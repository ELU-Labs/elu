# Codex

Sessions and reviews. Tested release: 0.166.0-alpha.5.1. Subscription: ChatGPT.

Labels: **[run]** checked by running the tested release of `codex` against a local mock model server (the real backend was never called); **[docs]** from OpenAI's documentation or `codex exec --help`; **[unverified]** neither.

## Install and sign in

- `npm i -g @openai/codex` (a user prefix, no sudo).
- `codex login` and choose ChatGPT. ELU Code reads `codex login status` and accepts only `Logged in using ChatGPT` [run]. An API key sign-in exits 0 too, so it is reported as signed out and the status line says `Codex: sign in with ChatGPT. Run: codex login`. No key variable is read or passed.
- If another `codex` shim comes first on your PATH (the cmux shim does on some machines), put the real binary first. ELU Code launches with `features.hooks=false`; whether that neutralizes a shim's hooks is [unverified].

## What each mode launches

Every mode keeps the same isolation: `--ignore-user-config --ignore-rules --json`, `-c mcp_servers={}`, hooks, apps, plugins, browser, multi-agent, image and skill features off, user input and plan tools off, and a refusal to launch when a project or managed `config.toml` could add MCP servers. The output schema goes through `--output-schema`; the prompt arrives on stdin. A session's model also gets `--skip-git-repo-check`: a project folder need not be a Git repository, and without the flag Codex refuses to start there [run].

| | Read only (reviewer) | Ask for approval | Approve for me | Full access |
|---|---|---|---|---|
| Sandbox | `--sandbox read-only` | profile `elu_ask` (below) [run] | the same profile [run] | `-c sandbox_mode="danger-full-access"` [run] |
| Approvals | `never` | `never`; a blocked action produces no stream item [run] | `on-request` with `approvals_reviewer="auto_review"` [run] | `never` |
| Shell | none | `exec_command` inside the sandbox [run] | same; an escalation goes to the reviewer model [run] | any command, no sandbox [run] |
| Network | blocked | blocked, loopback included [run] | blocked unless the reviewer allows an escalation | open [run] |
| Web search | off | off | off | `web_search="live"` [run: the tool is offered; a real search is unverified] |
| Named folders | n/a | read-only | read-only | n/a |
| Where | task worktree | worktree or branch | worktree or branch | also your checkout |

The `elu_ask` profile is one `-c permissions.elu_ask=…` value with `default_permissions="elu_ask"` [run]:

- `extends=":workspace"` for edit turns: the workspace is writable, everything else readable [run]. Answer turns use `extends=":read-only"` [run].
- `":slash_tmp"="read"` and `":tmpdir"="read"`: the shared temp folders the workspace sandbox adds are read-only again [run]. The `sandbox_workspace_write.exclude_*` keys do nothing under a profile [run], so they are not passed.
- Each named folder `"<dir>"="read"`: readable, not writable, the same entry a protected file gets below.
- Each protected file `"<path>"="read"`: readable, not writable [run]. The structural checks still run afterwards.
- Home secrets, ELU Code's state folder and the repository's `.git/elu-code` as `"<path>"="deny"`: a shell `cat` or `ls` there never starts and no item is reported [run]. The reviewer model in Approve for me sees the same deny list in its context [run].

A profile value containing `*`, `?`, `[`, `]`, `{` or `}` is refused before launch: Codex reads those as patterns.

Resume: `codex exec resume <thread_id> -` with the same `-c` set. `exec resume` has no `--sandbox` or `--cd`, so the sandbox and profile come from `-c` keys and the process runs in the workspace [run: the profile, Approve for me and Full access all applied on a resumed thread].

## What the owner sees

- Approve for me: an action the reviewer declines comes back as `status: "declined"` and is listed on the run as a denial (`Run: <command>` or `Edit: <paths>`) [run]. The model is told not to retry it and to return `needs_input`.
- Ask for approval: Codex has no live approval relay. A sandbox block produces no stream item and no denial record [run]; the model reports what it could not do.
- No dollar figure: Codex reports no cost in its stream. `maxCostUsd` must be `null`; the time limit bounds the run.

## Code mode, seen with the real service

These lines come from real turns on 0.166.0-alpha.5.1 with a ChatGPT sign-in, not from the mock model server.

- Every model in the release's catalog but one takes its tools only through the code-mode host (`"tool_mode": "code_mode_only"` in `codex debug models --bundled`). The mock server knows no such model, so the [run] checks above never met it.
- With `features.code_mode_host=false` a turn opens with `Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed`. No command and no file read starts; the model can only ask you to enable shell execution. A session therefore leaves `code_mode_host` at the release's default. A reviewer has no tools and keeps it off.
- With the host on, in Ask for approval and in Approve for me: a command runs as `/bin/zsh -lc '…'` and arrives as a `command_execution` item, a patch as a `file_change` item, and the adapter reads the stream. No other kind of item appeared.
- The sandbox still refused: a write beside the workspace (`Operation not permitted`), a patch to a protected file (rejected, no item, no denial record) and a host lookup by `curl`.
- The never list: with `allow_login_shell=false` a command runs as `/bin/zsh -c '…'`, and `command -v git` inside the sandbox names the stand-in. In Ask for approval, `npm test` whose script ran `git push` to an origin on another machine (an `ssh://` URL to a name that does not resolve) printed `git push is never allowed, in any mode.`, the push exited 126, ssh was never started, and the run kept the refusal for the chat. The same script's push to a bare repository inside the project went to the real git, and the sandbox of the mode refused its write (`remote unpack failed`). Approve for me was seen with the same refusal before local pushes were let through. With a login shell (`-lc`) the stand-in folder lands behind `/usr/bin` on macOS and would refuse nothing. Asked to run `git push` itself, the model declined, citing its instructions.
- After a refused step the model answers `needs_input`, names what it needs in the summary and leaves `question` empty (three turns of three). ELU Code reads that reply as it is. Refusing it started a second session that ran the turn's commands again.
- Not seen: Full access with the real service, a declined escalation in Approve for me, and what a code-mode cell can do without calling a tool.

## Not enforced or not verified

- No per-command allow or deny rules (`--ignore-rules`). In every mode but Read only the never list is held by stand-in commands first on the session's PATH (`lib/never-shims.mjs`), and `-c allow_login_shell=false` keeps a login shell from rebuilding PATH with the system folders ahead of them. They refuse by name and are not a sandbox: a full path to the real command, a changed PATH, a Git alias or another program that does the same work gets past them. A `git push` to a folder on this machine and a `git merge` or `git tag` in a scratch repository under the temporary directory pass, since a project's own tests do both. Behind them, in Ask the sandbox has no network and the Git common directory is read-only; in Approve for me an escape depends on the reviewer model; in Full access there is nothing.
- Reads are open everywhere except the profile's deny entries. Glob deny entries such as `**/.env*` are [unverified].
- Approve for me: an allowed escalation ran a write outside the sandbox [run]; an allowed escalated `curl` to a loopback address still could not connect [run, cause unknown]. An allowed escalation to an external host reached it in an earlier run.
- Full access web search: the `web_search` tool is offered with `web_search="live"` [run]; no search was performed against the real service.
- Whether `features.hooks=false` stops a PATH shim's hooks [unverified].
- Linux: the tested release runs its sandbox on bubblewrap, with its own copy of `bwrap` (Landlock is its older option). The profile semantics above were checked on macOS only; the Linux tests run with `bubblewrap` installed and an AppArmor profile loaded ([../permissions.md](../permissions.md#linux)).
