import type { CredentialBinding } from './credential-store.js';
import { CpError } from './errors.js';

/** `sandbox-egress` bindings: one object, or a list of 1-4 (one rendered header each). */
export function bindingList(b: CredentialBinding | CredentialBinding[]): CredentialBinding[] {
  return Array.isArray(b) ? b : [b];
}

type Piece =
  | { kind: 'lit'; text: string }
  | { kind: 'field'; field: string }
  | { kind: 'base64'; a: string; b: string };

const MAX_BINDINGS = 4;
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const REFUSED_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'keep-alive',
  'cookie',
  'set-cookie',
]);

const invalid = (why: string): never => {
  throw new CpError('invalid_request', why);
};

/**
 * The one scanner over a format, shared by validation and rendering so they cannot disagree.
 * Placeholders: `{f}` and `{base64(a:b)}`. Field names are checked against `fields` when given.
 */
function scan(format: string, fields: string[] | undefined): Piece[] {
  const out: Piece[] = [];
  const known = (f: string): void => {
    if (fields && !fields.includes(f)) {
      invalid(`binding format names field '${f}', which the credential kind does not declare`);
    }
  };
  let i = 0;
  let lit = '';
  while (i < format.length) {
    const c = format[i]!;
    if (c === '}') invalid(`binding format has an unbalanced '}'`);
    if (c !== '{') {
      lit += c;
      i++;
      continue;
    }
    const end = format.indexOf('}', i);
    if (end === -1) invalid(`binding format has an unterminated placeholder`);
    const inner = format.slice(i + 1, end);
    if (lit) out.push({ kind: 'lit', text: lit });
    lit = '';
    const b64 = /^base64\(([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+)\)$/.exec(inner);
    if (b64) {
      known(b64[1]!);
      known(b64[2]!);
      out.push({ kind: 'base64', a: b64[1]!, b: b64[2]! });
    } else if (/^[A-Za-z0-9_.-]+$/.test(inner)) {
      known(inner);
      out.push({ kind: 'field', field: inner });
    } else {
      invalid(`binding format has an unsupported placeholder '{${inner}}'`);
    }
    i = end + 1;
  }
  if (lit) out.push({ kind: 'lit', text: lit });
  if (!out.some((p) => p.kind !== 'lit')) invalid('binding format needs at least one placeholder');
  return out;
}

function checkHeader(header: unknown): void {
  if (typeof header !== 'string' || !HEADER_RE.test(header)) {
    invalid(`binding header must match ${HEADER_RE.source}`);
  }
  const h = (header as string).toLowerCase();
  if (REFUSED_HEADERS.has(h) || h.startsWith('proxy-') || h.startsWith('x-moca-')) {
    invalid(`binding header '${header as string}' is not allowed on an egress credential`);
  }
}

/** Throws CpError('invalid_request') naming the problem, never a secret. */
export function checkEgressBindings(
  b: CredentialBinding | CredentialBinding[],
  fields: string[],
): void {
  const list = bindingList(b);
  if (list.length < 1 || list.length > MAX_BINDINGS) {
    invalid(`a credential holds 1-${MAX_BINDINGS} bindings`);
  }
  const seen = new Set<string>();
  for (const one of list) {
    checkHeader(one.header);
    const key = one.header.toLowerCase();
    if (seen.has(key)) invalid(`binding header names must be unique, '${one.header}' repeats`);
    seen.add(key);
    if (typeof one.format !== 'string') invalid('binding format must be a string');
    scan(one.format, fields);
  }
}

/** One rendered header per binding. Throws CpError('credential_unsafe') on CR/LF/NUL. */
export function renderBindings(
  b: CredentialBinding | CredentialBinding[],
  secret: Record<string, string>,
): { name: string; value: string }[] {
  const get = (f: string): string => {
    const v = secret[f];
    if (v === undefined) {
      throw new CpError(
        'credential_unsafe',
        `credential_unsafe: stored credential lacks field '${f}'`,
      );
    }
    return v;
  };
  return bindingList(b).map((one) => {
    const value = scan(one.format, undefined)
      .map((p) =>
        p.kind === 'lit'
          ? p.text
          : p.kind === 'field'
            ? get(p.field)
            : Buffer.from(`${get(p.a)}:${get(p.b)}`, 'utf8').toString('base64'),
      )
      .join('');
    if (/[\r\n\0]/.test(value)) {
      throw new CpError(
        'credential_unsafe',
        `credential_unsafe: value for header '${one.header}' is unsafe`,
      );
    }
    return { name: one.header, value };
  });
}
