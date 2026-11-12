#!/usr/bin/env python3
"""Moca user & template lifecycle automation: the 2026-11-12 meeting deck.

    .venv/bin/python make_moca_user_template_lifecycle_pptx.py   # .pptx and .pdf beside this file

A superset of make_template_lifecycle_pptx.py (the template overview, 2026-11-09): its slides are
imported from there unchanged, and this file adds self-serve user management, the policy profiles,
self-attested gate records, the client's path through mocactl, and the upstream PRs.

Sources, in the order they win (a slide restates them; change the source first):
  1. docs/specs/2026-11-08-enrollment-and-roles-api-design.md (the model §3, the API §4, effects §5,
     decisions §6, as built §8)
  2. docs/specs/2026-11-08-subject-trust-gate-records-design.md (the idea §2, profiles §3, rules §4,
     visibility §6)
  3. docs/specs/2026-11-10-mocactl-template-commands-design.md (the commands §3, as built §4a)
  4. docs/specs/2026-11-03-template-lifecycle-and-provenance-design.md (policy §8, quotas §6.2)
  5. the sources make_template_lifecycle_pptx.py names, for the slides imported from it
  6. the upstream PRs as `gh pr list -R rossoctl/moca` lists them on 2026-11-12 (numbers and titles)
  7. autobench-moca's run records: runs/l28b-7-d, l28b-6-d, l28b-3-d FINDINGS.md, and runs/g50-1-d
     rounds batch-1, batch-3 and batch-4 (the speed charts)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from deck_kit import *  # noqa: E402,F401
from make_template_lifecycle_pptx import (  # noqa: E402
    lifelines, msg, self_msg,
    s_motif, s_architecture, s_states,
    s_seq_create, s_seq_refusals,
    s_seq_activate, s_first_use, s_seq_session, s_combined, s_lifecycle_api,
    s_windows, s_lifecycle_window, s_activation_chart,
    s_lite28, s_two_brains, s_issues,
)

OUT = str(Path(__file__).resolve().parent / "2026-11-12-mtg-moca_user-template-lifecycle.pptx")


# --------------------------------------------------------------------------- 1. Why and what

def s_problem(d):
    s = d.slide("Users and templates both needed an operator; now both are API calls",
                "Where the work started (template spec §1-§2; enrollment spec §1)")
    text(s, 0.6, 1.5, 6.2, 4.5, [
        "**Templates:** each was a hand-run build, a hand-picked worker id, a settings edit and a "
        "redeploy; benchmarks need 30+ of them, built and retired by clients, not operators.",
        "**Users:** who may log in, and who is admin, were deployment settings; a change was a "
        "settings edit and a `setup.sh` run, and left no record.",
        "**One admin action took two cluster writes:** add a temporary admin by `setup.sh`, act "
        "through the API, remove the admin by `setup.sh` again.",
        "**And proof:** which image, which checks, which snapshot, and who changed whose access.",
    ], size=15, bullets=True, gap=10)
    box(s, 7.3, 1.6, 5.4, 0.9, INFRA, "Before",
        ["settings + `setup.sh` + redeploy, by an operator"], size=13)
    arrow(s, 10.0, 2.5, 10.0, 3.0)
    brain(s, 7.3, 3.0, 5.4, 0.9, "After",
          ["one API call or `mocactl` command, by the client or an admin"], size=13)
    note(s, 7.3, 4.3, 5.4, 0.85, "Every change is a provenance record",
         ["who, whom, what, and the value before"], size=12)


def s_design(d):
    s = d.slide("Self-serve: policy, not a person, decides; every step is recorded",
                "The design in five ideas (template spec §3, §6-§8; enrollment spec §3)")
    rows = [
        ("Templates are declared in a store", "a name over immutable builds, each named by "
         "its snapshot's manifest hash"),
        ("Policy gates every image", "rules checked at create; a build becomes `registered` by "
         "itself once its probe passes in a restored microVM and the rules hold again"),
        ("Hosts build and run; the control plane decides", "a host agent claims builds and "
         "starts workers; clients activate by lease"),
        ("Users and roles through the API", "the settings bootstrap the first admins; enroll, "
         "grant and revoke are API calls, evaluated per request"),
        ("Every step is a chained record", "append-only provenance named by digest, "
         "verifiable offline, off the cluster"),
    ]
    y = 1.5
    for title, body in rows:
        orchestrator(s, 0.6, y, 5.0, 0.92, title, size=13)
        text(s, 5.9, y + 0.14, 6.8, 0.8, [body], size=14)
        y += 1.08


# --------------------------------------------------------------------------- 2. Users

def s_users_model(d):
    s = d.slide("The settings name the first admins; the API manages everyone else",
                "Who may use the service, and who is admin (enrollment spec §3, §6)")
    store(s, 0.6, 1.6, 3.6, 1.25, "Settings (the bootstrap)",
          ["`SH_ALLOWED_SUBJECTS`", "`SH_ADMIN_SUBJECTS`"], size=12)
    store(s, 0.6, 3.5, 3.6, 1.25, "Members store",
          ["per subject: enrolled, roles,", "since, by; on the volume"], size=12)
    orchestrator(s, 5.0, 2.4, 3.2, 1.45, "Control plane",
                 ["evaluate roles and enrollment", "on every request"], size=12)
    arrow(s, 4.2, 2.2, 5.0, 2.9)
    arrow(s, 4.2, 4.1, 5.0, 3.4)
    label(s, 4.0, 4.3, 1.4, 0.3, "API changes", size=10)
    rows = [
        ("Settings admin", "enroll, unenroll, grant, revoke; cannot be revoked by the API"),
        ("API-granted admin", "templates, policy, quotas; read the list; change no one's access"),
        ("Enrolled subject", "log in, create and use templates within quota"),
    ]
    y = 1.55
    for t, b in rows:
        brain(s, 9.0, y, 3.7, 1.05, t, [b], size=11)
        y += 1.25
    arrow(s, 8.2, 3.1, 9.0, 3.1)
    note(s, 0.6, 5.55, 12.1, 0.8, "The recovery path stays the deployment's",
         ["the settings' admins are always admins: none can be revoked through the API, and none "
          "can revoke itself"], size=12)


def s_demo_users(d):
    s = d.slide("Demo: a user's lifecycle, in seven commands",
                "As the demo runs it: the admin on one laptop, the user on another (demo runbook §1, §5)",
                notes="Commands as the demo runs them, with the subject as github:<id>. Grant's "
                      "--until takes a duration (30m) or epoch seconds. Each admin write prints "
                      "old -> new and is refused if the login names another control plane.")
    table(s, 0.6, 1.45, 12.1, [
        ["Who", "Command", "What the room sees"],
        ["user", "`mocactl sbx login`", "GitHub's device code; `403 not_enrolled` until step 2"],
        ["admin", "`sbx admin subjects enroll github:<id>`", "a `member` record; the user's next "
         "request works"],
        ["admin", "`sbx admin subjects`", "each subject, its roles, and `env` or `api` as source"],
        ["admin", "`sbx admin subjects grant github:<id> --until 30m`", "the user's next request "
         "is admin"],
        ["admin", "`sbx templates quota github:<id> --templates 10 …`", "old → new; the user's "
         "`sbx quota` shows it"],
        ["admin", "`sbx admin subjects revoke github:<id>`", "admin gone at the next request"],
        ["admin", "`sbx admin subjects unenroll github:<id>`", "the user's next request: `403`"],
    ], [1.3, 5.6, 5.2], right_from=-1, size=12, row_h=0.47, bold_first_col=False)
    note(s, 0.6, 5.55, 12.1, 0.7, "No settings edit, no setup.sh, no redeploy",
         ["every step is an API call that takes effect at the next request and leaves a record"],
         size=12)


def s_demo_templates(d):
    s = d.slide("Demo: a template's lifecycle, image to retire",
                "As the demo runs it, as one enrolled user, profile `base` (demo runbook §1-§4)",
                notes="The spec is flat: its own id and image, guest_ram_mb, vcpus, egress, tools, "
                      "a probe (cmd, expect_rc, expect). Refusal 1 changes --image so it differs "
                      "from the spec's own (--image exists for a spec that names no image, and "
                      "must equal the spec's own when it does); refusal 2 asks for the benchmark "
                      "profile, which needs "
                      "a trusted gate record.")
    table(s, 0.6, 1.4, 12.1, [
        ["Step", "Command", "What the room sees"],
        ["1  what I may do", "`sbx quota`, `sbx policy`, `sbx hosts`",
         "limits and use, profiles, host slots"],
        ["2  check, then create", "`sbx templates create --spec F --dry-run`, then without",
         "local checks pass; a build queued"],
        ["3  follow the build", "`sbx templates follow ID`",
         "queued → building → probing → registered"],
        ["4  versions", "`templates build`, `tag`, `edit`", "a second build; a tag names one"],
        ["5  use", "`templates activate --wait`; `sbx create --template ID`; `sbx run`",
         "a lease; a sandbox on that build"],
        ["6  release, retire", "`templates deactivate`; `templates retire --wait`",
         "the worker stops; a later create: `410`"],
    ], [2.6, 5.6, 3.9], right_from=-1, size=12, row_h=0.44, bold_first_col=False)
    label(s, 0.6, 4.6, 6.0, 0.3, "Two refusals, shown between steps 2 and 3; nothing is built",
          size=12, color=INK, align=PP_ALIGN.LEFT)
    note(s, 0.6, 4.95, 5.95, 1.25, "1. Refused by mocactl, before sending",
         ["`create --spec F --image <another digest>`", "rule `M7.spec_image`: `--image` "
          "supplies an image a spec lacks, never a different one; refused locally, nothing "
          "sent"], size=12)
    note(s, 6.75, 4.95, 5.95, 1.25, "2. Refused by the control plane's policy",
         ["`create --spec F --profile benchmark`", "`422 policy_refused`: no trusted gate "
          "record; a `check` record"], size=12)
    text(s, 0.6, 6.3, 12.1, 0.35, [
        "Every step leaves a record on the template's chain: create, gate, build, check, "
        "activate, retire."], size=11, color=MUTED)

def s_users_api(d):
    s = d.slide("Five routes, one mocactl command; each change is a record",
                "Reads: any admin. Changes: an admin named in the settings (enrollment spec §4)")
    table(s, 0.6, 1.5, 12.1, [
        ["Change", "Route", "`mocactl sbx admin subjects …`", "Record"],
        ["list subjects, roles, source", "`GET /v1/subjects`", "(no argument)", "none"],
        ["enroll", "`PUT /v1/subjects/{s}`", "`enroll SUBJECT`", "`member`"],
        ["unenroll", "`DELETE /v1/subjects/{s}`", "`unenroll SUBJECT`", "`member`"],
        ["grant admin, optional expiry", "`PUT …/roles/admin`", "`grant SUBJECT --until T`",
         "`role`"],
        ["revoke admin", "`DELETE …/roles/admin`", "`revoke SUBJECT`", "`role`"],
    ], [3.3, 3.4, 3.4, 2.0], right_from=-1, size=12, row_h=0.44, bold_first_col=False)
    text(s, 0.6, 4.35, 7.6, 1.6, [
        "**Refusals:** `409 bootstrap_subject` for a subject the settings name; `409 "
        "admin_granted` for an unenroll while an admin grant keeps the subject enrolled; `403` "
        "for a non-admin.",
        "**The client checks its target:** a login for another control plane is refused before "
        "any write; each write prints old → new.",
    ], size=13, gap=8)
    note(s, 8.6, 4.4, 4.1, 1.45, "Subjects are login ids",
         ["`github:<numeric id>` (or `oidc:<sub>`), from the existing login; never a name"],
         size=12)


def s_users_seq(d):
    s = d.slide("A grant takes effect at the next request, and can expire by itself",
                "A temporary admin for one task, with no setup.sh (enrollment spec §5)")
    xs = lifelines(s, [(1.9, "brain", "Settings admin"), (5.4, "orchestrator", "Control plane"),
                       (8.9, "brain", "Temporary admin"), (11.9, "store", "Members stream")],
                   top=1.45, bottom=6.0, w=2.2)
    msg(s, xs, "Settings admin", "Control plane", 2.55, "grant admin, until T")
    msg(s, xs, "Control plane", "Members stream", 3.0, "`role` granted, until T")
    msg(s, xs, "Temporary admin", "Control plane", 3.65, "next request: admin now")
    self_msg(s, xs, "Control plane", 4.05, "roles read per request", w=2.6)
    msg(s, xs, "Temporary admin", "Control plane", 4.6, "act: a policy, a handover")
    msg(s, xs, "Temporary admin", "Control plane", 5.25, "a request after T: not admin")
    msg(s, xs, "Control plane", "Members stream", 5.7, "`role` expired, written once")
    note(s, 0.6, 6.15, 12.1, 0.5, "No revoke step and no redeploy: the grant lapses on its own",
         [], size=12)


def s_user_onboarding(d):
    s = d.slide("Onboarding a user: one GitHub login, one enroll",
                "Moca's own device-flow login; no token is pasted, no settings edit")
    steps = [
        ("1", "Get a GitHub account", "the subject is its numeric id, `github:<id>`"),
        ("2", "`mocactl sbx login`", "GitHub's device flow, through the deployment's OAuth "
         "app; `403 not_enrolled` until enrolled"),
        ("3", "An admin enrolls it", "`sbx admin subjects enroll github:<id>`; a `member` "
         "record names who did it"),
        ("4", "The next request works", "`sbx templates`, `sbx quota`, `sbx create`; no redeploy"),
    ]
    y = 1.55
    for n, t, b in steps:
        box(s, 0.6, y, 0.65, 0.8, ACCENT, None, [f"**{n}**"], size=18)
        text(s, 1.5, y + 0.04, 4.3, 0.8, [f"**{t}**"], size=15)
        text(s, 5.9, y + 0.04, 6.8, 0.85, [b], size=13, color=MUTED)
        y += 1.02
    note(s, 0.6, 5.75, 12.1, 0.7, "One login per control plane",
         ["each namespace is its own deployment: a user logs in to each one it uses, and is "
          "enrolled in each"], size=12)


# --------------------------------------------------------------------------- 3. Templates

def s_policy_profiles(d):
    s = d.slide("A create names a profile; the profile names the rules",
                "Policy profiles an admin sets (template spec §8; subject-trust spec §3)")
    table(s, 0.6, 1.5, 12.1, [
        ["Profile", "Gate record", "Egress", "For"],
        ["`base`", "none", "per spec", "general images, no benchmark claim"],
        ["`benchmark`", "trusted by an admin (X1)", "none (X11)", "curated benchmark tasks"],
        ["`benchmark-self`", "the creator's own (X1, self)", "none (X11)",
         "a user's own benchmark tasks"],
        ["`general-self`", "the creator's own (X1, self)", "the host's allowlist",
         "general users who need a network"],
    ], [2.6, 3.6, 2.4, 3.5], right_from=-1, size=12, row_h=0.46, bold_first_col=False)
    text(s, 0.6, 4.1, 7.4, 1.9, [
        "**Checked at create and at registration:** the id; the image, by digest, from an "
        "allowed registry and repository; the spec; the size envelope; each rule the profile "
        "names.",
        "**Quotas per subject:** templates owned, builds queued, templates active at once; "
        "`mocactl sbx quota` shows limit and use.",
    ], size=13, gap=8)
    note(s, 8.4, 4.15, 4.3, 1.1, "A refusal names its rule",
         ["`422 policy_refused` with the rule id, and a `check` record on the caller's own "
          "template's stream"], size=12)


def s_self_attest(d):
    s = d.slide("Your own gate record counts for your own templates, privately",
                "Trust comes from who submits a record, never from what it says (subject-trust "
                "spec §2-§6)")
    brain(s, 0.6, 1.7, 3.0, 1.1, "A user", ["submit its own gate record"], size=12)
    orchestrator(s, 4.4, 1.6, 3.6, 1.3, "Policy, self profile",
                 ["record for this image; commits", "refused; egress per profile"], size=12)
    store(s, 8.8, 1.7, 3.9, 1.1, "Self-attested template", ["private to its owner"], size=12)
    arrow(s, 3.6, 2.25, 4.4, 2.25)
    arrow(s, 8.0, 2.25, 8.8, 2.25)
    brain(s, 4.4, 3.6, 3.6, 1.1, "An admin", ["add the record to the trusted list"], size=12)
    store(s, 8.8, 3.6, 3.9, 1.1, "Shareable template", ["`deployment` visibility allowed"],
          size=12)
    arrow(s, 8.0, 4.15, 8.8, 4.15)
    arrow(s, 10.75, 2.8, 10.75, 3.6, dash=True)
    text(s, 0.6, 3.55, 3.5, 1.6, [
        "**Recomputed on every read:** removing trust narrows a shared template back to "
        "private; the policy change names each build.",
    ], size=12, color=MUTED)
    note(s, 0.6, 5.45, 12.1, 0.8, "Asking for `deployment` visibility before trust",
         ["is refused `409 self_attested`, on the create, on a new build, and on an edit"],
         size=12)


def s_mocactl_path(d):
    s = d.slide("The client's whole path, in mocactl",
                "Each step a command, `--json` on all of them (mocactl template commands spec §3, "
                "§4a)")
    table(s, 0.6, 1.5, 12.1, [
        ["Step", "Command", "What it does"],
        ["before a create", "`sbx quota`, `sbx policy`", "limits and use; the profiles and rules"],
        ["check locally", "`sbx templates create --dry-run`",
         "the rules the inputs decide; creates nothing"],
        ["create and follow", "`sbx templates create`, `follow`",
         "post the spec and gate record; wait for registered"],
        ["new build, cancel", "`sbx templates build`, `cancel`", "a build of an existing template"],
        ["activate, use", "`sbx templates activate --wait`, `sbx create --seed`",
         "lease a slot; seed the workspace"],
        ["end of life", "`sbx templates retire --wait`", "until no host holds the build"],
        ["users and admin", "`sbx admin subjects …`", "print old → new; detect a concurrent write"],
        ["a record per call", "`--record F`", "one line per HTTP attempt, no secret in it"],
    ], [2.6, 5.0, 4.5], right_from=-1, size=12, row_h=0.42, bold_first_col=False)
    note(s, 0.6, 5.55, 12.1, 0.7, "Errors keep the server's reason",
         ["the rule id, the quota hit, the readiness and the queue position; exit 5 for a wait "
          "that timed out"], size=12)


# --------------------------------------------------------------------------- 5. Provenance

def s_provenance(d):
    s = d.slide("Every step is a chained record, checkable offline",
                "Provenance (template spec §7; enrollment spec §8): digests, not signatures")
    flow = [("policy", "the profiles"), ("create", "image, spec"), ("gate", "record sha256"),
            ("build", "T and S"), ("check", "each rule"), ("activate", "host, lease")]
    x = 0.6
    for i, (k, v) in enumerate(flow):
        store(s, x, 1.6, 1.85, 1.0, f"`{k}`", [v], size=12)
        if i < len(flow) - 1:
            arrow(s, x + 1.85, 2.1, x + 2.07, 2.1)
        x += 2.07
    store(s, 0.6, 2.95, 3.9, 0.95, "`members` stream",
          ["`member` and `role` records"], size=12)
    text(s, 4.8, 3.0, 7.9, 0.9, [
        "Who enrolled or granted whom, the value before, and an `expired` record when a grant "
        "lapses."], size=13, color=MUTED)
    text(s, 0.6, 4.15, 12.1, 1.6, [
        "**One file per record**, named by the sha256 of its canonical JSON; each names its "
        "predecessor. Any edit, drop or reorder breaks the chain.",
        "**Verified offline** by a stdlib Python script or the same rules in TypeScript, from an "
        "export, on a machine with no access to the cluster.",
    ], size=14, bullets=True, gap=8)
    note(s, 0.6, 5.85, 12.1, 0.6, "An export proves itself consistent, not complete",
         ["compare each stream's head with a copy kept elsewhere to catch a dropped tail"],
         size=12)


def s_states_defined(d):
    """The overview's states slide, with "a build" defined once at its foot (this deck only)."""
    s_states(d)
    s = d.prs.slides[-1]
    box(s, 0.6, 5.85, 12.1, 0.62, INFRA, "A build, in Moca",
        ["the KVM host turns the template's container image into a microVM snapshot, then runs "
         "the spec's probe in a VM restored from it"], size=12, align=PP_ALIGN.LEFT)


