import fs from 'node:fs';
import path from 'node:path';
import { isObject } from './util.mjs';
import { projectSnapshot, registeredProjects } from './projects.mjs';
import { pendingApprovals } from './approvals.mjs';
import { heldBySession, lastActivity, readBoard, rowSince, sessionDetail, sessionPlace } from './kanban.mjs';
import { sessionChecklist } from './checklist.mjs';
import { stopLine } from './stop-line.mjs';
import { blockedRows, ranIn } from './blocked.mjs';
import { taskEta } from './plan.mjs';
import { requestGoal, requestTitle, sessionGoal, taskTitle } from './state.mjs';
import { requestOrder } from './workspace.mjs';
import { waitingText } from './waiting.mjs';
import { namesProcess, sameProcess } from './process.mjs';
import { jobsLine } from './jobs.mjs';
import { agentName, cleanTokens, compact, leastCost, logSpend, modelLabel, moneyText, pricedSpend, runSpends, shortModel } from './agent-spend.mjs';
import { botHelpers, botOfKey, botWork, getBot } from './bots.mjs';
import { OWN_MODEL } from './vendors.mjs';
import { claudeId } from './models.mjs';
import { redact } from './publish.mjs';
import { sanitize } from './peer/peerdata.mjs';
import { columns, cut } from './width.mjs';

// What every session on this computer is doing, read from ELU's own records. No model is asked
// and nothing is sent anywhere. Two tables come out of it. Sessions: one row per session, with
// one of eight state words, why, since when, the Task's own estimate and the highest step its
// records prove. Agents: one row per agent of each session, with its tokens and its cost. The
// bot that oversees the sessions shows both in its chat's Artifacts tab, drawn by the renderer
// every artifact is drawn by (lib/terminal-artifacts.mjs), and reads them as a few short lines
// (stateDigest). Nothing here is stored: each is worked out when it is asked for. Sessions on
// the owner's other computers are not here: their records live there.

// The state words, in the order of what needs the owner first. A stored state is never one of
// them: a stored blocked is a refused command or a dropped connection, a session whose checks
// failed is stored as not verified, and a published one still says ready.
export const STATUS_WORDS = Object.freeze(['Needs approval', 'Asks you', 'Blocked', 'Stopped', 'Ready for your check', 'Working', 'Queued', 'Done']);
// What a session's records prove of its work, the least first. Only the first is the agent's
// own word: it marked every objective met. The others are git's, the checks', the reviewing
// bots' and the owner's.
export const PROOF_STEPS = Object.freeze({ reported: 'Reported', committed: 'Committed', checked: 'Checks passed', reviewed: 'Review passed', published: 'Published', accepted: 'Accepted' });
// The digest a turn of the overseeing bot is given: one line per session that is not done.
export const DIGEST_ROWS = 30, DIGEST_CHARS = 3000;

