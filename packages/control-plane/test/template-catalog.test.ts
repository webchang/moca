import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { ProvenanceStore, verifyExport } from '../src/provenance.js';
import type { SandboxTemplate } from '../src/sandbox-config.js';
import {
  FileTemplateCatalog,
  MemoryTemplateCatalog,
  PRESENCE_KEY,
  importedBuildId,
  redisPresenceReader,
  resolveBuild,
  type PresenceRecord,
  type TemplateDoc,
} from '../src/template-catalog.js';
import { admin, alice, bob, codeOf, ctx, makeDeps, NOW_MS, type TestDeps } from './helpers/deps.js';

const DECLARED: SandboxTemplate[] = [
  {
    id: 'default',
    worker: 'sbx_default',
    description: 'bash, git, Python 3',
    tools: ['bash', 'git', 'python3'],
  },
  {
    id: 'django-django-11133',
    worker: 'sbx_django_django_11133_3d3e705ff379',
    description: 'SWE-bench django__django-11133',
    tools: ['bash', 'git', 'python3', 'rg'],
    seed: 'cp -a /opt/testbed-src/. /workspace/',
  },
];
const freshDir = (): string => mkdtempSync(join(tmpdir(), 'cp-catalog-'));
const presence = (recs: PresenceRecord[]) => ({ list: async () => recs });
let seq = 0;
const sbxDeps = (over: Parameters<typeof makeDeps>[0] = {}): TestDeps =>
  makeDeps({
    newId: () => (++seq).toString(16).padStart(26, '0'),
    ...over,
    config: { routeProfile: 'sandbox', ...(over.config ?? {}) },
  });
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (
  op: string,
  d: TestDeps,
  params: Record<string, string> = {},
  principal = alice,
): Promise<Body> => (await HANDLERS[op]!(ctx({ principal, params }), d)).body as Body;

describe('the catalog', () => {
  it('declares each env-list template as one registered build, tagged default, with an opaque id', async () => {
    const c = new MemoryTemplateCatalog(DECLARED, 100);
    const d = (await c.get('django-django-11133'))!;
    expect(d.owner).toBeNull();
    expect(d.visibility).toBe('deployment');
    expect(d.builds).toHaveLength(1);
    expect(d.builds[0]).toMatchObject({
      status: 'registered',
      profile: 'imported',
      createdAt: 100,
    });
    expect(d.builds[0].spec.seed).toBe('cp -a /opt/testbed-src/. /workspace/');
    expect(d.tags.default).toBe(d.builds[0].buildId);
    expect(d.builds[0].buildId).toMatch(/^imported:[0-9a-f]{12}$/);
    expect(d.builds[0].buildId).not.toContain('sbx_');
    expect(importedBuildId('sbx_default')).toBe(importedBuildId('sbx_default'));
  });

  it('resolves id, id:tag and id@build (§3.2)', () => {
    const d: TemplateDoc = {
      schema: 'moca-template/1',
      id: 't',
      owner: 'github:1',
      visibility: 'deployment',
      description: '',
      tags: { default: 'sha256:b', stable: 'sha256:a' },
      builds: ['sha256:b', 'sha256:a'].map((buildId) => ({
        buildId,
        status: 'registered' as const,
        profile: 'benchmark',
        worker: `w_${buildId.slice(-1)}`,
        spec: { tools: [] },
        createdAt: 0,
      })),
      createdAt: 0,
    };
    expect(resolveBuild(d, {})?.buildId).toBe('sha256:b');
    expect(resolveBuild(d, { tag: 'stable' })?.buildId).toBe('sha256:a');
    expect(resolveBuild(d, { build: 'sha256:a' })?.worker).toBe('w_a');
    expect(resolveBuild(d, { tag: 'nope' })).toBeNull();
    expect(resolveBuild(d, { build: 'sha256:zz' })).toBeNull();
  });
});

