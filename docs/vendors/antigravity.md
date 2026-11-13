# Antigravity CLI

`agy` is Google's terminal coding agent for Google One AI Pro and Ultra subscribers (Plus
and Free with a quota). In ELU it can run sessions and reviews, in every permission mode. `agy`
runs only after it passes the one-time check below on this machine.

## Install

Use the vendor's installer from [antigravity.google/docs](https://antigravity.google/docs).
It puts `agy` in your user bin folder (`~/.local/bin`); nothing needs sudo. ELU never
installs it and never updates it: its own runs set `AGY_CLI_DISABLE_AUTO_UPDATE=true`, your
own runs keep the vendor's default.

## Sign in

Run `agy` once and sign in with your Google account. The token lives in the OS keychain
(on Linux, the keyring reached over `DBUS_SESSION_BUS_ADDRESS`, which ELU passes
through). ELU checks sign-in with `agy -p /usage --output-format json`: exit code only,
no model turn, no quota spent. Signed out, ELU says: `Antigravity: not signed in. Run: agy`.

Google's FAQ at [antigravity.google/docs/faq](https://antigravity.google/docs/faq) says,
verbatim: "Using third-party software, tools, or services to access Antigravity is a
violation of our Terms of Service and severely degrades the experience for legitimate
product users. Such actions can result in suspension or termination of your account…" and,
on headless use: "Antigravity CLI headless mode (`agy -p`) is intended for direct scripting
and CI workflows. Wrapping `agy` inside third-party coding agents or applications, or
automating account rotation, is not supported under consumer plans." ELU wraps `agy`.
Enabling it is your decision; the risk is your account, and ELU cannot reduce it.

## The one-time check

The check proves, on this machine and for the exact binary and release found, that the
enforcement designed from Google's documentation holds. ELU starts it by itself
before your first message to Antigravity goes out, whether you wrote to a session on it or
to a bot on it. The session says so first, then shows each step as it ends, and then your
message goes on. The check takes about seven short turns on Antigravity and a few minutes.
Only a message you just sent, or `c` in the Usage tab, starts it: a scheduled turn, a shadow
turn or a review never does. It runs in a throwaway repository with a planted file outside it, a local web
listener and a marker command:

| Step | Proves |
| --- | --- |
| `signin` | the sign-in probe passes under ELU's private HOME |
| `locked-no-write` | a read-only run told to create files creates nothing, inside or outside |
| `locked-no-shell` | told to run the marker command, the marker never runs |
| `locked-no-network` | told to fetch the local URL, the listener sees nothing |
| `json` | headless output parses and the result matches the schema |
| `resume` | a second run with the conversation id continues the first |
| `relay` (optional) | over `agy acp`, a write outside the workspace arrives as a permission request, and a denial writes nothing |

The result is saved under your ELU state. A different binary path or release has to
pass again, on your next message to it; until it does, no run starts, and a turn you did
not send yourself says
`Antigravity CLI has not been checked on this machine yet. Your first message to it runs the check.`
If a required step fails, Antigravity stays off here, the session says which step was not
proven, and your next message to it runs the check again. When `relay` fails,
Ask and Auto still run: blocked actions are denied and reported instead of asked live, and
the permissions picker says so.

The Usage tab shows whether Antigravity is signed in before the check has run. It asks
`agy` what the check asks first, its release (`agy --version`) and its flags (`agy --help`),
then runs the sign-in probe above, `agy -p /usage --output-format json` under ELU's private
HOME: exit code only, no model turn, no quota spent. It does this when the tab opens and it
has not read this `agy` yet, when the tab's usage check is due, and on `r`. The line then
says `signed in · needs a one-time check (c runs it now)`, or `not signed in. Run: agy`. `c` on
that line runs the same check there, with each step under the line as it ends, and the line
then says `ready`, or that the check failed and which step was not proven.

## The private HOME

`agy` reads `~/.gemini` for settings, hooks, MCP servers, plugins, skills and context files,
and has no flag to turn that off. So ELU runs it with `HOME` set to a folder under its
own state (`agy-home/`, mode 0700), one per workspace, holding only:

- `.gemini/antigravity-cli/settings.json`: the mode's permission rules, written before each run;
- `.gemini/config/hooks.json`: one PreToolUse hook, `lib/agy-hook.mjs`, run with the mode's name;
- the conversations `agy` keeps there, so a session resumes with `--conversation`, also
  after `/permissions` changed its mode: the rules are rewritten for every run.

