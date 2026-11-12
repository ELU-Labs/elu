# Peer network

How two ELU Code installs find each other, what they send, and how a team keeps its list of
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
  - **Extensions:** `elu.hello`, `elu.invite.start` `{topic, nonce}`, `elu.invite.prove` `{proof, name, exits?}`, `elu.join` `{teamId, secret, name}`, `elu.roster.get` `{teamId, after}`, `elu.roster.push` `{teamId, ops}`, `elu.picture.put` `{id, seq, last, size, sha256, data}` (see [Pictures](#pictures)).
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
  - With null, the receiver uses the project of its [setting](#what-teammates-can-do-here) for the team, else the share chosen for the team, else its one share. Without any, the message is still taken (SUBMITTED) and waits for the owner, who approves it in a project he has open. ELU Code 0.1.6 and earlier refuse it instead, with "They have not shared a project, so there is nothing of theirs to ask about yet."; a newer sender shows that refusal as a line saying the teammate needs to update.
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
- Asked by `/join` before the join, by the first `/invite` for a team before its code, and changed with `/access` or `elu access [--auto|--manual] [--rules TEXT] [--project PATH]`. `elu join` and `elu invite` take `--auto`, `--manual` and `--rules` too. Without either, `elu invite` on a team that already has other members saves `manual`.
- Leaving a team (`teamLeave`, or the leave written here when the daemon cannot start) and coming back to it with a new invite drop its entry along with its shares. Hearing that this machine was removed from it drops its entry only; its shares are dropped when it comes back. Joining again sets the entry again: `/join` asks, and `elu join` saves its flags or the defaults (`auto`, no rules).
- A question for a shared bot (`bot` in the extension) waits for the owner as before, and is refused when the receiver has no project for it. A teammate set to `autoAccept` in `peers.json` still has its asks and reviews answered read-only while the team has no setting.

Task state mapping:

| ELU Code | A2A |
|---|---|
| waiting for the owner to approve | SUBMITTED |
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
  - **Who answered.** The inviter's proof shows only that the other side knows the code. Anyone the code reached, and anyone with a copy of the inviter's `invites.json`, could answer as the inviter with a team of their own. A join shares no project of the joiner's: the joiner shares a project only with `/share` or `elu share`, and `elu peers` shows the fingerprint of every member. What a join does tell is the approved Tasks of the joiner's clone of a repository a member of the team says they share, when that claim names the repository's first commit and the clone has it ([Tasks](#tasks)). For a public repository anyone can name both. The joiner's Kanban says when this happens, and `/share off` stops it.
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

## Tasks

A Task is a session's approved plan: what the owner agreed the model should do. A team has one board for each repository a member shared with it. Every member's project of that repository is on it, whether that member shared it or not: their machine tells the team which Tasks its sessions there are working on, and shows the others' Tasks on its own Kanban.

- **Same repository, same board.** A project is on a team's board when this machine shares it with that team (`/share`, `elu share`, or the invite that shared it), or, when this machine does not share it, when its `origin` remote is the same repository (the same `repoId`) as a project a member of that team shares with it and this clone has the first commit that member names. The second needs nothing on this machine: a teammate who joins and opens their own clone is on the board without sharing it, and is never asked. A project shared from here is on the boards of the teams it is shared with and no others: a teammate's claim never adds a team the owner did not choose. Never for the home folder or a folder that holds it, never for a project with no `origin` remote, never for a clone without that first commit (a shallow clone may lack it), and never for a project kept off (below).
- **How a machine learns which repositories are on the board.** `elu.status` carries `boards: [{repoId, handle, commit, teams}]`: each project the sender shares with a team the two machines are both on (status on or off), with those teams. `commit` is the repository's first commit (`git rev-list --max-parents=0 HEAD`, the oldest when there are several); a project with no commit yet is not listed, and a row without a valid `commit` is dropped. The receiver checks it with `git cat-file -e <commit>^{commit}` in its own clone, so naming a repository's remote is not enough to bring someone's clone of it onto a board; for a public repository the first commit is public too. At most 20. The receiver keeps the last list from each teammate in `peer/boards/<key>.json` (0600) and replaces it with the next; a claim counts only for a team both machines are active members of. The sender sends a new `elu.status` within a tick of a share, an unshare or a team change. A teammate who is no longer on any team with this machine has their list deleted.
- **Keeping one project off.** `/share off` in a project keeps it off every board both ways: its Tasks are told to nobody, whatever a teammate shares, and teammates' Tasks are neither shown in it nor given to its models. For a project shared from here it also switches its status off. `/share on`, or `/share` again, puts it back. The list is `peer/board-off.json`. `elu unshare` says when someone else's share of the same repository still keeps the project's Tasks on a board.

- **What is told.** For each session of the project, the Task whose work is going on (its newest approved one), and any Task finished within the last 24 hours. Each is `{repoId, handle, id, revision, title, description, goal, objectives, priority, severity, state (approved or done), startedBy (owner, schedule or handoff), who, subtasks: [{text, state}], met, approvedAt, doneAt, updatedAt}`. `who` is the model's name, a shared bot's `@name`, or `bot` for a bot that is not shared.
- **What is never told.** A Task that is only proposed or was rejected, the request and repository that approval starts, the chat, file contents, and any path of the machine. While status is on, a [status row](#status) does carry the first line of that request and the changed paths inside the project.
- **To whom.** Only a teammate on a team whose board the project is on. A project shared from here with `status: false` tells nothing, and neither does a project with no `origin` remote, since it has no `repoId`. One that is not shared from here tells nothing unless a member shares its repository with a team and this clone has the first commit they name.
- **When.** `elu.plans` carries the whole present list for that teammate. It is sent on connect, and within 5 s of a change (so at most one every 5 s to each teammate, well inside the 20 requests in 10 s a connection allows): an approval, a subtask's state, a finished Task, a new revision, a repository newly on a board. A Task that ended, or whose project left the board, is absent from the next list, and the receiver replaces what it had.
- **Size.** At most 30 Tasks and 512 KiB in one message; the oldest are left out first.
- **Receiving.** Every field is checked against the same lists and limits, control characters and terminal escapes are removed, unknown fields are dropped, and a Task that fails a check is dropped. The list is kept whole in `peer/plans/<key>.json` (mode 0600), at most 30 Tasks per teammate across all projects. At most 20 of one teammate's Tasks are shown in one project.
- **Where it counts.** A teammate's Tasks are used only in this machine's project of the same repository, only when that repository is on the board of a team the teammate is on, and never in a project kept off. Tasks named for any other repository are kept and never shown or used.
- **On the board.** In that project the Kanban tab shows teammates' Tasks in the same four columns as your own: an approved one under In progress, a finished one under Done. Each card has its title and then the teammate's name, with `on <machine>` when their machine has a name, then how far it is, its priority and its severity; the name stays when the title is cut. The counts on the columns include them. The line under the board names the whole Task, its state and who works on it, and ends `read-only`. Enter opens the whole Task to read. No key moves, edits, starts or deletes a teammate's card, or makes a card of it; one tells you whose it is. When this project's own Tasks do not reach the team, one line under the columns says why: no `origin` remote, the home folder, kept off, or status off. When they reach it through someone else's share, the line names the team and who shares the repository, and says `/share off` keeps them off. A project whose repository nobody on the team shares has no line.
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
