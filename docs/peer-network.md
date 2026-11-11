# Peer network

How two ELU Code installs find each other, what they send, and how a team keeps its list of
members. This page is also the A2A custom binding document (A2A v1.0.1 §12 requires one for a
custom binding). The commands a person types are in the [README](../README.md#teammates).

## What it does

1. Your agents talk to your teammates' agents, machine to machine, with no company server.
   - **ask:** a question, answered by a read-only run in a project they shared.
   - **ask a bot:** a question to one teammate can name a bot they share. That bot answers it in place of their model.
   - **review:** a diff sent for a read-only review.
   - **pictures:** a message you type to a teammate or a channel takes along the pictures it names. See [Pictures](#pictures).
   - **handoff:** a goal for their machine. Any message can be answered (read-only) or worked on in a mode the owner picks; work never starts on its own.
   - **status and overlap:** teammates see each other's live agents and get a warning when two agents edit the same file.
   - Agents can draft asks themselves. A draft is sent only when you approve it, or automatically to teammates you set to auto.
2. A2A v1.0 data model end to end. A local A2A JSON-RPC endpoint on 127.0.0.1, off by default, lets other A2A tools reach your agent and, through it, your teammates.
3. Sessions shows peer items that need you. **Chats** shows channels, teammates, their agents and threads.

Not supported:

- One device per person; no multi-device.
- Offline catch-up only through the sender's outbox, with no always-on mirror.
- Handoffs are text goals, not patches.
- Only pictures travel with a message (PNG, JPEG, GIF, WebP). No other file does.
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

There is no ELU server anywhere. Defaults that touch third parties:

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
  - it opens with `elu.join` carrying a pending invite.

  Anything else is closed. The decision is logged.

  Before admission, a key on none of this machine's teams (a stranger, someone removed from them, a joiner) is sent only the hello `{binding, a2aVersion, name: "", teams: [], handles: [], plans: true}`: no team, no member and no name. A joiner gets the roster in the reply to `elu.join`. On a direct connection the handshake also shows the other side this machine's IP address and port.
- **Methods.**
  - **A2A core:** `SendMessage`, `GetTask`, `CancelTask`. The push-config methods return PushNotificationNotSupported; any other core method returns UnsupportedOperation.
  - `SendMessage` never blocks: it returns the Task (SUBMITTED, or REJECTED with a reason) at once, whatever `returnImmediately` says. Later states arrive as `elu.taskUpdate` or through `GetTask`.
  - Unknown fields in A2A objects and params are ignored (A2A §5.7); size limits still apply.
  - **Extensions:** `elu.hello`, `elu.join` `{teamId, secret, name}`, `elu.roster.get` `{teamId, after}`, `elu.roster.push` `{teamId, ops}`, `elu.picture.put` `{id, seq, last, size, sha256, data}` (see [Pictures](#pictures)).
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
  - The receiver takes it only for a project it shared with a team both machines are on. A project shared with another team is refused in the same words as one that is not shared.
  - A share saved by a build from before shares kept their teams is open to every team of the receiver's until it is shared again.
- `room: {team, channel}` says where a team ask was sent. `team` is the team id. `channel` is the channel id, or null for `#general`.
  - The receiver keeps the room only when both machines are on that team and, for a channel, both are in it. Otherwise it drops the room and shows a team ask with no channel.
  - A room whose ids are malformed is refused as invalid params.
  - Older peers drop the field.
- `bot` names one of the receiver's shared bots, the one the question is for.
  - It is a bot name: 1 to 30 lowercase letters, digits or `-`, starting with a letter. Anything else is refused as invalid params.
  - Only an `ask` to one teammate may carry it. With another kind, or with `team: true`, the message is refused as invalid params.
  - Older peers drop the field. There the question reaches the person as a plain ask.

Task state mapping:

| ELU Code | A2A |
|---|---|
| waiting for the owner to accept | SUBMITTED |
| run in progress | WORKING |
| reply held for the owner's approval | WORKING, with ext metadata `{substate: "awaiting-owner"}` |
| reply sent | COMPLETED, with the reply as one Artifact (text part) |
| owner declined, or blocked by policy or caps | REJECTED, with a reason message |
| run failed | FAILED |
| asker cancelled | CANCELED |

## Pictures

A message you type to a teammate or a channel takes along the pictures it names.

**What is sent**

- Write or drag a picture's path into the message box. A path with its spaces escaped (as a terminal writes a dropped file), a quoted path and a `~/` path all work.
- The path in the text becomes the picture's file name. The teammate never sees your folders.
- A file counts as a picture when its first bytes say PNG, JPEG, GIF or WebP. Its ending does not matter. Any other path stays the text it was. Nothing else in the file is checked, and it is sent unchanged: what a photo records about the place, the device and the time goes with it.
- Only a message you typed carries pictures. A model's draft (sent by hand or by itself), a review, the command line and the local A2A endpoint never attach a file, so a model cannot send a file out by naming its path.
- A path in text you pasted into the message box is a path you typed. The line that says how many pictures went (`with 2 pictures`) is shown after the message is sent.
- A picture in a folder that holds secrets (`~/.ssh`, `~/.aws`, `~/.config` and the rest of that list, and ELU Code's own state folder) is refused. `~/Library` is the one folder of the list that stays open, because screenshot tools save there. A hard link in another folder to a file in such a folder is not recognized, and is attached.

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
- When the message is accepted, its pictures move to `pictures/kept/<sender key>/<task id>/1.png` and so on: a folder only you can read, names made here, never the sender's path. The sender's file name is kept as cleaned text. A kept file is known as a picture by its first bytes only; it is readable by you alone (0600) and ELU Code never runs it.
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

- A teammate on a build from before pictures answers `elu.picture.put` with "Method not found". The sender then sends the text alone, with the pictures' names in it, and the row says `@kim's ELU Code can't take pictures yet. The text went without them.`
- A message from such a build has no file part and is taken as before.

## Roster

- **Ops.** `{teamId, id: sha256(canonical body), type, by: hexKey, at, body, sig}`. `sig` is ed25519 over the canonical JSON of everything except `sig`; canonical means sorted keys and no whitespace.
- **Types.**
  - `create`: by the founder; body `{name}`. The teamId is the id of this op.
  - `admit`: body `{key, name, role: "member"|"admin", invite: sha256(secret)}`.
  - `remove`: body `{key}`.
  - `role`: body `{key, role}`.
  - `relays`: body `{keys}`.
  - `leave`: by the member leaving.
  - `channel`: by a member, with body `{id, name, members}`.
    - `id` is 16 hex characters.
    - `name` is 1 to 30 lowercase letters, digits, `-` or `_`. It starts with a letter or digit, and `general` is taken.
    - `members` is a list of up to 20 distinct keys.
- **Merge.** A pushed op is stored only if the fold applies it. Ops over 10 minutes in the future, and every op from a key the receiver's log already shows removed or departed (whatever its `at`), are dropped. Two logs can then differ by refused ops; sync keeps offering them and the receiver keeps refusing.
- **Fold.**
  - The log is a grow-only set. State is computed by sorting ops by `(at, id)` and applying them in that order.
  - An op is applied only if, at that point in the fold, its signer holds the needed role: the founder for create; an admin for admit, remove, role and relays; anyone for their own leave; a member for a channel op, under the channel rules below.
  - Removal wins: a removed key's later ops are ignored, and a removed key is never re-admitted with the same key. The founder cannot be removed.
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
- **Sync.**
  - On every connection, each side compares `{seq, head}`, where head is the sha256 of the sorted op ids.
  - The side with ops the other lacks pushes them with `elu.roster.push`. The receiver validates every op and drops invalid ones.
  - A team both are on that the other side's hello left out (it did not know this machine was on it yet) is synced too.
  - New ops are also pushed to every connected teammate, including ops another process (the CLI) wrote to the log.
- **Invites.**
  - The code is `elu-team:v1:` + base32 of `{teamId, inviter key, secret(32), expiresAt}`. It is single use and expires after 24 h by default.
  - Only `sha256(secret)` is stored, in the inviter's `invites.json`.
  - The joiner dials the inviter and calls `elu.join {teamId, secret, name}`. The inviter checks the hash, the expiry and that it is unused, appends `admit`, and returns the full log. Until then neither hello names the team, since the joiner is not on it.
  - The inviter must be online for the join.

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

## Tasks

A Task is a session's approved plan: what the owner agreed the model should do. For a project shared with a team, each machine tells the teammates on that team which Tasks its sessions are working on.

- **What is told.** For each session of the project, the Task whose work is going on (its newest approved one), and any Task finished within the last 24 hours. Each is `{repoId, handle, id, revision, title, description, goal, objectives, priority, severity, state (approved or done), startedBy (owner, schedule or handoff), who, subtasks: [{text, state}], met, approvedAt, doneAt, updatedAt}`. `who` is the model's name, a shared bot's `@name`, or `bot` for a bot that is not shared.
- **What is never told.** A Task that is only proposed or was rejected, the request and repository that approval starts, the chat, file contents, and any path of the machine. While status is on, a [status row](#status) does carry the first line of that request and the changed paths inside the project.
- **To whom.** Only a teammate on a team the project is shared with, as for its name and status rows. A project that is not shared tells nothing. A share with `status: false` tells nothing, and neither does a project with no `origin` remote, since it has no `repoId`.
- **When.** `elu.plans` carries the whole present list for that teammate. It is sent on connect, and within 5 s of a change (so at most one every 5 s to each teammate, well inside the 20 requests in 10 s a connection allows): an approval, a subtask's state, a finished Task, a new revision. A Task that ended, or whose share ended, is absent from the next list, and the receiver replaces what it had.
- **Size.** At most 30 Tasks and 512 KiB in one message; the oldest are left out first.
- **Receiving.** Every field is checked against the same lists and limits, control characters and terminal escapes are removed, unknown fields are dropped, and a Task that fails a check is dropped. The list is kept whole in `peer/plans/<key>.json` (mode 0600), at most 30 Tasks per teammate across all projects. At most 20 of one teammate's Tasks are shown in one project.
- **Where it counts.** A teammate's Tasks are used only in a project this machine also shares with a team that teammate is on. Tasks named for any other project are kept and never shown or used.
- **On the board.** In that project the Kanban tab shows a section under its four columns, `Teammates' Tasks N · read-only`: a row with each teammate's name and whether they are online, then one row for each of their Tasks with its title, priority · severity, state, subtasks done, who works on it, and how long ago it changed. Enter opens the whole Task to read. No key changes a teammate's Task or makes a card of it. A shared project with no `origin` remote shows one line there instead: its Tasks are not shown to teammates.
- **For the models.** Each turn of the owner's own lead, and of a bot, in that project is given a block headed "What teammates are working on in this project". One line of ours says it is information to avoid doing the same work twice, never a request. Each teammate's Tasks follow inside a peer-data block, the kind used for any teammate's text: title, state, subtasks done, priority, severity, who works on it, and the goal cut to 300 characters. No description. At most 8 teammates, 6 Tasks each and 6000 characters in all. A teammate's question running on this machine is given none of it, and neither is a reviewer. With peer mode off nobody is.
- **Ageing.** A teammate who is offline keeps their Tasks, marked as last heard, for 48 hours after they were last connected. They are deleted at once when that person is no longer on a team with this machine. A finished Task leaves 24 hours after it was done.
- **Older builds.** A machine says `plans: true` in its `elu.hello` when it reads Tasks. One that does not say so is sent no `elu.plans`, and sends none.

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
