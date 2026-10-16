import { describe, expect, it } from 'vitest';
import { MODEL_ID_RE, sanitizeLimits } from '../src/models.js';
import { CP_ERROR_CODES, statusFor } from '../src/errors.js';

describe('MODEL_ID_RE', () => {
  it.each([
    'claude-opus-4-8',
    'meta-llama/Llama-3.1-8B-Instruct',
    'bedrock/anthropic.claude-3:0',
    'granite-4.1-8b',
  ])('accepts %s', (id) => expect(MODEL_ID_RE.test(id)).toBe(true));

  it.each(['', 'has space', 'tab\there', 'x'.repeat(257), 'naïve'])('refuses %j', (id) =>
    expect(MODEL_ID_RE.test(id)).toBe(false),
  );
});

describe('sanitizeLimits', () => {
  it('keeps known fields of the right type and drops the rest', () => {
    expect(
      sanitizeLimits({
        contextWindow: 200000,
        maxTokens: 32000,
        reasoning: true,
        vision: false,
        cost: 3,
      }),
    ).toEqual({ contextWindow: 200000, maxTokens: 32000, reasoning: true, vision: false });
  });

  it('drops non-positive and non-integer numbers, and wrongly typed booleans', () => {
    expect(sanitizeLimits({ contextWindow: -1, maxTokens: 1.5, reasoning: 'yes' })).toBeUndefined();
  });

  // PR #540 review R9: a bogus gateway limit must not reach every request's max_tokens.
  it('drops a context window above 10M', () => {
    expect(sanitizeLimits({ contextWindow: 1e300, reasoning: true })).toEqual({ reasoning: true });
    expect(sanitizeLimits({ contextWindow: 10_000_001 })).toBeUndefined();
    expect(sanitizeLimits({ contextWindow: 10_000_000 })).toEqual({ contextWindow: 10_000_000 });
  });

  it('clamps maxTokens down to the context window when both are present', () => {
    expect(sanitizeLimits({ contextWindow: 8000, maxTokens: 32000 })).toEqual({
      contextWindow: 8000,
      maxTokens: 8000,
    });
    expect(sanitizeLimits({ maxTokens: 32000 })).toEqual({ maxTokens: 32000 });
    // A dropped window leaves maxTokens unclamped: there is nothing left to clamp it to.
    expect(sanitizeLimits({ contextWindow: 2e7, maxTokens: 64000 })).toEqual({ maxTokens: 64000 });
  });

  it('is undefined for anything that is not an object', () => {
    expect(sanitizeLimits(null)).toBeUndefined();
    expect(sanitizeLimits('x')).toBeUndefined();
    expect(sanitizeLimits([1])).toBeUndefined();
  });
});

describe('model error codes', () => {
  it('are in the taxonomy with their statuses', () => {
    expect(CP_ERROR_CODES).toContain('model_unavailable');
    expect(CP_ERROR_CODES).toContain('model_catalog_unavailable');
    expect(statusFor('model_unavailable')).toBe(400);
    expect(statusFor('model_catalog_unavailable')).toBe(503);
  });
});
