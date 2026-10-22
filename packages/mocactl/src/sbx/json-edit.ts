import { createScanner, findNodeAtLocation, parseTree, SyntaxKind, type Node } from 'jsonc-parser';

/**
 * Minimal, style-keeping edits to a JSON (or JSONC) document's text, for agent-config.ts: append a
 * member to an object or an array, and remove one. Nothing else in the file is touched, so its
 * indentation, key order, line endings, comments and trailing commas survive, and a removal undoes
 * an insertion byte for byte. (jsonc-parser's own `modify` reformats the lines around an edit and
 * corrupts a compact array when it removes the last item, so only its parser and scanner are used.)
 */

export interface Style {
  /** One indentation level: spaces or a tab. */
  unit: string;
  eol: string;
}

export function styleOf(text: string): Style {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /\n([ \t]+)\S/.exec(text)?.[1];
  return { unit: indent ? (indent.startsWith('\t') ? '\t' : indent) : '  ', eol };
}

const isWs = (ch: string) => ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n';

function tree(text: string): Node {
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (!root) throw new Error('not a JSON document');
  return root;
}

/** The line's leading whitespace, for the line holding `offset`. */
function lineIndent(text: string, offset: number): string {
  let s = offset;
  while (s > 0 && text[s - 1] !== '\n') s--;
  let e = s;
  while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
  return text.slice(s, e);
}

/** Whether `offset` is the first non-blank character on its line. */
function startsLine(text: string, offset: number): boolean {
  let s = offset;
  while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--;
  return s === 0 || text[s - 1] === '\n';
}

/** The offsets of commas (outside comments) in [from, to). */
function commas(text: string, from: number, to: number): number[] {
  const sc = createScanner(text, false);
  sc.setPosition(from);
  const out: number[] = [];
  for (let k = sc.scan(); k !== SyntaxKind.EOF && sc.getTokenOffset() < to; k = sc.scan()) {
    if (k === SyntaxKind.CommaToken) out.push(sc.getTokenOffset());
  }
  return out;
}

/** The unit an object member or array item occupies: the property node, or the item itself. */
const unitOf = (n: Node) => (n.parent?.type === 'property' ? n.parent : n);

function render(value: unknown, s: Style, indent: string | undefined): string {
  if (indent === undefined) return JSON.stringify(value);
  return JSON.stringify(value, null, s.unit)
    .split('\n')
    .join(s.eol + indent);
}

/**
 * Appends `key: value` to the object at `path` (or `value` to the array there, `key` undefined),
 * in the container's own style: one member per line, indented as its siblings, when the container
 * spans lines (or is the document's empty root); else inline.
 */
export function append(
  text: string,
  path: string[],
  key: string | undefined,
  value: unknown,
  s: Style,
): string {
  const root = tree(text);
  const c = path.length ? findNodeAtLocation(root, path) : root;
  if (!c || (c.type !== 'object' && c.type !== 'array')) throw new Error(`no container at ${path}`);
  const kids = c.children ?? [];
  const open = c.offset;
  const close = c.offset + c.length - 1;
  const multi = text.slice(open, close).includes('\n') || (c === root && kids.length === 0);
  // A minified document stays minified; anything else gets JSON's usual `, ` and `: `.
  const minified = !/\s/.test(text.trim());
  const member = (indent: string | undefined) =>
    (key !== undefined
      ? JSON.stringify(key) + (minified && indent === undefined ? ':' : ': ')
      : '') + render(value, s, indent);

  if (!multi) {
    if (!kids.length) return text.slice(0, open + 1) + member(undefined) + text.slice(open + 1);
    const last = kids[kids.length - 1]!;
    const end = last.offset + last.length;
    const sep = commas(text, open, close).map((k) => isWs(text[k + 1] ?? ''));
    const sp = (sep.length ? sep[sep.length - 1] : !minified) ? ' ' : '';
    return text.slice(0, end) + ',' + sp + member(undefined) + text.slice(end);
  }
  if (!kids.length) {
    const base = lineIndent(text, close);
    const ind = base + s.unit;
    const inner = text.slice(open + 1, close);
    // An empty container's inside is only whitespace (or comments, kept before the member).
    const keep = inner.trim() ? inner.replace(/\s+$/, '') : '';
    return (
      text.slice(0, open + 1) + keep + s.eol + ind + member(ind) + s.eol + base + text.slice(close)
    );
  }
  const last = unitOf(kids[kids.length - 1]!);
  const end = last.offset + last.length;
  const trailing = commas(text, end, close)[0];
  const ind = startsLine(text, last.offset)
    ? lineIndent(text, last.offset)
    : lineIndent(text, open) + s.unit;
  // After the last member and everything that follows it up to its line's end or the closing
  // bracket: its comma and its comments, a block comment spanning lines included. The member
  // never lands inside a comment, and never between the last member and the comment after it.
  const at = lineTail(text, end).end;
  const add = s.eol + ind + member(ind) + (trailing !== undefined ? ',' : '');
  if (trailing !== undefined) return text.slice(0, at) + add + text.slice(at);
  return text.slice(0, end) + ',' + text.slice(end, at) + add + text.slice(at);
}

