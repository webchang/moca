import { CpError } from './errors.js';
import {
  asRecord,
  auditBestEffort,
  isAdmin,
  membershipNow,
  requireEnrolledPrincipal,
  requireReader,
  seconds,
} from './handler-util.js';
import type { CpDeps, Handler, RequestCtx } from './handlers.js';
import { isEnrolledForSandbox, type SandboxConfig } from './sandbox-config.js';
import {
  buildRecordOf,
  canonicalJson,
  LONE_SURROGATE_RE,
  sha256Hex,
  type AppendInput,
  type ProvenanceStore,
} from './provenance.js';
import {
  hostManaged,
  lastLeaseEnd,
  rejectedByAdmin,
  liveLeases,
  place,
  readinessOf,
  readinessReasonOf,
  startQueue,
  startRetryAfterS,
  type HostView,
  type Placement,
  type StartQueue,
} from './activation.js';
import { activationLock, templateUseLock } from './activation-lock.js';
import { busyWorkers, freshHosts, hostViewsOf, liveSnapshots } from './host-handlers.js';
import {
  checkCreate,
  normalizeSpec,
  policyDigest,
  policyProblems,
  quotaFor,
  TEMPLATE_ID_RE,
  type Policy,
  type PolicyStore,
} from './template-policy.js';
import {
  TEMPLATE_DOC_SCHEMA,
  MemoryTemplateCatalog,
  resolveBuild,
  type TemplateBuild,
  type TemplateCatalog,
  type TemplateDoc,
} from './template-catalog.js';
import {
  isLive,
  viewOf,
  type SandboxRecord,
  type SandboxStore,
  type SandboxView,
} from './sandbox-store.js';
import { mintSandboxToken } from './sandbox-token.js';
import {
  allLines,
  EGRESS_GRACE_S,
  ENTRY_ID_RE,
  summarize,
  type EgressStore,
} from './egress-log.js';
import { MEMBER_SUBJECT_FORMS, MEMBER_SUBJECT_RE } from './identity.js';
import { SubjectQueue } from './subject-document.js';
import type { TokenClaims } from './token.js';

/**
 * The sandbox resource's handlers (SBX0 spec §5.1), mounted on the `sandbox` route profile only.
 * Only TYPES come from handlers.ts, which spreads this table into HANDLERS: a runtime import back
 * would be a module cycle.
 */

/** `sbx-` plus 26 random lowercase hex characters (spec §5.1); also the workspace key. */
export const SANDBOX_ID_RE = /^sbx-[0-9a-f]{26}$/;
const ID_HEX = 26;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** A label key; openapi.yaml's `propertyNames` states the same pattern (openapi-contract.test.ts). */
export const LABEL_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const MAX_LABELS = 16;
const MAX_LABEL_BYTES = 256;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function service(deps: CpDeps): { cfg: SandboxConfig; store: SandboxStore } {
  // The sandbox profile always has both (configFromEnv, depsFromEnv); a harness one never mounts
  // these routes. Either missing is a wiring bug.
  if (!deps.config.sandbox || !deps.sandboxes) {
    throw new CpError('internal_error', 'the sandbox service is not configured');
  }
  return { cfg: deps.config.sandbox, store: deps.sandboxes };
}

/**
 * The id, from `deps.newId()`: its first 26 RANDOM hex characters. In production newId is
 * randomUUID, whose version nibble is fixed and whose variant nibble is half fixed, so both are
 * dropped (30 random hex remain). Fewer than 26 would make ids collide, so that is refused.
 */
function sandboxId(raw: string): string {
  let hex = raw.toLowerCase();
  if (UUID_RE.test(hex)) {
    const h = hex.replace(/-/g, '');
    hex = h.slice(0, 12) + h.slice(13, 16) + h.slice(17);
  }
  hex = hex.replace(/[^0-9a-f]/g, '');
  if (hex.length < ID_HEX) throw new CpError('internal_error', 'id source is too short');
  return `sbx-${hex.slice(0, ID_HEX)}`;
}

const requireEnrolled = (ctx: RequestCtx, deps: CpDeps): TokenClaims =>
  requireEnrolledPrincipal(ctx, deps.config);

/**
 * The sandbox ownership choke point, as assertOwner is for sessions. Every `sandboxScoped` route
 * goes through it (route-authz-enumeration.test.ts). A non-owner gets 404, never 403, so an id
 * names nothing to anyone else (spec §5.1). `admin` may read and delete any sandbox; minting is
 * owner-only for admins too (spec §4.2), so an admin cannot exec into another user's code.
 */
async function assertSandboxOwner(
  ctx: RequestCtx,
  deps: CpDeps,
  opts: { admin: boolean },
): Promise<SandboxRecord> {
  const p = requireEnrolled(ctx, deps);
  const id = ctx.params.id ?? '';
  const rec = await service(deps).store.get(id, seconds(deps));
  if (!rec || (rec.owner !== p.sub && !(opts.admin && isAdmin(p)))) {
    throw new CpError('sandbox_not_found', 'no such sandbox');
  }
  return rec;
}

/** The wire `Sandbox` (spec §5.1): nulls, never absent fields, and no worker or tenant. */
function sandboxBody(v: SandboxView) {
  return {
    id: v.id,
    owner: v.owner,
    name: v.name || null,
    template: v.template,
    // The exact build it runs on (template lifecycle spec §9): its manifest hash when the build has
    // one; null on a record from before tracing.
    buildId: v.buildId ?? null,
    templateManifestHash: v.buildId?.startsWith('sha256:') ? v.buildId : null,
    state: v.state,
    reason: v.reason ?? null,
    createdAt: v.createdAt,
    expiresAt: v.expiresAt,
    terminatedAt: v.terminatedAt ?? null,
    labels: v.labels,
  };
}

function parseLabels(raw: unknown): Record<string, string> {
  if (raw === undefined) return {};
  const o = asRecord(raw);
  if (raw !== o || Object.keys(o).length > MAX_LABELS) {
    throw new CpError(
      'invalid_request',
      `labels must be an object of at most ${MAX_LABELS} entries`,
    );
  }
  for (const [k, v] of Object.entries(o)) {
    if (!LABEL_KEY_RE.test(k)) {
      throw new CpError('invalid_request', `label keys must match ${LABEL_KEY_RE}`);
    }
    if (typeof v !== 'string' || Buffer.byteLength(v) > MAX_LABEL_BYTES) {
      throw new CpError(
        'invalid_request',
        `label values must be strings of at most ${MAX_LABEL_BYTES} bytes`,
      );
    }
  }
  return { ...(o as Record<string, string>) };
}

/** Sandbox writes are audited best effort: the write already happened (handler-util.ts). */
const audit = (deps: CpDeps, subject: string, sandboxId: string, decision: string) =>
  auditBestEffort(deps, decision, sandboxId, { subject, sandboxId, decision });

/**
 * The catalog (template lifecycle spec §3.1); built from the env list when none is wired: the
 * sandbox profile's SH_SANDBOX_TEMPLATES, or the harness profile's session templates (the same
 * variable; none declared is an empty catalog there).
 */
function catalog(deps: CpDeps): TemplateCatalog {
  return (
    deps.templates ??
    new MemoryTemplateCatalog(deps.config.sandbox?.templates ?? deps.config.sessionTemplates ?? [])
  );
}

/**
 * The trust a build's gate record has NOW (G41 (c)): `deployment` when its sha256 is in the
 * current policy's trustedGateRecords, or the build names no gate record; `self` when it was
 * created on a selfAttest profile with a record the policy does not (or no longer) trust, whether
 * or not the record was trusted at create (`selfAttestProfile`; `selfAttested` implies it).
 * Recomputed on every read, never stored, so an admin's promotion or removal needs no rewrite.
 */
export function attestationOf(
  b: TemplateBuild,
  trusted: ReadonlySet<string>,
): 'deployment' | 'self' {
  const g = b.request?.gateRecordSha256;
  const onSelfProfile = b.selfAttestProfile === true || b.selfAttested === true;
  return onSelfProfile && g !== undefined && !trusted.has(g) ? 'self' : 'deployment';
}

/**
 * A template's visibility in effect (G41 (c), the user's Q4 (i)): `private` whenever any of its
 * registered builds is self-attested now, whatever is stored, so a record whose trust an admin
 * removed narrows its templates on the next read. Otherwise the stored visibility.
 */
export function effectiveVisibility(
  d: TemplateDoc,
  trusted: ReadonlySet<string>,
): 'private' | 'deployment' {
  return d.visibility === 'deployment' &&
    d.builds.some((b) => b.status === 'registered' && attestationOf(b, trusted) === 'self')
    ? 'private'
    : d.visibility;
}

/** The current policy's trusted gate records, or none on a deployment without a policy store. */
async function trustedSet(deps: CpDeps): Promise<ReadonlySet<string>> {
  return new Set(deps.policy ? (await deps.policy.current()).policy.trustedGateRecords : []);
}

const canSee = (d: TemplateDoc, p: TokenClaims, trusted: ReadonlySet<string>): boolean =>
  effectiveVisibility(d, trusted) === 'deployment' || d.owner === p.sub || isAdmin(p);

async function visibleTemplates(deps: CpDeps, p: TokenClaims): Promise<TemplateDoc[]> {
  const trusted = await trustedSet(deps);
  return (await catalog(deps).list()).filter((d) => canSee(d, p, trusted));
}

/** 404 for a template the caller cannot see, as for one that does not exist (no existence oracle). */
async function visibleTemplate(deps: CpDeps, p: TokenClaims, id: string): Promise<TemplateDoc> {
  const d = await catalog(deps).get(id);
  if (!d || !canSee(d, p, await trustedSet(deps)))
    throw new CpError('template_not_found', 'no such template');
  return d;
}

/**
 * What readiness is derived from (§3.3): attached workers, and, where this control plane holds
 * sandbox records (the sandbox profile), the live sandboxes per worker and the latest creation
 * on each. The harness profile's sessions name a template, not a worker, so there `inUse` and
 * `lastUsed` are null (not zero): unknown, until use records exist (spec §7.1 `use`).
 */
interface ReadinessFacts {
  /** worker sandbox id -> its advertised capacity; present = attached to the relay. */
  attached: Map<string, number> | null;
  inUse: Map<string, number> | null;
  /** worker -> epoch seconds of the newest sandbox created on it, retained records included. */
  lastUsed: Map<string, number> | null;
  /** Where wanted builds are placed (§6.2), when any host agent has reported; else null. */
  placement: Placement | null;
  /**
   * The hosts' start lines (register G43): placed, wanted builds not attached, per host that reports
   * its startConcurrency; null without placement or presence.
   */
  queue: StartQueue | null;
  /** The fresh hosts as last reported (placement's), for start lines (null without host agents). */
  hosts: HostView[] | null;
  /**
   * Every host as last reported, stale ones too, for each build's `heldBy`: it is the snapshot
   * inventory, not placement, and a silent host still holds what it last reported (it is told to
   * remove a retired build once it reports again). Null without host agents.
   */
  holders: HostView[] | null;
  /** Whether a build's snapshot or worker a build whose use has not ended shares (liveSnapshots). */
  shared: (b: TemplateBuild) => boolean;
  /** The current policy's trusted gate records (G41 (c): attestation and visibility in effect). */
  trusted: ReadonlySet<string>;
  nowS: number;
}

/** The hosts as their agents last reported (§6.1), for placement and the hosts block. */
const hostViews = (deps: CpDeps): HostView[] => hostViewsOf(deps);

async function readinessFacts(deps: CpDeps, docs?: TemplateDoc[]): Promise<ReadinessFacts> {
  const nowS = seconds(deps);
  const trusted = await trustedSet(deps);
  const hosts = hostViews(deps);
  // Every template, not only those the caller sees: sharing is judged across the catalog, as the
  // wanted state judges it.
  docs ??= await catalog(deps).list();
  const shared = liveSnapshots(docs);
  // The workers with a live sandbox: they drain and keep their slot, and are never graced.
  const placement =
    hosts.length > 0 ? place(docs, hosts, nowS, await busyWorkers(deps, nowS)) : null;
  // Fresh hosts only for placement (HOST_STALE_S); every reported host for `heldBy`.
  const holders = viewsOrNull(
    deps,
    (deps.hosts?.all() ?? []).map(([id, h]) => ({
      id,
      holds: h.holds,
      activeLimit: h.limits.activeLimit,
      running: h.running,
    })),
  );
  let attached: Map<string, number> | null = null;
  if (deps.presence) {
    try {
      attached = new Map((await deps.presence.list()).map((r) => [r.sandboxId, r.capacityMax]));
    } catch {
      // Presence unreadable: readiness is unknown, not inactive (a client must not act on a guess).
      attached = null;
    }
  }
  const queue = placement && attached ? startQueue(docs, hosts, placement, attached, nowS) : null;
  if ((deps.config.routeProfile ?? 'harness') === 'harness' || !deps.sandboxes) {
    return {
      attached,
      inUse: null,
      lastUsed: null,
      placement,
      queue,
      hosts: viewsOrNull(deps, hosts),
      holders,
      shared,
      trusted,
      nowS,
    };
  }
  const inUse = new Map<string, number>();
  const lastUsed = new Map<string, number>();
  const now = seconds(deps);
  for (const r of await deps.sandboxes.listAll(now)) {
    if (isLive(r, now)) inUse.set(r.worker, (inUse.get(r.worker) ?? 0) + 1);
    lastUsed.set(r.worker, Math.max(lastUsed.get(r.worker) ?? 0, r.createdAt));
  }
  return {
    attached,
    inUse,
    lastUsed,
    placement,
    queue,
    hosts: viewsOrNull(deps, hosts),
    holders,
    shared,
    trusted,
    nowS,
  };
}

