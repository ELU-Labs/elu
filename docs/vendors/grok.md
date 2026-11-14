# Grok Build

Grok Build (`grok`) is xAI's coding CLI for SuperGrok and X Premium+ subscribers. ELU
runs sessions on it. Its enforcement follows the vendor's documentation; a one-time check on
your machine proves it before the first run in Read only, Ask for approval or Approve for
me. Full access needs no check.

## Install and sign in

```
npm i -g @xai-official/grok
grok login
```

Install into a user-writable npm prefix; nothing here needs sudo. `grok login` opens the
browser (`grok login --device-auth` on a remote machine) and keeps the token in
`~/.grok/auth.json`. ELU never reads that file, never copies it, and reads no API key
variable. You can also sign in from ELU: `s` on the Grok Build line in the Usage tab leaves
ELU's screen and runs `grok login` there (`grok login --device-auth` on a computer with no
browser: an SSH session, or Linux with no display), under the HOME and Grok home ELU runs
`grok` with, so the token lands in your own `~/.grok/auth.json` through the link below; ELU
comes back when it ends. `grok` 1.0.77 prints a link and a code to confirm on that page, on any
computer, and waits for it; with no browser ELU's second line says so. If `grok` is signed
out, the session says
`Grok Build (the grok command): not signed in. Sign it in with s on its line in the Usage tab.`

## The one-time check

The check proves what Read only, Ask for approval and Approve for me stand on. ELU starts
it by itself before the first turn on Grok in one of those modes goes out, whether you
wrote to a session on it or to a bot on it, or the turn started without you: a teammate's
message that starts a session of yours (`/access` Auto, or your `y` or `w` on it), a scheduled
turn, a shadow turn, a review, a standup or a Task's work. The session says so first:
`Checking Grok Build (the grok command) first: 8 steps, once on this machine for release
1.0.77. Full access needs no check: /permissions full runs your message now.` Under the
working line it then counts, `Grok Build: 3 of 8 steps, 1m 5s so far.`, and
then the turn goes on. Each step is a short turn on Grok, so how long the check takes is
how fast Grok answers. `c` in the Usage tab starts it too.

Full access needs no check and never waits for one. A message in a Full access session
runs at once on the `grok` that is installed: on a computer where it was never checked,
after `grok` was updated, after a check that did not pass, and while another session is
running the check. Nothing is said about a check there. ELU still reads what the turn
needs to start, the release and the sign-in, and a signed-out `grok` says so with the key
that signs it in. Set a session to Full access while its message waits for a check and the
message runs at once: a check that this session started ends there and records nothing,
so none of it runs beside your message. ELU never starts a check behind a Full access
turn.

Grok Build reviews, and can be a bot's vendor, once the check passed: a review runs on its
Read only launch, which the check proves writes nothing, runs no command and reaches no
network on this machine. It does not answer a teammate's question (the read-only kind
teammates ask of a shared project): only Claude Code's launch keeps every read inside the
project, hides what Git does not track, and holds the run under a dollar cap.

The Usage tab shows whether Grok is signed in before the check has run: it looks for
`~/.grok/auth.json`, never opens it, and runs nothing. Its line then says
`(grok) signed in · Full access only (c checks it)`, or `(grok) not signed in for ELU · s signs in`.
`c` on that line runs the same check there, with each step under the line as it ends, and the
line then says `ready`, or `Full access only (c checks again)` with the step that was not
proven and why. Signed out, `c` asks first whether to sign in. The check's folders are made
in the system temp folder as it is on disk: on macOS `/var` is a link to `/private/var`, and
ELU follows a link like that one, above what it writes, and refuses one inside it.

The check runs eight steps against the installed binary in a throwaway repository, with a
planted file outside it, a local web listener and a marker command:

| Step | What it proves |
|---|---|
| `signin` | the token works from ELU's private Grok home |
| `locked-no-write` | a read-only run told to create files creates none, inside or outside |
| `locked-no-shell` | told to run the marker command, it never runs |
| `locked-no-network` | told to fetch the local URL, the listener sees nothing |
| `json` | the headless result parses and follows ELU's schema |
| `resume` | a second run with the session id continues the first |
| `relay` | over ACP, a write outside the workspace asks first; denied, nothing is written |
| `isolation` | what `grok inspect --json` lists as loaded from another tool (Cursor, Claude Code, Codex), by name |

The first six are required. The result is stored per binary and version; a new release
proves itself again, before the next turn on it outside Full access, and the session says
that the release changed. Until the check has run, Grok runs in Full access only.

What a result turns off:

