import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ATTACH_TOKEN_AUDIENCE,
  ATTACH_TOKEN_ISSUER,
  ATTACH_TOKEN_TYP,
  mintAttachToken,
  verifyAttachToken,
} from '../src/attach-token.js';
import { makeSigner, publicKeyFromBase64, verifyToken } from '../src/token.js';

// Generated per run, never embedded (see token.test.ts).
function signer() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return makeSigner(privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
}
const keysOf = (s: ReturnType<typeof signer>) =>
  new Map([[s.kid, publicKeyFromBase64(s.publicKeyBase64)]]);

const NOW = 1_757_000_000;
const WL = `w-${'a'.repeat(32)}`;
const OWN = 'b'.repeat(32);
const binding = { wl: WL, own: OWN, gen: 'g-1', tr: 'container', n: 2, now: NOW, ttlSeconds: 600 };
/** Every claim, valid; for hand-built tokens that vary one of them. */
const claims = {
  iss: ATTACH_TOKEN_ISSUER,
  aud: ATTACH_TOKEN_AUDIENCE,
  wl: WL,
  own: OWN,
  gen: 'g',
  tr: 'container',
  n: 2,
  iat: NOW,
  exp: NOW + 600,
  jti: 'j',
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'ok';
};

describe('attach token (workload sandboxes spec §3.1)', () => {
  it('round-trips the binding under its own typ and audience, with n and a required exp', () => {
    const s = signer();
    const token = mintAttachToken(s, binding);
    const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString());
    expect(header).toEqual({ alg: 'EdDSA', typ: ATTACH_TOKEN_TYP, kid: s.kid });
    const c = verifyAttachToken(token, keysOf(s), { now: NOW });
    expect(c).toMatchObject({
      iss: ATTACH_TOKEN_ISSUER,
      aud: ATTACH_TOKEN_AUDIENCE,
      wl: WL,
      own: OWN,
      gen: 'g-1',
      tr: 'container',
      n: 2,
      iat: NOW,
      exp: NOW + 600,
    });
    expect(typeof c.jti).toBe('string');
  });

  it('refuses a token signed by a key outside the keyset (unknown kid)', () => {
    const token = mintAttachToken(signer(), binding);
    expect(code(() => verifyAttachToken(token, keysOf(signer()), { now: NOW }))).toBe(
      'token_invalid',
    );
  });

  it('refuses a tampered payload', () => {
    const s = signer();
    const [h, p, sig] = mintAttachToken(s, binding).split('.');
    const c = JSON.parse(Buffer.from(p!, 'base64url').toString());
    c.n = 100;
    const forged = `${h}.${Buffer.from(JSON.stringify(c)).toString('base64url')}.${sig}`;
    expect(code(() => verifyAttachToken(forged, keysOf(s), { now: NOW }))).toBe('token_invalid');
  });

  it('enforces exp with the clock leeway', () => {
    const s = signer();
    const token = mintAttachToken(s, { ...binding, ttlSeconds: 60 });
    expect(code(() => verifyAttachToken(token, keysOf(s), { now: NOW + 90 }))).toBe('ok');
    expect(code(() => verifyAttachToken(token, keysOf(s), { now: NOW + 91 }))).toBe(
      'token_expired',
    );
  });

  it('refuses a token with no exp, or a non-numeric one', () => {
    const s = signer();
    const { exp: _exp, ...noExp } = claims;
    expect(
      code(() => verifyAttachToken(s.signJws(ATTACH_TOKEN_TYP, noExp), keysOf(s), { now: NOW })),
    ).toBe('token_invalid');
    expect(
      code(() =>
        verifyAttachToken(s.signJws(ATTACH_TOKEN_TYP, { ...claims, exp: 'later' }), keysOf(s), {
          now: NOW,
        }),
      ),
    ).toBe('token_invalid');
  });

  it('refuses to mint without a positive ttl', () => {
    const s = signer();
    for (const ttlSeconds of [0, -1, 1.5]) {
      expect(
        code(() => mintAttachToken(s, { ...binding, ttlSeconds })),
        String(ttlSeconds),
      ).toBe('token_invalid');
    }
  });

  it('pins typ both ways: a session token is no attach token, and an attach token no session token', () => {
    const s = signer();
    const session = s.mint({
      sub: 'github:1',
      tenant: 'github:1',
      roles: [],
      scope: ['turn:write'],
      ttlSeconds: 300,
      now: NOW,
    });
    expect(code(() => verifyAttachToken(session, keysOf(s), { now: NOW }))).toBe('token_invalid');
    const attach = mintAttachToken(s, binding);
    expect(code(() => verifyToken(attach, keysOf(s), { now: NOW }))).toBe('token_invalid');
  });

  it('refuses the right typ with a wrong audience or issuer', () => {
    const s = signer();
    const v = (c: object, typ = ATTACH_TOKEN_TYP) =>
      code(() => verifyAttachToken(s.signJws(typ, c), keysOf(s), { now: NOW }));
    expect(v({ ...claims, aud: 'harness' })).toBe('token_invalid');
    expect(v({ ...claims, iss: 'other' })).toBe('token_invalid');
    // SBX0's caller token typ, with otherwise valid claims (#546, SBX0 sandbox service).
    expect(v(claims, 'moca-sandbox+jwt')).toBe('token_invalid');
    expect(v(claims)).toBe('ok');
  });

  it('refuses a binding that is not shaped like one, on both mint and verify', () => {
    const s = signer();
    for (const bad of [
      { wl: 'moca-sandbox' },
      { wl: `w-${'A'.repeat(32)}` },
      { own: 'short' },
      { gen: '' },
      { tr: 'Container!' },
      { n: 0 },
      { n: -1 },
      { n: 1.5 },
      { n: '2' },
    ]) {
      expect(
        code(() => mintAttachToken(s, { ...binding, ...(bad as object) } as typeof binding)),
        JSON.stringify(bad),
      ).toBe('token_invalid');
      const token = s.signJws(ATTACH_TOKEN_TYP, { ...claims, ...bad });
      expect(
        code(() => verifyAttachToken(token, keysOf(s), { now: NOW })),
        JSON.stringify(bad),
      ).toBe('token_invalid');
    }
    const { n: _n, ...noN } = claims;
    expect(
      code(() => verifyAttachToken(s.signJws(ATTACH_TOKEN_TYP, noN), keysOf(s), { now: NOW })),
    ).toBe('token_invalid');
  });
});