/** The host views, or null on a deployment without host agents (no `heldBy` to report). */
const viewsOrNull = (deps: CpDeps, hosts: HostView[]): HostView[] | null =>
  hosts.length > 0 || deps.config.templateHosts?.length ? hosts : null;

function buildBody(d: TemplateDoc, b: TemplateBuild, f: ReadinessFacts, full: boolean) {
  const readiness =
    b.status === 'retired'
      ? 'retired'
      : b.status !== 'registered'
        ? null
        : readinessOf(b, f.nowS, f.placement, f.attached);
  const readinessReason = readinessReasonOf(b, readiness, f.placement);
  // Waiting for a start slot on its host (register G43): present only on an `activating` build.
  const line = readiness === 'activating' ? f.queue?.byBuild.get(b.buildId) : undefined;
  // In its host's idle grace (register G43): no lease, its worker kept running until gracedUntil.
  const grace = b.status === 'registered' ? f.placement?.graced.get(b.buildId) : undefined;
  return {
    buildId: b.buildId,
    status: b.status,
    profile: b.profile,
    readiness,
    // Why an `unavailable` build is not placed (register G39): present only then.
    ...(readinessReason ? { readinessReason } : {}),
    ...(line ? { queued: line.queued, queuePosition: line.position } : {}),
    ...(grace ? { graced: true, gracedUntil: grace.until } : {}),
    capacity:
      readiness === 'active'
        ? {
            running: f.attached?.get(b.worker) ?? 0,
            inUse: f.inUse === null ? null : (f.inUse.get(b.worker) ?? 0),
          }
        : null,
    // A retired or admin-rejected build whose snapshot or worker a build whose use has not ended
    // shares: no host removes it for this one, its worker kept for that build. False otherwise.
    shared: (b.status === 'retired' || rejectedByAdmin(b)) && f.shared(b),
    lastUsedAt: f.lastUsed === null ? null : (f.lastUsed.get(b.worker) ?? null),
    // The hosts whose last inventory holds this build's snapshot (§6.1), a host silent past
    // HOST_STALE_S too: ids only, no paths. A client sees a retired build's removal here as its
    // host drops out. Null without host agents.
    heldBy:
      f.holders === null
        ? null
        : f.holders
            .filter((h) => h.holds[b.buildId] !== undefined)
            .map((h) => h.id)
            .sort(),
    tags: Object.entries(d.tags)
      .filter(([, id]) => id === b.buildId)
      .map(([t]) => t)
      .sort(),
    createdAt: b.createdAt,
    provenance: b.provenance ?? null,
    // The handle a create answered; equal to buildId until the build is registered.
    handle: b.handle ?? b.buildId,
    // On failed or rejected: why, and the step or the rule (§4).
    reason: b.reason ?? null,
    // G41 (c): whether its gate record is trusted deployment-wide now, or only by its submitter.
    attestation: attestationOf(b, f.trusted),
    // Its gate's floor checked offline (gate.floor_checked_offline); null with no gate record, and
    // true for a gate record created before the field (whose gates ran offline).
    gateFloorCheckedOffline:
      b.gateFloor?.checkedOffline ?? (b.request?.gateRecordSha256 ? true : null),
    // Only from a network_needed gate: whether its offline run met the floor anyway.
    ...(b.gateFloor?.metOffline !== undefined
      ? { gateFloorMetOffline: b.gateFloor.metOffline }
      : {}),
    ...(full ? { spec: b.spec } : {}),
  };
}

function templateBody(d: TemplateDoc, f: ReadinessFacts, full: boolean) {
  const def = resolveBuild(d, {});
  const defBody = def ? buildBody(d, def, f, false) : null;
  return {
    id: d.id,
    description: d.description,
    tools: def?.spec.tools ?? [],
    owner: d.owner,
    // In effect (G41 (c), Q4 (i)): private while any registered build is self-attested.
    visibility: effectiveVisibility(d, f.trusted),
    // G41 (c): `self` when any registered build is self-attested now.
    attestation: d.builds.some(
      (b) => b.status === 'registered' && attestationOf(b, f.trusted) === 'self',
    )
      ? 'self'
      : 'deployment',
    onboarding: d.builds.some((b) => b.status === 'registered')
      ? 'registered'
      : (d.builds[0]?.status ?? null),
    readiness: defBody?.readiness ?? null,
    ...(defBody?.readinessReason ? { readinessReason: defBody.readinessReason } : {}),
    tags: { ...d.tags },
    builds: d.builds.map((b) => buildBody(d, b, f, full)),
  };
}

/**
 * Create (template lifecycle spec §4, §8.1): self-serve, any enrolled client. Needs the stored
 * catalog and policy (SH_PROVENANCE_DIR); without them the route says so rather than pretending.
 */
function writable(deps: CpDeps): {
  cat: TemplateCatalog & Required<Pick<TemplateCatalog, 'update'>>;
  policy: PolicyStore;
  prov: ProvenanceStore;
} {
  const cat = deps.templates;
  if (!cat?.update || !deps.policy || !deps.provenance) {
    throw new CpError(
      'invalid_request',
      'this deployment does not store templates (SH_PROVENANCE_DIR is unset)',
    );
  }
  return {
    cat: cat as TemplateCatalog & Required<Pick<TemplateCatalog, 'update'>>,
    policy: deps.policy,
    prov: deps.provenance,
  };
}

/** `b-` and the same 26 random hex characters a sandbox id takes (sandboxId: a UUID's fixed nibbles dropped). */
const buildHandle = (raw: string): string => `b-${sandboxId(raw).slice('sbx-'.length)}`;

/**
 * The quota counters for one subject (§6.2). `templates`: the templates it owns with a build
 * registered or on its way there (a template whose builds all failed, were cancelled or were
 * retired holds no slot, so a failure never locks a subject out). `buildsQueued`: its builds not
 * yet built (queued, building or probing), the host work it has in flight.
 */
async function usage(
  cat: TemplateCatalog,
  subject: string,
): Promise<{ templates: number; buildsQueued: number }> {
  let templates = 0;
  let buildsQueued = 0;
  for (const d of await cat.list()) {
    if (d.owner !== subject) continue;
    if (d.builds.some((b) => REUSABLE.has(b.status))) templates++;
    buildsQueued += d.builds.filter((b) => CANCELLABLE.has(b.status)).length;
  }
  return { templates, buildsQueued };
}

/**
 * One quota check and write at a time per subject (§6.2), per catalog. The catalog serializes
 * per template id only, and the quota counts across every id a subject owns: without this, two
 * creates for different ids would both read the same use and both pass. Taken outside the
 * catalog's id lock, always in that order.
 */
const quotaLocks = new WeakMap<TemplateCatalog, SubjectQueue>();
function quotaLock(cat: TemplateCatalog): SubjectQueue {
  let q = quotaLocks.get(cat);
  if (!q) quotaLocks.set(cat, (q = new SubjectQueue()));
  return q;
}

/**
 * One create at a time per gate record sha256, per catalog, within this process: X1.self.scope's
 * lookup (who already self-attested the record) and the create's write run as one step, so two
 * subjects sending the same untrusted record at once can't both claim it. The catalog serializes
 * its own writes per id the same way, in this process; a deployment runs one control plane.
 */
const gateClaimQueues = new WeakMap<TemplateCatalog, SubjectQueue>();
function gateClaimQueue(cat: TemplateCatalog): SubjectQueue {
  let q = gateClaimQueues.get(cat);
  if (!q) gateClaimQueues.set(cat, (q = new SubjectQueue()));
  return q;
}

/** The build statuses that release a self-attested claim (X1.self.scope): ended without a template. */
const CLAIM_RELEASED = new Set<TemplateBuild['status']>(['failed']);

/** A create's write found another owner than the one it charged: run it again under the new one. */
const OWNER_MOVED = new Error('the template changed owner');

/**
 * The shared body of both create routes. `existing`: true for POST /v1/templates/{id}/builds (the
 * template must exist and be the caller's), false for POST /v1/templates (a new id, or the
 * caller's own existing one).
 */
