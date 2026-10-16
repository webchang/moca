import { describe, expect, it } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { recordModelSwitch } from '../src/model-switch-record';

// PR #540 review R11: pi's createAgentSession appends a model_change only for a new session, so a
// PATCH mid-session left the transcript and buildSessionContext().model naming the first model.
const reply = (provider: string, model: string) =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    provider,
    model,
    api: 'anthropic-messages',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: 'stop',
    timestamp: 0,
  }) as never;

function sessionOn(provider: string, model: string) {
  const sm = SessionManager.inMemory();
  sm.appendModelChange(provider, model);
  sm.appendMessage({ role: 'user', content: 'hi', timestamp: 0 } as never);
  sm.appendMessage(reply(provider, model));
  return sm;
}

const modelChanges = (sm: SessionManager) =>
  sm.getBranch().filter((e) => e.type === 'model_change');

describe('recordModelSwitch', () => {
  it('appends a model_change when the turn runs on another model than the last recorded', () => {
    const sm = sessionOn('anthropic', 'claude-opus-4-8');
    expect(recordModelSwitch(sm, { provider: 'litellm', id: 'granite-4.1-8b' })).toBe(true);
    expect(modelChanges(sm)).toHaveLength(2);
    expect(sm.getBranch().at(-1)).toMatchObject({
      type: 'model_change',
      provider: 'litellm',
      modelId: 'granite-4.1-8b',
    });
    expect(sm.buildSessionContext().model).toEqual({
      provider: 'litellm',
      modelId: 'granite-4.1-8b',
    });
  });

  it('records nothing when the model is unchanged', () => {
    const sm = sessionOn('anthropic', 'claude-opus-4-8');
    expect(recordModelSwitch(sm, { provider: 'anthropic', id: 'claude-opus-4-8' })).toBe(false);
    expect(modelChanges(sm)).toHaveLength(1);
  });

  it('records nothing twice: the second turn on the new model sees the first record', () => {
    const sm = sessionOn('anthropic', 'claude-opus-4-8');
    recordModelSwitch(sm, { provider: 'anthropic', id: 'claude-haiku-4-5' });
    expect(recordModelSwitch(sm, { provider: 'anthropic', id: 'claude-haiku-4-5' })).toBe(false);
    expect(modelChanges(sm)).toHaveLength(2);
  });

  it('compares the provider too', () => {
    const sm = sessionOn('anthropic', 'claude-opus-4-8');
    expect(recordModelSwitch(sm, { provider: 'litellm', id: 'claude-opus-4-8' })).toBe(true);
  });

  it('leaves a new session to pi, which records its first model itself', () => {
    const sm = SessionManager.inMemory();
    expect(recordModelSwitch(sm, { provider: 'anthropic', id: 'claude-opus-4-8' })).toBe(false);
    expect(modelChanges(sm)).toHaveLength(0);
  });
});
