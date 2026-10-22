import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runMarkerKey,
  runHeartbeatKey,
  runLeaseTimings,
  beginRunLease,
  reapOrphanedRuns,
  type RunLeaseStore,
} from '../src/run-lease';
import { readResult, toResultRecord, writeResult } from '../src/leaf-result-store';

/**
 * In-memory RunLeaseStore with real TTL semantics: `expires` holds absolute deadlines (ms) and
 * `get`/`getdel`/`keys` hide keys past theirs, so a heartbeat that stopped refreshing reads as
 * stale exactly the way it does against Redis.
 */
function fakeStore() {
  const data = new Map<string, string>();
  const expires = new Map<string, number>();
  let now = 0;
  const live = (key: string): boolean => {
    const at = expires.get(key);
    return at === undefined || at > now;
  };
  const purge = () => {
    for (const key of data.keys()) if (!live(key)) data.delete(key);
  };
  return {
    data,
    expires,
    clock: {
      get now() {
        return now;
      },
      advance(ms: number) {
        now += ms;
        purge();
      },
    },
    async set(key: string, value: string, opts?: { EX?: number }) {
      data.set(key, value);
      if (opts?.EX) expires.set(key, now + opts.EX * 1000);
      else expires.delete(key);
    },
    async get(key: string) {
      return live(key) ? (data.get(key) ?? null) : null;
    },
    async del(key: string) {
      data.delete(key);
      expires.delete(key);
    },
    async getdel(key: string) {
      const v = live(key) ? (data.get(key) ?? null) : null;
      data.delete(key);
      expires.delete(key);
      return v;
    },
    async keys(pattern: string) {
      const re = new RegExp(
        '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
      );
      return [...data.keys()].filter((k) => live(k) && re.test(k));
    },
  };
}

type FakeStore = ReturnType<typeof fakeStore> & RunLeaseStore;

describe('run lease keys', () => {
  it('namespaces marker and heartbeat by leaf session id', () => {
    expect(runMarkerKey('run-1-i1')).toBe('sh:run:run-1-i1');
    expect(runHeartbeatKey('run-1-i1')).toBe('sh:run:run-1-i1:hb');
  });
});

describe('runLeaseTimings', () => {
  it('defaults heartbeat to 10 s and staleness to 60 s', () => {
    expect(runLeaseTimings({})).toEqual({ heartbeatMs: 10_000, staleMs: 60_000 });
  });
  it('reads SH_RUN_HEARTBEAT_MS and SH_RUN_STALE_MS overrides', () => {
    expect(runLeaseTimings({ SH_RUN_HEARTBEAT_MS: '2000', SH_RUN_STALE_MS: '9000' })).toEqual({
      heartbeatMs: 2000,
      staleMs: 9000,
    });
  });
  it('falls back to defaults on non-positive or non-integer values', () => {
    expect(runLeaseTimings({ SH_RUN_HEARTBEAT_MS: '0', SH_RUN_STALE_MS: 'x' })).toEqual({
      heartbeatMs: 10_000,
      staleMs: 60_000,
    });
  });
  it('clamps staleMs to at least twice the heartbeat interval', () => {
    // 60000/60000 would make every live run read as dead between beats; the clamp keeps
    // the reaper from failing them all.
    expect(runLeaseTimings({ SH_RUN_HEARTBEAT_MS: '60000', SH_RUN_STALE_MS: '60000' })).toEqual({
      heartbeatMs: 60_000,
      staleMs: 120_000,
    });
  });
});

