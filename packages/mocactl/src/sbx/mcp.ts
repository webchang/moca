import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createSandboxMcpServer, type Exec } from '@moca/sandbox-client';
import { VERSION } from '../version.js';
import type { SbxCtx } from './commands.js';
import { openExec, type ExecFactory, type OpenedExec } from './exec.js';
import { recordCall } from './recorder.js';

/**
 * The stdio transport, closed when stdin ends: the SDK's own one only stops on a read error, so a
 * client that just closes the pipe would leave the server (and its gRPC channel) running.
 */
export async function stdioTransport(): Promise<Transport> {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const t = new StdioServerTransport();
  const end = () => void t.close().catch(() => {});
  process.stdin.once('end', end);
  process.stdin.once('close', end);
  return t;
}

/**
 * `mocactl sbx mcp` (SBX0 §6.4): the sandbox MCP server bound to one sandbox, on the given transport
 * (stdio in production). Resolves when the transport closes or `c.signal` aborts. Writes nothing to
 * stdout itself.
 *
 * The sandbox is looked up first, so a wrong id fails at start. The Exec connection opens at the
 * first call, so a sandbox that has expired or was deleted still serves, and every call says so
 * ("sandbox expired on …; run `mocactl sbx up`") instead of the server failing to start.
 */
export async function serveSbxMcp(
  c: SbxCtx,
  id: string,
  transport: Transport,
  factory?: ExecFactory,
): Promise<void> {
  const s = await c.api.getSandbox(id);
  let conn: Promise<OpenedExec> | undefined;
  const open = () =>
    (conn ??= openExec(c.api, id, factory, { sandboxExpiresAt: s.expiresAt }).catch(
      (err: unknown) => {
        conn = undefined; // the next call asks again; this one fails as it is
        throw err;
      },
    ));
  const exec: Exec = async (command, opts) => (await open()).exec(command, opts);
  const info = async () => {
    const now = await c.api.getSandbox(id);
    return (
      `Sandbox ${now.id}${now.name ? ` (${now.name})` : ''}: template ${now.template}, ${now.state}, expires ` +
      `${new Date(now.expiresAt * 1000).toISOString()}. Files live under /workspace and persist; every call is a ` +
      'fresh VM, so no process survives it; there is no network; calls run one at a time.'
    );
  };
  const server = createSandboxMcpServer({
    exec,
    info,
    record: (r) => recordCall(c.rt.paths.stateDir, id, r),
    expiresAt: s.expiresAt,
    version: VERSION,
  });
  const stop = () => void server.close().catch(() => {});
  try {
    await new Promise<void>((resolve, reject) => {
      // Protocol.onclose is the SDK's own close hook; the transport's callbacks belong to the SDK.
      server.onclose = () => resolve();
      server.connect(transport).catch(reject);
      if (c.signal?.aborted) stop();
      else c.signal?.addEventListener('abort', stop, { once: true });
    });
  } finally {
    c.signal?.removeEventListener('abort', stop);
    if (conn) (await conn.catch(() => undefined))?.close();
  }
}
