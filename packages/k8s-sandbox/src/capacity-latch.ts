import { SandboxCapacityRefusedError, type SandboxTransport } from './transport.js';

/**
 * Carries a mid-turn capacity refusal out of a Pi session (#452).
 *
 * WHY A LATCH AND NOT A THROW. A transport that rejects cannot end a turn by itself.
 * `createPodBashOps` passes the rejection to Pi's bash tool, which bare-rethrows
 * anything that is not `aborted`/`timeout:`; Pi's agent loop catches a tool throw,
 * converts it to `isError: true` tool content, and CONTINUES. So the throw is consumed
 * two frames below the turn, `session.prompt()` returns normally with
 * `stopReason: 'end_turn'`, and the model has meanwhile read the host's admission-control
 * arithmetic as its command's output. Nothing above can see what happened.
 *
 * A latch is the seam that survives that: the transport records, the tool_call hook stops
 * the loop spending more turns on a sandbox that is refusing work, and the caller rethrows
 * after `prompt()` returns, where a throw does propagate.
 *
 * ONE LATCH PER TURN, created by the caller. Deliberately not module state: a replica
 * runs many turns concurrently against different sandboxes, and a shared flag would fail
 * one session's turn because a different session's host was full.
 */
export interface CapacityLatch {
  /** Wrap a transport so a capacity refusal is recorded on its way past. */
  watch(transport: SandboxTransport): SandboxTransport;
  /** The refusal, if one was seen. */
  refusal(): SandboxCapacityRefusedError | undefined;
  /**
   * Rethrow the refusal if there was one. Call AFTER `session.prompt()` resolves — that
   * is the first point in the stack where a throw is not swallowed by the agent loop.
   */
  throwIfRefused(): void;
}

export function createCapacityLatch(): CapacityLatch {
  // FIRST refusal wins, not the last. A blocked tool_call still lets the model answer in
  // prose, and the turn can make further exec attempts before it winds down; the first
  // one is the one whose message describes the host at the moment it ran out.
  let seen: SandboxCapacityRefusedError | undefined;

  return {
    watch: (transport) => ({
      // FORWARDED. This is a pass-through wrapper, and `extension.ts` wraps both tiers in
      // it — so hardcoding either value here would make every latched transport claim the
      // same tier and silently contradict the thing it wraps (#245). On a harness turn
      // this wrapper IS the object a caller reads the tier off, so the forwarding is
      // asserted for every transport by test/conformance.ts, not taken on trust: the
      // per-transport assertion beside it reads the UNWRAPPED object and cannot see a
      // wrapper that answers for what it wraps.
      fastTier: transport.fastTier,
      exec: async (command, opts) => {
        try {
          return await transport.exec(command, opts);
        } catch (err) {
          if (err instanceof SandboxCapacityRefusedError && !seen) seen = err;
          // RETHROWN, always. The latch observes; it does not change what the tool sees.
          // Swallowing here would hand the model an empty success for a command that never
          // ran, which is worse than the error text this exists to suppress.
          throw err;
        }
      },
      close: () => transport.close(),
    }),
    refusal: () => seen,
    throwIfRefused: () => {
      if (seen) throw seen;
    },
  };
}
