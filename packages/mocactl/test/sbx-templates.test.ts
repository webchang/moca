import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, errorFromResponse } from '../src/api/errors.js';
import { resolvePaths, saveAuth } from '../src/config.js';
import { sbxMain, sbxPaths } from '../src/sbx/cli.js';
import { refusalText } from '../src/sbx/commands.js';
import { redact } from '../src/sbx/call-record.js';
import type { SbxHost } from '../src/sbx/api.js';
import { sizedActivateTimeoutS } from '../src/sbx/templates.js';
import { dryRun } from '../src/sbx/dry-run.js';
import {
  cleanupTmp,
  fakeCp,
  LOGIN,
  policyView,
  sandbox,
  SBX,
  setup,
  TOKEN,
  workspaces,
  type Handler,
} from './helpers/sbx.js';

// mocactl templates spec (docs/specs/2026-11-10-mocactl-template-commands-design.md): the template
// lifecycle from mocactl, its errors, its admin writes, and --record. example.com hosts only.

afterEach(cleanupTmp);

const DIGEST = `sha256:${'a'.repeat(64)}`;
const IMAGE = `team/moca-microvm@${DIGEST}`;
const SPEC = {
  schema: 'moca-sbx-template-spec/1',
  id: 'my-python',
  image: IMAGE,
  guest_ram_mb: 4096,
  vcpus: 2,
  egress: false,
  seed: '',
  tools: ['bash', 'git', 'python3'],
  probe: { cmd: 'python3 -V', timeout_s: 60, expect_rc: 0, expect: ['^Python 3'] },
  description: 'Python 3.12',
};
const HANDLE = 'b-0123456789abcdef0123456789';
const BUILD_ID = `sha256:${'b'.repeat(64)}`;
const QUEUED = {
  templateId: 'my-python',
  buildId: null,
  build: `/v1/templates/my-python/builds/${HANDLE}`,
  status: 'queued',
};
const build = (over: Record<string, unknown> = {}) => ({
  buildId: BUILD_ID,
  handle: HANDLE,
  status: 'registered',
  profile: 'base',
  readiness: 'inactive',
  capacity: null,
  lastUsedAt: null,
  heldBy: ['kvm-1'],
  tags: ['default'],
  createdAt: 1_800_000_000,
  provenance: `sha256:${'c'.repeat(64)}`,
  reason: null,
  attestation: 'deployment',
  ...over,
});
const template = (over: Record<string, unknown> = {}) => ({
  id: 'my-python',
  description: 'Python 3.12',
  tools: ['bash'],
  owner: 'github:1',
  visibility: 'private',
  attestation: 'deployment',
  onboarding: 'registered',
  readiness: 'inactive',
  tags: { default: BUILD_ID },
  builds: [build()],
  ...over,
});
const BUILD_PATH = `/v1/templates/my-python/builds/${HANDLE}`;

/** A spec file (and anything else) in a temp directory. */
function files(o: Record<string, unknown>): Record<string, string> & { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sbx-tpl-'));
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(o)) {
    out[name] = join(dir, name);
    writeFileSync(out[name], typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  }
  return { dir, ...out };
}

/** A fake clock the waits run on: sleep advances it. */
function clock() {
  let t = 1_800_000_000_000;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

function world(routes: Record<string, Handler>) {
  const s = setup();
  const cp = fakeCp(routes);
  const c = clock();
  const run = (argv: string[], over: Record<string, unknown> = {}) => {
    s.io.outs.length = 0;
    s.io.errs.length = 0;
    return sbxMain(argv, s.env, s.io, {
      home: s.home,
      fetchImpl: cp.fetchImpl,
      sleep: c.sleep,
      now: c.now,
      ...over,
    });
  };
  return {
    ...s,
    cp,
    clock: c,
    run,
    out: () => s.io.outs.join(''),
    err: () => s.io.errs.join('\n'),
  };
}

describe('errors keep the body (§3.7)', () => {
  it('reads rule, quota, readiness, its reason and the queue position', async () => {
    const res = (body: object, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status: 409, headers });
    const e = await errorFromResponse(
      'control-plane',
      res(
        {
          error: 'no_active_slot',
          message: 'no memory',
          readiness: 'unavailable',
          reason: 'memory',
        },
        { 'retry-after': '40' },
      ),
    );
    expect(e).toMatchObject({
      code: 'no_active_slot',
      readiness: 'unavailable',
      readinessReason: 'memory',
      retryAfterS: 40,
    });
    const p = await errorFromResponse(
      'control-plane',
      res({
        error: 'policy_refused',
        message: "spec.id must be the create's id",
        rule: 'M7.spec_id',
      }),
    );
    expect(refusalText(p)).toBe(
      "refused by policy rule M7.spec_id: spec.id must be the create's id",
    );
    const q = await errorFromResponse(
      'control-plane',
      res({
        error: 'quota_exceeded',
        message: 'at most 10 builds queued per subject',
        quota: 'buildsQueued',
      }),
    );
    expect(refusalText(q)).toBe(
      'over your buildsQueued quota: at most 10 builds queued per subject',
    );
    const n = await errorFromResponse(
      'control-plane',
      res({
        error: 'template_not_active',
        message: 'x',
        readiness: 'activating',
        queuePosition: 3,
      }),
    );
    expect(refusalText(n)).toBe('x (readiness activating; queue position 3)');
    // A reason that is not a readiness reason, on another code, is not one.
    const t = await errorFromResponse(
      'control-plane',
      res({ error: 'sandbox_terminated', message: 'gone', reason: 'deleted' }),
    );
    expect(t.readinessReason).toBeUndefined();
    expect(new ApiError('control-plane', 0, 'network_error', 'x', 5).retryAfterS).toBe(5);
  });

  it('prints a policy refusal with its rule, exit 1', async () => {
    const f = files({ 'spec.json': SPEC });
    const w = world({
      'POST /v1/templates': () => ({
        status: 422,
        body: { error: 'policy_refused', message: 'needs a gate record (X10)', rule: 'X10' },
      }),
    });
    expect(await w.run(['templates', 'create', '--spec', f['spec.json']!])).toBe(1);
    expect(w.err()).toContain('sbx: refused by policy rule X10: needs a gate record (X10)');
  });
});

