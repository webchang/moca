import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  costMib,
  defaultCostMib,
  place,
  readinessOf,
  startRetryAfterS,
  workerOverheadMib,
  type HostView,
} from '../src/activation.js';
import { writeError } from '../src/errors.js';
import { exchangeCredential } from '../src/exchange.js';
import { HANDLERS } from '../src/handlers.js';
import { HostRegistry, parseHostMemory, parseHostStart } from '../src/host-handlers.js';
import { ProvenanceStore, recordDigest as recordDigestOf, sha256Hex } from '../src/provenance.js';
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
import { buildJobSpec } from '../src/host-handlers.js';

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
const inventory = (
  d: TestDeps,
  host: string,
  holds: Record<string, string>,
  activeLimit: number,
  memory?: Record<string, unknown>,
) =>
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
        ...(memory ? { memory } : {}),
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

  it('never evicts for a lease taken in the same second: the tie on since does not reorder placement', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2', bob);
    await inventory(d, 'bm1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 1);
    expect((await activate(d, 't2', bob)).status).toBe(200);
    const e = await activate(d, 't1', alice).catch((x) => x);
    expect(e.code).toBe('no_active_slot');
    expect((await HANDLERS.hostWanted!(asHost('bm1'), d)).body).toMatchObject({
      run: [{ template: 't2' }],
    });
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

  it("a pinned session's seed is its build's, and its span is on the build's chain (§7.1)", async () => {
    const d = await setup();
    attachedNow = ['sbx_t1'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    await seedCredential(d);
    await activate(d, 't1');
    const act = (await d.provenance!.chain('template/t1'))
      .filter((x) => x.kind === 'activate')
      .at(-1)!;
    const r = await HANDLERS.createSession!(
      ctx({ principal: alice, body: { sandbox: { template: `t1@${hash('1')}` } } }),
      d,
    );
    expect(r.status).toBe(201);
    const sid = (r.body as Body).sessionId as string;
    const created = (await d.provenance!.chain('template/t1')).at(-1)!;
    expect(created).toMatchObject({
      kind: 'session',
      subject: alice.sub,
      body: {
        sessionId: sid,
        buildId: hash('1'),
        templateManifestHash: hash('1'),
        lease: recordDigestOf(act),
        state: 'created',
      },
    });
    // The seed is the pinned build's own spec.seed, not the env list's (t1 is in none).
    const ex = await exchangeCredential((r.body as Body).token as string, d);
    expect(ex).toMatchObject({
      sandboxTemplate: 't1',
      sandboxBuildId: hash('1'),
      sandboxSeed: SPEC.seed,
      sandboxSeedSource: 'build',
    });
    expect(SPEC.seed).toBe('cp -a /opt/testbed-src/. /workspace/');
    // Its end, on the same chain, once.
    now += 5000;
    await HANDLERS.deleteSession!(ctx({ principal: alice, params: { id: sid } }), d);
    const ended = (await d.provenance!.chain('template/t1')).at(-1)!;
    expect(ended).toMatchObject({
      kind: 'session',
      body: {
        sessionId: sid,
        buildId: hash('1'),
        state: 'terminated',
        reason: 'deleted',
        endedAt: Math.floor(now / 1000),
      },
    });
    expect(
      (await d.provenance!.chain('template/t1')).filter((x) => x.kind === 'session'),
    ).toHaveLength(2);
  });

  it('a build without a seed sends none, even where the env list declares one', async () => {
    const d = await setup();
    attachedNow = ['sbx_t1'];
    const { seed: _seed, ...noSeed } = BASE_SPEC as Body;
    await HANDLERS.createTemplate!(
      ctx({
        principal: alice,
        body: { id: 't1', image: IMAGE, spec: { ...noSeed, seed: '' }, profile: 'base' },
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
            worker: 'sbx_t1',
            snapshot: 't1-x',
            image: IMAGE,
            guest_ram_mb: 4096,
            manifest_hash: hash('1'),
          }),
          manifest: JSON.stringify({
            hash_version: 2,
            hash: hash('1'),
            guest_ram_mb: 4096,
            vcpus: 2,
            source_image_digest: DIGEST,
          }),
        },
      ),
      d,
    );
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    await seedCredential(d);
    await activate(d, 't1');
    const declared = {
      ...d,
      config: {
        ...d.config,
        sessionTemplates: [
          { id: 't1', worker: 'sbx_t1', description: '', tools: [], seed: 'echo env' },
        ],
      },
    };
    const r = await HANDLERS.createSession!(
      ctx({ principal: alice, body: { sandbox: { template: 't1' } } }),
      declared,
    );
    expect(r.status).toBe(201);
    const ex = await exchangeCredential((r.body as Body).token as string, declared);
    expect(ex).toMatchObject({ sandboxTemplate: 't1', sandboxBuildId: hash('1') });
    expect(ex).not.toHaveProperty('sandboxSeed');
    expect(ex).not.toHaveProperty('sandboxSeedSource');
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

  it('shows which hosts hold a build (heldBy), and a retired one leaving them', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    const held = async () =>
      (
        (
          await HANDLERS.getTemplateBuild!(
            ctx({ principal: alice, params: { id: 't1', build: hash('1') } }),
            d,
          )
        ).body as Body
      ).heldBy;
    // No host has reported, but hosts are configured: an empty list, not null.
    d.config.templateHosts = [
      { id: 'bm1', token: 'f'.repeat(64) },
      { id: 'bm2', token: 'e'.repeat(64) },
    ];
    expect(await held()).toEqual([]);
    await inventory(d, 'bm2', { [hash('1')]: 't1' }, 2);
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    expect(await held()).toEqual(['bm1', 'bm2']);
    await retire(d, 't1');
    await inventory(d, 'bm1', {}, 2);
    expect(await held()).toEqual(['bm2']);
    await inventory(d, 'bm2', {}, 2);
    expect(await held()).toEqual([]);
    // Without host agents, there is nothing to report.
    const plain = await setup();
    await registered(plain, 't2', hash('2'), 'sbx_t2');
    plain.hosts = new HostRegistry();
    const b = (
      await HANDLERS.getTemplateBuild!(
        ctx({ principal: alice, params: { id: 't2', build: hash('2') } }),
        plain,
      )
    ).body as Body;
    expect(b.heldBy).toBe(null);
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

  it('an admin hands a declared template to a subject (G34); a restart keeps it; its new owner retires it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-act-decl-'));
    const declared = [
      { id: 'decl-1', worker: 'sbx_decl_1', description: 'declared', tools: ['bash'] },
    ];
    const provenance = new ProvenanceStore({ dir, now: () => now });
    const mk = () =>
      makeDeps({
        newId: () => `${(++seq).toString(16).padStart(26, '0')}000000`,
        now: () => now,
        templates: new FileTemplateCatalog({ dir, declared, provenance, now: () => now }),
        provenance,
        policy: new FilePolicyStore({ dir, provenance }),
        hosts: new HostRegistry(),
        config: { routeProfile: 'sandbox' },
      });
    const d = mk();
    expect((await d.templates!.get('decl-1'))!.owner).toBe(null);
    // Before: a subject cannot retire it (no owner), as before.
    expect(
      await refusal(() =>
        HANDLERS.retireTemplate!(ctx({ principal: bob, params: { id: 'decl-1' } }), d),
      ),
    ).toBe('forbidden');
    const r = (await transfer(d, 'decl-1', bob.sub)).body as Body;
    expect(r).toMatchObject({ templateId: 'decl-1', owner: bob.sub, before: null });
    expect((await provenance.chain('template/decl-1')).at(-1)).toMatchObject({
      kind: 'owner',
      subject: admin.sub,
      body: { owner: bob.sub, before: null },
    });
    // A restart: a new catalog over the same directory, with the same declared list, does not
    // re-import it or reset its owner (the import runs only into an empty catalog).
    const d2 = mk();
    expect((await d2.templates!.get('decl-1'))!.owner).toBe(bob.sub);
    // Its new owner can now create a build under the id: the create no longer meets another's
    // template (G34's block was `409 template_exists`).
    await d2.policy!.set(DEFAULT_POLICY, 'github:admin');
    const made = await HANDLERS.createTemplateBuild!(
      ctx({
        principal: bob,
        params: { id: 'decl-1' },
        body: { image: IMAGE, spec: BASE_SPEC, profile: 'base' },
      }),
      d2,
    );
    expect(made.status).toBe(202);
    // A retire by the new owner works, as for any template of theirs.
    expect(
      (await HANDLERS.retireTemplate!(ctx({ principal: bob, params: { id: 'decl-1' } }), d2))
        .status,
    ).toBe(200);
    // Retired, the id stays its owner's: another subject's create is still another's template.
    expect(
      await refusal(() =>
        HANDLERS.createTemplate!(
          ctx({
            principal: alice,
            body: { id: 'decl-1', image: IMAGE, spec: BASE_SPEC, profile: 'base' },
          }),
          d2,
        ),
      ),
    ).toBe('template_exists');
  });

  it('refuses a non-admin, and a malformed or unenrolled subject', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    expect(await refusal(() => transfer(d, 't1', bob.sub, alice))).toBe('forbidden');
    expect(await refusal(() => transfer(d, 't1', 'bob'))).toBe('invalid_request');
    expect(await refusal(() => transfer(d, 't1', 'github:5555'))).toBe('invalid_request');
    expect(await refusal(() => transfer(d, 'nope', bob.sub))).toBe('template_not_found');
    // #701: an oidc subject passes the grammar (refused here only as not enrolled); test:N never does.
    const why = (owner: string) =>
      transfer(d, 't1', owner).then(
        () => 'none',
        (e: Error) => e.message,
      );
    expect(await why('oidc:erin@example.com')).not.toMatch(/must be a subject/);
    expect(await why('test:1')).toMatch(/owner must be a subject, github:<numeric id> or oidc:/);
  });
});

