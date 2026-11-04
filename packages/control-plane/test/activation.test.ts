import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { place, readinessOf } from '../src/activation.js';
import { writeError } from '../src/errors.js';
import { HANDLERS } from '../src/handlers.js';
import { HostRegistry } from '../src/host-handlers.js';
import { ProvenanceStore, sha256Hex } from '../src/provenance.js';
import { FileTemplateCatalog, type TemplateDoc } from '../src/template-catalog.js';
import { FilePolicyStore } from '../src/template-policy-store.js';
import { DEFAULT_POLICY } from '../src/template-policy.js';
import { alice, bob, ctx, makeDeps, NOW_MS, type TestDeps } from './helpers/deps.js';

const EX = resolve(__dirname, '../../../deploy/sbx/template-onboarding/examples');
const SPEC = JSON.parse(readFileSync(join(EX, 'django__django-11133.json'), 'utf8')) as Record<
  string,
  any
>; // eslint-disable-line @typescript-eslint/no-explicit-any
const { id: _id, image: IMAGE, schema: _s, notes: _n, ...REST } = SPEC;
const BASE_SPEC = { ...REST, source_record_digest: undefined, skip_git_identity_check: false };
const DIGEST = IMAGE.slice(IMAGE.indexOf('@') + 1);
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const hash = (c: string) => `sha256:${c.repeat(64)}`;

let seq = 0;
let now = NOW_MS;
async function setup(quotaActive = 8): Promise<TestDeps> {
  now = NOW_MS;
  const dir = mkdtempSync(join(tmpdir(), 'cp-act-'));
  const provenance = new ProvenanceStore({ dir, now: () => now });
  const d = makeDeps({
    newId: () => `${(++seq).toString(16).padStart(26, '0')}000000`,
    now: () => now,
    templates: new FileTemplateCatalog({ dir, declared: [], provenance, now: () => now }),
    provenance,
    policy: new FilePolicyStore({ dir, provenance }),
    hosts: new HostRegistry(),
    presence: {
      list: async () => attachedNow.map((w) => ({ sandboxId: w, labels: {}, capacityMax: 3 })),
    },
    config: { routeProfile: 'sandbox' },
  });
  await d.policy!.set(
    { ...DEFAULT_POLICY, quota: { ...DEFAULT_POLICY.quota, active: quotaActive } },
    'github:admin',
  );
  return d;
}
let attachedNow: string[] = [];
const asHost = (host: string, params: Record<string, string> = {}, body: unknown = {}) =>
  ({ ...ctx({ params: { host, ...params }, body }), host }) as ReturnType<typeof ctx> & {
    host: string;
  };

/** Creates, builds and registers template `id` with manifest hash `h` (via the host routes). */
async function registered(
  d: TestDeps,
  id: string,
  h: string,
  worker: string,
  principal = alice,
): Promise<void> {
  await HANDLERS.createTemplate!(
    ctx({ principal, body: { id, image: IMAGE, spec: BASE_SPEC, profile: 'base' } }),
    d,
  );
  const c = (await HANDLERS.hostClaimBuilds!(asHost('bm1', {}, { max: 1 }), d)).body as Body;
  const build = c.builds[0].build;
  const r = (
    await HANDLERS.hostBuildReport!(
      asHost(
        'bm1',
        { build },
        {
          event: 'built',
          templateRecord: JSON.stringify({
            schema: 'moca-sbx-template/1',
            id,
            worker,
            snapshot: `${id}-x`,
            image: IMAGE,
            guest_ram_mb: 4096,
            manifest_hash: h,
          }),
          manifest: JSON.stringify({
            hash_version: 2,
            hash: h,
            guest_ram_mb: 4096,
            vcpus: 2,
            source_image_digest: DIGEST,
          }),
        },
      ),
      d,
    )
  ).body as Body;
  expect(r.status).toBe('registered');
}
const inventory = (d: TestDeps, host: string, holds: Record<string, string>, activeLimit: number) =>
  HANDLERS.hostInventory!(
    asHost(
      host,
      {},
      {
        holds: Object.entries(holds).map(([manifestHash, template]) => ({
          manifestHash,
          template,
        })),
        limits: { activeLimit, idleLimitSeconds: 3600 },
      },
    ),
    d,
  );
