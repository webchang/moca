import { posix } from 'node:path';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { TOKEN_MARGIN_S, WORKSPACE, writeFileCommand } from '@moca/sandbox-client';
import { sanitizeRemote } from '../core/sanitize.js';
import type { Io } from '../headless.js';
import { SBX_EXIT, type SbxCtx } from './commands.js';
import { EXIT_KILLED, execFailed, openExec, type ExecFactory } from './exec.js';
import { serveSbxMcp, stdioTransport } from './mcp.js';

/** `put`'s timeout: a write of at most 14 MiB, well inside any token's life (no extra mint). */
export const PUT_TIMEOUT_S = 120;

/**
 * `--timeout S`: a whole number of seconds, at least 1. Undefined when absent; null (after saying
 * why) when malformed. The upper bound is the token's, known only once one is minted.
 */
export function parseTimeout(io: Io, raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1) {
    io.err(`sbx: --timeout must be a whole number of seconds, at least 1 (got '${raw}')`);
    return null;
  }
  return n;
}

/** The command's own output, byte for byte: never decoded, never given a newline. */
function passThrough(io: Io, stdout: Buffer, stderr: Buffer): void {
  if (stdout.length) {
    if (io.outBytes) io.outBytes(stdout);
    else io.out(stdout.toString());
  }
  if (stderr.length) {
    if (io.errBytes) io.errBytes(stderr);
    else io.err(stderr.toString().replace(/\n$/, ''));
  }
}

/**
 * `mocactl sbx run` (SBX0 §6.1): one Exec, never retried once started. Exits with the command's
 * code; 124 when it timed out (`ExecError{"timeout:<n>"}`) or was killed; 125 when the sandbox
 * failed (`execFailed`). The timeout defaults to, and is capped at, the sandbox token's lifetime
 * minus 60 s (§6.5); a larger `--timeout` is clamped with a note.
 */
export async function cmdRun(
  c: SbxCtx,
  id: string,
  command: string,
  timeout: number | undefined,
  factory?: ExecFactory,
): Promise<number> {
  let x;
  try {
    x = await openExec(c.api, id, factory);
  } catch (err) {
    return execFailed(c, err);
  }
  try {
    // A token near the sandbox's end leaves no positive cap: send no timeout, so the exec client
    // says why ("the sandbox expires in N s; pull your work now") instead of a range error.
    const cap = x.lifetimeS - TOKEN_MARGIN_S > 0 ? x.lifetimeS - TOKEN_MARGIN_S : undefined;
    let timeoutS = timeout ?? cap;
    if (timeout !== undefined && cap !== undefined && timeout > cap) {
      c.io.err(
        `sbx: --timeout ${timeout}s is over what the sandbox token allows; running with ${cap}s ` +
          `(the token's lifetime minus ${TOKEN_MARGIN_S}s)`,
      );
      timeoutS = cap;
    }
    const r = await x.exec(command, {
      ...(timeoutS !== undefined ? { timeoutS } : {}),
      signal: c.signal,
    });
    passThrough(c.io, r.stdout, r.stderr);
    // mocactl's own notes start on a line of their own, after the command's stderr.
    const notes = r.truncated || r.capped || r.timedOutS !== undefined || r.exitCode < 0;
    if (notes && c.io.errBytes && r.stderr.length && r.stderr.at(-1) !== 0x0a) {
      c.io.errBytes(Buffer.from('\n'));
    }
    if (r.truncated) c.io.err("sbx: stdout exceeded the sandbox's 8 MiB cap and was cut");
    if (r.capped) {
      c.io.err('sbx: the timeout was cut to fit what the sandbox token had left');
    }
    if (r.timedOutS !== undefined) {
      c.io.err(`sbx: the command timed out after ${r.timedOutS}s`);
      return EXIT_KILLED;
    }
    if (r.exitCode < 0) {
      c.io.err('sbx: the command was killed (out of memory, or a signal)');
      return EXIT_KILLED;
    }
    return r.exitCode;
  } catch (err) {
    return execFailed(c, err);
  } finally {
    x.close();
  }
}

/**
 * Where `put PATH` writes: relative to /workspace, or an absolute path under it. Undefined for a
 * path outside /workspace, which no later Exec would see (each runs in a fresh VM).
 */
export function workspacePath(path: string): string | undefined {
  const p = posix.isAbsolute(path) ? posix.normalize(path) : posix.join(WORKSPACE, path);
  return p.startsWith(`${WORKSPACE}/`) ? p : undefined;
}

/** `mocactl sbx put PATH` (SBX0 §6.1): stdin, byte for byte, written atomically (`writeFileCommand`). */
export async function cmdPut(
  c: SbxCtx,
  id: string,
  /** Already resolved by `workspacePath`. */
  target: string,
  content: Buffer,
  factory?: ExecFactory,
): Promise<number> {
  let x;
  try {
    x = await openExec(c.api, id, factory);
  } catch (err) {
    return execFailed(c, err);
  }
  try {
    const r = await x.exec(writeFileCommand(target), {
      stdin: content,
      timeoutS: PUT_TIMEOUT_S,
      signal: c.signal,
    });
    if (r.exitCode !== 0) {
      c.io.err(
        `sbx: put failed: ${sanitizeRemote(r.stderr.toString().trim()) || `exit ${r.exitCode}`}`,
      );
      return SBX_EXIT.failed;
    }
    return SBX_EXIT.ok;
  } catch (err) {
    return execFailed(c, err);
  } finally {
    x.close();
  }
}

/**
 * `mocactl sbx mcp` (SBX0 §6.4): serves until the client closes stdin or the signal aborts. Only
 * MCP frames go to stdout; a failure to start is reported on stderr.
 */
export async function cmdMcp(
  c: SbxCtx,
  id: string,
  transport?: Transport,
  factory?: ExecFactory,
): Promise<number> {
  try {
    await serveSbxMcp(c, id, transport ?? (await stdioTransport()), factory);
    return SBX_EXIT.ok;
  } catch (err) {
    return execFailed(c, err);
  }
}
