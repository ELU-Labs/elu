# Install

Back to the [README](../README.md).

The first run of `npx -y @elu-labs/elu` opens ELU and installs `elu` as a global
command: it prints the `npm install --global` line it runs, and uses `~/.local` when npm's
global folder cannot be written. To open ELU without installing anything, run
`ELU_NO_INSTALL=1 npx -y @elu-labs/elu`.

Run `npx -y @elu-labs/elu` from your home folder, not from inside a project you do not
trust: `npx` lets the folder it starts in decide what runs.

## What you need

You need macOS or Linux, Node 22 or newer, Git, and one vendor's command line installed and
signed in: Claude Code (`claude`), Codex (`codex`), Antigravity CLI (`agy`) or Grok Build
(`grok`). With more than one, choose with `/model`.

GitHub CLI (`gh`) is needed for draft pull requests, and for `@elu` to review and merge a
fix pull request.

## The vendors

Sessions run in the vendors' own unmodified command lines (Claude Code, Codex, Antigravity
and Grok Build), with your existing sign-in. ELU has no account and no telemetry, and
it never reads your Claude Code sign-in.

ELU starts the vendor command it finds first on your PATH, so one that another tool
wraps, such as a terminal app with its own `claude` or `codex` script ahead of the real
one, runs through that script in every mode. When a vendor's program does not start, the
chat says so, with what its command printed: check that the command runs in your terminal,
then type continue.

Antigravity (`agy`) and Grok Build (`grok`) are checked once on each machine, for each
release of them. The check proves what Read only, Ask for approval and Approve for me stand
on, so your first message to one in those modes starts it by itself and waits for it: eight
steps, each a short turn on that vendor. The chat says how many are done and how long it
has taken. Full access needs no check and never waits for one: the message runs at once,
and `/permissions full` during a check runs the waiting message at once too. The Usage tab
shows whether each is signed in, and `c` on its line runs the check there and then. Vendor
notes: [docs/vendors](vendors).

Google's FAQ says that using another app to reach Antigravity breaks its terms and can get
your account suspended or terminated. ELU wraps `agy`, so read
[docs/vendors/antigravity.md](vendors/antigravity.md) before you send it a message.

## The default model

New sessions start on the default model. A project's default is set with `/model default
<name>`, or in its settings: Projects, Enter, Default model. This computer's default, which
every project that has not chosen uses, is set with `/model computer <name>` or the This
computer row there. `none` in place of the name clears either. `/model computer auto`
starts the sessions you start on this computer with [Auto model](models.md): ELU then picks
the model for each step, from the models of the default model's vendor. With nothing chosen, the
default is the first vendor installed on this computer, in this order: Claude Code, Codex,
Antigravity CLI, Grok Build. So a computer that has only Grok Build runs every new session on
it, also one that a teammate's message, another computer or a schedule starts. A default
whose vendor is not installed here is not used, and ELU says so wherever it shows the
default. A bot whose vendor is not installed here runs on this computer's default, reviews
too: its row in the Bots tab says so. Where no vendor installed can review, an edit goes on
and the chat says `Not reviewed: no model on this computer can review.` A teammate's
question (the read-only kind) is answered by Claude Code only; without it, both sides read
why, and the owner can set `/access` to Auto so teammates' messages start sessions instead.
On Codex, Antigravity or Grok Build the question is refused with the read that vendor cannot
keep out (Codex and Grok Build read outside the shared project, and Antigravity reads its Git
folder and the files Git does not track) and how to choose Claude Code: `/model default` with a
Claude model.

## The sandbox for checks

ELU runs your project's checks and its pre-push hooks in a sandbox: Codex's (`codex
sandbox`, signed in or not) where Codex is installed, otherwise the computer's own,
bubblewrap on Linux and sandbox-exec on macOS, with the same limits. In Full access they
run as in your terminal, with no sandbox. Where a session needs one and the computer has
none, ELU says so before the work starts, with the step that fixes it. To use a copy of
Codex that is not on your PATH, set `ELU_CODE_SANDBOX_HELPER` to its absolute path. On
Ubuntu 24.04 bubblewrap starts only with the AppArmor profile in
[docs/permissions.md](permissions.md#linux). The Linux tests run with both.
