import {
  ATTACH_OWNER_RE,
  ATTACH_WORKLOAD_RE,
  WORKLOAD_MOUNTS,
  mintAttachToken,
  ownerScopeFor,
  resolveWorkloadStorage,
  workloadKeyFor,
  workloadRecordKey,
  type WorkloadMount,
  type WorkloadStorage,
  type WorkloadStorageCaps,
} from '@moca/control-plane';
import type { KubeApi, KubeObject } from './kube.js';
import {
  BundleStore,
  SEED_REVISION_DIR,
  SEED_REVISION_SCRIPT,
  SEED_WORKSPACE_DIR,
  SEED_WORKSPACE_SCRIPT,
} from './seed.js';

/**
 * What moca-provisioner does for one workload (workload sandboxes spec §4, ADR-0043): a Secret
 * `<wl>-attach` holding the workload's attach token, a headless Service `<wl>`, and a StatefulSet
 * `<wl>` whose pods attach to the relay with that token. `wl` is derived here from the verified
 * owner, so a caller can only ever reach its own owner's objects.
 *
 * A workload with a mount (`workspace.mount`, spec §5) also gets PVC `<wl>`, seeded once from its
 * frozen bundle by two init containers and mounted at /workspace/context. One without a mount gets
 * no PVC, and its context arrives by copy onto these sandboxes, as in phase 1.
 *
 * It never reads a Secret (its Role has no get or list on them): what re-minting needs -- the
 * token's expiry, lifetime, signing key and `n` -- is kept as annotations on the workload's
 * StatefulSet, and a re-minted token overwrites its Secret blind.
 */

export const APP_LABEL = 'moca-workload-sandbox';
export const WORKLOAD_LABEL = 'moca.dev/workload';
export const OWNER_LABEL = 'moca.dev/owner';
export const MANAGED_BY = 'moca-provisioner';
const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
const GENERATION_ANNOTATION = 'moca.dev/generation';
const RECORD_KEY_ANNOTATION = 'moca.dev/record-key';
const TIER_ANNOTATION = 'moca.dev/tier';
const COUNT_ANNOTATION = 'moca.dev/sandbox-count';
const REVISION_ANNOTATION = 'moca.dev/revision';
const MOUNT_ANNOTATION = 'moca.dev/mount';
/**
 * On the pod template only while the claim is unseeded (spec §5.3): the init containers read it
 * through the downward API and do nothing without it. Removed once pod `<wl>-0` has seeded.
 */
export const SEED_ANNOTATION = 'moca.dev/seed-revision';
/** The attach token's expiry, issue time and signing key, on the StatefulSet (spec §3.1). */
const EXP_ANNOTATION = 'moca.dev/attach-exp';
const IAT_ANNOTATION = 'moca.dev/attach-iat';
const KID_ANNOTATION = 'moca.dev/attach-kid';
/**
 * The PodTemplate in moca-sandbox every workload sandbox starts from (spec §4.2): an operator's
 * manifest (deploy/k8s/base/workload-sandboxes/template.yaml), the only one the Role can read.
 */
export const TEMPLATE = 'moca-workload-sandbox';
const TOKEN_KEY = 'token';
const TOKEN_DIR = '/run/moca-attach';
/** Where a mounted workload's context appears in its sandboxes (spec §5.3). */
export const CONTEXT_MOUNT = '/workspace/context';
const CONTEXT_VOLUME = 'context';

/** A workload name: what workloads.ts accepts. */
export const NAME_RE = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
export const MAX_NAME_LENGTH = 50;
/** A generation: workloads.ts mints a UUID; anything else is refused. */
export const GENERATION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REVISION_RE = /^[a-f0-9]{64}$/;
/** A record key, as workloadRecordKey makes it: `sh:wl:<owner scope>:<name>`. */
const RECORD_KEY_RE = /^sh:wl:[0-9a-f]{32}:[a-z0-9](?:[-a-z0-9]{0,48}[a-z0-9])?$/;

export interface ProvisionerConfig {
  /** MOCA_WORKLOAD_MAX_SANDBOXES: `count` per workload. */
  maxPerWorkload: number;
  /** MOCA_OWNER_MAX_SANDBOXES: an owner's replicas across all of its workloads. */
  maxPerOwner: number;
  /** MOCA_ATTACH_TOKEN_TTL_S. A token is re-minted once less than half of it remains. */
  attachTtlS: number;
  /** MOCA_WORKLOAD_MAX_STORAGE and MOCA_WORKLOAD_STORAGE_CLASSES: the PVC's caps (spec §6.3). */
  storage: WorkloadStorageCaps;
  /** MOCA_PROVISIONER_SEED_URL: what the init containers fetch the bundle from (spec §5.2). */
  seedUrl: string;
  /** MOCA_CONTEXT_BUNDLE_MAX_ENTRIES: phase 1's entry ceiling, applied by the seed too. */
  maxEntries: number;
}

