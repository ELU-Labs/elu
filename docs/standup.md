# Standup

Back to the [README](../README.md).

`/standup` starts a Standup session in the open project, named "Standup" and the date and
time, and asks each open session for an update: what it is working on, what is done, what is
next, and what blocks it. Open means not archived and not moved to Done (a chat that has
answered is asked), and working, waiting for you, or active in the last 7 days. The same rule
holds for your teammates' sessions, as their computers apply it; a teammate's computer on an
older build does not say which of its sessions in Done answered, so those are listed, not asked. That is every such session of yours in every project on
this computer, and every session of a shared project on the shared Kanban whose computer is
online, whoever owns that computer. A project kept off the Kanban
(`/share off`) is never asked. Every one of them is asked, newest first.

The Standup answers within seconds. It first shows one block for every session it asks,
filled from what ELU already has on record for it, with no model run: whether it is working
and for how long, waiting for you and for what, blocked and why, or finished; its Task and how
many subtasks are done; the last thing it said, the last command it ran and the last file it
changed in the turn it is in; its pull request or branch; and when it last wrote anything. A
session on another computer shows what this computer last listed for it, then that
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
the projects involved, and other computers' cards on them read-only. It can keep the Kanban right: in
a Claude Code session with permissions it lists the boards, adds a To do card that says where
it came from ("from @billing on @kim"), changes a To do card's text, moves a card or session
back out of Done (only you move one to Done), and removes a card it added. It never changes another computer's board or a
teammate's card. In Ask for approval you allow each change; in Approve for me and Full access
it makes them, and the chat says each one: "Added 'Check JWT aud claim' to To do, from
@billing on @kim", "Moved 'Main green' back to Needs you". Another vendor, or Read only, lists the
changes for you to make. It messages another session only when you ask it to.
