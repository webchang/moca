import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  KNATIVE_DEPRECATION_NOTICE,
  runningUnderKnative,
  warnKnativeDeprecation,
} from '../src/deprecation.js';

describe('runningUnderKnative (ADR-0041)', () => {
  it('detects each env var Knative Serving injects, singly', () => {
    expect(runningUnderKnative({ K_SERVICE: 'moca' })).toBe(true);
    expect(runningUnderKnative({ K_CONFIGURATION: 'moca' })).toBe(true);
    expect(runningUnderKnative({ K_REVISION: 'moca-00001' })).toBe(true);
  });

  it('stays silent off the Knative path — the P6 supervisor forks worker.ts without Knative env', () => {
    expect(runningUnderKnative({})).toBe(false);
    expect(
      runningUnderKnative({ HOSTNAME: 'worker-1', PORT: '8080', REDIS_URL: 'redis://redis:6379' }),
    ).toBe(false);
  });
});

describe('warnKnativeDeprecation (ADR-0041)', () => {
  it('prints the canonical notice once, under Knative', () => {
    const warn = vi.fn();
    expect(warnKnativeDeprecation({ K_SERVICE: 'moca' }, warn)).toBe(KNATIVE_DEPRECATION_NOTICE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(KNATIVE_DEPRECATION_NOTICE);
  });

  it('prints nothing off the Knative path', () => {
    const warn = vi.fn();
    expect(warnKnativeDeprecation({}, warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('KNATIVE_DEPRECATION_NOTICE carries the ADR-0041 policy verbatim', () => {
  it('names the ADR, the removal floor and the migration guide', () => {
    expect(KNATIVE_DEPRECATION_NOTICE).toContain('ADR-0041');
    expect(KNATIVE_DEPRECATION_NOTICE).toContain('end of October 2026');
    expect(KNATIVE_DEPRECATION_NOTICE).toContain('docs/migrating-from-knative.md');
  });
});

describe('server.ts wiring (ADR-0041)', () => {
  const serverSrc = readFileSync(
    fileURLToPath(new URL('../src/server.ts', import.meta.url)),
    'utf8',
  );
  const workerSrc = readFileSync(
    fileURLToPath(new URL('../src/worker.ts', import.meta.url)),
    'utf8',
  );

  it('startServer warns under Knative, before the shared boot call', () => {
    // Anchored to start-of-line, as worker-boot.test.ts does for prepareServerProcess: server.ts
    // must not be able to satisfy this with a comment that names the call.
    const warn = /^\s*warnKnativeDeprecation\(process\.env\);/m.exec(serverSrc);
    const boot = serverSrc.indexOf('prepareServerProcess(process.env)');
    expect(warn).not.toBeNull();
    expect(boot).toBeGreaterThan(-1);
    expect(warn!.index).toBeLessThan(boot);
  });

  it('the P6 worker never imports the warning — supervisor-forked workers stay silent', () => {
    expect(workerSrc).not.toMatch(/deprecation\.js/);
  });
});

describe('the KEDA drainer warns at boot (ADR-0041)', () => {
  const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
  const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
  const leafJobPath = fileURLToPath(new URL('../src/leaf-job.ts', import.meta.url));

  it('prints the notice even when boot is refused, before it dials Redis', () => {
    // The tenancy refusal is the deterministic fast-exit path: status 1, no Redis dialed. The
    // notice must already be on stderr when it happens — KEDA pods are short-lived and their
    // logs are the only channel a deprecated-path operator reads.
    const r = spawnSync(TSX, [leafJobPath], {
      cwd: PKG_DIR,
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MOCA_TENANCY: 'multi',
        // Nothing listens here: reaching the queue would be a connection error, not this refusal.
        REDIS_URL: 'redis://127.0.0.1:1',
      },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(KNATIVE_DEPRECATION_NOTICE);
    expect(r.stderr).toMatch(/MOCA_TENANCY=multi requires SH_REQUIRE_AUTH=true/);
  }, 30_000);
});

describe('the CronJob on-ramp warns at boot (ADR-0041)', () => {
  const PKG_DIR = fileURLToPath(new URL('..', import.meta.url));
  const TSX = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
  const cronDispatchPath = fileURLToPath(new URL('../src/cron-dispatch.ts', import.meta.url));

  it('prints the notice even when dispatch dies on a missing config, before the crash line', () => {
    // The missing-config crash is the deterministic fast-exit path: status 1, no Redis dialed, no
    // HTTP attempted. The CronJob pod restarts on every schedule — it is the most frequently
    // restarted component on the deprecated path — so its logs are the one runtime channel that
    // repeatedly reaches a scheduled-dispatch-only operator. The notice must lead the crash.
    const r = spawnSync(TSX, [cronDispatchPath], {
      cwd: PKG_DIR,
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CRON_CONFIG: '/nonexistent/schedule.json',
      },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(KNATIVE_DEPRECATION_NOTICE);
    expect(r.stderr).toMatch(/cron-dispatch error:/);
    // Order pinned on purpose: the warning is the first statement of main(), before loadConfig
    // can throw — a dying pod's log must open with the deprecation, not bury it.
    expect(r.stderr.indexOf(KNATIVE_DEPRECATION_NOTICE)).toBeLessThan(
      r.stderr.indexOf('cron-dispatch error:'),
    );
  }, 30_000);
});
