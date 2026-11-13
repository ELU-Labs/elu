import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, diff, head, baseFile, prepareGit, currentBranch, located, findRepository, publishable, taskChanges, notesSpec } from './git.mjs';
import { tasks, readTask, taskDir, lock, saveTask, nameFile, settingsFile, teammateText } from './state.mjs';
import { atomic, HOME_TARGET, homeOrAbove, homeRefusal, homeWork, noSymlinks, readJson, refuse, hash, within } from './util.mjs';
import { parseConfig, validateConfig, defaultConfig } from './config.mjs';
import { stringifyYaml } from './yaml.mjs';
import { detect } from './detect.mjs';
import { initPlan, applyInit, inferChecks } from './init.mjs';
import { beginApproved, runPlan, runTask, continueReady, continueTask, reviewRequest, createConversation, runConversation, runBot, runShadows, runStandup, isPeerRun, allowHome, setPermissions as savePermissions, addFolder as saveFolder, setBots as saveBots, setBudget as saveBudget } from './runner.mjs';
import { preparePublish, publish, redact } from './publish.mjs';
import { shellFile, shellRows, shellText, shellForModel } from './shell.mjs';
import { ADAPTERS } from './adapters/index.mjs';
import { personalDirectory, usageSnapshot, refreshCodexUsage } from './usage.mjs';
import { pinnedConfig, runChecks, evidenceCurrent } from './checks.mjs';
import { runCosts } from './agent-spend.mjs';
import { approveSaved, ensureTrustStore, trustedText } from './project-trust.mjs';
import { claudeServers, checkServerName } from './mcp.mjs';
import { readBoard, sessionClosed } from './kanban.mjs';
import { projectFolder, pendingRequests, saveRequest, removeRequest, historyPlan, createHistory, supersededRequests } from './workspace.mjs';
import { botKey, botOfKey, botWorks, needBot, plainQuestion, reviewingBots, sharedBot } from './bots.mjs';
import { buildChanges, LIMITS } from './diff.mjs';
import { agreedTask, approveTask, currentTask, openTask, planFile, saysYes, sessionTasks, taskToStart, waitingTask } from './plan.mjs';
import { configModel, defaultModel, modelName, ownsPolicy, setDefaultModel, setSessionModel, vendorShort, withModel } from './models.mjs';
import { fromTeammate } from './modes.mjs';

