import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initLedger, openLedger, type LedgerRecord } from '../src/core/subagent-ledger.js';

let root: string;
let path: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ledger-'));
  path = join(root, 'subagents.jsonl');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const rec = (over: Partial<LedgerRecord> = {}): LedgerRecord => ({
  sessionId: 's1',
  tag: 'parent-1',
  envelope: { kind: 'prompt', prompt: 'hi', configRef: 'sha256:a'.padEnd(71, 'a') },
  submittedAt: 1_000_000,
  lastKnownState: 'running',
  stateObservedAt: 1_000_000,
  ...over,
});

describe('openLedger — append + readAll', () => {
  it('round-trips a single record and returns it as the only session', () => {
    const l = openLedger(path);
    l.append(rec());
    const all = l.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.sessionId).toBe('s1');
    expect(all[0]!.envelope.configRef).toBeTruthy();
  });

  it('orders results by submittedAt so dispatch order is preserved (not file write order)', () => {
    const l = openLedger(path);
    // Dispatch two leaves with the LATER one appended first (simulates a retry that wrote
    // before an earlier out-of-band record was persisted).
    l.append(rec({ sessionId: 'late', submittedAt: 2_000_000 }));
    l.append(rec({ sessionId: 'early', submittedAt: 1_000_000 }));
    expect(l.readAll().map((r) => r.sessionId)).toEqual(['early', 'late']);
  });
});

describe('openLedger — updateState folding', () => {
  it('folds a terminal update over the initial record (last writer wins per-session)', () => {
    const l = openLedger(path);
    l.append(rec());
    l.updateState('s1', 'done', { now: 1_000_050 });
    const only = l.readAll()[0]!;
    expect(only.lastKnownState).toBe('done');
    expect(only.stateObservedAt).toBe(1_000_050);
    expect(only.stateDetail).toBeUndefined();
  });

  it('clears stateDetail when a later update omits it', () => {
    const l = openLedger(path);
    l.append(rec());
    l.updateState('s1', 'running', { detail: 'child exited; waiting for result', now: 10 });
    expect(l.readAll()[0]!.stateDetail).toBeTruthy();
    l.updateState('s1', 'done', { now: 20 }); // no detail
    expect(l.readAll()[0]!.stateDetail).toBeUndefined();
  });

  it('records the childPid only after it is passed in (write-record-before-fork)', () => {
    const l = openLedger(path);
    l.append(rec()); // no childPid yet — the ledger is written before the worker is forked
    expect(l.readAll()[0]!.childPid).toBeUndefined();
    l.updateState('s1', 'running', { childPid: 4242, now: 11 });
    expect(l.readAll()[0]!.childPid).toBe(4242);
  });

  it('drops an orphan update whose session has never been recorded (ignores noise)', () => {
    const l = openLedger(path);
    l.updateState('ghost', 'done', { now: 10 });
    expect(l.readAll()).toEqual([]);
  });
});

describe('openLedger — file integrity', () => {
  it('creates the file with 0600 so a shared machine does not expose per-leaf envelopes', () => {
    const l = openLedger(path);
    l.append(rec());
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('skips a malformed trailing line (recovers from a crash-mid-append)', () => {
    const l = openLedger(path);
    l.append(rec());
    appendFileSync(path, '{partial-write-no-closing-brace\n');
    // Still readable — the valid record on the previous line comes through unchanged.
    const all = l.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.sessionId).toBe('s1');
  });

  it('compact rewrites the file so only folded current state remains', () => {
    const l = openLedger(path);
    l.append(rec({ sessionId: 'a' }));
    l.append(rec({ sessionId: 'b', submittedAt: 2_000_000 }));
    l.updateState('a', 'done', { now: 1_000_050 });
    l.updateState('b', 'failed', { detail: 'saturated', now: 2_000_050 });
    // Pre-compact: 4 lines on disk.
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(4);
    l.compact();
    // Post-compact: 2 lines (one per session), both now `record` type, with folded state.
    const linesAfter = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    expect(linesAfter).toHaveLength(2);
    for (const line of linesAfter) {
      expect(line.type).toBe('record');
    }
    const states = l.readAll().map((r) => r.lastKnownState);
    expect(states).toEqual(['done', 'failed']);
  });
});

describe('initLedger', () => {
  it('creates an empty file with 0600 so readAll on a fresh install returns []', () => {
    initLedger(path);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(openLedger(path).readAll()).toEqual([]);
  });

  it('is idempotent: a second call does not clobber an existing ledger', () => {
    const l = openLedger(path);
    l.append(rec());
    initLedger(path); // must not reset the file
    expect(openLedger(path).readAll()).toHaveLength(1);
  });
});

describe('openLedger — find', () => {
  it('returns undefined for a session not in the ledger (not throw, not return a stub)', () => {
    const l = openLedger(path);
    l.append(rec());
    expect(l.find('nope')).toBeUndefined();
    expect(l.find('s1')?.sessionId).toBe('s1');
  });
});
