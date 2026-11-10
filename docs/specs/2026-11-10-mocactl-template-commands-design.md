# mocactl for templates and users: the client's whole path

- **Status:** design draft, for the user's decisions (§7). Not implemented.
- **Date:** 2026-11-10
- **Asked for by:** the user, 2026-11-09: "after we are done with Moca API enrichment/enhancement, we
  also need to enrich/enhance Moca's mocactl for template and user management/consumption."
- **Builds on:** [template lifecycle](2026-11-03-template-lifecycle-and-provenance-design.md) §5-§6,
  [cold-start pacing](2026-11-09-cold-start-pacing-design.md) (G43),
  [memory-aware placement](2026-11-09-memory-aware-placement-design.md) (G39),
  [sandbox egress records](2026-11-08-sandbox-egress-records-design.md) (G42),
  [subject trust for gate records](2026-11-08-subject-trust-gate-records-design.md) (G41 (c)), and the
  enrollment and roles design (G38). API: [openapi.yaml](../api/openapi.yaml) 1.10.0.
- **Inputs:** a benchmark runner's record of every call it makes through the API today (create →
  follow → activate → sandbox → seed and checks → egress → release → retire, and the admin calls it
  needed), and the gaps it hit (G37, G46, G47, frame times).

## 1. What exists

`mocactl sbx` (`packages/mocactl/src/sbx/cli.ts`, `api.ts`, `commands.ts`) already has:

| Area          | Commands                                                                                                                            | Notes                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Templates     | `templates` (list), `templates retire ID [--build B] [--reason T]`, `tag`, `untag`, `edit`, `transfer`, `quota TARGET … \| --clear` | all with `--json`; retire has no `--wait`                                                                                      |
| Users (admin) | `admin subjects`, `enroll`, `unenroll`, `grant [--until]`, `revoke`                                                                 | G38; refusals printed, never retried                                                                                           |
| Sandboxes     | `create [--template T]`, `ls`, `rm`, `token`, `egress [--ndjson]`, `run`, `put`, `up`, `doctor`, …                                  | `create` waits out `409 template_not_active` (Retry-After, up to 10 min); `--template id@build` is passed through but untested |
| Sessions      | `mocactl run --option sandboxTemplate=id@build`                                                                                     | accepted and tested (G37 closed)                                                                                               |

Errors: `ApiError` keeps `error`, `message`, `reason` and Retry-After; **the body's `rule`, `quota`,
`readiness` and `readinessReason` are dropped**, so a `422 policy_refused` or a `429 quota_exceeded`
prints one generic line.

Auth: the sbx login is `~/.config/mocactl/sbx-auth.json` (0600, its directory 0700); tokens travel only
in the `authorization` header; `sbx token` and `mocactl auth token` print a token on purpose.

## 2. What a client cannot do with mocactl today

Everything before a template is usable:

1. **Know what it may do:** no `quota` read, no `policy` read, no hosts view (the hosts block of
   `GET /v1/templates`).
2. **Create a template** (`POST /v1/templates` with id, image, spec, profile, visibility, gate
   record) or a new build of one; **follow** a build to `registered`, `failed` or `rejected`, with its
   `reason {step, rule, code}`; **cancel** one.
3. **Activate and release** (`POST …/activate {build, leaseSeconds}`, `POST …/deactivate {build,
stopNow}`), and see why an activation waits (`readiness`, `readinessReason: no_slot | memory`,
   `queued`, `queuePosition`, `graced`).
4. **Retire and see it gone** (`410 template_retired` on use; `heldBy` empty).
5. **Read why a create was refused:** the rule (`M7.spec_id`, `X10`, `X11`, …) and which quota.

A runner does all of this in its own client today. Every SWE-bench-style user would have to write it
again.

## 3. Proposal: the commands

All under `mocactl sbx templates`, each with `--json` (the API's answer, one JSON object, never a
token). New ones in **bold**.

### 3.1 Before a create

| Command          | Call                          | Prints                                                                                                             |
| ---------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **`sbx quota`**  | `GET /v1/quota`               | templates, buildsQueued, active, sandboxes: limit and used; `quotaSource`                                          |
| **`sbx policy`** | `GET /v1/policy`              | profiles (envelope, egress, requires), allowed registries and repositories, the policy digest                      |
| **`sbx hosts`**  | `GET /v1/templates` (`hosts`) | per host: active limit/used, start (concurrency, starting, queued, seconds), memory (headroom, brake), grace, disk |

### 3.2 Create and follow

| Command                                                                                                  | Call                                     | Notes                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`templates create --spec F [--id ID] [--image REF] [--profile P] [--visibility V] [--gate-record F]`** | `POST /v1/templates`                     | `F` is a spec, or a gate record's template block; id and image default to the spec's own and must equal it (M7). The gate record is sent **byte for byte** (its sha256 is what the policy trusts). Answers the build handle |
| **`templates create … --dry-run`**                                                                       | none                                     | the checks a client can make locally (§3.5); exit 0 or the rule it would fail                                                                                                                                               |
| **`templates build ID --spec F …`**                                                                      | `POST /v1/templates/{id}/builds`         | a new build of an existing template                                                                                                                                                                                         |
| **`templates show ID [--build B]`**                                                                      | `GET /v1/templates/{id}`, `…/builds/{b}` | status, reason, attestation, heldBy, readiness and its reason, queue position, grace                                                                                                                                        |
| **`templates follow ID [--build B] [--timeout S]`**                                                      | the same, polled                         | until registered / failed / rejected / cancelled; transient 5xx retried; exit 0 only on registered                                                                                                                          |
| **`templates cancel ID --build B`**                                                                      | `POST …/builds/{b}/cancel`               | queued, building or probing only                                                                                                                                                                                            |

