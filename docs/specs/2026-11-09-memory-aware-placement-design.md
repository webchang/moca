# Memory-aware placement of template workers

- **Status:** design accepted (the user, 2026-11-09: the four recommendations in §7, reviewed and agreed
  by autobench-moca, autobench, image-factory and autobench-sandbox). **Implemented** (merged 6230e2cc, reviewed by autobench and autobench-sandbox); control plane deployed (both namespaces, 2026-11-09, c9696027); host agent pending (placement by activeLimit until a host reports memory) (register G39). §4a records where the build
  differs from §4.
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
  attached worker holds its guest's whole RAM image even when idle. Snapshots are **Full**
  (`build-snapshot.sh`: `mem_size_mib` is the guest's RAM, `snapshot_type: Full`), and the mlock
  covers the file's whole logical size, holes included: the pinned cost is exactly the guest's RAM.
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
(The ~3.7 GiB is page-cache residency; the pinned cost the rule uses is the whole file, §4.)
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

- **The host reports memory** with each inventory. The inventory is sent on the build poll and on
  every 15 s wanted run (`host-agent.sh` sends it before the `--wanted-only` split), so it's fresh:
  - `memAvailableMib`, `memTotalMib` from `/proc/meminfo`;
  - `memPressureFull10`: memory PSI **`full avg10`** (a percentage) from `/proc/pressure/memory`.
    With no `/proc/pressure` (an older kernel, or PSI off at boot) the field is absent: no brake, and
    the agent logs it once. Never "no starts";
  - `vmCommittedMib`: what each attached worker's running VMs hold, from its slice
    (`sbx-<id>.slice`'s `memory.current`, minus the pinned file, read by the agent), per worker;
  - `memFloorMib`: **the effective floor** it applies (below), so an operator sees it without the
    arithmetic.
- **Each build's cost** is its guest RAM (`guest_ram_mb` in the manifest S, already checked against
  the spec and the template record at registration) plus a fixed overhead (`workerOverheadMib`,
  default 128, for the VMM and the worker). **Before placing a build, the agent checks that its
  memory file's size is `guest_ram_mb × 1 MiB`.** A mismatch (a future Diff snapshot, a balloon, a
  trimmed file) is a reported error: the build is `refused` on that host with a reason, in the
  agent's summary and the build's readiness, never only a log line.
