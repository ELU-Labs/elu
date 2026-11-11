import fs from 'node:fs';
import path from 'node:path';
import { atomic, hash, isObject, mkdir, noSymlinks, readJson, refuse } from '../util.mjs';
import { lock } from '../state.mjs';
import { peerFile, peerRepo, peerDir } from './paths.mjs';
import { peerPolicy, peerSettings, savePeerPolicy } from './settings.mjs';
import { sanitize } from './peerdata.mjs';
import { identity as loadIdentity, validName } from './identity.mjs';
import { head, merge, opsMissing, readLog, setChannel, team, teamPath, teams } from './roster.mjs';
import { parseInvite, redeemInvite } from './invite.mjs';
import { shares, sharedWith } from './shares.mjs';
import { createNode } from './transport.mjs';
import { Session } from './rpc.mjs';
import { intakeMethods, sharedTeams } from './intake.mjs';
import { acceptIncoming, declineIncoming, discardReply, processOutbox, sendReply, syncRecords } from './replies.mjs';
import { applyTask, asks as sentAsks, autoDrafts, continueAnswer, createAsk, discardDraft, dismissAsk, dismissTeam, reconnect, reviewText, sendDraft, teamAsk, tickAsks } from './asks.mjs';
import { cleanBots, cleanBox, saveRemoteStatus, statusRows, thisMachine } from './status.mjs';
import { fitPlans, heardPlans, planRows, prunePlans, saveRemotePlans } from './plans.mjs';
import { ErrorCode, TaskState, a2aError, artifact, peerExt, task as a2aTask } from './a2a.mjs';
import { buildAgentCard, startLocalA2A } from './a2a-http.mjs';
import { enqueue, startConductor } from '../conductor.mjs';
import { capMode, defaultMode } from '../modes.mjs';
import { pendingRequests } from '../workspace.mjs';
import { readTask } from '../state.mjs';
import { registeredProjects } from '../projects.mjs';
import { getAsk } from './asks.mjs';
import { getRecord, prune } from './taskstore.mjs';
import { pictureMethods, stagedPictures, sweepPictures } from './pictures.mjs';

// The peer daemon (docs/peer-network.md, "Layers"): one per user, holding peer.lock. It
// talks to the TUI and CLI only through files: commands/ in, commands/*.result.json and
// state.json out. It dials every active teammate, serves their A2A calls, and moves
// conductor outbox entries back to them.
const HEX64 = /^[0-9a-f]{64}$/;
const COMMAND = /^[A-Za-z0-9-]{1,64}$/;
const WAKE_MS = 30000;
const LOG_MAX = 1024 * 1024;
const active = (state, key) => state.members.some(m => m.key === key && !m.removed);

// local-tasks/<requestId>.json: {id, root, contextId, taskId, createdAt} for each /a2a
// request, so GetTask answers after the conductor drops the row. Kept 7 days.
const LOCAL = /^request-[a-f0-9-]{1,64}$/;
const localFile = id => peerFile('local-tasks', `${id}.json`);
const saveLocal = row => atomic(localFile(row.id), row);
function getLocal(id) {
  if (!LOCAL.test(id ?? '')) return null;
  try { const file = localFile(id); noSymlinks(file); if (!fs.existsSync(file)) return null; const value = readJson(file); return isObject(value) && value.id === id ? value : null; } catch { return null; }
}
function locals() {
  const folder = peerFile('local-tasks'); noSymlinks(folder); if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter(name => name.endsWith('.json')).flatMap(name => { const row = getLocal(name.slice(0, -5)); return row ? [row] : []; });
}
function pruneLocal(now) { for (const row of locals()) if (now - Date.parse(row.createdAt) > 7 * 24 * 3600000) fs.rmSync(localFile(row.id), { force: true }); }

