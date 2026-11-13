# Template lifecycle, readiness and provenance — Design

Version: 0.5 (draft for review; **self-serve**: clients build, register and activate their own
templates, gated by machine-checked policy; 0.5 applies autobench-moca's client review) — November 2026
Status: Proposed — branch `sbx-template` (webchang/moca), not proposed upstream; §11 items 1-7
implemented on the branch (see §11); the validation (item 8): windows 1 and 2 run 2026-11-04, windows
3 and 4 (measurements) and step 3 on 2026-11-05 (§10.1); the combined control plane of §4.1 is built
([its design](2026-11-05-combined-control-plane-design.md)) and deployed on ykt3 (`moca-combined`), its attach
window run 2026-11-05 (§10.1); step 8 (a real model, DeepSeek on CurveBender, graded) run 2026-11-06
Builds on: [session sandbox templates](2026-10-30-session-sandbox-templates-design.md) (a session
names a template; one worker serves one template's snapshot),
[SBX0](2026-10-15-sbx0-internal-sandbox-service-design.md) (templates on the sandbox profile, the
host janitor), and the template governance folder
([`deploy/sbx/template-onboarding/governance/`](../../deploy/sbx/template-onboarding/governance/README.md)):
the gating rules (M, X), the register of decisions (D), gaps (G, PV, S) and assumptions (A) this
design cites by id, and the process.

**What changed in 0.4** (the user, 2026-11-03: "support a self-serve model in principle, as much as
can"; D12): an enrolled client creates a template from its own image and follows its build; **policy,
not an admin, decides** whether a build is registered (§8); the client activates and deactivates its
templates within its quota and the host's limit (§6). Admins set the policy, the quotas and the host
limits, and can act on any template (§5.2). The request-and-approve flow of 0.3 is gone. Still not
adopted: build steps in code (clients bring a finished image, D13).

**What changed in 0.5** (autobench-moca's client review of 0.4, 2026-11-03): the template routes mount
on both route profiles (§4.1); the spec gains `workspace_mb`, and a build's seed and spec are readable
(§4); reuse keys on the gate record and the profile too (§3.2); activations are **leases** a batch
renews, so replacement never evicts a held build (§6.3); the `409`s carry readiness and the host's
slots (§4); the instance-id mapping is part of the benchmark profile (§8.4); the disk floor counts
retained workspaces (§6.1); open: TB's egress (O13), a lease's length (O14), workspace export (O15).

## 1. Goal and scope

**Goal:** SWE-bench, and benchmarks like it, at scale on Moca templates: many per-instance templates
**onboarded by their clients themselves**, gated automatically, a bounded set of them **active** on a
host at a time, chosen by the workload through the **Moca API** (D1, D3, D12), with every deployed
image and template traceable through persistent provenance that can be verified offline (D5, D7),
hosted in the control plane (D8).

**In scope (feasibility first, D10):**

- **self-serve onboarding**: a client creates a template from an image by digest; a build host builds
  and probes it; the build is registered when it passes policy (§4, §7, §8);
- template **states** a client can read: onboarding and readiness (D4; gaps S1, S2);
- **activation by the client**, within a per-subject quota and a per-host active limit, with
  **aging** and **least-recently-used replacement** (A16), and activation on first use (§6.4);
- **policy**: Moca's side of the gating rules as machine checks, in profiles an admin chooses (§8);
- **provenance**: a chain of records from the image to every run, persistent in the control plane and
  verifiable offline (D7, D8; PV1-PV9);
- **tracing a run** to its exact snapshot (PV7).

**Out of scope here:** the authorization design (D10: every enrolled subject is a client, admins are
`SH_ADMIN_SUBJECTS`, A1); build steps in code (D13); a worker serving several snapshots (A2);
multi-host scheduling and HA (A15); signing images or an SBOM (GATING-RULES §4, "later"); the
workload and its scheduler (autobench-moca's, D2).

## 2. What exists, and what is missing

| Today                                                                                                           | Where                                                                      | Missing for the goal                                                           |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Templates are declared to the control plane as `SH_SANDBOX_TEMPLATES` (a JSON env list), changed by redeploying | `packages/control-plane/src/sandbox-config.ts`; `deploy/sbx/setup.sh`      | no states; a change is a deploy (S1): **declared in the store instead** (§3.1) |
| `GET /v1/templates` lists them                                                                                  | `packages/control-plane/src/routes.ts:297`                                 | no readiness, capacity, owner or provenance (S1)                               |
| A session or sandbox names one; the harness routes it to a worker labelled `moca.dev/template`                  | `handlers.ts:706-725`; `harness/src/select-sandbox.ts`                     | a template with no worker fails only at session time, 503 (S2)                 |
| One `microvm-worker` per template; it mlocks its snapshot's memory at start                                     | `remote-worker/cmd/microvm-worker/main.go:605,630`                         | ~4 GiB per attached worker, idle or not (A3)                                   |
| An operator builds a template on the KVM host                                                                   | `deploy/sbx/template-onboarding/template-build.sh`                         | no way for a client to build one (S3)                                          |
| Workers are attached and detached by an operator on the host                                                    | `deploy/sbx/install-host.sh`; `deploy/microvm/setup-microvm.sh --template` | nothing for the control plane to drive (S3)                                    |
| The build writes a template record and a snapshot manifest on the host                                          | `template-build.sh`; `build-snapshot.sh`                                   | not in the control plane, not chained by digest (PV1-PV6)                      |
| The host janitor already reads the control plane with its own bearer                                            | `sandbox-handlers.ts:266-271` (`janitorSandboxes`)                         | the pattern this design reuses for a host agent                                |

## 3. Templates, builds and states

### 3.1 Templates are declared in the store

Templates are **declared in the control plane's store**, not in `SH_SANDBOX_TEMPLATES` (the user,
2026-11-03): creating, retiring or changing one is an API call that writes a record (§7), never a
redeploy. The env list is read once, at the first start against an empty store, to import what a
deployment declares today (owned by the first admin subject), and is ignored after that (a warning
names it if it is still set and differs). The harness's session templates (the seed, the tools) come
from the same store, through the exchange as today.

### 3.2 Templates, builds and tags (adopted from E2B)

The user asked (2026-11-03) to leverage the good design decisions of E2B's templates
(docs.e2b.dev, "Template tags & versioning", "Template names", the templates API). Adopted:

- **Self-serve:** any enrolled client creates a template and its builds through the API, as any E2B
  key holder does (D12). Moca adds what E2B does not have: policy gating before registration (§8).
- **A build is an immutable artifact with an id.** A build is one snapshot; its id is the snapshot's
  manifest hash, `buildId` (`sha256:…`, §8 PV2-PV3 make that hash cover the whole snapshot). A
  **template** is a name over its builds. Today's rule that a new image is a new snapshot and a new
  worker is unchanged: each is a new build of the same template.
- **A build is reused when its inputs are the same:** a create whose image digest, spec, profile,
  gate record (its sha256) and builder (Moca commit, kernel) match an existing registered build returns that build, not a second snapshot
  (E2B caches layers; Moca's unit is the whole snapshot). Disk is the scarce resource (A3).
- **Tags are labels on builds, moved without rebuilding.** A template is referenced as `id[:tag]`,
  `default` when the tag is omitted; **the template's owner** moves tags (`stable`, `v2`, …) between
  its registered builds (§5). Old builds stay addressable while their sandboxes drain.
- **Pin by build id:** a session or sandbox may name `id@sha256:…` instead of a tag, and is then
  served by exactly that build or refused.
- **The build is an API resource** with a status and paged logs (§4), as E2B's build status is.
- **Names:** Moca keeps its id rule, `^[a-z0-9][a-z0-9-]{0,30}$` (31 characters, the worker-id limit),
  lowercased on input and refused, never truncated, when longer; `GET /v1/templates/{id}` answering
  404 is the existence check. A tag follows the same rule. **Ids are unique per deployment**: the
  first subject to create an id owns it; another's create of the same id is `409 template_exists`
  (E2B scopes names to a project; a Moca deployment is one project, A21).
- **Visibility:** `private` (the owner and admins) or `deployment` (every enrolled client may use and
  activate it; only the owner changes it). Default `deployment`, so per-instance benchmark templates
  are built once and shared (A21).

Not adopted, by design: a builder chain of layers in code (D13: clients bring a finished image, built
anywhere); capturing running processes (a clean guest per command); unlimited templates (a per-host
active limit, A3); public templates across deployments.

### 3.3 The two states

A template's builds each have two independent states, both kept by the control plane.

**Onboarding** (how far the build is from usable), set by the build host's reports and by policy,
never by a person's approval (people still cancel, retire, and reject after the fact, §5):

| State        | Means                                                                                                                                                                               | Entered by                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `queued`     | created; admitted by the create-time checks (§8.1); waiting for a host                                                                                                              | the client's create (§4)                   |
| `building`   | a build host took it: pull, rootfs, boot, in-guest checks, snapshot                                                                                                                 | the host agent's claim (§6.1)              |
| `probing`    | restored from the new snapshot; the seed and the probe running                                                                                                                      | the host agent's report                    |
| `built`      | snapshot and probe passed on a host; its build record is in                                                                                                                         | the host agent's report (§7)               |
| `registered` | the control plane checked the build record against policy (§8.2) and the gate evidence; usable                                                                                      | the control plane, automatically           |
| `rejected`   | refused by policy at registration (§8.2), with the rule id and reason, or rejected after the fact by an admin (§5.2); a create policy refuses is a `422` and leaves no build (§8.1) | the control plane, automatically; an admin |
| `failed`     | the build or the probe failed, with `reason {message, step}`, or the owner cancelled a `queued`, `building` or `probing` build (§5.1)                                               | the host agent's report; the owner         |
| `retired`    | no new sessions; kept for provenance                                                                                                                                                | the owner, or an admin                     |

A template's own state is its newest build's (`registered` once any build is), so a client polling
`GET /v1/templates/{id}` sees `queued → building → probing → built → registered` without knowing the
build id.

**Readiness** (whether sessions can run on it now), for a `registered` build:

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

## 4. The API: create, read, follow

**Create (any enrolled client):**

```http
POST /v1/templates
{
  "id": "django-django-11133",
  "image": "<repository>@sha256:…",
  "spec": { "guest_mb": 4096, "vcpus": 2, "workspace_mb": 2048, "egress": false, "tools": ["bash", "git", "python3", "rg"],
            "seed": "…", "probe": { "command": "…", "expect_rc": 0, "expect": ["…"] },
            "skip_git_identity_check": true, "guest_home": "/tmp/home" },
  "gateRecord": { … },            // optional; required by the benchmark profile (§8)
  "profile": "benchmark",         // a policy profile the deployment offers (§8); default its default
  "visibility": "deployment",
  "tags": ["default"]
}
→ 202 { "templateId": "django-django-11133", "buildId": null, "build": "/v1/templates/django-django-11133/builds/b-01J…", "status": "queued" }
```

The spec is the same document `template-build.sh` reads today (`ONBOARDING.md`), plus
`workspace_mb`, the size of the sandbox's `/workspace` image (default 2048, today's
`SH_WORKSPACE_IMAGE_MB`; within the profile's envelope; register W11), which the worker serving the
build applies; the image's gate
record, when given, is stored with the build and checked (§8). `POST /v1/templates/{id}/builds`
starts a new build of an existing template (a new image or spec); same body, same answer. A build
has a provisional handle (`b-…`) until it is built; then its `buildId` is its manifest hash and the
handle redirects to it. A create that matches an existing registered build (§3.2) answers
`200 {buildId, status: "registered", reused: true}`; one that matches a build still on its way
(queued to built) answers `202` with that build and `reused: true`, and queues nothing. As built
(G21): the match is the image, the spec as sent, the profile and the gate record's sha256 on the
caller's own template; the builder is not compared (one deployment's hosts build with one builder),
a failed or rejected build is never reused, and on a deployment with host agents a registered
build is reused only while a host reports holding its snapshot (G29).

**Reads (any enrolled client; `private` templates only to their owner and admins).**
`GET /v1/templates` keeps today's fields and adds, per template, its owner, tags and builds:

```json
{
  "id": "django-django-11133",
  "owner": "github:3454373",
  "visibility": "deployment",
  "description": "SWE-bench django__django-11133 (lite) at its baseline bc348023edb4",
  "tools": ["bash", "git", "python3", "rg"],
  "onboarding": "registered",
  "tags": { "default": "sha256:3c1f…", "stable": "sha256:3c1f…" },
  "builds": [
    {
      "buildId": "sha256:3c1f…",
      "status": "registered",
      "profile": "benchmark",
      "readiness": "active",
      "capacity": { "running": 3, "inUse": 1 },
      "lastUsedAt": "2026-11-03T02:10:00Z",
      "spec": { "guest_mb": 4096, "vcpus": 2, "workspace_mb": 2048, "seed": "…", "tools": ["…"] },
      "provenance": "/v1/provenance/records/<digest>"
    }
  ]
}
```

Each build carries **its own spec, seed included**: a client that runs the seed itself (SBX0's
`sandbox` profile does not run it) reads the seed of the build it was served
(`GET /v1/templates/{id}/builds/{buildId}`), never the newest build's.

**Builds, as a resource (adopted from E2B's build status):**

| Route                                                                          | Returns                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/templates/{id}/builds`                                                | the template's builds, newest first                                                                                                                                                                                                                                                                 |
| `GET /v1/templates/{id}/builds/{build}`                                        | one build: `status` (§3.3), `readiness`, `heldBy` (the hosts holding its snapshot, ids only: a retired build's removal shows as its host dropping out), the policy result (each rule checked, passed or failed), its record chain (§7), and on failure or rejection `reason {message, step, rule?}` |
| `GET /v1/templates/{id}/builds/{build}/logs?logsOffset=0&limit=100&level=warn` | `logEntries [{timestamp, level, step, message}]`, paged by offset, at most 100 a page; reported by the build host, stored with its record                                                                                                                                                           |
| `GET /v1/templates/{id}/tags`                                                  | each tag and the build it points to, with when it was assigned and by whom                                                                                                                                                                                                                          |
| `GET /v1/quota`                                                                | the caller's quotas and use: templates, builds queued, active templates (§6.2); on the sandbox profile, live sandboxes (G27)                                                                                                                                                                        |
| `GET /v1/policy`                                                               | the deployment's policy profiles: each one's rules, size envelope, allowed registries, trusted gate-record sources, and the policy's digest (§8)                                                                                                                                                    |

plus a block per host: `{"hosts": [{"id": "bm1", "active": {"limit": 24, "used": 18}, "idleLimitSeconds": 3600, "disk": {"freeGb": 140, "floorGb": 60}}]}`
(limits are per host, §6.2). Errors keep Moca's shape, `{error, message}` with a stable code, and
add `step` where a build step failed and `rule` where policy refused; a refusal that may clear
carries `Retry-After`. `capacity.running` is what the worker's budget admits at once, as the worker
reports it (its stats, through the host agent's inventory), not a formula in the control plane: the
rule depends on the Moca commit (#644 changed standby charging: autobench-moca measured a density of 16
at a280cb41 and 36 at c49e6a8e on the same sweep); `inUse` is its running sessions now. `GET /v1/templates/{id}` returns one template with its full provenance chain (§7).

A session or sandbox names `id`, `id:tag` or `id@sha256:…` (§3.2); the reference is resolved to one
build at creation, recorded on the session, and kept for its life. On a build that is not `active`
it is refused at creation with `409 template_not_active` and `Retry-After`, and, unless the client
says `activate: false`, an activation is started for it (§6.4). The body says why, so a client can
tell a wait from a refusal: `{error, message, readiness, hosts: [{id, active: {limit, used}}],
quota: {active: {limit, used}}}`; `409 no_active_slot` and `409 quota_exceeded` carry the same.

### 4.1 Route profiles

Today `/v1/sessions` is on the `harness` route profile and `/v1/templates` and `/v1/sandboxes` on the
`sandbox` profile (`packages/control-plane/src/routes.ts`). **The template routes of this design
mount on both** (`BOTH`), so a Moca Pi brain (sessions, `harness`) and a stock agent (sandboxes,
`sandbox`) see the same templates, builds and readiness; the host-agent routes (§6.1) mount on the
profile whose deployment the hosts serve.

**For the validation (§10): one control plane, the `harness` profile with the sandbox routes added**
(autobench-moca's choice, 2026-11-03): one store, subject, quota and provenance chain, so both
brains' reps on an instance are served by the same build under the same lease, and no cross-process
question about leases and replacement enters what §10 measures. Two control planes sharing a store
is the alternative, not taken. Mounting the SBX0 routes on `harness` must keep SBX0's token
separation (to be checked in code and tests when it is built):

- the **sandbox token** keeps its own `typ` (`moca-sandbox+jwt`), audience (`moca-sandbox`) and
  issuer (`sandbox-token.ts`), whichever profile mints it, so it never passes as a session or API
  token, nor the reverse;
- **API tokens** on a `harness` control plane are minted under `sh-control-plane`, not the sandbox
  profile's `sbx-control-plane-api` (`apiIssuer`, `handlers.ts`); what mints for SBX0 under the
  sandbox issuer (`deploy/sbx/mint-login.sh` and its test) must follow the deployment's profile, and
  a sandbox-profile stack sharing the signing key must still accept nothing this one mints;
- the sandbox routes stay **refused to test users** (SBX0 §4.2 admits only enrolled `github:`
  subjects; `main.ts` refuses test users on the sandbox profile): on `harness`, the sandbox routes
  check the subject themselves.

## 5. Actions: the owner's, and the admin's

### 5.1 The owner's (self-serve)

**Built (2026-11-06):** every route of §5.1 and §5.2; `mocactl sbx templates` has `retire`, `tag`,
`untag`, `edit`, `transfer` and `quota`. A retire and a reject end a build's use for good (a new
build is the way back), never cut off running work (`409 build_in_use` under a live sandbox or an
active pinned session), and have a holding host remove the snapshot and worker (§6.1 step 7). A
retired or rejected build: `410 template_retired` (retired) or `400 unknown_template` (rejected) on
use. Each answer carries the subject, the build ids and the record's digest.

| Route                                                                                 | Who                                      | Does                                                                                                            |
| ------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `POST /v1/templates` · `POST /v1/templates/{id}/builds`                               | any client; a new build: the owner       | creates a template or a build (§4)                                                                              |
| `POST /v1/templates/{id}/activate` · `/deactivate`                                    | the owner; `deployment` ones: any client | sets the wanted readiness, within the caller's quota (§6.2); the host agent acts on it (§6)                     |
| `POST /v1/templates/{id}/tags {tags, build}` · `DELETE /v1/templates/{id}/tags/{tag}` | the owner                                | moves tags onto a registered build, or removes a tag; removing one never deletes the build (adopted from E2B)   |
| `PATCH /v1/templates/{id} {visibility, description}`                                  | the owner                                | changes them; a record (§7)                                                                                     |
| `POST /v1/templates/{id}/builds/{build}/cancel`                                       | the owner                                | a `queued`, `building` or `probing` build → `failed` (`cancelled`)                                              |
| `POST /v1/templates/{id}/retire` · `DELETE /v1/templates/{id}/builds/{build}`         | the owner                                | retires the template (deactivates it), or retires one build; snapshots go when no host needs them; records stay |

A deactivation by a non-owner applies to its own activation only: a `deployment` template stays
active while any subject's activation of it stands (each activation counts against that subject's
quota, §6.2).

### 5.2 The admin's

"Admin" is the existing `admin` role (`SH_ADMIN_SUBJECTS`, `packages/control-plane/src/identity.ts`);
the finer roles are the authorization design's (D10). Admins do not approve builds; they set what
policy allows and act where self-serve cannot:

| Route                                               | Does                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `PUT /v1/policy`                                    | the policy profiles (§8): rules, envelope, registries, trusted gate-record sources; a new policy record |
| `PUT /v1/quota/{subject}` · `PUT /v1/quota/default` | a subject's quotas (§6.2)                                                                               |
| every owner action, on any template                 | e.g. deactivate or retire another's template, move its tags                                             |
| `POST /v1/templates/{id}/builds/{build}/reject`     | rejects a registered build after the fact (a rule found broken), with the reason; deactivates it        |
| `PUT /v1/templates/{id}/owner`                      | transfers ownership; also hands a declared template (no owner) to a subject (G34)                       |

Host limits stay in each host's settings file (§6.2), set by its operator. Every action, the owner's
or the admin's, writes a provenance record naming its subject (§7).

A template the deployment declared (imported once from `SH_SANDBOX_TEMPLATES` into an empty
catalog, §3.1) has no owner, so its id blocks every self-serve create under it: `409
template_exists` (register G34). An admin hands it to a subject with `PUT
/v1/templates/{id}/owner` (an `owner` record with `before: null`); the subject then builds, tags and
retires it like any template of theirs. A retired template's id stays its owner's: another subject's
create under it is still `409 template_exists`.

## 6. Builds and activation on a host

### 6.1 The host agent

A **new, small service** on each KVM host, `sbx-host-agent` (the user, 2026-11-03; not an extension of
the host janitor, which keeps its one job), beside the workers. It **polls** the control plane and
**reports** to it; it never listens, as the janitor does not (a per-host bearer, no inbound port,
SBX0 §8.3). It has two jobs:

- **Build** (self-serve, new in 0.4): it claims `queued` builds and runs `template-build.sh` on them,
  as an operator does today, then installs the worker (`install-host.sh`) without starting it. A build
  is claimed only when the host's free disk stays above its floor after one more snapshot (the host
  agent's claim floor `SBX_DISK_FLOOR_GB`, 60 G by default; `template-build.sh`'s own refusal,
  `SBX_MIN_FREE_GB`, defaults to 50 G; measured 2026-11-01), counting the disk retained workspaces
  may still grow to (each session's sparse workspace, up to `workspace_mb`, kept until
  `SH_WORKSPACE_IDLE`: what filled bm1 in TB, register W8), and at most `buildConcurrency` at a time
  (default 1). The build log is streamed in `logEntries` (§4); the build record follows (§7).
- **Activate**: start and stop a template's installed worker unit, as `install-host.sh` /
  `setup-microvm.sh --template` do today.

**Each host declares the snapshots it holds** (the user, 2026-11-03): the control plane does not
assign templates to hosts. A build lands on the host that claimed it, and then is in that host's
inventory. On every poll the agent sends its inventory, and the control plane matches it to
registered builds by manifest hash:

| Step | Agent                                                                                                                                      | Control plane                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 1    | `POST /v1/hosts/{host}/inventory`: each installed worker's template id and its snapshot's manifest hash; the host's limits, free disk      | records the inventory; a build is placeable only on hosts holding it            |
| 2    | `POST /v1/hosts/{host}/builds/claim`: up to its free build slots                                                                           | hands out `queued` builds, oldest first, one subject's at a time in turn (§6.2) |
| 3    | builds; `POST /v1/hosts/{host}/builds/{build}/logs` and `/report` (`building`, `probing`, `built` with T and S, or `failed` with the step) | records them; on `built`, checks policy and registers or rejects (§8.2)         |
| 4    | `GET /v1/hosts/{host}/wanted`: the wanted readiness of the builds it holds                                                                 | answers from its store                                                          |
| 5    | for each wanted `active`: check the snapshot's manifest hash is the registered one, then start the worker unit                             | —                                                                               |
| 6    | `POST /v1/hosts/{host}/reports`: `{build, event, reason}`, the event `attached`, `refused` or `detached`                                   | records it (§7); readiness follows the relay's attached record                  |
| 7    | for each wanted `inactive` with no live sessions: stop the unit; for each retired build no longer wanted: remove the snapshot and the unit | —                                                                               |

Activation is a start and deactivation a stop: no file changes, no relay or control-plane restart.
A stopped worker costs no memory. A build no host declares is `unavailable`.

A host agent that is still running reports every build it claimed: `built`, or `failed` on any
other way out. When it cannot carry on with a build it claimed (a gate record it cannot fetch or
whose bytes do not match its sha256, a report not accepted, no template record or manifest after
the build), the failure's reason leads with `agent_error`, so the build never stays `building`.

**The build host handles untrusted images** in a self-serve model. The image is pulled only from a
registry the policy allows (§8.1), its export runs as today (`build-rootfs.sh`, as root, owners kept,
M4) into a size-capped scratch directory, and everything the image runs, runs inside the Firecracker
guest. Hardening the export of a hostile image (G14) is recorded, not solved, for the first version
(A15).

### 6.2 Quotas and the active limit

**Per host** (the user, 2026-11-03): each host's agent reports its `activeLimit` (the workers it may
run at once), `idleLimit` (§6.3), `buildConcurrency` and disk floor with its inventory, from the
host's own settings file. They are set by its operator from the host's memory and disk and the
templates' budgets (measured on bm1: ~26 SWE-bench templates by disk, ~36 workers by memory at
4 GiB guests, A3). The agent also refuses a start that would pass the host's memory, as a second
guard.

**Per subject** (new in 0.4, A22): quotas an admin sets, with a deployment default:
`templates` (owned with a build registered or on its way there, so one whose builds all failed,
were cancelled or retired holds no slot), `buildsQueued` (queued, building or probing at once,
charged to the template's owner even when an admin adds the build), `active` (templates the
subject holds active at once). An activation over the subject's `active` quota replaces that
subject's own least recently used activation (§6.3), or is refused with `409 quota_exceeded` (as
built: refused, `429 quota_exceeded` with `quota: active`; see §6.3). A
create over `templates` or `buildsQueued` is `429 quota_exceeded` with `Retry-After` for the latter.
The quota is read and the build written under one lock per subject, so concurrent creates for
different ids never pass one check together.
Build claims take subjects in turn, so one subject's batch of 50 does not hold every slot.

### 6.3 Aging and replacement (A16)

- **Use:** a build's `lastUsedAt` is the start of its latest session or sandbox (the control plane
  sees every creation).
- **Aging:** an `active` build idle longer than its host's `idleLimit` (§6.2) is moved to
  `deactivating` by the control plane, whoever activated it.
- **Leases:** an activation is a **lease** held by its subject, with a length (`leaseSeconds`,
  default the host's `idleLimit`, at most a day per grant) the client renews
  (`POST /v1/templates/{id}/activate` again) while it still needs the build, e.g. for the life of a
  batch; renewals have no cap (O14). A build under any unexpired lease is held:
  aging and replacement never take it, whether or not a session is live between reps.
- **Replacement:** an activation that would pass the host's `activeLimit` deactivates the `active`
  build on that host with the oldest `lastUsedAt`, no live session and **no unexpired lease**, whoever
  activated it (O11: idle builds only); one that would pass the subject's quota deactivates that
  subject's own oldest. If no build is free, the activation is refused (`409 no_active_slot`), never
  served by evicting a held one: a batch's waits then measure the host's capacity, not its
  neighbours.
- **As built (item 5, c5025b05):** a build is wanted active only while a lease stands, so an
  unleased build is not kept running, and aging is a lease running out. That makes the
  `lastUsedAt` aging and the replacement of idle unleased builds above moot: no build stays active
  without a lease to be replaced. Over the subject's `active` quota the activation is refused
  (`429 quota_exceeded`, `quota: active`); replacing the subject's own oldest is **not built**.
- **As built (register G40, 2026-11-09):** an activation's quota and placement check, its `activate`
  record and its lease write run one activation at a time across the deployment (owner activation
  and first use alike), so concurrent activations of different templates can't together pass a
  subject's quota or a host's `activeLimit`. A lease taken in the same second as a placed build waits
  (`409 no_active_slot`) rather than displacing it. One control plane process per template store is
  what makes that lock enough (RUNBOOK).
- **Live sessions:** a build is never stopped under a live session; `deactivating` drains (no new
  sessions, existing ones finish or expire). If every active build on every holding host has live
  sessions, the activation waits (`activating`, `Retry-After`) or is refused with `409 no_active_slot`.

### 6.4 Activation on first use

So a client can name a template and go, as on E2B: a session or sandbox creation on a `registered`
build that is `inactive` starts its activation (counted against the caller's quota) and answers
`409 template_not_active {readiness: "activating"}` with `Retry-After`; the client retries (`mocactl`
does, within its capacity wait, bcebfaf3). An explicit `activate` before a batch avoids the first
wait; autobench-moca's runner can do either.

**As built (2026-11-04), sandboxes only:** on a deployment with host agents (`SH_TEMPLATE_HOSTS`),
`POST /v1/sandboxes` on a registered build that is not `active` takes the caller's lease (as
`activate`, recorded with `reason: first_use`; its refusals `no_active_slot`, `template_unavailable`
and `quota_exceeded` answer as they would) and answers `409 template_not_active` with `readiness`
and `Retry-After`: the start line's estimate when the host reports a measured start time (an
`activating` build in the host's start line; register G43), else 30 s; `activate: false` starts
nothing. No sandbox record is kept while waiting, so a wait never uses the live-sandbox cap. Without host agents nothing changes. `mocactl sbx create`
and `sbx up` retry it for up to 10 minutes, saying why. **Sessions (Moca Pi)** take the same gate
where a template store exists (combined control plane increment 4, 557c4d26): `POST /v1/sessions`
resolves `sandbox.template` through the catalog, `sandbox.activate: false` starts nothing, and
`mocactl`'s session create waits on the 409. The gate applies whenever template hosts are
configured, also before any of them has reported (register G32, 62677b05): until a host's first
inventory, an attached worker serves and an absent one is refused, not left to wait at the relay.

## 7. Provenance

### 7.1 Records and the chain

Every step writes one record. A record is JSON, append-only, with `prev` (the digest of the record it
follows) so the chain from the image to a session can be walked and checked. Every record names its
**subject** (who, or `policy`, or a host) and when:

| Record                         | Written when                                                                           | Holds                                                                                                                                                                                                                                                                                 | Source (workload plane) |
| ------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `policy`                       | an admin sets the policy                                                               | the profiles, in full; its digest is what every `check` cites                                                                                                                                                                                                                         | the control plane       |
| `create`                       | a client creates a template or a build                                                 | the subject, id, image digest, spec, profile, visibility, the gate record's sha256 if given (the record itself stored beside it)                                                                                                                                                      | the control plane       |
| `gate`                         | a gate record is cited                                                                 | the gate record's digest, its sha256, its source (a trusted source and commit, or `client`) and its gate fields (GATING-RULES §3)                                                                                                                                                     | the image builder       |
| `build`                        | a snapshot is built and its probe passed                                               | the template record T and the manifest S: image digest, `source_record_digest`, manifest hash, kernel/rootfs/agent/vmstate/memfile digests, probe and its result, the Moca commit, the host, when                                                                                     | the host agent          |
| `check`                        | policy is applied, at create and at registration                                       | the policy's digest, the profile, each rule and its result, the outcome (`admitted`, `registered`, `rejected`); at registration, `build` is the **digest of the `build` record** it judged (not the manifest hash, which that record holds), so a check cites exactly what it checked | the control plane       |
| `activate` · `deactivate`      | readiness changes                                                                      | host, worker, manifest hash, subject, reason (owner, first use, aging, replacement, admin); each lease stores its `activate` record's digest                                                                                                                                          |
| `tag` · `visibility` · `owner` | the owner or an admin changes one                                                      | the new value and the one before: `tag` {tag, buildId (null when removed), before}; `visibility` {field (visibility or description), value, before}; `owner` {owner, before}                                                                                                          |
| `retire` · `reject`            | a template or build is retired, or rejected after the fact, and when a host removes it | subject, reason, `from` (the status before), `buildRecord`; a host's removal is a `retire` by `host:<id>` with `event: removed`                                                                                                                                                       |
| `sandbox`                      | a sandbox is created, and when it ends                                                 | at create: sandboxId, buildId, templateManifestHash, `lease` (null with no lease), expiresAt; at end: `state: terminated`, `reason` (`deleted` with endedAt, or `expired`: written by the janitor's sweep when it first sees it, once; the true end is expiresAt)                     |
| `session`                      | a Moca Pi session pinned through the store is created, and when it is deleted          | at create: sessionId, buildId, templateManifestHash, `lease` (null with no lease), `state: created`; at delete: sessionId, buildId, `state: terminated`, `reason: deleted`, endedAt                                                                                                   |
| `use` (summary)                | sessions start                                                                         | per build and day: count, first and last, by subject                                                                                                                                                                                                                                  | the control plane       |

**Every cross-record reference is a record digest** (the sha256 of the referenced record's
canonical JSON), never a time or a name, so a chain composes with no rule but equality: `check.policy`
(the policy record), `check.build`, `retire.buildRecord`, `reject.buildRecord` (the build's `build`
record), `sandbox.lease` and `session.lease` (the `activate` record the sandbox's or session's lease came
from). A rep then joins exactly: its build id is the `build` record's `manifest_hash` and the
`activate`, `sandbox` and `session` records' `buildId`; a session rep's span is its two `session`
records, by sessionId. **As of the 2026-11-06 image** (the `sandbox` kind, `lease` and `buildRecord`):
a store older than that has none of them, and one that spans the change mixes exact links with
links only time can infer (a sandbox under a lease taken before the image has `lease: null`); a
composer should report the two apart. A verifier from before the change refuses a store holding a
`sandbox` record. The `session` kind came later the same day (a Moca Pi session's span, as
`sandbox` for a sandbox): a verifier from before it refuses a store holding one, and sessions
created before it have no `created` record.

### 7.2 Hosting, persistence and offline verification

- **Hosted in the control plane** (D8), in a store that is **not Redis** (A8): an append-only
  directory on the control plane's persistent volume (`SH_PROVENANCE_DIR`), one file per record named
  by its digest (`records/`), a head per stream (`heads/`), and the documents records cite, such as
  gate records, byte for byte (`blobs/`). A **stream** is `policy` or `template/<id>`; a record is
  written before its stream's head moves, so a crash leaves an orphan, never a head naming a missing
  record. The control plane's file credential store is the precedent (`file-store.ts`). Built:
  `packages/control-plane/src/provenance.ts`.
- **Digests, not signatures** (the user, 2026-11-03): every record is named by the sha256 of its
  canonical JSON (keys sorted, no whitespace, integers only, so a second implementation writes the
  same bytes), and names its predecessor's digest in `prev`, with a `seq`, so any edit, drop or
  reorder breaks the chain. Each stream's head (the latest record's digest and the count) is listed in
  the export, to be compared against a copy kept elsewhere. Nothing is signed.
- **Exported**: `GET /v1/provenance/export?template=<id>` (the owner, readers of a `deployment`
  template, admins; _planned_) returns one JSON document (`moca-provenance-export/1`): the template's
  stream, the policy stream, every stream head, and the gate records its `gate` records cite. It is
  **verified offline** by `verify-provenance.py` (stdlib Python, built) or `verifyExport` (the same
  rules in TypeScript; a test runs both on the same exports): every record's digest, `seq` and
  `prev`, each stream's head and count, every blob's sha256, that each `check` cites a policy record
  and each `gate` a blob of the export, and, with `--head`, a head kept elsewhere (an export can only
  prove itself consistent; the kept head catches one that dropped its latest records). **Not built
  yet:** re-running each `check` against its policy, and matching a `build` record's manifest hash
  to a snapshot at hand.
- **Redaction**, for data that must not be kept:
  `deploy/sbx/template-onboarding/redact-provenance.py STORE_DIR TEMPLATE_ID --pattern RE [--apply]`
  (control plane stopped) rewrites the matching records of one stream (a record matches where a
  pattern changes one of its string values; keys are never rewritten) and every later one, moves the
  head, and appends a note to `redactions.log` (counts and heads, never the matched text). With no
  match it says so and changes nothing; every record file the rewritten chain names is kept.
  `--catalog-only` redacts text only the template catalog keeps. Dry run by default. An export taken
  before a redaction no longer verifies against the new head, by design.
- **The workload plane only reports**: the host agent posts build logs, `build`, and
  `activate`/`deactivate` events. The control plane checks and records; it never trusts a report it
  cannot tie to its chain (a `build` report must answer a build it handed to that host).

## 8. Policy: gating without an approver

Self-serve replaces the admin's approval with **policy**: the gating rules
([GATING-RULES](../../deploy/sbx/template-onboarding/governance/GATING-RULES.md)) as machine checks,
applied by the control plane and the build host, each result recorded (`check`, §7). A deployment
offers named **profiles**; an admin writes them (§5.2), and each create names one.

| Profile     | For                                                   | Requires, beyond the `base` rules                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`      | any client's own image (a toolchain, a project's env) | Moca's rules M1-M4, M7-M17; the image from an allowed registry; the size envelope; a probe (the default probe `true` if none) passing in a restored VM (M12)                                                      |
| `benchmark` | SWE-bench, TB and the like                            | a gate record that passed (X1), from a **trusted source** (§8.3), whose `source_record_digest` equals the image digest (X10); X11 (no network), X12 (commits refused), X14 (a measured probe), X15 (the envelope) |

TB-like benchmarks that need packages from the network (a large share of TB2 reps reached PyPI or
GitHub) do not fit X11; a `benchmark-egress` profile (egress through `moca-egress` with an allowlist
whose digest is in the spec and the build record) is open (O13). Until it is decided, TB templates are
created under `base`.

### 8.1 At create (in the control plane, before any build)

M7 (the spec well formed, the id rule), M8, M9 for `benchmark`, X10-X12 and X15 from the spec and the
gate record, the image pinned by digest (M1) **from an allowed registry** (new; closes G2's
allowlist part) and, where the policy lists repositories for that registry (`allowedRepositories`), from
one of them (rule `registry.repository`; whole path segments, `prefix/*` for a prefix), and the caller's
quota (§6.2). A registry with no list allows every repository it serves. A refusal is `422 policy_refused {rule, message}` and
a `check` record; nothing is queued.

### 8.2 At build and registration

On the build host, `template-build.sh` applies what it does today (M1-M4, M10-M13, M15, and X10, X12
with `--gate-record`). On the `built` report, the control plane re-checks the build record against
the create's spec and the policy (the manifest hash covers the fields, PV2; T names the gate record's
sha256), and registers the build or rejects it, with a `check` record either way.

| Rule                                                                                                              | Where                                     | Change                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| X10: `source_record_digest` equals the image digest                                                               | `template-build.sh`; the control plane    | done in `template-build.sh` (26bd6d7f); the control plane checks it again at create and registration                                                                                                               |
| X12: commits stay refused where the spec says                                                                     | `template-build.sh`, T                    | done (26bd6d7f): T records `skip_git_identity_check` and the gate's X5 evidence                                                                                                                                    |
| Gate evidence in T (GATING-RULES §3)                                                                              | `template-build.sh`                       | done (26bd6d7f): `gate_record.{schema, passed, kind, network, user, base_digest, recipe, builder, sha256, commit}`                                                                                                 |
| PV2: the manifest is covered by its digest (done in code: hash version 2)                                         | `build-snapshot.sh`, `vmpool/snapshot.go` | capabilities, image, instance type, guest size, vcpus and the egress CA move into `hash`; the Go manifest gains vcpus and the CA                                                                                   |
| PV3: every snapshot file has a digest (done in code: hash version 2) (the user, 2026-11-03: a digest, no signing) | `build-snapshot.sh`, `vmpool/snapshot.go` | the manifest records the sha256 of `vmstate` and `memfile` too; the build computes them once; the worker checks them at start only if asked (`SH_VERIFY_MEMFILE=1`, a 4 GiB read), and the offline verifier always |
| PV4: worker start checks T (done in code: `SH_TEMPLATE_RECORD`)                                                   | `microvm-worker`                          | compares T's `manifest_hash` and R's image digest with its snapshot                                                                                                                                                |
| Registration                                                                                                      | the control plane                         | automatic: registers a build only with a passed `check` against the policy named at create, and a `build` record from the host the build was handed to                                                             |

### 8.3 Trusted gate-record sources

Without signatures, a gate record proves nothing by itself: a client could write one. The `benchmark`
profile therefore trusts a gate record only from a **source the policy names**: a repository and path
pattern (for image-factory, its repository's `testbeds/` and `platforms/moca/` records), from which
the control plane (or the offline verifier) fetches the record at the cited commit and compares its
sha256 with the one the client sent. A record that cannot be fetched there is refused for `benchmark`
(it may still be stored, as `source: client`, on a `base` build). For the first version the fetch may
be replaced by an admin-loaded copy of the source's records (A23); fetching is G13.

### 8.4 The instance-id mapping

So two clients onboarding the same benchmark instance name it alike (and §3.2's reuse or
`409 template_exists` applies), the `benchmark` profile names its **id rule**, and the control plane
applies it at create: for SWE-bench, the instance id lower-cased, `__` and `_` to `-`, and `-v`
appended **only** to a Verified image whose instance is also in Lite (the user's rule (a),
2026-10-30, `ONBOARDING.md`), refused, never truncated, past 31 characters. Under it every instance
in autobench-sandboxes' four SWE-bench task sets fits (30 Lite and 30 Verified ids, 5 in both;
checked 2026-11-03): the longest are 31, e.g. `scikit-learn-scikit-learn-11310`. Appending `-v` to
every Verified id would not fit: `scikit-learn-scikit-learn-11310-v` and `…-12585-v` are 33. TB's
rule is open (register G12: one TB id is 32 characters). The create names the instance
(`instance: "django__django-11133"`) and the id is derived from it, or checked against it.

## 9. Tracing a run (PV7)

A session's and a sandbox's responses carry `sandbox.templateManifestHash`, and the control plane's
`use` records count them. Any run's result can then be traced: run → template → manifest hash →
`build` record → `check` (policy) → `gate` record → the image builder's record.

## 10. Validation, before any PR (D1, D11)

On bm1 with ykt3's control plane, autobench-moca driving the workload (D2) as a self-serve client, a
scripted mock model first (A13):

1. image-factory's gated images for K instances (K = 4, then more); its records loaded as the
   `benchmark` profile's trusted source (A23);
2. the client creates each template through the API (`profile: benchmark`); the host agent builds and
   probes; policy registers them; one deliberately broken create (a mismatched `source_record_digest`)
   is refused with its rule id, and one broken probe fails at `probing`;
3. a second client creates the same instance: the build is reused (§3.2) or the id is refused
   (`409 template_exists`), as designed;
4. the client activates (and, for one template, relies on activation on first use, §6.4); readiness
   `active`; its quota is reached and replacement takes its own oldest;
5. autobench-moca's runner opens sessions naming each instance's template, several instances at once;
6. aging and replacement: more templates than `activeLimit`, the window moves by itself;
7. export the provenance and verify it offline, from a machine with no access to the cluster;
8. then a real model and grading, with the user's OK; then the PRs, from what this proved. Grading a
   microVM workspace off the host needs a way out of the 8 MiB Exec output cap (register W6, O15).

autobench-moca's runner plan (its private `Plan-20261103-template-arm.md`): templates are created
(or reused) and followed to `registered`, and a window of K is activated, before any timed span;
creations send `activate: false`, so first-use activation never falls inside a rep; each rep records
its template, `buildId` and `sandbox.templateManifestHash`, and a hash other than the frozen `buildId`
voids the rep; the model-free stage replays recorded trajectories before the scripted mock model.

The process doc (`PROCESS.md`) is updated at each step, and the validation follows it as written.

### 10.1 Status (windows 1 and 2, 2026-11-04)

Window 1: stock agents only, the sandbox profile, the control-plane image
`sbx-template-0fb59160`, bm1's host agent, autobench-moca's runner as a non-admin client, K = 4
(django-11133, astropy-14995, sympy-12481, sympy-18189).

| Step | Result                                                                                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | done: image-factory's four records the policy's trusted gate records (A23)                                                                                                                                          |
| 2    | **all four built by the host agent and registered by policy**, no approver; the mismatched create refused at create (`422`, X10); the broken probe not reached (host-agent fixes made during the window)            |
| 3    | not run as designed: a duplicate create queued a second build (G21, reuse not built)                                                                                                                                |
| 4    | all four `active` by lease within 143 s, no eviction; first use (§6.4) not built                                                                                                                                    |
| 5    | sandboxes on `id@buildId`: served `buildId` and `templateManifestHash` = the pinned ones, for every sandbox; the replays' patches **not compared**: commands of about 40 KB or more stall over the exec Route (G26) |
| 6    | not exercised                                                                                                                                                                                                       |
| 7    | **8 chains, 83 records verified offline** (`verify-provenance.py`, rc 0); every snapshot digest matches the chain                                                                                                   |
| 8    | not started                                                                                                                                                                                                         |

Also found: Valkey 9 cannot read Redis 7.4's RDB 12 (G20, `SBX_REDIS_IMAGE`); a registry host
reached one build's reason and record and four build logs, now redacted by the agent and removed
from the store with `redact-provenance.py` (G25); the quota hides the sandbox cap (G27); T and S
are kept unredacted (G28). **Window 2:** the replays with file bytes as Exec stdin, G26 bisected,
the broken probe rerun, then the Moca Pi arm with the combined control plane.

**Window 2** (2026-11-04, the same four instances, code 521efe5c, `SBX_ACTIVE_LIMIT=2`):

| Step | Result                                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2    | **all four built fresh and registered** (G29: no reuse of window 1's removed snapshots); the mismatched create refused (X10); the broken probe failed `probe_failed`, its reason without a registry host |
| 3    | **passed separately (2026-11-05)**: a second subject's create of the same id and its new build `409 template_exists`, its cancel `403`; reads allowed                                                    |
| 4    | first use passed: `409 template_not_active`, `Retry-After: 30`, the caller's lease taken                                                                                                                 |
| 5    | the build check passed for each; writes as Exec stdin, no stall (G26 fixed); **every patch matches** its recording                                                                                       |
| 6    | aging passed: two windows of 2, the second placed as the first's leases ended                                                                                                                            |
| 7    | **8 chains, 140 records verified offline**; every snapshot digest matches                                                                                                                                |
| 8    | not started                                                                                                                                                                                              |

Open from window 2: client-side stalls of about 20 s on some Execs (register G30).

**Window 3** (2026-11-05, measurements, the same image and host setup): every build, patch and build check
as in window 2; G30's cause is the client's DNS (not Moca's); G31's baseline, about
86-108 s from each activation's request, both of a pair together. **Step 3** passed the same day on
ykt3 with a second enrolled subject (fssapi): its create of an existing id and its new build of
another's template `409 template_exists`, its cancel `403`.

**Window 4** (2026-11-05, measurements with the host agent's `--wanted-only` and the client's
resolved-address dial): activation 10.8-17.4 s from each request (window 3: 86-108 s, register
G31); 0 DNS stalls (G30); the rebuilt workers report `moca.dev/build` (G19); patches and build
check passed for each; a probe failure reported at step `probe`.

**The combined control plane's attach window** (2026-11-05, `moca-combined`, no model): the same four
templates created self-serve by a user with no role, built by bm1's host agent and registered by
policy (all four; the broken gate refused at create, X10; the broken probe failed at `probe`); a
stock-agent sandbox and a **Moca Pi session both pinned to django's build**, on one control plane,
the session's record carrying `sandboxTemplate` and `sandboxBuildId`; first use through a session
(`409 template_not_active`, then `201` after 23 s); activation in 13-18 s; the active limit refusing
a third (`no_active_slot`); 8 chains and 52 records verified offline. Steps 2, 4, 5 (sessions now
included), 6 and 7 hold on the combined control plane.

**Step 8** (2026-11-06, `moca-sbx-template`, a real model): **DeepSeek-V4.1-Flash on CurveBender**, not
Sonnet; two stock brains (Claude Code 2.1.286 and OpenCode 1.18.35), 3 reps × 4 instances each, on
fresh self-serve builds (the broken gate refused, X10; the broken probe failed at `probe`). **every rep
recorded with no void**, each on its first attempt; every sandbox served its pinned build
(`buildId` = manifest hash = pin); activations 13.8-21.1 s; a token renewal path through a forwarder
proven in the dry run. Graded with the official harness; the grading stays in autobench-moca's records (`runs/step8-1-b`,
not published). Resolution, tokens and model time do not compare with the Sonnet baseline (another
model); the sandbox-side measures do. Step 7 again
afterwards: 8 chains and 291 records verified offline, each of the four builds with its `build`
record and its activations in the chain.

**The lifecycle window** (2026-11-06, `moca-sbx-template` on the lifecycle image `40fc7a80`, no
model): the whole template lifecycle through the API, by a user with no role, no operator step.
Four templates created self-serve and registered by policy (the broken gate refused, X10; the broken
probe failed at `probe`); first use; replays on pinned builds (every patch matched); then **retire**: each
template's every build retired (a whole-template retire includes earlier windows' builds), a create
after it refused `410 template_retired`, readiness `retired` within about a second, and bm1's host
agent **removed each build's worker and snapshot by itself** (step 7), seen through the API as
`heldBy` emptying in 17-32 s. Provenance after: 375 records verified, and every chain from before
the window an unchanged prefix of its chain after (84 records appended, none rewritten). An
independent composer (autobench-moca's) joined each of the window's reps through the store with
**every link unique**: build, registration, policy, create, gate, the sandbox's lease, the sandbox's
span, and the retire with the host's removal (register G33 validated). Earlier reps, made before the
`sandbox` record kind existed, still read their lease by time, as §7.1 says a store spanning the
change does.

**Step 8 again** (2026-11-06, `moca-sbx-template` on the lifecycle image): the same design as step
8 (DeepSeek-V4.1-Flash on CurveBender, two stock brains, the same four instances), on fresh builds of
the templates the lifecycle window had retired, ending in retire with the host's own removal. Every
rep recorded on its pinned build; graded with the official harness (the grading stays in
autobench-moca's records). Provenance after: every earlier chain an unchanged prefix, and the
composer joined **every link of every rep** uniquely: the first graded reps whose whole chain, from
the gate record to the sandbox's lease and the build's retire, composes exactly.

**Lite-28 on templates** (2026-11-06/07, `moca-sbx-template`, stock brains on DeepSeek): the SWE-bench
Lite instances image-factory records, as self-serve templates in three groups, each group built and
registered by policy, used on pinned builds, then retired, with the host agent's removal checked
before the next group created. One instance was left out: its id is a template the deployment
declares, which blocks a self-serve create under the same id (register G34). Provenance after: every
earlier chain an unchanged prefix, and the composer joined every link of every rep uniquely. Two reps
on one template at once at the minimum worker budget hit admission refusals (register G36), fixed in
the clients and by sizing the budget for the reps run at once.

**The Moca Pi window** (2026-11-07, `moca-combined` on `87b02d64`): **two brains on one control plane
and one build.** On each of window 4's four templates, built fresh, a stock agent (OpenCode) on a
sandbox and Moca Pi on a session, both pinned to the same `id@buildId`, DeepSeek on CurveBender.
Every Moca Pi session was seeded from its pinned build's own spec (`sandbox.seed.source: build`),
returned its workspace's patch against the seed's baseline with the turn (`TurnResult.workspace`,
checksum and size matching), and was deleted at the end of its rep. At a worker budget sized for the
reps run at once, no admission refusal. Retire and the host's removal as before. Provenance after:
every earlier chain an unchanged prefix, a `session` record at each session's create (naming its
lease and build) and delete, and the composer joined **every link of every rep uniquely for both
brains**: the stock agent's through its `sandbox` records, Moca Pi's through its `session` records.
Found: mocactl's `--option sandboxTemplate` accepts only declared ids, not `id@buildId` (register G37):
the session is created through the API, then run with `mocactl run --session`.

## 11. Order of work

1. §8.2's remaining gating changes (PV2, PV3, PV4): no API change, testable alone (X10, X12 and the
   evidence fields are done, 26bd6d7f; PV2, PV3 and PV4 in code: manifest hash version 2 and
   `SH_TEMPLATE_RECORD`; proven on bm1 in windows 1 and 2).
2. The provenance store and records (§7), with offline verification, for `build`, `check` and
   `policy` first (store and verifiers done: `provenance.ts`, `verify-provenance.py`; records are
   written once the routes exist).
3. Templates in the store, states and the read API (§3, §4), with owners and visibility. **Built**
   (20d0995c, then increment 2): the catalog (`template-catalog.ts`; `SH_PROVENANCE_DIR` imports the
   env list once, with a `create` record each), `GET /v1/templates` (with `hosts`, empty until a host
   agent reports), `/{id}`, `/builds`, `/builds/{build}`, `/tags`, on **both** profiles (§4.1);
   `404 template_not_found`; readiness `active`/`inactive` from the relay's presence (`unknown` when
   unreadable); `lastUsedAt` and `capacity.inUse` from sandbox records on the sandbox profile (null on
   the harness profile until `use` records exist). The transitional readiness states, the hosts'
   contents and builds from template records came with item 5. Not yet: the client logs route. The
   combined harness-and-sandbox control plane of §4.1, with SBX0's token rules, is built (its own
   design, 2026-11-05: the `combined` route profile, increments 1-5), deployed on ykt3 (`moca-combined`, 2026-11-05)
   and attached to bm1's workers in one window (§10.1).
4. Create and policy at create (§4, §8.1), quotas (§6.2). **Built:** `POST /v1/templates` and
   `POST /v1/templates/{id}/builds` (202, a `b-<26 hex>` handle, status `queued`), `GET`/`PUT
/v1/policy` (admin PUT; every change a `policy` record), `GET /v1/quota`; the create-time rules
   (`template-policy.ts`: M1, M7, M8, M9, the registry allowlist, the envelope, X1 + trusted gate
   records (A23), X10, X11, X12 (fail closed), X14, X15), `422 policy_refused` with `rule`,
   `409 template_exists`, `429 quota_exceeded` with `quota`; `create`, `gate` and `check` records.
   The repository's SWE-bench example passes the benchmark profile in full. Cancel built (G22); the quota shows active leases and the live-sandbox cap (G27). **Every
   §5 activity is built (2026-11-06, the user: "our APIs must cover all lifecycle management
   activities for templates, from creation to retire"):** retire a template or one build
   (65e5b500; refused under a live sandbox or an active pinned session, c571226a), tags moved and
   removed (03d5a4b9), an admin's reject after the fact (f5bc68a7), description and visibility,
   and an admin's owner transfer (5aa8789a), admin quotas by subject (13bc0f72); each writes its
   record naming the caller, and `mocactl sbx templates` has a subcommand for each. Not yet
   deployed (the image after the v0.10.0 merge).
5. The host agent: builds (claim, run `template-build.sh`, logs, report) and automatic registration
   (§6.1, §8.2). **Built, first increment:** the host routes (`auth: host`, `SH_TEMPLATE_HOSTS` and
   `SH_HOST_TOKEN_<ID>`; a host reports only for itself) for inventory, claim (oldest first,
   subjects in turn), the gate record's bytes, log and report; on `built`, T and S stored byte for
   byte, a `build` record, and automatic registration or rejection naming the rule (T against the
   create's request, S hash version 2, R's digest, size, gate record, X12), with a `check` record;
   the first registered build takes `default`. `deploy/sbx/host-agent.sh` (one poll; the 0600
   header-file token; the disk floor; the gate record checked against its digest) with its unit and
   timer. **Then the activation half:** leases (`POST /v1/templates/{id}/activate` · `/deactivate`;
   60 s-1 day a grant, renewals unlimited), placement on the holding host with the fewest builds,
   within its `activeLimit`, first-leased first, never evicting (`409 no_active_slot` with
   Retry-After), the `active` quota, `GET /v1/hosts/{host}/wanted` (run, and stop only with no
   lease and no live sandbox), the agent's start/stop of **installed** workers with attach,
   refused and detach reports, readiness `activating`/`deactivating`/`unavailable`, and the hosts
   block filled. A build is followed by its handle after registration, and carries `reason`. Not
   yet: installing a worker (G18: its relay token is minted only by `setup.sh`), the session's
   `409 template_not_active` (first use is built for sandboxes, §6.4), the client logs route and
   `install-host.sh --host-agent`. Run on bm1 in windows 1 and 2 (§10.1).
6. Activation by the owner, the limits, aging, replacement and first use (§5.1, §6). Built with
   item 5 (leases, limits, aging as leases ending; no eviction); first use for sandboxes (§6.4).
7. Tracing (§9). **Built:** a sandbox's template reference (`id`, `id:tag`, `id@sha256:…`) resolves
   through the catalog to one registered build at creation, kept for its life, and the Sandbox
   carries `buildId` and `templateManifestHash`; a session records `sandboxBuildId` (its
   template's default build at creation, or the one `id@sha256:…` pins). Turns run on the session's
   build's workers (register G19, fixed by the combined control plane's increment 5: the
   `moca.dev/build` label). Not yet: `use` records.
8. The validation (§10). **Window 1** (decided 2026-11-04): stock agents only, on the SBX0 sandbox
   profile with `setup.sh SBX_TEMPLATE_STORE=1 SBX_TEMPLATE_HOSTS=bm1` (a7eca0a7) and a control-plane
   image built from the branch (`ghcr.io/webchang/moca:sbx-template-0fb59160`); template workers
   pre-installed on bm1 (G18); autobench-moca's runner as the client. The Moca Pi arm follows with the
   combined control plane. **Run 2026-11-04** (§10.1): window 1 passed steps 1, 2, 4 and 7;
   window 2 passed 2, 4, 5 (every patch matched), 6 and 7; step 3 passed with a second subject
   (2026-11-05); windows 3 and 4 measured G30 and G31 (2026-11-05); the combined control plane's attach
   window passed 2, 4, 5 (a sandbox and a Moca Pi session on one build), 6 and 7 (2026-11-05); step 8
   ran 2026-11-06 with DeepSeek on CurveBender: every rep completed with no void, every one on its pinned build.
   The lifecycle window (2026-11-06) ran create through retire through the API, with the host's
   own removal and every provenance link unique.
   Step 8 again, on the lifecycle image (2026-11-06): every link of every real-model rep unique.

## 12. Decisions

### 12.1 On the open questions of 0.2 (the user, 2026-11-03)

| #   | Question                                                           | Decision                                                                                  | Where          |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------- |
| O1  | Hash and sign vmstate and memfile too?                             | **a digest, no signing**: every snapshot file has a digest; records are chained by digest | §7.2, §8 (PV3) |
| O2  | `idleLimit` and `activeLimit`: per deployment, per host, computed? | **per host**                                                                              | §6.2           |
| O3  | The control plane assigns templates to hosts, or hosts declare?    | **each host declares the snapshots it holds**                                             | §6.1           |
| O4  | The host agent: a new service, or the janitor extended?            | **a new service**, `sbx-host-agent`                                                       | §6.1           |
| O5  | Templates declared in the store, not `SH_SANDBOX_TEMPLATES`?       | **declared in the store**; the env list imported once into an empty store                 | §3.1           |

### 12.2 Self-serve (the user, 2026-11-03; D12, D13)

| #   | Question                                   | Decision                                                                                                                        | Where      |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| O6  | Who may build a template?                  | **any enrolled client**; policy gates it automatically; admins set policy and quotas, and can retire                            | §4, §5, §8 |
| O7  | Where does a client's image get its gate?  | **Moca gates it** (the `base` profile); a trusted builder's gate record is extra evidence, **required for benchmark templates** | §8         |
| O8  | Who activates and deactivates?             | **clients, within quotas**; aging and LRU free slots; admins set quotas and can deactivate any                                  | §5.1, §6   |
| O9  | Build steps in code (E2B's builder chain)? | **not now**: clients bring a finished image by digest                                                                           | §3.2       |

### 12.3 Open, for the review

| #   | Question                                                                                                      | Proposed                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O10 | Default visibility of a new template                                                                          | `deployment` (benchmark templates are shared); autobench-moca agrees                                                                                                                                |
| O11 | May a non-owner's activation replace the owner's oldest, or only idle builds of anyone's (as §6.3)?           | idle builds of anyone's, oldest first, never a leased one (§6.3); autobench-moca agrees                                                                                                             |
| O12 | Private registries: a client's pull credential, or only registries the build hosts can already pull from?     | the latter for the first version (G16); autobench-moca agrees                                                                                                                                       |
| O13 | TB needs egress through an allowlist: a `benchmark-egress` profile, or TB out of scope for the first version? | out of scope for the first validation (SWE-bench only); the profile after it; autobench-moca agrees                                                                                                 |
| O14 | A lease's default length and its maximum                                                                      | the host's `idleLimit`, at most a day per grant; **renewal extends it without limit** while the holder renews (batches have run 17.4 h; the runner renews at half the lease); autobench-moca agrees |
| O15 | Workspace export (W6): a route (a tar stream of `/workspace`), or grading on the host?                        | a route, `GET /v1/sandboxes/{id}/workspace.tar`, after the validation; grading on the host for it (as AM's microVM cells did); autobench-moca agrees                                                |
