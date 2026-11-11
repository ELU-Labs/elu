# Grok Build

Grok Build (`grok`) is xAI's coding CLI for SuperGrok and X Premium+ subscribers. ELU Code
runs sessions on it. Its enforcement follows the vendor's documentation; a one-time check on
your machine proves it before the first run.

## Install and sign in

```
npm i -g @xai-official/grok
grok login
```

Install into a user-writable npm prefix; nothing here needs sudo. `grok login` opens the
browser (`grok login --device-auth` on a remote machine) and keeps the token in
`~/.grok/auth.json`. ELU Code never reads that file, never copies it, and reads no API key
variable: if `grok` is signed out, the session says `Grok Build: not signed in. Run: grok login`.

## The one-time check

ELU Code starts the check by itself before your first message to Grok goes out, whether
you wrote to a session on it or to a bot on it. The session says so first, then shows each
step as it ends, and then your message goes on. The check takes about seven short turns on
Grok and a few minutes. Only a message you just sent starts it: a scheduled turn, a shadow
turn or a review never does.

The check runs eight steps against the installed binary in a throwaway repository, with a
planted file outside it, a local web listener and a marker command:

| Step | What it proves |
|---|---|
| `signin` | the token works from ELU Code's private Grok home |
| `locked-no-write` | a read-only run told to create files creates none, inside or outside |
| `locked-no-shell` | told to run the marker command, it never runs |
| `locked-no-network` | told to fetch the local URL, the listener sees nothing |
| `json` | the headless result parses and follows ELU Code's schema |
| `resume` | a second run with the session id continues the first |
| `relay` | over ACP, a write outside the workspace asks first; denied, nothing is written |
| `isolation` | `grok inspect --json` shows no Claude or Cursor instructions, hooks or servers |

Every step but `relay` must pass. The result is stored per binary and version; a new
release proves itself again, on your next message to it. Until the check passes, no Grok
run starts, and a turn you did not send yourself says
`Grok Build has not been checked on this machine yet. Your first message to it runs the check.`
If a required step fails, Grok stays off here, the session says which step was not proven,
and your next message to it runs the check again. If `relay` fails, Ask and
Auto still work, but a blocked action is reported instead of asked:
`Grok can't ask live here. Blocked actions are reported.`

## How each mode runs

| Mode | Transport | Permissions |
|---|---|---|
| Read only | headless (`--prompt-file`) | `--permission-mode dontAsk`, `--sandbox read-only`, tools `read_file,grep,list_dir`, every write, shell, web and MCP tool denied |
| Ask | ACP (`grok agent stdio`) when `relay` passed, else headless `dontAsk` | `Read` and `Grep` with no path, workspace edits and reads of each named folder allowed by rule; outside edits, named folders included, shell and web ask you (ACP) or are denied and reported (headless); `--sandbox workspace` in headless mode |
| Auto | ACP with `autoMode`, else headless `--permission-mode auto` | Grok's own reviewer model decides routine actions; what it refuses asks you over ACP |
| Full | headless `--permission-mode bypassPermissions`, `--sandbox off` | anything; the never list stays as deny rules |

