import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { place, readinessOf } from '../src/activation.js';
import { writeError } from '../src/errors.js';
import { exchangeCredential } from '../src/exchange.js';
import { HANDLERS } from '../src/handlers.js';
import { HostRegistry } from '../src/host-handlers.js';
import { ProvenanceStore, sha256Hex } from '../src/provenance.js';
import { FileTemplateCatalog, type TemplateDoc } from '../src/template-catalog.js';
import { FilePolicyStore } from '../src/template-policy-store.js';
import { DEFAULT_POLICY } from '../src/template-policy.js';
import {
  alice,
  bob,
  ctx,
  makeDeps,
  NOW_MS,
  seedCredential,
  type TestDeps,
} from './helpers/deps.js';

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

describe('activation on first use (§6.4)', () => {
  const createSandbox = (d: TestDeps, body: Record<string, unknown>, principal = alice) =>
    HANDLERS.createSandbox!(ctx({ principal, body }), d);
  const refusal = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      const x = e as { code: string; extra?: Record<string, string>; retryAfterS?: number };
      return { code: x.code, readiness: x.extra?.readiness, retryAfterS: x.retryAfterS };
    }
    return { code: 'none' };
  };
  const leases = async (d: TestDeps, id: string) =>
    ((await d.templates!.get(id))!.builds[0]!.leases ?? []).filter(
      (l) => l.until > Math.floor(now / 1000),
    );

  it('starts the activation and answers 409 template_not_active; the retry creates once active', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    expect(await refusal(() => createSandbox(d, { template: 't1' }))).toEqual({
      code: 'template_not_active',
      readiness: 'activating',
      retryAfterS: 30,
    });
    // The lease is the caller's, recorded as first use, and the host is asked to run it.
    expect((await leases(d, 't1')).map((l) => l.subject)).toEqual([alice.sub]);
    const rec = (await d.provenance!.chain('template/t1')).at(-1)!;
    expect(rec).toMatchObject({ kind: 'activate', body: { reason: 'first_use' } });
    const w = (await HANDLERS.hostWanted!(asHost('bm1'), d)).body as Body;
    expect(w.run).toEqual([{ template: 't1', buildId: hash('1'), worker: 'sbx_t1' }]);
    // No sandbox was kept while waiting.
    expect(await d.sandboxes!.listByOwner(alice.sub, Math.floor(now / 1000))).toHaveLength(0);
    // Still activating: the retry waits again, without a second lease.
    expect((await refusal(() => createSandbox(d, { template: 't1' }))).code).toBe(
      'template_not_active',
    );
    expect(await leases(d, 't1')).toHaveLength(1);
    attachedNow = ['sbx_t1'];
    const r = await createSandbox(d, { template: 't1' });
    expect(r.status).toBe(201);
    expect((r.body as Body).buildId).toBe(hash('1'));
  });

  it('gates a session on its template the same way, and records the build it resolved (combined spec §3.4)', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    await seedCredential(d);
    const session = (sandbox: Record<string, unknown>) =>
      HANDLERS.createSession!(ctx({ principal: alice, body: { sandbox } }), d);
    // A self-serve template, in no static SH_SANDBOX_TEMPLATES list: the catalog resolves it.
    expect(d.config.sessionTemplates?.some((t) => t.id === 't1') ?? false).toBe(false);
    expect(await refusal(() => session({ template: 't1', activate: false }))).toMatchObject({
      code: 'template_not_active',
      readiness: 'inactive',
    });
    expect(await leases(d, 't1')).toHaveLength(0);
    expect(await refusal(() => session({ template: 't1' }))).toMatchObject({
      code: 'template_not_active',
      readiness: 'activating',
      retryAfterS: 30,
    });
    expect(await leases(d, 't1')).toHaveLength(1);
    attachedNow = ['sbx_t1'];
    const r = await session({ template: `t1@${hash('1')}` });
    expect(r.status).toBe(201);
    const sid = (r.body as Body).sessionId as string;
    const got = (await HANDLERS.getSession!(ctx({ principal: alice, params: { id: sid } }), d))
      .body as Body;
    expect(got).toMatchObject({ sandboxBuildId: hash('1') });
    // The exchange hands the data plane that build, so the turn runs only on its workers (G19).
    const tok = (r.body as Body).token as string;
    const ex = await exchangeCredential(tok, d);
    expect(ex).toMatchObject({ sandboxTemplate: 't1', sandboxBuildId: hash('1') });
    expect(await refusal(() => session({ template: 'nope' }))).toMatchObject({
      code: 'unknown_template',
    });
    expect(await refusal(() => session({ template: 't1', activate: 'no' }))).toMatchObject({
      code: 'invalid_request',
    });
  });

  it('with activate: false, answers 409 and starts nothing', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    expect(await refusal(() => createSandbox(d, { template: 't1', activate: false }))).toEqual({
      code: 'template_not_active',
      readiness: 'inactive',
      retryAfterS: 30,
    });
    expect(await leases(d, 't1')).toHaveLength(0);
    expect(await refusal(() => createSandbox(d, { template: 't1', activate: 'no' }))).toMatchObject(
      { code: 'invalid_request' },
    );
  });

  it('answers what activate would: no_active_slot when the host is full', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    await inventory(d, 'bm1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 1);
    await activate(d, 't1', bob);
    expect((await refusal(() => createSandbox(d, { template: 't2' }))).code).toBe('no_active_slot');
    expect(await leases(d, 't2')).toHaveLength(0);
  });

  it('refuses before any configured host has reported, and serves an attached worker (G32)', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    d.config.templateHosts = [{ id: 'bm1', token: 'f'.repeat(64) }];
    // No inventory from bm1 yet: refused, not left to wait at the relay; the lease is taken.
    expect(await refusal(() => createSandbox(d, { template: 't1' }))).toEqual({
      code: 'template_not_active',
      readiness: 'activating',
      retryAfterS: 30,
    });
    expect((await leases(d, 't1')).map((l) => l.subject)).toEqual([alice.sub]);
    expect(await d.sandboxes!.listByOwner(alice.sub, Math.floor(now / 1000))).toHaveLength(0);
    // Once bm1 reports, it is asked to run the build the lease wants.
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    const w = (await HANDLERS.hostWanted!(asHost('bm1'), d)).body as Body;
    expect(w.run).toEqual([{ template: 't1', buildId: hash('1'), worker: 'sbx_t1' }]);
    // A control plane restarted under attached workers (no inventory yet) still serves them.
    d.hosts = new HostRegistry();
    attachedNow = ['sbx_t1'];
    expect((await createSandbox(d, { template: 't1' })).status).toBe(201);
  });

  it('changes nothing without host agents: the create succeeds as before', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    d.hosts = undefined;
    expect((await createSandbox(d, { template: 't1' })).status).toBe(201);
  });
});