# --------------------------------------------------------------------------- 5. Performance
# Figures from autobench-moca's run records (runs/<run>/FINDINGS.md), checked there 2026-11-12.
# Shared conditions: one KVM host (96 CPUs), 28 SWE-bench Lite templates (4 GiB guest RAM, 2 vCPUs,
# snapshots 7.3-13.6 GiB, median 7.6), start limit 4, active limit 28, worker budget 17,536 MiB,
# the page cache dropped before each cold round with no worker attached.
SHARED = ("one KVM host, 28 SWE-bench Lite templates (4 GiB, 2 vCPUs, snapshots 7.3-13.6 GiB), "
          "start limit 4, page cache dropped before each cold round")


def s_perf_disk(d):
    s = d.slide("Disk throughput sets the cold start: 3.1× faster",
                "Seconds until active, 28 activations posted at once, same builds; only the "
                "volume's throughput changed (l28b-7-d, D1 and D1b, 2026-11-11)",
                notes=SHARED)
    cats = ["first active", "fourth active", "all 28 active"]
    slow, fast = [250.3, 420.3, 1977], [96.5, 154.5, 638]
    assert round(slow[-1] / fast[-1], 1) == 3.1
    bar_chart(s, 0.6, 1.5, 8.0, 4.4, cats,
              {"125 MiB/s": slow, "750 MiB/s": fast},
              [NEUTRAL[1], ACCENT[1]], number_format="#,##0.0")
    text(s, 9.0, 1.65, 3.7, 2.6, [
        "**Mean disk read:** 116.1 → 364.7 MiB/s over the round.",
        "**Time per read:** 6.99 → 1.65 ms, at 3,000 IOPS both times.",
    ], size=13, gap=10)
    note(s, 9.0, 4.35, 3.7, 1.55, "Each cold start read about its whole snapshot",
         ["a mean of 8.70 GiB per start at 750 MiB/s: reading less per start is the next "
          "lever"], size=12)
    text(s, 0.6, 6.1, 12.1, 0.4, [SHARED], size=11, color=MUTED)


