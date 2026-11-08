# Per-sandbox egress records through the API (DRAFT)

- **Status:** draft for review (register G42). Not implemented.
- **Date:** 2026-11-08
- **Asked by:** the user, 2026-11-08: "per-sandbox egress records available through Moca API
  operations … a key requirement for Moca". A benchmark grader voids a rep for a download its rules
  forbid, so it must be able to see what a sandbox reached.
- **Builds on:** [SBX0](2026-10-15-sbx0-internal-sandbox-service-design.md) (sandboxes, the janitor),
  [template lifecycle and provenance](2026-11-03-template-lifecycle-and-provenance-design.md) §7
  (records), guest egress (#623, P4.1; `remote-worker/internal/egress`).

## 1. What exists

On each KVM host one `moca-egress` proxy serves every template worker's guests. It writes **one
audit event per connection or request** (`internal/egress/audit.go`, `Event`) as a JSON line on its
stdout, so into the host's journal:

| Field                                 | Meaning                                                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `time`, `via`                         | when; always `moca-egress`                                                                                                                                                      |
| `vm_id`, `sid`                        | the VM, and the session id it was registered with: **for a sandbox, its workspace key, which is the sandbox id** (`launcher_firecracker.go`: `Register(…, req.ID, req.Key, …)`) |
| `sub`                                 | the subject, when the grant names one                                                                                                                                           |
| `host`, `dial_addr`, `method`, `path` | the destination; `path` without query, fragment or userinfo                                                                                                                     |
| `status`, `bytes_up`, `bytes_down`    | the outcome and volume                                                                                                                                                          |
| `credential`                          | a credential's **name** (never its value) when one was injected                                                                                                                 |
| `decision`                            | `tunnel`, `forward`, `destination_denied`, `destination_private`, `conn_cap`, `credential_injected`, …                                                                          |
| `dropped`, `coalesced`                | loss and coalescing counts (an async sink drops rather than block the proxy)                                                                                                    |

So the facts a grader needs are already recorded, per sandbox. **What's missing:** they stay in the
host's journal, so nobody can get them through Moca, and nothing ties them to the sandbox's
provenance.

## 2. Goals and non-goals

**Goals:**

- A sandbox's **owner**, or an admin, reads its egress events through the API, during its life and
  for its retention afterwards.
- A sandbox's end record names a **digest of its egress log**, so the egress is part of what the
  provenance chain proves, and a copy can be checked offline.
- No secret is ever exposed. Paths are already redacted at the proxy, and credentials are names only.
- The proxy's hot path is untouched. Shipping is off the proxy, and losing events is counted, never
  silent.

**Non-goals:**

- Changing what the proxy allows (that's the allowlist, the host operator's).
- Packet capture or request bodies.
- Moca Pi sessions' egress in this increment (§7).

## 3. The model

- **Collection, on the host:** the host agent tails the proxy's journal (`journalctl -u moca-egress
-o cat --after-cursor …`, keeping its cursor in `$SBX_SRV`). It groups events by `sid`, and posts
  them in batches to the control plane:
  - `POST /v1/hosts/{host}/egress` `{events:[…], cursor}`, behind the existing `hostToken` scheme;
  - every post is idempotent by (host, cursor range).

  The proxy itself is unchanged. Its JSON is the wire format.

- **Store, in the control plane:**
  - **Where:** an append-only log per sandbox, in Redis (where the sandbox records live), as a
    Redis stream `sh:sbx:egress:<sandboxId>` with a length cap. It's kept as long as the sandbox
    record (`SBX_RETENTION_DAYS`).
  - **Who:** events whose `sid` names no sandbox this host serves are refused, and counted.
  - **Integrity:** each sandbox keeps a running sha256 over its accepted events' canonical JSON, in
    arrival order.
- **Read:**
  - `GET /v1/sandboxes/{id}/egress?after=<cursor>&limit=N`, for the owner or an admin, gives
    `{events:[…], next, summary}`;
  - `summary` is per host: count, decisions, and bytes up and down.
- **Provenance:** the sandbox's `terminated` record (deleted or expired) gains
  `egress: {events: N, sha256, dropped}`. The digest is over the log up to the end, and dropped is
  what the host agent saw reported. Late events after the end are still accepted for a grace period,
  and named in a second `egress` record if any arrive.
- **Export:** `GET /v1/sandboxes/{id}/egress?format=ndjson` returns the whole log as JSON lines. Its
  sha256 equals the end record's, so a grader can check a copy offline (verify-provenance.py gains
  an optional `--egress FILE` check).

## 4. The API

| Route                                         | Who                 | Answer                        |
| --------------------------------------------- | ------------------- | ----------------------------- |
| `POST /v1/hosts/{host}/egress`                | a host agent        | `{accepted, refused, cursor}` |
| `GET /v1/sandboxes/{id}/egress`               | the owner, an admin | `{events, next, summary}`     |
| `GET /v1/sandboxes/{id}/egress?format=ndjson` | the owner, an admin | the log, NDJSON               |

Errors: 404 for an unknown or invisible sandbox, and 403 for another subject's sandbox, as for the
other sandbox routes.

## 5. Effects on what exists

- **The host agent:** a new tail-and-post step, on the build poll or its own timer (every 15 s, like
  the wanted state). Its env gains nothing; the journal is local.
- **The janitor:** unchanged. A workspace's removal doesn't touch its egress log, which follows the
  sandbox record's retention.
- **Graders:** read `…/egress` for each rep's sandbox, or check the exported log against the end
  record.

## 6. Open questions (for the user)

1. **Who may read a sandbox's egress:** the owner and admins (proposed), or also a named grader role?
2. **Retention:** the sandbox record's (14 days today, proposed), or longer for benchmark windows?
3. **A loss budget:** if the proxy dropped events for a sandbox (`audit_dropped`), should its end
   record mark the log incomplete, and should a grader treat that rep as unverifiable? Proposed: mark
   it incomplete, and let the grader decide.

## 7. Later

- **Moca Pi sessions' egress:** the same events, keyed by session id (the harness registers the
  session's workspace key), served on `GET /v1/sessions/{id}/egress`.
- **Shipping by the proxy itself** instead of the host agent's tail, once the format is stable.
