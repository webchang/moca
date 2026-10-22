import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = new URL('../src/', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function filesUnder(dir: string): string[] {
  if (!existsSync(join(src, dir))) return [];
  return readdirSync(join(src, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? filesUnder(join(dir, d.name)) : [join(dir, d.name)],
  );
}

describe('layering (spec §3.1)', () => {
  it.each(['api', 'core'])('%s/ never imports the UI', (dir) => {
    for (const file of filesUnder(dir)) {
      const text = readFileSync(join(src, file), 'utf8');
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
      for (const i of imports) {
        expect(i, `${file} imports ${i}`).not.toMatch(
          /^(ink|react)(\/|$)|\/(views|render|theme|commands)\//,
        );
      }
    }
  });

  // ADR-0038 and ADR-0042: exactly two exceptions to ADR-0036's rule -- @moca/config-bundle (bundle
  // building) and @moca/sandbox-client (SBX0's exec client, tools and MCP server). Neither carries
  // Pi, server internals or substrate assumptions. A third one must fail here.
  const ALLOWED_WORKSPACE_DEPS = new Set(['@moca/config-bundle', '@moca/sandbox-client']);

  it('declares no workspace dependency beyond the ADR-0038/ADR-0042 allow-list', () => {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, range] of Object.entries(all)) {
      if (ALLOWED_WORKSPACE_DEPS.has(name)) continue;
      expect(String(range), name).not.toMatch(/^workspace:/);
      expect(name).not.toMatch(/^@moca\//);
    }
  });

  it('keeps @moca/sandbox-client free of Pi and server packages at runtime (ADR-0042)', () => {
    const sc = JSON.parse(
      readFileSync(new URL('../../sandbox-client/package.json', import.meta.url), 'utf8'),
    );
    expect(Object.keys(sc.dependencies).sort()).toEqual([
      '@bufbuild/protobuf',
      '@grpc/grpc-js',
      '@modelcontextprotocol/sdk',
    ]);
  });

  it('keeps Pi out of @moca/sandbox-client/src: no @earendil-works import (ADR-0042)', () => {
    const scSrc = new URL('../../sandbox-client/src/', import.meta.url).pathname;
    const walk = (dir: string): string[] =>
      readdirSync(join(scSrc, dir), { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)],
      );
    const files = walk('.').filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const text = readFileSync(join(scSrc, f), 'utf8');
      const imports = [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
        (m) => m[1],
      );
      for (const i of imports) expect(i, `${f} imports ${i}`).not.toMatch(/^@earendil-works\//);
    }
  });

  it('depends on @moca/sandbox-client (ADR-0042)', () => {
    expect(pkg.dependencies['@moca/sandbox-client']).toBe('workspace:*');
  });
});