def s_perf_warm(d):
    s = d.slide("A warm worker activates in seconds: 7 s, not 980 s",
                "Mean seconds per activation, 28 posted at once, three rounds back to back "
                "(l28b-6-d, 2026-11-10/11, at 125 MiB/s)",
                notes=SHARED + "; idle grace 900 s")
    bar_chart(s, 0.6, 1.5, 8.0, 4.4, ["D1, cold", "D2.1, warm", "D2.2, warm"],
              {"mean": [979.8, 7.0, 7.1], "max": [1690.1, 10.5, 10.6]},
              [NEUTRAL[1], ACCENT[1]], number_format="#,##0.0")
    text(s, 9.0, 1.65, 3.7, 2.4, [
        "**Warm by the idle grace (900 s):** a released worker stays attached, so the next "
        "activation needs no restore from disk.",
        "**All 28 done after:** 1,809 s cold; 19 s in each warm round.",
    ], size=13, gap=10)
    note(s, 9.0, 4.3, 3.7, 1.6, "D1's mean covers 23 activations",
         ["the client stopped waiting on 5, which the control plane completed; in both warm "
          "rounds all 28 workers were still attached"], size=12)
    text(s, 0.6, 6.1, 12.1, 0.4, [SHARED], size=11, color=MUTED)