- **A required step is not proven.** Read only, Ask and Auto are off, and the session says
  which step and why, for example
  `Grok Build (the grok command) did not pass its check on this machine, so it runs in Full access only here. Not proven: a read-only turn runs no command (locked run ran a shell command).`
  Full access is never turned off by the check: it runs Grok as it is. A session that the
  failed check stopped says the result once when you switch it to Full access. In a Full
  access session a bot that only answers, a shadow and a review run on it too. Your next
  message outside Full access runs the check again only when that can change the result
  (you signed in, say). A step that failed because Grok did what the step forbids stays
  failed until `c` in the Usage tab checks again.
- **`relay` fails.** Ask and Auto still work, but a blocked action is reported instead of
  asked: `Grok Build can't ask live here. Blocked actions are reported.`
- **`isolation` finds something.** Nothing is turned off by that alone. Text the model reads
  (instructions, a rule, a skill, an agent) is named once after the check and under Grok's
  line in the Usage tab, with its file. A hook, an MCP server or a plugin, which would run,
  is asked about once before your first message outside Full access, by name: `y` lets it
  run and is kept for that release, `n` leaves Grok to Full access until `c` in the Usage tab
  asks again. Full access is not asked.

`grok inspect --json` lists a row for every Cursor, Claude Code and Codex switch on every
computer, on or off, and lists another tool's files with their paths even when their switch
is off (marked `disabled`). Only an entry it marks as loaded counts, or a switch that is on
with nothing listed under it. Grok's own built-in skills and a project's `CLAUDE.md`, which
Grok reads as it reads `AGENTS.md`, are Grok's and do not count.

## Messages you send while a turn works

A headless turn (`--prompt-file`) reads one prompt and an ACP turn answers one
`session/prompt`; the program queues prompts sent during a turn of its own, but a client has
no documented way to add to the one that runs. So a message you send while Grok Build works
waits in the chat, "Sent when this turn ends.", and Enter in the empty message box sends it
now: the turn stops as `/stop` stops it and what waits starts the next turn at once. The next
turn goes on in the session that was stopped: the one the launch named with `-s`, or the
ACP session from `session/new`, loaded with `session/load`.

## How each mode runs

| Mode | Transport | Permissions |
|---|---|---|
| Read only | headless (`--prompt-file`) | `--permission-mode dontAsk`, `--sandbox read-only`, tools `read_file,grep,list_dir`, every write, shell, web and MCP tool denied |
| Ask | ACP (`grok agent stdio`) when `relay` passed, else headless `dontAsk` | `Read` and `Grep` with no path, workspace edits and reads of each named folder allowed by rule; outside edits, named folders included, shell and web ask you (ACP) or are denied and reported (headless); `--sandbox workspace` in headless mode |
| Auto | ACP with `autoMode`, else headless `--permission-mode auto` | Grok's own reviewer model decides routine actions; what it refuses asks you over ACP |
| Full | headless `--permission-mode bypassPermissions`, `--sandbox off` | anything, the never list included |

