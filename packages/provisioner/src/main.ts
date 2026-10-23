import { fileURLToPath } from 'node:url';
import { credentialValue, makeSigner, parseKeyset } from '@moca/control-plane';
import { inClusterOptions, RestKube } from './kube.js';
import { remintExpiring, type ProvisionerConfig } from './provisioner.js';
import { startServer, type ServerDeps } from './server.js';

/**
 * moca-provisioner (ADR-0043): the only MOCA component with Kubernetes permissions in the sandbox
 * namespace. Secrets are files under CREDENTIALS_DIRECTORY (credentialValue), as the control
 * plane's are: MOCA_ATTACH_PRIVATE_KEY (its own Ed25519 key, PKCS#8 base64 or PEM) and
 * MOCA_PROVISIONER_TOKEN (the workers' service token).
 */

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** A positive integer, the default when unset; anything else refuses to boot. */
export function positiveIntEnv(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const v = env[name];
  if (v === undefined || v === '') return def;
  if (!/^[1-9][0-9]*$/.test(v)) throw new Error(`${name} must be a positive integer, got "${v}"`);
  return Number(v);
}

export function configFromEnv(env: NodeJS.ProcessEnv): ProvisionerConfig {
  return {
    maxPerWorkload: positiveIntEnv(env, 'MOCA_WORKLOAD_MAX_SANDBOXES', 2),
    maxPerOwner: positiveIntEnv(env, 'MOCA_OWNER_MAX_SANDBOXES', 4),
    attachTtlS: positiveIntEnv(env, 'MOCA_ATTACH_TOKEN_TTL_S', 86400),
  };
}

export function depsFromEnv(env: NodeJS.ProcessEnv): ServerDeps & { reconcileS: number } {
  const signer = makeSigner(
    required(credentialValue(env, 'MOCA_ATTACH_PRIVATE_KEY'), 'MOCA_ATTACH_PRIVATE_KEY'),
  );
  const userKeys = parseKeyset(env.SH_SESSION_TOKEN_PUBLIC_KEYS);
  if (userKeys.size === 0) throw new Error('SH_SESSION_TOKEN_PUBLIC_KEYS is required');
  const namespace = env.MOCA_SANDBOX_NAMESPACE?.trim() || 'moca-sandbox';
  return {
    kube: new RestKube(inClusterOptions(env, namespace)),
    signer,
    config: configFromEnv(env),
    serviceToken: required(
      credentialValue(env, 'MOCA_PROVISIONER_TOKEN'),
      'MOCA_PROVISIONER_TOKEN',
    ),
    userKeys,
    reconcileS: positiveIntEnv(env, 'MOCA_PROVISIONER_RECONCILE_S', 300),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const deps = depsFromEnv(process.env);
  const port = positiveIntEnv(process.env, 'MOCA_PROVISIONER_PORT', 8080);
  const server = startServer(deps, port);
  // Re-mint attach tokens nearing expiry (spec §3.1). The orphan sweep of spec §6.2 joins this
  // loop in a later PR.
  const tick = () =>
    remintExpiring(deps)
      .then((n) => n > 0 && console.log(`provisioner: re-minted ${n} attach token(s)`))
      .catch((err: unknown) => console.error('provisioner: re-mint pass failed:', err));
  void tick();
  const timer = setInterval(tick, deps.reconcileS * 1000);
  process.on('SIGTERM', () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
  });
}