describe('sbx quota, policy, hosts (§3.1)', () => {
  it('quota: limit and use, its source, and --json', async () => {
    const q = {
      subject: 'github:1',
      templates: { limit: 100, used: 3 },
      buildsQueued: { limit: 10, used: 1 },
      active: { limit: 8, used: 0 },
      sandboxes: { limit: 3, used: 1 },
      quotaSource: 'default',
    };
    const w = world({ 'GET /v1/quota': () => ({ status: 200, body: q }) });
    expect(await w.run(['quota'])).toBe(0);
    expect(w.out()).toContain('buildsQueued   1 of 10\n');
    expect(w.out()).toContain('sandboxes      1 of 3\n');
    expect(w.out()).toContain('github:1: the deployment default');
    expect(await w.run(['quota', '--json'])).toBe(0);
    expect(JSON.parse(w.out())).toEqual(q);
  });

  it('a minted login alone: reads use its own controlPlaneUrl, an admin write is refused until the URL is named', async () => {
    const q = {
      subject: 'github:1',
      templates: { limit: 100, used: 0 },
      buildsQueued: { limit: 10, used: 0 },
      active: { limit: 8, used: 0 },
      quotaSource: 'default',
    };
    const w = world({ 'GET /v1/quota': () => ({ status: 200, body: q }) });
    // As mint-login.sh leaves it: sbx-auth.json with its controlPlaneUrl, no MOCACTL_SBX_URL, no config.
    delete (w.env as Record<string, string | undefined>).MOCACTL_SBX_URL;
    expect(await w.run(['quota'])).toBe(0);
    expect(w.out()).toContain('github:1: the deployment default');
    const calls = w.cp.calls.length;
    expect(
      await w.run([
        'templates',
        'quota',
        'github:9',
        '--templates',
        '100',
        '--builds-queued',
        '10',
        '--active',
        '32',
      ]),
    ).toBe(1);
    expect(w.err()).toContain('an admin write needs its control plane named');
    expect(w.cp.calls.length).toBe(calls);
  });

  it('policy: each profile, the registries and the digest', async () => {
    const w = world({ 'GET /v1/policy': () => ({ status: 200, body: policyView() }) });
    expect(await w.run(['policy'])).toBe(0);
    expect(w.out()).toMatch(/^base +\(default\) guest <= 16384 MiB, vcpus <= 8/m);
    expect(w.out()).toMatch(
      /^benchmark-self .*\(exactly 4096 MiB, 2 vCPUs\); no egress; requires X1 X10/m,
    );
    expect(w.out()).toContain('registry docker.io: library/*\n');
    expect(w.out()).toContain('registry <default>: every repository\n');
    expect(w.out()).toContain(`policy sha256:${'d'.repeat(64)}`);
    expect(await w.run(['policy', '--json'])).toBe(0);
    expect(JSON.parse(w.out()).digest).toBe(`sha256:${'d'.repeat(64)}`);
  });

  it('hosts: the hosts block of GET /v1/templates, or none reported', async () => {
    const host = {
      id: 'kvm-1',
      active: { limit: 28, used: 4 },
      idleLimitSeconds: 3600,
      disk: { freeGb: 200, floorGb: 50 },
      memory: { headroomMib: 90_000, brake: null, usedMib: 20_000, totalMib: 190_000 },
      idleGraceSeconds: 600,
      graced: 1,
      start: { concurrency: 4, seconds: 51.2, starting: 4, queued: 6 },
    };
    let hosts: unknown[] = [host];
    const w = world({
      'GET /v1/templates': () => ({ status: 200, body: { templates: [], hosts } }),
    });
    expect(await w.run(['hosts'])).toBe(0);
    expect(w.out()).toBe(
      'kvm-1            active 4 of 28; start 4 starting, 6 queued (at most 4 at once, 51 s each); ' +
        'memory 90000 MiB headroom; grace 600 s (1 graced); disk 200 GB free (floor 50)\n',
    );
    expect(await w.run(['hosts', '--json'])).toBe(0);
    expect(JSON.parse(w.out())).toEqual([host]);
    hosts = [];
    expect(await w.run(['hosts'])).toBe(0);
    expect(w.out()).toBe('no host has reported yet\n');
  });
});