async function createBuild(ctx: RequestCtx, deps: CpDeps, existing: boolean) {
  const p = requireEnrolled(ctx, deps);
  const { cat, policy, prov } = writable(deps);
  const b = asRecord(ctx.body);
  const id = existing ? (ctx.params.id ?? '') : typeof b.id === 'string' ? b.id.toLowerCase() : '';
  const spec = asRecord(b.spec);
  let gateRecordBytes: Buffer | undefined;
  if (b.gateRecord !== undefined) {
    if (typeof b.gateRecord !== 'string') {
      throw new CpError(
        'invalid_request',
        'gateRecord must be the gate record file as a string, byte for byte (its sha256 is what is trusted)',
      );
    }
    gateRecordBytes = Buffer.from(b.gateRecord, 'utf8');
  }
  if (b.visibility !== undefined && b.visibility !== 'private' && b.visibility !== 'deployment') {
    throw new CpError('invalid_request', "visibility must be 'private' or 'deployment'");
  }
  const gateSha = gateRecordBytes ? `sha256:${sha256Hex(gateRecordBytes)}` : undefined;
  // A create that sends a gate record runs its claim lookup, checks and write under the record's
  // claim queue (gateClaimQueue), so two creates of one untrusted record never both claim it.
  const admit = async () => {
    const { policy: pol, record: policyRecord } = await policy.current();
    // Self-attestation: the subject a self-attested record counts for is the template's owner (the
    // gate record's `scope` and X1.self.scope's key alike). An admin adding a build to another
    // subject's template attests for that owner; an imported template (owner null) has none, so a
    // self-attested record is refused there (X1.trusted).
    const prior = existing && isAdmin(p) ? await cat.get(id) : null;
    const attester = prior && prior.owner !== p.sub ? prior.owner : p.sub;
    // Who already self-attested this record (keyed by subject and sha256), from the catalog: a build
    // self-attested at create (selfAttested) names its record's sha256, and its template the owner it
    // counts for. A claim is made by an admitted self-attested create and held while its build is
    // queued, building, probing, built, registered, rejected or retired (a real use, or an admin's
    // decision). It is released when the build ends `failed`, which never admitted a template, so no
    // one holds a published record with a build that fails. A refused create claims nothing.
    const gateSelfSubmitters =
      gateSha && !pol.trustedGateRecords.includes(gateSha)
        ? [
            ...new Set(
              (await cat.list())
                .filter(
                  (d) =>
                    d.owner !== null &&
                    d.builds.some(
                      (x) =>
                        x.selfAttested === true &&
                        x.request?.gateRecordSha256 === gateSha &&
                        !CLAIM_RELEASED.has(x.status),
                    ),
                )
                .map((d) => d.owner as string),
            ),
          ]
        : [];
    const result = checkCreate(
      {
        id,
        image: typeof b.image === 'string' ? b.image : '',
        spec,
        ...(typeof b.profile === 'string' ? { profile: b.profile } : {}),
        ...(gateRecordBytes ? { gateRecordBytes } : {}),
        ...(attester ? { subject: attester } : {}),
        gateSelfSubmitters,
      },
      pol,
    );
    const stream = `template/${id}`;
    const checkBody = {
      policy: policyRecord,
      profile: result.profile,
      at: 'create',
      outcome: result.passed ? 'admitted' : 'refused',
      results: result.results as unknown as Record<string, unknown>[],
    };
    if (!result.passed) {
      // A refusal is recorded on its template's stream only when the template exists and the caller
      // may write its stream: its own, or (adding a build) any as an admin. A refusal on an id no
      // template holds writes one audit line instead (the capped audit stream), naming the subject,
      // the id and the failed rules: a provenance record would let any enrolled subject open
      // streams without bound, which no quota counts. A refusal on someone else's id is only
      // answered, so no subject grows another's stream; and an id the rule refuses has no stream
      // to record on.
      if (TEMPLATE_ID_RE.test(id)) {
        const cur = await cat.get(id);
        if (cur && (cur.owner === p.sub || (existing && isAdmin(p))))
          await prov.append({ stream, kind: 'check', subject: 'policy', body: checkBody });
        else if (!cur)
          await auditBestEffort(deps, 'template_create_refused', id, {
            subject: p.sub,
            templateId: id,
            decision: 'template_create_refused',
            reason: 'policy_refused',
            rules: result.results
              .filter((r) => !r.passed)
              .map((r) => r.rule)
              .join(','),
          });
      }
      const f = result.failed!;
      throw new CpError('policy_refused', f.message ?? f.rule, undefined, { rule: f.rule });
    }
    // A self-attested create never makes its template deployment-visible.
    const selfAttestedCreate =
      result.gateTrust === 'self' && pol.profiles[result.profile]?.selfAttest === true;
    if (selfAttestedCreate && b.visibility === 'deployment')
      throw new CpError(
        'self_attested',
        'a self-attested template is private until an admin trusts its gate record (trustedGateRecords)',
      );
    const now = seconds(deps);
    const handle = buildHandle(deps.newId());
    const built = normalizeSpec(spec);
    const want = reuseKey(b.image as string, built, result.profile, result.gateRecordSha256);
    let reused: TemplateBuild | undefined;
    // The quota is the template's owner's: an admin adding a build to another's template uses the
    // owner's buildsQueued, not its own. The owner's lock is held around the check and the write
    // (quotaLock); a new id another subject takes meanwhile is refused inside, before any quota is
    // read. The owner is read before the lock, and an admin's transfer (PUT …/owner) can move it in
    // between: the write sees another owner, writes nothing, and the step runs again under the new
    // owner's lock, against the new owner's quota and usage.
    let doc: TemplateDoc | undefined;
    for (let attempt = 1; !doc; attempt++) {
      const charged = (await cat.get(id))?.owner ?? p.sub;
      // The owner's quota: its admin-set override, else the deployment default (quotaFor).
      const quota = quotaFor(pol, charged);
      try {
        doc = await quotaLock(cat).run(charged, () =>
          cat.update(id, async (cur) => {
            if (existing && !cur) throw new CpError('template_not_found', 'no such template');
            if (cur && cur.owner !== p.sub && !(existing && isAdmin(p))) {
              // 404 for a private template, 409 for a visible one: never an existence oracle for private.
              throw cur.visibility === 'private' && !isAdmin(p)
                ? new CpError('template_not_found', 'no such template')
                : new CpError('template_exists', `template '${id}' belongs to another subject`);
            }
            // The owner charged is the one read before the lock; a transfer meanwhile runs it again.
            if ((cur?.owner ?? p.sub) !== charged) throw OWNER_MOVED;
            // §3.2: the same inputs are the same build. One registered, or still on its way there, is
            // answered instead of a second build (a duplicate create would otherwise queue a second
            // one, and both register under one manifest hash).
            // A self-attested build on a template others can see would reach them on its owner's own gate
            // (self-attestation): refused; the owner makes the template private first, or an admin trusts the record.
            if (selfAttestedCreate && cur && cur.visibility === 'deployment')
              throw new CpError(
                'self_attested',
                `template '${id}' is deployment-visible: make it private before adding a self-attested build`,
              );
            // The record was checked as attested for `attester`; the template's owner must still be it.
            if (selfAttestedCreate && (cur ? cur.owner : p.sub) !== attester)
              throw new CpError(
                'self_attested',
                `template '${id}' changed owner during the create; send it again`,
              );
            reused = cur?.builds.find(
              (x) => REUSABLE.has(x.status) && buildReuseKey(x) === want && stillHeld(deps, x),
            );
            if (reused) return cur!;
            const u = await usage(cat, charged);
            // A template takes a slot when it holds none yet: a new id, or one whose builds all failed,
            // were cancelled or were retired (usage does not count it). Checking only new ids would let
            // a subject bring such templates back past the quota.
            const holdsSlot = cur?.builds.some((x) => REUSABLE.has(x.status)) ?? false;
            if (!holdsSlot && u.templates >= quota.templates) {
              throw new CpError(
                'quota_exceeded',
                `at most ${quota.templates} templates per subject`,
                undefined,
                { quota: 'templates' },
              );
            }
            if (u.buildsQueued >= quota.buildsQueued) {
              throw new CpError(
                'quota_exceeded',
                `at most ${quota.buildsQueued} builds queued per subject`,
                undefined,
                { quota: 'buildsQueued' },
              );
            }
            if (gateRecordBytes) await prov.putBlob(gateRecordBytes);
            const created = await prov.append({
              stream,
              kind: 'create',
              subject: p.sub,
              body: {
                image: b.image as string,
                // A round trip through JSON: what the client sent, as the wire carries it (no undefined),
                // with the guest size under the key the build reads (normalizeSpec).
                spec: JSON.parse(JSON.stringify(built)) as Record<string, unknown>,
                profile: result.profile,
                handle,
                ...(result.gateRecordSha256 ? { gate_record_sha256: result.gateRecordSha256 } : {}),
              },
            });
            if (result.gateRecordSha256) {
              await prov.append({
                stream,
                kind: 'gate',
                subject: p.sub,
                body: {
                  record_sha256: result.gateRecordSha256,
                  // `trusted`: in trustedGateRecords. `self`: trusted only for the template owner's
                  // templates (`scope`: the submitter, or the owner an admin added the build for), on a
                  // selfAttest profile. `client`: any other (a profile that does not require X1). The policy
                  // record in force names what the trust was at create, after any later change.
                  source:
                    result.gateTrust === 'trusted'
                      ? 'trusted'
                      : pol.profiles[result.profile]?.selfAttest === true
                        ? 'self'
                        : 'client',
                  ...(result.gateTrust !== 'trusted' &&
                  pol.profiles[result.profile]?.selfAttest === true
                    ? { scope: attester }
                    : {}),
                  policy: policyRecord,
                },
              });
            }
            await prov.append({ stream, kind: 'check', subject: 'policy', body: checkBody });
            const build: TemplateBuild = {
              buildId: handle,
              handle,
              status: 'queued',
              profile: result.profile,
              worker: '',
              spec: buildSpec(built),
              createdAt: now,
              queuedAtMs: deps.now(),
              provenance: created.digest,
              request: {
                image: b.image as string,
                spec: JSON.parse(JSON.stringify(built)) as Record<string, unknown>,
                ...(result.gateRecordSha256 ? { gateRecordSha256: result.gateRecordSha256 } : {}),
              },
              ...(selfAttestedCreate ? { selfAttested: true } : {}),
              // On a selfAttest profile, the record's trust is the policy's at each read, not at create.
              ...(result.gateRecordSha256 && pol.profiles[result.profile]?.selfAttest === true
                ? { selfAttestProfile: true }
                : {}),
              ...(result.gateFloor ? { gateFloor: result.gateFloor } : {}),
            };
            const base: TemplateDoc = cur ?? {
              schema: TEMPLATE_DOC_SCHEMA,
              id,
              owner: p.sub,
              visibility: selfAttestedCreate
                ? 'private'
                : ((b.visibility as 'private' | 'deployment' | undefined) ?? 'deployment'),
              description: String(built.description ?? ''),
              tags: {},
              builds: [],
              createdAt: now,
            };
            return { ...base, builds: [build, ...base.builds] };
          }),
        );
      } catch (err) {
        if (err !== OWNER_MOVED) throw err;
        if (attempt >= 3)
          throw new CpError(
            'internal_error',
            "the template's owner kept changing; retry the create",
          );
      }
    }
    if (reused) {
      await auditBestEffort(deps, 'template_build_reused', id, {
        subject: p.sub,
        decision: 'template_build_reused',
      });
      const done = reused.status === 'registered';
      return {
        status: done ? 200 : 202,
        body: {
          templateId: doc.id,
          buildId: done ? reused.buildId : null,
          build: `/v1/templates/${doc.id}/builds/${done ? reused.buildId : (reused.handle ?? reused.buildId)}`,
          status: reused.status,
          reused: true,
        },
      };
    }
    await auditBestEffort(deps, 'template_build_queued', id, {
      subject: p.sub,
      decision: 'template_build_queued',
    });
    return {
      status: 202,
      body: {
        templateId: doc.id,
        buildId: null,
        build: `/v1/templates/${doc.id}/builds/${handle}`,
        status: 'queued',
      },
    };
  };
  return gateSha ? gateClaimQueue(cat).run(gateSha, admit) : admit();
}

/** The statuses a build is reused from: registered, or on its way there (§3.2). */
const REUSABLE = new Set<TemplateBuild['status']>([
  'queued',
  'building',
  'probing',
  'built',
  'registered',
]);

/**
 * What makes two creates the same build (§3.2): the image, the spec as sent, the profile and the
 * gate record's sha256. The builder (MOCA commit, kernel) is the host's, unknown at create, so it
 * is not part of it: one deployment's hosts build with one builder.
 */
function reuseKey(
  image: string,
  spec: Record<string, unknown>,
  profile: string,
  gateRecordSha256: string | undefined,
): string {
  return canonicalJson({
    image,
    spec: JSON.parse(JSON.stringify(spec)),
    profile,
    gate: gateRecordSha256 ?? null,
  });
}

/**
 * Whether a registered build's snapshot still exists somewhere (register G29): on a deployment with
 * host agents, a host must report holding it, or a create would be answered with a build no host
 * can run (its snapshot removed after a window). A build on its way has no snapshot yet and is
 * always reused. Right after a restart no host has reported, so a create builds again: a duplicate
 * build, never a wrong answer.
 */
function stillHeld(deps: CpDeps, x: TemplateBuild): boolean {
  if (x.status !== 'registered' || !deps.hosts) return true;
  return deps.hosts.all().some(([, h]) => h.holds[x.buildId] !== undefined);
}

/** A stored build's reuse key; none for an imported build (it has no request). */
function buildReuseKey(x: TemplateBuild): string | undefined {
  if (!x.request) return undefined;
  return reuseKey(x.request.image, x.request.spec, x.profile, x.request.gateRecordSha256);
}

/** What a build keeps of its spec: the fields a client reads back (§4). */
function buildSpec(spec: Record<string, unknown>): TemplateBuild['spec'] {
  const n = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const guest = n(spec.guest_ram_mb); // normalizeSpec has put the alias guest_mb here
  return {
    ...(guest !== undefined ? { guest_mb: guest } : {}),
    ...(n(spec.vcpus) !== undefined ? { vcpus: n(spec.vcpus) } : {}),
    ...(n(spec.workspace_mb) !== undefined ? { workspace_mb: n(spec.workspace_mb) } : {}),
    ...(typeof spec.seed === 'string' ? { seed: spec.seed } : {}),
    tools: Array.isArray(spec.tools) ? (spec.tools as string[]) : [],
  };
}

/**
 * Per host: its limits, its use (the workers placement counts on it: placed, running, draining) and
 * its disk (§4, §6.2), and, from an agent
 * that reports it (register G39), its memory: the figures, the effective floor, the use and headroom
 * placement counts, and the brake (pressure or a stale inventory) that stops new starts. A host
 * silent for over HOST_STALE_S is left out, as placement leaves it out.
 */
function hostsBlock(deps: CpDeps, f: ReadinessFacts) {
  // The workers placement counts against each host's activeLimit: placed, running and draining.
  const used = f.placement?.used ?? new Map<string, number>();
  const graced = new Map<string, number>();
  for (const g of f.placement?.graced.values() ?? [])
    graced.set(g.host, (graced.get(g.host) ?? 0) + 1);
  return freshHosts(deps).map(([id, h]) => {
    const q = f.queue?.byHost.get(id);
    // Register G43: its start limit, measured start time, and start line, from an agent that reports it.
    const start = h.start
      ? {
          concurrency: h.start.concurrency,
          seconds: h.start.seconds ?? null,
          starting: q?.starting ?? null,
          queued: q?.queued ?? null,
        }
      : undefined;
    const m = h.memory;
    const u = f.placement?.memory.get(id);
    const memory =
      m && m.totalMib !== undefined && u
        ? {
            totalMib: m.totalMib,
            availableMib: m.availableMib!,
            floorMib: m.floorMib!,
            usedMib: u.usedMib,
            headroomMib: u.headroomMib,
            pressureFull10: m.pressureFull10 ?? null,
            pressureLimit: m.pressureLimit ?? null,
            brake: u.brake,
            runningWorkers: (m.running ?? []).length,
            memfileMismatch: [...(m.memfileMismatch ?? [])].sort(),
            reportedAt: h.at,
          }
        : undefined;
    return {
      id,
      active: { limit: h.limits.activeLimit, used: used.get(id) ?? 0 },
      idleLimitSeconds: h.limits.idleLimitSeconds,
      disk: { freeGb: h.limits.diskFreeGb, floorGb: h.limits.diskFloorGb },
      ...(memory ? { memory } : {}),
      ...(start ? { start } : {}),
      // Register G43: its idle grace and the builds in it now, only from an agent that sets one.
      ...(h.idleGraceSeconds
        ? { idleGraceSeconds: h.idleGraceSeconds, graced: graced.get(id) ?? 0 }
        : {}),
    };
  });
}

/**
 * Activate (§5.1, §6.3): take or renew this subject's lease on a registered build, `leaseSeconds`
 * long (default the largest idle limit of the hosts that hold it, clamped to 60-86400, else 3600;
 * at most a day per grant, renewals unlimited). Refused with template_unavailable when no host
 * holds it, no_active_slot (Retry-After) when every holder is full, quota_exceeded over the
 * subject's active quota; on a refusal the lease is not kept.
 */
async function activate(ctx: RequestCtx, deps: CpDeps) {
  const p = requireEnrolled(ctx, deps);
  writable(deps);
  const d0 = await visibleTemplate(deps, p, ctx.params.id ?? '');
  const b = asRecord(ctx.body);
  const ref =
    typeof b.build === 'string'
      ? { build: b.build }
      : { tag: typeof b.tag === 'string' ? b.tag : 'default' };
  const target = resolveBuild(d0, ref);
  if (!target || target.status !== 'registered') {
    throw new CpError(
      'template_unavailable',
      'no registered build of this template under that reference',
      undefined,
      {
        readiness: 'unavailable',
      },
    );
  }
  if (!hostManaged(target)) throw deploymentRun(d0.id);
  const r = await takeLease(deps, p, d0, target, b.leaseSeconds, 'owner');
  return {
    status: 200,
    body: { templateId: d0.id, buildId: target.buildId, leaseUntil: r.until, host: r.host },
  };
}

