# Sandbox templates for agent sessions — Design

Version: 1.0 — October 2026
Status: Proposed — implementation on branch `sbx-template` (webchang/moca), not yet proposed upstream
Builds on (reuse, no redesign): [P6.3](2026-10-04-p6-on-kubernetes-slice3-design.md) (sandbox tiers
and session-to-sandbox affinity), [SBX0](2026-10-15-sbx0-internal-sandbox-service-design.md) (its
templates: one `microvm-worker` per snapshot), `deploy/sbx/ONBOARDING.md` (turning an image into a
checked snapshot).

> **The one-sentence thesis.** A session can name a sandbox template at creation, as it names a
> tier; every turn then runs on a worker that serves that template's snapshot, and the harness
> seeds the session's workspace from the template the first time it is used. A session that names
> none never lands on a templated worker.

---

## 0. Decisions taken during design

| Question                               | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What a template is, to selection       | **A second presence label, `moca.dev/template`**, next to `moca.dev/tier`. A worker advertises it from `SANDBOX_TEMPLATE`. The deployment declares its templates (`SH_SANDBOX_TEMPLATES`, the same JSON list SBX0's control plane reads, with an optional `seed`). Rejected: matching on the snapshot name (it carries a digest and changes with every version); matching on `Hello.image` (a container reference, not an id clients choose). |
| Who picks a session's template         | **The user, at session creation**, fixed for the session's life, like its tier.                                                                                                                                                                                                                                                                                                                                                               |
| Where a session with no template lands | **Only on untemplated workers** (the user, 2026-10-30). A plain session never gets a benchmark image (often without network, with another toolchain) by accident.                                                                                                                                                                                                                                                                             |
| Who seeds a templated workspace        | **The harness, once, on the session's first turn that uses the workspace** (the user, 2026-10-30), so a stock agent starts in the template's repository. SBX0 clients run the seed themselves; agents in MOCA sessions do not know to.                                                                                                                                                                                                        |
| How the template reaches the selector  | **On the exchange response**, beside the tier, as P6.3 does.                                                                                                                                                                                                                                                                                                                                                                                  |
| Trust                                  | **As the tier.** The label is the worker's word, from its own environment. A workload sandbox's signed attach binding (`AttachBinding`) has no template: workload sandboxes are not templated in this design, and the relay removes a `moca.dev/template` label from any worker attached with a binding.                                                                                                                                      |

## 1. Scope

**In scope:** the worker label, the relay pass-through (and its removal under a binding), the
control plane's session field, validation, storage, exchange and discovery, the harness's filter,
affinity and seed, mocactl's session option, configuration, and tests.

**Out of scope:** templates for workload sandboxes (Kubernetes provisioner); several templates per
worker (one worker serves one snapshot, as in SBX0); a per-subject template allow-list; changing a
session's template after creation; building snapshots (`deploy/sbx/template-build.sh` does that).

## 2. Current state

A session's sandbox is chosen by tier only. The presence record (`sh:sandbox:records`) holds
`labels`, `capabilities` and `capacityMax`; `labels` carries `moca.dev/tier` and, for workload
sandboxes, `moca.dev/workload` and `moca.dev/owner`. A P4 `microvm-worker` serves one snapshot
(`SH_SNAPSHOT_DIR/SH_SNAPSHOT_IMAGE`), but nothing in its record says which. SBX0 has templates, but
maps each straight to a worker's `sandbox_id` in its own control-plane profile; MOCA sessions do not
use it.

## 3. Data model and wire

### 3.1 Workers (`remote-worker`)

`SANDBOX_TEMPLATE` (both `cmd/worker` and `cmd/microvm-worker`): set and non-blank, the worker's
Hello labels gain `moca.dev/template: <value>`, trimmed. Unset or blank: no label. There is no
default. `TemplateLabels` sits beside `TierLabels` in `internal/session/labels.go`; the two maps are
merged.

### 3.2 Relay (`packages/sandbox-relay`)

The label passes through like any other. With attach keys, `trustedLabels` deletes
`moca.dev/template` when the worker has a binding (a workload sandbox), and keeps it otherwise: a
shared-pool worker's labels are its own word today, the tier included.

### 3.3 Control plane (`packages/control-plane`)

- **Configuration.** `SH_SANDBOX_TEMPLATES` in the harness profile is the same JSON list SBX0 reads,
  `[{id, worker, description, tools, seed?}]`; `worker` is ignored here (selection is by label), and
  `seed` is an optional string. Unset or blank: no templates, and nothing below changes.
- **`POST /v1/sessions`** accepts `sandbox.template: string`. A non-string is a 400
  `invalid_request`. With templates declared, an id not in the list is a 400 whose message lists
  the declared ids; with none declared, any template is a 400 (`this deployment declares no sandbox
templates`). Omitted: `''`, no template.
- **`SessionRecord.sandboxTemplate: string`**, stored in the session hash beside `sandboxTier`.
- **`ExchangeResponse.sandboxTemplate?`** and **`sandboxSeed?`**: the stored template and its seed,
  omitted when the session has none or the deployment declares no templates (so a deployment
  without templates sends byte-identical responses).
- **Views** (`GET /v1/sessions`, `GET /v1/sessions/{id}`) include `sandboxTemplate` (`null` when none).
- **`GET /v1/discovery`** gains `sandboxTemplates: [{id, description, tools}] | null`.

### 3.4 Data plane (`packages/knative-server`, `harness`)

`TurnAuth` gains `sandboxTemplate` and `sandboxSeed`; `executeTurn` passes them to
`acquireTurnSandbox`, which passes `opts.template` to `selectPoolSandbox` and runs the seed (§5).
Leaf paths and unauthenticated turns pass no template.

### 3.5 Affinity

`AffinityEntry` gains `template?: string`. An entry with a template other than the session's is
followed like an entry with another tier (P6.3 §4 step 2): only to a sandbox in the filtered set.

## 4. Selection (`selectPoolSandbox`)

After P6.3's tier filter, a **template filter**:

- `opts.template` set: keep only records with `labels["moca.dev/template"] === opts.template`. Pods
  (the `pods` and `both` sources) never carry a template, so they are excluded.
- `opts.template` unset or `''`: keep only records **without** a `moca.dev/template` label.

The empty-set error (`SandboxPoolEmptyError`) names the template when one was asked
(`no attached sandbox for sandbox template 'X' …; check that a worker of this template sets
SANDBOX_TEMPLATE=X`). Affinity: an affine sandbox that is present but now serves another template
(or none) is a reset with `reason: 'retemplated'`, handled like `'retiered'` (no grace). Everything
else in P6.3 §4 is unchanged.

The template filter is applied whenever the records path is on. It needs no deployment setting: a
deployment whose workers carry no template label is unaffected.

## 5. The seed

When the session has a template with a seed, `acquireTurnSandbox` runs the seed in the selected
sandbox, through the same relay exec client, before the turn's first tool call, **only if the
workspace is not seeded yet**. "Seeded" is a marker file the seed leaves in the workspace:

    bash -c '<seed>' && touch /workspace/.moca-seeded

guarded by `[ -e /workspace/.moca-seeded ] || …`. The marker lives in the workspace, so it travels
with it: a session that keeps its sandbox is seeded once; a workspace reset (a new, empty
workspace) is seeded again. A failed seed fails the turn with `SandboxSeedError` (a 502, not
retryable) naming the template and the exit code. The seed's output is not shown to the agent.

## 6. User surface

- mocactl: `--option sandboxTemplate=<id>` (a `SESSION_OPTION_FIELDS` entry; its choices from
  `/v1/discovery`), shown in the session list beside the tier.
- The JSON turn result's `sandbox` gains `template` when the session has one.

## 7. Configuration and deployment

- Control plane: `SH_SANDBOX_TEMPLATES` (harness profile), alongside `SH_SANDBOX_TIERS`.
- Workers: `SANDBOX_TEMPLATE=<id>` in a templated worker's env file. For a P4 worker on the VM path,
  `microvm-worker.env`; the snapshot is any `template-build.sh` snapshot, named by
  `SH_SNAPSHOT_IMAGE`.
- One worker per template: a second template on a host is a second `microvm-worker` with its own
  `SANDBOX_ID`, snapshot and template (the VM path's units are written for one worker today; a
  multi-worker VM install is a follow-up, `deploy/sbx/install-host.sh` already does it for SBX0).

## 8. Testing

- **Workers, Go unit:** `SANDBOX_TEMPLATE` → the label, blank, unset, merged with the tier.
- **Relay, unit:** the label passes through; it is removed under a binding.
- **Control plane, unit:** parse (the seed optional and a string), create (unknown, none declared,
  non-string, omitted), the stored field, the exchange (present only with a template), discovery.
- **Harness, unit:** the template filter both ways, pods excluded for a template, the error wording,
  affinity across a template change (`retemplated`), the seed (runs once, skipped with the marker,
  re-run after a reset, failure).
- **mocactl, unit:** the option field and request shape.
- **Acceptance, MOCA-VM on bm1:** one untemplated P4 worker and one templated worker; a session with
  the template lands on the templated worker and finds the repository seeded; a session without
  lands on the untemplated one.
