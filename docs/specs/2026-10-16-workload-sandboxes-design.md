# Per-workload sandboxes and storage (`/workloads` phase 2) — Design

**Date:** 2026-10-16 · **Status:** Proposed · **Issue:**
[#476](https://github.com/rossoctl/moca/issues/476) (phase 2: per-workload sandboxes and storage),
which also took over the writable-workspace threads of #517 (context for delegated tasks).
**Decision record:** [ADR-0043](../adrs/0043-workload-sandboxes-provisioner.md).
**Builds on (reuse, no redesign):** the `/workloads` lifecycle
(`packages/knative-server/src/workloads.ts`);
[per-subject claim names](2026-10-15-per-subject-claim-names-design.md) (#543, per-subject claim
names for #358) and its companion
[rossoctl/context-service#59](https://github.com/rossoctl/context-service/issues/59) (caller-named
claims); [rossoctl/context-service#40](https://github.com/rossoctl/context-service/issues/40) (a
trusted call that resolves a Context into its PVC);
[P6 on Kubernetes](2026-10-02-p6-on-kubernetes-slice1-design.md) and its tiers and affinity
([slice 3](2026-10-04-p6-on-kubernetes-slice3-design.md));
[MI1](2026-09-28-moca-multi-user-isolation-design.md) (multi-user isolation).
**Amends (on acceptance):** MI1 §2.3, §9.1 and §13 (§9).

## 1. Problem

MOCA's Kubernetes deployment runs P6 (the process-manager runtime: a supervisor and its forked
workers) against a fixed pool of sandbox workers. The pool is one static StatefulSet,
`moca-sandbox` (`deploy/k8s/base/sandbox.yaml`), sized at install time by `SH_SANDBOX_COUNT`.
Nothing creates or deletes a sandbox while MOCA runs. Phase 1 of `/workloads` therefore copies a
workload's frozen context into whichever shared sandbox a run lands on
(`harness/src/context-overlay.ts`), and #532 (writable per-run copy) gives each run a throwaway
writable copy. That leaves three gaps:

- **No isolation between users.** Alice's and Bob's runs share sandboxes: one `/workspace`, one
  process list, one Unix user. `context-overlay.ts` says so itself: isolation between users needs
  separate sandboxes.
- **No durable working tree.** A writable copy is discarded after its run, so an always-on
  workload (a BugStone pipeline with its repositories loaded) cannot keep state.
- **Copies, not mounts.** Every run re-delivers the bundle, within the 256 MiB bundle limit.

#476 asks that each workload get its own sandboxes and, where useful, a mounted Context PVC, with
`DELETE /workloads/{id}` removing all of it.

### 1.1 Facts this design rests on (upstream/main `068711f1`)

- **Registration.** A worker dials the relay and sends `Hello{sandboxId, labels, capabilities}`.
  The relay writes the labels into `sh:sandbox:records` exactly as sent
  (`packages/sandbox-relay/src/relay.ts`, the `frame.hello` handler). The attach token is looked up
  as `$SH_RELAY_TOKEN_DIR/<id>`, then `SH_RELAY_TOKEN_<id>`, then the shared `SH_RELAY_TOKEN`
  (`makeDefaultValidateToken`, `main.ts`). The directory is used only for ids matching
  `^[A-Za-z_][A-Za-z0-9_]*$`, so the dashed `moca-sandbox-N` pods all fall through to the one shared
  token.
- **Selection.** `harness/src/select-sandbox.ts` filters records by `moca.dev/tier` and nothing
  else. It runs in the worker, not in the supervisor.
- **Redis is not a trusted store.** The supervisor's workers hold the same `REDIS_URL` as the relay
  (`deploy/k8s/base/redis.yaml`: "whoever can write it chooses the executor for every turn").
- **RBAC.** The supervisor, relay and sandboxes run with `automountServiceAccountToken: false`. The
  control plane has a Role on Secrets in `moca-credentials` only.
- **Every workload already has a PVC.** `createContext` (`context-service.ts`) always asks Context
  Service for a managed PVC, hard-coding `accessMode: ReadWriteOnce`; the sandbox never mounts it.
- **Workload lifecycle.** `creating`, `awaiting_upload`, then activation freezes the revision and
  the record is `ready`; delete goes through `deleting` to `deleted`. A frozen Context takes no
  further upload (`context_frozen`).
- **Context Service.** It names a managed PVC `context-<name>`, places it in the namespace the
  request names (`CONTEXT_SERVICE_NAMESPACE` on MOCA's side), and holds a ClusterRole over PVCs,
  ConfigMaps and helper pods in every namespace. Upload and export run in short-lived helper pods
  that mount the PVC (`internal/kube/context_upload.go`); they set no node affinity. Delete answers
  `409 in_use` while any pod mounts the claim (`manager.go`). Revisions live on the PVC under
  `.context-service/materialized/<digest>/`, and the revision id is the digest of exactly that
  directory.
- **Precedent.** The unmerged P6 rework of #455 (kept locally as a reference, never pushed) created
  agent-sandbox `Sandbox` CRs per workload, labelled with the workload, with the claim mounted
  read-only at `subPath: .context-service/materialized/<revision>`, and rolled back on failure.

### 1.2 Acceptance (#476)

1. On Kind, Alice and Bob each create a workload and delegate tasks to it.
2. A run of Alice's workload executes only on Alice's workload sandboxes. A run with no workload
   never executes there.
3. Neither user can see the other's context or working tree, whatever their sandboxes send at
   registration.
4. A workload can mount its Context read-only, or writable for delegated tasks, with no per-run
   copy.
5. `DELETE /workloads/{id}` removes the sandboxes, their token Secret, the Context and its PVC, and
   leaves no orphans when a step fails.
6. Phase 1 workloads, created without the new fields, behave exactly as today.

## 2. Design overview

![Per-workload sandboxes: create, activate, provision, attach, run and delete](workload-sandboxes-flow.svg)

1. **Create the workload:** the client calls `POST /workloads` with `sandboxes` and
   `workspace.mount`, and uploads the bundle with the grant, as in phase 1. The worker creates the
   Context and its PVC in `moca-sandbox` (`POST /internal/v1/contexts`).
2. **Activate:** `POST /workloads/{id}/activate` freezes the revision and moves the record to
   `provisioning`.
3. **Request sandboxes:** the worker calls `PUT /internal/v1/workloads/{name}/{generation}` on
   `moca-provisioner` with its service token and the caller's API token; the provisioner derives
   `wl` from the verified owner, name and generation.
4. **Find the storage:** the provisioner resolves the Context into its PVC through
   context-service#40's trusted resolve-attachment call, which requires `attach` for the owner and
   returns `{namespace, claimName, backend, accessMode}`.
5. **Create the sandboxes:** through the Kubernetes API, the provisioner creates StatefulSet `<wl>`,
   headless Service `<wl>` and Secret `<wl>-attach` (the attach token, mounted as a file) in
   `moca-sandbox`.
6. **Mount the context:** the sandbox pods `<wl>-<n>` mount the Context PVC at `/workspace/context`:
   read-only at `subPath: .context-service/materialized/<revision>`, or writable at
   `subPath: moca-workspace`, seeded once by an init container.
7. **Register with the relay:** each pod attaches to the relay with `Hello` + attach token; the
   relay stamps the trusted `moca.dev/workload` and `moca.dev/owner` labels, whatever `Hello` sent.
   Once `count` sandboxes are registered the record is `ready`.
8. **Run a task:** `POST /v1/runs` names the workload; selection keeps only records whose
   `moca.dev/workload` and `moca.dev/owner` match, and the worker runs the task with
   `SandboxExec.Exec` carrying the `workload` field, which the relay checks.
9. **Delete:** `DELETE /workloads/{id}` removes the sandboxes first
   (`DELETE /internal/v1/workloads/{name}/{generation}`, `200` once no pod remains), then the
   Context and its managed PVC (`DELETE /internal/v1/namespaces/{ns}/contexts/{name}`), because Context Service
   refuses to delete a mounted claim.

In short: a new `moca-provisioner` (§4, ADR-0043), the only MOCA component with Kubernetes
permissions in the sandbox namespace, creates each workload's sandbox pods at activation (§6). It
signs a token from which the relay sets the pods' workload and owner labels (§3), and mounts the
workload's Context PVC, resolved through context-service#40 (§5). `POST /workloads` gains two
optional fields (§7).

## 3. Trusted workload labels

### 3.1 The binding token

The provisioner holds an Ed25519 key. For each workload it mints one **attach token**, a JWT whose
header has `alg: EdDSA`, `typ: moca-attach+jwt` and a `kid`, with these claims, all required:

| Claim | Meaning                                                                            |
| ----- | ---------------------------------------------------------------------------------- |
| `iss` | `moca-provisioner`                                                                 |
| `aud` | `moca-relay-attach`, so it never passes as a session, API or sandbox token         |
| `wl`  | the workload key: the record's existing Context name, `w-<32 hex>` per reservation |
| `own` | the owner scope: `recordScope(owner)`, the hash the record key already uses        |
| `gen` | the workload generation, so a re-created workload gets a different binding         |
| `tr`  | the tier, `container`                                                              |
| `n`   | the workload's `sandboxes.count`; the relay accepts only ordinals below it         |
| `iat` | issued at                                                                          |
| `exp` | expiry, `iat` + `MOCA_ATTACH_TOKEN_TTL_S` (default 86400, one day)                 |
| `jti` | a random id, for logs                                                              |

The token goes into a per-workload Secret in `moca-sandbox`. The pods mount that Secret as a file
(`SANDBOX_TOKEN_FILE`, not an env var and not a `subPath`, so the kubelet refreshes it in place).
The relay verifies the token with public keys only (`MOCA_ATTACH_PUBLIC_KEYS`, a
`<kid>:<base64 SPKI>` list in the format of `SH_SESSION_TOKEN_PUBLIC_KEYS`), so the relay cannot
mint one and a sandbox cannot forge one. The name `moca-attach+jwt` stays clear of SBX0's
`moca-sandbox+jwt` client token (#546, SBX0 sandbox service), which authorizes callers, not workers.

**Expiry and rotation.** The provisioner re-mints a workload's token once less than half its
lifetime remains, on its reconciler loop (§6.2), and updates the Secret. The worker re-reads the
file whenever it dials, and when the file changes it reconnects with the new token at its next
idle moment (no Exec in flight). The relay closes an attach stream when its token's `exp` passes,
so no stream outlives its token. Phase 2 PR 1 re-reads the file only on dial, so that close at
`exp` is a hard cut, Execs in flight included; the idle reconnect on a file change is deferred to
PR 2, whose re-mint must land well before `exp`.
Rotating the provisioner's key is the usual overlap: add the new
`<kid>` to `MOCA_ATTACH_PUBLIC_KEYS`, switch the provisioner to it (every token is re-minted within
half a TTL), and drop the old key one TTL later. A projected, pod-bound credential (a
ServiceAccount token with the relay as audience, checked through TokenReview) would bind the token
to one pod; it needs the relay to call the Kubernetes API and is left as a later option.

**The worker can read its own token.** `commandEnv` keeps the token out of a command's environment,
but model code runs as the same UID (1001) in the same container as the worker process, so it can
read the token from the mounted file or from `/proc/<worker pid>/`. The design assumes model code
holds its workload's token; §9 records what that is worth to it.

**Why a signed token and not a store lookup.** The proposal was a trusted
`sandboxId → {workload, owner}` store. In this deployment the only shared store is Redis, and the
workers can write it, so a binding there is no more trusted than a `Hello` label. A Redis ACL that
gives the provisioner a write-only prefix would work, but it needs ACL users the deployment does not
have, and the relay would still do a lookup on every attach. A signed token carries the binding
itself, adds no store, and keeps the relay's attach path synchronous.

**One token per workload, not per sandbox.** A StatefulSet's pods share one template, so they
cannot each read a different Secret. All of a workload's sandboxes belong to one owner, so a token
stolen from one of them lets the thief register only another sandbox of that same workload, under
an ordinal below `n`, until `exp`. That crosses no user boundary: MI1 §9.2's argument for
per-sandbox tokens, applied one level up.

### 3.2 What the relay does on `Hello`

- **Token is an attach token.** The relay requires an unexpired token, and a `sandboxId` matching
  `^<wl>-(0|[1-9][0-9]*)$` whose ordinal is below `n`, then writes the record with
  `moca.dev/workload=<wl>`, `moca.dev/owner=<own>` and `moca.dev/tier=<tr>`, overwriting whatever
  `Hello` sent for those three keys. Other labels and capabilities pass through as today.
- **Token is a shared or per-id token (today's path).** The relay **removes** any
  `moca.dev/workload` or `moca.dev/owner` label from `Hello`. Without this, a shared-pool sandbox
  could claim to be Alice's.
- The duplicate-id refusal is unchanged, so a stolen token cannot take over a live sandbox's id.

A deleted workload's token stays valid until its `exp`, and nothing re-mints it. Until then, a copy
kept by its model code can register only a sandbox labelled with a workload key that no record has
any more; re-creating the same name gives a new `gen` and therefore a new `wl`. No run routes
there, so the token is harmless after delete.

### 3.3 Selection and the relay's Exec check

- **Selection** (`select-sandbox.ts`, in the worker). A run that names a workload considers only
  records whose `moca.dev/workload` equals the workload's key **and** whose `moca.dev/owner`
  equals `recordScope` of the run's owner, a second check on the same signed binding. A run
  without one excludes every record that carries the label. When the workload has no live sandbox,
  the run waits for the P6.3 affinity grace and then fails with
  `503 workload_sandbox_unavailable`. It never falls back to the shared pool.
- **Relay check (defense in depth).** The SandboxExec request gains an additive `workload` field
  (ADR-0024's rules). The relay refuses an Exec to a sandbox with a `moca.dev/workload` label unless
  the field matches, and refuses a non-empty `workload` on a sandbox without one.

The relay check stops bugs, not a compromised worker. The worker fills in `workload`, and nothing
signed tells the relay which user a run belongs to. That needs MI1 S2's control-plane-signed
grants (MI1 §4.2 I2). Until then the worker remains the trust root for routing, as it is today.

## 4. The provisioner

### 4.1 What it is

`moca-provisioner` is a small HTTP service in the `moca` namespace (`packages/provisioner`,
`@moca/provisioner`). Its ServiceAccount is bound to one Role in `moca-sandbox`:

| Resource                 | Verbs                             | Why                                          |
| ------------------------ | --------------------------------- | -------------------------------------------- |
| `apps/statefulsets`      | create, get, list, patch, delete  | one per workload                             |
| `secrets`                | create, get, list, update, delete | the workload's attach token, re-minted       |
| `services`               | create, get, delete               | the StatefulSet's headless governing Service |
| `pods`                   | get, list                         | readiness, and the reconciler's view         |
| `persistentvolumeclaims` | get                               | check that a resolved claim exists           |

No create on bare pods. The governing Service is headless with no ports, as the shared pool's is:
a workload sandbox accepts no connections. The provisioner has no rights outside `moca-sandbox`,
and none on PVCs beyond `get`: Context Service creates and deletes the claim. The control plane,
supervisor and relay stay without a Kubernetes token.

Its internal API is reached only by the supervisor's workers (NetworkPolicy):

```
PUT    /internal/v1/workloads/{name}/{generation}   # create or update; idempotent by (wl, gen)
GET    /internal/v1/workloads/{name}/{generation}   # replicas wanted and ready
DELETE /internal/v1/workloads/{name}/{generation}   # delete; 200 once no pod of it remains
```

The `PUT` body carries `count`, `tier`, `mount` and the frozen revision; no request carries a
workload key.

**Caller authentication.** The worker presents a service token (`MOCA_PROVISIONER_TOKEN`, one
caller credential per `/internal` endpoint, MI1 I8) **and** forwards the caller's own API token.
The provisioner verifies that token with `SH_SESSION_TOKEN_PUBLIC_KEYS`, as the supervisor already
does, and takes the owner from it. It then derives the workload key itself, exactly as
`workloads.ts` names the Context: `wl = "w-" + sha256(owner \0 name \0 generation)`, first 32 hex
characters. A worker cannot name another user's `wl`, so a compromised worker can provision, and
mint bindings, only for workloads of users whose tokens it currently holds. The reconciler acts
without a user token, but it only deletes.

### 4.2 What it creates

For workload key `wl`:

- Secret `<wl>-attach`: the attach token.
- Service `<wl>`: headless, no ports, the StatefulSet's governing Service.
- StatefulSet `<wl>`: `replicas = sandboxes.count`, pods labelled `app: moca-workload-sandbox`,
  `moca.dev/workload`, `moca.dev/owner`, and annotated with the record key and generation. The pod
  spec is the shared pool's (`sandbox.yaml`: non-root, `drop: ALL`, no service-account token,
  RuntimeDefault seccomp) with resources fixed by the operator per tier. Callers choose nothing in
  the pod spec except count, tier and mount mode.
- The pods get their own label so the shared StatefulSet's selector (`app: moca-sandbox`) never
  matches them. A static NetworkPolicy for `app: moca-workload-sandbox`, installed with the base,
  gives them the shared pool's egress: the relay's attach port and the public internet, without
  private ranges, so one workload's pods cannot reach another's.

A StatefulSet, not bare pods: a pod that dies comes back with the same name, so the same sandbox
id, and P6.3 affinity carries the workload's sessions to it (§10, restart continuity). The pods
are named `<wl>-<n>` (at most 36 characters), which is also their `SANDBOX_ID`.

### 4.3 Why a separate Deployment (summary of ADR-0043)

| Option                                                 | Verdict                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A.** `moca-provisioner`, its own Deployment and Role | **Chosen.** Smallest holder of the new permission; rendering a pod spec from request data happens away from signing keys                                                                                                                |
| **B.** Inside the control plane                        | No new Deployment, and it already has a token. But the control plane holds the signing keys and credential store (MI1 §4.3: "everything"), and is the internet-facing front door. Adding pod-spec rendering there grows the crown jewel |
| **C.** In the supervisor's workers                     | Refused by #476 itself: the workers process model output and run without a token on purpose                                                                                                                                             |
| **D.** agent-sandbox `Sandbox` CRs                     | Not an alternative to the component: something still needs RBAC on the CRs. It is a backend choice, and it adds a CRD and controller to every install. Recorded as a later backend behind the same API, for its warm pools              |
| **E.** Context Service creates sandboxes again         | Removed on purpose in rossoctl/context-service#51 (Sandbox provisioning removed): MOCA owns execution, Context Service owns storage                                                                                                     |
| **F.** Static per-user sandboxes (MI1 §9.1 option B)   | No dynamic workloads; an operator edits a file per user                                                                                                                                                                                 |

## 5. Storage

### 5.1 Where the PVC lives

A pod can mount only a PVC in its own namespace, so a workload's Context must live in
`moca-sandbox`. Context Service already places a Context in the namespace the request names, and
its ClusterRole already covers that namespace. On Kubernetes, `CONTEXT_SERVICE_NAMESPACE` becomes
`moca-sandbox`, for phase 1 workloads too, which read their bundle through the API and do not care
where the PVC is. Context Service's helper pods then run in `moca-sandbox`; they must pass its
`restricted` Pod Security level (to verify in PR 3), and the namespace's default-deny NetworkPolicy
does not affect them, because upload and export stream over `pods/exec`, not the pod network.

### 5.2 Resolution and authorization

At provisioning time the provisioner calls context-service#40's trusted resolve-attachment
operation with its own service credential and the owner as subject. Context Service requires
`attach` on the Context for that subject and returns `{namespace, claimName, backend, accessMode}`;
another user's Context answers the same not-found as anywhere else. The provisioner refuses a
`namespace` other than `moca-sandbox`.

This builds on #543 and #59; it does not compete with them. A workload's own managed Context PVC
is authorized because the workload's owner owns its Context. A bring-your-own claim (#59: the
caller names a slug, Context Service derives `moca-<scope>-<slug>` from the caller's subject and
attaches it) resolves through the same call, so the provisioner never sees a caller-supplied PVC
name. Whoever pre-creates a BYO claim now creates it in `moca-sandbox`.

### 5.3 Mount modes

| `workspace.mount` | Volume                | Mounted at `/workspace/context`                                      |
| ----------------- | --------------------- | -------------------------------------------------------------------- |
| `read-only`       | PVC, `readOnly: true` | `subPath: .context-service/materialized/<revision>`, read-only       |
| `writable`        | PVC, read-write       | `subPath: moca-workspace`, read-write, seeded once from the revision |

The run's working directory is the mount, rooted at its `workspace/` directory under the same rule
`context-overlay.ts` uses today.

**Writable mounts never expose `.context-service/`.** The frozen revision's id is the digest of
exactly what export streams. A writable mount of the revision directory, or of the claim root,
would let model code change a revision behind its id or rewrite revision history. So "writes stop
being copies" holds per run, not per workload: an init container (MOCA's image, not model code)
copies the frozen revision into `moca-workspace/` once, and every later run writes that tree in
place. The main container mounts only `moca-workspace`.

**The seed cannot be steered into `.context-service/`.** Model code can write `moca-workspace/`,
delete things there and plant symlinks such as `a -> ../.context-service/materialized/<rev>/a`.
Three rules keep a later seed from following them:

- **No claim root in the init container.** It mounts the revision read-only through its own
  `subPath: .context-service/materialized/<revision>`, and `moca-workspace` as a separate
  read-write mount. Nothing under `.context-service/` is writable in any container, and a symlink
  in `moca-workspace` resolves inside the container's own mounts, never to the claim root.
- **The seeded flag is not a file.** The provisioner creates the StatefulSet with the pod-template
  annotation `moca.dev/seed-revision=<revision>`, which the init container reads through the
  downward API; without it, the init container does nothing. Once the first pod's init container
  has completed (the provisioner reads pod status), the provisioner removes the annotation. The
  StatefulSet uses `updateStrategy: OnDelete`, so that patch restarts no pod, and pods that restart
  later come back without it. Model code cannot delete its way to a re-seed.
- **Seed into a temp dir, never into existing content.** The init container refuses to seed when
  `moca-workspace` holds anything except a leftover temp dir of its own, which it removes. It copies
  into a fresh `mkdtemp` directory under the mount without following symlinks, then renames the
  entries into place, so a crash mid-seed leaves no half-seeded tree that looks complete.

This puts MOCA's writes outside `.context-service/` on a claim Context Service owns. The #40
companion must state that the claim outside `.context-service/` belongs to the attacher. On a BYO
claim, #59 promises that pre-existing content at the claim's root is never read; mounting only
`moca-workspace/` keeps that promise.

**What writes do not become.** Nothing turns the writable tree back into a revision: #59
deliberately does not build "import the claim's tree as a revision". The tree lives as long as the
workload, is not exported, and is gone at `DELETE`. Snapshot and provenance are open (§10).

### 5.4 ReadWriteOnce vs ReadWriteMany

RWO lets one node attach a volume; pods on that node share it. RWX lets any node. The cases:

- **One sandbox, RWO.** Works everywhere, including Kind's `local-path`.
- **Several sandboxes, RWO.** The provisioner adds required pod affinity on `moca.dev/workload`,
  so all of a workload's pods schedule onto one node. A full node then leaves pods Pending, and
  `GET` reports fewer ready sandboxes.
- **Several sandboxes, RWX.** Spreads across nodes. Allowed only when the workload's StorageClass is
  marked RWX-capable in the operator's allowlist (§6.3), and MOCA then passes `ReadWriteMany`
  instead of today's hard-coded `ReadWriteOnce`.
- **Writable with several sandboxes** shares one tree between them. Concurrent writers are the
  workload's own concern; MOCA adds no locking.
- **Context Service's helper pods.** The upload helper writes the PVC before activation, and
  sandboxes are created only at activation (§6.1), so upload never meets a mounted RWO claim. The
  export helper serves phase 1 bundle delivery, which a mounted workload does not use. A later
  `contextctl` export of a mounted RWO claim from another node would hang Pending until it times
  out; the #40 companion should give helper pods node affinity to the claim's node, or refuse.
- **`ReadWriteOncePod`** is not supported: it would block the helpers outright.

## 6. Lifecycle

### 6.1 Create, activate, delete

The proposal ordered create as record, Context and PVC, sandboxes, ready. The existing lifecycle
puts upload and freeze between the Context and anything that can mount it, so phase 2 provisions
at **activation**:

1. `POST /workloads` reserves the record (`creating`), creates the Context and PVC, returns the
   upload grant (`awaiting_upload`). Unchanged.
2. The client uploads the bundle with the grant. Unchanged.
3. `POST /workloads/{id}/activate` freezes the revision (unchanged), then, for a workload with
   `sandboxes`, moves to the new status `provisioning` and calls `PUT` on the provisioner.
4. The record moves to `ready` once the relay has records for `count` sandboxes of `wl`, read from
   `sh:sandbox:records` on `GET` and on each activate retry.

Freeze cannot be undone, so a failed provisioning leaves the record in `provisioning` with an
`error` field. A repeat `activate` retries `PUT`, which is idempotent by `(wl, gen)`. Runs before
`ready` answer `409 workload_not_ready`, as today.

`DELETE /workloads/{id}` moves to `deleting`, then:

1. Provisioner `DELETE` removes the StatefulSet, Service and Secret, and answers once no pod
   remains. Order matters: Context Service refuses to delete a mounted claim (`409 in_use`).
2. The Context, and with it a managed PVC, is deleted (a BYO claim is left, per #59).
3. The record moves to `deleted`.

Each step tolerates "already gone", so a retried delete finishes what a failed one started.

### 6.2 The reconciler

A loop in the provisioner, every `MOCA_PROVISIONER_RECONCILE_S` (default 300). It lists the
workload StatefulSets, Services and Secrets in `moca-sandbox` and reads each one's record key from
its annotation, reading Redis with the deployment's one credential (there are no ACL users,
§3.1). It deletes the objects when the record is missing, `deleted`, or of another generation, and
the objects are older than a 10-minute grace. The same loop re-mints attach tokens nearing expiry
(§3.1) and removes `moca.dev/seed-revision` once seeding is done (§5.3).
Contexts left by a failed rollback are out of its reach: Context Service owns them.

### 6.3 Caps and ceilings

Enforced by the worker on create (with a named `400`/`429`) and again by the provisioner, which
does not trust the worker's arithmetic:

| Setting                                | Default | Enforced                                                               |
| -------------------------------------- | ------- | ---------------------------------------------------------------------- |
| `MOCA_WORKLOAD_MAX_SANDBOXES`          | 2       | `sandboxes.count` per workload                                         |
| `MOCA_OWNER_MAX_SANDBOXES`             | 4       | an owner's replicas across workloads, counted from `moca.dev/owner`    |
| `MOCA_WORKLOAD_MAX_STORAGE`            | `10Gi`  | `workspace.size`                                                       |
| `MOCA_WORKLOAD_STORAGE_CLASSES`        | unset   | allowlist, each entry marked `rwo` or `rwx`; unset = the default class |
| `MOCA_CONTEXT_MAX_WORKLOADS_PER_OWNER` | 5       | existing                                                               |

**The namespace backstop.** A ResourceQuota in `moca-sandbox` caps pods, `requests.storage` and
PVC count for the whole namespace, and sets `<class>.storageclass.storage.k8s.io/requests.storage:
0` for classes outside the allowlist. The StorageClass allowlist then holds even if a request
bypasses MOCA's check, for example through Context Service's own public API.

## 7. API

`POST /workloads` gains two optional fields. Absent, the workload is a phase 1 workload on the
shared pool, unchanged; `CREATE_FIELDS` and `WORKSPACE_FIELDS` still refuse everything not listed.

```json
{
  "name": "demo",
  "contextType": "workspace",
  "workspace": { "size": "2Gi", "storageClass": "standard", "mount": "writable" },
  "sandboxes": { "count": 1, "tier": "container" }
}
```

- `sandboxes` selects phase 2. `count` is 1 to `MOCA_WORKLOAD_MAX_SANDBOXES`; `tier` defaults to
  `container`, whatever the deployment's default tier, until a host-side provisioner exists.
- `tier` accepts `container` only. The provisioner creates pods in the cluster; P4 (microVM)
  sandboxes run on a KVM host outside it (P6.2), which a Role cannot reach. `microvm` answers
  `400 sandbox_tier_unavailable` until a host-side provisioner exists.
- `workspace.mount` is `read-only` (the default) or `writable`, and only with `sandboxes`;
  otherwise `400 workspace_mount_requires_sandboxes`. A phase 1 workload keeps copy delivery.
- No `workspace.persistent`: every workload already has a PVC (§1.1). What phase 2 adds is whether
  dedicated sandboxes mount it.
- `workspace.claimName` (#543) combines unchanged. The run-level `writable` of #532 still gives a
  `read-only` workload a per-run copy, on its own sandbox; on a `writable` workload it is a no-op.
- `GET /workloads/{id}` adds `sandboxes: {count, tier, ready}` and the new statuses
  `provisioning`. `mocactl workloads create` gains `--sandboxes <n>` and `--mount <mode>`; the
  `moca-delegate-task` skill passes `--sandboxes 1 --mount writable`.

## 8. Implementation, as four PRs

1. **Relay trusted labels and the selection filter.** Attach-token verification (`kid`, `iss`,
   `aud`, required `exp`, and `n`) and label stamping, the ordinal bound (`< n`), closing an attach
   stream at its token's `exp`, the worker reading `SANDBOX_TOKEN_FILE` on every dial, stripping the
   two labels from shared-pool `Hello`s, the additive `workload` field and the relay's Exec check,
   and the selection filter, which matches both workload and owner. Testable with a hand-minted
   token and a static StatefulSet; changes nothing for a deployment with no attach keys.
2. **The provisioner and its RBAC, without a PVC.** `@moca/provisioner`, the Role, NetworkPolicies
   and ResourceQuota in `deploy/k8s/base`, the internal API with `wl` derived from the verified
   owner, token minting and re-minting, and caps, `sandboxes` on
   `POST /workloads`, `provisioning`, and the delete order. Context still arrives by copy, now onto
   the workload's own sandboxes. This PR alone delivers acceptance 2 and 3.
3. **The context-service#40 companion and the mount.** The resolve call, the namespace move,
   `workspace.mount`, the init-container seed, and the RWO/RWX rules. Acceptance 4.
4. **The Alice/Bob Kind demo and the reconciler.** Two users, two workloads, a cross-user read
   attempt that fails, delete leaving nothing behind, and the reconciler with its tests.
   Acceptance 1 and 5.

## 9. Isolation, and what is still not a boundary

**Gained.** A workload's sandboxes are pods of their own: their own `/workspace`, process list,
network namespace and container user, and the owner's PVC is mounted into no one else's pod. Their
workload and owner labels come from a signature, not from the sandbox. This is MI1 §9.1's option A
(a launcher that creates a user's container) realized on Kubernetes, with the Kubernetes API in
place of a podman socket, so the container tier's "one container belongs to one user" claim holds
on this path for phase 2 workloads.

**Not a boundary:**

- **The kernel.** Workload pods are runc containers on shared nodes. A container escape reaches the
  node, other workloads' pods and, with `local-path`, every PVC on that node's disk.
- **The brain.** Workers still multiplex users and choose the sandbox (§3.3). Until MI1 S2 grants,
  a compromised worker can route any run anywhere and read Redis.
- **A workload's own token, inside the workload.** Model code can read its workload's attach token
  (§3.1). With it, from any host that reaches the relay's attach endpoint, it can register an
  ordinal below `n` whose real pod is down (a restart) and receive that workload's later runs. The
  capture lasts until the token's `exp`, at most one TTL, because the relay closes the stream then
  and nothing re-mints the token for it. It never reaches another workload or another user.
- **The reconciler's inputs.** It trusts workload records in Redis, which workers can write. A
  compromised worker can delete or forge a record so that the reconciler deletes another
  workload's objects. That is denial of service only: the reconciler creates nothing and mints
  nothing.
- **Context Service's trust in MOCA.** It takes the subject from `X-Context-Subject` and from the
  provisioner's resolve call. A compromised provisioner can attach any Context to any pod in
  `moca-sandbox`.
- **Egress.** Workload sandboxes keep the shared pool's public internet egress (MI1 R8 until S5),
  so model code can still send out what it can read: its own owner's data.
- **Operators and namespace admins.** Anyone who can exec into `moca-sandbox` pods or mount its
  PVCs reads every tenant's workspace.

**MI1 amendments, written when this is accepted** (a dated note at the head of each section, per
MI1 §14): §2.3, the workload and owner labels are trusted, while tier and capability labels from
`Hello` still are not; §9.1, option A exists on Kubernetes as the provisioner; §13, "a multi-user
mode on the Kubernetes path... keeps `single`" rests on a deprecation that ADR-0037 reversed for
P6 on Kubernetes, and phase 2 workloads are its first multi-user surface there.

## 10. Open questions

Evaline's four, from #476:

1. **Egress accounting for writable workloads (ADR-0006).** In this design the writable tree is not
   client-readable: no API exports it. The new channel opens only when a snapshot or export of the
   tree lands. Proposal: count it then, as its own audit category, not as credentialed egress.
2. **Provenance granularity.** Per write is impractical on a filesystem. Candidates: a
   content-addressed snapshot per `/v1/runs` boundary, or scheduled ones through Context Service's
   VolumeSnapshots. Depends on whether "import tree as revision" (#59 §3) gets built.
3. **Operator read access.** Only out-of-band (`kubectl exec`, or a debug pod on the claim) in this
   design. Is an audited in-band path needed for incident response?
4. **Writable continuity across a sandbox restart.** The StatefulSet brings the pod back with the
   same id and the same tree; P6.3 affinity waits for it. An in-flight Exec fails with "worker
   disconnected" and its partial writes stay. Is "the tool call fails, the model sees it, the tree
   is as the process left it" enough, or does a run need a checkpoint?

Ours:

5. **Cold start vs warm pool.** Provisioning at activation hides pod start from the first run.
   agent-sandbox warm pools (option D) would cut it to near zero later. Worth it?
6. **Idle scale-down.** Scaling a workload to zero replicas after idle saves nodes but brings cold
   start back to its next run. Default off?
7. **Session multiplexing.** Several runs of one workload share its sandboxes up to the lease cap.
   They share one owner, so this crosses no boundary, but on a `writable` workload they share one
   tree. Serialize writable runs per workload, or leave it to the caller?
8. **The MI1 §13 amendment.** Amend in place (§9) or supersede the bullet with a new MI1 revision?
9. **Existing Contexts after the namespace move (§5.1).** Workloads created before it keep their
   PVC in the old namespace and cannot be mounted. Is re-creating them acceptable?

## 11. Future simplifications

Not planned for phase 2. These are ideas to explore once phase 2 works end to end, not decisions:
each needs deeper work to confirm it is simpler without losing something we need.

1. **The provisioner registers sandboxes with the relay.** It creates the pods, so it can tell the
   relay which workload each belongs to. Sandboxes no longer prove it, and most of the attach token
   (§3.1) goes away.
2. **Fewer sandbox-count rules.** Today the user picks how many sandboxes a workload gets. One per
   workload would drop the count and ordinal rules, but fan-out needs more than one. The other
   direction is letting a workload scale its sandboxes with demand. Needs validation either way.
3. **MOCA owns the workload's PVC.** Context Service only fills it with the revision. No
   resolve-attachment call (§5.2) and no cross-service delete order (§6.1).
4. **Context Service as a format and library.** MOCA imports pack, validate and materialize instead
   of calling a separate service on the request path. `contextctl` stays a standalone tool.

## 12. Testing

- Relay: an attach token sets the three labels whatever `Hello` sends; a shared-token `Hello`
  loses its `moca.dev/workload`; a bad signature, unknown `kid`, wrong `aud` or `iss`, missing or
  past `exp`, wrong id prefix, or an ordinal `>= n` is refused; a stream is closed at `exp`; both
  Exec mismatches fail.
- Selection: workload and shared runs never cross; a record with the right workload but another
  owner is never selected; no live sandbox gives
  `workload_sandbox_unavailable`, never a fallback.
- Provisioner: caps on both sides, idempotent `PUT`, delete waits for pods, the owner comes from the
  verified user token and `wl` is derived from it (Alice's token cannot touch Bob's `wl`), tokens
  are re-minted before expiry, and a Kind check that its ServiceAccount cannot touch `moca`.
- Storage: a read-only mount refuses writes, a writable mount never shows `.context-service/`, and
  resolving another user's Context fails closed.
- Re-seed: model code deletes the tree's contents and plants symlinks into
  `../.context-service/materialized/<rev>/`; after a pod restart the revision directory's digest is
  unchanged, no seed ran (the annotation is gone), and a seed into a non-empty `moca-workspace`
  is refused. The Kind demo (PR 4) is the acceptance gate.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
