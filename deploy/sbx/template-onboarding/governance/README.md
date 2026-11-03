# Template governance: gating, provenance and the process

> **Preview.** Template gating and provenance is implemented but not yet declared Stable; interfaces
> and limits may change. Known limits: [the register](GAPS-AND-ASSUMPTIONS.md).

How a container image becomes a MOCA sandbox template that may be deployed, and how every deployed
image and template stays traceable. The tools are one level up, in
[`deploy/sbx/template-onboarding/`](../README.md); this folder holds what governs their use.

| Document                                             | What                                                                                                                                                      | Owner         |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| [`GATING-RULES.md`](GATING-RULES.md)                 | the gating rules for images and templates: MOCA's own (M) plus image-factory's extensions (X), each with its tier, evidence, record and enforcement       | image-factory |
| [`GAPS-AND-ASSUMPTIONS.md`](GAPS-AND-ASSUMPTIONS.md) | the register: the decisions this work rests on (D), gaps in gating (G), provenance (PV) and client status (S), the assumptions (A) and open questions (Q) | sbx-template  |
| [`PROCESS.md`](PROCESS.md)                           | the process, written while it is built: onboarding, gating, provenance, activation                                                                        | sbx-template  |
| [`INVENTORY-2026-11-02.md`](INVENTORY-2026-11-02.md) | MOCA's rules as found on 2026-11-02, with file and line (a snapshot, not kept current)                                                                    | sbx-template  |

## Why here

- **The process and the rules sit next to the tools that apply them** (`template-build.sh`,
  `template-register.sh`): MOCA's documentation rule puts how to run a deployment path next to its
  scripts ([`docs/CONTRIBUTING-DOCS.md`](../../../../docs/CONTRIBUTING-DOCS.md), "Where things go").
- **The register is kept beside the rules on purpose**, not in `docs/notes/`: it is the list of what
  the rules and tools do not cover yet, and changes with them.
- **The design** (its reasoning and alternatives) is a spec in `docs/specs/`, as that rule says:
  [template lifecycle, readiness and provenance](../../../../docs/specs/2026-11-03-template-lifecycle-and-provenance-design.md).

**This folder is movable.** Other documents link only to this README (the documentation map and the
design spec); the documents here link to each other by relative path. If MOCA's admin team wants it
elsewhere, moving it is one `git mv` and those links.
