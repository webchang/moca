import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  ProvenanceStore,
  recordDigest,
  sha256Hex,
  verifyExport,
  type ProvenanceExport,
} from '../src/provenance.js';

const T0 = Date.parse('2026-11-03T20:00:00Z');
const freshDir = (): string => mkdtempSync(join(tmpdir(), 'cp-provenance-'));
const store = (dir = freshDir()): ProvenanceStore => new ProvenanceStore({ dir, now: () => T0 });

const GATE = Buffer.from('{"schema":"image-factory/moca-microvm/1","gate":{"passed":true}}\n');

/** A policy, then one template's create, gate, build and check: the chain §10 step 2 writes. */
async function onboard(s: ProvenanceStore): Promise<{ policy: string; head: string }> {
  const policy = await s.append({
    stream: 'policy',
    kind: 'policy',
    subject: 'github:1',
    body: { profiles: { benchmark: {} } },
  });
  const t = 'template/django-django-11133';
  await s.append({
    stream: t,
    kind: 'create',
    subject: 'github:2',
    body: { image: 'x@sha256:ab', profile: 'benchmark' },
  });
  const gateSha = await s.putBlob(GATE);
  await s.append({
    stream: t,
    kind: 'gate',
    subject: 'github:2',
    body: { record_sha256: gateSha, source: 'image-factory' },
  });
  await s.append({
    stream: t,
    kind: 'build',
    subject: 'host:bm1',
    body: { manifest_hash: 'sha256:cd' },
  });
  const check = await s.append({
    stream: t,
    kind: 'check',
    subject: 'policy',
    body: { policy: policy.digest, outcome: 'registered' },
  });
  return { policy: policy.digest, head: check.digest };
}

describe('canonicalJson', () => {
  it('sorts keys at every depth and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [true, null], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[true,null]},"b":1}',
    );
  });
  it('refuses what a second implementation could encode differently', () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow(/integers/);
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson({ é: 1 })).toThrow(/ASCII/);
    expect(() => canonicalJson({ a: '\ud800' })).toThrow(/surrogate/);
    expect(() => canonicalJson(new Date(0))).toThrow();
  });
  it('keeps non-ASCII string values as JSON.stringify writes them', () => {
    expect(canonicalJson({ a: 'café ✓' })).toBe('{"a":"café ✓"}');
  });
});

