# API changelog

Two documents, two versions: the control plane's [openapi.yaml](openapi.yaml) (below) and the data
plane's [harness-openapi.yaml](harness-openapi.yaml) ([its section](#data-plane-harness-openapiyaml)).

## Control plane (openapi.yaml)

The version is `info.version` in [openapi.yaml](openapi.yaml): the minor is bumped for additive
changes, the major only with a `/v2` ([change policy](../reference/change-policy.md), decision 5).

### 1.14.0

Review fixes from the upstream template and enrollment PRs, brought into this document. No route is
added or removed.

- `DELETE /v1/subjects/{subject}` refuses a subject holding a live admin grant with the new error
  code `admin_granted` (409; revoke the role first): the grant keeps it enrolled, so the unenroll
  would change nothing.
- A `Subject` carries `storeEnrolled` (the store's own enrollment, apart from the settings and any
  role); enrolling a subject the settings enroll writes nothing (`record: null`).
- A grant's `until` is at most 366 days ahead (`400 invalid_request` beyond), so a value in epoch
  milliseconds is refused rather than read as a grant that never lapses.
- The template quotas count what holds a slot: `templates` counts a template only while one of its
  builds is registered or on its way there (one whose builds all failed, were cancelled or retired
  holds none, and a new build of it is checked against the quota like a new id), `buildsQueued`
  counts probing builds too, and a build an admin adds to another
  subject's template is charged to the template's owner. A create's quota check and write hold one
  lock per subject, so concurrent creates for different ids never pass one check together.
- A template spec names its guest size once: `guest_ram_mb`, or its alias `guest_mb` alone. A spec
  with both is refused `422 policy_refused` (`M7.guest`), even when equal; the alias is stored as
  `guest_ram_mb`, the key the build reads, in the `create` record, the build's request and the reuse
  key.
- Under every profile, a create whose spec names a gate record (`source_record_digest`), or that
  sends one, is refused unless that record passed (`X1`) and is for this image (`X1.image`); only
  `X1.trusted` stays a profile requirement. `X12` refuses any `skip_git_identity_check: true` that
  no gate record showing commits refused backs. Upgrade note: on `base` an unbacked skip is now
  refused: a client sends a gate record showing commits refused (X5: `agent_can_commit: "no"`,
  `git_identity: "none"`), or drops the skip, and the build host's git identity check then needs git
  with an identity in the image.
- M1 takes the distribution reference grammar: an optional `host[:port]/`, then lowercase path
  components, then `@sha256:<64 hex>`, at most 255 characters before the `@`. A tag beside the
  digest is refused, and so are references such as `Images/x`, `-x`, `a//b` or `../x`. Registry
  hosts compare case-insensitively (`allowedRegistries` and the image's host).
- `PUT /v1/policy` refuses a profile `requires` id outside X1, X10, X11, X12, X14, X15 (the ids
  the check acts on) and an `envelope.exact` that is not two positive whole numbers. A stored policy
  naming an unknown id, or with such an `exact`, fails closed when read, until an admin sets a
  valid one: read `GET /v1/policy` and fix it before upgrading.
- A tag is looked up as the template's own property everywhere (moving, removing, `id:tag`, the tag
  list), so a tag named like an `Object.prototype` member (`constructor`) is a tag like any other;
  `DELETE …/tags/{tag}` refuses a name outside the tag grammar with `400 invalid_request`.
- Every template change (a tag moved or removed, an edit, an owner transfer, a cancelled build) is
  stored only once its records are on the chain, and its owner's check is made again under the
  template's lock: a record that fails to append refuses the change, and an owner transfer landing
  in between refuses the old owner's change. A create retries under the new owner's quota lock when
  a transfer lands between its read and its write. `PATCH /v1/templates/{id}` refuses a description
  holding a lone surrogate with `400 invalid_request`.
- An activation's default lease is the largest `idleLimitSeconds` of the hosts that hold the build
  (not of every host), or 3600 when none reports one, clamped to 60-86400: a host's idle limit
  outside the range never refuses a request that named no lease. Only an explicit `leaseSeconds` is
  range-checked, and one that is not a whole number is refused rather than replaced by the
  default.
