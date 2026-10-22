# ADR-0043: A separate `moca-provisioner` is the only MOCA component that creates workload sandboxes

- **Status:** Proposed <!-- Proposed → Accepted → Superseded by ADR-NNNN / Deprecated -->
- **Date:** 2026-10-16
- **Deciders:** MOCA team
- **Spec:** [`../specs/2026-10-16-workload-sandboxes-design.md`](../specs/2026-10-16-workload-sandboxes-design.md)

## Context

Phase 2 of `/workloads` (#476, per-workload sandboxes and storage) gives each workload its own
sandbox pods, with its Context PVC mounted. On Kubernetes, P6 (the process-manager runtime) has
no component that can create a pod today:

- The supervisor, its workers, the relay and the sandboxes run with
  `automountServiceAccountToken: false`. The workers process model output, so they stay without a
  token on purpose.
- The control plane has a token, but only for a Role on Secrets in `moca-credentials`. It also holds
  the signing keys and the credential store, so MI1 §4.3 rates its compromise as "everything".
- Context Service used to create sandboxes. rossoctl/context-service#51 (Sandbox provisioning
  removed) took that out: MOCA owns execution, Context Service owns storage.

Whatever creates workload sandboxes also renders a pod spec from request data, holds RBAC in the
sandbox namespace, and is where a workload's owner and its storage meet.

## Decision

We will add **`moca-provisioner`**, its own Deployment in the `moca` namespace. It is the only MOCA
component with Kubernetes permissions in `moca-sandbox`: one Role to create and delete a
workload's StatefulSet, its headless Service and its attach-token Secret, and to read pods and
PVCs. It creates no PVCs; Context Service does.

- Workers call its internal API with a service token, and forward the caller's API token. The
  provisioner verifies that token itself and takes the owner from it.
- It signs each workload's attach token with its own Ed25519 key. The relay verifies the token with
  public keys and sets `moca.dev/workload` and `moca.dev/owner` from it, never from `Hello`.
- It resolves the workload's PVC through rossoctl/context-service#40, which checks `attach` for the
  owner.
- It runs the orphan reconciler.

The control plane, the supervisor and the relay stay without Kubernetes permissions.

### Alternatives considered

- **A provisioner inside the control plane.** No new Deployment, but it puts pod-spec rendering and
  sandbox RBAC into the most privileged, internet-facing process.
- **The supervisor's workers.** Refused in #476: they run model-influenced code.
- **agent-sandbox `Sandbox` CRs.** A backend, not an owner: something still needs RBAC on the CRs,
  and every install would need the CRD and its controller. Kept as a later backend for its warm
  pools.
- **Context Service creating sandboxes again.** Reverses context-service#51's ownership boundary.
- **Static per-user sandboxes** (MI1 §9.1 option B). No dynamic workloads, and operator toil per
  user.

## Consequences

- Positive: the new permission is held by the smallest component, in one namespace, with no
  rights on Secrets or pods in `moca`.
- Positive: workload labels in `sh:sandbox:records` become trustworthy without a new store; the
  workers can still write Redis, but not a valid signature.
- Positive: MI1 §9.1's option A (a launcher that creates a user's container) exists on Kubernetes.
- Negative / accepted cost: one more Deployment, signing key and internal endpoint to operate.
- Negative / accepted cost: a compromised provisioner can create pods in `moca-sandbox` and attach
  any Context there. A ResourceQuota bounds the first; nothing but its small surface bounds the
  second.
- Negative / accepted cost: it provisions only the container tier. P4 (microVM) hosts sit outside
  the cluster and need a host-side provisioner.
- Follow-up owed: the context-service#40 companion, including ownership of the claim outside
  `.context-service/`; the MI1 §2.3, §9.1 and §13 amendments; and the relay's Exec check
  becoming a real boundary once MI1 S2 grants name the user.

---

_Assisted-By: Claude (Anthropic AI) <noreply@anthropic.com>_
