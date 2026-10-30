#!/usr/bin/env bash
# Tests for deploy/sbx/template-build.sh with podman, df and the two builders mocked: the spec checks
# (each refused before anything is pulled), the names, the flags build-snapshot.sh gets, the guest
# verify command (run here under bash), the record, the free-space check, the digest check, and the
# "already built" short cut.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export MOCK_LOG="$TMP/mock.log"
mkdir -p "$TMP/bin"
fail() { echo "FAIL: $*" >&2; [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2; exit 1; }
pass() { echo "ok - $*"; }
DIGEST="sha256:$(printf 'a%.0s' {1..12})$(printf 'b%.0s' {1..52})"

# podman: MOCK_DIGEST is what inspect reports (default the pinned one); exists answers no, so it pulls.
cat >"$TMP/bin/podman" <<'MOCK'
#!/usr/bin/env bash
printf 'podman %s\n' "$*" >>"$MOCK_LOG"
case "$1 $2" in
'image exists') exit 1 ;;
'image inspect') echo "${MOCK_DIGEST:?}" ;;
esac
exit 0
MOCK
# df -Pk: MOCK_FREE_KB available.
cat >"$TMP/bin/df" <<'MOCK'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted\n/dev/x 1 1 %s 1%% /srv\n' "${MOCK_FREE_KB:?}"
MOCK
# The builders: record their argv (one arg per line); build-snapshot writes a manifest at --out
# unless MOCK_SNAPSHOT_FAIL, and saves its --verify-command for the tests to run.
cat >"$TMP/bin/build-rootfs" <<'MOCK'
#!/usr/bin/env bash
printf 'build-rootfs %s\n' "$*" >>"$MOCK_LOG"
mkdir -p "$2/etc"; printf '127.0.0.1 localhost\n' >"$2/etc/hosts"
MOCK
cat >"$TMP/bin/build-snapshot" <<'MOCK'
#!/usr/bin/env bash
printf 'build-snapshot\n' >>"$MOCK_LOG"
printf '%s\n' "$@" >"$MOCK_STATE/snapshot-args"
out=''
while (($#)); do
  case "$1" in
  --out) out="$2"; shift 2 ;;
  --verify-command) printf '%s' "$2" >"$MOCK_STATE/verify-command"; shift 2 ;;
  *) shift ;;
  esac
done
[[ -z "${MOCK_SNAPSHOT_FAIL:-}" ]] || { echo 'build-snapshot.sh: the fresh snapshot restored but the --verify-command exited 91' >&2; exit 1; }
mkdir -p "$out"
printf '{"hash": "%s", "built_at": "2026-10-30T00:00:00Z", "guest_ram_mb": 4096}\n' "${MOCK_HASH:-h1}" >"$out/manifest.json"
MOCK
chmod +x "$TMP/bin/"*
export PATH="$TMP/bin:$PATH" SBX_SRV="$TMP/srv" SBX_SKIP_ROOT_CHECK=1
export SBX_BUILD_ROOTFS="$TMP/bin/build-rootfs" SBX_BUILD_SNAPSHOT="$TMP/bin/build-snapshot"
export MOCK_STATE="$TMP/state" MOCK_DIGEST="$DIGEST" MOCK_FREE_KB=$((200 * 1024 * 1024))
mkdir -p "$MOCK_STATE" "$TMP/agent"
: >"$TMP/vmlinux"
BUILD="$SRC/deploy/sbx/template-build.sh"

# The spec of a SWE-bench instance, as image-factory's records give it.
spec() {
  jq -n --arg image "registry.example.invalid/moca-microvm@$DIGEST" '{
    schema: "moca-sbx-template-spec/1", id: "astropy-astropy-14995", image: $image,
    guest_ram_mb: 4096, vcpus: 2, guest_home: "/tmp/home", skip_git_identity_check: true,
    egress: false, seed: "cp -a /opt/testbed-src/. /workspace/",
    probe: {cmd: "cd /testbed && pytest -rA tests/test_public.py", timeout_s: 900, expect_rc: 0, expect: ["\\b42 passed\\b"]},
    description: "SWE-bench astropy__astropy-14995 at its baseline", tools: ["bash", "git", "python3"]}' |
    jq "${1:-.}" "${@:2}" >"$TMP/spec.json"
}
run() { : >"$MOCK_LOG"; bash "$BUILD" "$TMP/spec.json" --kernel "$TMP/vmlinux" --agent "$TMP/agent" "$@" >"$TMP/out" 2>&1; }
NAME=astropy-astropy-14995-aaaaaaaaaaaa
WORKER=sbx_astropy_astropy_14995_aaaaaaaaaaaa

