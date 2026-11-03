# Template lifecycle, readiness and provenance — Design

Version: 0.2 (draft for review; the user's answers to §12 applied, 2026-11-03) — November 2026
Status: Proposed — branch `sbx-template` (webchang/moca), not proposed upstream
Builds on: [session sandbox templates](2026-10-30-session-sandbox-templates-design.md) (a session
names a template; one worker serves one template's snapshot),
[SBX0](2026-10-15-sbx0-internal-sandbox-service-design.md) (templates on the sandbox profile, the
host janitor), and the template governance folder
([`deploy/sbx/template-onboarding/governance/`](../../deploy/sbx/template-onboarding/governance/README.md)):
the gating rules (M, X), the register of decisions (D), gaps (G, PV, S) and assumptions (A) this
design cites by id, and the process.

## 1. Goal and scope

**Goal:** SWE-bench, and benchmarks like it, at scale on MOCA templates: many per-instance templates
onboarded and gated, a bounded set of them **active** on a host at a time, chosen by the workload
through the **MOCA API** (D1, D3), with every deployed image and template traceable through
persistent provenance that can be verified offline (D5, D7), hosted in the control plane (D8).

**In scope (feasibility first, D10):**

- template **states** a client can read: onboarding and readiness (D4; gaps S1, S2);
- client **requests** for onboarding and activation, and **admin** actions that act on them (D9; S3);
- **activation**: attaching and detaching a template's worker on a KVM host, driven by the control
  plane, with an active limit per host, **aging** and **least-recently-used replacement** (A16);
- **provenance**: a chain of records from the gated image to every run, persistent in the control
  plane and verifiable offline (D7, D8; PV1-PV9);
- **gating at build and registration**: MOCA's side of the gating rules, including X10 and X12;
- **tracing a run** to its exact snapshot (PV7).

**Out of scope here:** the authorization design (D10: clients are admin clients for now, A1); a
worker serving several snapshots (A2); multi-host scheduling and HA (A15); signing images or an
SBOM (GATING-RULES §4, "later"); the workload and its scheduler (autobench-moca's, D2).

## 2. What exists, and what is missing

| Today                                                                                                           | Where                                                                      | Missing for the goal                                                           |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Templates are declared to the control plane as `SH_SANDBOX_TEMPLATES` (a JSON env list), changed by redeploying | `packages/control-plane/src/sandbox-config.ts`; `deploy/sbx/setup.sh`      | no states; a change is a deploy (S1): **declared in the store instead** (§3.1) |
| `GET /v1/templates` lists them                                                                                  | `packages/control-plane/src/routes.ts:297`                                 | no readiness, capacity or provenance (S1)                                      |
| A session or sandbox names one; the harness routes it to a worker labelled `moca.dev/template`                  | `handlers.ts:706-725`; `harness/src/select-sandbox.ts`                     | a template with no worker fails only at session time, 503 (S2)                 |
| One `microvm-worker` per template; it mlocks its snapshot's memory at start                                     | `remote-worker/cmd/microvm-worker/main.go:605,630`                         | ~4 GiB per attached worker, idle or not (A3)                                   |
| Workers are attached and detached by an operator on the host                                                    | `deploy/sbx/install-host.sh`; `deploy/microvm/setup-microvm.sh --template` | nothing for the control plane to drive (S3)                                    |
| The build writes a template record and a snapshot manifest on the host                                          | `template-build.sh`; `build-snapshot.sh`                                   | not in the control plane, not chained by digest (PV1-PV6)                      |
| The host janitor already reads the control plane with its own bearer                                            | `sandbox-handlers.ts:266-271` (`janitorSandboxes`)                         | the pattern this design reuses for a host agent                                |

## 3. Template states

### 3.1 Templates are declared in the store

Templates are **declared in the control plane's store**, not in `SH_SANDBOX_TEMPLATES` (the user,
2026-11-03): registering, retiring or changing one is an API call that writes a record (§7), never a
redeploy. The env list is read once, at the first start against an empty store, to import what a
deployment declares today, and is ignored after that (a warning names it if it is still set and
differs). The harness's session templates (the seed, the tools) come from the same store, through the
exchange as today.

### 3.2 The two states

A template has two independent states, both kept by the control plane.

**Onboarding** (how far the template is from usable):

| State        | Means                                                                       | Entered by                   |
| ------------ | --------------------------------------------------------------------------- | ---------------------------- |
| `requested`  | a client asked for it; nothing built                                        | a client's request (§5)      |
| `approved`   | an admin accepted the request                                               | an admin                     |
| `built`      | its snapshot is built and its in-VM probe passed, on a host                 | the build's report (§7.2)    |
| `registered` | its template record is accepted by the control plane, gate evidence checked | an admin's registration (§8) |
| `rejected`   | refused at any step, with the reason                                        | an admin, or a failed check  |
| `retired`    | no new sessions; kept for provenance                                        | an admin                     |

**Readiness** (whether sessions can run on it now), for a `registered` template:

| State          | Means                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `inactive`     | registered, no worker attached                                                                     |
| `activating`   | the control plane asked a host to attach its worker; not yet attached                              |
| `active`       | its worker is attached; sessions can run                                                           |
| `deactivating` | the control plane asked the host to detach it; live sessions drain (§6.3)                          |
| `unavailable`  | it cannot be activated: no host declares its snapshot (§6.1), or the host refused, with the reason |

Readiness follows from facts, not from intent: `active` means the relay holds an attached record
for its worker (the same record the harness routes on), and the control plane derives it from that,
so the state cannot claim a worker that is not there.

## 4. The API (reads: any client)

`GET /v1/templates` keeps today's fields and adds, per template:

```json
{
  "id": "django-django-11133",
  "description": "SWE-bench django__django-11133 (lite) at its baseline bc348023edb4",
  "tools": ["bash", "git", "python3", "rg"],
  "onboarding": "registered",
  "readiness": "active",
  "capacity": { "running": 3, "inUse": 1 },
  "lastUsedAt": "2026-11-03T02:10:00Z",
  "provenance": { "manifestHash": "sha256:…", "record": "/v1/provenance/records/<digest>" }
}
```

plus a block per host: `{"hosts": [{"id": "bm1", "active": {"limit": 24, "used": 18}, "idleLimitSeconds": 3600}]}`
(limits are per host, §6.2). `capacity.running` is what the
worker's budget admits at once (`(budget − 1024) ÷ (guest + 32)` MiB, the rule measured on
2026-10-31); `inUse` is its running sessions now. `GET /v1/templates/{id}` returns one template with
its full provenance chain (§7). A session or sandbox on a template that is not `active` is refused at
creation with `409 template_not_active` and its readiness, not left to a 503 retry later.

## 5. Requests and admin actions

| Route                                                                | Who                           | Does                                                                          |
| -------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| `POST /v1/template-requests {kind: "onboard", image, spec?, reason}` | any client                    | records a request to onboard an image (by digest) as a template               |
| `POST /v1/template-requests {kind: "activate", template, reason}`    | any client                    | records a request to activate a registered template                           |
| `GET /v1/template-requests[/{id}]`                                   | the requester; admins see all | the request and its state (`open`, `approved`, `done`, `rejected`)            |
| `POST /v1/template-requests/{id}/approve` · `/reject`                | **admin**                     | acts on a request; an approved onboarding goes to the operator's build (§7.2) |
| `POST /v1/templates/{id}/activate` · `/deactivate`                   | **admin**                     | sets the wanted readiness; the host agent acts on it (§6)                     |
| `POST /v1/templates/{id}/retire`                                     | **admin**                     | onboarding → `retired`; deactivates it                                        |

"Admin" is the existing `admin` role (`SH_ADMIN_SUBJECTS`, `packages/control-plane/src/identity.ts`);
the finer roles are the authorization design's (D10). Every request and action writes a provenance
record (§7).

## 6. Activation on a host

### 6.1 The host agent

A **new, small service** on each KVM host, `sbx-host-agent` (the user, 2026-11-03; not an extension of
the host janitor, which keeps its one job), beside the workers. It does what an operator does today
with `install-host.sh` / `setup-microvm.sh --template`: start and stop a template's installed worker
unit. It **polls** the control plane and **reports** to it; it never listens, as the janitor does not
(a per-host bearer, no inbound port, SBX0 §8.3).

**Each host declares the snapshots it holds** (the user, 2026-11-03): the control plane does not
assign templates to hosts. On every poll the agent sends its inventory, and the control plane matches
it to registered templates by manifest hash:

| Step | Agent                                                                                                                      | Control plane                                                           |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1    | `POST /v1/hosts/{host}/inventory`: each installed worker's template id and its snapshot's manifest hash; the host's limits | records the inventory; a template is placeable only on hosts holding it |
| 2    | `GET /v1/hosts/{host}/wanted`: the wanted readiness of the templates it holds                                              | answers from its store                                                  |
| 3    | for each wanted `active`: check the snapshot's manifest hash is the registered one, then start the worker unit             | —                                                                       |
| 4    | `POST /v1/hosts/{host}/reports`: `{template, event, reason}`, the event `attached`, `refused` or `detached`                | records it (§7); readiness follows the relay's attached record          |
| 5    | for each wanted `inactive` with no live sessions: stop the unit                                                            | —                                                                       |

Workers are installed once per template (`install-host.sh`), so activation is a start and
deactivation a stop: no file changes, no relay or control-plane restart. A stopped worker costs no
memory. A template no host declares is `unavailable`.

### 6.2 The active limit

**Per host** (the user, 2026-11-03): each host's agent reports its `activeLimit` (the workers it may
run at once) and `idleLimit` (§6.3) with its inventory, from the host's own settings file. They are
set by its operator from the host's memory and disk and the templates' budgets (measured on bm1: ~26
SWE-bench templates by disk, ~36 workers by memory at 4 GiB guests, A3). The agent also refuses a
start that would pass the host's memory, as a second guard. Activation beyond a host's limit is
refused, or triggers replacement on that host (§6.3).

