# Permissions

A turn runs in one of four profiles. You choose one of three modes when you start a
session; a turn that is not your own session's runs read only.

## Modes

| | Read only | Ask for approval | Approve for me | Full access |
| --- | --- | --- | --- | --- |
| Who gets it | bots that review or answer, teammate questions, tasks saved without a mode | your session | your session; at most this for a schedule whose mode you did not pick | your session with its bots' schedules, and a schedule you pick it for |
| Reads | the workspace; answer turns may read your home | without asking: the workspace, folders and, for answer turns, your home (below) | same | anything |
| Edits in the workspace | edit turns only | yes | yes | yes |
| Edits outside it | no | asks | a reviewer model decides; on Antigravity refused, and on Claude Code an answer turn's edit asks | yes |
| Shell inside the vendor sandbox | no | yes; Antigravity runs no sandbox, so every command asks | yes | yes, no sandbox |
| Shell outside it, network, web tools | no | asks | a reviewer model decides | yes |
| Secrets and ELU state | no | no | no | yes: Full access denies nothing |
| Tools | read and search | the vendor's file, shell and web tools | same | every tool the vendor has |
| Your environment | a short list (`PATH`, `HOME`, language, temp folder) | same | same | all of it: your SSH agent, your GitHub and cloud sign-ins, your proxy |
| Never list (push, tag, merge, deploy, publish) | blocked | blocked; every escape asks | stand-in commands and, except on Codex, deny rules; a command that gets past them gets through if the reviewer allows it | none: the model runs them without asking |
| Runs in | worktree | worktree or a named branch | same | also here |
| Checks | sandboxed, no network, structural limits | same | no network; dependency files may change | network on; no structural limit blocks, what one finds is shown as a note |

Secrets here are files Git does not track whose names look like secrets: `.env*`, `.npmrc`,
`.netrc`, `.pypirc`, `auth.json`, `credentials`, `credentials.json`, `id_rsa`, `id_ed25519`,
`*.pem`, and the secret folders in your home. On Claude Code a file of that name that the
repository tracks is read in every mode, as any other tracked file: it is in the repository
already. A teammate's question is denied the names whatever Git says. Outside a Git work
tree every file of those names is denied.

## Full access

Full access is everything. A turn that runs with it has no limit of ELU's:

