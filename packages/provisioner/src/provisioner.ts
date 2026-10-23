import {
  ATTACH_OWNER_RE,
  ATTACH_WORKLOAD_RE,
  mintAttachToken,
  ownerScopeFor,
  workloadKeyFor,
  workloadRecordKey,
} from '@moca/control-plane';
import type { KubeApi, KubeObject } from './kube.js';

/**
 * What moca-provisioner does for one workload (workload sandboxes spec §4, ADR-0043): a Secret
 * `<wl>-attach` holding the workload's attach token, a headless Service `<wl>`, and a StatefulSet
 * `<wl>` whose pods attach to the relay with that token. `wl` is derived here from the verified
 * owner, so a caller can only ever reach its own owner's objects.
 *
 * No PVC in this phase (spec §8 PR 2): context still arrives by copy, now onto these sandboxes.
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
}

export interface ProvisionerDeps {
  kube: KubeApi;
  /** Signs attach tokens with the provisioner's Ed25519 key (makeSigner). */
  signer: { kid: string; signJws(typ: string, claims: object): string };
  config: ProvisionerConfig;
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
}

export interface SandboxStatus {
  workloadId: string;
  generation: string;
  count: number;
  /** Pods the StatefulSet reports Ready. The relay's records are what the worker counts. */
  ready: number;
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

/** The PUT body: `count`, `tier`, and the frozen revision. No field names a workload key. */
export function parseSandboxSpec(body: unknown, config: ProvisionerConfig): SandboxSpec {
  if (!isObject(body)) throw new ProvisionError(400, 'sandboxes_invalid');
  if (Object.keys(body).some((k) => !['count', 'tier', 'revision'].includes(k))) {
    throw new ProvisionError(400, 'sandboxes_field_not_allowed');
  }
  const { count, tier = 'container', revision } = body;
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
  return { count: count as number, tier, ...(revision ? { revision } : {}) };
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
 */
export function podTemplate(template: KubeObject, k: Keys, ref: WorkloadRef, spec: SandboxSpec) {
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
    ],
  };
  return {
    metadata: {
      labels: labels(k),
      // The template's own (on kind, setup.sh's moca.dev/image-id), then the binding's.
      annotations: { ...(meta.annotations ?? {}), ...annotations(ref, spec) },
    },
    spec: {
      ...pod,
      automountServiceAccountToken: false,
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
      ],
    },
  };
}

function statefulSet(
  template: KubeObject,
  ref: WorkloadRef,
  k: Keys,
  spec: SandboxSpec,
  minted: Record<string, string>,
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
      template: podTemplate(template, k, ref, spec),
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

  if (!sts) {
    await kube.create('statefulsets', statefulSet(template!, ref, k, spec, minted!.annotations));
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
  };
}

/**
 * Delete a workload's StatefulSet, Service and Secret, each tolerating "already gone", and report
 * the pods still terminating. The caller repeats until none remain, and only then deletes the
 * Context: Context Service refuses to delete a mounted claim (spec §6.1). Queued behind the owner's
 * PUTs and re-mints, so a PUT the worker gave up on (MOCA_PROVISIONER_TIMEOUT_MS) finishes first and
 * its objects are deleted here, instead of being created after `remaining: 0`.
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
  for (const [kind, name] of [
    ['statefulsets', k.wl],
    ['services', k.wl],
  ] as const) {
    const obj = await kube.get(kind, name);
    if (obj && ours(obj, k)) await kube.delete(kind, name);
  }
  // Unread, as every Secret: its name is derived from the verified owner, so it is this workload's.
  await kube.delete('secrets', secretName(k.wl));
  const pods = await kube.list('pods', `${WORKLOAD_LABEL}=${k.wl},${OWNER_LABEL}=${k.own}`);
  return { remaining: pods.length };
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
