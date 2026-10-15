import { createHash } from 'node:crypto';
import type { SandboxTransport } from '@moca/k8s-sandbox';

/**
 * Delivers a workload's frozen Context Service revision into a shared P6 sandbox, read-only, for one
 * run. The sandbox keeps one extracted copy per owner and revision under `cache/`; each run
 * registers a ref on it and gets its own view at `runs/<session>`. The bundle crosses the relay only
 * on a miss. A writable run gets its own copy of the cached revision there instead of a link, which
 * it may change and which cleanup removes; the cached copy stays read-only. Keying the cache by
 * owner means two users never share a copy, even when both uploaded identical content. The owner's
 * part of the key is an HMAC under a secret agents never see, so an agent cannot derive another
 * user's key from their name and plant a copy for a revision it knows.
 * It is not isolation: every agent runs as the same uid as these files, so it can still alter any
 * copy it can see, and learn that copy's scope from its name. The read-only modes stop accidents,
 * not a determined agent. Isolation between users needs separate sandboxes (rossoctl/moca#476,
 * phase 2 workloads).
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

const CACHE_SCOPE = /^[a-f0-9]{32}$/;
const CACHE_KEY = /^[a-f0-9]{32}-[a-f0-9]{64}$/;

/** The sandbox cache key for one owner's revision: `<cache scope>-<revision>`. */
export function contextCacheKey(cacheScope: string, revision: string): string {
  if (!CACHE_SCOPE.test(cacheScope)) throw new Error('invalid context cache scope');
  if (!SHA256.test(revision)) throw new Error('invalid context revision');
  return `${cacheScope}-${revision}`;
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

/**
 * Most entries a bundle may hold, `MOCA_CONTEXT_BUNDLE_MAX_ENTRIES`, default 10000 (Context
 * Service's own upload limit). Moca already bounds the bytes a bundle inflates to; this bounds the
 * inodes its extraction takes on a disk that several users share.
 */
export function contextMaxEntries(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.MOCA_CONTEXT_BUNDLE_MAX_ENTRIES ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 10_000;
}

export function contextCacheDir(key: string): string {
  return `${BASE}/cache/${cacheKeyValue(key)}`;
}

export function contextRoot(sessionId: string): string {
  return `${BASE}/runs/${sessionValue(sessionId)}`;
}

const uploadPath = (rev: string, sid: string) => `${BASE}/incoming/${rev}.${sid}.context`;
const writableStage = (sid: string) => `${BASE}/runs/.stage.${sid}`;

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
    // A writable copy, or its staging dir, left by a harness that died. Links are left alone.
    `  for STALE in "${BASE}"/runs/* "${BASE}"/runs/.stage.*; do`,
    `    [ -d "$STALE" ] && [ ! -L "$STALE" ] && [ -n "$(find "$STALE" -maxdepth 0 -mmin +${STALE_MINUTES})" ] || continue`,
    `    chmod -R u+w "$STALE" 2>/dev/null || true; rm -rf "$STALE" 2>/dev/null || true`,
    `  done`,
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
 * Verify the assembled upload against the digest Moca computed (transport integrity: the bytes are
 * the ones Moca sent), refuse it when it holds more than `maxEntries` entries, extract it outside the
 * lock into a private staging dir beside the cache, make it read-only (write bits removed, exec bits
 * kept, so a bundled script stays runnable), then publish it with one
 * same-directory rename under the lock. A concurrent run that published first wins and this copy is
 * discarded, so a published revision is never partial.
 */
export function buildContextPopulateScript(
  key: string,
  sessionId: string,
  sha256: string,
  maxEntries = contextMaxEntries(),
): string {
  const rev = cacheKeyValue(key);
  const sid = sessionValue(sessionId);
  if (!SHA256.test(sha256)) throw new Error('invalid context bundle digest');
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error('invalid context bundle entry limit');
  }
  return [
    'set -euo pipefail',
    '# CONTEXT_POPULATE',
    `CACHE=${sq(contextCacheDir(rev))}; ROOT=${sq(contextRoot(sid))}`,
    `ARCHIVE=${sq(uploadPath(rev, sid))}`,
    `STAGE=${sq(`${BASE}/cache/.stage.${rev}.${sid}`)}`,
    `trap 'chmod -R u+w "$STAGE" 2>/dev/null || true; rm -rf "$STAGE" "$ARCHIVE"' EXIT`,
    `printf '%s  %s\\n' ${sq(sha256)} "$ARCHIVE" | sha256sum -c --status`,
    `ENTRIES="$(tar -tzf "$ARCHIVE" | wc -l)"; [ "$ENTRIES" -le ${maxEntries} ] || { echo "context bundle has $ENTRIES entries, over ${maxEntries}" >&2; exit 1; }`,
    'chmod -R u+w "$STAGE" 2>/dev/null || true; rm -rf "$STAGE"; mkdir -p "$STAGE"',
    'tar -xzf "$ARCHIVE" --no-same-owner --no-same-permissions -C "$STAGE"',
    // `X` keeps every directory traversable; files keep their exec bits.
    'chmod -R u+rX,a-w "$STAGE"',
    '(',
    '  flock 9',
    '  [ -d "$CACHE" ] || mv "$STAGE" "$CACHE"',
    '  ln -sfn "$CACHE" "$ROOT"',
    `) 9>"${LOCK}"`,
  ].join('\n');
}

