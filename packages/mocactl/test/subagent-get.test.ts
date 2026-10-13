import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdGet, type GetOptions } from '../src/subagent.js';
import { LeafTransport } from '../src/transport/leaf-turn.js';
import { ApiError } from '../src/api/errors.js';

/* --- harness --- */

function makeRt(scratch: string) {
  const cp = {
    mintSessionToken: vi.fn(async () => ({ token: 'tok-xyz', expiresAt: 999 })),
    healthz: vi.fn(),
  };
  const harness = { baseUrl: vi.fn(async () => 'https://harness.test') };
  return {
    rt: {
      cp,
      harness,
      auth: { subject: 'alice', apiToken: 'api-tok', expiresAt: 999 },
      paths: { stateDir: scratch, subagentsFile: join(scratch, 'subagents.jsonl') },
      now: () => 1,
      fetchImpl: fetch,
    } as any,
    cp,
  };
}

function makeIo(): { io: any; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
}

function fakeTransport(resp: unknown): LeafTransport {
  // Minimal shape: readLeafState resolves to `resp`. Pass 'queued' or a body; a thrown ApiError
  // models an auth refusal / 404.
  return {
    readLeafState: vi.fn(async () => {
      if (resp instanceof Error) throw resp;
      return resp;
    }),
  } as unknown as LeafTransport;
}

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'get-'));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const baseOpts = (over: Partial<GetOptions> = {}): GetOptions => ({
  sessionId: 'sess-abc',
  json: false,
  ...over,
});

/* --- validation --- */

describe('cmdGet — sessionId validation', () => {
  it('refuses an illegal sessionId before any network call', async () => {
    const { rt, cp } = makeRt(scratch);
    const { io, err } = makeIo();
    const r = await cmdGet(rt, io, baseOpts({ sessionId: 'has/slash' }));
    expect(r).toBe(2);
    expect(cp.mintSessionToken).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('invalid sessionId');
  });
});

/* --- not-yet-terminal + not-found --- */

describe('cmdGet — not-yet-terminal and not-found', () => {
  it("reports 'has not finished yet' and exits 1 when the server says 'queued'", async () => {
    const { rt } = makeRt(scratch);
    const { io, err } = makeIo();
    const r = await cmdGet(
      rt,
      io,
      baseOpts({ transport: fakeTransport('queued'), outDir: scratch }),
    );
    expect(r).toBe(1);
    expect(err.join('\n')).toContain('has not finished yet');
  });

  it("reports 'no session' and exits 1 when the server refuses the sessionId with 404", async () => {
    const { rt } = makeRt(scratch);
    const { io, err } = makeIo();
    const { ApiError } = await import('../src/api/errors.js');
    const r = await cmdGet(
      rt,
      io,
      baseOpts({
        transport: fakeTransport(new ApiError('harness', 404, 'session_not_found')),
        outDir: scratch,
      }),
    );
    expect(r).toBe(1);
    expect(err.join('\n')).toContain("no session 'sess-abc'");
  });
});

/* --- terminal result shapes: text, verdict, patch --- */

describe('cmdGet — terminal result shapes', () => {
  it('writes <sid>.text for a responded body and shows a bounded summary on stdout', async () => {
    const { rt } = makeRt(scratch);
    const { io, out } = makeIo();
    const body = { status: 'responded', text: 'line1\nline2\nline3' } as const;
    const r = await cmdGet(rt, io, baseOpts({ transport: fakeTransport(body), outDir: scratch }));
    expect(r).toBe(0);
    const p = join(scratch, 'sess-abc.text');
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('line1\nline2\nline3');
    expect(out.join('')).toContain('line1');
  });

  it('writes <sid>.verdict.json for a verdict shape (JSON pretty-printed)', async () => {
    const { rt } = makeRt(scratch);
    const { io } = makeIo();
    const body = {
      status: 'done',
      verdict: { item_id: 'x', verdict: 'OK', reason: 'all good' },
    } as const;
    const r = await cmdGet(rt, io, baseOpts({ transport: fakeTransport(body), outDir: scratch }));
    expect(r).toBe(0);
    const p = join(scratch, 'sess-abc.verdict.json');
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual(body.verdict);
  });

  it('writes <sid>.patch and normalizes a trailing newline so git apply does not reject', async () => {
    const { rt } = makeRt(scratch);
    const { io } = makeIo();
    const body = { status: 'solved', patch: 'diff --git a b\n@@ -1 +1 @@\n-a\n+b' } as const;
    const r = await cmdGet(rt, io, baseOpts({ transport: fakeTransport(body), outDir: scratch }));
    expect(r).toBe(0);
    const content = readFileSync(join(scratch, 'sess-abc.patch'), 'utf8');
    expect(content.endsWith('\n')).toBe(true);
    expect(content).toContain('+b\n');
  });

  it('returns exit 1 for status=failed even though the body is terminal', async () => {
    const { rt } = makeRt(scratch);
    const { io, err } = makeIo();
    const body = { status: 'failed', reason: 'saturated', message: 'pool full' } as const;
    const r = await cmdGet(rt, io, baseOpts({ transport: fakeTransport(body), outDir: scratch }));
    expect(r).toBe(1);
    expect(err.join('\n')).toContain('failed');
  });
});

/* --- --json mode --- */

describe('cmdGet --json', () => {
  it('--json emits one JSON line, with no human summary on stdout', async () => {
    const { rt } = makeRt(scratch);
    const { io, out } = makeIo();
    const body = { status: 'solved', patch: 'diff\n' } as const;
    const r = await cmdGet(
      rt,
      io,
      baseOpts({ json: true, transport: fakeTransport(body), outDir: scratch }),
    );
    expect(r).toBe(0);
    const stdout = out.join('');
    const parsed = JSON.parse(stdout.trim());
    expect(parsed.sessionId).toBe('sess-abc');
    expect(parsed.status).toBe('solved');
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatch(/sess-abc\.patch$/);
  });
});

/* --- API errors --- */

describe('cmdGet — ApiError translation', () => {
  it('on a 404 ApiError with code=session_not_found, prints "no session" (no stack trace)', async () => {
    const { rt } = makeRt(scratch);
    const { io, err } = makeIo();
    const transport = {
      readLeafState: vi.fn(async () => {
        throw new ApiError('harness', 404, 'session_not_found');
      }),
    } as unknown as LeafTransport;
    const r = await cmdGet(rt, io, baseOpts({ transport, outDir: scratch }));
    expect(r).toBe(1);
    expect(err.join('\n')).toContain("no session 'sess-abc'");
  });
});

describe('cmdGet — paused is not success', () => {
  it('exits 1 for a paused body (terminal, but still awaiting a gate decision)', async () => {
    const { rt } = makeRt(scratch);
    const { io } = makeIo();
    const body = {
      status: 'paused',
      gateId: 1,
      gate: { summary: 'approve this?', proposed_action: 'go' },
    } as const;
    const r = await cmdGet(rt, io, baseOpts({ transport: fakeTransport(body), outDir: scratch }));
    expect(r).toBe(1);
  });

  it('--json on paused still emits the file list on stdout', async () => {
    const { rt } = makeRt(scratch);
    const { io, out } = makeIo();
    const body = { status: 'paused', text: 'awaiting decision' } as const;
    const r = await cmdGet(
      rt,
      io,
      baseOpts({ json: true, transport: fakeTransport(body), outDir: scratch }),
    );
    expect(r).toBe(1);
    const parsed = JSON.parse(out[0]!.trim());
    expect(parsed.status).toBe('paused');
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0]).toMatch(/sess-abc\.text$/);
  });
});
