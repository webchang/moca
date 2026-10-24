import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { K8sSandboxConfig } from '../src/config.js';
import type { ExecInPod } from '../src/transport.js';
import { persistentExecInPod } from '../src/persistent-exec.js';
import { runConformance, type TransportFactory } from './conformance.js';

const SOH = '\x01';

const cfg: K8sSandboxConfig = {
  pod: 'sbx-0',
  namespace: 'team1',
  context: undefined,
  podCwd: '/workspace',
  headCwd: '/head',
};

/**
 * Build a persistentExecInPod whose `kubectl exec -- bash` is a scripted fake.
 *
 * The fake stands in for the POD, so it must do what the pod's `head -c <cap+1>` stage
 * does: hand back at most cap+1 raw bytes. That makes this factory's cap behaviour an
 * assumption about the pipeline, not proof of it — which is why the pipeline itself is
 * proved against a real bash in framing.test.ts. Here we hold the CLIENT half to the
 * contract: detect the overflow, trim, mark, and resolve.
 */
const persistentFactory: TransportFactory = (b, opts) => {
  const cap = opts?.outputCapBytes ?? 8 * 1024 * 1024;
  let stdinSeen: Buffer | undefined;
  let capStageSeen = false;
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => child.emit('close', null));
  child.stdin = {
    write: (line: string) => {
      // The pod-side cap is the mechanism here, so its presence in the framed command is
      // the witness the battery asserts against the declared `producer-side-cap`.
      if (line.includes(`| head -c ${cap + 1} |`)) capStageSeen = true;
      // wrapCommand emits: printf '\x01B%s\n' <nonce>; { … } | head -c N | base64; …
      const n = line.match(/printf '\x01B%s\\n' (\S+);/)?.[1] ?? 'n1';
      // stdin rides in a nonce-delimited heredoc, emitted as latin1.
      const hd = line.match(/<<'KAGENTI_EOF_[^']+'\n([\s\S]*?)\nKAGENTI_EOF_/);
      if (hd) stdinSeen = Buffer.from(hd[1], 'latin1');
      if (b.hang) return true;
      // Emit stderr chunks nowhere: this transport does not stream (streams: false).
      const raw = Buffer.from((b.stdout ?? []).join(''));
      const capped = raw.subarray(0, cap + 1); // what `head -c <cap+1>` would yield
      const code = capped.length < raw.length ? 141 : (b.exitCode ?? 0); // 141 = SIGPIPE
      queueMicrotask(() => {
        child.stdout.emit(
          'data',
          Buffer.from(`${SOH}B${n}\n${capped.toString('base64')}\n${SOH}E${n} ${code}\n`),
        );
      });
      return true;
    },
    end: vi.fn(),
  };
  const spawn = (() => child) as any;
  // A fallback that throws: reaching it means the transport treated a cap trip as a dead
  // channel and re-ran the command, which is the specific regression Task 3 guards.
  const fallback: ExecInPod = async () => {
    throw new Error('fallback must not be reached during conformance');
  };
  const transport = persistentExecInPod(cfg, {
    fallback,
    spawn,
    outputCapBytes: opts?.outputCapBytes,
  });
  return {
    transport,
    stdinSeen: () => stdinSeen,
    producerStop: () => (capStageSeen ? 'producer-side-cap' : 'none'),
  };
};

runConformance('persistentExecInPod', persistentFactory, {
  producerStop: 'producer-side-cap',
  streams: false,
  // The only transport that amortizes a burst over ONE shell (#245) — and it makes that
  // claim while declaring `streams: false`, which is exactly why the fast tier serves
  // read/write/edit/ls/find and never bash/grep. Claimed unconditionally, including after
  // capStageBroken latches onto the per-call fallback; see the returned object's comment.
  fastTier: 'persistent-channel',
});
