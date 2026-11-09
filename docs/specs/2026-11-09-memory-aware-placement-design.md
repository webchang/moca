# Memory-aware placement of template workers (DRAFT)

- **Status:** draft for the user's review (register G39). Not implemented.
- **Date:** 2026-11-09
- **Asked by:** autobench-moca, 2026-11-08, for the user ("per host resource availability"). The
  user's answer: "yes, run the test first". The Lite-28 batch window (2026-11-08) was that test.
- **Builds on:** [template lifecycle](2026-11-03-template-lifecycle-and-provenance-design.md) §6.2
  (quotas and the active limit) and §6.3 (leases), the host agent (§6.1), and the companion
  [cold-start pacing](2026-11-09-cold-start-pacing-design.md) (G43).

## 1. What exists

- **Placement** (`packages/control-plane/src/activation.ts`, `place()`): a wanted build goes to a
  host that holds its snapshot, the one with the fewest wanted builds, while that host has fewer than
  its `activeLimit`. Otherwise it waits, and the activation answers `no_active_slot`. A held build is
  never evicted.
- **`activeLimit`** is a number the host's operator writes in `/etc/sbx/host-agent.env`
  (`SBX_ACTIVE_LIMIT`). The agent reports it in its inventory with the disk's free space and floor.
  **It reports nothing about memory.**
- **A worker's memory:** at start, each template worker maps its snapshot's memory file and locks
  it (`PinMemoryFile`, mmap + mlock of the whole file). The locked pages are the density mechanism
  (every VM of that template shares them), and they're also memory the kernel can't reclaim. So an
  attached worker holds its guest's whole RAM image even when idle.
- **The worker's own budget** (`--budget-mb`, `SH_MAX_COMMITTED_MB`) limits the VMs **one** worker
  runs at once. Nothing limits the sum across workers on a host.

## 2. What the batch window measured

On the KVM host (188.5 GiB, 4 GiB guests), 28 templates attached at once, then one rep per template
in rounds (autobench-moca's l28b-2-d findings, private: "G39's constants"):

- **The attached workers take most of the memory:**
  - an attached, idle worker costs about **3.7 GiB**, about its pinned memory file;
  - 28 attached and idle took available memory from about 184 GiB to about 81 GiB.
- **Running VMs add little on top:** about **0.5 GiB per running rep** (their dirty pages), and
  roughly 0.2 GiB per Firecracker process during the reps.
- **Pressure stayed low:** memory PSI (full, avg10) stayed under 2 throughout, against the window's
  stop rule of 10, and nothing was killed.

So the cost of a host is mostly **the number of attached workers**, times each one's memory file.
A fixed `activeLimit` is right only for templates of one size. Bigger guests, or a host also running
other work (Moca's own P6 sessions), need a lower limit than the operator's number.

## 3. Goals and non-goals

**Goals:**

- Placement never starts a worker that would take the host under a memory floor, whatever
  `activeLimit` says.
- The rule is visible: an activation that can't be placed for memory says so (`no_active_slot` with
  `reason: memory`), and `GET /v1/templates/{id}` readiness shows it.
- Nothing is evicted. The rule only stops new starts, as `activeLimit` does today.

**Non-goals:**

- Changing the worker's own budget, or the guest size, or the pinning.
- Live migration, or moving a running worker.
- Accounting for other workloads' memory except through what the host reports as available.

## 4. The model

- **The host reports memory** with each inventory (the build poll and the 15 s wanted runs):
  - `memAvailableMib` from `/proc/meminfo` (`MemAvailable`);
  - `memTotalMib`;
  - `memPressureFull10`, memory PSI `full avg10` from `/proc/pressure/memory`, when present;
  - the memory each running worker holds is known from what it holds (below), so it isn't reported.
- **Each build's cost** is known in the control plane: its memory file's size. The `built` report
  already carries the manifest (S), which names the snapshot's guest RAM (`guest_ram_mb`). The cost
  is that, plus a fixed per-worker overhead (`workerOverheadMib`, default 128).
- **The rule,** in `place()`, per host, in the order builds are placed today:
  - `headroom = memAvailableMib − memFloorMib − Σ(cost of builds placed on it but not yet attached)`;
  - a build fits if `cost ≤ headroom` **and** the host is under `activeLimit`;
  - a host whose last inventory is older than 60 s is treated as having no headroom for new starts
    (its report is stale), never as having all of it.
- **Pressure as a brake:** while `memPressureFull10` is above `memPressureLimit` (default 10), the
  host takes no new start. It keeps what it runs.
- **The floor and the limits** are host settings, in `host-agent.env`, reported with the inventory:
  `SBX_MEM_FLOOR_MIB` (default 10% of MemTotal) and `SBX_MEM_PRESSURE_LIMIT` (default 10). Running
  VMs' growth (about 0.5 GiB per rep here) is what the floor absorbs.
- **Readiness:** a build wanted but not placed for memory is `unavailable` with
  `reason: memory`, and the activation's `409 no_active_slot` names it. The client's retry (Retry-After)
  is unchanged.

## 5. Effects

- **The host agent:** three fields in the inventory, read from `/proc`. No new unit or timer.
- **The control plane:** `place()` gains the memory test. The host view gains the memory fields.
  Builds without a recorded guest size (records before the manifest carried it) count at
  `defaultCostMib` (4096), so nothing older is undercounted to zero.
- **Operators:** `SBX_ACTIVE_LIMIT` stays the upper bound. It no longer has to be set from a memory
  calculation by hand.
- **Rollback:** an older control plane ignores the new inventory fields; an older agent sends none,
  and the control plane then places by `activeLimit` alone, as today (the fields are optional).

## 6. Tests (when built)

- `place()` with hosts of different headroom: a 4 GiB build skips a host with 3 GiB of headroom and
  goes to one with 8 GiB; two builds placed in one pass both count against the same host's headroom;
- a stale inventory gives no headroom;
- pressure above the limit blocks new starts and keeps running ones;
- `no_active_slot` names `memory`, and readiness says `unavailable` with that reason;
- an inventory without the fields places as today.

## 7. Open questions (for the user)

1. **The floor:** 10% of the host's memory (proposed), or a fixed amount the operator sets?
2. **The cost of a build:** its guest RAM plus a fixed overhead (proposed, from the manifest), or a
   measured per-template cost the agent reports after the first start (closer, but needs a first
   start to learn)?
3. **Pressure:** use PSI as a brake on new starts (proposed), or only the available-memory test?
4. **Order with G40** (the activation check not atomic across templates): build G40's serialization
   first, so memory placement is decided once per host, not raced (proposed), or together?
