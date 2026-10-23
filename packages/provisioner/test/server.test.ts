import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keyIdFor, makeSigner, workloadKeyFor } from '@moca/control-plane';
import { startServer, type ServerDeps } from '../src/server.js';
import { KubeError, RestKube } from '../src/kube.js';
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
let base: string;

beforeEach(async () => {
  kube = new FakeKube();
  kube.objects.podtemplates.set('moca-workload-sandbox', workloadTemplate());
  const deps: ServerDeps = {
    kube,
    signer: makeSigner(attach.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()),
    config: { maxPerWorkload: 2, maxPerOwner: 4, attachTtlS: 86400 },
    serviceToken: SERVICE,
    userKeys: new Map([[keyIdFor(cpPub), cpPub]]),
  };
  server = startServer(deps, 0);
  if (!server.listening) await new Promise<void>((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(() => new Promise<void>((r) => server.close(() => r())));

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
    kube.create = async (kind, obj) => {
      if (kind === 'statefulsets') {
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
    status = 500;
    expect(await call('PUT', path(randomUUID()), { body: { count: 1 } })).toEqual({
      status: 502,
      body: { error: 'kubernetes_error' },
    });
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
