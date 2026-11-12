# Security

## Reporting a vulnerability

Report it privately. Open the repository's **Security** tab and choose **Report a
vulnerability**, or go straight to
<https://github.com/ELU-Labs/elu/security/advisories/new>. Please do not open a
public issue or post reproduction details before a fix is out.

Say what you ran: the output of `elu --version`, your operating system,
the vendor command line and its release, the session's permission mode, and the steps.
Fixes are made on `main`; there are no older versions that get fixes.

## What is trusted

ELU Code launches installed vendor CLIs. The executables and your local installation are
trusted. Repository content, check scripts, prompts, and model responses are untrusted.
Only the owner can approve a push.

Prompts explain the task but are not security controls. This tool cannot prove a change is
correct, and model review is not a substitute for a person reviewing a pull request.

## What an agent may do

It depends on the session's permission mode ([docs/permissions.md](docs/permissions.md)).

- **Read only** is the profile of every reviewer, every question for a shared bot and every task
  saved without a mode. It gives no shell tools unless the Claude role declares explicit
  command prefixes. ELU Code adds none by itself: the test and build scripts it finds in a
  project run only as checks, inside the check sandbox, and a prefix reaches the model only
  from the project's settings file (`roles.lead.commands`). Ordinary questions in Read only
  have only read-only file tools, with no shell, workspace creation, or check execution.
- **Ask for approval** and **Approve for me** give the session's model, and a bot that
  works in the session, a shell inside the vendor's own sandbox, with no network. In Ask
  for approval Claude Code's sandbox reaches a host only once you allow it when asked, for
  the rest of that session. An action outside the sandbox asks you where the vendor can ask
  during a turn (Claude Code, and Antigravity and Grok Build once their one-time check has
  proven it); on Codex, which cannot, it is refused and reported. In Approve for me a reviewer model
  decides instead of you. The sandbox differs by vendor: Antigravity in Ask for approval
  has none, so every command needs your approval and one you approve runs outside any
  sandbox, and Grok Build's sandbox blocks the network on Linux only. The vendor pages in
  [docs/vendors](docs/vendors) have the details. In both modes your session's answer
  turns, and a working bot's, also read your home folder without asking, except the
  secret folders ([docs/permissions.md](docs/permissions.md)).
- **Full access** gives an unsandboxed shell. A Full access shell can read anything your
  user can, except where the vendor's deny rules cover a file tool.

The helpers a bot hands work to run under the same mode and the same denied commands as
the bot.

