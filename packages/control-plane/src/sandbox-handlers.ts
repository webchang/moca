import { CpError } from './errors.js';
import {
  asRecord,
  auditBestEffort,
  isAdmin,
  requireEnrolledPrincipal,
  seconds,
} from './handler-util.js';
import type { CpDeps, Handler, RequestCtx } from './handlers.js';
import type { SandboxConfig } from './sandbox-config.js';
import type { ProvenanceStore } from './provenance.js';
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
  if (deps.config.routeProfile !== 'sandbox' || !deps.sandboxes) {
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
    b.status !== 'registered' ? null : readinessOf(b, f.nowS, f.placement, f.attached);
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
  const doc = await cat.update(id, async (cur) => {
    if (existing && !cur) throw new CpError('template_not_found', 'no such template');
    if (cur && cur.owner !== p.sub && !(existing && isAdmin(p))) {
      // 404 for a private template, 409 for a visible one: never an existence oracle for private.
      throw cur.visibility === 'private' && !isAdmin(p)
        ? new CpError('template_not_found', 'no such template')
        : new CpError('template_exists', `template '${id}' belongs to another subject`);
    }
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
  const { cat, policy, prov } = writable(deps);
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
  const nowS = seconds(deps);
  const DAY = 86_400;
  const hosts = hostViews(deps);
  const defaultLease =
    Math.max(...hosts.map((h) => deps.hosts!.get(h.id)!.limits.idleLimitSeconds), 0) || 3600;
  const want =
    typeof b.leaseSeconds === 'number' && Number.isSafeInteger(b.leaseSeconds)
      ? b.leaseSeconds
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
    },
  });
  return {
    status: 200,
    body: {
      templateId: d0.id,
      buildId: target.buildId,
      leaseUntil: nowS + want,
      host: pl.placed.get(target.buildId) ?? null,
    },
  };
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

export const SANDBOX_HANDLERS: Record<string, Handler> = {
  activateTemplate: activate,
  deactivateTemplate: deactivate,

  createTemplate: (ctx, deps) => createBuild(ctx, deps, false),

  createTemplateBuild: (ctx, deps) => createBuild(ctx, deps, true),

  getPolicy: async (ctx, deps) => {
    requireEnrolled(ctx, deps);
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
    const p = requireEnrolled(ctx, deps);
    const { cat, policy } = writable(deps);
    const { policy: pol } = await policy.current();
    const u = await usage(cat, p.sub);
    return {
      status: 200,
      body: {
        subject: p.sub,
        templates: { limit: pol.quota.templates, used: u.templates },
        buildsQueued: { limit: pol.quota.buildsQueued, used: u.buildsQueued },
        // Activations (§6) are not built yet: nothing is held, so nothing is used.
        active: { limit: pol.quota.active, used: 0 },
      },
    };
  },

  listTemplates: async (ctx, deps) => {
    const p = requireEnrolled(ctx, deps);
    const docs = await visibleTemplates(deps, p);
    const live = await readinessFacts(deps);
    // The worker id is deployment plumbing; a client names a template, never a worker.
    const templates = docs.map((d) => templateBody(d, live, false));
    // Per-host limits and use (§4, §6.2) are reported by the host agent (§6.1), not built yet:
    // an empty list means "no host reports", never "no limit".
    return { status: 200, body: { templates, hosts: hostsBlock(deps, live) } };
  },

  listTemplateTags: async (ctx, deps) => {
    const p = requireEnrolled(ctx, deps);
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
    const p = requireEnrolled(ctx, deps);
    const d = await visibleTemplate(deps, p, ctx.params.id ?? '');
    return { status: 200, body: templateBody(d, await readinessFacts(deps), true) };
  },

  listTemplateBuilds: async (ctx, deps) => {
    const p = requireEnrolled(ctx, deps);
    const d = await visibleTemplate(deps, p, ctx.params.id ?? '');
    const live = await readinessFacts(deps);
    return { status: 200, body: { builds: d.builds.map((b) => buildBody(d, b, live, true)) } };
  },

  getTemplateBuild: async (ctx, deps) => {
    const p = requireEnrolled(ctx, deps);
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
    const template = cfg.templates.find((t) => t.id === b.template);
    if (!template) {
      throw new CpError('unknown_template', 'no such template (GET /v1/templates lists them)');
    }
    if (b.name !== undefined && (typeof b.name !== 'string' || !NAME_RE.test(b.name))) {
      throw new CpError('invalid_request', `name must match ${NAME_RE}`);
    }
    const labels = parseLabels(b.labels);
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
