import { ApiError, classify } from '../api/errors.js';
import { sanitizeRemote } from './sanitize.js';

/**
 * The one sentence a user sees for an error, headless or in the TUI (spec §8.1). Error messages
 * carry server text, so the result is always terminal-safe.
 */
export function describeError(err: unknown): string {
  return sanitizeRemote(describe(err));
}

/**
 * A newer mocactl against a control plane that predates model switching (per-session model spec
 * §7): its router answers the catalog and PATCH routes with a bare 404 `not_found`. A 404
 * `session_not_found` is a real answer about the session, so it is not this.
 */
export const MODEL_SWITCH_UNSUPPORTED = 'this control plane does not support switching models';
export function isModelSwitchUnsupported(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.code !== 'session_not_found';
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    // Reached, then cut: not "cannot reach". Raised for any request or stream body the peer closed,
    // so the text claims nothing about how far the exchange got.
    if (err.code === 'connection_dropped')
      return `the ${err.source === 'harness' ? 'harness' : 'control plane'} closed the connection (a proxy idle timeout?)`;
    const action = classify(err);
    switch (action.kind) {
      case 'login':
        return 'your login has expired — run `mocactl login` (or restart mocactl) to log in again';
      case 'harness-token-rejected':
        return 'the harness rejected the session token — run `mocactl doctor`';
      case 'session-gone':
        return 'that session no longer exists, or is not yours';
      case 'bundle-expired':
        return "this session's config bundle is gone (expired or never uploaded) — promote the same directory again; if it changed, start a new session";
      case 'bundle-quota':
        return "the control plane's config-bundle storage is full for your account or the deployment — free yours with `mocactl bundles delete DIGEST`, or ask the operator";
      case 'endpoint-unresolved':
        return `the inference credential has no gateway endpoint (${action.message}) — edit it in /credentials`;
      case 'operator-misconfigured':
        return `the control plane cannot log anyone in until its operator fixes it — ${action.message}`;
      case 'retry-after':
        return `the harness has no capacity — retry in ${action.seconds}s`;
      case 'unavailable':
        return `the ${action.source === 'harness' ? 'harness' : 'control plane'} is unavailable — try again shortly`;
      case 'connection':
        return `cannot reach the ${action.source === 'harness' ? 'harness' : 'control plane'}: ${action.message}`;
      case 'show':
        return action.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
