import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAgentConfig } from '../src/sbx/agent-config.js';
import type { AgentopExec, AgentopRun } from '../src/sbx/agentop.js';
import { CORTEX_NOTE } from '../src/sbx/sync.js';
import { cleanupTmp, harness } from './helpers/sbx.js';

afterEach(cleanupTmp);

const json = (r: string, f: string) => JSON.parse(readFileSync(join(r, f), 'utf8'));

/** An agentop answering each command line from `answers`, recording what it was asked. */
function agentop(answers: Record<string, Partial<AgentopRun>>) {
  const calls: string[] = [];
  const exec: AgentopExec = async (args) => {
    const k = args.join(' ');
    calls.push(k);
    const a = answers[k];
    if (!a) return { code: null, stdout: '', stderr: 'agentop is not on PATH' };
    return { code: 0, stdout: '', stderr: '', ...a };
  };
  return { exec, calls };
}

const INSTALLED = {
  '--version': { stdout: 'agentop v0.9.3\n' },
  'script install moca-sandbox': { stdout: 'Installed moca-sandbox: x.\n' },
  'script list --json': {
    stdout: JSON.stringify({
      scripts: [{ name: 'moca-sandbox', state: 'installed', scripts: 1, loaded: 1, notStarted: 0 }],
    }),
  },
};

describe('mocactl sbx up --cortex', () => {
  it('installs moca-sandbox, then writes the configuration without the local-tool denies', async () => {
    const a = agentop(INSTALLED);
    const h = harness({ agentop: a.exec });
    expect(await h.run(['up', '--cortex'])).toBe(0);
    expect(a.calls).toEqual(['--version', 'script install moca-sandbox']);
    const s = json(h.r, '.claude/settings.json');
    expect(s.permissions.deny).toBeUndefined();
    expect(s.permissions.allow).toEqual(['mcp__sandbox__*']);
    expect(json(h.r, '.sbx/agent-config.json').cortex).toBe(true);
    expect(checkAgentConfig(h.r)).toEqual([]);
    expect(h.err()).toContain('Installed moca-sandbox');
    expect(h.err()).toContain(CORTEX_NOTE);
  });

  it.each([
    ['agentop not on PATH', {}, 'not on PATH'],
    [
      'too old',
      { '--version': { stdout: 'agentop v0.9.2\n' } },
      'v0.9.2; Cortex mode needs v0.9.3',
    ],
  ])('%s: stops before anything is created, bound or pushed', async (_, answers, said) => {
    const h = harness({ agentop: agentop(answers).exec });
    expect(await h.run(['up', '--cortex'])).toBe(1);
    expect(h.err()).toContain(said);
    expect(h.err()).toContain('install.sh | sh');
    expect(h.cp.posts()).toHaveLength(0);
    expect(existsSync(join(h.r, '.sbx'))).toBe(false);
  });

  // The install changes the shared Cortex (~/.cortex), so a conflict must stop up before it runs.
  it('a conflict in the agent configuration stops up before Cortex is touched', async () => {
    const a = agentop(INSTALLED);
    const h = harness({ agentop: a.exec });
    mkdirSync(join(h.r, '.claude'), { recursive: true });
    writeFileSync(
      join(h.r, '.claude/settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash'] } }),
    );
    expect(await h.run(['up', '--cortex'])).toBe(1);
    expect(h.err()).toContain('sbx: .claude/settings.json: permissions.allow');
    expect(a.calls).not.toContain('script install moca-sandbox');
    expect(h.cp.posts()).toHaveLength(0);
  });

  it("a failed install stops up before anything is created, with agentop's own words", async () => {
    const a = agentop({
      '--version': { stdout: 'agentop v0.9.3\n' },
      'script install moca-sandbox': {
        code: 1,
        stderr: 'agentop script install: python3 not found\n',
      },
    });
    const h = harness({ agentop: a.exec });
    expect(await h.run(['up', '--cortex'])).toBe(1);
    expect(h.err()).toContain(
      'Cortex could not install moca-sandbox: agentop script install: python3 not found',
    );
    expect(h.cp.posts()).toHaveLength(0);
    expect(existsSync(join(h.r, '.claude'))).toBe(false);
  });

  it('a development build of agentop is accepted', async () => {
    const h = harness({
      agentop: agentop({ ...INSTALLED, '--version': { stdout: 'agentop dev\n' } }).exec,
    });
    expect(await h.run(['up', '--cortex'])).toBe(0);
  });

  it('a later plain up keeps Cortex mode: it checks Cortex again and adds no denies', async () => {
    const a = agentop(INSTALLED);
    const h = harness({ agentop: a.exec });
    expect(await h.run(['up', '--cortex'])).toBe(0);
    a.calls.length = 0;
    expect(await h.run(['up'])).toBe(0);
    expect(a.calls).toEqual(['--version', 'script install moca-sandbox']);
    expect(json(h.r, '.claude/settings.json').permissions.deny).toBeUndefined();
  });

  it('switching an existing repository to Cortex mode takes back the denies up added', async () => {
    const a = agentop(INSTALLED);
    const h = harness({ agentop: a.exec });
    expect(await h.run(['up'])).toBe(0);
    expect(json(h.r, '.claude/settings.json').permissions.deny.length).toBeGreaterThan(0);
    expect(a.calls).toEqual([]); // plain up never asks agentop
    expect(await h.run(['up', '--cortex'])).toBe(0);
    expect(json(h.r, '.claude/settings.json').permissions.deny).toBeUndefined();
  });

  it('rm takes the configuration back and leaves Cortex alone', async () => {
    const a = agentop(INSTALLED);
    const h = harness({ agentop: a.exec });
    expect(await h.run(['up', '--cortex'])).toBe(0);
    a.calls.length = 0;
    expect(await h.run(['rm'])).toBe(0);
    expect(existsSync(join(h.r, '.claude/settings.json'))).toBe(false);
    expect(existsSync(join(h.r, '.sbx'))).toBe(false);
    expect(a.calls.filter((c) => c.startsWith('script remove'))).toEqual([]);
  });

  it('--cortex with --no-agent-config is a usage error', async () => {
    const h = harness({ agentop: agentop(INSTALLED).exec });
    expect(await h.run(['up', '--cortex', '--no-agent-config'])).toBe(2);
    expect(h.cp.posts()).toHaveLength(0);
  });

  it('--cortex belongs to up only', async () => {
    const h = harness({ agentop: agentop(INSTALLED).exec });
    expect(await h.run(['push', '--cortex'])).toBe(2);
    expect(h.err()).toContain('--cortex only applies to up');
  });
});
