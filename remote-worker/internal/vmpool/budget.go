package vmpool

// admitOrEvictLocked is admitLocked for the two call sites whose refusal is
// USER-VISIBLE: acquire's warming charge and runLocked's new key. Caller holds p.mu.
//
// #452: a memory refusal reaching one of these is a failed exec in somebody's
// transcript, so try to make room before returning it.
//
// WHAT THIS ACTUALLY RELIEVES. One command leaves 1+StandbyDepth VMs resident, and the
// sweep only takes them back once the key has been idle for StandbyIdle (90s) — after
// which the run is parked holding zero VMs (see admitLocked's "PARKED RUNS DO NOT
// COUNT"). So committed memory tracks the sessions active in roughly the last
// StandbyIdle + ReclaimScanInterval, and it grows with the number of DISTINCT such
// sessions rather than with concurrency: on the shipped P4-on-P6 unit a handful of
// sessions each taking one turn inside that window can hold the whole budget in
// standbys while nothing is running. Without eviction those turns fail; the host then
// recovers by itself on the next sweep, so what is lost is a turn rather than the host.
//
// That bound is also why this is a burst fix and not a leak fix. It buys back the
// standbys of the coldest session inside the idle window — it does not and need not
// address anything beyond it, since past StandbyIdle there is nothing left to take. If a
// host is ever seen holding VMs for keys idle longer than that, this eviction would MASK
// it rather than fix it: that is a sweep bug and belongs in its own issue.
//
// Evicting is close to free — see evictForBudgetLocked for the cost argument.
//
// replenishOne deliberately does NOT come through here. Its refusal is already benign
// ("a refused refill is nobody's error"), and evicting a standby to manufacture
// another standby is pure churn: it moves RAM between runs without admitting any work
// that was not already admitted.
//
// ONLY THE MEMORY GATE EVICTS. Parking a run drops it out of unparkedRunsLocked, so
// this could be made to relieve the MaxRuns branch too — deliberately not done.
// MaxRuns bounds concurrent workspace KEYS and shedding a key's standbys does not
// shed the key, so using one mechanism to escape the other ceiling would re-conflate
// the two things spec §6 requires recorded distinctly. MaxRuns is also evaluated
// first inside admitLocked and a MaxRuns refusal returns here untouched, so a victim
// parked on the memory path can never retroactively widen the MaxRuns ceiling for the
// caller that caused the eviction.
func (p *pool) admitOrEvictLocked(newRun bool) error {
	err := p.admitLocked(newRun)
	if ReasonOf(err) != RefuseMemoryBudget {
		return err
	}
	p.evictForBudgetLocked()
	// Re-admitted, not assumed: eviction is best-effort (nothing idle to take, or the
	// reclaim queue already saturated), and a refusal must describe the host as it is
	// AFTER the attempt or its numbers send an operator to the wrong knob.
	return p.admitLocked(newRun)
}

// evictForBudgetLocked frees one VM's worth of memory by reclaiming a standby from the
// least-recently-used IDLE run. Caller holds p.mu. Best-effort and silent:
// admitOrEvictLocked re-measures rather than trusting a result.
//
// This is sweepOnce's RunActive -> RunParked transition fired by memory pressure
// instead of by the clock: drop a standby, STOP the replenish timers that would refill
// it, KEEP the workspace. Not firing the WorkspaceIdle half matters — a memory signal
// is about RAM, and deleting a live session's tree to make room for a different
// session would turn a recoverable cold start into #338's silent reset.
//
// WHY THIS IS CHEAP AND A REFUSAL IS NOT. An eviction costs the victim one cold
// acquire — the exact outcome StandbyIdle (90s) already produces for any run that goes
// quiet, with the workspace still on disk, so spec §4.4's "RAM is urgent and disk is
// not" is honoured rather than bypassed. A refusal costs the requesting session its
// turn.
//
// LRU BY lastExec, the same clock sweepOnce's idleFor reads, so eviction order and
// sweep order cannot disagree about which run is coldest.
//
// A BUSY RUN IS NEVER A CANDIDATE, for sweepOnce's reason: rp.busy() staying true is
// what stops a reclaim landing under a running command. That also makes self-eviction
// impossible at both call sites without a special case — runLocked's key has no
// runPool yet, and acquire only reaches the memory gate on a run whose ready list it
// has already found empty.
func (p *pool) evictForBudgetLocked() {
	// The send below happens UNDER p.mu and must not block, which this check is what
	// guarantees. Every sender (here and sweep) holds p.mu, so they are totally ordered
	// against each other, and reclaimLoop only ever drains — so capacity observed here
	// cannot be taken by anyone else before the send. A full queue means reclamation is
	// already behind, which is precisely the state where detaching more VMs would not
	// free memory any sooner: refuse instead. Checked BEFORE anything leaves rp.ready,
	// so a full queue costs nothing rather than losing a batch.
	if p.closed || len(p.reclaimQ) >= cap(p.reclaimQ) {
		return
	}

	var victim *runPool
	for _, rp := range p.runs {
		if rp.busy() || len(rp.ready) == 0 {
			continue
		}
		if victim == nil || rp.lastExec.Before(victim.lastExec) {
			victim = rp
		}
	}
	if victim == nil {
		return
	}

	// ONE VM, because one VM is what admission is short at both call sites. Taking the
	// whole ready list would shed a coldest run's entire standby depth to admit a single
	// warming, which is the reclaim storm spec §6 names. MaxReclaimsPerScan deliberately
	// does not appear here: it rate-limits the background sweep's bulk munmap against
	// the hot path, and this is already one VM on the hot path.
	n := len(victim.ready) - 1
	b := reclaimBatch{vms: []VM{victim.ready[n]}}
	victim.ready = victim.ready[:n]
	if len(victim.ready) == 0 {
		// Stopping these is load-bearing, not tidiness: a pending replenishment would
		// restore exactly the standby just evicted and re-consume the budget this call
		// exists to free, turning one admission into a refill race.
		for _, tm := range victim.pending {
			tm.Stop()
		}
		victim.pending = nil
		victim.parked = true
	}
	p.counters.evicted()
	p.reclaimQ <- b
}