**Many creates:** `templates create` takes several `--spec` files; at `429 quota_exceeded {quota:
buildsQueued}` it waits for a slot (a registered or failed build) and says "N waiting for a queue
slot", never failing the run (the runner's wave rule).

### 3.3 Activate, use, release

| Command                                                                    | Call                        | Notes                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`templates activate ID [--build B] [--lease S] [--wait] [--timeout S]`** | `POST …/activate`           | with `--wait`, polls readiness until `active`, printing the reason while it waits (queued at position N, no slot, memory, graced); `not_held` and `memfile_mismatch` fail at once with the reason |
| **`templates deactivate ID [--build B] [--stop-now]`**                     | `POST …/deactivate`         | `--stop-now` skips the host's idle grace (G43); prints `released`                                                                                                                                 |
| `create --template ID@BUILD`                                               | `POST /v1/sandboxes`        | already passed through; add a test and document it                                                                                                                                                |
| **`create --seed`**                                                        | the sandbox's first command | runs the build's `spec.seed`, then checks the workspace (a clean tree; HEAD named by the spec)                                                                                                    |
| `egress ID --verify`                                                       | `GET …/egress`              | adds a check of the log's sha256 against the end record (today `verify-provenance.py --egress` does it)                                                                                           |

### 3.4 End of life

| Command                                      | Call                 | Notes                                                      |
| -------------------------------------------- | -------------------- | ---------------------------------------------------------- |
| `templates retire ID … --wait [--timeout S]` | as today, then `GET` | waits until the build reads `retired` and no host holds it |

### 3.5 What `--dry-run` checks

The same checks the policy makes that need nothing but the inputs: the id rule, the image by digest
(not a tag, not a placeholder), the spec well formed (M7: guest ≥ 128 MiB as `guest_ram_mb`, vCPUs,
probe, tools, booleans), the spec's id and image equal to the create's, a profile `sbx policy` names,
the envelope, a self profile with a gate record and `base` without one, `source_record_digest` equal
to the image's digest. Not the gate record's trust (that needs the policy's trusted list) and not
quotas: the server decides those.

### 3.6 Users and admin

- **Kept as they are:** `admin subjects …`, `templates quota TARGET`.
- **Every admin write prints old → new** (from the answer's `before` and the new value) and the
  policy record's digest.
- **A 403 is reported plainly** ("needs the admin role") and never retried as another role; mocactl
  never mints, stores or extends an admin token. Admin logins stay the operator's (mint-login.sh),
  short and on purpose.

### 3.7 Errors (every command)

`ApiError` keeps the body's `rule`, `quota`, `readiness`, `readinessReason`, `queuePosition` and
`retryAfter`, and prints them: `refused by policy rule M7.spec_id: spec.id must be the create's id`;
`over your buildsQueued quota (10 of 10)`. Exit codes stay as they are (1 refused, 2 usage, 3 login,
4 network), with **5 for a timeout** of `follow`, `activate --wait` or `retire --wait`.

### 3.8 A record per call (`--record F`)

Every command that calls the API takes `--record F`: one NDJSON line per HTTP call, appended to `F`
(0600): method, path, status, the request body (a gate record by its sha256 only), the answer's body,
the request and answer times (UTC, ms), and the Retry-After. **Never a token or a header.** This is
what a benchmark runner needs to drop its own client and still compose its provenance links from what
mocactl did.

## 4. What does not change

- No control-plane change: every call exists in openapi 1.10.0 (1.11.0 with M7).
- The sandbox commands (`run`, `put`, `up`, `push`, `pull`), sessions, and the login flow.
- `sbx token` and `mocactl auth token` still print tokens; nothing new does.

## 5. Tests

Each command against the control plane's fake (the existing `sbx-cli.test.ts` pattern): the call it
makes, its `--json` answer, each refusal printed with its rule or quota, the waits (Retry-After,
queue, `429 buildsQueued`) and their timeouts, `--record` lines with no token, `--dry-run` refusing
each rule in §3.5. A runner's side-by-side run in one KVM-host window checks the commands against its
own client.

## 6. Order

1. Errors (§3.7), then the reads (§3.1): small, used by everything after.
2. Create, follow, show, cancel, build (§3.2), with `--dry-run` and many creates.
3. Activate and deactivate (§3.3), `create --template id@build` tested, `--seed`, `egress --verify`.
4. Retire `--wait`, the admin print (§3.4, §3.6), `--record` (§3.8).
5. Docs: the user guide, the GUIDE's create examples as mocactl commands, the RUNBOOK.

## 7. Decisions for the user

1. **The scope:** §3 as proposed (the reads, create/follow/cancel/build, activate/deactivate,
   seed, egress verify, retire `--wait`, errors, `--record`). _Recommended._ Or a smaller first cut:
   §3.1-§3.3 and §3.7 only.
2. **Where:** under `mocactl sbx templates` (beside the existing commands). _Recommended._ Or a new
   top-level `mocactl templates`.
3. **`--record F` (§3.8):** build it, so a runner can move to mocactl and keep its records.
   _Recommended_ (autobench-moca's condition for adopting mocactl).
4. **`create --seed`:** in mocactl (the client runs the seed, as SBX0 leaves it to the client).
   _Recommended._ Or leave seeding to each client.
5. **`--dry-run`:** the local checks of §3.5 only, never the trusted list or quotas. _Recommended._
6. **Timeouts:** exit 5, defaults `follow` 3600 s (a build), `activate --wait` 900 s (28 cold starts at
   4 per run), `retire --wait` 300 s. _Recommended._
