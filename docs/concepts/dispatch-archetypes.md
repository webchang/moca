# Dispatch archetypes

> **Preview.** Describes the P6 runtime on `main` as of 2026-10-12.

An orchestrator can hand work to MOCA in three patterns. Which of them work depends on the deployment.

| Archetype            | Pattern                                                           | On P6 today                                                        |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| **A. Async fan-out** | Dispatch many leaves with `async: true`, collect results later    | **Not available.** Exists only on the deprecated Knative/KEDA path |
| **B. Human gate**    | A leaf pauses for an external verdict, then resumes or terminates | **Works** (verdict leaves, `POST /v1/runs`)                        |
| **C. Scheduled**     | A cron trigger dispatches async leaves                            | **Not available.** Exists only on the deprecated path              |

Interactive turns (`POST /v1/turn`) and synchronous leaves (`POST /v1/runs`) work on P6 and on the
deprecated path alike.

## What the orchestrator relies on

- **Interactive:** `POST /v1/turn` with a session id, optionally streaming and detachable. See the
  [HTTP API guide](../reference/http-api.md).
- **Run-to-completion:** `POST /v1/runs` with a leaf envelope (a verdict, a `solve` or a `prompt` leaf)
  returns a result in the response body, which is also stored for polling at `GET /runs/status`. See
  [Leaf envelope and result](../reference/leaf-and-envelope.md). A failed leaf is a 200 with
  `status: "failed"`, so check the status field, not only the HTTP code.
- **Retry:** re-send the same `sessionId`. A verdict leaf returns its recorded verdict; the others run
  again.
- **Back-pressure:** a 503 with `Retry-After` means no sandbox is available right now (the pool is
  saturated, or the session's sandbox is busy or briefly absent), and a 429 from the supervisor means no
  worker has a free slot. Retry after the delay. A detachable turn can also return 503 `redis_unavailable`.

## Archetype B, the human gate

A verdict leaf marked `require_approval` stops and returns `status: "paused"` with a `gateId` and the
proposed action. The orchestrator (or a person behind it) re-sends the same envelope with an inline
`decision` of `approve`, `reject` or `abort`. Nothing is held in memory while paused: the state is the
session log in Redis, and there is no harness-side timeout. There is no gate on `/turn`.

## Archetypes A and C

`async: true` and the cron on-ramp need the Redis-Streams drainer that ran as a KEDA `ScaledJob` and the
`CronJob`; neither has a P6 counterpart yet, and the supervisor only runs `--role=turn` workers (a
`--role=leaf` role is reserved and not implemented). An authenticated `async: true` request returns 501
`async_runs_unavailable`. An _anonymous_ one on a deployment with `SH_REQUIRE_AUTH` off still gets 202 and is
queued, but nothing drains the queue on P6, so `/runs/status` answers `queued` forever: do not mistake the
202 for support. If you depend on A or C, stay on the deprecated path and tell the maintainers in
[the tracking issue](https://github.com/rossoctl/moca/issues/490); the
[migration guide](../migrating-from-knative.md#if-you-depend-on-async-fan-out-or-the-cronjob) explains what
the repository states and what it does not.
