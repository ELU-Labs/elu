# Orchestrator

Back to the [README](../README.md) · [Bots](bots.md)

`@orchestrator` is a bot that oversees your sessions. It learns your organization, watches
every session of your projects, on this computer and on the other computers on them (your
devbox, a teammate's computer on a shared project), and advises you. It never edits a file and has no shell. It
acts only through ELU's own tools, and only as far as the level you set.

Like every bot, it is in no session until you put it there.

## Talk to it

- Open `@orchestrator` in Chats and write to it. It answers in its own session in the open
  project; your next messages there go on in that session.
- In any session, `@orchestrator how are my sessions?` asks it there. It reads every session
  on this computer, and every session the other computers of your projects list here, either way.
- It has no schedule until you give it one on its page in the Bots tab. A scheduled run is
  skipped, with nothing in its chat, when no session changed since its last run.
- Only you write to it, on the computer it runs on. A teammate's computer, or another
  computer of yours, is answered `Only the owner writes to @orchestrator, on the computer it
  runs on.` So is a session started from another computer with it among the bots, and a copy
  from there of a session it is in.
- It never runs in a session another computer or a teammate started, or in one that helps a
  session on your other computer, when you write to it there or on its schedule.
- Its chat stays on this computer: it is not listed, shown or followed from another one, and
  neither is what it replies in a session or what it asks you. It is no card, Task or status
  row for a teammate, and its turn in a session is named nowhere there. A note it sent a
  session shows there under its name.
- What it says in a session, that session's agents read. What they write afterwards shows
  wherever the session shows.
- No Standup asks its chat, and no Standup's record of a session holds what it said or
  asked there.
- All of this holds after you rename it or remove it: a chat keeps the name its bot had,
  and ELU keeps every name a bot that oversees has had. A bot you make later under one of
  those names is treated the same way on other computers.
- Its turn teaches "Learned from you" nothing, and archiving its chat with lessons saves
  none from it. What it learns is a fact, or an Organization line you say yes to.

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
with the model, the input and output tokens, the tokens read from the cache, and the cost:
the vendor's figure, or ELU's from list prices where the vendor gives none. A row per single
helper is not shown: Claude Code does not report one whole.

| Mark | Means |
| --- | --- |
| `≥` before a cost | At least that |
| `≤` before a count | At most that: a bot's helpers on its own model |
| `in @name` | That cost is counted in that bot's own row |

Only this computer's sessions are in the tables. The bot is also given the sessions of the
other computers, one line each, as those computers listed them here. A session whose proof ELU has not checked
yet shows none until a later draw. The table the bot is given reads a session's proof again
only when that session's records change.

## What it may do

On Claude Code it runs in the mode of the session it is in, and ELU answers each tool it
asks for:

| Tool | Read only | Ask for approval | Approve for me | Full access |
| --- | --- | --- | --- | --- |
| Read and search files | yes | yes | yes | yes |
| Edit, write, shell | never | never | never | never |
| ELU's orchestrator tools | no | by level | by level | by level |
| Web search | no | asks you | yes | yes |
| Web fetch of a plain address | no | asks you | yes | yes |
| Web fetch of any other address | no | asks you | asks you | asks you |
| A connected source's reading tools | no | yes | yes | yes |
| A connected source's other tools | no | asks you | asks you | asks you |
| Opus helpers | no | yes | yes | yes |

- A reading tool is one whose name starts with get, list, search, read, find, fetch, view,
  show, describe, lookup or count, after the server's own name, and holds no word that can
  name a change, a send, a spend or a run (create, send, update, delete, replace, append,
  order, query and the like), even as a noun or inside a longer word. So
  `get_or_create_label`, `find_and_replace_doc`, `get_order` and `append_to_list` ask you,
  and so does a tool named only `query`. For the `elu` server, `ask_elu` and `list_issues`
  read; every other tool asks.
- After `and`, `or`, `then` or `plus` in a name, only another reading word or a common kind of
  thing reads: `get_and_list_items` and `get_cost_and_usage` read, `get_and_unarchive` asks,
  and so does `list_tables_and_columns`. A reading tool handed a method other than GET asks too.
- The list of changes is not complete. A name whose first word reads and whose other words
  are on neither list reads (`get_sign`).
- Some tools that only read still ask you, such as `pods_list` or `get_tag`, because of
  their name. Nothing runs without your yes.
- A plain address is `http` or `https` with no query (`?`), no fragment (`#`) and no sign-in.
  Any other address could carry out what the bot read, so it asks you in every mode. A
  reading tool asks you too when anything it is handed holds such an address, with or
  without `http://` in front. An email address does not count.
- Above Ask for approval, what it puts in the path of a plain address, or in the words of a
  search, goes out without a question. Keep its session in Ask for approval when that
  matters.
- It starts with only the MCP servers named on its own row (`elu`), never the project's
  others.
- Its helpers read files and search the web. They get no MCP server and none of ELU's tools.
- On another vendor, and in a Read only session, it only answers.
- One of its turns stops at $2, or sooner when the session's budget has less left.

### ELU's orchestrator tools

| Tool | Does |
| --- | --- |
| `sessions_list` | Every open session on this computer: project, title, state, what it is doing, since, ETA, proof. Then every session the other computers of your projects listed here, named `shop on @devbox #27` |
| `session_read` | One session, here or on another computer (`computer`): goal, Task, its question, why it stopped, proof, agents, last 6 messages. One that nothing here follows yet is followed first |
| `facts_find` | Saved facts by words, topic or id, with source, quote and date |
| `connections_list` | Which sources are set up, and the steps to connect ELU, Slack or Gmail |
| `fact_save` | Saves one fact with its source and quote |
| `card_add` | Adds a To do card to a project's Kanban |
| `org_propose` | Proposes a line to add to, or take out of, the Organization section |
| `session_message` | Sends a note to a session, here or on another computer |
| `session_answer` | Answers the question a session waits on, here or on another computer |

A note or an answer to a session on another computer always asks you first, at every level
that allows one: it leaves this computer, and ELU cannot tell your own computer from a
teammate's. That computer takes it as a note of its own `@orchestrator` (the bot that oversees
the sessions there), never as your words, and holds it to the same rules: no note to a session
a teammate started, one you stopped, archived or moved to Done, a Standup, a bot's chat, or one
whose Task waits for your approval, and an answer only while the session still asks that
question. A computer whose ELU is too old to keep that mark gets nothing, and the bot is told
`Update ELU on @devbox so the bot that oversees your sessions can write to its sessions from here.`
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

