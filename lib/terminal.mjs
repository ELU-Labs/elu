import blessed from 'blessed';
import { ProjectController, dashboardSnapshot, claimView, registerProject, registeredProjects, archiveProject, taskDetails, taskPatch, conversationEntries, modelLabel, modelName, reportedModels, sessionModel, knownProject, nameProject, savedProjectName } from './projects.mjs';
import { redact } from './publish.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectPath, projectFolder, createFolderPlan, createFolder, pendingRequests, removeRequest, takeRequest, addToRequest } from './workspace.mjs';
import { git, currentBranch } from './git.mjs';
import { runShell, recordShell, shellText } from './shell.mjs';
import { readProjectSettings, saveInstructions, saveContext } from './project-settings.mjs';
import { answerTrust, pendingTrust, reviewLines, unusedTrust } from './project-trust.mjs';
import { parseConfig } from './config.mjs';
import { enqueue as queueRequest, sendCommand, startConductor as launchConductor, retryRequest, saveConductorSettings, conductorSettings } from './conductor.mjs';
import { readablePictures } from './pictures.mjs';
import { boardRows, barCells, barColumns, boardSections, rowActions, rowCard, peerDecision, peerIncoming } from './board.mjs';
import { COMMANDS, FIRST_CHECK, argumentMatches, commandMatches, mentionMatches, sessionMentions, commandWords, needsArgument, parseCommand, vendorText } from './terminal-commands.mjs';
import { BOT_COLORS, listBots, getBot, needBot, chatBots, sessionBots, botColor, botOfKey, botShadows, botWorks, pickBotColor, saveBot, canShare } from './bots.mjs';
import { botModels, matchModels } from './bot-models.mjs';
import { modelChoices, findModel, choiceName, modelText, modelProblem, rememberModel, installedVendors } from './models.mjs';
import { addAgent, agentWords } from './agents.mjs';
import { botLines, botNames, botMessage, botDialogs } from './terminal-bots.mjs';
import { PALETTE, displayText, ink, keyHints, visible, terminalLayout, relativeTime, remote, peerName, threadWho, clockTime, teamPanes, membersLine, roomTarget, dmTarget, botTarget, peerSummary, chatBlock, messageTime, fitWords, wrapText } from './terminal-visuals.mjs';
import { sanitize } from './peer/peerdata.mjs';
import { approveTask, rejectTask } from './plan.mjs';
import { taskCard, taskNeedsYou } from './terminal-plan.mjs';
import { COLUMNS, readBoard, addCard, editCard, removeCard, startCard, linkCards, setDone, boardColumns, fitCard, closeSession, reopenSession } from './kanban.mjs';
import { taskTitle, setTitle, nameProblem, TITLE_MAX, requestGoal, sessionGoal, teammateText } from './state.mjs';
import { setPermissions as saveMode } from './runner.mjs';
import { listSchedules, saveSchedule, removeSchedule, pauseSchedule, runScheduleNow, runDue, parseWhen, nextRun, dateText, installScheduler, uninstallScheduler } from './schedules.mjs';
import { runBotSchedules, botScheduleIn, botScheduleLines, setBotSchedule, runBotNow, botSchedulesOn, botChatSession, botSchedulesShown, botScheduleBrief } from './bot-schedules.mjs';
import { peerPolicy as savedPeerPolicy } from './peer/settings.mjs';
import { MODES, PROFILES, LABELS, BADGES, APPROVAL_WAIT_SECONDS, checkMode, checkPlace, checkFolders, capMode, defaultMode, saveDefaultMode, isPeerRun, fromTeammate } from './modes.mjs';
import { VENDORS, VENDOR_NAMES, CAPS } from './vendors.mjs';
import { pendingApprovals, answerApproval, ownersToAnswer } from './approvals.mjs';
import { liftedBy, neverSentence, whyBlocked } from './never-list.mjs';
import { entryLine, keepOffer, keepRule, listEntries, removeEntry, turnOnEntry, usesSavedRules } from './permission-rules.mjs';
import { conformanceState, uncheckedText, vendorReading } from './conformance.mjs';
import { findBin, hash } from './util.mjs';
import { shellSandboxLine } from './sandbox.mjs';
import { changeRows, changeSummary } from './changes.mjs';
import { usageTab, refreshUsage, usageStale } from './usage.mjs';
import { detect } from './detect.mjs';
import { refreshAwake } from './awake.mjs';
import { editable } from './editor.mjs';
import { attachPaste, pastedText } from './paste.mjs';
import { readCode } from './peer/invite-code.mjs';
import { remoteSessions } from './terminal-remote.mjs';
import { RULES_MAX as RULES_LIMIT } from './peer/access.mjs';
import { attachReports, attachSelection, systemClipboard, buttonCode } from './selection.mjs';

// Everything the owner types for a session is queued here. A picture the message names in a
// folder no session may read (a screenshot saved under ~/Library) is first copied to where
// the session can read it, and the message names the copy.
const enqueue = (root, goal, options) => queueRequest(root, readablePictures(goal).text, options);

// All display text is untrusted, including tool output and task titles.
export function plain(value) { return redact(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f]/g, ' '); }
const clip = (value, width) => { const text = plain(value); return text.length > width ? `${text.slice(0, Math.max(0, width - 3))}...` : text; };
// Key hints joined by a dot, on as many rows as the width needs. A hint is never split.
const keyRows = (text, width) => text.split(' · ').reduce((rows, part) => { const last = rows.at(-1); if (last !== undefined && `${last} · ${part}`.length <= width) rows[rows.length - 1] = `${last} · ${part}`; else rows.push(part); return rows; }, []);
const cost = runs => {
  const known = runs.filter(run => Number.isFinite(run.costUsd));
  if (!known.length) return 'not reported';
  return `${known.length < runs.length ? 'at least ' : ''}$${known.reduce((sum, run) => sum + run.costUsd, 0).toFixed(2)}`;
};
export function todayCost(projects, now = new Date()) {
  const day = now.toDateString();
  return cost(projects.flatMap(project => project.tasks.flatMap(task => task.runs.filter(run => new Date(run.at ?? task.createdAt ?? '').toDateString() === day))));
}
// The Usage tab. A reset time is the clock when it is today, else the day and the clock.
const USAGE_NAMES = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', grok: 'Grok Build' };
const resetTime = (seconds, now) => { const at = new Date(seconds * 1000); return at.toDateString() === now.toDateString() ? at.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : at.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', ''); };
const dayText = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric' }) : 'unknown';
const pct = value => `${Math.round(value)}%`;
// Claude's usage is what Claude Code reports during a session, so none shows before one.
const CLAUDE_UNSEEN = 'Usage shows after your next session on Claude Code.';
// One window: a six-cell bar, the percent, the reset. A window the vendor did not report says so.
function usageWindow(name, row, now) {
  if (row?.usedPercent == null) return `${name}  [------]    —   ${row?.resetsAt ? `resets ${resetTime(row.resetsAt, now)}` : 'not reported'}`;
  const percent = Math.round(row.usedPercent), used = Math.round(percent * 6 / 100);
  return `${name}  [${'#'.repeat(used)}${'-'.repeat(6 - used)}]  ${pct(percent).padStart(4)}  ${row.resetsAt ? `resets ${resetTime(row.resetsAt, now)}` : 'reset not reported'}`;
}
const otherText = other => [other.account, `last seen ${dayText(other.lastSeen)}`, ...(other.usage?.weekly?.usedPercent != null ? [`wk ${pct(other.usage.weekly.usedPercent)} then`] : other.usage?.fiveHour?.usedPercent != null ? [`5h ${pct(other.usage.fiveHour.usedPercent)} then`] : [])].join(' · ');
// One block per vendor from usageTab() rows: the account and plan, the two windows, other
// accounts seen, then how to switch. Each line names its vendor so Enter can open that
// vendor's details.
export function usageBlocks(rows, { now = new Date() } = {}) {
  const out = [];
  for (const row of rows) {
    const name = (USAGE_NAMES[row.vendor] ?? row.vendor).padEnd(12), indent = ' '.repeat(12);
    const add = (text, tone = 'text', bold = false) => out.push({ vendor: row.vendor, text, tone, bold });
    if (!row.installed) { add(`${name}not installed`, 'muted'); continue; }
    // Never run yet, so its sign-in was never read: what starts its one-time check, not "not signed in".
    if (row.unchecked) { add(`${name}${FIRST_CHECK}`, 'muted'); continue; }
    if (!row.signedIn) { add(`${name}not signed in. ${row.signInHint}`, 'muted'); continue; }
    add(name + [row.active?.account ?? 'signed in', row.active?.plan, 'active'].filter(Boolean).join(' · '), 'text', true);
    if (row.usage || row.vendor === 'codex') { add(indent + usageWindow('5h', row.usage?.fiveHour, now)); add(indent + usageWindow('wk', row.usage?.weekly, now)); }
    else add(indent + (row.vendor === 'claude' ? CLAUDE_UNSEEN : 'usage not reported'), 'muted');
    for (const other of row.others ?? []) add(indent + otherText(other), 'muted');
    if (row.switchHint) add(indent + row.switchHint, 'muted');
  }
  return out;
}
// The details dialog for one vendor: when its usage was reported, both windows with their resets, other accounts.
export function usageDetailLines(row, now = new Date()) {
  if (!row.installed) return ['Not installed.'];
  if (row.unchecked) return [uncheckedText(row.vendor)];
  if (!row.signedIn) return [`Not signed in. ${row.signInHint}`];
  const lines = [[row.active?.account ?? 'signed in', row.active?.plan, row.active?.tier].filter(Boolean).join(' · ')], usage = row.usage;
  if (!usage) lines.push('', row.vendor === 'claude' ? CLAUDE_UNSEEN : 'Usage not reported.');
  else lines.push(`Reported ${clockTime(usage.observedAt)}`, '', usageWindow('5h', usage.fiveHour, now), usageWindow('wk', usage.weekly, now));
  if (row.others?.length) lines.push('', 'Other accounts', ...row.others.map(other => [other.account, other.plan, `first seen ${dayText(other.firstSeen)}`, otherText(other).split(' · ').slice(1).join(' · ')].filter(Boolean).join(' · ')));
  if (row.switchHint) lines.push('', row.switchHint);
  return lines;
}
export const geometry = terminalLayout;
// There is no peer on or off: the peer daemon runs while this machine is on a team. /invite
// and /join start it; the app starts it when it opens on a machine on a team.
const NO_TEAM = 'No team yet. Invite someone with /invite, or join with /join CODE.';
// What plain /invite offers.
const INVITE_NEW = 'Someone new: get an invite code to send them', INVITE_BOTS = 'Choose which of your bots teammates can use', INVITE_MINE = 'Another computer of mine: start sessions on it from here';
// Chats on a machine on no team.
const CHATS_OFF = 'No team yet.\nInvite someone: /invite\nGot a code? /join CODE';
const NO_PROJECT = 'Create a project first: press n in the Projects tab.';
const PEER_STOPPED = 'The peer daemon is not running. ELU Code starts it again within a minute.';
const PEER_MISSING = 'Teammates need the optional networking packages. Reinstall with optional dependencies.';
const WEEK = 7 * 24 * 60 * 60 * 1000;
// The facade never loads the networking packages itself; a missing module only hides peer features.
async function loadPeer() { try { return await import('./peer/index.mjs'); } catch { return null; } }
// One chat message as a block: header, then text behind the speaker's bar. Built once per text and width.
const blocks = new Map();
function chatMessage({ title, at = null, text, tone, shaded = false, raw = false }, width, colour) {
  const time = at ? messageTime(at) : '', key = [width, tone, shaded, colour, title, time, raw, text].join('\x00');
  let value = blocks.get(key);
  if (value === undefined) {
    // raw: a command and its output keep their asterisks and backticks.
    value = chatBlock({ title, time, text: raw ? blockText(text) : blockText(text).replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1'), tone, shaded, width, colour });
    blocks.set(key, value); if (blocks.size > 500) blocks.delete(blocks.keys().next().value);
  }
  return value;
}
// trusted: text from a trusted teammate shows as sent; control characters still go.
// A short value, such as an invite code, set apart in a frame so it reads as the thing to send.
const framed = value => { const rule = '─'.repeat(value.length + 6); return `╭${rule}╮\n│   ${value}   │\n╰${rule}╯`; };
function blockText(value, { trusted = false } = {}) {
  const text = String(value ?? '');
  return (trusted ? text.slice(0, 512000) : redact(text, 512000)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '') + (text.length > 512000 ? '\n[Display truncated; inspect the session worktree for the complete content.]' : '');
}
// The pickers: a number, the choice, what it means.
const PICK = (number, label, text) => `${number}  ${label.padEnd(19)}${text}`;
// What each mode allows, in one line each, the internet included.
const MODE_TEXT = { ask: "Edits the session's files; asks you for the rest and the internet.", auto: "Edits the session's files; a reviewer model, not you, decides the rest.", full: 'Any file, any command, the internet. Push and deploy stay blocked.' };
const PLACE_TEXT = { worktree: 'A copy of this repo on a new branch, feat/task-N.', branch: 'This repo on a branch you name.', here: 'This checkout, as it is.  Full access only.' };
const placeHint = place => place?.kind === 'branch' ? `This repo on branch ${place.branch}.` : place?.kind === 'here' ? 'This checkout, as it is.' : 'A copy of this repo on a new branch.';
const PLACE_LABEL = { worktree: 'New worktree', branch: 'Branch', here: 'Here' };
const READ_ONLY_PEERS = 'Teammate questions stay read-only.';
const SCHEDULE_CAP = 'Schedules run with Approve for me at most.';
const placeText = place => place?.kind === 'branch' ? `Branch ${place.branch}` : PLACE_LABEL[place?.kind] ?? PLACE_LABEL.worktree;
const expandHome = value => { const text = String(value ?? '').trim(); return text === '~' ? os.homedir() : text.startsWith('~/') ? path.join(os.homedir(), text.slice(2)) : text; };
const shortHome = value => { const home = os.homedir(); return value === home ? '~' : value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value; };
// A bot runs under the role bot:name; the owner reads @name.
const roleLabel = role => botOfKey(role) ? `@${botOfKey(role)}` : role;
// A bot's scheduled turn runs with Approve for me at most, whatever its session's mode.
const scheduledTurn = (task, role) => { const bot = botOfKey(role); return Boolean(bot) && (task.messages ?? []).findLast(row => row.to === `@${bot}`)?.scheduled === true; };
// Whether what this role asks in this session can be given Full access: the owner's own
// session, for the model or a bot of its chat. Never a teammate's question, a session from
// before modes, another role, or a bot's scheduled turn.
const fullAllowed = (task, role) => Boolean(task) && !isPeerRun(task.origin) && MODES.includes(task.permissions) && (!role || role === 'lead' || Boolean(botOfKey(role))) && !scheduledTurn(task, role);
// The mode the turn in progress started with: the session's before the first switch made
// since the turn began.
function turnMode(task) {
  const times = [task.activeSince, (task.messages ?? []).findLast(row => !row.from)?.at].map(value => Date.parse(value ?? '')).filter(Number.isFinite);
  const first = times.length ? (task.permissionChanges ?? []).find(row => Date.parse(row.at) > Math.max(...times)) : null;
  return first ? first.from : task.permissions ?? null;
}
// Who wrote a waiting request: you, or the teammate whose message it is.
const requester = row => row.origin ? peerName(row.origin.name, row.origin.peer) : 'You';
// A saved request as it was typed: one written to a bot starts with its @name again.
const typedGoal = row => row.bot ? `@${row.bot} ${row.goal}` : row.goal;
// A path as the Blocked line shows it: inside the session's folder, from there; else from ~.
function shortPath(value, cwd) {
  const file = String(value ?? ''); if (!file) return '';
  const full = cwd ? path.resolve(cwd, file) : file, inside = cwd && (full === cwd || full.startsWith(`${cwd}/`));
  const shown = inside ? path.relative(cwd, full) || '.' : shortHome(full);
  return shown.length > 70 ? `…${shown.slice(-69)}` : shown;
}
// What a denied action was, for the Blocked line: "Edit src/app.ts". cwd: the session's folder.
function blockedText(denial, cwd = null) {
  const tool = String(denial?.tool ?? denial?.tool_name ?? ''), input = denial?.input ?? denial?.tool_input ?? {}, field = name => typeof input?.[name] === 'string' ? input[name] : '';
  const command = () => { const line = field('command').replace(/\s+/g, ' ').trim(); return line.length > 80 ? `${line.slice(0, 79)}…` : line; };
  const text = denial?.network ? `Connect to ${denial.network}` : typeof denial?.readonly === 'string' ? denial.readonly ? `Write ${shortPath(denial.readonly, cwd)}` : `Run ${command()}`
    : denial?.summary ? String(denial.summary) : tool === 'Bash' ? `Run ${command()}` : ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) ? `Edit ${shortPath(field('file_path') || field('notebook_path'), cwd)}` : tool === 'Read' && field('file_path') ? `Read ${shortPath(field('file_path'), cwd)}` : tool === 'WebFetch' ? `Open ${field('url')}` : tool === 'WebSearch' ? 'Search the web' : `Use ${tool || 'a tool'}`;
  return plain(text).replace(/\s+/g, ' ').trim().slice(0, 160);
}
const waitText = seconds => seconds >= 120 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`;
// One Blocked line: what was refused, why, and the one thing to do, with commands that exist
// here. kind is why (lib/never-list.mjs whyBlocked); a raised mode that lifts it continues the
// turn (setMode). run: the run that was refused; asked: its approvals; full: whether this
// session may have Full access.
function blockedLine(denial, run, asked = [], { cwd = null, full = true } = {}) {
  // The mode the turn really ran in: one asked for Approve for me may have run in Ask for approval.
  const what = blockedText(denial, cwd), mode = MODES.includes(run?.effectivePermissions) ? run.effectivePermissions : run?.permissions ?? null, why = whyBlocked(denial, { mode, vendor: run?.vendor ?? null, asked });
  const toFull = full ? '/permissions full continues it.' : 'this session cannot have Full access, so do it yourself.';
  if (why.kind === 'never') { const line = plain(why.line).replace(/\s+/g, ' ').trim(); return { kind: why.kind, text: `Blocked: ${neverSentence(why.command)}${line === why.command ? '' : ` (${why.alone ? '' : 'part of: '}${clip(line, 120)})`}. Run it yourself.` }; }
  const text = {
    secret: `Blocked: ${what}. Files that may hold secrets stay closed: open it yourself.`,
    own: `Blocked: ${what}. ELU Code's own files stay closed in every mode.`,
    timeout: `Stopped: ${what}. No answer in ${waitText(why.wait ?? APPROVAL_WAIT_SECONDS)}; reply to try again.`,
    owner: `Stopped: ${what}. You said no; reply with what to do instead.`,
    network: `Blocked: ${what}. The internet is off for commands in ${LABELS[mode] ?? LABELS.locked}: ${toFull}`,
    full: `Blocked: ${what}. Needs Full access: ${toFull}`,
    ask: `Blocked: ${what}. This session is read only: /permissions ask continues it.`,
    reviewer: `Blocked: ${what}. Approve for me's reviewer said no: /permissions ask lets you decide.`,
    git: `Blocked: ${denial?.tool === 'Bash' ? blockedText({ tool: 'Bash', input: denial.input }) : what}. ELU Code commits the changes when you publish: /publish.`,
    rule: `Blocked: ${what}. A rule no mode lifts refused it.`,
  }[why.kind];
  return { kind: why.kind, text };
}
// Absolute paths in a trusted teammate's message that exist on this machine, as the folders
// the lead may read: a file offers its folder. Paths that fail the folder
// check are left out.
export function foldersNamed(text) {
  const out = [];
  for (const match of String(text ?? '').matchAll(/(?<![\w:/.~-])(?:~|\/[\w.@+-]+)(?:\/[\w.@+-]+)+\/?/g)) {
    const value = expandHome(match[0].replace(/\/$/, ''));
    let dir; try { dir = fs.statSync(value).isDirectory() ? value : path.dirname(value); } catch { continue; }
    try { for (const folder of checkFolders([dir])) if (!out.includes(folder)) out.push(folder); } catch { /* Not a folder the lead may read. */ }
  }
  return out.slice(0, 8);
}

// A list's letter keys also answer with Shift held (Caps Lock, Y for y).
const withShift = keys => keys.flatMap(key => /^[a-z]$/.test(key) ? [key, `S-${key}`] : [key]);
function bindInput(field, screen) {
  // blessed hands the terminal to $EDITOR on e (field focused but not reading), Ctrl-E and a
  // right-click. ELU Code never does: those start typing in place instead.
  field.readEditor = function() { return this.readInput(); };
  // A field owns exactly one listener while focused. The library's deferred
  // listener registration can attach stale handlers after rapid view changes.
  field.readInput = function(callback) {
    if (this._reading || this.destroyed) return;
    this._reading = true;
    if (screen.focused !== this) this.focus();
    screen.grabKeys = true; this._updateCursor(); screen.program.showCursor();
    const listener = (ch, key) => this._listener(ch, key);
    const finish = (error, value) => {
      if (!this._reading || this._done !== finish) return;
      this._reading = false; this.removeListener('keypress', listener); this.removeListener('blur', blur);
      delete this.__listener; delete this.__done; delete this._done;
      screen.grabKeys = false; screen.program.hideCursor();
      if (error === 'stop') return;
      if (error) this.emit('error', error);
      else this.emit(value == null ? 'cancel' : 'submit', value);
      this.emit('action', value); callback?.(error, value);
    };
    // A click on the focused field makes blessed focus it again, which blurs it in place; only
    // focus moving elsewhere ends the reading.
    const blur = () => { if (screen.focused !== this) finish(null, null); };
    this._done = finish; this.__listener = listener; this.__done = blur;
    this.on('keypress', listener); this.on('blur', blur);
  };
}

