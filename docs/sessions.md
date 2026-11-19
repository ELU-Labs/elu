# Sessions

Back to the [README](../README.md).

The first start asks for a project name; later starts open your last project. Type a
message and press Enter. That starts a session: the model answers, or edits in a new Git
worktree on its own branch. Then the project's checks run, and any bot you added to the
session reviews the change. Nothing is pushed until you type `/publish` and confirm.

## The tabs

| Tab | What it shows |
| --- | --- |
| Sessions | Every session across your projects. The selected one is open beside the list. Typing on a row writes a message to it; a row's key is its letter, then Enter. Task in a session's header (a click on it, or Ctrl+T) opens its Task: the goal, the objectives with the model's marks, and the checklist of its work from ELU's own records (committed, checks, review, pushed, pull request, and what it waits for). |
| Projects | Your projects. `n` makes one, `o` makes another the active one. Enter opens a project's settings: its Instructions (rules every session in it follows, which you write) and Memory (what ELU learned from you there, and what you added; every session reads it) open to read, each first saying what it is, and `e` edits them. When the project is on other computers too (Also on), both are the same there and hold what everyone on it wrote, and what ELU learned from each of them. A project a teammate shares that is not on this computer is listed too, as `ELU   shared by @rio   on @rio-mac`: Enter opens its team board, and `c` clones it here. |
| Kanban | The open project's tasks and sessions: To do, In progress, Needs you, Done. On a team, everyone with a clone of the same repository shares one board: every session another computer on the team runs in it shows in the same columns with who started it and on which machine, to read only. A project whose folder holds several repositories has a board for each. `/share off` keeps a project off it both ways. Nothing goes to Done until you check it: Shift+→ under Needs you, or `/done` in a session, shows its goal and objectives, then Done, a new goal, or a copy with one. A session at work on a Task takes a new goal too, from `/done` or its Task: its turn is not stopped, and is told at its next step, or when it ends if it takes no message. A project shared with you on another computer that no project here holds is "<project> on devbox" under Board ▾: its board is read from there, and what you do on it is done there. With no project here, Kanban opens on it. |
| Chats | Your team's channels, your teammates and your bots. |
| Bots | Your bots. `n` makes one, Enter opens one. |
| Usage | Your vendor accounts and their plan usage, then your top 10 agents by cost with their tokens. `t` switches between today and the last 7 days. |

Click a tab's name. Or press Tab until the tab row is selected, choose with ← and →, and
press Enter.

## Sub sessions

You start sessions. A session works with its own subagents, and checks on things later with
[long jobs](jobs.md), which start it again when they end. When it does start another session
(`elu sessions new`, a schedule it adds, or `@orchestrator`), that session is a sub session of
it: Sessions lists it under the session that started it, not on its own. The session's row says
how many it has (`▸3`), and they open under it (`▾3`) while it is the selected row or one of
them is. One that asks you something is always shown under it, and the session moves to
Needs you. Sub sessions are one level deep: one that a sub session starts goes under the same
session. A session told to archive itself and start a new one hands its work on, so that new
one is yours, not a sub session. Your other computers list them the same way.

## Messages while a session works

