import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SANDBOX_ID_RE } from './state.js';

/**
 * The flight recorder (SBX0 §6.4): one JSON line per tool call (ts, tool, ms, execs, ok, error) at
 * <state dir>/sbx/<sandbox id>.log, 0600 in a 0700 directory. Never command text, command output or
 * a token. `sbx doctor` summarizes it.
 */
function file(stateDir: string, id: string): string {
  // The id names a file: one that is not a sandbox id could name a path.
  if (!SANDBOX_ID_RE.test(id)) throw new Error(`'${id}' is not a sandbox id`);
  return join(stateDir, 'sbx', `${id}.log`);
}

export function recordCall(stateDir: string, id: string, rec: object): void {
  const f = file(stateDir, id);
  const dir = join(stateDir, 'sbx');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  appendFileSync(f, JSON.stringify(rec) + '\n', { mode: 0o600 });
  chmodSync(f, 0o600);
}

/** The records, oldest first; a torn or foreign line is skipped. */
export function readRecords(stateDir: string, id: string): Record<string, unknown>[] {
  const f = file(stateDir, id);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        const v = JSON.parse(l) as unknown;
        return v && typeof v === 'object' && !Array.isArray(v)
          ? [v as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
}
