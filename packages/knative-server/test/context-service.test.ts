import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearContextBundleCache,
  ContextServiceError,
  createUploadGrant,
  deleteContext,
  downloadContextBundle,
  publicBaseUrl,
} from '../src/context-service.js';

const grant = {
  uploadUrl: '/v1/uploads/abc_DEF-1',
  token: 'one-time', // notsecret
  expiresAt: '2026-10-09T12:00:00Z',
  method: 'PUT',
  contentType: 'application/vnd.rossoctl.context',
  maxBytes: 268435456,
};

beforeEach(() => {
  vi.stubEnv('CONTEXT_SERVICE_URL', 'http://cs.internal/');
  vi.stubEnv('CONTEXT_SERVICE_TOKEN', 'svc'); // notsecret
  vi.stubEnv('CONTEXT_SERVICE_PUBLIC_URL', 'https://gw.example/cs');
  vi.stubEnv('CONTEXT_SERVICE_NAMESPACE', 'moca');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('CONTEXT_SERVICE_PUBLIC_URL', () => {
  it.each(['https://gw.example', 'http://localhost:8080', 'http://127.0.0.1', 'http://[::1]:9'])(
    'accepts %s',
    (url) => {
      vi.stubEnv('CONTEXT_SERVICE_PUBLIC_URL', url);
      expect(() => publicBaseUrl()).not.toThrow();
    },
  );

  it.each(['', 'http://gw.example', 'https://user:pw@gw.example', 'ftp://gw.example'])(
    'refuses %j',
    (url) => {
      vi.stubEnv('CONTEXT_SERVICE_PUBLIC_URL', url);
      expect(() => publicBaseUrl()).toThrow(/CONTEXT_SERVICE_PUBLIC_URL/);
    },
  );
});

describe('Context Service client', () => {
  it('requests a grant as the user and rebases its URL onto the public address', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(grant), { status: 201 }));
    vi.stubGlobal('fetch', fetch);
    await expect(createUploadGrant('w-1', 'github:alice')).resolves.toEqual({
      ...grant,
      uploadUrl: 'https://gw.example/cs/v1/uploads/abc_DEF-1',
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://cs.internal/v1/namespaces/moca/contexts/w-1/upload-capabilities');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer svc',
      'x-context-subject': 'user:github:alice',
    });
  });

  it.each([
    { ...grant, uploadUrl: 'https://evil.example/v1/uploads/x' },
    { ...grant, uploadUrl: '/v1/uploads/../../admin' },
    { ...grant, method: 'POST' },
    { ...grant, maxBytes: 0 },
    { ...grant, token: '' },
  ])('refuses an invalid grant %#', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 201 })),
    );
    await expect(createUploadGrant('w-1', 'github:alice')).rejects.toBeInstanceOf(
      ContextServiceError,
    );
  });

  it('reports an error status with its code, and an unreachable service as ContextServiceError', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'in_use', message: 'x' }), { status: 409 }),
        )
        .mockRejectedValueOnce(new TypeError('fetch failed')),
    );
    await expect(deleteContext('w-1', 'github:alice')).rejects.toMatchObject({
      status: 409,
      code: 'in_use',
    });
    await expect(deleteContext('w-1', 'github:alice')).rejects.toBeInstanceOf(ContextServiceError);
  });

  it('treats an already-deleted Context as deleted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    await expect(deleteContext('w-1', 'github:alice')).resolves.toBeUndefined();
  });
});

describe('frozen bundle download', () => {
  const REVISION = 'e'.repeat(64);
  const BUNDLE = gzipSync(Buffer.from('x'.repeat(4096)));
  const bundleResponse = (body: BodyInit | null, headers: Record<string, string> = {}) =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/vnd.rossoctl.context', ...headers },
    });

  beforeEach(() => clearContextBundleCache());

  it('downloads from the trusted export as the owner and caches it per owner', async () => {
    const fetch = vi.fn(async () => bundleResponse(new Uint8Array(BUNDLE)));
    vi.stubGlobal('fetch', fetch);
    await expect(downloadContextBundle('w-1', REVISION, 'github:alice')).resolves.toEqual(BUNDLE);
    await expect(downloadContextBundle('w-1', REVISION, 'github:alice')).resolves.toEqual(BUNDLE);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe(
      `http://cs.internal/internal/v1/namespaces/moca/contexts/w-1/revisions/${REVISION}/bundle`,
    );
    expect(init).toMatchObject({
      method: 'GET',
      headers: { authorization: 'Bearer svc', 'x-context-subject': 'user:github:alice' },
    });
    // Another owner never shares the entry.
    await downloadContextBundle('w-1', REVISION, 'github:bob');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares one download between concurrent requests for the same revision', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetch = vi.fn(async () => {
      await gate;
      return bundleResponse(new Uint8Array(BUNDLE));
    });
    vi.stubGlobal('fetch', fetch);
    const loads = [1, 2, 3].map(() => downloadContextBundle('w-2', REVISION, 'github:alice'));
    release();
    for (const bundle of await Promise.all(loads)) expect(bundle).toEqual(BUNDLE);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a bundle whose Content-Length exceeds the ceiling', async () => {
    vi.stubEnv('MOCA_CONTEXT_BUNDLE_MAX_BYTES', '16');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bundleResponse(new Uint8Array(BUNDLE), { 'content-length': '4096' })),
    );
    await expect(downloadContextBundle('w-3', REVISION, 'github:alice')).rejects.toThrow(
      'MOCA_CONTEXT_BUNDLE_MAX_BYTES',
    );
  });

  it('refuses a streamed bundle that grows past the ceiling with no Content-Length', async () => {
    vi.stubEnv('MOCA_CONTEXT_BUNDLE_MAX_BYTES', String(BUNDLE.length - 1));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(BUNDLE.subarray(0, 10)));
        controller.enqueue(new Uint8Array(BUNDLE.subarray(10)));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bundleResponse(stream)),
    );
    await expect(downloadContextBundle('w-4', REVISION, 'github:alice')).rejects.toThrow(
      'MOCA_CONTEXT_BUNDLE_MAX_BYTES',
    );
  });

  it('rejects a truncated gzip stream and does not cache it', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(bundleResponse(new Uint8Array(BUNDLE.subarray(0, BUNDLE.length - 8))))
      .mockResolvedValueOnce(bundleResponse(new Uint8Array(BUNDLE)));
    vi.stubGlobal('fetch', fetch);
    await expect(downloadContextBundle('w-5', REVISION, 'github:alice')).rejects.toThrow(
      'truncated or invalid bundle',
    );
    // The next request downloads again rather than reusing the failure.
    await expect(downloadContextBundle('w-5', REVISION, 'github:alice')).resolves.toEqual(BUNDLE);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refuses a reply that is not a context bundle', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })),
    );
    await expect(downloadContextBundle('w-6', REVISION, 'github:alice')).rejects.toThrow(
      'content type',
    );
  });

  it('evicts the least recently used bundle past MOCA_CONTEXT_BUNDLE_CACHE_BYTES', async () => {
    vi.stubEnv('MOCA_CONTEXT_BUNDLE_CACHE_BYTES', String(BUNDLE.length * 2));
    const fetch = vi.fn(async () => bundleResponse(new Uint8Array(BUNDLE)));
    vi.stubGlobal('fetch', fetch);
    for (const name of ['a', 'b', 'a', 'c', 'a', 'b'])
      await downloadContextBundle(`w-${name}`, REVISION, 'github:alice');
    // a, b, (a hit), c evicts b, (a hit), b again evicts c.
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
