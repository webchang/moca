import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  keyIdFor,
  makeSigner,
  ownerScopeFor,
  verifyAttachToken,
  workloadKeyFor,
} from '@moca/control-plane';
import {
  deleteWorkload,
  getWorkload,
  parseSandboxSpec,
  putWorkload,
  remintExpiring,
  type ProvisionerDeps,
  type WorkloadRef,
} from '../src/provisioner.js';
import { FakeKube, workloadTemplate } from './fake-kube.js';

const { privateKey } = generateKeyPairSync('ed25519');
const signer = makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
const publicKey = createPublicKey(privateKey);
const publicKeys = new Map([[keyIdFor(publicKey), publicKey]]);
const config = { maxPerWorkload: 2, maxPerOwner: 4, attachTtlS: 86400 };
const stsOf = (wl: string) => kube.objects.statefulsets.get(wl)!;

let kube: FakeKube;
let now: number;
let deps: ProvisionerDeps;
const ref = (owner: string, name = 'demo', generation = randomUUID()): WorkloadRef => ({
  owner,
  name,
  generation,
});
const tokenIn = (wl: string) =>
  Buffer.from(kube.objects.secrets.get(`${wl}-attach`)!.data.token, 'base64').toString();

beforeEach(() => {
  kube = new FakeKube();
  kube.objects.podtemplates.set('moca-workload-sandbox', workloadTemplate());
  now = 1_800_000_000;
  deps = { kube, signer, config, now: () => now };
});