export { personalDirectory } from './usage.mjs';
export function registerProject(repo) {
  // What the owner approved is recorded before the list grows, so a project added now is
  // never taken for one he already had.
  ensureTrustStore();
  const dir = personalDirectory();
  const release = lock({ state: dir }, 'projects');
  try {
    const file = path.join(dir, 'projects.json'); noSymlinks(file);
    const rows = fs.existsSync(file) ? readJson(file) : [];
    if (!Array.isArray(rows) || rows.some(row => typeof row?.root !== 'string')) refuse('The project registry is invalid.');
    atomic(file, [...rows.filter(row => row.root !== repo.root && !(repo.common && row.common === repo.common)), { root: repo.root, common: repo.common }]);
  } finally { release(); }
}
// Archives a project: it leaves the registry (and the Projects tab). Its folder and the
// sessions saved in it stay as they are, and opening the folder again brings both back.
export function archiveProject(root) {
  const dir = personalDirectory();
  const release = lock({ state: dir }, 'projects');
  try {
    const file = path.join(dir, 'projects.json'); noSymlinks(file);
    const rows = fs.existsSync(file) ? readJson(file) : [];
    if (!Array.isArray(rows) || rows.some(row => typeof row?.root !== 'string')) refuse('The project registry is invalid.');
    if (!rows.some(row => row.root === root)) return false;
    atomic(file, rows.filter(row => row.root !== root)); folders.delete(root); return true;
  } finally { release(); }
}
export function claimView(repo) {
  const releases = []; let common;
  const attach = value => { if (value.common && value.common !== common) { releases.push(lock(value, 'view')); common = value.common; } };
  const release = () => { for (const close of releases.splice(0).reverse()) close(); };
  try { releases.push(lock({ state: personalDirectory() }, `view-${hash(repo.root)}`)); attach(repo); return { readOnly: false, release, attach }; }
  catch (error) {
    release();
    if (!error.message.includes('holds this lock')) throw error;
    return { readOnly: true, release() {} };
  }
}
function readTail(file, limit = 64000) {
  noSymlinks(file); if (!fs.existsSync(file)) return '';
  const fd = fs.openSync(file, 'r');
  try { const size = fs.fstatSync(fd).size; const bytes = Buffer.alloc(Math.min(size, limit)); fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - limit)); return bytes.toString('utf8'); }
  finally { fs.closeSync(fd); }
}
// Views redraw several times a second. Each file is parsed again only after it changes;
// values are frozen because every redraw shares them.
const parsed = new Map();
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value)) freeze(item); } return value; }
// Callers check the folders above the file; the file itself is checked here.
function signature(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (stat.isSymbolicLink()) refuse(`Refusing a symbolic link: ${file}`);
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}
// A redraw checks the state folder once, then only the parts below it.
function stateDir(repo, id) {
  if (!/^[1-9][0-9]*$/.test(String(id))) refuse('Task ID must be a positive integer.');
  let current = repo.state;
  for (const part of ['tasks', String(id)]) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) refuse(`Refusing a symbolic link: ${current}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return current;
}
// beside is one more file, or several, the value is read from too: a change to any reads it again.
function memo(file, key, read, beside = null) {
  const also = other => { try { return signature(other); } catch { return 'refused'; } };
  const first = signature(file), sig = first === null || !beside ? first : [first, ...[beside].flat().map(also)].join('|'), id = `${key}\0${file}`;
  if (sig === null) { parsed.delete(id); return undefined; }
  const hit = parsed.get(id);
  if (hit?.sig === sig) return hit.value;
  const value = freeze(read()); parsed.delete(id); parsed.set(id, { sig, value });
  if (parsed.size > 4000) parsed.delete(parsed.keys().next().value);
  return value;
}
// A bot runs as bot:<name>; the activity names it the way the owner writes to it, and the
// session's own run as the model.
const shown = role => botOfKey(role) ? `@${botOfKey(role)}` : role === 'lead' ? 'model' : role;
function eventRows(file) {
  return memo(file, 'events', () => readTail(file).split('\n').flatMap(line => {
    try {
      const row = JSON.parse(line);
      // A row says who did what, never which session by number: taskId carries that, and step
      // is what the session's row in the list shows while it runs.
      const check = row.type === 'check-started' ? `running ${row.name}` : row.type === 'check-finished' ? `${row.name} ${row.status}` : null;
      const what = `${typeof row.note === 'string' ? row.note : row.type.replace(/^role-/, '').replace(/^task-/, 'session ').replaceAll('-', ' ')}${row.state ? ` (${row.state})` : ''}`;
      const text = check !== null ? `checks: ${check}` : row.role ? `${shown(row.role)}: ${what}` : what;
      return [{ at: row.at, text: redact(text), taskId: row.taskId ?? null, ...(check !== null ? { step: redact(check) } : {}) }];
    } catch { return []; /* Partial append. */ }
  })) ?? [];
}
// vendor: the run's vendor; its adapter reads a log line when it exports logRow,
// else the Claude and Codex shapes below are tried.
function logRows(file, role, at, id, vendor = null) {
  return memo(file, `log\0${role}\0${at ?? ''}\0${id}\0${vendor ?? ''}`, () => {
    const rows = []; const time = at ?? fs.statSync(file).mtime.toISOString(), prefix = `${shown(role)}: `;
    const add = text => rows.push({ at: time, text: redact(prefix + text), taskId: id, step: redact(text) });
    const logRow = ADAPTERS[vendor]?.logRow;
    for (const line of readTail(file).split('\n')) {
      try {
        const row = JSON.parse(line);
        if (typeof logRow === 'function') { const read = logRow(row); if (read?.text) add(String(read.text)); continue; }
        for (const item of row.message?.content ?? []) {
          if (item.type === 'text') add(item.text);
          if (item.type === 'tool_use') add(`${item.name} ${item.input?.file_path ?? item.input?.command ?? ''}`);
        }
        if (row.type === 'result') add(row.structured_output?.summary ?? row.result ?? '');
        if (row.type === 'item.completed' && row.item?.text) { let text = row.item.text; try { text = JSON.parse(text).summary ?? text; } catch {} add(text); }
      } catch { /* An unfinished line is not an event. */ }
    }
    return rows;
  }) ?? [];
}
export function activity(repo, values = tasks(repo), limit = 100) {
  // The newest rows in time order. Every row of one log shares its run time, so whole logs
  // are ordered as blocks instead of sorting each row on every redraw.
  const blocks = [], time = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
  noSymlinks(repo.state);
  for (const row of eventRows(path.join(repo.state, 'events.jsonl')).slice(-limit)) blocks.push([time(row.at), blocks.length, [row]]);
  for (const task of values) {
    const files = [...task.runs.map(run => run.logFile), task.activeLog].filter(Boolean), dir = stateDir(repo, task.id);
    for (const file of new Set(files)) {
      if (path.dirname(file) !== dir) continue;
      const run = task.runs.find(run => run.logFile === file);
      const rows = logRows(file, run?.role ?? task.activeRole ?? 'lead', run?.at ?? task.activeSince, task.id, run?.vendor ?? null);
      if (rows.length) blocks.push([time(rows[0].at), blocks.length, rows]);
    }
  }
  blocks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const newest = []; let count = 0;
  for (let index = blocks.length - 1; index >= 0 && count < limit; index--) { const rows = blocks[index][2].slice(-(limit - count)); newest.push(rows); count += rows.length; }
  return newest.reverse().flat();
}
function viewTasks(repo) {
  const folder = path.join(repo.state, 'tasks'); noSymlinks(folder);
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder).filter(id => /^[1-9][0-9]*$/.test(id)).map(id => memo(path.join(stateDir(repo, id), 'task.json'), 'task', () => withPlan(repo, readTask(repo, id)), [nameFile(repo, id), settingsFile(repo, id), planFile(repo, id)]))
    .filter(Boolean).sort((a, b) => Number(a.id) - Number(b.id));
}
// A session in a snapshot carries its current Task (lib/plan.mjs) as plan, when it has one.
function withPlan(repo, task) {
  const plan = currentTask(repo, task.id);
  return plan ? { ...task, plan } : task;
}
// The project's own settings, when the owner approved them on this machine; null when it
// has none or they are not approved. Parsed once for each text.
const approvedConfigs = new Map();
function approvedConfig(root) {
  const text = trustedText(root, 'config.yaml');
  if (text == null) { approvedConfigs.delete(root); return null; }
  const hit = approvedConfigs.get(root); if (hit?.text === text) return hit.config;
  const config = freeze(parseConfig(text)); approvedConfigs.set(root, { text, config }); return config;
}
// The settings a new session starts from: the project's own as the owner approved them
// (the file as it stands, or the version he approved last while it differs), else the ones
// a project with no settings file gets. The checks found in the folder run after an edit,
// inside the check sandbox. They are never handed to the lead as shell commands: only a
// settings file the owner wrote, or approved, names those.
function startConfig(root) {
  const text = trustedText(root, 'config.yaml'); if (text != null) return parseConfig(text);
  const config = defaultConfig(); config.checks = inferChecks(root);
  return config;
}
export function projectSnapshot(repo) {
  const config = approvedConfig(repo.root);
  const values = viewTasks(repo);
  const initialized = Boolean(config && repo.state && fs.existsSync(path.join(repo.state, 'manifest.json')));
  // A message a newer one to the same session made pointless is not shown; superseded names
  // them, so the app takes them out of the queue.
  const all = pendingRequests(repo.root), superseded = supersededRequests(all, values), saved = all.filter(row => !superseded.includes(row.id));
  // Closed sessions leave Sessions. The board keeps the ones moved to Done there, and shows no archived one.
  let closed = []; try { const board = readBoard(repo); closed = values.filter(task => sessionClosed(board, task)).map(task => task.id); } catch { /* An unreadable board closes nothing. */ }
  return { name: savedProjectName(repo.root) ?? path.basename(repo.root), branch: repo.common ? currentBranch(repo.root) : 'new project', root: repo.root, initialized, roles: config?.roles ?? defaultConfig().roles, tasks: values, closed, superseded,
    requests: saved.filter(row => !QUEUE_ONLY.includes(row.state) && !values.some(task => task.id === row.taskId && task.goal === row.goal || task.id === row.continuationTaskId && task.state === 'running')),
    queue: saved.filter(row => row.state !== 'done'), activity: activity(repo, values), usage: usageSnapshot() };
}
// Requests the conductor is handling or has finished; History lists only saved ones.
const QUEUE_ONLY = ['queued', 'starting', 'running', 'done'];
// The registry already records each Git root and common directory. While both still exist,
// reuse them instead of asking Git on every redraw. Anything else is resolved again.
const folders = new Map();
function registeredProject(entry) {
  if (entry.common && typeof entry.common === 'string' && fs.existsSync(path.join(entry.root, '.git')) && fs.existsSync(entry.common)) return located(entry.root, entry.common);
  const cached = folders.get(entry.root);
  if (cached && fs.existsSync(cached.root) && !fs.existsSync(path.join(cached.root, '.git'))) return cached;
  const repo = projectFolder(entry.root); if (entry.common && repo.common !== entry.common) refuse('Repository location changed.');
  if (!repo.common) folders.set(entry.root, repo); else folders.delete(entry.root);
  return repo;
}
// A project's name and marker live in its folder, next to its settings.
const projectFile = root => path.join(root, '.elu-code', 'project.json');
// One rule for a name the owner types and a name a copied folder ships: 1 to 60 characters,
// none of them a control character. Braces are allowed; the screen draws a name as plain text.
function projectNameOf(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return name && name.length <= 60 && !/[\u0000-\u001f\u007f-\u009f]/.test(name) ? name : null;
}
export function savedProjectName(root) {
  try {
    const file = projectFile(root); noSymlinks(file); if (!fs.existsSync(file)) return null;
    return projectNameOf(readJson(file)?.name);
  } catch { return null; }
}
// A folder is a project once it has ELU settings or is in the registry.
export function knownProject(location) {
  if (['project.json', 'config.yaml'].some(name => fs.existsSync(path.join(location.root, '.elu-code', name)))) return true;
  try {
    const file = path.join(personalDirectory(), 'projects.json'); noSymlinks(file);
    const rows = fs.existsSync(file) ? readJson(file) : [];
    return Array.isArray(rows) && rows.some(row => row?.root === location.root || Boolean(location.common) && row?.common === location.common);
  } catch { return false; }
}
export function nameProject(location, name) {
  const value = projectNameOf(String(name ?? ''));
  if (!value) refuse('Use a project name of 1 to 60 characters.');
  const folder = path.join(location.root, '.elu-code'); noSymlinks(folder); fs.mkdirSync(folder, { recursive: true });
  atomic(projectFile(location.root), { name: value, createdAt: new Date().toISOString() });
  registerProject(location); return value;
}
export function registeredProjects() {
  const file = path.join(personalDirectory(), 'projects.json'); noSymlinks(file);
  if (!fs.existsSync(file)) return [];
  const entries = readJson(file); if (!Array.isArray(entries)) refuse('The project registry is invalid.');
  return entries.flatMap(entry => { try { return [registeredProject(entry)]; } catch { return []; } });
}
export function dashboardSnapshot() {
  const file = path.join(personalDirectory(), 'projects.json'); noSymlinks(file);
  if (!fs.existsSync(file)) return { projects: [], usage: usageSnapshot() };
  const entries = readJson(file); if (!Array.isArray(entries)) refuse('The project registry is invalid.');
  return { usage: usageSnapshot(), projects: entries.map(entry => {
    try { return projectSnapshot(registeredProject(entry)); }
    catch (error) { return { root: entry.root, name: savedProjectName(entry.root) ?? path.basename(entry.root), unavailable: error.message, tasks: [], requests: [], queue: [], roles: {}, activity: [] }; }
  }) };
}
// Turns one of your Claude Code MCP servers on or off for this project's lead. All are on
// until turned off, as in Claude Code.
export function setServer(repo, name, on, proposedConfig) {
  checkServerName(name);
  if (!claudeServers(repo.root)[name]) refuse(`No MCP server named ${name}. Run claude mcp list to see yours.`);
  // The change starts from settings the owner approved, never from a file he has not.
  const file = path.join(repo.root, '.elu-code/config.yaml'), approved = trustedText(repo.root, 'config.yaml');
  const config = approved != null ? parseConfig(approved) : structuredClone(proposedConfig);
  const off = new Set(config.mcpOff ?? []); if (on) off.delete(name); else off.add(name);
  delete config.mcp; if (off.size) config.mcpOff = [...off]; else delete config.mcpOff;
  validateConfig(config); const text = stringifyYaml(config);
  fs.mkdirSync(path.dirname(file), { recursive: true }); approveSaved(repo.root, 'config.yaml', text); atomic(file, text); return config;
}
export function taskDetails(repo, id) {
  const task = readTask(repo, id);
  if (task.kind === 'conversation') return { task, diff: '', checks: [], reviews: [], logs: task.runs.filter(run => path.dirname(run.logFile) === taskDir(repo, id)).map(run => ({ role: run.role, text: readTail(run.logFile) })) };
  const untracked = git(task.worktree, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...notesSpec(task)]).stdout.split('\0').filter(Boolean);
  const additions = untracked.map(file => {
    const full = path.join(task.worktree, file); noSymlinks(full);
    if (!fs.statSync(full).isFile()) return `New path: ${file} (not a regular file)`;
    const text = readTail(full);
    return `New file: ${file}\n${text.includes('\0') ? '(binary content)' : text}${fs.statSync(full).size > 64000 ? '\n[File preview truncated.]' : ''}`;
  });
  return { task, diff: [diff(task.worktree, task.base, { exclude: notesSpec(task) }), ...additions].join('\n'), checks: task.evidence?.results ?? [], reviews: task.reviews, logs: task.runs.filter(run => path.dirname(run.logFile) === taskDir(repo, id)).map(run => ({ role: run.role, text: readTail(run.logFile) })) };
}
// The start of a new file for the Changes view: a regular file only, never through a link,
// never a wait on a pipe. All of it when it is at most `most` bytes, else `preview` bytes.
function readStart(file, most, preview) {
  try { noSymlinks(file); } catch (error) { return { note: /symbolic link/.test(error.message) ? 'symbolic link, not opened' : 'could not be read' }; }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { note: 'not a regular file' };
    const bytes = Buffer.alloc(stat.size <= most ? stat.size : Math.min(stat.size, preview));
    return { bytes: bytes.subarray(0, fs.readSync(fd, bytes, 0, bytes.length, 0)), size: stat.size };
  } catch (error) { return error.code === 'ENOENT' ? null : { note: error.code === 'ELOOP' ? 'symbolic link, not opened' : 'could not be read' }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
// What taskDetails shows as text, as files, hunks and lines (the shape is in diff.mjs). The
// same base and the same safe Git flags, with renames paired. Each call runs Git, so a view
// keeps the answer and asks again only to refresh.
export function taskPatch(repo, id) {
  const task = readTask(repo, id);
  if (task.kind === 'conversation') return buildChanges();
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/'];
  const run = git(task.worktree, [...args, task.base, '--'], { allowFailure: true });
  if (run.status !== 0 && run.error?.code !== 'ENOBUFS') refuse('git could not finish.', { exitCode: run.status, reason: (run.error?.message ?? run.stderr).trim().slice(0, 1000) });
  // A patch too large to hold arrives cut short. The totals then come from Git's own count.
  const counts = run.status === 0 ? null : git(task.worktree, [...args, '--raw', '--numstat', '-z', task.base, '--']).stdout;
  const untracked = git(task.worktree, ['ls-files', '--others', '--exclude-standard', '-z']).stdout.split('\0').filter(Boolean);
  // New files are read whole while they are small, 16 MB in all, so their lines can be counted.
  let budget = 16 * 1024 * 1024;
  const read = file => {
    const got = readStart(path.join(task.worktree, file), Math.min(budget, 4 * 1024 * 1024), LIMITS.previewBytes);
    budget -= got?.bytes?.length ?? 0;
    return got;
  };
  return buildChanges({ base: task.base, branch: task.branch ?? (currentBranch(task.worktree) || null), patch: run.stdout, counts, untracked, read });
}
// Whether the owner's message to @name in this session asks for a review of its edits: the
// session's own editing turn for its approved Task finished (implementedAt), the session
// changed files since it started and has not published them, and it stopped after that;
// @name is one of its reviewing bots, and the message is about the work, not a plain
// question (plainQuestion). Edits the owner had in his checkout before an automatic session
// started, which it copies into its worktree (initialDigest), are not the session's own. The
// fix turns run under that Task, opened again when it was done (reviewRequest).
export const REVIEW_STATES = Object.freeze(['blocked', 'ready', 'unverified', 'needs_input']);
export function reviewsEdits(repo, task, name, text) {
  if (!task || task.kind === 'conversation' || task.pushedCommit || !task.implementedAt || !REVIEW_STATES.includes(task.state) || plainQuestion(text)) return false;
  if (!reviewingBots(task).includes(name) || !agreedTask(sessionTasks(repo, task.id))) return false;
  try { const change = taskChanges(task); return (!task.initialDigest || change.digest !== task.initialDigest) && publishable(change).length > 0; } catch { return false; }
}
export function conversationEntries(repo, task) {
  const messages = task.messages ?? [];
  // A message the owner wrote to a bot reads You → @name; the bot's reply is an entry of its own.
  // A turn the bot's schedule started reads Schedule → @name, so it is never taken for the owner's.
  // shadow: a shadow bot said it after the agent's turn, unasked; quiet: a note about its turn and not its answer, such as why it did not speak.
  // A teammate's message reads as their own words under their name; the sentence ELU
  // wrote for the model is kept as goal, for a bot that reads the chat as the model did.
  const theirs = row => { const words = row.from && !row.bot ? teammateText(row) : null; return words ? { text: words, goal: row.text } : { text: row.text }; };
  // loop: a line of the review loop about the agent's own answer to a review (Fixed 2), shown as the agent's.
  const agentRun = task.runs.findLast(run => run.role === 'lead');
  // model, effort: what wrote an entry, for its header (fable 5.2 med). A row from before they
  // were kept has neither, and its header reads as it did.
  const written = row => row.loop ? { role: speaker(agentRun ?? { role: 'lead' }, row.model ?? agentRun?.model), lead: true, loop: true, at: row.at, text: row.text, ...wroteIt(row.model ? row : ranOn(agentRun)) } : row.bot ? { role: `@${row.bot}`, bot: row.bot, at: row.at, text: row.text, ...(row.failed ? { failed: true } : {}), ...(row.shadow ? { shadow: true } : {}), ...(row.quiet ? { quiet: true } : {}), ...wroteIt(row) }
    : row.to && !row.from ? { role: `${row.scheduled ? 'Schedule' : 'You'} → ${row.to}`, to: row.to.replace(/^@/, ''), at: row.at, text: row.text, ...(row.scheduled ? { scheduled: true } : {}) }
    // A standup's rows (lib/standup.mjs): line is one line of its own, such as "@ana asks: standup";
    // update is an update, the asked session's own or one that came to a Standup.
    : row.line || row.standup || row.update ? { role: row.from ?? 'Standup', at: row.at, text: row.text, ...(row.line ? { line: true } : { update: true }), ...(row.failed || row.failedAnswer ? { failed: true } : {}) }
    : { role: row.from ?? 'You', at: row.at, ...theirs(row) };
  // The review loop's lines (task.loop): each bot's review, and the agent's answer to it.
  const entries = [...(!messages.some(row => row.text === task.goal) ? [{ role: 'You', at: task.createdAt, text: task.goal }] : []), ...messages.map(written), ...(Array.isArray(task.loop) ? task.loop : []).map(written)];
  // A shared bot that answers a teammate speaks where the lead would, under its own name.
  const peerBot = task.origin?.bot ? botKey(task.origin.bot) : null, asBot = (at, text, run) => ({ role: `@${task.origin.bot}`, bot: task.origin.bot, at, text, ...wroteIt(ranOn(run)) });
  // Commands the owner ran with ! sit in the conversation where they happened.
  for (const row of memo(shellFile(repo, task.id), 'shell', () => shellRows(repo, task.id)) ?? []) entries.push({ role: row.cwd && row.cwd !== repo.root ? 'Shell · editing workspace' : 'Shell', shell: true, at: row.at, text: shellText(row), forModel: shellForModel(row) });
  // Only a Claude or Codex log is read here. When the newest lead run's log gave no reply, as a
  // Grok or Antigravity run's does, its reply is the task's own, added below unless already shown.
  // A standup's answer turn (lib/standup.mjs) shows as the standup's question and answer rows.
  const last = task.runs.findLast(run => (run.role === 'lead' || run.role === peerBot) && !run.standup);
  let lastSaid = false;
  for (const run of task.runs.filter(run => (run.role === 'lead' || run.role === peerBot) && !run.standup)) {
    if (path.dirname(run.logFile) !== taskDir(repo, task.id)) continue;
    const reply = memo(run.logFile, 'reply', () => {
      let summary, model;
      for (const line of readTail(run.logFile).split('\n')) {
        try {
          const row = JSON.parse(line);
          if (row.type === 'system' && row.subtype === 'init' && typeof row.model === 'string') model = row.model;
          if (row.type === 'result') {
            summary = row.structured_output?.summary;
            if (!summary && typeof row.result === 'string') { try { summary = JSON.parse(row.result).summary; } catch { summary = row.result; } }
          }
          if (row.type === 'item.completed' && row.item?.type === 'agent_message') { try { summary = JSON.parse(row.item.text).summary; } catch { summary = row.item.text; } }
        } catch { /* A partial stream remains visible through the running status. */ }
      }
      return { summary: summary ?? null, model: model ?? null };
    });
    if (reply?.summary) { lastSaid ||= run === last; const ran = { ...ranOn(run), ...(!run.model && reply.model ? { model: reply.model } : {}) }; entries.push(run.role === 'lead' ? { role: speaker(run, run.model ?? reply.model), lead: true, at: run.at, text: reply.summary, ...wroteIt(ran) } : asBot(run.at, reply.summary, ran)); }
  }
  const text = (task.reply ?? task.result)?.summary, at = task.runs.at(-1)?.at ?? task.createdAt, said = entries.filter(row => row.lead && !row.loop || peerBot && row.bot);
  if ((!said.length || last && !lastSaid && !said.some(row => row.text === text)) && text && !(task.reply ?? task.result).bot) entries.push(peerBot && last?.role === peerBot ? asBot(at, text, last) : { role: speaker(last ?? { role: 'lead' }, last?.model), lead: true, at, text, ...wroteIt(ranOn(last)) });
  return entries.sort((a, b) => Date.parse(a.at ?? 0) - Date.parse(b.at ?? 0)).slice(-80);
}
// The chat as a bot reads it when the owner writes to it: who wrote each entry, oldest
// first. A long chat keeps its newest part.
function botChat(repo, task) {
  // The line about files the owner has not approved is for him, not for a bot.
  const rows = conversationEntries(repo, { ...task, messages: (task.messages ?? []).filter(row => !row.unapproved) }).map(entry => ({ at: entry.at, from: entry.lead ? 'agent' : entry.shell ? 'owner (shell command)' : entry.scheduled ? `schedule of @${entry.to}` : entry.shadow ? `${entry.role} (shadow: its comment on the turn before, not a request)` : entry.role.replace(/^You/, 'owner'), ...(entry.shell ? entry.forModel : { text: String(entry.goal ?? entry.text ?? '').slice(0, 16000) }) }));
  // A command's output counts toward the size with its text.
  const length = row => row.text.length + (row.output?.length ?? 0);
  let size = 0, start = rows.length;
  while (start > 0 && size + length(rows[start - 1]) <= 60000) size += length(rows[--start]);
  return rows.slice(start);
}
export { modelName };
// The model and effort a run wrote with: the model its vendor reported, else the one it was
// started with (asked), and its effort; only the ones that are known.
const ranOn = run => ({ model: run?.model ?? run?.asked ?? null, effort: run?.effort ?? null });
// The model and effort fields of a chat entry, from a row or a run, when they read as text.
export function wroteIt(row) {
  const model = typeof row?.model === 'string' && row.model.trim() ? row.model.trim().slice(0, 80) : null, effort = typeof row?.effort === 'string' && /^[a-z]{1,12}$/.test(row.effort) ? row.effort : null;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}
// A chat speaker: the model that wrote the reply, such as Fable 5.1. A run that named no
// model reads as its vendor.
export function speaker(run, model) {
  return modelName(model) ?? (run?.vendor ? vendorShort(run.vendor) : 'Model');
}
// The name a model is shown by before it answers, as its chat titles will name it: the full
// name a run reported for it when one is known (opus reads Opus 5.5), else the name it was
// chosen by, else its vendor. known: [{ vendor, model }] from earlier runs, oldest first.
export function modelLabel(choice, known = []) {
  const family = id => (modelName(id) ?? '').split(' ')[0].toLowerCase();
  const seen = known.findLast(row => row.vendor === choice.vendor && row.model && (!choice.model || row.model === choice.model || family(row.model) === family(choice.model)));
  return modelName(seen?.model) ?? modelName(choice.model) ?? vendorShort(choice.vendor);
}
// The model a session's next message goes to, { vendor, model }: the one in its own saved
// policy. A session pinned to a commit has none of its own and reads as its last run.
export function sessionModel(repo, task) {
  if (ownsPolicy(task)) {
    try { const file = path.join(stateDir(repo, task.id), 'policy.yaml'), saved = memo(file, 'model', () => configModel(parseConfig(fs.readFileSync(file, 'utf8')))); if (saved) return saved; }
    catch { /* An unreadable policy shows the last run instead. */ }
  }
  const last = (task.runs ?? []).findLast(run => run.role === 'lead');
  return last ? { vendor: last.vendor, model: null } : null;
}
// The models the runs of these sessions reported, oldest first, for modelLabel.
export function reportedModels(tasks) {
  return tasks.flatMap(task => (task.runs ?? []).filter(run => run.role === 'lead' && run.model)).sort((a, b) => String(a.at).localeCompare(String(b.at))).map(run => ({ vendor: run.vendor, model: run.model }));
}

export function setupCommitPlan(repo) {
  const manifest = readJson(path.join(repo.state, 'manifest.json'));
  const allowed = ['.elu-code/config.yaml', ...(manifest.files ?? []).map(file => file.path).filter(file => ['AGENTS.md', 'CLAUDE.md'].includes(file))];
  const staged = git(repo.root, ['diff', '--cached', '--name-only', '-z']).stdout.split('\0').filter(Boolean);
  if (staged.some(file => !allowed.includes(file))) refuse('Other files are staged. Save that work before committing the project setup.');
  const base = head(repo.root);
  const files = allowed.flatMap(file => {
    const full = path.join(repo.root, file); noSymlinks(full);
    const before = baseFile(repo.root, base, file, { optional: true });
    const content = fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
    return before === content ? [] : [{ file, content }];
  });
  parseConfig(fs.readFileSync(path.join(repo.root, '.elu-code/config.yaml'), 'utf8'));
  return { base, files, digest: hash(JSON.stringify(files)), branch: git(repo.root, ['branch', '--show-current']).stdout.trim(), diff: files.map(({ file, content }) => `${file}\n${content ?? '(deleted)'}`).join('\n\n') };
}
export function commitSetup(repo, approved) {
  const current = setupCommitPlan(repo);
  if (current.base !== approved.base || current.digest !== approved.digest) refuse('The setup changed after the preview. Review it again.');
  if (!current.files.length) return 'The project setup is already committed.';
  const release = lock(repo);
  try {
    prepareGit(repo, repo.root, ['add', '--', ...current.files.map(file => file.file)]);
    git(repo.root, ['-c', `core.hooksPath=${path.join(repo.state, 'empty-hooks')}`, 'commit', '-m', 'Configure ELU']);
    return 'Project setup committed. Start a session to begin a task.';
  } finally { release(); }
}

// This controller owns only the tasks started by this view. Dashboard has no controller.
// Checking and publishing need the session to themselves. A turn holds it while it runs, and
// then the answer is to wait for the reply, in place of the lock's own line.
function publishLock(repo, id) {
  try { return lock(repo, `task-${id}`); }
  catch (error) {
    if (!error.message.includes('holds this lock')) throw error;
    let state = null; try { state = readTask(repo, id).state; } catch { /* The lock's own line stands. */ }
    if (['running', 'preparing'].includes(state)) refuse('Wait for the reply, or /stop, then publish.');
    throw error;
  }
}
export class ProjectController {
  constructor(repo, { readOnly = false, onRepository } = {}) {
    this.repo = repo; this.readOnly = readOnly; this.onRepository = onRepository; this.running = new Map(); this.conversations = new Map(); this.usageAbort = new AbortController();
    this.draftConfig = startConfig(repo.root); this.fromApproved = trustedText(repo.root, 'config.yaml') != null;
  }
  snapshot() { const value = projectSnapshot(this.repo); return value.initialized ? value : { ...value, roles: this.draftConfig.roles }; }
  // A long-lived owner picks up agent changes saved by any terminal. A settings file that
  // changed is not used until the owner approves it: the settings he approved stay. Once he
  // goes without them, the draft starts over from the defaults. With no file and none
  // approved the draft stays.
  reloadConfig() {
    const approved = trustedText(this.repo.root, 'config.yaml') != null;
    if (approved || this.fromApproved || fs.existsSync(path.join(this.repo.root, '.elu-code/config.yaml'))) this.draftConfig = startConfig(this.repo.root);
    this.fromApproved = approved;
  }
  writable() { if (this.readOnly) refuse('This view is read-only. Use the first view to make changes.'); }
  // A session's edit runs in the repository the lead chose; its records stay here.
  taskRepo(task) {
    if (!task?.repository || task.repository === this.repo.root) return this.repo;
    const found = findRepository(task.repository);
    if (!found || found.root !== task.repository) refuse('The repository this session edits has moved or is gone.');
    return { ...found, state: this.repo.state, project: this.repo.root };
  }
  // The repository the lead named, from the project folder or your home. null means the
  // project folder itself, which starts its own history.
  // folders: the session's extra folders; a repository in one may be edited too.
  editTarget(named, folders = []) {
    const root = this.repo.root, home = fs.realpathSync(os.homedir()), value = typeof named === 'string' && named.trim() ? named.trim() : '.';
    const folder = path.resolve(root, value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value);
    const real = fs.existsSync(folder) && fs.statSync(folder).isDirectory() ? fs.realpathSync(folder) : null;
    if (!real || !within(home, real) && !within(root, real) && !folders.some(dir => within(dir, real))) refuse(`The model chose ${value}, which is not a folder in your home. Tell it which repository to change.`);
    const found = findRepository(real);
    if (found) return found.root === root ? this.repo : { ...found, state: this.repo.state, project: root };
    if (real !== root) refuse(`${value} is not a Git repository. Tell the model which repository to change.`);
    if (root === home) refuse('Tell the model which repository to change. Your home folder never becomes a repository.');
    return null;
  }
  historyPlan() { this.writable(); return historyPlan(this.repo); }
  createHistory(plan) { this.writable(); const next = createHistory(plan); this.adoptRepository(next); return next; }
  setChecks(command) { this.writable(); const next = structuredClone(this.draftConfig); next.checks = [{ name: 'tests', command }]; validateConfig(next); this.draftConfig = next; }
  setupPlan() { this.writable(); return initPlan(this.repo, this.draftConfig); }
  setup(plan) { this.writable(); const result = applyInit(this.repo, plan); registerProject(this.repo); return result; }
  vendors() { this.writable(); return detect(this.repo.root); }
  servers() { const all = Object.keys(claudeServers(this.repo.root)), off = this.draftConfig.mcpOff ?? []; return { all, on: all.filter(name => !off.includes(name)) }; }
  setServer(name, on) {
    this.writable(); this.draftConfig = setServer(this.repo, name, on, this.draftConfig);
    return on ? `${name} is on. The model can use its tools from your next message.` : `${name} is off for this project. /mcp on ${name} turns it back on.`;
  }
  queue(goal, id, update) { this.writable(); return saveRequest(this.repo.root, goal, id, update); }
  cancelRequest(id) { this.writable(); removeRequest(this.repo.root, id); }
  // A teammate's ask or review never escalates to editing and may continue only its own
  // conversation; an accepted handoff becomes the owner's normal task. permissions, place
  // and folders are the owner's session choices; a follow-up without them
  // inherits the task's, and one with a mode switches the task from this turn.
  // bots: the bots in the chat, set like the other session choices. bot: the bot this message
  // is written to; it answers in one read-only turn and the lead does not run. A teammate's
  // request names a shared bot in origin.bot instead, and that bot answers it.
  // model: the model the session runs on, { vendor, model }. A new session without one
  // starts with the project's default; a follow-up with one switches from this turn.
  // A bot that has a schedule works instead: its turn may end in an edit, which then takes
  // the path the model's edit takes, with the bot doing the work. scheduled: the bot's own
  // schedule wrote the message. botChat: a new session becomes that bot's own chat.
  // timed: a /schedule job wrote the message, so the owner is not at this turn.
  // A turn that changes no files is followed by the session's shadow bots (runShadows), once
  // each, when the owner wrote the message to the model or to a bot that works. Their
  // turns are part of this message: the next one waits for them as it waits for a review.
  // approved: the owner approved the session's Task (lib/plan.mjs), with the key or by typing
  // yes. Its editing turn starts at once, by the model or the bot that proposed it, with no
  // second planning turn. An editing turn starts in no other way than for an approved Task.
  // mine: the owner's other computer started this new session (lib/peer/remote.mjs); it is marked so on its record.
  // home: the owner let this new teammate's session run in his home folder (HOME_QUESTION).
  // helps: this new session of the owner's helps one on his other computer (lib/remote-helper.mjs).
  // A message of the owner's to a session whose approved Task stopped on a question, a block
  // or his stop continues that work (continueTask): the Task's edit access, in the session's
  // mode now. When that work cannot start again (continueReady refuses), the message gets a
  // read-only answer that says why. A session whose Task is done answers in a read-only turn.
  ask(text, id, { readOnly = false, origin = null, context = null, permissions, place, folders, bots, bot = null, model, scheduled = false, botChat: ownChat = false, timed = false, approved = false, mine = null, home = false, helps = null, standup = null, standupFor = null } = {}) {
    this.writable();
    if (standup || standupFor) return this.standup(text, id, { permissions, standup, standupFor });
    let saved = id ? readTask(this.repo, id) : null;
    const own = Boolean(saved) && !origin && !readOnly && !scheduled && !timed;
    if (approved && !own) refuse('Only the owner approves a Task, in its own session.');
    if (own && !approved && saysYes(text) && waitingTask(sessionTasks(this.repo, saved.id))) { approveTask(this.repo, saved.id); approved = true; }
    const agreed = approved ? taskToStart(this.repo, saved.id) ?? refuse('That Task is no longer waiting to start.') : null;
    // A Task that needs no edit is worked on in an ordinary turn, which is told it is approved.
    const direct = agreed?.edit.intent === 'edit' ? agreed : null;
    if (direct) bot = direct.edit.bot ?? null;
    // A session a teammate's message started never works in the home folder, or above it,
    // unless the owner allowed it: not its first turn, and not a later one, whoever writes it.
    // Where it works decides: a session that edits in a repository's own folder is not there.
    const theirs = Boolean(origin?.peer || saved?.origin?.peer), allowed = saved ? saved.homeAllowed === true : home === true;
    if (theirs && !allowed && homeWork(saved, this.repo.root)) refuse(homeRefusal(saved?.id ?? null));
    if (saved && ['ask', 'review', 'handoff'].includes(origin?.kind) && (saved.kind !== 'conversation' || saved.origin?.peer !== origin.peer)) refuse('A teammate can continue only their own conversation.');
    if (origin && (bot !== null || bots !== undefined)) refuse("Bots join your own sessions, not a teammate's question.");
    if (scheduled && (bot === null || !saved)) refuse("A bot's scheduled turn names the bot and its session.");
    if (origin?.bot && !isPeerRun(origin)) refuse('A peer request names an invalid bot.');
    if (saved && isPeerRun(origin) && origin.bot && origin.bot !== saved.origin?.bot) refuse('A teammate can continue only their own conversation.');
    if (isPeerRun(origin) && (origin.bot ?? saved?.origin?.bot)) sharedBot(origin.bot ?? saved.origin.bot);
    else if (isPeerRun(origin) && (saved ? pinnedConfig(this.repo, null, { task: saved }).config : this.draftConfig).roles.lead.vendor !== 'claude') refuse('A teammate\'s question needs Claude as the model.');
    if (saved && isPeerRun(origin) && (permissions !== undefined || place !== undefined || folders !== undefined)) refuse('Teammate questions stay read-only.');
    if (origin && model !== undefined) refuse("A teammate's question runs on your default model.");
    const addressed = bot === null ? null : needBot(bot);
    if (addressed && isPeerRun(saved?.origin)) refuse("Bots join your own sessions, not a teammate's question.");
    // A teammate's later message in a session their message started keeps the session as it
    // is: the mode it carries is only what a new one would start with, and the owner may
    // have changed this one since.
    const keep = Boolean(saved) && origin?.own === true;
    if (saved && permissions !== undefined && !keep) saved = savePermissions(this.repo, saved.id, permissions);
    for (const dir of saved && !keep ? folders ?? [] : []) saved = saveFolder(this.repo, saved.id, dir);
    if (saved && bots !== undefined) saved = saveBots(this.repo, saved.id, bots);
    if (saved && model !== undefined) saved = setSessionModel(this.repo, saved.id, model);
    // The owner's message continues the work of the session's approved Task when it stopped
    // before the end; it never goes to a read-only turn that resumes the working one. Edits
    // kept as not verified because a later turn of the work failed are such a stop too.
    const working = own && !direct && !addressed && saved.kind !== 'conversation' && (['needs_input', 'blocked', 'stopped'].includes(saved.state) || saved.state === 'unverified' && Boolean(saved.error?.message)) && !saved.pushedCommit && Boolean(openTask(sessionTasks(this.repo, saved.id)));
    // The owner's message to one of the session's reviewing bots about edits this session made
    // and has not published runs a review of them (reviewRequest): that bot's must-fix findings
    // go to the agent, which fixes or disputes them, and the loop goes on as after its turn. A
    // plain question (plainQuestion) gets the bot's answer in the chat as before.
    const reviewing = own && !direct && Boolean(addressed) && reviewsEdits(this.repo, saved, addressed.name, text);
    const task = saved ?? createConversation(this.repo, withModel(this.draftConfig, model ?? defaultModel(this.draftConfig)), text, { origin, permissions, place, folders, bots, ...(ownChat && addressed ? { botChat: addressed.name } : {}), ...(mine && !origin ? { mine } : {}), ...(theirs && home === true ? { homeAllowed: true } : {}), ...(helps && !origin ? { helps } : {}) });
    const location = saved && saved.kind !== 'conversation' ? this.taskRepo(saved) : this.repo;
    // Nor in a repository there: the one the model chose for the edit, or one a session edits
    // already. The owner's y for the session lets it there too.
    const notHome = target => { if (theirs && !allowed && target && homeOrAbove(target.root)) refuse(HOME_TARGET); return target; };
    notHome(location);
    const shadowed = !origin && !readOnly && !scheduled && !timed && (!addressed || botWorks(addressed));
    const finished = this.own(task.id, async signal => {
      let value, stuck = null;
      if (working) {
        const ready = await continueReady(location, task.id).catch(error => { stuck = error.message; return null; });
        if (ready) return continueTask(location, task.id, text, { signal, ready, owner: true });
      }
      // Work that cannot go on here (published, its policy changed) is answered by the bot instead.
      if (reviewing) {
        const ready = await continueReady(location, task.id).catch(() => null);
        if (ready) return reviewRequest(location, task.id, text, { signal, bot: addressed.name, ready });
      }
      const chat = current => botChat(this.repo, current);
      // owner: the owner wrote this message, just now. Only such a turn may start a vendor's one-time check.
      const owner = !origin && !scheduled && !timed;
      const conversation = direct ? Promise.resolve().then(() => beginApproved(this.repo, task.id, text, direct)) : addressed ? runBot(location, task, text, { signal, name: addressed.name, chat, scheduled, owner, unattended: timed ? 'schedule' : false }) : runConversation(location, task, text, { signal, origin, context, readOnly, owner, unattended: scheduled || timed ? 'schedule' : origin?.kind === 'handoff' && !origin.own ? 'handoff' : false, stuck }); this.conversations.set(task.id, conversation);
      try { value = await conversation; } finally { this.conversations.delete(task.id); }
      // A shadow turn never fails the message it follows.
      if (value.state !== 'preparing') return shadowed ? runShadows(location, value, { signal, chat, by: addressed ? `@${addressed.name}` : 'lead' }).catch(() => value) : value;
      // The bot this message was written to makes the edit it asked for, where the model would.
      const worker = addressed ? { bot: addressed.name, scheduled, chat } : null;
      try {
        // The gate: whatever a reply said, the app starts an edit only for a Task the owner
        // approved, or one a schedule recorded for a run nobody watches.
        if (!openTask(sessionTasks(this.repo, value.id))) refuse('This session has no approved Task, so no edit was started.');
        if (value.kind !== 'conversation') return await continueTask(this.taskRepo(value), value.id, text, { signal, recordAnswer: false, worker });
        let target = notHome(this.editTarget(worker ? value.botEdit?.repository : direct?.edit.repository ?? value.result?.repository));
        if (!target || target === this.repo) { await this.editingRepository(signal); signal.throwIfAborted(); target = this.repo; }
        value = readTask(this.repo, task.id);
        const { config } = pinnedConfig(this.repo, null, { task: value });
        const plan = await runPlan(target, value.goal, { automatic: true, config, id: value.id });
        return await runTask(target, plan, { signal, conversation: value, worker });
      } catch (error) {
        const current = readTask(this.repo, task.id);
        if (current.kind === 'conversation' || current.state === 'preparing') { current.state = signal.aborted ? 'stopped' : 'blocked'; current.error = { message: error.message }; saveTask(this.repo, current); }
        throw error;
      }
    });
    return { id: task.id, finished };
  }
  // /standup (lib/standup-round.mjs). standup: a round, in a new Standup session on the
  // project's default model and the mode given, or, with id, another round of that Standup
  // session (@everyone); { question } asks that in place of the standup. The round asks every
  // open session of the owner's and of his teammates' shared ones, then the Standup's model
  // sums it up in one turn of its own. /stop stops the waiting and the summary still comes; a
  // second /stop stops the summary. standupFor: one of this computer's sessions answers a
  // round in a read-only turn of its own (runStandup).
  standup(text, id, { permissions, standup = null, standupFor = null } = {}) {
    if (standupFor) {
      const saved = readTask(this.repo, id), location = saved.kind !== 'conversation' ? this.taskRepo(saved) : this.repo;
      if (fromTeammate(saved.origin) || saved.standup) refuse('Only your own sessions answer a standup.');
      return { id: saved.id, finished: this.own(saved.id, signal => runStandup(location, saved, standupFor, { signal })) };
    }
    const saved = id ? readTask(this.repo, id) : null;
    if (saved && !saved.standup) refuse('@everyone asks again from a Standup session. /standup starts one.');
    const task = saved ?? createConversation(this.repo, withModel(this.draftConfig, defaultModel(this.draftConfig)), text, { permissions });
    const question = standup && typeof standup === 'object' ? standup.question ?? null : null;
    // After the owner's /stop the summary still comes, under a stop of its own; a conductor
    // that stops ends it all.
    const renew = () => { const run = this.running.get(task.id); if (!run || run.controller.signal.reason?.message !== 'Stopped by the owner.') return null; run.controller = new AbortController(); return run.controller.signal; };
    // summing: whether its summary turn runs, which the conductor counts as any model's turn.
    let summing = false;
    return { id: task.id, finished: this.own(task.id, async signal => (await import('./standup-round.mjs')).runStandupSession(this.repo, task.id, { signal, renew, question, message: saved ? text : null, onSummary: () => { summing = true; } })), summing: () => summing };
  }
  async editingRepository(signal) {
    if (this.repo.common && git(this.repo.root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true }).status === 0) return;
    if (this.preparation) return this.preparation;
    this.preparation = (async () => {
      while (this.conversations.size) await Promise.allSettled([...this.conversations.values()]);
      signal?.throwIfAborted();
      const plan = historyPlan(this.repo);
      this.adoptRepository(plan ? createHistory(plan) : projectFolder(this.repo.root));
    })().finally(() => { this.preparation = null; });
    return this.preparation;
  }
  adoptRepository(next) {
    const previous = this.repo;
    if (previous.state !== next.state) {
      for (const task of tasks(previous)) {
        const from = taskDir(previous, task.id), to = taskDir(next, task.id);
        if (fs.existsSync(to)) refuse('Task history already exists in the new repository. Reopen the project before continuing.');
        const copy = (source, destination) => {
          noSymlinks(source); noSymlinks(destination); const stat = fs.statSync(source);
          if (stat.isDirectory()) { fs.mkdirSync(destination, { recursive: true, mode: 0o700 }); for (const name of fs.readdirSync(source)) copy(path.join(source, name), path.join(destination, name)); }
          else { noSymlinks(destination); if (!fs.existsSync(destination)) fs.copyFileSync(source, destination); }
        };
        copy(from, to);
        task.runs = task.runs.map(run => ({ ...run, logFile: path.join(to, path.basename(run.logFile)) }));
        if (Array.isArray(task.stops)) task.stops = task.stops.map(run => ({ ...run, logFile: path.join(to, path.basename(run.logFile)) }));
        task.activeLog = null; saveTask(next, task);
      }
      const events = path.join(previous.state, 'events.jsonl'); noSymlinks(events);
      if (fs.existsSync(events) && !fs.existsSync(path.join(next.state, 'events.jsonl'))) fs.copyFileSync(events, path.join(next.state, 'events.jsonl'));
    }
    this.repo = next; this.onRepository?.(next); registerProject(next);
  }
  async verify(id, command) {
    this.writable(); const release = publishLock(this.repo, id);
    try {
      const task = readTask(this.repo, id);
      if (task.kind === 'conversation' || task.state === 'running') refuse('Select a finished editing task to verify.');
      const repo = this.taskRepo(task), { config } = pinnedConfig(repo, task.base, { current: false, task });
      if (command) {
        if (task.mode !== 'automatic') refuse('Update and commit checks through project settings for this task.');
        config.checks = [{ name: 'tests', command }]; validateConfig(config);
        const text = stringifyYaml(config); atomic(path.join(taskDir(this.repo, id), 'policy.yaml'), text); task.configHash = hash(text); saveTask(this.repo, task);
      }
      const result = await runChecks(repo, task);
      const reviewed = task.reviewStatus === 'skipped' || task.reviewStatus === 'passed' && task.reviews.at(-1)?.digest === result.digest;
      task.state = reviewed && evidenceCurrent(task) ? 'ready' : 'unverified';
      saveTask(this.repo, task); return result;
    } finally { release(); }
  }
  setupCommitPlan() { this.writable(); return setupCommitPlan(this.repo); }
  commitSetup(plan) { this.writable(); return commitSetup(this.repo, plan); }
  plan(goal) { this.writable(); return runPlan(this.repo, goal); }
  start(plan, request) {
    this.writable(); if (request) this.queue(request.goal, request.id, { taskId: plan.id, state: 'starting', reason: 'Starting task.' });
    return this.own(plan.id, signal => runTask(this.repo, plan, { signal })).then(task => { if (request) removeRequest(this.repo.root, request.id); return task; }, error => {
      if (request) { if (tasks(this.repo).some(task => task.id === plan.id && task.goal === request.goal)) removeRequest(this.repo.root, request.id); else this.queue(request.goal, request.id, { state: 'blocked', taskId: null, reason: error.message }); } throw error;
    });
  }
  answer(id, text) { this.writable(); const repo = this.taskRepo(readTask(this.repo, id)); return this.own(String(id), signal => continueTask(repo, id, text, { signal, owner: true })); }
  // The owner's y to HOME_QUESTION for this session. Returns the task.
  allowHome(id) { this.writable(); return allowHome(this.repo, String(id)); }
  // The session's mode and folders: a switch applies from the next turn.
  setPermissions(id, mode) { this.writable(); return savePermissions(this.repo, String(id), mode); }
  // The bots in the session's chat: saved bots only. Returns the task.
  setBots(id, names) { this.writable(); return saveBots(this.repo, String(id), names); }
  setBudget(id, dollars) { this.writable(); return saveBudget(this.repo, String(id), dollars); }
  // What the model has spent in a session and the most it may: the limit the owner set for
  // the session, or null when he set none.
  budget(id) {
    const task = readTask(this.repo, String(id));
    const spent = runCosts(task).reduce((total, cost, at) => task.runs[at]?.role === 'lead' ? total + (cost ?? 0) : total, 0), own = Number.isFinite(task.budgetUsd);
    return { spent, limit: own ? task.budgetUsd : null, own };
  }
  // The session's model, from its next message. Returns the task.
  setModel(id, choice) { this.writable(); return setSessionModel(this.repo, String(id), choice); }
  // The model new sessions of this project start with, saved in its config file.
  setDefaultModel(choice) { this.writable(); this.draftConfig = setDefaultModel(this.repo, choice, this.draftConfig); return defaultModel(this.draftConfig); }
  defaultModel() { return defaultModel(this.draftConfig); }
  addFolder(id, dir) { this.writable(); return saveFolder(this.repo, String(id), dir); }
  own(id, run) {
    if (this.running.has(id)) refuse('This task is already running.');
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => run(controller.signal)).finally(() => this.running.delete(id));
    this.running.set(id, { controller, promise }); return promise;
  }
  async stop(id, reason = 'Stopped by the owner.') {
    this.writable(); const run = this.running.get(String(id));
    if (!run) refuse('This task is not owned by this view.');
    run.controller.abort(new Error(reason));
    await run.promise.catch(() => {});
  }
  refreshUsage() {
    this.writable();
    return this.usageRefresh ??= refreshCodexUsage({ signal: this.usageAbort.signal }).finally(() => { this.usageRefresh = null; });
  }
  async close() { this.usageAbort.abort(); await Promise.all([this.usageRefresh, ...[...this.running.keys()].map(id => this.stop(id))]); }
  async pushPlan(id) {
    this.writable(); const release = publishLock(this.repo, id);
    try { const task = readTask(this.repo, id); if (task.kind === 'conversation' || task.state === 'answered') refuse('This response has no code changes to publish.'); return await preparePublish(this.taskRepo(task), task); } finally { release(); }
  }
  async push(id, confirmationId) {
    this.writable(); const release = publishLock(this.repo, id);
    try { const task = readTask(this.repo, id); return await publish(this.taskRepo(task), task, confirmationId); } finally { release(); }
  }
}