describe('retire (§5.1)', () => {
  const refusal = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      return (e as { code: string }).code;
    }
    return 'none';
  };
  const retire = (d: TestDeps, id: string, principal = alice, body: unknown = {}) =>
    HANDLERS.retireTemplate!(ctx({ principal, params: { id }, body }), d);
  const retireBuild = (d: TestDeps, id: string, build: string, principal = alice) =>
    HANDLERS.retireTemplateBuild!(ctx({ principal, params: { id, build } }), d);

  it('retires a template: builds retired, leases gone, a 410 on use, a retire record per build', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1');
    const r = await retire(d, 't1', alice, { reason: 'done with it' });
    expect(r.status).toBe(200);
    const body = r.body as Body;
    expect(body).toMatchObject({ templateId: 't1', subject: alice.sub, status: 'retired' });
    expect(body.builds).toHaveLength(1);
    expect(body.builds[0]).toMatchObject({ buildId: hash('1'), readiness: 'retired' });
    expect(body.builds[0].record).toMatch(/^sha256:[0-9a-f]{64}$/);
    const doc = (await d.templates!.get('t1'))!;
    expect(doc.builds[0]).toMatchObject({ status: 'retired', leases: [] });
    expect(await readiness(d, 't1')).toBe('retired');
    const b = (
      await HANDLERS.getTemplateBuild!(
        ctx({ principal: alice, params: { id: 't1', build: hash('1') } }),
        d,
      )
    ).body as Body;
    expect(b).toMatchObject({ status: 'retired', readiness: 'retired' });
    const rec = (await d.provenance!.chain('template/t1')).at(-1)!;
    expect(rec).toMatchObject({
      kind: 'retire',
      subject: alice.sub,
      body: { buildId: hash('1'), from: 'registered', reason: 'done with it' },
    });
    // Use refused as gone, not unknown, by id and by pinned build, for sandboxes and sessions.
    const sandbox = (template: string) =>
      HANDLERS.createSandbox!(ctx({ principal: alice, body: { template } }), d);
    expect(await refusal(() => sandbox('t1'))).toBe('template_retired');
    expect(await refusal(() => sandbox(`t1@${hash('1')}`))).toBe('template_retired');
    await seedCredential(d);
    expect(
      await refusal(() =>
        HANDLERS.createSession!(
          ctx({ principal: alice, body: { sandbox: { template: 't1' } } }),
          d,
        ),
      ),
    ).toBe('template_retired');
    expect(await refusal(() => activate(d, 't1'))).not.toBe('none');
    // Idempotent: a second retire answers retired, with no second record.
    const before = (await d.provenance!.chain('template/t1')).length;
    const again = (await retire(d, 't1')).body as Body;
    expect(again.builds[0].record).toBe(null);
    expect((await d.provenance!.chain('template/t1')).length).toBe(before);
    // The quota no longer counts it.
    const q = (await HANDLERS.getQuota!(ctx({ principal: alice }), d)).body as Body;
    expect(q.templates.used).toBe(0);
  });

  it('asks the holding host to remove a retired build, and records the removal', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    expect(((await HANDLERS.hostWanted!(asHost('bm1'), d)).body as Body).remove).toEqual([]);
    await retire(d, 't1');
    const w = (await HANDLERS.hostWanted!(asHost('bm1'), d)).body as Body;
    expect(w.remove).toEqual([{ template: 't1', buildId: hash('1'), worker: 'sbx_t1' }]);
    expect(w.run).toEqual([]);
    expect(w.stop).toEqual([]);
    // Another host, not holding it, is asked for nothing.
    await inventory(d, 'bm2', {}, 2);
    expect(((await HANDLERS.hostWanted!(asHost('bm2'), d)).body as Body).remove).toEqual([]);
    const r = await HANDLERS.hostWorkerReport!(
      asHost('bm1', {}, { buildId: hash('1'), event: 'removed' }),
      d,
    );
    expect((r.body as Body).recorded).toBe('removed');
    const rec = (await d.provenance!.chain('template/t1')).at(-1)!;
    expect(rec).toMatchObject({
      kind: 'retire',
      subject: 'host:bm1',
      body: { buildId: hash('1'), event: 'removed' },
    });
    // `removed` for a build not retired is refused.
    await registered(d, 't2', hash('2'), 'sbx_t2');
    await inventory(d, 'bm1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 2);
    expect(
      await refusal(() =>
        HANDLERS.hostWorkerReport!(asHost('bm1', {}, { buildId: hash('2'), event: 'removed' }), d),
      ),
    ).toBe('not_found');
    // Once the host stops holding it, it is no longer asked.
    await inventory(d, 'bm1', { [hash('2')]: 't2' }, 2);
    expect(((await HANDLERS.hostWanted!(asHost('bm1'), d)).body as Body).remove).toEqual([]);
  });

  it('never retires a build under a live sandbox (409 build_in_use); retires one build alone', async () => {
    const d = await setup();
    attachedNow = ['sbx_t1'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1');
    const sb = (
      await HANDLERS.createSandbox!(ctx({ principal: alice, body: { template: 't1' } }), d)
    ).body as Body;
    expect(await refusal(() => retireBuild(d, 't1', hash('1')))).toBe('build_in_use');
    expect((await d.templates!.get('t1'))!.builds[0].status).toBe('registered');
    // Not removed under it either: the wanted state never lists a busy worker.
    await HANDLERS.deleteSandbox!(ctx({ principal: alice, params: { id: sb.id } }), d);
    const r = (await retireBuild(d, 't1', hash('1'))).body as Body;
    expect(r).toMatchObject({
      templateId: 't1',
      buildId: hash('1'),
      readiness: 'retired',
      status: 'retired',
    });
    expect(await refusal(() => retireBuild(d, 't1', hash('9')))).toBe('template_not_found');
  });

  it('never retires a build an active session is pinned to; deleting the session frees it', async () => {
    const d = await setup();
    attachedNow = ['sbx_t1'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1');
    await seedCredential(d);
    const s = (
      await HANDLERS.createSession!(
        ctx({ principal: alice, body: { sandbox: { template: `t1@${hash('1')}` } } }),
        d,
      )
    ).body as Body;
    expect(await refusal(() => retire(d, 't1'))).toBe('build_in_use');
    expect(await refusal(() => retireBuild(d, 't1', hash('1')))).toBe('build_in_use');
    expect((await d.templates!.get('t1'))!.builds[0].status).toBe('registered');
    await HANDLERS.deleteSession!(ctx({ principal: alice, params: { id: s.sessionId } }), d);
    expect((await retire(d, 't1')).status).toBe(200);
  });

  it("refuses another subject; an admin may retire anyone's", async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    expect(await refusal(() => retire(d, 't1', bob))).toBe('forbidden');
    expect(await refusal(() => retire(d, 't1', alice, { reason: 7 }))).toBe('invalid_request');
    const admin = { ...bob, roles: ['admin'] };
    expect((await retire(d, 't1', admin)).status).toBe(200);
  });
});