- **Files.** It reads and changes any file: secret files (`.env`, `.npmrc`, keys), the
  secret folders in your home (`~/.ssh`, `~/.aws`, `~/.config`), ELU's own folder, and
  your vendor sign-ins (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.grok`).
- **Folders.** `/permissions folders add <path>` takes any folder there is: a secret
  folder, ELU's folder, one outside your home, your home itself, and as many as you name.
  A path with `*`, `?`, brackets or braces in it starts too.
- **Commands.** Any command runs without asking and outside any sandbox, with push, tag,
  merge, publish and deploy among them. There is no never list.
- **Your environment.** Commands get the environment a command you type gets: your SSH
  agent, your GitHub and cloud sign-ins, your proxy, your npm settings.
- **Tools.** Every tool the vendor has. Claude Code: helpers, background commands,
  notebooks and the rest of its default set. Codex: every feature its release ships
  (helpers, the plan, images, skills, plugins). Grok Build: its memory, its subagents, its
  server-side search, and as many turns as the work takes. Antigravity: its slash
  commands, and no hook of ELU's between it and a tool call.
- **Network.** The internet and anything on this computer, the local A2A endpoint
  included when you have turned it on.
- **Checks.** Your project's own tests and build still run after an edit. ELU's structural
  checks (ignored output, files outside the declared paths, deleted tests) fail nothing:
  what one finds is shown as a note.
- **Approvals.** Once a session has Full access, ELU allows everything its running turn
  asks, a removal and an MCP tool included.
- **No wait.** A message runs at once. The one-time check of Antigravity and Grok Build
  proves the other three modes and nothing Full access needs, so a Full access turn never
  runs it and never waits for one, its own or another session's
  ([Grok Build](vendors/grok.md#the-one-time-check)).
- **Publishing.** `/publish` pushes to the pull request that is open for the branch,
  such as one the model opened itself, whether or not it is a draft, and leaves its text
  as it is. Below Full access `/publish` pushes only to a branch with no pull request, or
  with one draft it can keep as a draft.

What stays, and why:

- The names that choose a vendor's own account and endpoint (`ANTHROPIC_*`, `CLAUDE_*`,
  `OPENAI_*`, `CODEX_*`, `XAI_*`, `GROK_*`, `GEMINI_*`, `GOOGLE_API_KEY`) do not come from
  your shell: a key among them would move the turn to another account than the one you
  signed in with.
- The vendor starts with the settings ELU gives it, not with your vendor settings file or
  your hooks: ELU reads the run's output, and a setting it did not make can change that
  output. On Claude Code your own MCP servers are on, as in every mode (`/mcp`). Codex,
  Grok Build and Antigravity get no MCP servers from ELU in any mode.
- A turn has to answer in the form ELU reads, and a turn that prints nothing for 10
  minutes is stopped ([How long a turn runs](#how-long-a-turn-runs)). That is how a
  vendor that hangs is told from one that works. A turn that works is never stopped.
- Codex cannot ask you a question in the middle of a turn: nobody could answer it there.
- Grok Build and Antigravity do not start in your home itself: each loads settings from
  `~` that ELU cannot turn off (Grok Build the agents, plugins and permission rules of your
  Claude Code folder, your own `~/.grok` agents and your `.agents` skills; Antigravity
  `~/.gemini`). So `~` in their runs is a folder of links, one to each entry
  at the top of your home, made again before every run. `~/.npmrc`, `~/.config`, `~/.aws`,
  `~/.docker`, `~/.kube`, `~/.ssh`, `~/.gitconfig` and everything else there are your own
  files, so npm, cloud CLIs, `gh`, Git and SSH are signed in as in your terminal.
  - Not linked: `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.cursor`, `~/.gemini`,
    `~/.grok` and `~/.agents`. The vendor's own folder there is the one ELU wrote for the
    run. Yours are never written through `~`; a command still reaches them by full path.
  - A file or folder a command makes at the top of `~` is moved to your home when the run
    ends. A file saved in place of yours replaces yours. Renaming an entry renames yours.
  - Removing an entry at the top of `~` removes the link only: yours stays and is linked
    again at the next run. A command that walks `~` without following links (`find ~`,
    `du ~`) sees links: give it your home's full path.
  - Claude Code and Codex run in your home.
- What a vendor asks in every mode, ELU answers for you with yes, at once. Claude Code
  asks before `rm` or `rmdir` on your home, the working folder or a top-level folder.
- Who gets Full access: your own sessions, the schedules of their bots, and the schedules
  you pick it for. A bot's scheduled turn runs in its session's mode, Full access included.
  A request to the local A2A endpoint is your own and runs your default mode as it is. A
  teammate's message that starts by itself runs with Approve for me at most, and a
  teammate's question runs read only.

Everything in the sections below about deny rules, the never list, the sandbox and
approvals holds in the other modes.

"Asks" is a live approval in your terminal where the vendor has a relay: Claude
Code, and Antigravity and Grok Build once the `relay` step of their one-time check
has passed on this machine. Elsewhere the action is denied and reported, and the
model returns `needs_input` naming what it needs. "A reviewer model decides" is the
vendor's own reviewer, such as Claude Code's auto mode.

A reply ELU cannot read is asked for once more. Claude Code is asked in the
same session, which has done the work already, and the chat says it was asked for
its reply again. Another vendor, or a Claude Code session that cannot be picked
up, starts once more for the same message. The chat then says it was started
twice, because anything the first one ran the second may have run again. A
`needs_input` reply that names what it needs in its summary and asks no question
is read as it is.

Read only has no shell unless the project's settings file names command prefixes
for the model (`roles.lead.commands` in `.elu-code/config.yaml`, for example
`npm test`). ELU never adds one by itself. The test and build scripts it
finds in a project run as checks after an edit, inside the check sandbox. A
settings file counts only after you have approved it on this machine: ELU
shows it and asks when it is new or changed. Until you approve a change, the
settings you approved last stay in use.

The workspace is the place you picked: a worktree on a new task branch, a
worktree with a named branch checked out, or, in Full access, the checkout
itself with its current branch and a dirty tree allowed. Folders are extra
directories in your home that the model may read this session, added with
`/permissions folders add <path>`; below Full access they are never a secret
folder or ELU's state. A folder that holds one of those is refused too, and a link counts as
where it leads: with `~/.config` linked to `~/dotfiles/config`, `~/dotfiles` is
refused. Full access takes any folder ([Full access](#full-access)); a session that leaves
Full access keeps only the folders the other modes take. A folder a trusted teammate's
message names is offered the same way when you work on it with `w`. In Ask for approval and Approve for me a folder is read and never written:
Claude Code denies writes there to its file tools and to sandboxed commands, Codex gives
the folder read access only, and Antigravity denies writes there to its file tool. On
Claude Code and Antigravity a folder that holds the workspace or lies inside it, such as
the folder of all your projects (a worktree sits beside its project), gets no such deny,
because a deny there would refuse every edit in the workspace. Full access adds no rule
for folders. Answer turns have no workspace: they run in the project
folder, and in Ask and Auto a write there asks like any outside write.

In Ask for approval and Approve for me, answer turns read your whole home folder
without asking on Claude Code, Codex and Grok Build: your session's own, and a working
bot's when you write to it. Claude Code is given the home folder with `--add-dir` for
those turns; Codex reads anywhere in every turn; Grok Build allows `Read` and `Grep`
with no path. On Claude Code a command that stays in the sandbox also reads outside the
workspace without asking. Antigravity keeps its file tool to the workspace and folders.
The secret folders (`~/.ssh`, `~/.aws`, `~/.config`, `~/Library` and the rest), each
vendor's own folder (`~/.claude`, `~/.codex`, `~/.gemini`, `~/.grok`) and ELU's
state stay closed below Full access, as the table says. Your session's answer turns, and a working
bot's until the session's work is published, also get a list of up to 60 Git
repositories found in your home, so the model can find the code you mean.

## Which profile a turn runs with

In order: a bot that reviews or answers runs read only; a teammate's question or
review, or a read-only turn, runs read only; otherwise the session's mode. A task
saved without a mode runs read only.

Your message to a session whose approved Task stopped (on a question, a block or your
stop) continues that work with the Task's edit access, in the session's mode now. Only a
session whose Task is done answers in a read-only turn, and that turn is told it cannot
change files.

A bot that works (one with a schedule, and `@lead`, `@qa` and each bot you make) runs in
the session's mode when you write to it, and so do the helpers it hands work to. On Claude
Code a working bot can start helpers when its instructions ask for them. They run on the
bot's own model unless the bot was saved with another for them, as `@lead` was, with the
tools and the denied commands of the bot's turn, and they start no helpers of their own.
In Full access a helper has every tool and is told nothing it may not do.
A bot that is allowed to merge pull requests starts helpers only when it was saved with a
model for them. A turn its schedule started runs in the session's mode too, Full access
included: pick Full access for the session, when you start it or with `/permissions full`,
and its bots' schedules run with it, with nobody watching. In a session that edits your
checkout in place, they run while the session has Full access.

Full access has no never list. A turn that runs with it, your session's or a working
bot's, runs what your own shell could: `git push` (tags too), `git tag`, `git merge`,
`gh pr merge`, `gh release`, `npm publish`, deploys, and adding or removing an MCP
server. It gets no deny rules for them, no stand-in commands and no line in its
instructions that forbids them; its instructions say it may push, open and merge pull
requests, tag, publish and deploy when the task calls for it. The switch that lets a bot
merge pull requests changes nothing there. Everything below holds in Ask for approval and
Approve for me, and a read-only turn has no shell to run them with.

One entry of the never list can open outside Full access: a bot that is allowed to merge
pull requests (`@elu` comes allowed; a bot you make is not) may run `gh pr merge` in its
own working turn on `claude`. Ask for approval still asks you before each merge. Push,
tag, `git merge`, deploy and publish stay blocked for that bot and for everyone else.

A longer command line that holds a never-list command is refused whole. The chat
then names the part, as in `Blocked: git tag is not allowed outside Full access`, and
does not point at `/permissions`. Each turn's instructions name the commands once
and say how to list tags without `git tag`: `git for-each-ref
--sort=-creatordate refs/tags` or `git describe --tags`.

A rule on the command's text does not see what a script runs, and Codex has no
deny rules. So every session in Ask for approval or Approve for me also gets stand-in
commands, on every vendor; on Codex they alone hold the never list. A
private folder goes first on the session's PATH with one small script per command
word (`git`, `gh`, `npm` and the rest). Each refuses the never-list call by name,
in the same words, whatever runs it: the model, a script, `sh -c`, `npm test`.
The command is read as the tool reads it, so `git -C dir push` is refused and
`git merge-base` or `git stash push` is not. Every other call goes to the real
command with its arguments untouched; `git tag` alone and `git tag -l` only list
tags and pass. The chat shows the refusal as a Blocked line even when the turn
went on to answer.

Another tool may wrap a command with a script of the same name that looks along PATH
for the real one and runs the first other file it finds: a terminal app that wraps the
vendor's command does, for `claude` and `codex`. Handed ELU's stand-in in place of the
real program, such a script is handed straight back, and stops as a loop. So the
stand-in named `claude` (it refuses `claude mcp add`) has a folder of its own, which is
never on the PATH Claude Code itself is started with, and it takes that folder off PATH
whenever it hands a call on. The stand-in for any other command does the same for a
call that came back to it. The vendor's program is then reached through the other
tool's script in every mode.

Pushing to a folder on this machine and working in a scratch repository under the
temporary directory are not publishing, and a project's own tests do both, so the
stand-in for `git` lets them through:

- `git push` passes when every place it would push to is a path or a `file://` URL
  on this machine. git itself is asked, so the remote's `pushurl`, every
  `url.<base>.insteadOf` and `pushInsteadOf` rule and the remote of a push that
  names none are read as git reads them. A destination on another machine, one git
  cannot place, or an option the stand-in does not know (`--receive-pack`,
  `--repo`, submodules pushed on demand) is refused before anything is sent.
- `git merge` and a `git tag` that makes or deletes a tag pass when the repository
  they act on lies inside the system temporary directory: its top level and the
  folder that holds its history, links resolved. Everywhere else they are refused.
  A worktree under the temporary directory of a repository kept elsewhere is that
  repository, and is refused.

The temporary directory is the one ELU itself was started with, and `/tmp`;
a session cannot name another by changing `TMPDIR`.

Stand-in commands are not a sandbox. A full path to the real command
(`/usr/bin/git push`), a changed PATH, a Git alias or another program that does the
same work gets past them; the folder is written again when the next session starts.
The vendor's sandbox, where it runs one, still stands behind them; Antigravity in
Ask for approval runs none, so every command asks and one you approve runs outside
any sandbox. A session in Full access gets no stand-in folder on its PATH.

## Git in the sandbox

In Read only, Ask for approval and Approve for me a command in the sandbox reads the
repository's Git folder and writes nothing there. `git status`, `git diff`, `git log`
and `git show` work without asking. `git add`, `git commit`, `git stash` and the like
are refused in the sandbox.

What a sandboxed command can read that way:

- The repository's history through git: every committed version of every file. That
  includes a file committed once and later removed. A secret-looking file the
  repository tracks (an `.npmrc`, an `.env.example`) is not hidden at all: every clone
  has it, and the sandbox and the file tools read it as any other tracked file.
- The Git settings file: remote URLs, and a token if one is written into a URL.
- The stash and the reflog.

The sandbox has no network of its own: a sandboxed command reaches only a host you allowed
when asked (see Network below), so it cannot send any of it anywhere else. What it prints
goes to the model, as all output does, and into the session's record.
ELU's own records in the folder (`.git/elu-code`) stay closed to commands and
to the file tools. A teammate's question reads none of the Git folder.

## Approvals

Claude Code is started with ELU's approval relay as its permission prompt
tool: a small MCP server over stdio, started from the same private config file
as your own servers, with one tool. When Claude would prompt, the call becomes a
request under ELU's personal directory and the terminal shows it under
Needs you. Allow lets the action run; deny tells the model not to retry it
another way. The request shows in every ELU window of yours that lists the
session, on this computer and on your other computers: its row says what it
waits for, any of those windows can answer it, and the terminal bell rings once.
No answer within 20 minutes is not a no: the action does not run, and the model
is told that nobody declined it, to go on with the work that does not need it,
and to say at the end what still waits for your answer. The session then shows
`Not done: ... No answer in 20 minutes; reply to try again.` under the reply, or
`Stopped: ...` when the turn could not go on without it. The turn's limits
(below) wait while a request is open, and the conductor does not treat the wait
as a stall. Every decision is kept with the task, and blocked actions are kept
on the run. In Full access the relay allows every call at once: nobody is asked
and nothing is refused, and the task keeps each as allowed by Full access.

### How long a turn runs

A turn that is still working runs until it ends, however long that takes, in every mode: no
clock of ELU's stops work. It is stopped only when the vendor has printed nothing for 10
minutes. A command the model runs counts as working for as long as it runs, even when it
prints nothing, such as a long test run: the 10 minutes count only while no command is
running. Time a request waits for you does not count, and the 10 minutes start again once
it is answered.

In Approve for me and Full access ELU tells a turn that went quiet to carry on, once, and
the chat says so: "No output for 10 minutes. ELU told it to carry on." If the same turn goes
quiet again, it stops. In Ask for approval and Read only it stops the first time. A stopped
turn says so in the chat in one line, such as "Stopped after 10 minutes with no output. Your
changes are kept. Reply to carry on." Its edits stay on disk, and your next message carries
on. `roles.lead.timeoutSeconds` in `.elu-code/config.yaml` sets the 10 minutes; the 900 it
says by default means the default, as 600 does.

A vendor that prints its answer only at the end (Antigravity and Grok Build without the live
relay) has no clock at all: silence says nothing about it, so it runs until it ends or you
`/stop` it. So does each of the project's checks: a check runs until it ends, however long
that takes.

A push with `/publish` has no time limit either, in every mode, and nor do the project's
pre-push guards it runs. A guard, or the push itself, that prints nothing for 10 minutes is
stopped and says so: "Stopped the pre-push guard after 10 minutes with no output. Nothing was
pushed."
ELU 0.1.24 and earlier stopped a guard, and the push, after 2 minutes; a session from then
keeps its guards again, without that limit, at its next `/publish`.

ELU 0.1.19 and earlier also stopped a turn after 2 hours, working or not. A session stopped
that way says "Stopped by a time limit an earlier version had. Reply to carry on." In Approve
for me and Full access ELU carries it on by itself the next time the app opens, once, and
says so in the chat.

The keys are `y` allow and `n` deny, each followed by Enter. Where the session can
be given Full access there is a third, `f`: it asks what `/permissions full` asks,
then allows the action and switches the session to Full access, so that session stops asking.
It is not offered for a turn that runs read only.

### Network

In Ask for approval, a sandboxed command that connects to a host (`curl https://elu.dev`,
`npm view`) asks you under Needs you as "Network access to elu.dev". Claude Code asks this
on its own output, not through the relay. ELU starts every turn of yours with the prompt as
a stream-json message (`--input-format stream-json`) and keeps its input open, so a message
you send while it works reaches it ([vendors/claude.md](vendors/claude.md)), and in Ask for
approval it writes your answer back there. Whatever else Claude Code asks on its own output
(a tool call, a form from an MCP server) is answered the same way, by the session's mode.
In Full access it is allowed at once: nobody is asked and nothing is refused. In Approve
for me and Ask for approval one of your rules or a default answers it, and otherwise you
are asked under Needs you. In Read only it is refused. Allow lets that host through for the rest of the session: Claude Code keeps it
for the run, and later turns of the session start with it in the sandbox's allowed hosts.
Deny, or no answer, fails the connection. Before, the input was closed once the prompt was
read, and Claude Code denied every host without asking and reported it as "user denied".

`a` keeps the host as a rule. Hosts that publish packages, take pushes or deploy
(`registry.npmjs.org`, `pypi.org`, `github.com`, `ghcr.io`, Docker Hub, and the deploy APIs
of Vercel, Netlify, Fly, Firebase, Cloud Run, Heroku and Cloudflare) are never kept as a rule,
and one you allowed is asked again in the session's next turn. In Approve for me Claude
Code's own classifier decides, and Full access has no sandbox.

### Allowed without asking

`a` (always) beside `y` and `n` keeps the kind of action as a rule and allows it now. It
shows the rule in plain words, then asks where: **This project** (the default) or **All my
projects**. A rule is kept narrow:

- A command keeps its program and subcommand: `npm test`, `git diff`, `pytest`,
  `python -m pytest`, `npm run lint`, `gh pr view`. Arguments may change.
- A program that does too much as a word, such as `npm install`, `curl`, `docker`, `find`
  or `git branch`, keeps the exact command. So do programs that read the files you name
  (`cat`, `grep`, `rg`, `ls`, `head`, `tail` and the like) and `git fetch`, `clone` and
  `ls-remote`.
- The arguments are checked each time a rule answers: one that names a secret or ELU's
  own files, or a git option that runs a program or writes a file (`--output`, `--ext-diff`,
  `--no-index`, `--upload-pack`), asks.
- A line that joins or wraps commands (`;`, `&&`, `||`, `$( )`, backticks, a redirect, a
  leading `NAME=value`) gets no `a`; it can only be allowed once. A pipe into `head`,
  `tail`, `wc` or `grep`, and `2>&1`, are read through.
- No rule for the never list, removals (`rm`, `rmdir`), `sudo`, `env`, `xargs`, `ssh`,
  `chmod`, inline code (`node -e`, `python -c`, `sh -c`), a full path to a program, a
  secret (`.env`, keys, credentials, `~/.ssh`, `~/.aws`), an MCP tool or a web search.
- A rule asked inside the sandbox applies inside it only; one asked outside it says so.
  Where commands run with no sandbox at all (Antigravity, Grok Build, or Claude Code where
  its sandbox cannot start), every command counts as outside it.
- An edit becomes edits in the session's own workspace, in turns that edit (a Task you
  approved). Outside the project it is that one file. `.git`, `.elu-code` and secrets are
  asked each time.
