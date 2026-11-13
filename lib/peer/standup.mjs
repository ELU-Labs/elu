import fs from 'node:fs';
import { atomic, isObject, mkdir, noSymlinks, readJson, refuse } from '../util.mjs';
import { readTask, taskTitle } from '../state.mjs';
import { conductorTakesStandup, enqueue, sendCommand } from '../conductor.mjs';
import { pendingRequests, takeRequest } from '../workspace.mjs';
import { registeredProjects } from '../projects.mjs';
import { readBoard } from '../kanban.mjs';
import { currentTask } from '../plan.mjs';
import { pendingApprovals } from '../approvals.mjs';
import { HELD_ANSWER, QUESTION_MAX, ROUND, STANDUP_QUESTION, standupLeftOut, standupReply, standupWaits } from '../standup.mjs';
import { peerFile } from './paths.mjs';
import { sanitize } from './peerdata.mjs';
import { peerPolicy, peerSettings } from './settings.mjs';
import { teams } from './roster.mjs';
import { teamAccess } from './access.mjs';
import { MESSAGES_PER_DAY, count, originName, readCaps, sharedTeams } from './intake.mjs';
import { cardsFor, localRepos, savedProofs, sessionCards } from './cards.mjs';
import { peerRunUsd } from '../adapters/claude.mjs';

