import type { SessionManager } from '@earendil-works/pi-coding-agent';

/**
 * Record a mid-session model switch in the persisted pi session (per-session model spec §5.3, PR
 * #540 review R11). pi's createAgentSession appends a `model_change` only for a NEW session; after a
 * PATCH the transcript and tree -- and anything reading `buildSessionContext().model` -- went on
 * naming the first model. Resumption never depended on it (the model is always passed explicitly),
 * so this is the record, not the switch.
 *
 * "Last recorded" is what pi itself reconstructs: the latest model_change or assistant reply on the
 * branch. A new session (no messages) is left to pi, and so is one whose tail names no model. Uses
 * only SessionManager's public API (buildSessionContext, appendModelChange).
 */
export function recordModelSwitch(
  sessionManager: Pick<SessionManager, 'buildSessionContext' | 'appendModelChange'>,
  model: { provider: string; id: string },
): boolean {
  const ctx = sessionManager.buildSessionContext();
  if (ctx.messages.length === 0 || !ctx.model) return false;
  if (ctx.model.provider === model.provider && ctx.model.modelId === model.id) return false;
  sessionManager.appendModelChange(model.provider, model.id);
  return true;
}