### 6.3 Aging and replacement (A16)

- **Use:** a template's `lastUsedAt` is the start of its latest session or sandbox (the control
  plane sees every creation).
- **Aging:** an `active` template idle longer than its host's `idleLimit` (§6.2) is moved to
  `deactivating` by the control plane.
- **Replacement:** an activation that would pass `activeLimit` deactivates the `active` template
  with the oldest `lastUsedAt` that has no live session.
- **Live sessions:** a template is never stopped under a live session; `deactivating` drains (no new
  sessions, existing ones finish or expire). If every active template has live sessions, the
  activation waits or is refused with `409 no_active_slot`.

## 7. Provenance

### 7.1 Records and the chain

Every step writes one record. A record is JSON, append-only, with `prev` (the digest of the record it
follows) so the chain from the gated image to a session can be walked and checked:

| Record                    | Written when                             | Holds                                                                                                                                                                                | Source (workload plane) |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `gate`                    | the image's gate record is cited         | image-factory's record digest and its gate fields (GATING-RULES §3)                                                                                                                  | image-factory           |
| `build`                   | a snapshot is built and its probe passed | the template record T and the manifest S: image digest, `source_record_digest`, manifest hash, kernel/rootfs/agent digests, probe and its result, the MOCA commit, the builder, when | `template-build.sh`     |
| `register`                | an admin registers it                    | T as accepted, the checks it passed (§8)                                                                                                                                             | the control plane       |
| `activate` · `deactivate` | readiness changes                        | host, worker, manifest hash, reason (request, aging, replacement)                                                                                                                    | the host agent's report |
| `retire`                  | an admin retires it                      | reason                                                                                                                                                                               | the control plane       |
| `request` · `decision`    | a client requests, an admin decides      | who, what, reason                                                                                                                                                                    | the control plane       |
| `use` (summary)           | sessions start                           | per template and day: count, first and last                                                                                                                                          | the control plane       |

