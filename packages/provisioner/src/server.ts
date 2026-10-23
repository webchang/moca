import { timingSafeEqual, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { CpError, verifyToken } from '@moca/control-plane';
import {
  checkRef,
  deleteWorkload,
  getWorkload,
  parseSandboxSpec,
  ProvisionError,
  putWorkload,
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
 *   DELETE /internal/v1/workloads/{name}/{generation}   200 once no pod of it remains, else 202
 *
 * Two credentials on every call (MI1 I8): the worker's service token (`Authorization`,
 * MOCA_PROVISIONER_TOKEN) and the caller's own control-plane API token (`X-Moca-User-Token`),
 * verified here with SH_SESSION_TOKEN_PUBLIC_KEYS. The owner is that token's subject; the workload
 * key is derived from it, never read from the request.
 */

export const USER_TOKEN_HEADER = 'x-moca-user-token';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const MAX_BODY_BYTES = 64 * 1024;
const ROUTE = /^\/internal\/v1\/workloads\/([^/]+)\/([^/]+)$/;

export interface ServerDeps extends ProvisionerDeps {
  /** MOCA_PROVISIONER_TOKEN. */
  serviceToken: string;
  /** SH_SESSION_TOKEN_PUBLIC_KEYS: the control plane's public keys, for the forwarded API token. */
  userKeys: Map<string, KeyObject>;
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ProvisionError(413, 'body_too_large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
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
  if (!['PUT', 'GET', 'DELETE'].includes(req.method ?? '')) {
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
