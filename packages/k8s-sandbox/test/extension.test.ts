import { describe, expect, it, vi } from 'vitest';
import type { K8sSandboxConfig } from '../src/config.js';
import { SandboxCapacityRefusedError, type SandboxTransport } from '../src/transport.js';
import { k8sSandboxExtension } from '../src/extension.js';
import { createCapacityLatch } from '../src/capacity-latch.js';

const cfg: K8sSandboxConfig = {
  pod: 'sbx-0',
  namespace: 'default',
  context: undefined,
  podCwd: '/workspace',
  headCwd: '/head',
};

/** Minimal ExtensionAPI stub recording registrations + event handlers. */
function fakePi() {
  const tools: unknown[] = [];
  const handlers: Record<string, (...a: unknown[]) => unknown> = {};
  const pi = {
    registerTool: (t: unknown) => tools.push(t),
    on: (name: string, h: (...a: unknown[]) => unknown) => {
      handlers[name] = h;
    },
  } as unknown as Parameters<ReturnType<typeof k8sSandboxExtension>>[0];
  return { pi, tools, handlers };
}

const okTransport = (close = vi.fn(async () => {})): SandboxTransport => ({
  exec: async () => ({ stdout: Buffer.from(''), exitCode: 0, truncated: false }),
  close,
});

