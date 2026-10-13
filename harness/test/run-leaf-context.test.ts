import { describe, expect, it, vi } from 'vitest';

const { selectPoolSandboxMock } = vi.hoisted(() => ({ selectPoolSandboxMock: vi.fn() }));
vi.mock('../src/select-sandbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/select-sandbox.js')>();
  return { ...actual, selectPoolSandbox: (...args: unknown[]) => selectPoolSandboxMock(...args) };
});

import { runLeaf, type LeafEnvelope } from '../src/run-leaf.js';

type ExecuteTurnDep = NonNullable<NonNullable<Parameters<typeof runLeaf>[2]>['executeTurn']>;

const REVISION = 'd'.repeat(64);
const SCOPE = 'e'.repeat(32);

const okTurn = () =>
  vi.fn<ExecuteTurnDep>(async () => ({
    sessionId: 'run-1',
    response: 'text',
    stopReason: 'end_turn',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
  }));

const relayLease = () => {
  const transport = {
    exec: vi.fn(async (..._args: unknown[]) => ({
      stdout: Buffer.from(''),
      exitCode: 0,
      truncated: false,
    })),
    close: vi.fn(async () => {}),
  };
  return {
    lease: {
      config: { pod: 'sbx-0', namespace: 'moca', podCwd: '/workspace', headCwd: '/tmp' },
      transport,
      leased: true,
      heartbeat: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    },
    transport,
  };
};

const env = (loadBundle: () => Promise<Buffer>): LeafEnvelope =>
  ({
    sessionId: 'run-1',
    item: { item_id: 'i1', file: 'f', pattern: 'p' },
    kind: 'prompt',
    prompt: 'Inspect.',
    internalContext: { revision: REVISION, ownerScope: SCOPE, loadBundle },
  }) as LeafEnvelope;

describe('frozen context on a prompt leaf', () => {
  it('overlays through the relay transport, points the prompt at it, and cleans up', async () => {
    const { lease, transport } = relayLease();
    selectPoolSandboxMock.mockReset().mockResolvedValue(lease);
    const loadBundle = vi.fn();
    const overlayContext = vi.fn(async () => '/workspace/.moca-context/runs/run-1');
    const executeTurn = okTurn();
    const r = await runLeaf(env(loadBundle), undefined, { executeTurn, overlayContext });

    expect(r.status).toBe('responded');
    expect(overlayContext).toHaveBeenCalledWith(
      transport,
      `${SCOPE}-${REVISION}`,
      'run-1',
      loadBundle,
    );
    expect(executeTurn.mock.calls[0]![0].prompt).toContain('/workspace/.moca-context/runs/run-1');
    expect(
      transport.exec.mock.calls.some(([script]) => String(script).includes('CONTEXT_CLEANUP')),
    ).toBe(true);
    expect(lease.release).toHaveBeenCalled();
  });

  it('fails without running a turn when the sandbox is not a P6 relay sandbox', async () => {
    const { lease } = relayLease();
    selectPoolSandboxMock.mockReset().mockResolvedValue({ ...lease, transport: undefined });
    const executeTurn = okTurn();
    const r = await runLeaf(env(vi.fn()), undefined, { executeTurn, overlayContext: vi.fn() });
    expect(r).toMatchObject({ status: 'failed', message: expect.stringContaining('P6 relay') });
    expect(executeTurn).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalled();
  });

  it('reports an overlay failure as a run failure and still releases the ref', async () => {
    const { lease, transport } = relayLease();
    selectPoolSandboxMock.mockReset().mockResolvedValue(lease);
    const executeTurn = okTurn();
    const overlayContext = vi.fn(async () => {
      throw new Error('Context Service is unreachable');
    });
    const r = await runLeaf(env(vi.fn()), undefined, { executeTurn, overlayContext });
    expect(r).toMatchObject({
      status: 'failed',
      message: 'context overlay failed: Context Service is unreachable',
    });
    expect(executeTurn).not.toHaveBeenCalled();
    expect(
      transport.exec.mock.calls.some(([script]) => String(script).includes('CONTEXT_CLEANUP')),
    ).toBe(true);
  });
});