// A standup asked by another computer of mine (lib/standup-round.mjs; lib/peer/remote.mjs
// carries it, and only to a computer whose hello says standup: 1). That computer names the
// sessions here it wants asked; each is asked here only if it is one this computer would ask
// itself (standupLeftOut), in the same read-only answer turn (runStandup), through the
// conductor. Its answer is read back from the session's own chat. A round is kept a day.
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
// Asks the sessions named by refs ("<project key>:<session id>") of round, with the owner's
// question when he asked one; projectKey(root) gives a project's key as the listing names it.
// Returns { asked: [{ ref, title }], skipped: [{ ref, why }] }.
export function hostStandup(params, machine, { projectKey, kick = () => {}, now = Date.now() } = {}) {
  if (!isObject(params)) refuse('A standup needs its round.');
  const round = params.round, kept = readRound(round, machine);
  if (kept) return { asked: kept.asked.map(({ ref, title }) => ({ ref, title })), skipped: kept.skipped ?? [] };
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
  return { asked: asked.map(({ ref, title }) => ({ ref, title })), skipped };
}
// What the sessions of round said so far: { answers: [{ ref, title, who, text, failed }], pending: [{ ref, working, queued }] }.
export function hostStandupRead(params, machine) {
  const row = readRound(params?.round, machine);
  if (!row) refuse('That standup is not on this computer.');
  const repos = registeredProjects(), answers = [], pending = [];
  for (const item of row.asked) {
    const repo = repos.find(value => value.root === item.root);
    let task = null; try { task = repo ? readTask(repo, item.taskId) : null; } catch { task = null; }
    const said = task ? standupReply(task, row.round) : null;
    if (said) { answers.push({ ref: item.ref, title: item.title, who: short(said.who, 40), text: short(said.text, 4000), at: said.at, ...(said.failed ? { failed: true } : {}) }); continue; }
    let request = null; try { request = pendingRequests(item.root).find(value => value.id === item.requestId) ?? null; } catch { request = null; }
    if (!task || !request || ['done', 'blocked'].includes(request.state)) answers.push({ ref: item.ref, title: item.title, who: '', text: `It did not answer.${request?.reason && request.reason !== 'Finished.' ? ` ${short(request.reason, 300)}` : ''}`, failed: true });
    else pending.push({ ref: item.ref, working: ['running', 'preparing'].includes(task.state) && !task.standupTurn, queued: request.state === 'queued' });
  }
  return { answers, pending };
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
    try {
      const repo = repos.find(value => value.root === item.root), task = repo ? readTask(repo, item.taskId) : null;
      if (task?.standupTurn?.round === row.round) { sendCommand({ type: 'stop', root: item.root, taskId: item.taskId }); stopped++; }
    } catch { /* Nothing to stop. */ }
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
// teammate is declined; every request counts toward the teammate's daily message limit. Each
// answer turn is one of the teammate's runs here and reserves what one run may spend from
// their daily allowance and their teams', as any run a teammate causes; it is settled to what
// the turn cost once its answer is read, and given back when the question is taken back.
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
function reserve(row) {
  const caps = peerSettings().caps, used = readCaps(), mine = used.peers[row.peer] ?? { runs: 0, usd: 0 }, usd = peerRunUsd();
  if (mine.runs >= caps.peerRunsPerDay) return 'the daily request limit for this teammate';
  if (mine.usd + usd > caps.peerUsdPerDay) return 'the daily spending limit for this teammate';
  if (row.teams.some(id => (used.teams[id]?.usd ?? 0) + usd > caps.teamUsdPerDay)) return "the team's daily spending limit here";
  count(row.peer, row.teams, { runs: 1, usd }); return usd;
}
// What an answer turn of round cost, its runs without a cost counted at all it reserved.
const spent = (task, round, reserved) => (task?.runs ?? []).filter(run => run.standup === round).reduce((total, run) => total + (run.costUnknown || !Number.isFinite(run.costUsd) ? reserved : run.costUsd), 0);
const settle = (row, target, usd) => { if (!target.reservedUsd) return; count(row.peer, row.teams, { usd: Math.min(usd, target.reservedUsd) - target.reservedUsd }); target.reservedUsd = 0; };
function askTargets(ctx, row) {
  for (const target of row.targets) {
    const reserved = reserve(row);
    if (typeof reserved === 'string') { target.failed = `not asked: ${reserved}`; continue; }
    try { target.requestId = enqueue(target.root, STANDUP_QUESTION, { continuationTaskId: target.taskId, priority: 1, standupFor: { round: row.round, by: `@${row.name}`, ...(row.question ? { question: row.question } : {}), peer: row.peer, teams: row.teams } }).id; target.reservedUsd = reserved; }
    catch (error) { target.failed = short(error.message, 200); count(row.peer, row.teams, { runs: -1, usd: -reserved }); }
  }
  row.state = 'asked'; row.askedAt = new Date().toISOString();
  if (row.targets.some(target => target.requestId)) { ctx.kick?.(); ctx.soon?.(); }
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
  if ((readCaps(now).peers[key]?.messages ?? 0) >= MESSAGES_PER_DAY) refuse('You have reached the daily message limit for this teammate.');
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
    const row = allowed.has(card) ? rows.find(value => value.card.id === card && !value.origin) : null;
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
    if (target.failed?.startsWith('not asked') && !target.requestId) { answers.push({ card: target.card, title: target.title, who: '', text: `It was ${target.failed}.`, failed: true }); continue; }
    const repo = projects.find(value => value.root === target.root);
    let task = null; try { task = repo ? readTask(repo, target.taskId) : null; } catch { task = null; }
    const said = task ? standupReply(task, row.round) : null;
    if (said && target.reservedUsd) { settle(row, target, spent(task, row.round, target.reservedUsd)); settled = true; }
    // Only what the teammate check let through leaves: the update, or the line that it was held.
    if (said) { answers.push({ card: target.card, title: target.title, who: short(said.who, 40), text: said.held || typeof said.sent !== 'string' ? HELD_ANSWER : short(said.sent, 4000), ...(said.failed ? { failed: true } : {}), ...(said.held ? { held: true } : {}) }); continue; }
    let request = null; try { request = target.requestId ? pendingRequests(target.root).find(value => value.id === target.requestId) ?? null : null; } catch { request = null; }
    if (!task || !request || ['done', 'blocked'].includes(request.state)) answers.push({ card: target.card, title: target.title, who: '', text: 'It did not answer.', failed: true });
    else pending.push({ card: target.card, working: ['running', 'preparing'].includes(task.state) && !task.standupTurn, queued: request.state === 'queued' });
  }
  if (settled) saveTeamRound(row);
  return { state: 'asked', answers, pending };
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
    try {
      const repo = projects.find(value => value.root === target.root), task = repo ? readTask(repo, target.taskId) : null;
      if (task?.standupTurn?.round === row.round) { sendCommand({ type: 'stop', root: target.root, taskId: target.taskId }); stopped++; }
    } catch { /* Nothing to stop. */ }
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
  try { result = await session.request(method, params); }
  catch (error) { if (error.details?.rpc?.code === -32601) return { older: true }; throw error; }
  if (!isObject(result)) return {};
  // Its conductor runs an older build still: nothing was asked there.
  if (result.older === true) return { older: true };
  const state = ['asked', 'waiting', 'declined'].includes(result.state) ? result.state : null;
  if (command.type === 'teamStandup') return { state, asked: cleanRows(result.asked, { title: 80 }), skipped: cleanRows(result.skipped, { why: 120 }) };
  if (command.type === 'teamStandupRead') return { state, answers: cleanRows(result.answers, { title: 80, who: 40, text: 4000, failed: true, held: true }), pending: cleanRows(result.pending, { working: true, queued: true }) };
  return { stopped: Number.isSafeInteger(result.stopped) ? result.stopped : 0 };
}