const DAY = 86400000, LIVE = ['running', 'preparing'];
const time = value => { const at = Date.parse(value ?? ''); return Number.isFinite(at) ? at : 0; };
const iso = ms => new Date(ms).toISOString();
const firstLine = value => String(value ?? '').split('\n').find(line => line.trim())?.trim() ?? '';
// One line of plain text. A title, a step or a question is what a model or a command wrote,
// so it is cleaned as the screen cleans it, and a key in it is masked, before a table or
// another model reads it.
const one = value => redact(sanitize(String(value ?? ''))).replace(/\s+/g, ' ').trim();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// 9:40 PM today, Nov 14 9:40 PM on another day, in local time: as the ETA line of a Task
// reads (lib/terminal-plan.mjs clockTime), which is not read here so that a turn's relay can
// read this file without the screen's library.
export function clock(at, now = Date.now()) {
  const day = new Date(at), today = new Date(now), hours = day.getHours();
  const text = `${hours % 12 || 12}:${String(day.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
  return day.toDateString() === today.toDateString() ? text : `${MONTHS[day.getMonth()]} ${day.getDate()} ${text}`;
}
// 25 min, 2 h 5 min, 3 d 4 h.
function minutesText(minutes) {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  const hours = Math.floor((minutes % 1440) / 60);
  return `${Math.floor(minutes / 1440)} d${hours ? ` ${hours} h` : ''}`;
}
const spanText = ms => { const minutes = Math.floor(Math.max(0, ms) / 60000); return minutes < 1 ? 'under a minute' : minutesText(minutes); };
// What an approval asks for, as the Sessions list words it after "wants to".
const wants = summary => firstLine(summary).replace(/^(Run|Edit|Open|Search|Use|Save)\b/, verb => verb.toLowerCase());

// Whether the process a working session names still runs. Asking starts a process
// (lib/process.mjs), so an answer stands for a few seconds.
const owners = new Map(), OWNER_MS = 5000;
function ownerAlive(owner) {
  const key = `${owner.pid}\0${owner.born ?? owner.identity ?? ''}`, had = owners.get(key), at = Date.now();
  if (had && at - had.at < OWNER_MS) return had.value;
  let value = null; try { value = sameProcess(owner); } catch { value = null; }
  owners.delete(key); owners.set(key, { at, value });
  if (owners.size > 200) owners.delete(owners.keys().next().value);
  return value;
}

// What is worked out once per session and kept until its records change: the rows of its
// checklist, which ask git about its folder, and its agents, which read its runs. A table is
// drawn many times a second, and neither may be asked each time. The records are the four
// files a session's view is read from (lib/projects.mjs viewTasks); with no folder to look at
// (a record handed in as it is), the record itself is the mark.
const RECORDS = ['task.json', 'plan.json', 'settings.json', 'keep-going.json'], kept = new Map();
function markOf(repo, id) {
  if (typeof repo?.state !== 'string' || !/^[1-9][0-9]*$/.test(String(id))) return null;
  const dir = path.join(repo.state, 'tasks', String(id));
  const marks = RECORDS.map(name => { try { const stat = fs.lstatSync(path.join(dir, name)); return `${stat.ino}:${stat.size}:${stat.mtimeMs}`; } catch { return '-'; } });
  return marks[0] === '-' ? null : marks.join('|');
}
function keptFor(root, task, repo) {
  const key = `${root}\0${task.id}`, mark = markOf(repo, task.id), had = kept.get(key);
  if (had && (mark === null ? had.task === task : had.mark === mark)) return had;
  const made = { mark, task }; kept.delete(key); kept.set(key, made);
  if (kept.size > 600) kept.delete(kept.keys().next().value);
  return made;
}
// Forgets what was kept, so the next look reads everything again.
export function forgetOverview() { kept.clear(); owners.clear(); last = null; }

// The rows of a session's checklist that say what its records prove (lib/checklist.mjs), by a
// key: committed, checks, review, pushed, pull, and for a session with nothing to publish
// replied, no-edits or in-target. Its rows about what it waits on are the state word here.
const PROOF_ROWS = { 'Edits committed': 'committed', 'Checks passed': 'checks', 'Review passed': 'review', Pushed: 'pushed', 'Pull request': 'pull', Replied: 'replied', 'No edits': 'no-edits', 'Nothing to publish': 'in-target' };
// budget: { most, spent } in ms, for one look of the tables. The checklist asks git, and the
// look runs where the owner types (the tab is drawn) or where every session runs (a bot's
// turn), so the sessions whose proof is not kept yet are asked about only until the look spent
// most on them: null for the rest, which a later look asks about. One is always asked.
function proofRows(root, task, { repo, fresh, checklist, budget = null }) {
  const entry = keptFor(root, task, repo);
  if (!fresh && !entry.proof && budget && budget.spent >= budget.most) return null;
  if (fresh || !entry.proof) {
    const began = Date.now();
    let rows = []; try { rows = checklist() ?? []; } catch { rows = []; }
    entry.proof = rows.filter(row => PROOF_ROWS[row?.text]).map(row => ({ key: PROOF_ROWS[row.text], text: row.text, met: row.met === true, evidence: row.evidence ?? null }));
    if (budget) budget.spent += Date.now() - began;
  }
  return entry.proof;
}
// How long one look of this computer's own records (readOverview) asks git about proofs.
export const PROOF_BUDGET = 150;
// The highest step the records prove. accepted: the owner checked it himself.
function ladder(proof, reported, accepted) {
  const met = key => proof.some(row => row.key === key && row.met);
  return accepted ? 'accepted' : met('pushed') && met('pull') ? 'published' : met('review') ? 'reviewed' : met('checks') ? 'checked' : met('committed') ? 'committed' : reported ? 'reported' : 'none';
}
// A session whose agent reported every objective met while a later step says otherwise is
// named so: the review still asks for fixes, the checks failed or did not run since its last
// edit, or no bot reviewed that edit. The words read are the checklist's own (lib/checklist.mjs).
// Edits that are not committed are not named: ELU commits them when the owner publishes.
function saysDone(proof) {
  const row = key => proof.find(item => item.key === key && !item.met) ?? null, review = row('review'), checks = row('checks');
  if (review && /asks for/.test(review.evidence ?? '')) { const fixes = Number(/(\d+) fix/.exec(review.evidence)?.[1]); return fixes ? `says done, ${fixes} ${fixes === 1 ? 'fix' : 'fixes'} open` : 'says done, fixes open'; }
  if (checks && /^Failed\b/.test(checks.evidence ?? '')) return 'says done, checks failed';
  if (checks && !/^Not set\b/.test(checks.evidence ?? '')) return 'says done, checks not run';
  return review ? 'says done, not reviewed' : null;
}
// What the Proof column says of a row: what it is named, else its highest step, else nothing.
export const proofText = row => row?.says ?? PROOF_STEPS[row?.done] ?? null;

// When the Task's work is expected done, by the agent's own estimate (lib/plan.mjs taskEta):
// { at, overdue, text }, the text a clock time, or "overdue 12 min" once it has passed. null
// when nobody estimated it, when the Task is not approved yet, and when its agent reported
// every objective met.
function etaOf(plan, reported, now) {
  if (plan?.state !== 'approved' || reported) return null;
  const at = taskEta(plan); if (at === null) return null;
  const late = Math.round((now - at) / 60000);
  return { at: iso(at), overdue: late > 0, text: late > 0 ? `overdue ${minutesText(late)}` : clock(at, now) };
}
// The newest thing a session did: its latest activity row that carries a step (as the
// Sessions list reads it, lib/board.mjs).
function latestStep(project, id) {
  const rows = Array.isArray(project?.activity) ? project.activity : [];
  for (let index = rows.length - 1; index >= 0; index--) if (typeof rows[index]?.step === 'string' && String(rows[index].taskId) === String(id)) return firstLine(rows[index].step);
  return '';
}
// What a working turn is doing: its latest step, with who does it when that is not the
// session's own model.
function workingWhy(project, task) {
  // getBot is read only while a bot is at work, so the bot that oversees reads "overseeing".
  const step = latestStep(project, task.id), bot = botWork(task, { find: getBot });
  if (task.state === 'preparing') return step || 'preparing';
  if (!task.activeRole || task.activeRole === 'checks') return step ? `checks: ${step}` : 'running the checks';
  if (bot) return `${bot.agent} ${bot.label}${step ? `: ${step}` : ''}`;
  return step || sessionDetail(task);
}
const GONE = 'ELU stopped before this response finished.', CARRY_ON = 'Type continue to carry on.';
const failedChecks = task => (Array.isArray(task.evidence?.results) ? task.evidence.results : []).filter(row => row?.status === 'failed').map(row => one(row.name));
const noBoard = now => ({ cards: [], done: [], closed: {}, archived: [], checked: {}, since: now, moved: {} });

// One session's row: { kind: 'session', root, project, id, title, word, rank, why, action,
// since: { at, run? }, role, task, proof, done, says, eta, column, order, asOf }, or null for
// one the tables leave out: an archived session, a teammate's question (answered in its Chats
// thread), one the board shows nowhere (quiet for 14 days), and one in Done for over a day.
// word is one of STATUS_WORDS and rank its place there; why is one line (its latest step, the
// question it asks, why it stopped) and action the one thing to do where a stop names one;
// since is when that began (run: a turn that counts up); role is who works while it works;
// task is its Task in numbers; proof is the checklist rows that prove something, done the
// highest step they reach (a key of PROOF_STEPS, or none) and says what it is named when it
// reports done with a later step missing; eta as etaOf; column is where the board has it.
// project: its project as a snapshot gives it (root, name, queue, activity). approvals: what
// waits for the owner's allow, every session's. board: the project's board, read. repo: the
// project's folders, to see when the session's records change. proof: false leaves the
// checklist out, and git with it. fresh: reads it again whatever was kept. budget: see
// proofRows; a session whose proof waits for a later look has none yet, and done null.
// alive(owner) and checklist(task) stand in for the process look and the checklist.
// The tests run in the order the Sessions list has them (lib/board.mjs), with three changes: a
// session the owner checked is Done whatever state it was stored with, the states that ended
// are told apart by the records, and a working record whose process is gone is not working.
export function sessionStatus(project, task, { approvals = [], board = null, repo = null, now = Date.now(), proof = true, fresh = false, budget = null, alive = ownerAlive, checklist = sessionChecklist } = {}) {
  if (!isObject(task) || ['ask', 'review'].includes(task.origin?.kind)) return null;
  const on = board ?? noBoard(now), queue = Array.isArray(project?.queue) ? project.queue : [], id = String(task.id);
  // A standup's answer turn (lib/standup.mjs) leaves the session where it stood: it is not work.
  const seen = task.standupTurn && LIVE.includes(task.state) ? { ...task, state: task.standupTurn.state ?? 'answered' } : task;
  const live = LIVE.includes(seen.state), plan = isObject(seen.plan) && seen.plan.state !== 'rejected' ? seen.plan : null;
  const asked = live ? (Array.isArray(approvals) ? approvals : []).filter(approval => String(approval?.taskId) === id && (!approval.root || approval.root === project.root)) : [];
  // The owner's message to it that did not run or waits for his yes; and its next message
  // that waits to start, which says more of it than how its last turn ended.
  const [request] = heldBySession(queue).get(id) ?? [];
  const next = live ? null : queue.filter(row => ['queued', 'starting'].includes(row?.state) && String(row.continuationTaskId) === id && !row.standupFor).sort(requestOrder)[0] ?? null;
  let column = null; try { column = sessionPlace(on, seen, now); } catch { column = null; }
  if (column === null && !request && !next) return null;
  const objectives = Array.isArray(plan?.objectives) ? plan.objectives.length : 0, met = Array.isArray(plan?.met) ? plan.met.length : 0;
  const reported = Boolean(plan) && plan.state !== 'proposed' && objectives > 0 && met >= objectives;
  const last = lastActivity(seen), started = time(seen.activeSince) || time(seen.createdAt);
  const eta = etaOf(plan, reported, now);
  const refused = () => { try { return blockedRows(seen); } catch { return []; } };
  const stopped = () => { try { return stopLine(seen); } catch { return null; } };
  let word, why, action = null, since = rowSince(seen, { approval: asked[0], request }), order = time(since.at);
  if (asked.length) {
    // A permission holds a turn now and lapses: it leads, the oldest first.
    [word, why, order] = ['Needs approval', `Wants to ${wants(asked[0].summary) || 'use a tool'}`, time(asked[0].at)];
  } else if (live && namesProcess(seen.owner) && alive(seen.owner) === false) {
    [word, why, action, since, order] = ['Stopped', `${GONE} ${CARRY_ON}`, CARRY_ON, { at: iso(started) }, started];
  } else if (live) {
    // One past its agent's own estimate first, then the longest running.
    [word, why, order] = ['Working', workingWhy(project, seen), (eta?.overdue ? 0 : 1e14) + started];
  } else if (request?.state === 'waiting') {
    [word, why, order] = ['Needs approval', `A message waits for your yes: ${firstLine(requestGoal(request))}`, 1e14 + time(request.createdAt)];
  } else if (request) {
    [word, why] = ['Blocked', firstLine(request.reason) || 'A message to it did not run.'];
  } else if (next) {
    [word, why, since, order] = ['Queued', waitingText(next, now), { at: next.queuedAt ?? next.createdAt ?? iso(last) }, (next.priority ?? 1) * 1e13 + time(next.queuedAt ?? next.createdAt)];
  } else if (column === 'done') {
    // Only the owner moves a session to Done. The last day's are listed, the newest first.
    const checked = time(on.checked?.[task.id]) || time(plan?.checkedAt), at = checked || time(on.closed?.[task.id]) || last;
    if (now - at > DAY) return null;
    [word, why, since, order] = ['Done', checked ? `You checked it ${clock(checked, now)}.` : 'In Done.', { at: iso(at) }, -at];
  } else if (plan?.state === 'proposed') {
    const at = time(plan.proposedAt) || last;
    [word, why, since, order] = ['Needs approval', `Task to approve: ${plan.title}`, { at: iso(at) }, 2e14 + at];
  } else if (seen.state === 'needs_input') {
    const said = refused(), reply = seen.reply?.outcome === 'needs_input' ? seen.reply : seen.result;
    [word, why] = said.length ? ['Blocked', said[0].text] : ['Asks you', firstLine(reply?.question) || firstLine(sessionGoal(seen))];
  } else if (jobsLine(seen.jobs, now)) {
    const running = seen.jobs.filter(job => job?.state === 'running');
    [word, why, order] = ['Working', jobsLine(seen.jobs, now), 1e14 + Math.min(...running.map(job => time(job.startedAt) || now))];
  } else {
    const said = refused(), failed = failedChecks(seen), stop = stopped();
    if (said.length) [word, why] = ['Blocked', said[0].text];
    else if (seen.keepStopped) [word, why, since] = ['Blocked', seen.keepStopped.text, time(seen.keepStopped.at) ? { at: seen.keepStopped.at } : since];
    else if (seen.reviewStatus === 'blocked') [word, why, action] = ['Blocked', stop?.text ?? 'The review still asks for fixes.', stop?.action ?? null];
    else if (failed.length) [word, why] = ['Blocked', `Checks failed: ${failed.join(', ')}.`];
    // One whose message waits in the queue for a Claude account to reset comes last.
    else if (stop) [word, why, action, order] = ['Stopped', stop.text, stop.action, (seen.error?.waitsFor ? 1e14 : 0) + time(since.at)];
    // Every objective reported met first, then the oldest. A published session is still
    // stored as ready: its pull request says it is published.
    else [word, why, order] = ['Ready for your check', typeof seen.pr === 'string' && seen.pr ? 'published' : sessionDetail(seen), (reported ? 0 : 1e14) + last];
    if (word === 'Blocked') order = time(since.at);
  }
  // A session in Done is not asked about again: its checklist would ask git for nothing.
  const proved = proof && word !== 'Done' ? proofRows(project.root, task, { repo, fresh, budget, checklist: () => checklist(seen) }) : [], rows = proved ?? [];
  const accepted = word === 'Done' && (time(on.checked?.[task.id]) > 0 || time(plan?.checkedAt) > 0), done = proved === null ? null : ladder(rows, reported, accepted);
  const steps = Array.isArray(plan?.subtasks) ? plan.subtasks : [];
  return {
    kind: 'session', root: project.root, project: one(project.name), id, title: one(taskTitle(task)), word, rank: STATUS_WORDS.indexOf(word), why: one(why), action, since, role: live && word !== 'Stopped' ? seen.activeRole ?? null : null,
    task: plan ? { id: plan.id, title: one(plan.title), state: plan.state, met, objectives, stepsDone: steps.filter(row => row?.state === 'done').length, steps: steps.length, etaAt: eta?.at ?? null } : null,
    proof: rows, done, says: reported && done !== 'accepted' ? saysDone(rows) : null, eta: word === 'Done' ? null : eta, column, order, asOf: iso(now),
  };
}
// A message with no session yet, in the same shape: Queued while it waits to start, Blocked
// when it did not run, Needs approval when it waits for the owner's yes. It has no id.
export function requestStatus(project, request, now = Date.now()) {
  const state = request?.state, at = request?.queuedAt ?? request?.createdAt ?? iso(now);
  const [word, why, order] = state === 'waiting' ? ['Needs approval', 'It waits for your yes.', 1e14 + time(request.createdAt)]
    : state === 'blocked' ? ['Blocked', firstLine(request.reason) || 'It did not run.', time(request.createdAt)]
      : ['Queued', waitingText(request, now), (request?.priority ?? 1) * 1e13 + time(at)];
  return { kind: 'request', root: project.root, project: one(project.name), id: null, request: request?.id ?? null, title: one(requestTitle(request)), word, rank: STATUS_WORDS.indexOf(word), why: one(why), action: null,
    since: { at: state === 'queued' || state === 'starting' ? at : request?.createdAt ?? at }, role: null, task: null, proof: [], done: 'none', says: null, eta: null, column: null, order, asOf: iso(now) };
}
const from = (map, root) => map instanceof Map ? map.get(root) ?? null : isObject(map) ? map[root] ?? null : null;
const byNeed = (a, b) => a.rank - b.rank || a.order - b.order || String(a.root).localeCompare(String(b.root)) || Number(a.id ?? 0) - Number(b.id ?? 0);
// Every row, what needs the owner first: by the word, then inside it as sessionStatus orders
// them. projects: what a snapshot gives (lib/projects.mjs). boards and repos: each project's
// board and folders by its root, a Map or an object. except: { root, id } of a session to
// leave out, such as the chat of the bot that asks. The other options are sessionStatus's.
// A session whose records cannot be read has no row: the rest are still shown.
export function statusRows(projects, { approvals = [], boards = null, repos = null, now = Date.now(), except = null, ...rest } = {}) {
  const rows = [];
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!isObject(project) || project.unavailable) continue;
    const tasks = (Array.isArray(project.tasks) ? project.tasks : []).filter(task => !(except && except.root === project.root && String(except.id) === String(task?.id)));
    for (const task of tasks) {
      let row = null; try { row = sessionStatus(project, task, { ...rest, approvals, board: from(boards, project.root), repo: from(repos, project.root), now }); } catch { row = null; }
      if (row) rows.push(row);
    }
    // A message to a session is on that session's row. One that starts a session has its own.
    const known = new Set((Array.isArray(project.tasks) ? project.tasks : []).map(task => String(task?.id)));
    for (const request of Array.isArray(project.queue) ? project.queue : []) {
      if (!['queued', 'starting', 'blocked', 'waiting'].includes(request?.state) || request.standupFor || ['ask', 'review'].includes(request.origin?.kind)) continue;
      if (known.has(String(request.continuationTaskId ?? '')) || known.has(String(request.taskId ?? ''))) continue;
      rows.push(requestStatus(project, request, now));
    }
  }
  return rows.sort(byNeed);
}

const COUNTS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const sum = tokens => tokens ? COUNTS.reduce((total, key) => total + tokens[key], 0) : 0;
const plus = (a, b) => !a ? b : !b ? a : Object.fromEntries(COUNTS.map(key => [key, a[key] + b[key]]));
const less = (a, b) => Object.fromEntries(COUNTS.map(key => [key, a[key] - b[key]]));
const whole = tokens => COUNTS.every(key => tokens[key] >= 0);
const same = (a, b) => COUNTS.every(key => a[key] === b[key]);
// The models of a Claude Code result less those of an earlier one of its session, or null
// when they are not the same session's totals carried on (as lib/agent-spend.mjs counts it).
function grown(now, before) {
  const out = {};
  for (const [id, row] of Object.entries(now)) {
    const was = before[id], tokens = was ? less(row.tokens, was.tokens) : row.tokens, costUsd = row.costUsd - (was?.costUsd ?? 0);
    if (!whole(tokens) || costUsd < -1e-9) return null;
    out[id] = { tokens, costUsd: Math.max(0, costUsd) };
  }
  return Object.keys(before).every(id => now[id]) ? out : null;
}
// What one Claude Code run used itself, by model, and what its own loop used: Claude Code's
// result counts every model it called (modelUsage, its helpers' among them) and, apart, the
// tokens of the agent's own loop (usage). A turn that went on with a session reports that
// session's totals so far, so its own share is those less its session's turn before, as
// lib/agent-spend.mjs takes a run's own spend. null when its log says neither, or is gone.
function ownShare(runs, index, logOf) {
  const run = runs[index], log = logOf(index), result = log?.result;
  if (!result?.models || !result.usage) return null;
  const session = result.session ?? run.session ?? null; let base = null;
  for (let at = index - 1; at >= 0 && session && !base; at--) {
    const before = runs[at]; if (!isObject(before) || before.vendor !== 'claude') continue;
    const earlier = logOf(at);
    if (earlier?.result && (earlier.result.session ?? before.session) === session) base = earlier.result;
  }
  const more = base?.models ? grown(result.models, base.models) : null, exact = rows => Object.values(rows).some(row => same(row.tokens, result.usage));
  const carried = more && exact(more) ? true : exact(result.models) ? false : Boolean(more);
  return { models: carried ? more : result.models, loop: result.usage, model: log.model ?? run.model ?? null };
}
// The line of a run's own model among the models it used, or null when none is it.
const lineOf = (models, model) => Object.keys(models).find(id => id === model) ?? Object.keys(models).find(id => Boolean(claudeId(id)) && claudeId(id) === claudeId(model ?? '')) ?? null;
// Whether a name a bot's helpers were given (opus, claude-opus-5-5) is the model of a line.
function namesModel(name, id) {
  const want = String(name ?? '').trim().toLowerCase().replace(/\[.*\]$/, ''), have = claudeId(id) ?? String(id).trim().toLowerCase();
  return Boolean(want) && (want === have || claudeId(want) === have || /^[a-z]+$/.test(want) && new RegExp(`(^|-)${want}(-|$)`).test(have));
}
// The model a bot's helpers ran on in a run: what the bot, as it is saved now, starts them on
// with the permissions the run had (lib/bots.mjs botHelpers). null: it starts none, or it is
// no longer saved.
function savedHelpers(name, run) { try { const bot = getBot(name); return bot ? botHelpers(bot, ranIn(run)) : null; } catch { return null; } }

// The agents of one session, in the order each first ran: its own model, each bot, and after
// a bot its helpers, as one row per model they ran on. A row: { key, kind: 'model' | 'bot' |
// 'helpers', parent, agent, model, vendor, tokens, costUsd, partial, atMost, within, runs,
// working, at }. tokens is { input, output, cacheRead, cacheWrite } or null; costUsd is the
// vendor's figure where it gives one, and partial says it is at least that (lib/agent-spend.mjs).
// Helpers on another model than their bot's are exact: that model's line of the run, taken
// out of the bot's own row. Helpers on the bot's own model are what that model's line holds
// over the bot's own loop: at most that (atMost), since a compaction is in it too, and their
// cost is not reported apart, so it stays in the bot's row (within: the bot's name), as do
// those tokens: such a row is a part of its bot's, never added to it. One helper alone has no
// row: Claude Code does not report it whole.
// read(file, vendor): logSpend, or a stand-in. helpersOf(name, run): the model that bot's
// helpers ran on, 'inherit' for its own, or null.
export function sessionAgents(task, { read = logSpend, helpersOf = savedHelpers } = {}) {
  const runs = Array.isArray(task?.runs) ? task.runs : [], logs = new Map(), rows = new Map(), parts = new Map();
  const logOf = index => { if (!logs.has(index)) { let value = null; try { value = isObject(runs[index]) ? read(runs[index].logFile, runs[index].vendor) : null; } catch { value = null; } logs.set(index, value); } return logs.get(index); };
  let spends; try { spends = runSpends(task, read); } catch { spends = runs.map(() => null); }
  const rowOf = role => { if (!rows.has(role)) rows.set(role, { role, kind: botOfKey(role) || role === 'lead' && task?.botChat ? 'bot' : 'model', models: [], tokens: null, costUsd: null, partial: false, runs: 0, at: 0, working: false }); return rows.get(role); };
  const roleOf = run => typeof run.role === 'string' && run.role ? run.role : 'lead';
  const count = (row, spend, tokens, cost, at) => {
    row.runs++; row.tokens = plus(row.tokens, tokens); row.at = Math.max(row.at, at);
    if (cost !== null) row.costUsd = (row.costUsd ?? 0) + cost;
    // A cost that is not known, or may be more, makes the row at least what it shows.
    if (spend.costUsd === null || spend.atLeast) row.partial = true;
    if (spend.vendor && !row.models.some(item => item.vendor === spend.vendor && item.model === spend.model)) row.models.push({ vendor: spend.vendor, model: spend.model });
  };
  const helper = (role, model, at, add) => {
    const key = `${role}#helpers:${claudeId(model) ?? model}`, part = parts.get(key) ?? { key, role, model, tokens: null, costUsd: null, atMost: false, own: false, runs: 0, at: 0 };
    part.runs++; part.tokens = plus(part.tokens, add.tokens); part.at = Math.max(part.at, at);
    if (add.own) part.atMost = part.own = true; else part.costUsd = (part.costUsd ?? 0) + add.costUsd;
    parts.set(key, part);
  };
  runs.forEach((run, index) => {
    const spend = spends[index]; if (!isObject(run) || !spend) return;
    const role = roleOf(run), bot = botOfKey(role), at = time(run.at);
    let tokens = spend.tokens, cost = leastCost(spend, run);
    // Only a working bot on Claude Code starts helpers (lib/runner.mjs).
    const share = bot && spend.vendor === 'claude' && spend.started !== false && tokens ? ownShare(runs, index, logOf) : null;
    const wanted = share ? helpersOf(bot, run) : null, mine = share ? lineOf(share.models, share.model) : null;
    // A result with nothing for the agent's own loop (some error results) tells nothing apart.
    if (wanted && mine && sum(share.loop) > 0) {
      if (wanted === OWN_MODEL || namesModel(wanted, mine)) {
        const over = less(share.models[mine].tokens, share.loop);
        if (whole(over) && sum(over) > 0) helper(role, mine, at, { tokens: over, own: true });
      } else for (const [id, line] of Object.entries(share.models)) {
        if (id === mine || !namesModel(wanted, id) || sum(line.tokens) <= 0) continue;
        const left = less(tokens, line.tokens);
        if (!whole(left) || cost === null || cost + 1e-9 < line.costUsd) continue;
        tokens = left; cost = Math.max(0, cost - line.costUsd);
        helper(role, id, at, { tokens: line.tokens, costUsd: line.costUsd });
      }
    }
    count(rowOf(role), spend, tokens, cost, at);
  });
  // A turn stopped while its vendor worked is no run: it counts with no cost reported, until
  // a later run of its session reported what it spent (lib/agent-spend.mjs).
  for (const stop of Array.isArray(task?.stops) ? task.stops : []) {
    if (!isObject(stop) || stop.counted === true || stop.started === false) continue;
    const at = time(stop.at), spend = pricedSpend({ vendor: typeof stop.vendor === 'string' ? stop.vendor : null, model: typeof stop.model === 'string' && stop.model ? stop.model : stop.asked ?? null, costUsd: null, tokens: cleanTokens(stop.tokens), started: true }, at || Date.now());
    count(rowOf(roleOf(stop)), spend, spend.tokens, null, at);
  }
  // The turn in progress has no run yet: its agent is listed, working, with what it had spent before.
  if (LIVE.includes(task?.state) && !task.standupTurn && typeof task.activeRole === 'string' && task.activeRole && task.activeRole !== 'checks') rowOf(task.activeRole).working = true;
  const out = [];
  for (const row of rows.values()) {
    // A vendor's own default is left out when the same vendor also named a model.
    const shown = row.models.filter(item => item.model || !row.models.some(other => other.vendor === item.vendor && other.model));
    const model = shown.map(item => shortModel(item.model, item.vendor)).filter((name, at, all) => name && all.indexOf(name) === at).join(' + '), agent = agentName(row.role, task, shown);
    out.push({ key: row.role, kind: row.kind, parent: null, agent, model, vendor: shown.at(-1)?.vendor ?? null, tokens: row.tokens, costUsd: row.costUsd, partial: row.partial && row.costUsd !== null, atMost: false, within: null, runs: row.runs, working: row.working, at: row.at ? iso(row.at) : null });
    for (const part of parts.values()) if (part.role === row.role) out.push({ key: part.key, kind: 'helpers', parent: row.role, agent: `${agent} helpers`, model: shortModel(part.model, 'claude'), vendor: 'claude', tokens: part.tokens, costUsd: part.own ? null : part.costUsd, partial: false, atMost: part.atMost, within: part.own ? agent : null, runs: part.runs, working: false, at: part.at ? iso(part.at) : null });
  }
  return out;
}
function agentsOf(root, task, { repo = null, fresh = false, read, helpersOf } = {}) {
  const entry = keptFor(root, task, repo);
  if (fresh || !entry.agents) entry.agents = sessionAgents(task, { ...(read ? { read } : {}), ...(helpersOf ? { helpersOf } : {}) });
  return entry.agents;
}
// The agents of the sessions the status rows list, in their order, each row with its
// session's root, project, id and title before what sessionAgents gives. Kept per session
// until its records change, as its proof is; a stand-in reader is asked once per record too.
export function agentRows(projects, status, { repos = null, fresh = false, read, helpersOf } = {}) {
  const found = new Map();
  for (const project of Array.isArray(projects) ? projects : []) for (const task of Array.isArray(project?.tasks) ? project.tasks : []) found.set(`${project.root}\0${task?.id}`, task);
  return (status ?? []).filter(row => row.kind === 'session').flatMap(row => {
    const task = found.get(`${row.root}\0${row.id}`); if (!task) return [];
    let agents = []; try { agents = agentsOf(row.root, task, { repo: from(repos, row.root), fresh, read, helpersOf }); } catch { agents = []; }
    return agents.map(agent => ({ root: row.root, project: row.project, id: row.id, title: row.title, ...agent }));
  });
}
// Both tables' rows from records handed in: { now, status, agents }. The options are
// statusRows's and agentRows's, and proofMs: how long this look asks git about proofs not kept
// yet (proofRows), with no end when it is not given.
export function overview(projects, { now = Date.now(), repos = null, fresh = false, read, helpersOf, proofMs = null, ...rest } = {}) {
  const status = statusRows(projects, { ...rest, repos, fresh, now, budget: Number.isFinite(proofMs) ? { most: proofMs, spent: 0 } : null });
  return { now, status, agents: agentRows(projects, status, { repos, fresh, read, helpersOf }) };
}
// The same, read from this computer's own records: its projects, their boards, and the
// approvals that wait. within: a look made less than that many ms ago is given again, so a
// tab drawn many times a second reads the records about once a second. except: see statusRows.
// It asks git about proofs for PROOF_BUDGET ms at most (overview's proofMs); checklist stands in
// for the checklist.
let last = null;
function local() {
  const projects = [], repos = new Map(), boards = new Map();
  let listed = []; try { listed = registeredProjects(); } catch { listed = []; }
  for (const repo of listed) {
    // A project that cannot be read is left out, as the Sessions list shows it with no sessions.
    try { projects.push(projectSnapshot(repo)); repos.set(repo.root, repo); } catch { continue; }
    try { boards.set(repo.root, readBoard(repo)); } catch { /* An unreadable board closes nothing. */ }
  }
  return { projects, repos, boards };
}
export function readOverview({ now = Date.now(), except = null, within = 0, fresh = false, proof = true, checklist } = {}) {
  const key = `${except ? `${except.root}\0${except.id}` : ''}\0${proof}`;
  if (!fresh && last && last.key === key && Math.abs(Date.now() - last.read) < within) return last.value;
  const { projects, repos, boards } = local();
  let approvals = []; try { approvals = pendingApprovals(); } catch { approvals = []; }
  const value = overview(projects, { approvals, boards, repos, now, except, fresh, proof, proofMs: PROOF_BUDGET, ...(checklist ? { checklist } : {}) });
  last = { key, read: Date.now(), value };
  return value;
}
// One session of this computer, for a tool that reads it: { status, agents }, or null when
// there is no such session here. status is its row, read now and not from what was kept, or
// null for one the tables leave out (sessionStatus); agents are its agents' rows either way.
export function readSession(root, id, { now = Date.now(), fresh = true } = {}) {
  let repo = null; try { repo = registeredProjects().find(row => row.root === root) ?? null; } catch { repo = null; }
  if (!repo) return null;
  let project; try { project = projectSnapshot(repo); } catch { return null; }
  const task = (project.tasks ?? []).find(row => String(row.id) === String(id));
  if (!task) return null;
  let board = null; try { board = readBoard(repo); } catch { board = null; }
  let approvals = []; try { approvals = pendingApprovals({ root }); } catch { approvals = []; }
  // As in the tables: a record that cannot be read gives no row, and no error.
  let status = null; try { status = sessionStatus(project, task, { approvals, board, repo, now, fresh }); } catch { status = null; }
  let agents = []; try { agents = agentsOf(root, task, { repo, fresh }); } catch { agents = []; }
  return { status, agents: agents.map(agent => ({ root, project: one(project.name), id: String(task.id), title: one(taskTitle(task)), ...agent })) };
}