/**
 * The refusal of a lease on a build no host can hold (activation.ts hostManaged): one imported from
 * SH_SANDBOX_TEMPLATES, whose worker the deployment runs. It needs no activation: a sandbox is
 * created on it whenever its worker is attached, as on a deployment without host agents.
 */
const deploymentRun = (id: string) =>
  new CpError(
    'invalid_request',
    `template '${id}' is run by the deployment (SH_SANDBOX_TEMPLATES); it takes no activation lease`,
  );

/**
 * Takes or renews `p`'s lease on `target` (§6.3) and records it, or refuses with no lease kept:
 * template_unavailable, no_active_slot (Retry-After), quota_exceeded. Shared by activate and by
 * activation on first use (§6.4); `reason` is the record's (§7.1).
 */
async function takeLease(
  deps: CpDeps,
  p: TokenClaims,
  d0: TemplateDoc,
  target: TemplateBuild,
  leaseSeconds: unknown,
  reason: 'owner' | 'first_use',
): Promise<{ until: number; host: string | null }> {
  if (!hostManaged(target)) throw deploymentRun(d0.id);
  const { cat } = writable(deps);
  return activationLock(cat).run('activation', () =>
    takeLeaseLocked(deps, p, d0, target, leaseSeconds, reason),
  );
}

/** takeLease's body: run only under activationLock. */
async function takeLeaseLocked(
  deps: CpDeps,
  p: TokenClaims,
  d0: TemplateDoc,
  target: TemplateBuild,
  leaseSeconds: unknown,
  reason: 'owner' | 'first_use',
): Promise<{ until: number; host: string | null }> {
  const { cat, policy, prov } = writable(deps);
  const nowS = seconds(deps);
  const DAY = 86_400;
  const hosts = hostViewsOf(deps);
  // An explicit leaseSeconds is the client's, range-checked. The default is the largest idle limit
  // of the hosts that hold this build (3600 when none reports one), clamped into the range: a
  // host's SBX_IDLE_LIMIT_S outside it never refuses a request that named no lease.
  let want: number;
  if (leaseSeconds !== undefined && leaseSeconds !== null) {
    if (
      typeof leaseSeconds !== 'number' ||
      !Number.isSafeInteger(leaseSeconds) ||
      leaseSeconds < 60 ||
      leaseSeconds > DAY
    ) {
      throw new CpError('invalid_request', 'leaseSeconds must be 60-86400 (renew to hold longer)');
    }
    want = leaseSeconds;
  } else {
    const idle = hosts
      .filter((h) => h.holds[target.buildId] !== undefined)
      .map((h) => deps.hosts!.get(h.id)!.limits.idleLimitSeconds);
    want = Math.min(DAY, Math.max(60, Math.max(0, ...idle) || 3600));
  }
  const { policy: pol } = await policy.current();
  const docs = await cat.list();
  // `target` was resolved before the lock; a retire, and an admin's reject after the fact, take the
  // lock too, so this read is current. A build retired or rejected since is refused here (retired:
  // template_retired; rejected, as any build no longer registered: template_unavailable), so no
  // lease (none counting against the quota) is written onto it, and no `activate` record either.
  const fresh = docs.find((d) => d.id === d0.id)?.builds.find((x) => x.buildId === target.buildId);
  if (fresh?.status === 'retired')
    throw new CpError('template_retired', `template '${d0.id}' build ${target.buildId} is retired`);
  if (fresh?.status !== 'registered')
    throw new CpError('template_unavailable', 'this build is no longer registered', undefined, {
      readiness: 'unavailable',
    });
  const held = docs
    .flatMap((d) => d.builds)
    .filter(
      (x) => x.buildId !== target.buildId && liveLeases(x, nowS).some((l) => l.subject === p.sub),
    );
  if (held.length >= quotaFor(pol, p.sub).active) {
    throw new CpError(
      'quota_exceeded',
      `at most ${quotaFor(pol, p.sub).active} active templates per subject`,
      undefined,
      { quota: 'active' },
    );
  }
  const withLease = (x: TemplateBuild, record?: string): TemplateBuild => {
    const others = (x.leases ?? []).filter((l) => l.subject !== p.sub && l.until > nowS);
    const mine = (x.leases ?? []).find((l) => l.subject === p.sub && l.until > nowS);
    return {
      ...x,
      leases: [
        ...others,
        {
          subject: p.sub,
          until: nowS + want,
          since: mine?.since ?? nowS,
          ...(record ? { record } : {}),
        },
      ],
    };
  };
  // Would it be placed? Judge with this lease added, before keeping it.
  const trial = docs.map((d) =>
    d.id !== d0.id
      ? d
      : { ...d, builds: d.builds.map((x) => (x.buildId === target.buildId ? withLease(x) : x)) },
  );
  // Register G43: a graced worker gives its slot up to this lease (it is not `placed`, so never
  // "displaced" below); the workers with a live sandbox are never graced.
  const busy = await busyWorkers(deps, nowS);
  const pl = place(trial, hosts, nowS, busy);
  // A held build is never evicted to make room (§6.3): placement breaks a tie of equal `since` (whole
  // seconds) by buildId, so a lease taken in the same second as a placed one could otherwise sort
  // ahead of it and push it off its host. Such a lease waits, as one that does not fit.
  const before = place(docs, hosts, nowS, busy);
  const displaced = [...before.placed.keys()].find(
    (b) => b !== target.buildId && !pl.placed.has(b),
  );
  const displaces = displaced !== undefined;
  // Displacing, the refusal's reason is the displaced build's: what would push it off (G39).
  const why =
    displaced !== undefined ? pl.unplaced.get(displaced) : pl.unplaced.get(target.buildId);
  if (hosts.length > 0 && why === 'not_held') {
    throw new CpError('template_unavailable', "no host holds this build's snapshot", undefined, {
      readiness: 'unavailable',
    });
  }
  // Every holder reports this build's memory file wrong (G39): no wait clears it, a rebuild does.
  if (!displaces && why === 'memfile_mismatch') {
    throw new CpError(
      'template_unavailable',
      "every host holding this build reports its memory file is not the guest's size",
      undefined,
      { readiness: 'unavailable', reason: 'memfile_mismatch' },
    );
  }
  if (why === 'no_slot' || why === 'memory' || displaces) {
    // Retry-After: the soonest a slot on one of this build's holders can free, that is the soonest
    // another build placed on one of them loses its last live lease. Other hosts' builds, and other
    // subjects' leases on a build that stays leased, free nothing here. 60 s when no leased build
    // holds those slots (draining workers, whose end no lease tells).
    const holders = new Set(
      hosts.filter((h) => h.holds[target.buildId] !== undefined).map((h) => h.id),
    );
    const free = Math.min(
      ...trial
        .flatMap((d) => d.builds)
        .filter((x) => x.buildId !== target.buildId && holders.has(pl.placed.get(x.buildId) ?? ''))
        .map((x) => Math.max(...liveLeases(x, nowS).map((l) => l.until)) - nowS),
    );
    // A memory refusal says so; one at the active limit answers exactly as before.
    throw new CpError(
      'no_active_slot',
      why === 'memory'
        ? 'no host holding this build has the memory for its worker now (memory-aware placement)'
        : 'every host holding this build is at its active limit with leased builds',
      undefined,
      why === 'memory'
        ? { readiness: 'unavailable', reason: 'memory' }
        : { readiness: 'unavailable' },
      Number.isFinite(free) ? Math.max(1, free) : 60,
    );
  }
  // The record first, so the lease can name it (a sandbox under this lease cites it, §7.1), and no
  // lease is ever stored without its record.
  const rec = await prov.append({
    stream: `template/${d0.id}`,
    kind: 'activate',
    subject: p.sub,
    body: {
      buildId: target.buildId,
      leaseSeconds: want,
      until: nowS + want,
      ...(pl.placed.get(target.buildId) ? { host: pl.placed.get(target.buildId)! } : {}),
      ...(reason === 'first_use' ? { reason } : {}),
    },
  });
  await cat.update(d0.id, async (cur) => ({
    ...cur!,
    builds: cur!.builds.map((x) => (x.buildId === target.buildId ? withLease(x, rec.digest) : x)),
  }));
  return { until: nowS + want, host: pl.placed.get(target.buildId) ?? null };
}

/**
 * Deactivate (§5.1): drop this subject's lease; the build stays wanted while others hold it. When
 * none is left, the time is kept as the build's lastLeaseEnd, from which a host's idle grace runs
 * (register G43). `stopNow: true` skips that grace: a build left with no lease is stopped at the
 * next wanted answer (forced cold), and the `deactivate` record says `stopNow: true`.
 */
async function deactivate(ctx: RequestCtx, deps: CpDeps) {
  const p = requireEnrolled(ctx, deps);
  const { cat, prov } = writable(deps);
  const d0 = await visibleTemplate(deps, p, ctx.params.id ?? '');
  const b = asRecord(ctx.body);
  if (b.stopNow !== undefined && typeof b.stopNow !== 'boolean')
    throw new CpError('invalid_request', 'stopNow must be a boolean');
  const stopNow = b.stopNow === true;
  const nowS = seconds(deps);
  const all = isAdmin(p) && b.all === true;
  let dropped = 0;
  // Builds whose idle grace this stopNow ends: unleased, with a lease end it had not covered yet.
  let ended = 0;
  await cat.update(d0.id, async (cur) => ({
    ...cur!,
    builds: cur!.builds.map((x) => {
      const live = (x.leases ?? []).filter((l) => l.until > nowS);
      const keep = live.filter((l) => !(all || l.subject === p.sub));
      dropped += live.length - keep.length;
      // The end of its last lease (G43): now when this drop leaves none, else what the expired
      // leases this write clears said (lastLeaseEnd reads them before they go).
      const prior = lastLeaseEnd(x, nowS);
      const end = keep.length === 0 && live.length > 0 ? nowS : prior;
      const out: TemplateBuild = {
        ...x,
        leases: keep,
        ...(end !== undefined ? { lastLeaseEnd: end } : {}),
      };
      if (stopNow && keep.length === 0 && x.status === 'registered' && end !== undefined) {
        if (x.stopNowAt === undefined || end > x.stopNowAt) ended += 1;
        out.stopNowAt = nowS;
      }
      return out;
    }),
  }));
  if (dropped > 0 || ended > 0) {
    await prov.append({
      stream: `template/${d0.id}`,
      kind: 'deactivate',
      subject: p.sub,
      body: { leases: dropped, all, ...(stopNow ? { stopNow: true } : {}) },
    });
  }
  return { status: 200, body: { templateId: d0.id, released: dropped } };
}

/**
 * A change's records (§7.1), appended inside the catalog's write, as create does: the write
 * happens only after they are on the chain, so a change is never stored without its record. Every
 * body is checked as canonical JSON before the first append, so a body the chain refuses refuses
 * the change and writes nothing. A failed write after the appends leaves records of a change not
 * stored, which a reader sees against the catalog; never the reverse. Returns their digests.
 */
async function appendRecords(prov: ProvenanceStore, inputs: AppendInput[]): Promise<string[]> {
  for (const x of inputs) canonicalJson(x.body);
  const digests: string[] = [];
  for (const x of inputs) digests.push((await prov.append(x)).digest);
  return digests;
}

/** The statuses an owner may cancel (§5.1): not yet built. */
const CANCELLABLE = new Set<TemplateBuild['status']>(['queued', 'building', 'probing']);

/**
 * Cancel (§5.1, register G22): the owner (or an admin) withdraws a build not yet built; it becomes
 * `failed` with step `cancelled`, and a `build` record says who cancelled it. A host agent still
 * building it has its later reports refused (a failed build takes none), so it never registers.
 */
async function cancelBuild(ctx: RequestCtx, deps: CpDeps) {
  const { p, cat, prov, d0, own } = await ownTemplate(ctx, deps, 'cancels its builds');
  const ref = ctx.params.build ?? '';
  let cancelled: TemplateBuild | undefined;
  await cat.update(d0.id, async (c) => {
    const cur = own(c);
    const x = cur.builds.find((y) => y.handle === ref || y.buildId === ref);
    if (!x) throw new CpError('template_not_found', 'no such build of this template');
    if (!CANCELLABLE.has(x.status))
      throw new CpError(
        'invalid_request',
        `the build is ${x.status}; only a queued, building or probing build is cancelled`,
      );
    cancelled = {
      ...x,
      status: 'failed',
      reason: { message: `cancelled by ${p.sub}`, step: 'cancelled' },
    };
    await appendRecords(prov, [
      {
        stream: `template/${d0.id}`,
        kind: 'build',
        subject: p.sub,
        body: { handle: cancelled.handle ?? cancelled.buildId, outcome: 'cancelled' },
      },
    ]);
    return { ...cur, builds: cur.builds.map((y) => (y === x ? cancelled! : y)) };
  });
  await auditBestEffort(deps, 'template_build_cancelled', d0.id, {
    subject: p.sub,
    decision: 'template_build_cancelled',
  });
  return {
    status: 200,
    body: { templateId: d0.id, build: cancelled!.handle ?? cancelled!.buildId, status: 'failed' },
  };
}