export class PeerDaemon {
  constructor({ tickMs = 2000, statusMs = 10000, conductor = startConductor, testing = {}, requireEnabled = true, onExit } = {}) {
    Object.assign(this, { tickMs, statusMs, conductor, testing, requireEnabled, onExit });
    this.sessions = new Map(); this.handles = new Map(); this.joins = new Map(); this.waiters = new Map();
    this.running = new Set(); this.rows = []; this.rowsDigest = null; this.statusAt = 0; this.error = null;
    // machines: what each teammate last said their machine is called and shares; mine: what this one tells them.
    this.machines = new Map(); this.mine = null;
  }
  async start() {
    if (this.requireEnabled && !peerSettings().enabled) refuse('Peer mode is off. Turn it on with elu peer on.');
    mkdir(peerDir());
    this.release = lock(peerRepo(), 'peer');
    try {
      this.me = loadIdentity(); this.recall(); this.mine = thisMachine();
      const settings = peerSettings();
      this.ctx = {
        me: this.me, event: text => this.event(text), kick: () => this.kick(), dial: key => this.node.dial(key),
        session: key => { const s = this.sessions.get(key); return s?.admitted ? s : null; },
        push: (key, task) => this.ctx.session(key)?.notify('elu.taskUpdate', { task }),
      };
      const relays = [...new Set([...teams().flatMap(state => active(state, this.me.key) ? state.relays : []), ...(Array.isArray(settings.relays) ? settings.relays : [])])];
      this.node = await createNode({ identity: this.me, bootstrap: settings.bootstrap, relays, testing: this.testing });
      this.node.on('connection', (socket, key) => this.attach(socket, key));
      this.methods = pictureMethods(this.ctx, { ...intakeMethods(this.ctx), ...this.extensions() });
      await this.node.listen();
    } catch (error) { await this.node?.destroy().catch(() => {}); this.release(); throw error; }
    this.startedAt = new Date().toISOString(); this.lastTick = Date.now();
    this.dialAll();
    try { fs.mkdirSync(peerFile('outbox'), { recursive: true, mode: 0o700 }); this.watcher = fs.watch(peerFile('outbox'), () => this.soon()); } catch { /* Polling still runs. */ }
    this.timer = setInterval(() => this.tick(), this.tickMs); this.tick();
    // A transient node (joinTeam with the daemon off) only joins.
    if (this.requireEnabled && peerSettings().localA2A) { try { this.local = await this.startLocal(); } catch (error) { this.event(`local A2A did not start: ${error.message}`); } }
    this.log(`started ${this.me.fingerprint}`);
    return this;
  }
  async stop() {
    if (this.closed) return; this.closed = true;
    clearInterval(this.timer); clearTimeout(this.soonTimer); this.watcher?.close();
    for (const session of this.sessions.values()) session.close();
    await this.local?.close().catch(() => {});
    await this.node?.destroy().catch(() => {});
    try { this.heartbeat(true); } catch { /* Best effort. */ }
    this.log('stopped');
    try { this.release?.(); } catch { /* Already gone. */ }
  }
  soon() { clearTimeout(this.soonTimer); this.soonTimer = setTimeout(() => this.tick(), 50); }
  kick() { try { this.conductor(); } catch (error) { this.log(`conductor did not start: ${error.message}`); } }
  log(text) {
    try {
      const file = peerFile('daemon.log'); noSymlinks(file);
      if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX) fs.truncateSync(file, 0);
      fs.appendFileSync(file, `${new Date().toISOString()} ${sanitize(text, 500)}\n`, { mode: 0o600 });
    } catch { /* Logging never stops the daemon. */ }
  }
  event(text) { this.log(text); }
  name(key) { return sanitize(teams().flatMap(state => state.members).find(m => m.key === key)?.name ?? key.slice(0, 8), 64); }
  myTeams() { return teams().filter(state => active(state, this.me.key)); }
  teammateKeys() { return [...new Set(this.myTeams().flatMap(state => state.members.filter(m => !m.removed && m.key !== this.me.key).map(m => m.key)))]; }
  dialAll() {
    const keys = new Set(this.teammateKeys());
    for (const key of keys) this.node.dial(key);
    for (const key of this.dialled ?? []) if (!keys.has(key) && !this.joins.has(key)) this.node.leave(key);
    this.dialled = keys;
  }

  tick() {
    if (this.closed || this.busy) return; this.busy = true;
    const now = Date.now();
    try {
      // A long gap between ticks means the machine slept: announce again and redial.
      if (now - this.lastTick > WAKE_MS) { this.event('woke up; reconnecting'); this.node.refresh().catch(() => {}); this.dialAll(); }
      this.lastTick = now;
      this.commands();
      processOutbox(this.ctx); syncRecords(this.ctx, now); tickAsks(this.ctx, now); autoDrafts(this.ctx);
      this.forwardLocal(); this.syncLocal();
      if (now - (this.pruneAt ??= 0) > 3600000) { this.pruneAt = now; prune(now); pruneLocal(now); sweepPictures(set => sentAsks().some(row => row.state === 'pending' && row.pictures?.set === set), now); this.forgetPlans(now); }
      this.retell();
      if (now - this.statusAt >= this.statusMs) { this.statusAt = now; this.status(); }
      if (now - (this.plansAt ??= 0) >= (this.plansMs ?? 5000)) { this.plansAt = now; this.tellPlans(); }
      if (now - (this.routingAt ??= now) > 5 * 60000) { this.routingAt = now; this.node.saveRouting(); }
      this.error = null;
    } catch (error) { this.error = error.message; this.log(`tick: ${error.message}`); }
    finally { this.busy = false; }
    try { this.heartbeat(); } catch (error) { this.log(`heartbeat: ${error.message}`); }
  }
  // state.json in the facade's peerStatus shape, plus this machine's status rows.
  heartbeat(stopped = false) {
    const connections = this.node?.connections ?? new Map();
    const member = m => {
      const conn = connections.get(m.key), online = m.key === this.me.key || Boolean(this.sessions.get(m.key)?.admitted);
      const machine = m.key === this.me.key ? this.mine : this.machines.get(m.key);
      return { key: m.key, fingerprint: m.key.slice(0, 8), name: sanitize(m.name, 64), role: m.role, online: online && !stopped, path: m.key === this.me.key ? null : conn?.path ?? null, lastSeen: conn ? new Date(conn.lastSeen).toISOString() : this.lastSeen?.[m.key] ?? null, ...(this.handles.get(m.key) ? { handles: this.handles.get(m.key) } : {}), ...(machine ? { box: machine.box, bots: machine.bots } : {}) };
    };
    for (const [key, conn] of connections) (this.lastSeen ??= {})[key] = new Date(conn.lastSeen).toISOString();
    atomic(peerFile('state.json'), {
      running: !stopped, stopped, pid: process.pid, at: new Date().toISOString(), startedAt: this.startedAt, key: this.me.key, fingerprint: this.me.fingerprint, name: this.me.name, error: this.error,
      teams: this.myTeams().map(state => ({ id: state.id, name: state.name, role: state.members.find(m => m.key === this.me.key)?.role ?? 'member', members: state.members.filter(m => !m.removed).map(member),
        channels: state.channels.filter(row => row.members.includes(this.me.key)).map(row => ({ id: row.id, name: row.name, members: row.members })) })),
      counters: { ...(this.node?.counters ?? { direct: 0, relayed: 0, failed: 0 }) },
      rows: this.rows,
    });
  }
  status(force = false) {
    let rows; try { rows = statusRows(); } catch (error) { this.log(`status: ${error.message}`); return; }
    const digest = hash(JSON.stringify(rows));
    if (!force && digest === this.rowsDigest) return;
    this.rows = rows; this.rowsDigest = digest;
    this.announce();
  }
  // elu.status carries the rows, and with them this machine's box name and shared bots. A
  // build from before bots reads only the rows. It goes to a teammate on connect and to
  // everyone connected when any of the three changes.
  announce(only = null) {
    const mine = this.mine ??= thisMachine();
    for (const session of only ? [only] : this.sessions.values()) if (session.admitted) { const open = this.openTo(session.key); session.notify('elu.status', { rows: this.rows.filter(row => open.has(row.handle)), ...mine }); }
  }
  // A project's name and its live rows go only to a teammate on a team it is shared with. A
  // shares file that cannot be read shares none.
  openTo(key) {
    try { const ids = sharedTeams(this.me.key, key).map(state => state.id); return new Set(shares().filter(row => sharedWith(row, ids)).map(row => row.handle)); }
    catch { return new Set(); }
  }
  // elu.plans carries the Tasks this machine's sessions work on in the projects open to
  // that teammate (plans.mjs): the whole present list each time, so a Task that ended and a
  // share that ended are simply absent from the next one. It goes on connect, and when
  // that list changes. Only a teammate whose hello said it reads Tasks is sent any.
  tellPlans(only = null) {
    let rows; try { rows = planRows(); } catch (error) { this.log(`plans: ${error.message}`); return; }
    const told = this.plansTold ??= new Map();
    for (const session of only ? [only] : this.sessions.values()) if (session.admitted && session.remoteHello?.plans === true) {
      const open = this.openTo(session.key), tasks = fitPlans(rows.filter(row => open.has(row.handle))), digest = hash(JSON.stringify(tasks));
      if (!only && told.get(session.key) === digest) continue;
      told.set(session.key, digest); session.notify('elu.plans', { tasks });
    }
  }
  // What teammates told this machine is dropped when they are no longer teammates, and
  // 48 hours after they were last connected.
  forgetPlans(now = Date.now()) {
    try { prunePlans({ teammates: this.teammateKeys(), online: [...this.sessions.values()].filter(session => session.admitted).map(session => session.key), now }); }
    catch (error) { this.log(`plans: ${error.message}`); }
  }
  // The box name and the bots file are read again on every tick, so a renamed machine or
  // a bot shared, changed or taken back reaches teammates within a few seconds.
  retell() {
    const mine = thisMachine(), changed = JSON.stringify(mine) !== JSON.stringify(this.mine);
    this.mine = mine; if (changed) this.announce();
  }
  // What teammates said about their machines stays in state.json when the daemon stops,
  // so the next start still knows it for those who are offline.
  recall() {
    let saved = null; try { const file = peerFile('state.json'); noSymlinks(file); if (fs.existsSync(file)) saved = readJson(file); } catch { /* Starts with none. */ }
    if (!isObject(saved) || saved.key !== this.me.key || !Array.isArray(saved.teams)) return;
    for (const state of saved.teams.slice(0, 32)) for (const m of Array.isArray(state?.members) ? state.members.slice(0, 256) : []) {
      if (isObject(m) && HEX64.test(m.key ?? '') && m.key !== this.me.key && (Object.hasOwn(m, 'box') || Object.hasOwn(m, 'bots'))) this.machines.set(m.key, { box: cleanBox(m.box), bots: cleanBots(m.bots) });
    }
  }

  // Connections. Admission happens here, after the hello (see rpc.mjs).
  // key: the key this hello goes to, which Noise proved before the first frame. The hello
  // lists only my teams that key is an active member of here, each with the ops that admit
  // me, and carries my name only when it lists a team. A key on none of my teams (a stranger,
  // someone removed, a joiner) learns no team, member or name; a joiner gets the roster in
  // the reply to elu.join. One admitted by this same exchange is not on my roster yet, so
  // my name and project names reach them on the next connect.
  hello(key) {
    const proof = id => {
      const { ops } = readLog(id), out = [], founder = ops.find(op => op.type === 'create');
      if (!founder) return [];
      let key = this.me.key;
      while (key !== founder.by && out.length < 7) {
        const admit = ops.filter(op => op.type === 'admit' && op.body.key === key).sort((a, b) => a.at - b.at)[0]; if (!admit) break;
        out.push(admit, ...ops.filter(op => op.type === 'role' && op.body.key === admit.by).slice(0, 1)); key = admit.by;
      }
      return [founder, ...out].slice(0, 8);
    };
    const known = sharedTeams(this.me.key, key).slice(0, 32);
    return { name: known.length ? this.me.name.slice(0, 64) : '', teams: known.map(state => ({ id: state.id, ...head(state.id), ops: proof(state.id) })), handles: [...this.openTo(key)].slice(0, 20), plans: true };
  }
  admit(hello, session) {
    const key = session.key;
    if (this.joins.has(key)) return 'member';
    // A teammate admitted elsewhere proves it with the ops that admit it.
    for (const entry of hello.teams) {
      const state = team(entry.id);
      // A key that is gone from the team gets no say in its log, here or through sync.
      if (!state || !active(state, this.me.key) || state.members.some(m => m.key === key) || !Array.isArray(entry.ops)) continue;
      try { const { added } = merge(entry.id, entry.ops.slice(0, 8)); if (added.length) this.forward(entry.id, added, key); } catch (error) { this.log(`proof: ${error.message}`); }
    }
    if (sharedTeams(this.me.key, key).length) return 'member';
    return this.invitesOpen() ? 'join' : null;
  }
  invitesOpen() {
    return this.myTeams().some(state => {
      try { const file = teamPath(state.id, 'invites.json'); noSymlinks(file); return fs.existsSync(file) && readJson(file).some(row => row?.usedBy === null && row.expiresAt > Date.now()); } catch { return false; }
    });
  }
  attach(socket, key) {
    if (this.closed || !HEX64.test(key)) return void socket.destroy();
    const session = new Session(socket, { key, hello: () => this.hello(key), admit: (hello, s) => this.admit(hello, s), methods: this.methods, log: text => this.log(text), onError: error => this.log(`handler: ${error.message}`) });
    // A refusal to a trusted teammate keeps its paths; read per refusal.
    session.trusted = () => peerPolicy(key).trusted;
    session.on('admitted', () => this.admitted(session));
    session.on('close', () => {
      if (this.sessions.get(key) !== session) return;
      this.sessions.delete(key); this.event(`@${this.name(key)} offline`);
      this.plansTold?.delete(key); try { heardPlans(key); } catch { /* Their Tasks keep the time they were last told. */ }
    });
  }
  admitted(session) {
    const key = session.key, previous = this.sessions.get(key);
    this.sessions.set(key, session);
    if (previous && previous !== session) previous.close('replaced by a newer connection');
    const handles = Array.isArray(session.remoteHello?.handles) ? session.remoteHello.handles.filter(h => typeof h === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(h)).slice(0, 20) : [];
    this.handles.set(key, handles);
    for (const waiter of this.waiters.get(key) ?? []) waiter(session);
    this.waiters.delete(key);
    if (this.joins.has(key)) return;
    this.event(`@${this.name(key)} online`);
    this.sync(session).catch(error => this.log(`sync: ${error.message}`))
      .then(() => reconnect(this.ctx, key)).catch(error => this.log(`reconnect: ${error.message}`));
    // Sent even when empty, so a teammate drops rows of tasks that ended while apart.
    this.announce(session);
    this.tellPlans(session);
  }
  // Roster sync: where heads differ, each side lists its op ids and pushes what the other lacks.
  // A hello lists only the teams its sender knows the receiver is on, so a team we share that
  // their hello left out is one where they did not know me yet: it is synced too, so they get
  // the ops they lack. A joiner already has the whole log from the reply to elu.join.
  async sync(session) {
    const listed = new Map((session.remoteHello?.teams ?? []).map(entry => [entry.id, entry.head]));
    const ids = [...listed.keys()].filter(id => { const state = team(id); return state && active(state, this.me.key) && state.members.some(m => m.key === session.key); });
    if (!session.joinAccepted) for (const state of sharedTeams(this.me.key, session.key)) if (!listed.has(state.id)) ids.push(state.id);
    for (const teamId of ids) {
      if (session.state === 'closed') return;
      if (head(teamId).head === listed.get(teamId)) continue;
      try {
        const { ids: theirs } = await session.request('elu.roster.get', { teamId });
        const missing = opsMissing(teamId, Array.isArray(theirs) ? theirs : []);
        for (let i = 0; i < missing.length; i += 500) await session.request('elu.roster.push', { teamId, ops: missing.slice(i, i + 500) });
      } catch (error) { this.log(`sync ${teamId.slice(0, 8)}: ${error.message}`); }
    }
  }
  forward(teamId, ops, except) {
    const state = team(teamId); if (!state) return;
    this.noteOps(teamId, ops);
    for (const session of this.sessions.values()) {
      if (session.key !== except && session.admitted && active(state, session.key)) session.request('elu.roster.push', { teamId, ops }).catch(() => {});
    }
  }
  // Ops written by another process (the CLI's relay op, an invite redeemed by a transient
  // node) are pushed to connected teammates on the next tick. Ops this daemon merged or
  // forwarded itself are noted first, so they are not pushed twice.
  noteOps(teamId, ops) { const known = this.knownOps?.get(teamId); for (const op of ops) known?.add(op.id); }
  forwardLocal() {
    this.knownOps ??= new Map();
    for (const state of this.myTeams()) {
      const ids = readLog(state.id).ops, known = this.knownOps.get(state.id);
      this.knownOps.set(state.id, new Set(ids.map(op => op.id)));
      const fresh = known ? ids.filter(op => !known.has(op.id)) : [];
      if (fresh.length) { this.forward(state.id, fresh); this.recheck(); }
    }
  }
  // After a roster change: close teammates who are gone and dial new ones.
  recheck() {
    for (const session of [...this.sessions.values()]) if (!this.joins.has(session.key) && !sharedTeams(this.me.key, session.key).length) session.close('no longer a teammate');
    this.dialAll(); this.forgetPlans();
  }
  extensions() {
    const teamOf = (params, session) => {
      if (!isObject(params) || !HEX64.test(params.teamId ?? '')) refuse('Choose a team.');
      const state = team(params.teamId);
      if (!state || !active(state, this.me.key) || !active(state, session.key)) refuse('That team is not shared with you.');
      return state;
    };
    return {
      'elu.join': (params, session) => {
        if (!isObject(params) || !HEX64.test(params.teamId ?? '') || !HEX64.test(params.secret ?? '') || !validName(params.name)) refuse('This invite is not valid.');
        const op = redeemInvite(params.teamId, params.secret, session.key, params.name);
        this.event(`@${sanitize(params.name, 40)} joined`);
        this.forward(params.teamId, [op], session.key);
        session.joinAccepted = true; setImmediate(() => this.dialAll());
        return { ops: readLog(params.teamId).ops };
      },
      'elu.roster.get': (params, session) => {
        const state = teamOf(params, session), after = Number.isSafeInteger(params.after) ? params.after : 0;
        return { teamId: state.id, ids: readLog(state.id).ops.filter(op => op.at > after).map(op => op.id) };
      },
      'elu.roster.push': (params, session) => {
        const state = teamOf(params, session);
        if (!Array.isArray(params.ops) || params.ops.length > 5000) refuse('Roster ops must be a list.');
        const { added, rejected } = merge(state.id, params.ops);
        if (added.length) { this.forward(state.id, added, session.key); setImmediate(() => this.recheck()); }
        if (rejected.length) this.log(`roster push from ${session.key.slice(0, 8)}: ${rejected.length} refused`);
        return { added: added.length, rejected: rejected.length };
      },
      // A teammate on a build from before bots sends only rows: no box name and no bots.
      'elu.status': (params, session) => {
        if (!session.admitted || !isObject(params)) return null;
        saveRemoteStatus(session.key, params.rows); this.machines.set(session.key, { box: cleanBox(params.box), bots: cleanBots(params.bots) });
        return null;
      },
      // A teammate's Tasks: the list replaces what they said before, each field cleaned on the way in.
      'elu.plans': (params, session) => { if (session.admitted && isObject(params)) saveRemotePlans(session.key, params.tasks); return null; },
      'elu.taskUpdate': (params, session) => { if (session.admitted && isObject(params)) applyTask(this.ctx, session.key, params.task); return null; },
    };
  }
  waitSession(key, timeoutMs) {
    const now = this.sessions.get(key); if (now?.admitted) return Promise.resolve(now);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.set(key, (this.waiters.get(key) ?? []).filter(w => w !== done)); reject(new Error('The inviter is not reachable. They must be online for you to join.')); }, timeoutMs);
      const done = session => { clearTimeout(timer); resolve(session); };
      this.waiters.set(key, [...this.waiters.get(key) ?? [], done]);
    });
  }
  // Invite join over the network: dial the inviter, call elu.join, store the log.
  async join(code, { timeoutMs = 60000 } = {}) {
    const invite = parseInvite(code);
    if (invite.expiresAt <= Date.now()) refuse('This invite has expired.');
    if (invite.inviter === this.me.key) refuse('This is your own invite.');
    const known = team(invite.teamId);
    if (known && active(known, this.me.key)) refuse('You are already on this team.');
    this.joins.set(invite.inviter, invite);
    try {
      this.node.dial(invite.inviter);
      const session = await this.waitSession(invite.inviter, timeoutMs);
      const result = await session.request('elu.join', { teamId: invite.teamId, secret: invite.secret, name: this.me.name });
      if (!Array.isArray(result?.ops)) refuse('The inviter sent no roster.');
      merge(invite.teamId, result.ops);
      const state = team(invite.teamId);
      if (!state || !active(state, this.me.key)) refuse('The inviter did not admit you.');
      this.event(`joined ${state.name}`);
      return { id: state.id, name: state.name };
    } finally {
      this.joins.delete(invite.inviter);
      const session = this.sessions.get(invite.inviter);
      if (session && sharedTeams(this.me.key, invite.inviter).length) { this.admitted(session); } else session?.close('join ended');
      this.dialAll();
    }
  }

  // The local A2A endpoint (docs/peer-network.md, "Local A2A endpoint"): /a2a/peer/<name>
  // becomes an ask to that teammate; /a2a queues an owner request in metadata.project.
  startLocal() {
    // A name that is not URL-safe is routed by its fingerprint, which teammate() also accepts.
    const teammates = () => this.teammateKeys().map(key => { const name = this.name(key); return { name: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) ? name : key.slice(0, 8) }; });
    return startLocalA2A({ writeState: true, card: ({ url }) => buildAgentCard({ name: this.me.name, shares: shares(), teammates: teammates(), url }), dispatch: (method, params, ctx) => this.localCall(method, params, ctx) });
  }
  // SendMessage never blocks here: it returns the Task SUBMITTED and GetTask follows it.
  localCall(method, params, { peerName }) {
    if (method === 'CancelTask') throw a2aError(ErrorCode.UNSUPPORTED_OPERATION, 'Cancel the request in ELU Code.');
    const text = params.message?.parts?.filter(part => typeof part.text === 'string').map(part => part.text).join('\n\n') ?? '';
    const project = params.metadata?.project ?? params.message?.metadata?.project ?? null;
    if (method === 'SendMessage') {
      // A client context is kept, never replaced; follow-ups to an existing task are not supported.
      const contextId = params.message?.contextId ?? null;
      if (params.message?.taskId) throw a2aError(ErrorCode.UNSUPPORTED_OPERATION, 'Follow-ups to a task are not supported. Send a new message in the same context.', { taskId: params.message.taskId });
      if (contextId !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(contextId)) throw a2aError(ErrorCode.INVALID_PARAMS, 'The context id may use only letters, digits, dashes and underscores.');
      if (peerName) {
        const kind = ['ask', 'review', 'handoff'].includes(peerExt(params.message)?.kind) ? peerExt(params.message).kind : 'ask';
        const ask = createAsk(this.ctx, { to: peerName, kind, project: typeof project === 'string' ? project : null, text, threadId: contextId });
        return a2aTask({ id: ask.id, contextId: ask.threadId });
      }
      const share = shares().find(row => row.handle === project) ?? registeredProjects().map(repo => ({ root: repo.root, handle: path.basename(repo.root) })).find(row => row.handle === project);
      if (!share) refuse('Name a project in metadata.project.');
      // An automatic request runs the personal default, capped at Approve for me.
      const row = enqueue(share.root, text, { permissions: capMode(defaultMode(), 'auto') }); this.kick();
      saveLocal({ id: row.id, root: share.root, contextId: contextId ?? row.id, taskId: null, createdAt: new Date().toISOString() });
      return a2aTask({ id: row.id, contextId: contextId ?? row.id });
    }
    const ask = getAsk(params.id);
    if (ask) {
      const state = { pending: 'SUBMITTED', submitted: 'SUBMITTED', working: 'WORKING', held: 'WORKING', answered: 'COMPLETED', rejected: 'REJECTED', failed: 'FAILED', canceled: 'CANCELED', expired: 'FAILED' }[ask.state] ?? 'WORKING';
      return a2aTask({ id: ask.id, contextId: ask.threadId, state: TaskState[state], statusMessage: ask.reason ?? undefined, artifacts: ask.answer ? [artifact({ name: 'Answer', text: ask.answer.text })] : undefined });
    }
    // An /a2a request: its row while the conductor keeps it, then the task it ran.
    const local = getLocal(params.id), repos = registeredProjects();
    for (const repo of local ? repos.filter(repo => repo.root === local.root) : repos) {
      let row; try { row = pendingRequests(repo.root).find(r => r.id === params.id && !r.origin); } catch { continue; }
      const taskId = row?.taskId ?? local?.taskId ?? null;
      if (!row && !local) continue;
      let reply = null; try { if (taskId) { const done = readTask(repo, taskId); reply = (done.reply ?? done.result)?.summary ?? null; } } catch { /* Not started. */ }
      const state = !row ? reply ? 'COMPLETED' : 'FAILED' : row.state === 'done' ? (reply ? 'COMPLETED' : 'FAILED') : ['starting', 'running'].includes(row.state) ? 'WORKING' : 'SUBMITTED';
      return a2aTask({ id: params.id, contextId: local?.contextId ?? params.id, state: TaskState[state], artifacts: state === 'COMPLETED' ? [artifact({ name: 'Answer', text: reply })] : undefined });
    }
    throw a2aError(ErrorCode.TASK_NOT_FOUND, 'No such task.', { taskId: params.id });
  }
  // Notes the task id of each /a2a request while its row still exists.
  syncLocal() {
    for (const local of locals().filter(row => !row.taskId)) {
      let row; try { row = pendingRequests(local.root).find(r => r.id === local.id); } catch { continue; }
      if (row?.taskId) saveLocal({ ...local, taskId: row.taskId });
    }
  }

  // commands/<id>.json from the TUI and CLI; each result goes to commands/<id>.result.json.
  commands() {
    const folder = peerFile('commands'); noSymlinks(folder); if (!fs.existsSync(folder)) return;
    const names = fs.readdirSync(folder);
    // The TUI never waits for results, so results older than an hour are dropped.
    for (const name of names.filter(name => name.endsWith('.result.json'))) { try { const file = path.join(folder, name); if (Date.now() - fs.lstatSync(file).mtimeMs > 3600000) fs.rmSync(file, { force: true }); } catch { /* Gone already. */ } }
    for (const name of names.filter(name => name.endsWith('.json') && !name.endsWith('.result.json')).sort()) {
      const id = name.slice(0, -5), file = path.join(folder, name);
      if (!COMMAND.test(id) || this.running.has(id)) continue;
      let command = null; try { noSymlinks(file); command = readJson(file); } catch { /* Answered as invalid below. */ }
      fs.rmSync(file, { force: true });
      this.running.add(id);
      const finish = (ok, value) => { this.running.delete(id); try { atomic(path.join(folder, `${id}.result.json`), { id, ok, ...(ok ? { result: value ?? null } : { error: value }), at: new Date().toISOString() }); } catch (error) { this.log(`result: ${error.message}`); } };
      Promise.resolve().then(() => this.command(command)).then(value => finish(true, value), error => finish(false, error.message ?? 'The command failed.'));
    }
  }
  async command(command) {
    if (!isObject(command)) refuse('The command is not valid.');
    const { type } = command, item = String(command.id ?? command.item ?? ''), [kind, ref] = item.includes(':') ? [item.slice(0, item.indexOf(':')), item.slice(item.indexOf(':') + 1)] : [null, item];
    // Pictures ride only on a message the owner typed: the app that took it staged the copies.
    const pictures = ['ask', 'handoff', 'teamAsk'].includes(type) ? stagedPictures(command.pictures) : null;
    // bot: the teammate's shared bot the question is for; createAsk refuses it on a handoff.
    const ask = kindOf => createAsk(this.ctx, { to: command.to, kind: kindOf, project: command.project ?? null, text: command.text, root: command.root ?? null, chatTaskId: command.chatTaskId ?? (kindOf === 'ask' ? command.taskId : null) ?? null, threadId: command.threadId ?? null, bot: command.bot ?? null, byOwner: true, pictures });
    // pathsCut tells the TUI a path left as [path], so it can say why.
    const sent = row => ({ askId: row.id, pathsCut: row.pathsCut === true, ...(row.pictures ? { pictures: row.pictures.list.length } : {}) });
    const incoming = () => kind === 'incoming' || !kind && getRecord(ref);
    switch (type) {
      case 'ask': case 'handoff': return sent(ask(type));
      case 'teamAsk': return { askIds: teamAsk(this.ctx, { project: command.project ?? null, text: command.text, root: command.root ?? null, chatTaskId: command.chatTaskId ?? command.taskId ?? null, team: command.team ?? null, channel: command.channel ?? null, byOwner: true, pictures }).map(row => row.id), ...(pictures ? { pictures: pictures.list.length } : {}) };
      // A channel is a signed roster op, so the people in it get it from any teammate.
      case 'channelSet': {
        if (!this.myTeams().some(state => state.id === command.team)) refuse('Choose one of your teams.');
        const { op, id } = setChannel(this.me, command.team, { id: command.id ?? null, name: command.name ?? null, members: command.members });
        this.forward(command.team, [op], null); return { id };
      }
      case 'review': return { askId: createAsk(this.ctx, { to: command.to, kind: 'review', project: command.project ?? null, text: reviewText(command.root, command.taskId), root: command.root ?? null }).id };
      case 'approve': case 'accept':
        if (kind === 'held') { const task = sendReply(this.ctx, ref, { text: command.text }); return { task, pathsCut: getRecord(ref)?.reply?.pathsCut === true }; }
        // y: answer it read-only, whatever the wire kind.
        if (incoming()) return { task: acceptIncoming(this.ctx, ref, { how: 'answer' }) };
        if (kind === 'draft') return sent(sendDraft(this.ctx, ref, { byOwner: true }));
        refuse('Nothing to approve there.');
      case 'work':
        // w: the owner's own session in the mode, place and folders they picked.
        if (!incoming()) refuse('Nothing to work on there.');
        return { task: acceptIncoming(this.ctx, ref, { how: 'work', permissions: command.permissions, place: command.place, folders: command.folders }) };
      case 'discard':
        if (kind === 'held') return { task: discardReply(this.ctx, ref) };
        if (incoming()) return { task: this.decline(ref) };
        if (kind === 'draft') return { draft: discardDraft(ref).id };
        if (['answer', 'asked', 'expired', 'rejected'].includes(kind)) return { askId: dismissAsk(this.ctx, ref).id };
        if (kind === 'team') return { askIds: dismissTeam(this.ctx, ref).map(row => row.id) };
        refuse('Nothing to discard there.');
      case 'continue': return { requestId: continueAnswer(this.ctx, kind ? ref : item).id };
      case 'mute': case 'unmute':
        if (!HEX64.test(command.key ?? '') || !teams().some(state => state.members.some(m => m.key === command.key))) refuse('Choose a teammate to mute.');
        return { key: command.key, muted: savePeerPolicy(command.key, { muted: type === 'mute' }).muted };
      case 'trust': case 'untrust':
        // Trust is mine about a teammate on my roster; it is never sent to them.
        if (!HEX64.test(command.key ?? '') || !this.teammateKeys().includes(command.key)) refuse('Choose a teammate to trust.');
        return { key: command.key, trusted: savePeerPolicy(command.key, { trusted: type === 'trust' }).trusted };
      case 'join': return this.join(command.code);
      case 'shutdown':
        // peer off then peer on within one tick leaves enabled true, and a shutdown left over
        // from a daemon that died before reading it predates this one: both are ignored.
        if (this.requireEnabled && peerSettings().enabled || Date.parse(command.at) < Date.parse(this.startedAt)) return { stopping: false };
        setImmediate(() => this.onExit ? this.onExit() : this.stop()); return { stopping: true };
      default: refuse('Unknown peer command.');
    }
  }
  // The board may remove the request before the decline arrives; the record is then already rejected.
  decline(id) {
    const record = getRecord(id);
    if (record && !record.waiting && record.task.status.state === TaskState.REJECTED) return record.task;
    return declineIncoming(this.ctx, id);
  }
}
