import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxSeedError, SEED_MARKER, seedWorkspace } from '../src/run-turn.js';

/**
 * The template seed (session-templates spec §5), run through a fake transport that executes the
 * command under a real bash with /workspace mapped to a scratch directory, so the quoting and the
 * marker are tested as the guest would run them.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function bashTransport() {
  const ws = mkdtempSync(join(tmpdir(), 'seed-ws-'));
  dirs.push(ws);
  const commands: string[] = [];
  return {
    ws,
    commands,
    exec: async (command: string) => {
      commands.push(command);
      try {
        execFileSync('bash', ['-c', command.replaceAll('/workspace', ws)], { stdio: 'pipe' });
        return { exitCode: 0 };
      } catch (e) {
        return { exitCode: (e as { status: number }).status };
      }
    },
  };
}

describe('seedWorkspace', () => {
  it('runs the seed, then leaves the marker', async () => {
    const t = bashTransport();
    await seedWorkspace(t, 'py312', 'echo seeded > /workspace/file');
    expect(readFileSync(join(t.ws, 'file'), 'utf8')).toBe('seeded\n');
    expect(existsSync(join(t.ws, '.moca-seeded'))).toBe(true);
    expect(SEED_MARKER).toBe('/workspace/.moca-seeded');
  });

  it('runs once: a second turn finds the marker and runs nothing', async () => {
    const t = bashTransport();
    await seedWorkspace(t, 'py312', 'echo x >> /workspace/count');
    await seedWorkspace(t, 'py312', 'echo x >> /workspace/count');
    expect(readFileSync(join(t.ws, 'count'), 'utf8')).toBe('x\n');
  });

  it('quotes the seed for bash: quotes and $ arrive as written', async () => {
    const t = bashTransport();
    await seedWorkspace(t, 'py312', `printf '%s\\n' "it's" '$HOME' > /workspace/q`);
    expect(readFileSync(join(t.ws, 'q'), 'utf8')).toBe("it's\n$HOME\n");
  });

  it('a failed seed throws SandboxSeedError naming the template, and leaves no marker', async () => {
    const t = bashTransport();
    const err = await seedWorkspace(t, 'django-django-11133', 'exit 3').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxSeedError);
    expect((err as Error).message).toContain("'django-django-11133'");
    expect((err as Error).message).toContain('exit 3');
    expect(existsSync(join(t.ws, '.moca-seeded'))).toBe(false);
  });

  it('a truncated or signalled seed (null exit) also fails', async () => {
    const err = await seedWorkspace(
      { exec: async () => ({ exitCode: null }) },
      'py312',
      'true',
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxSeedError);
  });
});

describe('acquireTurnSandbox seeds a templated session (session-templates spec §5)', () => {
  // A records-path selection with one templated worker, through acquireTurnSandbox's real
  // selectPoolSandbox call, with every store faked.
  async function acquire(template: { id: string; seed?: string }, exitCode = 0) {
    const { acquireTurnSandbox } = await import('../src/run-turn.js');
    const commands: string[] = [];
    const released: string[] = [];
    const lease = {
      load: async () => 0,
      acquire: async () => true,
      heartbeat: async () => {},
      release: async (p: string) => void released.push(p),
    };
    const rec = {
      sandboxId: 'py-1',
      labels: { 'moca.dev/template': template.id },
      capabilities: [],
      capacityMax: 4,
      transport: 'grpc' as const,
    };
    const transport = {
      exec: async (c: string) => {
        commands.push(c);
        return { stdout: Buffer.alloc(0), exitCode, truncated: false };
      },
      close: async () => {},
      fastTier: 'per-call-exec' as const,
    };
    const env = {
      KAGENTI_SANDBOX_POOL_SELECTOR: 'app=sbx',
      SH_SANDBOX_DISCOVERY: 'records',
      SH_REMOTE_SANDBOX: '1',
    } as NodeJS.ProcessEnv;
    const deps = {
      records: { put: async () => {}, remove: async () => {}, list: async () => [rec] },
      lease,
      makeExecClient: () => ({}) as never,
      makeTransport: () => transport,
      affinity: {
        get: async () => null,
        claim: async (_s: string, e: { sandboxId: string; tier: string }) => e,
        replace: async () => {},
        detachedSince: async (_id: string, now: number) => now,
      },
    };
    const got = acquireTurnSandbox(undefined, env, '/h', 's-1', deps, undefined, template);
    return { got, commands, released };
  }

  it('runs the seed in the selected sandbox before the turn', async () => {
    const r = await acquire({ id: 'py312', seed: 'echo hi' });
    const got = await r.got;
    expect(got.placement?.sandboxId).toBe('py-1');
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0]).toContain('.moca-seeded');
    expect(r.commands[0]).toContain("bash -c 'echo hi'");
  });

  it('a template without a seed runs nothing', async () => {
    const r = await acquire({ id: 'py312' });
    await r.got;
    expect(r.commands).toHaveLength(0);
  });

  it('a failed seed fails the turn and returns the lease', async () => {
    const r = await acquire({ id: 'py312', seed: 'false' }, 1);
    await expect(r.got).rejects.toBeInstanceOf(SandboxSeedError);
    expect(r.released).toEqual(['py-1']);
  });
});