export interface ProvisionerDeps {
  kube: KubeApi;
  /** Signs attach tokens with the provisioner's Ed25519 key (makeSigner). */
  signer: { kid: string; signJws(typ: string, claims: object): string };
  config: ProvisionerConfig;
  /** Bundles handed over for seeding, until the seed has run (spec §5.2). */
  bundles: BundleStore;
  /** Epoch seconds. */
  now?: () => number;
}

export interface WorkloadRef {
  owner: string;
  name: string;
  generation: string;
}

export interface SandboxSpec {
  count: number;
  tier: 'container';
  revision?: string;
  /** With `storage` and `revision`: the workload's own PVC, mounted this way (spec §5.3). */
  mount?: WorkloadMount;
  storage?: WorkloadStorage;
}

export interface SandboxStatus {
  workloadId: string;
  generation: string;
  count: number;
  /** Pods the StatefulSet reports Ready. The relay's records are what the worker counts. */
  ready: number;
  /**
   * A mounted workload's seed (spec §5.2): `pending` while its bundle is held, `bundle_missing`
   * when it is unseeded and no bundle is held (a provisioner restart), `done` once seeded.
   */
  seed?: 'pending' | 'bundle_missing' | 'done';
}

/** A refusal with a stable code; `status` is the HTTP status the API answers with. */
export class ProvisionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'ProvisionError';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const SPEC_FIELDS = ['count', 'tier', 'revision', 'mount', 'storage'];

/**
 * The PUT body: `count`, `tier`, the frozen revision, and for a mounted workload `mount` and
 * `storage` (`size`, `storageClass`). No field names a workload key.
 */
export function parseSandboxSpec(body: unknown, config: ProvisionerConfig): SandboxSpec {
  if (!isObject(body)) throw new ProvisionError(400, 'sandboxes_invalid');
  if (Object.keys(body).some((k) => !SPEC_FIELDS.includes(k))) {
    throw new ProvisionError(400, 'sandboxes_field_not_allowed');
  }
  const { count, tier = 'container', revision, mount, storage } = body;
  if (!Number.isSafeInteger(count) || (count as number) < 1) {
    throw new ProvisionError(400, 'sandboxes_count_invalid');
  }
  // The worker checks this too; the provisioner does not trust its arithmetic (spec §6.3).
  if ((count as number) > config.maxPerWorkload) {
    throw new ProvisionError(400, 'sandboxes_count_exceeded');
  }
  // P4 hosts sit outside the cluster, where this Role cannot reach (spec §7).
  if (tier === 'microvm') throw new ProvisionError(400, 'sandbox_tier_unavailable');
  if (tier !== 'container') throw new ProvisionError(400, 'sandbox_tier_invalid');
  if (revision !== undefined && (typeof revision !== 'string' || !REVISION_RE.test(revision))) {
    throw new ProvisionError(400, 'revision_invalid');
  }
  if (mount === undefined) {
    if (storage !== undefined) throw new ProvisionError(400, 'workspace_mount_invalid');
    return { count: count as number, tier, ...(revision ? { revision } : {}) };
  }
  if (!WORKLOAD_MOUNTS.includes(mount as WorkloadMount) || !revision) {
    throw new ProvisionError(400, 'workspace_mount_invalid');
  }
  if (
    !isObject(storage) ||
    Object.keys(storage).some((k) => !['size', 'storageClass'].includes(k))
  ) {
    throw new ProvisionError(400, 'workspace_field_not_allowed');
  }
  // The worker checks these too (spec §6.3).
  const claim = resolveWorkloadStorage(storage, config.storage);
  if (typeof claim === 'string') throw new ProvisionError(400, claim);
  // Several sandboxes on ReadWriteOnce share one node (podTemplate's affinity); nothing more here.
  return {
    count: count as number,
    tier,
    revision: revision as string,
    mount: mount as WorkloadMount,
    storage: claim,
  };
}

export function checkRef(name: string, generation: string): void {
  if (name.length > MAX_NAME_LENGTH || !NAME_RE.test(name)) {
    throw new ProvisionError(404, 'workload_not_found');
  }
  if (!GENERATION_RE.test(generation)) throw new ProvisionError(404, 'workload_not_found');
}

interface Keys {
  wl: string;
  own: string;
}
const keysOf = (ref: WorkloadRef): Keys => ({
  wl: workloadKeyFor(ref.owner, ref.name, ref.generation),
  own: ownerScopeFor(ref.owner),
});

const secretName = (wl: string) => `${wl}-attach`;

