import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MAX_EXEC_MESSAGE_BYTES } from '@moca/k8s-sandbox';
import {
  buildContextAcquireScript,
  buildContextCleanupScript,
  buildContextPopulateScript,
  CONTEXT_CHUNK_BYTES,
  contextCacheDir,
  contextCacheKey,
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
    expect(() => contextCacheKey('not-a-scope', digest)).toThrow('owner scope');
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
    expect(populate).toContain('chmod 0444');
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
    expect(script).toContain("rm -f '/workspace/.moca-context/runs/run-1'");
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
});
