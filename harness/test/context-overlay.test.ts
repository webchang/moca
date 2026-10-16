import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MAX_EXEC_MESSAGE_BYTES } from '@moca/k8s-sandbox';
import {
  buildContextAcquireScript,
  buildContextCleanupScript,
  buildContextPopulateScript,
  buildContextWritableScript,
  CONTEXT_CHUNK_BYTES,
  contextCacheDir,
  contextCacheKey,
  contextMaxEntries,
  contextRetainMinutes,
  contextRoot,
  overlayContext,
} from '../src/context-overlay.js';

const ok = (stdout = '') => ({ stdout: Buffer.from(stdout), exitCode: 0, truncated: false });

describe('P6 context overlay', () => {
  const digest = 'a'.repeat(64);
  const revision = contextCacheKey('0'.repeat(32), digest);

  it("keeps each owner's copy of a revision separate", () => {
    const alice = contextCacheKey('1'.repeat(32), digest);
    const bob = contextCacheKey('2'.repeat(32), digest);
    expect(contextCacheDir(alice)).not.toBe(contextCacheDir(bob));
    expect(() => contextCacheKey('not-a-scope', digest)).toThrow('cache scope');
    expect(() => contextCacheDir(digest)).toThrow('cache key');
  });

  it('keeps each raw binary chunk below the relay and worker receive limit', () => {
    expect(CONTEXT_CHUNK_BYTES).toBeLessThanOrEqual(MAX_EXEC_MESSAGE_BYTES / 2);
  });

  it('on a miss loads the bundle once, sends raw bytes, and verifies its digest', async () => {
    const exec = vi.fn().mockResolvedValueOnce(ok('miss')).mockResolvedValue(ok());
    const bundle = Buffer.from([0x1f, 0x8b, 0x00, 0x0a, 0xff]);
    const loadBundle = vi.fn(async () => bundle);
    const root = await overlayContext({ exec } as never, revision, 'run-1', loadBundle);

    expect(root).toBe('/workspace/.moca-context/runs/run-1');
    expect(loadBundle).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledTimes(3);
    expect(exec.mock.calls[1][0]).toContain('cat > ');
    // The exact bytes, not a base64 rendering of them.
    expect(exec.mock.calls[1][1].stdin).toEqual(bundle);
    const populate = exec.mock.calls[2][0] as string;
    expect(populate).toContain(createHash('sha256').update(bundle).digest('hex'));
    expect(populate).toContain('sha256sum -c --status');
    expect(populate).toContain('tar -xzf "$ARCHIVE" --no-same-owner --no-same-permissions');
    expect(populate).toContain('chmod -R u+rX,a-w "$STAGE"');
    expect(populate).toContain('[ -d "$CACHE" ] || mv "$STAGE" "$CACHE"');
  });

  it('on a hit binds in one exec and never fetches or transfers the bundle', async () => {
    const exec = vi.fn().mockResolvedValue(ok('hit'));
    const loadBundle = vi.fn();
    await overlayContext({ exec } as never, revision, 'run-2', loadBundle);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(loadBundle).not.toHaveBeenCalled();
    expect(exec.mock.calls[0][1].stdin).toBeUndefined();
  });

  it('rejects unsafe revision and session values before transport', async () => {
    const exec = vi.fn();
    await expect(overlayContext({ exec } as never, '../bad', 'run', vi.fn())).rejects.toThrow(
      'invalid context cache key',
    );
    expect(() => contextRoot('../run')).toThrow('invalid session id');
    expect(() => buildContextPopulateScript(revision, 'run', 'not-a-digest')).toThrow('digest');
    expect(exec).not.toHaveBeenCalled();
  });

  it('chunks binary input below the relay message ceiling and appends after the first', async () => {
    const exec = vi.fn().mockResolvedValueOnce(ok('miss')).mockResolvedValue(ok());
    const bundle = Buffer.alloc(CONTEXT_CHUNK_BYTES + 3, 7);
    await overlayContext({ exec } as never, revision, 'run-chunked', async () => bundle);
    const chunks = exec.mock.calls.filter(([script]) => script.includes('CONTEXT_UPLOAD_CHUNK'));
    expect(chunks.map((call) => call[1].stdin.length)).toEqual([CONTEXT_CHUNK_BYTES, 3]);
    expect(chunks[0][0]).toContain('cat > ');
    expect(chunks[1][0]).toContain('cat >> ');
  });

  it('rejects a corrupted transfer: the sandbox checks the digest before extracting', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(ok('miss'))
      .mockResolvedValueOnce(ok())
      // sha256sum -c fails, so the populate script exits before tar runs.
      .mockResolvedValueOnce({ stdout: Buffer.from(''), exitCode: 1, truncated: false })
      .mockResolvedValue(ok());
    const bundle = Buffer.from('bundle bytes');
    await expect(
      overlayContext({ exec } as never, revision, 'run-5', async () => bundle),
    ).rejects.toThrow('context overlay failed (exit 1)');
    const populate = exec.mock.calls[2][0] as string;
    expect(populate.indexOf('sha256sum -c')).toBeLessThan(populate.indexOf('tar -xzf'));
    expect(populate).toContain(createHash('sha256').update(bundle).digest('hex'));
    expect(exec.mock.calls.at(-1)![0]).toMatch(/^rm -f .*incoming\/0{32}-a{64}\.run-5\.context/);
  });

  it('caps the bundle entries before extracting: 10000 by default, like Context Service', () => {
    const populate = buildContextPopulateScript(revision, 'run-6', digest);
    expect(populate).toContain('[ "$ENTRIES" -le 10000 ]');
    expect(populate.indexOf('sha256sum -c')).toBeLessThan(populate.indexOf('tar -tzf'));
    expect(populate.indexOf('tar -tzf')).toBeLessThan(populate.indexOf('tar -xzf'));
    expect(buildContextPopulateScript(revision, 'run-6', digest, 7)).toContain('-le 7 ]');
    expect(contextMaxEntries({ MOCA_CONTEXT_BUNDLE_MAX_ENTRIES: '25' })).toBe(25);
    expect(contextMaxEntries({ MOCA_CONTEXT_BUNDLE_MAX_ENTRIES: 'many' })).toBe(10_000);
    expect(() => buildContextPopulateScript(revision, 'run-6', digest, 0)).toThrow('entry limit');
  });

  it('the entry cap refuses, in a real shell, an archive with more entries than the limit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'moca-context-entries-'));
    try {
      mkdirSync(join(dir, 'src'));
      for (const name of ['a', 'b', 'c']) writeFileSync(join(dir, 'src', name), name);
      const archive = join(dir, 'bundle.context');
      // COPYFILE_DISABLE keeps macOS tar from adding AppleDouble entries.
      execFileSync('tar', ['-czf', archive, '-C', join(dir, 'src'), 'a', 'b', 'c'], {
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      });
      const check = (limit: number) => {
        const line = buildContextPopulateScript(revision, 'run-7', digest, limit)
          .split('\n')
          .find((l) => l.includes('tar -tzf'))!;
        return () =>
          execFileSync(
            'bash',
            ['-c', `set -euo pipefail\nARCHIVE=$1\n${line}\necho ok`, '_', archive],
            {
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          ).toString();
      };
      expect(check(3)()).toBe('ok\n');
      expect(check(2)).toThrow(/context bundle has +3 entries, over 2/);
      // A corrupt archive fails the listing, so it is never extracted either.
      writeFileSync(archive, 'not gzip');
      expect(check(3)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('concurrent misses each publish under the lock, and only the first copy is kept', () => {
    const one = buildContextPopulateScript(revision, 'run-a', digest);
    const two = buildContextPopulateScript(revision, 'run-b', digest);
    // Separate uploads and staging dirs, so two runs never write the same file.
    expect(one).toContain(`incoming/${revision}.run-a.context`);
    expect(two).toContain(`incoming/${revision}.run-b.context`);
    expect(one).toContain(`cache/.stage.${revision}.run-a`);
    expect(two).toContain(`cache/.stage.${revision}.run-b`);
    // Publication is a single rename under flock, skipped when another run published first.
    const lock = one.indexOf('flock 9');
    expect(lock).toBeGreaterThan(one.indexOf('tar -xzf'));
    expect(one.indexOf('[ -d "$CACHE" ] || mv "$STAGE" "$CACHE"')).toBeGreaterThan(lock);
  });

  it('removes its partial upload when a transfer fails', async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce(ok('miss'))
      .mockResolvedValueOnce({ stdout: Buffer.from(''), exitCode: 1, truncated: false })
      .mockResolvedValue(ok());
    await expect(
      overlayContext({ exec } as never, revision, 'run-3', async () => Buffer.from('x')),
    ).rejects.toThrow('exit 1');
    expect(exec.mock.calls.at(-1)![0]).toMatch(/^rm -f .*incoming\/0{32}-a{64}\.run-3\.context/);
  });

  it('refuses an empty bundle', async () => {
    const exec = vi.fn().mockResolvedValue(ok('miss'));
    await expect(
      overlayContext({ exec } as never, revision, 'run-4', async () => Buffer.alloc(0)),
    ).rejects.toThrow('empty context bundle');
  });

  it('registers a ref before the presence check, under the sweep lock', () => {
    const script = buildContextAcquireScript(revision, 'run-1', 30);
    const ref = script.indexOf(`refs/${revision}/run-1`);
    expect(script.indexOf('flock 9')).toBeLessThan(ref);
    expect(ref).toBeLessThan(script.indexOf('if [ -d "$CACHE" ]'));
    expect(script).toContain('-mmin -30');
  });

  it('cleanup drops only this run and sweeps unreferenced caches past retention', () => {
    const script = buildContextCleanupScript(revision, 'run-1', 0);
    expect(script).toContain("ROOT='/workspace/.moca-context/runs/run-1'");
    expect(script).toContain('rm -rf "$ROOT"');
    expect(script).toContain(`rm -f "/workspace/.moca-context/refs/${revision}/run-1"`);
    expect(script).toContain('ls -A "/workspace/.moca-context/refs/$REV"');
    expect(script).toContain('-mmin -0');
  });

  it('retains nothing by default: shared sandboxes serve several users', () => {
    expect(contextRetainMinutes({})).toBe(0);
    expect(contextRetainMinutes({ MOCA_CONTEXT_SANDBOX_RETAIN_MINUTES: '30' })).toBe(30);
    expect(contextRetainMinutes({ MOCA_CONTEXT_SANDBOX_RETAIN_MINUTES: '-1' })).toBe(0);
    expect(contextRetainMinutes({ MOCA_CONTEXT_SANDBOX_RETAIN_MINUTES: 'x' })).toBe(0);
  });

  it('with the default retention, cleanup sweeps the revision once no run references it', () => {
    const script = buildContextCleanupScript(revision, 'run-1');
    expect(script).toContain('-mmin -0');
    // The ref is released before the sweep, both under the lock.
    const lock = script.indexOf('flock 9');
    const release = script.indexOf(`refs/${revision}/run-1`);
    expect(lock).toBeLessThan(release);
    expect(release).toBeLessThan(script.indexOf('rm -rf "$DIR"'));
  });

  it('a writable run copies the revision after binding it, on a hit and on a miss', async () => {
    const hit = vi.fn().mockResolvedValue(ok('hit'));
    await overlayContext({ exec: hit } as never, revision, 'run-w', vi.fn(), { writable: true });
    expect(hit.mock.calls.map(([script]) => script.split('\n')[1])).toEqual([
      '# CONTEXT_ACQUIRE',
      '# CONTEXT_WRITABLE_COPY',
    ]);

    const miss = vi.fn().mockResolvedValueOnce(ok('miss')).mockResolvedValue(ok());
    await overlayContext({ exec: miss } as never, revision, 'run-w', async () => Buffer.from('x'), {
      writable: true,
    });
    expect(miss.mock.calls.map(([script]) => script.split('\n')[1])).toEqual([
      '# CONTEXT_ACQUIRE',
      '# CONTEXT_UPLOAD_CHUNK',
      '# CONTEXT_POPULATE',
      '# CONTEXT_WRITABLE_COPY',
    ]);

    // Read-only is the default.
    const plain = vi.fn().mockResolvedValue(ok('hit'));
    await overlayContext({ exec: plain } as never, revision, 'run-r', vi.fn());
    expect(plain).toHaveBeenCalledTimes(1);
  });

  it('stages the writable copy and renames it into place, so it is never partial', () => {
    const script = buildContextWritableScript(revision, 'run-w');
    const order = [
      'cp -a "$SRC" "$STAGE"',
      'chmod -R u+w "$STAGE"\n',
      'touch "$STAGE"',
      'rm -rf "$ROOT"',
      'mv "$STAGE" "$ROOT"',
    ].map((step) => script.indexOf(step));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(script).toContain("STAGE='/workspace/.moca-context/runs/.stage.run-w'");
    expect(() => buildContextWritableScript(revision, '../run')).toThrow('invalid session id');
  });

  it('in a real shell, gives the run a writable copy, leaves the cache alone, and cleans up', () => {
    const base = mkdtempSync(join(tmpdir(), 'moca-context-writable-'));
    const local = (script: string) => script.replaceAll('/workspace/.moca-context', base);
    const sh = (script: string) =>
      execFileSync('bash', ['-c', local(script)], { stdio: ['ignore', 'pipe', 'pipe'] });
    const cache = join(base, 'cache', revision);
    const root = join(base, 'runs', 'run-w');
    try {
      mkdirSync(join(cache, 'src'), { recursive: true });
      mkdirSync(join(base, 'runs'));
      // Another run still references the revision, so the cleanup sweep keeps the cache.
      mkdirSync(join(base, 'refs', revision), { recursive: true });
      writeFileSync(join(base, 'refs', revision, 'other'), '');
      writeFileSync(join(cache, 'src', 'a.txt'), 'frozen');
      writeFileSync(join(cache, 'test.sh'), '#!/bin/sh\necho tests ok\n', { mode: 0o755 });
      // Make the cache read-only exactly as the populate script does.
      const readOnly = buildContextPopulateScript(revision, 'run-w', digest)
        .split('\n')
        .find((l) => l.includes('a-w'))!;
      execFileSync('bash', ['-c', `STAGE=$1\n${readOnly}`, '_', cache]);
      const mode = (path: string) => statSync(path).mode & 0o777;
      // Nothing is writable, directories stay traversable, and the script keeps its exec bit.
      expect([cache, join(cache, 'src'), join(cache, 'src', 'a.txt')].map(mode)).toEqual([
        0o555, 0o555, 0o444,
      ]);
      expect(mode(join(cache, 'test.sh'))).toBe(0o555);
      expect(() => writeFileSync(join(cache, 'src', 'a.txt'), 'x')).toThrow();
      symlinkSync(cache, root);

      sh(buildContextWritableScript(revision, 'run-w'));
      expect(lstatSync(root).isSymbolicLink()).toBe(false);
      writeFileSync(join(root, 'src', 'a.txt'), 'edited');
      writeFileSync(join(root, 'src', 'new.txt'), 'new');
      expect(mode(join(root, 'test.sh'))).toBe(0o755);
      expect(execFileSync('./test.sh', { cwd: root }).toString()).toBe('tests ok\n');
      expect(readFileSync(join(cache, 'src', 'a.txt'), 'utf8')).toBe('frozen');
      expect(mode(cache)).toBe(0o555);
      expect(mode(join(cache, 'src', 'a.txt'))).toBe(0o444);

      // The agent may leave its copy read-only; cleanup still removes it.
      chmodSync(join(root, 'src'), 0o555);
      sh(buildContextCleanupScript(revision, 'run-w', 0));
      expect(() => lstatSync(root)).toThrow();
      expect(() => lstatSync(join(base, 'runs', '.stage.run-w'))).toThrow();
      expect(readFileSync(join(cache, 'src', 'a.txt'), 'utf8')).toBe('frozen');
      expect(mode(cache)).toBe(0o555);
    } finally {
      execFileSync('chmod', ['-R', 'u+w', base]);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("roots every run's view at the revision's workspace/ directory when it has one", () => {
    const pick =
      'SRC="$CACHE"; if [ -d "$CACHE/workspace" ] && [ ! -L "$CACHE/workspace" ] && [ ! -e "$CACHE/harnesses" ] && [ ! -e "$CACHE/memory" ] && [ ! -e "$CACHE/knowledge" ] && [ ! -e "$CACHE/artifacts" ]; then SRC="$CACHE/workspace"; fi';
    const acquire = buildContextAcquireScript(revision, 'run-1');
    const populate = buildContextPopulateScript(revision, 'run-1', digest);
    const writable = buildContextWritableScript(revision, 'run-1');
    for (const script of [acquire, populate, writable]) {
      expect(script).toContain(pick);
      expect(script).not.toContain('ln -sfn "$CACHE"');
      expect(script).not.toContain('cp -a "$CACHE"');
    }
    expect(acquire).toContain(`then ${pick}; ln -sfn "$SRC" "$ROOT"; printf hit;`);
    // Picked after publication, under the lock, from whichever copy won.
    expect(populate.indexOf(pick)).toBeGreaterThan(
      populate.indexOf('[ -d "$CACHE" ] || mv "$STAGE" "$CACHE"'),
    );
    expect(populate.indexOf('ln -sfn "$SRC" "$ROOT"')).toBeGreaterThan(populate.indexOf(pick));
    expect(writable.indexOf('cp -a "$SRC" "$STAGE"')).toBeGreaterThan(writable.indexOf(pick));
  });

  it('in a real shell, a view shows workspace/ when the revision has it and the whole revision otherwise', () => {
    // macOS has no flock(1); the lock is not under test here.
    const noFlock = 'flock() { :; }\n';
    for (const shape of ['workspace', 'flat', 'workspace-link'] as const) {
      const base = mkdtempSync(join(tmpdir(), `moca-context-view-${shape}-`));
      const sh = (script: string) =>
        execFileSync(
          'bash',
          ['-c', noFlock + script.replaceAll('/workspace/.moca-context', base)],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        ).toString();
      const cache = join(base, 'cache', revision);
      const root = join(base, 'runs', 'run-v');
      const outside = join(base, 'outside');
      try {
        const files = shape === 'workspace' ? join(cache, 'workspace') : cache;
        mkdirSync(join(files, 'src'), { recursive: true });
        writeFileSync(join(files, 'src', 'greet.py'), 'print("hi")\n');
        if (shape === 'workspace') writeFileSync(join(cache, 'manifest.json'), '{}');
        // A bundled `workspace` link must never root a view outside the cache.
        if (shape === 'workspace-link') {
          mkdirSync(join(outside, 'secret'), { recursive: true });
          symlinkSync(outside, join(cache, 'workspace'));
        }
        const view = shape === 'workspace' ? join(cache, 'workspace') : cache;
        // Recently used, so the acquire's own sweep keeps the unreferenced revision for this hit.
        mkdirSync(join(base, 'used'), { recursive: true });
        writeFileSync(join(base, 'used', revision), '');

        expect(sh(buildContextAcquireScript(revision, 'run-v', 60))).toBe('hit');
        expect(lstatSync(root).isSymbolicLink()).toBe(true);
        expect(execFileSync('readlink', [root]).toString().trim()).toBe(view);
        expect(execFileSync('ls', [root]).toString()).toContain('src\n');
        expect(readFileSync(join(root, 'src', 'greet.py'), 'utf8')).toBe('print("hi")\n');

        sh(buildContextWritableScript(revision, 'run-v'));
        expect(lstatSync(root).isSymbolicLink()).toBe(false);
        expect(lstatSync(join(root, 'src')).isDirectory()).toBe(true);
        expect(() => lstatSync(join(root, 'manifest.json'))).toThrow();
        expect(() => lstatSync(join(root, 'secret'))).toThrow();
        writeFileSync(join(root, 'src', 'greet.py'), 'edited');
        expect(readFileSync(join(files, 'src', 'greet.py'), 'utf8')).toBe('print("hi")\n');

        sh(buildContextCleanupScript(revision, 'run-v', 0));
        expect(() => lstatSync(root)).toThrow();
        if (shape === 'workspace-link')
          expect(lstatSync(join(outside, 'secret')).isDirectory()).toBe(true);
      } finally {
        execFileSync('chmod', ['-R', 'u+w', base]);
        rmSync(base, { recursive: true, force: true });
      }
    }
  });

  it('in a real shell, a revision with workspace/ and other roots shows the whole revision', () => {
    const base = mkdtempSync(join(tmpdir(), 'moca-context-mixed-'));
    const sh = (script: string) =>
      execFileSync(
        'bash',
        ['-c', 'flock() { :; }\n' + script.replaceAll('/workspace/.moca-context', base)],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ).toString();
    const cache = join(base, 'cache', revision);
    const root = join(base, 'runs', 'run-m');
    try {
      mkdirSync(join(cache, 'workspace', 'src'), { recursive: true });
      writeFileSync(join(cache, 'workspace', 'src', 'greet.py'), 'print("hi")\n');
      mkdirSync(join(cache, 'memory'), { recursive: true });
      writeFileSync(join(cache, 'memory', 'notes.md'), 'remember\n');
      mkdirSync(join(base, 'used'), { recursive: true });
      writeFileSync(join(base, 'used', revision), '');

      expect(sh(buildContextAcquireScript(revision, 'run-m', 60))).toBe('hit');
      expect(execFileSync('readlink', [root]).toString().trim()).toBe(cache);
      const listing = execFileSync('ls', [root]).toString();
      expect(listing).toContain('workspace\n');
      expect(listing).toContain('memory\n');

      sh(buildContextWritableScript(revision, 'run-m'));
      expect(readFileSync(join(root, 'memory', 'notes.md'), 'utf8')).toBe('remember\n');
      expect(readFileSync(join(root, 'workspace', 'src', 'greet.py'), 'utf8')).toBe(
        'print("hi")\n',
      );
      sh(buildContextCleanupScript(revision, 'run-m', 0));
      expect(() => lstatSync(root)).toThrow();
    } finally {
      execFileSync('chmod', ['-R', 'u+w', base]);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('in a real shell, a populated revision with workspace/ links the view to it', () => {
    const base = mkdtempSync(join(tmpdir(), 'moca-context-populate-'));
    const src = mkdtempSync(join(tmpdir(), 'moca-context-bundle-'));
    try {
      mkdirSync(join(src, 'workspace', 'src'), { recursive: true });
      writeFileSync(join(src, 'workspace', 'src', 'greet.py'), 'print("hi")\n');
      mkdirSync(join(base, 'cache'), { recursive: true });
      mkdirSync(join(base, 'runs'));
      mkdirSync(join(base, 'incoming'));
      const archive = join(base, 'incoming', `${revision}.run-p.context`);
      execFileSync('tar', ['-czf', archive, '-C', src, 'workspace'], {
        env: { ...process.env, COPYFILE_DISABLE: '1' },
      });
      const sha = createHash('sha256').update(readFileSync(archive)).digest('hex');
      // No flock(1) on macOS, and its sha256sum lacks --status; neither is under test here.
      execFileSync('bash', [
        '-c',
        'flock() { :; }\nsha256sum() { cat >/dev/null; }\n' +
          buildContextPopulateScript(revision, 'run-p', sha).replaceAll(
            '/workspace/.moca-context',
            base,
          ),
      ]);
      const root = join(base, 'runs', 'run-p');
      expect(execFileSync('readlink', [root]).toString().trim()).toBe(
        join(base, 'cache', revision, 'workspace'),
      );
      expect(execFileSync('ls', [root]).toString()).toBe('src\n');
    } finally {
      execFileSync('chmod', ['-R', 'u+w', base]);
      rmSync(base, { recursive: true, force: true });
      rmSync(src, { recursive: true, force: true });
    }
  });

  it('cleanup never chmods through a read-only link into the cache', () => {
    const script = buildContextCleanupScript(revision, 'run-1');
    expect(script).toContain('[ -L "$ROOT" ] || chmod -R u+w "$ROOT"');
  });

  it('the sweep removes abandoned writable copies, never links', () => {
    const script = buildContextAcquireScript(revision, 'run-1');
    expect(script).toContain('for STALE in "/workspace/.moca-context"/runs/*');
    expect(script).toContain('[ -d "$STALE" ] && [ ! -L "$STALE" ]');
  });
});
