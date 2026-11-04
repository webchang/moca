#!/usr/bin/env bash
# deploy/sbx/host-agent.sh -- sbx-host-agent, a KVM host's template agent
# (docs/specs/2026-11-03-template-lifecycle-and-provenance-design.md §6.1). One run is one poll:
# report the inventory, claim queued builds, build each with template-build.sh, report the outcome;
# then start and stop installed workers as the control plane wants (§6.3). The control plane
# registers or rejects a built build by policy (§8.2) and decides what runs; nothing here does.
#
# A worker must already be installed (install-host.sh, with its relay token from setup.sh): a wanted
# build whose worker is not is reported `refused`, never installed here (register gap G18).
#
#   sudo deploy/sbx/host-agent.sh --once     one poll (the unit's timer runs it)
#
# Run it through the unit (systemctl start sbx-host-agent.service): the unit loads host-agent.env; a
# bare run sees none of it and refuses (SBX_API_URL). Installed outside the tree, it needs
# SBX_TEMPLATE_BUILD (the unit sets it to /srv/sbx/src/...).
#
# Environment (the unit sets it from /etc/sbx/host-agent.env):
#   SBX_API_URL              https://<api host>, the control plane
#   SBX_HOST_ID              this host's id, as in the control plane's SH_TEMPLATE_HOSTS
#   SBX_HOST_TOKEN_FILE      default $SBX_ENV_DIR/host-agent.token: SH_HOST_TOKEN_<ID>, 64 hex, alone
#                            in a 0600 file owned by the running user
#   SBX_KERNEL               the guest kernel template-build.sh boots (its --kernel)
#   SBX_API_CA_FILE          optional; the CA to verify the API Route with
#   SBX_SRV                  default /srv/sbx: snapshots under $SBX_SRV/snapshots, records under templates/
#   SBX_ENV_DIR              default /etc/sbx
#   SBX_DISK_FLOOR_GB        default 60: no build is claimed below this much free disk on $SBX_SRV
#                            (template-build.sh's own refusal; retained workspaces count, W8)
#   SBX_BUILD_CONCURRENCY    default 1: builds claimed per poll
#   SBX_ACTIVE_LIMIT, SBX_IDLE_LIMIT_S   reported to the control plane (§6.2); default 0 (none set)
#   SBX_TEMPLATE_BUILD       default <repo>/deploy/sbx/template-onboarding/template-build.sh (a test seam)
#   SBX_REGISTRY             optional; template-build.sh --registry
#
# The token never reaches argv or a log: curl reads it from a 0600 header file. No host IP, account
# or registry host is logged. Output: one JSON line per action, then one summary line
# {"agent":"summary","claimed","built","failed","started","stopped","errors"}. A refusal of its own settings is exit 2.
set -euo pipefail
export LC_ALL=C

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${SBX_TEMPLATE_BUILD:=$REPO_ROOT/deploy/sbx/template-onboarding/template-build.sh}"
HOST_ID_RE='^[a-z0-9][a-z0-9-]{0,30}$'
HANDLE_RE='^b-[0-9a-f]{26}$'
WORKER_RE='^[A-Za-z_][A-Za-z0-9_]*$'
TEMPLATE_ID_RE='^[a-z0-9][a-z0-9-]{0,30}$'
DIGEST_RE='^sha256:[0-9a-f]{64}$'

say() { printf '%s\n' "$*"; }
refuse() { echo "sbx-host-agent: $*" >&2; exit 2; }
CLAIMED=0 BUILT=0 FAILED=0 ERRORS=0 STARTED=0 STOPPED=0
error() { ERRORS=$((ERRORS + 1)); say "{\"agent\":\"error\",\"why\":$(jq -Rn --arg w "$1" '$w')}"; }

