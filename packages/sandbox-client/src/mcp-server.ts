// The low-level `Server`, not `McpServer`: it takes the tools' JSON Schemas (Pi's, verbatim) as they
// are, so this package needs no zod (its runtime dependencies stay the three of ADR-0042). The SDK
// marks it deprecated only in favour of the zod-based high-level API.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { ExecMachineryError, ExecRefusedError, type Exec } from './exec-conn.js';
import { sandboxTools, ToolInputError, WORKSPACE, type ToolResult } from './tools.js';

/**
 * The sandbox MCP server (SBX0 spec §6.4): the eight tools over one sandbox's Exec. Transport-free:
 * `mocactl sbx mcp` connects it to stdio, the tests to an in-memory pair.
 */

/** One line per tool call for the flight recorder. Never command output. */
export interface CallRecord {
  /** ISO time the call arrived. */
  ts: string;
  tool: string;
  /** Arrival to answer, queueing included. */
  ms: number;
  /** Execs this call made: 1 per tool, 2 for edit, 0 for sandbox_info and any refused call. */
  execs: number;
  /** False for a tool error of any kind, the command's own non-zero exit included. */
  ok: boolean;
  /** One line, set only when the failure was not the command's: never command output. */
  error?: string;
}

export interface SandboxMcpOptions {
  exec: Exec;
  /** `sandbox_info`'s text. Costs no Exec, and is never queued. */
  info: () => Promise<string>;
  /** Called once per call. A recorder that throws never fails the call. */
  record?: (r: CallRecord) => void;
  /** How long a call may wait behind this server's running one before it is refused as busy. */
  busyWaitMs?: number;
  /** Epoch ms; tests only. */
  now?: () => number;
  workspace?: string;
  /** The sandbox's expiresAt (epoch s), named when the sandbox turns out to have expired. */
  expiresAt?: number;
  name?: string;
  version?: string;
}

/** Spec §6.4: the default wait before a call is refused as busy. */
export const DEFAULT_BUSY_WAIT_MS = 30_000;

/**
 * The sandbox rules (spec §6.3), as Markdown: the server's instructions, and the body of the block
 * `sbx up` writes into CLAUDE.md / AGENTS.md. The instructions are what is sure to reach the agent:
 * every MCP client receives them on connecting, while Claude Code does not load a CLAUDE.md that
 * `sbx up`'s own `Read` deny covers (#568).
 */
export const sandboxRules = (ws: string): string =>
  [
    `The code lives in a remote sandbox at \`${ws}\`: use the \`sandbox\` MCP tools for everything.`,
    '',
    '- Every tool call runs in a fresh VM, and no process survives it. Never start background jobs, servers or watchers expecting them to keep running; chain the work into one command instead.',
    `- Files under \`${ws}\` persist between calls; nothing else does.`,
    '- There is no network: packages cannot be installed from the internet.',
    '- Calls run one at a time, so batch the work: read several files in one `bash` call, and run the tests in one call after editing.',
  ].join('\n');

/** The server's instructions for the default workspace. */
export const MCP_INSTRUCTIONS = sandboxRules(WORKSPACE);

/** The tool error texts that are not the command's own (plan 1c R4). */
export const SANDBOX_BUSY_TEXT =
  'sandbox busy: another client of this sandbox has Execs in flight; retry later';
export const TEMPLATE_BUSY_TEXT = 'template busy; retry later';
/** What a failure after the command started adds: it may have changed files (final review M2). */
const MAY_HAVE_RUN = 'the command may have partly run';
export const TOKEN_EXPIRED_TEXT =
  'the sandbox token expired during the command, so the relay cancelled it; this is not your ' +
  `command's output, and ${MAY_HAVE_RUN}. Retry it, split into shorter steps ` +
  'if it is long.';
const CANCELLED = 'cancelled by the client';
const UP = 'run `mocactl sbx up` for a new one';

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const fail = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

/**
 * A terminated sandbox, as the token source reports it: mocactl's `ApiError` with code
 * `sandbox_terminated` (HTTP 409), checked structurally so this package never imports mocactl.
 */
function terminated(err: unknown): 'deleted' | 'expired' | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { code?: unknown; reason?: unknown; message?: unknown };
  if (e.code !== 'sandbox_terminated') return undefined;
  if (e.reason === 'deleted' || e.reason === 'expired') return e.reason;
  // mocactl's ApiError carries the control plane's `reason`; without one (another token source),
  // its message is "sandbox was deleted" or "sandbox has expired".
  return typeof e.message === 'string' && /deleted/.test(e.message) ? 'deleted' : 'expired';
}

/**
 * The one text for an Exec failure that was not the command's outcome (spec §6.4), shared by the
 * MCP server and `mocactl sbx`; undefined for any other error. `audience: 'model'` (the default)
 * adds "not your command's output" to a machinery failure, which a model needs told and a person
 * at a terminal (`'cli'`) does not.
 */
export function execFailureText(
  err: unknown,
  o: { audience?: 'model' | 'cli' } = {},
): string | undefined {
  if (err instanceof ExecMachineryError) {
    switch (err.kind) {
      case 'busy':
        return SANDBOX_BUSY_TEXT;
      case 'template_busy':
        return TEMPLATE_BUSY_TEXT;
      case 'token_expired':
        return TOKEN_EXPIRED_TEXT;
      case 'expiring':
        return err.message; // the sandbox expires in N s; pull your work now
      default: {
        const what =
          o.audience === 'cli' ? 'sandbox failure' : "sandbox failure, not your command's output";
        const ran = err.mayHaveRun ? `; ${MAY_HAVE_RUN}` : '';
        return `${what}: ${err.message.replace(/^sandbox failure: /, '')}${ran}`;
      }
    }
  }
  if (err instanceof ExecRefusedError) {
    return `the sandbox refused the call (${err.message}). If it expired or was deleted, ${UP}.`;
  }
  return undefined;
}

