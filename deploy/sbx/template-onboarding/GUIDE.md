# Moca — Template Onboarding Guide

**Last modified:** 2026-11-07T15:16:38Z

> Hand-maintained. Bump the line above when you edit this guide.

This guide takes a container image to a **sandbox template**: a named image that a client, or an
agent session, asks for by id, and whose commands then run in microVMs restored from that image's
snapshot. It walks through two worked examples end to end: Moca's public sandbox image (anyone can
reproduce it) and a SWE-bench instance (the benchmark case it was built for). It was validated on
2026-10-29 and 2026-10-30 against an SBX0 deployment: the control plane and relay on OpenShift, and
the workers on a bare-metal KVM host. Since then the same flow has run self-serve through the API
for the SWE-bench Lite instances on templates, and for two kinds of client (a stock agent and Moca
Pi) on one control plane and one build, with every provenance link exact (2026-11-07, §8).

- **A template is one worker serving one snapshot.** Onboarding is: build a snapshot from the image,
  check it in a real microVM, give it a worker, register it, use it, and retire it when a new
  image replaces it.
- **Everything for templates is in [this folder](README.md):** the tools, the two sample specs,
  their tests, and links to the related files elsewhere.
- The short reference for the same steps is [`deploy/sbx/template-onboarding/ONBOARDING.md`](ONBOARDING.md).
  Deploying SBX0 itself is [`deploy/sbx/README.md`](../README.md) and
  [`RUNBOOK.md`](../RUNBOOK.md); using a sandbox is the
  [user guide](../../../docs/sbx/user-guide.md); templates in Moca's own agent sessions are designed in
  [`2026-10-30-session-sandbox-templates-design.md`](../../../docs/specs/2026-10-30-session-sandbox-templates-design.md).
- **Every host and registry below is a placeholder:** `sbx-api.example.com`, `registry.example.com`.
  No real host, account id or token appears here.

**In a hurry?** §2 is the whole flow on one page; §4 is the public-image example as
copy-pasteable commands; §6 is a client choosing between the two sample templates.

<!-- Regenerate this list: python3 docs/tools/gen_toc.py deploy/sbx/template-onboarding/GUIDE.md -->
<!-- toc -->

**Contents**

