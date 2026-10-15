import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * A client that loses its socket must not take the worker with it.
 *
 * node-redis clients are EventEmitters, and `RedisSocket.#onSocketError` re-emits every socket error
 * on the client -- so with no `'error'` listener an established connection dropping is an uncaught
 * exception and Node exits 1. Probed on the pinned `redis@6.2.1` with `CLIENT KILL` against the
 * probe's own connection: no listener exits on an uncaught `SocketClosedUnexpectedlyError`, one
 * listener handles it and node-redis reconnects by itself.
 *
 * `redis-backend-rearm.test.ts` cannot see this: its mock is a plain object, so nothing ever emits.
 * This mock is a real EventEmitter for exactly that reason.
 *
 * The failure needs no in-flight turn to blame, which is what makes it worse here than it was: the
 * store is memoised for the process's life (run-turn.ts `sharedSessionStore`), so a Redis restart
 * while a worker sits idle is enough.
 */
class FakeClient extends EventEmitter {
  isOpen = false;
  // node-redis sets #isOpen true SYNCHRONOUSLY inside connect() (socket.js:170) and clears it on the
  // terminal give-up (socket.js:154). Modelling that is load-bearing now that `open()` re-arms on
  // !isOpen: a fake that left isOpen false would re-arm on every call, quietly consuming `attempt`'s
  // one-shot rejection and turning the awaited FAILURE this file is about into a second, succeeding
  // connect.
  connect = vi.fn(async () => {
    this.isOpen = true;
    try {
      return await this.attempt();
    } catch (err) {
      this.isOpen = false;
      throw err;
    }
  });
  /** The connect's outcome. Held apart from `connect` so overriding it keeps the isOpen bookkeeping. */
  attempt = vi.fn<() => Promise<void>>(async () => undefined);
  quit = vi.fn(async () => 'OK');
  // The command the probe runs; list() is gone (rossoctl/moca#361) and read() exercises the same
  // open() path.
  xRange = vi.fn(async () => [] as unknown[]);
}

let client: FakeClient;
vi.mock('redis', () => ({ createClient: () => client }));

const { RedisSessionBackend } = await import('../src/redis-backend');

beforeEach(() => {
  client = new FakeClient();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('RedisSessionBackend error listener', () => {
  it('survives an error emitted on an established connection', () => {
    new RedisSessionBackend();

    // The assertion that fails without the listener: EventEmitter.emit('error') with no listener
    // rethrows, which in the real client is an uncaught exception rather than a rejected promise.
    expect(() => client.emit('error', new Error('Socket closed unexpectedly'))).not.toThrow();
    expect(client.listenerCount('error')).toBe(1);
  });

  it('does not swallow the failure a caller is awaiting', async () => {
    client.attempt.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));
    const b = new RedisSessionBackend();

    // The listener is for unawaited EVENTS; a rejected command still reaches its caller.
    await expect(b.read('probe')).rejects.toThrow('connect ETIMEDOUT');
  });
});
