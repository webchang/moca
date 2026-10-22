// Package egress holds the policy primitives of moca-egress, the host-side
// L7 egress proxy for the microVM tier: the destination allowlist, the
// resolved-address check, and the redacted audit record. It implements the
// consequences recorded in P4.1 (docs/specs/2026-09-15-p4-1-microvm-egress-transport-design.md,
// section 11) and the audit shape of MI1
// (docs/specs/2026-09-28-moca-multi-user-isolation-design.md, section 8.5).
//
// Host-wide blast radius (P4.1 T3, section 11 item 1). One moca-egress
// process serves every microVM on the host. RC1's per-sandbox sidecar failed
// one sandbox at a time; a fault, a misconfiguration or a compromise here
// affects all of them at once. Nothing in this package narrows that.
//
// One implementation of CallerIdentity (P4.1 T4, section 11 item 2). The
// interface that resolves a caller to a VM and session has exactly one
// implementation in this slice, kept behind an interface for the reason in
// P4.1 section 5. This is a scoped incursion into territory Z1 owns, and Z1
// keeps the question of what the interface should finally be.
//
// No cert-pinning escape hatch (P4.1 section 7, section 11 item 3). Tools
// that ignore proxy environment variables have no network on this tier, and
// a client that pins certificates cannot be worked around: the container-tier
// "route it around the proxy" exception does not exist here. Such an upstream
// must be reached from the container tier or not at all. This is a strict
// regression against Z5 section 5.2 and it is not mitigated.
//
// No claim that the proxy cannot be escaped (P4.1 section 11 item 6). As with
// P4 section 1's refusal to claim the VMM cannot be escaped, the claim made is
// that the credential moved out of the guest, not that the boundary is
// unbreakable. The allowlist and the address check are defence in depth, not
// a proof of containment.
//
// Audit redaction (P4.1 section 11 item 4, MI1 section 8.5 item 6). The audit
// log is new attack surface: upstream URLs may carry secrets in query strings
// or userinfo. An audit record therefore carries the escaped path only, via
// RedactPath: never a query, a fragment or userinfo. The credential field
// names the credential and never holds its value.
package egress