- A web fetch becomes that host, and so does a sandboxed command's network access, except
  the hosts that publish, take pushes or deploy (see Network above).

A path is judged where it really leads: a link in the project to a secret, to your home or
to another folder is not a path in the project, for a rule or a default.

Rules are kept in your personal directory (`permission-rules.json`), never in the repo.

These are on from the first run and apply in every mode:

1. Read and search files in the project: the vendor's file tools, and commands such as `ls`,
   `cat`, `grep`, `rg` and `find` without `-exec` or `-delete`, on paths inside the project
   that are not secrets. A command only inside the sandbox, and never with an option that
   runs a program or writes a file (`rg --pre` or `--hostname-bin`, `tree -o`).
2. Git read commands: `status`, `diff`, `log`, `show`, `branch` (listing only), `blame`.
   Inside the sandbox only.
3. The project's own `test`, `lint`, `typecheck`, `format` and `build` scripts
   by name from `package.json` or the `Makefile`, and `cargo`, `go` and `pytest` checks where
   the project has `Cargo.toml`, `go.mod` or a Python project file, plus `node --test`. Inside
   the sandbox only, so never on Antigravity or Grok Build, which run commands without one.

They never cover installs, removals, network writes or secrets. In Ask for approval this
means the reads and checks a session runs most no longer wait for you, while anything that
leaves the sandbox, edits outside the project or reaches the internet still asks, unless a
rule of yours covers it.