// Six tabs. Sessions lists every session across projects on the left and
// shows the selected one's chat on the right. + New session shows the same chat empty, with
// the project, its model and its bots above the box. Projects lists every project. Kanban holds the
// open project's tasks in four columns. Chats holds channels and direct messages, each with
// its threads. Bots lists the saved bots. Usage shows the vendor accounts and their plan usage.
// usage: where the Usage tab reads from ({ env, readFile, vendors }); tests pass a temp home
// and fixed vendor rows.
export async function launchTerminal({ repo, startDirectory = process.cwd(), input = process.stdin, output = process.stdout, refreshMs = 350, onRender, startConductor = launchConductor, peer, team: teamStart = false, askProject = false, clipboard = null, loginItem = { install: installScheduler, uninstall: uninstallScheduler }, usage = {} } = {}) {
  if (!input.isTTY || !output.isTTY) throw new Error('Open ELU Code in a terminal, or use --json for a snapshot.');
  const facade = peer === undefined ? await loadPeer() : peer;
  const colour = process.env.NO_COLOR === undefined;
  const shade = name => colour ? PALETTE[name] : 'default';
  const accent = shade('orange'), muted = shade('muted');
  const screen = blessed.screen({ input, output, terminal: process.env.TERM || 'xterm', smartCSR: true, fullUnicode: true, title: 'ELU Code', warnings: false, autoPadding: false, dockBorders: false, ignoreLocked: ['C-c', 'tab', 'S-tab'] });
  blessed.box({ parent: screen, top: 0, left: 0, width: '100%', height: '100%', style: { bg: shade('background') } });
  const box = options => blessed.box({ parent: screen, border: 'line', tags: false, style: { fg: shade('text'), bg: shade('panel'), border: { fg: shade('border') }, label: { fg: muted, bold: true } }, ...options });
  // Lists highlight their selected row in full only while focused; the row keeps its own colours.
  const selection = { fg: shade('text'), bg: shade('highlight'), inverse: !colour, bold: true, underline: false };
  const QUIET = { fg: shade('text'), bg: shade('raised'), inverse: false, bold: false, underline: !colour };
  const pane = (parent, options = {}) => blessed.list({ parent, top: 1, left: 1, width: '100%-2', height: '100%-2', keys: true, mouse: true, vi: false, tags: true, invertSelected: false, style: { fg: shade('text'), bg: shade('panel'), selected: { ...selection } }, scrollbar: { ch: '┃', style: { fg: shade('dim') } }, ...options });
  const button = (top, content) => blessed.button({ parent: screen, top, height: 1, mouse: true, keys: true, tags: false, content, style: { fg: muted, bg: shade('raised') } });
  // Row 0: the brand (the open project's name, else ELU Code), the six tabs, and live status.
  blessed.box({ parent: screen, top: 0, left: 0, width: '100%', height: 1, style: { bg: shade('raised') } });
  const BRAND = ' ◆ ELU Code ';
  const brand = blessed.text({ parent: screen, top: 0, left: 0, width: BRAND.length, height: 1, tags: false, content: BRAND, style: { fg: accent, bg: shade('raised'), bold: true } });
  const pills = blessed.text({ parent: screen, top: 0, height: 1, tags: true, style: { fg: muted, bg: shade('raised') } });
  const tabs = [['Sessions', 'tasks'], ['Projects', 'projects'], ['Kanban', 'kanban'], ['Chats', 'chats'], ['Bots', 'bots'], ['Usage', 'usage']].map(([name, viewName]) => Object.assign(button(0, ` ${name} `), { viewName }));
  // Row 1: what the view offers. Projects: + New project. Bots: + New bot. A session opened from Kanban: the way back.
  const newBot = button(1, ' + New bot ');
  const newProject = button(1, ' + New project ');
  const back = button(1, ' ‹ Kanban ');
  const header = blessed.text({ parent: screen, top: 1, height: 1, tags: true, style: { fg: shade('text'), bg: shade('background') } });
  // Sessions: + New session, then needs you, running, queued and recent, across every project.
  const boardBox = box({});
  const board = pane(boardBox, { keys: false });
  // Chats: the bar of channels and direct messages beside the open one's threads.
  const teamBoxes = [' Team ', ' Threads '].map(label => box({ label, hidden: true }));
  const teamLists = teamBoxes.map(parent => pane(parent));
  // Over a channel's threads: who is in it. It stays in place while the threads scroll.
  const chatMembers = blessed.text({ parent: teamBoxes[1], top: 1, left: 1, width: '100%-3', height: 1, tags: true, hidden: true, style: { fg: muted, bg: shade('panel') } });
  const teamOff = box({ hidden: true, label: ' Chats ', padding: { left: 1 } });
  // Kanban: the open project's tasks in four columns.
  const kanbanBoxes = COLUMNS.map(([, name]) => box({ label: ` ${name} `, hidden: true }));
  const kanbanLists = kanbanBoxes.map(parent => pane(parent));
  const kanbanOff = box({ hidden: true, label: ' Kanban ', padding: { left: 1 } });
  // Teammates' Tasks in this project, under the four columns. Nothing in it can be changed here.
  const kanbanTeam = box({ hidden: true, label: ' Teammates ', padding: { left: 1 } });
  const kanbanTeamList = pane(kanbanTeam, { keys: false });
  let teamTaskRows = [], teamTasks = { at: 0, root: null, people: [], sharing: 'none' };
  const newCard = button(1, ' + New task ');
  // Bots: one list of the saved bots.
  const botsBox = box({ label: ' Bots ', hidden: true });
  const botsList = pane(botsBox);
  // Projects: one list of every project. Usage: one list of the accounts and their plan usage.
  const projectsBox = box({ label: ' Projects ', hidden: true });
  const projectsList = pane(projectsBox);
  const usageBox = box({ label: ' Usage ', hidden: true });
  const usageList = pane(usageBox);
  // A task's chat, or the New task form when no task is open.
  const activity = box({ tags: true, scrollable: true, alwaysScroll: true, mouse: true, keys: true, padding: { left: 2, right: 2 }, scrollbar: { ch: '┃', style: { fg: shade('dim') } } });
  // What the open session changed, in the chat's place. Only the rows in view are drawn, so a
  // long diff costs no more than a short one. A row is never wrapped: it already fits.
  const changesBox = box({ tags: true, wrap: false, hidden: true });
  // The switch between the two, on the top border of whichever shows: Chat   Changes 3.
  const sessionTabs = blessed.text({ parent: screen, height: 1, tags: true, hidden: true, autoFocus: false, style: { fg: muted } });
  const compose = box({ label: ' New session ', hidden: true });
  const composeList = pane(compose, { height: '100%-5' });
  const composeHint = blessed.text({ parent: compose, bottom: 1, left: 2, width: '100%-4', height: 2, tags: true, style: { fg: muted, bg: shade('panel') } });
  const status = blessed.text({ parent: screen, height: 1, tags: true, style: { fg: muted, bg: shade('background') } });
  // The message box wraps over four lines. Enter sends; newlines inside a paste are kept.
  const ask = blessed.textarea({ parent: screen, border: 'line', label: ' Message ', inputOnFocus: false, keys: true, mouse: true, tags: false, padding: { left: 1, right: 1 }, style: { fg: shade('text'), bg: shade('raised'), border: { fg: accent }, label: { fg: accent, bold: true } } });
  // Its label names the session's bots, each in its own colour, so the label alone reads tags.
  ask._label.parseTags = true;
  bindInput(ask, screen); editable(ask);
  ask.submit = function() { return this.__listener?.('\r', { name: 'enter' }); };
  const keysBar = blessed.text({ parent: screen, height: 1, tags: true, style: { fg: muted, bg: shade('background') } });
  const palette = blessed.list({ parent: screen, hidden: true, border: 'line', label: ' Commands: arrows / Tab / Enter ', tags: false, keys: false, mouse: true, style: { fg: shade('text'), bg: shade('raised'), border: { fg: accent }, selected: { fg: shade('background'), bg: accent, inverse: !colour, bold: true } }, scrollbar: { ch: '┃' } });
  const sizeNotice = box({ top: 0, left: 0, width: '100%', height: '100%', hidden: true, content: 'ELU Code\nResize to at least 80 columns by 24 rows.\nCtrl-C quits.' });
  let claim = { readOnly: true, release() {} }; let controller; let snapshot; let modal = null; let closing = false; let selectedId = null; let selectedRequest = null; let message = ''; let busy = false; let usageEnabled = false; let kanbanData = COLUMNS.map(([column, name]) => ({ column, name, items: [] })), returnTo = 'tasks'; let paletteDismissed = null; let paletteValues = []; let paletteText = null; let composeWhen = null; let following = null; let drawing = false; let pendingDraw = null;
  let view = teamStart ? 'chats' : 'tasks';
  // Sessions: the row the cursor is on (NEW is + New session), the row the right side was
  // last shown for, and the open session's own row as of the last draw.
  const NEW = 'new'; let barKey = NEW, barAt = 0, openKey = null, ownSeen = null, wanted = null, opening = false, dash = null, sided = null;
  let shellRun = null, shellTyped = false, chatTarget = null, chatOpen = null, chatJump = null, boardLines = [], composeRows = [], teamRows = [[], []], projectRows = [], botRows = [], botJump = null, teamOn = false, peerData = { on: false }, lastPane = { chats: null, kanban: null };
  // The Usage tab: its rows (one vendor each), the data behind them, whether a check is running.
  let usageRows = [], usageData = null, usageKey = null, usageBusy = false; const usageAbort = new AbortController();
  // The new session's permissions: mode, where it works, extra folders. Approvals are the lead's live requests.
  let composeMode = null, composePlace = { kind: 'worktree' }, composeFolders = [], approvals = [];
  // The approvals the terminal bell already rang for (ringFor).
  const rung = new Set();
  // The bots a new session starts with (/bots add in the form), and the saved bots, read at
  // most once a second: the key bar and the @ list ask on every draw.
  let composeBots = [], botCache = { at: 0, rows: [] };
  // Archived sessions are left out of the list until /archived, or a click on the line that
  // counts them, asks for them.
  let showArchived = false;
  const toggleArchived = () => { showArchived = !showArchived; setMessage(showArchived ? 'Archived sessions are listed last. /archived hides them again.' : 'Archived sessions are hidden.'); };
  // The chat follows its newest line while its end is in view. Once the owner scrolls up it
  // stays on the lines he chose, through every redraw and whatever arrives below, until he
  // is back at the end or another chat opens. chatShown names the chat the pane last drew.
  let chatShown = null;
  const scrolledUp = pane => { const at = pane.getScrollPerc(true); return at >= 0 && at < 100; };
  const savedBots = () => { if (Date.now() - botCache.at > 1000) { let rows = []; try { rows = listBots(); } catch { /* An unreadable file offers none. */ } botCache = { at: Date.now(), rows }; } return botCache.rows; };
  // The colour a bot shows in, by its name: one that is no longer saved still has one. You
  // are blue and the session's model is orange; a bot is never plain.
  const toneOfBot = name => botColor(savedBots().find(bot => bot.name === name) ?? { name });
  // "@reviewer @elu +2" with each name in its bot's colour; the other words in rest.
  const paintBots = (text, rest = null) => text.split(' ').map(word => word.startsWith('@') ? ink(word, toneOfBot(word.slice(1)), colour, true) : ink(word, rest, colour, Boolean(rest))).join(' ');
  // The bots a new session starts with, and the ones of a session saved without a list: what
  // sessionBots gives a session with no list. Read at most once a second, like the saved
  // bots, because labels ask on every draw. A session's own list, even an empty one, stands.
  let firstCache = { at: 0, rows: [] };
  const firstBots = () => { if (Date.now() - firstCache.at > 1000) { let rows = []; try { rows = sessionBots(null); } catch { /* An unreadable file gives none. */ } firstCache = { at: Date.now(), rows }; } return firstCache.rows; };
  const botsOf = task => Array.isArray(task?.bots) ? task.bots : firstBots();
  // Who a message with no @name goes to in a session: the bot the owner last wrote to there,
  // while it is still in the session's chat, else null for the session's model. A message of
  // theirs that still waits counts as written. @model writes to the model whoever came last.
  const TO_MODEL = /^@model(?=\s|$)/i;
  function addressedBot(task, rows) {
    if (!task || fromTeammate(task.origin)) return null;
    const waits = rows.filter(row => row.continuationTaskId === task.id && ['queued', 'starting'].includes(row.state) && !row.scheduled && !row.origin)
      .sort((a, b) => Date.parse(a.queuedAt ?? a.createdAt) - Date.parse(b.queuedAt ?? b.createdAt)).at(-1);
    const last = waits ? waits.bot ?? null : (task.messages ?? []).findLast(row => !row.bot && !row.from && !row.scheduled)?.to?.replace(/^@/, '') ?? null;
    return last && botsOf(task).includes(last) && savedBots().some(bot => bot.name === last) ? last : null;
  }
  composeBots = firstBots();
  // The new session's model, { vendor, model }: null is the project's default. botTyped is
  // the saved bot the message box's text is written to, so the label is drawn again when it changes.
  let composeModel = null, botTyped = null, personTyped = null, modelTyped = false, reported = { at: 0, root: null, rows: [] };
  // The models earlier runs of the open project reported, so a model chosen by a short name
  // is shown by its full one. Read at most every two seconds: labels ask on every draw.
  const knownModels = () => {
    const root = controller?.repo.root ?? null;
    if (root !== reported.root || Date.now() - reported.at > 2000) { let rows = []; try { rows = controller ? reportedModels(controller.snapshot().tasks) : []; } catch { /* Shown by the chosen name. */ } reported = { at: Date.now(), root, rows }; }
    return reported.rows;
  };
  const nameOf = choice => modelLabel(choice, knownModels());
  // A bot's model by name, for its page and its row: the name a session shows that model
  // by. A bot that names no model runs on its vendor's own, so it is the model the bot's
  // latest run in the open project reported, and null before one did.
  let botRan = { at: 0, root: null, rows: new Map() };
  const botModelName = bot => {
    if (bot.model) return nameOf({ vendor: bot.vendor, model: bot.model });
    const root = controller?.repo.root ?? null;
    if (root !== botRan.root || Date.now() - botRan.at > 2000) {
      const rows = new Map();
      try {
        for (const task of controller ? controller.snapshot().tasks : []) for (const run of task.runs ?? []) {
          const key = `${botOfKey(run.role)}\0${run.vendor}`;
          if (botOfKey(run.role) && run.model && !(String(rows.get(key)?.at ?? '') > String(run.at))) rows.set(key, run);
        }
      } catch { /* The row says who picks the model. */ }
      botRan = { at: Date.now(), root, rows };
    }
    return modelName(botRan.rows.get(`${bot.name}\0${bot.vendor}`)?.model);
  };
  // The model a session's next message goes to, named as its chat titles name it.
  const modelOf = task => modelLabel(sessionModel(controller.repo, task) ?? controller.defaultModel(), [...knownModels(), ...reportedModels([task])]);
  const drafts = new Map();
  const draftKey = () => controller ? `${controller.repo.root}\0${selectedId ?? 'new'}` : null;
  function rememberDraft() { if (controller && view === 'chat' && !ask.getValue().trimStart().startsWith('/')) drafts.set(draftKey(), ask.getValue()); }
  function restoreDraft() { if (controller && view === 'chat') ask.setValue(drafts.get(draftKey()) ?? ''); }
  let resolveDone, rejectDone; const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const setMessage = value => { message = plain(value); draw(); };
  const chatWidth = () => Math.max(20, (typeof activity.width === 'number' ? activity.width : screen.width) - activity.iwidth - 1);
  // Drag selects and copies on release; a click in the message box moves its cursor.
  // Tests pass their own clipboard; without one a test copies nothing.
  const copyText = clipboard ?? (process.env.NODE_TEST_CONTEXT ? null : systemClipboard({ write: data => screen.program._write(data) }));
  const copied = text => setMessage(`Copied ${text.length.toLocaleString('en-US')} character${text.length === 1 ? '' : 's'}.`);
  // The bar drawn at the left of a message is not part of its text, so a copy leaves it out.
  const mouseSelection = attachSelection(screen, { copy: copyText, onCopy: copied, clean: row => row.replace(/^\s*┃ ?/, '') });
  ask.selection = () => { const range = mouseSelection.range(); return range?.el === ask ? range : null; };
  // A paste goes into the box being typed in, whole; a single-line box takes it on one line.
  attachPaste(screen, text => {
    const field = screen.focused; if (!field?._reading) return;
    const value = pastedText(text);
    if (value) field._listener(field.type === 'textbox' ? value.replace(/\n/g, ' ') : value, { name: 'paste', sequence: value });
  });
  // Last, so it feeds every reader of the input: each mouse report reaches them on its own.
  attachReports(screen);
  const catchAction = fn => Promise.resolve().then(fn).catch(error => setMessage(error.message));
  const busyHere = () => Boolean(controller?.snapshot().tasks.some(task => ['running', 'preparing'].includes(task.state)));
  const conduct = () => { try { startConductor(); } catch (error) { setMessage(`The conductor could not start: ${error.message}`); } };
  // y approves the Task that waits in a session and starts its work; n rejects it (lib/plan.mjs).
  // The work starts as a message of its own, so it waits its turn like any other.
  const taskWaits = row => row?.kind === 'task' && row.task?.plan?.state === 'proposed';
  function decideTask(root, task, yes) {
    if (['running', 'preparing'].includes(task.state)) throw new Error('This session is working. Answer its Task when it stops.');
    const repo = projectFolder(root);
    if (!yes) { rejectTask(repo, task.id); setMessage('Task rejected. Nothing was changed.'); return; }
    const plan = approveTask(repo, task.id);
    enqueue(root, `Approved the Task: ${plan.title}`, { continuationTaskId: task.id, priority: 0, approved: true }); conduct();
    // Said so that it stays true once the turn has ended: the line stays up until a key clears it.
    setMessage('Task approved.');
  }
  // Bots that have a schedule run by themselves in the sessions they are in. The login item
  // is asked for when one is first on, so they also run while ELU Code is closed.
  const tickBots = () => runBotSchedules(new Date(), { start: conduct, install: loginItem.install });
  const composing = () => view === 'chat' && !selectedId && !selectedRequest && !following;
  // The Sessions tab: the list on the left; a session, the new session form or a row's text
  // on the right. A session opened from Kanban fills the screen instead.
  const listed = () => view === 'tasks' || view === 'chat' && returnTo === 'tasks';
  // The conductor may give a folder its first Git history; this view then follows it.
  function adoptHistory() {
    if (!controller || controller.repo.common || !fs.existsSync(path.join(controller.repo.root, '.git'))) return;
    const next = projectFolder(controller.repo.root); if (!next.common) return;
    controller.repo = next; repo = next; claim.attach?.(next); if (view === 'chat') snapshot = controller.snapshot();
  }
  // A request the conductor has started is its session from then on. The screen learns that
  // at its next draw, so whatever is sent before that draw asks here first: a message saved
  // over the request would start a second session, and /stop would cancel the request of a
  // session that is working.
  function openStarted() {
    if (!selectedRequest || !controller) return null;
    let row; try { row = pendingRequests(controller.repo.root).find(value => value.id === selectedRequest.id) ?? null; } catch { return null; }
    if (row?.taskId) { selectedId = row.taskId; selectedRequest = null; }
    return row;
  }
  // Follows a sent message until the conductor starts it, then shows its chat.
  function follow() {
    if (!following || !controller || controller.repo.root !== following.root) { following = null; return; }
    let row; try { row = pendingRequests(following.root).find(value => value.id === following.id); } catch { return; }
    if (!row) { following = null; return; }
    if (row.taskId && selectedRequest?.id === row.id) { selectedId = row.taskId; selectedRequest = null; }
    if (row.state === 'done') {
      const asked = following.bot; following = null;
      const task = controller.snapshot().tasks.find(value => value.id === row.taskId), reply = asked ? (task?.messages ?? []).findLast(value => value.bot === asked) : null;
      if (task && view === 'chat') message = plain(reply ? reply.failed ? `@${asked}: ${reply.text}` : `@${asked} answered` : task.state === 'answered' ? `${modelOf(task)} answered` : task.state === 'ready' ? 'ready | /publish to review push' : task.state === 'needs_input' ? 'Waiting for your answer' : task.error?.message ?? task.state);
    } else if (row.state === 'blocked') {
      following = null;
      if (!selectedId || selectedId === row.continuationTaskId || selectedRequest?.id === row.id) { selectedRequest = row; if (!ask.getValue()) ask.setValue(typedGoal(row)); }
      message = plain(`Request blocked: ${row.reason} Text saved; Enter restores it.`);
    }
  }
  // Sessions. A line of the list is + New session, a heading, or a row; only the first and the last take the cursor.
  const lineKey = line => line?.add ? NEW : line?.row?.key ?? null;
  // The session a row shows beside the list: a session's chat, a request of yours with the
  // chat it continues, or the session an approval waits in. Any other row shows its own text.
  function sessionOf(row) {
    if (row.kind === 'task') return { root: row.root, id: row.id, request: null };
    if (row.kind === 'request' && !peerIncoming(row)) return { root: row.root, id: row.request.continuationTaskId ?? null, request: row.request };
    if (row.kind === 'approval' && dash?.projects.some(project => project.root === row.root && project.tasks?.some(task => task.id === String(row.id)))) return { root: row.root, id: String(row.id), request: null };
    return null;
  }
  // The row that stands for what is open on the right, or null when a row's own text shows.
  function ownKey() {
    if (view !== 'chat' || returnTo !== 'tasks' || !controller) return null;
    const root = controller.repo.root;
    return selectedId ? `${root}\0task\0${selectedId}` : selectedRequest ? `${root}\0request\0${selectedRequest.id}` : following ? `${root}\0request\0${following.id}` : NEW;
  }
  // The cursor moved to another row by a key or the mouse.
  function pointBar(key) { if (key && key !== barKey) { barKey = key; wanted = null; message = ''; } }
  // A new session starts with the default mode, a new worktree, the project's model, its first bots, and no schedule or extra folders.
  function resetForm() { composeWhen = null; composeMode = defaultMode(); composePlace = { kind: 'worktree' }; composeFolders = []; composeBots = firstBots(); composeModel = null; }
  // The new session form. fresh: n, + or /new asked for it, so it starts over. Moving the
  // cursor back to + New session keeps what the form was set to.
  function showForm(fresh = true) {
    rememberDraft(); view = 'chat'; selectedId = null; selectedRequest = null; following = null;
    if (fresh) resetForm();
    restoreDraft();
  }
  // A session's chat. A request still in the queue is followed into its session when the
  // conductor starts it. opened: Enter was pressed, so a blocked or saved request of yours
  // comes back into the message box.
  function showSession({ id = null, request = null }, opened = false) {
    view = 'chat'; selectedId = id; selectedRequest = request; restoreDraft();
    following = request && ['queued', 'starting'].includes(request.state) ? { root: controller.repo.root, id: request.id, bot: request.bot ?? null } : null;
    if (opened && request && ['blocked', 'waiting'].includes(request.state) && !request.origin && !ask.getValue()) { ask.setValue(typedGoal(request)); message = 'Saved request restored. Send to retry.'; }
  }
  // What the cursor's row shows on the right, without moving focus: the new session form, a
  // session, or the row's own text. The box under a row that is not a session starts a new
  // one, so it keeps the new session's draft.
  function showLine(line, session) {
    const typed = ask.getValue(), fresh = controller ? `${controller.repo.root}\0new` : null;
    if (view === 'tasks' && fresh && !typed.trimStart().startsWith('/')) drafts.set(fresh, typed);
    returnTo = 'tasks';
    if (line.add && controller) showForm(false);
    else if (session && controller) { rememberDraft(); showSession(session); }
    else { rememberDraft(); if (view === 'chat') ask.setValue(drafts.get(fresh) ?? ''); view = 'tasks'; selectedRequest = null; following = null; }
  }
  // The bots on a schedule in each listed session, by project root then session, read again
  // every two seconds: the list and the open session's title line show them. A session
  // opened from the Kanban tab has no list behind it: its own project is read then.
  let timedAt = 0, timedShown = {};
  function timedSessions(now = Date.now()) {
    if (now - timedAt < 2000) return timedShown;
    timedAt = now; timedShown = {};
    for (const project of dash?.projects ?? (snapshot?.tasks ? [snapshot] : [])) {
      if (project.unavailable || !project.tasks?.length) continue;
      try { const shown = botSchedulesShown(projectFolder(project.root), project.tasks, new Date(now)); if (Object.keys(shown).length) timedShown[project.root] = shown; } catch { /* A project that cannot be read shows no schedule. */ }
    }
    return timedShown;
  }
  // Builds the list, keeps the cursor on its row while rows move between groups, and shows
  // that row on the right. A new message elsewhere never moves either of them.
  function syncSessions(now) {
    // Peer threads that wait for nothing live in Chats; asks, replies and drafts for you stay here.
    const rows = boardRows(dash.projects, now, { items: peerData.items, online: onlineKeys(peerData.status), recent: WEEK, schedules: listSchedules(), approvals, archived: showArchived, timed: timedSessions(now), remote: remoteApp.rows(now) }).filter(row => row.kind !== 'peer' || peerDecision(row));
    const before = boardLines.findIndex(line => lineKey(line) === barKey), at = before < 0 ? barAt : before;
    boardLines = [{ add: true }, { spacer: true }, ...(rows.length ? boardSections(rows) : [{ note: dash.projects.length ? 'No sessions yet.' : 'No project yet.' }])];
    // The archive is out of the way, and one line says it is there.
    const stored = dash.projects.reduce((count, project) => count + (project.closed?.length ?? 0), 0);
    // It sits on the last row of the pane; in a list longer than the pane it is the last line.
    if (stored) boardLines.push(...Array.from({ length: Math.max(1, (typeof board.height === 'number' ? board.height : 0) - boardLines.length - 1) }, () => ({ spacer: true })), { note: showArchived ? 'Hide archived · /archived' : `${stored} archived · /archived`, archive: true });
    const find = key => boardLines.findIndex(line => lineKey(line) === key), has = key => find(key) >= 0;
    const after = boardLines.findIndex((line, place) => place >= at && lineKey(line)), near = after >= 0 ? after : boardLines.findLastIndex(lineKey);
    // The right side changed by itself (a sent message became a session, /new opened the form): the cursor follows it.
    // A message sent from the form used its settings up, and so did leaving the tab.
    const own = ownKey();
    if (own !== ownSeen) { if (ownSeen === NEW) resetForm(); ownSeen = own; wanted = own; }
    if (wanted && has(wanted)) { barKey = openKey = wanted; wanted = null; }
    // The cursor's row left the list: the open session's own row takes it, else the nearest row.
    if (!has(barKey)) {
      if (own && has(own)) barKey = openKey = own;
      else if (!wanted) barKey = lineKey(boardLines[near]);
    }
    if (barKey !== openKey && !opening && has(barKey)) {
      const key = barKey, line = boardLines[find(key)], session = line.row ? sessionOf(line.row) : null;
      wanted = null;
      if (session && session.root !== controller?.repo.root) {
        // A session of another project: that project becomes the active one first.
        opening = true;
        catchAction(async () => {
          try { await switchProject(projectFolder(session.root)); if (barKey === key && listed()) showLine(line, session); }
          finally { opening = false; openKey = key; ownSeen = ownKey(); resize(); }
        });
      } else { try { showLine(line, session); } finally { openKey = key; ownSeen = ownKey(); } }
    }
    // While a sent message waits for its session's row, the cursor rests on the nearest row.
    barAt = has(barKey) ? find(barKey) : near;
  }
  function activateProject(location) {
    const nextClaim = claimView(location); let nextController, nextSnapshot;
    try { nextController = new ProjectController(location, { readOnly: nextClaim.readOnly, onRepository: value => { repo = value; nextClaim.attach(value); } }); nextSnapshot = nextController.snapshot(); }
    catch (error) { nextClaim.release(); throw error; }
    repo = location; claim = nextClaim; controller = nextController; snapshot = nextSnapshot; vendorList.forget();
    if (!claim.readOnly) registerProject(repo);
    selectedId = null; selectedRequest = null; message = '';
    usageEnabled = snapshot.initialized && !claim.readOnly;
    if (usageEnabled) controller.refreshUsage().then(draw);
    if (!claim.readOnly) setImmediate(() => catchAction(() => reviewProjectFiles(location.root)));
  }
  function minimumSize() {
    const small = screen.width < 80 || screen.height < 24;
    sizeNotice.hidden = !small;
    if (small) sizeNotice.setFront();
    return small;
  }
  // Every project with a record, and the open one even when another view owns it.
  function allProjects(value = dashboardSnapshot()) {
    if (controller && !value.projects.some(project => project.root === controller.repo.root)) value.projects.unshift(controller.snapshot());
    return value;
  }
  function resize() {
    const g = geometry(screen.width, screen.height), W = g.width, top = g.top, bottom = g.statusTop, height = bottom - top;
    layoutSession(g);
    layoutChats(g);
    const third = Math.floor(W / 4);
    kanbanBoxes.forEach((frame, index) => Object.assign(frame, { top, left: index * third, width: index === 3 ? W - 3 * third : third, height }));
    Object.assign(kanbanOff, { top, left: 0, width: W, height: 3 });
    Object.assign(botsBox, { top, left: 0, width: W, height });
    Object.assign(projectsBox, { top, left: 0, width: W, height });
    Object.assign(usageBox, { top, left: 0, width: W, height });
    Object.assign(keysBar, { top: g.keysTop, left: 1, width: W - 2 });
    Object.assign(header, { width: Math.max(1, W - (header.left ?? 0) - 1) });
    if (modal) positionModal();
    draw();
  }
  // The bar of Sessions and of Chats: three tenths of the screen, 30 to 44 columns.
  const barWidth = width => Math.min(44, Math.max(30, Math.floor(width * 0.3)));
  // Sessions puts its list down the left side, with the session, the status row and the
  // message box in the rest. Every other view has them across the screen.
  function layoutSession(g) {
    const W = g.width, top = g.top, height = g.statusTop - top, bar = listed() ? barWidth(W) : 0; sided = bar > 0;
    Object.assign(boardBox, { top, left: 0, width: bar || W, height: g.keysTop - top });
    Object.assign(activity, { top, left: bar, width: W - bar, height });
    Object.assign(compose, { top, left: bar, width: W - bar, height });
    Object.assign(status, { top: g.statusTop, left: bar + 1, width: W - bar - 2, height: 1 });
    Object.assign(ask, { top: g.askTop, left: bar, width: W - bar, height: g.askHeight });
  }
  // Teammates beside threads from 100 columns, else above them.
  function layoutChats(g) {
    const W = g.width, top = g.top, height = g.statusTop - top, side = W >= 100, mates = side ? barWidth(W) : 0;
    const stacked = Math.max(4, Math.min(Math.floor(height / 2), teamRows[0].length + 2));
    Object.assign(teamBoxes[0], side ? { top, left: 0, width: mates, height } : { top, left: 0, width: W, height: stacked });
    Object.assign(teamBoxes[1], side ? { top, left: mates, width: W - mates, height } : { top: top + stacked, left: 0, width: W, height: height - stacked });
    Object.assign(teamOff, { top, left: 0, width: W, height: 3 });
  }
  // Everything the timer can change on screen. Other changes render through their own draw.
  let lastFrame = null;
  const watched = () => [header, brand, pills, status, keysBar, ...tabs, newCard, newBot, newProject, back, activity, changesBox, sessionTabs, boardBox, compose, composeHint, ask, teamOff, ...teamBoxes, chatMembers, kanbanOff, ...kanbanBoxes, kanbanTeam, botsBox, projectsBox, usageBox];
  const frame = () => [screen.width, screen.height, screen.focused?.uid, ...watched().map(panel => `${panel.content}\x01${panel._label?.content ?? ''}\x01${panel.style.fg}\x01${panel.style.bg}\x01${panel.style.bold}\x01${panel.style.underline}\x01${panel.style.inverse}\x01${panel.style.border?.fg}\x01${panel.hidden}\x01${panel.position.left}\x01${panel.position.top}\x01${panel.position.width}\x01${panel.position.height}`), ...[board, composeList, ...teamLists, ...kanbanLists, kanbanTeamList, botsList, projectsList, usageList].map(list => `${list.ritems?.join('\n')}\x01${list.selected}\x01${list.style.selected.bg}\x01${list.style.selected.inverse}`), palette.hidden, palette.ritems?.join('\n'), palette.selected, activity.childBase, modal?.uid].join('\x00');
  // Peer files are read at most once per draw, and only by the views that show them.
  // Whether this machine is on a team, read from the rosters at most every 2 s; /invite and
  // /join read it again at once (peerOnAt = 0).
  let peerOnValue = false, peerOnAt = 0;
  const peerOn = () => {
    if (Date.now() - peerOnAt < 2000) return peerOnValue;
    peerOnAt = Date.now(); try { peerOnValue = Boolean(facade) && facade.onTeam?.() === true; } catch { peerOnValue = false; }
    return peerOnValue;
  };
  const peerRead = (name, ...args) => { try { const value = facade?.[name]?.(...args); return value && typeof value === 'object' ? value : null; } catch { return null; } };
  const peerList = (name, ...args) => { const value = peerRead(name, ...args); return Array.isArray(value) ? value : []; };
  // Sessions on my other computers (lib/terminal-remote.mjs), and the one under the cursor in Sessions.
  const remoteApp = remoteSessions({ facade, peerRead, peerCommand: command => peerCommand(command), chatMessage, ink, colour, toneOfBot: name => toneOfBot(name) });
  const remoteHere = () => view === 'tasks' && listed() && boardLines[barAt]?.row?.kind === 'remote' ? boardLines[barAt].row : null;
  // Trust is my setting about a teammate, read from the peer policy file.
  const peerTrusted = key => { try { return typeof key === 'string' && (facade?.peerPolicy ?? savedPeerPolicy)(key)?.trusted === true; } catch { return false; } };
  const trustedKeys = status => [...new Set((status?.teams ?? []).flatMap(row => row?.members ?? []).map(member => member?.key).filter(key => typeof key === 'string' && key !== status?.key && peerTrusted(key)))];
  // A new approval, here or on another computer of mine, rings the terminal bell once,
  // whatever view is open: nothing else may wait twenty minutes unseen. keys: what waits now.
  function ringFor(keys) {
    const fresh = keys.filter(key => !rung.has(key));
    for (const key of fresh) rung.add(key);
    if (rung.size > 1000) for (const key of [...rung]) if (!keys.includes(key)) rung.delete(key);
    if (fresh.length) { try { screen.program.output.write('\x07'); } catch { /* No terminal to ring. */ } }
  }
  // The lead's live approvals, read once per draw; an unreadable folder shows none.
  const pendingNow = () => { try { return pendingApprovals(); } catch { return []; } };
  const approvalsFor = task => approvals.filter(row => String(row.taskId) === String(task.id) && (!row.root || row.root === controller?.repo.root));
  // The first approval a session's own row in the list waits on.
  const rowApproval = row => row?.kind === 'task' ? approvals.find(item => String(item.taskId) === String(row.id) && (!item.root || item.root === row.root)) ?? null : null;
  // Full access set while a turn asks reaches that turn through its approvals: the app
  // answers them for the owner, what waits now and what the turn asks next. Returns how
  // many it allowed. started: the mode the turn began with. Only a turn that began in Ask
  // for approval or Approve for me is answered: one that began in Full access asks only
  // what its vendor asks in every mode, and that stays the owner's, as does a removal, an
  // MCP tool and an action too long to read. The never list is not asked, so it is not
  // allowed here either.
  const allowForFull = (task, rows, started) => {
    let count = 0;
    if (task?.permissions === 'full' && task.state === 'running' && ['ask', 'auto'].includes(started)) for (const row of rows) { if (!fullAllowed(task, row.role) || ownersToAnswer(row)) continue; try { if (answerApproval(row.id, 'allow')) count++; } catch { /* It stays for the owner to answer. */ } }
    return count;
  };
  // The Blocked lines of a session's last lead turn, at most three, each saying what was
  // refused, why and the one thing to do. Shown while the session waits for the owner, and
  // for a never-list command whatever the turn went on to do.
  function blockedRows(task, lastLead = task?.runs?.findLast(run => run.role === 'lead')) {
    const refused = Array.isArray(lastLead?.denials) ? lastLead.denials.filter(denial => task.state === 'needs_input' || denial?.never) : [];
    if (!refused.length) return [];
    // The approvals of that turn: stamped with the id it was launched with, which a resumed turn reports as another.
    const ids = [lastLead.session, lastLead.launch].filter(Boolean), asked = (task.approvals ?? []).filter(row => row.role === 'lead' && ids.includes(row.session));
    return [...new Map(refused.map(denial => blockedLine(denial, lastLead, asked, { cwd: task.worktree ?? null, full: fullAllowed(task, 'lead') })).map(row => [row.text, row])).values()].slice(0, 3);
  }
  // Raising a session's mode after its last turn stopped on something the new mode lifts
  // continues that turn at once, with this message.
  const CONTINUE = mode => `Continue where you stopped: this session now has ${LABELS[mode]}. Try again what was blocked.`;
  const resumes = (task, mode) => task.state === 'needs_input' && PROFILES.indexOf(mode) > PROFILES.indexOf(MODES.includes(task.permissions) ? task.permissions : 'locked') && blockedRows(task).some(row => liftedBy(row.kind, mode));
  // Sets a session's mode and returns what the status line says. With no turn in progress
  // the mode holds from the next message, unless the last turn stopped on something the new
  // mode lifts: then it continues at once. A turn in progress keeps the mode its vendor
  // started with; Full access alone reaches it, through its approvals.
  // location and root: the project of a session the list shows from another project.
  function setMode(given, mode, { location = null, root = controller.repo.root } = {}) {
    const task = location ? given : controller.snapshot().tasks.find(row => row.id === given.id) ?? given, running = task.state === 'running';
    const capped = running && scheduledTurn(task, task.activeRole), was = running ? turnMode(task) : null, now = capped && MODES.includes(was) ? capMode(was, 'auto') : was;
    const goOn = !running && !['preparing'].includes(task.state) && resumes(task, mode);
    if (location) saveMode(location, String(task.id), mode); else controller.setPermissions(task.id, mode);
    if (goOn) { enqueue(root, CONTINUE(mode), { continuationTaskId: String(task.id), priority: 0 }); conduct(); return `${LABELS[mode]}. Continuing where it stopped.`; }
    if (!running || !MODES.includes(now)) return `${LABELS[mode]} from your next message.`;
    if (mode === now) return `${LABELS[mode]}.`;
    if (mode === 'full' && !capped) {
      const waiting = pendingNow().filter(row => String(row.taskId) === String(task.id) && (!row.root || row.root === root) && fullAllowed(task, row.role)), allowed = allowForFull({ ...task, permissions: mode }, waiting, was);
      return `${allowed ? 'Allowed. ' : ''}${waiting.some(ownersToAnswer) ? 'Full access. This turn still asks before rm, rmdir and MCP tools.' : 'Full access: this session no longer asks you.'}`;
    }
    return `${LABELS[mode]} from the next message; this turn ${now === 'ask' ? 'still asks' : `keeps ${LABELS[now]}`}.`;
  }
  // f beside y and n: allow what waits and give its session Full access, as /permissions
  // full does and after the same question. Offered only where Full access can be given and
  // is not the session's mode already; elsewhere the keys stay y and n.
  const offersFull = (task, approval) => Boolean(approval) && task?.permissions !== 'full' && fullAllowed(task, approval.role);
  const approvalKeys = (task, approval) => `y allow · n deny${offersFull(task, approval) ? ' · f full access' : ''}${offersAlways(task, approval) ? ' · a always' : ''}`;
  // a beside y and n: keep this kind of action as a rule (lib/permission-rules.mjs) and allow
  // it now. Offered where the relay reads his rules (rules: saved), for an action that makes
  // a narrow rule; never for the never list, a teammate's session, or what stays his each time.
  const alwaysOffer = (task, approval) => task ? keepOffer(approval, task.origin) : null;
  const offersAlways = (task, approval) => Boolean(alwaysOffer(task, approval)?.rule);
  async function allowAlways(task, approval) {
    const offer = alwaysOffer(task, approval);
    if (!offer?.rule) throw new Error(`${offer?.refused ?? 'This one is asked each time.'} y allows it once, n denies it.`);
    const picked = await listDialog('Always allow', [ink(`This project  ${shortHome(approval.root ?? '')}`, 'text', colour), ink('All my projects', 'text', colour)], { notes: [offer.line, 'Push, tag, merge, deploy and publish stay blocked.'], hint: 'enter choose · esc cancel' });
    if (!picked) return;
    const all = picked.index === 1;
    const { answered } = keepRule(approval, task.origin, all ? 'all' : 'project', { sessionOf: approvalSession });
    setMessage(`${answered ? 'Allowed. ' : ''}From now on, without asking: ${offer.summary} (${all ? 'all your projects' : 'this project'}).`);
  }
  // /permissions rules: what runs without asking, numbered as elu permissions numbers it.
  async function rulesDialog() {
    for (let selected = 0; ;) {
      const rows = listEntries();
      const picked = await listDialog('Allowed without asking', rows.map(row => ink(entryLine(row), row.kind === 'default' && !row.on ? 'muted' : 'text', colour)), { selected, keys: ['x', 'o'], notes: ['a beside y and n adds a rule when a session asks. Push, tag, merge, deploy and publish are never allowed.'], hint: 'x remove or turn off · o turn on · esc close' });
      if (!picked) return;
      selected = picked.index; const row = rows[picked.index];
      // x removes a rule or turns a default off; o, or Enter on a default, turns it on or off.
      if (picked.key === 'x') setMessage(removeEntry(row.n));
      else if (row.kind === 'default') setMessage(picked.key !== 'o' && row.on ? removeEntry(row.n) : turnOnEntry(row.n));
    }
  }
  // The session an approval waits in, in any project the list shows.
  const approvalSession = approval => (dash?.projects ?? allProjects().projects).find(project => project.root === approval.root)?.tasks?.find(task => task.id === String(approval.taskId)) ?? null;
  const rowProject = row => row.root === controller?.repo.root ? {} : { location: projectFolder(row.root), root: row.root };
  async function allowFull(task, approval, where = {}) {
    if (!offersFull(task, approval)) throw new Error('Full access is not offered for this one. y allows it, n denies it.');
    if (!await confirmFull()) return;
    // The one f was pressed on is the owner's own answer, whatever it asks.
    const answered = answerApproval(approval.id, 'allow'), said = setMode(task, 'full', where);
    setMessage(answered && !said.startsWith('Allowed. ') ? `Allowed. ${said}` : said);
  }
  // A task's chat glances at peer status for the top bar at most every 5 s.
  let peerGlance = { at: 0, value: { on: false } };
  // On a team, the daemon runs: the app starts it when it opens, restarts one an update left
  // running with the old code, and starts one that died, at most once a minute. The start
  // as the app opens says nothing.
  let peerRevivedAt = 0, strayChecked = false;
  const peerFrame = () => revivePeer(peerFrameNow());
  function revivePeer(frame) {
    // On no team nothing runs, unless a leave is still to reach a former teammate: the daemon
    // is started for that once, as the app opens. Otherwise a daemon an older version left
    // running (0.1.5 started it before a join, which may have failed) is stopped once:
    // restartStale stops a daemon of another version and, on no team, starts none.
    if (!frame.on && facade && !strayChecked) {
      strayChecked = true;
      const unheard = (() => { try { return facade.leaveUnheard?.() === true; } catch { return false; } })();
      if (unheard && typeof facade.startPeer === 'function') Promise.resolve().then(() => facade.startPeer()).catch(() => {});
      else if (typeof facade.restartStale === 'function') Promise.resolve().then(() => facade.restartStale()).catch(() => {});
    }
    if (!frame.on || frame.status?.running !== false && frame.status?.stale !== true || typeof facade?.startPeer !== 'function' || Date.now() - peerRevivedAt < 60000) return frame;
    const opening = peerRevivedAt === 0; peerRevivedAt = Date.now();
    Promise.resolve().then(() => facade.startPeer()).then(started => { if (started && !opening) setMessage('The peer daemon had stopped. Starting it again.'); }, error => setMessage(`The peer daemon could not start: ${error.message}`));
    return frame;
  }
  function peerFrameNow() {
    if (!facade) return { on: false };
    if (!listed() && ['chat', 'kanban', 'bots', 'projects', 'usage'].includes(view)) {
      if (Date.now() - peerGlance.at > 5000) { const on = peerOn(); peerGlance = { at: Date.now(), value: { on, status: on ? peerRead('peerStatus') : null } }; }
      return peerGlance.value;
    }
    const on = peerOn(), status = on ? peerRead('peerStatus') : null;
    // An item says whether its teammate is trusted; older daemons leave it to the policy.
    const items = () => peerList('peerItems').map(item => item && typeof item === 'object' && item.trusted === undefined && typeof item.peer === 'string' ? { ...item, trusted: peerTrusted(item.peer) } : item);
    if (listed()) return { on, status, items: on ? items() : [] };
    if (!on) return { on, status };
    return { on, status, items: items(), agents: peerList('teamAgents'), trusted: trustedKeys(status), bots: myBots().map(bot => ({ ...bot, tone: botColor(bot) })) };
  }
  const onlineKeys = status => new Set((status?.teams ?? []).flatMap(row => row?.members ?? []).filter(member => member?.online).map(member => member.key));
  const scheduleDraw = () => { if (!pendingDraw && !closing) pendingDraw = setImmediate(() => { pendingDraw = null; draw(); }); };
  const selectedBoardRow = () => boardLines[board.selected ?? 0]?.row ?? null;
  // Where a new task goes from the Tasks input: the open project, the only one, or the selected row's.
  function goalTarget() {
    const projects = (dash ?? snapshot)?.projects ?? [];
    return controller?.repo.root ?? (projects.length === 1 ? projects[0].root : null) ?? ((view === 'projects' ? projectRows[projectsList.selected ?? 0]?.root : selectedBoardRow()?.root) || null);
  }
  const projectName = root => snapshot?.projects?.find(project => project.root === root)?.name ?? path.basename(root);
  // The brand and the terminal's title name the open project, else ELU Code.
  const brandName = () => controller ? clip(snapshot?.name ?? projectName(controller.repo.root), 20) : 'ELU Code';
  // Sessions: the list, then the chat or the form beside it. A row's own text takes no focus.
  // A session's pane is its chat, or its changes while they show.
  const sessionPane = () => changesBox.hidden ? activity : changesBox;
  const viewPanes = () => listed() ? view === 'chat' ? [board, composing() ? composeList : sessionPane()] : [board]
    : view === 'kanban' ? controller ? [...kanbanLists, ...(teamTaskRows.some(row => row.task) ? [kanbanTeamList] : [])] : []
    : view === 'chats' ? teamOn ? teamLists : []
    : view === 'bots' ? [botsList]
    : view === 'projects' ? [projectsList]
    : view === 'usage' ? [usageList]
    : composing() ? [composeList] : [sessionPane()];
  const subButtons = () => view === 'kanban' ? [newCard] : view === 'bots' ? [newBot] : view === 'projects' ? [newProject] : listed() || ['chats', 'usage'].includes(view) ? [] : [back];
  const activeTab = () => tabs.find(tab => tab.viewName === (view === 'chat' ? returnTo : view));
  // In these views the message box starts a new session, as in Sessions.
  const sessionBox = () => ['tasks', 'bots', 'projects', 'usage'].includes(view);
  // The teams a project was joined through (a teammate's team that has it as its project
  // here); none for a project of the owner's own. x leaves the first kind and archives the
  // second. The key bar asks on every draw, so its answer is read at most every two seconds.
  const joinedTeamsOf = root => { const found = root ? peerRead('joinedTeams', root) : null; return Array.isArray(found) ? found : []; };
  let joinedAt = 0, joinedRoot = null, joinedShown = [];
  function joinedInBar(root) {
    const now = Date.now();
    if (root !== joinedRoot || now - joinedAt >= 2000) { joinedRoot = root; joinedAt = now; joinedShown = joinedTeamsOf(root); }
    return joinedShown;
  }
  // The key bar names what each key does for whatever has focus right now.
  function keyPairs() {
    const focused = screen.focused;
    if (tabs.includes(focused)) return [['←→', 'switch'], ['enter', 'open'], ['↓', listed() ? 'sessions' : view === 'kanban' ? 'new task' : view === 'chats' ? 'chats' : view === 'bots' ? 'new bot' : view === 'projects' ? 'new project' : view === 'usage' ? 'usage' : 'back']];
    if (focused === newCard) return [['enter', 'new task'], ['↓', 'board'], ['↑', 'tabs']];
    if (focused === newBot) return [['enter', 'new bot'], ['↓', 'bots'], ['↑', 'tabs']];
    if (focused === botsList) return [['enter', 'open'], ['n', 'new bot'], ['x', 'remove'], ['tab', 'next']];
    if (focused === newProject) return [['enter', 'new project'], ['↓', 'projects'], ['↑', 'tabs']];
    if (focused === projectsList) return [['enter', 'settings'], ['o', 'make active'], ['n', 'new project'], ['x', joinedInBar(projectRows[projectsList.selected ?? 0]?.root).length ? 'leave' : 'archive'], ['tab', 'next']];
    if (focused === usageList) return [['enter', 'details'], ['r', 'refresh'], ['↑↓', 'scroll'], ['tab', 'next']];
    if (focused === kanbanTeamList) return [['enter', 'view'], ['↑↓', 'tasks'], ['tab', 'next']];
    if (kanbanLists.includes(focused)) {
      const index = kanbanLists.indexOf(focused), item = kanbanData[index]?.items[focused.selected ?? 0], column = kanbanData[index]?.column;
      const first = !item ? [] : column === 'todo' ? [['⇧→', 'start'], ['enter', 'edit'], ['x', 'delete']] : column === 'needs' ? [['enter', 'open'], ['⇧→', 'done']] : column === 'done' ? [['enter', 'open'], ['⇧←', 'reopen']] : [['enter', 'open']];
      return [...first, ['←→', 'columns'], ['n', 'new task']];
    }
    if (focused === back) return [['enter', 'back to Kanban'], ['↓', 'chat']];
    if (focused === board && rowApproval(selectedBoardRow())) return [['y', 'allow'], ['n', 'deny'], ...(offersFull(selectedBoardRow().task, rowApproval(selectedBoardRow())) ? [['f', 'full access']] : []), ...(offersAlways(selectedBoardRow().task, rowApproval(selectedBoardRow())) ? [['a', 'always']] : []), ['enter', 'open'], ['tab', 'next']];
    if (focused === board && selectedBoardRow()?.kind === 'approval' && offersAlways(approvalSession(selectedBoardRow().approval), selectedBoardRow().approval)) return [['y', 'allow'], ['n', 'deny'], ...(offersFull(approvalSession(selectedBoardRow().approval), selectedBoardRow().approval) ? [['f', 'full access']] : []), ['a', 'always'], ['enter', 'open'], ['tab', 'next']];
    if (focused === board && selectedBoardRow()?.kind === 'approval' && offersFull(approvalSession(selectedBoardRow().approval), selectedBoardRow().approval)) return [['y', 'allow'], ['n', 'deny'], ['f', 'full access'], ['enter', 'open'], ['n', 'new session'], ['tab', 'next']];
    if (focused === board && taskWaits(selectedBoardRow())) return [['y', 'approve'], ['n', 'reject'], ['enter', 'open'], ['tab', 'next']];
    // A session on another computer of mine that waits for y or n: n answers it, so it is not also new session.
    if (focused === board && selectedBoardRow()?.kind === 'remote' && (selectedBoardRow().approval || selectedBoardRow().label === 'TASK')) return [...rowActions(selectedBoardRow()), ['tab', 'next']];
    if (focused === board) return selectedBoardRow() ? [...rowActions(selectedBoardRow()).slice(0, 5), ['n', 'new session'], ['tab', 'next']] : [['enter', 'new session'], ['↑↓', 'choose'], ['tab', 'next']];
    if (focused === composeList) {
      const row = composeRows[composeList.selected ?? 0];
      return [...row?.type === 'project' ? [['enter', 'change project']] : row?.type === 'when' ? [['enter', 'schedule'], ...(composeWhen ? [['x', 'send now instead']] : [])] : ['permissions', 'place', 'model'].includes(row?.type) ? [['enter', 'change']] : row?.type === 'folders' ? [['enter', 'add'], ...(composeFolders.length ? [['x', 'clear']] : [])] : [['enter', 'add or remove'], ...(composeBots.length ? [['x', 'clear']] : [])], ['↓', 'write the message'], ['esc', 'sessions']];
    }
    if (focused === teamLists[0]) {
      const row = teamRows[0][focused.selected ?? 0]?.value;
      if (row?.type === 'add') return [['enter', row.what === 'channel' ? 'new channel' : 'invite a teammate'], ['↑↓', 'choose']];
      if (row?.type === 'room') return [['enter', 'write'], ['n', 'new channel'], ...(row.channel ? [['m', 'members'], ['x', 'leave']] : []), ['tab', 'threads']];
      if (row?.type === 'bot') return [['enter', 'write'], ['n', 'new channel'], ['tab', 'threads']];
      return [['enter', 'write'], ['t', 'trust'], ['n', 'new channel'], ['tab', 'threads']];
    }
    if (focused === teamLists[1]) return [['y', 'accept/send'], ['n', 'decline'], ['c', 'continue'], ['enter', 'read'], ...(chatOpen?.type === 'room' && chatOpen.channel ? [['m', 'members'], ['x', 'leave']] : [])];
    if (focused === ask && !palette.hidden) return [['↑↓', 'choose'], ['tab', 'complete'], ['enter', 'run'], ['esc', 'close']];
    if (focused === ask) {
      if (view === 'chats') return [['enter', 'send'], ['@name', 'one teammate'], ['/', 'commands'], ['!', 'run a shell command']];
      // Only what is not obvious: what Enter does, the command list, choosing the model, and running a shell command.
      const more = [['/', 'commands'], ['/model', 'choose the model'], ['!', 'run a shell command']];
      // With a saved bot, @name is worth knowing too.
      if (savedBots().length) more.unshift(['@name', 'ask a bot']);
      // Beside the list, Esc is the way back to it. It comes last, so it shows where there is room.
      if (listed()) more.push(['esc', 'sessions']);
      if (remoteHere()) return [['enter', `send to @${remoteHere().machine}`], ['esc', 'sessions']];
      if (sessionBox()) return [['enter', 'new session'], ...more];
      if (view === 'kanban') return [['enter', 'add to To do'], ...more.filter(([key]) => key !== '@name')];
      return [['enter', composing() && composeWhen ? 'save the schedule' : 'send'], ...more];
    }
    if (focused === activity) return [['↑↓', 'scroll'], ['esc', 'sessions'], ['i', 'type']];
    if (focused === changesBox) {
      const row = changesShown?.rows[changesShown.cursor], file = row?.kind === 'file' ? changesShown.entry?.changes.files[row.file] : null;
      return [['↑↓', 'move'], ...(file ? [['enter', unfolded(changesShown.entry, file) ? 'fold' : 'unfold']] : []), ['pgup pgdn', 'page'], ['esc', 'chat'], ['tab', 'next']];
    }
    return [['tab', 'next'], ['?', 'help'], ['q', 'quit']];
  }
  const firstWords = (value, width) => fitWords(plain(String(value ?? '').split('\n').find(line => line.trim()) ?? ''), width);
  // How a message names a session: its title in quotes, cut short. No session shows a number.
  const sessionName = task => `"${firstWords(taskTitle(task), 40)}"`;
  const state = task => task.state === 'needs_input' ? 'waiting for you' : approvalsFor(task).length ? 'needs approval' : task.state === 'running' ? task.activeRole && task.activeRole !== 'lead' ? `${roleLabel(task.activeRole)} ${task.shadowing ? 'shadowing' : 'working'}` : 'working' : task.state;
  const clockTime = value => new Date(value).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  // A focused tab or button is filled with the accent; the current one is accent text.
  function styleButton(widget, active, mark = active) {
    const focused = screen.focused === widget, row = widget.position.top === 0;
    Object.assign(widget.style, { fg: focused ? shade('background') : active ? accent : muted, bg: focused ? accent : active && row ? shade('background') : row ? shade('raised') : shade('background'), bold: active || focused, underline: mark && !focused, inverse: focused && !colour });
  }
  function placeRow(widgets, left) {
    let x = left;
    for (const widget of widgets) { widget.hidden = false; Object.assign(widget, { left: x, width: widget.content.length }); x += widget.content.length + 1; }
    return x;
  }
  // --- Kanban: what teammates are working on in this project ---
  // Each teammate's machine tells the Tasks its sessions work on in a project shared with a
  // team (lib/peer/plans.mjs). They show under the four columns, by teammate, apart from this
  // machine's cards and read-only. What a teammate sent is text to show, never to act on.
  const teamTaskState = task => task.state === 'done' ? 'done' : 'in progress';
  const teamTaskDone = task => ({ done: task.subtasks.filter(step => step.state === 'done').length, of: task.subtasks.length });
  const teamTaskAt = task => task.updatedAt ?? task.doneAt ?? task.approvedAt;
  function drawTeamTasks(on) {
    const root = on && peerData.on ? controller.repo.project ?? controller.repo.root : null;
    if (!root) teamTasks = { at: 0, root: null, people: [], sharing: 'none' };
    else if (teamTasks.root !== root || Date.now() - teamTasks.at > 3000) {
      let sharing = 'none'; try { sharing = facade?.taskSharing?.(root) ?? 'none'; } catch { sharing = 'none'; }
      teamTasks = { at: Date.now(), root, people: peerList('teammateTasks', root).filter(person => Array.isArray(person?.tasks) && person.tasks.length), sharing };
    }
    const kept = teamTaskRows[kanbanTeamList.selected ?? 0]?.key, rows = teamTasks.people.flatMap(person => [{ person }, ...person.tasks.map(task => ({ person, task, key: `${person.peer}/${task.id}` }))]);
    const note = !rows.length && teamTasks.sharing === 'no-origin' ? 'Tasks are not shown to teammates: this project has no origin remote.' : '';
    const g = geometry(screen.width, screen.height), height = g.statusTop - g.top, tall = rows.length ? Math.min(rows.length + 2, Math.max(4, Math.floor(height / 3))) : note ? 3 : 0;
    teamTaskRows = rows;
    if (on) kanbanBoxes.forEach(frame => { frame.height = height - tall; });
    Object.assign(kanbanTeam, { top: g.top + height - tall, left: 0, width: g.width, height: Math.max(3, tall) });
    kanbanTeam.hidden = !tall; kanbanTeamList.hidden = !rows.length;
    kanbanTeam.style.border.fg = screen.focused === kanbanTeamList ? accent : shade('border');
    kanbanTeam.setLabel(rows.length ? ` Teammates' Tasks ${rows.filter(row => row.task).length} · read-only ` : ' Teammates ');
    kanbanTeam.setContent(note);
    Object.assign(kanbanTeamList.style.selected, screen.focused === kanbanTeamList ? selection : { fg: shade('text'), bg: shade('panel'), inverse: false, bold: false, underline: false });
    const width = Math.max(20, g.width - 6);
    const lines = rows.map(({ person, task }) => {
      if (!task) return ink(`${person.online ? '●' : '○'} ${clip(person.name, 40)}`, person.online ? 'text' : 'muted', colour, true) + ink(person.online ? ' · online' : ` · offline · last heard ${relativeTime(person.heardAt)}`, person.online ? 'muted' : 'orange', colour);
      const { done, of } = teamTaskDone(task), at = teamTaskAt(task);
      const detail = [`${task.priority} · ${task.severity}`, teamTaskState(task), ...(of ? [`${done}/${of} done`] : []), task.who, ...(at ? [relativeTime(at)] : [])].join(' · '), title = clip(task.title, Math.max(12, width - 4 - detail.length));
      return `  ${ink(title, task.state === 'done' || !person.online ? 'muted' : 'blue', colour, task.state !== 'done')}${ink(`  ${clip(detail, Math.max(8, width - 4 - title.length))}`, 'muted', colour)}`;
    });
    if (lines.join('\n') !== kanbanTeamList.ritems?.join('\n')) kanbanTeamList.setItems(lines);
    const found = kept === undefined ? -1 : rows.findIndex(row => row.key === kept);
    kanbanTeamList.select(found >= 0 ? found : Math.max(0, Math.min(kanbanTeamList.selected ?? 0, rows.length - 1)));
    // The Tasks it was on are gone: focus goes back to the columns.
    if (on && !rows.length && screen.focused === kanbanTeamList) (lastPane.kanban ?? kanbanLists[0]).focus();
  }
  // Moves the selection between Tasks, over the rows that only name a teammate. False at an end.
  function teamTaskStep(step) {
    const at = teamTaskRows.map((row, index) => row.task ? index : -1).filter(index => index >= 0), here = at.indexOf(kanbanTeamList.selected ?? 0), next = here < 0 ? (step < 0 ? -1 : 0) : here + step;
    if (!at.length || next < 0 || next >= at.length) return false;
    kanbanTeamList.select(at[next]); return true;
  }
  // The whole Task, to read: description, goal, objectives with the met ones marked, subtasks.
  async function openTeamTask() {
    const row = teamTaskRows[kanbanTeamList.selected ?? 0]; if (!row?.task) return;
    const { task, person } = row, width = Math.min(88, screen.width - 4) - 6, lines = [], { done, of } = teamTaskDone(task);
    const say = (text, tone = 'text', bold = false) => { for (const line of wrapText(text, width)) lines.push(ink(line, tone, colour, bold)); };
    say(task.title, 'text', true);
    say(`${teamTaskState(task)} · priority ${task.priority} · severity ${task.severity}${task.revision > 1 ? ` · revision ${task.revision}` : ''}`, 'muted');
    say(`Worked on by ${task.who} on ${person.name}'s machine · started by ${task.startedBy === 'schedule' ? 'a schedule' : task.startedBy === 'handoff' ? 'a handoff' : 'its owner'}`, 'muted');
    say([task.approvedAt && `approved ${relativeTime(task.approvedAt)}`, task.doneAt && `done ${relativeTime(task.doneAt)}`, teamTaskAt(task) && `updated ${relativeTime(teamTaskAt(task))}`, !person.online && `last heard ${relativeTime(person.heardAt)}`].filter(Boolean).join(' · '), 'muted');
    if (task.goal) { lines.push(''); say('Goal', 'muted', true); say(task.goal); }
    if (task.description) { lines.push(''); say('Description', 'muted', true); say(task.description); }
    lines.push(''); say(`Objectives · ${task.met.length} of ${task.objectives.length} met`, 'muted', true);
    task.objectives.forEach((text, index) => { const met = task.met.includes(index + 1); say(`  ${met ? '✓' : '·'} ${text}`, met ? 'green' : 'text'); });
    if (of) { lines.push(''); say(`Subtasks · ${done} of ${of} done`, 'muted', true); for (const step of task.subtasks) say(`  ${step.state === 'done' ? '✓' : step.state === 'doing' ? '▸' : '·'} ${step.text}`, step.state === 'done' ? 'green' : step.state === 'doing' ? 'blue' : 'text'); }
    await listDialog(clip(`${person.name}'s Task`, 60), lines, { hint: 'read-only · ↑↓ scroll · esc close' });
  }
  function draw(idle) {
    if (closing || drawing) return;
    drawing = true;
    try {
      if (minimumSize()) { screen.render(); lastFrame = null; return; }
      if (view === 'chat' && !controller) view = 'tasks';
      const g = geometry(screen.width, screen.height), W = g.width, now = Date.now();
      snapshot = view === 'chat' || view === 'kanban' && controller ? controller.snapshot() : allProjects(dashboardSnapshot());
      adoptHistory(); follow();
      peerData = peerFrame();
      // In every view, a session set to Full access while its turn asks is answered for the owner.
      let everyProject = null;
      const asking = pendingNow().filter(row => {
        const list = snapshot.tasks && (!row.root || row.root === controller?.repo.root) ? snapshot.tasks : (snapshot.projects ?? (everyProject ??= allProjects().projects)).find(project => project.root === row.root)?.tasks;
        const task = (list ?? []).find(value => String(value.id) === String(row.taskId));
        return !allowForFull(task, [row], task ? turnMode(task) : null);
      });
      approvals = view === 'tasks' || view === 'chat' ? asking : [];
      let away = []; try { away = remoteApp.rows(now).filter(row => row.approval).map(row => `remote\0${row.id}\0${row.approval.id}`); } catch { /* Read again next draw. */ }
      ringFor([...asking.map(row => `approval\0${row.id}`), ...away]);
      // Sessions: the list's rows, the cursor, and what its row shows on the right.
      dash = listed() ? view === 'tasks' ? snapshot : allProjects(dashboardSnapshot()) : null;
      if (dash) { const was = view, owner = controller; syncSessions(now); if (view !== was || controller !== owner) snapshot = view === 'chat' ? controller.snapshot() : dash; }
      if (sided !== listed()) layoutSession(g);
      // Row 0: brand, tabs, then peers and the clock. The brand names the open project.
      const name = brandName(), brandText = ` ◆ ${name} `;
      if (brand.content !== brandText) { brand.setContent(brandText); brand.width = brandText.length; }
      if (screen.title !== name) screen.title = name;
      placeRow(tabs, brandText.length + 1);
      for (const tab of tabs) styleButton(tab, tab === activeTab());
      const stopped = peerData.on && peerData.status?.running === false;
      const pillText = `${ink(`${peerData.on && !stopped ? '●' : '○'} ${peerSummary(peerData.on, peerData.status)}`, stopped ? 'orange' : peerData.on ? 'green' : 'muted', colour)}${ink('  ·  ', 'dim', colour)}${ink(clockTime(now), 'muted', colour)} `;
      const pillWidth = visible(pillText).length, tabsEnd = tabs.at(-1).left + tabs.at(-1).width;
      pills.setContent(pillText); Object.assign(pills, { left: Math.max(0, W - pillWidth), width: pillWidth });
      pills.hidden = tabsEnd + 2 + pillWidth > W;
      // Row 1: the view's own buttons, then its title.
      for (const widget of [newCard, newBot, newProject, back]) widget.hidden = true;
      const end = placeRow(subButtons(), 1);
      for (const widget of [newCard, newBot, newProject]) styleButton(widget, true, false);
      styleButton(back, false);
      const task = view === 'chat' && snapshot.tasks.find(row => row.id === selectedId);
      const readOnly = claim.readOnly ? '  [READ ONLY]' : '', goal = task ? firstWords(taskTitle(task), 60) : '';
      const titled = (name, text) => [name, task ? text : selectedRequest ? 'saved request' : following ? following.bot ? `sending to @${following.bot}` : 'sending' : 'New session', task ? state(task) : ''].filter(Boolean).join('  ·  ') + readOnly;
      // The session's badge: Ask, Auto or Full (orange), then Here when it works in your checkout.
      const mode = task && MODES.includes(task.permissions) ? task.permissions : null;
      const badge = mode ? ink('  ·  ', 'dim', colour) + ink(BADGES[mode], mode === 'full' ? 'orange' : 'muted', colour, true) + (task.place?.kind === 'here' ? ' ' + ink('Here', 'orange', colour, true) : '') : '';
      // The title sits over the session: beside the list in Sessions, else after the view's buttons.
      // Beside the list it is cut to fit. The project goes first, since the brand names it, then the end of the request.
      // The request gets the room the dot and the state leave: titled('', '.') is those and one character.
      // After the badge, a bot of this session that runs on a schedule: "◷ @elu every 1h · next in 52m".
      // It is left out when the line has no room for it beside a readable title.
      const runs = task ? (timedSessions()[snapshot.root]?.[task.id] ?? []).map(value => botScheduleBrief(value)).join('  ·  ') : '', clocked = runs ? ink('  ·  ', 'dim', colour) + ink(`◷ ${runs}`, 'blue', colour) : '';
      const left = listed() ? boardBox.width + 1 : end + 1, tail = clocked && W - left - 1 - visible(badge).length - visible(clocked).length >= 24 ? clocked : '', room = Math.max(1, W - left - 1 - visible(badge).length - visible(tail).length);
      const title = view === 'kanban' ? controller ? snapshot.name + readOnly : '' : view !== 'chat' ? '' : !listed() || titled(snapshot.name, goal).length <= room ? titled(snapshot.name, goal) : titled('', goal).length <= room ? titled('', goal) : titled('', fitWords(goal, Math.max(4, room - titled('', '.').length + 1)));
      Object.assign(header, { left, width: Math.max(1, W - left - 1) });
      header.setContent(ink(clip(title, room), 'text', colour, true) + badge + tail);
      // Sessions: the list. Its rows are built before this, with the cursor.
      boardBox.hidden = !listed();
      if (listed()) {
        // The list's last column is its scrollbar. The first one marks the cursor's row.
        // A row stops one column short of the list, as in the other lists. One that fills it is wrapped by blessed and loses its age.
        const width = Math.max(8, board.width - 2), mark = screen.focused === board ? 'orange' : 'dim', columns = barColumns(boardLines.flatMap(line => line.row ? [line.row] : []), width - 1);
        const lines = boardLines.map((line, place) => line.spacer ? '' : line.note ? ink(` ${line.note}`, 'muted', colour) : line.header
          ? ink(` ${line.header.toUpperCase()}`, line.tone, colour, true) + ink(` ${line.count} `, 'muted', colour) + ink('─'.repeat(Math.max(0, width - line.header.length - String(line.count).length - 3)), 'dim', colour)
          : ink(place === barAt ? '▌' : ' ', mark, colour) + (line.add ? ink('+ New session', 'orange', colour, true) : barCells(line.row, width - 1, now, columns).map(cell => ink(cell.text, cell.tone, colour, cell.bold, { trusted: line.row.kind === 'peer' && line.row.item?.trusted === true })).join('')));
        if (lines.join('\n') !== board.ritems?.join('\n')) board.setItems(lines);
        board.select(barAt);
      }
      // Chats
      teamOn = view === 'chats' && peerData.on;
      teamOff.hidden = view !== 'chats' || teamOn;
      // The box fits its lines: the three of CHATS_OFF, or one.
      const offText = facade ? stopped ? PEER_STOPPED : CHATS_OFF : PEER_MISSING;
      teamOff.setContent(offText); teamOff.height = offText.split('\n').length + 2;
      teamBoxes.forEach((frame, index) => { frame.hidden = !teamOn; frame.style.border.fg = screen.focused === teamLists[index] ? accent : shade('border'); });
      if (teamOn) {
        // The bar lists channels, then each teammate with their live agents. Each pane keeps its selected row while content moves.
        const widths = teamLists.map(list => Math.max(8, list.width - 2)), sizes = [widths[0], widths[0] - 2, widths[1]], [bar, work] = teamPanes(peerData, sizes, colour);
        const mates = bar.flatMap(row => [row, ...work.filter(item => item.value?.row && row.value?.type === 'member' && item.value.peer === row.value.key).map(item => ({ ...item, line: `  ${item.line}` }))]);
        const place = (index, rows, first = 0) => {
          const list = teamLists[index], kept = teamRows[index][list.selected ?? 0]?.key, lines = rows.map(row => row.line);
          teamRows[index] = rows;
          if (lines.join('\n') !== list.ritems?.join('\n')) list.setItems(lines);
          const found = kept === undefined ? -1 : rows.findIndex(row => row.key === kept);
          list.select(found >= 0 ? found : kept === undefined ? first : Math.min(list.selected ?? 0, rows.length - 1));
        };
        // The bar opens on the channel or person open last, else the first with a thread that waits for the owner, else the first channel. A new channel takes the cursor once.
        const jump = chatJump === null ? -1 : mates.findIndex(row => row.value?.target === chatJump); chatJump = null;
        const start = [row => row.value?.target === chatTarget, row => row.value?.waiting > 0, row => row.value?.target].map(match => mates.findIndex(match)).find(index => index >= 0);
        place(0, mates, start ?? 0);
        if (jump >= 0) teamLists[0].select(jump);
        // The row under the cursor is the open channel or person (an agent's row opens its teammate); a heading or an add row keeps the last one.
        const pointed = mates[teamLists[0].selected ?? 0]?.value, wanted = pointed?.target ?? (pointed?.type === 'agent' ? dmTarget(pointed.peer) : chatTarget);
        chatOpen = mates.find(row => row.value?.target === wanted)?.value ?? mates.find(row => row.value?.target)?.value ?? null;
        chatTarget = chatOpen?.target ?? null;
        const where = chatOpen ? chatOpen.type === 'room' ? `#${chatOpen.name}` : chatOpen.type === 'bot' ? `@${chatOpen.name}${chatOpen.peer ? ` · ${botHome(chatOpen)}` : ''}` : peerName(chatOpen.name, chatOpen.key) : null;
        place(1, teamPanes(peerData, sizes, colour, chatTarget, where)[2]);
        teamBoxes[1].setLabel(` ${where ?? 'Threads'} `);
        // A channel names who is in it on a line of its own, and its threads start under that line.
        const inside = chatOpen?.type === 'room' ? membersLine(chatOpen, widths[1], colour) : '';
        chatMembers.setContent(inside); chatMembers.hidden = !inside;
        Object.assign(teamLists[1], inside ? { top: 2, height: '100%-3' } : { top: 1, height: '100%-2' });
        layoutChats(g);
      }
      // Kanban
      const kanbanOn = view === 'kanban' && Boolean(controller);
      kanbanOff.hidden = view !== 'kanban' || kanbanOn;
      kanbanOff.setContent('Kanban shows one project. Open one in the Projects tab, or start elu inside it.');
      kanbanBoxes.forEach((frame, index) => { frame.hidden = !kanbanOn; frame.style.border.fg = screen.focused === kanbanLists[index] ? accent : shade('border'); });
      if (kanbanOn) {
        let data = readBoard(controller.repo);
        if (data.cards.some(card => card.requestId && !card.taskId) && linkCards(controller.repo, snapshot.queue ?? [])) data = readBoard(controller.repo);
        const previous = kanbanData;
        kanbanData = boardColumns(data, snapshot, now);
        kanbanData.forEach((column, index) => {
          const list = kanbanLists[index], width = Math.max(4, list.width - 2), kept = previous[index]?.items[list.selected ?? 0]?.key;
          kanbanBoxes[index].setLabel(` ${column.name} ${column.items.length} `);
          const tone = item => item.task?.state === 'needs_input' || item.request?.state === 'blocked' || item.task?.state === 'blocked' || item.plan?.state === 'proposed' ? 'orange' : column.column === 'progress' ? 'blue' : column.column === 'done' ? 'muted' : 'text';
          const lines = column.items.map(item => {
            // A Task's card is its title first; where the Task stands goes beside it as far as it fits (lib/kanban.mjs).
            const card = item.plan ? fitCard(plain(item.title), item.detail, width) : null, title = card ? card.title : fitWords(plain(item.title), width), room = width - title.length - 2;
            const detail = card ? card.detail : item.detail && room >= Math.min(item.detail.length, 12) ? clip(item.detail, room) : '';
            return ink(title, tone(item), colour, column.column !== 'done') + (detail ? ink(`  ${detail}`, 'muted', colour) : '');
          });
          if (lines.join('\n') !== list.ritems?.join('\n')) list.setItems(lines);
          const found = kept === undefined ? -1 : column.items.findIndex(item => item.key === kept);
          list.select(found >= 0 ? found : Math.max(0, Math.min(list.selected ?? 0, column.items.length - 1)));
        });
      }
      drawTeamTasks(kanbanOn);
      // Bots
      botsBox.hidden = view !== 'bots';
      if (view === 'bots') drawBots();
      // Projects
      projectsBox.hidden = view !== 'projects';
      if (view === 'projects') drawProjects();
      // Usage
      usageBox.hidden = view !== 'usage';
      if (view === 'usage') drawUsage(now);
      // A task's chat, or the New task form.
      const form = composing();
      activity.hidden = view === 'chat' ? form : view !== 'tasks'; compose.hidden = view !== 'chat' || !form;
      if (form) {
        composeMode ??= defaultMode();
        // A row is a name, a value and a hint. Beside the list the pane is narrow: the value
        // column shrinks, then a shorter hint is used, then none, so no row wraps.
        const room = Math.max(30, composeList.width - 1), column = Math.min(22, Math.max(12, room - 29));
        const label = text => ink(text.padEnd(13), 'muted', colour);
        const row = (name, value, tone, ...hints) => {
          const text = clip(value, Math.min(40, room - 13)), wide = Math.max(column, text.length + 2), hint = hints.find(hint => 13 + wide + hint.length <= room);
          // tone: a colour for the whole value, or a function that paints it word by word.
          if (typeof tone === 'function') return label(name) + tone(text) + ' '.repeat(hint ? wide - text.length : 0) + ink(hint ?? '', 'muted', colour);
          return label(name) + ink(hint ? text.padEnd(wide) : text, tone, colour, true) + ink(hint ?? '', 'muted', colour);
        };
        composeRows = [{ type: 'project', line: label('Project') + ink(clip(snapshot.name, room - 13 - (claim.readOnly ? 11 : 0)), 'text', colour, true) + ink(claim.readOnly ? '  read only' : '', 'orange', colour) }];
        const upcoming = composeWhen && nextRun(composeWhen, new Date(now));
        composeRows.push({ type: 'when', line: row('When', composeWhen?.label ?? 'now', composeWhen ? 'orange' : 'text', ...(composeWhen ? [upcoming ? `next ${dateText(upcoming)}` : 'has passed'] : ['/schedule to run it later', '/schedule'])) });
        // The session's permissions: the mode, where the lead works, extra folders it may read.
        composeRows.push({ type: 'permissions', line: row('Permissions', LABELS[composeMode], composeMode === 'full' ? 'orange' : 'text', '/permissions ask, auto or full', '/permissions') });
        composeRows.push({ type: 'place', line: row('Runs in', placeText(composePlace), composePlace.kind === 'here' ? 'orange' : 'text', '/place worktree, branch NAME or here', '/place') });
        const folders = composeFolders.length ? composeFolders.map(shortHome).join(' ') : 'none';
        composeRows.push({ type: 'folders', line: row('Folders', folders, 'text', ...(composeFolders.length ? ['/permissions folders add PATH · x clears', '/permissions folders add PATH', 'x clears'] : ['/permissions folders add PATH', '/permissions folders'])) });
        // The model the message goes to, then the bots that review its changes.
        const using = nameOf(composeModel ?? controller.defaultModel());
        composeRows.push({ type: 'model', line: row('Model', using, 'orange', '/model NAME, or /model to pick', '/model NAME') });
        composeRows.push({ type: 'bots', line: row('Bots', composeBots.length ? botNames(composeBots, Math.min(40, room - 13)) : 'none', text => paintBots(text, 'text'), '/bots add NAME, /bots remove NAME', '/bots add NAME') });
        const lines = composeRows.map(row => row.line);
        if (lines.join('\n') !== composeList.ritems?.join('\n')) composeList.setItems(lines);
        // The note under the rows takes the lines it needs, and the rows take the rest.
        const note = (composeWhen ? `Saved as a schedule: each run starts a new session with ${using}.\nRuns while this computer is awake, even with ELU Code closed.` : `Your message goes to ${using}.\nBots review the changes. Type @name to add one or to write to it.`).split('\n').flatMap(line => wrapText(line, Math.max(10, compose.width - 4)));
        if (composeHint.height !== note.length) { composeHint.height = note.length; composeList.height = `100%-${note.length + 3}`; }
        composeHint.setContent(note.join('\n'));
        compose.style.border.fg = screen.focused === composeList ? accent : shade('border');
      }
      const lines = [];
      // A plain line in the chat is wrapped at words here, so the pane beside the list never wraps one a second time.
      const note = (text, tone, bold = false) => wrapText(text, chatWidth()).map(row => ink(row, tone, colour, bold)).join('\n');
      if (task) {
        const entries = conversationEntries(repo, task), leadName = modelOf(task);
        // Your messages sit on a shaded band behind a blue bar; the lead's behind an orange one.
        // A question ends the lead's last reply, in the same block.
        const waiting = task.state === 'needs_input' ? task.reply?.outcome === 'needs_input' ? task.reply : task.result : null;
        const asked = String(waiting?.question ?? '').trim(), choices = (waiting?.choices ?? []).map((choice, index) => `${index + 1}. ${choice}`).join('\n');
        const withQuestion = text => [text, asked && !text.includes(asked) ? asked : '', choices].filter(Boolean).join('\n\n');
        const last = waiting && entries.at(-1)?.lead ? entries.at(-1) : null;
        for (const entry of entries) {
          const text = entry === last ? withQuestion(entry.text) : entry.text;
          // A ! command sits between the messages behind a green bar, with its output as printed.
          if (entry.shell) { lines.push(chatMessage({ title: entry.role, at: entry.at, text, tone: 'green', raw: true }, chatWidth(), colour)); continue; }
          // A bot's reply sits behind a bar in the bot's own colour, never the lead's orange or your blue; one it could not give, behind a red one.
          if (entry.bot) { lines.push(chatMessage({ title: entry.role, at: entry.at, text, tone: entry.failed ? 'red' : entry.quiet ? 'muted' : toneOfBot(entry.bot) }, chatWidth(), colour)); continue; }
          lines.push(chatMessage({ title: entry === last ? `${entry.role} is waiting for you` : entry.role, at: entry.at, text, tone: entry.lead ? 'orange' : 'blue', shaded: !entry.lead }, chatWidth(), colour));
        }
        if (waiting && !last) lines.push(chatMessage({ title: `${leadName} is waiting for you`, text: withQuestion(''), tone: 'orange' }, chatWidth(), colour));
        // While it waits for an allow or deny it is not working: the approval below says what it waits for.
        if (task.state === 'running' && !approvalsFor(task).length) {
          lines.push(ink(task.shadowing ? `${roleLabel(task.activeRole)} is shadowing the last turn` : task.activeRole === 'checks' ? 'Checks are running' : `${!task.activeRole || task.activeRole === 'lead' ? leadName : roleLabel(task.activeRole)} is working`, botOfKey(task.activeRole) ? toneOfBot(botOfKey(task.activeRole)) : 'orange', colour, true));
          const event = snapshot.activity.findLast(row => String(row.taskId) === String(task.id)); if (event) lines.push(ink(clip(event.text, chatWidth()), 'muted', colour));
          lines.push(ink('type a message any time · /stop to stop', 'muted', colour));
        }
        if (task.state === 'unverified') lines.push(note('Edits are not verified. /publish runs the checks first.', 'orange'));
        if (task.state === 'ready') lines.push(note('Checks complete. /changes to inspect · /publish to review push', 'green'));
        if (task.error) lines.push(note(task.error.message, 'orange'));
        // The session's Task (lib/plan.mjs): what waits for a yes, or what is being worked on and how far it is.
        // A rejected one is a single line, until the chat goes on.
        const dropped = task.plan?.state === 'rejected' && (task.messages ?? []).some(row => Date.parse(row.at) > Date.parse(task.plan.rejectedAt));
        if (task.plan && !dropped) lines.push(taskCard(task.plan, { width: chatWidth(), colour, approval: approvalsFor(task).length > 0 }));
        // A live approval waits here and under Needs you; Esc leaves the box, then y or n answers.
        for (const row of approvalsFor(task)) lines.push([ink('Waiting for your approval', 'orange', colour, true), ink(`${!row.role || row.role === 'lead' ? leadName : roleLabel(row.role)} wants to:`, 'text', colour), note(row.summary, 'text', true), ink(offersFull(task, row) || offersAlways(task, row) ? `Esc, then ${approvalKeys(task, row)}` : 'Esc, then y allow · n deny · esc later', 'muted', colour)].join('\n'));
        // Actions the vendor refused and reported, and a mode the vendor did not give.
        const lastLead = task.runs.findLast(run => run.role === 'lead');
        // What a rule of his or a default answered in this session, kept in its decisions.
        const ruled = [...new Set((task.approvals ?? []).filter(row => row.by && row.rule).map(row => `${row.by === 'rule' ? 'Allowed by your rule' : 'Allowed by default'}: ${row.rule}`))].slice(-3);
        if (ruled.length) lines.push(ruled.map(text => note(text, 'muted')).join('\n'));
        if (lastLead?.permissions === 'auto' && lastLead.effectivePermissions === 'ask') lines.push(note('Asked instead. Approve for me is not available here.', 'muted'));
        // A second launch for one message is said. One that started the message over may have run again
        // what the first one ran; one that asked the same session for its reply again started nothing over.
        if (lastLead?.again) lines.push(note(lastLead.resumed ? `${leadName} was asked for its reply again: the first one was not accepted.` : `${leadName} was started twice for this message: its first reply was not accepted. Anything it ran may have run twice.`, 'muted'));
        // What the last turn was refused, each with why and what to do. A step in which a
        // never-list command was refused shows whatever the turn went on to say.
        const rows = blockedRows(task, lastLead);
        if (rows.length) lines.push(rows.map(row => note(row.text, 'orange')).join('\n'));
        // What was sent while the session worked waits here and goes by itself when the turn
        // ends. The newest one names the key that takes it back, and says that an approval
        // above is not answered by it.
        const held = (snapshot.queue ?? []).filter(row => row.continuationTaskId === task.id && ['queued', 'starting'].includes(row.state)), newest = waitingMessage(task.id, held);
        for (const row of held) {
          const when = row.state === 'starting' ? 'Starting.' : ['running', 'preparing'].includes(task.state) ? 'Sent when this turn ends.' : row.reason ?? 'Waiting to start.';
          const more = row === newest ? [when, '↑ in the message box takes it back', ...(approvalsFor(task).length ? ['The approval above still needs your answer.'] : [])] : [when];
          lines.push(chatMessage({ title: row.bot ? `${row.scheduled ? 'Schedule' : 'You'} → @${row.bot} (waiting)` : `${requester(row)} (waiting)`, at: row.createdAt, text: requestGoal(row), tone: 'blue', shaded: true }, chatWidth(), colour) + '\n' + more.map(text => note(text, 'muted')).join('\n'));
        }
      }
      // A ! command still running in this session shows the end of its output so far.
      if (task && shellRun?.session?.id === task.id && shellRun.session.repo.root === repo.root) lines.push(chatMessage({ title: 'Shell', at: shellRun.at, text: [`$ ${shellRun.command}`, shellRun.run.tail(2000).trimEnd()].filter(Boolean).join('\n'), tone: 'green', raw: true }, chatWidth(), colour) + '\n' + ink('Running. /stop ends it.', 'muted', colour));
      const current = selectedRequest && (snapshot.queue ?? []).find(row => row.id === selectedRequest.id);
      if (current && ['queued', 'starting', 'running'].includes(current.state)) lines.push(chatMessage({ title: current.bot ? `${current.scheduled ? 'Schedule' : 'You'} → @${current.bot} (queued)` : `${requester(current)} (queued)`, at: current.createdAt, text: requestGoal(current), tone: 'blue', shaded: true }, chatWidth(), colour) + '\n' + note(`${current.reason ?? 'Waiting to start.'} /stop cancels it.`, 'muted'));
      else if (selectedRequest) lines.push(chatMessage({ title: selectedRequest.bot ? `Saved request → @${selectedRequest.bot}` : selectedRequest.origin ? `Saved request from ${requester(selectedRequest)}` : 'Saved request', at: selectedRequest.createdAt, text: requestGoal(selectedRequest), tone: 'blue', shaded: true }, chatWidth(), colour) + '\n' + note([(current ?? selectedRequest).state === 'blocked' && (current ?? selectedRequest).reason, 'Send it to retry. /stop cancels it.'].filter(Boolean).join(' '), 'muted'));
      // Asked before the new text is set: lines that arrive below must not read as scrolling up.
      const chatNow = view === 'chat' ? `${controller?.repo.root ?? ''}\0${selectedId ?? selectedRequest?.id ?? following?.id ?? ''}` : null;
      const held = chatNow !== null && chatNow === chatShown && scrolledUp(activity);
      chatShown = chatNow;
      if (view === 'chat') activity.setContent(lines.join('\n\n'));
      // Sessions, on a row that is not a session: the row's own text, and how to start when there is nothing yet.
      else if (view === 'tasks') {
        // A session of another project shows once that project is the active one. Until then the pane is empty.
        const row = boardLines[barAt]?.row, card = row && row.kind !== 'remote' && !sessionOf(row) && rowCard(row, now);
        if (row?.kind === 'remote') activity.setContent(remoteApp.view(row, chatWidth()));
        else activity.setContent(row && !card ? '' : card ? `${chatBlock({ title: card.title, text: blockText(card.text, { trusted: row.kind === 'peer' && row.item?.trusted === true }), tone: card.tone, width: chatWidth(), colour })}\n\n${ink(keyRows(card.keys, chatWidth()).join('\n'), 'muted', colour)}`
          : note(dash.projects.length ? 'Type below to start a session, or press n to set it up first.' : 'No project yet. Press n to create one here. n in the Projects tab opens another folder.', 'muted'));
      }
      // The message box says where the text goes, and which bots are in the chat.
      const target = sessionBox() && goalTarget(), inChat = task ? botsOf(task) : form ? composeBots : [], withBots = inChat.length ? ` · with ${botNames(inChat)}` : '';
      // The model the text goes to: the open session's, else the one a new session starts with.
      // Text that starts with a saved bot's @name is written to that bot.
      const toModel = !controller ? null : task ? modelOf(task) : nameOf((form ? composeModel : !sessionBox() && selectedRequest?.model) || controller.defaultModel());
      const toBot = (target || view === 'chat' && !claim.readOnly) && ask.getValue().trimStart().startsWith('@') ? botMessage(ask.getValue(), savedBots())?.bot.name ?? null : null;
      // A teammate's @name, when no bot has it, makes the text a question to them.
      // @name of another computer of mine first in the new session box starts the session there, before a teammate's @name.
      const toMachine = !toBot && !remoteHere() && (sessionBox() || composing()) && ask.getValue().trimStart().startsWith('@') && !TO_MODEL.test(ask.getValue().trimStart()) ? remoteApp.named(ask.getValue().trim().split(/\s+/)[0])?.name ?? null : null;
      const toPerson = !toBot && !toMachine && (sessionBox() || view === 'chat') && ask.getValue().trimStart().startsWith('@') ? teammateNamed(ask.getValue().trim().split(/\s+/)[0])?.name ?? null : null;
      // With no @name the text goes to the bot the owner last wrote to in this session; @model goes to the model.
      const stays = !toBot && !toPerson && task && view === 'chat' && !selectedRequest && !claim.readOnly && !TO_MODEL.test(ask.getValue().trimStart()) ? addressedBot(task, snapshot.queue ?? []) : null;
      // Beside the list the box is narrow: the label gives up its bots, then its last part, before it would wrap into the text.
      const fits = (...parts) => { for (let count = parts.length; count > 1; count--) { const text = ` ${parts.slice(0, count).join('')} `; if (text.length <= ask.width - 4) return text; } return ` ${parts[0]} `; };
      // A message that starts with ! is a shell command; the label says where it runs.
      const said = (ask.getValue().trimStart().startsWith('!') ? ` Run in ${clip(shortHome(shellPlace().cwd), 40)} · Enter runs it `
        : view === 'chats' ? !chatOpen ? ' Ask your team, or @name one teammate ' : chatOpen.type === 'room' ? ` Message #${chatOpen.name} · the first teammate to take it answers ` : chatOpen.type !== 'bot' ? ` Message ${peerName(chatOpen.name, chatOpen.key)} ` : chatOpen.peer ? ` Message @${chatOpen.name} on ${botHome(chatOpen)} · runs after ${peerName(chatOpen.owner, chatOpen.peer)} accepts it ` : ` Message @${chatOpen.name} · it answers in its own session `
        : toBot ? ` Message @${toBot} `
        : stays ? fits(`Message @${stays}`, ` · @model writes to ${toModel}`)
        : toMachine ? fits(`New session on @${toMachine}`, ' · your other computer')
        : toPerson ? ` Ask @${toPerson} · teammate `
        : remoteHere() ? remoteApp.label(remoteHere())
        : sessionBox() ? target ? toModel ? fits(`New session → ${toModel}`, ` · ${projectName(target)}`) : ` New session · ${projectName(target)} ` : ' New session · Enter creates a project first '
        : view === 'kanban' ? controller ? ` Add a task to To do · ${snapshot.name} ` : ' Create a project first: n in the Projects tab '
        : claim.readOnly ? ' Read only · / for commands ' : composing() ? composeWhen ? fits(`Schedule → ${toModel}`, ` · ${composeWhen.label}`, ` · ${snapshot.name}`) : fits(`New session → ${toModel}`, ` · ${snapshot.name}`, withBots) : mode ? fits(`Message ${toModel}`, ` · ${LABELS[mode]}`, withBots) : fits(`Message ${toModel}`, withBots));
      // The label is plain text, but for the bots it names: each in its own colour.
      const named = withBots && said.endsWith(`${withBots} `) ? said.length - withBots.length - 1 : said.length;
      ask.setLabel(blessed.escape(said.slice(0, named)) + (named < said.length ? ` · with ${paintBots(botNames(inChat))} ` : ''));
      const typing = screen.focused === ask;
      ask.style.border.fg = typing ? accent : shade('border'); ask.style.label.fg = typing ? accent : muted;
      // Status row: the last message, else what the open task is doing. The key bar below never hides it.
      const card = kanbanLists.includes(screen.focused) && kanbanData[kanbanLists.indexOf(screen.focused)]?.items[screen.focused.selected ?? 0];
      const quiet = card ? [card.title, card.note ?? card.detail].filter(Boolean).join('  ·  ') : task ? [task.state === 'needs_input' ? 'waiting for your answer' : task.state, snapshot.requests?.length ? `${snapshot.requests.length} saved` : ''].filter(Boolean).join(' · ') : '';
      // Beside the list the row is short. A message too long for it takes a second row from the chat above.
      // A lead that waits for an allow or deny says so here first, with the keys before the
      // command so a narrow row still shows them. The last message goes below it, on two
      // rows when one is too short for it.
      const asked = task ? approvalsFor(task)[0] : null;
      const long = listed() && message.length + 2 > status.width;
      // With f the row is longer: where it would not fit, or would leave no room for what is asked, it starts at Esc.
      const askForms = asked && (offersFull(task, asked) || offersAlways(task, asked)) ? [`? Needs you · Esc, then ${approvalKeys(task, asked)}`, `? Esc, then ${approvalKeys(task, asked)}`] : ['? Needs you · Esc, then y allow · n deny'];
      const askKeys = askForms.find(form => status.width - form.length - 3 >= 12) ?? askForms.find(form => form.length <= status.width) ?? askForms.at(-1), askText = status.width - askKeys.length - 3 >= 12 && asked?.summary ? ` · ${asked.summary}` : '';
      if (asked) status.setContent([ink(clip(askKeys + askText, status.width), 'orange', colour, true), message ? ink(`› ${long ? fitWords(plain(message), status.width * 2 - 4) : clip(message, status.width - 2)}`, 'text', colour) : ''].filter(Boolean).join('\n'));
      else status.setContent(message ? ink(`› ${long ? fitWords(plain(message), status.width * 2 - 4) : clip(message, status.width - 2)}`, 'text', colour) : ink(clip(quiet, status.width), 'muted', colour));
      const tall = (asked ? 1 : 0) + (message ? long ? 2 : 1 : asked ? 0 : 1);
      if (status.height !== tall) { Object.assign(status, { top: g.statusTop - tall + 1, height: tall }); activity.height = compose.height = g.statusTop - g.top - tall + 1; }
      // A Task that waits for approval says so here as an approval does: first, with the last
      // message on a second row. An approval of an action in the same session comes before it.
      if (!asked && task?.plan?.state === 'proposed') {
        const two = message ? 2 : 1;
        status.setContent([ink(clip(taskNeedsYou(task.plan), status.width), 'orange', colour, true), message ? ink(`› ${clip(message, status.width - 2)}`, 'text', colour) : ''].filter(Boolean).join('\n'));
        if (status.height !== two) { Object.assign(status, { top: g.statusTop - two + 1, height: two }); activity.height = compose.height = g.statusTop - g.top - two + 1; }
      }
      drawSessionViews(task);
      keysBar.setContent(keyHints(keyPairs(), W - 2, colour));
      for (const list of [board, composeList, ...teamLists, botsList, projectsList, usageList]) Object.assign(list.style.selected, screen.focused === list ? selection : QUIET);
      for (const [panel, owner] of [[boardBox, board], [activity, activity], [botsBox, botsList], [projectsBox, projectsList], [usageBox, usageList]]) panel.style.border.fg = screen.focused === owner ? accent : shade('border');
      if (chatNow === null ? screen.focused !== activity : !held) activity.setScrollPerc(100);
      if (modal) modal.setFront();
      syncPalette();
      const next = frame(); if (idle !== true || next !== lastFrame) { lastFrame = next; screen.render(); }
      // view names the tab: Sessions is 'tasks' whatever shows beside its list, and 'chat' is a session opened from Kanban.
      // session is what shows as a chat: a session's number, 'new' for the form, 'request' for a message not started yet.
      onRender?.({ screen, selection: mouseSelection, snapshot, panels: { header, brand, pills, tabs, newCard, newBot, newProject, kanbanBoxes, kanbanLists, kanbanOff, kanbanTeam, kanbanTeamList, back, board, boardBox, compose, composeList, composeHint, activity, chat: activity, changes: changesBox, sessionTabs, status, keys: keysBar, palette, ask, teamBoxes, teamLists, teamOff, botsBox, botsList, projectsBox, projectsList, usageBox, usageList }, controller, view: listed() ? 'tasks' : view, session: view !== 'chat' ? null : selectedId ?? (composing() ? 'new' : 'request'), sessionView: changesBox.hidden ? 'chat' : 'changes' });
    } catch (error) { header.setContent(displayText(clip(error.message, screen.width))); screen.render(); }
    finally { drawing = false; }
  }
  // Bots: one row per saved bot. The selected bot keeps its row while the list changes; a
  // new one takes the cursor once.
  function drawBots() {
    const width = Math.max(20, botsList.width - 2), kept = botJump ?? botRows[botsList.selected ?? 0]?.name; botJump = null;
    let lines;
    try { botRows = listBots(); lines = botLines(botRows, width, colour, botModelName); }
    catch (error) { botRows = []; lines = [ink(` ${clip(error.message, width - 1)}`, 'orange', colour)]; }
    if (lines.join('\n') !== botsList.ritems?.join('\n')) botsList.setItems(lines);
    const found = kept === undefined ? -1 : botRows.findIndex(bot => bot.name === kept);
    botsList.select(found >= 0 ? found : Math.max(0, Math.min(botsList.selected ?? 0, botRows.length - 1)));
  }
  // Projects: one row per project: name, folder, sessions, last activity. The active one is
  // first and in the accent; the rest keep their order. The selection stays on its project
  // while the list changes.
  function drawProjects() {
    const width = Math.max(20, projectsList.width - 2), kept = projectRows[projectsList.selected ?? 0]?.root, now = Date.now();
    const top = controller?.repo.root;
    projectRows = [...snapshot.projects].sort((a, b) => (b.root === top) - (a.root === top));
    const lastActivity = project => {
      const times = [...project.activity.map(row => row.at), ...project.tasks.map(task => task.createdAt)].map(value => Date.parse(value)).filter(Number.isFinite);
      return times.length ? relativeTime(new Date(Math.max(...times)).toISOString(), now) : 'no activity';
    };
    const lines = projectRows.length ? projectRows.map(project => {
      // ● marks the active project: the one in the header, which new sessions and Kanban use.
      const active = project.root === controller?.repo.root, name = ink(`${active ? '●' : ' '} ${clip(project.name, 22).padEnd(24)}`, active ? 'orange' : 'text', colour, true);
      if (project.unavailable) return name + ink('unavailable', 'muted', colour);
      const sessions = project.tasks.filter(task => !project.closed?.includes(task.id)).length, tail = `${sessions} session${sessions === 1 ? '' : 's'}`.padEnd(13) + lastActivity(project);
      const room = Math.max(4, width - 26 - tail.length - 2);
      return name + ink(clip(shortHome(project.root), room).padEnd(room + 2), 'muted', colour) + ink(tail, 'muted', colour);
    }) : [ink(' No projects yet. n creates one.', 'muted', colour)];
    if (lines.join('\n') !== projectsList.ritems?.join('\n')) projectsList.setItems(lines);
    const found = kept === undefined ? -1 : projectRows.findIndex(project => project.root === kept);
    projectsList.select(found >= 0 ? found : Math.max(0, Math.min(projectsList.selected ?? 0, projectRows.length - 1)));
  }
  // Usage: one block per vendor, then today's spend. The data is read again when the saved
  // usage changes or a check finishes; the selected vendor keeps its row.
  const usageReaders = () => ({ env: usage.env, readFile: usage.readFile });
  const usageVendors = () => { if (usage.vendors) return usage.vendors(); try { return vendorList.kept() ?? vendorList.read(() => detect(controller?.repo.root ?? startDirectory)); } catch { return []; } };
  function drawUsage(now) {
    const key = JSON.stringify(snapshot.usage);
    if (!usageData || key !== usageKey) { usageKey = key; usageData = usageTab({ vendors: usageVendors(), env: usage.env, readFile: usage.readFile, now }); }
    const width = Math.max(20, usageList.width - 2), kept = usageRows[usageList.selected ?? 0]?.vendor;
    const total = todayCost(snapshot.projects, new Date(now));
    usageRows = [...usageBlocks(usageData, { now: new Date(now) }), { vendor: null, text: `ELU Code spend today ${total}`, tone: 'muted' }];
    const lines = usageRows.map(row => ink(clip(row.text, width), row.tone, colour, row.bold));
    if (lines.join('\n') !== usageList.ritems?.join('\n')) usageList.setItems(lines);
    const found = kept === undefined ? -1 : usageRows.findIndex(row => row.vendor === kept);
    usageList.select(found >= 0 ? found : Math.max(0, Math.min(usageList.selected ?? 0, usageRows.length - 1)));
  }
  // The tab's check: when it opens and the last one is older than two minutes, or on r.
  async function refreshUsageTab(force = false) {
    if (usageBusy || closing || (!force && !usageStale())) return;
    usageBusy = true; setMessage('Checking usage…');
    try {
      await refreshUsage({ force, ...usageReaders(), signal: usageAbort.signal });
      usageData = null;
      if (!closing) setMessage(`Usage updated ${clockTime(Date.now())}`);
    } finally { usageBusy = false; usageData = null; draw(); }
  }
  // Enter on a vendor's rows opens its details; r checks again now.
  async function usageAction(action) {
    if (action === 'refresh') return refreshUsageTab(true);
    const vendor = usageRows[usageList.selected ?? 0]?.vendor, row = usageData?.find(item => item.vendor === vendor);
    if (!row) return;
    await prompt(`${USAGE_NAMES[vendor]} usage`, usageDetailLines(row, new Date()).join('\n'));
  }
  function focusInput() { if (!closing && !modal) { ask.focus(); ask.readInput(); } }
  // Moves to the view's main pane, or to its buttons when it has none.
  function focusContent(index = 0) {
    if (modal) return;
    if (ask._reading) ask.cancel();
    const panes = viewPanes(), remembered = view === 'chats' && panes.includes(lastPane.chats) ? lastPane.chats : view === 'kanban' && panes.includes(lastPane.kanban) ? lastPane.kanban : null;
    const next = remembered ?? panes[Math.min(index, panes.length - 1)] ?? subButtons()[0] ?? activeTab();
    if (next === board) focusBoard(); else next.focus();
    draw();
  }
  function syncPalette() {
    const value = ask.getValue(), bang = value.trimStart().startsWith('!');
    // The label changes when the text becomes, or stops being, a shell command.
    if (bang !== shellTyped) { shellTyped = bang; if (!drawing) scheduleDraw(); }
    // So does a saved bot's @name at the start.
    const bot = value.trimStart().startsWith('@') && (sessionBox() || view === 'chat') ? botMessage(value, savedBots())?.bot.name ?? null : null;
    if (bot !== botTyped) { botTyped = bot; if (!drawing) scheduleDraw(); }
    // And a teammate's, when no bot has that name.
    const person = !bot && value.trimStart().startsWith('@') && (sessionBox() || view === 'chat') ? teammateNamed(value.trim().split(/\s+/)[0])?.name ?? null : null;
    if (person !== personTyped) { personTyped = person; if (!drawing) scheduleDraw(); }
    // And @model, which writes to the session's model.
    const own = TO_MODEL.test(value.trimStart());
    if (own !== modelTyped) { modelTyped = own; if (!drawing) scheduleDraw(); }
    if (value !== paletteDismissed) paletteDismissed = null;
    // Rows: a command, or the next word of one (/model default, then a model).
    // more: choosing it fills it in and keeps going instead of running it.
    const values = screen.focused === ask && !modal && value !== paletteDismissed ? [
      ...commandMatches(value).map(command => ({ value: `/${command.name}`, label: `/${command.name}`, description: command.description, more: needsArgument(command), usage: command.usage })),
      ...argumentMatches(value, paletteContext).map(row => ({ ...row, label: row.word })),
      ...(view === 'chats' ? mentionMatches(value, paletteContext) : sessionBox() || view === 'chat' ? sessionMentions(value, paletteContext) : []).map(row => ({ ...row, label: row.word })),
    ] : [];
    const changed = values.map(row => row.value).join() !== paletteValues.map(row => row.value).join();
    paletteValues = values; palette.hidden = values.length === 0;
    const lastText = paletteText; paletteText = value;
    if (values.length) {
      const g = geometry(screen.width, screen.height);
      palette.height = Math.min(values.length + 2, 10, g.askTop - g.top); palette.top = g.askTop - palette.height;
      Object.assign(palette, { left: 1, width: g.width - 2 });
      // Typing a whole command name selects it, so /archive runs /archive, not /archived.
      const exact = value !== lastText ? values.findIndex(row => row.value === value.trim().toLowerCase()) : -1;
      const selected = exact >= 0 ? exact : changed ? 0 : palette.selected ?? 0;
      palette.setItems(values.map(row => clip(`${row.label.padEnd(14)} ${row.description}`, palette.width - 4)));
      palette.items.forEach((item, index) => {
        item.removeAllListeners('click');
        item.on('click', () => catchAction(() => { if (values[index].more) choosePalette(values[index]); else return submit(values[index].value); }));
      });
      palette.select(Math.min(selected, values.length - 1)); palette.setFront();
    }
  }
  // Fills in a row that needs more words and shows what can come next.
  function choosePalette(row) {
    focusInput(); ask.setValue(`${row.value} `); syncPalette();
    if (row.usage) setMessage(`Usage: ${row.usage}`);
    draw();
  }
  // What the command list suggests after a command name. Vendor checks start programs, so one
  // list serves the session: /model add reads the copy. A vendor's one-time check that ran
  // since then changed what the list says, so it is read again.
  const vendorList = vendorReading();
  const cachedVendors = () => { if (!controller) return []; return vendorList.kept() ?? vendorList.read(() => controller.vendors()); };
  // The open session, and the bots in it; in the new session form, the ones it will start with.
  const openTask = () => controller && view === 'chat' && selectedId && !selectedRequest ? controller.snapshot().tasks.find(row => row.id === selectedId) ?? null : null;
  const chatBotsNow = () => { if (view !== 'chat') return []; if (composing()) return composeBots; const task = openTask(); return task ? botsOf(task) : []; };
  // The model in view: the open session's, else the one a new session starts with.
  const modelNow = () => { if (!controller) return null; const task = openTask(); return (task ? sessionModel(controller.repo, task) : composing() ? composeModel : null) ?? controller.defaultModel(); };
  const paletteContext = {
    // The open session's model, as @model reaches it; null where no session is open.
    model: () => { const task = view === 'chat' && controller && selectedId && !selectedRequest ? (snapshot?.tasks ?? []).find(row => row.id === selectedId) : null; return task ? modelOf(task) : null; },
    // The models a session can be given, with a mark on the one in use.
    models: () => { const choices = modelChoices(), now = modelNow(), current = now ? choiceName(now, choices) : null; return choices.map(row => ({ name: row.name, vendor: row.vendor, note: row.note, current: row.name === current })); },
    servers: () => controller ? controller.servers() : { all: [], on: [] },
    bots: () => { const here = chatBotsNow(); return savedBots().map(bot => ({ name: bot.name, about: bot.about, here: here.includes(bot.name), scheduled: Boolean(bot.schedule), color: botColor(bot) })); },
    teammates: () => {
      const status = peerRead('peerStatus'), members = new Map();
      for (const member of (status?.teams ?? []).flatMap(row => row?.members ?? [])) if (member?.key && member.key !== status.key && /^[^\s@/\\]{1,64}$/.test(member.name ?? '')) members.set(member.key, { name: member.name, online: Boolean(member.online), path: remote(member.path, 10) });
      return [...members.values()];
    },
    // The teammates /invite can add to the open channel, by the name the screen shows them under.
    invitees: () => { const room = openChannel(); return room ? { channel: room.name, people: outsiders(room).map(member => ({ name: peerName(member.name, member.key).slice(1), online: Boolean(member.online) })) } : null; },
  };
  // The teammate a leading @name means: the exact name first, then the same letters in any case.
  const teammateNamed = word => {
    if (!/^@[^\s@]+$/.test(word ?? '')) return null;
    const name = word.slice(1), rows = paletteContext.teammates();
    return rows.find(row => row.name === name) ?? rows.find(row => row.name.toLowerCase() === name.toLowerCase()) ?? null;
  };
  function showView(next) {
    if (!['tasks', 'projects', 'kanban', 'chats', 'bots', 'usage', 'chat'].includes(next)) throw new Error('Choose Sessions, Projects, Kanban, Chats, Bots, or Usage.');
    if (next === 'chat' && !controller) throw new Error(NO_PROJECT);
    rememberDraft(); view = next; message = ''; ask.clearValue();
    if (next !== 'chat') selectedRequest = null;
    // Sessions shows its cursor's row again. A row of a project that is no longer the active one gives way to + New session.
    if (next === 'tasks') { returnTo = 'tasks'; openKey = null; if (controller && barKey !== NEW && !barKey.startsWith(`${controller.repo.root}\0`)) barKey = NEW; }
    if (next === 'usage') usageData = null;
    restoreDraft(); resize();
    if (next === 'usage') catchAction(() => refreshUsageTab());
  }
  // Waits for the daemon's answer, so a refusal (an unknown teammate, a secret in a diff)
  // reaches the status line instead of a success message.
  // My bots, for the Chats bar. A bots file that cannot be read shows none here; the Bots tab says why.
  const myBots = () => { try { return listBots(); } catch { return []; } };
  // Where a teammate's bot runs: their machine's name, or their own name when they sent none.
  const botHome = bot => remote(bot.box, 32) || peerName(bot.owner, bot.peer);
  const peerCommand = async command => {
    if (!facade?.sendPeerCommand) throw new Error(PEER_MISSING);
    if (peerRead('peerStatus')?.running !== true) throw new Error(PEER_STOPPED);
    // A picture the message names goes with it (lib/peer/pictures.mjs); over a limit this throws its one line.
    if (typeof facade.withPictures === 'function') command = facade.withPictures(command);
    const { id } = facade.sendPeerCommand(command);
    return facade.awaitCommand ? facade.awaitCommand(id, 10000) : null;
  };
  // The daemon's answer to a send: a path outside the repo was cut for an untrusted teammate,
  // which the owner learns about here, or the usual line.
  const withCount = (result, line) => Number.isInteger(result?.pictures) && result.pictures > 0 ? line.replace('. ', ` with ${result.pictures === 1 ? '1 picture' : `${result.pictures} pictures`}. `) : line;
  const sentLine = (result, who, line) => setMessage(result?.pathsCut === true ? `Paths outside the repo were replaced with [path]. Trust ${who} to keep them.` : withCount(result, line));
  // The vendor of the model in view, for the picker's relay line.
  const leadVendor = () => { try { return modelNow()?.vendor ?? null; } catch { return null; } };
  // A vendor without a live relay here reports blocked actions instead.
  function relayLine(vendor) {
    if (!VENDORS.includes(vendor)) return [];
    const caps = CAPS[vendor], name = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', grok: 'Grok' }[vendor] ?? VENDOR_NAMES[vendor];
    let live = caps.relay === 'mcp';
    if (caps.relay === 'acp') { try { live = conformanceState(vendor)?.relay === true; } catch { live = false; } }
    return live ? [] : [`${name} can't ask live. Blocked actions are reported.`];
  }
  // Asked once for this run of the app: the answer starts a program, and the picker is drawn often.
  let shellNote = null;
  const shellLine = () => (shellNote ??= shellSandboxLine());
  // The Permissions picker: 1 ask, 2 auto, 3 full with its confirm. null when cancelled.
  async function pickMode({ schedule = false, vendor = leadVendor() } = {}) {
    const choices = ['ask', 'auto', ...(schedule ? [] : ['full'])];
    const body = [...choices.map((mode, index) => PICK(String(index + 1), LABELS[mode], MODE_TEXT[mode])), PICK('r', 'Without asking', 'The defaults and the rules you kept with a.'), '', ...(schedule ? [SCHEDULE_CAP] : []), ...relayLine(vendor), ...shellLine(), '/permissions folders add <path> lets the model read one more folder.'].join('\n');
    const answer = (await prompt('Permissions', body, '', { keys: [...choices.map((_, index) => String(index + 1)), 'r'] }))?.trim().toLowerCase();
    if (!answer) return null;
    if (answer === 'r') { await rulesDialog(); return null; }
    const mode = MODES.includes(answer) ? answer : choices[Number(answer) - 1];
    if (!mode) throw new Error(`Choose 1 to ${choices.length}.`);
    checkMode(mode, { allowFull: !schedule });
    if (mode === 'full' && !await confirmFull()) return null;
    return mode;
  }
  const confirmFull = () => yes('Full access', 'Full access: the model changes any file, runs any command and uses the internet without asking.\nPush, tag, merge, deploy and publish stay blocked.', 'Use it? y/N');
  // The Runs in picker: a new worktree, a named branch, or your checkout (Full access only).
  async function pickPlace({ mode }) {
    const body = [PICK('1', PLACE_LABEL.worktree, PLACE_TEXT.worktree), PICK('2', PLACE_LABEL.branch, PLACE_TEXT.branch), PICK('3', PLACE_LABEL.here, PLACE_TEXT.here)].join('\n');
    const answer = (await prompt('Runs in', body, '', { keys: ['1', '2', '3'] }))?.trim().toLowerCase();
    if (!answer) return null;
    const kind = { 1: 'worktree', 2: 'branch', 3: 'here', worktree: 'worktree', branch: 'branch', here: 'here' }[answer];
    if (!kind) throw new Error('Choose 1 to 3.');
    if (kind !== 'branch') return checkPlace(kind, { mode });
    const branch = (await prompt('Branch', 'Branch name. Commits land on it; a worktree checks it out.', ''))?.trim();
    return branch ? checkPlace({ kind, branch }, { mode }) : null;
  }
  // Adds one folder the model may read this session; "none" clears the list. null when cancelled.
  async function pickFolders(current) {
    const body = [...(current.length ? current.map(shortHome) : ['none']), '', 'A folder in your home the model may read this session.', 'none clears the list. Esc keeps it.'].join('\n');
    const answer = (await prompt('Folders', body, ''))?.trim();
    if (!answer) return null;
    return answer === 'none' ? [] : checkFolders([...current, expandHome(answer)]);
  }
  // The picker a teammate's message gets when the owner works on it: the rows of
  // the compose form in one dialog, 1 to 3 change a row, Enter starts it. offered: folders a
  // trusted sender named. null when cancelled.
  async function workPicker({ offered = [] } = {}) {
    let mode = defaultMode(), place = { kind: 'worktree' }, folders = offered, fromMessage = offered.length > 0;
    for (;;) {
      const rows = [`Permissions  ${LABELS[mode].padEnd(22)}1 to change`, `             ${MODE_TEXT[mode]}`,
        `Runs in      ${placeText(place).padEnd(22)}2 to change`, `             ${placeHint(place)}`,
        `Folders      ${folders.length ? `${folders.map(shortHome).join(' ')}  ${fromMessage ? 'from their message · ' : ''}` : 'none'.padEnd(22)}3 to change`, '             Other folders it may read.'];
      const answer = (await prompt('Accept', [...rows, '', 'Enter starts it as your session. Esc leaves it waiting.'].join('\n'), '', { keys: ['1', '2', '3'] }))?.trim();
      if (answer === null || answer === undefined) return null;
      if (answer === '') { checkPlace(place, { mode }); return { permissions: mode, place, folders }; }
      if (answer === '1') { mode = await pickMode() ?? mode; if (place.kind === 'here' && mode !== 'full') place = { kind: 'worktree' }; }
      else if (answer === '2') place = await pickPlace({ mode }) ?? place;
      else if (answer === '3') { const next = await pickFolders(folders); if (next) { folders = next; fromMessage = false; } }
      else throw new Error('Press 1, 2 or 3 to change a row, Enter to start.');
    }
  }
  // Owner decisions on a teammate's message, from Tasks or Threads:
  // - an incoming message: accept (the owner's own session, in a mode they pick now; the
  //   agent answers a question or does the task) through the daemon, or decline. An older
  //   saved request row is removed with its decline.
  // - a held reply or an agent draft lives only with the daemon: y sends, n discards.
  async function decidePeer({ request, item, root }, decision) {
    const who = request ? peerName(request.origin?.name, request.origin?.peer) : threadWho(item);
    if (request || item?.kind === 'incoming') {
      const at = request ? root : item.root, requestId = request?.id ?? item.requestId, id = item?.id ?? request?.origin?.a2aTaskId;
      if (!id) throw new Error('That message is no longer waiting.');
      // y: the session your own prompt would start, in the message's project or, when it
      // came with none, the one open now. w: the same in a mode, place and folders picked now.
      const here = controller ? { root: controller.repo.root } : {};
      if (decision === 'answer') {
        await peerCommand({ type: 'approve', id, ...here });
        setMessage(`Approved ${who}. It runs as your session; the reply goes back to this thread.`); return;
      }
      if (decision === 'work') {
        const picked = await workPicker({ offered: item?.trusted === true ? foldersNamed(item.text) : [] });
        if (!picked) return;
        await peerCommand({ type: 'work', id, permissions: picked.permissions, place: picked.place, folders: picked.folders, ...here });
        setMessage(`Accepted ${who}. It runs as your session; the reply goes back to this thread.`); return;
      }
      if (typeof at === 'string' && at && typeof requestId === 'string') removeRequest(at, requestId);
      await peerCommand({ type: 'discard', id });
      setMessage(`Declined ${who}.`); return;
    }
    if (decision === 'work') throw new Error('w works on a teammate\'s message that waits for you.');
    const accept = decision === 'answer';
    // n on a thread that waits for nothing dismisses it; an open ask is also cancelled with the teammate.
    if (!accept && ['answer', 'asked', 'expired', 'rejected'].includes(item?.kind)) { await peerCommand({ type: 'discard', id: item.id }); setMessage(item.kind === 'asked' ? `Cancelled the ask to ${who}.` : 'Dismissed.'); return; }
    if (!['held', 'draft'].includes(item?.kind)) throw new Error('y works on messages, replies, and drafts that wait for you.');
    const result = await peerCommand({ type: accept ? 'approve' : 'discard', id: item.id });
    if (accept) sentLine(result, who, item.kind === 'held' ? `Sending the reply to ${who}.` : `Sending the ask to ${who}.`); else setMessage('Discarded.');
  }
  // Trust a teammate or remove it, after a confirm.
  async function trustPeer(value) {
    if (value?.type !== 'member' || value.self) throw new Error('Choose a teammate first.');
    const who = peerName(value.name, value.key), trusted = value.trusted ?? peerTrusted(value.key);
    if (trusted) {
      if (!await yes(`Trust ${who}`, `Remove trust for ${who}? Paths go out as [path] again.`, 'y/N')) return;
      await peerCommand({ type: 'untrust', key: value.key }); setMessage(`Removed trust for ${who}. Paths go out as [path].`); return;
    }
    if (!await yes(`Trust ${who}`, `Trust ${who}? Paths on this machine reach theirs as written.\nSecrets are still held back.`, 'y/N')) return;
    await peerCommand({ type: 'trust', key: value.key }); setMessage(`Trusted ${who}. Paths go out as they are. Their text shows as sent.`);
  }
  // Returns the letter pressed when the dialog names keys (y, w, n, c, f, m or t), else null.
  async function peerDetails(value) {
    const text = value => sanitize(value, 160000);
    // Text other than a named letter does nothing, and says so. preselect: the letter Enter picks.
    const keyed = async (title, body, keys = [], { preselect = '', trusted = false } = {}) => {
      const typed = String(await prompt(title, body, preselect, { keys, preselect, trusted }) ?? '').trim().toLowerCase();
      if (keys.includes(typed)) return typed;
      if (typed && keys.length) throw new Error(`Nothing was done. Press ${keys.join(' or ')}.`);
      return null;
    };
    if (value.type === 'member') {
      const trusted = value.trusted ?? peerTrusted(value.key);
      return keyed(`Teammate ${peerName(value.name, value.key)}`, [`Key: ${value.key}`, `Fingerprint: ${text(value.member.fingerprint)}`, `Team: ${text(value.team?.name)}`, `Role: ${text(value.member.role)}`, `State: ${value.self ? 'you' : value.member.online ? `online, ${text(value.member.path ?? 'direct')}` : 'offline'}`, `Last seen: ${relativeTime(value.member.lastSeen)}`, ...(value.self ? [] : [trusted ? 'Trust: trusted · paths go out as they are.' : 'Trust: not trusted · paths go out as [path].', '', trusted ? 't removes trust' : 't trusts them'])].join('\n'), value.self ? [] : ['t']);
    }
    if (value.type === 'agent') return keyed(`Sessions of ${peerName(value.name, value.peer)}`, value.row ? [`${text(value.row.handle)} ${text(value.row.label)}`, text(value.row.now), '', 'Overlap with your work:', ...(value.row.overlap ?? []).map(text), '', 'Changed files:', ...(Array.isArray(value.row.files) ? value.row.files.slice(0, 200).map(text) : [])].join('\n') : 'No live sessions.');
    // Any message is accepted the same way: it runs as the owner's session.
    const [hint, keys, preselect] = value.kind === 'answer' ? ['c continues in the chat with this answer.', ['c'], ''] : value.kind === 'incoming' ? ['y approves: it starts as if you typed it. w picks the mode first. n declines.', ['y', 'w', 'n'], 'y'] : ['held', 'draft'].includes(value.kind) ? ['y sends. n discards.', ['y', 'n'], ''] : ['', [], ''];
    // The thread reads like a chat: who said what, oldest first, from the thread's log.
    let messages = []; try { messages = value.threadId && typeof facade?.threadMessages === 'function' ? facade.threadMessages(value.threadId) : []; } catch { messages = []; }
    const TAG = { ask: 'question', review: 'review', handoff: 'task', answer: 'answer', held: 'answer', blocked: 'answer' };
    const head = m => [`${TAG[m.kind] === 'answer' ? '↳ ' : ''}${m.from === 'peer' ? peerName(m.name, m.peer) : m.held ? 'your model' : 'you'}`, TAG[m.kind] ?? text(m.kind), ...(m.held ? [m.blocked ? 'held: possible secret' : 'not sent yet'] : []), clockTime(m.at)].join(' · ');
    const talk = messages.length ? messages.flatMap(m => m.from === 'note' ? [`(${text(m.text)})`, ''] : [head(m), text(m.text), '']) : [text(value.text), ''];
    return keyed(`Thread with ${threadWho(value)}`, [`Project: ${text(value.project) || 'not named'}`, '', ...talk, hint].join('\n').trimEnd(), keys, { preselect, trusted: value.trusted === true });
  }
  // Panes: 0 the bar (channels, then teammates with their live agents), 1 Threads.
  async function teamAction(index, action) {
    const value = teamRows[index][teamLists[index].selected ?? 0]?.value;
    // The bar: Enter on a channel or a person moves to the message box; the add rows start their flow.
    if (index === 0) {
      if (action === 'decline') action = 'new';
      if (action === 'open' && value?.type === 'add') action = value.what === 'channel' ? 'new' : 'invite';
      if (action === 'open' && value?.target) { focusInput(); draw(); return; }
      if (action === 'new') return newChannel();
      if (action === 'invite') return peerSlash({ name: 'invite', args: [] });
    }
    // m and x act on the channel under the cursor in the bar, and on the open channel from its threads.
    if (['members', 'leave'].includes(action)) {
      const room = index === 0 ? value : chatOpen;
      if (room?.type === 'room' && room.channel) return action === 'members' ? channelMembers(room) : leaveChannel(room);
      if (room?.type === 'room' && action === 'members') { setMessage('Everyone on the team is in #general. + Add teammate invites someone.'); return; }
      if (index === 0) throw new Error('Choose a channel you made or were added to. #general is everyone.');
      return;
    }
    if (action === 'open') {
      if (index === 0 && value?.type !== 'agent') return;
      else {
        const key = value ? await peerDetails(value) : null, next = { y: 'accept', w: 'work', n: 'decline', c: 'continue', t: 'trust' }[key];
        return next ? teamAction(index, next) : undefined;
      }
    }
    if (['accept', 'decline', 'work'].includes(action)) { if (index !== 1 || !value) throw new Error('Choose a thread that waits for you.'); return decidePeer({ item: value }, action === 'accept' ? 'answer' : action); }
    // t shows the teammate with their Trust line; t there confirms the change.
    if (action === 'trust') {
      if (index !== 0 || value?.type !== 'member' || value.self) throw new Error('Choose a teammate first.');
      return await peerDetails(value) === 't' ? trustPeer(value) : undefined;
    }
    if (action === 'ask') {
      if (index !== 0 || !['member', 'agent'].includes(value?.type)) throw new Error('Choose a teammate first.');
      focusInput(); ask.setValue(`@${peerName(value.name, value.peer ?? value.key).slice(1)} `); draw(); return;
    }
    if (action === 'continue') { if (index !== 1 || value?.kind !== 'answer') throw new Error('c continues with an answer. Choose one in Threads.'); await peerCommand({ type: 'continue', id: value.id }); setMessage('Continuing in the chat with the answer.'); return; }
  }
  // Channels. A channel is made on a team from the people already on it, and reaches them
  // as a signed change to the team's roster.
  const myKey = () => peerRead('peerStatus')?.key ?? null;
  async function pickMembers(title, people, chosen, done) {
    const picked = new Set(chosen);
    for (let selected = 0; ;) {
      const rows = [...people.map(person => ink(`${picked.has(person.key) ? '[x]' : '[ ]'} ${peerName(person.name, person.key)}`, 'text', colour)), ink(done, 'text', colour, true)];
      const choice = await listDialog(title, rows, { selected, hint: 'enter tick or finish · esc cancel' });
      if (!choice) return null;
      if (choice.index === people.length) return [...picked];
      const { key } = people[choice.index]; if (picked.has(key)) picked.delete(key); else picked.add(key);
      selected = choice.index;
    }
  }
  // Which of my bots teammates may write to, in one line. With none shared, their messages come to me.
  const botsLine = () => {
    if (!myBots().some(bot => canShare(bot.vendor))) return '';
    const shared = myBots().filter(bot => bot.shared && canShare(bot.vendor)).map(bot => `@${bot.name}`);
    return shared.length ? `Teammates can write to ${shared.join(', ')}.` : 'No bot is shared, so a teammate’s message comes to you.';
  };
  async function shareBots() {
    const bots = myBots().filter(bot => canShare(bot.vendor)); if (!bots.length) return '';
    const picked = await pickMembers('Bots your teammates can use', bots.map(bot => ({ key: bot.name, name: bot.name })), bots.filter(bot => bot.shared).map(bot => bot.name), 'Done');
    if (picked) for (const bot of bots) if (bot.shared !== picked.includes(bot.name)) saveBot({ ...bot, shared: picked.includes(bot.name) });
    return botsLine();
  }
  async function newChannel() {
    const teams = (peerRead('peerStatus')?.teams ?? []).filter(team => (team.members ?? []).some(member => member.key !== myKey()));
    if (!teams.length) throw new Error('Add a teammate first: /invite.');
    const picked = teams.length === 1 ? { index: 0 } : await listDialog('Team for the channel', teams.map(team => ink(remote(team.name, 40) || 'Team', 'text', colour)));
    if (!picked) return;
    const team = teams[picked.index], people = team.members.filter(member => member.key !== myKey());
    const name = (await prompt('New channel', 'Name it with lowercase letters, digits, - or _. Up to 30 characters.\nNext you choose who is in it.'))?.trim().replace(/^#/, '').toLowerCase();
    if (!name) return;
    if (!/^[a-z0-9][a-z0-9_-]{0,29}$/.test(name) || name === 'general') throw new Error('Name a channel with 1 to 30 lowercase letters, digits, - or _. general is taken.');
    const members = await pickMembers(`Who is in #${name}`, people, [], 'Create channel');
    if (!members) return;
    if (!members.length) throw new Error('Tick at least one teammate, then Create channel.');
    const result = await peerCommand({ type: 'channelSet', team: team.id, name, members: [myKey(), ...members] });
    if (result?.id) chatJump = roomTarget(team.id, result.id);
    setMessage(`Created #${name} with ${members.length} teammate${members.length === 1 ? '' : 's'}. They see it when they are online.`); draw();
  }
  // The channel the message box writes to. #general, a direct message and a bot's chat are not one.
  const openChannel = () => view === 'chats' && teamOn && chatOpen?.type === 'room' && chatOpen.channel ? chatOpen : null;
  // The teammates on a channel's team who are not in it.
  const outsiders = room => ((peerRead('peerStatus')?.teams ?? []).find(row => row.id === room.team)?.members ?? []).filter(member => member.key !== myKey() && !room.members.includes(member.key));
  // Who is in a channel besides me, saved as one signed change to the team's roster.
  const saveChannel = (room, others) => peerCommand({ type: 'channelSet', team: room.team, id: room.channel, name: room.name, members: [myKey(), ...others] });
  async function channelMembers(room) {
    const team = (peerRead('peerStatus')?.teams ?? []).find(row => row.id === room.team); if (!team) throw new Error('That team is gone.');
    const people = team.members.filter(member => member.key !== myKey());
    const members = await pickMembers(`Who is in #${room.name}`, people, room.members.filter(key => key !== myKey()), 'Save');
    if (!members) return;
    if (!members.length) throw new Error('Tick at least one teammate. To leave the channel, press x on it.');
    await saveChannel(room, members);
    setMessage(`#${room.name} now has ${members.length} teammate${members.length === 1 ? '' : 's'} and you.`); draw();
  }
  // /invite with a name: one teammate joins the open channel, the change m makes for them.
  // Where there is nobody to add, one line says why, and what plain /invite is for.
  async function inviteToChannel(word) {
    const typed = `@${word.replace(/^@+/, '')}`, fresh = '/invite alone makes a code for someone new.', shown = member => peerName(member.name, member.key);
    const status = peerRead('peerStatus'), teams = status?.teams ?? [];
    if (!teams.some(team => (team.members ?? []).some(member => member.key !== status.key))) throw new Error(`No teammates yet. ${fresh}`);
    const room = openChannel(), open = view === 'chats' && teamOn ? chatOpen : null;
    if (!room && open?.type === 'room') throw new Error(`Everyone is in #general already. ${fresh}`);
    if (!room && open?.type === 'member') throw new Error('A direct message is just the two of you. Open a channel to add a teammate.');
    if (!room && open?.type === 'bot') throw new Error('A bot’s chat has no members. Open a channel to add a teammate.');
    if (!room) throw new Error('Open a channel in Chats first: /invite @name adds a teammate to it.');
    // The exact name first, then the same letters in any case.
    const named = rows => { const same = rows.filter(member => shown(member) === typed); return same.length ? same : rows.filter(member => shown(member).toLowerCase() === typed.toLowerCase()); };
    const out = outsiders(room), found = named(out);
    if (found.length > 1) throw new Error(`Two teammates are called ${typed}. Press m on #${room.name} and tick the one you mean.`);
    if (!found.length) {
      const inside = named((teams.find(team => team.id === room.team)?.members ?? []).filter(member => member.key !== status.key && room.members.includes(member.key)));
      if (inside.length) throw new Error(`${shown(inside[0])} is already in #${room.name}.`);
      if (!out.length) throw new Error(`Everyone is in #${room.name} already. ${fresh}`);
      throw new Error(`No teammate ${typed} to add to #${room.name}. Not in it yet: ${out.slice(0, 5).map(shown).join(', ')}${out.length > 5 ? ` and ${out.length - 5} more` : ''}.`);
    }
    await saveChannel(room, [...room.members.filter(key => key !== myKey()), found[0].key]);
    setMessage(`Added ${shown(found[0])} to #${room.name}.`); draw();
  }
  async function leaveChannel(room) {
    const others = room.members.filter(key => key !== myKey());
    if (!await yes(`Leave #${room.name}`, others.length ? 'You stop getting its messages. The others stay in it.' : 'You are the last one in it, so the channel is removed.', 'y/N')) return;
    await peerCommand({ type: 'channelSet', team: room.team, id: room.channel, name: room.name, members: others });
    setMessage(`Left #${room.name}.`); draw();
  }
  // Leaving a team, and removing a teammate: one signed change to the team's roster, made by
  // the facade the CLI uses too (index.teamChange). It starts the daemon when it is not
  // running, refuses while a daemon of another version will not stop, sends the change to the
  // teammates online now, writes it here only when the daemon cannot start, and stops a
  // daemon left on no team with nothing to tell.
  async function teamChange(command) {
    setMessage('Connecting…'); draw();
    return facade.teamChange(command);
  }
  // What became of a change: told now, told by the daemon when a teammate connects, or
  // written here only because the daemon could not start.
  const leaveNote = result => result?.told === false && result.daemon === false ? ' Your teammates were not told, since the peer daemon could not start. It tells them once it can.'
    : result?.told === false ? ' No teammate was online, so the first one to connect is told.'
      : result?.stopping ? ' You are on no team now, so the peer daemon stops.' : '';
  async function leaveTeam(args) {
    const status = peerRead('peerStatus'), teams = status?.teams ?? [], wanted = args.join(' ');
    if (!teams.length) throw new Error('You are not on a team.');
    const team = wanted ? teams.find(row => row.id === wanted || row.name === wanted) ?? teams.find(row => String(row.name).toLowerCase() === wanted.toLowerCase()) : teams.length === 1 ? teams[0] : null;
    if (!team) throw new Error(wanted ? `You are not on a team called ${remote(wanted, 40)}.` : `You are on ${teams.length} teams. Use /leave NAME: ${teams.map(row => remote(row.name, 40)).join(', ')}.`);
    const shown = remote(team.name, 40) || 'the team';
    if (team.founder === status.key) throw new Error(`You made ${shown}, so you cannot leave it. /remove @name removes a teammate.`);
    if (!await yes(`Leave ${shown}`, `Leave ${shown}? You stop getting its messages.`, '[y/N]')) return;
    const result = await teamChange({ type: 'teamLeave', team: team.id }); peerOnAt = 0;
    setMessage(`You left ${shown}.${leaveNote(result)}`); draw();
  }
  async function removeTeammate(args) {
    const status = peerRead('peerStatus'), teams = status?.teams ?? [], [word = '', ...rest] = args, wanted = rest.join(' ');
    if (!word) throw new Error(`Use ${usageOf('remove')}.`);
    const typed = `@${word.replace(/^@+/, '')}`, shown = member => peerName(member.name, member.key);
    const scope = wanted ? teams.filter(row => row.id === wanted || String(row.name).toLowerCase() === wanted.toLowerCase()) : teams;
    if (wanted && !scope.length) throw new Error(`You are not on a team called ${remote(wanted, 40)}.`);
    // A key or fingerprint prefix of 8 or more characters first (two teammates can show the
    // same name), then the exact name, then the same letters in any case.
    const prefix = word.replace(/^@+/, '').toLowerCase();
    const named = members => {
      const keyed = prefix.length >= 8 ? members.filter(member => String(member.key ?? '').startsWith(prefix)) : [];
      if (keyed.length) return keyed;
      const same = members.filter(member => shown(member) === typed); return same.length ? same : members.filter(member => shown(member).toLowerCase() === typed.toLowerCase());
    };
    const found = scope.flatMap(team => named((team.members ?? []).filter(member => member.key !== status.key)).map(member => ({ team, member })));
    if (!found.length) throw new Error(`No teammate ${typed} on ${scope.length === 1 ? remote(scope[0].name, 40) : 'your teams'}.`);
    if (found.length > 1) throw new Error(new Set(found.map(row => row.team.id)).size > 1 ? `${typed} is on more than one of your teams. Use /remove ${typed} TEAM.` : `Two teammates are called ${typed}. Use /remove with the first 8 characters of their key (elu peers --json shows it).`);
    const [{ team, member }] = found, where = remote(team.name, 40) || 'the team';
    if (team.role !== 'admin') throw new Error(`Only an admin of ${where} can remove a teammate.`);
    if (team.founder && member.key === team.founder) throw new Error(`${shown(member)} made ${where}, so they cannot be removed.`);
    // The fingerprint too: a name can be made to look like another teammate's.
    if (!await yes(`Remove ${shown(member)}`, `Remove ${shown(member)} (${String(member.key).slice(0, 8)}) from ${where}?`, '[y/N]')) return;
    const result = await teamChange({ type: 'teamRemove', team: team.id, key: member.key });
    setMessage(`Removed ${shown(member)} from ${where}.${result?.daemon === false ? ' They and your other teammates hear it once the peer daemon can start.' : ''}`); draw();
  }
  const usageOf = name => COMMANDS.find(row => row.name === name).usage;
  const hasIdentity = () => { try { facade.identity(); return true; } catch (error) { if (/identity first/.test(error.message)) return false; throw error; } };
  // The name teammates see, asked the first time a team needs it. False when none was given.
  const askName = async () => {
    if (typeof facade.identity !== 'function' || hasIdentity()) return true;
    const name = (await prompt('Your name', 'Teammates see this name on your asks and answers. 1 to 40 characters.', os.userInfo().username))?.trim();
    if (!name) return false;
    facade.identity({ create: true, name }); return true;
  };
  const named = async () => { if (await askName()) return true; setMessage('Nothing was done. Your teammates need a name for you.'); return false; };
  // An invite needs the daemon running, on the team the invite is for: started here, or
  // restarted when an update left it running with the old code (startPeer does both).
  const peerReady = async () => {
    peerOnAt = 0;
    const now = peerRead('peerStatus');
    if (now?.running === true && now.stale !== true) return true;
    setMessage(now?.running === true ? 'Restarting the peer daemon…' : 'Connecting…'); draw(); await facade.startPeer();
    for (let i = 0; i < 40 && peerRead('peerStatus')?.running !== true; i++) await new Promise(done => setTimeout(done, 250));
    if (peerRead('peerStatus')?.running !== true) throw new Error(PEER_STOPPED);
    return true;
  };
  // What teammates can do here, per team (lib/peer/access.mjs). The two questions: Auto or
  // Manual, then the rules. Enter twice keeps what is set, or takes Auto for a new team and
  // Manual for one that already has teammates and no setting (its messages wait today, and
  // Enter keeps that). Esc on either is null.
  const HANDLING_ROWS = [['auto', 'Auto: their message starts a session here, as if you typed it'], ['manual', 'Manual: each message waits for you to approve it']];
  const accessOf = teamId => { try { return typeof facade?.teamAccess === 'function' ? facade.teamAccess(teamId) : null; } catch { return null; } };
  async function accessQuestions(current = null, { existing = false } = {}) {
    const picked = await listDialog('What teammates can do here', HANDLING_ROWS.map(([, text]) => ink(text, 'text', colour)), { selected: (current ? current.handling === 'manual' : existing) ? 1 : 0, notes: ['Push, merge, deploy and publish stay blocked either way.'], hint: 'enter choose · esc cancel' });
    if (!picked) return null;
    const rules = await prompt('Rules for teammates', 'Optional, in plain English. For example: Only work on the elu repo. Don\'t write anything until I accept it.', current?.rules ?? '');
    if (rules === null || rules === undefined) return null;
    if (rules.trim().length > RULES_LIMIT) throw new Error(`Keep the rules to ${RULES_LIMIT} characters.`);
    return { handling: HANDLING_ROWS[picked.index][0], rules: rules.trim() };
  }
  // Saved with the open project as the one teammates' sessions run in. A project that cannot
  // be that (the home folder) is left out, and the rest is still saved: noProject says why,
  // and the status line each command ends with carries it (projectNote).
  function saveAccess(teamId, { handling, rules }) {
    if (typeof facade?.saveTeamAccess !== 'function') return { saved: null, noProject: null };
    const root = controller ? controller.repo.root : undefined;
    try { return { saved: facade.saveTeamAccess(teamId, { handling, rules, ...(root ? { root } : {}) }), noProject: null }; }
    catch (error) { if (!root) throw error; return { saved: facade.saveTeamAccess(teamId, { handling, rules }), noProject: error.message }; }
  }
  const projectNote = noProject => noProject ? ` No project was saved for their sessions: ${noProject.replace(/\.$/, '')}. Until one is, their messages wait for you.` : '';
  // Whether a team has anyone on it but me.
  const hasTeammates = team => (team?.members ?? []).some(member => member?.key && member.key !== myKey());
  // /access: what teammates can do here, for one team, with the current values shown first.
  async function accessCommand(args) {
    if (args.length) throw new Error('Use /access.');
    const teams = peerRead('peerStatus')?.teams ?? [];
    if (!teams.length) throw new Error('No team yet. /invite makes one, or /join one with a code.');
    const picked = teams.length === 1 ? { index: 0 } : await listDialog('Which team', teams.map(team => ink(remote(team.name, 40) || 'Team', 'text', colour)));
    if (!picked) return;
    const team = teams[picked.index], current = accessOf(team.id);
    const now = current ? `${current.handling === 'manual' ? 'Manual' : 'Auto'} · rules: ${current.rules ? fitWords(current.rules.replace(/\s+/g, ' '), 60) : 'none'}${current.root ? ` · ${shortHome(current.root)}` : ''}` : 'Not set: messages wait for you to approve them.';
    setMessage(`${remote(team.name, 40) || 'Team'} now: ${now}`); draw();
    const asked = await accessQuestions(current, { existing: true });
    if (!asked) { setMessage('Nothing was changed.'); return; }
    const { saved, noProject } = saveAccess(team.id, asked);
    setMessage(`Saved for ${remote(team.name, 40) || 'the team'}: ${saved?.handling === 'manual' ? 'messages wait for you to approve them' : 'messages start sessions here, as if you typed them'}${saved?.rules ? ', with your rules' : ''}${saved?.root ? ` in ${shortHome(saved.root)}` : ''}.${projectNote(noProject)}`);
  }
  // /invite, Another computer of mine: a code for one of my own computers, good for an hour.
  // Joined with it, and with a yes on that computer, the two count each other as mine
  // (lib/peer/mine.mjs), and each can start sessions on the other. A team is made first when
  // there is none.
  async function inviteMine(teams) {
    // A computer already on the team needs no code: /mine on both marks it. They are offered first.
    const known = teams.length ? remoteApp.unmarked() : [];
    if (known.length) {
      const NEW = 'A computer not on your team yet: get a code';
      const options = [...known.map(machine => `@${machine.name}${machine.owner && machine.owner !== machine.name ? ` (${machine.owner})` : ''}: already on your team, mark it as yours`), NEW];
      const picked = await listDialog('Which computer', options.map(text => ink(text, 'text', colour)), { hint: 'enter choose · esc close' });
      if (!picked) return;
      if (picked.index < known.length) { setMessage(await remoteApp.mine([`@${known[picked.index].name}`])); return; }
    }
    if (!(await named())) return;
    const chosen = teams[0] ?? await firstTeam();
    if (!chosen) throw new Error('The team could not be made.');
    if (!(await peerReady())) return;
    const result = await facade.createInvite(chosen.id, { hours: 1, mine: true }), code = readCode(typeof result === 'string' ? result : result?.code)?.short;
    if (!code) throw new Error('The invite could not be made.');
    let copied = false; try { if (copyText) { copyText(code); copied = true; } } catch {}
    setMessage(`Code for another computer of yours ready${copied ? ' and copied' : ''}. It works once, within 1 h.`);
    await prompt('Another computer of mine', `${framed(code)}\n\n${copied ? 'Copied to your clipboard. ' : ''}One use, expires in 1 h. Anyone with this code can start sessions on this computer, so keep it to yourself.\nOn your other computer:\n1. Open a terminal in the project its sessions should use.\n2. Run npx -y @elu-labs/elu\n3. In ELU Code, type /join and paste this code.\n4. Answer Yes when it asks if this computer is yours too.\nThen type @name of either computer first in the new session box to start a session on it.`);
  }
  // The first /invite makes the team, so nobody has to name one: it is named after the open project.
  async function firstTeam() {
    const named = controller ? path.basename(controller.repo.root).slice(0, 60) : '';
    try { if (named) return await facade.createTeam(named); } catch {}
    return facade.createTeam('My team');
  }
  // A message for a session on another computer of mine: started there (machine), or continuing
  // the one under the cursor (here). It never goes as a question to a teammate instead.
  async function remoteSubmit(here, machine, text) {
    if (!text) { ask.setValue(`@${machine.name} `); setMessage(`Write the message after @${machine.name}.`); focusInput(); return; }
    if (here) { setMessage(await remoteApp.send(here, text)); ask.clearValue(); focusInput(); return; }
    const form = composing(), settings = form ? { permissions: composeMode ?? defaultMode(), place: composePlace, model: composeModel, bots: composeBots } : { permissions: defaultMode(), place: { kind: 'worktree' }, model: null, bots: firstBots() };
    setMessage(`Starting on @${machine.name}…`); draw();
    const started = await remoteApp.start(machine, text, settings);
    ask.clearValue(); if (form) resetForm();
    // The list shows it, with the cursor on it.
    rememberDraft(); view = 'tasks'; returnTo = 'tasks'; selectedId = null; selectedRequest = null; following = null;
    ownSeen = null; wanted = null; barKey = openKey = started.key;
    setMessage(started.line); resize(); focusInput();
  }
  // Peer slash commands. Each makes one facade call; the result shows in the status line.
  async function peerSlash({ name, args, text = '' }) {
    if (!facade) throw new Error(PEER_MISSING);
    if (name === 'share') {
      if (!controller) throw new Error('Open a project to share it.');
      if (args.length > 1 || args[0] && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(args[0])) throw new Error('Use /share [handle] with 1 to 40 lowercase letters, digits or dashes.');
      controller.writable(); const result = await facade.share(controller.repo.root, { handle: args[0], status: true });
      setMessage(`Shared ${shortHome(result?.root ?? controller.repo.root)} with your team as ${remote(result?.handle, 40) || args[0] || path.basename(controller.repo.root)}.`); return;
    }
    if (name === 'access') return accessCommand(args);
    if (!peerOn() && !['invite', 'join'].includes(name)) throw new Error(NO_TEAM);
    if (name === 'peers') {
      const status = peerRead('peerStatus'), members = new Map();
      for (const member of (status?.teams ?? []).flatMap(row => row?.members ?? [])) if (member?.key && member.key !== status.key) members.set(member.key, member);
      const online = [...members.values()].filter(member => member.online);
      setMessage(members.size ? `${online.length} of ${members.size} teammates online${online.length ? `: ${online.map(member => `${peerName(member.name, member.key)} (${remote(member.path, 10) || 'direct'})`).join(', ')}` : ''}` : 'No teammates yet. Use /invite to add one.'); return;
    }
    // Adding a teammate also picks the project they ask about: the open one.
    const teamShare = async teamId => {
      if (!controller) return 'Type /share in a project so teammates can ask about it.';
      try { controller.writable(); const row = await facade.share(controller.repo.root, { teams: [teamId] }); return `Teammates can ask about ${remote(row?.handle, 40) || path.basename(controller.repo.root)}, the folder ${shortHome(row?.root ?? controller.repo.root)}.`; }
      catch (error) { return `${path.basename(controller.repo.root)} is not shared: ${error.message}`; }
    };
    if (name === 'invite') {
      const teams = peerRead('peerStatus')?.teams ?? [];
      if (!teams.length && args.length) throw new Error('No team yet. /invite alone starts one and makes a code to send.');
      // Plain /invite first says what it can do: a code for someone new, or which bots teammates may use.
      if (!args.length) {
        const sharing = myBots().some(bot => canShare(bot.vendor));
        const options = [INVITE_NEW, INVITE_MINE, ...(sharing ? [INVITE_BOTS] : [])];
        const picked = await listDialog('Invite', options.map(text => ink(text, 'text', colour)), { hint: 'enter choose · esc close' });
        if (!picked) return;
        if (options[picked.index] === INVITE_BOTS) { setMessage(await shareBots()); return; }
        if (options[picked.index] === INVITE_MINE) return inviteMine(teams);
      }
      if (!(await named())) return;
      // A name adds a teammate to the open channel: @name always, a bare word unless a team is called that.
      if (teams.length && args.length === 1 && (args[0].startsWith('@') || !teams.some(row => row.id === args[0] || row.name === args[0]))) return (await peerReady()) && inviteToChannel(args[0]);
      const found = args.length ? teams.find(row => row.id === args[0] || row.name === args.join(' ')) : teams[0] ?? null;
      if (args.length && !found) throw new Error('No team by that name.');
      // The first invite for a team asks what teammates can do here, before the code; later ones do not ask again.
      // They are asked before a first team is made, so Esc there leaves no team behind.
      const known = Boolean(found && accessOf(found.id));
      const asked = known ? null : await accessQuestions(null, { existing: hasTeammates(found) });
      if (!known && !asked) { setMessage('Nothing was done. No invite was made.'); return; }
      // The first /invite makes the team, so nobody has to name one: it is named after the open project.
      const chosen = found ?? await firstTeam();
      if (!chosen) throw new Error('The team could not be made.');
      // On a team now, so the daemon runs from here on.
      if (!(await peerReady())) return;
      const result = await facade.createInvite(chosen.id, { hours: 24 }), code = readCode(typeof result === 'string' ? result : result?.code)?.short;
      if (!code) throw new Error('The invite could not be made.');
      const shared = await teamShare(chosen.id), bots = botsLine();
      const noProject = asked ? saveAccess(chosen.id, asked).noProject : null;
      // The code goes on the clipboard as the window opens, so nobody has to select it.
      let copied = false; try { if (copyText) { copyText(code); copied = true; } } catch {}
      setMessage(`Invite for ${remote(chosen.name, 40)} ready${copied ? ' and copied' : ''}. It works once, within 24 h.${projectNote(noProject)}`);
      await prompt('Team invite', `${framed(code)}\n\n${copied ? 'Copied to your clipboard. ' : ''}One use, expires in 24 h.\n${shared}\n${bots ? `${bots}\n` : ''}Send this code to your teammate. On their computer:\n1. Open a terminal in the project folder they will share with you.\n2. Run npx -y @elu-labs/elu\n3. In ELU Code, type /join and paste this code.\nStay online until they join.`); return;
    }
    if (name === 'join') {
      // A pasted code may come in pieces, across lines or with spaces, and with a second /join in front: they are one code.
      if (!args.length) throw new Error(`Use ${usageOf('join')}.`);
      const code = readCode(args.join(' '));
      if (!code) throw new Error(`That is not an invite code. Use ${usageOf('join')}, as in /join k7qm-x2pd-9fhw.`);
      // One confirm, then what teammates can do here; Esc on any of them joins nothing. The
      // team's name and who invited you are known only once the code has been proved, which
      // is the join itself, so the confirm cannot name them yet. They are asked before the
      // join is sent, since the join is what starts the daemon.
      const confirmed = await listDialog('Join a team', ['Join', 'Cancel'].map(text => ink(text, 'text', colour)), { notes: ['This code joins the team of the person who sent it to you.'], hint: 'enter choose · esc cancel' });
      if (confirmed?.index !== 0) { setMessage('Nothing was done. You did not join.'); return; }
      const asked = await accessQuestions();
      if (!asked) { setMessage('Nothing was done. You did not join.'); return; }
      if (!(await named())) return;
      // A daemon an update left running with the old code is restarted first. With none
      // running, joinTeam starts one for the join; it keeps running once this machine is on the team.
      const now = peerRead('peerStatus');
      if (now?.running === true && now.stale === true) { setMessage('Restarting the peer daemon…'); draw(); await facade.startPeer(); }
      setMessage('Looking for the person who invited you…'); draw();
      // Joining is all it does: the joiner is added to the inviter's team. It shares nothing of
      // the joiner's; /share does that, whenever they want. Teammates' messages start sessions
      // in the project open now, as the answers say.
      const joined = await facade.joinTeam(code.short ?? code.long), team = remote(joined?.name, 40) || 'the team', who = remote(joined?.inviter?.name, 40);
      peerOnAt = 0;
      const { saved, noProject } = joined?.id ? saveAccess(joined.id, asked) : { saved: null, noProject: null };
      const said = `Joined ${team}${who ? ` with ${who}` : ''}. ${saved?.handling === 'manual' ? 'Their messages wait for you to approve them.' : saved && !noProject ? 'Their messages start sessions here, as if you typed them.' : ''}${projectNote(noProject)}`.replace(/\s+/g, ' ').trim();
      // A code made for another computer of the inviter's own marks nothing by itself: the person
      // here says whether both are theirs. No is first, and Esc is no.
      if (joined?.mineOffer?.key) {
        setMessage(said); draw();
        const picked = await listDialog(`Is ${who ? `${who}'s` : 'their'} computer yours too?`, ['No', 'Yes, both are mine'].map(text => ink(text, 'text', colour)), { notes: ['Only say yes if you set up both computers.', 'Yes lets each one start sessions on the other.'], hint: 'enter choose · esc no' });
        if (picked?.index === 1) { setMessage(`Joined ${team}${who ? ` with ${who}` : ''}. ${await remoteApp.agree(joined.mineOffer.key, who)}`); return; }
        setMessage(`${said} Not marked as yours.`); return;
      }
      setMessage(said); return;
    }
    if (name === 'leave') return leaveTeam(args);
    if (name === 'remove') return removeTeammate(args);
    const target = args[0] ?? '';
    // No @name: the question goes to every teammate, and the first to take it answers.
    if (target && !target.startsWith('@')) {
      if (text.length > 16000) throw new Error('Keep it under 16,000 characters.');
      const chat = controller && view === 'chat' ? { root: controller.repo.root, taskId: selectedId ?? null } : {};
      const result = await peerCommand({ type: 'teamAsk', project: null, text, ...chat });
      setMessage(withCount(result, 'Asked your team. The first teammate to take it answers.')); return;
    }
    if (!/^@[^\s@/\\]{1,64}$/.test(target)) throw new Error('Write @name and your question.');
    const to = target.slice(1);
    // A second word names a project only when it is one of that teammate's shared handles.
    let rest = text.slice(target.length).trim(), project = null;
    // Handles come from the teammate's hello (in peerStatus), and from their live rows.
    const plain = value => String(value ?? '').replace(/[\s@]+/g, '').toLowerCase(), members = (peerRead('peerStatus')?.teams ?? []).flatMap(row => row?.members ?? []).filter(member => member?.key === to || member?.name === to || plain(member?.name) === plain(to));
    const word = rest.split(/\s+/, 1)[0], handles = [...members.flatMap(member => Array.isArray(member.handles) ? member.handles : []), ...peerList('teamAgents').filter(row => row?.name === to).flatMap(row => (row.rows ?? []).map(value => value?.handle))];
    if (word && rest.length > word.length && handles.includes(word)) { project = word; rest = rest.slice(word.length).trim(); }
    if (!rest) throw new Error('Write your question after @name.');
    if (rest.length > 16000) throw new Error('Keep it under 16,000 characters.');
    const chat = controller && view === 'chat' ? { root: controller.repo.root, taskId: selectedId ?? null } : {};
    // A question is also how work is handed over: the teammate chooses to answer
    // it or to work on it.
    const result = await peerCommand({ type: 'ask', to, project, text: rest, ...chat });
    sentLine(result, `@${to}`, `Sent to @${to}. Their reply shows in this thread.`);
  }
  // One switch at a time: moving through the list asks for the next one while the last still closes.
  let switching = Promise.resolve();
  function switchProject(location) {
    const next = switching.then(async () => {
      if (controller?.repo.root === location.root) return;
      rememberDraft(); await controller?.close(); claim.release(); controller = null;
      activateProject(location);
    });
    switching = next.catch(() => {}); return next;
  }
  // A folder typed in the project chooser: opened, or created after a confirm when it is missing.
  async function openProject(value, create) {
    let location;
    if (create) { const plan = createFolderPlan(value, startDirectory); if (!await yes('Create project folder', `${plan.root}\n\n${plan.message}`)) return false; location = createFolder(plan); nameProject(location, path.basename(location.root)); }
    else location = projectFolder(value, startDirectory);
    await switchProject(location); return true;
  }
  // + New task: an empty chat in the open project, else the only one, else one you choose.
  async function newTaskForm(root = null) {
    const projects = snapshot?.projects ?? [];
    root ??= controller?.repo.root ?? (projects.length === 1 ? projects[0].root : null);
    if (!root && !await (projects.length ? chooseProject() : createHere())) return;
    if (root) await switchProject(projectFolder(root));
    if (!controller) return;
    if (view !== 'chat') returnTo = view === 'kanban' ? 'kanban' : 'tasks';
    showForm(); message = '';
    resize(); focusInput();
  }
  async function nameHere(location) {
    const name = await prompt('New project', `${location.root}\n\nName this project. Its settings are saved in .elu-code/ in this folder.\nThe model finds your code anywhere in your home folder.\nEsc skips${location.common ? ' and opens the repository unnamed' : ''}.`, path.basename(location.root));
    if (!name?.trim()) { if (location.common && !controller) { activateProject(location); resize(); } return false; }
    const saved = nameProject(location, name);
    await switchProject(location); resize(); focusInput();
    setMessage(`Created project ${saved}. Type below to start a session.`); return true;
  }
  // No project open: name the folder ELU Code started in; the disk root picks another.
  async function createHere() {
    let location = null; try { location = projectFolder(startDirectory); } catch { /* The disk root is never a project. */ }
    if (!location) return chooseProject();
    const saved = savedProjectName(location.root);
    if (saved) { await switchProject(location); return true; }
    return nameHere(location);
  }
  // Bots keys act on the selected bot: Enter opens it, n makes one, x removes one.
  const botDialog = botDialogs({ prompt, listDialog, editSetting, yes, setMessage, colour, root: () => controller ? controller.repo.project ?? controller.repo.root : null, named: botModelName });
  async function botsAction(action) {
    botCache.at = 0;
    if (action === 'new') { const made = await botDialog.create(); if (made) botJump = made.name; return; }
    const bot = botRows[botsList.selected ?? 0];
    if (!bot) throw new Error('No bots yet. n makes one.');
    if (action === 'remove') { await botDialog.remove(bot.name); return; }
    return botDialog.open(bot.name);
  }
  // /bots add NAME and /bots remove NAME change the bots of the open session, or of the one about to start.
  // again: adding a bot that is already there says so without an error, as @name alone does.
  function chatBot(action, name, { again = false } = {}) {
    const task = openTask();
    if (!task && !composing()) throw new Error('Open a session first.');
    const now = task ? botsOf(task) : composeBots, has = now.includes(name);
    if (action === 'add') needBot(name);
    // A bot that has a schedule works in the session by itself, and the owner is told when.
    // One that works with no schedule waits to be written to.
    // before: its schedule here as it was ahead of the tick that this add started.
    const joined = (list, before = null) => {
      const runs = botScheduleIn(controller.repo, task ? { ...task, bots: list } : null, name);
      if (!runs && botShadows(getBot(name))) return `@${name} is in this session. It reviews the changes, and speaks after each turn that changes no files.`;
      if (!runs) return botWorks(needBot(name)) ? `@${name} is in this session. It works when you write to @${name}.` : `@${name} is in this session. It reviews the changes.`;
      if (!runs.on && runs.note) return `@${name} is in this session. ${runs.note}`;
      if (runs.off) return `@${name} is in this session. Its schedule is off here; /bots schedule on ${name} starts it.`;
      const every = runs.label ?? 'on its schedule', stop = `/bots schedule off ${name} stops the schedule here.`;
      // The form has no session yet: Enter in the empty box starts it with this bot's first turn.
      if (!task) return composeWhen || !runs.label ? `@${name} is in this session. It works here ${every} once the session starts, and when you write to @${name}.` : `@${name} is in this session. Press Enter to start it, or send your first message.`;
      if (before && runs.lastRunAt && runs.lastRunAt !== before.lastRunAt) return `@${name} is in this session and starts now. It then works here ${every}. ${stop}`;
      if (runs.starting) return `@${name} is in this session. It starts when the session is free, then works here ${every}. ${stop}`;
      return `@${name} is in this session. It works here ${every}${runs.nextRunAt ? `, next ${dateText(new Date(runs.nextRunAt))}` : ''}, and when you write to @${name}. ${stop}`;
    };
    if (has && again && action === 'add') { setMessage(joined(now)); return; }
    if (has === (action === 'add')) throw new Error(has ? `@${name} is already in this session.` : `@${name} is not in this session.`);
    // A bot that was deleted since drops out here: the store takes saved names only.
    const saved = listBots().map(bot => bot.name), rest = now.filter(row => row !== name && saved.includes(row)), next = has ? rest : [...rest, name];
    if (task) controller.setBots(task.id, next); else composeBots = chatBots(next);
    // A bot that has a schedule starts here now: the tick queues its first run.
    const before = !has && task ? botScheduleIn(controller.repo, { ...task, bots: next }, name) : null;
    if (before) tickBots();
    setMessage(has ? `@${name} left this session.` : joined(next, before));
  }
  // The Bots row: every saved bot, with a tick on the ones in the session. Enter adds or
  // removes the selected one; Esc closes.
  async function pickBots() {
    for (let selected = 0; ;) {
      botCache.at = 0; const bots = savedBots(), here = chatBotsNow();
      if (!bots.length) throw new Error('No bots yet. The Bots tab makes one.');
      const picked = await listDialog('Bots in this session', bots.map(bot => ink(here.includes(bot.name) ? '[x] ' : '[ ] ', here.includes(bot.name) ? 'orange' : 'muted', colour, true) + ink(`@${bot.name}`, 'text', colour, true) + ink(bot.about ? `  ${fitWords(bot.about, 40)}` : '', 'muted', colour)), { hint: 'enter add or remove · esc close', selected });
      if (!picked) return;
      selected = picked.index; chatBot(here.includes(bots[selected].name) ? 'remove' : 'add', bots[selected].name);
    }
  }
  // Projects keys act on the selected project: Enter opens its settings, o makes it the
  // active project, n creates one, x archives one, or leaves one that was joined.
  async function projectsAction(action) {
    if (action === 'new') return newProjectFlow();
    const project = projectRows[projectsList.selected ?? 0];
    if (!project) throw new Error('No projects yet. n creates one.');
    if (action === 'archive') return archiveRow(project);
    if (project.unavailable) throw new Error(project.unavailable);
    if (action === 'open') return makeActive(project);
    return projectSettings(project);
  }
  // The active project is the one in the header. The list stays in front, with its mark moved.
  async function makeActive(project) {
    if (controller?.repo.root === project.root) { setMessage(`${project.name} is already the active project.`); return; }
    await switchProject(projectFolder(project.root)); resize();
    setMessage(`${project.name} is now the active project.`); projectsList.focus(); draw();
  }
  // x, and the last row of a project's page. A project of the owner's own is archived: it
  // leaves the list, and a folder that was open is closed first. One joined through a
  // teammate's team is left: its share ends first, and when that fails the error shows and
  // the project stays on the list.
  async function archiveRow(project) {
    const teams = joinedTeamsOf(project.root), names = teams.map(team => remote(team.name, 40) || 'a team').join(', ');
    const sure = teams.length
      ? await yes(`Leave ${project.name}`, `It is no longer shared with ${names}: this machine stops answering teammates about it. You stay in the team.\nIt leaves this list. Its files and sessions stay.`, 'y/N')
      : await yes(`Archive ${project.name}`, 'It leaves this list. Its files and sessions stay.', 'y/N');
    if (!sure) return false;
    if (teams.length) facade.leaveProject(project.root);
    if (controller?.repo.root === project.root) await closeProject();
    archiveProject(project.root); joinedAt = 0;
    setMessage(teams.length ? `Left ${project.name}. ${names} can no longer ask about it.` : `Archived ${project.name}. n in Projects brings it back.`); return true;
  }
  async function closeProject() {
    rememberDraft(); await controller?.close(); claim.release(); controller = null; claim = { readOnly: true, release() {} }; repo = null;
    selectedId = null; selectedRequest = null; following = null; usageEnabled = false; vendorList.forget();
    if (view === 'chat') view = 'tasks';
  }
  // + New project: a folder (made when missing; a new or empty one gets Git history), then its name.
  async function newProjectFlow() {
    const value = (await prompt('New project', 'Folder for the project. ~ works. A missing folder is created.', ''))?.trim();
    if (!value) return false;
    const folder = projectPath(value, startDirectory), fresh = !fs.existsSync(folder);
    let location = fresh ? createFolder(createFolderPlan(value, startDirectory)) : projectFolder(value, startDirectory);
    const same = (() => { try { return fs.realpathSync(folder) === location.root; } catch { return false; } })();
    const empty = same && !fs.readdirSync(location.root).length;
    if (!location.common && empty && location.root !== fs.realpathSync(os.homedir()) && findBin('git')) { git(location.root, ['init', '--template=', '--initial-branch=main']); location = projectFolder(location.root); }
    const saved = savedProjectName(location.root);
    if (saved) { await switchProject(location); setMessage(`Opened ${saved}.`); return true; }
    return nameHere(location);
  }
  const firstLine = (text, width = 48) => clip(String(text ?? '').split('\n').find(line => line.trim()) ?? '', width) || 'none';
  // A project's settings: instructions and context are edited in place.
  async function projectSettings(project) {
    const { root, name } = project, row = (label, value) => ink(label.padEnd(14), 'muted', colour) + ink(value, 'text', colour);
    // The first row switches to the project; on the active one the list starts on Instructions.
    const active = controller?.repo.root === root;
    for (let selected = active ? 1 : 0; ;) {
      // A file that came with the folder and is not in use says so: its text is shown by Shared files, never in the editor.
      // One that changed since he approved it shows the approved text, which is the one in force.
      const settings = readProjectSettings(root), waiting = unusedTrust(root), unused = waiting.filter(file => file.before === null), changed = waiting.length - unused.length;
      const line = (name, text) => unused.some(file => file.name === name) ? 'not in use' : firstLine(text), count = [unused.length ? `${unused.length} not in use` : '', changed ? `${changed} changed` : ''].filter(Boolean).join(', ');
      const rows = [active ? ink('● Active project', 'orange', colour) : ink('Make active', 'text', colour), row('Instructions', line('instructions.md', settings.instructions)), row('Context', line('context.md', settings.context)), ink(joinedTeamsOf(root).length ? 'Leave' : 'Archive', 'text', colour), ...(waiting.length ? [row('Shared files', `${count} · Enter to review`)] : [])];
      const picked = await listDialog(`Project ${name}`, rows, { selected });
      if (!picked) return;
      selected = picked.index;
      if (picked.index === 0) return makeActive(project);
      else if (picked.index === 1) await editSetting(`Instructions · ${name}`, settings.instructions, text => saveInstructions(root, text));
      else if (picked.index === 2) await editSetting(`Context · ${name}`, settings.context, text => saveContext(root, text));
      // Once nothing is left to review the row is gone: the cursor goes back to the top, not to the row that took its place.
      else if (picked.index === 4) { await reviewProjectFiles(root, { declined: true }); if (!unusedTrust(root).length) selected = active ? 1 : 0; }
      else if (await archiveRow(project)) return;
    }
  }
  // A project's own settings and instructions are used only after the owner said so on this
  // machine (lib/project-trust.mjs). For each file that is new or changed he is shown its
  // text, or what changed, and asked once: use it, or not. Use it is offered once every page
  // was shown, and never for a file too large to review. While a version he approved is in
  // force, the choice against is to keep it, and a file that is gone asks whether to go
  // without. Esc decides later: nothing changes meanwhile, and he is asked again.
  // declined: also the files he turned down before, from the project's own page.
  async function reviewProjectFiles(root, { declined = false } = {}) {
    if (modal || closing) return;
    // A dialog stops the message box reading; one opened while he was typing gives it back.
    const said = [], typing = Boolean(ask._reading); let unused = false;
    for (const file of declined ? unusedTrust(root) : pendingTrust(root)) {
      const lines = reviewLines(file).flatMap(line => wrapText(line, Math.min(88, screen.width - 4) - 5)), size = Math.max(4, screen.height - 12), pages = Math.ceil(lines.length / size);
      const place = `.elu-code/${file.name}`, kept = file.before !== null, keeping = `Keeping the approved ${place}`;
      const yes = file.gone ? 'Go without it' : 'Use it', no = kept ? 'Keep the approved one' : 'Do not use it';
      const title = `${file.large ? 'Too large' : file.gone ? 'Gone' : file.state === 'new' ? 'New' : file.state === 'changed' ? 'Changed' : 'Not in use'} · ${place}`;
      let picked, use = false;
      for (let page = 0, seen = 1; ;) {
        const all = seen >= pages, rows = [...(file.large ? [] : [all ? yes : `Next page (${page + 1} of ${pages})`]), no, ...(all && pages > 1 ? ['Read it again'] : [])], against = rows.indexOf(no);
        picked = await listDialog(title, rows, { selected: all ? against : 0, hint: 'enter choose · esc decide later', notes: lines.slice(page * size, (page + 1) * size), shown: true });
        if (!picked || picked.index === against) break;
        if (!all) { page += 1; seen = Math.max(seen, page + 1); continue; }
        if (picked.index === against + 1) { page = 0; seen = 1; continue; }
        use = true; break;
      }
      if (!picked) { said.push(kept ? `${keeping} until you decide` : `${place} is not used until you decide`); break; }
      // Settings that cannot be read are turned down with the reason, so the project keeps working.
      if (use && !file.gone && file.name === 'config.yaml') { try { parseConfig(file.text); } catch (error) { answerTrust(root, file, false); said.push(`${kept ? keeping : `Not using ${place}`}: ${String(error.message).replace(/\.$/, '')}`); unused = true; continue; } }
      answerTrust(root, file, use); said.push(use ? `${file.gone ? 'Going without' : 'Using'} ${place}` : kept ? keeping : `Not using ${place}`); unused ||= !use;
    }
    if (!said.length) return;
    if (typing) setImmediate(() => { if (!modal) focusInput(); });
    if (controller?.repo.root === root) { controller.reloadConfig(); snapshot = controller.snapshot(); }
    setMessage(`${said.join('. ')}.${unused ? ' To change that, open Projects and choose this project.' : ''}`);
  }
  // The editor shows the text as typed, without the file's last newline. It comes back with
  // the text when a save is refused, with the reason above the keys.
  async function editSetting(title, value, save) {
    let note = ''; value = value.replace(/\n$/, '');
    for (;;) {
      const text = await editText(title, value, { note });
      if (text === null) return;
      try { save(text); setMessage('Saved.'); return; } catch (error) { note = error.message; value = text; }
    }
  }
  // Kanban keys act on the selected task in a column.
  async function kanbanAction(index, action) {
    if (!controller && (action !== 'new' || !await createHere())) { if (!controller) throw new Error(NO_PROJECT); return; }
    const column = kanbanData[index], item = column?.items[kanbanLists[index].selected ?? 0], repo = controller.repo;
    if (action === 'new') {
      const text = await prompt('New task', 'What should be done? It waits in To do until you start it with Shift+→.', '');
      if (!text?.trim()) return; addCard(repo, text); setMessage('Added to To do. Shift+→ on it starts it.'); return;
    }
    if (!item) throw new Error('Nothing here. n adds a task to To do.');
    if (action === 'open') {
      if (item.card?.column === 'todo') {
        const text = await prompt('Edit task', 'Change the task. Shift+→ on it starts it.', item.card.text);
        if (text?.trim() && text.trim() !== item.card.text) { editCard(repo, item.card.id, text); setMessage('Saved.'); } return;
      }
      if (item.task) return openRow({ kind: 'task', root: repo.root, id: item.task.id });
      if (item.request) return openRow({ kind: 'request', root: repo.root, request: item.request });
      throw new Error('Its session is not available. x removes it from the board.');
    }
    if (action === 'remove') {
      if (!item.card) throw new Error('Move it to Done instead. Its session stays in Sessions.');
      removeCard(repo, item.card.id); setMessage('Removed from the board.'); return;
    }
    if (action === 'forward') {
      if (column.column === 'todo') {
        controller.writable();
        const request = enqueue(repo.root, item.card.text, { priority: 0, permissions: defaultMode() }); startCard(repo, item.card.id, request.id); conduct();
        setMessage('Started. It moves to Needs you when the model stops.'); return;
      }
      if (column.column === 'progress') throw new Error('It is being worked on. It moves to Needs you when the model stops.');
      if (column.column === 'needs') {
        if (!item.card && !item.task) throw new Error('Enter opens it: send it again, or /stop cancels it.');
        setDone(repo, item, true); setMessage('Moved to Done.'); return;
      }
      throw new Error('Done is the last column. Shift+← reopens it.');
    }
    if (action === 'back') {
      if (column.column === 'done') {
        if (!item.card && !readBoard(repo).done.includes(item.task.id)) throw new Error('Answered questions and published work stay in Done.');
        setDone(repo, item, false); setMessage('Reopened.'); return;
      }
      if (column.column === 'todo') throw new Error('To do is the first column.');
      throw new Error('A started task stays with its session. Enter opens it; Shift+→ moves it to Done.');
    }
  }
  // When the New task form's message goes: now, or on a schedule.
  async function setWhen() {
    const answer = await prompt('When', ['When should this message be sent?', '', 'now               send it now', 'daily 9:00        every day', 'weekdays 9am      Monday to Friday', 'mon,thu 14:30     chosen days', 'every 2h          every 2 hours (15m to 7d)', 'tomorrow 15:00    once', '2026-12-01 9:00   once', '', 'Times are this computer’s local time. Each run starts a new session.'].join('\n'), composeWhen?.text ?? '');
    if (answer === null) return;
    const when = parseWhen(answer);
    composeWhen = when && { ...when, text: answer.trim() };
    // A schedule runs unattended, so it never gets Full access.
    const capped = when && composeMode === 'full'; if (capped) composeMode = 'auto';
    setMessage(when ? `Runs ${when.label}, next ${dateText(nextRun(when))}. ${capped ? SCHEDULE_CAP : 'Write the message below.'}` : 'Sends now.');
    focusInput();
  }
  async function scheduleTask(text) {
    const row = saveSchedule({ root: controller.repo.root, project: snapshot.name, goal: text.trim(), when: composeWhen, permissions: composeMode === 'full' ? 'auto' : composeMode, ...(composeModel ? { model: composeModel } : {}) });
    composeWhen = null; drafts.delete(draftKey()); ask.clearValue(); refreshAwake();
    let note = '';
    try { const result = loginItem.install(); if (!result.installed) note = ` ${result.reason}`; }
    catch (error) { note = ` It runs only while ELU Code is open: ${error.message}`; }
    showView('tasks'); focusInput();
    setMessage(`Scheduled ${row.when.label}, next ${dateText(new Date(row.nextRunAt))}.${note}`);
  }
  // r runs it now, p pauses or resumes it, x deletes it, Enter opens its last run.
  async function scheduleAction(row, action) {
    const { schedule } = row;
    if (action === 'open') {
      const task = schedule.lastTaskId && snapshot.projects.find(project => project.root === row.root)?.tasks?.find(value => value.id === schedule.lastTaskId);
      if (!task) throw new Error(schedule.runs ? 'Its last run is not in Sessions any more. r runs it now.' : 'No runs yet. r runs it now.');
      return openRow({ kind: 'task', root: row.root, id: task.id });
    }
    if (action === 'retry') { runScheduleNow(schedule.id, new Date(), { start: conduct }); setMessage('Running it now. It shows under Queued, then Running.'); return; }
    if (action === 'publish') { const value = pauseSchedule(schedule.id, schedule.enabled); refreshAwake(); setMessage(value.enabled ? `Resumed. Next run ${dateText(new Date(value.nextRunAt))}.` : 'Paused. p resumes it.'); return; }
    if (action === 'stop') {
      if (!await yes('Delete schedule', `${schedule.when.label} · ${projectName(row.root)}\n${schedule.goal}\n\nPast runs stay in Sessions.`)) return;
      if (!removeSchedule(schedule.id) && !botSchedulesOn()) { try { loginItem.uninstall(); } catch { /* The login item finds nothing to run. */ } }
      refreshAwake(); setMessage('Schedule deleted.'); return;
    }
    throw new Error('r runs it now, p pauses it, x deletes it.');
  }
  // Picks a known project by number, or opens or creates a folder by path.
  async function chooseProject() {
    const projects = allProjects().projects.filter(project => !project.unavailable);
    const value = (await prompt('Project', [...projects.map((project, index) => `${String(index + 1).padStart(2)}  ${project.name}  ${project.root}`), '', projects.length ? 'Type a number, or a folder to open. A folder that does not exist yet is created.' : 'Type a folder to open. A folder that does not exist yet is created.', 'No Git or setup is needed.'].join('\n'), ''))?.trim();
    if (!value) return false;
    if (/^[0-9]+$/.test(value)) { const chosen = projects[Number(value) - 1]; if (!chosen) throw new Error(`Choose 1 to ${projects.length}, or type a folder.`); await switchProject(projectFolder(chosen.root)); return true; }
    const folder = path.resolve(startDirectory, value.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
    return openProject(value, !fs.existsSync(folder));
  }
  async function composeAction(row, action = 'open') {
    if (!row) return;
    if (row.type === 'project') { if (await chooseProject()) { selectedId = null; selectedRequest = null; resize(); } return; }
    if (row.type === 'when') { if (action === 'remove') { composeWhen = null; setMessage('Sends now.'); return; } return setWhen(); }
    // The session's permission rows: mode, where it runs, extra folders.
    if (row.type === 'permissions') {
      const mode = await pickMode({ schedule: Boolean(composeWhen) }); if (!mode) return;
      composeMode = mode; if (composePlace.kind === 'here' && mode !== 'full') composePlace = { kind: 'worktree' };
      setMessage(`${LABELS[mode]} for this session.`); return;
    }
    if (row.type === 'place') { const place = await pickPlace({ mode: composeMode }); if (place) { composePlace = place; setMessage(`${placeText(place)} for this session.`); } return; }
    if (row.type === 'folders') {
      if (action === 'remove') { composeFolders = []; setMessage('No extra folders.'); return; }
      const folders = await pickFolders(composeFolders); if (folders) { composeFolders = folders; setMessage(folders.length ? `The model reads ${folders.map(shortHome).join(', ')} this session.` : 'No extra folders.'); } return;
    }
    if (row.type === 'model') { if (action === 'remove') return; const now = composeModel ?? controller.defaultModel(), choice = await pickModel(now, `The new session uses ${nameOf(now)} (${modelText(now)}).`); if (choice) useModel(choice); return; }
    if (row.type === 'bots') { if (action === 'remove') { composeBots = []; setMessage('No bots in this session.'); return; } return pickBots(); }
  }
  // The Model picker: every model a session can be given, narrowed to what is typed. A name
  // that is not listed is taken as vendor:name. null when closed with nothing chosen.
  async function pickModel(current, said) {
    const choices = modelChoices(), rows = choices.map(row => ({ name: row.name, note: [row.vendor, row.note].filter(Boolean).join(' · ') }));
    if (!rows.length) throw new Error('No vendor command line is installed, so there is no model to choose yet.');
    const check = text => { if (!text.trim()) return null; try { findModel(text); return null; } catch (error) { return error.message; } };
    const answer = await prompt('Model', `${said}\nChoose one, or type vendor:name for a model that is not listed.`, choiceName(current, choices), { suggest: text => matchModels(rows, text), check });
    return answer?.trim() ? findModel(answer) : null;
  }
  // Gives a model to the open session, from its next message, or to the new session form.
  function useModel(choice) {
    const task = openTask();
    if (task) { controller.setModel(task.id, choice); reported.at = 0; setMessage(`${nameOf(choice)} from your next message.`); return; }
    if (!composing()) throw new Error('Open a session, or /new. /model default <name> sets new sessions.');
    composeModel = choice; setMessage(`${nameOf(choice)} for this session.`);
  }
  // /model add: a vendor that can run a session here, then a model by the name its command
  // line knows. A name the vendor does not list is remembered, so /model offers it later.
  async function addModel() {
    const vendors = installedVendors();
    if (!vendors.length) throw new Error('No vendor command line is installed, so there is no model to add yet.');
    let vendor = vendors[0];
    if (vendors.length > 1) {
      let rows = []; try { rows = cachedVendors(); } catch { rows = []; }
      const picked = await listDialog('Add a model · runs on', vendors.map(name => { const row = rows.find(item => item.vendor === name); return ink(name.padEnd(8), 'text', colour, true) + ink(row ? vendorText(row) : VENDOR_NAMES[name], 'muted', colour); }));
      if (!picked) return;
      vendor = vendors[picked.index];
    }
    const models = botModels(vendor), listed = name => models.some(row => row.name === name);
    const check = text => text.trim() ? modelProblem(vendor, text.trim()) : 'Name the model.';
    const answer = (await prompt('Add a model', `A model ${VENDOR_NAMES[vendor]} knows by name. /model offers it from now on.`, '', models.length ? { check, suggest: text => matchModels(models, text), warn: text => listed(text.trim()) ? null : `${text.trim()} is not a model ${vendor} lists.` } : { check }))?.trim();
    if (!answer) return;
    const choice = listed(answer) ? { vendor, model: answer } : rememberModel(vendor, answer);
    if (openTask() || composing()) return useModel(choice);
    setMessage(`Added ${nameOf(choice)} (${modelText(choice)}). /model ${choiceName(choice, modelChoices())} uses it in a session.`);
  }
  // /model shows or chooses the model of the open session, or of the new session form.
  // default <name> sets what new sessions of this project start with; add adds one by name.
  async function modelCommand(args) {
    if (!controller) throw new Error(NO_PROJECT);
    if (args[0] === 'add') { if (args.length > 1) throw new Error('Use /model add.'); return addModel(); }
    if (args[0] === 'default') {
      if (args.length > 2) throw new Error('Use /model default <name>.');
      const before = controller.defaultModel(), choice = args[1] ? findModel(args[1]) : await pickModel(before, `New sessions in ${controller.snapshot().name} start with ${nameOf(before)} (${modelText(before)}).`);
      if (!choice) return;
      const saved = controller.setDefaultModel(choice);
      setMessage(`New sessions in ${controller.snapshot().name} start with ${nameOf(saved)} (${modelText(saved)}).`); return;
    }
    if (args.length > 1) throw new Error('Use /model, /model <name>, /model default <name> or /model add.');
    const task = openTask(), now = modelNow();
    if (!task && !composing()) {
      if (args[0]) throw new Error('Open a session, or /new. /model default <name> sets new sessions.');
      setMessage(`New sessions start with ${nameOf(now)} (${modelText(now)}). /model default <name> changes it.`); return;
    }
    const choice = args[0] ? findModel(args[0]) : await pickModel(now, `${task ? `This session uses ${modelOf(task)}` : `The new session uses ${nameOf(now)}`} (${modelText(now)}).`);
    if (choice) useModel(choice);
  }
  // Edits that are not verified are checked first. A project with no checks of its own is asked
  // for its test or build command, and asked again while the one given here fails; a project's
  // own checks are run as they are. What is still not verified after that is refused, as before.
  // checkAsked: the command last given at that prompt, by session, while the app runs.
  const checkAsked = new Map();
  async function publishCurrent() {
    if (!controller || !selectedId || selectedRequest) throw new Error('Open finished editing work from Sessions first.');
    const id = selectedId, open = controller.snapshot().tasks.find(row => row.id === id);
    if (open?.state === 'unverified') {
      const results = open.evidence?.results ?? [], key = `${controller.repo.root}\0${id}`;
      let command;
      const again = checkAsked.has(key) && results.some(row => row.status === 'failed');
      if (again || results.some(row => row.name === 'project-checks' && row.status === 'not-configured')) {
        const value = await prompt('Verify edits', 'Test or build command. Enter words separated by spaces, or a JSON argument array.', checkAsked.get(key) ?? controller.draftConfig.checks[0]?.command.join(' ') ?? 'node --test');
        if (!value?.trim()) { setMessage('Not published. The edits are still not verified.'); return; }
        command = value.trim().startsWith('[') ? JSON.parse(value) : commandWords(value); checkAsked.set(key, value.trim());
      }
      setMessage('Running the checks…');
      await controller.verify(id, command);
      setMessage('');
    }
    const plan = await controller.pushPlan(id), task = controller.snapshot().tasks.find(row => row.id === id);
    // Work done with Full access says so before it goes out.
    const full = task?.permissions === 'full' || (task?.runs ?? []).some(run => run.role === 'lead' && run.permissions === 'full') ? `${modelOf(task)} ran with Full access.\n` : '';
    if (await yes('Push and open draft PR', `Commit: ${plan.commit}\nDestination: ${plan.destination.url}\nRef: ${plan.destination.ref}\nBase: ${plan.destination.base}\n\n${plan.title}\n${full}\nPush and open a draft PR with the evidence? [y/N]`)) { const result = await controller.push(id, plan.confirmationId); setMessage(`Pushed ${result.commit}; draft PR ${result.pr}`); }
  }
  // Closing hides a session from Sessions and puts it in Kanban's Done; its history and
  // worktree stay. A new message opens it again.
  function closeTask(location, task, after) {
    if (['running', 'preparing'].includes(task.state)) throw new Error(`${sessionName(task)} is running. Stop it first with /stop.`);
    closeSession(location, task.id); after?.();
    setMessage(`Archived ${sessionName(task)}. /archived lists it; a new message brings it back.`);
  }
  // Asks for a session's name: one line of up to TITLE_MAX characters. The box opens with
  // the name only when someone chose it (the owner, an approved Task, the model), never
  // with the request. A name that is refused stays in the box. An empty answer takes the
  // owner's name away: the session goes back to its Task's title, the model's name, or the
  // first words of what was asked.
  async function renameTask(location, task, given = null) {
    const own = typeof task.title === 'string' ? task.title.trim() : '';
    for (let typed = own.length <= TITLE_MAX ? own : ''; ;) {
      const answer = given ?? await prompt('Rename session', `One line of up to ${TITLE_MAX} characters. It shows in the list and the title. Leave it empty to go back to the name ELU Code gave it.`, typed, { check: nameProblem });
      if (answer == null) return;
      try {
        const saved = setTitle(location, task.id, answer);
        setMessage(saved.titleBy === 'owner' ? `Renamed to ${saved.title}.` : saved.title ? `The session is named ${saved.title} again.` : 'The session is named after your first message again.'); return;
      } catch (error) { if (given != null) throw error; setMessage(error.message); typed = answer; }
    }
  }
  async function stopCurrent(given) {
    if (shellRun) { shellRun.run.stop(); setMessage('Stopping the command.'); return; }
    if (!controller) throw new Error(NO_PROJECT);
    controller.writable(); const root = controller.repo.root;
    if (selectedRequest) {
      // It may have started since the screen last drew: then its session is open, and the turn below is what stops.
      let row = openStarted(), taken = null;
      // A message that still waits is taken back in one step. One the conductor has begun to
      // start is not cancelled: its session would start all the same, after the owner was
      // told it was cancelled. In a moment it is a session, and /stop stops its turn.
      if (selectedRequest && row?.state === 'queued') { taken = takeRequest(root, row.id); if (!taken) row = openStarted(); }
      if (selectedRequest && !taken && ['queued', 'starting'].includes(row?.state)) throw new Error('This session is still starting. /stop again in a moment.');
      if (selectedRequest) { if (!taken) controller.cancelRequest(selectedRequest.id); following = null; selectedRequest = null; ask.clearValue(); setMessage('Request cancelled.'); return; }
    }
    const id = given ?? selectedId;
    const task = id && controller.snapshot().tasks.find(task => task.id === String(id));
    const rows = id ? pendingRequests(root) : [], pending = rows.filter(row => row.continuationTaskId === String(id) && row.state === 'queued');
    const cancel = () => { const gone = pending.filter(row => takeRequest(root, row.id)).length; return gone > 1 ? 'Waiting messages cancelled.' : gone ? 'Waiting message cancelled.' : null; };
    // A turn of this session the conductor is starting this instant: its request says so
    // before the session says it is working. The stop is sent all the same, and the conductor
    // reads it at its next look, when the turn is there to stop.
    const starting = rows.find(row => row.continuationTaskId === String(id) && row.state === 'starting');
    if (task && (['running', 'preparing'].includes(task.state) || starting)) {
      // The turn that is being stopped: its request, or the time it began when it has none.
      const turn = `${root}\0${task.id}\0${starting?.id ?? rows.find(row => row.taskId === task.id && row.state === 'running')?.id ?? task.activeSince ?? ''}`;
      // A second /stop while the same turn is still stopping cancels what waits behind it, so the session is left idle.
      if (stopAsked === turn && pending.length) { setMessage(cancel() ?? 'Stopping.'); return; }
      stopAsked = turn; sendCommand({ type: 'stop', root, taskId: task.id }); conduct();
      setMessage(pending.length ? `Stopping. Your waiting message${pending.length > 1 ? 's are' : ' is'} sent next · /stop again cancels ${pending.length > 1 ? 'them' : 'it'}.` : 'Stopping. Changes and chat history are kept.'); return;
    }
    const cancelled = cancel();
    if (!cancelled) throw new Error('Nothing is running in this chat.');
    setMessage(cancelled);
  }
  // The newest message the owner sent to a session that has not started yet: the one Up in
  // the message box takes back. A bot's scheduled turn is not his to take back here.
  function waitingMessage(id, rows) {
    return rows.filter(row => row.continuationTaskId === String(id) && row.state === 'queued' && !row.scheduled && !row.origin)
      .sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1) || Date.parse(a.queuedAt ?? a.createdAt) - Date.parse(b.queuedAt ?? b.createdAt)).at(-1) ?? null;
  }
  // Takes the open session's newest waiting message back and returns it as it was typed,
  // or null when none waits or it has just been sent.
  function takeBack() {
    if (!controller || claim.readOnly || view !== 'chat' || !selectedId || selectedRequest) return null;
    let row = null;
    try { const root = controller.repo.root; row = waitingMessage(selectedId, pendingRequests(root)); row &&= takeRequest(root, row.id); } catch { return null; }
    return row ? typedGoal(row) : null;
  }
  async function showDetails(location, task) {
    const data = taskDetails(location, task.id);
    const response = task.reply ?? task.result;
    await prompt('Session details: diff / checks / review / log', [sessionGoal(task), `State: ${task.state}`, `PR: ${task.pr ?? 'not published'}`, `Question: ${response?.question ?? 'none'}`, task.error?.message ?? '', '\nRESPONSE', response?.summary ?? '', '\nREQUESTS', ...(task.messages ?? []).map(row => row.bot ? `@${row.bot}: ${row.text}` : row.to ? `You → ${row.to}: ${row.text}` : teammateText(row) ? `${row.from}: ${teammateText(row)}` : row.text), '\nDIFF', data.diff || '(no diff)', '\nCHECKS', ...data.checks.map(row => `${row.name}: ${row.status} ${(row.details ?? []).join('; ')}`), '\nREVIEW', ...data.reviews.flatMap(row => [`${roleLabel(row.role ?? 'reviewer')} round ${row.round}: ${row.result.summary}`, ...row.result.comments.map(comment => `${comment.severity}: ${comment.body}`)]), '\nLOG', ...data.logs.map(log => `${roleLabel(log.role)}:\n${log.text}`)].join('\n'));
  }
  // Opens a row's chat and moves to its message box; a blocked or saved request comes back into the box.
  async function openRow(row) {
    const from = view;
    await switchProject(projectFolder(row.root));
    if (!controller) return;
    if (from !== 'chat') returnTo = from === 'kanban' ? 'kanban' : 'tasks';
    rememberDraft(); message = '';
    showSession(row.kind === 'task' ? { id: row.id } : { id: row.request.continuationTaskId ?? null, request: row.request }, true);
    // In Sessions the list's cursor is on this row, and the right side already shows it.
    if (returnTo === 'tasks') { barKey = openKey = row.key; ownSeen = ownKey(); wanted = null; }
    resize(); focusInput();
  }
  // Task keys act on the selected row in any project without opening it.
  async function boardAction(action) {
    const row = selectedBoardRow();
    // A session on another computer of mine: y and n answer what it waits for, s stops it, c takes it off this list.
    if (row?.kind === 'remote' && action !== 'new' && !(action === 'decline' && !row.approval && row.label !== 'TASK')) {
      if (action === 'open') return focusInput();
      // a: keep this kind of action as a rule on that computer, for its project or all of them there.
      if (action === 'answer' && row.approval) {
        if (!row.approval.always) throw new Error('This one is asked each time. y allows it once, n denies it.');
        const picked = await listDialog('Always allow', [ink(`This project on @${row.machine}${row.remote.project ? `  ${remote(row.remote.project, 40)}` : ''}`, 'text', colour), ink(`All my projects on @${row.machine}`, 'text', colour)], { notes: [`${row.approval.always}, without asking.`, 'Kept on that computer. Push, tag, merge, deploy and publish stay blocked.'], hint: 'enter choose · esc cancel' });
        if (!picked) return;
        setMessage(await remoteApp.action(row, 'always', picked.index === 1 ? 'all' : 'project')); return;
      }
      const said = await remoteApp.action(row, action);
      if (said) setMessage(said); else throw new Error(rowActions(row).map(([key, what]) => `${key} ${what}`).join(' · '));
      return;
    }
    // The row of a session whose Task waits takes y and n, once no approval of an action waits there.
    if (['accept', 'decline'].includes(action) && taskWaits(row) && !rowApproval(row)) return decideTask(row.root, row.task, action === 'accept');
    // An approval the lead waits on: y allows, n denies, Enter shows it.
    if (row?.kind === 'approval') {
      const { approval } = row, summary = approval.summary, session = approvalSession(approval);
      if (action === 'full') return offersFull(session, approval) ? allowFull(session, approval, rowProject(row)) : undefined;
      if (action === 'answer') return allowAlways(session, approval);
      if (action === 'open') {
        const key = (await prompt('Needs you', `${approval.role && approval.role !== 'lead' ? roleLabel(approval.role) : row.task && row.root === controller?.repo.root ? modelOf(row.task) : 'The model'} wants to:\n${summary}\n\n${approvalKeys(session, approval)} · esc later`, '', { keys: [...(offersFull(session, approval) ? ['y', 'n', 'f'] : ['y', 'n']), ...(offersAlways(session, approval) ? ['a'] : [])] }))?.trim().toLowerCase();
        if (key === 'f' && offersFull(session, approval)) return allowFull(session, approval, rowProject(row));
        if (key === 'a' && offersAlways(session, approval)) return allowAlways(session, approval);
        if (!['y', 'n'].includes(key)) { if (key) throw new Error('Nothing was done. Press y or n.'); return; }
        action = key === 'y' ? 'accept' : 'decline';
      }
      if (action === 'accept' || action === 'decline') { setMessage(answerApproval(approval.id, action === 'accept' ? 'allow' : 'deny') ? action === 'accept' ? 'Allowed.' : 'Denied.' : 'That approval was already answered.'); return; }
      throw new Error('y allows it, n denies it, Enter shows it.');
    }
    // The row of a session that waits on an approval takes y and n too, as its chat says: Esc, then y or n.
    if (action === 'full') { const asked = rowApproval(row); return asked && offersFull(row.task, asked) ? allowFull(row.task, asked, rowProject(row)) : undefined; }
    // a on a session whose request reads his rules is the approval key, and says why when no rule fits.
    if (action === 'answer' && rowApproval(row)?.rules === 'saved' && usesSavedRules(row.task.origin)) return allowAlways(row.task, rowApproval(row));
    const waiting = ['accept', 'decline'].includes(action) && rowApproval(row);
    if (waiting) { setMessage(answerApproval(waiting.id, action === 'accept' ? 'allow' : 'deny') ? action === 'accept' ? 'Allowed.' : 'Denied.' : 'That approval was already answered.'); return; }
    if (['accept', 'decline'].includes(action)) {
      const decision = action === 'accept' ? 'answer' : 'decline';
      if (peerDecision(row)) return decidePeer(row, decision);
      if (action === 'accept') throw new Error('y works on teammate messages, replies, and drafts.');
      if (row?.kind === 'peer') return decidePeer(row, 'decline');
      action = 'new';
    }
    // Enter on + New session goes into the form as it stands. n and + start it over.
    if (action === 'open' && boardLines[board.selected ?? 0]?.add && composing()) return focusInput();
    if (action === 'new' || action === 'open' && boardLines[board.selected ?? 0]?.add) return newTaskForm();
    if (!row) return;
    if (row.kind === 'schedule') return scheduleAction(row, action);
    const live = row.kind === 'task' && ['running', 'preparing'].includes(row.task.state);
    if (row.kind === 'peer') {
      if (action !== 'open') throw new Error('Enter reads it. n dismisses it.');
      const key = await peerDetails({ type: 'thread', ...row.item }), decision = { y: 'answer', w: 'work', n: 'decline' }[key];
      return decision ? decidePeer(row, decision) : undefined;
    }
    // A saved request from a teammate opens like its thread: y accepts, n declines.
    if (row.kind === 'request' && action === 'open' && peerIncoming(row)) {
      const key = await peerDetails({ type: 'thread', kind: 'incoming', ...(row.item ?? {}), id: row.item?.id ?? row.request.origin?.a2aTaskId, root: row.root, requestId: row.request.id, text: row.item?.text ?? row.request.origin?.context ?? row.request.goal, project: row.project, name: row.request.origin?.name, peer: row.request.origin?.peer, request: row.request.origin?.kind, trusted: row.item?.trusted === true }), decision = { y: 'answer', w: 'work', n: 'decline' }[key];
      return decision ? decidePeer(row, decision) : undefined;
    }
    if (action === 'open') return openRow(row);
    if (action === 'stop') {
      if (row.kind === 'request') { removeRequest(row.root, row.request.id); if (row.request.origin) await peerCommand({ type: 'discard', id: row.item?.id ?? row.request.origin.a2aTaskId }).catch(() => {}); setMessage('Queued request cancelled.'); return; }
      if (!live) throw new Error(row.task ? `${sessionName(row.task)} is not running.` : 'That session is not running.');
      sendCommand({ type: 'stop', root: row.root, taskId: row.id }); conduct(); setMessage(`Stopping ${sessionName(row.task)}. Changes and chat history are kept.`); return;
    }
    if (action === 'retry') {
      if (row.kind === 'request') { if (!retryRequest(row.root, row.request.id)) throw new Error('Only a blocked or saved request can be retried.'); conduct(); setMessage('Queued again.'); return; }
      if (!['blocked', 'stopped', 'unverified'].includes(row.task.state)) throw new Error('Retry works on blocked, stopped, or unverified work.');
      // The last message to the lead goes again. A session that only wrote to a bot sends that message to the bot again.
      const yours = (row.task.messages ?? []).filter(value => !value.bot), last = yours.findLast(value => !value.to) ?? yours.at(-1);
      // A teammate's message is theirs to send again: sent from here it would read as the owner's.
      if (last?.peer || teammateText(last)) throw new Error(`That message is from ${last.from ?? 'a teammate'}. Ask them to send it again, or write your own in the session.`);
      enqueue(row.root, last?.text ?? row.task.goal, { continuationTaskId: row.id, priority: 0, ...(last?.to ? { bot: last.to.replace(/^@/, '') } : {}) }); conduct(); setMessage(`Retrying ${sessionName(row.task)}.`); return;
    }
    if (action === 'answer') {
      if (row.kind !== 'task') throw new Error('Choose a session to answer.');
      const response = row.task.reply?.outcome === 'needs_input' ? row.task.reply : row.task.result;
      const body = row.task.state === 'needs_input' ? `${response?.question ?? ''}\n${(response?.choices ?? []).join(' / ')}` : `Follow up in ${row.project}:\n${sessionGoal(row.task)}${live ? '\n\nIt is sent when the current turn ends.' : ''}`;
      const text = await prompt(`Answer ${sessionName(row.task)}`, body, ''); if (!text?.trim()) return;
      enqueue(row.root, text.trim(), { continuationTaskId: row.id, priority: 0 }); conduct(); setMessage(`Sent to ${sessionName(row.task)}.`); return;
    }
    // d shows what the session changed, beside the list, and moves into it.
    if (action === 'diff') {
      if (row.kind !== 'task') throw new Error('Choose a session to see its changes.');
      if (view !== 'chat' || selectedId !== row.id || controller?.repo.root !== row.root) await openRow(row);
      showChanges({ focus: true }); changesFrom = board; return;
    }
    if (action === 'close') {
      if (row.kind !== 'task') throw new Error('c archives a session. Choose one.');
      if (row.archived) return setMessage(`${sessionName(row.task)} is archived already. u brings it back.`);
      return closeTask(projectFolder(row.root), row.task);
    }
    if (action === 'rename') { if (row.kind !== 'task') throw new Error('e renames a session. Choose one.'); return renameTask(projectFolder(row.root), row.task); }
    if (action === 'unarchive') {
      if (row.kind !== 'task' || !row.archived) return;
      reopenSession(projectFolder(row.root), row.id); barKey = row.key; setMessage(`${sessionName(row.task)} is back in the list.`); return;
    }
    if (action === 'publish') {
      if (row.kind !== 'task' || row.task.state !== 'ready') throw new Error('Only ready work can be published. Ready rows show checks and review.');
      await openRow(row); return publishCurrent();
    }
  }
  async function dispatch(command) {
    const { name, args } = command;
    if (args.length && ['new', 'schedule', 'sessions', 'kanban', 'chats', 'projects', 'peers', 'usage', 'changes', 'chat', 'details', 'publish', 'archive', 'archived', 'setup', 'help', 'quit'].includes(name)) throw new Error(`Use ${command.usage}.`);
    if (name === 'quit') return quit();
    if (name === 'help') return prompt('Commands', ['Six tabs: Sessions, Projects, Kanban, Chats, Bots, and Usage. Tab moves between areas; arrows move inside one.', 'Sessions: every session, in a list on the left. The selected one shows beside it. Enter moves into it and Esc moves back. d (or /changes) shows what it changed in place of its chat; Esc goes back. n or + New session starts one. c (or /close) closes one.', 'Projects: every project; ● marks the active one. o makes another active; Enter opens its settings; n or + New project creates one.', 'Kanban: this project’s tasks. n adds one; Shift+→ on a To do task starts it.', 'Chats: channels and direct messages on the left, the open one’s threads beside them. Type to write to it. n makes a channel, m sets who is in it, /invite @name adds one teammate, x leaves it. /leave leaves the whole team; an admin’s /remove @name takes a teammate off it, and a new invite brings them back.', 'Bots: models with instructions you write once. n or + New bot makes one; Enter opens it; x removes it. Each shows in its own color; /bots color NAME COLOR changes it. In a session, @name alone adds one and @name with a message asks it; a teammate’s @name with a message asks them.', 'Usage: your accounts and their plan usage. Enter shows a vendor’s details; r checks again.', 'Schedules: in + New session, set When (daily 9:00, every 2h, ...). r runs one now, p pauses, x deletes.', 'Permissions: each session runs as Ask for approval, Approve for me, or Full access. /permissions changes it.', 'Model: each session has its own. /model changes it, /model default sets what new sessions start with, and /model add adds one by name.', 'Agents: /agent add <model> puts another model in this session with no bot to write first. Words after the model say what it is for (/agent add sonnet you review my SQL), and --name NAME names it. @name with a message asks it; /agent remove <name> takes it out.', 'Type / to filter commands. Tab completes; Enter runs.', 'Start a message with ! to run a shell command in the project folder: !git status. In an open session the model sees it with your next message.', 'Mouse: drag to copy; a double click copies a word. Click in the message box to move the cursor.', '', ...COMMANDS.map(row => `${row.usage}\n  ${row.description}`), '', 'Examples:', '/model sonnet', '/model default opus', '/permissions auto', '/permissions folders add ~/evals', '/close'].join('\n'));
    if (name === 'model') return modelCommand(args);
    // /permissions [mode] sets this session's mode; default <mode> sets what new sessions start with.
    if (name === 'budget') {
      const task = controller && view === 'chat' && !selectedRequest && selectedId ? controller.snapshot().tasks.find(row => row.id === selectedId) : null;
      if (!task) throw new Error('Open a session to see or change its spending limit.');
      if (isPeerRun(task.origin)) throw new Error(READ_ONLY_PEERS);
      if (args.length > 1) throw new Error(`Use ${command.usage}.`);
      const money = value => `$${Number(value).toFixed(2)}`;
      if (!args.length) { const { spent, limit } = controller.budget(task.id); setMessage(limit ? `This session has spent ${money(spent)} of its ${money(limit)} limit. /budget off removes the limit.` : `This session has spent ${money(spent)}. It has no limit; /budget NUMBER sets one.`); return; }
      if (/^(off|none)$/i.test(args[0])) { controller.setBudget(task.id, null); setMessage(`This session has no spending limit.${task.state === 'blocked' ? ' Send your message again.' : ''}`); return; }
      if (!/^[$]?[0-9]+([.][0-9]+)?$/.test(args[0])) throw new Error('Use /budget with a number of dollars, such as /budget 20, or /budget off.');
      const dollars = Number(args[0].replace('$', ''));
      controller.setBudget(task.id, dollars);
      setMessage(`This session may now spend up to ${money(dollars)}.${task.state === 'blocked' ? ' Send your message again.' : ''}`); return;
    }
    if (name === 'permissions') {
      // /permissions folders add <path>: one more folder in your home the model may read this session.
      if (args[0] === 'folders') {
        if (args[1] !== 'add' || args.length !== 3) throw new Error('Use /permissions folders add <path>.');
        const task = controller && view === 'chat' && !selectedRequest && selectedId ? controller.snapshot().tasks.find(row => row.id === selectedId) : null;
        const composing = controller && view === 'chat' && !selectedId && !selectedRequest;
        if (!task && !composing) throw new Error('Open a session, or /new, then /permissions folders add <path>.');
        if (task && isPeerRun(task.origin)) throw new Error(READ_ONLY_PEERS);
        const dir = expandHome(args[2]);
        if (composing) { composeFolders = checkFolders([...composeFolders, dir]); setMessage(`The model reads ${shortHome(dir)} this session.`); return; }
        controller.addFolder(task.id, dir); setMessage(`Added ${shortHome(dir)}. The model reads it from your next message.`); return;
      }
      // /permissions rules [remove N|on N]: what runs without asking (lib/permission-rules.mjs).
      if (args[0] === 'rules') {
        if (args.length === 1) return rulesDialog();
        if (args.length !== 3 || !['remove', 'on'].includes(args[1]) || !/^[0-9]+$/.test(args[2])) throw new Error('Use /permissions rules, /permissions rules remove N or /permissions rules on N.');
        setMessage(args[1] === 'remove' ? removeEntry(Number(args[2])) : turnOnEntry(Number(args[2]))); return;
      }
      if (args[0] === 'default') { if (args.length !== 2) throw new Error('Use /permissions default <ask|auto|full>.'); const mode = checkMode(args[1], { allowFull: true }); saveDefaultMode(mode); setMessage(`New sessions start with ${LABELS[mode]}.`); return; }
      if (args.length > 1 || args[0] && !MODES.includes(args[0])) throw new Error(`Use ${command.usage}.`);
      const task = controller && view === 'chat' && !selectedRequest && selectedId ? controller.snapshot().tasks.find(row => row.id === selectedId) : null;
      const composing = controller && view === 'chat' && !selectedId && !selectedRequest;
      if (!task && !composing && !args.length) return rulesDialog();
      if (!task && !composing) throw new Error('Open a session, or /new. /permissions default <mode> sets new sessions.');
      if (task && isPeerRun(task.origin)) throw new Error(READ_ONLY_PEERS);
      const mode = args[0] ? checkMode(args[0], { allowFull: !(composing && composeWhen) }) : await pickMode({ schedule: composing && Boolean(composeWhen) });
      if (!mode || args[0] === 'full' && !await confirmFull()) return;
      if (composing) { composeMode = mode; if (composePlace.kind === 'here' && mode !== 'full') composePlace = { kind: 'worktree' }; setMessage(`${LABELS[mode]} for this session. ${MODE_TEXT[mode]}`); return; }
      setMessage(setMode(task, mode)); return;
    }
    // /place [worktree|branch <name>|here]: where the new session works. With no word it asks.
    if (name === 'place') {
      if (!controller) throw new Error(NO_PROJECT);
      if (!composing()) throw new Error('A session keeps the place it started in. /new starts another, and /place says where that one runs.');
      const kind = args[0]?.toLowerCase(), mode = composeMode ?? defaultMode();
      if (kind && !['worktree', 'branch', 'here'].includes(kind) || args.length !== (kind === 'branch' ? 2 : kind ? 1 : 0)) throw new Error(`Use ${command.usage}.`);
      const place = kind ? checkPlace(kind === 'branch' ? { kind, branch: args[1] } : kind, { mode }) : await pickPlace({ mode });
      if (place) { composePlace = place; setMessage(`${placeText(place)} for this session.`); }
      return;
    }
    if (name === 'new') return newTaskForm();
    if (name === 'schedule') { await newTaskForm(); if (controller && view === 'chat') await setWhen(); return; }
    if (name === 'sessions') { showView('tasks'); return; }
    if (name === 'kanban') { showView('kanban'); return; }
    if (name === 'chats') { showView('chats'); return; }
    // /agent add <model> [what it does] [--name NAME] puts a model in the session with no bot
    // written first: it makes (or finds) a bot on that model that works when written to, and
    // adds it as /bots add does. The words after the model say what the agent is for.
    if (name === 'agent' || name === 'agents') {
      if (!controller) throw new Error(NO_PROJECT);
      const task = openTask();
      if (!task && !composing()) throw new Error('Open a session first.');
      if (!args.length) { setMessage(`In this session: ${[task ? modelOf(task) : nameOf(modelNow()), ...chatBotsNow().map(bot => `@${bot}`)].join(', ')}. /agent add <model> adds another.`); return; }
      if (args[0] === 'remove' && args.length === 2) return chatBot('remove', args[1].replace(/^@/, '').toLowerCase());
      if (args[0] !== 'add' || args.length < 2) throw new Error('Use /agent add <model> [what it does] [--name NAME], or /agent remove <name>.');
      controller.writable();
      const choice = findModel(args[1]), { role, name: called } = agentWords(String(command.text ?? '').replace(/^add\s+\S+/, ''));
      try { return addAgent(choice, { name: called, role, label: nameOf(choice), join: bot => chatBot('add', bot, { again: true }) }); }
      finally { botCache.at = 0; }
    }
    if (name === 'bots') {
      // With no words it also says which bots of the open session run by themselves here, and when next.
      if (!args.length) { const task = openTask(), lines = task ? botScheduleLines(controller.repo, task) : []; showView('bots'); if (lines.length) setMessage(lines.join('   ')); return; }
      const words = args.map(word => word.replace(/^@/, '').toLowerCase());
      // A bot's schedule is turned off or on for the open session alone, and run tells it to work now.
      if (words[0] === 'schedule' && ['on', 'off'].includes(words[1]) && words.length === 3 || words[0] === 'run' && words.length === 2) {
        const task = openTask(), bot = words.at(-1);
        if (!task) throw new Error('Open a session first.');
        controller.writable();
        if (words[0] === 'run') { runBotNow(controller.repo, task.id, bot, new Date(), { start: conduct }); setMessage(`@${bot} runs now. Its reply comes in this session.`); return; }
        const now = setBotSchedule(controller.repo, task.id, bot, words[1] === 'on'); if (now.on) tickBots();
        setMessage(now.on ? `@${bot} runs here ${now.label}, next ${dateText(new Date(now.nextRunAt))}.` : `@${bot} no longer runs by itself in this session. Its other sessions are as they were. /bots schedule on ${bot} turns it back on.`);
        return;
      }
      // A bot's colour, wherever its name shows. With no colour a new one is picked at random.
      if (words[0] === 'color') {
        if (words.length < 2 || words.length > 3) throw new Error(`Use /bots color NAME COLOR. COLOR is random or one of: ${BOT_COLORS.join(', ')}.`);
        const bot = needBot(words[1]), random = words[2] === undefined || words[2] === 'random';
        const saved = saveBot({ ...bot, color: random ? pickBotColor(listBots().filter(row => row.name !== bot.name), { not: botColor(bot) }) : words[2] });
        botCache = { at: 0, rows: [] }; setMessage(`@${saved.name} is ${saved.color} now.`); return;
      }
      const bot = words[1] ?? '';
      if (!['add', 'remove'].includes(args[0]) || !bot || args.length > 2) throw new Error('Use /bots, /bots add NAME, /bots remove NAME, /bots schedule on NAME, /bots schedule off NAME, /bots run NAME or /bots color NAME COLOR.');
      return chatBot(args[0], bot);
    }
    if (name === 'projects') { showView('projects'); return; }
    if (name === 'usage') { showView('usage'); return; }
    if (['peers', 'invite', 'join', 'access', 'leave', 'remove', 'share'].includes(name)) return peerSlash(command);
    if (name === 'mine') { if (!facade) throw new Error(PEER_MISSING); if (!peerOn()) throw new Error(NO_TEAM); setMessage(await remoteApp.mine(args)); return; }
    if (name === 'slots') {
      if (!args.length) { setMessage(`${conductorSettings().maxAgents} sessions run at once. Use /slots <1-16> to change it.`); return; }
      if (args.length > 1 || !/^[0-9]+$/.test(args[0])) throw new Error('Use /slots <1-16>.');
      setMessage(`${saveConductorSettings({ maxAgents: Number(args[0]) }).maxAgents} sessions run at once. Running work is not interrupted.`); return;
    }
    if (!controller) throw new Error(NO_PROJECT);
    if (name === 'changes') return showChanges();
    if (name === 'chat') return showChat();
    if (name === 'details') { const task = view === 'chat' && controller.snapshot().tasks.find(row => row.id === selectedId); if (!task) throw new Error('Open a session first.'); return showDetails(repo, task); }
    if (name === 'publish') return publishCurrent();
    if (name === 'stop') return stopCurrent(args[0]);
    if (name === 'archive') {
      const task = view === 'chat' && selectedId && controller.snapshot().tasks.find(row => row.id === selectedId);
      if (!task) throw new Error('Open a session to archive it. In Sessions, c archives the selected one.');
      return closeTask(controller.repo, task, () => { showView(returnTo); focusContent(); });
    }
    if (name === 'archived') { toggleArchived(); return; }
    if (name === 'rename') {
      const task = view === 'chat' && selectedId && controller.snapshot().tasks.find(row => row.id === selectedId);
      if (!task) throw new Error('Open a session to rename it. In Sessions, e renames the selected one.');
      return renameTask(controller.repo, task, args.length ? args.join(' ') : null);
    }
    if (name === 'mcp') {
      const { all, on } = controller.servers();
      if (!args.length) return prompt('MCP servers', [all.length ? all.map(server => `${on.includes(server) ? '● on ' : '○ off'}  ${server}`).join('\n') : 'No MCP servers in Claude Code. Add one with claude mcp add.', '', 'Your Claude Code servers (claude mcp list). Sessions use them all.', '/mcp off NAME turns one off for this project. Teammates\' asks never get them.'].join('\n'));
      if (args.length !== 2 || !['on', 'off'].includes(args[0])) throw new Error('Use /mcp, /mcp on NAME or /mcp off NAME.');
      setMessage(controller.setServer(args[1], args[0] === 'on')); return;
    }
    if (name === 'setup') { if (busyHere()) throw new Error('Wait for running responses before advanced setup.'); return controller.snapshot().initialized ? reviewSetup() : prepareProject(); }
  }
  function positionModal() {
    modal.width = Math.min(88, screen.width - 4); modal.height = Math.min(screen.height - 4, modal.preferredHeight ?? screen.height - 4);
    modal.left = Math.floor((screen.width - modal.width) / 2); modal.top = Math.floor((screen.height - modal.height) / 2);
  }
  // keys: single letters the body names (y accepts, f forwards…). While the field is
  // empty, or still holds the preselected letter Enter would send, pressing one closes the
  // dialog with that letter. trusted: the body is a trusted teammate's text, shown as sent.
  // suggest: a function from the typed text to the options that match it, as rows { name,
  // note }. They are listed under the body. Tab takes the marked one, and an arrow moves the
  // mark and takes that one. A row with a value puts that in the field when it is taken, not
  // its name: a field of several names keeps the ones before. check: a function from the
  // field's text to the reason it cannot be sent, or null. Enter on such a text shows the
  // reason and keeps the dialog open. warn: the same for a text that may be sent anyway, so a
  // second Enter on it submits it.
  function prompt(title, body, value = '', { keys = [], preselect = '', trusted = false, suggest = null, check = null, warn = null } = {}) {
    if (modal) throw new Error('Close the current dialog first.');
    return new Promise(resolve => {
      openDialog();
      modal = dialogBox(title);
      const guided = Boolean(suggest || check || warn), all = suggest?.('') ?? [];
      modal.preferredHeight = Math.max(12, String(body).split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / Math.min(80, screen.width - 12))), 0) + 7 + (guided ? all.length + 3 : 0)); positionModal();
      const text = blessed.box({ parent: modal, top: 1, left: 1, width: '100%-2', height: '100%-5', scrollable: true, keys: true, tags: guided, content: guided ? '' : blockText(body, { trusted }), scrollbar: { ch: '|' } });
      const field = blessed.textbox({ parent: modal, bottom: 1, left: 1, height: 3, width: '100%-2', border: 'line', label: suggest ? ' Enter submits / Tab completes / ↑↓ choose / Esc cancels ' : ' Enter submits / Esc cancels / PageUp reads ', keys: true, mouse: true, inputOnFocus: false, value, tags: false, style: { fg: shade('text'), bg: shade('raised'), border: { fg: accent } } });
      bindInput(field, screen); editable(field);
      // The options for the text typed so far, under the body, with a mark on the one Tab
      // takes. Rows that do not fit give way to a +N more line. The line from check or warn
      // goes last, once Enter was refused or nothing matches. A field that opens with a
      // value lists every option until something is typed.
      let typed = '', options = [], mark = Math.max(0, all.findIndex(row => row.name === value)), refused = null;
      const column = Math.max(0, ...all.map(row => row.name.length)) + 2;
      const list = () => {
        const wide = Math.max(8, text.width - 1), lines = wrapText(blockText(body, { trusted }), wide), stop = check?.(field.value) ?? null, doubt = stop ?? warn?.(field.value) ?? null;
        options = suggest?.(typed) ?? []; mark = Math.max(0, Math.min(mark, options.length - 1));
        const said = !doubt ? null : refused === field.value ? stop ?? `${doubt} Enter again submits it as typed.` : typed && !options.length ? doubt : null, notes = said ? ['', ...wrapText(said, wide)] : [];
        const room = Math.max(2, text.height - lines.length - 1 - notes.length), size = options.length > room ? room - 1 : options.length, start = Math.min(Math.max(0, mark - size + 1), options.length - size);
        const rows = options.slice(start, start + size).map((row, index) => `${ink(start + index === mark ? '>' : ' ', 'orange', colour, true)} ${ink(row.name.padEnd(column), null, colour, start + index === mark)}${ink(fitWords(row.note, wide - column - 2), 'muted', colour)}`);
        text.setContent([...lines.map(line => displayText(line, { trusted })), ...(rows.length ? ['', ...rows] : []), ...(size < options.length ? [ink(`  +${options.length - size} more`, 'muted', colour)] : []), ...notes.map(line => ink(line, 'orange', colour))].join('\n'));
      };
      if (guided) list();
      // One line: Enter submits, as in blessed's textbox.
      const edit = field._listener;
      field._listener = function(ch, key = {}) {
        if (key.name === 'enter' && (check?.(this.value) || warn?.(this.value) && refused !== this.value)) { refused = this.value; list(); screen.render(); return; }
        if (key.name === 'enter') return this._done?.(null, this.value);
        // Tab takes the marked option, then the one after it. An arrow moves the mark and takes that one.
        if (options.length && ['tab', 'up', 'down'].includes(key.name)) {
          const taken = row => row.value ?? row.name;
          if (key.name !== 'tab' || this.value === taken(options[mark])) mark = (mark + (key.name === 'up' || key.shift ? -1 : 1) + options.length) % options.length;
          this.setValue(taken(options[mark])); list(); screen.render(); return;
        }
        if ((!this.value || this.value === preselect) && keys.includes(ch?.toLowerCase()) && !key.ctrl && !key.meta) return this._done?.(null, ch.toLowerCase());
        const before = this.value, result = edit.call(this, ch, key);
        if (guided && this.value !== before) { typed = this.value; mark = 0; refused = null; list(); screen.render(); }
        return result;
      };
      let finished = false;
      const finish = answer => { if (finished) return; finished = true; closeDialog(resolve, answer); };
      modal.dismiss = () => finish(null); modal.keep = () => Boolean(field.value) && field.value !== value;
      field.on('submit', answer => finish(answer)); field.on('cancel', () => finish(null));
      field.on('focus', () => field.readInput());
      field.key('pageup', () => { text.scroll(-5); screen.render(); }); field.key('pagedown', () => { text.scroll(5); screen.render(); });
      field.focus(); minimumSize(); screen.render();
    });
  }
  // Dialogs hand focus back to where the first of them was opened (a settings dialog opens
  // an editor, then comes back), else to the message box, unless something has taken focus
  // since the last one closed.
  let dialogOrigin = null;
  function openDialog() { if (ask._reading) ask.cancel(); dialogOrigin ??= screen.focused; }
  function closeDialog(resolve, answer) {
    modal.destroy(); modal = null; const settled = screen.focused; draw(); resolve(answer);
    setImmediate(() => {
      if (modal || closing) return;
      const before = dialogOrigin; dialogOrigin = null;
      if (screen.focused !== settled) return;
      if (before && before !== ask && !before.destroyed && !before.detached && before.visible) { before.focus(); draw(); } else focusInput();
    });
  }
  // A dialog takes the clicks on its own border and text, so none falls through to the view
  // behind it, and such a click never takes focus from its field or list.
  const dialogBox = title => box({ label: ` ${title} `, clickable: true, autoFocus: false });
  // A dialog is modal for the mouse. A press outside it reaches nothing behind it: it closes
  // a dialog with nothing typed in it, as Esc does, and does nothing to one whose text would
  // be lost (keep). The rest of that press goes nowhere either, since blessed turns a release
  // into a click on whatever is under it, and nor does the wheel outside the dialog.
  // held is where the press in progress began: a dialog, false outside one, null with none
  // open. This runs before the selection and blessed, which both pass over an unknown action.
  let held = null, pressed = { at: 0, x: -1, y: -1 };
  screen.program.prependListener('mouse', data => {
    const pos = modal?.lpos, outside = Boolean(modal) && !(pos && data.x >= pos.xi && data.x < pos.xl && data.y >= pos.yi && data.y < pos.yl);
    if (data.action === 'mousedown' && !(buttonCode(data) & 32)) {
      const now = Date.now(), again = now - pressed.at < 500 && pressed.x === data.x && pressed.y === data.y;
      pressed = { at: now, x: data.x, y: data.y }; held = outside ? false : modal;
      // A double click on the row that opens a dialog: its second press does not close it again.
      if (outside && !again && !modal.keep?.()) modal.dismiss();
    }
    // A drag or a release belongs to the dialog its press began in.
    if (data.action === 'wheelup' || data.action === 'wheeldown' ? !outside : held !== false && (!modal || held === modal)) return;
    if (data.action === 'mouseup') { held = null; screen.mouseDown = null; }
    data.action = 'mouseoutside';
  });
  // Keys belong to the open dialog. Should focus be outside it, a key first puts it back on
  // the dialog's field or list (reader, the one that last had it), so Esc closes the dialog
  // and nothing behind it acts on the key. blessed reads the focused widget after this runs.
  screen.on('element focus', el => { if (modal && el.hasAncestor(modal)) modal.reader = el; });
  screen.program.prependListener('keypress', () => {
    if (!modal?.reader || closing || screen.focused?.hasAncestor(modal)) return;
    modal.reader.focus(); draw();
  });
  // A list in a dialog: Enter picks a row ({ index }), a named letter picks it with that letter
  // ({ index, key }), Esc closes it (null). Rows are tagged text; selected is the row to start on.
  // notes are plain lines shown muted under the rows, wrapped one column short of their box
  // so that blessed never wraps a full line again.
  // shown: the notes are a file's own text, shown as it is, with nothing taken out.
  function listDialog(title, rows, { hint = 'enter choose · esc close', keys = [], selected = 0, notes = [], shown = false } = {}) {
    if (modal) throw new Error('Close the current dialog first.');
    return new Promise(resolve => {
      openDialog();
      modal = dialogBox(title);
      const said = notes.flatMap(note => wrapText(note, Math.min(88, screen.width - 4) - 5)), under = said.length ? said.length + 1 : 0;
      modal.preferredHeight = Math.max(8, rows.length + 4 + under); positionModal();
      if (under) blessed.text({ parent: modal, bottom: 3, left: 2, width: '100%-4', height: said.length, tags: true, content: said.map(line => ink(line || ' ', shown ? 'text' : 'muted', colour, false, { trusted: shown })).join('\n'), style: { fg: muted, bg: shade('panel') } });
      const list = blessed.list({ parent: modal, top: 1, left: 1, width: '100%-2', height: `100%-${4 + under}`, keys: true, mouse: true, vi: false, tags: true, invertSelected: false, style: { fg: shade('text'), bg: shade('panel'), selected: { ...selection } }, scrollbar: { ch: '┃', style: { fg: shade('dim') } } });
      list.setItems(rows); list.select(Math.max(0, Math.min(selected, rows.length - 1)));
      blessed.text({ parent: modal, bottom: 1, left: 2, width: '100%-4', height: 1, tags: true, content: ink(hint, 'muted', colour), style: { fg: muted, bg: shade('panel') } });
      let finished = false;
      const finish = answer => { if (finished) return; finished = true; closeDialog(resolve, answer); };
      modal.dismiss = () => finish(null);
      list.on('select', (_, index) => finish({ index: index ?? list.selected ?? 0 }));
      list.on('cancel', () => finish(null));
      for (const key of keys) list.key(withShift([key]), () => finish({ index: list.selected ?? 0, key }));
      list.on('select item', () => screen.render());
      list.focus(); minimumSize(); screen.render();
    });
  }
  // A text editor in a dialog: Enter adds a line, a paste goes in whole, Ctrl-S saves (the
  // text), Esc cancels (null). note: a line shown above the keys, such as a refused save.
  function editText(title, value = '', { note = '' } = {}) {
    if (modal) throw new Error('Close the current dialog first.');
    return new Promise(resolve => {
      openDialog();
      modal = dialogBox(title);
      modal.preferredHeight = screen.height - 4; positionModal();
      const field = blessed.textarea({ parent: modal, top: 1, left: 1, width: '100%-2', height: '100%-5', inputOnFocus: false, keys: true, mouse: true, tags: false, value, style: { fg: shade('text'), bg: shade('raised') }, scrollbar: { ch: '┃', style: { fg: shade('dim') } } });
      bindInput(field, screen); editable(field); field.setValue(value);
      blessed.text({ parent: modal, bottom: 1, left: 2, width: '100%-4', height: 2, tags: true, content: [note && ink(note, 'orange', colour), ink('Enter adds a line · Ctrl-S saves · Esc cancels', 'muted', colour)].filter(Boolean).join('\n'), style: { fg: muted, bg: shade('panel') } });
      const edit = field._listener;
      field._listener = function(ch, key = {}) {
        if (key.ctrl && key.name === 's') return this._done?.(null, this.value);
        if (key.name === 'enter' && key.sequence !== '\n' && !key.ctrl && !key.meta) return edit.call(this, '\n', { ...key, sequence: '\n' });
        return edit.call(this, ch, key);
      };
      let finished = false;
      const finish = answer => { if (finished) return; finished = true; closeDialog(resolve, answer); };
      modal.dismiss = () => finish(null); modal.keep = () => true;
      field.on('submit', answer => finish(answer)); field.on('cancel', () => finish(null));
      field.on('focus', () => field.readInput());
      field.focus(); minimumSize(); screen.render();
    });
  }
  async function yes(title, body, question = 'Confirm? [y/N]') { return /^y(?:es)?$/i.test((await prompt(title, `${body}\n\n${question}`))?.trim() ?? ''); }
  async function reviewSetup() {
    const plan = controller.setupCommitPlan();
    if (!plan.files.length) { setMessage('The project setup is already committed.'); return true; }
    if (await yes('Review project setup', `Commit these setup files on ${plan.branch}?\n\n${plan.diff}\n\nThis makes a local commit. Nothing is pushed. Project commit hooks are skipped.`)) { setMessage(controller.commitSetup(plan)); return true; }
    setMessage('Advanced setup remains uncommitted. Chat still works without committing it.'); return false;
  }
  async function prepareProject() {
    const history = controller.historyPlan();
    if (history) {
      if (!await yes('Start project history', `${history.root}\n\n${history.message}\n\nFiles in the initial checkpoint:\n${history.files.map(file => file.path).join('\n') || '(empty checkpoint)'}`)) throw new Error('Project history was not created. Your request is saved.');
      repo = controller.createHistory(history); claim.attach(repo);
    }
    if (!controller.snapshot().initialized) {
      if (!controller.draftConfig.checks.length) {
        const command = await prompt('Project checks', 'How should this project be checked? Examples: npm test, node --test, python3 -m pytest, go test ./...\nEnter words separated by spaces, or a JSON argument array for paths with spaces. These checks run with network access blocked.', 'node --test');
        if (!command?.trim()) throw new Error('Project checks are still needed. Your request is saved.');
        controller.setChecks(command.trim().startsWith('[') ? JSON.parse(command) : command.trim().split(/\s+/));
      }
      const plan = controller.setupPlan();
      const body = ['Runs on:', ...Object.entries(plan.config.roles).map(([name, role]) => `${name === 'lead' ? 'model' : name}: ${role.vendor}, ${role.access}, network ${role.network}`), '\nChecks:', ...plan.config.checks.map(check => check.command.join(' ')), '\nWrites:', ...plan.writes, '\n' + plan.message].join('\n');
      if (!await yes('Set up project', body)) throw new Error('Setup was cancelled. Your request is saved.');
      setMessage(controller.setup(plan).message);
      if (!await reviewSetup()) throw new Error('Review and commit the project settings before starting. Your request is saved.');
      usageEnabled = true; controller.refreshUsage().then(draw);
    }
  }
  // Where a ! command runs and the session it joins: the open session's folder, else the
  // open project, else where ELU Code started. A teammate's question never takes one.
  function shellPlace() {
    const task = controller && view === 'chat' && selectedId && !selectedRequest ? (snapshot?.tasks ?? []).find(row => row.id === selectedId) : null;
    let cwd = controller?.repo.root ?? startDirectory;
    if (task?.worktree) { try { if (fs.statSync(task.worktree).isDirectory()) cwd = task.worktree; } catch { /* That folder is gone; the project folder is used. */ } }
    return { cwd, session: task && !fromTeammate(task.origin) && !claim.readOnly ? { repo: controller.repo, id: task.id } : null };
  }
  // One ! command at a time. In an open session it joins the conversation, so the lead sees
  // it with the next message; anywhere else its output opens when it ends.
  function shellCommand(command) {
    if (!command) throw new Error('Type a command after !, such as !git status.');
    if (command.length > 4000) throw new Error('Keep the command under 4,000 characters.');
    if (shellRun) throw new Error(`Still running: ${clip(shellRun.command, 40)}. /stop ends it.`);
    const { cwd, session } = shellPlace(), at = new Date().toISOString();
    const run = runShell(command, { cwd, onOutput: () => { if (!drawing && !closing) scheduleDraw(); } });
    shellRun = { command, cwd, at, run, session };
    setMessage(session ? '' : `Running ${clip(command, 50)} · /stop ends it`);
    run.done.then(async result => {
      shellRun = null;
      if (closing) return;
      const row = { at, command, cwd, ...result }, text = shellText(row);
      if (session) { try { recordShell(session.repo, session.id, row); } catch (error) { setMessage(error.message); } draw(); return; }
      setMessage(modal ? `Finished: ${clip(text.replace(/\n/g, ' · '), 70)}` : ''); draw();
      if (!modal) await prompt(clip(`$ ${command}`, 60), text.includes('\n') ? text : `${text}\n(no output)`);
    }).catch(error => { if (!closing) { setMessage(error.message); draw(); } });
  }
  // Up and Down in the message box walk through what the owner sent, as in a shell: the open
  // session's own messages, then everything sent since the app opened. It is kept in memory only.
  const sentNow = [];
  let recall = null;
  // The turn the last /stop was for, so a second one is told from the first.
  let stopAsked = null;
  const sentBefore = () => {
    const task = openTask(), own = task ? [...(fromTeammate(task.origin) ? [] : [task.goal]), ...(task.messages ?? []).filter(row => !row.bot && !row.from && !row.scheduled).map(row => row.to ? `${row.to} ${row.text}` : row.text)] : [];
    // A session's first message is its goal and is also its first saved message: one of them is enough.
    return [...own.filter(text => typeof text === 'string' && text.trim()).map(text => text.trim()).filter((text, at, all) => text !== all[at - 1] && !sentNow.includes(text)), ...sentNow];
  };
  // The message box sends to whatever the view shows: a new task, the open task, or a teammate.
  // The new session form with a bot that has a schedule in it, and nothing typed: the session
  // starts with that bot's first turn, and no message goes to the model. Other scheduled bots
  // of the form start by themselves once the session is there. false when this is not that form.
  function startWithBot() {
    if (!controller || !composing() || composeWhen) return false;
    const starter = composeBots.find(name => botScheduleIn(controller.repo, null, name)?.label);
    if (!starter) return false;
    let request;
    try {
      controller.writable();
      request = enqueue(controller.repo.root, 'Start working.', { priority: 0, permissions: composeMode ?? defaultMode(), place: composePlace, folders: composeFolders, bots: composeBots, ...(composeModel ? { model: composeModel } : {}), bot: starter });
    } catch (error) { setMessage(error.message); focusInput(); return true; }
    recall = null; palette.hide(); chatShown = null; message = ''; drafts.delete(draftKey());
    following = { root: controller.repo.root, id: request.id, bot: starter };
    sessionView = 'chat'; selectedId = null; selectedRequest = request;
    ask.clearValue(); usageEnabled = true; controller.refreshUsage().then(draw);
    conduct(); resize(); focusInput();
    return true;
  }
  async function submit(text) {
    // An empty Enter keeps the box reading: a box left focused but not reading drops keys.
    // In the new session form it starts the session when a bot that has a schedule is in it.
    if (!text.trim()) { if (!startWithBot()) focusInput(); return; }
    openStarted();
    recall = null;
    if (sentNow.at(-1) !== text.trim()) { sentNow.push(text.trim()); if (sentNow.length > 200) sentNow.shift(); }
    palette.hide();
    // What the owner sends shows at the end of the chat, wherever he had scrolled to.
    chatShown = null;
    // ! runs the rest in a shell, as in a terminal. It is never sent to the model or a teammate.
    if (text.trimStart().startsWith('!')) {
      try { shellCommand(text.trimStart().slice(1).trim()); ask.clearValue(); sessionView = 'chat'; }
      catch (error) { ask.setValue(text); setMessage(error.message); }
      finally { focusInput(); draw(); }
      return;
    }
    if (text.trimStart().startsWith('/')) {
      try { const command = parseCommand(text); ask.clearValue(); await dispatch(command); }
      catch (error) { ask.setValue(text); paletteDismissed = text; setMessage(error.message); }
      finally { if (!modal) focusInput(); draw(); }
      return;
    }
    // A file that changed while the project was open is asked about before the message goes.
    if (controller && !claim.readOnly) await catchAction(() => reviewProjectFiles(controller.repo.root));
    let mention = null, toModel = false;
    // What goes back in the box when the message cannot be sent: the text as it was typed.
    const typed = () => toModel ? `@model ${text}` : text;
    try {
      if (view === 'chats') {
        // @name writes to that teammate whatever is open; otherwise the open channel or person gets it.
        let words = text.trim().split(/\s+/);
        // @name of one of my own bots, when no teammate has that name: its chat opens and takes the rest.
        const mine = /^@[a-z0-9-]+$/i.test(words[0]) && !teammateNamed(words[0]) ? listBots().find(bot => bot.name === words[0].slice(1).toLowerCase()) ?? null : null;
        if (mine) {
          chatOpen = { type: 'bot', target: botTarget(null, mine.name), name: mine.name, peer: null, owner: null, box: null, about: mine.about, online: true };
          chatJump = chatTarget = chatOpen.target;
          text = text.trim().slice(words[0].length).trim(); words = text.split(/\s+/);
          if (!text) { ask.clearValue(); setMessage(`Write your message to @${mine.name}.`); focusInput(); return; }
        }
        if (!mine && words[0].startsWith('@') || !chatOpen) await peerSlash({ name: 'ask', args: words, text: text.trim() });
        else if (text.trim().length > 16000) throw new Error('Keep it under 16,000 characters.');
        else if (chatOpen.type === 'member') {
          // Every word is the message: only @name with a handle picks a project.
          const who = peerName(chatOpen.name, chatOpen.key);
          sentLine(await peerCommand({ type: 'ask', to: chatOpen.key, project: null, text: text.trim() }), who, `Sent to ${who}. Their reply shows in this thread.`);
        } else if (chatOpen.type === 'bot' && chatOpen.peer) {
          // A teammate's bot: the question goes to their machine and names the bot.
          const owner = peerName(chatOpen.owner, chatOpen.peer);
          sentLine(await peerCommand({ type: 'ask', to: chatOpen.peer, bot: chatOpen.name, project: null, text: text.trim() }), owner, `Sent to @${chatOpen.name} on ${botHome(chatOpen)}. It runs after ${owner} accepts it.`);
        } else if (chatOpen.type === 'bot') {
          // My own bot has one chat in the active project: this message continues it, and the
          // first one starts it. A bot that has a schedule then also runs there by itself.
          if (!controller) throw new Error(NO_PROJECT);
          controller.writable();
          const own = botChatSession(controller.repo, chatOpen.name);
          if (own?.starting) throw new Error(`@${chatOpen.name} is still starting its session. Send this again in a moment.`);
          if (own) enqueue(controller.repo.root, text.trim(), { priority: 0, continuationTaskId: own.id, bot: chatOpen.name });
          else enqueue(controller.repo.root, text.trim(), { priority: 0, permissions: defaultMode(), place: { kind: 'worktree' }, folders: [], bot: chatOpen.name, botChat: true });
          conduct();
          setMessage(own ? `@${chatOpen.name} answers in its session. It is in Sessions.` : `@${chatOpen.name} answers in a new session. It is in Sessions.`);
        } else {
          const result = await peerCommand({ type: 'teamAsk', project: null, text: text.trim(), team: chatOpen.team, channel: chatOpen.channel });
          setMessage(withCount(result, `Sent to #${chatOpen.name}. The first teammate to take it answers.`));
        }
        ask.clearValue(); focusInput(); return;
      }
      if (view === 'kanban') {
        if (!controller && !await createHere()) { ask.setValue(text); focusInput(); return; }
        addCard(controller.repo, text); ask.clearValue(); setMessage('Added to To do. Shift+→ on it starts it.'); focusInput(); return;
      }
      // @model writes to the session's model, whoever the owner wrote to last. Alone it sends nothing.
      if (TO_MODEL.test(text.trimStart())) {
        text = text.trimStart().replace(TO_MODEL, '').trim(); toModel = true;
        if (!text) { ask.setValue('@model '); setMessage('Write your message after @model.'); focusInput(); return; }
      }
      // @name first sends the message to that saved bot; any other @word goes where a message with no name goes.
      if (!toModel && text.trimStart().startsWith('@')) mention = botMessage(text, listBots());
      // A teammate's @name asks them. A bot of that name comes first.
      const first = text.trim().split(/\s+/)[0], person = !mention && !toModel && text.trimStart().startsWith('@') ? teammateNamed(first) : null;
      // A session on another computer of mine: the message continues it there. In the new
      // session box, @name of one of my computers first starts the session on that computer.
      const here = remoteHere(), machine = !here && !mention && !toModel && (sessionBox() || composing()) ? remoteApp.named(first) : null;
      if (here || machine) return await remoteSubmit(here, machine, here ? (toModel ? `@model ${text}` : text) : text.trim().slice(first.length).trim());
      if (person) {
        const question = text.trim().slice(first.length).trim();
        // The name alone adds nobody: the box keeps it, ready for the question.
        if (!question) { ask.setValue(`@${person.name} `); setMessage(`Write your question after @${person.name}.`); focusInput(); return; }
        await peerSlash({ name: 'ask', args: [`@${person.name}`, ...question.split(/\s+/)], text: `@${person.name} ${question}` });
        ask.clearValue(); focusInput(); return;
      }
      if (sessionBox()) {
        let root = goalTarget();
        if (!root) { if (!await createHere()) { ask.setValue(typed()); focusInput(); return; } root = controller?.repo.root; if (!root) return; }
        await newTaskForm(root); if (!controller) return;
      }
      controller.writable();
      // @name alone adds that bot to the open session, or to the new session form.
      if (mention && !mention.text) { chatBot('add', mention.bot.name, { again: true }); ask.clearValue(); focusInput(); return; }
      if (composeWhen && composing()) { if (mention) throw new Error(`A schedule is not written to a bot. Take @${mention.bot.name} off the start.`); return await scheduleTask(text); }
    } catch (error) { ask.setValue(typed()); setMessage(error.message); focusInput(); return; }
    // The session may have started while this was on its way.
    let pending = openStarted();
    // A message that waits for a turn of its session to end is not one to rewrite: this one
    // waits beside it in that session, and the two go together when the turn ends.
    if (selectedRequest && pending?.continuationTaskId && !pending.origin && ['queued', 'starting'].includes(pending.state)) { selectedId = pending.continuationTaskId; selectedRequest = null; }
    // The message that starts this session still waits for the conductor: this one goes with
    // it, in the order sent, as waiting messages go together. It never takes its place. One
    // written to someone else cannot go with it, so it stays in the box.
    if (selectedRequest && pending?.state === 'queued' && !pending.continuationTaskId && !pending.origin && !pending.scheduled && !pending.scheduleId) {
      // With no @name it goes to whoever the first was written to, and @model goes to the model.
      const to = mention ? mention.bot.name : toModel ? null : pending.bot ?? null;
      const same = to === (pending.bot ?? null), joined = same ? addToRequest(controller.repo.root, pending.id, mention ? mention.text : text) : null;
      if (joined) { message = ''; drafts.delete(draftKey()); selectedRequest = joined; ask.clearValue(); conduct(); resize(); focusInput(); return; }
      pending = openStarted();
      if (selectedRequest && pending?.state === 'queued') { ask.setValue(typed()); setMessage('This session has not started yet. Send this once it has.'); focusInput(); return; }
    }
    // While the conductor is still starting it there is no session to wait in yet, and the request is no longer one to rewrite.
    if (selectedRequest && pending?.state === 'starting') { ask.setValue(typed()); setMessage('This session is still starting. Send this again in a moment.'); focusInput(); return; }
    const root = controller.repo.root, continuation = selectedRequest ? selectedRequest.continuationTaskId ?? null : selectedId;
    message = '';
    drafts.delete(draftKey());
    // A new session carries the compose rows; a saved request keeps its own.
    const session = continuation ? {} : selectedRequest ? { permissions: selectedRequest.permissions, place: selectedRequest.place, folders: selectedRequest.folders, ...(selectedRequest.bots ? { bots: selectedRequest.bots } : {}), ...(selectedRequest.model ? { model: selectedRequest.model } : {}) } : { permissions: composeMode ?? defaultMode(), place: composePlace, folders: composeFolders, bots: composeBots, ...(composeModel ? { model: composeModel } : {}) };
    // A saved request keeps the bot it was written to, so one that now goes to the model is sent as a new request.
    const rewritten = Boolean(selectedRequest?.bot) && !mention;
    // In an open session a message with no @name goes to whoever the owner wrote to last: a bot they
    // wrote to stays the one they are talking to until they name another, or @model.
    let stays = null;
    if (!mention && !toModel && continuation && !selectedRequest) { try { stays = addressedBot(controller.snapshot().tasks.find(row => row.id === continuation), pendingRequests(root)); } catch { /* It goes to the model. */ } }
    const to = mention ? mention.bot.name : stays;
    let request;
    // The bot gets the message without its @name; the chat shows who it was written to.
    try { request = enqueue(root, mention ? mention.text : text, { id: rewritten ? undefined : selectedRequest?.id, continuationTaskId: continuation, priority: 0, ...session, ...(to ? { bot: to } : {}) }); if (rewritten) removeRequest(root, selectedRequest.id); }
    catch (error) { ask.setValue(typed()); setMessage(error.message); focusInput(); return; }
    following = { root, id: request.id, bot: to };
    // What was sent shows in the chat.
    sessionView = 'chat';
    selectedId = continuation; selectedRequest = continuation ? null : request;
    ask.clearValue(); usageEnabled = true; controller.refreshUsage().then(draw);
    conduct(); resize(); focusInput();
  }
  async function quit() {
    if (closing) return;
    if (modal?.dismiss) modal.dismiss(); else if (modal) modal.children.find(child => child.type === 'textbox')?.emit('cancel');
    closing = true; shellRun?.run.stop(); clearInterval(timer); clearInterval(usageTimer); clearInterval(scheduleTimer); clearInterval(changesTimer); clearTimeout(patchTimer); usageAbort.abort();
    let failure;
    try { await controller?.close(); } catch (error) { failure = error; }
    try { claim.release(); } catch (error) { failure ??= error; }
    screen.destroy(); if (failure) rejectDone(failure); else resolveDone();
  }
  ask.on('submit', text => catchAction(() => submit(text)));
  ask.on('focus', () => ask.readInput());
  // Esc leaves the message box for the view's main pane.
  ask.on('cancel', () => { palette.hide(); if (screen.focused === ask && !closing) focusContent(); else draw(); });
  // Tabs and buttons
  tabs.forEach((tab, index) => {
    tab.on('press', () => catchAction(() => { if (ask._reading) ask.cancel(); showView(tab.viewName); focusContent(); }));
    tab.key(['left', 'right'], (_, key) => { tabs[(index + (key.name === 'left' ? -1 : 1) + tabs.length) % tabs.length].focus(); draw(); });
    tab.key('down', () => { const next = subButtons()[0] ?? viewPanes()[0]; if (next) { next.focus(); draw(); } else focusInput(); });
    tab.on('focus', () => draw());
  });
  newBot.on('press', () => catchAction(() => botsAction('new')));
  newProject.on('press', () => catchAction(() => projectsAction('new')));
  back.on('press', () => catchAction(() => { if (ask._reading) ask.cancel(); showView(returnTo); focusContent(); }));
  newCard.on('press', () => catchAction(() => kanbanAction(0, 'new')));
  for (const widget of [newCard, newBot, newProject, back]) {
    widget.key(['left', 'right'], (_, key) => { const row = subButtons(), at = row.indexOf(widget); row[(at + (key.name === 'left' ? -1 : 1) + row.length) % row.length].focus(); draw(); });
    widget.key('up', () => { activeTab().focus(); draw(); });
    widget.key('down', () => focusContent());
    widget.on('focus', () => draw());
  }
  for (const widget of [...tabs, newCard, newBot, newProject, back]) widget.key('escape', () => focusInput());
  // Sessions: the cursor's row shows on the right as it moves. Enter or Right goes into it, to the message box.
  // A click on a row shows it and goes into it, to the message box, so what is typed next is
  // a message and not the list's letter keys. blessed has selected the row by then, and it
  // opens a row that was already selected by itself (select).
  let rowOpened = false;
  board.on('select', () => { rowOpened = true; queueMicrotask(() => { rowOpened = false; }); catchAction(() => boardAction('open')); });
  // A click on the line that counts the archived sessions shows them, and hides them again.
  board.on('element click', el => {
    if (modal || el === board) return;
    if (boardLines[board.items.indexOf(el)]?.archive) { toggleArchived(); scheduleDraw(); return; }
    if (!rowOpened) catchAction(() => boardAction('open'));
  });
  board.key('enter', () => { if (!modal) catchAction(() => boardAction('open')); });
  board.key('right', () => { if (!modal) focusInput(); });
  // n declines a peer row and starts a new task anywhere else; + always starts one.
  for (const [keys, action] of [[['a'], 'answer'], [['s', 'x'], 'stop'], [['r'], 'retry'], [['d'], 'diff'], [['c'], 'close'], [['e'], 'rename'], [['u'], 'unarchive'], [['p'], 'publish'], [['y'], 'accept'], [['f'], 'full'], [['w'], 'work'], [['n'], 'decline'], [['+'], 'new']]) board.key(withShift(keys), () => { if (!modal) catchAction(() => boardAction(action)); });
  board.key('escape', () => focusInput());
  board.on('focus', () => draw());
  // A click or the wheel on a heading lands on the nearest row the way it was going.
  board.on('select item', (_, index) => {
    if (drawing) return;
    if (!lineKey(boardLines[index])) {
      const down = boardLines.findIndex((line, place) => place > index && lineKey(line)), up = boardLines.findLastIndex((line, place) => place < index && lineKey(line));
      board.select(index < barAt && up >= 0 ? up : down >= 0 ? down : barAt); return;
    }
    pointBar(lineKey(boardLines[index])); scheduleDraw();
  });
  // Arrows skip the group headings. Past the first row are the tabs; past the last, the message box.
  const boardRowsAt = () => boardLines.map((line, index) => lineKey(line) ? index : -1).filter(index => index >= 0);
  function focusBoard() { const rows = boardRowsAt(); if (rows.length && !rows.includes(board.selected ?? 0)) board.select(rows[0]); board.focus(); }
  function boardStep(step) {
    const rows = boardRowsAt(), at = rows.indexOf(board.selected ?? 0), next = at < 0 ? 0 : at + step;
    if (!rows.length || next < 0 || next >= rows.length) return false;
    board.select(rows[next]); return true;
  }
  board.key(['up', 'down'], (_, key) => { if (modal) return; if (!boardStep(key.name === 'up' ? -1 : 1)) { if (key.name === 'up') activeTab().focus(); else focusInput(); } draw(); });
  board.key(['pageup', 'pagedown', 'home', 'end'], (_, key) => {
    if (modal) return;
    const rows = boardRowsAt(), at = Math.max(0, rows.indexOf(board.selected ?? 0)), page = Math.max(1, board.height - 2);
    const next = key.name === 'home' ? 0 : key.name === 'end' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (key.name === 'pageup' ? -page : page)));
    if (rows.length) board.select(rows[next]); draw();
  });
  // New task form
  composeList.on('select', () => catchAction(() => composeAction(composeRows[composeList.selected ?? 0])));
  composeList.key(['x', 'delete', 'backspace'], () => { if (!modal) catchAction(() => composeAction(composeRows[composeList.selected ?? 0], 'remove')); });
  // Esc or Left leaves the right side for the list. A session opened from Kanban goes back to the board.
  const leaveSession = () => { if (modal) return; if (!listed()) showView(returnTo); focusContent(); };
  composeList.key('escape', leaveSession);
  for (const pane of [composeList, activity]) pane.key('left', () => { if (listed()) leaveSession(); });
  composeList.on('select item', () => { if (!drawing) scheduleDraw(); });
  // Chats
  teamLists.forEach((list, index) => {
    list.on('select', () => catchAction(() => teamAction(index, 'open')));
    for (const [keys, action] of [[['y'], 'accept'], [['n'], 'decline'], [['a'], 'ask'], [['c'], 'continue'], [['t'], 'trust'], [['m'], 'members'], [['x'], 'leave']]) list.key(withShift(keys), () => { if (!modal) catchAction(() => teamAction(index, action)); });
    list.key('escape', () => focusInput());
    list.on('focus', () => { lastPane.chats = list; draw(); });
    list.on('select item', () => { if (!drawing) scheduleDraw(); });
  });
  teamLists[0].key('right', () => { if (!modal && screen.width >= 100) { teamLists[1].focus(); draw(); } });
  teamLists[1].key('left', () => { if (!modal && screen.width >= 100) { teamLists[0].focus(); draw(); } });
  activity.key('escape', leaveSession);
  // A session's two views share the right pane: its chat, and what it changed. One answer
  // from Git is kept per session, so coming back to a session shows it at once.
  let sessionView = 'chat', changesFrom = null, patchTimer = null, patchAsked = null, changesShown = null, built = { rows: [] };
  const patches = new Map();
  // The session whose changes are on screen, as root and id, or null.
  const patchKey = () => sessionView === 'changes' && view === 'chat' && controller && selectedId && snapshot?.tasks?.some(row => row.id === selectedId) ? `${controller.repo.root}\0${selectedId}` : null;
  const unfolded = (entry, file) => entry.fold.get(file.path) ?? entry.wide ?? true;
  // The rows for one width, built again only when the changes, the width or a fold moves.
  function patchRows(entry, width) {
    if (built.entry !== entry || built.changes !== entry.changes || built.width !== width || built.version !== entry.version) {
      const open = new Set(entry.changes.files.flatMap((file, index) => unfolded(entry, file) ? [index] : []));
      built = { entry, changes: entry.changes, width, version: entry.version, rows: changeRows(entry.changes, width, colour, { open }) };
    }
    return built.rows;
  }
  // The summary names the branch a session started from while its base commit is still on it.
  // Git is asked once for each branch the project is on, not at every read.
  function baseName(task, entry) {
    try {
      const home = task.repository ?? controller.repo.root, name = currentBranch(home);
      if (!name || name === task.branch || task.place?.kind === 'here') return null;
      if (entry.based?.name !== name) entry.based = { name, on: git(home, ['merge-base', '--is-ancestor', task.base, `refs/heads/${name}`], { allowFailure: true }).status === 0 };
      return entry.based.on ? name : null;
    } catch { return null; }
  }
  // Asks Git what the session on screen changed. This starts Git, so it runs from a timer of
  // its own and never while drawing. A read that finds nothing new keeps the rows as they are.
  function readPatch(key) {
    patchTimer = null;
    if (closing || key !== patchKey()) return;
    const id = selectedId, task = snapshot.tasks.find(row => row.id === id), started = Date.now();
    const entry = patches.get(key) ?? { changes: null, digest: null, error: null, fold: new Map(), wide: null, version: 0, cursor: 0, top: 0 };
    // The sessions looked at last are kept. The oldest goes first.
    patches.delete(key); patches.set(key, entry); if (patches.size > 24) patches.delete(patches.keys().next().value);
    try {
      const changes = taskPatch(controller.repo, id), digest = hash(JSON.stringify(changes));
      entry.error = null;
      if (digest !== entry.digest) {
        // The cursor stays on its line of its file while the rows around it change.
        const old = built.entry === entry ? built.rows : null, at = old?.[entry.cursor], name = at?.file != null ? entry.changes.files[at.file]?.path ?? null : null;
        const offset = name === null ? 0 : entry.cursor - old.findIndex(row => row.file === at.file), gap = entry.cursor - entry.top;
        entry.changes = { ...changes, base: (changes.base && baseName(task, entry)) || changes.base }; entry.digest = digest;
        // Up to five files start unfolded. More start folded, as a list to pick from.
        if (entry.wide === null && changes.files.length) entry.wide = changes.files.length <= 5;
        if (built.width) {
          const rows = patchRows(entry, built.width), index = name === null ? -1 : changes.files.findIndex(file => file.path === name), start = index < 0 ? -1 : rows.findIndex(row => row.file === index);
          if (start >= 0) { entry.cursor = start + Math.min(offset, rows.filter(row => row.file === index).length - 1); entry.top = Math.max(0, entry.cursor - gap); }
        }
      }
    } catch (error) { entry.error = plain(error.message).replace(/\s+/g, ' ').trim() || 'The changes could not be read.'; }
    entry.live = ['running', 'preparing'].includes(task?.state); entry.at = Date.now(); entry.took = entry.at - started;
    draw();
  }
  function askPatch(key, wait) { clearTimeout(patchTimer); patchTimer = key ? setTimeout(() => readPatch(key), wait) : null; }
  // While the session runs its changes are read again: every five seconds, or less often
  // when a read is slow, so reading never takes more than a twentieth of the time. One more
  // read follows the end of the run.
  const changesTimer = setInterval(() => {
    const key = patchKey(), entry = key ? patches.get(key) : null;
    if (!entry || closing || patchTimer) return;
    const live = ['running', 'preparing'].includes(snapshot.tasks.find(row => row.id === selectedId)?.state);
    if (live ? Date.now() - entry.at >= Math.max(5000, entry.took * 20) : entry.live) askPatch(key, 0);
  }, 1000);
  // Focus leaves the Changes view for where it was before: the list, the message box or the chat.
  function leaveChanges() {
    const to = changesFrom; changesFrom = null;
    if (to === ask || !listed() && to !== activity) focusInput(); else if (to === activity && view === 'chat') activity.focus(); else focusBoard();
  }
  function showChat() { sessionView = 'chat'; if (screen.focused === changesBox) leaveChanges(); draw(); }
  // focus: the keys go to the view (d on the list, a click on its name). A command typed in
  // the message box leaves them there.
  function showChanges({ focus = false } = {}) {
    if (!controller || view !== 'chat' || !controller.snapshot().tasks.some(row => row.id === selectedId)) throw new Error('Open a session first.');
    sessionView = 'changes'; patchAsked = `${controller.repo.root}\0${selectedId}`; askPatch(patchAsked, 0);
    if (focus && screen.focused !== changesBox) { const from = screen.focused; if (ask._reading) ask.cancel(); changesBox.focus(); changesFrom = [board, ask, activity].includes(from) ? from : null; }
    draw();
  }
  // The switch, and under it the rows in view when Changes shows. Nothing here asks Git.
  function drawSessionViews(task) {
    const offered = view === 'chat' && Boolean(task), on = offered && sessionView === 'changes', key = on ? `${controller.repo.root}\0${task.id}` : null, entry = key ? patches.get(key) ?? null : null;
    // Another session shows, or the view came back: its changes are read once the cursor rests on it.
    if (key !== patchAsked) { patchAsked = key; askPatch(key, 150); }
    sessionTabs.hidden = !offered; changesBox.hidden = !on; changesShown = null;
    if (offered) {
      // The count is the last one read, also while the chat shows.
      const known = patches.get(`${controller.repo.root}\0${task.id}`), label = changeSummary(known && !known.error ? known.changes : null);
      const word = (text, active) => active ? `${colour ? `{${PALETTE.orange}-fg}` : ''}{bold}{underline}${text}{/underline}{/bold}${colour ? '{/}' : ''}` : ink(text, 'muted', colour);
      sessionTabs.setContent(` ${word('Chat', !on)}   ${word(label, on)} `);
      Object.assign(sessionTabs, { top: activity.top, left: activity.left + 1, width: label.length + 9 });
    }
    // The pane went while it had the focus (its session closed elsewhere): the focus goes back.
    if (!on) { if (screen.focused === changesBox) leaveChanges(); return; }
    activity.hidden = true;
    Object.assign(changesBox, { top: activity.top, left: activity.left, width: activity.width, height: activity.height });
    changesBox.style.border.fg = screen.focused === changesBox ? accent : shade('border');
    // A row is the cursor's mark, the text, then the scrollbar's column.
    const high = Math.max(1, changesBox.height - 2), width = Math.max(8, changesBox.width - 4), line = (text, tone) => [{ text: ink(fitWords(text, width), tone, colour), kind: 'note', file: null }];
    const rows = !entry ? line('Reading changes…', 'muted') : entry.error ? line(entry.error, 'orange') : patchRows(entry, width);
    const cursor = Math.max(0, Math.min(entry?.cursor ?? 0, rows.length - 1)), most = Math.max(0, rows.length - high);
    const top = Math.max(cursor - high + 1, Math.min(entry?.top ?? 0, cursor, most));
    if (entry) { entry.cursor = cursor; entry.top = top; }
    const thumb = most ? Math.round((high - 1) * top / most) : -1, tone = screen.focused === changesBox ? 'orange' : 'dim';
    changesBox.setContent(rows.slice(top, top + high).map((row, at) => `${ink(rows.length > 1 && top + at === cursor ? '▌' : ' ', tone, colour)}${row.text}${' '.repeat(Math.max(0, width - blessed.unicode.strWidth(visible(row.text))))}${at === thumb ? ink('┃', 'dim', colour) : ' '}`).join('\n'));
    changesShown = { key, entry: entry?.error ? null : entry, rows, high, top, cursor };
  }
  // Up and Down move the cursor a row, and the rows follow it. The wheel moves the rows, and the cursor stays in view.
  function moveChanges(step, { rows = false } = {}) {
    const now = changesShown, entry = now?.entry; if (modal || !entry) return;
    const last = now.rows.length - 1, most = Math.max(0, now.rows.length - now.high);
    if (rows) { entry.top = Math.max(0, Math.min(most, entry.top + step)); entry.cursor = Math.max(entry.top, Math.min(entry.top + now.high - 1, entry.cursor, last)); }
    else { entry.cursor = Math.max(0, Math.min(last, entry.cursor + step)); if (Math.abs(step) > 1) entry.top = Math.max(0, Math.min(most, entry.top + step)); }
    draw();
  }
  // Folds or unfolds the file whose header is on that row.
  function foldChanges(index) {
    const now = changesShown, entry = now?.entry, row = now?.rows[index], file = row?.kind === 'file' ? entry?.changes.files[row.file] : null; if (modal || !file) return;
    entry.fold.set(file.path, !unfolded(entry, file)); entry.version++; entry.cursor = index; draw();
  }
  changesBox.key(['up', 'down'], (_, key) => moveChanges(key.name === 'up' ? -1 : 1));
  changesBox.key(['pageup', 'pagedown'], (_, key) => moveChanges((key.name === 'pageup' ? -1 : 1) * Math.max(1, (changesShown?.high ?? 2) - 1)));
  changesBox.key(['home', 'end'], (_, key) => moveChanges(key.name === 'home' ? -Infinity : Infinity));
  changesBox.key(['enter', 'space'], () => foldChanges(changesShown?.cursor));
  changesBox.key(['escape', ...withShift(['d'])], () => { if (!modal) showChat(); });
  changesBox.on('wheelup', () => moveChanges(-3, { rows: true })); changesBox.on('wheeldown', () => moveChanges(3, { rows: true }));
  // A click puts the cursor on its row. On a file's header it also folds or unfolds the file.
  changesBox.on('click', data => {
    const now = changesShown, index = now ? now.top + data.y - changesBox.atop - 1 : -1; if (modal || !now?.entry || index < now.top || index >= now.rows.length) return;
    if (now.rows[index].kind === 'file') foldChanges(index); else { now.entry.cursor = index; draw(); }
  });
  // Leaving the message box by a key passes through the list on the way to this view, so
  // the box counts as where the focus came from for the rest of that key.
  let leftBox = false;
  ask.on('blur', () => { leftBox = true; setImmediate(() => { leftBox = false; }); });
  changesBox.on('focus', from => { const origin = leftBox ? ask : from; if ([board, ask, activity].includes(origin)) changesFrom = origin; draw(); });
  sessionTabs.on('click', data => { if (!modal) catchAction(() => data.x - sessionTabs.aleft < 6 ? showChat() : showChanges({ focus: true })); });
  // Kanban
  kanbanLists.forEach((list, index) => {
    list.on('select', () => catchAction(() => kanbanAction(index, 'open')));
    list.key(['left', 'right'], (_, key) => { if (modal) return; const next = kanbanLists[index + (key.name === 'left' ? -1 : 1)]; if (next) { next.focus(); draw(); } });
    list.key(['S-right', '>'], () => { if (!modal) catchAction(() => kanbanAction(index, 'forward')); });
    list.key(['S-left', '<'], () => { if (!modal) catchAction(() => kanbanAction(index, 'back')); });
    list.key(['n', '+'], () => { if (!modal) catchAction(() => kanbanAction(index, 'new')); });
    list.key(['x', 'delete'], () => { if (!modal) catchAction(() => kanbanAction(index, 'remove')); });
    list.key('escape', () => focusInput());
    list.on('focus', () => { lastPane.kanban = list; draw(); });
    list.on('select item', () => { if (!drawing) scheduleDraw(); });
  });
  // Kanban: teammates' Tasks. Arrows move between Tasks, Enter shows one; no key changes one.
  kanbanTeamList.key(['up', 'down'], (_, key) => { if (modal) return; if (!teamTaskStep(key.name === 'up' ? -1 : 1)) { if (key.name === 'up') (lastPane.kanban ?? kanbanLists[0]).focus(); else focusInput(); } draw(); });
  kanbanTeamList.key('enter', () => { if (!modal) catchAction(() => openTeamTask()); });
  kanbanTeamList.on('select', () => { if (!modal) catchAction(() => openTeamTask()); });
  kanbanTeamList.key('escape', () => focusInput());
  kanbanTeamList.on('focus', () => { teamTaskStep(0); draw(); });
  kanbanTeamList.on('select item', () => { if (!drawing) scheduleDraw(); });
  // Bots
  botsList.on('select', () => catchAction(() => botsAction('open')));
  botsList.key(['n', '+'], () => { if (!modal) catchAction(() => botsAction('new')); });
  botsList.key(withShift(['x']), () => { if (!modal) catchAction(() => botsAction('remove')); });
  botsList.key('escape', () => focusInput());
  botsList.on('focus', () => draw());
  botsList.on('select item', () => { if (!drawing) scheduleDraw(); });
  // Projects
  projectsList.on('select', () => catchAction(() => projectsAction('settings')));
  projectsList.key(['n', '+'], () => { if (!modal) catchAction(() => projectsAction('new')); });
  projectsList.key(withShift(['o']), () => { if (!modal) catchAction(() => projectsAction('open')); });
  projectsList.key(withShift(['x']), () => { if (!modal) catchAction(() => projectsAction('archive')); });
  projectsList.key('escape', () => focusInput());
  projectsList.on('focus', () => draw());
  projectsList.on('select item', () => { if (!drawing) scheduleDraw(); });
  // Usage
  usageList.on('select', () => catchAction(() => usageAction('open')));
  usageList.key(withShift(['r']), () => { if (!modal) catchAction(() => usageAction('refresh')); });
  usageList.key('escape', () => focusInput());
  usageList.on('focus', () => draw());
  usageList.on('select item', () => { if (!drawing) scheduleDraw(); });
  // The screen hears a key before the focused list moves, so a list can be left from its edge:
  // up to the view's buttons, down to the next pane or the message box.
  // The empty Bots list is one message over its rows, so every row of it is an edge.
  const atEdge = (list, key) => list === botsList && !botRows.length || (key.name === 'up' ? (list.selected ?? 0) <= 0 : key.name === 'down' && (list.selected ?? 0) >= list.items.length - 1);
  screen.on('keypress', (_, key = {}) => {
    const focused = screen.focused;
    if (modal || closing || !(focused === composeList || teamLists.includes(focused) || kanbanLists.includes(focused) || [botsList, projectsList, usageList].includes(focused)) || !['up', 'down'].includes(key.name) || !atEdge(focused, key)) return;
    // Stacked panes (Internal under 100 columns) lead into each other first.
    const panes = viewPanes(), at = panes.indexOf(focused), stacked = view === 'chats' && screen.width < 100;
    if (key.name === 'up') { if (stacked && at > 0) panes[at - 1].focus(); else (view === 'kanban' ? newCard : view === 'bots' ? newBot : view === 'projects' ? newProject : listed() || ['chats', 'usage'].includes(view) ? activeTab() : back).focus(); }
    else if (stacked && at >= 0 && at < panes.length - 1) panes[at + 1].focus();
    else if (kanbanLists.includes(focused) && teamTaskRows.some(row => row.task)) kanbanTeamList.focus();
    else focusInput();
    draw();
  });
  // Ctrl-C with text highlighted copies it and stays; with none it quits.
  screen.key(['C-c'], () => catchAction(() => {
    const text = mouseSelection.text(); if (!text) return quit();
    copyText?.(text); mouseSelection.clear(); copied(text);
  }));
  // Tab moves between areas: the current tab, the view's buttons, its panes, then the message box.
  function focusNext(backwards = false) {
    if (modal || closing) return;
    // In Sessions the message box comes right after the list, so Tab on a row starts typing; the chat follows it.
    const panels = listed() ? [activeTab(), board, ask, ...viewPanes().slice(1)] : [activeTab(), ...subButtons(), ...viewPanes(), ask];
    const index = panels.indexOf(tabs.includes(screen.focused) ? activeTab() : screen.focused);
    if (screen.focused === ask) ask.cancel();
    const next = panels[(index + panels.length + (backwards ? -1 : 1)) % panels.length];
    if (next === board) focusBoard(); else next.focus();
    draw();
  }
  screen.key('tab', () => { if (screen.focused !== ask || palette.hidden) focusNext(); }); screen.key('S-tab', () => focusNext(true));
  const nativeInput = ask._listener;
  ask._listener = function(ch, key = {}) {
    if (!this._reading || typeof this._done !== 'function') return;
    syncPalette();
    if (!palette.hidden) {
      if (key.name === 'up' || key.name === 'down') { palette.select((palette.selected + (key.name === 'up' ? -1 : 1) + paletteValues.length) % paletteValues.length); screen.render(); return; }
      if (key.name === 'escape') { paletteDismissed = this.getValue(); palette.hide(); screen.render(); return; }
      if (key.name === 'tab') { this.setValue(`${paletteValues[palette.selected ?? 0].value} `); syncPalette(); screen.render(); return; }
      if (key.name === 'enter' && key.sequence !== '\n') {
        const chosen = paletteValues[palette.selected ?? 0];
        // A bot's whole @name, typed out, is sent as it is: Enter alone adds that bot to the session.
        const whole = view !== 'chats' && chosen.value.startsWith('@') && this.getValue().trim() === chosen.value;
        if (chosen.more && !whole) { choosePalette(chosen); return; }
        this.setValue(chosen.value);
      }
    } else if (recall && ['up', 'down'].includes(key.name) && this.getValue() === recall.list[recall.at]) {
      // Walking through what was sent: Up is older, Down is newer, and Down past the newest empties the box.
      const at = recall.at + (key.name === 'up' ? -1 : 1);
      if (at >= recall.list.length) { const dropped = recall.taken; recall = null; this.setValue(''); if (dropped) setMessage('Dropped. It will not be sent.'); }
      else if (at >= 0) { recall.at = at; this.setValue(recall.list[at]); }
      paletteDismissed = this.getValue(); syncPalette(); screen.render(); return;
    } else if (!this.getValue() && ['up', 'down'].includes(key.name)) {
      // Up in an empty box takes back the newest message that still waits for the turn to end:
      // it is in the box again, Enter sends it and Down drops it.
      const taken = key.name === 'up' ? takeBack() : null;
      if (taken !== null) { const list = [...sentBefore().filter(text => text !== taken.trim()), taken]; recall = { list, at: list.length - 1, taken: true }; this.setValue(taken); paletteDismissed = taken; syncPalette(); setMessage('Taken back. Enter sends it again · ↓ drops it.'); return; }
      // Up in an empty box brings back the last thing sent. With nothing sent yet, the arrows leave the box as before.
      const list = key.name === 'up' ? sentBefore() : [];
      if (list.length) { recall = { list, at: list.length - 1 }; this.setValue(list.at(-1)); paletteDismissed = this.getValue(); syncPalette(); screen.render(); return; }
      this.cancel(); focusContent(key.name === 'up' && view !== 'kanban' ? viewPanes().length - 1 : 0); return;
    } else if (key.name === 'left' && this.cursor === 0 && listed() && !key.ctrl && !key.meta && !key.shift) {
      // Left at the start of the text goes back to the list.
      this.cancel(); return;
    }
    if (key.name === 'tab') return;
    // Enter sends. A newline inside pasted text arrives as a bare line feed and stays in the message.
    if (key.name === 'enter' && key.sequence !== '\n') { this._done(null, this.value); return; }
    const value = nativeInput.call(this, ch, key); syncPalette(); screen.render(); return value;
  };
  screen.on('keypress', (ch, key = {}) => {
    if (modal || closing || screen.focused === ask || busy || minimumSize()) return;
    const command = key.name ?? ch;
    if ([...tabs, newCard, newBot, newProject, back].includes(screen.focused) && !['q', '?'].includes(command)) return;
    if (command === 'q') catchAction(() => quit());
    else if (command === '?') catchAction(() => dispatch({ name: 'help', args: [] }));
    else if (command === 'i' && screen.focused === activity) focusInput();
    // In a session, y or n answers the first approval the lead waits on, and
    // f allows it and gives the session Full access where that is offered.
    else if (['y', 'n', 'f', 'a'].includes(command) && screen.focused === activity && view === 'chat' && controller) catchAction(async () => {
      const task = selectedId && !selectedRequest ? controller.snapshot().tasks.find(row => row.id === selectedId) : null, first = task && approvalsFor(task)[0];
      if (!first) return;
      if (command === 'f') return offersFull(task, first) ? allowFull(task, first) : undefined;
      if (command === 'a') return allowAlways(task, first);
      setMessage(answerApproval(first.id, command === 'y' ? 'allow' : 'deny') ? command === 'y' ? 'Allowed.' : 'Denied.' : 'That approval was already answered.');
    });
  });
  // In a session, y approves and n rejects the Task that waits (lib/plan.mjs). An approval of
  // an action in the same session keeps the two keys: it is answered first, by the handler above.
  screen.on('keypress', (ch, key = {}) => {
    if (modal || closing || screen.focused === ask || busy || minimumSize()) return;
    const command = key.name ?? ch;
    if (!['y', 'n'].includes(command) || screen.focused !== activity || view !== 'chat' || !controller) return;
    catchAction(() => {
      const task = selectedId && !selectedRequest ? controller.snapshot().tasks.find(row => row.id === selectedId) : null;
      if (task?.plan?.state !== 'proposed' || approvalsFor(task).length) return;
      decideTask(controller.repo.root, task, command === 'y');
    });
  });
  const interrupted = () => { catchAction(() => quit()); };
  for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, interrupted);
  screen.on('resize', resize);
  const timer = setInterval(() => draw(true), refreshMs);
  // The login item follows this install, so a moved checkout or a new Node still runs schedules.
  if (listSchedules().some(row => row.enabled)) { try { loginItem.install(); } catch { /* Schedules still run while a terminal is open. */ } }
  const scheduleTimer = setInterval(() => { try { if (tickBots() + runDue(new Date(), { start: conduct })) draw(); } catch { /* The login item retries. */ } refreshAwake(); }, 30000);
  const usageTimer = setInterval(() => { if (usageEnabled && !closing && view === 'chat') controller.refreshUsage().then(draw); }, 60000);
  // Started in a folder that is not a project: open the last project used. Only a first start asks for a name.
  let here = repo ?? null;
  if (askProject && !here) { try { here = projectFolder(startDirectory); } catch { /* The disk root is never a project. */ } }
  let fresh = askProject && here && !teamStart && !knownProject(here);
  if (fresh) { let last = null; try { last = registeredProjects().at(-1); } catch { /* An unreadable registry asks for a name. */ } if (last) { here = last; fresh = false; } }
  try {
    if (here && !fresh) activateProject(here);
    resize(); focusInput();
    if (fresh) setImmediate(() => catchAction(() => nameHere(here)));
    await done;
  } finally {
    clearInterval(timer); clearInterval(usageTimer); clearInterval(changesTimer); clearTimeout(patchTimer); for (const signal of ['SIGTERM', 'SIGHUP']) process.off(signal, interrupted);
    if (!closing) { closing = true; await controller?.close(); claim.release(); screen.destroy(); }
  }
  return { terminal: true };
}
