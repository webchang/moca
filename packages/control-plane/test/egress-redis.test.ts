import { createHash, randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EGRESS_LOG_CAP,
  MemoryEgressStore,
  RedisEgressStore,
  summarize,
  type EgressRedisLike,
  type EgressStore,
} from '../src/egress-log.js';

// Needs Redis on 6379, as sandbox-redis.test.ts does. The Lua append against the memory model.
const client = createClient({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' });
const redis = client as unknown as EgressRedisLike;
beforeAll(async () => void (await client.connect()));
afterAll(async () => void client.destroy());

function isolated() {
  const prefix = `test:egress:${process.pid}:${randomUUID()}:`;
  return {
    prefix,
    store: new RedisEgressStore(redis, 3600, prefix),
    done: async () => {
      const keys = await client.keys(`${prefix}*`);
      if (keys.length) await client.del(keys);
    },
  };
}

/** A typical stored event: a CONNECT tunnel, with nanosecond time, as moca-egress writes it. */
const REAL = JSON.stringify({
  bytes_down: 1234567,
  bytes_up: 4321,
  decision: 'tunnel',
  dial_addr: '192.0.2.10:443',
  host: 'files.pythonhosted.example.com',
  method: 'CONNECT',
  sid: 'sbx-0123456789abcdef0123456789',
  status: 200,
  time: '2026-11-08T12:00:00.123456789Z',
  via: 'moca-egress',
  vm_id: 'sbx_t1-0123456789abcdef',
});
const line = (i: number) => `{"bytes_up":${i},"decision":"tunnel","host":"a.example.com"}`;
const group = (sandboxId: string, n: number, expireAtS: number, from = 0) => ({
  sandboxId,
  lines: Array.from({ length: n }, (_, i) => line(from + i)),
  proxyDropped: 0,
  invalid: 0,
  expireAtS,
});

describe.each([
  [
    'memory',
    () => ({ store: new MemoryEgressStore() as EgressStore, prefix: '', done: async () => {} }),
  ],
  ['redis', isolated],
])('the egress store (%s)', (name, make) => {
  it('appends in order, pages by id, is idempotent by (host, cursor), and seals', async () => {
    const { store, done } = make();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const a = await store.append('bm1', 'c1', [group('sbx-a', 3, exp)], 2, 0);
    expect(a).toEqual({ accepted: 3, refused: 2, capped: 0, invalid: 0, dropped: 0, cursor: 'c1' });
    expect(await store.append('bm1', 'c1', [group('sbx-a', 3, exp)], 2, 0)).toEqual(a);
    await store.append(
      'bm1',
      'c2',
      [{ ...group('sbx-a', 2, exp, 3), proxyDropped: 4, invalid: 1 }],
      0,
      4,
    );
    const p1 = await store.page('sbx-a', null, 2);
    const p2 = await store.page('sbx-a', p1[1]!.id, 10);
    expect([...p1, ...p2].map((e) => e.line)).toEqual([0, 1, 2, 3, 4].map(line));
    const s = await summarize(store, 'sbx-a');
    const want = [0, 1, 2, 3, 4].map((i) => `${line(i)}\n`).join('');
    expect(s.sha256).toBe(`sha256:${createHash('sha256').update(want).digest('hex')}`);
    expect(s).toMatchObject({ total: 5, dropped: 5, droppedBy: { proxy: 4, cap: 0, invalid: 1 } });
    expect(await store.seal('sbx-a', exp)).toBe(true);
    expect(await store.seal('sbx-a', exp)).toBe(false);
    const late = await store.append('bm1', 'c3', [group('sbx-a', 2, exp)], 0, 0);
    expect(late).toMatchObject({ accepted: 0, refused: 2 });
    await done();
  });

  if (name === 'redis') {
    it('names its keys sh:sbx:egress:<id> and :meta, both expiring with the sandbox record', async () => {
      const { store, prefix, done } = isolated();
      const exp = Math.floor(Date.now() / 1000) + 1800;
      await store.append('bm1', 'c1', [{ ...group('sbx-b', 1, exp), proxyDropped: 1 }], 0, 1);
      for (const k of [`${prefix}sbx-b`, `${prefix}sbx-b:meta`]) {
        expect(await client.expireTime(k)).toBe(exp);
      }
      expect(await client.type(`${prefix}sbx-b`)).toBe('stream');
      const ttl = await client.ttl(`${prefix}host:bm1`);
      expect(ttl).toBeGreaterThan(3500);
      await store.expireAt('sbx-b', exp + 60);
      expect(await client.expireTime(`${prefix}sbx-b`)).toBe(exp + 60);
      expect(new RedisEgressStore(redis, 1)['stream']('sbx-x')).toBe('sh:sbx:egress:sbx-x');
      await done();
    });

    it(`stops at ${EGRESS_LOG_CAP} entries and counts the rest as cap drops`, async () => {
      const { store, prefix, done } = isolated();
      const exp = Math.floor(Date.now() / 1000) + 600;
      const k = `${prefix}sbx-c`;
      // Fill to one short of the cap directly, then let the script take one and cap two.
      const batch: string[] = [];
      for (let i = 0; i < EGRESS_LOG_CAP - 1; i++) batch.push('*', 'e', REAL);
      for (let i = 0; i < batch.length; i += 3000) {
        const m = client.multi();
        for (let j = i; j < Math.min(i + 3000, batch.length); j += 3)
          m.xAdd(k, '*', { e: batch[j + 2]! });
        await m.exec();
      }
      const r = await store.append('bm1', 'c1', [group('sbx-c', 3, exp)], 0, 0);
      expect(r).toMatchObject({ accepted: 1, capped: 2 });
      expect(await client.xLen(k)).toBe(EGRESS_LOG_CAP);
      // Memory: what one stored event costs, at the cap (the report's estimate).
      const bytes = await client.memoryUsage(k);
      console.log(
        `[egress-redis] ${EGRESS_LOG_CAP} events of ${REAL.length} B: ${bytes} B, ${Math.round(Number(bytes) / EGRESS_LOG_CAP)} B each`,
      );
      await done();
    });
  }
});
