# Pacing and placing template workers' cold starts

- **Status:** design accepted (the user, 2026-11-09: the four recommendations in §7, reviewed and agreed
  by autobench-moca, autobench, image-factory and autobench-sandbox). **The start limit is
  implemented** (merged 64bb34fe): its control plane deployed on both namespaces (2026-11-09,
  ccac7696), its host agent part pending a KVM-host window. **The idle grace is implemented** (merged
  43379f55), not deployed yet
  (register G43). §4a records where the build differs from §4.
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
- **Width doesn't raise the disk's throughput:** one cold start alone took about 37 s, and a wave of
  four about 3-4 minutes. So a start limit bounds **each start's wait**, not the total: on this
  volume, 28 cold 4 GiB starts take about 20 minutes at any width. (Measured after a round's release;
  a start right after its build reads from the page cache and looks faster, so measure with the cache
  dropped, `echo 3 > /proc/sys/vm/drop_caches`, or after a reboot.)

The client-side counterpart exists: autobench-moca's runner can hold its leases between rounds
(`KEEP_WARM=1`), which avoids the cold round entirely, at the cost of holding the workers.

## 3. Goals and non-goals

**Goals:**

- A host never starts more cold workers at once than its disk can serve. Starts queue on the host,
  and each activation's readiness says it is queued, not stuck.
- Placement prefers a host where the build's worker is already running.
- Optionally, a released worker stays up for a short grace, so a template used again soon is warm.
- Nothing is evicted. Leases, quotas and `activeLimit` mean what they mean today.

**Non-goals:**

- Changing the pinning (it's the density mechanism) or the disk (the user's decision).
- Prefetching memory files before an activation (possible later, §7; it moves the read earlier, it
  can't beat the disk).
- Reporting which memory files a host has cached (decided: not now, §7).

## 4. The model

- **Bounded start concurrency, in the host agent:**
  - a host setting `SBX_START_CONCURRENCY`, default 4, limits how many workers are _starting_
    (started but not yet attached) at once. It is **not** `SBX_ACTIVE_LIMIT` (which caps running
    ones). A value of 0, or anything but a positive integer, is refused at the agent's settings
    check;
  - each wanted run starts at most that many minus those still starting, oldest lease first (the
    order the wanted answer already uses), and leaves the rest for the next run (every 15 s);
  - **activation() never waits for a start to finish.** `systemctl start` of the `Type=simple` worker
    unit returns at once, so the run's other steps (G42's egress, within its 120 s) stay inside the
    unit's 5 min timeout;
  - "attached" is the relay's presence, which the control plane already has. The wanted answer
    gains `starting: [buildId]` (wanted, started, not yet attached), so the agent doesn't need its
    own probe;
  - **the limit is applied by the agent,** so it takes effect even with an older control plane
    (without `starting`, the agent counts its own units started in the last 10 minutes and not yet
    seen attached). It's the one setting that works without the control plane knowing.