check_settings() {
  local t
  for t in jq curl df mktemp base64 sha256sum systemctl; do command -v "$t" >/dev/null || refuse "needs $t on PATH"; done
  SBX_SRV="${SBX_SRV-/srv/sbx}" SBX_ENV_DIR="${SBX_ENV_DIR-/etc/sbx}"
  [[ "$SBX_SRV" =~ ^(/[A-Za-z0-9_][A-Za-z0-9._-]*)+$ ]] || refuse "SBX_SRV='$SBX_SRV' must be an absolute path other than /"
  [[ "${SBX_API_URL:-}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || refuse 'SBX_API_URL must be https://<api host>'
  [[ "${SBX_HOST_ID:-}" =~ $HOST_ID_RE ]] || refuse "SBX_HOST_ID must match $HOST_ID_RE"
  : "${SBX_HOST_TOKEN_FILE:=$SBX_ENV_DIR/host-agent.token}"
  [[ -f "$SBX_HOST_TOKEN_FILE" && -r "$SBX_HOST_TOKEN_FILE" ]] || refuse 'SBX_HOST_TOKEN_FILE must name a readable file'
  local mode
  mode="$(stat -c '%a %u' "$SBX_HOST_TOKEN_FILE" 2>/dev/null || stat -f '%Lp %u' "$SBX_HOST_TOKEN_FILE")"
  [[ "$mode" == "600 $(id -u)" ]] || refuse "$SBX_HOST_TOKEN_FILE must be mode 0600 and owned by the running user"
  [[ "$(<"$SBX_HOST_TOKEN_FILE")" =~ ^[0-9a-f]{64}$ ]] || refuse "$SBX_HOST_TOKEN_FILE must hold 64 hex characters"
  [[ -n "${SBX_KERNEL:-}" && -f "$SBX_KERNEL" ]] || refuse 'SBX_KERNEL must name the guest kernel file'
  [[ -x "$SBX_TEMPLATE_BUILD" ]] || refuse "no template-build.sh at $SBX_TEMPLATE_BUILD"
  for v in SBX_DISK_FLOOR_GB SBX_BUILD_CONCURRENCY SBX_ACTIVE_LIMIT SBX_IDLE_LIMIT_S; do
    [[ -z "${!v:-}" || "${!v}" =~ ^(0|[1-9][0-9]{0,8})$ ]] || refuse "$v must be a whole number without a leading zero"
  done
  : "${SBX_DISK_FLOOR_GB:=60}" "${SBX_BUILD_CONCURRENCY:=1}" "${SBX_ACTIVE_LIMIT:=0}" "${SBX_IDLE_LIMIT_S:=0}"
  ((SBX_BUILD_CONCURRENCY >= 1 && SBX_BUILD_CONCURRENCY <= 4)) || refuse 'SBX_BUILD_CONCURRENCY must be 1-4'
}

HDR=''
api() { # api METHOD PATH [BODY_FILE] -> the body on stdout; fails on any non-2xx
  local ca=() data=()
  [[ -z "${SBX_API_CA_FILE:-}" ]] || ca=(--cacert "$SBX_API_CA_FILE")
  [[ -z "${3:-}" ]] || data=(-H 'Content-Type: application/json' --data-binary "@$3")
  curl -fsS --max-time 60 --proto =https "${ca[@]}" -H "@$HDR" -X "$1" "${data[@]}" "$SBX_API_URL$2"
}

free_gb() { df -Pk "$SBX_SRV" 2>/dev/null | awk 'NR==2 { printf "%d", $4 / 1048576 }'; }

# The snapshots this host holds, by manifest hash, as template-build.sh's records name them.
inventory() {
  local f out="$WORK/inventory.json"
  {
    printf '{"holds":['
    local sep=''
    for f in "$SBX_SRV"/templates/*.json; do
      [[ -f "$f" ]] || continue
      jq -e '.schema == "moca-sbx-template/1" and (.manifest_hash | test("^sha256:[0-9a-f]{64}$"))' "$f" >/dev/null 2>&1 || continue
      printf '%s%s' "$sep" "$(jq -c '{template: .id, manifestHash: .manifest_hash}' "$f")"
      sep=','
    done
    printf '],"limits":{"activeLimit":%d,"idleLimitSeconds":%d,"buildConcurrency":%d,"diskFreeGb":%d,"diskFloorGb":%d}}' \
      "$SBX_ACTIVE_LIMIT" "$SBX_IDLE_LIMIT_S" "$SBX_BUILD_CONCURRENCY" "$(free_gb)" "$SBX_DISK_FLOOR_GB"
  } >"$out"
  api POST "/v1/hosts/$SBX_HOST_ID/inventory" "$out" >/dev/null
}

report() { # report HANDLE BODY_JSON
  printf '%s' "$2" >"$WORK/report.json"
  api POST "/v1/hosts/$SBX_HOST_ID/builds/$1/report" "$WORK/report.json"
}

log_tail() { # log_tail HANDLE FILE: the build log's last 200 lines, as entries
  tail -n 200 "$2" | jq -Rs '{entries: (split("\n") | map(select(length > 0)) | map({level: "info", step: "build", message: .[0:4096]}))}' \
    >"$WORK/log.json"
  api POST "/v1/hosts/$SBX_HOST_ID/builds/$1/log" "$WORK/log.json" >/dev/null || error "log upload for $1 failed"
}

build_one() { # build_one JOB_JSON
  local job="$1" handle tpl spec gate args=() rc=0 snap rec
  handle="$(jq -r .build <<<"$job")" tpl="$(jq -r .template <<<"$job")"
  [[ "$handle" =~ $HANDLE_RE && "$tpl" =~ $TEMPLATE_ID_RE ]] || { error 'the control plane handed out a malformed job'; return; }
  CLAIMED=$((CLAIMED + 1))
  say "{\"agent\":\"claimed\",\"template\":\"$tpl\",\"build\":\"$handle\"}"
  spec="$WORK/$handle.spec.json"
  jq '.spec' <<<"$job" >"$spec"
  gate="$(jq -r '.gateRecord // empty' <<<"$job")"
  if [[ -n "$gate" ]]; then
    local d="${gate##*/}"
    [[ "$d" =~ $DIGEST_RE && "$gate" == "/v1/hosts/$SBX_HOST_ID/blobs/$d" ]] || { error "malformed gate record path for $handle"; return; }
    api GET "$gate" | jq -r .base64 | base64 --decode >"$WORK/$handle.gate.json" || { error "gate record fetch for $handle failed"; return; }
    # The bytes must be the ones the policy trusted: their sha256 is the name.
    [[ "sha256:$(sha256sum "$WORK/$handle.gate.json" | cut -d' ' -f1)" == "$d" ]] || { error "gate record for $handle does not match its digest"; return; }
    args+=(--gate-record "$WORK/$handle.gate.json")
  fi
  [[ -z "${SBX_REGISTRY:-}" ]] || args+=(--registry "$SBX_REGISTRY")
  report "$handle" '{"event":"building"}' >/dev/null || { error "report building for $handle failed"; return; }
  "$SBX_TEMPLATE_BUILD" "$spec" --kernel "$SBX_KERNEL" "${args[@]}" >"$WORK/$handle.log" 2>&1 || rc=$?
  log_tail "$handle" "$WORK/$handle.log"
  if ((rc != 0)); then
    FAILED=$((FAILED + 1))
    local last
    last="$(grep -v '^[[:space:]]*$' "$WORK/$handle.log" | tail -n 1 | cut -c1-500)"
    report "$handle" "$(jq -cn --arg m "template-build.sh exit $rc: $last" '{event: "failed", step: "build", message: $m}')" >/dev/null ||
      error "report failed for $handle failed"
    say "{\"agent\":\"failed\",\"build\":\"$handle\",\"rc\":$rc}"
    return
  fi
  # template-build.sh names the snapshot <id>-<first 12 hex of the image digest> and writes its record
  # beside the snapshots (its "Names" rule), built now or already built.
  local digest
  digest="$(jq -r .image "$spec")"
  digest="${digest##*@sha256:}"
  rec="$SBX_SRV/templates/$tpl-${digest:0:12}.json"
  [[ -f "$rec" ]] || { error "no template record for $handle at $rec"; return; }
  snap="$SBX_SRV/snapshots/$(jq -r .snapshot "$rec")"
  [[ -f "$snap/manifest.json" ]] || { error "no manifest for $handle"; return; }
  local out
  out="$(report "$handle" "$(jq -cn --rawfile t "$rec" --rawfile s "$snap/manifest.json" '{event: "built", templateRecord: $t, manifest: $s}')")" ||
    { error "report built for $handle failed"; return; }
  BUILT=$((BUILT + 1))
  say "{\"agent\":\"reported\",\"build\":\"$handle\",\"outcome\":$(jq -c . <<<"$out")}"
}

worker_report() { # worker_report BUILD_ID EVENT [REASON]
  jq -cn --arg b "$1" --arg e "$2" --arg r "${3:-}" '{buildId: $b, event: $e} + (if $r == "" then {} else {reason: $r} end)' \
    >"$WORK/worker.json"
  api POST "/v1/hosts/$SBX_HOST_ID/workers/report" "$WORK/worker.json" >/dev/null || error "worker report for $1 failed"
}

# Start what is wanted and installed; stop what is not wanted (the control plane leaves out a worker
# with live sandboxes). Readiness is the relay's attached record, never this report.
activation() {
  local wanted w unit
  wanted="$(api GET "/v1/hosts/$SBX_HOST_ID/wanted")" || { error 'wanted state unreadable'; return; }
  jq -e '(.run | type) == "array" and (.stop | type) == "array"' >/dev/null 2>&1 <<<"$wanted" || { error 'wanted state malformed'; return; }
  while IFS=$'\t' read -r w b; do
    [[ "$w" =~ $WORKER_RE ]] || { error 'a wanted worker id is malformed'; continue; }
    unit="sbx-worker@$w.service"
    if [[ ! -f "$SBX_ENV_DIR/workers/$w.env" ]]; then
      worker_report "$b" refused 'worker not installed on this host (install-host.sh with its setup.sh bundle)'
      say "{\"agent\":\"refused\",\"worker\":\"$w\",\"why\":\"not installed\"}"
      continue
    fi
    systemctl is-active --quiet "$unit" && continue
    if systemctl start "$unit"; then
      STARTED=$((STARTED + 1)); worker_report "$b" attached; say "{\"agent\":\"started\",\"worker\":\"$w\"}"
    else
      worker_report "$b" refused "systemctl start $unit failed"; error "start $unit failed"
    fi
  done < <(jq -r '.run[] | [.worker, .buildId] | @tsv' <<<"$wanted")
  while IFS=$'\t' read -r w b; do
    [[ "$w" =~ $WORKER_RE ]] || { error 'a worker id to stop is malformed'; continue; }
    unit="sbx-worker@$w.service"
    systemctl is-active --quiet "$unit" || continue
    if systemctl stop "$unit"; then
      STOPPED=$((STOPPED + 1)); worker_report "$b" detached; say "{\"agent\":\"stopped\",\"worker\":\"$w\"}"
    else
      error "stop $unit failed"
    fi
  done < <(jq -r '.stop[] | [.worker, .buildId] | @tsv' <<<"$wanted")
}

main() {
  [[ "${1:-}" == --once && $# -eq 1 ]] || { echo 'usage: host-agent.sh --once' >&2; exit 2; }
  command -v jq >/dev/null || refuse 'needs jq on PATH'
  check_settings
  WORK="$(umask 077 && mktemp -d)"
  HDR="$WORK/hdr"
  # shellcheck disable=SC2064 # expand now: the trap must remove exactly this directory
  trap "rm -rf '$WORK'" EXIT
  (umask 077 && printf 'Authorization: Bearer %s\n' "$(<"$SBX_HOST_TOKEN_FILE")" >"$HDR")
  if ! inventory; then
    say '{"agent":"skipped","why":"control plane unreachable or refused the inventory"}'
    return 0
  fi
  local free
  free="$(free_gb)"
  if [[ -z "$free" ]] || ((free < SBX_DISK_FLOOR_GB)); then
    say "{\"agent\":\"skipped\",\"why\":\"free disk ${free:-?} GB is below the floor $SBX_DISK_FLOOR_GB GB\"}"
  else
    printf '{"max":%d}' "$SBX_BUILD_CONCURRENCY" >"$WORK/claim.json"
    local jobs
    if jobs="$(api POST "/v1/hosts/$SBX_HOST_ID/builds/claim" "$WORK/claim.json")" && jq -e '.builds | type == "array"' >/dev/null 2>&1 <<<"$jobs"; then
      while IFS= read -r job; do build_one "$job"; done < <(jq -c '.builds[]' <<<"$jobs")
    else
      error 'claim failed'
    fi
  fi
  activation
  say "{\"agent\":\"summary\",\"claimed\":$CLAIMED,\"built\":$BUILT,\"failed\":$FAILED,\"started\":$STARTED,\"stopped\":$STOPPED,\"errors\":$ERRORS}"
}

main "$@"