const readiness = async (d: TestDeps, id: string) =>
  ((await HANDLERS.getTemplate!(ctx({ principal: alice, params: { id } }), d)).body as Body)
    .readiness;
const activate = (d: TestDeps, id: string, principal = alice, body: unknown = {}) =>
  HANDLERS.activateTemplate!(ctx({ principal, params: { id }, body }), d);

describe('activation (§6.2-§6.4)', () => {
  it('goes inactive -> activating -> active -> deactivating -> inactive, from leases, placement and presence', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    expect(await readiness(d, 't1')).toBe('inactive');
    const r = (await activate(d, 't1')).body as Body;
    expect(r).toMatchObject({
      templateId: 't1',
      buildId: hash('1'),
      host: 'bm1',
      leaseUntil: Math.floor(now / 1000) + 3600,
    });
    expect(await readiness(d, 't1')).toBe('activating');
    const w = (await HANDLERS.hostWanted!(asHost('bm1'), d)).body as Body;
    expect(w.run).toEqual([{ template: 't1', buildId: hash('1'), worker: 'sbx_t1' }]);
    attachedNow = ['sbx_t1'];
    expect(await readiness(d, 't1')).toBe('active');
    await HANDLERS.deactivateTemplate!(
      ctx({ principal: alice, params: { id: 't1' }, body: {} }),
      d,
    );
    expect(await readiness(d, 't1')).toBe('deactivating');
    expect(((await HANDLERS.hostWanted!(asHost('bm1'), d)).body as Body).stop).toHaveLength(1);
    attachedNow = [];
    expect(await readiness(d, 't1')).toBe('inactive');
    const kinds = (await d.provenance!.chain('template/t1')).map((x) => x.kind);
    expect(kinds.slice(-2)).toEqual(['activate', 'deactivate']);
  });

  it('ages a lease out: no renewal, no longer wanted', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1', alice, { leaseSeconds: 120 });
    expect(await readiness(d, 't1')).toBe('activating');
    now += 121_000;
    expect(await readiness(d, 't1')).toBe('inactive');
  });

  it('renews a lease without limit, a day at most per grant', async () => {
    const d = await setup();
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    for (let i = 0; i < 3; i++) {
      await activate(d, 't1', alice, { leaseSeconds: 86_400 });
      now += 43_200_000;
    }
    expect(await readiness(d, 't1')).not.toBe('inactive');
    await expect(activate(d, 't1', alice, { leaseSeconds: 86_401 })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('never evicts a leased build: over the limit is 409 no_active_slot with Retry-After', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2', bob);
    await inventory(d, 'bm1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 1);
    await activate(d, 't1', alice, { leaseSeconds: 600 });
    const e = await activate(d, 't2', bob).catch((x) => x);
    expect(e.code).toBe('no_active_slot');
    expect(e.retryAfterS).toBe(600);
    const res = { headersSent: false, status: 0, headers: {} as Record<string, string>, body: '' };
    writeError(
      {
        headersSent: false,
        writeHead: (st: number, h: Record<string, string>) => (
          (res.status = st),
          (res.headers = h)
        ),
        end: (b: string) => (res.body = b),
      },
      e,
    );
    expect(res.status).toBe(409);
    expect(res.headers['Retry-After']).toBe('600');
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'no_active_slot',
      readiness: 'unavailable',
    });
    // The held build is untouched; once its lease ends, the other fits.
    expect((await HANDLERS.hostWanted!(asHost('bm1'), d)).body).toMatchObject({
      run: [{ template: 't1' }],
    });
    now += 601_000;
    expect((await activate(d, 't2', bob)).status).toBe(200);
  });

  it('refuses a build no host holds as template_unavailable, and a draft build too', async () => {
    const d = await setup();
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'bm1', {}, 2);
    expect(await activate(d, 't1').catch((x) => x.code)).toBe('template_unavailable');
    await HANDLERS.createTemplate!(
      ctx({
        principal: alice,
        body: { id: 'draft', image: IMAGE, spec: BASE_SPEC, profile: 'base' },
      }),
      d,
    );
    expect(await activate(d, 'draft').catch((x) => x.code)).toBe('template_unavailable');
  });

  it("caps a subject's active builds at quota.active", async () => {
    const d = await setup(1);
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    await inventory(d, 'bm1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 4);
    await activate(d, 't1');
    const e = await activate(d, 't2').catch((x) => x);
    expect(e.code).toBe('quota_exceeded');
    expect(e.extra).toEqual({ quota: 'active' });
    expect((await HANDLERS.getQuota!(ctx({ principal: alice }), d)).body).toMatchObject({
      active: { limit: 1 },
    });
  });

  it("keeps a shared build wanted while another subject's lease stands", async () => {
    const d = await setup();
    attachedNow = ['sbx_t1'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1', alice);
    await activate(d, 't1', bob);
    await HANDLERS.deactivateTemplate!(
      ctx({ principal: alice, params: { id: 't1' }, body: {} }),
      d,
    );
    expect(await readiness(d, 't1')).toBe('active');
  });

  it('fills the hosts block from the agents: limits, use, disk', async () => {
    const d = await setup();
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1');
    const b = (await HANDLERS.listTemplates!(ctx({ principal: alice }), d)).body as Body;
    expect(b.hosts).toEqual([
      {
        id: 'bm1',
        active: { limit: 2, used: 1 },
        idleLimitSeconds: 3600,
        disk: { freeGb: 0, floorGb: 0 },
      },
    ]);
  });

  it("records a host's attach and detach reports for a build it holds, and refuses others", async () => {
    const d = await setup();
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    await HANDLERS.hostWorkerReport!(
      asHost('bm1', {}, { buildId: hash('1'), event: 'attached' }),
      d,
    );
    expect((await d.provenance!.chain('template/t1')).at(-1)).toMatchObject({
      kind: 'activate',
      subject: 'host:bm1',
    });
    await expect(
      HANDLERS.hostWorkerReport!(asHost('bm2', {}, { buildId: hash('1'), event: 'attached' }), d),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('place, alone', () => {
  const doc = (id: string, h: string, sinceS: number, until = 10_000): TemplateDoc => ({
    schema: 'moca-template/1',
    id,
    owner: 'github:1',
    visibility: 'deployment',
    description: '',
    tags: { default: h },
    builds: [
      {
        buildId: h,
        status: 'registered',
        profile: 'base',
        worker: `w_${id}`,
        spec: { tools: [] },
        createdAt: 0,
        leases: [{ subject: 'github:1', until, since: sinceS }],
      },
    ],
    createdAt: 0,
  });
  it('places first-leased first, on the least-used holder, and never evicts', () => {
    const docs = [doc('a', hash('a'), 3), doc('b', hash('b'), 1), doc('c', hash('c'), 2)];
    const hosts = [
      { id: 'h1', holds: { [hash('a')]: 'a', [hash('b')]: 'b', [hash('c')]: 'c' }, activeLimit: 1 },
      { id: 'h2', holds: { [hash('a')]: 'a', [hash('c')]: 'c' }, activeLimit: 1 },
    ];
    const p = place(docs, hosts, 0);
    expect([...p.placed]).toEqual([
      [hash('b'), 'h1'],
      [hash('c'), 'h2'],
    ]);
    expect(p.unplaced.get(hash('a'))).toBe('no_slot');
  });
  it('reads readiness unknown when presence is unreadable', () => {
    expect(readinessOf(doc('a', hash('a'), 0).builds[0]!, 0, null, null)).toBe('unknown');
  });
});

void sha256Hex;