/**
 * What follows a member on its own line: its comma (if there), comments, and where the line ends
 * (`atBreak`: at a line break; else at the next token, such as a closing bracket on the line).
 */
function lineTail(text: string, from: number): { comma?: number; end: number; atBreak: boolean } {
  const sc = createScanner(text, false);
  sc.setPosition(from);
  let comma: number | undefined;
  let end = from;
  for (let k = sc.scan(); k !== SyntaxKind.EOF; k = sc.scan()) {
    const off = sc.getTokenOffset();
    if (k === SyntaxKind.Trivia) continue;
    if (k === SyntaxKind.CommaToken && comma === undefined) {
      comma = off;
      end = off + 1;
    } else if (k === SyntaxKind.LineCommentTrivia || k === SyntaxKind.BlockCommentTrivia) {
      end = off + sc.getTokenLength();
    } else if (k === SyntaxKind.LineBreakTrivia) {
      return { ...(comma !== undefined ? { comma } : {}), end: off, atBreak: true };
    } else break;
  }
  return { ...(comma !== undefined ? { comma } : {}), end, atBreak: false };
}

/** Whether [from, to) holds a line comment (the only text there is commas and comments). */
function hasLineComment(text: string, from: number, to: number): boolean {
  const sc = createScanner(text, false);
  sc.setPosition(from);
  for (let k = sc.scan(); k !== SyntaxKind.EOF && sc.getTokenOffset() < to; k = sc.scan()) {
    if (k === SyntaxKind.LineCommentTrivia) return true;
  }
  return false;
}

/** Deletes the ranges (sorted, disjoint) from `text`. */
function cut(text: string, ranges: [number, number][]): string {
  let out = '';
  let at = 0;
  for (const [a, b] of ranges.sort((x, y) => x[0] - y[0])) {
    out += text.slice(at, a);
    at = b;
  }
  return out + text.slice(at);
}

/** Every comment in the document, in order, as written (line and block comments alike). */
export function commentsOf(text: string): string[] {
  const sc = createScanner(text, false);
  const out: string[] = [];
  for (let k = sc.scan(); k !== SyntaxKind.EOF; k = sc.scan()) {
    if (k === SyntaxKind.LineCommentTrivia || k === SyntaxKind.BlockCommentTrivia) {
      out.push(text.slice(sc.getTokenOffset(), sc.getTokenOffset() + sc.getTokenLength()));
    }
  }
  return out;
}

/** The text inside the container at `path` when it has no members (for `remove`'s `emptyInner`). */
export function innerOf(text: string, path: (string | number)[]): string | undefined {
  const root = tree(text);
  const c = path.length ? findNodeAtLocation(root, path) : root;
  if (!c || (c.type !== 'object' && c.type !== 'array') || (c.children ?? []).length) {
    return undefined;
  }
  return text.slice(c.offset + 1, c.offset + c.length - 1);
}

export interface Slot {
  from: number;
  to: number;
  /** The container's brackets. */
  open: number;
  close: number;
  /** The member is the container's only one. */
  only: boolean;
}

/**
 * Where the member at `path` sits in its container, as offsets into `text`: its slot runs from the
 * end of the member before it (or just inside the opening bracket) to the start of the member
 * after it (or the closing bracket), and holds the member itself, its commas and whatever
 * whitespace and comments lie between. A removal may cut only inside it (agent-config's
 * guard), apart from an emptied container's recorded inside (`only`: it is the only member).
 */
export function slotOf(text: string, path: (string | number)[]): Slot | undefined {
  const n = findNodeAtLocation(tree(text), path);
  if (!n || !path.length) return undefined;
  const u = unitOf(n);
  const c = u.parent!;
  const kids = (c.children ?? []).map(unitOf);
  const i = kids.indexOf(u);
  const prev = i > 0 ? kids[i - 1] : undefined;
  const next = kids[i + 1];
  const open = c.offset;
  const close = c.offset + c.length - 1;
  return {
    from: prev ? prev.offset + prev.length : open + 1,
    to: next ? next.offset : close,
    open,
    close,
    only: kids.length === 1,
  };
}