# 1. Spec errors: exit 2, naming the field, before podman or a builder runs.
bad=(
  '.id = "Astropy__astropy-14995" => id'
  '.id = "scikit-learn-scikit-learn-134960" => id'
  '.image = "registry.example.invalid/moca-microvm:latest" => image must be pinned'
  '.guest_ram_mb = 64 => guest_ram_mb'
  '.vcpus = 0 => vcpus'
  '.guest_home = "/root" => guest_home'
  '.egress = "no" => egress must be true or false'
  'del(.seed) => seed must be a string'
  '.probe.expect_rc = 1.5 => probe must be'
  '.probe.timeout_s = 0 => probe must be'
  '.probe.cmd = "" => probe must be'
  '.probe.expect = ["("] => invalid extended regex'
  '.tools = ["git", "git"] => tools'
  '.etc_hosts_sha256 = "abc" => etc_hosts_sha256'
)
for case_ in "${bad[@]}"; do
  filter="${case_% => *}" want="${case_#* => }"
  spec "$filter"
  rc=0; run || rc=$?
  [[ "$rc" == 2 ]] || fail "spec '$filter' exited $rc, want 2"
  grep -q -- "$want" "$TMP/out" || fail "spec '$filter' does not say '$want'"
  [[ ! -s "$MOCK_LOG" ]] || fail "spec '$filter' ran something first: $(cat "$MOCK_LOG")"
done
pass 'refuses a bad id, an unpinned image, bad sizes, egress, seed, probe or tools, before anything runs (exit 2)'

# 2. A build: the names, the pull by digest, the builders' flags, the record.
spec
run || fail 'a good spec did not build'
grep -qx "podman pull registry.example.invalid/moca-microvm@$DIGEST" "$MOCK_LOG" || fail 'the image was not pulled by digest'
grep -q "^build-rootfs --out $SBX_SRV/build/$NAME/rootfs --image registry.example.invalid/moca-microvm@$DIGEST$" "$MOCK_LOG" ||
  fail "build-rootfs did not get the build dir and the image: $(grep build-rootfs "$MOCK_LOG")"
A="$MOCK_STATE/snapshot-args"
want_args="$(printf '%s\n' --kernel "$TMP/vmlinux" --rootfs "$SBX_SRV/build/$NAME/rootfs" --agent "$TMP/agent" \
  --image "$NAME" --vmm firecracker --guest-ram-mb 4096 --vcpus 2 --out "$SBX_SRV/snapshots/$NAME")"
[[ "$(head -n 16 "$A")" == "$want_args" ]] || fail "build-snapshot's first flags differ: $(head -n 16 "$A")"
grep -qx -- --skip-git-identity-check "$A" && grep -qx -- --guest-home "$A" && grep -qx /tmp/home "$A" ||
  fail 'build-snapshot did not get --skip-git-identity-check and --guest-home /tmp/home'
grep -A1 -x -- --verify-timeout-s "$A" | tail -n1 | grep -qx 900 || fail 'the probe timeout is not --verify-timeout-s'
R="$SBX_SRV/templates/$NAME.json"
[[ -f "$R" ]] || fail 'no record written'
jq -e --arg w "$WORKER" --arg n "$NAME" '.schema == "moca-sbx-template/1" and .id == "astropy-astropy-14995"
  and .worker == $w and .snapshot == $n and .manifest_hash == "h1" and .egress == false
  and .seed == "cp -a /opt/testbed-src/. /workspace/" and .min_budget_mb == 13408' "$R" >/dev/null ||
  fail "the record is wrong: $(cat "$R")"
grep -q -- "--snapshot $NAME --budget-mb <at least 13408> --no-egress" "$TMP/out" || fail 'the install hint lacks the snapshot, budget or --no-egress'
grep -qx "podman rmi registry.example.invalid/moca-microvm@$DIGEST" "$MOCK_LOG" || fail 'the pulled image was not removed'
[[ ! -e "$SBX_SRV/build/$NAME" ]] || fail 'the rootfs tree was left behind'
pass 'builds by digest: snapshot <id>-<digest12>, worker sbx_<id>_<digest12>, the spec flags, a record, and cleans up'

# 3. The guest verify command, run here under bash in a scratch /workspace (testbed faked).
run_verify() {
  local t="$TMP/guest" cmd
  rm -rf "$t"; mkdir -p "$t/workspace" "$t/opt/testbed-src" "$t/tmp"
  echo src >"$t/opt/testbed-src/file"
  cmd="$(sed -e "s|/opt/testbed-src|$t/opt/testbed-src|g" -e "s|/workspace|$t/workspace|g" \
    -e "s|/tmp/.template-probe.log|$t/tmp/probe.log|g" "$MOCK_STATE/verify-command")"
  (cd "$t/workspace" && bash -c "$cmd") >"$TMP/vout" 2>&1
}
spec '.probe.cmd = "ls /workspace/file && echo \"=== 42 passed in 0.70s ===\""'
run || fail 'the probe spec did not build'
run_verify || fail "the verify command failed on a passing probe: $(cat "$TMP/vout")"
grep -q 'the probe passed' "$TMP/vout" || fail 'a passing probe does not say so'
pass 'the verify command seeds /workspace, runs the probe and passes on the expected result'
spec '.probe.cmd = "echo \"=== 178 passed, 1 failed in 0.70s ===\"; exit 1"'
run || fail 'the probe spec did not build'
rc=0; run_verify || rc=$?
[[ "$rc" == 91 ]] && grep -q 'want exit 0' "$TMP/vout" || fail "a probe with the wrong exit code gave $rc: $(cat "$TMP/vout")"
spec '.probe.cmd = "echo \"=== 178 passed in 0.70s ===\""'
run || fail 'the probe spec did not build'
rc=0; run_verify || rc=$?
[[ "$rc" == 92 ]] && grep -q 'no match for' "$TMP/vout" || fail "a probe without its pattern gave $rc: $(cat "$TMP/vout")"
spec '.seed = "false"'
run || fail 'the seed spec did not build'
rc=0; run_verify || rc=$?
[[ "$rc" == 90 ]] && grep -q 'the seed failed' "$TMP/vout" || fail "a failing seed gave $rc: $(cat "$TMP/vout")"
spec '.probe.cmd = $c' --arg c "echo \"it's\" \"\\\"quoted\\\"\" \"\$HOME\" '\$HOME'; echo '42 passed in 1s'"
run || fail 'the quoting spec did not build'
run_verify || fail "quotes and \$ in the probe broke the verify command: $(cat "$TMP/vout")"
grep -qF "it's \"quoted\" $HOME \$HOME" "$TMP/vout" || fail "the probe's quoting changed on the way: $(cat "$TMP/vout")"
pass 'the verify command fails on a wrong exit code (91), a missing pattern (92) or a failed seed (90), and quotes safely'

