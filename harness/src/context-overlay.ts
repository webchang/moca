import { createHash } from 'node:crypto';
import type { SandboxTransport } from '@moca/k8s-sandbox';

/**
 * Delivers a workload's frozen Context Service revision into a shared P6 sandbox, read-only, for one
 * run. The sandbox keeps one extracted copy per owner and revision under `cache/`; each run
 * registers a ref on it and gets its own view at `runs/<session>`. The bundle crosses the relay only
 * on a miss. Keying the cache by owner means two users never share a copy, so one user's agent
 * cannot alter what another user's run reads, even when both uploaded identical content.
 */

/**
 * Bytes of bundle per SandboxExec. `Exec.stdin` is protobuf `bytes`, so the bundle travels raw (no
 * base64). Half the shared 16 MiB relay and worker receive limit (`MAX_EXEC_MESSAGE_BYTES`, pinned
 * by test) leaves room for the command and framing.
 */
export const CONTEXT_CHUNK_BYTES = 8 * 1024 * 1024;

const BASE = '/workspace/.moca-context';
const LOCK = `${BASE}/.lock`;
/** Age at which a ref, staging dir or upload is presumed abandoned by a harness that died. */
const STALE_MINUTES = 1440;
const SHA256 = /^[a-f0-9]{64}$/;

function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const OWNER_SCOPE = /^[a-f0-9]{32}$/;
const CACHE_KEY = /^[a-f0-9]{32}-[a-f0-9]{64}$/;

/** The sandbox cache key for one owner's revision: `<owner scope>-<revision>`. */
export function contextCacheKey(ownerScope: string, revision: string): string {
  if (!OWNER_SCOPE.test(ownerScope)) throw new Error('invalid context owner scope');
  if (!SHA256.test(revision)) throw new Error('invalid context revision');
  return `${ownerScope}-${revision}`;
}

function cacheKeyValue(key: string): string {
  if (!CACHE_KEY.test(key)) throw new Error('invalid context cache key');
  return key;
}

function sessionValue(sessionId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new Error('invalid session id for context overlay');
  }
  return sessionId;
}

/**
 * Minutes an unreferenced revision stays in the sandbox for a later run. Defaults to 0: shared
 * sandboxes serve several users, so a revision is removed as soon as no run references it. Raising
 * it saves a re-download for back-to-back runs at the cost of leaving the context on the sandbox.
 */
export function contextRetainMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.MOCA_CONTEXT_SANDBOX_RETAIN_MINUTES ?? '0', 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function contextCacheDir(key: string): string {
  return `${BASE}/cache/${cacheKeyValue(key)}`;
}

export function contextRoot(sessionId: string): string {
  return `${BASE}/runs/${sessionValue(sessionId)}`;
}

const uploadPath = (rev: string, sid: string) => `${BASE}/incoming/${rev}.${sid}.context`;

/**
 * Remove revisions that no live run references and no run used within the retention window, plus
 * anything a dead harness abandoned. Runs inside the caller's flock, so it cannot race the ref an
 * acquire writes. Dot-prefixed staging dirs are invisible to the `cache/*` glob.
 */
function sweepLines(retainMinutes: number): string[] {
  return [
    `  find "${BASE}/refs" -mindepth 2 -maxdepth 2 -type f -mmin +${STALE_MINUTES} -delete 2>/dev/null || true`,
    `  find "${BASE}/incoming" -mindepth 1 -maxdepth 1 -type f -mmin +${STALE_MINUTES} -delete 2>/dev/null || true`,
    `  for STALE in "${BASE}"/cache/.stage.*; do`,
    `    [ -d "$STALE" ] && [ -n "$(find "$STALE" -maxdepth 0 -mmin +${STALE_MINUTES})" ] || continue`,
    `    chmod -R u+w "$STALE" 2>/dev/null || true; rm -rf "$STALE" 2>/dev/null || true`,
    `  done`,
    `  for DIR in "${BASE}"/cache/*; do`,
    `    [ -d "$DIR" ] || continue`,
    `    REV="$(basename "$DIR")"`,
    `    [ -z "$(ls -A "${BASE}/refs/$REV" 2>/dev/null)" ] || continue`,
    // `-mmin -0` matches nothing, so a zero retention drops every unreferenced revision.
    `    [ -z "$(find "${BASE}/used/$REV" -mmin -${retainMinutes} 2>/dev/null)" ] || continue`,
    `    chmod -R u+w "$DIR" 2>/dev/null || true`,
    `    rm -rf "$DIR" 2>/dev/null || true`,
    `    rm -f "${BASE}/used/$REV"; rmdir "${BASE}/refs/$REV" 2>/dev/null || true`,
    `  done`,
    // Bookkeeping left by a run whose revision was never published (a failed transfer).
    `  for USED in "${BASE}"/used/*; do`,
    `    [ -f "$USED" ] || continue; REV="$(basename "$USED")"`,
    `    [ -d "${BASE}/cache/$REV" ] || [ -n "$(ls -A "${BASE}/refs/$REV" 2>/dev/null)" ] || rm -f "$USED"`,
    `  done`,
    `  rmdir "${BASE}"/refs/* 2>/dev/null || true`,
  ];
}

async function run(transport: SandboxTransport, script: string, stdin?: Buffer): Promise<string> {
  const result = await transport.exec(script, { timeout: 300, ...(stdin ? { stdin } : {}) });
  if (result.truncated) throw new Error('context overlay exceeded the sandbox output cap');
  if (result.exitCode !== 0) throw new Error(`context overlay failed (exit ${result.exitCode})`);
  return result.stdout.toString();
}

