import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_ALLOW,
  CLAUDE_DENY,
  checkAgentConfig,
  cortexMode,
  takeBackAgentConfig,
  writeAgentConfig,
} from '../src/sbx/agent-config.js';

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-cortex-')));
  made.push(d);
  mkdirSync(join(d, '.git'));
  return d;
};
const json = (d: string, f: string) => JSON.parse(readFileSync(join(d, f), 'utf8'));
const record = (d: string) => json(d, '.sbx/agent-config.json');

describe('agent configuration in Cortex mode (sbx up --cortex)', () => {
  it('writes everything but the local-tool denies, and records the mode', () => {
    const d = dir();
    writeAgentConfig(d, { cortex: true });
    const s = json(d, '.claude/settings.json');
    expect(s.permissions.allow).toEqual([CLAUDE_ALLOW]);
    expect(s.permissions.deny).toBeUndefined();
    expect(s.enabledMcpjsonServers).toEqual(['sandbox']);
    expect(json(d, '.mcp.json').mcpServers.sandbox).toEqual({
      command: 'mocactl',
      args: ['sbx', 'mcp'],
    });
    expect(json(d, 'opencode.json').tools.bash).toBe(false);
    expect(readFileSync(join(d, 'CLAUDE.md'), 'utf8')).toContain('<!-- sbx:begin -->');
    expect(record(d).cortex).toBe(true);
    expect(cortexMode(d)).toBe(true);
    expect(checkAgentConfig(d)).toEqual([]);
  });

  it('a later plain up keeps the mode and adds no denies', () => {
    const d = dir();
    writeAgentConfig(d, { cortex: true });
    writeAgentConfig(d);
    expect(json(d, '.claude/settings.json').permissions.deny).toBeUndefined();
    expect(record(d).cortex).toBe(true);
  });

  it('takes back the denies an earlier plain up added, and keeps one the developer wrote', () => {
    const d = dir();
    mkdirSync(join(d, '.claude'));
    writeFileSync(
      join(d, '.claude/settings.json'),
      JSON.stringify({ permissions: { deny: ['Bash(rm -rf *)'] } }),
    );
    writeAgentConfig(d);
    expect(json(d, '.claude/settings.json').permissions.deny).toEqual([
      'Bash(rm -rf *)',
      ...CLAUDE_DENY,
    ]);
    writeAgentConfig(d, { cortex: true });
    expect(json(d, '.claude/settings.json').permissions.deny).toEqual(['Bash(rm -rf *)']);
    expect(record(d).cortex).toBe(true);
    expect(
      record(d).json.some((r: { path: string[] }) => r.path.join('.') === 'permissions.deny'),
    ).toBe(false);
  });

  it('records the mode even when the files already hold everything', () => {
    const d = dir();
    writeAgentConfig(d, { cortex: true });
    rmSync(join(d, '.sbx'), { recursive: true });
    const before = readFileSync(join(d, '.claude/settings.json'), 'utf8');
    writeAgentConfig(d, { cortex: true });
    expect(record(d).cortex).toBe(true);
    expect(readFileSync(join(d, '.claude/settings.json'), 'utf8')).toBe(before);
  });

  it('a dry run writes nothing, the record included', () => {
    const d = dir();
    const r = writeAgentConfig(d, { dryRun: true, cortex: true });
    expect(r.changed.length).toBeGreaterThan(0);
    expect(existsSync(join(d, '.sbx'))).toBe(false);
  });

  it('rm takes everything back', () => {
    const d = dir();
    writeAgentConfig(d, { cortex: true });
    takeBackAgentConfig(d);
    expect(existsSync(join(d, '.claude/settings.json'))).toBe(false);
    expect(existsSync(join(d, '.mcp.json'))).toBe(false);
    expect(existsSync(join(d, '.sbx/agent-config.json'))).toBe(false);
  });

  it('outside Cortex mode, missing denies are still a problem', () => {
    const d = dir();
    writeAgentConfig(d);
    const p = join(d, '.claude/settings.json');
    const s = json(d, '.claude/settings.json');
    s.permissions.deny = s.permissions.deny.filter((t: string) => t !== 'Read');
    writeFileSync(p, JSON.stringify(s));
    expect(cortexMode(d)).toBe(false);
    expect(checkAgentConfig(d).join('\n')).toContain('not denied');
  });

  it('a record with a malformed cortex value is refused, not read as Cortex mode', () => {
    const d = dir();
    writeAgentConfig(d, { cortex: true });
    const r = record(d);
    r.cortex = 'yes';
    writeFileSync(join(d, '.sbx/agent-config.json'), JSON.stringify(r));
    expect(cortexMode(d)).toBe(false);
    expect(() => writeAgentConfig(d)).toThrow(/malformed cortex/);
  });
});