describe('admin quotas (§5.2)', () => {
  const refusal = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      return (e as { code: string }).code;
    }
    return 'none';
  };
  const admin = { ...bob, sub: 'github:42', tenant: 'github:42', roles: ['admin'] };
  const putQuota = (d: TestDeps, subject: string, body: unknown, principal = admin) =>
    HANDLERS.putQuota!(ctx({ principal, params: { subject }, body }), d);
  const quotaOf = async (d: TestDeps, principal = alice) =>
    (await HANDLERS.getQuota!(ctx({ principal }), d)).body as Body;

  it("an admin sets one subject's quota and the default; each is a policy record; it is enforced", async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    await inventory(d, 'bm1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 4);
    expect((await quotaOf(d)).quotaSource).toBe('default');
    const before = (await d.provenance!.chain('policy')).length;
    const r = (await putQuota(d, alice.sub, { templates: 5, buildsQueued: 2, active: 1 }))
      .body as Body;
    expect(r).toMatchObject({
      target: alice.sub,
      subject: admin.sub,
      quota: { active: 1 },
      before: null,
    });
    expect(r.record).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await d.provenance!.chain('policy')).length).toBe(before + 1);
    const q = await quotaOf(d);
    expect(q).toMatchObject({
      quotaSource: 'subject',
      active: { limit: 1 },
      templates: { limit: 5 },
    });
    // Bob still has the default.
    expect((await quotaOf(d, bob)).active.limit).toBe(8);
    // Enforced: alice holds one active, so a second activation is over her quota.
    await activate(d, 't1');
    expect(await refusal(() => activate(d, 't2'))).toBe('quota_exceeded');
    // The default too; removing alice's override returns her to it.
    await putQuota(d, 'default', { templates: 100, buildsQueued: 10, active: 3 });
    expect((await quotaOf(d, bob)).active.limit).toBe(3);
    const rm = (await putQuota(d, alice.sub, null)).body as Body;
    expect(rm).toMatchObject({ quota: null, before: { active: 1 } });
    expect(await quotaOf(d)).toMatchObject({ quotaSource: 'default', active: { limit: 3 } });
    expect((await activate(d, 't2')).status).toBe(200);
  });

  it('refuses a non-admin, a bad target and a bad quota', async () => {
    const d = await setup();
    expect(
      await refusal(() =>
        putQuota(d, alice.sub, { templates: 1, buildsQueued: 1, active: 1 }, alice),
      ),
    ).toBe('forbidden');
    expect(
      await refusal(() => putQuota(d, 'alice', { templates: 1, buildsQueued: 1, active: 1 })),
    ).toBe('invalid_request');
    expect(
      await refusal(() => putQuota(d, alice.sub, { templates: -1, buildsQueued: 1, active: 1 })),
    ).toBe('invalid_request');
    expect(await refusal(() => putQuota(d, 'default', null))).toBe('invalid_request');
    expect(
      await refusal(() => putQuota(d, 'test:1', { templates: 1, buildsQueued: 1, active: 1 })),
    ).toBe('invalid_request');
  });

  it("takes an oidc subject's override as a github one's (#701)", async () => {
    const d = await setup();
    const erin = 'oidc:erin@example.com';
    const r = (await putQuota(d, erin, { templates: 2, buildsQueued: 1, active: 1 })).body as Body;
    expect(r).toMatchObject({ target: erin, quota: { templates: 2 }, before: null });
    expect((await putQuota(d, erin, null)).body).toMatchObject({ quota: null });
  });
});

describe('every link of a sandbox is a record digest (§7.1)', () => {
  it('sandbox -> its lease (the activate record) -> the build record; ends and the retire cite them', async () => {
    const d = await setup();
    attachedNow = ['sbx_t1'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1');
    const sb = (
      await HANDLERS.createSandbox!(
        ctx({ principal: alice, body: { template: `t1@${hash('1')}` } }),
        d,
      )
    ).body as Body;
    const chain = await d.provenance!.chain('template/t1');
    const digestOf = (r: (typeof chain)[number]) => recordDigestOf(r);
    const created = chain.find(
      (r) => r.kind === 'sandbox' && (r.body as Body).state === 'created',
    )!;
    expect(created).toMatchObject({
      subject: alice.sub,
      body: { sandboxId: sb.id, buildId: hash('1'), templateManifestHash: hash('1') },
    });
    // The lease is exactly the activate record that granted it.
    const act = chain.find((r) => digestOf(r) === (created.body as Body).lease)!;
    expect(act).toMatchObject({
      kind: 'activate',
      subject: alice.sub,
      body: { buildId: hash('1') },
    });
    // The build record, by its manifest hash, is what the registration check cited.
    const build = chain.find(
      (r) => r.kind === 'build' && (r.body as Body).manifest_hash === hash('1'),
    )!;
    const check = chain.find((r) => r.kind === 'check' && (r.body as Body).at === 'registration')!;
    expect((check.body as Body).build).toBe(digestOf(build));
    // The end, and the retire and the host's removal, cite the same build record.
    await HANDLERS.deleteSandbox!(ctx({ principal: alice, params: { id: sb.id } }), d);
    await HANDLERS.retireTemplate!(ctx({ principal: alice, params: { id: 't1' } }), d);
    await HANDLERS.hostWorkerReport!(
      asHost('bm1', {}, { buildId: hash('1'), event: 'removed' }),
      d,
    );
    const after = await d.provenance!.chain('template/t1');
    expect(
      after.find((r) => r.kind === 'sandbox' && (r.body as Body).state === 'terminated'),
    ).toMatchObject({
      subject: alice.sub,
      body: { sandboxId: sb.id, reason: 'deleted' },
    });
    const retires = after.filter((r) => r.kind === 'retire');
    expect(retires.map((r) => (r.body as Body).buildRecord)).toEqual([
      digestOf(build),
      digestOf(build),
    ]);
  });

  it("an expired sandbox's end is recorded once, by the janitor's sweep, with its true end", async () => {
    const d = await setup();
    attachedNow = ['sbx_t1'];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 2);
    await activate(d, 't1');
    const sb = (
      await HANDLERS.createSandbox!(ctx({ principal: alice, body: { template: 't1' } }), d)
    ).body as Body;
    const janitor = () =>
      HANDLERS.janitorSandboxes!({ ...ctx({}), janitorAuthorized: true } as never, d);
    await janitor();
    const ends = async () =>
      (await d.provenance!.chain('template/t1')).filter(
        (r) => r.kind === 'sandbox' && (r.body as Body).state === 'terminated',
      );
    expect(await ends()).toHaveLength(0);
    now += 8 * 86_400_000;
    await janitor();
    await janitor();
    const e = await ends();
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({
      subject: 'janitor',
      body: { sandboxId: sb.id, reason: 'expired', expiresAt: sb.expiresAt },
    });
  });
});