// A table's text cells, cut so that its columns fit the tab. The renderer gives each column
// the width of its widest cell and leaves the last columns out when they do not fit
// (lib/terminal-artifacts.mjs), so one long title or step would push the state off the
// screen. flex: { column: [least, most, share] }, the columns that give up room: each is cut
// to its most, then the one widest for its share gives a column at a time, down to its least.
function fitted(heads, rows, width, flex) {
  const wide = heads.map((head, at) => Math.max(columns(head), ...rows.map(row => columns(row[at] ?? '–')))), give = Object.keys(flex).map(Number);
  for (const at of give) wide[at] = Math.min(wide[at], Math.max(flex[at][1], columns(heads[at])));
  let over = wide.reduce((total, value) => total + value, 0) + (heads.length - 1) * 2 - width;
  while (over > 0) {
    const at = give.filter(index => wide[index] > Math.max(flex[index][0], columns(heads[index]))).sort((a, b) => wide[b] / flex[b][2] - wide[a] / flex[a][2])[0];
    if (at === undefined) break;
    wide[at]--; over--;
  }
  return rows.map(row => row.map((cell, at) => cell !== null && flex[at] ? cut(cell, wide[at]) : cell));
}
// The Sessions table as an artifact's table block: Project, Session, State, Doing, Since,
// the agent's own ETA, Proof. Since is when the state began, as a clock time; the ETA is the
// Task's estimate as one, named as the agent's in its heading, or "overdue 12 min".
// width: the columns of the tab it is drawn in.
export function sessionsTable(status, { now = Date.now(), width = 110 } = {}) {
  const heads = ['Project', 'Session', 'State', 'Doing', 'Since', "Agent's ETA", 'Proof'];
  const rows = (status ?? []).map(row => [row.project || null, row.title || null, row.word, row.why || null, time(row.since?.at) ? clock(time(row.since.at), now) : null, row.eta?.text ?? null, proofText(row)]);
  return { kind: 'table', columns: heads.map(label => ({ label })), rows: fitted(heads, rows, width, { 0: [6, 20, 1], 1: [12, 40, 2], 3: [16, 90, 4] }) };
}
// The Agents table: Session, Agent, Model, In, Out, Cache, Cost. The counts are sent as short
// text (412k, 1.2M), since the renderer writes a number out in full; Cache is what was read
// from the cache, as the Usage tab counts it (lib/agent-spend.mjs). ≤ before a count: at most that. ≥ before a cost: at
// least that. "in @name": that cost is not reported apart, it is in that bot's own row.
export function agentsTable(agents, { width = 110 } = {}) {
  const heads = ['Session', 'Agent', 'Model', 'In', 'Out', 'Cache', 'Cost'];
  const short = (row, value) => row.tokens ? `${row.atMost ? '≤' : ''}${compact(value)}` : null;
  const rows = (agents ?? []).map(row => [row.title || null, row.agent || null, modelLabel(row.model) || null, short(row, row.tokens?.input), short(row, row.tokens?.output), short(row, row.tokens?.cacheRead),
    row.within ? `in ${row.within}` : moneyText(row.costUsd, row.partial)]);
  return { kind: 'table', columns: heads.map(label => ({ label })), rows: fitted(heads, rows, width, { 0: [10, 36, 2], 1: [8, 28, 1], 2: [8, 28, 1] }) };
}
// The two tables as the artifacts a session's Artifacts tab draws (artifactsView in
// lib/terminal-artifacts.mjs takes them as it takes a Task's own): each one table, filled now.
// They belong to no Task and are in no store: whoever draws them asks again each time.
// view: what overview or readOverview gave. width: the columns of the tab.
export function overviewArtifacts(view, { width = 110 } = {}) {
  const at = iso(view.now), item = (title, shows, block) => ({ title, shows, every: null, key: title.toLowerCase(), updates: [{ at, data: { blocks: [block] } }], script: null, scriptAt: null, run: null });
  return [
    item('Sessions', 'Every session on this computer, what needs you first.', sessionsTable(view.status, { now: view.now, width })),
    item('Agents', 'The agents of each session, with their tokens and what they cost.', agentsTable(view.agents, { width })),
  ];
}

