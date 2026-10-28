import { afterEach, describe, expect, it } from 'vitest';
import type { AgentopExec, AgentopRun } from '../src/sbx/agentop.js';
import { cleanupTmp, harness } from './helpers/sbx.js';

afterEach(cleanupTmp);

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

describe('mocactl sbx doctor in Cortex mode', () => {
  const list = (row: object) => ({
    ...INSTALLED,
    'script list --json': {
      stdout: JSON.stringify({ scripts: [{ name: 'moca-sandbox', ...row }] }),
    },
  });

  it.each([
    [
      'installed and loaded',
      { state: 'installed', scripts: 1, loaded: 1, notStarted: 0 },
      'ok - cortex:',
      '',
    ],
    [
      'not installed',
      { state: 'not installed', scripts: 1 },
      'FAIL - cortex: moca-sandbox is not installed',
      'agentop script install moca-sandbox',
    ],
    [
      'Cortex not running',
      { state: 'installed', scripts: 1 },
      'FAIL - cortex: Cortex is not running',
      'agentop service start',
    ],
    [
      'script did not start',
      { state: 'installed', scripts: 1, loaded: 0, notStarted: 1 },
      'FAIL - cortex: moca-sandbox did not start',
      "Cortex's log",
    ],
  ])('%s', async (_, row, line, fix) => {
    let answers: Record<string, Partial<AgentopRun>> = INSTALLED;
    const exec: AgentopExec = (args, t) => agentop(answers).exec(args, t);
    const h = harness({ agentop: exec });
    expect(await h.run(['up', '--cortex'])).toBe(0);
    answers = list(row);
    await h.run(['doctor']);
    const out = h.io.outs.join('');
    expect(out).toContain(line);
    if (fix) expect(out).toContain(fix);
    expect(out).not.toContain('not denied');
    // The agent-config line must not claim denies that Cortex mode does not write.
    expect(out).not.toContain('every local tool denied');
    expect(out).toContain('local tools left to Cortex');
  });

  it('outside Cortex mode, doctor asks agentop nothing', async () => {
    const a = agentop(INSTALLED);
    const h = harness({ agentop: a.exec });
    expect(await h.run(['up'])).toBe(0);
    await h.run(['doctor']);
    expect(a.calls).toEqual([]);
    expect(h.io.outs.join('')).not.toContain('cortex:');
  });
});