function labels(k: Keys): Record<string, string> {
  return {
    app: APP_LABEL,
    [WORKLOAD_LABEL]: k.wl,
    [OWNER_LABEL]: k.own,
    [MANAGED_BY_LABEL]: MANAGED_BY,
  };
}

function annotations(ref: WorkloadRef, spec: SandboxSpec): Record<string, string> {
  return {
    [RECORD_KEY_ANNOTATION]: workloadRecordKey(ref.owner, ref.name),
    [GENERATION_ANNOTATION]: ref.generation,
    [TIER_ANNOTATION]: spec.tier,
    [COUNT_ANNOTATION]: String(spec.count),
    ...(spec.revision ? { [REVISION_ANNOTATION]: spec.revision } : {}),
    ...(spec.mount ? { [MOUNT_ANNOTATION]: spec.mount } : {}),
  };
}

const nowOf = (deps: ProvisionerDeps) => (deps.now ?? (() => Math.floor(Date.now() / 1000)))();

/** A fresh token, and the StatefulSet annotations that remember it. */
function mint(deps: ProvisionerDeps, k: Keys, gen: string, tier: string, n: number) {
  const now = nowOf(deps);
  const token = mintAttachToken(deps.signer, {
    wl: k.wl,
    own: k.own,
    gen,
    tr: tier,
    n,
    now,
    ttlSeconds: deps.config.attachTtlS,
  });
  return {
    token,
    annotations: {
      [COUNT_ANNOTATION]: String(n),
      [IAT_ANNOTATION]: String(now),
      [EXP_ANNOTATION]: String(now + deps.config.attachTtlS),
      [KID_ANNOTATION]: deps.signer.kid,
    },
  };
}

/**
 * Write the workload's Secret without reading it: create, or overwrite one already there (an
 * unconditional replace, no resourceVersion). The name is derived from the verified owner, and the
 * admission policy holds this ServiceAccount to `w-<32 hex>-attach` names.
 */
async function writeSecret(
  deps: ProvisionerDeps,
  k: Keys,
  recordKey: string,
  gen: string,
  token: string,
) {
  const secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
      name: secretName(k.wl),
      labels: labels(k),
      annotations: { [RECORD_KEY_ANNOTATION]: recordKey, [GENERATION_ANNOTATION]: gen },
    },
    data: { [TOKEN_KEY]: Buffer.from(token).toString('base64') },
  };
  if (!(await deps.kube.create('secrets', secret))) await deps.kube.replace('secrets', secret);
}

/**
 * True when the StatefulSet's token is not for this binding (count, tier), was signed with a key
 * this provisioner no longer holds (a rotation), or has less than half its lifetime left.
 */
function needsMint(deps: ProvisionerDeps, sts: KubeObject, spec: SandboxSpec): boolean {
  const a = sts.metadata.annotations ?? {};
  const iat = Number(a[IAT_ANNOTATION]);
  const exp = Number(a[EXP_ANNOTATION]);
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat) return true;
  if (a[COUNT_ANNOTATION] !== String(spec.count) || a[TIER_ANNOTATION] !== spec.tier) return true;
  if (a[KID_ANNOTATION] !== deps.signer.kid) return true;
  return exp - nowOf(deps) < (exp - iat) / 2;
}

/**
 * One owner's PUTs, DELETEs and re-mints run one at a time, so two concurrent PUTs cannot both pass
 * the owner cap on the same count, and a DELETE cannot interleave with a PUT still converging (or a
 * re-mint's Secret write) and leave objects behind it. In-process only: the provisioner runs as exactly one replica
 * (deploy/k8s/base/workload-sandboxes/provisioner.yaml).
 */
const ownerQueues = new Map<string, Promise<unknown>>();
async function serialized<T>(own: string, fn: () => Promise<T>): Promise<T> {
  const prev = ownerQueues.get(own) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  ownerQueues.set(own, tail);
  try {
    return await run;
  } finally {
    if (ownerQueues.get(own) === tail) ownerQueues.delete(own);
  }
}

const SANDBOX_CONTAINER = 'sandbox';
/** Env the binding sets: the template's own values for these are replaced. */
const OWN_ENV = new Set(['SANDBOX_ID', 'SANDBOX_TOKEN', 'SANDBOX_TOKEN_FILE', 'SANDBOX_TIER']);

/**
 * The pod template: the operator's PodTemplate (spec §4.2: the shared pool's image, resources,
 * relay address and hardening, without its relay token), with the binding added -- labels, the
 * id, tier and token-file env, and the attach token mounted as a file, not a subPath, so the
 * kubelet refreshes it in place when it is re-minted. The template is not checked here: the
 * admission policy (workload-sandboxes/admission-policy.yaml) refuses any StatefulSet from this
 * ServiceAccount that references another Secret, a host path or namespace, a privileged container,
 * or a service-account token.
 *
 * A mounted workload (spec §5.3) also gets its PVC as a volume, the two seed init containers (the
 * sandbox image, which is MOCA's), the claim at /workspace/context, and the seed annotation, which
 * the provisioner removes once pod `<wl>-0` has seeded (settleSeeds).
 */