describe('PUT: what a workload gets', () => {
  it('creates the Secret, headless Service and StatefulSet under the derived workload key', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    const status = await putWorkload(deps, r, { count: 2, tier: 'container' });
    expect(status).toMatchObject({ workloadId: 'demo', count: 2 });
    expect([...kube.objects.secrets.keys()]).toEqual([`${wl}-attach`]);
    expect([...kube.objects.services.keys()]).toEqual([wl]);
    const svc = kube.objects.services.get(wl)!;
    expect(svc.spec).toEqual({
      clusterIP: 'None',
      selector: { app: 'moca-workload-sandbox', 'moca.dev/workload': wl },
    });
    const sts = kube.objects.statefulsets.get(wl)!;
    expect(sts.spec.replicas).toBe(2);
    expect(sts.spec.serviceName).toBe(wl);
    expect(sts.spec.template.metadata.labels).toEqual({
      app: 'moca-workload-sandbox',
      'moca.dev/workload': wl,
      'moca.dev/owner': ownerScopeFor('github:alice'),
      'app.kubernetes.io/managed-by': 'moca-provisioner',
    });
    expect(sts.metadata.annotations).toMatchObject({
      'moca.dev/generation': r.generation,
      'moca.dev/record-key': `sh:wl:${ownerScopeFor('github:alice')}:demo`,
    });
    // The pods' own label, so the shared pool's selector (app: moca-sandbox) never matches them.
    expect(sts.spec.selector.matchLabels.app).toBe('moca-workload-sandbox');
  });

  it("mints a token whose binding is the workload's, verifiable with the public key only", async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 2, tier: 'container' });
    const c = verifyAttachToken(tokenIn(wl), publicKeys, { now });
    expect(c).toMatchObject({
      wl,
      own: ownerScopeFor('github:alice'),
      gen: r.generation,
      tr: 'container',
      n: 2,
      exp: now + 86400,
    });
  });

  it('builds the pod from the PodTemplate, adding only the binding and the attach token', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    const t = workloadTemplate().template;
    const tpl = stsOf(wl).spec.template;
    const pod = tpl.spec;
    expect(pod.serviceAccountName).toBe('moca-workload-sandbox');
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.securityContext).toEqual(t.spec.securityContext);
    // The template's annotations (kind's image ID) survive, under the binding's.
    expect(tpl.metadata.annotations).toMatchObject({
      'moca.dev/image-id': 'x',
      'moca.dev/generation': r.generation,
    });
    const [c] = pod.containers;
    expect(c.image).toBe(t.spec.containers[0].image);
    expect(c.securityContext).toEqual(t.spec.containers[0].securityContext);
    expect(c.resources).toEqual(t.spec.containers[0].resources);
    const env = Object.fromEntries(c.env.map((e: { name: string }) => [e.name, e]));
    expect(c.env).toHaveLength(4);
    expect(env.SANDBOX_TIER.value).toBe('container');
    expect(env.SANDBOX_TOKEN_FILE.value).toBe('/run/moca-attach/token');
    expect(env.RELAY_ADDR.value).toBe('sandbox-relay-attach.moca.svc:9443');
    expect(env.SANDBOX_ID.valueFrom).toEqual({ fieldRef: { fieldPath: 'metadata.name' } });
    // The attach token as a directory mount, never a subPath, so the kubelet refreshes it.
    expect(c.volumeMounts).toEqual([
      { name: 'workspace', mountPath: '/workspace' },
      { name: 'attach-token', mountPath: '/run/moca-attach', readOnly: true },
    ]);
    expect(pod.volumes).toEqual([
      { name: 'workspace', emptyDir: {} },
      { name: 'attach-token', secret: { secretName: `${wl}-attach`, defaultMode: 0o440 } },
    ]);
  });

  it('never reads a Secret: it writes them blind, and records the token on the StatefulSet', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 2, tier: 'container' });
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    await remintExpiring(deps);
    await deleteWorkload(deps, r);
    expect(kube.calls.filter((c) => /^(get|list) secrets/.test(c))).toEqual([]);
  });

  it("records the token's expiry, issue time, signing key and n on the StatefulSet", async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 2, tier: 'container' });
    expect(stsOf(wl).metadata.annotations).toMatchObject({
      'moca.dev/attach-iat': String(now),
      'moca.dev/attach-exp': String(now + 86400),
      'moca.dev/attach-kid': signer.kid,
      'moca.dev/sandbox-count': '2',
    });
    // The Secret carries no copy of what the token says.
    expect(Object.keys(kube.objects.secrets.get(`${wl}-attach`)!.metadata.annotations)).toEqual([
      'moca.dev/record-key',
      'moca.dev/generation',
    ]);
  });

  it('is idempotent by (wl, gen): a repeat converges the same objects and keeps a fresh token', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    const first = tokenIn(wl);
    kube.calls = [];
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    expect(tokenIn(wl)).toBe(first);
    expect(kube.calls.filter((c) => /^(create|replace|patch)/.test(c))).toEqual([]);
  });

  it('a changed count re-mints the token for the new n and scales the StatefulSet', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    await putWorkload(deps, r, { count: 2, tier: 'container' });
    expect(verifyAttachToken(tokenIn(wl), publicKeys, { now }).n).toBe(2);
    expect(kube.objects.statefulsets.get(wl)!.spec.replicas).toBe(2);
  });

  it('a re-created workload (new generation) gets a different key and binding', async () => {
    const a = ref('github:alice', 'demo');
    const b = ref('github:alice', 'demo');
    await putWorkload(deps, a, { count: 1, tier: 'container' });
    await deleteWorkload(deps, a);
    await putWorkload(deps, b, { count: 1, tier: 'container' });
    const wlB = workloadKeyFor(b.owner, b.name, b.generation);
    expect(wlB).not.toBe(workloadKeyFor(a.owner, a.name, a.generation));
    expect(verifyAttachToken(tokenIn(wlB), publicKeys, { now }).gen).toBe(b.generation);
  });

  it('refuses when the PodTemplate is missing, creating nothing', async () => {
    kube.objects.podtemplates.clear();
    await expect(
      putWorkload(deps, ref('github:alice'), { count: 1, tier: 'container' }),
    ).rejects.toMatchObject({ status: 500, code: 'workload_template_missing' });
    expect(kube.objects.secrets.size).toBe(0);
  });

  it('overwrites a Secret left by an earlier, interrupted PUT instead of failing on it', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    kube.objects.secrets.set(`${wl}-attach`, {
      metadata: { name: `${wl}-attach` },
      data: { token: 'c3RhbGU=' },
    });
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    expect(verifyAttachToken(tokenIn(wl), publicKeys, { now }).wl).toBe(wl);
  });
});

