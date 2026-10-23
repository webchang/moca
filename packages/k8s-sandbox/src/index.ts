export { k8sSandboxExtension } from './extension.js';
export { resolveConfig, type K8sSandboxConfig } from './config.js';
export { buildKubectlArgs, KubectlTransport, type ExecInPod, type ExecResult } from './exec.js';
export type { SandboxTransport } from './transport.js';
// #452. The ERROR is exported because knative-server maps it to 503 by name and the leaf
// paths classify a turn by it; CAPACITY_REFUSAL because its coupling test must read the
// same regex the transport uses, not a copy of it.
export { CAPACITY_REFUSAL, SandboxCapacityRefusedError } from './transport.js';
export { createCapacityLatch, type CapacityLatch } from './capacity-latch.js';
// Exported for the relay, which must set its ingress limit to the SAME value the Go
// worker uses — see MAX_EXEC_MESSAGE_BYTES on why the two cannot move independently.
export { MAX_EXEC_MESSAGE_BYTES } from './transport.js';
export { buildPersistentKubectlArgs, persistentExecInPod } from './persistent-exec.js';
export {
  buildSelectorArgs,
  buildPodNameArgs,
  resolveSandboxConfig,
  type RunKubectl,
} from './resolve-pod.js';
export { buildPoolPodsArgs, parsePodNames, listPoolPods } from './pool.js';
export { defaultRunKubectl } from './resolve-pod.js';
export { GrpcRelayTransport, type ExecClientLike } from './grpc-relay-transport.js';
export {
  WorkerFrame,
  ServerFrame,
  Hello,
  Exec,
  Abort,
  Chunk,
  End,
  ExecError,
  ExecEvent,
  ExecRequest,
  AbortRequest,
  AbortResponse,
  Stream,
  SandboxWorkerService,
  SandboxExecService,
  SandboxExecClient,
  type SandboxWorkerServer,
  type SandboxExecServer,
} from './gen/sandbox/v1/sandbox.js';
export { SANDBOX_ENV_ALLOW, sandboxEnv } from './sandbox-env.js';
