import {
  createBashTool,
  createEditTool,
  createFindTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  type ExtensionAPI,
  type ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import { type K8sSandboxConfig, resolveConfig } from './config.js';
import { KubectlTransport } from './exec.js';
import type { CapacityLatch } from './capacity-latch.js';
import type { SandboxTransport } from './transport.js';
import { persistentExecInPod } from './persistent-exec.js';
import {
  createPodBashOps,
  createPodEditOps,
  createPodFindOps,
  createPodLsOps,
  createPodReadOps,
  createPodWriteOps,
} from './operations.js';
import { createPodGrepTool } from './grep-tool.js';

/**
 * The tools this extension overrides, and so the only ones a host capacity refusal says
 * anything about (#452).
 *
 * The latch's `tool_call` block is scoped to these BY NAME because an extension's
 * `tool_call` handler sees every tool in the session, not just the ones it registered.
 * A harness turn also carries tools that never cross the sandbox seam —
 * `submit_verdict` and `request_approval` on a verdict leaf — and blocking those is
 * actively harmful: a verdict the model can still reach IS the leaf's result
 * (`run-leaf.ts`, where `throwIfRefused()` deliberately fires only when nothing was
 * captured), so blocking the submit would discard finished reasoning and make the run
 * retry work it had already completed.
 *
 * Kept in sync with the `registerTool` calls below by
 * `test/extension.test.ts`, which asserts the set matches what the extension registers
 * rather than trusting this list.
 */
const SANDBOX_TOOLS = new Set(['read', 'write', 'edit', 'ls', 'find', 'bash', 'grep']);

/**
 * Pi extension that overrides the seven built-in tools so file/search/exec run
 * in a remote Kubernetes pod. Inert (local tools stand) unless a sandbox is
 * configured.
 *
 * Two-tier transport:
 *  - fastTransport: a persistent in-pod bash channel for the small request/response
 *    ops (read/write/edit/ls/find), with transparent fallback to per-call exec.
 *  - streamTransport: per-call `kubectl exec` for the streaming/long-running ops
 *    (bash, grep, user `!`), which need onData/abort/long-running semantics.
 *
 * @param opts.config    Explicit config; if omitted, resolved from process.env.
 *                       Pass `null` to force-disable.
 * @param opts.transport Override BOTH tiers. The shorthand, and what every caller used
 *                       before #245 — which is exactly the problem it now documents: a
 *                       caller passing a per-call transport here (`run-leaf.ts`, with a
 *                       leased `GrpcRelayTransport`) silently gives up the fast tier for
 *                       every file op. Prefer the two below when the tiers differ.
 * @param opts.fastTransport   Override the FAST tier only (read/write/edit/ls/find).
 *                             Falls back to `transport`, then to `persistentExecInPod`.
 * @param opts.streamTransport Override the STREAM tier only (bash, grep, user `!`).
 *                             Falls back to `transport`, then to `KubectlTransport`.
 * @param opts.capacity  A per-turn CapacityLatch. When given, a host's capacity refusal
 *                       ends the turn instead of being narrated to the model (#452); the
 *                       caller rethrows it after `session.prompt()` returns. Omitted
 *                       (every caller that is not a harness turn) keeps today's
 *                       behaviour exactly.
 */
export function k8sSandboxExtension(opts?: {
  config?: K8sSandboxConfig | null;
  transport?: SandboxTransport;
  fastTransport?: SandboxTransport;
  streamTransport?: SandboxTransport;
  capacity?: CapacityLatch;
}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const localCwd = process.cwd();
    const config = opts?.config !== undefined ? opts.config : resolveConfig(process.env, localCwd);
    if (!config) return; // off gate — local tools stand

    // THE TWO TIERS ARE RESOLVED SEPARATELY (#245), each falling through the same three
    // steps: its own override, then the both-tiers shorthand, then this tier's default.
    //
    // `transport` used to be the only knob and it meant BOTH, which made the two-tier
    // design silently conditional on which caller you were: `run-leaf.ts` passes a leased
    // GrpcRelayTransport for the gRPC path, so on that path `fastTransport` became a
    // per-call transport and every read/write/edit/ls/find paid a full relay round trip
    // ending in a fresh `bash -c`, where the kubectl path spent one framed line on an
    // already-running bash. Keeping the shorthand is deliberate — overriding both is the
    // right thing for a test, and for a caller whose sandbox genuinely has one channel —
    // but a caller that can do better now has somewhere to say so.
    //
    // ORDER MATTERS: the specific override wins over the shorthand, so passing both
    // `transport` and `fastTransport` is "both tiers go there, except the fast one".
    // The reverse precedence would make the specific knob unreachable whenever the
    // shorthand was also set, which is every existing caller.
    //
    // WRAPPED HERE, once, around the two transports every tool below draws from — rather
    // than at each of the seven registerTool sites. #452 arrives on bash most often, but
    // read/write/edit/ls/find/grep all cross the same seam and a refusal on any of them
    // is the same host condition.
    const watch = opts?.capacity ? opts.capacity.watch : (t: SandboxTransport) => t;
    // Resolved BEFORE wrapping, and kept, because `watch` allocates a fresh wrapper per
    // call: with a latch supplied, `fastTransport !== streamTransport` even when both
    // resolve to the one object the `transport` shorthand named. Only these pre-wrap
    // values can answer "is there really one channel here?", which session_shutdown needs.
    const streamBase = opts?.streamTransport ?? opts?.transport ?? KubectlTransport(config);
    const fastBase =
      opts?.fastTransport ??
      opts?.transport ??
      persistentExecInPod(config, { fallback: KubectlTransport(config).exec });
    const streamTransport = watch(streamBase);
    const fastTransport = watch(fastBase);

    // Fast request/response ops → persistent channel.
    pi.registerTool(
      createReadTool(localCwd, { operations: createPodReadOps(fastTransport.exec, config) }),
    );
    pi.registerTool(
      createWriteTool(localCwd, { operations: createPodWriteOps(fastTransport.exec, config) }),
    );
    pi.registerTool(
      createEditTool(localCwd, { operations: createPodEditOps(fastTransport.exec, config) }),
    );
    pi.registerTool(
      createLsTool(localCwd, { operations: createPodLsOps(fastTransport.exec, config) }),
    );
    pi.registerTool(
      createFindTool(localCwd, { operations: createPodFindOps(fastTransport.exec, config) }),
    );

    // Streaming / long-running ops → per-call kubectl exec.
    pi.registerTool(
      createBashTool(localCwd, { operations: createPodBashOps(streamTransport.exec, config) }),
    );
    pi.registerTool(createPodGrepTool(localCwd, streamTransport.exec, config));
    pi.on('user_bash', () => ({ operations: createPodBashOps(streamTransport.exec, config) }));

    // STOP SPENDING THE TURN ON A HOST THAT IS REFUSING WORK (#452).
    //
    // Registered only when a latch was supplied, so the handler count every other caller
    // sees is unchanged. `tool_call`'s `{block, reason}` is the ONLY loop-control result
    // Pi offers an extension — `tool_result` carries just `{content, details, isError}`,
    // with no way to terminate — and blocking is advisory: the model still gets a turn to
    // answer in prose. That is why the latch is also read by the caller after
    // `session.prompt()` resolves. This hook is not the fix; it stops the model from
    // retrying a doomed exec a dozen times first, which is what made the original report
    // read as a hang rather than an error.
    if (opts?.capacity) {
      const latch = opts.capacity;
      pi.on('tool_call', (event) => {
        if (!SANDBOX_TOOLS.has(event.toolName)) return {};
        const refusal = latch.refusal();
        if (!refusal) return {};
        // The reason goes to the MODEL, so it says what to do, not what the arithmetic
        // was. The operator-facing numbers travel in the rethrown error's message.
        return { block: true, reason: 'The sandbox host is at capacity; this turn is ending.' };
      });
    }

    // Tell the model its cwd is the pod's, not the head's.
    pi.on('before_agent_start', (event) => {
      const modified = event.systemPrompt.replace(
        `Current working directory: ${localCwd}`,
        `Current working directory: ${config.podCwd} (sandbox pod ${config.namespace}/${config.pod})`,
      );
      return { systemPrompt: modified };
    });

    // Tear down the persistent kubectl process so it is never leaked.
    //
    // BOTH TIERS, and that is new with #245. Closing the fast tier alone was sufficient
    // while the stream tier was either the SAME OBJECT (the `transport` shorthand) or a
    // `KubectlTransport`, whose close() is a documented no-op. Now that the two can be
    // given independently, a caller passing a `streamTransport` that owns something — a
    // GrpcRelayTransport owns its gRPC channel — would have leaked it once per session.
    //
    // Guarded on the PRE-WRAP identity rather than relying on idempotency: close() is
    // contractually idempotent, so a double close is safe, but the shorthand makes these
    // one object on every existing caller and closing it twice there is pointless work on
    // a path that runs for every session.
    pi.on('session_shutdown', async () => {
      await fastTransport.close();
      if (streamBase !== fastBase) await streamTransport.close();
    });
  };
}
