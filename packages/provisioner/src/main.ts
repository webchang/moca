import { fileURLToPath } from 'node:url';
import {
  credentialValue,
  makeSigner,
  parseKeyset,
  parseStorageClasses,
  publicKeyFromBase64,
  storageMiB,
} from '@moca/control-plane';
import type { KeyObject } from 'node:crypto';
import { inClusterOptions, RestKube } from './kube.js';
import {
  remintExpiring,
  settleSeeds,
  type ProvisionerConfig,
  type ProvisionerDeps,
} from './provisioner.js';
import { BundleStore, DEFAULT_SEED_HOLD_S } from './seed.js';
import { startSeedServer, startServer, type ServerDeps } from './server.js';

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
  const maxStorage = env.MOCA_WORKLOAD_MAX_STORAGE?.trim() || '10Gi';
  const maxMiB = storageMiB(maxStorage);
  if (maxMiB === null) {
    throw new Error(`MOCA_WORKLOAD_MAX_STORAGE must be <n>Mi or <n>Gi, got "${maxStorage}"`);
  }
  return {
    maxPerWorkload: positiveIntEnv(env, 'MOCA_WORKLOAD_MAX_SANDBOXES', 2),
    maxPerOwner: positiveIntEnv(env, 'MOCA_OWNER_MAX_SANDBOXES', 4),
    attachTtlS: positiveIntEnv(env, 'MOCA_ATTACH_TOKEN_TTL_S', 86400),
    storage: { maxMiB, classes: parseStorageClasses(env.MOCA_WORKLOAD_STORAGE_CLASSES) },
    seedUrl:
      env.MOCA_PROVISIONER_SEED_URL?.trim() ||
      'http://moca-provisioner.moca.svc:8081/seed/v1/bundle',
    maxEntries: positiveIntEnv(env, 'MOCA_CONTEXT_BUNDLE_MAX_ENTRIES', 10_000),
  };
}

export function depsFromEnv(env: NodeJS.ProcessEnv): ServerDeps & {
  reconcileS: number;
  attachKeys: Map<string, KeyObject>;
} {
  const signer = makeSigner(
    required(credentialValue(env, 'MOCA_ATTACH_PRIVATE_KEY'), 'MOCA_ATTACH_PRIVATE_KEY'),
  );
  const userKeys = parseKeyset(env.SH_SESSION_TOKEN_PUBLIC_KEYS);
  if (userKeys.size === 0) throw new Error('SH_SESSION_TOKEN_PUBLIC_KEYS is required');
  const namespace = env.MOCA_SANDBOX_NAMESPACE?.trim() || 'moca-sandbox';
  const budget = positiveIntEnv(env, 'MOCA_PROVISIONER_SEED_BUDGET_BYTES', 1024 * 1024 * 1024);
  const maxBundleBytes = positiveIntEnv(env, 'MOCA_CONTEXT_BUNDLE_MAX_BYTES', 256 * 1024 * 1024);
  // One owner holds at most half the budget, so a largest bundle must fit in half of it.
  if (maxBundleBytes > Math.floor(budget / 2)) {
    throw new Error(
      'MOCA_PROVISIONER_SEED_BUDGET_BYTES must be at least twice MOCA_CONTEXT_BUNDLE_MAX_BYTES',
    );
  }
  return {
    kube: new RestKube(inClusterOptions(env, namespace)),
    signer,
    // The seed port verifies attach tokens with this provisioner's own public key.
    attachKeys: new Map([[signer.kid, publicKeyFromBase64(signer.publicKeyBase64)]]),
    config: configFromEnv(env),
    // Held bundles and hand-offs in flight together, half of it per owner; each held at most
    // MOCA_PROVISIONER_SEED_HOLD_S (spec §5.2).
    bundles: new BundleStore(
      budget,
      positiveIntEnv(env, 'MOCA_PROVISIONER_SEED_HOLD_S', DEFAULT_SEED_HOLD_S),
    ),
    // Phase 1's ceiling on a downloaded bundle (MOCA_CONTEXT_BUNDLE_MAX_BYTES), held to again here:
    // setup.sh gives the provisioner the workers' value.
    maxBundleBytes,
    serviceToken: required(
      credentialValue(env, 'MOCA_PROVISIONER_TOKEN'),
      'MOCA_PROVISIONER_TOKEN',
    ),
    userKeys,
    reconcileS: positiveIntEnv(env, 'MOCA_PROVISIONER_RECONCILE_S', 300),
  };
}

/** How often seeds are checked while one may be in progress. */
export const SEED_POLL_MS = 5000;

/**
 * The seed-settle pass (settleSeeds), run once at startup by the reconcile tick and then every
 * SEED_POLL_MS while a bundle is held or a StatefulSet still carries the seed annotation: a seed
 * that finishes after a restart (nothing held) is settled in seconds, not at the next reconcile, so
 * GET does not report bundle_missing for a seed that succeeded. One pass at a time.
 */
export function seedSettler(deps: ProvisionerDeps) {
  let pending = 0;
  let running: Promise<void> | null = null;
  const run = (): Promise<void> =>
    (running ??= settleSeeds(deps)
      .then((r) => {
        pending = r.pending;
        if (r.settled > 0) console.log(`provisioner: ${r.settled} workload PVC(s) seeded`);
      })
      .catch((err: unknown) => console.error('provisioner: seed pass failed:', err))
      .finally(() => {
        running = null;
      }));
  return {
    run,
    /** The poll: a pass only while something may still seed. */
    poll: (): Promise<void> =>
      pending > 0 || deps.bundles.heldBytes > 0 ? run() : Promise.resolve(),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const deps = depsFromEnv(process.env);
  const port = positiveIntEnv(process.env, 'MOCA_PROVISIONER_PORT', 8080);
  const server = startServer(deps, port);
  const seedServer = startSeedServer(
    deps,
    positiveIntEnv(process.env, 'MOCA_PROVISIONER_SEED_PORT', 8081),
  );
  const settle = seedSettler(deps);
  // Re-mint attach tokens nearing expiry (spec §3.1), and finish seeds a restart left behind
  // (spec §5.3). The orphan sweep of spec §6.2 joins this loop in a later PR.
  const tick = () => {
    void settle.run();
    return remintExpiring(deps)
      .then((n) => n > 0 && console.log(`provisioner: re-minted ${n} attach token(s)`))
      .catch((err: unknown) => console.error('provisioner: re-mint pass failed:', err));
  };
  void tick();
  const timer = setInterval(tick, deps.reconcileS * 1000);
  const seedTimer = setInterval(() => void settle.poll(), SEED_POLL_MS);
  process.on('SIGTERM', () => {
    clearInterval(timer);
    clearInterval(seedTimer);
    seedServer.close();
    server.close(() => process.exit(0));
  });
}
