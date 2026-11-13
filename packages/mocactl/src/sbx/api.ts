import { ControlPlaneClient } from '../api/control-plane.js';

/** The sandbox service's HTTP API (SBX0 §5.1), on top of the control-plane client's auth and retry. */
export interface SbxTemplate {
  id: string;
  description: string;
  tools: string[];
}

export interface SbxSandbox {
  id: string;
  owner: string;
  name: string | null;
  template: string;
  state: 'ready' | 'terminated';
  reason: 'deleted' | 'expired' | null;
  createdAt: number;
  expiresAt: number;
  terminatedAt: number | null;
  labels: Record<string, string>;
}

export interface SbxToken {
  token: string;
  expiresAt: number;
  execEndpoint: string;
  wrk: string;
  wsk: string;
  execCa: string | null;
}

/**
 * `/v1/discovery` as the sandbox service reads it (SBX0 §4.1). Only `profile` is relied on: a
 * control plane that predates profiles omits it and is a harness (MOCA) one.
 */
/** A subject as `GET /v1/subjects` lists it (register G38). */
export interface SbxSubject {
  subject: string;
  enrolled: boolean;
  source: 'env' | 'api';
  /** Whether the API's store itself enrolls it (apart from the settings and any role). */
  storeEnrolled: boolean;
  roles: { role: string; source: 'env' | 'api'; until: number | null; by: string | null }[];
}

export interface SbxDiscovery {
  profile?: string;
}

/** What a retire answers (lifecycle spec §5.1): each build retired, with its retire record. */
export interface SbxRetired {
  templateId: string;
  subject: string;
  status: 'retired';
  builds?: { build: string; buildId: string | null; readiness: 'retired'; record: string | null }[];
  build?: string;
  buildId?: string | null;
  record?: string | null;
}

/** What a tag move answers (lifecycle spec §5.1). */
export interface SbxTagsMoved {
  templateId: string;
  subject: string;
  buildId: string;
  tags: { tag: string; buildId: string; before: string | null; record: string | null }[];
}

/** A sandbox's egress log, a page at a time (register G42): the proxy's events as it wrote them. */
export interface SbxEgressPage {
  events: Record<string, unknown>[];
  next: string | null;
  summary: SbxEgressSummary;
}

export interface SbxEgressSummary {
  byHost: Record<
    string,
    { count: number; decisions: Record<string, number>; bytesUp: number; bytesDown: number }
  >;
  total: number;
  dropped: number;
  droppedBy?: { proxy: number; cap: number; budget?: number; invalid: number };
  complete: boolean;
  sealed?: boolean;
  sha256: string;
}

/** A build's readiness reason (openapi ReadinessReason, register G39): why it waits. */
export type SbxReadinessReason = 'not_held' | 'no_slot' | 'memory' | 'memfile_mismatch';

/** One build of a template (openapi TemplateBuild, template lifecycle spec §3.2, §3.3). */
export interface SbxBuild {
  buildId: string;
  handle: string;
  status: string;
  profile: string;
  readiness: string | null;
  readinessReason?: SbxReadinessReason;
  /** Register G43: waiting for a start slot on its host, and its place in the host's start line. */
  queued?: boolean;
  queuePosition?: number;
  /** Register G43: in its host's idle grace, until `gracedUntil`. */
  graced?: true;
  gracedUntil?: number;
  reason: { message: string; step?: string; rule?: string; code?: string } | null;
  attestation?: 'deployment' | 'self';
  heldBy: string[] | null;
  /**
   * A retired build whose snapshot or worker a build that is not retired shares: no host removes
   * it for the retire. Absent from an older control plane.
   */
  shared?: boolean;
  tags: string[];
  createdAt: number;
  provenance: string | null;
  spec?: {
    guest_mb?: number;
    vcpus?: number;
    workspace_mb?: number;
    seed?: string;
    tools?: string[];
  };
}

