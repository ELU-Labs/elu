# Commands and keys

Back to the [README](../README.md).

Type these in the message box. `/` alone lists every command, and `/help` explains the keys.

| Type | What it does |
| --- | --- |
| `/new` | Starts a new session |
| `/model sonnet` | Chooses the model of this session; `/model` alone lists them. The name can be the one the app shows, and a message after it is sent on that model: `/model opus 5.5 fix the build`. While a turn works, the model and that message start with the next turn. Over a session on another computer it changes that session's model there. `/model auto` turns [Auto model](models.md) on for this session, or for the one you are starting: ELU picks the model for each step, and each reply names the one that wrote it. A message after it is sent that way: `/model auto fix the build`. `/model auto on` is the same as `/model auto`. `/model auto off` turns it off, and the session stays on the model it has; a model or an effort you pick for the session turns it off too. `/model auto high` sets the effort of its plans and edits and `/model auto quick grok` where quick questions go, both for this computer. `/model computer auto` starts the sessions you start on this computer with it |
| `/permissions auto` | Sets what the model may do: `ask`, `auto` or `full` |
| `/place branch try-coupons` | Sets where a new session runs: `worktree`, `branch NAME` or `here` |
| `/bots add qa` | Keeps a bot in this session; `/bots remove qa` takes it out |
| `/agent add fable` | Adds another model to this session as an agent; write `@fable` and what to do. Words after the model say what it is for, and `--name NAME` names it: `/agent add sonnet you review my SQL --name sql`. `/agent change @sql effort high` changes an agent's model, its effort or both (`@model` is the session's own model), as a click on the heading of its reply does; a bot changes for this session only unless `--every-session` follows |
| `@pair is there a simpler way?` | Asks a bot. Your next messages in that session go to it too |
| `@lead plan the coupon work` | Asks a bot that works. The session stays its own: your next messages, your approval of its Task and a new goal go to it, and it hands work to its helpers |
| `@model and what do you think?` | Writes to the session's model again |
| `/orchestrator act` | Sets how much the bot that oversees your sessions may do by itself: `watch`, `suggest`, `act` or `run`, for every project on this computer. `/orchestrator` alone shows the level, the caps and its last five actions; `/orchestrator undo a12` undoes one of them, and asks you first for an Organization line. See [Orchestrator](orchestrator.md) |
| `/changes` | Shows what this session changed; `/chat` goes back. The name of its Changes tab counts them (`Chat   Changes 7`) before you open it: a session of this computer counts again when a turn ends or its state changes, and one on another computer shows its changes the same way, whole. In a session of this computer, `+` on a line (or a click on its `+`) notes what should change, and `s` sends the notes to the model together |
| `/publish` | Shows the exact push and draft pull request, then asks you |
| `/stop` | Stops the running response, and the [long jobs](jobs.md) the session started. Messages you sent while it ran then go at once, in order; `↑` takes one back first. Over a session on another computer, it stops that session there, when it was started from here or that project is Auto there. While a session of this computer works, the key bar under the message box names it (`/stop stop`) |
| `/archived` | Lists this computer's archived sessions last in Sessions; `/archived` again hides them. `c` archives a session, and `u` or a new message brings it back. `/archived clean` deletes them for good, or first saves what you taught in them to the project's memory. Every other computer lists and cleans up its own |
| Enter (empty box) | While a turn works and a message of yours waits, sends that message now. On Claude Code the command the turn waits on moves to the background and the same turn reads the message. On the other vendors the turn stops as `/stop` stops it and the message starts the next turn, in the same vendor session where it can go on |
| `/schedule in 1h check the build` | Starts a session later or on a schedule: `/schedule [when] [message]`. `/schedule ` lists times such as `in 5m`, `in 1h` and `daily 9:00`. Each run is a new session with the model, mode and bots of the form (a bot with its own schedule is left out); it does not see the chat it was made in. Each run is named with the schedule's message, or with the name you gave its last run, and it archives the schedule's earlier runs, so Sessions lists one run of each schedule; `/archived` shows the others. A run that still works or needs you stays until a later run finds it done. A schedule gets Full access only when you pick it for that schedule, and the form asks you once before saving it |
| `/budget 5` | Limits this session to 5 dollars, or any amount from a cent up; `/budget` alone says what it has spent, and `/budget off` removes the limit. At the limit it offers a higher one, or `/budget off` while a run's cost is not known. See [Usage](usage.md#spending-limits) for where the limit is checked |
| `/keepgoing off` | Whether ELU starts this session again by itself while its Task's objectives are not all met and nothing is running: `on` or `off`; `/keepgoing` alone says which it is. See [Long jobs](jobs.md) |
| `/slots 12` | Limits how many sessions run at once, in one project as in several, to any whole number from 1. Until you set a limit there is none and no session waits for a slot; `/slots off` removes it, and `/slots` alone says which it is. What you type always starts; this number limits what starts by itself. A new session you start or a message you send here, a Task you approve here, a teammate's message you accept with y or w and a schedule or bot you run now start whatever runs. A scheduled run that comes due, a bot's scheduled turn, a teammate's message that Auto starts, what another computer on a shared project asks for here, a retry after a failure and a message one session sends another wait under Queued past the limit, and the chat says what each waits for, such as "Waiting for a free slot: 13 sessions are running, and 12 run at once. /slots changes it."; it starts when a slot frees. Running work is not interrupted |
| `/standup` | Asks every open session of yours here, and those of your shared projects on other computers, for an update, in a new Standup session. See [Standup](standup.md) |
| `@everyone did anyone touch auth?` | In a Standup session, asks the sessions of its last round again, with your question; `@everyone standup` asks for an update. Elsewhere it starts a Standup with the question |
| `! git status` | Runs a shell command. In an open session the model gets the command and its output with your next message |
| `/computer name studio` | Renames this computer. The other computers on your teams see the new name within seconds, in their Sessions headings and `@studio`. `/computer` alone says its name; `/computer name default` goes back to its host name. On the command line: `elu id --computer studio` |
| `/update` | Says how to update: `/quit`, then `elu update` |
| `/takeover` | In a view-only window, moves the project to this window. The other window turns view only |
| `/quit` | Closes ELU. Sessions that are running or queued go on in the background; `elu conductor stop` stops them |

