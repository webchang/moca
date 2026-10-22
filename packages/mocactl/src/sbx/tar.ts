/**
 * A minimal tar writer (ustar, with PAX records for long or non-ASCII names and link targets):
 * enough for `mocactl sbx push` to send a working tree without a tar dependency (mocactl ships as
 * one file). GNU tar, bsdtar and Python's tarfile all read it; the tests extract with each.
 *
 * Only regular files and symlinks: directories are implied by the paths under them (git tracks no
 * empty directory, so a push has none to carry).
 */
export interface TarEntry {
  /** Relative, '/'-separated, with no `.` or `..` segment. */
  path: string;
  type: 'file' | 'symlink';
  /** Permission bits, e.g. 0o644 or 0o755. */
  mode: number;
  data?: Buffer;
  linkname?: string;
  /** Epoch seconds. */
  mtime: number;
}

/**
 * Python's tarfile reading a gzip tar from stdin into the current directory: the fallback for a
 * sandbox without `tar` (SBX0 §6.2). The `tar` filter (Python 3.12+) is used when present.
 */
export const PY_TAR_EXTRACT =
  'import sys,tarfile as t;a=t.open(fileobj=sys.stdin.buffer,mode="r|gz");' +
  'a.extractall(".",**({"filter":"tar"} if hasattr(t,"tar_filter") else {}))';

const BLOCK = 512;
/** The largest value an 11-digit octal field holds. */
const MAX_OCTAL_11 = 8 ** 11 - 1;

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

interface Header {
  size: number;
  mode: number;
  mtime: number;
  /** The ustar typeflag: '0' file, '2' symlink, 'x' PAX extended header. */
  type: string;
  linkname?: string;
}

function header(name: string, e: Header): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(e.mode & 0o7777, 8), 100, 'ascii');
  h.write(octal(0, 8), 108, 'ascii'); // uid
  h.write(octal(0, 8), 116, 'ascii'); // gid
  h.write(octal(e.size, 12), 124, 'ascii');
  h.write(octal(e.mtime, 12), 136, 'ascii');
  h.write('        ', 148, 'ascii'); // the checksum is summed with its own field as eight spaces
  h.write(e.type, 156, 'ascii');
  if (e.linkname) h.write(e.linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 'ascii');
  return h;
}

function pad(b: Buffer): Buffer[] {
  const r = b.length % BLOCK;
  return r ? [b, Buffer.alloc(BLOCK - r)] : [b];
}

/** One PAX record: "<len> <key>=<value>\n", where <len> counts the whole record, itself included. */
function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const n = Buffer.byteLength(body);
  let len = n + String(n).length;
  while (String(len).length + n !== len) len = String(len).length + n;
  return Buffer.from(`${len}${body}`, 'utf8');
}

/** Fits a ustar name or linkname field as is: printable ASCII, at most 100 bytes. */
const fitsUstar = (s: string) => s.length <= 100 && /^[\x20-\x7e]*$/.test(s);

function checkPath(p: string): void {
  const bad =
    !p ||
    p.startsWith('/') ||
    p.endsWith('/') ||
    p.includes('\0') ||
    p.split('/').some((s) => s === '' || s === '.' || s === '..');
  if (bad) throw new Error(`tar: not a relative path a tar member can have: ${JSON.stringify(p)}`);
}

export function tarEntries(entries: TarEntry[]): Buffer {
  const out: Buffer[] = [];
  for (const e of entries) {
    checkPath(e.path);
    const data = e.type === 'file' ? (e.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const link = e.type === 'symlink' ? (e.linkname ?? '') : undefined;
    if (link !== undefined && (link === '' || link.includes('\0'))) {
      throw new Error(`tar: symlink ${JSON.stringify(e.path)} has no usable target`);
    }
    const mtime = Math.min(Math.max(0, Math.floor(e.mtime)), MAX_OCTAL_11);
    const pathFits = fitsUstar(e.path);
    const linkFits = link === undefined || fitsUstar(link);
    if (!pathFits || !linkFits) {
      const recs = Buffer.concat([
        ...(pathFits ? [] : [paxRecord('path', e.path)]),
        ...(linkFits ? [] : [paxRecord('linkpath', link!)]),
      ]);
      out.push(header('PaxHeader', { size: recs.length, mode: 0o644, mtime, type: 'x' }));
      out.push(...pad(recs));
    }
    // A reader that honours PAX (all three do) ignores these fallbacks.
    const name = pathFits ? e.path : e.path.slice(-99).replace(/[^\x20-\x7e]/g, '_');
    out.push(
      header(name, {
        size: data.length,
        mode: e.mode,
        mtime,
        type: e.type === 'file' ? '0' : '2',
        ...(link !== undefined && linkFits ? { linkname: link } : {}),
      }),
    );
    if (data.length) out.push(...pad(data));
  }
  out.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(out);
}
