import fs from 'node:fs';
import path from 'node:path';
import { lock, readTask, saveTask, setTitle, event, taskTitle } from './state.mjs';
import { runConversation } from './runner.mjs';
import { enqueue, sendCommand } from './conductor.mjs';
import { pendingRequests, takeRequest } from './workspace.mjs';
import { conversationEntries, modelLabel, registeredProjects, reportedModels, savedProjectName, sessionModel } from './projects.mjs';
import { readBoard, COLUMNS } from './kanban.mjs';
import { currentTask } from './plan.mjs';
import { pendingApprovals } from './approvals.mjs';
import { HELD_ANSWER, NOT_OPEN, STANDUP_QUESTION, STANDUP_RECENT_DAYS, STANDUP_WAIT_MINUTES, SUMMARY_TEXT, cleanText, cutAnswer, firstLines, newRound, oneLine, standupActivity, standupAgent, standupHeading, standupLeftOut, standupReply, standupWaits } from './standup.mjs';

// One standup round (README, "Standup"), run by the conductor as the Standup session's turn.
// It picks the sessions to ask (lib/standup.mjs says which), says in the chat how many and on
// which computers before asking any, asks each in its own read-only answer turn (runStandup:
// through the conductor here, through lib/peer/standup.mjs on another computer of the owner's
// or a teammate's), shows each answer as it arrives, then the sessions not asked, and one line
// when all are in. The Standup's model then sums the round up in one turn. Nothing here runs
// by itself: only the owner's /standup or @everyone starts a round, and /stop ends the
// waiting. The updates stay on the session's record (task.standup) for its model to read
// whenever the owner writes to it.

// How often the round looks for answers, how long a session that works may take to start
// answering, and how long the round waits at most. Tests shorten them.
export const STANDUP_TIMES = { pollMs: 1000, remoteMs: 4000, waitMs: STANDUP_WAIT_MINUTES * 60000, capMs: 30 * 60000 };
const WORKING = ['running', 'preparing', 'starting'];
const time = value => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : 0; };
const plain = value => String(value ?? '').replace(/[\s@]+/g, '').slice(0, 40);
const COLUMN_NAMES = Object.fromEntries(COLUMNS);
const STATE_WORDS = { running: 'working', preparing: 'working', starting: 'starting', needs_input: 'waiting for you', answered: 'answered', ready: 'ready to publish', unverified: 'not verified', blocked: 'blocked', stopped: 'stopped', gone: 'gone' };
const stateWord = (state, waits) => waits ? 'waiting for you' : STATE_WORDS[state] ?? String(state ?? '').replace(/_/g, ' ');

// ---- Who is asked ----

