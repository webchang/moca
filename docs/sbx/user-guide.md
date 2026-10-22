# Using the sandbox service (SBX0): a user guide

> **Preview.** The SBX0 sandbox service is implemented for an internal cohort, but not yet
> declared Stable; interfaces and limits may change. Known limits: [Limits](#6-limits).

This guide takes you from nothing installed to an agent's work applied in your own repository. You
need no MOCA background. The design is
[the SBX0 spec](../specs/2026-10-15-sbx0-internal-sandbox-service-design.md). Operators should read
[the runbook](../../deploy/sbx/RUNBOOK.md) instead.

## 1. What you get

Your coding agent (Claude Code or OpenCode) still runs on your laptop, but **every command it runs
runs in the sandbox service**, each one in a fresh virtual machine (VM). It reads, edits and tests
your code there, in a copy of your repository at `/workspace`. **Your laptop's tree is untouched**
until you take the agent's work back as a patch and apply it (`mocactl sbx pull --apply`).

Why this is safer than letting the agent run on your laptop:

- no process survives a call, so nothing the agent starts keeps running;
- the VM has no network, so nothing can be downloaded or sent out;
- the VM holds no secrets: no credentials, no tokens, none of your laptop's files except the ones
  you pushed.

## 2. Install

You need **Node.js 22 or later**, `git`, and a GitHub account that your operator has enrolled.
Install `mocactl`, the client. Since v0.7.0 the default channel, the latest release, carries
`mocactl sbx`:

```bash
curl -fsSL https://raw.githubusercontent.com/rossoctl/moca/main/scripts/install-mocactl.sh | sh
```

It installs `mocactl` into `~/.local/bin`, and prints a line to add to your shell's rc file if that
directory is not on your `PATH`. Re-running it upgrades to the latest release. Its closing hint
about `SH_CONTROL_PLANE_URL` is for MOCA's own server: ignore it here. Check that `sbx` is there:

```bash
mocactl --version     # v0.7.0 or later
mocactl sbx --help    # the first line: usage (the sandbox service, SBX0):
```

If `mocactl sbx --help` prints mocactl's general `usage:` list instead, with no `mocactl sbx`
lines (and a bare `mocactl sbx` says `unknown command "sbx"`), your `mocactl` predates v0.7.0:
re-run the install line above (or with `MOCACTL_VERSION=edge` for the newest build of `main`).

## 3. First run

Your operator gives you the sandbox service's URL, `https://<api host>`.

**Log in** with GitHub's device flow. The URL is remembered, so this is the only time you pass it:

```bash
mocactl sbx login --control-plane-url https://<api host>
```

```
Open https://github.com/login/device and enter the code ABCD-1234 (valid for 15 minutes)
logged in to the sandbox service as <your GitHub login>
```

If it says `this account (github:<id>) is not enrolled in the sandbox service; ask an operator to
add it`, send that `github:<id>` to your operator.

**Bring a repository up**: create its sandbox, push your working tree to it, and point your agents
at it:

```bash
cd <your repository>
mocactl sbx up
```

```
sbx: not pushed, as they may hold secrets (--include-secrets pushes them): .env
created sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a (default)
pushed 214 files (3.2 MiB) to sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a
configured Claude Code and OpenCode: .mcp.json, .claude/settings.json, opencode.json, CLAUDE.md, AGENTS.md
sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a
sandbox sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a (default), expires 2026-10-26T09:00:00.000Z; bound in .sbx/sandbox.json
```

Without `--template`, `up` uses the `default` template; `mocactl sbx templates` lists the others,
and `mocactl sbx up --template <id>` picks one. Run `up` again at any time: it reuses this
repository's sandbox while it is live.

**Each worktree gets its own sandbox.** A sandbox belongs to one working tree: another clone, or
another `git worktree` of the same repository, gets a sandbox of its own at its first `up`, so
two agents in two worktrees never share, or overwrite, one tree. Each counts toward your quota
of sandboxes ([Limits](#6-limits)): `mocactl sbx rm` the ones you are done with.

**Run your agent** in the repository, as you normally do:

```bash
claude
```

or

```bash
opencode
```

Claude Code may ask once to approve the project's `sandbox` MCP server: approve it. If it asks
whether you trust the folder, accept that too. Then ask for work as usual ("the tests fail, fix them"). The agent's tools are now `sandbox`'s
(`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls` and `sandbox_info`); its local tools are
denied.

Headless use (scripts, CI) works the same way, without the prompts:

```bash
claude -p "Fix the failing test and run the suite" --mcp-config .mcp.json --strict-mcp-config
opencode run "Fix the failing test and run the suite"
```

**Take the work back** when the agent is done:

```bash
mocactl sbx pull            # look at the patch first, if you like
mocactl sbx pull --apply
```

```
applied the sandbox's changes to 3 files (2814 bytes of patch)
```

`pull --apply` applies the patch to your working tree (not your index: review it with `git diff`,
then commit as usual) and records in the sandbox that you have it, so the next pull shows only newer
changes. When there is nothing new it says `nothing to pull`.

`pull --apply` never writes your local agent configuration or hooks: a patch that touches
`.mcp.json`, anything under `.claude/`, `opencode.json`, `opencode.jsonc`, `.opencode/`,
`.vscode/tasks.json`, `.vscode/settings.json`, `.husky/` or `.envrc` (at any depth, in any case),
or `.git` and `.sbx/`, is refused whole, naming each file and why, and nothing is applied. These
files can make your laptop run a command the next time an agent, an editor, git or direnv starts,
and they are often uncommitted, so `git diff` would not show the change. To take such a change,
save the patch with `mocactl sbx pull -o FILE`, read it, and apply what you want by hand
(`git apply --exclude=.claude/settings.json FILE` leaves a file out). A change to `CLAUDE.md` or
`AGENTS.md` outside the `sbx` block is applied, with a warning on stderr: review it before your
next agent session.

## 4. What `sbx up` changed in your repository

`up` **merges** into these files and never overwrites what you have. If a value already there
conflicts (say, a `sandbox` MCP server of your own), it stops before doing anything and names the
file and key.

| File                     | What `up` adds                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.mcp.json`              | `mcpServers.sandbox`: `mocactl sbx mcp`, the sandbox's tools over stdio                                                                                                                                                                  |
| `.claude/settings.json`  | `permissions.allow`: `mcp__sandbox__*`; `permissions.deny`: Claude Code's local tools (`Bash`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `NotebookEdit`, `WebFetch`, `WebSearch`, `Agent`, `Task`, …); `enabledMcpjsonServers`: `sandbox` |
| `opencode.json`          | `mcp.sandbox`: `mocactl sbx mcp`; `tools.<name>: false` for OpenCode's local tools (`bash`, `read`, `edit`, `write`, `patch`, `apply_patch`, `glob`, `grep`, `list`, `lsp`, `webfetch`, `websearch`, `task`, `multiedit`)                |
| `CLAUDE.md`, `AGENTS.md` | A block between `<!-- sbx:begin -->` and `<!-- sbx:end -->` telling the agent how the sandbox works (below)                                                                                                                              |
| `.sbx/`                  | `sandbox.json`, the binding (your sandbox's id and the service URL), and `agent-config.json`, the record of what `up` added. `.sbx/` is listed in `.git/info/exclude`, never in your `.gitignore`                                        |

They are ordinary files in your working tree, so `git status` shows them. Leave them uncommitted:
committed, they would point every teammate's agents at a sandbox and deny their local tools.
`mocactl sbx up --no-agent-config` creates and pushes without touching them.

### The first `claude` asks about the sandbox server

Start Claude Code from the repository root, where `up` wrote `.mcp.json` and
`.claude/settings.json`. On a fresh clone the first session asks about the server `up` wired
up, despite the `enabledMcpjsonServers` entry above:

```
New MCP server found in this project: sandbox

  Use this MCP server
  Use this and all future MCP servers in this project
❯ Continue without using this MCP server
```

Choose **"Use this MCP server"**. The highlighted default is the last line, so pressing Enter
declines, and declining writes `disabledMcpjsonServers: ["sandbox"]` into
`.claude/settings.local.json`. Together with the local tools denied in `.claude/settings.json`
that leaves the agent with no tools at all — and the marker suppresses the question on the next
run, so the state is easy to mistake for a broken sandbox. `mocactl sbx doctor` reports it:

```
Claude Code: .claude/settings.local.json disabledMcpjsonServers rejects the sandbox MCP server
```

To recover, delete `.claude/settings.local.json` (`up` never writes it) and start `claude` again.
Why the prompt appears at all despite `enabledMcpjsonServers` is
[#577](https://github.com/rossoctl/moca/issues/577).

**To undo it**, delete the sandbox:

```bash
mocactl sbx rm
```

```
deleted sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a; tokens already issued stop working within one token lifetime plus 30 s (15.5 minutes by default)
removed the agent configuration sbx up added: .mcp.json, .claude/settings.json, opencode.json, CLAUDE.md, AGENTS.md
removed .sbx/ (the binding)
```

`rm` takes back exactly what `up` added (a value you had before stays), then removes `.sbx/`.
`mocactl sbx rm --keep-config` deletes the sandbox and leaves the configuration. **Pull first:**
the sandbox's files go with it. `rm` checks, and refuses to delete a sandbox that holds work you
have not pulled:

```
sbx: the sandbox has changes not yet pulled, so sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a was not deleted: run mocactl sbx pull --apply to keep them, or mocactl sbx rm --force to delete it with them
```

An expired sandbox is deleted without the check: no command can reach its files any more, so
there is nothing left to pull. When the check cannot run for another reason (its template's
worker is down), `rm` says so, deletes nothing, and needs `--force`:

```
sbx: cannot check sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a for changes not yet pulled: sandbox failure: UNKNOWN: no live worker for sandbox 'sbx_default'; nothing was deleted. Pull them first if you can, or delete it anyway with mocactl sbx rm --force
```

`mocactl sbx rm --force` deletes without checking. The same check applies to `rm ID` for a sandbox
that is not bound here.

## 5. Working with it

- **Each call is a fresh VM.** Files under `/workspace` persist from one call to the next; nothing
  else does. No process survives a call: a server, a watcher or a background job started in one
  call is gone in the next. Chain the steps into one command instead (`make build && make test`).
- **No network.** Packages cannot be installed from the internet. The templates carry the
  toolchains: `mocactl sbx templates` lists them, with their tools.
- **One command at a time per sandbox.** The sandbox runs one call at a time, so batch the work:
  read several files in one call, run the whole test suite in one call. The agent's tools refuse a
  call that would wait more than 30 s behind another one with `sandbox busy: … retry later`, and
  the service refuses a third call in flight on one sandbox (from another terminal, say) the same
  way. The `CLAUDE.md`/`AGENTS.md` block tells the agent all of this.
- **Your secrets are not pushed.** `up` and `push` leave out `.env*`, `*.pem`, `*.key` and `id_*`
  files, and say so (`--include-secrets` pushes them; don't). Everything else that git would
  commit, plus your untracked files that are not ignored, is pushed.
- **Push again after you change files locally:**

  ```bash
  mocactl sbx push
  ```

  `push` replaces the sandbox's tree with yours. It refuses while the sandbox has changes you have
  not pulled; pull them first, or `mocactl sbx push --force` to discard them. `up` on a sandbox with
  changes not yet pulled leaves it unpushed, with a warning, and still succeeds.

- **Run a command yourself:**

  ```bash
  mocactl sbx run -- python3 -m unittest
  mocactl sbx run -- sh -c 'cd src && ls | wc -l'
  echo 'make test 2>&1 | tail -20' | mocactl sbx run
  ```

  `run -- CMD…` quotes each argument, so it runs exactly what you typed: use stdin or
  `-- sh -c '…'` for pipes, variables and globs. It exits with the command's own code, 124 when the
  command timed out, and 125 when the sandbox itself failed. Like `ssh`, it passes the remote
  side's terminal escape sequences through to your terminal.

- **Write a file into the sandbox** from stdin:

  ```bash
  mocactl sbx put data/fixture.json < fixture.json
  ```

  `put` writes only under `/workspace` (a relative path is taken from there).

## 6. Limits

- **Sandboxes expire after 7 days** by default (your operator may set another lifetime). Then the
  sandbox and its files are gone: pull before. `mocactl sbx ls` shows each sandbox's expiry, and
  `mocactl sbx doctor` fails its sandbox check in the last 24 hours. A sandbox's lifetime cannot be
  extended; for a fresh one, pull, `mocactl sbx rm`, then `mocactl sbx up` (an expired one is
  removed with `mocactl sbx rm --force`, as its files can no longer be checked).
- **3 sandboxes per person** by default, and a total for the whole service. Each worktree or clone
  you run `up` in uses one.
- **Delete and de-enrollment take effect within one token lifetime plus 30 s** (15 minutes by
  default, so 15.5 minutes). A sandbox token already issued keeps working until it expires. A
  command still running at that point is cancelled.
- **The longest single command is one token lifetime** (15 minutes by default). `run`'s
  `--timeout` defaults to, and is capped at, that lifetime minus 60 s. Split longer work into
  several calls.
- **Files over 12 MiB are not pushed** (`push` refuses and names them; `.gitignore` them), and a
  tree over 256 MiB is refused (`--max-push` sets another cap). A pull larger than 8 MiB as a
  patch is refused, never cut.
- **What a pull does not bring back:**
  - new files the agent creates in build output, at any depth: `node_modules/`, `.venv/`,
    `venv/`, `__pycache__/`, `.pytest_cache/`, `.mypy_cache/`, `*.pyc`, and any `build/`,
    `dist/` or `target/` directory. A `build/`, `dist/` or `target/` below the top level is pulled
    in full only if you pushed a file inside it (a source directory that happens to have such a
    name). The agent's edits to files you pushed in any of these do come back. A rename inside an
    excluded directory comes back as a bare delete, and a `push` replaces the agent's new files
    there without warning, since they never count as unpulled;
  - new files under a directory your own `.gitignore` ignores are not protected: they may not come
    back, and a `push` can replace them.
- **Pull --apply needs a recent git.** When your files have moved on since the push, the patch is
  merged 3-way; that uses `git apply --3way --cached`, which git accepts from version 2.32
  ([git 2.32 release notes](https://github.com/git/git/blob/master/Documentation/RelNotes/2.32.0.adoc)).
  When the patch does not apply as it is, and it touches a file you have uncommitted edits to, or
  conflicts with your local commits, it is refused and nothing is changed.
- **One shared KVM host, best effort.** Every sandbox runs on one shared machine, supported in
  business hours. If it is lost, every sandbox on it ends and its files are gone. Your laptop
  keeps the original tree, so pull often.

## 7. Using the API directly

The sandbox is also reachable from your own code over gRPC (`sandbox/v1`):

```bash
eval "$(mocactl sbx env)"
```

prints, for the bound sandbox, `export` lines for a client: `SBX_ADDR`, `SBX_TLS`,
`SBX_SANDBOX_ID`, `SBX_WORKSPACE_KEY`, `SBX_TOKEN_CMD` and, when the endpoint's certificate is
self-issued, `SBX_CA_FILE`. `mocactl sbx token` prints a fresh token. See
[the direct-client guide](../api/sandbox-v1-direct-client.md) for what a client sends.

## 8. Troubleshooting

Start with `mocactl sbx doctor` in the repository:

```bash
mocactl sbx doctor
```

```
ok - login: logged in to https://<api host> as <your GitHub login>
ok - sandbox: sbx-0f3a9c2e7b1d4a5f6e8c0b2d4a (default) is ready; expires 2026-10-26T09:00:00.000Z, in 6 d 23 h
ok - agent config: Claude Code and OpenCode use the sandbox MCP server, with every local tool denied in this repository's project config; user-level and managed settings are not checked
ok - exec: one `true` in a fresh VM: 412 ms
ok - changes: nothing to pull
ok - recent calls: 42 calls in the last 24 h: p50 380 ms, p95 1210 ms, 1 error (0 not the command's own)
```

It exits 0 when every check passes, else 1, and each failure prints its fix. What they mean:

| Check          | A failure means                                                                                                                                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login`        | Not logged in (run `mocactl sbx login`), not enrolled (send your operator the `github:<id>` it names), or the service is unreachable (check the URL and your network)                                                                                                         |
| `sandbox`      | No sandbox is bound here, it no longer exists, or it is terminated (deleted or expired): `mocactl sbx up` creates a new one. "less than 24 h left": pull its work now                                                                                                         |
| `agent config` | A local tool is enabled again, or the `sandbox` server is missing, in this repository's project files: `mocactl sbx up` merges it again. It checks the project's files only, not your user-level or managed settings; a local tool you enable there still acts on your laptop |
| `claude code`  | Shown only when it fails: the Claude Code on your `PATH` is older than 2.0.0, so its `MultiEdit`, `LS` and `NotebookRead` tools read or edit files on your laptop and are not denied. Run `claude update`                                                                     |
| `exec`         | The sandbox does not answer. Retry in a minute; if it persists, tell your operator (`mocactl sbx doctor --json` is what to send)                                                                                                                                              |
| `changes`      | A warning, not a failure: the sandbox holds work you have not pulled (`mocactl sbx pull --apply`), or the last push did not finish (`mocactl sbx push`)                                                                                                                       |

Other messages:

- **"not enrolled"**: your GitHub account is not on the service's list, or was removed. Send your
  operator the `github:<id>` in the message.
- **"sandbox failure: … no live worker for sandbox …"** (this is what "template unavailable" looks
  like today): the template's worker is not attached, usually because the KVM host is down or being
  maintained. Nothing you can fix; tell your operator, and wait.
- **"at most 3 live sandboxes per user"** or **"the sandbox service is at capacity"**: `mocactl sbx ls`
  shows yours; pull and `mocactl sbx rm` one you no longer need.
- **"template busy; retry later"**: too many users on that template at once. Retry in a while.
- **"sandbox busy: …"**: another call on your sandbox is still running (another terminal, or a
  parallel agent). Wait for it, or retry.
- **"the sandbox expires in N s; pull your work now"**: the sandbox is in its last minute, too
  short for a command to run, so even a pull can no longer reach it. In the minutes before, commands
  still run, with their timeout cut to what is left: pull then.
- **"sandbox has expired"** or **"sandbox was deleted"** (the agent sees "sandbox expired on …; run
  `mocactl sbx up` for a new one"): the sandbox is gone; `up` makes a new one and pushes your
  tree.
- **The agent still uses its local tools** (it edits files on your laptop): re-run
  `mocactl sbx up`, approve the `sandbox` MCP server and accept Claude Code's folder trust once,
  then restart the agent. `mocactl sbx doctor` names what is wrong. Check your user-level settings
  too, which `doctor` does not read.
- **TLS errors at login**: the service's certificate is not publicly trusted. Ask your operator for
  its CA and set `NODE_EXTRA_CA_CERTS=<ca.pem>` in your environment.

**Logging out.** `mocactl sbx logout` ends this login and deletes `sbx-auth.json` (in
`~/.config/mocactl/`). It is kept apart from `mocactl login`'s MOCA login: you can have both, and
logging out of one leaves the other.

## 9. Data handling

Your code sits on one shared KVM host that other users' sandboxes also run on. **Push internal
code only, and no secrets.** `sbx up` and `push` leave out common secret files by default (`.env*`,
`*.pem`, `*.key`, `id_*`), but they cannot know about every secret: keep credentials, tokens and
customer data out of the repositories you push.