def s_perf_queue(d):
    s = d.slide("28 cold starts at once queue behind the start limit",
                "Seconds until active; alone, a cold start takes about 78 s (125 MiB/s, start limit "
                "4; l28b-3-d serial-1, 2026-11-09/10; l28b-7-d D1, 2026-11-11)",
                notes=SHARED + "; the serial pass released each template with stopNow and "
                      "dropped no cache between templates")
    bar_chart(s, 0.6, 1.5, 8.0, 4.4,
              ["one at a time, mean", "one at a time, max", "28 at once, first active",
               "28 at once, last active"],
              {"seconds": [78, 120, 250.3, 1968.5]},
              [NEUTRAL[1]], number_format="#,##0.0")
    text(s, 9.0, 1.65, 3.7, 2.6, [
        "**Four start at a time:** the rest wait, so the last of 28 is active after about "
        "33 minutes.",
        "**Then the disk:** four starts at once share one volume's throughput (previous charts).",
    ], size=13, gap=10)
    note(s, 9.0, 4.45, 3.7, 1.0, "One pass per condition",
         ["a measurement, not a distribution"], size=12)
    text(s, 0.6, 6.1, 12.1, 0.4, [SHARED], size=11, color=MUTED)


def s_perf_cache(d):
    # runs/g50-1-d/rounds/batch-1 (the cache as first built) and batch-3 (13179c7b's worker), each
    # instance's request_to_active_s; read per start, the 72.87 GiB total and the files re-hashed
    # from runs/g50-1-d/FINDINGS.md ("Bytes read", from the diskstats counters; "Journal lines").
    s = d.slide("The fixed verify cache halves a cold start's reads",
                "Seconds until active, 8 cold activations posted at once (G50 window, 2026-11-12, "
                "750 MiB/s, start limit 4)",
                notes="8 SWE-bench Lite templates (4 GiB guest RAM, snapshots 7.3-13.5 GiB, 72.87 "
                      "GiB in all); page cache dropped before each round; activations only; each "
                      "worker had one restore since its cache was seeded. Before = the cache as "
                      "first built, which missed after every restore (ctime in its identity).")
    before, after = [84.5, 143.2, 204.0], [47.5, 49.3, 100.7]
    assert round(before[-1] / after[-1], 1) == 2.0
    bar_chart(s, 0.6, 1.5, 8.0, 4.4, ["first active", "fourth active", "all 8 active"],
              {"cache as first built": before, "cache fixed": after},
              [NEUTRAL[1], ACCENT[1]], number_format="#,##0.0")
    text(s, 9.0, 1.65, 3.7, 2.6, [
        "**Read per start:** 8.99 → 4.00 GiB, the memory file alone, which a start still "
        "pins.",
        "**Files re-hashed per start:** 4 of 4 → 0 of 4.",
    ], size=13, gap=10)
    note(s, 9.0, 4.4, 3.7, 1.5, "Why the first build missed",
         ["each VM restore links and chowns the files into its jail, which moved the ctime the "
          "cache keyed on"], size=12)
    text(s, 0.6, 6.1, 12.1, 0.4, [
        "one KVM host, 8 SWE-bench Lite templates (4 GiB, snapshots 7.3-13.5 GiB), page cache "
        "dropped before each round"], size=11, color=MUTED)