describe('templates create, build, show, follow, cancel (§3.2)', () => {
  it('posts the spec with its own id and image, and the gate record byte for byte', async () => {
    const gate = '{ "schema": "image-factory/gate/1",\n  "gate": {"passed": true} }\n';
    const f = files({ 'spec.json': SPEC, 'gate.json': gate });
    const w = world({ 'POST /v1/templates': () => ({ status: 202, body: QUEUED }) });
    expect(
      await w.run([
        'templates',
        'create',
        '--spec',
        f['spec.json']!,
        '--profile',
        'general-self',
        '--visibility',
        'private',
        '--gate-record',
        f['gate.json']!,
      ]),
    ).toBe(0);
    expect(w.cp.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/v1/templates',
      body: {
        id: 'my-python',
        image: IMAGE,
        spec: SPEC,
        profile: 'general-self',
        visibility: 'private',
        gateRecord: gate,
      },
    });
    expect(w.out()).toBe(`my-python ${HANDLE} queued\n`);
    expect(await w.run(['templates', 'create', '--spec', f['spec.json']!, '--json'])).toBe(0);
    expect(JSON.parse(w.out())).toEqual(QUEUED);
  });

  it("reads a gate record's template block as the spec, and refuses an id or image that differs (M7)", async () => {
    const f = files({ 'rec.json': { schema: 'image-factory/moca-microvm/1', template: SPEC } });
    const w = world({ 'POST /v1/templates': () => ({ status: 202, body: QUEUED }) });
    expect(await w.run(['templates', 'create', '--spec', f['rec.json']!])).toBe(0);
    expect((w.cp.calls.at(-1)!.body as { spec: unknown }).spec).toEqual(SPEC);
    const n = w.cp.calls.length;
    expect(await w.run(['templates', 'create', '--spec', f['rec.json']!, '--id', 'other'])).toBe(1);
    expect(w.err()).toContain('refused by policy rule M7.spec_id');
    expect(
      await w.run([
        'templates',
        'create',
        '--spec',
        f['rec.json']!,
        '--image',
        `team/x@sha256:${'f'.repeat(64)}`,
      ]),
    ).toBe(1);
    expect(w.err()).toContain('M7.spec_image');
    expect(w.cp.calls.length).toBe(n);
  });

  it('refuses bad usage locally, before any request', async () => {
    const f = files({ 'spec.json': SPEC, 'a.json': SPEC, 'bad.json': 'not json' });
    const w = world({});
    const usage = async (argv: string[], msg: RegExp) => {
      expect(await w.run(argv)).toBe(2);
      expect(w.err()).toMatch(msg);
    };
    await usage(['templates', 'create'], /templates create needs --spec F/);
    await usage(['templates', 'create', '--spec', f['bad.json']!], /cannot read --spec/);
    await usage(['templates', 'create', '--spec', join(f.dir, 'none.json')], /cannot read --spec/);
    await usage(
      ['templates', 'create', '--spec', f['spec.json']!, '--spec', f['a.json']!, '--id', 'x'],
      /--id and --image name one template/,
    );
    await usage(
      ['templates', 'build', 'my-python', '--spec', f['spec.json']!, '--id', 'x'],
      /--id only applies to templates create/,
    );
    await usage(
      ['templates', 'show', 'my-python', '--spec', f['spec.json']!],
      /--spec only applies/,
    );
    await usage(['templates', 'cancel', 'my-python'], /templates cancel needs --build BUILD/);
    await usage(
      ['templates', 'follow', 'my-python', '--timeout', '0'],
      /--timeout must be a whole number/,
    );
    await usage(
      ['templates', 'activate', 'my-python', '--timeout', '9'],
      /--timeout with templates activate needs --wait/,
    );
    await usage(['templates', 'deactivate', 'my-python', '--wait'], /--wait only applies/);
    await usage(
      ['templates', 'activate', 'my-python', '--lease', 'x'],
      /--lease must be a whole number/,
    );
    await usage(['templates', 'show', 'my-python', '--stop-now'], /--stop-now only applies/);
    await usage(['ls', '--timeout', '9'], /--timeout only applies to run and templates/);
    await usage(['templates', 'follow'], /too many arguments for templates/);
    expect(w.cp.calls).toEqual([]);
  });

  it('build ID: posts to /builds, with ID as the template', async () => {
    const f = files({ 'spec.json': { ...SPEC, id: undefined } });
    const w = world({
      'POST /v1/templates/my-python/builds': () => ({ status: 202, body: QUEUED }),
    });
    expect(await w.run(['templates', 'build', 'my-python', '--spec', f['spec.json']!])).toBe(0);
    expect(w.cp.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/v1/templates/my-python/builds',
      body: { id: 'my-python', image: IMAGE },
    });
  });

  it('409 template_exists: follows your own newest build and posts nothing more', async () => {
    const f = files({ 'spec.json': SPEC });
    const w = world({
      'POST /v1/templates': () => ({
        status: 409,
        body: { error: 'template_exists', message: "template 'my-python' exists" },
      }),
      'GET /v1/templates/my-python': () => ({
        status: 200,
        body: template({
          builds: [build({ status: 'building', readiness: null, buildId: HANDLE })],
        }),
      }),
    });
    expect(await w.run(['templates', 'create', '--spec', f['spec.json']!, '--json'])).toBe(0);
    expect(w.cp.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(JSON.parse(w.out())).toMatchObject({
      build: BUILD_PATH,
      status: 'building',
      reused: true,
    });
    expect(w.err()).toContain(`my-python is already yours: following its newest build, ${HANDLE}`);
  });

  it("409 template_exists: names another's owner, and a declared one's hand-over (G34)", async () => {
    const f = files({ 'spec.json': SPEC });
    let owner: string | null = 'github:9';
    const w = world({
      'POST /v1/templates': () => ({ status: 409, body: { error: 'template_exists' } }),
      'GET /v1/templates/my-python': () => ({ status: 200, body: template({ owner }) }),
    });
    expect(await w.run(['templates', 'create', '--spec', f['spec.json']!])).toBe(1);
    expect(w.err()).toContain('my-python belongs to github:9: pick another id');
    owner = null;
    expect(await w.run(['templates', 'create', '--spec', f['spec.json']!])).toBe(1);
    expect(w.err()).toContain(
      'a template the deployment declared: an admin can hand it over to you (mocactl sbx templates transfer my-python github:1, G34)',
    );
  });

  it('many creates: waits for a queue slot at 429 buildsQueued, then times out with exit 5', async () => {
    const f = files({ 'a.json': SPEC, 'b.json': { ...SPEC, id: 'my-python-2' } });
    let full = 2;
    const w = world({
      'POST /v1/templates': (req) =>
        (req.body as { id: string }).id === 'my-python-2' && full-- > 0
          ? {
              status: 429,
              body: { error: 'quota_exceeded', message: 'at most 1', quota: 'buildsQueued' },
              headers: { 'retry-after': '20' },
            }
          : { status: 202, body: { ...QUEUED, templateId: (req.body as { id: string }).id } },
    });
    expect(
      await w.run(['templates', 'create', '--spec', f['a.json']!, '--spec', f['b.json']!]),
    ).toBe(0);
    expect(w.out()).toBe(`my-python ${HANDLE} queued\nmy-python-2 ${HANDLE} queued\n`);
    expect(w.err()).toContain('1 waiting for a queue slot');
    expect(w.err()).not.toContain('2 waiting');
    expect(w.clock.slept).toEqual([20_000, 20_000]);
    full = 1000;
    expect(await w.run(['templates', 'create', '--spec', f['b.json']!, '--timeout', '60'])).toBe(5);
    expect(w.err()).toMatch(
      /timed out after 60 s waiting for a queue slot for my-python-2 \(exit 5\)/,
    );
  });

  it('many creates: Ctrl-C during the wait for a queue slot is exit 130, and posts nothing more', async () => {
    const f = files({
      'a.json': SPEC,
      'b.json': { ...SPEC, id: 'my-python-2' },
      'c.json': { ...SPEC, id: 'my-python-3' },
    });
    const w = world({
      'POST /v1/templates': () => ({
        status: 429,
        body: { error: 'quota_exceeded', message: 'at most 1', quota: 'buildsQueued' },
        headers: { 'retry-after': '20' },
      }),
    });
    const ac = new AbortController();
    const argv = ['templates', 'create', '--spec', f['a.json']!, '--spec', f['b.json']!];
    expect(
      await w.run([...argv, '--spec', f['c.json']!], {
        signal: ac.signal,
        sleep: async () => ac.abort(),
      }),
    ).toBe(130);
    expect(w.cp.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(w.err()).toContain('sbx: interrupted (exit 130)');
    expect(w.err()).not.toContain('over your buildsQueued quota');
    // Interrupted before the first POST: none is sent.
    const before = w.cp.calls.length;
    expect(await w.run(argv, { signal: ac.signal })).toBe(130);
    expect(w.cp.calls.length).toBe(before);
  });

  it('show: a template and its builds, or one build, with readiness and why', async () => {
    const w = world({
      'GET /v1/templates/my-python': () => ({
        status: 200,
        body: template({
          readiness: 'unavailable',
          readinessReason: 'memory',
          builds: [
            build({ readiness: 'activating', queued: true, queuePosition: 5 }),
            build({
              handle: 'b-1',
              buildId: 'b-1',
              status: 'failed',
              readiness: null,
              heldBy: [],
              tags: [],
              reason: { message: 'the probe did not match', step: 'probe', code: 'probe_failed' },
            }),
          ],
        }),
      }),
      [`GET ${BUILD_PATH}`]: () => ({
        status: 200,
        body: build({ readiness: 'deactivating', graced: true, gracedUntil: 1_800_000_600 }),
      }),
    });
    expect(await w.run(['templates', 'show', 'my-python'])).toBe(0);
    expect(w.out()).toContain(
      'my-python  owner github:1  private  registered  unavailable (memory)\n',
    );
    expect(w.out()).toContain(`activating (queued at position 5)  tags default  held by kvm-1`);
    expect(w.out()).toContain(
      'b-1  failed  held by no host  step probe, code probe_failed: the probe did not match',
    );
    expect(await w.run(['templates', 'show', 'my-python', '--build', HANDLE])).toBe(0);
    expect(w.out()).toContain('deactivating (graced until 2027-01-15T08:10:00.000Z)');
    expect(await w.run(['templates', 'show', 'my-python', '--build', HANDLE, '--json'])).toBe(0);
    expect(JSON.parse(w.out())).toMatchObject({ graced: true });
  });

  it('follow: through each status and a 5xx to registered (exit 0); failed is 1, with its reason', async () => {
    const seq = [
      { status: 503, body: { error: 'redis_unavailable' } },
      { status: 200, body: build({ status: 'queued', readiness: null }) },
      { status: 200, body: build({ status: 'building', readiness: null }) },
      { status: 200, body: build({ status: 'registered' }) },
    ];
    let i = 0;
    const w = world({
      'GET /v1/templates/my-python': () => ({ status: 200, body: template() }),
      [`GET ${BUILD_PATH}`]: () => seq[Math.min(i++, seq.length - 1)]!,
    });
    expect(await w.run(['templates', 'follow', 'my-python'])).toBe(0);
    expect(w.err()).toContain(`my-python ${HANDLE}: queued`);
    expect(w.err()).toContain(`my-python ${HANDLE}: building`);
    expect(w.err()).toMatch(/polling again/);
    expect(w.out()).toContain(`${HANDLE} ${BUILD_ID}  registered`);
    seq.splice(0, seq.length, {
      status: 200,
      body: build({
        status: 'failed',
        readiness: null,
        reason: { message: 'cancelled by github:1', step: 'cancelled' },
      }),
    });
    i = 0;
    expect(await w.run(['templates', 'follow', 'my-python', '--build', HANDLE, '--json'])).toBe(1);
    expect(JSON.parse(w.out())).toMatchObject({ status: 'failed' });
    expect(w.err()).toContain(`${HANDLE} was cancelled: step cancelled: cancelled by github:1`);
  });

  it('follow: a 404 is a refusal, at once; past --timeout is exit 5', async () => {
    let missing = true;
    const w = world({
      [`GET ${BUILD_PATH}`]: () =>
        missing
          ? { status: 404, body: { error: 'template_not_found', message: 'no such build' } }
          : { status: 200, body: build({ status: 'probing', readiness: null }) },
    });
    expect(await w.run(['templates', 'follow', 'my-python', '--build', HANDLE])).toBe(1);
    expect(w.err()).toContain('no such build');
    missing = false;
    expect(
      await w.run(['templates', 'follow', 'my-python', '--build', HANDLE, '--timeout', '12']),
    ).toBe(5);
    expect(w.clock.slept).toEqual([5000, 5000, 2000]);
    expect(w.err()).toContain('timed out after 12 s');
  });

  it('follow: Ctrl-C is exit 130, not a failed build', async () => {
    const w = world({
      [`GET ${BUILD_PATH}`]: () => ({
        status: 200,
        body: build({ status: 'building', readiness: null }),
      }),
    });
    const ac = new AbortController();
    expect(
      await w.run(['templates', 'follow', 'my-python', '--build', HANDLE], {
        signal: ac.signal,
        sleep: async () => ac.abort(),
      }),
    ).toBe(130);
    expect(w.err()).toContain('sbx: interrupted (exit 130)');
    expect(w.out()).toBe('');
  });

  it('cancel: posts the cancel, and reports a build past cancelling', async () => {
    let ok = true;
    const w = world({
      [`POST ${BUILD_PATH}/cancel`]: () =>
        ok
          ? { status: 200, body: { templateId: 'my-python', build: HANDLE, status: 'failed' } }
          : {
              status: 400,
              body: { error: 'invalid_request', message: 'the build is registered' },
            },
    });
    expect(await w.run(['templates', 'cancel', 'my-python', '--build', HANDLE])).toBe(0);
    expect(w.out()).toBe(`cancelled my-python ${HANDLE}\n`);
    ok = false;
    expect(await w.run(['templates', 'cancel', 'my-python', '--build', HANDLE])).toBe(1);
    expect(w.err()).toContain('the build is registered');
  });
});