### 7.2 Hosting, persistence and offline verification

- **Hosted in the control plane** (D8), in a store that is **not Redis** (A8): an append-only
  directory on the control plane's persistent volume, one file per record named by its digest, and an
  index per template. The control plane's existing file store and its PVC (`file-store.ts`, the
  egress credentials' `moca-sbx-credentials`) are the precedent.
- **Digests, not signatures** (the user, 2026-11-03): every record is named by the sha256 of its
  canonical JSON, and names its predecessor's digest in `prev`, so any edit breaks the chain. Each
  template's chain head (the latest record's digest) is listed in the export's index, to be compared
  against a copy kept elsewhere. Nothing is signed.
- **Exported**: `GET /v1/provenance/export?template=<id>` returns the records and the index as a
  tarball; `mocactl` (or a small script) **verifies offline**: every record's digest, every `prev`,
  and that the `build` record's manifest hash matches a snapshot if one is at hand.
- **The workload plane only reports**: the build host posts `build` (or the operator registers T,
  which carries it); the host agent posts `activate`/`deactivate` events. The control plane checks
  and records; it never trusts a report it cannot tie to its chain.

## 8. Gating at build and registration

MOCA's side of the gating rules ([GATING-RULES](../../deploy/sbx/template-onboarding/governance/GATING-RULES.md)):

