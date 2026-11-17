# Bots

Back to the [README](../README.md).

A bot is a model with a name and instructions. You write it once and use it in any session.
In a session a bot reviews each change, answers when you write `@name`, or does work of its
own.

Five come with the app. You can edit or remove any of them in the Bots tab.

| Bot | Runs on | What it does |
| --- | --- | --- |
| `@reviewer` | Claude, Opus | Reviews each change of a session you add it to, for correctness, security, performance and maintainability |
| `@lead` | Claude, Fable, with Opus helpers | When you write to it: plans the work, hands the pieces to helpers, and checks what they return |
| `@qa` | Claude, Opus | When you write to it: tests the change like a user, fixes what it finds, and verifies each fix |
| `@pair` | Codex, `gpt-6.1-sol`, high effort | A second model beside the working agent: says what it would challenge after each turn, and reviews each change |
| `@elu` | Claude, every hour | Finds issues in your live product with [ELU](https://elu.dev), then reviews and merges the fix pull request or writes the fix |

- A new session has no bots. `/bots add reviewer` adds one, and so does `@reviewer` alone
  and then Enter. With no bots, the checks alone decide whether a change is ready.
  `elu run` takes `--bot reviewer`.
- `@lead plan the refund change` gives a bot work. `@lead`, `@qa`, `@elu` and each bot you
  make do the work you write to them, within the session's permissions; `@reviewer` and
  `@pair` read and answer.
- After each edit, ELU runs the checks and every reviewing bot of the session reviews
  the change. Its must-fix findings go to the model, which fixes each one or disputes it with
  a reason; then the checks and the review run again, up to the policy's review rounds. The
  chat shows each step, such as `@reviewer: 2 must-fix`, `Fixed 2` and `@reviewer: Passed.`
  A bot whose model cannot take the change, not even its diff alone, says so in one line,
  and the session goes on without its review. It tries again once a fix changes the files.
  The model is told which bots review its change and that ELU runs the checks and
  publishing, so it never asks you to wait for a bot, review, commit, push or merge.
- Write to a reviewing bot about edits the session has not published, such as `@reviewer make
  sure the fixes are real, not nitpicks`, and it reviews them with your words, in that same
  loop. That holds when the session's own editing turn finished, it changed files and stopped
  after that (ready, blocked, not verified or waiting for you), and the bot is one of its
  reviewers. Edits you had in your checkout before the session started are not its own. The
  fixes are work on the session's approved Task: a Task that was done opens again for them
  and closes again when the review passes. The bot's must-fix findings stay within that Task;
  new work is at most a suggestion, and you ask the agent for it. A message that starts with
  `?`, or ends with `?` and asks for no work (fix, check, review, verify, work with or on, go
  through, look at, make sure), is a question: the bot answers it in the chat.
- After you write to a bot, your next messages in that session go to it too, until you name
  another bot or start a message with `@model`. The title of the message box names who gets
  the message, such as `Message @lead · @model writes to Opus 5.5`. In a session you wrote to
  a bot that works, such as `@lead`, everything else goes to it as well: your approval of its
  Task (`y` or in words), a new goal (from its Task, `/done` or `elu sessions goal`), `a` on
  its row, the turn after a bot reviews its edits, its standup answer and what is typed over
  it on another computer of the project. After `@model` the session is
  the model's until you name a bot again. A bot you stop picks up where it stopped on your next message when it runs on
  Claude Code or Grok Build; on the others its next turn starts from the chat. When it
  cannot pick up, a line in the chat says so and the turn starts from the chat.
- To make a bot, open the Bots tab, press `n` and answer its questions. Enter on a bot
  opens its page, where each row changes one thing: its model, its schedule, its MCP
  servers, its instructions. How a bot goes about its work is in its instructions: write
  there that it hands pieces to helpers, and on Claude Code it can start them.
- A bot whose model your Claude account has no usage credits for runs once more on the
  session's model, when that is another Claude model, and the chat says so in one line. Its later turns in that session start
  there.
- Each bot has a color: its name and its replies show in it. **Color** on its page changes
  it, and so does `/bots color qa gold`. `/bots color qa random` picks another.
- `@elu` starts when it joins a session and then runs there every hour. Once ELU is
  installed, it runs while ELU is closed too, through the login item that runs
  schedules. `/bots schedule off elu` stops that in one session. It needs ELU connected:
  `npx -y @elu-labs/cli --offer=promo` signs you up, or in, adds ELU to your web app and
  connects your AI tools.