`/permissions rules` lists the defaults and your rules, numbered, with where each applies:
`x` removes a rule or turns a default off, `o` turns a default on. `/permissions rules remove
N` and `/permissions rules on N` do the same by number, and so do `elu permissions`,
`elu permissions remove N` and `elu permissions on N`. A file that cannot be read turns
every rule and default off until it is fixed.

When a rule or a default answers, nothing waits under Needs you; the decision is kept with
the task as allowed by your rule or by default, and the session shows "Allowed by your rule:
npm test".

Your rules apply in your own sessions and your bots' sessions, and in a session started from
one of your own machines (`origin.mine`). A session a teammate started uses the defaults
only, and `a` is not offered there. Rules live on each machine: a session runs with the rules
of the machine it runs on. An approval of a session on your other computer waits on both
machines, with `a` beside `y` and `n` where that machine offers it, and `a` from either one
keeps the rule on the machine where the session runs. That machine makes the rule from its own
copy of the request.

Every vendor that asks goes through the relay: Claude Code through its permission prompt
tool, Antigravity and Grok Build over ACP. The relay checks the never list, then your
rules, then the defaults, before it writes a request: no rule or default answers a
never-list command, so outside Full access it is never allowed without you. Claude Code's own allow rules are not
used, so a rule never lets a command leave the sandbox without the relay seeing it. Codex
does not ask during a turn, so rules change nothing there.

