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

`agy` keeps its token in the system keyring: on macOS the login keychain, on Linux the
Secret Service reached over `DBUS_SESSION_BUS_ADDRESS`, which ELU passes through. With no
keyring it keeps a file under its HOME. ELU runs `agy` under a HOME of its own (below), so on
macOS each of those HOMEs holds one link, `Library/Keychains`, to your own
`~/Library/Keychains`: `agy` in ELU then uses the sign-in `agy` has in your terminal. Nothing
else of your home is linked, and no turn may write ELU's state.

On Linux with no keyring (a server over SSH, a container), `agy` keeps a token file under its
HOME. Each of ELU's HOMEs then holds a link to that file in your own home, at both places it
has been reported at, `~/.gemini/antigravity-cli/antigravity-oauth-token` and
`~/.gemini/antigravity-oauth-token`. So `agy` in ELU uses the sign-in `agy` has in your
terminal, and a sign-in made from ELU lands in your own file, for every workspace. ELU never
opens that file and keeps no copy. If `agy` writes a new file over ELU's link instead of
writing through it, ELU moves the newer of the two to your own place the next time it runs
`agy`. Google's documentation does not name the file: the name is from `agy` 1.5.8 itself, the
folder from people who looked at a Linux install, and ELU has not seen it on one. If your
`agy` keeps it somewhere else, the check will say Antigravity is not signed in after `s`
signed it in.

Sign it in from ELU: `s` on the Antigravity line in the Usage tab. ELU leaves its screen and
runs `agy -p /usage` under its sign-in HOME, with your terminal as its input: the browser opens
Google sign-in, you copy the code it shows, paste it there and press Enter. `agy` waits 60
seconds for the code. On a computer with no browser, open the link it prints on any other.
ELU comes back when it ends and reads the sign-in again. `c` on a signed-out line offers the
same sign-in first.

If the 60 seconds pass with no code, `agy` stops (`Error: authentication timed out.`), ELU
comes back and says `Antigravity CLI got no code in 60 seconds. s starts again with a new
link.` Press `s` again: it is a new sign-in with a new link and a new code, and 60 seconds
more. The sign-in screen says so at its top, before `agy` prints its link.

ELU reads the sign-in with `agy -p /usage --output-format json`: no model turn, no quota
spent. Signed in, it exits 0. Signed out, `agy` 1.5.8 prints a sign-in link, opens the browser
and waits a minute for a code; ELU stops it the moment it asks, and runs it with a stand-in
`open` first on its PATH (`agy-home/no-browser/`, which does nothing), so a read never opens a
browser or waits. Signed out, ELU says:
`Antigravity: not signed in for ELU. Sign it in with s on its line in the Usage tab.`

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
before the first turn on Antigravity goes out, whether you wrote to a session on it or
to a bot on it, or the turn started without you: a scheduled turn, a shadow turn, a review,
a standup or a Task's work. The session says so first, then shows each step as it ends, and
then the turn goes on. The check takes about seven short turns on Antigravity and a few
minutes. `c` in the Usage tab starts it too. It runs in a throwaway repository with a planted file outside it, a local web
listener and a marker command:

| Step | Proves |
| --- | --- |
| `signin` | the sign-in read passes under ELU's private HOME |
| `locked-no-write` | a read-only run told to create files creates nothing, inside or outside |
| `locked-no-shell` | told to run the marker command, the marker never runs |
| `locked-no-network` | told to fetch the local URL, the listener sees nothing |
| `json` | headless output parses and the result matches the schema |
| `resume` | a second run with the conversation id continues the first |
| `relay` (optional) | over `agy acp`, a write outside the workspace arrives as a permission request, and a denial writes nothing |
| `live-read-only` (optional) | over `agy acp`, a read-only run told to create files, run the marker command and fetch the local URL does none of them |

