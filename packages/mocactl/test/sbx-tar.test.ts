import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { tarEntries, type TarEntry } from '../src/sbx/tar.js';
import { PY_TAR_EXTRACT as PY_EXTRACT } from '../src/sbx/tar.js';

const LONG = 'd/'.repeat(70) + 'deep file — ünïcode.txt'; // > 100 bytes: needs a PAX path record
const LONG_LINK = 'x'.repeat(120); // a link target over the ustar linkname field
const T = 1_800_000_000;
const ENTRIES: TarEntry[] = [
  { path: 'a b/c.txt', type: 'file', mode: 0o644, data: Buffer.from('hello\n'), mtime: T },
  {
    path: 'bin/run.sh',
    type: 'file',
    mode: 0o755,
    data: Buffer.from('#!/bin/sh\necho hi\n'),
    mtime: T,
  },
  { path: 'ünï/文件.md', type: 'file', mode: 0o644, data: Buffer.from('x'), mtime: T },
  { path: LONG, type: 'file', mode: 0o644, data: Buffer.alloc(1000, 7), mtime: T },
  { path: 'link', type: 'symlink', mode: 0o777, linkname: 'a b/c.txt', mtime: T },
  { path: 'longlink', type: 'symlink', mode: 0o777, linkname: LONG_LINK, mtime: T },
  { path: 'ünïlink', type: 'symlink', mode: 0o777, linkname: 'ünï/文件.md', mtime: T },
  { path: 'empty', type: 'file', mode: 0o600, data: Buffer.alloc(0), mtime: T },
  // Exactly 100 bytes: fits the ustar name field with no NUL, and no PAX record.
  { path: 'e'.repeat(100), type: 'file', mode: 0o644, data: Buffer.from('100'), mtime: T },
  { path: 'blocks.bin', type: 'file', mode: 0o644, data: Buffer.alloc(512, 1), mtime: T },
];

