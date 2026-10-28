import { describe, expect, it } from 'vitest';
import { formatDestination, hostMatches, parseDestination } from '../src/egress-destination.js';

describe('parseDestination', () => {
  it.each([
    ['api.github.com', { host: 'api.github.com', port: 443, pathPrefix: '/' }, 'api.github.com'],
    ['API.GitHub.com.', { host: 'api.github.com', port: 443, pathPrefix: '/' }, 'api.github.com'],
    [
      'mcp.corp.example:443/github',
      { host: 'mcp.corp.example', port: 443, pathPrefix: '/github' },
      'mcp.corp.example/github',
    ],
    ['svc.corp:8443', { host: 'svc.corp', port: 8443, pathPrefix: '/' }, 'svc.corp:8443'],
    [
      'svc.corp:8443/a/b',
      { host: 'svc.corp', port: 8443, pathPrefix: '/a/b' },
      'svc.corp:8443/a/b',
    ],
  ])('parses %s', (entry, d, stored) => {
    expect(parseDestination(entry)).toEqual(d);
    expect(formatDestination(parseDestination(entry))).toBe(stored);
  });

  it.each([
    'https://h',
    'h:0',
    'h:65536',
    'h:08443',
    'h/a/',
    'h/a//b',
    'h/a/../b',
    'h/a/./b',
    'h/a/.',
    'h/a%2Fb',
    'h/a?x',
    'h/a#x',
    'h/a\\b',
    '[::1]',
    '',
  ])('refuses %s', (entry) => expect(() => parseDestination(entry)).toThrow(/destination/));

  it('says IPv6 literals are not supported in phase 1', () =>
    expect(() => parseDestination('[::1]:443')).toThrow(/IPv6.*phase 1/));
});

describe('hostMatches', () => {
  it('matches mixed-case and trailing-dot hosts', () => {
    expect(hostMatches('api.github.com', 'API.GitHub.com.')).toBe(true);
    expect(hostMatches('github.com', 'api.github.com')).toBe(false);
  });
});
