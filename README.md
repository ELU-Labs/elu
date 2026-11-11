# ELU Code

A full-screen terminal app that runs coding sessions on the AI command lines you already
use, with bots that review and do work, and teammates you can ask.

![ELU Code on a made-up project, with stand-in vendors](docs/demo.gif)

## Install

From your home folder, not inside a project you do not trust:

```sh
npx -y @elu-labs/elu
```

This opens ELU Code and installs the `elu` command; next time you type `elu`.

You need macOS or Linux, Node 22 or newer, Git, Claude Code signed in, and Codex installed
(no sign-in needed; its sandbox runs your project's checks):
`npm install --global @openai/codex`. Using Antigravity? Read
[its page](docs/vendors/antigravity.md) first. More in [Install details](#install-details).

## Start

```sh
elu
```

The first start asks for a project name; later starts open your last project. Type a
message and press Enter. That starts a session: the model answers, or edits in a new Git
worktree on its own branch. Then the project's checks run and `@reviewer` reviews the
change. Nothing is pushed until you type `/publish` and confirm.

A worktree sits beside its repository, in a folder named after it with `.elu-code` added
(`shop.elu-code` beside `shop`). When a Task edits the project folder itself and the folder
has no commits yet, ELU Code first commits its files there as `Start project history`,
running `git init` if it needs to, and pushes nothing. A file that looks like a secret, such
as `.env`, stops it until `.gitignore` keeps that file out.

| Tab | What it shows |
| --- | --- |
| Sessions | Every session across your projects. The selected one is open beside the list. |
| Projects | Your projects. `n` makes one, `o` makes another the active one. |
| Kanban | The open project's tasks: To do, In progress, Needs you, Done. In a project shared with a team, the Tasks teammates' sessions are working on show under them, by teammate, to read only. |
| Chats | Your team's channels, your teammates and your bots. |
| Bots | Your bots. `n` makes one, Enter opens one. |
| Usage | Your vendor accounts and their plan usage. |

Click a tab's name. Or press Tab until the tab row is selected, choose with ← and →, and
press Enter.

## Tasks

Ask for a change to code or files, or for work that needs planning, and the first reply is
a Task: a title, a description, the goal, the objectives that say when it is done, a
priority and a severity. Nothing is edited yet.

| Do | What happens |
| --- | --- |
| Esc, then `y` | Approves the Task. The work starts by itself. |
| Esc, then `n` | Rejects it. Nothing is changed. |
| Type a message | Changes the Task. The card shows the new revision. |

Typing `yes` and Enter approves too. A question gets a plain answer and no Task. A follow-up
inside an approved Task's goal starts at once; a new piece of work gets a Task of its own.
An approved Task gives its session its name, unless you named the session yourself.

On the Kanban tab a session with a Task shows as that Task: its title, how far it is, its
priority and its severity. One that waits for your approval is under Needs you. Enter opens
its session.

After you approve, the model splits the work into subtasks and changes them as it likes.
The card lists them as a checklist and marks the objectives the model reports met. The
Task is done when every objective is reported met and the turn, with its checks and
review, has ended. A new message opens it again.

ELU Code starts the edit only for a Task you approved. What the model can still do in its
first turn depends on the vendor and the mode:
[docs/permissions.md](docs/permissions.md#plan-first).

## Commands

Type these in the message box. `/` alone lists every command, and `/help` explains the keys.

You can send a message at any time. One sent while the session is working waits in the chat and is sent by itself when that turn ends; several go together, in order. `↑` in the empty message box takes the newest one back so you can change it.

| Type | What it does |
| --- | --- |
| `/new` | Starts a new session |
| `/model sonnet` | Chooses the model of this session; `/model` alone lists them |
| `/permissions auto` | Sets what the model may do: `ask`, `auto` or `full` |
| `/place branch try-coupons` | Sets where a new session runs: `worktree`, `branch NAME` or `here` |
| `/bots add qa` | Keeps a bot in this session; `/bots remove qa` takes it out |
| `/agent add fable` | Adds another model to this session as an agent; write `@fable` and what to do. Words after the model say what it is for, and `--name NAME` names it: `/agent add sonnet you review my SQL --name sql` |
| `@pair is there a simpler way?` | Asks a bot. Your next messages in that session go to it too |
| `@model and what do you think?` | Writes to the session's model again |
| `/changes` | Shows what this session changed; `/chat` goes back |
| `/publish` | Shows the exact push and draft pull request, then asks you |
| `/stop` | Stops the running response. A message you sent while it ran is sent next; `/stop` again cancels that message |
| `/schedule` | Starts a session later or on a schedule, such as `daily 9:00` or `every 2h` |
| `/budget 5` | Limits this session to 5 dollars; `/budget off` removes the limit |
| `! git status` | Runs a shell command. In an open session the model gets the command and its output with your next message |
| `/quit` | Closes ELU Code. Sessions that are running or queued go on in the background; `elu conductor stop` stops them |

A schedule also runs while ELU Code is closed, through a login item, once ELU Code is
installed (not run through `npx`). On macOS, while an agent works or a schedule is on, ELU
Code stops the Mac from going to sleep on its own (`caffeinate -i`); the display can still
sleep. Schedules show in the Sessions tab under Scheduled: `p` pauses one and `x` deletes
it.

## Permissions

Each session runs in one of three modes. `/permissions ask`, `auto` or `full` changes it,
and `/permissions default auto` sets what new sessions start with.

- **Ask for approval** (`ask`, the default): asks before outside edits, escapes, and internet.
  Codex cannot ask you during a turn, so there these are refused and reported.
- **Approve for me** (`auto`): a reviewer model, not you, decides on escapes and internet.
  On Grok Build, what its reviewer refuses then asks you.
- **Full access** (`full`): any file, any command, the internet.

When the model asks, `y` allows and `n` denies; `f` allows and gives that session Full access.
You can change the mode while a turn runs.

Bots that review, and a teammate's question, always run read only.
`/permissions folders add <path>` lets the model read one more folder of your home this
session.

On Claude Code, your own MCP servers (`claude mcp list`) are on for the model and for bots
that work, and their tools run without asking in every mode. Neither the sandbox nor the
never list below covers them, so a server can reach the internet and act on other services.
`/mcp off NAME` turns one off for the project. A teammate's question never gets them.

ELU Code does not push, merge, tag, deploy or publish by itself. `/publish` shows the exact
push and the draft pull request, waits for you, and refuses a default branch. The model is
told never to run those commands, and on Claude Code they are denied by rule; in Full access
that is a rule on the command's text, not a sandbox. Stand-in commands, first on every
session's PATH, also refuse them by name, inside a script too; a full path to the real
command gets past those. One exception: a bot that is allowed
to merge pull requests may run `gh pr merge`. Ask for approval still asks you first; in
Approve for me the reviewer model decides. `@elu` comes allowed; a bot you make is not.
Details:
[docs/permissions.md](docs/permissions.md), [SECURITY.md](SECURITY.md).

## Bots

A bot is a model with a name and instructions. You write it once and use it in any session.
In a session a bot reviews each change, answers when you write `@name`, or does work of its
own.

Five come with the app. You can edit or remove any of them in the Bots tab.

| Bot | Runs on | What it does |
| --- | --- | --- |
| `@reviewer` | Claude, Opus | Reviews every change for correctness, security, performance and maintainability |
| `@lead` | Claude, Fable, with Opus helpers | When you write to it: plans the work, hands the pieces to helpers, and checks what they return |
| `@qa` | Claude, Opus | When you write to it: tests the change like a user, fixes what it finds, and verifies each fix |
| `@pair` | Codex, `gpt-6.1-sol`, high effort | A second model beside the working agent: says what it would challenge after each turn, and reviews each change |
| `@elu` | Claude, every hour | Finds issues in your live product with [ELU](https://elu.dev), then reviews and merges the fix pull request or writes the fix |

- A new session starts with `@reviewer`. `/bots add qa` adds another bot, and so does `@qa`
  alone and then Enter.
- `@lead plan the refund change` gives a bot work. `@lead`, `@qa`, `@elu` and each bot you
  make do the work you write to them, within the session's permissions; `@reviewer` and
  `@pair` read and answer.
- After you write to a bot, your next messages in that session go to it too, until you name
  another bot or start a message with `@model`. The title of the message box names who gets
  the message. A bot you stop picks up where it stopped on your next message when it runs on
  Claude Code or Grok Build; on the others its next turn starts from the chat. When it
  cannot pick up, a line in the chat says so and the turn starts from the chat.
- To make a bot, open the Bots tab, press `n` and answer its questions. Enter on a bot
  opens its page, where each row changes one thing: its model, its schedule, its MCP
  servers, its instructions. How a bot goes about its work is in its instructions: write
  there that it hands pieces to helpers, and on Claude Code it can start them.
- Each bot has a color: its name and its replies show in it. **Color** on its page changes
  it, and so does `/bots color qa gold`. `/bots color qa random` picks another.
- `@elu` starts when it joins a session and then runs there every hour. Once ELU Code is
  installed, it runs while ELU Code is closed too, through the login item that runs
  schedules. `/bots schedule off elu` stops that in one session. It needs ELU connected:
  `npx -y @elu-labs/cli --offer=promo` signs you up, or in, adds ELU to your web app and
  connects your AI tools.

## Teammates

Your computer can ask a teammate's, and theirs can ask yours. There is no ELU server:
the two connect directly over Hyperswarm.

```sh
# on your computer
elu id --name sam        # once: your name on the team
elu team create shop
elu peer on
elu invite               # prints a code like k7qm-x2pd-9fhw; it works once, within 24 hours

# on your teammate's computer, in the project you may ask about
elu id --name kim
elu peer on
elu join CODE
```

`elu peers` shows who is online. In the app, write to a teammate in the Chats tab, or
type `@kim where are the tax rates?` in any session. A teammate's question is answered
read only, from a project you shared. `elu share`, or `/share` in the app, shares the
project you are in. Adding a teammate shares one too: `elu invite` and `elu join` share
the folder you run them in when it is an ELU Code project (`--project PATH` names
another), and `/invite` and `/join` share the open project. The wire format is in
[docs/peer-network.md](docs/peer-network.md).

Teammates on a team a project is shared with also see the work in it: for each live
editing task, the first line of its request and the paths of the files it changed, and the
approved Tasks its sessions work on. `elu share --no-status`, in the project, turns that
off. [SECURITY.md](SECURITY.md#what-teammates-are-told) says exactly what is sent.

A message you type can carry pictures. Drag a screenshot into the message box, or write
its path, and it goes with the message: up to 4 pictures, 8 MB each. Your teammate's model
sees them when it answers.

In a channel, `/invite @kim` adds a teammate you already have. `/invite` alone makes a
code for someone new; the first time, it also makes your team, named after the open project.

## Install details

Sessions run in the vendors' own unmodified command lines (Claude Code, Codex, Antigravity
and Grok Build), with your existing sign-in. ELU Code has no account and no telemetry, and
it never reads your Claude Code sign-in. The Usage tab shows Claude plan usage from what
Claude Code reports during your sessions. For Codex plan usage, ELU Code starts Codex's own
`app-server`, which asks with your Codex sign-in, whenever `codex` is installed: when you
open a project that is set up or send a message, at most once a minute while a session is
on screen, and from the Usage tab ([what is read and when](SECURITY.md#credentials)).

You need macOS or Linux, Node 22 or newer, Git, and Claude Code (`claude`) installed and
signed in: new projects and the built-in bots run on it. To run sessions on Codex
(`codex`), sign in to it and choose it with `/model`.

Codex must be installed even if your sessions run on Claude Code, but it does not need to
be signed in. ELU Code runs your project's checks and its pre-push hooks inside Codex's
sandbox (`codex sandbox`); without it the checks fail and `/publish` refuses. Install it
with `npm install --global @openai/codex`. To use a copy that is not on your PATH, set
`ELU_CODE_SANDBOX_HELPER` to its absolute path. On Linux that sandbox is bubblewrap:
install `bubblewrap` and, on Ubuntu 24.04, load the AppArmor profile in
[docs/permissions.md](docs/permissions.md#linux). The Linux tests run with both.

GitHub CLI (`gh`) is needed for draft pull requests, and for `@elu` to review and merge a
fix pull request.

The first run of `npx -y @elu-labs/elu` opens ELU Code and installs `elu` as a global
command: it prints the `npm install --global` line it runs, and uses `~/.local` when npm's
global folder cannot be written. To open ELU Code without installing anything, run
`ELU_NO_INSTALL=1 npx -y @elu-labs/elu`.

Run `npx -y @elu-labs/elu` from your home folder, not from inside a project you do not
trust: `npx` lets the folder it starts in decide what runs.

The Usage tab lists the vendor command lines ELU Code found and whether each is signed in.
Antigravity (`agy`) and Grok Build (`grok`) are checked once on each machine: your first
message to one starts the check by itself. It takes about seven short turns on that vendor
and a few minutes. Vendor notes: [docs/vendors](docs/vendors).

Google's FAQ says that using another app to reach Antigravity breaks its terms and can get
your account suspended or terminated. ELU Code wraps `agy`, so read
[docs/vendors/antigravity.md](docs/vendors/antigravity.md) before you send it a message.

## Update and remove

```sh
npx -y @elu-labs/elu@latest
```

That installs the newest version where `elu` already is, and opens it. If peer mode is on,
restart it so it runs the new version: `elu peer off`, wait until `elu peer status` says
the daemon is stopped, then `elu peer on`.

To remove ELU Code, first delete your schedules in the app (Sessions tab, under Scheduled:
`x` on each one), so they no longer keep the Mac awake, and quit it with `/quit`.

Then remove the login item that runs schedules, and bots with a schedule such as `@elu`,
while ELU Code is closed, if there is one. On macOS, run
`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.elu-code.scheduler.plist`
and delete that file. On Linux, run `systemctl --user disable --now elu-code-scheduler.timer`
and delete `elu-code-scheduler.service` and `elu-code-scheduler.timer` in
`~/.config/systemd/user`.

Stop what still runs in the background:

```sh
elu peer off                # if peer mode is on
elu peer uninstall          # if you made the peer daemon start at login
elu conductor stop          # stops sessions that are still running
```

In each project folder that is a Git repository, see what ELU Code would remove there,
then remove it:

```sh
elu uninstall --dry-run
elu uninstall               # asks before it removes anything
```

That removes the project's run history in `.git/elu-code`, which can hold secrets a command
printed; its task worktrees, and their folder once it is empty; and what `elu init` or
`/setup` wrote: `.elu-code/config.yaml` and the marked part of `AGENTS.md` and `CLAUDE.md`.
It keeps the task branches. It stops at a worktree with changes you have not committed,
and at a worktree of another repository: remove those first, as below.

Last:

```sh
npm uninstall --global @elu-labs/elu
```

If `elu` is in `~/.local/bin`, add `--prefix "$HOME/.local"` to that line.

These stay, for you to delete:

- `~/.config/elu-code`: your bots, your projects, your peer identity, and the sessions of a
  project whose folder is not a Git repository.
- `~/.local/share/elu-code`: the stand-in commands that refuse the never list.
- `~/.cache/elu`: an empty folder that held Claude Code's temporary files.
- `.elu-code/project.json` in each project folder, with the project's name, and any
  setting saved beside it that `elu uninstall` did not list.
- Task worktrees in a repository that is not itself the project folder, which a session
  edited. They sit beside that repository, in `shop.elu-code` for `shop`. In the
  repository, `git worktree list` shows them and `git worktree remove PATH` removes one;
  then delete the folder.
- Task branches, whose names start with `feat/task-`: `git branch -D NAME` in their
  repository.

## Help and contributing

- A question or a bug: [open an issue](https://github.com/ELU-Labs/elu/issues).
- A security problem: report it privately, as [SECURITY.md](SECURITY.md) says.
- A change to the code: [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits and license

MIT licensed. Sponsored by [ELU](https://elu.dev).

`@reviewer` is adapted from the code-review skill in Anthropic's knowledge-work-plugins
(Apache-2.0), and `@qa` from the qa skill in gstack by Garry Tan (MIT). The examples in
`test/fixtures/a2a/` come from the A2A specification (Apache-2.0). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
