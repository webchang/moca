import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keyIdFor, makeSigner, workloadKeyFor } from '@moca/control-plane';
import { mintAttachToken, mintSandboxToken, ownerScopeFor } from '@moca/control-plane';
import { startSeedServer, startServer, type ServerDeps } from '../src/server.js';
import { KubeError, RestKube } from '../src/kube.js';
import { BundleStore } from '../src/seed.js';
import { FakeKube, workloadTemplate } from './fake-kube.js';

// The internal API end to end over HTTP: both credentials, the owner from the forwarded token,
// and the status codes the worker relies on.

const attach = generateKeyPairSync('ed25519');
const cp = generateKeyPairSync('ed25519');
const cpSigner = makeSigner(cp.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
const cpPub = createPublicKey(cp.privateKey);
const SERVICE = 'svc-token-for-tests'; // notsecret
const apiToken = (sub: string, scope = ['api']) =>
  cpSigner.mint({ sub, tenant: sub, roles: [], scope, ttlSeconds: 300 });

let kube: FakeKube;
let server: http.Server;
let seedServer: http.Server;
let base: string;
let seedBase: string;
let deps: ServerDeps;
const attachSigner = makeSigner(
  attach.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
);
const attachPub = createPublicKey(attach.privateKey);

beforeEach(async () => {
  kube = new FakeKube();
  kube.objects.podtemplates.set('moca-workload-sandbox', workloadTemplate());
  deps = {
    kube,
    signer: attachSigner,
    config: {
      maxPerWorkload: 2,
      maxPerOwner: 4,
      attachTtlS: 86400,
      storage: { maxMiB: 10 * 1024, classes: new Map() },
      seedUrl: 'http://moca-provisioner.moca.svc:8081/seed/v1/bundle',
      maxEntries: 10_000,
    },
    bundles: new BundleStore(1024 * 1024),
    maxBundleBytes: 1024 * 1024,
    serviceToken: SERVICE,
    userKeys: new Map([[keyIdFor(cpPub), cpPub]]),
  };
  server = startServer(deps, 0);
  seedServer = startSeedServer(
    { ...deps, attachKeys: new Map([[attachSigner.kid, attachPub]]) },
    0,
  );
  for (const s of [server, seedServer]) {
    if (!s.listening) await new Promise<void>((r) => s.once('listening', r));
  }
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  seedBase = `http://127.0.0.1:${(seedServer.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => seedServer.close(() => r()));
});

async function call(
  method: string,
  path: string,
  opts: { service?: string | null; user?: string | null; body?: unknown } = {},
) {
  const service = opts.service === undefined ? SERVICE : opts.service;
  const user = opts.user === undefined ? apiToken('github:alice') : opts.user;
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(service ? { authorization: `Bearer ${service}` } : {}),
      ...(user ? { 'x-moca-user-token': user } : {}),
      'content-type': 'application/json',
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const path = (gen: string, name = 'demo') => `/internal/v1/workloads/${name}/${gen}`;

describe('authentication', () => {
  it('needs the service token, then a valid API-scoped user token', async () => {
    const gen = randomUUID();
    const body = { count: 1 };
    expect((await call('PUT', path(gen), { service: null, body })).status).toBe(401);
    expect((await call('PUT', path(gen), { service: 'wrong', body })).status).toBe(401);
    expect(await call('PUT', path(gen), { user: null, body })).toEqual({
      status: 401,
      body: { error: 'user_token_required' },
    });
    expect(await call('PUT', path(gen), { user: 'garbage', body })).toMatchObject({
      status: 401,
      body: { error: 'token_invalid' },
    });
    // A session token is not an API token.
    const session = apiToken('github:alice', ['turn:write']);
    expect((await call('PUT', path(gen), { user: session, body })).status).toBe(401);
    // A token from a key the provisioner does not trust.
    const other = generateKeyPairSync('ed25519').privateKey;
    const forged = makeSigner(other.export({ format: 'pem', type: 'pkcs8' }).toString()).mint({
      sub: 'github:alice',
      tenant: 'github:alice',
      roles: [],
      scope: ['api'],
      ttlSeconds: 300,
    });
    expect((await call('PUT', path(gen), { user: forged, body })).status).toBe(401);
    expect(kube.objects.secrets.size).toBe(0);
  });
});

describe('the routes', () => {
  it("PUT provisions under the token owner's key; GET reads it; DELETE is 200 once no pod remains", async () => {
    const gen = randomUUID();
    const wl = workloadKeyFor('github:alice', 'demo', gen);
    expect(await call('PUT', path(gen), { body: { count: 2, revision: 'a'.repeat(64) } })).toEqual({
      status: 200,
      body: { workloadId: 'demo', generation: gen, count: 2, ready: 0 },
    });
    expect(kube.objects.statefulsets.has(wl)).toBe(true);
    kube.runPods(wl);
    expect(await call('GET', path(gen))).toMatchObject({ status: 200, body: { ready: 2 } });
    // Bob, naming Alice's workload exactly, finds nothing and deletes nothing.
    const bob = { user: apiToken('github:bob') };
    expect((await call('GET', path(gen), bob)).status).toBe(404);
    expect(await call('DELETE', path(gen), bob)).toEqual({ status: 200, body: { remaining: 0 } });
    expect(kube.objects.statefulsets.has(wl)).toBe(true);
    // Alice's delete: pods still terminating, then gone.
    expect(await call('DELETE', path(gen))).toEqual({ status: 202, body: { remaining: 2 } });
    kube.reapPods();
    expect(await call('DELETE', path(gen))).toEqual({ status: 200, body: { remaining: 0 } });
  });

  it('refuses a body that names a workload key, a bad name or generation, and caps', async () => {
    const gen = randomUUID();
    expect(await call('PUT', path(gen), { body: { count: 1, wl: 'w-' + 'a'.repeat(32) } })).toEqual(
      { status: 400, body: { error: 'sandboxes_field_not_allowed' } },
    );
    expect((await call('PUT', path(gen, 'Bad_Name'), { body: { count: 1 } })).status).toBe(404);
    expect((await call('PUT', path('not-a-uuid'), { body: { count: 1 } })).status).toBe(404);
    expect((await call('PUT', path(gen), { body: { count: 3 } })).body).toEqual({
      error: 'sandboxes_count_exceeded',
    });
    expect((await call('PUT', path(gen), { body: { count: 1, tier: 'microvm' } })).body).toEqual({
      error: 'sandbox_tier_unavailable',
    });
    expect((await call('POST', path(gen))).status).toBe(405);
    expect((await call('GET', '/internal/v1/other')).status).toBe(404);
  });
});

describe('Kubernetes failures', () => {
  it('maps an admission denial (403) or an invalid object (422) to 422 workload_refused, others to 502', async () => {
    const create = kube.create.bind(kube);
    let status = 403;
    let refused = 'statefulsets';
    kube.create = async (kind, obj) => {
      if (kind === refused) {
        throw new KubeError(status, 'Forbidden', `Kubernetes API POST ${kind} answered ${status}`);
      }
      return create(kind, obj);
    };
    for (status of [403, 422]) {
      expect(await call('PUT', path(randomUUID()), { body: { count: 1 } })).toEqual({
        status: 422,
        body: { error: 'workload_refused' },
      });
    }
    // A mounted workload's PVC refused (a class outside the policy's allowlist): the same answer.
    refused = 'persistentvolumeclaims';
    const mounted = {
      count: 1,
      revision: 'c'.repeat(64),
      mount: 'read-only',
      storage: { size: '1Gi' },
    };
    for (status of [403, 422]) {
      expect(await call('PUT', path(randomUUID()), { body: mounted })).toEqual({
        status: 422,
        body: { error: 'workload_refused' },
      });
    }
    refused = 'statefulsets';
    status = 500;
    expect(await call('PUT', path(randomUUID()), { body: { count: 1 } })).toEqual({
      status: 502,
      body: { error: 'kubernetes_error' },
    });
  });
});

describe('the bundle hand-off and the seed port (spec §5.2)', () => {
  const REV = 'c'.repeat(64);
  const BUNDLE = Buffer.from('a gzip bundle, as far as this test is concerned');
  const putBundle = (gen: string, body: Buffer, opts: { type?: string; user?: string } = {}) =>
    fetch(`${base}${path(gen)}/bundle`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${SERVICE}`,
        'x-moca-user-token': opts.user ?? apiToken('github:alice'),
        'content-type': opts.type ?? 'application/vnd.rossoctl.context',
      },
      body: new Blob([new Uint8Array(body)]),
    });
  const attachFor = (owner: string, gen: string, now = Math.floor(Date.now() / 1000)) =>
    mintAttachToken(attachSigner, {
      wl: workloadKeyFor(owner, 'demo', gen),
      own: ownerScopeFor(owner),
      gen,
      tr: 'container',
      n: 1,
      now,
      ttlSeconds: 3600,
    });
  const seed = (token?: string) =>
    fetch(
      `${seedBase}/seed/v1/bundle`,
      token ? { headers: { authorization: `Bearer ${token}` } } : {},
    );

  it('holds a bundle for the derived key, and serves it only to that workload and generation', async () => {
    const gen = randomUUID();
    const res = await putBundle(gen, BUNDLE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ held: true });
    const got = await seed(attachFor('github:alice', gen));
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('application/vnd.rossoctl.context');
    expect(Buffer.from(await got.arrayBuffer())).toEqual(BUNDLE);
    // Bob's workload of the same name and generation, and another generation of Alice's: nothing.
    expect((await seed(attachFor('github:bob', gen))).status).toBe(404);
    expect((await seed(attachFor('github:alice', randomUUID()))).status).toBe(404);
  });

  it('the seed port accepts only an attach token from this provisioner, unexpired', async () => {
    const gen = randomUUID();
    await putBundle(gen, BUNDLE);
    expect((await seed()).status).toBe(401);
    // An API token, a sandbox token and a session token are not attach tokens.
    expect((await seed(apiToken('github:alice'))).status).toBe(401);
    const now = Math.floor(Date.now() / 1000);
    const { token: sandbox } = mintSandboxToken(attachSigner, {
      sub: 'github:alice',
      tenant: 'github:alice',
      sbx: 'sbx-1',
      wrk: 'w',
      wsk: 'k',
      ttlSeconds: 300,
      notAfter: now + 300,
      iss: 'moca-control-plane',
      now,
    });
    // Signed with the attach key itself, so only its typ and audience refuse it.
    expect((await seed(sandbox)).status).toBe(401);
    // Expired.
    expect((await seed(attachFor('github:alice', gen, 1_000_000))).status).toBe(401);
    // Another key.
    const other = makeSigner(
      generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    );
    const forged = mintAttachToken(other, {
      wl: workloadKeyFor('github:alice', 'demo', gen),
      own: ownerScopeFor('github:alice'),
      gen,
      tr: 'container',
      n: 1,
      now: Math.floor(Date.now() / 1000),
      ttlSeconds: 3600,
    });
    expect((await seed(forged)).status).toBe(401);
  });

  it('after a restart (nothing held) the seed port answers 404 seed_bundle_missing', async () => {
    const gen = randomUUID();
    const got = await seed(attachFor('github:alice', gen));
    expect(got.status).toBe(404);
    expect(await got.json()).toEqual({ error: 'seed_bundle_missing' });
  });

  it('the internal API refuses an attach token, and the seed port serves nothing else', async () => {
    const gen = randomUUID();
    const token = attachFor('github:alice', gen);
    expect((await call('GET', path(gen), { service: token })).status).toBe(401);
    expect((await call('GET', path(gen), { user: token })).status).toBe(401);
    for (const p of [path(gen), `${path(gen)}/bundle`, '/healthz', '/seed/v1/other']) {
      const r = await fetch(`${seedBase}${p}`, { headers: { authorization: `Bearer ${token}` } });
      expect(r.status, p).toBe(404);
    }
    expect((await fetch(`${seedBase}/seed/v1/bundle`, { method: 'PUT' })).status).toBe(405);
  });

  it('refuses a bundle of the wrong type, an empty or oversized one, and answers 503 with Retry-After past the budget', async () => {
    const gen = randomUUID();
    expect((await putBundle(gen, BUNDLE, { type: 'application/json' })).status).toBe(415);
    expect((await putBundle(gen, Buffer.alloc(0))).status).toBe(400);
    expect((await putBundle(gen, Buffer.alloc(deps.maxBundleBytes + 1))).status).toBe(413);
    // Fill the budget (1 MiB in these deps) with other owners' bundles first.
    const half = 512 * 1024;
    deps.bundles.put('w-' + '0'.repeat(32), {
      gen: 'g',
      own: 'x',
      bytes: Buffer.alloc(half),
      at: 0,
    });
    deps.bundles.put('w-' + '1'.repeat(32), {
      gen: 'g',
      own: 'y',
      bytes: Buffer.alloc(half - BUNDLE.length),
      at: 0,
    });
    expect((await putBundle(gen, BUNDLE)).status).toBe(200);
    const full = await putBundle(randomUUID(), BUNDLE, { user: apiToken('github:bob') });
    expect(full.status).toBe(503);
    expect(full.headers.get('retry-after')).toBe('15');
    expect(await full.json()).toEqual({ error: 'seed_budget_full' });
  });

  /** A hand-off whose body is written by the test: `declared` bytes, or chunked with none. */
  const rawHandOff = (gen: string, user: string, declared?: number) => {
    const req = http.request(`${base}${path(gen)}/bundle`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${SERVICE}`,
        'x-moca-user-token': user,
        'content-type': 'application/vnd.rossoctl.context',
        ...(declared === undefined ? {} : { 'content-length': String(declared) }),
      },
    });
    const answer = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      req.on('response', (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text || 'null') }));
      });
      req.on('error', reject);
    });
    answer.catch(() => {});
    return { req, answer };
  };
  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(cond()).toBe(true);
  };

  it('reserves the seed budget from Content-Length before reading a body: concurrent hand-offs past it get 503 at once', async () => {
    const size = 400 * 1024;
    const alice = rawHandOff(randomUUID(), apiToken('github:alice'), size);
    const bob = rawHandOff(randomUUID(), apiToken('github:bob'), size);
    alice.req.write(Buffer.alloc(1024));
    bob.req.write(Buffer.alloc(1024));
    await until(() => deps.bundles.reservedBytes === 2 * size);
    // A third would pass the 1 MiB budget: refused before any of its body is read, while the
    // other two are still in flight, and nothing is held yet.
    const carol = rawHandOff(randomUUID(), apiToken('github:carol'), size);
    carol.req.flushHeaders();
    expect(await carol.answer).toEqual({ status: 503, body: { error: 'seed_budget_full' } });
    carol.req.destroy();
    expect(deps.bundles.heldBytes).toBe(0);
    expect(deps.bundles.inMemory).toBe(2 * size);
    // Alice's worker gives up mid-body: her reservation is given back.
    alice.req.destroy();
    await until(() => deps.bundles.reservedBytes === size);
    bob.req.end(Buffer.alloc(size - 1024));
    expect(await bob.answer).toEqual({ status: 200, body: { held: true } });
    expect(deps.bundles.reservedBytes).toBe(0);
    expect(deps.bundles.heldBytes).toBe(size);
  });

  it('refuses a hand-off without a Content-Length (411), or shorter than it declared (400), keeping no reservation', async () => {
    const chunked = rawHandOff(randomUUID(), apiToken('github:alice'));
    // Written before end(), so Node sends it chunked, with no Content-Length.
    chunked.req.write(BUNDLE);
    chunked.req.end();
    expect(await chunked.answer).toEqual({
      status: 411,
      body: { error: 'bundle_length_required' },
    });
    const short = rawHandOff(randomUUID(), apiToken('github:alice'), 100);
    short.req.write(Buffer.alloc(10));
    await until(() => deps.bundles.reservedBytes === 100);
    short.req.destroy();
    await until(() => deps.bundles.reservedBytes === 0);
    expect(deps.bundles.heldBytes).toBe(0);
  });

  it('a resend that fails mid-body or is shorter than declared leaves the held bundle fetchable', async () => {
    const gen = randomUUID();
    await putBundle(gen, BUNDLE);
    for (const end of ['destroy', 'short'] as const) {
      const resend = rawHandOff(gen, apiToken('github:alice'), 100);
      resend.req.write(Buffer.alloc(10));
      await until(() => deps.bundles.reservedBytes === 100);
      if (end === 'destroy') resend.req.destroy();
      else resend.req.socket?.end();
      await until(() => deps.bundles.reservedBytes === 0);
      const got = await seed(attachFor('github:alice', gen));
      expect(got.status).toBe(200);
      expect(Buffer.from(await got.arrayBuffer())).toEqual(BUNDLE);
    }
  });

  it('counts a bundle a seed GET is still sending, even once it is dropped', async () => {
    const gen = randomUUID();
    await putBundle(gen, BUNDLE);
    const wl = workloadKeyFor('github:alice', 'demo', gen);
    const done = deps.bundles.serve(deps.bundles.get(wl)!.bytes);
    deps.bundles.drop(wl);
    expect(deps.bundles.heldBytes).toBe(0);
    expect(deps.bundles.inMemory).toBe(BUNDLE.length);
    done();
    expect(deps.bundles.inMemory).toBe(0);
    // Served end to end: nothing left counted after the response.
    await putBundle(gen, BUNDLE);
    expect((await seed(attachFor('github:alice', gen))).status).toBe(200);
    deps.bundles.drop(wl);
    await until(() => deps.bundles.inMemory === 0);
  });

  it("GET reports a mounted workload's seed: pending while held, bundle_missing when not", async () => {
    const gen = randomUUID();
    const body = { count: 1, revision: REV, mount: 'read-only', storage: { size: '1Gi' } };
    expect((await call('PUT', path(gen), { body })).status).toBe(200);
    expect((await call('GET', path(gen))).body).toMatchObject({ seed: 'bundle_missing' });
    await putBundle(gen, BUNDLE);
    expect((await call('GET', path(gen))).body).toMatchObject({ seed: 'pending' });
  });
});

describe('RestKube', () => {
  it('speaks the namespaced REST paths, merge-patches, and maps 404 and 409', async () => {
    const seen: { method: string; url: string; type?: string; auth?: string }[] = [];
    const api = http.createServer((req, res) => {
      seen.push({
        method: req.method!,
        url: req.url!,
        type: req.headers['content-type'],
        auth: req.headers.authorization,
      });
      req.resume();
      req.on('end', () => {
        const status =
          req.method === 'GET' && req.url!.endsWith('/missing')
            ? 404
            : req.method === 'POST'
              ? 409
              : 200;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(req.url!.includes('?') ? { items: [] } : { metadata: { name: 'x' } }),
        );
      });
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    const kubeApi = new RestKube({
      baseUrl: `http://127.0.0.1:${(api.address() as { port: number }).port}`,
      namespace: 'moca-sandbox',
      token: () => 'sa-token',
    });
    try {
      expect(await kubeApi.get('podtemplates', 'missing')).toBeNull();
      expect(await kubeApi.create('statefulsets', { metadata: { name: 'x' } })).toBe(false);
      expect(await kubeApi.list('pods', 'a=b,c=d')).toEqual([]);
      await kubeApi.patch('statefulsets', 'x', { spec: { replicas: 1 } });
      expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
        'GET /api/v1/namespaces/moca-sandbox/podtemplates/missing',
        'POST /apis/apps/v1/namespaces/moca-sandbox/statefulsets',
        'GET /api/v1/namespaces/moca-sandbox/pods?labelSelector=a%3Db%2Cc%3Dd',
        'PATCH /apis/apps/v1/namespaces/moca-sandbox/statefulsets/x',
      ]);
      expect(seen[3]!.type).toBe('application/merge-patch+json');
      expect(seen.every((s) => s.auth === 'Bearer sa-token')).toBe(true);
    } finally {
      await new Promise<void>((r) => api.close(() => r()));
    }
  });
});