/**
 * Register this run on the revision and, when the sandbox already holds it, bind the run's view in
 * the same exec. The ref is written before the presence check, under the lock the sweep holds, so a
 * concurrent cleanup cannot delete a revision this run is about to use.
 */
export function buildContextAcquireScript(
  key: string,
  sessionId: string,
  retainMinutes = contextRetainMinutes(),
): string {
  const rev = cacheKeyValue(key);
  const sid = sessionValue(sessionId);
  return [
    'set -eu',
    '# CONTEXT_ACQUIRE',
    `CACHE=${sq(contextCacheDir(rev))}; ROOT=${sq(contextRoot(sid))}`,
    `mkdir -p "${BASE}/cache" "${BASE}/refs" "${BASE}/used" "${BASE}/runs" "${BASE}/incoming"`,
    '(',
    '  flock 9',
    ...sweepLines(retainMinutes),
    `  mkdir -p "${BASE}/refs/${rev}"`,
    `  : > "${BASE}/refs/${rev}/${sid}"`,
    `  touch "${BASE}/used/${rev}"`,
    '  if [ -d "$CACHE" ]; then ln -sfn "$CACHE" "$ROOT"; printf hit; else printf miss; fi',
    `) 9>"${LOCK}"`,
  ].join('\n');
}

/**
 * Verify the assembled upload against the digest Moca computed, extract it outside the lock into a
 * private staging dir beside the cache, make it read-only, then publish it with one same-directory
 * rename under the lock. A concurrent run that published first wins and this copy is discarded, so
 * a published revision is never partial.
 */
export function buildContextPopulateScript(key: string, sessionId: string, sha256: string): string {
  const rev = cacheKeyValue(key);
  const sid = sessionValue(sessionId);
  if (!SHA256.test(sha256)) throw new Error('invalid context bundle digest');
  return [
    'set -euo pipefail',
    '# CONTEXT_POPULATE',
    `CACHE=${sq(contextCacheDir(rev))}; ROOT=${sq(contextRoot(sid))}`,
    `ARCHIVE=${sq(uploadPath(rev, sid))}`,
    `STAGE=${sq(`${BASE}/cache/.stage.${rev}.${sid}`)}`,
    `trap 'chmod -R u+w "$STAGE" 2>/dev/null || true; rm -rf "$STAGE" "$ARCHIVE"' EXIT`,
    `printf '%s  %s\\n' ${sq(sha256)} "$ARCHIVE" | sha256sum -c --status`,
    'chmod -R u+w "$STAGE" 2>/dev/null || true; rm -rf "$STAGE"; mkdir -p "$STAGE"',
    'tar -xzf "$ARCHIVE" --no-same-owner --no-same-permissions -C "$STAGE"',
    'find "$STAGE" -type d -exec chmod 0555 {} +',
    'find "$STAGE" -type f -exec chmod 0444 {} +',
    '(',
    '  flock 9',
    '  [ -d "$CACHE" ] || mv "$STAGE" "$CACHE"',
    '  ln -sfn "$CACHE" "$ROOT"',
    `) 9>"${LOCK}"`,
  ].join('\n');
}

/**
 * Expose one frozen revision read-only to this run and return the path of its view. `loadBundle`
 * is called only when the sandbox lacks the revision; the bytes then go over SandboxExec stdin in
 * chunks and are checked against their sha256 in the sandbox before anything is extracted.
 *
 * The transport must be a P6 relay transport, whose stdin is binary-safe.
 */
export async function overlayContext(
  transport: SandboxTransport,
  key: string,
  sessionId: string,
  loadBundle: () => Promise<Buffer>,
): Promise<string> {
  const rev = cacheKeyValue(key);
  const sid = sessionValue(sessionId);
  const root = contextRoot(sid);
  if ((await run(transport, buildContextAcquireScript(rev, sid))).trim() === 'hit') return root;

  const bundle = await loadBundle();
  if (!Buffer.isBuffer(bundle) || bundle.length === 0) throw new Error('empty context bundle');
  const sha256 = createHash('sha256').update(bundle).digest('hex');
  const archive = sq(uploadPath(rev, sid));
  try {
    for (let offset = 0; offset < bundle.length; offset += CONTEXT_CHUNK_BYTES) {
      await run(
        transport,
        ['set -eu', '# CONTEXT_UPLOAD_CHUNK', `cat ${offset === 0 ? '>' : '>>'} ${archive}`].join(
          '\n',
        ),
        bundle.subarray(offset, Math.min(offset + CONTEXT_CHUNK_BYTES, bundle.length)),
      );
    }
    await run(transport, buildContextPopulateScript(rev, sid, sha256));
  } catch (err) {
    await run(transport, `rm -f ${archive} 2>/dev/null || true`).catch(() => {});
    throw err;
  }
  return root;
}

/**
 * Remove this run's view and ref, then sweep revisions past retention. Best effort (`set -u`): a
 * teardown hiccup must never mask the run's verdict.
 */
export function buildContextCleanupScript(
  key: string,
  sessionId: string,
  retainMinutes = contextRetainMinutes(),
): string {
  const rev = cacheKeyValue(key);
  const sid = sessionValue(sessionId);
  return [
    'set -u',
    '# CONTEXT_CLEANUP',
    `rm -f ${sq(contextRoot(sid))} ${sq(uploadPath(rev, sid))} 2>/dev/null || true`,
    `mkdir -p "${BASE}" 2>/dev/null || exit 0`,
    '(',
    '  flock 9 || exit 0',
    `  rm -f "${BASE}/refs/${rev}/${sid}" 2>/dev/null || true`,
    ...sweepLines(retainMinutes),
    `) 9>"${LOCK}"`,
  ].join('\n');
}