- A refused create is recorded as a `check` provenance record only on an existing template's stream
  the caller may write (its own, or an admin's adding a build); a refusal on another subject's id is
  only answered, and one on an id no template holds writes one audit line instead
  (`template_create_refused`, with the subject, `templateId` and the failed `rules`).
- A build made on a `selfAttest` profile with a gate record now stores `selfAttestProfile`, trusted
  or not at create, and its `attestation` is `self` whenever its record is not trusted now: a trust
  removal narrows such a build (its template private to its owner) whatever the order of events.
- `X1.self.scope` counts only builds self-attested at create (the record untrusted then), keyed on
  the template's owner; a claim is held unless its build failed, and two creates sending one
  untrusted record at once are serialized, so never both claim it. The `gate` record's `scope` is
  the template's owner (the submitter, except on an admin's build for another subject's template).
- From a registry the policy lists repositories for (`allowedRepositories`), an image path outside
  the entries' grammar (uppercase, or an empty, `.` or `..` segment) is refused (`registry.repository`,
  saying the path is malformed) before it is matched, so the policy and the build host's puller read
  one path the same way.
- A template imported from `SH_SANDBOX_TEMPLATES` (its build `imported:<12 hex>`, which no host's
  inventory can hold) is never gated by activation: a sandbox create on it serves whenever its
  worker is attached, its readiness is its worker's presence alone, it is never placed, run or
  stopped by the wanted state, and activate refuses it with `400 invalid_request` (the deployment
  runs its worker; it takes no lease). Before, once a host was configured, such a template was
  refused `template_not_active` for good.
- Placement, the hosts block of `GET /v1/templates` and the default lease leave out any host
  whose last inventory is older than 360 s (`HOST_STALE_S`, three build polls), until it reports
  again: a host whose agent died or was removed takes no new placement and no slot. When every
  host is silent, readiness is the workers' presence alone.
- Placement counts the workers a host runs: each `holds` entry of an inventory may carry `running`
  (its worker unit runs), kept current between inventories by the host's `attached`, `detached`
  and `refused` reports. Placement is sticky (a wanted build already running on a holder stays
  there), and a host's count starts with the workers that stay running on it: the wanted builds it
  runs and the unleased ones still draining a live sandbox. `active.used` in the hosts block shows
  that count. A leased build that runs on a host while placement keeps it on another is in that
  host's `stop` (never under a live sandbox), so one worker id does not stay on two hosts. With
  memory figures, a worker started since the inventory (an attached report) is counted as pending,
  since the host's MemAvailable cannot show it yet.
- `409 no_active_slot`'s `Retry-After` is the seconds until the soonest a build placed on one of
  this build's holders loses its last live lease (when its slot frees), not the earliest end of any
  lease in the catalog; 60 when no lease gives that time.
- Activation on first use takes the lease only when the caller holds no live lease on the build: a
  retry under its own lease is answered `409 template_not_active` with the readiness and
  `Retry-After`, and writes nothing (no renewal, no new `activate` record per retry). Another
  subject's first use still takes its own lease.
- A host's `refused` worker report that repeats its last one for the build (the same reason) while
  the build stays in the host's `run` is not recorded again (`recorded: null`): the agent retries
  every 15 s, and the template's stream is append-only. A different reason, any other report for
  the build, or the build leaving the host's `run` starts a new episode, recorded again.
- A retire and an admin's reject run their in-use check, their records and their catalog write
  under the activation lock and the template's use lock, on the template as read under those
  locks; an activation re-reads its build's status under the activation lock (a build retired since
  is `410 template_retired`, one rejected `409 template_unavailable`), and a sandbox create stores
  its sandbox under the template's use lock after one last status read (`410 template_retired`, or
  `400 unknown_template` for a build no longer registered). So no lease, sandbox or `activate`
  record lands on a build that a racing retire or reject ends, and no build is retired or rejected
  under a sandbox. Creates on different templates do not wait on each other.
