# Moca's existing rules for sandbox images and microVM templates: inventory (2026-11-02)

From sbx-template, read-only, on branch sbx-template at 22e19036. A snapshot in time, not kept current:
the living rules are [`GATING-RULES.md`](GATING-RULES.md). Input for image-factory, which owns Moca's
gating rules (the user, 2026-11-02). Paths are relative to the Moca repository.

## 1. Image rules

| Rule                                                                             | Where                                                                                | On violation          | Tier                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------- | ---------------------------- |
| Worker capability tools present (bash, rg, base64, file, python3, git, gh)       | `remote-worker/cmd/worker/main.go:40`; `cmd/worker/dockerfile_parity_test.go:114`    | CI test fails         | container                    |
| tar, gzip, flock (config overlay), curl, ca-certificates                         | `dockerfile_parity_test.go:167`, `research_tooling_test.go:46`; `Dockerfile:135-148` | CI test fails         | container (microVM inherits) |
| `Dockerfile` and `Dockerfile.runtime` install the same packages and `/workspace` | `dockerfile_parity_test.go:183,225`                                                  | CI test fails         | container                    |
| `/workspace` 1001:0 775, WORKDIR; `USER 1001`                                    | `Dockerfile:169-170,189`                                                             | documented only       | container                    |
| `HOME=/home/sandbox` 1001:0 775                                                  | `Dockerfile:176-177`; `research_tooling_test.go:59`                                  | CI test fails         | container                    |
| System git identity in `/etc/gitconfig`, a commit succeeds (#415)                | `Dockerfile:187`; `research_tooling_test.go:88,120`                                  | CI test fails         | container                    |
| Vendored rg and gh pinned by version and sha256                                  | `Dockerfile:55-75,90-110`                                                            | build fails           | container                    |
| Base `ubi9/ubi-minimal:latest`, deliberately unpinned                            | `Dockerfile:118-122`                                                                 | documented exception  | container                    |
| Rootfs export as root, never merged into an existing tree                        | `deploy/microvm/build-rootfs.sh:47-57`                                               | refused               | microVM                      |
| Image re-pulled each build (#414); `SH_SKIP_PULL` with no local copy fatal       | `build-rootfs.sh:69-81`                                                              | refused               | microVM                      |
| Required tools: bash git rg gh python3 base64 file ls cat                        | `build-rootfs.sh:30,91-104`                                                          | refused, tree removed | microVM                      |
| The image's `remote-worker` binary stripped from the rootfs                      | `build-rootfs.sh:108`                                                                | silent                | microVM                      |
| Curated templates carry bash, git, tar, ripgrep, toolchain, "pinned by hash"     | SBX0 spec `docs/specs/2026-10-15-...:715-722,494`                                    | documented only       | microVM                      |
| Commands run under `bash -c`                                                     | `deploy/sbx/template-onboarding/ONBOARDING.md:81`                                    | documented            | both                         |
| Seeds safe to re-run; no `flock` = unlocked seed                                 | `docs/specs/2026-10-30-session-sandbox-templates-design.md:131-135`                  | documented            | both                         |

## 2. Snapshot and template rules

**build-snapshot.sh** (exit 2 = usage, exit 1 = check): `--egress-ca` one public X.509 cert, no private
key (`:267-287`); `--vmm` firecracker|cloud-hypervisor (`:295`); `--guest-home` under `/tmp` (`:305`);
`--vcpus` 1-32 (`:310`); `--verify-timeout-s` 1-86400 (`:315`); host preflight: `/dev/kvm`, cgroup v2, no
swap, kernel >= 5.18 (`:513-604`); no writes through image symlinks (`:689-702`); HOME line lands in
init (`:805`); CA tooling present (`:643,661`); static guest agent from `cmd/guest-agent` (`:611-619`).
In-guest checks before the snapshot (`:1749-1752`, `:1925-1928`): `check_git_identity` (`:1114`, skipped
only with `--skip-git-identity-check`), `check_egress_listener` (`:1141`), `check_dev_fd` (`:1160`),
`check_var` (`:1180`). Capabilities measured in the guest (`:1073`). Only an inert credential
placeholder in the guest (`:773,819-823`). Sealed root-owned 0444/0555 in a pending dir (`:2028`);
verify restore (`true` or `--verify-command`) before publishing by rename (`:2059`).

**Manifest:** image, vmm, instance_type, kernel_release, guest_ram_mb, vcpus, capabilities, built_at,
kernel/rootfs/agent sha256, hash; `egress_ca_sha256` outside the hash (`build-snapshot.sh:1968-2011`).
`hash` covers the kernel, rootfs and agent digests, not vmstate or memfile
(`remote-worker/internal/vmpool/snapshot.go:47-50,73`).

**Worker start** (`remote-worker/cmd/microvm-worker/main.go:620-698`, all fatal): `Manifest.Verify`
(`snapshot.go:98`); `verifyInstanceType` (`main.go:456`, override `SH_ALLOW_INSTANCE_TYPE_MISMATCH`,
fails open); memfile mlock (`pin_linux.go:23`); a startup probe restore running `true` (`snapshot.go:162`).

**install-host.sh**: plain snapshot name that exists (`:455-456`); `--budget-mb` > 1024 (`:457`); budget

> = (guest+32) x 3 + 1024 (`check_snapshot_ram`, `:303`); with egress credentials, `egress_ca_sha256` =
> host CA (`check_snapshot_ca`, `:313`); the same for installed workers is a warning (`:379`).

**template-build.sh** (spec errors exit 2): id `^[a-z0-9][a-z0-9-]{0,30}$` (`:109`); image
`repo@sha256:<64>` (`:111`); guest_ram_mb >= 128, vcpus 1-32 (`:121-122`); guest_home under /tmp
(`:124`); booleans typed (`:125-126`); `guest_home_gitconfig` needs guest_home, refused with
`skip_git_identity_check` (`:127-131`); egress boolean, `--egress-ca` only with egress true (`:132-134`);
seed a string, probe shape and regexes valid (`:135-149`); description and distinct tools (`:142`);
`probe_status` unmeasured/none refused (`:150`); `etc_hosts_sha256` 64 hex (`:154`). Build: CA no private
key (`:216-218`); `SBX_MIN_FREE_GB` (`:231-234`); pulled digest = spec (`:249`); rootfs `/etc/hosts` sha
(`:256-258`); seed + probe as `--verify-command` (`:167`); manifest CA = CA (`:271`); names from the
digest (`:156-160`); record `moca-sbx-template/1` with `manifest_hash` (`:190`). Probe on public targets
only: documented (`ONBOARDING.md:77`, `template-build.sh:38`).

**template-register.sh**: record schema `moca-sbx-template/1` (`:97`); a worker serves one template (`:101`).

## 3. Provenance already recorded

`/etc/moca-rootfs-source` in the rootfs: `image=`, `digest=` (`build-rootfs.sh:111`). The manifest (above).
The template record: pinned `image@sha256`, `manifest_hash`, `built_at`, `egress_ca_sha256`. image-factory's
extra spec fields (`source_record_digest`, `proved_in_vm`) are carried but ignored, never verified.
Vendored rg/gh by sha256. **No signing, SBOM, attestation or registry allowlist for sandbox images.**

## 4. Gaps

1. The default image is a mutable `:latest` tag for `build-rootfs.sh` and the container tier of P6 (the process-manager runtime)
   (`setup-microvm.sh:259`, `deploy/k8s/setup.sh:353`); only template-build requires a digest.
2. The Dockerfile base is unpinned `:latest`.
3. The pulled digest is checked at pull time only; no signature or origin check; `--registry` takes any host.
4. `manifest.json` is not authenticated: capabilities, image, instance_type, guest_ram_mb, vcpus and
   `egress_ca_sha256` are outside `hash`; the Go `Manifest` has no vcpus or `egress_ca_sha256` field.
5. vmstate and memfile are not hashed (documented choice).
6. The instance-type check fails open and has an env override.
7. Worker start does not cross-check the record's `manifest_hash` nor the image digest in
   `/etc/moca-rootfs-source`; the record is unsigned.
8. The container tier gates nothing at run time (capabilities probed from PATH, no digest check).
9. The "bash, git, tar, ripgrep" template rule is enforced via `build-rootfs.sh`'s tool list, which
   omits tar and includes gh.
10. `--guest-ram-mb` has no bound in build-snapshot.sh; `--skip-git-identity-check` records no reason.
11. No scan for secrets or keys in the image, setuid, size, vulnerabilities, or an SBOM.
12. The probe is not re-run after deployment (the startup probe runs `true`); "probe is shareable" is unenforced.
