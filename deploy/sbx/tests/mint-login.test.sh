#!/usr/bin/env bash
# Tests for deploy/sbx/mint-login.sh against a fake kubectl serving a moca-mu1 Secret with a fresh key:
# the login cache it writes verifies under the sandbox profile's API issuer, for the subject and roles
# asked, at mode 0600; a subject that is not enrolled, a Secret setup.sh did not write and bad flags
# are refused; the key and the token appear in no output.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MINT="$SRC/deploy/sbx/mint-login.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; [[ -f "$TMP/out" ]] && sed 's/^/  | /' "$TMP/out" >&2; exit 1; }
pass() { echo "ok - $*"; }
command -v node >/dev/null || { echo 'SKIP: mint-login.test.sh needs node'; exit 0; }

# A key as setup.sh stores it: PKCS#8 DER, base64 on one line, then base64 again as Secret data.
openssl genpkey -algorithm ed25519 -out "$TMP/k.pem" 2>/dev/null
openssl pkey -in "$TMP/k.pem" -outform DER -out "$TMP/k.der" 2>/dev/null
openssl pkey -inform DER -in "$TMP/k.der" -pubout -outform DER -out "$TMP/pub.der" 2>/dev/null
KEY_LINE="$(base64 <"$TMP/k.der" | tr -d '\n')"
PUB_B64="$(base64 <"$TMP/pub.der" | tr -d '\n')"
mkdir -p "$TMP/bin"
secret() { # secret LABEL-or-empty: the moca-mu1 JSON the fake kubectl serves
  jq -n --arg k "$(printf '%s' "$KEY_LINE" | base64 | tr -d '\n')" --arg l "$1" \
    '{metadata: {labels: (if $l == "" then {} else {"sbx.moca.dev/setup": $l} end)}, data: {SH_SESSION_TOKEN_PRIVATE_KEY: $k}}'
}
secret true >"$TMP/secret.json"
cat >"$TMP/bin/kubectl" <<MOCK
#!/usr/bin/env bash
printf 'kubectl %s\n' "\$*" >>"$TMP/kubectl.log"
if [[ "\$1 \$2 \$3" == 'get deploy moca-control-plane' ]]; then cat "$TMP/live-profile"; exit 0; fi
[[ "\$*" == 'get secret moca-mu1 -n sbx-test -o json' ]] || exit 1
cat "$TMP/secret.json"
MOCK
chmod +x "$TMP/bin/kubectl"
export PATH="$TMP/bin:$PATH"
printf 'sandbox' >"$TMP/live-profile"
printf 'SBX_NAMESPACE=sbx-test\nSBX_API_HOST=sbx-api.apps.example.invalid\nSBX_ALLOWED_SUBJECTS=github:1234,github:9999\nSBX_ADMIN_SUBJECTS=github:42\n' >"$TMP/env"
mkdir -p "$TMP/home-a" "$TMP/home-admin"

# The login: the token verifies under the sandbox API issuer with this key, for this subject.
verify() { # verify HOME SUBJECT ROLES_JSON [ISSUER_EXPORT] (from the control-plane package, where tsx resolves)
  cd "$SRC/packages/control-plane"
  SBX_PUB="$PUB_B64" SBX_FILE="$1/.config/mocactl/sbx-auth.json" SBX_SUB="$2" SBX_ROLES="$3" \
    node --import tsx --input-type=module -e "
      import { readFileSync } from 'node:fs';
      import { verifyToken, publicKeyFromBase64, ${4:-SANDBOX_API_ISSUER} as SANDBOX_API_ISSUER } from '$SRC/packages/control-plane/src/token.ts';
      const e = process.env, a = JSON.parse(readFileSync(e.SBX_FILE, 'utf8'));
      const keys = new Map([[JSON.parse(Buffer.from(a.apiToken.split('.')[0], 'base64url')).kid, publicKeyFromBase64(e.SBX_PUB)]]);
      const c = verifyToken(a.apiToken, keys, { issuer: SANDBOX_API_ISSUER, requiredScope: 'api' });
      const ok = c.sub === e.SBX_SUB && a.subject === e.SBX_SUB && JSON.stringify(c.roles) === e.SBX_ROLES
        && JSON.stringify(a.roles) === e.SBX_ROLES && a.controlPlaneUrl === 'https://sbx-api.apps.example.invalid'
        && a.expiresAt === c.exp && c.exp - c.iat === 3600;
      if (!ok) { console.error(JSON.stringify({ c, a: { ...a, apiToken: undefined } })); process.exit(1); }
    "
}
# From another directory, with a relative --home: the script finds tsx and the home itself.
(cd "$TMP" && bash "$MINT" --env-file "$TMP/env" --subject github:1234 --home home-a) >"$TMP/out" 2>&1 || fail 'mint a user login'
F="$TMP/home-a/.config/mocactl/sbx-auth.json"
[[ "$(stat -c %a "$F" 2>/dev/null || stat -f %Lp "$F")" == 600 ]] || fail 'the login file is not 0600'
verify "$TMP/home-a" github:1234 '[]' || fail 'the user token does not verify under the sandbox API issuer'
bash "$MINT" --env-file "$TMP/env" --subject github:42 --home "$TMP/home-admin" >"$TMP/out" 2>&1 || fail 'mint an admin login'
verify "$TMP/home-admin" github:42 '["admin"]' || fail 'an admin subject did not get the admin role'
[[ ! -e "$TMP/home-a/.config/mocactl/auth.json" ]] || fail 'a sandbox-profile login wrote auth.json'
pass 'writes a 0600 sbx-auth.json whose token verifies under the sandbox API issuer, with the admin role for an admin'