What a teammate's message does here is set per team ([What teammates can do
here](#what-teammates-can-do-here)). Its answer goes back to them without waiting for you
to read it, unless you chose to read that teammate's replies first. A reply that looks like it
holds a key or a token is always held for you; that check looks for the shapes of secrets
and is not a guarantee. Only a project's own folder can be shared, never your home folder,
and a shared project answers only the teams it was shared with.

A picture goes to a teammate only with a message you typed yourself that names it. A path
in text you pasted into the message counts the same as one you typed, and the line that
says how many pictures went (`with 2 pictures`) comes after the message is sent. A model's
draft never attaches a file, and a picture in a folder that holds secrets is refused; a
hard link in another folder to a file in such a folder is not recognized, and is attached.
"A picture" means a file whose first bytes say PNG, JPEG, GIF or WebP: the rest of the file
is not checked, and it is sent as it is, with what it records about the place, the device
and the time. A picture a teammate sends you is kept in ELU Code's private folder under a
name made here, readable only by you, and is never run. When you accept their question, its
run can read the shared project and a copy of those pictures, and nothing else. The copy
sits in the temporary directory, closed to other users, until the run ends; another session
of yours that can read the temporary directory could read it in that time.

Only Full access uses a vendor permission bypass, and only for the model of a session you
gave it and the bots that work in that session; every other launcher asks or denies.
Unsupported policies stop before a role launches. In Read only, Ask for approval and
Approve for me, task metadata and source checks stay outside agent write access: the file
tools and the sandboxed shell may not change the repository's Git folder or the protected
project files, and may not read ELU Code's records in that folder; a command that leaves
the sandbox asks first. Full access can change them, as it can change anything your user
can.

A sandboxed command reads the rest of the Git folder, so `git status`, `git diff` and
`git log` work without an approval. Through git it can read the repository's whole
history: every committed version of every file, including a file committed once and later
removed, and committed files the sandbox hides by name in the worktree (`.env*`, `*.pem`,
`.npmrc`). It can read the Git settings file, with its remote URLs and any token written
into one, and the stash and the reflog. The sandbox has no network beyond the hosts you
allowed when asked, so a sandboxed command cannot send what it reads anywhere else; what
it prints goes to the model, as all output does, and into the session's record. `git add`,
`git commit` and anything else that writes in the folder stay refused. A teammate's
question is given tracked files only: its commands read none of the folder.

Vendor tool permissions restrict direct file tools. Claude Code's own sandbox fences only
shell commands and is never required: where it cannot start, commands run outside it under
the same rules (Ask asks you for each, a reviewer model decides in Approve for me, a Read
only role keeps its command prefixes).

Claude shell roles are labelled "temp folder writable": shared temp directories are denied,
but the vendor can retain its own writable temporary folder outside the worktree. This
exception is visible in `elu policy show`. In Read only, Ask for approval and Approve for
me ELU Code names that folder itself where its path is short enough for Claude Code to
use: a private one under your cache folder, or in your runtime folder where that path is
too long, made for the run and removed when it ends (`docs/vendors/claude.md`).

## When ELU Code connects to teammates

ELU Code makes no peer connection until this machine makes a team or tries to join one
with a code. Someone who never invites anyone and never joins a team starts no peer daemon
and connects to nothing. A join starts the daemon for the join: it announces this machine's
key on HyperDHT and looks for the inviter, and when the join fails it stops again within
about two minutes. Once the machine makes a team (`/invite`, `elu team create`,
`elu invite`) or joins one (`/join`, `elu join`), the peer daemon runs in the background,
also while ELU Code is closed, so teammates can reach it: it announces this machine's key on
HyperDHT and connects to its teammates
([docs/peer-network.md](docs/peer-network.md#layers)).

There is no switch to turn it off while you stay on a team. To take this machine offline,
leave each team (`/leave` or `elu team leave`); once the machine is on no team, the daemon
stops. It stops too when an admin removes this machine from its last team. The person who
made a team cannot leave it, so their machine stays reachable while they keep the team.
`elu peer uninstall` stops the daemon and removes its login item, and `elu uninstall` stops
it too, but only until ELU Code next opens or an `elu` peer command runs while the machine
is still on a team.

## Update check

Once a day, as the app opens, ELU Code asks `https://registry.npmjs.org/@elu-labs/elu/latest`
for the latest version number, in the background, and keeps the answer and the time in its
state folder. `elu update` asks the same address. Neither sends anything about you or your
projects. `ELU_NO_UPDATE_CHECK=1` turns the daily check off. `elu update` installs with
`npm install --global --ignore-scripts`, by name and version, where `elu` already is.

## What teammates can do here

Each team has one setting on your machine, asked by `/join` and by your first `/invite` for
that team, and changed with `/access` or `elu access`:

- **Auto** (the default for a new team): a teammate's message starts a session at once, as
  if you had typed it into ELU Code, in the project you joined or invited from. Its first
  turn runs in that project folder itself, not in a worktree. Like your own turns it reads
  your home folder (not the secret folders) and uses your MCP servers and Claude Code
  memory. It runs in your default permission mode, except that a session nobody started by
  hand never gets Full access: from Full it runs with Approve for me, as a schedule does.
  Its answer goes back to the teammate without you reading it, unless it looks like a
  secret or you hold that teammate's replies. Any Task it proposes waits for your approval,
  as your own do; only an approved Task's edit runs in a new worktree, and the teammate is
  told that the plan waits for you and that no further reply comes in the thread.
- Auto applies only when every team the project belongs to here (the teams it is shared
  with that you and the sender are both on, and the teams whose setting names it) is set
  to Auto for that project. Otherwise the message waits. A team ask (`#general` or a
  channel) always waits, so one message never starts a session on every member's machine.
  A later message in the same thread continues its session in the mode the session has
  now; if that is Full access, it waits for you.
- **Manual**: each message waits until you approve it (y), then starts that same session,
  in your default mode, Full access included, since you started it. w picks the mode, place
  and folders first; n declines.
- A teammate's message never runs in your home folder, or a folder above it, and its session
  never edits a repository there, in any mode: that would reach every file of yours. When the
  only project it could run in is your home folder, it waits, and y says to open ELU Code in
  the project folder and approve it again. Its session shows the teammate's own words, under
  their name, and is never sent again as yours.
- A team whose setting was never set (joined with an earlier version) is Manual with no
  rules: its messages arrive as chat and wait for you. Nothing turns Auto on by itself:
  `elu invite` on such a team saves Manual unless you pass `--auto`, and `/invite` and
  `/access` offer Manual first.
- Leaving a team, or being removed from it, forgets its setting on your machine. Coming
  back with a new invite sets it again: `/join` asks, and `elu join` saves its flags, Auto
  with no rules when there are none.

**Rules** are plain English you write, up to 1000 characters, such as "Only answer
questions, do not edit files." They go, under the heading "The owner's rules for
teammates", into the prompt of every turn of every session a teammate starts here, and the
model is told to follow them, to refuse what they forbid and say so, and to only propose
when they say to change nothing until you accept. They are a guard in what the model is
told, not a limit ELU Code enforces: a model can get them wrong. A session gets the rules
of every team its project belongs to here, so the sender cannot pick a team with laxer
ones. Once you approve a Task, that approval counts as your acceptance of the work inside
its goal. What is enforced is the permission mode, the Task approval before an edit, and
the per-teammate and per-team message and spending caps. The never list (push, merge, tag,
deploy, publish, and adding or removing an MCP server) holds for every session a teammate starts as it does in that mode for
your own (`docs/permissions.md`): in Ask for approval and Approve for me it is backed by
the sandbox and deny rules; in Full access, which only a session you approve can have, it
is stand-in commands, prompt text and deny rules with no sandbox behind them, and a
teammate's message can then reach any file you can. Each turn a teammate's message starts
may spend at most the per-request cap (`caps.runUsd`), which intake reserved for it; a
cost a vendor does not report counts as that whole amount. These sessions share the peer
slots with teammates' questions, so they never fill every slot of yours.

A question for one of your shared bots is answered by that bot, read only, after you
accept it, as before. A machine on ELU Code 0.1.6 or earlier refuses a message when its
owner shares no project; the sender is then told that the teammate needs to update.

## What teammates are told

A project is shared with `elu share` or `/share`, and also when a teammate is added:
`elu invite` shares the folder it runs in when it is an ELU Code project (`--project PATH`
names another), and `/invite` the open project. A join shares only after the joiner says
so: `/join` asks before it shares the open project, and after `elu join` with a short code
it takes `elu share` (a long code from 0.1.3, which names the inviter's key, still shares as
`elu invite` does). A share has status
on unless you made it with `elu share --no-status`; `/share`, and `elu share` without that
flag, turn status on again. While status is on, and the project has an `origin` remote, the
teammates on a team it is shared with are told two things about it, and neither is checked
for secrets:

- **Status rows**, one for each live editing task (one being prepared, running, ready or
  waiting for you; a plain conversation has none): the first line of the request it works
  on, up to 80 characters; its state and what is at work on it (`lead`, `checks`, a shared
  bot's `@name`, or `bot` for another bot); and the paths, relative to the repository, of up
  to 200 files it has changed or added. They are used to warn about overlapping work. The
  peer daemon reads them every 10 seconds and sends them when they change, and to each
  teammate when they connect.
- **Tasks**: for each session, the approved Task its work is on and any finished in the
  last 24 hours, with the title, description, goal, objectives, priority, severity, state,
  subtasks, which objectives are met, who works on it, and its times. They are sent within
  5 seconds of a change, and to each teammate when they connect.

**Without sharing.** A team has one board for each repository a member shared with it. A
project of yours whose `origin` remote is that same repository is on that board too, though
you never shared it, so the teammates on that team are told its Tasks as above (not its status
rows, and nothing else about it). This needs no step on your machine, joining a team included,
and your Manual or Auto setting does not change it. It never applies to your home folder or a
folder that holds it, to a project with no `origin` remote, or to a project you share yourself:
that one goes only to the teams you shared it with. Any member of the team can put a
repository on its board by saying they share it. Their claim counts on your machine only
when it names the repository's first commit and your clone has that commit, so knowing the
remote is not enough. For a public repository both are public, so any teammate, or anyone
posing as your inviter (see Invite codes), can bring your clone of it onto their board.
`/share off` in a project keeps it off every board both ways: its Tasks are told to nobody,
and teammates' Tasks are not shown in it or given to its models. `/share on` puts it back.

**Sessions on the Kanban.** Every session you run in a repository is a card on the Kanban of
each teammate, and each other computer of yours, who has a clone of that same repository.
No share is needed. A card holds only the session's title (its name, or the first line of
what was asked, up to 80 characters), its column (In progress, Needs you or Done), who
started it, the time it last moved, and the id of its Task when it has one. Never the chat,
a file, a diff or a path: a path in the title reads [path], and a title with a secret in it
goes as "Session". A session a teammate's message started shows what they asked and their
name only to teammates on a team that message came through; anyone else sees "Session". To know who has which repository, each machine sends each teammate
one proof per repository: a hash of the two machines' keys, the repository id and its first
commit. A teammate without a clone of that history cannot make the proof, and a proof made
for one pair of machines counts for no other, so a card goes only to someone who has the
repository, and is kept only from someone who proved it. For a public repository anyone can
get the history, so any teammate can. `/share off` in a project keeps its sessions and its
repositories to itself, and shows no teammate's session in it.

Every teammate on any of your teams is also told, whatever the status of your shares, this
machine's name (the peer setting `box`, by default the first part of its host name), the
bots you share and what each is for, the names of the projects shared with their team, and
the repository ids (a hash of the `origin` remote) and first commit ids of those projects.
Nothing else about your work is told: not a Task you have not approved or a rejected one,
the rest of your request, the chat, file contents or absolute paths. A teammate's question
and its answer are another matter, covered above.

What a teammate tells is untrusted text: each field is checked and cut to its limit before
it is kept, and it counts only in your project of the same repository, when that repository
is on the board of a team that teammate is on, and never in a project kept off with
`/share off`. Your
own model and bots in that project are given the titles and goals as data, marked as a
teammate's text and never as a request; a teammate's question running on your machine is
given none of it.

## Invite codes

An invite code is 12 random characters, such as `k7qm-x2pd-9fhw`, about 59.4 bits. It works
once, for 24 hours. Anyone who has it can join that team as a member, so send it only to
the person you mean. It names no team and no key: while the invite is open, your peer
daemon waits on a network topic derived from the code with scrypt, and the joiner finds you
there. Before you say anything about the team, each side proves to the other that it knows
the code, over that connection only ([docs/peer-network.md](docs/peer-network.md#roster)).

What others learn:

- A DHT node near the topic, or anyone looking it up, sees the topic, your peer key and the
  IP addresses of the two machines. Not the team, its members or the code. Getting the code
  back from the topic costs one scrypt run of 64 MiB per guess: hundreds of thousands of
  GPU-years for the whole space, against a code that lasts a day.
- Someone on the topic who does not know the code fails the proof and learns no more than
  the topic told them. A proof covers both sides' fresh nonces and both keys of the
  connection, so it cannot be replayed or passed through a relay.
- Your `invites.json` keeps, for each code, the topic, the key you prove yourself with and
  the public key a joiner's proof is checked against. Not the code: a copy of the file
  cannot be used to join.
- Whoever holds the code, or a copy of your `invites.json`, can also answer as you: wait on
  the topic and admit the joiner to a team of their own. Joining shares no project of the
  joiner's, so they would get the joiner's questions, and one more thing: the approved
  Tasks of the joiner's clone of a repository they say they share, when they name its first
  commit too (see Without sharing). For a private repository that takes a copy of it; for a
  public one it does not. The joiner shares a project only with `/share` or `elu share`,
  `/share off` keeps one off every board, and `elu peers` shows each member's fingerprint.
  The titles and columns of the joiner's sessions in a repository the other side proves it
  has go to them too (see Sessions on the Kanban).

## Your other computers

Marking another machine as yours (`/mine`, `elu mine`, or an invite for "Another computer of
mine") lets it start sessions on this machine as if you typed them here: in your default or
chosen mode, Full access included, with your bots and your MCP servers, and without the
limits teammates get. Treat it like a login to this machine.

- A machine counts as yours only when both machines marked each other, and only while they
  share a team. The mark is kept on each machine and keyed by its peer key. Either side ends
  it with `/mine remove @name`; leaving or being removed from the last shared team ends it too.
- Only such a machine can start, continue, stop or answer a session here, or read its events.
  Everyone else, teammates included, is refused, and is never sent a session's events.
- The never list, the sandbox, approvals and this machine's limits still apply to those
  sessions, and push, merge and deploy stay blocked as they are for your own.
- An invite code for another computer of yours works once, for 1 hour unless you choose
  otherwise. Anyone who uses it first becomes one of your computers, so type it on the other
  machine yourself and check `/mine` afterwards; `elu peers` shows each machine's fingerprint.
- Joining with such a code marks nothing on the joining machine until the person there says
  yes ("Is <name>'s computer yours too?", or `elu join CODE --mine`). A teammate who sends you
  one cannot make their computer yours: say No.
- Two machines on a team together that are both signed in to GitHub (with `gh`) as the same
  account mark each other by themselves. Each keeps its public peer key and box name in one
  secret gist of that account; only `gh` talks to GitHub, and the token is never read. Anyone
  signed in to that GitHub account counts as you, so sign in to it only on your own machines,
  or turn this off with `/mine auto off` or `ELU_NO_GITHUB_PAIRING=1`. A teammate signed in as
  someone else cannot write to your gist. A machine you `/mine remove` is not paired by GitHub
  again until you mark it yourself.
- An approval waits on both machines. The first answer, from either one, is the one that counts.
- A session your other computer starts is your own, not a teammate's: your rules (`a`,
  `/permissions rules`) and the defaults answer for it, it may run in your home folder as your
  own sessions do, and its messages read as yours. `a` on its approval, from either machine,
  keeps the rule on the machine where the session runs, since that is where its approvals are
  answered. That machine makes the rule from its own copy of the request, never from what the
  other one sends, so the never list and the limits on rules hold there too.
- A machine of yours sees every session on the other one, not only the ones it started:
  sessions you started there, ones a schedule or a bot started, and ones a teammate's message
  started, with their chat, steps, changes and approvals. It can continue, stop and answer
  each of them. A teammate's question answered in Chats is not shown. An ordinary teammate
  sees none of this.

## Leaving, removal and coming back

A teammate who leaves, or whom an admin removes, is out of the team from that op on: their
later ops are not applied, and a connection from their machine serves nothing but an invite
exchange. Over it they are told about their exit and nothing written after it: no member
admitted since, channel or role change. The connection then closes. A new invite brings
the same key back as a new member with the role that invite gives. What they signed before
they went out stays; nothing they sign that is dated between going out and coming back
applies; and a machine that saw them go out refuses any op of theirs dated before that, so
backdating cannot give them back an old admin role
([docs/peer-network.md](docs/peer-network.md#roster)). The person who made the team cannot
leave it or be removed.

## The never list

The never list (push, tag, merge, deploy, publish, and adding or removing an MCP server
with `claude mcp add`, `add-json`, `add-from-claude-desktop`, `remove`, `elu mcp add` or
`elu mcp remove`) is enforced only where the means are missing: Read only and Ask for approval, with the one exception below. In Approve for me
and Full access it is prompt text plus the vendor's deny rules, which match command text
and can be sidestepped by an obscured command. ELU Code's own publish step still needs
your confirmation and still refuses a default branch in every mode.

One entry can open. A bot that is allowed to merge pull requests (`@elu` comes allowed; a
bot you make is not) may run `gh pr merge` in its own working turn on Claude Code: its deny
rules leave that command out, and its `gh` stand-in lets it through. In Ask for approval
you are asked before each merge. In Approve for me the reviewer model decides and you are
not asked, and Full access does not ask. A turn its schedule started runs with Approve for
me at most, so in a session set to Approve for me or Full access the hourly `@elu` can
merge with nobody watching. Push, tag, `git merge`, deploy and publish stay blocked for
that bot as for every other.

A rule on command text does not see what a script runs, and Codex has no deny rules at
all. So every vendor's session, in every mode but Read only, also gets stand-in commands:
a private folder (`~/.local/share/elu-code/never-list`, mode 0700) goes first on the
session's PATH with one script per command word, and each refuses the never-list call by
name whatever runs it, a script or `sh -c` included. Claude Code builds PATH again for
each command, so ELU Code names a one-line file in `CLAUDE_ENV_FILE` that puts the folder
back in front. This was seen with the real Codex and the real Claude Code in Ask for
approval and Approve for me, not in Full access; with Antigravity and Grok Build only in
tests against stand-in tools. They are a tripwire as well, not a sandbox. These get
past them: a full path to the real command (`/usr/bin/git push`), a changed PATH, a Git
alias (`git -c alias.p=push p`) and another program that does the same work (`gh api`,
`git send-pack`). Two things pass on purpose, because they are not publishing: a
`git push` to a folder on this machine (a path or a `file://` URL, as git itself resolves
the remote), and a `git merge` or `git tag` in a scratch repository that lies, links
resolved, inside the system temporary directory. A push to another machine, or one git
cannot place, is refused before anything is sent. A project kept under the temporary
directory is treated as scratch. A session in Full access can also rewrite the folder; it is written
again, and cleared of anything else, when the next session starts. In Ask for approval
and Approve for me the vendor's sandbox, where it runs one, still stands behind them; in
Full access nothing does.

## Approvals

Approvals have limits. They are a convenience, not a boundary against an agent that is
already outside the sandbox: a process running as your user can forge an answer file. Ask
for approval keeps the agent inside the sandbox until you say yes; Approve for me trusts
the vendor's reviewer model; Full access trusts your choice. Request text is model output:
control characters are stripped, otherwise the command, path or URL is shown exactly.

A rule you keep with `a`, and the defaults, answer for you in the relay; they are not a
sandbox either. What a rule can do: allow one program and subcommand with any arguments
(`npm test`), one exact command, edits in the session's own workspace in turns that edit, one
file outside the project, or pages on one host, in one project or all of them. What it
cannot do: allow anything on the never list, joined or wrapped commands, removals, `sudo`,
inline code, a secret file, `.git`, an MCP tool or a web search; leave the sandbox unless it
was kept from a request that left it; or apply in a session a teammate started. A session
your other computer started is yours, so they apply there, from that machine's own rules. Where a
vendor runs commands with no sandbox (Antigravity, Grok Build, Claude Code where its sandbox
cannot start), every command counts as leaving it. Arguments are checked each time only for
secrets, ELU Code's own files and git options that run a program or write a file, so `npm
test` allows `npm test -- anything else`, and a script the rule allows runs whatever the
project put in it. The read and git defaults answer a command only inside the sandbox. Rules live in your personal directory, mode 0600, and
are read again on every request; a file that cannot be read allows nothing.

## Configuration, MCP servers and hooks

A project's own settings and instructions (`.elu-code/config.yaml`, `instructions.md` and
`context.md`) come with its folder, so they count as yours only once you have approved
their exact content on this machine. ELU Code shows a file that is new or changed and asks
once whether to use it. Until you approve a first version, sessions run on the default
settings and without those instructions. After that, the version you approved last stays in
use until you approve a change: a file that changed, that you turned down or that was
removed does not put the defaults back. A file over 100 KB is never used. Scripted runs
are refused while the settings file in the folder is not one you approved. Your answers are
kept by content hash, with the text you approved last, in ELU Code's own state folder,
never in the project. Like approvals, this is not a boundary against a process that already
runs as your user: a Full access session can write that folder, and so can a command that
was approved to leave the sandbox in Ask for approval or in Approve for me, where the
approver is the vendor's reviewer model. With a Codex model, the repository's own
`AGENTS.md` reaches the model as Codex itself reads it, and this step does not cover it.

ELU Code starts one MCP server of its own, the approval relay, and only for a session with
permissions: a dependency-free process that turns Claude Code's permission prompts into
requests you answer in the terminal. Its Claude launcher otherwise uses strict MCP
configuration, holding only the servers ELU Code passes, and loads no settings files
(`--setting-sources ''`). The Codex reviewer ignores user configuration and refuses
project or managed configuration that has not passed isolation tests.

Your own Claude Code MCP servers (`claude mcp list`: the ones in `~/.claude.json`, for all
folders and for the project folder) are given to the model of your sessions on Claude Code
and to each bot that works there, unless you turn one off for the project with
`/mcp off NAME`. A bot also gets the servers its page names, even one turned off for the
project. Bots that only review or answer, a read-only turn and a teammate's question get
none. Their tools run without asking in every mode: in Read only (a task saved without a
mode), Ask for approval and Approve for me they are allowed by name, and Full access
allows everything. They run as their own processes, so neither the shell sandbox nor the
never list covers them: a server that can push, merge, post or send mail can do so
without asking you. Their settings, which can hold tokens, are copied for each run into a
private file in ELU Code's state folder and removed when the run ends.

You add a server, and a key never goes through the chat. The model is told to ask you to
type `/mcp add` when it needs a server you do not have, never to ask for a key in the chat,
and never to add or remove a server itself. Adding and removing one (`claude mcp add`,
`add-json`, `add-from-claude-desktop`, `remove`, `elu mcp add`, `elu mcp remove`) is on the
never list, and no session's file tools may read `~/.claude.json`. In Full access these
are rules on command text, stand-in commands and prompt text, not a boundary: a model there
runs as you, with no sandbox, and a full path to `claude`, a script, or a program or file
tool that writes `~/.claude.json` itself can still add a server. `/mcp add` takes the key in
a field that shows one dot for each character; the key is not drawn, kept in the message
box or its history, sent to a model or a teammate, or written to a log or a session's files.
`elu mcp add` refuses a key on its own command line, in a header, a variable or the URL, so
it never has you put one in your shell history, and asks for it with echo off or reads it
from standard input. Claude Code's own command
saves the server (`claude mcp add-json --scope user`); ELU Code never writes that file.
That command takes the settings only on its command line, so for the second it runs, any
process on this computer that runs as you, a Full access session included, or as another
account that can list processes could read the key. What it prints back is shown with the
key taken out. A key counts wherever a server's settings hold one: a header, a variable, a
bearer token among its arguments, or its URL (a password before the `@`, a query value such
as `api_key=`, or a long path segment of letters and digits). A message from the message box
that holds a server config (an `mcpServers` block, or one server with only a server's
fields, such as a `url` or a `command`) is not sent, wherever it was written: ELU Code
offers to add the server, and the box keeps only your other words. So is a
`claude mcp add` or `claude mcp add-json` line, typed with `!` in front or without: it is
not run, since in an open session a command's line joins the chat the model reads, and
ELU Code offers to add the server instead. A config or line that holds a key is never sent
or run as it is; one without a key is sent, or run, if you press Enter on it again. Text
that looks like a server's settings with a key in it but does not read as one is never sent
either: take the key out, or use `/mcp add`. In an open session, a `!` command that holds a
key (a bearer token, an `Authorization` header, a `..._TOKEN=` value) is not run; with no
session open it runs, and its output shows only to you. Text you
paste into the message box still shows on your screen until you send it or clear it.

On Claude Code, the model of your sessions and each bot that works there also get your
Claude Code instructions and memory for the project folder, as Claude Code itself would
load them: `~/.claude/CLAUDE.md`, the folder's `CLAUDE.md`, and the notes in
`~/.claude/projects/<folder>/memory`. The two instruction files and the memory index go
into the prompt of a session's first turn; the notes are copied for each run into a
private folder in the system temporary directory, which the run may read, and removed when
it ends. A teammate's question gets none of them. The folder's `CLAUDE.md` comes with the
folder, and the approval step above does not cover it.

Hooks are inspected before editing. Configured hook folders in the task worktree are
protected, and a changed hook stops checks and publication. Publishing uses an absolute
private copy of the reviewed hooks. It runs the existing pre-push guards, including the
guard in Git's common directory; commit hooks are not run. Git preparation and staging do
not execute checkout or index hooks. Push guards run with a read-only worktree, private
temporary space, and network access denied. A hook that invokes edited source inherits
these same limits. The original hook files and Git configuration are unchanged. Git
attributes and submodules that could execute repository code are refused.

Terminal requests pin a hashed policy in private task state; scripted runs pin
configuration and commands to a base commit. A session's mode, place and folders live in
that private state, never in repository files, and changing the mode between turns changes
no policy.

## Credentials

Agents do not receive cloud or GitHub credentials from ELU Code's inherited environment.
Vendor authentication remains the vendor CLI's responsibility. ELU Code never signs you in.
It never reads Claude Code's sign-in, in the macOS Keychain or in its credentials file, and
it sends no request of its own with any vendor sign-in.

The Usage tab shows plan usage. Claude usage comes from the rate limit lines Claude Code
writes to its own output during a session that ELU Code runs. No request is made for it,
and until such a session has run, the tab says so.

Codex usage comes from Codex's own `app-server` command: ELU Code starts it and asks it for
your plan's rate limits, so the request with your Codex sign-in is made by Codex. It starts
in an empty private folder with MCP servers, hooks, apps, plugins and analytics turned off,
and no thread or turn is ever started. ELU Code asks for this check whenever `codex` is on
your PATH, including when you have it only for the check sandbox:

- when you open a project that is set up, unless another ELU Code window already has it
  open, and when you finish setting one up;
- when you start a session or send a message;
- every minute while a session, or the new session form, is on screen;
- when the Usage tab opens and its last check is more than two minutes old, and when you
  press `r` there.

Apart from `r`, a check asked for less than a minute after the last one is skipped.

What is saved, in `~/.config/elu-code`, is usage reduced to numbers and times
(`usage.json`), and the email and plan name of each account seen, with its last usage
(`accounts.json`). The Usage tab takes the Claude email, plan name and rate limit tier from
`~/.claude.json`. It decodes the Codex email and plan on your machine from the id token in
`auth.json` in the Codex home. No token from that file is sent, saved or shown.

## Checks and evidence

Check scripts and pre-push guards run inside Codex's OS sandbox (`codex sandbox`, or the
copy `ELU_CODE_SANDBOX_HELPER` names), with an empty Codex home of their own, so Codex must
be installed whatever vendor your sessions use, but need not be signed in. A check that
cannot start in the sandbox fails; it never retries without isolation. Runtime directories
needed by installed check programs are readable, not writable.

Checks have a fresh private temporary directory inside the task worktree. Shared system
temporary directories are denied. Ignored output is included in the evidence digest and
blocks completion because it would be absent from the commit. Build and test scripts must
not depend on unpublished generated files.

Missing project checks leave code unverified and cannot authorize publication. Source
edits after a check or review invalidate that evidence. Changing an allowed test to assert
less is still possible and must be caught in review.

## Output and secrets

Raw output can contain secrets. It remains in `.git/elu-code/` (or personal conversation
state before a folder has Git history), never in the PR evidence block. Review responses
get conservative pattern-based redaction, which cannot recognize all personal or business
information. Inspect the exact body before approving publication.

## What the tests prove

Compiler and fake-CLI tests establish ELU Code's behavior. Sandbox probes establish the
installed helper's boundaries. Actual agent enforcement requires live tests on the exact
vendor release, including commands launched by a test script, outside writes, synthetic
secret reads, network requests, protected edits, configured MCP servers, and cancellation.
A model choosing not to attempt an action is not proof that the vendor refused it.

Use a tested vendor release for sensitive repositories. Operating system updates, managed
settings, and vendor updates can change enforcement.

## Linux

A write outside the mounted files may land in a private, temporary filesystem without an
error. Sandbox probes and tests verify that the real files remain unchanged. Keep
repositories with push hooks outside shared `/tmp` and `/var/tmp` folders: the tested
helper cannot mount read-only hook inputs there.

## Antigravity and Grok Build

Antigravity CLI runs under a private HOME holding only ELU Code's settings and hook; its
rules and that hook were designed from Google's documentation, and the steps of its
one-time check, which ELU Code runs before your first message to it, are the only proof on
a given machine. Google's FAQ says that using third-party software to access Antigravity
violates its terms and can get the account suspended or terminated, and that wrapping
`agy` in other applications is not supported on consumer plans. ELU Code wraps it: using
it is the owner's decision, and the owner's account carries the risk. Antigravity's deny
rules and hook match command text: in Approve for me and Full access the never list is a
tripwire, not a boundary.

Grok Build runs with a private HOME and every documented Claude/Cursor compatibility,
telemetry and upload switch off; the `isolation` step of its one-time check is the only
proof on a given machine, and the vendor's own issue
[xai-org/grok-build-plugin-cc#34](https://github.com/xai-org/grok-build-plugin-cc/issues/34)
says some switches are ignored. Grok's deny rules match command text: in Approve for me
and Full access the never list is a tripwire, not a boundary.
