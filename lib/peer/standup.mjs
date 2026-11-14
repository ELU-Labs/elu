import fs from 'node:fs';
import { atomic, isObject, mkdir, noSymlinks, readJson, refuse } from '../util.mjs';
import { readTask, taskTitle } from '../state.mjs';
import { conductorAnswersBeside, conductorTakesStandup, enqueue, sendCommand, stopStandupAnswer } from '../conductor.mjs';
import { pendingRequests, takeRequest } from '../workspace.mjs';
import { registeredProjects } from '../projects.mjs';
import { readBoard } from '../kanban.mjs';
import { currentTask } from '../plan.mjs';
import { pendingApprovals } from '../approvals.mjs';
import { HELD_ANSWER, QUESTION_MAX, ROUND, STANDUP_QUESTION, standupAnswer, standupLeftOut, standupRuns, standupWaits } from '../standup.mjs';
import { localRecord } from '../standup-record.mjs';
import { peerFile } from './paths.mjs';
import { sanitize } from './peerdata.mjs';
import { peerPolicy, peerSettings } from './settings.mjs';
import { teams } from './roster.mjs';
import { refuser } from './mine.mjs';
import { teamAccess } from './access.mjs';
import { MESSAGES_PER_DAY, count, originName, readCaps, sharedTeams } from './intake.mjs';
import { cardsFor, localRepos, savedProofs, sessionCards } from './cards.mjs';
import { runCosts } from '../agent-spend.mjs';