describe('tags (§3.2, §5.1)', () => {
  const refusal = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      return (e as { code: string }).code;
    }
    return 'none';
  };
  const move = (d: TestDeps, id: string, body: unknown, principal = alice) =>
    HANDLERS.moveTemplateTags!(ctx({ principal, params: { id }, body }), d);
  const remove = (d: TestDeps, id: string, tag: string, principal = alice) =>
    HANDLERS.removeTemplateTag!(ctx({ principal, params: { id, tag } }), d);
  const tagsOf = async (d: TestDeps, id: string) =>
    ((await HANDLERS.listTemplateTags!(ctx({ principal: alice, params: { id } }), d)).body as Body)
      .tags as { tag: string; buildId: string; assignedBy: string | null }[];

  it('moves default to a new build: new creates follow it, a pinned one keeps its build', async () => {
    const d = await setup();
    attachedNow = ['sbx_t1', 'sbx_t1b'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    // A second build of the same template.
    await HANDLERS.createTemplateBuild!(
      ctx({
        principal: alice,
        params: { id: 't1' },
        body: { image: IMAGE, spec: { ...BASE_SPEC, description: 'v2' } },
      }),
      d,
    );
    const c = (await HANDLERS.hostClaimBuilds!(asHost('bm1', {}, { max: 1 }), d)).body as Body;
    await HANDLERS.hostBuildReport!(
      asHost(
        'bm1',
        { build: c.builds[0].build },
        {
          event: 'built',
          templateRecord: JSON.stringify({
            schema: 'moca-sbx-template/1',
            id: 't1',
            worker: 'sbx_t1b',
            snapshot: 't1-y',
            image: IMAGE,
            guest_ram_mb: 4096,
            manifest_hash: hash('2'),
          }),
          manifest: JSON.stringify({
            hash_version: 2,
            hash: hash('2'),
            guest_ram_mb: 4096,
            vcpus: 2,
            source_image_digest: DIGEST,
          }),
        },
      ),
      d,
    );
    expect((await tagsOf(d, 't1')).find((t) => t.tag === 'default')?.buildId).toBe(hash('1'));
    const r = (await move(d, 't1', { tags: ['default', 'stable'], build: hash('2') })).body as Body;
    expect(r).toMatchObject({ templateId: 't1', subject: alice.sub, buildId: hash('2') });
    expect(r.tags).toEqual([
      expect.objectContaining({ tag: 'default', buildId: hash('2'), before: hash('1') }),
      expect.objectContaining({ tag: 'stable', buildId: hash('2'), before: null }),
    ]);
    expect(r.tags[0].record).toMatch(/^sha256:[0-9a-f]{64}$/);
    const tags = await tagsOf(d, 't1');
    expect(tags.map((t) => [t.tag, t.buildId, t.assignedBy])).toEqual([
      ['default', hash('2'), alice.sub],
      ['stable', hash('2'), alice.sub],
    ]);
    const rec = (await d.provenance!.chain('template/t1')).at(-2)!;
    expect(rec).toMatchObject({
      kind: 'tag',
      subject: alice.sub,
      body: { tag: 'default', buildId: hash('2'), before: hash('1') },
    });
    // A bare id and a tag follow it; a pinned build does not move.
    const sandbox = async (template: string) =>
      (
        (await HANDLERS.createSandbox!(ctx({ principal: alice, body: { template } }), d))
          .body as Body
      ).buildId;
    expect(await sandbox('t1')).toBe(hash('2'));
    expect(await sandbox('t1:stable')).toBe(hash('2'));
    expect(await sandbox(`t1@${hash('1')}`)).toBe(hash('1'));
    // A move onto the build a tag already names writes no record.
    const n = (await d.provenance!.chain('template/t1')).length;
    const again = (await move(d, 't1', { tags: ['stable'], build: hash('2') })).body as Body;
    expect(again.tags[0].record).toBe(null);
    expect((await d.provenance!.chain('template/t1')).length).toBe(n);
    // Removing a tag keeps its build; default is never removed.
    const rm = (await remove(d, 't1', 'stable')).body as Body;
    expect(rm).toMatchObject({ tag: 'stable', buildId: null, before: hash('2') });
    expect((await tagsOf(d, 't1')).map((t) => t.tag)).toEqual(['default']);
    expect((await d.templates!.get('t1'))!.builds.map((x) => x.status)).toEqual([
      'registered',
      'registered',
    ]);
    expect(await refusal(() => sandbox('t1:stable'))).not.toBe('none');
  });

  it('refuses bad tags, unknown or unusable builds, removing default, and other subjects', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    expect(await refusal(() => move(d, 't1', { tags: [], build: hash('1') }))).toBe(
      'invalid_request',
    );
    expect(await refusal(() => move(d, 't1', { tags: ['Bad Tag'], build: hash('1') }))).toBe(
      'invalid_request',
    );
    expect(await refusal(() => move(d, 't1', { tags: ['a', 'a'], build: hash('1') }))).toBe(
      'invalid_request',
    );
    expect(await refusal(() => move(d, 't1', { tags: ['a'], build: hash('9') }))).toBe(
      'template_not_found',
    );
    expect(await refusal(() => remove(d, 't1', 'default'))).toBe('invalid_request');
    expect(await refusal(() => remove(d, 't1', 'nope'))).toBe('template_not_found');
    expect(await refusal(() => move(d, 't1', { tags: ['a'], build: hash('1') }, bob))).toBe(
      'forbidden',
    );
    await HANDLERS.retireTemplate!(ctx({ principal: alice, params: { id: 't1' } }), d);
    expect(await refusal(() => move(d, 't1', { tags: ['a'], build: hash('1') }))).toBe(
      'template_retired',
    );
    expect(
      (
        await move(d, 't1', { tags: ['x'], build: hash('1') }, { ...bob, roles: ['admin'] }).catch(
          (e) => e,
        )
      ).code,
    ).toBe('template_retired');
  });
});

