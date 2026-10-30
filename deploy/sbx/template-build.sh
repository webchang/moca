#!/usr/bin/env bash
# deploy/sbx/template-build.sh -- on the KVM host, turn a container image into an SBX0 template's
# golden snapshot, checked in a microVM before it is published (deploy/sbx/ONBOARDING.md, steps 1-2).
#
#   sudo deploy/sbx/template-build.sh SPEC --kernel PATH [--agent DIR] [--vmm firecracker]
#                                     [--keep-image] [--force]
#
# SPEC is a template spec, JSON (schema moca-sbx-template-spec/1; ONBOARDING.md has the fields):
#   id                       the template id clients ask for, ^[a-z0-9][a-z0-9-]{0,30}$
#   image                    the container image, pinned: repository@sha256:<64 hex>
#   guest_ram_mb, vcpus      the guest's size (build-snapshot.sh --guest-ram-mb, --vcpus)
#   guest_home               optional, a writable HOME under /tmp (build-snapshot.sh --guest-home)
#   skip_git_identity_check  optional, true for an image that refuses agent commits on purpose
#   egress                   true or false: whether the worker gets guest egress (false: --no-egress,
#                            no network at all, e.g. a benchmark whose upstream fix must stay out of
#                            reach)
#   seed                     a bash command that fills a new sandbox's empty /workspace ("" for none).
#                            SBX0 does not run it: the client runs it as its first command
#   probe                    {cmd, timeout_s, expect_rc, expect}: a bash command run after the seed,
#                            in /workspace; it passes when it exits expect_rc and its output matches
#                            every extended regex in expect
#   description, tools       the template's entry, as clients see it (GET /v1/templates)
#
# What it does, each step failing the whole build:
#   1. checks the spec, and that $SBX_SRV has SBX_MIN_FREE_GB free (default 50: a 4 GiB guest's
#      snapshot is 7-11 GB, and the rootfs and image are on top while it builds);
#   2. pulls the image by digest and checks the digest it got;
#   3. deploy/microvm/build-rootfs.sh, then deploy/microvm/build-snapshot.sh with the spec's flags and
#      --verify-command: the seed and the probe, run in the restored VM. A probe that fails publishes
#      nothing;
#   4. writes the template record, $SBX_SRV/templates/<snapshot>.json (schema moca-sbx-template/1): the
#      spec plus the snapshot, its worker id and its manifest hash. deploy/sbx/template-register.sh
#      reads it on the operator's machine; a client may read the seed from it;
#   5. removes the rootfs tree and (unless --keep-image) the pulled image.
#
# Names: the snapshot is <id>-<first 12 hex of the image digest>, and its worker id is
# sbx_<id with - as _>_<the same 12 hex>, so a new image of a template is a new snapshot and a new
# worker (RUNBOOK §5, versioned updates). A snapshot that already exists with the same record is not
# rebuilt; --force rebuilds it.
#
# It touches nothing else: no worker, no unit, no cluster. Installing the worker is
# deploy/sbx/install-host.sh, after template-register.sh and setup.sh (ONBOARDING.md).
#
# Exit: 0 built (or already built); 1 a step failed; 2 a usage or spec error.
set -euo pipefail

SBX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SBX_DIR/../.." && pwd)"
: "${SBX_SRV:=/srv/sbx}"
: "${SBX_MIN_FREE_GB:=50}"
# The two builders, overridable for the tests only.
: "${SBX_BUILD_ROOTFS:=$REPO_ROOT/deploy/microvm/build-rootfs.sh}"
: "${SBX_BUILD_SNAPSHOT:=$REPO_ROOT/deploy/microvm/build-snapshot.sh}"
TEMPLATE_ID_RE='^[a-z0-9][a-z0-9-]{0,30}$'
# install-host.sh's sizing (sbx-worker@.service's standby depth 2, the 1024 MiB reserve, the VMM's
# 32 MiB per VM), so the record can say what --budget-mb one session needs.
STANDBY_DEPTH=2 MEMORY_RESERVE_MB=1024 VM_OVERHEAD_MB=32