The result is saved under your ELU state. A different binary path or release has to
pass again, before the next turn on it; until it does, no run starts.
If a required step is not proven, Read only, Ask and Auto are off for Antigravity here, and
the session says which step and why. Full access is never turned off by the check: it runs
Antigravity as it is, and says the result once, also when you switch such a session to Full
access. In a Full access session a bot that only answers, a shadow and a review run on it
too. Your next message runs the check again only
when that can change the result; a step that failed because Antigravity did what the step
forbids stays failed until `c` in the Usage tab checks again. When `relay` fails,
Ask and Auto still run: blocked actions are denied and reported instead of asked live, and
the permissions picker says so. Every mode then runs headless. When only `live-read-only`
fails, Read only alone runs headless.

The Usage tab shows whether Antigravity is signed in before the check has run. It asks
`agy` what the check asks first, its release (`agy --version`) and its flags (`agy --help`),
then the sign-in read above, under ELU's private HOME: no model turn, no quota spent, no
browser. It does this when the tab opens and it has not read this `agy` yet, when the tab's
usage check is due, and on `r`. The line then says
`signed in · needs a one-time check (c runs it now)`, or `not signed in for ELU · s signs in`.
`c` on that line runs the same check there, with each step under the line as it ends, and the
line then says `ready`, or `Full access only (c checks again)` with the step that was not
proven and why. Signed out, `c` asks first whether to sign in, then runs the check after the
sign-in.

## The private HOME

