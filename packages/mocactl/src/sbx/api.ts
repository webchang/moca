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

export class SandboxApiClient extends ControlPlaneClient {
  sandboxDiscovery(): Promise<SbxDiscovery> {
    return this.json('GET', '/v1/discovery', { auth: false });
  }

  async listTemplates(): Promise<SbxTemplate[]> {
    return (await this.json<{ templates: SbxTemplate[] }>('GET', '/v1/templates')).templates;
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

  createSandbox(body: {
    template: string;
    name?: string;
    labels?: Record<string, string>;
  }): Promise<SbxSandbox> {
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

  mintSandboxToken(id: string): Promise<SbxToken> {
    return this.json('POST', `/v1/sandboxes/${encodeURIComponent(id)}/token`);
  }
}