log() { printf '==> %s\n' "$*"; }
die() { echo "deploy/sbx/template-build.sh: $*" >&2; exit 1; }
usage() {
  echo 'usage: template-build.sh SPEC --kernel PATH [--agent DIR] [--vmm firecracker|cloud-hypervisor] [--keep-image] [--force]' >&2
  exit 2
}
spec_error() { echo "deploy/sbx/template-build.sh: $SPEC: $*" >&2; exit 2; }

SPEC='' KERNEL='' AGENT="$REPO_ROOT/remote-worker" VMM=firecracker KEEP_IMAGE='' FORCE=''
while (($#)); do
  case "$1" in
  --kernel) [[ $# -ge 2 ]] || usage; KERNEL="$2"; shift 2 ;;
  --agent) [[ $# -ge 2 ]] || usage; AGENT="$2"; shift 2 ;;
  --vmm) [[ $# -ge 2 ]] || usage; VMM="$2"; shift 2 ;;
  --keep-image) KEEP_IMAGE=1; shift ;;
  --force) FORCE=1; shift ;;
  -h | --help) usage ;;
  -*) echo "template-build.sh: unknown argument $1" >&2; usage ;;
  *) [[ -z "$SPEC" ]] || usage; SPEC="$1"; shift ;;
  esac
done
[[ -n "$SPEC" && -n "$KERNEL" ]] || usage
[[ -f "$SPEC" ]] || { echo "template-build.sh: no spec file $SPEC" >&2; exit 2; }
[[ "$VMM" == firecracker || "$VMM" == cloud-hypervisor ]] || usage
command -v jq >/dev/null || die 'needs jq'

