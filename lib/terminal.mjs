import blessed from 'blessed';
import { ProjectController, dashboardSnapshot, claimView, VIEW_ONLY, registerProject, registeredProjects, archiveProject, taskDetails, taskPatch, conversationEntries, wroteIt, modelLabel, modelName, reportedModels, sessionModel, knownProject, nameProject, savedProjectName } from './projects.mjs';
import { pushesRunning, redact, stopPushes } from './publish.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { projectPath, projectFolder, createFolderPlan, createFolder, pendingRequests, removeRequest, takeRequest, addToRequest, updateRequest, dropRequests, typedRequest, sendTypedNow } from './workspace.mjs';
import { asideStatus, runsCommand, sentWords, waitingWords } from './message-aside.mjs';
import { git } from './git.mjs';
import { runShell, recordShell, shellText } from './shell.mjs';
import { readProjectSettings, saveInstructions, saveContext } from './project-settings.mjs';
import { answerTrust, longNote, pendingTrust, reviewLines, unusedTrust } from './project-trust.mjs';
import { parseConfig } from './config.mjs';
import { updateNotice, UPDATE_IN_APP } from './update.mjs';
import { enqueue as queueRequest, sendCommand, startConductor as launchConductor, retryRequest, saveConductorSettings, conductorSettings, openingConductor, conductorNote } from './conductor.mjs';
import { readablePictures } from './pictures.mjs';
import { columns as widthOf, cut as cutText, padEnd } from './width.mjs';
import { boardRows, barCells, barColumns, boardSections, rowActions, rowCard, peerDecision, peerIncoming } from './board.mjs';
import { SLOTS_RULE, SLOTS_RULE_UNSET, waitingText, waitState } from './waiting.mjs';
import { limitText } from './conductor-files.mjs';
import { COMMANDS, SCHEDULE_PRESETS, argumentMatches, commandMatches, mentionMatches, sessionMentions, commandWords, needsArgument, parseCommand, typedCommand, vendorText, waitWords } from './terminal-commands.mjs';
import { BOT_COLORS, listBots, getBot, needBot, chatBots, sessionBots, botColor, botOfKey, botShadows, botWorks, pickBotColor, saveBot, canShare } from './bots.mjs';
import { matchModels } from './bot-models.mjs';
import { modelChoices, findModel, choiceName, modelText, modelProblem, rememberModel, installedVendors, modelTag, entryTag, vendorShort, modelWords } from './models.mjs';
import { addAgent, agentWords } from './agents.mjs';
import { botLines, botNames, botMessage, botDialogs } from './terminal-bots.mjs';
import { PALETTE, displayText, ink, keyHints, visible, terminalLayout, relativeTime, remote, peerName, threadWho, clockTime, sentState, teamPanes, membersLine, teammateLine, roomTarget, dmTarget, botTarget, peerSummary, chatBlock, tagged, messageTime, fitWords, wrapText, stepLines, stepsLine, STEPS_LINE, silentLine } from './terminal-visuals.mjs';
import { runSteps, endedSteps, runsOfEntries, runSeconds } from './run-activity.mjs';
import { sanitize } from './peer/peerdata.mjs';
import { scanSecrets } from './peer/secrets.mjs';
import { approveTask, approvesTasks, rejectTask, saysYes, taskEta } from './plan.mjs';
import { etaText, taskCard, taskLetBy, taskNeedsYou, taskPlace } from './terminal-plan.mjs';
import { COLUMNS, lastActivity, readBoard, addCard, editCard, removeCard, startCard, linkCards, setDone, boardColumns, fitCard, fitTeammateCard, closeSession, reopenSession } from './kanban.mjs';
import { boardSlice, folderRemote, projectBoards, sessionFolders } from './kanban-repos.mjs';
import { taskTitle, setTitle, nameProblem, TITLE_MAX, requestGoal, sessionGoal, teammateText, readTask, taskDir, tasks as savedTasks } from './state.mjs';
import { setPermissions as saveMode, allowHome } from './runner.mjs';
import { listSchedules, saveSchedule, removeSchedule, pauseSchedule, runScheduleNow, runDue, runBots, parseWhen, splitWhen, nextRun, dateText, installScheduler, uninstallScheduler, FULL_SCHEDULE, NO_HERE } from './schedules.mjs';
import { runBotSchedules, botScheduleIn, botScheduleLines, setBotSchedule, runBotNow, schedulesOn, botChatSession, botSchedulesShown, botScheduleBrief } from './bot-schedules.mjs';
import { peerPolicy as savedPeerPolicy } from './peer/settings.mjs';
import { MODES, LABELS, BADGES, APPROVAL_WAIT_SECONDS, checkMode, checkPlace, checkFolders, foldersBelowFull, capMode, defaultMode, saveDefaultMode, isPeerRun, fromTeammate } from './modes.mjs';
import { VENDORS, VENDOR_NAMES, VENDOR_COMMANDS, CAPS, DEVICE_SIGN_IN_COMMAND, vendorWithCommand } from './vendors.mjs';
import { computerDefault, passedOver, saveComputerDefault, setDefaultModel as saveProjectDefault, startModel } from './models.mjs';
import { startConfig } from './projects.mjs';
import { pendingApprovals, answerApproval } from './approvals.mjs';
import { liftedBy, neverSentence, whyBlocked } from './never-list.mjs';
import { entryLine, keepOffer, keepRule, listEntries, removeEntry, turnOnEntry, usesSavedRules } from './permission-rules.mjs';
import { checkResult, conformanceState, failedText, uncheckedText, vendorReading } from './conformance.mjs';
import { findBin, hash, HOME_QUESTION, homeOrAbove, homeWork } from './util.mjs';
import { shellSandboxLine } from './sandbox.mjs';
import { changeRows, changeSummary, fileKey, noteKey, notesMessage, placeNotes, readNotes, saveNotes } from './changes.mjs';
import { steadyWheel, frameRender } from './wheel.mjs';
import { usageTab, refreshUsage, usageStale, accountOf, accountsStamp, forgetAccount, recordAccount } from './usage.mjs';
import { DEFAULT_LOGIN, DEVICE_SIGN_IN, LOGIN_ENV, LOGIN_VENDORS, SIGN_IN, finishLogin, hasBrowser, listLogins, newLogin, removeLogin, shareServersAll, useLogin } from './logins.mjs';
import { OLD_COUNT, UNPRICED, agentSpend, agentTable, spendText, topRows } from './agent-spend.mjs';
import { detect } from './detect.mjs';
import { askLoadsAgain, checkOnFirstUse, readSignInNow, readSignInsBeforeCheck, signInsUnread, withCheck } from './vendor-check.mjs';
import { ADAPTERS } from './adapters/index.mjs';
import { readAllModels, readBotModels } from './bot-models.mjs';
import { refreshAwake } from './awake.mjs';
import { editable } from './editor.mjs';
import { attachPaste, pastedText } from './paste.mjs';
import { claudeServers, findServerConfig, cliServerConfig, keyedConfigText, keyedLine, secretsOf, addServer, removeServer, nameProblem as serverNameProblem, headerProblem, envProblem, headerValue } from './mcp.mjs';
import { readCode } from './peer/invite-code.mjs';
import { offeredName } from './peer/identity.mjs';
import { reachText } from './peer/reach-text.mjs';
import { STANDUP_GOAL, everyoneMessage, standupHas, standupStage, standupWaitLine } from './standup.mjs';
import { HERE, boxKeys, hereMention, remoteSessions } from './terminal-remote.mjs';
import { helperLink, helperTask, helperTick, helperTitle, linkHelper, ownerWrote, sendsTo } from './remote-helper.mjs';
import { stopLine, errorText } from './stop-line.mjs';
import { committedLine, finished, publishWords, published, pushStopNote, restingMove, stateWord } from './task-head.mjs';
import { carryOnCapped } from './carry-on.mjs';
import { keepRows } from './terminal-visuals.mjs';
import { attachReports, attachSelection, systemClipboard, buttonCode } from './selection.mjs';

// Everything the owner types for a session is queued here. A picture the message names in a
// folder no session may read (a screenshot saved under ~/Library) is first copied to where
// the session can read it, and the message names the copy. It is marked typed: what he sends
// himself starts whatever the number of sessions running (ownerTyped in lib/workspace.mjs).
// What the app queues by itself (a helper's turn, a carried-on session) goes by queueRequest.
const enqueue = (root, goal, options) => queueRequest(root, readablePictures(goal).text, { ...options, typed: true });

// All display text is untrusted, including tool output and task titles.
export function plain(value) { return redact(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f]/g, ' '); }
const clip = (value, width) => cutText(plain(value), width, '...');
// Key hints joined by a dot, on as many rows as the width needs. A hint is never split.
const keyRows = (text, width) => text.split(' · ').reduce((rows, part) => { const last = rows.at(-1); if (last !== undefined && widthOf(`${last} · ${part}`) <= width) rows[rows.length - 1] = `${last} · ${part}`; else rows.push(part); return rows; }, []);
// What this computer's agents spent today: the same runs the Usage tab's top agents add up.
export function todayCost(projects, now = new Date()) {
  return spendText(agentSpend(projects, { now: now.getTime(), days: 1 }));
}
// The Usage tab's spend line: what every computer shown spent today, at least that when a run
// reported no cost. parts: [{ name, spend }], this computer first; with more than one, each
// one's part follows. waiting: computers of mine that are online and have not sent theirs yet.
// A part marked old is from a computer on a build before 0.1.20, whose costs can be too high.
export function spendLine(parts, waiting = [], offline = []) {
  const known = parts.filter(part => part.spend.costUsd !== null), runs = parts.reduce((sum, part) => sum + (part.spend.runs ?? 1), 0);
  const all = { costUsd: known.length ? known.reduce((sum, part) => sum + part.spend.costUsd, 0) : null, partial: parts.some(part => part.spend.partial || part.spend.costUsd === null && part.spend.runs !== 0), runs };
  const each = parts.length > 1 ? `: ${parts.map(part => `${part.name} ${spendText(part.spend)}${part.old ? ' (older ELU)' : ''}`).join(', ')}` : '';
  const why = all.costUsd === null && runs > 0 ? [...new Set(parts.flatMap(part => part.spend.unpriced ?? []))].map(vendor => vendorShort(vendor)) : [];
  return `ELU spend today ${spendText({ ...all, partial: all.partial && all.costUsd !== null })}${why.length ? ` (${why.join(', ')} reported no cost)` : ''}${each}${waiting.length ? `; waiting for ${waiting.join(', ')}` : ''}${offline.length ? `; ${offline.join(', ')} offline, not counted` : ''}`;
}
// The Usage tab. A reset time is the clock when it is today, else the day and the clock.
const USAGE_NAMES = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', grok: 'Grok Build' };
const resetTime = (seconds, now) => { const at = new Date(seconds * 1000); return at.toDateString() === now.toDateString() ? at.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : at.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', ''); };
const dayText = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric' }) : 'unknown';
const pct = value => `${Math.round(value)}%`;
// Claude's usage is what Claude Code reports during a session, so none shows before one.
const CLAUDE_UNSEEN = 'Usage shows after your next session on Claude Code.';
const CLAUDE_ACCOUNT_UNSEEN = 'Usage shows after a session on this account.';
// One window: a six-cell bar, the percent, the reset. A window the vendor did not report says so.
function usageWindow(name, row, now) {
  if (row?.usedPercent == null) return `${name}  [------]    —   ${row?.resetsAt ? `resets ${resetTime(row.resetsAt, now)}` : 'not reported'}`;
  const percent = Math.round(row.usedPercent), used = Math.round(percent * 6 / 100);
  return `${name}  [${'#'.repeat(used)}${'-'.repeat(6 - used)}]  ${pct(percent).padStart(4)}  ${row.resetsAt ? `resets ${resetTime(row.resetsAt, now)}` : 'reset not reported'}`;
}
// A vendor that needs the one-time check: where it stands, after its sign-in. One that was
// never checked runs in Full access, which needs no check, and in no other mode until c or
// a message in another mode checked it.
const NEEDS_CHECK = 'Full access only (c checks it)';
const checkWord = row => row.running ? 'checking…' : row.check === 'ready' ? 'ready' : row.check === 'failed' ? 'Full access only (c checks again)' : NEEDS_CHECK;
// Words on lines of at most width characters, for what a check says under its vendor.
const wrapWords = (text, width) => plain(text).split(/\s+/).filter(Boolean).reduce((lines, word) => { const last = lines.at(-1); if (last !== undefined && widthOf(`${last} ${word}`) <= width) lines[lines.length - 1] = `${last} ${word}`; else lines.push(word); return lines; }, []);
const otherText = other => [other.account, `last seen ${dayText(other.lastSeen)}`, ...(other.usage?.weekly?.usedPercent != null ? [`wk ${pct(other.usage.weekly.usedPercent)} then`] : other.usage?.fiveHour?.usedPercent != null ? [`5h ${pct(other.usage.fiveHour.usedPercent)} then`] : [])].join(' · ');
// One block per vendor from usageTab() rows. Claude and Codex list every account signed in
// here, the one new turns use marked active, each with its two windows; then the accounts
// seen before that are not signed in here, and the keys. Each line names its vendor, and an
// account's lines name the account (login), so Enter on any of them uses it. Antigravity and
// Grok Build say where they stand with their one-time check after their sign-in; checks holds
// a check c started here, per vendor: { running, lines, current, error }, its lines shown
// under the vendor as the session shows them.
export function usageBlocks(rows, { now = new Date(), checks = new Map(), reading = false } = {}) {
  const out = [];
  for (const row of rows) {
    const name = (USAGE_NAMES[row.vendor] ?? row.vendor).padEnd(12), indent = ' '.repeat(12);
    const add = (text, tone = 'text', bold = false, login = null) => out.push({ vendor: row.vendor, login, text, tone, bold });
    const windows = (usage, login, unseen) => {
      if (usage || row.vendor === 'codex') { add(indent + usageWindow('5h', usage?.fiveHour, now), 'text', false, login); add(indent + usageWindow('wk', usage?.weekly, now), 'text', false, login); }
      else add(indent + unseen, 'muted', false, login);
    };
    if (!row.installed) { add(`${name}not installed`, 'muted'); continue; }
    if (row.check) {
      const run = checks.get(row.vendor), state = { ...row, running: run?.running === true }, notes = [];
      // Until it is ready its line is about its sign-in or its check, and names the command
      // after the vendor: the owner installed and types that, not this name.
      const named = VENDOR_COMMANDS[row.vendor] ? `${name}(${VENDOR_COMMANDS[row.vendor]}) ` : name;
      if (!row.signedIn && row.signInRead === false) add(`${named}${row.signedOutText ?? `not signed in. ${row.signInHint}`}`, 'muted');
      else if (!row.signedIn && row.unchecked && !row.runsHere) { add(`${named}this release cannot run here`, 'muted'); notes.push(row.signInReason); }
      // What the tab is waiting for while it reads the sign-in, and why a read gave no answer.
      else if (!row.signedIn && row.unchecked) { add(`${named}${reading ? 'reading its sign-in…' : row.signInReason ? 'sign-in not read' : 'sign-in not read yet'} · ${checkWord(state)}`, 'muted'); if (!reading) notes.push(row.signInReason); }
      else add((checkWord(state) === 'ready' ? name : named) + [row.active?.account ?? 'signed in', row.active?.plan, checkWord(state)].filter(Boolean).join(' · '), 'text', true);
      // What its check found, in the words the chat got: what is not proven, and what else it loads here.
      if (!run?.error && !(run && row.check === 'ready')) notes.push(...(row.notes ?? (row.check === 'failed' ? [`Not proven: ${row.notProven}${row.more ? `, and ${row.more} more` : ''}.`] : [])));
      // What the check said: the lines it keeps, then the step it is on, or why it stopped.
      if (run) notes.push(...run.lines, run.running ? run.current : run.error);
      for (const note of notes.filter(Boolean)) for (const line of wrapWords(note, 76 - indent.length)) add(indent + line, 'muted');
      continue;
    }
    if (row.keysHint) {
      // Signed out on the account in use: that is said first, and the others are still listed.
      const listed = (row.accounts ?? []).filter(item => item.account && (row.signedIn || !item.active));
      let first = true; const head = text => { const out = (first ? name : indent) + text; first = false; return out; };
      if (!row.signedIn) add(head(`not signed in. ${row.signInHint}`), 'muted');
      for (const item of listed) {
        add(head([item.account, item.plan, item.active ? 'active' : null].filter(Boolean).join(' · ')), 'text', item.active, item.login);
        windows(item.usage, item.login, row.vendor === 'claude' ? item.active ? CLAUDE_UNSEEN : CLAUDE_ACCOUNT_UNSEEN : 'usage not reported');
      }
      if (row.signedIn && !listed.length) { const login = row.accounts?.find(item => item.active)?.login ?? DEFAULT_LOGIN; add(head('signed in · active'), 'text', true, login); windows(row.usage, login, row.vendor === 'claude' ? CLAUDE_UNSEEN : 'usage not reported'); }
      for (const other of row.others ?? []) add(indent + otherText(other), 'muted');
      add(indent + (listed.length ? row.keysHint : 'a add account'), 'muted');
      continue;
    }
    if (!row.signedIn) { add(`${name}${row.signedOutText ?? `not signed in. ${row.signInHint}`}`, 'muted'); continue; }
    add(name + [row.active?.account ?? 'signed in', row.active?.plan, 'active'].filter(Boolean).join(' · '), 'text', true);
    windows(row.usage, null, 'usage not reported');
    for (const other of row.others ?? []) add(indent + otherText(other), 'muted');
  }
  return out;
}
// The details dialog for one vendor: when its usage was reported, both windows with their resets, other accounts.
export function usageDetailLines(row, now = new Date()) {
  if (!row.installed) return ['Not installed.'];
  // Not checked yet: its sign-in as read, then what the check is and that c runs it.
  if (row.unchecked && !row.signedIn) return [row.signInRead === false ? row.signedOutDetail ?? `Not signed in. ${row.signInHint}` : row.signInReason ?? 'Sign-in not read yet. r reads it.', '', uncheckedText(row.vendor), ...(row.runsHere ? ['c runs it now.'] : [])];
  if (!row.signedIn) return [row.signedOutDetail ?? `Not signed in. ${row.signInHint}`];
  const failed = row.check === 'failed' ? checkResult(row.vendor, { bin: row.bin ?? null, version: row.release ?? null }) : null;
  if (failed?.failed.length) return ['Signed in.', '', failedText(row.vendor, failed, { next: false }), 'c runs the check again.'];
  if (row.check && row.check !== 'ready') return ['Signed in.', '', uncheckedText(row.vendor, { bin: row.bin ?? null, version: row.release ?? null }), row.check === 'failed' ? 'c runs it again.' : 'c runs it now.'];
  const lines = [[row.active?.account ?? 'signed in', row.active?.plan, row.active?.tier].filter(Boolean).join(' · ')], usage = row.usage;
  if (!usage) lines.push('', row.vendor === 'claude' ? CLAUDE_UNSEEN : 'Usage not reported.');
  else lines.push(`Reported ${clockTime(usage.observedAt)}`, '', usageWindow('5h', usage.fiveHour, now), usageWindow('wk', usage.weekly, now));
  const signedIn = (row.accounts ?? []).filter(item => item.account && !item.active);
  if (signedIn.length) lines.push('', 'Also signed in', ...signedIn.map(item => [item.account, item.plan, item.usage?.weekly?.usedPercent != null ? `wk ${pct(item.usage.weekly.usedPercent)}` : item.usage?.fiveHour?.usedPercent != null ? `5h ${pct(item.usage.fiveHour.usedPercent)}` : null].filter(Boolean).join(' · ')));
  if (row.others?.length) lines.push('', 'Other accounts', ...row.others.map(other => [other.account, other.plan, `first seen ${dayText(other.firstSeen)}`, otherText(other).split(' · ').slice(1).join(' · ')].filter(Boolean).join(' · ')));
  if (row.keysHint) lines.push('', row.keysHint);
  if (row.notes?.length) lines.push('', ...row.notes);
  return lines;
}
export const geometry = terminalLayout;
// There is no peer on or off: the peer daemon runs while this machine is on a team. /invite
// and /join start it; the app starts it when it opens on a machine on a team.
const NO_TEAM = 'No team yet. Invite someone with /invite, or join with /join CODE.';
// What plain /invite offers.
const INVITE_NEW = 'Someone new: get an invite code to send them', INVITE_BOTS = 'Choose which of your bots teammates can use';
// Chats on a machine on no team.
const CHATS_OFF = 'No team yet.\nInvite someone: /invite\nGot a code? /join CODE';
const NO_PROJECT = 'Create a project first: press n in the Projects tab.';
const PEER_STOPPED = 'The peer daemon is not running. ELU starts it again within a minute.';
const PEER_MISSING = 'Teammates need the optional networking packages. Reinstall with optional dependencies.';
const WEEK = 7 * 24 * 60 * 60 * 1000;
// A project file of more pages than this is asked about at once, not page by page (reviewProjectFiles).
const LONG_PAGES = 20;
// The facade never loads the networking packages itself; a missing module only hides peer features.
async function loadPeer() { try { return await import('./peer/index.mjs'); } catch { return null; } }
// One chat message as a block: header, then text behind the speaker's bar. Built once per text and width.
// The text is compared with the ones kept under the same header, never copied into the key:
// the chat asks for every block on every tick, and a long message must cost that nothing.
const blocks = new Map();
function chatMessage({ title, narrow = null, at = null, text, tone, shaded = false, raw = false }, width, colour) {
  const time = at ? messageTime(at) : '', body = String(text ?? ''), key = [width, tone, shaded, colour, title, narrow ?? '', time, raw, body.length].join('\x00');
  const kept = blocks.get(key), found = kept?.find(row => row.text === body);
  if (found) return found.value;
  // raw: a command and its output keep their asterisks and backticks.
  const value = chatBlock({ title, narrow, time, text: raw ? blockText(body) : blockText(body).replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1'), tone, shaded, width, colour });
  if (kept) { kept.push({ text: body, value }); if (kept.length > 20) kept.shift(); } else blocks.set(key, [{ text: body, value }]);
  if (blocks.size > 500) blocks.delete(blocks.keys().next().value);
  return value;
}
// trusted: text from a trusted teammate shows as sent; control characters still go.
// A short value, such as an invite code, set apart in a frame so it reads as the thing to send.
// While a bot's turn runs and nothing is reported yet: the model and effort it was saved with,
// when it names them. A bot that runs on the session's model in this session (modelFallback)
// shows none.
function startedOn(task, role) {
  const name = botOfKey(role); if (!name) return null;
  let bot = null; try { bot = getBot(name); } catch { return null; }
  if (!bot) return null;
  const fallback = task?.modelFallback && Object.hasOwn(task.modelFallback, name);
  return modelTag({ model: fallback ? null : bot.model, effort: bot.effort });
}
const framed = value => { const rule = '─'.repeat(widthOf(value) + 6); return `╭${rule}╮\n│   ${value}   │\n╰${rule}╯`; };
// A message shows whole, whatever its length: the chat pages, and a block is built once.
function blockText(value, { trusted = false } = {}) {
  const text = String(value ?? '');
  return (trusted ? text : redact(text, Infinity)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}
// The pickers: a number, the choice, what it means.
const PICK = (number, label, text) => `${number}  ${label.padEnd(19)}${text}`;
// What each mode allows, in one line each, the internet included.
const MODE_TEXT = { ask: "Edits the session's files; asks you for the rest and the internet.", auto: "Edits the session's files; a reviewer model, not you, decides the rest.", full: 'Any file, any command, the internet.' };
const PLACE_TEXT = { worktree: 'A copy of this repo on a new branch, feat/task-N.', branch: 'This repo on a branch you name.', here: 'This checkout, as it is.  Full access only.' };
const placeHint = place => place?.kind === 'branch' ? `This repo on branch ${place.branch}.` : place?.kind === 'here' ? 'This checkout, as it is.' : 'A copy of this repo on a new branch.';
const PLACE_LABEL = { worktree: 'New worktree', branch: 'Branch', here: 'Here' };
const READ_ONLY_PEERS = 'Teammate questions stay read-only.';
// A schedule whose mode the owner did not pick runs with Approve for me at most.
const SCHEDULE_CAP = 'A schedule gets Full access only when you pick it for that schedule.';
const placeText = place => place?.kind === 'branch' ? `Branch ${place.branch}` : PLACE_LABEL[place?.kind] ?? PLACE_LABEL.worktree;
const expandHome = value => { const text = String(value ?? '').trim(); return text === '~' ? os.homedir() : text.startsWith('~/') ? path.join(os.homedir(), text.slice(2)) : text; };
const shortHome = value => { const home = os.homedir(); return value === home ? '~' : value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value; };
// A bot runs under the role bot:name; the owner reads @name.
const roleLabel = role => botOfKey(role) ? `@${botOfKey(role)}` : role;
// Whether what this role asks in this session can be given Full access: the owner's own
// session, for the model or a bot of its chat, its scheduled turns too. Never a teammate's
// question, a session from before modes, or another role.
const fullAllowed = (task, role) => Boolean(task) && !isPeerRun(task.origin) && MODES.includes(task.permissions) && (!role || role === 'lead' || Boolean(botOfKey(role)));
// The mode the turn in progress started with: the session's before the first switch made
// since the turn began.
function turnMode(task) {
  const times = [task.activeSince, (task.messages ?? []).findLast(row => !row.from)?.at].map(value => Date.parse(value ?? '')).filter(Number.isFinite);
  const first = times.length ? (task.permissionChanges ?? []).find(row => Date.parse(row.at) > Math.max(...times)) : null;
  return first ? first.from : task.permissions ?? null;
}
// A peer's @name as their team gives it. Inside the app peerName also knows my own computers.
const memberName = peerName;
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
// session may have Full access; current: the session's mode now, which may already lift it.
// what: the action alone, as the continuation names it.
const ranIn = run => MODES.includes(run?.effectivePermissions) ? run.effectivePermissions : MODES.includes(run?.permissions) ? run.permissions : 'locked';
function blockedLine(denial, run, asked = [], { cwd = null, full = true, current = null, waits = true } = {}) {
  // The mode the turn really ran in: one asked for Approve for me may have run in Ask for approval.
  const what = blockedText(denial, cwd), mode = MODES.includes(run?.effectivePermissions) ? run.effectivePermissions : run?.permissions ?? null, why = whyBlocked(denial, { mode, vendor: run?.vendor ?? null, asked });
  const toFull = full ? '/permissions full continues it.' : 'this session cannot have Full access, so do it yourself.';
  if (why.kind === 'never') { const line = plain(why.line).replace(/\s+/g, ' ').trim(); return { kind: why.kind, what, text: `Blocked: ${neverSentence(why.command)}${line === why.command ? '' : ` (${why.alone ? '' : 'part of: '}${clip(line, 120)})`}. Run it yourself.` }; }
  // The mode was raised after the turn stopped, to one that lifts this: a reply goes on.
  if (['network', 'full', 'ask', 'reviewer'].includes(why.kind) && MODES.includes(current) && current !== ranIn(run) && liftedBy(why.kind, current)) return { kind: why.kind, what, text: `Blocked: ${what}. ${LABELS[current]} is on now: reply to continue.` };
  const text = {
    secret: `Blocked: ${what}. Files that may hold secrets stay closed: open it yourself.`,
    own: `Blocked: ${what}. ELU's own files stay closed in every mode.`,
    // waits: the turn stopped there. One that went on without it says what it left undone.
    timeout: `${waits ? 'Stopped' : 'Not done'}: ${what}. No answer in ${waitText(why.wait ?? APPROVAL_WAIT_SECONDS)}; reply to try again.`,
    owner: `Stopped: ${what}. You said no; reply with what to do instead.`,
    network: `Blocked: ${what}. The internet is off for commands in ${LABELS[mode] ?? LABELS.locked}: ${toFull}`,
    full: `Blocked: ${what}. Needs Full access: ${toFull}`,
    ask: `Blocked: ${what}. This session is read only: /permissions ask continues it.`,
    reviewer: `Blocked: ${what}. Approve for me's reviewer said no: /permissions ask lets you decide.`,
    // Shown while the session waits for him, where /publish would refuse: the changes are checked first.
    git: `Blocked: ${denial?.tool === 'Bash' ? blockedText({ tool: 'Bash', input: denial.input }) : what}. No commit is needed: ELU commits when you publish. Reply to go on.`,
    rule: `Blocked: ${what}. A rule no mode lifts refused it.`,
  }[why.kind];
  return { kind: why.kind, what, text };
}
// Absolute paths in a trusted teammate's message that exist on this machine, as the folders
// the lead may read: a file offers its folder. Paths that fail the folder
// check of the session's mode are left out. In Full access (mode 'full') that check takes
// any folder there is, and as many as the message names; the other modes take eight.
export function foldersNamed(text, { mode } = {}) {
  const out = [];
  for (const match of String(text ?? '').matchAll(/(?<![\w:/.~-])(?:~|\/[\w.@+-]+)(?:\/[\w.@+-]+)+\/?/g)) {
    const value = expandHome(match[0].replace(/\/$/, ''));
    let dir; try { dir = fs.statSync(value).isDirectory() ? value : path.dirname(value); } catch { continue; }
    try { for (const folder of checkFolders([dir], { mode })) if (!out.includes(folder)) out.push(folder); } catch { /* Not a folder the lead may read. */ }
  }
  return mode === 'full' ? out : out.slice(0, 8);
}

// A list's letter keys also answer with Shift held (Caps Lock, Y for y).
const withShift = keys => keys.flatMap(key => /^[a-z]$/.test(key) ? [key, `S-${key}`] : [key]);
function bindInput(field, screen) {
  // blessed hands the terminal to $EDITOR on e (field focused but not reading), Ctrl-E and a
  // right-click. ELU never does: those start typing in place instead.
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
export async function launchTerminal({ repo, startDirectory = process.cwd(), input = process.stdin, output = process.stdout, refreshMs = 350, onRender, startConductor = launchConductor, peer, team: teamStart = false, askProject = false, clipboard = null, loginItem = { install: installScheduler, uninstall: uninstallScheduler }, usage = {}, updateCheck = updateNotice } = {}) {
  if (!input.isTTY || !output.isTTY) throw new Error('Open ELU in a terminal, or use --json for a snapshot.');
  // A terminal that only prints lines (TERM=dumb: an editor's output pane, a plain log) cannot draw the app.
  if (process.env.TERM === 'dumb') throw new Error('ELU cannot draw in this terminal: it is set to TERM=dumb.\nOpen ELU in a terminal window. If this is one, run:\n  TERM=xterm-256color elu');
  const facade = peer === undefined ? await loadPeer() : peer;
  const colour = process.env.NO_COLOR === undefined;
  const shade = name => colour ? PALETTE[name] : 'default';
  const accent = shade('orange'), muted = shade('muted');
  const screen = blessed.screen({ input, output, terminal: process.env.TERM || 'xterm', smartCSR: true, fullUnicode: true, title: 'ELU', warnings: false, autoPadding: false, dockBorders: false, ignoreLocked: ['C-c', 'tab', 'S-tab'] });
  // Every pane shows a row that fits it as one row: the chat, the lists, the dialogs, the message box.
  keepRows(screen);
  blessed.box({ parent: screen, top: 0, left: 0, width: '100%', height: '100%', style: { bg: shade('background') } });
  const box = options => blessed.box({ parent: screen, border: 'line', tags: false, style: { fg: shade('text'), bg: shade('panel'), border: { fg: shade('border') }, label: { fg: muted, bold: true } }, ...options });
  // Lists highlight their selected row in full only while focused; the row keeps its own colours.
  const selection = { fg: shade('text'), bg: shade('highlight'), inverse: !colour, bold: true, underline: false };
  const QUIET = { fg: shade('text'), bg: shade('raised'), inverse: false, bold: false, underline: !colour };
  // A step of the wheel selects a row, and the list's select item handler draws the app, once a frame (scheduleDraw).
  const pane = (parent, options = {}) => steadyWheel(blessed.list({ parent, top: 1, left: 1, width: '100%-2', height: '100%-2', keys: true, mouse: true, vi: false, tags: true, invertSelected: false, style: { fg: shade('text'), bg: shade('panel'), selected: { ...selection } }, scrollbar: { ch: '┃', style: { fg: shade('dim') } }, ...options }), null, { render: () => {} });
  const button = (top, content) => blessed.button({ parent: screen, top, height: 1, mouse: true, keys: true, tags: false, content, style: { fg: muted, bg: shade('raised') } });
  // Row 0: the brand (the open project's name, else ELU), the six tabs, and live status.
  blessed.box({ parent: screen, top: 0, left: 0, width: '100%', height: 1, style: { bg: shade('raised') } });
  const BRAND = ' ◆ ELU ';
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
  // Kanban: the open project's tasks and sessions in four columns, one board for each repository.
  const kanbanBoxes = COLUMNS.map(([, name]) => box({ label: ` ${name} `, hidden: true }));
  const kanbanLists = kanbanBoxes.map(parent => pane(parent));
  const kanbanOff = box({ hidden: true, label: ' Kanban ', padding: { left: 1 } });
  // Teammates' sessions and Tasks are cards on the four columns. Under them, one line says
  // when teammates see none of this board, and why.
  const kanbanTeam = box({ hidden: true, label: ' Team board ', padding: { left: 1 } });
  let teamTasks = { at: 0, root: null, people: [], sessions: { repos: [], people: [] }, off: false };
  // The open project's boards (one for each repository), the one picked in the header, and what the last frame showed.
  let kanbanBoards = [], kanbanPicked = null, kanbanName = '', kanbanShownNow = null;
  const newCard = button(1, ' + New task ');
  // A project that works in several repositories has a board for each: this picks one.
  const kanbanPick = button(1, ' Board ▾ ');
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
  // What the line says reads whole, on however many rows it is drawn.
  status.getContent = () => status._parseTags(status.said ?? '');
  // The message box wraps over four lines. Enter sends; newlines inside a paste are kept.
  // ignoreKeys: blessed's own Up and Down scroll the view a line before the cursor moves, so it
  // went past what the cursor needs. lib/editor.mjs scrolls the view to the cursor alone.
  const ask = blessed.textarea({ parent: screen, border: 'line', label: ' Message ', inputOnFocus: false, keys: true, ignoreKeys: true, mouse: true, tags: false, padding: { left: 1, right: 1 }, style: { fg: shade('text'), bg: shade('raised'), border: { fg: accent }, label: { fg: accent, bold: true } } });
  // Its label names the session's bots, each in its own colour, so the label alone reads tags.
  ask._label.parseTags = true;
  bindInput(ask, screen); editable(ask);
  ask.submit = function() { return this.__listener?.('\r', { name: 'enter' }); };
  // One row, never wrapped: a coloured line exactly as wide as the bar would lose its last word to a second row.
  const keysBar = blessed.text({ parent: screen, height: 1, tags: true, wrap: false, style: { fg: muted, bg: shade('background') } });
  const palette = blessed.list({ parent: screen, hidden: true, border: 'line', label: ' Commands: arrows / Tab / Enter ', tags: false, keys: false, mouse: true, style: { fg: shade('text'), bg: shade('raised'), border: { fg: accent }, selected: { fg: shade('background'), bg: accent, inverse: !colour, bold: true } }, scrollbar: { ch: '┃' } });
  // The wheel moves the chat one line and the command list one row (lib/wheel.mjs), as it does every list.
  steadyWheel(activity); steadyWheel(palette);
  const sizeNotice = box({ top: 0, left: 0, width: '100%', height: '100%', hidden: true, content: 'ELU\nResize to at least 80 columns by 24 rows.\nCtrl-C quits.' });
  // This window, to the projects it holds (claimView): what it holds is its own, never another window's.
  const thisWindow = {};
  let claim = { readOnly: true, release() {} }; let controller; let snapshot; let modal = null; let closing = false; let selectedId = null; let selectedRequest = null; let message = ''; let busy = false; let usageEnabled = false; let kanbanData = COLUMNS.map(([column, name]) => ({ column, name, items: [] })), returnTo = 'tasks'; let paletteDismissed = null; let paletteValues = []; let paletteText = null; let composeWhen = null; let following = null; let drawing = false;
  let view = teamStart ? 'chats' : 'tasks';
  // Sessions: the row the cursor is on (NEW is + New session), the row the right side was
  // last shown for, and the open session's own row as of the last draw.
  const NEW = 'new'; let barKey = NEW, barAt = 0, openKey = null, ownSeen = null, wanted = null, opening = false, dash = null, sided = null;
  // What was typed on the cursor's row while its project was still opening: each key with where
  // it was pressed. It is dropped when the cursor leaves that row.
  const heldKeys = [];
  let shellRun = null, shellTyped = false, chatTarget = null, chatOpen = null, chatJump = null, heldEdit = null, boardLines = [], composeRows = [], teamRows = [[], []], projectRows = [], botRows = [], botJump = null, teamOn = false, peerData = { on: false }, lastPane = { chats: null, kanban: null };
  // The Usage tab: its lines (each names its vendor, and an account's its account), the data behind them, whether a check is running.
  let usageRows = [], usageData = null, usageKey = null, usageBusy = false; const usageAbort = new AbortController(), usageChecks = new Map();
  // Top agents: today (1) or the last seven days (7); t switches.
  let usagePeriod = 1;
  // The new session's permissions: mode, where it works, extra folders. Approvals are the lead's live requests.
  let composeMode = null, composePlace = { kind: 'worktree' }, composeFolders = [], approvals = [];
  // The approvals the terminal bell already rang for (ringFor).
  const rung = new Set();
  // composePicked: the owner chose this form's mode himself (/permissions <mode> or the picker),
  // so a new default leaves it. A request sent from such a form carries picked: true.
  // composeFullOk: he said yes to FULL_SCHEDULE for this form's Full access, so saving the
  // schedule does not ask him again.
  let composePicked = false, composeFullOk = false;
  // The bots a new session starts with (/bots add in the form), and the saved bots, read at
  // most once a second: the key bar and the @ list ask on every draw.
  let composeBots = [], botCache = { at: 0, rows: [] };
  // Archived sessions are left out of the list until /archived, or a click on the line that
  // counts them, asks for them.
  let showArchived = false;
  const toggleArchived = () => { showArchived = !showArchived; setMessage(showArchived ? 'Archived sessions are listed last. /archived hides them again.' : 'Archived sessions are hidden.'); };
  // The chat follows its newest line while its end is in view. Once the owner scrolls up it
  // stays on the lines he chose, through every redraw and whatever arrives below, until he
  // is back at the end or another chat opens. At the top it stays at the top. chatShown names
  // what the pane last drew: a session here, or in Sessions the row beside the list (a session
  // on another computer, a teammate's question, an approval), so each keeps its own place.
  let chatShown = null;
  const scrolledUp = pane => { const at = pane.getScrollPerc(true); return at >= 0 && at < 100; };
  // A window made smaller or larger wraps the chat again before it is drawn, so how far down
  // it reads says nothing then: where the pane was is taken before (resize). One at its end
  // stays at its end; one the owner scrolled up stays on the lines he put it on. Until the
  // next draw that ends: { end } or { place }.
  let sized = null;
  // What the model or a bot did in a turn (lib/run-activity.mjs): while the turn runs, every
  // step under its working line; once it ended, one line above its reply that opens to them.
  // Ctrl-O opens or folds every turn's; a click on a turn's line opens or folds that one
  // (flipped). stepKeys: the turns whose lines the chat shows, top to bottom.
  let stepsOpen = false, stepKeys = [];
  const stepsFlipped = new Set();
  // A session's runs that have steps to show: the model's and its bots', from the session's
  // own folder, a standup's answer turn left out as the chat leaves it out. A turn the owner
  // stopped is among them (task.stops, lib/runner.mjs). Each ended: a call it left running
  // was cut when it did.
  function stepRuns(repo, task) {
    const dir = taskDir(repo, task.id), time = run => Date.parse(run.at ?? '') || 0;
    return [...(task.runs ?? []), ...(task.stops ?? []).map(run => ({ ...run, stopped: true }))].filter(run => typeof run.logFile === 'string' && path.dirname(run.logFile) === dir && !run.standup && (run.role === 'lead' || botOfKey(run.role)))
      .sort((a, b) => time(a) - time(b))
      .map(run => ({ role: run.role, at: run.at, startedAt: run.startedAt ?? null, key: run.logFile, ...(run.stopped ? { stopped: true } : {}), steps: endedSteps(runSteps(run.logFile, { cwd: task.worktree }), Date.parse(run.at ?? '')) }));
  }
  // Whether a turn's steps are open; the chat (or a session on another computer) names each
  // turn it shows a line for, in order, here.
  const stepsShown = key => { stepKeys.push(key); return stepsOpen !== stepsFlipped.has(key); };
  // The one line a turn's runs fold into, and their steps under it when open.
  function foldedSteps(runs) {
    const count = runs.reduce((sum, run) => sum + run.steps.length, 0); if (!count) return null;
    const open = stepsShown(runs[0].key);
    return [stepsLine(count, runSeconds(runs), open, colour, { stopped: runs.some(run => run.stopped) }), ...(open ? [stepLines(runs.flatMap(run => run.steps), { width: chatWidth() - 1, colour })] : [])].join('\n');
  }
  function toggleSteps(key = null) {
    if (key === null) { stepsOpen = !stepsOpen; stepsFlipped.clear(); }
    else if (stepsFlipped.has(key)) stepsFlipped.delete(key); else stepsFlipped.add(key);
    draw();
  }
  // A session on another computer is drawn in parts (remoteApp.parts), and parts above the
  // lines he reads change: its oldest entries leave the top once it keeps no more, and an entry
  // that arrives lands above its question, its steps and what he sent last. Held, the pane
  // keeps the part at its top and his line in it; when that part is gone, the next one still
  // there, from its first line. partsShown: the parts the pane drew last.
  let partsShown = null, olderOf = null;
  const partLines = part => part.text.replace(/\r\n|\r/g, '\n').split('\n').length + 1;
  const partAt = (pane, parts) => {
    const lines = pane._clines, top = lines?.rtof?.[pane.childBase];
    if (!parts || top === undefined || pane.content !== parts.map(part => part.text).join('\n\n')) return null;
    for (let index = 0, start = 0; index < parts.length; start += partLines(parts[index]), index++) {
      if (top < start + partLines(parts[index])) return { parts, index, line: top - start, wrapped: pane.childBase - lines.ftor[top][0] };
    }
    return null;
  };
  const keepPart = (pane, place, parts) => {
    const keys = parts.map(part => part.key), still = place.parts.slice(place.index).findIndex(part => keys.includes(part.key));
    if (still < 0) return;
    const index = keys.indexOf(place.parts[place.index + still].key), same = still === 0, ftor = pane._clines?.ftor;
    if (!ftor?.length) return;
    let start = 0; for (let at = 0; at < index; at++) start += partLines(parts[at]);
    const fake = Math.min(ftor.length - 1, start + (same ? Math.min(place.line, partLines(parts[index]) - 1) : 0)), real = ftor[fake];
    const line = real[same && fake - start === place.line ? Math.min(place.wrapped, real.length - 1) : 0];
    pane.childBase = Math.max(0, Math.min(line, pane.getScrollHeight() - (pane.height - pane.iheight)));
  };
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
  // One a teammate's message started that he works on as his own counts as his; a teammate's question never.
  const TO_MODEL = /^@model(?=\s|$)/i;
  function addressedBot(task, rows) {
    if (!task || isPeerRun(task.origin)) return null;
    const waits = rows.filter(row => row.continuationTaskId === task.id && ['queued', 'starting'].includes(row.state) && !row.scheduled && !row.origin && !row.standupFor)
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
  // The chat is drawn on every tick. Its parts are given to the pane only when one of them
  // changed: setting the text again makes blessed wrap and colour every line of it again,
  // which with a long message open was the app's whole load while nothing happened.
  let chatParts = null, chatText = null;
  const setChat = parts => {
    if (chatParts && activity.content === chatText && parts.length === chatParts.length && parts.every((part, index) => part === chatParts[index])) return;
    chatParts = parts; chatText = parts.join('\n\n'); activity.setContent(chatText);
  };
  // blessed also works out the colour of every line again each time the pane is drawn. That is
  // done once for each text the pane holds and each style it is drawn in.
  const lineColours = activity._parseAttr; let colouredLines = null, colouredFrom = null;
  activity._parseAttr = function(lines) {
    const from = this.sattr(this.style);
    if (lines === colouredLines && from === colouredFrom) return undefined;
    colouredLines = lines; colouredFrom = from; return lineColours.call(this, lines);
  };
  // Drag selects and copies on release; a click in the message box moves its cursor.
  // Tests pass their own clipboard; without one a test copies nothing.
  const copyText = clipboard ?? (process.env.NODE_TEST_CONTEXT ? null : systemClipboard({ write: data => screen.program._write(data) }));
  const copied = text => setMessage(`Copied ${text.length.toLocaleString('en-US')} character${text.length === 1 ? '' : 's'}.`);
  // The bar drawn at the left of a message is not part of its text, so a copy leaves it out.
  const mouseSelection = attachSelection(screen, { copy: copyText, onCopy: copied, clean: row => row.replace(/^\s*┃ ?/, '') });
  ask.selection = () => { const range = mouseSelection.range(); return range?.el === ask ? range : null; };
  // Shift and the arrows highlight in the box (lib/editor.mjs): the same highlight a drag makes.
  ask.highlight = (from, to, by) => { if (from) mouseSelection.select(ask, from, to, by); else mouseSelection.clear(); };
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
  async function decideTask(root, task, accept) {
    if (['running', 'preparing'].includes(task.state)) throw new Error('This session is working. Answer its Task when it stops.');
    const repo = projectFolder(root);
    if (!accept) { rejectTask(repo, task.id); setMessage('Task rejected. Nothing was changed.'); return; }
    if (!await homeOk(root, task.id)) return;
    const plan = approveTask(repo, task.id);
    enqueue(root, `Approved the Task: ${plan.title}`, { continuationTaskId: task.id, priority: 0, approved: true }); conduct();
    // Said so that it stays true once the turn has ended: the line stays up until a key clears it.
    setMessage('Task approved.');
  }
  // A teammate's session that works in the home folder asks once before the owner's message,
  // approval or retry goes to it (HOME_QUESTION in lib/util.mjs); y keeps the answer on the
  // session, so it never asks again, and the message goes at once. n sends nothing.
  async function homeOk(root, id) {
    if (!root || id == null || id === '') return true;
    let repo, task; try { repo = projectFolder(root); task = readTask(repo, String(id)); } catch { return true; }
    if (!task.origin?.peer || task.homeAllowed === true || !homeWork(task, repo.root)) return true;
    if (!await yes('Home folder', HOME_QUESTION, 'y yes · n no')) { setMessage('Nothing was sent. It waits for your y.'); return false; }
    allowHome(repo, task.id); return true;
  }
  // The same before a teammate's message starts a session in the home folder: true to send it
  // with the owner's y, false when he said n, null when it does not run there.
  async function homeStart(runsAt) {
    if (!runsAt || !homeOrAbove(runsAt)) return null;
    if (!await yes('Home folder', HOME_QUESTION, 'y yes · n no')) { setMessage('It waits for you.'); return false; }
    return true;
  }
  // Bots that have a schedule run by themselves in the sessions they are in. The login item
  // is asked for when one is first on, so they also run while ELU is closed.
  const tickBots = () => runBotSchedules(new Date(), { start: conduct, install: loginItem.install });
  // One rule: the login item is there exactly while a schedule is on, a task's or a bot's.
  // Called after anything that turns one on or off. changed: only when that answer moved.
  // Returns what the installer said, so a schedule that runs only while ELU is open says so.
  let loginItemOn = null;
  function keepLoginItem({ changed = false } = {}) {
    const on = schedulesOn();
    if (changed && on === loginItemOn) return null;
    loginItemOn = on;
    // wanted: asked again as the login item is removed, so one another window just asked for stays.
    try { return on ? loginItem.install() : loginItem.uninstall({ wanted: schedulesOn }); }
    // Not done, so not remembered: the 30-second check asks again.
    catch (error) { loginItemOn = null; return on ? { installed: false, reason: `It runs only while ELU is open: ${error.message}` } : null; }
  }
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
    // An opened request stays open as its session.
    if (row?.taskId) { const was = ownKey(); selectedId = row.taskId; selectedRequest = null; if (entered && entered === was) entered = ownKey(); }
    return row;
  }
  // Follows a sent message until the conductor starts it, then shows its chat.
  function follow() {
    if (!following || !controller || controller.repo.root !== following.root) { following = null; return; }
    let row; try { row = pendingRequests(following.root).find(value => value.id === following.id); } catch { return; }
    // A message the running turn took (lib/runner.mjs inboxFeed) is done while that turn still
    // works, and its row is cleared two minutes later: the line then follows the session it
    // went to until that turn ends, so it never stops at the word running.
    // One answered beside a turn that takes no message (lib/message-aside.mjs) says so once, as the chat does.
    if (row?.aside?.state === 'answered' && !following.aside && ['queued', 'done'].includes(row.state)) { following.aside = true; message = plain(asideStatus(row.state === 'done' ? 'question' : 'work')); }
    if (row?.state === 'done' && row.taskId) following.taskId = row.taskId;
    if (!row && !following.taskId) { following = null; return; }
    if (row?.taskId && selectedRequest?.id === row.id) { const was = ownKey(); selectedId = row.taskId; selectedRequest = null; if (entered && entered === was) entered = ownKey(); }
    if (!row || row.state === 'done') {
      const task = controller.snapshot().tasks.find(value => value.id === following.taskId);
      if (task && ['running', 'preparing'].includes(task.state)) return;
      const asked = following.bot; following = null;
      const reply = asked ? (task?.messages ?? []).findLast(value => value.bot === asked) : null;
      if (task && view === 'chat') message = plain(reply ? reply.failed ? `@${asked}: ${reply.text}` : `@${asked} answered` : task.state === 'answered' ? `${modelOf(task)} answered` : task.state === 'ready' ? `ready | ${publishWords(task)}` : task.state === 'needs_input' && !task.error ? 'Waiting for your answer' : stopLine(task)?.text ?? task.error?.message ?? stateWord(task));
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
  function pointBar(key) { if (key && key !== barKey) { barKey = key; wanted = null; message = ''; entered = null; heldKeys.length = 0; if (ask.getValue()) typedFor = answerTarget(); } }
  // What a lone y or n in the message box answers: the row under the cursor, or the session open
  // without the list. typedFor: that target when the text was begun or the cursor last moved by hand.
  const answerTarget = () => listed() ? `list\0${barKey}` : `open\0${controller?.repo.root ?? ''}\0${selectedId ?? ''}`;
  let typedFor = null;
  // The session beside the list that Enter or a click opened, or that a message was sent in,
  // as ownKey() names it: in its chat a lone y or n is a reply. A session the cursor only
  // rests on is a row of the list, where y and n are keys. null when none is.
  let entered = null;
  const enteredHere = () => Boolean(entered) && entered === ownKey();
  // A new session starts with the default mode, a new worktree, the project's model, its first bots, and no schedule or extra folders.
  function resetForm() { composeWhen = null; composeMode = defaultMode(); composePicked = false; composeFullOk = false; composePlace = { kind: 'worktree' }; composeFolders = []; composeBots = firstBots(); composeModel = null; }
  // A form whose mode the owner did not pick follows the default as it is now, changed here or
  // in another window, so a session he has not sent never starts with the default it was opened
  // with. A schedule gets Approve for me at most unless its mode was picked, and Here only goes
  // with Full access. true when the mode changed.
  function followDefault() {
    if (composePicked) return false;
    const mode = composeWhen ? capMode(defaultMode(), 'auto') : defaultMode();
    if (composeMode === mode) return false;
    composeMode = mode; if (composePlace.kind === 'here' && mode !== 'full') composePlace = { kind: 'worktree' };
    belowFull(mode);
    return true;
  }
  // A folder only Full access takes leaves the form with Full access, as it leaves a session.
  function belowFull(mode) { if (mode !== 'full') composeFolders = foldersBelowFull(composeFolders); }
  const formMode = () => { followDefault(); return composeMode; };
  // A saved request of mine for a new session, a schedule's run too, goes again with no more
  // access than the default now, unless its mode was picked for it. The fields to change, or
  // null when it may go as it is.
  function underDefault(row) {
    if (!MODES.includes(row?.permissions) || row.origin || row.mine || row.continuationTaskId || row.picked === true) return null;
    const permissions = capMode(row.permissions, defaultMode());
    if (permissions === row.permissions) return null;
    return { permissions, ...(row.place?.kind === 'here' && permissions !== 'full' ? { place: { kind: 'worktree' } } : {}) };
  }
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
    returnTo = 'tasks'; entered = null;
    if (line.add && controller) showForm(false);
    else if (session && controller) { rememberDraft(); showSession(session); }
    else { rememberDraft(); if (view === 'chat') ask.setValue(drafts.get(fresh) ?? ''); view = 'tasks'; selectedRequest = null; following = null; }
  }
  // The bots on a schedule in each listed session, by project root then session, read again
  // every two seconds: the list and the open session's title line show them. A session
  // opened from the Kanban tab has no list behind it: its own project is read then.
  let timedAt = 0, timedShown = {};
  // Where a project's records are is asked of Git once, and again when its .git comes or goes:
  // asked on every read, it started Git every two seconds for each project while nothing happened.
  const timedFolders = new Map();
  const timedFolder = root => {
    const git = fs.existsSync(path.join(root, '.git')), kept = timedFolders.get(root);
    if (kept?.git === git) return kept.repo;
    const repo = projectFolder(root); timedFolders.set(root, { git, repo }); return repo;
  };
  function timedSessions(now = Date.now()) {
    if (now - timedAt < 2000) return timedShown;
    timedAt = now; timedShown = {};
    for (const project of dash?.projects ?? (snapshot?.tasks ? [snapshot] : [])) {
      if (project.unavailable || !project.tasks?.length) continue;
      try { const shown = botSchedulesShown(timedFolder(project.root), project.tasks, new Date(now)); if (Object.keys(shown).length) timedShown[project.root] = shown; } catch { /* A project that cannot be read shows no schedule. */ }
    }
    return timedShown;
  }
  // Builds the list, keeps the cursor on its row while rows move between groups, and shows
  // that row on the right. A new message elsewhere never moves either of them.
  function syncSessions(now) {
    // Peer threads that wait for nothing live in Chats; asks, replies and drafts for you stay here.
    const rows = boardRows(dash.projects, now, { items: peerData.items, online: onlineKeys(peerData.status), recent: WEEK, schedules: listSchedules(), approvals, archived: showArchived, timed: timedSessions(now), remote: remoteApp.rows(now), called: peerName }).filter(row => row.kind !== 'peer' || peerDecision(row));
    const before = boardLines.findIndex(line => lineKey(line) === barKey), at = before < 0 ? barAt : before;
    // After this machine's own: every session of each computer of mine in this project's repository, under its name.
    boardLines = [{ add: true }, { spacer: true }, ...(rows.length ? boardSections(rows) : [{ note: dash.projects.length ? 'No sessions yet.' : 'No project yet.' }]), ...remoteApp.sections(now, controller?.repo.root, { archived: showArchived })];
    // The archive is out of the way, and one line says it is there.
    // Those my other computers archived count too: /archived lists them under each computer.
    const stored = dash.projects.reduce((count, project) => count + (project.closed?.length ?? 0), 0) + remoteApp.archivedCount(now, controller?.repo.root);
    // It sits on the last row of the pane; in a list longer than the pane it is the last line.
    if (stored) boardLines.push(...Array.from({ length: Math.max(1, (typeof board.height === 'number' ? board.height : 0) - boardLines.length - 1) }, () => ({ spacer: true })), { note: showArchived ? 'Hide archived · /archived' : `${stored} archived · /archived`, archive: true });
    const find = key => boardLines.findIndex(line => lineKey(line) === key), has = key => find(key) >= 0;
    const after = boardLines.findIndex((line, place) => place >= at && lineKey(line)), near = after >= 0 ? after : boardLines.findLastIndex(lineKey);
    // The right side changed by itself (a sent message became a session, /new opened the form): the cursor follows it.
    // A message sent from the form used its settings up, and so did leaving the tab.
    const own = ownKey();
    if (own !== ownSeen) { if (ownSeen === NEW) resetForm(); if (entered && entered === ownSeen) entered = own; ownSeen = own; wanted = own; }
    if (wanted && has(wanted)) { barKey = openKey = wanted; wanted = null; }
    // The cursor's row left the list: the open session's own row takes it, else the nearest row.
    // A session of my other computer that waited under Needs you and was answered stays under
    // the cursor, on its row under that computer, so what it does next shows where I answered.
    if (!has(barKey)) {
      const same = typeof barKey === 'string' && barKey.startsWith('remote:') && barKey.endsWith('/wants') ? barKey.slice(0, -'/wants'.length) : null;
      if (same && has(same)) barKey = openKey = same;
      else if (own && has(own)) barKey = openKey = own;
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
          catch (error) { heldKeys.length = 0; throw error; }
          finally {
            opening = false; openKey = key; ownSeen = ownKey(); resize();
            // What was typed on the cursor's row meanwhile goes to it once that row is open.
            if (!opening) for (const [from, ch, pressed] of heldKeys.splice(0)) if ([from, ask].includes(screen.focused)) typeFrom(from, ch, pressed);
          }
        });
      } else { try { showLine(line, session); } finally { openKey = key; ownSeen = ownKey(); } }
    }
    // While a sent message waits for its session's row, the cursor rests on the nearest row.
    barAt = has(barKey) ? find(barKey) : near;
  }
  function activateProject(location) {
    const nextClaim = claimView(location, { window: thisWindow }); let nextController, nextSnapshot;
    try { nextController = new ProjectController(location, { readOnly: nextClaim.readOnly, onRepository: value => { repo = value; nextClaim.attach(value); }, takeOver: () => takeProject(nextClaim), readOnlyText: () => viewOnlyLine(nextClaim.holder) }); nextSnapshot = nextController.snapshot(); }
    catch (error) { nextClaim.release(); throw error; }
    repo = location; claim = nextClaim; controller = nextController; snapshot = nextSnapshot; forgetVendors();
    selectedId = null; selectedRequest = null; message = claim.readOnly ? VIEW_ONLY : ''; takeoverAt = null;
    usageEnabled = false;
    if (!claim.readOnly) writer();
  }
  // What a window that may change its project does once it has it: the project is listed,
  // usage is read, and files that came with the folder are asked about.
  function writer() {
    registerProject(repo);
    usageEnabled = snapshot.initialized;
    if (usageEnabled) controller.refreshUsage().then(draw);
    const root = controller.repo.root; setImmediate(() => catchAction(() => reviewProjectFiles(root)));
  }
  // A window that opened view-only, because another window had its project, takes the project
  // over once no other window has it: that window quit, ended with its terminal or its
  // connection, or let go when /takeover here asked it to. It tries every second, and at once
  // before anything that changes the project (ProjectController.writable). true when it has
  // the project now. sure: false on the timer, which starts no process while nothing changed.
  let triedAt = 0, viewLooked = 0, takeoverAt = null;
  function takeProject(asked = claim, now = Date.now(), sure = true) {
    if (asked !== claim || !controller || closing) return false;
    if (!claim.readOnly) return true;
    triedAt = now;
    if (!claim.retry?.({ sure, now })) return false;
    controller.readOnly = false; takeoverAt = null; writer();
    // A window that let go when asked is still open; any other has closed.
    setMessage(claim.holderOpen ? 'This window can make changes now.' : 'The other ELU window has closed. This window can make changes now.');
    return true;
  }
  // The window that has this project, and what to do, for a window that cannot change it: the
  // longest form the status row shows whole. The row has two lines beside the list and one
  // elsewhere, and a line broken at a word can end up to ten columns early. The row is drawn
  // again at another size or in another tab: refused keeps what to choose from.
  let refused = null;
  const TYPED_BACK = ' ↑ brings back what you typed.';
  function viewOnlyLine(holder) {
    const known = [holder?.pid ? `process ${holder.pid}` : '', holder?.startedAt ? `started ${messageTime(holder.startedAt)}` : '', holder?.terminal ? `in terminal ${holder.terminal}` : ''].filter(Boolean);
    const forms = [known.length ? `${VIEW_ONLY} That window is ${known.join(', ')}.` : '', holder?.terminal ? `View only: the ELU window in ${holder.terminal} has it. Close it, or /takeover here.` : '', VIEW_ONLY].filter(Boolean);
    refused = { forms, text: fitForm(forms) }; return refused.text;
  }
  const fitForm = forms => { const room = listed() ? status.width * 2 - 14 : status.width - 2; return forms.find(form => widthOf(form) <= room) ?? forms.at(-1); };
  // The message box of a view-only window says which window has the project, its terminal when
  // it has one, and what to do: the longest form that fits in max.
  function viewOnlyLabel(max) {
    const has = 'View only: another ELU window has it', where = claim.holder?.terminal ? `, in terminal ${claim.holder.terminal}` : '', what = ' · close it, or /takeover';
    const forms = [` ${has}${where}${what} `, ` ${has}${what} `, ' View only: another window has it · /takeover ', ` ${has} `];
    return forms.find(form => widthOf(form) <= max) ?? forms.at(-1);
  }
  // On the redraw timer. A view-only window looks once a second whether it can take its
  // project, and says so when the window it asked with /takeover has not let go in ten
  // seconds. The window that has the project looks every two seconds whether another asked
  // for it: it lets go, turns view-only and says so, and leaves the asker time to take it.
  function viewTick(now = Date.now()) {
    if (!controller || closing) return;
    try {
      if (claim.readOnly) {
        if (now - triedAt < 1000) return;
        if (!takeProject(claim, now, false) && takeoverAt && now - takeoverAt > 10000) { takeoverAt = null; setMessage('The other ELU window did not let go. Close it to make changes here.'); }
      } else if (now - viewLooked >= 2000) {
        viewLooked = now;
        if (claim.wanted?.()) { claim.giveUp(); controller.readOnly = true; usageEnabled = false; triedAt = now + 1000; setMessage('View only: another ELU window took this project. /takeover takes it back.'); }
      }
    } catch { /* Looked at again on the next tick. */ }
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
  // Rows the status takes beyond its one: the panes above it end that much higher.
  let lifted = 0;
  function resize() {
    sized ??= scrolledUp(activity) ? { place: partAt(activity, partsShown) } : { end: true };
    const g = geometry(screen.width, screen.height), W = g.width, top = g.top, bottom = g.statusTop - lifted, height = bottom - top;
    layoutSession(g);
    layoutChats(g);
    const third = Math.floor(W / 4);
    kanbanBoxes.forEach((frame, index) => Object.assign(frame, { top, left: index * third, width: index === 3 ? W - 3 * third : third, height }));
    Object.assign(kanbanOff, { top, left: 0, width: W, height: 3 });
    Object.assign(botsBox, { top, left: 0, width: W, height });
    Object.assign(projectsBox, { top, left: 0, width: W, height });
    Object.assign(usageBox, { top, left: 0, width: W, height });
    // As wide as its hints may be (W - 2). It never wraps (wrap: false above): a coloured line as
    // wide as its box would lose its last word to a second row.
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
    const W = g.width, top = g.top, height = g.statusTop - lifted - top, side = W >= 100, mates = side ? barWidth(W) : 0;
    const stacked = Math.max(4, Math.min(Math.floor(height / 2), teamRows[0].length + 2));
    Object.assign(teamBoxes[0], side ? { top, left: 0, width: mates, height } : { top, left: 0, width: W, height: stacked });
    Object.assign(teamBoxes[1], side ? { top, left: mates, width: W - mates, height } : { top: top + stacked, left: 0, width: W, height: height - stacked });
    Object.assign(teamOff, { top, left: 0, width: W, height: 3 });
  }
  // Everything the timer can change on screen. Other changes render through their own draw.
  // A panel's text stands in the frame as a number that changes when the text does, so the
  // text of a long chat is not copied on every tick to learn that nothing changed.
  let lastFrame = null, statusPlaced = ''; const stamps = new WeakMap();
  const stamp = panel => { let kept = stamps.get(panel); if (!kept || kept.text !== panel.content) stamps.set(panel, kept = { text: panel.content, mark: (kept?.mark ?? 0) + 1 }); return kept.mark; };
  const watched = () => [header, brand, pills, status, keysBar, ...tabs, newCard, kanbanPick, newBot, newProject, back, activity, changesBox, sessionTabs, boardBox, compose, composeHint, ask, teamOff, ...teamBoxes, chatMembers, kanbanOff, ...kanbanBoxes, kanbanTeam, botsBox, projectsBox, usageBox];
  const frame = () => [screen.width, screen.height, screen.focused?.uid, ...watched().map(panel => `${stamp(panel)}\x01${panel._label?.content ?? ''}\x01${panel.style.fg}\x01${panel.style.bg}\x01${panel.style.bold}\x01${panel.style.underline}\x01${panel.style.inverse}\x01${panel.style.border?.fg}\x01${panel.hidden}\x01${panel.position.left}\x01${panel.position.top}\x01${panel.position.width}\x01${panel.position.height}`), ...[board, composeList, ...teamLists, ...kanbanLists, botsList, projectsList, usageList].map(list => `${list.ritems?.join('\n')}\x01${list.selected}\x01${list.style.selected.bg}\x01${list.style.selected.inverse}`), palette.hidden, palette.ritems?.join('\n'), palette.selected, activity.childBase, modal?.uid].join('\x00');
  // Peer files are read at most once per draw, and only by the views that show them.
  // Whether this machine is on a team, read from the rosters at most every 2 s; /invite and
  // /join read it again at once (peerOnAt = 0).
  let peerOnValue = false, peerOnAt = 0;
  const peerOn = () => {
    if (Date.now() - peerOnAt < 2000) return peerOnValue;
    peerOnAt = Date.now(); try { peerOnValue = Boolean(facade) && facade.onTeam?.() === true; } catch { peerOnValue = false; }
    return peerOnValue;
  };
  // The peer status is asked for many times in one draw (each row of another computer names
  // its machine): its files are read once for all of them. The next draw reads them again.
  let drawDepth = 0, statusRead = null;
  const peerRead = (name, ...args) => {
    const status = drawDepth > 0 && name === 'peerStatus' && !args.length;
    if (status && statusRead) return statusRead.value;
    let found = null; try { const value = facade?.[name]?.(...args); found = value && typeof value === 'object' ? value : null; } catch { found = null; }
    if (status) statusRead = { value: found };
    return found;
  };
  const peerList = (name, ...args) => { const value = peerRead(name, ...args); return Array.isArray(value) ? value : []; };
  // Sessions on my other computers (lib/terminal-remote.mjs), and the one under the cursor in Sessions.
  const remoteApp = remoteSessions({ facade, peerRead, peerCommand: (command, options) => peerCommand(command, options), chatMessage, ink, colour, toneOfBot: name => toneOfBot(name), stepsShown });
  const remoteHere = () => view === 'tasks' && listed() && boardLines[barAt]?.row?.kind === 'remote' ? boardLines[barAt].row : null;
  // Every @name the app shows for a peer. Another computer of mine goes by one name wherever
  // it is named, the one Sessions and /mine call it (its box name, else its name on the team);
  // a teammate keeps the name they gave themselves.
  const peerName = (name, key) => { const mine = typeof key === 'string' ? remoteApp.yours().get(key) : null; return mine ? `@${mine.name}` : memberName(name, key); };
  // Who wrote a waiting request: you, or the teammate (or the computer of mine) whose message it is.
  const requester = row => row.origin ? peerName(row.origin.name, row.origin.peer) : 'You';
  // Who a thread is with, by the same name.
  const threadWho = item => item?.team && !item.peer ? 'your team' : peerName(item?.name, item?.peer);
  // Your agent here for a session on another computer (lib/remote-helper.mjs): its chat, read
  // where it runs, for that session's pane, whether it works now, and the approvals it waits on.
  // null before the first message.
  const helperRepo = root => controller?.repo.root === root ? controller.repo : projectFolder(root);
  function helperPane(row) {
    const link = helperLink(row.remote.machine, row.id);
    if (!link) return null;
    try {
      const repo = helperRepo(link.root), queue = pendingRequests(link.root), id = helperTask(link, { requests: queue, sessions: () => savedTasks(repo) });
      const task = id ? readTask(repo, id) : null, entries = task ? conversationEntries(repo, task) : [];
      const waiting = queue.filter(request => ['queued', 'starting'].includes(request.state) && (id ? String(request.continuationTaskId) === id : request.id === link.requestId)).map(request => ({ role: 'You', at: request.createdAt, text: requestGoal(request), waiting: true }));
      const model = entries.findLast(entry => entry.lead)?.role ?? (task && controller?.repo.root === link.root ? modelOf(task) : 'Your agent');
      const approvals = id ? pendingApprovals({ root: link.project, taskId: id }) : [];
      return { model, title: task ? taskTitle(task) : helperTitle(link), entries: [...entries, ...waiting], working: waiting.length > 0 || ['running', 'preparing'].includes(task?.state), stopped: link.stopped, approvals, sends: id ? sendsTo(link.remoteId).filter(send => send.task === id) : [] };
    } catch { return null; }
  }
  // Trust is my setting about a teammate, read from the peer policy file.
  const peerTrusted = key => { try { return typeof key === 'string' && (facade?.peerPolicy ?? savedPeerPolicy)(key)?.trusted === true; } catch { return false; } };
  // What I set for a teammate: holdReplies and autoContinue, beside trusted (lib/peer/settings.mjs).
  const peerPolicyOf = key => { try { return (typeof key === 'string' ? (facade?.peerPolicy ?? savedPeerPolicy)(key) : null) ?? {}; } catch { return {}; } };
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
  // what its vendor asks in every mode, and that question is the vendor's to the owner.
  // Full access is everything, so nothing a switched turn asks is kept back for him: a
  // removal, an MCP tool and a long command are allowed with the rest. The never list is
  // not asked, so it is not allowed here either.
  const allowForFull = (task, rows, started) => {
    let count = 0;
    if (task?.permissions === 'full' && task.state === 'running' && ['ask', 'auto'].includes(started)) for (const row of rows) { if (!fullAllowed(task, row.role)) continue; try { if (answerApproval(row.id, 'allow')) count++; } catch { /* It stays for the owner to answer. */ } }
    return count;
  };
  // The Blocked lines of a session's last lead turn, at most three, each saying what was
  // refused, why and the one thing to do. Shown while the session waits for the owner, and
  // for a never-list command whatever the turn went on to do. An approval nobody answered is
  // said too once the turn has ended, whatever it ended on: it never passes in silence.
  // all: every line, not only the three shown.
  function blockedRows(task, lastLead = task?.runs?.findLast(run => run.role === 'lead'), { all = false } = {}) {
    const waits = task.state === 'needs_input', ended = !['running', 'preparing'].includes(task.state);
    const refused = Array.isArray(lastLead?.denials) ? lastLead.denials.filter(denial => ended || denial?.never) : [];
    if (!refused.length) return [];
    // The approvals of that turn: stamped with the id it was launched with, which a resumed
    // turn reports as another. A turn kept before that id was recorded finds them by the
    // tool call each one asked about.
    const ids = [lastLead.session, lastLead.launch].filter(Boolean), uses = refused.map(denial => denial?.tool_use_id).filter(use => typeof use === 'string' && use);
    const asked = (task.approvals ?? []).filter(row => row.role === 'lead' && (ids.includes(row.session) || (!lastLead.launch && typeof row.id === 'string' && uses.some(use => row.id.endsWith(`-${use}`)))));
    const rows = [...new Map(refused.map(denial => [denial, blockedLine(denial, lastLead, asked, { cwd: task.worktree ?? null, full: fullAllowed(task, 'lead'), current: task.permissions ?? null, waits })]).filter(([denial, row]) => waits || denial?.never || row.kind === 'timeout').map(([, row]) => [row.text, row])).values()];
    return all ? rows : rows.slice(0, 3);
  }
  // Giving a session a mode other than the one its last turn ran in, where that turn stopped
  // on something the new mode lifts, continues it at once. Returns those refusals, or null.
  // A turn that also stopped on the owner's own no, or on the never list, waits for him.
  function lifting(task, mode) {
    const lastLead = task.runs?.findLast(run => run.role === 'lead');
    if (task.state !== 'needs_input' || !lastLead || mode === ranIn(lastLead)) return null;
    const rows = blockedRows(task, lastLead, { all: true });
    if (rows.some(row => ['owner', 'never'].includes(row.kind))) return null;
    const lifted = rows.filter(row => liftedBy(row.kind, mode));
    return lifted.length ? lifted : null;
  }
  // The continuation names only what the new mode lifts.
  const CONTINUE = (mode, rows) => `Continue where you stopped: this session now has ${LABELS[mode]}. Try again only this: ${rows.slice(0, 5).map(row => row.what).join('; ')}. Do not retry anything the owner said no to or that is never allowed.`;
  // Sets a session's mode and returns what the status line says. With no turn in progress
  // the mode holds from the next message, unless the last turn stopped on something the new
  // mode lifts: then it continues at once. A turn in progress keeps the mode its vendor
  // started with; Full access alone reaches it, through its approvals.
  // location and root: the project of a session the list shows from another project.
  function setMode(given, mode, { location = null, root = controller.repo.root } = {}) {
    const task = location ? given : controller.snapshot().tasks.find(row => row.id === given.id) ?? given, running = task.state === 'running';
    const was = running ? turnMode(task) : null, now = was;
    const lifted = !running && !['preparing'].includes(task.state) ? lifting(task, mode) : null;
    if (location) saveMode(location, String(task.id), mode); else controller.setPermissions(task.id, mode);
    if (lifted) { enqueue(root, CONTINUE(mode, lifted), { continuationTaskId: String(task.id), priority: 0 }); conduct(); return `${LABELS[mode]}. Continuing where it stopped.`; }
    // A Task that waits needs no approval in a mode that approves Tasks (lib/plan.mjs): the mode
    // approves it, and its work starts as after y. So in the owner's own session, and in one a
    // teammate's message started that he works on as his own; a teammate's question has no Task.
    if (!running && task.state !== 'preparing' && approvesTasks(mode) && task.plan?.state === 'proposed' && !isPeerRun(task.origin)) {
      const plan = approveTask(location ?? projectFolder(root), String(task.id), { by: mode });
      enqueue(root, `${LABELS[mode]} approved the Task: ${plan.title}`, { continuationTaskId: String(task.id), priority: 0, approved: true }); conduct();
      return `${LABELS[mode]}. It approved the Task, and the work starts.`;
    }
    if (!running || !MODES.includes(now)) return `${LABELS[mode]} from your next message.`;
    if (mode === now) return `${LABELS[mode]}.`;
    if (mode === 'full') {
      const waiting = pendingNow().filter(row => String(row.taskId) === String(task.id) && (!row.root || row.root === root) && fullAllowed(task, row.role)), allowed = allowForFull({ ...task, permissions: mode }, waiting, was);
      return `${allowed ? 'Allowed. ' : ''}Full access: this session no longer asks you.`;
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
    const picked = await listDialog('Always allow', [ink(`This project  ${shortHome(approval.root ?? '')}`, 'text', colour), ink('All my projects', 'text', colour)], { notes: [offer.line, 'Push, tag, merge, deploy and publish stay blocked outside Full access.'], hint: 'enter choose · esc cancel' });
    if (!picked) return;
    const all = picked.index === 1;
    const { answered } = keepRule(approval, task.origin, all ? 'all' : 'project', { sessionOf: approvalSession });
    setMessage(`${answered ? 'Allowed. ' : ''}From now on, without asking: ${offer.summary} (${all ? 'all your projects' : 'this project'}).`);
  }
  // /permissions rules: what runs without asking, numbered as elu permissions numbers it.
  async function rulesDialog() {
    for (let selected = 0; ;) {
      const rows = listEntries();
      const picked = await listDialog('Allowed without asking', rows.map(row => ink(entryLine(row), row.kind === 'default' && !row.on ? 'muted' : 'text', colour)), { selected, keys: ['x', 'o'], notes: ['a beside y and n adds a rule when a session asks. Push, tag, merge, deploy and publish are refused outside Full access.'], hint: 'x remove or turn off · o turn on · esc close' });
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
    if (listed()) return shownAsMine({ on, status, items: on ? items() : [] });
    if (!on) return { on, status };
    return shownAsMine({ on, status, items: items(), agents: peerList('teamAgents'), trusted: trustedKeys(status), bots: myBots().map(bot => ({ ...bot, tone: botColor(bot) })) });
  }
  // What Chats and Sessions draw from the daemon's files names another computer of mine as
  // peerName does: its row on a team (mine, and waiting, mark it there), each thread with it
  // and its live sessions. A draft names its teammate by name only, so one for a computer of
  // mine is found by the name it has on the team. One that waits has self, the name /mine
  // there finds this machine by; a computer that says it is mine and is not marked here goes by
  // the name /mine here finds it by, and has it as asks.
  function shownAsMine(frame) {
    const mine = frame.status ? remoteApp.yours() : null, asking = frame.status ? remoteApp.asking() : null; if (!mine?.size && !asking?.size) return frame;
    const self = remoteApp.self(), row = member => mine.has(member?.key) ? { ...member, name: mine.get(member.key).name, mine: true, waiting: mine.get(member.key).waiting, ...(mine.get(member.key).waiting ? { self } : {}) } : asking.has(member?.key) ? { ...member, name: asking.get(member.key).name, asks: asking.get(member.key).name } : member;
    const called = (row, key) => row && typeof row === 'object' && mine.has(key) ? { ...row, name: mine.get(key).name } : row;
    const members = (frame.status.teams ?? []).flatMap(team => team?.members ?? []).filter(member => mine.has(member?.key));
    const drafted = item => item && typeof item === 'object' && !item.peer && item.kind === 'draft' ? called(item, members.find(member => memberName(member.name, member.key) === memberName(item.name))?.key) : item;
    return { ...frame,
      status: { ...frame.status, teams: (frame.status.teams ?? []).map(team => Array.isArray(team?.members) ? { ...team, members: team.members.map(row) } : team) },
      ...(frame.items ? { items: frame.items.map(item => item?.peer ? called(item, item.peer) : drafted(item)) } : {}),
      ...(frame.agents ? { agents: frame.agents.map(row => called(row, row?.peer)) } : {}) };
  }
  const onlineKeys = status => new Set((status?.teams ?? []).flatMap(row => row?.members ?? []).filter(member => member?.online).map(member => member.key));
  // A draw soon, after the rest of the read that asked for it, and at most once a frame however often it is asked for.
  const scheduleDraw = frameRender(() => { if (!closing) draw(); });
  const selectedBoardRow = () => boardLines[board.selected ?? 0]?.row ?? null;
  // Where a new task goes from the Tasks input: the open project, the only one, or the selected row's.
  function goalTarget() {
    const projects = (dash ?? snapshot)?.projects ?? [];
    const picked = view === 'projects' ? projectRows[projectsList.selected ?? 0]?.root : selectedBoardRow()?.root;
    // A row of another computer of mine, or of a project a teammate shares, names no project here.
    return controller?.repo.root ?? (projects.length === 1 ? projects[0].root : null) ?? ((/^(?:remote|shared):/.test(picked ?? '') ? null : picked) || null);
  }
  const projectName = root => snapshot?.projects?.find(project => project.root === root)?.name ?? path.basename(root);
  // The brand and the terminal's title name the open project, else ELU.
  const brandName = () => controller ? clip(snapshot?.name ?? projectName(controller.repo.root), 20) : 'ELU';
  // Sessions: the list, then the chat or the form beside it. A row's own text takes no focus.
  // A session's pane is its chat, or its changes while they show, also for one on another computer.
  const sessionPane = () => changesBox.hidden ? activity : changesBox;
  const viewPanes = () => listed() ? view === 'chat' ? [board, composing() ? composeList : sessionPane()] : remoteHere() ? [board, sessionPane()] : [board]
    : view === 'kanban' ? controller || sharedNow() ? kanbanLists : []
    : view === 'chats' ? teamOn ? teamLists : []
    : view === 'bots' ? [botsList]
    : view === 'projects' ? [projectsList]
    : view === 'usage' ? [usageList]
    : composing() ? [composeList] : [sessionPane()];
  // A window that is view only (another ELU window has the project) changes nothing on its board, so it offers none of that.
  const viewOnly = () => Boolean(controller) && claim.readOnly;
  const subButtons = () => view === 'kanban' ? sharedNow() ? [back] : [...(viewOnly() ? [] : [newCard]), ...(controller && kanbanBoards.length > 1 ? [kanbanPick] : [])] : view === 'bots' ? [newBot] : view === 'projects' ? [newProject] : listed() || ['chats', 'usage'].includes(view) ? [] : [back];
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
  // On a Sessions row, and in a session's chat, every character types a message. A row's key
  // acts when it is the one character typed and Enter follows: what the key bar names for the
  // row, + for a new session, and y, n, f and a on a row that waits on an answer. Typed in a
  // session that was opened or written in, a lone letter is a reply, unless the typing began
  // on the row. The key bar says it once, in the room it has.
  const LETTER = ['letter', 'then enter'], LETTER_SHORT = ['letter', '⏎'];
  const lettered = pairs => [...pairs, [...pairs, LETTER].map(pair => pair.join(' ')).join('  ').length <= screen.width - 2 ? LETTER : LETTER_SHORT, ['tab', 'next']];
  const KEY_ACTIONS = { a: 'answer', s: 'stop', x: 'stop', r: 'retry', d: 'diff', c: 'close', e: 'rename', u: 'unarchive', p: 'publish', y: 'accept', f: 'full', w: 'work', n: 'decline', '+': 'new' };
  const KEY_DOES = { archive: 'archives this session', rename: 'renames this session', changes: 'shows its changes', 'new session': 'starts a new session', stop: 'stops this session', remove: 'removes it', retry: 'tries again', unarchive: 'brings this session back', publish: 'publishes it', answer: 'answers it', 'follow up': 'writes a follow up', allow: 'allows it', deny: 'denies it', 'full access': 'allows it with Full access', always: 'always allows this', approve: 'approves the Task', reject: 'rejects the Task', 'run now': 'runs it now', pause: 'pauses it', resume: 'resumes it', delete: 'deletes it', accept: 'accepts it', decline: 'declines it', send: 'sends it', discard: 'discards it', cancel: 'cancels it', dismiss: 'dismisses it' };
  // typedFrom: the list or the chat the typing began in, or null when it began in the box.
  // typedBase: the draft the box held then. One character typed over it is still a row's key,
  // and the draft stays in the box when the key acts.
  let typedFrom = null, typedBase = '';
  function typedAlone(value) {
    if (typeof value !== 'string') return null;
    if (value.length === 1) return value;
    if (!typedFrom || !typedBase || value.length !== typedBase.length + 1) return null;
    let at = 0; while (at < typedBase.length && value[at] === typedBase[at]) at++;
    return value.slice(0, at) + value.slice(at + 1) === typedBase ? value[at] : null;
  }
  function rowKey(value = ask.getValue()) {
    const text = typedAlone(value);
    if (!text || !KEY_ACTIONS[text]) return null;
    if (!listed()) {
      // A session opened from Kanban has no row. Typed in its chat, y, n, f and a answer the
      // approval it waits on, and y and n the Task that waits.
      // f and a typed in its box answer it too, as its line says; y and n from there go to answerKey.
      const task = (typedFrom || ['f', 'a'].includes(text)) && view === 'chat' && controller && selectedId && !selectedRequest ? controller.snapshot().tasks.find(row => row.id === selectedId) : null, asked = task ? approvalsFor(task)[0] : null;
      if (asked && ['y', 'n'].includes(text)) return { does: KEY_DOES[text === 'y' ? 'allow' : 'deny'], run: () => setMessage(answerApproval(asked.id, text === 'y' ? 'allow' : 'deny') ? text === 'y' ? 'Allowed.' : 'Denied.' : 'That approval was already answered.') };
      if (asked && text === 'f') return { does: KEY_DOES['full access'], run: () => offersFull(task, asked) ? allowFull(task, asked) : undefined };
      if (asked && text === 'a') return { does: KEY_DOES.always, run: () => allowAlways(task, asked) };
      if (!asked && task?.plan?.state === 'proposed' && ['y', 'n'].includes(text)) return { does: KEY_DOES[text === 'y' ? 'approve' : 'reject'], run: () => decideTask(controller.repo.root, task, text === 'y') };
      // d shows what the session changed, as it does on a row.
      if (task && text === 'd') return { does: KEY_DOES.changes, run: () => showChanges({ focus: true }) };
      return null;
    }
    // In a session open beside the list, f and a typed in its box answer the approval it waits
    // on, as its line says, as y and n do (answerKey). Any other letter there is a message.
    if (!typedFrom && enteredHere()) {
      const row = selectedBoardRow(), asked = rowApproval(row) ?? (row?.kind === 'remote' ? row.approval : null);
      return asked && (text === 'a' || text === 'f' && row.kind === 'task') ? { action: KEY_ACTIONS[text], does: text === 'f' ? KEY_DOES['full access'] : KEY_DOES.always } : null;
    }
    if (!controller && !selectedBoardRow()) return null;
    const row = selectedBoardRow(), named = keyPairs(board).find(([key]) => key === text) ?? rowActions(row).find(([key]) => key === text);
    if (named) return { action: KEY_ACTIONS[text], does: KEY_DOES[named[1]] ?? `does “${named[1]}”` };
    if (text === '+') return { action: 'new', does: KEY_DOES['new session'] };
    if (text === 'x' && rowActions(row).some(([key]) => key === 's')) return { action: 'stop', does: KEY_DOES[rowActions(row).find(([key]) => key === 's')[1]] ?? 'stops it' };
    // A row that waits on an answer keeps f and a as its keys even where they are not offered: they say why.
    const waits = row && (rowApproval(row) || taskWaits(row) || row.kind === 'approval');
    if (waits && ['f', 'a'].includes(text)) return { action: KEY_ACTIONS[text], does: text === 'f' ? KEY_DOES['full access'] : KEY_DOES.always };
    // d shows what a session that waits on an answer changed, to read before the answer is given.
    if (waits && text === 'd' && row.kind === 'task') return { action: 'diff', does: KEY_DOES.changes };
    return null;
  }
  // Whether d, then Enter, typed in the chat beside the list shows the session's changes: its
  // row names d (a session here or on another computer), or it was opened from Kanban.
  function paneShowsChanges() {
    if (!sessionShown()) return false;
    if (!listed()) return view === 'chat' && !selectedRequest;
    const row = selectedBoardRow();
    return Boolean(row) && (rowActions(row).some(([key]) => key === 'd') || row.kind === 'task' && Boolean(rowApproval(row) || taskWaits(row)));
  }
  // The key bar names what each key does for whatever has focus right now.
  function keyPairs(focused = screen.focused) {
    if (tabs.includes(focused)) return [['←→', 'switch'], ['enter', 'open'], ['↓', listed() ? 'sessions' : view === 'kanban' ? sharedNow() ? 'back to Projects' : viewOnly() ? 'board' : 'new task' : view === 'chats' ? 'chats' : view === 'bots' ? 'new bot' : view === 'projects' ? 'new project' : view === 'usage' ? 'usage' : 'back']];
    if (focused === newCard) return [['enter', 'new task'], ['↓', 'board'], ['↑', 'tabs']];
    if (focused === kanbanPick) return [['enter', 'choose a board'], ['↓', 'board'], ['↑', 'tabs']];
    if (focused === newBot) return [['enter', 'new bot'], ['↓', 'bots'], ['↑', 'tabs']];
    if (focused === botsList) return [['enter', 'open'], ['n', 'new bot'], ['x', 'remove'], ['tab', 'next']];
    if (focused === newProject) return [['enter', 'new project'], ['↓', 'projects'], ['↑', 'tabs']];
    if (focused === projectsList && projectRows[projectsList.selected ?? 0]?.remote) return [['enter', 'sessions'], ['n', 'new project'], ['tab', 'next']];
    if (focused === projectsList && projectRows[projectsList.selected ?? 0]?.shared) return [['enter', projectRows[projectsList.selected ?? 0].sharers[0].mine ? 'open' : 'team board'], ['c', 'bring here'], ['n', 'new project'], ['tab', 'next']];
    if (focused === projectsList) return [['enter', 'settings'], ['o', 'make active'], ['n', 'new project'], ['x', joinedInBar(projectRows[projectsList.selected ?? 0]?.root).length ? 'leave' : 'archive'], ['tab', 'next']];
    if (focused === usageList) {
      const vendorRow = usageData?.find(row => row.vendor === usageRows[usageList.selected ?? 0]?.vendor);
      // Antigravity CLI and Grok Build: s signs them in here, signed in or not (another account, a lapsed sign-in).
      const signIn = vendorRow?.signsInHere && vendorRow.installed ? [['s', 'sign in']] : [];
      return usageRows[usageList.selected ?? 0]?.agent ? [['enter', 'open'], ['r', 'refresh'], ['t', usagePeriod === 1 ? '7 days' : 'today'], ['↑↓', 'scroll'], ['tab', 'next']]
      : usageRows[usageList.selected ?? 0]?.none ? [['r', 'refresh'], ['t', usagePeriod === 1 ? '7 days' : 'today'], ['tab', 'next']]
      : ['needed', 'failed'].includes(vendorRow?.check) || vendorRow?.asks ? [['c', vendorRow.asks ? 'ask again' : 'run check'], ...signIn, ['d', 'details'], ['r', 'refresh'], ['t', usagePeriod === 1 ? '7 days' : 'today'], ['tab', 'next']]
      : signIn.length ? [...signIn, ['d', 'details'], ['r', 'refresh'], ['t', usagePeriod === 1 ? '7 days' : 'today'], ['tab', 'next']]
      : [['enter', 'use'], ['a', 'add account'], ['x', 'forget'], ['d', 'details'], ['r', 'refresh'], ['t', usagePeriod === 1 ? '7 days' : 'today'], ['tab', 'next']];
    }
    if (kanbanLists.includes(focused)) {
      const index = kanbanLists.indexOf(focused), item = kanbanData[index]?.items[focused.selected ?? 0], column = kanbanData[index]?.column;
      if (viewOnly() && !sharedNow()) return [...(item?.teammate ? [['enter', 'read']] : item && (column !== 'todo' || !item.card) ? [['enter', 'open']] : []), ['←→', 'columns']];
      const first = !item ? [] : item.teammate ? [['enter', 'read']] : column === 'todo' ? [['⇧→', 'start'], ['enter', 'edit'], ['x', 'delete']] : column === 'needs' ? [['enter', 'open'], ['⇧→', 'done']] : column === 'done' ? [['enter', 'open'], ['⇧←', 'reopen']] : [['enter', 'open']];
      return [...first, ['←→', 'columns'], sharedNow() ? ['n', `write to ${sharedWho(sharedNow())}`] : ['n', 'new task']];
    }
    if (focused === back) return view === 'kanban' ? [['enter', 'back to Projects'], ['↓', 'board']] : [['enter', 'back to Kanban'], ['↓', 'chat']];
    // The row of a session that waits on an approval of an action names d too: its changes are read before the answer.
    if (focused === board && rowApproval(selectedBoardRow())) return lettered([['y', 'allow'], ['n', 'deny'], ...(offersFull(selectedBoardRow().task, rowApproval(selectedBoardRow())) ? [['f', 'full access']] : []), ...(offersAlways(selectedBoardRow().task, rowApproval(selectedBoardRow())) ? [['a', 'always']] : []), ['d', 'changes'], ['enter', 'open']]);
    if (focused === board && selectedBoardRow()?.kind === 'approval' && offersAlways(approvalSession(selectedBoardRow().approval), selectedBoardRow().approval)) return lettered([['y', 'allow'], ['n', 'deny'], ...(offersFull(approvalSession(selectedBoardRow().approval), selectedBoardRow().approval) ? [['f', 'full access']] : []), ['a', 'always'], ['enter', 'open']]);
    if (focused === board && selectedBoardRow()?.kind === 'approval' && offersFull(approvalSession(selectedBoardRow().approval), selectedBoardRow().approval)) return lettered([['y', 'allow'], ['n', 'deny'], ['f', 'full access'], ['enter', 'open']]);
    // The row of a session whose Task waits names d too: its changes are read before the Task is approved.
    if (focused === board && taskWaits(selectedBoardRow())) return lettered([['y', 'approve'], ['n', 'reject'], ['d', 'changes'], ['enter', 'open']]);
    // A session on another computer of mine that waits for y or n: n answers it, so it is not also new session.
    if (focused === board && selectedBoardRow()?.kind === 'remote' && (selectedBoardRow().approval || selectedBoardRow().label === 'TASK')) return lettered(rowActions(selectedBoardRow()));
    // Where n declines, denies or dismisses the row, it is not also new session there; + still starts one.
    if (focused === board) return selectedBoardRow() ? lettered([...rowActions(selectedBoardRow()).slice(0, 5), ...(rowActions(selectedBoardRow()).some(([key]) => key === 'n') ? [] : [['n', 'new session']])]) : [['enter', 'new session'], ['↑↓', 'choose'], ['tab', 'next']];
    if (focused === composeList) {
      const row = composeRows[composeList.selected ?? 0];
      return [...row?.type === 'project' ? [['enter', 'change project']] : row?.type === 'when' ? [['enter', 'schedule'], ...(composeWhen ? [['x', 'send now instead']] : [])] : ['permissions', 'place', 'model'].includes(row?.type) ? [['enter', 'change']] : row?.type === 'folders' ? [['enter', 'add'], ...(composeFolders.length ? [['x', 'clear']] : [])] : [['enter', 'add or remove'], ...(composeBots.length ? [['x', 'clear']] : [])], ['↓', 'write the message'], ['esc', 'sessions']];
    }
    if (focused === teamLists[0]) {
      const row = teamRows[0][focused.selected ?? 0]?.value;
      if (row?.type === 'add') return [['enter', row.what === 'channel' ? 'new channel' : 'invite a teammate'], ['↑↓', 'choose']];
      if (row?.type === 'room') return [['enter', 'write'], ['n', 'new channel'], ...(row.channel ? [['m', 'members'], ['x', 'leave']] : []), ['tab', 'threads']];
      if (row?.type === 'bot') return [['enter', 'write'], ['n', 'new channel'], ['tab', 'threads']];
      return [['enter', 'write'], ['t', 'trust'], ['h', 'hold replies'], ['o', 'auto-continue'], ['tab', 'threads'], ['n', 'new channel']];
    }
    // e is offered on a reply or a result that waits for the owner: it opens its text in the message box.
    // c is not offered on a thread whose answer or result the session already went on with.
    if (focused === teamLists[1]) {
      const row = teamRows[1][focused.selected ?? 0]?.value;
      return [['y', 'accept/send'], ...(row?.kind === 'held' ? [['e', 'edit']] : []), ['n', 'decline'], ...(row?.kind === 'answer' && row.continued === true ? [] : [['c', 'continue']]), ['enter', 'read'], ...(chatOpen?.type === 'room' && chatOpen.channel ? [['m', 'members'], ['x', 'leave']] : [])];
    }
    if (focused === ask && !palette.hidden) return [['↑↓', 'choose'], ['tab', 'complete'], ['enter', 'run'], ['esc', 'close']];
    if (focused === ask) {
      // A row's key alone in the box: Enter does it, and the line under the box says so.
      const lone = rowKey();
      if (lone) return [['enter', `${lone.does} · keep typing to write a message`]];
      // A command and a space, with no choices listed for what comes next: its usage and what it does.
      if (view === 'chats' && heldEdit) return [['enter', `send the edited ${heldEdit.result ? 'result' : 'reply'}`], ['esc', 'leave it held']];
      const typed = typedCommand(ask.getValue());
      if (typed) return [[typed.usage, `· ${typed.description}`]];
      if (view === 'chats') return [['enter', 'send'], ['@name', 'one member'], ['/', 'commands'], ['!', 'run a shell command']];
      // Only what is not obvious: what Enter does, the command list, choosing the model, and running a shell command.
      const more = [['/', 'commands'], ['/model', 'choose the model'], ['!', 'run a shell command']];
      // More chat, or more of what it changed, than its pane shows: PgUp and PgDn page it from here too.
      const page = (changesBox.hidden ? !activity.hidden && (activity._clines?.length ?? 0) > activity.height - activity.iheight : (changesShown?.rows.length ?? 0) > changesShown?.high) ? [['pgup pgdn', 'page']] : [];
      // With a saved bot, @name is worth knowing too; on a team it also asks a teammate (another computer of mine is not one).
      const mates = (peerData.status?.teams ?? []).some(team => (team?.members ?? []).some(member => member?.key && member.key !== peerData.status.key && !remoteApp.own(member.key)));
      if (savedBots().length || mates) more.unshift(['@name', !mates ? 'ask a bot' : savedBots().length ? 'ask a bot or a teammate' : 'ask a teammate']);
      // Beside the list, Esc is the way back to it. It comes last, so it shows where there is room.
      if (listed()) more.push(['esc', 'sessions']);
      // Over a session on another computer, Enter writes to that session; @here first asks your agent here.
      if (remoteHere() && !ask.getValue().trim() && remoteHere().remote?.held > 0 && ['running', 'preparing'].includes(remoteHere().remote.state)) return [['enter', `send it now on @${remoteHere().machine}`], ['esc', 'sessions']];
      if (remoteHere()) return boxKeys(remoteHere(), remoteApp.route(remoteHere(), ask.getValue()).to, page);
      // A view-only window sends nothing new from its box: the bar names what it does take.
      // A message a turn holds back was sent already, and Enter still sends it now (below).
      if (viewOnly() && view !== 'kanban' && (sessionBox() || ask.getValue().trim() || !heldBack().length)) return [['/', 'commands'], ...page, ...(listed() ? [['esc', 'sessions']] : [])];
      if (sessionBox()) return [['enter', 'new session'], ...page, ...more];
      if (view === 'kanban' && sharedNow()) return [['enter', `send to ${sharedWho(sharedNow())}`], ['/', 'commands']];
      if (view === 'kanban') return viewOnly() ? [['/', 'commands']] : [['enter', 'add to To do'], ...more.filter(([key]) => key !== '@name')];
      // While the open session works, a message still goes at any time, and /stop stops the turn:
      // said here, under the box, so nothing is drawn under a waiting message in the chat.
      const open = view === 'chat' && !composing() && selectedId && !selectedRequest ? (snapshot?.tasks ?? []).find(row => row.id === selectedId) : null;
      const stops = open?.state === 'running' && !approvalsFor(open).length || open && controller?.pushing(open.id) ? [['/stop', 'stop']] : [];
      // An empty box over a session whose turn holds a message back: Enter sends it now.
      if (!ask.getValue().trim() && heldBack().length) return [['enter', 'send it now'], ...(claim.readOnly ? [] : [['↑', 'take it back']]), ...stops, ...page, ...more];
      return [['enter', composing() && composeWhen ? 'save the schedule' : 'send'], ...stops, ...page, ...more];
    }
    // Beside the list, the keys a row's own text names work here too.
    // The page keys come last and are never the ones left out: a bar too long for the screen
    // says "then enter" as ⏎, then Esc's way back in one word, then leaves the arrows out.
    // d shows what the session changed from its chat too, as on its row: d, then Enter.
    if (focused === activity) {
      const keys = [...paneKeys(), ...(paneShowsChanges() ? [['d', 'changes']] : [])], fits = pairs => widthOf(pairs.map(pair => pair.join(' ')).join('  ')) <= screen.width - 2, steps = stepKeys.length ? [['ctrl+o', 'steps']] : [];
      const bars = [[LETTER, ['↑↓', 'scroll'], ['esc', 'sessions']], [LETTER_SHORT, ['↑↓', 'scroll'], ['esc', 'sessions']], [LETTER_SHORT, ['↑↓', 'scroll'], ['esc', 'back']], [LETTER_SHORT, ['esc', 'back']]].map(([letter, ...rest]) => [...keys, ...(keys.length ? [letter] : []), ...rest, ...steps, ['pgup pgdn', 'page']]);
      return bars.find(fits) ?? bars.at(-1);
    }
    if (focused === changesBox) {
      const row = changesShown?.rows[changesShown.cursor], file = row?.kind === 'file' ? changesShown.entry?.changes.files[row.file] : null;
      // Line notes are for a session on this computer: + and s are named where they work.
      return [['↑↓', 'move'], ...(file ? [['enter', unfolded(changesShown.entry, file) ? 'fold' : 'unfold']] : []), ...(row?.line && changesShown.entry?.notes ? [['+', 'note']] : []), ...(changesShown?.entry?.notes?.size ? [['s', 'send notes']] : []), ...(changesShown?.entry ? [['[ ]', 'file'], ['n p', 'change']] : []), ['pgup pgdn', 'page'], ['esc', 'chat'], ['tab', 'next']];
    }
    return [['tab', 'next'], ['?', 'help'], ['q', 'quit']];
  }
  // Up in the message box brings back what was sent and the cursor stays in the box: right after Enter, the bar says what the arrows do with it.
  const barPairs = () => { const pairs = keyPairs(), walk = recallKeys(); return walk.length ? [pairs[0], ...walk, ...pairs.slice(1)] : pairs; };
  const firstWords = (value, width) => fitWords(plain(String(value ?? '').split('\n').find(line => line.trim()) ?? ''), width);
  // How a message names a session: its title in quotes, cut short. No session shows a number.
  const sessionName = task => `"${firstWords(taskTitle(task), 40)}"`;
  const state = task => task.state === 'needs_input' ? 'waiting for you' : approvalsFor(task).length ? 'needs approval' : task.state === 'running' ? task.activeRole && task.activeRole !== 'lead' ? `${roleLabel(task.activeRole)} ${task.shadowing ? 'shadowing' : 'working'}` : 'working' : stateWord(task);
  // The same words for a session on another computer of mine, from what that computer last said.
  // One that has not started there says what it waits for, as its chat and its row do: a free
  // slot, say, or that it is kept here until that computer connects; only one at its start says starting.
  const remoteState = v => v.state === 'needs_input' ? 'waiting for you' : v.approvals?.length ? 'needs approval' : ['running', 'preparing'].includes(v.state) ? 'working' : v.state === 'starting' && v.waits ? waitState(v.waits) : v.state === 'starting' && v.unsent ? 'not sent yet' : v.finished === true ? 'committed' : String(v.state ?? '').replace(/_/g, ' ');
  const clockTime = value => new Date(value).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  // A focused tab or button is filled with the accent; the current one is accent text.
  function styleButton(widget, active, mark = active) {
    const focused = screen.focused === widget, row = widget.position.top === 0;
    Object.assign(widget.style, { fg: focused ? shade('background') : active ? accent : muted, bg: focused ? accent : active && row ? shade('background') : row ? shade('raised') : shade('background'), bold: active || focused, underline: mark && !focused, inverse: focused && !colour });
  }
  function placeRow(widgets, left) {
    let x = left;
    for (const widget of widgets) { const width = widthOf(widget.content); widget.hidden = false; Object.assign(widget, { left: x, width }); x += width + 1; }
    return x;
  }
  // --- Projects a teammate shares that this computer does not have (lib/peer/shared.mjs) ---
  // Each is a row of its own in Projects: its name, who shares it and on which machine. Enter
  // opens its team board in Kanban, read-only: the Tasks and sessions its team told. The
  // message box there writes to whoever shares it, which starts a session on their computer.
  // c brings it to this computer when its sharer told a git address. Read at most every 3
  // seconds, and only on a team. sharedOpen: the one whose team board Kanban shows.
  let sharedKept = { at: 0, rows: [] }, sharedOpen = null, sharedTold = { at: 0, id: null, board: null }, bringing = false;
  function sharedProjects(now = Date.now()) {
    if (!peerOn()) return [];
    if (now - sharedKept.at > 3000 || now < sharedKept.at) sharedKept = { at: now, rows: peerList('teammateProjects').filter(row => row?.id && Array.isArray(row.sharers) && row.sharers.length) };
    return sharedKept.rows;
  }
  // Null once it is no longer shared with this computer, or is here now: Kanban is the open project's again.
  const sharedNow = () => sharedOpen === null ? null : sharedProjects().find(row => row.id === sharedOpen) ?? null;
  // Who shares it, as a message names them, and the machine it is on: its name, else its owner's.
  const sharedWho = row => row.sharers[0].mine ? 'you' : peerName(row.sharers[0].name, row.sharers[0].key);
  const sharedBox = row => `@${remote(row.sharers[0].box, 32).replace(/[\s@]+/g, '') || peerName(row.sharers[0].name, row.sharers[0].key).slice(1)}`;
  const sharedBy = row => `shared by ${sharedWho(row)}${row.sharers.length > 1 ? ` +${row.sharers.length - 1}` : ''}`;
  // Outside Sessions the status line is one row: the longest of these that fits it, else the last.
  const fitLine = (...forms) => forms.find(form => widthOf(form) <= status.width - 3) ?? forms.at(-1);
  // As rows of Projects, after this machine's own. One that a computer of mine shares is left
  // out while Projects already lists that project of that computer (away): never two rows for one project.
  const sharedRows = away => sharedProjects().filter(row => !(row.sharers[0].mine && away.some(there => there.key === row.sharers[0].key && (row.repoId && there.repoId ? there.repoId === row.repoId : there.project === row.name))))
    .map(row => ({ ...row, shared: true, root: `shared:${row.id}`, by: sharedBy(row), box: sharedBox(row), online: row.sharers[0].online === true }));
  // The same project as my other computer lists it, when it does: the row Enter opens as any project of that computer.
  function sharedThere(row) {
    const who = row.sharers[0], listed = peerList('remoteMachines').find(machine => machine?.key === who.key);
    const found = (listed?.projects ?? []).find(project => row.repoId && project?.repoId ? project.repoId === row.repoId : project?.name === row.name);
    return found ? { remote: true, key: who.key, id: found.id, name: `${found.name} on ${sharedBox(row).slice(1)}`, project: found.name, machine: sharedBox(row).slice(1) } : null;
  }
  // Its team board, as boardColumns takes a project's: no cards or sessions of this machine, only what its team told.
  function sharedShown(row, now) {
    if (sharedTold.id !== row.id || now - sharedTold.at > 3000 || now < sharedTold.at) sharedTold = { at: now, id: row.id, board: peerRead('teammateProjectBoard', row.id) };
    const told = sharedTold.board;
    return { kanban: { cards: [], done: [], archived: [] }, snapshot: { tasks: [], queue: [] }, id: row.repoId ?? null, name: '', plans: Array.isArray(told?.plans) ? told.plans : [], sessions: Array.isArray(told?.sessions) ? told.sessions : [], shared: row };
  }
  // The message box over it: the longest that fits says where the message runs.
  function sharedLabel(row, max = Infinity) {
    const who = row.sharers[0].mine ? `your computer ${sharedBox(row)}` : sharedWho(row), name = clip(row.name, 30);
    return [` Message ${who} about ${name} · starts a session on ${row.sharers[0].mine ? 'it' : 'their computer'}, under the access ${row.sharers[0].mine ? 'you' : 'they'} chose `, ` Message ${who} about ${name} · starts a session there `, ` Message ${who} about ${name} `, ` Message ${who} `].find(form => widthOf(form) <= max) ?? ` Message ${who} `;
  }
  // The line under its board: whose it is and where, and how it comes here.
  function sharedNote(row, max) {
    const whose = row.sharers[0].mine ? `on your computer ${sharedBox(row)}` : `${sharedWho(row)}'s project, on ${sharedBox(row)}`, bring = row.address ? ' c in Projects brings it here.' : '';
    return [`${clip(row.name, 30)} is ${whose}, not on this computer. A message here starts a session there.${bring}`, `${clip(row.name, 30)} is ${whose}, not on this computer.${bring}`, `${clip(row.name, 30)} is ${whose}.${bring}`, `${clip(row.name, 30)} is ${whose}.`, 'Not on this computer.'].find(form => widthOf(form) <= max) ?? '';
  }
  // What a team shares that this computer does not have reaches Projects a moment after the
  // join: the join's line (it starts with head) then names it, whichever of its endings shows.
  function nameShared(teamId, head) {
    if (!teamId || typeof facade?.teammateProjects !== 'function') return;
    const started = Date.now(); let rows = [];
    // For a minute, and only while the join's line is the one showing: often at first, then every two seconds.
    const look = () => {
      if (closing || Date.now() - started > 60000) return;
      if (message.startsWith(head) && !message.includes(' in Projects.')) {
        if (!rows.length) rows = peerList('teammateProjects').filter(row => row?.name && row.teams?.some(team => team?.id === teamId));
        if (rows.length) {
          const names = rows.slice(0, 3).map(row => clip(row.name, 30));
          sharedKept.at = 0; setMessage(`${head} ${rows.length === 1 ? `Its project ${names[0]} is` : `Its projects ${names.join(', ')}${rows.length > 3 ? ` and ${rows.length - 3} more` : ''} are`} in Projects.${message.slice(head.length)}`);
        }
      }
      setTimeout(look, Date.now() - started < 10000 ? 400 : 2000).unref?.();
    };
    look();
  }
  // --- Kanban: what teammates are working on in this project ---
  // Each teammate's machine tells every session it runs in a repository this machine also
  // has (lib/peer/cards.mjs), and each one's Task (lib/peer/plans.mjs). They are
  // cards on the four columns, each with the teammate's name, read-only. What a teammate sent
  // is text to show, never to act on. A project whose folder holds several repositories has
  // one board for each (lib/kanban-repos.mjs); the header picks one.
  const teamTaskState = task => task.state === 'done' ? 'done' : 'in progress';
  const teamTaskDone = task => ({ done: task.subtasks.filter(step => step.state === 'done').length, of: task.subtasks.length });
  const teamTaskAt = task => task.updatedAt ?? task.doneAt ?? task.approvedAt;
  // Read at most every 3 seconds, and only on a team.
  function teammateBoard(on) {
    const root = on && peerData.on ? controller.repo.project ?? controller.repo.root : null;
    if (!root) teamTasks = { at: 0, root: null, people: [], sessions: { repos: [], people: [] }, off: false };
    else if (teamTasks.root !== root || Date.now() - teamTasks.at > 3000) {
      let off = false; try { off = facade?.boardKeptOff?.(root) === true; } catch { off = false; }
      const told = peerRead('teammateSessions', root), sessions = { repos: Array.isArray(told?.repos) ? told.repos : [], people: Array.isArray(told?.people) ? told.people : [] };
      teamTasks = { at: Date.now(), root, people: peerList('teammateTasks', root).filter(person => Array.isArray(person?.tasks) && person.tasks.length), sessions, off };
    }
    return teamTasks;
  }
  // Each session's repository folder, with the clones the daemon found in the project's folder,
  // and the repository of the session last open.
  let kanbanClones = { at: 0, root: null, list: [] };
  function kanbanFolders(now) {
    if (kanbanClones.root !== controller.repo.root || Date.now() - kanbanClones.at > 3000) kanbanClones = { at: Date.now(), root: controller.repo.root, list: peerList('projectClones', controller.repo.root) };
    const folders = sessionFolders(controller.repo, snapshot.tasks, { clones: kanbanClones.list, now });
    const open = snapshot.tasks.find(task => task.id === selectedId), first = open ? folderRemote(folders.get(open.id) ?? null, now)?.repoId ?? null : null;
    return { folders, first };
  }
  // The boards of the open project, the one shown, and what is on it. The board of the
  // session last open in this project leads; one picked in the header stays until that changes.
  function kanbanShown(kanban, now) {
    const team = teammateBoard(true), { folders, first } = kanbanFolders(now);
    const found = projectBoards(controller.repo, snapshot, { others: team.sessions.repos, first, folders, now });
    kanbanBoards = found.boards;
    if (kanbanPicked && (kanbanPicked.root !== controller.repo.root || kanbanPicked.first !== first || !kanbanBoards.some(row => row.id === kanbanPicked.id))) kanbanPicked = null;
    const id = kanbanPicked ? kanbanPicked.id : kanbanBoards[0]?.id ?? null, own = boardSlice(kanban, snapshot, id, found);
    const plans = team.people.map(person => ({ ...person, tasks: person.tasks.filter(task => !task.repoId || task.repoId === id || kanbanBoards.length <= 1) })).filter(person => person.tasks.length);
    const sessions = team.sessions.people.map(person => ({ ...person, sessions: (person.sessions ?? []).filter(card => card.repoId === id) })).filter(person => person.sessions.length);
    return { ...own, id, name: kanbanBoards.find(row => row.id === id)?.name ?? '', plans, sessions };
  }
  async function pickKanbanBoard() {
    if (kanbanBoards.length < 2) throw new Error('This project has one board.');
    const shown = kanbanPicked?.id ?? kanbanBoards[0]?.id, picked = await listDialog('Kanban board', kanbanBoards.map(row => ink(row.name, 'text', colour)), { selected: Math.max(0, kanbanBoards.findIndex(row => row.id === shown)), notes: ['Each repository this project works in has its own board, shared with teammates who have it.'] });
    if (!picked) return;
    kanbanPicked = { root: controller.repo.root, first: kanbanFolders(Date.now()).first, id: kanbanBoards[picked.index].id };
  }
  // Why teammates see none of this board, when they could expect to.
  function drawTeamTasks(on, shown = null) {
    const note = on && shown?.shared ? sharedNote(shown.shared, screen.width - 4) : !on || !teamTasks.root ? '' : teamTasks.off ? 'Kept off the team board: teammates do not see your sessions here, and theirs are not shown. /share on puts it back.'
      : shown && shown.id === null && shown.snapshot.tasks.length ? 'These sessions work in no repository with an origin remote, so teammates do not see them.' : '';
    const g = geometry(screen.width, screen.height), height = g.statusTop - lifted - g.top, tall = note ? 3 : 0;
    if (on) kanbanBoxes.forEach(frame => { frame.height = height - tall; });
    Object.assign(kanbanTeam, { top: g.top + height - tall, left: 0, width: g.width, height: 3 });
    kanbanTeam.hidden = !tall;
    kanbanTeam.style.border.fg = shade('border');
    kanbanTeam.setContent(note);
  }
  // A card opened: one view of its whole Task, the same for my own sessions, those of my other
  // computers and teammates': where it stands, who works on it and where, the goal, the
  // description, the objectives (met ones marked), the success criteria, the subtasks and the
  // ETA. A session with no Task yet shows its first message. Mine opens with the Go to session
  // button at its foot; a teammate's is only read here. On my other computer, mine is what that
  // computer says was started by me, from the key that started it (session.own,
  // lib/peer/cards.mjs); a teammate's session there keeps @name, and has the button too. Every
  // field is another machine's or a model's text.
  async function openCard(item) {
    const lines = [], now = Date.now(), person = item.teammate ?? null, card = item.session ?? null;
    // What the card says is kept as said and wrapped when it is shown, for the width the dialog
    // has then: the window may change size while the card is open.
    const say = (text, tone = 'text', bold = false) => { lines.push({ text, tone, bold }); };
    const wrapped = () => { const width = Math.min(88, screen.width - 4) - 6; return lines.flatMap(row => typeof row === 'string' ? [row] : wrapText(row.text, width).map(line => ink(line, row.tone, colour, row.bold))); };
    const head = text => { lines.push(''); say(text, 'muted', true); };
    const at = value => { const time = Date.parse(value ?? ''); return Number.isFinite(time) ? time : 0; };
    const task = person ? item.shared ?? null : item.plan ?? null, column = COLUMNS.find(([key]) => key === item.column)?.[1] ?? item.column;
    // Who and where, what opens it, its first message and when it last moved.
    let title, where, open = null, first = '', last = 0, missing = '';
    if (!person) {
      title = 'Your session'; where = 'you · this computer';
      if (item.task) { const id = item.task.id; open = () => openRow({ kind: 'task', root: controller.repo.root, id }); first = sessionGoal(item.task); last = lastActivity(item.task); }
      else if (item.request) { const request = item.request; open = () => openRow({ kind: 'request', root: controller.repo.root, request }); first = requestGoal(request); last = at(request.createdAt); }
    } else {
      const name = remote(person.name, 40) || 'a teammate', box = remote(person.box, 24);
      last = card ? at(card.at) : at(teamTaskAt(task));
      if (person.mine) {
        // My other computer: to follow and answer in Sessions, when it lists this session.
        const own = card?.own === true, by = remote(card?.by, 40) || name;
        title = own ? `Your session${box ? ` on ${box}` : ''}` : `${by}'s ${card ? 'session' : 'Task'}${box ? ` on ${box}` : ''}`;
        where = own ? `you · ${box || name}` : card ? `Started by @${by} · on ${box || name}` : `Worked on by ${task.who} on ${box || name} · started by ${task.startedBy === 'schedule' ? 'a schedule' : task.startedBy === 'handoff' ? 'a handoff' : 'its owner'}`;
        first = card?.first ?? '';
        const key = card ? remoteApp.sessionKey(person.peer, { remote: card.remote ?? null, ref: card.ref ?? null }, controller?.repo.root) : null;
        if (key) open = () => { rememberDraft(); view = 'tasks'; returnTo = 'tasks'; selectedId = null; selectedRequest = null; following = null; ownSeen = null; wanted = null; barKey = openKey = key; resize(); focusInput(); };
        if (card?.plan && !task) missing = `It has a Task. Update ELU on ${box || name} to see it here.`;
      } else {
        title = `${name}'s ${card ? 'session' : 'Task'}`;
        where = card ? `Started by @${remote(card.by, 40) || name} · on ${box ? `${name}'s machine ${box}` : `${name}'s machine`}`
          : `Worked on by ${task.who} on ${name}'s machine${box ? ` ${box}` : ''} · started by ${task.startedBy === 'schedule' ? 'a schedule' : task.startedBy === 'handoff' ? 'a handoff' : 'its owner'}`;
        if (card?.plan && !task) missing = `It has a Task. It shows here once ${name} updates ELU.`;
      }
    }
    // A Task the session's mode approved says so, as the card in its session does. A line that
    // says what started the Task already (· started by a schedule) is not told that again.
    if (task && approvesTasks(task.approvedBy)) where = `${where} · ${taskLetBy(task, { started: !where.includes(' · started by ') })}`;
    say(task ? task.title : card ? card.title : item.title, 'text', true);
    // Where the card sits leads the line when it says something the Task's state does not: a
    // finished Task waiting for /publish is in progress, and its card is under Needs you.
    const state = task ? task.state === 'proposed' ? 'waits for approval' : teamTaskState(task) : '';
    if (task) say([...(column && String(column).toLowerCase() !== state ? [column] : []), state, `priority ${task.priority}`, `severity ${task.severity}`, ...(task.revision > 1 ? [`revision ${task.revision}`] : [])].join(' · '), 'muted');
    else say(column, item.column === 'needs' ? 'orange' : item.column === 'progress' ? 'blue' : 'muted');
    say(where, 'muted');
    if (task) {
      const { done, of } = teamTaskDone(task), criteria = Array.isArray(task.criteria) ? task.criteria : [];
      if (task.goal) { head('Goal'); say(task.goal); }
      if (task.description) { head('Description'); say(task.description); }
      head(`Objectives · ${task.met.length} of ${task.objectives.length} met`);
      task.objectives.forEach((text, index) => { const met = task.met.includes(index + 1); say(`  ${met ? '✓' : '·'} ${text}`, met ? 'green' : 'text'); });
      head(`Success criteria${criteria.length ? '' : ' · not set'}`); for (const text of criteria) say(`  · ${text}`);
      head(of ? `Subtasks · ${done} of ${of} done` : 'Subtasks · none yet');
      for (const step of task.subtasks) say(`  ${step.state === 'done' ? '✓' : step.state === 'doing' ? '▸' : '·'} ${step.text}`, step.state === 'done' ? 'green' : step.state === 'doing' ? 'blue' : 'text');
      lines.push(''); say(`ETA ${etaText(task, now)}`, task.state !== 'done' && (taskEta(task) ?? Infinity) < now ? 'orange' : 'text');
    } else {
      head('No Task yet');
      if (missing) say(missing, 'muted');
      const words = String(first ?? '').trim();
      if (words) say(words.length > 400 ? `${words.slice(0, 399)}…` : words);
    }
    lines.push(''); say([last ? `last activity ${relativeTime(new Date(last).toISOString(), now)}` : '', person && !person.online ? `last heard ${relativeTime(person.heardAt, now)}` : ''].filter(Boolean).join(' · ') || 'no activity yet', 'muted');
    if (person && !person.mine) { lines.push(''); say('It runs on their machine: only they can change it.', 'muted'); }
    // Only the Go to session button opens it: the text is there to read.
    const picked = await listDialog(clip(title, 60), wrapped, open ? { hint: 'enter go to session · ↑↓ scroll · esc close', button: 'Go to session' } : { hint: person && !person.mine ? 'read-only · ↑↓ scroll · esc close' : '↑↓ scroll · esc close' });
    if (picked?.button && open) await open();
  }
  function draw(idle) {
    drawDepth += 1;
    try { return drawNow(idle); } finally { drawDepth -= 1; if (!drawDepth) statusRead = null; }
  }
  function drawNow(idle) {
    if (closing || drawing) return;
    drawing = true; let again = false;
    try {
      if (minimumSize()) { screen.render(); lastFrame = null; return; }
      if (view === 'chat' && !controller) view = 'tasks';
      const g = geometry(screen.width, screen.height), W = g.width, now = Date.now();
      snapshot = view === 'chat' || view === 'kanban' && controller ? controller.snapshot() : allProjects(dashboardSnapshot());
      adoptHistory(); follow();
      // Messages a newer one to the same session made pointless leave the queue for good.
      for (const project of snapshot.projects ?? [snapshot]) if (project?.superseded?.length) { try { dropRequests(project.root, project.superseded); } catch { /* The next draw tries again. */ } }
      peerData = peerFrame();
      // A shared project's team board is open only while Kanban shows it. Once it is gone (unshared, the
      // team left, or it is here now), Kanban is the open project's again.
      if (sharedOpen !== null && (view !== 'kanban' || !sharedNow())) { sharedOpen = null; if (view === 'kanban') message = 'That project is no longer shared with this computer.'; }
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
      if (brand.content !== brandText) { brand.setContent(brandText); brand.width = widthOf(brandText); }
      if (screen.title !== name) screen.title = name;
      placeRow(tabs, widthOf(brandText) + 1);
      for (const tab of tabs) styleButton(tab, tab === activeTab());
      const stopped = peerData.on && peerData.status?.running === false;
      const pillText = `${ink(`${peerData.on && !stopped ? '●' : '○'} ${peerSummary(peerData.on, peerData.status)}`, stopped ? 'orange' : peerData.on ? 'green' : 'muted', colour)}${ink('  ·  ', 'dim', colour)}${ink(clockTime(now), 'muted', colour)} `;
      const pillWidth = widthOf(visible(pillText)), tabsEnd = tabs.at(-1).left + tabs.at(-1).width;
      pills.setContent(pillText); Object.assign(pills, { left: Math.max(0, W - pillWidth), width: pillWidth });
      pills.hidden = tabsEnd + 2 + pillWidth > W;
      // Row 1: the view's own buttons, then its title.
      for (const widget of [newCard, kanbanPick, newBot, newProject, back]) widget.hidden = true;
      kanbanPick.setContent(` Board: ${clip(kanbanName, 40)} ▾ `);
      const backText = view === 'kanban' ? ' ‹ Projects ' : ' ‹ Kanban '; if (back.content !== backText) back.setContent(backText);
      const end = placeRow(subButtons(), 1);
      for (const widget of [newCard, kanbanPick, newBot, newProject]) styleButton(widget, true, false);
      styleButton(back, false);
      const task = view === 'chat' && snapshot.tasks.find(row => row.id === selectedId);
      // A session on another computer of mine beside the list has the same title: its project,
      // its request, its state and its mode, as that computer last told this one.
      const there = remoteHere(), far = there?.remote ?? null, project = far ? there.project !== '-' ? there.project : '' : snapshot.name;
      const goal = task ? firstWords(taskTitle(task), 60) : far ? firstWords(far.title || 'Session', 60) : '';
      const titled = (name, text) => [name, task || far ? text : selectedRequest ? 'saved request' : following ? following.bot ? `sending to @${following.bot}` : 'sending' : 'New session', task ? state(task) : far ? remoteState(far) : ''].filter(Boolean).join('  ·  ');
      // The session's badge: Ask, Auto or Full (orange), then Here when it works in your checkout.
      const mode = task && MODES.includes(task.permissions) ? task.permissions : far && MODES.includes(far.mode) ? far.mode : null;
      const badge = mode ? ink('  ·  ', 'dim', colour) + ink(BADGES[mode], mode === 'full' ? 'orange' : 'muted', colour, true) + ((task ? task.place?.kind : far.place) === 'here' ? ' ' + ink('Here', 'orange', colour, true) : '') : '';
      // The title sits over the session: beside the list in Sessions, else after the view's buttons.
      // Beside the list it is cut to fit. The project goes first, since the brand names it, then the end of the request.
      // The request gets the room the dot and the state leave: titled('', '.') is those and one character.
      // After the badge, a bot of this session that runs on a schedule: "◷ @elu every 1h · next in 52m".
      // It is left out when the line has no room for it beside a readable title.
      const runs = task ? (timedSessions()[snapshot.root]?.[task.id] ?? []).map(value => botScheduleBrief(value)).join('  ·  ') : '', clocked = runs ? ink('  ·  ', 'dim', colour) + ink(`◷ ${runs}`, 'blue', colour) : '';
      const left = listed() ? boardBox.width + 1 : end + 1, tail = clocked && W - left - 1 - widthOf(visible(badge)) - widthOf(visible(clocked)) >= 24 ? clocked : '', room = Math.max(1, W - left - 1 - widthOf(visible(badge)) - widthOf(visible(tail)));
      const title = view === 'kanban' ? sharedNow() ? `${sharedNow().name}  ·  ${sharedBy(sharedNow())}  ·  on ${sharedBox(sharedNow())}` : controller ? snapshot.name : '' : view !== 'chat' && !far ? '' : !listed() || widthOf(titled(project, goal)) <= room ? titled(project, goal) : widthOf(titled('', goal)) <= room ? titled('', goal) : titled('', fitWords(goal, Math.max(4, room - widthOf(titled('', '.')) + 1)));
      Object.assign(header, { left, width: Math.max(1, W - left - 1) });
      header.setContent(ink(clip(title, room), 'text', colour, true) + badge + tail);
      // Sessions: the list. Its rows are built before this, with the cursor.
      boardBox.hidden = !listed();
      if (listed()) {
        // The list's last column is its scrollbar. The first one marks the cursor's row.
        // A row stops one column short of the list, as in the other lists. One that fills it is wrapped by blessed and loses its age.
        const width = Math.max(8, board.width - 2), mark = screen.focused === board ? 'orange' : 'dim', columns = barColumns(boardLines.flatMap(line => line.row ? [line.row] : []), width - 1);
        const lines = boardLines.map((line, place) => line.spacer ? '' : line.note ? ink(` ${line.note}`, 'muted', colour) : line.header
          ? ink(` ${line.header.toUpperCase()}`, line.tone, colour, true) + ink(` ${line.count} `, 'muted', colour) + ink('─'.repeat(Math.max(0, width - widthOf(line.header.toUpperCase()) - String(line.count).length - 3)), 'dim', colour)
          : ink(place === barAt ? '▌' : ' ', mark, colour) + (line.add ? ink('+ New session', 'orange', colour, true) : barCells(line.row, width - 1, now, columns).map(cell => ink(cell.text, cell.tone, colour, cell.bold, { trusted: line.row.kind === 'peer' && line.row.item?.trusted === true })).join('')));
        // Queued says what its sessions wait for beside its count (said: "4 of 4 running", then shorter): the longest its heading has room for.
        boardLines.forEach((line, place) => { const room = line.said ? width - line.header.length - String(line.count).length - 3 : 0, text = (line.said ?? []).find(text => text.length + 2 <= room); if (text) lines[place] = ink(` ${line.header.toUpperCase()}`, line.tone, colour, true) + ink(` ${line.count} · ${text}${text.length + 2 < room ? ' ' : ''}`, 'muted', colour) + ink('─'.repeat(Math.max(0, room - text.length - 3)), 'dim', colour); });
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
        // A teammate's line says what is on for them: held replies and auto-continue, with their keys.
        const inside = chatOpen?.type === 'room' ? membersLine(chatOpen, widths[1], colour) : chatOpen?.type === 'member' ? teammateLine(peerPolicyOf(chatOpen.key), widths[1], colour) : '';
        chatMembers.setContent(inside); chatMembers.hidden = !inside;
        Object.assign(teamLists[1], inside ? { top: 2, height: '100%-3' } : { top: 1, height: '100%-2' });
        layoutChats(g);
      }
      // Kanban
      const sharedBoard = view === 'kanban' ? sharedNow() : null;
      const kanbanOn = view === 'kanban' && Boolean(controller || sharedBoard);
      kanbanOff.hidden = view !== 'kanban' || kanbanOn;
      kanbanOff.setContent('Kanban shows one project. Open one in the Projects tab, or start elu inside it.');
      kanbanBoxes.forEach((frame, index) => { frame.hidden = !kanbanOn; frame.style.border.fg = screen.focused === kanbanLists[index] ? accent : shade('border'); });
      if (kanbanOn) {
        let data = sharedBoard ? null : readBoard(controller.repo);
        if (data?.cards.some(card => card.requestId && !card.taskId) && linkCards(controller.repo, snapshot.queue ?? [])) data = readBoard(controller.repo);
        const previous = kanbanData, shown = sharedBoard ? sharedShown(sharedBoard, now) : kanbanShown(data, now); kanbanName = shown.name;
        kanbanData = boardColumns(shown.kanban, shown.snapshot, now, shown.plans, shown.sessions); kanbanShownNow = shown;
        kanbanData.forEach((column, index) => {
          const list = kanbanLists[index], width = Math.max(4, list.width - 2), kept = previous[index]?.items[list.selected ?? 0]?.key;
          kanbanBoxes[index].setLabel(` ${column.name} ${column.items.length} `);
          const tone = item => item.teammate ? item.teammate.online === false || column.column === 'done' ? 'muted' : 'blue' : item.task?.state === 'needs_input' || item.request?.state === 'blocked' || item.task?.state === 'blocked' || item.plan?.state === 'proposed' ? 'orange' : column.column === 'progress' ? 'blue' : column.column === 'done' ? 'muted' : 'text';
          const lines = column.items.map(item => {
            // A Task's card is its title first; where the Task stands goes beside it as far as it fits (lib/kanban.mjs).
            const card = item.teammate ? fitTeammateCard(plain(item.title), item.detail, width, item.session ? 2 : 1) : item.plan ? fitCard(plain(item.title), item.detail, width) : null, title = card ? card.title : fitWords(plain(item.title), width), room = width - widthOf(title) - 2;
            const detail = card ? card.detail : item.detail && room >= Math.min(widthOf(item.detail), 12) ? clip(item.detail, room) : '';
            return ink(title, tone(item), colour, column.column !== 'done') + (detail ? ink(`  ${detail}`, 'muted', colour) : '');
          });
          if (lines.join('\n') !== list.ritems?.join('\n')) list.setItems(lines);
          const found = kept === undefined ? -1 : column.items.findIndex(item => item.key === kept);
          list.select(found >= 0 ? found : Math.max(0, Math.min(list.selected ?? 0, column.items.length - 1)));
        });
      }
      drawTeamTasks(kanbanOn, kanbanOn ? kanbanShownNow : null);
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
        followDefault();
        // A row is a name, a value and a hint. Beside the list the pane is narrow: the value
        // column shrinks, then a shorter hint is used, then none, so no row wraps.
        const room = Math.max(30, composeList.width - 1), column = Math.min(22, Math.max(12, room - 29));
        const label = text => ink(text.padEnd(13), 'muted', colour);
        const row = (name, value, tone, ...hints) => {
          const text = clip(value, Math.min(40, room - 13)), wide = Math.max(column, widthOf(text) + 2), hint = hints.find(hint => 13 + wide + hint.length <= room);
          // tone: a colour for the whole value, or a function that paints it word by word.
          if (typeof tone === 'function') return label(name) + tone(text) + ' '.repeat(hint ? wide - widthOf(text) : 0) + ink(hint ?? '', 'muted', colour);
          return label(name) + ink(hint ? padEnd(text, wide) : text, tone, colour, true) + ink(hint ?? '', 'muted', colour);
        };
        composeRows = [{ type: 'project', line: label('Project') + ink(clip(snapshot.name, room - 13 - (claim.readOnly ? 11 : 0)), 'text', colour, true) + ink(claim.readOnly ? '  view only' : '', 'orange', colour) }];
        const upcoming = composeWhen && nextRun(composeWhen, new Date(now));
        composeRows.push({ type: 'when', line: row('When', composeWhen?.label ?? 'now', composeWhen ? 'orange' : 'text', ...(composeWhen ? [upcoming ? `next ${dateText(upcoming)}` : 'has passed'] : ['/schedule to run it later', '/schedule'])) });
        // The session's permissions: the mode, where the lead works, extra folders it may read.
        composeRows.push({ type: 'permissions', line: row('Permissions', LABELS[composeMode], composeMode === 'full' ? 'orange' : 'text', '/permissions ask, auto or full', '/permissions') });
        composeRows.push({ type: 'place', line: row('Runs in', placeText(composePlace), composePlace.kind === 'here' ? 'orange' : 'text', '/place worktree, branch NAME or here', '/place') });
        const folders = composeFolders.length ? composeFolders.map(shortHome).join(' ') : 'none';
        composeRows.push({ type: 'folders', line: row('Folders', folders, 'text', ...(composeFolders.length ? ['/permissions folders add PATH · x clears', '/permissions folders add PATH', 'x clears'] : ['/permissions folders add PATH', '/permissions folders'])) });
        // The model the message goes to, then the bots that review its changes.
        const using = nameOf(composeModel ?? controller.defaultModel()), passed = composeModel ? '' : passedOver(controller.startModel().missing, nameOf);
        composeRows.push({ type: 'model', line: row('Model', using, 'orange', '/model NAME, or /model to pick', '/model NAME') });
        composeRows.push({ type: 'bots', line: row('Bots', composeBots.length ? botNames(composeBots, Math.min(40, room - 13)) : 'none', text => paintBots(text, 'text'), '/bots add NAME, /bots remove NAME', '/bots add NAME') });
        const lines = composeRows.map(row => row.line);
        if (lines.join('\n') !== composeList.ritems?.join('\n')) composeList.setItems(lines);
        // The note under the rows takes the lines it needs, and the rows take the rest.
        const note = (composeWhen ? `${scheduleRuns()}\nRuns while this computer is awake, even with ELU closed.` : `Your message goes to ${using}.${passed ? ` ${passed} ` : '\n'}Bots review the changes. Type @name to add one or to write to it.`).split('\n').flatMap(line => wrapText(line, Math.max(10, compose.width - 4)));
        if (composeHint.height !== note.length) { composeHint.height = note.length; composeList.height = `100%-${note.length + 3}`; }
        composeHint.setContent(note.join('\n'));
        compose.style.border.fg = screen.focused === composeList ? accent : shade('border');
      }
      const lines = []; stepKeys = [];
      // Who wrote each entry of a session's chat, when and what: a held place follows it (partsShown).
      let entryKeys = [];
      // A plain line in the chat is wrapped at words here, so the pane beside the list never wraps one a second time.
      // It is wrapped one column short of the pane: blessed wraps a coloured row that fills the pane again, at its
      // last space, which left "carry" and "on." of a stop line on rows of their own.
      const note = (text, tone, bold = false) => wrapText(text, chatWidth() - 1).map(row => ink(row, tone, colour, bold)).join('\n');
      if (task) {
        // A message answered beside the turn that still works (lib/message-aside.mjs) shows under
        // the working line, where it was typed, so a turn with many steps never pushes it out
        // of sight (besideTurn); once that turn is over it is part of the chat, in its place.
        const all = conversationEntries(repo, task), leadName = modelOf(task);
        const besideTurn = ['running', 'preparing'].includes(task.state) ? all.filter(entry => entry.beside) : [], entries = besideTurn.length ? all.filter(entry => !entry.beside) : all;
        entryKeys = entries.map(entry => `${entry.at}\0${entry.role}\0${entry.text}`);
        // Your messages sit on a shaded band behind a blue bar; the lead's behind an orange one.
        // A question ends the lead's last reply, in the same block.
        const waiting = task.state === 'needs_input' ? task.reply?.outcome === 'needs_input' ? task.reply : task.result : null;
        const asked = String(waiting?.question ?? '').trim(), choices = (waiting?.choices ?? []).map((choice, index) => `${index + 1}. ${choice}`).join('\n');
        const withQuestion = text => [text, asked && !text.includes(asked) ? asked : '', choices].filter(Boolean).join('\n\n');
        // A standup's rows that came after it (lib/standup.mjs) leave the question where it was.
        const own = entries.filter(entry => !entry.line && !entry.update), last = waiting && own.at(-1)?.lead ? own.at(-1) : null;
        // Each reply has its turn's steps above it, folded into one line.
        // A turn that ended with no reply, stopped by the owner, a limit or a failure, still
        // shows what it did, where it happened: before the message that came next.
        const runs = stepRuns(repo, task), { owned, before, after } = runsOfEntries(entries, runs);
        // The session's Task (lib/plan.mjs): what waits for a yes, or what is being worked on and how far it is.
        // It sits where it happened: after the reply that proposed it, before anything that came
        // later (taskPlace). A rejected one is a single line, until the chat goes on.
        const dropped = task.plan?.state === 'rejected' && (task.messages ?? []).some(row => Date.parse(row.at) > Date.parse(task.plan.rejectedAt));
        const cardAt = task.plan && !dropped ? taskPlace(entries, task.plan) : -1, card = () => lines.push(taskCard(task.plan, { width: chatWidth(), colour, approval: approvalsFor(task).length > 0 }));
        let drawn = 0;
        for (const entry of entries) {
          if (drawn++ === cardAt) card();
          for (const turn of [before.get(entry), owned.get(entry)]) { const steps = turn ? foldedSteps(turn) : null; if (steps) lines.push(steps); }
          const text = entry === last ? withQuestion(entry.text) : entry.text;
          // A ! command sits between the messages behind a green bar, with its output as printed.
          if (entry.shell) { lines.push(chatMessage({ title: entry.role, at: entry.at, text, tone: 'green', raw: true }, chatWidth(), colour)); continue; }
          // A bot's reply sits behind a bar in the bot's own colour, never the lead's orange or your blue; one it could not give, behind a red one.
          if (entry.bot) { lines.push(chatMessage({ ...tagged(entry.role, entryTag(entry)), at: entry.at, text, tone: entry.failed ? 'red' : entry.quiet ? 'muted' : toneOfBot(entry.bot) }, chatWidth(), colour)); continue; }
          // A standup's own lines (lib/standup.mjs) are notes; each update sits behind the agent's orange bar, titled with its session and computer.
          if (entry.line) { lines.push(note(text, 'muted')); continue; }
          if (entry.update) { lines.push(chatMessage({ title: entry.role, at: entry.at, text, tone: entry.failed ? 'red' : 'orange' }, chatWidth(), colour)); continue; }
          // A message sent while a turn worked, that went to that turn, says so under it.
          lines.push(chatMessage({ ...tagged(entry.role, entryTag(entry), entry === last ? ' is waiting for you' : ''), at: entry.at, text, tone: entry.lead ? 'orange' : 'blue', shaded: !entry.lead }, chatWidth(), colour) + (entry.during ? '\n' + note('Sent to the running turn.', 'muted') : ''));
        }
        if (cardAt >= entries.length) card();
        const unanswered = after.length ? foldedSteps(after) : null; if (unanswered) lines.push(unanswered);
        if (waiting && !last) lines.push(chatMessage({ title: `${leadName} is waiting for you`, text: withQuestion(''), tone: 'orange' }, chatWidth(), colour));
        // While it waits for an allow or deny it is not working: the approval below says what it waits for.
        const workFrom = lines.length;
        if (task.state === 'running' && !approvalsFor(task).length) {
          const working = after => { const line = tagged(roleLabel(task.activeRole), startedOn(task, task.activeRole), after); return line.narrow && widthOf(visible(line.title)) > chatWidth() ? line.narrow : line.title; };
          lines.push(ink(task.shadowing ? working(' is shadowing the last turn') : standupStage(task) === 'round' ? standupWaitLine(task) : standupStage(task) === 'summary' ? `${leadName} is writing the summary` : task.activeRole === 'checks' ? 'Checks are running' : !task.activeRole || task.activeRole === 'lead' ? `${leadName} is working` : working(' is working'), botOfKey(task.activeRole) ? toneOfBot(botOfKey(task.activeRole)) : 'orange', colour, true));
          // Every step of the run so far, newest last. Before its first one, and for the checks,
          // the newest line of the session's activity.
          const live = task.activeLog && path.dirname(task.activeLog) === taskDir(repo, task.id) ? runSteps(task.activeLog, { cwd: task.worktree }) : [];
          if (live.length) lines.push(stepLines(live, { width: chatWidth() - 1, colour, now }));
          // A run that prints only when it ends (lib/runner.mjs activeSilent): how long it has worked, and why no step shows.
          else if (task.activeSilent?.log && task.activeSilent.log === task.activeLog) lines.push(note(silentLine(task.activeSilent.name, Date.parse(task.activeSince ?? ''), now), 'muted'));
          else { const event = snapshot.activity.findLast(row => String(row.taskId) === String(task.id)); if (event) lines.push(ink(clip(event.text, chatWidth()), 'muted', colour)); }
          // That a message can go any time and /stop stops the turn is said by the key bar under the message box (keyPairs).
        }
        // The turn at work is drawn directly above what waits for it, under the notes about the turns before (below).
        const atWork = lines.splice(workFrom);
        // A session that stopped and waits for the owner says why, when that is known, and the one
        // thing to do. Edits a later turn could not finish are not offered to /publish.
        const stop = stopLine(task);
        // What the agent committed itself is the session's work: where it is. With all of it
        // committed the session has finished, and nothing asks for the checks.
        const work = stop || !['unverified', 'ready'].includes(task.state) ? null : committedLine(task);
        if (work) lines.push(note(work, finished(task) || task.state === 'ready' ? 'green' : 'orange'));
        if (task.state === 'unverified' && !stop && !finished(task)) lines.push(note('Edits are not verified. /publish runs the checks first.', 'orange'));
        // The branch moved while nothing ran here: what changed, and the one thing to do.
        const moved = stop ? null : restingMove(task, now);
        if (moved) lines.push(note(moved, 'orange'));
        // Pushed, with a pull request, the line above says it all; pushed by the agent without one, /publish opens it.
        if (task.state === 'ready' && !(work && (published(task) || task.committed?.pushed === true && task.pr))) lines.push(note(`Checks complete. /changes to inspect · ${publishWords(task)}`, 'green'));
        if (stop) lines.push(note(stop.text, 'orange'));
        else if (task.error) lines.push(note(task.error.message, 'orange'));
        // A push that was stopped, by /stop, by ELU closing or by its quiet limit, and what reached GitHub.
        const pushStop = pushStopNote(task);
        if (pushStop) lines.push(note(pushStop, 'orange'));
        // A live approval waits here and under Needs you; its letter typed in the box, then Enter, answers it.
        for (const row of approvalsFor(task)) lines.push([ink('Waiting for your approval', 'orange', colour, true), ink(`${!row.role || row.role === 'lead' ? leadName : roleLabel(row.role)} wants to:`, 'text', colour), note(row.summary, 'text', true), ink(offersFull(task, row) || offersAlways(task, row) ? `${approvalKeys(task, row)}, then Enter` : 'y allow · n deny, then Enter · esc later', 'muted', colour)].join('\n'));
        // Actions the vendor refused and reported, and a mode the vendor did not give.
        const lastLead = task.runs.findLast(run => run.role === 'lead');
        // What a rule of his or a default answered in this session, kept in its decisions.
        const ruled = [...new Set((task.approvals ?? []).filter(row => row.by && row.rule).map(row => `${row.by === 'rule' ? 'Allowed by your rule' : 'Allowed by default'}: ${row.rule}`))].slice(-3);
        if (ruled.length) lines.push(ruled.map(text => note(text, 'muted')).join('\n'));
        if (lastLead?.permissions === 'auto' && lastLead.effectivePermissions === 'ask') lines.push(note('Asked instead. Approve for me is not available here.', 'muted'));
        // It answered but stayed open for a command it left running: ELU ended that with the turn.
        if (lastLead?.leftRunning && !['running', 'preparing'].includes(task.state)) lines.push(note(`${leadName} had answered, so ELU stopped what it left running: ${lastLead.leftRunning}`, 'muted'));
        // A second launch for one message is said. One that started the message over may have run again
        // what the first one ran; one that asked the same session for its reply again started nothing over.
        if (lastLead?.again) lines.push(note(lastLead.resumed ? `${leadName} was asked for its reply again: the first one was not accepted.` : `${leadName} was started twice for this message: its first reply was not accepted. Anything it ran may have run twice.`, 'muted'));
        // What the last turn was refused, each with why and what to do. A step in which a
        // never-list command was refused shows whatever the turn went on to say.
        const rows = blockedRows(task, lastLead);
        if (rows.length) lines.push(rows.map(row => note(row.text, 'orange')).join('\n'));
        // A ! command still running in this session shows the end of its output so far.
        if (shellRun?.session?.id === task.id && shellRun.session.repo.root === repo.root) lines.push(chatMessage({ title: 'Shell', at: shellRun.at, text: [`$ ${shellRun.command}`, shellRun.run.tail(2000).trimEnd()].filter(Boolean).join('\n'), tone: 'green', raw: true }, chatWidth(), colour) + '\n' + ink('Running. /stop ends it.', 'muted', colour));
        lines.push(...atWork);
        // What the owner sent that the session has not read yet ends the chat, right above the
        // message box, with nothing under it.
        // A message of yours to it that did not run says why, and how to act on it. While the
        // session works its row stands for the turn, so the keys are named once the turn ends.
        const working = ['running', 'preparing'].includes(task.state);
        for (const row of (snapshot.queue ?? []).filter(value => value.continuationTaskId === task.id && ['blocked', 'waiting'].includes(value.state) && !(value.origin && value.state === 'waiting'))) {
          const said = [row.state === 'blocked' && row.reason, !working && 'In Sessions, r sends it again and s removes it.'].filter(Boolean).join(' ');
          lines.push(chatMessage({ title: `${requester(row)} (${row.state === 'blocked' ? 'blocked' : 'saved'})`, at: row.createdAt, text: requestGoal(row), tone: 'blue', shaded: true }, chatWidth(), colour) + (said ? '\n' + note(said, 'muted') : ''));
        }
        // What was sent while the session worked waits here and goes by itself when the turn
        // ends. The newest one names the key that takes it back, and says that an approval
        // above is not answered by it.
        // A standup's question (lib/standup.mjs) is not his message: its own rows show once it is answered.
        // One the running turn takes (activeInbox, Claude Code) goes on its input in a moment and
        // waits there for the turn's next step, so behind a long command it waits for the command;
        // once the turn took it, it is a message of the chat, marked sent to the running turn.
        // Enter sends it now, and the turn goes on. One the turn cannot take waits for the turn
        // to end, and Enter stops the turn as /stop stops it, so it starts the next one (sendWaitingNow).
        for (const entry of besideTurn) lines.push(entry.line ? note(entry.text, 'muted') : entry.update ? chatMessage({ title: entry.role, at: entry.at, text: entry.text, tone: entry.failed ? 'red' : 'orange' }, chatWidth(), colour) : chatMessage({ title: entry.role, at: entry.at, text: entry.text, tone: 'blue', shaded: true }, chatWidth(), colour));
        const held = (snapshot.queue ?? []).filter(row => row.continuationTaskId === task.id && ['queued', 'starting'].includes(row.state) && !row.standupFor), newest = waitingMessage(task.id, held);
        // Each says what happens to it and when (lib/message-aside.mjs waitingWords), never only
        // that it waits. One a turn cannot take is answered beside the turn at once: an answer
        // to a message that asks for work shows under it here, while the message keeps its place.
        for (const row of held) {
          // One that waits while no turn works says what for, as lib/waiting.mjs says it (a free slot, a time).
          const words = waitingWords(working ? row : { ...row, reason: waitingText(row) }, { working, goes: goesToTurn(task, row), deaf: answersBeside(task, row), soon: notSaidYet(task, row), stops: task.activeNowStops === true, command: commandRuns(task, repo), readOnly: claim.readOnly, model: leadName });
          const more = row === newest ? [...words.lines, ...(words.keys ? [words.keys] : []), ...(approvalsFor(task).length ? ['The approval above still needs your answer.'] : [])] : words.lines;
          const said = words.answer ? chatMessage({ title: `${words.answer.who} · beside the turn`, at: words.answer.at, text: words.answer.text, tone: 'orange' }, chatWidth(), colour) + '\n' : '';
          const sender = row.bot ? `${row.scheduled ? 'Schedule' : 'You'} → @${row.bot}` : requester(row);
          lines.push(chatMessage({ title: `${sender} (${words.tag})`, narrow: `${sender} (${words.short})`, at: row.createdAt, text: requestGoal(row), tone: 'blue', shaded: true }, chatWidth(), colour) + '\n' + (said ? '\n' : '') + said + more.map(text => note(text, 'muted')).join('\n'));
        }
      }
      const current = selectedRequest && (snapshot.queue ?? []).find(row => row.id === selectedRequest.id);
      if (current && ['queued', 'starting', 'running'].includes(current.state)) lines.push(chatMessage({ title: current.bot ? `${current.scheduled ? 'Schedule' : 'You'} → @${current.bot} (queued)` : `${current.scheduleId && !current.origin ? 'Schedule' : requester(current)} (queued)`, at: current.createdAt, text: requestGoal(current), tone: 'blue', shaded: true }, chatWidth(), colour) + '\n' + note(`${waitingText(current)} /stop cancels it.`, 'muted'));
      else if (selectedRequest) lines.push(chatMessage({ title: selectedRequest.bot ? `Saved request → @${selectedRequest.bot}` : selectedRequest.origin ? `Saved request from ${requester(selectedRequest)}` : 'Saved request', at: selectedRequest.createdAt, text: requestGoal(selectedRequest), tone: 'blue', shaded: true }, chatWidth(), colour) + '\n' + note([(current ?? selectedRequest).state === 'blocked' && (current ?? selectedRequest).reason, 'Send it to retry. /stop cancels it.'].filter(Boolean).join(' '), 'muted'));
      // Asked before the new text is set: lines that arrive below must not read as scrolling up.
      const chatNow = view === 'chat' ? `${controller?.repo.root ?? ''}\0${selectedId ?? selectedRequest?.id ?? following?.id ?? ''}` : view === 'tasks' ? `row\0${boardLines[barAt]?.row?.key ?? ''}` : null;
      const held = chatNow !== null && chatNow === chatShown && (sized ? !sized.end : scrolledUp(activity)), heldAt = () => sized?.place ?? partAt(activity, partsShown);
      chatShown = chatNow;
      // A session here is held by its parts, as one on another computer is: each entry by its
      // key, each line under them by its first row. Entries that leave the top or land above,
      // and a part that grows above, leave the lines he reads where they are.
      if (view === 'chat') {
        const seen = new Map(), parts = lines.map((text, index) => { const name = entryKeys[index] ?? `\0${text.split('\n')[0]}`, count = seen.get(name) ?? 0; seen.set(name, count + 1); return { key: `${name}\0${count}`, text }; });
        const place = held ? heldAt() : null;
        setChat(lines);
        if (place) keepPart(activity, place, parts);
        partsShown = parts;
      }
      // Sessions, on a row that is not a session: the row's own text, and how to start when there is nothing yet.
      else if (view === 'tasks') {
        // A session of another project shows once that project is the active one. Until then the pane is empty.
        const row = boardLines[barAt]?.row, card = row && row.kind !== 'remote' && !sessionOf(row) && rowCard(row, now);
        if (row?.kind === 'remote') {
          const parts = remoteApp.parts(row, chatWidth(), helperPane(row)), at = held ? heldAt() : null;
          // On the notes above its first message, the last of which counts the earlier messages,
          // when they load he stays with the oldest one he had: they land above it, a page up.
          const first = list => list.findIndex(part => !/^(?:runs|behind|earlier|task)\0/.test(part.key)), was = at ? first(at.parts) : -1;
          const landed = at && was > 0 && at.index < was && at.parts.slice(0, was).some(part => part.key.startsWith('earlier\0')) && parts[first(parts)]?.key !== at.parts[was].key;
          const place = landed ? { ...at, index: was, line: 0, wrapped: 0 } : at;
          setChat(parts.map(part => part.text));
          if (place) keepPart(activity, place, parts);
          partsShown = parts; olderOf = row;
        } else setChat([row && !card ? '' : card ? `${chatBlock({ title: card.title, text: blockText(card.text, { trusted: row.kind === 'peer' && row.item?.trusted === true }), tone: card.tone, width: chatWidth(), colour })}\n\n${ink(keyRows(card.keys, chatWidth()).join('\n'), 'muted', colour)}`
          : note(dash.projects.length ? 'Type below to start a session, or press n to set it up first.' : 'No project yet. Press n to create one here. n in the Projects tab opens another folder.', 'muted')]);
      }
      // The message box says where the text goes, and which bots are in the chat.
      const target = sessionBox() && goalTarget(), inChat = task ? botsOf(task) : form ? composeBots : [], withBots = inChat.length ? ` · with ${botNames(inChat)}` : '';
      // The model the text goes to: the open session's, else the one a new session starts with.
      // Text that starts with a saved bot's @name is written to that bot.
      const toModel = !controller ? null : task ? modelOf(task) : nameOf((form ? composeModel : !sessionBox() && selectedRequest?.model) || controller.defaultModel());
      // Over a session on another computer of mine, submit sends every message where
      // remoteApp.route says, so no bot's or teammate's @name labels the box: the same word can
      // be that computer's @name there and a name on my team.
      const toBot = !remoteHere() && (target || view === 'chat' && !claim.readOnly) && ask.getValue().trimStart().startsWith('@') ? botMessage(ask.getValue(), savedBots())?.bot.name ?? null : null;
      // A teammate's @name, when no bot has it, makes the text a question to them.
      // @name of another computer of mine first in the new session box starts the session there, before a teammate's @name.
      const machine = !toBot && !remoteHere() && (sessionBox() || composing()) && ask.getValue().trimStart().startsWith('@') && !TO_MODEL.test(ask.getValue().trimStart()) ? remoteApp.named(ask.getValue().trim().split(/\s+/)[0]) : null, toMachine = machine?.name ?? null;
      const person = !toBot && !toMachine && !remoteHere() && (sessionBox() || view === 'chat') && ask.getValue().trimStart().startsWith('@') ? teammateNamed(ask.getValue().trim().split(/\s+/)[0]) : null, toPerson = person?.name ?? null;
      // With no @name the text goes to the bot the owner last wrote to in this session; @model goes to the model.
      const stays = !toBot && !toPerson && task && view === 'chat' && !selectedRequest && !claim.readOnly && !TO_MODEL.test(ask.getValue().trimStart()) ? addressedBot(task, snapshot.queue ?? []) : null;
      // Beside the list the box is narrow: the label gives up its bots, then its last part, before it would wrap into the text.
      const fits = (...parts) => { for (let count = parts.length; count > 1; count--) { const text = ` ${parts.slice(0, count).join('')} `; if (widthOf(text) <= ask.width - 4) return text; } return ` ${parts[0]} `; };
      // The person open in Chats, when it is another computer of mine.
      const openMine = view === 'chats' && chatOpen?.type === 'member' ? remoteApp.yours().get(chatOpen.key) ?? null : null;
      // The box over a message to another computer of mine: whose it is, that it waits while it
      // has not marked this one back, then what Enter does (tail). A narrow box gives up the
      // tail first, and keeps that it waits before whose it is.
      // One that waits while offline says that: it cannot agree until it connects.
      const waitsOf = key => waitWords(onlineKeys(peerRead('peerStatus')).has(key));
      const toMine = (lead, mine, tail = '') => {
        const waits = mine.waiting ? waitsOf(mine.key) : '', forms = mine.waiting ? [`${lead} · your computer · ${waits}${tail}`, `${lead} · your computer · ${waits}`, `${lead} · ${waits}`] : [`${lead} · your computer${tail}`, `${lead} · your computer`];
        return ` ${forms.find(text => widthOf(text) + 2 <= ask.width - 4) ?? lead} `;
      };
      // A message that starts with ! is a shell command; the label says where it runs.
      // While a held reply is edited the box holds its text, whatever that starts with.
      const said = (view === 'chats' && heldEdit ? ` Edit the ${heldEdit.result ? 'result for' : 'reply to'} ${heldEdit.who} · Enter sends it · Esc leaves it held `
        : ask.getValue().trimStart().startsWith('!') ? ` Run in ${clip(shortHome(shellPlace().cwd), 40)} · Enter runs it `
        : view === 'chats' ? !chatOpen ? ' Ask your team, or @name one member ' : chatOpen.type === 'room' ? ` Message #${chatOpen.name} · the first ${takers(chatOpen)} to take it answers ` : chatOpen.type !== 'bot' ? openMine ? toMine(`Message ${peerName(chatOpen.name, chatOpen.key)}`, openMine) : ` Message ${peerName(chatOpen.name, chatOpen.key)} ` : chatOpen.peer ? ` Message @${chatOpen.name} on ${botHome(chatOpen)} · runs after ${peerName(chatOpen.owner, chatOpen.peer)} accepts it ` : ` Message @${chatOpen.name} · it answers in its own session `
        : toBot ? ` Message @${toBot} `
        : stays ? fits(`Message @${stays}`, ` · @model writes to ${toModel}`)
        // One that has not marked this machine back yet starts nothing: the box says it waits, as Enter then does.
        : toMachine ? fits(`New session on @${toMachine}`, remoteApp.yours().get(machine.key)?.waiting ? ` · ${waitsOf(machine.key)}` : ' · your other computer')
        // Another computer of mine is never a teammate.
        : toPerson ? person.mine ? toMine(`Ask @${toPerson}`, person, ' · Enter sends it there, the reply shows here') : ` Ask @${toPerson} · teammate `
        : remoteHere() ? remoteApp.label(remoteHere(), ask.width - 4, ask.getValue())
        : sessionBox() ? target ? toModel ? fits(`New session → ${toModel}`, ` · ${projectName(target)}`) : ` New session · ${projectName(target)} ` : ' New session · Enter creates a project first '
        : view === 'kanban' && sharedNow() ? sharedLabel(sharedNow(), ask.width - 4)
        : view === 'kanban' && !viewOnly() ? controller ? ` Add a task to To do · ${snapshot.name} ` : ' Create a project first: n in the Projects tab '
        // A Standup session: its model has every update, and @everyone asks the same sessions again.
        : task?.standup && view === 'chat' && !claim.readOnly ? fits(`Message ${toModel}`, ` · ${standupHas(task)}`, ' · @everyone asks them all again')
        : claim.readOnly ? viewOnlyLabel(ask.width - 4) : composing() ? composeWhen ? fits(`Schedule → ${toModel}`, ` · ${composeWhen.label}`, ` · ${snapshot.name}`, withBots) : fits(`New session → ${toModel}`, ` · ${snapshot.name}`, withBots) : mode ? fits(`Message ${toModel}`, ` · ${LABELS[mode]}`, withBots) : fits(`Message ${toModel}`, withBots));
      // The label is plain text, but for the bots it names: each in its own colour.
      const named = withBots && said.endsWith(`${withBots} `) ? said.length - withBots.length - 1 : said.length;
      ask.setLabel(blessed.escape(said.slice(0, named)) + (named < said.length ? ` · with ${paintBots(botNames(inChat))} ` : ''));
      const typing = screen.focused === ask;
      ask.style.border.fg = typing ? accent : shade('border'); ask.style.label.fg = typing ? accent : muted;
      // Status row: the last message, else what the open task is doing. The key bar below never hides it.
      const card = kanbanLists.includes(screen.focused) && kanbanData[kanbanLists.indexOf(screen.focused)]?.items[screen.focused.selected ?? 0];
      const quiet = card ? [card.title, card.note ?? card.detail].filter(Boolean).join('  ·  ') : task ? [task.state === 'needs_input' ? 'waiting for your answer' : stateWord(task), stopLine(task)?.action, snapshot.requests?.length ? `${snapshot.requests.length} saved` : ''].filter(Boolean).join(' · ') : '';
      // The last message shows whole: it wraps onto as many rows as it needs, which the pane above
      // gives up, to at most half of that pane. What the open session is doing wraps the same way.
      // A lead that waits for an allow or deny says so here first, with the keys before the
      // command so a narrow row still shows them. The last message goes below it.
      const asked = task ? approvalsFor(task)[0] : null;
      // A dialog over the status rows would hide what its own keys just said (a bot's page at
      // 80x24 hid "@name does not run by itself."): the message then shows right under the dialog.
      // With no message the rows stay where they are, behind it.
      if (modal) placeModal();
      const beside = sided ? barWidth(W) : 0, over = modal && message && modal.top <= g.statusTop && modal.top + modal.height > g.statusTop ? modal : null;
      Object.assign(status, over ? { left: over.left + 1, width: over.width - 2 } : { left: beside + 1, width: W - beside - 2 });
      // tail: what a refusal that cleared the box says after it (putBack).
      if (refused && message === refused.text + (refused.tail ?? '')) { refused.text = fitForm(refused.forms); message = refused.text + (refused.tail ?? ''); }
      // A row here stops a column short of the status: blessed wraps a coloured row that fills it
      // again, at its last space, and the end it cut off took the row of the message under it.
      const statusRoom = status.width - 1;
      // A key there is its letter, then Enter. Where the row would not fit, or would leave no room
      // for what is asked, it starts at the keys; with f or a it then says the same in fewer words,
      // and where even that is too long, with the letters alone, so the row still ends at Enter.
      const askForms = asked ? [`? Needs you · ${approvalKeys(task, asked)}, then Enter`, `? ${approvalKeys(task, asked)}, then Enter`, ...(offersFull(task, asked) || offersAlways(task, asked) ? [`? ${approvalKeys(task, asked)}, Enter`] : [])] : [''];
      const askLetters = asked ? `? ${approvalKeys(task, asked).split(' · ').map(part => part[0]).join(' · ')}, Enter` : '';
      const askKeys = askForms.find(form => status.width - form.length - 3 >= 12) ?? askForms.find(form => form.length <= statusRoom) ?? askLetters, askText = status.width - askKeys.length - 3 >= 12 && asked?.summary ? ` · ${asked.summary}` : '';
      // A Task that waits for approval says so here as an approval does: first, with the last
      // message under it. An approval of an action in the same session comes before it.
      const needs = asked ? clip(askKeys + askText, statusRoom) : task?.plan?.state === 'proposed' ? clip(taskNeedsYou(task.plan, status.width), statusRoom) : null;
      // A Kanban card under the cursor is named on one row: the board shows it, and Enter opens it whole.
      const words = message ? wrapText(message, statusRoom - 2) : needs !== null ? [] : card ? [clip(quiet, statusRoom)] : wrapText(quiet, statusRoom);
      const most = Math.max(2, Math.floor((g.statusTop - g.top) / 2) - (needs === null ? 0 : 1)), statusLines = words.length > most ? [...words.slice(0, most - 1), fitWords(words.slice(most - 1).join(' '), Math.max(8, statusRoom - 2))] : words;
      status.setContent([...(needs === null ? [] : [ink(needs, 'orange', colour, true)]), ...statusLines.map((row, at) => message ? ink(`${at ? '  ' : '› '}${row}`, 'text', colour) : ink(row, 'muted', colour))].join('\n'));
      status.said = [...(needs === null ? [] : [ink(needs, 'orange', colour, true)]), ...(message ? [ink(`› ${message}`, 'text', colour)] : needs !== null ? [] : [ink(words.join(' '), 'muted', colour)])].join('\n');
      const tall = Math.max(1, (needs === null ? 0 : 1) + statusLines.length);
      if (over) {
        // The dialog moves up, and then gets shorter, to leave these rows above the key bar.
        const free = () => g.keysTop - over.top - over.height;
        if (tall > free()) over.top = Math.max(0, over.top - (tall - free()));
        if (tall > free()) over.height = Math.max(8, g.keysTop - tall - over.top);
        Object.assign(status, { top: over.top + over.height, height: Math.max(1, Math.min(tall, free())) }); status.setFront();
      } else Object.assign(status, { top: g.statusTop - tall + 1, height: tall });
      // The rows it takes come from the pane above it, in every view: the others are laid out again.
      const lift = over ? 0 : tall - 1;
      activity.height = compose.height = g.statusTop - g.top - lift;
      if (lift !== lifted) { lifted = lift; again = true; }
      // Rows that only moved are drawn too: the frame below compares what the panels say, not where they are.
      const placed = [status.left, status.top, status.width, status.height, over?.top, over?.height].join();
      if (placed !== statusPlaced) { statusPlaced = placed; lastFrame = null; }
      drawSessionViews(task);
      keysBar.setContent(keyHints(withThreadsPage(barPairs()), W - 2, colour));
      for (const list of [board, composeList, ...teamLists, botsList, projectsList, usageList]) Object.assign(list.style.selected, screen.focused === list ? selection : QUIET);
      for (const [panel, owner] of [[boardBox, board], [activity, activity], [botsBox, botsList], [projectsBox, projectsList], [usageBox, usageList]]) panel.style.border.fg = screen.focused === owner ? accent : shade('border');
      if (chatNow === null ? screen.focused !== activity : !held) activity.setScrollPerc(100);
      // The first line of a session on another computer is in view: its earlier messages load.
      if (olderOf && (activity.childBase ?? 0) === 0) remoteApp.older(olderOf);
      olderOf = null;
      if (modal) modal.setFront();
      syncPalette();
      const next = frame(); if (!again && (idle !== true || next !== lastFrame)) { lastFrame = next; screen.render(); }
      // view names the tab: Sessions is 'tasks' whatever shows beside its list, and 'chat' is a session opened from Kanban.
      // session is what shows as a chat: a session's number, 'new' for the form, 'request' for a message not started yet.
      onRender?.({ screen, selection: mouseSelection, snapshot, panels: { header, brand, pills, tabs, newCard, kanbanPick, newBot, newProject, kanbanBoxes, kanbanLists, kanbanOff, kanbanTeam, back, board, boardBox, compose, composeList, composeHint, activity, chat: activity, changes: changesBox, sessionTabs, status, keys: keysBar, palette, ask, teamBoxes, teamLists, teamOff, botsBox, botsList, projectsBox, projectsList, usageBox, usageList }, controller, view: listed() ? 'tasks' : view, session: view !== 'chat' ? null : selectedId ?? (composing() ? 'new' : 'request'), sessionView: changesBox.hidden ? 'chat' : 'changes' });
    } catch (error) { header.setContent(displayText(clip(error.message, screen.width))); screen.render(); }
    finally { drawing = false; if (!again) sized = null; }
    if (again) resize();
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
    // After this machine's projects: those of my other computers that Sessions does not show, as "<project> on <name>",
    // then those a teammate shares that this computer does not have.
    const away = remoteApp.projects(now, top);
    projectRows = [...[...snapshot.projects].sort((a, b) => (b.root === top) - (a.root === top)), ...away, ...sharedRows(away)];
    const lastActivity = project => {
      const times = [...project.activity.map(row => row.at), ...project.tasks.map(task => task.createdAt)].map(value => Date.parse(value)).filter(Number.isFinite);
      return times.length ? relativeTime(new Date(Math.max(...times)).toISOString(), now) : 'no activity';
    };
    const lines = projectRows.length ? projectRows.map(project => {
      // ● marks the active project: the one in the header, which new sessions and Kanban use.
      // Another computer's project is listed only for its sessions that are not part of this one, and says so.
      if (project.remote) {
        // The tail fits in what the name and the online state leave: shorter when it must, then cut.
        const n = project.sessions, ago = project.last ? relativeTime(project.last, now) : 'no activity', fits = width - 38 - 'offline'.length - 2;
        const tail = [`${n} session${n === 1 ? '' : 's'} not in this project  ${ago}`, `${n} not in this project  ${ago}`, `${n} not in this project`].find(text => text.length <= fits) ?? clip(`${n} not in this project`, Math.max(0, fits)), room = Math.max(4, width - 38 - tail.length - 2);
        return ink(`  ${padEnd(clip(project.name, 34), 36)}`, 'violet', colour, true) + ink(clip(project.online ? 'online' : 'offline', room).padEnd(room + 2), 'muted', colour) + ink(tail, 'muted', colour);
      }
      // A project a teammate shares: its name, who shares it and where it is. It is not on this computer.
      if (project.shared) {
        const tail = project.online ? 'online' : 'offline', room = Math.max(4, width - 26 - tail.length - 2);
        return ink(`  ${padEnd(clip(project.name, 22), 24)}`, 'blue', colour, true) + ink(padEnd(clip(`${project.by}   on ${project.box}`, room), room + 2), 'muted', colour) + ink(tail, 'muted', colour);
      }
      const active = project.root === controller?.repo.root, name = ink(`${active ? '●' : ' '} ${padEnd(clip(project.name, 22), 24)}`, active ? 'orange' : 'text', colour, true);
      if (project.unavailable) return name + ink('unavailable', 'muted', colour);
      const sessions = project.tasks.filter(task => !project.closed?.includes(task.id)).length, tail = `${sessions} session${sessions === 1 ? '' : 's'}`.padEnd(13) + lastActivity(project);
      const room = Math.max(4, width - 26 - tail.length - 2);
      return name + ink(padEnd(clip(shortHome(project.root), room), room + 2), 'muted', colour) + ink(tail, 'muted', colour);
    }) : [ink(' No projects yet. n creates one.', 'muted', colour)];
    if (lines.join('\n') !== projectsList.ritems?.join('\n')) projectsList.setItems(lines);
    const found = kept === undefined ? -1 : projectRows.findIndex(project => project.root === kept);
    projectsList.select(found >= 0 ? found : Math.max(0, Math.min(projectsList.selected ?? 0, projectRows.length - 1)));
  }
  // Usage: one block per vendor, then the top agents by cost and today's spend. The data is
  // read again when the saved usage changes or a check finishes; the selected row keeps its place.
  const usageReaders = () => ({ env: usage.env, readFile: usage.readFile });
  // What a vendor's sign-in read and its check run with: usage.env stands in for the owner's home in a test.
  const usageEnvironment = () => usage.env ? { ...process.env, ...usage.env } : process.env;
  // Reading the vendors starts their programs: each one's release, and the sign-in of Claude
  // Code, Codex and a checked Antigravity CLI, which one that says nothing holds for half a
  // minute. So no draw ever waits for it. usageVendors() gives the last reading at once (null
  // before the first) and starts one when that is no longer true; readVendors() waits for one,
  // and never fails. The screen draws and takes keys all the while, and draws again when a
  // reading ends. usage.vendors stands in for the reading in a test, kept apart from /model's.
  const usageReading = usage.vendors ? vendorReading() : null, vendorsHere = () => usageReading ?? vendorList;
  let vendorsShown = null, vendorsWait = null, vendorsFailed = false;
  const forgetVendors = () => { vendorList.forget(); usageReading?.forget(); vendorsFailed = false; };
  function readVendors() {
    const reading = vendorsHere(), kept = reading.kept();
    if (kept) return Promise.resolve(vendorsShown = kept);
    let value; try { value = reading.read(usage.vendors ?? (() => detect(controller?.repo.root ?? startDirectory))); } catch { value = []; }
    if (typeof value?.then !== 'function') return Promise.resolve(vendorsShown = value);
    if (vendorsWait?.of === value) return vendorsWait.rows;
    const rows = Promise.resolve(value).then(found => ({ found }), () => ({ found: [], failed: true })).then(({ found, failed = false }) => {
      // A reading forgotten while it ran is not shown: the one started after it is.
      if (vendorsWait?.of !== value) return found;
      // One that failed is not started again by a draw: r reads again.
      vendorsWait = null; vendorsShown = found; vendorsFailed = failed; usageData = null;
      if (!closing && view === 'usage') draw();
      return found;
    });
    vendorsWait = { of: value, rows };
    return rows;
  }
  const usageVendors = () => { const kept = vendorsHere().kept(); if (kept) return vendorsShown = kept; if (!vendorsFailed) readVendors(); return vendorsShown; };
  const READING_VENDORS = 'Reading what is installed and signed in here…';
  function drawUsage(now) {
    const key = JSON.stringify(snapshot.usage) + accountsStamp();
    if (!usageData || key !== usageKey) {
      const vendors = usageVendors();
      if (vendors) { usageKey = key; usageData = usageTab({ vendors: withCheck(vendors, { env: usageEnvironment() }), env: usage.env, readFile: usage.readFile, now, browser: hasBrowser(process.env, usage.platform ?? process.platform) }); }
    }
    const at = usageList.selected ?? 0, width = Math.max(20, usageList.width - 2), kept = usageRows[at];
    const today = agentSpend(snapshot.projects, { now, days: 1 }), spend = usagePeriod === 1 ? today : agentSpend(snapshot.projects, { now, days: usagePeriod });
    usageRows = [...(usageData ? usageBlocks(usageData, { now: new Date(now), checks: usageChecks, reading: usageBusy }) : [{ vendor: null, text: READING_VENDORS, tone: 'muted' }]), ...topAgentRows(spend, today, width, now)];
    const lines = usageRows.map(row => ink(clip(row.text, width), row.tone, colour, row.bold));
    if (lines.join('\n') !== usageList.ritems?.join('\n')) usageList.setItems(lines);
    // The selected line stays: the same agent; else the same line of the same account, else that
    // account's first, else the vendor's.
    const same = row => row.vendor === kept.vendor && row.login === kept.login;
    const found = !kept ? -1 : kept.key ? usageRows.findIndex(row => row.key === kept.key) : !kept.vendor ? -1 : usageRows[at] && same(usageRows[at]) ? at : [same, row => row.vendor === kept.vendor].map(test => usageRows.findIndex(test)).find(index => index >= 0) ?? -1;
    usageList.select(found >= 0 ? found : Math.max(0, Math.min(at, usageRows.length - 1)));
  }
  // Top agents: up to ten, most cost first, from this computer and each computer of mine that
  // is online and sends them (marked on <name>); one on an older build gets one line instead.
  // An agent that did not start is always among them (topRows). A computer on a build before
  // 0.1.20 counts a session's total again for each turn: a line under the table says its costs
  // may be too high, and its part of the spend line is marked.
  // A row's share is of what every computer shown spent in the period. A cost that is a lower
  // bound names what reported none, and a line under the table says why. Last, the spend line:
  // what every computer shown spent today, each one's part when there are several, which
  // computer it still waits for, and which is offline and not counted.
  function topAgentRows(spend, today, width, now) {
    const rows = spend.rows.map(row => ({ ...row, where: '', open: { root: row.root, id: row.taskId } })), notes = [], parts = [{ name: 'this computer', spend: today }], waiting = [], offline = [];
    let total = spend.costUsd ?? 0, peers = [];
    try { peers = remoteApp.agents(now); } catch { peers = []; }
    for (const { machine, top, listed, offline: away } of peers) {
      if (away) { offline.push(machine.name); continue; }
      if (!top) { if (listed) notes.push(`${machine.name}: update ELU to include it`); else waiting.push(machine.name); continue; }
      const period = usagePeriod === 1 ? top.today : top.week;
      total += period.costUsd ?? 0;
      // own is false only for a list a build before 0.1.20 sent; one saved before this build read that word says nothing yet.
      const old = top.own === false; if (old) notes.push(OLD_COUNT(machine.name));
      parts.push({ name: machine.name, spend: top.today, ...(old ? { old: true } : {}) });
      for (const row of period.rows) rows.push({ ...row, where: `on ${machine.name}`, open: { machine: machine.key, project: row.ref.split(':')[0], id: row.id } });
    }
    const top = topRows(rows), out = [{ vendor: null, text: '' }, { vendor: null, text: usagePeriod === 1 ? 'Top agents today' : 'Top agents, last 7 days', tone: 'text', bold: true }];
    if (!top.length) out.push({ vendor: null, text: usagePeriod === 1 ? 'No agent has run today.' : 'No agent has run in the last 7 days.', tone: 'muted', none: true });
    else {
      const [head, ...lines] = agentTable(top, { width, total });
      out.push({ vendor: null, text: head, tone: 'muted' }, ...lines.map((text, at) => ({ vendor: null, text, tone: 'text', agent: top[at], key: `agent:${top[at].open.machine ?? top[at].open.root}\0${top[at].open.id ?? top[at].ref}\0${top[at].agent}` })));
      const why = [...new Set(top.flatMap(row => row.unpriced ?? []))].filter(vendor => Object.hasOwn(UNPRICED, vendor));
      out.push(...why.map(vendor => ({ vendor: null, text: `+ ${vendorShort(vendor).toLowerCase()}: ${UNPRICED[vendor]}`, tone: 'muted' })));
    }
    out.push(...notes.map(text => ({ vendor: null, text, tone: 'muted' })));
    // A spend line wider than the pane goes on two: the total, then each computer's.
    const spent = spendLine(parts, waiting, offline), cut = spent.indexOf(': ');
    if (widthOf(spent) > width && cut > 0) out.push({ vendor: null, text: spent.slice(0, cut), tone: 'muted' }, { vendor: null, text: `  ${spent.slice(cut + 2)}`, tone: 'muted' });
    else out.push({ vendor: null, text: spent, tone: 'muted' });
    return out;
  }
  // Enter on an agent's row opens its session: one here as Sessions opens it, one on a computer
  // of mine under that computer's heading in Sessions.
  async function openAgent(row) {
    if (row.open.machine) {
      if (!row.open.id) throw new Error('That session cannot be opened from here.');
      barKey = remoteApp.openSession(row.open.machine, row.open.project, row.open.id, row.ref ?? null, controller?.repo.root); wanted = null;
      showView('tasks');
      setImmediate(() => { if (!modal && !closing && view === 'tasks') { board.focus(); draw(); } }); return;
    }
    if (!snapshot.projects.some(project => project.root === row.open.root)) throw new Error('That project is no longer in Projects.');
    return openRow({ kind: 'task', root: row.open.root, id: row.open.id, key: `${row.open.root}\0task\0${row.open.id}` });
  }
  // The tab's check: when it opens and the last one is older than two minutes, or on r. It
  // also reads the sign-in of a vendor still waiting for its one-time check: on r and when
  // that check is due, every such vendor's, and otherwise the one never read for its program.
  let usageOpening = false;
  async function refreshUsageTab(force = false) {
    if (usageBusy || usageOpening || closing) return;
    if (force) setMessage('Checking usage…');
    usageOpening = true; let vendors = []; try { vendors = await readVendors(); } finally { usageOpening = false; }
    if (usageBusy || closing) return;
    const due = force || usageStale();
    if (!due && !signInsUnread(vendors)) return;
    usageBusy = true; setMessage('Checking usage…');
    try {
      await refreshUsage({ force, ...usageReaders(), signal: usageAbort.signal });
      await readSignInsBeforeCheck(vendors, { env: usageEnvironment(), signal: usageAbort.signal, all: due });
      usageData = null;
      if (!closing) setMessage(`Usage updated ${clockTime(Date.now())}`);
    } finally { usageBusy = false; usageData = null; draw(); }
  }
  // Enter on an account's lines makes new turns of that vendor use it, on an agent's line opens
  // its session, and on any other line of a vendor opens the vendor's details, as d does on
  // every line of a vendor; a adds an account, x forgets one, r checks again now.
  async function usageAction(action) {
    // r reads every vendor again: detect()'s reading of them too, and a finished check's lines go.
    if (action === 'refresh') { forgetVendors(); for (const [vendor, run] of usageChecks) if (!run.running) usageChecks.delete(vendor); return refreshUsageTab(true); }
    const line = usageRows[usageList.selected ?? 0];
    if (line?.agent) return action === 'open' ? openAgent(line.agent) : undefined;
    const vendor = line?.vendor, row = usageData?.find(item => item.vendor === vendor);
    if (!row) return;
    if (action === 'add') return addAccount(vendor);
    if (action === 'check') return checkHere(row);
    if (action === 'signin') return signInVendor(row);
    if (action === 'forget') return forgetLine(row, line);
    if (action === 'open' && line.login) return useAccount(row, line.login);
    await prompt(`${USAGE_NAMES[vendor]} usage`, usageDetailLines(row, new Date()).join('\n'));
  }
  // c: a vendor's one-time check, here, as a first message to it below Full access would run
  // it: the same check, its lines under the vendor as it goes, then ready or why not. It goes
  // on if the tab closes.
  // A vendor that is not signed in for ELU stops before its first step, at once: the check offers
  // the vendor's sign-in (s does the same), and goes on when it finished.
  async function checkHere(row, { signedInHere = false } = {}) {
    const name = VENDOR_NAMES[row.vendor];
    if (!row.check) return setMessage(row.installed ? `${name} needs no check.` : `${name} is not installed.`);
    if (usageChecks.get(row.vendor)?.running) return setMessage(`${name} is being checked.`);
    // He said no to what it would run here: c forgets that, so his next message to it asks again.
    if (row.check === 'ready' && row.asks) { askLoadsAgain(row.vendor); forgetVendors(); usageData = null; await refreshUsageTab(true); return setMessage(`${name} asks you again on your next message to it.`); }
    if (row.check === 'ready') return setMessage(`${name} passed its check on this machine.`);
    const run = { running: true, lines: [], current: null, error: null };
    usageChecks.set(row.vendor, run); setMessage(`Checking ${name}…`); draw();
    let passed = false, signedOut = false;
    try {
      const found = (await readVendors()).find(item => item.vendor === row.vendor);
      // A folder of its own for the release and sign-in it asks first, never a project.
      passed = await checkOnFirstUse(found, { cwd: os.homedir(), environment: usageEnvironment(), signal: usageAbort.signal, force: true, say: (text, { keep = false } = {}) => { if (keep) { run.lines.push(text); run.current = null; } else run.current = text; if (!closing) draw(); } });
      if (!passed) run.error = `${name} needs no check now.`;
    } catch (error) { run.error = error.message; run.cause = error.details?.cause ?? null; signedOut = run.cause === 'signin' && error.details.signedIn === false; }
    finally {
      // The vendors are read again before the line says where it stands: with the check's record.
      run.current = null; forgetVendors(); if (!closing) await readVendors();
      run.running = false; usageData = null;
      if (!closing) { setMessage(passed ? `${name} is ready.` : run.error.split(/(?<=\.) /)[0]); draw(); }
    }
    if (!signedOut || closing || signedInHere || !ADAPTERS[row.vendor]?.signInTerminal) return;
    if (!await yesKey(`Sign in to ${name}`, `${vendorWithCommand(row.vendor)} is not signed in for ELU, so its check cannot run.\nSign in now? Its own sign-in runs here on a clean screen, and the check goes on after it.`)) return setMessage(`${vendorWithCommand(row.vendor)} is not signed in for ELU. s signs it in.`);
    if (await signInVendor(row)) return checkHere(usageData?.find(item => item.vendor === row.vendor) ?? row, { signedInHere: true });
  }
  // The words ELU writes at the top of a vendor's sign-in screen, under which the vendor prints
  // its own: one screen and one wording for all four, whether s signs the vendor in or a adds an
  // account (account). Each line fits 80 columns: the terminal would break a longer one inside
  // a word. With no browser here the second line says what the link the vendor prints is for.
  // A device code sign-in (Codex, Grok Build) ends on that page, with the code printed under the
  // link. Claude Code and Antigravity CLI take a code that page shows, pasted here; Claude Code
  // 2.1.322 reads it without showing it.
  const NO_BROWSER = Object.freeze({ device: 'No browser here: open the link below on any computer and use the code under it.', paste: 'No browser here: open the link below on any computer, then paste its code here.' });
  function signInLines(vendor, { account = false } = {}) {
    const name = VENDOR_NAMES[vendor], browser = hasBrowser(process.env, usage.platform ?? process.platform);
    const first = account ? `Signing in a new ${name} account. ELU comes back when it ends.` : `Signing in to ${name}${vendor === 'agy' ? ' for ELU' : ''}. ELU comes back when it ends.`;
    if (vendor === 'agy') return [first, ...(browser
      ? ['Your browser opens Google sign-in. Sign in there and copy the code it shows,', `then paste it here and press Enter. It waits ${ADAPTERS.agy.SIGN_IN_WAIT_SECONDS} seconds for the code.`]
      : [NO_BROWSER.paste, `Press Enter after it. It waits ${ADAPTERS.agy.SIGN_IN_WAIT_SECONDS} seconds for the code.`])];
    if (browser) return [first];
    return DEVICE_SIGN_IN_COMMAND[vendor] ? [first, NO_BROWSER.device] : [first, NO_BROWSER.paste, 'Nothing shows as you paste. Press Enter after the code.'];
  }
  // A sign-in that ends by itself when no code came in time: Antigravity CLI's, after its 60
  // seconds. Its screen says so before, and what s does then; a sign-in that ran that long and
  // left it signed out says the time ran out. usage.signInWait is how long that is in a test.
  const signInWait = vendor => ADAPTERS[vendor]?.SIGN_IN_WAIT_SECONDS ?? null;
  const signInWaitLines = vendor => { const wait = signInWait(vendor); return wait ? [`If the ${wait} seconds pass, it stops. Press s again for a new link and a new code.`] : []; };
  // s: Antigravity CLI's and Grok Build's own sign-in, for the HOME ELU runs them under, in
  // this terminal on a clean screen as a adds a Claude Code or Codex account (signInHere):
  // the owner opens the link and pastes the code there. Then the sign-in is read again, as the
  // tab reads it, and the line says where it stands. True when it is signed in.
  let signingIn = false;
  async function signInVendor(row) {
    const name = VENDOR_NAMES[row.vendor], adapter = ADAPTERS[row.vendor];
    if (!adapter?.signInTerminal) return setMessage(LOGIN_VENDORS.includes(row.vendor) ? `a adds a ${name} account.` : `${name} signs in on its own.`), false;
    if (!row.installed) return setMessage(`${name} is not installed.`), false;
    if (signingIn || usageChecks.get(row.vendor)?.running) return setMessage(`${name} is busy. Try again when it is done.`), false;
    signingIn = true;
    try {
      const found = (await readVendors()).find(item => item.vendor === row.vendor);
      if (!found?.bin) return setMessage(`${name} is not installed.`), false;
      const command = adapter.signInTerminal({ env: usageEnvironment(), browser: hasBrowser(process.env, usage.platform ?? process.platform) });
      setMessage(`Signing in to ${name}…`);
      const wait = signInWait(row.vendor), began = Date.now();
      try { await (usage.signIn ?? signInHere)({ vendor: row.vendor, bin: found.bin, args: command.args, env: command.env, lines: [...signInLines(row.vendor), ...signInWaitLines(row.vendor)] }); } catch { /* What the sign-in left decides. */ }
      const ranOut = wait !== null && Date.now() - began >= (usage.signInWait ?? wait) * 1000;
      if (closing) return false;
      setMessage(`Reading ${name}'s sign-in…`); usageBusy = true; draw();
      let read = null;
      try { read = await readSignInNow(found, { env: usageEnvironment(), signal: usageAbort.signal }); forgetVendors(); if (!closing) await readVendors(); } finally { usageBusy = false; }
      usageData = null;
      const done = read?.signedIn === true;
      // A check c stopped for the sign-in says so under the line until now: it is signed in.
      if (done && usageChecks.get(row.vendor)?.cause === 'signin') usageChecks.delete(row.vendor);
      if (!closing) { setMessage(done ? `${name} is signed in for ELU.` : read?.signedIn === false ? (ranOut ? `${name} got no code in ${wait} seconds. s starts again with a new link.` : `${name}'s sign-in did not finish. s tries again.`) : `${name} did not say if it is signed in. r reads it again.`); draw(); }
      return done;
    } finally { signingIn = false; }
  }
  function useAccount(row, login) {
    const item = row.accounts?.find(account => account.login === login), name = VENDOR_NAMES[row.vendor];
    if (!item?.account) return setMessage(`That account is not signed in. a adds an account to ${name}.`);
    if (item.active) return setMessage(`New ${name} turns already use ${item.account}.`);
    useLogin(row.vendor, login); forgetVendors(); usageData = null;
    // A turn already running keeps its account; the status line has room for one sentence.
    setMessage(`New ${name} turns use ${item.account}.`);
    draw();
  }
  // The vendor's own sign-in, in this terminal, on a clean screen with ELU's lines at its top,
  // and ELU drawn again in full when it ends. blessed's screen.spawn is not used: it holds the
  // way out of ELU's screen until the next tick and silences the output before that tick, so
  // the sign-in drew over ELU. Here what blessed holds is written first; while the sign-in
  // runs, whatever ELU draws goes nowhere. usage.signIn stands in for all of it in a test,
  // usage.spawn for the program only.
  // Ctrl-C (or Ctrl-\) there reaches the sign-in and ELU alike, as the terminal sends it to
  // both: it ends the sign-in, and ELU, which keeps running, comes back.
  const SIGN_IN_SIGNALS = ['SIGINT', 'SIGQUIT'];
  function signInHere({ bin, args, env, lines = [] }) {
    return new Promise(resolve => {
      const program = screen.program, output = program.output, write = output.write, mouse = program.mouseEnabled, input = program.input;
      let done = false;
      const stay = () => {};
      for (const signal of SIGN_IN_SIGNALS) process.on(signal, stay);
      const back = code => {
        if (done) return; done = true;
        for (const signal of SIGN_IN_SIGNALS) process.off(signal, stay);
        program.flush(); output.write = write;
        input.setRawMode?.(true); input.resume();
        program.alternateBuffer(); program._write('\x1b[?2004h');
        if (mouse) { program.enableMouse(); if (screen.options.sendFocus) program.setMouse({ sendFocus: true }, true); }
        screen.alloc(); screen.render(); program.lrestoreCursor('spawn', true); program.flush();
        resolve(code);
      };
      program.lsaveCursor('spawn');
      if (mouse) program.disableMouse();
      program.normalBuffer(); program.showCursor();
      // Paste marks off: the code the owner pastes reaches the sign-in as typed.
      program._write(`\x1b[?2004l\x1b[H\x1b[2J${lines.map(text => `${text}\r\n`).join('')}\r\n`);
      program.flush();
      output.write = () => true;
      input.pause(); input.setRawMode?.(false);
      let child;
      try { child = (usage.spawn ?? spawn)(bin, args, { env, cwd: os.homedir(), stdio: 'inherit' }); } catch { back(null); return; }
      child.once('error', () => back(null)); child.once('exit', code => back(code));
    });
  }
  // A new account, signed in by the vendor's own sign-in into a folder of its own; every
  // other account stays signed in. One that is already here, or a sign-in that did not finish,
  // leaves nothing behind.
  async function addAccount(vendor) {
    const name = VENDOR_NAMES[vendor];
    if (!LOGIN_VENDORS.includes(vendor)) return setMessage('Accounts are added for Claude Code and Codex.');
    const bin = findBin(vendor);
    if (!bin) return setMessage(`${name} is not installed.`);
    const before = listLogins(vendor).map(login => accountOf(vendor, login, usageReaders())?.email).filter(Boolean);
    const platform = usage.platform ?? process.platform, slot = newLogin(vendor, process.env, { platform }), env = { ...process.env, [LOGIN_ENV[vendor]]: slot.dir };
    delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    setMessage(`Signing in to another ${name} account…`);
    // With no browser here, the vendor's device code sign-in where it has one; otherwise the
    // sign-in prints a link for a computer that has one and waits for the code pasted here.
    const device = !hasBrowser(process.env, platform) && DEVICE_SIGN_IN[vendor];
    try { await (usage.signIn ?? signInHere)({ vendor, bin, args: [...(device || SIGN_IN[vendor])], env, lines: signInLines(vendor, { account: true }) }); } catch { /* What the sign-in left decides. */ }
    const account = accountOf(vendor, slot.id);
    try {
      if (!account) { removeLogin(vendor, slot.id, { platform }); return setMessage(`No account was added: the ${name} sign-in did not finish.`); }
      if (before.includes(account.email)) { removeLogin(vendor, slot.id, { platform }); return setMessage(`${account.email} is already signed in here.`); }
      finishLogin(vendor, slot.id); recordAccount(vendor, account.email, account.plan, null);
      setMessage(`Added ${account.email}. Enter on it uses it.`);
    } finally { usageData = null; draw(); }
  }
  // x forgets an account ELU added, after a y/N: ELU's copy of its sign-in goes, and it is not
  // signed out anywhere. The owner's own sign-in is the vendor's, and is never forgotten here.
  async function forgetLine(row, line) {
    const item = row.accounts?.find(account => account.login === line.login), name = VENDOR_NAMES[row.vendor];
    if (!item) return setMessage('Select an account to forget.');
    if (item.login === DEFAULT_LOGIN) return setMessage(`${item.account ?? 'That'} is your own sign-in: ELU keeps no copy to forget.`);
    const shown = item.account ?? 'this account';
    if (!await yes(`Forget ${shown}`, `ELU forgets its copy of the ${name} sign-in for ${shown}. It is not signed out.${item.active ? `\nNew ${name} turns go back to your own sign-in.` : ''}`, 'y/N')) return;
    const forgot = forgetAccount(row.vendor, item.login, { ...usageReaders(), platform: usage.platform ?? process.platform });
    if (item.active) forgetVendors();
    usageData = null; setMessage(`Forgot ${shown}.`); draw();
    // A locked Keychain kept the item: its name is longer than the status line has room for.
    if (forgot?.keychainLeft) await prompt(`Forgot ${shown}`, `The Keychain kept its sign-in. Delete "${forgot.keychainLeft}" in Keychain Access.`);
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
    // An edit of a held reply or result that may hold a secret (editHeld): the status tells
    // to take it out only while the text in the box holds one, by the daemon's own scan.
    if (heldEdit?.secret != null && value !== heldEdit.scanned) {
      const secret = scanSecrets(value).length > 0; heldEdit.scanned = value;
      if (secret !== heldEdit.secret) { heldEdit.secret = secret; message = secret ? `Take out the possible secret. Enter sends it to ${heldEdit.who}, Esc leaves it held.` : `Enter sends it to ${heldEdit.who}. Esc leaves it held.`; if (!drawing) scheduleDraw(); }
    }
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
    const values = screen.focused === ask && !modal && value !== paletteDismissed && !heldEdit ? [
      ...commandMatches(value).map(command => ({ value: `/${command.name}`, label: `/${command.name}`, description: command.description, more: needsArgument(command), usage: command.usage })),
      ...argumentMatches(value, paletteContext).map(row => ({ ...row, label: row.word })),
      // Over a session on another computer every word goes to that session, so @ offers only the name that does not.
      ...(view === 'chats' ? mentionMatches(value, paletteContext) : remoteHere() ? hereMention(remoteHere(), value) : sessionBox() || view === 'chat' ? sessionMentions(value, paletteContext) : []).map(row => ({ ...row, label: row.word })),
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
      palette.setItems(values.map(row => clip(`${padEnd(row.label, 14)} ${row.description}`, palette.width - 4)));
      palette.items.forEach((item, index) => {
        item.removeAllListeners('click');
        item.on('click', () => catchAction(() => { if (values[index].more) choosePalette(values[index]); else return submit(values[index].value); }));
      });
      palette.select(Math.min(selected, values.length - 1)); palette.setFront();
    }
    // The key bar changes when a message is brought back into the box, walked, changed or cleared.
    const walk = recallKeys().join();
    if (walk !== recallShown) { recallShown = walk; if (!drawing) scheduleDraw(); }
  }
  // Fills in a row that needs more words and shows what can come next.
  function choosePalette(row) {
    focusInput(); ask.setValue(`${row.value} `); syncPalette();
    if (row.usage) setMessage(`Usage: ${row.usage}`);
    // A time for /schedule: the message comes next, and what each run gets is said before it is saved.
    else if (row.value.startsWith('/schedule ') && controller) setMessage(`Write the message after the time. ${scheduleRuns()}`);
    draw();
  }
  // What the command list suggests after a command name. Vendor checks start programs, so one
  // list serves the session: /model add reads the copy. A vendor's one-time check that ran
  // since then changed what the list says, so it is read again.
  const vendorList = vendorReading();
  const cachedVendors = async () => { if (!controller) return []; return vendorList.kept() ?? vendorList.read(() => controller.vendors()); };
  // The open session, and the bots in it; in the new session form, the ones it will start with.
  const openTask = () => controller && view === 'chat' && selectedId && !selectedRequest ? controller.snapshot().tasks.find(row => row.id === selectedId) ?? null : null;
  const chatBotsNow = () => { if (view !== 'chat') return []; if (composing()) return composeBots; const task = openTask(); return task ? botsOf(task) : []; };
  // The model in view: the open session's, else the one a new session starts with.
  const modelNow = () => { if (!controller) return null; const task = openTask(); return (task ? sessionModel(controller.repo, task) : composing() ? composeModel : null) ?? controller.defaultModel(); };
  const paletteContext = {
    // The open session's model, as @model reaches it; null where no session is open.
    model: () => { const task = view === 'chat' && controller && selectedId && !selectedRequest ? (snapshot?.tasks ?? []).find(row => row.id === selectedId) : null; return task ? modelOf(task) : null; },
    // The models a session can be given, with a mark on the one in use. Each vendor's own
    // list is read beside the app, never held for it: the names known now show at once, and
    // the list is drawn again when a vendor has printed its own.
    models: () => { readAllModels().then(fresh => { if (fresh && !closing) { syncPalette(); draw(); } }, () => {}); const choices = modelChoices(), now = modelNow(), current = now ? choiceName(now, choices) : null; return choices.map(row => ({ name: row.name, vendor: row.vendor, note: row.note, current: row.name === current })); },
    servers: () => { if (controller) return controller.servers(); const all = Object.keys(claudeServers(null)); return { all, on: all }; },
    bots: () => { const here = chatBotsNow(); return savedBots().map(bot => ({ name: bot.name, about: bot.about, here: here.includes(bot.name), scheduled: Boolean(bot.schedule), color: botColor(bot) })); },
    teammates: () => {
      const status = peerRead('peerStatus'), members = new Map();
      // Another computer of mine is listed under the name Sessions calls it; team is its name on the team, which also names it when typed.
      const mine = remoteApp.yours();
      for (const member of (status?.teams ?? []).flatMap(row => row?.members ?? [])) {
        if (!member?.key || member.key === status.key) continue;
        const own = mine.get(member.key), name = own ? own.name : member.name;
        if (/^[^\s@/\\]{1,64}$/.test(name ?? '')) members.set(member.key, { key: member.key, name, online: Boolean(member.online), path: remote(member.path, 10), ...(own ? { mine: true, waiting: own.waiting, team: member.name } : {}) });
      }
      return [...members.values()];
    },
    // The teammates /invite can add to the open channel, by the name the screen shows them under.
    invitees: () => { const room = openChannel(), mine = remoteApp.yours(); return room ? { channel: room.name, people: outsiders(room).map(member => ({ name: peerName(member.name, member.key).slice(1), online: Boolean(member.online), ...(mine.has(member.key) ? { mine: true, waiting: mine.get(member.key).waiting } : {}) })) } : null; },
  };
  // The teammate a leading @name means: the exact name first, then the same letters in any
  // case. Another computer of mine also answers to its name on the team, after everyone's shown name.
  const teammateNamed = word => {
    if (!/^@[^\s@]+$/.test(word ?? '')) return null;
    const name = word.slice(1), rows = paletteContext.teammates(), same = (value, exact) => typeof value === 'string' && (exact ? value === name : value.toLowerCase() === name.toLowerCase());
    return rows.find(row => same(row.name, true)) ?? rows.find(row => same(row.name, false)) ?? rows.find(row => same(row.team, true)) ?? rows.find(row => same(row.team, false)) ?? null;
  };
  function showView(next) {
    if (!['tasks', 'projects', 'kanban', 'chats', 'bots', 'usage', 'chat'].includes(next)) throw new Error('Choose Sessions, Projects, Kanban, Chats, Bots, or Usage.');
    if (next === 'chat' && !controller) throw new Error(NO_PROJECT);
    rememberDraft(); view = next; message = ''; ask.clearValue(); heldEdit = null;
    if (next !== 'chat') selectedRequest = null;
    // Sessions shows its cursor's row again. A row of a project that is no longer the active one gives way to + New session.
    // One on another computer of mine stays: it belongs to no project here.
    if (next === 'tasks') { returnTo = 'tasks'; openKey = null; if (controller && barKey !== NEW && !barKey.startsWith(`${controller.repo.root}\0`) && !barKey.startsWith('remote:')) barKey = NEW; }
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
  // timeoutMs: files to another computer of mine take longer than any other command.
  const peerCommand = async (command, { timeoutMs = 10000 } = {}) => {
    if (!facade?.sendPeerCommand) throw new Error(PEER_MISSING);
    if (peerRead('peerStatus')?.running !== true) throw new Error(PEER_STOPPED);
    // A picture the message names goes with it (lib/peer/pictures.mjs); over a limit this throws its one line.
    if (typeof facade.withPictures === 'function') command = facade.withPictures(command);
    const { id } = facade.sendPeerCommand(command);
    return facade.awaitCommand ? facade.awaitCommand(id, timeoutMs) : null;
  };
  // The daemon's answer to a send: a path outside the repo was cut for an untrusted teammate,
  // which the owner learns about here, or the usual line.
  const withCount = (result, line) => Number.isInteger(result?.pictures) && result.pictures > 0 ? line.replace('. ', ` with ${result.pictures === 1 ? '1 picture' : `${result.pictures} pictures`}. `) : line;
  // The line after a message to another computer of mine: it is it, never them.
  const sentToMine = who => `Sent to ${who}, your computer. Its reply shows in this thread.`;
  // The line then follows the message (sentState, lib/terminal-visuals.mjs): that computer
  // is not connected yet and for how long, delivered and when, started there and as which
  // session, answered, or failed there and why. It is read again every two seconds while it
  // is still the line shown; any other line ends that. mine: it went to a computer of mine.
  let sentWatch = null;
  function sentTick() {
    if (!sentWatch || closing) return;
    if (message !== sentWatch.shown) { sentWatch = null; return; }
    const watch = sentWatch, item = peerList('peerItems').find(row => typeof row?.id === 'string' && row.id.endsWith(`:${watch.id}`) && ['asked', 'answer', 'rejected', 'expired'].includes(row.kind)) ?? null;
    const state = sentState(item, { who: watch.who, online: onlineKeys(peerRead('peerStatus')).has(item?.peer), mine: watch.mine, unconfirmed: watch.mine && remoteApp.yours().get(item?.peer)?.waiting ? remoteApp.self() : null });
    if (!state) { sentWatch = null; return; }
    const text = plain(state.done || !watch.pictures ? state.text : `${state.text} ${watch.pictures} sent with it.`);
    if (text !== message) { setMessage(text); watch.shown = message; }
    sentWatch = state.done ? null : watch;
  }
  const sentLine = (result, who, line, mine = false) => {
    setMessage(result?.pathsCut === true ? `Paths outside the repo were replaced with [path]. Trust ${who} to keep them.` : withCount(result, line));
    sentWatch = typeof result?.askId === 'string' && result.pathsCut !== true ? { id: result.askId, who, mine, shown: message, pictures: Number.isInteger(result.pictures) && result.pictures > 0 ? result.pictures === 1 ? '1 picture' : `${result.pictures} pictures` : null } : null;
    try { sentTick(); } catch { sentWatch = null; }
  };
  // A message from a teammate, or from another computer of mine, whose session here failed
  // before any answer is said once, with why: its sender is told the same (lib/peer/failure.mjs).
  // The daemon's list is read for it at most every six seconds.
  let failedSeen = null, failedAt = 0;
  function failedTick() {
    if (closing || !facade || Date.now() - failedAt < 6000 || !peerOn()) return;
    failedAt = Date.now();
    const failed = peerList('peerItems').filter(item => item?.kind === 'failed' && typeof item.id === 'string');
    // One that failed up to a minute before the app opened is said too: its message may have come as this computer connected.
    if (!failedSeen) failedSeen = new Set(failed.filter(item => !(Date.now() - Date.parse(item.at) < 60000)).map(item => item.id));
    const fresh = failed.filter(item => !failedSeen.has(item.id)); for (const item of fresh) failedSeen.add(item.id);
    const item = fresh.at(-1); if (!item) return;
    const own = typeof item.peer === 'string' ? remoteApp.yours().get(item.peer) : null, who = threadWho(own ? { ...item, name: own.name } : item);
    setMessage(`A message from ${who} failed here${item.reason ? `: ${item.reason}` : '.'}`);
  }
  // The vendor of the model in view, for the picker's relay line.
  const leadVendor = () => { try { return modelNow()?.vendor ?? null; } catch { return null; } };
  // A vendor without a live relay here reports blocked actions instead.
  function relayLine(vendor) {
    if (!VENDORS.includes(vendor)) return [];
    const caps = CAPS[vendor], name = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', grok: 'Grok Build' }[vendor] ?? VENDOR_NAMES[vendor];
    let live = caps.relay === 'mcp';
    if (caps.relay === 'acp') { try { live = conformanceState(vendor)?.relay === true; } catch { live = false; } }
    return live ? [] : [`${name} can't ask live. Blocked actions are reported.`];
  }
  // The check starts bwrap once per bwrap program and keeps the answer (lib/sandbox.mjs).
  const shellLine = () => shellSandboxLine();
  // The Permissions picker: 1 ask, 2 auto, 3 full with its confirm. null when cancelled.
  // schedule: it picks for a schedule, whose runs have nobody watching, so Full access says
  // that (FULL_SCHEDULE) when it asks.
  async function pickMode({ schedule = false, vendor = leadVendor() } = {}) {
    const choices = ['ask', 'auto', 'full'];
    const body = [...choices.map((mode, index) => PICK(String(index + 1), LABELS[mode], MODE_TEXT[mode])), PICK('r', 'Without asking', 'The defaults and the rules you kept with a.'), '', ...(schedule ? ['Each run of a schedule has nobody watching.'] : []), ...relayLine(vendor), ...shellLine(), '/permissions folders add <path> lets the model read one more folder.'].join('\n');
    const answer = (await prompt('Permissions', body, '', { keys: [...choices.map((_, index) => String(index + 1)), 'r'] }))?.trim().toLowerCase();
    if (!answer) return null;
    if (answer === 'r') { await rulesDialog(); return null; }
    const mode = MODES.includes(answer) ? answer : choices[Number(answer) - 1];
    if (!mode) throw new Error(`Choose 1 to ${choices.length}.`);
    checkMode(mode);
    if (mode === 'full' && !await (schedule ? confirmScheduleFull() : confirmFull())) return null;
    return mode;
  }
  const confirmFull = () => yes('Full access', 'Full access: the model changes any file, runs any command and uses the internet without asking.\nThat includes push, tags, merges, publishing and deploys.\nIt reads your secret files and sign-ins, and gets your whole environment.', 'Use it? y/N');
  const confirmScheduleFull = () => yes('Full access', FULL_SCHEDULE, 'Use it for this schedule? y/N');
  // The Runs in picker: a new worktree, a named branch, or your checkout (Full access only).
  // schedule: it picks for a schedule, which never runs in your checkout, Full access or not.
  async function pickPlace({ mode, schedule = false }) {
    const body = [PICK('1', PLACE_LABEL.worktree, PLACE_TEXT.worktree), PICK('2', PLACE_LABEL.branch, PLACE_TEXT.branch), PICK('3', PLACE_LABEL.here, PLACE_TEXT.here)].join('\n');
    const answer = (await prompt('Runs in', body, '', { keys: ['1', '2', '3'] }))?.trim().toLowerCase();
    if (!answer) return null;
    const kind = { 1: 'worktree', 2: 'branch', 3: 'here', worktree: 'worktree', branch: 'branch', here: 'here' }[answer];
    if (!kind) throw new Error('Choose 1 to 3.');
    if (schedule && kind === 'here') throw new Error(NO_HERE);
    if (kind !== 'branch') return checkPlace(kind, { mode });
    const branch = (await prompt('Branch', 'Branch name. Commits land on it; a worktree checks it out.', ''))?.trim();
    return branch ? checkPlace({ kind, branch }, { mode }) : null;
  }
  // Adds one folder the model may read this session; "none" clears the list. null when cancelled.
  async function pickFolders(current, mode) {
    const body = [...(current.length ? current.map(shortHome) : ['none']), '', mode === 'full' ? 'Any folder the model may read this session.' : 'A folder in your home the model may read this session.', 'none clears the list. Esc keeps it.'].join('\n');
    const answer = (await prompt('Folders', body, ''))?.trim();
    if (!answer) return null;
    return answer === 'none' ? [] : checkFolders([...current, expandHome(answer)], { mode });
  }
  // The picker a teammate's message gets when the owner works on it: the rows of
  // the compose form in one dialog, 1 to 3 change a row, Enter starts it. named: the message
  // of a trusted sender, whose folders are offered as the picked mode takes them: Full access
  // offers every folder it names, and a lower mode only the ones it may read. null when cancelled.
  async function workPicker({ named = null } = {}) {
    const offer = mode => named === null ? [] : foldersNamed(named, { mode });
    // own: he changed the Folders row himself, so the message no longer decides it.
    let mode = defaultMode(), place = { kind: 'worktree' }, folders = offer(mode), own = false;
    for (;;) {
      const rows = [`Permissions  ${LABELS[mode].padEnd(22)}1 to change`, `             ${MODE_TEXT[mode]}`,
        `Runs in      ${padEnd(placeText(place), 22)}2 to change`, `             ${placeHint(place)}`,
        `Folders      ${folders.length ? `${folders.map(shortHome).join(' ')}  ${own ? '' : 'from their message · '}` : 'none'.padEnd(22)}3 to change`, '             Other folders it may read.'];
      const answer = (await prompt('Accept', [...rows, '', 'Enter starts it as your session. Esc leaves it waiting.'].join('\n'), '', { keys: ['1', '2', '3'] }))?.trim();
      if (answer === null || answer === undefined) return null;
      if (answer === '') { checkPlace(place, { mode }); return { permissions: mode, place, folders }; }
      if (answer === '1') {
        mode = await pickMode() ?? mode; if (place.kind === 'here' && mode !== 'full') place = { kind: 'worktree' };
        // The message's folders are read again for the new mode; folders he named himself
        // stay, less the ones only Full access takes.
        folders = own ? (mode === 'full' ? folders : foldersBelowFull(folders)) : offer(mode);
      }
      else if (answer === '2') place = await pickPlace({ mode }) ?? place;
      else if (answer === '3') { const next = await pickFolders(folders, mode); if (next) { folders = next; own = true; } }
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
    // A teammate's standup (lib/peer/standup.mjs): y asks your open sessions they see on the Kanban, n declines.
    if (item?.kind === 'standup') {
      await peerCommand({ type: decision === 'decline' ? 'discard' : 'approve', id: item.id });
      setMessage(decision === 'decline' ? `Declined ${who}'s standup. They are told.` : `Asked your sessions for ${who}'s standup. Each answers in its own chat.`); return;
    }
    if (request || item?.kind === 'incoming') {
      const at = request ? root : item.root, requestId = request?.id ?? item.requestId, id = item?.id ?? request?.origin?.a2aTaskId;
      // A message the conductor held for a session in the home folder: y lets it run there.
      if (request?.state === 'waiting' && request.reason === HOME_QUESTION && decision !== 'decline') {
        if (!await yes('Home folder', HOME_QUESTION, 'y yes · n no')) { setMessage('It waits for you.'); return; }
        if (request.continuationTaskId) allowHome(projectFolder(root), request.continuationTaskId); else updateRequest(root, request.id, { home: true });
        if (!retryRequest(root, request.id)) throw new Error('That message is no longer waiting.');
        conduct(); setMessage(`Approved ${who}. It runs in your home folder.`); return;
      }
      if (!id) throw new Error('That message is no longer waiting.');
      // y: the session your own prompt would start, in the message's project or, when it
      // came with none, the one open now. w: the same in a mode, place and folders picked now.
      const here = controller ? { root: controller.repo.root } : {};
      // Where it would run is the home folder: the owner is asked first, and his y goes with it.
      const runsAt = typeof at === 'string' && at && !homeOrAbove(at) ? at : here.root ?? at, home = decision === 'decline' ? null : await homeStart(runsAt);
      if (home === false) return;
      if (home) here.home = true;
      if (decision === 'answer') {
        await peerCommand({ type: 'approve', id, ...here });
        setMessage(`Approved ${who}. It runs as your session; the reply goes back to this thread.`); return;
      }
      if (decision === 'work') {
        const picked = await workPicker({ named: item?.trusted === true ? item.text : null });
        if (!picked) return;
        await peerCommand({ type: 'work', id, permissions: picked.permissions, place: picked.place, folders: picked.folders, ...here });
        setMessage(`Accepted ${who}. It runs as your session; the reply goes back to this thread.`); return;
      }
      if (typeof at === 'string' && at && typeof requestId === 'string') removeRequest(at, requestId);
      await peerCommand({ type: 'discard', id });
      setMessage(`Declined ${who}'s message.`); return;
    }
    if (decision === 'work') throw new Error('w works on a teammate\'s message that waits for you.');
    const accept = decision === 'answer';
    // n on a thread that waits for nothing dismisses it; an open ask is also cancelled with the teammate.
    if (!accept && ['answer', 'asked', 'expired', 'rejected'].includes(item?.kind)) { await peerCommand({ type: 'discard', id: item.id }); setMessage(item.kind === 'asked' ? `Cancelled the ask to ${who}.` : 'Dismissed.'); return; }
    if (!['held', 'draft'].includes(item?.kind)) throw new Error('y works on messages, replies, and drafts that wait for you.');
    const result = await peerCommand({ type: accept ? 'approve' : 'discard', id: item.id });
    if (accept) sentLine(result, who, item.kind === 'held' ? `Sending the ${item.result ? 'result' : 'reply'} to ${who}.` : `Sending the ask to ${who}.`); else setMessage(item.result ? `Dropped the result. Nothing was sent to ${who}.` : 'Discarded.');
  }
  // What t and Ask say with no one chosen: a computer of mine is someone to choose too.
  const chooseFirst = () => remoteApp.yours().size ? 'Choose a teammate or one of your computers first.' : 'Choose a teammate first.';
  // The members of a channel as a line counts them: teammates, and my computers apart, never as teammates. more: who else the line names.
  const counted = (keys, more = []) => {
    const mine = keys.filter(key => remoteApp.own(key)).length, others = keys.length - mine;
    const parts = [...(others ? [`${others} teammate${others === 1 ? '' : 's'}`] : []), ...(mine ? [mine === 1 ? 'your computer' : `${mine} of your computers`] : []), ...more];
    return parts.length > 2 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts.join(' and ');
  };
  // Who a channel needs ticked: a computer of mine counts too.
  const oneMember = () => remoteApp.yours().size ? 'one teammate or one of your computers' : 'one teammate';
  // The first to answer a channel: a teammate, or, where everyone else in it is a computer of mine, one of those.
  const takers = room => { const others = (room?.members ?? []).filter(key => key !== myKey()); return others.length && others.every(key => remoteApp.own(key)) ? 'of your computers' : 'teammate'; };
  // e on a reply or a result that waits for the owner: its whole text goes into the message
  // box of Chats, with that teammate open. Enter sends what the box then holds, scanned again
  // by the daemon; Esc, or leaving the box, leaves it held as it was.
  function editHeld(item) {
    if (item?.kind !== 'held') throw new Error('e edits a reply or a result that waits for you. Choose one in Threads.');
    let text = null; try { text = typeof facade?.heldText === 'function' ? facade.heldText(item.id) : null; } catch { text = null; }
    // From Sessions it opens in Chats, on that teammate.
    if (view !== 'chats') { showView('chats'); if (item.peer) chatJump = dmTarget(item.peer); }
    heldEdit = { id: item.id, who: threadWho(item), result: item.result === true, ...(item.blocked ? { secret: true } : {}) };
    focusInput(); ask.setValue(String(text ?? item.text ?? ''));
    setMessage(item.blocked ? `Take out the possible secret. Enter sends it to ${heldEdit.who}, Esc leaves it held.` : `Change the text below, then Enter sends it to ${heldEdit.who}. Esc leaves it held.`);
    draw();
  }
  // Leaving it says so, and gives its row in Threads, where y, e and n act on it.
  const leaveEdit = () => {
    const { id, result } = heldEdit; heldEdit = null; ask.clearValue(); setMessage(`The ${result ? 'result' : 'reply'} is still held. y sends it as it is, e edits it, n drops it.`);
    return teamRows[1].findLastIndex(row => row.value?.id === id);
  };
  // Trust a teammate or remove it, after a confirm. Another computer of mine is it, never them.
  async function trustPeer(value) {
    if (value?.type !== 'member' || value.self) throw new Error(chooseFirst());
    const who = peerName(value.name, value.key), trusted = value.trusted ?? peerTrusted(value.key), mine = remoteApp.own(value.key);
    if (trusted) {
      if (!await yes(`Trust ${who}`, `Remove trust for ${who}? Paths go out as [path] again.`, 'y/N')) return;
      await peerCommand({ type: 'untrust', key: value.key }); setMessage(`Removed trust for ${who}. Paths go out as [path].`); return;
    }
    if (!await yes(`Trust ${who}`, `Trust ${who}? Paths on this machine reach ${mine ? 'it' : 'theirs'} as written.\nSecrets are still held back.`, 'y/N')) return;
    await peerCommand({ type: 'trust', key: value.key }); setMessage(`Trusted ${who}. Paths go out as they are. ${mine ? 'Its' : 'Their'} text shows as sent.`);
  }
  // h and o on a teammate: hold my replies and results to them until I send each one, and let
  // their answers and results continue the chat I asked from. Mine about them, kept by the
  // daemon like trust, and never sent to them. Another computer of mine is it, never them.
  async function teammateSetting(value, name) {
    if (value?.type !== 'member' || value.self) throw new Error(chooseFirst());
    const who = peerName(value.name, value.key), on = peerPolicyOf(value.key)[name] !== true, whose = remoteApp.own(value.key) ? 'its' : 'their';
    await peerCommand({ type: 'peerSetting', key: value.key, name, on });
    setMessage(name === 'holdReplies'
      ? on ? `Holding replies to ${who}: y sends each one, e edits it, n drops it.` : `Replies to ${who} go when ready. One with a possible secret still waits.`
      : on ? `Auto-continue on for ${who}: ${whose} answer or result continues your chat.` : `Auto-continue off for ${who}: ${whose} answers wait here; c continues one.`);
  }
  // What a thread says once the session it was asked from went on with its answer or result.
  const wentOn = item => `Your session already continued with this ${item.result ? 'result' : 'answer'}.`;
  // Returns the letter pressed when the dialog names keys (y, w, n, c, f, m or t), else null.
  async function peerDetails(value) {
    // A message in a thread shows whole, whatever its length.
    const text = value => sanitize(value, Infinity);
    // Text other than a named letter does nothing, and says so. preselect: the letter Enter picks.
    const keyed = async (title, body, keys = [], { preselect = '', trusted = false, live = null } = {}) => {
      const typed = String(await prompt(title, body, preselect, { keys, preselect, trusted, live }) ?? '').trim().toLowerCase();
      if (keys.includes(typed)) return typed;
      if (typed && keys.length) throw new Error(`Nothing was done. Press ${keys.join(' or ')}.`);
      return null;
    };
    if (value.type === 'member') {
      // Another computer of mine says so in its title, and while it has not marked this one back, whose agreement it waits for and what to type there.
      // A computer that says it is mine and is not marked here says so, and the command that agrees. Either says once why GitHub did not pair the two, when GitHub can say.
      const trusted = value.trusted ?? peerTrusted(value.key), mine = value.self ? null : remoteApp.yours().get(value.key) ?? null, shown = peerName(value.name, value.key), { holdReplies: hold, autoContinue: auto } = peerPolicyOf(value.key);
      const asks = value.self || mine ? null : remoteApp.asking().get(value.key) ?? null, github = mine?.waiting || asks ? remoteApp.githubNote(value.key) : null;
      const agree = mine?.waiting ? [`Waiting for ${shown} to agree: run /mine @${remoteApp.self()} there.`, ...(github ? [github] : []), ''] : asks ? [`@${asks.name} says it is your computer. /mine @${asks.name} agrees.`, ...(github ? [github] : []), ''] : [];
      return keyed(`${mine ? 'Your computer' : 'Teammate'} ${shown}${mine?.waiting ? ' · waiting for it to agree' : asks ? ' · says it is your computer' : ''}`, [...agree, `Key: ${value.key}`, `Fingerprint: ${text(value.member.fingerprint)}`, `Team: ${text(value.team?.name)}`, `Role: ${text(value.member.role)}`, `State: ${value.self ? 'you' : reachText({ ...value.member, via: text(value.member.via) }, { whole: true })}`, `Last seen: ${relativeTime(value.member.lastSeen)}`, ...(value.self ? [] : [trusted ? 'Trust: trusted · paths go out as they are.' : 'Trust: not trusted · paths go out as [path].',
        hold ? `Hold replies: on · each reply and result to ${mine ? 'that computer' : 'them'} waits for you to send it.` : `Hold replies: off · your replies and results go to ${mine ? 'it' : 'them'} when ready.`,
        auto ? `Auto-continue: on · ${mine ? 'its' : 'their'} answer or result continues the chat you asked from.` : `Auto-continue: off · ${mine ? 'its' : 'their'} answers wait in ${mine ? 'its' : 'their'} thread.`,
        '', `${trusted ? 't removes trust' : mine ? 't trusts it' : 't trusts them'} · h ${hold ? 'stops holding replies' : 'holds replies'} · o turns auto-continue ${auto ? 'off' : 'on'}`])].join('\n'), value.self ? [] : ['t', 'h', 'o']);
    }
    if (value.type === 'agent') return keyed(`Sessions of ${peerName(value.name, value.peer)}`, value.row ? [`${text(value.row.handle)} ${text(value.row.label)}`, text(value.row.now), '', 'Overlap with your work:', ...(value.row.overlap ?? []).map(text), '', 'Changed files:', ...(Array.isArray(value.row.files) ? value.row.files.slice(0, 200).map(text) : [])].join('\n') : 'No live sessions.');
    // Any message is accepted the same way: it runs as the owner's session.
    // An answer or a result the chat already went on with is only read: c has nothing left to do.
    const [hint, keys, preselect] = value.kind === 'answer' && value.continued === true ? [wentOn(value), [], ''] : value.kind === 'answer' ? [`c continues in the chat with this ${value.result ? 'result' : 'answer'}.`, ['c'], ''] : value.kind === 'incoming' ? ['y starts it now, as if you typed it. w picks the mode first. n declines.', ['y', 'w', 'n'], 'y'] : value.kind === 'held' ? ['y sends. e edits it first. n discards.', ['y', 'e', 'n'], ''] : value.kind === 'draft' ? ['y sends. n discards.', ['y', 'n'], ''] : ['', [], ''];
    // The thread reads like a chat: who said what, oldest first, from the thread's log.
    const logged = () => { try { return value.threadId && typeof facade?.threadMessages === 'function' ? facade.threadMessages(value.threadId) : []; } catch { return []; } }, messages = logged();
    const TAG = { ask: 'question', review: 'review', handoff: 'task', answer: 'answer', held: 'answer', blocked: 'answer' };
    const head = m => [`${TAG[m.kind] === 'answer' ? '↳ ' : ''}${m.from === 'peer' ? peerName(m.name, m.peer) : m.held ? 'your model' : 'you'}`, m.held && value.result ? 'result' : TAG[m.kind] ?? text(m.kind), ...(m.held ? [m.blocked ? 'held: possible secret' : 'not sent yet'] : []), clockTime(m.at)].join(' · ');
    const talkOf = list => list.length ? list.flatMap(m => m.from === 'note' ? [`(${text(m.text)})`, ''] : [head(m), text(m.text), '']) : [text(value.text), ''], talk = talkOf(messages);
    const where = item => sentState(item, { who: threadWho(value), online: onlineKeys(peerRead('peerStatus')).has(value.peer), mine: Boolean(value.peer && remoteApp.yours().has(value.peer)) });
    // The line for where a message is now and, while it waits there, what it waits for (note) whole on a line of its own.
    const placed = item => (state => state ? [`↳ ${text(state.text)}`, ...(item.kind === 'asked' && item.note ? [text(item.note)] : []), ''] : null)(where(item.kind === 'asked' ? { ...item, note: null } : item));
    // A message of mine that got no answer ends with who could not answer and why, in full;
    // one that waits on their computer, with what it waits for there.
    const end = !messages.length ? [] : value.kind === 'rejected' && value.text && value.text !== value.question ? [`↳ ${threadWho(value)} · ${value.state === 'failed' ? 'failed' : 'rejected'}`, text(value.text), '']
      // One that still waits says where it is now: not connected to that computer yet, delivered, started there (sentState).
      // What it waits for there (note) follows on its own line, whole.
      : value.kind === 'asked' ? placed(value) ?? []
      // A message that failed here says why, as its session here says it; a question that was refused before any session, in the owner's own words.
      : value.kind === 'failed' && (value.reason || value.why) ? ['↳ your model could not answer', text(value.reason || value.why), ''] : [];
    // The project the thread is about, by its name here: the one a teammate's message runs in
    // (or waits for), or the one I asked from. A share of theirs that my message named says
    // theirs. A message that has no project yet has no such line.
    const named = ['asked', 'answer', 'expired', 'rejected', 'draft'].includes(value.kind) ? text(value.project) : '';
    const about = named || (typeof value.root === 'string' && value.root ? text(projectName(value.root)) : text(value.project));
    const page = (said, last) => [...(about ? [`Project: ${about}`, ''] : []), ...said, ...last, hint].join('\n').trimEnd();
    // A message of mine that is still on its way is read again while its thread is open: the line says where it is now, then that it was answered or why it failed.
    const tail = value.kind === 'asked' && messages.length && typeof value.id === 'string' && value.id.includes(':') ? value.id.slice(value.id.indexOf(':')) : null;
    const live = tail ? () => { const now = peerList('peerItems').find(row => typeof row?.id === 'string' && row.id.endsWith(tail) && ['asked', 'answer', 'rejected', 'expired'].includes(row.kind)), lines = now ? placed(now) : null; return lines ? page(talkOf(logged()), lines) : null; } : null;
    return keyed(`Thread with ${threadWho(value)}`, page(talk, end), keys, { preselect, trusted: value.trusted === true, live });
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
        const key = value ? await peerDetails(value) : null, next = { y: 'accept', w: 'work', n: 'decline', c: 'continue', t: 'trust', e: 'edit' }[key];
        return next ? teamAction(index, next) : undefined;
      }
    }
    if (['accept', 'decline', 'work'].includes(action)) { if (index !== 1 || !value) throw new Error('Choose a thread that waits for you.'); return decidePeer({ item: value }, action === 'accept' ? 'answer' : action); }
    // t shows the teammate with their Trust line; t there confirms the change.
    if (action === 'trust') {
      if (index !== 0 || value?.type !== 'member' || value.self) throw new Error(chooseFirst());
      const key = await peerDetails(value);
      return key === 't' ? trustPeer(value) : key === 'h' ? teammateSetting(value, 'holdReplies') : key === 'o' ? teammateSetting(value, 'autoContinue') : undefined;
    }
    // h and o act on the teammate under the cursor in the bar (an agent's row is its teammate's), and on the open one from their threads.
    if (['hold', 'auto'].includes(action)) return teammateSetting(index === 0 && value?.type !== 'agent' ? value : chatOpen, action === 'hold' ? 'holdReplies' : 'autoContinue');
    if (action === 'edit') { if (index !== 1) throw new Error('e edits a reply or a result that waits for you. Choose one in Threads.'); return editHeld(value); }
    if (action === 'ask') {
      if (index !== 0 || !['member', 'agent'].includes(value?.type)) throw new Error(chooseFirst());
      focusInput(); ask.setValue(`@${peerName(value.name, value.peer ?? value.key).slice(1)} `); draw(); return;
    }
    if (action === 'continue') { if (index !== 1 || value?.kind !== 'answer') throw new Error('c continues with an answer. Choose one in Threads.'); if (value.continued === true) throw new Error(wentOn(value)); await peerCommand({ type: 'continue', id: value.id }); setMessage(`Continuing in the chat with the ${value.result ? 'result' : 'answer'}.`); return; }
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
    if (!members.length) throw new Error(`Tick at least ${oneMember()}, then Create channel.`);
    const result = await peerCommand({ type: 'channelSet', team: team.id, name, members: [myKey(), ...members] });
    if (result?.id) chatJump = roomTarget(team.id, result.id);
    setMessage(`Created #${name} with ${counted(members)}. ${members.length === 1 && remoteApp.own(members[0]) ? 'It sees it when it is online.' : 'They see it when they are online.'}`); draw();
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
    if (!members.length) throw new Error(`Tick at least ${oneMember()}. To leave the channel, press x on it.`);
    await saveChannel(room, members);
    setMessage(`#${room.name} now has ${counted(members, ['you'])}.`); draw();
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
    // A project that team shared, when its board is the one open: Kanban is the open project's again, and the line says the leave.
    sharedKept.at = 0; if (sharedOpen !== null && !sharedNow()) sharedOpen = null;
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
    const name = (await prompt('Your name', 'Teammates see this name on your asks and answers. 1 to 40 characters.', offeredName()))?.trim();
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
  // team: the team the setting is for, when it is known. A message from another computer of
  // mine on it follows the setting as a teammate's does (lib/peer/intake.mjs), and the two
  // questions say so; where everyone else on the team is a computer of mine, they name no teammate.
  async function accessQuestions(current = null, { existing = false, team = null } = {}) {
    const others = (team?.members ?? []).filter(member => member?.key && member.key !== myKey()), mine = others.filter(member => remoteApp.own(member.key)), names = mine.map(member => peerName(member.name, member.key)).join(', ');
    const only = mine.length > 0 && mine.length === others.length, also = mine.length && !only ? `Messages from your computer${mine.length === 1 ? '' : 's'} ${names} follow this too.` : null;
    const picked = await listDialog(only ? 'What your computers can do here' : 'What teammates can do here', HANDLING_ROWS.map(([, text]) => ink(text, 'text', colour)), { selected: (current ? current.handling === 'manual' : existing) ? 1 : 0, notes: [...(also ? [also] : []), 'Push, merge, deploy and publish need Full access either way.'], hint: 'enter choose · esc cancel' });
    if (!picked) return null;
    const rules = await prompt(only ? 'Rules for your computers' : 'Rules for teammates', `Optional, in plain English. For example: Only work on the elu repo. Don't write anything until I accept it.${also ? `\n${also}` : ''}`, current?.rules ?? '');
    if (rules === null || rules === undefined) return null;
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
    const now = current ? `${current.handling === 'manual' ? 'Manual' : 'Auto'} · rules: ${current.rules ? fitWords(current.rules.replace(/\s+/g, ' '), 60) : 'none'}${current.root ? ` · ${shortHome(current.root)}` : ''}` : 'Manual · rules: none';
    setMessage(`${remote(team.name, 40) || 'Team'} now: ${now}`); draw();
    const asked = await accessQuestions(current, { existing: true, team });
    if (!asked) { setMessage('Nothing was changed.'); return; }
    const { saved, noProject } = saveAccess(team.id, asked);
    setMessage(`Saved for ${remote(team.name, 40) || 'the team'}: ${saved?.handling === 'manual' ? 'messages wait for you to approve them' : 'messages start sessions here, as if you typed them'}${saved?.rules ? ', with your rules' : ''}${saved?.root ? ` in ${shortHome(saved.root)}` : ''}.${projectNote(noProject)}`);
  }
  // The team a plain /invite makes its code for. Only an admin of a team can add someone to
  // it: the one team I am an admin of, or the one picked from several. Null when Esc closed the list.
  async function inviteTeam(teams) {
    const mine = teams.filter(team => team.role === 'admin');
    if (!mine.length) {
      const [team] = teams, maker = remote((team.members ?? []).find(member => member.key === team.founder)?.name, 40);
      throw new Error(`Only an admin of ${remote(team.name, 40) || 'the team'} can make an invite code.${maker ? ` Ask ${maker}, who made the team.` : ''}`);
    }
    if (mine.length === 1) return mine[0];
    const picked = await listDialog('Which team', mine.map(team => ink(remote(team.name, 40) || 'Team', 'text', colour)), { notes: ['The code adds someone to this team.'], hint: 'enter choose · esc close' });
    return picked ? mine[picked.index] : null;
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
    const name = machine?.name ?? here.machine;
    if (!text) { ask.setValue(`@${name} `); setMessage(`Write the message after @${name}.`); focusInput(); return; }
    // Files or folders on this computer that the message names are offered to go with it (y/n).
    if (here) { setMessage(await remoteApp.send(here, text, filesAsked)); ask.clearValue(); focusInput(); return; }
    const form = composing(), settings = form ? { permissions: formMode(), place: composePlace, model: composeModel, bots: composeBots } : { permissions: defaultMode(), place: { kind: 'worktree' }, model: null, bots: firstBots() };
    setMessage(`Starting on @${machine.name}…`); draw();
    // Its home folder is a project there: the owner picks the folder the session works in.
    const where = await remoteApp.folders(machine);
    if (where) {
      const at = Math.max(0, where.folders.findIndex(row => row.path === where.root));
      const picked = await listDialog(`Folder on @${machine.name}`, where.folders.map(row => row.label === '~' ? ink('~', 'text', colour) + ink('  the home folder', 'muted', colour) : ink(row.label, 'text', colour)),
        { selected: at, notes: [`Pick the folder this session works in on @${machine.name}.`], hint: 'enter choose · esc cancel' });
      if (!picked) { ask.setValue(`@${machine.name} ${text}`); setMessage('Nothing was sent. The message is still here.'); focusInput(); return; }
      settings.folder = where.folders[picked.index].path;
    }
    const started = await remoteApp.start(machine, text, settings);
    ask.clearValue(); if (form) resetForm();
    // The list shows it, with the cursor on it.
    rememberDraft(); view = 'tasks'; returnTo = 'tasks'; selectedId = null; selectedRequest = null; following = null;
    ownSeen = null; wanted = null; barKey = openKey = started.key;
    setMessage(started.line); resize(); focusInput();
  }
  // A message to your agent here about the session on another computer under the cursor,
  // asked for with @here (lib/remote-helper.mjs). The first starts it in the project open here,
  // with the defaults of a new session there, named after that session; the next ones continue
  // it, wherever it runs.
  async function helperSubmit(row, text) {
    if (!text) { ask.setValue(`${HERE} `); setMessage(`Write your message after ${HERE}.`); focusInput(); return; }
    let link = helperLink(row.remote.machine, row.id), id = null;
    if (link) {
      const queue = pendingRequests(link.root), first = queue.find(request => request.id === link.requestId && !request.taskId);
      id = helperTask(link, { requests: queue, sessions: () => savedTasks(helperRepo(link.root)) });
      // Its first message has not started yet: this one goes with it.
      if (!id && first?.state === 'queued' && addToRequest(link.root, first.id, text)) { ask.clearValue(); setMessage('Your agent here has not started yet. This goes with your first message.'); focusInput(); return; }
      if (!id && first) throw new Error('Your agent here is still starting. Send this again in a moment.');
      try { if (id) readTask(helperRepo(link.root), id); } catch { id = null; }
    }
    if (id) {
      queueRequest(link.root, text, { continuationTaskId: id, priority: 0 });
      ownerWrote(link);
    } else {
      const root = goalTarget();
      if (!root) throw new Error('Open a project here first: your agent here works in it.');
      const repo = helperRepo(root), request = queueRequest(root, text, { priority: 0, permissions: defaultMode(), place: { kind: 'worktree' }, folders: [], bots: firstBots(), helps: { machine: row.remote.machine, remoteId: row.id, name: row.machine, title: row.remote.title ?? '' } });
      linkHelper({ machine: row.remote.machine, remoteId: row.id, name: row.machine, title: row.remote.title ?? '', root, project: repo.project ?? repo.root, requestId: request.id });
    }
    conduct(); ask.clearValue();
    setMessage(`Sent to your agent here. It answers beside @${row.machine}'s session.`); focusInput();
  }
  // The one line that offers files to a session on another computer of mine, and what shows while they go.
  const filesAsked = { confirm: line => yesKey('Send files', line), sending: line => { setMessage(line); draw(); } };
  // Peer slash commands. Each makes one facade call; the result shows in the status line.
  // A /join that is looking for the inviter: Esc stops it at once and says so. If the join
  // went through in that same moment, the line then says it joined.
  let joining = null;
  const cancelJoin = () => { if (!joining || joining.signal.aborted) return false; joining.abort(); setMessage('Join cancelled. You did not join.'); return true; };
  async function peerSlash({ name, args, text = '' }) {
    if (!facade) throw new Error(PEER_MISSING);
    // What teammates see of a shared project without having it: its name in their Projects, and its git address when it has one.
    const seenLine = root => { let address = null; try { address = facade.projectAddress?.(root) ?? null; } catch { /* Said without it. */ } return `They see its name${address ? ' and git address' : ''} in Projects.`; };
    if (name === 'share') {
      if (!controller) throw new Error('Open a project to share it.');
      // /share off keeps this project's Tasks off the team board; /share on puts them back.
      if (args.length === 1 && ['on', 'off'].includes(args[0])) {
        controller.writable(); facade.taskBoard(controller.repo.project ?? controller.repo.root, args[0] === 'on'); teamTasks.at = 0;
        setMessage(args[0] === 'on' ? 'This project is on the team board again.' : "This project is kept off the team board: teammates do not see your sessions here, and theirs are not shown. /share on puts it back."); return;
      }
      if (args.length > 1 || args[0] && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(args[0])) throw new Error('Use /share [handle] with 1 to 40 lowercase letters, digits or dashes.');
      controller.writable(); const result = await facade.share(controller.repo.root, { handle: args[0], status: true });
      setMessage(`Shared ${shortHome(result?.root ?? controller.repo.root)} with your team as ${remote(result?.handle, 40) || args[0] || path.basename(controller.repo.root)}. ${seenLine(result?.root ?? controller.repo.root)}`); return;
    }
    if (name === 'access') return accessCommand(args);
    if (!peerOn() && !['invite', 'join'].includes(name)) throw new Error(NO_TEAM);
    if (name === 'peers') {
      const status = peerRead('peerStatus'), members = new Map();
      for (const member of (status?.teams ?? []).flatMap(row => row?.members ?? [])) if (member?.key && member.key !== status.key) members.set(member.key, member);
      // Another computer of mine is counted apart: it is not a teammate.
      const mine = remoteApp.yours(), said = (rows, what) => { const online = rows.filter(member => member.online); return rows.length ? `${online.length} of ${rows.length} ${what} online${online.length ? `: ${online.map(member => `${peerName(member.name, member.key)} (${member.path === 'relayed' ? `through ${remote(member.via, 60) || 'another computer'}` : remote(member.path, 10) || 'direct'})`).join(', ')}` : ''}` : ''; };
      const all = [...members.values()], yours = all.filter(member => mine.has(member.key)), others = all.filter(member => !mine.has(member.key)), unsure = yours.filter(member => mine.get(member.key).waiting).map(member => peerName(member.name, member.key));
      // One that has not marked this machine back yet is not mine yet, and the line says which.
      setMessage(members.size ? [said(others, 'teammates'), said(yours, 'of your computers'), unsure.length ? `waiting for ${unsure.join(', ')} to agree` : ''].filter(Boolean).join(' · ') : 'No teammates yet. Use /invite to add one.'); return;
    }
    // Adding a teammate also picks the project they ask about: the open one.
    const teamShare = async teamId => {
      if (!controller) return 'Type /share in a project so teammates can ask about it.';
      try { controller.writable(); const row = await facade.share(controller.repo.root, { teams: [teamId] }); return `Teammates can ask about ${remote(row?.handle, 40) || path.basename(controller.repo.root)}, the folder ${shortHome(row?.root ?? controller.repo.root)}. ${seenLine(row?.root ?? controller.repo.root)}`; }
      catch (error) { return `${path.basename(controller.repo.root)} is not shared: ${error.message}`; }
    };
    if (name === 'invite') {
      const teams = peerRead('peerStatus')?.teams ?? [];
      if (!teams.length && args.length) throw new Error('No team yet. /invite alone starts one and makes a code to send.');
      // Plain /invite first says what it can do: a code for someone new, or which bots teammates may use.
      if (!args.length) {
        const sharing = myBots().some(bot => canShare(bot.vendor));
        const options = [INVITE_NEW, ...(sharing ? [INVITE_BOTS] : [])];
        const picked = await listDialog('Invite', options.map(text => ink(text, 'text', colour)), { hint: 'enter choose · esc close' });
        if (!picked) return;
        if (options[picked.index] === INVITE_BOTS) { setMessage(await shareBots()); return; }
      }
      if (!(await named())) return;
      // A name adds a teammate to the open channel: @name always, a bare word unless a team is called that.
      if (teams.length && args.length === 1 && (args[0].startsWith('@') || !teams.some(row => row.id === args[0] || row.name === args[0]))) return (await peerReady()) && inviteToChannel(args[0]);
      // Already on a team, the code is for it and no other team is made: with several, it asks which.
      const found = args.length ? teams.find(row => row.id === args[0] || row.name === args.join(' ')) : teams.length ? await inviteTeam(teams) : null;
      if (args.length && !found) throw new Error('No team by that name.');
      if (teams.length && !found) { setMessage('Nothing was done. No invite was made.'); return; }
      // The first invite for a team asks what teammates can do here, before the code; later ones do not ask again.
      // They are asked before a first team is made, so Esc there leaves no team behind.
      const known = Boolean(found && accessOf(found.id));
      const asked = known ? null : await accessQuestions(null, { existing: hasTeammates(found), team: found });
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
      await prompt('Team invite', `${framed(code)}\n\n${copied ? 'Copied to your clipboard. ' : ''}One use, expires in 24 h.\n${shared}\n${bots ? `${bots}\n` : ''}Send this code to your teammate. On their computer:\n1. Open a terminal in the project folder they will share with you.\n2. Run npx -y @elu-labs/elu\n3. In ELU, type /join and paste this code.\nStay online until they join.`); return;
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
      // While it looks, the line counts and says what the search needs, so it is seen to be
      // working; Esc stops it at once (cancelJoin). The search finds them only while their ELU runs.
      // Once their computer is found the line says so, and what it is trying: a direct connection, again, or through another computer.
      const started = Date.now(), looking = () => { const seconds = Math.floor((Date.now() - started) / 1000); let line = null; try { line = facade.joinLine?.(seconds, 'Esc'); } catch { /* The plain line below. */ } return typeof line === 'string' && line ? line : `Looking for the person who invited you… ${seconds} s. Their ELU must be open. Esc cancels.`; };
      const stopper = joining = new AbortController(), count = setInterval(() => { if (!stopper.signal.aborted && !closing) setMessage(looking()); }, 1000);
      setMessage(looking());
      // Joining is all it does: the joiner is added to the inviter's team. It shares no project
      // of the joiner's; /share does that, whenever they want. Teammates' messages start sessions
      // in the project open now, as the answers say.
      let joined, failed = null;
      try { joined = await facade.joinTeam(code.short ?? code.long, { signal: stopper.signal }); } catch (error) { failed = error; } finally { clearInterval(count); if (joining === stopper) joining = null; }
      if (failed) {
        // Why it gave up and what works can be longer than the row below holds: then a window shows it whole, a sentence to a line.
        const why = String(failed?.message ?? '').replace(/\s+/g, ' ').trim();
        if (widthOf(why) > (listed() ? status.width * 2 - 4 : status.width - 2) && !stopper.signal.aborted && !modal && !closing) {
          setMessage(why);
          await listDialog('Could not join', why.split(/(?<=[.!?])\s+(?=\p{Lu})/u).flatMap(line => wrapText(line, Math.min(88, screen.width - 4) - 5)).map(line => ink(line, 'text', colour)), { hint: 'esc close' });
        }
        throw failed;
      }
      const team = remote(joined?.name, 40) || 'the team', who = remote(joined?.inviter?.name, 40);
      peerOnAt = 0;
      const { saved, noProject } = joined?.id ? saveAccess(joined.id, asked) : { saved: null, noProject: null };
      // through: the computer that passes the connection along, when the two networks would not connect directly.
      const through = remote(joined?.via, 60), joinedHead = `Joined ${team}${who ? ` with ${who}` : ''}.${through ? ` Connected through ${through}.` : ''}`;
      setImmediate(() => nameShared(joined?.id, joinedHead));
      const said = `${joinedHead} ${saved?.handling === 'manual' ? 'Their messages wait for you to approve them.' : saved && !noProject ? 'Their messages start sessions here, as if you typed them.' : ''}${projectNote(noProject)}`.replace(/\s+/g, ' ').trim();
      // A team of my own that nobody else was ever on was closed by the join, so Chats has one #general; on several teams now, each has
      // its own. Said right after who was joined: the row is cut at its width, and what teammates can do here was just answered.
      const teamsNote = [facade.closedLine?.(joined?.closed), facade.teamsLine?.(facade.teamCount?.())].filter(Boolean).join(' ');
      const told = teamsNote && said.startsWith(joinedHead) ? `${joinedHead} ${teamsNote}${said.slice(joinedHead.length)}` : `${said}${teamsNote ? ` ${teamsNote}` : ''}`;
      // A code made for another computer of the inviter's own marks nothing by itself: the person
      // here says whether both are theirs. No is first, and Esc is no.
      if (joined?.mineOffer?.key) {
        setMessage(told); draw();
        const picked = await listDialog(`Is ${who ? `${who}'s` : 'their'} computer yours too?`, ['No', 'Yes, both are mine'].map(text => ink(text, 'text', colour)), { notes: ['Only say yes if you set up both computers.', 'Yes lets each one start sessions on the other.'], hint: 'enter choose · esc no' });
        if (picked?.index === 1) { setMessage(`${joinedHead} ${teamsNote ? `${teamsNote} ` : ''}${await remoteApp.agree(joined.mineOffer.key, who)}`); return; }
        setMessage(`${told} Not marked as yours.`); return;
      }
      setMessage(told); return;
    }
    if (name === 'leave') return leaveTeam(args);
    if (name === 'remove') return removeTeammate(args);
    const target = args[0] ?? '';
    // No @name: the question goes to every teammate, and the first to take it answers.
    if (target && !target.startsWith('@')) {
      const chat = controller && view === 'chat' ? { root: controller.repo.root, taskId: selectedId ?? null } : {};
      const result = await peerCommand({ type: 'teamAsk', project: null, text, ...chat });
      setMessage(withCount(result, `Asked your team. The first ${takers({ members: (peerRead('peerStatus')?.teams ?? []).flatMap(team => (team?.members ?? []).map(member => member.key)) })} to take it answers.`)); return;
    }
    if (!/^@[^\s@/\\]{1,64}$/.test(target)) throw new Error('Write @name and your question.');
    // Another computer of mine is asked by its key: the name the app shows it under is its box name, which the daemon does not ask by.
    const own = (person => person?.mine ? person : null)(teammateNamed(target)), to = own?.key ?? target.slice(1), shown = own ? `@${own.name}` : `@${to}`;
    // A second word names a project only when it is one of that teammate's shared handles.
    let rest = text.slice(target.length).trim(), project = null;
    // Handles come from the teammate's hello (in peerStatus), and from their live rows.
    const plain = value => String(value ?? '').replace(/[\s@]+/g, '').toLowerCase(), members = (peerRead('peerStatus')?.teams ?? []).flatMap(row => row?.members ?? []).filter(member => member?.key === to || member?.name === to || plain(member?.name) === plain(to));
    const word = rest.split(/\s+/, 1)[0], handles = [...members.flatMap(member => Array.isArray(member.handles) ? member.handles : []), ...peerList('teamAgents').filter(row => row?.name === to || row?.peer === to).flatMap(row => (row.rows ?? []).map(value => value?.handle))];
    if (word && rest.length > word.length && handles.includes(word)) { project = word; rest = rest.slice(word.length).trim(); }
    if (!rest) throw new Error('Write your question after @name.');
    const chat = controller && view === 'chat' ? { root: controller.repo.root, taskId: selectedId ?? null } : {};
    // A question is also how work is handed over: the teammate chooses to answer
    // it or to work on it.
    const result = await peerCommand({ type: 'ask', to, project, text: rest, ...chat });
    sentLine(result, shown, own ? sentToMine(shown) : `Sent to ${shown}. Their reply shows in this thread.`, Boolean(own));
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
  // No project open: name the folder ELU started in; the disk root picks another.
  async function createHere() {
    let location = null; try { location = projectFolder(startDirectory); } catch { /* The disk root is never a project. */ }
    if (!location) return chooseProject();
    const saved = savedProjectName(location.root);
    if (saved) { await switchProject(location); return true; }
    return nameHere(location);
  }
  // Bots keys act on the selected bot: Enter opens it, n makes one, x removes one.
  const botDialog = botDialogs({ prompt, listDialog, editSetting, yes, setMessage, colour, root: () => controller ? controller.repo.project ?? controller.repo.root : null, named: botModelName, scheduled: () => keepLoginItem() });
  async function botsAction(action) {
    botCache.at = 0;
    if (action === 'new') { const made = await botDialog.create(); if (made) botJump = made.name; return; }
    const bot = botRows[botsList.selected ?? 0];
    if (!bot) throw new Error('No bots yet. n makes one.');
    // A removed bot, or one whose schedule was taken away, no longer runs anywhere.
    try { if (action === 'remove') { await botDialog.remove(bot.name); return; } return await botDialog.open(bot.name); }
    finally { keepLoginItem(); }
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
    // A bot that leaves takes its schedule here with it; one that comes back brings it.
    if (task) keepLoginItem();
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
    let project = projectRows[projectsList.selected ?? 0];
    if (!project) throw new Error('No projects yet. n creates one.');
    if (action === 'bring') { if (!project.shared) throw new Error(`${project.name} is already on this computer.`); return bringShared(project); }
    // A project a computer of mine shares, as that computer lists it: the view of its sessions there applies.
    if (project.shared && project.sharers[0].mine && action === 'settings') project = sharedThere(project) ?? project;
    // A project a teammate shares: Enter opens its team board in Kanban. It is not this machine's to change.
    if (project.shared) {
      if (action !== 'settings') throw new Error(fitLine(`${project.name} is not on this computer. Enter opens its team board; c brings it here.`, 'Not on this computer. Enter opens its team board; c brings it here.'));
      sharedOpen = project.id; showView('kanban');
      const to = project.sharers[0].mine ? project.box : sharedWho(project);
      setMessage(fitLine(`${project.name}, ${project.by} on ${project.box}. The box below writes to ${to}.`, `The box below writes to ${to}.`));
      setImmediate(() => { if (!modal && !closing && view === 'kanban') { focusContent(Math.max(0, kanbanData.findIndex(column => column.items.length))); draw(); } }); return;
    }
    // A project of another computer of mine: Enter shows its sessions in Sessions. It is not this machine's to change.
    if (project.remote) {
      if (action !== 'settings') throw new Error(`${project.name} is on your other computer. Enter shows its sessions.`);
      // The cursor goes to its newest session, which then shows beside the list.
      const first = remoteApp.openProject(project.key, project.id);
      if (first) { barKey = first; wanted = null; }
      showView('tasks');
      setMessage(`Sessions of ${project.project} on @${project.machine}${first ? '' : ': none yet'}.`);
      // The list takes the keys once this Enter is done with, so it does not also reach the message box.
      setImmediate(() => { if (!modal && !closing && view === 'tasks') { board.focus(); draw(); } }); return;
    }
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
  // c on a shared project: asks where, clones it there from the git address its sharer told,
  // and registers it under its name. From then on the local project is its row. With no
  // address there is nothing to clone, and the line says what to do instead.
  async function bringShared(project) {
    const who = sharedWho(project);
    if (!project.address) {
      // A teammate on an older ELU sends no address though the project has one (it has a repository id).
      const older = project.sharers[0].older && project.repoId ? who === 'you' ? project.box : who : null;
      throw new Error(fitLine(`${clip(project.name, 30)} has no git address to copy from${older ? ` (${older} needs ELU 0.1.20 to send it)` : ''}. Put its folder on this computer, open a terminal in it and run ELU.`,
        ...(older ? [`No git address: ${older} needs ELU 0.1.20. Copy its folder here and run ELU.`] : []), 'No git address. Copy its folder here, open a terminal in it and run ELU.'));
    }
    if (typeof facade?.cloneProject !== 'function') throw new Error(PEER_MISSING);
    if (bringing) throw new Error('A project is being copied here. Wait for it to finish.');
    const value = (await prompt(`Bring ${project.name} here`, `${project.address}\n\nFolder to clone it into. ~ works. It is created.`, `~/${project.handle}`))?.trim();
    if (!value) return false;
    const folder = projectPath(value, startDirectory);
    bringing = true; setMessage(`Cloning ${project.name} into ${shortHome(folder)}…`); draw();
    let location;
    try { await facade.cloneProject(project.address, folder); location = projectFolder(folder); nameProject(location, project.name); }
    finally { bringing = false; }
    sharedKept.at = 0;
    await switchProject(location); resize();
    setMessage(fitLine(`${project.name} is here now, in ${shortHome(location.root)}. It is the active project.`, `${clip(project.name, 30)} is here now. It is the active project.`)); return true;
  }
  async function closeProject() {
    rememberDraft(); await controller?.close(); claim.release(); controller = null; claim = { readOnly: true, release() {} }; repo = null;
    selectedId = null; selectedRequest = null; following = null; usageEnabled = false; forgetVendors();
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
      // What its new sessions start with, then this computer's default, which a project that has not chosen uses.
      const start = active ? controller.startModel() : startModel(startConfig(root));
      const rows = [active ? ink('● Active project', 'orange', colour) : ink('Make active', 'text', colour), row('Instructions', line('instructions.md', settings.instructions)), row('Context', line('context.md', settings.context)), row('Default model', defaultRow(start)), row('This computer', computerRow()), ink(joinedTeamsOf(root).length ? 'Leave' : 'Archive', 'text', colour), ...(waiting.length ? [row('Shared files', `${count} · Enter to review`)] : [])];
      const picked = await listDialog(`Project ${name}`, rows, { selected });
      if (!picked) return;
      selected = picked.index;
      if (picked.index === 0) return makeActive(project);
      else if (picked.index === 1) await editSetting(`Instructions · ${name}`, settings.instructions, text => saveInstructions(root, text));
      else if (picked.index === 2) await editSetting(`Context · ${name}`, settings.context, text => saveContext(root, text));
      // Once nothing is left to review the row is gone: the cursor goes back to the top, not to the row that took its place.
      else if (picked.index === 3 || picked.index === 4) { try { await chooseDefault(picked.index === 3 ? 'project' : 'computer', [], project); } catch (error) { setMessage(error.message); } }
      else if (picked.index === 6) { await reviewProjectFiles(root, { declined: true }); if (!unusedTrust(root).length) selected = active ? 1 : 0; }
      else if (await archiveRow(project)) return;
    }
  }
  // A project's own settings and instructions are used only after the owner said so on this
  // machine (lib/project-trust.mjs). For each file that is new or changed he is shown its
  // text, or what changed, and asked once: use it, or not. Use it is offered once every page
  // was shown. A file of more than LONG_PAGES pages is not stepped through page by page: one
  // line says how long it is and where to read all of it, and the choice is offered at once,
  // with the pages still there. While a version he approved is in force, the choice against is
  // to keep it, and a file that is gone asks whether to go without. Esc decides later:
  // nothing changes meanwhile, and he is asked again.
  // declined: also the files he turned down before, from the project's own page.
  async function reviewProjectFiles(root, { declined = false } = {}) {
    if (modal || closing) return;
    // A dialog stops the message box reading; one opened while he was typing gives it back.
    const said = [], typing = Boolean(ask._reading); let unused = false;
    for (const file of declined ? unusedTrust(root) : pendingTrust(root)) {
      // The pages are made for the screen as it is: asked again when the window changes size
      // while the dialog is open, and kept until it does.
      let made = null;
      const paged = () => {
        if (made?.screen === `${screen.width}x${screen.height}`) return made;
        const wide = Math.min(88, screen.width - 4) - 5, lines = reviewLines(file).flatMap(line => wrapText(line, wide)), room = Math.max(4, screen.height - 12);
        const long = Math.ceil(lines.length / room) > LONG_PAGES, above = long ? [...wrapText(longNote(file), wide), ''] : [];
        const size = Math.max(2, room - above.length);
        return made = { screen: `${screen.width}x${screen.height}`, lines, long, above, size, pages: Math.ceil(lines.length / size) };
      };
      const place = `.elu-code/${file.name}`, kept = file.before !== null, keeping = `Keeping the approved ${place}`;
      const yes = file.gone ? 'Go without it' : 'Use it', no = kept ? 'Keep the approved one' : 'Do not use it';
      const title = `${file.gone ? 'Gone' : file.state === 'new' ? 'New' : file.state === 'changed' ? 'Changed' : 'Not in use'} · ${place}`;
      let picked, use = false;
      // Where he is in the file (from) and how far he has read (read) are shares of its text, so
      // the page on screen is the same part of it after the window changed size.
      for (let from = 0, read = 0, paging = false; ;) {
        const shownNow = () => {
          const { lines, long, above, size, pages } = paged(), page = Math.max(0, Math.min(pages - 1, Math.floor(from * lines.length / size + 1e-6)));
          read = Math.max(read, Math.min(1, (page + 1) * size / lines.length));
          const all = long || read >= 1, next = `Next page (${page + 1} of ${pages})`;
          const rows = long ? [yes, no, page + 1 < pages ? next : 'First page'] : [all ? yes : next, no, ...(all && pages > 1 ? ['Read it again'] : [])];
          return { rows, against: rows.indexOf(no), all, long, page, pages, step: size / lines.length, notes: [...above, ...lines.slice(page * size, (page + 1) * size)] };
        };
        const first = shownNow();
        // Stepping through a long file, the cursor stays on the next page.
        picked = await listDialog(title, () => shownNow().rows, { selected: paging ? first.against + 1 : first.all ? first.against : 0, hint: 'enter choose · esc decide later', notes: () => shownNow().notes, shown: true });
        const { against, all, long, page, pages, step } = shownNow();
        if (!picked || picked.index === against) break;
        if (long && picked.index === against + 1) { from = page + 1 < pages ? (page + 1) * step : 0; paging = true; continue; }
        if (!all) { from = (page + 1) * step; continue; }
        if (picked.index === against + 1) { from = 0; read = 0; continue; }
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
    // A shared project's team board is read here: Enter opens a card, n goes to the box that writes to its sharer.
    const shared = sharedNow();
    if (shared) {
      if (action === 'new') { focusInput(); return; }
      const item = kanbanData[index]?.items[kanbanLists[index].selected ?? 0];
      if (!item) throw new Error(`Nothing here yet. The box below writes to ${shared.sharers[0].mine ? sharedBox(shared) : sharedWho(shared)}.`);
      if (action === 'open') return openCard(item);
      throw new Error(`That is ${remote(item.teammate?.name, 24) || 'a teammate'}'s ${item.session ? 'session' : 'Task'}. Enter opens it to read.`);
    }
    if (!controller && (action !== 'new' || !await createHere())) { if (!controller) throw new Error(NO_PROJECT); return; }
    const column = kanbanData[index], item = column?.items[kanbanLists[index].selected ?? 0], repo = controller.repo;
    // A view-only window opens a card to read it. It adds, edits, moves and removes nothing: the refusal says which window does.
    if (action !== 'open' || item && !item.teammate && item.card?.column === 'todo') controller.writable();
    if (action === 'new') {
      const text = await prompt('New task', 'What should be done? It waits in To do until you start it with Shift+→.', '');
      if (!text?.trim()) return; addCard(repo, text); setMessage('Added to To do. Shift+→ on it starts it.'); return;
    }
    if (!item) throw new Error(viewOnly() ? 'Nothing here.' : 'Nothing here. n adds a task to To do.');
    // A teammate's Task is theirs: Enter opens it to read, and no key changes it.
    if (item.teammate) {
      if (action === 'open') return openCard(item);
      // One of mine on my other computer (session.own) is mine, and moves only there.
      if (item.teammate.mine && item.session?.own === true) throw new Error(`That is your session on ${remote(item.teammate.box, 24) || `@${remote(item.teammate.name, 40)}`}. Enter opens it; it changes only on that computer.`);
      throw new Error(`That is ${remote(item.teammate.name, 40) || 'a teammate'}'s ${item.session ? 'session' : 'Task'}. Enter opens it to read; it changes only on their machine.`);
    }
    if (action === 'open') {
      if (item.card?.column === 'todo') {
        const text = await prompt('Edit task', 'Change the task. Shift+→ on it starts it.', item.card.text);
        if (text?.trim() && text.trim() !== item.card.text) { editCard(repo, item.card.id, text); setMessage('Saved.'); } return;
      }
      if (item.task || item.request) return openCard(item);
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
  // What each run of a schedule made in the form gets. Out of the form, what /schedule would
  // save: the open session's bots, else what a new session starts with.
  function scheduleRuns() {
    if (!controller) return '';
    const form = composing(), mode = form ? scheduleMode() : capMode(defaultMode(), 'auto'), chosen = form ? composeBots : botsOf(openTask()), place = form ? composePlace : null;
    // A bot with its own schedule is left out of the runs (runBots).
    let bots = chosen, own = [];
    try { bots = runBots(chosen); own = chosen.filter(name => !bots.includes(name) && getBot(name)); } catch { /* An unreadable bots file: the names as chosen. */ }
    const where = place?.kind === 'branch' ? ` on branch ${place.branch}` : '';
    const left = own.length ? ` ${own.map(name => `@${name}`).join(' ')} ${own.length === 1 ? 'runs on its own schedule, so it is' : 'run on their own schedules, so they are'} left out.` : '';
    return `Each run starts a new session in ${snapshot?.name ?? projectName(controller.repo.root)}${where} with your message, ${nameOf((form ? composeModel : null) ?? controller.defaultModel())}, ${LABELS[mode]} and ${bots.length ? bots.map(name => `@${name}`).join(' ') : 'no bots'}.${left} It does not see this chat.`;
  }
  // The mode each run of the form's schedule gets: the one the owner picked, Full access
  // included, else Approve for me at most, since each run has nobody watching.
  const scheduleMode = () => composePicked ? formMode() : capMode(formMode(), 'auto');
  // The form's When, set to a time /schedule read. A schedule runs unattended, so it gets Full
  // access only when the owner picked it, and never runs in your checkout as it is.
  function useWhen(when, text) {
    composeWhen = when && { ...when, text };
    const capped = when && composeMode === 'full' && !composePicked; if (capped) { composeMode = 'auto'; belowFull('auto'); }
    const moved = when && composePlace.kind === 'here'; if (moved) composePlace = { kind: 'worktree' };
    setMessage(when ? `Runs ${when.label}, next ${dateText(nextRun(when))}. ${capped ? SCHEDULE_CAP : moved ? 'It runs in a new worktree, never in your checkout as it is.' : 'Write the message below.'}` : 'Sends now.');
  }
  // When the New task form's message goes: a time from the list, or one typed in Other time.
  async function setWhen() {
    const rows = [...SCHEDULE_PRESETS.map(([when, text]) => ink(when.padEnd(14), 'text', colour, true) + ink(text, 'muted', colour)), ink('Other time…', 'text', colour, true)];
    const picked = await listDialog('When', rows, { notes: [`Times are this computer’s local time. ${scheduleRuns()}`] });
    if (!picked) return;
    let answer = SCHEDULE_PRESETS[picked.index]?.[0];
    if (!answer) {
      answer = await prompt('When', ['When should this message be sent?', '', 'now               send it now', 'in 30m            once, in 30 minutes', 'daily 9:00        every day', 'weekdays 9am      Monday to Friday', 'mon,thu 14:30     chosen days', 'every 2h          every 2 hours (15m to 7d)', 'tomorrow 15:00    once', '2026-12-01 9:00   once', '', 'Times are this computer’s local time. Each run starts a new session that does not see this chat.'].join('\n'), composeWhen?.text ?? '');
      if (answer === null) return;
    }
    useWhen(parseWhen(answer), answer.trim());
    focusInput();
  }
  // inline: the message came with /schedule, not from the box, so the form's draft stays.
  // Either way the schedule used the form's settings up, so the next form starts over.
  // Full access is said and asked once before it is saved, unless he said yes when he picked it.
  // A place a schedule never runs in is refused first, so he is never asked about one that
  // cannot be saved.
  async function scheduleTask(text, { inline = false } = {}) {
    const runs = scheduleRuns(), mode = scheduleMode();
    if (composePlace.kind === 'here') throw new Error(NO_HERE);
    if (mode === 'full' && !composeFullOk) {
      if (!await confirmScheduleFull()) { if (!inline || !ask.getValue()) ask.setValue(text); setMessage('Not saved. /permissions changes its mode; Enter saves it.'); focusInput(); return; }
      composeFullOk = true;
    }
    const row = saveSchedule({ root: controller.repo.root, project: snapshot.name, goal: text.trim(), when: composeWhen, permissions: mode, picked: composePicked, ...(composeModel ? { model: composeModel } : {}), bots: composeBots, place: composePlace });
    const draft = inline ? ask.getValue() : '';
    resetForm(); if (!inline) { drafts.delete(draftKey()); ask.clearValue(); } refreshAwake();
    let note = '';
    try { const result = loginItem.install(); if (!result.installed) note = ` ${result.reason}`; }
    catch (error) { loginItemOn = null; note = ` It runs only while ELU is open: ${error.message}`; }
    // Beside the list the box is the new session's, and the list keeps what it holds as its draft.
    showView('tasks'); if (draft) { drafts.set(draftKey(), draft); ask.setValue(draft); } focusInput();
    // A one-time run's label already says when it is. The line holds two rows: what keeps it
    // from running while ELU is closed is said in place of what each run gets, or it is cut off.
    setMessage(`Scheduled ${row.when.label}${row.when.kind === 'once' ? '' : `, next ${dateText(new Date(row.nextRunAt))}`}. ${note ? note.trim() : runs}`);
  }
  // r runs it now, p pauses or resumes it, x deletes it, Enter opens its last run.
  async function scheduleAction(row, action) {
    const { schedule } = row;
    if (action === 'open') {
      // A run names its schedule from its start; the schedule keeps its number a moment later.
      const runs = snapshot.projects.find(project => project.root === row.root)?.tasks ?? [];
      const task = (schedule.lastTaskId && runs.find(value => value.id === schedule.lastTaskId)) || runs.findLast(value => value.scheduleId === schedule.id);
      if (!task) throw new Error(schedule.runs ? 'Its last run is not in Sessions any more. r runs it now.' : 'No runs yet. r runs it now.');
      return openRow({ kind: 'task', root: row.root, id: task.id });
    }
    if (action === 'retry') { runScheduleNow(schedule.id, new Date(), { start: conduct }); setMessage('Running it now. It shows under Queued, then Running.'); return; }
    if (action === 'publish') {
      const value = pauseSchedule(schedule.id, schedule.enabled), item = keepLoginItem(); refreshAwake();
      setMessage(value.enabled ? `Resumed. Next run ${dateText(new Date(value.nextRunAt))}.${item?.installed === false && item.reason ? ` ${item.reason}` : ''}` : 'Paused. p resumes it.'); return;
    }
    if (action === 'stop') {
      if (!await yes('Delete schedule', `${schedule.when.label} · ${projectName(row.root)}\n${schedule.goal}\n\nPast runs stay in Sessions.`)) return;
      removeSchedule(schedule.id); keepLoginItem();
      refreshAwake(); setMessage('Schedule deleted.'); return;
    }
    throw new Error('r runs it now, p pauses it, x deletes it, each followed by Enter.');
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
      composeMode = mode; composePicked = true; composeFullOk = mode === 'full' && Boolean(composeWhen); if (composePlace.kind === 'here' && mode !== 'full') composePlace = { kind: 'worktree' };
      belowFull(mode);
      setMessage(`${LABELS[mode]} for this ${composeWhen ? 'schedule' : 'session'}.`); return;
    }
    if (row.type === 'place') { const place = await pickPlace({ mode: composeMode, schedule: Boolean(composeWhen) }); if (place) { composePlace = place; setMessage(`${placeText(place)} for this ${composeWhen ? 'schedule' : 'session'}.`); } return; }
    if (row.type === 'folders') {
      if (action === 'remove') { composeFolders = []; setMessage('No extra folders.'); return; }
      const folders = await pickFolders(composeFolders, formMode()); if (folders) { composeFolders = folders; setMessage(folders.length ? `The model reads ${folders.map(shortHome).join(', ')} this session.` : 'No extra folders.'); } return;
    }
    if (row.type === 'model') { if (action === 'remove') return; await readAllModels(); const now = composeModel ?? controller.defaultModel(), choice = await pickModel(now, `The new session uses ${nameOf(now)} (${modelText(now)}).`); if (choice) useModel(choice); return; }
    if (row.type === 'bots') { if (action === 'remove') { composeBots = []; setMessage('No bots in this session.'); return; } return pickBots(); }
  }
  // The Model picker: every model a session can be given, narrowed to what is typed. A name
  // that is not listed is taken as vendor:name. null when closed with nothing chosen.
  // none: a default is being chosen, and this says what choosing none means; that row gives NO_CHOICE.
  const NO_CHOICE = Object.freeze({ none: true }), saysNone = text => String(text ?? '').trim().toLowerCase() === 'none';
  async function pickModel(current, said, { none = null } = {}) {
    const choices = modelChoices(), rows = [...choices.map(row => ({ name: row.name, note: [row.vendor, row.note].filter(Boolean).join(' · ') })), ...(none ? [{ name: 'none', note: none }] : [])];
    if (!choices.length) throw new Error('No vendor command line is installed, so there is no model to choose yet.');
    const check = text => { if (!text.trim() || none && saysNone(text)) return null; try { findModel(text); return null; } catch (error) { return error.message; } };
    const answer = await prompt('Model', `${said}\nChoose one, or type vendor:name for a model that is not listed.`, choiceName(current, choices), { suggest: text => matchModels(rows, text), check });
    return !answer?.trim() ? null : none && saysNone(answer) ? NO_CHOICE : findModel(answer);
  }
  // What new sessions start with, the model alone: never where it came from. A saved default
  // whose vendor is not installed here is said first, then what is used instead. Kept short:
  // outside a list of sessions the line under the chat is one row. start is lib/models.mjs
  // startModel; name the project's, null for this computer.
  function defaultSaid(start, name) {
    const model = `${nameOf(start)} (${modelText(start)})`, gone = passedOver(start.missing, nameOf);
    if (start.from === 'none') return [gone, 'No vendor command line is installed, so new sessions cannot start yet.'].filter(Boolean).join(' ');
    const said = name ? `New sessions in ${name} start with ${model}.`
      : `This computer's default is ${model}.`;
    return [gone, said].filter(Boolean).join(' ');
  }
  // The same as a row of a project's settings says it: the project's row, then this computer's.
  function defaultRow(start) {
    if (start.from === 'none') return 'no vendor command line is installed';
    const gone = start.missing.find(row => row.from === 'project');
    if (gone) return `${nameOf(start)} · ${nameOf(gone)} is chosen, but ${VENDOR_NAMES[gone.vendor]} is not installed`;
    return nameOf(start);
  }
  function computerRow() {
    const own = computerDefault(), start = startModel(null);
    if (own && start.from !== 'computer') return `${start.from === 'none' ? '' : `${nameOf(start)} · `}${nameOf(own)} is chosen, but ${VENDOR_NAMES[own.vendor]} is not installed`;
    if (start.from === 'none') return 'no vendor command line is installed';
    return nameOf(start);
  }
  // Chooses a default model: a project's (/model default, the active project's unless another
  // is given) or this computer's (/model computer), which every project that has not chosen
  // uses. A name sets it, none goes back to no choice, and nothing typed opens the picker.
  async function chooseDefault(scope, words = [], project = null) {
    // Each vendor's own list is read first, beside the app: a row of a project's settings opens this too.
    await readAllModels();
    const computer = scope === 'computer', active = !project || controller?.repo.root === project.root;
    if (!computer && active && !controller) throw new Error(NO_PROJECT);
    // A name may be the one the model is shown by, of several words (/model computer opus 5.5); it takes no message.
    const named = words.length && !(words.length === 1 && saysNone(words[0])) ? modelWords(words, { label: nameOf }) : null;
    if (named ? named.count < words.length : words.length > 1) throw new Error(`Use /model ${computer ? 'computer' : 'default'} <name>, or none.`);
    const start = () => computer ? startModel(null) : active ? controller.startModel() : startModel(startConfig(project.root));
    const name = computer ? null : active ? controller.snapshot().name : project.name;
    const choice = named ? named.choice : words.length ? NO_CHOICE : await pickModel(start(), defaultSaid(start(), name), { none: computer ? "clears this computer's default" : "clears this project's default" });
    if (!choice) return;
    const value = choice === NO_CHOICE ? null : choice;
    if (computer) saveComputerDefault(value); else if (active) controller.setDefaultModel(value); else saveProjectDefault(projectFolder(project.root), value, startConfig(project.root));
    setMessage(defaultSaid(start(), name));
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
      let rows = []; try { rows = await cachedVendors(); } catch { rows = []; }
      const picked = await listDialog('Add a model · runs on', vendors.map(name => { const row = rows.find(item => item.vendor === name); return ink(name.padEnd(8), 'text', colour, true) + ink(row ? vendorText(row) : VENDOR_NAMES[name], 'muted', colour); }));
      if (!picked) return;
      vendor = vendors[picked.index];
    }
    const models = await readBotModels(vendor), listed = name => models.some(row => row.name === name);
    const check = text => text.trim() ? modelProblem(vendor, text.trim()) : 'Name the model.';
    const answer = (await prompt('Add a model', `A model ${VENDOR_NAMES[vendor]} knows by name. /model offers it from now on.`, '', models.length ? { check, suggest: text => matchModels(models, text), warn: text => listed(text.trim()) ? null : `${text.trim()} is not a model ${vendor} lists.` } : { check }))?.trim();
    if (!answer) return;
    const choice = listed(answer) ? { vendor, model: answer } : rememberModel(vendor, answer);
    if (openTask() || composing()) return useModel(choice);
    setMessage(`Added ${nameOf(choice)} (${modelText(choice)}). /model ${choiceName(choice, modelChoices())} uses it in a session.`);
  }
  // /model shows or chooses the model of the open session, or of the new session form.
  // default <name> sets what new sessions of this project start with; add adds one by name.
  // A name may be the one the model is shown by (/model opus 5.5), and words after it are a
  // message, sent to the session on that model (/model sonnet fix the build).
  async function modelCommand(args, text = args.join(' ')) {
    if (!controller) throw new Error(NO_PROJECT);
    if (args[0] === 'add') { if (args.length > 1) throw new Error('Use /model add.'); return addModel(); }
    // computer <name>: this computer's default. default alone picks the project's, and none clears either.
    if (args[0] === 'computer' || args[0] === 'default' && (args.length === 1 || args.length === 2 && saysNone(args[1]))) return chooseDefault(args[0] === 'computer' ? 'computer' : 'project', args.slice(1));
    if (args[0] === 'default') {
      const named = args.length > 1 ? modelWords(args.slice(1), { label: nameOf }) : null;
      if (named && named.count < args.length - 1) throw new Error('Use /model default <name>.');
      const before = controller.defaultModel(), choice = named ? named.choice : await pickModel(before, `New sessions in ${controller.snapshot().name} start with ${nameOf(before)} (${modelText(before)}).`);
      if (!choice) return;
      const saved = controller.setDefaultModel(choice);
      setMessage(`New sessions in ${controller.snapshot().name} start with ${nameOf(saved)} (${modelText(saved)}).`); return;
    }
    // Over a session on another computer of mine, the model is that session's and one of that
    // computer's: the name goes there as typed, with the message after it, and is read there.
    const here = remoteHere();
    if (here && args.length) { setMessage(await remoteApp.send(here, text.trim(), { model: true })); return; }
    const named = args.length ? modelWords(args, { label: nameOf }) : null;
    if (!openTask() && !composing()) {
      if (!named) { setMessage(`${defaultSaid(controller.startModel(), controller.snapshot().name)} /model default <name> changes it.`); return; }
      // A name with no session open, where the box starts a new one: the new session form
      // opens on that model, so the message typed next goes to it.
      if (!sessionBox()) throw new Error('Open a session, or /new. /model default <name> sets new sessions.');
      await newTaskForm(); if (!composing()) return;
    }
    const task = openTask(), now = modelNow();
    const choice = named ? named.choice : await pickModel(now, `${task ? `This session uses ${modelOf(task)}` : `The new session uses ${nameOf(now)}`} (${modelText(now)}).`);
    if (!choice) return;
    useModel(choice);
    // The message is the rest of the text as it was typed. Sending it clears the line, so the
    // line that names the model it went to is said once it is sent, and stays until the answer.
    let rest = text.trimStart(); for (let word = 0; word < (named?.count ?? 0); word += 1) rest = rest.replace(/^\S+\s*/, '');
    if (rest.trim()) { const before = following; await submit(rest.trim()); if (task && following && following !== before) setMessage(`${nameOf(choice)} from this message.`); }
  }
  // Edits that are not verified are checked first. A project with no checks of its own is asked
  // for its test or build command, and asked again while the one given here fails; a project's
  // own checks are run as they are. What is still not verified after that is refused, as before.
  // checkAsked: the command last given at that prompt, by session, while the app runs.
  const checkAsked = new Map();
  async function publishCurrent() {
    if (!controller || !selectedId || selectedRequest) throw new Error('Open finished editing work from Sessions first.');
    const id = selectedId, open = controller.snapshot().tasks.find(row => row.id === id);
    // What the agent pushed itself, with a pull request open for it, has nothing left to publish.
    const there = open && open.kind !== 'conversation' ? controller.published(id) : null;
    if (there) { setMessage(there.message); return; }
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
    if (plan.published) { setMessage(plan.message); return; }
    // Work done with Full access says so before it goes out.
    const full = task?.permissions === 'full' || (task?.runs ?? []).some(run => run.role === 'lead' && run.permissions === 'full') ? `${modelOf(task)} ran with Full access.\n` : '';
    if (await yes('Push and open draft PR', `Commit: ${plan.commit}\nDestination: ${plan.destination.url}\nRef: ${plan.destination.ref}\nBase: ${plan.destination.base}\n\n${plan.title}\n${full}\nPush and open a draft PR with the evidence? [y/N]`)) {
      setMessage('Pushing… /stop stops it.');
      // A push that was stopped says what happened in one line, and /publish is not put back in the box.
      let result; try { result = await controller.push(id, plan.confirmationId); } catch (error) { if (!error.pushStopped) throw error; if (!closing) setMessage(error.message); return; }
      setMessage(`Pushed ${result.commit}; draft PR ${result.pr}`);
    }
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
      const answer = given ?? await prompt('Rename session', `One line of up to ${TITLE_MAX} characters. It shows in the list and the title. Leave it empty to go back to the name ELU gave it.`, typed, { check: nameProblem });
      if (answer == null) return;
      try {
        const saved = setTitle(location, task.id, answer);
        setMessage(saved.titleBy === 'owner' ? `Renamed to ${saved.title}.` : saved.title ? `The session is named ${saved.title} again.` : 'The session is named after your first message again.'); return;
      } catch (error) { if (given != null) throw error; setMessage(error.message); typed = answer; }
    }
  }
  // The same over a session on another computer of mine (row): that computer renames,
  // archives or brings it back with its own code (lib/peer/remote.mjs), with the same lines.
  // action: rename, close or unarchive. The box opens with its name only when someone chose it.
  async function remoteEdit(row, action, given = null) {
    const verb = action === 'close' ? 'archive' : action, older = remoteApp.editLine(row, verb), named = value => `"${firstWords(value || 'Session', 40)}"`;
    if (older) throw new Error(older);
    if (action === 'unarchive') {
      if (!row.archived) return;
      const { shown } = await remoteApp.archive(row, false); barKey = row.key; setMessage(`${named(shown ?? row.remote.title)} is back in the list.`); return;
    }
    if (action === 'close') {
      if (row.archived) return setMessage(`${named(row.remote.title)} is archived already. u brings it back.`);
      if (row.group === 1) throw new Error(`${named(row.remote.title)} is running. Stop it first with /stop.`);
      const { shown } = await remoteApp.archive(row, true);
      setMessage(`Archived ${named(shown ?? row.remote.title)}. /archived lists it; a new message brings it back.`); return;
    }
    const own = row.named && typeof row.remote.title === 'string' ? row.remote.title.trim() : '';
    const answer = given ?? await prompt('Rename session', `One line of up to ${TITLE_MAX} characters. It shows in the list and the title. Leave it empty to go back to the name ELU gave it.`, own.length <= TITLE_MAX ? own : '', { check: nameProblem });
    if (answer == null) return;
    const problem = nameProblem(answer); if (problem) throw new Error(problem);
    const saved = await remoteApp.rename(row, answer);
    setMessage(saved.titleBy === 'owner' ? `Renamed to ${saved.title}.` : saved.title ? `The session is named ${saved.title} again.` : 'The session is named after your first message again.');
  }
  // /stop stops the open session's turn, and the messages the owner sent while it ran then go
  // at once, together and in the order sent: they are his words, so /stop never drops them
  // (↑ in the message box takes one back). Stopping changes nothing in the project, so it works
  // in a view-only window too. A session on another computer of mine under the cursor stops
  // there, whatever this window may change here.
  async function stopCurrent(given) {
    if (shellRun) { shellRun.run.stop(); setMessage('Stopping the command.'); return; }
    const there = given === undefined ? remoteHere() : null;
    if (there) { setMessage(await remoteApp.action(there, 'stop')); return; }
    if (!controller) throw new Error(NO_PROJECT);
    const root = controller.repo.root;
    if (selectedRequest) {
      controller.writable();
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
    // A push this window runs in the session stops, with its pre-push guards (lib/publish.mjs).
    if (id && controller.stopPush(id)) { setMessage('Stopping the push.'); return; }
    const task = id && controller.snapshot().tasks.find(task => task.id === String(id));
    const rows = id ? pendingRequests(root) : [], pending = rows.filter(row => row.continuationTaskId === String(id) && row.state === 'queued' && !row.standupFor);
    const waiting = pending.length > 1 ? `Your ${pending.length} waiting messages go` : 'Your waiting message goes', back = pending.length > 1 ? '↑ takes one back' : '↑ takes it back';
    // A turn of this session the conductor is starting this instant: its request says so
    // before the session says it is working. The stop is sent all the same, and the conductor
    // reads it at its next look, when the turn is there to stop.
    const starting = rows.find(row => row.continuationTaskId === String(id) && row.state === 'starting');
    if (task && (['running', 'preparing'].includes(task.state) || starting)) {
      // The turn that is being stopped: its request, or the time it began when it has none.
      const turn = `${root}\0${task.id}\0${starting?.id ?? rows.find(row => row.taskId === task.id && row.state === 'running')?.id ?? task.activeSince ?? ''}`, again = stopAsked === turn;
      stopAsked = turn; sendCommand({ type: 'stop', root, taskId: task.id }); conduct();
      setMessage(pending.length ? `${again ? 'Still stopping' : 'Stopping'}. ${waiting} as soon as it stops${pending.length > 1 ? ', in order' : ''}${again ? '.' : ` · ${back}.`}` : 'Stopping. Changes and chat history are kept.'); return;
    }
    // Nothing runs, and what waits goes now.
    if (pending.length) { conduct(); setMessage(`Nothing is running in this chat. ${waiting} next${pending.length > 1 ? ', in order' : ''} · ${back}.`); return; }
    if (task?.pushRun) throw new Error('Another ELU window is pushing this session: /stop there stops it.');
    throw new Error('Nothing is running in this chat.');
  }
  // Whether the turn running in the session takes this waiting message (lib/runner.mjs
  // inboxFeed): it listens, and the message is a typed one for the speaker of that turn that
  // was not taken back from it.
  // Whether a waiting message is answered beside the running turn (lib/message-aside.mjs):
  // that turn takes no message while it works, and the message is a typed one for its speaker.
  function answersBeside(task, row) {
    return task?.state === 'running' && task.activeDeaf === true && row.state === 'queued' && typedRequest(row) && !row.back && (row.bot ?? null) === (botOfKey(task.activeRole ?? '') ?? null);
  }
  // In a turn's first moments it has not said yet whether it takes messages: one sent then is read by the turn or answered beside it.
  function notSaidYet(task, row) {
    return ['running', 'preparing'].includes(task?.state) && task.activeInbox !== true && task.activeDeaf !== true && row.state === 'queued' && typedRequest(row) && !row.back && (row.bot ?? null) === (botOfKey(task.activeRole ?? '') ?? null);
  }
  function goesToTurn(task, row) {
    return task?.state === 'running' && task.activeInbox === true && row.state === 'queued' && typedRequest(row) && !row.back && (row.bot ?? null) === (botOfKey(task.activeRole ?? '') ?? null);
  }
  // Whether the turn of a session here runs a command now, from the steps of its run so far.
  function commandRuns(task, repo = controller?.repo) {
    return Boolean(repo) && task?.state === 'running' && typeof task.activeLog === 'string' && path.dirname(task.activeLog) === taskDir(repo, task.id) && runsCommand(runSteps(task.activeLog, { cwd: task.worktree }));
  }
  // The open session's messages of the owner's that wait while its turn works: on that turn's
  // input for its next step, or for the turn to end. Enter in an empty box sends them now.
  function heldBack(rows = snapshot?.queue ?? []) {
    if (!controller || view !== 'chat' || !selectedId || selectedRequest) return [];
    const task = snapshot?.tasks?.find(row => row.id === String(selectedId));
    if (!task || !['running', 'preparing'].includes(task.state)) return [];
    return rows.filter(row => row.continuationTaskId === task.id && row.state === 'queued' && !row.scheduled && !row.origin && !row.standupFor);
  }
  // Enter in an empty box over a session where a message of the owner's waits. A turn that
  // takes it and can be told to take it now (activeSendNow, Claude Code) is told, with Claude
  // Code's own message for it (lib/runner.mjs inboxFeed): the command it waits on moves to the
  // background and the turn goes on with the message, nothing stopped. Any other turn stops
  // as /stop stops it, the session and its changes kept, and what waits starts the next turn
  // at once, in the order sent, in the vendor session the turn stopped in where it can be
  // picked up (lib/runner.mjs pickup). Either is sent from a read-only view too: the messages
  // were sent already. False when nothing waits.
  function sendWaitingNow() {
    let all; try { all = controller ? pendingRequests(controller.repo.root) : []; } catch { all = []; }
    const rows = heldBack(all);
    if (!rows.length) return false;
    const root = controller.repo.root, id = String(selectedId), task = snapshot.tasks.find(row => row.id === id), many = rows.length > 1;
    if (task?.activeSendNow === true && rows.every(row => goesToTurn(task, row))) {
      let marked = 0; try { marked = sendTypedNow(root, id, botOfKey(task.activeRole ?? '') ?? null); } catch { marked = 0; }
      // Codex takes it by stopping the command it runs (activeNowStops, lib/codex-live.mjs); Claude Code moves that command to the background.
      setMessage(marked ? `Sending now. ${task.activeNowStops === true ? 'The command that is running stops, and the' : 'The'} turn goes on with ${many ? 'them' : 'it'}.` : 'The running turn already took it.');
      return true;
    }
    // The turn being stopped, as /stop names it, so a /stop after this says it is still stopping.
    stopAsked = `${root}\0${id}\0${all.find(row => row.taskId === id && row.state === 'running')?.id ?? task?.activeSince ?? ''}`;
    sendCommand({ type: 'stop', root, taskId: id }); conduct();
    setMessage(`Sending now. This turn stops and your message${many ? 's start' : ' starts'} the next one · ↑ takes ${many ? 'one' : 'it'} back.`);
    return true;
  }
  // The newest message the owner sent to a session that has not started yet: the one Up in
  // the message box takes back. A bot's scheduled turn is not his to take back here.
  function waitingMessage(id, rows) {
    return rows.filter(row => row.continuationTaskId === String(id) && row.state === 'queued' && !row.scheduled && !row.origin && !row.standupFor)
      .sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1) || Date.parse(a.queuedAt ?? a.createdAt) - Date.parse(b.queuedAt ?? b.createdAt)).at(-1) ?? null;
  }
  // Takes the open session's newest waiting message back and returns it as it was typed,
  // or null when none waits or it has just been sent. One that is on the running turn's input
  // (turn) is taken back there first, with Claude Code's own message for it (lib/runner.mjs
  // inboxFeed). Its answer comes in a moment, so { later } is returned: a promise of the text;
  // of null when the turn had taken it; of false when the box was typed in meanwhile, and the
  // message waits as it did; of undefined when no answer came yet.
  let takingBack = false;
  function takeBack(free = () => true) {
    if (!controller || claim.readOnly || view !== 'chat' || !selectedId || selectedRequest) return null;
    if (takingBack) return { later: null };
    let row = null;
    try {
      const root = controller.repo.root, id = String(selectedId); row = waitingMessage(id, pendingRequests(root));
      const task = row?.turn && !row.back ? controller.snapshot().tasks.find(value => value.id === id) : null;
      if (task?.state === 'running' && task.activeInbox === true && updateRequest(root, row.id, { cancel: new Date().toISOString(), now: undefined }, { from: ['queued'] })) {
        takingBack = true;
        return { later: takenFromTurn(root, row.id, free).finally(() => { takingBack = false; }) };
      }
      row &&= takeRequest(root, row.id);
    } catch { return null; }
    return row ? typedGoal(row) : null;
  }
  async function takenFromTurn(root, id, free) {
    for (const started = Date.now(); Date.now() - started < 5000;) {
      await new Promise(resolve => setTimeout(resolve, 80));
      let row; try { row = pendingRequests(root).find(value => value.id === id); } catch { continue; }
      if (!row || row.state !== 'queued') return null;
      // The vendor has it and cannot give it back (Codex): the turn reads it at its next step.
      if (row.fixed && !row.back) return null;
      if (!row.back && row.turn) continue;
      if (!free()) { updateRequest(root, id, { back: undefined, cancel: undefined }, { from: ['queued'] }); return false; }
      const taken = takeRequest(root, id); return taken ? typedGoal(taken) : null;
    }
    return undefined;
  }
  async function showDetails(location, task) {
    const data = taskDetails(location, task.id);
    const response = task.reply ?? task.result;
    await prompt('Session details: diff / checks / review / log', [sessionGoal(task), `State: ${task.state}`, `PR: ${task.pr ?? 'not published'}`, `Question: ${response?.question ?? 'none'}`, errorText(task), '\nRESPONSE', response?.summary ?? '', '\nREQUESTS', ...(task.messages ?? []).map(row => row.bot ? `${tagged(`@${row.bot}`, modelTag(wroteIt(row))).title}: ${row.text}` : row.to ? `You → ${row.to}: ${row.text}` : teammateText(row) ? `${row.from}: ${teammateText(row)}` : row.text), '\nDIFF', data.diff || '(no diff)', '\nCHECKS', ...data.checks.map(row => `${row.name}: ${row.status} ${(row.details ?? []).join('; ')}`), '\nREVIEW', ...data.reviews.flatMap(row => [`${tagged(roleLabel(row.role ?? 'reviewer'), modelTag(wroteIt(row))).title} round ${row.round}: ${row.result.summary}`, ...row.result.comments.map(comment => `${comment.severity}: ${comment.body}`)]), '\nLOG', ...data.logs.map(log => `${roleLabel(log.role)}:\n${log.text}`)].join('\n'));
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
    if (returnTo === 'tasks') { barKey = openKey = row.key; ownSeen = entered = ownKey(); wanted = null; }
    resize(); focusInput();
  }
  // Removes the messages a row holds; a teammate's one is also dropped with them.
  async function removeHeld({ root, requests = [], item = null }) {
    for (const request of requests) {
      removeRequest(root, request.id);
      if (request.origin) await peerCommand({ type: 'discard', id: item?.id ?? request.origin.a2aTaskId }).catch(() => {});
    }
  }
  // The keys of the selected row that also work while its text beside the list has the focus:
  // y and n where it waits on them, and c, which takes it away.
  function paneKeys() {
    const row = view === 'tasks' && listed() ? selectedBoardRow() : null, actions = row ? rowActions(row) : [], keys = actions.map(([key]) => key);
    const answers = keys.includes('y') && keys.includes('n');
    return actions.filter(([key]) => answers ? ['y', 'n', 'c'].includes(key) : key === 'c');
  }
  // Task keys act on the selected row in any project without opening it.
  async function boardAction(action) {
    const row = selectedBoardRow();
    // d shows what a session on another computer changed in its own tab, as a session here does.
    // A cursor that just moved onto the row is the pane's session from the next draw on, so that draw comes first.
    // Esc then goes back to where d was typed: its chat beside the list, or its row.
    if (row?.kind === 'remote' && action === 'diff') { const from = screen.focused === activity ? activity : board; if (remoteHere()?.key !== row.key) draw(); showChanges({ focus: true }); changesFrom = from; return; }
    // e renames it there, c archives it there and u brings it back, as for a session here. c on
    // one only started from here and not listed there takes it off this list (below).
    if (row?.kind === 'remote' && (['rename', 'unarchive'].includes(action) || action === 'close' && (row.listed || row.archived))) return remoteEdit(row, action);
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
    // The row of a session that waits on an approval takes y and n too, as its chat says: y or n, then Enter.
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
    // c takes away whatever the list shows: a teammate's message is declined, and they are told.
    if (action === 'close' && (row.kind === 'peer' || peerIncoming(row))) return decidePeer(row, 'decline');
    if (row.kind === 'schedule') return scheduleAction(row, action);
    const live = row.kind === 'task' && ['running', 'preparing'].includes(row.task.state);
    // A session whose message of yours did not run: r sends that message again, s removes it.
    if (row.kind === 'task' && row.request && !live && !row.archived) {
      if (action === 'retry') { if (!await homeOk(row.root, row.id)) return; if (!retryRequest(row.root, row.request.id)) throw new Error('That message is no longer waiting.'); conduct(); setMessage('Queued again.'); return; }
      if (action === 'stop') { await removeHeld(row); setMessage('Removed.'); return; }
    }
    if (row.kind === 'peer') {
      if (row.item.kind === 'standup') throw new Error('y asks your sessions for their update. n declines.');
      // e on a reply or a result that waits to go opens its text to edit, as in Chats.
      if (action === 'rename' && row.item.kind === 'held') return editHeld(row.item);
      if (action !== 'open') throw new Error('Enter reads it. n dismisses it.');
      const key = await peerDetails({ type: 'thread', ...row.item }), decision = { y: 'answer', w: 'work', n: 'decline' }[key];
      if (key === 'e') return editHeld(row.item);
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
      if (row.kind === 'request') {
        if (!await homeOk(row.root, row.request.continuationTaskId)) return;
        const lower = underDefault(row.request); if (lower) updateRequest(row.root, row.request.id, lower, { from: ['blocked', 'waiting'] });
        if (!retryRequest(row.root, row.request.id)) throw new Error('Only a blocked or saved request can be retried.');
        conduct(); setMessage(lower ? `Queued again, with ${LABELS[lower.permissions]}, the default now.` : 'Queued again.'); return;
      }
      if (!['blocked', 'stopped', 'unverified'].includes(row.task.state)) throw new Error('Retry works on blocked, stopped, or unverified work.');
      // The last message to the lead goes again. A session that only wrote to a bot sends that message to the bot again.
      const yours = (row.task.messages ?? []).filter(value => !value.bot), last = yours.findLast(value => !value.to) ?? yours.at(-1);
      // A teammate's message is theirs to send again: sent from here it would read as the owner's.
      if (last?.peer || teammateText(last)) throw new Error(`That message is from ${last.from ?? 'a teammate'}. Ask them to send it again, or write your own in the session.`);
      if (!await homeOk(row.root, row.id)) return;
      enqueue(row.root, last?.text ?? row.task.goal, { continuationTaskId: row.id, priority: 0, ...(last?.to ? { bot: last.to.replace(/^@/, '') } : {}) }); conduct(); setMessage(`Retrying ${sessionName(row.task)}.`); return;
    }
    if (action === 'answer') {
      if (row.kind !== 'task') throw new Error('Choose a session to answer.');
      const response = row.task.reply?.outcome === 'needs_input' ? row.task.reply : row.task.result;
      const body = row.task.state === 'needs_input' ? `${response?.question ?? ''}\n${(response?.choices ?? []).join(' / ')}` : `Follow up in ${row.project}:\n${sessionGoal(row.task)}${live ? '\n\nIts turn is working: the turn reads this at its next step, or it is answered beside the turn at once.' : ''}`;
      const text = await prompt(`Answer ${sessionName(row.task)}`, body, ''); if (!text?.trim()) return;
      if (!await homeOk(row.root, row.id)) return;
      enqueue(row.root, text.trim(), { continuationTaskId: row.id, priority: 0 }); conduct(); setMessage(`Sent to ${sessionName(row.task)}.`); return;
    }
    // d shows what the session changed, beside the list, and moves into it.
    if (action === 'diff') {
      if (row.kind !== 'task') throw new Error('Choose a session to see its changes.');
      const from = screen.focused === activity ? activity : board;
      if (view !== 'chat' || selectedId !== row.id || controller?.repo.root !== row.root) await openRow(row);
      showChanges({ focus: true }); changesFrom = from; return;
    }
    if (action === 'close') {
      // A message of yours that waits is removed.
      if (row.kind === 'request') { await removeHeld({ root: row.root, requests: [row.request], item: row.item }); setMessage('Removed.'); return; }
      if (row.kind !== 'task') throw new Error('c archives a session. Choose one.');
      if (row.archived) return setMessage(`${sessionName(row.task)} is archived already. u brings it back.`);
      // Its messages that did not run go with it: an archived session runs none.
      return closeTask(projectFolder(row.root), row.task, row.requests?.length ? () => { removeHeld(row).catch(() => {}); } : undefined);
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
    if (args.length && ['new', 'sessions', 'kanban', 'chats', 'projects', 'peers', 'usage', 'changes', 'chat', 'details', 'publish', 'archive', 'archived', 'setup', 'update', 'help', 'quit'].includes(name)) throw new Error(`Use ${command.usage}.`);
    if (name === 'quit') return quit();
    // A command that names a model waits for each vendor's own list, read beside the app.
    if (['model', 'agent', 'agents'].includes(name)) await readAllModels();
    // The files of a running app are not replaced under it: elu update runs once it is closed.
    if (name === 'update') return setMessage(UPDATE_IN_APP);
    if (name === 'help') return prompt('Commands', ['Six tabs: Sessions, Projects, Kanban, Chats, Bots, and Usage. Tab moves between areas; arrows move inside one.', 'Sessions: every session, in a list on the left. The selected one shows beside it. Enter moves into it and Esc moves back. PgUp and PgDn page its chat, from the message box too. d (or /changes) shows what it changed in place of its chat, also for a session on another computer: [ and ] move between its files, n and p between its changes, and Esc goes back. n or + New session starts one. c (or /archive) archives one; /archived lists them, and a new message brings one back. On a row, typing writes a message; a key is its letter, then Enter. While the model works, its chat shows each thought and tool call as it happens; then they fold into one line above its reply, and Ctrl-O or a click on that line opens them.', 'Projects: every project; ● marks the active one. o makes another active; Enter opens its settings; n or + New project creates one. A project a teammate shares that is not on this computer is listed too: Enter opens its team board, c clones it here.', 'Kanban: this project’s sessions by column. n adds a task; Shift+→ on a To do task starts it. On a team, everyone who has the same repository sees every session in it, with who started it and on which machine. A project that works in several repositories has a board for each: Board picks one. /share off keeps a project off it.', 'Chats: channels and direct messages on the left, the open one’s threads beside them. Type to write to it. n makes a channel, m sets who is in it, /invite @name adds one teammate, x leaves it. /leave leaves the whole team; an admin’s /remove @name takes a teammate off it, and a new invite brings them back. On a teammate, h holds your replies and results to them until you send each one: y sends it, e edits it first, n drops it. o lets their answer or result continue the chat you asked from.', 'Bots: models with instructions you write once. n or + New bot makes one; Enter opens it; x removes it. Each shows in its own color; /bots color NAME COLOR changes it. In a session, @name alone adds one and @name with a message asks it; a teammate’s @name with a message asks them.', 'Usage: your accounts and their plan usage, then the top agents by cost. Every account you add stays signed in: Enter on one makes new turns use it, a adds one, x forgets one. d shows a vendor’s details. Enter on an agent opens its session; t shows today or the last 7 days; r checks again.', 'Schedules: /schedule lists times such as in 5m, in 1h and daily 9:00. /schedule in 1h check the build saves one at once. Each run starts a new session that does not see the chat it was made in, named with the schedule’s message, and archives its earlier runs: /archived shows them. In Sessions, r runs one now, p pauses, x deletes, each followed by Enter.', 'Permissions: each session runs as Ask for approval, Approve for me, or Full access. /permissions changes it.', 'Model: each session has its own. /model NAME changes it; the name it is shown by works too (/model opus 5.5), and a message after the name is sent on that model. Over a session on your other computer, it changes that session’s model there. /model default NAME sets what new sessions start with, and /model add adds one by name. /model computer NAME sets this computer’s default. Both defaults are also rows in a project’s settings (Projects, Enter), and none in place of the name clears one.', 'Agents: /agent add <model> puts another model in this session with no bot to write first. Words after the model say what it is for (/agent add sonnet you review my SQL), and --name NAME names it. @name with a message asks it; /agent remove <name> takes it out.', 'Type / to filter commands. Tab completes; Enter runs.', 'Start a message with ! to run a shell command in the project folder: !git status. In an open session the model sees it with your next message.', 'Mouse: drag to copy; a double click copies a word. Click in the message box to move the cursor.', '', ...COMMANDS.map(row => `${row.usage}\n  ${row.description}`), '', 'Examples:', '/model sonnet', '/model opus 5.5 fix the build', '/model default opus', '/permissions auto', '/permissions folders add ~/evals', '/archive'].join('\n'));
    if (name === 'model') return modelCommand(args, command.text);
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
        if (composing) { composeFolders = checkFolders([...composeFolders, dir], { mode: formMode() }); setMessage(`The model reads ${shortHome(dir)} this session.`); return; }
        controller.addFolder(task.id, dir); setMessage(`Added ${shortHome(dir)}. The model reads it from your next message.`); return;
      }
      // /permissions rules [remove N|on N]: what runs without asking (lib/permission-rules.mjs).
      if (args[0] === 'rules') {
        if (args.length === 1) return rulesDialog();
        if (args.length !== 3 || !['remove', 'on'].includes(args[1]) || !/^[0-9]+$/.test(args[2])) throw new Error('Use /permissions rules, /permissions rules remove N or /permissions rules on N.');
        setMessage(args[1] === 'remove' ? removeEntry(Number(args[2])) : turnOnEntry(Number(args[2]))); return;
      }
      // A new session being written whose mode the owner did not pick takes the new default too.
      if (args[0] === 'default') {
        if (args.length !== 2) throw new Error('Use /permissions default <ask|auto|full>.');
        const mode = checkMode(args[1]); saveDefaultMode(mode);
        const draft = controller && view === 'chat' && !selectedId && !selectedRequest && !following || Boolean(controller && drafts.get(`${controller.repo.root}\0new`)?.trim());
        followDefault();
        if (!draft || composePicked) setMessage(`New sessions start with ${LABELS[mode]}.`);
        else if (composeMode !== mode) setMessage(`New sessions start with ${LABELS[mode]}, this scheduled one with ${LABELS[composeMode]}. ${SCHEDULE_CAP}`);
        else setMessage(`New sessions start with ${LABELS[mode]}, this one too.`);
        return;
      }
      if (args.length > 1 || args[0] && !MODES.includes(args[0])) throw new Error(`Use ${command.usage}.`);
      const task = controller && view === 'chat' && !selectedRequest && selectedId ? controller.snapshot().tasks.find(row => row.id === selectedId) : null;
      const composing = controller && view === 'chat' && !selectedId && !selectedRequest;
      if (!task && !composing && !args.length) return rulesDialog();
      if (!task && !composing) throw new Error('Open a session, or /new. /permissions default <mode> sets new sessions.');
      if (task && isPeerRun(task.origin)) throw new Error(READ_ONLY_PEERS);
      const timed = composing && Boolean(composeWhen);
      const mode = args[0] ? checkMode(args[0]) : await pickMode({ schedule: timed });
      if (!mode || args[0] === 'full' && !await (timed ? confirmScheduleFull() : confirmFull())) return;
      if (composing) { composeMode = mode; composePicked = true; composeFullOk = mode === 'full' && timed; if (composePlace.kind === 'here' && mode !== 'full') composePlace = { kind: 'worktree' }; belowFull(mode); setMessage(`${LABELS[mode]} for this ${timed ? 'schedule' : 'session'}. ${MODE_TEXT[mode]}`); return; }
      setMessage(setMode(task, mode)); return;
    }
    // /place [worktree|branch <name>|here]: where the new session works. With no word it asks.
    if (name === 'place') {
      if (!controller) throw new Error(NO_PROJECT);
      if (!composing()) throw new Error('A session keeps the place it started in. /new starts another, and /place says where that one runs.');
      const kind = args[0]?.toLowerCase(), mode = formMode();
      if (kind && !['worktree', 'branch', 'here'].includes(kind) || args.length !== (kind === 'branch' ? 2 : kind ? 1 : 0)) throw new Error(`Use ${command.usage}.`);
      if (composeWhen && kind === 'here') throw new Error(NO_HERE);
      const place = kind ? checkPlace(kind === 'branch' ? { kind, branch: args[1] } : kind, { mode }) : await pickPlace({ mode, schedule: Boolean(composeWhen) });
      if (place) { composePlace = place; setMessage(`${placeText(place)} for this ${composeWhen ? 'schedule' : 'session'}.`); }
      return;
    }
    if (name === 'new') return newTaskForm();
    // /schedule alone lists times. /schedule <when> sets the time and waits for the message;
    // /schedule <when> <message> saves it at once. The form it is typed in keeps what it holds;
    // typed in a session, the new form starts with that session's bots.
    if (name === 'schedule') {
      const typed = command.text ? splitWhen(command.text) : null, session = composing() ? null : openTask();
      if (!composing()) await newTaskForm();
      if (!controller || !composing()) return;
      if (session) { try { composeBots = botsOf(session).filter(bot => getBot(bot)); } catch { /* An unreadable bots file: the form's own. */ } }
      if (!typed) return setWhen();
      if (typed.rest) controller.writable();
      useWhen(typed.when, typed.text);
      if (typed.rest) return scheduleTask(typed.rest, { inline: true });
      focusInput(); return;
    }
    if (name === 'sessions') { showView('tasks'); return; }
    if (name === 'kanban') { showView('kanban'); return; }
    if (name === 'chats') { showView('chats'); return; }
    // /standup starts a Standup session in this project and opens its chat (README, "Standup").
    if (name === 'standup') {
      if (!controller) throw new Error(NO_PROJECT);
      controller.writable();
      const request = enqueue(controller.repo.root, STANDUP_GOAL, { priority: 0, permissions: defaultMode(), standup: true });
      showSession({ request }); conduct(); return;
    }
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
        const now = setBotSchedule(controller.repo, task.id, bot, words[1] === 'on');
        if (now.on) tickBots();
        keepLoginItem();
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
    // /send PATH...: files from this computer to the session on another computer of mine under the cursor.
    if (name === 'send') {
      const here = remoteHere();
      if (!facade) throw new Error(PEER_MISSING);
      if (!here) throw new Error('Choose a session on another computer of yours in Sessions, then /send PATH.');
      if (!args.length) throw new Error(`Use ${command.usage}.`);
      setMessage(await remoteApp.sendPaths(here, args, filesAsked)); return;
    }
    // /slots says the limit on sessions at once, /slots N sets one (any whole number from 1),
    // and /slots off removes it (none, unlimited and 0 too). There is none until one is set.
    // Each answer ends with what a limit holds back: never what the owner types.
    if (name === 'slots') {
      const none = `${limitText(null)} /slots 6 sets one. ${SLOTS_RULE_UNSET}`;
      if (!args.length) { const slots = conductorSettings().maxAgents; setMessage(slots === null ? none : `${limitText(slots)} /slots off removes the limit. ${SLOTS_RULE}`); return; }
      const word = args[0].toLowerCase(), asked = /^[0-9]+$/.test(word) ? Number(word) : ['off', 'none', 'unlimited'].includes(word) ? 0 : null;
      if (args.length > 1 || !Number.isSafeInteger(asked)) throw new Error('Use /slots 6 to set a limit, or /slots off for no limit.');
      const slots = saveConductorSettings({ maxAgents: asked || null }).maxAgents; setMessage(slots === null ? none : `${limitText(slots)} Running work is not interrupted. ${SLOTS_RULE}`); return;
    }
    // /mcp lists your Claude Code servers, adds or removes one, and turns one on or off for the project.
    if (name === 'mcp') {
      if (args[0] === 'add') return addServerAsked(args.slice(1));
      if (args[0] === 'remove') return removeServerAsked(args.slice(1));
      const { all, on } = controller ? controller.servers() : { all: Object.keys(claudeServers(null)), on: Object.keys(claudeServers(null)) };
      if (!args.length) return prompt('MCP servers', [all.length ? all.map(server => `${on.includes(server) ? '● on ' : '○ off'}  ${server}`).join('\n') : 'No MCP servers in Claude Code yet.', '', 'Your Claude Code servers (claude mcp list). Sessions use them all.', '/mcp add adds one, and keeps its key out of the chat. /mcp remove NAME removes one.', '/mcp off NAME turns one off for this project. Teammates\' asks never get them.'].join('\n'));
      if (args.length !== 2 || !['on', 'off'].includes(args[0])) throw new Error('Use /mcp, /mcp add, /mcp remove NAME, /mcp on NAME or /mcp off NAME.');
      if (!controller) throw new Error(NO_PROJECT);
      setMessage(controller.setServer(args[1], args[0] === 'on')); return;
    }
    // /stop needs no project here when it stops a command or a session on another computer.
    if (name === 'stop') return stopCurrent(args[0]);
    // /rename and /archive over a session on another computer of mine rename and archive it there.
    const there = ['rename', 'archive'].includes(name) ? remoteHere() : null;
    if (there) return remoteEdit(there, name === 'archive' ? 'close' : 'rename', name === 'rename' && args.length ? args.join(' ') : null);
    if (!controller) throw new Error(NO_PROJECT);
    if (name === 'changes') return showChanges();
    if (name === 'chat') return showChat();
    if (name === 'details') { const task = view === 'chat' && controller.snapshot().tasks.find(row => row.id === selectedId); if (!task) throw new Error('Open a session first.'); return showDetails(repo, task); }
    if (name === 'publish') return publishCurrent();
    if (name === 'takeover') {
      if (!controller) throw new Error('Open a project first.');
      if (!claim.readOnly) { setMessage('This window already makes the changes here.'); return; }
      if (takeProject()) return;
      claim.ask(); takeoverAt = Date.now(); triedAt = 0; setMessage('Asked the other ELU window to let go of this project.'); return;
    }
    // A session whose message has not started yet is open, with nothing to name or archive yet.
    if (['archive', 'rename'].includes(name) && view === 'chat') openStarted();
    const unstarted = view === 'chat' && !selectedId && (selectedRequest || following);
    if (name === 'archive') {
      const task = view === 'chat' && selectedId && controller.snapshot().tasks.find(row => row.id === selectedId);
      if (!task && unstarted) throw new Error('This session has not started yet. Try again once it has.');
      if (!task) throw new Error('Open a session to archive it. In Sessions, c archives the selected one.');
      return closeTask(controller.repo, task, () => { showView(returnTo); focusContent(); });
    }
    if (name === 'archived') { toggleArchived(); return; }
    if (name === 'rename') {
      const task = view === 'chat' && selectedId && controller.snapshot().tasks.find(row => row.id === selectedId);
      if (!task && unstarted) throw new Error('This session has not started yet. Try again once it has.');
      if (!task) throw new Error('Open a session to rename it. In Sessions, e renames the selected one.');
      return renameTask(controller.repo, task, args.length ? args.join(' ') : null);
    }
    if (name === 'setup') { if (busyHere()) throw new Error('Wait for running responses before advanced setup.'); return controller.snapshot().initialized ? reviewSetup() : prepareProject(); }
  }
  // A dialog is laid out for the screen as it is now, when it opens and again each time the
  // window changes size while it is open: layout works out its height and its wrapped lines for
  // the new width, and laid fills what depends on the size the box then has.
  function positionModal() {
    modal.width = Math.min(88, screen.width - 4); modal.layout?.();
    placeModal();
    modal.laid?.();
  }
  // Where the dialog stands, with the height its layout asked for. Every draw puts it back there
  // before it makes room under it for the status line, and that is all a draw does to it: its
  // lines are not worked out or set again, so a draw that renders nothing leaves the dialog's
  // text on the screen as it was.
  function placeModal() {
    modal.width = Math.min(88, screen.width - 4);
    modal.height = Math.min(screen.height - 4, modal.preferredHeight ?? screen.height - 4);
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
  // second Enter on it submits it. live: a function that gives the body again, read every
  // two seconds while the dialog is open (a thread whose message is still on its way).
  function prompt(title, body, value = '', { keys = [], preselect = '', trusted = false, suggest = null, check = null, warn = null, live = null } = {}) {
    if (modal) throw new Error('Close the current dialog first.');
    return new Promise(resolve => {
      openDialog();
      modal = dialogBox(title);
      const guided = Boolean(suggest || check || warn), all = suggest?.('') ?? [];
      modal.layout = () => { modal.preferredHeight = Math.max(12, String(body).split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(widthOf(line) / Math.min(80, screen.width - 12))), 0) + 7 + (guided ? all.length + 3 : 0)); }; positionModal();
      const text = blessed.box({ parent: modal, top: 1, left: 1, width: '100%-2', height: '100%-5', scrollable: true, keys: true, tags: guided, content: guided ? '' : blockText(body, { trusted }), scrollbar: { ch: '|' } });
      const field = blessed.textbox({ parent: modal, bottom: 1, left: 1, height: 3, width: '100%-2', border: 'line', label: suggest ? ' Enter submits / Tab completes / ↑↓ choose / Esc cancels ' : ' Enter submits / Esc cancels / PgUp PgDn page ', keys: true, mouse: true, inputOnFocus: false, value, tags: false, style: { fg: shade('text'), bg: shade('raised'), border: { fg: accent } } });
      bindInput(field, screen); editable(field);
      // The options for the text typed so far, under the body, with a mark on the one Tab
      // takes. Rows that do not fit give way to a +N more line. The line from check or warn
      // goes last, once Enter was refused or nothing matches. A field that opens with a
      // value lists every option until something is typed.
      let typed = '', options = [], mark = Math.max(0, all.findIndex(row => row.name === value)), refused = null;
      const column = Math.max(0, ...all.map(row => widthOf(row.name))) + 2;
      const list = () => {
        const wide = Math.max(8, text.width - 1), lines = wrapText(blockText(body, { trusted }), wide), stop = check?.(field.value) ?? null, doubt = stop ?? warn?.(field.value) ?? null;
        options = suggest?.(typed) ?? []; mark = Math.max(0, Math.min(mark, options.length - 1));
        const said = !doubt ? null : refused === field.value ? stop ?? `${doubt} Enter again submits it as typed.` : typed && !options.length ? doubt : null, notes = said ? ['', ...wrapText(said, wide)] : [];
        const room = Math.max(2, text.height - lines.length - 1 - notes.length), size = options.length > room ? room - 1 : options.length, start = Math.min(Math.max(0, mark - size + 1), options.length - size);
        const rows = options.slice(start, start + size).map((row, index) => `${ink(start + index === mark ? '>' : ' ', 'orange', colour, true)} ${ink(padEnd(row.name, column), null, colour, start + index === mark)}${ink(fitWords(row.note, wide - column - 2), 'muted', colour)}`);
        text.setContent([...lines.map(line => displayText(line, { trusted })), ...(rows.length ? ['', ...rows] : []), ...(size < options.length ? [ink(`  +${options.length - size} more`, 'muted', colour)] : []), ...notes.map(line => ink(line, 'orange', colour))].join('\n'));
      };
      if (guided) { list(); modal.laid = list; }
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
      const fresh = live && !guided ? setInterval(() => { if (finished || closing) return; try { const next = live(); if (typeof next === 'string' && next !== body) { body = next; text.setContent(blockText(body, { trusted })); screen.render(); } } catch { /* The body stays as it was. */ } }, 2000) : null; fresh?.unref?.();
      const finish = answer => { if (finished) return; finished = true; clearInterval(fresh); closeDialog(resolve, answer); };
      modal.dismiss = () => finish(null); modal.keep = () => Boolean(field.value) && field.value !== value;
      field.on('submit', answer => finish(answer)); field.on('cancel', () => finish(null));
      field.on('focus', () => field.readInput());
      // PgUp and PgDn move the body a page, as they move a chat (pageOf).
      field.key(['pageup', 'pagedown'], (_, key) => { text.scroll((key.name === 'pageup' ? -1 : 1) * pageOf(text), true); screen.render(); });
      field.focus(); minimumSize(); screen.render();
    });
  }
  // Dialogs hand focus back to where the first of them was opened (a settings dialog opens
  // an editor, then comes back), else to the message box, unless something has taken focus
  // since the last one closed.
  let dialogOrigin = null;
  // Drawn again once the dialog is up: a message moves out from under one that covers it.
  function openDialog() { if (ask._reading) ask.cancel(); dialogOrigin ??= screen.focused; if (message) { lastFrame = null; scheduleDraw(); } }
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
  // button: a label. The rows are then only text to read, and the button under them is the one
  // thing to choose: it has the focus, so Enter presses it, as a click on it does ({ button:
  // true }). ↑↓, the page keys and the wheel scroll the text; a click on a row does nothing.
  function listDialog(title, rows, { hint = 'enter choose · esc close', keys = [], selected = 0, notes = [], shown = false, button = null } = {}) {
    if (modal) throw new Error('Close the current dialog first.');
    return new Promise(resolve => {
      openDialog();
      modal = dialogBox(title);
      // rows and notes may be functions: they are asked again for the screen as it is when the
      // window changes size, so lines wrapped or paged for the old size are made for the new one.
      const rowsNow = () => typeof rows === 'function' ? rows() : rows, notesNow = () => typeof notes === 'function' ? notes() : notes;
      const room = button ? 2 : 0;
      let said = [], under = 0, lines = rowsNow(), noteText = null, list = null, press = null;
      modal.layout = () => {
        said = notesNow().flatMap(note => wrapText(note, modal.width - 5)); under = said.length ? said.length + 1 : 0;
        if (list) lines = rowsNow();
        modal.preferredHeight = Math.max(8, lines.length + 4 + under + room);
        if (!list) return;
        if (noteText) { noteText.height = Math.max(1, said.length); noteText.setContent(said.map(line => ink(line || ' ', shown ? 'text' : 'muted', colour, false, { trusted: shown })).join('\n')); }
        list.height = `100%-${4 + under + room}`;
        if (press) press.bottom = 3 + under;
        if (lines.join('\n') !== list.ritems?.join('\n')) { const at = list.selected ?? 0; list.setItems(lines); list.select(Math.max(0, Math.min(at, lines.length - 1))); }
      };
      positionModal();
      if (under) noteText = blessed.text({ parent: modal, bottom: 3, left: 2, width: '100%-4', height: said.length, tags: true, content: said.map(line => ink(line || ' ', shown ? 'text' : 'muted', colour, false, { trusted: shown })).join('\n'), style: { fg: muted, bg: shade('panel') } });
      list = blessed.list({ parent: modal, top: 1, left: 1, width: '100%-2', height: `100%-${4 + under + room}`, keys: !button, mouse: true, vi: false, tags: true, invertSelected: false, interactive: !button, style: { fg: shade('text'), bg: shade('panel'), selected: { ...selection } }, scrollbar: { ch: '┃', style: { fg: shade('dim') } } });
      steadyWheel(list, button ? step => list.scroll(step, true) : null); list.setItems(lines); list.select(Math.max(0, Math.min(selected, lines.length - 1)));
      blessed.text({ parent: modal, bottom: 1, left: 2, width: '100%-4', height: 1, tags: true, content: ink(hint, 'muted', colour), style: { fg: muted, bg: shade('panel') } });
      let finished = false;
      const finish = answer => { if (finished) return; finished = true; closeDialog(resolve, answer); };
      modal.dismiss = () => finish(null);
      if (button) {
        // Drawn as a button of the app's header has the focus.
        press = blessed.button({ parent: modal, bottom: 3 + under, left: 2, width: button.length + 2, height: 1, mouse: true, keys: true, tags: false, content: ` ${button} `, style: { fg: shade('background'), bg: accent, bold: true, inverse: !colour } });
        const scroll = step => { list.scroll(step, true); screen.render(); }, page = () => Math.max(1, list.height - list.iheight - 1);
        press.on('press', () => finish({ button: true }));
        press.key('escape', () => finish(null));
        press.key('up', () => scroll(-1)); press.key('down', () => scroll(1));
        press.key('pageup', () => scroll(-page())); press.key('pagedown', () => scroll(page()));
        press.key('home', () => scroll(-lines.length)); press.key('end', () => scroll(lines.length));
        // A click on the text leaves the focus, and so Enter, on the button.
        list.on('focus', () => press.focus());
        press.focus(); minimumSize(); screen.render(); return;
      }
      list.on('select', (_, index) => finish({ index: index ?? list.selected ?? 0 }));
      list.on('cancel', () => finish(null));
      for (const key of keys) list.key(withShift([key]), () => finish({ index: list.selected ?? 0, key }));
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
      modal.layout = () => { modal.preferredHeight = screen.height - 4; }; positionModal();
      const field = blessed.textarea({ parent: modal, top: 1, left: 1, width: '100%-2', height: '100%-5', inputOnFocus: false, keys: true, ignoreKeys: true, mouse: true, tags: false, value, style: { fg: shade('text'), bg: shade('raised') }, scrollbar: { ch: '┃', style: { fg: shade('dim') } } });
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
  // y or n answers at once; typed yes and Enter also does.
  async function yesKey(title, body, question = 'y yes · n no') { return /^y(?:es)?$/i.test((await prompt(title, `${body}\n\n${question}`, '', { keys: ['y', 'n'] }))?.trim() ?? ''); }
  // A field whose text is never drawn, kept, copied or shown: a key or a password. It shows
  // one dot for each character typed or pasted. Enter gives the text, Esc null.
  function secretPrompt(title, body) {
    if (modal) throw new Error('Close the current dialog first.');
    return new Promise(resolve => {
      openDialog();
      modal = dialogBox(title);
      modal.preferredHeight = Math.max(10, String(body).split('\n').length + 8); positionModal();
      blessed.box({ parent: modal, top: 1, left: 1, width: '100%-2', height: '100%-5', tags: false, content: blockText(body) });
      const field = blessed.textbox({ parent: modal, bottom: 1, left: 1, height: 3, width: '100%-2', border: 'line', label: ' Enter saves / Esc cancels / hidden as you type ', keys: true, mouse: false, inputOnFocus: false, value: '', tags: false, style: { fg: shade('text'), bg: shade('raised'), border: { fg: accent } } });
      bindInput(field, screen);
      let secret = '';
      const show = () => { field.setContent('•'.repeat(Math.min(secret.length, Math.max(1, field.width - field.iwidth - 2)))); screen.render(); };
      field._updateCursor = () => {};
      field._listener = function(ch, key = {}) {
        if (key.name === 'escape') { secret = ''; return this._done?.(null, null); }
        if (key.name === 'enter' || key.name === 'return') { const value = secret; secret = ''; return this._done?.(null, value); }
        if (key.name === 'backspace') secret = secret.slice(0, -1);
        else if (key.ctrl && key.name === 'u') secret = '';
        else if (key.name === 'paste') secret += String(ch ?? '').replace(/[\r\n]+/g, '');
        else if (typeof ch === 'string' && !key.ctrl && !key.meta && ch.length && !/[\x00-\x1f\x7f]/.test(ch)) secret += ch;
        else return;
        show();
      };
      let finished = false;
      const finish = answer => { if (finished) return; finished = true; closeDialog(resolve, answer); };
      modal.dismiss = () => finish(null); modal.keep = () => secret.length > 0;
      field.on('submit', answer => finish(answer)); field.on('cancel', () => finish(null));
      field.on('focus', () => field.readInput());
      field.focus(); minimumSize(); screen.render();
    });
  }
  // /mcp add [NAME]: the name, the URL or command, the header or variable that carries its
  // key, then the key in a hidden field. Claude Code saves it (lib/mcp.mjs).
  const serverRoot = () => controller?.repo.root ?? null;
  const offHere = name => { try { return Boolean(controller) && !controller.servers().on.includes(name); } catch { return false; } };
  const addedLine = names => `Added ${names.join(' and ')}. Sessions get ${names.length > 1 ? 'them' : 'it'} from their next turn.${names.filter(offHere).map(name => ` ${name} is off for this project: /mcp on ${name} turns it on.`).join('')}`;
  async function serverName(value = '', { typed = false } = {}) {
    const name = typed ? value : (await prompt('Add an MCP server', 'Its name, such as elu. Sessions see its tools as mcp__NAME__*.', value, { check: text => serverNameProblem(text.trim()) }))?.trim();
    if (!name) return null;
    if (claudeServers(serverRoot())[name] && !await yesKey('Add an MCP server', `${name} is already one of your Claude Code servers. Replace it?`)) return null;
    return name;
  }
  // /mcp add NAME URL [--header NAME] and /mcp add NAME [--env NAME] [--] COMMAND [ARGS]..., as
  // elu mcp add takes them: { name, where, args, field, flag }, null where a part was not
  // typed. After a command every word is its own. The key is never a word: it is asked for.
  const MCP_ADD_USE = 'Use /mcp add NAME URL [--header NAME], or /mcp add NAME [--env NAME] COMMAND [ARGS]. What is left out is asked for.';
  const isUrl = value => /^https?:\/\//i.test(value ?? '');
  const flagMismatch = (flag, url) => flag && (flag === 'env') === url ? (flag === 'env' ? '--env goes with a command. A URL takes --header.' : '--header goes with a URL. A command takes --env.') : null;
  function typedServer(words) {
    const out = { name: words[0], where: null, args: [], field: null, flag: null };
    for (let i = 1; i < words.length; i++) {
      const word = words[i], own = /^--(header|env)(?:=(.*))?$/.exec(word);
      if (out.where !== null && !isUrl(out.where)) { out.args.push(word); continue; }
      if (word === '--' && out.where === null) { out.where = words[i + 1] ?? null; out.args = words.slice(i + 2); break; }
      if (own) {
        if (out.flag) throw new Error(MCP_ADD_USE);
        out.flag = own[1]; out.field = own[2] ?? words[++i] ?? '';
        const wrong = (out.flag === 'env' ? envProblem : headerProblem)(out.field); if (wrong) throw new Error(wrong);
        continue;
      }
      if (out.where !== null) throw new Error(MCP_ADD_USE);
      out.where = word;
    }
    const problem = serverNameProblem(out.name); if (problem) throw new Error(problem);
    if (out.where !== null) { const wrong = flagMismatch(out.flag, isUrl(out.where)); if (wrong) throw new Error(wrong); }
    return out;
  }
  async function addServerAsked(words) {
    const given = words.length ? typedServer(words) : null;
    const name = await serverName(given?.name ?? '', { typed: Boolean(given) }); if (!name) { setMessage('Nothing was added.'); return; }
    const where = given?.where ?? (await prompt(`Add ${name}`, 'Its URL, such as https://example.com/mcp,\nor the command that starts it, such as npx -y some-server.', '', { check: text => { const value = text.trim(); if (!value) return 'Type a URL or a command.'; if (isUrl(value) && /\s/.test(value)) return 'A URL has no spaces.'; if (given?.flag && flagMismatch(given.flag, isUrl(value))) return flagMismatch(given.flag, isUrl(value)); try { commandWords(value); return null; } catch (error) { return error.message; } } }))?.trim();
    if (!where) { setMessage('Nothing was added.'); return; }
    const url = isUrl(where);
    const field = given?.field ?? await prompt(`Add ${name}`, url ? 'The header that carries its key, such as Authorization.\nLeave it empty if it needs no key.' : 'The environment variable that carries its key, such as API_KEY.\nLeave it empty if it needs no key.', '', { check: text => text.trim() ? (url ? headerProblem : envProblem)(text.trim()) : null });
    if (field === null) { setMessage('Nothing was added.'); return; }
    const named = field.trim();
    let value = null;
    if (named) {
      value = await secretPrompt(`${named} · ${name}`, `Type or paste the value of ${named}.\nIt is hidden here, and never goes to the chat, a session, a log or a model.${url && named.toLowerCase() === 'authorization' ? '\nA key typed alone is sent after the word "Bearer".' : ''}`);
      if (!value?.trim()) { value = null; setMessage('Nothing was added.'); return; }
    }
    const [command, ...rest] = url ? [] : given?.where ? [where, ...given.args] : commandWords(where);
    const entry = url ? { type: 'http', url: where, ...(named ? { headers: { [named]: headerValue(named, value) } } : {}) } : { command, args: rest, ...(named ? { env: { [named]: value.trim() } } : {}) };
    value = null;
    setMessage(`Adding ${name}…`);
    await addServer(name, entry, { root: serverRoot(), replace: true });
    setMessage(addedLine([name]));
  }
  async function removeServerAsked(words) {
    if (words.length !== 1) throw new Error('Use /mcp remove NAME. /mcp lists your servers.');
    const name = words[0];
    if (!claudeServers(serverRoot())[name]) throw new Error(`No MCP server named ${name}. /mcp lists yours.`);
    if (!await yesKey('Remove an MCP server', `Remove ${name} from your Claude Code servers?\nNo session gets it from then on, in any project.`)) { setMessage('Nothing was removed.'); return; }
    setMessage(await removeServer(name, serverRoot()));
  }
  // A message that holds an MCP server's config is not sent: it would put the key in the
  // chat, the session's history and the model's prompt. ELU offers to add the server
  // instead, and the box keeps the owner's other words. So does a claude mcp add line, typed
  // with ! or without: run in an open session, its line would join the chat the model reads.
  // true when the message was held. sendAsIs: a held text without a key, which Enter sends
  // (or runs) as it is the second time. A text with a key is never sent or run as it is.
  let sendAsIs = null;
  async function heldConfig(text) {
    if (sendAsIs !== null && sendAsIs === text) { sendAsIs = null; return false; }
    sendAsIs = null;
    const bang = text.trimStart().startsWith('!'), not = bang ? 'Not run' : 'Not sent';
    const hold = why => { ask.setValue(text); setMessage(why); focusInput(); return true; };
    // A claude mcp add-json line is read as the command it is, with its name.
    const cli = cliServerConfig(text), found = cli?.servers ? cli : findServerConfig(text) ?? cli;
    if (!found?.servers) {
      if (found?.keyed || keyedConfigText(text)) return hold(`${not}. It holds an MCP server's key: take the key out to send the rest, or use /mcp add.`);
      // Any other command with a key: in an open session its line would reach the model.
      if (bang && shellPlace().session && keyedLine(text)) return hold('Not run. It holds a key, and the model reads this session\'s commands.');
      return false;
    }
    const names = found.servers.map(row => row.name), keyed = found.servers.some(row => secretsOf(row.entry).length);
    const what = names.every(Boolean) ? names.join(' and ') : names.length > 1 ? 'these servers' : 'this server';
    const keep = () => { ask.setValue(text); if (!keyed) sendAsIs = text; setMessage(keyed ? `${not}. It holds a key: take the key out to send the rest, or use /mcp add.` : `${not}. Enter again ${bang ? 'runs' : 'sends'} it as it is.`); focusInput(); };
    if (!await yesKey('MCP server', `This ${found.cli ? 'adds an MCP server' : 'looks like an MCP server config'}. Add ${what} to your Claude Code servers?${keyed ? ' The key stays out of the chat.' : ''}`, `y adds ${names.length > 1 ? 'them' : 'it'} · n leaves your text in the box, ${bang ? 'not run' : 'unsent'}`)) { keep(); return true; }
    const added = [];
    try {
      for (const row of found.servers) {
        // A config's own name is used as it is; one that is taken is replaced only when the owner says so.
        const own = row.name && !serverNameProblem(row.name) ? row.name : null;
        const name = !own ? await serverName() : !claudeServers(serverRoot())[own] || await yesKey('MCP server', `${own} is already one of your Claude Code servers. Replace it?`) ? own : null;
        if (!name) continue;
        await addServer(name, row.entry, { root: serverRoot(), replace: true }); added.push(name);
      }
    } catch (error) { ask.setValue(text); setMessage(added.length ? `${addedLine(added)} ${error.message}` : error.message); focusInput(); return true; }
    if (!added.length) { keep(); return true; }
    ask.setValue(found.rest); setMessage(addedLine(added)); focusInput(); return true;
  }
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
      const plan = await controller.setupPlan();
      const body = ['Runs on:', ...Object.entries(plan.config.roles).map(([name, role]) => `${name === 'lead' ? 'model' : name}: ${role.vendor}, ${role.access}, network ${role.network}`), '\nChecks:', ...plan.config.checks.map(check => check.command.join(' ')), '\nWrites:', ...plan.writes, '\n' + plan.message].join('\n');
      if (!await yes('Set up project', body)) throw new Error('Setup was cancelled. Your request is saved.');
      setMessage(controller.setup(plan).message);
      if (!await reviewSetup()) throw new Error('Review and commit the project settings before starting. Your request is saved.');
      usageEnabled = true; controller.refreshUsage().then(draw);
    }
  }
  // Where a ! command runs and the session it joins: the open session's folder, else the
  // open project, else where ELU started. A teammate's question never takes one.
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
  // While the box holds a message brought back, unchanged: Up is an older one when there is one, Down a newer one, and past the newest the box is empty again.
  let recallShown = '';
  const recallKeys = () => recall && screen.focused === ask && palette.hidden && ask.getValue() === recall.list[recall.at] ? [...(recall.at > 0 ? [['↑', 'older']] : []), ['↓', recall.at < recall.list.length - 1 ? 'newer' : recall.taken ? 'drop' : 'clear']] : [];
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
      request = enqueue(controller.repo.root, 'Start working.', { priority: 0, permissions: formMode(), place: composePlace, folders: composeFolders, bots: composeBots, ...(composeModel ? { model: composeModel } : {}), ...(composePicked ? { picked: true } : {}), bot: starter });
    } catch (error) { setMessage(error.message); focusInput(); return true; }
    // The form's settings went with this session; the next form starts over.
    resetForm();
    recall = null; palette.hide(); chatShown = null; message = ''; drafts.delete(draftKey());
    following = { root: controller.repo.root, id: request.id, bot: starter };
    sessionView = 'chat'; selectedId = null; selectedRequest = request;
    ask.clearValue(); usageEnabled = true; controller.refreshUsage().then(draw);
    conduct(); resize(); focusInput();
    return true;
  }
  // What a view-only window refuses cannot be sent from it by pressing Enter again, and a command
  // typed next would join it. So the box is cleared, the line says where it goes, and ↑ brings
  // the text back. Any other refusal leaves the text in the box, to change and send again.
  const refusedHere = error => { if (!controller?.readOnly) return false; try { controller.writable(); return false; } catch (again) { return again.message === error.message; } };
  const putBack = (text, error) => { if (refusedHere(error)) { ask.clearValue(); if (refused?.text === error.message) refused.tail = TYPED_BACK; return `${error.message}${TYPED_BACK}`; } ask.setValue(text); return error.message; };
  async function submit(text) {
    // An empty Enter keeps the box reading: a box left focused but not reading drops keys.
    // In the new session form it starts the session when a bot that has a schedule is in it.
    // Over a session whose turn holds a message of his back, it sends that message now.
    // Over a session on another computer whose turn holds one back, it sends it there now.
    if (!text.trim()) {
      if (startWithBot()) return;
      const there = remoteHere();
      if (there && Number.isInteger(there.remote?.held) && there.remote.held > 0 && ['running', 'preparing'].includes(there.remote.state)) setMessage(await remoteApp.action(there, 'sendNow'));
      else sendWaitingNow();
      focusInput(); return;
    }
    // The text of a held reply or result the owner edited (editHeld), whatever it starts with:
    // the daemon scans it again and sends it. Refused, it stays in the box, still held, for
    // another change.
    if (heldEdit && view === 'chats') {
      const { id, who, result } = heldEdit;
      palette.hide();
      try { sentLine(await peerCommand({ type: 'approve', id, text: text.trim() }), who, `Sending the edited ${result ? 'result' : 'reply'} to ${who}.`); heldEdit = null; ask.clearValue(); }
      // Refused for a possible secret: the line stays until the text no longer holds one (syncPalette).
      catch (error) { ask.setValue(text); if (/possible secret/.test(error.message)) Object.assign(heldEdit, { secret: true, scanned: text }); setMessage(error.message); }
      focusInput(); draw(); return;
    }
    // A row's key, the one character typed, acts on the row from where the typing began, as
    // the line under the box says. It is never a message, and a draft it was typed over stays.
    const lone = rowKey(text), from = typedFrom, base = from && text.length > 1 ? typedBase : ''; typedFrom = null; typedBase = '';
    if (lone) {
      const kept = [draftKey(), controller ? `${controller.repo.root}\0new` : null].filter(key => key && drafts.get(key) === text);
      if (base) ask.setValue(base); else ask.clearValue();
      for (const key of kept) { if (base) drafts.set(key, base); else drafts.delete(key); }
      if (typedFor !== answerTarget()) { setMessage('The selected item changed. Choose one in the list first.'); focusInput(); draw(); return; }
      if (from === board) focusBoard(); else if (from) from.focus();
      try { await (lone.run ? lone.run() : boardAction(lone.action)); }
      catch (error) { setMessage(error.message); }
      if (!modal && screen.focused === ask) focusInput();
      draw(); return;
    }
    // An MCP server config never goes to a model or a teammate, nor into what Up recalls.
    if (!text.trimStart().startsWith('/') && await heldConfig(text)) { draw(); return; }
    openStarted();
    recall = null;
    // /mcp add with its URL or command typed is kept out of what Up recalls too: the URL may hold a key.
    if (sentNow.at(-1) !== text.trim() && !/^\/mcp\s+add\s+\S+\s+\S/i.test(text.trim())) { sentNow.push(text.trim()); if (sentNow.length > 200) sentNow.shift(); }
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
      catch (error) {
        // /ask is not a command: a teammate is asked by name, in a session as in Chats. With a
        // teammate of that name, the box keeps the part that asks them, so Enter sends it.
        const gone = /^\s*\/ask(?:\s+([^]*))?$/i.exec(text), mate = /^@\S+\s+\S/.test(gone?.[1] ?? '') ? teammateNamed(gone[1].split(/\s+/)[0]) : null;
        if (gone) {
          const kept = mate ? gone[1].trim() : text;
          ask.setValue(kept); paletteDismissed = kept;
          setMessage(mate ? `Unknown command: /ask. Ask by name: Enter sends this to @${mate.name}.` : 'Unknown command: /ask. Write @name and your question to ask a teammate.');
        // What a view-only window refuses leaves the box clear, and ↑ brings it back. Any other refusal keeps what was typed.
        } else { const refusal = putBack(text, error); paletteDismissed = text; setMessage(refusal); }
      }
      finally { if (!modal) focusInput(); draw(); }
      return;
    }
    // y or n alone answers what the selected item waits on, as the key does. It never starts a session.
    if (/^[yn]$/i.test(text.trim()) && ['tasks', 'chat', 'bots', 'projects', 'usage'].includes(view)) {
      // Taken as a key, or refused, the letter leaves the box at once, and so does the draft it
      // was kept in: a row that moves while it acts never saves it as a draft, and a letter
      // typed next never joins it. As a reply it goes back in the box and is sent as one.
      const letter = text.trim().toLowerCase(), fresh = controller ? `${controller.repo.root}\0new` : null;
      const kept = [draftKey(), fresh].filter(key => key && drafts.get(key)?.trim().toLowerCase() === letter);
      const forget = () => { for (const key of kept) if (drafts.get(key)?.trim().toLowerCase() === letter) drafts.delete(key); };
      ask.clearValue();
      let answered;
      try { answered = await answerKey(letter); }
      catch (error) { forget(); setMessage(error.message); focusInput(); draw(); return; }
      if (answered) { forget(); ask.clearValue(); if (!modal) focusInput(); draw(); return; }
      ask.setValue(text);
    }
    // What is sent in a session beside the list opens it: a lone y or n there is a reply from then on.
    if (view === 'chat' && listed()) entered = ownKey();
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
        else if (chatOpen.type === 'member') {
          // Every word is the message: only @name with a handle picks a project.
          const who = peerName(chatOpen.name, chatOpen.key);
          const mine = remoteApp.yours().get(chatOpen.key);
          sentLine(await peerCommand({ type: 'ask', to: chatOpen.key, project: null, text: text.trim() }), who, mine ? sentToMine(who) : `Sent to ${who}. Their reply shows in this thread.`, Boolean(mine));
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
          setMessage(withCount(result, `Sent to #${chatOpen.name}. The first ${takers(chatOpen)} to take it answers.`));
        }
        ask.clearValue(); focusInput(); return;
      }
      if (view === 'kanban' && sharedNow()) {
        // A shared project's team board: the message goes to whoever shares it, about that project.
        const shared = sharedNow(), who = shared.sharers[0], name = peerName(who.name, who.key);
        if (text.trim().length > 16000) throw new Error('Keep it under 16,000 characters.');
        sentLine(await peerCommand({ type: 'ask', to: who.key, project: shared.handle, text: text.trim() }), name, fitLine(`Sent to ${name}. It starts a session on ${who.mine ? 'that' : 'their'} computer, under the access ${who.mine ? 'you' : 'they'} chose. The reply shows in Chats.`, `Sent to ${name}. It starts a session there. The reply shows in Chats.`, `Sent to ${name}. The reply shows in Chats.`), who.mine === true);
        sharedTold.at = 0; ask.clearValue(); focusInput(); return;
      }
      if (view === 'kanban') {
        if (!controller && !await createHere()) { ask.setValue(text); focusInput(); return; }
        controller.writable(); addCard(controller.repo, text); ask.clearValue(); setMessage('Added to To do. Shift+→ on it starts it.'); focusInput(); return;
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
      // Over a session there, a message goes to that session, as if typed there, unless it starts with @here: that one asks your agent here.
      const here = remoteHere(), machine = !here && !mention && !toModel && (sessionBox() || composing()) ? remoteApp.named(first) : null;
      if (here) {
        const way = remoteApp.route(here, toModel ? `@model ${text}` : text);
        // A plain yes that goes to a session there whose Task waits is his answer to that Task, as y is.
        // After @here it is a message for his agent here, as anything is.
        if (!toModel && way.to === 'there' && here.label === 'TASK' && saysYes(way.text)) { setMessage(await remoteApp.action(here, 'accept')); ask.clearValue(); focusInput(); return; }
        return way.to === 'there' ? await remoteSubmit(here, null, way.text) : await helperSubmit(here, way.text);
      }
      if (machine) return await remoteSubmit(here, machine, text.trim().slice(first.length).trim());
      // @everyone asks every open session (README, "Standup"): in a Standup session, the ones its
      // last round asked, with the question; anywhere else, in a new Standup session.
      const everyone = !mention && !toModel && !person ? everyoneMessage(text) : null;
      if (everyone) {
        if (!controller) throw new Error(NO_PROJECT);
        controller.writable();
        const open = view === 'chat' && selectedId && !selectedRequest ? controller.snapshot().tasks.find(row => row.id === selectedId) : null, standup = { question: everyone.question };
        const request = open?.standup ? enqueue(controller.repo.root, text.trim(), { priority: 0, continuationTaskId: open.id, standup }) : enqueue(controller.repo.root, text.trim(), { priority: 0, permissions: defaultMode(), standup });
        ask.clearValue(); if (!open?.standup) showSession({ request }); conduct(); focusInput(); return;
      }
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
    } catch (error) { setMessage(putBack(typed(), error)); focusInput(); return; }
    // The session may have started while this was on its way.
    let pending = openStarted();
    // A message that waits for a turn of its session to end is not one to rewrite: this one
    // waits beside it in that session, and the two go together when the turn ends.
    if (selectedRequest && pending?.continuationTaskId && !pending.origin && ['queued', 'starting'].includes(pending.state)) { selectedId = pending.continuationTaskId; selectedRequest = null; }
    // The message that starts this session still waits for the conductor: this one goes with
    // it, in the order sent, as waiting messages go together. It never takes its place. One
    // written to someone else cannot go with it, so it stays in the box. What he types always
    // starts (typed): a schedule's run that waits for a free slot keeps its own message, takes
    // his after it, and starts now.
    if (selectedRequest && pending?.state === 'queued' && !pending.continuationTaskId && !pending.origin && !pending.scheduled) {
      // With no @name it goes to whoever the first was written to, and @model goes to the model.
      const to = mention ? mention.bot.name : toModel ? null : pending.bot ?? null;
      const same = to === (pending.bot ?? null), joined = same ? addToRequest(controller.repo.root, pending.id, mention ? mention.text : text, { typed: true }) : null;
      if (joined) { message = ''; drafts.delete(draftKey()); selectedRequest = joined; ask.clearValue(); if (joined.scheduleId) setMessage('Added to this scheduled run. It starts now.'); conduct(); resize(); focusInput(); return; }
      pending = openStarted();
      if (selectedRequest && pending?.state === 'queued') { ask.setValue(typed()); setMessage('This session has not started yet. Send this once it has.'); focusInput(); return; }
    }
    // While the conductor is still starting it there is no session to wait in yet, and the request is no longer one to rewrite.
    if (selectedRequest && pending?.state === 'starting') { ask.setValue(typed()); setMessage('This session is still starting. Send this again in a moment.'); focusInput(); return; }
    const root = controller.repo.root, continuation = selectedRequest ? selectedRequest.continuationTaskId ?? null : selectedId;
    if (continuation && !await homeOk(root, continuation)) { ask.setValue(typed()); focusInput(); return; }
    message = '';
    drafts.delete(draftKey());
    // A new session carries the compose rows; a saved request keeps its own, with no more access
    // than the default now unless its mode was picked for it.
    const session = continuation ? {} : selectedRequest ? { permissions: selectedRequest.permissions, place: selectedRequest.place, folders: selectedRequest.folders, ...(selectedRequest.bots ? { bots: selectedRequest.bots } : {}), ...(selectedRequest.model ? { model: selectedRequest.model } : {}), ...underDefault(selectedRequest) } : { permissions: formMode(), place: composePlace, folders: composeFolders, bots: composeBots, ...(composeModel ? { model: composeModel } : {}) };
    const picked = continuation ? false : selectedRequest ? selectedRequest.picked === true : composePicked, fromForm = !continuation && !selectedRequest;
    // A saved request keeps the bot it was written to, so one that now goes to the model is sent as a new request.
    const rewritten = Boolean(selectedRequest?.bot) && !mention;
    // In an open session a message with no @name goes to whoever the owner wrote to last: a bot they
    // wrote to stays the one they are talking to until they name another, or @model.
    let stays = null;
    if (!mention && !toModel && continuation && !selectedRequest) { try { stays = addressedBot(controller.snapshot().tasks.find(row => row.id === continuation), pendingRequests(root)); } catch { /* It goes to the model. */ } }
    const to = mention ? mention.bot.name : stays;
    let request;
    // The bot gets the message without its @name; the chat shows who it was written to.
    try { request = enqueue(root, mention ? mention.text : text, { id: rewritten ? undefined : selectedRequest?.id, continuationTaskId: continuation, priority: 0, ...session, ...(picked ? { picked: true } : {}), ...(to ? { bot: to } : {}) }); if (rewritten) removeRequest(root, selectedRequest.id); }
    catch (error) { ask.setValue(typed()); setMessage(error.message); focusInput(); return; }
    // A message sent from the form uses its settings up, wherever the form was opened, so the
    // next new session starts with the default again.
    if (fromForm) resetForm();
    following = { root, id: request.id, bot: to };
    // What was sent shows in the chat.
    sessionView = 'chat';
    selectedId = continuation; selectedRequest = continuation ? null : request;
    ask.clearValue(); usageEnabled = true; controller.refreshUsage().then(draw);
    // Sent to a session whose turn works: the status line says what happens to it and when, as the chat does.
    const into = continuation ? controller.snapshot().tasks.find(row => row.id === continuation) : null;
    if (into && ['running', 'preparing'].includes(into.state)) { let sent = null; try { sent = pendingRequests(root).find(row => row.id === request.id) ?? null; } catch { sent = null; } if (sent) setMessage(`Sent. ${sentWords({ goes: goesToTurn(into, sent), deaf: answersBeside(into, sent), soon: notSaidYet(into, sent), command: commandRuns(into) })}`); }
    conduct(); resize(); focusInput();
  }
  // y or n sent alone: true when it answered the selected item or was refused, false when it is
  // a reply to send to the open session.
  async function answerKey(key) {
    // The row changed by itself after the text was typed: nothing is answered in its place.
    const moved = () => typedFor !== answerTarget() && (setMessage('The selected item changed. Choose one in the list first.'), true);
    // A session opened from Kanban, or opened or written in beside the list, takes it in its chat.
    if (view === 'chat' && (!listed() || enteredHere())) {
      const task = controller && selectedId && !selectedRequest ? controller.snapshot().tasks.find(row => row.id === selectedId) : null;
      if (task) {
        const first = approvalsFor(task)[0];
        if ((first || task.plan?.state === 'proposed') && moved()) return true;
        if (first) { setMessage(answerApproval(first.id, key === 'y' ? 'allow' : 'deny') ? key === 'y' ? 'Allowed.' : 'Denied.' : 'That approval was already answered.'); return true; }
        if (task.plan?.state === 'proposed') { await decideTask(controller.repo.root, task, key === 'y'); return true; }
        return false;
      }
      if (selectedRequest?.continuationTaskId) return false;
    } else if (listed()) {
      // In the list, whatever shows beside it, y and n are keys: they act on the selected row
      // where it waits on them, and are never sent to the session it shows.
      const row = selectedBoardRow(), keys = rowActions(row).map(([value]) => value);
      if (row && (keys.includes('y') && keys.includes('n') || rowApproval(row) || taskWaits(row))) { if (moved()) return true; await boardAction(key === 'y' ? 'accept' : 'decline'); return true; }
      // A session on another computer of mine takes it as a message.
      if (row?.kind === 'remote') return false;
    }
    setMessage('y and n answer the selected item. Choose one in the list first.'); return true;
  }
  // Mouse tracking off, the cursor shown and the alternate screen left, written straight to the
  // terminal. A signal does this at once, before the sessions this window runs have stopped,
  // so a kill while they stop leaves the terminal as it was before ELU opened. Nothing is
  // drawn after it.
  let restored = false;
  function restoreTerminal() {
    if (restored || screen.destroyed) return;
    restored = true; screen.render = () => {};
    try { screen.leave(); } catch { /* The modes are turned off below all the same. */ }
    try { screen.program.flush(); output.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?25h'); } catch { /* A terminal that is gone needs nothing back. */ }
    try { input.setRawMode?.(false); } catch { /* Not a terminal. */ }
  }
  async function quit() {
    if (closing) return;
    // A join still looking ends with the app, as Esc ends it: nothing joins with nobody here.
    if (joining && !joining.signal.aborted) { joining.abort(); try { facade?.endJoins?.(); } catch { /* The daemon ends it once it sees the app gone. */ } }
    if (modal?.dismiss) modal.dismiss(); else if (modal) modal.children.find(child => child.type === 'textbox')?.emit('cancel');
    closing = true; shellRun?.run.stop(); clearTimeout(timer); clearInterval(usageTimer); clearInterval(serversTimer); clearInterval(scheduleTimer); clearInterval(sentTimer); clearInterval(changesTimer); clearTimeout(patchTimer); clearTimeout(countTimer); usageAbort.abort();
    let failure;
    // A push still going stops with its guards, and its session says on the next open what reached GitHub (lib/publish.mjs).
    if (pushesRunning()) { setMessage('Stopping the push before ELU closes…'); try { await stopPushes('closed'); } catch (error) { failure = error; } }
    try { await controller?.close(); } catch (error) { failure ??= error; }
    try { claim.release(); } catch (error) { failure ??= error; }
    screen.destroy(); if (failure) rejectDone(failure); else resolveDone();
  }
  ask.on('submit', text => catchAction(() => submit(text)));
  ask.on('focus', () => ask.readInput());
  // Esc leaves the message box for the view's main pane.
  // An edit of a held reply ends there too, and the reply stays held: the cursor goes back
  // to it in Threads, unless another part of Chats has the focus by then.
  // A row's key typed and not entered is taken back, and the draft it was typed over stays.
  ask.on('cancel', () => {
    if (typedFrom && rowKey()) { if (ask.getValue().length > 1) ask.setValue(typedBase); else ask.clearValue(); } typedFrom = null; typedBase = '';
    palette.hide();
    const held = heldEdit && !closing ? leaveEdit() : -1;
    if (held >= 0 && !viewPanes().includes(screen.focused)) { teamLists[1].select(held); teamLists[1].focus(); draw(); return; }
    if (screen.focused === ask && !closing) focusContent(); else draw();
  });
  // Tabs and buttons
  tabs.forEach((tab, index) => {
    tab.on('press', () => catchAction(() => { if (ask._reading) ask.cancel(); showView(tab.viewName); focusContent(); }));
    tab.key(['left', 'right'], (_, key) => { tabs[(index + (key.name === 'left' ? -1 : 1) + tabs.length) % tabs.length].focus(); draw(); });
    tab.key('down', () => { const next = subButtons()[0] ?? viewPanes()[0]; if (next) { next.focus(); draw(); } else focusInput(); });
    tab.on('focus', () => draw());
  });
  newBot.on('press', () => catchAction(() => botsAction('new')));
  newProject.on('press', () => catchAction(() => projectsAction('new')));
  back.on('press', () => catchAction(() => { if (ask._reading) ask.cancel(); showView(view === 'kanban' ? 'projects' : returnTo); focusContent(); }));
  newCard.on('press', () => catchAction(() => kanbanAction(0, 'new')));
  kanbanPick.on('press', () => catchAction(async () => { await pickKanbanBoard(); draw(); }));
  for (const widget of [newCard, kanbanPick, newBot, newProject, back]) {
    widget.key(['left', 'right'], (_, key) => { const row = subButtons(), at = row.indexOf(widget); row[(at + (key.name === 'left' ? -1 : 1) + row.length) % row.length].focus(); draw(); });
    widget.key('up', () => { activeTab().focus(); draw(); });
    widget.key('down', () => focusContent());
    widget.on('focus', () => draw());
  }
  for (const widget of [...tabs, newCard, kanbanPick, newBot, newProject, back]) widget.key('escape', () => focusInput());
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
  // Enter after a key that waits for its project to open waits with it, so the two stay together.
  board.key('enter', (ch, key) => { if (modal) return; if (opening && heldKeys.length) heldKeys.push([board, ch, key]); else catchAction(() => boardAction('open')); });
  board.key('right', () => { if (!modal) focusInput(); });
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
  // The bar's headings and its blank row cannot be chosen: an arrow, the wheel or a click that lands on
  // one goes on to the nearest row the way it was going, so the direct chats are reached with the keys.
  // The first heading has no row over it: a click there gives the row under it.
  let teamAt = 0;
  const teamChosen = at => teamRows[0][at]?.key !== undefined;
  teamLists.forEach((list, index) => {
    list.on('select', () => catchAction(() => teamAction(index, 'open')));
    for (const [keys, action] of [[['y'], 'accept'], [['n'], 'decline'], [['a'], 'ask'], [['c'], 'continue'], [['t'], 'trust'], [['h'], 'hold'], [['o'], 'auto'], [['e'], 'edit'], [['m'], 'members'], [['x'], 'leave']]) list.key(withShift(keys), () => { if (!modal) catchAction(() => teamAction(index, action)); });
    list.key('escape', () => focusInput());
    list.on('focus', () => { lastPane.chats = list; draw(); });
    list.on('select item', (_, at) => {
      if (index === 0 && !drawing && !teamChosen(at)) {
        const down = teamRows[0].findIndex((row, place) => place > at && teamChosen(place)), up = teamRows[0].findLastIndex((row, place) => place < at && teamChosen(place));
        list.select(at < teamAt && up >= 0 ? up : down >= 0 ? down : teamAt); return;
      }
      if (index === 0) teamAt = at;
      // A heading stays in view over its first row: a short bar scrolled it away as the cursor came up to that row.
      if (index === 0 && at > 0 && !teamChosen(at - 1) && list.childBase >= at && list.height > 1) list.scrollTo(at - 1);
      if (!drawing) scheduleDraw();
    });
  });
  teamLists[0].key('right', () => { if (!modal && screen.width >= 100) { teamLists[1].focus(); draw(); } });
  teamLists[1].key('left', () => { if (!modal && screen.width >= 100) { teamLists[0].focus(); draw(); } });
  activity.key('escape', leaveSession);
  // A page of a pane that scrolls: its height less one line, so the last line of one page is
  // the first of the next. A chat, the threads in Chats and the body of a dialog move by it.
  function pageOf(pane) { return Math.max(1, pane.height - pane.iheight - 1); }
  // In Chats the same keys move the cursor of the open one's threads a page, in the threads
  // or from the message box.
  function pageThreads(up) {
    const list = teamLists[1], last = list.items.length - 1;
    if (last >= 0) list.select(Math.max(0, Math.min(last, (list.selected ?? 0) + (up ? -1 : 1) * pageOf(list))));
    draw();
  }
  teamLists[1].key(['pageup', 'pagedown'], (_, key) => { if (!modal) pageThreads(key.name === 'pageup'); });
  // Where there are more threads than their pane shows, the key bar names the keys: last in
  // the threads, and after Enter over the message box, as over a session's chat.
  function withThreadsPage(pairs) {
    const list = teamLists[1], focused = screen.focused;
    if (view !== 'chats' || !teamOn || list.items.length <= list.height - list.iheight) return pairs;
    if (focused === list) return [...pairs, ['pgup pgdn', 'page']];
    return focused === ask && pairs[0]?.[0] === 'enter' ? [pairs[0], ['pgup pgdn', 'page'], ...pairs.slice(1)] : pairs;
  }
  // PgUp and PgDn move a chat a page, in the chat itself or from the message box under it.
  // What it changed moves the same way while it shows. false when nothing of the kind shows.
  function pageChat(up) {
    if (modal) return false;
    if (view === 'chats') { if (teamOn) pageThreads(up); return teamOn; }
    if (!changesBox.hidden) { moveChanges((up ? -1 : 1) * Math.max(1, (changesShown?.high ?? 2) - 1)); return true; }
    if (activity.hidden) return false;
    activity.scroll((up ? -1 : 1) * pageOf(activity)); draw(); return true;
  }
  activity.key(['pageup', 'pagedown'], (_, key) => pageChat(key.name === 'pageup'));
  // A session's two views share the right pane: its chat, and what it changed. One answer
  // from Git is kept per session, so coming back to a session shows it at once.
  let sessionView = 'chat', changesFrom = null, patchTimer = null, patchAsked = null, changesShown = null, built = { rows: [] };
  const patches = new Map();
  // Line notes, per session: they outlive the answer from Git, which only the last 24 keep.
  const lineNotes = new Map();
  // The row of the view the mouse is over, counted from its top row, or null.
  let changesHover = null;
  // The session whose changes are on screen, as root and id, or null.
  const patchKey = () => sessionView === 'changes' && view === 'chat' && controller && selectedId && snapshot?.tasks?.some(row => row.id === selectedId) ? `${controller.repo.root}\0${selectedId}` : null;
  // The session here the pane shows, its chat or its Changes, as root and id, or null. Its tab
  // counts its changes: read when it shows, then again when its turn ends or its state changes
  // (countMark, as its computer reads them for another computer of the owner's,
  // lib/peer/remote.mjs), from a timer, never while drawing. A count older than COUNT_AGAIN
  // is read again at the next draw, so a commit or checkout made in its folder between turns
  // shows once the screen changes; a slow read waits twenty times as long as it took.
  const shownKey = () => view === 'chat' && controller && selectedId && snapshot?.tasks?.some(row => row.id === selectedId) ? `${controller.repo.root}\0${selectedId}` : null;
  const countMark = task => `${task?.state}:${task?.runs?.length ?? 0}:${task?.activeRole ?? ''}`;
  const COUNT_AGAIN = 10000;
  let countTimer = null, countAsked = null;
  function askCount(key, mark) { clearTimeout(countTimer); countAsked = `${key}\0${mark}`; countTimer = setTimeout(() => { countTimer = null; countAsked = null; readPatch(key, { count: true }); }, 150); }
  const unfolded = (entry, file) => entry.fold.get(fileKey(file)) ?? entry.wide ?? true;
  // The session the pane shows: one of this computer that is open, or the one of another computer under the cursor.
  const sessionShown = () => Boolean(remoteHere()) || view === 'chat' && Boolean(controller && selectedId && snapshot?.tasks?.some(row => row.id === selectedId));
  // A session on another computer has the same view. Its changes are what that computer sent
  // (remoteApp.changes), whole, kept like a local session's under the row's key. Until they
  // are here, said is the line the view shows instead.
  function remotePatch(row) {
    const key = `remote\0${row.key}`, found = remoteApp.changes(row);
    let entry = patches.get(key);
    if (!entry) { entry = { changes: null, error: null, fold: new Map(), wide: null, version: 0, cursor: 0, top: 0 }; patches.set(key, entry); if (patches.size > 24) patches.delete(patches.keys().next().value); }
    entry.said = found.note ? { text: found.note, tone: found.tone } : null;
    if (found.changes && found.changes !== entry.changes) {
      // The cursor stays on its file while the rows around it change.
      const at = built.entry === entry ? built.rows[entry.cursor] : null, name = at?.file != null && entry.changes.files[at.file] ? fileKey(entry.changes.files[at.file]) : null, gap = entry.cursor - entry.top;
      entry.changes = found.changes; entry.version++;
      // Up to five files start unfolded when they are short. More, or longer ones, start folded,
      // as a list to pick from: opening the view then costs the same however much was changed.
      if (entry.wide === null && found.changes.files.length) entry.wide = found.changes.files.length <= 5 && found.changes.files.reduce((sum, file) => sum + file.hunks.reduce((lines, hunk) => lines + hunk.lines.length, 0), 0) <= 2000;
      const index = name === null ? -1 : found.changes.files.findIndex(file => fileKey(file) === name), start = index < 0 || !built.width ? -1 : patchRows(entry, built.width).findIndex(shown => shown.file === index);
      if (start >= 0) { entry.cursor = start; entry.top = Math.max(0, start - gap); }
    }
    return entry;
  }
  // The rows for one width, built again only when the changes, the width or a fold moves.
  function patchRows(entry, width) {
    if (built.entry !== entry || built.changes !== entry.changes || built.width !== width || built.version !== entry.version) {
      // A pane that changes its width wraps its rows anew: the cursor stays at its file, or at its change in it.
      const at = built.entry === entry && built.changes === entry.changes && built.version === entry.version ? built.rows[entry.cursor] : null;
      const head = row => row.file === at.file && (row.kind === 'file' || row.kind === 'hunk'), passed = at?.file != null ? built.rows.slice(0, entry.cursor + 1).filter(head).length : 0;
      const open = new Set(entry.changes.files.flatMap((file, index) => unfolded(entry, file) ? [index] : []));
      built = { entry, changes: entry.changes, width, version: entry.version, rows: changeRows(entry.changes, width, colour, { open, notes: entry.notes }) };
      if (passed) {
        // A view that shows its first row keeps showing it: the summary above stays in sight.
        let seen = 0; const now = built.rows.findIndex(row => head(row) && ++seen === passed), gap = entry.cursor - entry.top;
        if (now >= 0) { entry.cursor = now; entry.top = entry.top ? Math.max(0, now - gap) : 0; }
      }
    }
    return built.rows;
  }
  // Asks Git what the session on screen changed. This starts Git, so it runs from a timer of
  // its own and never while drawing. A read that finds nothing new keeps the rows as they are.
  // count: only the tab's count is asked for, while the chat shows.
  function readPatch(key, { count = false } = {}) {
    if (!count) patchTimer = null;
    if (closing || key !== (count ? shownKey() : patchKey())) return;
    const id = selectedId, task = snapshot.tasks.find(row => row.id === id), started = Date.now();
    const entry = patches.get(key) ?? { changes: null, digest: null, error: null, fold: new Map(), wide: null, version: 0, cursor: 0, top: 0 };
    // They are kept with the session, so they are read back after ELU starts again.
    if (!lineNotes.has(key)) lineNotes.set(key, readNotes(controller.repo, id));
    const repo = controller.repo; entry.notes = lineNotes.get(key); entry.keep = () => saveNotes(repo, id, entry.notes);
    // The sessions looked at last are kept. The oldest goes first.
    patches.delete(key); patches.set(key, entry); if (patches.size > 24) patches.delete(patches.keys().next().value);
    try {
      // A pull request that becomes known after this read is shown by one more read.
      const changes = taskPatch(controller.repo, id, { changed: () => { if (!closing && key === patchKey() && !patchTimer) askPatch(key, 0); } }), digest = hash(JSON.stringify(changes));
      entry.error = null;
      if (digest !== entry.digest) {
        // The cursor stays on its line of its file while the rows around it change.
        const old = built.entry === entry ? built.rows : null, at = old?.[entry.cursor], name = at?.file != null && entry.changes.files[at.file] ? fileKey(entry.changes.files[at.file]) : null;
        const offset = name === null ? 0 : entry.cursor - old.findIndex(row => row.file === at.file), gap = entry.cursor - entry.top;
        entry.changes = changes; entry.digest = digest;
        // A note goes with its line when the line only moved.
        if (placeNotes(entry.changes, entry.notes)) entry.keep();
        // Up to five files start unfolded. More start folded, as a list to pick from.
        if (entry.wide === null && changes.files.length) entry.wide = changes.files.length <= 5;
        if (built.width) {
          const rows = patchRows(entry, built.width), index = name === null ? -1 : changes.files.findIndex(file => fileKey(file) === name), start = index < 0 ? -1 : rows.findIndex(row => row.file === index);
          if (start >= 0) { entry.cursor = start + Math.min(offset, rows.filter(row => row.file === index).length - 1); entry.top = Math.max(0, entry.cursor - gap); }
        }
      }
    } catch (error) { entry.error = plain(error.message).replace(/\s+/g, ' ').trim() || 'The changes could not be read.'; }
    entry.live = ['running', 'preparing'].includes(task?.state); entry.at = Date.now(); entry.took = entry.at - started; entry.mark = countMark(task);
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
    if (to === ask || !listed() && to !== activity) focusInput(); else if (to === activity && (view === 'chat' || remoteHere())) activity.focus(); else focusBoard();
  }
  function showChat() { sessionView = 'chat'; if (screen.focused === changesBox) leaveChanges(); draw(); }
  // focus: the keys go to the view (d on the list, a click on its name). A command typed in
  // the message box leaves them there.
  function showChanges({ focus = false } = {}) {
    const there = remoteHere();
    if (!there && (!controller || view !== 'chat' || !controller.snapshot().tasks.some(row => row.id === selectedId))) throw new Error('Open a session first.');
    sessionView = 'changes';
    // A session on another computer: what it sent is here already, and one not sent yet is asked for now.
    if (there) { patchAsked = `remote\0${there.key}`; askPatch(null); remoteApp.changes(there, { fetch: true }); }
    else { patchAsked = `${controller.repo.root}\0${selectedId}`; askPatch(patchAsked, 0); }
    if (focus && screen.focused !== changesBox) { const from = screen.focused; if (ask._reading) ask.cancel(); changesBox.focus(); changesFrom = [board, ask, activity].includes(from) ? from : null; }
    draw();
  }
  // The switch, and under it the rows in view when Changes shows. Nothing here asks Git.
  function drawSessionViews(task) {
    const there = remoteHere(), offered = view === 'chat' && Boolean(task) || Boolean(there), on = offered && sessionView === 'changes';
    const key = !on ? null : there ? `remote\0${there.key}` : `${controller.repo.root}\0${task.id}`, entry = !key ? null : there ? remotePatch(there) : patches.get(key) ?? null;
    // Another session shows, or the view came back: its changes are read once the cursor rests on it.
    // One on another computer has sent them, or is asked for them now.
    if (key !== patchAsked) { patchAsked = key; askPatch(there ? null : key, 150); if (there && on) remoteApp.changes(there, { fetch: true }); }
    sessionTabs.hidden = !offered; changesBox.hidden = !on; changesShown = null;
    // A session here: its tab counts its changes without them open, as one on another computer's does.
    if (offered && !there && !on) {
      const shown = `${controller.repo.root}\0${task.id}`, mark = countMark(task), had = patches.get(shown);
      const old = had?.mark === mark && Date.now() - had.at > Math.max(COUNT_AGAIN, (had.took ?? 0) * 20);
      if ((had?.mark !== mark || old) && countAsked !== `${shown}\0${mark}`) askCount(shown, mark);
    }
    if (offered) {
      // The count is the last one read, also while the chat shows.
      const known = there ? remoteApp.changes(there) : patches.get(`${controller.repo.root}\0${task.id}`), label = changeSummary(known && !known.error ? known.changes : null);
      const word = (text, active) => active ? `${colour ? `{${PALETTE.orange}-fg}` : ''}{bold}{underline}${text}{/underline}{/bold}${colour ? '{/}' : ''}` : ink(text, 'muted', colour);
      sessionTabs.setContent(` ${word('Chat', !on)}   ${word(label, on)} `);
      Object.assign(sessionTabs, { top: activity.top, left: activity.left + 1, width: label.length + 9 });
    }
    if (!on) changesHover = null;
    // The pane went while it had the focus (its session closed elsewhere): the focus goes back.
    if (!on) { if (screen.focused === changesBox) leaveChanges(); return; }
    activity.hidden = true;
    Object.assign(changesBox, { top: activity.top, left: activity.left, width: activity.width, height: activity.height });
    changesBox.style.border.fg = screen.focused === changesBox ? accent : shade('border');
    // A row is the cursor's mark, the text, then the scrollbar's column. What is said in place of the rows is said whole.
    const high = Math.max(1, changesBox.height - 2), width = Math.max(8, changesBox.width - 4), line = (text, tone) => wrapText(text, width).map(part => ({ text: ink(part, tone, colour), kind: 'note', file: null }));
    const hasFiles = Boolean(entry?.changes) && !entry.error;
    const rows = !entry ? line('Reading changes…', 'muted') : entry.error ? line(entry.error, 'orange') : !entry.changes ? line(entry.said?.text ?? 'No changes yet.', entry.said?.tone ?? 'muted') : patchRows(entry, width);
    // The first time a session's files show, the cursor is on the first of them.
    if (entry?.changes?.files.length && !entry.placed) { entry.placed = true; if (!entry.cursor) entry.cursor = Math.max(0, rows.findIndex(row => row.kind === 'file')); }
    const cursor = Math.max(0, Math.min(entry?.cursor ?? 0, rows.length - 1)), most = Math.max(0, rows.length - high);
    const top = Math.max(cursor - high + 1, Math.min(entry?.top ?? 0, cursor, most));
    if (entry) { entry.cursor = cursor; entry.top = top; }
    const thumb = most ? Math.round((high - 1) * top / most) : -1, tone = screen.focused === changesBox ? 'orange' : 'dim';
    // On a line the cursor is a +: a click on it, or the + key, notes what should change there.
    // The line under the mouse shows one too, so it is clear where to click. A session on
    // another computer takes no line notes, so its cursor is the bar on every row. What is
    // said in place of the rows has no cursor.
    const noted = row => Boolean(row.line) && Boolean(entry?.notes);
    const mark = (row, at) => { const over = at === changesHover && noted(row); return over || hasFiles && rows.length > 1 && top + at === cursor ? ink(noted(row) ? '+' : '▌', over ? 'orange' : tone, colour) : ' '; };
    changesBox.setContent(rows.slice(top, top + high).map((row, at) => `${mark(row, at)}${row.text}${' '.repeat(Math.max(0, width - widthOf(visible(row.text))))}${at === thumb ? ink('┃', 'dim', colour) : ' '}`).join('\n'));
    changesShown = { key, entry: entry?.error || !entry?.changes ? null : entry, rows, high, top, cursor };
  }
  // Up and Down move the cursor a row, and the rows follow it. The wheel moves the rows one a step, and the cursor stays in view.
  function moveChanges(step, { rows = false, redraw = true } = {}) {
    const now = changesShown, entry = now?.entry; if (modal || !entry) return;
    const last = now.rows.length - 1, most = Math.max(0, now.rows.length - now.high);
    if (rows) { entry.top = Math.max(0, Math.min(most, entry.top + step)); entry.cursor = Math.max(entry.top, Math.min(entry.top + now.high - 1, entry.cursor, last)); }
    else { entry.cursor = Math.max(0, Math.min(last, entry.cursor + step)); if (Math.abs(step) > 1) entry.top = Math.max(0, Math.min(most, entry.top + step)); }
    if (redraw) draw();
  }
  // Folds or unfolds the file whose header is on that row.
  function foldChanges(index) {
    const now = changesShown, entry = now?.entry, row = now?.rows[index], file = row?.kind === 'file' ? entry?.changes.files[row.file] : null; if (modal || !file) return;
    const open = !unfolded(entry, file);
    entry.fold.set(fileKey(file), open); entry.version++; entry.cursor = index;
    // An unfolded file shows: the rows move up as far as its last row needs, never past its name.
    if (open && built.width) entry.top = Math.max(entry.top, Math.min(index, patchRows(entry, built.width).findLastIndex(shown => shown.file === row.file) - now.high + 1));
    draw();
  }
  // [ and ] go to the file before and the file after; n and p to the next change and the one
  // before. A folded file on the way to a change is unfolded, so n walks every change there is.
  function stepChanges(kind, step) {
    const now = changesShown, entry = now?.entry; if (modal || !entry) return;
    let rows = now.rows, at = -1;
    for (let index = kind === 'file' || step < 0 ? now.cursor + step : now.cursor; index >= 0 && index < rows.length && at < 0; index += step) {
      const row = rows[index], file = row.kind === 'file' ? entry.changes.files[row.file] : null;
      if (kind === 'file') { if (file) at = index; continue; }
      if (row.kind === 'hunk' && index !== now.cursor) at = index;
      else if (file?.hunks.length && !unfolded(entry, file) && built.width) {
        entry.fold.set(fileKey(file), true); entry.version++; rows = patchRows(entry, built.width);
        at = step > 0 ? rows.findIndex(shown => shown.file === row.file && shown.kind === 'hunk') : rows.findLastIndex(shown => shown.file === row.file && shown.kind === 'hunk');
      }
    }
    if (at < 0) return;
    // A change, or a file that is open, comes to the top of the view, so what it holds shows under it.
    const file = entry.changes.files[rows[at].file];
    entry.cursor = at; if (kind !== 'file' || unfolded(entry, file)) entry.top = at;
    draw();
  }
  // + on a line asks what should change there. The note shows under the line, and s sends
  // every note to the session's model together, in one message.
  async function noteChanges(index) {
    const now = changesShown, entry = now?.entry, line = now?.rows[index]?.line; if (modal || !entry?.notes) return;
    if (!line) throw new Error('Move to a line first: + notes what should change there.');
    const key = noteKey(line), had = entry.notes.get(key)?.note ?? '', where = line.kind === 'del' ? `removed line ${line.old}` : `line ${line.now ?? line.old}`;
    const text = await prompt('Note', `${line.path}, ${where}\n${line.text}\n\nWhat should change here? Empty removes the note.`, had);
    if (text != null) { if (text.trim()) entry.notes.set(key, { ...line, note: text.trim() }); else entry.notes.delete(key); entry.version++; entry.keep(); }
    // The hint above can take a row more or less now: the cursor stays on its line.
    const at = text != null && built.width ? patchRows(entry, built.width).findIndex(row => row.line && row.kind !== 'mark' && noteKey(row.line) === key) : -1; if (at >= 0) entry.cursor = at;
    if (!changesBox.hidden) changesBox.focus();
    draw();
  }
  async function sendNotes() {
    const entry = changesShown?.entry; if (modal || !entry?.notes) return;
    if (!entry.notes.size) throw new Error('No notes yet. + on a line notes what should change.');
    const count = entry.notes.size, draft = ask.getValue();
    // It goes as a message to the model, as one typed in the box would; what was typed stays.
    await submit(`@model ${notesMessage(entry.notes, entry.changes)}`);
    const sent = ask.getValue() === '';
    if (draft) ask.setValue(draft);
    if (!sent) { if (!draft) ask.clearValue(); draw(); return; }
    entry.notes.clear(); entry.version++; entry.keep();
    setMessage(count === 1 ? 'Sent your note to the model.' : `Sent ${count} notes to the model together.`); draw();
  }
  changesBox.key(['+'], () => { if (!modal) catchAction(() => noteChanges(changesShown?.cursor)); });
  changesBox.key(['s'], () => { if (!modal) catchAction(() => sendNotes()); });
  changesBox.key(['up', 'down'], (_, key) => moveChanges(key.name === 'up' ? -1 : 1));
  changesBox.key(['pageup', 'pagedown'], (_, key) => moveChanges((key.name === 'pageup' ? -1 : 1) * Math.max(1, (changesShown?.high ?? 2) - 1)));
  changesBox.key(['home', 'end'], (_, key) => moveChanges(key.name === 'home' ? -Infinity : Infinity));
  changesBox.key(['enter', 'space'], () => foldChanges(changesShown?.cursor));
  changesBox.key(['[', ']'], ch => stepChanges('file', ch === '[' ? -1 : 1));
  changesBox.key(withShift(['n', 'p']), (_, key) => stepChanges('change', key.name === 'p' ? -1 : 1));
  changesBox.key(['escape', ...withShift(['d'])], () => { if (!modal) showChat(); });
  steadyWheel(changesBox, step => moveChanges(step, { rows: true, redraw: false }), { render: () => draw() });
  // A click puts the cursor on its row. On a file's header it also folds or unfolds the file.
  changesBox.on('click', data => {
    const now = changesShown, index = now ? now.top + data.y - changesBox.atop - 1 : -1; if (modal || !now?.entry || index < now.top || index >= now.rows.length) return;
    if (now.rows[index].kind === 'file') foldChanges(index);
    // A click on the + beside a line notes it, as the + key does.
    else if (now.rows[index].line && now.entry.notes && data.x - changesBox.aleft <= 1) { now.entry.cursor = index; draw(); catchAction(() => noteChanges(index)); }
    else { now.entry.cursor = index; draw(); }
  });
  // The + follows the mouse from line to line, and goes when the mouse leaves the view.
  const hoverChanges = at => { if (at !== changesHover) { changesHover = at; scheduleDraw(); } };
  changesBox.on('mousemove', data => { if (!modal) hoverChanges(data.y - changesBox.atop - 1); });
  changesBox.on('mouseout', () => hoverChanges(null));
  // Leaving the message box by a key passes through the list on the way to this view, so
  // the box counts as where the focus came from for the rest of that key.
  let leftBox = false;
  ask.on('blur', () => { leftBox = true; setImmediate(() => { leftBox = false; }); });
  changesBox.on('focus', from => { const origin = leftBox ? ask : from; if ([board, ask, activity].includes(origin)) changesFrom = origin; draw(); });
  sessionTabs.on('click', data => { if (!modal) catchAction(() => data.x - sessionTabs.aleft < 6 ? showChat() : showChanges({ focus: true })); });
  // A message sent to a session on another computer from its Changes shows in its chat, as one sent to a session here does.
  ask.on('submit', text => { if (sessionView === 'changes' && remoteHere() && text.trim() && !text.trim().startsWith('/')) sessionView = 'chat'; });
  // Kanban
  // A click on a card opens it, as Enter does, also in a column that did not have the focus.
  // blessed selects the clicked card and opens (select) only one that was already selected,
  // so a click on any other card opens it here; one that select opened is not opened again.
  kanbanLists.forEach((list, index) => {
    let cardOpened = false;
    list.on('select', () => { cardOpened = true; queueMicrotask(() => { cardOpened = false; }); catchAction(() => kanbanAction(index, 'open')); });
    list.on('element click', el => { if (!modal && el !== list && !cardOpened && list.items.includes(el)) catchAction(() => kanbanAction(index, 'open')); });
    list.key(['left', 'right'], (_, key) => { if (modal) return; const next = kanbanLists[index + (key.name === 'left' ? -1 : 1)]; if (next) { next.focus(); draw(); } });
    list.key(['S-right', '>'], () => { if (!modal) catchAction(() => kanbanAction(index, 'forward')); });
    list.key(['S-left', '<'], () => { if (!modal) catchAction(() => kanbanAction(index, 'back')); });
    list.key(['n', '+'], () => { if (!modal) catchAction(() => kanbanAction(index, 'new')); });
    list.key(['x', 'delete'], () => { if (!modal) catchAction(() => kanbanAction(index, 'remove')); });
    list.key('escape', () => focusInput());
    list.on('focus', () => { lastPane.kanban = list; draw(); });
    list.on('select item', () => { if (!drawing) scheduleDraw(); });
  });
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
  projectsList.key(withShift(['c']), () => { if (!modal) catchAction(() => projectsAction('bring')); });
  projectsList.key('escape', () => focusInput());
  projectsList.on('focus', () => draw());
  projectsList.on('select item', () => { if (!drawing) scheduleDraw(); });
  // Usage
  usageList.on('select', () => catchAction(() => usageAction('open')));
  usageList.key(withShift(['r']), () => { if (!modal) catchAction(() => usageAction('refresh')); });
  for (const [keys, action] of [[['a'], 'add'], [['x'], 'forget'], [['d'], 'details'], [['c'], 'check'], [['s'], 'signin']]) usageList.key(withShift(keys), () => { if (!modal) catchAction(() => usageAction(action)); });
  usageList.key(withShift(['t']), () => { if (!modal) { usagePeriod = usagePeriod === 1 ? 7 : 1; draw(); } });
  usageList.key('escape', () => focusInput());
  usageList.on('focus', () => draw());
  // The blank line, the headings and the lines under the agents cannot be chosen: an arrow, the
  // wheel or a click that lands on one goes on to the nearest row the way it was going, so Down
  // from the last account goes into Top agents and Up comes back, at any size. A row keeps in
  // view the lines over it up to the row before (the heading and the table's header over the
  // first agent), and the last one the lines under it (the spend line).
  let usageAt = 0;
  const usageChosen = at => Boolean(usageRows[at]?.vendor || usageRows[at]?.agent || usageRows[at]?.none);
  usageList.on('select item', (_, at) => {
    if (drawing) return;
    if (!usageChosen(at)) {
      const down = usageRows.findIndex((row, place) => place > at && usageChosen(place)), up = usageRows.findLastIndex((row, place) => place < at && usageChosen(place));
      const to = at < usageAt && up >= 0 ? up : down >= 0 ? down : up;
      if (to >= 0) { usageList.select(to); return; }
    }
    usageAt = at;
    const shown = usageList.height - usageList.iheight;
    let top = at; while (top > 0 && !usageChosen(top - 1)) top--;
    const last = !usageRows.some((row, place) => place > at && usageChosen(place));
    if (last && usageRows.length - 1 - top < shown) usageList.scrollTo(usageRows.length - 1);
    if (top < usageList.childBase && at - top < shown) usageList.scrollTo(top);
    scheduleDraw();
  });
  // The screen hears a key before the focused list moves, so a list can be left from its edge:
  // up to the view's buttons, down to the next pane or the message box.
  // The empty Bots list is one message over its rows, so every row of it is an edge.
  // The Chats bar ends at its first and last rows that can be chosen: its first row is a heading.
  // So does the Usage list: the lines under its last agent are not rows.
  const edgeRows = list => list === teamLists[0] && teamRows[0].some((row, at) => teamChosen(at)) ? [teamRows[0].findIndex((row, at) => teamChosen(at)), teamRows[0].findLastIndex((row, at) => teamChosen(at))]
    : list === usageList && usageRows.some((row, at) => usageChosen(at)) ? [usageRows.findIndex((row, at) => usageChosen(at)), usageRows.findLastIndex((row, at) => usageChosen(at))] : [0, list.items.length - 1];
  const atEdge = (list, key) => list === botsList && !botRows.length || (key.name === 'up' ? (list.selected ?? 0) <= edgeRows(list)[0] : key.name === 'down' && (list.selected ?? 0) >= edgeRows(list)[1]);
  screen.on('keypress', (_, key = {}) => {
    const focused = screen.focused;
    if (modal || closing || !(focused === composeList || teamLists.includes(focused) || kanbanLists.includes(focused) || [botsList, projectsList, usageList].includes(focused)) || !['up', 'down'].includes(key.name) || !atEdge(focused, key)) return;
    // Stacked panes (Internal under 100 columns) lead into each other first.
    const panes = viewPanes(), at = panes.indexOf(focused), stacked = view === 'chats' && screen.width < 100;
    if (key.name === 'up') { if (stacked && at > 0) panes[at - 1].focus(); else (view === 'kanban' ? subButtons()[0] ?? activeTab() : view === 'bots' ? newBot : view === 'projects' ? newProject : listed() || ['chats', 'usage'].includes(view) ? activeTab() : back).focus(); }
    else if (stacked && at >= 0 && at < panes.length - 1) panes[at + 1].focus();
    else focusInput();
    draw();
  });
  // Ctrl-O opens or folds the steps of every turn in the chat (lib/run-activity.mjs).
  screen.key(['C-o'], () => { if (!modal && !closing) toggleSteps(); });
  // A click on a turn's steps line opens or folds that turn's steps.
  activity.on('click', data => {
    if (modal || !stepKeys.length) return;
    const rows = activity._clines ?? [], at = data.y - activity.atop - activity.itop + activity.childBase, line = index => String(rows[index] ?? '').replace(/\x1b\[[\d;]*m/g, '').trimStart();
    if (!STEPS_LINE.test(line(at))) return;
    let turn = 0; for (let index = 0; index < at; index++) if (STEPS_LINE.test(line(index))) turn++;
    if (stepKeys[turn]) toggleSteps(stepKeys[turn]);
  });
  // Esc while /join looks for the inviter, from anywhere but the message box (which hears it first).
  screen.on('keypress', (_, key = {}) => { if (key.name === 'escape' && !modal && !closing && screen.focused !== ask) cancelJoin(); });
  // Ctrl-C with text highlighted copies it and stays; with none it quits. The highlight stays
  // too, as in any text field: the next key or click acts on it as it would before the copy.
  screen.key(['C-c'], () => catchAction(() => {
    const text = mouseSelection.text(); if (!text) return quit();
    copyText?.(text); copied(text);
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
  // Text put in the empty box, typed or set, notes the row a lone y or n in it would answer.
  const nativeSetValue = ask.setValue;
  ask.setValue = function(value) { if (!this.value && typeof value === 'string' && value) typedFor = answerTarget(); return nativeSetValue.apply(this, arguments); };
  const nativeInput = ask._listener;
  ask._listener = function(ch, key = {}) {
    if (!this._reading || typeof this._done !== 'function') return;
    if (key.name === 'escape' && cancelJoin()) return;
    // Ctrl-O opens or folds the steps of every turn in the chat, as in Claude Code, while typing too.
    if (key.ctrl && key.name === 'o') { toggleSteps(); return; }
    if (!this.getValue()) typedFor = answerTarget();
    // PgUp and PgDn page the chat above the box; the text and its cursor stay as they are.
    if (['pageup', 'pagedown'].includes(key.name) && !key.ctrl && !key.meta && pageChat(key.name === 'pageup')) return;
    syncPalette();
    if (!palette.hidden) {
      if ((key.name === 'up' || key.name === 'down') && !key.shift) { palette.select((palette.selected + (key.name === 'up' ? -1 : 1) + paletteValues.length) % paletteValues.length); screen.render(); return; }
      if (key.name === 'escape') { paletteDismissed = this.getValue(); palette.hide(); screen.render(); return; }
      if (key.name === 'tab') { this.setValue(`${paletteValues[palette.selected ?? 0].value} `); syncPalette(); screen.render(); return; }
      if (key.name === 'enter' && key.sequence !== '\n') {
        const chosen = paletteValues[palette.selected ?? 0];
        // A bot's whole @name, typed out, is sent as it is: Enter alone adds that bot to the session.
        const whole = view !== 'chats' && chosen.value.startsWith('@') && this.getValue().trim() === chosen.value;
        if (chosen.more && !whole) { choosePalette(chosen); return; }
        this.setValue(chosen.value);
      }
    } else if (recall && ['up', 'down'].includes(key.name) && !key.shift && this.getValue() === recall.list[recall.at]) {
      // Walking through what was sent: Up is older, Down is newer, and Down past the newest empties the box.
      const at = recall.at + (key.name === 'up' ? -1 : 1);
      if (at >= recall.list.length) { const dropped = recall.taken; recall = null; this.setValue(''); if (dropped) setMessage('Dropped. It will not be sent.'); }
      else if (at >= 0) { recall.at = at; this.setValue(recall.list[at]); }
      paletteDismissed = this.getValue(); syncPalette(); screen.render(); return;
    } else if (!this.getValue() && ['up', 'down'].includes(key.name) && !key.shift) {
      // Up in an empty box takes back the newest message that still waits for the turn to end:
      // it is in the box again, Enter sends it and Down drops it.
      const restore = taken => { const list = [...sentBefore().filter(text => text !== taken.trim()), taken]; recall = { list, at: list.length - 1, taken: true }; this.setValue(taken); paletteDismissed = taken; syncPalette(); setMessage('Taken back. Enter sends it again · ↓ drops it.'); };
      const taken = key.name === 'up' ? takeBack(() => !this.getValue()) : null;
      // One on the running turn's input is asked back from that turn: the answer comes in a moment.
      if (taken !== null && typeof taken === 'object') {
        taken.later?.then(text => { if (typeof text === 'string') restore(text); else setMessage(text === null ? 'The running turn already took it.' : text === false ? 'Not taken back: the box has text.' : 'Not given back yet · ↑ again in a moment.'); }, () => {});
        return;
      }
      if (taken !== null) { restore(taken); return; }
      // Up in an empty box brings back the last thing sent. With nothing sent yet, the arrows leave the box as before.
      const list = key.name === 'up' ? sentBefore() : [];
      if (list.length) { recall = { list, at: list.length - 1 }; this.setValue(list.at(-1)); paletteDismissed = this.getValue(); syncPalette(); screen.render(); return; }
      this.cancel(); focusContent(key.name === 'up' && view !== 'kanban' ? viewPanes().length - 1 : 0); return;
    } else if (key.name === 'left' && this.cursor === 0 && listed() && !key.ctrl && !key.meta && !key.shift && !this.selection()) {
      // Left at the start of the text goes back to the list; with text highlighted it ends the highlight.
      this.cancel(); return;
    }
    if (key.name === 'tab') return;
    // Enter sends. A newline inside pasted text arrives as a bare line feed and stays in the message.
    if (key.name === 'enter' && key.sequence !== '\n') { this._done(null, this.value); return; }
    const value = nativeInput.call(this, ch, key); syncPalette(); screen.render(); return value;
  };
  // On a Sessions row, and in a session's chat, every printable character starts a message:
  // it goes into the box, which takes the focus, so the rest of what is typed follows it. No
  // letter acts by itself there: a key is its letter, then Enter (rowKey). Ctrl and Alt
  // letters type nothing.
  function typesMessage(ch, key) {
    return typeof ch === 'string' && /^[^\x00-\x1f\x7f]$/u.test(ch) && !key.ctrl && !key.meta && (screen.focused === activity || listed() && screen.focused === board);
  }
  function typeFrom(from, ch, key) {
    if (screen.focused !== ask) { focusInput(); if (screen.focused !== ask) return; typedFrom = from; typedBase = ask.getValue(); typedFor = answerTarget(); }
    ask._listener(ch, key);
  }
  // A character typed on a tab or a view's button starts a message there too, so nothing typed
  // is lost: q still quits, ? opens the help, and a space presses the button. On a list whose
  // letters act at once (Usage, Bots, Projects, Kanban, Chats, the New session form), / starts
  // a command in the box the same way, and every key after it goes there.
  const printable = (ch, key) => typeof ch === 'string' && /^[^\x00-\x1f\x7f\s]$/u.test(ch) && !key.ctrl && !key.meta;
  screen.on('keypress', (ch, key = {}) => {
    if (modal || closing || screen.focused === ask || busy || minimumSize()) return;
    const command = key.name ?? ch;
    if ([...tabs, newCard, kanbanPick, newBot, newProject, back].includes(screen.focused) && !['q', '?'].includes(command)) { if (printable(ch, key)) typeFrom(null, ch, key); return; }
    if (ch === '/' && printable(ch, key) && [usageList, botsList, projectsList, composeList, ...kanbanLists, ...teamLists].includes(screen.focused)) { typeFrom(null, ch, key); return; }
    if (typesMessage(ch, key)) {
      const from = screen.focused;
      // The row the cursor just moved to shows first, so the character lands in its own box.
      // While its project is still opening, what is typed waits for it.
      if (from === board && barKey !== openKey && !opening) draw();
      if (opening) heldKeys.push([from, ch, key]); else typeFrom(from, ch, key);
      return;
    }
    if (command === 'q') catchAction(() => quit());
    else if (command === '?') catchAction(() => dispatch({ name: 'help', args: [] }));
  });
  // A signal closes ELU as q does, with the terminal put back first, in the handler. A process
  // that ends any other way puts it back as it exits.
  const interrupted = () => { restoreTerminal(); catchAction(() => quit()); };
  for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, interrupted);
  process.on('exit', restoreTerminal);
  screen.on('resize', resize);
  // The tick reads what changed on disk and draws it. While nothing on screen has changed for
  // two seconds and nothing was typed or clicked, it comes a third as often: an idle app then
  // costs next to nothing. The first change, key or click brings the usual pace back.
  let timer = null, unchangedSince = Date.now();
  const awake = () => { unchangedSince = Date.now(); };
  const tick = () => {
    const before = lastFrame; viewTick(); draw(true);
    if (lastFrame !== before) awake();
    if (!closing) timer = setTimeout(tick, Date.now() - unchangedSince >= 2000 ? refreshMs * 3 : refreshMs);
  };
  timer = setTimeout(tick, refreshMs);
  screen.program.on('keypress', awake); screen.program.on('mouse', awake);
  const scheduleTimer = setInterval(() => {
    try { if (tickBots() + runDue(new Date(), { start: conduct })) draw(); } catch { /* The login item retries. */ } refreshAwake();
    // A one-time run that has passed, or a session that was deleted, may have been the last schedule.
    keepLoginItem({ changed: true });
    // A computer of mine that just paired by GitHub is said once.
    try { const said = facade && peerOn() ? remoteApp.paired() : null; if (said) setMessage(said); } catch { /* Said on the next look. */ }
  }, 30000);
  const usageTimer = setInterval(() => { if (usageEnabled && !closing && view === 'chat') controller.refreshUsage().then(draw); }, 60000);
  // The owner's own MCP servers reach every account he added, one he adds or removes outside
  // ELU too, within a few seconds (lib/logins.mjs). A look with nothing changed reads nothing.
  try { shareServersAll(); } catch { /* Looked at again in a moment. */ }
  const serversTimer = setInterval(() => { try { shareServersAll(); } catch { /* Looked at again in a moment. */ } }, 5000);
  // When a session there answers what your agent here sent it, your agent here goes on by itself (lib/remote-helper.mjs).
  const helperTimer = setInterval(() => {
    try { if (facade && helperTick({ views: peerList('remoteSessions'), enqueue: queueRequest, requests: pendingRequests, sessions: root => savedTasks(helperRepo(root)), session: (root, id) => readTask(helperRepo(root), id) })) { conduct(); draw(); } } catch { /* Looked at again in a moment. */ }
  }, 2000);
  // The line after a message to a teammate follows it, and one from a teammate that failed here is said (sentTick, failedTick).
  // A teammate's computer that says it is mine, and is not marked here, is said once, with the command that agrees.
  const sentTimer = setInterval(() => {
    try { sentTick(); failedTick(); } catch { /* Looked at again in a moment. */ }
    try { const said = facade && peerOn() ? remoteApp.asks() : null; if (said) setMessage(said); } catch { /* Said on the next look. */ }
  }, 2000);
  // Started in a folder that is not a project: open the last project used. Only a first start asks for a name.
  let here = repo ?? null;
  if (askProject && !here) { try { here = projectFolder(startDirectory); } catch { /* The disk root is never a project. */ } }
  let fresh = askProject && here && !teamStart && !knownProject(here);
  if (fresh) { let last = null; try { last = registeredProjects().at(-1); } catch { /* An unreadable registry asks for a name. */ } if (last) { here = last; fresh = false; } }
  try {
    if (here && !fresh) activateProject(here);
    // The login item follows this install, so a moved checkout or a new Node still runs schedules.
    // One that an earlier version left with nothing on is removed. The project is registered by now.
    keepLoginItem();
    resize(); focusInput();
    // Sessions an earlier version still finishes, and messages that waited through a
    // downgrade, are named once, quietly, in the status line. Beside a conductor of an earlier
    // version that stays, or with a window of one open, this version's conductor starts now, so
    // even work queued before the update starts here. Work that is queued with no conductor
    // running starts now too: its conductor was ended from outside, by a restart of the
    // computer or by 0.1.19's login item on Linux. Not after the owner's own elu conductor
    // stop, which holds until work is queued (openingConductor).
    let opened = '';
    // A session an earlier version stopped at its two-hour limit, which this version does not
    // have, is carried on now in Approve for me and Full access, once (lib/carry-on.mjs).
    try { if (carryOnCapped({ enqueue: queueRequest })) conduct(); } catch { /* It waits for a reply, and says what stopped it. */ }
    try { opened = openingConductor({ start: conduct }) ?? ''; if (opened) setMessage(opened); } catch { /* Started with the next message. */ }
    // Opened right after an update, the earlier conductor is still the one that takes work: it hands
    // over a moment later, and only then are its sessions the ones to name. So they are looked for
    // through the first minute, and said once, before whatever the line says then.
    const drainSaid = () => { try { const note = conductorNote(); if (note && !closing && !message.includes(note)) setMessage(message ? `${note} ${message}` : note); return Boolean(note); } catch { return true; } };
    if (!/ started before the update /.test(opened)) { const started = Date.now(), look = setInterval(() => { if (closing || drainSaid() || Date.now() - started > 60000) clearInterval(look); }, 1000); look.unref?.(); }
    // A newer version is named in the status line. The check never holds up the start. It comes
    // after the line that names sessions from before the update, and after the start line that
    // says a team was closed while that line still shows: each is kept, and the notice follows.
    let closedNote = '';
    Promise.resolve().then(() => updateCheck()).then(text => { if (text && !closing) setMessage(/ started before the update /.test(message) ? `${message} ${text}` : closedNote && message.includes(closedNote) ? `${closedNote} ${text}` : text); }, () => {});
    // A team of my own that nobody else was ever on, left beside the team this machine then
    // joined (0.1.19 and earlier), is closed once as the app opens, and one line says so.
    try { const note = facade?.closedLine?.(facade.closeSoloTeams?.({ once: true })); if (note) { peerOnAt = 0; closedNote = plain(note); setMessage(message ? `${note} ${message}` : note); } } catch { /* The next join closes it. */ }
    if (fresh) setImmediate(() => catchAction(() => nameHere(here)));
    await done;
  } finally {
    clearTimeout(timer); clearInterval(usageTimer); clearInterval(serversTimer); clearInterval(helperTimer); clearInterval(sentTimer); clearInterval(changesTimer); clearTimeout(patchTimer); clearTimeout(countTimer); for (const signal of ['SIGTERM', 'SIGHUP']) process.off(signal, interrupted); process.off('exit', restoreTerminal);
    if (!closing) { closing = true; await stopPushes('closed').catch(() => {}); await controller?.close(); claim.release(); screen.destroy(); }
  }
  return { terminal: true };
}