/** A template with its builds (openapi Template). */
export interface SbxTemplateFull extends SbxTemplate {
  owner: string | null;
  visibility: 'private' | 'deployment';
  attestation?: 'deployment' | 'self';
  onboarding: string | null;
  readiness: string | null;
  readinessReason?: SbxReadinessReason;
  tags: Record<string, string>;
  builds: SbxBuild[];
}

/** One KVM host as `GET /v1/templates` reports it (template lifecycle spec §6.2, G39, G43). */
export interface SbxHost {
  id: string;
  active: { limit: number; used: number };
  idleLimitSeconds: number;
  disk: { freeGb: number; floorGb: number };
  memory?: { headroomMib: number; brake: string | null; usedMib: number; totalMib: number };
  idleGraceSeconds?: number;
  graced?: number;
  start?: {
    concurrency: number;
    seconds: number | null;
    starting: number | null;
    queued: number | null;
  };
}

/** What a create answers (openapi TemplateQueued): the build to follow. */
export interface SbxQueued {
  templateId: string;
  buildId: string | null;
  /** The build's path, `/v1/templates/{id}/builds/{handle}`. */
  build: string;
  status: string;
  reused?: boolean;
}

/** The body of a template create (openapi TemplateCreate). */
export interface SbxTemplateCreate {
  id?: string;
  image: string;
  spec: Record<string, unknown>;
  profile?: string;
  /** The gate record file as sent, byte for byte. */
  gateRecord?: string;
  visibility?: string;
}

export type SbxLimitUse = { limit: number; used: number };
export interface SbxQuotaView {
  subject: string;
  templates: SbxLimitUse;
  buildsQueued: SbxLimitUse;
  active: SbxLimitUse;
  sandboxes?: SbxLimitUse;
  quotaSource?: 'subject' | 'default';
}

export type SbxQuota = { templates: number; buildsQueued: number; active: number };

/** A policy profile (openapi Policy.profiles), as much of it as mocactl reads. */
export interface SbxProfile {
  requires: string[];
  selfAttest?: boolean;
  selfAttestEgress?: boolean;
  requireOfflineGate?: boolean;
  envelope: {
    maxGuestMb: number;
    maxVcpus: number;
    maxWorkspaceMb: number;
    exact?: { guestMb: number; vcpus: number };
  };
}

export interface SbxPolicyView {
  policy: {
    schema: string;
    profiles: Record<string, SbxProfile>;
    defaultProfile: string;
    allowedRegistries: string[];
    allowedRepositories?: Record<string, string[]>;
    trustedGateRecords: string[];
    quota: SbxQuota;
    quotaBySubject?: Record<string, SbxQuota>;
  };
  digest: string;
  record: string;
}

export class SandboxApiClient extends ControlPlaneClient {
  sandboxDiscovery(): Promise<SbxDiscovery> {
    return this.json('GET', '/v1/discovery', { auth: false });
  }

  async listTemplates(): Promise<SbxTemplate[]> {
    return (await this.json<{ templates: SbxTemplate[] }>('GET', '/v1/templates')).templates;
  }

  /** The KVM hosts' limits and use, the `hosts` block of `GET /v1/templates` (§6.2). */
  async listHosts(): Promise<SbxHost[]> {
    return (await this.json<{ hosts?: SbxHost[] }>('GET', '/v1/templates')).hosts ?? [];
  }

  /** One template with its builds and their specs (`GET /v1/templates/{id}`). */
  getTemplate(id: string): Promise<SbxTemplateFull> {
    return this.json('GET', `/v1/templates/${encodeURIComponent(id)}`);
  }

  /** One build, by build id or by the create's handle (`GET /v1/templates/{id}/builds/{b}`). */
  getTemplateBuild(id: string, build: string): Promise<SbxBuild> {
    return this.json(
      'GET',
      `/v1/templates/${encodeURIComponent(id)}/builds/${encodeURIComponent(build)}`,
    );
  }

