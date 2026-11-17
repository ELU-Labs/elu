# Teammates

Back to the [README](../README.md).

Your computer can ask a teammate's, and theirs can ask yours. There is no ELU server:
the two connect directly over Hyperswarm.

```sh
# on your computer
elu id --name sam        # once: your name on the team
elu id --computer studio # optional: this computer's name; it starts as its host name
elu team create shop
elu invite               # prints a code like k7qm-x2pd-9fhw; it works once, within 24 hours

# on your teammate's computer, in their copy of the project
elu id --name kim
elu join CODE            # joins their team; your messages start sessions here
```

## When a join cannot connect

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

## The peer daemon

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

## Writing to a teammate

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

## What a teammate's message does on your computer

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
that mode. [SECURITY.md](../SECURITY.md#what-teammates-can-do-here) has the details. `/access`,
or `elu access`, shows and changes all of it.

## Shared projects

`elu share`, or `/share` in the app, shares the project you are in, so teammates can name it
and see its live work. Inviting a teammate shares one too: `elu invite` shares the folder you
run it in when it is an ELU project (`--project PATH` names another), and `/invite`
the open project. A computer that joins takes the folder it joins in as that same project,
whatever its folder, repository or name: it is one project on every computer that has it,
with no step. An invite or share made in another folder shares that folder as another
project of the team, and whoever joins with that invite joins it; each project keeps its own
sessions, instructions and memory. Everyone on it sees its sessions from each of those computers in
Sessions, under that computer and its owner ("On studio · sara"): Enter opens one, with its
chat, steps and changes, and its tasks are on the Kanban. Everyone on it also works in them,
under the access the computer that runs them set for that project (`/access` there): Auto
starts what they ask at once, Manual keeps it for a yes there. A computer whose folder of the
project is its home folder keeps it for a yes too, until its owner picks Auto in `/access`
there and answers y to "Let the other computers on it work here without asking?" (or runs
`elu access --auto --home` in that folder). Its instructions and memory
are the same everywhere it is. A project you
never shared, or keep off with `/share off`, stays on your computer.
The Kanban board needs no share either:
every session you run in a repository a teammate also has is on their Kanban, with its title,
its column, who started it, which machine and its approved Task, and theirs are on yours, so
their agents also know what yours is working on. Of a project you did not share, nothing else
is sent: no chat, file or path. `/share off` in a project keeps it off both ways. The wire
format is in [docs/peer-network.md](peer-network.md).

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
off. [SECURITY.md](../SECURITY.md#what-teammates-are-told) says exactly what is sent.

## Pictures

A message you type can carry pictures. Drag a screenshot into the message box, or write
its path, and it goes with the message: up to 4 pictures, 8 MB each. Your teammate's model
sees them when it answers.

## Leaving and removing

`/leave` (or `elu team leave`) takes you off a team. An admin's `/remove @kim` (or
`elu team remove kim`) takes kim off it, and kim's daemon stops when kim is on no other
team. Either way, a new invite brings them back, also when nobody heard the leave yet: the
leave goes along with the invite.

## Your own computers

Your own computers work the same way as anyone's: there is no "mine" any more, and nothing to
mark. Invite your devbox to the project like a teammate (`/invite` in the project on the
laptop, `/join` that code on the devbox in its folder of that project). From then on,
`@devbox fix the flaky test` in the new session box starts the session on the devbox in that
project, with the model and bots you picked and your mode, up to the devbox's own default.
It shows in Sessions under "On devbox", live, and its approvals wait on both machines. The
name of its Changes tab counts what it changed, and `d` opens its Changes beside the chat, as for a
session here: the files with their counts, each change under the file and the line it is at,
`[` and `]` between files, `n` and `p` between changes. It runs under that project's access on
the devbox (`/access` there), as a teammate's message does: Auto starts it at once; Manual keeps
it on the devbox until someone there says yes (`r` on it in Sessions), and anything else you ask
of its sessions from here is refused with what to do. The devbox's saved rules do not answer for
it: the defaults and the team's `/access` rules do, and `a` on its approval keeps the rule on
the devbox for that project only. A message you send from here into a session someone started
on the devbox is told those `/access` rules too, as its own turn. Sessions started from here
take no teammate slot there: only `/slots` on the devbox makes them wait. With several projects shared with the laptop, the box first
asks which one the session works in there. Enter starts it there; Esc sends nothing and keeps
your message.
Sessions also lists every other session of that project on the devbox under "On devbox",
whoever started it, and they are on its Kanban.
A project is one on every computer that has it: its row in Projects counts its sessions on the devbox too ("22 sessions · 22 on @devbox").
A project you never shared stays on its computer, yours too: no other computer sees it or works in it.
With a devbox session under the cursor, what you type goes to that session, as if you had
typed it on the devbox: `yes`, the number of a choice or your own words answer the question
it waits on, and any other message continues it. The message box names its model and the
computer ("Message Opus 5.5 on @devbox"), and its reply shows in the same pane. In a session
you wrote to a bot that works, such as `@lead`, your message goes to that bot, as it would on
the devbox ("Message @lead on @devbox · @model writes to Opus 5.5"); `@model` first writes to
its model. This works
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
the text alone, and Esc sends nothing and keeps your message in the box. `/send PATH...`
sends files without a message. They land in that session's
inbox on the devbox, which it may read in every mode, and each path in your message points
there. `@devbox` and a screenshot dragged into the new session box asks the same, and y
starts the session with it. A Claude Code session of yours can list the sessions of your shared
projects on other computers and send them files itself; in Ask for approval you allow each send.
A project's instructions and memory are the same on every computer that has it, for every
model and bot there, like its tasks: the project a team was invited to. An edit on one, and every line a session
learned from you, is on the others within seconds, and on one that was off when it comes back.
When both changed the same text while apart, the newer edit is used, and the line that says so
names where the other was kept (`.elu-code/history/` in the project). The project's settings
say where else it is: "Also on @devbox, @studio". A computer on an older ELU shares none.
`/mine` only answers that there is nothing to mark. An older ELU that still says this computer is
its own is not heard: it gets nothing for it, and what it asks is handled as anyone's.
Each computer goes by its host name until you name it: `/computer name devbox` on it (or `elu id --computer devbox`) renames it, and the other computers on your teams show the new name within seconds, ELU 0.1.27 and older too. `/computer name default` goes back to the host name.
[SECURITY.md](../SECURITY.md#computers-on-a-shared-project) says what that allows.

## Invites and channels

In a channel, `/invite @kim` adds a teammate you already have. `/invite` alone makes a
code for someone new; the first time, it also makes your team, named after the open project.
Once you are on a team, the code is for that team and no other team is made: with several
it asks which, and only an admin of a team can make one. If you join someone else's team
while your own still has nobody else on it, yours is closed and the line that says you
joined says so: Chats then has one #general, with everyone in it. Nothing of yours is
deleted. Two teams that both have other people each keep their own #general, named by team.
