import { CpError } from './errors.js';

/**
 * A `sandbox-egress` destination entry, `host[:port][/prefix]` (spec §4.2, "Destination entries").
 * One parser for every writer and reader, so what is stored and what is matched cannot drift.
 */
export interface Destination {
  host: string;
  port: number;
  pathPrefix: string;
}

const DEFAULT_PORT = 443;

function bad(entry: unknown, why: string): never {
  throw new CpError('invalid_request', `destination '${String(entry)}': ${why}`);
}

/** Throws CpError('invalid_request') naming the entry's problem. */
export function parseDestination(entry: string): Destination {
  if (typeof entry !== 'string' || entry.length === 0) bad(entry, 'must be a non-empty string');
  if (entry.startsWith('[')) bad(entry, 'IPv6 literal hosts are not supported in phase 1');
  if (/[\s\x00-\x1f\x7f]/.test(entry))
    bad(entry, 'must not contain whitespace or control characters');
  if (entry.includes('://')) bad(entry, 'must be host[:port][/prefix], not a URL');

  const slash = entry.indexOf('/');
  const hostPort = slash === -1 ? entry : entry.slice(0, slash);
  const prefix = slash === -1 ? '/' : entry.slice(slash);

  const parts = hostPort.split(':');
  if (parts.length > 2) bad(entry, 'must have at most one ":port"');
  if (/[?#]/.test(parts[0]!)) bad(entry, 'host must not contain ? or #');
  const host = parts[0]!.toLowerCase().replace(/\.$/, '');
  if (host.length === 0) bad(entry, 'host is empty');

  let port = DEFAULT_PORT;
  if (parts.length === 2) {
    if (!/^[1-9][0-9]{0,4}$/.test(parts[1]!)) {
      bad(entry, 'port must be decimal 1-65535 with no leading zero');
    }
    port = Number(parts[1]);
    if (port > 65535) bad(entry, 'port must be decimal 1-65535 with no leading zero');
  }

  if (/[?#%\\]/.test(prefix)) bad(entry, 'path prefix must not contain ?, #, % or \\');
  if (prefix.includes('//')) bad(entry, 'path prefix must not contain //');
  if (prefix.includes('/./') || prefix.includes('/../') || /\/\.{1,2}$/.test(prefix)) {
    bad(entry, 'path prefix must not contain . or .. segments');
  }
  if (prefix !== '/' && prefix.endsWith('/')) bad(entry, 'path prefix must not end in /');

  return { host, port, pathPrefix: prefix };
}

/** The stored form: host, then ':port' unless 443, then the prefix unless '/'. */
export function formatDestination(d: Destination): string {
  return (
    d.host +
    (d.port === DEFAULT_PORT ? '' : `:${d.port}`) +
    (d.pathPrefix === '/' ? '' : d.pathPrefix)
  );
}

const canonHost = (h: string): string => h.toLowerCase().replace(/\.$/, '');

/** Exact, case-insensitive, trailing-dot-insensitive. */
export function hostMatches(stored: string, requested: string): boolean {
  return canonHost(stored) === canonHost(requested);
}
