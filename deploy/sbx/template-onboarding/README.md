# MOCA template onboarding

The all-in-one place for **sandbox templates**: what they are, how to create and onboard one from a
container image, how to check it, and how clients and agents use it. A template is a named image
that a client asks for by id; its commands then run in microVMs restored from that image's snapshot.

Start with the [Template Onboarding Guide](GUIDE.md) ([PDF](GUIDE.pdf)). It walks through the
whole flow with two sample templates and a client choosing between them.

## In this folder

| File                                                                       | What it is                                                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [`GUIDE.md`](GUIDE.md), [`GUIDE.pdf`](GUIDE.pdf)                           | the guide: mental model, the flow, two worked examples, update and retire, capacity, troubleshooting                                 |
| [`ONBOARDING.md`](ONBOARDING.md)                                           | the short reference: the steps, the spec's fields, the tools' options                                                                |
| [`template-build.sh`](template-build.sh)                                   | **KVM host, root:** spec → pull by digest → rootfs → snapshot, the probe run in a restored microVM → a template record               |
| [`template-register.sh`](template-register.sh)                             | **operator machine:** record → `SBX_WORKERS` and the templates file (add, versioned update, `--retire`, `--remove`), then `setup.sh` |
| [`examples/default.json`](examples/default.json)                           | sample spec 1: MOCA's public sandbox image (`ghcr.io/rossoctl/moca-remote-worker`, pinned), template `default`                       |
| [`examples/django__django-11133.json`](examples/django__django-11133.json) | sample spec 2: a SWE-bench instance (image-factory's spec block, host-free image), template `django-django-11133`                    |
| [`tests/`](tests/)                                                         | `template-build.test.sh`, `template-register.test.sh`, and `examples.test.sh` (every sample passes the spec check)                   |

## Related files elsewhere in the repository

These are part of the same flow but live with the code they belong to.

**SBX0, the sandbox service the templates run on** (`deploy/sbx/`):

| File                                             | Role in the flow                                                                                                                                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`../setup.sh`](../setup.sh)                     | the cluster side: mints each worker's token and bundle; a template change restarts the control plane only                                                                                                |
| [`../install-host.sh`](../install-host.sh)       | the KVM host: installs (or `--uninstall`s) a template's worker                                                                                                                                           |
| [`../templates-check.sh`](../templates-check.sh) | the live check that a client gets the template it asked for, and that templates are isolated                                                                                                             |
| [`../mint-login.sh`](../mint-login.sh)           | a test login for a deployment without a GitHub OAuth app                                                                                                                                                 |
| [`../README.md`](../README.md)                   | installing SBX0                                                                                                                                                                                          |
| [`../RUNBOOK.md`](../RUNBOOK.md)                 | operating it: [§5 templates](../RUNBOOK.md#5-adding-updating-and-removing-a-template), [guest egress](../RUNBOOK.md#guest-egress), [§14 checking the templates](../RUNBOOK.md#14-checking-the-templates) |
| [`../tests/`](../tests/)                         | `templates-check.test.sh`, `mint-login.test.sh`, `install-host.test.sh`, `setup.test.sh`                                                                                                                 |

**Snapshots** (`deploy/microvm/`):

| File                                                                 | Role in the flow                                                                                                                             |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [`../../microvm/build-rootfs.sh`](../../microvm/build-rootfs.sh)     | image → rootfs tree (called by `template-build.sh`)                                                                                          |
| [`../../microvm/build-snapshot.sh`](../../microvm/build-snapshot.sh) | rootfs → golden snapshot; `--verify-command` runs the probe (called by `template-build.sh`)                                                  |
| [`../../microvm/P4-ON-P6.md`](../../microvm/P4-ON-P6.md)             | building snapshots by hand, and [a templated P4 worker for MOCA sessions](../../microvm/P4-ON-P6.md#a-templated-p4-worker-session-templates) |
| [`../../microvm/setup-microvm.sh`](../../microvm/setup-microvm.sh)   | MOCA-VM (P6+P4): `--template ID --snapshot DIR` installs a templated P4 worker for MOCA sessions; `--uninstall-template ID` removes it       |

**Using a template:**

| File                                                                                                                                      | Role in the flow                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`docs/sbx/user-guide.md`](../../../docs/sbx/user-guide.md)                                                                               | clients: `mocactl sbx templates`, `create --template`, `run`, agents through `mocactl sbx mcp` |
| [`docs/concepts/sandboxes-and-tiers.md`](../../../docs/concepts/sandboxes-and-tiers.md)                                                   | templates and tiers in MOCA's own agent sessions (`--option sandboxTemplate=ID`)               |
| [`docs/specs/2026-10-30-session-sandbox-templates-design.md`](../../../docs/specs/2026-10-30-session-sandbox-templates-design.md)         | the design of templates in agent sessions                                                      |
| [`docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md`](../../../docs/specs/2026-10-15-sbx0-internal-sandbox-service-design.md) | the design of SBX0 and its templates                                                           |

**Code that implements template selection:** `packages/control-plane/src/sandbox-config.ts`
(`SH_SANDBOX_TEMPLATES`), `packages/control-plane/src/sandbox-handlers.ts` (`POST /v1/sandboxes
{template}`), `harness/src/select-sandbox.ts` (a session's template), and
`remote-worker/internal/session/labels.go` (a worker's `SANDBOX_TEMPLATE`).

**Regenerating the guide:** `python3 docs/tools/gen_toc.py deploy/sbx/template-onboarding/GUIDE.md`
for its table of contents, and `python3 docs/tools/gen_pdf.py` for its PDF
([`docs/tools/`](../../../docs/tools/)).

## The flow in brief

```bash
# 1. KVM host: build and check (the spec says image, size, egress, seed, probe)
sudo deploy/sbx/template-onboarding/template-build.sh deploy/sbx/template-onboarding/examples/default.json --kernel /path/to/vmlinux

# 2. operator machine: register (with the record copied from the host), then setup.sh
deploy/sbx/template-onboarding/template-register.sh --env-file <env file> default-eed901b838bf.json --apply

# 3. KVM host: install the worker from its bundle
sudo deploy/sbx/install-host.sh <bundle dir> --snapshot default-eed901b838bf --budget-mb 8192

# 4. client: choose it
mocactl sbx templates
mocactl sbx create --template default
```
