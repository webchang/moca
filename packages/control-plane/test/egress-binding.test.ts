import { describe, expect, it } from 'vitest';
import { bindingList, checkEgressBindings, renderBindings } from '../src/egress-binding.js';

describe('renderBindings', () => {
  it('renders Basic for the github preset shape', () =>
    expect(
      renderBindings(
        { header: 'Authorization', format: 'Basic {base64(username:password)}' },
        { username: 'x-access-token', password: 'p' },
      ),
    ).toEqual([
      {
        name: 'Authorization',
        value: 'Basic ' + Buffer.from('x-access-token:p').toString('base64'),
      },
    ]));

  it('renders a two-header list in order', () =>
    expect(
      renderBindings(
        [
          { header: 'X-API-Key', format: '{key}' },
          { header: 'X-Org', format: 'acme-{key}' },
        ],
        { key: 'k' },
      ),
    ).toEqual([
      { name: 'X-API-Key', value: 'k' },
      { name: 'X-Org', value: 'acme-k' },
    ]));

  it('refuses CR/LF/NUL in any rendered value', () => {
    for (const bad of ['a\r', 'a\nb', 'a\0'])
      expect(() => renderBindings({ header: 'X-API-Key', format: '{key}' }, { key: bad })).toThrow(
        /credential_unsafe/,
      );
  });

  it('throws a CpError with code credential_unsafe', () => {
    try {
      renderBindings({ header: 'X-API-Key', format: '{key}' }, { key: 'a\nb' });
      expect.unreachable();
    } catch (e) {
      expect((e as { code: string }).code).toBe('credential_unsafe');
    }
  });
});

describe('credential_unsafe message', () => {
  it.each(['a\nb', 'sekret\r'])('never carries the rendered value %j', (bad) => {
    let msg = '';
    try {
      renderBindings({ header: 'X-API-Key', format: '{key}' }, { key: bad });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/credential_unsafe/);
    expect(msg).not.toContain(bad);
    expect(msg).not.toContain('sekret');
    expect(msg).not.toContain('a\nb');
  });
});

describe('bindingList', () => {
  it('wraps a single binding', () =>
    expect(bindingList({ header: 'A', format: '{t}' })).toEqual([{ header: 'A', format: '{t}' }]));
});

describe('checkEgressBindings', () => {
  it('accepts a valid single and list', () => {
    checkEgressBindings({ header: 'Authorization', format: 'Bearer {token}' }, ['token']);
    checkEgressBindings(
      [
        { header: 'A', format: '{token}' },
        { header: 'B', format: 'x{token}' },
      ],
      ['token'],
    );
  });
  it.each([
    [{ header: 'Authorization', format: 'Bearer {nope}' }, /field/],
    [{ header: 'Authorization', format: 'Bearer {sha1(token)}' }, /placeholder/],
    [{ header: 'Authorization', format: 'static' }, /placeholder/],
    [{ header: 'Host', format: '{token}' }, /header/],
    [{ header: 'Cookie', format: '{token}' }, /header/],
    [{ header: 'Set-Cookie', format: '{token}' }, /header/],
    [{ header: 'Proxy-Authorization', format: '{token}' }, /header/],
    [{ header: 'X-Moca-Sub', format: '{token}' }, /header/],
    [{ header: 'Bad Header', format: '{token}' }, /header/],
    [[], /1-4/],
    [
      [
        { header: 'A', format: '{token}' },
        { header: 'a', format: '{token}' },
      ],
      /unique/,
    ],
    [
      Array(5)
        .fill(0)
        .map((_, i) => ({ header: `X-${i}`, format: '{token}' })),
      /1-4/,
    ],
  ])('refuses binding %o', (b, re) =>
    expect(() => checkEgressBindings(b as never, ['token'])).toThrow(re),
  );
});
