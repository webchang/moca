#!/usr/bin/env bash
# Tests for deploy/sbx/host-agent.sh (template lifecycle spec §6.1), with curl and template-build.sh
# mocked on PATH: a fake control plane that hands out one build and records every report, and a fake
# build that writes a template record and manifest where template-build.sh would. What must hold:
# the token is sent only from a 0600 header file (never argv, never output); a successful build is
# reported `built` with the record and manifest as files; a failed one `failed` with its exit; a
# gate record is checked against its digest before the build; no build is claimed below the disk
# floor; and the agent refuses its own bad settings before it calls anything.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2; exit 1; }
pass() { echo "ok - $*"; }
A="$SRC/deploy/sbx/host-agent.sh"
TOKEN="$(printf 'a%.0s' {1..64})"
DIGEST="3d3e705ff379defc6684c220f97fc8701df4e06fce8fa8841c13d3ff8cef7746"
GATE='{"gate":{"passed":true}}'
GATE_SHA="$(printf '%s' "$GATE" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1)"

mkdir -p "$TMP/bin" "$TMP/srv/templates" "$TMP/srv/snapshots" "$TMP/state"
# curl: the fake control plane. Logs its argv; answers only with the bearer from a header file.
cat >"$TMP/bin/curl" <<'MOCK'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"$MOCK_LOG"
args=("$@") hdr='' url='' data='' method=GET
for ((i = 0; i < ${#args[@]}; i++)); do
  [[ "${args[$i]}" == -H && "${args[$((i + 1))]:-}" == @* ]] && hdr="${args[$((i + 1))]#@}"
  [[ "${args[$i]}" == --data-binary ]] && data="${args[$((i + 1))]#@}"
  [[ "${args[$i]}" == -X ]] && method="${args[$((i + 1))]}"
  [[ "${args[$i]}" == https://* ]] && url="${args[$i]}"
done
[[ -n "$hdr" && "$(cat "$hdr")" == "Authorization: Bearer $(cat "$MOCK_TOKEN_FILE")" ]] || { echo 'curl: (22) 401' >&2; exit 22; }
path="${url#https://cp.example.invalid}"
[[ -z "$data" ]] || cp "$data" "$MOCK_STATE/$(printf '%s' "$method$path" | tr '/' '_')"
case "$method $path" in
"POST /v1/hosts/bm1/inventory") echo '{"host":"bm1","holds":0}' ;;
"POST /v1/hosts/bm1/builds/claim") cat "$MOCK_STATE/claim-answer" ;;
"GET /v1/hosts/bm1/blobs/"*) printf '{"sha256":"x","base64":"%s"}' "$(printf '%s' "$MOCK_GATE" | base64)" ;;
"POST /v1/hosts/bm1/builds/"*/log) echo '{"appended":1}' ;;
"POST /v1/hosts/bm1/builds/"*/report) echo '{"status":"registered","buildId":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}' ;;
*) echo "curl: (22) 404 $method $path" >&2; exit 22 ;;
esac
MOCK
# template-build.sh: logs its argv; writes the record and manifest template-build.sh would, or fails.
cat >"$TMP/bin/template-build" <<'MOCK'
#!/usr/bin/env bash
printf 'build %s\n' "$*" >>"$MOCK_LOG"
[[ -z "${MOCK_BUILD_FAIL:-}" ]] || { echo 'build-snapshot.sh: the --verify-command exited 91'; exit 1; }
spec="$1" id="$(jq -r .id "$1")" d="$(jq -r .image "$1")"; d="${d##*@sha256:}"; name="$id-${d:0:12}"
mkdir -p "$SBX_SRV/snapshots/$name"
printf '{"hash_version":2,"hash":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}' >"$SBX_SRV/snapshots/$name/manifest.json"
jq -n --arg n "$name" --arg id "$id" '{schema: "moca-sbx-template/1", id: $id, snapshot: $n, manifest_hash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}' \
  >"$SBX_SRV/templates/$name.json"
echo "==> built template $id"
MOCK
chmod +x "$TMP/bin/curl" "$TMP/bin/template-build"
: >"$TMP/kernel"
(umask 077 && printf '%s' "$TOKEN" >"$TMP/token")
export PATH="$TMP/bin:$PATH" MOCK_LOG="$TMP/log" MOCK_STATE="$TMP/state" MOCK_TOKEN_FILE="$TMP/token" MOCK_GATE="$GATE"
export SBX_API_URL=https://cp.example.invalid SBX_HOST_ID=bm1 SBX_HOST_TOKEN_FILE="$TMP/token" SBX_KERNEL="$TMP/kernel"
export SBX_SRV="$TMP/srv" SBX_ENV_DIR="$TMP" SBX_TEMPLATE_BUILD="$TMP/bin/template-build" SBX_DISK_FLOOR_GB=0

