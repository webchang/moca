import { CpError } from './errors.js';
import {
  asRecord,
  auditBestEffort,
  isAdmin,
  requireEnrolledPrincipal,
  requireReader,
  seconds,
} from './handler-util.js';
import type { CpDeps, Handler, RequestCtx } from './handlers.js';
import type { SandboxConfig } from './sandbox-config.js';
import { canonicalJson, type ProvenanceStore } from './provenance.js';
import { liveLeases, place, readinessOf, type HostView, type Placement } from './activation.js';
import {
  checkCreate,
  policyDigest,
  policyProblems,
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

const canSee = (d: TemplateDoc, p: TokenClaims): boolean =>
  d.visibility === 'deployment' || d.owner === p.sub || isAdmin(p);

async function visibleTemplates(deps: CpDeps, p: TokenClaims): Promise<TemplateDoc[]> {
  return (await catalog(deps).list()).filter((d) => canSee(d, p));
}

/** 404 for a template the caller cannot see, as for one that does not exist (no existence oracle). */
async function visibleTemplate(deps: CpDeps, p: TokenClaims, id: string): Promise<TemplateDoc> {
  const d = await catalog(deps).get(id);
  if (!d || !canSee(d, p)) throw new CpError('template_not_found', 'no such template');
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
  nowS: number;
}

/** The hosts as their agents last reported (§6.1), for placement and the hosts block. */
function hostViews(deps: CpDeps): HostView[] {
  return (deps.hosts?.all() ?? []).map(([id, h]) => ({
    id,
    holds: h.holds,
    activeLimit: h.limits.activeLimit,
  }));
}

async function readinessFacts(deps: CpDeps, docs?: TemplateDoc[]): Promise<ReadinessFacts> {
  const nowS = seconds(deps);
  const hosts = hostViews(deps);
  const placement =
    hosts.length > 0 ? place(docs ?? (await catalog(deps).list()), hosts, nowS) : null;
  let attached: Map<string, number> | null = null;
  if (deps.presence) {
    try {
      attached = new Map((await deps.presence.list()).map((r) => [r.sandboxId, r.capacityMax]));
    } catch {
      // Presence unreadable: readiness is unknown, not inactive (a client must not act on a guess).
      attached = null;
    }
  }
  if ((deps.config.routeProfile ?? 'harness') === 'harness' || !deps.sandboxes) {
    return { attached, inUse: null, lastUsed: null, placement, nowS };
  }
  const inUse = new Map<string, number>();
  const lastUsed = new Map<string, number>();
  const now = seconds(deps);
  for (const r of await deps.sandboxes.listAll(now)) {
    if (isLive(r, now)) inUse.set(r.worker, (inUse.get(r.worker) ?? 0) + 1);
    lastUsed.set(r.worker, Math.max(lastUsed.get(r.worker) ?? 0, r.createdAt));
  }
  return { attached, inUse, lastUsed, placement, nowS };
}

function buildBody(d: TemplateDoc, b: TemplateBuild, f: ReadinessFacts, full: boolean) {
  const readiness =
    b.status === 'retired'
      ? 'retired'
      : b.status !== 'registered'
        ? null
        : readinessOf(b, f.nowS, f.placement, f.attached);
  return {
    buildId: b.buildId,
    status: b.status,
    profile: b.profile,
    readiness,
    capacity:
      readiness === 'active'
        ? {
            running: f.attached?.get(b.worker) ?? 0,
            inUse: f.inUse === null ? null : (f.inUse.get(b.worker) ?? 0),
          }
        : null,
    lastUsedAt: f.lastUsed === null ? null : (f.lastUsed.get(b.worker) ?? null),
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
    ...(full ? { spec: b.spec } : {}),
  };
}

function templateBody(d: TemplateDoc, f: ReadinessFacts, full: boolean) {
  const def = resolveBuild(d, {});
  return {
    id: d.id,
    description: d.description,
    tools: def?.spec.tools ?? [],
    owner: d.owner,
    visibility: d.visibility,
    onboarding: d.builds.some((b) => b.status === 'registered')
      ? 'registered'
      : (d.builds[0]?.status ?? null),
    readiness: def ? buildBody(d, def, f, false).readiness : null,
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

/** The quota counters for one subject (§6.2): templates owned, builds queued or building. */
async function usage(
  cat: TemplateCatalog,
  subject: string,
): Promise<{ templates: number; buildsQueued: number }> {
  let templates = 0;
  let buildsQueued = 0;
  for (const d of await cat.list()) {
    if (d.owner !== subject) continue;
    if (d.builds.some((b) => b.status !== 'retired')) templates++;
    buildsQueued += d.builds.filter((b) => b.status === 'queued' || b.status === 'building').length;
  }
  return { templates, buildsQueued };
}

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
  const { policy: pol, record: policyRecord } = await policy.current();
  const result = checkCreate(
    {
      id,
      image: typeof b.image === 'string' ? b.image : '',
      spec,
      ...(typeof b.profile === 'string' ? { profile: b.profile } : {}),
      ...(gateRecordBytes ? { gateRecordBytes } : {}),
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
    // A refusal of a well-formed id is recorded on its template's stream; an id the rule refuses
    // has no stream to record on, and is only answered.
    if (TEMPLATE_ID_RE.test(id))
      await prov.append({ stream, kind: 'check', subject: 'policy', body: checkBody });
    const f = result.failed!;
    throw new CpError('policy_refused', f.message ?? f.rule, undefined, { rule: f.rule });
  }
  const now = seconds(deps);
  const handle = buildHandle(deps.newId());
  const quota = pol.quota;
  const want = reuseKey(b.image as string, spec, result.profile, result.gateRecordSha256);
  let reused: TemplateBuild | undefined;
  const doc = await cat.update(id, async (cur) => {
    if (existing && !cur) throw new CpError('template_not_found', 'no such template');
    if (cur && cur.owner !== p.sub && !(existing && isAdmin(p))) {
      // 404 for a private template, 409 for a visible one: never an existence oracle for private.
      throw cur.visibility === 'private' && !isAdmin(p)
        ? new CpError('template_not_found', 'no such template')
        : new CpError('template_exists', `template '${id}' belongs to another subject`);
    }
    // §3.2: the same inputs are the same build. One registered, or still on its way there, is
    // answered instead of a second build (register G21: a duplicate create queued one, and both
    // registered under one manifest hash).
    reused = cur?.builds.find(
      (x) => REUSABLE.has(x.status) && buildReuseKey(x) === want && stillHeld(deps, x),
    );
    if (reused) return cur!;
    const u = await usage(cat, p.sub);
    if (!cur && u.templates >= quota.templates) {
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
        // A round trip through JSON: what the client sent, as the wire carries it (no undefined).
        spec: JSON.parse(JSON.stringify(spec)) as Record<string, unknown>,
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
          source: pol.trustedGateRecords.includes(result.gateRecordSha256) ? 'trusted' : 'client',
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
      spec: buildSpec(spec),
      createdAt: now,
      queuedAtMs: deps.now(),
      provenance: created.digest,
      request: {
        image: b.image as string,
        spec: JSON.parse(JSON.stringify(spec)) as Record<string, unknown>,
        ...(result.gateRecordSha256 ? { gateRecordSha256: result.gateRecordSha256 } : {}),
      },
    };
    const base: TemplateDoc = cur ?? {
      schema: TEMPLATE_DOC_SCHEMA,
      id,
      owner: p.sub,
      visibility: (b.visibility as 'private' | 'deployment' | undefined) ?? 'deployment',
      description: String(spec.description ?? ''),
      tags: {},
      builds: [],
      createdAt: now,
    };
    return { ...base, builds: [build, ...base.builds] };
  });
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
  const guest = n(spec.guest_mb ?? spec.guest_ram_mb);
  return {
    ...(guest !== undefined ? { guest_mb: guest } : {}),
    ...(n(spec.vcpus) !== undefined ? { vcpus: n(spec.vcpus) } : {}),
    ...(n(spec.workspace_mb) !== undefined ? { workspace_mb: n(spec.workspace_mb) } : {}),
    ...(typeof spec.seed === 'string' ? { seed: spec.seed } : {}),
    tools: Array.isArray(spec.tools) ? (spec.tools as string[]) : [],
  };
}

/** Per host: its limits, its use (builds placed on it now) and its disk (§4, §6.2). */
function hostsBlock(deps: CpDeps, f: ReadinessFacts) {
  const used = new Map<string, number>();
  for (const h of f.placement?.placed.values() ?? []) used.set(h, (used.get(h) ?? 0) + 1);
  return (deps.hosts?.all() ?? []).map(([id, h]) => ({
    id,
    active: { limit: h.limits.activeLimit, used: used.get(id) ?? 0 },
    idleLimitSeconds: h.limits.idleLimitSeconds,
    disk: { freeGb: h.limits.diskFreeGb, floorGb: h.limits.diskFloorGb },
  }));
}

/**
 * Activate (§5.1, §6.3): take or renew this subject's lease on a registered build, `leaseSeconds`
 * long (default the host's idleLimit, at most a day per grant, renewals unlimited). Refused with
 * template_unavailable when no host holds it, no_active_slot (Retry-After) when every holder is
 * full, quota_exceeded over the subject's active quota; on a refusal the lease is not kept.
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
  const r = await takeLease(deps, p, d0, target, b.leaseSeconds, 'owner');
  return {
    status: 200,
    body: { templateId: d0.id, buildId: target.buildId, leaseUntil: r.until, host: r.host },
  };
}

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
  const { cat, policy, prov } = writable(deps);
  const nowS = seconds(deps);
  const DAY = 86_400;
  const hosts = hostViews(deps);
  const defaultLease =
    Math.max(...hosts.map((h) => deps.hosts!.get(h.id)!.limits.idleLimitSeconds), 0) || 3600;
  const want =
    typeof leaseSeconds === 'number' && Number.isSafeInteger(leaseSeconds)
      ? leaseSeconds
      : defaultLease;
  if (want < 60 || want > DAY)
    throw new CpError('invalid_request', 'leaseSeconds must be 60-86400 (renew to hold longer)');
  const { policy: pol } = await policy.current();
  const docs = await cat.list();
  const held = docs
    .flatMap((d) => d.builds)
    .filter(
      (x) => x.buildId !== target.buildId && liveLeases(x, nowS).some((l) => l.subject === p.sub),
    );
  if (held.length >= pol.quota.active) {
    throw new CpError(
      'quota_exceeded',
      `at most ${pol.quota.active} active templates per subject`,
      undefined,
      { quota: 'active' },
    );
  }
  const withLease = (x: TemplateBuild): TemplateBuild => {
    const others = (x.leases ?? []).filter((l) => l.subject !== p.sub && l.until > nowS);
    const mine = (x.leases ?? []).find((l) => l.subject === p.sub && l.until > nowS);
    return {
      ...x,
      leases: [...others, { subject: p.sub, until: nowS + want, since: mine?.since ?? nowS }],
    };
  };
  // Would it be placed? Judge with this lease added, before keeping it.
  const trial = docs.map((d) =>
    d.id !== d0.id
      ? d
      : { ...d, builds: d.builds.map((x) => (x.buildId === target.buildId ? withLease(x) : x)) },
  );
  const pl = place(trial, hosts, nowS);
  if (hosts.length > 0 && pl.unplaced.get(target.buildId) === 'not_held') {
    throw new CpError('template_unavailable', "no host holds this build's snapshot", undefined, {
      readiness: 'unavailable',
    });
  }
  if (pl.unplaced.get(target.buildId) === 'no_slot') {
    const free = Math.min(
      ...trial
        .flatMap((d) => d.builds)
        .flatMap((x) => liveLeases(x, nowS).map((l) => l.until - nowS)),
    );
    throw new CpError(
      'no_active_slot',
      'every host holding this build is at its active limit with leased builds',
      undefined,
      {
        readiness: 'unavailable',
      },
      Number.isFinite(free) ? Math.max(1, free) : 60,
    );
  }
  await cat.update(d0.id, async (cur) => ({
    ...cur!,
    builds: cur!.builds.map((x) => (x.buildId === target.buildId ? withLease(x) : x)),
  }));
  await prov.append({
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
  return { until: nowS + want, host: pl.placed.get(target.buildId) ?? null };
}

/** Deactivate (§5.1): drop this subject's lease; the build stays wanted while others hold it. */
async function deactivate(ctx: RequestCtx, deps: CpDeps) {
  const p = requireEnrolled(ctx, deps);
  const { cat, prov } = writable(deps);
  const d0 = await visibleTemplate(deps, p, ctx.params.id ?? '');
  const b = asRecord(ctx.body);
  const nowS = seconds(deps);
  const all = isAdmin(p) && b.all === true;
  let dropped = 0;
  await cat.update(d0.id, async (cur) => ({
    ...cur!,
    builds: cur!.builds.map((x) => {
      const keep = (x.leases ?? []).filter((l) => l.until > nowS && !(all || l.subject === p.sub));
      dropped += (x.leases ?? []).filter((l) => l.until > nowS).length - keep.length;
      return { ...x, leases: keep };
    }),
  }));
  if (dropped > 0) {
    await prov.append({
      stream: `template/${d0.id}`,
      kind: 'deactivate',
      subject: p.sub,
      body: { leases: dropped, all },
    });
  }
  return { status: 200, body: { templateId: d0.id, released: dropped } };
}

/** The statuses an owner may cancel (§5.1): not yet built. */
const CANCELLABLE = new Set<TemplateBuild['status']>(['queued', 'building', 'probing']);

/**
 * Cancel (§5.1, register G22): the owner (or an admin) withdraws a build not yet built; it becomes
 * `failed` with step `cancelled`, and a `build` record says who cancelled it. A host agent still
 * building it has its later reports refused (a failed build takes none), so it never registers.
 */
async function cancelBuild(ctx: RequestCtx, deps: CpDeps) {
  const p = requireEnrolled(ctx, deps);
  const { cat, prov } = writable(deps);
  const d0 = await visibleTemplate(deps, p, ctx.params.id ?? '');
  if (d0.owner !== p.sub && !isAdmin(p))
    throw new CpError('forbidden', "only the template's owner cancels its builds");
  const ref = ctx.params.build ?? '';
  let cancelled: TemplateBuild | undefined;
  await cat.update(d0.id, async (cur) => {
    const x = cur!.builds.find((y) => y.handle === ref || y.buildId === ref);
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
    return { ...cur!, builds: cur!.builds.map((y) => (y === x ? cancelled! : y)) };
  });
  await prov.append({
    stream: `template/${d0.id}`,
    kind: 'build',
    subject: p.sub,
    body: { handle: cancelled!.handle ?? cancelled!.buildId, outcome: 'cancelled' },
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
async function retireBuilds(
  ctx: RequestCtx,
  deps: CpDeps,
  which: (b: TemplateBuild) => boolean,
): Promise<{
  templateId: string;
  subject: string;
  builds: { build: string; buildId: string | null; readiness: 'retired'; record: string | null }[];
}> {
  const p = requireEnrolled(ctx, deps);
  const { cat, prov } = writable(deps);
  const d0 = await visibleTemplate(deps, p, ctx.params.id ?? '');
  if (d0.owner !== p.sub && !isAdmin(p))
    throw new CpError('forbidden', "only the template's owner, or an admin, retires it");
  const reason = asRecord(ctx.body).reason;
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1024))
    throw new CpError('invalid_request', 'reason must be a string of at most 1024 characters');
  const nowS = seconds(deps);
  const busy = new Set<string>();
  if (deps.sandboxes) {
    for (const r of await deps.sandboxes.listAll(nowS)) if (isLive(r, nowS)) busy.add(r.worker);
  }
  // A Moca Pi session pinned to the build is live use too: its next turn needs the worker. Read
  // before the catalog update, so no session lookup runs inside it.
  const pinned = new Set<string>();
  if (deps.index?.hasActiveSessionOnBuild) {
    for (const x of d0.builds.filter(which)) {
      if (x.status !== 'retired' && (await deps.index.hasActiveSessionOnBuild(x.buildId)))
        pinned.add(x.buildId);
    }
  }
  const done: TemplateBuild[] = [];
  await cat.update(d0.id, async (cur) => {
    const targets = cur!.builds.filter(which);
    if (targets.length === 0)
      throw new CpError('template_not_found', 'no such build of this template');
    const inUse = targets.find((x) => x.status !== 'retired' && x.worker && busy.has(x.worker));
    if (inUse)
      throw new CpError(
        'build_in_use',
        `build ${inUse.handle ?? inUse.buildId} still serves a live sandbox: delete it, then retire`,
      );
    const held = targets.find((x) => x.status !== 'retired' && pinned.has(x.buildId));
    if (held)
      throw new CpError(
        'build_in_use',
        `build ${held.handle ?? held.buildId} is pinned by an active session: delete it, then retire`,
      );

    done.push(...targets.filter((x) => x.status !== 'retired'));
    return {
      ...cur!,
      builds: cur!.builds.map((x) =>
        done.includes(x) ? { ...x, status: 'retired' as const, leases: [] } : x,
      ),
    };
  });
  const records = new Map<TemplateBuild, string>();
  for (const x of done) {
    const rec = await prov.append({
      stream: `template/${d0.id}`,
      kind: 'retire',
      subject: p.sub,
      body: {
        build: x.handle ?? x.buildId,
        ...(x.status === 'registered' ? { buildId: x.buildId } : {}),
        from: x.status,
        ...(typeof reason === 'string' ? { reason } : {}),
      },
    });
    records.set(x, rec.digest);
  }
  if (done.length > 0)
    await auditBestEffort(deps, 'template_retired', d0.id, {
      subject: p.sub,
      decision: 'template_retired',
    });
  // What ties the answer to the trace (the client's request, 2026-11-06): each build, its id, its
  // readiness and the record written now (null for one already retired: no second record).
  const byHandle = new Map([...records].map(([x, d]) => [x.handle ?? x.buildId, d]));
  const after = (await cat.get(d0.id))!;
  return {
    templateId: d0.id,
    subject: p.sub,
    builds: after.builds
      .filter((x) => x.status === 'retired' && which(x))
      .map((x) => ({
        build: x.handle ?? x.buildId,
        buildId:
          x.handle && x.handle !== x.buildId && x.buildId.startsWith('b-') ? null : x.buildId,
        readiness: 'retired' as const,
        record: byHandle.get(x.handle ?? x.buildId) ?? null,
      })),
  };
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
  const b = d && canSee(d, p) ? resolveBuild(d, r) : null;
  // A retired build, or a template whose every build is retired, is gone, not unknown (§5.1).
  if (
    d &&
    canSee(d, p) &&
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
 * With hosts configured but none reported yet (a fresh deploy, a restart, a host down; register
 * G32), readiness is the worker's presence alone: an attached worker serves, and an absent one is
 * refused rather than left to wait at the relay.
 */
export async function requireActive(
  deps: CpDeps,
  p: TokenClaims,
  t: { doc: TemplateDoc; build: TemplateBuild },
  activate: boolean,
): Promise<void> {
  if (hostViews(deps).length === 0 && !deps.config.templateHosts?.length) return;
  const facts = await readinessFacts(deps);
  const readiness = readinessOf(t.build, facts.nowS, facts.placement, facts.attached);
  if (readiness === 'active') return;
  let now = readiness;
  if (
    activate &&
    (readiness === 'inactive' || readiness === 'deactivating' || readiness === 'activating')
  ) {
    // Refusals (no_active_slot, quota_exceeded, template_unavailable) answer as they would to activate.
    await takeLease(deps, p, t.doc, t.build, undefined, 'first_use');
    now = 'activating';
  }
  throw new CpError(
    'template_not_active',
    activate
      ? `template '${t.doc.id}' is ${now}; its activation has started: retry after the wait`
      : `template '${t.doc.id}' is ${now}; activate it (POST /v1/templates/${t.doc.id}/activate) or retry without activate: false`,
    undefined,
    { readiness: now },
    FIRST_USE_RETRY_S,
  );
}

export const SANDBOX_HANDLERS: Record<string, Handler> = {
  activateTemplate: activate,
  deactivateTemplate: deactivate,

  createTemplate: (ctx, deps) => createBuild(ctx, deps, false),

  createTemplateBuild: (ctx, deps) => createBuild(ctx, deps, true),
  cancelTemplateBuild: cancelBuild,
  retireTemplate,
  retireTemplateBuild,

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
    const { policy, record } = await deps.policy.set(ctx.body as Policy, p.sub);
    await auditBestEffort(deps, 'policy_set', 'policy', { subject: p.sub, decision: 'policy_set' });
    return { status: 200, body: { policy, digest: policyDigest(policy), record } };
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
        templates: { limit: pol.quota.templates, used: u.templates },
        buildsQueued: { limit: pol.quota.buildsQueued, used: u.buildsQueued },
        active: { limit: pol.quota.active, used: active },
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
        const m = d.tagsMeta?.[tag];
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
    const outcome = await store.create(
      rec,
      { perSubject: cfg.maxPerSubject, total: cfg.maxTotal, retentionS: cfg.retentionS },
      now,
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
    if (outcome === 'deleted') await audit(deps, ctx.principal!.sub, rec.id, 'sandbox_deleted');
    // Idempotent: a second delete, or a delete after expiry, reports how it actually ended.
    const ended = viewOf(outcome === 'deleted' ? { ...rec, deletedAt: now } : rec, now);
    return {
      status: 200,
      body: { id: rec.id, state: 'terminated', reason: ended.reason ?? 'deleted' },
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
    for (const rec of await store.listAll(now)) {
      const v = viewOf(rec, now);
      if (v.state === 'ready') live.push({ wsk: v.wsk, wrk: v.worker });
      else terminated.push({ wsk: v.wsk, wrk: v.worker, terminatedAt: v.terminatedAt! });
    }
    return { status: 200, body: { live, terminated } };
  },
};