describe('reject after the fact (§5.2)', () => {
  const refusal = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      return (e as { code: string }).code;
    }
    return 'none';
  };
  const admin = { ...bob, roles: ['admin'] };
  const reject = (d: TestDeps, id: string, build: string, principal: typeof alice, body: unknown) =>
    HANDLERS.rejectTemplateBuild!(ctx({ principal, params: { id, build }, body }), d);

  it('an admin rejects a registered build with a reason: use refused, leases gone, host removes it', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1');
    // Not the owner's to reject, and never without a reason.
    expect(await refusal(() => reject(d, 't1', hash('1'), alice, { reason: 'X12 broken' }))).toBe(
      'forbidden',
    );
    expect(await refusal(() => reject(d, 't1', hash('1'), admin, {}))).toBe('invalid_request');
    const r = (await reject(d, 't1', hash('1'), admin, { reason: 'X12 was mis-scored' }))
      .body as Body;
    expect(r).toMatchObject({
      templateId: 't1',
      subject: admin.sub,
      buildId: hash('1'),
      status: 'rejected',
    });
    expect(r.record).toMatch(/^sha256:[0-9a-f]{64}$/);
    const b = (await d.templates!.get('t1'))!.builds[0];
    expect(b).toMatchObject({
      status: 'rejected',
      leases: [],
      reason: { message: 'X12 was mis-scored', rule: 'admin' },
    });
    const rec = (await d.provenance!.chain('template/t1')).at(-1)!;
    expect(rec).toMatchObject({
      kind: 'reject',
      subject: admin.sub,
      body: { buildId: hash('1'), from: 'registered', reason: 'X12 was mis-scored' },
    });
    expect(
      await refusal(() =>
        HANDLERS.createSandbox!(ctx({ principal: alice, body: { template: 't1' } }), d),
      ),
    ).toBe('unknown_template');
    const w = (await HANDLERS.hostWanted!(asHost('bm1'), d)).body as Body;
    expect(w.remove).toEqual([{ template: 't1', buildId: hash('1'), worker: 'sbx_t1' }]);
    expect(
      (
        (
          await HANDLERS.hostWorkerReport!(
            asHost('bm1', {}, { buildId: hash('1'), event: 'removed' }),
            d,
          )
        ).body as Body
      ).recorded,
    ).toBe('removed');
    // Only a registered build is rejected after the fact; a second reject records nothing.
    const n = (await d.provenance!.chain('template/t1')).length;
    expect(
      ((await reject(d, 't1', hash('1'), admin, { reason: 'again' })).body as Body).record,
    ).toBe(null);
    expect((await d.provenance!.chain('template/t1')).length).toBe(n);
    await HANDLERS.retireTemplate!(ctx({ principal: alice, params: { id: 't1' } }), d);
    expect(await refusal(() => reject(d, 't1', hash('1'), admin, { reason: 'x' }))).toBe(
      'invalid_request',
    );
  });
});

