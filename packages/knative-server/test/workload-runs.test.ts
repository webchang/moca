import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createClient } from 'redis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyIdFor, makeSigner, publicKeyToBase64 } from '@moca/control-plane';

// `/runs` with a workloadId, against a real Redis (where B4 keeps workload records), a fake control
// plane for the session-token exchange, and a fake Context Service bundle export.

const { runLeaf } = vi.hoisted(() => ({ runLeaf: vi.fn() }));
vi.mock('@moca/harness/run-leaf', () => ({
  runLeaf: (...args: unknown[]) => runLeaf(...args),
  validateItem: () => null,
  leafSessionId: (env: { sessionId?: string }) => env.sessionId ?? 'leaf',
}));

import { startServer } from '../src/server.js';
import { clearContextBundleCache } from '../src/context-service.js';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const REVISION = 'c'.repeat(64);
const BUNDLE = gzipSync(Buffer.from('frozen context'));

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const signer = makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
const sessionToken = (sub: string, sid: string) =>
  signer.mint({ sub, tenant: sub, roles: [], scope: ['turn:write'], sid, ttlSeconds: 300 });

const scope = (owner: string) => createHash('sha256').update(owner).digest('hex').slice(0, 32);

const redis = createClient({ url: REDIS_URL });
let server: ReturnType<typeof startServer>;
let cp: http.Server;
let cs: http.Server;
let csCalls: { method: string; path: string; subject: string }[];
let base: string;
let alice: string;
let bob: string;

async function seed(owner: string, name: string, status: string, revision?: string) {
  const contextName = `w-${randomUUID().replaceAll('-', '')}`;
  await redis.set(
    `sh:wl:${scope(owner)}:${name}`,
    JSON.stringify({
      name,
      owner,
      generation: randomUUID(),
      contextName,
      contextId: randomUUID(),
      status,
      contextType: 'workspace',
      workspace: { size: '1Gi' },
      ...(revision ? { revision } : {}),
    }),
  );
  return contextName;
}

