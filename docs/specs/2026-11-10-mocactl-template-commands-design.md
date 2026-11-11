# mocactl for templates and users: the client's whole path

- **Status:** implemented (branch sbx-mocactl), as accepted (the user, 2026-11-10: all seven
  recommendations in §7), after reviews by autobench-moca and autobench. As built: §4a. Not yet run
  against a live control plane or in a KVM-host window (§5's side-by-side run).
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

**A create that meets `409 template_exists`:** if the template is the caller's own, follow its newest
build and post nothing (also how a create whose `202` was lost, for example to a client's sleep, is
recovered); if it is not, say whose it is and that an admin can hand a declared id over (G34). A
many-create resume never posts anything twice.

**Many creates:** `templates create` takes several `--spec` files; at `429 quota_exceeded {quota:
buildsQueued}` it waits for a slot (a registered or failed build) and says "N waiting for a queue
slot", never failing the run (the runner's wave rule).

### 3.3 Activate, use, release

| Command                                                                    | Call                            | Notes                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`templates activate ID [--build B] [--lease S] [--wait] [--timeout S]`** | `POST …/activate`               | with `--wait`, polls readiness until `active`, printing the reason while it waits (queued at position N, no slot, memory, graced); `not_held` and `memfile_mismatch` fail at once with the reason |
| **`templates deactivate ID [--build B] [--stop-now]`**                     | `POST …/deactivate`             | `--stop-now` skips the host's idle grace (G43); prints `released`                                                                                                                                 |
| `create --template ID@BUILD`                                               | `POST /v1/sandboxes`            | already passed through; add a test and document it                                                                                                                                                |
| **`create --seed`**                                                        | the sandbox's first command     | runs the build's `spec.seed`, then checks the workspace (a clean tree; HEAD named by the spec)                                                                                                    |
| **`token ID --renew-every S`**, and `run`/`put` renewing on their own      | `POST /v1/sandboxes/{id}/token` | a run longer than the sandbox token's life keeps working (a runner renews every 10 min today)                                                                                                     |
| `egress ID --verify`                                                       | `GET …/egress`                  | adds a check of the log's sha256 against the end record (today `verify-provenance.py --egress` does it)                                                                                           |

### 3.4 End of life

| Command                                      | Call                 | Notes                                                      |
| -------------------------------------------- | -------------------- | ---------------------------------------------------------- |
| `templates retire ID … --wait [--timeout S]` | as today, then `GET` | waits until the build reads `retired` and no host holds it |

### 3.5 What `--dry-run` checks

The same checks the policy makes that need nothing but the inputs: the id rule, the image by digest
(not a tag, not a placeholder), the spec well formed (M7: guest ≥ 128 MiB, vCPUs, probe, tools,
booleans; **a spec with `guest_mb` and no `guest_ram_mb` is told to write `guest_ram_mb`**, which the
build reads, G46), the spec's id and image equal to the create's, a profile `sbx policy` names,
the envelope, a self profile with a gate record and `base` without one, `source_record_digest` equal
to the image's digest. Where a KVM host may still run a build-snapshot.sh older than G47's fix, a
git-less image is pointed at `skip_git_identity_check`. Not the gate record's trust (that needs the policy's trusted list) and not
quotas: the server decides those.

### 3.6 Users and admin