// A standup asked by another computer of mine (lib/standup-round.mjs; lib/peer/remote.mjs
// carries it, and only to a computer whose hello says standup: 1). That computer names the
// sessions here it wants asked; each is asked here only if it is one this computer would ask
// itself (standupLeftOut). What this computer has on record for each goes back at once, with
// no model run (records, lib/standup-record.mjs), and each is asked for its model's update in
// the same read-only answer run, through the conductor: its own turn when it is idle, a run
// beside its turn when it works, so nothing waits for a turn to end or for a free slot. Its
// answer is read back from the session's own chat, or from beside its turn. A round is kept a day.
// While the conductor here is of an older build (conductorTakesStandup), the round is told
// this computer is older and nothing is queued. A teammate's standup is further down.
const REF = /^[0-9a-f]{16}:[1-9][0-9]{0,9}$/, CARD = /^[0-9a-f]{16}$/, HEX64 = /^[0-9a-f]{64}$/, KEPT_MS = 24 * 3600000;
const roundFile = round => peerFile('remote', 'standup', `${round}.json`);
const short = (value, max) => sanitize(value, max);
const question = value => {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > QUESTION_MAX) refuse(`A standup question is 1 to ${QUESTION_MAX} characters.`);
  return value;
};
function readRound(round, machine) {
  if (!ROUND.test(round ?? '')) refuse('A standup needs its round.');
  const file = roundFile(round); noSymlinks(file);
  if (!fs.existsSync(file)) return null;
  const row = readJson(file);
  if (!isObject(row) || row.machine !== machine) refuse('That standup is not on this computer.');
  return row;
}
function prune(now, ...where) {
  const folder = peerFile(...where);
  try { noSymlinks(folder); if (!fs.existsSync(folder)) return; } catch { return; }
  for (const name of fs.readdirSync(folder)) { try { const file = `${folder}/${name}`; if (now - fs.statSync(file).mtimeMs > KEPT_MS) fs.rmSync(file, { force: true }); } catch { /* Gone already. */ } }
}
// An update goes back whole: ELU sets no limit of its own on it. What bounds one answer to a
// read is the link, whose line is 1 MiB: an answer carries at most READ_BYTES of updates, the
// rest come with the next read, and an update longer than that comes in parts. The asker says
// it reads them so (parts: 1), which sessions it still waits for (only), and from which
// character it has each (from); an answer cut short says where the next part starts (more).
// A build from before this says none of it and cuts each update at OLD_MAX itself, so it is
// sent no more than that, in one answer as it expects.
const READ_BYTES = 500 * 1024, OLD_MAX = 4000;
function fitted(answers, params, id) {
  if (params?.parts !== 1) return answers.map(row => ({ ...row, text: row.text.slice(0, OLD_MAX) }));
  const only = Array.isArray(params[`${id}s`]) ? new Set(params[`${id}s`]) : null, from = isObject(params.from) ? params.from : {}, out = [];
  let left = READ_BYTES;
  for (const row of answers) {
    if (only && !only.has(row[id])) continue;
    if (left <= 0) break;
    const start = Number.isSafeInteger(from[row[id]]) && from[row[id]] > 0 ? Math.min(from[row[id]], row.text.length) : 0;
    // Three bytes hold any character of the text as the link writes it; a part never ends inside one.
    let end = Math.min(row.text.length, start + Math.max(1, Math.floor(left / 3)));
    const last = row.text.charCodeAt(end - 1); if (end < row.text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    const text = row.text.slice(start, end); left -= Buffer.byteLength(JSON.stringify(text));
    out.push({ ...row, text, ...(start ? { from: start } : {}), ...(end < row.text.length ? { more: end } : {}) });
  }
  return out;
}
// The asking side of a read: request(params) asks the other computer. Updates come back
// whole: the parts of a long one are joined here, over as many reads as it takes (a few now,
// the rest when the round reads again), and until its last part is in, its session is still
// waited for. key: the computer asked; id: what names a session in the answer (ref or card).
const joining = new Map(), JOIN_MS = 8000, JOIN_KEPT_MS = 3600000;
export async function readWhole(request, { key, round, id, only = null }) {
  const now = Date.now(), mark = value => `${key}\0${round}\0${value}`, until = now + JOIN_MS, done = [];
  for (const [name, row] of joining) if (now - row.at > JOIN_KEPT_MS) joining.delete(name);
  let first = null;
  for (let wanted = only; ;) {
    const from = Object.fromEntries([...joining].filter(([name]) => name.startsWith(mark(''))).map(([name, row]) => [name.slice(mark('').length), row.text.length]).filter(([value]) => !wanted || wanted.includes(value)));
    const result = await request({ round, parts: 1, ...(wanted ? { [`${id}s`]: wanted } : {}), ...(Object.keys(from).length ? { from } : {}) });
    first ??= result;
    if (!isObject(result) || !Array.isArray(result.answers)) break;
    const more = [];
    for (const row of result.answers) {
      if (!isObject(row) || typeof row[id] !== 'string' || typeof row.text !== 'string') continue;
      const kept = joining.get(mark(row[id])), start = Number.isSafeInteger(row.from) ? row.from : 0;
      // A part that does not follow what is here: the update is read again from its start.
      if (start !== (kept?.text.length ?? 0) && start !== 0) { joining.delete(mark(row[id])); continue; }
      const text = `${start ? kept.text : ''}${row.text}`;
      if (Number.isSafeInteger(row.more)) { joining.set(mark(row[id]), { text, at: now }); more.push(row[id]); }
      else { joining.delete(mark(row[id])); done.push({ ...row, text }); }
    }
    if (!more.length || Date.now() >= until) break;
    wanted = more;
  }
  return isObject(first) && Array.isArray(first.answers) ? { ...first, answers: done } : first;
}
// What this computer has on record for the sessions asked, for the asker's blocks: { ref,
// record } each. The link takes a line of 1 MiB, so when all of them together are longer
// than an answer may be, each one's last text is cut, shorter until they fit; nothing else is.
const SAID_CHARS = 4000;
function recordsOf(items, now) {
  const repos = registeredProjects();
  let approvals = []; try { approvals = pendingApprovals(); } catch { approvals = []; }
  const rows = items.flatMap(item => {
    try { const repo = repos.find(value => value.root === item.root), task = readTask(repo, item.taskId); return [{ ref: item.ref, record: localRecord(repo, task, { now, approvals: approvals.filter(row => !row.root || row.root === repo.root) }) }]; } catch { return []; }
  });
  let out = rows;
  for (let chars = SAID_CHARS; Buffer.byteLength(JSON.stringify(out)) > READ_BYTES && chars >= 60; chars = Math.floor(chars / 4)) {
    out = rows.map(row => typeof row.record.said === 'string' && row.record.said.length > chars ? { ...row, record: { ...row.record, said: `${row.record.said.slice(0, chars)} …` } } : row);
  }
  return out;
}
// Asks the sessions named by refs ("<project key>:<session id>") of round, with the owner's
// question when he asked one; projectKey(root) gives a project's key as the listing names it.
// Returns { asked: [{ ref, title }], skipped: [{ ref, why }], records: [{ ref, record }] }.
export function hostStandup(params, machine, { projectKey, kick = () => {}, now = Date.now() } = {}) {
  if (!isObject(params)) refuse('A standup needs its round.');
  const round = params.round, kept = readRound(round, machine);
  if (kept) return { asked: kept.asked.map(({ ref, title }) => ({ ref, title })), skipped: kept.skipped ?? [], records: recordsOf(kept.asked, now) };
  if (!conductorTakesStandup()) return { older: true, asked: [], skipped: [] };
  prune(now, 'remote', 'standup');
  const asked0 = { round, by: 'You', ...(question(params.question) ? { question: params.question } : {}) };
  const refs = [...new Set(Array.isArray(params.refs) ? params.refs.filter(ref => typeof ref === 'string' && REF.test(ref)) : [])];
  let approvals = []; try { approvals = pendingApprovals(); } catch { approvals = []; }
  const repos = registeredProjects(), asked = [], skipped = [];
  for (const ref of refs) {
    const [project, id] = ref.split(':'), repo = repos.find(row => projectKey(row.root) === project);
    let task = null; try { task = repo ? readTask(repo, id) : null; } catch { task = null; }
    if (!task) { skipped.push({ ref, why: 'gone' }); continue; }
    let why; try { why = standupLeftOut(readBoard(repo), task, { now, waits: standupWaits(task, { plan: currentTask(repo, task.id), approvals: approvals.filter(item => item.root === repo.root) }) }); } catch (error) { why = short(error.message, 120); }
    if (why) { skipped.push({ ref, why }); continue; }
    try {
      const request = enqueue(repo.root, STANDUP_QUESTION, { continuationTaskId: task.id, priority: 1, standupFor: asked0 });
      asked.push({ ref, root: repo.root, taskId: task.id, requestId: request.id, title: short(taskTitle(task), 80) });
    } catch (error) { skipped.push({ ref, why: short(error.message, 120) }); }
  }
  mkdir(peerFile('remote', 'standup')); atomic(roundFile(round), { round, machine, at: new Date(now).toISOString(), asked, skipped });
  if (asked.length) kick();
  return { asked: asked.map(({ ref, title }) => ({ ref, title })), skipped, records: recordsOf(asked, now) };
}
// Why a question that has not started has not: 'older' while the conductor here is of a build
// that answers only once the session's turn ends, else 'queued'. One that runs: 'writing'.
const pendingWhy = request => request.state !== 'queued' ? 'writing' : conductorAnswersBeside() ? 'queued' : 'older';
// What the sessions of round said so far: { answers: [{ ref, title, who, text, failed }], pending: [{ ref, working, queued, why }] }.
export function hostStandupRead(params, machine) {
  const row = readRound(params?.round, machine);
  if (!row) refuse('That standup is not on this computer.');
  const repos = registeredProjects(), answers = [], pending = [];
  for (const item of row.asked) {
    const repo = repos.find(value => value.root === item.root);
    let task = null; try { task = repo ? readTask(repo, item.taskId) : null; } catch { task = null; }
    const said = task ? standupAnswer(repo, task, row.round) : null;
    if (said) { answers.push({ ref: item.ref, title: item.title, who: short(said.who, 40), text: short(said.text, Infinity), at: said.at, ...(said.failed ? { failed: true } : {}) }); continue; }
    let request = null; try { request = pendingRequests(item.root).find(value => value.id === item.requestId) ?? null; } catch { request = null; }
    if (!task || !request || ['done', 'blocked'].includes(request.state)) answers.push({ ref: item.ref, title: item.title, who: '', text: `It did not answer.${request?.reason && request.reason !== 'Finished.' ? ` ${short(request.reason, 300)}` : ''}`, failed: true });
    else pending.push({ ref: item.ref, working: ['running', 'preparing'].includes(task.state) && !task.standupTurn, queued: request.state === 'queued', why: pendingWhy(request) });
  }
  return { answers: fitted(answers, params, 'ref'), pending };
}
// Stops one answer run of round that has started: by its request, which leaves the session's
// own turn alone; under a conductor from before that, only the answer turn the session is in.
function stopAnswer(root, requestId, taskId, round, repos) {
  if (conductorAnswersBeside()) {
    if (pendingRequests(root).find(value => value.id === requestId)?.state !== 'running') return false;
    stopStandupAnswer(root, requestId); return true;
  }
  const repo = repos.find(value => value.root === root), task = repo ? readTask(repo, taskId) : null;
  if (task?.standupTurn?.round !== round) return false;
  sendCommand({ type: 'stop', root, taskId }); return true;
}
// Stops waiting: the questions of round not started yet are taken back, and an answer turn
// of it that runs is stopped. refs: only those sessions; without it, all of the round's.
export function hostStandupStop(params, machine) {
  const row = readRound(params?.round, machine);
  if (!row) return { stopped: 0 };
  const only = Array.isArray(params.refs) ? new Set(params.refs) : null, repos = registeredProjects();
  let stopped = 0;
  for (const item of row.asked.filter(value => !only || only.has(value.ref))) {
    try { if (takeRequest(item.root, item.requestId)) { stopped++; continue; } } catch { /* Started already. */ }
    try { if (stopAnswer(item.root, item.requestId, item.taskId, row.round, repos)) stopped++; } catch { /* Nothing to stop. */ }
  }
  return { stopped };
}

// ---- A teammate's standup ----
// A teammate asks the sessions of mine they see as cards on our shared Kanban (lib/peer/cards.mjs):
// only cards this computer tells them, of the owner's own sessions that are open
// (standupLeftOut). It runs as the owner's setting for the teams we share says: Auto asks at
// once; Manual, or a team with no setting, waits for his y, one approval for the round, and
// his n declines it. Each session answers once a round, in the read-only answer turn told
// his rules for teammates; only the answer as the teammate check leaves it goes back
// (lib/standup.mjs, teammateAnswer), with the card's title and the agent's name. A muted
// teammate is declined; every request counts toward the teammate's daily message limit. A round
// is one of the teammate's requests here. What a session has on record costs nothing; each model
// update spends from their daily allowance and their teams' what it cost (standupSpend), so a
// round asks every session the limits leave room for. Past a limit a session is not asked, and
// its line says which limit, plainly.
const teamFile = (key, round) => peerFile('standup', `${round}-${key.slice(0, 16)}.json`);
const FILE = /^(standup-[0-9a-f]{16})-([0-9a-f]{16})\.json$/;
function readTeamRound(key, round) {
  if (!ROUND.test(round ?? '')) refuse('A standup needs its round.');
  const file = teamFile(key, round); noSymlinks(file);
  if (!fs.existsSync(file)) return null;
  const row = readJson(file);
  return isObject(row) && row.peer === key ? row : null;
}
const saveTeamRound = row => { mkdir(peerFile('standup')); atomic(teamFile(row.peer, row.round), row); };
// Every shared team set to Auto: a standup of theirs is asked at once.
const autoFor = ids => ids.length > 0 && ids.every(id => teamAccess(id)?.handling === 'auto');
// What one model update usually costs: it holds that much of the allowance while it runs, and
// counts that much when its vendor reports no cost.
export const UPDATE_USD = 0.1;
// The daily limit here that runs more requests or usd more would pass, or null.
function limitPassed(peer, teamIds, { runs = 0, usd = 0 } = {}) {
  const caps = peerSettings().caps, used = readCaps(), mine = used.peers[peer] ?? { runs: 0, usd: 0 };
  if (runs && mine.runs + runs > caps.peerRunsPerDay) return { amount: `${caps.peerRunsPerDay} ${caps.peerRunsPerDay === 1 ? 'request' : 'requests'}` };
  if (mine.usd + usd > caps.peerUsdPerDay) return { amount: `$${caps.peerUsdPerDay.toFixed(2)}` };
  if (teamIds.some(id => (used.teams[id]?.usd ?? 0) + usd > caps.teamUsdPerDay)) return { amount: `$${caps.teamUsdPerDay.toFixed(2)}`, team: true };
  return null;
}
// Why a session was not asked: to the teammate (you), and to the owner here (by: their name).
function notAsked(passed, peer, by = null) {
  if (by) return `Not asked: ${passed.team ? `${by}'s team has` : `${by} has`} used the ${passed.amount} a day this computer allows ${passed.team ? 'it' : 'them'}.`;
  const place = refuser(peer) === 'computer' ? 'computer' : "teammate's computer";
  return `Not asked: ${passed.team ? 'your team has' : 'you have'} used the ${passed.amount} a day this ${place} allows ${passed.team ? 'it' : 'you'}.`;
}
// A teammate's model update as it starts (lib/runner.mjs): past a limit it is not asked, an
// error that says why to the owner here (its sent: to the teammate); otherwise it holds
// UPDATE_USD, and the function returned counts what its runs cost once they have run.
export function standupSpend(asked) {
  const teamIds = asked.teams ?? [], passed = limitPassed(asked.peer, teamIds, { usd: UPDATE_USD });
  if (passed) throw Object.assign(new Error(notAsked(passed, asked.peer, asked.by)), { standupLimit: true, sent: notAsked(passed, asked.peer) });
  count(asked.peer, teamIds, { usd: UPDATE_USD });
  return runs => count(asked.peer, teamIds, { usd: runCosts({ runs }).reduce((total, cost) => total + (Number.isFinite(cost) ? cost : UPDATE_USD), 0) - UPDATE_USD });
}
// A round asked by an earlier build reserved what one run may spend for each session: what the
// answer runs of round cost, a run without a cost counted as all it reserved.
const spent = (repo, task, round, reserved) => runCosts({ ...task, runs: standupRuns(repo, task, round) }).reduce((total, cost) => total + (Number.isFinite(cost) ? cost : reserved), 0);
const settle = (row, target, usd) => { if (!target.reservedUsd) return; count(row.peer, row.teams, { usd: Math.min(usd, target.reservedUsd) - target.reservedUsd }); target.reservedUsd = 0; };
function askTargets(ctx, row) {
  const passed = limitPassed(row.peer, row.teams, { runs: 1, usd: UPDATE_USD });
  for (const target of row.targets) {
    if (passed) { target.failed = notAsked(passed, row.peer); continue; }
    try { target.requestId = enqueue(target.root, STANDUP_QUESTION, { continuationTaskId: target.taskId, priority: 1, standupFor: { round: row.round, by: `@${row.name}`, ...(row.question ? { question: row.question } : {}), peer: row.peer, teams: row.teams } }).id; }
    catch (error) { target.failed = short(error.message, 200); }
  }
  row.state = 'asked'; row.askedAt = new Date().toISOString();
  if (row.targets.some(target => target.requestId)) { count(row.peer, row.teams, { runs: 1 }); ctx.kick?.(); ctx.soon?.(); }
}
// elu.standup.ask: { round, cards: [card ids], question? }. Returns { state: asked | waiting |
// declined, asked: [{ card, title }], skipped: [{ card, why }] }. A round asked again is answered as before.
export function teamStandupAsk(ctx, key, params, { now = Date.now() } = {}) {
  const ids = sharedTeams(ctx.me.key, key).map(state => state.id);
  if (!ids.length) refuse('That team is not shared with you.');
  if (!isObject(params)) refuse('A standup needs its round.');
  const kept = readTeamRound(key, params.round);
  const told = row => ({ state: row.state === 'stopped' ? 'declined' : row.state, asked: row.targets.map(({ card, title }) => ({ card, title })), skipped: row.skipped });
  if (kept) return told(kept);
  if (!conductorTakesStandup()) return { older: true, state: null, asked: [], skipped: [] };
  if ((readCaps(now).peers[key]?.messages ?? 0) >= MESSAGES_PER_DAY) refuse(`You have reached the daily message limit for this ${refuser(key)}.`);
  count(key, [], { messages: 1 });
  if (peerPolicy(key).muted) return { state: 'declined', asked: [], skipped: [] };
  prune(now, 'standup');
  const wanted = [...new Set(Array.isArray(params.cards) ? params.cards.filter(id => typeof id === 'string' && CARD.test(id)) : [])];
  let repos = null; try { repos = ctx.repos?.() ?? localRepos(now); } catch { repos = new Map(); }
  let rows = []; try { rows = sessionCards({ owner: ctx.me.name, repos, now }); } catch { rows = []; }
  const allowed = new Set(cardsFor(key, ctx.me.key, rows, repos, savedProofs(key), ids).map(card => card.id));
  let approvals = []; try { approvals = pendingApprovals(); } catch { approvals = []; }
  const projects = registeredProjects(), targets = [], skipped = [];
  for (const card of wanted) {
    const row = allowed.has(card) ? rows.find(value => value.card.id === card) : null;
    // A session a teammate's message started is never asked here, though its card is shared:
    // the reason says whose message it was, never that it is not shared.
    if (row?.origin) { skipped.push({ card, why: row.origin.peer === key ? 'your message started it' : "a teammate's message started it" }); continue; }
    const repo = row && projects.find(value => value.root === row.root);
    let task = null; try { task = repo ? readTask(repo, row.taskId) : null; } catch { task = null; }
    if (!task) { skipped.push({ card, why: 'not shared with you' }); continue; }
    let why; try { why = standupLeftOut(readBoard(repo), task, { now, waits: standupWaits(task, { plan: currentTask(repo, task.id), approvals: approvals.filter(item => item.root === repo.root) }) }); } catch (error) { why = short(error.message, 120); }
    if (why) { skipped.push({ card, why }); continue; }
    targets.push({ card, root: repo.root, taskId: task.id, title: row.card.title });
  }
  const name = originName(teams(), key).replace(/[\s@]+/g, '') || key.slice(0, 8);
  const row = { round: params.round, peer: key, name, teams: ids.slice(0, 32), question: question(params.question), at: new Date(now).toISOString(), state: 'waiting', targets, skipped };
  if (targets.length && autoFor(ids)) askTargets(ctx, row);
  else if (targets.length) ctx.event?.(`@${name} asks every session for a standup update`);
  else row.state = 'asked';
  saveTeamRound(row);
  return told(row);
}
// elu.standup.read: { round } -> { state, answers: [{ card, title, who, text, failed?, held? }], pending: [{ card, working, queued }] }.
export function teamStandupRead(key, params) {
  const row = readTeamRound(key, params?.round);
  if (!row) refuse('That standup is not on this computer.');
  if (row.state !== 'asked') return { state: row.state === 'stopped' ? 'declined' : row.state, answers: [], pending: row.state === 'waiting' ? row.targets.map(({ card }) => ({ card, working: false, queued: true })) : [] };
  const projects = registeredProjects(), answers = [], pending = [];
  let settled = false;
  for (const target of row.targets) {
    if (/^not asked/i.test(target.failed ?? '') && !target.requestId) { answers.push({ card: target.card, title: target.title, who: '', text: target.failed.startsWith('Not') ? target.failed : `It was ${target.failed}.`, failed: true }); continue; }
    const repo = projects.find(value => value.root === target.root);
    let task = null; try { task = repo ? readTask(repo, target.taskId) : null; } catch { task = null; }
    const said = task ? standupAnswer(repo, task, row.round) : null;
    if (said && target.reservedUsd) { settle(row, target, spent(repo, task, row.round, target.reservedUsd)); settled = true; }
    // Only what the teammate check let through leaves: the update, or the line that it was held.
    if (said) { answers.push({ card: target.card, title: target.title, who: short(said.who, 40), text: said.held || typeof said.sent !== 'string' ? HELD_ANSWER : short(said.sent, Infinity), ...(said.failed ? { failed: true } : {}), ...(said.held ? { held: true } : {}) }); continue; }
    let request = null; try { request = target.requestId ? pendingRequests(target.root).find(value => value.id === target.requestId) ?? null : null; } catch { request = null; }
    if (!task || !request || ['done', 'blocked'].includes(request.state)) answers.push({ card: target.card, title: target.title, who: '', text: 'It did not answer.', failed: true });
    else pending.push({ card: target.card, working: ['running', 'preparing'].includes(task.state) && !task.standupTurn, queued: request.state === 'queued' });
  }
  if (settled) saveTeamRound(row);
  return { state: 'asked', answers: fitted(answers, params, 'card'), pending };
}
// elu.standup.stop: { round, cards? }: the questions not started yet are taken back, and an
// answer turn that runs is stopped; a round that waits for the owner waits no more.
export function teamStandupStop(key, params) {
  const row = readTeamRound(key, params?.round);
  if (!row) return { stopped: 0 };
  if (row.state === 'waiting') { row.state = 'stopped'; saveTeamRound(row); return { stopped: row.targets.length }; }
  const only = Array.isArray(params.cards) ? new Set(params.cards) : null, projects = registeredProjects();
  let stopped = 0;
  for (const target of row.targets.filter(value => value.requestId && (!only || only.has(value.card)))) {
    // A question taken back before it ran spent nothing.
    try { if (takeRequest(target.root, target.requestId)) { if (target.reservedUsd) { count(row.peer, row.teams, { runs: -1 }); settle(row, target, 0); } stopped++; continue; } } catch { /* Started already. */ }
    try { if (stopAnswer(target.root, target.requestId, target.taskId, row.round, projects)) stopped++; } catch { /* Nothing to stop. */ }
  }
  saveTeamRound(row);
  return { stopped };
}
export function teamStandupMethods(ctx) {
  return {
    'elu.standup.ask': (params, session) => teamStandupAsk(ctx, session.key, params),
    'elu.standup.read': (params, session) => { if (!sharedTeams(ctx.me.key, session.key).length) refuse('That team is not shared with you.'); return teamStandupRead(session.key, params); },
    'elu.standup.stop': (params, session) => teamStandupStop(session.key, params),
  };
}
// The owner's y and n on a teammate's standup that waits: id is the item's ("<round>-<key start>").
function waitingRound(id) {
  const found = FILE.exec(`${id}.json`); if (!found) refuse('That standup is no longer waiting.');
  const file = peerFile('standup', `${id}.json`); noSymlinks(file);
  const row = fs.existsSync(file) ? readJson(file) : null;
  if (!isObject(row) || row.state !== 'waiting' || !HEX64.test(row.peer ?? '')) refuse('That standup is no longer waiting.');
  return row;
}
// A round is asked as things stand when he says y: a teammate removed from every team we
// shared, or muted since, is declined, and the rules told are those of the teams we share now.
export function approveStandup(ctx, id) {
  const row = waitingRound(id), ids = sharedTeams(ctx.me.key, row.peer).map(state => state.id);
  if (!ids.length || peerPolicy(row.peer).muted) { row.state = 'declined'; saveTeamRound(row); return { asked: 0, declined: true }; }
  row.teams = ids.slice(0, 32); askTargets(ctx, row); saveTeamRound(row);
  return { asked: row.targets.filter(target => target.requestId).length };
}
export function declineStandup(id) { const row = waitingRound(id); row.state = 'declined'; saveTeamRound(row); return { declined: true }; }
// Teammates' standups that wait for the owner, for the board: { id, peer, name, question, sessions, at }.
export function waitingStandups(now = Date.now()) {
  const folder = peerFile('standup');
  try { noSymlinks(folder); if (!fs.existsSync(folder)) return []; } catch { return []; }
  return fs.readdirSync(folder).flatMap(name => {
    if (!FILE.test(name)) return [];
    try { const row = readJson(`${folder}/${name}`); return isObject(row) && row.state === 'waiting' && HEX64.test(row.peer ?? '') && now - Date.parse(row.at) < KEPT_MS ? [{ id: name.slice(0, -5), peer: row.peer, name: short(row.name, 64), question: row.question ? short(row.question, 400) : null, sessions: row.targets.length, at: row.at }] : []; } catch { return []; }
  });
}
// ---- Asking a teammate's computer (the asker's side) ----
// teamStandup, teamStandupRead and teamStandupStop from lib/standup-round.mjs. A teammate who
// is not connected, or whose hello does not say standup: 1, is never sent it. What comes back
// is checked here before anything reads it.
export const TEAM_COMMANDS = ['teamStandup', 'teamStandupRead', 'teamStandupStop'];
const cleanRows = (value, fields) => (Array.isArray(value) ? value : []).flatMap(row => isObject(row) && CARD.test(row.card ?? '') ? [Object.fromEntries(Object.entries(fields).map(([name, max]) => [name, max === true ? row[name] === true : short(String(row[name] ?? ''), max)]).concat([['card', row.card]]))] : []);
export async function teamStandupCommand(ctx, command) {
  if (!HEX64.test(command.to ?? '') || !sharedTeams(ctx.me.key, command.to).length) refuse('Choose a teammate.');
  if (!ROUND.test(command.round ?? '')) refuse('A standup needs its round.');
  const session = ctx.session(command.to);
  if (!session) return { offline: true };
  if (session.remoteHello?.standup !== 1) return { older: true };
  const method = { teamStandup: 'elu.standup.ask', teamStandupRead: 'elu.standup.read', teamStandupStop: 'elu.standup.stop' }[command.type];
  const params = { round: command.round, ...(Array.isArray(command.cards) ? { cards: command.cards.filter(id => CARD.test(id ?? '')) } : {}), ...(command.type === 'teamStandup' && question(command.question) ? { question: command.question } : {}) };
  let result;
  // A read takes every update whole, the parts of a long one joined (readWhole).
  try { result = command.type === 'teamStandupRead' ? await readWhole(extra => session.request(method, extra), { key: command.to, round: command.round, id: 'card', only: params.cards ?? null }) : await session.request(method, params); }
  catch (error) { if (error.details?.rpc?.code === -32601) return { older: true }; throw error; }
  if (!isObject(result)) return {};
  // Its conductor runs an older build still: nothing was asked there.
  if (result.older === true) return { older: true };
  const state = ['asked', 'waiting', 'declined'].includes(result.state) ? result.state : null;
  if (command.type === 'teamStandup') return { state, asked: cleanRows(result.asked, { title: 80 }), skipped: cleanRows(result.skipped, { why: 120 }) };
  if (command.type === 'teamStandupRead') return { state, answers: cleanRows(result.answers, { title: 80, who: 40, text: Infinity, failed: true, held: true }), pending: cleanRows(result.pending, { working: true, queued: true }) };
  return { stopped: Number.isSafeInteger(result.stopped) ? result.stopped : 0 };
}