- `build_in_use` is judged by build: a live sandbox counts for the build it resolved to, so a
  sandbox on one build does not block retiring another build that shares its worker (a record
  without a build id still counts for every build on its worker). Each `retire` or `reject` record
  is written inside the catalog update, so a record that cannot be written leaves the build as it
  was; its `buildRecord` is the build's `build` record matched by handle, so a build built and then
  rejected cites it too.

### 1.13.0

The member, owner and quota routes take an OIDC subject as well as a GitHub one (#701's `oidc:<sub>`,
adapted on our side before filing, joint list D2): `PUT`/`DELETE /v1/subjects/{subject}` and its role
routes, `PUT /v1/templates/{id}/owner`'s `owner`, `PUT /v1/quota/{subject}` and the policy's
`quotaBySubject` keys accept `github:<numeric id>` or `oidc:<provider sub>` (the same sub pattern login
verifies). `test:<n>` is still refused there. The `Subject` schema's and the five path and body patterns
widen to match; no field or route is added or removed, and a GitHub deployment sees no change.

### 1.12.0

Merged from upstream (rossoctl/moca), which released these as its own 1.3.0: this document's 1.3.0
was already the template routes, so they arrive here as 1.12.0: a client sees `info.version` go
from 1.11.0 to 1.12.0. Nothing else changes.