export function podTemplate(
  template: KubeObject,
  k: Keys,
  ref: WorkloadRef,
  spec: SandboxSpec,
  config: ProvisionerConfig,
) {
  const meta = template.template?.metadata ?? {};
  const pod = template.template?.spec;
  const base = pod?.containers?.find((c: { name: string }) => c.name === SANDBOX_CONTAINER);
  if (!base) {
    throw new ProvisionError(
      500,
      'workload_template_invalid',
      `PodTemplate ${TEMPLATE} has no '${SANDBOX_CONTAINER}' container`,
    );
  }
  // A mounted workload's spec always carries its claim and revision (parseSandboxSpec).
  const seed = spec.mount && spec.storage && spec.revision ? spec : null;
  const container = {
    ...base,
    env: [
      { name: 'SANDBOX_ID', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
      { name: 'SANDBOX_TIER', value: spec.tier },
      { name: 'SANDBOX_TOKEN_FILE', value: `${TOKEN_DIR}/${TOKEN_KEY}` },
      ...((base.env ?? []) as { name: string }[]).filter((e) => !OWN_ENV.has(e.name)),
    ],
    volumeMounts: [
      ...((base.volumeMounts ?? []) as unknown[]),
      { name: 'attach-token', mountPath: TOKEN_DIR, readOnly: true },
      ...(seed ? [contextMount(seed)] : []),
    ],
  };
  return {
    metadata: {
      labels: labels(k),
      // The template's own (on kind, setup.sh's moca.dev/image-id), then the binding's.
      annotations: {
        ...(meta.annotations ?? {}),
        ...annotations(ref, spec),
        ...(seed ? { [SEED_ANNOTATION]: seed.revision } : {}),
      },
    },
    spec: {
      ...pod,
      automountServiceAccountToken: false,
      ...(seed ? { initContainers: seedContainers(base, seed, config) } : {}),
      ...(seed?.storage?.access === 'rwo' ? { affinity: { podAffinity: sameNode(k) } } : {}),
      containers: [
        container,
        ...pod.containers.filter((c: { name: string }) => c.name !== SANDBOX_CONTAINER),
      ],
      volumes: [
        ...((pod.volumes ?? []) as unknown[]),
        {
          name: 'attach-token',
          secret: { secretName: secretName(k.wl), defaultMode: 0o440 },
        },
        ...(seed ? [{ name: CONTEXT_VOLUME, persistentVolumeClaim: { claimName: k.wl } }] : []),
      ],
    },
  };
}

/** The main container's view of the claim: never the claim root, never `revision/` writable. */
function contextMount(spec: SandboxSpec) {
  return spec.mount === 'writable'
    ? { name: CONTEXT_VOLUME, mountPath: CONTEXT_MOUNT, subPath: 'moca-workspace' }
    : {
        name: CONTEXT_VOLUME,
        mountPath: CONTEXT_MOUNT,
        subPath: `revision/${spec.revision}`,
        readOnly: true,
      };
}

/**
 * The seed (spec §5.3), as two init containers so none mounts the claim root: the first fills
 * `revision/<rev>` from the held bundle, the second (writable mounts only) copies it into
 * `moca-workspace`. Only pod `<wl>-0` writes; the others wait for it. Both do nothing once the seed
 * annotation is gone.
 */
function seedContainers(base: KubeObject, spec: SandboxSpec, config: ProvisionerConfig) {
  const seedEnv = [
    {
      name: 'SEED_REVISION',
      valueFrom: { fieldRef: { fieldPath: `metadata.annotations['${SEED_ANNOTATION}']` } },
    },
    // Its ordinal: only `<wl>-0` writes.
    { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
  ];
  const common = {
    image: base.image,
    ...(base.imagePullPolicy ? { imagePullPolicy: base.imagePullPolicy } : {}),
    ...(base.securityContext ? { securityContext: base.securityContext } : {}),
    ...(base.resources ? { resources: base.resources } : {}),
  };
  const revision = {
    name: 'seed-revision',
    ...common,
    command: ['bash', '-c', SEED_REVISION_SCRIPT],
    env: [
      ...seedEnv,
      { name: 'SANDBOX_TOKEN_FILE', value: `${TOKEN_DIR}/${TOKEN_KEY}` },
      { name: 'SEED_URL', value: config.seedUrl },
      { name: 'MAX_ENTRIES', value: String(config.maxEntries) },
    ],
    volumeMounts: [
      { name: CONTEXT_VOLUME, mountPath: SEED_REVISION_DIR, subPath: 'revision' },
      { name: 'attach-token', mountPath: TOKEN_DIR, readOnly: true },
    ],
  };
  if (spec.mount !== 'writable') return [revision];
  const workspace = {
    name: 'seed-workspace',
    ...common,
    command: ['bash', '-c', SEED_WORKSPACE_SCRIPT],
    env: seedEnv,
    volumeMounts: [
      {
        name: CONTEXT_VOLUME,
        mountPath: SEED_REVISION_DIR,
        subPath: `revision/${spec.revision}`,
        readOnly: true,
      },
      { name: CONTEXT_VOLUME, mountPath: SEED_WORKSPACE_DIR, subPath: 'moca-workspace' },
    ],
  };
  return [revision, workspace];
}

/**
 * ReadWriteOnce attaches to one node, so every pod of the workload goes where the first went
 * (spec §5.4). Set whatever the count, so a later scale-up stays on that node too.
 */
function sameNode(k: Keys) {
  return {
    requiredDuringSchedulingIgnoredDuringExecution: [
      {
        labelSelector: { matchLabels: { [WORKLOAD_LABEL]: k.wl } },
        topologyKey: 'kubernetes.io/hostname',
      },
    ],
  };
}

/** The workload's own PVC (spec §5.1): a plain claim, not a claim template. */
function claim(ref: WorkloadRef, k: Keys, spec: SandboxSpec) {
  const storage = spec.storage!;
  return {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: k.wl, labels: labels(k), annotations: annotations(ref, spec) },
    spec: {
      accessModes: [storage.access === 'rwx' ? 'ReadWriteMany' : 'ReadWriteOnce'],
      resources: { requests: { storage: storage.size } },
      ...(storage.storageClass ? { storageClassName: storage.storageClass } : {}),
    },
  };
}

function statefulSet(
  template: KubeObject,
  ref: WorkloadRef,
  k: Keys,
  spec: SandboxSpec,
  minted: Record<string, string>,
  config: ProvisionerConfig,
) {
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: {
      name: k.wl,
      labels: labels(k),
      annotations: { ...annotations(ref, spec), ...minted },
    },
    spec: {
      serviceName: k.wl,
      replicas: spec.count,
      podManagementPolicy: 'Parallel',
      selector: { matchLabels: { app: APP_LABEL, [WORKLOAD_LABEL]: k.wl } },
      // OnDelete: removing the seed annotation once seeded restarts no pod (spec §5.3).
      ...(spec.mount ? { updateStrategy: { type: 'OnDelete' } } : {}),
      template: podTemplate(template, k, ref, spec, config),
    },
  };
}