describe('activation is one check-and-write at a time across templates (G40)', () => {
  /**
   * Holds every `activate` record's append until `release()`: each activation, once past its
   * checks, waits inside its critical section, so without the lock a second activation reads the
   * catalog before the first one's lease is written: a real race, not a sequence.
   */
  function gateActivateRecords(d: TestDeps) {
    const prov = d.provenance!;
    const orig = prov.append.bind(prov);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let entered = 0;
    prov.append = (async (rec: Parameters<typeof orig>[0]) => {
      if (rec.kind === 'activate') {
        entered++;
        await gate;
      }
      return orig(rec);
    }) as typeof prov.append;
    return {
      release: () => open(),
      entered: () => entered,
    };
  }
  /**
   * Starts every op at once, waits until all are held at the gate (or 250 ms: under the lock only
   * one can get there), releases it, and answers each op's outcome: 'ok' or its error code.
   */
  async function race(g: ReturnType<typeof gateActivateRecords>, ops: (() => Promise<unknown>)[]) {
    const all = Promise.allSettled(ops.map((f) => f()));
    for (let i = 0; i < 50 && g.entered() < ops.length; i++)
      await new Promise((r) => setTimeout(r, 5));
    g.release();
    return (await all).map((r) =>
      r.status === 'fulfilled' ? 'ok' : String((r.reason as { code?: string }).code ?? r.reason),
    );
  }
  const liveLeasesOf = async (d: TestDeps) =>
    (await d.templates!.list())
      .flatMap((x) => x.builds)
      .flatMap((b) => (b.leases ?? []).filter((l) => l.until > Math.floor(now / 1000)));

  it("two concurrent activations of different templates never pass one subject's active quota", async () => {
    const d = await setup(2);
    attachedNow = [];
    await registered(d, 't0', hash('0'), 'sbx_t0');
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    await registered(d, 't3', hash('3'), 'sbx_t3');
    await inventory(
      d,
      'bm1',
      { [hash('0')]: 't0', [hash('1')]: 't1', [hash('2')]: 't2', [hash('3')]: 't3' },
      8,
    );
    await activate(d, 't0'); // one of alice's two held already: room for exactly one more
    const g = gateActivateRecords(d);
    const out = await race(g, [
      () => activate(d, 't1'),
      () => activate(d, 't2'),
      () => activate(d, 't3'),
    ]);
    expect(out.filter((x) => x === 'ok')).toHaveLength(1);
    expect(out.filter((x) => x === 'quota_exceeded')).toHaveLength(2);
    expect((await liveLeasesOf(d)).filter((l) => l.subject === alice.sub)).toHaveLength(2);
    // Every kept lease names its record, and no refused one left a record.
    const recs = (
      await Promise.all(['t0', 't1', 't2', 't3'].map((id) => d.provenance!.chain(`template/${id}`)))
    )
      .flat()
      .filter((r) => r.kind === 'activate');
    expect(recs).toHaveLength(2);
    for (const l of await liveLeasesOf(d))
      expect(recs.map((r) => recordDigestOf(r))).toContain(l.record);
  });

  it("two concurrent activations of different templates never pass a host's activeLimit", async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2', bob);
    await inventory(d, 'bm1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 1);
    const g = gateActivateRecords(d);
    const out = await race(g, [() => activate(d, 't1', alice), () => activate(d, 't2', bob)]);
    expect([...out].sort()).toEqual(['no_active_slot', 'ok']);
    expect(await liveLeasesOf(d)).toHaveLength(1);
    expect((await HANDLERS.hostWanted!(asHost('bm1'), d)).body).toMatchObject({
      run: [{ template: out[0] === 'ok' ? 't1' : 't2' }],
    });
  });

  it('activation on first use takes the same lock as an owner activation', async () => {
    const d = await setup(1);
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    await inventory(d, 'bm1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 4);
    const g = gateActivateRecords(d);
    const out = await race(g, [
      () => activate(d, 't1'),
      () => HANDLERS.createSandbox!(ctx({ principal: alice, body: { template: 't2' } }), d),
    ]);
    // The first-use create answers template_not_active when it took the lease, quota_exceeded when not.
    expect(
      (out[0] === 'ok' && out[1] === 'quota_exceeded') ||
        (out[0] === 'quota_exceeded' && out[1] === 'template_not_active'),
    ).toBe(true);
    expect((await liveLeasesOf(d)).filter((l) => l.subject === alice.sub)).toHaveLength(1);
  });

  it('a renewal does not count against itself, also beside a concurrent activation', async () => {
    const d = await setup(1);
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    await inventory(d, 'bm1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 1);
    const first = (await activate(d, 't1', alice, { leaseSeconds: 600 })).body as Body;
    now += 60_000;
    const g = gateActivateRecords(d);
    const out = await race(g, [
      () => activate(d, 't1', alice, { leaseSeconds: 600 }),
      () => activate(d, 't2', alice),
    ]);
    expect(out).toEqual(['ok', 'quota_exceeded']);
    const ls = await liveLeasesOf(d);
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ subject: alice.sub, until: first.leaseUntil + 60 });
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

describe('memory-aware placement (register G39)', () => {
  const G = 4096 + workerOverheadMib; // a 4 GiB guest's cost
  const doc = (
    id: string,
    h: string,
    sinceS: number,
    guest?: number,
    leased = true,
  ): TemplateDoc => ({
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
        spec: { tools: [], ...(guest !== undefined ? { guest_mb: guest } : {}) },
        createdAt: 0,
        leases: leased ? [{ subject: 'github:1', until: 10_000, since: sinceS }] : [],
      },
    ],
    createdAt: 0,
  });
  /** A host at time 100 with `headroom` MiB free above a 4096 floor, both bounds alike. */
  const host = (
    id: string,
    holds: string[],
    headroom: number,
    extra: Partial<NonNullable<HostView['memory']>> = {},
    activeLimit = 8,
    at = 100,
  ): HostView => ({
    id,
    holds: Object.fromEntries(holds.map((h) => [h, 'x'])),
    activeLimit,
    at,
    memory: {
      totalMib: 4096 + headroom,
      availableMib: 4096 + headroom,
      floorMib: 4096,
      pressureLimit: 10,
      ...extra,
    },
  });

  it("costs a build its guest RAM plus the worker's overhead; one with no guest size at 4096", () => {
    expect(costMib(doc('a', hash('a'), 0, 2048).builds[0]!)).toBe(2048 + 128);
    expect(costMib(doc('a', hash('a'), 0).builds[0]!)).toBe(defaultCostMib + 128);
    expect(workerOverheadMib).toBe(128);
  });

  it('a 4 GiB build skips a host with 3 GiB of headroom and goes to one with 8 GiB', () => {
    // h1 sorts first by id and has fewer builds: only memory sends the build to h2.
    const p = place(
      [doc('a', hash('a'), 1, 4096)],
      [host('h1', [hash('a')], 3072), host('h2', [hash('a')], 8192)],
      100,
    );
    expect(p.placed.get(hash('a'))).toBe('h2');
    expect(p.memory.get('h1')).toEqual({
      usedMib: 0,
      pendingMib: 0,
      headroomMib: 3072,
      brake: null,
    });
    expect(p.memory.get('h2')).toMatchObject({ usedMib: G, headroomMib: 8192 - G });
    const only = place([doc('a', hash('a'), 1, 4096)], [host('h1', [hash('a')], 3072)], 100);
    expect(only.unplaced.get(hash('a'))).toBe('memory');
  });

  it('two builds placed in one pass both count against the same host', () => {
    const docs = [doc('a', hash('a'), 1, 4096), doc('b', hash('b'), 2, 4096)];
    const p = place(docs, [host('h1', [hash('a'), hash('b')], 2 * G - 1)], 100);
    expect(p.placed.get(hash('a'))).toBe('h1');
    expect(p.unplaced.get(hash('b'))).toBe('memory');
    // The available bound alone (total ample) binds the same way: pending starts come off it.
    const wide = host('h1', [hash('a'), hash('b')], 2 * G - 1, { totalMib: 1_000_000 });
    expect(place(docs, [wide], 100).unplaced.get(hash('b'))).toBe('memory');
    expect(place(docs, [host('h1', [hash('a'), hash('b')], 2 * G)], 100).placed.size).toBe(2);
  });

  it("counts running workers (any build's, wanted or not) and their VMs' committed memory", () => {
    const docs = [doc('a', hash('a'), 1, 4096), doc('idle', hash('i'), 0, 2048, false)];
    // 2 G of headroom by the figures, but the idle build's worker runs (2176) and VMs hold 1000.
    const h = host('h1', [hash('a'), hash('i')], 2 * G, {
      availableMib: 1_000_000,
      running: ['w_idle'],
      vmCommittedMib: { w_idle: 1000 },
    });
    expect(place(docs, [h], 100).memory.get('h1')!.usedMib).toBe(2176 + 1000 + G);
    const tight = host('h1', [hash('a'), hash('i')], 2176 + 1000 + G - 1, {
      availableMib: 1_000_000,
      running: ['w_idle'],
      vmCommittedMib: { w_idle: 1000 },
    });
    expect(place(docs, [tight], 100).unplaced.get(hash('a'))).toBe('memory');
    // A running worker of no known build counts at the default cost.
    const stray = host('h1', [hash('a')], G + defaultCostMib + 127, {
      availableMib: 1_000_000,
      running: ['w_unknown'],
    });
    expect(place([doc('a', hash('a'), 1, 4096)], [stray], 100).unplaced.get(hash('a'))).toBe(
      'memory',
    );
  });

  it('a stale inventory (over 60 s) gives no headroom for new starts, and keeps what runs', () => {
    const docs = [doc('a', hash('a'), 1, 4096), doc('b', hash('b'), 2, 4096)];
    const h = host('h1', [hash('a'), hash('b')], 100_000, { running: ['w_a'] }, 8, 100);
    expect(place(docs, [h], 160).placed.size).toBe(2);
    const p = place(docs, [h], 161);
    expect(p.placed.get(hash('a'))).toBe('h1'); // its worker runs: kept
    expect(p.unplaced.get(hash('b'))).toBe('memory');
    expect(p.memory.get('h1')!.brake).toBe('stale');
  });

  it('pressure above the limit blocks new starts but keeps placed (running) ones', () => {
    const docs = [doc('a', hash('a'), 1, 4096), doc('b', hash('b'), 2, 4096)];
    const at = (psi: number) =>
      host('h1', [hash('a'), hash('b')], 100_000, { running: ['w_a'], pressureFull10: psi });
    expect(place(docs, [at(10)], 100).placed.size).toBe(2); // at the limit: not above it
    const p = place(docs, [at(10.5)], 100);
    expect(p.placed.get(hash('a'))).toBe('h1');
    expect(p.unplaced.get(hash('b'))).toBe('memory');
    expect(p.memory.get('h1')!.brake).toBe('pressure');
    // No PSI reported (no /proc/pressure): no brake.
    expect(place(docs, [host('h1', [hash('a'), hash('b')], 100_000)], 100).placed.size).toBe(2);
  });

  it('never places a build on a host that reports its memory file wrong; elsewhere it may go', () => {
    const docs = [doc('a', hash('a'), 1, 4096)];
    const bad = host('h1', [hash('a')], 100_000, { memfileMismatch: [hash('a')] });
    expect(place(docs, [bad], 100).unplaced.get(hash('a'))).toBe('memfile_mismatch');
    expect(place(docs, [bad, host('h2', [hash('a')], 100_000)], 100).placed.get(hash('a'))).toBe(
      'h2',
    );
  });

  it('a host without memory figures places exactly by activeLimit, as before', () => {
    const docs = [doc('a', hash('a'), 1, 4096), doc('b', hash('b'), 2, 4096)];
    const bare: HostView = {
      id: 'h1',
      holds: { [hash('a')]: 'a', [hash('b')]: 'b' },
      activeLimit: 1,
    };
    const p = place(docs, [bare], 100);
    expect([...p.placed]).toEqual([[hash('a'), 'h1']]);
    expect(p.unplaced.get(hash('b'))).toBe('no_slot');
    expect(p.memory.size).toBe(0);
    // Workers or a PSI reading without the figures change nothing either.
    const partial = { ...bare, activeLimit: 2, memory: { running: ['w_x'], pressureFull10: 99 } };
    expect(place(docs, [partial], 100).placed.size).toBe(2);
    // At its activeLimit, a memory-reporting host still says no_slot (the limit binds first).
    expect(
      place(docs, [host('h1', [hash('a'), hash('b')], 100_000, {}, 1)], 100).unplaced.get(
        hash('b'),
      ),
    ).toBe('no_slot');
  });

  it('keeps the memory fields of an inventory, drops malformed ones, and needs all three figures', () => {
    expect(parseHostMemory(undefined)).toBeUndefined();
    expect(parseHostMemory([1])).toBeUndefined();
    expect(
      parseHostMemory({
        memTotalMib: 16384,
        memAvailableMib: 12288,
        memFloorMib: 4096,
        memPressureFull10: 0.25,
        memPressureLimit: 10,
        runningWorkers: ['sbx_a', '../x', 3],
        vmCommittedMib: { sbx_a: 512, 'bad id': 1, sbx_b: -1 },
        memfileMismatch: [hash('a'), 'nope'],
      }),
    ).toEqual({
      totalMib: 16384,
      availableMib: 12288,
      floorMib: 4096,
      pressureFull10: 0.25,
      pressureLimit: 10,
      running: ['sbx_a'],
      vmCommittedMib: { sbx_a: 512 },
      memfileMismatch: [hash('a')],
    });
    expect(parseHostMemory({ memTotalMib: 16384, memAvailableMib: 12288 })).toEqual({});
    expect(parseHostMemory({ memTotalMib: 1.5, memAvailableMib: 1, memFloorMib: 1 })).toEqual({});
  });
});

describe('memory-aware placement through the routes (register G39)', () => {
  /** 16 GiB, a 4096 floor: `free` MiB of headroom. */
  const mem = (free: number, extra: Record<string, unknown> = {}) => ({
    memTotalMib: 4096 + free,
    memAvailableMib: 4096 + free,
    memFloorMib: 4096,
    memPressureLimit: 10,
    runningWorkers: [],
    vmCommittedMib: {},
    memfileMismatch: [],
    ...extra,
  });
  const G = 4096 + workerOverheadMib;
  const writeOf = (e: unknown) => {
    const res = { status: 0, headers: {} as Record<string, string>, body: '' };
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
    return { ...res, json: JSON.parse(res.body) as Body };
  };

  it('a 409 no_active_slot names memory, with Retry-After; readiness is unavailable for memory', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2', bob);
    await inventory(d, 'bm1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 4, mem(G + 100));
    await activate(d, 't1', alice, { leaseSeconds: 600 });
    const e = await activate(d, 't2', bob).catch((x) => x);
    expect(e.code).toBe('no_active_slot');
    const w = writeOf(e);
    expect(w.status).toBe(409);
    expect(w.headers['Retry-After']).toBe('600');
    expect(w.json).toMatchObject({
      error: 'no_active_slot',
      readiness: 'unavailable',
      reason: 'memory',
    });
    // The refusal kept no lease.
    const t2 = (await HANDLERS.getTemplate!(ctx({ principal: bob, params: { id: 't2' } }), d))
      .body as Body;
    expect(t2.readiness).toBe('inactive');
    // Make t2 wanted (its lease written behind placement's back, as a shared lease would be), and
    // its readiness says why it waits.
    await d.templates!.update!('t2', async (cur) => ({
      ...cur!,
      builds: cur!.builds.map((b) => ({
        ...b,
        leases: [
          {
            subject: bob.sub,
            until: Math.floor(now / 1000) + 600,
            since: Math.floor(now / 1000) + 1,
          },
        ],
      })),
    }));
    const t2b = (await HANDLERS.getTemplate!(ctx({ principal: bob, params: { id: 't2' } }), d))
      .body as Body;
    expect(t2b.readiness).toBe('unavailable');
    expect(t2b.readinessReason).toBe('memory');
    expect(t2b.builds[0]).toMatchObject({ readiness: 'unavailable', readinessReason: 'memory' });
    // A create on it answers template_not_active with that reason.
    const c = await HANDLERS.createSandbox!(
      ctx({ principal: bob, body: { template: 't2' } }),
      d,
    ).catch((x) => x);
    expect(c.code).toBe('template_not_active');
    expect(c.extra).toMatchObject({ readiness: 'unavailable', reason: 'memory' });
    // At the active limit with memory to spare, the refusal is as before: no reason field.
    await inventory(d, 'bm1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 1, mem(100_000));
    const e2 = await activate(d, 't2', bob).catch((x) => x);
    expect(e2.code).toBe('no_active_slot');
    expect(e2.extra).toEqual({ readiness: 'unavailable' });
    const t2c = (await HANDLERS.getTemplate!(ctx({ principal: bob, params: { id: 't2' } }), d))
      .body as Body;
    expect(t2c.builds[0]).toMatchObject({ readiness: 'unavailable', readinessReason: 'no_slot' });
  });

  it('an older agent (no memory) places by activeLimit alone, and the hosts block has no memory', async () => {
    const d = await setup();
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    await inventory(d, 'bm1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 2);
    expect((await activate(d, 't1')).status).toBe(200);
    expect((await activate(d, 't2')).status).toBe(200);
    const b = (await HANDLERS.listTemplates!(ctx({ principal: alice }), d)).body as Body;
    expect(b.hosts[0]).not.toHaveProperty('memory');
    expect(b.templates.every((t: Body) => !('readinessReason' in t))).toBe(true);
  });

  it('shows the memory and the effective floor in the hosts block', async () => {
    const d = await setup();
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(
      d,
      'bm1',
      { [hash('1')]: 't1' },
      4,
      mem(16384, {
        memPressureFull10: 0.5,
        runningWorkers: ['sbx_x'],
        vmCommittedMib: { sbx_x: 300 },
      }),
    );
    await activate(d, 't1');
    const b = (await HANDLERS.listTemplates!(ctx({ principal: alice }), d)).body as Body;
    expect(b.hosts[0].memory).toEqual({
      totalMib: 20480,
      availableMib: 20480,
      floorMib: 4096,
      // sbx_x is no build's worker: it counts at the default cost (4096 + 128).
      usedMib: 4224 + 300 + G,
      headroomMib: Math.min(16384 - (4224 + 300 + G), 16384 - G),
      pressureFull10: 0.5,
      pressureLimit: 10,
      brake: null,
      runningWorkers: 1,
      memfileMismatch: [],
      reportedAt: Math.floor(now / 1000),
    });
  });

  it('a stale inventory takes no new start; a memfile mismatch on every holder is template_unavailable', async () => {
    const d = await setup();
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 4, mem(100_000));
    now += 61_000;
    const e = await activate(d, 't1').catch((x) => x);
    expect(e.code).toBe('no_active_slot');
    expect(e.extra).toMatchObject({ reason: 'memory' });
    const b = (await HANDLERS.listTemplates!(ctx({ principal: alice }), d)).body as Body;
    expect(b.hosts[0].memory).toMatchObject({ brake: 'stale', headroomMib: 0 });
    await inventory(
      d,
      'bm1',
      { [hash('1')]: 't1' },
      4,
      mem(100_000, { memfileMismatch: [hash('1')] }),
    );
    const m = await activate(d, 't1').catch((x) => x);
    expect(m.code).toBe('template_unavailable');
    expect(m.extra).toEqual({ readiness: 'unavailable', reason: 'memfile_mismatch' });
    await inventory(d, 'bm1', { [hash('1')]: 't1' }, 4, mem(100_000));
    expect((await activate(d, 't1')).status).toBe(200);
  });

  it("the wanted state runs only what fits a host's memory", async () => {
    const d = await setup();
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    await inventory(d, 'bm1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 4, mem(100_000));
    await activate(d, 't1');
    now += 1000;
    await activate(d, 't2');
    // The host's memory shrinks (another workload): the placed builds stay only while their workers
    // run; t1's runs, t2's has not started and no longer fits.
    await inventory(
      d,
      'bm1',
      { [hash('1')]: 't1', [hash('2')]: 't2' },
      4,
      mem(G + 10, { runningWorkers: ['sbx_t1'] }),
    );
    const w = (await HANDLERS.hostWanted!(asHost('bm1'), d)).body as Body;
    expect(w.run.map((x: Body) => x.template)).toEqual(['t1']);
  });

  it('two concurrent activations onto one host with headroom for one: one is placed (G40 lock)', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2', bob);
    await inventory(d, 'bm1', { [hash('1')]: 't1', [hash('2')]: 't2' }, 8, mem(2 * G - 1));
    const prov = d.provenance!;
    const orig = prov.append.bind(prov);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let entered = 0;
    prov.append = (async (rec: Parameters<typeof orig>[0]) => {
      if (rec.kind === 'activate') {
        entered++;
        await gate;
      }
      return orig(rec);
    }) as typeof prov.append;
    const all = Promise.allSettled([activate(d, 't1', alice), activate(d, 't2', bob)]);
    for (let i = 0; i < 50 && entered < 2; i++) await new Promise((r) => setTimeout(r, 5));
    open();
    const out = (await all).map((r) =>
      r.status === 'fulfilled' ? 'ok' : String((r.reason as { code?: string }).code),
    );
    expect([...out].sort()).toEqual(['no_active_slot', 'ok']);
    const refused = (await all).find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason.extra).toMatchObject({ reason: 'memory' });
    const leases = (await d.templates!.list())
      .flatMap((x) => x.builds)
      .flatMap((b) => (b.leases ?? []).filter((l) => l.until > Math.floor(now / 1000)));
    expect(leases).toHaveLength(1);
  });
});

describe('cold-start pacing: the start limit (register G43)', () => {
  const createSandbox = (d: TestDeps, body: Record<string, unknown>, principal = alice) =>
    HANDLERS.createSandbox!(ctx({ principal, body }), d);
  const retryOf = async (f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      const x = e as { code: string; retryAfterS?: number };
      return { code: x.code, retryAfterS: x.retryAfterS };
    }
    return { code: 'none' };
  };
  /** An inventory whose limits carry the agent's start figures (G43), or none (an older agent). */
  const inventoryStart = (
    d: TestDeps,
    host: string,
    holds: Record<string, string>,
    start: Record<string, unknown> | null,
    extra: Record<string, unknown> = {},
  ) =>
    HANDLERS.hostInventory!(
      asHost(
        host,
        {},
        {
          holds: Object.entries(holds).map(([manifestHash, template]) => ({
            manifestHash,
            template,
          })),
          limits: { activeLimit: 8, idleLimitSeconds: 3600, ...(start ?? {}) },
          ...extra,
        },
      ),
      d,
    );
  const build = async (d: TestDeps, id: string) =>
    ((await HANDLERS.getTemplate!(ctx({ principal: alice, params: { id } }), d)).body as Body)
      .builds[0] as Body;
  const holds3 = { [hash('1')]: 't1', [hash('2')]: 't2', [hash('3')]: 't3' };
  const three = async (d: TestDeps) => {
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    await registered(d, 't3', hash('3'), 'sbx_t3');
  };

  it('the wanted answer lists, of run, the builds not attached (starting), in the wanted order', async () => {
    const d = await setup();
    attachedNow = [];
    await three(d);
    await inventoryStart(d, 'bm1', holds3, { startConcurrency: 2 });
    // Leased t3, then t1, then t2: run and starting follow the leases, first leased first.
    await activate(d, 't3');
    now += 1000;
    await activate(d, 't1');
    now += 1000;
    await activate(d, 't2');
    let w = (await HANDLERS.hostWanted!(asHost('bm1'), d)).body as Body;
    expect(w.run.map((x: Body) => x.template)).toEqual(['t3', 't1', 't2']);
    expect(w.starting).toEqual([hash('3'), hash('1'), hash('2')]);
    // t3 attaches: it is no longer starting, and still in run.
    attachedNow = ['sbx_t3'];
    w = (await HANDLERS.hostWanted!(asHost('bm1'), d)).body as Body;
    expect(w.run.map((x: Body) => x.template)).toEqual(['t3', 't1', 't2']);
    expect(w.starting).toEqual([hash('1'), hash('2')]);
    // Another host's builds are never in this host's starting.
    expect(((await HANDLERS.hostWanted!(asHost('bm2'), d)).body as Body).starting).toEqual([]);
  });

  it('leaves starting out when the presence cannot be read (the agent counts its own starts)', async () => {
    const d = await setup();
    attachedNow = [];
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventoryStart(d, 'bm1', { [hash('1')]: 't1' }, { startConcurrency: 4 });
    await activate(d, 't1');
    d.presence = {
      list: async () => {
        throw new Error('relay down');
      },
    };
    const w = (await HANDLERS.hostWanted!(asHost('bm1'), d)).body as Body;
    expect(w.run).toHaveLength(1);
    expect(w).not.toHaveProperty('starting');
  });

  it('reads a build beyond its host start limit as activating, queued, with its 1-based position', async () => {
    const d = await setup();
    attachedNow = [];
    await three(d);
    await inventoryStart(d, 'bm1', holds3, { startConcurrency: 2, startSeconds: 40 });
    for (const id of ['t1', 't2', 't3']) {
      await activate(d, id);
      now += 1000;
    }
    await inventoryStart(d, 'bm1', holds3, { startConcurrency: 2, startSeconds: 40 });
    expect(await build(d, 't1')).toMatchObject({
      readiness: 'activating',
      queued: false,
      queuePosition: 1,
    });
    expect(await build(d, 't2')).toMatchObject({ queued: false, queuePosition: 2 });
    expect(await build(d, 't3')).toMatchObject({
      readiness: 'activating',
      queued: true,
      queuePosition: 3,
    });
    // t1 attaches: it leaves the line (active, no queue fields), and t3 moves up into a slot.
    attachedNow = ['sbx_t1'];
    const b1 = await build(d, 't1');
    expect(b1.readiness).toBe('active');
    expect(b1).not.toHaveProperty('queued');
    expect(await build(d, 't3')).toMatchObject({ queued: false, queuePosition: 2 });
    // The hosts block shows the host's start figures and its line.
    const list = (await HANDLERS.listTemplates!(ctx({ principal: alice }), d)).body as Body;
    expect(list.hosts[0].start).toEqual({ concurrency: 2, seconds: 40, starting: 2, queued: 0 });
    attachedNow = [];
    const list2 = (await HANDLERS.listTemplates!(ctx({ principal: alice }), d)).body as Body;
    expect(list2.hosts[0].start).toEqual({ concurrency: 2, seconds: 40, starting: 2, queued: 1 });
  });

  it("answers template_not_active with Retry-After from the build's position: ceil(position / concurrency) x startSeconds", async () => {
    const d = await setup();
    attachedNow = [];
    await three(d);
    await inventoryStart(d, 'bm1', holds3, { startConcurrency: 2, startSeconds: 40 });
    await activate(d, 't1');
    now += 1000;
    await activate(d, 't2');
    now += 1000;
    await inventoryStart(d, 'bm1', holds3, { startConcurrency: 2, startSeconds: 40 });
    // First use of t3 takes its lease: third in line, the second wave, 2 x 40 s.
    expect(await retryOf(() => createSandbox(d, { template: 't3' }))).toEqual({
      code: 'template_not_active',
      retryAfterS: 80,
    });
    // t1 is first in line: the first wave.
    expect(await retryOf(() => createSandbox(d, { template: 't1' }))).toEqual({
      code: 'template_not_active',
      retryAfterS: 40,
    });
    // One start at a time: the third waits three waves (3 x 37.4 s, rounded up).
    await inventoryStart(d, 'bm1', holds3, { startConcurrency: 1, startSeconds: 37.4 });
    expect(await retryOf(() => createSandbox(d, { template: 't3' }))).toEqual({
      code: 'template_not_active',
      retryAfterS: 113,
    });
    // No start measured yet: the line is shown, and Retry-After is as before.
    await inventoryStart(d, 'bm1', holds3, { startConcurrency: 2 });
    expect(await build(d, 't3')).toMatchObject({ queued: true, queuePosition: 3 });
    expect(await retryOf(() => createSandbox(d, { template: 't3' }))).toEqual({
      code: 'template_not_active',
      retryAfterS: 30,
    });
    const list = (await HANDLERS.listTemplates!(ctx({ principal: alice }), d)).body as Body;
    expect(list.hosts[0].start).toEqual({ concurrency: 2, seconds: null, starting: 2, queued: 1 });
  });

  it('changes nothing for an agent that reports no startConcurrency (version skew)', async () => {
    const d = await setup();
    attachedNow = [];
    await three(d);
    await inventoryStart(d, 'bm1', holds3, null);
    for (const id of ['t1', 't2', 't3']) {
      await activate(d, id);
      now += 1000;
    }
    await inventoryStart(d, 'bm1', holds3, null);
    const b3 = await build(d, 't3');
    expect(b3.readiness).toBe('activating');
    expect(b3).not.toHaveProperty('queued');
    expect(b3).not.toHaveProperty('queuePosition');
    expect(await retryOf(() => createSandbox(d, { template: 't3' }))).toEqual({
      code: 'template_not_active',
      retryAfterS: 30,
    });
    const list = (await HANDLERS.listTemplates!(ctx({ principal: alice }), d)).body as Body;
    expect(list.hosts[0]).not.toHaveProperty('start');
    // A malformed figure is dropped, never guessed: no start line either.
    for (const bad of [
      { startConcurrency: 0 },
      { startConcurrency: -1 },
      { startConcurrency: 1.5 },
    ]) {
      await inventoryStart(d, 'bm1', holds3, { ...bad, startSeconds: 40 });
      expect(await build(d, 't3')).not.toHaveProperty('queued');
    }
    expect(parseHostStart({ startConcurrency: 4, startSeconds: -3 })).toEqual({ concurrency: 4 });
    expect(parseHostStart({ startSeconds: 40 })).toBeUndefined();
  });

  it('places a build on a host already running its worker, with or without memory figures', () => {
    const doc = (id: string, h: string): TemplateDoc => ({
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
          leases: [{ subject: 'github:1', until: 10_000, since: 1 }],
        },
      ],
      createdAt: 0,
    });
    const docs = [doc('a', hash('a'))];
    const holds = { [hash('a')]: 'a' };
    // Without memory figures: h1 first by id, unless h2 runs w_a.
    const bare = (running?: string[]): HostView[] => [
      { id: 'h1', holds, activeLimit: 4, at: 100 },
      {
        id: 'h2',
        holds,
        activeLimit: 4,
        at: 100,
        ...(running ? { memory: { running } } : {}),
      },
    ];
    expect(place(docs, bare(), 100).placed.get(hash('a'))).toBe('h1');
    expect(place(docs, bare([]), 100).placed.get(hash('a'))).toBe('h1');
    expect(place(docs, bare(['w_a']), 100).placed.get(hash('a'))).toBe('h2');
    // With memory figures, as G39 already did.
    const mem = { totalMib: 65536, availableMib: 60000, floorMib: 4096, pressureLimit: 10 };
    const fig: HostView[] = [
      { id: 'h1', holds, activeLimit: 4, at: 100, memory: { ...mem, running: [] } },
      { id: 'h2', holds, activeLimit: 4, at: 100, memory: { ...mem, running: ['w_a'] } },
    ];
    expect(place(docs, fig, 100).placed.get(hash('a'))).toBe('h2');
    // A running worker on a host without figures is not charged memory anywhere.
    const p = place(
      docs,
      [fig[0]!, { id: 'h2', holds, activeLimit: 4, memory: { running: ['w_a'] } }],
      100,
    );
    expect(p.placed.get(hash('a'))).toBe('h2');
    expect(p.memory.get('h1')!.pendingMib).toBe(0);
  });

  it('computes the start line and its estimate purely', () => {
    expect(startRetryAfterS({ host: 'h', position: 5, queued: true }, undefined)).toBeNull();
    const h: HostView = {
      id: 'h',
      holds: {},
      activeLimit: 8,
      start: { concurrency: 4, seconds: 37 },
    };
    expect(startRetryAfterS({ host: 'h', position: 1, queued: false }, h)).toBe(37);
    expect(startRetryAfterS({ host: 'h', position: 4, queued: false }, h)).toBe(37);
    expect(startRetryAfterS({ host: 'h', position: 5, queued: true }, h)).toBe(74);
    expect(startRetryAfterS({ host: 'h', position: 28, queued: true }, h)).toBe(7 * 37);
    expect(
      startRetryAfterS(
        { host: 'h', position: 1, queued: false },
        { ...h, start: { concurrency: 4 } },
      ),
    ).toBeNull();
  });
});

