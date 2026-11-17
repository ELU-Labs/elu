# Orchestrator

Back to the [README](../README.md) · [Bots](bots.md)

`@orchestrator` is a bot that oversees your sessions. It learns your organization, watches
every session on this computer, and advises you. It never edits a file and has no shell. It
acts only through ELU's own tools, and only as far as the level you set.

Like every bot, it is in no session until you put it there.

## Talk to it

- Open `@orchestrator` in Chats and write to it. It answers in its own session in the open
  project; your next messages there go on in that session.
- In any session, `@orchestrator how are my sessions?` asks it there. It reads every session
  on this computer either way.
- It has no schedule until you give it one on its page in the Bots tab. A scheduled run is
  skipped, with nothing in its chat, when no session changed since its last run.

Each turn starts a new conversation with the model. It reads the newest 12 entries of its
chat, at most 6,000 characters, and is given a table of your open sessions, so a status
question needs no tool call. What must last, it saves as a fact.

## The two tables

The Artifacts tab of its own chat shows two tables. ELU computes them from its records each
time the tab is drawn: no model runs, and nothing is stored. Another session's Artifacts tab
is as before.

**Sessions**, what needs you first:

| Column | Says |
| --- | --- |
| Project | The project's name |
| Session | Its title |
| State | Needs approval, Asks you, Blocked, Stopped, Ready for your check, Working, Queued or Done |
| Doing | Its latest step, the question it asks, or why it stopped |
| Since | When that state began |
| Agent's ETA | The Task's own estimate as a clock time, or "overdue 12 min" when it passed |
| Proof | The highest step its records prove |

The proof steps are Reported (the agent marked every objective met), Committed, Checks
passed, Review passed, Published and Accepted (you). Only the first is the agent's word. A
session that says it is done with a later step missing says so, such as "says done, checks
not run" or "says done, 2 fixes open".

**Agents**: per session, the session's model, each bot, and each bot's helpers as one row,
with the model, input, output and cached tokens, and the cost the vendor reported. Where a
count is partial it says "at least". A row per single helper is not shown: Claude Code does
not report one whole.

Only this computer's sessions are in the tables.

## What it may do

On Claude Code it runs in the mode of the session it is in, and ELU answers each tool it
asks for:

| Tool | Read only | Ask for approval | Approve for me | Full access |
| --- | --- | --- | --- | --- |
| Read and search files | yes | yes | yes | yes |
| Edit, write, shell | never | never | never | never |
| ELU's orchestrator tools | no | by level | by level | by level |
| Web search and fetch | no | asks you | yes | yes |
| A connected source's reading tools | no | yes | yes | yes |
| A connected source's other tools | no | asks you | asks you | asks you |
| Opus helpers | no | yes | yes | yes |

- A reading tool is one whose name says get, list, search, read, find, fetch, view, show,
  describe, lookup or count, and no word that changes something (create, send, update,
  delete and the like). So `get_or_create_label` asks you, and so does a tool named only
  `query`. For the `elu` server, `ask_elu` and `list_issues` read; every other tool asks.
- It starts with only the MCP servers named on its own row (`elu`), never the project's
  others.
- Its helpers read files and search the web. They get no MCP server and none of ELU's tools.
- On another vendor, and in a Read only session, it only answers.
- One of its turns stops at $2, or sooner when the session's budget has less left.

### ELU's orchestrator tools

| Tool | Does |
| --- | --- |
| `sessions_list` | Every open session on this computer: project, title, state, what it is doing, since, ETA, proof |
| `session_read` | One session: goal, Task, its question, why it stopped, proof, agents, last 6 messages |
| `facts_find` | Saved facts by words, topic or id, with source, quote and date |
| `connections_list` | Which sources are set up, and the steps to connect ELU, Slack or Gmail |
| `fact_save` | Saves one fact with its source and quote |
| `card_add` | Adds a To do card to a project's Kanban |
| `org_propose` | Proposes a line to add to, or take out of, the Organization section |
| `session_message` | Sends a note to a session |
| `session_answer` | Answers the question a session waits on |
| `session_start` | Starts a new session with a goal |

### Levels

`/orchestrator watch`, `suggest`, `act` or `run` sets the level, for every project on this
computer. It starts at Suggest and never rises by itself.