You can send a message at any time, and a working session answers it right away. On Claude Code and on Codex, one sent while the session is working goes to that turn: the model reads it at its next step and answers it first, then carries on. The chat shows that answer at once, under your message, as a reply written while it works (`Opus 5.5 · while working`), and the reply at the end of the turn does not repeat it. The line under your message says what happened to it as it changes: `Read 12:45 PM.`, then `Read 12:45 PM · answered 12:46 PM.`, or `Read 12:45 PM · carried on without answering.` once the turn has gone on for three tool calls, one after another, and written nothing, so you can ask again or stop it; if it answers after that, the answer shows then and the line says when. A new goal given to a working session and a message from another computer of the project say when they were read the same way. Behind a long command the turn reads it when that command ends, the chat says so, and Enter in the empty message box sends it now: Claude Code moves the command to the background and the same turn reads your message; Codex stops the command and goes on with your message at once. Where a turn takes no message while it works (Grok Build, Antigravity, a Codex or Claude Code that cannot, and while the project's checks run), the message is answered at once beside the turn: a short read-only run on the session's own model reads the chat and what the turn has done so far, and its answer shows in the chat within seconds, under the working line and the turn's steps, marked "Answered beside the running turn, from what it has done so far. The turn goes on." A question is done with that answer, and the session reads both at its next turn. A message that asks for work is answered the same way, says that it asks for work, and starts the next turn when this one ends; Enter in the empty message box sends it now by stopping the turn and the command that is running, its changes kept: your message starts the next turn, in the same vendor session where it can go on, and where it cannot, with what the stopped turn had said and done. The chat never says only that a message waits: each one says what happens to it and when, and the status line says the same when you send it. `↑` in the empty message box takes the newest one back so you can change it. The same holds for a session of a shared project on another computer, where that computer answers, with no window open there; if it runs an older ELU, the chat says that the message starts when its turn ends and that nothing answers it before, and still offers Enter where that computer can send it now. It holds for a message to a bot while that bot works too.

## The chat

A chat reads in time order, here and for a session on another computer. What you sent that has not been read yet is the last thing in it, right above the message box, with nothing under it; the working turn's steps are right above that. A session's Task sits after the reply that proposed it.

While the model or a bot works, the chat shows what it does now under the working line: its newest step, such as its latest thought (a long one cut to its last lines) or its last tool call (● running, ✓ done, ✗ failed), and every tool call still running. The steps before fold into one line above them, such as `▸ 14 earlier steps · ctrl+o shows all`. Opened, it shows every thought, tool call, plan and what the turn wrote on the way, and stays open while more come. A thought that comes without its text shows how many tokens it has taken so far, such as `✻ thinking · 1.2k tokens`. A call says how long it has run, second by second, such as `● Run: npm test · 2m 10s`, and keeps its total when it ends. Commands the turn left running in the background are one line, such as `● 1 background command: npm run watch · 4m 0s`. When the turn ends its steps fold into one line above its reply, such as `▸ 12 steps in 1m 12s`. A turn you stop with `/stop` keeps its steps, and its line says `stopped`. `ctrl+o` opens or folds the steps of every turn, in the message box too; a click on a turn's line opens or folds that turn's. A session on another computer shows the same. A program that prints only when it ends has no steps to show: the chat then counts the time under the working line, such as `1m 12s so far. Antigravity reports only when it ends.` Antigravity shows its steps in every permission mode where its one-time check proved `agy acp` on this machine, and runs that way otherwise ([docs/vendors/antigravity.md](vendors/antigravity.md)).

## Where a session works

A worktree sits beside its repository, in a folder named after it with `.elu-code` added
(`shop.elu-code` beside `shop`). When a Task edits the project folder itself and the folder
has no commits yet, ELU first commits its files there as `Start project history`,
running `git init` if it needs to, and pushes nothing. A file that looks like a secret, such
as `.env`, stops it until `.gitignore` keeps that file out.

What installing, building and testing leave in the worktree is not a change when Git ignores
the folder itself: `node_modules`, `vendor`, `.venv`, `venv`, `__pycache__`, `*.egg-info`,
`.eggs`, `.next`, `dist`, `build`, `coverage`, `htmlcov`, `.pytest_cache`, `.hypothesis`,
`.turbo`, `.cache`, `target` and the like, and an ignored `.coverage` file. Nothing in those
folders is read, so a link or a large file there never stops a session, and none of it is
published. A folder of one of those names that Git does not ignore, such as a tracked
`src/build`, is an ordinary folder. Any other ignored file the model writes fails the
`no-ignored-output` check, and one that looks like a secret, such as `.env` or
`src/build/.env`, fails `secret-paths`; a link among them is never followed.

## When the model commits its own work

When the model commits its own work in the session's workspace, that commit is the
session's work. The checks and the review run on it, `/changes` shows it against the
session's base, and the session ends as any other does. With all of its work committed it
is listed as `committed`, here and on other computers on the project, and its chat says where the
work is: the branch, the commit, and whether it is pushed. `/publish` then pushes what is
there, on the branch it is on; when that branch is on GitHub already with a pull request
for the same commit, it names the pull request and pushes nothing. A commit made in the
session's workspace while nothing ran, such as one you made by hand, is named in the chat
and the session goes on from it: your next message, the checks and `/publish` all do.

## One window makes changes

One ELU window at a time makes changes in a project. A second window on the same project
opens view only: it shows everything, and `/stop` works there. The first change you make in
it (a message, `x`, Enter) takes the project and then goes through: the other window lets go
and turns view only, and one that does not answer is closed when no session or command runs
in it (ELU asks first when one does). It also takes the project by itself once the other
window closes, and `/takeover` moves it at once.

## Color and pictures

ELU draws in color also where `NO_COLOR` is set; `ELU_NO_COLOR=1 elu` opens it without color.

A chart on a session's Artifacts tab is a picture in a terminal that shows pictures (kitty,
Ghostty, WezTerm, iTerm2) and text in every other, as inside tmux; `ELU_NO_PICTURES=1 elu`
keeps it text.
