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
import { findNodeAtLocation, parseTree } from 'jsonc-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The guards in agent-config's edits, driven by a json-edit that misbehaves on demand: an edit that
// parses but does not do what was asked (one that landed in a comment, say) is refused, and
// nothing is written.
const broken = vi.hoisted(() => ({
  append: undefined as ((...a: unknown[]) => string) | undefined,
  remove: undefined as ((...a: unknown[]) => string) | undefined,
}));
vi.mock('../src/sbx/json-edit.js', async (orig) => {
  const real = await orig<typeof import('../src/sbx/json-edit.js')>();
  return {
    ...real,
    append: (...a: Parameters<typeof real.append>) =>
      broken.append ? broken.append(real, ...a) : real.append(...a),
    remove: (...a: Parameters<typeof real.remove>) =>
      broken.remove ? broken.remove(real, ...a) : real.remove(...a),
  };
});

const { ConfigConflict, removeAgentConfig, writeAgentConfig } =
  await import('../src/sbx/agent-config.js');
type Real = typeof import('../src/sbx/json-edit.js');

const made: string[] = [];
afterEach(() => {
  broken.append = undefined;
  broken.remove = undefined;
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const dir = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'sbx-guard-')));
  made.push(d);
  mkdirSync(join(d, '.git'));
  return d;
};
const conflict = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigConflict) return e;
    throw e;
  }
  throw new Error('no ConfigConflict');
};