  /** Create a template, or a new build of one's own (lifecycle spec §4): `POST /v1/templates`. */
  createTemplate(body: SbxTemplateCreate): Promise<SbxQueued> {
    return this.json('POST', '/v1/templates', { body });
  }

  /** A new build of one's own template: `POST /v1/templates/{id}/builds` (the body's id ignored). */
  createTemplateBuild(id: string, body: SbxTemplateCreate): Promise<SbxQueued> {
    return this.json('POST', `/v1/templates/${encodeURIComponent(id)}/builds`, { body });
  }

  /** Withdraw a queued, building or probing build (register G22). */
  cancelTemplateBuild(
    id: string,
    build: string,
  ): Promise<{ templateId: string; build: string; status: 'failed' }> {
    return this.json(
      'POST',
      `/v1/templates/${encodeURIComponent(id)}/builds/${encodeURIComponent(build)}/cancel`,
    );
  }

  /** Take or renew the caller's lease on a registered build (§6.3). */
  activateTemplate(
    id: string,
    body: { build?: string; leaseSeconds?: number },
  ): Promise<{ templateId: string; buildId: string; leaseUntil: number; host: string | null }> {
    return this.json('POST', `/v1/templates/${encodeURIComponent(id)}/activate`, { body });
  }

  /** Release the caller's lease; `stopNow` skips the host's idle grace (register G43). */
  deactivateTemplate(
    id: string,
    body: { stopNow?: boolean },
  ): Promise<{ templateId: string; released: number }> {
    return this.json('POST', `/v1/templates/${encodeURIComponent(id)}/deactivate`, { body });
  }

  /** The caller's template quotas and use, and the live-sandbox cap (§6.2, register G27). */
  getQuota(): Promise<SbxQuotaView> {
    return this.json('GET', '/v1/quota');
  }

  /** The deployment's template policy (§8): profiles, registries, quotas, and its digest. */
  getPolicy(): Promise<SbxPolicyView> {
    return this.json('GET', '/v1/policy');
  }

  /** Retire a template, or one build of it (lifecycle spec §5.1): `POST …/retire` or `DELETE …/builds/{b}`. */
  retireTemplate(id: string, opts: { build?: string; reason?: string } = {}): Promise<SbxRetired> {
    const t = encodeURIComponent(id);
    return opts.build
      ? this.json('DELETE', `/v1/templates/${t}/builds/${encodeURIComponent(opts.build)}`)
      : this.json('POST', `/v1/templates/${t}/retire`, {
          body: opts.reason !== undefined ? { reason: opts.reason } : {},
        });
  }

  /** Move tags onto a build (lifecycle spec §5.1): `POST /v1/templates/{id}/tags`. */
  moveTemplateTags(id: string, tags: string[], build: string): Promise<SbxTagsMoved> {
    return this.json('POST', `/v1/templates/${encodeURIComponent(id)}/tags`, {
      body: { tags, build },
    });
  }

  /** Remove a tag; its build stays (lifecycle spec §5.1). */
  removeTemplateTag(
    id: string,
    tag: string,
  ): Promise<{ templateId: string; tag: string; before: string; record: string }> {
    return this.json(
      'DELETE',
      `/v1/templates/${encodeURIComponent(id)}/tags/${encodeURIComponent(tag)}`,
    );
  }

  /** Change a template's description or visibility (lifecycle spec §5.1). */
  updateTemplate(
    id: string,
    body: { visibility?: string; description?: string },
  ): Promise<{
    templateId: string;
    visibility: string;
    description: string;
    changes: { field: string; value: string; before: string; record: string }[];
  }> {
    return this.json('PATCH', `/v1/templates/${encodeURIComponent(id)}`, { body });
  }

  /** Transfer a template to another subject (lifecycle spec §5.2; admins). */
  transferTemplateOwner(
    id: string,
    owner: string,
  ): Promise<{ templateId: string; owner: string; before: string | null; record: string | null }> {
    return this.json('PUT', `/v1/templates/${encodeURIComponent(id)}/owner`, { body: { owner } });
  }