# A combined control plane (combined control plane spec §3.3): the harness issuer, which a sandbox
# stack on the same key refuses.
mkdir -p "$TMP/home-c"
cp "$TMP/env" "$TMP/env-c"; echo 'SBX_ROUTE_PROFILE=combined' >>"$TMP/env-c"
# The live control plane must run the same profile, or the login would be refused there.
! bash "$MINT" --env-file "$TMP/env-c" --subject github:1234 --home "$TMP/home-c" >"$TMP/out" 2>&1 || fail 'minted combined for a sandbox control plane'
grep -q 'runs SH_ROUTE_PROFILE=sandbox' "$TMP/out" || fail 'the profile mismatch refusal does not say why'
printf 'combined' >"$TMP/live-profile"
bash "$MINT" --env-file "$TMP/env-c" --subject github:1234 --home "$TMP/home-c" >"$TMP/out" 2>&1 || fail 'mint a combined login'
verify "$TMP/home-c" github:1234 '[]' DEFAULT_ISSUER || fail 'the combined token does not verify under the harness issuer'
! verify "$TMP/home-c" github:1234 '[]' 2>/dev/null || fail 'the combined token verifies under the sandbox issuer'
echo 'SBX_ROUTE_PROFILE=harness' >>"$TMP/env-c"
! bash "$MINT" --env-file "$TMP/env-c" --subject github:1234 --home "$TMP/home-c" >"$TMP/out" 2>&1 || fail 'accepted SBX_ROUTE_PROFILE=harness'
# setup.sh's SBX_PROFILE=combined alone does the same (one env file for both scripts).
printf 'combined' >"$TMP/live-profile"
cp "$TMP/env" "$TMP/env-p"; echo 'SBX_PROFILE=combined' >>"$TMP/env-p"
mkdir -p "$TMP/home-p"
bash "$MINT" --env-file "$TMP/env-p" --subject github:1234 --home "$TMP/home-p" >"$TMP/out" 2>&1 || fail 'mint a login from SBX_PROFILE=combined'
verify "$TMP/home-p" github:1234 '[]' DEFAULT_ISSUER || fail 'SBX_PROFILE=combined did not mint under the harness issuer'
# Combined: mocactl's own auth.json holds the same login (for `mocactl run`), also 0600.
cmp -s "$TMP/home-p/.config/mocactl/sbx-auth.json" "$TMP/home-p/.config/mocactl/auth.json" || fail 'no auth.json, or not the same login'
[[ "$(stat -c %a "$TMP/home-p/.config/mocactl/auth.json" 2>/dev/null || stat -f %Lp "$TMP/home-p/.config/mocactl/auth.json")" == 600 ]] || fail 'auth.json is not 0600'
grep -q 'sbx-auth.json and .*/auth.json, each 0600' "$TMP/out" || fail 'the summary does not name both files'
! grep -q 'replacing' "$TMP/out" || fail 'the first mint says it replaced an auth.json'
bash "$MINT" --env-file "$TMP/env-p" --subject github:1234 --home "$TMP/home-p" >"$TMP/out" 2>&1 || fail 'mint again'
grep -q 'replacing the auth.json there' "$TMP/out" || fail 'a second mint does not say it replaced auth.json'
printf 'sandbox' >"$TMP/live-profile"
pass 'mints under the harness issuer for SBX_ROUTE_PROFILE=combined (and writes it as auth.json too), never the sandbox one; refuses another profile, and a profile the live control plane does not run'

# Neither the key nor the token in any output.
tok="$(jq -r .apiToken "$F")"
for f in "$TMP/out" "$TMP/kubectl.log"; do
  ! grep -qF "$KEY_LINE" "$f" || fail "the key is in $f"
  ! grep -qF "$tok" "$f" || fail "the token is in $f"
done
pass 'prints neither the key nor the token'

# Refusals, each before a file is written.
check_refused() { # check_refused WHAT EXPECT ARGS...
  local what="$1" expect="$2"; shift 2
  rm -rf "$TMP/home-r"; mkdir -p "$TMP/home-r"
  ! bash "$MINT" "$@" >"$TMP/out" 2>&1 || fail "accepted $what"
  grep -q -- "$expect" "$TMP/out" || fail "the $what refusal does not say '$expect'"
  [[ ! -e "$TMP/home-r/.config/mocactl/sbx-auth.json" ]] || fail "wrote a login for $what"
}
check_refused 'a subject not enrolled' 'neither SBX_ALLOWED_SUBJECTS' --env-file "$TMP/env" --subject github:7 --home "$TMP/home-r"
check_refused 'a non-github subject' 'github:<numeric id>' --env-file "$TMP/env" --subject demo:1 --home "$TMP/home-r"
check_refused 'a TTL over a day' '1-1440' --env-file "$TMP/env" --subject github:1234 --home "$TMP/home-r" --ttl-minutes 1441
secret '' >"$TMP/secret.json"
check_refused 'a Secret setup.sh did not write' 'was not written by deploy/sbx/setup.sh' --env-file "$TMP/env" --subject github:1234 --home "$TMP/home-r"
pass 'refuses an unenrolled or non-github subject, a TTL over a day, and a Secret setup.sh did not write'
