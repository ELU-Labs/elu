# Claude Code

Sessions and reviews. Sign-in is `claude`'s own; ELU never reads your sign-in
token. The Usage tab names the account from `~/.claude.json` (email, organization,
plan and rate limit tier) and shows only the five-hour and weekly usage windows that
Claude Code prints during sessions. An account you add there runs with `CLAUDE_CONFIG_DIR`
set to a folder of its own that links to your `~/.claude` for everything but the sign-in
([../../SECURITY.md](../../SECURITY.md#several-accounts)); `claude auth login` signs it in on a
cleared screen under one line of ELU's, which on a computer with no browser (an SSH session,
or Linux with no display) says to open the link Claude Code prints. Tested releases:
2.1.319 and 2.1.322. The modes are described in
[../permissions.md](../permissions.md); this page is how `claude` is launched
for each.

## Read only

The launch: `--restricted --permission-mode dontAsk --permission-prompts none`,
`--safe-mode` unless your own MCP servers are on (it would drop them), an explicit
`--tools` list with no shell unless the role declares command prefixes, strict MCP
configuration (none for a review, a read-only turn or a teammate's question; for a task
saved without a mode, your own Claude Code servers, all of them unless `/mcp off NAME`
turned one off for the project), no setting sources,
disabled hooks, the OS sandbox with network off, and
`blockReadsOutsideWorkingDirectories`. An answer turn in a session saved without a
mode also gets `--add-dir` for your home folder and for a private copy of your Claude
Code memory, when there is one.

## Ask for approval, Approve for me, Full access

| | Ask | Auto | Full |
| --- | --- | --- | --- |
| `--permission-mode` | `default` | `auto` | `bypassPermissions` |
| `--permission-prompts` / `--permission-prompt-tool` | `host` / `mcp__elu-code-approval__approve` | same | same |
| `--restricted` / `--safe-mode` | no | no | no |
| `--input-format` | `stream-json`: the prompt is one user message and the input stays open for the network questions | text | text |
| `--tools` | `Read,Grep,Glob,Edit,Write,Bash,WebFetch,WebSearch` | same | same |
| `--allowedTools` | your MCP servers, `Read`, `Grep`, `Glob`, `Edit` and `Write` on the workspace | same | none |
| `--disallowedTools` | `Agent,Task,NotebookEdit,PowerShell,Monitor`; a turn with helpers, below | same | same |
| `--add-dir` | each folder of the session; an answer turn (yours, or a working bot's) also gets your home folder and a private copy of your Claude Code memory when there is one | same | same |
| Sandbox | on where it starts, never required; a host a command connects to asks you, and one you allowed stays allowed in the session; unsandboxed commands ask you | on where it starts, never required, no network; unsandboxed commands go to the reviewer | off |
| Asks | web tools; answer turns also edits in the project folder | answer-turn edits only | none |
| Denies | protected paths, writes in the folders of the session, secret reads, ELU state, the never list | same, without dependency files | secret reads, ELU state |

Every profile keeps `--setting-sources ''`, `--strict-mcp-config` with a private
config file and disabled hooks. `--max-budget-usd` is passed only when the session
has a spending limit (`/budget`) or the run is a teammate's question. The approval relay is the
one server ELU adds to that file; it is never in the allow list.

A folder you name with `/permissions folders add` is read and never written in Ask and
Auto: `Edit` and `Write` deny rules cover it and the sandbox's `denyWrite` lists it, the
way protected paths are kept. Claude Code lets a deny win over an allow, so a folder that
holds the workspace or lies inside it gets neither: for example the folder of all your
projects, where a worktree sits beside its repository. Nor does a folder that holds the
cache folder where the run keeps its temporary files (below). Not seen with the real
service yet.

The never list as deny rules, in Ask and Auto: `git push`, `git tag`, `git merge`, `gh pr merge`,
`gh release`, `npm publish`, `pnpm publish`, `yarn publish`, `cargo publish`,
`firebase deploy`, `vercel deploy`, `gcloud run deploy`, `gcloud app deploy`,
`fly deploy`, `kubectl apply`, `terraform apply`, `claude mcp add`,
`claude mcp add-json`, `claude mcp add-from-claude-desktop`, `claude mcp remove`,
`elu mcp add`, `elu mcp remove`. They match command text, so
`git -C . push` or a shell wrapper gets past them; in Ask the sandbox reaches no
host you did not allow (a push to `github.com` asks you for that host, and it is never kept
as a rule) and the common directory is read-only, which is what holds. A bot that is
allowed to merge pull requests (`@elu` comes allowed; a bot you make is not) runs its
own working turn without the `gh pr merge` rule; in Ask that command asks you instead.
Full access has none of these rules, no stand-in commands and no `CLAUDE_ENV_FILE`: a turn
there runs push, tags, merges, publishing and deploys as your own shell would.

A working bot's turn that may start helpers (see [../permissions.md](../permissions.md))
is launched with these changes: `--tools` adds `Agent`; `--allowedTools` adds
`Agent(executor)`, except in Full; `--disallowedTools` is
`NotebookEdit,PowerShell,Monitor`; `--agents` defines the one helper, `executor`, with
the turn's own tools and the helpers' model; the deny rules add each built-in agent type
and an `Agent` call that names a model or an isolation; and the settings and the
environment turn off built-in agents, forked agents, helpers of helpers and background
tasks, and force the helpers' model when the bot names one.

In Ask and Auto, stand-in commands (`lib/never-shims.mjs`) cover what those rules cannot read: a
script, `sh -c`, `npm test`. Claude Code starts each command from a snapshot of
your shell setup, which builds PATH again, so a folder put first on the PATH it was
started with ends up behind the system's. ELU sets `CLAUDE_ENV_FILE` to a
one-line file that puts the folder first again; Claude Code runs that file ahead of
each command. Seen on 2.1.322 in Ask for approval and in Approve for me: `npm test`
whose script ran `git push` to an origin on another machine printed `git push is
never allowed, in any mode.` (the words of that release; it now prints `git push is
not allowed outside Full access.`) and the push exited 126, and the run kept the
refusal for the chat; the same turn without the file reached `/usr/bin/git`.

Claude Code keeps files of its own while it runs. After every command it writes a
note of its working folder, and its sandboxed commands are given the same folder as
`TMPDIR`. Its own place for them is `/tmp/claude-<uid>`, and the sandbox ELU
sets for Read only, Ask for approval and Approve for me denies writes under `/tmp`,
so every sandboxed command ended `Exit code 1` whatever it did. In those modes ELU
names a private folder of the run in `CLAUDE_CODE_TMPDIR`:
`<cache folder>/elu/<two letters>`, yours alone to read, made for the run and
removed when it ends. The cache folder is `XDG_CACHE_HOME`, or `~/.cache`. Claude
Code uses a named folder for sandboxed commands only while `<folder>/claude-<uid>`
is at most 44 bytes. Where the cache folder is too long for that (a home folder of
more than nineteen bytes, with a three-digit user number) your own runtime folder
is tried, `XDG_RUNTIME_DIR` (`/run/user/<uid>` on Linux): the run's folder there is
`<runtime folder>/elu<two letters>`, which fits a ten-digit user number. Where
neither fits none is named, and commands there still end 1. Seen on 2.1.322 in Ask
for approval: `npm test` ended 0 with `TMPDIR` in the cache folder's place, and the
folder was gone after the run. Not seen with the real service: Approve for me, Read
only, Linux, the runtime folder.

A sandboxed command reads the repository's Git folder. The sandbox's `denyRead`
holds only ELU's records in it (`<Git folder>/elu-code`) and `denyWrite` holds
the whole folder; a teammate's question keeps the whole folder in `denyRead`. Seen
on 2.1.322 in Ask for approval, in an answer turn: `git status`, `git diff` and
`git log` ran in the sandbox with no approval asked; `git commit` ended 128 on
`index.lock: Operation not permitted`; `ls .git/elu-code` was refused. A text
filter named in the Git settings ran inside the sandbox when `git diff` used it:
it could write nothing, and its call to the network was refused. Not seen with the
real service: Approve for me, Read only, an edit turn in a worktree, Linux.

`parse` reads the profile Claude ran with from its init line. A run asked for
Auto that reports `default` is shown as Ask. Denied tool calls come back on the
result as `permission_denials` and are kept on the run.

On Linux, Claude Code's shell sandbox needs `bwrap` and `socat` on PATH, and `bwrap`
must be able to start (Ubuntu 24.04 needs an AppArmor profile for it; see Linux in
[permissions.md](../permissions.md)). Where the sandbox does not start, Claude Code
runs commands without one: Ask for approval asks you for each, and Approve for me
sends each to the reviewer. The Permissions picker says "No OS sandbox here" when a
tool is missing. Where both are installed and `bwrap` cannot start, Claude Code says
its sandbox is disabled; seen on 2.1.322, `npm test` then came to the owner as an
approval. The picker and `elu policy show` then say "The OS sandbox cannot start
here". Claude Code's sandbox always makes a user namespace, so ELU's start check
makes one too: where user namespaces are turned off, a `bwrap` run as root or
installed setuid still starts without one, and the sandbox does not. Nothing is
installed for you.

Not enforced or not verified on these releases: Bash rules match text only;
WebFetch runs outside the sandbox; a `bypassPermissions` run does not check
protected paths; whether Claude's auto reviewer counts toward the dollar budget.

## Network questions

In the default permission mode, a sandboxed command that connects to a host the settings do
not list makes Claude Code ask on its own output: a `control_request` with subtype
`can_use_tool`, tool `SandboxNetworkAccess` and input `{ host }`. It waits for a
`control_response` on its input and never calls the permission prompt tool for it. With the
prompt given as text, its input is closed once the prompt is read, the question cannot be
sent, and the host is denied with `(user denied)` though nobody was asked. Read from the
2.1.322 program, and seen in use: `curl https://elu.dev/api/mcp` ended
`CONNECT tunnel failed, response 403` in an Ask session. So in Ask ELU passes
`--input-format stream-json`, writes the prompt as one user message, answers each question
from your answer under Needs you (or a rule of yours), and closes the input after the
`result` line. A host you allowed is in `sandbox.network.allowedDomains` for the later turns
of the session. Not yet seen with the real service.