Every profile denies reads of secret folders (`~/.ssh`, `~/.aws`, `~/.claude`, `~/.codex`,
`.env*`, `auth.json`, key files, ELU Code's own state) by rule, and denies the never list on
command text (`git push`, `git tag`, `git merge`, `gh pr merge`, `gh release`, package
publishes, deploys, `kubectl apply`, `terraform apply`). Those rules match text: `sh -c`
and aliases get past them, so in Auto and Full they are a tripwire, not a boundary.
Stand-in commands first on the session's PATH also refuse the list by name for what a
script or `sh -c` runs; that was seen only in tests against a stand-in `grok`, not with the
real one, and whether Grok's sandbox lets a command read that folder is not proven. The
Read only profile has no shell, so there the never list holds. Grok's sandbox blocks a
child process's network on Linux only; on macOS the read-only profile holds because it has
no shell and no web tools, not because the sandbox blocks the network.

Headless runs have no schema flag, so ELU Code puts the output schema in the prompt and
validates the answer. Sessions resume with `-r`; a mode switch that changes the sandbox
profile cannot resume (Grok keeps a session's sandbox), so that turn's retry starts a fresh
session without the earlier context. The time limit is the role's; `--max-turns` (40 for
read-only turns, 120 for edit turns) bounds the model rounds. Cost is not reported under a
subscription; the role's `maxCostUsd` must be `null`.

## The private home

By default Grok reads your `~/.grok` tree (config, rules, hooks, skills, agents,
`AGENTS.md`), `/etc/grok`, the workspace's `.grok`, every `AGENTS.md` and `CLAUDE.md` up
the tree, `.envrc`, and your Claude Code configuration: `~/.claude/settings.json` and
`settings.local.json` (hooks and permission rules), `~/.claude/CLAUDE.md`,
`~/.claude/rules/*.md`, `~/.claude/agents/*.md`, `~/.claude/skills/`, `~/.claude.json`
(MCP servers), plus the same Cursor files. The switches
`GROK_CLAUDE_{SKILLS,RULES,AGENTS,MCPS,HOOKS}_ENABLED=0` and `GROK_CURSOR_*_ENABLED=0`
exist, and ELU Code sets all ten, but
[xai-org/grok-build-plugin-cc#34](https://github.com/xai-org/grok-build-plugin-cc/issues/34)
(open, filed against CLI 1.0.5) reports `~/.claude/CLAUDE.md`, `rules` and `agents` still
loading with every switch off, and the `~/.claude` scan is anchored on `HOME`, which
`GROK_HOME` does not move.

So every run gets a private `HOME` under ELU Code's state (`grok-home` in your personal
directory) and a `GROK_HOME` inside it holding only what ELU Code wrote:

- `config.toml`: Claude and Cursor compatibility off, telemetry, trace upload, Mixpanel,
  feedback, managed config, campaigns, remote fetch and server-side search off, workspace
  snapshots and codebase uploads off, auto-update off, session relay off, `.envrc` off,
  subagents off, and the never list as deny rules. It is rewritten before every run.
- `trusted_folders.toml`: empty. A workspace is never trusted, so its `.grok/config.toml`,
  hooks, MCP servers and skills never load. Its `AGENTS.md` and `CLAUDE.md` still reach the
  prompt; they are repository content, treated as untrusted.
- `sessions/`: Grok's session store, so `-r` works.
- `auth.json`: a symbolic link to your real `~/.grok/auth.json`. `grok login`, `grok logout`
  and token refreshes write through it; ELU Code holds no copy. If Grok ever replaces the
  link with a file, the newer token wins at the next run.

There is no `~/.claude` under that home, so the `isolation` step shows what actually
reaches a run on your machine. If it fails, Grok stays off here and the session says why.

## Telemetry and uploads

On consumer plans Grok's product analytics, session trace upload (which includes file
contents) and per-turn workspace snapshots are on by default. ELU Code turns off every
documented switch, in the environment and in `config.toml`: `GROK_TELEMETRY_ENABLED=0`,
`GROK_TELEMETRY_TRACE_UPLOAD=0`, `GROK_TELEMETRY_MIXPANEL_ENABLED=0`,
`GROK_FEEDBACK_ENABLED=0`, `GROK_MEMORY=0`, `GROK_SUBAGENTS=0`, `GROK_CAMPAIGNS=0`,
`GROK_DISABLE_AUTOUPDATER=1`, `[telemetry] trace_upload=false`,
`[harness] disable_workspace_teleport=true` and the older `disable_codebase_upload=true`
(the key that stopped per-turn repository uploads on earlier releases), `[relay]
enabled=false`. With trace upload on, a headless run can spend up to 150 seconds draining
uploads at exit; off, it ends when the turn ends. Grok's server-side web search
(`[features] backend_tools`, `GROK_BACKEND_SEARCH`) runs inside the model call, where no
permission rule applies, so it is off in every mode; the model's own web tools follow the
mode. Account-level settings for coding data, retention and training live in Grok's own
`/privacy` screen; ELU Code cannot change them.

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
- Whether Grok refreshes the token through the symbolic link or replaces it is not settled;
  the rule above keeps the newer token either way.
- Workspace `AGENTS.md` and `CLAUDE.md` reach the prompt in every mode. A repository can
  steer the model's instructions, not its permissions.
- A full shell in Full access can push, tag, merge, deploy and publish. ELU Code keeps the
  prompt line, the deny rules and its own publish gate, and claims no more.
