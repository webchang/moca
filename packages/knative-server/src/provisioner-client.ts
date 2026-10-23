/**
 * Client for moca-provisioner's internal API (workload sandboxes spec §4.1, ADR-0043). The worker
 * presents its service token (MOCA_PROVISIONER_TOKEN) and forwards the caller's own API token; the
 * provisioner verifies that token itself and derives the workload key from its subject, so no
 * request here names a workload key.
 *
 * Off unless MOCA_PROVISIONER_URL is set: without it, `sandboxes` on POST /workloads is refused as
 * any unknown field is, and nothing here is called.
 */

export const USER_TOKEN_HEADER = 'x-moca-user-token';

export class ProvisionerError extends Error {
  constructor(
    message: string,
    /** The status the provisioner answered, when it answered. */
    readonly status?: number,
    /** Its `error` code, when it sent one. */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ProvisionerError';
  }
}

export function provisionerConfigured(): boolean {
  return (process.env.MOCA_PROVISIONER_URL?.trim().length ?? 0) > 0;
}

/** Throws when the provisioner is configured without its token. */
export function assertProvisionerSettings(): void {
  if (provisionerConfigured() && !process.env.MOCA_PROVISIONER_TOKEN?.trim()) {
    throw new Error('MOCA_PROVISIONER_TOKEN is required with MOCA_PROVISIONER_URL');
  }
}

export interface WorkloadRefForProvisioner {
  name: string;
  generation: string;
  /** The caller's control-plane API token, forwarded verbatim. */
  userToken: string;
}

async function call(
  method: 'PUT' | 'DELETE',
  ref: WorkloadRefForProvisioner,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const base = process.env.MOCA_PROVISIONER_URL?.trim().replace(/\/+$/, '');
  const token = process.env.MOCA_PROVISIONER_TOKEN?.trim();
  if (!base || !token) throw new Error('the provisioner is not configured');
  const timeout = Number.parseInt(process.env.MOCA_PROVISIONER_TIMEOUT_MS ?? '', 10);
  const path = `/internal/v1/workloads/${encodeURIComponent(ref.name)}/${encodeURIComponent(ref.generation)}`;
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      [USER_TOKEN_HEADER]: ref.userToken,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(Number.isSafeInteger(timeout) && timeout > 0 ? timeout : 15_000),
  }).catch((err: unknown) => {
    throw new ProvisionerError(`the provisioner is unreachable: ${String(err)}`);
  });
  const json = ((await response.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof json.error === 'string' ? json.error : undefined;
    throw new ProvisionerError(
      `the provisioner answered ${response.status}${code ? ` ${code}` : ''}`,
      response.status,
      code,
    );
  }
  return { status: response.status, json };
}

/** Create or converge the workload's sandboxes. Idempotent by (name, generation). */
export async function provisionSandboxes(
  ref: WorkloadRefForProvisioner,
  spec: { count: number; tier: string; revision: string },
): Promise<void> {
  await call('PUT', ref, spec);
}

/**
 * Delete the workload's sandboxes. Resolves `true` once no pod of it remains (200), `false` while
 * pods are still terminating (202); the caller repeats.
 */
export async function deleteSandboxes(ref: WorkloadRefForProvisioner): Promise<boolean> {
  return (await call('DELETE', ref)).status === 200;
}