describe('templates create --dry-run (§3.5)', () => {
  const pol = policyView().policy;
  const ok: { id: string; image: string; spec: Record<string, unknown> } = {
    id: 'my-python',
    image: IMAGE,
    spec: SPEC,
  };
  const fails = (input: Partial<typeof ok> & { profile?: string; gateRecord?: string }) =>
    dryRun({ ...ok, ...input }, pol).failed?.rule;

  it('passes a good spec, and asks for guest_ram_mb over guest_mb (G46)', () => {
    expect(dryRun(ok, pol).failed).toBeUndefined();
    const { guest_ram_mb: _g, ...rest } = SPEC;
    const r = dryRun({ ...ok, spec: { ...rest, guest_mb: 4096 } }, pol);
    expect(r.failed).toBeUndefined();
    expect(r.notes.join('\n')).toContain('write spec.guest_ram_mb rather than guest_mb');
  });

  it.each([
    ['M7.id', { id: 'My_Python' }],
    ['M7.id', { id: 'x'.repeat(32) }],
    ['M1', { image: 'team/moca-microvm:latest' }],
    ['M1', { image: 'team/moca-microvm@sha256:<64 hex>' }],
    ['M7.spec_id', { id: 'other' }],
    ['M7.spec_image', { image: `team/other@sha256:${'f'.repeat(64)}` }],
    ['profile', { profile: 'nope' }],
  ] as const)('refuses %s', (rule, input) => {
    expect(fails(input)).toBe(rule);
  });

  it.each([
    ['M7.guest', { guest_ram_mb: 64 }],
    ['M7.vcpus', { vcpus: 0 }],
    ['M7.workspace', { workspace_mb: 100 }],
    ['M7.home', { guest_home: '/home/x' }],
    ['M7.egress', { egress: 'no' }],
    ['M7.seed', { seed: 1 }],
    ['M7.probe', { probe: { cmd: '', timeout_s: 60, expect_rc: 0 } }],
    ['M7.tools', { tools: ['bash', 'bash'] }],
    ['M7.description', { description: '' }],
    ['M7.skip_git_identity_check', { skip_git_identity_check: 'yes' }],
    ['M8', { guest_home_gitconfig: true }],
    ['M9', { probe_status: 'unmeasured' }],
    ['envelope', { guest_ram_mb: 32_768 }],
    ['X10', { source_record_digest: `sha256:${'9'.repeat(64)}` }],
  ] as const)('refuses a spec failing %s', (rule, change) => {
    expect(fails({ spec: { ...SPEC, ...change } })).toBe(rule);
  });

  it('a self profile needs a gate record for this image, offline; base takes none', () => {
    const self = { profile: 'benchmark-self' };
    const bench = {
      ...SPEC,
      probe_status: 'vm',
      source_record_digest: DIGEST,
      skip_git_identity_check: true,
    };
    expect(fails({ ...self, spec: bench })).toBe('X10.record');
    const gate = (o: object) =>
      JSON.stringify({
        schema: 'image-factory/gate/1',
        gate: { passed: true, floor_checked_offline: true },
        image: { digest: DIGEST },
        observed: { testbed: { agent_can_commit: 'no' }, guest: { git_identity: 'none' } },
        ...o,
      });
    expect(fails({ ...self, spec: bench, gateRecord: gate({}) })).toBeUndefined();
    expect(fails({ ...self, spec: bench, gateRecord: gate({ gate: { passed: false } }) })).toBe(
      'X1',
    );
    expect(fails({ ...self, spec: bench, gateRecord: gate({ image: { digest: 'x' } }) })).toBe(
      'X1.image',
    );
    expect(fails({ ...self, spec: bench, gateRecord: gate({ gate: { passed: true } }) })).toBe(
      'X1.offline',
    );
    expect(fails({ ...self, spec: { ...bench, egress: true }, gateRecord: gate({}) })).toBe('X11');
    expect(
      fails({ ...self, spec: { ...bench, probe_status: undefined }, gateRecord: gate({}) }),
    ).toBe('X14');
    expect(fails({ ...self, spec: { ...bench, vcpus: 1 }, gateRecord: gate({}) })).toBe('X15');
    expect(
      fails({
        ...self,
        spec: bench,
        gateRecord: gate({ observed: { testbed: { agent_can_commit: 'yes' } } }),
      }),
    ).toBe('X12');
    expect(fails({ ...self, spec: bench, gateRecord: 'not json' })).toBe('gate.json');
    expect(fails({ gateRecord: gate({}) })).toBe('gate.profile');
  });

  it('points a git-less spec at skip_git_identity_check (G47)', () => {
    const r = dryRun({ ...ok, spec: { ...SPEC, tools: ['bash', 'python3'] } }, pol);
    expect(r.notes.join('\n')).toContain('set skip_git_identity_check');
  });

  it('runs from the CLI: reads the policy, creates nothing, exit 1 with the rule', async () => {
    const f = files({ 'good.json': SPEC, 'bad.json': { ...SPEC, id: 'other-id', vcpus: 64 } });
    const w = world({ 'GET /v1/policy': () => ({ status: 200, body: policyView() }) });
    expect(await w.run(['templates', 'create', '--spec', f['good.json']!, '--dry-run'])).toBe(0);
    expect(w.out()).toBe('my-python: passes the local checks (base)\n');
    expect(
      await w.run([
        'templates',
        'create',
        '--spec',
        f['good.json']!,
        '--spec',
        f['bad.json']!,
        '--dry-run',
        '--json',
      ]),
    ).toBe(1);
    const lines = w
      .out()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { failed?: { rule: string } });
    expect(lines.map((l) => l.failed?.rule)).toEqual([undefined, 'M7.vcpus']);
    expect(w.err()).toContain('other-id');
    expect(w.err()).toContain('would be refused by policy rule M7.vcpus: spec.vcpus must be 1-32');
    expect(w.cp.calls.every((c) => c.method === 'GET' && c.path === '/v1/policy')).toBe(true);
  });
});

