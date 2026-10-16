import { describe, it, expect } from 'vitest';
import { leafTurnConfig } from '../src/run-leaf.js';
import type { TurnConfig } from '../src/run-turn.js';

describe('leafTurnConfig', () => {
  it('strips sessionModel but keeps other fields', () => {
    const input: TurnConfig = {
      sessionModel: { id: 'x', contextWindow: 100 },
      anthropicBaseUrl: 'https://gateway',
      redisUrl: 'redis://localhost:6379',
      cwd: '/tmp',
      serverMode: true,
      allowLocalTools: false,
    };
    const result = leafTurnConfig(input);
    expect(result?.sessionModel).toBeUndefined();
    expect(result?.anthropicBaseUrl).toBe('https://gateway');
    expect(result?.redisUrl).toBe('redis://localhost:6379');
    expect(result?.cwd).toBe('/tmp');
    expect(result?.serverMode).toBe(true);
    expect(result?.allowLocalTools).toBe(false);
  });

  it('returns undefined when passed undefined', () => {
    expect(leafTurnConfig(undefined)).toBeUndefined();
  });

  it('returns config without sessionModel when sessionModel is absent', () => {
    const input: TurnConfig = {
      anthropicBaseUrl: 'https://gateway',
      serverMode: true,
      allowLocalTools: false,
    };
    const result = leafTurnConfig(input);
    expect(result?.sessionModel).toBeUndefined();
    expect(result?.anthropicBaseUrl).toBe('https://gateway');
  });
});