describe('the edit guards', () => {
  it('refuses an added key that does not land where it was asked, writing nothing', () => {
    const d = dir();
    const body = '{\n  "model": "x"\n}\n';
    writeFileSync(join(d, 'opencode.json'), body);
    // Writes some other key: the document still parses, but the intended member is not in it.
    broken.append = (real, text, path, key, _v, st) =>
      (real as Real).append(
        text as string,
        path as string[],
        key === undefined ? undefined : `${key as string}-misplaced`,
        0,
        st as never,
      );
    expect(conflict(() => writeAgentConfig(d)).message).toMatch(/could not be edited safely/);
    expect(readFileSync(join(d, 'opencode.json'), 'utf8')).toBe(body);
    expect(existsSync(join(d, '.mcp.json'))).toBe(false);
    expect(existsSync(join(d, '.sbx'))).toBe(false);
  });

  it('refuses an item appended to an existing list that does not land last, writing nothing', () => {
    const d = dir();
    mkdirSync(join(d, '.claude'));
    const body = '{\n  "permissions": {\n    "deny": [\n      "Bash"\n    ]\n  }\n}\n';
    writeFileSync(join(d, '.claude/settings.json'), body);
    // Appends a different item into the list (key undefined: the addItems path).
    broken.append = (real, text, path, key, v, st) =>
      (real as Real).append(
        text as string,
        path as string[],
        key as string | undefined,
        key === undefined ? `${String(v)}-misplaced` : v,
        st as never,
      );
    const err = conflict(() => writeAgentConfig(d));
    expect(err.file).toBe('.claude/settings.json');
    expect(err.key).toBe('permissions.deny');
    expect(err.message).toMatch(/could not be edited safely/);
    expect(readFileSync(join(d, '.claude/settings.json'), 'utf8')).toBe(body);
    expect(existsSync(join(d, '.sbx'))).toBe(false);
  });

  // #574: taking back a retired deny is a tidy-up, not a correctness fix, so a guard refusing it
  // leaves the entry and its record alone instead of failing the whole up.
  it('keeps up working when the retired-deny take-back is refused', () => {
    const d = dir();
    mkdirSync(join(d, '.claude'));
    writeFileSync(
      join(d, '.claude/settings.json'),
      '{\n  "permissions": {\n    "deny": []\n  }\n}\n',
    );
    writeAgentConfig(d);
    const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
    s.permissions.deny.push('MultiEdit');
    writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s, null, 2) + '\n');
    const rec = JSON.parse(readFileSync(join(d, '.sbx/agent-config.json'), 'utf8'));
    rec.json.push({
      file: '.claude/settings.json',
      op: 'item',
      path: ['permissions', 'deny'],
      value: 'MultiEdit',
    });
    writeFileSync(join(d, '.sbx/agent-config.json'), JSON.stringify(rec, null, 2) + '\n');
    // Takes the entry out and re-indents a line of theirs: a cut, plus a byte they wrote.
    broken.remove = (real, text, path, o) =>
      (real as Real)
        .remove(text as string, path as never, o as never)
        .replace('\n  "perm', '\n\t"perm');
    expect(() => writeAgentConfig(d)).not.toThrow();
    const after = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
    expect(after.permissions.deny).toContain('MultiEdit');
    expect(readFileSync(join(d, '.claude/settings.json'), 'utf8')).not.toContain('\n\t"perm');
    // The record is kept, so a later run can try again.
    const kept = JSON.parse(readFileSync(join(d, '.sbx/agent-config.json'), 'utf8'));
    expect(kept.json).toContainEqual({
      file: '.claude/settings.json',
      op: 'item',
      path: ['permissions', 'deny'],
      value: 'MultiEdit',
    });
    // And once the edit behaves, the take-back goes through.
    broken.remove = undefined;
    writeAgentConfig(d);
    expect(
      JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8')).permissions.deny,
    ).not.toContain('MultiEdit');
  });

  it('refuses a removal that loses a comment, keeping the file and the record', () => {
    const d = dir();
    const body = '{\n  "model": "x" // mine\n}\n';
    writeFileSync(join(d, 'opencode.json'), body);
    writeAgentConfig(d);
    const up = readFileSync(join(d, 'opencode.json'), 'utf8');
    broken.remove = (real, text, path, o) =>
      (real as Real).remove(text as string, path as never, o as never).replace(' // mine', '');
    const err = conflict(() => removeAgentConfig(d));
    expect(err.file).toBe('opencode.json');
    expect(err.message).toMatch(/needs a manual edit/);
    expect(err.message).toMatch(/comment/);
    expect(readFileSync(join(d, 'opencode.json'), 'utf8')).toBe(up);
    expect(existsSync(join(d, '.sbx/agent-config.json'))).toBe(true);
    expect(existsSync(join(d, '.mcp.json'))).toBe(true); // no file was changed
  });

  it('refuses a removal that takes away anything but what sbx up added', () => {
    const d = dir();
    writeFileSync(join(d, 'opencode.json'), '{\n  "model": "x",\n  "theme": "y"\n}\n');
    writeAgentConfig(d);
    const up = readFileSync(join(d, 'opencode.json'), 'utf8');
    // Removes the developer's "theme" along with the asked-for member.
    broken.remove = (real, text, path, o) => {
      const out = (real as Real).remove(text as string, path as never, o as never);
      return (path as unknown[])[0] === 'mcp' ? (real as Real).remove(out, ['theme']) : out;
    };
    const err = conflict(() => removeAgentConfig(d));
    expect(err.file).toBe('opencode.json');
    expect(err.message).toMatch(/needs a manual edit/);
    expect(readFileSync(join(d, 'opencode.json'), 'utf8')).toBe(up);
    expect(existsSync(join(d, '.sbx/agent-config.json'))).toBe(true);
  });

  // Review round 4 (probe12): removals that keep the parsed value and every comment, but change
  // bytes the developer wrote. Each removal must be a cut, inside the removed member's slot.
  const USER =
    '{\n  "model": "x.0", // the model\n\n  "n": 1.50,\n  "s": "\\u0041",\n' +
    '  "theme": "y", /* t */\n  "z": [1, 2]\n}\n';
  /** The member at `path` wrapped in a block comment: still parses, and loses no comment. */
  const commentOut = (text: string, path: (string | number)[]) => {
    const n = findNodeAtLocation(parseTree(text)!, path)!.parent!;
    const end = n.offset + n.length;
    return `${text.slice(0, n.offset)}/* ${text.slice(n.offset, end)} */${text.slice(end)}`;
  };
  it.each([
    ['re-indents a line of theirs', (o: string) => o.replace('\n  "n"', '\n\t"n"')],
    [
      'moves their block comment',
      (o: string) => o.replace(' /* t */', '').replace('"n": 1.50', '"n": /* t */ 1.50'),
    ],
    ['rewrites 1.50 as 1.5', (o: string) => o.replace('1.50', '1.5')],
    ['rewrites \\u0041 as A', (o: string) => o.replace('\\u0041', 'A')],
    ['rewrites [1, 2] as [1,2]', (o: string) => o.replace('[1, 2]', '[1,2]')],
    ['drops their blank line', (o: string) => o.replace('\n\n', '\n')],
    ['comments the member out instead', undefined],
  ])(
    'refuses a removal that %s, keeping the file and the record',
    (_n, hostile: ((o: string) => string) | undefined) => {
      const d = dir();
      writeFileSync(join(d, 'opencode.json'), USER);
      writeAgentConfig(d);
      const up = readFileSync(join(d, 'opencode.json'), 'utf8');
      // Only in opencode.json (whose paths start mcp or tools); the other files come back.
      broken.remove = (real, text, path, o) => {
        const p = path as (string | number)[];
        if (p[0] !== 'mcp' && p[0] !== 'tools') {
          return (real as Real).remove(text as string, p, o as never);
        }
        return hostile
          ? hostile((real as Real).remove(text as string, p, o as never))
          : commentOut(text as string, p);
      };
      const err = conflict(() => removeAgentConfig(d));
      expect(err.file).toBe('opencode.json');
      expect(err.message).toMatch(/needs a manual edit/);
      expect(readFileSync(join(d, 'opencode.json'), 'utf8')).toBe(up);
      expect(existsSync(join(d, '.sbx/agent-config.json'))).toBe(true);
      expect(existsSync(join(d, '.mcp.json'))).toBe(true); // no file was changed
      // And the real removal takes it all back, byte for byte.
      broken.remove = undefined;
      removeAgentConfig(d);
      expect(readFileSync(join(d, 'opencode.json'), 'utf8')).toBe(USER);
    },
  );
});
