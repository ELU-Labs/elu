# ELU

A full-screen terminal app that runs coding sessions on the AI command lines you already
use, with bots that review and do work, and teammates you can ask.

One message starts a session: ELU plans the change as a Task, you approve it, the agent works in its own Git worktree, ELU runs your project's checks, and the reply shows.

![In the ELU terminal app, one message starts a session: ELU plans it as a Task, the agent works in its own Git worktree, the project's checks run, and the reply shows.](docs/media/sessions.svg)

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
[its page](docs/vendors/antigravity.md) first. More in [Install](docs/install.md).

## Start

```sh
elu
```

The first start asks for a project name; later starts open your last project. Type a
message and press Enter. That starts a session: the model answers, or edits in a new Git
worktree on its own branch.

## Features

### Tasks

Ask for a change and the first reply is a Task: its goal, its objectives and its success criteria, with a checklist of subtasks once the work starts. Approve it, and where keep going is on (`/keepgoing on` turns it on) ELU starts the session again by itself until every objective is met.

![A Task in the ELU terminal app: a card with a goal and two objectives is approved with y, the session works, and ELU starts it again until both objectives are met.](docs/media/task.svg)

### Replies while it works

Write to a session while it works: the turn reads your message at its next step, and its answer shows at once under your message, with a line such as `Read 12:45 PM · answered 12:46 PM.` The turn keeps working.

![A message written to a session of the ELU terminal app that is still working: the line under it changes to Read, then answered, and the answer shows under it while the turn keeps working.](docs/media/reply.svg)

### Bots

Add a bot to a session: `@reviewer` reviews each change under its own name, and the agent fixes what it finds. Another bot, `@lead`, plans the work and hands the pieces to helpers.

![A bot in an ELU session: @reviewer is added to a new session, reviews the agent's change under its own name, asks for one fix, and passes the change once it is fixed.](docs/media/bots.svg)

### Models and agents

Change the model, the vendor or the effort in the middle of a session: `/model` picks another model and the next reply comes from it, in the same chat; `/agent change` sets a model's effort.

![Changing the model in the middle of an ELU session: /model lists the models, the session changes from Opus to Sonnet, the next reply comes from Sonnet, and /agent change sets its effort to high.](docs/media/agents.svg)

### Long jobs

Work that takes longer than a turn runs as a job. The turn ends, the job keeps running, and when it ends ELU starts the session again by itself.

![A long job in ELU: the agent starts a long test run as a job and ends its turn, the job keeps running, and when it ends ELU starts the session again by itself and the agent reports the result.](docs/media/jobs.svg)

### Artifacts

A Task can name numbers to track. The session's Artifacts tab shows them as charts and tables, and the session fills them in while it works.

![The Artifacts tab of a session in the ELU terminal app: a chart of tests passing by run starts empty and fills in while the session works, until it reaches the target.](docs/media/artifacts.svg)

### Usage

The Usage tab lists your vendor accounts, with how much of each limit is used and how much time is left.

![The ELU Usage tab lists made-up Claude and Codex accounts, each limit as a bar with the percent used and the time left, and a folded account is opened to show all its limits.](docs/media/usage.svg)

### Your computers and your team

Share a project with your other computers and your teammates. Every computer on it sees the project's sessions and can write to them, and the computer that runs a session answers. They also share one Kanban board.

![Two computers on one shared ELU project: a session ana starts on her laptop shows on ben's desk computer, ben writes to it from there, and the laptop's agent answers on both.](docs/media/team.svg)

### Publishing

Nothing is pushed until you type `/publish`, read the exact push and confirm; then ELU pushes the branch and opens a draft pull request. `/permissions` sets what a session may do without asking; only Full access lets it push by itself.

![In the ELU terminal app, /publish shows the exact push and asks before it pushes the branch and opens a draft pull request, and /permissions sets what a session may do without asking.](docs/media/publish.svg)

## More

- [Install](docs/install.md): what you need, the vendors, the default model, the sandbox for checks.
- [Sessions](docs/sessions.md): the tabs, the chat, messages while a session works, worktrees.
- [Tasks](docs/tasks.md): what a Task holds, approving it, its card on the Kanban.
- [Commands and keys](docs/commands.md): the commands, schedules, `elu` from a shell or a session, the keys.
- [Long jobs](docs/jobs.md): jobs that outlive a turn, and keep going.
- [Permissions](docs/permissions.md): the modes, approvals, rules, MCP servers, the never list.
- [Bots](docs/bots.md): the five that come with the app, and making your own.
- [Teammates](docs/teammates.md): teams, invites, shared projects, your own computers. The wire format is in [docs/peer-network.md](docs/peer-network.md).
- [Standup](docs/standup.md): an update from every open session.
- [Usage](docs/usage.md): accounts, limits, costs, `/budget`.
- [Vendors](docs/vendors): Claude Code, Codex, Antigravity and Grok Build.
- [Security](SECURITY.md): what is trusted, and what an agent may do.

## Update and remove

Quit ELU with `/quit` in every terminal it is open in, then run `elu update`. To remove
ELU, follow [Update and remove](docs/update.md): it says what to stop first and what stays.

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