## Plan first

A message that asks for a change to code or files, or for work that needs planning, comes
back as a Task: a title, a description, the goal, the objectives that say when it is done,
a priority, a severity, the success criteria and the model's estimate of the work in
minutes. This holds for the session's model and for a bot that works, such as `@lead`.
Who approves the Task depends on the session's mode:

| Mode | The Task |
| --- | --- |
| Read only, Ask for approval | Waits for you. Approve it with `y` then Enter, reject it with `n` then Enter, change it with a message, or approve it in a message in your own words. Nothing is edited before. |
| Approve for me, Full access | The mode approves it. It is written and shown like any other, marked `approved by Approve for me` or `approved by Full access`, nobody waits, and the work goes on in the same message. |

In Approve for me and Full access the agent is never told that you must approve first, and
you never type an approval. Work that changes no repository file, such as running a
command or reading logs, is done in the turn that writes the Task. Work that changes the
repository goes on in the editing turn right after it. A Task that waited from before
starts when you give its session one of these modes, or with your next message there.

ELU enforces this much, on every vendor:

- The editing turn starts only for an approved Task: one you approved, one the session's
  mode approved, or one a schedule or a handoff recorded. That is the turn that runs in
  the session's workspace and is followed by the checks and the review. A reply that asks
  for an edit with no Task is asked for its Task once more. If none comes, then in Read
  only and Ask for approval the reply is kept as a plain answer with a line that says no
  Task was read, and nothing starts; in Approve for me and Full access ELU writes the Task
  from your request as you wrote it, and the work goes on.