function headlessService(ref: WorkloadRef, k: Keys, spec: SandboxSpec) {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    // Nothing connects to a sandbox: no ports, as the shared pool's governing Service.
    metadata: { name: k.wl, labels: labels(k), annotations: annotations(ref, spec) },
    spec: { clusterIP: 'None', selector: { app: APP_LABEL, [WORKLOAD_LABEL]: k.wl } },
  };
}

/** An object that carries this workload's labels; anything else under the name is not ours. */
function ours(obj: KubeObject, k: Keys): boolean {
  const l = obj.metadata.labels ?? {};
  return (
    l[WORKLOAD_LABEL] === k.wl && l[OWNER_LABEL] === k.own && l[MANAGED_BY_LABEL] === MANAGED_BY
  );
}

function conflict(kind: string, name: string): never {
  throw new ProvisionError(
    409,
    'workload_object_conflict',
    `${kind} ${name} is not this workload's`,
  );
}

/**
 * Create or converge a workload's sandboxes. Idempotent by (wl, gen): a repeat converges the same
 * three objects. The owner cap counts the owner's other StatefulSets in the namespace, so a worker
 * that lies about the count elsewhere is still held to it here; one owner's PUTs run one at a time.
 */
export function putWorkload(
  deps: ProvisionerDeps,
  ref: WorkloadRef,
  spec: SandboxSpec,
): Promise<SandboxStatus> {
  const k = keysOf(ref);
  return serialized(k.own, () => converge(deps, ref, k, spec));
}