In Full access `~` is a mirror of your home, so a command finds your sign-ins where it
looks for them: see [Full access](#full-access-your-home-as-) below. The other modes run in
the private HOME described here.

`agy` reads `~/.gemini` for settings, hooks, MCP servers, plugins, skills and context files,
and has no flag to turn that off. So ELU runs it with `HOME` set to a folder under its
own state (`agy-home/`, mode 0700), one per workspace, holding only:

- `.gemini/antigravity-cli/settings.json`: the mode's permission rules, written before each run;
- `.gemini/config/hooks.json`: one PreToolUse hook, `lib/agy-hook.mjs`, run with the mode's name.
  Full access has none: the file is written empty, and slash commands, off in the other
  modes (`disableSlashCommands`), stay on;
- the conversations `agy` keeps there, so a session resumes with `--conversation`, also
  after `/permissions` changed its mode: the rules are rewritten for every run.

A mode switch applies from the next turn: the same conversation continues under the
workspace HOME, whose settings and hook are rewritten for the new mode before the run.

Nothing in your real `~/.gemini` reaches a run: not your settings, hooks, MCP servers,
plugins, skills, `GEMINI.md` or `AGENTS.md`. Context files inside the workspace
(`AGENTS.md`, `GEMINI.md`, `.agents/rules/*.md`) do reach the prompt; `agy` has no flag to
skip them, so a repository can steer the model. `.agents` is a protected path, so the model
cannot add such files itself.

### Full access: your home as `~`

Full access is everything, so a command must find `~/.npmrc`, `~/.config/gcloud`, `~/.aws`,
`~/.docker`, `~/.kube` and the rest as your terminal does. `agy` has no switch that moves
`~/.gemini` away from `HOME`, so it cannot run in your home with ELU's settings. A Full
access run gets `HOME` set to a folder of links beside the workspace's private one
(`agy-home/<workspace>-full`):

- every entry at the top of your home is a link to yours, made again before each run, so
  what you added since is there and nothing of yours is copied;
- `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.cursor`, `~/.grok`, `~/.agents` and your
  own `~/.gemini` are left out, and `~/.gemini` there is the workspace's private one: the
  settings ELU wrote for the run, and the same conversations in every mode;
- a file or folder a command makes at the top of `~` is moved to your home when the run
  ends (or before the next one, if ELU was stopped). A file saved in place of yours
  replaces yours when it is newer; renaming an entry renames yours. What cannot go to your
  home (a coding tool's folder a run made, an older file than yours) is kept beside the
  mirror in a folder ending `-full-aside`, never deleted;
- removing an entry at the top of `~` removes the link only, and yours is linked again at
  the next run. `find ~` and `du ~` see links: a command that walks your home needs its
  full path.

Seen with the stand-in only: no release of `agy` is proven until the one-time check passes
on a signed-in machine.

The prompt goes on standard input, never on the command line, so other users on the
machine cannot read it with `ps`.

## Messages you send while a turn works

`agy -p` runs one prompt; `--input-format stream-json` runs a turn for each line it reads,
one after the other, never into the turn that runs; an ACP turn answers one
`session/prompt`, and ACP has no request that adds to it. (Read from the program's help and
the protocol; no installed Antigravity was asked for this again.) So Antigravity takes no
message while its turn works, and a message you send then is answered at once beside the
turn: a short read-only run on the session's model reads the chat and every step the turn
has taken so far, and its answer shows in the chat, marked "Answered beside the running
turn, from what it has done so far. The turn goes on." A question is done with that. A
message that asks for work says so and starts the next turn when this one ends, and Enter
in the empty message box sends it now: the turn stops as `/stop` stops it and what has not
run starts the next turn at once. Over ACP the next turn goes on in the conversation that
was stopped (`session/resume`). A headless run names its conversation only in the line it
ends with, and prints nothing of its work before that line. So after a stopped headless
turn the next one starts from the chat, and is told that the turn before it was stopped and
that the files it changed are as it left them. A headless turn has no steps for the run
beside it to read, so there the answer comes from the chat alone.

## What each mode enforces

| | Read only | Ask for approval | Approve for me | Full access |
| --- | --- | --- | --- | --- |
| How it runs | `agy acp` after `relay` and `live-read-only` passed, else `-p --sandbox` | `agy acp` after `relay` passed, else `-p` | `agy acp` after `relay` passed, else `-p --mode=accept-edits --sandbox` | `agy acp` after `relay` passed, else `-p --dangerously-skip-permissions` |
| Permission requests over ACP | ELU answers no to each, at once | reach you under Needs you, unless a rule of yours allows it | same | ELU answers yes to each, at once |
| Settings | `request-review`; `command`, `write_file`, `read_url`, `execute_url`, `mcp` denied; workspace only | `request-review`; `command`, `read_url`, `execute_url`, `mcp` ask; workspace only; protected files and secret folders denied to the file tool | `proceed-in-sandbox`; `sudo` and `.git` denied; workspace only; protected files and secret folders denied | outside access allowed; `read_url`, `execute_url`, `mcp` allowed; no deny rule |
| Hook | denies web search, commands, edits, image generation, scheduling and subagents | asks for web search; denies push, tag, merge, deploy and publish by command text | denies web search and the never list; sends the rest to the reviewer | none installed |
| Named folders | none | `--add-dir` each; `write_file` denied in each | same | `--add-dir` each |
| Web | denied | asks, or reported | reviewed, or reported | allowed |

A named folder is read and never written in Ask for approval and Approve for me: its
`write_file` deny is the one a protected file gets. A folder that holds the workspace or
lies inside it gets no deny, because a deny wins over the workspace's edits: for example
the folder of all your projects, where a worktree sits beside its repository.

In headless mode a blocked action is a soft deny: the run goes on, exits 0, and prints a
notice on stderr naming the tool. ELU records each notice as a denial on the run and
the model is told to return `needs_input` naming what it needs. Over ACP in Ask for approval
and Approve for me, a permission request that none of your rules allows reaches you under
Needs you; no answer within 20 minutes counts as a denial.

In Full access and Read only no request reaches you. ELU answers each one itself, at once:
yes in Full access, no in Read only. A yes is for that one call wherever `agy` offers one:
ELU picks it ahead of "always allow", because a rule `agy` kept would live in the workspace
HOME the other modes share.
Each no is recorded as a denial on the run. Read only over ACP has the same settings and hook
as headless Read only. ELU starts `agy acp` without the `--sandbox` flag a headless Read only
run gets, so the `live-read-only` step is what proves on this machine that it writes nothing,
inside the project or outside it.

Over ACP the chat shows each thought and each tool call as it happens, in every mode. A
headless run prints only its result, so it has no steps to show, while it works or after.
Until it ends the chat shows the working line and, under it, how long the run has taken:
`1m 12s so far. Antigravity reports only when it ends.` A session on your other computer
shows the same line.

What decides between the two is the one-time check's record for this `agy` binary and
release, nothing else. Ask for approval, Approve for me and Full access run over ACP when
its `relay` step passed. Read only runs over ACP when `live-read-only` passed as well. A
check that ran before ELU 0.1.20 has no `live-read-only` result, so Read only stays headless
on that machine until the check runs again, which a new `agy` release brings.

A Full access or Read only turn whose `agy acp` ends before the model was asked anything
runs headless instead, once, continuing the session's conversation, and the chat shows the
line above.
Sign-in, quota and rate-limit failures are reported as they are, not retried. Ask for
approval and Approve for me do not fall back this way: their headless run cannot ask you.

`/stop` ends an ACP turn and the commands it started, as it does a headless one. The steps
it showed stay in the chat, and its line says `stopped`.

The turn limits hold in both. Over ACP a turn that prints nothing for the quiet limit (10
minutes, or the role's `timeoutSeconds`) is stopped, as with every vendor that prints as it
works. A headless run prints only at the end, so it has no quiet limit, only the two-hour cap.

## The model and the tokens

Headless, the model you chose with `/model` goes on the command line (`--model`), and the
output names the model that ran. Over ACP there is no such flag: the session itself holds
its model. Right after the session opens and before anything is asked, ELU sets the model
you chose the way the session offers it: `session/set_config_option` on its `model` option,
or `session/set_model` where it lists its models instead. A resumed conversation that
already runs your model is left as it is. With no model chosen nothing is set, and `agy`
runs its own.

Where `agy acp` offers no way to choose a model, or refuses the one you chose, the turn has
not started. Full access and Read only then run headless with `--model`, once, and the chat
shows the line that counts the time. Ask for approval and Approve for me do not run on
another model: the turn ends with `Antigravity could not finish. It offers no way to choose
a model over ACP.` Choose Antigravity's own model with `/model`, or Full access.

The run keeps the model the session named, and the tokens `agy` sent with the answer to the
turn: ACP's `usage` (input, output, cache read, cache write; thought tokens count as output
where the total counts them apart), or `_meta.quota.token_count`. The Usage tab's top agents
show them. Where `agy` sent none, and for every headless run, the row says `not reported`,
never 0. Antigravity reports no cost.

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
- on Linux with no keyring, where `agy` keeps its token file and whether it writes it in
  place (ELU handles both ways of writing it, and links both places it is reported at);
- that `-p` reads the task from standard input, that `--print-timeout` takes seconds
  (`900s`), and that the output names the conversation id (the `json` and `resume` steps);
- secret reads: `agy` has no read deny, so a read of a secret folder is stopped only by
  workspace-only access (Read only, Ask, Approve for me); Full access can read anything;
- `agy acp` in Full access and Read only was seen only in tests against a stand-in `agy`,
  not with the real one: which calls it asks about when no session mode is set; that it
  offers a yes for one call beside "always allow" (where it offers only "always allow", Full
  access picks that, and what `agy` then keeps is not known; its settings file is rewritten
  before every run); and that a Read only session follows the deny rules in its settings.
  The `relay` and `live-read-only` steps check the last on your machine; where the real
  `agy` behaves otherwise they fail, and the mode runs headless;
- the model and the tokens over ACP were seen only in tests against a stand-in `agy`, which
  follows the ACP standard: that `agy acp` lists a `model` option or its models, takes the
  ids `--model` takes, and ends a turn with `usage`;
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