describe('FileTemplateCatalog: the env list imported once (§3.1)', () => {
  it('imports into an empty catalog with a provenance create record per template', async () => {
    const dir = freshDir();
    const prov = new ProvenanceStore({ dir, now: () => NOW_MS });
    const c = new FileTemplateCatalog({
      dir,
      declared: DECLARED,
      provenance: prov,
      now: () => NOW_MS,
    });
    const docs = await c.list();
    expect(docs.map((d) => d.id)).toEqual(['default', 'django-django-11133']);
    const chain = await prov.chain('template/django-django-11133');
    expect(chain.map((r) => r.kind)).toEqual(['create']);
    expect(chain[0]).toMatchObject({
      subject: 'deployment',
      body: { source: 'SH_SANDBOX_TEMPLATES' },
    });
    expect(docs[1].builds[0].provenance).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(verifyExport(await prov.export(['template/django-django-11133'])).ok).toBe(true);
  });

  it('ignores the env list once the catalog holds templates, and warns when it differs', async () => {
    const dir = freshDir();
    const prov = new ProvenanceStore({ dir });
    await new FileTemplateCatalog({ dir, declared: DECLARED, provenance: prov }).list();
    const warnings: string[] = [];
    const again = new FileTemplateCatalog({
      dir,
      declared: [DECLARED[0]!],
      provenance: prov,
      warn: (m) => warnings.push(m),
    });
    expect((await again.list()).map((d) => d.id)).toEqual(['default', 'django-django-11133']);
    expect(warnings.join()).toMatch(/SH_SANDBOX_TEMPLATES differs/);
    // No second create record: the import ran once.
    expect((await prov.chain('template/default')).length).toBe(1);
  });

  it('resumes an import a crash cut short: the missing templates, no second create record', async () => {
    const dir = freshDir();
    const prov = new ProvenanceStore({ dir });
    await new FileTemplateCatalog({ dir, declared: DECLARED, provenance: prov }).list();
    // A crash after the first document: the second is missing and the marker was never written.
    rmSync(join(dir, 'catalog', 'django-django-11133.json'));
    rmSync(join(dir, 'catalog', '.imported'));
    const warnings: string[] = [];
    const again = new FileTemplateCatalog({
      dir,
      declared: DECLARED,
      provenance: prov,
      warn: (m) => warnings.push(m),
    });
    expect((await again.list()).map((d) => d.id)).toEqual(['default', 'django-django-11133']);
    expect(warnings).toEqual([]);
    // The second template's create record (written before the crash) is reused, not appended again.
    for (const id of ['default', 'django-django-11133'])
      expect((await prov.chain(`template/${id}`)).map((r) => r.kind)).toEqual(['create']);
    const doc = (await again.list()).find((d) => d.id === 'django-django-11133')!;
    expect(doc.builds[0].provenance).toBe((await prov.head('template/django-django-11133'))!.head);
    expect(existsSync(join(dir, 'catalog', '.imported'))).toBe(true);
  });

  it('does not warn when the env list still matches', async () => {
    const dir = freshDir();
    const prov = new ProvenanceStore({ dir });
    await new FileTemplateCatalog({ dir, declared: DECLARED, provenance: prov }).list();
    const warnings: string[] = [];
    await new FileTemplateCatalog({
      dir,
      declared: DECLARED,
      provenance: prov,
      warn: (m) => warnings.push(m),
    }).list();
    expect(warnings).toEqual([]);
  });

  it('answers null for an unknown id, and for a name that is not a template id', async () => {
    const dir = freshDir();
    const c = new FileTemplateCatalog({
      dir,
      declared: DECLARED,
      provenance: new ProvenanceStore({ dir }),
    });
    expect(await c.get('nope')).toBeNull();
    expect(await c.get('../catalog')).toBeNull();
  });
});