- **Kept as they are**, `admin subjects …` and `templates quota TARGET`, **gaining the print below**
  (today they don't print `before`).
- **Every admin write prints old → new** and the policy record's digest, and **detects a concurrent
  write** without any control-plane change: it reads the current value first and shows it, writes,
  then compares the answer's `before` with what it read. If they differ it **fails loudly**
  (nonzero): "changed by someone else between read and write: <read> / <before> / <new>". That
  doesn't prevent the race (decision 7 would), but it can't go unnoticed.
- **The issuer check:** mocactl refuses a login whose control plane or issuer doesn't match the
  command's target (a login for one deployment pointed at another), with a test.
- **Later, named here so it isn't lost:** a user's request that an admin trust their self-attested
  gate record (G41 (c): today an admin's edit of `trustedGateRecords`), for example `templates share`.
- **A 403 is reported plainly** ("needs the admin role") and never retried as another role; mocactl
  never mints, stores or extends an admin token. Admin logins stay the operator's (mint-login.sh),
  short and on purpose.

### 3.7 Errors (every command)

`ApiError` keeps the body's `rule`, `quota`, `readiness`, `readinessReason`, `queuePosition` and
`retryAfter`, and prints them: `refused by policy rule M7.spec_id: spec.id must be the create's id`;
`over your buildsQueued quota (10 of 10)`. Exit codes stay as they are (1 refused, 2 usage, 3 login,
4 network), with **5 for a timeout** of `follow`, `activate --wait` or `retire --wait`.

### 3.8 A record per call (`--record F`)

Every command that calls the API takes `--record F`, appending **one NDJSON line per HTTP attempt** (a
retried POST shows as two): the mocactl command and an invocation id (to group a command's calls),
`seq` (the line's number in the invocation) and `try` (1, 2, … for the same method and path in a row),
method, the path (never the base URL or host), status or the transport error, the
request body, the answer's body, the request and answer times (UTC, ms), and the Retry-After. This is
what a benchmark runner needs to drop its own client and still compose its provenance links from what
mocactl did: the sandbox's id, `buildId` and `templateManifestHash`, the activate answer, and the
times.

- **No secret, in a header or a body.** Any field named `token`, `refreshToken`, `sessionToken`,
  `apiToken` or `accessToken`, and a gate record, is replaced by its sha256. `sbx token` and the `auth`
  commands never take `--record`. A test asserts that no recorded line matches a JWT (`eyJ…`) or a
  refresh token's prefix. **And a value check as a backstop:** any string value, under any field name or nested
  anywhere, that looks like a JWT (`eyJ…\.…\.…`) or starts with the refresh token's prefix is hashed
  too, so a token field the API adds later is caught at write time, not only by the test.
- **No host identifier or free text:** `execEndpoint`, `execCa`, an egress event's `dial_addr`,
  build-log text and reason messages are replaced by their length, as a benchmark runner's own
  client does.
- **The file:** created 0600; an existing `F` with wider permissions is refused. Opened `O_APPEND`,
  each line written in one `write` call (under the pipe-buffer size, or with a lock past it), so 28
  concurrent processes can share one record.

## 4. What does not change

- No control-plane change: every call exists in openapi 1.10.0 (1.11.0 with M7).
- The sandbox commands (`run`, `put`, `up`, `push`, `pull`) apart from token renewal, sessions, and
  the login flow.
- **Open session gaps, not in this scope:** receive times in `run --json`'s frames (G-e),
  `run --patch-out F` (a session's workspace patch to a file), and `--record` on `mocactl run` (a Moca
  Pi session's id and times for a runner's provenance links).
- `sbx token` and `mocactl auth token` still print tokens; nothing new does.

## 4a. As built (branch sbx-mocactl)

Code: `packages/mocactl/src/sbx/templates.ts` (the commands), `dry-run.ts` (§3.5),
`call-record.ts` (§3.8), `api.ts` (the calls), `commands.ts` (errors, admin writes, `--seed`,
`--renew-every`, `--verify`), `api/errors.ts` (§3.7); tests in `test/sbx-templates.test.ts`. Where it
departs from §3, and why:

- **`sbx quota`, `sbx policy`, `sbx hosts` are top-level** under `sbx`, as §3.1's table names them,
  not under `sbx templates` (whose `templates quota TARGET` is the admin write, kept).
- **`--record` is refused on `credentials`** as well as `token` and the login commands: its request
  bodies are secrets. The record's backstop also hashes a field named `secret` and
  `refresh_token` (the refresh request's own name), beside §3.8's list.
- **The record's `command` is `sbx <command> [<subcommand>]`**, never the arguments (an id or a path
  could be anything). Bodies that are not JSON (an egress NDJSON export) are kept as their length.
  A request's `reason` (a retire's free text) is kept as its length, as a reason message is.
- **`--dry-run` reads `GET /v1/policy`** for the profiles §3.5 checks against, so it needs a login
  and one request; it creates nothing. Beyond §3.5's list it checks what the profile requires that
  the inputs decide: the gate record passed and is for this image (X1, X1.image, X1.offline),
  egress off (X11), commits refused with `skip_git_identity_check` (X12), `probe_status` (X14), the
  exact size (X15). The trust of the record (X1.trusted, the self-attested scope) and quotas stay
  the server's. Its two id and image rules are named `M7.spec_id` and `M7.spec_image` (the
  control plane names no such rule today: it ignores the spec's own id and image). `base` with a
  gate record is a local refusal, `gate.profile`.
- **`create --seed` checks HEAD only when the build's spec names `baseline_commit`**: the spec
  schema has no head field today (image-factory's records carry `baseline_commit` beside the
  template block, not in it), so for most templates the check is the clean tree alone. A seed that
  fails keeps the sandbox, exit 1.
- **`token --renew-every S`** prints a fresh token every S seconds until interrupted; `run` and
  `put` already re-mint inside one connection (`sandboxTokenFn`), so no change was made to them.
- **§3.6's compare for `admin subjects`:** those answers carry no `before`, so the read is compared
  with the answer's `record` (null when nothing changed): a read that says "already so" while a
  record was written, or the reverse, is the loud failure. An unenroll of an admin, and a revoke of
  a lapsed grant, cannot be judged from the list and are not compared.
- **The issuer check** compares the login's control-plane URL with the target, then the API
  token's `iss` (read, not verified) with the issuer the target's `/v1/discovery` profile mints
  under (`sandbox`: `sbx-control-plane-api`, `combined`: `sh-control-plane`). It runs before admin
  writes only; a token that is not a JWT is left to the server.
- **A `404 template_not_found` is reported as itself**: before, every non-sandbox 404 read as "that
  control plane has no sandbox routes", which also misreported `templates retire` of an unknown id.
- **Many creates run one after another**, not in parallel; "N waiting" counts the specs not yet
  posted. `--timeout` on `create` bounds the queue-slot wait (default 3600 s, exit 5).

- **`activate --wait`'s default, sized** (the grace window, 2026-11-10: 28 cold starts at four at a
  time took about 1,890 s, past a fixed 1800 s): with no `--timeout`, the first poll of a build queued
  behind its host's start limit sets the limit to (ceil(queuePosition / concurrency) + 1) × the host's
  `start.seconds` × 1.25, never under 1800 s and never over 4 h (14,400 s, said on stderr when it applies: a host reporting an outlier start time can't make it sit for hours); without a position or a measured start time, 1800 s.
  `--timeout S` always wins. The same rule as autobench-moca's runner.

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
6. **Timeouts:** exit 5, defaults `follow` 3600 s (a build), `activate --wait` **1800 s** (a cold batch of 28 at 4 starting per run measured up to 1,447 s to active), `retire --wait` 300 s. _Recommended._
7. **If-Match on admin PUTs** (`PUT /v1/quota/{subject}`, `PUT /v1/policy`), so a concurrent write is
   refused, not only detected: a control-plane change, with an image and a rollout on both namespaces.
   **Later, as its own change** (_recommended_: admin writes are rare and by one operator, and §3.6's
   check detects one), or now.