async function converge(
  deps: ProvisionerDeps,
  ref: WorkloadRef,
  k: Keys,
  spec: SandboxSpec,
): Promise<SandboxStatus> {
  const { kube, config } = deps;
  let sts = await kube.get('statefulsets', k.wl);
  if (sts && !ours(sts, k)) conflict('StatefulSet', k.wl);
  // A PUT that adds no replicas (a repeat, or a scale-down) is never refused by the cap, even when
  // the owner is over it (MOCA_OWNER_MAX_SANDBOXES lowered).
  if (!sts || spec.count > (Number(sts.spec?.replicas) || 0)) {
    const others = await kube.list('statefulsets', `${OWNER_LABEL}=${k.own}`);
    const elsewhere = others
      .filter((s) => s.metadata.name !== k.wl)
      .reduce((n, s) => n + (Number(s.spec?.replicas) || 0), 0);
    if (elsewhere + spec.count > config.maxPerOwner) {
      throw new ProvisionError(429, 'owner_sandbox_quota_exceeded');
    }
  }
  const template = sts ? null : await kube.get('podtemplates', TEMPLATE);
  if (!sts && !template) {
    throw new ProvisionError(500, 'workload_template_missing', `no PodTemplate ${TEMPLATE}`);
  }

  // The Secret first: the pods mount it. Re-written only with a fresh token, which the StatefulSet
  // annotations then record.
  const minted =
    !sts || needsMint(deps, sts, spec)
      ? mint(deps, k, ref.generation, spec.tier, spec.count)
      : null;
  if (minted) {
    const recordKey = workloadRecordKey(ref.owner, ref.name);
    await writeSecret(deps, k, recordKey, ref.generation, minted.token);
  }

  const svc = await kube.get('services', k.wl);
  if (svc && !ours(svc, k)) conflict('Service', k.wl);
  if (!svc && !(await kube.create('services', headlessService(ref, k, spec)))) {
    // Lost a create race: hold whatever is there now to the same ownership as the pre-read.
    const raced = await kube.get('services', k.wl);
    if (raced && !ours(raced, k)) conflict('Service', k.wl);
  }

  // The claim before the pods that mount it. Its size and class are fixed at create.
  if (spec.storage) {
    const pvc = await kube.get('persistentvolumeclaims', k.wl);
    if (pvc && !ours(pvc, k)) conflict('PersistentVolumeClaim', k.wl);
    if (!pvc && !(await kube.create('persistentvolumeclaims', claim(ref, k, spec)))) {
      // Lost a create race: hold whatever is there now to the same ownership as the pre-read.
      const raced = await kube.get('persistentvolumeclaims', k.wl);
      if (raced && !ours(raced, k)) conflict('PersistentVolumeClaim', k.wl);
    }
  }

  if (!sts) {
    await kube.create(
      'statefulsets',
      statefulSet(template!, ref, k, spec, minted!.annotations, config),
    );
    sts = await kube.get('statefulsets', k.wl);
    // The re-read is held to the same ownership as the pre-read: never adopt another's object.
    if (sts && !ours(sts, k)) conflict('StatefulSet', k.wl);
  } else if (minted || Number(sts.spec?.replicas) !== spec.count) {
    await kube.patch('statefulsets', k.wl, {
      metadata: { annotations: { [COUNT_ANNOTATION]: String(spec.count), ...minted?.annotations } },
      spec: { replicas: spec.count },
    });
  }
  return {
    workloadId: ref.name,
    generation: ref.generation,
    count: spec.count,
    ready: Number(sts?.status?.readyReplicas) || 0,
    ...seedStatus(deps, k, sts),
  };
}

export async function getWorkload(deps: ProvisionerDeps, ref: WorkloadRef): Promise<SandboxStatus> {
  const k = keysOf(ref);
  const sts = await deps.kube.get('statefulsets', k.wl);
  if (!sts || !ours(sts, k)) throw new ProvisionError(404, 'workload_not_found');
  return {
    workloadId: ref.name,
    generation: ref.generation,
    count: Number(sts.spec?.replicas) || 0,
    ready: Number(sts.status?.readyReplicas) || 0,
    ...seedStatus(deps, k, sts),
  };
}

function seedStatus(deps: ProvisionerDeps, k: Keys, sts: KubeObject | null) {
  if (!sts?.metadata.annotations?.[MOUNT_ANNOTATION]) return {};
  if (!sts.spec?.template?.metadata?.annotations?.[SEED_ANNOTATION])
    return { seed: 'done' as const };
  const held = deps.bundles.get(k.wl);
  return { seed: held ? ('pending' as const) : ('bundle_missing' as const) };
}

/**
 * Delete a workload's StatefulSet, Service, Secret and PVC, each tolerating "already gone", and
 * report the pods still terminating, and the claim until it is gone (its protection finalizer holds
 * it while a pod mounts it). The caller repeats until nothing remains, and only then deletes the
 * Context (spec §6.1). Queued behind the owner's PUTs and re-mints, so a PUT the worker gave up on
 * (MOCA_PROVISIONER_TIMEOUT_MS) finishes first and its objects are deleted here, instead of being
 * created after `remaining: 0`.
 */
export function deleteWorkload(
  deps: ProvisionerDeps,
  ref: WorkloadRef,
): Promise<{ remaining: number }> {
  const k = keysOf(ref);
  return serialized(k.own, () => removeWorkload(deps, k));
}

