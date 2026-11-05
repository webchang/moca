#!/usr/bin/env python3
"""MOCA template lifecycle automation: an overview deck (design, workflow sequences, validation).

    .venv/bin/python make_template_lifecycle_pptx.py          # .pptx and .pdf beside this file

Sources, in the order they win (a slide restates them; change the source first):
  1. docs/specs/2026-11-03-template-lifecycle-and-provenance-design.md (states §3.3, API §4,
     host agent §6.1, first use §6.4, provenance §7, policy §8, validation §10.1)
  2. docs/specs/2026-11-05-combined-control-plane-design.md (one control plane, turns by build)
  3. deploy/sbx/template-onboarding/governance/GAPS-AND-ASSUMPTIONS.md (G19-G31)
  4. deploy/sbx/RUNBOOK.md §15 (the host agent, its units)
  5. the run record of windows 1-4 (on the user's machine; its numbers are copied below with the
     window they come from)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from deck_kit import *  # noqa: E402,F401

OUT = str(Path(__file__).resolve().parent / "template-lifecycle-overview.pptx")


# ------------------------------------------------------------------ a sequence-diagram helper
# One shape per participant kind, as on the architecture slides: the brain (the client agent and
# the harness) accent, the hands (workers) neutral, the control plane and relay outlined.

def lifelines(s, parts, top=1.45, bottom=6.75, w=1.9, h=0.62, size=12):
    """parts: [(x_centre, kind, title)]; draws the heads and dashed lifelines, returns x by name."""
    xs = {}
    for xc, kind, title in parts:
        x = xc - w / 2
        if kind == "brain":
            brain(s, x, top, w, h, title, size=size)
        elif kind == "hands":
            hands(s, x, top, w, h, title, size=size)
        elif kind == "store":
            store(s, x, top - 0.05, w, h + 0.1, title, size=size)
        else:
            orchestrator(s, x, top, w, h, title, size=size)
        arrow(s, xc, top + h, xc, bottom, color=RULE, w=1, dash=True, head=False)
        xs[title] = xc
    return xs


def msg(s, xs, a, b, y, t, dash=False, size=11, above=True):
    """A message from lifeline a to b at height y, its label above the arrow."""
    x1, x2 = xs[a], xs[b]
    arrow(s, x1, y, x2, y, color=INK if not dash else MUTED, dash=dash)
    lx, lw = min(x1, x2) + 0.05, abs(x2 - x1) - 0.1
    label(s, lx, y - 0.32 if above else y + 0.02, lw, 0.3, t, size=size,
          color=INK if not dash else MUTED)


def self_msg(s, xs, a, y, t, w=2.4, size=11):
    """A step a participant does itself: a short note to the right of its lifeline."""
    x = xs[a] + 0.08
    label(s, x, y - 0.15, w, 0.3, t, size=size, align=PP_ALIGN.LEFT, color=MUTED, italic=True)


# --------------------------------------------------------------------------- 1. Why and what

def s_problem(d):
    s = d.slide("Benchmarks need many templates; adding one was manual",
                "Where the work started (spec §1-§2)")
    text(s, 0.6, 1.5, 6.0, 4.6, [
        "**One template = one SWE-bench instance's environment**, as a microVM snapshot that "
        "every command of that instance runs in.",
        "**Before:** each template was a hand-run build, a hand-picked worker id, a settings "
        "edit and a redeploy of the control plane.",
        "**At scale:** 30+ per-instance templates, built and retired as experiments run, by "
        "clients that are not operators.",
        "**And proof:** which image, which checks, which snapshot served a given run.",
    ], size=15, bullets=True, gap=10)
    brain(s, 7.4, 1.6, 2.4, 0.9, "Client agent", ["the brain: plans, edits"], size=12)
    hands(s, 10.3, 1.6, 2.4, 0.9, "microVM", ["the hands: runs commands"], size=12)
    arrow(s, 9.8, 2.05, 10.3, 2.05)
    store(s, 7.4, 3.1, 5.3, 1.0, "One snapshot per template",
          ["the instance's repository, toolchain and tests"], size=12)
    note(s, 7.4, 4.6, 5.3, 1.3, "The goal (the user, 2026-11-02)",
         ["SWE-bench at scale on templates, self-serve and gated, validated end to end "
          "before any upstream PR"], size=12)


def s_design(d):
    s = d.slide("Self-serve: any enrolled client builds; policy, not a person, decides",
                "The design in four ideas (spec §3, §6-§8; D12-D13)")
    rows = [
        ("Templates are declared in a store", "a template is a name over immutable builds; a "
         "build's id is its snapshot's manifest hash"),
        ("Policy gates every image", "machine-checked rules at create and at registration; "
         "a `benchmark` profile needs a trusted gate record"),
        ("Hosts build and run; the control plane decides", "a host agent claims builds and "
         "starts workers; clients activate by lease, within quotas"),
        ("Every step is a chained record", "append-only provenance named by digest, "
         "verifiable offline with no access to the cluster"),
    ]
    y = 1.55
    for title, body in rows:
        orchestrator(s, 0.6, y, 4.2, 1.05, title, size=13)
        text(s, 5.1, y + 0.18, 7.6, 0.9, [body], size=14)
        y += 1.3


# --------------------------------------------------------------------------- 2. Architecture

def s_architecture(d):
    s = d.slide("One control plane decides; hosts build and run; clients only ask",
                "Who runs where: ykt3 (OpenShift) and bm1 (bare-metal KVM host)")
    brain(s, 0.5, 1.6, 2.6, 1.1, "Client", ["stock agent or `mocactl`"], size=12)
    orchestrator(s, 4.2, 1.5, 3.4, 1.3, "Control plane", ["catalog, policy, leases"], size=12)
    store(s, 4.4, 3.3, 3.0, 1.1, "Template store", ["catalog, provenance"], size=12)
    orchestrator(s, 4.2, 5.0, 3.4, 1.1, "Relay", ["routes Execs to workers"], size=12)
    brain(s, 9.2, 1.5, 3.4, 1.1, "Host agent", ["claims builds, starts workers"], size=12)
    hands(s, 9.2, 3.3, 3.4, 1.1, "Template workers", ["one per template, its snapshot"], size=12)
    hands(s, 9.2, 5.0, 3.4, 1.1, "microVMs", ["one per command, from the snapshot"], size=12)
    arrow(s, 3.1, 2.15, 4.2, 2.15)
    label(s, 2.9, 1.75, 1.5, 0.3, "create, activate", size=11)
    arrow(s, 5.9, 2.8, 5.9, 3.3, both=True)
    arrow(s, 7.6, 2.0, 9.2, 2.0, both=True)
    label(s, 7.6, 1.6, 1.6, 0.3, "claim, report", size=11)
    arrow(s, 10.9, 2.6, 10.9, 3.3)
    label(s, 11.0, 2.75, 1.6, 0.3, "start, stop", size=11, align=PP_ALIGN.LEFT)
    arrow(s, 9.2, 3.85, 7.6, 5.4)
    label(s, 7.8, 4.45, 1.5, 0.3, "attach", size=11)
    arrow(s, 10.9, 4.4, 10.9, 5.0)
    arrow(s, 1.8, 2.7, 4.2, 5.55)
    label(s, 1.4, 4.1, 2.2, 0.3, "Exec (sandbox token)", size=11)
    text(s, 0.5, 6.35, 12.2, 0.4, [
        "ykt3 holds no VM; bm1 holds no policy. The host agent reads its wanted state from the "
        "control plane and reports facts back; readiness is what the relay sees attached."],
        size=12, color=MUTED)


def s_states(d):
    s = d.slide("A build has two states: how far from usable, and whether it runs now",
                "Onboarding is set by the host's reports and policy; readiness by what is attached")
    steps = ["queued", "building", "probing", "built", "registered"]
    x = 0.6
    for i, st in enumerate(steps):
        box(s, x, 1.75, 2.05, 0.6, INFRA if i < 4 else ACCENT, None, [f"`{st}`"], size=13)
        if i < 4:
            arrow(s, x + 2.05, 2.05, x + 2.45, 2.05)
        x += 2.45
    label(s, 0.6, 1.4, 6, 0.3, "**Onboarding** (spec §3.3)", size=13, align=PP_ALIGN.LEFT,
          color=INK)
    text(s, 0.6, 2.55, 12.1, 0.7, [
        "Off the path: `failed` (a build or probe failure, with its step; or the owner's cancel), "
        "`rejected` (policy at registration, with its rule), `retired`."], size=12, color=MUTED)
    label(s, 0.6, 3.5, 6, 0.3, "**Readiness** of a registered build", size=13,
          align=PP_ALIGN.LEFT, color=INK)
    rd = [("inactive", "no worker attached"), ("activating", "a host was asked"),
          ("active", "its worker is attached"), ("deactivating", "live sandboxes drain")]
    x = 0.6
    for i, (st, why) in enumerate(rd):
        box(s, x, 3.85, 2.85, 0.95, INFRA if st != "active" else NEUTRAL, f"`{st}`", [why],
            size=12)
        if i < 3:
            arrow(s, x + 2.85, 4.32, x + 3.1, 4.32)
        x += 3.1
    text(s, 0.6, 5.1, 12.1, 0.9, [
        "`unavailable`: no host holds its snapshot, or every holder is full. `active` is derived "
        "from the relay's attached record, so the state cannot claim a worker that is not there."],
        size=12, color=MUTED)


# --------------------------------------------------------------------------- 3. Workflows

def s_seq_create(d):
    s = d.slide("Create to registered: no approver, every decision recorded",
                "Sequence 1: onboarding (spec §4, §6.1, §8)")
    xs = lifelines(s, [(1.4, "brain", "Client"), (4.6, "orch", "Control plane"),
                       (7.8, "store", "Provenance"), (11.2, "brain", "Host agent")])
    msg(s, xs, "Client", "Control plane", 2.55, "POST /v1/templates")
    self_msg(s, xs, "Control plane", 2.9, "create-time rules, quota", w=2.6)
    msg(s, xs, "Control plane", "Provenance", 3.35, "create, gate, check")
    msg(s, xs, "Control plane", "Client", 3.75, "202 queued, a build handle", dash=True)
    msg(s, xs, "Host agent", "Control plane", 4.3, "claim (every 2 min)")
    self_msg(s, xs, "Control plane", 4.65, "the host builds: pull, snapshot, probe", w=3.0)
    msg(s, xs, "Host agent", "Control plane", 5.2, "report built: T and S")
    self_msg(s, xs, "Control plane", 5.55, "registration rules", w=2.6)
    msg(s, xs, "Control plane", "Provenance", 6.0, "build, check")
    msg(s, xs, "Control plane", "Client", 6.4, "build registered: buildId = manifest hash",
        dash=True)


def s_seq_refusals(d):
    s = d.slide("Refusals are answers with a rule, not silence",
                "What a client sees when a create cannot proceed (spec §4, §8; G21, G22, G29)")
    table(s, 0.6, 1.5, 12.1, [
        ["Case", "Answer", "Recorded"],
        ["Policy refuses the create", "422 `policy_refused` with the rule id", "a `check` record"],
        ["Another subject owns the id", "409 `template_exists`", "nothing queued"],
        ["Same inputs as a build a host still holds", "200 or 202 with `reused: true`",
         "no second build"],
        ["Over a quota", "429 `quota_exceeded`, naming which", "nothing queued"],
        ["The owner withdraws a build", "cancel: `failed` at step `cancelled`", "a `build` record"],
        ["The build or probe fails on the host", "`failed`, with step and code (`probe_failed`)",
         "a `build` record"],
    ], [3.6, 4.6, 2.6], right_from=-1, size=13, row_h=0.55, bold_first_col=True)
    note(s, 0.6, 5.65, 12.1, 0.8, "Nothing that names where an image lives leaves the host",
         ["failure text is redacted; a record naming the registry is not sent at all (G25, G28)"],
         size=12)


def s_seq_activate(d):
    s = d.slide("Activation is a lease; the worker starts in seconds",
                "Sequence 2: activate, then a sandbox on the pinned build (spec §6.3; G31)")
    xs = lifelines(s, [(1.3, "brain", "Client"), (4.3, "orch", "Control plane"),
                       (7.3, "brain", "Host agent"), (10.0, "hands", "Worker"),
                       (12.2, "orch", "Relay")], w=1.75)
    msg(s, xs, "Client", "Control plane", 2.55, "activate {build}: a lease")
    self_msg(s, xs, "Control plane", 2.9, "place on a holder, within its limit")
    msg(s, xs, "Host agent", "Control plane", 3.4, "wanted? (every 15 s)")
    msg(s, xs, "Host agent", "Worker", 3.85, "systemctl start")
    msg(s, xs, "Worker", "Relay", 4.3, "attach: labels incl. build")
    msg(s, xs, "Control plane", "Client", 4.75, "readiness `active`", dash=True)
    msg(s, xs, "Client", "Control plane", 5.25, "POST /v1/sandboxes {id@buildId}")
    msg(s, xs, "Control plane", "Client", 5.65, "201, then a sandbox token", dash=True)
    msg(s, xs, "Client", "Relay", 6.15, "Exec over TLS: command, stdin")
    msg(s, xs, "Relay", "Worker", 6.5, "a fresh microVM runs it", size=10)


def s_first_use(d):
    s = d.slide("First use: name a template and go",
                "Activation on first use (spec §6.4), for sandboxes and sessions alike")
    xs = lifelines(s, [(1.8, "brain", "Client"), (6.0, "orch", "Control plane"),
                       (10.6, "brain", "Host agent")], bottom=5.25)
    msg(s, xs, "Client", "Control plane", 2.55, "create on a build that is not active")
    self_msg(s, xs, "Control plane", 2.9, "takes the caller's lease", w=3.0)
    msg(s, xs, "Control plane", "Client", 3.4, "409 template_not_active, Retry-After 30",
        dash=True)
    msg(s, xs, "Host agent", "Control plane", 3.95, "wanted? starts the worker")
    msg(s, xs, "Client", "Control plane", 4.55, "retry after the wait")
    msg(s, xs, "Control plane", "Client", 4.95, "201: created on the active build", dash=True)
    text(s, 0.6, 5.45, 12.1, 0.9, [
        "`activate: false` starts nothing. No sandbox is kept while waiting, so a wait never uses "
        "the caller's sandbox cap. `mocactl` retries for up to 10 minutes, saying why."],
        size=12, color=MUTED)
    note(s, 0.6, 6.45, 12.1, 0.4, "Without host agents nothing changes: the create succeeds "
         "as before", size=11)


def s_seq_session(d):
    s = d.slide("A Moca Pi session runs only on its build",
                "Sequence 3: a session pinned to a build (combined control plane §3.4; G19)")
    xs = lifelines(s, [(1.3, "brain", "Client"), (4.2, "orch", "Control plane"),
                       (7.2, "brain", "Harness"), (10.0, "orch", "Relay"),
                       (12.2, "hands", "Worker")], w=1.75)
    msg(s, xs, "Client", "Control plane", 2.55, "POST /v1/sessions {template@build}")
    msg(s, xs, "Control plane", "Client", 2.95, "a session token", dash=True)
    msg(s, xs, "Client", "Harness", 3.45, "a prompt, with the token")
    msg(s, xs, "Harness", "Control plane", 3.9, "exchange: model key, template, build")
    self_msg(s, xs, "Harness", 4.3, "agent loop: model, then tools", w=2.4)
    msg(s, xs, "Harness", "Relay", 4.8, "Exec to a worker of that build")
    msg(s, xs, "Relay", "Worker", 5.25, "microVM")
    msg(s, xs, "Harness", "Client", 5.75, "the streamed turn", dash=True)
    note(s, 0.6, 6.15, 12.1, 0.55, "The client never sends an Exec in this arm",
         ["the harness, inside the cluster, does; the worker is chosen by its `moca.dev/build` "
          "label"], size=11)


def s_combined(d):
    s = d.slide("One control plane serves both kinds of brain",
                "The combined route profile (combined control plane design, C1-C4)")
    brain(s, 0.6, 1.6, 3.6, 1.1, "Stock agent", ["creates sandboxes, sends Execs"], size=12)
    brain(s, 0.6, 3.3, 3.6, 1.1, "Moca Pi client", ["creates sessions, sends prompts"], size=12)
    orchestrator(s, 5.0, 2.2, 3.4, 1.6, "Control plane", ["profile `combined`",
                 "one catalog, quota, lease"], size=12)
    hands(s, 9.3, 2.4, 3.4, 1.1, "Workers of a build", ["serve both"], size=12)
    arrow(s, 4.2, 2.15, 5.0, 2.7)
    arrow(s, 4.2, 3.85, 5.0, 3.3)
    arrow(s, 8.4, 2.95, 9.3, 2.95)
    table(s, 0.6, 4.75, 12.1, [
        ["Decision", "Chosen"],
        ["C1 How", "a third profile, `combined`; `harness` and `sandbox` unchanged"],
        ["C2 Login", "open as on `harness`; enrollment checked on sandbox routes and template writes"],
        ["C3 Where", "a new namespace, so the validated SBX0 stays as it is"],
        ["C4 Turns by build", "in: a worker label and a filter (G19)"],
    ], [2.3, 9.8], right_from=-1, size=12, row_h=0.36, bold_first_col=True)


# --------------------------------------------------------------------------- 4. Provenance

def s_provenance(d):
    s = d.slide("Every step is a chained record, checkable offline",
                "Provenance (spec §7): digests, not signatures")
    flow = [("policy", "the profiles"), ("create", "image, spec"), ("gate", "record sha256"),
            ("build", "T and S"), ("check", "each rule"), ("activate", "host, lease")]
    x = 0.6
    for i, (k, v) in enumerate(flow):
        store(s, x, 1.65, 1.85, 1.0, f"`{k}`", [v], size=12)
        if i < len(flow) - 1:
            arrow(s, x + 1.85, 2.15, x + 2.07, 2.15)
        x += 2.07
    text(s, 0.6, 3.0, 12.1, 2.6, [
        "**One file per record**, named by the sha256 of its canonical JSON; each names its "
        "predecessor in `prev`, with a `seq`. Any edit, drop or reorder breaks the chain.",
        "**Stored in the control plane** on a volume, not Redis: records, a head per stream, "
        "and the cited gate records byte for byte.",
        "**Verified offline** by a stdlib Python script or the same rules in TypeScript, from an "
        "export, on a machine with no access to the cluster.",
    ], size=14, bullets=True, gap=10)
    note(s, 0.6, 5.75, 12.1, 0.7, "An export proves itself consistent, not complete",
         ["compare each stream's head with a copy kept elsewhere to catch a dropped tail"],
         size=12)


# --------------------------------------------------------------------------- 5. Validation

def s_windows(d):
    s = d.slide("Four windows validated the lifecycle end to end",
                "Spec §10 steps, as run 2026-11-04 to 2026-11-05 (no model)")
    table(s, 0.6, 1.5, 12.1, [
        ["Step", "Window 1", "Window 2", "Windows 3-4"],
        ["Create, build, register", "4 of 4", "4 of 4, fresh", "4 of 4 each"],
        ["Refused create (X10)", "yes", "yes", "yes"],
        ["Broken probe", "not reached", "`probe_failed`", "step `probe` (w4)"],
        ["First use", "not built", "409, then active", "as w2"],
        ["Served build = pinned", "4 of 4", "4 of 4", "4 of 4"],
        ["Patches match recordings", "not compared", "4 of 4", "4 of 4"],
        ["Offline verification", "83 records", "140 records, 12/12", "not repeated"],
    ], [3.4, 2.6, 3.0, 3.1], right_from=-1, size=13, row_h=0.5, bold_first_col=True)
    text(s, 0.6, 5.7, 12.1, 0.8, [
        "Step 3 (a second client on the same instance) passed separately with a second enrolled "
        "subject: its create and its new build `409`, its cancel `403`."], size=12, color=MUTED)


def s_activation_chart(d):
    s = d.slide("Activation fell from ~100 s to ~11-17 s",
                "Seconds from each activation's request to `active`, both builds of a pair "
                "together (G31)")
    # windows 3 and 4, request_to_active_s (autobench-moca's records, copied into the run record)
    bar_chart(s, 0.6, 1.5, 8.2, 4.9,
              ["first pair", "second pair"],
              {"window 3, build poll only": [107.4, 86.2],
               "window 4, wanted-state unit": [10.8, 17.4]},
              [NEUTRAL[1], ACCENT[1]], number_format="0.0")
    text(s, 9.2, 1.7, 3.5, 3.2, [
        "**Before:** an activation waited for the build poll, which starts 2 minutes after the "
        "previous one ends, and behind any build.",
        "**After:** a separate unit applies the wanted state every 15 s; a lock keeps it and "
        "the build poll from acting at once.",
    ], size=13, gap=10)
    note(s, 9.2, 5.1, 3.5, 1.2, "One pair per window",
         ["a measurement, not a distribution"], size=12)


def s_issues(d):
    s = d.slide("What the windows found, and the fixes",
                "Every finding has a register entry; MOCA's are fixed and validated")
    table(s, 0.6, 1.5, 12.1, [
        ["Id", "Found", "Fixed in", "Validated"],
        ["G26", "commands over 32 KiB hung the worker", "the worker: refused at once", "w2-w4"],
        ["G25, G28", "a registry host left the host in a reason", "host agent redaction",
         "w2-w4"],
        ["G21, G29", "duplicate builds; reuse of a removed snapshot", "control plane reuse rules",
         "w2-w4"],
        ["G31", "activation waited for the build poll", "the wanted-state unit", "w4"],
        ["G19", "a session could run on another build", "the build label and filter",
         "label w4"],
        ["G30", "~20 s client stalls", "the client's DNS (not MOCA)", "w4: 0 stalls"],
    ], [1.4, 4.6, 3.8, 1.8], right_from=-1, size=12, row_h=0.5, bold_first_col=True)
    note(s, 0.6, 5.3, 12.1, 0.9, "Not yet covered",
         ["a real model and grading (step 8); the combined control plane deployed (built, "
          "tested, not on a cluster)"], size=12)


# --------------------------------------------------------------------------- 6. Next

def s_next(d):
    s = d.slide("Next: deploy the combined plane, then a real model, then upstream",
                "In order, each with the user's decision first")
    rows = [
        ("1", "Deploy the combined control plane", "a new ykt3 namespace (a cluster-scoped "
         "change), a new image, a bm1 window with both brains"),
        ("2", "A real model and grading", "spec §10 step 8, with the model spend agreed"),
        ("3", "Propose upstream", "as PRs, from what the windows proved; upstream has no "
         "session templates today"),
    ]
    y = 1.65
    for n, t, b in rows:
        box(s, 0.6, y, 0.7, 0.9, ACCENT, None, [f"**{n}**"], size=18)
        text(s, 1.55, y + 0.05, 4.4, 0.9, [f"**{t}**"], size=16)
        text(s, 6.0, y + 0.05, 6.7, 0.95, [b], size=14, color=MUTED)
        y += 1.35
    note(s, 0.6, 5.8, 12.1, 0.6, "Built, not deployed",
         ["the combined control plane's increments 1-5 are tested and pushed, not run on a cluster"],
         size=12)


SECTIONS = [
    ("1", "Why and what", "the problem, and the design in four ideas", [s_problem, s_design]),
    ("2", "Architecture", "where each part runs, and a build's states",
     [s_architecture, s_states]),
    ("3", "Onboarding", "create to registered, and the refusals", [s_seq_create, s_seq_refusals]),
    ("4", "Using a template", "activation, first use, sessions, one control plane",
     [s_seq_activate, s_first_use, s_seq_session, s_combined]),
    ("5", "Provenance and validation", "records chained by digest; windows 1-4",
     [s_provenance, s_windows, s_activation_chart, s_issues]),
    ("6", "Next", "deploy, model, upstream", [s_next]),
]

if __name__ == "__main__":
    d = Deck("MOCA template lifecycle automation", footer="MOCA · template lifecycle", out=OUT,
             refuse=[
                 (r"\d{12}", "an account id or similar 12-digit number"),
                 (r"dkr\.ecr|amazonaws", "a registry host"),
                 (r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", "an IP address"),
                 (r"apps\.ykt3|\.ibm\.com", "an internal host name"),
                 (r"\b[0-9a-f]{64}\b", "a 64-hex value (a token, key or full digest)"),
                 (r"Bearer \S|BEGIN [A-Z ]*(KEY|CERTIFICATE)|kubeconfig|client-key-data",
                  "a credential or kubeconfig detail"),
             ])
    d.build(SECTIONS, lambda d: d.title_slide(
        "Self-serve sandbox templates, gated by policy, with provenance",
        "sbx-template · 2026-11-05"))
