# Codex

Sessions and reviews. Tested release: 0.166.0-alpha.5.1. Subscription: ChatGPT.

Labels: **[run]** checked by running the tested release of `codex` against a local mock model server (the real backend was never called); **[docs]** from OpenAI's documentation or `codex exec --help`; **[unverified]** neither.

## Install and sign in

- `npm i -g @openai/codex` (a user prefix, no sudo).
- `codex login` and choose ChatGPT. ELU reads `codex login status` and accepts only `Logged in using ChatGPT` [run]. An API key sign-in exits 0 too, so it is reported as signed out and the status line says `Codex: sign in with ChatGPT. Run: codex login`, or `Run: codex login --device-auth` on a computer with no browser (an SSH session, or Linux with no display). No key variable is read or passed.
- More ChatGPT accounts: `a` in the Usage tab runs `codex login` with `CODEX_HOME` set to a folder of the account's own, which links to your `~/.codex` for everything but `auth.json` ([../../SECURITY.md](../../SECURITY.md#several-accounts)). Each account's usage is read with its own `app-server`. A sign-in kept in the OS keyring instead of `auth.json` names no account ELU can read, so it is not added [unverified]. The sign-in runs on a cleared screen under one line of ELU's, and ELU is drawn again when it ends. On a computer with no browser (an SSH session, or Linux with no display) the sign-in is `codex login --device-auth`, Codex's device code sign-in, and ELU's second line says to open the link on any computer and use the code under it [run] (`codex login --help` and the sign-in up to its code, 0.167.0).
- Another tool's `codex` script may come first on your PATH: a terminal app that wraps the vendor's command puts one there. ELU runs Codex through it in every mode ([why](../permissions.md#which-profile-a-turn-runs-with)). ELU launches with `features.hooks=false`; whether that turns off the hooks such a script adds is [unverified].

## What each mode launches

Every mode but Full access keeps the same isolation: `--ignore-user-config --ignore-rules --json`, `-c mcp_servers={}`, hooks, apps, plugins, browser, multi-agent, image and skill features off, user input and plan tools off, and a refusal to launch when a project or managed `config.toml` could add MCP servers. Full access keeps `--ignore-user-config --ignore-rules --json`, `-c mcp_servers={}`, the user input tool off (nobody could answer it in a run without a terminal) and that refusal, and switches nothing else off: every feature stays as the release ships it, a login shell is allowed, and commands get the whole environment of the run. Its stream may then carry any kind of item (`collab_tool_call`, `mcp_tool_call`, `web_search`, ones a later release adds), and ELU reads them all; below Full access a kind the session was not given refuses the run. Not seen with the real service: these are the release's own defaults. The output schema goes through `--output-schema`; the prompt arrives on stdin. A session's model also gets `--skip-git-repo-check`: a project folder need not be a Git repository, and without the flag Codex refuses to start there [run]. A Full access turn of yours that runs through the app-server (see "Messages you send while a turn works") cannot be given `--ignore-user-config` or `--ignore-rules`: it reads your own Codex `config.toml`, your rules and the MCP servers they name.

| | Read only (reviewer) | Ask for approval | Approve for me | Full access |
|---|---|---|---|---|
| Sandbox | `--sandbox read-only` | profile `elu_ask` (below) [run] | the same profile [run] | `-c sandbox_mode="danger-full-access"` [run] |
| Approvals | `never` | `never`; a blocked action produces no stream item [run] | `on-request` with `approvals_reviewer="auto_review"` [run] | `never` |
| Shell | none | `exec_command` inside the sandbox [run] | same; an escalation goes to the reviewer model [run] | any command, no sandbox [run] |
| Network | blocked | blocked, loopback included [run] | blocked unless the reviewer allows an escalation | open [run] |
| Web search | off | off | off | `web_search="live"` [run: the tool is offered; a real search is unverified] |
| Named folders | n/a | read-only | read-only | n/a |
| Features and tools | all off | shell on, the rest off | same | the release's defaults |
| Where | task worktree | worktree or branch | worktree or branch | also your checkout |

The `elu_ask` profile is one `-c permissions.elu_ask=…` value with `default_permissions="elu_ask"` [run]:

- `extends=":workspace"` for edit turns: the workspace is writable, everything else readable [run]. Answer turns use `extends=":read-only"` [run].
- `":slash_tmp"="read"` and `":tmpdir"="read"`: the shared temp folders the workspace sandbox adds are read-only again [run]. The `sandbox_workspace_write.exclude_*` keys do nothing under a profile [run], so they are not passed.
- Each named folder `"<dir>"="read"`: readable, not writable, the same entry a protected file gets below.
- Each protected file `"<path>"="read"`: readable, not writable [run]. The structural checks still run afterwards.
- Home secrets, ELU's state folder and the repository's `.git/elu-code` as `"<path>"="deny"`: a shell `cat` or `ls` there never starts and no item is reported [run]. The reviewer model in Approve for me sees the same deny list in its context [run].

A profile value containing `*`, `?`, `[`, `]`, `{` or `}` is refused before launch: Codex reads those as patterns.

Resume: `codex exec resume <thread_id> -` with the same `-c` set. `exec resume` has no `--sandbox` or `--cd`, so the sandbox and profile come from `-c` keys and the process runs in the workspace [run: the profile, Approve for me and Full access all applied on a resumed thread].

## Messages you send while a turn works

`codex exec` reads its prompt to the end of its input before it starts, and has no way to
take more while it works. The same program has a second interface that can:
`codex app-server --listen stdio://`, JSON-RPC over standard input and output. There a turn
is started with `turn/start`, and `turn/steer` (`threadId`, `expectedTurnId`, `input`) adds
user input to the turn that runs: the model reads it at its next step, with the rest of the
thread, and one reply answers everything [run: codex-cli 0.167.0, `turn/steer` during a
running command, the model's next request held the message].

So a turn of yours in your own session runs through the app-server where the installed
Codex has `turn/steer`. ELU asks the program itself, once for each installed binary (its
path, size and date): it starts the app-server, sends `initialize`, then `turn/steer` for a
thread that does not exist. A program that answers that it has no such method, or has no
app-server, keeps `codex exec` for every turn, as before. No list of versions decides it.

Through the app-server everything `exec --json` gives stays: ELU starts the thread with
the same `-c` keys, `cwd`, `sandbox`, `approvalPolicy` and model (`thread/start`, or
`thread/resume` with the thread id), sends the same prompt and reply schema (`turn/start`,
`outputSchema`), and writes each notification as the line `exec --json` prints for it
(`thread.started`, `turn.started`, `item.started`, `item.completed`, `turn.completed` with
the token usage, `turn.failed`), so steps, commands, edits, usage, the modes, the sandbox,
the never list and the resume of the thread read as they did [run: the same Full access
launch through exec and through the app-server gave the same lines, tools, schema, model
and usage; a thread started one way resumed the other way with its history whole].

A message you send while the turn works goes to it, and the chat shows it with "Sent to
the running turn." once the turn read it. Codex cannot give a message back once it is
steered, so while a command runs ELU holds the message until that command ends: the chat
says "The running turn reads it when the command it is running ends.", `↑` takes it back
until then, and Enter in the empty message box sends it now. Sent now, ELU stops the
command and the turn (`turn/interrupt`) and starts the next turn of the same thread with
your message at once, in the same run [run: two `sleep` processes went from running to
none, and the same run answered with the message 3.5 seconds later]. A message steered
between two steps cannot be taken back: the chat says the turn has it.

The app-server has no `--ignore-user-config` and no `--ignore-rules`. Outside Full access,
where ELU leaves your own Codex `config.toml` and rules out, a computer that has either
keeps `codex exec` for that turn. In Full access the app-server reads your `config.toml`
as Codex itself would, with ELU's own `-c` keys laid over it; the MCP servers it names stay,
since `-c mcp_servers={}` does not take them away there [run].

Where a turn runs through `codex exec` (a Codex without `turn/steer`, or the case above),
it takes no message while it works. A message sent to it is answered at once beside the
turn: a short read-only `codex exec` on the session's model, in a thread of its own, reads
the chat and every step the turn has taken so far, and its answer shows in the chat,
marked "Answered beside the running turn, from what it has done so far. The turn goes on."
A question is done with that. A message that asks for work says so and starts the next turn
when this one ends, and Enter in the empty message box sends it now: the turn stops as
`/stop` stops it, its edits and the chat kept, and what has not run starts the next turn at
once, in the order sent, as one message. Outside Read only the next turn goes on in the
thread that was stopped (`codex exec resume <thread id>`, the id read from the stopped
run's `thread.started` line), so Codex keeps what it was doing. A Read only turn starts a
new thread each time, as before, so there the next turn is given what the stopped one wrote
and did, read from its log: each message, each command with its exit code and what it
printed (one still running is marked as stopped), and the files it changed.

Proven with the installed codex-cli 0.167.0 spoken to over its app-server, with a stand-in
model service in place of the real one; no turn was run on a real model or account. The
approval requests the app-server sends a client were answered in tests with the stand-in
only.

## What the owner sees

- Subtasks: a turn that works on an approved Task is launched with `-c tools.update_plan.enabled=true` and told to keep the Task's subtasks in its plan. Each `todo_list` item in the stream ticks them while the turn runs; the first step not done shows as the one in hand. Every other turn keeps the plan tool off.
- Approve for me: an action the reviewer declines comes back as `status: "declined"` and is listed on the run as a denial (`Run: <command>` or `Edit: <paths>`) [run]. The model is told not to retry it and to return `needs_input`.
- Ask for approval: Codex has no live approval relay. A sandbox block produces no stream item and no denial record [run]; the model reports what it could not do.
- No dollar figure: Codex reports no cost in its stream. `maxCostUsd` must be `null`; nothing bounds a run that works, and one that prints nothing for the quiet limit is stopped.
- What the model thinks: every launch passes `-c model_reasoning_summary="auto"`. Every model in the bundled catalog of 0.167.0-alpha.4.1 defaults to `none`, and then the stream has no reasoning item. The chat shows each reasoning summary as it arrives, with each command, edit and message, and how long a command has run. A program whose file does not hold the key is started without it, and a launch that ends at once with nothing printed runs again without it (see [Claude Code](claude.md)). Not seen with the real service yet.

## Code mode, seen with the real service

These lines come from real turns on 0.166.0-alpha.5.1 with a ChatGPT sign-in, not from the mock model server.

- Every model in the release's catalog but one takes its tools only through the code-mode host (`"tool_mode": "code_mode_only"` in `codex debug models --bundled`). The mock server knows no such model, so the [run] checks above never met it.
- With `features.code_mode_host=false` a turn opens with `Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed`. No command and no file read starts; the model can only ask you to enable shell execution. A session therefore leaves `code_mode_host` at the release's default. A reviewer has no tools and keeps it off.
- With the host on, in Ask for approval and in Approve for me: a command runs as `/bin/zsh -lc '…'` and arrives as a `command_execution` item, a patch as a `file_change` item, and the adapter reads the stream. No other kind of item appeared.
- The sandbox still refused: a write beside the workspace (`Operation not permitted`), a patch to a protected file (rejected, no item, no denial record) and a host lookup by `curl`.
- The never list: with `allow_login_shell=false` a command runs as `/bin/zsh -c '…'`, and `command -v git` inside the sandbox names the stand-in. In Ask for approval, `npm test` whose script ran `git push` to an origin on another machine (an `ssh://` URL to a name that does not resolve) printed `git push is never allowed, in any mode.` (the words of that release; it now prints `git push is not allowed outside Full access.`), the push exited 126, ssh was never started, and the run kept the refusal for the chat. The same script's push to a bare repository inside the project went to the real git, and the sandbox of the mode refused its write (`remote unpack failed`). Approve for me was seen with the same refusal before local pushes were let through. With a login shell (`-lc`) the stand-in folder lands behind `/usr/bin` on macOS and would refuse nothing. Asked to run `git push` itself, the model declined, citing its instructions.
- After a refused step the model answers `needs_input`, names what it needs in the summary and leaves `question` empty (three turns of three). ELU reads that reply as it is. Refusing it started a second session that ran the turn's commands again.
- Not seen: Full access with the real service, a declined escalation in Approve for me, and what a code-mode cell can do without calling a tool.

## Not enforced or not verified

- No per-command allow or deny rules (`--ignore-rules`). In Ask for approval and Approve for me the never list is held by stand-in commands first on the session's PATH (`lib/never-shims.mjs`), and `-c allow_login_shell=false` keeps a login shell from rebuilding PATH with the system folders ahead of them. They refuse by name and are not a sandbox: a full path to the real command, a changed PATH, a Git alias or another program that does the same work gets past them. A `git push` to a folder on this machine and a `git merge` or `git tag` in a scratch repository under the temporary directory pass, since a project's own tests do both. Behind them, in Ask the sandbox has no network and the Git common directory is read-only; in Approve for me an escape depends on the reviewer model. Full access has no never list and no stand-in commands: it pushes, tags, merges, publishes and deploys as your own shell would.
- Reads are open everywhere except the profile's deny entries. Glob deny entries such as `**/.env*` are [unverified].
- Approve for me: an allowed escalation ran a write outside the sandbox [run]; an allowed escalated `curl` to a loopback address still could not connect [run, cause unknown]. An allowed escalation to an external host reached it in an earlier run.
- Full access web search: the `web_search` tool is offered with `web_search="live"` [run]; no search was performed against the real service.
- Whether `features.hooks=false` stops a PATH shim's hooks [unverified].
- Linux: the tested release runs its sandbox on bubblewrap, with its own copy of `bwrap` (Landlock is its older option). The profile semantics above were checked on macOS only; the Linux tests run with `bubblewrap` installed and an AppArmor profile loaded ([../permissions.md](../permissions.md#linux)).