- [1. Mental model (read this first)](#1-mental-model-read-this-first)
  - [What a snapshot holds](#what-a-snapshot-holds)
  - [Where things run](#where-things-run)
  - [Names](#names)
- [2. The flow on one page](#2-the-flow-on-one-page)
- [3. The template spec](#3-the-template-spec)
  - [The probe must be shareable](#the-probe-must-be-shareable)
- [4. Example 1: Moca's public sandbox image](#4-example-1-mocas-public-sandbox-image)
  - [4.1 Write the spec](#41-write-the-spec)
  - [4.2 Build and probe on the KVM host](#42-build-and-probe-on-the-kvm-host)
  - [4.3 Register (operator machine)](#43-register-operator-machine)
  - [4.4 Install the worker](#44-install-the-worker)
  - [4.5 Use it](#45-use-it)
- [5. Example 2: a SWE-bench instance (django\_\_django-11133)](#5-example-2-a-swe-bench-instance-django__django-11133)
  - [5.1 The spec comes from image-factory](#51-the-spec-comes-from-image-factory)
  - [5.2 Build, register, install](#52-build-register-install)
  - [5.3 A client: seed first](#53-a-client-seed-first)
  - [5.4 An agent: OpenCode on the template](#54-an-agent-opencode-on-the-template)
- [6. Two templates side by side: the client chooses](#6-two-templates-side-by-side-the-client-chooses)
- [7. Update and retire](#7-update-and-retire)
- [8. Templates in Moca agent sessions](#8-templates-in-moca-agent-sessions)
  - [A session pinned to a build, end to end](#a-session-pinned-to-a-build-end-to-end)
- [9. Capacity](#9-capacity)
- [10. Troubleshooting (what we actually hit)](#10-troubleshooting-what-we-actually-hit)
- [11. Regenerating the documents](#11-regenerating-the-documents)

<!-- /toc -->

---

## 1. Mental model (read this first)

1. **A sandbox runs every command in a fresh microVM** restored from its template's golden
   snapshot, with the sandbox's own `/workspace` attached. Files in `/workspace` persist across
   commands; nothing else does.
2. **One worker (`microvm-worker`) serves one snapshot.** A template is a name for a worker, so a new
   image of a template is a new snapshot and a new worker; the old one drains.
3. **The client chooses the template** when it creates a sandbox (`mocactl sbx create --template ID`,
   `POST /v1/sandboxes {template}`), and a sandbox keeps its worker for life.

### What a snapshot holds

Every template is its own bootable image: there is no common Moca image underneath. What templates
share is Moca's thin boot layer, which `build-snapshot.sh` copies into each snapshot.

| In a snapshot        | Shared by every template?                                                               | Size (a 4 GiB SWE-bench guest)    |
| -------------------- | --------------------------------------------------------------------------------------- | --------------------------------- |
| `kernel`             | yes: the host's one guest kernel (`--kernel`)                                           | ~28 MB                            |
| `agent`              | yes: Moca's guest agent, from `remote-worker`                                           | ~3 MB                             |
| `/sbin/init`         | yes: Moca's init (mounts, `/dev/fd`, `/var` overlay, `HOME`), inside the rootfs         | a few KB                          |
| `rootfs`             | no: an ext4 image of the template's container image (OS, toolchain, repository, `/var`) | 3.5-9 GB                          |
| `memfile`, `vmstate` | no: the guest's RAM and CPU state after it booted                                       | the guest's RAM (4 GiB), a few KB |

So each template costs 7-14 GB of disk, mostly its rootfs and memfile, and disk is what limits how
many templates a host holds (§9). Within one template every VM is restored from the same files by
hardlink and gets only its own workspace disk, so more sandboxes of a template cost little.

### Where things run

| Component              | Runs on                                     | Does                                                                 |
| ---------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `template-build.sh`    | the KVM host, as root                       | image → snapshot, checked in a microVM → a template record           |
| `template-register.sh` | the operator's machine                      | record → SBX0's inputs (`SBX_WORKERS`, the templates file)           |
| `setup.sh`             | the operator's machine, against the cluster | mints the worker's token and bundle; restarts the control plane only |
| `install-host.sh`      | the KVM host, as root                       | installs the worker, which attaches to the relay                     |
| `mocactl sbx`          | anywhere                                    | lists templates, creates sandboxes, runs commands                    |

### Names

For a template id `ID` and an image digest `sha256:abcdef012345…`:

| What      | Name                                               |
| --------- | -------------------------------------------------- |
| snapshot  | `ID-abcdef012345` (the first 12 hex of the digest) |
| worker id | `sbx_<ID with - as _>_abcdef012345`                |
| record    | `$SBX_SRV/templates/<snapshot>.json`               |

## 2. The flow on one page

| #   | Where    | Command                                                           | Check                                                                     |
| --- | -------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | anywhere | write `spec.json` (§3)                                            | `template-build.sh` validates every field first                           |
| 2   | KVM host | `template-build.sh spec.json --kernel K [--registry H]`           | digest, `/etc/hosts`, the probe in a microVM; a failure publishes nothing |
| 3   | operator | `template-register.sh --env-file F record.json`                   | one worker per template; an update keeps the old worker                   |
| 4   | operator | `setup.sh --env-file F`                                           | the control plane rolls; the relay does not                               |
| 5   | KVM host | `install-host.sh BUNDLE --snapshot S --budget-mb N [--no-egress]` | the worker attaches                                                       |
| 6   | client   | `mocactl sbx create --template ID`                                | the sandbox runs on that template's image                                 |
| 7   | both     | new image: steps 1-5 again, then `--retire` the old worker        | its live sandboxes have ended                                             |

## 3. The template spec

A JSON file, schema `moca-sbx-template-spec/1`. Every field is checked before anything runs
([`template-build.sh`](template-build.sh)):

| Field                     | Meaning                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`                      | what clients ask for: `^[a-z0-9][a-z0-9-]{0,30}$`; the same across versions                                             |
| `image`                   | `repository@sha256:<digest>`, never a tag; a repository with no host takes it from `--registry`                         |
| `guest_ram_mb`, `vcpus`   | the guest's size, fixed in the snapshot                                                                                 |
| `guest_home`              | optional, a writable `HOME` under `/tmp` (the rootfs is read-only)                                                      |
| `skip_git_identity_check` | `true` for an image that refuses agent commits on purpose                                                               |
| `guest_home_gitconfig`    | optional, `true`: copy the image's `/root/.gitconfig` into `guest_home`; refused with `skip_git_identity_check`         |
| `egress`                  | `false`: no network at all (`--no-egress`); `true`: the host's allowlisted egress                                       |
| `seed`                    | a bash command that fills a new sandbox's empty `/workspace`, or `""`                                                   |
| `probe`                   | `{cmd, timeout_s, expect_rc, expect[]}`: run after the seed in the restored VM; passes on the exit code and every regex |
| `description`, `tools`    | what clients see in `GET /v1/templates`                                                                                 |
| `etc_hosts_sha256`        | optional: the build stops unless the rootfs's `/etc/hosts` has this hash                                                |

### The probe must be shareable

The probe proves the image's toolchain works in a microVM, not that a task is solvable. For a
benchmark, **use a public test target, never the tests that grade a fix**: their names and counts
are answer-key material. Match the runner's output as it prints it (§10 has two ways this went
wrong).

## 4. Example 1: Moca's public sandbox image

Moca's own sandbox image, `ghcr.io/rossoctl/moca-remote-worker`, is public, so this example needs no
registry key. It is the image SBX0's `default` template ran on 2026-10-29 (built then with
`build-snapshot.sh` directly). On 2026-10-31 this exact spec was built with `template-build.sh`
(with `--egress-ca`, for egress credentials) and its probe passed in the restored VM.

### 4.1 Write the spec

This spec is [`examples/default.json`](examples/default.json) in this folder:

```json
{
  "schema": "moca-sbx-template-spec/1",
  "id": "default",
  "image": "ghcr.io/rossoctl/moca-remote-worker@sha256:eed901b838bf11e16054fccfb38af600a6e61d74dd52907af0750bba13ecbed3",
  "guest_ram_mb": 256,
  "vcpus": 1,
  "egress": true,
  "seed": "",
  "probe": {
    "cmd": "git --version && python3 -c 'print(6*7)' && rg --version | head -1",
    "timeout_s": 120,
    "expect_rc": 0,
    "expect": ["^git version ", "^42$", "^ripgrep "]
  },
  "description": "MOCA's sandbox image: bash, git, Python 3, ripgrep",
  "tools": ["bash", "git", "python3", "rg"]
}
```

`egress: true` gives the guest the host's allowlisted egress (GitHub by default,
[RUNBOOK](../RUNBOOK.md#guest-egress)). Use `false` for a template that must stay offline.

### 4.2 Build and probe on the KVM host

```bash
sudo deploy/sbx/template-onboarding/template-build.sh deploy/sbx/template-onboarding/examples/default.json --kernel /path/to/vmlinux
```

Expected output, ending:

```
build-snapshot.sh: verify command exited 0; the last of its output:
...
template-build: the probe passed
==> built template default: snapshot default-eed901b838bf, worker sbx_default_eed901b838bf
==> record: /srv/sbx/templates/default-eed901b838bf.json (copy it to the operator's machine for deploy/sbx/template-onboarding/template-register.sh)
==> then, after setup.sh: sudo deploy/sbx/install-host.sh <bundle of sbx_default_eed901b838bf> --snapshot default-eed901b838bf --budget-mb <at least 1888>
```

A 256 MiB guest's snapshot is small; a 4 GiB one is about 7.3 GB (§9).

### 4.3 Register (operator machine)

Copy the record over, then:

```bash
deploy/sbx/template-onboarding/template-register.sh --env-file <env file> default-eed901b838bf.json --apply
```

It adds the worker to `SBX_WORKERS` and the template to the templates file, then runs `setup.sh`.
Only the control plane restarts, so running commands on other templates are not interrupted
(on 2026-10-30 the relay's settings hash stayed `1cf8f5032ae16280` across two template changes).

### 4.4 Install the worker

Copy the bundle `deploy/sbx/.generated/workers/sbx_default_eed901b838bf` to the host by path (it
holds a token: never print it), then:

```bash
sudo deploy/sbx/install-host.sh <bundle dir> --snapshot default-eed901b838bf --budget-mb 8192
```

Expected: `sbx-worker@sbx_default_eed901b838bf attached to the relay`. The worker first checks the snapshot against its
manifest and against the template record `template-build.sh` left in `$SBX_SRV/templates/`
(`SH_TEMPLATE_RECORD`); a mismatch stops it at start, naming the field. The record's id also becomes
the worker's `SANDBOX_TEMPLATE`, so Moca agent sessions naming the template find it (section 8).

### 4.5 Use it

```bash
mocactl sbx templates
mocactl sbx create --template default --name try-default
mocactl sbx run -- python3 -c 'print(6*7)'
```

## 5. Example 2: a SWE-bench instance (django\_\_django-11133)

This is exactly what ran on 2026-10-30 (the record is in the project's run notes): a SWE-bench Lite
instance, built, checked in a microVM, registered, used by a client and by an agent, then retired.

### 5.1 The spec comes from image-factory

The result, as it ran, is [`examples/django__django-11133.json`](examples/django__django-11133.json) in
this folder (its image names no registry host; give it with `--registry`).

image-factory's moca-microvm records carry the spec under `template`, so nothing is written by hand.
Its `probe` is a **public** test target (`basic`), not the instance's grading tests, and its image
names no registry host:

```bash
jq '.template' platforms/moca/microvm/django__django-11133.json > django__django-11133.json
cp platforms/moca/microvm/django__django-11133.json django__django-11133.gate-record.json
```

The second file is the image's **gate record**, unchanged: the build checks the image against it
(§5.2). Both are in [`examples/`](examples/).

The fields that matter: `id: django-django-11133` (the instance id lower-cased, `__` → `-`; a
Verified image also in Lite gets `-v`), 4096 MiB and 2 vCPUs, `egress: false`, `seed:
"cp -a /opt/testbed-src/. /workspace/"`, `probe.expect: ["^OK\\b"]` with `expect_rc: 0`, and
`etc_hosts_sha256`.

### 5.2 Build, register, install

```bash
sudo deploy/sbx/template-onboarding/template-build.sh deploy/sbx/template-onboarding/examples/django__django-11133.json --kernel /path/to/vmlinux --registry registry.example.com --gate-record deploy/sbx/template-onboarding/examples/django__django-11133.gate-record.json
```

The spec names its gate record (`source_record_digest`), so the build needs it: before pulling, it
checks the gate passed, the record is for this image, and commits are refused, and the template
record keeps that evidence ([gating rules X10, X12](governance/GATING-RULES.md)). The run below was
on 2026-10-30, before this check existed _(the `--gate-record` form is unverified on a host)_.

As it ran on 2026-10-30 (about 3 minutes, plus the pull):

```
==> etc/hosts as the spec says
build-snapshot.sh: verify command exited 0; the last of its output:
Ran 53 tests in 0.062s
OK (skipped=2)
template-build: the probe passed
==> built template django-django-11133: snapshot django-django-11133-3d3e705ff379, worker sbx_django_django_11133_3d3e705ff379
```

Then §4.3 and §4.4 with that record, and **`--no-egress` with `--budget-mb 13408`**: a 4 GiB guest
needs (4096 + 32) × 3 + 1024 MiB for one session at standby depth 2.

### 5.3 A client: seed first

A new sandbox's `/workspace` is empty. **SBX0 does not run the seed: the client does**, as its first
command. And use `sbx create`, not `sbx up`: `up` pushes the client's own repository into
`/workspace` before the seed runs.

```bash
id=$(mocactl sbx create --template django-django-11133 --json | jq -r .id)
mocactl sbx run --sandbox "$id" -- bash -c 'cp -a /opt/testbed-src/. /workspace/ && git -C /workspace log --oneline -1'
mocactl sbx run --sandbox "$id" -- bash -c 'source /opt/miniconda3/bin/activate && conda activate testbed && cd /testbed && ./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1 basic 2>&1 | tail -3'
```

Expected (2026-10-30): the seed in 1-2 s with a clean tree at `bc34802 baseline`, then
`Ran 53 tests`, `OK (skipped=2)`. The guest has no network (`connect: Network is unreachable`), and a
token for this sandbox is `PERMISSION_DENIED` at any other template's worker.

### 5.4 An agent: OpenCode on the template

Point the agent's MCP server at the seeded sandbox (`mocactl sbx mcp --sandbox <id>`), keeping `sbx
up`'s tools-off block, so the agent works only through the sandbox. On 2026-10-30 a headless
`opencode run` with the instance's problem statement used `sandbox_bash`, `sandbox_read` and
`sandbox_edit` only, finished in 23 s, and its patch was **graded resolved** by the official
SWE-bench harness. Take the patch from the sandbox (`git diff --binary <baseline>` in `/workspace`),
not with `sbx pull`, which diffs against the client's repository.

## 6. Two templates side by side: the client chooses

With both examples onboarded, the deployment serves two templates, each on its own worker. The
templates file that `template-register.sh` wrote holds:

```json
[
  {
    "id": "default",
    "worker": "sbx_default_eed901b838bf",
    "description": "MOCA's sandbox image: bash, git, Python 3, ripgrep",
    "tools": ["bash", "git", "python3", "rg"]
  },
  {
    "id": "django-django-11133",
    "worker": "sbx_django_django_11133_3d3e705ff379",
    "description": "SWE-bench django__django-11133 (lite) at its baseline bc348023edb4; seed with: cp -a /opt/testbed-src/. /workspace/",
    "tools": ["bash", "git", "python3", "rg"]
  }
]
```

**A client lists them, then picks one per sandbox.** The worker ids never reach the client: it sees
only the id, the description and the tools.

```bash
mocactl sbx templates
```

```
default          MOCA's sandbox image: bash, git, Python 3, ripgrep
django-django-11133 SWE-bench django__django-11133 (lite) at its baseline bc348023edb4; seed with: cp -a /opt/testbed-src/. /workspace/
```

(`--json` gives the same list as JSON, with `tools`.)

A sandbox of each, and a command that tells them apart (only the SWE-bench image has the instance's
repository at `/opt/testbed-src`):

```bash
gen=$(mocactl sbx create --template default --name general --json | jq -r .id)
swe=$(mocactl sbx create --template django-django-11133 --name task --json | jq -r .id)
for s in "$gen" "$swe"; do
  mocactl sbx run --sandbox "$s" -- bash -c 'git -C /opt/testbed-src log --oneline -1 2>/dev/null || echo no-testbed'
done
```

Expected:

```
no-testbed
bc34802 baseline
```

The SWE-bench template also has no network (`egress: false`, checked on 2026-10-30:
`connect: Network is unreachable`). `default`'s egress (`egress: true`, through the host's
allowlisting proxy, so `git` and `curl` over HTTPS rather than raw TCP) was checked on 2026-10-31
with SBX0's egress credentials: a second user's sandbox cloned, committed and pushed a branch of a
private repository with its stored PAT, which never entered the sandbox; another user's sandbox got
`401`; deleting the credential revoked it within its cache TTL ([`smoke.sh`](../smoke.sh) step 7).

What SBX0 guarantees, as checked live with two templates on 2026-10-29
([`deploy/sbx/templates-check.sh`](../templates-check.sh), 7 checks, 0 failed):

- the list names every template and **no worker id**;
- each create records the template asked for; an **unknown template is refused** (`no such
template`) and creates nothing;
- each template's sandboxes go to **its own worker**; two sandboxes of one template share the worker
  but **not their workspaces**;
- each sandbox's commands run on **its template's image** (the probe saw each image's digest);
- a token for one template's sandbox sent to the other template's worker is **`PERMISSION_DENIED`**
  at the relay;
- another user cannot see or use the sandbox;
- `sbx up --template` refuses a repository already bound to a sandbox of another template.

The 2026-10-29 run used `default` and an earlier SWE-bench template, `swe-astropy-14995`; the 2026-10-30
run repeated the choice and isolation checks with `django-django-11133` and `astropy-astropy-14995`.
To check a deployment yourself, run `templates-check.sh` against two of its templates
([RUNBOOK §14](../RUNBOOK.md#14-checking-the-templates)).

## 7. Update and retire

A new image for a template: a new spec with the new digest, then build, register and install again.
The record names a new worker; registering moves the template there and **keeps the old worker** so
its live sandboxes keep working. Once none is left:

```bash
deploy/sbx/template-onboarding/template-register.sh --env-file <env file> --retire <old worker id> --apply
sudo deploy/sbx/install-host.sh --uninstall <old worker id>
```

Removing a template entirely is `--remove ID`. On 2026-10-30 retiring `django-django-11133` revoked its
worker's token, a create of it was refused (`no such template`), and an astropy sandbox created
before kept running.

**Self-serve, through the API** (a deployment with the template store and host agents; deployed and
shown end to end on 2026-11-06): the template's owner does it all, with no operator step.

Point `default` at a new build (new creates use it), then retire the old build, or the whole
template:

```bash
mocactl sbx templates tag django-django-11133 default --build sha256:<new build>
mocactl sbx templates retire django-django-11133 --build sha256:<old build>
mocactl sbx templates retire django-django-11133 --reason 'done'
```

A retire is refused while a sandbox or a session still uses the build (`409 build_in_use`): delete
it first. A retired build is never used again (`410 template_retired`), and the host agent then
removes its worker and snapshot. Every step is a record naming who did it. The owner also changes
the description and visibility (`templates edit`); an admin rejects a build after the fact,
transfers a template (`templates transfer`) and sets quotas (`templates quota`).

The host agent's removal keeps each retired build's sandbox and session **workspaces** for the
janitor (`install-host.sh --janitor`), which frees them once their sandboxes have ended. On a host
without the janitor they stay on disk: about a few hundred MB to a GB per template used, so a long
run of retires fills `/srv/sbx` unless the janitor is installed or the workspaces are removed.

A template the deployment declares (`SH_SANDBOX_TEMPLATES`) has no owner, so a subject cannot create
a self-serve template under the same id (`409 template_exists`), and no admin can hand it over yet
(register G34): use another id.

## 8. Templates in Moca agent sessions

Moca's own agent sessions (Moca Pi, P6) can name a template too: `mocactl run --option
sandboxTemplate=ID`. A worker serves a template when `SANDBOX_TEMPLATE` is set; a session with no
template never lands on one; the harness runs the seed once, before the agent's first tool call.
A templated P4 worker is installed beside the main one with `setup-microvm.sh --template ID
--snapshot DIR`; set-up is in [`P4-ON-P6.md`](../../microvm/P4-ON-P6.md#a-templated-p4-worker-session-templates).
Only one worker per host may use guest egress (moca-egress keys VMs by id, which workers share), so
the installer refuses `--egress` beside another worker that uses it.
Checked live on a Moca-VM (P6+P4) on 2026-10-31, with a scripted mock model: a session naming
`django-django-11133` ran on the templated worker with the repository seeded, its second turn kept
the workspace and did not seed again, a session with no template ran on the untemplated worker, and
an unknown template was refused at creation.

On the **combined control plane** (one control plane for both, `setup.sh SBX_PROFILE=combined`), a
session names a self-serve template the same way, and may pin a build (`ID@sha256:…`): it runs only
on that build's workers. Checked on the cluster and the KVM host on 2026-11-05, with no model: a
stock-agent sandbox and a session pinned to the same build, and first use through a session (`409
template_not_active`, then created 23 s later).

### A session pinned to a build, end to end

On a deployment with the template store (the combined control plane, image `87b02d64` or later):

- **The seed is the build's own.** The harness seeds the session's workspace from the pinned build's
  `spec.seed`, the same seed a stock agent's client reads for that build, and reports where it came
  from: `sandbox.seed: {source: "build", buildId: "sha256:…"}` in the turn's result. A client checks
  that `buildId` equals its pin. (`source: "declared"` is a template from `SH_SANDBOX_TEMPLATES`.)
- **The turn returns the patch.** After each turn on a templated session, the result carries
  `workspace: {baseline, patch, patchSha256, patchBytes}`: the whole workspace's diff from the commit
  the seed left (`git diff --cached --binary` on a throwaway index, Moca's own `.moca-*` files left
  out), also on the terminal `done` and `error` frames, so `mocactl run --json` prints it. It is
  never truncated: over `SH_TURN_PATCH_MAX_BYTES` (4 MiB by default) `patch` is left out and
  `patchRefused: "too_large"` says so; a patch that is not UTF-8 comes as `patchBase64`; a failed
  capture is `{error}` and does not fail the turn. Each turn's patch is the whole end state, so a
  client takes the last turn's. Extract it with `jq -j` (shell `$(…)` drops the trailing newline, and
  the checksum then differs).
- **Creating the session for `ID@build`:** today `mocactl run --option sandboxTemplate=` accepts
  only the deployment's declared ids, and refuses `ID@sha256:…` before sending anything (register
  G37). Create the session through the API, then run it:

  ```bash
  curl -sS -X POST -H @<header file with your api token> -H 'Content-Type: application/json' --data '{"sandbox": {"template": "django-django-11133@sha256:<build>"}, "model": "<model id>", "credentials": {"inference": "<name>"}}' https://sbx-api.example.com/v1/sessions
  mocactl run "<prompt>" --session <sessionId> --json
  mocactl sessions delete <sessionId>
  ```

  A first create on an inactive template is `409 template_not_active` with `Retry-After`: retry.
  Without the gateway's host in `SH_MODEL_CATALOG_HOSTS`, the model id is accepted unverified
  (`modelVerified: false`) and `GET /v1/sessions/{id}` shows it.

- **Provenance:** a `session` record at create (its lease's `activate` record and its build) and one
  at delete, on the template's stream, as a sandbox has. A session that is never deleted has no end
  record: delete each session when its work is done (an active pinned session also blocks the
  build's retire).

**Validated on 2026-11-07** (the combined control plane on the cluster, workers on the KVM host, a
real model): on four SWE-bench templates built fresh, a stock agent (OpenCode) on a sandbox and
Moca Pi on a session, both pinned to the same build. Every session was seeded from its build and
returned its patch whole, and an independent composer joined every provenance link of every rep
exactly, for both kinds of client.

## 9. Capacity

Measured on one host (188 GiB, 93 GB free) on 2026-10-31, with SWE-bench templates of 4 GiB guests:

| Limit               | Rule                                                                                                                            | Measured                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| disk, templates     | 7.3-13.6 GB per snapshot; `template-build.sh` wants `SBX_MIN_FREE_GB` (50 by default) free                                      | 8 built in 31 min (140-515 s each, ~70 GB); room for about one more                                     |
| memory per template | each attached worker keeps its snapshot's memory mapped, idle or not                                                            | ~4.1 GiB each                                                                                           |
| disk, sandboxes     | each seeded sandbox's workspace                                                                                                 | 75-240 MB each; 25 sandboxes over 8 templates and 2 users took ~3.5 GB, and disk stopped the test first |
| commands at once    | `--budget-mb` ≥ (guest + 32) × (running VMs) + 1024; a **running** VM is charged its full guest size, a standby its dirty pages | 3 per worker at 13408 MiB; every one at 65536 MiB, with almost no real memory used                      |
| quotas              | `SBX_MAX_PER_SUBJECT`, `SBX_MAX_TOTAL`                                                                                          | deployment settings                                                                                     |
| logins              | a minted login lasts at most 24 h                                                                                               | —                                                                                                       |

So on a host like this, disk limits templates and sandboxes before memory does, and the default
budget allows far fewer commands at once than memory holds: raise `--budget-mb` for parallel runs.

**Size the budget for the work run at once on the template, not for one session.**
`template-build.sh`'s `min_budget_mb`, (guest + 32) × 3 + 1024 (13408 MiB for a 4 GiB guest), fits
about two running VMs plus a standby. Two agents working one template at once, each with
back-to-back commands, then hit admission refusals (`memory-budget: promoting a standby …`, register
G36). Allow one running VM per command that may run at once: **17536 MiB for four 4 GiB VMs**, as
the 2026-11-07 runs used with no refusal. The worker's start-up warning (slots × per-VM size against
the budget) is expected at any budget below its slot count.

**A refused command never ran, and the clients retry it.** `mocactl sbx run` and `sbx put` retry an
Exec the worker or relay refused before it started (`template_busy`, `busy`), with backoff of 1, 2, 4
and 8 s (`MOCACTL_SBX_BUSY_RETRIES`, 4 by default, 0 to turn off), and exit **75** when every try is
refused. The static client (`remote-worker/cmd/sbx`, and its Python twin) does the same within
`SBX_BUSY_RETRY_S` (30 s by default) and logs each refusal. **125** stays for every other sandbox
failure, where the command may have run.

## 10. Troubleshooting (what we actually hit)

| Symptom                                                      | Cause                                                                 | Fix                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `no match for ^Ran 51 tests?\b`, though the tests passed     | an expected count rebuilt from "passed", but `Ran` counts skips       | expect what the runner prints (`^OK\b`, or the `Ran` total)                    |
| `no match for \b8 passed\b`, though pytest passed            | pytest coloured its summary (`ESC[32m8 passed`)                       | fixed in `template-build.sh`: it matches with ANSI stripped                    |
| a probe expectation from the gate's counts                   | the gate counts include grading tests                                 | use a public target (§3)                                                       |
| `git checkout` fails part way as a non-root user             | root-owned files from earlier root builds in the checkout             | `chown -R` the checkout to its user first; check with `find … -not -user …`    |
| a worker restarts and fails                                  | its env names a snapshot no longer on disk                            | point it at one that exists before starting                                    |
| `sbx up` sandbox has the client's repo, not the template's   | `up` pushes the client repository                                     | `sbx create`, then the seed (§5.3)                                             |
| every restore after `vm-9` fails "API socket never appeared" | the jail path overflowed a Unix socket for a 31-character template id | fixed (2026-10-31): jails are keyed by a short hash of the worker id           |
| "no capacity" for minutes, never ending                      | the session's tier or template has no worker attached                 | the retry line (and the harness log) now name the cause; attach a worker of it |
| `memory-budget: promoting a standby would re-price it …`     | the worker's `--budget-mb` fits fewer running VMs than the work needs | size the budget for the commands run at once (§9); clients retry, then exit 75 |
| `unknown sandbox template 'ID@sha256:…'; declared: …`        | mocactl checks `--option sandboxTemplate` against the declared list   | create the session through the API, then `mocactl run --session` (§8)          |
| a session's patch checksum does not match                    | `$(…)` in the shell dropped the patch's trailing newline              | write it with `jq -j '.workspace.patch'` (§8)                                  |
| a self-serve create is `409 template_exists`, nobody owns it | the id is a template the deployment declares                          | use another id (§7; register G34)                                              |

## 11. Regenerating the documents

| Artifact                                   | Generated by                                                            | Source of truth |
| ------------------------------------------ | ----------------------------------------------------------------------- | --------------- |
| this guide's table of contents             | `python3 docs/tools/gen_toc.py deploy/sbx/template-onboarding/GUIDE.md` | the headings    |
| `deploy/sbx/template-onboarding/GUIDE.pdf` | `python3 docs/tools/gen_pdf.py`                                         | this `.md`      |

**If no generator rebuilds it, don't commit it.**