/** The tool error for anything a tool threw: never shown as the command's output. */
function describe(err: unknown, expiresAt?: number): string {
  if (err instanceof ToolInputError) return `invalid input: ${err.message}`;
  const exec = execFailureText(err);
  if (exec !== undefined) return exec;
  const gone = terminated(err);
  if (gone === 'deleted') return `sandbox was deleted; ${UP}`;
  if (gone === 'expired') {
    const on = expiresAt ? ` on ${new Date(expiresAt * 1000).toISOString()}` : '';
    return `sandbox expired${on}; ${UP}`;
  }
  return `sandbox unavailable: ${err instanceof Error ? err.message : String(err)}`;
}

/** What a call acts on, one line, at most 80 characters: the busy message names it. */
function detailOf(tool: string, args: Record<string, unknown>): string {
  const target = tool === 'bash' ? args.command : (args.path ?? args.pattern);
  const raw = tool === 'bash' ? String(target ?? '') : `${tool} ${String(target ?? '')}`;
  const line = oneLine(raw);
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

type Turn = 'go' | 'busy' | 'cancelled';

/**
 * This server's Exec calls, one at a time in arrival order (spec §6.4). The worker serializes them
 * anyway; doing it here is what lets a call that would wait too long be refused unsent, naming the
 * call it would wait behind.
 */
/** @internal Exported for its unit test only. */
export function line(waitMs: number, now: () => number) {
  let running: { detail: string; since: number } | undefined;
  const waiting: Array<{ go: () => void }> = [];

  const take = (detail: string) => {
    running = { detail, since: now() };
  };
  const release = () => {
    running = undefined;
    const next = waiting.shift();
    next?.go();
  };
  const acquire = (detail: string, signal: AbortSignal): Promise<Turn> => {
    // An abort listener never fires for a signal that is already aborted: refuse that call now.
    if (signal.aborted) return Promise.resolve('cancelled');
    if (!running && waiting.length === 0) {
      take(detail);
      return Promise.resolve('go');
    }
    return new Promise<Turn>((resolve) => {
      const leave = (t: Turn) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        const i = waiting.indexOf(me);
        if (i >= 0) waiting.splice(i, 1);
        resolve(t);
      };
      const me = {
        go: () => {
          take(detail);
          leave('go');
        },
      };
      const onAbort = () => leave('cancelled');
      const timer = setTimeout(() => leave('busy'), waitMs);
      signal.addEventListener('abort', onAbort, { once: true });
      waiting.push(me);
    });
  };
  const busy = (): string => {
    const r = running;
    const what = r?.detail || 'a call';
    return `sandbox busy: \`${what}\` has been running for ${elapsed(r ? now() - r.since : 0)}; retry later or wait for it`;
  };
  return { acquire, release, busy };
}

export function createSandboxMcpServer(o: SandboxMcpOptions): Server {
  const ws = o.workspace ?? WORKSPACE;
  const tools = sandboxTools({ info: o.info, workspace: ws });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const now = o.now ?? Date.now;
  const queue = line(o.busyWaitMs ?? DEFAULT_BUSY_WAIT_MS, now);
  const server = new Server(
    { name: o.name ?? 'moca-sandbox', version: o.version ?? '0.0.0' },
    { capabilities: { tools: {} }, instructions: sandboxRules(ws) },
  );
  const listed: Tool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Tool['inputSchema'],
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const started = now();
    let execs = 0;
    const record = (ok: boolean, error?: string) => {
      try {
        o.record?.({
          ts: new Date(started).toISOString(),
          tool: name,
          ms: Math.max(0, now() - started),
          execs,
          ok,
          ...(error !== undefined ? { error: oneLine(error) } : {}),
        });
      } catch {
        // The flight recorder is diagnostics: a full disk must not fail the agent's call.
      }
    };
    // `recorded` is the record's copy when it must differ from what the agent sees.
    const refuse = (text: string, recorded = text): CallToolResult => {
      record(false, recorded);
      return fail(text);
    };

    const tool = byName.get(name);
    if (!tool) return refuse(`unknown tool: ${name}`);
    const counted: Exec = (command, opts) => {
      execs++;
      return o.exec(command, opts);
    };
    const run = async (): Promise<CallToolResult> => {
      try {
        const r: ToolResult = await tool.run(args, counted, extra.signal);
        record(!r.isError);
        return r as CallToolResult;
      } catch (err) {
        // The SDK sends nothing for a cancelled request; the record says why it ended.
        if (extra.signal.aborted) return refuse(CANCELLED);
        return refuse(oneLine(describe(err, o.expiresAt)));
      }
    };

    if (tool.name === 'sandbox_info') return run(); // costs no VM: never queued

    const turn = await queue.acquire(detailOf(tool.name, args), extra.signal);
    // The record leaves out the running call's command text: a command line can hold a secret.
    if (turn === 'busy')
      return refuse(queue.busy(), 'sandbox busy (client-side): waited behind a running call');
    if (turn === 'cancelled') return refuse(CANCELLED);
    try {
      return await run();
    } finally {
      queue.release();
    }
  });

  return server;
}