describe('cold-start pacing: the idle grace (register G43)', () => {
  const GRACE = 600;
  const nowS = () => Math.floor(now / 1000);
  /**
   * An inventory with the agent's idle grace (null: an agent that reports none) and the workers it
   * runs (runningWorkers); memory figures only when given.
   */
  const inventoryGrace = (
    d: TestDeps,
    holds: Record<string, string>,
    grace: unknown,
    running: string[],
    activeLimit = 8,
    figures: Record<string, unknown> = {},
  ) =>
    HANDLERS.hostInventory!(
      asHost(
        'bm1',
        {},
        {
          holds: Object.entries(holds).map(([manifestHash, template]) => ({
            manifestHash,
            template,
          })),
          limits: {
            activeLimit,
            idleLimitSeconds: 3600,
            ...(grace === null ? {} : { idleGraceSeconds: grace }),
          },
          memory: { runningWorkers: running, ...figures },
        },
      ),
      d,
    );
  const wanted = async (d: TestDeps) => (await HANDLERS.hostWanted!(asHost('bm1'), d)).body as Body;
  const ids = (xs: Body[]) => xs.map((x) => x.template);
  const build = async (d: TestDeps, id: string) =>
    ((await HANDLERS.getTemplate!(ctx({ principal: alice, params: { id } }), d)).body as Body)
      .builds[0] as Body;
  const deactivate = (d: TestDeps, id: string, body: unknown = {}, principal = alice) =>
    HANDLERS.deactivateTemplate!(ctx({ principal, params: { id }, body }), d);
  const hostsBlock = async (d: TestDeps) =>
    ((await HANDLERS.listTemplates!(ctx({ principal: alice }), d)).body as Body).hosts[0] as Body;
  const one = { [hash('1')]: 't1' };
  const two = { [hash('1')]: 't1', [hash('2')]: 't2' };
  /** t1 registered, leased, running and attached on bm1, then released by alice at `released`. */
  const released = async (grace: unknown = GRACE, holds = one, activeLimit = 8) => {
    const d = await setup();
    await registered(d, 't1', hash('1'), 'sbx_t1');
    if (holds !== one) await registered(d, 't2', hash('2'), 'sbx_t2');
    await inventoryGrace(d, holds, grace, [], activeLimit);
    await activate(d, 't1');
    attachedNow = ['sbx_t1'];
    await inventoryGrace(d, holds, grace, ['sbx_t1'], activeLimit);
    now += 10_000;
    await deactivate(d, 't1');
    return d;
  };

  it('with no grace (0, or an agent that reports none), a released build is stopped as today', async () => {
    for (const g of [0, null, -1, 1.5, '600', 86_401]) {
      const d = await released(g);
      const w = await wanted(d);
      expect(ids(w.stop)).toEqual(['t1']);
      expect(w.run).toEqual([]);
      expect(w).not.toHaveProperty('graced');
      expect(await build(d, 't1')).not.toHaveProperty('graced');
      const h = await hostsBlock(d);
      expect(h).not.toHaveProperty('graced');
      expect(h).not.toHaveProperty('idleGraceSeconds');
      expect(d.hosts!.get('bm1')!.idleGraceSeconds ?? 0).toBe(0);
    }
  });

  it('keeps a released build in run, graced, until its last lease end + the grace; then stop', async () => {
    const d = await released();
    const end = nowS();
    let w = await wanted(d);
    expect(ids(w.run)).toEqual(['t1']);
    expect(w.graced).toEqual([hash('1')]);
    expect(w.stop).toEqual([]);
    expect(w.starting).toEqual([]);
    const b = await build(d, 't1');
    expect(b).toMatchObject({ readiness: 'deactivating', graced: true, gracedUntil: end + GRACE });
    expect(await hostsBlock(d)).toMatchObject({
      idleGraceSeconds: GRACE,
      graced: 1,
      active: { limit: 8, used: 0 },
    });
    // The record of the release, as today (no stopNow).
    const rec = (await d.provenance!.chain('template/t1')).at(-1)!;
    expect(rec).toMatchObject({ kind: 'deactivate', body: { leases: 1, all: false } });
    expect(rec.body).not.toHaveProperty('stopNow');
    // The grace ends: stopped.
    now += (GRACE - 1) * 1000;
    expect((await wanted(d)).graced).toEqual([hash('1')]);
    now += 1000;
    await inventoryGrace(d, one, GRACE, ['sbx_t1']);
    w = await wanted(d);
    expect(ids(w.stop)).toEqual(['t1']);
    expect(w.run).toEqual([]);
    expect(w.graced).toEqual([]);
    expect(await build(d, 't1')).not.toHaveProperty('graced');
    expect((await hostsBlock(d)).graced).toBe(0);
  });

  it('graces from the end of a lease that ran out, not only a deactivate', async () => {
    const d = await setup();
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventoryGrace(d, one, GRACE, []);
    await activate(d, 't1', alice, { leaseSeconds: 120 });
    const until = nowS() + 120;
    attachedNow = ['sbx_t1'];
    now += 200_000;
    await inventoryGrace(d, one, GRACE, ['sbx_t1']);
    expect((await wanted(d)).graced).toEqual([hash('1')]);
    expect((await build(d, 't1')).gracedUntil).toBe(until + GRACE);
    // A worker the agent does not report running is never graced (nothing to keep).
    await inventoryGrace(d, one, GRACE, []);
    expect(ids((await wanted(d)).stop)).toEqual(['t1']);
  });

  it('a lease taken during the grace keeps the worker running, un-graced; first use serves at once', async () => {
    const d = await released();
    expect((await wanted(d)).graced).toEqual([hash('1')]);
    // First use on the graced, attached worker: a lease, and the create succeeds with no wait.
    const sb = await HANDLERS.createSandbox!(ctx({ principal: bob, body: { template: 't1' } }), d);
    expect(sb.status).toBe(201);
    const w = await wanted(d);
    expect(ids(w.run)).toEqual(['t1']);
    expect(w.graced).toEqual([]);
    expect(w.stop).toEqual([]);
    const b = await build(d, 't1');
    expect(b.readiness).toBe('active');
    expect(b).not.toHaveProperty('graced');
  });

  it('a wanted build that needs the slot displaces the graced worker (activeLimit)', async () => {
    const d = await released(GRACE, two, 1);
    expect((await wanted(d)).graced).toEqual([hash('1')]);
    // t2 fits only in t1's slot: placed, not refused, and t1 is stopped.
    const r = (await activate(d, 't2')).body as Body;
    expect(r.host).toBe('bm1');
    const w = await wanted(d);
    expect(ids(w.run)).toEqual(['t2']);
    expect(ids(w.stop)).toEqual(['t1']);
    expect(w.graced).toEqual([]);
    expect(await build(d, 't1')).not.toHaveProperty('graced');
    expect(await hostsBlock(d)).toMatchObject({ graced: 0, active: { limit: 1, used: 1 } });
    // Without a grace, as today: t1 (no lease) holds no slot, t2 is placed and t1 stopped.
    const plain = await released(0, two, 1);
    expect(((await activate(plain, 't2')).body as Body).host).toBe('bm1');
    expect(ids((await wanted(plain)).stop)).toEqual(['t1']);
  });

  it('a wanted build that needs the memory displaces the graced worker (G39 headroom)', async () => {
    const d = await setup();
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await registered(d, 't2', hash('2'), 'sbx_t2');
    // Room for one 4096 + 128 worker above the floor, not two.
    const mem = (running: string[], avail: number) => ({
      memTotalMib: 12_288 + 4096,
      memAvailableMib: avail,
      memFloorMib: 12_288 - 4224,
      memPressureLimit: 10,
      runningWorkers: running,
    });
    const inv = (running: string[], avail: number) =>
      HANDLERS.hostInventory!(
        asHost(
          'bm1',
          {},
          {
            holds: Object.entries(two).map(([manifestHash, template]) => ({
              manifestHash,
              template,
            })),
            limits: { activeLimit: 8, idleLimitSeconds: 3600, idleGraceSeconds: GRACE },
            memory: mem(running, avail),
          },
        ),
        d,
      );
    await inv([], 12_288 + 4096);
    await activate(d, 't1');
    attachedNow = ['sbx_t1'];
    await inv(['sbx_t1'], 12_288);
    now += 10_000;
    await deactivate(d, 't1');
    await inv(['sbx_t1'], 12_288);
    expect((await wanted(d)).graced).toEqual([hash('1')]);
    expect((await hostsBlock(d)).memory.usedMib).toBe(4224);
    await activate(d, 't2');
    const w = await wanted(d);
    expect(ids(w.run)).toEqual(['t2']);
    expect(ids(w.stop)).toEqual(['t1']);
    expect(w.graced).toEqual([]);
  });

  it('re-checks for a lease at stop time: one taken between the decisions keeps the worker', async () => {
    const d = await released(GRACE, two, 1);
    await activate(d, 't2');
    // A lease on t1 lands after the wanted answer read the catalog, before its stop is decided.
    const cat = d.templates!;
    const get = cat.get.bind(cat);
    cat.get = async (id: string) => {
      const doc = await get(id);
      if (!doc || id !== 't1') return doc;
      return {
        ...doc,
        builds: doc.builds.map((b) => ({
          ...b,
          leases: [{ subject: bob.sub, until: nowS() + 600, since: nowS() }],
        })),
      };
    };
    const w = await wanted(d);
    expect(ids(w.run)).toEqual(['t2']);
    expect(w.stop).toEqual([]);
    cat.get = get;
    expect(ids((await wanted(d)).stop)).toEqual(['t1']);
  });

  it('a retire or a reject ends the grace at once: stop and remove in the same answer', async () => {
    for (const how of ['retire', 'reject'] as const) {
      const d = await released();
      expect((await wanted(d)).graced).toEqual([hash('1')]);
      if (how === 'retire') {
        await HANDLERS.retireTemplate!(ctx({ principal: alice, params: { id: 't1' } }), d);
      } else {
        await HANDLERS.rejectTemplateBuild!(
          ctx({
            principal: { ...bob, roles: ['admin'] },
            params: { id: 't1', build: hash('1') },
            body: { reason: 'X12' },
          }),
          d,
        );
      }
      const w = await wanted(d);
      expect(w.run).toEqual([]);
      expect(w.graced).toEqual([]);
      expect(ids(w.stop)).toEqual(['t1']);
      expect(ids(w.remove)).toEqual(['t1']);
      // The agent's stop of the retired worker is recorded, then its removal.
      for (const event of ['detached', 'removed']) {
        const r = await HANDLERS.hostWorkerReport!(
          asHost('bm1', {}, { buildId: hash('1'), event }),
          d,
        );
        expect((r.body as Body).recorded).toBe(event);
      }
    }
  });

  it('stopNow ends the grace: the build is stopped at the next answer, and the record says so', async () => {
    const d = await setup();
    await registered(d, 't1', hash('1'), 'sbx_t1');
    await inventoryGrace(d, one, GRACE, []);
    await activate(d, 't1');
    await activate(d, 't1', bob);
    attachedNow = ['sbx_t1'];
    await inventoryGrace(d, one, GRACE, ['sbx_t1']);
    expect(
      await deactivate(d, 't1', { stopNow: 'yes' }).then(
        () => 'none',
        (e: { code: string }) => e.code,
      ),
    ).toBe('invalid_request');
    // Alice's stopNow while bob holds a lease: it stays wanted, and bob's later release is graced.
    await deactivate(d, 't1', { stopNow: true });
    expect(ids((await wanted(d)).run)).toEqual(['t1']);
    now += 5000;
    await deactivate(d, 't1', {}, bob);
    expect((await wanted(d)).graced).toEqual([hash('1')]);
    // A stopNow on a graced build ends its grace (no lease to drop: still recorded).
    now += 5000;
    const r = (await deactivate(d, 't1', { stopNow: true })).body as Body;
    expect(r.released).toBe(0);
    const w = await wanted(d);
    expect(ids(w.stop)).toEqual(['t1']);
    expect(w.graced).toEqual([]);
    const rec = (await d.provenance!.chain('template/t1')).at(-1)!;
    expect(rec).toMatchObject({
      kind: 'deactivate',
      subject: alice.sub,
      body: { leases: 0, all: false, stopNow: true },
    });
    // Again: nothing left to end, no second record.
    const n = (await d.provenance!.chain('template/t1')).length;
    await deactivate(d, 't1', { stopNow: true });
    expect((await d.provenance!.chain('template/t1')).length).toBe(n);
    // A release with stopNow that drops the last lease: no grace, the record carries it.
    await activate(d, 't1');
    now += 5000;
    await deactivate(d, 't1', { stopNow: true });
    expect(ids((await wanted(d)).stop)).toEqual(['t1']);
    expect((await d.provenance!.chain('template/t1')).at(-1)).toMatchObject({
      kind: 'deactivate',
      body: { leases: 1, stopNow: true },
    });
    // A later lease and plain release is graced again.
    await activate(d, 't1');
    now += 5000;
    await deactivate(d, 't1');
    expect((await wanted(d)).graced).toEqual([hash('1')]);
  });

  it('never graces a worker with a live sandbox (it drains, as today), nor counts it', async () => {
    const d = await released();
    const sb = (
      await HANDLERS.createSandbox!(ctx({ principal: alice, body: { template: 't1' } }), d)
    ).body as Body;
    now += 5000;
    await deactivate(d, 't1');
    const w = await wanted(d);
    expect(w.graced).toEqual([]);
    expect(w.stop).toEqual([]);
    expect(w.run).toEqual([]);
    await HANDLERS.deleteSandbox!(ctx({ principal: alice, params: { id: sb.id } }), d);
    expect((await wanted(d)).graced).toEqual([hash('1')]);
  });
});