  /**
   * Set a subject's quota, or the default; null removes a subject's override (spec §5.2; admins).
   * `expect`, when given, is the value read before: the control plane writes only if the target's
   * quota is that now, else `409 quota_changed` with nothing written.
   */
  putQuota(
    target: string,
    quota: SbxQuota | null,
    expect?: SbxQuota | null,
  ): Promise<{
    target: string;
    quota: SbxQuota | null;
    before: SbxQuota | null;
    policy: string;
    record: string;
  }> {
    return this.json('PUT', `/v1/quota/${encodeURIComponent(target)}`, {
      body: quota,
      query: { expect: expect === undefined ? undefined : JSON.stringify(expect) },
    });
  }

  /** Every enrolled subject, with its roles (enrollment and roles spec §4, register G38; admins). */
  async listSubjects(): Promise<SbxSubject[]> {
    return (await this.json<{ subjects: SbxSubject[] }>('GET', '/v1/subjects')).subjects;
  }

  /** Enroll a subject (G38; admins). */
  enrollSubject(subject: string): Promise<SbxSubject & { record: string | null }> {
    return this.json('PUT', `/v1/subjects/${encodeURIComponent(subject)}`, {
      body: { enrolled: true },
    });
  }

  /** Unenroll a subject enrolled through the API (G38; admins). */
  unenrollSubject(subject: string): Promise<SbxSubject & { record: string | null }> {
    return this.json('DELETE', `/v1/subjects/${encodeURIComponent(subject)}`);
  }

  /** Grant the admin role, optionally until an epoch second (G38; admins). */
  grantAdmin(subject: string, until?: number): Promise<SbxSubject & { record: string | null }> {
    return this.json('PUT', `/v1/subjects/${encodeURIComponent(subject)}/roles/admin`, {
      body: until === undefined ? {} : { until },
    });
  }

  /** Revoke an API-granted admin role (G38; admins). */
  revokeAdmin(subject: string): Promise<SbxSubject & { record: string | null }> {
    return this.json('DELETE', `/v1/subjects/${encodeURIComponent(subject)}/roles/admin`);
  }

  createSandbox(body: {
    template: string;
    name?: string;
    labels?: Record<string, string>;
  }): Promise<SbxSandbox & { buildId?: string | null; templateManifestHash?: string | null }> {
    return this.json('POST', '/v1/sandboxes', { body });
  }

  async listSandboxes(opts: { all?: boolean } = {}): Promise<SbxSandbox[]> {
    return (
      await this.json<{ sandboxes: SbxSandbox[] }>('GET', '/v1/sandboxes', {
        query: { all: opts.all ? '1' : undefined },
      })
    ).sandboxes;
  }

  getSandbox(id: string): Promise<SbxSandbox> {
    return this.json('GET', `/v1/sandboxes/${encodeURIComponent(id)}`);
  }

  deleteSandbox(id: string): Promise<{ id: string; state: 'terminated'; reason: string }> {
    return this.json('DELETE', `/v1/sandboxes/${encodeURIComponent(id)}`);
  }

  /** One page of a sandbox's egress log (owner or admin), from `after` (a page's `next`). */
  sandboxEgress(id: string, opts: { after?: string; limit?: number } = {}): Promise<SbxEgressPage> {
    return this.json('GET', `/v1/sandboxes/${encodeURIComponent(id)}/egress`, {
      query: { after: opts.after, limit: opts.limit },
    });
  }

  /** The whole log as NDJSON, byte for byte as served: its sha256 is the summary's. */
  async sandboxEgressNdjson(id: string): Promise<string> {
    const res = await this.request('GET', `/v1/sandboxes/${encodeURIComponent(id)}/egress`, {
      query: { format: 'ndjson' },
    });
    return res.text();
  }

  mintSandboxToken(id: string): Promise<SbxToken> {
    return this.json('POST', `/v1/sandboxes/${encodeURIComponent(id)}/token`);
  }
}