| Rule                                                                               | Where                                     | Change                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| X10: `source_record_digest` equals the image digest                                | `template-build.sh`                       | refuse a spec where it does not; carry it in T                                                                                                                                                                     |
| X12: commits stay refused where the spec says                                      | `template-build.sh`, T                    | T records `skip_git_identity_check` with its reason and the gate's X5 evidence                                                                                                                                     |
| Gate evidence in T (GATING-RULES §3)                                               | `template-build.sh` from the spec         | T carries `gate_record.{schema, passed, kind, network, user, base_digest, recipe, builder, sha256, commit}`                                                                                                        |
| PV2: the manifest is covered by its digest                                         | `build-snapshot.sh`, `vmpool/snapshot.go` | capabilities, image, instance type, guest size, vcpus and the egress CA move into `hash`; the Go manifest gains vcpus and the CA                                                                                   |
| PV3: every snapshot file has a digest (the user, 2026-11-03: a digest, no signing) | `build-snapshot.sh`, `vmpool/snapshot.go` | the manifest records the sha256 of `vmstate` and `memfile` too; the build computes them once; the worker checks them at start only if asked (`SH_VERIFY_MEMFILE=1`, a 4 GiB read), and the offline verifier always |
| PV4: worker start checks T                                                         | `microvm-worker`                          | compares T's `manifest_hash` and R's image digest with its snapshot                                                                                                                                                |
| Registration                                                                       | the control plane                         | accepts T only with a passed gate (X1), a matching `source_record_digest` (X10), and a `build` record it can verify                                                                                                |

## 9. Tracing a run (PV7)

A session's and a sandbox's responses carry `sandbox.templateManifestHash`, and the control plane's
`use` records count them. Any run's result can then be traced: run → template → manifest hash →
`build` record → `gate` record → image-factory's record.

## 10. Validation, before any PR (D1, D11)

On bm1 with ykt3's control plane, autobench-moca driving the workload (D2), a scripted mock model
first (A13):

1. image-factory's gated images for K instances (K = 4, then more);
2. clients request onboarding; an admin approves; `template-build.sh` builds and records; the admin
   registers (gating checks, §8);
3. clients request activation; the admin activates; the host agent attaches; readiness `active`;
4. autobench-moca's runner opens sessions naming each instance's template, several instances at once;
5. aging and replacement: more templates than `activeLimit`, the window moves by itself;
6. export the provenance and verify it offline, from a machine with no access to the cluster;
7. then a real model and grading, with the user's OK; then the PRs, from what this proved.

The process doc (`PROCESS.md`) is updated at each step, and the validation follows it as written.

## 11. Order of work

1. §8's gating changes (X10, X12, the evidence fields, PV2, PV4): no API change, testable alone.
2. The provenance store and records (§7), with offline verification, for build and register first.
3. Template states and the read API (§3, §4).
4. Requests and admin actions (§5).
5. The host agent and activation, the limit, aging and replacement (§6).
6. Tracing (§9).
7. The validation (§10).

## 12. Decisions on the open questions (the user, 2026-11-03)

| #   | Question                                                           | Decision                                                                                  | Where          |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------- |
| O1  | Hash and sign vmstate and memfile too?                             | **a digest, no signing**: every snapshot file has a digest; records are chained by digest | §7.2, §8 (PV3) |
| O2  | `idleLimit` and `activeLimit`: per deployment, per host, computed? | **per host**                                                                              | §6.2           |
| O3  | The control plane assigns templates to hosts, or hosts declare?    | **each host declares the snapshots it holds**                                             | §6.1           |
| O4  | The host agent: a new service, or the janitor extended?            | **a new service**, `sbx-host-agent`                                                       | §6.1           |
| O5  | Templates declared in the store, not `SH_SANDBOX_TEMPLATES`?       | **declared in the store**; the env list imported once into an empty store                 | §3.1           |
