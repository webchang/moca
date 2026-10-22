import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisSandboxStore, type SandboxRedisLike } from '../src/sandbox-redis.js';
import { subjectHash } from '../src/subject-document.js';
import { sandboxStoreContract } from './helpers/sandbox-store-contract.js';

// Needs Redis on 6379, as refresh-redis.test.ts does; CI provides a redis:7 service.
const client = createClient({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379' });
const redis = client as unknown as SandboxRedisLike;
beforeAll(async () => void (await client.connect()));
afterAll(async () => void client.destroy());

function isolated() {
  const prefix = `test:sbx:${process.pid}:${randomUUID()}:`;
  return {
    prefix,
    store: new RedisSandboxStore(redis, prefix),
    done: async () => {
      const keys = await client.keys(`${prefix}*`);
      if (keys.length) await client.del(keys);
    },
  };
}

sandboxStoreContract('redis', async () => isolated());

describe('RedisSandboxStore TTLs (retention is the key lifetime)', () => {
  it('sets the record to live until expiresAt + retention, then to retention after delete', async () => {
    const { prefix, store, done } = isolated();
    const now = Math.floor(Date.now() / 1000);
    await store.create(
      {
        id: 'sbx-t',
        owner: 'github:1',
        tenant: 'github:1',
        name: '',
        template: 'd',
        worker: 'w',
        wsk: 'sbx-t',
        labels: {},
        createdAt: now,
        expiresAt: now + 1000,
      },
      { perSubject: 1, total: 1, retentionS: 500 },
      now,
    );
    const ttl1 = await client.ttl(`${prefix}sandbox:sbx-t`);
    expect(ttl1).toBeGreaterThan(1400);
    expect(ttl1).toBeLessThanOrEqual(1500);
    await store.markDeleted('sbx-t', now, 500);
    const ttl2 = await client.ttl(`${prefix}sandbox:sbx-t`);
    expect(ttl2).toBeGreaterThan(490);
    expect(ttl2).toBeLessThanOrEqual(500);
    await done();
  });

  it('keeps the name key until expiresAt + retention, so only `live` decides who holds a name', async () => {
    const { prefix, store, done } = isolated();
    const now = Math.floor(Date.now() / 1000);
    await store.create(
      {
        id: 'sbx-n',
        owner: 'github:1',
        tenant: 'github:1',
        name: 'web',
        template: 'd',
        worker: 'w',
        wsk: 'sbx-n',
        labels: {},
        createdAt: now,
        expiresAt: now + 1000,
      },
      { perSubject: 1, total: 1, retentionS: 500 },
      now,
    );
    // Garbage collection only: a Redis clock running ahead must not free a name whose holder is live.
    const ttl = await client.ttl(`${prefix}name:${subjectHash('github:1')}:web`);
    expect(ttl).toBeGreaterThan(1400);
    expect(ttl).toBeLessThanOrEqual(1500);
    await done();
  });

  it('prunes index members whose record is gone on create, so a create-and-delete loop never grows them', async () => {
    const { prefix, store, done } = isolated();
    const now = Math.floor(Date.now() / 1000);
    const rec = (id: string) => ({
      id,
      owner: 'github:1',
      tenant: 'github:1',
      name: '',
      template: 'd',
      worker: 'w',
      wsk: id,
      labels: {},
      createdAt: now,
      expiresAt: now + 1000,
    });
    const limits = { perSubject: 50, total: 50, retentionS: 500 };
    for (let i = 0; i < 20; i++) {
      expect(await store.create(rec(`sbx-old${i}`), limits, now)).toBe('ok');
      await store.markDeleted(`sbx-old${i}`, now, 500);
      // Retention passed: the TTL took the record, as Redis would.
      await client.del(`${prefix}sandbox:sbx-old${i}`);
    }
    const owner = `${prefix}owner:${subjectHash('github:1')}`;
    expect(await client.zCard(owner)).toBeLessThanOrEqual(1);
    expect(await client.zCard(`${prefix}all`)).toBeLessThanOrEqual(2);
    // A live member stays.
    expect(await store.create(rec('sbx-live'), limits, now)).toBe('ok');
    expect(await client.zScore(owner, 'sbx-live')).not.toBeNull();
    await done();
  });
});