def s_perf_readahead(d):
    # runs/g50-1-d/FINDINGS.md "D1c step 2": batch-3 (read_ahead_kb 128) against batch-4 (512),
    # each instance's request_to_active_s in rounds/batch-3 and batch-4; busy-interval medians and
    # reads per start from the same section.
    s = d.slide("Read-ahead 512 lets the disk reach its cap",
                "Seconds until active, 8 cold activations at once, fixed verify cache; only "
                "read_ahead_kb changed: 1.6× faster (G50, 2026-11-12)",
                notes="As slide 30: 8 SWE-bench Lite templates, 750 MiB/s volume, start limit 4, "
                      "page cache dropped before each round, activations only. read_ahead_kb was "
                      "set back to 128 after the round.")
    ra128, ra512 = [47.5, 49.3, 100.7], [29.2, 30.9, 62.2]
    assert round(ra128[-1] / ra512[-1], 1) == 1.6
    bar_chart(s, 0.6, 1.5, 8.0, 4.4, ["first active", "fourth active", "all 8 active"],
              {"read_ahead_kb 128": ra128, "read_ahead_kb 512": ra512},
              [NEUTRAL[1], ACCENT[1]], number_format="#,##0.0")
    text(s, 9.0, 1.65, 3.7, 2.8, [
        "**Disk, busy intervals:** 420.8 → 742.3 MiB/s median, at the volume's 750 MiB/s cap.",
        "**Same work:** about 4 GiB read per start; reads stayed 127.5 KiB, the device's largest.",
    ], size=13, gap=10)
    note(s, 9.0, 4.55, 3.7, 1.25, "One round per setting",
         ["a measurement, not a distribution"], size=12)
    text(s, 0.6, 6.1, 12.1, 0.4, [
        "one KVM host, 8 SWE-bench Lite templates (4 GiB, snapshots 7.3-13.5 GiB), page cache "
        "dropped before each round"], size=11, color=MUTED)