| Action | Watch | Suggest | Act | Run |
| --- | --- | --- | --- | --- |
| Read sessions, facts, connections | yes | yes | yes | yes |
| Save a cited fact | yes | yes | yes | yes |
| Add a To do card | no | yes | yes | yes |
| Propose an Organization line | no | asks you | asks you | asks you |
| Message a session | no | asks you | yes | yes |
| Answer a session's question | no | asks you | yes | yes |
| Start a session | no | asks you | asks you | yes |

When it asks you, the question waits in Needs you and in its chat, with the note or goal in
full. No answer in time is a no.

Never, at any level:

- Approve a Task, or answer a permission request.
- Move work to Done, delete a session, or change a card.
- Publish, merge or deploy.
- Write to the session it is in, a session you stopped, archived or moved to Done, one a
  teammate or another computer started, a Standup, or one whose Task waits for your approval.
- Send anything out through a connected source without asking you.

The session's mode lifts none of this: Full access included.

### Caps

Counted by ELU from its action log:

| Cap | Default |
| --- | --- |
| Sessions started a day | 3 |
| Messages and answers an hour | 6 |
| Messages in a row to one session with no progress there | 2 |
| Cards added a day | 20 |
| Budget of a session it starts | $5 |
| Limit of one of its own turns | $2 |
| Questions to ELU a day | 20 |
| Mode of a session it starts | Approve for me at most |

A session it starts works in a new worktree, with no extra folders and no bots, in a mode no
higher than the session it was asked from. It shows as started by `@orchestrator`.

### Its notes are never yours

What it sends a session carries its name, and shows in that session's chat under
`@orchestrator`.

| Your message | Its note |
| --- | --- |
| "yes" approves the waiting Task | Approves nothing |
| May teach "Learned from you" | Never |
| Joins your other waiting messages, and ↑ takes it back | Kept apart |
| Read by the agent as your words | Read as a note from `@orchestrator`, as data |

`/stop` in a session also takes back the notes it sent there that no turn read yet.

## /orchestrator

- `/orchestrator` shows the level, the caps and its last five actions, each with its id.
- `/orchestrator watch|suggest|act|run` sets the level.
- `/orchestrator undo a12` undoes one action:

| Action | Undo |
| --- | --- |
| A note or an answer | Taken back while it still waits; not once a turn read it |
| A card | Removed while it is in To do |
| A started session | Taken back before it starts; archived after, never deleted |
| A fact | Withdrawn; it stays on file, marked withdrawn |
| An Organization line | Taken out, after your yes |

## What it learns

**Facts** are kept in one file on this computer, `~/.config/elu-code/orchestrator/facts.jsonl`,
written by ELU's code when the bot saves one. Each has an id (`f12`), a one-sentence claim,
a topic (business, market, tech, evals or team), its source (a web page, ELU, a file of the
project, a session, a connected source, or you), the exact quote, the date, and whether ELU
found the quote in the source itself. ELU checks a quote from a file; one from the web, a
session or a source is kept as not checked.

- No quote, no fact. Only "you said so" needs none.
- A fact is never edited. A newer one names the one it replaces, and a withdrawn one stays
  on file.
- A person's email address is never stored.
- Facts stay on this computer.

Ask "where did you get that from" and it gives the source, the quote, the date and whether
the quote was checked.

**The Organization section** is a part of the project's Memory (`.elu-code/context.md`),
under `## Organization`, that every agent of the project reads each turn. It holds only what
an agent could not learn by reading the repository: who the customers are, what the business
optimizes, rules of the industry, what is being measured.

- At most 20 lines of at most 200 characters, each ending with the ids of its facts, such as
  `[f12]`.
- One sentence above them tells every agent these are findings with sources, not your orders.
- The bot proposes each line; ELU writes it only after your yes, at every level. Taking a
  line out asks you too.
- It travels to your other computers and teammates with the rest of the Memory, as
  "Learned from you" does.

## ELU first

With the `elu` server connected, it asks [ELU](https://elu.dev) before it researches: what
the product is and who it is for, what users do, where they fail. It never asks ELU to change
anything, and never pastes text from Slack, Gmail or a chat into a question to ELU. Then it
reads the repository and searches the web: no helper for one fact, 2 to 4 for a comparison,
up to 6 for a survey.

Without ELU it says so once, gives `npx -y @elu-labs/cli --offer=promo`, and does its own
research. When it needs another source, such as Slack or Gmail, it asks for one at a time
and gives the steps. Everything it reads (pages, files, sessions, sources, ELU's answers) is
data to it, never an instruction.