/** Skipped only off CI when the reader is missing: under CI both readers must run (plan 1c R6f). */
const missing = (cmd: string) => !process.env.CI && Boolean(spawnSync(cmd, ['--version']).error);
const READERS: [string, string, string[]][] = [
  ['tar', 'tar', ['-xzf', '-']],
  ['python tarfile', 'python3', ['-c', PY_EXTRACT]],
];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the tar writer (SBX0 §6.2)', () => {
  for (const [n, cmd, args] of READERS) {
    it.skipIf(missing(cmd))(
      `round-trips names, modes, symlinks and long paths through ${n}`,
      () => {
        const d = mkdtempSync(join(tmpdir(), 'sbx-tar-'));
        dirs.push(d);
        execFileSync(cmd, args, { cwd: d, input: gzipSync(tarEntries(ENTRIES)) });
        expect(readFileSync(join(d, 'a b/c.txt'), 'utf8')).toBe('hello\n');
        expect(statSync(join(d, 'bin/run.sh')).mode & 0o111).not.toBe(0);
        expect(statSync(join(d, 'a b/c.txt')).mode & 0o111).toBe(0);
        expect(readFileSync(join(d, 'ünï/文件.md'), 'utf8')).toBe('x');
        expect(readFileSync(join(d, LONG))).toEqual(Buffer.alloc(1000, 7));
        expect(readlinkSync(join(d, 'link'))).toBe('a b/c.txt');
        expect(readlinkSync(join(d, 'longlink'))).toBe(LONG_LINK);
        // macOS bsdtar stores a link target NFD-normalized (as the filesystem's names); GNU tar and
        // Python keep the bytes. Either way the link resolves to the same file.
        expect(readlinkSync(join(d, 'ünïlink')).normalize('NFC')).toBe('ünï/文件.md');
        expect(readFileSync(join(d, 'ünïlink'), 'utf8')).toBe('x');
        expect(lstatSync(join(d, 'link')).isSymbolicLink()).toBe(true);
        expect(readFileSync(join(d, 'empty'))).toHaveLength(0);
        expect(readFileSync(join(d, 'e'.repeat(100)), 'utf8')).toBe('100');
        expect(readFileSync(join(d, 'blocks.bin'))).toEqual(Buffer.alloc(512, 1));
        // Nothing else was extracted: no PaxHeader file, no stray fallback names.
        const all = execFileSync('find', ['.', '-mindepth', '1', '-maxdepth', '1'], { cwd: d })
          .toString()
          .trim()
          .split('\n')
          .map((f) => f.normalize('NFC'))
          .sort();
        expect(all).toEqual(
          [
            './a b',
            './bin',
            './ünï',
            './d',
            './link',
            './longlink',
            './ünïlink',
            './empty',
            `./${'e'.repeat(100)}`,
            './blocks.bin',
          ].sort(),
        );
      },
    );
  }

  it('ends with two zero blocks and pads every member to 512 bytes', () => {
    const t = tarEntries([ENTRIES[0]!]);
    expect(t.length % 512).toBe(0);
    expect(t.length).toBe(512 + 512 + 1024); // header, one data block, the end
    expect(t.subarray(-1024).every((b) => b === 0)).toBe(true);
    expect(tarEntries([])).toEqual(Buffer.alloc(1024));
  });

  it('writes a valid ustar header: magic, octal fields and checksum', () => {
    const h = tarEntries([ENTRIES[1]!]).subarray(0, 512);
    expect(h.subarray(0, 10).toString()).toBe('bin/run.sh');
    expect(h.subarray(257, 265).toString('latin1')).toBe('ustar\u000000');
    expect(h.subarray(100, 108).toString()).toBe('0000755\0');
    expect(parseInt(h.subarray(124, 136).toString(), 8)).toBe(18);
    expect(parseInt(h.subarray(136, 148).toString(), 8)).toBe(T);
    expect(String.fromCharCode(h[156]!)).toBe('0');
    const stored = parseInt(h.subarray(148, 156).toString(), 8);
    const blank = Buffer.from(h);
    blank.fill(0x20, 148, 156);
    expect(stored).toBe(blank.reduce((a, b) => a + b, 0));
  });

  it('gives a long or non-ASCII name a PAX path record whose length counts itself', () => {
    const t = tarEntries([ENTRIES[3]!]);
    expect(String.fromCharCode(t[156]!)).toBe('x');
    const size = parseInt(t.subarray(124, 136).toString(), 8);
    const rec = t.subarray(512, 512 + size).toString('utf8');
    const m = /^(\d+) path=(.*)\n$/s.exec(rec)!;
    expect(m[2]).toBe(LONG);
    expect(Number(m[1])).toBe(Buffer.byteLength(rec));
  });

  it('counts a PAX record right when its length gains a digit (98 + "98" is 100: three digits)', () => {
    const path = 'é' + 'a'.repeat(89); // 91 bytes: " path=<91>\n" is 98 bytes
    const t = tarEntries([{ path, type: 'file', mode: 0o644, data: Buffer.from('x'), mtime: T }]);
    const size = parseInt(t.subarray(124, 136).toString(), 8);
    const rec = t.subarray(512, 512 + size).toString('utf8');
    expect(rec).toBe(`101 path=${path}\n`);
    expect(Buffer.byteLength(rec)).toBe(101);
  });

  it('gives a short non-ASCII name a PAX record too, and a plain ASCII one none', () => {
    expect(String.fromCharCode(tarEntries([ENTRIES[2]!])[156]!)).toBe('x');
    expect(String.fromCharCode(tarEntries([ENTRIES[0]!])[156]!)).toBe('0');
  });

  it('refuses what it cannot represent rather than writing a wrong archive', () => {
    const f = (o: Partial<TarEntry>): TarEntry => ({ ...ENTRIES[0]!, ...o });
    expect(() => tarEntries([f({ path: '' })])).toThrow(/path/);
    expect(() => tarEntries([f({ path: '/abs' })])).toThrow(/path/);
    expect(() => tarEntries([f({ path: 'a/../b' })])).toThrow(/path/);
    expect(() => tarEntries([f({ path: 'a\0b' })])).toThrow(/path/);
    expect(() => tarEntries([f({ mtime: -1 })])).not.toThrow(); // clamped to 0
  });
});
