import { describe, expect, it, vi, afterEach } from 'vitest';
import { compactIfOverflowing, promptWouldOverflow } from '../src/pre-prompt-compaction';

// estimateTokens is chars/4: 16 000 characters is about 4 000 tokens.
const big = [{ role: 'user', content: 'x'.repeat(16_000), timestamp: 0 }] as never[];
const settings = { enabled: true, reserveTokens: 1_000, keepRecentTokens: 500 };

describe('promptWouldOverflow', () => {
  it('is true when the history leaves less than reserveTokens of the window', () => {
    expect(promptWouldOverflow(big, 4_500, settings)).toBe(true);
  });

  it('is false when it fits', () => {
    expect(promptWouldOverflow(big, 10_000, settings)).toBe(false);
  });

  it('is false with compaction disabled, no window, or no history', () => {
    expect(promptWouldOverflow(big, 4_500, { ...settings, enabled: false })).toBe(false);
    expect(promptWouldOverflow(big, undefined, settings)).toBe(false);
    expect(promptWouldOverflow([], 4_500, settings)).toBe(false);
  });
});

describe('compactIfOverflowing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const session = (
    contextWindow: number,
    compact = vi.fn(async () => ({})),
    abortCompaction = vi.fn(() => {}),
    lastEntryType = 'message',
  ) => ({
    messages: big,
    model: { contextWindow },
    settingsManager: { getCompactionSettings: () => settings },
    sessionManager: { getBranch: () => [{ type: 'message' }, { type: lastEntryType }] },
    compact,
    abortCompaction,
  });

  // PR #540 review R12: pi throws "Already compacted" on a compaction-last branch, and a window no
  // larger than reserve + keepRecent stays over the threshold even after compacting -- both turned
  // into a failure line (and an abort/disconnect cycle) on every turn.
  it('skips, silently, when the last branch entry is already a compaction', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = session(4_500, undefined, undefined, 'compaction');
    expect(await compactIfOverflowing(s)).toBe(false);
    expect(s.compact).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('skips, silently, when the window is no larger than reserveTokens + keepRecentTokens', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = session(1_500);
    expect(await compactIfOverflowing(s)).toBe(false);
    expect(s.compact).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('compacts when the next prompt would not fit', async () => {
    const s = session(4_500);
    expect(await compactIfOverflowing(s)).toBe(true);
    expect(s.compact).toHaveBeenCalledOnce();
  });

  it('leaves a history that fits alone', async () => {
    const s = session(10_000);
    expect(await compactIfOverflowing(s)).toBe(false);
    expect(s.compact).not.toHaveBeenCalled();
  });

  it('lets the turn proceed when compaction fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = session(
      4_500,
      vi.fn(async () => {
        throw new Error('Nothing to compact (session too small)');
      }),
    );
    expect(await compactIfOverflowing(s)).toBe(false);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toContain('pre-prompt compaction failed');
  });

  it('returns false without compacting when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const s = session(4_500);
    expect(await compactIfOverflowing(s, controller.signal)).toBe(false);
    expect(s.compact).not.toHaveBeenCalled();
  });

  it('calls abortCompaction when signal aborts during compaction', async () => {
    let resolveFakeCompact: () => void;
    const fakeCompact = new Promise<{}>((resolve) => {
      resolveFakeCompact = () => resolve({});
    });
    const s = session(
      4_500,
      vi.fn(async () => fakeCompact),
    );
    const controller = new AbortController();

    const promise = compactIfOverflowing(s, controller.signal);
    // Abort mid-compaction
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    // Resolve the fake compact to let the operation complete
    resolveFakeCompact!();
    await promise;

    expect(s.abortCompaction).toHaveBeenCalledOnce();
  });

  it('removes abort listener after normal compaction completes', async () => {
    const s = session(4_500);
    const controller = new AbortController();
    const removeEventListenerSpy = vi.spyOn(controller.signal, 'removeEventListener');

    await compactIfOverflowing(s, controller.signal);

    // Listener should have been removed
    expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));

    // Abort after compaction should not call abortCompaction
    controller.abort();
    expect(s.abortCompaction).not.toHaveBeenCalled();
  });

  it('does not log a cancelled compaction as a failure (final review F7)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const controller = new AbortController();
    const s = session(
      4_500,
      vi.fn(async () => {
        controller.abort();
        throw new Error('Compaction cancelled');
      }),
    );
    expect(await compactIfOverflowing(s, controller.signal)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(log.mock.calls.join('\n')).toContain('pre-prompt compaction cancelled');
  });
});