describe('the owner boundary', () => {
  it("Alice's token cannot touch Bob's workload: the same name and generation derive another key", async () => {
    const gen = randomUUID();
    const bob = ref('github:bob', 'demo', gen);
    await putWorkload(deps, bob, { count: 1, tier: 'container' });
    const bobWl = workloadKeyFor('github:bob', 'demo', gen);
    // Alice names Bob's workload exactly.
    const alice = ref('github:alice', 'demo', gen);
    await expect(getWorkload(deps, alice)).rejects.toMatchObject({ status: 404 });
    await deleteWorkload(deps, alice);
    expect(kube.objects.statefulsets.has(bobWl)).toBe(true);
    expect(kube.objects.secrets.has(`${bobWl}-attach`)).toBe(true);
  });

  it('refuses to adopt an object under the derived name that is not this workload', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    kube.objects.statefulsets.set(wl, {
      metadata: { name: wl, labels: { 'moca.dev/workload': wl } },
      spec: { replicas: 1 },
    });
    await expect(putWorkload(deps, r, { count: 1, tier: 'container' })).rejects.toMatchObject({
      status: 409,
      code: 'workload_object_conflict',
    });
  });

  it('refuses to adopt a Service that appears between its pre-read and its create', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    const create = kube.create.bind(kube);
    kube.create = async (kind, obj) => {
      if (kind === 'services') {
        kube.objects.services.set(wl, {
          metadata: { name: wl, labels: { 'moca.dev/workload': wl } },
        });
      }
      return create(kind, obj);
    };
    await expect(putWorkload(deps, r, { count: 1, tier: 'container' })).rejects.toMatchObject({
      status: 409,
      code: 'workload_object_conflict',
    });
    expect(kube.objects.statefulsets.has(wl)).toBe(false);
  });

  it('refuses to adopt a StatefulSet that appears between its pre-read and its create', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    const create = kube.create.bind(kube);
    kube.create = async (kind, obj) => {
      if (kind === 'statefulsets') {
        kube.objects.statefulsets.set(wl, {
          metadata: { name: wl, labels: { 'moca.dev/workload': wl } },
          spec: { replicas: 1 },
        });
      }
      return create(kind, obj);
    };
    await expect(putWorkload(deps, r, { count: 1, tier: 'container' })).rejects.toMatchObject({
      status: 409,
      code: 'workload_object_conflict',
    });
  });
});