Every profile but Full denies reads of secret folders (`~/.ssh`, `~/.aws`, `~/.claude`, `~/.codex`,
`~/.gemini`, `~/.grok`,
`.env*`, `auth.json`, key files, ELU's own state) by rule. Every profile but Full
denies the never list on command text (`git push`, `git tag`, `git merge`, `gh pr merge`,
`gh release`, package publishes, deploys, `kubectl apply`, `terraform apply`). Those rules
match text: `sh -c` and aliases get past them, so in Auto they are a tripwire, not a
boundary. Full has no never list: no deny rules for it, in the flags or in `config.toml`,
and no stand-in commands. In Ask and Auto, stand-in commands first on the session's PATH
also refuse the list by name for what a
script or `sh -c` runs; that was seen only in tests against a stand-in `grok`, not with the
real one, and whether Grok's sandbox lets a command read that folder is not proven. The
Read only profile has no shell, so there the never list holds. Grok's sandbox blocks a
child process's network on Linux only; on macOS the read-only profile holds because it has
no shell and no web tools, not because the sandbox blocks the network.

Headless runs have no schema flag, so ELU puts the output schema in the prompt and
validates the answer. Sessions resume with `-r`; a mode switch that changes the sandbox
profile cannot resume (Grok keeps a session's sandbox), so that turn's retry starts a fresh
session without the earlier context. A headless run uses `--output-format streaming-json`:
each thought, tool call and piece of text comes as it happens and shows in the chat, the
answer is read from the text, and `end` closes the run with its usage. A program whose file
does not hold `streaming-json` is started with `--output-format json`, which prints only at
the end, and a launch that ends at once with nothing printed runs again that way (see
[Claude Code](claude.md)). It has no quiet limit and
no time limit: it runs until it ends (see How long a turn runs in
[permissions](../permissions.md)); `--max-turns` (40 for
read-only turns, 120 for edit turns) bounds the model rounds, except in Full access, which
has no turn cap of ELU's. Cost is not reported under a
subscription; the role's `maxCostUsd` must be `null`.

The model you chose with `/model` goes on the command line: `--model` headless, and
`grok agent --model <id> stdio` over ACP. A session Grok loads keeps the model it had, so
when you chose another since, ELU switches it before anything is asked, with
`session/set_config_option` on the session's `model` option (value `{ "value": "<id>" }`,
as Grok's docs give it). The run keeps the model the session then named.

The tokens of a run come from its result headless, and over ACP from `_meta.usage` on the
answer to the turn. There `inputTokens` is the whole prompt, so ELU takes the cache read
and the cache write out of it, as Grok's headless output does. The Usage tab's top agents
show them; a turn that carried none says `not reported`, never 0.

A turn that works on an approved Task shows its subtasks as it goes. Over ACP, ELU reads
the `plan` updates Grok sends for its own to-do list. Headless in Full access, the turn is
told to keep the list in a JSON file in a private temporary folder of that run; ELU reads
it twice a second and removes it with the run. Headless in Ask or Auto, the subtasks show
when the turn ends.

## The private home

In Full access `~` is a mirror of your home (`grok-home-full` in your personal directory),
so a command finds your sign-ins where it looks for them: see [Full access](#full-access-your-home-as-)
below. The other modes run in the private home described here.

By default Grok reads your `~/.grok` tree (config, rules, hooks, skills, agents,
`AGENTS.md`), `/etc/grok`, the workspace's `.grok`, every `AGENTS.md` and `CLAUDE.md` up
the tree, `.envrc`, and your Claude Code configuration: `~/.claude/settings.json` and
`settings.local.json` (hooks and permission rules), `~/.claude/CLAUDE.md`,
`~/.claude/rules/*.md`, `~/.claude/agents/*.md`, `~/.claude/skills/`, `~/.claude.json`
(MCP servers), plus the same Cursor files. The switches
`GROK_{CLAUDE,CURSOR,CODEX}_{SKILLS,RULES,AGENTS,MCPS,HOOKS,SESSIONS}_ENABLED=0` exist, and
ELU sets all eighteen, in the environment and again in `config.toml`, but
[xai-org/grok-build-plugin-cc#34](https://github.com/xai-org/grok-build-plugin-cc/issues/34)
(open, filed against CLI 1.0.5) reports `~/.claude/CLAUDE.md`, `rules` and `agents` still
loading with every switch off, and the `~/.claude` scan is anchored on `HOME`, which
`GROK_HOME` does not move.

So every run gets a private `HOME` under ELU's state (`grok-home` in your personal
directory) and a `GROK_HOME` inside it holding only what ELU wrote:

- `config.toml`: Claude, Cursor and Codex compatibility off, telemetry, trace upload, Mixpanel,
  feedback, managed config, campaigns and remote fetch off, workspace snapshots and codebase
  uploads off, auto-update off, session relay off, `.envrc` off, and, in every profile but
  Full, server-side search off, subagents off and the never list as deny rules. Full access
  is everything: its config has none of those three, and its run also drops `--no-memory`,
  `--no-subagents`, `--max-turns`, `GROK_MEMORY=0`, `GROK_SUBAGENTS=0` and
  `GROK_BACKEND_SEARCH=0`. It is
  rewritten before every run, for that run's profile. Runs share it: a run that reads one
  written for another profile still has the never list in its flags wherever it holds.
- `trusted_folders.toml`: empty. A workspace is never trusted, so its `.grok/config.toml`,
  hooks, MCP servers and skills never load. Its `AGENTS.md` and `CLAUDE.md` still reach the
  prompt; they are repository content, treated as untrusted.
- `sessions/`: Grok's session store, so `-r` works.
- `auth.json`: a symbolic link to your real `~/.grok/auth.json`. `grok login`, `grok logout`
  and token refreshes write through it; ELU holds no copy. If Grok ever replaces the
  link with a file, the newer token wins at the next run. Which of the two `grok login`
  does has not been watched: ELU's tests sign it in both ways. Written through the link,
  the token is in your own `~/.grok/auth.json`; written over it, the token stays in ELU's
  Grok home, ELU's runs are signed in, and your own `grok` is signed in only by its own
  `grok login`.

There is no `~/.claude` or `~/.cursor` under that home, so the `isolation` step shows what
actually reaches a run on your machine, and the session names anything it finds.

### Full access: your home as `~`

Full access is everything, so a command must find `~/.npmrc`, `~/.config/gcloud`, `~/.aws`,
`~/.docker`, `~/.kube` and the rest as your terminal does. Running Grok in your home with
`GROK_HOME` set to ELU's folder does not work. Seen on the real Grok Build 1.0.77, signed
out, with a stand-in home as `HOME`, `GROK_HOME` elsewhere and all eighteen switches off:
`grok inspect --json` marks that home's Claude Code and Cursor instructions, rules, skills
and MCP servers `disabled`, and still loads the agents of `~/.claude/agents` and
`~/.grok/agents`, a Claude Code plugin with its hook, the skills of `~/.agents`, and the
permission rules of a Claude Code settings file (`~/.claude/settings.local.json`, or
`settings.json` when there is no local one).

So a Full access run gets `HOME` set to `grok-home-full`, a folder of links:

- every entry at the top of your home is a link to yours, made again before each run, so
  what you added since is there and nothing of yours is copied;
- `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.cursor`, `~/.gemini`, `~/.agents` and your
  own `~/.grok` are left out, and `~/.grok` there is ELU's `GROK_HOME`. The same
  `grok inspect --json` under this folder lists nothing from your home;
- a file or folder a command makes at the top of `~` is moved to your home when the run
  ends (or before the next one, if ELU was stopped). A file saved in place of yours
  replaces yours when it is newer; renaming an entry renames yours. What cannot go to your
  home (a coding tool's folder a run made, an older file than yours) is kept beside the
  mirror in `grok-home-full-aside`, never deleted;
- removing an entry at the top of `~` removes the link only, and yours is linked again at
  the next run. `find ~` and `du ~` see links: a command that walks your home needs its
  full path.

The other modes deny reading this folder, as the rest of ELU's own.

## Telemetry and uploads

On consumer plans Grok's product analytics, session trace upload (which includes file
contents) and per-turn workspace snapshots are on by default. ELU turns off every
documented switch, in the environment and in `config.toml`: `GROK_TELEMETRY_ENABLED=0`,
`GROK_TELEMETRY_TRACE_UPLOAD=0`, `GROK_TELEMETRY_MIXPANEL_ENABLED=0`,
`GROK_FEEDBACK_ENABLED=0`, `GROK_MEMORY=0` and `GROK_SUBAGENTS=0` (both below Full access
only), `GROK_CAMPAIGNS=0`,
`GROK_DISABLE_AUTOUPDATER=1`, `[telemetry] trace_upload=false`,
`[harness] disable_workspace_teleport=true` and the older `disable_codebase_upload=true`
(the key that stopped per-turn repository uploads on earlier releases), `[relay]
enabled=false`. With trace upload on, a headless run can spend up to 150 seconds draining
uploads at exit; off, it ends when the turn ends. Grok's server-side web search
(`[features] backend_tools`, `GROK_BACKEND_SEARCH`) runs inside the model call, where no
permission rule applies, so it is off in every mode but Full access, where no rule applies
at all; the model's own web tools follow the mode. Account-level settings for coding data, retention and training live in Grok's own
`/privacy` screen; ELU cannot change them.

## What is enforced and what is not

Enforced by the vendor and proven by the one-time check on your machine: no writes, no shell and
no network in Read only; the schema result; resume; where `relay` passed, a live question
before an outside write in Ask.

Not enforced, or not proven:

- Deny rules match command text. Obfuscated commands reach Auto's reviewer model and run
  unprompted in Full.
- `--permission-mode` values other than `bypassPermissions` in headless mode are
  documented for the enterprise build; the check's locked steps prove `dontAsk` here, and
  Ask falls back to it only when `relay` failed.
- Whether the server-side search switch and the older codebase-upload key are honoured on
  this release, and whether `auto` mode is available on your plan without
  `[auto_mode] enabled`, is not settled by the docs.
- The exact ACP permission request shape and `session/load` come from the ACP standard and
  Grok's docs; the `relay` step is the only proof.
- The model and the tokens over ACP follow Grok's docs and were seen only against a stand-in
  `grok`: the `--model` agent option, the `model` config option and its value shape, and
  `_meta.usage`, whose name for the cache read the docs do not give (`cachedReadTokens`,
  `cacheReadTokens` and `cacheReadInputTokens` are all read).
- Whether Grok refreshes the token through the symbolic link or replaces it is not settled;
  the rule above keeps the newer token either way.
- Workspace `AGENTS.md` and `CLAUDE.md` reach the prompt in every mode. A repository can
  steer the model's instructions, not its permissions.
- A full shell in Full access pushes, tags, merges, deploys and publishes, as you chose.
- Subtasks while a turn runs were seen only in tests against a stand-in `grok`: that the
  real one sends `plan` updates over ACP, and that its model keeps the list file, is not
  verified.
  ELU keeps its own publish gate for `/publish`, and claims no more.