# --------------------------------------------------------------------------- 6. Upstream, next

# The upstream PRs (gh pr list -R rossoctl/moca, 2026-11-12), grouped by what they bring.
UPSTREAM = [
    ["Users", "#762", "enroll subjects and grant the admin role through the API"],
    ["Templates", "#760", "a template store with builds, tags and readiness"],
    ["", "#766", "self-serve create, gated by policy, with quotas"],
    ["", "#769", "a subject's own gate record, for its own templates"],
    ["", "#759", "a Moca Pi session can choose a sandbox template"],
    ["Provenance", "#756", "template provenance in a hash chain, verifiable offline"],
    ["mocactl", "#767, #768", "authoring commands; `--record`; token renewal"],
    ["", "#761, #755", "retry a refused command (exit 75); `--version`"],
    ["Hosts", "#757, #758", "microVM worker and snapshot fixes; deploy fixes"],
    ["", "#771, #772", "from an image to a registered template; the host agent"],
    ["", "#773", "a verify cache: a start re-hashes only changed snapshot files"],
]


def s_upstream(d):
    s = d.slide("The enhancements are open upstream, as reviewable PRs",
                "rossoctl/moca, 2026-11-12: each stacked where it builds on another")
    table(s, 0.6, 1.4, 12.1, [["Area", "PRs", "What it brings"]] + UPSTREAM,
          [2.2, 2.2, 7.7], right_from=-1, size=12, row_h=0.36, bold_first_col=True)
    note(s, 0.6, 5.95, 12.1, 0.6, "Each one reviewed before its push",
         ["a tree check, a deploy-input diff, and a scan for hosts, ids, tokens and results"],
         size=12)