# 1. The spec. Every field is checked here, before anything is pulled or built.
jq -e 'type == "object"' "$SPEC" >/dev/null 2>&1 || spec_error 'is not a JSON object'
field() { jq -r --arg k "$1" '.[$k] // empty | tostring' "$SPEC"; }
ID="$(field id)"
[[ "$ID" =~ $TEMPLATE_ID_RE ]] || spec_error "id '$ID' must match $TEMPLATE_ID_RE"
IMAGE="$(field image)"
[[ "$IMAGE" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] || spec_error "image must be pinned as repository@sha256:<64 hex>, got '$IMAGE'"
DIGEST="${IMAGE##*@}"
RAM="$(field guest_ram_mb)" VCPUS="$(field vcpus)"
[[ "$RAM" =~ ^[1-9][0-9]*$ ]] && ((RAM >= 128)) || spec_error "guest_ram_mb must be a whole number of MiB, at least 128, got '$RAM'"
[[ "$VCPUS" =~ ^([1-9]|[12][0-9]|3[0-2])$ ]] || spec_error "vcpus must be 1-32, got '$VCPUS'"
GUEST_HOME="$(field guest_home)"
[[ -z "$GUEST_HOME" || "$GUEST_HOME" =~ ^/tmp(/[A-Za-z0-9._-]+)+$ ]] || spec_error "guest_home must be a path under /tmp, got '$GUEST_HOME'"
jq -e '(.skip_git_identity_check // false | type) == "boolean"' "$SPEC" >/dev/null || spec_error 'skip_git_identity_check must be true or false'
jq -e '(.egress | type) == "boolean"' "$SPEC" >/dev/null || spec_error 'egress must be true or false (false: the worker is installed with --no-egress)'
jq -e '(.seed | type) == "string"' "$SPEC" >/dev/null || spec_error 'seed must be a string ("" for none)'
jq -e '(.probe | type) == "object" and (.probe.cmd | type) == "string" and (.probe.cmd | length) > 0
  and (.probe.expect_rc | type) == "number" and (.probe.expect_rc | floor) == .probe.expect_rc
  and .probe.expect_rc >= 0 and .probe.expect_rc <= 255
  and (.probe.timeout_s | type) == "number" and .probe.timeout_s >= 1 and .probe.timeout_s <= 86400
  and (.probe.expect // [] | type) == "array" and all(.probe.expect // [] | .[]; type == "string" and length > 0)' \
  "$SPEC" >/dev/null || spec_error 'probe must be {cmd (non-empty), timeout_s (1-86400), expect_rc (0-255), expect: [extended regexes]}'
jq -e '(.description | type) == "string" and (.description | length) > 0
  and (.tools | type) == "array" and all(.tools[]; type == "string") and (.tools | unique | length) == (.tools | length)' \
  "$SPEC" >/dev/null || spec_error 'description must be a non-empty string and tools a list of distinct strings'
for re in $(jq -r '.probe.expect // [] | .[] | @base64' "$SPEC"); do
  re="$(printf '%s' "$re" | base64 --decode)"
  rc=0; printf '' | grep -Eq -- "$re" 2>/dev/null || rc=$?
  ((rc <= 1)) || spec_error "probe.expect has an invalid extended regex: $re"
done

TAG12="${DIGEST#sha256:}"; TAG12="${TAG12:0:12}"
NAME="$ID-$TAG12"
WORKER="sbx_${ID//-/_}_$TAG12"
OUT="$SBX_SRV/snapshots/$NAME"
RECORD="$SBX_SRV/templates/$NAME.json"
BUDGET_MIN=$(((RAM + VM_OVERHEAD_MB) * (1 + STANDBY_DEPTH) + MEMORY_RESERVE_MB))

# The command the restored VM runs (build-snapshot.sh --verify-command): in /workspace, the seed,
# then the probe with its output in a log, its exit code and its patterns checked in the guest, so
# the build passes only on the expected result (an instance whose baseline fails tests exits
# nonzero). Each part is quoted with printf %q for the guest's bash.
verify_command() {
  local seed cmd want re
  seed="$(jq -r '.seed' "$SPEC")"
  cmd="$(jq -r '.probe.cmd' "$SPEC")"
  want="$(jq -r '.probe.expect_rc' "$SPEC")"
  if [[ -n "$seed" ]]; then
    printf 'bash -c %q || { echo "template-build: the seed failed ($?)"; exit 90; }\n' "$seed"
  fi
  printf 'bash -c %q >/tmp/.template-probe.log 2>&1; rc=$?\n' "$cmd"
  printf '%s\n' 'tail -c 12288 /tmp/.template-probe.log' 'echo "template-build: the probe exited $rc"'
  printf '[ "$rc" = %q ] || { echo "template-build: want exit %s"; exit 91; }\n' "$want" "$want"
  for re in $(jq -r '.probe.expect // [] | .[] | @base64' "$SPEC"); do
    re="$(printf '%s' "$re" | base64 --decode)"
    printf 'grep -Eq -- %q /tmp/.template-probe.log || { echo %q; exit 92; }\n' "$re" "template-build: no match for $re"
  done
  printf '%s\n' 'echo "template-build: the probe passed"'
}

# The record, from the spec and the built manifest: everything template-register.sh needs, and the
# seed a client runs. No secret is in either.
write_record() {
  local hash built
  hash="$(jq -r '.hash' "$OUT/manifest.json")"
  built="$(jq -r '.built_at // empty' "$OUT/manifest.json")"
  mkdir -p "$SBX_SRV/templates"
  jq -S --arg snapshot "$NAME" --arg worker "$WORKER" --arg hash "$hash" --arg built "$built" \
    --argjson budget "$BUDGET_MIN" \
    '{schema: "moca-sbx-template/1", id, worker: $worker, snapshot: $snapshot, image, guest_ram_mb,
      vcpus, egress, seed, probe, description, tools, manifest_hash: $hash, built_at: $built,
      min_budget_mb: $budget}' "$SPEC" >"$RECORD.tmp"
  mv "$RECORD.tmp" "$RECORD"
}

# The spec's part of a record, for "already built": the same spec on the same snapshot.
spec_key() { jq -S '{id, image, guest_ram_mb, vcpus, egress, seed, probe, description, tools}' "$1"; }

[[ -n "${SBX_SKIP_ROOT_CHECK:-}" || "$(id -u)" == 0 ]] || die 'must run as root (build-rootfs.sh and build-snapshot.sh do)'
[[ -f "$KERNEL" ]] || die "no kernel at $KERNEL"
[[ -d "$AGENT" ]] || die "no guest agent source at $AGENT (the remote-worker module)"

if [[ -z "$FORCE" && -f "$OUT/manifest.json" && -f "$RECORD" ]] &&
  [[ "$(spec_key "$SPEC")" == "$(spec_key "$RECORD")" ]] &&
  [[ "$(jq -r .manifest_hash "$RECORD")" == "$(jq -r .hash "$OUT/manifest.json")" ]]; then
  log "already built: snapshot $NAME, record $RECORD (--force rebuilds)"
  exit 0
fi

mkdir -p "$SBX_SRV/snapshots"
free_kb="$(df -Pk "$SBX_SRV/snapshots" | awk 'NR == 2 {print $4}')"
[[ "$free_kb" =~ ^[0-9]+$ ]] || die "could not read the free space of $SBX_SRV/snapshots"
((free_kb >= SBX_MIN_FREE_GB * 1024 * 1024)) ||
  die "$SBX_SRV/snapshots has $((free_kb / 1024 / 1024)) GiB free; a build needs $SBX_MIN_FREE_GB (SBX_MIN_FREE_GB). Drop an unused snapshot first."

BUILD="$SBX_SRV/build/$NAME"
cleanup() {
  rm -rf "$BUILD"
  [[ -n "$KEEP_IMAGE" || -z "${PULLED:-}" ]] || podman rmi "$IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 2. The image, by digest. podman resolves a digest reference to exactly that manifest; the check
# makes a registry or a local tag that says otherwise fail here, not in a sandbox.
log "pulling $IMAGE"
PULLED=''
podman image exists "$IMAGE" || { podman pull "$IMAGE" >/dev/null && PULLED=1; }
got="$(podman image inspect --format '{{.Digest}}' "$IMAGE")"
[[ "$got" == "$DIGEST" ]] || die "pulled $IMAGE but its digest is $got"

# 3. The rootfs and the snapshot, with the seed and the probe as the verify step.
rm -rf "$BUILD"
mkdir -p "$BUILD"
log "building the rootfs of $NAME"
"$SBX_BUILD_ROOTFS" --out "$BUILD/rootfs" --image "$IMAGE"
args=(--kernel "$KERNEL" --rootfs "$BUILD/rootfs" --agent "$AGENT" --image "$NAME" --vmm "$VMM"
  --guest-ram-mb "$RAM" --vcpus "$VCPUS" --out "$OUT"
  --verify-command "$(verify_command)" --verify-timeout-s "$(jq -r '.probe.timeout_s' "$SPEC")")
[[ -z "$GUEST_HOME" ]] || args+=(--guest-home "$GUEST_HOME")
[[ "$(jq -r '.skip_git_identity_check // false' "$SPEC")" != true ]] || args+=(--skip-git-identity-check)
log "building and checking the snapshot $NAME (the probe runs in the restored VM)"
"$SBX_BUILD_SNAPSHOT" "${args[@]}"
[[ -f "$OUT/manifest.json" ]] || die "build-snapshot.sh left no $OUT/manifest.json"

# 4. The record.
write_record
egress_flag=''
[[ "$(jq -r .egress "$SPEC")" == true ]] || egress_flag=' --no-egress'
log "built template $ID: snapshot $NAME, worker $WORKER"
log "record: $RECORD (copy it to the operator's machine for deploy/sbx/template-register.sh)"
log "then, after setup.sh: sudo deploy/sbx/install-host.sh <bundle of $WORKER> --snapshot $NAME --budget-mb <at least $BUDGET_MIN>$egress_flag"