async function removeWorkload(deps: ProvisionerDeps, k: Keys): Promise<{ remaining: number }> {
  const { kube } = deps;
  // Retired, not only dropped: a late hand-off for it is refused, never held again.
  deps.bundles.retire(k.wl, nowOf(deps));
  let claimLeft = 0;
  for (const [kind, name] of [
    ['statefulsets', k.wl],
    ['services', k.wl],
    ['persistentvolumeclaims', k.wl],
  ] as const) {
    const obj = await kube.get(kind, name);
    if (!obj || !ours(obj, k)) continue;
    if (kind === 'persistentvolumeclaims') claimLeft = 1;
    if (!obj.metadata.deletionTimestamp) await kube.delete(kind, name);
  }
  // Unread, as every Secret: its name is derived from the verified owner, so it is this workload's.
  await kube.delete('secrets', secretName(k.wl));
  const pods = await kube.list('pods', `${WORKLOAD_LABEL}=${k.wl},${OWNER_LABEL}=${k.own}`);
  return { remaining: pods.length + claimLeft };
}

/**
 * Reserve `bytes` of the seed budget for a bundle hand-off to `ref`'s workload, before its body is
 * read (spec §5.2): the budget bounds what is in memory, not only what is held. Throws 503
 * seed_budget_full when it does not fit the budget or the owner's half of it. The caller gives the
 * reservation back with the returned function once the bundle is held or the hand-off failed.
 */
export function reserveBundle(deps: ProvisionerDeps, ref: WorkloadRef, bytes: number): () => void {
  const k = keysOf(ref);
  if (!deps.bundles.reserve(k.wl, k.own, bytes)) throw new ProvisionError(503, 'seed_budget_full');
  let released = false;
  return () => {
    if (!released) deps.bundles.release(k.own, bytes);
    released = true;
  };
}

/**
 * Hold the frozen bundle a mounted workload's init containers seed from (spec §5.2), until
 * settleSeeds sees the seed done or MOCA_PROVISIONER_SEED_HOLD_S passes. Its bytes were reserved
 * first (reserveBundle). Not held when the workload's sandboxes have already seeded (a repeat
 * activate resends it, and it would never be fetched), nor once DELETE has removed the workload: on
 * the owner's queue, so a hand-off from an activate the worker gave up on, landing after the DELETE,
 * is refused instead of held for nothing.
 */
export function putBundle(
  deps: ProvisionerDeps,
  ref: WorkloadRef,
  bytes: Buffer,
): Promise<{ held: boolean }> {
  const k = keysOf(ref);
  return serialized(k.own, async () => {
    if (deps.bundles.retired(k.wl)) throw new ProvisionError(404, 'workload_not_found');
    const sts = await deps.kube.get('statefulsets', k.wl);
    if (sts && !ours(sts, k)) conflict('StatefulSet', k.wl);
    if (sts && !sts.spec?.template?.metadata?.annotations?.[SEED_ANNOTATION]) {
      return { held: false };
    }
    deps.bundles.put(k.wl, { gen: ref.generation, own: k.own, bytes, at: nowOf(deps) });
    return { held: true };
  });
}

/**
 * Finish seeds (spec §5.3): for each workload StatefulSet still carrying the seed annotation, once
 * pod `<wl>-0` is Initialized (its init containers, the seed's one writer, completed), remove the
 * annotation and drop the held bundle. OnDelete keeps that patch from restarting any pod; a pod
 * created later comes up without it, so its init containers do nothing. Then drop every bundle held
 * past MOCA_PROVISIONER_SEED_HOLD_S, seeded or not. Each StatefulSet is settled on its own: one that
 * fails is logged and skipped. `pending` counts the StatefulSets still carrying the annotation, which
 * main.ts keeps checking every few seconds.
 */
export async function settleSeeds(
  deps: ProvisionerDeps,
): Promise<{ settled: number; pending: number }> {
  const sets = await deps.kube.list(
    'statefulsets',
    `app=${APP_LABEL},${MANAGED_BY_LABEL}=${MANAGED_BY}`,
  );
  let settled = 0;
  let pending = 0;
  for (const s of sets) {
    try {
      const r = await settleOne(deps, s);
      if (r === 'settled') settled++;
      if (r === 'pending') pending++;
    } catch (err) {
      pending++;
      const why = err instanceof Error ? err.message : String(err);
      console.error(`provisioner: seed check of StatefulSet ${s.metadata.name} failed: ${why}`);
    }
  }
  deps.bundles.expire(nowOf(deps));
  return { settled, pending };
}