// Every session of this computer the round may ask, in each registered project, but this
// Standup session itself: { here: true, repo, task, ref, title, who, at, state, waits, last }.
function localSessions(self, now) {
  let approvals = []; try { approvals = pendingApprovals(); } catch { approvals = []; }
  const rows = [];
  for (const repo of registeredProjects()) {
    let board, ids;
    try { board = readBoard(repo); const folder = path.join(repo.state, 'tasks'); ids = fs.existsSync(folder) ? fs.readdirSync(folder).filter(id => /^[1-9][0-9]*$/.test(id)) : []; } catch { continue; }
    for (const id of ids) {
      if (repo.root === self.root && id === self.id) continue;
      let task; try { task = readTask(repo, id); } catch { continue; }
      let plan = null; try { plan = currentTask(repo, id); } catch { plan = null; }
      const waits = standupWaits(task, { plan, approvals: approvals.filter(item => !item.root || item.root === repo.root) });
      if (standupLeftOut(board, task, { now, waits })) continue;
      const agent = standupAgent(task);
      let who = 'the model';
      try { who = agent.bot ? `@${agent.bot.name}` : modelLabel(sessionModel(repo, task) ?? { vendor: 'claude', model: null }, reportedModels([task])); } catch { /* Named by its vendor once it answers. */ }
      let last = '';
      try { last = firstLines(conversationEntries(repo, task).findLast(entry => entry.lead || entry.bot)?.text); } catch { last = ''; }
      rows.push({ here: true, where: 'here', repo, task, ref: `${repo.root}\0${task.id}`, title: oneLine(taskTitle(task), 80), project: savedProjectName(repo.root) ?? path.basename(repo.root), who, at: standupActivity(task), state: task.state, waits: waits?.question ?? null, last });
    }
  }
  return rows;
}
// The computers of mine, as this one last listed their sessions (lib/peer/remote.mjs): each
// one's name, whether it is online now, whether its build can answer a standup, and its
// sessions the round may ask. A teammate's session there is never one.
function remoteComputers(now) {
  let peer; try { peer = awaitPeer(); } catch { return []; }
  let status = null; try { status = peer.peerStatus(); } catch { status = null; }
  const members = new Map((status?.teams ?? []).flatMap(team => team.members ?? []).map(member => [member.key, member]));
  const out = [];
  for (const machine of peer.remoteMachines()) {
    if (!peer.pairedMine(machine.key)) continue;
    const member = members.get(machine.key), name = `@${plain(member?.box) || plain(member?.name) || machine.key.slice(0, 8)}`;
    const projects = new Map((machine.projects ?? []).map(row => [row.id, row.name]));
    // standup: false: that computer would not ask it (done, quiet, a Standup), so it is never one to ask.
    const sessions = (machine.sessions ?? []).filter(row => row.by !== 'teammate' && row.standup !== false).flatMap(row => {
      const waits = row.question ? row.question : row.plan ? `Task to approve: ${row.plan.title}` : row.approvals?.length ? `approval: ${row.approvals[0].summary}` : row.state === 'needs_input' ? 'asks you' : null;
      if (!WORKING.includes(row.state) && !waits && now - time(row.at) > STANDUP_RECENT_DAYS * 86400000) return [];
      return [{ here: false, where: name, key: machine.key, ref: row.ref, title: oneLine(row.title, 80), project: projects.get(row.project) ?? null, who: null, at: time(row.at), state: row.state, waits: waits ? oneLine(waits, 200) : null, last: '' }];
    });
    out.push({ key: machine.key, name, online: status?.running === true && member?.online === true, standup: machine.standup === true, sessions });
  }
  return out;
}
let peerModules = null;
function awaitPeer() { if (!peerModules) throw new Error('Not loaded.'); return peerModules; }
async function loadPeer() {
  if (peerModules) return peerModules;
  const [index, mine] = await Promise.all([import('./peer/index.mjs'), import('./peer/mine.mjs')]);
  peerModules = { peerStatus: index.peerStatus, remoteMachines: index.remoteMachines, sendPeerCommand: index.sendPeerCommand, awaitCommand: index.awaitCommand, pairedMine: mine.pairedMine };
  return peerModules;
}
// Teammates' sessions on the shared Kanban of each project here (lib/peer/cards.mjs), never
// of a project kept off it: one row per teammate, with their cards. My own other computers
// are asked as mine, not here.
async function teammatePeople(roots, now) {
  let cards; try { cards = await import('./peer/cards.mjs'); } catch { return []; }
  const people = new Map();
  for (const root of roots) {
    let told; try { told = cards.teammateSessions(root, now); } catch { continue; }
    for (const person of told.people ?? []) {
      try { if (peerModules?.pairedMine(person.peer)) continue; } catch { /* Not one of mine. */ }
      const row = people.get(person.peer) ?? { peer: person.peer, name: person.name, box: person.box, online: person.online, sessions: [] };
      for (const card of person.sessions ?? []) if (!row.sessions.some(value => value.id === card.id)) row.sessions.push(card);
      people.set(person.peer, row);
    }
  }
  return [...people.values()];
}
// A teammate's open cards as rows of the round: { team: true, peer, card, ref, where, ... }.
// Open is what their computer says (card.standup), by the same rule as his own sessions: a
// session in Done because it answered is asked, one moved to Done is not. A card that says
// nothing comes from an older build: one in Done may have answered, so it is listed (untold),
// never dropped. A withheld card (a session a teammate's message started) is never asked.
const withheld = card => card.standup === undefined && card.by === 'teammate' && card.title === 'Session';
const cardState = card => card.standup === true || card.standup === undefined && card.column !== 'done' ? 'open' : card.standup === undefined && !withheld(card) ? 'untold' : null;
function teammateRows(people) {
  return people.flatMap(person => (person.sessions ?? []).flatMap(card => { const state = cardState(card); return state ? [{ ...(state === 'untold' ? { untold: true } : {}),
    team: true, peer: person.peer, card: card.id, ref: `${person.peer}/${card.id}`, where: `@${plain(person.name) || person.peer.slice(0, 8)}`, online: person.online === true,
    title: oneLine(card.title, 80), project: null, who: null, at: time(card.at), state: COLUMN_NAMES[card.column] ?? card.column, column: COLUMN_NAMES[card.column] ?? card.column, waits: null, last: '' }] : []; }));
}
// Who this round asks and who it lists: asked, newest first, every session of the owner's it
// can ask and every one of his teammates'; notAsked, those it cannot, each with why. only: the refs of the last round, for @everyone in a Standup session, which asks those
// again. sources: the computers and teammates, which tests give in place of the peer files.
export async function standupPlan(self, { now = Date.now(), sources = {}, only = null } = {}) {
  const keep = row => !only || only.has(row.ref);
  const local = localSessions(self, now).filter(keep);
  const computers = sources.computers ? sources.computers(now) : await loadPeer().then(() => remoteComputers(now), () => []);
  const remote = computers.flatMap(machine => machine.sessions.map(row => ({ ...row, online: machine.online, can: machine.standup }))).filter(keep);
  const mine = [...local, ...remote.filter(row => row.online && row.can)].sort((a, b) => b.at - a.at);
  const roots = [...new Set([self.root, ...registeredProjects().map(repo => repo.root)])];
  const people = sources.teammates ? sources.teammates(roots, now) : await teammatePeople(roots, now);
  const rows = teammateRows(people).filter(keep).sort((a, b) => b.at - a.at), team = rows.filter(row => !row.untold), reachable = team.filter(row => row.online);
  const asked = [...mine, ...reachable];
  const notAsked = [
    ...remote.filter(row => !row.online || !row.can).map(row => ({ ...row, why: !row.online ? `${row.where} is offline` : `${row.where} runs an older ELU` })),
    ...team.filter(row => !row.online).map(row => ({ ...row, why: `${row.where} is offline` })),
    ...rows.filter(row => row.untold).map(row => ({ ...row, why: `${row.where} runs an older ELU, which does not say whether it answered` })),
  ];
  return { asked, notAsked, roots: [...new Set([self.root, ...local.map(row => row.repo.root)])] };
}

