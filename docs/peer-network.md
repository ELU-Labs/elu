# Peer network

How two ELU installs find each other, what they send, and how a team keeps its list of
members. This page is also the A2A custom binding document (A2A v1.0.1 §12 requires one for a
custom binding). The commands a person types are in the [README](../README.md#teammates).

## What it does

1. Your agents talk to your teammates' agents, machine to machine, with no company server.
   - **ask:** a message to a teammate. It always reaches them; what it does on their machine is their setting for the team (see [What teammates can do here](#what-teammates-can-do-here)).
   - **ask a bot:** a question to one teammate can name a bot they share. That bot answers it in place of their model.
   - **review:** a diff sent for a read-only review.
   - **pictures:** a message you type to a teammate or a channel takes along the pictures it names. See [Pictures](#pictures).
   - **handoff:** a goal for their machine, handled like any other message.
   - **status and overlap:** teammates see each other's live agents and get a warning when two agents edit the same file.
   - Agents can draft asks themselves. A draft is sent only when you approve it, or automatically to teammates you set to auto.
2. A2A v1.0 data model end to end. A local A2A JSON-RPC endpoint on 127.0.0.1, off by default, lets other A2A tools reach your agent and, through it, your teammates.
3. Sessions shows peer items that need you. **Chats** shows channels, teammates, their agents and threads.

Not supported:

- One device per person; no multi-device.
- Offline catch-up only through the sender's outbox, with no always-on mirror.
- Handoffs are text goals, not patches.
- Only pictures travel with a message to a teammate (PNG, JPEG, GIF, WebP). Other files go only to a session on another computer of yours (see [Files](#files)).
- No Windows support.
- A share grants the whole repository (tracked files minus sensitive ones), not per-path globs.

## Layers

```
identity    ed25519 key per install (Node crypto), shown as hex + 8-char fingerprint
roster      per team: signed append-only log of create/admit/remove/role/relays/leave/channel ops
discovery   each daemon announces its own key on HyperDHT; teammates are dialled by key
transport   Hyperswarm (Noise IK, UDP holepunch) -> blind relay you run -> outbox retry
binding     newline-delimited JSON-RPC 2.0 over the Noise stream (this document)
messages    A2A v1.0 Message/Task/Artifact + extension urn:elu-code:a2a-ext:peer:v1
channels    team: pairwise A2A tasks + status notifications
conductor   peer daemon <-> conductor through files only (requests, outbox, commands)
```

There is no ELU server anywhere, and no on or off. The daemon runs while this machine is an active member of at least one team, or has left one without any teammate hearing it yet:

- Nothing starts on a machine that never made or joined a team, and it makes no peer connection.
- `/invite`, `elu team create` and `elu invite` start it once the team exists; `/join` and `elu join` start it for the join, through a `join` command it reads when it starts. The app starts it when it opens on a machine on a team, and again within a minute when it stops. It is a detached process, so it keeps running when the app closes.
- `/leave` and `elu team leave` take this machine off a team. Leaving the last one once a teammate has the leave, or hearing that an admin removed this machine from it (`/remove`, `elu team remove`), stops the daemon at once. A leave no teammate has heard keeps it running until one has (see [Leaving and removing](#roster)), and the app starts it for that as it opens. Otherwise, with no team, no join and no command under way for 60 seconds (a join that failed, say), it stops by itself. `peer --daemon` started with no team, no unheard leave and no command waiting, by a login service say, exits before it connects.
- A daemon of another version left running on a machine on no team (0.1.5 started one before a join, which may have failed) is stopped when the app opens, and by `elu peers` and the `elu` commands that need a team.
- `elu peer uninstall` and `elu uninstall` stop it, but only until the app opens or an `elu` peer command runs while the machine is still on a team.
- An `enabled` field in `settings.json`, written by 0.1.5 and earlier, is ignored.

Defaults that touch third parties:

- the HyperDHT bootstrap nodes. HyperDHT's own public nodes are used unless `bootstrap` in `peer/settings.json` names others; the routing table is cached after the first join.
- other HyperDHT nodes. Announcing the key and dialling a teammate send requests to DHT nodes that anyone may run, and they see this machine's IP address and port.
  - The daemon's own DHT node is ephemeral: it is never added to other nodes' routing tables, so strangers' lookups, announcements and connections are not routed through it, however long it runs.
  - A relay you run keeps HyperDHT's default instead: on a reachable server it can join other nodes' routing tables after about 20 minutes and route lookups for anyone.

## Binding: `urn:elu-code:a2a-binding:hyperswarm-ndjson:v1`

- **Transport.** A Hyperswarm connection. Noise IK authenticates both device keys. Each side `listen()`s on its own key pair, and a teammate is dialled with `swarm.joinPeer(key)`.
- **Framing.** One UTF-8 JSON object per line; a frame may be at most 1 MiB. A larger frame closes the connection.
- **JSON-RPC 2.0, both directions.** Either side may send requests; responses are matched by `id`. Notifications have no `id`. Requests time out after 30 s.
- **First frame.** Each side's first frame must be `elu.hello` with params `{binding, a2aVersion: "1.0", name, teams: [{id, seq, head, ops}], handles, plans}`. `plans: true` says this build reads [Tasks](#tasks); a build that does not know a field ignores it. With no valid hello within 5 s, the connection closes.
  - The hello is written for the receiver's key, which Noise has proved before the first frame. `teams` lists only the sender's teams that this key is an active member of in the sender's log. `name` is the sender's display name when `teams` lists one, and empty otherwise.
  - `ops` (at most 8 per team) are the roster ops that admit the sender, so a teammate admitted elsewhere can prove it. They are merged only for a key the receiver has never seen in that team.
  - `handles` (at most 20) are the sender's share handles that the receiver may ask about: the projects shared with a team both machines are on. A teammate admitted by this same exchange gets them on the next connect.
  - **Service parameters.** A2A-Version travels as `a2aVersion`; any `1.x` is accepted, and another major version closes the connection with a logged reason. The only extension, `urn:elu-code:a2a-ext:peer:v1`, is listed in each `Message.extensions` (A2A-Extensions has no other carrier here).
- **Admission.** The Hyperswarm firewall admits every key. The application layer then accepts a connection only if:
  - the remote key is an active member of a team we share; or
  - its hello carries roster ops that validly extend our log and make it a member; or
  - an invite of this machine is still open, and the connection uses it: `elu.invite.start` then `elu.invite.prove` for a short code, or `elu.join` for a long code from 0.1.3 or earlier (see [Invites](#roster)). Nothing else may be sent first.

  Anything else is closed. The decision is logged.

  Before admission, a key on none of this machine's teams (a stranger, someone removed from them, a joiner) is sent only the hello `{binding, a2aVersion, name: "", teams: [], handles: [], plans: true}`: no team, no member and no name. A joiner gets the roster in the reply to `elu.invite.prove` (or `elu.join`). On a direct connection the handshake also shows the other side this machine's IP address and port.
- **Methods.**
  - **A2A core:** `SendMessage`, `GetTask`, `CancelTask`. The push-config methods return PushNotificationNotSupported; any other core method returns UnsupportedOperation.
  - `SendMessage` never blocks: it returns the Task (SUBMITTED, or REJECTED with a reason) at once, whatever `returnImmediately` says. Later states arrive as `elu.taskUpdate` or through `GetTask`.
  - Unknown fields in A2A objects and params are ignored (A2A §5.7); size limits still apply.
  - **Extensions:** `elu.hello`, `elu.invite.start` `{topic, nonce}`, `elu.invite.prove` `{proof, name, exits?}`, `elu.join` `{teamId, secret, name}`, `elu.roster.get` `{teamId, after}`, `elu.roster.push` `{teamId, ops}`, `elu.picture.put` `{id, seq, last, size, sha256, data}` (see [Pictures](#pictures)), and the `elu.mine` and `elu.remote.*` methods between computers of one owner, `elu.remote.files` among them (see [Your other computers](#your-other-computers)).
  - **Notifications:** `elu.status` `{rows, box, bots: [{name, about}]}`, `elu.plans` `{tasks}` and `elu.taskUpdate` `{task}`. `box` and `bots` are described under [Status](#status), `elu.plans` under [Tasks](#tasks).
- **Errors.** JSON-RPC error objects; `data` is a list of `google.rpc.ErrorInfo` with `reason` set to the code's name. Messages carry no local paths, unless the caller is a peer I trust (`trusted` in `peers.json`), who gets them as written.

  | code | meaning | the asker |
  |---|---|---|
  | -32000 | too many requests (more than 20 in 10 s; more than 40 closes the connection) | retries with backoff |
  | -32001 | TaskNotFound | marks the ask failed |
  | -32002 | TaskNotCancelable | stops cancelling |
  | -32003 | PushNotificationNotSupported | |
  | -32004 | UnsupportedOperation | marks the ask failed |
  | -32009 | VersionNotSupported | |
  | -32602 | invalid params, including every refusal | marks the ask failed |
  | -32603 | internal error | retries with backoff |

- **Idempotency.** `SendMessage` is idempotent on (sender key, `messageId`). A repeat returns the original Task. The sender stores the server's `taskId` in `asks/` and polls `GetTask` when it reconnects.
- **Exact names.** JSON field names, enum strings and method names must match A2A v1.0.1 (`specification/a2a.proto` and `docs/specification.md` at tag v1.0.1). `lib/peer/a2a.mjs` cites the section each one comes from.

Extension `urn:elu-code:a2a-ext:peer:v1`:

- It is listed in `Message.extensions`.
- Its data lives in `metadata["urn:elu-code:a2a-ext:peer:v1"]` = `{kind, project, hop, from: {key, name}, team?, room?, bot?}`. `team: true` marks a team ask; older peers drop it and show a plain ask.
- `kind` is one of `ask`, `review`, `handoff`, `answer`.
- `project` is a share handle or repository id, or null for the team's project.
  - The receiver takes a named project only when it shared it with a team both machines are on. A project shared with another team is refused in the same words as one that is not shared.
  - With null, the receiver uses the project of its [setting](#what-teammates-can-do-here) for the team, else the share chosen for the team, else its one share. Without any, the message is still taken (SUBMITTED) and waits for the owner, who approves it in a project he has open. ELU 0.1.6 and earlier refuse it instead, with "They have not shared a project, so there is nothing of theirs to ask about yet."; a newer sender shows that refusal as a line saying the teammate needs to update.
  - A share saved by a build from before shares kept their teams is open to every team of the receiver's until it is shared again.
- `room: {team, channel}` says where a team ask was sent. `team` is the team id. `channel` is the channel id, or null for `#general`.
  - The receiver keeps the room only when both machines are on that team and, for a channel, both are in it. Otherwise it drops the room and shows a team ask with no channel.
  - A room whose ids are malformed is refused as invalid params.
  - Older peers drop the field.
- `bot` names one of the receiver's shared bots, the one the question is for.
  - It is a bot name: 1 to 30 lowercase letters, digits or `-`, starting with a letter. Anything else is refused as invalid params.
  - Only an `ask` to one teammate may carry it. With another kind, or with `team: true`, the message is refused as invalid params.
  - Older peers drop the field. There the question reaches the person as a plain ask.

## What teammates can do here

Each machine keeps one setting per team in `peer/access.json` = `{teamId: {handling, rules, root, at}}`. It is never sent; nothing on the wire changed for it.

- `handling` is `auto` or `manual`. The teams that decide a message are the teams of the project it runs in: those the project is shared with that both machines are on (every common team for a share without teams), plus the common teams whose `root` is that project. The sender's `room` never chooses among them. When every one of them is `auto` with that project as its `root`, an incoming `ask`, `review` or `handoff` (not one for a shared bot, and not a team ask) is queued at once as the owner's own kind of session: a request with `origin.kind` `handoff`, `origin.own: true`, `origin.teams` those teams, the owner's default permission mode (`auto` in place of `full`), place `worktree` and no extra folders. A later message in the thread continues the session in its current mode, and waits when that is `full`. Its Task waits for the owner's approval as one he asked for would, and the reply says so. Otherwise it waits (SUBMITTED) until the owner's y, which queues the same request in his default mode. A team with no entry is `manual` with no rules.
- These sessions count toward `peerSlots`. Each turn a message starts is capped at `caps.runUsd`; an outbox entry with no cost (`costUsd: null`) is charged the whole reservation.
- `rules` is the owner's plain-English text, up to 1000 characters. Every turn of a session a teammate started (`task.origin.peer` set) is told it under "The owner's rules for teammates", read when the turn starts. It gets the rules of every team in `origin.teams`; a session without them gets the rules of every team the teammate is on.
- `root` is the project those sessions run in: the folder `/join` (or `elu join`) ran in, or the one `/invite` shared. It is used when it is a registered project, and is never the home folder or above it.
- A session a teammate's message starts (`task.origin.peer` set) never works in the home folder or a folder above it, and never edits a repository there, unless the owner allowed it. Where the session works decides (its `worktree`): one whose project is the home folder but that edits in a repository's own folder is not there. The owner at the keyboard (typing, replying, approving, retrying) is asked "This session's project is your home folder. Let it run here?"; y keeps `homeAllowed: true` on the session (or `home: true` on the request that starts one) and the message goes at once, and n sends nothing. `elu allow-home <session>` does the same from the command line. An unattended message (Auto) never runs there: intake picks no such root, and a request that reaches the conductor for such a session waits under Needs you with the same question. The conductor and the session refuse anything else, whatever path reaches them.
- The teammate's own text is kept on the session's message as `context` (and `words`, apart from the note on any pictures). The chat, the session's details, `elu status`, the follow-up box and the lists show it under their name; the sentence written for the model stays in its prompt. Retry never sends a teammate's message again as the owner's.
- Asked by `/join` before the join, by the first `/invite` for a team before its code, and changed with `/access` or `elu access [--auto|--manual] [--rules TEXT] [--project PATH]`. `elu join` and `elu invite` take `--auto`, `--manual` and `--rules` too. Without either, `elu invite` on a team that already has other members saves `manual`.
- Leaving a team (`teamLeave`, or the leave written here when the daemon cannot start) and coming back to it with a new invite drop its entry along with its shares. Hearing that this machine was removed from it drops its entry only; its shares are dropped when it comes back. Joining again sets the entry again: `/join` asks, and `elu join` saves its flags or the defaults (`auto`, no rules).
- A question for a shared bot (`bot` in the extension) waits for the owner as before, and is refused when the receiver has no project for it. A teammate set to `autoAccept` in `peers.json` still has its asks and reviews answered read-only while the team has no setting.

Task state mapping:

| ELU | A2A |
|---|---|
| waiting for the owner to approve | SUBMITTED |
| run in progress | WORKING |
| reply held for the owner's approval | WORKING, with ext metadata `{substate: "awaiting-owner"}` |
| reply sent | COMPLETED, with the reply as one Artifact (text part) |
| owner declined, or blocked by policy or caps | REJECTED, with a reason message |
| run failed | FAILED |
| asker cancelled | CANCELED |

## Your other computers

Two machines of the same owner (a laptop and a devbox, say) can each start and watch sessions on the other. Each is an ordinary member of a team the two share; what makes them the owner's is a mark on both sides.

- Each machine keeps `peer/mine.json` = `{key: {at, theirs, theirsAt, auto?, account?, login?, pairedAt?, refused?}}`. `at` is when this machine marked `key` as its own (`/mine @name`, `elu mine @NAME`, or GitHub pairing below). `theirs` is what `key` last said about this machine. A key is mine only when `at` is set, `theirs` is true, and the two still share a team. `/mine remove @name` (or `elu mine remove @NAME`) clears `at` and sets `refused`. Leaving, or being removed from, the last team the two share drops the row on the next roster check.
- **Pairing by GitHub account.** Two machines on a team together that are both signed in to GitHub with `gh` as the same account mark each other with no step. Each one's peer daemon (it runs while the app is closed) does this at start, when a teammate connects, and every 15 minutes; never more than once a minute, each `gh` call stopped after 10 seconds, and nothing waits for it.
  - It runs `gh api -i user` for the account (its id and login) and the token's scopes, which must include `gist`. It never reads the token: only `gh` talks to api.github.com.
  - It looks for that account's secret gist described `ELU Code computers` (`gh api --paginate gists`), and makes it, secret, when there is none (`gh api -X POST gists`). The gist holds one file per computer, `<peer key>.json` = `{"key", "name", "at"}`: the machine's public peer key and its box name. A machine writes only its own file (`gh api -X PATCH gists/<id>` naming that file alone), only when it is missing or the name changed. Two machines that made a gist at the same moment leave two: each reads all of them and writes to the oldest.
  - A file whose name is a 64-hex key and whose `key` is that same key is a key the account vouches for. Every teammate on a team shared with this machine whose key is vouched for is marked mine (`auto: "github"`, the account id and login) and told so with `elu.mine`. The other machine does the same, so the pair forms by itself. Each side writes one line in its daemon log, and the app shows it once: "@devbox is yours: both computers are signed in to GitHub as octo-user."
  - A GitHub mark goes, and the other machine is told, when its key's file leaves the gist or another GitHub account signs in. A mark made by hand is never taken away by this. A key refused with `/mine remove` is never marked by GitHub again until it is marked by hand.
  - No `gh`, not signed in, no `gist` scope, offline or a GitHub error: nothing changes, nothing is retried before the next check, and `/mine` (and `elu mine`) ends with "Sign in to GitHub with gh auth login on both computers to pair them by themselves, or type /mine @name on each." What the last check found is in `peer/github.json` (`{state, at, login?}`).
  - Anyone signed in to the same GitHub account counts as you: a machine whose key that account's gist holds, on a team with this one, becomes yours. A teammate signed in as someone else cannot write to your gist, so cannot make their computer yours.
  - Off with `ELU_NO_GITHUB_PAIRING=1`, or with `/mine auto off` (`elu mine auto off`), saved as `githubPairing: false` in `peer/settings.json`; `/mine auto on` turns it on again. Turning it off keeps the computers already paired. It never runs in a test or CI run (`NODE_TEST_CONTEXT`, `CI`) unless that run sets `ELU_GITHUB_PAIRING=1`.
- An invite made with `mine: true` (`elu invite --mine`; good for 1 hour by default) marks nothing by itself on either side. The `elu.invite.prove` result carries `mineOffer: true`, and the joiner's app asks "Is <name>'s computer yours too?" (No first; Esc is no). On the command line only `elu join CODE --mine` says yes. A yes marks the inviter on the joiner and sends `elu.mine {mine: true}`; the inviter marks the joiner back only on that, from the key its mine code admitted, once, within a week of the join. A `mineOffer` from the other side is never enough to mark anything.
- A machine already on the team that uses a mine code is refused, and the code stays unused: both sides are told to run `/mine` on each machine instead.
- `hello` carries `remote: 1`. A build without it is older: it is never sent the methods below, and every action toward it says "@name needs to update ELU to run sessions from here." Nothing falls back to an ask.
- `hello` carries `files: 1` on a build that takes files (`elu.remote.files`). Files are never sent to a computer whose hello says `remote: 1` without it, nor to one that answers Method not found: the owner is told "@name needs to update ELU to receive files."
- `hello` carries `folders: 1` on a build that lets the owner pick the folder a session works in (`elu.remote.folders`). A computer whose hello says `remote: 1` without it is never asked, and its sessions start where they did.

Wire, on the existing connection:

| Method | Direction | Params | Result |
|---|---|---|---|
| `elu.mine` (notification) | both | `{mine: boolean}`: whether the sender marks the receiver as its own. Sent on every admitted connection with `remote: 1`, and on each change. The receiver says a line only when the answer changed. | none |
| `elu.remote.folders` | viewer to host | `{}` | `{pick, root, project, folders: [{path, label, name, project}]}` |
| `elu.remote.start` | viewer to host | `{id, text, permissions, place, model, bots, folder?}` | `{id, project}` |
| `elu.remote.send` | viewer to host | `{id, text}` (a leading `@bot` writes to that bot of the host's) | `{id}` |
| `elu.remote.stop` | viewer to host | `{id}` | `{stopping}` |
| `elu.remote.answer` | viewer to host | `{id, approval, decision: "allow"\|"deny", always?: "project"\|"all"}` | `{answered, kept?}`: false when it was already answered |
| `elu.remote.task` | viewer to host | `{id, decision: "approve"\|"reject"}` | `{answered}` |
| `elu.remote.since` | viewer to host | `{id, after}` | `{id, events, more, last, first}` |
| `elu.remote.events` (notification) | host to viewer | `{items: [{id, events}]}` | none |
| `elu.remote.list` | viewer to host | `{since, after, limit}` | `{full, cursor, projects, sessions, gone, next}` |
| `elu.remote.watch` | viewer to host | `{ref}` | `{id, project, title}` |
| `elu.remote.files` | viewer to host | `{id, send, seq, last, size, data, text}` (`text` on the last piece only; see [Files](#files)) | `{ok}` per piece, then `{id, files, bytes, dir}` |

- Every request and notification above except `elu.mine` is refused with "Only your own computers can do this." unless the sender's key is mine on the receiver, and the host sends events only to such a key. An `id` (a UUID the viewer chose) belongs to the key that started it; to any other key it is "That session is not on this computer."
- `start` runs the message as the host owner's own new session: `permissions` is `ask`, `auto` or `full`, `place` is as for a local session, `model` is `{vendor, model}` or null, and `bots` are names of the host's own bots (one it lacks is refused). Teammate rules, Auto/Manual and teammate caps do not apply; the never list, the sandbox and the host's limits do. It runs in the registered `root` of the first team the two share that has one (`/access`). With none, it runs where the owner's own sessions there run: the host's only registered project, or of several the one whose newest session (`createdAt` or `activeSince`) is newest, the home folder included, since the home-folder rule is for teammates' sessions. A host with no registered project refuses it with what to do there. The task's `origin` is `{kind: "mine", mine: true, machine, name, remoteId}`.
- `folders` says where a `start` would run (`root`, the project's folder there, and `project`, its name), and `pick` is true while the home folder (or a folder above it) is a registered project there and no team setting decides. Then `folders` lists every registered project there, the home folder too, then each Git repository in the home folder as a session's lead finds them (`clonesIn`: hidden folders, dependencies and linked worktrees left out, at most 60, looked for again every 10 minutes); `label` is its path from the home folder (`~/shop`), `project` says it is a registered project. The viewer's app asks before the session starts: "Folder on @devbox", one row each, the cursor on `root`; Enter starts it with that `folder`, and Esc sends nothing and keeps the message in the box. A `folder` that is a registered project runs there; one that is a Git repository's own folder in the home folder (never the home folder, a folder above it, a folder inside a repository, or a linked worktree) is registered first, as opening it there would. Anything else is refused with "Pick one of the folders listed." and nothing is queued. With no `folder`, `start` runs as above.
- Events are numbered per session from 1 and kept on the host (the newest 4000) in `peer/remote/host/<id>.jsonl`. Each is `{seq, at, type, ...}`, with `type` one of `state` (`state, title, mode, place, bots, activeRole, error, question, choices`), `entry` (a chat message: `role, at, text, lead?, bot?, failed?, quiet?, shell?`), `step` (`at, text`), `approvals` (`list: [{id, role, summary, at, always?}]`, all that wait now; `always` is the rule `a` would keep, in words, only where the host offers `a`), `plan` (the shared Task, or null) and `diff` (`summary, patch`, the patch cut at 60,000 characters). A notification stays under 400 KB.
- The viewer folds them, in order, into `peer/remote/view/<id>.json`. On a gap, and on each new connection, it asks `elu.remote.since` from its last `seq`, a few sessions at a time. When `first` is past its `seq`, the older events are gone and it continues from `first`.
- An approval answered on either machine is answered once: the approval file takes the first answer, and the next `approvals` event drops it on the viewer.
- `always` (only with `allow`) is `a` pressed on the viewer, after it chose this project or all projects. The host makes the rule from its own approval request, as its own `a` would (`keepOffer`, `keepRule` in `lib/permission-rules.mjs`), saves it in its own rules, allows the approval and anything else waiting that the rule covers, and returns the rule in words as `kept`. Where it offers no `a` (the never list, a removal, an MCP tool, a teammate's session) it refuses. The viewer offers `a` only for an approval whose event carries `always`; an older host sends none.
- A session with `origin.kind` `mine` is the owner's own: his saved rules answer for it, and the limits on a teammate's session (the home folder, the teammate's words) do not apply to it.

Every session on a computer of mine, not only the ones started from here:

- `elu.remote.list` lists every session on the host, whoever started it: its owner by hand, a schedule, a bot, a teammate's message, or another computer of the owner's. A teammate's question (an ask or a review, answered in Chats) and an archived session are not listed, nor is one that neither works nor waits now (a question, a Task to approve, an approval) and has done nothing for a week; such a session leaves the list as `gone`. `projects` is every registered project there: `{id, name, repoId, home}`, where `id` is 16 hex characters of the folder's hash, `repoId` is the hash of its normalized `origin` URL (as for shares) or null, and `home` says it is the home folder. Each session is `{ref, project, title, state, at, createdAt, question, error, plan, approvals, by, who, repoId, remoteId?, standup?}`: `ref` is `<project id>:<task id>`, `at` its last activity, `plan` `{state: "proposed", title}` or null, `approvals` what waits now (as in the `approvals` event), `by` one of `you`, `schedule`, `bot`, `teammate`, `mine`, and `who` the teammate's or the bot's name. A session a message from another computer of the owner's started (a handoff, by the teammate path, that the owner took on as his own kind of session) is `mine`, not `teammate`, decided by the key the message came from on every list, so one started before the two were paired lists as `mine` once they are; its `remoteId` is the id that computer follows it by, when it does. Its mode and rules stay what they were. One he took on in a mode he picked stays `teammate`, as its files are refused. The answer says `mineByPeer: true`. An older host does not: only from one does a viewer read a `teammate` session as `mine` by name, when `who` is its own name or the name of another computer of its owner's, and never by a name that a teammate on a team with it who is not its owner's also goes by. `repoId` is the repository the session works in, found as the Kanban finds it (`lib/kanban-repos.mjs`: the repository its edit runs in, the one its Task names, the project or the session's folder when it is a clone, else the project's main repository, picked from every session of the project, archived and older ones too), as the hash of that clone's normalized `origin` URL like the project's `repoId`, or null for none. An older build sends no `repoId`; the viewer keeps it only as 64 hex characters, else null. `remoteId` is sent only to the computer that started that session. `standup: false` marks one a standup would not ask there ("Standup" below). Newest first, at most 100 a page; `next` is the cursor for the next page (`after`).
- `cursor` is the host's clock when it listed. Given back as `since`, only sessions that changed after it are sent, and `gone` names the ones that left. A cursor from before the host's daemon started, or more than 10 minutes old, gets everything again with `full: true`. The viewer asks for everything when the host connects, then every 3 seconds for what changed. A list of several pages takes one page a tick, at most 10, and is kept in `peer/remote/machines/<key>.json` once its last page is in.
- What the viewer asks a host on its own (lists and catch-ups) stays within 8 requests in 10 s per host, and watches made by the cursor within 14 with them, under the connection's limit of 20. A watch past that is refused for a moment ("<name> is busy") and asked again 5 s later. What the owner does (send, stop, answer, a watch by key) is never held back, but counts.
- `elu.remote.watch` makes a listed session one the viewer follows: from then on it has numbered events, and `since`, `send`, `stop`, `answer` and `task` take its `id` as for a session started from the viewer. The `id` is the UUID made from SHA-256 of `watch`, the viewer's key, the host's key and `ref`, so both sides know it before the answer. A watch lasts a week after its last event or watch. A command or catch-up to a watch the host let go is answered "That session is not on this computer.": the viewer watches it again once under the same `id`, keeps its view in place and starts its events over from the first, and sends the command again. A view whose listing shows activity more than 2 minutes after its last event, once for each such listed change, catches up the same way: its events are on their way (a session quiet there for 10 minutes is looked at every 30 s, and listed every 3 s), it missed events without seeing a gap, or its watch was let go. A view goes only when the watch itself is answered "That session is not on this computer.", or when a catch-up finds the watch let go of a session its computer no longer lists.
- Sessions on the viewer shows, after its own, a heading per computer of mine ("On devbox · online" or "offline"): the sessions there that work in a repository the open project holds (its own, and each one its Kanban has a board for: the clones its folder holds and the ones its recent sessions work in, as the daemon last found them, read again every minute), and the ones started from the viewer, newest first. A session listed with no `repoId` (an older build, or one in no repository) shows when its project there has the same `repoId` as the open project. With none of them, the heading says "No sessions of this project. Projects lists its others." when that computer has sessions this project does not show, else "No sessions yet." Each row takes its time and its place from the listing. What waits for the owner there, in any project (the home folder too): an approval, a Task to approve or a question, also shows under Needs you, marked "on devbox". Those sessions are part of the open project, whatever folder their project is there (a folder of clones, the home folder). A project of that computer shows in Projects as "<project> on devbox" only while it has sessions not shown under the heading, with how many ("2 sessions not in this project"); one whose sessions all show, or that has none, is not listed. Enter there lists those sessions under a heading of their own. A row is watched when the cursor rests on it for 300 ms, and not while its computer is offline ("<name> is offline. What it listed last is shown."). A watch that failed is asked again after 30 s, not on every draw.
- A computer of mine whose build answers `elu.remote.list` with Method not found, or that does not say `remote: 1`, shows "Update ELU on <name> to see its sessions here." and is asked again after 10 minutes.
- Both methods are refused, as the others, unless the sender's key is mine on the host. Nothing about a computer is listed, watched or sent to a key that is not.

### Files

A message to a session on another computer of yours can take files and folders from this one. Only computers that are yours on both sides send or take them; a teammate never does.

**What is sent**

- A message typed to such a session that names files or folders here (absolute, `~/`, quoted, or with spaces escaped as a dropped file is) asks one line first: "Send 14 files (2.1 MB), including 1 key file, from this computer with this message?". y sends them with the message, n sends the text alone. `/send PATH...` sends files alone after the same line. Both computers are yours, so anything you can read may go, key files included; the line names them.
- A folder goes whole, except its `.git`, a link that leads out of it, a link to a folder in it, and anything that is not a file or a folder (the line says how many were left out). ELU's own state folder never goes.
- At most 5,000 files and 200 MB a send. Over that, the line says so and offers the text alone.
- A Claude Code session of yours (its relay, `elu-code-approval`) has two tools: `list_other_sessions` (each computer of yours, and its sessions' id, title, state and the question or approval they wait on) and `send_to_session` `{session, paths, message?}`. A send reads only what that session may read: never ELU's state, the home's secret folders or an untracked file whose name may hold a secret, and in Approve for me nothing outside the folders its turn reads (its workspace, the folders added with `/permissions folders`, and the home only in a turn that reads across it). Paths are compared by what they are on disk, and those closed folders and secret names without case, so another spelling of the same file is the same file. Each file is copied only if it is still the file that was checked, never through a link. A teammate's session on that computer, such as a handoff accepted there, is not listed and takes no files. In Ask for approval each send is an approval for you, naming the session, its computer and the paths. Sessions on other models do not have these tools.

**On the wire**

1. The app or the tool copies the files to `peer/files/out/<set>/` in the state folder, each with its SHA-256. The daemon sends only from there.
2. One send is one stream: its list as a JSON line (`{items: [{name, written}], files: [{path, size, sha256}]}`), then each file's bytes in that order. It goes in pieces of 700 KiB with `elu.remote.files` `{id, send, seq, last, size, data}`, `data` base64, the message as `text` on the last piece. Pieces count toward the same request rate as the other requests to that computer, and one turned away as busy is sent again shortly.
3. The host takes pieces only from a key that is mine there, for a session that key may write to (as `elu.remote.send`), that has started, and that is the owner's own: never a teammate's, such as a handoff accepted there ("That session is a teammate's. Files from your other computers go only to your own sessions."). It stages them in `peer/files/in/<sender key>/`, at most 2 sends from one computer at a time, and removes a half-sent one after 10 minutes.
4. With the last piece in, the list is checked again (the same caps; each path relative, no `.` or `..`, no `.git`, no name given twice) and every file is written new (0600, folders 0700, never through a link) and checked against its SHA-256. On any fault nothing stays and nothing reaches the session.

**Where they land**

- In the session's inbox, `elu-code/inbox/<project id>-<task id>/<time>-<computer>/` in the data folder (`$XDG_DATA_HOME`, else `~/.local/share`): outside the state folder, which no session may read, and outside every project and worktree. Where that folder is inside a Git work tree that does not ignore it (a home folder that is a repository, say), nothing is received, so no session there commits what landed: the sender is told to add it to that repository's `.gitignore`. The inbox is added to the session's folders, as `/permissions folders add` would, so the session reads it in every mode.
- The message continues the session as one typed there, each path it named pointing where that file or folder landed, and ends with "Files from @laptop: 14 files (2.1 MB) in <folder>". The sender sees "Sent 14 files to the session on @devbox."

## Pictures

A message you type to a teammate or a channel takes along the pictures it names.

**What is sent**

- Write or drag a picture's path into the message box. A path with its spaces escaped (as a terminal writes a dropped file), a quoted path and a `~/` path all work.
- The path in the text becomes the picture's file name. The teammate never sees your folders.
- A file counts as a picture when its first bytes say PNG, JPEG, GIF or WebP. Its ending does not matter. Any other path stays the text it was. Nothing else in the file is checked, and it is sent unchanged: what a photo records about the place, the device and the time goes with it.
- Only a message you typed carries pictures. A model's draft (sent by hand or by itself), a review, the command line and the local A2A endpoint never attach a file, so a model cannot send a file out by naming its path.
- A path in text you pasted into the message box is a path you typed. The line that says how many pictures went (`with 2 pictures`) is shown after the message is sent.
- A picture in a folder that holds secrets (`~/.ssh`, `~/.aws`, `~/.config` and the rest of that list, and ELU's own state folder) is refused. `~/Library` is the one folder of the list that stays open, because screenshot tools save there. A hard link in another folder to a file in such a folder is not recognized, and is attached.

**Limits**

| | limit |
|---|---|
| one picture | 8 MB |
| pictures in one message | 4 |
| all pictures in one message | 16 MB |

Over a limit, the message is not sent, it stays in the message box, and one line says why, for example `shot.png is 14 MB; a picture can be up to 8 MB.`

**On the wire**

1. The app you typed in copies each picture to `pictures/out/<set>/<n>` in the state folder. The daemon sends only from there, never from a path in a command.
2. Before the message, the daemon sends each picture in pieces of 700 KiB with `elu.picture.put` `{id, seq, last, size, sha256, data}`. `data` is base64, so a piece stays under the 1 MiB frame. Pieces count toward the same request rate as everything else, and one message with pictures goes to a teammate at a time.
3. The message then names each picture as an A2A file part by reference: `{url: "urn:elu-code:picture:<id>", filename, mediaType, metadata: {"urn:elu-code:a2a-ext:peer:v1": {size, sha256}}}`. A file part does not count toward the text limit.
4. The Task that `SendMessage` returns says how many pictures were kept, in its extension metadata as `pictures`.

**On the receiving side**

- Pieces are taken only from a teammate who is not muted. Each picture is checked again: its first bytes, its size and its SHA-256.
- A finished picture waits in `pictures/in/<sender key>/` for the message that names it. One that waits longer than 10 minutes is removed.
- When the message is accepted, its pictures move to `pictures/kept/<sender key>/<task id>/1.png` and so on: a folder only you can read, names made here, never the sender's path. The sender's file name is kept as cleaned text. A kept file is known as a picture by its first bytes only; it is readable by you alone (0600) and ELU never runs it.
- In Chats, the row says how many pictures came and how large (`@kim asks you with 2 pictures (1.5 MB)`), and the opened message lists each name and size. The sender's row says `with 2 pictures`.
- A refused message keeps no pictures. Kept pictures are removed with the message's record.
- Caps, so a teammate cannot fill the disk: 32 MB or 16 pictures on their way from one teammate, 64 MB kept from one teammate, 256 MB kept in all. Over the first, the sender tries again later. Over the others, the text arrives without the pictures and the sender's row says so.

**When the question runs**

- The pictures are copied to a folder of their own under `elu-code-pictures` in the temporary directory. The folder is yours alone (0700) and holds only that question's pictures.
- A question run reads the shared project and, when the message came with pictures, that one folder. Nothing else changes about what a teammate's question can read.
- The pictures are named inside the teammate's data block, so the model treats them as the teammate's material and never as instructions.
- The copies are removed when the run ends. While it runs, another session of yours that can read the temporary directory could read them.
- If the copies cannot be made, the model is told the pictures' names and that it could not see them.
- A message you take on as your own session, in a mode you pick, gets the same copies as paths in the teammate's data, like a picture you name in your own session. Those copies stay in the temporary directory, as the copy of your own picture does.
- With another model than Claude, a teammate's message can only be taken on as your own session, so that is the one way its pictures reach that model.

**Older builds**

- A teammate on a build from before pictures answers `elu.picture.put` with "Method not found". The sender then sends the text alone, with the pictures' names in it, and the row says `@kim's ELU can't take pictures yet. The text went without them.`
- A message from such a build has no file part and is taken as before.

## Roster

- **Ops.** `{teamId, id: sha256(canonical body), type, by: hexKey, at, body, sig}`. `sig` is ed25519 over the canonical JSON of everything except `sig`; canonical means sorted keys and no whitespace.
- **Types.**
  - `create`: by the founder; body `{name}`. The teamId is the id of this op.
  - `admit`: body `{key, name, role: "member"|"admin", invite}`. `invite` names the invite: sha256 of `short:` followed by the joiner's verifier key for a short code, sha256(secret) for a long one.
  - `remove`: body `{key}`.
  - `role`: body `{key, role}`.
  - `relays`: body `{keys}`.
  - `leave`: by the member leaving.
  - `channel`: by a member, with body `{id, name, members}`.
    - `id` is 16 hex characters.
    - `name` is 1 to 30 lowercase letters, digits, `-` or `_`. It starts with a letter or digit, and `general` is taken.
    - `members` is a list of up to 20 distinct keys.
- **Merge.** A pushed op is stored only if the fold applies it. Dropped: ops over 10 minutes in the future; every op from a key the receiver's log shows out of the team now (whatever its `at`); and every op from a key that sorts at or before that key's latest leave or removal in the receiver's log, even after the key came back. Two logs can then differ by refused ops; sync keeps offering them and the receiver keeps refusing.
- **Fold.**
  - The log is a grow-only set. State is computed by sorting ops by `(at, id)` and applying them in that order.
  - An op is applied only if, at that point in the fold, its signer holds the needed role: the founder for create; an admin for admit, remove, role and relays; anyone for their own leave; a member for a channel op, under the channel rules below.
  - Removal wins: from a key's removal or its own leave, its ops are ignored. The founder cannot be removed, leave, or change role.
  - **Coming back.** An admin's later `admit` of that key (a new invite, redeemed as usual) brings it back with the role, name and join time of that admit. Ops it signed before it went out stay applied; ops that sort between its exit and the new admit are not applied; ops that sort after the admit apply under its new role.
    - Why this is safe with timestamps that the signer picks: the fold judges an op by where it sorts, never by when it was signed. A returning key cannot backdate an op to when it held its old role, because every machine that has the exit refuses, at merge, any op of that key sorting at or before it. An op dated into the window between exit and admit is not applied. An op signed while out and forward-dated (at most 10 minutes, the merge limit) past the new admit applies only under the role that admit gave, the same as an op signed after coming back. An admin's `admit` is stamped after the newest op that admin has, so it sorts after the exit it answers.
    - A machine that never got the exit can still take a backdated op from that key, as it could before; it is refused by every machine that has the exit, and the logs differ by that op.
    - A teammate on 0.1.5 or earlier refuses the new `admit`, so it keeps the returning member out until it updates.
  - The fold returns `channels: [{id, name, members, createdBy, createdAt}]`, oldest first.
- **Channels.** A channel is a named group inside a team. `#general` is everyone on the team and needs no op.
  - One `channel` op sets the whole channel: its name and its members. An op with no members deletes the channel.
  - Any active member may create a channel that lists them.
  - A channel's members and the team's admins may change it.
  - Every key listed must be an active member of the team.
  - No two channels share a name.
  - A member who is removed from the team, or leaves it, drops out of its channels. A channel with nobody left is gone, and its name is free again.
  - Limits: 50 channels per team, and 200 channel ops per signer. An op past a limit is not applied.
  - A channel op syncs like every other op, so the people added get the channel from any teammate.
  - A teammate on an older build refuses the op and sees no channels.
- **Leaving and removing.** `/leave` or `elu team leave` appends the member's `leave`; `/remove @name` or `elu team remove NAME` appends an admin's `remove`. The founder cannot leave and cannot be removed. Both go through the daemon, which is started for it when it is not running; a daemon started for it first waits, until 10 s after its start, for the team's teammates to connect. The op is then pushed at once to every teammate online, the one removed included, before their connections close (it waits up to 5 s for them). The machine that left drops the team from Chats and forgets which of its projects was that team's, so coming back shares nothing until the owner shares again.
  - A machine that was offline gets the op on its next connection. Its hello still lists the team as shared, while the other side's log shows one of them out: that connection serves nothing but an invite exchange; the side that has the op pushes the ops the other lacks up to that exit (as in sync, never an op that sorts after it), and the connection closes once the other side has it, or after 30 s. Sync applies the same cap on any connection, for a team where one of the two is out.
  - A leave no teammate took at once is noted in `unheard.json` (`[{team, op}]`, written before the leave is sent). While a row is there, the daemon keeps running, also on no team, and dials that team's other members; the first of them to connect is given the leave as above. The row goes once a teammate has taken the op, once every other member's hello shows it already counts this machine out (an admin removed it, say), or once this machine is back on the team. The app and the CLI say when no teammate was told.
  - A member whose leave nobody heard can still come back with a new invite: it sends that team's ops up to its leave (at most 64) with `elu.invite.prove`, and an inviter that still lists it on the team takes them in before the admit. An inviter on an earlier build ignores them and refuses with `You are already on this team.` until it hears the leave.
  - A machine on no team after a leave a teammate took, or after it hears it was removed, stops its daemon at once.
  - Without the networking packages the op is written to the log here. A remove goes out the same way once the daemon runs; a leave is noted as unheard, and goes out once the daemon can start.
- **Sync.**
  - On every connection, each side compares `{seq, head}`, where head is the sha256 of the sorted op ids.
  - The side with ops the other lacks pushes them with `elu.roster.push`. The receiver validates every op and drops invalid ones.
  - A team both are on that the other side's hello left out (it did not know this machine was on it yet) is synced too.
  - New ops are also pushed to every connected teammate, including ops another process (the CLI) wrote to the log.
- **Invites.**
  - **The code.** 12 characters in three groups of four, such as `k7qm-x2pd-9fhw`, drawn with `crypto.randomBytes` from 31 characters: the digits 2 to 9 and the lowercase letters without i, l and o. That is 31^12 codes, about 59.4 bits. A code names no team and no key. It is single use and expires after 24 h by default.
  - **Reading a code.** Whitespace anywhere (spaces, tabs, line breaks), case, dashes, quotes around it, and `/join` or `elu join` in front, once or twice, are ignored.
  - **Keys.** `master = scrypt(code without dashes, salt "elu-code invite code", N = 2^16, r = 8, p = 1, 32 bytes)`, about 64 MiB of memory and a fraction of a second per code. Then HKDF-SHA256 of `master` with no salt and the info strings `elu-code invite topic`, `elu-code invite inviter proof` and `elu-code invite joiner proof` gives, 32 bytes each:
    - `topic`, the Hyperswarm topic;
    - `prover`, the inviter's HMAC-SHA256 key;
    - `seed`, an ed25519 seed whose public key is `verifier`.
  - **Stored.** The inviter's `invites.json` (mode 600) keeps `{hash: sha256("short:" + verifier), expiresAt, usedBy, topic, prover, verifier}`, and `usedAt` once used: not the code, and not `seed`, so the file alone cannot be used to join. The prefix means no long code's secret hashes to a short row's `hash`, so a 0.1.3 daemon reading the file does not take the verifier as a secret.
  - **Finding the inviter.** While an invite is unused and unexpired, the inviter's daemon announces on `topic` (`swarm.join(topic, {server: true, client: false})`). It stays there for 10 minutes after the invite is used, or until it expires if that is sooner, and then leaves. The joiner derives the same topic, looks it up (`{server: false, client: true})`), and tries each peer it finds there. A peer found on the topic gets nothing but the hello until both proofs pass.
  - **Proofs.** Both cover the canonical JSON `{proof: "elu-code invite", role, topic, joinerNonce, inviterNonce, inviter, joiner}`, where the nonces are 32 fresh random bytes from each side and `inviter` and `joiner` are the two Noise public keys of this connection (all hex).
    1. Joiner → `elu.invite.start {topic, nonce: joinerNonce}`.
    2. Inviter → `{nonce: inviterNonce, proof: HMAC-SHA256(prover, role "inviter")}`. The joiner checks it, and closes the connection if it is wrong.
    3. Joiner → `elu.invite.prove {proof: ed25519 signature with seed over role "joiner", name, exits?}`. `exits`, `[{teamId, ops}]`, is sent only for teams the joiner left without that inviter hearing it (see Leaving and removing).
    4. The inviter checks the signature against `verifier`, takes in the `exits` entry for the invite's team when its log still lists the joiner on it, then checks the expiry and that the invite is unused, appends `admit`, and replies `{teamId, inviter: its key, ops: the full log}`. The joiner checks that `inviter` is the key on the connection and that the log admits it. A key still on the team is refused (`You are already on this team.`) and the invite stays unused; a key that left or was removed is admitted again.
  - **A lost reply.** For 10 minutes after an invite is used, the key it admitted may run the exchange again and gets the same `admit` op with the full log, while that admit still stands: a key removed or gone since is refused and needs a new invite. Any other key is refused.
  - A proof that fails ends the connection. A key with 3 failed proofs in 10 minutes gets no invite answers until the window has passed. A start that names an unknown topic is refused and closed, and does not count: finding a topic costs a scrypt run either way. There is no limit on failures from everyone, since keys cost nothing and it would let anyone lock the real joiner out.
  - **Who answered.** The inviter's proof shows only that the other side knows the code. Anyone the code reached, and anyone with a copy of the inviter's `invites.json`, could answer as the inviter with a team of their own. A join shares no project of the joiner's: the joiner shares a project only with `/share` or `elu share`, and `elu peers` shows the fingerprint of every member. What a join does tell is the approved Tasks of the joiner's clone of a repository a member of the team says they share, when that claim names the repository's first commit and the clone has it ([Tasks](#tasks)). Every session the joiner runs in a repository a teammate also has is also on that teammate's Kanban: its title, column, who started it and which machine ([Kanban](#kanban)). For a public repository anyone can name both. Nothing on the joiner's Kanban marks this; `/share off` in a project stops it.
  - **Long codes from 0.1.3 and earlier** still join: `elu-team:v1:` + base32 of `{teamId, inviter key, secret(32), expiresAt}`. The joiner dials the inviter's key and calls `elu.join {teamId, secret, name}`; the inviter checks `sha256(secret)` against a row that has no `topic`. A short invite is never redeemed through `elu.join`.
  - The inviter must be online for the join. Until it, neither hello names the team, since the joiner is not on it.
  - **The daemon's version.** `state.json` carries the daemon's package version. A daemon keeps the code it started with, so when the app opens and before inviting or joining, the app and CLI restart one whose version is not their own (0.1.3 and earlier write none): a shutdown, with `enabled: false` written to `settings.json` for daemons from 0.1.5 and earlier, which honour a shutdown only then, then this copy's daemon. If it does not stop within 10 seconds, they refuse and say to try again.

## Status

- Status is on by default when a project is shared; `elu share --no-status` turns it off. While it is on, `elu.status` carries one row for each live task that edits the project (preparing, running, ready or waiting for input), at most 50 rows in all: `{repoId, handle, taskId, label, now, files}`. A session that only answers has no row.
  - `label` is the first line of the task's request, up to 80 characters.
  - `now` is what the task is doing: its state and who is at work (a role such as `lead`, a shared bot's `@name`, or `bot` for a bot that is not shared), up to 80 characters.
  - `files` is up to 200 paths, relative to the project, of the files the task changed from the commit it started from, and of the new files Git does not ignore.
- The rows go only to connected teammates on a team the project is shared with, as its name does. A project with no `origin` remote has no `repoId` and sends no rows.
- Every 10 s the daemon builds the rows again and sends them when they changed.
- `repoId` is the sha256 of the normalised `origin` remote URL, so the same repository matches across machines.
- Overlap is computed locally: my live tasks' changed files against teammates' rows with the same repoId. No query is sent for it.
- Status is also sent on every connection, even with no rows, and a teammate's saved rows are shown only while they are connected.
- `elu.status` also carries `box`, the name of the machine, and `bots`, the bots its owner shares: `[{name, about}]`, at most 20. These two go to every connected teammate, also when no project is shared or status is off.
  - The box name is the peer setting `box`. With none set it is the first label of the host name, without any character a box name cannot have and cut to 32 characters, or `box` when nothing is left.
  - The daemon reads the box name and the bots file again on every tick. When either changes, every connected teammate gets a new `elu.status` on that tick.
  - The receiver checks each field on its own. A box name that is not valid reads as none. A bot with a bad name, or an `about` that is not text, is dropped. An `about` is cut to one line of 120 characters.
  - The daemon keeps what each teammate last said in `state.json`, so it is still known after a restart while they are offline.
  - A machine on an older build reads only `rows` and sends neither field. It shows with no box name and no bots.
- `elu.status` also carries `boards`, the repositories this machine shares with the teams the two machines are both on: `[{repoId, handle, commit, teams}]`, at most 20. It says which team boards a teammate's own clone of a repository is on ([Tasks](#tasks)). A machine on an older build sends none.
- `elu.status` also carries `repos`, one proof for each repository this machine has, for the Kanban ([Kanban](#kanban)). A machine on an older build sends none.

## Kanban

Anything anyone works on in a repository shows on one Kanban for everyone on the team who has that repository. No `/share` is needed. Your own other computers count the same as teammates here, whether or not you marked them with `/mine`.

- **Which board.** A session is on the board of the repository it works in, from its first message: the one its edit runs in; else the one its proposed or approved Task names for the edit; else the project, when it is a clone; else the clone the session's folder is in. A session with none of these (a conversation in a parent folder, one that asks you first, one whose Task waits for you) works in the project's main repository: the one clone in the project's folder, or with several the repository of the project's most recent session that has one, else the clone whose folder has the project folder's name (in any letter case). Two clones are the same repository when their `origin` remotes match (the same `repoId`) and they have the same first commit. A project whose folder is above its repositories (a parent folder, or your home folder) has one board for each repository its sessions work in, and for each repository in its folder that a teammate's sessions work in. The header's `Board` button picks one. The board of the session you last opened in the project comes first. A session that works in no repository shows on each of the project's boards, as a card in To do does, and is not sent to teammates. A session is one card on your board while its first turn runs.
- **What a teammate sees.** Each of your sessions as a card in the column your own board has it in: In progress while it works, Needs you when it waits for you, Done when it is finished. Beside the title: `@name` of who started it (you, or the teammate whose message started it) and the name of the machine it runs on. On your own other computers' cards (`/mine`), a session you started there, here or from another of your computers says `you` instead; one a teammate's message started keeps `@name`. Enter opens it to read, as it opens one of your own cards: its whole Task when its machine told it (where it stands, its priority and severity, who started it and where, the goal, the description, the objectives with the met ones marked, the success criteria, the subtasks and the ETA), else `No Task yet`, and when it last moved. Nothing on another machine can change it. A card of one of your other computers (both marked with `/mine`) shows its Task or its first message, and its Go to session button opens it in Sessions, where you can follow and answer it, when Sessions lists it; one of yours reads `you · <machine>` and is not read-only.
- **What is sent.** For each session, only `{repoId, id, title, column, by, at}`, plus `plan`, the id of its Task when it has one (so a Task card and its session card show as one card), and `remote`, its id on the computer of yours that started it, sent only to that computer, `standup`, whether a standup would ask it ("Standup" below), and `own` to your own other computers alone: whether the session is yours, decided by the key that started it (by hand, a schedule or a bot there, another of your computers, or your own kind of session from a message of one). A computer that does not send `own`, an older one, is read by `by`, and never by a name a teammate who is not yours also goes by. A computer both machines mark as yours is also sent `ref`, the session's place on this computer as `elu.remote.list` names it, and `task`, the Task the session shows (its newest, waiting for approval too, unless that was rejected; the fields `elu.plans` carries, with `proposedAt`), or else `first`, the first 400 characters of its first message. A card's `task` is left out, oldest cards first, while the message would pass 256 KiB. Any other machine's `ref`, `task` and `first` are dropped on the way in, and an older build drops them all. `title` is the session's name or the first line of what was asked, at most 80 characters: every absolute or `~/` path in it reads `[path]`, and a title with a secret in it is sent as `Session`. `by` is at most 40 characters. `id` is a hash of the session's number and folder with a random secret this machine keeps in `peer/card-secret` (mode 0600), so it stays the same here and tells no one else either. Never the chat, a file, a diff or a path.
- **Who asked stays in the team it came through.** A session a teammate's message started has their words as its title and their name as `by`. Its card goes as it is only to that teammate and to teammates on a team the message came through (the teams of the project it runs in, else every team that teammate shares with this machine). Anyone else gets it with the title `Session` and `by` `teammate`.
- **Proof of a repository.** Each machine sends each teammate, in `elu.status`, one proof for each repository it has: the sha256 of the two machines' keys, the `repoId` and the repository's first commit. Only someone with a clone of that repository can make the matching proof, and it is good for those two machines only. A card goes only to a teammate whose proof matches this clone, and is kept only from one whose proof matches the receiver's. A repository the other side does not have is never sent, and a clone with another first commit gets no card. At most 200 proofs.
- **Which repositories a machine has.** Every project that is not kept off: the project itself when it is a clone, else the clones in its folder (hidden folders, dependencies and editing workspaces are skipped; at most 60, looked for again every 10 minutes), and the repositories its sessions of the last two weeks work in. Never the home folder, or a folder above it, as a repository.
- **What the board keeps.** Archived sessions are not sent. A session you moved to Done is sent as Done. As on your own board, a session quiet for 14 days leaves unless it is in progress or done, and at most 20 finished sessions of each repository are sent.
- **Keeping one project off.** `/share off` in a project keeps it off both ways: its sessions are told to nobody, its repositories are proven to nobody, and teammates' sessions are not shown in it. A project shared from here with status off is kept off too. `/share on` puts it back.
- **When.** `elu.cards` carries the whole present list for that teammate, on connect and within 5 s of a change, so a session that ends or leaves is absent from the next list. At most 100 cards and 256 KiB in one message. Only a machine whose `elu.hello` says `cards: 1` is sent any.
- **Receiving.** Every field is checked: control characters, terminal escapes and invisible characters are removed, white space becomes one space, text is cut to its limit, unknown fields are dropped, and a card that fails a check is dropped. The list is kept in `peer/cards/<key>.json` and the proofs in `peer/board-repos/<key>.json` (mode 0600). At most 40 of one teammate's cards are shown on one board. An offline teammate's cards stay, marked offline, for 48 hours after they were last connected, and are deleted at once when they are no longer on a team with this machine.

## Standup

`/standup` (README, "Standup") asks open sessions on other computers too. Only a machine whose
`elu.hello` says `standup: 1` is sent any of this; an older one is listed in the Standup as
not asked, and shows an asked session's rows as plain chat.

- **Your other computers.** The remote listing marks a session the host would not ask with `standup: false` (moved to Done, quiet for a week, a Standup, no agent), and the asker leaves those out before it counts. `elu.remote.standup {round, refs, question?}` names sessions by the refs of the remote listing. The host asks each one only if it would ask it itself (open, with an agent, not a teammate's), in the same read-only answer turn, and answers `{asked: [{ref, title}], skipped: [{ref, why}]}`, or `{older: true}` while its conductor still runs an older build that would take the question for a plain message. `elu.remote.standupRead {round}` gives `{answers: [{ref, title, who, text, at, failed?}], pending: [{ref, working, queued}]}`, and `elu.remote.standupStop {round, refs?}` takes back the questions not started and stops an answer turn that runs. A round is kept a day in `peer/remote/standup/`.
- **A teammate's computer.** A session card carries `standup: true` or `false`, whether a standup would ask it (the same rule as the owner's own sessions: not moved to Done, with an agent, active in the last week, working or waiting); a card of an older build carries neither, and one of those in Done is not asked but listed in the Standup, since it may have answered. A withheld card (a session a teammate's message started) is never asked. `elu.standup.ask {round, cards, question?}` names sessions by their card ids on the shared Kanban: only cards this machine tells that teammate, of the owner's own open sessions, at most 20. It counts toward the teammate's 200 messages a day; a muted teammate is declined. Each session asked is one of the teammate's runs for the day and reserves `runUsd` from their daily allowance and their teams', settled to what its turn cost when its answer is read and given back when the question is taken back before it runs; one past a limit answers that it was not asked. The approval is checked again when the owner says y: a teammate no longer in a shared team, or muted, is declined. While the conductor there runs an older build, the answer is `{older: true}` and nothing is asked. When every team the two share is set to Auto, the sessions are asked at once; otherwise the owner sees one item for the round, where y asks and n declines. The answer is `{state: asked | waiting | declined, asked: [{card, title}], skipped: [{card, why}]}`. `elu.standup.read {round}` gives `{state, answers: [{card, title, who, text, failed?, held?}], pending: [{card, working, queued}]}`, and `elu.standup.stop {round, cards?}` stops it. A round is kept a day in `peer/standup/`; asked again, it is answered as before, so each session answers at most once a round.
- **What a teammate's answer turn gets and gives.** The question inside a peer-data block, the owner's rules for those teams, and the read-only answer instructions. What goes back is checked as any answer to a teammate is: paths are cut, and an update that may hold a secret is replaced by "Its update was held back: it may hold a secret." Only the update, the card's title and the agent's name leave the machine. The asker checks every field again, and its Standup model reads a teammate's update only inside a peer-data block.

## Tasks

A Task is a session's approved plan: what the owner agreed the model should do. A team has one board for each repository a member shared with it. Every member's project of that repository is on it, whether that member shared it or not: their machine tells the team which Tasks its sessions there are working on, and shows the others' Tasks on its own Kanban.

- **Same repository, same board.** A project is on a team's board when this machine shares it with that team (`/share`, `elu share`, or the invite that shared it), or, when this machine does not share it, when its `origin` remote is the same repository (the same `repoId`) as a project a member of that team shares with it and this clone has the first commit that member names. The second needs nothing on this machine: a teammate who joins and opens their own clone is on the board without sharing it, and is never asked. A project shared from here is on the boards of the teams it is shared with and no others: a teammate's claim never adds a team the owner did not choose. Never for the home folder or a folder that holds it, never for a project with no `origin` remote, never for a clone without that first commit (a shallow clone may lack it), and never for a project kept off (below).
- **How a machine learns which repositories are on the board.** `elu.status` carries `boards: [{repoId, handle, commit, teams}]`: each project the sender shares with a team the two machines are both on (status on or off), with those teams. `commit` is the repository's first commit (`git rev-list --max-parents=0 HEAD`, the oldest when there are several); a project with no commit yet is not listed, and a row without a valid `commit` is dropped. The receiver checks it with `git cat-file -e <commit>^{commit}` in its own clone, so naming a repository's remote is not enough to bring someone's clone of it onto a board; for a public repository the first commit is public too. At most 20. The receiver keeps the last list from each teammate in `peer/boards/<key>.json` (0600) and replaces it with the next; a claim counts only for a team both machines are active members of. The sender sends a new `elu.status` within a tick of a share, an unshare or a team change. A teammate who is no longer on any team with this machine has their list deleted.
- **Keeping one project off.** `/share off` in a project keeps it off every board both ways: its Tasks are told to nobody, whatever a teammate shares, and teammates' Tasks are neither shown in it nor given to its models. For a project shared from here it also switches its status off. `/share on`, or `/share` again, puts it back. The list is `peer/board-off.json`. `elu unshare` says when someone else's share of the same repository still keeps the project's Tasks on a board.

- **What is told.** For each session of the project, the Task whose work is going on (its newest approved one), and any Task finished within the last 24 hours. Each is `{repoId, handle, id, revision, title, description, goal, objectives, priority, severity, state (approved or done), startedBy (owner, schedule or handoff), who, subtasks: [{text, state}], met, approvedAt, doneAt, updatedAt, criteria, estimateMinutes, etaMinutes, etaAt}`. `criteria` are the success criteria (at most 8, 200 characters each); `estimateMinutes` the model's estimate of the work from approval to done, and `etaMinutes` its last revision of the minutes left, made at `etaAt`. An older build sends none of the last four, and its Task reads as not set; an older build drops them on the way in. `who` is the model's name, a shared bot's `@name`, or `bot` for a bot that is not shared.
- **What is never told.** A Task that is only proposed or was rejected, the request and repository that approval starts, the chat, file contents, and any path of the machine. While status is on, a [status row](#status) does carry the first line of that request and the changed paths inside the project.
- **To whom.** Only a teammate on a team whose board the project is on. A project shared from here with `status: false` tells nothing, and neither does a project with no `origin` remote, since it has no `repoId`. One that is not shared from here tells nothing unless a member shares its repository with a team and this clone has the first commit they name.
- **When.** `elu.plans` carries the whole present list for that teammate. It is sent on connect, and within 5 s of a change (so at most one every 5 s to each teammate, well inside the 20 requests in 10 s a connection allows): an approval, a subtask's state, a finished Task, a new revision, a repository newly on a board. A Task that ended, or whose project left the board, is absent from the next list, and the receiver replaces what it had.
- **Size.** At most 30 Tasks and 512 KiB in one message; the oldest are left out first.
- **Receiving.** Every field is checked against the same lists and limits, control characters and terminal escapes are removed, unknown fields are dropped, and a Task that fails a check is dropped. The list is kept whole in `peer/plans/<key>.json` (mode 0600), at most 30 Tasks per teammate across all projects. At most 20 of one teammate's Tasks are shown in one project.
- **Where it counts.** A teammate's Tasks are used only in this machine's project of the same repository, only when that repository is on the board of a team the teammate is on, and never in a project kept off. Tasks named for any other repository are kept and never shown or used.
- **On the board.** In that project the Kanban tab shows teammates' Tasks in the same four columns as your own: an approved one under In progress, a finished one under Done. Each card has its title and then the teammate's name, with `on <machine>` when their machine has a name, then how far it is, its priority and its severity; the name stays when the title is cut. The counts on the columns include them. The line under the board names the whole Task, its state and who works on it, and ends `read-only`. Enter opens the whole Task to read. No key moves, edits, starts or deletes a teammate's card, or makes a card of it; one tells you whose it is. When a teammate's session with that Task is on the board too, the two are one card: the session's, which opens with the Task. When the project is kept off, one line under the columns says so; when its sessions work in no repository with an `origin` remote, one line says teammates do not see them.
- **For the models.** Each turn of the owner's own lead, and of a bot, in that project is given a block headed "What teammates are working on in this project". One line of ours says it is information to avoid doing the same work twice, never a request. Each teammate's Tasks follow inside a peer-data block, the kind used for any teammate's text: title, state, subtasks done, priority, severity, who works on it, and the goal cut to 300 characters. No description. At most 8 teammates, 6 Tasks each and 6000 characters in all. A teammate's question running on this machine is given none of it, and neither is a reviewer. On no team nobody is.
- **Ageing.** A teammate who is offline keeps their Tasks, marked as last heard, for 48 hours after they were last connected. They are deleted at once when that person is no longer on a team with this machine. A finished Task leaves 24 hours after it was done.
- **Older builds.** A machine says `plans: true` in its `elu.hello` when it reads Tasks. One that does not say so is sent no `elu.plans`, and sends none. A machine from before the team board sends no `boards` and ignores them: a teammate's clone of a repository it shares is on no board through it, and its own Tasks go only to the teams it shares that project with, as before.

## Local A2A endpoint

- Off by default. It listens on 127.0.0.1 on a random port; port and token are in `local-a2a.json` (0600).
- Every request needs `Authorization: Bearer <token>`. The Host must be `127.0.0.1:<port>` or `localhost:<port>`, and requests carrying an `Origin` header are refused.
- **Agent Card.** Served at `/.well-known/agent-card.json` with a JSONRPC interface. One skill per share, plus one skill per teammate.
- **Routing.**
  - `SendMessage` at `/a2a` goes to my own agent: an owner-authorised request in the named project (`metadata.project`), queued, not read-only.
  - `SendMessage` at `/a2a/peer/<name>` becomes an ask from me to that teammate.
  - `GetTask` works for both, also after the conductor drops the request row (`local-tasks/`).
  - A client `contextId` is kept (it becomes the ask's thread). A message with `taskId` gets UnsupportedOperation. `SendMessage` returns at once; poll `GetTask`.
- **Conformance.** Tested with the official `@a2a-js/sdk` 1.3.0 client (a dev dependency).
