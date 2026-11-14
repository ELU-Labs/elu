import fs from 'node:fs';
import path from 'node:path';
import { lock, readTask, saveTask, setTitle, event, taskTitle } from './state.mjs';
import { runConversation, runStandupFirst } from './runner.mjs';
import { conductorAnswersBeside, enqueue, sendCommand, stopStandupAnswer } from './conductor.mjs';
import { pendingRequests, takeRequest } from './workspace.mjs';
import { registeredProjects, savedProjectName } from './projects.mjs';
import { readBoard, COLUMNS } from './kanban.mjs';
import { currentTask } from './plan.mjs';
import { stateWord as sessionState } from './task-head.mjs';
import { pendingApprovals } from './approvals.mjs';
import { FIRST_SUMMARY, HELD_ANSWER, NOT_OPEN, STANDUP_QUESTION, STANDUP_RECENT_DAYS, STANDUP_WAIT_MINUTES, SUMMARY_TEXT, cleanText, cutAnswer, firstLines, newRound, oneLine, standupActivity, standupAnswer, standupLeftOut, standupWaits } from './standup.mjs';
import { cleanRecord, listedRecord, localRecord, recordLines, span } from './standup-record.mjs';

// One standup round (README, "Standup"), run by the conductor as the Standup session's turn.
// It picks the sessions to ask (lib/standup.mjs says which) and shows one block for each at
// once, from what ELU has on record for it and with no model run (lib/standup-record.mjs): a
// session here from its own files, one on another computer of the owner's from what this
// computer last listed and then from that computer's own record, a teammate's from its card.
// Each is then asked for its model's update in a read-only run of its own (runStandup, or
// beside its turn when it works: through the conductor here, through lib/peer/standup.mjs on
// another computer), and the update is added to its block when it arrives. The first line
// always says how many answered from records, how many model updates are written and still
// being written, and for each one missing, why. The Standup's model writes a first summary
// from the records while the updates are written, and sums the round up in one turn when
// they are in. Nothing here runs by itself: only the owner's /standup or @everyone starts a
// round, and /stop ends the waiting and takes back every question not answered, on the other
// computers too. The updates stay on the session's record (task.standup) for its model to
// read whenever the owner writes to it.

// How often the round looks for answers here and on other computers, how long a question may
// take to start, how long the round waits at most, and how long it waits for another
// computer's records before the first summary starts. Tests shorten them.
export const STANDUP_TIMES = { pollMs: 1000, remoteMs: 2000, waitMs: STANDUP_WAIT_MINUTES * 60000, capMs: 30 * 60000, recordsMs: 2000 };
const WORKING = ['running', 'preparing', 'starting'];
const time = value => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : 0; };
const plain = value => String(value ?? '').replace(/[\s@]+/g, '').slice(0, 40);
const COLUMN_NAMES = Object.fromEntries(COLUMNS);
const STATE_WORDS = { running: 'working', preparing: 'working', starting: 'starting', needs_input: 'waiting for you', answered: 'answered', ready: 'ready to publish', unverified: 'not verified', blocked: 'blocked', stopped: 'stopped', gone: 'gone' };
const stateWord = (state, waits) => waits ? 'waiting for you' : STATE_WORDS[state] ?? String(state ?? '').replace(/_/g, ' ');

// ---- Who is asked ----