async function run(owner: string | null, body: Record<string, unknown>) {
  const sid = String(body.sessionId);
  const response = await fetch(`${base}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(owner ? { authorization: `Bearer ${sessionToken(owner, sid)}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const prompt = (workloadId: string, extra: Record<string, unknown> = {}) => ({
  sessionId: `s-${randomUUID()}`,
  kind: 'prompt',
  prompt: 'Inspect the context.',
  workloadId,
  ...extra,
});

const listen = (s: http.Server) =>
  new Promise<string>((resolve) =>
    s.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(s.address() as { port: number }).port}`),
    ),
  );
const close = (s: http.Server) => new Promise<void>((resolve) => s.close(() => resolve()));

beforeAll(async () => {
  await redis.connect();
});
afterAll(async () => {
  await redis.close();
});

beforeEach(async () => {
  alice = `github:alice-${randomUUID()}`;
  bob = `github:bob-${randomUUID()}`;
  csCalls = [];
  clearContextBundleCache();
  runLeaf.mockReset().mockResolvedValue({ status: 'responded', text: 'ok' });
  cp = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        mode: 'direct',
        anthropicAuthToken: 'sk-test', // notsecret
        anthropicBaseUrl: 'https://litellm.internal/v1',
      }),
    );
  });
  cs = http.createServer((req, res) => {
    csCalls.push({
      method: req.method ?? '',
      path: req.url ?? '',
      subject: String(req.headers['x-context-subject']),
    });
    res
      .writeHead(200, { 'content-type': 'application/vnd.rossoctl.context' })
      .end(Buffer.from(BUNDLE));
  });
  const [cpUrl, csUrl] = await Promise.all([listen(cp), listen(cs)]);
  for (const [key, value] of Object.entries({
    MOCA_CONTEXT_WORKLOADS_ENABLED: '1',
    CONTEXT_SERVICE_URL: csUrl,
    CONTEXT_SERVICE_PUBLIC_URL: 'https://cs.example/',
    CONTEXT_SERVICE_TOKEN: 'cs-service-token', // notsecret
    CONTEXT_SERVICE_NAMESPACE: 'moca',
    SH_SESSION_TOKEN_PUBLIC_KEYS: `${keyIdFor(publicKey)}:${publicKeyToBase64(publicKey)}`,
    SH_CONTROL_PLANE_URL: cpUrl,
    SH_EXCHANGE_TOKEN: 'exchange', // notsecret
    REDIS_URL,
  }))
    vi.stubEnv(key, value);
  server = startServer(0);
  if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all([close(server), close(cp), close(cs)]);
});

describe('a run on a workload', () => {
  it("passes the owner's frozen revision to the harness and loads the bundle lazily", async () => {
    const contextName = await seed(alice, 'demo', 'ready', REVISION);
    const res = await run(alice, prompt('demo'));
    expect(res).toEqual({ status: 200, body: { status: 'responded', text: 'ok' } });
    const env = runLeaf.mock.calls[0]![0];
    expect(env.internalContext.revision).toBe(REVISION);
    // The sandbox cache is keyed per owner, so users never share a copy.
    expect(env.internalContext.ownerScope).toBe(scope(alice));
    // Nothing is downloaded until the harness finds the sandbox lacks the revision.
    expect(csCalls).toEqual([]);

    expect(await env.internalContext.loadBundle()).toEqual(BUNDLE);
    expect(await env.internalContext.loadBundle()).toEqual(BUNDLE);
    expect(csCalls).toEqual([
      {
        method: 'GET',
        path: `/internal/v1/namespaces/moca/contexts/${contextName}/revisions/${REVISION}/bundle`,
        subject: `user:${alice}`,
      },
    ]);
  });

  it("answers 404 for another user's workload, as for a missing one", async () => {
    await seed(alice, 'demo', 'ready', REVISION);
    expect(await run(bob, prompt('demo'))).toEqual({
      status: 404,
      body: { error: 'workload_not_found' },
    });
    expect(await run(alice, prompt('missing'))).toEqual({
      status: 404,
      body: { error: 'workload_not_found' },
    });
    expect(runLeaf).not.toHaveBeenCalled();
  });

  it.each(['creating', 'awaiting_upload', 'deleting'])(
    'answers 409 for a %s workload',
    async (status) => {
      await seed(alice, 'demo', status);
      expect(await run(alice, prompt('demo'))).toEqual({
        status: 409,
        body: { error: 'workload_not_ready' },
      });
      expect(runLeaf).not.toHaveBeenCalled();
    },
  );

  it('answers 404 for a deleted workload', async () => {
    await seed(alice, 'demo', 'deleted', REVISION);
    expect((await run(alice, prompt('demo'))).status).toBe(404);
  });

  it('accepts only prompt runs', async () => {
    await seed(alice, 'demo', 'ready', REVISION);
    expect(
      await run(alice, {
        sessionId: 's-1',
        workloadId: 'demo',
        kind: 'solve',
        problemStatement: 'Fix it.',
        repoUrl: 'https://example.com/repo.git',
        ref: 'main',
      }),
    ).toEqual({ status: 400, body: { error: 'workload_run_requires_prompt' } });
  });

  it('still answers 501 when workloads are off', async () => {
    vi.stubEnv('MOCA_CONTEXT_WORKLOADS_ENABLED', '0');
    await seed(alice, 'demo', 'ready', REVISION);
    expect(await run(alice, prompt('demo'))).toEqual({
      status: 501,
      body: { error: 'workload_runs_unavailable' },
    });
  });

  it('keeps asynchronous workload runs unavailable', async () => {
    await seed(alice, 'demo', 'ready', REVISION);
    expect((await run(alice, prompt('demo', { async: true }))).status).toBe(501);
    expect(runLeaf).not.toHaveBeenCalled();
  });
});