def s_next(d):
    s = d.slide("Next: land the PRs upstream, then the demo",
                "In order, each with the user's decision first")
    rows = [
        ("1", "Upstream review", "answer the reviews of the open PRs; land them in stack order"),
        ("2", "The next PRs", "activation, removal, memory, pacing and egress (#742-#745, "
         "#752), on the host agent (#772)"),
        ("3", "The demo, not before 2026-11-19", "self-serve template and user lifecycle, live, "
         "on the tip the G50 window tested"),
    ]
    y = 1.65
    for n, t, b in rows:
        box(s, 0.6, y, 0.7, 0.9, ACCENT, None, [f"**{n}**"], size=18)
        text(s, 1.55, y + 0.05, 4.4, 0.9, [f"**{t}**"], size=16)
        text(s, 6.0, y + 0.05, 6.7, 0.95, [b], size=14, color=MUTED)
        y += 1.35
    box(s, 0.6, 5.8, 12.1, 0.6, INFRA, "Done since",
        ["synced with upstream main and tested on both namespaces; roles through the API on both; "
         "the client's whole path in mocactl"], size=12, align=PP_ALIGN.LEFT)


SECTIONS = [
    ("1", "Why and what", "motif, design, architecture",
     [s_motif, s_design, s_architecture]),
    ("2", "Users, and the demo", "bootstrap; the demo's commands; API; roles",
     [s_users_model, s_demo_users, s_demo_templates, s_users_api, s_users_seq,
      s_user_onboarding]),
    ("3", "Self-serve templates", "create, refusals, profiles, records",
     [s_seq_create, s_seq_refusals, s_policy_profiles, s_self_attest, s_mocactl_path,
      s_provenance]),
    ("4", "Using a template", "a build's states, activation, sessions",
     [s_states_defined, s_seq_activate, s_first_use, s_seq_session, s_combined, s_lifecycle_api]),
    ("5", "Validation and speed", "windows 1-4; cold and warm starts",
     [s_windows, s_lifecycle_window, s_activation_chart, s_perf_disk,
      s_perf_warm, s_perf_queue, s_perf_cache, s_perf_readahead]),
    ("6", "At scale, upstream, next", "Lite-28, findings, PRs, next",
     [s_lite28, s_two_brains, s_issues, s_upstream, s_next]),
    ("B", "Backup", "", [s_problem]),
]

if __name__ == "__main__":
    d = Deck("Moca User & template lifecycle automation",
             footer="Moca · user & template lifecycle", out=OUT,
             refuse=[
                 (r"\d{12}", "an account id or similar 12-digit number"),
                 (r"dkr\.ecr|amazonaws", "a registry host"),
                 (r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", "an IP address"),
                 (r"apps\.ykt3|\.ibm\.com|vpc-int", "an internal host name"),
                 (r"\b[0-9a-f]{64}\b", "a 64-hex value (a token, key or full digest)"),
                 (r"Bearer \S|BEGIN [A-Z ]*(KEY|CERTIFICATE)|kubeconfig|client-key-data",
                  "a credential or kubeconfig detail"),
                 (r"github:\d{4,}", "a real GitHub subject id"),
                 (r"\b\d+ (passed|failed|resolved)\b|pass rate|resolution rate",
                  "a benchmark result"),
             ])
    d.outline_size = 10  # five long titles in a section: the floor, never under it
    d.build(SECTIONS, lambda d: d.title_slide(
        "Self-service workflows with policy-based gates and provenance tracking",
        "2026-11-12"))