/**
 * Retire (§5.1): the owner, or an admin, retires a whole template (every build not yet retired) or
 * one build. A retired build is never used again (a create naming it answers `410
 * template_retired`), its leases go (so it is no longer wanted), and a host holding it is asked to
 * remove its snapshot and worker (`GET /v1/hosts/{host}/wanted` `remove`, §6.1 step 7). Refused
 * while a live sandbox runs on the build (`409 build_in_use`): a worker is never removed under one.
 * Its records stay, and each retire is a `retire` record naming who did it. Idempotent: an already
 * retired build is answered as retired, with no second record.
 */
/**
 * Why each build is in use now (§5.1): a live sandbox runs on it. A retire is refused while any
 * build it names is in use, so it never cuts off running work. A sandbox names the build it
 * resolved to (`buildId`), so it counts for that build only: two builds of one template from one
 * image can share a worker id, and a sandbox on one must not block retiring the other. A record
 * from before builds were traced (no `buildId`) counts for every build on its worker.
 */
async function buildsInUse(
  deps: CpDeps,
  builds: TemplateBuild[],
  nowS: number,
): Promise<Set<string>> {
  const out = new Set<string>();
  if (!deps.sandboxes) return out;
  const busyBuilds = new Set<string>();
  const legacyWorkers = new Set<string>();
  for (const r of await deps.sandboxes.listAll(nowS)) {
    if (!isLive(r, nowS)) continue;
    if (r.buildId) busyBuilds.add(r.buildId);
    else legacyWorkers.add(r.worker);
  }
  for (const x of builds)
    if (busyBuilds.has(x.buildId) || (x.worker !== '' && legacyWorkers.has(x.worker)))
      out.add(x.buildId);
  return out;
}

/**
 * A sandbox create's store write, under its template's use lock (templateUseLock), after one last
 * read of its build's status: a retire or an admin's reject that took the lock first leaves the
 * build ended, and the create is refused with nothing stored (`410 template_retired`; `400
 * unknown_template` for a build no longer registered); one that comes after sees this sandbox live
 * and is refused `409 build_in_use`. Without a template store nothing can end, and no lock is taken.
 */
async function createUnlessEnded<T>(
  deps: CpDeps,
  t: { id: string; buildId: string },
  create: () => Promise<T>,
): Promise<T> {
  const cat = deps.templates;
  if (!cat?.update) return create();
  return templateUseLock(cat).run(t.id, async () => {
    const b = (await cat.get(t.id))?.builds.find((x) => x.buildId === t.buildId);
    if (b?.status === 'retired')
      throw new CpError('template_retired', `template '${t.id}' build ${t.buildId} is retired`);
    if (b?.status !== 'registered')
      throw new CpError('unknown_template', 'no such template (GET /v1/templates lists them)');
    return create();
  });
}

async function retireBuilds(
  ctx: RequestCtx,
  deps: CpDeps,
  which: (b: TemplateBuild) => boolean,
  mode: 'retire' | 'reject' = 'retire',
): Promise<{
  templateId: string;
  subject: string;
  builds: { build: string; buildId: string | null; readiness: 'retired'; record: string | null }[];
}> {
  const p = requireEnrolled(ctx, deps);
  const { cat, prov } = writable(deps);
  const d0 = await visibleTemplate(deps, p, ctx.params.id ?? '');
  if (mode === 'reject' ? !isAdmin(p) : d0.owner !== p.sub && !isAdmin(p))
    throw new CpError(
      'forbidden',
      mode === 'reject'
        ? 'rejecting a build after the fact requires the admin role'
        : "only the template's owner, or an admin, retires it",
    );
  const reason = asRecord(ctx.body).reason;
  if (mode === 'reject' && (typeof reason !== 'string' || !reason.trim()))
    throw new CpError('invalid_request', 'a reject needs a reason: the rule found broken, and why');
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1024))
    throw new CpError('invalid_request', 'reason must be a string of at most 1024 characters');
  const done: TemplateBuild[] = [];
  const records = new Map<TemplateBuild, string>();
  // Under the activation lock, so an activation never writes a lease onto a build retired or
  // rejected after it resolved the build: it re-reads the build's status under the same lock
  // (takeLeaseLocked). And under this template's use lock, inside it (activation, then template),
  // so a sandbox create on this template either is stored before the in-use check or sees the
  // build ended (createUnlessEnded).
  await activationLock(cat).run('activation', () =>
    templateUseLock(cat).run(d0.id, async () => {
      // Read from the template as it is now, under the locks: d0 was read before them, and a build
      // it saw still building may have registered (taking its buildId, then a sandbox) while this
      // waited. A build that registers after this read has no sandbox, and gets none while the use
      // lock is held. Read before the catalog update, so no store lookup runs inside it.
      const now = await cat.get(d0.id);
      if (!now) throw new CpError('template_not_found', 'no such template');
      const live = now.builds.filter((x) => which(x) && x.status !== 'retired');
      const inUse = await buildsInUse(deps, live, seconds(deps));
      // A Moca Pi session pinned to the build is live use too: its next turn needs the worker.
      const pinned = new Set<string>();
      if (deps.index?.hasActiveSessionOnBuild) {
        for (const x of live)
          if (await deps.index.hasActiveSessionOnBuild(x.buildId)) pinned.add(x.buildId);
      }
      await cat.update(d0.id, async (cur) => {
        done.length = 0;
        records.clear();
        const targets = cur!.builds.filter(which);
        if (targets.length === 0)
          throw new CpError('template_not_found', 'no such build of this template');
        if (
          mode === 'reject' &&
          targets.some((x) => x.status !== 'registered' && x.status !== 'rejected')
        )
          throw new CpError(
            'invalid_request',
            'only a registered build is rejected after the fact',
          );
        const busy = targets.find((x) => x.status !== 'retired' && inUse.has(x.buildId));
        if (busy)
          throw new CpError(
            'build_in_use',
            `build ${busy.handle ?? busy.buildId} still serves a live sandbox: delete it, then retire`,
          );
        const held = targets.find((x) => x.status !== 'retired' && pinned.has(x.buildId));
        if (held)
          throw new CpError(
            'build_in_use',
            `build ${held.handle ?? held.buildId} is pinned by an active session: delete it, then retire`,
          );
        const end = mode === 'reject' ? ('rejected' as const) : ('retired' as const);
        done.push(...targets.filter((x) => x.status !== end && x.status !== 'retired'));
        // Each record is written inside the update, as a host's build report writes its own: a
        // record that cannot be written leaves the build as it was, so a retry ends it with its
        // record, and no build is retired or rejected without one.
        for (const x of done) {
          const rec = await prov.append({
            stream: `template/${d0.id}`,
            kind: mode,
            subject: p.sub,
            body: {
              build: x.handle ?? x.buildId,
              ...(x.status === 'registered' ? { buildId: x.buildId } : {}),
              buildRecord: await buildRecordOf(prov, d0.id, x),
              from: x.status,
              ...(typeof reason === 'string' ? { reason } : {}),
            },
          });
          records.set(x, rec.digest);
        }
        return {
          ...cur!,
          builds: cur!.builds.map((x) =>
            done.includes(x)
              ? {
                  ...x,
                  status: end,
                  leases: [],
                  ...(mode === 'reject'
                    ? { reason: { message: String(reason), rule: 'admin', step: 'rejected' } }
                    : {}),
                }
              : x,
          ),
        };
      });
    }),
  );
  if (done.length > 0)
    await auditBestEffort(
      deps,
      mode === 'reject' ? 'template_build_rejected' : 'template_retired',
      d0.id,
      {
        subject: p.sub,
        decision: mode === 'reject' ? 'template_build_rejected' : 'template_retired',
      },
    );
  // What ties the answer to the trace (the client's request, 2026-11-06): each build, its id, its
  // readiness and the record written now (null for one already retired: no second record).
  const byHandle = new Map([...records].map(([x, d]) => [x.handle ?? x.buildId, d]));
  const after = (await cat.get(d0.id))!;
  return {
    templateId: d0.id,
    subject: p.sub,
    builds: after.builds
      .filter((x) => x.status === (mode === 'reject' ? 'rejected' : 'retired') && which(x))
      .map((x) => ({
        build: x.handle ?? x.buildId,
        buildId:
          x.handle && x.handle !== x.buildId && x.buildId.startsWith('b-') ? null : x.buildId,
        readiness: 'retired' as const,
        record: byHandle.get(x.handle ?? x.buildId) ?? null,
      })),
  };
}

/**
 * Tags (§3.2, §5.1): the owner, or an admin, moves tags onto a registered build without rebuilding,
 * or removes one; a reference `id:tag` (and `id` for `default`) then resolves to the new build for new
 * sandboxes and sessions; those already created keep theirs. Removing a tag never deletes its build;
 * `default` is moved, never removed (the bare `id` must resolve). Each change is a `tag` record with
 * the new value and the one before (§7).
 */
async function ownTemplate(ctx: RequestCtx, deps: CpDeps, verb: string) {
  const p = requireEnrolled(ctx, deps);
  const w = writable(deps);
  const trusted = await trustedSet(deps);
  const own = (d: TemplateDoc | null): TemplateDoc => ownerCheck(d, p, trusted, verb);
  const d0 = own(await catalog(deps).get(ctx.params.id ?? ''));
  return { p, ...w, d0, own };
}

/**
 * The owner's check on a document: 404 for one the caller cannot see (or none), 403 for one that
 * is neither theirs nor an admin's to act on. `ownTemplate` makes it on the document as read, for
 * an early answer; each write makes it again on the document under the template's lock, so an
 * owner transfer (or a change to private) between the two is seen and the old owner's change
 * refused.
 */
function ownerCheck(
  d: TemplateDoc | null,
  p: TokenClaims,
  trusted: ReadonlySet<string>,
  verb: string,
): TemplateDoc {
  if (!d || !canSee(d, p, trusted)) throw new CpError('template_not_found', 'no such template');
  if (d.owner !== p.sub && !isAdmin(p))
    throw new CpError('forbidden', `only the template's owner, or an admin, ${verb}`);
  return d;
}

async function moveTemplateTags(ctx: RequestCtx, deps: CpDeps) {
  const { p, cat, prov, d0, own } = await ownTemplate(ctx, deps, 'moves its tags');
  const b = asRecord(ctx.body);
  const tags = b.tags;
  if (!Array.isArray(tags) || tags.length === 0 || tags.length > 16)
    throw new CpError('invalid_request', 'tags must be a list of 1-16 tag names');
  for (const t of tags)
    if (typeof t !== 'string' || !TEMPLATE_ID_RE.test(t))
      throw new CpError(
        'invalid_request',
        `tag '${String(t)}' must match ${TEMPLATE_ID_RE.source}`,
      );
  if (new Set(tags).size !== tags.length)
    throw new CpError('invalid_request', 'a tag is listed twice');
  const ref = typeof b.build === 'string' ? b.build : '';
  const nowS = seconds(deps);
  let buildId = '';
  let moved: { tag: string; from: string | null }[] = [];
  const records: Record<string, string> = {};
  // The build is checked under the template's write lock, so it is still registered when tagged,
  // and its records are appended inside the write, so no move is stored without its record.
  await cat.update(d0.id, async (c) => {
    const cur = own(c);
    moved = [];
    const target = cur.builds.find((x) => x.buildId === ref || x.handle === ref);
    if (!target) throw new CpError('template_not_found', 'no such build of this template');
    if (target.status === 'retired')
      throw new CpError('template_retired', `build ${target.buildId} is retired: tag a live build`);
    if (target.status !== 'registered')
      throw new CpError(
        'invalid_request',
        `the build is ${target.status}; only a registered build is tagged`,
      );
    buildId = target.buildId;
    const next = { ...cur.tags };
    const meta = { ...(cur.tagsMeta ?? {}) };
    for (const t of tags as string[]) {
      // An own property only: a tag such as `constructor` is not Object.prototype's.
      const from = Object.hasOwn(next, t) ? next[t]! : null;
      if (from === buildId) continue;
      moved.push({ tag: t, from });
      next[t] = buildId;
      meta[t] = { at: nowS, by: p.sub };
    }
    const digests = await appendRecords(
      prov,
      moved.map((m) => ({
        stream: `template/${d0.id}`,
        kind: 'tag' as const,
        subject: p.sub,
        body: { tag: m.tag, buildId, before: m.from },
      })),
    );
    moved.forEach((m, i) => (records[m.tag] = digests[i]!));
    return { ...cur, tags: next, tagsMeta: meta };
  });
  if (moved.length > 0)
    await auditBestEffort(deps, 'template_tags_moved', d0.id, {
      subject: p.sub,
      decision: 'template_tags_moved',
    });
  return {
    status: 200,
    body: {
      templateId: d0.id,
      subject: p.sub,
      buildId,
      // `before`: what the tag named until now (null: it is new); unchanged tags name their build.
      tags: (tags as string[]).map((t) => {
        const m = moved.find((x) => x.tag === t);
        return { tag: t, buildId, before: m ? m.from : buildId, record: records[t] ?? null };
      }),
    },
  };
}

