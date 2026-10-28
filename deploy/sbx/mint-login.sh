#!/usr/bin/env bash
# deploy/sbx/mint-login.sh -- a test login for an SBX0 deployment without GitHub's device flow: an API
# token minted with the deployment's own signing key, written as the login cache `mocactl sbx` reads.
#
#   deploy/sbx/mint-login.sh --env-file FILE --subject github:<id> --home DIR [--ttl-minutes N]
#
# For a deployment whose SBX_GITHUB_CLIENT_ID is a placeholder (no OAuth app), so `mocactl sbx login`
# cannot run: tests of the template API, the smoke's two users. The subject must be enrolled
# (SBX_ALLOWED_SUBJECTS or SBX_ADMIN_SUBJECTS), or every sandbox route refuses it. The login cannot
# refresh: it ends at its expiry (default 60 minutes, at most 1440); mint another.
#
# It reads the key from the Secret moca-mu1 in SBX_NAMESPACE (kubectl, the current context, as
# setup.sh) and writes DIR/.config/mocactl/sbx-auth.json, mode 0600, with XDG_CONFIG_HOME unset for
# its users, as smoke.sh runs mocactl. The key and the token never reach argv, the log or stdout:
# they travel through the environment of one node process.
#
# Anyone who can read Secrets in the namespace can do this, so it grants nothing an operator lacks.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$SCRIPT_DIR/../.." && pwd)"
die() { echo "deploy/sbx/mint-login.sh: $*" >&2; exit 2; }

ENV_FILE='' SUBJECT='' HOME_DIR='' TTL_MIN=60
while (($#)); do
  case "$1" in
    --env-file) [[ $# -ge 2 ]] || die '--env-file needs a value'; ENV_FILE="$2"; shift 2 ;;
    --subject) [[ $# -ge 2 ]] || die '--subject needs a value'; SUBJECT="$2"; shift 2 ;;
    --home) [[ $# -ge 2 ]] || die '--home needs a value'; HOME_DIR="$2"; shift 2 ;;
    --ttl-minutes) [[ $# -ge 2 ]] || die '--ttl-minutes needs a value'; TTL_MIN="$2"; shift 2 ;;
    *) die "unknown argument '$1' (usage: --env-file FILE --subject github:<id> --home DIR [--ttl-minutes N])" ;;
  esac
done
[[ -f "$ENV_FILE" ]] || die '--env-file FILE is required: the settings file setup.sh ran with'
[[ "$SUBJECT" =~ ^github:[0-9]+$ ]] || die '--subject must be github:<numeric id>'
[[ -n "$HOME_DIR" && -d "$HOME_DIR" ]] || die '--home must be an existing directory'
[[ "$TTL_MIN" =~ ^[1-9][0-9]*$ ]] && ((TTL_MIN <= 1440)) || die '--ttl-minutes must be 1-1440'
for t in kubectl jq node; do command -v "$t" >/dev/null || die "needs $t on PATH"; done

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
[[ -n "${SBX_NAMESPACE:-}" && -n "${SBX_API_HOST:-}" ]] || die "$ENV_FILE must set SBX_NAMESPACE and SBX_API_HOST"
enrolled=",${SBX_ALLOWED_SUBJECTS:-},${SBX_ADMIN_SUBJECTS:-},"
[[ "$enrolled" == *",$SUBJECT,"* ]] ||
  die "$SUBJECT is in neither SBX_ALLOWED_SUBJECTS nor SBX_ADMIN_SUBJECTS: add it and re-run setup.sh first"
roles='[]'
[[ ",${SBX_ADMIN_SUBJECTS:-}," != *",$SUBJECT,"* ]] || roles='["admin"]'

json="$(kubectl get secret moca-mu1 -n "$SBX_NAMESPACE" -o json)" || die "cannot read the Secret moca-mu1 in $SBX_NAMESPACE"
jq -e '.metadata.labels["sbx.moca.dev/setup"] == "true"' <<<"$json" >/dev/null ||
  die "moca-mu1 in $SBX_NAMESPACE was not written by deploy/sbx/setup.sh"
HOME_DIR="$(cd "$HOME_DIR" && pwd)"
cfg="$HOME_DIR/.config/mocactl"
mkdir -p "$cfg"
chmod 700 "$HOME_DIR/.config" "$cfg"

# The key leaves jq on a pipe into node's environment only; node writes the file itself. Run from the
# control-plane package, where `--import tsx` resolves (as its units start node).
cd "$SRC/packages/control-plane"
SBX_KEY_B64="$(jq -r '.data.SH_SESSION_TOKEN_PRIVATE_KEY // empty' <<<"$json")" \
  SBX_SUB="$SUBJECT" SBX_ROLES="$roles" SBX_TTL_S="$((TTL_MIN * 60))" SBX_URL="https://$SBX_API_HOST" \
  SBX_OUT="$cfg/sbx-auth.json" \
  node --import tsx --input-type=module -e "
    import { writeFileSync, renameSync } from 'node:fs';
    import { makeSigner, SANDBOX_API_ISSUER } from '$SRC/packages/control-plane/src/token.ts';
    const e = process.env;
    if (!e.SBX_KEY_B64) { console.error('moca-mu1 has no SH_SESSION_TOKEN_PRIVATE_KEY'); process.exit(1); }
    const key = Buffer.from(e.SBX_KEY_B64, 'base64').toString('utf8');
    const s = makeSigner(key);
    const now = Math.floor(Date.now() / 1000), ttl = Number(e.SBX_TTL_S), roles = JSON.parse(e.SBX_ROLES);
    const apiToken = s.mint({ sub: e.SBX_SUB, tenant: e.SBX_SUB, roles, scope: ['api'], ttlSeconds: ttl, now, iss: SANDBOX_API_ISSUER });
    const auth = { apiToken, subject: e.SBX_SUB, roles, expiresAt: now + ttl, controlPlaneUrl: e.SBX_URL };
    writeFileSync(e.SBX_OUT + '.new', JSON.stringify(auth) + '\n', { mode: 0o600 });
    renameSync(e.SBX_OUT + '.new', e.SBX_OUT);
  " || die 'could not mint the login'
echo "wrote a login for $SUBJECT ($(jq -r 'if .roles == ["admin"] then "admin" else "user" end' "$cfg/sbx-auth.json"), ${TTL_MIN} min) to $cfg/sbx-auth.json"
