import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SEED_REVISION_DIR,
  SEED_REVISION_SCRIPT,
  SEED_WORKSPACE_DIR,
  SEED_WORKSPACE_SCRIPT,
} from '../src/seed.js';

// The two init containers' scripts, run for real in bash against a directory standing in for the
// claim (spec §5.3). Each script sees only its own mounts, rewritten to paths under the claim; the
// bundle comes from a local HTTP server standing in for the seed port.

const REV = 'f'.repeat(64);
let claim: string;
let bundle: Buffer;
let fetches = 0;
let server: http.Server;
let url: string;

beforeEach(async () => {
  claim = mkdtempSync(join(tmpdir(), 'moca-seed-'));
  mkdirSync(join(claim, 'revision'));
  mkdirSync(join(claim, 'moca-workspace'));
  const src = join(claim, '..', `${claim.split('/').pop()}-src`);
  mkdirSync(join(src, 'workspace', 'src'), { recursive: true });
  writeFileSync(join(src, 'workspace', 'README.txt'), 'hello\n');
  writeFileSync(join(src, 'workspace', 'test.sh'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
  writeFileSync(join(src, 'workspace', 'src', 'a.py'), 'print(1)\n');
  bundle = execFileSync('tar', ['-czf', '-', '-C', src, 'workspace']);
  rmSync(src, { recursive: true, force: true });
  writeFileSync(join(claim, 'token'), 'attach-token');
  fetches = 0;
  server = http.createServer((req, res) => {
    fetches++;
    if (req.headers.authorization !== 'Bearer attach-token') return res.writeHead(401).end();
    res.writeHead(200).end(bundle);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/seed/v1/bundle`;
});
const children: ReturnType<typeof spawn>[] = [];
afterEach(async () => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  execFileSync('chmod', ['-R', 'u+w', claim]);
  rmSync(claim, { recursive: true, force: true });
});

/** Run one init container's script with its mounts at their paths under the claim. */
function run(
  which: 'revision' | 'workspace',
  opts: { pod?: string; rev?: string | null } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const script = (which === 'revision' ? SEED_REVISION_SCRIPT : SEED_WORKSPACE_SCRIPT)
    .replaceAll(
      SEED_REVISION_DIR,
      which === 'revision' ? join(claim, 'revision') : join(claim, 'revision', REV),
    )
    .replaceAll(SEED_WORKSPACE_DIR, join(claim, 'moca-workspace'));
  const rev = opts.rev === undefined ? REV : opts.rev;
  // Async: the seed port stand-in runs in this process, so a blocking spawn would deadlock it.
  const child = spawn('bash', ['-c', script.replace('--max-time 600', '--max-time 10')], {
    env: {
      PATH: process.env.PATH,
      ...(rev !== null ? { SEED_REVISION: rev } : {}),
      POD_NAME: opts.pod ?? 'w-0123-0',
      SANDBOX_TOKEN_FILE: join(claim, 'token'),
      SEED_URL: url,
      MAX_ENTRIES: '100',
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d));
  child.stderr.on('data', (d: Buffer) => (stderr += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  return new Promise((resolve) =>
    child.on('exit', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    }),
  );
}

const revDir = () => join(claim, 'revision', REV);
const ws = (...p: string[]) => join(claim, 'moca-workspace', ...p);

describe('the revision seed (first init container)', () => {
  it('pod 0 extracts the bundle into revision/<rev>, read-only, exec bits kept, no temp dir left', async () => {
    const r = await run('revision');
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(revDir(), 'workspace', 'README.txt'), 'utf8')).toBe('hello\n');
    const mode = lstatSync(join(revDir(), 'workspace', 'test.sh')).mode & 0o777;
    expect(mode & 0o222).toBe(0);
    expect(mode & 0o100).toBe(0o100);
    expect(execFileSync('ls', ['-A', join(claim, 'revision')], { encoding: 'utf8' }).trim()).toBe(
      REV,
    );
  });

  it('does nothing without the seed annotation, and nothing again once seeded', async () => {
    expect((await run('revision', { rev: null })).status).toBe(0);
    expect(existsSync(revDir())).toBe(false);
    expect(fetches).toBe(0);
    expect((await run('revision')).status).toBe(0);
    expect((await run('revision')).stdout).toContain('already seeded');
    expect(fetches).toBe(1);
  });

  it('another pod never writes: it waits until pod 0 has seeded, then exits 0', async () => {
    const waiter = new Promise<number | null>((resolve) => {
      const script = SEED_REVISION_SCRIPT.replaceAll(SEED_REVISION_DIR, join(claim, 'revision'));
      execFileAsync(script, 'w-0123-1').on('exit', (code) => resolve(code));
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(revDir())).toBe(false);
    expect(fetches).toBe(0);
    expect((await run('revision')).status).toBe(0);
    expect(await waiter).toBe(0);
    expect(fetches).toBe(1);
  });

  it('removes its own leftover temp dir from a crash, and refuses anything else in revision/', async () => {
    mkdirSync(join(claim, 'revision', '.seed-abc123', 'half'), { recursive: true });
    expect((await run('revision')).status).toBe(0);
    expect(existsSync(join(claim, 'revision', '.seed-abc123'))).toBe(false);
    execFileSync('chmod', ['-R', 'u+w', claim]);
    rmSync(revDir(), { recursive: true });
    writeFileSync(join(claim, 'revision', 'planted'), 'x');
    const r = await run('revision');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('refusing');
    expect(existsSync(revDir())).toBe(false);
  });

  it('fails, seeding nothing, when the bundle is missing (a provisioner restart)', async () => {
    server.removeAllListeners('request');
    server.on('request', (_req, res) => res.writeHead(404).end('{"error":"seed_bundle_missing"}'));
    const r = await run('revision');
    expect(r.status).not.toBe(0);
    expect(execFileSync('ls', ['-A', join(claim, 'revision')], { encoding: 'utf8' })).toBe('');
  });
});

describe('the workspace seed (second init container, writable mounts)', () => {
  beforeEach(async () => {
    expect((await run('revision')).status).toBe(0);
  });

  it('copies the revision into moca-workspace, writable, leaving the revision as it was', async () => {
    const r = await run('workspace');
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(ws('workspace', 'README.txt'), 'utf8')).toBe('hello\n');
    writeFileSync(ws('workspace', 'README.txt'), 'changed\n');
    expect(readFileSync(join(revDir(), 'workspace', 'README.txt'), 'utf8')).toBe('hello\n');
    expect(execFileSync('ls', ['-A', ws()], { encoding: 'utf8' }).trim()).toBe('workspace');
  });

  it('never re-seeds over model code: deleted contents and planted symlinks stay, the revision is untouched', async () => {
    expect((await run('workspace')).status).toBe(0);
    execFileSync('rm', ['-rf', ws('workspace')]);
    symlinkSync(join('..', 'revision', REV, 'workspace'), ws('a'));
    const r = await run('workspace');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('not empty');
    expect(readlinkSync(ws('a'))).toBe(join('..', 'revision', REV, 'workspace'));
    expect(readFileSync(join(revDir(), 'workspace', 'README.txt'), 'utf8')).toBe('hello\n');
    expect(lstatSync(join(revDir(), 'workspace', 'README.txt')).mode & 0o222).toBe(0);
  });

  it('finishes a seed a crash interrupted after the copy, instead of starting over', async () => {
    mkdirSync(ws('.moca-seed-ready', 'workspace'), { recursive: true });
    writeFileSync(ws('.moca-seed-ready', 'workspace', 'only.txt'), 'from the copy\n');
    mkdirSync(ws('elsewhere'));
    const r = await run('workspace');
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(ws('workspace', 'only.txt'), 'utf8')).toBe('from the copy\n');
    expect(existsSync(ws('.moca-seed-ready'))).toBe(false);
  });

  it('another pod waits for pod 0 and writes nothing', async () => {
    const script = SEED_WORKSPACE_SCRIPT.replaceAll(SEED_REVISION_DIR, revDir()).replaceAll(
      SEED_WORKSPACE_DIR,
      ws(),
    );
    const done = new Promise<number | null>((resolve) =>
      execFileAsync(script, 'w-0123-1').on('exit', (code) => resolve(code)),
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(execFileSync('ls', ['-A', ws()], { encoding: 'utf8' })).toBe('');
    expect((await run('workspace')).status).toBe(0);
    expect(await done).toBe(0);
  });
});

/** One init container's script in the background, as pod `pod`. */
function execFileAsync(script: string, pod: string) {
  const child = spawn('bash', ['-c', script], {
    env: {
      PATH: process.env.PATH,
      SEED_REVISION: REV,
      POD_NAME: pod,
      SANDBOX_TOKEN_FILE: join(claim, 'token'),
      SEED_URL: url,
      MAX_ENTRIES: '100',
    },
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}
