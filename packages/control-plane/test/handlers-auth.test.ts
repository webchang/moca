import { describe, expect, it } from 'vitest';
import { HANDLERS } from '../src/handlers.js';
import { verifyToken } from '../src/token.js';
import { TestUserProvider } from '../src/identity.js';
import { StubIdentity } from './helpers/stub-identity.js';
import { NOW_MS, alice, codeOf, ctx, makeDeps } from './helpers/deps.js';

const HOUR = 3_600_000;

/** A deps whose clock the test moves, with the production API-token lifetime. */
function clocked(roles: string[] = []) {
  let now = NOW_MS;
  const d = makeDeps({
    now: () => now,
    identity: new StubIdentity({ subject: 'github:1234', displayName: 'Alice', roles }),
    config: { apiTokenTtlSeconds: 900 },
  });
  return { d, advance: (ms: number) => void (now += ms) };
}

const login = async (d: ReturnType<typeof makeDeps>) =>
  (await HANDLERS.completeDeviceAuth!(ctx({ body: { deviceCode: 'dc-1', label: 'laptop' } }), d))
    .body as Record<string, unknown> & { token: string; refreshToken: string };

const refresh = (
  d: ReturnType<typeof makeDeps>,
  token: unknown,
  grant: unknown = 'refresh_token',
) => HANDLERS.refreshAuth!(ctx({ body: { grant_type: grant, refresh_token: token } }), d);