describe('the read API (§4)', () => {
  const attached = (worker: string, cap = 3): PresenceRecord => ({
    sandboxId: worker,
    labels: { 'moca.dev/template': 'x' },
    capacityMax: cap,
  });

  it('derives readiness from presence: attached is active with its capacity, absent is inactive', async () => {
    const d = sbxDeps({ presence: presence([attached('sbx_default', 3)]) });
    await HANDLERS.createSandbox!(ctx({ principal: alice, body: { template: 'default' } }), d);
    const ts = (await call('listTemplates', d)).templates as Body[];
    const def = ts.find((t) => t.id === 'default')!;
    expect(def.readiness).toBe('active');
    expect(def.builds[0].capacity).toEqual({ running: 3, inUse: 1 });
    const node = ts.find((t) => t.id === 'node22')!;
    expect(node.readiness).toBe('inactive');
    expect(node.builds[0].capacity).toBeNull();
  });

  it('says unknown, not inactive, when presence cannot be read or is not wired', async () => {
    const broken = sbxDeps({ presence: { list: async () => Promise.reject(new Error('down')) } });
    expect(((await call('listTemplates', broken)).templates as Body[])[0].readiness).toBe(
      'unknown',
    );
    expect(((await call('listTemplates', sbxDeps())).templates as Body[])[0].readiness).toBe(
      'unknown',
    );
  });

  it('omits specs from the list and includes them, seed and all, on one template and its builds', async () => {
    const d = sbxDeps({ templates: new MemoryTemplateCatalog(DECLARED) });
    const listed = (await call('listTemplates', d)).templates as Body[];
    expect(listed[1].builds[0].spec).toBeUndefined();
    const one = await call('getTemplate', d, { id: 'django-django-11133' });
    expect(one.builds[0].spec.seed).toBe('cp -a /opt/testbed-src/. /workspace/');
    const builds = (await call('listTemplateBuilds', d, { id: 'django-django-11133' }))
      .builds as Body[];
    const b = await call('getTemplateBuild', d, {
      id: 'django-django-11133',
      build: builds[0].buildId,
    });
    expect(b.spec.tools).toEqual(['bash', 'git', 'python3', 'rg']);
    expect(b.tags).toEqual(['default']);
  });

  it('never sends a worker id', async () => {
    const d = sbxDeps({
      templates: new MemoryTemplateCatalog(DECLARED),
      presence: presence([attached('sbx_default')]),
    });
    const all = JSON.stringify([
      await call('listTemplates', d),
      await call('getTemplate', d, { id: 'django-django-11133' }),
      await call('listTemplateBuilds', d, { id: 'default' }),
    ]);
    expect(all).not.toMatch(/sbx_/);
  });

  it('answers 404 template_not_found for an unknown template or build', async () => {
    const d = sbxDeps();
    expect(await codeOf(() => call('getTemplate', d, { id: 'nope' }))).toBe('template_not_found');
    expect(await codeOf(() => call('listTemplateBuilds', d, { id: 'nope' }))).toBe(
      'template_not_found',
    );
    expect(
      await codeOf(() => call('getTemplateBuild', d, { id: 'default', build: 'sha256:00' })),
    ).toBe('template_not_found');
  });

  it('hides a private template from everyone but its owner and admins, as 404', async () => {
    const priv: TemplateDoc = {
      ...(await new MemoryTemplateCatalog([DECLARED[0]!]).get('default'))!,
      id: 'mine',
      owner: alice.sub,
      visibility: 'private',
    };
    const d = sbxDeps({
      templates: { list: async () => [priv], get: async (id) => (id === 'mine' ? priv : null) },
    });
    expect(
      ((await call('listTemplates', d, {}, alice)).templates as Body[]).map((t) => t.id),
    ).toEqual(['mine']);
    expect(
      ((await call('listTemplates', d, {}, bob)).templates as Body[]).map((t) => t.id),
    ).toEqual([]);
    expect(await codeOf(() => call('getTemplate', d, { id: 'mine' }, bob))).toBe(
      'template_not_found',
    );
    expect((await call('getTemplate', d, { id: 'mine' }, admin)).id).toBe('mine');
  });

  it('refuses a caller who is not enrolled', async () => {
    const outsider = { ...alice, sub: 'github:42', tenant: 'github:42' };
    for (const op of ['listTemplates', 'getTemplate', 'listTemplateBuilds', 'getTemplateBuild']) {
      expect(
        await codeOf(() => call(op, sbxDeps(), { id: 'default', build: 'x' }, outsider)),
        op,
      ).toBe('not_enrolled');
    }
  });
});

