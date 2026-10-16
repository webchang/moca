import {
  estimateTokens,
  shouldCompact,
  type SettingsManager,
} from '@earendil-works/pi-coding-agent';

type CompactionSettings = ReturnType<SettingsManager['getCompactionSettings']>;

type Msg = Parameters<typeof estimateTokens>[0];

/**
 * Pi checks for compaction after each reply and again inside prompt(), before sending
 * (`_checkCompaction(lastAssistant, false)`), against the current model's window -- but both read
 * the LAST REPLY's reported usage: counted by whichever model produced it (after a switch, the old
 * one), and not consulted at all when that reply predates the latest compaction. On an overflow
 * error pi compacts and retries. After a switch to a smaller model (per-session model spec §5.3)
 * the next request could therefore be sent knowing it cannot fit. This check reads no reply's
 * usage: the loaded history, estimated as pi estimates it (chars/4), against the CURRENT window.
 * It does not depend on a switch having happened, so no "previous window" is stored anywhere.
 */
export function promptWouldOverflow(
  messages: Msg[],
  contextWindow: number | undefined,
  settings: CompactionSettings,
): boolean {
  if (!contextWindow || messages.length === 0) return false;
  const tokens = messages.reduce((n, m) => n + estimateTokens(m), 0);
  return shouldCompact(tokens, contextWindow, settings);
}

export interface CompactableSession {
  messages: Msg[];
  model?: { contextWindow?: number };
  settingsManager: { getCompactionSettings(): CompactionSettings };
  sessionManager: { getBranch(): ReadonlyArray<{ type: string }> };
  compact(): Promise<unknown>;
  abortCompaction(): void;
}

/**
 * Whether compacting now could not help (PR #540 review R12), so it is not attempted, and nothing
 * is logged: a branch whose last entry is already a compaction (pi's compact() throws "Already
 * compacted"), or a window no larger than reserveTokens + keepRecentTokens, which stays over the
 * threshold even after pi's own compaction -- either way every turn would log a failure.
 */
function compactionCannotHelp(session: CompactableSession, settings: CompactionSettings): boolean {
  const window = session.model?.contextWindow ?? 0;
  if (window <= settings.reserveTokens + settings.keepRecentTokens) return true;
  return session.sessionManager.getBranch().at(-1)?.type === 'compaction';
}

/**
 * Compact first when the prompt would not fit. A failure (pi refuses a history too small to cut)
 * is logged and the turn proceeds: pi's own overflow path is still behind it.
 *
 * If signal is provided and already aborted, returns false without compacting. During compaction,
 * if the signal aborts, calls session.abortCompaction() to cancel the operation.
 */
export async function compactIfOverflowing(
  session: CompactableSession,
  signal?: AbortSignal,
): Promise<boolean> {
  const settings = session.settingsManager.getCompactionSettings();
  if (!promptWouldOverflow(session.messages, session.model?.contextWindow, settings)) return false;
  if (compactionCannotHelp(session, settings)) return false;

  // If signal is already aborted, don't attempt compaction
  if (signal?.aborted) return false;

  const abortListener = () => {
    session.abortCompaction();
  };

  try {
    if (signal) {
      signal.addEventListener('abort', abortListener);
    }
    await session.compact();
    return true;
  } catch (err) {
    // A cancelled turn aborts its compaction too: that is not a failure, and the turn does not
    // proceed, so the failure line would mislead on both counts.
    if (signal?.aborted) {
      console.log('[compaction] pre-prompt compaction cancelled');
      return false;
    }
    console.error(
      `[compaction] pre-prompt compaction failed; the turn proceeds: ${(err as Error)?.message ?? String(err)}`,
    );
    return false;
  } finally {
    if (signal) {
      signal.removeEventListener('abort', abortListener);
    }
  }
}