// admitLocked decides whether one more VM may be committed. Caller holds p.mu.
//
// TWO CEILINGS, RECORDED DISTINCTLY. Spec §6: "A memory-driven refusal is recorded
// distinctly from a MaxRuns refusal, or the two ceilings get conflated and neither
// is diagnosable." E11 reports ExecErrors by cause for exactly this reason (§7.3).
//
// MaxRuns IS A BACKSTOP, not primary admission control. There is no "busy" frame in
// the wire contract, so a MaxRuns refusal reaches the harness as a failed exec
// rather than as back-pressure — while the harness already has the right mechanism
// one tier up: SandboxPoolSaturatedError at lease time under KAGENTI_SANDBOX_CAP.
// The consistency requirement is therefore
//
//	MaxRuns >= cap x (records this worker advertises)
//
// and violating it refuses work the harness believed it had capacity for, which is
// P6 §3.9's spurious-429s-truncate-the-rungs failure one tier down.
//
// PARKED RUNS DO NOT COUNT, and that is what makes the condition above true rather
// than aspirational. It used to count len(p.runs), which includes the parked entries
// the sweep deliberately keeps for WorkspaceIdle (30 minutes by default) — and a
// parked run holds ZERO VMs by construction, since sweepOnce only sets parked once
// len(rp.ready) has reached zero on a run that is not busy. With the shipped
// SH_MAX_RUNS=64, 64 short-lived sandboxes finishing inside a minute left 64
// zero-VM parked entries, and the 65th lease the harness legitimately granted was
// refused RefuseMaxRuns for the next ~29 minutes while nothing was resident. During
// E11 that would read as back-pressure from the tier rather than as the bug it is.
// Pool.Reclaim is the only thing that releases a key early and it has no production
// caller, so nothing else was going to shorten that window.
//
// What still bounds the parked set is WorkspaceIdle, and what it costs is disk rather
// than RAM (spec §4.4's whole reason for two thresholds). What bounds VMs is the
// memory gate below, which counts every VM a parked run does not have.
//
// The memory gate exists so spec §7.4's prediction 1 ("replenishment binds on
// process/memory count before CPU") is observable AS BACK-PRESSURE. Without it the
// prediction would be "confirmed" by the host falling over, which is not a
// measurement.
func (p *pool) admitLocked(newRun bool) error {
	if unparked := p.unparkedRunsLocked(); newRun && unparked >= p.cfg.MaxRuns {
		return refusal(RefuseMaxRuns,
			"MaxRuns=%d reached with %d unparked runs (%d entries incl. parked); the lease cap "+
				"one tier up is primary admission control and this is its backstop (spec §6)",
			p.cfg.MaxRuns, unparked, len(p.runs))
	}
	committed := p.committedLocked()
	budget := p.cfg.MaxCommittedBytes - p.cfg.MemoryReserveBytes
	if next := committed + p.perVMBytes(); next > budget {
		return refusal(RefuseMemoryBudget,
			"committing %d more bytes would reach %d against a budget of %d "+
				"(MaxCommittedBytes %d less MemoryReserveBytes %d)",
			p.perVMBytes(), next, budget, p.cfg.MaxCommittedBytes, p.cfg.MemoryReserveBytes)
	}
	return nil
}

// unparkedRunsLocked counts the runs MaxRuns is about: those not sitting in RunParked
// with zero VMs. Caller holds p.mu.
//
// Deliberately NOT the same quantity as Stats().ActiveRuns, which counts every map entry
// and reports the parked subset separately — Stats describes what the host is holding
// (including workspaces on disk), while this describes what the ceiling is for. The
// relationship is ActiveRuns - ParkedRuns == this.
func (p *pool) unparkedRunsLocked() int {
	n := 0
	for _, rp := range p.runs {
		if !rp.parked {
			n++
		}
	}
	return n
}

// committedLocked is every VM this host is holding, in bytes. Caller holds p.mu.
//
// Standbys are charged their FULL guest RAM even though they are paused and their
// memory files are CoW-shared, because a standby is one Resume away from consuming
// all of it. Admission control that charged the paused footprint would admit a host
// it cannot then run — the opposite of the PSS-vs-RSS error in spec §7.3, and in the
// dangerous direction rather than the pessimistic one.
func (p *pool) committedLocked() int64 {
	var vms int64
	for _, rp := range p.runs {
		vms += int64(len(rp.ready) + rp.inFlight + rp.warming)
	}
	return vms * p.perVMBytes()
}

// countRefusal records an already-built refusal and returns it unchanged, so the
// construction site keeps the detailed message and the counting stays in one place.
func (p *pool) countRefusal(err error) error {
	if r := ReasonOf(err); r != "" {
		p.counters.refuse(r)
	}
	return err
}