describe('templates activate, deactivate (§3.3)', () => {
  const LEASE = {
    templateId: 'my-python',
    buildId: BUILD_ID,
    leaseUntil: 1_800_003_600,
    host: 'kvm-1',
  };
  const BPATH = `/v1/templates/my-python/builds/${encodeURIComponent(BUILD_ID)}`;

  it('without --wait: the lease, with --build and --lease in the body', async () => {
    const w = world({
      'POST /v1/templates/my-python/activate': () => ({ status: 200, body: LEASE }),
    });
    expect(
      await w.run(['templates', 'activate', 'my-python', '--build', BUILD_ID, '--lease', '7200']),
    ).toBe(0);
    expect(w.cp.calls.at(-1)!.body).toEqual({ build: BUILD_ID, leaseSeconds: 7200 });
    expect(w.out()).toBe(`my-python ${BUILD_ID} leased until 2027-01-15T09:00:00.000Z on kvm-1\n`);
    expect(await w.run(['templates', 'activate', 'my-python', '--json'])).toBe(0);
    expect(JSON.parse(w.out())).toEqual(LEASE);
  });

  it('sizes --wait from the start line: (ceil(position / concurrency) + 1) start times plus a quarter, never under 1800 s', () => {
    const host = (concurrency: number, seconds: number | null) =>
      ({ id: 'kvm-1', start: { concurrency, seconds, starting: 4, queued: 24 } }) as SbxHost;
    // The grace window's cold batch: position 28 behind 4 at a time, 320 s a start.
    expect(sizedActivateTimeoutS({ queued: true, queuePosition: 28 }, host(4, 320))).toBe(3200);
    expect(sizedActivateTimeoutS({ queued: true, queuePosition: 2 }, host(4, 320))).toBe(1800);
    expect(sizedActivateTimeoutS({ queued: true, queuePosition: 28 }, host(4, null))).toBe(1800);
    expect(sizedActivateTimeoutS({ queued: false }, host(4, 320))).toBe(1800);
    expect(sizedActivateTimeoutS(undefined, undefined)).toBe(1800);
    // A host reporting an outlier start time (hours) is capped at 4 h.
    expect(sizedActivateTimeoutS({ queued: true, queuePosition: 28 }, host(4, 7200))).toBe(14_400);
  });

  it('--wait: retries no_active_slot, then polls through the queue to active', async () => {
    let refusals = 1;
    const seq = [
      build({ readiness: 'activating', queued: true, queuePosition: 2 }),
      build({ readiness: 'activating', queued: false }),
      build({ readiness: 'active' }),
    ];
    let i = 0;
    const w = world({
      'POST /v1/templates/my-python/activate': () =>
        refusals-- > 0
          ? {
              status: 409,
              body: {
                error: 'no_active_slot',
                message: 'full',
                readiness: 'unavailable',
                reason: 'memory',
              },
              headers: { 'retry-after': '45' },
            }
          : { status: 200, body: LEASE },
      [`GET ${BPATH}`]: () => ({ status: 200, body: seq[Math.min(i++, 2)] }),
    });
    expect(await w.run(['templates', 'activate', 'my-python', '--wait'])).toBe(0);
    expect(w.err()).toContain('my-python: waiting: no host has the memory for its worker now');
    expect(w.err()).toContain('waiting: activating (queued at position 2)');
    expect(w.err()).toContain('waiting: activating (starting)');
    expect(w.out()).toContain(`my-python ${BUILD_ID} active`);
    expect(w.clock.slept).toEqual([45_000, 5000, 5000]);
  });

  it("--wait with no --timeout: sized from the host's start line at the first read; --timeout wins", async () => {
    const hosts = {
      templates: [],
      hosts: [
        {
          id: 'kvm-1',
          active: { limit: 28, used: 28 },
          idleLimitSeconds: 3600,
          disk: { freeGb: 400, floorGb: 60 },
          start: { concurrency: 4, seconds: 320, starting: 4, queued: 24 },
        },
      ],
    };
    const queued = build({ readiness: 'activating', queued: true, queuePosition: 28 });
    const w = world({
      'POST /v1/templates/my-python/activate': () => ({ status: 200, body: LEASE }),
      'GET /v1/templates': () => ({ status: 200, body: hosts }),
      [`GET ${BPATH}`]: () => ({ status: 200, body: queued }),
    });
    expect(await w.run(['templates', 'activate', 'my-python', '--wait'])).toBe(5);
    expect(w.err()).toContain('queued at position 28; waiting up to 3200 s');
    expect(w.err()).toContain('timed out after 3200 s');
    expect(await w.run(['templates', 'activate', 'my-python', '--wait', '--timeout', '60'])).toBe(
      5,
    );
    expect(w.err()).not.toContain('waiting up to');
    expect(w.err()).toContain('timed out after 60 s');
  });

  it('--wait: not_held and memfile_mismatch fail at once; a long wait times out with exit 5', async () => {
    let answer: { status: number; body: unknown } = {
      status: 409,
      body: {
        error: 'template_unavailable',
        message: "no host holds this build's snapshot",
        readiness: 'unavailable',
      },
    };
    let polled = build({ readiness: 'activating', queued: true, queuePosition: 9 });
    const w = world({
      'POST /v1/templates/my-python/activate': () => answer,
      [`GET ${BPATH}`]: () => ({ status: 200, body: polled }),
    });
    expect(await w.run(['templates', 'activate', 'my-python', '--wait'])).toBe(1);
    expect(w.err()).toContain("no host holds this build's snapshot (readiness unavailable)");
    expect(w.clock.slept).toEqual([]);
    answer = { status: 200, body: LEASE };
    polled = build({ readiness: 'unavailable', readinessReason: 'memfile_mismatch' });
    expect(await w.run(['templates', 'activate', 'my-python', '--wait'])).toBe(1);
    expect(w.err()).toContain('cannot become active: unavailable (memfile_mismatch)');
    polled = build({ readiness: 'activating', queued: true, queuePosition: 9 });
    expect(await w.run(['templates', 'activate', 'my-python', '--wait', '--timeout', '8'])).toBe(5);
    expect(w.err()).toContain(`timed out after 8 s waiting for my-python ${BUILD_ID} to be active`);
  });

  it('deactivate: releases, --stop-now skips the grace', async () => {
    const w = world({
      'POST /v1/templates/my-python/deactivate': () => ({
        status: 200,
        body: { templateId: 'my-python', released: 1 },
      }),
    });
    expect(await w.run(['templates', 'deactivate', 'my-python'])).toBe(0);
    expect(w.cp.calls.at(-1)!.body).toEqual({});
    expect(w.out()).toBe('my-python: released 1 lease\n');
    expect(await w.run(['templates', 'deactivate', 'my-python', '--stop-now', '--json'])).toBe(0);
    expect(w.cp.calls.at(-1)!.body).toEqual({ stopNow: true });
    expect(JSON.parse(w.out())).toEqual({ templateId: 'my-python', released: 1 });
  });
});

