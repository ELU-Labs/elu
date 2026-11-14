# ELU

A full-screen terminal app that runs coding sessions on the AI command lines you already
use, with bots that review and do work, and teammates you can ask.

![ELU on a made-up project, with stand-in vendors](docs/demo.gif)

## Install

From your home folder, not inside a project you do not trust:

```sh
npx -y @elu-labs/elu
```

This opens ELU and installs the `elu` command; next time you type `elu`. To install
a given version, name it: `npx -y @elu-labs/elu@0.1.12`.

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

What installing, building and testing leave in the worktree is not a change when Git ignores
the folder itself: `node_modules`, `vendor`, `.venv`, `venv`, `__pycache__`, `*.egg-info`,
`.eggs`, `.next`, `dist`, `build`, `coverage`, `htmlcov`, `.pytest_cache`, `.hypothesis`,
`.turbo`, `.cache`, `target` and the like, and an ignored `.coverage` file. Nothing in those
folders is read, so a link or a large file there never stops a session, and none of it is
published. A folder of one of those names that Git does not ignore, such as a tracked
`src/build`, is an ordinary folder. Any other ignored file the model writes fails the
`no-ignored-output` check, and one that looks like a secret, such as `.env` or
`src/build/.env`, fails `secret-paths`; a link among them is never followed.

A worktree sits beside its repository, in a folder named after it with `.elu-code` added
(`shop.elu-code` beside `shop`). When a Task edits the project folder itself and the folder
has no commits yet, ELU first commits its files there as `Start project history`,
running `git init` if it needs to, and pushes nothing. A file that looks like a secret, such
as `.env`, stops it until `.gitignore` keeps that file out.

| Tab | What it shows |
| --- | --- |
| Sessions | Every session across your projects. The selected one is open beside the list. Typing on a row writes a message to it; a row's key is its letter, then Enter. |
| Projects | Your projects. `n` makes one, `o` makes another the active one. A project a teammate shares that is not on this computer is listed too, as `ELU   shared by @rio   on @rio-mac`: Enter opens its team board, and `c` clones it here. |
| Kanban | The open project's tasks and sessions: To do, In progress, Needs you, Done. On a team, everyone with a clone of the same repository shares one board: every session a teammate, or another computer of yours, runs in it shows in the same columns with who started it and on which machine, to read only. A project whose folder holds several repositories has a board for each. `/share off` keeps a project off it both ways. |
| Chats | Your team's channels, your teammates and your bots. |
| Bots | Your bots. `n` makes one, Enter opens one. |
| Usage | Your vendor accounts and their plan usage, then your top 10 agents by cost with their tokens. `t` switches between today and the last 7 days. |

Click a tab's name. Or press Tab until the tab row is selected, choose with ← and →, and
press Enter.

## Tasks

Ask for a change to code or files, or for work that needs planning, and the first reply is
a Task: a title, a description, the goal, the objectives that say when it is done, a
priority, a severity, the success criteria that show it is done, and the model's estimate
of the work.

With Full access or Approve for me the mode approves the Task: the card says so, nothing
waits for you, and the work goes on in the same message. A schedule's run in one of these
modes works the same way, and so does a session a teammate's message starts as yours. With Ask for approval or Read
only nothing is edited yet, and the Task waits for you:

| Do | What happens |
| --- | --- |
| `y`, then Enter | Approves the Task. The work starts by itself. |
| `n`, then Enter | Rejects it. Nothing is changed. |
| Type a message | Changes the Task. The card shows the new revision. |

An approval you type counts too, in your own words: `yes`, `I approve`, `go ahead`,
`sounds good, do it`.
A question gets a plain answer and no Task. A follow-up
inside an approved Task's goal starts at once; a new piece of work gets a Task of its own.
An approved Task gives its session its name, unless you named the session yourself.

On the Kanban tab a session with a Task shows as that Task: its title, how far it is, its
priority and its severity. One that waits for your approval is under Needs you. Enter opens
the whole Task, as does a click: the goal, the objectives, the success criteria, the subtasks
and the ETA. Its Go to session button opens its session; Enter presses it. A teammate's card,
and one of your other computer's, open the same way.

After approval, the model splits the work into subtasks and changes them as it likes.
The card lists them as a checklist that follows the model's own to-do list while the turn
runs, and marks the objectives the model reports met. Its ETA
is approval plus the estimate, and follows the minutes left the model reports as it works. The
Task is done when every objective is reported met and the turn, with its checks and
review, has ended. A new message opens it again, and `continue` takes the next piece of
its goal.

A step that fails is the agent's to fix: it finds the cause and goes on. It asks you only
when it cannot go on at all, or when the choice is truly yours. When the work is done it
says what it did and ends.