- In Read only and Ask for approval only you approve, in your own session: with the key,
  or in a message. A few words that all say go (`yes`, `ok`, `I approve`, `go ahead`, `yes go ahead`,
  `do it`, `sounds good`, `continue`) approve at once. An approval in other words is read
  by the turn that answers your message, which is told that a plain approval in any words
  counts; the work starts right after its reply. Over a session on your other computer
  the same few words approve its Task there, with or without that computer's `@name`; an
  approval in other words goes to the session there, as any message typed over it does.
  After `@here` either one is a message for your agent here. A teammate's message, a
  schedule and a bot's own turn cannot approve a Task.
- A mode approves a Task only in your own session. A session a teammate's message started
  keeps your approval in every mode (see below).
- A Task is read as untrusted text. The title is one line of up to 80 characters; the
  description up to 2000; the goal up to 500; one to eight objectives of up to 300 each;
  the priority is urgent, high, medium or low; the severity is critical, high, medium or
  low; at most eight success criteria of up to 200 each. The estimate is a whole number of
  minutes up to a week, else it is not set. Control characters are refused, and markup is
  shown as typed.
- After approval the model reports its subtasks, the objectives it says are met, and the
  minutes it thinks are left, which move the ETA. While the turn runs, the subtasks follow
  the model's own to-do list; each vendor's page says how it is read. A
  report cannot change the goal or an objective: those change only through a revised Task,
  which is approved again the same way. Done on the card is the model's report. The checks
  and the review are what verify the edit.

