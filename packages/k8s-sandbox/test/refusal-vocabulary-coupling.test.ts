import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPACITY_REFUSAL } from '../src/transport.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ERRORS_GO = resolve(REPO_ROOT, 'remote-worker/internal/vmpool/errors.go');
const LOOP_GO = resolve(REPO_ROOT, 'remote-worker/internal/session/loop.go');

/**
 * Every `RefusalReason` the Go pool can name, as `{ constant: wireValue }`.
 *
 * Loud-throw reader, the idiom output-cap-coupling.test.ts uses for `BufferCap`: a
 * renamed or reformatted block must fail the extraction rather than yield an empty map
 * and pass every assertion below vacuously.
 */
const readRefusalReasons = (): Record<string, string> => {
  const src = readFileSync(ERRORS_GO, 'utf8');
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/^\t(Refuse\w+)\s+(?:RefusalReason\s+)?= "([^"]+)"$/gm)) {
    out[m[1]] = m[2];
  }
  if (Object.keys(out).length < 2) {
    throw new Error(
      `found ${Object.keys(out).length} RefusalReason constants in errors.go — block renamed or reformatted?`,
    );
  }
  return out;
};

/** The session loop's own refusal literal, the third branch of CAPACITY_REFUSAL. */
const readQueueFullMessage = (): string => {
  const src = readFileSync(LOOP_GO, 'utf8');
  const match = /errFrame\(reqID, "(busy: [^"]+)"\)/.exec(src);
  if (!match) {
    throw new Error(
      'could not find `errFrame(reqID, "busy: ...")` in session/loop.go — message reworded?',
    );
  }
  return match[1];
};

/**
 * CAPACITY_REFUSAL matches on PROSE because the wire contract has no typed refusal
 * (errors.go: "a refusal can only be an error"), so these messages are load-bearing
 * across the language boundary and this pins them. Change the Go side and this fails —
 * which is the point: a reworded refusal would otherwise reach the model as its command's
 * output again, silently restoring #452.
 */
describe('the capacity-refusal vocabulary is pinned to the Go worker', () => {
  // The exact rendering of RefusalError.Error() -- `"<reason>: <detail>"` -- which is why
  // the colon in each CAPACITY_REFUSAL branch is contractual rather than incidental.
  const render = (reason: string) => `${reason}: committing 301989888 more bytes would reach …`;

  it('matches the two capacity reasons', () => {
    const reasons = readRefusalReasons();
    for (const constant of ['RefuseMemoryBudget', 'RefuseMaxRuns']) {
      const wire = reasons[constant];
      expect(wire, `${constant} missing from errors.go`).toBeTruthy();
      expect(CAPACITY_REFUSAL.test(render(wire)), `${constant} (${wire}) must be capacity`).toBe(
        true,
      );
    }
  });

  it('matches the session loop\'s "busy" refusal', () => {
    expect(CAPACITY_REFUSAL.test(readQueueFullMessage())).toBe(true);
  });

  it("does NOT match the refusals that are the caller's fault, not the host's", () => {
    // THE HALF THAT KEEPS THIS HONEST. A regex loose enough to catch every refusal would
    // turn a bad workspace key or a failed spawn into a 503 + Retry-After, so the caller
    // retries forever against a request that can never succeed. Only "the host is full"
    // is retryable; `sandbox-client`'s NOT_STARTED carries these separately for that
    // reason.
    const reasons = readRefusalReasons();
    const capacity = new Set(['RefuseMemoryBudget', 'RefuseMaxRuns']);
    const others = Object.entries(reasons).filter(([c]) => !capacity.has(c));
    expect(others.length, 'errors.go should still have non-capacity reasons').toBeGreaterThan(0);
    for (const [constant, wire] of others) {
      expect(
        CAPACITY_REFUSAL.test(render(wire)),
        `${constant} (${wire}) is not a capacity condition and must not be treated as retryable — if a new reason IS one, add it to CAPACITY_REFUSAL and to this test's capacity set deliberately`,
      ).toBe(false);
    }
  });

  it('does not match an ordinary command failure', () => {
    // The frame a refusal arrives in is the frame a failed command arrives in, so the
    // regex must be anchored: a command whose own output happens to mention a budget
    // must stay a command failure.
    for (const message of [
      'exit status 1',
      'bash: line 1: foo: command not found\nmax-runs: in the log text',
      'make: *** [memory-budget] Error 2',
    ]) {
      expect(CAPACITY_REFUSAL.test(message), message).toBe(false);
    }
  });
});