// Every session of this computer the round may ask, in each registered project, but this
// Standup session itself: { here: true, repo, task, ref, title, who, at, state, waits, last,
// record }. record: what is on record for it (lib/standup-record.mjs).
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
      let record = null; try { record = localRecord(repo, task, { now, plan, waits }); } catch { record = null; }
      rows.push({ here: true, where: 'here', repo, task, ref: `${repo.root}\0${task.id}`, title: oneLine(taskTitle(task), 80), project: savedProjectName(repo.root) ?? path.basename(repo.root), who: record?.who ?? 'the model', at: standupActivity(task), state: sessionState(task), waits: waits?.question ?? null, last: record?.said ? firstLines(record.said) : '', record });
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
    // standup: false: that computer would not ask it (done, quiet, a Standup), so it is never one to ask; nor one archived there.
    const sessions = (machine.sessions ?? []).filter(row => row.by !== 'teammate' && row.standup !== false && row.archived !== true).flatMap(row => {
      const waits = row.question ? row.question : row.plan ? `Task to approve: ${row.plan.title}` : row.approvals?.length ? `approval: ${row.approvals[0].summary}` : row.state === 'needs_input' ? 'asks you' : null;
      if (!WORKING.includes(row.state) && !waits && now - time(row.at) > STANDUP_RECENT_DAYS * 86400000) return [];
      const listed = { here: false, where: name, key: machine.key, ref: row.ref, title: oneLine(row.title, 80), project: projects.get(row.project) ?? null, who: null, at: time(row.at), state: row.finished ? 'committed' : row.state, waits: waits ? oneLine(waits, 200) : null, last: '', error: row.error ? oneLine(row.error, 300) : null };
      // Until that computer's own record is in, its block shows what this one last listed.
      return [{ ...listed, record: listedRecord(listed), listed: true }];
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
  // A session that waits for him comes first, then the ones that work, then the newest.
  const rank = row => row.waits ? 0 : WORKING.includes(row.state) ? 1 : 2;
  const mine = [...local, ...remote.filter(row => row.online && row.can)].sort((a, b) => rank(a) - rank(b) || b.at - a.at);
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
// A session's block is titled with its name, its agent once known, and where it runs.
const heading = row => `${oneLine(row.title, 80) || 'Session'} · ${row.who ? `${row.who} ` : ''}${computerName(row)}`;
// The block of one session: what is on record for it, then its model's update, or what
// stands in for it: that it is being written, or why there is none.
const blockText = row => [...(row.lines ?? []), '', row.update ? row.update : row.missing ? `No model update: ${row.missing}` : `Model update: ${row.pending ?? 'being written'}…`].join('\n').trim();
const settled = row => row.update != null || row.missing != null;
// The first line of a round, kept true as it goes: how many sessions, on which computers; how
// many answered from records at once; how many model updates are written and still being
// written; and each one missing, with why. done: the round is over.
export function headLine(rows, { question = null, done = false } = {}) {
  if (!rows.length) return `No session is open to ask: none of yours works, waits for you, or was active in the last ${STANDUP_RECENT_DAYS} days, and no teammate with sessions on your Kanban is online.`;
  const written = rows.filter(row => row.update != null).length, missing = rows.filter(row => row.missing != null), writing = rows.length - written - missing.length;
  const listed = rows.filter(row => row.listed).length, records = rows.length - listed;
  return [
    `${plural(rows.length, 'session')} on ${plural(computers(rows), 'computer')} (${where(rows)}).`,
    ...(question ? [`Asked: ${oneLine(question, 200)}${/[.?!]$/.test(oneLine(question, 200)) ? '' : '.'}`] : []),
    `${records} answered from ${records === 1 ? 'its record' : 'records'} at once${listed ? `; ${listed} shown as this computer last listed ${listed === 1 ? 'it' : 'them'}` : ''}.`,
    `Model updates: ${[`${written} written`, writing ? `${writing} being written` : '', missing.length ? `${missing.length} missing` : ''].filter(Boolean).join(', ')}.`,
    ...(missing.length ? [`Missing: ${missing.map(row => `${oneLine(row.title, 60) || 'Session'} ${computerName(row)} (${oneLine(row.missing, 160)})`).join('; ')}.`] : []),
    ...(done ? [] : ['/stop stops waiting.']),
  ].filter(Boolean).join(' ');
}
const notAskedText = row => [`- ${row.title} · ${computerName(row)} · ${row.team ? row.column : stateWord(row.state, row.waits)}`, row.waits && row.waits !== 'asks you' ? `: ${row.waits}` : '', row.last ? ` · last reply: ${row.last}` : '', ` · ${row.why}`].join('');
export const endLine = ({ rows, notAsked, stopped = false }) => `Standup ${stopped ? 'stopped' : 'done'} · ${plural(rows.length, 'session')} on ${plural(computers(rows), 'computer')} · ${plural(rows.filter(row => row.update != null).length, 'model update')}${rows.some(row => row.update == null) ? ` · ${rows.filter(row => row.update == null).length} missing` : ''} · ${notAsked} not asked`;

// ---- The round ----

const sleep = (ms, signal) => new Promise(resolve => { if (signal?.aborted) return resolve(); const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
export function standupTitle(at = new Date()) {
  return `Standup ${at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`.slice(0, 60);
}
// Why a model update that is not in yet is not, in the words its block shows.
const PENDING = { queued: 'waiting to start', writing: 'being written', older: 'it comes when its turn ends (the ELU that runs it is from before this update)' };
// Runs one round in the Standup session id of repo. signal: the owner's /stop. question: the
// owner's @everyone question, null for a standup. message: what he wrote, for a round of a
// Standup session that has had one (it asks the same sessions again). sources: see standupPlan.
// first: writes the first summary from the records ({ round, records, notAsked, writing,
// signal }) -> { text, who, runs }; without it the round has none.
export async function runStandupRound(repo, id, { signal, question = null, message = null, sources = {}, times = STANDUP_TIMES, first = null } = {}) {
  const release = lock(repo, `task-${id}`), round = newRound(), started = Date.now();
  const task = readTask(repo, id), before = task.standup ?? null, at = () => new Date().toISOString();
  const add = (text, extra = {}) => { const row = { at: at(), text, from: 'Standup', standupChat: true, line: true, ...extra }; (task.messages ??= []).push(row); return row; };
  const say = (text, extra = {}) => { const row = add(text, extra); saveTask(repo, task); return row; };
  if (!before) { try { setTitle(repo, task.id, standupTitle()); } catch { /* It keeps the name it shows. */ } }
  const kept = { rounds: [], projects: [], updates: [], notAsked: [], last: [], next: 1, ...(before ?? {}) };
  // The round is on the record from its first save, so the chat says what it is doing.
  kept.rounds = [...kept.rounds, { round, at: new Date(started).toISOString(), question, asked: 0 }];
  const tally = kept.rounds.at(-1);
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
  // rows: every session the round shows, in the order of its block; pending: those whose model
  // update is still to come.
  let rows = [], pending = [], plan = { asked: [], notAsked: [], roots: [] }, head = null, asking = false, summary = null;
  const stopFirst = new AbortController();
  // The first line, each block and the tally on the record say what is true now.
  const show = () => {
    if (!head) return;
    for (const row of rows) Object.assign(row.block, { text: blockText(row), from: heading(row) });
    head.text = headLine(rows, { question });
    const written = rows.filter(row => row.update != null).length;
    Object.assign(tally, { asked: rows.length, written, writing: rows.filter(row => !settled(row)).length });
    saveTask(repo, task);
  };
  const drop = row => { rows = rows.filter(value => value !== row); pending = pending.filter(value => value !== row); task.messages = task.messages.filter(value => value !== row.block); };
  const miss = (row, why) => { row.missing = why; pending = pending.filter(value => value !== row); };
  const take = (row, said) => {
    const who = row.here ? said.who || row.who : cleanText(said.who, 40) || row.who, text = row.here ? cutAnswer(said.text) : cutAnswer(cleanText(said.text, Infinity));
    row.who = who ?? row.who; row.answeredAt = said.at && !row.team ? said.at : at();
    // A run that could not answer leaves the record alone in the block, with why.
    if (said.failed) row.missing = text; else row.update = text;
    pending = pending.filter(value => value !== row);
  };
  try {
    const only = message && before?.last?.length ? new Set(before.last) : null;
    plan = await standupPlan({ root: repo.root, id: task.id }, { sources, only });
    kept.projects = [...new Set([...kept.projects, ...plan.roots])];
    kept.last = plan.asked.map(row => row.ref);
    // One block for every session, at once, from what is on record: no model has run yet.
    rows = plan.asked;
    head = add(headLine(rows, { question }));
    for (const row of rows) {
      row.lines = row.team ? [`${row.column} on ${row.where}'s board${row.at ? ` · last active ${span(Date.now() - row.at)} ago` : ''}`] : recordLines(row.record);
      row.block = add('', { from: heading(row), line: false, update: true });
    }
    show();
    // Each is asked for its model's update: this computer's through the conductor, which starts
    // it at once, beside the session's turn when it works; another's through its own.
    for (const row of rows.filter(row => row.here)) {
      try { row.request = enqueue(row.repo.root, STANDUP_QUESTION, { continuationTaskId: row.task.id, priority: 1, standupFor: ask }).id; row.pending = PENDING.queued; pending.push(row); }
      catch (error) { row.missing = `could not ask it: ${oneLine(error.message, 160)}`; }
    }
    show();
    const groups = list => [...new Set(list.map(row => row.key ?? row.peer))].map(key => [key, list.filter(row => (row.key ?? row.peer) === key)]);
    const askMine = async ([key, list]) => {
      let result = null; try { result = await command({ type: 'remoteStandup', to: key, round, refs: list.map(row => row.ref), ...(question ? { question } : {}) }); } catch (error) { result = { error: error.message }; }
      const taken = new Map((result?.asked ?? []).map(item => [item.ref, item])), skipped = new Map((result?.skipped ?? []).map(item => [item.ref, item.why]));
      const records = new Map((Array.isArray(result?.records) ? result.records : []).map(item => [item?.ref, cleanRecord(item?.record)]));
      for (const row of list) {
        if (taken.has(row.ref)) {
          row.title = oneLine(taken.get(row.ref).title, 80) || row.title;
          const record = records.get(row.ref);
          // Its own record takes the place of what was listed. A computer whose ELU sends none is named as such.
          if (record) { Object.assign(row, { record, who: record.who ?? row.who, lines: recordLines(record) }); delete row.listed; }
          else { row.older = true; row.lines = [...recordLines(row.record), `${row.where} runs an older ELU that sends no record: this is what this computer last listed for it.`]; }
          row.pending = PENDING.writing; pending.push(row); continue;
        }
        // One it would not ask was never one to ask: it is left out without a word.
        if (NOT_OPEN.includes(skipped.get(row.ref))) { drop(row); continue; }
        row.missing = result?.offline ? `${row.where} is offline` : result?.older ? `${row.where} runs an older ELU` : skipped.has(row.ref) ? `not open there: ${oneLine(skipped.get(row.ref), 120)}` : `${row.where} did not take it${result?.error ? `: ${oneLine(result.error, 160)}` : ''}`;
      }
      show();
    };
    const askTeam = async ([key, list]) => {
      let result = null; try { result = await command({ type: 'teamStandup', to: key, round, cards: list.map(row => row.card), ...(question ? { question } : {}) }); } catch (error) { result = { error: error.message }; }
      const taken = new Map((result?.asked ?? []).map(item => [item.card, item])), skipped = new Map((result?.skipped ?? []).map(item => [item.card, item.why]));
      const waits = result?.state === 'waiting';
      if (waits) add(`${list[0].where} decides teammates' standups by hand: ${plural(taken.size, 'session')} there ${taken.size === 1 ? 'waits' : 'wait'} for ${list[0].where} to approve.`);
      for (const row of list) {
        if (taken.has(row.card) && result?.state !== 'declined') { row.title = cleanText(taken.get(row.card).title, 80) || row.title; row.pending = waits ? `waiting for ${row.where} to approve` : PENDING.writing; pending.push(row); continue; }
        if (result?.state !== 'declined' && NOT_OPEN.includes(skipped.get(row.card))) { drop(row); continue; }
        row.missing = result?.offline ? `${row.where} is offline` : result?.older ? `${row.where} runs an older ELU` : result?.state === 'declined' ? `${row.where} declined` : skipped.has(row.card) ? `not open there: ${cleanText(skipped.get(row.card), 120)}` : `${row.where} did not take it${result?.error ? `: ${oneLine(result.error, 160)}` : ''}`;
      }
      show();
    };
    asking = true;
    const asked = Promise.all([...groups(rows.filter(row => !row.here && !row.team)).map(askMine), ...groups(rows.filter(row => row.team)).map(askTeam)]).catch(() => {}).then(() => { asking = false; });
    // The first summary is written from the records once they are in: when every computer has
    // sent its own, or after recordsMs. The round goes on showing updates while it is written.
    await Promise.race([asked, sleep(times.recordsMs ?? 2000, signal)]);
    if (first && !question && (pending.length || asking) && !signal?.aborted) {
      tally.first = 'writing'; show();
      const told = { round, signal: stopFirst.signal, writing: rows.filter(row => !settled(row)).length,
        records: rows.map(row => ({ session: row.title, computer: row.where, ...(row.project ? { project: row.project } : {}), ...(row.team ? { teammate: true, column: row.column } : { record: row.record }) })),
        notAsked: plan.notAsked.map(row => ({ session: row.title, computer: row.where, why: row.why })) };
      summary = Promise.resolve().then(() => first(told)).catch(() => null).then(result => {
        delete tally.first;
        if (Array.isArray(result?.runs)) task.runs = [...(task.runs ?? []), ...result.runs.map(run => ({ ...run, standup: round }))];
        if (result?.text) add(result.text, { from: `${FIRST_SUMMARY} · from the records${result.who ? ` · ${result.who}` : ''}`, line: false, update: true });
        show();
      });
    }
    // Updates as they arrive, until all are in, the owner stops it, or the round has waited long
    // enough for a question no session has started on. An answer run that goes is a turn like any
    // other: no clock of ELU's stops it, and the round waits for it. turns: those that ran on
    // another computer when it last said.
    const late = () => Date.now() - started > times.waitMs, minutes = Math.round(times.waitMs / 60000);
    const turns = new Set(), turning = row => { if (!row.here) return turns.has(row); try { return ['starting', 'running'].includes(pendingRequests(row.repo.root).find(value => value.id === row.request)?.state); } catch { return false; } };
    let remoteAt = 0, waiting = true;
    while ((pending.length || asking) && !signal?.aborted && waiting) {
      // Read before the answers are, so the answer of a run that ended since is still taken.
      waiting = Date.now() - started < times.capMs || pending.some(turning);
      let changed = false;
      const because = (row, why) => { if (row.pending !== why) { row.pending = why; changed = true; } };
      for (const row of pending.filter(row => row.here)) {
        let current = null; try { current = readTask(row.repo, row.task.id); } catch { current = null; }
        const said = current ? standupAnswer(row.repo, current, round) : null;
        if (said) { take(row, said); changed = true; continue; }
        let request = null; try { request = pendingRequests(row.repo.root).find(value => value.id === row.request) ?? null; } catch { request = null; }
        if (!current || !request || ['done', 'blocked'].includes(request.state)) { take(row, { text: `It did not answer.${request?.reason && request.reason !== 'Finished.' ? ` ${oneLine(request.reason, 300)}` : ''}`, failed: true }); changed = true; continue; }
        because(row, request.state === 'queued' ? conductorAnswersBeside() ? PENDING.queued : PENDING.older : PENDING.writing);
        // One that has not started after the wait is taken back, and its block says so.
        if (request.state === 'queued' && late() && takeRequest(row.repo.root, row.request)) { miss(row, `it did not start in ${minutes} minutes`); changed = true; }
      }
      if (pending.some(row => !row.here) && Date.now() - remoteAt >= times.remoteMs) {
        remoteAt = Date.now();
        for (const [key, list] of groups(pending.filter(row => !row.here))) {
          const team = list[0].team, id = row => team ? row.card : row.ref;
          // Only the sessions still waited for are asked about, so an update is sent here once.
          let result = null; try { result = await command({ type: team ? 'teamStandupRead' : 'remoteStandupRead', to: key, round, [team ? 'cards' : 'refs']: list.map(id) }); } catch { result = null; }
          for (const row of list) turns.delete(row);
          for (const item of Array.isArray(result?.pending) ? result.pending : []) { const row = item?.queued === false ? list.find(value => id(value) === (team ? item.card : item.ref)) : null; if (row) turns.add(row); }
          // A computer that does not answer the read is named in its blocks while the round waits for it.
          if (!result || result.offline || result.error) { for (const row of list) because(row, `${row.where} does not answer right now`); continue; }
          if (result?.state === 'declined') { for (const row of list) miss(row, `${row.where} declined`); changed = true; continue; }
          for (const said of result?.answers ?? []) { const row = list.find(value => id(value) === (team ? said.card : said.ref) && pending.includes(value)); if (row) { take(row, said.held ? { ...said, text: HELD_ANSWER, failed: true } : said); changed = true; } }
          const still = (result?.pending ?? []).filter(item => pending.some(row => id(row) === (team ? item.card : item.ref)));
          for (const item of still) { const row = list.find(value => id(value) === (team ? item.card : item.ref)); if (row && result?.state !== 'waiting') because(row, PENDING[item.why] ?? (item.queued ? item.working ? PENDING.older : PENDING.queued : PENDING.writing)); }
          // One that has not started there after the wait is taken back too.
          const slow = late() ? still.filter(item => item.queued && result?.state !== 'waiting').map(item => team ? item.card : item.ref) : [];
          if (slow.length) {
            try { await command({ type: team ? 'teamStandupStop' : 'remoteStandupStop', to: key, round, [team ? 'cards' : 'refs']: slow }); } catch { /* Named as missing all the same. */ }
            for (const ref of slow) { const row = list.find(value => id(value) === ref && pending.includes(value)); if (row) { miss(row, `it did not start in ${minutes} minutes`); changed = true; } }
          }
        }
      }
      if (changed) show();
      if ((pending.length || asking) && waiting) await sleep(times.pollMs, signal);
    }
    await asked;
    // Stopped, or waited long enough: every question still out is taken back, here and on the
    // other computers, so none runs later in a session. An answer run that still goes then is
    // one the owner stopped the round on (the round's time alone waits for it), and is stopped.
    for (const row of pending.filter(row => row.here)) {
      try { if (!takeRequest(row.repo.root, row.request)) { if (conductorAnswersBeside()) stopStandupAnswer(row.repo.root, row.request); else if (readTask(row.repo, row.task.id).standupTurn?.round === round) sendCommand({ type: 'stop', root: row.repo.root, taskId: row.task.id }); } } catch { /* Named as missing all the same. */ }
    }
    for (const [key, list] of groups(pending.filter(row => !row.here))) { try { await command({ type: list[0].team ? 'teamStandupStop' : 'remoteStandupStop', to: key, round }); } catch { /* Its answers stay there. */ } }
    for (const row of [...pending]) miss(row, signal?.aborted ? 'you stopped the standup before it was written' : `no answer in ${Math.round(times.capMs / 60000)} minutes`);
    // The first summary is of no use once the round is over: it is stopped, and what it wrote in time stays.
    stopFirst.abort(); if (summary) await summary;
    for (const row of rows) {
      kept.updates = [...kept.updates, { id: `u${kept.next++}`, round, session: row.title, agent: row.who ?? 'its agent', computer: row.where, ...(row.project ? { project: row.project } : {}), at: row.answeredAt ?? at(), ...(row.record && !row.team ? { record: row.record } : {}), ...(row.update != null ? { text: row.update } : { text: '', missing: row.missing ?? 'no model update', failed: true }), ...(row.team ? { teammate: true, peer: row.peer } : {}) }];
    }
    kept.notAsked = plan.notAsked.map(row => ({ session: row.title, computer: row.where, ...(row.project ? { project: row.project } : {}), state: row.team ? row.column : stateWord(row.state, row.waits), ...(row.waits ? { waits: row.waits } : {}), ...(row.last ? { lastReply: row.last } : {}), ...(row.team ? { teammate: true } : {}), why: row.why }));
    if (head) { for (const row of rows) Object.assign(row.block, { text: blockText(row), from: heading(row) }); head.text = headLine(rows, { question, done: true }); Object.assign(tally, { asked: rows.length, written: rows.filter(row => row.update != null).length, writing: 0 }); }
    if (plan.notAsked.length) add(`Not asked:\n${plan.notAsked.map(notAskedText).join('\n')}`);
    say(endLine({ rows, notAsked: plan.notAsked.length, stopped: signal?.aborted === true }));
  } catch (error) {
    stopFirst.abort();
    say(`The standup stopped: ${error.message}`);
  } finally {
    delete tally.first;
    Object.assign(task, { state: 'answered', error: null, activeRole: null, activeLog: null });
    try { saveTask(repo, task); event(repo, 'task-ended', { taskId: task.id, state: task.state }); } finally { release(); }
  }
  return { task, round, shown: rows.length, answered: rows.filter(row => row.update != null).length, listed: plan.notAsked.length };
}
// A round, then its summary: one turn of the Standup's own model, on the session's model and
// mode, that sums the round up and makes the Kanban changes its updates call for. Before it,
// while the sessions' models still write, the same model writes a first summary from the
// records, in a run beside the round (runStandupFirst). A round with nothing to sum up has
// neither. renew: a new stop for the summary after the owner's /stop of the waiting, or null
// when the stop ends everything. onSummary: called as the summary turn starts.
// The turn runs with nobody watching, so it only answers and keeps the Kanban (runConversation).
export async function runStandupSession(repo, id, { signal, renew = null, onSummary = null, ...options } = {}) {
  const first = options.first === undefined ? told => runStandupFirst(repo, readTask(repo, id), told.round, told) : options.first;
  const { task, shown, listed } = await runStandupRound(repo, id, { signal, ...options, first });
  if (!shown && !listed) return task;
  const summary = signal?.aborted ? renew?.() ?? null : signal;
  if (!summary || summary.aborted) return task;
  onSummary?.();
  return runConversation(repo, readTask(repo, id), SUMMARY_TEXT, { signal: summary, owner: true, as: { from: 'Standup', standupChat: true, line: true, summary: true } });
}