Async turns: the owner-scoped submission API
([#387](https://github.com/rossoctl/moca/issues/387)) and the dequeue-time credential exchange
([#388](https://github.com/rossoctl/moca/issues/388)), per the
[async fan-out spec](../specs/2026-11-05-p6-async-fan-out-design.md) and
[ADR-0047](../adrs/0047-p6-async-fan-out-in-worker-drain.md). The M1 slice: a working drain under
`MOCA_TENANCY=single`.

- New POST /v1/sessions/{id}/turns (202 with the turn id), GET /v1/sessions/{id}/turns/{turnId} and
  DELETE /v1/sessions/{id}/turns/{turnId} (queued turns only). Owner-scoped: another user's session
  answers 404. `idempotencyKey` defaults to the session id, so a resubmission is deduplicated rather
  than queued behind. Documented in 1.2.0's document by oversight; recorded here.
- New `TurnStatus` schema and `turnId` path parameter. The nine turn states are pinned against the
  server's own list by a contract test.
- New POST /internal/turn-credentials, behind the existing `exchangeToken` scheme: a worker presents
  the turn id it read off the queue and gets back the credential resolved from the turn record. No
  credential and no bearer token ever travels in the work queue (MI1 §6.5). A pure read — it does not
  move the turn to `running`. The `turnId` must be the `t-<uuid>` shape the control plane mints;
  anything else is 400 `invalid_request`, refused before Redis is read.
- New error codes `turn_not_cancellable` (409, cancelling a turn that is not queued),
  `turn_not_claimable` (409, claiming a cancelled or terminal turn), `turn_not_found` (404),
  `async_quota_exhausted` (429, `MOCA_ASYNC_QUEUED_PER_OWNER` non-terminal turns already held),
  `async_tenancy_unsupported` (501, async under `MOCA_TENANCY=multi`) and
  `workload_runs_unavailable` (501, a submission naming a `workloadId`). Either 501 is answered
  before the quota is touched, so a request that can never be served is never reported as a 429 and
  leaves no record, no queue entry and no quota slot behind (§4.2).
- `async: true` on the harness's own turn route stays removed and still answers 400 `async_removed`;
  these routes are its replacement.

Interim, and named as such: /internal/turn-credentials returns a resolved credential rather than the
MI1 S2 grants, there is no `turn_exp`, and `MOCA_TENANCY=multi` refuses async at both the submission
and the claim. M2 mints grants for both audiences with a `turn_exp` and lifts that gate.

### 1.11.0

A create's spec that names an `id` or `image` other than the create's own is refused (gating rule M7,
the follow-up to G46): `POST /v1/templates` (and a new build) answers `422 policy_refused` with `rule:
M7.spec_id` or `M7.spec_image`, recorded as a `check` like any rule. The build job takes both from the
create's own fields (G46's fix), so a different copy in the spec was silently ignored; now it is refused.
A spec that carries the same values, such as a gate record's template block sent unchanged, passes as
before. No field or route is added or removed.

### 1.10.0

The idle grace of template workers ([cold-start pacing spec](../specs/2026-11-09-cold-start-pacing-design.md)
§4, register G43): on a KVM host with `SBX_IDLE_GRACE_S` set (default 0, off), a released build's
worker is kept running for that long after its last lease ends, so a use soon after is warm. Off,
nothing changes.

- `POST /v1/hosts/{host}/inventory`'s `limits` take an optional `idleGraceSeconds` (0-86400). Absent
  (an older agent), malformed or 0: no grace; an older control plane ignores it.
- The grace runs from the build's last lease end (a release's time, or an expired lease's `until`),
  for a worker the agent reports running (`runningWorkers`) with no live sandbox, while the host has
  room under `activeLimit` and its memory headroom (a graced worker counts as running there). A
  wanted build that needs the slot or the memory displaces the graced worker that ends soonest; the
  stop is re-checked for a lease when the wanted answer is made.
- `GET /v1/hosts/{host}/wanted` gains `graced: [buildId]` for a host with a grace: the graced builds,
  kept in `run` after the wanted ones (the agent starts none of them). A retired or rejected build is
  then also listed in `stop` beside `remove`, so its removal is not held for a grace.
- `POST /v1/templates/{id}/deactivate` takes an optional `stopNow: true`: with no lease left, the
  build skips the grace (stopped at the next poll); the `deactivate` record carries `stopNow: true`.
- Builds gain `graced: true` and `gracedUntil` (epoch seconds) while in a grace. `GET /v1/templates`'
  hosts gain `idleGraceSeconds` and `graced` (a count) for a host whose agent sets a grace.
- `POST /v1/hosts/{host}/workers/report` takes `detached` for a retired or rejected build too.

### 1.9.0

Pacing template workers' cold starts ([cold-start pacing spec](../specs/2026-11-09-cold-start-pacing-design.md),
register G43): a KVM host starts at most `SBX_START_CONCURRENCY` (default 4) workers at once, and an
activation waiting for a start slot says so. The start limit is the host agent's, so it holds with an
older control plane too. Nothing running is stopped.

- `GET /v1/hosts/{host}/wanted` gains `starting: [buildId]`: the builds of `run` whose worker is not
  attached to the relay (its presence, as readiness reads it), in `run`'s order. `run` is now in the
  wanted order, first leased first. Without `starting` (an older control plane, or the presence
  unreadable) the agent counts its own starts of the last `SBX_START_WINDOW_S` (default 300).
- `POST /v1/hosts/{host}/inventory`'s `limits` take optional `startConcurrency` and `startSeconds`
  (the mean of the agent's last cold starts, start to attach). Without them (an older agent) nothing
  changes; an older control plane ignores them.
- A build `activating` on such a host gains `queued` and `queuePosition` (1-based, among its host's
  placed, wanted builds not attached yet, first leased first); `queued` is true beyond the host's
  `startConcurrency`.
- `409 template_not_active`'s Retry-After is `ceil(ceil(queuePosition / startConcurrency) ×
startSeconds)` when the host reports both; else 30 s, as before. A queued activation stays
  `activating` longer than before: a client polls with a timeout sized for the host's whole start line.
- `GET /v1/templates`' hosts gain `start: {concurrency, seconds, starting, queued}`, only for a host
  whose agent reports it.
- Placement prefers a holder whose agent reports the build's worker running (`runningWorkers`),
  whether or not it reports memory figures (in 1.8.0, only one that did).

### 1.8.0

Memory-aware placement of template workers ([memory-aware placement spec](../specs/2026-11-09-memory-aware-placement-design.md),
register G39): a new worker starts on a host only if the host has the memory for it, whatever its
`activeLimit` says. Nothing running is evicted.

- `POST /v1/hosts/{host}/inventory` takes an optional `memory: {memTotalMib, memAvailableMib,
memFloorMib, memPressureFull10, memPressureLimit, runningWorkers, vmCommittedMib, memfileMismatch}`.
  Without it (an older agent) the host is placed by `activeLimit` alone, as before; an older control
  plane ignores it.
- A build costs its guest RAM (`spec.guest_mb`) plus 128 MiB, or 4096 + 128 with no recorded guest size.
  A host's headroom is `min(total − floor − used, available − floor − pending starts)`, where `used`
  counts its running workers, their VMs' committed memory and the builds placed there not started yet.
  A host whose last inventory is older than 60 s, or whose PSI `full avg10` is above its limit, takes
  no new start. A build in a host's `memfileMismatch` is never placed there.
- `409 no_active_slot` gains `reason: memory` when a holder under its active limit lacks the memory
  (Retry-After unchanged); at the active limit it answers as before, with no `reason`.
  `409 template_unavailable` gains `reason: memfile_mismatch` when every holder reports the build's
  memory file wrong. `409 template_not_active` with readiness `unavailable` carries the reason too.
- Templates and builds gain `readinessReason` (`not_held | no_slot | memory | memfile_mismatch`),
  present only with readiness `unavailable`.
- `GET /v1/templates`' hosts gain `memory: {totalMib, availableMib, floorMib, usedMib, headroomMib,
pressureFull10, pressureLimit, brake, runningWorkers, memfileMismatch, reportedAt}`, only for a
  host whose agent reports it; `floorMib` is the effective floor.

### 1.7.0

Per-sandbox egress records (register G42): what a sandbox reached through the KVM host's egress
proxy, readable through the API and named in the sandbox's provenance.

- `GET /v1/sandboxes/{id}/egress?after=&limit=` (the owner or an admin, as `GET /v1/sandboxes/{id}`)
  gives `{events, next, summary}`. The events are the proxy's audit events exactly as it wrote them
  (`EgressEvent`), in arrival order. `summary` is `{byHost: {host: {count, decisions, bytesUp,
bytesDown}}, total, dropped, droppedBy: {proxy, cap, budget, invalid}, complete, sealed, sha256}`.
- `?format=ndjson` gives the whole log as `application/x-ndjson`: each event's canonical JSON, each
  followed by `\n`. Its sha256 is `summary.sha256`.
- `POST /v1/hosts/{host}/egress` (`hostToken`): the host agent's batches of up to 1000 events and its
  journal cursor, idempotent by (host, cursor).
- `GET /v1/hosts/{host}/wanted` gains `egressSids`, the workspace keys whose events the host ships (the
  set the egress route accepts); the agent sends no other sandbox's or session's events.
- The `sandbox` provenance record that ends a sandbox (`state: terminated`) gains
  `egress: {events, sha256, dropped, droppedBy, complete}`. Events that arrive in the 600 s after the end are
  still taken; if any did, one more `sandbox` record with `state: egress` names the final log. No
  record kind is added.

### 1.6.0

A per-registry repository allowlist in the template policy, so a registry can be opened to named
repositories only (the onboarding guide's general-user samples on Docker Hub).

- The policy gains an optional `allowedRepositories: {registry: [repository, …]}`. Each entry is an exact
  repository path or a `prefix/*`, matched on whole path segments. A registry with no entry allows every
  repository, as before.
- A create from a listed registry but an unlisted repository is refused `422 policy_refused`, rule
  `registry.repository`.
- `index.docker.io` reads as `docker.io`. A reference with no host stays `<default>`, the build host's
  own registry, never Docker Hub.

### 1.5.0

Per-subject trust for gate records ([subject trust spec](../specs/2026-11-08-subject-trust-gate-records-design.md),
register G41 (c)).

- Policy profiles may carry `selfAttest` and `selfAttestEgress`. The default policy gains
  `benchmark-self` (the benchmark rules, offline) and `general-self` (no X11; the KVM host's
  allowlisted egress allowed).
- On a `selfAttest` profile, a gate record the policy does not trust is accepted for the creating
  subject's own template. New policy rules: `X1.self.scope` (another subject's record),
  `X12.self` (commits always refused), `X1.self.egress` (egress where the profile forbids it).
- `attestation` (`deployment | self`) on templates and builds, recomputed from the current policy.
- `X1.offline`: on a profile that requires X1, a general-gate record (`image-factory/gate/1`) needs
  `gate.floor_checked_offline: true` (fail closed); a curated family record predates the field and
  passes. A profile with `requireOfflineGate: false` (`general-self`) accepts either. Builds show
  `gateFloorCheckedOffline`, and `gateFloorMetOffline` for a gate from a `network_needed` contract.
- New error code `self_attested` (409): deployment visibility for a template with a self-attested
  build, at create or by PATCH.
- PUT /v1/policy answers `narrowed`, the builds a trust removal makes private; the `policy` record
  names them too. A template's `visibility` is the one in effect.
- The `gate` provenance record's body: `source` `trusted | self | client`, `scope` for `self`, and
  `policy` (the policy record at create).

### 1.4.0

Enrollment and roles through the API ([enrollment and roles spec](../specs/2026-11-08-enrollment-and-roles-api-design.md),
register G38). On both route profiles, when the deployment keeps a template store (`SH_PROVENANCE_DIR`). The list: any admin; every change: an admin named in `SH_ADMIN_SUBJECTS` (others `403 forbidden`).

- New GET /v1/subjects: every enrolled subject with its roles, each with `source: env | api`, and
  an admin grant's `until`.
- New PUT and DELETE /v1/subjects/{subject} (enroll, unenroll), and PUT and DELETE
  /v1/subjects/{subject}/roles/admin (grant, with an optional `until` in epoch seconds; revoke).
- The settings stay the bootstrap: `SH_ALLOWED_SUBJECTS` and `SH_ADMIN_SUBJECTS` can't be changed
  here (`409 bootstrap_subject`), and an admin can't revoke its own role (`409 self_revoke`).
- **Behaviour change:** with a template store, roles and enrollment are evaluated per request. A
  token's `roles` claim reports what held when it was minted; a grant, revoke or lapsed `until`
  takes effect at the subject's next request.
- New provenance stream `members`, with record kinds `member` and `role`. An older
  `verify-provenance.py` refuses a store holding them.
- New `Subject` schema; new error codes `bootstrap_subject` (409) and `self_revoke` (409).

### 1.3.0

Templates as a store with a lifecycle, self-serve and gated by policy, built and run by host agents,
with provenance ([template lifecycle spec](../specs/2026-11-03-template-lifecycle-and-provenance-design.md);
[combined control plane spec](../specs/2026-11-05-combined-control-plane-design.md)). Every route below
is served on both route profiles, `sandbox` and `harness` (so also `combined`), and only when the
deployment keeps a template store (`SH_PROVENANCE_DIR`).

- **The catalog:** GET /v1/templates now lists the store's templates (owned, visible, or the
  deployment's), with `readiness` per build (`inactive`, `activating`, `active`, `deactivating`,
  `retired`). New GET /v1/templates/{id}, GET /v1/templates/{id}/builds, GET
  /v1/templates/{id}/builds/{build} (`heldBy`: the hosts holding it; its spec, seed included) and
  GET /v1/templates/{id}/tags. A template is referenced as `id`, `id:tag` or `id@sha256:…`.
- **Self-serve creates:** new POST /v1/templates (create, from an image and a spec) and POST
  /v1/templates/{id}/builds (a new build), each checked against the policy at create; POST
  /v1/templates/{id}/builds/{build}/cancel.
- **The policy and quotas:** new GET and PUT /v1/policy (admin): allowed registries, profiles,
  trusted gate records, quotas. New GET /v1/quota (with `quotaSource`) and PUT
  /v1/quota/{subject|default} (admin).
- **Activation by lease:** new POST /v1/templates/{id}/activate and /deactivate. A sandbox or a
  session on a template that is not active is refused `409 template_not_active` with Retry-After,
  and its lease is taken (first use) unless `activate: false`.
- **The lifecycle:**
  - new POST /v1/templates/{id}/tags and DELETE /v1/templates/{id}/tags/{tag};
  - PATCH /v1/templates/{id} (description, visibility);
  - PUT /v1/templates/{id}/owner (admin; a template the deployment declares can be handed to a
    subject);
  - POST /v1/templates/{id}/builds/{build}/reject (admin);
  - POST /v1/templates/{id}/retire and DELETE /v1/templates/{id}/builds/{build} (retire).
- **The host agents:**
  - new POST /v1/hosts/{host}/inventory, /builds/claim, /builds/{build}/log, /builds/{build}/report
    and /workers/report;
  - GET /v1/hosts/{host}/wanted (start, stop, remove) and /blobs/{digest};
  - all behind the new `hostToken` scheme (`SH_TEMPLATE_HOSTS`).
- **Sessions:** POST /v1/sessions takes `sandbox.template`, resolved like a sandbox's (`id`, `id:tag`,
  `id@sha256:…`), and records `sandboxBuildId`. GET /v1/sessions/{id} shows `sandboxTemplate`,
  `sandboxBuildId` and `templateManifestHash`.
- **New error codes:**
  - 404 `template_not_found`;
  - 409 `template_exists`, `template_not_active`, `template_unavailable`, `no_active_slot` and
    `build_in_use` (a retire under a live sandbox or an active pinned session);
  - 410 `template_retired`;
  - 422 `policy_refused` (the failing rule named).
- **Provenance records** on each template's chain: `create`, `gate`, `build`, `check`, `policy`,
  `activate`, `deactivate`, `retire`, `reject`, `owner`, `sandbox` and `session`, each cross-record
  reference a record digest. An older `verify-provenance.py` refuses a store holding the newer kinds.

### 1.2.0

The sandbox service's routes ([SBX0 spec](../specs/2026-10-15-sbx0-internal-sandbox-service-design.md) §5.1),
served only by a control plane on the `sandbox` route profile (`SH_ROUTE_PROFILE=sandbox`); a moca
control plane answers 404 for all of them.

- New GET /v1/templates; POST and GET /v1/sandboxes; GET and DELETE /v1/sandboxes/{id}; and
  POST /v1/sandboxes/{id}/token, which mints a sandbox token for Exec (owner only, admins included).
- New GET /v1/janitor/sandboxes for the host janitor, behind the new `janitorToken` security scheme
  (`SH_JANITOR_TOKEN`).
- New `Sandbox` schema and `sandboxId` path parameter (`sbx-` plus 26 lowercase hex characters).
- New error codes `not_enrolled` (403), `sandbox_not_found` (404), `sandbox_terminated` (409, with
  `reason`), `name_conflict` (409), `quota_exceeded` (429) and `unknown_template` (400).
- Every sandbox route, the janitor's included, keeps its records in Redis and can answer
  `503 redis_unavailable`; POST /v1/sandboxes can answer `400 invalid_json`.
- GET /v1/discovery names the route `profile`, and on `sandbox` answers `execEndpoint` and `execCa`.
- POST /v1/auth/device/token and POST /v1/auth/token can answer `403 not_enrolled` on the `sandbox`
  profile (a subject not in, or since removed from, `SH_ALLOWED_SUBJECTS`); a refused refresh also
  revokes that login.

### 1.1.0

Per-session model selection ([spec](../specs/2026-10-14-per-session-model-selection-design.md)).

- New error codes `model_unavailable` (400) and `model_catalog_unavailable` (503).
- /internal/credentials returns the session's `model` when it names one.
- POST /v1/sessions accepts `model`; the session view shows it; new PATCH /v1/sessions/{id} switches it.
- New GET /v1/models and GET /v1/sessions/{id}/models.

## Data plane (harness-openapi.yaml)

### 1.1.0

A session on a sandbox template ([session templates spec](../specs/2026-10-30-session-sandbox-templates-design.md) §5, §5.1).

- `TurnResult.sandbox` gains `template` (the session's template) and `seed` (`{source: build |
declared, buildId?}`: where the workspace's seed came from; `buildId` is the pinned build when the
  source is `build`).
- `TurnResult.workspace`, on a templated session's turn: the workspace's end state as a diff from
  the seed's baseline commit (`baseline`, `patch` or `patchBase64`, `patchSha256`, `patchBytes`),
  never truncated: over `SH_TURN_PATCH_MAX_BYTES` (default 4 MiB) the patch is left out and
  `patchRefused: too_large` set; `error` alone when the capture failed (the turn still succeeds).
- The terminal `done` and `error` frames carry `sandbox` and `workspace` too.

### 1.0.0

The first versioned data-plane document.