describe('ProvenanceStore', () => {
  it('chains records by prev, names each by the sha256 of its bytes, and counts the head', async () => {
    const dir = freshDir();
    const s = store(dir);
    const { head } = await onboard(s);
    const chain = await s.chain('template/django-django-11133');
    expect(chain.map((r) => r.kind)).toEqual(['create', 'gate', 'build', 'check']);
    expect(chain.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(chain[0].prev).toBeNull();
    for (let i = 1; i < chain.length; i++) expect(chain[i].prev).toBe(recordDigest(chain[i - 1]));
    expect(await s.head('template/django-django-11133')).toEqual({
      stream: 'template/django-django-11133',
      head,
      count: 4,
    });
    for (const f of readdirSync(join(dir, 'records'))) {
      expect(`${sha256Hex(readFileSync(join(dir, 'records', f)))}.json`).toBe(f);
    }
    expect(chain[0].at).toBe('2026-11-03T20:00:00Z');
  });

  it('keeps one stream per template: another template starts at seq 1', async () => {
    const s = store();
    await onboard(s);
    const r = await s.append({
      stream: 'template/py312',
      kind: 'create',
      subject: 'github:2',
      body: {},
    });
    expect(r.record.seq).toBe(1);
    expect(r.record.prev).toBeNull();
  });

  it('serializes concurrent appends to one stream: no two records share a seq', async () => {
    const s = store();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        s.append({ stream: 'template/t', kind: 'use', subject: 'policy', body: { n: i } }),
      ),
    );
    const chain = await s.chain('template/t');
    expect(chain.map((r) => r.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('refuses a malformed stream, an unknown kind, a policy record outside the policy stream', async () => {
    const s = store();
    await expect(
      s.append({ stream: 'template/Bad', kind: 'create', subject: 'a', body: {} }),
    ).rejects.toThrow(/stream/);
    await expect(
      s.append({ stream: 'template/x', kind: 'nope' as never, subject: 'a', body: {} }),
    ).rejects.toThrow(/kind/);
    await expect(
      s.append({ stream: 'template/x', kind: 'policy', subject: 'a', body: {} }),
    ).rejects.toThrow(/policy stream/);
    await expect(
      s.append({ stream: 'policy', kind: 'create', subject: 'a', body: {} }),
    ).rejects.toThrow(/template stream/);
    await expect(
      s.append({ stream: 'template/x', kind: 'create', subject: '', body: {} }),
    ).rejects.toThrow(/subject/);
  });

  it('refuses to read a record whose file was edited', async () => {
    const dir = freshDir();
    const s = store(dir);
    const { head } = await onboard(s);
    const f = join(dir, 'records', `${head.slice(7)}.json`);
    writeFileSync(f, readFileSync(f, 'utf8').replace('registered', 'rejected'));
    await expect(s.chain('template/django-django-11133')).rejects.toThrow(
      /does not match its digest/,
    );
  });

  it('stores a cited document byte for byte under its sha256', async () => {
    const s = store();
    const d = await s.putBlob(GATE);
    expect(d).toBe(`sha256:${sha256Hex(GATE)}`);
    expect((await s.getBlob(d))?.equals(GATE)).toBe(true);
    expect(await s.putBlob(GATE)).toBe(d); // idempotent
  });

  it('writes a file once, refuses other bytes under its name, and leaves no temp file', async () => {
    const dir = freshDir();
    const s = store(dir);
    const d = await s.putBlob(GATE);
    const blob = join(dir, 'blobs', d.slice('sha256:'.length));
    // A file under the name with other bytes (not one the store wrote) is never overwritten.
    writeFileSync(blob, 'other bytes');
    await expect(s.putBlob(GATE)).rejects.toThrow(/exists with other bytes/);
    expect(readFileSync(blob, 'utf8')).toBe('other bytes');
    expect(readdirSync(join(dir, 'blobs')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    const dir2 = freshDir();
    await onboard(store(dir2));
    expect(readdirSync(join(dir2, 'records')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('survives a restart: a new store on the same directory continues the chain', async () => {
    const dir = freshDir();
    const { head } = await onboard(store(dir));
    const again = store(dir);
    const r = await again.append({
      stream: 'template/django-django-11133',
      kind: 'activate',
      subject: 'github:2',
      body: {},
    });
    expect(r.record.prev).toBe(head);
    expect(r.record.seq).toBe(5);
  });
});

describe('export and offline verification', () => {
  const exported = async (): Promise<ProvenanceExport> => {
    const s = store();
    await onboard(s);
    return JSON.parse(JSON.stringify(await s.export(['template/django-django-11133'])));
  };

  it('exports the template stream, the policy stream it cites and the gate record; verifies', async () => {
    const doc = await exported();
    expect(doc.streams.map((h) => h.stream).sort()).toEqual([
      'policy',
      'template/django-django-11133',
    ]);
    expect(doc.blobs).toHaveLength(1);
    expect(verifyExport(doc)).toMatchObject({ ok: true, errors: [] });
  });

  it.each([
    ['an edited body', (d: ProvenanceExport) => (d.records[1].body.profile = 'base'), /prev|head/],
    [
      'a dropped middle record',
      (d: ProvenanceExport) => d.records.splice(2, 1),
      /seq|prev|records/,
    ],
    ['a reordered stream', (d: ProvenanceExport) => d.records.reverse(), /seq|prev/],
    [
      'a moved head',
      (d: ProvenanceExport) => (d.streams[0].head = `sha256:${'0'.repeat(64)}`),
      /head says/,
    ],
    [
      'an edited gate record',
      (d: ProvenanceExport) => (d.blobs[0].base64 = Buffer.from('{}').toString('base64')),
      /blob/,
    ],
    ['a dropped gate record', (d: ProvenanceExport) => d.blobs.pop(), /gate cites/],
    [
      'a check citing no policy record',
      (d: ProvenanceExport) => {
        const c = d.records.find((r) => r.kind === 'check')!;
        c.body.policy = `sha256:${'1'.repeat(64)}`;
      },
      /check cites policy/,
    ],
    ['a stream with no head', (d: ProvenanceExport) => d.streams.splice(0, 1), /no head/],
  ])('fails on %s', async (_name, edit, want) => {
    const doc = await exported();
    edit(doc);
    const v = verifyExport(doc);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toMatch(want);
  });
});

// The stdlib-only verifier an auditor runs (deploy/sbx/template-onboarding/verify-provenance.py)
// must agree with verifyExport on every export: run it on the good one and on each tampered one.
const VERIFIER = resolve(__dirname, '../../../deploy/sbx/template-onboarding/verify-provenance.py');
const havePython = spawnSync('python3', ['--version']).status === 0;
const runVerifier = (
  doc: ProvenanceExport,
  ...args: string[]
): { status: number | null; out: string } => {
  const f = join(freshDir(), 'export.json');
  writeFileSync(f, JSON.stringify(doc));
  const r = spawnSync('python3', [VERIFIER, f, ...args], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

describe.skipIf(!havePython)('verify-provenance.py agrees with verifyExport', () => {
  it('verifies a good export, with non-ASCII text and nesting in bodies', async () => {
    const s = store();
    await onboard(s);
    await s.append({
      stream: 'template/django-django-11133',
      kind: 'use',
      subject: 'policy',
      body: { note: 'café ✓ "quoted" \\ \u0001', nested: { b: [1, -2, true, null], a: '' } },
    });
    const doc = JSON.parse(JSON.stringify(await s.export(['template/django-django-11133'])));
    expect(verifyExport(doc).ok).toBe(true);
    const r = runVerifier(doc);
    expect(r.out).toContain('ok template/django-django-11133: 5 records');
    expect(r.status).toBe(0);
  });

  it('verifies a store holding the sandbox kind (added 2026-11-06), with its lease a record digest', async () => {
    const s = store();
    await onboard(s);
    const act = await s.append({
      stream: 'template/django-django-11133',
      kind: 'activate',
      subject: 'github:1',
      body: { buildId: 'sha256:' + 'a'.repeat(64), leaseSeconds: 3600 },
    });
    await s.append({
      stream: 'template/django-django-11133',
      kind: 'sandbox',
      subject: 'github:1',
      body: {
        sandboxId: 'sbx-1',
        buildId: 'sha256:' + 'a'.repeat(64),
        lease: act.digest,
        state: 'created',
      },
    });
    const doc = JSON.parse(JSON.stringify(await s.export(['template/django-django-11133'])));
    expect(verifyExport(doc).ok).toBe(true);
    const r = runVerifier(doc);
    expect(r.status).toBe(0);
    expect(r.out).toContain('ok template/django-django-11133: 6 records');
  });

  it('verifies a store holding the session kind (added 2026-11-06), created and terminated', async () => {
    const s = store();
    await onboard(s);
    const act = await s.append({
      stream: 'template/django-django-11133',
      kind: 'activate',
      subject: 'github:1',
      body: { buildId: 'sha256:' + 'a'.repeat(64), leaseSeconds: 3600 },
    });
    for (const body of [
      {
        sessionId: 'sess-1',
        buildId: 'sha256:' + 'a'.repeat(64),
        templateManifestHash: 'sha256:' + 'a'.repeat(64),
        lease: act.digest,
        state: 'created',
      },
      {
        sessionId: 'sess-1',
        buildId: 'sha256:' + 'a'.repeat(64),
        state: 'terminated',
        reason: 'deleted',
        endedAt: 1,
      },
    ]) {
      await s.append({
        stream: 'template/django-django-11133',
        kind: 'session',
        subject: 'github:1',
        body,
      });
    }
    const doc = JSON.parse(JSON.stringify(await s.export(['template/django-django-11133'])));
    expect(verifyExport(doc).ok).toBe(true);
    const r = runVerifier(doc);
    expect(r.status).toBe(0);
    expect(r.out).toContain('ok template/django-django-11133: 7 records');
  });

  it('fails where verifyExport fails', async () => {
    const s = store();
    await onboard(s);
    const doc = JSON.parse(
      JSON.stringify(await s.export(['template/django-django-11133'])),
    ) as ProvenanceExport;
    doc.records[1].body.profile = 'base';
    expect(verifyExport(doc).ok).toBe(false);
    const r = runVerifier(doc);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/FAIL/);
  });

  it('compares a head kept elsewhere (--head), which catches a truncated export', async () => {
    const s = store();
    const { head } = await onboard(s);
    await s.append({
      stream: 'template/django-django-11133',
      kind: 'activate',
      subject: 'github:2',
      body: {},
    });
    const doc = JSON.parse(
      JSON.stringify(await s.export(['template/django-django-11133'])),
    ) as ProvenanceExport;
    // Truncate to the state before the activate: self-consistent, so only the kept head can tell.
    doc.records = doc.records.filter((r) => r.kind !== 'activate');
    const h = doc.streams.find((x) => x.stream === 'template/django-django-11133')!;
    h.head = head;
    h.count = 4;
    expect(verifyExport(doc).ok).toBe(true);
    const kept = (await s.head('template/django-django-11133'))!.head;
    const r = runVerifier(doc, '--head', `template/django-django-11133=${kept}`);
    expect(r.status).toBe(1);
    expect(r.out).toContain('the kept head is');
  });
});

// Register G42: verify-provenance.py --egress SANDBOX_ID=FILE, an optional, additive check of a
// sandbox's exported egress log against the egress its newest `sandbox` record names.
describe.skipIf(!havePython)('verify-provenance.py --egress (G42)', () => {
  const TPL = 'template/django-django-11133';
  const SBX = 'sbx-0123456789abcdef0123456789';
  const NDJSON =
    '{"bytes_down":20,"bytes_up":10,"decision":"tunnel","host":"pypi.example.com","sid":"sbx-0123456789abcdef0123456789","status":200,"time":"2026-11-08T12:00:00Z","via":"moca-egress"}\n' +
    '{"bytes_down":0,"bytes_up":0,"decision":"destination_denied","host":"files.example.com","method":"GET","path":"/x/","sid":"sbx-0123456789abcdef0123456789","status":403,"time":"2026-11-08T12:00:01Z","via":"moca-egress"}\n';
  const egressOf = (data: string, over: Record<string, unknown> = {}) => ({
    events: data.split('\n').length - 1,
    sha256: `sha256:${sha256Hex(Buffer.from(data, 'utf8'))}`,
    dropped: 0,
    complete: true,
    ...over,
  });
  const ended = async (egress?: Record<string, unknown>, late?: Record<string, unknown>) => {
    const s = store();
    await onboard(s);
    await s.append({
      stream: TPL,
      kind: 'sandbox',
      subject: 'github:1',
      body: { sandboxId: SBX, buildId: null, state: 'created' },
    });
    await s.append({
      stream: TPL,
      kind: 'sandbox',
      subject: 'github:1',
      body: {
        sandboxId: SBX,
        buildId: null,
        state: 'terminated',
        reason: 'deleted',
        endedAt: 1,
        ...(egress ? { egress } : {}),
      },
    });
    if (late)
      await s.append({
        stream: TPL,
        kind: 'sandbox',
        subject: 'janitor',
        body: { sandboxId: SBX, buildId: null, state: 'egress', egress: late },
      });
    return JSON.parse(JSON.stringify(await s.export([TPL]))) as ProvenanceExport;
  };
  const file = (data: string) => {
    const f = join(freshDir(), 'egress.ndjson');
    writeFileSync(f, data);
    return f;
  };

  it('leaves the existing checks unchanged: a copy without any egress record verifies, rc 0', async () => {
    const doc = await ended();
    expect(verifyExport(doc).ok).toBe(true);
    const r = runVerifier(doc);
    expect(r.status).toBe(0);
    expect(r.out).toContain(`ok ${TPL}: 6 records`);
    expect(r.out).not.toContain('egress');
    // A copy with an egress record verifies the same way when --egress is not given.
    const withEgress = runVerifier(await ended(egressOf(NDJSON)));
    expect(withEgress.status).toBe(0);
    expect(withEgress.out).not.toContain('egress');
  });

  it("checks a log's sha256 and line count against its end record, and says when it is incomplete", async () => {
    const ok = runVerifier(await ended(egressOf(NDJSON)), '--egress', `${SBX}=${file(NDJSON)}`);
    expect(ok.status).toBe(0);
    expect(ok.out).toContain(`ok egress ${SBX}: 2 events, sha256:`);
    expect(ok.out).toContain('complete');
    const inc = runVerifier(
      await ended(egressOf(NDJSON, { dropped: 3, complete: false })),
      '--egress',
      `${SBX}=${file(NDJSON)}`,
    );
    expect(inc.status).toBe(0);
    expect(inc.out).toContain('INCOMPLETE, 3 dropped');
    // With the record's droppedBy, the line names the reasons.
    const why = runVerifier(
      await ended(
        egressOf(NDJSON, {
          dropped: 5,
          complete: false,
          droppedBy: { proxy: 0, cap: 0, budget: 4, invalid: 1 },
        }),
      ),
      '--egress',
      `${SBX}=${file(NDJSON)}`,
    );
    expect(why.status).toBe(0);
    expect(why.out).toContain('INCOMPLETE, 5 dropped (budget 4, invalid 1)');
  });

  it('takes the newest record naming egress: a later state: egress record wins over the end record', async () => {
    const more = `${NDJSON}{"decision":"aborted","time":"2026-11-08T12:00:02Z","via":"moca-egress"}\n`;
    const doc = await ended(egressOf(NDJSON), egressOf(more));
    expect(runVerifier(doc, '--egress', `${SBX}=${file(more)}`).status).toBe(0);
    const old = runVerifier(doc, '--egress', `${SBX}=${file(NDJSON)}`);
    expect(old.status).toBe(1);
    expect(old.out).toContain('the record names');
  });

  it('fails on a changed log, a missing record, and refuses an unreadable file (rc 2)', async () => {
    const doc = await ended(egressOf(NDJSON));
    const changed = runVerifier(doc, '--egress', `${SBX}=${file(NDJSON.replace('10', '11'))}`);
    expect(changed.status).toBe(1);
    expect(changed.out).toContain("the file's sha256 is");
    const none = runVerifier(await ended(), '--egress', `${SBX}=${file(NDJSON)}`);
    expect(none.status).toBe(1);
    expect(none.out).toContain('no sandbox record of the export names its egress log');
    expect(runVerifier(doc, '--egress', `${SBX}=/nonexistent/x`).status).toBe(2);
    expect(runVerifier(doc, '--egress', SBX).status).toBe(2);
  });
});