describe('k8sSandboxExtension', () => {
  it('registers the seven pod tools and wires the lifecycle handlers', () => {
    const { pi, tools, handlers } = fakePi();
    k8sSandboxExtension({ config: cfg, transport: okTransport() })(pi);
    expect(tools).toHaveLength(7);
    expect(typeof handlers.user_bash).toBe('function');
    expect(typeof handlers.before_agent_start).toBe('function');
    expect(typeof handlers.session_shutdown).toBe('function');
  });

  it('closes the fast channel on session_shutdown', async () => {
    const close = vi.fn(async () => {});
    const { pi, handlers } = fakePi();
    k8sSandboxExtension({ config: cfg, transport: okTransport(close) })(pi);
    await handlers.session_shutdown();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('is inert (registers nothing) when config is null', () => {
    const { pi, tools } = fakePi();
    k8sSandboxExtension({ config: null })(pi);
    expect(tools).toHaveLength(0);
  });

  it('never sends the harness process environment to the sandbox through the bash tool', async () => {
    const commands: string[] = [];
    const recording: SandboxTransport = {
      exec: async (command) => {
        commands.push(command);
        return { stdout: Buffer.from(''), exitCode: 0, truncated: false };
      },
      close: vi.fn(async () => {}),
    };
    const saved = process.env.MI1_PLANTED_SECRET;
    process.env.MI1_PLANTED_SECRET = 'planted-value-must-not-cross'; // notsecret
    try {
      const { pi, tools } = fakePi();
      k8sSandboxExtension({ config: cfg, transport: recording })(pi);
      const bash = (
        tools as Array<{ name: string; execute: (...a: unknown[]) => Promise<unknown> }>
      ).find((t) => t.name === 'bash')!;
      await bash.execute('call-1', { command: 'echo hi' });
      expect(commands).toHaveLength(1);
      expect(commands[0]).not.toContain('planted-value-must-not-cross');
      expect(commands[0]).not.toContain('MI1_PLANTED_SECRET');
    } finally {
      if (saved === undefined) delete process.env.MI1_PLANTED_SECRET;
      else process.env.MI1_PLANTED_SECRET = saved;
    }
  });
});

/**
 * #452. The extension is where a host's capacity refusal is caught on its way past — for
 * all seven tools at once — and where the agent loop is told to stop spending turns on a
 * sandbox that is refusing work.
 */
describe('k8sSandboxExtension capacity latch', () => {
  const refusing = (): SandboxTransport => ({
    exec: async () => {
      throw new SandboxCapacityRefusedError('memory-budget: committing 301989888 more bytes');
    },
    close: vi.fn(async () => {}),
  });

  const runBash = async (tools: unknown[]) => {
    const bash = (
      tools as Array<{ name: string; execute: (...a: unknown[]) => Promise<unknown> }>
    ).find((t) => t.name === 'bash')!;
    // Not awaited expecting a rejection: Pi's bash tool catches the throw and reports it
    // as tool content, which is precisely the behaviour the latch exists to work around.
    await bash.execute('call-1', { command: 'pytest -x' }).catch(() => {});
  };

  // A `tool_call` event for one of the extension's OWN tools. The handler is scoped by
  // `toolName` (see SANDBOX_TOOLS), so every assertion about blocking has to name a tool
  // or it passes for the wrong reason.
  const callOf = (toolName: string) => ({ type: 'tool_call', toolCallId: 'c1', toolName });
  const sandboxCall = () => callOf('bash');

  it('registers no tool_call handler when no latch is supplied', () => {
    // Keeps every existing caller's handler set exactly as it was. The hook is a hard stop
    // on a turn and must not appear on a path with nothing to read the latch afterwards.
    const { pi, handlers } = fakePi();
    k8sSandboxExtension({ config: cfg, transport: okTransport() })(pi);
    expect(handlers.tool_call).toBeUndefined();
  });

  it('latches a refusal that passes through a tool, and then blocks the loop', async () => {
    const capacity = createCapacityLatch();
    const { pi, tools, handlers } = fakePi();
    k8sSandboxExtension({ config: cfg, transport: refusing(), capacity })(pi);

    // Transparent until a refusal is seen, or it would end every turn it is attached to.
    expect(handlers.tool_call(sandboxCall(), {})).toEqual({});
    expect(capacity.refusal()).toBeUndefined();

    await runBash(tools);

    expect(capacity.refusal()).toBeInstanceOf(SandboxCapacityRefusedError);
    expect(handlers.tool_call(sandboxCall(), {})).toMatchObject({ block: true });
    // The reason reaches the MODEL, so it must not quote the host's byte arithmetic — that
    // is for the operator, and it travels in the rethrown error.
    const reason = (handlers.tool_call(sandboxCall(), {}) as { reason: string }).reason;
    expect(reason).not.toMatch(/\d{6,}/);
    expect(() => capacity.throwIfRefused()).toThrow(SandboxCapacityRefusedError);
  });

  it('does not latch an ordinary tool failure', async () => {
    // A failing command must stay a failing command: latching one would end the turn and
    // answer 503 + Retry-After for a sandbox that is working perfectly well.
    const capacity = createCapacityLatch();
    const { pi, tools, handlers } = fakePi();
    const failing: SandboxTransport = {
      exec: async () => {
        throw new Error('exit status 1');
      },
      close: vi.fn(async () => {}),
    };
    k8sSandboxExtension({ config: cfg, transport: failing, capacity })(pi);
    await runBash(tools);
    expect(capacity.refusal()).toBeUndefined();
    expect(handlers.tool_call(sandboxCall(), {})).toEqual({});
    expect(() => capacity.throwIfRefused()).not.toThrow();
  });

  it('blocks only the tools it registered, so a verdict can still be submitted', async () => {
    // An extension's `tool_call` handler sees EVERY tool in the session, not only its own.
    // A verdict leaf also carries submit_verdict and request_approval, which never cross
    // the sandbox seam — and run-leaf.ts only calls throwIfRefused() when nothing was
    // captured, precisely so a verdict the model can still reach becomes the leaf's
    // result. Blocking the submit would discard finished reasoning and send the run back
    // to redo it.
    const capacity = createCapacityLatch();
    const { pi, tools, handlers } = fakePi();
    k8sSandboxExtension({ config: cfg, transport: refusing(), capacity })(pi);
    await runBash(tools);
    expect(capacity.refusal()).toBeInstanceOf(SandboxCapacityRefusedError);

    // Latched, so every sandbox tool is blocked...
    for (const name of ['read', 'write', 'edit', 'ls', 'find', 'bash', 'grep']) {
      expect(handlers.tool_call(callOf(name), {})).toMatchObject({ block: true });
    }
    // ...and nothing else is.
    for (const name of ['submit_verdict', 'request_approval']) {
      expect(handlers.tool_call(callOf(name), {})).toEqual({});
    }
  });

  it('scopes the block to exactly the tools the extension registers', async () => {
    // Pins the SANDBOX_TOOLS set against the REGISTRATIONS rather than trusting the list.
    // An eighth pod tool added without updating the set would ship a tool whose refusals
    // the model keeps retrying through a doomed turn; this fails instead.
    const capacity = createCapacityLatch();
    const { pi, tools, handlers } = fakePi();
    k8sSandboxExtension({ config: cfg, transport: refusing(), capacity })(pi);
    const registered = (tools as Array<{ name: string }>).map((t) => t.name).sort();

    await runBash(tools);

    const blocked = registered
      .filter((name) => (handlers.tool_call(callOf(name), {}) as { block?: boolean }).block)
      .sort();
    expect(blocked).toEqual(registered);
  });

  it('keeps the FIRST refusal, which is the one that describes the host', async () => {
    const capacity = createCapacityLatch();
    const { pi, tools } = fakePi();
    let n = 0;
    const transport: SandboxTransport = {
      exec: async () => {
        throw new SandboxCapacityRefusedError(`memory-budget: refusal ${++n}`);
      },
      close: vi.fn(async () => {}),
    };
    k8sSandboxExtension({ config: cfg, transport, capacity })(pi);
    await runBash(tools);
    await runBash(tools);
    expect(capacity.refusal()?.message).toBe('memory-budget: refusal 1');
  });

  it("is independent per latch: one turn's refusal never fails another turn", async () => {
    // The reason the latch is an object the caller creates rather than module state — a
    // replica serves many turns at once, against different hosts.
    const mine = createCapacityLatch();
    const theirs = createCapacityLatch();
    const { pi: piA, tools: toolsA } = fakePi();
    const { pi: piB } = fakePi();
    k8sSandboxExtension({ config: cfg, transport: refusing(), capacity: theirs })(piA);
    k8sSandboxExtension({ config: cfg, transport: okTransport(), capacity: mine })(piB);
    await runBash(toolsA);
    expect(theirs.refusal()).toBeInstanceOf(SandboxCapacityRefusedError);
    expect(mine.refusal()).toBeUndefined();
  });
});
