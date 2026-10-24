import { timingSafeEqual, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { CpError, verifyAttachToken, verifyToken } from '@moca/control-plane';
import {
  checkRef,
  deleteWorkload,
  getWorkload,
  parseSandboxSpec,
  ProvisionError,
  putBundle,
  putWorkload,
  reserveBundle,
  type ProvisionerDeps,
  type WorkloadRef,
} from './provisioner.js';
import { KubeError } from './kube.js';

/**
 * The provisioner's internal API (workload sandboxes spec §4.1), reached only by the supervisor's
 * workers (NetworkPolicy):
 *
 *   PUT    /internal/v1/workloads/{name}/{generation}   create or converge; idempotent by (wl, gen)
 *   GET    /internal/v1/workloads/{name}/{generation}   replicas wanted and ready
 *   DELETE /internal/v1/workloads/{name}/{generation}   200 once no pod or PVC of it remains, else 202
 *   PUT    /internal/v1/workloads/{name}/{generation}/bundle   the frozen bundle to seed from (§5.2)
 *
 * Two credentials on every call (MI1 I8): the worker's service token (`Authorization`,
 * MOCA_PROVISIONER_TOKEN) and the caller's own control-plane API token (`X-Moca-User-Token`),
 * verified here with SH_SESSION_TOKEN_PUBLIC_KEYS. The owner is that token's subject; the workload
 * key is derived from it, never read from the request.
 *
 * The seed port (startSeedServer) serves only `GET /seed/v1/bundle` to workload sandboxes' init
 * containers, authenticated with the workload's attach token (spec §5.2).
 */

export const USER_TOKEN_HEADER = 'x-moca-user-token';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const MAX_BODY_BYTES = 64 * 1024;
const ROUTE = /^\/internal\/v1\/workloads\/([^/]+)\/([^/]+)(\/bundle)?$/;
export const BUNDLE_TYPE = 'application/vnd.rossoctl.context';
/** How long a worker waits after `503 seed_budget_full`: about one seed's time to finish. */
const SEED_RETRY_AFTER_S = 15;

export interface ServerDeps extends ProvisionerDeps {
  /** MOCA_PROVISIONER_TOKEN. */
  serviceToken: string;
  /** SH_SESSION_TOKEN_PUBLIC_KEYS: the control plane's public keys, for the forwarded API token. */
  userKeys: Map<string, KeyObject>;
  /** MOCA_CONTEXT_BUNDLE_MAX_BYTES: the largest bundle one hand-off may carry, as the workers'. */
  maxBundleBytes: number;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS).end(JSON.stringify(body));
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

function bearer(req: IncomingMessage): string | undefined {
  const raw = header(req, 'authorization');
  const m = raw ? /^Bearer\s+(\S+)\s*$/i.exec(raw) : null;
  return m?.[1];
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(header(req, 'content-length'));
  if (Number.isFinite(declared) && declared > max) throw new ProvisionError(413, 'body_too_large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new ProvisionError(413, 'body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

/**
 * A bundle hand-off's body, read into one buffer of its declared Content-Length: never more than
 * that in memory, and no concat copy. The caller has already reserved those bytes of the seed
 * budget. A body shorter or longer than declared (the worker gave up) is a 400.
 */
async function readBundle(req: IncomingMessage, declared: number): Promise<Buffer> {
  const out = Buffer.allocUnsafe(declared);
  let size = 0;
  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      if (size + chunk.length > declared) break;
      chunk.copy(out, size);
      size += chunk.length;
    }
  } catch {
    // The worker closed the connection mid-body (it gave up).
    throw new ProvisionError(400, 'bundle_length_mismatch');
  }
  if (size !== declared) throw new ProvisionError(400, 'bundle_length_mismatch');
  return out;
}

/**
 * A bundle hand-off's declared size. It is required, so the seed budget is reserved before the body
 * is read: 411 without it, 413 bundle_too_large past MOCA_CONTEXT_BUNDLE_MAX_BYTES, 400 when empty.
 */
function bundleLength(req: IncomingMessage, max: number): number {
  const raw = header(req, 'content-length');
  if (raw === undefined || !/^\d{1,15}$/.test(raw.trim())) {
    throw new ProvisionError(411, 'bundle_length_required');
  }
  const declared = Number(raw);
  if (declared > max) throw new ProvisionError(413, 'bundle_too_large');
  if (declared === 0) throw new ProvisionError(400, 'bundle_empty');
  return declared;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req, MAX_BODY_BYTES);
  try {
    return JSON.parse(body.toString());
  } catch {
    throw new ProvisionError(400, 'invalid_json');
  }
}

/** The owner, from the forwarded API token. Throws a 401 ProvisionError. */
function ownerOf(req: IncomingMessage, deps: ServerDeps): string {
  const presented = header(req, USER_TOKEN_HEADER)?.trim();
  if (!presented) throw new ProvisionError(401, 'user_token_required');
  const now = deps.now?.() ?? Math.floor(Date.now() / 1000);
  try {
    return verifyToken(presented, deps.userKeys, { now, requiredScope: 'api' }).sub;
  } catch (err) {
    if (err instanceof CpError) throw new ProvisionError(401, err.code);
    throw err;
  }
}