describe('sandboxes: --template id@build, --seed, token --renew-every, egress --verify (§3.3)', () => {
  it('passes create --template id@build through as given', async () => {
    const w = world({
      'POST /v1/sandboxes': (req) => ({
        status: 201,
        body: sandbox({ template: (req.body as { template: string }).template }),
      }),
    });
    expect(await w.run(['create', '--template', `my-python@${BUILD_ID}`])).toBe(0);
    expect(w.cp.calls.at(-1)!.body).toEqual({ template: `my-python@${BUILD_ID}` });
  });

  const seeded = (
    seed: string,
    extra: Record<string, unknown> = {},
    more: Parameters<typeof world>[0] = {},
  ) => {
    const ws = workspaces();
    const w = world({
      ...more,
      'POST /v1/sandboxes': () => ({
        status: 201,
        body: {
          ...sandbox({ template: 'my-python' }),
          buildId: BUILD_ID,
          templateManifestHash: BUILD_ID,
        },
      }),
      'GET /v1/templates/my-python': () => ({
        status: 200,
        body: template({ builds: [build({ spec: { seed, tools: ['bash'], ...extra } })] }),
      }),
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }),
    });
    return { w, ws, run: (argv: string[]) => w.run(argv, { execFactory: ws.factory }) };
  };
  const GIT_SEED =
    'git init -q /workspace && cd /workspace && echo hi > a && git add a && ' +
    'git -c user.email=t@example.com -c user.name=t -c commit.gpgSign=false commit -qm base';

  it('--seed: runs the seed first, then finds a clean tree and its HEAD', async () => {
    const s = seeded(GIT_SEED);
    expect(await s.run(['create', '--template', 'my-python', '--seed', '--json'])).toBe(0);
    const out = JSON.parse(s.w.out()) as { seed: { clean: boolean; head: string } };
    expect(out.seed).toMatchObject({ seed: GIT_SEED, exitCode: 0, clean: true });
    expect(out.seed.head).toMatch(/^[0-9a-f]{40}$/);
    expect(s.ws.get(SBX).sent[0]!.command).toBe(GIT_SEED);
    expect(s.w.err()).toContain(`seeded ${SBX}: a clean tree at ${out.seed.head}`);
  });

  it("--seed: the seed's clean tree becomes the baseline, so a plain rm deletes it (no unpulled changes)", async () => {
    let deleted = 0;
    const s = seeded(
      GIT_SEED,
      {},
      {
        [`DELETE /v1/sandboxes/${SBX}`]: () => {
          deleted++;
          return {
            status: 200,
            body: { ...sandbox({ template: 'my-python' }), state: 'terminated' },
          };
        },
      },
    );
    expect(await s.run(['create', '--template', 'my-python', '--seed'])).toBe(0);
    expect(await s.run(['rm', SBX])).toBe(0);
    expect(deleted).toBe(1);
    expect(s.w.err()).not.toContain('not yet pulled');
  });

  it('--seed: a failing seed, a dirty tree, or another HEAD than the spec names is exit 1', async () => {
    let s = seeded('exit 3');
    expect(await s.run(['create', '--template', 'my-python', '--seed'])).toBe(1);
    expect(s.w.err()).toContain('the seed exited 3');
    expect(s.w.out()).toBe(`${SBX}\n`);
    s = seeded(`${GIT_SEED} && echo x > b`);
    expect(await s.run(['create', '--template', 'my-python', '--seed'])).toBe(1);
    expect(s.w.err()).toContain('has 1 changed or untracked paths: not a clean tree');
    s = seeded(GIT_SEED, { baseline_commit: 'f'.repeat(40) });
    expect(await s.run(['create', '--template', 'my-python', '--seed'])).toBe(1);
    expect(s.w.err()).toContain(`not the spec's ${'f'.repeat(40)}`);
    s = seeded('');
    expect(await s.run(['create', '--template', 'my-python', '--seed'])).toBe(0);
    expect(s.w.err()).toContain('the template has no seed');
    expect(s.ws.get(SBX).sent).toEqual([]);
  });

  it('token --renew-every: a fresh token per period until stopped', async () => {
    const ac = new AbortController();
    let n = 0;
    const w = world({
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({
        status: 200,
        body: { ...TOKEN, token: `${TOKEN.token}${n++}` },
      }),
    });
    const sleep = async (ms: number) => {
      w.clock.slept.push(ms);
      if (w.clock.slept.length === 2) ac.abort();
    };
    expect(await w.run(['token', SBX, '--renew-every', '600'], { sleep, signal: ac.signal })).toBe(
      0,
    );
    expect(w.out().trim().split('\n')).toHaveLength(2);
    expect(w.clock.slept).toEqual([600_000, 600_000]);
    expect(await w.run(['ls', '--renew-every', '5'])).toBe(2);
  });

  it('egress --verify: the log served against its summary', async () => {
    const e = JSON.stringify({
      time: '2026-11-10T00:00:00Z',
      via: 'moca-egress',
      decision: 'tunnel',
    });
    const log = `${e}\n`;
    const sha = `sha256:${createHash('sha256').update(log).digest('hex')}`;
    let summarySha = sha;
    const w = world({
      [`GET /v1/sandboxes/${SBX}/egress`]: (req) =>
        req.path.includes('format=ndjson')
          ? { status: 200, body: JSON.parse(e) }
          : {
              status: 200,
              body: {
                events: [],
                next: null,
                summary: { byHost: {}, total: 1, dropped: 0, complete: true, sha256: summarySha },
              },
            },
    });
    // The fake answers JSON with no newline: the NDJSON body is the event plus its newline.
    const fetchImpl = (async (u: string | URL, init?: RequestInit) => {
      const r = await w.cp.fetchImpl(u, init);
      return String(u).includes('format=ndjson') ? new Response(log, { status: 200 }) : r;
    }) as typeof fetch;
    expect(await w.run(['egress', SBX, '--verify'], { fetchImpl })).toBe(0);
    expect(w.out()).toBe(`verified: 1 events, ${sha}\n`);
    summarySha = `sha256:${'0'.repeat(64)}`;
    expect(await w.run(['egress', SBX, '--verify', '--json'], { fetchImpl })).toBe(1);
    expect(JSON.parse(w.out())).toMatchObject({ verified: false, sha256: sha });
    expect(await w.run(['egress', SBX, '--verify', '--ndjson'], { fetchImpl })).toBe(2);
  });
});

