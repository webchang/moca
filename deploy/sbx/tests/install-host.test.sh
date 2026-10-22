#!/usr/bin/env bash
# Tests for deploy/sbx/install-host.sh with systemctl and journalctl mocked: what it writes, that
# two workers never share a slice, jail or workspace root (SBX0 §8.2), and that --uninstall leaves
# workspace data alone.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export MOCK_LOG="$TMP/mock.log"
mkdir -p "$TMP/bin"
fail() { echo "FAIL: $*" >&2; [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2; exit 1; }
pass() { echo "ok - $*"; }

cat >"$TMP/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >>"$MOCK_LOG"
[[ "$1" == show ]] && { echo "InvocationID=abc123"; exit 0; }
exit 0
MOCK
# journalctl: MOCK_JOURNAL_DIR holds the whole journal as the Nth look sees it (files 1, 2, ...;
# the last one keeps being served), so a test can script the worker's log growing between looks.
cat >"$TMP/bin/journalctl" <<'MOCK'
#!/usr/bin/env bash
printf 'journalctl %s\n' "$*" >>"$MOCK_LOG"
if [[ -n "${MOCK_JOURNAL_DIR:-}" ]]; then
  n=$(($(cat "$MOCK_JOURNAL_DIR/count" 2>/dev/null || echo 0) + 1))
  echo "$n" >"$MOCK_JOURNAL_DIR/count"
  while ((n > 1)) && [[ ! -f "$MOCK_JOURNAL_DIR/$n" ]]; do n=$((n - 1)); done
  cat "$MOCK_JOURNAL_DIR/$n"
  exit 0
fi
[[ -n "${MOCK_NO_ATTACH:-}" ]] || echo 'microvm-worker: attached, serving execs'
MOCK
chmod +x "$TMP/bin/systemctl" "$TMP/bin/journalctl"
export PATH="$TMP/bin:$PATH" SBX_UNIT_DIR="$TMP/units" SBX_ENV_DIR="$TMP/etc" SBX_SRV="$TMP/srv"
export SBX_SKIP_ROOT_CHECK=1 SBX_ATTACH_TIMEOUT=2 SBX_ATTACH_SETTLE=1
INSTALL="$SRC/deploy/sbx/install-host.sh"
mkdir -p "$SBX_SRV/snapshots/default" "$SBX_SRV/snapshots/py312"

bundle() { # bundle ID [EXTRA_LINES]: a worker bundle as setup.sh writes it, plus EXTRA_LINES
  local d="$TMP/bundles/$1"
  mkdir -p "$d"
  printf 'RELAY_ADDR=sbx-attach.apps.example.invalid:443\nRELAY_TLS=true\nSANDBOX_ID=%s\nSANDBOX_TOKEN=%s\n%s' \
    "$1" "$(printf '%064d' 7)" "${2-$'SH_WORKSPACE_IDLE=216h\nSH_WORKSPACE_IMAGE_MB=2048\n'}" >"$d/worker.env"
  printf -- '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n' >"$d/relay-ca.crt"
  echo "$d"
}

# Refusals
! bash "$INSTALL" "$(bundle sbx_default)" >"$TMP/out" 2>&1 || fail 'installed without --snapshot'
! bash "$INSTALL" "$(bundle sbx_default)" --snapshot missing >"$TMP/out" 2>&1 || fail 'installed a missing snapshot'
grep -q 'no snapshot' "$TMP/out" || fail 'missing-snapshot refusal does not say why'
b="$(bundle sbx_bad)"; sed -i.bak 's/^SANDBOX_TOKEN=.*/SANDBOX_TOKEN=short/' "$b/worker.env"
! bash "$INSTALL" "$b" --snapshot default >"$TMP/out" 2>&1 || fail 'accepted a malformed token'
! grep -q 'short' "$TMP/out" || fail 'the refusal printed the token value'
for extra in 'SH_WORKSPACE_IDLE=9d' 'SH_WORKSPACE_IDLE=0h' 'SH_WORKSPACE_IMAGE_MB=2g' 'SH_WORKSPACE_IMAGE_MB=0'; do
  : >"$MOCK_LOG"
  # The bad line last: env_value takes the last one, so it overrides the valid idle before it.
  ! bash "$INSTALL" "$(bundle sbx_bad $'SH_WORKSPACE_IDLE=216h\n'"$extra"$'\n')" --snapshot default >"$TMP/out" 2>&1 || fail "accepted $extra"
  grep -q "${extra%%=*} in" "$TMP/out" || fail "the $extra refusal does not name the setting"
  ! grep -q systemctl "$MOCK_LOG" || fail "touched systemd before refusing $extra"
done
# A bundle with no SH_WORKSPACE_IDLE predates 1b's rule (idle = lifetime + 2 days): refused, not defaulted.
: >"$MOCK_LOG"
! bash "$INSTALL" "$(bundle sbx_bad $'SH_WORKSPACE_IMAGE_MB=2048\n')" --snapshot default >"$TMP/out" 2>&1 || fail 'accepted a bundle with no SH_WORKSPACE_IDLE'
grep -q 'SH_WORKSPACE_IDLE' "$TMP/out" && grep -q 'deploy/sbx/setup.sh' "$TMP/out" ||
  fail 'the missing-idle refusal does not name SH_WORKSPACE_IDLE and setup.sh'
! grep -q systemctl "$MOCK_LOG" || fail 'touched systemd before refusing a bundle with no SH_WORKSPACE_IDLE'
pass 'refuses a missing snapshot, a missing --snapshot, a malformed token (without printing it), a missing or bad idle, a bad image size'

bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 || fail 'install sbx_default'
bash "$INSTALL" "$(bundle sbx_py312 $'SH_WORKSPACE_IDLE=240h\nSH_WORKSPACE_IMAGE_MB=4096\n')" --snapshot py312 --budget-mb 8192 \
  >"$TMP/out" 2>&1 || fail 'install sbx_py312'

A="$SBX_ENV_DIR/workers/sbx_default.env" B="$SBX_ENV_DIR/workers/sbx_py312.env"
for f in "$A" "$B"; do
  [[ "$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")" == 600 ]] || fail "$f is not 0600"
  grep -qx 'RELAY_TLS=true' "$f" || fail "$f: RELAY_TLS"
done
grep -qx 'SH_WORKSPACE_IDLE=216h' "$A" || fail "$A: SH_WORKSPACE_IDLE is not the bundle's 216h"
grep -qx 'SH_WORKSPACE_IMAGE_MB=2048' "$A" || fail "$A: SH_WORKSPACE_IMAGE_MB is not the bundle's 2048"
grep -qx 'SH_WORKSPACE_IDLE=240h' "$B" || fail "$B: SH_WORKSPACE_IDLE is not the bundle's 240h"
grep -qx 'SH_WORKSPACE_IMAGE_MB=4096' "$B" || fail "$B: SH_WORKSPACE_IMAGE_MB is not the bundle's 4096"
[[ "$(grep -c '^SH_WORKSPACE_IDLE=' "$B")" == 1 ]] || fail "$B: SH_WORKSPACE_IDLE written twice"
grep -qx 'SH_SNAPSHOT_IMAGE=py312' "$B" || fail 'snapshot not set'
grep -qx 'SH_MAX_COMMITTED_MB=8192' "$B" || fail 'budget not set'
for k in SH_PARENT_CGROUP SH_CHROOT_BASE SH_WORKSPACE_ROOT; do
  va="$(grep "^$k=" "$A" | cut -d= -f2-)" vb="$(grep "^$k=" "$B" | cut -d= -f2-)"
  [[ -n "$va" && "$va" != "$vb" ]] || fail "$k is shared between workers ($va)"
done
grep -qx 'SH_PARENT_CGROUP=sbx.slice/sbx-sbx_py312.slice' "$B" || fail 'parent cgroup is not the worker slice'
pass "two workers: 0600 env files, own slice, jail and workspace root, the bundle's idle and image size"

# A bundle without SH_WORKSPACE_IMAGE_MB gets microvm-worker's default, 2048 MiB.
bash "$INSTALL" "$(bundle sbx_old $'SH_WORKSPACE_IDLE=216h\n')" --snapshot default >"$TMP/out" 2>&1 || fail 'install a bundle with no image size'
grep -qx 'SH_WORKSPACE_IMAGE_MB=2048' "$SBX_ENV_DIR/workers/sbx_old.env" || fail 'SH_WORKSPACE_IMAGE_MB is not the 2048 default'
bash "$INSTALL" --uninstall sbx_old >"$TMP/out" 2>&1 || fail 'uninstall sbx_old'
pass 'a bundle without the image size gets the 2048 MiB default'

[[ -f "$SBX_UNIT_DIR/sbx-worker@.service" && -f "$SBX_UNIT_DIR/sbx.slice" ]] || fail 'template unit or parent slice missing'
[[ -f "$SBX_UNIT_DIR/sbx-sbx_py312.slice" ]] || fail 'per-worker slice missing'
grep -qx 'Slice=sbx-%i.slice' "$SBX_UNIT_DIR/sbx-worker@.service" || fail 'unit is not in its worker slice'
grep -qx 'AssertPathExists=/dev/kvm' "$SBX_UNIT_DIR/sbx-worker@.service" || fail 'unit lacks AssertPathExists=/dev/kvm'
grep -qx 'StartLimitIntervalSec=300' "$SBX_UNIT_DIR/sbx-worker@.service" || fail 'unit lacks StartLimitIntervalSec=300'
grep -qx 'StartLimitBurst=5' "$SBX_UNIT_DIR/sbx-worker@.service" || fail 'unit lacks StartLimitBurst=5'
grep -qx 'systemctl enable sbx-worker@sbx_py312.service' "$MOCK_LOG" || fail 'unit not enabled'
! grep -q 'systemctl enable --now' "$MOCK_LOG" || fail 'enable --now plus restart starts a fresh unit twice'
[[ "$(grep -cx 'systemctl restart sbx-worker@sbx_py312.service' "$MOCK_LOG")" == 1 ]] || fail 'the worker is not restarted exactly once'
grep -q 'sbx-worker@sbx_py312' "$SBX_ENV_DIR/manifest" || fail 'manifest does not record the worker'
pass 'installs the template unit, the slices, enables and restarts the worker once and records it'

# A worker that crash-looped into `failed` refuses a restart until reset: reset-failed comes first.
grep -A1 -x 'systemctl reset-failed sbx-worker@sbx_py312.service' "$MOCK_LOG" | grep -qx 'systemctl restart sbx-worker@sbx_py312.service' ||
  fail 'reset-failed does not run right before the restart (a failed unit would refuse it)'
pass 'clears a failed state (reset-failed) right before restarting the worker'

: >"$MOCK_LOG"
! MOCK_NO_ATTACH=1 bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 || fail 'reported success with no attach'
grep -q 'journalctl -u sbx-worker@sbx_default _SYSTEMD_INVOCATION_ID=abc123' "$TMP/out" || fail 'no-attach failure does not name the journal'
grep -q 'about a minute to reach the relay' "$TMP/out" || fail 'the timeout does not mention the Secret sync delay'
pass 'fails, naming the journal and the token-sync delay, when the worker never logs an attach'

# The attach rule of setup-microvm.sh: an earlier refusal does not fail the wait, a later attach that
# holds succeeds, and an attach followed by `stream ended` with no re-attach fails.
ATTACHED='microvm-worker: attached, serving execs'
ENDED='microvm-worker: stream ended (rpc error: code = Unauthenticated desc = bad token); reconnecting in 612ms'
journal() { # journal DIR LOOK... -- each LOOK is the full journal at that look, lines separated by |
  local d="$1" i=0 look
  rm -rf "$d" && mkdir -p "$d" && shift
  for look in "$@"; do i=$((i + 1)); printf '%s\n' "$look" | tr '|' '\n' >"$d/$i"; done
}
journal "$TMP/j1" "$ATTACHED" "$ATTACHED|$ENDED" "$ATTACHED|$ENDED|$ATTACHED"
MOCK_JOURNAL_DIR="$TMP/j1" SBX_ATTACH_TIMEOUT=10 bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 ||
  fail 'a refusal followed by an attach that holds was reported as a failure'
grep -q 'sbx-worker@sbx_default attached to the relay' "$TMP/out" || fail 'no attached message'
pass 'an attach that holds after an earlier refusal (Secret not yet synced) succeeds'

journal "$TMP/j2" "$ATTACHED" "$ATTACHED|$ENDED"
! MOCK_JOURNAL_DIR="$TMP/j2" SBX_ATTACH_TIMEOUT=3 bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 ||
  fail 'an attach followed by stream ended and no re-attach was reported as attached'
grep -q 'journalctl -u sbx-worker@sbx_default _SYSTEMD_INVOCATION_ID=abc123' "$TMP/out" || fail 'the failure does not name the journal'
pass 'an attach that ends and never comes back fails, naming the journal'

: >"$MOCK_LOG"
! SBX_ATTACH_SETTLE=0 bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 || fail 'accepted SBX_ATTACH_SETTLE=0'
grep -q 'SBX_ATTACH_SETTLE' "$TMP/out" || fail 'the SBX_ATTACH_SETTLE refusal does not say why'
! grep -q 'systemctl' "$MOCK_LOG" || fail 'touched systemd before refusing SBX_ATTACH_SETTLE=0'
pass 'refuses SBX_ATTACH_SETTLE below 1 before touching anything'

: >"$MOCK_LOG"
mkdir -p "$SBX_SRV/workspaces/sbx_py312/sbx-keepme"
bash "$INSTALL" --uninstall sbx_py312 >"$TMP/out" 2>&1 || fail 'uninstall'
grep -q 'systemctl disable --now sbx-worker@sbx_py312.service' "$MOCK_LOG" || fail 'unit not disabled'
grep -A1 'systemctl disable --now sbx-worker@sbx_py312.service' "$MOCK_LOG" | grep -qx 'systemctl stop sbx-sbx_py312.slice' ||
  fail 'the worker slice is not stopped after the unit is disabled (VMs left by a timed-out stop stay resident)'
[[ ! -f "$B" && ! -f "$SBX_UNIT_DIR/sbx-sbx_py312.slice" ]] || fail 'env file or slice kept'
[[ -d "$SBX_SRV/workspaces/sbx_py312/sbx-keepme" ]] || fail 'uninstall removed workspace data'
grep -q "left in place: $SBX_SRV/workspaces/sbx_py312" "$TMP/out" || fail 'uninstall does not say what it kept'
pass '--uninstall stops and removes the worker, keeps (and names) its workspace data'

# Uninstall matches the worker's manifest lines exactly: removing `a` keeps `ba`'s.
bash "$INSTALL" "$(bundle a)" --snapshot default >"$TMP/out" 2>&1 || fail 'install a'
bash "$INSTALL" "$(bundle ba)" --snapshot default >"$TMP/out" 2>&1 || fail 'install ba'
bash "$INSTALL" --uninstall a >"$TMP/out" 2>&1 || fail 'uninstall a'
M="$SBX_ENV_DIR/manifest"
! grep -q 'sbx-worker@a \|/a-relay-ca\.crt' "$M" || fail "a's manifest lines kept: $(cat "$M")"
grep -qx "worker sbx-worker@ba $SBX_ENV_DIR/workers/ba.env $SBX_UNIT_DIR/sbx-ba.slice" "$M" || fail "uninstalling a dropped ba's worker line: $(cat "$M")"
grep -qx "file $SBX_ENV_DIR/workers/ba-relay-ca.crt" "$M" || fail "uninstalling a dropped ba's CA line: $(cat "$M")"
[[ -f "$SBX_ENV_DIR/workers/ba-relay-ca.crt" && -f "$SBX_ENV_DIR/workers/ba.env" ]] || fail "uninstalling a removed ba's files"
pass "--uninstall a keeps worker ba's manifest lines and files (fixed-string match)"

# The shared units stay while any worker is left, and go with the last one (spec §8.2's undo).
[[ -f "$SBX_UNIT_DIR/sbx-worker@.service" && -f "$SBX_UNIT_DIR/sbx.slice" ]] || fail 'shared units removed while workers remain'
grep -qx "unit $SBX_UNIT_DIR/sbx.slice" "$M" || fail 'the manifest lost the shared units while workers remain'
bash "$INSTALL" --uninstall ba >"$TMP/out" 2>&1 || fail 'uninstall ba'
bash "$INSTALL" --uninstall sbx_default >"$TMP/out" 2>&1 || fail 'uninstall sbx_default (no worker after it)'
[[ ! -e "$SBX_UNIT_DIR/sbx-worker@.service" && ! -e "$SBX_UNIT_DIR/sbx.slice" ]] || fail 'shared units kept after the last worker'
grep -q "removed $SBX_UNIT_DIR/sbx-worker@.service" "$TMP/out" && grep -q "removed $SBX_UNIT_DIR/sbx.slice" "$TMP/out" ||
  fail 'the last uninstall does not say it removed the shared units'
[[ ! -s "$M" ]] || fail "the manifest still lists something after the last worker: $(cat "$M")"
[[ -d "$SBX_SRV/workspaces/sbx_default" ]] || fail 'the last uninstall removed workspace data'
# daemon-reload runs after the unit files are gone, so systemd forgets them.
bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 || fail 'reinstall sbx_default'
: >"$MOCK_LOG"
bash "$INSTALL" --uninstall sbx_default >"$TMP/out" 2>&1 || fail 'uninstall sbx_default again'
[[ "$(tail -1 "$MOCK_LOG")" == 'systemctl daemon-reload' ]] || fail "daemon-reload is not the last step of the undo: $(tail -1 "$MOCK_LOG")"
[[ ! -e "$SBX_UNIT_DIR/sbx-worker@.service" ]] || fail 'reinstall + uninstall left the template unit'
pass '--uninstall of the last worker removes the shared unit and sbx.slice, then daemon-reloads; workspace data stays'

# The janitor (spec §8.3): --janitor BUNDLE_DIR installs the script, its env, its token and the two
# units, enables the timer and records all of it as its own manifest kind; --uninstall-janitor
# reverses it; uninstalling the last worker leaves it alone.
export SBX_LIBEXEC_DIR="$TMP/libexec"
JTOKEN="$(printf 'k%.0s' {1..64})"
jbundle() { # jbundle [ENV_TEXT]: a janitor bundle as setup.sh writes it
  local d="$TMP/jbundle"
  rm -rf "$d" && mkdir -p "$d"
  printf '%s' "${1-$'SBX_API_URL=https://sbx-api.apps.example.invalid\nSBX_JANITOR_AGE=3900\n'}" >"$d/janitor.env"
  printf '%s' "$JTOKEN" >"$d/janitor.token"
  echo "$d"
}
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
M="$SBX_ENV_DIR/manifest"

# Refusals, before anything is written or systemd is touched.
for bad in 'SBX_API_URL=http://sbx-api.example.invalid' 'SBX_API_URL=https://x/../y' 'SBX_JANITOR_AGE=1h' \
  $'SBX_API_URL=https://sbx-api.example.invalid\nSBX_JANITOR_AGE=03600' $'SBX_API_URL=https://sbx-api.example.invalid\nSBX_JANITOR_AGE=0900' \
  $'SBX_API_URL=https://sbx-api.example.invalid\nSBX_JANITOR_AGE=60' $'SBX_API_URL=https://sbx-api.example.invalid\nSBX_JANITOR_AGE=0' \
  $'SBX_API_URL=https://sbx-api.example.invalid\nSBX_JANITOR_AGE=3900\nSBX_JANITOR_TOKEN=leaked'; do
  : >"$MOCK_LOG"
  ! bash "$INSTALL" --janitor "$(jbundle "$bad"$'\n')" >"$TMP/out" 2>&1 || fail "installed a janitor bundle with: $bad"
  ! grep -q systemctl "$MOCK_LOG" || fail "touched systemd before refusing: $bad"
  [[ ! -e "$SBX_LIBEXEC_DIR/sbx-janitor.sh" ]] || fail "wrote the janitor before refusing: $bad"
done
d="$(jbundle)"; printf 'tooShortSecret' >"$d/janitor.token"
! bash "$INSTALL" --janitor "$d" >"$TMP/out" 2>&1 || fail 'installed a token under 32 characters'
! grep -q tooShortSecret "$TMP/out" || fail 'the short-token refusal printed the token'
d="$(jbundle)"; printf 'not a cert' >"$d/api-ca.crt"
! bash "$INSTALL" --janitor "$d" >"$TMP/out" 2>&1 || fail 'installed an api-ca.crt that holds no certificate'
mkdir -p "$TMP/nojq"
for t in bash cat grep sed install mkdir chmod rm mv id tail cut touch dirname; do ln -sf "$(command -v "$t")" "$TMP/nojq/$t"; done
ln -sf "$TMP/bin/systemctl" "$TMP/nojq/systemctl"
! PATH="$TMP/nojq" "$TMP/nojq/bash" "$INSTALL" --janitor "$(jbundle)" >"$TMP/out" 2>&1 || fail 'installed the janitor on a host without jq and curl'
grep -q 'needs jq' "$TMP/out" || fail 'the missing-jq refusal does not say so'
pass '--janitor refuses a bad URL, a wait with a leading zero or of 60 s or less, a token in janitor.env, a short token, a bad CA, and a host without jq/curl'

: >"$MOCK_LOG"
d="$(jbundle)"
printf -- '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n' >"$d/api-ca.crt"
bash "$INSTALL" --janitor "$d" >"$TMP/out" 2>&1 || fail 'install the janitor'
JE="$SBX_ENV_DIR/janitor.env" JT="$SBX_ENV_DIR/janitor.token" JS="$SBX_LIBEXEC_DIR/sbx-janitor.sh"
[[ "$(mode "$JE")" == 600 && "$(mode "$JT")" == 600 && "$(mode "$JS")" == 755 ]] ||
  fail "modes: env $(mode "$JE"), token $(mode "$JT"), script $(mode "$JS")"
[[ "$(cat "$JT")" == "$JTOKEN" ]] || fail 'janitor.token is not the bundle token'
! grep -qF "$JTOKEN" "$JE" || fail 'the token is in janitor.env'
grep -qx 'SBX_API_URL=https://sbx-api.apps.example.invalid' "$JE" && grep -qx 'SBX_JANITOR_AGE=3900' "$JE" || fail "janitor.env: $(cat "$JE")"
grep -qx "SBX_API_CA_FILE=$SBX_ENV_DIR/janitor-api-ca.crt" "$JE" || fail 'janitor.env does not point at the installed API CA'
[[ -f "$SBX_ENV_DIR/janitor-api-ca.crt" ]] || fail 'the API CA was not installed'
cmp -s "$JS" "$SRC/deploy/sbx/janitor.sh" || fail 'the installed script is not deploy/sbx/janitor.sh'
S="$SBX_UNIT_DIR/sbx-janitor.service"
grep -qx "EnvironmentFile=$SBX_ENV_DIR/janitor.env" "$S" || fail 'the service does not read the installed janitor.env'
grep -qx "Environment=SBX_JANITOR_TOKEN_FILE=$SBX_ENV_DIR/janitor.token" "$S" || fail 'the service does not name the installed token'
grep -qx "Environment=SBX_ENV_DIR=$SBX_ENV_DIR" "$S" && grep -qx "Environment=SBX_SRV=$SBX_SRV" "$S" || fail 'the service does not name the env dir and srv'
grep -qx "ReadWritePaths=-$SBX_SRV/workspaces" "$S" || fail 'the service cannot write the workspace roots'
grep -qx "ExecStart=$JS" "$S" || fail 'the service does not run the installed script'
! grep -q '/etc/sbx\|/srv/sbx\|/usr/local/libexec' "$S" || fail "the service keeps a default path: $(grep -n '/etc/sbx\|/srv/sbx\|/usr/local/libexec' "$S")"
cmp -s "$SBX_UNIT_DIR/sbx-janitor.timer" "$SRC/deploy/sbx/sbx-janitor.timer" || fail 'the timer is not deploy/sbx/sbx-janitor.timer'
grep -A1 -x 'systemctl daemon-reload' "$MOCK_LOG" | grep -qx 'systemctl enable --now sbx-janitor.timer' || fail "the timer is not enabled after a daemon-reload: $(cat "$MOCK_LOG")"
! grep -qF "$JTOKEN" "$MOCK_LOG" "$TMP/out" || fail 'the token reached systemctl argv or the log'
for f in "$JE" "$JT" "$JS" "$S" "$SBX_UNIT_DIR/sbx-janitor.timer" "$SBX_ENV_DIR/janitor-api-ca.crt"; do
  grep -qx "janitor $f" "$M" || fail "the manifest does not record janitor $f: $(cat "$M")"
done
! grep -q '^unit .*janitor' "$M" || fail 'the janitor is recorded as a shared unit (the last worker uninstall would remove it)'
pass '--janitor installs the 0755 script, 0600 env and token, the CA and both units, enables the timer, records each as janitor'

# Re-run without a CA: the CA and its env line go; nothing else changes.
bash "$INSTALL" --janitor "$(jbundle)" >"$TMP/out" 2>&1 || fail 're-install the janitor without a CA'
! grep -q SBX_API_CA_FILE "$JE" && [[ ! -e "$SBX_ENV_DIR/janitor-api-ca.crt" ]] || fail 'a re-install without a CA keeps it'
! grep -qx "janitor $SBX_ENV_DIR/janitor-api-ca.crt" "$M" || fail 'the manifest keeps the dropped CA'
[[ "$(grep -c "^janitor $JE\$" "$M")" == 1 ]] || fail 'a re-install records janitor.env twice'
pass 'a re-install without api-ca.crt drops it and records nothing twice'

# The installed janitor runs from its unit's environment: SBX_ENV_DIR's env file and token.
mkdir -p "$TMP/jbin"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >>%q\necho %q\n' "$TMP/jcurl.log" '{"live":[],"terminated":[]}' >"$TMP/jbin/curl"
chmod +x "$TMP/jbin/curl"
(
  set -a
  # shellcheck disable=SC1090 # the installed env file
  . "$JE"
  set +a
  SBX_JANITOR_TOKEN_FILE="$JT" PATH="$TMP/jbin:$PATH" "$JS"
) >"$TMP/out" 2>&1 || fail 'the installed janitor does not run from its env file'
grep -q '"janitor":"summary"' "$TMP/out" || fail 'the installed janitor printed no summary'
pass 'the installed janitor runs from the installed env file and token'

# Uninstalling the last worker leaves the janitor; --uninstall-janitor removes exactly it.
bash "$INSTALL" "$(bundle sbx_default)" --snapshot default >"$TMP/out" 2>&1 || fail 'install sbx_default beside the janitor'
bash "$INSTALL" --uninstall sbx_default >"$TMP/out" 2>&1 || fail 'uninstall the last worker'
[[ ! -e "$SBX_UNIT_DIR/sbx-worker@.service" ]] || fail 'the last worker uninstall left the template unit'
[[ -f "$S" && -f "$SBX_UNIT_DIR/sbx-janitor.timer" && -f "$JS" && -f "$JE" && -f "$JT" ]] || fail 'the last worker uninstall removed the janitor'
grep -q '^janitor ' "$M" || fail 'the last worker uninstall dropped the janitor from the manifest'
bash "$INSTALL" "$(bundle sbx_py312)" --snapshot py312 >"$TMP/out" 2>&1 || fail 'install sbx_py312 beside the janitor'
: >"$MOCK_LOG"
bash "$INSTALL" --uninstall-janitor >"$TMP/out" 2>&1 || fail '--uninstall-janitor'
[[ -f "$SBX_ENV_DIR/workers/sbx_py312.env" && -f "$SBX_UNIT_DIR/sbx-worker@.service" && -f "$SBX_UNIT_DIR/sbx-sbx_py312.slice" ]] ||
  fail "--uninstall-janitor removed a worker's files"
grep -q '^worker sbx-worker@sbx_py312 ' "$M" && grep -q '^unit ' "$M" || fail "--uninstall-janitor dropped worker lines: $(cat "$M")"
! grep -q 'disable --now sbx-worker' "$MOCK_LOG" || fail '--uninstall-janitor stopped a worker'
grep -qx 'systemctl disable --now sbx-janitor.timer' "$MOCK_LOG" || fail 'the timer was not disabled'
[[ "$(tail -1 "$MOCK_LOG")" == 'systemctl daemon-reload' ]] || fail 'daemon-reload is not the last step of --uninstall-janitor'
for f in "$S" "$SBX_UNIT_DIR/sbx-janitor.timer" "$JS" "$JE" "$JT"; do [[ ! -e "$f" ]] || fail "--uninstall-janitor left $f"; done
! grep -q '^janitor ' "$M" || fail "--uninstall-janitor left manifest lines: $(cat "$M")"
[[ -d "$SBX_SRV/workspaces/sbx_default" ]] || fail '--uninstall-janitor removed workspace data'
bash "$INSTALL" --uninstall-janitor >"$TMP/out" 2>&1 || fail 'a second --uninstall-janitor fails (it should be a no-op)'
bash "$INSTALL" --uninstall sbx_py312 >"$TMP/out" 2>&1 || fail 'uninstall sbx_py312'
[[ ! -s "$M" ]] || fail "the manifest is not empty once the janitor and every worker are gone: $(cat "$M")"
! bash "$INSTALL" --janitor "$(jbundle)" --uninstall sbx_py312 >"$TMP/out" 2>&1 || fail 'accepted --janitor with --uninstall'
pass 'the last worker uninstall leaves the janitor; --uninstall-janitor removes exactly its files and lines, never a worker'
