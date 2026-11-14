# Claude Code

Sessions and reviews. Sign-in is `claude`'s own; ELU never reads your sign-in
token. The Usage tab names the account from `~/.claude.json` (email, organization,
plan and rate limit tier) and shows only the five-hour and weekly usage windows that
Claude Code prints during sessions. An account you add there runs with `CLAUDE_CONFIG_DIR`
set to a folder of its own that links to your `~/.claude` for everything but the sign-in
([../../SECURITY.md](../../SECURITY.md#several-accounts)); `claude auth login` signs it in on a
cleared screen under one line of ELU's. On a computer with no browser (an SSH session, or
Linux with no display) `claude auth login` has no device code sign-in (`--help`, 2.1.322): it
prints a link and waits for the code that page shows, so ELU's lines say to open the link on
any computer and paste its code there, and that nothing shows as you paste: Claude Code reads
the code without showing it, and sends it as it came. ELU turns its paste marks off while a
sign-in has the terminal, or Claude Code would send them as part of the code. ELU waits as long
as the sign-in takes; Ctrl-C ends it and ELU comes back. Tested releases:
2.1.319 and 2.1.322. The modes are described in
[../permissions.md](../permissions.md); this page is how `claude` is launched
for each.

## Messages you send while a turn works

Every turn of yours in your own session, and every turn of a bot you wrote to, starts with
`--input-format stream-json`, in every mode, Read only too: the prompt goes in as one user
message and the input stays open until the turn writes its `result` line. A message you
send while the turn works goes on that input at once, as one more user message with a uuid
(`{"type":"user","message":{"role":"user","content":...},"parent_tool_use_id":null,"uuid":...,"origin":{"kind":"human"}}`),
with a line that tells the model you wrote again during its turn and that its reply answers
that too. Claude Code takes a user message that comes while it works in at the turn's next
step, and the turn goes on with it; the one reply answers everything. For a message with a
uuid it writes `command_lifecycle` lines (`queued`, `started`, `completed`, or `cancelled`).
Until `started`, the chat says under the message "The running turn reads it when the
command it is running ends.": behind one long command, the next step is when that command
ends. Once
`started` comes, the chat shows your message where you sent it, with "Sent to the running
turn." under it, and the session's history keeps it once. Several go in the order you sent
them. Only a message for the one working turns go: yours to the model while the model
works, yours to a bot while that bot works. A message to someone else waits for the turn to
end, and so does every message sent after it.

Enter in the empty message box sends a waiting message now. ELU writes Claude Code's own
control request for it (`{"subtype":"interrupt","send_now":true,"message_uuid":...}`).
Claude Code answers `delivering` when the command the turn waits on can move to the
background: the command keeps running there, the turn reads your message at once and goes
on. It answers `stopped` when nothing can move: the turn is cut, its `result` line says
`error_during_execution`, and your message starts the next turn of the same run, in the
same session, with nothing started again. `↑` takes a waiting message back with
`{"subtype":"cancel_async_message","message_uuid":...}`; one the turn already took stays
sent, and the chat says so. All of this is used only when the run's first line names the
capabilities `msg_lifecycle_v1` and `interrupt_send_now_v1`. A Claude Code release that
names neither gets no message while it works: there a message is answered at once beside
the turn, by a short read-only run on the session's model, and Enter stops the turn first,
as on the vendors that take none. Read from the 2.1.322 program; the
messages above were driven with the stand-in CLI, not yet with the real service.

A turn ends at its `result` line. When Claude Code is still there three seconds after it,
waiting on a command the turn left in the background, ELU ends it with that command, and
the chat names the command. A `result` line is not the end of the run while a message of
yours on its input is still owed an answer: after a send now that cut the turn, the run
goes on with your message, and with any you send meanwhile, and the three seconds count
from the `result` line of the last of those turns. `/stop` stops such a run whole: a message
it had taken stays in the chat, and one that still waited starts the next turn, in the
same session.

Read from the 2.1.323 program (a queued prompt is folded into a running turn at
its next tool step; one that comes after the last step runs as one more turn of the same
run, with a `result` line of its own, after the input closes) and from its change log
("queued prompts sent as content blocks over --input-format stream-json ... merged into one
turn"). When a message comes after the last step, ELU shows both replies, in order. A
question of Claude Code's on that input (a tool call, a host, a form from an MCP server) is
answered by the session's mode: allowed at once in Full access, answered by your rules and
then by you in Ask for approval and Approve for me, refused in Read only
([../permissions.md](../permissions.md)). A teammate's question never takes messages.
Driven with the stand-in CLI; not yet seen with the real service.

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
| `--input-format` | `stream-json`: the prompt is one user message and the input stays open for your messages and the network questions | `stream-json`, for your messages | `stream-json`, for your messages |
| `--tools` | `Read,Grep,Glob,Edit,Write,Bash,WebFetch,WebSearch`; a turn that works on an approved Task adds the to-do tools, below | same | `default`: every tool Claude Code has |
| `--allowedTools` | your MCP servers, `Read`, `Grep`, `Glob`, `Edit` and `Write` on the workspace | same | none |
| `--disallowedTools` | `Agent,Task,NotebookEdit,PowerShell,Monitor`; a turn with helpers, below | same | not passed: no tool is refused |
| `--add-dir` | each folder of the session; an answer turn (yours, or a working bot's) also gets your home folder and a private copy of your Claude Code memory when there is one | same | same |
| Sandbox | on where it starts, never required; a host a command connects to asks you, and one you allowed stays allowed in the session; unsandboxed commands ask you | on where it starts, never required, no network; unsandboxed commands go to the reviewer | off |
| Asks | web tools; answer turns also edits in the project folder | answer-turn edits only | none |
| Denies | protected paths, writes in the folders of the session, secret reads, ELU state, the never list | same, without dependency files | nothing |
| Settings `env` | npm reads no settings of yours (`npm_config_userconfig=/dev/null`), OpenSSL no config | same | empty: npm and OpenSSL read what they read in your shell |
| Environment of the run | a short allow-list | same | your whole environment, less the names that choose Claude Code's account and endpoint (`ANTHROPIC_*`, `CLAUDE_*`) and the other vendors' |

Every profile keeps `--setting-sources ''`, `--strict-mcp-config` with a private
config file and disabled hooks. `--max-budget-usd` is passed only when the session
has a spending limit (`/budget`) or the run is a teammate's question. The approval relay is the
one server ELU adds to that file; it is never in the allow list.

A launch, Read only too, passes `--thinking-display summarized`, so the chat can show what
the model thinks while it works. Claude Code 2.1.318 to 2.1.323 accept the flag but leave it out of
`--help`, as they do `--permission-prompt-tool`, and `claude <any flag> --version` exits 0 for
a made-up flag too (seen on 2.1.322). So the program cannot be asked whether it takes the flag:
ELU reads the program's own file for the flag's text, once for each program, and starts a
program that does not hold it without the flag. A launch that still ends at once with nothing
printed runs again without the flag, and that program is not given it again; a later release
is read anew. What was found is kept in `~/.config/elu-code/vendor-extras.json`.

With the flag or without, the 2.1.322 runs read so far sent every thinking block with its text
empty. The chat then shows the thought's token count, live, from the `system/thinking_tokens`
rows. A `tool_progress` row comes every 30 seconds while a command prints nothing and says how
long the call has run; the chat counts the seconds between two of them. `task_started`,
`task_notification`, `task_updated` and `background_tasks_changed` rows name the commands a
turn has running in the background, which the chat shows as one line.

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

A turn that works on an approved Task is launched with Claude Code's to-do tools, in every
mode: `--tools` adds `TaskCreate,TaskUpdate,TaskList,TaskGet,TodoWrite`, and Ask and Auto
allow them without asking. On 2.1.321 and 2.1.322 a run has no to-do tool unless `--tools`
names one; named, it has the four Task tools, and a name that release does not have is left
out. The turn is told to keep the Task's subtasks there. Each step shows on the card when
Claude Code answers the call, so the subtasks tick while the turn runs. Claude Code keeps
that list with its session and names a step by its number, so ELU keeps the steps with the
Task for the session's next turn. This was read in Claude Code's own code; a turn of the
real one making these calls was not seen yet.

A working bot's turn that may start helpers (see [../permissions.md](../permissions.md))
is launched with these changes: `--tools` adds `Agent`; `--allowedTools` adds
`Agent(executor)`, except in Full; `--disallowedTools` is
`NotebookEdit,PowerShell,Monitor`; `--agents` defines the one helper, `executor`, with
the turn's own tools and the helpers' model; the deny rules add each built-in agent type
and an `Agent` call that names a model or an isolation; and the settings and the
environment turn off built-in agents, forked agents, helpers of helpers and background
tasks, and force the helpers' model when the bot names one. In Full access none of that
is set but the helpers' model: the helper has every tool, any agent type can be started,
and its instructions name nothing it may not do.

With every tool, one run can end more than one turn: Claude Code answers, waits for a
helper or a command it left in the background, and answers again when that finishes. ELU
reads the rows these write (`task_started`, `task_notification`, `task_updated`,
`background_tasks_changed`, `tool_progress`) and takes the last result that carries an
answer as the reply; a later result that failed or carries none does not undo it. Read
from the strings of Claude Code 2.1.322; not seen with the real service.

In Ask and Auto, stand-in commands (`lib/never-shims.mjs`) cover what those rules cannot read: a
script, `sh -c`, `npm test`. Claude Code starts each command from a snapshot of
your shell setup, which builds PATH again, so a folder put first on the PATH it was
started with ends up behind the system's. ELU sets `CLAUDE_ENV_FILE` to a
one-line file that puts the folder first again; Claude Code runs that file ahead of
each command. The stand-in named `claude` is in a folder of its own that only this file
puts on PATH. Claude Code itself is started without it, so a terminal app that wraps the
vendor's command with its own `claude` script finds the real program, not the stand-in
([why](../permissions.md#which-profile-a-turn-runs-with)). Seen on 2.1.322 in Ask for approval and in Approve for me: `npm test`
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
folder was gone after the run. Seen on 2.1.322 on Linux in Ask for approval, with the
sandbox starting, a home folder too long for the cache place and a ten-digit user
number: the sandboxed `npm test` was given `TMPDIR` as
`<runtime folder>/elu<two letters>/claude-<uid>`, could make a file there, and ended
0 with no "operation not permitted" note. Not seen with the real service: Approve
for me, Read only.

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