describe('templates retire --wait (§3.4)', () => {
  it('waits until the build reads retired and no host holds it; past --timeout is exit 5', async () => {
    let held = [['kvm-1'], ['kvm-1'], []];
    let i = 0;
    const w = world({
      'POST /v1/templates/my-python/retire': () => ({
        status: 200,
        body: {
          templateId: 'my-python',
          subject: 'github:1',
          status: 'retired',
          builds: [{ build: HANDLE, buildId: BUILD_ID, readiness: 'retired', record: 'sha256:r' }],
        },
      }),
      [`GET ${BUILD_PATH}`]: () => ({
        status: 200,
        body: build({
          status: 'retired',
          readiness: 'retired',
          heldBy: held[Math.min(i++, held.length - 1)],
        }),
      }),
    });
    expect(await w.run(['templates', 'retire', 'my-python', '--wait'])).toBe(0);
    expect(w.err()).toContain(`my-python ${HANDLE}: retired, still held by kvm-1`);
    expect(w.err()).toContain(`my-python ${HANDLE}: retired, held by no host`);
    held = [['kvm-1']];
    i = 0;
    expect(await w.run(['templates', 'retire', 'my-python', '--wait', '--timeout', '7'])).toBe(5);
    expect(await w.run(['templates', 'retire', 'my-python', '--timeout', '7'])).toBe(2);
  });
});

describe('admin writes: read, write, compare (§3.6)', () => {
  const quotaAnswer = (before: unknown) => ({
    status: 200,
    body: {
      target: 'github:9',
      subject: 'github:1',
      quota: { templates: 5, buildsQueued: 2, active: 1 },
      before,
      policy: `sha256:${'5'.repeat(64)}`,
      record: `sha256:${'6'.repeat(64)}`,
    },
  });
  const QUOTA_ARGS = [
    'templates',
    'quota',
    'github:9',
    '--templates',
    '5',
    '--builds-queued',
    '2',
    '--active',
    '1',
  ];

  it('prints old -> new and the policy digest; a changed before fails loudly', async () => {
    let before: unknown = { templates: 3, buildsQueued: 1, active: 1 };
    const w = world({
      'GET /v1/policy': () => ({
        status: 200,
        body: policyView({
          quotaBySubject: { 'github:9': { templates: 3, buildsQueued: 1, active: 1 } },
        }),
      }),
      'PUT /v1/quota/github%3A9': () => quotaAnswer(before),
    });
    expect(await w.run(QUOTA_ARGS)).toBe(0);
    expect(w.out()).toBe(
      'github:9: templates 3, builds queued 1, active 1 -> templates 5, builds queued 2, active 1 ' +
        `(policy sha256:${'5'.repeat(64)}, record sha256:${'6'.repeat(64)})\n`,
    );
    expect(w.cp.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /v1/policy',
      'PUT /v1/quota/github%3A9',
    ]);
    before = { templates: 4, buildsQueued: 1, active: 1 };
    expect(await w.run(QUOTA_ARGS)).toBe(1);
    expect(w.err()).toContain(
      "github:9's quota was changed by someone else between read and write: templates 3, builds queued 1, active 1 / templates 4, builds queued 1, active 1 / templates 5, builds queued 2, active 1",
    );
    expect(await w.run([...QUOTA_ARGS, '--json'])).toBe(1);
    expect(JSON.parse(w.out())).toMatchObject({ read: { templates: 3 }, before: { templates: 4 } });
  });

  it('a subject change: old -> new and its record; an answer the read contradicts fails loudly', async () => {
    let subjects: unknown[] = [];
    let record: string | null = 'sha256:m';
    const w = world({
      'GET /v1/subjects': () => ({ status: 200, body: { subjects } }),
      'PUT /v1/subjects/github%3A9': () => ({
        status: 200,
        body: {
          subject: 'github:9',
          enrolled: true,
          source: 'api',
          storeEnrolled: true,
          roles: [],
          record,
        },
      }),
    });
    expect(await w.run(['admin', 'subjects', 'enroll', 'github:9'])).toBe(0);
    expect(w.out()).toContain('github:9: not enrolled -> enrolled (api) (record sha256:m)');
    // Read as not enrolled, yet the write changed nothing: someone enrolled it in between.
    record = null;
    expect(await w.run(['admin', 'subjects', 'enroll', 'github:9'])).toBe(1);
    expect(w.err()).toContain(
      "github:9's enrollment was changed by someone else between read and write: not enrolled / already so / enrolled (api)",
    );
    subjects = [
      { subject: 'github:9', enrolled: true, source: 'api', storeEnrolled: true, roles: [] },
    ];
    expect(await w.run(['admin', 'subjects', 'enroll', 'github:9'])).toBe(0);
    expect(w.out()).toContain('(unchanged)');
  });

  it("refuses a login another deployment's control plane issued, before any write", async () => {
    const { home, env, io } = setup();
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const harnessToken = `${b64({ alg: 'EdDSA' })}.${b64({ iss: 'sh-control-plane', sub: 'github:1' })}.sig`;
    saveAuth(sbxPaths(resolvePaths(env, home)), { ...LOGIN, apiToken: harnessToken });
    const cp = fakeCp({
      'GET /v1/discovery': () => ({
        status: 200,
        body: { profile: 'sandbox', execEndpoint: 'x.example.com:443' },
      }),
    });
    expect(await sbxMain(QUOTA_ARGS, env, io, { home, fetchImpl: cp.fetchImpl })).toBe(1);
    expect(io.errs.join('\n')).toContain(
      "refused: the login was issued by 'sh-control-plane', but https://sbx-api.example.invalid (profile sandbox) issues 'sbx-control-plane-api'",
    );
    expect(cp.calls.map((c) => c.path)).toEqual(['/v1/discovery']);
  });
});

