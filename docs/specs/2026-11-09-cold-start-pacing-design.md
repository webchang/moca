# Pacing and placing template workers' cold starts (DRAFT)

- **Status:** draft for the user's review (register G43). Not implemented.
- **Date:** 2026-11-09
- **Found in:** the Lite-28 batch window, 2026-11-08: 28 templates activated at once on one KVM host,
  and many activations waited minutes for their workers. The user kept the host's disk as it was
  (a general-purpose volume, about 125 MB/s).
- **Builds on:** [template lifecycle](2026-11-03-template-lifecycle-and-provenance-design.md) §6.1
  (the host agent), §6.3 (leases), §6.4 (first use), and the companion
  [memory-aware placement](2026-11-09-memory-aware-placement-design.md) (G39).

## 1. What exists, and why a cold start is slow

- **Readiness is presence:** a build is `active` once its worker has attached to the relay. Before
  attaching, a worker:
  1. verifies its snapshot and template record;
  2. maps and locks its whole snapshot memory file (`PinMemoryFile`, mmap + mlock), which reads the
     whole file from disk unless it is already in the page cache;
  3. restores a probe VM;
  4. attaches.
- **The host agent starts every wanted worker in one pass** (`activation()` in
  `deploy/sbx/host-agent.sh`, `systemctl start` each; the units are `Type=simple`, so systemd
  reports them started at once).
- So **N workers starting together read N memory files at the same time**, and a cold start's time
  is about `N × memory file ÷ the disk's read throughput`. With 4 GiB guests on a ~125 MB/s volume,
  28 at once is about 15 minutes of reads alone (112 GiB at 125 MB/s) before the last one can
  attach; the probe restores and the start order added more in the window.
- **A worker stops as soon as it is not wanted:** `GET /v1/hosts/{host}/wanted` lists a build in
  `stop` when it has no live lease and no live sandbox. `SBX_IDLE_LIMIT_S` is only the default lease
  length. There is no grace after the last lease ends, so the next use of the template is cold again,
  even minutes later.
- **The inventory reports no disk throughput,** and placement doesn't consider whether a worker is
  already running.

## 2. What the batch window measured

autobench-moca's l28b-2-d records (private: the findings and the per-activation times):

- **Warm:** with all 28 workers still attached from the previous round, every activation was
  active in under a second.
- **Cold, 28 at once** (the runner's round end had released all 28): activations became active from
  under half a minute to over four minutes each, in waves, and the last of the 28 attached after
  more than twenty minutes. The host's journal and disk counters showed the time spent in the memory
  file reads; memory pressure stayed low.
- **The cause was confirmed on the host,** not inferred: the workers' start logs and the volume's
  throughput.

The client-side counterpart exists: autobench-moca's runner can hold its leases between rounds
(`KEEP_WARM=1`), which avoids the cold round entirely, at the cost of holding the workers.

## 3. Goals and non-goals

**Goals:**

- A host never starts more cold workers at once than its disk can serve. Starts queue on the host,
  and each activation's readiness says it is queued, not stuck.
- Placement prefers a host where the build's worker is already running, or whose page cache already
  holds its memory file.
- Optionally, a released worker stays up for a short grace, so a template used again soon is warm.
- Nothing is evicted. Leases, quotas and `activeLimit` mean what they mean today.

**Non-goals:**

- Changing the pinning (it's the density mechanism) or the disk (the user's decision).
- Prefetching memory files before an activation (possible later; §7).

## 4. The model

- **Bounded start concurrency, in the host agent:**
  - a new host setting `SBX_START_CONCURRENCY` (default 4) limits how many workers are _starting_
    (started but not yet attached) at once;
  - each wanted run starts at most that many minus those still starting, oldest lease first (the
    order the wanted answer already uses), and leaves the rest for the next run (every 15 s);
  - "attached" is the relay's presence, which the control plane already has. The wanted answer
    gains `starting: [buildId]` (wanted, started, not yet attached), so the agent doesn't need its
    own probe.
- **Readiness while queued:** a build wanted, placed, and waiting for a start slot is `activating`
  with `queued: true` and its position. Retry-After on `409 template_not_active` becomes the
  estimate: position ÷ concurrency × the host's measured start time.
- **The disk's throughput in the inventory:** the agent reports `startSeconds`, a moving average of
  its recent cold starts (start to attach, from the worker's journal), and `startConcurrency`. No
  benchmark run is needed: the numbers come from the starts it does.
- **Cold-start-aware placement** (in `place()`, after G39's memory test):
  - first, a host where the build's worker is already running (it's attached: no start at all);
  - then a host whose last inventory lists the build's memory file as cached (`cached: [buildId]`, from
    `fincore` or `mincore`, best effort; optional);
  - then the existing rule (fewest wanted builds).
- **An optional idle grace:** a host setting `SBX_IDLE_GRACE_S` (default 0, today's behaviour). The
  wanted answer keeps a build in `run`, not `stop`, for that long after its last lease ends, if the
  host has room under `activeLimit` and G39's memory floor. A grace never holds a slot another
  wanted build needs: that build's placement stops the graced worker first (the only "eviction",
  and only of an unleased worker).

## 5. Effects

- **The host agent:** the start limit in `activation()`, `startSeconds` and `startConcurrency` (and
  optionally `cached`) in the inventory. No new unit or timer.
- **The control plane:** `starting` in the wanted answer, the queued readiness and Retry-After, the
  placement order, and the grace in the wanted answer.
- **Clients:** activations that queue answer as today (`409 template_not_active`, Retry-After), with
  a better estimate. A runner using `KEEP_WARM` can drop it if the grace covers its gaps.
- **Rollback:** each part is optional, off when its setting is absent: an older agent starts all at
  once, as today, and an older control plane ignores the new inventory fields.

## 6. Tests (when built)

- the agent starts at most `SBX_START_CONCURRENCY` workers in a run, and starts the next ones as the
  first attach (a mocked `starting` list);
- readiness says `queued` with a position; Retry-After grows with it;
- placement prefers the host already running the worker, then the cached one;
- the grace keeps a released build in `run` for `SBX_IDLE_GRACE_S`, and gives the slot up to a
  wanted build;
- with none of the settings, everything behaves as today.

## 7. Open questions (for the user)

1. **Start concurrency:** a fixed host setting (proposed, default 4), or derived by the agent from
   its measured `startSeconds`?
2. **The idle grace:** build it (off by default, proposed), or leave keeping warm to clients'
   leases (`KEEP_WARM`)?
3. **Cached memory files:** report them (best effort, proposed as optional), or skip that part?
4. **Prefetch:** later, read a placed build's memory file into the page cache before its worker
   starts, when the host is idle? Proposed: a later increment, if the above isn't enough.
