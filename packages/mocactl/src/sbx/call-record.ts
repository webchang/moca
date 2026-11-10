import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';

/**
 * `--record F` (mocactl templates spec §3.8): one NDJSON line per HTTP attempt a command makes, so a
 * benchmark runner can drop its own client and still compose its provenance links from what
 * mocactl did. Each line: the command and an invocation id, the attempt number, the method, the
 * path (never the base URL or host), the status or the transport error, the request and answer
 * bodies, their times (UTC, ms) and the Retry-After.
 *
 * NO SECRET reaches the file: a token-named field and a gate record are replaced by their sha256,
 * and so is any string value, under any name, that looks like a JWT or a refresh token, so a token
 * field the API adds later is caught here. Host identifiers and free text (execEndpoint, execCa, an
 * egress event's dial_addr, a build log, a reason's message) are replaced by their length.
 *
 * The file is created 0600 and opened O_APPEND; an existing one with wider permissions is refused.
 * Each line is one write(2): under PIPE_BUF it needs nothing more; past it the write takes a lock
 * file beside F, so concurrent processes (a runner's 28 creates) can share one record.
 */

/** The refresh token's prefix (control-plane refresh-store.ts REFRESH_TOKEN_PREFIX). */
export const REFRESH_TOKEN_PREFIX = 'mrt_';
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/;
/** Fields whose value is a secret, whatever it looks like. */
const SECRET_FIELDS = new Set([
  'token',
  'refreshToken',
  'refresh_token',
  'sessionToken',
  'apiToken',
  'accessToken',
  'gateRecord',
  // A credential's value (`sbx credentials add` refuses --record; this is the backstop).
  'secret',
]);
/** Fields that name a host or carry free text: kept as their length only. */
const LENGTH_FIELDS = new Set(['execEndpoint', 'execCa', 'dial_addr', 'log']);
/** PIPE_BUF on Linux and macOS is at least 512; 4096 on both. */
const PIPE_BUF = 4096;
const LOCK_STALE_MS = 10_000;

const sha256 = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
const lengthOf = (v: unknown) => ({
  length: typeof v === 'string' ? v.length : JSON.stringify(v ?? null).length,
});
const secretLooking = (s: string) => JWT_RE.test(s) || s.startsWith(REFRESH_TOKEN_PREFIX);

/**
 * A body as the record keeps it. `parent` is the field this value sits under: a `message` in a
 * build's `reason` (or a log entry) is free text; a request's string `reason` is the caller's.
 */
export function redact(v: unknown, field?: string, parent?: string, request = false): unknown {
  if (field !== undefined && SECRET_FIELDS.has(field) && v !== null && v !== undefined)
    return typeof v === 'string' ? sha256(v) : sha256(JSON.stringify(v));
  if (field !== undefined && LENGTH_FIELDS.has(field) && v !== null && v !== undefined)
    return lengthOf(v);
  if (field === 'message' && parent === 'reason') return lengthOf(v);
  if (request && field === 'reason' && typeof v === 'string') return lengthOf(v);
  if (typeof v === 'string') return secretLooking(v) ? sha256(v) : v;
  if (Array.isArray(v)) return v.map((x) => redact(x, undefined, field, request));
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        k,
        redact(x, k, field, request),
      ]),
    );
  return v;
}

/** A body as text: JSON when it parses (then redacted), else its length (NDJSON, a proxy's page). */
function bodyOf(text: string | undefined, request: boolean): unknown {
  if (text === undefined || text === '') return undefined;
  try {
    return redact(JSON.parse(text), undefined, undefined, request);
  } catch {
    return { length: text.length };
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

export interface CallRecorder {
  /** `fetch`, recording each call. */
  wrap(fetchImpl: typeof fetch, baseUrl: string): typeof fetch;
  close(): void;
}

/**
 * Opens F for appending, or says why not (the caller refuses the command, exit 2). An existing F
 * readable or writable by anyone but its owner is refused; a new one is created 0600.
 */
export function openCallRecord(
  path: string,
  command: string,
  now: () => number = Date.now,
): CallRecorder | { error: string } {
  let fd: number;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (err) {
    return { error: `cannot open the record ${path}: ${(err as Error).message}` };
  }
  const st = fstatSync(fd);
  if (!st.isFile() || (st.mode & 0o077) !== 0) {
    closeSync(fd);
    return {
      error: `the record ${path} is ${st.isFile() ? `mode ${(st.mode & 0o777).toString(8)}` : 'not a regular file'}: it must be 0600 (or new), as it records your calls`,
    };
  }
  const invocation = randomUUID();
  let attempt = 0;
  const write = (rec: Record<string, unknown>) => {
    const line = Buffer.from(JSON.stringify(rec) + '\n', 'utf8');
    if (line.length <= PIPE_BUF) {
      writeSync(fd, line);
      return;
    }
    const release = lock(`${path}.lock`);
    try {
      writeSync(fd, line);
    } finally {
      release();
    }
  };
  return {
    wrap(fetchImpl, baseUrl) {
      const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
      return (async (input: string | URL | Request, init?: RequestInit) => {
        const u = new URL(String(input instanceof Request ? input.url : input));
        const p = u.pathname.startsWith(basePath) ? u.pathname.slice(basePath.length) : u.pathname;
        const rec: Record<string, unknown> = {
          command,
          invocation,
          attempt: ++attempt,
          method: init?.method ?? 'GET',
          path: (p || '/') + u.search,
          request: bodyOf(typeof init?.body === 'string' ? init.body : undefined, true),
          requestAt: iso(now()),
        };
        let res: Response;
        try {
          res = await fetchImpl(input, init);
        } catch (err) {
          write({
            ...rec,
            error: (err as { cause?: { code?: unknown } }).cause?.code ?? (err as Error).name,
            answerAt: iso(now()),
          });
          throw err;
        }
        const text = await res
          .clone()
          .text()
          .catch(() => undefined);
        const retryAfter = res.headers.get('retry-after');
        write({
          ...rec,
          status: res.status,
          answer: bodyOf(text, false),
          answerAt: iso(now()),
          ...(retryAfter !== null ? { retryAfter } : {}),
        });
        return res;
      }) as typeof fetch;
    },
    close() {
      closeSync(fd);
    },
  };
}

/** An O_EXCL lock file, waited on (a busy wait: lines this long are rare), broken once stale. */
function lock(path: string): () => void {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      closeSync(openSync(path, 'wx', 0o600));
      return () => rmSync(path, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return () => {};
    }
    try {
      if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) rmSync(path, { force: true });
    } catch {
      // released meanwhile
    }
    Atomics.wait(wait, 0, 0, 5);
  }
}