The rest is an instruction to the model, not a boundary. The model decides whether a
message needs a Task and whether a follow-up is inside a Task that is already approved. In
Read only and Ask for approval it is told to change nothing in the turn that proposes one.
That first turn runs with the session's mode, in the project folder, so what stops an edit
there is the mode:

| First turn | Claude Code | Codex | Grok Build | Antigravity |
| --- | --- | --- | --- | --- |
| Read only | no edit tools | read-only sandbox | edits denied | edits denied |
| Ask for approval | an edit in the project folder asks you | read-only sandbox | an edit asks you, or is denied and reported | not fenced: it can edit in the project folder |
| Approve for me | an edit in the project folder asks you | read-only sandbox; Codex's reviewer model decides a request to leave it | Grok's reviewer model decides | not fenced |
| Full access | not fenced | not fenced | not fenced | not fenced |

Some turns wait for nobody in any mode:

- A session a schedule starts, and a bot's own scheduled turn, have nobody to approve.
  The Task is recorded as started by schedule and the work goes on.
- A teammate's handoff you chose to work on with `w` records its Task as started by a
  handoff and goes on.
- A teammate's question and any read-only turn change nothing and make no Task.
- `elu run "<goal>"` on the command line makes no Task.

A teammate's message that starts a session by itself (Auto) or that you approve with y is
not among them: that session runs in your default mode, Full access included, as if you
had typed the message yourself, and its Task waits for your approval as one you asked for
in Ask for approval would, whatever the mode. A later message in its thread runs in the
session's mode at the time, Full access included.

### When something fails, and when the work is done

What the agent is told, in every mode that has a shell:

- A step that fails is its own to fix: a missing folder, a command that exits non-zero, a
  tool error, a network error. It finds the cause, fixes it or goes another way, and keeps
  going. It asks you only when it cannot go on at all, or when the choice is truly yours,
  such as spending money you did not approve or deleting your data. Then it asks once and
  says what it will do by default.
- In Ask for approval and Approve for me, an action that you, the approver or a rule
  declined is not tried another way: the agent stops and names the action it needs. Only a
  declined action is such a stop. Full access declines nothing, so there the agent is told
  of no stop.
- When the work is done it says what it did and ends. It does not ask what to do next or
  offer choices. `continue` after a finished Task means the next piece of the goal.

## Lifecycle

- New sessions start with your personal default, `ask` until you change it
  with `/permissions default <mode>`; the place is a worktree.
