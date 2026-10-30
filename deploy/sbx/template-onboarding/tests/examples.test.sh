#!/usr/bin/env bash
# Tests for deploy/sbx/template-onboarding/examples/: every sample spec passes template-build.sh's own
# spec check (run up to the pull, with podman and df mocked: no image is pulled, nothing is built), so
# a sample can never drift from what the tool accepts, and names the snapshot and worker the guide shows.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
TPL="$SRC/deploy/sbx/template-onboarding"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2; exit 1; }
pass() { echo "ok - $*"; }
mkdir -p "$TMP/bin" "$TMP/agent"
: >"$TMP/vmlinux"
# podman: the pull is where the check ends, so any pull fails and nothing beyond it runs.
cat >"$TMP/bin/podman" <<'MOCK'
#!/usr/bin/env bash
case "$1 $2" in 'image exists') exit 1 ;; esac
[[ "$1" == pull ]] && { echo "podman-pull $2" >&2; exit 42; }
exit 0
MOCK
cat >"$TMP/bin/df" <<'MOCK'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 1 1 %s 1%% /srv\n' $((500 * 1024 * 1024))
MOCK
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:$PATH" SBX_SRV="$TMP/srv" SBX_SKIP_ROOT_CHECK=1

# check SPEC SNAPSHOT: the spec passes every field check (the run reaches the pull, never exit 2),
# and the pull is of the spec's pinned image.
check() {
  local spec="$1" want="$2" rc=0
  bash "$TPL/template-build.sh" "$spec" --kernel "$TMP/vmlinux" --agent "$TMP/agent" \
    --registry registry.example.com >"$TMP/out" 2>&1 || rc=$?
  [[ "$rc" != 2 ]] || fail "$(basename "$spec") was refused as a spec"
  grep -q '^podman-pull ' "$TMP/out" || fail "$(basename "$spec") did not reach the pull"
  grep -q "^podman-pull .*@$(jq -r '.image | split("@")[1]' "$spec")\$" "$TMP/out" ||
    fail "$(basename "$spec") pulled another image"
  [[ "$(jq -r .id "$spec")-$(jq -r '.image | split("sha256:")[1][0:12]' "$spec")" == "$want" ]] ||
    fail "$(basename "$spec") would not be snapshot $want"
}

n=0
for spec in "$TPL"/examples/*.json; do
  jq -e '.schema == "moca-sbx-template-spec/1"' "$spec" >/dev/null || fail "$(basename "$spec") is not a spec"
  n=$((n + 1))
done
((n >= 2)) || fail "want at least two sample specs, found $n"
pass "the examples directory holds $n template specs"

check "$TPL/examples/default.json" default-eed901b838bf
pass 'default.json passes the spec check and pulls the public image by digest'
check "$TPL/examples/django__django-11133.json" django-django-11133-3d3e705ff379
grep -q '^podman-pull registry.example.com/image-factory/moca-microvm@' "$TMP/out" ||
  fail 'the SWE-bench sample is not host-free (its registry should come from --registry)'
pass 'django__django-11133.json passes the spec check; its image is host-free and takes --registry'

# The samples never carry a registry host, an account id or a token.
! grep -l -E 'amazonaws|dkr\.ecr|ghp_|github_pat_|[0-9]{12}\.' "$TPL"/examples/*.json >/dev/null ||
  fail 'a sample names a registry host, an account id or a token'
pass 'no sample names a private registry, an account id or a token'