## Schedules

A schedule also runs while ELU is closed, through a login item, once ELU is
installed (not run through `npx`). The login item is there only while a schedule is on, a
task's or a bot's: ELU removes it with the last one, also while ELU is closed, and puts it back with the next. On Linux it is
a systemd user timer, which runs while you are logged in; `loginctl enable-linger` keeps it
running after you log out. On macOS, while an agent works or a schedule is on, ELU
stops the Mac from going to sleep on its own (`caffeinate -i`); the display can still
sleep. A closed lid, or a battery that runs out, still puts the Mac to sleep. In the Sessions tab a schedule is the session it runs, marked `◷`, or a row under
Queued until it first runs (under Recent while paused). Its Schedule tab (`t`, or a click on
the name) shows when it runs, the next run, its message and its mode, and changes them for
the next run; there `r` runs it now, `p` pauses it and `x` deletes it. A new run archives the schedule's earlier ones, as `c`
would, so its row stays one, with the name you gave the last one; `u` or a new message brings one back. A time is `in 30m`, `every 2h` (15 minutes to 7 days),
`daily 9:00`, `weekdays 9am`,
`mon,thu 14:30`, `tomorrow 15:00` or `2026-12-01 9:00`, in this computer's local time.
Asked to repeat work, the model makes the schedule with `elu schedules add` where it has
[ELU's own commands](#elu-from-a-session), and otherwise gives you the `/schedule` line to type.

## ELU from a session

`elu sessions` and `elu schedules` change ELU from your shell and from inside a session, so a
message or a schedule such as "archive this chat and start a new session that says hello" just
works. The app shows each change at once.

- `elu sessions [--all]` lists this project's sessions: number, name, state, the schedule that
  started it, and whether it is archived or in Done. `elu sessions archive N|this`, `unarchive N`,
  `rename N|this "name"` and `new "message" [--mode ask|auto|full]` change them. `this` is the
  session the command runs in: it is archived when its turn ends, after its reply.
  `elu sessions goal N "goal"` gives one a new goal, also while it works: its turn is not
  stopped.
  `elu sessions copy N "goal"` starts a copy of one, with a new goal.
  `elu sessions delete N|archived [--learn]` deletes an archived session for good, or every
  archived one; `--learn` first saves what you taught in them to the project's memory.
  Work on no remote stays in its folder and on its branch.
- `elu schedules [--all]` lists the schedules, and `elu schedules add <when> <message>` (the
  words `/schedule` takes), `pause N`, `resume N`, `delete N` and `run N` change them.
- `elu jobs` lists the session's [long jobs](jobs.md), and `elu jobs start NAME -- COMMAND`,
  `stop NAME` and `log NAME` start one, end one and print the end of its log.
  `elu sessions keep-going N|this [on|off]` says or sets whether ELU starts a session again
  while its Task is not met.

A session started from a session, or the run of a schedule added in one, is a
[sub session](sessions.md#sub-sessions) of it, listed under it in Sessions and in
`elu sessions`. A session started from a session gets that session's mode, or a lower one with `--mode`. In
Ask for approval you are asked before one runs; Approve for me and Full access run them. Every
vendor's session has them, in every mode. Inside a sandbox the command hands itself to ELU,
which runs it only for that session and no higher than its mode. A schedule added in a session
gets that session's mode or a lower one, and `elu schedules run`, `resume` and `delete` there
take only a schedule whose runs get no more: the others are yours, in ELU. A teammate's
question or review, or a session a teammate's message started, is never told about them and
cannot run them. Neither is a turn that a note of `@orchestrator` led to, nor a session it
started until you write there: an `elu` command such a turn runs is your own `elu`, and it
asks you each time, in every mode.

## Keys

The last row of the screen names the keys for whatever has the focus.

| Key | What it does |
| --- | --- |
| Tab | Moves between the tabs, the list, the message box and the chat |
| Enter | Sends the message, or opens the selected row |
| Esc | Leaves the message box for the list, and the list for the message box; closes a dialog |
| ↑ ↓ | Move in a list; scroll the chat when it has the focus |
| PgUp PgDn | Move a page: in a session's chat or its changes and in the threads of a chat in Chats, from the message box too; in the Sessions list; in the text of a dialog, such as a teammate's thread, `/help` or a bot's instructions as you edit them |
