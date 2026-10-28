import { describe, expect, it } from 'vitest';
import {
  agentopProblem,
  installMocaSandbox,
  mocaSandboxStatus,
  type AgentopExec,
  type AgentopRun,
} from '../src/sbx/agentop.js';

/** An agentop that answers each command line from `answers`, and records what it was asked. */
export function fakeAgentop(answers: Record<string, Partial<AgentopRun>>) {
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

describe('agentop for Cortex mode', () => {
  it.each([
    ['agentop v0.9.3\n', undefined],
    ['agentop v0.10.0\n', undefined],
    ['agentop v1.0.0-rc.1\n', undefined],
    ['agentop dev\n', undefined],
    ['agentop dev-1a2b3c4\n', undefined],
    // A build from Cortex's main channel (install.sh --ref=main): release-binaries.yaml stamps main-<sha7>.
    ['agentop main-2aa7c81\n', undefined],
    ['agentop v0.9.2\n', 'v0.9.2; Cortex mode needs v0.9.3 or later'],
    ['agentop v0.8.9\n', 'v0.8.9; Cortex mode needs v0.9.3 or later'],
    ['something else\n', 'which is not a version'],
  ])('version %j', async (stdout, problem) => {
    const { exec } = fakeAgentop({ '--version': { stdout } });
    const got = await agentopProblem(exec);
    if (problem === undefined) expect(got).toBeUndefined();
    else expect(got).toContain(problem);
  });

  it('agentop not on PATH', async () => {
    expect(await agentopProblem(fakeAgentop({}).exec)).toContain('not on PATH');
  });

  it('install passes agentop on in both directions', async () => {
    const ok = fakeAgentop({
      'script install moca-sandbox': { stdout: 'Installed moca-sandbox: x.\n' },
    });
    expect(await installMocaSandbox(ok.exec)).toEqual({
      ok: true,
      message: 'Installed moca-sandbox: x.',
    });
    const bad = fakeAgentop({
      'script install moca-sandbox': {
        code: 1,
        stderr: 'agentop script install: python3 not found\n',
      },
    });
    expect(await installMocaSandbox(bad.exec)).toEqual({
      ok: false,
      message: 'agentop script install: python3 not found',
    });
  });

  it('reads moca-sandbox from script list --json, with and without a running Cortex', async () => {
    const list = (row: object) =>
      fakeAgentop({
        'script list --json': { stdout: JSON.stringify({ scripts: [{ name: 'other' }, row] }) },
      });
    const running = await mocaSandboxStatus(
      list({ name: 'moca-sandbox', state: 'installed', scripts: 1, loaded: 1, notStarted: 0 }).exec,
    );
    expect(running).toEqual({
      status: { state: 'installed', scripts: 1, loaded: 1, notStarted: 0 },
    });
    const stopped = await mocaSandboxStatus(
      list({ name: 'moca-sandbox', state: 'installed', scripts: 1 }).exec,
    );
    expect(stopped).toEqual({ status: { state: 'installed', scripts: 1 } });
    expect((await mocaSandboxStatus(list({ name: 'nope' }).exec)).problem).toContain(
      'ships no moca-sandbox',
    );
    const notJson = fakeAgentop({ 'script list --json': { stdout: 'oops' } });
    expect((await mocaSandboxStatus(notJson.exec)).problem).toContain('did not answer JSON');
  });
});