async function removeTemplateTag(ctx: RequestCtx, deps: CpDeps) {
  const { p, cat, prov, d0, own } = await ownTemplate(ctx, deps, 'removes its tags');
  const tag = ctx.params.tag ?? '';
  if (!TEMPLATE_ID_RE.test(tag))
    throw new CpError('invalid_request', `tag '${tag}' must match ${TEMPLATE_ID_RE.source}`);
  if (tag === 'default')
    throw new CpError(
      'invalid_request',
      'the default tag is moved (POST …/tags), never removed: the bare id must resolve',
    );
  let before = '';
  let record = '';
  await cat.update(d0.id, async (c) => {
    const cur = own(c);
    // An own property only: a tag such as `constructor` is not Object.prototype's.
    const b = Object.hasOwn(cur.tags, tag) ? cur.tags[tag] : undefined;
    if (b === undefined)
      throw new CpError('template_not_found', `no tag '${tag}' on this template`);
    before = b;
    const next = { ...cur.tags };
    const meta = { ...(cur.tagsMeta ?? {}) };
    delete next[tag];
    delete meta[tag];
    [record] = await appendRecords(prov, [
      {
        stream: `template/${d0.id}`,
        kind: 'tag',
        subject: p.sub,
        body: { tag, buildId: null, before },
      },
    ]);
    return { ...cur, tags: next, tagsMeta: meta };
  });
  return {
    status: 200,
    body: { templateId: d0.id, subject: p.sub, tag, buildId: null, before, record },
  };
}

/**
 * Reject after the fact (§5.2): an admin rejects a registered build (a rule found broken), with the
 * reason. As a retire, it ends the build's use, drops its leases, a host holding it removes it, and
 * it is refused under a live sandbox or session; a create naming it answers `400 unknown_template`,
 * as for a build policy rejected at registration. A `reject` record names the admin and the reason.
 */
async function rejectTemplateBuild(ctx: RequestCtx, deps: CpDeps) {
  const ref = ctx.params.build ?? '';
  const r = await retireBuilds(ctx, deps, (x) => x.handle === ref || x.buildId === ref, 'reject');
  const b = r.builds[0];
  return {
    status: 200,
    body: {
      templateId: r.templateId,
      subject: r.subject,
      build: b?.build ?? ref,
      buildId: b?.buildId ?? null,
      record: b?.record ?? null,
      status: 'rejected',
    },
  };
}

/**
 * Edit (§5.1): the owner, or an admin, changes a template's description or visibility. Visibility
 * `private` hides it from other subjects (they get 404, as for an id that does not exist) and
 * refuses their new use; their sandboxes and sessions already created keep running. A `visibility`
 * record (the new value and the one before) is written for a visibility change; a description change
 * is a `visibility` record too, with the field it changed, so every edit is on the chain.
 */
async function updateTemplate(ctx: RequestCtx, deps: CpDeps) {
  const { p, cat, prov, d0, own } = await ownTemplate(ctx, deps, 'edits it');
  const b = asRecord(ctx.body);
  if (b.visibility === undefined && b.description === undefined)
    throw new CpError('invalid_request', 'nothing to change: send visibility or description');
  if (b.visibility !== undefined && b.visibility !== 'private' && b.visibility !== 'deployment')
    throw new CpError('invalid_request', "visibility must be 'private' or 'deployment'");
  if (
    b.description !== undefined &&
    (typeof b.description !== 'string' || b.description.length > 1024)
  )
    throw new CpError('invalid_request', 'description must be a string of at most 1024 characters');
  // A JSON body can carry a lone surrogate (`"\ud800"`), which a provenance record cannot hold.
  if (typeof b.description === 'string' && LONE_SURROGATE_RE.test(b.description))
    throw new CpError('invalid_request', 'description must not hold a lone surrogate');
  const visibility = b.visibility as 'private' | 'deployment' | undefined;
  const description = b.description as string | undefined;
  const trusted = visibility === 'deployment' ? await trustedSet(deps) : undefined;
  let changes: { field: 'visibility' | 'description'; value: string; before: string }[] = [];
  const records: Record<string, string> = {};
  // The owner's check, the self-attestation check and the records run under the template's lock,
  // on the document as it is then; the change is stored only once its records are on the chain.
  const after = await cat.update(d0.id, async (c) => {
    const cur = own(c);
    // A self-attested template reaches no one else on its owner's own gate.
    if (
      trusted &&
      cur.builds.some((x) => x.status !== 'retired' && attestationOf(x, trusted) === 'self')
    )
      throw new CpError(
        'self_attested',
        'a self-attested build stays private until an admin trusts its gate record (trustedGateRecords)',
      );
    changes = [];
    if (visibility !== undefined && visibility !== cur.visibility)
      changes.push({ field: 'visibility', value: visibility, before: cur.visibility });
    if (description !== undefined && description !== cur.description)
      changes.push({ field: 'description', value: description, before: cur.description });
    const digests = await appendRecords(
      prov,
      changes.map((x) => ({
        stream: `template/${d0.id}`,
        kind: 'visibility' as const,
        subject: p.sub,
        body: { field: x.field, value: x.value, before: x.before },
      })),
    );
    changes.forEach((x, k) => (records[x.field] = digests[k]!));
    return {
      ...cur,
      ...(visibility !== undefined ? { visibility } : {}),
      ...(description !== undefined ? { description } : {}),
    };
  });
  return {
    status: 200,
    body: {
      templateId: d0.id,
      subject: p.sub,
      visibility: after.visibility,
      description: after.description,
      changes: changes.map((x) => ({ ...x, record: records[x.field] })),
    },
  };
}

/**
 * Transfer ownership (§5.2): an admin makes another enrolled subject the template's owner, for
 * example when its creator leaves. The new owner gets every owner action; quotas count it as theirs
 * from now on. Leases, sandboxes and sessions already made keep their own subjects. An `owner`
 * record names the admin, the new owner and the one before.
 *
 * A template the deployment declared (imported from SH_SANDBOX_TEMPLATES, owner null) can be handed
 * to a subject the same way (register G34): its id otherwise blocks every self-serve create under it
 * (`409 template_exists`), retired or not. The record's `before` is null. The import runs once, into
 * an empty catalog, so a restart does not take it back.
 */
async function transferTemplateOwner(ctx: RequestCtx, deps: CpDeps) {
  const p = requireEnrolled(ctx, deps);
  if (!isAdmin(p))
    throw new CpError('forbidden', 'transferring a template requires the admin role');
  const { cat, prov } = writable(deps);
  const d0 = await visibleTemplate(deps, p, ctx.params.id ?? '');
  const owner = asRecord(ctx.body).owner;
  if (typeof owner !== 'string' || !MEMBER_SUBJECT_RE.test(owner))
    throw new CpError('invalid_request', `owner must be a subject, ${MEMBER_SUBJECT_FORMS}`);
  // The new owner must be able to act on it: enrolled now, by the allow list, an admin role or the
  // members store (register G38).
  const om = await membershipNow(deps, owner, []);
  if (!isEnrolledForSandbox(owner, om.roles, deps.config, om.enrolled))
    throw new CpError(
      'invalid_request',
      `${owner} is not enrolled: enroll them first (PUT /v1/subjects/${owner}, or SBX_ALLOWED_SUBJECTS)`,
    );
  let before = null as string | null;
  let record: string | null = null;
  // The transfer reads the owner it replaces under the template's lock, and its record is
  // appended inside the write, so no transfer is stored without its record.
  await cat.update(d0.id, async (cur) => {
    if (!cur) throw new CpError('template_not_found', 'no such template');
    before = cur.owner;
    if (before === owner) return cur;
    [record] = await appendRecords(prov, [
      { stream: `template/${d0.id}`, kind: 'owner', subject: p.sub, body: { owner, before } },
    ]);
    return { ...cur, owner };
  });
  return { status: 200, body: { templateId: d0.id, subject: p.sub, owner, before, record } };
}

/**
 * A sandbox's end on its build's chain (§7.1): `deleted` when DELETE ends it, `expired` when it is
 * first seen past its expiresAt (expiry is computed, not an event, so that record comes when it is
 * noticed; its body's expiresAt is the true end).
 */
async function sandboxEnded(
  deps: CpDeps,
  rec: SandboxRecord,
  subject: string,
  reason: 'deleted' | 'expired',
  nowS: number,
): Promise<void> {
  if (!deps.provenance) return;
  await deps.provenance.append({
    stream: `template/${rec.template}`,
    kind: 'sandbox',
    subject,
    body: {
      sandboxId: rec.id,
      buildId: rec.buildId ?? null,
      state: 'terminated',
      reason,
      expiresAt: rec.expiresAt,
      ...(reason === 'deleted' ? { endedAt: nowS } : {}),
      ...(deps.egress ? { egress: await egressDigest(deps.egress, rec.id) } : {}),
    },
  });
}

/**
 * What a `sandbox` record names of the egress log (register G42): its digest, and its completeness
 * with the reasons (`droppedBy`: proxy, cap, budget, invalid).
 */
async function egressDigest(store: EgressStore, id: string) {
  const s = await summarize(store, id);
  return {
    events: s.total,
    sha256: s.sha256,
    dropped: s.dropped,
    droppedBy: s.droppedBy,
    complete: s.complete,
  };
}

/**
 * Seals each ended sandbox's egress log once its grace has passed (egress-log.ts EGRESS_GRACE_S),
 * in the janitor's sweep after recordExpiries. A log that changed after its end record named it
 * (events that arrived in the grace) gets one more `sandbox` record, `state: 'egress'`, naming the
 * final log: the newest `sandbox` record of a sandbox that carries `egress` is its log's digest.
 *
 * The seal comes last, after the record is written: a sweep that fails before it (the chain, the
 * digest or the append) leaves the log unsealed, so the next sweep does the work again. Past the
 * grace the host post takes no events for the sandbox, so the log no longer changes, and the
 * compare with the chain's newest record keeps a repeated sweep from writing a second record.
 */
async function sealEgress(deps: CpDeps, recs: SandboxRecord[], nowS: number): Promise<void> {
  const store = deps.egress;
  const retentionS = deps.config.sandbox?.retentionS ?? 0;
  if (!store) return;
  const due = recs.filter(
    (r) => !isLive(r, nowS) && nowS >= (r.deletedAt ?? r.expiresAt) + EGRESS_GRACE_S,
  );
  const chains = new Map<string, Awaited<ReturnType<ProvenanceStore['chain']>>>();
  for (const r of due) {
    if ((await store.meta(r.id)).sealed) continue;
    if (deps.provenance) {
      const stream = `template/${r.template}`;
      if (!chains.has(stream)) chains.set(stream, await deps.provenance.chain(stream));
      const named = chains
        .get(stream)!
        .filter(
          (x) =>
            x.kind === 'sandbox' &&
            (x.body as { sandboxId?: string }).sandboxId === r.id &&
            (x.body as { egress?: unknown }).egress !== undefined,
        )
        .pop()?.body.egress as { sha256?: string; dropped?: number } | undefined;
      const now = await egressDigest(store, r.id);
      if (!named || named.sha256 !== now.sha256 || named.dropped !== now.dropped) {
        await deps.provenance.append({
          stream,
          kind: 'sandbox',
          subject: 'janitor',
          body: { sandboxId: r.id, buildId: r.buildId ?? null, state: 'egress', egress: now },
        });
      }
    }
    await store.seal(r.id, (r.deletedAt ?? r.expiresAt) + retentionS);
  }
}

/**
 * The `expired` end records (§7.1), written when expiry is first noticed: the janitor's sweep reads
 * every sandbox, so it is where an expired one is seen. Once per sandbox: a template chain already
 * holding this sandbox's terminated record is skipped (the chain is the marker, no store field).
 */
async function recordExpiries(deps: CpDeps, recs: SandboxRecord[], nowS: number): Promise<void> {
  if (!deps.provenance) return;
  const expired = recs.filter((r) => r.deletedAt === undefined && nowS >= r.expiresAt);
  const byTemplate = new Map<string, SandboxRecord[]>();
  for (const r of expired) byTemplate.set(r.template, [...(byTemplate.get(r.template) ?? []), r]);
  for (const [template, rs] of byTemplate) {
    const ended = new Set(
      (await deps.provenance.chain(`template/${template}`))
        .filter(
          (x) => x.kind === 'sandbox' && (x.body as { state?: string }).state === 'terminated',
        )
        .map((x) => (x.body as { sandboxId?: string }).sandboxId),
    );
    for (const r of rs)
      if (!ended.has(r.id)) await sandboxEnded(deps, r, 'janitor', 'expired', nowS);
  }
}

async function retireTemplate(ctx: RequestCtx, deps: CpDeps) {
  const r = await retireBuilds(ctx, deps, () => true);
  return { status: 200, body: { ...r, status: 'retired' } };
}

async function retireTemplateBuild(ctx: RequestCtx, deps: CpDeps) {
  const ref = ctx.params.build ?? '';
  const r = await retireBuilds(ctx, deps, (x) => x.handle === ref || x.buildId === ref);
  return {
    status: 200,
    body: { templateId: r.templateId, subject: r.subject, ...r.builds[0], status: 'retired' },
  };
}