describe('edit description and visibility (§5.1)', () => {
  const refusal = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      return (e as { code: string }).code;
    }
    return 'none';
  };
  const patch = (d: TestDeps, id: string, body: unknown, principal = alice) =>
    HANDLERS.updateTemplate!(ctx({ principal, params: { id }, body }), d);

  it('the owner makes it private: others no longer see or use it; each change is a record', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    expect(
      ((await HANDLERS.getTemplate!(ctx({ principal: bob, params: { id: 't1' } }), d)).body as Body)
        .id,
    ).toBe('t1');
    const r = (await patch(d, 't1', { visibility: 'private', description: 'Django 11133, v1' }))
      .body as Body;
    expect(r).toMatchObject({
      templateId: 't1',
      subject: alice.sub,
      visibility: 'private',
      description: 'Django 11133, v1',
    });
    expect(r.changes.map((c: Body) => [c.field, c.value, c.before])).toEqual([
      ['visibility', 'private', 'deployment'],
      ['description', 'Django 11133, v1', expect.any(String)],
    ]);
    expect(r.changes[0].record).toMatch(/^sha256:[0-9a-f]{64}$/);
    const chain = await d.provenance!.chain('template/t1');
    expect(chain.at(-2)).toMatchObject({
      kind: 'visibility',
      subject: alice.sub,
      body: { field: 'visibility', value: 'private', before: 'deployment' },
    });
    expect(chain.at(-1)).toMatchObject({ kind: 'visibility', body: { field: 'description' } });
    // Bob no longer sees it (404), nor uses it; the owner and an admin still do.
    expect(
      await refusal(() => HANDLERS.getTemplate!(ctx({ principal: bob, params: { id: 't1' } }), d)),
    ).toBe('template_not_found');
    expect(
      await refusal(() =>
        HANDLERS.createSandbox!(ctx({ principal: bob, body: { template: 't1' } }), d),
      ),
    ).toBe('unknown_template');
    expect(
      (
        (
          await HANDLERS.getTemplate!(
            ctx({ principal: { ...bob, roles: ['admin'] }, params: { id: 't1' } }),
            d,
          )
        ).body as Body
      ).id,
    ).toBe('t1');
    // An edit to the same values writes nothing.
    const n = (await d.provenance!.chain('template/t1')).length;
    expect(((await patch(d, 't1', { visibility: 'private' })).body as Body).changes).toEqual([]);
    expect((await d.provenance!.chain('template/t1')).length).toBe(n);
    // Back to deployment.
    await patch(d, 't1', { visibility: 'deployment' });
    expect(
      ((await HANDLERS.getTemplate!(ctx({ principal: bob, params: { id: 't1' } }), d)).body as Body)
        .id,
    ).toBe('t1');
  });

  it('refuses bad values, an empty edit, and another subject', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    expect(await refusal(() => patch(d, 't1', { visibility: 'public' }))).toBe('invalid_request');
    expect(await refusal(() => patch(d, 't1', { description: 7 }))).toBe('invalid_request');
    expect(await refusal(() => patch(d, 't1', { description: 'x'.repeat(1025) }))).toBe(
      'invalid_request',
    );
    expect(await refusal(() => patch(d, 't1', {}))).toBe('invalid_request');
    expect(await refusal(() => patch(d, 't1', { description: 'mine now' }, bob))).toBe('forbidden');
  });
});