// ---- The chat ----

const computerName = row => row.where === 'here' ? 'here' : `on ${row.where}`;
const where = rows => {
  const groups = new Map();
  for (const row of rows) groups.set(row.where, (groups.get(row.where) ?? 0) + 1);
  return [...groups].map(([at, n]) => `${n} ${at === 'here' ? 'here' : `on ${at}`}`).join(', ');
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const computers = rows => new Set(rows.map(row => row.where)).size;
export function askingLine(asked, question = null) {
  if (!asked.length) return `No session is open to ask: none of yours works, waits for you, or was active in the last ${STANDUP_RECENT_DAYS} days, and no teammate's shared session is online.`;
  return `Asking ${plural(asked.length, 'session')} on ${plural(computers(asked), 'computer')} (${where(asked)})${question ? ` your question: ${oneLine(question, 200)}` : ' for a standup update'}. Each answers in its own session, on its own model and limits, and changes nothing there. /stop stops waiting.`;
}
const notAskedText = row => [`- ${row.title} · ${computerName(row)} · ${row.team ? row.column : stateWord(row.state, row.waits)}`, row.waits && row.waits !== 'asks you' ? `: ${row.waits}` : '', row.last ? ` · last reply: ${row.last}` : '', ` · ${row.why}`].join('');
export const endLine = ({ answered, notAsked, stopped = false }) => `Standup ${stopped ? 'stopped' : 'done'} · ${plural(answered.length, 'session')} on ${plural(computers(answered), 'computer')} · ${notAsked} not asked`;

// ---- The round ----

const sleep = (ms, signal) => new Promise(resolve => { if (signal?.aborted) return resolve(); const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
export function standupTitle(at = new Date()) {
  return `Standup ${at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`.slice(0, 60);
}
// Runs one round in the Standup session id of repo. signal: the owner's /stop. question: the
// owner's @everyone question, null for a standup. message: what he wrote, for a round of a
// Standup session that has had one (it asks the same sessions again). sources: see standupPlan.
export async function runStandupRound(repo, id, { signal, question = null, message = null, sources = {}, times = STANDUP_TIMES } = {}) {
  const release = lock(repo, `task-${id}`), round = newRound(), started = Date.now();
  const task = readTask(repo, id), before = task.standup ?? null, at = () => new Date().toISOString();
  const say = (text, extra = {}) => { (task.messages ??= []).push({ at: at(), text, from: 'Standup', standupChat: true, line: true, ...extra }); saveTask(repo, task); };
  if (!before) { try { setTitle(repo, task.id, standupTitle()); } catch { /* It keeps the name it shows. */ } }
  const kept = { rounds: [], projects: [], updates: [], notAsked: [], last: [], next: 1, ...(before ?? {}) };
  // The round is on the record from its first save, so the chat says it waits for the sessions.
  kept.rounds = [...kept.rounds, { round, at: new Date(started).toISOString(), question, asked: 0 }];
  Object.assign(task, { state: 'running', error: null, activeRole: null, activeLog: null, standup: kept });
  saveTask(repo, task);
  if (message) (task.messages ??= []).push({ at: at(), text: message, standupChat: true });
  const peer = sources.peer ?? (await loadPeer().catch(() => null));
  const command = async (body, wait = 30000) => {
    if (!peer) return { offline: true };
    try { if (peer.peerStatus().running !== true) return { offline: true }; } catch { return { offline: true }; }
    const { id: sent } = peer.sendPeerCommand(body); return peer.awaitCommand(sent, wait);
  };
  const ask = { round, by: 'You', ...(question ? { question } : {}) };
  const answered = [], missed = [], took = [];
  let pending = [], plan = { asked: [], notAsked: [], roots: [] };
  try {
    const only = message && before?.last?.length ? new Set(before.last) : null;
    plan = await standupPlan({ root: repo.root, id: task.id }, { sources, only });
    kept.projects = [...new Set([...kept.projects, ...plan.roots])];
    kept.rounds.at(-1).asked = plan.asked.length;
    kept.last = plan.asked.map(row => row.ref);
    say(askingLine(plan.asked, question));
    // Each is asked: this computer's through the conductor, another's through its own.
    for (const row of plan.asked.filter(row => row.here)) {
      try { row.request = enqueue(row.repo.root, STANDUP_QUESTION, { continuationTaskId: row.task.id, priority: 1, standupFor: ask }).id; pending.push(row); }
      catch (error) { missed.push({ ...row, why: `could not ask it: ${oneLine(error.message, 160)}` }); }
    }
    const groups = rows => [...new Set(rows.map(row => row.key ?? row.peer))].map(key => [key, rows.filter(row => (row.key ?? row.peer) === key)]);
    for (const [key, rows] of groups(plan.asked.filter(row => !row.here && !row.team))) {
      let result = null; try { result = await command({ type: 'remoteStandup', to: key, round, refs: rows.map(row => row.ref), ...(question ? { question } : {}) }); } catch (error) { result = { error: error.message }; }
      const taken = new Map((result?.asked ?? []).map(item => [item.ref, item])), skipped = new Map((result?.skipped ?? []).map(item => [item.ref, item.why]));
      for (const row of rows) {
        if (taken.has(row.ref)) { pending.push({ ...row, title: oneLine(taken.get(row.ref).title, 80) || row.title }); continue; }
        // One it would not ask was never one to ask: it is left out without a word.
        if (NOT_OPEN.includes(skipped.get(row.ref))) continue;
        missed.push({ ...row, why: result?.offline ? `${row.where} is offline` : result?.older ? `${row.where} runs an older ELU` : skipped.has(row.ref) ? `not open there: ${oneLine(skipped.get(row.ref), 120)}` : `${row.where} did not take it${result?.error ? `: ${oneLine(result.error, 160)}` : ''}` });
      }
    }
    for (const [key, rows] of groups(plan.asked.filter(row => row.team))) {
      let result = null; try { result = await command({ type: 'teamStandup', to: key, round, cards: rows.map(row => row.card), ...(question ? { question } : {}) }); } catch (error) { result = { error: error.message }; }
      const taken = new Map((result?.asked ?? []).map(item => [item.card, item])), skipped = new Map((result?.skipped ?? []).map(item => [item.card, item.why]));
      if (result?.state === 'waiting') say(`${rows[0].where} decides teammates' standups by hand: ${plural(taken.size, 'session')} there ${taken.size === 1 ? 'waits' : 'wait'} for ${rows[0].where} to approve.`);
      for (const row of rows) {
        if (taken.has(row.card) && result?.state !== 'declined') { pending.push({ ...row, title: cleanText(taken.get(row.card).title, 80) || row.title }); continue; }
        if (result?.state !== 'declined' && NOT_OPEN.includes(skipped.get(row.card))) continue;
        missed.push({ ...row, why: result?.offline ? `${row.where} is offline` : result?.older ? `${row.where} runs an older ELU` : result?.state === 'declined' ? `${row.where} declined` : skipped.has(row.card) ? `not open there: ${cleanText(skipped.get(row.card), 120)}` : `${row.where} did not take it${result?.error ? `: ${oneLine(result.error, 160)}` : ''}` });
      }
    }
    // Answers as they arrive, until all are in, the owner stops it, or the round has waited long
    // enough for a question no session has started on. An answer turn that runs is a turn like any
    // other: no clock of ELU's stops it, and the round waits for it. turns: those that ran on
    // another computer when it last said.
    const take = (row, said) => {
      const who = row.here ? said.who || row.who : cleanText(said.who, 40) || 'its agent', text = row.here ? cutAnswer(said.text) : cutAnswer(cleanText(said.text, Infinity));
      const heading = standupHeading({ title: row.title, who, where: row.where });
      say(text, { from: heading, line: false, update: true, ...(said.failed ? { failed: true } : {}) });
      const update = { id: `u${kept.next++}`, round, session: row.title, agent: who, computer: row.where, ...(row.project ? { project: row.project } : {}), at: said.at && !row.team ? said.at : at(), text, ...(said.failed ? { failed: true } : {}), ...(row.team ? { teammate: true, peer: row.peer } : {}) };
      kept.updates = [...kept.updates, update];
      answered.push(row); if (!said.failed) took.push(row); saveTask(repo, task);
    };
    const late = () => Date.now() - started > times.waitMs, minutes = Math.round(times.waitMs / 60000);
    const turns = new Set(), turning = row => { if (!row.here) return turns.has(row); try { return ['starting', 'running'].includes(pendingRequests(row.repo.root).find(value => value.id === row.request)?.state); } catch { return false; } };
    let remoteAt = 0, waiting = true;
    while (pending.length && !signal?.aborted && waiting) {
      // Read before the answers are, so the answer of a turn that ended since is still taken.
      waiting = Date.now() - started < times.capMs || pending.some(turning);
      for (const row of pending.filter(row => row.here)) {
        let current = null; try { current = readTask(row.repo, row.task.id); } catch { current = null; }
        const said = current ? standupReply(current, round) : null;
        if (said) { take(row, said); continue; }
        let request = null; try { request = pendingRequests(row.repo.root).find(value => value.id === row.request) ?? null; } catch { request = null; }
        if (!current || !request || ['done', 'blocked'].includes(request.state)) { take(row, { text: `It did not answer.${request?.reason && request.reason !== 'Finished.' ? ` ${oneLine(request.reason, 300)}` : ''}`, failed: true }); continue; }
        // One that is working answers when its turn ends; after the wait it is listed as it stands.
        if (request.state === 'queued' && ['running', 'preparing'].includes(current.state) && !current.standupTurn && late() && takeRequest(row.repo.root, row.request)) { missed.push({ ...row, state: current.state, why: `still working after ${minutes} minutes` }); answered.push(row); }
      }
      if (pending.some(row => !row.here) && Date.now() - remoteAt >= times.remoteMs) {
        remoteAt = Date.now();
        for (const [key, rows] of groups(pending.filter(row => !row.here && !answered.includes(row)))) {
          const team = rows[0].team, id = row => team ? row.card : row.ref;
          // Only the sessions still waited for are asked about, so an update is sent here once.
          let result = null; try { result = await command({ type: team ? 'teamStandupRead' : 'remoteStandupRead', to: key, round, [team ? 'cards' : 'refs']: rows.map(id) }); } catch { result = null; }
          for (const row of rows) turns.delete(row);
          for (const item of Array.isArray(result?.pending) ? result.pending : []) { const row = item?.queued === false ? rows.find(value => id(value) === (team ? item.card : item.ref)) : null; if (row) turns.add(row); }
          if (result?.state === 'declined') { for (const row of rows) { missed.push({ ...row, why: `${row.where} declined` }); answered.push(row); } continue; }
          for (const said of result?.answers ?? []) { const row = rows.find(value => id(value) === (team ? said.card : said.ref) && !answered.includes(value)); if (row) take(row, said.held ? { ...said, text: HELD_ANSWER, failed: true } : said); }
          const slow = (result?.pending ?? []).filter(item => item.working && item.queued && late()).map(item => team ? item.card : item.ref);
          if (slow.length) {
            try { await command({ type: team ? 'teamStandupStop' : 'remoteStandupStop', to: key, round, [team ? 'cards' : 'refs']: slow }); } catch { /* Listed as working all the same. */ }
            for (const ref of slow) { const row = rows.find(value => id(value) === ref && !answered.includes(value)); if (row) { missed.push({ ...row, state: 'running', why: `still working after ${minutes} minutes` }); answered.push(row); } }
          }
        }
      }
      pending = pending.filter(row => !answered.includes(row));
      if (pending.length && waiting) await sleep(times.pollMs, signal);
    }
    // Stopped, or waited long enough: what was asked and not answered is taken back.
    for (const row of pending.filter(row => row.here)) {
      try { if (!takeRequest(row.repo.root, row.request)) { const current = readTask(row.repo, row.task.id); if (current.standupTurn?.round === round) sendCommand({ type: 'stop', root: row.repo.root, taskId: row.task.id }); } } catch { /* Listed all the same. */ }
    }
    for (const [key, rows] of groups(pending.filter(row => !row.here))) { try { await command({ type: rows[0].team ? 'teamStandupStop' : 'remoteStandupStop', to: key, round }); } catch { /* Its answers stay there. */ } }
    for (const row of pending) missed.push({ ...row, why: signal?.aborted ? 'you stopped waiting' : `no answer in ${Math.round(times.capMs / 60000)} minutes` });
    const notAsked = [...missed, ...plan.notAsked];
    kept.notAsked = notAsked.map(row => ({ session: row.title, computer: row.where, ...(row.project ? { project: row.project } : {}), state: row.team ? row.column : stateWord(row.state, row.waits), ...(row.waits ? { waits: row.waits } : {}), ...(row.last ? { lastReply: row.last } : {}), ...(row.team ? { teammate: true } : {}), why: row.why }));
    if (notAsked.length) say(`Not asked, declined or still working:\n${notAsked.map(notAskedText).join('\n')}`);
    say(endLine({ answered: took, notAsked: notAsked.length, stopped: signal?.aborted === true }));
  } catch (error) {
    say(`The standup stopped: ${error.message}`);
  } finally {
    Object.assign(task, { state: 'answered', error: null, activeRole: null, activeLog: null });
    try { saveTask(repo, task); event(repo, 'task-ended', { taskId: task.id, state: task.state }); } finally { release(); }
  }
  return { task, round, answered: took.length, listed: missed.length + plan.notAsked.length };
}
// A round, then its summary: one turn of the Standup's own model, on the session's model and
// mode, that sums the round up and makes the Kanban changes its updates call for. A round with
// nothing to sum up has none. renew: a new stop for the summary after the owner's /stop of the
// waiting, or null when the stop ends everything. onSummary: called as the summary turn starts.
// The turn runs with nobody watching, so it only answers and keeps the Kanban (runConversation).
export async function runStandupSession(repo, id, { signal, renew = null, onSummary = null, ...options } = {}) {
  const { task, answered, listed } = await runStandupRound(repo, id, { signal, ...options });
  if (!answered && !listed) return task;
  const summary = signal?.aborted ? renew?.() ?? null : signal;
  if (!summary || summary.aborted) return task;
  onSummary?.();
  return runConversation(repo, readTask(repo, id), SUMMARY_TEXT, { signal: summary, owner: true, as: { from: 'Standup', standupChat: true, line: true, summary: true } });
}