/**
 * A sandbox's template reference (§3.2, §4): `id`, `id:tag` or `id@sha256:...`, resolved to one
 * registered build and its worker at creation, and kept for the sandbox's life. A build not
 * `active` is not refused here (its first Exec waits on the relay, as before); activation on first
 * use (§6.4) is not built.
 */
export async function resolveForUse(
  deps: CpDeps,
  p: TokenClaims,
  ref: string,
): Promise<{
  id: string;
  worker: string;
  buildId: string;
  doc: TemplateDoc;
  build: TemplateBuild;
}> {
  const at = ref.indexOf('@');
  const colon = at < 0 ? ref.indexOf(':') : -1;
  const id = at >= 0 ? ref.slice(0, at) : colon >= 0 ? ref.slice(0, colon) : ref;
  const r =
    at >= 0 ? { build: ref.slice(at + 1) } : colon >= 0 ? { tag: ref.slice(colon + 1) } : {};
  const d = await catalog(deps).get(id);
  const trusted = await trustedSet(deps);
  const seen = !!d && canSee(d, p, trusted);
  const b = d && seen ? resolveBuild(d, r) : null;
  // A retired build, or a template whose every build is retired, is gone, not unknown (§5.1).
  if (
    d &&
    seen &&
    (b?.status === 'retired' ||
      (!b && d.builds.length > 0 && d.builds.every((x) => x.status === 'retired')))
  ) {
    throw new CpError(
      'template_retired',
      `template '${d.id}'${b ? ` build ${b.buildId}` : ''} is retired`,
    );
  }
  if (!d || !b || b.status !== 'registered' || !b.worker) {
    throw new CpError('unknown_template', 'no such template (GET /v1/templates lists them)');
  }
  return { id: d.id, worker: b.worker, buildId: b.buildId, doc: d, build: b };
}

/** How long a client waits before retrying a create on a template still activating (§6.4). */
export const FIRST_USE_RETRY_S = 30;

/**
 * Activation on first use (§6.4): on a deployment with host agents, a sandbox is created only on
 * an `active` build. One not active is refused with `409 template_not_active` and Retry-After, and,
 * unless the client sent `activate: false`, the caller's lease on it is taken first, so the host
 * agent starts its worker; the retry succeeds once it is attached. No sandbox record is kept while
 * waiting, so a wait never uses the caller's live-sandbox cap. Without host agents (workers run
 * by the deployment, SH_TEMPLATE_HOSTS unset) nothing changes: the create succeeds as before.
 * With hosts configured but none reported within HOST_STALE_S (a fresh deploy, a restart, every
 * host down), readiness is the worker's presence alone: an attached worker serves, and an absent one is refused rather
 * than left to wait at the relay. A build imported from SH_SANDBOX_TEMPLATES (no snapshot, so no
 * host ever holds it) is never gated: the deployment runs its worker.
 *
 * `mayActivate` false (a session's create by a subject not enrolled for sandboxes, combined spec
 * §3.4) never takes a lease: activation is enrolled-only, as on the activate route. Such a caller
 * waits (409) on a build another subject's lease is starting, and is refused (403 not_enrolled) one
 * nobody is starting, which only an enrolled subject can.
 */
export async function requireActive(
  deps: CpDeps,
  p: TokenClaims,
  t: { doc: TemplateDoc; build: TemplateBuild },
  activate: boolean,
  mayActivate = true,
): Promise<void> {
  if (hostViews(deps).length === 0 && !deps.config.templateHosts?.length) return;
  // A build imported from SH_SANDBOX_TEMPLATES is the deployment's to run, never a host's: no gate,
  // as on a deployment without host agents.
  if (!hostManaged(t.build)) return;
  let facts = await readinessFacts(deps);
  const readiness = readinessOf(t.build, facts.nowS, facts.placement, facts.attached);
  if (readiness === 'active') return;
  let now = readiness;
  // A caller that already holds a live lease on the build (a retry of its own first use, say) is
  // only told to wait: no renewal and no new `activate` record on every retry.
  const leased = liveLeases(t.build, facts.nowS).some((l) => l.subject === p.sub);
  if (activate && !mayActivate && !leased && readiness !== 'activating') {
    throw new CpError(
      'not_enrolled',
      `template '${t.doc.id}' is ${readiness}, and this account (${p.sub}) is not enrolled in the ` +
        'sandbox service, so it cannot activate it: an enrolled user must activate it first',
      undefined,
      { readiness },
    );
  }
  if (
    activate &&
    mayActivate &&
    !leased &&
    (readiness === 'inactive' || readiness === 'deactivating' || readiness === 'activating')
  ) {
    // Refusals (no_active_slot, quota_exceeded, template_unavailable) answer as they would to activate.
    const lease = await takeLease(deps, p, t.doc, t.build, undefined, 'first_use');
    // Register G43: a build in its idle grace has its worker attached, and the lease keeps it there
    // (placement prefers the host running it): it serves now, with no wait.
    const graced = facts.placement?.graced.get(t.build.buildId);
    if (graced && lease.host === graced.host && readiness === 'deactivating') return;
    now = 'activating';
    // The lease may have placed it just now: its start line is read after it (register G43).
    if (readiness !== 'activating') facts = await readinessFacts(deps);
  }
  // Register G43: on a host whose agent reports its start limit and time, the wait its place in the
  // host's start line implies; else FIRST_USE_RETRY_S, as before.
  const line = now === 'activating' ? facts.queue?.byBuild.get(t.build.buildId) : undefined;
  const estimate = line
    ? startRetryAfterS(
        line,
        facts.hosts?.find((h) => h.id === line.host),
      )
    : null;
  throw new CpError(
    'template_not_active',
    activate
      ? `template '${t.doc.id}' is ${now}; its activation has started: retry after the wait`
      : `template '${t.doc.id}' is ${now}; activate it (POST /v1/templates/${t.doc.id}/activate) or retry without activate: false`,
    undefined,
    {
      readiness: now,
      ...(now === 'unavailable' && facts.placement?.unplaced.get(t.build.buildId)
        ? { reason: facts.placement.unplaced.get(t.build.buildId)! }
        : {}),
    },
    estimate ?? FIRST_USE_RETRY_S,
  );
}

/**
 * A quota write's body (§5.2): exactly `templates`, `buildsQueued` and `active`, returned as a new
 * object of those three, so nothing else the request carried reaches the policy. Their values are
 * policyProblems' to judge.
 */
function quotaBody(v: unknown): Policy['quota'] {
  const keys = ['templates', 'buildsQueued', 'active'] as const;
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new CpError('invalid_request', 'a quota is an object: templates, buildsQueued, active');
  const extra = Object.keys(v).filter((k) => !(keys as readonly string[]).includes(k));
  if (extra.length > 0)
    throw new CpError(
      'invalid_request',
      `a quota holds only templates, buildsQueued, active (not ${extra.join(', ')})`,
    );
  const o = v as Record<string, unknown>;
  return {
    templates: o.templates,
    buildsQueued: o.buildsQueued,
    active: o.active,
  } as Policy['quota'];
}

/** Whether two quotas (or two absent overrides, null) hold the same three counters. */
const sameQuota = (a: Policy['quota'] | null, b: Policy['quota'] | null): boolean =>
  a === null || b === null
    ? a === b
    : a.templates === b.templates && a.buildsQueued === b.buildsQueued && a.active === b.active;