/**
 * Replace this run's read-only link with its own writable copy of the cached revision. The ref this
 * run holds keeps the cached copy from being swept while `cp -a` reads it, so the copy runs outside
 * the lock. It is staged beside the run's view and renamed into place, so the agent never sees a
 * partial copy. `touch` restarts the stage's age: `cp -a` keeps the cached copy's mtime, which the
 * sweep would otherwise read as abandoned.
 */
export function buildContextWritableScript(key: string, sessionId: string): string {
  const rev = cacheKeyValue(key);
  const sid = sessionValue(sessionId);
  return [
    'set -euo pipefail',
    '# CONTEXT_WRITABLE_COPY',
    `CACHE=${sq(contextCacheDir(rev))}; ROOT=${sq(contextRoot(sid))}`,
    `STAGE=${sq(writableStage(sid))}`,
    `trap 'chmod -R u+w "$STAGE" 2>/dev/null || true; rm -rf "$STAGE"' EXIT`,
    '[ -d "$CACHE" ]',
    'chmod -R u+w "$STAGE" 2>/dev/null || true; rm -rf "$STAGE"',
    'cp -a "$CACHE" "$STAGE"',
    'chmod -R u+w "$STAGE"',
    'touch "$STAGE"',
    // `rm -rf` on the link removes only the link, never the cached copy it points at.
    'rm -rf "$ROOT"',
    'mv "$STAGE" "$ROOT"',
  ].join('\n');
}

export interface OverlayContextOptions {
  /** Give the run its own writable copy at its view rather than a link to the read-only cache. */
  writable?: boolean;
}

/**
 * Expose one frozen revision to this run, read-only unless `writable`, and return the path of its
 * view. `loadBundle` is called only when the sandbox lacks the revision; the bytes then go over
 * SandboxExec stdin in chunks and are checked against their sha256 in the sandbox before anything is
 * extracted. That check proves the copy is intact, not which revision it is: Moca trusts Context
 * Service's authenticated export for that. A writable copy is made from the cached revision after
 * it is in place, so it doubles the bytes the revision takes on the sandbox for the run.
 *
 * The transport must be a P6 relay transport, whose stdin is binary-safe.
 */
export async function overlayContext(
  transport: SandboxTransport,
  key: string,
  sessionId: string,
  loadBundle: () => Promise<Buffer>,
  options: OverlayContextOptions = {},
): Promise<string> {
  const rev = cacheKeyValue(key);
  const sid = sessionValue(sessionId);
  const root = contextRoot(sid);
  if ((await run(transport, buildContextAcquireScript(rev, sid))).trim() !== 'hit') {
    await populate(transport, rev, sid, loadBundle);
  }
  if (options.writable) await run(transport, buildContextWritableScript(rev, sid));
  return root;
}

/** Load the bundle, send it over in chunks, and extract it into the cache. */
async function populate(
  transport: SandboxTransport,
  rev: string,
  sid: string,
  loadBundle: () => Promise<Buffer>,
): Promise<void> {
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
}

/**
 * Remove this run's view (a link, or a writable copy) and ref, then sweep revisions past retention.
 * Best effort (`set -u`): a teardown hiccup must never mask the run's verdict.
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
    `ROOT=${sq(contextRoot(sid))}; STAGE=${sq(writableStage(sid))}`,
    // Never `chmod -R` the link: chmod follows a link named on its command line, into the cache.
    '{ [ -L "$ROOT" ] || chmod -R u+w "$ROOT"; chmod -R u+w "$STAGE"; } 2>/dev/null || true',
    `rm -rf "$ROOT" "$STAGE" ${sq(uploadPath(rev, sid))} 2>/dev/null || true`,
    `mkdir -p "${BASE}" 2>/dev/null || exit 0`,
    '(',
    '  flock 9 || exit 0',
    `  rm -f "${BASE}/refs/${rev}/${sid}" 2>/dev/null || true`,
    ...sweepLines(retainMinutes),
    `) 9>"${LOCK}"`,
  ].join('\n');
}