export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
): Promise<void> {
  const path = (req.url ?? '').split('?', 1)[0]!;
  if (req.method === 'GET' && path === '/healthz') return send(res, 200, { status: 'ok' });
  const match = ROUTE.exec(path);
  if (!match) return send(res, 404, { error: 'not_found' });
  const bundle = match[3] !== undefined;
  if (!(bundle ? ['PUT'] : ['PUT', 'GET', 'DELETE']).includes(req.method ?? '')) {
    return send(res, 405, { error: 'method_not_allowed' });
  }
  const presented = bearer(req);
  if (!presented || !sameSecret(presented, deps.serviceToken)) {
    return send(res, 401, { error: 'unauthorized' });
  }
  try {
    const owner = ownerOf(req, deps);
    let name: string;
    let generation: string;
    try {
      name = decodeURIComponent(match[1]!);
      generation = decodeURIComponent(match[2]!);
    } catch {
      throw new ProvisionError(404, 'workload_not_found');
    }
    checkRef(name, generation);
    const ref: WorkloadRef = { owner, name, generation };
    if (bundle) {
      if (header(req, 'content-type')?.split(';', 1)[0]?.trim() !== BUNDLE_TYPE) {
        throw new ProvisionError(415, 'bundle_content_type_invalid');
      }
      // Reserved before a byte is read (503 seed_budget_full), and given back however this ends:
      // held bundles plus hand-offs in flight never pass MOCA_PROVISIONER_SEED_BUDGET_BYTES.
      const declared = bundleLength(req, deps.maxBundleBytes);
      const release = reserveBundle(deps, ref, declared);
      try {
        return send(res, 200, await putBundle(deps, ref, await readBundle(req, declared)));
      } finally {
        release();
      }
    }
    if (req.method === 'PUT') {
      const spec = parseSandboxSpec(await readJson(req), deps.config);
      return send(res, 200, await putWorkload(deps, ref, spec));
    }
    if (req.method === 'GET') return send(res, 200, await getWorkload(deps, ref));
    const { remaining } = await deleteWorkload(deps, ref);
    return send(res, remaining === 0 ? 200 : 202, { remaining });
  } catch (err) {
    if (err instanceof ProvisionError) {
      if (err.status >= 500) console.error('provisioner:', err.message);
      if (err.code === 'seed_budget_full') res.setHeader('Retry-After', String(SEED_RETRY_AFTER_S));
      // A refused hand-off's body is never read: close, so the worker stops sending it.
      if (bundle && !req.readableEnded) res.setHeader('Connection', 'close');
      return send(res, err.status, { error: err.code });
    }
    console.error('provisioner: request failed:', err instanceof KubeError ? err.message : err);
    // The API server refusing the objects themselves -- the admission policy (403) or an invalid
    // object (422) -- is a permanent misconfiguration, not an outage: retrying will not help.
    if (err instanceof KubeError && (err.status === 403 || err.status === 422)) {
      return send(res, 422, { error: 'workload_refused' });
    }
    // Any other Kubernetes API failure is the provisioner's dependency failing: 502, as the
    // worker's Context Service failures are.
    return send(res, err instanceof KubeError ? 502 : 500, {
      error: err instanceof KubeError ? 'kubernetes_error' : 'internal_error',
    });
  }
}

/**
 * The seed port: `GET /seed/v1/bundle` with a workload's attach token as the bearer, verified with
 * this provisioner's own public key. The token's `wl` and `gen` pick the bundle, so an init
 * container can fetch only its own workload's, and only while it is held (spec §5.2). Model code in
 * the pod holds the same token and can fetch it too; it can read that revision anyway.
 */
export async function handleSeed(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ProvisionerDeps & { attachKeys: Map<string, KeyObject> },
): Promise<void> {
  const path = (req.url ?? '').split('?', 1)[0]!;
  if (path !== '/seed/v1/bundle') return send(res, 404, { error: 'not_found' });
  if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
  const presented = bearer(req);
  if (!presented) return send(res, 401, { error: 'unauthorized' });
  let claims: { wl: string; gen: string };
  try {
    claims = verifyAttachToken(presented, deps.attachKeys, { now: deps.now?.() });
  } catch (err) {
    if (err instanceof CpError) return send(res, 401, { error: 'unauthorized' });
    throw err;
  }
  const held = deps.bundles.get(claims.wl);
  // Not held: a provisioner restart lost it, or the seed has finished. The worker's next activate
  // resends it (spec §5.2).
  if (!held || held.gen !== claims.gen) return send(res, 404, { error: 'seed_bundle_missing' });
  // Counted against the seed budget until sent, even if the bundle is dropped meanwhile.
  const done = deps.bundles.serve(held.bytes);
  res.once('close', done);
  res
    .writeHead(200, { 'Content-Type': BUNDLE_TYPE, 'Content-Length': held.bytes.length })
    .end(held.bytes);
}

export function startSeedServer(
  deps: ProvisionerDeps & { attachKeys: Map<string, KeyObject> },
  port: number,
): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    handleSeed(req, res, deps).catch((err: unknown) => {
      console.error('provisioner: seed request failed', err);
      if (!res.headersSent) send(res, 500, { error: 'internal_error' });
    });
  });
  server.listen(port, () => console.log(`moca-provisioner seed port listening on :${port}`));
  return server;
}

export function startServer(deps: ServerDeps, port: number): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    handle(req, res, deps).catch((err: unknown) => {
      console.error('provisioner: unhandled', err);
      if (!res.headersSent) send(res, 500, { error: 'internal_error' });
    });
  });
  server.listen(port, () => console.log(`moca-provisioner listening on :${port}`));
  return server;
}