describe('caps (spec §6.3), enforced here too', () => {
  it('refuses a count above MOCA_WORKLOAD_MAX_SANDBOXES, a non-integer, and microvm', () => {
    expect(() => parseSandboxSpec({ count: 3 }, config)).toThrow(
      expect.objectContaining({ status: 400, code: 'sandboxes_count_exceeded' }),
    );
    for (const count of [0, -1, 1.5, '1', undefined]) {
      expect(() => parseSandboxSpec({ count }, config)).toThrow(
        expect.objectContaining({ code: 'sandboxes_count_invalid' }),
      );
    }
    expect(() => parseSandboxSpec({ count: 1, tier: 'microvm' }, config)).toThrow(
      expect.objectContaining({ code: 'sandbox_tier_unavailable' }),
    );
    expect(() => parseSandboxSpec({ count: 1, wl: 'w-x' }, config)).toThrow(
      expect.objectContaining({ code: 'sandboxes_field_not_allowed' }),
    );
    expect(parseSandboxSpec({ count: 2, revision: 'a'.repeat(64) }, config)).toEqual({
      count: 2,
      tier: 'container',
      revision: 'a'.repeat(64),
    });
  });

  it("refuses an owner's replicas across workloads beyond MOCA_OWNER_MAX_SANDBOXES", async () => {
    await putWorkload(deps, ref('github:alice', 'one'), { count: 2, tier: 'container' });
    await putWorkload(deps, ref('github:alice', 'two'), { count: 2, tier: 'container' });
    await expect(
      putWorkload(deps, ref('github:alice', 'three'), { count: 1, tier: 'container' }),
    ).rejects.toMatchObject({ status: 429, code: 'owner_sandbox_quota_exceeded' });
    // Another owner is not counted against Alice.
    await putWorkload(deps, ref('github:bob', 'one'), { count: 2, tier: 'container' });
  });

  it('serializes one owner: of two concurrent PUTs that together exceed the cap left, exactly one wins', async () => {
    await putWorkload(deps, ref('github:alice', 'one'), { count: 2, tier: 'container' });
    const results = await Promise.allSettled([
      putWorkload(deps, ref('github:alice', 'two'), { count: 2, tier: 'container' }),
      putWorkload(deps, ref('github:alice', 'three'), { count: 2, tier: 'container' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((r) => r.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
      status: 429,
      code: 'owner_sandbox_quota_exceeded',
    });
    const total = [...kube.objects.statefulsets.values()].reduce((n, s) => n + s.spec.replicas, 0);
    expect(total).toBe(4);
  });

  it('serializes per owner only: another owner is not held behind', async () => {
    const [a, b] = await Promise.all([
      putWorkload(deps, ref('github:alice', 'one'), { count: 2, tier: 'container' }),
      putWorkload(deps, ref('github:bob', 'one'), { count: 2, tier: 'container' }),
    ]);
    expect([a.count, b.count]).toEqual([2, 2]);
  });

  it('never refuses a PUT that adds no replicas, even for an owner already over the cap', async () => {
    const r = ref('github:alice', 'one');
    await putWorkload(deps, r, { count: 2, tier: 'container' });
    await putWorkload(deps, ref('github:alice', 'two'), { count: 2, tier: 'container' });
    // The operator lowers MOCA_OWNER_MAX_SANDBOXES below what Alice already has.
    const lowered = { ...deps, config: { ...config, maxPerOwner: 2 } };
    expect(await putWorkload(lowered, r, { count: 2, tier: 'container' })).toMatchObject({
      count: 2,
    });
    expect(await putWorkload(lowered, r, { count: 1, tier: 'container' })).toMatchObject({
      count: 1,
    });
    expect(stsOf(workloadKeyFor(r.owner, r.name, r.generation)).spec.replicas).toBe(1);
    // Growing again is held to the cap.
    await expect(putWorkload(lowered, r, { count: 2, tier: 'container' })).rejects.toMatchObject({
      status: 429,
      code: 'owner_sandbox_quota_exceeded',
    });
  });

  it("a repeat PUT does not count the workload's own replicas twice", async () => {
    const r = ref('github:alice', 'one');
    await putWorkload(deps, ref('github:alice', 'two'), { count: 2, tier: 'container' });
    await putWorkload(deps, r, { count: 2, tier: 'container' });
    await putWorkload(deps, r, { count: 2, tier: 'container' });
  });
});

describe('DELETE: sandboxes first, done once no pod remains', () => {
  it('removes all three objects, and reports pods until the garbage collector has them', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 2, tier: 'container' });
    kube.runPods(wl);
    expect(await deleteWorkload(deps, r)).toEqual({ remaining: 2 });
    expect(kube.objects.statefulsets.has(wl)).toBe(false);
    expect(kube.objects.services.has(wl)).toBe(false);
    expect(kube.objects.secrets.has(`${wl}-attach`)).toBe(false);
    kube.reapPods();
    expect(await deleteWorkload(deps, r)).toEqual({ remaining: 0 });
  });

  it('waits for a PUT still converging: a DELETE during it leaves nothing, and frees the cap', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    // A slow API server: the PUT's StatefulSet create hangs until released, as when the worker's
    // MOCA_PROVISIONER_TIMEOUT_MS gives up on it and the client then deletes the workload.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached = false;
    const create = kube.create.bind(kube);
    kube.create = async (kind, obj) => {
      if (kind === 'statefulsets') {
        reached = true;
        await gate;
      }
      return create(kind, obj);
    };
    const put = putWorkload(deps, r, { count: 2, tier: 'container' });
    await vi.waitFor(() => expect(reached).toBe(true));
    let deleted = false;
    const del = deleteWorkload(deps, r).then((v) => ((deleted = true), v));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Queued behind the PUT, not run beside it.
    expect(deleted).toBe(false);
    release();
    await put;
    expect(await del).toEqual({ remaining: 0 });
    expect(kube.objects.statefulsets.has(wl)).toBe(false);
    expect(kube.objects.services.has(wl)).toBe(false);
    expect(kube.objects.secrets.has(`${wl}-attach`)).toBe(false);
    // Nothing left counts toward Alice's cap.
    await putWorkload(deps, ref('github:alice', 'other'), { count: 2, tier: 'container' });
    await putWorkload(deps, ref('github:alice', 'third'), { count: 2, tier: 'container' });
  });

  it("waits for a re-mint's Secret write: a DELETE during it leaves no Secret behind", async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    now += 50_000;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached = false;
    const replace = kube.replace.bind(kube);
    kube.replace = async (kind, obj) => {
      if (kind === 'secrets') {
        reached = true;
        await gate;
      }
      return replace(kind, obj);
    };
    const remint = remintExpiring(deps);
    await vi.waitFor(() => expect(reached).toBe(true));
    const del = deleteWorkload(deps, r);
    release();
    expect(await remint).toBe(1);
    expect(await del).toEqual({ remaining: 0 });
    expect(kube.objects.secrets.has(`${wl}-attach`)).toBe(false);
    expect(kube.objects.statefulsets.has(wl)).toBe(false);
  });

  it('tolerates objects already gone, and never deletes the shared pool', async () => {
    kube.objects.statefulsets.set('moca-sandbox', { metadata: { name: 'moca-sandbox' } });
    expect(await deleteWorkload(deps, ref('github:alice'))).toEqual({ remaining: 0 });
    expect(kube.objects.statefulsets.has('moca-sandbox')).toBe(true);
  });
});