describe('device-flow login issues a refresh token (B14 §4.3)', () => {
  it('returns a 15-minute API token AND a refresh token capped at the absolute limit', async () => {
    const { d } = clocked();
    const body = await login(d);
    expect(body.refreshToken).toMatch(/^mrt_[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBe(Math.floor(NOW_MS / 1000) + 900);
    expect(body.refreshExpiresAt).toBe(Math.floor(NOW_MS / 1000) + 90 * 86_400);
    expect(d.refreshAudit.map((e) => e.decision)).toEqual(['refresh_issued']);
  });
});

describe('POST /v1/auth/token', () => {
  it('ACCEPTANCE 1: after 12 h asleep, the refresh token alone gets a fresh API token', async () => {
    const { d, advance } = clocked();
    const first = await login(d);
    advance(12 * HOUR); // the API token died 11 h 45 m ago
    const res = await refresh(d, first.refreshToken);
    expect(res.status).toBe(200);
    const body = res.body as { token: string; refreshToken: string; expiresAt: number };
    expect(body.refreshToken).not.toBe(first.refreshToken);
    const claims = verifyToken(body.token, d.verifyKeys, {
      now: Math.floor((NOW_MS + 12 * HOUR) / 1000),
      requiredScope: 'api',
    });
    expect(claims.sub).toBe('github:1234');
    expect(body.expiresAt).toBe(Math.floor((NOW_MS + 12 * HOUR) / 1000) + 900);
  });

  it('ACCEPTANCE 2: a revoked refresh token is refused with invalid_grant', async () => {
    const { d } = clocked();
    const first = await login(d);
    await HANDLERS.revokeAuth!(ctx({ body: { token: first.refreshToken } }), d);
    expect(await codeOf(() => refresh(d, first.refreshToken))).toBe('invalid_grant');
  });

  it('ACCEPTANCE 3: every refresh is audited with subject and family, refusals included', async () => {
    const { d } = clocked();
    const first = await login(d);
    const second = (await refresh(d, first.refreshToken)).body as { refreshToken: string };
    await refresh(d, second.refreshToken);
    await codeOf(() => refresh(d, 'mrt_' + 'Z'.repeat(43)));
    const rotated = d.refreshAudit.filter((e) => e.decision === 'refresh_rotated');
    expect(rotated).toHaveLength(2);
    for (const e of rotated) expect(e).toMatchObject({ subject: 'github:1234' });
    expect(new Set(rotated.map((e) => e.family)).size).toBe(1);
    // An unknown token names no family or principal, so it is audited in the anonymous stream.
    expect(d.refreshAnonAudit.at(-1)).toMatchObject({
      decision: 'refresh_refused',
      reason: 'unknown',
    });
  });

  it('mints roles from the CURRENT admin list, not the ones recorded at login', async () => {
    let roles = ['admin'];
    let now = NOW_MS;
    const d = makeDeps({
      now: () => now,
      identity: {
        startDeviceAuth: async () => ({
          deviceCode: 'dc',
          userCode: 'U',
          verificationUri: 'v',
          interval: 5,
          expiresIn: 900,
        }),
        completeDeviceAuth: async () => ({ subject: 'github:1234', displayName: 'A', roles }),
        rolesFor: () => roles,
      },
    });
    const first = await login(d);
    roles = []; // the operator removed them from SH_ADMIN_SUBJECTS
    now += 60_000;
    const body = (await refresh(d, first.refreshToken)).body as { token: string; roles: string[] };
    expect(body.roles).toEqual([]);
    const claims = verifyToken(body.token, d.verifyKeys, {
      now: Math.floor(now / 1000),
      requiredScope: 'api',
    });
    expect(claims.roles ?? []).toEqual([]);
  });

  it('refuses a malformed refresh_token or grant_type without touching the store (Review Focus 3)', async () => {
    const { d } = clocked();
    expect(await codeOf(() => refresh(d, undefined))).toBe('invalid_request');
    expect(await codeOf(() => refresh(d, 42))).toBe('invalid_request');
    expect(await codeOf(() => refresh(d, 'mrt_x', 'password'))).toBe('invalid_request');
    for (const junk of ['', 'mrt_', 'not-a-token', 'mrt_' + 'A'.repeat(10_000)]) {
      expect(await codeOf(() => refresh(d, junk))).toBe('invalid_grant');
    }
    expect(d.refreshAudit).toEqual([]); // the wrong shape never reached a lookup
  });

  it('kills the family on reuse: the thief and the owner both have to log in again', async () => {
    const { d, advance } = clocked();
    const first = await login(d);
    const second = (await refresh(d, first.refreshToken)).body as { refreshToken: string };
    advance(60_000); // past the 30 s grace
    expect(await codeOf(() => refresh(d, first.refreshToken))).toBe('invalid_grant');
    expect(await codeOf(() => refresh(d, second.refreshToken))).toBe('invalid_grant');
    expect(d.refreshAudit.map((e) => e.decision)).toContain('refresh_reuse_detected');
  });
});

describe('POST /v1/auth/revoke and /v1/auth/revoke-all', () => {
  it('answers 200 even for a token nobody issued (RFC 7009 §2.2)', async () => {
    const { d } = clocked();
    const res = await HANDLERS.revokeAuth!(ctx({ body: { token: 'mrt_' + 'Q'.repeat(43) } }), d);
    expect(res).toEqual({ status: 200, body: {} });
    expect(await codeOf(() => HANDLERS.revokeAuth!(ctx({ body: {} }), d))).toBe('invalid_request');
  });

  it('revoke-all ends every login of the caller and reports how many', async () => {
    const { d } = clocked();
    const a = await login(d);
    const b = await login(d);
    const res = await HANDLERS.revokeAllAuth!(ctx({ principal: alice }), d);
    expect(res).toEqual({ status: 200, body: { revoked: 2 } });
    for (const t of [a.refreshToken, b.refreshToken]) {
      expect(await codeOf(() => refresh(d, t))).toBe('invalid_grant');
    }
  });

  it('revoke-all requires an API token', async () => {
    const { d } = clocked();
    expect(await codeOf(() => HANDLERS.revokeAllAuth!(ctx(), d))).toBe('token_required');
  });
});

// ---------------------------------------------------------------- test users (ADR-0045, #616)

const SECRET = 'test-user-secret-0123456789'; // notsecret
const testProvider = (count = 10, adminSubjects: string[] = []) =>
  new TestUserProvider({ count, secret: SECRET, adminSubjects });

const testLogin = (d: ReturnType<typeof makeDeps>, body: Record<string, unknown>) =>
  HANDLERS.testUserToken!(ctx({ body }), d);

describe('POST /v1/auth/test-token is invisible unless SH_TEST_USERS is set', () => {
  // The gate that matters most: a production control plane must not advertise a test-login path.
  it('404s with no testUsers provider, whatever the body', async () => {
    const d = makeDeps(); // no testUsers
    for (const body of [
      {},
      { index: 1 },
      { index: 1, secret: SECRET },
      { index: 999, secret: 'wrong' },
    ]) {
      expect(await codeOf(() => testLogin(d, body)), JSON.stringify(body)).toBe('not_found');
    }
  });
});

describe('POST /v1/auth/test-token requires the shared secret', () => {
  it('refuses a missing, wrong, empty or non-string secret as `unauthorized`', async () => {
    const d = makeDeps({ testUsers: testProvider() });
    for (const secret of [undefined, '', 'wrong', SECRET + 'x', SECRET.slice(0, -1), 42, null]) {
      expect(await codeOf(() => testLogin(d, { index: 1, secret })), String(secret)).toBe(
        'unauthorized',
      );
    }
  });

  // The secret is checked BEFORE the index, so an unauthenticated prober cannot learn how many
  // test users exist by watching which indexes answer differently.
  it('answers the same for a bad index as for a good one when the secret is wrong', async () => {
    const d = makeDeps({ testUsers: testProvider(10) });
    expect(await codeOf(() => testLogin(d, { index: 1, secret: 'wrong' }))).toBe('unauthorized');
    expect(await codeOf(() => testLogin(d, { index: 9999, secret: 'wrong' }))).toBe('unauthorized');
  });
});

describe('POST /v1/auth/test-token bounds the index', () => {
  it('refuses 0, N+1, a fraction, a string and a missing index', async () => {
    const d = makeDeps({ testUsers: testProvider(10) });
    for (const index of [0, -1, 11, 1.5, '1', undefined, null]) {
      expect(await codeOf(() => testLogin(d, { index, secret: SECRET })), String(index)).toBe(
        'invalid_request',
      );
    }
  });
});

describe('a test-user login is configured exactly like a GitHub one', () => {
  it('returns the same body shape, with a refresh token and an api-scoped token', async () => {
    const d = makeDeps({ testUsers: testProvider(10) });
    const body = (await testLogin(d, { index: 3, secret: SECRET, label: 'driver' })).body as {
      token: string;
      subject: string;
      displayName: string;
      roles: string[];
      refreshToken: string;
      expiresAt: number;
    };
    expect(body.subject).toBe('test:3');
    expect(body.displayName).toBe('Test User 3');
    expect(body.refreshToken).toBeTruthy();
    const claims = verifyToken(body.token, d.verifyKeys, { now: Math.floor(NOW_MS / 1000) });
    expect(claims.sub).toBe('test:3');
    // One subject is one tenant in MU1, as for a GitHub subject.
    expect(claims.tenant).toBe('test:3');
    expect(claims.scope).toContain('api');
  });

  it('issues a refresh token that actually rotates, so renewal works as it does for a user', async () => {
    const d = makeDeps({ testUsers: testProvider(10) });
    const first = (await testLogin(d, { index: 1, secret: SECRET })).body as {
      refreshToken: string;
    };
    const rotated = (await refresh(d, first.refreshToken)).body as {
      token: string;
      refreshToken: string;
    };
    expect(rotated.token).toBeTruthy();
    expect(rotated.refreshToken).not.toBe(first.refreshToken);
  });

  it('gives different indexes different subjects', async () => {
    const d = makeDeps({ testUsers: testProvider(10) });
    const a = (await testLogin(d, { index: 1, secret: SECRET })).body as { subject: string };
    const b = (await testLogin(d, { index: 2, secret: SECRET })).body as { subject: string };
    expect(a.subject).not.toBe(b.subject);
  });

  it('honours SH_ADMIN_SUBJECTS for a test subject', async () => {
    const d = makeDeps({ testUsers: testProvider(10, ['test:4']) });
    const body = (await testLogin(d, { index: 4, secret: SECRET })).body as { roles: string[] };
    expect(body.roles).toEqual(['admin']);
  });
});
