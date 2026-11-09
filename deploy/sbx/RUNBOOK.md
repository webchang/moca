# SBX0 operator runbook

> **Preview.** The SBX0 sandbox service is implemented for an internal cohort, but not yet
> declared Stable; interfaces and limits may change.

For the operators of an SBX0 deployment: the sandbox control plane, the relay and Redis in one
namespace of a shared OpenShift cluster, and template workers plus the janitor on a KVM host. The
install reference (every input and its rule) is [the deploy README](README.md); users have
[the user guide](../../docs/sbx/user-guide.md). The design is
[the SBX0 spec](../../docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md) (§8 for
operations).

Throughout, `<env file>` is the operator's settings file outside the repository (README §1),
`<host>` a KVM host, `<checkout>` this repository on that host, and `<id>` a worker id. Keep
`deploy/sbx/.generated/` between runs: `setup.sh` reads the bundles it last wrote there (it is
gitignored).

## 1. Deploy from scratch

1. **The namespace.** An existing namespace, dedicated to SBX0, where you have edit rights.
2. **A GitHub OAuth app** of this deployment's own, with device flow enabled: its client id is
   `SBX_GITHUB_CLIENT_ID`.
3. **The snapshots.** On the KVM host, one golden snapshot per template, built with
   `deploy/microvm/build-snapshot.sh --out /srv/sbx/snapshots/<image>`
   ([P4-ON-P6](../microvm/P4-ON-P6.md) has the full command). Every curated template carries `bash`,
   `git`, `tar` and `ripgrep`.
   Build them with a `build-snapshot.sh` from P4.1 or later: an older snapshot has no guest egress
   listener (see [Guest egress](#guest-egress)). The host also needs `/usr/local/bin/moca-egress`
   (`CGO_ENABLED=0 go build -o /usr/local/bin/moca-egress ./remote-worker/cmd/moca-egress`); the
   worker install refuses without it, unless you pass `--no-egress`.
4. **The cluster side.** Write `<env file>` (README §1 lists every input; the required ones are
   `SBX_NAMESPACE`, `SBX_API_HOST`, `SBX_ATTACH_HOST`, `SBX_EXEC_HOST`, `SBX_IMAGE`, `SBX_WORKERS`,
   `SBX_TEMPLATES_FILE`, `SBX_GITHUB_CLIENT_ID`, `SBX_ALLOWED_SUBJECTS` and `SBX_WORKSPACE_FS_GIB`),
   then:

   ```bash
   deploy/sbx/setup.sh --env-file <env file>
   ```

   It generates every token, key and certificate once and keeps them, applies the overlay, waits for
   the rollouts, and writes one worker bundle per `SBX_WORKERS` id plus the janitor bundle under
   `deploy/sbx/.generated/`.

5. **Each worker,** on its KVM host:

   ```bash
   scp -r deploy/sbx/.generated/workers/<id> <host>:sbx-<id>
   ssh <host> sudo <checkout>/deploy/sbx/install-host.sh sbx-<id> --snapshot <image> [--budget-mb N]
   ssh <host> rm -r sbx-<id>
   ```

   It waits up to 120 s for the worker's attach to hold (`SBX_ATTACH_TIMEOUT`). The worker's guest
   RAM (`SH_GUEST_RAM_MB`) is taken from the snapshot's `manifest.json` (`guest_ram_mb`), never set
   by hand: a snapshot without it is refused. `--budget-mb` (default 8192) must hold at least one
   session, (guest RAM + 32) × 3 + 1024 MiB at the unit's standby depth of 2: 13408 MiB for a
   4096 MiB guest. A smaller budget is refused, naming the minimum. **That minimum fits one
   session, not overlapping use:** size the budget for the commands that may run at once on the
   template, (guest RAM + 32) × running VMs + 1024 MiB, for example 17536 MiB for four 4096 MiB
   VMs (two agents on one template, each with a command and a standby being promoted). Below that,
   a command is refused at admission before it starts (`memory-budget`, register G36); `sbx run`
   and the static `sbx` client retry such a refusal and exit 75 if every try is refused.

6. **The janitor,** once per KVM host:

   ```bash
   scp -r deploy/sbx/.generated/janitor <host>:sbx-janitor
   ssh <host> sudo <checkout>/deploy/sbx/install-host.sh --janitor sbx-janitor
   ssh <host> rm -r sbx-janitor
   ```

7. **Check it** with [status](#8-status-and-the-audit-lines): every worker attached, the janitor
   timer active, then log in as a user and run `mocactl sbx doctor` in a repository.

**Which `mocactl` users install.** Since v0.7.0 the default channel, the latest release, carries
`mocactl sbx`, as [the user guide](../../docs/sbx/user-guide.md#2-install) says:

```bash
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/scripts/install-mocactl.sh | sh
mocactl sbx --help    # the first line: usage (the sandbox service, SBX0):
```

A `mocactl` older than v0.7.0 has no `sbx`: its `mocactl sbx --help` prints the general
`usage:` list, and a bare `mocactl sbx` says `unknown command "sbx"`. Such a user re-runs the
install line above (or with `MOCACTL_VERSION=edge` for the newest build of `main`).

The increments' inputs, for an older deployment: 1a had `SBX_CLIENTS` (static tokens; now refused)
and no sandbox profile; 1b added the control-plane inputs (`SBX_API_HOST`, `SBX_GITHUB_CLIENT_ID`,
`SBX_ALLOWED_SUBJECTS`, `SBX_TEMPLATES_FILE`, the lifetimes and quotas); 1c adds the janitor
(`SBX_JANITOR_WAIT_MINUTES`, `SBX_API_CA_FILE`) and nothing else that is required.

## 2. Upgrading

**An image upgrade** (a new `SBX_IMAGE`): set it in `<env file>` and re-run `setup.sh`. A changed
image rolls the control plane and the relay, and so does a change to what the relay reads (the
token issuer, `SBX_MAX_INFLIGHT`, the signing keyset, the attach or exec certificate). Workers keep
running, and reattach when the relay comes back; Execs running through the old relay pod end with it
(the worker kills a dropped stream's Execs), so apply those when nothing long is running. Any other
setting (templates, subjects, quotas, lifetimes) rolls the control plane alone, and running Execs
carry on.

**From 1a:** unset `SBX_CLIENTS` (the run refuses it), move `SBX_IMAGE` off the team-only 1a image,
and run with `SBX_ACK_HOSTS=1`, because every 1a worker bundle lacks the workspace idle time and
must be reinstalled:

```bash
SBX_ACK_HOSTS=1 deploy/sbx/setup.sh --env-file <env file>
```

Then re-run `install-host.sh` with the new bundle for every worker (step 5 of §1); it refuses a 1a
bundle. The run deletes the static client tokens and removes the relay's harness exec token. **1a
workspaces are not migrated:** tell 1a users to pull their work out first.

**Redis's image and its data (Valkey, #670).** Since upstream #670 the base runs Valkey 9. Valkey
9 **cannot read RDB format 12**, which Redis 7.4 writes, so on a namespace that Redis 7.4 ran,
Valkey's AOF load aborts (`Can't handle RDB format version 12`) and `redis-0` crash-loops, taking
the control plane down with it (ykt3, 2026-11-04, about 24 min). Until a real migration exists,
keep such a namespace on Redis 7: set `SBX_REDIS_IMAGE` to the digest it ran, e.g.
`docker.io/redis:7-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499`.
Before any Redis image change, take a copy of `/data` (`BGSAVE`, then `dump.rdb` and
`appendonlydir`). **The StatefulSet is OrderedReady:** a `redis-0` that crash-loops on the old
revision is never replaced, so `setup.sh`'s rollout wait times out. Then delete the pod
(`kubectl -n <ns> delete pod redis-0`; its PVC stays) and re-run `setup.sh`.

**Redis's memory limit (register G45).** `setup.sh`'s `redis.conf` sets `maxmemory 200mb` with
`maxmemory-policy noeviction`, under the container's 256 MiB: a full Redis refuses writes (the
control plane answers `503 redis_unavailable`) and evicts nothing, instead of being killed with
every session and sandbox record. **A new namespace gets it at Redis's first start** with nothing
extra. **An existing one doesn't:** the Secret's change doesn't restart `redis-0` (the StatefulSet
has no settings hash), so apply it live, `kubectl -n <ns> exec redis-0 -c redis -- redis-cli CONFIG
SET maxmemory 209715200` and `… CONFIG SET maxmemory-policy noeviction` (`REDISCLI_AUTH` is set in
the container), or let the next restart read the file. Check with `CONFIG GET maxmemory`. Redis 7
and Valkey 9 both accept it.

**A host bundle change.** Re-run `install-host.sh` with the new worker bundle whenever `setup.sh`
says so, and `install-host.sh --janitor` with the new janitor bundle after a change to
`SBX_JANITOR_WAIT_MINUTES`, `SBX_TOKEN_TTL_MINUTES` (its default wait follows the lifetime),
`SBX_API_HOST` or `SBX_API_CA_FILE`. `status.sh --host` warns when a host's installed janitor wait
no longer exceeds the token lifetime plus 30 s.

## 3. Changing the sandbox lifetime

`SBX_LIFETIME_DAYS` (default 7) sets how long a sandbox lives, and each worker's idle reclaim,
`SH_WORKSPACE_IDLE`, is that plus two days. **A change means reinstalling every host's workers.**
The control plane takes the new lifetime at once, but a running worker keeps the idle it was
installed with until `install-host.sh` is re-run on its host; after a raise, that idle can be
shorter than a live sandbox's lifetime, and the worker would reclaim its workspace.

So `setup.sh` refuses a lifetime that changes the idle in the bundles it last wrote. Either
reinstall every host first, with bundles made from the new value, or:

```bash
SBX_ACK_HOSTS=1 deploy/sbx/setup.sh --env-file <env file>
```

and then, right after, re-run `install-host.sh` with the new bundle for each worker the run names.

## 4. Adding or removing a user

Users are `SBX_ALLOWED_SUBJECTS`: comma-separated `github:<numeric id>`, no spaces. Look an id up
with `gh api users/<login> --jq .id`. A user who is not enrolled is told their own `github:<id>` by
`mocactl sbx login`.

Edit the list and re-run `setup.sh`. The control plane rolls with the new list:

- **adding** takes effect as soon as the rollout ends;
- **removing** refuses every sandbox route (create, list, mint) at once, and the user's login at
  its next refresh. A sandbox token already issued keeps working until it expires: **within one
  token lifetime plus 30 s** (`SBX_TOKEN_TTL_MINUTES`, 15 minutes by default), and a command still
  running then is cancelled. The user's sandboxes are not deleted; delete them as an admin
  (`mocactl sbx ls --all`, `mocactl sbx rm --force <sandbox id>`) if their work must go. The
  `--force` is needed: `rm` first checks a sandbox for work not yet pulled, which takes a sandbox
  token, and an admin is never minted one for another user's sandbox.

Admins (`SBX_ADMIN_SUBJECTS`) may list, read and delete every sandbox, but never mint a token for
another user's: they cannot run commands in another user's code.

**Enrollment and admins through the API** (register G38, on a deployment with a template store,
`SBX_TEMPLATE_STORE`). The settings above stay the bootstrap; an admin named in `SBX_ADMIN_SUBJECTS`
adds to them without a `setup.sh` run (an API-granted admin can't change access: `403`), each change a record on the `members` provenance stream:

```bash
mocactl sbx admin subjects                                   # who is enrolled, and how
mocactl sbx admin subjects enroll github:<id>                # or unenroll
mocactl sbx admin subjects grant github:<id> --until 1h      # a temporary admin: lapses by itself
mocactl sbx admin subjects revoke github:<id>
```

It takes effect at the subject's next request. A subject in `SBX_ALLOWED_SUBJECTS` or
`SBX_ADMIN_SUBJECTS` can't be unenrolled or revoked this way (`409 bootstrap_subject`): change the
settings for those. An admin can't revoke its own role.

**What this changes for an operator** (once deployed):

- **Who controls access.** Without it, every enrollment or admin change is a `setup.sh` run by
  whoever operates the namespace. With it, an admin named in `SBX_ADMIN_SUBJECTS` can enroll subjects
  and grant admin through the
  API, with no `setup.sh` run. The record on the `members` stream is then the only trace, so read it
  (`GET /v1/subjects`, the provenance export) as part of any access review.
- **Roles come from the store, not the login.** On a deployment with a store, the control plane
  replaces a token's `roles` claim, on every request, with the subject's roles now (the settings plus
  the store's grants). Two consequences:
  - **A login minted as a user acts as an admin** if its subject holds an API admin grant. Check
    `GET /v1/subjects` before treating a mint as user-only.
  - **Revocation is immediate.** Removing a subject from `SBX_ADMIN_SUBJECTS` (a `setup.sh` run), or
    revoking an API grant, takes effect at the subject's next request, even for an admin token that
    is still valid. But `setup.sh` can't remove an API grant (those live in the store, on the PVC). So
    after removing a temporary admin from the settings, check `GET /v1/subjects` for API admins too
    before concluding there is no admin. For a temporary admin, prefer an API grant with `--until`:
    it lapses by itself.

**A test login without GitHub.** A deployment whose `SBX_GITHUB_CLIENT_ID` is a placeholder (no OAuth
app) has no device flow. To test it, an operator mints a login for an enrolled subject with the
deployment's own signing key:

```bash
deploy/sbx/mint-login.sh --env-file <env file> --subject github:<id> --home <dir> [--ttl-minutes N]
HOME=<dir> mocactl sbx templates
```

It reads `moca-mu1` with `kubectl` and writes `<dir>/.config/mocactl/sbx-auth.json` (0600), the
cache `mocactl sbx` reads, with `XDG_CONFIG_HOME` unset. The key and the token reach no argv, log
or output. The login cannot refresh: mint another when it ends (60 minutes by default, at most a
day). Anyone who can read Secrets in the namespace can do this, so it grants nothing an operator
lacks. Give each test user a `<dir>` of their own, as the smoke's two `HOME`s (§13).

A second test user must still be a real `github:<id>` enrolled in `SBX_ALLOWED_SUBJECTS`. A made-up
id is safe only while the client id is a placeholder, since nothing can then sign in through
GitHub. Once a real OAuth app is configured, whoever owns that id on GitHub could log in as an
enrolled user. So drop a made-up id from the list when the test ends, and use a real second account
on a deployment with an OAuth app.

## 5. Adding, updating and removing a template

[template-onboarding/](template-onboarding/README.md) is the long form, with the tools that do the steps below:
`template-build.sh` (the snapshot, checked in a microVM) and `template-register.sh` (the two lists).

A template is an id clients choose (`mocactl sbx create --template <id>`, `POST /v1/sandboxes
{template}`), served by one worker running one snapshot. A sandbox keeps the worker it was created
on for its whole life, whatever later happens to its template's entry.

**Adding a template:**

1. Build its snapshot on the KVM host (§1 step 3), named `<image>`. An image built from a container
   image for a benchmark (one that refuses agent commits, with a read-only rootfs) usually needs
   `build-snapshot.sh --skip-git-identity-check --guest-home /tmp/home`, and `--vcpus N
--guest-ram-mb M` for its size ([P4-ON-P6](../microvm/P4-ON-P6.md#build-the-golden-snapshot)).
2. Pick a worker id (`^[A-Za-z_][A-Za-z0-9_]*$`, say `sbx_node22`) and add it to `SBX_WORKERS`.
3. Add its entry, `{ "id", "worker", "description", "tools" }`, to `SBX_TEMPLATES_FILE`. One
   template per worker; every worker in the list.
4. Re-run `setup.sh`: it mints the worker's token and writes its bundle.
5. Install the worker with that bundle and `--snapshot <image>` (§1 step 5). A new worker's token
   reaches the relay when the kubelet syncs the Secret, about a minute, so its first attaches may be
   refused; `install-host.sh` waits. Pass `--budget-mb` for a guest larger than 256 MiB (§1 step 5).
6. Check it with `deploy/sbx/templates-check.sh` (§14).

**Updating a template** (a new image or snapshot) is versioned: never re-point a worker that serves
sandboxes at another snapshot, or their commands change environment mid-work. Instead:

1. Build the new snapshot under a new `<image>` name.
2. Add a new worker id for it (say `sbx_node22_v2`) to `SBX_WORKERS`, keeping the old one.
3. Change the template's `worker` in `SBX_TEMPLATES_FILE` to the new id. The old worker serves no
   template now, but stays in `SBX_WORKERS`, so it keeps its token and its sandboxes keep working.
4. Re-run `setup.sh`, install the new worker (steps 4-5 above), and check it (step 6). New sandboxes
   of the template go to the new worker; existing ones stay on the old.
5. Retire the old worker once it serves no live sandbox: `GET /v1/janitor/sandboxes` (the janitor's
   token) lists each live sandbox with its `wrk`, and `mocactl sbx ls --all` (an admin) shows their
   templates. Then remove it as below.

Both workers hold their snapshot's memory file in RAM (it is the guest's whole RAM image) until the
old one is retired, so the host needs room for both.

**Removing a template** (or a retired worker) is the reverse of adding one: drop it from both lists,
re-run `setup.sh` (which revokes the worker's token and deletes its bundle; it cannot attach again),
then `sudo <checkout>/deploy/sbx/install-host.sh --uninstall <id>` on its host. Its sandboxes stop
working at once (no worker serves them): tell their owners to pull first. With egress credentials on
(`SBX_EGRESS_CREDENTIALS=1`), a worker that serves no template is no egress worker, so its
remaining sandboxes get no stored credential (as if their owners had none) and credentialed hosts
answer them `401` until it is retired.

Every template change re-runs `setup.sh`, which rolls the control plane but not the relay (§2), so
running `Exec`s on every template carry on. A worker added or retired at the same time is a token
change, which the relay reads on each attach without a restart.

**One control plane process per template store** (register G40): activation's quota and placement
check and its lease write run under a lock inside the control plane process, which is enough because
one process owns the store: the Deployment runs one replica, and the template store's volume
(`ocp-sbx`'s and `ocp-combined`'s) is ReadWriteOnce with `strategy: Recreate`, so no second pod writes
it, even during a rollout. Keep it that way. A control plane with more than one replica, or a rolling
update, on one store would need a store-level lock. The other overlays configure no template store.

**Self-serve templates and the policy** (a deployment with a template store, §15): clients create
their own templates with `POST /v1/templates`, gated by the stored policy (`GET /v1/policy`), which
only an admin changes (`PUT /v1/policy`, a `policy` record). What an operator sets there:

- **Profiles**, the gate a create names: `base` (no gate record), `benchmark` (a gate record an admin
  trusts in `trustedGateRecords`), and the self-attested `benchmark-self` (offline) and
  `general-self` (the KVM host's allowlisted egress), which trust a subject's own gate record for its
  own templates only (register G41). A new image's default policy gains new profiles, but a stored
  policy does not: add them with one `PUT /v1/policy`, the whole policy as read plus the change.
- **Images:** `allowedRegistries` (`<default>` is the KVM host's own `SBX_REGISTRY`) and, per
  registry, `allowedRepositories`. Docker Hub is `docker.io`. **On a rollback to an image older than
  the repository allowlist, take `docker.io` out of `allowedRegistries` first:** an older image
  ignores `allowedRepositories`, so it would admit every Docker Hub repository.
- **Quotas:** `quota`, and `quotaBySubject` for an override.

## 6. Rotating the signing key

The control plane signs sandbox tokens with one Ed25519 key, `SH_SESSION_TOKEN_PRIVATE_KEY` in the
`moca-mu1` Secret; the relay verifies with its public half, in `sbx-token-keys`. **`setup.sh` keeps
exactly one key:** every run rewrites `sbx-token-keys` with the current key alone, so a second key
added by hand is removed by the next run. Rotation is therefore a key replacement:

```bash
kubectl patch secret moca-mu1 -n <namespace> --type=merge \
  -p '{"data":{"SH_SESSION_TOKEN_PRIVATE_KEY":null}}'
deploy/sbx/setup.sh --env-file <env file>
```

Remove that one key only: `moca-mu1` also holds the janitor's token (`SH_JANITOR_TOKEN`), which
deleting the whole Secret would rotate too. The run generates a new key, publishes its public half
as the whole keyset, and rolls the relay and the control plane (both pods' settings hashes cover
the keyset). `setup.sh` does not keep the old key beside the new one, and nothing else does.

What users see: `mocactl` mints a fresh sandbox token for its calls, and re-mints once when the
relay refuses a token before the call started, so sessions carry on with the new key. A token
minted with the old key is refused by the new relay (an unknown key id): a direct client must run
its `SBX_TOKEN_CMD` again, and no old-key token outlives one token lifetime in any case. The relay's
rollout also ends the Execs running through it (the worker kills a dropped stream's Execs), so
rotate when nothing long is running. The gentler form of spec §4.3 (both keys in the keyset while
the signer switches) is not what `setup.sh` does.

**The janitor's token** rotates the same way, plus a restart, because the control plane reads it
only at boot and it is not in the settings hash:

```bash
kubectl patch secret moca-mu1 -n <namespace> --type=merge -p '{"data":{"SH_JANITOR_TOKEN":null}}'
deploy/sbx/setup.sh --env-file <env file>
kubectl rollout restart deployment/moca-control-plane -n <namespace>
```

Then re-run `install-host.sh --janitor` with the new janitor bundle on every host. Until then, each
janitor run there logs `skipped` (refused) and removes nothing.

## 7. The janitor

A systemd timer on each KVM host, every 15 minutes (`sbx-janitor.timer`). Each run asks the control
plane for the live and terminated sandboxes (`GET /v1/janitor/sandboxes`, with its own token) and,
in each of this host's worker roots, removes:

- the workspace of a sandbox terminated more than the wait ago (`SBX_JANITOR_WAIT_MINUTES`,
  default 60, or the token lifetime plus 5 minutes when that is longer);
- an unknown workspace (no record at all) left unmodified for longer than that worker's
  `SH_WORKSPACE_IDLE`;
- `.reclaiming-*` trees older than an hour.

It keeps everything else, and touches nothing when the control plane cannot be asked or answers
anything unexpected. The wait must exceed one token lifetime plus 30 s, so a deleted sandbox's last
token has expired before its files go; `setup.sh` refuses a shorter one, and `status.sh --host`
warns when a host's installed bundle predates a lifetime raise.

Each run logs one JSON line, `summary` or `skipped`, unless it refuses its own settings (a token
file with the wrong mode, a bad URL): then it exits 2 with the reason on stderr and no JSON line.
`status.sh --host` shows the service's result, so such a run shows as FAILED:

```bash
ssh <host> sudo journalctl -u sbx-janitor -o cat | grep '"janitor":"summary"' | tail -1
```

```json
{
  "janitor": "summary",
  "ts": "…",
  "examined": 4,
  "removed": 1,
  "unknown": 0,
  "bytes_freed": 4096,
  "errors": 0
}
```

`errors` counts what it kept because something did not check out (a missing worker env file, an
unreadable time); the lines before the summary say which. A `skipped` line says why (the control
plane unreachable, the token refused, a TLS failure: set `SBX_API_CA_FILE` if the API Route's
certificate is not publicly trusted).

Uninstalling the last worker leaves the janitor. Remove it with
`sudo <checkout>/deploy/sbx/install-host.sh --uninstall-janitor`.

## 8. Status and the audit lines

`deploy/sbx/status.sh` is read-only. It reads the audit lines of the relay's current pod only, so
right after the relay rolls (any `setup.sh` change that alters its settings or keys) the "last
hour" figures cover less than an hour. From a machine with `kubectl` access to the namespace:

```bash
deploy/sbx/status.sh --env-file <env file>
```

```
token lifetime: 900 s
workers attached: sbx_default sbx_py312
workers not attached: none
sandboxes live: 12
sandboxes terminated (retained, approx.): 31
exec last hour: 214 calls, p50 380 ms, p95 2140 ms, errors 1%
exec refused last hour: 2 refused, 5 busy
exec cut short last hour: 1 timeout, 0 expired, 3 cancelled
```

- **workers attached** reads the relay's presence records in Redis. A worker `not attached` serves
  no sandbox: its users see `no live worker for sandbox <id>`.
- **sandboxes terminated (retained, approx.)** is the deleted or expired sandboxes still listed
  (`SBX_RETENTION_DAYS`, default 14).
- **exec last hour** is from the relay's audit lines. A call is an Exec the relay routed; p50 and
  p95 are over those calls' durations; `errors` counts the relay's `error` outcome only (no live
  worker, a worker disconnect, a worker-side failure). A command's own non-zero exit is not an
  error. Refusals (a bad token, a wrong sandbox) and `busy` (the in-flight cap) are counted apart,
  as are calls cut short by a timeout, a token expiry or a client's cancel.

On a KVM host, as root:

```bash
sudo <checkout>/deploy/sbx/status.sh --host --token-ttl-seconds 900
```

```
unit sbx-worker@sbx_default.service: active
unit sbx-janitor.timer: active
workspace filesystem: 45% used, 90G of 200G (110G free) on /srv
janitor last run: {"janitor":"summary",…}
janitor wait: 3600 s (outlasts the token lifetime 900 s + 30 s)
```

Pass `--token-ttl-seconds` the cluster's `token lifetime`, or set `SBX_STATUS_HOSTS="<host> …"` (ssh
targets whose user has passwordless sudo) in `<env file>`, and the cluster-side run reports each
host too, with every line prefixed `host <host>`. The script is piped over ssh, so the host needs
no checkout for this.

**Reading the audit lines yourself.** The relay writes one JSON line per sandbox Exec to stdout
(spec §3.5), mixed with its other output, so select them first:

```bash
kubectl logs deployment/sandbox-relay -c sandbox-relay -n <namespace> --since=1h |
  grep -F '"audit":"sandbox_exec"' | jq -c 'select(.outcome != "end")'
```

Each line has `ts`, `wrk` (the worker), `req_id`, `ms`, `outcome`
(`end | timeout | expired | busy | error | cancelled | refused`) and `out_bytes`; `sub` and `sbx`
(the user and the sandbox) when the token verified; `exit_code` and `truncated` on `end`; and a
fixed `reason` on `refused`. No command text, output or token is ever logged. A refused `Abort` is
`"audit":"sandbox_abort"`. A `"audit":"sandbox_release"` line means a worker never ended an
expired Exec within 60 s of its abort, and the relay gave its slot back anyway: look at that
worker's host (a wedged guest, a stuck vsock). For a debugging session only, `SH_SANDBOX_AUDIT_COMMANDS=1` on the relay
adds each command's first 200 bytes as `cmd`.

## 9. Limits operators must know

- **The in-flight cap.** The relay admits at most `SBX_MAX_INFLIGHT` (default 2) Execs in flight
  per sandbox: one running, one waiting at the worker. More are refused as `busy` (users see
  "sandbox busy"). It keeps one user from filling a template's worker.
- **The deaf-worker slot hold.** When an Exec outlives its token, the relay cancels it and then
  waits for the worker's acknowledgement before freeing its in-flight slot. A wedged worker that
  never answers holds that slot until its attach stream drops: SBX0 has no bound on that drain, so
  with the default cap of 2, one wedged Exec halves the sandbox's concurrency until the worker
  disconnects. Restarting the worker (`systemctl restart sbx-worker@<id>`) drops the stream and
  frees every slot it held, and also ends every running Exec on that worker, for every user of the
  template.
- **Delete is not immediate.** A deleted sandbox (or a removed user) stays reachable for up to one
  token lifetime plus 30 s. Raising `SBX_TOKEN_TTL_MINUTES` allows longer commands at the cost of a
  slower delete, and needs a janitor reinstall (§2).
- **Disk is not admission-controlled on the worker.** The quotas are the disk control: `setup.sh`
  refuses `SBX_MAX_TOTAL` × `SBX_WORKSPACE_IMAGE_MB` over 80 % of `SBX_WORKSPACE_FS_GIB`.

## Guest egress

`install-host.sh` installs and starts one `moca-egress` per host (`moca-egress.service`) before the
worker, and wires every template worker to its control socket
(`MOCA_EGRESS_CONTROL_SOCK=/run/moca-egress/control.sock` in the worker env), with a drop-in
`sbx-worker@<id>.service.d/egress.conf` that orders the worker after `moca-egress`. A `--no-egress`
worker gets neither, so it never starts a `moca-egress.service` that the host has. A sandbox can then reach
only the hosts on the allowlist; everything else is refused with a named error (`destination_denied`),
never a timeout. No credential is involved.

- **The allowlist** is `MOCA_EGRESS_ALLOW` in `/etc/sbx/moca-egress.env`, a comma-separated list of
  hosts. It is seeded on the first install with `api.github.com,github.com,codeload.github.com,objects.githubusercontent.com`
  (or from `MOCA_EGRESS_ALLOW` in the installer's environment, on the first write only) and is never
  overwritten by a re-run. To change it, edit the file and run `sudo systemctl restart moca-egress`;
  open tunnels end, new ones work at once. The same restart is needed after rebuilding the binary.
- **Another install's `moca-egress.service`.** A host that also runs `deploy/microvm`'s P6 worker
  already has one. If `/etc/systemd/system/moca-egress.service` exists and `/etc/sbx/manifest` has no
  `egress unit` line for it, `install-host.sh` logs
  `reusing the existing moca-egress.service (not installed by this script)`, wires the workers to its
  socket and touches nothing else. Its allowlist is then that install's
  `/etc/serverless-harness/moca-egress.env`.
- **`--no-egress`** installs a worker without `MOCA_EGRESS_CONTROL_SOCK` and installs no egress unit:
  the worker behaves as before egress existed, and the guest has no network.
- **Snapshot:** a golden snapshot built before P4.1 has no guest egress listener. Rebuild it with
  `build-snapshot.sh` for egress to work ([P4-ON-P6](../microvm/P4-ON-P6.md#guest-egress-p41-277)).
- **If it fails to start,** the install names `journalctl -u moca-egress` (often a bad
  `/etc/sbx/moca-egress.env`). Fix it and re-run `install-host.sh`.
- **Ownership is by content.** The manifest records a digest of the unit it installed. If another
  install (`setup-microvm.sh`) later replaces `moca-egress.service`, a re-run logs
  `changed by another install; reusing it` and leaves it alone, and the last uninstall keeps it.
- **Uninstalling** the last worker also stops and removes the `moca-egress.service` this script
  installed; an allowlist you edited stays (`kept ... (edited)`).

### Egress records (register G42)

The host agent's wanted-state run (`sbx-host-agent-wanted`, every 15 s) also ships the proxy's audit
events to the control plane, where each lands in its sandbox's egress log: `mocactl sbx egress
SANDBOX`, or `GET /v1/sandboxes/{id}/egress`. Nothing to install: no new unit, timer or setting.

Paths are logged without query, fragment or userinfo, and an injected credential appears by name only, but a secret a guest puts in a URL path segment is logged as sent.

- **On or off:** on when `systemctl is-active moca-egress.service` says active, off otherwise (a
  `--no-egress` host, or a moca-egress not started). Active, not enabled: `install-host.sh` reuses a
  `moca-egress.service` another install owns (a P6 worker's) without enabling it, and that install may
  start it for a window only. So on such a host, whether the agent reads the proxy's journal follows
  that unit's state: while it runs for its own install (a P6 window), the agent reads its events every
  15 s, ships only this host's SBX0 sandboxes' (`egressSids`), and counts the rest `egressNotOurs`.
  Nothing of the other install's leaves the host, but check the unit's state at a window's start. Off, the agent reads no journal, posts nothing and writes no cursor; its summary
  says `"egress":"off"`.
- **Only this host's sandboxes' events leave it.** The wanted state names them (`egressSids`: the
  workspace keys of the sandboxes on this host's workers, live or ended within 600 s); an event with
  any other `sid`, such as a Moca P6 session's on the same proxy, stays in the journal and is only
  counted (`egressNotOurs`). The proxy's `audit_dropped` reports are sent. Against a control plane
  whose wanted state has no `egressSids` (older than openapi 1.7.0), the agent sends nothing and says
  so in an error line, keeping its cursor.
- **A time budget:** a run starts no new batch 120 s after its egress step began, so slow posts never
  hold the wanted unit (`TimeoutStartSec` 5 min) and its activations. The cursor stays at the last
  batch taken; the next run goes on.
- **It only reads.** The agent reads `journalctl -u moca-egress.service` and never starts, stops or
  configures `moca-egress`, so a failed post never blocks or changes a guest's egress.
- **Where it is:** the journal cursor after the last event the control plane took is
  `/srv/sbx/egress.cursor`; a batch being sent is `/srv/sbx/egress.pending.json` (both 0600). Without a
  cursor, the first run starts at this boot.
- **If a post fails** (the control plane down, a 5xx, or a 404 from one older than this): the summary
  counts an error (`egress post failed: the cursor stays, the next run retries (HTTP <code>)`), the
  cursor stays, and the next run re-sends the same batch first. The control plane takes a repeated
  batch once (idempotent by host and cursor). Up to 10 batches of 1000 entries per run.
- **A batch refused as malformed** (400 `invalid_request` or `invalid_json`) would fail every retry, so
  it is moved to `/srv/sbx/egress.rejected/<UTC time>-<pid>.json` (0600), the cursor moves past it, and
  the error names the file (`egressRejected` in the summary). Its events are not in any sandbox's log:
  look at the file, and fix the agent or the control plane.
- **A cursor the journal no longer has** (rotated away, or from another machine) is an error
  (`the journal cursor is no longer valid; restarting from this boot`). The old cursor is kept as
  `/srv/sbx/egress.cursor.stale`, and shipping restarts from this boot's first entry. Entries already
  sent are skipped (`egressSkipped`), by `/srv/sbx/egress.mark` (the last sent entry's boot id and
  monotonic time): the control plane's replay check is by cursor, so it could not tell them apart.
  Without a mark, the restart re-sends this boot's entries, which the control plane stores twice; the
  agent says so in an error line (`no position mark`). Entries of an earlier boot that the old cursor
  had not reached are not read.
- **What is kept:** each event exactly as the proxy wrote it, for as long as the sandbox record
  (`SBX_RETENTION_DAYS`). A log holds at most 10,000 events (`EGRESS_LOG_CAP`, about 3 MB), and all
  logs together at most 200,000 (`EGRESS_TOTAL_BUDGET`): with 256 MiB for Redis, egress logs take at
  most about 64 MB. The total counts the logs that still exist, so an expired log gives its share
  back. Each post reads the length of every retained log, so its cost grows with the number of
  sandboxes retained with a log: small at SBX0's scale. Redis refuses writes past its 200 MB
  `maxmemory` (register G45, above), well clear of these.
- **Completeness:** an event over 8 KiB isn't sent (only its sandbox id is). A log's `dropped` counts
  those (`invalid`), events past its cap (`cap`) or past the total budget (`budget`), and the proxy's own `audit_dropped` reports, charged to every sandbox on
  the host's workers live within 60 s before each. `complete` is `dropped == 0`. The sandbox's end
  record (`sandbox`, `state: terminated`) names `egress: {events, sha256, dropped, droppedBy, complete}`; if events
  arrive in the 600 s after the end, a later `sandbox` record with `state: egress` names the final
  log. The grader decides whether an incomplete log still counts.
- **To turn it off** on a host without disabling egress: there is no switch but the unit's state, by
  design. Roll back the host agent instead (`install-host.sh` with the previous tree).

### Credential injection (`--egress`)

Prerequisite for both procedures: set `SBX_EGRESS_CREDENTIALS=1` (and optionally `SBX_EGRESS_HOSTS`)
in `setup.sh`'s env file and run `setup.sh`. That writes `deploy/sbx/.generated/egress/<host id>/`
(`egress.env`, `egress.token`, optional `api-ca.crt`); pass that `<host id>` directory to `--egress`,
not its `egress/` parent. `--egress` generates the host's interception CA once (`/etc/sbx/egress/ca.crt`,
`ca.key`), writes the token (0600) and the drop-in `moca-egress.service.d/sbx-credentials.conf`, then
restarts `moca-egress`. It refuses a host whose `moca-egress.service` it did not install (the P6-owned
unit is configured by its own installer) and a host with no worker yet (the unit comes with the first
worker). `--egress-ca-out` prints the CA path (generating it if absent) and does nothing else. Once the
drop-in exists, a snapshot whose `manifest.json` `egress_ca_sha256` is missing or differs is refused
before systemd is touched.

**Fresh host** (no worker installed):

1. `sudo deploy/sbx/install-host.sh --egress-ca-out` (generates the CA).
2. `deploy/microvm/build-snapshot.sh --egress-ca /etc/sbx/egress/ca.crt --out /srv/sbx/snapshots/<image>`,
   or for a template, `template-build.sh SPEC --egress-ca /etc/sbx/egress/ca.crt ...`
   ([template-onboarding](template-onboarding/ONBOARDING.md)).
3. `sudo deploy/sbx/install-host.sh WORKER_BUNDLE --snapshot <image>`.
4. `sudo deploy/sbx/install-host.sh --egress .generated/egress/<host id>`.

**Existing host** (worker already installed):

1. `sudo deploy/sbx/install-host.sh --egress .generated/egress/<host id>`.
2. `deploy/microvm/build-snapshot.sh --egress-ca /etc/sbx/egress/ca.crt --out /srv/sbx/snapshots/<new image>`.
3. Re-install each worker with `--snapshot <new image>`.

Between `--egress` and the reinstall, users with a stored credential see guest TLS failures on
intercepted hosts, because the old snapshot does not trust the new CA. Do the reinstall promptly. The
same applies to a CA rotation.

The default allowlist (`MOCA_EGRESS_ALLOW`) does not include `api.githubcopilot.com`. Add it to
`/etc/sbx/moca-egress.env` for the `github-mcp` preset, which otherwise gets `403 destination_denied`.

**Turning credential injection off.** Run `install-host.sh --uninstall-egress` on every KVM host
first, then run `setup.sh` with `SBX_EGRESS_CREDENTIALS=0`. With the cluster off, the lookup route is
unmounted (404); a host that still has the drop-in treats the 404 as an error and answers
`503 credential_unavailable` on every allowlisted request, including a plain `git clone` by users with
no credential. The PVC and the `sbx-egress` Secret stay, so a later on-run finds the stored credentials
again. The reverse rule: never run `--egress` against a cluster that is still off.

A re-run keeps the CA. To rotate it, delete `/etc/sbx/egress/ca.crt` and `ca.key`, re-run `--egress`,
then rebuild every snapshot (step 2). `--uninstall-egress` removes the drop-in, token and api CA and
keeps the CA, because existing snapshots were built with it.

## 10. A KVM-host outage

**What users see.** Every sandbox whose template runs on the host fails: `mocactl sbx run` and the
agents' tools report `sandbox failure: … no live worker for sandbox <worker id>`, and
`mocactl sbx doctor` fails its `exec` check. Login, `ls` and `create` still work, because the
control plane runs in the cluster; a new sandbox fails the same way until the host is back.

**What to tell them.** The service is best effort, business hours. Their laptops keep the original
trees, and anything not yet pulled is on the host. If the host comes back with its disk, every
sandbox and its files are as they were (a worker restart keeps workspaces). If the disk is lost,
every sandbox on it is gone: they run `mocactl sbx rm --force` (`rm` cannot check a lost sandbox
for unpulled work, so it refuses without `--force`), then `mocactl sbx up`, and redo the work not
pulled.

**What to check.** `status.sh` (`workers not attached`), then on the host `status.sh --host` and
`journalctl -u sbx-worker@<id>`. A worker that crash-looped into `failed` is brought back by
re-running its `install-host.sh` (it resets the failed state).

## 11. The disk filling up

1. `status.sh --host`: the workspace filesystem line, and the janitor's last run.
2. If the janitor is `skipped` on every run, or its timer is not `active`, nothing is being freed:
   fix that first (§7).
3. If it runs but frees nothing, the disk is live sandboxes: `status.sh`'s `sandboxes live`, and
   `mocactl sbx ls --all` as an admin to see whose. Ask users to `mocactl sbx rm` what they no
   longer need.
4. Lower `SBX_MAX_TOTAL` (and `SBX_MAX_PER_SUBJECT`) and re-run `setup.sh`, so fewer sandboxes can
   exist; existing ones are not affected.

## 12. Uninstalling

On each KVM host:

```bash
sudo <checkout>/deploy/sbx/install-host.sh --uninstall <id>     # each worker
sudo <checkout>/deploy/sbx/install-host.sh --uninstall-janitor
```

They remove exactly what the installs recorded in `/etc/sbx/manifest`; the last worker's uninstall
also removes the shared `sbx-worker@.service` and `sbx.slice`, and the `moca-egress.service` it
installed ([Guest egress](#guest-egress)). Workspace data under `/srv/sbx/workspaces/<id>` and its jail `/srv/sbx/jail/j<12 hex of the id>` (the uninstall names it) is left; remove it by hand.

In the cluster, delete what `setup.sh` applied, then its Secrets and ConfigMaps:

```bash
kubectl delete -k deploy/sbx/.generated
kubectl delete secret -n <namespace> moca-redis moca-relay moca-relay-sandbox-tokens moca-mu1 \
  sbx-token-keys moca-relay-tls sbx-exec-tls --ignore-not-found
kubectl delete configmap -n <namespace> moca-settings sbx-settings --ignore-not-found
rm -rf deploy/sbx/.generated
```

The Redis volume (the StatefulSet's `data` claim, `data-redis-0`) is kept by the delete. Remove it
with `kubectl delete pvc data-redis-0 -n <namespace>` to delete every sandbox record and every
login (the refresh families live there too).

## 13. Live smoke

`deploy/sbx/smoke.sh` runs the spec's live checks (§10.6) against a deployed service. Run it after
a deploy or an upgrade, and once for the 1c acceptance. Without `SBX_LIVE_SMOKE=1` it prints one
`SKIP` line and does nothing. It reads only the environment. It never logs in, never prints a
token, and deletes only the sandboxes it created in that run, even when it fails or is
interrupted.

**Prepare two logins, once.** You need two GitHub accounts, both enrolled (§4), because step 2
checks that one user cannot reach the other's sandbox. Each login lives in its own `HOME`:

```bash
mocactl sbx login --control-plane-url https://<api host>          # user A, in your own HOME
mkdir -p ~/sbx-smoke-b
HOME=~/sbx-smoke-b mocactl sbx login --control-plane-url https://<api host>   # user B
```

Log user B in from a browser session signed in to B's GitHub account (a private window works).
Both logins refresh themselves, so this lasts as long as a login normally does. Leave
`XDG_CONFIG_HOME` and `XDG_STATE_HOME` unset: the smoke runs `mocactl` with them unset.

**Run it:**

```bash
SBX_LIVE_SMOKE=1 SBX_API_URL=https://<api host> \
  SBX_SMOKE_HOME_A="$HOME" SBX_SMOKE_HOME_B=~/sbx-smoke-b \
  SBX_SMOKE_HOST=<host> deploy/sbx/smoke.sh
```

```
ok 1 - round trip: sbx up, run, put, pull --apply on a sample repository
ok 2 - two users: B is refused A's sandbox (404, PERMISSION_DENIED); one req_id from both gets each its own result
ok 3 - a command silent for 5 minutes completes
ok 4 - delete: the mint is refused at once; the kept token is cancelled at exp + leeway, then refused
ok 5 - claude fixes the failing test through mocactl sbx mcp; the tree is unchanged until pull --apply
ok 5 - opencode fixes the failing test through mocactl sbx mcp; the tree is unchanged until pull --apply # SKIP opencode not on PATH
ok 6 - the janitor frees a deleted sandbox's directory
```

It exits 0 when every step is `ok` or skipped, 1 when any step is `not ok` (the line gives the
reason), and 2 on a usage or settings error, before any sandbox is touched. On a failure it keeps its logs and prints their path. A full run takes about 25 minutes without
step 6: step 3 runs a command that is silent for 5 minutes, and step 4 waits for a token to expire
(one token lifetime plus the 30 s leeway). With step 6 it is closer to 70–90 minutes, because step 6
waits out the host's own janitor wait (`setup.sh` keeps it at `max(60, SBX_TOKEN_TTL_MINUTES + 5)`
minutes, so 65 min with 60-minute tokens).

| Variable                                                                 | Default                                      | What it is                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SBX_API_URL`                                                            | (required)                                   | `https://<api host>`                                                                                                                                                                                                                                                                                                                                                   |
| `SBX_SMOKE_HOME_A`, `SBX_SMOKE_HOME_B`                                   | (required)                                   | the two logged-in `HOME`s; they must be two different users                                                                                                                                                                                                                                                                                                            |
| `SBX_SMOKE_GITHUB_TOKEN_FILE`, `SBX_SMOKE_GITHUB_REPO`                   | (unset: step 7 is a SKIP)                    | step 7: a file holding a GitHub PAT (a fine-grained one that can push to the repository; one trailing newline is ignored; never an environment variable) and `OWNER/REPO`                                                                                                                                                                                              |
| `SBX_SMOKE_CRED_TTL`                                                     | `60`                                         | the egress credential cache TTL (`SH_EGRESS_CREDENTIAL_TTL_SECONDS`); step 7 waits this plus 5 s after deleting the credential                                                                                                                                                                                                                                         |
| `SBX_SMOKE_GITHUB_MCP`                                                   | (unset)                                      | `1`: step 7 also checks the `github-mcp` preset (`api.githubcopilot.com` must be in the host's egress allowlist)                                                                                                                                                                                                                                                       |
| `SBX_SMOKE_CRED_TWO_USERS`                                               | (unset)                                      | `1`, with `SBX_SMOKE_HOME_B`: step 7 also checks that user B's sandbox gets a 401 and a public clone works; otherwise that check is a SKIP                                                                                                                                                                                                                             |
| `SBX_SMOKE_TEMPLATE`                                                     | `default`                                    | the template every sandbox is created from                                                                                                                                                                                                                                                                                                                             |
| `SBX_SMOKE_STEPS`                                                        | `1,2,3,4,5,6,7`                              | the steps to run; `1,2,5` leaves out the slow ones                                                                                                                                                                                                                                                                                                                     |
| `SBX_SMOKE_AGENTS`                                                       | `claude,opencode`                            | the agents step 5 runs, headless; one not on `PATH` is a SKIP. Each needs its own login and model configured                                                                                                                                                                                                                                                           |
| `SBX_SMOKE_HOST`                                                         | (unset: step 6 is a SKIP)                    | an ssh target (`[user@]host`) for the template's KVM host, with passwordless `sudo`                                                                                                                                                                                                                                                                                    |
| `SBX_SMOKE_HOST_ENV_DIR`, `SBX_SMOKE_HOST_SRV`, `SBX_SMOKE_HOST_LIBEXEC` | `/etc/sbx`, `/srv/sbx`, `/usr/local/libexec` | that host's `SBX_ENV_DIR`, `SBX_SRV` and `SBX_LIBEXEC_DIR`, if `install-host.sh` was given others                                                                                                                                                                                                                                                                      |
| `SBX_SMOKE_JANITOR_AGE`                                                  | the host's own `SBX_JANITOR_AGE`             | step 6's janitor wait. The one run frees **every** workspace on the host terminated longer ago than this, other users' too, so it can only be lengthened: a value below the host's wait (which `setup.sh` keeps above the token lifetime + 30 s) is refused. Step 6 waits until its own deletion is that old: the host's wait, 65 min by default with 60-minute tokens |
| `MOCACTL`                                                                | (unset: installed from the `edge` channel)   | a `mocactl` to test instead, such as a local build (`packages/mocactl/dist/mocactl.mjs`)                                                                                                                                                                                                                                                                               |
| `SBX_SMOKE_PYTHON`                                                       | `python3`                                    | Python 3.10+ with `grpcio` and `grpcio-tools` (steps 2 and 4 use `docs/api/examples/sandbox_v1_client.py`). It also runs the sample repository's tests locally                                                                                                                                                                                                         |

Step 7 (egress credentials, `SBX_EGRESS_CREDENTIALS=1`) runs alone with only user A's login:

```bash
SBX_LIVE_SMOKE=1 SBX_API_URL=https://<api host> SBX_SMOKE_HOME_A="$HOME" SBX_SMOKE_STEPS=7 \
  SBX_SMOKE_GITHUB_TOKEN_FILE=~/.sbx-smoke-pat SBX_SMOKE_GITHUB_REPO=<owner>/<repo> deploy/sbx/smoke.sh
```

`SBX_SMOKE_HOME_B` stays required for steps 1 to 6. Step 7 prints the PAT nowhere and passes it to
`mocactl` on stdin only; its trap deletes the credentials (`smoke-<ts>-<pid>-gh` and `-gh-mcp`, named
per run so two runs as the same user cannot revoke one another), the remote branch
`sbx-smoke-<ts>` and the sandboxes, even on failure.

What each step does:

1. Creates a sample repository with one failing test, runs `sbx up`, and checks that `sbx run`
   fails the suite. It `sbx put`s the fix and checks that the suite passes in the sandbox, that
   the local tree is unchanged and its suite still fails, and that the local suite passes after
   `sbx pull --apply`.
2. Checks that user B's `sbx token` and `sbx env` for A's sandbox both say `no such sandbox`, and
   that B's token with A's sandbox and workspace key is `PERMISSION_DENIED`. Then A and B each send
   the same `req_id` and the same command at once, each to a sandbox of their own from the same
   template, and each must read its own sandbox's file.
3. Runs `sbx run --timeout 400 -- sh -c 'sleep 300; echo survived'`, which must print `survived`.
4. Mints a token and keeps it, deletes the sandbox, and checks that the next mint is refused
   (`sandbox was deleted`) while the kept token still runs `true`. 20 s before the token's `exp` it
   starts a command that would run past `exp`. That command must be cancelled
   (`DEADLINE_EXCEEDED`) at `exp` plus 30 s. By this machine's clock, anything from 15 to 60 s after
   `exp` passes, to allow for clock skew.
   After that, the token must be refused (`UNAUTHENTICATED`).
5. For each agent, in a fresh sample repository after `sbx up`: `sbx doctor`'s agent-config check
   must pass. Then
   `claude -p "…" --mcp-config .mcp.json --strict-mcp-config` or `opencode run "…"` runs, with the
   smoke's `mocactl` first on `PATH` (logged in as user A) for the `mocactl sbx mcp` it starts. The
   flight recorder must show the agent's calls, and `git status --porcelain` must be the same as
   right after `sbx up`. The local suite must still fail, then pass after `sbx pull --apply`.
6. Deletes a sandbox (step 4's, if that ran), checks that its directory
   `<SBX_SRV>/workspaces/<worker>/<id>` exists on the host, and runs the installed janitor once:
   `ssh <host> sudo -n bash -s`, which sources `janitor.env` and then runs
   `/usr/local/libexec/sbx-janitor.sh` with the host's own `SBX_JANITOR_AGE` (or a longer
   `SBX_SMOKE_JANITOR_AGE`), after waiting until the deletion is that old. The installed timer
   and its settings are not changed. After the run, the directory must be gone.
7. Needs the two GitHub variables, else it is a SKIP. User A stores the PAT
   (`credentials add <run>-gh --preset github`, on stdin from the file). In A's sandbox it clones the
   repository, commits, pushes `sbx-smoke-<ts>` and deletes it, and checks that `gh api user` (or
   `curl`, without `gh`) names the PAT's owner. The placeholder sent from this machine must get a 401.
   User A deletes the credential, the step waits `SBX_SMOKE_CRED_TTL` + 5 s, and the sandbox must get
   a 401. Optionally `github-mcp`, and B's sandbox (401, public clone ok).

What it cannot check for you: the agents' own logs (kept on a failure) show whether an agent
fixed the test by the shortest route, or tried its local tools first and was denied. The
`no network in the guest` claim is not one of its steps (`docs/sbx/security-review.md` §2).

## 14. Checking the templates

`deploy/sbx/templates-check.sh` checks that a client chooses the template its sandbox runs on: the
list, a create of each template, each sandbox's token naming its own template's worker, a command in
each answering on its template's image, a token refused at another template's worker, and `sbx up`
refusing a bound sandbox of another template. Run it after adding or updating a template. Like the
smoke, it reads only the environment, never prints a token, and deletes only the sandboxes it
created; without `SBX_LIVE_CHECK=1` it does nothing.

```bash
SBX_LIVE_CHECK=1 SBX_API_URL=https://<api host> \
  SBX_CHECK_HOME_A=<home A> SBX_CHECK_HOME_B=<home B> SBX_CHECK_TEMPLATES=default,<template> \
  SBX_CHECK_PROBE_<TEMPLATE>='<a command that prints yes only on that template>' \
  deploy/sbx/templates-check.sh
```

The two `HOME`s are two enrolled users' logins (§13, or `mint-login.sh`, §4). Each `SBX_CHECK_PROBE_<ID>`
(the id upper-cased, dashes as underscores) runs in every template's sandboxes: it must print `yes`
in its own template's and anything else in the others'. `SBX_CHECK_EXEC=0` checks the control plane
alone, before any worker is installed. `--help` lists every input and check.

## 15. The template host agent (preview)

> **Preview, not yet installed by `install-host.sh`.** The self-serve template build of the
> [template lifecycle spec](../../docs/specs/2026-11-03-template-lifecycle-and-provenance-design.md)
> §6.1; not proven on a KVM host yet.

`deploy/sbx/host-agent.sh --once` is one poll of a KVM host's agent. It reports what the host holds,
claims queued template builds (clients create them with `POST /v1/templates`), runs
`template-build.sh` on each with its gate record, and reports the result. The control plane
registers or rejects each built build by policy; nobody approves it. It needs:

- on the control plane, the template store and this host's bearer: run `setup.sh` with
  `SBX_TEMPLATE_STORE=1 SBX_TEMPLATE_HOSTS='<host id> ...'`. It adds the store's PVC
  (`moca-sbx-templates`, mounted as `SH_PROVENANCE_DIR`; `SBX_TEMPLATES_FILE` is imported into it
  once), a token per host in the Secret `sbx-template-hosts`, and a bundle per host in
  `.generated/host-agent/<id>/` (`host-agent.env`, `host-agent.token`): copy it to the host as
  `/etc/sbx/host-agent.env` and `/etc/sbx/host-agent.token`, add `SBX_KERNEL` to the env file, and
  delete the copy;
- on the host, `/etc/sbx/host-agent.env` (`SBX_API_URL`, `SBX_HOST_ID`, `SBX_KERNEL`, optionally
  `SBX_DISK_FLOOR_GB`, `SBX_BUILD_CONCURRENCY`, `SBX_ACTIVE_LIMIT`, `SBX_IDLE_LIMIT_S`,
  `SBX_MEM_FLOOR_MIB`, `SBX_MEM_PRESSURE_LIMIT` (see "Memory-aware placement" below),
  `SBX_START_CONCURRENCY`, `SBX_START_WINDOW_S`, `SBX_IDLE_GRACE_S` (see "Cold-start pacing" below), `SBX_REGISTRY`), the token alone in `/etc/sbx/host-agent.token` (0600, root), the script at
  `/usr/local/libexec/sbx-host-agent.sh`, and `sbx-host-agent.service` with its timer. The unit sets
  `SBX_TEMPLATE_BUILD` to the checkout at `/srv/sbx/src` (the agent cannot find it from
  `/usr/local/libexec`) and `REGISTRY_AUTH_FILE=/run/containers/0/auth.json` (it hides root's home):
  log root's podman in with `--authfile /run/containers/0/auth.json`. It also gives Go a home and caches
  under `/srv/sbx` (`build-snapshot.sh` compiles the guest agent): run
  `install -d -m 0700 /srv/sbx/go /srv/sbx/home` first, and seed `/srv/sbx/go/pkg/mod` from root's
  module cache so no build fetches. Do not set `GOFLAGS=-mod=mod`: the repository is a Go workspace,
  which refuses it. Run a poll through the unit
  (`systemctl start sbx-host-agent.service`), not by hand: only the unit loads the env file.

It never claims a build below `SBX_DISK_FLOOR_GB` of free disk (default 60), and it checks a gate
record's bytes against their sha256 before building with it. The token stays in a 0600 header file,
never in argv or the log.

**Nothing that names where an image lives leaves the host** (register G25, G28). A failed build's
reason and its uploaded log are redacted (`SBX_REGISTRY` exactly, then URLs, registry hosts, IPs
and 12-digit account ids); the full log stays on the host in `/srv/sbx/agent-logs/` (0700). The
reason leads with a code a client can branch on: `pull_failed`, `probe_failed`, `disk_floor`,
`spec_refused`, `build_failed`, or `leak_refused` (step `report`): the template record or manifest,
which go byte for byte, names `SBX_REGISTRY`, so the build is reported failed and neither is sent.
Name the image in the spec without its registry; `SBX_REGISTRY` supplies it at the pull.

Each poll also asks the control plane which workers to run and stop (`GET /v1/hosts/{host}/wanted`:
builds leased by clients and placed on this host, within `SBX_ACTIVE_LIMIT`), starts and stops
their `sbx-worker@<id>` units, and reports each start (`attached`), refusal and stop (`detached`). It
never stops a worker with live sandboxes. It also removes what the control plane lists in `remove` (a
retired build, or one an admin rejected): it stops the worker, runs `install-host.sh --uninstall`,
deletes the snapshot and its template record, and reports `removed`; only a build its own template
record matches (the build id and the worker), never a running worker. It starts only **installed** workers: install a new
template's worker as in §5 (its relay token comes from `setup.sh`; the record's id becomes its
`SANDBOX_TEMPLATE`, the label Moca Pi sessions select by); until then the agent reports
it `refused` (register gap G18).

**Memory-aware placement** (register G39,
[memory-aware placement spec](../../docs/specs/2026-11-09-memory-aware-placement-design.md)): each
inventory also reports the host's memory, and the control plane starts a new worker on a host only
if the host has the memory for it, whatever `SBX_ACTIVE_LIMIT` says. `SBX_ACTIVE_LIMIT` stays the
upper bound; it no longer has to be set from a memory calculation by hand. Nothing running is
stopped: the rule only holds back new starts.

- **What the agent reports** (the inventory's `memory` object): `memTotalMib` and `memAvailableMib`
  from `/proc/meminfo`; `memPressureFull10`, the memory PSI line's **`full avg10`** from
  `/proc/pressure/memory` (a percentage: the share of the last 10 s in which every non-idle task
  was stalled on memory); the workers of held builds whose `sbx-worker@<id>` runs; per running
  worker, `vmCommittedMib`, its slice's `memory.current` (`sbx.slice/sbx-<id>.slice`) less its
  pinned memory file (a lower bound while a worker starts: its file's pages may not be charged to
  its slice yet, and MemAvailable then bounds placement); and `memFloorMib`, **the effective floor**, so the number placement uses is in
  the inventory and in `GET /v1/templates`' hosts block (`memory.floorMib`), with no arithmetic.
- **`SBX_MEM_FLOOR_MIB`**: the memory never placed into, a whole number of MiB. Unset, it is 10% of
  MemTotal, at least 4096 (a host of 188.5 GiB: 19302 MiB). Set a fixed amount on a host shared with
  other work (Moca's own P6 sessions).
- **`SBX_MEM_PRESSURE_LIMIT`** (default 10): while `full avg10` is above it, the host takes no new
  start; what it runs is kept. **No `/proc/pressure`** (an older kernel, or `psi=0` at boot): the
  field is left out, which is **no brake**, never "no starts"; the agent's summary says
  `"psi":"absent"` once per run.
- Both live in `host-agent.env` (0600), never in argv. A bad value (a floor of 0, a leading zero, a
  limit that is not a number in (0, 100] with at most two decimals) is refused like the agent's other
  settings: exit 2, before any call.
- **A worker's cost** is its guest's RAM (the registered build's guest size, which registration
  checked against the manifest's `guest_ram_mb`) plus 128 MiB; a build with no recorded guest size
  counts at 4096 + 128. A host's headroom is `min(total − floor − used, available − floor − pending)`,
  `used` being its running workers' cost, their VMs' committed memory and the starts placed there
  but not running yet. The hosts block shows `usedMib` and `headroomMib`.
- **A stale host** (its last inventory over 60 s old: four missed 15 s reports) takes no new start
  (`brake: stale`); one under pressure shows `brake: pressure`.
- **The memory-file check:** for each build it holds, the agent checks that the snapshot's
  `memfile` is exactly `guest_ram_mb × 1 MiB` (the manifest beside it). A worker pins that file
  whole, so a different size (a future Diff snapshot, a balloon, a trimmed file) would make its cost
  wrong. A mismatch is an error line naming the build, a `"memfileMismatch":<n>` count in the
  summary, and the build in the inventory's `memfileMismatch`: the control plane never places it on
  that host, and the agent refuses to start it (reported `refused`). Rebuild the snapshot.
- **A slice it cannot read** (`memory.current` missing): that worker's VMs are left out of
  `vmCommittedMib`, never guessed, and the summary names it (`"sliceUnread":[...]`).
- **What a client sees:** an activation refused for memory is `409 no_active_slot` with
  `reason: memory` and the usual `Retry-After`; at the active limit it answers as before, with no
  reason. A build waiting for memory reads `readiness: unavailable` with `readinessReason: memory`.
- **Version skew, both ways:** an agent older than G39 sends no `memory`, and the control plane
  places that host by `SBX_ACTIVE_LIMIT` alone, as before. A control plane older than G39 (openapi
  1.8.0) ignores the field and places by `SBX_ACTIVE_LIMIT` alone; the agent still refuses to start a
  build whose memory file does not match. Upgrade either first; list both in the rollout.

**Cold-start pacing** (register G43,
[cold-start pacing spec](../../docs/specs/2026-11-09-cold-start-pacing-design.md)): before it
attaches to the relay, a worker reads and locks its whole snapshot memory file, and workers that
start together share the host's disk. So the agent starts at most **`SBX_START_CONCURRENCY`**
workers at once (default 4).

- **What it caps:** workers **starting** (started, not attached yet), not running ones. It is not
  `SBX_ACTIVE_LIMIT`, which caps running workers. Each run starts at most `SBX_START_CONCURRENCY`
  less those still starting, oldest lease first, and leaves the rest for a later run (every 15 s);
  the summary counts them (`"startQueued":<n>`). A run never waits for a start to finish:
  `systemctl start` of the worker unit returns at once.
- **The setting:** a whole number, at least 1, in `host-agent.env` (0600), never in argv. **0 is
  refused** (exit 2, before any call), as is a leading zero or anything that is not a number.
- **Where "starting" comes from:** the control plane's wanted answer lists, in `starting`, the builds
  placed on this host whose worker the relay does not show attached. The limit is the agent's, so it
  holds **with an older control plane too** (openapi before 1.9.0, no `starting`): the agent then
  counts as starting the workers it started less than `SBX_START_WINDOW_S` ago (default 300) that
  are still running and wanted. Its starts are kept in `/srv/sbx/start-times` (0600).
- **What it bounds:** each start's wait, not the total. The disk sets the total. On a
  general-purpose volume of about 125 MB/s, one cold 4 GiB start took about 37 s, and a wave of four
  about 3-4 minutes; 28 cold starts take about 20 minutes at any width. Raise the limit only on a
  faster disk.
- **What the agent reports:** `startConcurrency` and `startSeconds` in the inventory's limits.
  `startSeconds` is the mean of its last 10 cold starts, start to attach, to within the 15 s poll; it
  is absent until a start is done, and always with an older control plane. The hosts block of
  `GET /v1/templates` shows `start: {concurrency, seconds, starting, queued}`.
- **What a client sees:** a build waiting for a start slot is `activating` with `queued: true` and
  its `queuePosition` (1-based, on its host). `409 template_not_active`'s Retry-After becomes
  `ceil(position / concurrency) × startSeconds` once the host has measured a start, else 30 s as
  before. A queued activation stays `activating` longer than before, so **a client polls readiness
  with a timeout sized for a full queue** (for example, 900 s for 28 starts in waves of four).
- **Measure cold starts with the page cache dropped** (`echo 3 > /proc/sys/vm/drop_caches`, or
  after a reboot): a start right after its build, or after a recent stop, reads its memory file from
  the cache and looks much faster than a cold one.
- **Placement prefers a host already running the build's worker** (no start at all), whether or
  not that host reports its memory.
- **The first window after the agent swap is not a regression:** with at most four starts per run, a
  wide activation (say 28 templates at once) takes several 15 s runs to start everything, and a
  client's first Retry-After is the old 30 s until the host has measured a start. Each start's wait is
  bounded; the total is the disk's, as before.
- **The one change on upgrade:** a host whose agent is upgraded, with no new settings and whatever
  its control plane, now starts at most 4 workers per run instead of every wanted one at once.
  A control plane older than 1.9.0 ignores the new inventory fields; an older agent sends none, and
  the control plane then shows no queue and answers Retry-After as before.

**The idle grace** (register G43, openapi 1.10.0): a released worker can stay up for a while, so a
template used again soon is warm (no memory-file read at all).

- **The setting:** `SBX_IDLE_GRACE_S` in `host-agent.env` (0600), never in argv. **Default 0: off**,
  and the host behaves exactly as before: a build with no lease and no live sandbox is stopped at
  the next poll. A whole number of seconds, 0 to 86400, no leading zero; anything else is refused
  (exit 2, before any call). The inventory reports it (`limits.idleGraceSeconds`).
- **When to use it, and how long:** **600-900 s**, long enough to cover a batch's gaps between rounds
  (94 s and 261 s in the Lite-28 window), so a runner can drop its own `KEEP_WARM`. Leave it off where
  each task's cold start is what is measured, or use `stopNow` (below).
- **What it does:** after a build's last lease ends (its release, or the lease running out), the
  control plane keeps it in the wanted answer's `run` until that end plus `SBX_IDLE_GRACE_S`, and
  lists it in `graced`. It is graced only if its worker runs on the host (`runningWorkers`), has no
  live sandbox, and the host has room for it: a slot under `SBX_ACTIVE_LIMIT` and G39's memory
  headroom. The agent never starts a graced build; it only keeps one running. A use within the grace
  finds the worker attached and gets a sandbox at once (first use takes a lease; no `409`).
- **A wanted build that needs the slot** (or the memory) **displaces** the graced worker that ends
  soonest: it goes to `stop`. That is the only stop of a worker nobody asked to stop, and only of one
  with no lease. **At stop time the control plane re-checks that it is still unleased** (under the
  activation lock): a lease taken in between keeps it running. The agent logs such a stop as
  `{"agent":"stopped","worker":"<id>","was":"graced"}`.
- **`stopNow`, to force cold:** `POST /v1/templates/{id}/deactivate {"stopNow": true}` releases the
  caller's lease and, if no lease remains, skips the grace: the worker is stopped at the next poll.
  On a build already in its grace it ends the grace (`released: 0`). The `deactivate` record carries
  `stopNow: true`. Use it for one-by-one comparisons, so each task still measures its cold start.
- **A retire or a reject ends the grace at once:** the build leaves `run`, and on a host with a grace
  the wanted answer lists it in `stop` beside `remove`, so the agent stops the worker and removes the
  build in the same poll. Removal is never held for a grace.
- **What you see:** the agent's summary line gains `"graced":<n>` when it keeps any; the hosts block
  of `GET /v1/templates` shows `idleGraceSeconds` and `graced` (a count) per host with a grace; a
  graced build reads `deactivating` with `graced: true` and `gracedUntil` (epoch seconds).
- **What it costs:** a graced worker still pins its **whole memory file** (it is a running worker).
  G39 counts it in `memory.usedMib`, and it holds a slot of `SBX_ACTIVE_LIMIT` until a wanted build
  needs one. A host over its memory with its graced workers lets the soonest-ending go first.
- **Version skew:** an agent without the setting reports no `idleGraceSeconds`, which the control
  plane takes as 0 (off). A control plane older than 1.10.0 ignores the field, sends no `graced`, and
  stops released workers as before; the agent then just applies `stop`. Upgrade either first.

**Activations without waiting for a build** (register G31): the build poll applies the wanted
state only after its builds, and its timer starts two minutes after the previous poll ends. Install
`sbx-host-agent-wanted.service` and its timer beside the agent's (same env file): every 15 s it
runs `host-agent.sh --wanted-only`, which reports the inventory and starts and stops workers, and
claims and builds nothing. A lock in the script keeps the two from applying the wanted state at
once. `install -m 0644 sbx-host-agent-wanted.{service,timer} /etc/systemd/system/`, then
`systemctl daemon-reload && systemctl enable --now sbx-host-agent-wanted.timer`; remove both in the
host's teardown with the agent's.
