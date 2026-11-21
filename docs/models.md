# Models and Auto model

Back to the [README](../README.md).

Each session has its own model. `/model` lists the models this computer offers, `/model NAME`
gives one to the open session or to the session you are starting, and
[the default model](install.md#the-default-model) is what a new session starts on. Every
reply names the model and the effort that wrote it.

Each model offers the efforts its vendor lists for it, and `/agent change` and a bot's
Effort row offer those. Codex models go up to `ultra` where Codex lists it (`gpt-6.2-sol`
does, `gpt-6-luna` stops at `max`). Claude models go up to `max`.

Auto model is one more choice in that list. With it on, ELU picks the model for each step of
the session:

| You write | Step | Runs on |
| --- | --- | --- |
| A tough question | Plan | The top model |
| A simple lookup question | Quick question | A fast model, beside the session |
| "Implement it", once the Task is approved | Edit | The work model |
| An answer to what the work stopped to ask | Edit | The work model |
| "thanks" | none | The model that ran last |

No model is asked to decide. The step comes from what the session waits for, which ELU
knows for certain. When ELU is not sure a message is a simple lookup, it is not treated as
one: a wrong guess can cost money, never quality.

Before you turn it on: a turn can cost more than it does without it. A session otherwise
runs on one model at its vendor's own effort. Auto model plans on the top model and runs
plans and edits at `xhigh` unless you lower it. What it saves comes from quick answers, and
from edits that do not run on the top model.

## Turning it on and off

| Type | What it does |
| --- | --- |
| `/model auto` | Turns Auto model on for this session, or for the session you are starting |
| `/model auto fix the build` | The same, and sends the message |
| `/model auto on` | The same as `/model auto` |
| `/model auto off` | Turns it off. The session stays on the model it has |
| `/model auto high` | Sets the effort of its plans and edits on this computer: `low`, `medium`, `high`, `xhigh`, `max` or `ultra` |
| `/model auto quick grok` | Sets where quick questions go on this computer: `claude`, `codex`, `grok`, `home` or `off` |
| `/model computer auto` | New sessions you start on this computer begin with Auto model |
| `/model opus` | A model you pick wins: Auto model is off for this session |

- `auto` is the first row of the `/model` list and of the Model picker. When it is turned
  on, one line says which model takes which step: `Auto model is on. Plans: Fable 5.2 xhigh ·
  Edits: Opus 5.5 xhigh · Quick questions: Grok Build`. In an open session the chat keeps
  that line.
- While it is on, the message box reads `Message Auto model`, the new session form shows
  `Auto model` in its Model row, and each reply's header still names the model and effort
  that wrote it. No line is written when the model changes from one step to the next.
- A model or an effort you pick for the session turns it off, the model it runs on now
  included: `/model NAME`, the Model picker, `/agent change @model`, or the page a click on
  a reply's heading opens. The chat says so: `Model of this session: Opus 5.5. Auto model is
  off.` A bot's model or effort is its own, and changing it leaves Auto model on.
- `/model computer auto` is for sessions you start yourself on this computer, and needs
  Claude Code or Codex installed here. `/model computer NAME` and `/model computer none`
  take it away again, and a model you pick in the new session form takes it away for that
  session. A project's default is always a model: `/model default auto` says where Auto
  model is set.
- The word `auto` names no model. A model saved by that name is typed with its vendor in
  front: `vendor:auto`.

## The step of a message

Only a message you typed on this computer picks a step.

| When your message arrives | Step | Runs on |
| --- | --- | --- |
| It starts a new session | Plan | Top |
| No Task is open | Plan | Top |
| A Task waits for approval, and you write anything but a plain yes | Plan | Top |
| A plain yes to a waiting Task, or its approval by key | Edit | Work |
| The approved Task's work is starting, going on, or stopped on a question, a block or your stop | Edit | Work |
| The work ended and you ask for something new | Plan | Top |
| "ok", "thanks" or "got it" with nothing waiting | none | The model that ran last |
| A simple lookup question, with the session idle and not waiting on you | Quick question | Fast |

The work has ended when every objective of the [Task](tasks.md) is reported met. A message
then is a new ask, so the top model plans it.

The top model and the work model each keep a conversation of their own in the session, and
each resumes only its own. A model that takes its turn is handed what the other one replied
since its own last turn. Your messages and the Task are given on every turn. So a change of
model reads nothing again.

## The models it picks

| Class | Claude Code | Codex | Antigravity CLI | Grok Build |
| --- | --- | --- | --- | --- |
| Top | Fable | GPT Astra, the newest it lists | none | none |
| Work | Opus | GPT Sol, the newest it lists | none | none |
| Fast | Haiku | GPT Luna, the newest it lists | none | Its default model |

Plans and edits never leave the session's own vendor, so the session keeps that vendor's
limits on what it may do. A session on Claude Code can have Auto model. One on Codex can
when Codex lists a top and a work model on this computer. One on Antigravity CLI or Grok
Build cannot: `Auto model needs Claude Code or Codex for this session.`

One effort serves plans and edits: `xhigh` until you change it with `/model auto high`. A
model that does not offer that effort runs at the highest one it offers below it: `ultra`
runs as `max` on Claude. The fast model runs at its own effort. Your own effort for the session is not touched, and it
is back when Auto model is off.

A bot runs on its own model, as before. Where a bot that works does the session's work, the
line reads `Edits: @lead`.

## Quick questions

A message is a quick question only when all of this holds:

- You typed it in a session that already has a reply, and no turn is working.
- The session does not wait on you: it asked nothing, no Task waits for approval, and no
  work is stopped.
- It is not written to a bot or to `@model`.
- It is plain English letters in one paragraph of at most 120 characters.
- It starts with one of: what is, what's, what are, what does, where is, where are, which
  file, which command, how do I, how to.
- It does not speak to the model: no you, your or please.
- It has no word that asks for a judgment or for work, such as why, cause, reason, problem,
  wrong, fail, error, bug, fix, safe, correct, better, risk, should, compare, tradeoff,
  impact, approach, priority, design, plan, review, think, mean, revert, migrate or handle,
  and no phrase such as what if or the source of.
- It has no word that points into the conversation or at the state of the work, such as
  this, it, here, we, now, left, next, status, progress, done or step. Only the session's own
  model knows what such a word points at. `that` counts too, right after the opening words
  or at the end: "what is that?".

| Message | Quick |
| --- | --- |
| how do I run the tests? | yes |
| where is the build script? | yes |
| what does the add command do? | yes |
| where is the function that parses the config? | yes |
| is this safe to merge? | no |
| what's the root cause? | no |
| what is left? | no |
| how do I roll this back? | no |
| what is the reason the CI is red? | no |
| can you make the retry count configurable? | no |

Where it goes, the first that applies:

| Order | Where |
| --- | --- |
| 1 | The vendor you set with `/model auto quick`, when it is ready |
| 2 | With no vendor set: Grok Build, when it is installed, signed in and past its one-time check |
| 3 | The fast model of the session's own vendor |
| 4 | Nowhere: the message is not quick, and goes by its step |

A vendor you set never falls through to a second vendor you did not name: when it is not
ready, the session's own vendor answers. `/model auto quick home` keeps quick questions on
the session's own vendor, so nothing of the project goes to a second vendor.
`/model auto quick off` turns them off.

The quick run reads files and nothing else: no shell, no network, no MCP servers, no
memory, in every mode. It is given the recent chat, the Task, and the project's
instructions and Memory. It never starts a vendor's one-time check. It starts only while
the session's [budget](usage.md#spending-limits) holds, and what it costs is its own row in
Usage: `Quick answers` and the session's name. On Grok Build the read-only run does not
keep reads inside the project folder as Claude Code's does.

Its answer says who wrote it: `Grok Build · quick answer`. When the fast model says the
message asks for more, cannot answer from what it has, fails or takes too long, the top
model takes the message: `Fable 5.2 answers this one: it needs more than a quick answer.` A
vendor that failed is passed over for 15 minutes, for an hour after a limit, and after a
failed sign-in until you sign in again, a day at most. If a quick answer is not enough, type
`think`: the same question goes to the top model.

If ELU ends while a quick answer is being written, the chat says `The quick answer was cut
off. Send your question again.`

A quick question typed while a turn works is answered by that turn, as any message is.

## At a limit

| Case | What happens |
| --- | --- |
| The top model is at its own limit | The work model answers, and one line says until when: `Fable 5.2 is at its limit until Thu 6:00 PM, so Opus 5.5 answers until then.` |
| The top model is not on your plan | The work model answers in this session, and one line says so |
| The work model is at its own limit and the top model is free | The top model edits, and one line says so |
| The limit is met in the middle of a turn | The turn stops, then starts again at once on the other model |
| The account's own limit | As without Auto model: another account, a wait, or a stop. See [Usage](usage.md) |

With [several Claude accounts](usage.md#several-claude-accounts) that switch by themselves,
another account is tried first. The other model is used only when no account has the model
left. ELU reads no limit of a single Codex model, so a Codex session behaves at a limit as
it does without Auto model.

## Turns you did not type

| Turn | Model |
| --- | --- |
| Keep going, a long job that ended, carry on, a retry after a stall or a limit | The model the session ran last |
| The retry key | The model the failed turn ran on |
| A schedule's run, a teammate's message, a message from your other computer | The model the session ran last |
| A note or an answer of `@orchestrator` to the session | The model the session ran last |
| A bot's turn, a review | The bot's own model |
| A new session you did not type: a schedule, a teammate, another computer, `@orchestrator` | Starts with Auto model off |

A new goal you type in the Done check is your own message: it picks a step like any other.

A session on another computer is that computer's: `/model auto` over it says `Auto model is
set on the computer that runs the session.` A schedule runs on one model.

After an update, `/model auto` works once the sessions that were running have ended. Until
then ELU says it still runs them on the build from before the update.

## Where it is kept

| What | Where |
| --- | --- |
| On or off, for a session | The session's record. Its saved model is always a real one, so your other computers read it as before |
| The effort, where quick questions go, and whether new sessions begin with it | `auto-model.json` in your personal folder, for this computer |
