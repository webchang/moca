import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promptCacheExtension, stripCacheControl } from '../src/prompt-cache-extension';

type Handler = (e: { payload?: unknown }) => unknown;

// Minimal fake `pi` that captures the before_provider_request handler the extension registers.
function makePi(): { pi: unknown; getHandler: () => Handler | undefined } {
  let handler: Handler | undefined;
  const pi = {
    on: (_event: string, h: Handler) => {
      handler = h;
    },
  };
  return { pi, getHandler: () => handler };
}

const EPHEMERAL = { type: 'ephemeral' };

// The shape pi-ai's Anthropic buildParams produces: a marked system block, a marked last tool,
// and a marked last block of the final user message (here a tool_result with nested content).
function anthropicPayload() {
  return {
    model: 'aws/claude-sonnet-5',
    system: [{ type: 'text', text: 'You are…', cache_control: EPHEMERAL }],
    tools: [
      {
        name: 'read',
        input_schema: { type: 'object', properties: { cache_control: { type: 'string' } } },
      },
      { name: 'bash', input_schema: { type: 'object' }, cache_control: EPHEMERAL },
    ],
    messages: [
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: {} }] },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [{ type: 'text', text: 'ok', cache_control: EPHEMERAL }],
            cache_control: EPHEMERAL,
          },
        ],
      },
    ],
  };
}

describe('promptCacheExtension', () => {
  const saved = process.env.SH_PROMPT_CACHE;
  beforeEach(() => {
    delete process.env.SH_PROMPT_CACHE;
  });
  afterEach(() => {
    saved === undefined
      ? delete process.env.SH_PROMPT_CACHE
      : (process.env.SH_PROMPT_CACHE = saved);
  });

  it('is inert (registers no handler) unless SH_PROMPT_CACHE=off', () => {
    for (const v of [undefined, '', 'on', 'OFF', 'none']) {
      if (v === undefined) delete process.env.SH_PROMPT_CACHE;
      else process.env.SH_PROMPT_CACHE = v;
      const { pi, getHandler } = makePi();
      promptCacheExtension()(pi as never);
      expect(getHandler(), `SH_PROMPT_CACHE=${v}`).toBeUndefined();
    }
  });

  it('removes every cache_control marker from an Anthropic payload', () => {
    process.env.SH_PROMPT_CACHE = 'off';
    const { pi, getHandler } = makePi();
    promptCacheExtension()(pi as never);
    const out = getHandler()!({ payload: anthropicPayload() });
    // The marker's own shape; the schema property `cache_control: {type: "string"}` is kept on purpose.
    expect(JSON.stringify(out)).not.toMatch(/"cache_control":\{"type":"ephemeral"/);
  });

  it('keeps a tool schema property named cache_control', () => {
    const p = anthropicPayload();
    stripCacheControl(p);
    expect(p.tools[0].input_schema.properties).toHaveProperty('cache_control');
  });

  it('counts the markers it removed, and leaves everything else as it was', () => {
    const p = anthropicPayload();
    expect(stripCacheControl(p)).toBe(4); // system, last tool, tool_result, its nested text block
    expect(p.messages[0].content).toBe('fix the bug');
    expect(p.system[0]).toEqual({ type: 'text', text: 'You are…' });
    expect(stripCacheControl(p)).toBe(0);
  });

  it('ignores a payload without messages, system or tools', () => {
    process.env.SH_PROMPT_CACHE = 'off';
    const { pi, getHandler } = makePi();
    promptCacheExtension()(pi as never);
    expect(getHandler()!({ payload: { model: 'm' } })).toEqual({ model: 'm' });
    expect(getHandler()!({})).toBeUndefined();
  });
});