describe('--record F (§3.8)', () => {
  it('redacts a host and a token by value: harnessUrl, any absolute URL, a refresh token inside text', () => {
    const rt = `mrt_${'A'.repeat(43)}`;
    const out = redact({
      profile: 'sandbox',
      harnessUrl: 'https://harness.example.com',
      links: ['http://cp.example.com/v1/x', 'not a url'],
      message: `refresh ${rt} was refused`,
      note: 'plain text',
    }) as Record<string, unknown>;
    expect(out.harnessUrl).toEqual({ length: 'https://harness.example.com'.length });
    expect(out.links).toEqual([{ length: 'http://cp.example.com/v1/x'.length }, 'not a url']);
    expect(out.message).toMatch(/^sha256:/);
    expect(out.note).toBe('plain text');
    expect(JSON.stringify(out)).not.toContain('example.com');
  });

  const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/;
  const lines = (f: string) =>
    readFileSync(f, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const noSecret = (f: string) => {
    const text = readFileSync(f, 'utf8');
    expect(text).not.toMatch(JWT_RE);
    expect(text).not.toContain('mrt_');
    expect(text).not.toContain('example');
  };

  it('one line per attempt, path only, the times and Retry-After; 0600; nothing secret', async () => {
    const f = files({ 'spec.json': SPEC, 'gate.json': '{"gate":{"passed":true}}' });
    const rec = join(f.dir, 'calls.ndjson');
    let n = 0;
    const w = world({
      'POST /v1/templates': () =>
        n++ === 0
          ? {
              status: 429,
              body: { error: 'quota_exceeded', message: 'full', quota: 'buildsQueued' },
              headers: { 'retry-after': '3' },
            }
          : { status: 202, body: QUEUED },
    });
    expect(
      await w.run([
        'templates',
        'create',
        '--spec',
        f['spec.json']!,
        '--gate-record',
        f['gate.json']!,
        '--profile',
        'base',
        '--record',
        rec,
      ]),
    ).toBe(0);
    expect(statSync(rec).mode & 0o777).toBe(0o600);
    const l = lines(rec);
    expect(l).toHaveLength(2);
    expect(l[0]).toMatchObject({
      command: 'sbx templates create',
      seq: 1,
      try: 1,
      method: 'POST',
      path: '/v1/templates',
      status: 429,
      retryAfter: '3',
    });
    expect(l[1]).toMatchObject({ seq: 2, try: 2, status: 202, answer: QUEUED });
    expect(l[0]!.invocation).toBe(l[1]!.invocation);
    expect(String(l[0]!.requestAt)).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    const sent = (l[0]!.request as { gateRecord: string }).gateRecord;
    expect(sent).toBe(
      `sha256:${createHash('sha256').update('{"gate":{"passed":true}}').digest('hex')}`,
    );
    noSecret(rec);
  });

  it('a token refresh, a sandbox token and a build log are hashed or measured, never kept', async () => {
    const { home, env, io } = setup({ loggedIn: true, expired: false });
    const dir = mkdtempSync(join(tmpdir(), 'sbx-rec-'));
    const rec = join(dir, 'r.ndjson');
    const fresh = (t: string) => ({
      token: TOKEN.token.replace('sig', t),
      subject: 'github:1',
      roles: [],
      expiresAt: 4_000_000_000,
      refreshToken: `mrt_${'z'.repeat(43)}`,
      refreshExpiresAt: 4_000_000_000,
    });
    let first = true;
    const cp = fakeCp({
      'POST /v1/sandboxes': () =>
        first
          ? ((first = false), { status: 401, body: { error: 'token_expired' } })
          : {
              status: 201,
              body: { ...sandbox(), note: TOKEN.token, nested: [{ any: `mrt_${'q'.repeat(43)}` }] },
            },
      'POST /v1/auth/token': () => ({ status: 200, body: fresh('s2') }),
      [`GET /v1/templates/x/builds/b-1`]: () => ({
        status: 200,
        body: build({
          log: [{ message: 'pulled from registry.example.com' }],
          reason: { message: 'failed at registry.example.com', step: 'build' },
        }),
      }),
      [`POST /v1/sandboxes/${SBX}/token`]: () => ({ status: 200, body: TOKEN }),
    });
    const opts = { home, fetchImpl: cp.fetchImpl };
    expect(await sbxMain(['create', '--template', 'node22', '--record', rec], env, io, opts)).toBe(
      0,
    );
    const l = lines(rec);
    // The 401, the refresh (its refresh token hashed both ways), and the retried POST: three attempts.
    expect(l.map((x) => `${x.method} ${x.path} ${x.status}`)).toEqual([
      'POST /v1/sandboxes 401',
      'POST /v1/auth/token 200',
      'POST /v1/sandboxes 201',
    ]);
    expect((l[1]!.request as { refresh_token: string }).refresh_token).toMatch(/^sha256:/);
    expect((l[2]!.answer as { note: string }).note).toMatch(/^sha256:/);
    expect(
      await sbxMain(['templates', 'show', 'x', '--build', 'b-1', '--record', rec], env, io, opts),
    ).toBe(0);
    const show = lines(rec).at(-1)!.answer as { log: unknown; reason: { message: unknown } };
    expect(show.log).toEqual({ length: expect.any(Number) });
    expect(show.reason.message).toEqual({ length: 'failed at registry.example.com'.length });
    // A sandbox token minted for a command (env, run, put): its token hashed, its endpoint measured.
    expect(await sbxMain(['env', SBX, '--record', rec], env, io, opts)).toBe(0);
    const minted = lines(rec).at(-1)!.answer as Record<string, unknown>;
    expect(minted.token).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(minted.execEndpoint).toEqual({ length: TOKEN.execEndpoint.length });
    noSecret(rec);
    // sbx token and the login commands never record.
    expect(await sbxMain(['token', SBX, '--record', rec], env, io, opts)).toBe(2);
    expect(await sbxMain(['login', '--record', rec], env, io, opts)).toBe(2);
    expect(await sbxMain(['credentials', '--record', rec], env, io, opts)).toBe(2);
    expect(io.errs.join('\n')).toContain('token takes no --record');
  });

  it('refuses an existing record readable by others; appends to a 0600 one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbx-rec-'));
    const rec = join(dir, 'r.ndjson');
    writeFileSync(rec, '');
    chmodSync(rec, 0o644);
    const w = world({ 'GET /v1/quota': () => ({ status: 200, body: { subject: 'github:1' } }) });
    expect(await w.run(['quota', '--record', rec])).toBe(2);
    expect(w.err()).toContain('mode 644: it must be 0600');
    expect(w.cp.calls).toEqual([]);
    chmodSync(rec, 0o600);
    expect(await w.run(['quota', '--record', rec])).toBe(0);
    expect(await w.run(['quota', '--record', rec])).toBe(0);
    expect(lines(rec).map((x) => x.seq)).toEqual([1, 1]);
  });
});