// What each listed session's agents spent together: { agents, tokens, costUsd, partial } by
// root and id. A helpers row that is a part of its bot's row is not added again.
function spentBySession(agents) {
  const all = new Map();
  for (const row of agents ?? []) {
    const key = `${row.root}\0${row.id}`, had = all.get(key) ?? { agents: 0, tokens: 0, costUsd: null, partial: false };
    had.agents++;
    if (!row.within) { had.tokens += sum(row.tokens); if (row.costUsd !== null) had.costUsd = (had.costUsd ?? 0) + row.costUsd; if (row.partial || row.costUsd === null && row.runs > 0) had.partial = true; }
    all.set(key, had);
  }
  return all;
}
// The state of the sessions in a few lines, for a model's prompt: one line per session that
// is not Done, what needs the owner first, at most DIGEST_ROWS of them and DIGEST_CHARS
// characters, counted as JSON so a quote in a title cannot push it over. A line holds less
// the more of them there are: first what the agents spent goes, then the steps and the
// titles are cut shorter, and only then are the last sessions left out, which the last line
// says. { asOf, lines, text, rows, left, total }: rows are the status rows the lines are of,
// left how many sessions have no line, total how many are not Done.
// view: what overview or readOverview gave.
const DETAIL = [{ title: 60, doing: 120, spent: true, span: true }, { title: 40, doing: 70, span: true }, { title: 30, doing: 40 }, { title: 24, doing: 24 }];
export function stateDigest(view, { rows: most = DIGEST_ROWS, chars = DIGEST_CHARS } = {}) {
  const now = view.now, open = (view.status ?? []).filter(row => row.word !== 'Done'), spent = spentBySession(view.agents);
  const line = (row, level) => {
    const used = level.spent ? spent.get(`${row.root}\0${row.id}`) : null, at = time(row.since?.at);
    return [
      `${row.word}: ${[row.project, row.id ? `#${row.id}` : '(not started)'].filter(Boolean).join(' ')} ${cut(row.title, level.title)}`.trim(),
      cut(row.why, level.doing),
      at ? `since ${clock(at, now)}${level.span ? ` (${spanText(now - at)})` : ''}` : '',
      row.eta ? `ETA ${row.eta.text} (agent's estimate)` : '',
      proofText(row) ? `proof: ${proofText(row)}` : '',
      used && (used.tokens || used.costUsd !== null) ? `${used.agents} ${used.agents === 1 ? 'agent' : 'agents'}, ${compact(used.tokens)} tokens, ${moneyText(used.costUsd, used.partial && used.costUsd !== null)}` : '',
    ].filter(Boolean).join(' · ');
  };
  const fits = lines => JSON.stringify(lines).length <= chars;
  let shown = open.slice(0, Math.max(0, most)), lines = [];
  const made = level => { const left = open.length - shown.length; return [...shown.map(row => line(row, level)), ...(left ? [`${left} more ${left === 1 ? 'session is' : 'sessions are'} not shown.`] : [])]; };
  for (const level of DETAIL) { lines = made(level); if (fits(lines)) break; }
  while (!fits(lines) && shown.length) { shown = shown.slice(0, -1); lines = made(DETAIL.at(-1)); }
  if (!fits(lines)) lines = [];
  return { asOf: iso(now), lines, text: lines.join('\n'), rows: shown, left: open.length - shown.length, total: open.length };
}
