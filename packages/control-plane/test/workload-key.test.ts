import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ATTACH_OWNER_RE, ATTACH_WORKLOAD_RE } from '../src/attach-token.js';
import { ownerScopeFor, workloadKeyFor, workloadRecordKey } from '../src/workload-key.js';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

describe('workload names (workload sandboxes spec §3.1, §4.1)', () => {
  it('derives the formulas the record, its Context and the attach token share', () => {
    expect(ownerScopeFor('github:alice')).toBe(sha('github:alice').slice(0, 32));
    expect(workloadKeyFor('github:alice', 'demo', 'g1')).toBe(
      `w-${sha('github:alice\0demo\0g1').slice(0, 32)}`,
    );
    expect(workloadRecordKey('github:alice', 'demo')).toBe(
      `sh:wl:${sha('github:alice').slice(0, 32)}:demo`,
    );
  });

  it('produces exactly what an attach token accepts as wl and own', () => {
    expect(workloadKeyFor('a', 'b', 'c')).toMatch(ATTACH_WORKLOAD_RE);
    expect(ownerScopeFor('a')).toMatch(ATTACH_OWNER_RE);
  });

  it('separates owner, name and generation, so no two triples collide by concatenation', () => {
    expect(workloadKeyFor('ab', 'c', 'g')).not.toBe(workloadKeyFor('a', 'bc', 'g'));
    expect(workloadKeyFor('a', 'b', 'g1')).not.toBe(workloadKeyFor('a', 'b', 'g2'));
  });
});