- **Readiness while queued:** a build wanted, placed, and waiting for a start slot is `activating`
  with `queued: true` and its position. Retry-After on `409 template_not_active` becomes the
  estimate: position ÷ concurrency × the host's measured start time. A queued start stays
  `activating` longer than before, so **a client polls readiness with a timeout sized for a full
  queue** (autobench-moca's runner allows 900 s for 28 in waves of 4).
- **The host's start time in the inventory:** the agent reports `startSeconds`, a moving average of
  its recent cold starts (start to attach, from the worker's journal), and `startConcurrency`. No
  benchmark run is needed: the numbers come from the starts it does.
- **Cold-start-aware placement** (in `place()`, after G39's memory test): first a host where the
  build's worker is already running (attached or graced: no start at all), then the existing rule
  (fewest wanted builds).
- **Hard links:** each worker's jail hard-links the memory file. A fallback to a copy (a different
  file system) reads and pins a second whole copy, so on a production host that warning is an error.
- **An optional idle grace:** a host setting `SBX_IDLE_GRACE_S`, **default 0** (off, today's
  behaviour); where used, 600-900 s, long enough to cover a batch's gaps between rounds (94 s and
  261 s in the window), so a runner can drop `KEEP_WARM`. The wanted answer keeps a build in `run`,
  not `stop`, for that long after its last lease ends, if the host has room under `activeLimit` and
  G39's memory floor (a graced worker counts there as attached). Then:
  - **force cold:** a release with `stopNow: true` (`POST /v1/templates/{id}/deactivate`) ends the
    grace at once, so a one-by-one comparison still measures each task's cold start;
  - **a retire or a reject ends the grace at once** (a retired build is never wanted again), so the
    host's removal of the build isn't delayed;
  - **a wanted build that needs the slot** stops the graced worker first: the only stop of a worker
    nobody asked to stop, and only of one with no lease. The stop **re-checks, at stop time, that
    the worker is still unleased**, else it isn't stopped;
  - each graced stop is logged, and graced workers are counted in the agent's summary and shown in
    the host view (`GET /v1/templates` hosts block: `graced`), so "why did my warm worker go" and
    "graced, not stuck" both have an answer;
  - it's a host setting, not a client's. On a host with the grace off, `KEEP_WARM` stays the client's
    option.

**Words:** a "lease" here is a template activation lease (`POST /v1/templates/{id}/activate`), and the
grace keeps a template's **worker** attached after its last one ends. Upstream's proposed lease mode
(ADR-0048, SBX0.3) is a different thing: it keeps one sandbox's **VM** warm between its commands,
inside a worker. The two can coexist: a graced worker can hold lease VMs only while their sandboxes
live, and a sandbox keeps its worker wanted.

## 4a. As built: the start limit (64bb34fe), and why

- **`SBX_START_WINDOW_S`** (default **300 s**, not ten minutes): with a control plane that sends no
  `starting`, the agent counts as starting the workers it started less than that long ago, still
  running and wanted. A wave of four 4 GiB cold starts on a ~125 MB/s volume (3-4 minutes) fits
  inside it; a slower disk raises it. It is validated like `SBX_START_CONCURRENCY` (a whole number, at
  least 1).
- **`startSeconds` is measured to within the 15 s poll:** the agent sees a start end when its build
  leaves the wanted answer's `starting` while still in `run`, not from the worker's journal. Kept in
  `$SBX_SRV/start-seconds` (0600, the last 10), with the starts themselves in `start-times`.
- **`run` comes in the wanted order** (oldest lease first), so the agent starts in that order.
- **"Attached" is the relay's presence,** the source readiness uses; the agent's own `attached`
  reports only mean "started".
- **Retry-After** is `max(1, ceil(ceil(position / startConcurrency) × startSeconds))`, else 30 s as
  before; on first use the readiness facts are re-read after the lease is taken, so the request's own
  build has its place in the line.
- **Placement prefers a host already running the build's worker** for every host, with or without
  memory figures (G39's `runningWorkers`).
- **The hosts block** shows `start: {concurrency, seconds, starting, queued}`; builds gain optional
  `queued` and `queuePosition`; openapi 1.9.0.

## 4b. As built: the idle grace (43379f55), and why

- **When the last lease ended:** a build's `lastLeaseEnd` (epoch s), set by a deactivate that drops the
  last live lease; for a lease that ran out, the latest `until` among its expired leases (copied into
  `lastLeaseEnd` before a write clears them). A build released before the change has neither and gets
  no grace.
- **What the grace needs:** the agent reports the worker running (`runningWorkers`), no live sandbox,
  a free slot under `activeLimit` and G39's memory with its graced workers counted. If the host is
  short, the soonest-ending graced workers drop first.
- **The lease re-check at stop:** only displaced graced workers are re-read, from the catalog, under
  the activation lock (G40's, moved to `activation-lock.ts` so the wanted answer and activation share
  it); no host or Redis call runs under it.
- **A retire or reject while graced:** the removal step skips a running worker, so on a host with a
  grace the wanted answer lists a retired or rejected build in `stop` as well as `remove`; the agent
  stops it, then removes it in the same run, and `workers/report` accepts `detached` for it.
- **`stopNow`** on a build already in its grace ends it (a record with `leases: 0`, `stopNow: true`;
  a repeat writes nothing); while other subjects still hold leases it changes nothing for them.
- **A graced, attached worker's first use** takes a lease and creates the sandbox at once.
- **The rollout order:** the control plane (1.10.0) first, then the agent, then the setting, since an
  older control plane doesn't stop a retired graced worker (RUNBOOK).
- **Fields:** `SBX_IDLE_GRACE_S` (0..86400, default 0); inventory `limits.idleGraceSeconds`; the wanted
  answer's `graced: [buildId]`; builds' `graced`/`gracedUntil`; the hosts block's `idleGraceSeconds`
  and `graced`; the agent summary's `graced`; `$SBX_SRV/graced` (0600). openapi 1.10.0.

## 5. Effects

- **The host agent:** the start limit in `activation()`, `startSeconds` and `startConcurrency` in the
  inventory, graced workers in the summary. No new unit or timer. New settings, all in
  `host-agent.env` (0600), never argv: `SBX_START_CONCURRENCY`, `SBX_IDLE_GRACE_S`.
- **The control plane:** `starting` in the wanted answer, the queued readiness and Retry-After, the
  placement order, the grace in the wanted answer, `stopNow` on deactivate, and `graced` in the host
  view.
- **Clients:** activations that queue answer as today (`409 template_not_active`, Retry-After), with
  a better estimate. A runner using `KEEP_WARM` can drop it if the grace covers its gaps.
- **Rollback, and version skew both ways:** each part is optional, off when its setting is absent:
  an older agent starts all at once, as today, and an older control plane ignores the new inventory
  fields (the start limit still applies, from the agent). Each rollout list states both.

## 6. Tests (when built)

- the agent starts at most `SBX_START_CONCURRENCY` workers in a run, and starts the next ones as the
  first attach (a mocked `starting` list);
- readiness says `queued` with a position; Retry-After grows with it;
- `SBX_START_CONCURRENCY=0` is refused; activation() returns without waiting on a start;
- the limit holds against an older control plane (no `starting`);
- placement prefers the host already running the worker;
- the grace keeps a released build in `run` for `SBX_IDLE_GRACE_S`, and gives the slot up to a
  wanted build, re-checking for a lease at stop time;
- `stopNow` and a retire end the grace at once; graced workers are counted and shown;
- with none of the settings, everything behaves as today.

## 7. Decisions (the user, 2026-11-09)

Recommended by sbx-template, reviewed and agreed by autobench-moca, autobench, image-factory and
autobench-sandbox:

1. **Start concurrency:** a fixed host setting, `SBX_START_CONCURRENCY`, default 4, 0 refused,
   applied by the agent without waiting on starts. It bounds each start's wait; the disk sets the
   total.
2. **The idle grace:** built, off by default (600-900 s where used), with `stopNow` to force cold, a
   retire or reject ending it at once, a lease re-check at stop time, and graced workers counted and
   shown. Built after the start limit.
3. **Cached memory files:** not reported, for now.
4. **Prefetch:** later, only if the start limit and the grace leave cold starts too slow.