describe('owner transfer (§5.2)', () => {
  const refusal = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      return (e as { code: string }).code;
    }
    return 'none';
  };
  const admin = { ...bob, sub: 'github:42', tenant: 'github:42', roles: ['admin'] };
  const transfer = (d: TestDeps, id: string, owner: unknown, principal = admin) =>
    HANDLERS.transferTemplateOwner!(ctx({ principal, params: { id }, body: { owner } }), d);

  it('an admin moves a template to another enrolled subject, who then owns its actions', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    // Bob cannot retire alice's template, until it is his.
    expect(
      await refusal(() =>
        HANDLERS.retireTemplate!(ctx({ principal: bob, params: { id: 't1' } }), d),
      ),
    ).toBe('forbidden');
    const r = (await transfer(d, 't1', bob.sub)).body as Body;
    expect(r).toMatchObject({
      templateId: 't1',
      subject: admin.sub,
      owner: bob.sub,
      before: alice.sub,
    });
    expect(r.record).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await d.templates!.get('t1'))!.owner).toBe(bob.sub);
    const rec = (await d.provenance!.chain('template/t1')).at(-1)!;
    expect(rec).toMatchObject({
      kind: 'owner',
      subject: admin.sub,
      body: { owner: bob.sub, before: alice.sub },
    });
    // Now bob owns it, and alice no longer does.
    expect(
      await refusal(() =>
        HANDLERS.updateTemplate!(
          ctx({ principal: alice, params: { id: 't1' }, body: { description: 'x' } }),
          d,
        ),
      ),
    ).toBe('forbidden');
    expect(
      (
        await HANDLERS.updateTemplate!(
          ctx({ principal: bob, params: { id: 't1' }, body: { description: 'bob' } }),
          d,
        )
      ).status,
    ).toBe(200);
    // A transfer to the current owner writes nothing.
    expect(((await transfer(d, 't1', bob.sub)).body as Body).record).toBe(null);
  });

  it('refuses a non-admin, a malformed or unenrolled subject, and a declared template', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    expect(await refusal(() => transfer(d, 't1', bob.sub, alice))).toBe('forbidden');
    expect(await refusal(() => transfer(d, 't1', 'bob'))).toBe('invalid_request');
    expect(await refusal(() => transfer(d, 't1', 'github:5555'))).toBe('invalid_request');
    expect(await refusal(() => transfer(d, 'nope', bob.sub))).toBe('template_not_found');
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
