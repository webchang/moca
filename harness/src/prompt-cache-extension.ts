import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

/**
 * Turn Anthropic prompt caching OFF for every model request, opt-in via SH_PROMPT_CACHE=off.
 *
 * pi-ai's Anthropic provider always marks the system prompt and the last user message with
 * `cache_control` (and the last tool, unless the gateway compat flags drop it), and nothing on
 * moca's path sets `cacheRetention: "none"` -- `PI_CACHE_RETENTION` only knows "long". A
 * deployment whose gateway bills cache reads and writes at a rate that is not reproducible (a
 * benchmark that must price every token at a pinned rate) needs requests without any marker.
 *
 * This hooks `before_provider_request`, the payload seam toolChoiceExtension already uses, and
 * deletes `cache_control` from the system blocks, the tools, and the content blocks of every
 * message (one level into a tool_result's own content too). It only touches those top-level
 * keys: a tool's input_schema is never walked, so a schema property that happens to be called
 * `cache_control` survives. It logs, once, how many markers the first request carried.
 * Unset (or any other value), it registers nothing and the request is untouched.
 */
export function promptCacheExtension(): ExtensionFactory {
  return (pi) => {
    if (process.env.SH_PROMPT_CACHE !== 'off') return;
    let logged = false;
    pi.on('before_provider_request', (event: { payload?: unknown }) => {
      const params = event.payload as Record<string, unknown> | undefined;
      if (!params || typeof params !== 'object') return undefined;
      const stripped = stripCacheControl(params);
      if (!logged) {
        logged = true;
        console.error(
          `[prompt-cache] off: removed ${stripped} cache_control marker(s) from the first request`,
        );
      }
      return params;
    });
  };
}

/** Delete every request-level `cache_control` marker in place; returns how many were removed. */
export function stripCacheControl(params: Record<string, unknown>): number {
  let n = 0;
  const strip = (block: unknown) => {
    if (block && typeof block === 'object' && 'cache_control' in block) {
      delete (block as Record<string, unknown>).cache_control;
      n += 1;
    }
  };
  const blocks = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

  blocks(params.system).forEach(strip);
  blocks(params.tools).forEach(strip);
  for (const msg of blocks(params.messages)) {
    if (!msg || typeof msg !== 'object') continue;
    for (const block of blocks((msg as { content?: unknown }).content)) {
      strip(block);
      // A tool_result carries its own content blocks, which the provider may also mark.
      if (block && typeof block === 'object')
        blocks((block as { content?: unknown }).content).forEach(strip);
    }
  }
  return n;
}
