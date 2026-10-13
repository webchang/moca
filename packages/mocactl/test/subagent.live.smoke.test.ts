import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * End-to-end smoke: spawn two subagents (one prompt + bundle, one solve + repo),
 * verify `subagents` reports both terminal and `get` returns their results.
 *
 * Needs: a reachable control plane + harness, a prior `mocactl login`. Opt-in with
 * MOCACTL_LIVE_SMOKE=1, same as the other live smokes.
 *
 * Writes to `$XDG_STATE_HOME/mocactl/subagents.jsonl` on this machine (same file
 * `mocactl subagents` reads). The test uses a unique --tag so a parallel smoke
 * run (or a developer's own spawns) does not confuse the assertions.
 */
const live = process.env.MOCACTL_LIVE_SMOKE === '1';
const bin = new URL('../bin/mocactl.mjs', import.meta.url).pathname;
const run = (args: string[], timeout: number) =>
  spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: process.env, timeout });

describe.skipIf(!live)('mocactl subagent live smoke (MOCACTL_LIVE_SMOKE=1)', () => {
  it('spawn → subagents → get round-trips two subagents under a unique tag', async () => {
    const tag = `smoke-${Date.now()}`;
    // Promote a tiny bundle so the prompt subagent gets a configRef, exercising the full
    // session-bound-bundle path (not just an unconfigured prompt turn).
    const fixture = new URL('./fixtures/promote-skills', import.meta.url).pathname;
    const p = run(['promote', fixture, '--json'], 60_000);
    expect(p.status, p.stderr).toBe(0);
    const { digest } = JSON.parse(p.stdout) as { digest: string };

    // Subagent A: prompt + bundle. Prints a brief acknowledgement.
    const spawnA = run(
      [
        'spawn',
        'Reply with the single word: ack',
        '--kind',
        'prompt',
        '--config',
        digest,
        '--tag',
        tag,
        '--json',
      ],
      30_000,
    );
    expect(spawnA.status, spawnA.stderr).toBe(0);
    const a = JSON.parse(spawnA.stdout) as { sessionId: string; pid: number };

    // Subagent B: solve against a tiny public repo. The sync /v1/runs call returns a patch body.
    const spawnB = run(
      [
        'spawn',
        'Add a one-line README note that says "smoke-test".',
        '--kind',
        'solve',
        '--config',
        digest,
        '--repo',
        'https://github.com/octocat/Hello-World.git',
        '--ref',
        'master',
        '--tag',
        tag,
        '--json',
      ],
      30_000,
    );
    expect(spawnB.status, spawnB.stderr).toBe(0);
    const b = JSON.parse(spawnB.stdout) as { sessionId: string; pid: number };

    // Poll `mocactl subagents --tag <tag>` until both are terminal (done | failed | unknown).
    // Each spawn has its own 10-minute budget on the harness side; 3 minutes here is a client
    // bound, not a server one.
    const deadline = Date.now() + 180_000;
    let final: { subagents: Array<{ sessionId: string; state: string }> } = { subagents: [] };
    while (Date.now() < deadline) {
      const r = run(['subagents', '--tag', tag, '--json'], 15_000);
      expect(r.status, r.stderr).toBe(0);
      final = JSON.parse(r.stdout);
      if (final.subagents.length === 2 && final.subagents.every((s) => s.state !== 'running'))
        break;
      await new Promise((res) => setTimeout(res, 2000));
    }
    expect(final.subagents.map((s) => s.sessionId).sort()).toEqual(
      [a.sessionId, b.sessionId].sort(),
    );
    // A smoke that passes with `failed` can't catch regressions in the dispatch path (bundle
    // not applied, worker loses endpoints, …). At least one row must land in a happy terminal.
    const happy = final.subagents.filter((s) => s.state === 'done' || s.state === 'paused');
    expect(happy.length).toBeGreaterThan(0);

    for (const s of final.subagents) {
      const g = run(
        ['get', s.sessionId, '--out', `/tmp/mocactl-smoke-${s.sessionId}`, '--json'],
        30_000,
      );
      // Exit 0 for done, exit 1 for failed; both are terminal and both must emit a JSON line.
      expect([0, 1]).toContain(g.status);
      const parsed = JSON.parse(g.stdout) as { sessionId: string; status: string };
      expect(parsed.sessionId).toBe(s.sessionId);
    }
  }, 300_000);
});