describe('presence', () => {
  it('reads the key the relay writes (harness pool-records.ts recordsKey)', () => {
    const src = readFileSync(resolve(__dirname, '../../../harness/src/pool-records.ts'), 'utf8');
    expect(src).toContain(`return '${PRESENCE_KEY}';`);
  });

  it('parses records and skips an unreadable one', async () => {
    const r = redisPresenceReader({
      hGetAll: async (k) => {
        expect(k).toBe(PRESENCE_KEY);
        return {
          a: JSON.stringify({
            sandboxId: 'sbx_a',
            labels: { x: 'y' },
            capacityMax: 4,
            capabilities: [],
            transport: 'grpc',
          }),
          b: '{not json',
          c: JSON.stringify({ labels: {} }),
        };
      },
    });
    expect(await r.list()).toEqual([{ sandboxId: 'sbx_a', labels: { x: 'y' }, capacityMax: 4 }]);
  });
});

describe('increment 2: both profiles, lastUsedAt, tags', () => {
  const harnessDeps = (over: Parameters<typeof makeDeps>[0] = {}): TestDeps =>
    makeDeps({
      ...over,
      config: { routeProfile: 'harness', sandbox: undefined, ...(over.config ?? {}) },
    });

  it('serves the harness profile its session templates, with no sandbox counts (null, not 0)', async () => {
    const d = harnessDeps({
      config: { sessionTemplates: DECLARED },
      presence: { list: async () => [{ sandboxId: 'sbx_default', labels: {}, capacityMax: 2 }] },
    });
    const ts = (
      await call('listTemplates', d, {}, { ...alice, sub: 'github:777', tenant: 'github:777' })
    ).templates as Body[];
    expect(ts.map((t) => t.id)).toEqual(['default', 'django-django-11133']);
    expect(ts[0].readiness).toBe('active');
    expect(ts[0].builds[0].capacity).toEqual({ running: 2, inUse: null });
    expect(ts[0].builds[0].lastUsedAt).toBeNull();
    expect(ts[1].readiness).toBe('inactive');
    const one = await call('getTemplate', d, { id: 'django-django-11133' });
    expect(one.builds[0].spec.seed).toBe('cp -a /opt/testbed-src/. /workspace/');
  });

  it('lists nothing on a harness control plane that declares no templates', async () => {
    expect((await call('listTemplates', harnessDeps())).templates).toEqual([]);
  });

  it("reports a build's lastUsedAt as its newest sandbox's creation, retained records included", async () => {
    let now = NOW_MS;
    const d = sbxDeps({ now: () => now, presence: presence([]) });
    await HANDLERS.createSandbox!(ctx({ principal: alice, body: { template: 'default' } }), d);
    now += 60_000;
    await HANDLERS.createSandbox!(ctx({ principal: bob, body: { template: 'default' } }), d);
    const ts = (await call('listTemplates', d)).templates as Body[];
    expect(ts.find((t) => t.id === 'default')!.builds[0].lastUsedAt).toBe(Math.floor(now / 1000));
    expect(ts.find((t) => t.id === 'node22')!.builds[0].lastUsedAt).toBeNull();
  });

  it('lists tags with their build, and when and by whom they were set', async () => {
    const d = sbxDeps({ templates: new MemoryTemplateCatalog(DECLARED, 500) });
    const { tags } = (await call('listTemplateTags', d, { id: 'default' })) as { tags: Body[] };
    expect(tags).toEqual([
      {
        tag: 'default',
        buildId: importedBuildId('sbx_default'),
        assignedAt: 500,
        assignedBy: null,
      },
    ]);
    expect(await codeOf(() => call('listTemplateTags', d, { id: 'nope' }))).toBe(
      'template_not_found',
    );
  });
});

it('lists an empty hosts block until a host agent reports (§6.2)', async () => {
  expect((await call('listTemplates', sbxDeps())).hosts).toEqual([]);
});