ELU starts the edit only for an approved Task. What the model can still do in its
first turn depends on the vendor and the mode:
[docs/permissions.md](docs/permissions.md#plan-first).

## Commands

Type these in the message box. `/` alone lists every command, and `/help` explains the keys.

You can send a message at any time, and a working session answers it right away. On Claude Code and on Codex, one sent while the session is working goes to that turn: the model reads it at its next step, the chat then says "Sent to the running turn." under it, and the reply answers it too. Behind a long command the turn reads it when that command ends, the chat says so, and Enter in the empty message box sends it now: Claude Code moves the command to the background and the same turn reads your message; Codex stops the command and goes on with your message at once. Where a turn takes no message while it works (Grok Build, Antigravity, a Codex or Claude Code that cannot, and while the project's checks run), the message is answered at once beside the turn: a short read-only run on the session's own model reads the chat and what the turn has done so far, and its answer shows in the chat within seconds, under the working line and the turn's steps, marked "Answered beside the running turn, from what it has done so far. The turn goes on." A question is done with that answer, and the session reads both at its next turn. A message that asks for work is answered the same way, says that it asks for work, and starts the next turn when this one ends; Enter in the empty message box sends it now by stopping the turn and the command that is running, its changes kept: your message starts the next turn, in the same vendor session where it can go on, and where it cannot, with what the stopped turn had said and done. The chat never says only that a message waits: each one says what happens to it and when, and the status line says the same when you send it. `↑` in the empty message box takes the newest one back so you can change it. The same holds for a session on your other computer, where that computer answers, with no window open there; if it runs an older ELU, the chat says that the message starts when its turn ends and that nothing answers it before, and still offers Enter where that computer can send it now. It holds for a message to a bot while that bot works too.

A chat reads in time order, here and for a session on your other computer. What you sent that has not been read yet is the last thing in it, right above the message box, with nothing under it; the working turn's steps are right above that. A session's Task sits after the reply that proposed it.

While the model or a bot works, the chat shows what it does as it happens: each thought, each tool call (● running, ✓ done, ✗ failed), its plan, and what it writes on the way. A thought that comes without its text shows how many tokens it has taken so far, such as `✻ thinking · 1.2k tokens`. A call says how long it has run, second by second, such as `● Run: npm test · 2m 10s`, and keeps its total when it ends. Commands the turn left running in the background are one line, such as `● 1 background command: npm run watch · 4m 0s`. When the turn ends they fold into one line above its reply, such as `▸ 12 steps in 1m 12s`. A turn you stop with `/stop` keeps its steps, and its line says `stopped`. `ctrl+o` opens or folds the steps of every turn, in the message box too; a click on that line opens or folds that turn's. A session on your other computer shows the same. A program that prints only when it ends has no steps to show: the chat then counts the time under the working line, such as `1m 12s so far. Antigravity reports only when it ends.` Antigravity shows its steps in every permission mode where its one-time check proved `agy acp` on this machine, and runs that way otherwise ([docs/vendors/antigravity.md](docs/vendors/antigravity.md)).

| Type | What it does |
| --- | --- |
| `/new` | Starts a new session |
| `/model sonnet` | Chooses the model of this session; `/model` alone lists them. The name can be the one the app shows, and a message after it is sent on that model: `/model opus 5.5 fix the build`. Over a session on your other computer it changes that session's model there |
| `/permissions auto` | Sets what the model may do: `ask`, `auto` or `full` |
| `/place branch try-coupons` | Sets where a new session runs: `worktree`, `branch NAME` or `here` |
| `/bots add qa` | Keeps a bot in this session; `/bots remove qa` takes it out |
| `/agent add fable` | Adds another model to this session as an agent; write `@fable` and what to do. Words after the model say what it is for, and `--name NAME` names it: `/agent add sonnet you review my SQL --name sql` |
| `@pair is there a simpler way?` | Asks a bot. Your next messages in that session go to it too |
| `@model and what do you think?` | Writes to the session's model again |
| `/changes` | Shows what this session changed; `/chat` goes back. The name of its Changes tab counts them (`Chat   Changes 7`) before you open it: a session of this computer counts again when a turn ends or its state changes, and one on your other computer shows its changes the same way, whole. In a session of this computer, `+` on a line (or a click on its `+`) notes what should change, and `s` sends the notes to the model together |
| `/publish` | Shows the exact push and draft pull request, then asks you |
| `/stop` | Stops the running response. Messages you sent while it ran then go at once, in order; `↑` takes one back first. Over a session on your other computer, it stops that session there. While a session of this computer works, the key bar under the message box names it (`/stop stop`) |
| Enter (empty box) | While a turn works and a message of yours waits, sends that message now. On Claude Code the command the turn waits on moves to the background and the same turn reads the message. On the other vendors the turn stops as `/stop` stops it and the message starts the next turn, in the same vendor session where it can go on |
| `/schedule in 1h check the build` | Starts a session later or on a schedule: `/schedule [when] [message]`. `/schedule ` lists times such as `in 5m`, `in 1h` and `daily 9:00`. Each run is a new session with the model, mode and bots of the form (a bot with its own schedule is left out); it does not see the chat it was made in. Each run is named with the schedule's message, or with the name you gave its last run, and it archives the schedule's earlier runs, so Sessions lists one run of each schedule; `/archived` shows the others. A run that still works or needs you stays until a later run finds it done. A schedule gets Full access only when you pick it for that schedule, and the form asks you once before saving it |
| `/budget 5` | Limits this session to 5 dollars; `/budget off` removes the limit |
| `/slots 12` | Limits how many sessions run at once, in one project as in several, to any whole number from 1. Until you set a limit there is none and no session waits for a slot; `/slots off` removes it, and `/slots` alone says which it is. What you type always starts; this number limits what starts by itself. A new session you start, a message you send, here or from your other computer, a Task you approve, a teammate's message you accept with y or w and a schedule or bot you run now start whatever runs. A scheduled run that comes due, a bot's scheduled turn, a teammate's message that Auto starts, a retry after a failure and a message one session sends another wait under Queued past the limit, and the chat says what each waits for, such as "Waiting for a free slot: 13 sessions are running, and 12 run at once. /slots changes it."; it starts when a slot frees. Running work is not interrupted |
| `/standup` | Asks every open session of yours, here and on your other computers, and your teammates' shared ones, for an update, in a new Standup session. See [Standup](#standup) |
| `@everyone did anyone touch auth?` | In a Standup session, asks the sessions of its last round again, with your question; `@everyone standup` asks for an update. Elsewhere it starts a Standup with the question |
| `! git status` | Runs a shell command. In an open session the model gets the command and its output with your next message |
| `/update` | Says how to update: `/quit`, then `elu update` |
| `/takeover` | In a view-only window, moves the project to this window. The other window turns view only |
| `/quit` | Closes ELU. Sessions that are running or queued go on in the background; `elu conductor stop` stops them |

One ELU window at a time makes changes in a project. A second window on the same project
opens view only: it shows everything and `/stop` works there, but it sends nothing. It takes
the project by itself within seconds once the other window closes, and `/takeover` moves it
at once.

A schedule also runs while ELU is closed, through a login item, once ELU is
installed (not run through `npx`). The login item is there only while a schedule is on, a
task's or a bot's: ELU removes it with the last one, also while ELU is closed, and puts it back with the next. On Linux it is
a systemd user timer, which runs while you are logged in; `loginctl enable-linger` keeps it
running after you log out. On macOS, while an agent works or a schedule is on, ELU
stops the Mac from going to sleep on its own (`caffeinate -i`); the display can still
sleep. Schedules show in the Sessions tab under Scheduled: `p` pauses one and `x` deletes
it, each followed by Enter. A new run archives the schedule's earlier ones, as `c` would, so
its row stays one; `u` or a new message brings one back. A time is `in 30m`, `every 2h` (15 minutes to 7 days),
`daily 9:00`, `weekdays 9am`,
`mon,thu 14:30`, `tomorrow 15:00` or `2026-12-01 9:00`, in this computer's local time.
Asked to repeat work, the model makes the schedule with `elu schedules add` where it has
[ELU's own commands](#elu-from-a-session), and otherwise gives you the `/schedule` line to type.

### ELU from a session

`elu sessions` and `elu schedules` change ELU from your shell and from inside a session, so a
message or a schedule such as "archive this chat and start a new session that says hello" just
works. The app shows each change at once.

- `elu sessions [--all]` lists this project's sessions: number, name, state, the schedule that
  started it, and whether it is archived. `elu sessions archive N|this`, `unarchive N`,
  `rename N|this "name"` and `new "message" [--mode ask|auto|full]` change them. `this` is the
  session the command runs in: it is archived when its turn ends, after its reply.
  `elu sessions delete N|archived [--learn]` deletes an archived session for good, or every
  archived one; `--learn` first saves what you taught in them to the project context. Work
  on no remote stays in its folder and on its branch.
- `elu schedules [--all]` lists the schedules, and `elu schedules add <when> <message>` (the
  words `/schedule` takes), `pause N`, `resume N`, `delete N` and `run N` change them.

A session started from a session gets that session's mode, or a lower one with `--mode`. In
Ask for approval you are asked before one runs; Approve for me and Full access run them. Every
vendor's session has them, in every mode. Inside a sandbox the command hands itself to ELU,
which runs it only for that session and no higher than its mode. A teammate's question or
review is never told about them and cannot run them.

## Keys

The last row of the screen names the keys for whatever has the focus.

| Key | What it does |
| --- | --- |
| Tab | Moves between the tabs, the list, the message box and the chat |
| Enter | Sends the message, or opens the selected row |
| Esc | Leaves the message box for the list, and the list for the message box; closes a dialog |
| ↑ ↓ | Move in a list; scroll the chat when it has the focus |
| PgUp PgDn | Move a page: in a session's chat or its changes and in the threads of a chat in Chats, from the message box too; in the Sessions list; in the text of a dialog, such as a teammate's thread or `/help` |

## Permissions

Each session runs in one of three modes. `/permissions ask`, `auto` or `full` changes it,
and `/permissions default auto` sets what new sessions start with.

- **Ask for approval** (`ask`, the default): edits the session's files and asks you before
  anything else, the internet included.
  Codex cannot ask you during a turn, so there these are refused and reported.
- **Approve for me** (`auto`): edits the session's files; a reviewer model, not you, decides
  the rest. Commands get no internet unless the reviewer lets one leave the sandbox.
  On Grok Build, what its reviewer refuses then asks you.
- **Full access** (`full`): any file, any command, the internet, with no sandbox. That
  includes push, tags, merges, publishing and deploys: the never list below does not apply.
  Nothing of ELU's limits it: every tool the vendor has, your secret files and sign-ins,
  your whole environment. [What stays, and why](docs/permissions.md#full-access).

When the model asks, `y` allows and `n` denies; `f` allows and gives that session Full access.
On the session's row or in its chat each is the letter, then Enter, so a message that starts
with one of them is only a message.
`a` allows and keeps a narrow rule, such as `npm test` or `git diff`, for this project or all
of them, so it is not asked again. Reads in the project, git reads and the project's own test,
lint and build scripts run without asking from the start. `/permissions rules` or
`elu permissions` lists them all and removes any. No rule covers the never list.
You can change the mode while a turn runs. When a turn stopped on something a wider mode
allows, its Blocked line says which, and raising the mode continues the turn at once, with
only what that mode allows. A turn that also stopped on your no, or on the never list, waits
for your reply.
A new approval rings the terminal bell once.

Bots that review, and a teammate's question, always run read only.
`/permissions folders add <path>` lets the model read one more folder of your home this
session; in Full access, any folder there is.

On Claude Code, your own MCP servers (`claude mcp list`) are on for the model and for bots
that work, and their tools run without asking in every mode. Neither the sandbox nor the
never list below covers them, so a server can reach the internet and act on other services.
`/mcp off NAME` turns one off for the project. A teammate's question never gets them.

`/mcp add` adds a server: it asks for a name, the URL (or the command that starts it), the
header that carries its key, such as `Authorization`, and then the key, in a field that
shows only dots. Claude Code saves it for every folder (`claude mcp add-json --scope user`),
and sessions get it from their next turn. `/mcp remove NAME` removes one after asking. From
a shell, `elu mcp add NAME URL --header Authorization` asks for the key with echo off, or
reads it from standard input; a command goes after `--`, as in
`elu mcp add github --env GITHUB_TOKEN -- docker run -i --rm ghcr.io/github/github-mcp-server`.
`elu mcp remove NAME` removes one. If you paste a server config, such as an `mcpServers`
block, or a `claude mcp add` line (with `!` or without) into the message box, ELU does
not send or run it: it offers to add the server, so the key stays out of the chat. The model
is told to ask you to type `/mcp add` when it needs a server you do not have, and adding or
removing one is on the never list, outside Full access.

ELU does not push, merge, tag, deploy or publish by itself. `/publish` shows the exact
push and the draft pull request, waits for you, and refuses a default branch. Outside Full
access the model is told never to run those commands, and on Claude Code they are denied by
rule. Stand-in commands, first on the PATH of every session in Ask for approval or Approve
for me, also refuse them by name, inside a script too; a full path to the real command gets
past those. One exception: a bot that is allowed to merge pull requests may run
`gh pr merge`. Ask for approval still asks you first; in Approve for me the reviewer model
decides. `@elu` comes allowed; a bot you make is not. In Full access none of this applies:
the model, and a bot working in that session, may push, open and merge pull requests, tag,
publish and deploy when the task calls for it.
Details:
[docs/permissions.md](docs/permissions.md), [SECURITY.md](SECURITY.md).

When the model commits its own work in the session's workspace, that commit is the
session's work. The checks and the review run on it, `/changes` shows it against the
session's base, and the session ends as any other does. With all of its work committed it
is listed as `committed`, here and on your other computers, and its chat says where the
work is: the branch, the commit, and whether it is pushed. `/publish` then pushes what is
there, on the branch it is on; when that branch is on GitHub already with a pull request
for the same commit, it names the pull request and pushes nothing. A commit made in the
session's workspace while nothing ran, such as one you made by hand, is named in the chat
and the session goes on from it: your next message, the checks and `/publish` all do.

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
- After each edit, ELU runs the checks and every reviewing bot of the session reviews
  the change. Its must-fix findings go to the model, which fixes each one or disputes it with
  a reason; then the checks and the review run again, up to the policy's review rounds. The
  chat shows each step, such as `@reviewer: 2 must-fix`, `Fixed 2` and `@reviewer: Passed.`
  The model is told which bots review its change and that ELU runs the checks and
  publishing, so it never asks you to wait for a bot, review, commit, push or merge.
- Write to a reviewing bot about edits the session has not published, such as `@reviewer make
  sure the fixes are real, not nitpicks`, and it reviews them with your words, in that same
  loop. That holds when the session's own editing turn finished, it changed files and stopped
  after that (ready, blocked, not verified or waiting for you), and the bot is one of its
  reviewers. Edits you had in your checkout before the session started are not its own. The
  fixes are work on the session's approved Task: a Task that was done opens again for them
  and closes again when the review passes. The bot's must-fix findings stay within that Task;
  new work is at most a suggestion, and you ask the agent for it. A message that starts with
  `?`, or ends with `?` and asks for no work (fix, check, review, verify, work with or on, go
  through, look at, make sure), is a question: the bot answers it in the chat.
- After you write to a bot, your next messages in that session go to it too, until you name
  another bot or start a message with `@model`. The title of the message box names who gets
  the message. A bot you stop picks up where it stopped on your next message when it runs on
  Claude Code or Grok Build; on the others its next turn starts from the chat. When it
  cannot pick up, a line in the chat says so and the turn starts from the chat.
- To make a bot, open the Bots tab, press `n` and answer its questions. Enter on a bot
  opens its page, where each row changes one thing: its model, its schedule, its MCP
  servers, its instructions. How a bot goes about its work is in its instructions: write
  there that it hands pieces to helpers, and on Claude Code it can start them.
- A bot whose model your Claude account has no usage credits for runs once more on the
  session's model, when that is another Claude model, and the chat says so in one line. Its later turns in that session start
  there.
- Each bot has a color: its name and its replies show in it. **Color** on its page changes
  it, and so does `/bots color qa gold`. `/bots color qa random` picks another.
- `@elu` starts when it joins a session and then runs there every hour. Once ELU is
  installed, it runs while ELU is closed too, through the login item that runs
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
elu invite               # prints a code like k7qm-x2pd-9fhw; it works once, within 24 hours

# on your teammate's computer, in their copy of the project
elu id --name kim
elu join CODE            # joins their team; your messages start sessions here
```

A join finds the person who invited you only while their ELU is open and online. While it
looks, it counts the seconds and says so; Esc (Ctrl-C in the shell) cancels it. If nobody
answers within a minute it says why and what to do, and if your own computer is not
connected it says that at once.

Some networks will not connect two computers directly: a phone hotspot is one. A join that
found their computer says so, keeps trying for three minutes, and goes through another
computer that both can reach when one is on: another computer or teammate of yours, or a
teammate of theirs, with ELU open. That computer passes along bytes it cannot read. If
there is no way through, the join says why and what works.

The same holds once you are on a team. Two teammates whose networks will not connect
directly reach each other through any computer on the team that reaches both, with nothing
to set up. `elu peers` and the Team list then say `online · through kim's computer`. They
go back to a direct connection when one works, and move to another computer when that one
closes. With no computer that reaches both, the row says so instead of a bare `offline`.

There is nothing to turn on. Once your computer is on a team, a background process (the
peer daemon) keeps it reachable by your teammates, also while ELU is closed. Until you
invite someone or join a team, nothing starts and nothing connects. There is no off switch
while you stay on a team: `/leave` (or `elu team leave`) takes you off one, and once you are
on no team the daemon stops. If no teammate was online to hear that you left, it keeps
running until one of them connects and is told. The person who made a team cannot leave it.
An admin removes a teammate with `/remove @kim` (or `elu team remove kim`). Leaving, or being
removed, also forgets what that team's messages could do on your machine. A new invite
brings you back and sets it again: `/join` asks, and `elu join` saves its flags, Auto with
no rules when there are none.

`elu peers` shows who is online. In the app, write to a teammate in the Chats tab, or
type `@kim where are the tax rates?` in any session. A message always reaches them, and
they can reply in the same thread.

Two more choices are yours for each teammate, in Chats with their row selected or their
messages open. `h` holds your replies and results to them: each one waits in their thread
until you press `y` to send it, `e` to edit its text first, or `n` to drop it. One that may
hold a secret always waits, and is sent only after you take the secret out. `o` turns on
auto-continue: their answer, or the result of work they approved, continues the session you
asked from. Its thread stays in Chats for a week, marked "continued in your session"; `n`
dismisses it sooner. The line over their thread says which of the two are on.

What a teammate's message does on your machine is yours to choose, once per team: `/join`
asks, and so does your first `/invite` for a team. **Auto** (the default for a new team)
starts a session in your project as if you had typed the message yourself: it runs in the
project folder, reads your home folder (not the secret folders) and uses your MCP servers,
in your default permission mode, Full access included, and its answer goes back without you
reading it unless it looks like a secret. Its Task is approved as one you type would be: in
Approve for me and Full access the mode approves it and the work goes on, and in Ask for
approval it waits for you. Only an approved Task's edit runs in a new worktree. **Manual** keeps each message waiting
until you press y, and its sender reads that it waits for you. Your y (or w) starts it at
once, whatever runs, as anything you type does; one that Auto starts waits for a free slot. You can also write rules in plain English, such as "Only work on the elu
repo. Don't write anything until I accept it.", and every session a teammate starts is told
them. A teammate's message never runs in your home folder on its own: ELU asks you
first, and runs it there only when you press y. Their session shows their own words under their name. Push, merge, tag, deploy and publish stay blocked as they are for your own sessions in
that mode. [SECURITY.md](SECURITY.md#what-teammates-can-do-here) has the details. `/access`,
or `elu access`, shows and changes all of it.

`elu share`, or `/share` in the app, shares the project you are in, so teammates can name it
and see its live work. Inviting a teammate shares one too: `elu invite` shares the folder you
run it in when it is an ELU project (`--project PATH` names another), and `/invite`
the open project. Joining shares no project of yours, but the Kanban board needs no share:
every session you run in a repository a teammate also has is on their Kanban, with its title,
its column, who started it, which machine and its approved Task, and theirs are on yours, so
their agents also know what yours is working on. Nothing else about it
is sent: no chat, file or path. `/share off` in a project keeps it off both ways. The wire
format is in [docs/peer-network.md](docs/peer-network.md).

Teammates on a team a project is shared with see it in their Projects tab, also with no copy
of it: its name, who shares it and on which machine. What they are told is the project's
name, its handle and its git address (the `origin` remote, never with a password or a token
in it), and the title, column and starter of each session in it. Enter on the row opens the
project's team board, where the message box writes to whoever shares it: the message starts a
session on their computer, under what they chose for the team. `c` clones the project from its
git address into a folder you name; from then on it is a project of yours and the one row for
it. A project with no git address says so: copy its folder to your computer and run ELU in
it. `/share off`, unsharing the project, or leaving the team takes the row away.

Teammates on a team a project is shared with also see the work in it: for each live
editing task, the first line of its request and the paths of the files it changed, and the
approved Tasks its sessions work on. `elu share --no-status`, in the project, turns that
off. [SECURITY.md](SECURITY.md#what-teammates-are-told) says exactly what is sent.

A message you type can carry pictures. Drag a screenshot into the message box, or write
its path, and it goes with the message: up to 4 pictures, 8 MB each. Your teammate's model
sees them when it answers.

`/leave` (or `elu team leave`) takes you off a team. An admin's `/remove @kim` (or
`elu team remove kim`) takes kim off it, and kim's daemon stops when kim is on no other
team. Either way, a new invite brings them back, also when nobody heard the leave yet: the
leave goes along with the invite.

Your own computers work together the same way. Two computers on one team that are signed
in to GitHub with `gh` as the same account pair by themselves. Otherwise run
`elu invite --mine` on your laptop, then `/join` that code on your devbox and answer Yes when
it asks if the laptop is yours too (or `elu join CODE --mine`). A devbox already on your team
needs no code: run `/mine @devbox` on the laptop and `/mine @laptop` on the devbox. From then on, `@devbox fix the flaky test` in the
new session box starts the session on the devbox, with the mode, model and bots you picked.
It shows in Sessions marked "on devbox", live, and its approvals wait on both machines. The
name of its Changes tab counts what it changed, and `d` opens its Changes beside the chat, as for a
session here: the files with their counts, each change under the file and the line it is at,
`[` and `]` between files, `n` and `p` between changes. It is
your own session there, so your rules apply, and `a` on its approval, from either machine,
keeps the rule on the devbox, where it runs. When the devbox's home folder is one of its projects,
the box first asks which folder the session works in there: its projects, the home folder, and
each Git repository in the home folder, the cursor on where it would run. Enter starts it there;
Esc sends nothing and keeps your message.
Sessions also lists every other session on the devbox in the same repository under "On devbox": they are part of your project, in Sessions and on its Kanban ("you · devbox"), whichever of your computers started them.
Projects lists a devbox project as "<project> on devbox" only for its sessions this project cannot show, and says how many.
With a devbox session under the cursor, what you type goes to that session, as if you had
typed it on the devbox: `yes`, the number of a choice or your own words answer the question
it waits on, and any other message continues it. The message box names its model and the
computer ("Message Opus 5.5 on @devbox"), and its reply shows in the same pane. This works
with ELU closed on the devbox, or open there in a view-only window: the devbox runs the
session in the background. A message that has not run there yet is the last thing in the pane,
right above the message box, marked waiting, with why: its turn has not ended, no slot is free,
or it could not start. With the devbox off,
the line under the pane says so at once and your message stays in the box. `y`, `n` and `a`,
each followed by Enter, still answer its approvals.
Start a message with `@here` to ask an agent on the laptop for help with that session instead:
the first such message starts a session in the project open on the laptop, named "Help: " and
the devbox session's title, and the next ones continue it. It is told which session it helps,
what that session waits on and what it said last, and it reaches only that session, by sending
it files with a message or a message alone (Claude Code; another model says what you should
send). When the devbox session answers, your agent here goes on by itself, up to 4 times for
each message of yours, unless you stopped it, and asks you when it needs a decision, a secret,
or something only you can do. Its approvals wait on its own row in Sessions, and the devbox
session's pane says so. Both agents show in the same pane, the devbox's as "Opus 5.5 on
@devbox" and yours as "Opus 5.5 here", and the helper is also a session of its own in
Sessions. A teammate's session on the devbox, such as a handoff you accepted there, has no
agent here: every word you type goes to it.
A message to a devbox session that names files or folders on the laptop asks
"Send 14 files (2.1 MB) from this computer with this message?": y sends them along, n sends
the text alone. `/send PATH...` sends files without a message. They land in that session's
inbox on the devbox, which it may read in every mode, and each path in your message points
there. A Claude Code session of yours can list your sessions on your other computers and send
them files itself; in Ask for approval you allow each send.
A project's instructions and context are the same on all your computers, for every model and
bot there, like its tasks. A project of the same repository on both is linked by itself. Any
other, such as `ELU` in the devbox's home folder and `~/projects/ELU` on the laptop, you link
once in its settings: Projects, Enter, Linked; when the devbox has one of the same name, that
row offers it, and Enter links it. From then on an edit on either, and every line a session
learned from you, is on the other within seconds, and on one that was off when it comes back.
When both changed the same text while apart, the newer edit is used, and the line that says so
names where the other was kept (`.elu-code/history/` in the project). A computer on an older
ELU shares none, and the row says to update it.
`/mine` lists your computers and `/mine remove @devbox` ends it.

Signed in to GitHub with `gh` as the same account on both, your laptop and devbox need none
of that: once they are on a team together they pair by themselves, and say
"@devbox is yours: both computers are signed in to GitHub as <you>." To do this, each one keeps
its public peer key and box name in one secret gist of that account ("ELU Code computers"),
written and read only through `gh`; nothing else goes to GitHub. Anyone signed in to that
GitHub account counts as you. A computer you `/mine remove` stays removed until you `/mine` it
again. `/mine auto off` (or `ELU_NO_GITHUB_PAIRING=1`) turns this off.
[SECURITY.md](SECURITY.md#your-other-computers) says what that allows.

In a channel, `/invite @kim` adds a teammate you already have. `/invite` alone makes a
code for someone new; the first time, it also makes your team, named after the open project.
Once you are on a team, the code is for that team and no other team is made: with several
it asks which, and only an admin of a team can make one. If you join someone else's team
while your own still has nobody else on it, yours is closed and the line that says you
joined says so: Chats then has one #general, with everyone in it. Nothing of yours is
deleted. Two teams that both have other people each keep their own #general, named by team.

## Standup

`/standup` starts a Standup session in the open project, named "Standup" and the date and
time, and asks each open session for an update: what it is working on, what is done, what is
next, and what blocks it. Open means not archived and not moved to Done (a chat that has
answered is asked), and working, waiting for you, or active in the last 7 days. The same rule
holds for your teammates' sessions, as their computers apply it; a teammate's computer on an
older build does not say which of its sessions in Done answered, so those are listed, not asked. That is every such session of yours in every project on
this computer, those on your other computers that are online (`/mine`), and your teammates'
sessions on the shared Kanban whose computers are online. A project kept off the Kanban
(`/share off`) is never asked. Every one of them is asked, newest first.

The Standup answers within seconds. It first shows one block for every session it asks,
filled from what ELU already has on record for it, with no model run: whether it is working
and for how long, waiting for you and for what, blocked and why, or finished; its Task and how
many subtasks are done; the last thing it said, the last command it ran and the last file it
changed in the turn it is in; its pull request or branch; and when it last wrote anything. A
session on another computer of yours shows what this computer last listed for it, then that
computer's own record as soon as it sends it; a computer whose ELU is too old to send one is
named as such. A session that waits for you comes first, with its question, then the ones
that work, then the newest. Each block is titled with its session, agent and computer: "Email
logs · Opus 5.5 on @devbox", "Sales Export · Opus 5.5 here", "Billing · @billing on @kim". A
Standup, a session no agent has run in, and a session that only helps one on another
computer ("Help: …") are never asked.

Each session is then asked for its model's update (working on, done, next, blocked,
overlap), which is added to its block when it arrives. It is written in one run of the
session's own agent (its model, or the worker bot that works in it), on its own model and
limits, in at most 8 lines, and that run changes nothing: no edit, no Task, and the session
stays where it was, in Sessions and on the Kanban: answering is not activity. A Claude Code
session answers in a copy of its own history, so its next turn goes on from its work; another
vendor keeps the standup in that history. Its chat shows "@sam asks: standup", the update,
and "Sent to @sam". A session in the middle of a turn never makes the Standup wait: its
update is written by a separate short read-only run beside that turn, which reads the
session's chat and the turn's live activity, never resumes or interrupts the turn, and takes
no slot (`/slots`). The turn goes on, and the session's chat shows the ask and the update once
the turn ends, once. Up to 8 answer runs go at a time on a computer.

The first line of the Standup always says what is in and what is not: "7 sessions on 2
computers (5 on @devbox, 2 here). 7 answered from records at once. Model updates: 3 written,
4 being written." A model update that does not come is named with why, in its block and in
that line: "Missing: Email logs on @devbox (@devbox is offline)". The line under the chat
says how many model updates are still being written. Then come the sessions not asked, and
one line: "Standup done · 9 sessions on 4 computers · 8 model updates · 1 missing · 2 not
asked". `/stop` stops waiting and takes back every question not answered yet, on your other
computers and your teammates' too, so none runs later in a session. A question no session has
started on is taken back after 10 minutes and named as missing. After 30 minutes the round
ends and takes back what is still not answered, except that a model update that is being
written is waited for, however long it takes. Nothing runs on a timer: only `/standup` and
`@everyone` ask.

On a teammate's computer their own setting decides, as for any message from you: Auto asks
their sessions at once; Manual shows them "@sam asks every session for a standup update"
once a round, to approve or decline, and a decline is named in your Standup. Each of their
sessions answers at most once a round, is told their rules for teammates, and what comes back
is checked as any answer to a teammate is: paths are cut, and an update that may hold a
secret is not sent. You get the update text, the card's title, the agent's name and the
computer, nothing else. A round counts as one of your requests there. What a session has on
record costs nothing; each model update spends from your daily allowance there what it cost,
so with the limits as they come a round asks every session. When a limit there is reached, each
session it stops says which, such as "Not asked: you have used the $5.00 a day this teammate's
computer allows you." A computer that still runs an older build of ELU for its sessions is
listed, not asked.

While the model updates are still being written, the Standup's own model writes a first
summary from the records alone, and says so. When the round ends, it reads every update,
whole, with each session's record, and sums it up: what waits for you, what is done, what is
in progress, what is blocked, and who. It never says it has every update while one is
missing; the message box says "it has every update" or "it has 5 of 7 model updates". That turn starts
with nobody watching, so it only answers and keeps the Kanban: it reads, with no edits, no
shell, no web, no Task and none of your MCP servers; Full access runs as Approve for me, and
another vendor runs it Read only. It runs once a round and is never
retried on its own. Then you talk to
it: each message goes to that model with the updates and this computer's Kanban boards for
the projects involved, your other computers' sessions and teammates' cards on them read-only. It can keep the Kanban right: in
a Claude Code session with permissions it lists the boards, adds a To do card that says where
it came from ("from @billing on @kim"), changes a To do card's text, moves a card or session
to Done or back, and removes a card it added. It never changes another computer's board or a
teammate's card. In Ask for approval you allow each change; in Approve for me and Full access
it makes them, and the chat says each one: "Added 'Check JWT aud claim' to To do, from
@billing on @kim", "Moved 'Main green' to Done". Another vendor, or Read only, lists the
changes for you to make. It messages another session only when you ask it to.

## Install details

Sessions run in the vendors' own unmodified command lines (Claude Code, Codex, Antigravity
and Grok Build), with your existing sign-in. ELU has no account and no telemetry, and
it never reads your Claude Code sign-in. The Usage tab shows Claude plan usage from what
Claude Code reports during your sessions. For Codex plan usage, ELU starts Codex's own
`app-server`, which asks with your Codex sign-in, whenever `codex` is installed: when you
open a project that is set up or send a message, at most once a minute while a session is
on screen, and from the Usage tab ([what is read and when](SECURITY.md#credentials)).
Its top agents add up what each vendor reported for each run: the cost and tokens Claude Code
reports (its cost is the API price, also on a subscription), Codex's tokens, and the tokens
Grok Build and Antigravity send with a turn (Antigravity over ACP only). Codex reports no
cost, so its cost reads not reported. A run whose vendor sent no tokens says `not reported`,
never 0. A turn you stop counts with the tokens it had used; Claude Code says a cost only
when a turn ends.

You need macOS or Linux, Node 22 or newer, Git, and one vendor's command line installed and
signed in: Claude Code (`claude`), Codex (`codex`), Antigravity CLI (`agy`) or Grok Build
(`grok`). With more than one, choose with `/model`.

New sessions start on the default model. A project's default is set with `/model default
<name>`, or in its settings: Projects, Enter, Default model. This computer's default, which
every project that has not chosen uses, is set with `/model computer <name>` or the This
computer row there. `none` in place of the name clears either. With nothing chosen, the
default is the first vendor installed on this computer, in this order: Claude Code, Codex,
Antigravity CLI, Grok Build. So a computer that has only Grok Build runs every new session on
it, also one that a teammate's message, your other computer or a schedule starts. A default
whose vendor is not installed here is not used, and ELU says so wherever it shows the
default. A bot whose vendor is not installed here runs on this computer's default, reviews
too: its row in the Bots tab says so. Where no vendor installed can review, an edit goes on
and the chat says `Not reviewed: no model on this computer can review.` A teammate's
question (the read-only kind) is answered by Claude Code only; without it, both sides read
why, and the owner can set `/access` to Auto so teammates' messages start sessions instead.

ELU runs your project's checks and its pre-push hooks in a sandbox: Codex's (`codex
sandbox`, signed in or not) where Codex is installed, otherwise the computer's own,
bubblewrap on Linux and sandbox-exec on macOS, with the same limits. In Full access they
run as in your terminal, with no sandbox. Where a session needs one and the computer has
none, ELU says so before the work starts, with the step that fixes it. To use a copy of
Codex that is not on your PATH, set `ELU_CODE_SANDBOX_HELPER` to its absolute path. On
Ubuntu 24.04 bubblewrap starts only with the AppArmor profile in
[docs/permissions.md](docs/permissions.md#linux). The Linux tests run with both.

GitHub CLI (`gh`) is needed for draft pull requests, and for `@elu` to review and merge a
fix pull request.

The first run of `npx -y @elu-labs/elu` opens ELU and installs `elu` as a global
command: it prints the `npm install --global` line it runs, and uses `~/.local` when npm's
global folder cannot be written. To open ELU without installing anything, run
`ELU_NO_INSTALL=1 npx -y @elu-labs/elu`.

Run `npx -y @elu-labs/elu` from your home folder, not from inside a project you do not
trust: `npx` lets the folder it starts in decide what runs.

The Usage tab lists the vendor command lines ELU found and whether each is signed in.
Finding that out runs each of them, and one that is slow to answer can take half a minute:
the tab says `Reading what is installed and signed in here…` meanwhile and every key works.
It keeps several Claude Code or Codex accounts signed in at once, so when one runs out of its
limit you switch instead of signing in again: `a` adds an account with the vendor's own
sign-in, Enter on an account makes new turns use it, and `x` forgets one. Each account shows
its own five-hour and weekly usage ([how accounts are kept](SECURITY.md#several-accounts)).
Antigravity (`agy`) and Grok Build (`grok`) are checked once on each machine, for each
release of them. The check proves what Read only, Ask for approval and Approve for me stand
on, so your first message to one in those modes starts it by itself and waits for it: eight
steps, each a short turn on that vendor. The chat says how many are done and how long it
has taken. Full access needs no check and never waits for one: the message runs at once,
and `/permissions full` during a check runs the waiting message at once too. The Usage tab
shows whether each is signed in, and `c` on its line runs the check there and then. Vendor
notes: [docs/vendors](docs/vendors).

ELU starts the vendor command it finds first on your PATH, so one that another tool
wraps, such as a terminal app with its own `claude` or `codex` script ahead of the real
one, runs through that script in every mode. When a vendor's program does not start, the
chat says so, with what its command printed: check that the command runs in your terminal,
then type continue.

Google's FAQ says that using another app to reach Antigravity breaks its terms and can get
your account suspended or terminated. ELU wraps `agy`, so read
[docs/vendors/antigravity.md](docs/vendors/antigravity.md) before you send it a message.

## Update and remove

Quit ELU with `/quit` in every terminal it is open in, then:

```sh
elu update
```

On 0.1.11 or older, which have no `elu update`, update once with
`cd ~ && npx -y @elu-labs/elu@0.1.12`. Name the version: `@latest` can reuse an old copy
npx kept.

`elu update` installs the newest version where `elu` already is and restarts the peer
daemon on it; sessions still running finish on the old version first. Once a day ELU
checks for a newer version and says so in its status line; `ELU_NO_UPDATE_CHECK=1` turns
that check off. Both ask the npm registry for the latest version number and send nothing
else.

To remove ELU, first delete your schedules in the app (Sessions tab, under Scheduled:
`x`, then Enter, on each one), so they no longer keep the Mac awake, and quit it with `/quit`.

Then remove the login item that runs schedules, and bots with a schedule such as `@elu`,
while ELU is closed, if there is one. On macOS, run
`launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/dev.elu-code.scheduler.plist`
and delete that file. On Linux, run `systemctl --user disable --now elu-code-scheduler.timer`
and delete `elu-code-scheduler.service` and `elu-code-scheduler.timer` in
`~/.config/systemd/user`.

Stop what still runs in the background:

```sh
elu peer uninstall          # stops the peer daemon and removes its login item
elu conductor stop          # stops sessions that are still running
```

In each project folder that is a Git repository, see what ELU would remove there,
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
