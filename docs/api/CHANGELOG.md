# API changelog

Two documents, two versions: the control plane's [openapi.yaml](openapi.yaml) (below) and the data
plane's [harness-openapi.yaml](harness-openapi.yaml) ([its section](#data-plane-harness-openapiyaml)).

## Control plane (openapi.yaml)

The version is `info.version` in [openapi.yaml](openapi.yaml): the minor is bumped for additive
changes, the major only with a `/v2` ([change policy](../reference/change-policy.md), decision 5).

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