- A follow-up inherits the session's mode, place and folders. Switching the
  mode applies from the next turn and is recorded on the session; the pinned
  policy does not change.
- A switch made while a turn runs is saved at once, and so are the spending
  limit, the folders and the bots. The turn in progress keeps the mode it
  started with, with one exception: after a switch to Full access, ELU
  allows that turn's approvals for you, the one that waits and the ones it asks
  next, all of them: a removal with `rm` or `rmdir`, an MCP tool and a command too
  long to show whole included. The never list is not asked,
  so it stays refused in that turn, which started without Full access; the next
  turn runs it.
- A turn that starts in Full access asks you nothing. What its vendor asks in
  every mode (Claude Code asks before `rm` or `rmdir` on your home, the working
  folder or a top-level folder) is allowed at once. The same holds for a turn
  whose session you set to Full access while it works, and with the app closed:
  whichever way the vendor asks, ELU's answer does not wait for the app.
- The automatic edit task of a conversation inherits the conversation's choices.
- A schedule stores the mode of the form it was made in. One whose mode you did
  not pick yourself runs with your default at each run, and never above `auto`.
  One you pick Full access for keeps `full`, and each of its runs starts in Full
  access, with nobody watching: it reads anything, runs any command and uses the
  internet without asking, push, tags, merges, publishing and deploys included, as
  in any Full access session. Before it saves such a schedule, the form says so in one
  line and asks you once. A schedule from an earlier version runs as it did; a
  mode a schedule file names that this version does not know is refused, and that
  run does not start. The other way round, an earlier version runs a Full access
  schedule read only, and says nothing: the login item runs the installed copy,
  also while you run a newer one through `npx`, so update that copy with
  `elu update`. It also
  keeps the bots of the form it was made in, and, for a one-time schedule, a
  branch if one was set. A repeating schedule runs in a new worktree each time,
  since a branch is checked out in one place at a time, and a schedule never
  runs `here`. A bot with its own schedule is left out of the runs, so a run
  never starts that bot's schedule. An unanswered approval times out and the
  task asks you.
- A request sent to the local A2A endpoint, which is off by default, runs your
  personal default as it is, Full access included: only a program on this computer
  that holds your own token reaches the endpoint. A session that
  has Full access can itself reach the endpoint, as it can anything on this computer.
- A teammate's message you answer runs read only and never gets a mode. One you
  choose to work on runs with the mode you pick then.
- `elu run` runs read only unless you pass `--permissions auto|full`,
  with `--place here|branch:<name>` and `--folder <path>` (repeatable). `ask`
  needs the terminal app.
- Publishing pushes the session's branch. A `here` session on a default branch
  cannot publish. The publish preview says when the model ran with Full access.

## Linux

Claude Code's shell sandbox on Linux is bubblewrap. It needs `bwrap` and `socat`
on PATH, and `bwrap` must be allowed to make user namespaces. Where the sandbox
does not start, the system fences nothing, so Ask for approval asks you for every
command and Approve for me sends every command to the reviewer.

The Permissions picker and `elu policy show` say which case this machine is: "No
OS sandbox here" when a tool is not installed, "The OS sandbox cannot start here"
when both are installed and `bwrap` cannot start. ELU finds out by starting `bwrap`
around a command that does nothing, with the namespaces Claude Code's sandbox
makes: its own user, network and process namespaces. A `bwrap` run as root, or
installed setuid, can make the others where user namespaces are turned off; the
sandbox still cannot start there, and ELU says so. Where it cannot start, ELU
counts every command as outside the sandbox, so a default that holds only inside
it (Git reads, the project's checks) asks you. The answer is kept for each `bwrap`
program, so it is started once; start ELU again after a fix.

Ubuntu 24.04 stops a program from making user namespaces unless an AppArmor
profile lets it, and has no profile for `bwrap`. This one does, saved as
`/etc/apparmor.d/bwrap`:

    abi <abi/4.0>,
    include <tunables/global>

    profile bwrap /usr/bin/bwrap flags=(unconfined) {
      userns,
      include if exists <local/bwrap>
    }

and loaded once with `sudo apparmor_parser -r /etc/apparmor.d/bwrap`. Nothing is
installed or changed for you.

The check sandbox (`codex sandbox`), which runs every project's checks whatever the
vendor, is bubblewrap on Linux too. The Linux tests run with `bubblewrap` installed
and an AppArmor profile like this one loaded.

## Claude Code

See [vendors/claude.md](vendors/claude.md) for the exact launch per profile.
