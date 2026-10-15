# Migrating off the Knative/KEDA deployment

> **Deprecated 2026-10-11.** The Knative + KEDA deployment path — the Knative Service, KEDA
> ScaledJobs, `KubectlTransport` and pod-exec sandboxes under `deploy/knative/` — is deprecated
> ([ADR-0041](adrs/0041-deprecate-knative-keda-deployment.md)). P6, the process-manager runtime,
> is the primary way to run MOCA sessions. During the window the old path receives security and
> breakage fixes only, and no new features. Removal comes no earlier than **end of October
> 2026**, and only once its remaining users have migrated — if that is you, say so in the
> [tracking issue](https://github.com/rossoctl/moca/issues/490) so the date can account for
> you.

## What is deprecated — and what is not

Deprecated, per [ADR-0037](adrs/0037-p6-on-kubernetes-substrate.md)'s scope — a deployment model,
not a substrate:

- the Knative Service and its revision/activator machinery (`deploy/knative/service.yaml`,
  `setup-kind.sh`, `setup-ocp.sh`);
- KEDA ScaledJobs (`deploy/knative/leaf-scaledjob.yaml`) and the `leaf-job.ts` entrypoint that
  drains them;
- `KubectlTransport` and pod-exec sandboxes — the K8s-specific half of `packages/k8s-sandbox`;
- the manifests, overlays, smoke scripts and OCP image build under `deploy/knative/`.

**Not** deprecated:

- **Kubernetes as a substrate.** [`deploy/k8s/`](../deploy/k8s/README.md) runs the P6 process model
  as ordinary Kubernetes workloads and is maintained as a first-class deployment (ADR-0037). If
  you want to stay on a cluster, that is your destination, not a compromise.
- **Containers as a sandbox technology.** The container sandbox tier (`remote-worker/cmd/worker`)
  is substrate-agnostic and stays; the per-`Exec` microVM tier
  ([ADR-0035](adrs/0035-per-exec-microvm-warm-standby.md)) is its stronger sibling.
- **The shared harness code.** `packages/knative-server`'s name is historical — its `worker.ts` is
  the process the P6 supervisor forks, and the non-K8s half of `packages/k8s-sandbox` carries the
  transport P6 runs on. The packages stay; only their K8s-specific halves are deprecated.

## Pick a destination

| You want...                                        | Go to                                            | Notes                                                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| To stay on Kubernetes or OpenShift                 | [`deploy/k8s/`](../deploy/k8s/README.md)         | P6 on Kubernetes (P6.1, epic #426). Namespaces and NetworkPolicy replace podman isolation — a NetworkPolicy-enforcing CNI is a hard requirement. Kind and OCP overlays ship (`setup.sh`). |
| A dedicated VM or bare metal — the production path | [`deploy/vm/`](../deploy/vm/README.md)           | `setup-vm.sh`, systemd units, podman `isolate=strict` + nftables. Carries the hardening, reboot handling and E8 run discipline.                                                           |
| To try P6 in five minutes, no root                 | [`deploy/compose/`](../deploy/compose/README.md) | The trial path — the supervisor, relay, Redis and a sandbox under Docker Compose, optionally with the MU1 control plane. Same processes, same wire; not for production.                   |

All three run the same processes, the same environment and the same wire. Only the process
manager, the addressing and the way isolation is enforced differ.

## What maps to what

| Knative path                                                       | P6 path                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Knative Service: scale-to-zero HTTP endpoint, activator cold-start | Supervisor: L4-only ingress, socket hand-off to a fixed worker pool ([ADR-0034](adrs/0034-vm-process-manager-socket-handoff.md)). Workers are warm — there is no cold-start term in the ceiling.                                                    |
| KEDA ScaledJob: `leaf-worker` pods 0→N on queue depth              | Supervisor-managed workers: many sessions per worker, a bounded number of concurrent in-flight turns each, admission control instead of autoscaling.                                                                                                |
| Pod-exec sandboxes via `kubectl` (`KubectlTransport`)              | `remote-worker` sandboxes — container tier, or per-`Exec` microVM tier ([ADR-0035](adrs/0035-per-exec-microvm-warm-standby.md)) — dialed in over the gRPC relay. The sandbox dials out; it needs no inbound route.                                  |
| Kourier / Route ingress                                            | L4 only. Any L7 hop that pools upstream connections silently defeats the supervisor's per-connection hand-off (ADR-0037 §3). On OpenShift, TLS terminates in a sidecar behind a passthrough Route.                                                  |
| Scale-to-zero between turns                                        | Warm process-manager pods. Idle capacity costs memory continuously; in exchange there is no activator cold-start and no Knative/KEDA operators to run or upgrade.                                                                                   |
| `async: true` leaf fan-out, drained by KEDA `leaf-worker` pods     | **No P6 equivalent yet.** The P6 runtime serves turns; async leaf dispatch is an owed follow-up (see [If you depend on async fan-out or the CronJob](#if-you-depend-on-async-fan-out-or-the-cronjob)).                                              |
| CronJob scheduled on-ramp (`cron-dispatch`, Archetype C)           | **No P6 equivalent yet.** The VM spec names a supervisor timer over `cron-dispatch` as the intended replacement, but scheduled dispatch on P6 is out of scope for round one ([P6 spec](specs/2026-09-08-p6-vm-process-manager-design.md) §2.2, §8). |

## Scaling the P6 runtime

The scaling model replaces autoscaling with two levers:

- **Horizontal — add process-manager pods.** Sessions are Redis-backed, so any supervisor can
  serve any session, subject to sandbox affinity: P6.3 keeps a session on the sandbox that served
  its previous turn, waiting out a grace period before a recorded in-tier fallback. Add PM pods
  the way you would add replicas.
- **Vertical — size process-manager pods up.** More workers per supervisor, more memory. The
  supervisor hands accepted sockets to workers and never touches a response byte (ADR-0034), so
  its own ceiling is admission and hand-off, not payload throughput; the density number belongs to
  the worker pool.

What you lose: scale-to-zero. What you gain: no Knative or KEDA operators, no activator cold-start
term in the latency ceiling (E9 measured what the deployment tier was costing), and warm sessions
between turns.

## What carries over

- **Session transcripts.** Both paths persist sessions through `@moca/session-backend` in Redis
  with the same schema. Point the P6 deployment at the same Redis and sessions resume —
  rehydration is a constant ~6 entries / ~900 bytes per session regardless of length (E2).
- **Credentials and promoted config bundles.** Owned by the MU1 control plane, which runs on both
  paths. On Kubernetes it keeps using `K8sSecretStore` — that is the substrate, not the deprecated
  path; off Kubernetes it uses the non-K8s `CredentialStore` (#348).
- **What does not carry: sandbox filesystems.** Pod-exec sandboxes and P6 sandboxes are different
  instances. After cutover a session's next turn re-derives its workspace — the tree is a detached
  worktree at a pinned commit and continuity lives in the Redis session log, so this costs a
  fetch, not data.

## If you depend on async fan-out or the CronJob

Archetype A (`async: true` fan-out drained by KEDA `leaf-worker` pods) and Archetype C (the
CronJob scheduled on-ramp) run only on the deprecated path today. What the repo states:

- [ADR-0041](adrs/0041-deprecate-knative-keda-deployment.md) lists both as having **no P6
  equivalent yet**, and the [P6 spec](specs/2026-09-08-p6-vm-process-manager-design.md) puts async
  leaf and cron on the VM out of scope for round one. The supervisor's `--role` flag exists; the
  experiment that would use it does not.
- No design, interim workaround or tracking issue for either is referenced in ADR-0034 or
  ADR-0041. This guide does not invent one.

What that means for you:

- **Stay on the deprecated path for those workloads** until a P6 equivalent is announced, and say
  so in the [migration tracking issue](https://github.com/rossoctl/moca/issues/490): removal waits for
  remaining users to migrate, and a dependency on A or C is exactly the case that moves the date.
- **Interactive turns can move first.** The two deployments share only Redis and the session
  schema is the same, so running P6 for `/turn` traffic while async and cron stay on Knative is the
  intended shape of "bring the P6 side up in parallel" in [Bring-up](#bring-up) below. The repo's smoke tests do not
  exercise this mixed setup _(unverified)_; canary it before relying on it.
- Archetype B (human gate) and sync `/turn` and `/runs` are not affected.

## Configuration: what changes

Only variables verified in the shipped manifests and env templates are listed. For anything not
listed, the destination README is authoritative (`deploy/vm/env/*.env.example`, `deploy/k8s/`,
`deploy/compose/`).

| Knative path (`deploy/knative/service.yaml`)                                                   | P6 path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `REDIS_URL`                                                                                    | Unchanged (`supervisor.env.example`: "inherited unchanged"). Point it at the same Redis to keep sessions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `KAGENTI_SANDBOX_POD`                                                                          | Not used by the supervisor template. Sandboxes are discovered from relay records: `SH_SANDBOX_DISCOVERY=records` and `SH_REMOTE_SANDBOX=1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `KAGENTI_SANDBOX_POOL_SELECTOR`                                                                | Still present in the supervisor template (`app=sandbox`), together with `KAGENTI_SANDBOX_CAP`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SH_REQUIRE_AUTH`, `SH_EXCHANGE_TOKEN`, `SH_SESSION_TOKEN_PUBLIC_KEYS`, `SH_CONTROL_PLANE_URL` | Same names, mostly not set by hand on a VM. `setup-vm.sh` generates the secrets (`SH_SESSION_TOKEN_PRIVATE_KEY`, `SH_CREDENTIAL_KEK`, `SH_EXCHANGE_TOKEN`) as systemd credentials, writes `SH_SESSION_TOKEN_PUBLIC_KEYS` into `supervisor.env`, and the template presets `SH_CONTROL_PLANE_URL=http://127.0.0.1:8090`. Setting a credential in an env file as well makes its consumer refuse to boot: the control plane for its own env file, the workers for `SH_EXCHANGE_TOKEN` in `supervisor.env`.                                                                                                                                                                                                       |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`                              | Inference credentials are per user, issued by the control plane. To keep an operator-wide key, opt in with `SH_ALLOW_OPERATOR_FALLBACK=true`. The key itself is never an env line: it becomes the `operator-inference-token` credential file (`SH_OPERATOR_INFERENCE_TOKEN`, mode 0600, loaded via `LoadCredential=`). An Anthropic API key also needs `SH_DEFAULT_INFERENCE_ENDPOINT=https://api.anthropic.com` and `SH_OPERATOR_INFERENCE_HEADER=x-api-key`, or the control plane refuses to boot. `ANTHROPIC_BASE_URL` has no single equivalent: it maps to `SH_DEFAULT_INFERENCE_ENDPOINT` for the fallback and to per-user endpoints otherwise. See `deploy/vm/README.md`, "The operator-key fallback". |
| `LEAF_RESULT_TTL_SECONDS`                                                                      | Read only by the async entrypoints (`server.ts`, `leaf-job.ts`); no P6 counterpart while async has no P6 equivalent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SH_MODEL`, `SH_MODEL_PROVIDER`                                                                | Same names, set on the supervisor (`harness/src/run-turn.ts` reads `config?.model ?? env.SH_MODEL`); a session's config bundle overrides them. Compose passes them to the supervisor.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| _(none)_                                                                                       | New on VM. Required in `supervisor.env`: `SH_TURNS_PER_WORKER` (no default) and `SH_RELAY_ADDR`. Required in `relay.env`: `SH_RELAY_TOKEN`, which must match each sandbox worker's `SANDBOX_TOKEN`. `MOCA_RELAY_EXEC_TOKEN` is also required but `setup-vm.sh` generates it into both `relay.env` and `supervisor.env`, so you do not set it. Required in `control-plane.env`: `SH_GITHUB_CLIENT_ID` and `SH_PUBLIC_HARNESS_URL`. Optional: `SH_WORKERS`, `SH_ROUTING_POLICY`.                                                                                                                                                                                                                               |

## Clients: `mocactl`

`mocactl` talks to the MU1 control plane, which tells it where the harness is
(`GET /v1/discovery`, set with `SH_PUBLIC_HARNESS_URL`), so migrating clients means pointing them at
the control plane's URL, not at the harness. See [`packages/mocactl/README.md`](../packages/mocactl/README.md).

- Install: `curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/scripts/install-mocactl.sh | sh`
  (Node 22+; `MOCACTL_VERSION` and `MOCACTL_INSTALL_DIR` override defaults).
- First run: `mocactl` onboards, then `mocactl login` does the device-flow login.
  `--harness-url` / `SH_HARNESS_URL` override discovery, for example behind a local port-forward.
- The Knative quick start (`deploy/knative/mocactl-quickstart.sh`, `make mocactl-quickstart`) is
  deprecated along with the rest of `deploy/knative/`. The P6 equivalents are the Compose and VM
  READMEs above.

## Bring-up

1. Pick a destination above and follow its README end to end (`deploy/vm/setup-vm.sh`,
   `deploy/k8s/setup.sh`, or `deploy/compose/install.sh`). Bring the P6 side up in parallel with
   the running Knative deployment — they share nothing but Redis.
2. Point the P6 deployment at the same Redis instance, or replicate Redis first.
3. Repoint clients at the P6 deployment's endpoints — the control plane for authentication and
   session management, the supervisor listener for turns. Each destination README documents its
   supported topology (for `deploy/vm`, see "Reaching it: the supported demo topology").
4. Verify with a canary session that resumes a pre-migration transcript, then decommission the
   Knative Service, the KEDA ScaledJobs and their RBAC.

## Rolling back

Bring-up runs the P6 side next to the Knative deployment, so rollback is a client change while you
have not yet done step 4 of [Bring-up](#bring-up) above:

1. Repoint clients at the Knative endpoint.
2. Sessions written by P6 resume there: both paths use `@moca/session-backend` with the same schema.
3. Sandbox filesystems do not carry in either direction; the next turn re-derives its workspace.

Keep the Knative Service and ScaledJobs in place until you are satisfied; step 4 is the point of no
easy return. After removal lands, the deprecated path will not be there to roll back to.

## During the window

- The deprecated path keeps working and receives security and breakage fixes. It gets no new
  features. Fixes land on `main` only: there are no release branches or backports, and a user pinned to
  an older tag gets no fixes. "Breakage" means a regression or a break from a base-image or dependency
  update. The full policy is in [Maturity and lifecycle](reference/maturity-and-lifecycle.md#support-for-legacy-paths).
- **Control-plane exposure on the deprecated K8s path.** `deploy/knative/` runs the control plane
  in the same namespace as the harness (`default`, unless you passed `--namespace` to
  `setup-k8s.sh`), and the harness ServiceAccount holds `pods/exec: create` there with no
  `resourceNames`. A process with code execution in a harness pod can therefore `kubectl exec` into
  the control plane and read its Ed25519 session-signing key and the credential KEK (the exchange
  token is already mounted in the harness), which defeats the "the harness cannot mint a token"
  property. It will not be fixed on this path. The harness needs that grant to reach its sandbox
  pods, so it cannot be narrowed; the control plane is what has to move. If you run it there during
  the window, move it to its own namespace (the Role is namespace-scoped, so that alone closes the
  exec path), or move to `deploy/k8s`, which keeps the control plane in `moca` and its credentials
  in a separate `moca-credentials` namespace. A bare namespace move gets three things wrong:
  the `/resources` pod Role (`sh-control-plane-pods`) stays in the harness namespace and needs a
  cross-namespace RoleBinding; `sh-control-plane-egress-from-harness` needs a `namespaceSelector`,
  otherwise every token exchange returns 503; and `SH_CONTROL_PLANE_URL` in `service.yaml` changes.
  Off Kubernetes (`deploy/vm`, `deploy/compose`) there is no pod-exec path to the control plane.
- Removal happens no earlier than end of October 2026 and only once the remaining users have
  migrated. [Tell us when you have moved](https://github.com/rossoctl/moca/issues/490) — the
  condition is users, not the calendar alone.

## Status log

| Date       | Change                                                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-11 | Knative/KEDA deployment path deprecated ([ADR-0041](adrs/0041-deprecate-knative-keda-deployment.md)). Removal: no earlier than end of October 2026, after remaining users migrate. |
| 2026-10-12 | Added the async/cron section, configuration mapping, `mocactl` guidance and rollback.                                                                                              |
| 2026-10-14 | Stated the deprecated path's control-plane exposure in full (it will not be fixed) instead of pointing at #248.                                                                    |
