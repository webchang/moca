import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * What a sandbox id may look like on this side: `sbx-` and lowercase alphanumerics (the control
 * plane issues `sbx-` plus 26 hex, SBX0 §5.1). Checked before an id reaches a URL or a file name,
 * so a hand-edited `.sbx/sandbox.json` or argument cannot name a path.
 */
export const SANDBOX_ID_RE = /^sbx-[0-9a-z]{1,64}$/;

/**
 * A path component as a case-folding filesystem might resolve it: NFKC (which maps U+017F `ſ` to
 * `s`, and full-width letters to ASCII), then lowercased both directly and through uppercase.
 * APFS folds `.ſbx` and `.SBX` to `.sbx`. Erring wide is safe: a look-alike is only refused.
 */
export function folds(seg: string): string[] {
  // NTFS also drops trailing dots and spaces (`.claude.`, `.envrc `), as Windows resolves a name.
  const k = seg.normalize('NFKC').replace(/[. ]+$/, '');
  return [k.toLowerCase(), k.toUpperCase().toLowerCase()];
}

/**
 * A path's components as Windows would split them: on `\` as well as `/`. git keeps a backslash
 * as an ordinary byte in a name, which NTFS then reads as a separator.
 */
export const segments = (p: string): string[] => p.split(/[\\/]/);

/**
 * Why the repository's `.sbx/` cannot be trusted as this laptop's state, or undefined when it can.
 * A symlink would have `up` write (and `rm` delete) outside the repository; a tracked one came with
 * the clone, so its binding (which names a control plane) and its record of what `up` added are
 * the repository's say-so, not this laptop's (#554 review). `sbx up` keeps `.sbx/` untracked by
 * excluding it, so neither is ever its own doing.
 */
export function sbxDirProblem(root: string): string | undefined {
  const dir = join(root, '.sbx');
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return undefined;
  }
  if (st.isSymbolicLink()) return 'is a symlink';
  if (!st.isDirectory()) return 'is not a directory';
  let tracked = '';
  try {
    tracked = execFileSync('git', ['ls-files', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 1 << 30,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined; // not a git repository: nothing can be tracked
  }
  // Folded as the filesystem resolves it, not git's case-sensitive pathspec: on macOS and Windows a
  // tracked `.SBX/sandbox.json` is the file `join(root, '.sbx', ...)` opens (#554 review).
  const isTracked = tracked
    .split('\0')
    .some((p) => p !== '' && folds(segments(p)[0]!).includes('.sbx'));
  return isTracked ? 'is tracked by git (it came with the repository)' : undefined;
}

/**
 * The repository's bound sandbox: `.sbx/sandbox.json` in the nearest directory up from `cwd`,
 * stopping at a repository root (a `.git` entry) or `/`. `mocactl sbx up` (1c) writes it; every
 * other command reads it when no id is given (SBX0 §6.1).
 */
export function findSandboxFile(cwd: string): string | undefined {
  let dir = cwd;
  for (;;) {
    const f = join(dir, '.sbx', 'sandbox.json');
    // A symlinked or tracked .sbx/ is never this laptop's binding (sbxDirProblem).
    if (existsSync(f)) return sbxDirProblem(dir) ? undefined : f;
    if (existsSync(join(dir, '.git'))) return undefined;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

export function readBoundSandbox(cwd: string): string | undefined {
  const f = findSandboxFile(cwd);
  if (!f) return undefined;
  try {
    const id = (JSON.parse(readFileSync(f, 'utf8')) as { id?: unknown }).id;
    return typeof id === 'string' && SANDBOX_ID_RE.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A binding's control-plane URL: http(s), and printable ASCII only (no space, no control character,
 * nothing a terminal would act on when the URL is printed).
 */
export const BINDING_URL_RE = /^https?:\/\/[\x21-\x7e]+$/i;

/**
 * The binding as written, unvalidated: the caller checks the id (`SANDBOX_ID_RE`) and reports a bad
 * one, rather than treating it as no binding. `controlPlaneUrl` is the control plane `sbx up` used,
 * kept only when it is an http(s) URL.
 */
export function readBinding(cwd: string): { id: string; controlPlaneUrl?: string } | undefined {
  const f = findSandboxFile(cwd);
  if (!f) return undefined;
  try {
    const b = JSON.parse(readFileSync(f, 'utf8')) as { id?: unknown; controlPlaneUrl?: unknown };
    if (typeof b.id !== 'string') return undefined;
    const url = typeof b.controlPlaneUrl === 'string' ? b.controlPlaneUrl : undefined;
    return {
      id: b.id,
      ...(url && BINDING_URL_RE.test(url) ? { controlPlaneUrl: url } : {}),
    };
  } catch {
    return undefined;
  }
}
