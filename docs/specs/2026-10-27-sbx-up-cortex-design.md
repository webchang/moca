# `sbx up --cortex`: load the project's `CLAUDE.md` in a sandbox repo — design

Version: 1.0 — October 27, 2026
Status: Proposed

Builds on:

- SBX0 §6.3, the agent configuration `sbx up` writes ([`2026-10-15-sbx0-internal-sandbox-service-design.md`](2026-10-15-sbx0-internal-sandbox-service-design.md)).
- Cortex's `agentop script install moca-sandbox`, released in Cortex v0.9.3 (rossoctl/cortex#1507). The script is rossoctl/cortex#1495.

## 1. Problem

1. To keep Claude Code off its local tools, `sbx up` writes `permissions.deny` for 17 built-in tools into `.claude/settings.json` (§6.3).
2. The `Read` deny also stops Claude Code loading the project's `CLAUDE.md`. An allow rule cannot carve an exception out of a deny (#568).
3. #572 moved moca's own rules into the MCP server's instructions, so those reach the agent. The project's own `CLAUDE.md` still does not: its coding rules, its commands, what the team wrote there.

### 1.1 Facts this design rests on

Measured with Claude Code 2.1.295-2.1.309:

- Denying `Read` in settings drops `CLAUDE.md`; the other 16 denies do not.
- With the denies gone and nothing else in their place, the model calls local `Bash` when it judges that easier, even with the sandbox tools present.
- Claude Code runs a tool the model calls even when it is not in the tool list sent to the model.
- A project `.claude/settings.json` holding only the `mcp__sandbox__*` allow rule gives no approval prompts, interactive or headless.

Cortex's `moca-sandbox` script does the deny's job in the proxy, in sessions whose tool list carries `mcp__sandbox__*` tools:

- it removes the 17 local tools from the list the model sees;
- it renames a local `tool_use` in the response to `blocked__<name>`, so Claude Code answers "No such tool available" and runs nothing;
- it replaces the result of a local call that already ran with an error.

Live with a real model and a real sandbox, with the script and no denies: `CLAUDE.md` loaded and its rules were followed, only sandbox tools ran, and a prompt asking for local `Bash` was refused.

## 2. Goal

With Cortex installed, `sbx up --cortex` sets a repository up so that:

- Claude Code loads the project's `CLAUDE.md`;
- the model still cannot run local tools.

Without `--cortex`, `sbx up` is unchanged. moca does not require Cortex.

Out of scope:

- writing no project files at all. The ways to avoid them were weighed and rejected: an allow rule in user settings, `claude mcp add`, a launch command such as `mocactl sbx claude`;
- OpenCode, whose `tools: false` entries do not stop `AGENTS.md` loading;
- choosing a Cortex version other than the one installed (a later option);
- checking that Claude Code is routed through Cortex (see §5).

## 3. `sbx up --cortex`

A new flag on `up` only. `--cortex` with `--no-agent-config` is a usage error (exit 2): the second writes no agent configuration, and the first is a choice about it.

**Before anything is created, bound or pushed** (where `up` already checks the agent configuration):

1. **agentop.** `agentop --version` must answer `agentop vX.Y.Z` with `X.Y.Z` at least `0.9.3`, or `agentop dev…`.
   - Missing, unparseable or older: stop, exit 1, and say:
     `sbx up --cortex needs Cortex v0.9.3 or later: curl -fsSL https://www.rossoctl.dev/cortex/install.sh | sh`
2. **The script.** Run `agentop script install moca-sandbox` and wait for it, up to 60 s.
   - Exit 0: go on. This is safe to repeat: an installed copy is left alone, and an outdated one is updated.
   - Any other exit, or the timeout: stop, exit 1, and print agentop's stderr under `Cortex could not install moca-sandbox:`.
   - agentop's own output says when Cortex is not running and the slot takes effect at its next start. `up` prints it and goes on.

**After the push, where `up` writes the agent configuration today:**

3. Write §6.3's configuration **without the 17 `permissions.deny` entries**. Everything else is written as today:
   - the `.mcp.json` server;
   - `permissions.allow` `mcp__sandbox__*` and `enabledMcpjsonServers` `sandbox`;
   - `opencode.json`, its `tools: false` entries included;
   - the `CLAUDE.md`/`AGENTS.md` rules block.
4. **Remember the mode.** `.sbx/agent-config.json` gets a top-level `"cortex": true`. A later `sbx up` in that repository, with or without the flag, keeps Cortex mode and does not add the denies.
5. **Migrate.** In a repository whose record lists deny items `up` added earlier, those items are taken back. A deny the developer wrote by hand is not in the record, so it stays.

To leave Cortex mode, run `sbx rm`, then `sbx up` without the flag.

`up`'s closing message gains one line in Cortex mode:
`Cortex blocks local tools in this repo's Claude Code sessions; Claude Code must reach the model through Cortex (agentop configure claude-code).`

## 4. `sbx doctor`

In a repository whose record has `cortex: true`:

- **The deny check is skipped.** Every other agent-configuration check stays: the server, the allow rule, the enablement, OpenCode, the rules block.
- **New check, `cortex`.** Run `agentop script list --json`, and find `moca-sandbox` in its `scripts` array.

| Finding                                             | Result                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| agentop missing or older than v0.9.3                | FAIL, fix: the install one-liner                                              |
| `state` not `installed`                             | FAIL, the state named; fix: `agentop script install moca-sandbox`             |
| no `loaded` field (Cortex not running)              | FAIL: nothing blocks local tools; fix: start Cortex (`agentop service start`) |
| `loaded` below `scripts`, or `notStarted` above 0   | FAIL: the script did not start; fix: see Cortex's log                         |
| `installed`, `loaded == scripts`, `notStarted == 0` | ok                                                                            |

Outside Cortex mode, doctor is unchanged.

## 5. What is not checked

**Whether Claude Code reaches the model through Cortex.** agentop has no machine-readable answer: `agentop configure claude-code status` prints text and exits 0 either way. A repository in Cortex mode whose Claude Code bypasses Cortex runs with no blocking. That is a setup matter: `up`'s closing line and the docs name it.

## 6. `sbx rm`

- Unchanged: it takes back exactly what the record lists.
- The Cortex install stays: other repositories may use it, and it does nothing in sessions without the sandbox tools. `agentop script remove moca-sandbox` removes it.

## 7. Docs

- SBX0 §6.3 gains a paragraph on the Cortex mode, and the sentence "Claude Code never loads this `CLAUDE.md`" is qualified.
- `sbx up`'s usage line gains `[--cortex]`, with one line saying what it does.

## 8. Testing

vitest, in the existing files, through the harness's fake exec (`test/helpers/sbx.ts`):

- `sbx-cli.test.ts`: `--cortex` parses on `up` only; with `--no-agent-config` it exits 2.
- `sbx-up.test.ts`:
  - agentop missing, too old, `dev`, and current;
  - a failing install stops `up` before anything is created, bound or pushed;
  - the configuration written has no denies and is otherwise as today;
  - a later plain `up` keeps the mode;
  - migration takes back recorded denies and keeps hand-written ones;
  - `rm` takes everything back.
- `sbx-agent-config.test.ts`: `cortex` in the record round-trips; `checkAgentConfig` skips the denies only in Cortex mode.
- `sbx-doctor.test.ts`: each row of §4's table.

Live, before the PR is opened, in a VM with real moca and Cortex v0.9.3 on scratch ports:

- `CLAUDE.md` loads;
- local `Bash` comes back blocked;
- `doctor` passes;
- `rm` leaves the repository as it was.

## 9. Size

One PR, about 250 lines of code and 400 of tests.