describe('beginRunLease', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes the marker and the first heartbeat', async () => {
    const store = fakeStore();
    const lease = beginRunLease(store, 'run-1-i1', {
      owner: 'pod-1:42',
      rawSessionId: 'run/1/i1',
      ttlSeconds: 86400,
      timings: { heartbeatMs: 1000, staleMs: 5000 },
    });
    await lease.ready;
    expect(JSON.parse(store.data.get(runMarkerKey('run-1-i1'))!)).toMatchObject({
      owner: 'pod-1:42',
      rawSessionId: 'run/1/i1',
    });
    expect(store.data.get(runHeartbeatKey('run-1-i1'))).toBe('1');
  });

  it('refreshes the heartbeat on the interval so it outlives short stalls', async () => {
    const store = fakeStore();
    const lease = beginRunLease(store, 'run-1-i1', {
      owner: 'pod-1:42',
      rawSessionId: 'run/1/i1',
      ttlSeconds: 86400,
      timings: { heartbeatMs: 1000, staleMs: 5000 },
    });
    await lease.ready;
    // Past one stale window with heartbeats landing: still alive.
    store.clock.advance(4000);
    vi.advanceTimersByTime(4000);
    expect(store.data.get(runHeartbeatKey('run-1-i1'))).toBe('1');
    // Heartbeat stopped (holder died): the key expires after the stale window.
    store.clock.advance(6000);
    expect(store.data.get(runHeartbeatKey('run-1-i1'))).toBeUndefined();
  });

  it('release clears both keys and stops the heartbeat', async () => {
    const store = fakeStore();
    const lease = beginRunLease(store, 'run-1-i1', {
      owner: 'pod-1:42',
      rawSessionId: 'run/1/i1',
      ttlSeconds: 86400,
      timings: { heartbeatMs: 1000, staleMs: 5000 },
    });
    await lease.release();
    expect(store.data.get(runMarkerKey('run-1-i1'))).toBeUndefined();
    expect(store.data.get(runHeartbeatKey('run-1-i1'))).toBeUndefined();
    // No heartbeat resurrects the key after release.
    store.clock.advance(2000);
    vi.advanceTimersByTime(2000);
    expect(store.data.has(runHeartbeatKey('run-1-i1'))).toBe(false);
  });

  it('fails open: a store error yields a no-op lease rather than a failed run', async () => {
    const store: RunLeaseStore = {
      set: () => Promise.reject(new Error('redis down')),
      get: () => Promise.resolve(null),
      del: () => Promise.resolve(),
      getdel: () => Promise.resolve(null),
      keys: () => Promise.resolve([]),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lease = beginRunLease(store, 'run-1-i1', {
      owner: 'pod-1:42',
      rawSessionId: 'run/1/i1',
      ttlSeconds: 86400,
    });
    await expect(lease.release()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('reapOrphanedRuns', () => {
  it('finalizes a dead holder as a failed result and clears the lease keys', async () => {
    const store: FakeStore = fakeStore();
    // The crash's leftovers: marker present, heartbeat key expired past its stale window.
    await store.set(
      runMarkerKey('run-1-i1'),
      JSON.stringify({ owner: 'pod-1:42', rawSessionId: 'run/1/i1', startedAt: 0 }),
      { EX: 86400 },
    );
    await store.set(runHeartbeatKey('run-1-i1'), '1', { EX: 5 });
    store.clock.advance(6000);

    const onReap = vi.fn();
    const reaped = await reapOrphanedRuns(store, { ttlSeconds: 86400, onReap });
    expect(reaped).toEqual([{ sid: 'run-1-i1', rawSessionId: 'run/1/i1', owner: 'pod-1:42' }]);
    expect(onReap).toHaveBeenCalledWith({
      sid: 'run-1-i1',
      rawSessionId: 'run/1/i1',
      owner: 'pod-1:42',
    });
    const record = await readResult(store, 'run-1-i1');
    expect(record).toMatchObject({ status: 'failed', reason: 'owner_lost', sessionId: 'run/1/i1' });
    expect(store.data.get(runMarkerKey('run-1-i1'))).toBeUndefined();
    expect(store.data.get(runHeartbeatKey('run-1-i1'))).toBeUndefined();
  });

  it('leaves alone a run that finalized itself before its marker release was lost', async () => {
    const store: FakeStore = fakeStore();
    const startedAt = Date.parse('2026-10-21T00:00:00Z');
    await store.set(
      runMarkerKey('run-1-i1'),
      JSON.stringify({ owner: 'pod-1:42', rawSessionId: 'run/1/i1', startedAt }),
      { EX: 86400 },
    );
    // No heartbeat (expired) plus a result the holder wrote after the marker started: the
    // SIGKILL-between-writeResult-and-release shape. The reaper must not turn it into
    // owner_lost.
    await writeResult(
      store,
      'run-1-i1',
      toResultRecord(
        { status: 'done', verdict: { item_id: 'i1', verdict: 'CLEAR', reason: 'ok' } },
        'run/1/i1',
        new Date(startedAt + 1000).toISOString(),
      ),
      86400,
    );
    const onReap = vi.fn();
    const reaped = await reapOrphanedRuns(store, { ttlSeconds: 86400, onReap });
    expect(reaped).toEqual([]);
    expect(onReap).not.toHaveBeenCalled();
    expect(await readResult(store, 'run-1-i1')).toMatchObject({ status: 'done' });
    expect(store.data.get(runMarkerKey('run-1-i1'))).toBeUndefined();
  });

  it('still reaps over a record older than the marker (a previous run of the same sid)', async () => {
    const store: FakeStore = fakeStore();
    const startedAt = Date.parse('2026-10-21T00:00:00Z');
    await store.set(
      runMarkerKey('run-1-i1'),
      JSON.stringify({ owner: 'pod-1:42', rawSessionId: 'run/1/i1', startedAt }),
      { EX: 86400 },
    );
    await writeResult(
      store,
      'run-1-i1',
      toResultRecord(
        { status: 'done', verdict: { item_id: 'i1', verdict: 'CLEAR', reason: 'ok' } },
        'run/1/i1',
        new Date(startedAt - 5000).toISOString(),
      ),
      86400,
    );
    const reaped = await reapOrphanedRuns(store, { ttlSeconds: 86400 });
    expect(reaped).toEqual([{ sid: 'run-1-i1', rawSessionId: 'run/1/i1', owner: 'pod-1:42' }]);
    expect(await readResult(store, 'run-1-i1')).toMatchObject({
      status: 'failed',
      reason: 'owner_lost',
    });
  });

  it('skips a run whose heartbeat is still alive', async () => {
    const store: FakeStore = fakeStore();
    await store.set(
      runMarkerKey('run-1-i1'),
      JSON.stringify({ owner: 'pod-1:42', rawSessionId: 'run/1/i1', startedAt: 0 }),
      { EX: 86400 },
    );
    await store.set(runHeartbeatKey('run-1-i1'), '1', { EX: 60 });
    const reaped = await reapOrphanedRuns(store, { ttlSeconds: 86400 });
    expect(reaped).toEqual([]);
    expect(store.data.get(runMarkerKey('run-1-i1'))).toBeDefined();
    expect(await readResult(store, 'run-1-i1')).toBeNull();
  });

  it('skips when the marker is already gone (another reaper claimed it)', async () => {
    const store: FakeStore = fakeStore();
    await store.set(runHeartbeatKey('run-1-i1'), '1', { EX: 1 });
    store.clock.advance(2000);
    // No marker at all: nothing to claim.
    const reaped = await reapOrphanedRuns(store, { ttlSeconds: 86400 });
    expect(reaped).toEqual([]);
  });

  it('restores the marker when the holder revives between claim and re-check', async () => {
    const store: FakeStore = fakeStore();
    const marker = runMarkerKey('run-1-i1');
    const hb = runHeartbeatKey('run-1-i1');
    await store.set(
      marker,
      JSON.stringify({ owner: 'pod-1:42', rawSessionId: 'run/1/i1', startedAt: 0 }),
      { EX: 86400 },
    );
    await store.set(hb, '1', { EX: 1 });
    store.clock.advance(2000); // heartbeat read as stale...
    // ...but the holder's next heartbeat lands after the claim, before the re-check.
    const origGet = store.get.bind(store);
    let reads = 0;
    store.get = async (key: string) => {
      if (key === hb && ++reads === 2) {
        store.data.set(hb, '1');
        store.expires.set(hb, store.clock.now + 5000);
      }
      return origGet(key);
    };
    const reaped = await reapOrphanedRuns(store, { ttlSeconds: 86400 });
    expect(reaped).toEqual([]);
    expect(store.data.get(marker)).toBeDefined();
    expect(await readResult(store, 'run-1-i1')).toBeNull();
  });

  it('returns nothing when there are no run markers at all', async () => {
    const store: FakeStore = fakeStore();
    await store.set('leaf:result:other', '{}');
    const reaped = await reapOrphanedRuns(store, { ttlSeconds: 86400 });
    expect(reaped).toEqual([]);
  });
});
