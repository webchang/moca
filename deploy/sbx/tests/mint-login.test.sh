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
[[ "\$*" == 'get secret moca-mu1 -n sbx-test -o json' ]] || exit 1
cat "$TMP/secret.json"
MOCK
chmod +x "$TMP/bin/kubectl"
export PATH="$TMP/bin:$PATH"
printf 'SBX_NAMESPACE=sbx-test\nSBX_API_HOST=sbx-api.apps.example.invalid\nSBX_ALLOWED_SUBJECTS=github:1234,github:9999\nSBX_ADMIN_SUBJECTS=github:42\n' >"$TMP/env"
mkdir -p "$TMP/home-a" "$TMP/home-admin"

# The login: the token verifies under the sandbox API issuer with this key, for this subject.
verify() { # verify HOME SUBJECT ROLES_JSON (from the control-plane package, where tsx resolves)
  cd "$SRC/packages/control-plane"
  SBX_PUB="$PUB_B64" SBX_FILE="$1/.config/mocactl/sbx-auth.json" SBX_SUB="$2" SBX_ROLES="$3" \
    node --import tsx --input-type=module -e "
      import { readFileSync } from 'node:fs';
      import { verifyToken, publicKeyFromBase64, SANDBOX_API_ISSUER } from '$SRC/packages/control-plane/src/token.ts';
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
pass 'writes a 0600 sbx-auth.json whose token verifies under the sandbox API issuer, with the admin role for an admin'

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