/**
 * Removes the member at `path` (an object key, or an array index), undoing `append`: a member on
 * its own line goes with that whole line (its comma and any comment after it); the comma before it
 * is touched only when it was the last member and had no comma of its own, which is the one
 * `append` added. A member sharing its line with others is cut with its separating comma.
 */
export function remove(
  text: string,
  path: (string | number)[],
  o: {
    /**
     * What was inside the container before its first member was appended (`innerOf`): restored
     * when the member removed is the only one, so `{}`, `{ }` and `{\n}` each come back as they were.
     */
    emptyInner?: string;
  } = {},
): string {
  const root = tree(text);
  const n = findNodeAtLocation(root, path);
  if (!n) return text;
  const u = unitOf(n);
  const c = u.parent!;
  const kids = (c.children ?? []).map(unitOf);
  const i = kids.indexOf(u);
  const prev = i > 0 ? kids[i - 1] : undefined;
  const next = kids[i + 1];
  const open = c.offset;
  const close = c.offset + c.length - 1;
  const end = u.offset + u.length;
  const own = commas(text, end, next ? next.offset : close)[0];
  const tail = lineTail(text, end);
  // The container left empty: its inside as it was before the first append, when known and only
  // whitespace is left; otherwise just the member's span is gone.
  const collapse = (t: string): string => {
    if (kids.length !== 1 || o.emptyInner === undefined) return t;
    const r = tree(t);
    const e = path.length > 1 ? findNodeAtLocation(r, path.slice(0, -1)) : r;
    if (!e) return t;
    const inner = t.slice(e.offset + 1, e.offset + e.length - 1);
    return inner.trim() === ''
      ? t.slice(0, e.offset + 1) + o.emptyInner + t.slice(e.offset + e.length - 1)
      : t;
  };

  const ownLine =
    startsLine(text, u.offset) &&
    (own === undefined || own === tail.comma) &&
    (tail.atBreak || next === undefined);
  if (ownLine) {
    let ls = u.offset;
    while (ls > 0 && text[ls - 1] !== '\n') ls--;
    const eol = text.slice(ls - 2, ls) === '\r\n' ? ls - 2 : ls - 1;
    const before = prev ? prev.offset + prev.length : open + 1;
    // The line break before the member's line goes with it, unless the line before ends in a
    // line comment and nothing on this line ends it: that comment would swallow what follows.
    const from = tail.atBreak || !hasLineComment(text, before, eol) ? eol : ls;
    const ranges: [number, number][] = [[from, tail.end]];
    if (prev && !next && own === undefined) {
      const comma = commas(text, prev.offset + prev.length, u.offset)[0];
      if (comma !== undefined) ranges.push([comma, comma + 1]);
    }
    return collapse(cut(text, ranges));
  }
  if (next && prev && startsLine(text, u.offset)) {
    // It starts its line, and another member follows it there (one the developer put after it,
    // say): what `append` wrote goes, the line break before its line, its indentation, the member
    // and its comma, and everything else stays, the lines before it (blank lines the developer
    // put there) and what follows its comma. A comment between the member and its comma stays.
    let ls = u.offset;
    while (ls > 0 && text[ls - 1] !== '\n') ls--;
    const eol = text.slice(ls - 2, ls) === '\r\n' ? ls - 2 : ls - 1;
    const comma = own!;
    const between = text.slice(end, comma).trim() !== '';
    if (hasLineComment(text, prev.offset + prev.length, eol)) {
      // The line break must stay, or that comment would swallow what follows: the next member
      // takes this one's place on the line.
      let to = comma + 1;
      while (to < next.offset && (text[to] === ' ' || text[to] === '\t')) to++;
      return cut(
        text,
        between
          ? [
              [u.offset, end],
              [comma, to],
            ]
          : [[u.offset, to]],
      );
    }
    return cut(
      text,
      between
        ? [
            [eol, end],
            [comma, comma + 1],
          ]
        : [[eol, comma + 1]],
    );
  }
  if (next && !prev) {
    // The first of several: it goes with its comma and the spaces after it, so the next member
    // takes its place on the line.
    let to = own !== undefined ? own + 1 : end;
    while (to < next.offset && (text[to] === ' ' || text[to] === '\t')) to++;
    return cut(text, [[u.offset, to]]);
  }
  let start = u.offset;
  while (start > open + 1 && isWs(text[start - 1]!)) start--;
  if (prev) {
    // The comma that separated it from the one before goes, and the whitespace up to it; a
    // comment between them stays.
    const comma = commas(text, prev.offset + prev.length, u.offset)[0];
    return comma === undefined
      ? cut(text, [[start, end]])
      : cut(text, [
          [comma, comma + 1],
          [start, end],
        ]);
  }
  return collapse(cut(text, [[start, own !== undefined ? own + 1 : end]]));
}