describe('re-minting before expiry (spec §3.1)', () => {
  it('re-mints a token once less than half its lifetime remains, keeping its binding', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 2, tier: 'container' });
    const first = verifyAttachToken(tokenIn(wl), publicKeys, { now });
    now += 43_000; // just under half
    expect(await remintExpiring(deps)).toBe(0);
    now += 1_000; // past half
    expect(await remintExpiring(deps)).toBe(1);
    const second = verifyAttachToken(tokenIn(wl), publicKeys, { now });
    expect(second.exp).toBe(now + 86400);
    expect(second.exp).toBeGreaterThan(first.exp);
    expect(stsOf(wl).metadata.annotations['moca.dev/attach-exp']).toBe(String(second.exp));
    // Recorded, so the next pass leaves it.
    expect(await remintExpiring(deps)).toBe(0);
    expect({ ...second, iat: 0, exp: 0, jti: '' }).toEqual({ ...first, iat: 0, exp: 0, jti: '' });
    // Well before the old one's exp, so the worker's idle reconnect has half a day to land.
    expect(first.exp - now).toBeGreaterThan(40_000);
  });

  it('re-mints a token signed with a key this provisioner no longer holds (rotation)', async () => {
    const r = ref('github:alice');
    const wl = workloadKeyFor(r.owner, r.name, r.generation);
    await putWorkload(deps, r, { count: 1, tier: 'container' });
    const { privateKey: next } = generateKeyPairSync('ed25519');
    const nextSigner = makeSigner(next.export({ format: 'pem', type: 'pkcs8' }).toString());
    const nextPub = createPublicKey(next);
    const rotated = { ...deps, signer: nextSigner };
    expect(await remintExpiring(rotated)).toBe(1);
    const nextKeys = new Map([[keyIdFor(nextPub), nextPub]]);
    expect(() => verifyAttachToken(tokenIn(wl), nextKeys, { now })).not.toThrow();
  });

  it('skips a malformed or failing StatefulSet and still re-mints the ones after it', async () => {
    const bad = ref('github:alice', 'bad');
    const good = ref('github:alice', 'good');
    const badWl = workloadKeyFor(bad.owner, bad.name, bad.generation);
    const goodWl = workloadKeyFor(good.owner, good.name, good.generation);
    await putWorkload(deps, bad, { count: 1, tier: 'container' });
    await putWorkload(deps, good, { count: 1, tier: 'container' });
    const broken = (patch: (a: Record<string, string>) => void, name: string) => {
      const s = JSON.parse(JSON.stringify(stsOf(badWl)));
      s.metadata.name = name;
      patch(s.metadata.annotations);
      return s;
    };
    // Listed first: annotations a PUT never writes, and a valid one whose Secret write fails.
    const malformed = [
      broken((a) => (a['moca.dev/generation'] = 'not-a-uuid'), badWl),
      broken((a) => (a['moca.dev/record-key'] = 'sh:wl:x"}:y'), badWl),
    ];
    const list = kube.list.bind(kube);
    kube.list = async (kind, sel) => {
      const items = await list(kind, sel);
      return kind === 'statefulsets' ? [...malformed, ...items] : items;
    };
    const replace = kube.replace.bind(kube);
    kube.replace = async (kind, obj) => {
      if (obj.metadata.name === `${badWl}-attach`) throw new Error('admission denied');
      return replace(kind, obj);
    };
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((m: string) => void errors.push(m));
    try {
      now += 50_000;
      const before = tokenIn(goodWl);
      expect(await remintExpiring(deps)).toBe(1);
      expect(tokenIn(goodWl)).not.toBe(before);
      expect(errors.some((m) => /skips .* no valid generation/.test(m))).toBe(true);
      expect(errors.some((m) => /skips .* no valid record key/.test(m))).toBe(true);
      expect(errors.some((m) => /re-mint of StatefulSet .* failed: admission denied/.test(m))).toBe(
        true,
      );
      // No token in any log line.
      expect(errors.join('\n')).not.toMatch(/eyJ/);
    } finally {
      spy.mockRestore();
    }
  });

  it('touches nothing it did not create, whatever its labels claim', async () => {
    kube.objects.secrets.set('moca-relay-attach', {
      metadata: { name: 'moca-relay-attach', labels: {} },
      data: { SH_RELAY_TOKEN: 'eA==' },
    });
    // A StatefulSet named off its workload label: never re-minted under another name.
    kube.objects.statefulsets.set('moca-sandbox', {
      metadata: {
        name: 'moca-sandbox',
        labels: {
          app: 'moca-workload-sandbox',
          'app.kubernetes.io/managed-by': 'moca-provisioner',
          'moca.dev/workload': 'moca-relay',
          'moca.dev/owner': 'x',
        },
        annotations: {
          'moca.dev/sandbox-count': '1',
          'moca.dev/generation': randomUUID(),
          'moca.dev/record-key': 'sh:wl:x:y',
          'moca.dev/tier': 'container',
        },
      },
    });
    expect(await remintExpiring(deps)).toBe(0);
    expect(kube.calls.filter((c) => /^(create|replace|patch)/.test(c))).toEqual([]);
    expect(kube.objects.secrets.get('moca-relay-attach')!.data).toEqual({ SH_RELAY_TOKEN: 'eA==' });
  });
});