- **The rule,** in `place()`, per host, in the order builds are placed today:
  - `used = Σ cost(attached or graced workers) + Σ vmCommittedMib + Σ cost(placed, not yet attached)`;
  - `headroom = memTotalMib − memFloorMib − used`, and also never more than
    `memAvailableMib − memFloorMib` (memory other workloads took);
  - a build fits if `cost ≤ headroom` **and** the host is under `activeLimit`;
  - **graced workers** (G43's idle grace) count as attached: they still hold their pinned file;
  - a host whose last inventory is older than 60 s has no headroom for new starts (about four missed
    15 s reports), never all of it.
- **Pressure as a brake:** while `memPressureFull10` is above `memPressureLimit` (default 10), the
  host takes no new start. It keeps what it runs.
- **The floor:** `SBX_MEM_FLOOR_MIB`, default **10% of MemTotal, clamped to at least 4 GiB**; an
  operator may set a fixed amount instead (a host shared with other work). `SBX_MEM_PRESSURE_LIMIT`,
  default 10. Both in `host-agent.env` (0600), never in argv.
- **Readiness:** a build wanted but not placed for memory is `unavailable` with `reason: memory`, and
  the activation's `409 no_active_slot` names it. The client's retry (Retry-After) is unchanged.
- **Serialized:** the check and the lease's write run under G40's activation lock, so two
  activations can't each see the same headroom.

## 4a. As built (6230e2cc), and why

- **The inventory's `memory` object** (not new fields in `limits`): `memTotalMib`, `memAvailableMib`,
  `memFloorMib` (effective), `memPressureFull10` (absent with no PSI), `memPressureLimit`,
  `runningWorkers`, `vmCommittedMib` (per worker), `memfileMismatch`. The slice is
  `sbx.slice/sbx-<id>.slice` (install-host.sh's `SH_PARENT_CGROUP`). If `/proc/meminfo` gives no
  MemTotal or MemAvailable, no figures are sent (an error line), and the host is placed by
  `activeLimit` alone.
- **"Running" is the agent's own report** (`runningWorkers`: the `sbx-worker@<id>` units active on
  that host), not the relay's presence: a worker pins its memory file from its start, before it
  attaches, and presence doesn't say which host a worker is on. Every build's worker counts, wanted
  or not, so a draining worker still uses memory. A host that already runs the build's worker keeps
  it, even when stale, braked or short of headroom (never evict), and is preferred for it.
- **The headroom:** `min(total − floor − used, available − floor − pending)`, where
  `used = Σ cost(running workers) + Σ vmCommittedMib + pending`, and `pending` is the cost of builds
  placed in this pass whose workers aren't running yet. MemAvailable already reflects what runs, so
  only the pending starts come off it, and two builds placed in one pass both count.
- **The terms count different memory:**
  - A worker's **cost**, its guest's RAM + 128 MiB, is its pinned memory file (the guest's whole RAM
    image, locked once) plus the worker and its VMM.
  - Its running VMs are separate processes restored from that file. Each maps it privately:
    unmodified pages are the same page-cache pages, already in the cost, and the pages a VM writes are
    private copies. **`vmCommittedMib`**, the slice's `memory.current` minus the file's size, is
    those private pages plus the VMM processes.
  - The only overlap is the 128 MiB overhead with the VMM processes, a few hundred MiB per worker in
    the safe direction.
  - The batch window agrees: about 3.7 GiB per attached idle 4 GiB worker against a cost of 4.1 GiB
    (the cost over-reserves by about 0.4 GiB), and about 0.5 GiB per running rep on top.
  - **The `min()` covers an under-count:** while a worker starts, or if its file's pages are still
    charged to another cgroup (a snapshot just built on that host), `memory.current` minus the file
    floors at 0, and `vmCommittedMib` reads low. MemAvailable sees every locked and dirty page,
    whoever is charged, so the second term still binds.
- **A memory-file mismatch** on every holder is its own reason, `memfile_mismatch`, answered
  `409 template_unavailable` (waiting can't clear it; a rebuild does). The agent also refuses to
  start a mismatched build itself (`refused`), so an older control plane can't start one.
- **Readiness and refusals carry the reason:** `no_active_slot` with `reason: memory` (at the active
  limit it answers as before, with no reason); `readinessReason` on builds and templates.
- **Lease mode** (upstream's proposed SBX0.3, ADR-0048), if built: a lease VM lives in its worker's
  slice, so `vmCommittedMib` counts it with no change. Its reclaim target for idle lease VMs and this
  floor act on different things (VMs and workers). On one host, set this floor at or above lease
  mode's reclaim target, so a worker start can't push running sandboxes' leases into reclaim.

## 5. Effects

- **The host agent:** the memory fields in the inventory, read from `/proc` and the workers' slices,
  and the memory-file size check. No new unit or timer.
- **The control plane:** `place()` gains the memory test. The host view gains the memory fields.
  Builds without a recorded guest size (records before the manifest carried it) count at
  `defaultCostMib` (4096), so nothing older is undercounted to zero.
- **Operators:** `SBX_ACTIVE_LIMIT` stays the upper bound. It no longer has to be set from a memory
  calculation by hand.
- **Rollback, and version skew both ways:** an older control plane ignores the new inventory
  fields; an older agent sends none, and the control plane then places by `activeLimit` alone, as
  today (the fields are optional). Each rollout list states both.

## 6. Tests (when built)

- `place()` with hosts of different headroom: a 4 GiB build skips a host with 3 GiB of headroom and
  goes to one with 8 GiB; two builds placed in one pass both count against the same host's headroom;
- a stale inventory gives no headroom;
- pressure above the limit blocks new starts and keeps running ones;
- `no_active_slot` names `memory`, and readiness says `unavailable` with that reason;
- an inventory without the fields places as today;
- running VMs' committed memory and graced workers count against headroom;
- a memory file whose size isn't `guest_ram_mb` is refused with a reported reason;
- the floor's 10% default is clamped to 4 GiB on a small host;
- no `/proc/pressure`: no brake, one log line;
- two concurrent activations onto one host with headroom for one: one is placed (G40's lock).

## 7. Decisions (the user, 2026-11-09)

Recommended by sbx-template, reviewed and agreed by autobench-moca, autobench, image-factory and
autobench-sandbox:

1. **The floor:** 10% of MemTotal, clamped to at least 4 GiB, overridable by the operator; the agent
   reports the effective floor. The count covers attached and graced workers and running VMs'
   committed memory.
2. **A build's cost:** its guest RAM from the manifest (exact: a Full snapshot, pinned whole) plus an
   overhead, with the memory file's size checked before placing (a reported error on mismatch).
3. **Pressure:** PSI `full avg10` over 10 brakes new starts only; absent, no brake, logged once.
4. **Order:** G40 first.
