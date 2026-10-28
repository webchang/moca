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
  /**
   * The workload records in Redis, read-only, for the orphan sweep (spec §6.2). Unset, there is no
   * sweep: nothing can tell an orphan from a live workload.
   */
  records?: RecordStore;
  /** Epoch seconds. */
  now?: () => number;
}

/** The one Redis read the orphan sweep makes: a workload record by its key, null when absent. */
export interface RecordStore {
  get(key: string): Promise<string | null>;
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

/**
 * The StatefulSet first (its pods go, and the owner cap, counted from StatefulSets, is freed), then
 * the Secret, then the Service, the claim last. The Secret goes while the Service (and claim) still
 * exist: it is the one kind the provisioner cannot list, so a failed Secret delete leaves an object
 * the orphan sweep can see, and the next DELETE or sweep retries it. Nothing here waits, so a claim
 * its protection finalizer holds is only reported (`remaining`), and the next call retries.
 * `onDelete` hears each object a delete was issued for (the orphan sweep logs them). `keepClaim`
 * leaves the PVC alone: the orphan sweep's delete on a missing record (spec §6.2).
 */
async function removeWorkload(
  deps: ProvisionerDeps,
  k: Keys,
  onDelete?: (kind: string, name: string) => void,
  keepClaim = false,
): Promise<{ remaining: number }> {
  const { kube } = deps;
  // Retired, not only dropped: a late hand-off for it is refused, never held again.
  deps.bundles.retire(k.wl, nowOf(deps));
  const drop = async (kind: 'statefulsets' | 'services' | 'persistentvolumeclaims') => {
    const obj = await kube.get(kind, k.wl);
    if (!obj || !ours(obj, k)) return false;
    if (!obj.metadata.deletionTimestamp && (await kube.delete(kind, k.wl))) onDelete?.(kind, k.wl);
    return true;
  };
  await drop('statefulsets');
  // Unread, as every Secret: its name is derived from the verified owner, so it is this workload's.
  if (await kube.delete('secrets', secretName(k.wl))) onDelete?.('secrets', secretName(k.wl));
  await drop('services');
  const claimLeft = !keepClaim && (await drop('persistentvolumeclaims')) ? 1 : 0;
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
  if (!deps.bundles.reserve(k.own, bytes)) throw new ProvisionError(503, 'seed_budget_full');
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
 * sweep's (sweepOrphans, spec §6.2), so this keeps an orphan's token fresh until its grace is over.
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

/** MOCA_PROVISIONER_ORPHAN_GRACE_S's default: an object younger than this is never swept. */
export const DEFAULT_ORPHAN_GRACE_S = 600;

/**
 * MOCA_PROVISIONER_REDIS_TIMEOUT_MS's default: the bound on each record read. node-redis has no
 * command timeout, so a GET on a half-open or blackholed socket would otherwise never answer, and
 * the second read, on the owner's queue, would hold that owner's PUT, DELETE and re-mint with it.
 */
export const DEFAULT_REDIS_TIMEOUT_MS = 2000;

/**
 * The emptied-Redis guard (spec §6.2): a pass deletes nothing when more than this fraction of the
 * workloads it read a record for have none (at least MISSING_ABORT_MIN of them). A record is written
 * before any object, so many missing at once is not orphans but a Redis that lost its data (AOF or
 * PVC lost, FLUSHALL, a restore) or a REDIS_URL pointing at another instance or db index.
 */
export const MISSING_ABORT_FRACTION = 0.5;
/** The fewest workloads the guard aborts for: a lone orphan with no record is still swept. */
export const MISSING_ABORT_MIN = 2;
const MISSING = 'record missing';

/** The kinds the sweep lists. Not Secrets: the Role has no read on them (spec §4.1). */
const SWEPT_KINDS = ['statefulsets', 'services', 'persistentvolumeclaims'] as const;
const KIND_NAME: Record<string, string> = {
  statefulsets: 'StatefulSet',
  services: 'Service',
  persistentvolumeclaims: 'PersistentVolumeClaim',
  secrets: 'Secret',
};

/** One workload key's objects, as listed. */
interface SweepGroup {
  wl: string;
  objects: { kind: (typeof SWEPT_KINDS)[number]; obj: KubeObject }[];
}

export interface SweepResult {
  /** Workloads whose objects were deleted (or are still going: a held claim). */
  swept: number;
  /** Workloads left alone because something about them is not as the provisioner writes it. */
  skipped: number;
  /** Workloads whose check or delete failed (a Redis read timed out, too); the next pass retries. */
  failed: number;
  /**
   * PVCs left on a missing record, this pass's and earlier ones'. Nothing collects them, and they
   * count against moca-sandbox's ResourceQuota until an operator deletes them (spec §6.2).
   */
  kept: number;
  /** Set when the emptied-Redis guard stopped the pass before any delete. */
  aborted?: true;
}

/** A workload the first look found deletable: re-checked on its owner's queue before any delete. */
interface DueGroup {
  g: SweepGroup;
  k: Keys;
  recordKey: string;
  gen: string;
}

/**
 * The orphan sweep (spec §6.2): delete a workload's StatefulSet, Service, Secret and PVC when its
 * Redis record is `deleted`, `deleting`, or of another generation, and every one of its objects is
 * older than `graceS`. A `deleting` record is one whose owner asked for the delete and whose worker
 * gave up waiting (its DELETE answered 202 and was not repeated); the sweep finishes the
 * provisioner's half, and the owner's next DELETE the rest (Context, record). A live record
 * (`creating`, `awaiting_upload`, `provisioning`, `ready`) of the same generation is never touched.
 *
 * A missing record frees the sandboxes (StatefulSet, Secret, Service) but never deletes the PVC:
 * an emptied or wrong Redis cannot be told from a lost record, and a writable workspace may exist
 * nowhere else. The claim is logged as kept and left for an operator. And when the first look finds
 * most of the records it read missing (MISSING_ABORT_FRACTION, MISSING_ABORT_MIN), the pass deletes
 * nothing at all.
 *
 * Delete-only: it creates and mints nothing, so a forged record (workers can write Redis, spec §9)
 * can at worst delete a workload's objects. It is conservative about everything else: an object
 * whose labels, name, record-key or generation annotation are not as the provisioner writes them, a
 * group whose objects disagree, a record that does not parse or that this workload key does not
 * derive from, or an object with no readable creation time, is logged and skipped, never deleted.
 *
 * Every record read is bounded by `timeoutMs`: one that times out fails that workload (logged, its
 * objects kept), and on the owner's queue the timeout releases the queue, so a hung Redis never
 * holds an owner's PUT, DELETE or re-mint past it, and the pass always ends.
 *
 * Each workload is handled on its own (one that fails never stops the others), on its owner's
 * queue, so a delete here cannot interleave with that owner's PUT, DELETE or re-mint, and is
 * re-checked there against fresh reads. Secrets are not listed (no read): a workload's Secret is
 * deleted blind with its other objects, by its derived name.
 */
export async function sweepOrphans(
  deps: ProvisionerDeps & { records: RecordStore },
  graceS: number,
  timeoutMs = DEFAULT_REDIS_TIMEOUT_MS,
): Promise<SweepResult> {
  const selector = `app=${APP_LABEL},${MANAGED_BY_LABEL}=${MANAGED_BY}`;
  const groups = new Map<string, SweepGroup>();
  const result: SweepResult = { swept: 0, skipped: 0, failed: 0, kept: 0 };
  for (const kind of SWEPT_KINDS) {
    // A failed list fails the pass: deciding on a partial view could miss a group's live member.
    for (const obj of await deps.kube.list(kind, selector)) {
      const key = obj.metadata.labels?.[WORKLOAD_LABEL];
      const id = typeof key === 'string' ? key : `?${obj.metadata.name}`;
      const g = groups.get(id) ?? { wl: id, objects: [] };
      g.objects.push({ kind, obj });
      groups.set(id, g);
    }
  }
  const failed = (wl: string, err: unknown) => {
    result.failed++;
    const why = err instanceof Error ? err.message : String(err);
    console.error(`provisioner: orphan check of workload ${wl} failed: ${why}`);
  };
  // The first look at every workload, before any delete: the emptied-Redis guard needs them all.
  const due: DueGroup[] = [];
  let read = 0;
  let missing = 0;
  for (const g of groups.values()) {
    try {
      const r = await firstLook(deps, g, graceS, timeoutMs);
      if (r.counted) read++;
      if (r.counted && r.missing) missing++;
      if (r.outcome === 'skipped' && r.keptClaim) result.kept++;
      else if (r.outcome === 'skipped') result.skipped++;
      if (r.outcome === 'due') due.push(r.due);
    } catch (err) {
      failed(g.wl, err);
    }
  }
  if (missing >= MISSING_ABORT_MIN && missing > MISSING_ABORT_FRACTION * read) {
    console.error(
      `provisioner: ORPHAN SWEEP ABORTED, nothing deleted: ${missing} of the ${read} workload ` +
        'records read are missing from Redis. Redis may have lost its data, or REDIS_URL may point ' +
        'at another instance; check it before anything else (spec §6.2).',
    );
    return { ...result, aborted: true };
  }
  for (const d of due) {
    try {
      const r = await sweepDue(deps, d, graceS, timeoutMs);
      if (r.outcome === 'swept') result.swept++;
      if (r.outcome === 'skipped') result.skipped++;
      if (r.keptClaim) result.kept++;
    } catch (err) {
      failed(d.g.wl, err);
    }
  }
  return result;
}

/** One record read, bounded: node-redis has no command timeout (DEFAULT_REDIS_TIMEOUT_MS). */
async function readRecord(
  deps: { records: RecordStore },
  key: string,
  timeoutMs: number,
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Redis read timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([deps.records.get(key), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type Verdict = { keep: true; why?: string } | { keep: false; why: string };

/** Whether one workload's record leaves its objects alone, and why not. */
async function judge(
  deps: { records: RecordStore },
  k: Keys,
  recordKey: string,
  gen: string,
  timeoutMs: number,
): Promise<Verdict> {
  const raw = await readRecord(deps, recordKey, timeoutMs);
  if (raw === null) return { keep: false, why: MISSING };
  let rec: unknown;
  try {
    rec = JSON.parse(raw);
  } catch {
    return { keep: true, why: 'record does not parse' };
  }
  if (!isObject(rec) || typeof rec.generation !== 'string' || typeof rec.status !== 'string') {
    return { keep: true, why: 'record has no generation or status' };
  }
  if (rec.generation !== gen) return { keep: false, why: 'record of another generation' };
  // The same generation: the objects must derive from this record's owner and name, as a PUT made
  // them. Anything else is not the provisioner's doing, and is left for an operator.
  if (
    typeof rec.owner !== 'string' ||
    typeof rec.name !== 'string' ||
    workloadKeyFor(rec.owner, rec.name, gen) !== k.wl ||
    workloadRecordKey(rec.owner, rec.name) !== recordKey
  ) {
    return { keep: true, why: 'workload key does not derive from its record' };
  }
  if (rec.status === 'deleted') return { keep: false, why: 'record deleted' };
  if (rec.status === 'deleting') return { keep: false, why: 'record deleting' };
  return { keep: true };
}

/** The group's keys, record key and generation, or why it is not one the sweep may act on. */
function groupKeys(g: SweepGroup): { k: Keys; recordKey: string; gen: string } | { bad: string } {
  let found: { k: Keys; recordKey: string; gen: string } | null = null;
  for (const { kind, obj } of g.objects) {
    const l = obj.metadata.labels ?? {};
    const a = obj.metadata.annotations ?? {};
    const what = `${KIND_NAME[kind]} ${obj.metadata.name}`;
    const k = { wl: l[WORKLOAD_LABEL], own: l[OWNER_LABEL] };
    if (typeof k.wl !== 'string' || !ATTACH_WORKLOAD_RE.test(k.wl))
      return { bad: `${what}: no valid workload label` };
    if (typeof k.own !== 'string' || !ATTACH_OWNER_RE.test(k.own))
      return { bad: `${what}: no valid owner label` };
    if (obj.metadata.name !== k.wl) return { bad: `${what}: named off its workload label` };
    const recordKey = a[RECORD_KEY_ANNOTATION];
    const gen = a[GENERATION_ANNOTATION];
    if (
      typeof recordKey !== 'string' ||
      !RECORD_KEY_RE.test(recordKey) ||
      !recordKey.startsWith(`sh:wl:${k.own}:`)
    ) {
      return { bad: `${what}: no valid record key` };
    }
    if (typeof gen !== 'string' || !GENERATION_RE.test(gen))
      return { bad: `${what}: no valid generation` };
    if (found && (found.k.own !== k.own || found.recordKey !== recordKey || found.gen !== gen)) {
      return { bad: `${what}: disagrees with the workload's other objects` };
    }
    found = { k, recordKey, gen };
  }
  return found ?? { bad: 'no objects' };
}

/** Seconds since the object was created, or null when its creationTimestamp does not parse. */
function ageS(obj: KubeObject, now: number): number | null {
  const at = Date.parse(String(obj.metadata.creationTimestamp ?? ''));
  return Number.isFinite(at) ? now - Math.floor(at / 1000) : null;
}

/** The claim of a group, when it is the group's only object: a missing record's leftover. */
function loneClaim(g: SweepGroup): KubeObject | null {
  const [only, ...rest] = g.objects;
  return only && rest.length === 0 && only.kind === 'persistentvolumeclaims' ? only.obj : null;
}

const keptClaim = (name: string) =>
  console.error(`provisioner: orphan sweep kept PVC ${name}: record missing`);

/**
 * The first look at one workload, off the owner's queue: the cheap checks, then one record read.
 * `counted` (and `missing`) feed the emptied-Redis guard; a claim kept alone after an earlier
 * missing-record sweep is not counted, or two such would stop every later pass.
 */
async function firstLook(
  deps: ProvisionerDeps & { records: RecordStore },
  g: SweepGroup,
  graceS: number,
  timeoutMs: number,
): Promise<
  | { outcome: 'kept' | 'skipped'; counted?: boolean; missing?: boolean; keptClaim?: true }
  | { outcome: 'due'; due: DueGroup; counted: boolean; missing: boolean }
> {
  const skip = (why: string) => {
    console.error(`provisioner: orphan sweep skips workload ${g.wl}: ${why}`);
    return { outcome: 'skipped' as const };
  };
  const keys = groupKeys(g);
  if ('bad' in keys) return skip(keys.bad);
  const { k, recordKey, gen } = keys;
  // Already going (a claim its finalizer holds until the pod is gone): nothing left to delete. The
  // Secret went before the Service and claim (removeWorkload), so none is left behind unseen
  // (a delete made before that order could leave one: spec §6.2).
  if (g.objects.every(({ obj }) => obj.metadata.deletionTimestamp)) return { outcome: 'kept' };
  // Cheap checks first: most workloads are live, or too young.
  const now = nowOf(deps);
  for (const { obj } of g.objects) {
    const age = ageS(obj, now);
    if (age === null) return skip(`${obj.metadata.name} has no creation time`);
    if (age < graceS) return { outcome: 'kept' };
  }
  const v = await judge(deps, k, recordKey, gen, timeoutMs);
  const lone = loneClaim(g);
  const counted = !lone;
  const missing = !v.keep && v.why === MISSING;
  if (v.keep) return v.why ? { ...skip(v.why), counted } : { outcome: 'kept', counted };
  // A claim already kept on a missing record: nothing else of it to delete, and it stays.
  if (lone && missing) {
    keptClaim(lone.metadata.name);
    return { outcome: 'skipped', keptClaim: true };
  }
  return { outcome: 'due', due: { g, k, recordKey, gen }, counted, missing };
}

/** The delete, on the owner's queue, after re-reading the objects and the record there. */
async function sweepDue(
  deps: ProvisionerDeps & { records: RecordStore },
  d: DueGroup,
  graceS: number,
  timeoutMs: number,
): Promise<{ outcome: 'swept' | 'skipped' | 'kept'; keptClaim?: true }> {
  const { k, recordKey, gen } = d;
  const skip = (why: string) => {
    console.error(`provisioner: orphan sweep skips workload ${k.wl}: ${why}`);
    return { outcome: 'skipped' as const };
  };
  const kept = { outcome: 'kept' as const };
  // A throw here (a Redis read that timed out) ends this call, and serialized releases the queue.
  return serialized(k.own, async () => {
    // Again under the owner's queue, against fresh reads: a PUT or DELETE may have run since.
    const fresh: SweepGroup = { wl: k.wl, objects: [] };
    for (const kind of SWEPT_KINDS) {
      const obj = await deps.kube.get(kind, k.wl);
      if (obj && ours(obj, k)) fresh.objects.push({ kind, obj });
    }
    if (fresh.objects.length === 0) return kept;
    const again = groupKeys(fresh);
    if ('bad' in again) return skip(again.bad);
    if (again.recordKey !== recordKey || again.gen !== gen) return kept;
    for (const { obj } of fresh.objects) {
      const age = ageS(obj, nowOf(deps));
      if (age === null || age < graceS) return kept;
    }
    const verdict = await judge(deps, k, recordKey, gen, timeoutMs);
    if (verdict.keep) return verdict.why ? skip(verdict.why) : kept;
    // A missing record never deletes the claim: only an explicit deleted/deleting or another
    // generation does (spec §6.2).
    const keepClaim = verdict.why === MISSING;
    let deleted = 0;
    await removeWorkload(
      deps,
      k,
      (kind, name) => {
        deleted++;
        // Kind, name and reason only: never a token, a record or its owner.
        console.log(
          `provisioner: orphan sweep deleted ${KIND_NAME[kind]} ${name} (${verdict.why})`,
        );
      },
      keepClaim,
    );
    const claim = fresh.objects.find(({ kind }) => kind === 'persistentvolumeclaims');
    const claimKept = keepClaim && claim !== undefined;
    if (claimKept) keptClaim(claim.obj.metadata.name);
    return {
      outcome: deleted > 0 ? ('swept' as const) : ('kept' as const),
      ...(claimKept ? { keptClaim: true as const } : {}),
    };
  });
}