async function settleOne(
  deps: ProvisionerDeps,
  s: KubeObject,
): Promise<'settled' | 'pending' | 'skip'> {
  const l = s.metadata.labels ?? {};
  const k = { wl: l[WORKLOAD_LABEL], own: l[OWNER_LABEL] };
  if (!k.wl || !k.own || s.metadata.name !== k.wl) return 'skip';
  if (!s.spec?.template?.metadata?.annotations?.[SEED_ANNOTATION]) {
    deps.bundles.drop(k.wl);
    return 'skip';
  }
  const first = await deps.kube.get('pods', `${k.wl}-0`);
  const seeded =
    first !== null &&
    ours(first, k) &&
    ((first.status?.conditions ?? []) as { type: string; status: string }[]).some(
      (c) => c.type === 'Initialized' && c.status === 'True',
    );
  if (!seeded) return 'pending';
  const patched = await serialized(k.own, async () => {
    // Read again under the owner's queue: a DELETE may have removed it since the list.
    const cur = await deps.kube.get('statefulsets', k.wl);
    if (!cur || !ours(cur, k)) return false;
    if (cur.spec?.template?.metadata?.annotations?.[SEED_ANNOTATION]) {
      await deps.kube.patch('statefulsets', k.wl, {
        spec: { template: { metadata: { annotations: { [SEED_ANNOTATION]: null } } } },
      });
    }
    return true;
  });
  deps.bundles.drop(k.wl);
  return patched ? 'settled' : 'skip';
}

/**
 * Re-mint every attach token this provisioner manages that is nearing expiry (spec §3.1). It acts
 * without a user token, from the labels and annotations of the StatefulSets it created; it creates
 * nothing and widens no binding: wl, own, gen, tier and n are the StatefulSet's own. Orphans are the
 * reconciler's (spec §6.2, a later PR), so this keeps an orphan's token fresh until then.
 */
export async function remintExpiring(deps: ProvisionerDeps): Promise<number> {
  const sets = await deps.kube.list(
    'statefulsets',
    `app=${APP_LABEL},${MANAGED_BY_LABEL}=${MANAGED_BY}`,
  );
  let reminted = 0;
  // One item at a time, each on its own: one that is malformed or fails (deleted meanwhile, an
  // admission denial) is logged and skipped, and never starves the ones listed after it.
  for (const s of sets) {
    try {
      if (await remintOne(deps, s)) reminted++;
    } catch (err) {
      // The object's name and the failure only: never a token.
      const why = err instanceof Error ? err.message : String(err);
      console.error(`provisioner: re-mint of StatefulSet ${s.metadata.name} failed: ${why}`);
    }
  }
  return reminted;
}

/** Re-mint one StatefulSet's token if it is due. False when skipped or not due. */
async function remintOne(deps: ProvisionerDeps, s: KubeObject): Promise<boolean> {
  const l = s.metadata.labels ?? {};
  const a = s.metadata.annotations ?? {};
  const k = { wl: l[WORKLOAD_LABEL], own: l[OWNER_LABEL] };
  const count = Number(a[COUNT_ANNOTATION]);
  const gen = a[GENERATION_ANNOTATION];
  const recordKey = a[RECORD_KEY_ANNOTATION];
  const skip = (why: string) => {
    console.error(`provisioner: re-mint skips StatefulSet ${s.metadata.name}: ${why}`);
    return false;
  };
  // Every value that goes into a token or a Secret is checked first, as a PUT would make it.
  if (typeof k.wl !== 'string' || !ATTACH_WORKLOAD_RE.test(k.wl))
    return skip('no valid workload label');
  if (typeof k.own !== 'string' || !ATTACH_OWNER_RE.test(k.own))
    return skip('no valid owner label');
  if (s.metadata.name !== k.wl) return skip('named off its workload label');
  if (typeof gen !== 'string' || !GENERATION_RE.test(gen)) return skip('no valid generation');
  const keyOk = typeof recordKey === 'string' && RECORD_KEY_RE.test(recordKey);
  if (!keyOk || !recordKey.startsWith(`sh:wl:${k.own}:`)) return skip('no valid record key');
  if (!Number.isSafeInteger(count) || count < 1) return skip('no valid sandbox count');
  if (a[TIER_ANNOTATION] !== 'container') return skip('not the container tier');
  const spec: SandboxSpec = { count, tier: 'container' };
  return serialized(k.own, async () => {
    // Read again under the owner's queue: a PUT may have just re-minted it, or a DELETE removed it.
    const cur = await deps.kube.get('statefulsets', k.wl);
    if (!cur || !ours(cur, k) || !needsMint(deps, cur, spec)) return false;
    const minted = mint(deps, k, gen, spec.tier, count);
    await writeSecret(deps, k, recordKey, gen, minted.token);
    await deps.kube.patch('statefulsets', k.wl, {
      metadata: { annotations: minted.annotations },
    });
    return true;
  });
}