export const SANDBOX_HANDLERS: Record<string, Handler> = {
  activateTemplate: activate,
  deactivateTemplate: deactivate,

  createTemplate: (ctx, deps) => createBuild(ctx, deps, false),

  createTemplateBuild: (ctx, deps) => createBuild(ctx, deps, true),
  cancelTemplateBuild: cancelBuild,
  retireTemplate,
  retireTemplateBuild,
  moveTemplateTags,
  removeTemplateTag,
  rejectTemplateBuild,
  updateTemplate,
  transferTemplateOwner,

  getPolicy: async (ctx, deps) => {
    requireReader(ctx, deps.config);
    if (!deps.policy)
      throw new CpError(
        'invalid_request',
        'this deployment does not store templates (SH_PROVENANCE_DIR is unset)',
      );
    const { policy, record } = await deps.policy.current();
    return { status: 200, body: { policy, digest: policyDigest(policy), record } };
  },

  /**
   * Admin quotas (§5.2): `PUT /v1/quota/default` sets the deployment default, `PUT
   * /v1/quota/{subject}` one subject's override; a body of `null` for a subject removes its
   * override. Each is a policy change: a new `policy` record (the whole policy, as `PUT /v1/policy`
   * writes), so the chain shows who set which quota when.
   */
  putQuota: async (ctx, deps) => {
    const p = requireEnrolled(ctx, deps);
    if (!isAdmin(p)) throw new CpError('forbidden', 'setting quotas requires the admin role');
    if (!deps.policy)
      throw new CpError(
        'invalid_request',
        'this deployment does not store templates (SH_PROVENANCE_DIR is unset)',
      );
    const subject = ctx.params.subject ?? '';
    const isDefault = subject === 'default';
    if (!isDefault && !MEMBER_SUBJECT_RE.test(subject))
      throw new CpError(
        'invalid_request',
        `the quota's target is 'default' or a subject, ${MEMBER_SUBJECT_FORMS}`,
      );
    // Stored as the three counters alone: a key beyond them is refused, never kept in the policy.
    const body = ctx.body === null ? null : quotaBody(ctx.body);
    // A compare-and-set (`?expect=`, JSON: the quota the client read, null for no override): the
    // write is made only if the target's quota is that value now, else 409 quota_changed with
    // nothing written, so another admin's change in between is never overwritten unseen.
    const expectRaw = ctx.query.get('expect');
    let expected: Policy['quota'] | null | undefined;
    if (expectRaw !== null) {
      let v: unknown;
      try {
        v = JSON.parse(expectRaw);
      } catch {
        throw new CpError('invalid_request', 'expect must be a quota, or null, as JSON');
      }
      expected = v === null ? null : quotaBody(v);
      if (
        expected !== null &&
        ![expected.templates, expected.buildsQueued, expected.active].every(
          (n) => Number.isSafeInteger(n) && n >= 0,
        )
      )
        throw new CpError('invalid_request', 'expect must hold whole numbers, as a quota does');
    }
    // The read, the change and the write are one step of the policy store (update), so a quota or
    // policy another admin writes meanwhile is never dropped by this write.
    let before: unknown;
    let next!: Policy;
    const { record } = await deps.policy.update((cur) => {
      next = { ...cur, quotaBySubject: { ...(cur.quotaBySubject ?? {}) } };
      if (isDefault) {
        before = cur.quota;
        next.quota = body as Policy['quota'];
      } else {
        before = cur.quotaBySubject?.[subject] ?? null;
        if (body === null) delete next.quotaBySubject![subject];
        else next.quotaBySubject![subject] = body as Policy['quota'];
      }
      if (expected !== undefined && !sameQuota(before as Policy['quota'] | null, expected))
        throw new CpError(
          'quota_changed',
          `${subject}'s quota changed since it was read: nothing written; read it again, then write`,
        );
      if (Object.keys(next.quotaBySubject!).length === 0) delete next.quotaBySubject;
      const bad = policyProblems(next);
      if (bad.length) throw new CpError('invalid_request', bad.join('; '));
      return next;
    }, p.sub);
    await auditBestEffort(deps, 'quota_set', subject, { subject: p.sub, decision: 'quota_set' });
    return {
      status: 200,
      body: {
        target: subject,
        subject: p.sub,
        quota: isDefault ? next.quota : (next.quotaBySubject?.[subject] ?? null),
        before,
        policy: policyDigest(next),
        record,
      },
    };
  },

  putPolicy: async (ctx, deps) => {
    const p = requireEnrolled(ctx, deps);
    if (!isAdmin(p)) throw new CpError('forbidden', 'setting the policy requires the admin role');
    if (!deps.policy)
      throw new CpError(
        'invalid_request',
        'this deployment does not store templates (SH_PROVENANCE_DIR is unset)',
      );
    const bad = policyProblems(ctx.body);
    if (bad.length) throw new CpError('invalid_request', bad.join('; '));
    // G41 (c), the user's Q4 (i): a record whose trust this removes narrows its deployment-visible
    // templates to private on read. Name each narrowed build in the policy record, so nothing is
    // silent. The policy itself is what the admin sent, every field kept as sent.
    const before = new Set((await deps.policy.current()).policy.trustedGateRecords);
    const after = new Set((ctx.body as Policy).trustedGateRecords);
    const narrowed: { template: string; buildId: string }[] = [];
    if ([...before].some((g) => !after.has(g)) && deps.templates)
      for (const d of await deps.templates.list())
        if (effectiveVisibility(d, before) === 'deployment')
          for (const x of d.builds)
            if (
              x.status === 'registered' &&
              attestationOf(x, before) === 'deployment' &&
              attestationOf(x, after) === 'self'
            )
              narrowed.push({ template: d.id, buildId: x.buildId });
    const { policy, record } = await deps.policy.set(
      ctx.body as Policy,
      p.sub,
      narrowed.length ? { narrowed } : undefined,
    );
    await auditBestEffort(deps, 'policy_set', 'policy', { subject: p.sub, decision: 'policy_set' });
    return {
      status: 200,
      body: {
        policy,
        digest: policyDigest(policy),
        record,
        ...(narrowed.length ? { narrowed } : {}),
      },
    };
  },

  getQuota: async (ctx, deps) => {
    const p = requireReader(ctx, deps.config);
    const { cat, policy } = writable(deps);
    const { policy: pol } = await policy.current();
    const u = await usage(cat, p.sub);
    const nowS = seconds(deps);
    // Builds this subject holds a live lease on (§6.3), as activate counts them.
    const active = (await cat.list())
      .flatMap((d) => d.builds)
      .filter((x) => liveLeases(x, nowS).some((l) => l.subject === p.sub)).length;
    // SBX0's live-sandbox cap (register G27): shown where it applies, so a client sees it before
    // a create is refused by it.
    let sandboxes: { limit: number; used: number } | undefined;
    if (deps.config.sandbox && deps.sandboxes) {
      const live = (await deps.sandboxes.listByOwner(p.sub, nowS)).filter((r) => isLive(r, nowS));
      sandboxes = { limit: deps.config.sandbox.maxPerSubject, used: live.length };
    }
    return {
      status: 200,
      body: {
        subject: p.sub,
        templates: { limit: quotaFor(pol, p.sub).templates, used: u.templates },
        buildsQueued: { limit: quotaFor(pol, p.sub).buildsQueued, used: u.buildsQueued },
        active: { limit: quotaFor(pol, p.sub).active, used: active },
        // Whether this subject has an admin-set quota (§5.2) or the deployment default.
        quotaSource: pol.quotaBySubject?.[p.sub] ? 'subject' : 'default',
        ...(sandboxes ? { sandboxes } : {}),
      },
    };
  },

  listTemplates: async (ctx, deps) => {
    const p = requireReader(ctx, deps.config);
    const docs = await visibleTemplates(deps, p);
    const live = await readinessFacts(deps);
    // The worker id is deployment plumbing; a client names a template, never a worker.
    const templates = docs.map((d) => templateBody(d, live, false));
    // Per-host limits and use (§4, §6.2) are reported by the host agent (§6.1), not built yet:
    // an empty list means "no host reports", never "no limit".
    return { status: 200, body: { templates, hosts: hostsBlock(deps, live) } };
  },

  listTemplateTags: async (ctx, deps) => {
    const p = requireReader(ctx, deps.config);
    const d = await visibleTemplate(deps, p, ctx.params.id ?? '');
    const tags = Object.entries(d.tags)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([tag, buildId]) => {
        const m = d.tagsMeta && Object.hasOwn(d.tagsMeta, tag) ? d.tagsMeta[tag] : undefined;
        return { tag, buildId, assignedAt: m?.at ?? d.createdAt, assignedBy: m?.by ?? d.owner };
      });
    return { status: 200, body: { tags } };
  },

  getTemplate: async (ctx, deps) => {
    const p = requireReader(ctx, deps.config);
    const d = await visibleTemplate(deps, p, ctx.params.id ?? '');
    return { status: 200, body: templateBody(d, await readinessFacts(deps), true) };
  },

  listTemplateBuilds: async (ctx, deps) => {
    const p = requireReader(ctx, deps.config);
    const d = await visibleTemplate(deps, p, ctx.params.id ?? '');
    const live = await readinessFacts(deps);
    return { status: 200, body: { builds: d.builds.map((b) => buildBody(d, b, live, true)) } };
  },

  getTemplateBuild: async (ctx, deps) => {
    const p = requireReader(ctx, deps.config);
    const d = await visibleTemplate(deps, p, ctx.params.id ?? '');
    // By build id, or by the handle the create answered (§4: it keeps resolving once the build is
    // registered and its id becomes the manifest hash); the body's buildId is the real id.
    const ref = ctx.params.build ?? '';
    const b = d.builds.find((x) => x.buildId === ref || x.handle === ref);
    if (!b) throw new CpError('template_not_found', 'no such build of this template');
    return { status: 200, body: buildBody(d, b, await readinessFacts(deps), true) };
  },

  createSandbox: async (ctx, deps) => {
    const p = requireEnrolled(ctx, deps);
    const { cfg, store } = service(deps);
    const b = asRecord(ctx.body);
    if (typeof b.template !== 'string')
      throw new CpError('invalid_request', 'template is required');
    if (b.activate !== undefined && typeof b.activate !== 'boolean')
      throw new CpError('invalid_request', 'activate must be true or false');
    const template = await resolveForUse(deps, p, b.template);
    if (b.name !== undefined && (typeof b.name !== 'string' || !NAME_RE.test(b.name))) {
      throw new CpError('invalid_request', `name must match ${NAME_RE}`);
    }
    const labels = parseLabels(b.labels);
    await requireActive(deps, p, template, b.activate !== false);
    const now = seconds(deps);
    const id = sandboxId(deps.newId());
    // Create does no I/O to the worker: the first Exec creates the workspace, and wsk being the
    // sandbox's own id is what makes a new sandbox always start empty (spec §5.1).
    const rec: SandboxRecord = {
      id,
      owner: p.sub,
      tenant: p.tenant,
      name: (b.name as string | undefined) ?? '',
      template: template.id,
      worker: template.worker,
      buildId: template.buildId,
      wsk: id,
      labels,
      createdAt: now,
      expiresAt: now + cfg.lifetimeS,
    };
    // Stored under the template's use lock, after one last read of the build's status, so a
    // retire or reject racing this create either sees it live or is seen by it (createUnlessEnded).
    const outcome = await createUnlessEnded(deps, template, () =>
      store.create(
        rec,
        { perSubject: cfg.maxPerSubject, total: cfg.maxTotal, retentionS: cfg.retentionS },
        now,
      ),
    );
    if (outcome === 'quota_subject') {
      throw new CpError('quota_exceeded', `at most ${cfg.maxPerSubject} live sandboxes per user`);
    }
    if (outcome === 'quota_total') {
      throw new CpError('quota_exceeded', 'the sandbox service is at capacity');
    }
    if (outcome === 'name_conflict') {
      throw new CpError('name_conflict', `you already have a live sandbox named '${rec.name}'`);
    }
    await audit(deps, p.sub, id, 'sandbox_created');
    // The sandbox on its build's chain (§7.1): its lease is the caller's live lease on the build, as
    // the digest of the activate record that granted it (null: no lease, e.g. no host agents).
    if (deps.provenance) {
      const live = (template.build.leases ?? []).find((l) => l.subject === p.sub && l.until > now);
      await deps.provenance.append({
        stream: `template/${template.id}`,
        kind: 'sandbox',
        subject: p.sub,
        body: {
          sandboxId: id,
          buildId: template.buildId,
          templateManifestHash: template.build.status === 'registered' ? template.buildId : null,
          lease: live?.record ?? null,
          state: 'created',
          expiresAt: rec.expiresAt,
        },
      });
    }
    return { status: 201, body: sandboxBody(viewOf(rec, now)) };
  },

  listSandboxes: async (ctx, deps) => {
    const p = requireEnrolled(ctx, deps);
    const { store } = service(deps);
    // Presence, not value, is what needs the role (RouteSpec.adminOnlyQuery), as with ?owner=.
    const all = ctx.query.get('all');
    if (all !== null && !isAdmin(p))
      throw new CpError('forbidden', '?all= requires the admin role');
    if (all !== null && all !== '1') throw new CpError('invalid_request', "all must be '1'");
    const state = ctx.query.get('state');
    if (state !== null && state !== 'ready' && state !== 'terminated') {
      throw new CpError('invalid_request', "state must be 'ready' or 'terminated'");
    }
    const now = seconds(deps);
    const recs = all ? await store.listAll(now) : await store.listByOwner(p.sub, now);
    const sandboxes = recs
      .map((r) => viewOf(r, now))
      .filter((v) => state === null || v.state === state)
      .map(sandboxBody);
    return { status: 200, body: { sandboxes } };
  },

  getSandbox: async (ctx, deps) => {
    const rec = await assertSandboxOwner(ctx, deps, { admin: true });
    return { status: 200, body: sandboxBody(viewOf(rec, seconds(deps))) };
  },

  deleteSandbox: async (ctx, deps) => {
    const rec = await assertSandboxOwner(ctx, deps, { admin: true });
    const { cfg, store } = service(deps);
    const now = seconds(deps);
    const outcome = await store.markDeleted(rec.id, now, cfg.retentionS);
    // Retention ran out between the read and the delete: it is gone, as it would read now.
    if (outcome === 'not_found') throw new CpError('sandbox_not_found', 'no such sandbox');
    if (outcome === 'deleted') {
      await audit(deps, ctx.principal!.sub, rec.id, 'sandbox_deleted');
      // The egress log is kept as long as the record, whose retention now runs from the delete.
      await deps.egress?.expireAt(rec.id, now + cfg.retentionS);
      await sandboxEnded(deps, rec, ctx.principal!.sub, 'deleted', now);
    }
    // Idempotent: a second delete, or a delete after expiry, reports how it actually ended.
    const ended = viewOf(outcome === 'deleted' ? { ...rec, deletedAt: now } : rec, now);
    return {
      status: 200,
      body: { id: rec.id, state: 'terminated', reason: ended.reason ?? 'deleted' },
    };
  },

  /**
   * A sandbox's egress log, for whoever may read the sandbox (GET /v1/sandboxes/{id}):
   * `{events, next, summary}` a page at a time (`after` is the last page's `next`; `summary` on the
   * first page, null after it), or with
   * `format=ndjson` the whole log, whose sha256 is `summary.sha256` and the end record's.
   */
  getSandboxEgress: async (ctx, deps) => {
    const rec = await assertSandboxOwner(ctx, deps, { admin: true });
    if (!deps.egress) throw new CpError('internal_error', 'the egress log is not configured');
    const format = ctx.query.get('format');
    if (format !== null && format !== 'json' && format !== 'ndjson')
      throw new CpError('invalid_request', "format must be 'json' or 'ndjson'");
    if (format === 'ndjson') {
      let out = '';
      for await (const line of allLines(deps.egress, rec.id)) out += `${line}\n`;
      return { status: 200, body: out, contentType: 'application/x-ndjson' };
    }
    const after = ctx.query.get('after');
    if (after !== null && !ENTRY_ID_RE.test(after))
      throw new CpError('invalid_request', "after must be a page's next");
    const rawLimit = ctx.query.get('limit');
    const limit = rawLimit === null ? 100 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new CpError('invalid_request', 'limit must be 1-1000');
    const page = await deps.egress.page(rec.id, after, limit);
    return {
      status: 200,
      body: {
        events: page.map((e) => JSON.parse(e.line) as unknown),
        next: page.length === limit ? page[page.length - 1]!.id : null,
        // On the first page only: the summary reads the whole log, so a page after it (`after`)
        // costs that page alone, and paging a log through is linear in its length.
        summary: after === null ? await summarize(deps.egress, rec.id) : null,
      },
    };
  },

  mintSandboxToken: async (ctx, deps) => {
    const rec = await assertSandboxOwner(ctx, deps, { admin: false });
    const { cfg } = service(deps);
    const now = seconds(deps);
    const v = viewOf(rec, now);
    // Expiry is computed (spec §5.2): a sandbox past its expiresAt refuses here with no job run.
    if (v.state === 'terminated') {
      const reason = v.reason ?? 'expired';
      const why = reason === 'deleted' ? 'sandbox was deleted' : 'sandbox has expired';
      throw new CpError('sandbox_terminated', why, undefined, { reason });
    }
    const { token, exp } = mintSandboxToken(deps.signer, {
      sub: rec.owner,
      tenant: rec.tenant,
      sbx: rec.id,
      wrk: rec.worker,
      wsk: rec.wsk,
      ttlSeconds: cfg.tokenTtlS,
      notAfter: rec.expiresAt,
      iss: cfg.issuer,
      now,
    });
    return {
      status: 200,
      body: {
        token,
        expiresAt: exp,
        execEndpoint: cfg.execEndpoint,
        wrk: rec.worker,
        wsk: rec.wsk,
        execCa: cfg.execCa ?? null,
      },
    };
  },

  /**
   * The host janitor's read (spec §8.3): every live sandbox, and every terminated one still
   * retained, with only what it needs to find a workspace tree. The router admits only the
   * SH_JANITOR_TOKEN bearer; a handler reached without that mark is a routing bug.
   */
  janitorSandboxes: async (ctx, deps) => {
    if (!ctx.janitorAuthorized) throw new CpError('unauthorized', 'janitor authentication failed');
    const { store } = service(deps);
    const now = seconds(deps);
    const live: { wsk: string; wrk: string }[] = [];
    const terminated: { wsk: string; wrk: string; terminatedAt: number }[] = [];
    const all = await store.listAll(now);
    for (const rec of all) {
      const v = viewOf(rec, now);
      if (v.state === 'ready') live.push({ wsk: v.wsk, wrk: v.worker });
      else terminated.push({ wsk: v.wsk, wrk: v.worker, terminatedAt: v.terminatedAt! });
    }
    await recordExpiries(deps, all, now);
    await sealEgress(deps, all, now);
    return { status: 200, body: { live, terminated } };
  },
};