void sha256Hex;

describe('the build job names the guest size template-build.sh reads (guest_mb)', () => {
  it('maps guest_mb to guest_ram_mb, keeps guest_ram_mb, and prefers guest_mb as the policy does', () => {
    expect(buildJobSpec('t', 'i@sha256:x', { guest_mb: 4096, vcpus: 2 })).toEqual({
      id: 't',
      image: 'i@sha256:x',
      vcpus: 2,
      guest_ram_mb: 4096,
    });
    expect(buildJobSpec('t', 'i', { guest_ram_mb: 2048 })).toEqual({
      id: 't',
      image: 'i',
      guest_ram_mb: 2048,
    });
    expect(buildJobSpec('t', 'i', { guest_mb: 1024, guest_ram_mb: 2048 })).toEqual({
      id: 't',
      image: 'i',
      guest_ram_mb: 1024,
    });
    expect(buildJobSpec('t', 'i', { vcpus: 1 })).toEqual({ id: 't', image: 'i', vcpus: 1 });
    // A spec's own id or image never renames the build or swaps its image.
    expect(
      buildJobSpec('t', 'i@sha256:x', { id: 'other', image: 'evil@sha256:y', vcpus: 1 }),
    ).toEqual({
      id: 't',
      image: 'i@sha256:x',
      vcpus: 1,
    });
  });

  it("a create that names guest_mb is claimed with guest_ram_mb (the guide window's failure)", async () => {
    const d = await setup();
    const { guest_ram_mb: g, ...noRam } = BASE_SPEC as Body;
    const r = await HANDLERS.createTemplate!(
      ctx({
        principal: alice,
        body: { id: 'gmb', image: IMAGE, spec: { ...noRam, guest_mb: g }, profile: 'base' },
      }),
      d,
    );
    expect(r.status).toBe(202);
    const c = (await HANDLERS.hostClaimBuilds!(asHost('bm1', {}, { max: 1 }), d)).body as Body;
    expect(c.builds[0].spec.guest_ram_mb).toBe(g);
    expect(c.builds[0].spec.guest_mb).toBeUndefined();
  });
});