A note or an answer to a session in Full access asks you first, at every level. One sent
before you set the session to Full access is not given when its turn comes, unless you said
yes to it yourself.

When it asks you, the question waits in Needs you and in its chat, with the exact text ELU
will write, send or start in full. No answer in time is a no. Text over 20,000 characters is
never asked about.

After your yes, ELU checks that what you were asked about still holds: the same
Organization line, by its words, and the same question in the session. If not, nothing is
done and the bot asks again. An answer goes in only while the session still asks the
question it was written for. Only such an answer carries on work that stopped on its
question. A note is answered as a note: the work waits for you, and the reply ends with
`A note from @orchestrator does not carry the work on. It waits for you.`

Never, at any level:

- Approve a Task, or answer a permission request.
- Move work to Done, delete a session, or change a card.
- Publish, merge or deploy.
- Write to the session it is in, a session you stopped, archived or moved to Done, one a
  teammate or another computer started, a Standup, or one whose Task waits for your approval.
- Send anything out through a connected source without asking you.

The session's mode lifts none of this: Full access included. Full access never answers a
question it asks, also after it is renamed or removed while that question waits.

### Caps

Counted by ELU from its action log. When the log cannot be written, the bot does nothing
but read. Setting the clock back resets no cap.

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
| Picks a step of [Auto model](models.md) | Picks none: the turn runs on the model the session ran last |

`/stop` in a session, archiving it or checking it Done also takes back the notes and answers
it sent there that no turn read yet. One that reaches an archived or Done session is not
given.

An older ELU does not know these notes. If you go back to one while a note still waits, it
runs as your own message: `/stop` the session first.

A session it starts never begins with Auto model.

No turn its note leads to has ELU's own commands (`elu sessions`, `elu schedules`,
`elu jobs`), and neither has a session it started, until you write there. Until then that
session's Task waits for your yes in every mode, also when a working bot you added there
proposes it on its schedule. If such a turn runs your own `elu` instead, it asks you each
time, in every mode, and no rule of yours answers it.

## /orchestrator

- `/orchestrator` shows the level, the caps and its last five actions, each with its id.
- `/orchestrator watch|suggest|act|run` sets the level.
- `/orchestrator undo a12` undoes one action:

| Action | Undo |
| --- | --- |
| A note or an answer | Taken back while it still waits; not once a turn read it |
| A card | Removed while it is in To do |
| A started session | Taken back before it starts; archived after, never deleted. Never a session you started yourself: when ELU cannot tell which session it became, it says so |
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
- A person's email address is never stored, also when it is escaped or spelled out, such as
  `name [at] example [dot] com`, `name at example dot com`, `name @ example.com` or
  `name&#64;example.com`.
- A key or a token in a source's address or reference is refused.
- Facts stay on this computer. A note to another computer's session carries only its own words,
  after your yes.

Ask "where did you get that from" and it gives the source, the quote, the date and whether
the quote was checked.

**The Organization section** is a part of the project's Memory (`.elu-code/context.md`),
under `## Organization`, that every agent of the project reads each turn. It holds only what
an agent could not learn by reading the repository: who the customers are, what the business
optimizes, rules of the industry, what is being measured.

- At most 20 lines of at most 200 characters, each ending with the ids of its facts, such as
  `[f12]`. On a computer with a peer key the id also names the computer that keeps the fact:
  `[f12@1a2b3c4d]`. A line written before the computer had a key keeps `[f12]` there, and
  goes to your other computers with the longer id.
- One sentence above them tells every agent these are findings with sources, not your orders.
- Each line is a `- ` list item that ends with its fact ids. The first line below them that
  is not one ends the section, so what you write there, a list of your own too, stays your
  own text.
- The bot proposes each line; ELU writes it only after your yes, at every level. Taking a
  line out asks you too.
- It travels to your other computers and teammates with the rest of the Memory, as
  "Learned from you" does. Lines from another computer join only while the section has
  room; ELU says once how many were not added. A line you take out on one computer stays
  out on the others.
- A fact stays on the computer that saved it. Asked about a line that came from another
  computer, the bot says where its fact is kept, and never cites a fact of this computer
  for it.

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
