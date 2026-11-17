# Usage

Back to the [README](../README.md).

The Usage tab lists the vendor command lines ELU found and whether each is signed in.
Finding that out runs each of them, and one that is slow to answer can take half a minute:
the tab says `Reading what is installed and signed in here…` meanwhile and every key works.
It keeps several Claude Code or Codex accounts signed in at once, so when one runs out of its
limit you switch instead of signing in again: `a` adds an account with the vendor's own
sign-in, Enter on an account makes new turns use it, and `x` forgets one. Claude accounts
also switch by themselves ([below](#several-claude-accounts)). Each account names its plan,
and each of its limits has a line under it: a bar, the percent used and the time left until
it starts again, for its five hours, its week and a model's own week (`Fable`). An account
whose tightest limit is tight (75% used) or FULL, and that is not the one in use, is one line
with that limit; `f` unfolds it, and folds an open one. The tab's first line counts the
accounts: free, tight, FULL and with no reading. The account in use is in its own colour and
says active ([how accounts are kept](../SECURITY.md#several-accounts)).

## Several Claude accounts

With two or more Claude accounts in the Usage tab, Claude work moves between them by itself.
When the account in use reaches 98% of its five-hour or weekly limit, or Anthropic refuses it
for one, the turn goes on, on the next account with room: first in your order (`u` on an
account moves it up), then the one whose week resets soonest. The chat says so in one line,
such as `Moved to b@example.com: a@example.com reached its weekly limit.`, and the status
line says it once. A per-minute slowdown is waited out on the same account.

When every account is at its limit, the session names the one that resets first and when.
Your message waits, with any you type meanwhile, and goes on by itself then, or as soon as
you pick, add or sign in an account again. A teammate's message or a bot's scheduled turn
only says when. Enter on an account still makes new turns use it.

An account whose sign-in ended and could not be renewed shows `sign in again` in Usage and
is skipped. ELU reads it again each minute and uses it once its sign-in works.

Under the Claude accounts, `Switch accounts by itself` turns this off (it is on), and `Use
paid extra usage` lets an account at its limit go on with extra usage you pay for (it is
off). Codex and the other vendors switch only when you pick an account. How ELU uses the
sign-ins: [SECURITY.md](../SECURITY.md#claude-account-switching).

## Plan usage and costs

The Usage tab shows Claude plan usage from what
Claude Code reports during your sessions. For Codex plan usage, ELU starts Codex's own
`app-server`, which asks with your Codex sign-in, whenever `codex` is installed: when you
open a project that is set up or send a message, at most once a minute while a session is
on screen, and from the Usage tab ([what is read and when](../SECURITY.md#credentials)).
Its top agents add up what each run spent: the cost Claude Code reports (the API price, also
on a subscription), and the tokens Codex, Grok Build and Antigravity report, at the model's
API list price. Codex reports what its thread has used so far, so a session that goes on in
the same thread counts each run's own share once. So does an Antigravity conversation whose
turn count shows each run reporting the conversation so far.
A Codex request whose prompt is over the model's long-context size is priced at that rate;
the other vendors' runs are priced from their totals, which do not say how big each request
was, at the short rate. A cost that may be too low shows as at least that (≥$1.20): a run whose prompts add up
past the model's long-context size, one whose count leaves some calls out (a Grok Build
compaction, Codex's reviewer in Approve for me), an Antigravity run whose total leaves its
thinking out, and a total with an unknown cost in it. A run
whose cost is not known shows a dash, never 0, and so does one known only to be at least
an amount under a cent; a known cost under a cent shows as <$0.01. A turn you
stop counts with the tokens it had used; Claude Code says a cost only when a turn ends.

## Spending limits

`/budget` counts the same costs. A run whose cost is not known counts as all of the limit,
so nothing more runs until `/budget off`; one that ELU 0.1.25 or earlier ran counts as it did
there. A Codex run that failed before Codex recorded a request of it cost at least nothing: it shows a dash, and does not count as all of the limit. A run that never started spent nothing. A turn starts only while some of the limit is left.
Claude Code stops itself at the limit. ELU stops a Codex turn that runs through its
`app-server`, a Grok Build turn that streams, and a turn over ACP whose vendor sends its cost,
when what it has spent reaches the limit, as soon as the turn shows it goes on: a turn whose
last response reaches it keeps its answer. A Grok Build turn on Grok's own model is priced at
the model its session's record names; while it names none, it is checked between turns. Where
the vendor says nothing about usage while it works (Codex exec, Grok Build's json output, headless Antigravity), the limit is checked
between turns, so one turn can go over it.