job() { # job [GATE_SHA]: the claim answer, one build of the worked example
  jq -n --arg d "$DIGEST" --arg g "${1:-}" '{builds: [{template: "django-django-11133", build: "b-0123456789abcdef0123456789",
    image: ("image-factory/moca-microvm@sha256:" + $d),
    spec: {id: "django-django-11133", image: ("image-factory/moca-microvm@sha256:" + $d), guest_ram_mb: 4096}}
    + (if $g == "" then {} else {gateRecord: ("/v1/hosts/bm1/blobs/sha256:" + $g)} end)]}' >"$TMP/state/claim-answer"
}
run() { : >"$MOCK_LOG"; rm -f "$TMP/state/POST_"*; bash "$A" --once >"$TMP/out" 2>&1; }

# 1. A good build: claimed, built, reported with both files; the token only in a header file.
job "$GATE_SHA"
run || fail 'a good poll failed'
grep -q '"agent":"summary","claimed":1,"built":1,"failed":0,"errors":0' "$TMP/out" || fail 'summary'
R="$TMP/state/POST_v1_hosts_bm1_builds_b-0123456789abcdef0123456789_report"
jq -e '.event == "built" and (.templateRecord | fromjson | .manifest_hash == "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
  and (.manifest | fromjson | .hash_version == 2)' "$R" >/dev/null || fail 'the built report does not carry T and S as files'
grep -q -- "--gate-record $TMP" "$MOCK_LOG" || grep -q -- '--gate-record /' "$MOCK_LOG" || fail 'the build was not given its gate record'
grep -q -- "$TOKEN" "$MOCK_LOG" "$TMP/out" && fail 'the token reached argv or output'
jq -e '.limits.diskFloorGb == 0 and (.holds | length) == 0' "$TMP/state/POST_v1_hosts_bm1_inventory" >/dev/null || fail 'inventory'
pass 'a claimed build is built and reported built with its template record and manifest; the token stays in a 0600 header file'

# 2. The next poll's inventory names the snapshot it now holds.
job ''
printf '{"builds":[]}' >"$TMP/state/claim-answer"
run || fail 'second poll'
jq -e '.holds == [{template: "django-django-11133", manifestHash: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}]' "$TMP/state/POST_v1_hosts_bm1_inventory" >/dev/null ||
  fail 'the inventory does not name the held snapshot'
pass 'the inventory names the snapshots held, by manifest hash'

# 3. A failed build is reported failed, with template-build.sh's exit and last line.
job ''
MOCK_BUILD_FAIL=1 run || fail 'a failing build failed the poll'
jq -e '.event == "failed" and (.message | test("exit 1: build-snapshot.sh: the --verify-command exited 91"))' "$R" >/dev/null ||
  fail 'the failure report'
grep -q '"failed":1' "$TMP/out" || fail 'summary of a failure'
pass 'a failed build is reported failed with its exit and last line'

# 4. A gate record whose bytes do not hash to its name is not built with.
job "$(printf 'b%.0s' {1..64})"
run || fail 'poll with a bad gate record'
grep -q '^build ' "$MOCK_LOG" && fail 'built with a gate record that does not match its digest'
grep -q 'does not match its digest' "$TMP/out" || fail 'the mismatch was not reported'
pass 'a gate record is checked against its digest before any build'

# 5. Below the disk floor, nothing is claimed.
job ''
SBX_DISK_FLOOR_GB=999999999 run || fail 'poll below the floor'
grep -q 'builds/claim' "$MOCK_LOG" && fail 'claimed below the disk floor'
grep -q 'below the floor' "$TMP/out" || fail 'the floor skip was not said'
pass 'no build is claimed below the disk floor'

# 6. Its own settings, refused (exit 2) before any call.
for bad in 'SBX_HOST_ID=BM1' 'SBX_API_URL=http://cp.example.invalid' 'SBX_BUILD_CONCURRENCY=9' 'SBX_DISK_FLOOR_GB=060'; do
  : >"$MOCK_LOG"
  rc=0; env "$bad" bash "$A" --once >"$TMP/out" 2>&1 || rc=$?
  [[ "$rc" == 2 ]] || fail "accepted $bad (rc $rc)"
  [[ ! -s "$MOCK_LOG" ]] || fail "called the control plane before refusing $bad"
done
chmod 0644 "$TMP/token"
rc=0; bash "$A" --once >"$TMP/out" 2>&1 || rc=$?
[[ "$rc" == 2 ]] && grep -q 'mode 0600' "$TMP/out" || fail 'accepted a token file readable by others'
chmod 0600 "$TMP/token"
rc=0; bash "$A" >"$TMP/out" 2>&1 || rc=$?
[[ "$rc" == 2 ]] || fail 'ran without --once'
pass 'refuses a bad host id, a non-https URL, a bad concurrency or floor, a shared token file, and no --once, before calling anything'

echo 'all host-agent.sh tests passed'
