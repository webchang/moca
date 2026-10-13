# @moca/k8s-sandbox

> **Deprecated 2026-10-11 ([ADR-0041](../../docs/adrs/0041-deprecate-knative-keda-deployment.md)).**
> The `kubectl exec` sandbox transport (`KubectlTransport`) described here is deprecated: security and
> breakage fixes only, removal no earlier than **end of October 2026**. Sandboxes run through the gRPC
> relay on P6; see [Migrating off the Knative/KEDA deployment](../../docs/migrating-from-knative.md).

Routes Pi tool execution (read/write/edit/bash/ls/grep/find) to a remote
Kubernetes pod via `kubectl exec`, using Pi's native `Operations` seam. Part of
MOCA (Milestone 2). See
[`docs/specs/2026-06-17-m2-k8s-sandbox-client-design.md`](../../docs/specs/2026-06-17-m2-k8s-sandbox-client-design.md).

## Use

`harness/cli.ts` registers `k8sSandboxExtension()`. It is **inert unless
`KAGENTI_SANDBOX_POD` is set**:

| Env var                     | Default         | Meaning                                  |
| --------------------------- | --------------- | ---------------------------------------- |
| `KAGENTI_SANDBOX_POD`       | (unset → off)   | pod to exec into                         |
| `KAGENTI_SANDBOX_NAMESPACE` | `default`       | namespace                                |
| `KAGENTI_SANDBOX_CONTEXT`   | current-context | kube context                             |
| `KAGENTI_SANDBOX_CWD`       | `/workspace`    | pod working dir (announced to the model) |

Apply the fixture pod first: `kubectl apply -f deploy/sandbox.yaml`.
See `SMOKE.md` for the end-to-end runbook.

## Notes

- No pi-fork change: the `Operations` seam is native. The one exception is
  `grep`, whose search hardwires a local `rg`; its tool gets an `execute`
  override (`grep-tool.ts`). See `NOTES-pi-operations.md`.
- `find` honours basename globs only (no .gitignore/ignore list) — an M2
  simplification vs Pi's local `fd`.
- Per-op `kubectl exec` latency is acceptable for M2 (not the perf milestone);
  a persistent in-pod channel is the M3 upgrade path.