# 4. Already built: the same spec on the same snapshot is not rebuilt; --force rebuilds; a changed
# spec rebuilds.
spec
run || fail 'the first build failed'
run || fail 'the re-run failed'
grep -q 'already built' "$TMP/out" && ! grep -q 'build-snapshot' "$MOCK_LOG" || fail 'the same spec was rebuilt'
run --force || fail '--force failed'
grep -q 'build-snapshot' "$MOCK_LOG" || fail '--force did not rebuild'
spec '.description = "another"'
run || fail 'the changed spec failed'
grep -q 'build-snapshot' "$MOCK_LOG" || fail 'a changed spec was not rebuilt'
pass 'skips a snapshot already built from the same spec; --force or a changed spec rebuilds'

# 5. Refusals that must leave nothing behind: low disk, a digest mismatch, a failed probe.
spec
rm -rf "$SBX_SRV"
rc=0; MOCK_FREE_KB=$((10 * 1024 * 1024)) run || rc=$?
[[ "$rc" == 1 ]] && grep -q '10 GiB free; a build needs 50' "$TMP/out" || fail "low disk was not refused: $(cat "$TMP/out")"
! grep -q 'podman' "$MOCK_LOG" || fail 'low disk still pulled'
rc=0; MOCK_DIGEST="sha256:$(printf 'c%.0s' {1..64})" run || rc=$?
[[ "$rc" == 1 ]] && grep -q 'but its digest is sha256:ccc' "$TMP/out" || fail "a digest mismatch was not refused: $(cat "$TMP/out")"
! grep -q build-rootfs "$MOCK_LOG" || fail 'a digest mismatch still built'
rc=0; MOCK_SNAPSHOT_FAIL=1 run || rc=$?
[[ "$rc" == 1 ]] || fail 'a failed snapshot build did not fail the run'
[[ ! -e "$SBX_SRV/templates/$NAME.json" && ! -e "$SBX_SRV/build/$NAME" ]] || fail 'a failed build left a record or a build dir'
pass 'refuses low disk before pulling, a digest mismatch before building, and a failed probe writes no record'

# 6. etc_hosts_sha256: the rootfs's /etc/hosts must have it, checked before the snapshot is built.
HOSTS_SHA="$(printf '127.0.0.1 localhost\n' | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1)"
spec ".etc_hosts_sha256 = \"$HOSTS_SHA\""
run --force || fail "a matching etc_hosts_sha256 did not build: $(cat "$TMP/out")"
grep -q 'etc/hosts as the spec says' "$TMP/out" || fail 'the hosts check did not run'
spec ".etc_hosts_sha256 = \"$(printf 'f%.0s' {1..64})\""
rc=0; run --force || rc=$?
[[ "$rc" == 1 ]] && grep -q "/etc/hosts has sha256 $HOSTS_SHA, not the spec's" "$TMP/out" || fail "a wrong etc_hosts_sha256 was not refused: $(cat "$TMP/out")"
! grep -q build-snapshot "$MOCK_LOG" || fail 'a wrong etc_hosts_sha256 still built the snapshot'
pass 'checks the rootfs /etc/hosts against etc_hosts_sha256 before building the snapshot'

# 7. egress true: no --no-egress in the hint; a curated template's spec needs no seed.
spec '.egress = true | .seed = ""'
run || fail 'an egress spec did not build'
! grep -q -- '--no-egress' "$TMP/out" || fail 'egress true still says --no-egress'
! grep -q 'bash -c .*seed' "$MOCK_STATE/verify-command" && ! grep -q 'the seed failed' "$MOCK_STATE/verify-command" ||
  fail 'an empty seed still runs a seed'
pass 'egress true drops --no-egress from the hint; an empty seed runs nothing'