A mode switch applies from the next turn: the same conversation continues under the
workspace HOME, whose settings and hook are rewritten for the new mode before the run.

Nothing in your real `~/.gemini` reaches a run: not your settings, hooks, MCP servers,
plugins, skills, `GEMINI.md` or `AGENTS.md`. Context files inside the workspace
(`AGENTS.md`, `GEMINI.md`, `.agents/rules/*.md`) do reach the prompt; `agy` has no flag to
skip them, so a repository can steer the model. `.agents` is a protected path, so the model
cannot add such files itself.

The prompt goes on standard input, never on the command line, so other users on the
machine cannot read it with `ps`.

## What each mode enforces

| | Read only | Ask for approval | Approve for me | Full access |
| --- | --- | --- | --- | --- |
| How it runs | `agy -p --sandbox` | `agy acp` after `relay` passed, else `-p` | `agy acp` after `relay` passed, else `-p --mode=accept-edits --sandbox` | `-p --dangerously-skip-permissions` |
| Settings | `request-review`; `command`, `write_file`, `read_url`, `execute_url`, `mcp` denied; workspace only | `request-review`; `command`, `read_url`, `execute_url`, `mcp` ask; workspace only; protected files and secret folders denied to the file tool | `proceed-in-sandbox`; `sudo` and `.git` denied; workspace only; protected files and secret folders denied | outside access allowed; `read_url`, `execute_url`, `mcp` allowed; secret folders denied to the file tool |
| Hook | denies web search, commands, edits, image generation, scheduling and subagents | asks for web search; denies push, tag, merge, deploy and publish by command text | denies web search and the never list; sends the rest to the reviewer | no opinion: Full access runs the never list |
| Named folders | none | `--add-dir` each; `write_file` denied in each | same | `--add-dir` each |
| Web | denied | asks, or reported | reviewed, or reported | allowed |

A named folder is read and never written in Ask for approval and Approve for me: its
`write_file` deny is the one a protected file gets. A folder that holds the workspace or
lies inside it gets no deny, because a deny wins over the workspace's edits: for example
the folder of all your projects, where a worktree sits beside its repository.

In headless mode a blocked action is a soft deny: the run goes on, exits 0, and prints a
notice on stderr naming the tool. ELU records each notice as a denial on the run and
the model is told to return `needs_input` naming what it needs. Over ACP, a permission
request reaches you under Needs you; no answer within 20 minutes counts as a denial.

A turn that works on an approved Task shows its subtasks as it goes. Over ACP, ELU reads
the `plan` updates `agy` sends for its own to-do list. Headless in Full access, the turn is
told to keep the list in a JSON file in a private temporary folder of that run; ELU reads
it twice a second and removes it with the run. Headless in Ask or Approve for me, the
subtasks show when the turn ends.

## What is not enforced, or not verified

Everything above comes from Google's documentation and the Antigravity changelog; the
one-time check is the proof, per machine. In particular, until a check says otherwise:

- outside Full access the never list is matched on command text by the hook, a tripwire
  that an obfuscated command gets past; Full access has no never list;
- in Ask for approval and Approve for me, stand-in commands first on the session's PATH
  also refuse the never list by name for what a script runs. That was seen only in tests against a stand-in `agy`, not with the
  real one;
- whether `read_url` denies cover web search (hence the hook), whether the hook loads from
  the private HOME, and the exact shape of the headless notice and of the ACP permission
  request;
- whether `-p` in a folder it does not trust refuses instead of denying softly, and whether
  the keychain sign-in is visible under the private HOME;
- that `-p` reads the task from standard input, that `--print-timeout` takes seconds
  (`900s`), and that the output names the conversation id (the `json` and `resume` steps);
- secret reads: `agy` has no read deny, so a read of a secret folder is stopped only by
  workspace-only access (Read only, Ask, Approve for me); Full access can read anything;
- whether a command can write in a folder given with `--add-dir`: the `write_file` deny
  covers the file tool;
- on Linux, `--sandbox` needs unprivileged user namespaces; without them Read only and
  Approve for me report instead of sandboxing;
- subtasks while a turn runs: that the real `agy` sends `plan` updates over ACP, and that
  its model keeps the list file in Full access. Both were seen only against a stand-in.

## Telemetry

Antigravity's "Interactions data" (prompts and responses used to improve the product) is an
account setting, not a file or an environment variable. ELU cannot turn it off; opt out
in your Antigravity account settings.
