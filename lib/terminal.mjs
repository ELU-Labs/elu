import blessed from 'blessed';
import { ProjectController, dashboardSnapshot, claimView, VIEW_ONLY, registerProject, registeredProjects, archiveProject, taskDetails, taskPatch, conversationEntries, wroteIt, modelLabel, modelName, modelWaiting, reportedModels, sessionModel, knownProject, nameProject, savedProjectName, learnArchived } from './projects.mjs';
import { deleteSession, unpushedText, unpushedWork } from './session-delete.mjs';
import { pushesRunning, redact, stopPushes } from './publish.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { recordReply } from './waiting-replies.mjs';
import { projectPath, projectFolder, createFolderPlan, createFolder, pendingRequests, removeRequest, takeRequest, addToRequest, updateRequest, dropRequests, typedRequest, sendTypedNow, asksYes } from './workspace.mjs';
import { WHILE_WORKING, asideStatus, readWords, runsCommand, sentWords, waitingWords } from './message-aside.mjs';
import { git } from './git.mjs';
import { runShell, recordShell, shellText } from './shell.mjs';
import { readProjectSettings, saveInstructions } from './project-settings.mjs';
import { saveContextEdit } from './project-notes.mjs';
import { answerTrust, longNote, pendingTrust, reviewLines, unusedTrust } from './project-trust.mjs';
import { parseConfig } from './config.mjs';
import { updateNotice, UPDATE_IN_APP } from './update.mjs';
import { enqueue as queueRequest, sendCommand, startConductor as launchConductor, retryRequest, saveConductorSettings, conductorSettings, conductorTakesAuto, openingConductor, conductorNote } from './conductor.mjs';
import { picturesElsewhere, readablePictures } from './pictures.mjs';
import { columns as widthOf, cut as cutText, padEnd } from './width.mjs';
import { boardRows, barCells, barColumns, boardSections, rowActions, rowArtifacts, rowArtifactsNamed, rowCard, peerDecision, peerIncoming, SCHEDULE_MARK, scheduleMark } from './board.mjs';
import { SLOTS_RULE, SLOTS_RULE_UNSET, waitingText } from './waiting.mjs';
import { limitText } from './conductor-files.mjs';
import { COMMANDS, SCHEDULE_PRESETS, argumentMatches, commandMatches, mentionMatches, sessionMentions, commandWords, isCommand, needsArgument, parseCommand, typedCommand, vendorText } from './terminal-commands.mjs';
import { BOT_COLORS, listBots, getBot, needBot, chatBots, sessionBots, sessionTalker, sessionWorker, requestBots, botColor, botEfforts, botOfKey, botShadows, botWorks, botOversees, botShareable, everOversaw, pickBotColor, saveBot } from './bots.mjs';
import { matchModels, agentOwnEffort } from './bot-models.mjs';
import { modelChoices, findModel, choiceName, modelText, modelProblem, rememberModel, installedVendors, modelTag, entryTag, modelWords } from './models.mjs';
import { addAgent, agentWords } from './agents.mjs';
import { botLines, botNames, botMessage, botDialogs } from './terminal-bots.mjs';
import { agentDialogs, effortText } from './terminal-agent.mjs';
import { changeWords, effortOf, effortProblem, leadEffort, noteChange, sessionBot } from './agent-change.mjs';
import { PALETTE, displayText, ink, keyHints, visible, terminalLayout, relativeTime, remote, peerName, threadWho, clockTime, sentState, teamPanes, membersLine, teammateLine, roomTarget, dmTarget, botTarget, peerSummary, chatBlock, tagged, messageTime, widestTime, fitWords, wrapText, readableRows, stepLines, stepsLine, STEPS_LINE, silentLine, workingSteps } from './terminal-visuals.mjs';
import { runSteps, endedSteps, runsOfEntries, runSeconds } from './run-activity.mjs';
import { asWritten, codeBlock, copyReader, drawingOf, installTerminalStyles, keepCopies, keepDrawing, markdownRows, markdownText, plainText } from './markdown.mjs';
import { sanitize } from './peer/peerdata.mjs';
import { scanSecrets } from './peer/secrets.mjs';
import { approveTask, approvesTasks, rejectTask, saysYes, sessionTasks, taskEta } from './plan.mjs';
import { etaText, taskCard, taskLetBy, taskNeedsYou, taskPlace } from './terminal-plan.mjs';
import { answerCheck, checkView, goalToldWords, moveToDone, readGoal, sameGoal, taskView } from './owner-check.mjs';
import { toldChecklist } from './checklist.mjs';
import { jobsLine, sessionJobsNow } from './jobs.mjs';
import { eluLine, sentByElu } from './elu-sent.mjs';
import { KEEP_OFF, KEEP_ON, keepsGoing, readKeepGoing, setKeepGoing } from './keep-going.mjs';
import { COLUMNS, CHECK_IT, lastActivity, readBoard, addCard, editCard, removeCard, startCard, linkCards, setDone, boardColumns, fitCard, fitCheckCard, fitTeammateCard, closeSession, reopenSession, sessionDetail, endedAs } from './kanban.mjs';
import { boardSlice, folderRemote, projectBoards, sessionFolders } from './kanban-repos.mjs';
import { taskTitle, setTitle, nameProblem, TITLE_MAX, requestGoal, requestTitle, sessionGoal, teammateText, readTask, taskDir, tasks as savedTasks } from './state.mjs';
import { setPermissions as saveMode, allowHome } from './runner.mjs';
import { listSchedules, saveSchedule, changeSchedule, removeSchedule, pauseSchedule, runScheduleNow, runSchedule, runMode, runDue, runBots, parseWhen, splitWhen, nextRun, dateText, untilText, installScheduler, uninstallScheduler, FULL_SCHEDULE, NO_HERE } from './schedules.mjs';
import { runBotSchedules, botScheduleIn, botScheduleLines, setBotSchedule, runBotNow, schedulesOn, botChatSession, botSchedulesShown, botScheduleBrief } from './bot-schedules.mjs';
import { peerPolicy as savedPeerPolicy, computerName, nameComputer } from './peer/settings.mjs';
import { MODES, LABELS, BADGES, checkMode, checkPlace, checkFolders, foldersBelowFull, capMode, defaultMode, saveDefaultMode, isPeerRun, fromTeammate } from './modes.mjs';
import { VENDORS, VENDOR_NAMES, CAPS, DEVICE_SIGN_IN_COMMAND, vendorWithCommand } from './vendors.mjs';
import { computerDefault, passedOver, saveComputerDefault, setDefaultModel as saveProjectDefault, startModel } from './models.mjs';
import { AUTO_NAME, AUTO_WORD, LINES as AUTO_LINES, QUICK_WORDS, autoOn, autoSettings, autoWords, homeProblem, isAutoWord, quickVendor, routesLine, saveAutoSettings, setSessionAuto, vendorReady } from './auto-model.mjs';
import { startConfig } from './projects.mjs';
import { pendingApprovals, answerApproval } from './approvals.mjs';
import { liftedBy } from './never-list.mjs';
import { blockedRows as turnBlocked, ranIn, workRun } from './blocked.mjs';
import { entryLine, keepOffer, keepRule, listEntries, removeEntry, turnOnEntry, usesSavedRules } from './permission-rules.mjs';
import { conformanceState, vendorReading } from './conformance.mjs';
import { USAGE_NAMES, usageBlocks, usageDetailLines, usageRowIds, usageTotal } from './terminal-usage.mjs';
import { findBin, hash, HOME_AUTO_QUESTION, HOME_QUESTION, homeOrAbove, homeWork, isHomeFolder } from './util.mjs';
import { shellSandboxLine } from './sandbox.mjs';
import { changeRows, changeSummary, fileKey, noteKey, notesMessage, placeNotes, readNotes, saveNotes } from './changes.mjs';
import { artifactRows as artifactItems, artifactText, everyText, latestAt as artifactsLatest, markSeen as markArtifactsSeen, readStore as readArtifactStore, refreshDue as refreshArtifacts, storeFile as artifactFile, taskArtifacts, unseen as artifactsUnseen } from './artifacts.mjs';
import { artifactsView, chartPictures } from './terminal-artifacts.mjs';
import { overviewArtifacts, readOverview } from './session-overview.mjs';
import { attachPictures } from './terminal-pictures.mjs';
import { steadyWheel, frameRender } from './wheel.mjs';
import { usageTab, refreshUsage, usageStale, accountOf, accountsStamp, forgetAccount, recordAccount } from './usage.mjs';
import { moveText, moveUp, notePicked, readSwitch, restartsOnOther, setAuto, setExtraUsage, wakeNow, waitsForReset } from './claude-switch.mjs';
import { DEFAULT_LOGIN, DEVICE_SIGN_IN, LOGIN_ENV, LOGIN_VENDORS, SIGN_IN, finishLogin, hasBrowser, listLogins, newLogin, removeLogin, shareServersAll, useLogin } from './logins.mjs';
import { agentSpend, agentTable, topRows } from './agent-spend.mjs';
import { budgetMessage } from './budget.mjs';
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
import { HERE, NO_MINE_LINE, boxKeys, hereMention, remoteSessions } from './terminal-remote.mjs';
import { helperLink, helperTask, helperTick, helperTitle, linkHelper, ownerWrote, sendsTo } from './remote-helper.mjs';
import { budgetBlocks, stopLine, errorText } from './stop-line.mjs';
import { committedLine, finished, publishWords, published, pushStopNote, restingMove, stateText } from './task-head.mjs';
import { carryOnCapped } from './carry-on.mjs';
import { keepParts, keepRows } from './terminal-visuals.mjs';
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
// The Usage tab's lines are laid out in lib/terminal-usage.mjs.
export { usageBlocks, usageDetailLines, usageTotal };
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
  // A model's message shown again is kept again for a copy, with the lines its rows came from.
  if (found) { keepDrawing(found.value, found.drawing); return found.value; }
  // raw: a command and its output keep their asterisks and backticks. A message on no shade is
  // a model's, a bot's or an agent's, drawn as Markdown; yours (shaded) shows as before.
  const value = chatBlock({ title, narrow, time, text: raw || !shaded ? blockText(body) : blockText(body).replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/`([^`\n]+)`/g, '$1'), tone, shaded, width, colour, markdown: !raw && !shaded });
  const drawing = !raw && !shaded ? drawingOf(value) : null;
  if (kept) { kept.push({ text: body, value, drawing }); if (kept.length > 20) kept.shift(); } else blocks.set(key, [{ text: body, value, drawing }]);
  if (blocks.size > 500) blocks.delete(blocks.keys().next().value);
  return value;
}
// trusted: text from a trusted teammate shows as sent; control characters still go.
// A short value, such as an invite code, set apart in a frame so it reads as the thing to send.
// While a bot's turn runs and nothing is reported yet: the model and effort it runs on in this
// session (the owner's own for it here, lib/agent-change.mjs, else as it was saved), when it
// names them. A bot that runs on the session's model in place of that one (modelFallback)
// shows none.
function startedOn(task, role) {
  const name = botOfKey(role); if (!name) return null;
  let bot = null; try { bot = sessionBot(task, getBot(name)); } catch { return null; }
  if (!bot) return null;
  const fallback = task?.modelFallback && Object.hasOwn(task.modelFallback, name) && task.modelFallback[name] === (bot.model ?? null);
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
// The bot that oversees the sessions asks before it sends a note or an answer, starts a
// session, adds a card or writes a line of the Organization section (lib/orchestrator-actions.mjs).
// Its question holds the first 200 characters. whole is the exact text ELU writes, sends or
// starts the session with when he says yes, kept whole beside the question (lib/approvals.mjs),
// so he reads all of it first. Nothing of the input is read for it: that is what the bot
// called the tool with, and it may hold words ELU never sends. null for an approval with no
// whole, or when the question holds it all already.
const ORCH_ASKED = { session_message: 'The note', session_answer: 'The answer', session_start: 'The goal', card_add: 'The card', org_propose: 'The line' };
export function askedWhole(approval) {
  if (typeof approval?.whole !== 'string') return null;
  const tool = /^mcp__elu-code-approval__([a-z_]+)$/.exec(String(approval.tool ?? ''))?.[1] ?? '', whole = sanitize(approval.whole, 20000).trim();
  if (!whole || String(approval.summary ?? '').includes(whole.replace(/\s+/g, ' '))) return null;
  return { label: `${Object.hasOwn(ORCH_ASKED, tool) ? ORCH_ASKED[tool] : 'The text'} in full:`, text: whole };
}
// Whether what this role asks in this session can be given Full access: the owner's own
// session, for the model or a bot of its chat, its scheduled turns too. Never a teammate's
// question, a session from before modes, or another role, and never the bot that oversees
// the sessions, for which Full access lifts nothing: not a question it raised (asked, the
// approval, marked oversee), and not one of a bot that oversees. A bot that find (a saved bot by
// its name) no longer shows, renamed or removed since it asked, is that bot when a bot ever
// oversaw under its name (lib/bots.mjs everOversaw, which counts every name while the bots
// cannot be read); any other is a bot like before. With no way to look, or a look that fails, no.
const savedNotOverseeing = (find, name) => { if (typeof find !== 'function') return false; let bot = null; try { bot = find(name); } catch { return false; } return bot ? !botOversees(bot) : !everOversaw(name); };
export const fullAllowed = (task, role, find = null, asked = null) => Boolean(task) && !isPeerRun(task.origin) && MODES.includes(task.permissions) && !asked?.oversee && (!role || role === 'lead' || Boolean(botOfKey(role)) && savedNotOverseeing(find, botOfKey(role)));
// The mode the turn in progress started with: the session's before the first switch made
// since the turn began.
function turnMode(task) {
  const times = [task.activeSince, (task.messages ?? []).findLast(row => !row.from)?.at].map(value => Date.parse(value ?? '')).filter(Number.isFinite);
  const first = times.length ? (task.permissionChanges ?? []).find(row => Date.parse(row.at) > Math.max(...times)) : null;
  return first ? first.from : task.permissions ?? null;
}
// A peer's @name as their team gives it. Inside the app peerName also knows my own computers.
const memberName = peerName;
// What the line under the list says once the owner said yes (r) to what another computer on
// the shared project sent into a project that takes its work by hand (asksYes).
const YES_SAID = 'You said yes. It starts next.';
// The words under a message that waits in the chat, each one to click (drawUnsent).
const WAIT_ACTIONS = /^(?:Yes|Send again) · Dismiss(?: · Reply)?$/;
// A saved request as it was typed: one written to a bot starts with its @name again.
const typedGoal = row => row.bot ? `@${row.bot} ${row.goal}` : row.goal;
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

// What a dialog says its keys do, as "key does · key does": the pairs the key bar names under
// it. A part that names no key ("read-only") is left out; only: the keys it may name.
function hintPairs(text, only = null) {
  return String(text ?? '').split(' · ').map(part => /^(enter|esc|tab|↑↓|pgup pgdn|pgdn|ctrl-\S+|\S)\s+(\S.*)$/iu.exec(part.trim())).filter(found => found && (!only || only.includes(found[1].toLowerCase()))).map(([, key, does]) => [key.toLowerCase(), does]);
}
// Keys named in a line: "y or w", "1, 2, 3 or r".
const orList = keys => keys.length > 1 ? `${keys.slice(0, -1).join(', ')} or ${keys.at(-1)}` : keys.join('');
// What the check of a session that works says of it, where it would say how it ended.
const GOAL_AT_WORK = 'It is working. A new goal reaches it without stopping it.';

// Six tabs. Sessions lists every session across projects on the left and
// shows the selected one's chat on the right. + New session shows the same chat empty, with
// the project, its model and its bots above the box. Projects lists every project. Kanban holds the
// open project's tasks in four columns. Chats holds channels and direct messages, each with
// its threads. Bots lists the saved bots. Usage shows the vendor accounts and their plan usage.
// usage: where the Usage tab reads from ({ env, readFile, vendors }); tests pass a temp home
// and fixed vendor rows.
export async function launchTerminal({ repo, startDirectory = process.cwd(), input = process.stdin, output = process.stdout, refreshMs = 350, onRender, startConductor = launchConductor, peer, team: teamStart = false, askProject = false, clipboard = null, loginItem = { install: installScheduler, uninstall: uninstallScheduler }, usage = {}, updateCheck = updateNotice, pictures: picturesOn = !process.env.NODE_TEST_CONTEXT } = {}) {
  if (!input.isTTY || !output.isTTY) throw new Error('Open ELU in a terminal, or use --json for a snapshot.');
  // A terminal that only prints lines (TERM=dumb: an editor's output pane, a plain log) cannot draw the app.
  if (process.env.TERM === 'dumb') throw new Error('ELU cannot draw in this terminal: it is set to TERM=dumb.\nOpen ELU in a terminal window. If this is one, run:\n  TERM=xterm-256color elu');
  const facade = peer === undefined ? await loadPeer() : peer;
  // The app draws in colour also where NO_COLOR is set, which some computers set for every
  // command line. NO_COLOR is left in the environment, so what ELU starts (the vendors, gh,
  // git) gets what it got before. ELU_NO_COLOR=1 (any value but empty or 0) turns colour off.
  const colour = !process.env.ELU_NO_COLOR || process.env.ELU_NO_COLOR === '0';
  const shade = name => colour ? PALETTE[name] : 'default';
  const accent = shade('orange'), muted = shade('muted');
  const screen = blessed.screen({ input, output, terminal: process.env.TERM || 'xterm', smartCSR: true, fullUnicode: true, title: 'ELU', warnings: false, autoPadding: false, dockBorders: false, ignoreLocked: ['C-c', 'tab', 'S-tab', 'C-t'] });
  // Every pane shows a row that fits it as one row: the chat, the lists, the dialogs, the message box.
  keepRows(screen);
  // When the window changes size, blessed draws a frame before resize (below) gives the panes their
  // new size, and so does a selection as it clears. A pane's row then runs past the window's edge
  // onto the next, and a mark of no width that lands first there (a model's italics or link,
  // lib/markdown.mjs) goes on a cell past the edge, which ended the app. No frame is drawn until
  // resize has laid the panes out (or the next tick, should a resize come before it listens).
  let sizing = false;
  screen.program.prependListener('resize', () => { sizing = true; setImmediate(() => { sizing = false; }); });
  const render = screen.render;
  screen.render = function (...args) { return sizing ? undefined : render.apply(this, args); };
  // A model's Markdown shows italics and opens links where this terminal can (lib/markdown.mjs).
  // A test's screen draws neither.
  if (!process.env.NODE_TEST_CONTEXT) installTerminalStyles(screen);
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
  // A click on its Task opens the Task (below); autoFocus off keeps the focus where it was, since
  // the header is not a place to type or choose.
  const header = blessed.text({ parent: screen, top: 1, height: 1, tags: true, autoFocus: false, style: { fg: shade('text'), bg: shade('background') } });
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
  let kanbanBoards = [], kanbanPicked = null, kanbanName = '', kanbanShownNow = null, kanbanThere = null;
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
  // What the open session's Task asked to see (lib/artifacts.mjs), in the chat's place, as ELU
  // draws it from the data the session gave. Only the rows in view are drawn, as for its changes.
  const artifactsBox = box({ tags: true, wrap: false, hidden: true });
  // The schedule that runs the open session, in the chat's place: when it runs, its message and
  // the mode each run gets, each changed with Enter, and pause, run now and delete.
  const scheduleBox = box({ hidden: true });
  const scheduleList = pane(scheduleBox, { height: '100%-5' });
  const scheduleHint = blessed.text({ parent: scheduleBox, bottom: 1, left: 2, width: '100%-4', height: 2, tags: true, style: { fg: muted, bg: shade('panel') } });
  // The switch between them, on the top border of whichever shows: Chat   Changes 3   Schedule.
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
  // Reply under a message that waits for his yes: the message box answers whoever sent it
  // (replying), and the message does not run. waitButtons: what each message that waits in the
  // chat offers, in the order drawn; their words are clicked (WAIT_ACTIONS).
  let replying = null, waitButtons = [];
  let view = teamStart ? 'chats' : 'tasks';
  // Sessions: the row the cursor is on (NEW is + New session), the row the right side was
  // last shown for, and the open session's own row as of the last draw.
  const NEW = 'new'; let barKey = NEW, barAt = 0, openKey = null, ownSeen = null, wanted = null, opening = false, dash = null, sided = null;
  // What was typed on the cursor's row while its project was still opening: each key with where
  // it was pressed. It is dropped when the cursor leaves that row.
  const heldKeys = [];
  let shellRun = null, shellTyped = false, chatTarget = null, chatOpen = null, chatJump = null, heldEdit = null, boardLines = [], composeRows = [], teamRows = [[], []], projectRows = [], botRows = [], botJump = null, teamOn = false, peerData = { on: false }, lastPane = { chats: null, kanban: null };
  // The Usage tab: its lines (each names its vendor, and an account's its account), the data behind them, whether a check is running.
  let usageRows = [], usageIds = [], usageData = null, usageKey = null, usageBusy = false; const usageAbort = new AbortController(), usageChecks = new Map(), usageOpen = new Map();
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
  // What the model or a bot did in a turn (lib/run-activity.mjs): while the turn runs, its
  // newest step under its working line, the steps before folded into one line above it
  // (workingSteps); once it ended, one line above its reply that opens to them all. Ctrl-O
  // opens or folds every turn's; a click on a turn's line opens or folds that one (flipped).
  // A turn keeps its key, its log, from its first step to its end, so one opened while it
  // works stays open as it grows. stepKeys: the turns whose lines the chat shows, top to bottom.
  // Ctrl-O does what the line of the turn last clicked says, else the newest turn's line: it
  // folds every turn when that one is open, and opens every turn when it is folded.
  let stepsOpen = false, stepKeys = [], stepsClicked = null;
  // The headings of the agents' replies in the open chat, as drawn: a click on one opens that agent's page.
  let agentHeads = [];
  const stepsFlipped = new Set();
  // A session's runs that have steps to show: the model's and its bots', from the session's
  // own folder, a standup's answer turn left out as the chat leaves it out. A turn the owner
  // stopped is among them (task.stops, lib/runner.mjs). Each ended: a call it left running
  // was cut when it did.
  function stepRuns(repo, task) {
    const dir = taskDir(repo, task.id), time = run => Date.parse(run.at ?? '') || 0;
    return [...(task.runs ?? []), ...(task.stops ?? []).map(run => ({ ...run, stopped: true }))].filter(run => typeof run.logFile === 'string' && path.dirname(run.logFile) === dir && !run.standup && (run.role === 'lead' || botOfKey(run.role)))
      .sort((a, b) => time(a) - time(b))
      .map(run => ({ role: run.role, at: run.at, startedAt: run.startedAt ?? null, key: run.logFile, ...(run.stopped ? { stopped: true } : {}), ...(run.again ? { again: true, ...(run.resumed ? { resumed: true } : {}) } : {}), steps: endedSteps(runSteps(run.logFile, { cwd: task.worktree }), Date.parse(run.at ?? '')) }));
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
    if (key === null) {
      const said = stepKeys.includes(stepsClicked) ? stepsClicked : stepKeys.at(-1);
      stepsOpen = !(said === undefined ? stepsOpen : stepsOpen !== stepsFlipped.has(said)); stepsFlipped.clear(); stepsClicked = null;
    }
    else { if (stepsFlipped.has(key)) stepsFlipped.delete(key); else stepsFlipped.add(key); stepsClicked = key; }
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
  // A session's bots, the ones the owner put in it (sessionBots). A new session starts with
  // none, and so does one saved without a list.
  const botsOf = task => sessionBots(task);
  // Who a message with no @name goes to in a session (sessionTalker): the bot the owner last
  // wrote to there, while it is still in the session's chat, else null for the session's model.
  // A message of theirs that still waits counts as written. His approval, a new goal and a
  // message the elu command sent name nobody: after them a session he wrote to a working bot
  // (@lead) stays that bot's. @model writes to the model whoever came last, and it stays the model.
  // One a teammate's message started that he works on as his own counts as his; a teammate's question never.
  const TO_MODEL = /^@model(?=\s|$)/i;
  const savedBot = name => savedBots().find(bot => bot.name === name) ?? null;
  function addressedBot(task, rows) { return sessionTalker(task, { waiting: rows, find: savedBot }); }
  composeBots = [];
  // The new session's model, { vendor, model }: null is the project's default. botTyped is
  // the saved bot the message box's text is written to, so the label is drawn again when it changes.
  let composeModel = null, botTyped = null, personTyped = null, modelTyped = false, reported = { at: 0, root: null, rows: [] };
  // Auto model for the new session (lib/auto-model.mjs): ELU picks the model for each step, and
  // composeModel then only says which vendor's models it picks from. A new form starts with
  // what /model computer auto set for this computer.
  let composeAuto = autoSettings().default;
  // What Auto model reads from disk is asked on every draw and every key, so each answer is
  // kept for two seconds. A setting changed here drops them all (autoKept.clear()).
  const autoKept = new Map();
  const autoRead = (key, read) => {
    const kept = autoKept.get(key), at = Date.now();
    if (kept && at - kept.at < 2000) return kept.value;
    if (autoKept.size > 60) autoKept.clear();
    let value = null; try { value = read(); } catch { value = null; }
    autoKept.set(key, { at, value }); return value;
  };
  // Whether a session on this vendor can have Auto model now: the vendor has a top and a work
  // model, and the conductor here is of a build that knows it.
  const autoCan = vendor => autoRead(`can\0${vendor}`, () => !homeProblem(vendor) && conductorTakesAuto()) === true;
  // The form's: on, for a session that starts now (a schedule runs on one model), on a vendor that can have it.
  const formAuto = () => Boolean(controller) && composeAuto && !composeWhen && autoCan((composeModel ?? controller.defaultModel()).vendor);
  // What a new session starts with where no form is open yet: this computer's default.
  const autoStart = () => Boolean(controller) && autoRead('default', () => autoSettings().default) === true && autoCan(controller.defaultModel().vendor);
  // Whether the /model list has its first row: a vendor installed here can have Auto model.
  const autoOffered = () => autoRead('offered', () => installedVendors().some(vendor => !homeProblem(vendor))) === true;
  // "Auto model is on. Plans: Fable 5.2 xhigh · Edits: Opus 5.5 xhigh · Quick questions: Grok
  // Build", for a session of this vendor: the open one (task), whose working bot edits on its
  // own model, or the new one.
  const autoOnLine = (vendor, task = null) => AUTO_LINES.on(autoRead(`routes\0${vendor}\0${task?.id ?? ''}`, () => {
    let worker = null; if (task) { try { worker = sessionWorker(task, { waiting: pendingRequests(controller.repo.root), find: savedBot }); } catch { worker = null; } }
    return routesLine({ home: vendor, task, worker });
  }) ?? '');
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
  // The model a session's next turn starts on, named as its chat titles name it. turn: the
  // model of the turn that works now instead (lib/projects.mjs sessionModel).
  const modelOf = (task, { turn = false } = {}) => modelLabel(sessionModel(controller.repo, task, { turn }) ?? controller.defaultModel(), [...knownModels(), ...reportedModels([task])]);
  // The model that works in a session, which is the one a message typed now goes to: a model
  // chosen while its turn works starts with the next turn, and is named from then.
  // A quick answer of Auto model's (lib/runner.mjs runAutoAnswer) is named as its header names it.
  const workingModel = task => task.state === 'running' && typeof task.quickTurn?.name === 'string' && task.quickTurn.name ? plain(task.quickTurn.name) : modelOf(task, { turn: ['running', 'preparing'].includes(task.state) });
  // The model that wrote a session's last reply: the one its last turn was started on.
  // A quick answer of Auto model's that came after it is named as its header names it.
  const answeredBy = task => {
    const run = (task.runs ?? []).findLast(row => row.role === 'lead' && !row.standup), quick = (task.messages ?? []).findLast(row => row.update && typeof row.quick === 'string' && typeof row.from === 'string'), suffix = AUTO_LINES.quickFrom('');
    if (quick && quick.from.endsWith(suffix) && !(Date.parse(quick.at) < Date.parse(run?.at ?? 0))) return plain(quick.from.slice(0, -suffix.length));
    return run ? modelLabel({ vendor: run.vendor, model: run.asked ?? null }, [...knownModels(), ...reportedModels([task])]) : modelOf(task);
  };
  const drafts = new Map();
  const draftKey = () => controller ? `${controller.repo.root}\0${selectedId ?? 'new'}` : null;
  // In Sessions on a row that is no session (view tasks) the box is the new session's (showLine):
  // its draft is kept and given back there too, so it outlives a visit to another tab.
  const freshKey = () => controller ? `${controller.repo.root}\0new` : null;
  // Where the draft of the box as it is now is kept: none in a view that keeps no draft.
  const draftSlot = () => view === 'chat' ? draftKey() : view === 'tasks' ? freshKey() : null;
  function rememberDraft() { if (controller && ['chat', 'tasks'].includes(view) && !isCommand(ask.getValue())) drafts.set(view === 'chat' ? draftKey() : freshKey(), ask.getValue()); }
  function restoreDraft() { if (controller && ['chat', 'tasks'].includes(view)) ask.setValue(drafts.get(view === 'chat' ? draftKey() : freshKey()) ?? ''); }
  let resolveDone, rejectDone; const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const setMessage = value => { message = plain(value); draw(); };
  const chatWidth = () => Math.max(20, (typeof activity.width === 'number' ? activity.width : screen.width) - activity.iwidth - 1);
  // The chat is drawn on every tick. Its parts are given to the pane only when one of them
  // changed: setting the text again makes blessed wrap and colour every line of it again,
  // which with a long message open was the app's whole load while nothing happened. When one
  // changed, only that one is read again (keepParts).
  let chatParts = null, chatText = null;
  keepParts(activity);
  const setChat = parts => {
    if (chatParts && activity.content === chatText && parts.length === chatParts.length && parts.every((part, index) => part === chatParts[index])) return;
    chatParts = parts; activity.setParts(parts); chatText = activity.content;
  };
  // Drag selects and copies on release; a click in the message box moves its cursor.
  // Tests pass their own clipboard; without one a test copies nothing.
  const copyText = clipboard ?? (process.env.NODE_TEST_CONTEXT ? null : systemClipboard({ write: data => screen.program._write(data) }));
  const copied = text => setMessage(`Copied ${text.length.toLocaleString('en-US')} character${text.length === 1 ? '' : 's'}.`);
  // The bar drawn at the left of a message is not part of its text, so a copy leaves it out.
  // A model's Markdown copies as it was written: each row of the pane names the line of the
  // pane's text it shows, and that line, by its place in the message drawn there, the line of
  // the message it was drawn from. A list's row is its item (the Task); the Artifacts tab's,
  // the row of its artifacts it shows, less what is drawn around it.
  let sourced = null, readCopy = () => null;
  const source = (el, row) => {
    const list = Array.isArray(el?.ritems) && typeof el.select === 'function', tab = el === artifactsBox ? artifactsShown : null;
    const lines = list ? el.ritems : tab ? tab.rows : typeof el?.content === 'string' ? el.content : null;
    const at = list ? row : tab ? tab.top + row : el?._clines?.rtof?.[row];
    if (lines === null || at === undefined) return null;
    const key = list ? el.ritems.join('\n') : tab ? tab.rows : lines;
    if (sourced !== key) { sourced = key; readCopy = copyReader(typeof lines === 'string' ? lines.split('\n') : [...lines]); }
    return readCopy(at);
  };
  const mouseSelection = attachSelection(screen, { copy: copyText, onCopy: copied, clean: row => row.replace(/^\s*┃ ?/, ''), source });
  ask.selection = () => { const range = mouseSelection.range(); return range?.el === ask ? range : null; };
  // Shift and the arrows highlight in the box (lib/editor.mjs): the same highlight a drag makes.
  ask.highlight = (from, to, by) => { if (from) mouseSelection.select(ask, from, to, by); else mouseSelection.clear(); };
  // A paste goes into the box being typed in, whole; a single-line box takes it on one line.
  // Pasted where no box is typed in, as a file dropped on the terminal while the list or the
  // chat has the focus, it goes into the message box (pasteMessage): a paste is never a key.
  attachPaste(screen, text => {
    const field = screen.focused, value = pastedText(text); if (!value) return;
    if (!field?._reading) { pasteMessage(value); return; }
    field._listener(field.type === 'textbox' ? value.replace(/\n/g, ' ') : value, { name: 'paste', sequence: value });
  });
  // Last, so it feeds every reader of the input: each mouse report reaches them on its own.
  attachReports(screen);
  // An action knows itself while it runs (acting), so a change that waits for the owner's yes to
  // take the project can carry on once he said it (offerClose).
  const acting = new AsyncLocalStorage();
  const catchAction = fn => acting.run(fn, () => Promise.resolve().then(fn).catch(error => setMessage(error.message)));
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
  // A new goal given to a session at work (answerCheckWith): once its turn read it, the status
  // line says when (the chat's line of that goal, lib/runner.mjs toldGoal).
  let goalSent = null;
  function goalRead() {
    if (!goalSent || !controller || controller.repo.root !== goalSent.root) { goalSent = null; return; }
    const task = controller.snapshot().tasks.find(value => value.id === goalSent.id), told = (task?.messages ?? []).findLast(value => value.goalTold !== undefined && Date.parse(value.at) >= goalSent.since);
    if (told) message = plain(`${goalSent.name} read the new goal at ${messageTime(told.at)}.`);
    if (told || !task || !['running', 'preparing'].includes(task.state)) goalSent = null;
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
    if (typeof row?.goal === 'string') following.goal = row.goal;
    if (!row && !following.taskId) { following = null; return; }
    if (row?.taskId && selectedRequest?.id === row.id) { const was = ownKey(); selectedId = row.taskId; selectedRequest = null; if (entered && entered === was) entered = ownKey(); }
    if (!row || row.state === 'done') {
      const task = controller.snapshot().tasks.find(value => value.id === following.taskId);
      if (task && ['running', 'preparing'].includes(task.state)) {
        // Once that turn took it, the line says what the chat says under the message, as it changes: read, then answered (readWords).
        const taken = following.goal ? (task.messages ?? []).findLast(value => value.during && value.sentAt && !value.from && value.text === following.goal) : null, words = taken ? readWords(taken, messageTime) : null;
        if (words && following.read !== words) { following.read = words; message = plain(words); }
        return;
      }
      const asked = following.bot, away = following.away; following = null;
      const reply = asked ? (task?.messages ?? []).findLast(value => value.bot === asked) : null;
      if (task && view === 'chat') {
        const end = reply ? reply.failed ? `@${asked}: ${reply.text}` : `@${asked} answered` : task.state === 'answered' ? `${answeredBy(task)} answered` : task.state === 'ready' ? `ready to publish | ${publishWords(task)}` : task.state === 'needs_input' && !task.error ? 'Waiting for your answer' : stopLine(task)?.text ?? task.error?.message ?? stateText(task);
        // A picture the message named that is not on this computer is still said once the answer came.
        const said = String(end ?? '').replace(/[.\s]+$/, '');
        message = plain(!away ? end : / answered$/.test(said) ? `${said} without ${away}.` : `${said}. Sent without ${away}.`);
      }
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
  function resetForm() { composeWhen = null; composeMode = defaultMode(); composePicked = false; composeFullOk = false; composePlace = { kind: 'worktree' }; composeFolders = []; composeBots = []; composeModel = null; composeAuto = autoSettings().default; }
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
    if (opened && request && ['blocked', 'waiting'].includes(request.state) && !request.origin && !asksYes(request) && !ask.getValue()) { ask.setValue(typedGoal(request)); message = 'Saved request restored. Send to retry.'; }
  }
  // What the cursor's row shows on the right, without moving focus: the new session form, a
  // session, or the row's own text. The box under a row that is not a session starts a new
  // one, so it keeps the new session's draft.
  function showLine(line, session) {
    const typed = ask.getValue(), fresh = controller ? `${controller.repo.root}\0new` : null;
    if (view === 'tasks' && fresh && !isCommand(typed)) drafts.set(fresh, typed);
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
    boardLines = [{ add: true }, { spacer: true }, ...(rows.length ? boardSections(rows, now, { open: [barKey, openKey] }) : [{ note: dash.projects.length ? 'No sessions yet.' : 'No project yet.' }]), ...remoteApp.sections(now, controller?.repo.root, [barKey, openKey])];
    // The archive is out of the way, and one line says it is there. Archived sessions are each
    // computer's own: this line counts this computer's, and /archived on another lists its own.
    // A session the owner checked Done is in Done, not archived, and is not counted.
    const stored = dash.projects.reduce((count, project) => count + ((project.archived ?? project.closed)?.length ?? 0), 0);
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
    try { nextController = new ProjectController(location, { readOnly: nextClaim.readOnly, onRepository: value => { repo = value; nextClaim.attach(value); }, takeOver: () => takeProject(nextClaim, Date.now(), true, true), readOnlyText: () => viewOnlyLine(nextClaim.holder) }); nextSnapshot = nextController.snapshot(); }
    catch (error) { nextClaim.release(); throw error; }
    repo = location; claim = nextClaim; controller = nextController; snapshot = nextSnapshot; forgetVendors();
    selectedId = null; selectedRequest = null; message = claim.readOnly ? claim.holder?.window ? VIEW_TAKES : VIEW_ONLY : ''; takeoverAt = null;
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
  // pressed: a change the owner made (a key, a click or a message in the last few seconds; a
  // timer never takes the project). It takes the project at once (claim.takeNow): the other
  // window is asked to let go, and closed when it does not and runs nothing; one that runs
  // something is closed only when the owner says yes, and the change then carries on (not
  // /takeover, pressed 'takeover', which is done once it has the project). One press tries
  // once (triedNow), so a change that looks again waits for nothing more.
  let triedAt = 0, viewLooked = 0, takeoverAt = null, pressedAt = 0, triedNow = 0;
  function takeProject(asked = claim, now = Date.now(), sure = true, pressed = false) {
    if (asked !== claim || !controller || closing) return false;
    if (!claim.readOnly) return true;
    triedAt = now;
    const holder = claim.holder;
    let how = claim.retry?.({ sure, now }) ? claim.holderOpen ? 'let go' : 'gone' : false;
    if (!how && pressed && claim.takeNow && Date.now() - pressedAt < 10000 && pressedAt > triedNow) {
      triedNow = pressedAt;
      // It may wait seconds for that window: the line says so first (sayNow).
      how = claim.takeNow({ waiting: () => sayNow('Taking over from the other ELU window…') });
      if (!how && claim.busy?.length) offerClose(asked, holder, claim.busy, pressed === 'takeover' ? null : acting.getStore());
    }
    if (!how) return false;
    took(how, holder);
    return true;
  }
  // A line shown before ELU waits without drawing: blessed writes on the next tick, so it goes
  // to the terminal now.
  const sayNow = text => { setMessage(text); try { screen.program.flush(); } catch { /* Shown on the next draw. */ } };
  // The line that says the other window was closed stays a few seconds before what the change
  // then says, which would otherwise take its place at once (shownTook, on every draw).
  let tookLine = null;
  function took(how, holder) {
    controller.readOnly = false; takeoverAt = null; writer();
    // A window that let go when asked is still open; any other has closed.
    const line = how === 'closed' ? `Closed the other ELU window${holder?.startedAt ? ` (started ${messageTime(holder.startedAt)})` : ''} and took over.` : how === 'let go' ? 'This window can make changes now.' : 'The other ELU window has closed. This window can make changes now.';
    tookLine = how === 'closed' ? { text: line, until: Date.now() + 8000 } : null;
    setMessage(line);
  }
  function shownTook(now = Date.now()) {
    if (!tookLine) return;
    const { text, until } = tookLine;
    if (now >= until) { tookLine = null; if (message.startsWith(`${text} `)) message = message.slice(text.length + 1); return; }
    if (!message.startsWith(text)) message = message ? `${text} ${message}` : text;
  }
  // The other window runs something closing it would stop (running, from claim.busy): asked
  // once. On yes it is closed, and the change that asked (redo, the action it was part of)
  // carries on.
  let offered = null;
  const runningName = row => row.command ? `"${firstWords(row.command.replace(/^(?:\S*\/)?(?:ba|z|da|k|fi)?sh\s+(?:-\w+\s+)*-c\s+/, ''), 40)}"` : sessionName(row);
  function offerClose(asked, holder, running, redo) {
    if (offered === asked) return; offered = asked;
    catchAction(async () => {
      try {
        if (!await yesKey('Take over', `The other ELU window is running ${running.map(runningName).join(', ')}. Close it and take over?`, 'y yes · n no')) return;
        if (asked !== claim || !claim.readOnly || closing) return;
        sayNow('Closing the other ELU window…');
        if (!claim.closeHolder()) { setMessage('The other ELU window did not close. Close it to make changes here.'); return; }
        took('closed', holder);
        if (redo) catchAction(redo);
      } finally { offered = null; }
    });
  }
  // The window that has this project, and what to do, for a window that cannot change it: the
  // longest form the status row shows whole. The row has two lines beside the list and one
  // elsewhere, and a line broken at a word can end up to ten columns early. The row is drawn
  // again at another size or in another tab: refused keeps what to choose from.
  let refused = null;
  const TYPED_BACK = ' ↑ brings back what you typed.';
  const VIEW_TAKES = 'View only: another ELU window has this project. A change here takes it over.';
  function viewOnlyLine(holder) {
    const known = [holder?.pid ? `process ${holder.pid}` : '', holder?.startedAt ? `started ${messageTime(holder.startedAt)}` : '', holder?.terminal ? `in terminal ${holder.terminal}` : ''].filter(Boolean);
    const forms = [known.length ? `${VIEW_ONLY} That window is ${known.join(', ')}.` : '', holder?.terminal ? `View only: the ELU window in ${holder.terminal} has it. Close it, or /takeover here.` : '', VIEW_ONLY].filter(Boolean);
    refused = { forms, text: fitForm(forms) }; return refused.text;
  }
  const fitForm = forms => { const room = listed() ? status.width * 2 - 14 : status.width - 2; return forms.find(form => widthOf(form) <= room) ?? forms.at(-1); };
  // The message box of a view-only window says which window has the project, its terminal when
  // it has one, and what to do: the longest form that fits in max.
  // Where a change here takes the project from that window (claim.holder.window), it says so.
  function viewOnlyLabel(max) {
    const takes = claim.holder?.window, has = 'View only: another ELU window has it', where = claim.holder?.terminal ? `, in terminal ${claim.holder.terminal}` : '', what = takes ? ' · a change here takes it over' : ' · close it, or /takeover';
    const forms = [` ${has}${where}${what} `, ` ${has}${what} `, takes ? ' View only · a change here takes it over ' : ' View only: another window has it · /takeover ', ` ${has} `];
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
    sizing = false;
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
  const watched = () => [header, brand, pills, status, keysBar, ...tabs, newCard, kanbanPick, newBot, newProject, back, activity, changesBox, artifactsBox, scheduleBox, scheduleHint, sessionTabs, boardBox, compose, composeHint, ask, teamOff, ...teamBoxes, chatMembers, kanbanOff, ...kanbanBoxes, kanbanTeam, botsBox, projectsBox, usageBox];
  const frame = () => [screen.width, screen.height, screen.focused?.uid, ...watched().map(panel => `${stamp(panel)}\x01${panel._label?.content ?? ''}\x01${panel.style.fg}\x01${panel.style.bg}\x01${panel.style.bold}\x01${panel.style.underline}\x01${panel.style.inverse}\x01${panel.style.border?.fg}\x01${panel.hidden}\x01${panel.position.left}\x01${panel.position.top}\x01${panel.position.width}\x01${panel.position.height}`), ...[board, composeList, scheduleList, ...teamLists, ...kanbanLists, botsList, projectsList, usageList].map(list => `${list.ritems?.join('\n')}\x01${list.selected}\x01${list.style.selected.bg}\x01${list.style.selected.inverse}`), palette.hidden, palette.ritems?.join('\n'), palette.selected, activity.childBase, modal?.uid].join('\x00');
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
  const remoteApp = remoteSessions({ facade, peerRead, peerCommand: (command, options) => peerCommand(command, options), chatMessage, ink, colour, toneOfBot: name => toneOfBot(name), stepsShown, roots: () => registeredProjects().map(project => project.root) });
  const remoteHere = () => view === 'tasks' && listed() && boardLines[barAt]?.row?.kind === 'remote' ? boardLines[barAt].row : null;
  // What a session of someone else's computer on a shared project says to a key or command that would work in it.
  const seeOnlyLine = row => `It is ${row.owner}'s session: only ${row.owner} can work in it.`;
  // A session on another computer of mine: its agents (their models, efforts and bots) are
  // changed on the computer that runs it. Its model alone is changed from here, by /model.
  const agentsThere = row => row.seeOnly ? seeOnlyLine(row) : `This session's agents are changed on @${row.machine}. /model <name> changes its model from here.`;
  // Every @name the app shows for a peer: the name its person gave themselves on the team. A
  // person name two computers on my teams go by (one person's own computers, or this one's)
  // would read alike, so each of those goes by its computer name instead, wherever it is named.
  let alike = { at: -Infinity, boxes: new Map() };
  const alikeBox = key => {
    if (Date.now() - alike.at > 1000 || Date.now() < alike.at) {
      const boxes = new Map(), plain = value => remote(value, 40).replace(/[\s@]+/g, '').toLowerCase(), said = new Map();
      let members = [], me = null;
      try { const status = peerRead('peerStatus'); me = status?.key ?? null; members = (status?.teams ?? []).flatMap(team => team?.members ?? []).filter(member => typeof member?.key === 'string'); } catch { members = []; }
      for (const member of members) {
        const person = plain(member.name), box = remote(member.box, 40).replace(/[\s@]+/g, '');
        if (box && person && members.some(other => other.key !== member.key && plain(other.name) === person)) boxes.set(member.key, box);
        if (!said.has(member.key)) said.set(member.key, { person: remote(member.name, 40).replace(/[\s@]+/g, ''), box });
      }
      alike = { at: Date.now(), boxes, said, me };
    }
    return alike.boxes.get(key) ?? null;
  };
  const peerName = (name, key) => { const box = typeof key === 'string' ? alikeBox(key) : null; return box ? `@${box}` : memberName(name, key); };
  // Who typed a message another computer on the shared project sent into a session here (its
  // key, computer): that computer's person, on that computer, by its name (who did what, by
  // computer). One typed here, or one this computer sent, reads You (null).
  const computerWho = key => {
    if (typeof key !== 'string') return null;
    alikeBox(key);
    if (!alike.me || key === alike.me) return null;
    const there = alike.said?.get(key);
    return `${there?.person || 'Someone'} on @${there?.box || key.slice(0, 8)}`;
  };
  const sentFrom = entry => entry.lead || entry.bot || entry.shell || !/^You(?: |$)/.test(entry.role ?? '') ? null : computerWho(entry.computer);
  // Who wrote a waiting request: you, the teammate whose message it is, or the person of the
  // computer on the shared project that sent it (computer, its key).
  // A request the bot that oversees the sessions queued carries its name (overseer): it is the bot's, never his.
  const requester = row => typeof row.overseer === 'string' ? `@${row.overseer}` : row.origin ? peerName(row.origin.name, row.origin.peer) : computerWho(row.computer) ?? 'You';
  // A session a schedule's run started: by the schedule it names, or, for one an earlier version
  // started, by the schedule's last run, as my other computers are told (lib/peer/remote.mjs, by: 'schedule').
  const scheduleRun = (root, task) => !task.origin && !task.botChat && (typeof task.scheduleId === 'string' || listSchedules().some(row => row.root === root && String(row.lastTaskId) === String(task.id)));
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
    if (task?.permissions === 'full' && task.state === 'running' && ['ask', 'auto'].includes(started)) for (const row of rows) { if (!fullAllowed(task, row.role, savedBot, row)) continue; try { if (answerApproval(row.id, 'allow')) count++; } catch { /* It stays for the owner to answer. */ } }
    return count;
  };
  // The last turn that did a session's work (lib/blocked.mjs): its model's, or a working bot's,
  // as @lead's in a session written to it.
  const lastWork = task => workRun(task, name => savedBot(name)?.works === true);
  // The Blocked lines of a session's last working turn (lib/blocked.mjs), with whether this
  // session may have Full access as this window decides it.
  const blockedRows = (task, lastLead = lastWork(task), { all = false } = {}) => turnBlocked(task, lastLead, { all, full: fullAllowed(task, 'lead') });
  // Giving a session a mode other than the one its last turn ran in, where that turn stopped
  // on something the new mode lifts, continues it at once. Returns those refusals, or null.
  // A turn that also stopped on the owner's own no, or on the never list, waits for him.
  function lifting(task, mode) {
    const lastLead = lastWork(task);
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
    // A session that works with a bot (sessionWorker) carries on with that bot.
    let worker = null; if (lifted) { try { worker = sessionWorker(task, { waiting: pendingRequests(root), find: savedBot }); } catch { worker = null; } }
    // ELU wrote the continuation, so it picks no step of Auto model (byElu): the model that stopped goes on.
    if (lifted) { enqueue(root, CONTINUE(mode, lifted), { continuationTaskId: String(task.id), priority: 0, byElu: true, ...(worker ? { bot: worker } : {}) }); conduct(); return `${LABELS[mode]}. Continuing where it stopped.`; }
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
      const waiting = pendingNow().filter(row => String(row.taskId) === String(task.id) && (!row.root || row.root === root) && fullAllowed(task, row.role, savedBot, row)), allowed = allowForFull({ ...task, permissions: mode }, waiting, was);
      return `${allowed ? 'Allowed. ' : ''}Full access: this session no longer asks you.`;
    }
    return `${LABELS[mode]} from the next message; this turn ${now === 'ask' ? 'still asks' : `keeps ${LABELS[now]}`}.`;
  }
  // f beside y and n: allow what waits and give its session Full access, as /permissions
  // full does and after the same question. Offered only where Full access can be given and
  // is not the session's mode already; elsewhere the keys stay y and n.
  const offersFull = (task, approval) => Boolean(approval) && task?.permissions !== 'full' && fullAllowed(task, approval.role, savedBot, approval);
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
    const self = remoteApp.self(), row = member => mine.has(member?.key) ? { ...member, name: mine.get(member.key).name, mine: true, waiting: mine.get(member.key).waiting, ...(mine.get(member.key).waiting ? { self } : {}), ...(mine.get(member.key).older ? { older: true } : {}) } : asking.has(member?.key) ? { ...member, name: asking.get(member.key).name, asks: asking.get(member.key).name } : member;
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
  // A chart on the Artifacts tab is a picture where this terminal shows pictures. ELU asks it
  // now, once (lib/terminal-pictures.mjs), and draws again once it has answered or its cells
  // have another size. A test's screen asks nothing unless the test says so.
  const pictures = picturesOn ? attachPictures(screen, { ...(typeof picturesOn === 'object' ? picturesOn : {}), onChange: () => { lastFrame = null; scheduleDraw(); } }) : null;
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
  // Its Schedule tab, while it shows, also for a schedule with no run in the list.
  const sessionPane = () => !scheduleBox.hidden ? scheduleList : !artifactsBox.hidden ? artifactsBox : changesBox.hidden ? activity : changesBox;
  const viewPanes = () => listed() ? view === 'chat' ? [board, composing() ? composeList : sessionPane()] : remoteHere() || !scheduleBox.hidden ? [board, sessionPane()] : [board]
    : view === 'kanban' ? controller || sharedNow() || thereNow() ? kanbanLists : []
    : view === 'chats' ? teamOn ? teamLists : []
    : view === 'bots' ? [botsList]
    : view === 'projects' ? [projectsList]
    : view === 'usage' ? [usageList]
    : composing() ? [composeList] : [sessionPane()];
  // A window that is view only (another ELU window has the project) changes nothing on its board, so it offers none of that.
  // A window whose changes are refused. One where a change takes the project from another ELU
  // window (claim.holder.window) offers every key, as the window that has it does.
  const viewOnly = () => Boolean(controller) && claim.readOnly && !claim.holder?.window;
  const subButtons = () => view === 'kanban' ? sharedNow() ? [back] : [...(viewOnly() && !thereNow() ? [] : [newCard]), ...((controller ? kanbanBoards.length : 0) + thereBoards().length > 1 ? [kanbanPick] : [])] : view === 'bots' ? [newBot] : view === 'projects' ? [newProject] : listed() || ['chats', 'usage'].includes(view) ? [] : [back];
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
  // Ctrl+T opens the Task of the session the header names (showTask). The bar of the session's
  // message box names it after Enter's and the page keys, so a narrow bar keeps those, and its
  // chat's bar where there is room. The list's bar and its Changes' bar name it last.
  const taskKeys = () => sessionShown() ? [['ctrl+t', TASK_WORD]] : [];
  const lettered = pairs => [...pairs, [...pairs, LETTER].map(pair => pair.join(' ')).join('  ').length <= screen.width - 2 ? LETTER : LETTER_SHORT, ['tab', 'next'], ...taskKeys()];
  const KEY_ACTIONS = { a: 'answer', s: 'stop', x: 'stop', r: 'retry', d: 'diff', c: 'close', e: 'rename', u: 'unarchive', p: 'publish', y: 'accept', f: 'full', w: 'work', n: 'decline', t: 'schedule', v: 'artifacts', '+': 'new' };
  const KEY_DOES = { 'clean up': 'asks to delete it for good', 'clean up all': 'asks to delete them for good', archive: 'archives this session', rename: 'renames this session', changes: 'shows its changes', artifacts: 'shows its artifacts', schedule: 'shows its schedule', 'new session': 'starts a new session', stop: 'stops this session', remove: 'removes it', retry: 'tries again', yes: 'says yes', unarchive: 'brings this session back', publish: 'publishes it', answer: 'answers it', 'follow up': 'writes a follow up', allow: 'allows it', deny: 'denies it', 'full access': 'allows it with Full access', always: 'always allows this', approve: 'approves the Task', reject: 'rejects the Task', 'run now': 'runs it now', pause: 'pauses it', resume: 'resumes it', delete: 'deletes it', accept: 'accepts it', decline: 'declines it', send: 'sends it', discard: 'discards it', cancel: 'cancels it', dismiss: 'dismisses it' };
  // typedFrom: the list or the chat the typing began in, or null when it began in the box.
  // typedBase: the draft the box held then. One character typed over it is still a row's key,
  // and the draft stays in the box when the key acts.
  let typedFrom = null, typedBase = '';
  // aside: a draft a command typed outside the box was set apart from (typeFrom): its text,
  // the view and the draft it was in (key), and where it is kept away from the box (keep).
  let aside = null;
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
      // t shows the schedule that runs it, as it does on a row.
      if (task && text === 't' && shownSchedule(task)) return { does: KEY_DOES.schedule, run: () => showSchedule({ focus: true }) };
      // v shows its artifacts, as it does on a row.
      if (task && text === 'v' && shownArtifacts(task)) return { does: KEY_DOES.artifacts, run: () => showArtifacts({ focus: true }) };
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
    if (named) return { action: /^clean up/.test(named[1]) ? 'clean' : KEY_ACTIONS[text], does: KEY_DOES[named[1]] ?? `does “${named[1]}”` };
    if (text === '+') return { action: 'new', does: KEY_DOES['new session'] };
    if (text === 'x' && rowActions(row).some(([key]) => key === 's')) return { action: 'stop', does: KEY_DOES[rowActions(row).find(([key]) => key === 's')[1]] ?? 'stops it' };
    // A row that waits on an answer keeps f and a as its keys even where they are not offered: they say why.
    const waits = row && (rowApproval(row) || taskWaits(row) || row.kind === 'approval');
    if (waits && ['f', 'a'].includes(text)) return { action: KEY_ACTIONS[text], does: text === 'f' ? KEY_DOES['full access'] : KEY_DOES.always };
    // d shows what a session that waits on an answer changed, to read before the answer is given.
    if (waits && text === 'd' && row.kind === 'task') return { action: 'diff', does: KEY_DOES.changes };
    // v shows the Artifacts tab of a session whose Task has no artifact yet too, where its row does not name it.
    if (text === 'v' && row && rowArtifacts(row)) return { action: 'artifacts', does: KEY_DOES.artifacts };
    return null;
  }
  // A character typed alone on the row of a session, here or on another computer of mine, that
  // is no key of that row: Enter does not send it, and the line under the box says so and names
  // the row's keys. More typed after it makes a message. / and ! start a command as anywhere.
  function strayKey(value = ask.getValue()) {
    if (typedFrom !== board || typedBase || typeof value !== 'string' || value.length !== 1 || /[\s/!]/.test(value) || !listed() || !selectedBoardRow()) return null;
    return rowKey(value) ? null : value;
  }
  // Whether d, then Enter, typed in the chat beside the list shows the session's changes: its
  // row names d (a session here or on another computer), or it was opened from Kanban.
  function paneShowsChanges() {
    if (!sessionShown()) return false;
    if (!listed()) return view === 'chat' && !selectedRequest;
    const row = selectedBoardRow();
    return Boolean(row) && (rowActions(row).some(([key]) => key === 'd') || row.kind === 'task' && Boolean(rowApproval(row) || taskWaits(row)));
  }
  // Whether v, then Enter, typed in the chat shows the session's artifacts: its Task has some.
  function paneShowsArtifacts() {
    if (!sessionShown()) return false;
    if (!listed()) return view === 'chat' && !selectedRequest && Boolean(shownArtifacts(openSession()));
    return rowActions(selectedBoardRow()).some(([key]) => key === 'v');
  }
  // The key bar names what each key does for whatever has focus right now.
  function keyPairs(focused = screen.focused) {
    if (tabs.includes(focused)) return [['←→', 'switch'], ['enter', 'open'], ['↓', listed() ? 'sessions' : view === 'kanban' ? sharedNow() ? 'back to Projects' : viewOnly() ? 'board' : 'new task' : view === 'chats' ? 'chats' : view === 'bots' ? 'new bot' : view === 'projects' ? 'new project' : view === 'usage' ? 'usage' : 'back']];
    if (focused === newCard) return [['enter', 'new task'], ['↓', 'board'], ['↑', 'tabs']];
    if (focused === kanbanPick) return [['enter', 'choose a board'], ['↓', 'board'], ['↑', 'tabs']];
    if (focused === newBot) return [['enter', 'new bot'], ['↓', 'bots'], ['↑', 'tabs']];
    // An empty list has nothing for Enter to open, or for x to remove.
    if (focused === botsList) return botRows.length ? [['enter', 'open'], ['n', 'new bot'], ['x', 'remove'], ['tab', 'next']] : [['n', 'new bot'], ['tab', 'next']];
    if (focused === newProject) return [['enter', 'new project'], ['↓', 'projects'], ['↑', 'tabs']];
    if (focused === projectsList && !projectRows.length) return [['n', 'new project'], ['tab', 'next']];
    if (focused === projectsList && projectRows[projectsList.selected ?? 0]?.remote) return [['enter', 'sessions'], ['n', 'new project'], ['tab', 'next']];
    if (focused === projectsList && projectRows[projectsList.selected ?? 0]?.team) return [['enter', 'open'], ['n', 'new project'], ['tab', 'next']];
    if (focused === projectsList && projectRows[projectsList.selected ?? 0]?.shared) return [['enter', projectRows[projectsList.selected ?? 0].sharers[0].mine ? 'open' : 'team board'], ['c', 'bring here'], ['n', 'new project'], ['tab', 'next']];
    if (focused === projectsList) return [['enter', 'settings'], ['o', 'make active'], ['n', 'new project'], ['x', joinedInBar(projectRows[projectsList.selected ?? 0]?.root).length ? 'leave' : 'archive'], ['tab', 'next']];
    if (focused === usageList) {
      const vendorRow = usageData?.find(row => row.vendor === usageRows[usageList.selected ?? 0]?.vendor);
      // Antigravity CLI and Grok Build: s signs them in here, signed in or not (another account, a lapsed sign-in).
      const signIn = vendorRow?.signsInHere && vendorRow.installed ? [['s', 'sign in']] : [];
      return usageRows[usageList.selected ?? 0]?.agent ? [['enter', 'open'], ['r', 'refresh'], ['t', usagePeriod === 1 ? '7 days' : 'today'], ['↑↓', 'scroll'], ['tab', 'next']]
      // A line of no vendor, such as the one that says the vendors are being read, has nothing for Enter, a or x.
      : usageRows[usageList.selected ?? 0]?.none || !vendorRow ? [['r', 'refresh'], ['t', usagePeriod === 1 ? '7 days' : 'today'], ['tab', 'next']]
      // Enter uses the account of an account's lines; on the vendor's other lines it opens its details, as d does.
      : ['needed', 'failed'].includes(vendorRow.check) || vendorRow.asks ? [['enter', 'details'], ['c', vendorRow.asks ? 'ask again' : 'run check'], ...signIn, ['r', 'refresh'], ['t', usagePeriod === 1 ? '7 days' : 'today'], ['tab', 'next']]
      : signIn.length ? [['enter', 'details'], ...signIn, ['r', 'refresh'], ['t', usagePeriod === 1 ? '7 days' : 'today'], ['tab', 'next']]
      // A setting of Claude's accounts: Enter turns it on or off.
      : usageRows[usageList.selected ?? 0]?.setting ? [['enter', vendorRow.switches?.[usageRows[usageList.selected ?? 0].setting] ? 'turn off' : 'turn on'], ['r', 'refresh'], ['t', usagePeriod === 1 ? '7 days' : 'today'], ['tab', 'next']]
      // u, with two or more Claude accounts, takes the room of d where the bar has too little for both (d still opens the details).
      // f, on an account with several limits, folds them to its tightest or unfolds them; where the bar is still too narrow, a says less.
      : usageRows[usageList.selected ?? 0]?.login ? (line => [[true, 'add account'], [false, 'add account'], ...(line.flips ? [[false, 'add']] : [])].map(([details, add]) => [['enter', 'use'], ...(line.flips ? [['f', line.open ? 'fold' : 'unfold']] : []), ...(vendorRow.switches ? [['u', 'move up']] : []), ['a', add], ['x', 'forget'], ...(details ? [['d', 'details']] : []), ['r', 'refresh'], ['t', usagePeriod === 1 ? '7 days' : 'today'], ['tab', 'next']]))(usageRows[usageList.selected ?? 0]).reduce((chosen, pairs, at, bars) => chosen ?? (at === bars.length - 1 || widthOf(pairs.map(pair => pair.join(' ')).join('  ')) <= screen.width - 2 ? pairs : null), null)
      : [['enter', 'details'], ['a', 'add account'], ['x', 'forget'], ['r', 'refresh'], ['t', usagePeriod === 1 ? '7 days' : 'today'], ['tab', 'next']];
    }
    // A card whose session is gone opens nothing: the bar leaves its Enter out (idleEnter).
    // What ⇧→ does under Needs you (kanbanAction, thereAction): it checks a session that waits
    // for the owner's check, and one that asks him something (its check is not refused: Done, or
    // a new message), and moves a card whose session is gone straight to Done. On a Task to
    // approve and on a message not started it is refused, and the Kanban has no key that approves
    // a Task: the bar names no ⇧→ there. A card of my other computer's board waits for the check
    // when it says so (CHECK_IT), and asks him something when its state says so.
    const needsForward = item => item.plan?.state !== 'proposed' && (item.check || item.task?.state === 'needs_input' || item.wire && item.task && String(item.detail ?? '').split(' · ').includes(CHECK_IT)) ? [['⇧→', 'check']] : !item.task && item.card ? [['⇧→', 'done']] : [];
    if (kanbanLists.includes(focused)) {
      const index = kanbanLists.indexOf(focused), item = kanbanData[index]?.items[focused.selected ?? 0], column = kanbanData[index]?.column;
      if (viewOnly() && !sharedNow() && !thereNow()) return [...(item?.teammate ? [['enter', 'read']] : item && (column !== 'todo' || !item.card) ? [['enter', 'open']] : []), ['←→', 'columns']];
      const first = !item ? [] : item.teammate ? [['enter', 'read'], ...(ownCheck(item) ? [['⇧→', 'check']] : [])] : column === 'todo' ? [['⇧→', 'start'], ['enter', 'edit'], ['x', 'delete']] : column === 'needs' ? [['enter', 'open'], ...needsForward(item)] : column === 'done' ? [['enter', 'open'], ['⇧←', 'reopen']] : [['enter', 'open']];
      return [...first, ['←→', 'columns'], sharedNow() ? ['n', `write to ${sharedWho(sharedNow())}`] : ['n', 'new task']];
    }
    if (focused === back) return view === 'kanban' ? [['enter', 'back to Projects'], ['↓', 'board']] : [['enter', 'back to Kanban'], ['↓', 'chat']];
    // The row of a session that waits on an approval of an action names d too: its changes are read before the answer.
    if (focused === board && rowApproval(selectedBoardRow())) return lettered([['y', 'allow'], ['n', 'deny'], ...(offersFull(selectedBoardRow().task, rowApproval(selectedBoardRow())) ? [['f', 'full access']] : []), ...(offersAlways(selectedBoardRow().task, rowApproval(selectedBoardRow())) ? [['a', 'always']] : []), ['d', 'changes'], ['enter', 'open']]);
    if (focused === board && selectedBoardRow()?.kind === 'approval' && offersAlways(approvalSession(selectedBoardRow().approval), selectedBoardRow().approval)) return lettered([['y', 'allow'], ['n', 'deny'], ...(offersFull(approvalSession(selectedBoardRow().approval), selectedBoardRow().approval) ? [['f', 'full access']] : []), ['a', 'always'], ['enter', 'open']]);
    if (focused === board && selectedBoardRow()?.kind === 'approval' && offersFull(approvalSession(selectedBoardRow().approval), selectedBoardRow().approval)) return lettered([['y', 'allow'], ['n', 'deny'], ['f', 'full access'], ['enter', 'open']]);
    // The row of a session whose Task waits names d too: its changes are read before the Task is approved.
    if (focused === board && taskWaits(selectedBoardRow())) return lettered([['y', 'approve'], ['n', 'reject'], ['d', 'changes'], ...(rowArtifactsNamed(selectedBoardRow()) ? [['v', 'artifacts']] : []), ['enter', 'open']]);
    // A session on another computer of mine that waits for y or n: n answers it, so it is not also new session.
    if (focused === board && selectedBoardRow()?.kind === 'remote' && (selectedBoardRow().approval || selectedBoardRow().label === 'TASK')) return lettered(rowActions(selectedBoardRow()));
    // Where n declines, denies or dismisses the row, it is not also new session there; + still starts one.
    if (focused === board) return selectedBoardRow() ? lettered([...rowActions(selectedBoardRow()).slice(0, 5), ...(rowActions(selectedBoardRow()).some(([key]) => key === 'n') ? [] : [['n', 'new session']])]) : [['enter', 'new session'], ['↑↓', 'choose'], ['tab', 'next']];
    if (focused === composeList) {
      const row = composeRows[composeList.selected ?? 0];
      // With no bot saved, the Bots row has none to add.
      return [...row?.type === 'project' ? [['enter', 'change project']] : row?.type === 'when' ? [['enter', 'schedule'], ...(composeWhen ? [['x', 'send now instead']] : [])] : ['permissions', 'place', 'model'].includes(row?.type) ? [['enter', 'change']] : row?.type === 'folders' ? [['enter', 'add'], ...(composeFolders.length ? [['x', 'clear']] : [])] : [...(savedBots().length ? [['enter', 'add or remove']] : []), ...(composeBots.length ? [['x', 'clear']] : [])], ['↓', 'write the message'], ['esc', 'sessions']];
    }
    if (focused === teamLists[0]) {
      const row = teamRows[0][focused.selected ?? 0]?.value;
      // No team listed yet: nothing is chosen for Enter to open.
      if (!row) return [['/', 'commands'], ['tab', 'threads']];
      // A teammate's live session shows what it works on and what overlaps with yours: Enter opens that.
      if (row.type === 'agent') return [['enter', 'details'], ['t', 'trust'], ['h', 'hold replies'], ['o', 'auto-continue'], ['tab', 'threads'], ['n', 'new channel']];
      if (row?.type === 'add') return [['enter', row.what === 'channel' ? 'new channel' : 'invite a teammate'], ['↑↓', 'choose']];
      if (row?.type === 'room') return [['enter', 'write'], ['n', 'new channel'], ...(row.channel ? [['m', 'members'], ['x', 'leave']] : []), ['tab', 'threads']];
      if (row?.type === 'bot') return [['enter', 'write'], ['n', 'new channel'], ['tab', 'threads']];
      // A computer that says it is mine: Enter asks whether to agree, or to write to it. h and o work there as on any member's row.
      if (row?.type === 'member' && row.member?.asks) return [['enter', 'agree or write'], ['t', 'trust'], ['h', 'hold replies'], ['o', 'auto-continue'], ['tab', 'threads'], ['n', 'new channel']];
      return [['enter', 'write'], ['t', 'trust'], ['h', 'hold replies'], ['o', 'auto-continue'], ['tab', 'threads'], ['n', 'new channel']];
    }
    // e is offered on a reply or a result that waits for the owner: it opens its text in the message box.
    // c is not offered on a thread whose answer or result the session already went on with.
    // Where no thread is listed there is nothing to read or answer.
    if (focused === teamLists[1]) {
      const row = teamRows[1][focused.selected ?? 0]?.value, room = chatOpen?.type === 'room' && chatOpen.channel ? [['m', 'members'], ['x', 'leave']] : [];
      if (!row) return [...room, ['tab', 'next']];
      return [['y', 'accept/send'], ...(row.kind === 'held' ? [['e', 'edit']] : []), ['n', 'decline'], ...(row.kind === 'answer' && row.continued === true ? [] : [['c', 'continue']]), ['enter', 'read'], ...room];
    }
    // A choice that needs more words (a command that takes one, a bot's name) is filled in by Enter, as by Tab: it runs nothing yet.
    if (focused === ask && !palette.hidden) return paletteFills() ? [['↑↓', 'choose'], ['tab enter', 'complete'], ['esc', 'close']] : [['↑↓', 'choose'], ['tab', 'complete'], ['enter', 'run'], ['esc', 'close']];
    if (focused === ask) {
      // A row's key alone in the box: Enter does it, and the line under the box says so.
      const lone = rowKey();
      if (lone) return [['enter', `${lone.does} · keep typing to write a message`]];
      const stray = strayKey();
      if (stray) return [[stray, 'is no key on this row'], ...keyPairs(board).filter(([key]) => !['enter', '↑↓', 'tab', 'letter'].includes(key))];
      // A command and a space, with no choices listed for what comes next: its usage and what it does.
      if (view === 'chats' && heldEdit) return [['enter', `send the edited ${heldEdit.result ? 'result' : 'reply'}`], ['esc', 'leave it held']];
      const typed = typedCommand(ask.getValue());
      // /send over someone else's session says at once that it is theirs, as /send itself does.
      const theirs = typed?.name === 'send' ? remoteHere() : null;
      if (typed) return [[typed.usage, `· ${theirs?.seeOnly ? seeOnlyLine(theirs) : typed.description}`]];
      if (view === 'chats') return [['enter', 'send'], ['@name', 'one member'], ['/', 'commands'], ['!', 'run a shell command']];
      // Only what is not obvious: what Enter does, the command list, choosing the model, and running a shell command.
      const more = [['/', 'commands'], ['/model', 'choose the model'], ['!', 'run a shell command']];
      // More chat, or more of what it changed, than its pane shows: PgUp and PgDn page it from here too.
      const page = (!artifactsBox.hidden ? (artifactsShown?.rows.length ?? 0) > artifactsShown?.high : changesBox.hidden ? !activity.hidden && (activity._clines?.length ?? 0) > activity.height - activity.iheight : (changesShown?.rows.length ?? 0) > changesShown?.high) ? [['pgup pgdn', 'page']] : [];
      // With a saved bot, @name is worth knowing too; on a team it also asks a teammate (another computer of mine is not one).
      const mates = (peerData.status?.teams ?? []).some(team => (team?.members ?? []).some(member => member?.key && member.key !== peerData.status.key && !remoteApp.own(member.key)));
      if (savedBots().length || mates) more.unshift(['@name', !mates ? 'ask a bot' : savedBots().length ? 'ask a bot or a teammate' : 'ask a teammate']);
      // Beside the list, Esc is the way back to it. It comes last, so it shows where there is room.
      if (listed()) more.push(['esc', 'sessions']);
      // Over a session on another computer, Enter writes to that session; @here first asks your agent here.
      if (remoteHere() && !ask.getValue().trim() && remoteHere().remote?.held > 0 && ['running', 'preparing'].includes(remoteHere().remote.state)) return [['enter', `send it now on @${remoteHere().machine}`], ['esc', 'sessions']];
      // Ctrl+T comes before Esc. Where the bar has no room for it after the page keys, @here's
      // hint is said in fewer words first, so the key for the Task in the header still shows.
      if (remoteHere()) {
        const pairs = boxKeys(remoteHere(), remoteApp.route(remoteHere(), ask.getValue()).to, page), bar = list => [...list.slice(0, -1), ...taskKeys(), list.at(-1)];
        // An Enter the bar leaves out (idleEnter, barPairs) takes no room.
        const idle = idleEnter(focused), fits = list => widthOf(list.slice(0, -1).filter(([key]) => key !== 'enter' || !idle).map(pair => pair.join(' ')).join('  ')) <= screen.width - 2;
        return [pairs, pairs.map(([key, label]) => key === HERE ? [key, 'your agent here'] : [key, label])].map(bar).find(fits) ?? bar(pairs);
      }
      // A view-only window sends nothing new from its box: the bar names what it does take.
      // A message a turn holds back was sent already, and Enter still sends it now (below).
      if (viewOnly() && view !== 'kanban' && (sessionBox() || ask.getValue().trim() || !heldBack().length)) return [['/', 'commands'], ...page, ...taskKeys(), ...(listed() ? [['esc', 'sessions']] : [])];
      if (sessionBox()) return [['enter', 'new session'], ...page, ...more];
      if (view === 'kanban' && sharedNow()) return [['enter', `send to ${sharedWho(sharedNow())}`], ['/', 'commands']];
      // With nothing typed, Enter opens the New task form there, as n and + New task do (submit).
      if (view === 'kanban') return viewOnly() && !thereNow() ? [['/', 'commands']] : [['enter', 'add to To do'], ...more.filter(([key]) => key !== '@name')];
      // While the open session works, a message still goes at any time, and /stop stops the turn:
      // said here, under the box, so nothing is drawn under a waiting message in the chat.
      const open = view === 'chat' && !composing() && selectedId && !selectedRequest ? (snapshot?.tasks ?? []).find(row => row.id === selectedId) : null;
      const stops = open?.state === 'running' && !approvalsFor(open).length || open && controller?.pushing(open.id) ? [['/stop', 'stop']] : [];
      // The new session form with a bot in it that has a schedule: an empty Enter starts the session with that bot's first turn.
      if (!ask.getValue().trim() && starterBot({ cached: true })) return [['enter', 'start the session'], ...stops, ...page, ...more];
      // An empty box over a session whose turn holds a message back: Enter sends it now.
      // A new goal of his is not taken back (waitingMessage): ↑ is named only while another message waits.
      if (!ask.getValue().trim() && heldBack().length) return [['enter', 'send it now'], ...(claim.readOnly || heldBack().every(row => row.goalChange) ? [] : [['↑', 'take it back']]), ...stops, ...page, ...taskKeys(), ...more];
      return [['enter', composing() && composeWhen ? 'save the schedule' : 'send'], ...stops, ...page, ...taskKeys(), ...more];
    }
    // Beside the list, the keys a row's own text names work here too.
    // The page keys come last and are never the ones left out: a bar too long for the screen
    // says "then enter" as ⏎, then Esc's way back in one word, then leaves the arrows out.
    // d shows what the session changed from its chat too, as on its row: d, then Enter.
    if (focused === activity) {
      const keys = [...paneKeys(), ...(paneShowsChanges() ? [['d', 'changes']] : []), ...(paneShowsArtifacts() ? [['v', 'artifacts']] : [])], fits = pairs => widthOf(pairs.map(pair => pair.join(' ')).join('  ')) <= screen.width - 2, steps = stepKeys.length ? [['ctrl+o', 'steps']] : [];
      const bars = [[LETTER, ['↑↓', 'scroll'], ['esc', 'sessions']], [LETTER_SHORT, ['↑↓', 'scroll'], ['esc', 'sessions']], [LETTER_SHORT, ['↑↓', 'scroll'], ['esc', 'back']], [LETTER_SHORT, ['esc', 'back']]].map(([letter, ...rest]) => [...keys, ...(keys.length ? [letter] : []), ...rest, ...steps, ['pgup pgdn', 'page']]);
      // Ctrl+T, for the Task in the header, where the whole bar has room for it.
      if (taskKeys().length) bars.unshift([...bars[0].slice(0, -1), ...taskKeys(), bars[0].at(-1)]);
      return bars.find(fits) ?? bars.at(-1);
    }
    if (focused === changesBox) {
      const row = changesShown?.rows[changesShown.cursor], file = row?.kind === 'file' ? changesShown.entry?.changes.files[row.file] : null;
      // Line notes are for a session on this computer: + and s are named where they work.
      return [['↑↓', 'move'], ...(file ? [['enter', unfolded(changesShown.entry, file) ? 'fold' : 'unfold']] : row?.kind === 'more' && changesShown.entry ? [['enter', 'read more']] : []), ...(row?.line && changesShown.entry?.notes ? [['+', 'note']] : []), ...(changesShown?.entry?.notes?.size ? [['s', 'send notes']] : []), ...(changesShown?.entry ? [['[ ]', 'file'], ['n p', 'change']] : []), ['pgup pgdn', 'page'], ['esc', 'chat'], ['tab', 'next'], ...taskKeys()];
    }
    if (focused === artifactsBox) return [['↑↓', 'scroll'], ['pgup pgdn', 'page'], ['esc', 'chat'], ['tab', 'next'], ...taskKeys()];
    if (focused === scheduleList) {
      const row = scheduleShown?.rows[scheduleList.selected ?? 0], job = scheduleShown?.schedule;
      return [['enter', row?.does ?? 'change'], ['r', 'run now'], ['p', job?.enabled ? 'pause' : 'resume'], ['x', 'delete'], ['esc', scheduleShown?.chat ? 'chat' : 'sessions'], ['tab', 'next']];
    }
    return [['tab', 'next'], ['?', 'help'], ['q', 'quit']];
  }
  // Up in the message box brings back what was sent and the cursor stays in the box: right after Enter, the bar says what the arrows do with it.
  // The bar names Enter only where Enter acts (idleEnter): the rest of what keyPairs names stays.
  // Under a dialog it names the dialog's own keys (bar): the keys of the view behind it do nothing there.
  const barPairs = () => { if (modal) return modal.bar?.() ?? [['esc', 'close']]; const idle = idleEnter(), pairs = keyPairs().filter(([key]) => key !== 'enter' || !idle), walk = recallKeys(); return walk.length ? [pairs[0], ...walk, ...pairs.slice(1)] : pairs; };
  // Whether Enter, where the focus is, does nothing. In the message box with nothing typed there
  // is nothing to send, unless an empty Enter acts there (submit): it starts the form's bot that
  // has a schedule, sends a message a turn holds back now, here or on my other computer, or
  // opens the New session or New task form. A card on this computer's Kanban whose session is
  // gone opens nothing (kanbanAction); a teammate's card is read, and one in To do is edited.
  function idleEnter(focused = screen.focused) {
    if (focused === ask) {
      if (!palette.hidden || ask.getValue().trim() || starterBot({ cached: true })) return false;
      const there = remoteHere();
      if (there) return !(Number.isInteger(there.remote?.held) && there.remote.held > 0 && ['running', 'preparing'].includes(there.remote.state));
      return !(sessionBox() && !viewOnly() || view === 'kanban' && !sharedNow() && (!viewOnly() || thereNow()) || heldBack().length);
    }
    const index = kanbanLists.indexOf(focused), item = kanbanData[index]?.items[focused.selected ?? 0];
    // A card of another computer's board opens there whatever it holds (thereAction).
    return index >= 0 && !sharedNow() && !thereNow() && Boolean(item) && !item.teammate && !item.task && !item.request && item.card?.column !== 'todo';
  }
  const firstWords = (value, width) => fitWords(plain(String(value ?? '').split('\n').find(line => line.trim()) ?? ''), width);
  // How a message names a session: its title in quotes, cut short. No session shows a number.
  const sessionName = task => `"${firstWords(taskTitle(task), 40)}"`;
  // The session's header names its Task where it used to name its state: a click on it, or
  // Ctrl+T, opens the Task with the checklist of its work (showTask). Where it sits in the
  // header, from the header's left: { from, to }, or null while the header shows none.
  const TASK_WORD = 'Task';
  let headerTask = null;
  // A session whose message waits in the queue for a Claude account to reset is waiting, not blocked.
  // So is one of Auto model's whose message starts again at once on its other model (otherWait).
  const otherWait = task => { try { return restartsOnOther(task, snapshot?.queue ?? []); } catch { return false; } };
  const resetWait = task => { try { return waitsForReset(task, snapshot?.queue ?? []) || otherWait(task); } catch { return false; } };
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
  // A team's project this computer has no folder of is a project of its own here: never "shared by".
  const sharedBy = row => row.team ? 'no folder here yet' : `shared by ${sharedWho(row)}${row.sharers.length > 1 ? ` +${row.sharers.length - 1}` : ''}`;
  // The project of a team opened from Projects while this computer has no folder of it: { team,
  // id, name }. Sessions shows its sessions on every computer of the team, and the first new
  // session asks which folder here it is (teamFolderAsk).
  let teamOpen = null;
  const teamNow = () => teamOpen && sharedProjects().some(row => row.id === teamOpen.id && row.team === teamOpen.team) ? teamOpen : null;
  // Outside Sessions the status line is one row: the longest of these that fits it, else the last.
  const fitLine = (...forms) => forms.find(form => widthOf(form) <= status.width - 3) ?? forms.at(-1);
  // As rows of Projects, after this machine's own. One that a computer of mine shares is left
  // out while Projects already lists that project of that computer (away), or this computer has
  // it: by its repository, else by the repositories it holds (remoteApp.has), else by its name.
  // Never two rows for one project. A teammate's share stays.
  const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
  const hereToo = (row, away, now, root) => away.some(there => there.key === row.sharers[0].key && (row.repoId && there.repoId ? there.repoId === row.repoId : there.project === row.name))
    || (remoteApp.has(row.sharers[0].key, row, now, root) ?? (snapshot?.projects ?? []).some(project => sameName(project.name, row.name)));
  const sharedRows = (away, now = Date.now(), root = null) => sharedProjects().filter(row => !(row.sharers[0].mine && hereToo(row, away, now, root)))
    .map(row => ({ ...row, shared: true, root: `shared:${row.id}`, by: sharedBy(row), box: sharedBox(row), online: row.sharers[0].online === true }));
  // The same project as my other computer lists it, when it does: the row Enter opens as any project of that computer.
  function sharedThere(row) {
    const who = row.sharers[0], listed = peerList('remoteMachines').find(machine => machine?.key === who.key);
    const found = (listed?.projects ?? []).find(project => row.repoId && project?.repoId ? project.repoId === row.repoId : project?.name === row.name);
    return found ? { remote: true, key: who.key, id: found.id, name: `${found.name} on ${sharedBox(row).slice(1)}`, project: found.name, machine: sharedBox(row).slice(1) } : null;
  }
  // Its team board, as boardColumns takes a project's: no cards or sessions of this machine, only what its team told.
  // A team's project with no folder here (team) has the sessions of it on every computer of the team too.
  function sharedShown(row, now) {
    if (sharedTold.id !== row.id || now - sharedTold.at > 3000 || now < sharedTold.at) sharedTold = { at: now, id: row.id, board: peerRead('teammateProjectBoard', row.id) };
    const told = sharedTold.board, sessions = Array.isArray(told?.sessions) ? [...told.sessions] : [];
    let team = []; try { team = row.team ? remoteApp.teamCards(null, now, row.team) : []; } catch { team = []; }
    for (const person of team) if (!sessions.some(kept => kept.peer === person.peer)) sessions.push(person);
    return { kanban: { cards: [], done: [], archived: [] }, snapshot: { tasks: [], queue: [] }, id: row.repoId ?? null, name: '', plans: Array.isArray(told?.plans) ? told.plans : [], sessions, shared: row };
  }
  // The message box over it: the longest that fits says where the message runs.
  function sharedLabel(row, max = Infinity) {
    const who = row.sharers[0].mine ? `your computer ${sharedBox(row)}` : sharedWho(row), name = clip(row.name, 30);
    return [` Message ${who} about ${name} · starts a session on ${row.sharers[0].mine ? 'it' : 'their computer'}, under the access ${row.sharers[0].mine ? 'you' : 'they'} chose `, ` Message ${who} about ${name} · starts a session there `, ` Message ${who} about ${name} `, ` Message ${who} `].find(form => widthOf(form) <= max) ?? ` Message ${who} `;
  }
  // The line under its board: whose it is and where, and how it comes here. A team's project with
  // no folder here is this computer's project too: its first session here asks which folder it is.
  function sharedNote(row, max) {
    if (row.team) return [`${clip(row.name, 30)} on every computer of the team. It has no folder here yet: a new session in Sessions asks which folder it is.`, `${clip(row.name, 30)} on every computer of the team. It has no folder here yet.`, 'No folder here yet.'].find(form => widthOf(form) <= max) ?? '';
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
      // The sessions everyone else runs in this project when it is a shared project, from their
      // computers' lists (lib/terminal-remote.mjs), for whoever the cards above do not show.
      let shared = []; try { shared = off ? [] : remoteApp.teamCards(controller.repo.root); } catch { shared = []; }
      for (const person of shared) if (!sessions.people.some(row => row.peer === person.peer)) sessions.people.push(person);
      // A team's project: everyone on the team sees its sessions, with or without an origin remote.
      let teamProject = false; try { teamProject = !off && remoteApp.teamProject(controller.repo.root); } catch { teamProject = false; }
      teamTasks = { at: Date.now(), root, people: peerList('teammateTasks', root).filter(person => Array.isArray(person?.tasks) && person.tasks.length), sessions, off, teamProject };
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
    const sessions = team.sessions.people.map(person => ({ ...person, sessions: (person.sessions ?? []).filter(card => card.repoId === id || card.anyBoard === true && id === (kanbanBoards[0]?.id ?? null)) })).filter(person => person.sessions.length);
    return { ...own, id, name: boardName(kanbanBoards.find(row => row.id === id)), plans, sessions };
  }
  // The open project's board goes by the project's name, as a board of my other computer's
  // project does. Where the project has one for each of its repositories, each goes by its repository.
  const boardName = board => !board ? '' : kanbanBoards.length > 1 ? board.name : snapshot.name;
  // The boards of the open project, then those of my other computers' projects that are not here.
  async function pickKanbanBoard() {
    const here = controller ? kanbanBoards : [], there = thereBoards(), rows = [...here.map(row => ({ name: boardName(row), here: row })), ...there.map(row => ({ name: `${row.project} on @${row.machine}`, there: row }))];
    if (rows.length < 2) throw new Error('This project has one board.');
    const shown = kanbanThere ? rows.findIndex(row => row.there && sameThere(row.there, kanbanThere)) : rows.findIndex(row => row.here?.id === (kanbanPicked?.id ?? kanbanBoards[0]?.id));
    const notes = [...(here.length > 1 ? ['Each repository this project works in has its own board, shared with teammates who have it.'] : []), ...(there.length ? ['A shared project on another computer shows its board from there. What you change on it changes there, under its access rules.'] : [])];
    const picked = await listDialog('Kanban board', rows.map(row => ink(row.name, 'text', colour)), { selected: Math.max(0, shown), notes });
    if (!picked) return;
    const row = rows[picked.index];
    if (row.there) { kanbanThere = { ...row.there, root: controller?.repo.root ?? null }; return; }
    kanbanThere = null; kanbanPicked = { root: controller.repo.root, first: kanbanFolders(Date.now()).first, id: row.here.id };
  }
  // --- Kanban: a project of my other computer (lib/peer/remote-board.mjs) ---
  // Read from that computer every 3 seconds while it shows. What the owner does to a card is
  // sent there and done there, by that computer's own Kanban; then the board is read again.
  const sameThere = (a, b) => a?.key === b?.key && a?.id === b?.id;
  const thereBoards = () => { try { return remoteApp.boards(Date.now(), controller?.repo.root ?? null); } catch { return []; } };
  // The one Kanban shows, while my computer still lists it and it is still not here. It was
  // chosen with the project open then (root): opening or making another one here lets it go.
  const thereNow = () => {
    if (kanbanThere && kanbanThere.root !== (controller?.repo.root ?? null)) kanbanThere = null;
    return kanbanThere && view === 'kanban' && !sharedNow() ? thereBoards().find(row => sameThere(row, kanbanThere)) ?? null : null;
  };
  let thereKept = { at: 0, of: null, board: null, error: null, older: false, offline: false, asking: false };
  function thereShown(row, now) {
    const of = `${row.key}\0${row.id}`;
    if (thereKept.of !== of) thereKept = { at: 0, of, board: null, error: null, older: false, offline: false, asking: false };
    if (!row.older && !thereKept.asking && (now - thereKept.at > 3000 || now < thereKept.at)) {
      thereKept.asking = true;
      const kept = thereKept, done = value => { Object.assign(kept, { at: Date.now(), asking: false, ...value }); if (!closing) draw(); };
      peerCommand({ type: 'remoteBoard', to: row.key, project: row.id }, { timeoutMs: 20000 })
        .then(result => done({ board: result?.columns ? result : null, older: result?.older === true, offline: result?.offline === true, error: null }), error => done({ error: error.message }));
    }
    return thereKept;
  }
  // Its four columns as that computer sent them: each card as one of mine, with what it is there
  // (there). One that waits for my check there says so as on its own board (check).
  function thereColumns(row, now) {
    const kept = thereShown(row, now), told = row.older || kept.older ? null : kept.board;
    return COLUMNS.map(([column, name]) => ({ column, name, items: (told?.columns.find(part => part.column === column)?.items ?? []).map(item => ({
      key: item.key, column, title: item.title, detail: item.detail, there: row, wire: item, card: item.card ?? null, task: item.ref ? { state: item.state } : null, request: item.requestState ? { state: item.requestState } : null, ...(item.plan ? { plan: item.plan } : {}), ...(item.check ? { check: true } : {}) })) }));
  }
  // The line under it: that what changes here changes there, or why it is not shown. The title
  // over it says where it is: the two say it once each, with the computer's @name.
  function thereNote(row, max) {
    const kept = thereShown(row, Date.now()), name = `@${row.machine}`;
    const forms = row.older || kept.older ? [`Update ELU on ${name} to see its board here.`] : kept.offline || !row.online ? [`${name} is offline. Its board shows here once it is back.`, `${name} is offline.`]
      : kept.error ? [clip(kept.error, max)] : !kept.board ? [`Reading its board from ${name}…`]
      : [`What you change here changes on ${name}.`, 'What you change here changes there.'];
    return forms.find(form => widthOf(form) <= max) ?? forms.at(-1);
  }
  // A card of it opened: as a session of mine on that computer (openCard), with Go to session.
  const posedThere = (row, item) => ({ ...item, task: null, request: null, teammate: { peer: row.key, name: row.machine, box: row.machine, online: row.online, mine: true },
    session: { own: true, by: '', ref: item.wire.ref ?? null, remote: null, first: item.wire.first ?? '', at: item.wire.at ?? null, title: item.title, ...(item.plan ? { plan: item.plan.id } : {}) }, ...(item.plan ? { shared: item.plan } : {}) });
  async function thereAct(row, act, extra = {}) {
    const result = await peerCommand({ type: 'remoteBoardAct', to: row.key, project: row.id, act, ...extra }, { timeoutMs: 30000 });
    if (result?.offline) throw new Error(`@${row.machine} is offline. Try again once it is on.`);
    if (result?.older) throw new Error(`Update ELU on @${row.machine} to change its board from here.`);
    thereKept.at = 0; setMessage(`${result?.said ?? 'Done.'} On @${row.machine}.`); draw();
  }
  // Kanban keys on a card of my other computer's board: the same keys as here, done there.
  async function thereAction(row, index, action) {
    const column = kanbanData[index], item = column?.items[kanbanLists[index].selected ?? 0];
    if (action === 'new') {
      const text = await prompt('New task', `What should be done on ${row.machine}? It waits in To do there until you start it with Shift+→.`, '', { check: notCommand });
      if (text?.trim()) await thereAct(row, 'add', { text }); return;
    }
    if (!item) throw new Error('Nothing here. n adds a task to To do.');
    if (action === 'open') {
      if (item.card?.column === 'todo') {
        const text = await prompt('Edit task', 'Change the task. Shift+→ on it starts it.', item.card.text, { check: text => notCommand(text, item.card.text) });
        if (text?.trim() && text.trim() !== item.card.text) await thereAct(row, 'edit', { key: item.key, text }); return;
      }
      return openCard(posedThere(row, item));
    }
    // Done there waits for the owner's check, as here: Shift+→ or /done on a session under Needs
    // you shows its check from that computer (elu.remote.check), and only its Done moves it. A
    // card whose session is gone has nothing to check, and moves there at once.
    if (action === 'check' && column.column !== 'needs') throw new Error(column.column === 'done' ? 'It is in Done already.' : 'Only a card under Needs you waits for your check.');
    if (['forward', 'check'].includes(action) && column.column === 'needs' && item.wire.ref) {
      const older = remoteApp.checkLine(row.key); if (older) throw new Error(older);
      await checkSession({ remote: { to: row.key, ref: item.wire.ref }, title: item.title });
      thereKept.at = 0; draw(); return;
    }
    if (['remove', 'forward', 'back', 'check'].includes(action)) return thereAct(row, action === 'check' ? 'forward' : action, { key: item.key });
  }
  // Why teammates see none of this board, when they could expect to.
  function drawTeamTasks(on, shown = null) {
    const note = on && shown?.there ? thereNote(shown.there, screen.width - 4) : on && shown?.shared ? sharedNote(shown.shared, screen.width - 4) : !on || !teamTasks.root ? '' : teamTasks.off ? 'Kept off the team board: teammates do not see your sessions here, and theirs are not shown. /share on puts it back.'
      : shown && shown.id === null && shown.snapshot.tasks.length && !teamTasks.teamProject ? 'These sessions work in no repository with an origin remote, so teammates do not see them.' : '';
    const g = geometry(screen.width, screen.height), height = g.statusTop - lifted - g.top, tall = note ? 3 : 0;
    if (on) kanbanBoxes.forEach(frame => { frame.height = height - tall; });
    Object.assign(kanbanTeam, { top: g.top + height - tall, left: 0, width: g.width, height: 3 });
    kanbanTeam.hidden = !tall;
    kanbanTeam.style.border.fg = shade('border');
    // A board read from another computer is no team board here: its line is about that computer.
    const label = on && shown?.there ? ' Another computer ' : ' Team board ';
    if (kanbanTeam.options.label !== label) { kanbanTeam.options.label = label; kanbanTeam.setLabel(label); }
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
        // A session of a shared project opens in Sessions, under that computer, to read.
        const key = card?.anyBoard && card.ref ? remoteApp.sessionKey(person.peer, { ref: card.ref }, controller?.repo.root) : null;
        if (key) open = () => { rememberDraft(); view = 'tasks'; returnTo = 'tasks'; selectedId = null; selectedRequest = null; following = null; ownSeen = null; wanted = null; barKey = openKey = key; resize(); focusInput(); };
      }
    }
    // A Task the session's mode approved says so, as the card in its session does. A line that
    // says what started the Task already (· started by a schedule) is not told that again.
    if (task && approvesTasks(task.approvedBy)) where = `${where} · ${taskLetBy(task, { started: !where.includes(' · started by ') })}`;
    say(task ? task.title : card ? card.title : item.title, 'text', true);
    // Where the card sits leads the line when it says something the Task's state does not: a
    // finished Task waiting for /publish is in progress, and its card is under Needs you. A
    // session in Done ended: its card says how (mine: answered, committed, published, stopped),
    // never in progress, with no ETA, and objectives nobody marked carry no met count.
    const ended = item.column === 'done' && task?.state !== 'done';
    const state = task ? task.state === 'proposed' ? 'waits for approval' : ended ? item.task ? sessionDetail(item.task) : '' : teamTaskState(task) : '';
    if (task) say([...(column && String(column).toLowerCase() !== state ? [column] : []), state, `priority ${task.priority}`, `severity ${task.severity}`, ...(task.revision > 1 ? [`revision ${task.revision}`] : [])].filter(Boolean).join(' · '), 'muted');
    else say(column, item.column === 'needs' ? 'orange' : item.column === 'progress' ? 'blue' : 'muted');
    say(where, 'muted');
    if (task) {
      const { done, of } = teamTaskDone(task), criteria = Array.isArray(task.criteria) ? task.criteria : [];
      if (task.goal) { head('Goal'); say(task.goal); }
      if (task.description) { head('Description'); say(task.description); }
      head(ended && !task.met.length ? 'Objectives' : `Objectives · ${task.met.length} of ${task.objectives.length} met`);
      task.objectives.forEach((text, index) => { const met = task.met.includes(index + 1), shows = typeof task.evidence?.[index] === 'string' ? task.evidence[index] : ''; say(`  ${met ? '✓' : '·'} ${text}`, met ? 'green' : 'text'); if (shows) say(`    ${shows}`, 'muted'); });
      head(`Success criteria${criteria.length ? '' : ' · not set'}`); for (const text of criteria) say(`  · ${text}`);
      if (of || !ended) head(of ? `Subtasks · ${done} of ${of} done` : 'Subtasks · none yet');
      for (const step of task.subtasks) say(`  ${step.state === 'done' ? '✓' : step.state === 'doing' ? '▸' : '·'} ${step.text}`, step.state === 'done' ? 'green' : step.state === 'doing' ? 'blue' : 'text');
      if (!ended) { lines.push(''); say(`ETA ${etaText(task, now)}`, task.state !== 'done' && (taskEta(task) ?? Infinity) < now ? 'orange' : 'text'); }
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
      adoptHistory(); follow(); goalRead();
      // Messages a newer one to the same session made pointless leave the queue for good.
      for (const project of snapshot.projects ?? [snapshot]) if (project?.superseded?.length) { try { dropRequests(project.root, project.superseded); } catch { /* The next draw tries again. */ } }
      peerData = peerFrame();
      // A shared project's team board is open only while Kanban shows it. Once it is gone (unshared, the
      // team left, or it is here now), Kanban is the open project's again. A team's project with no
      // folder here, opened from Projects, is its board in Kanban while it stays open.
      if (view === 'kanban' && sharedOpen === null && teamNow()) sharedOpen = teamNow().id;
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
      // A new session in a team's project with no folder here (teamNow) is titled by that project.
      const there = remoteHere(), far = there?.remote ?? null, project = far ? there.project !== '-' ? there.project : '' : !task && !selectedRequest && teamNow() ? teamNow().name : snapshot.name;
      // A schedule's run that has not started yet is titled as its row reads: the name it takes, else
      // the schedule's wording (requestTitle). Its session keeps that title once it starts.
      // So is a new session another computer asked for that waits for a yes here (asksYes): it is no saved request of the owner's.
      const timed = !task && !far && selectedRequest && !selectedRequest.origin && (selectedRequest.scheduleId || asksYes(selectedRequest)) ? selectedRequest : null;
      const goal = task ? firstWords(taskTitle(task), 60) : far ? firstWords(far.title || 'Session', 60) : timed ? firstWords(requestTitle(timed), 60) : '';
      const titled = (name, text) => [name, task || far || timed ? text : selectedRequest ? 'saved request' : following ? following.bot ? `sending to @${following.bot}` : 'sending' : 'New session', task || far ? TASK_WORD : ''].filter(Boolean).join('  ·  ');
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
      // Kanban: the title beside Board ▾ leaves out the project the button names already.
      const pickNames = name => !kanbanPick.hidden && kanbanName === name;
      const title = view === 'kanban' ? sharedNow() ? sharedNow().team ? `${sharedNow().name}  ·  ${sharedBy(sharedNow())}` : `${sharedNow().name}  ·  ${sharedBy(sharedNow())}  ·  on ${sharedBox(sharedNow())}` : thereNow() ? `${pickNames(thereNow().project) ? '' : `${thereNow().project}  ·  `}on @${thereNow().machine}` : controller && !pickNames(snapshot.name) ? snapshot.name : '' : view !== 'chat' && !far ? '' : !listed() || widthOf(titled(project, goal)) <= room ? titled(project, goal) : widthOf(titled('', goal)) <= room ? titled('', goal) : titled('', fitWords(goal, Math.max(4, room - widthOf(titled('', '.')) + 1)));
      Object.assign(header, { left, width: Math.max(1, W - left - 1) });
      // Task is underlined, as a link is: what it opens is the session's Task (showTask).
      const shownTitle = clip(title, room), taskAt = (task || far) && view !== 'kanban' && shownTitle.endsWith(`  ·  ${TASK_WORD}`) ? widthOf(shownTitle) - TASK_WORD.length : -1;
      headerTask = taskAt >= 0 ? { from: taskAt, to: taskAt + TASK_WORD.length } : null;
      header.setContent(taskAt >= 0 ? ink(shownTitle.slice(0, -TASK_WORD.length), 'text', colour, true) + `{underline}${ink(TASK_WORD, 'blue', colour, true)}{/underline}` + badge + tail : ink(shownTitle, 'text', colour, true) + badge + tail);
      // Sessions: the list. Its rows are built before this, with the cursor.
      boardBox.hidden = !listed();
      if (listed()) {
        // The list's last column is its scrollbar. The first one marks the cursor's row.
        // A row stops one column short of the list, as in the other lists. One that fills it is wrapped by blessed and loses its age.
        const width = Math.max(8, board.width - 2), mark = screen.focused === board ? 'orange' : 'dim', columns = barColumns(boardLines.flatMap(line => line.row && !line.header ? [line.row] : []), width - 1);
        // A project's name over the sessions of my other computer in it (sub): its name, then how many.
        const lines = boardLines.map((line, place) => line.spacer ? '' : line.note ? ink(` ${line.note}`, 'muted', colour) : line.sub ? ink(` ${cutText(line.sub, Math.max(1, width - String(line.count).length - 3))}`, line.tone, colour, true) + ink(` ${line.count}`, 'muted', colour) : line.header
          ? (line.row ? ink(place === barAt ? '▌' : ' ', mark, colour) + ink(line.header.toUpperCase(), line.tone, colour, true) : ink(` ${line.header.toUpperCase()}`, line.tone, colour, true)) + ink(` ${line.count} `, 'muted', colour) + ink('─'.repeat(Math.max(0, width - widthOf(line.header.toUpperCase()) - String(line.count).length - 3)), 'dim', colour)
          : ink(place === barAt ? '▌' : ' ', mark, colour) + (line.add ? ink('+ New session', 'orange', colour, true) : barCells(line.row, width - 1, now, line.inProject ? { ...columns, project: 0 } : columns).map(cell => ink(cell.text, cell.tone, colour, cell.bold, { trusted: line.row.kind === 'peer' && line.row.item?.trusted === true })).join('')));
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
        // A pane a long line under the chat made shorter keeps the cursor's row in sight (at 80x24
        // the row of a computer that says it is mine went out of it): select scrolls only on a move.
        for (const list of teamLists) { const shown = list.height - list.iheight; if (shown > 0 && (list.selected ?? 0) >= list.childBase + shown) list.scrollTo(list.selected ?? 0); }
      }
      // Kanban
      const sharedBoard = view === 'kanban' ? sharedNow() : null;
      // With no project here, Kanban opens on the first project of my other computers by itself.
      if (view === 'kanban' && !controller && !sharedBoard && !thereNow()) { const first = thereBoards()[0]; kanbanThere = first ? { ...first, root: null } : null; }
      const thereBoard = view === 'kanban' && !sharedBoard ? thereNow() : null;
      const kanbanOn = view === 'kanban' && Boolean(controller || sharedBoard || thereBoard);
      kanbanOff.hidden = view !== 'kanban' || kanbanOn;
      kanbanOff.setContent('Kanban shows one project. Open one in the Projects tab, or start elu inside it.');
      kanbanBoxes.forEach((frame, index) => { frame.hidden = !kanbanOn; frame.style.border.fg = screen.focused === kanbanLists[index] ? accent : shade('border'); });
      if (kanbanOn) {
        let data = sharedBoard || thereBoard ? null : readBoard(controller.repo);
        if (data?.cards.some(card => card.requestId && !card.taskId) && linkCards(controller.repo, snapshot.queue ?? [])) data = readBoard(controller.repo);
        const previous = kanbanData, shown = thereBoard ? { there: thereBoard, name: thereBoard.project } : sharedBoard ? sharedShown(sharedBoard, now) : kanbanShown(data, now); kanbanName = shown.name;
        kanbanData = thereBoard ? thereColumns(thereBoard, now) : boardColumns(shown.kanban, shown.snapshot, now, shown.plans, shown.sessions); kanbanShownNow = shown;
        // A card a schedule runs has its mark in front, as its row in Sessions does, grey while the
        // schedule is paused: one on my other computer says so itself (timed, timedPaused).
        const jobs = !thereBoard && !sharedBoard ? listSchedules() : [];
        const cardJob = item => item.teammate ? null : thereBoard ? item.wire?.timed === true ? { enabled: item.wire.timedPaused !== true } : null
          : item.task ? runSchedule(controller.repo.root, item.task, jobs) : item.request?.scheduleId ? jobs.find(job => job.id === item.request.scheduleId) ?? null : null;
        kanbanData.forEach((column, index) => {
          const list = kanbanLists[index], wide = Math.max(4, list.width - 2), kept = previous[index]?.items[list.selected ?? 0]?.key;
          kanbanBoxes[index].setLabel(` ${column.name} ${column.items.length} `);
          const tone = item => item.teammate ? item.teammate.online === false || column.column === 'done' ? 'muted' : 'blue' : item.task?.state === 'needs_input' || item.request?.state === 'blocked' || item.task?.state === 'blocked' || item.plan?.state === 'proposed' ? 'orange' : column.column === 'progress' ? 'blue' : column.column === 'done' ? 'muted' : 'text';
          const lines = column.items.map(item => {
            const timed = scheduleMark({ onSchedule: cardJob(item) }), width = timed ? Math.max(4, wide - 2) : wide;
            // A Task's card is its title first; where the Task stands goes beside it as far as it fits (lib/kanban.mjs).
            // One that waits for the owner's check says so where it fits.
            const card = item.teammate ? item.check && fitCheckCard(plain(item.title), item.detail, width, 1) || fitTeammateCard(plain(item.title), item.detail, width, item.session ? 2 : 1) : item.check && fitCheckCard(plain(item.title), item.detail, width) || (item.plan ? fitCard(plain(item.title), item.detail, width) : null), title = card ? card.title : fitWords(plain(item.title), width), room = width - widthOf(title) - 2;
            const detail = card ? card.detail : item.detail && room >= Math.min(widthOf(item.detail), 12) ? clip(item.detail, room) : '';
            return (timed ? ink(`${SCHEDULE_MARK} `, timed.tone, colour, true) : '') + ink(title, tone(item), colour, column.column !== 'done') + (detail ? ink(`  ${detail}`, 'muted', colour) : '');
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
        // column shrinks, then a shorter hint is used, then none, so no row wraps. A hint with a
        // time in it (the next run) is fitted at its widest, so it shows at any hour or at none.
        const room = Math.max(30, composeList.width - 1), column = Math.min(22, Math.max(12, room - 29));
        const label = text => ink(text.padEnd(13), 'muted', colour);
        const row = (name, value, tone, ...hints) => {
          const text = clip(value, Math.min(40, room - 13)), wide = Math.max(column, widthOf(text) + 2), hint = hints.find(hint => 13 + wide + widestTime(hint).length <= room);
          // tone: a colour for the whole value, or a function that paints it word by word.
          if (typeof tone === 'function') return label(name) + tone(text) + ' '.repeat(hint ? wide - widthOf(text) : 0) + ink(hint ?? '', 'muted', colour);
          return label(name) + ink(hint ? padEnd(text, wide) : text, tone, colour, true) + ink(hint ?? '', 'muted', colour);
        };
        // A team's project opened from Projects with no folder here: the session is its, and sending asks which folder it is.
        const team = teamNow(), teamName = team ? clip(team.name, Math.max(4, room - 13)) : '', asks = team ? ['  sending asks which folder here it is', '  asks its folder here', ''].find(text => widthOf(teamName) + widthOf(text) <= room - 13) ?? '' : '';
        composeRows = [{ type: 'project', line: team ? label('Project') + ink(teamName, 'text', colour, true) + ink(asks, 'muted', colour) : label('Project') + ink(clip(snapshot.name, room - 13 - (claim.readOnly ? 11 : 0)), 'text', colour, true) + ink(claim.readOnly ? '  view only' : '', 'orange', colour) }];
        const upcoming = composeWhen && nextRun(composeWhen, new Date(now));
        composeRows.push({ type: 'when', line: row('When', composeWhen?.label ?? 'now', composeWhen ? 'orange' : 'text', ...(composeWhen ? [upcoming ? `next ${dateText(upcoming)}` : 'has passed'] : ['/schedule to run it later', '/schedule'])) });
        // The session's permissions: the mode, where the lead works, extra folders it may read.
        composeRows.push({ type: 'permissions', line: row('Permissions', LABELS[composeMode], composeMode === 'full' ? 'orange' : 'text', '/permissions ask, auto or full', '/permissions') });
        composeRows.push({ type: 'place', line: row('Runs in', placeText(composePlace), composePlace.kind === 'here' ? 'orange' : 'text', '/place worktree, branch NAME or here', '/place') });
        const folders = composeFolders.length ? composeFolders.map(shortHome).join(' ') : 'none';
        composeRows.push({ type: 'folders', line: row('Folders', folders, 'text', ...(composeFolders.length ? ['/permissions folders add PATH · x clears', '/permissions folders add PATH', 'x clears'] : ['/permissions folders add PATH', '/permissions folders'])) });
        // The model the message goes to, then the bots that review its changes.
        // With Auto model the row names it, and the note says which model takes which step.
        const start = composeModel ?? controller.defaultModel(), using = nameOf(start), passed = composeModel ? '' : passedOver(controller.startModel().missing, nameOf), auto = formAuto();
        composeRows.push({ type: 'model', line: row('Model', auto ? AUTO_NAME : using, 'orange', '/model NAME, or /model to pick', '/model NAME') });
        composeRows.push({ type: 'bots', line: row('Bots', composeBots.length ? botNames(composeBots, Math.min(40, room - 13)) : 'none', text => paintBots(text, 'text'), '/bots add NAME, /bots remove NAME', '/bots add NAME') });
        const lines = composeRows.map(row => row.line);
        if (lines.join('\n') !== composeList.ritems?.join('\n')) composeList.setItems(lines);
        // The note under the rows takes the lines it needs, and the rows take the rest.
        const note = (composeWhen ? `${scheduleRuns()}\nRuns while this computer is awake, even with ELU closed.` : `${auto ? autoOnLine(start.vendor) : `Your message goes to ${using}.`}${passed ? ` ${passed} ` : '\n'}${composeBots.length ? 'Bots review the changes. Type @name to add one or to write to it.' : 'No bot reviews the changes. Type @name to add one.'}`).split('\n').flatMap(line => wrapText(line, Math.max(10, compose.width - 4)));
        if (composeHint.height !== note.length) { composeHint.height = note.length; composeList.height = `100%-${note.length + 3}`; }
        composeHint.setContent(note.join('\n'));
        compose.style.border.fg = screen.focused === composeList ? accent : shade('border');
      }
      const lines = []; stepKeys = []; agentHeads = []; waitButtons = [];
      // Who wrote each entry of a session's chat, when and what: a held place follows it (partsShown).
      // partKeys: a line's own key by its place, where its first row changes as it grows: the
      // working turn's steps, whose line counts the steps before its newest.
      let entryKeys = []; const partKeys = [];
      // A plain line in the chat is wrapped at words here, so the pane beside the list never wraps one a second time.
      // It is wrapped one column short of the pane: blessed wraps a coloured row that fills the pane again, at its
      // last space, which left "carry" and "on." of a stop line on rows of their own.
      const note = (text, tone, bold = false) => wrapText(text, chatWidth() - 1).map(row => ink(row, tone, colour, bold)).join('\n');
      if (task) {
        // A message answered beside the turn that still works (lib/message-aside.mjs) shows under
        // the working line, where it was typed, so a turn with many steps never pushes it out
        // of sight (besideTurn); once that turn is over it is part of the chat, in its place.
        const every = conversationEntries(repo, task, { all: true }), all = every.slice(-80), leadName = workingModel(task);
        // A schedule's run opens with the schedule's message, the first of its chat, which nobody
        // typed: it reads Schedule, as the run did while it waited and as my other computers show it.
        const opening = every[0]?.role === 'You' && !every[0].shell && !every[0].bot && scheduleRun(repo.root, task) ? every[0] : null;
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
        // A session in Done on the board says how it ended there, as its card does (endedAs).
        let ended = ''; if (task.plan?.state === 'approved') { try { ended = endedAs(readBoard(repo), task, { requests: snapshot.queue ?? [] }); } catch { /* Read as not ended. */ } }
        const cardAt = task.plan && !dropped ? taskPlace(entries, task.plan) : -1, card = () => lines.push(taskCard(task.plan, { width: chatWidth(), colour, approval: approvalsFor(task).length > 0, ended }));
        // A second launch of the model or of a bot for one message is said with that run: under
        // the reply it wrote, or under its steps when it wrote none, and never under a later
        // message. One that started the message over may have run again what the first one ran;
        // one that asked the same session for its reply again started nothing over.
        // name: the model's, as its reply is titled; a bot's run is said by the bot's own name.
        const twice = (turn, name) => { const run = (turn ?? []).findLast(row => row.again); if (!run) return; const who = botOfKey(run.role) ? `@${botOfKey(run.role)}` : name; lines.push(note(run.resumed ? `${who} was asked for its reply again: the first one was not accepted.` : `${who} was started twice for this message: its first reply was not accepted. Anything it ran may have run twice.`, 'muted')); };
        // What another computer sent that waits for this computer's yes, and a message of yours
        // that did not run, sit where they were sent, as every other message does: one older than
        // the chat's last entry goes in its place by time, and the rest end the chat, right above
        // the message box. A message that did not run says why, and how to act on it. While the
        // session works its row stands for the turn, so the keys are named once the turn ends.
        const working = ['running', 'preparing'].includes(task.state);
        const unsent = (snapshot.queue ?? []).filter(value => value.continuationTaskId === task.id && ['blocked', 'waiting'].includes(value.state) && !(value.origin && value.state === 'waiting')).sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
        const drawUnsent = row => {
          // One another computer sent that waits for this computer's yes (asksYes) says so. Under
          // it, what can be done with it, each a word to click (waitingAction): Yes, as r in
          // Sessions says it, or Send again for one of his that did not run; Dismiss, as s takes it
          // away; and for one another computer or a teammate sent, Reply, which answers them in
          // its place.
          const yes = asksYes(row), who = requester(row);
          const actions = [yes ? 'Yes' : 'Send again', 'Dismiss', ...(who !== 'You' && typeof row.overseer !== 'string' ? ['Reply'] : [])];
          waitButtons.push({ id: row.id, taskId: task.id, who, actions });
          partKeys[lines.length] = `\0unsent\0${row.id}`;
          lines.push(chatMessage({ title: `${who} (${row.state === 'blocked' ? 'blocked' : yes ? 'waits for your yes' : 'saved'})`, at: row.createdAt, text: requestGoal(row), tone: 'blue', shaded: true }, chatWidth(), colour) + (row.state === 'blocked' && row.reason ? '\n' + note(row.reason, 'muted') : '') + '\n' + actions.map(word => ink(word, 'blue', colour, true)).join(ink(' · ', 'muted', colour)));
        };
        let drawn = 0;
        for (const entry of entries) {
          if (drawn++ === cardAt) card();
          { const at = Date.parse(entry.at); while (unsent.length && Date.parse(unsent[0].createdAt) < at) drawUnsent(unsent.shift()); }
          for (const turn of [before.get(entry), owned.get(entry)]) { const steps = turn ? foldedSteps(turn) : null; if (steps) lines.push(steps); if (turn === before.get(entry)) twice(turn, leadName); }
          const text = entry === last ? withQuestion(entry.text) : entry.text;
          // A ! command sits between the messages behind a green bar, with its output as printed.
          if (entry.shell) { lines.push(chatMessage({ title: entry.role, at: entry.at, text, tone: 'green', raw: true }, chatWidth(), colour)); continue; }
          // A bot's reply sits behind a bar in the bot's own colour, never the lead's orange or your blue; one it could not give, behind a red one.
          // What it wrote while its turn worked, in answer to a message that turn took, says so (lib/runner.mjs inboxFeed).
          if (entry.bot) { const head = tagged(entry.role, entryTag(entry), entry.whileWorking ? WHILE_WORKING : ''); agentHeads.push({ ...head, bot: entry.bot }); lines.push(chatMessage({ ...head, at: entry.at, text, tone: entry.failed ? 'red' : entry.quiet ? 'muted' : toneOfBot(entry.bot) }, chatWidth(), colour)); twice(owned.get(entry), entry.role); continue; }
          // A standup's own lines (lib/standup.mjs) are notes; each update sits behind the agent's orange bar, titled with its session and computer.
          if (entry.line) { lines.push(note(text, 'muted')); continue; }
          if (entry.update) { lines.push(chatMessage({ title: entry.role, at: entry.at, text, tone: entry.failed ? 'red' : 'orange' }, chatWidth(), colour)); continue; }
          // A message sent while a turn worked, that went to that turn, says under it when that
          // turn read it and answered it (readWords), and keeps the time he sent it.
          const head = tagged(entry === opening ? 'Schedule' : sentFrom(entry) ? String(entry.role).replace(/^You(?= |$)/, sentFrom(entry)) : entry.role, entryTag(entry), entry === last ? ' is waiting for you' : entry.whileWorking ? WHILE_WORKING : ''); if (entry.lead && entry !== opening) agentHeads.push({ ...head, bot: null });
          lines.push(chatMessage({ ...head, at: entry.sentAt ?? entry.at, text, tone: entry.lead ? 'orange' : 'blue', shaded: !entry.lead }, chatWidth(), colour) + (entry.during ? '\n' + note(readWords(entry, messageTime), 'muted') : ''));
          twice(owned.get(entry), entry.role);
        }
        if (cardAt >= entries.length) card();
        const unanswered = after.length ? foldedSteps(after) : null; if (unanswered) lines.push(unanswered);
        twice(after, leadName);
        if (waiting && !last) lines.push(chatMessage({ title: `${leadName} is waiting for you`, text: withQuestion(''), tone: 'orange' }, chatWidth(), colour));
        // While it waits for an allow or deny it is not working: the approval below says what it waits for.
        const workFrom = lines.length; let liveAt = -1;
        if (task.state === 'running' && !approvalsFor(task).length) {
          const working = after => { const line = tagged(roleLabel(task.activeRole), startedOn(task, task.activeRole), after); return line.narrow && widthOf(visible(line.title)) > chatWidth() ? line.narrow : line.title; };
          lines.push(ink(task.shadowing ? working(' is shadowing the last turn') : standupStage(task) === 'round' ? standupWaitLine(task) : standupStage(task) === 'summary' ? `${leadName} is writing the summary` : task.activeRole === 'checks' ? 'Checks are running' : !task.activeRole || task.activeRole === 'lead' ? `${leadName} is working` : working(' is working'), botOfKey(task.activeRole) ? toneOfBot(botOfKey(task.activeRole)) : 'orange', colour, true));
          // What the run does now: its newest step, under one line for the steps before it,
          // which opens to them all. Before its first one, and for the checks, the newest line
          // of the session's activity.
          const live = task.activeLog && path.dirname(task.activeLog) === taskDir(repo, task.id) ? runSteps(task.activeLog, { cwd: task.worktree }) : [];
          if (live.length) { liveAt = lines.length - workFrom; lines.push(workingSteps(live, { width: chatWidth() - 1, colour, now, shown: () => stepsShown(task.activeLog) })); }
          // A run that prints only when it ends (lib/runner.mjs activeSilent): how long it has worked, and why no step shows.
          else if (task.activeSilent?.log && task.activeSilent.log === task.activeLog) lines.push(note(silentLine(task.activeSilent.name, Date.parse(task.activeSince ?? ''), now), 'muted'));
          // A quick answer of Auto model's (quickTurn) logs no steps: a line from the turn before it is not shown.
          else { const event = snapshot.activity.findLast(row => String(row.taskId) === String(task.id)); if (event && !(task.quickTurn && !(Date.parse(event.at) >= Date.parse(task.activeSince)))) lines.push(ink(clip(event.text, chatWidth()), 'muted', colour)); }
          // That a message can go any time and /stop stops the turn is said by the key bar under the message box (keyPairs).
        }
        // The turn at work is drawn directly above what waits for it, under the notes about the turns before (below).
        const atWork = lines.splice(workFrom);
        // A session that stopped and waits for the owner says why, when that is known, and the one
        // thing to do. Edits a later turn could not finish are not offered to /publish.
        const stop = stopLine(task, { goesOn: resetWait(task), other: otherWait(task) });
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
        // A refresh script to keep shows whole, as written, under what it asks, and so does the
        // note, answer, goal, card or line the bot that oversees asks to send (askedWhole).
        for (const row of approvalsFor(task)) lines.push([ink('Waiting for your approval', 'orange', colour, true), ink(`${!row.role || row.role === 'lead' ? leadName : roleLabel(row.role)} wants to:`, 'text', colour), note(row.summary, 'text', true), ...[askedWhole(row)].filter(Boolean).flatMap(whole => [note(whole.label, 'muted'), note(whole.text, 'text')]), ...(row.script ?[markdownRows(codeBlock(blockText(row.script.text, { trusted: true })), chatWidth() - 1, { colour }).join('\n')] : []), ink(offersFull(task, row) || offersAlways(task, row) ? `${approvalKeys(task, row)}, then Enter` : 'y allow · n deny, then Enter · esc later', 'muted', colour)].join('\n'));
        // Actions the vendor refused and reported, and a mode the vendor did not give.
        const lastLead = task.runs.findLast(run => run.role === 'lead');
        // What a rule of his or a default answered in this session, kept in its decisions.
        const ruled = [...new Set((task.approvals ?? []).filter(row => row.by && row.rule).map(row => `${row.by === 'rule' ? 'Allowed by your rule' : 'Allowed by default'}: ${row.rule}`))].slice(-3);
        if (ruled.length) lines.push(ruled.map(text => note(text, 'muted')).join('\n'));
        if (lastLead?.permissions === 'auto' && lastLead.effectivePermissions === 'ask') lines.push(note('Asked instead. Approve for me is not available here.', 'muted'));
        // It answered but stayed open for a command it left running: ELU ended that with the turn.
        if (lastLead?.leftRunning && !lastLead.leftSaid && !['running', 'preparing'].includes(task.state)) lines.push(note(`${leadName} had answered, so ELU stopped what it left running: ${lastLead.leftRunning}`, 'muted'));
        // What the last working turn was refused, each with why and what to do: the model's, or
        // the working bot's, such as @lead's. A step in which a never-list command was refused
        // shows whatever the turn went on to say.
        const rows = blockedRows(task);
        if (rows.length) lines.push(rows.map(row => note(row.text, 'orange')).join('\n'));
        // A ! command still running in this session shows the end of its output so far.
        if (shellRun?.session?.id === task.id && shellRun.session.repo.root === repo.root) lines.push(chatMessage({ title: 'Shell', at: shellRun.at, text: [`$ ${shellRun.command}`, shellRun.run.tail(2000).trimEnd()].filter(Boolean).join('\n'), tone: 'green', raw: true }, chatWidth(), colour) + '\n' + ink('Running. /stop ends it.', 'muted', colour));
        if (liveAt >= 0) partKeys[lines.length + liveAt] = `\0live\0${task.activeLog}`;
        // Its long jobs that still run (lib/jobs.mjs), in one line, as its row in Sessions says it.
        { const running = jobsLine(task.jobs, now); if (running) lines.push(note(running, 'blue')); }
        lines.push(...atWork);
        // What the owner sent that the session has not read yet, and was sent after everything
        // above, ends the chat, right above the message box, with nothing under it.
        for (const row of unsent) drawUnsent(row);
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
          // What ELU sent it by itself (lib/elu-sent.mjs) is one line of ELU's, never a message of his.
          // The same words from another computer on the project wait as that computer's message.
          if (sentByElu(row.goal) && !row.computer && !row.origin) { lines.push(note(eluLine(row.goal), 'muted')); continue; }
          // One that waits while no turn works says what for, as lib/waiting.mjs says it (a free slot, a time).
          const words = waitingWords(working ? row : { ...row, reason: waitingText(row) }, { working, goes: goesToTurn(task, row), deaf: answersBeside(task, row), soon: notSaidYet(task, row), stops: task.activeNowStops === true, command: commandRuns(task, repo), readOnly: claim.readOnly, model: leadName });
          const more = row === newest ? [...words.lines, ...(words.keys ? [words.keys] : []), ...(approvalsFor(task).length ? ['The approval above still needs your answer.'] : [])] : words.lines;
          const said = words.answer ? chatMessage({ title: `${words.answer.who} · beside the turn`, at: words.answer.at, text: words.answer.text, tone: 'orange' }, chatWidth(), colour) + '\n' : '';
          const sender = row.bot ? `${typeof row.overseer === 'string' ? requester(row) : row.scheduled ? 'Schedule' : 'You'} → @${row.bot}` : requester(row);
          partKeys[lines.length] = `\0held\0${row.id}`;
          lines.push(chatMessage({ title: `${sender} (${words.tag})`, narrow: `${sender} (${words.short})`, at: row.createdAt, text: requestGoal(row), tone: 'blue', shaded: true }, chatWidth(), colour) + '\n' + (said ? '\n' : '') + said + more.map(text => note(text, 'muted')).join('\n'));
        }
      }
      const current = selectedRequest && (snapshot.queue ?? []).find(row => row.id === selectedRequest.id);
      if (current && ['queued', 'starting', 'running'].includes(current.state)) lines.push(chatMessage({ title: current.bot ? `${typeof current.overseer === 'string' ? requester(current) : current.scheduled ? 'Schedule' : 'You'} → @${current.bot} (queued)` : `${current.scheduleId && !current.origin ? 'Schedule' : requester(current)} (queued)`, at: current.createdAt, text: requestGoal(current), tone: 'blue', shaded: true }, chatWidth(), colour) + '\n' + note(`${waitingText(current)} /stop cancels it.`, 'muted'));
      // A new session another computer asked for, which waits for this computer's yes (asksYes).
      else if (selectedRequest && asksYes(current ?? selectedRequest)) lines.push(chatMessage({ title: `${requester(selectedRequest)}${selectedRequest.bot ? ` → @${selectedRequest.bot}` : ''} (waits for your yes)`, at: selectedRequest.createdAt, text: requestGoal(selectedRequest), tone: 'blue', shaded: true }, chatWidth(), colour) + '\n' + note('In Sessions, r starts it and c removes it.', 'muted'));
      else if (selectedRequest) lines.push(chatMessage({ title: selectedRequest.bot ? `Saved request → @${selectedRequest.bot}` : selectedRequest.origin ? `Saved request from ${requester(selectedRequest)}` : 'Saved request', at: selectedRequest.createdAt, text: requestGoal(selectedRequest), tone: 'blue', shaded: true }, chatWidth(), colour) + '\n' + note([(current ?? selectedRequest).state === 'blocked' && (current ?? selectedRequest).reason, 'Send it to retry. /stop cancels it.'].filter(Boolean).join(' '), 'muted'));
      // Asked before the new text is set: lines that arrive below must not read as scrolling up.
      const chatNow = view === 'chat' ? `${controller?.repo.root ?? ''}\0${selectedId ?? selectedRequest?.id ?? following?.id ?? ''}` : view === 'tasks' ? `row\0${boardLines[barAt]?.row?.key ?? ''}` : null;
      const held = chatNow !== null && chatNow === chatShown && (sized ? !sized.end : scrolledUp(activity)), heldAt = () => sized?.place ?? partAt(activity, partsShown);
      chatShown = chatNow;
      // A session here is held by its parts, as one on another computer is: each entry by its
      // key, each line under them by its first row. Entries that leave the top or land above,
      // and a part that grows above, leave the lines he reads where they are.
      if (view === 'chat') {
        const seen = new Map(), parts = lines.map((text, index) => { const name = partKeys[index] ?? entryKeys[index] ?? `\0${text.split('\n')[0]}`, count = seen.get(name) ?? 0; seen.set(name, count + 1); return { key: `${name}\0${count}`, text }; });
        const place = held ? heldAt() : null;
        setChat(lines);
        if (place) keepPart(activity, place, parts);
        partsShown = parts;
      }
      // Sessions, on a row that is not a session: the row's own text, and how to start when there is nothing yet.
      else if (view === 'tasks') {
        // A session of another project shows once that project is the active one. Until then the pane is empty.
        // A schedule with no run in the list shows its Schedule tab (drawSessionViews).
        const row = boardLines[barAt]?.row, card = row && !['remote', 'schedule'].includes(row.kind) && !sessionOf(row) && rowCard(row, now);
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
          // The headings of its agents' replies: a click on one says where they are changed.
          agentHeads = parts.flatMap(part => part.head ? [{ ...part.head, there: row }] : []);
        } else setChat([row && !card ? '' : card ? `${chatBlock({ title: card.title, text: blockText(card.text, { trusted: row.kind === 'peer' && row.item?.trusted === true }), tone: card.tone, width: chatWidth(), colour, markdown: row.kind === 'peer' && ['answer', 'held', 'draft'].includes(row.item?.kind) })}\n\n${ink(keyRows(card.keys, chatWidth()).join('\n'), 'muted', colour)}`
          : note(dash.projects.length ? 'Type below to start a session, or press n to set it up first.' : 'No project yet. Press n to create one here. n in the Projects tab opens another folder.', 'muted')]);
      }
      // The message box says where the text goes, and which bots are in the chat.
      const target = sessionBox() && goalTarget(), inChat = task ? botsOf(task) : form ? composeBots : [], withBots = inChat.length ? ` · with ${botNames(inChat)}` : '';
      // The model the text goes to: the open session's, else the one a new session starts with.
      // Text that starts with a saved bot's @name is written to that bot.
      // With Auto model on it reads Auto model: the model changes with the step, and each reply's header names the one that wrote it.
      const autoBox = Boolean(controller) && (task ? autoOn(task) : form ? formAuto() : !sessionBox() && selectedRequest ? selectedRequest.auto === true : sessionBox() && autoStart());
      const toModel = !controller ? null : autoBox ? AUTO_NAME : task ? workingModel(task) : nameOf((form ? composeModel : !sessionBox() && selectedRequest?.model) || controller.defaultModel());
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
      // A message that starts with ! is a shell command; the label says where it runs.
      // While a held reply is edited the box holds its text, whatever that starts with.
      const said = (replyNow() ? fits(`Reply to ${replying.who}`, ' · Enter sends it · Esc cancels')
        : view === 'chats' && heldEdit ? ` Edit the ${heldEdit.result ? 'result for' : 'reply to'} ${heldEdit.who} · Enter sends it · Esc leaves it held `
        : ask.getValue().trimStart().startsWith('!') ? ` Run in ${clip(shortHome(shellPlace().cwd), 40)} · Enter runs it `
        : view === 'chats' ? !chatOpen ? ' Ask your team, or @name one member ' : chatOpen.type === 'room' ? ` Message #${chatOpen.name} · the first ${takers(chatOpen)} to take it answers ` : chatOpen.type !== 'bot' ? ` Message ${peerName(chatOpen.name, chatOpen.key)} ` : chatOpen.peer ? ` Message @${chatOpen.name} on ${botHome(chatOpen)} · runs after ${peerName(chatOpen.owner, chatOpen.peer)} accepts it ` : ` Message @${chatOpen.name} · it answers in its own session `
        : toBot ? ` Message @${toBot} `
        : stays ? fits(`Message @${stays}`, ` · @model writes to ${toModel}`)
        // A long name gives up New session on first, then its own end.
        : toMachine ? fits(`New session on @${toMachine}`, ' · shared project')
        : toPerson ? ` Ask @${toPerson} · teammate `
        : remoteHere() ? remoteApp.label(remoteHere(), ask.width - 4, ask.getValue())
        : sessionBox() && view === 'tasks' && teamNow() ? fits(`New session · ${teamNow().name}`, ' · Enter asks which folder here it is')
        : sessionBox() ? target ? toModel ? fits(`New session → ${toModel}`, ` · ${projectName(target)}`) : ` New session · ${projectName(target)} ` : ' New session · Enter creates a project first '
        : view === 'kanban' && sharedNow() ? sharedLabel(sharedNow(), ask.width - 4)
        : view === 'kanban' && thereNow() ? fits('Add a task to To do', ` · ${thereNow().project}`)
        : view === 'kanban' && !viewOnly() ? controller ? ` Add a task to To do · ${snapshot.name} ` : ' Create a project first: n in the Projects tab '
        // A Standup session: its model has every update, and @everyone asks the same sessions again.
        : task?.standup && view === 'chat' && !claim.readOnly ? fits(`Message ${toModel}`, ` · ${standupHas(task)}`, ' · @everyone asks them all again')
        : claim.readOnly ? viewOnlyLabel(ask.width - 4) : composing() ? composeWhen ? fits(`Schedule → ${toModel}`, ` · ${composeWhen.label}`, ` · ${snapshot.name}`, withBots) : fits(`New session → ${toModel}`, ` · ${teamNow()?.name ?? snapshot.name}`, withBots) : mode ? fits(`Message ${toModel}`, ` · ${LABELS[mode]}`, withBots) : fits(`Message ${toModel}`, withBots));
      // The label is plain text, but for the bots it names: each in its own colour.
      const named = withBots && said.endsWith(`${withBots} `) ? said.length - withBots.length - 1 : said.length;
      ask.setLabel(blessed.escape(said.slice(0, named)) + (named < said.length ? ` · with ${paintBots(botNames(inChat))} ` : ''));
      const typing = screen.focused === ask;
      ask.style.border.fg = typing ? accent : shade('border'); ask.style.label.fg = typing ? accent : muted;
      // Status row: the last message, else what the open task is doing. The key bar below never hides it.
      const card = kanbanLists.includes(screen.focused) && kanbanData[kanbanLists.indexOf(screen.focused)]?.items[screen.focused.selected ?? 0];
      // One that waits for a Claude account to reset says only that: its line is its state.
      const quiet = card ? [card.title, card.note ?? card.detail].filter(Boolean).join('  ·  ') : task ? [task.state === 'needs_input' ? 'waiting for your answer' : resetWait(task) ? null : stateText(task), stopLine(task, { goesOn: resetWait(task), other: otherWait(task) })?.action, snapshot.requests?.length ? `${snapshot.requests.length} saved` : ''].filter(Boolean).join(' · ') : '';
      // The last message shows whole: it wraps onto as many rows as it needs, which the pane above
      // gives up, to at most half of that pane. What the open session is doing wraps the same way.
      // A lead that waits for an allow or deny says so here first, with the keys before the
      // command so a narrow row still shows them. The last message goes below it.
      const asked = task ? approvalsFor(task)[0] : null;
      // A dialog over the status rows would hide what its own keys just said (a bot's page at
      // 80x24 hid "@name does not run by itself."): the rows then go to the foot of the message
      // box, inside its border and beside the list, as always. Put right under the dialog, a long
      // message ran across the list and over the box's border. The dialog stays where it is: a
      // message that comes while one of its rows is clicked (a double click copies a word) does
      // not move that row from under the pointer. It moves up only as far as it reaches into
      // those rows. With no message the rows stay where they are, behind it.
      const middle = modal ? modalPlace() : null;
      const beside = sided ? barWidth(W) : 0;
      Object.assign(status, { left: beside + 1, width: W - beside - 2 });
      shownTook(now);
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
      const cut = most => words.length > most ? [...words.slice(0, most - 1), fitWords(words.slice(most - 1).join(' '), Math.max(8, statusRoom - 2))] : words, rowsOf = lines => Math.max(1, (needs === null ? 0 : 1) + lines.length);
      let statusLines = cut(Math.max(2, Math.floor((g.statusTop - g.top) / 2) - (needs === null ? 0 : 1)));
      const over = middle && message && middle.top <= g.statusTop && middle.top + middle.height > g.statusTop - rowsOf(statusLines) + 1 ? modal : null;
      // Under a dialog the rows are the box's own, over its bottom border: the ones under the text
      // in it, so a draft there shows whole, and as the dialog leaves once it stands at the top of
      // the screen. Where that leaves fewer than it needs, the line says it in fewer words (it shows
      // whole once the dialog closes); only a draft that fills the box gives its last row to the line.
      const typed = over && ask.getValue() ? Math.min(g.askHeight - 2, Math.max(0, (ask._clines?.length ?? 1) - (ask.childBase ?? 0))) : 0;
      const foot = g.keysTop - 1, free = over ? foot - Math.max(g.askTop + 1 + typed, middle.height) : 0;
      if (over && rowsOf(statusLines) > free) statusLines = cut(Math.max(1, free - (needs === null ? 0 : 1)));
      status.setContent([...(needs === null ? [] : [ink(needs, 'orange', colour, true)]), ...statusLines.map((row, at) => message ? ink(`${at ? '  ' : '› '}${row}`, 'text', colour) : ink(row, 'muted', colour))].join('\n'));
      status.said = [...(needs === null ? [] : [ink(needs, 'orange', colour, true)]), ...(message ? [ink(`› ${message}`, 'text', colour)] : needs !== null ? [] : [ink(words.join(' '), 'muted', colour)])].join('\n');
      const tall = rowsOf(statusLines);
      Object.assign(status, over ? { top: foot - tall, height: tall } : { top: g.statusTop - tall + 1, height: tall });
      if (over) status.setFront();
      if (modal) Object.assign(modal, { ...middle, top: over ? Math.max(0, Math.min(middle.top, status.top - middle.height)) : middle.top });
      // The rows it takes come from the pane above it, in every view: the others are laid out again.
      const lift = over ? 0 : tall - 1;
      activity.height = compose.height = g.statusTop - g.top - lift;
      if (lift !== lifted) { lifted = lift; again = true; }
      // Rows that only moved are drawn too: the frame below compares what the panels say, not where they are.
      const placed = [status.left, status.top, status.width, status.height, over?.top, over?.height].join();
      if (placed !== statusPlaced) { statusPlaced = placed; lastFrame = null; }
      drawSessionViews(task);
      keysBar.setContent(keyHints(withThreadsPage(barPairs()), W - 2, colour));
      for (const list of [board, composeList, scheduleList, ...teamLists, botsList, projectsList, usageList]) Object.assign(list.style.selected, screen.focused === list ? selection : QUIET);
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
      onRender?.({ screen, selection: mouseSelection, snapshot, panels: { header, brand, pills, tabs, newCard, kanbanPick, newBot, newProject, kanbanBoxes, kanbanLists, kanbanOff, kanbanTeam, back, board, boardBox, compose, composeList, composeHint, activity, chat: activity, changes: changesBox, artifacts: artifactsBox, schedule: scheduleBox, scheduleList, sessionTabs, status, keys: keysBar, palette, ask, teamBoxes, teamLists, teamOff, botsBox, botsList, projectsBox, projectsList, usageBox, usageList }, controller, view: listed() ? 'tasks' : view, session: view !== 'chat' ? null : selectedId ?? (composing() ? 'new' : 'request'), sessionView: !scheduleBox.hidden ? 'schedule' : !artifactsBox.hidden ? 'artifacts' : changesBox.hidden ? 'chat' : 'changes' });
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
  // while the list changes. A project is one on all my computers: its row counts its sessions
  // on each of them too, as Sessions shows them under it (remoteApp.counts).
  function drawProjects() {
    const width = Math.max(20, projectsList.width - 2), kept = projectRows[projectsList.selected ?? 0]?.root, now = Date.now();
    const top = controller?.repo.root;
    // After this machine's projects: those of my other computers that Sessions does not show, as "<project> on <name>",
    // then those a teammate shares that this computer does not have.
    const away = remoteApp.projects(now, top), there = remoteApp.counts(now, snapshot.projects.filter(project => !project.unavailable).map(project => project.root));
    projectRows = [...[...snapshot.projects].sort((a, b) => (b.root === top) - (a.root === top)), ...away, ...sharedRows(away, now, top)];
    const lastActivity = (project, also = null) => {
      const times = [...project.activity.map(row => row.at), ...project.tasks.map(task => task.createdAt), also].map(value => Date.parse(value)).filter(Number.isFinite);
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
      // The project of a team this computer is on, with no folder here yet: a project of its own,
      // by its name, with its sessions on the team's computers.
      if (project.shared && project.team) {
        const far = remoteApp.teamCount(project.team, now), n = far.sessions, ago = far.last ? relativeTime(far.last, now) : 'no activity';
        const count = `${n} session${n === 1 ? '' : 's'}`, where = far.on.length ? `${count} · ${far.on.map(row => `${row.sessions} on @${row.name}`).join(', ')}` : count;
        const tail = [where, count].find(text => width - 26 - widthOf(text) - 2 - widthOf(ago) - 2 >= 12) ?? count, line = padEnd(tail, Math.max(13, widthOf(tail) + 2)) + ago, room = Math.max(4, width - 26 - widthOf(line) - 2);
        return ink(`  ${padEnd(clip(project.name, 22), 24)}`, 'text', colour, true) + ink(padEnd(clip('no folder here yet', room), room + 2), 'muted', colour) + ink(line, 'muted', colour);
      }
      // A project a teammate shares: its name, who shares it and where it is. It is not on this computer.
      if (project.shared) {
        const tail = project.online ? 'online' : 'offline', room = Math.max(4, width - 26 - tail.length - 2);
        return ink(`  ${padEnd(clip(project.name, 22), 24)}`, 'blue', colour, true) + ink(padEnd(clip(`${project.by}   on ${project.box}`, room), room + 2), 'muted', colour) + ink(tail, 'muted', colour);
      }
      const active = project.root === controller?.repo.root, name = ink(`${active ? '●' : ' '} ${padEnd(clip(project.name, 22), 24)}`, active ? 'orange' : 'text', colour, true);
      if (project.unavailable) return name + ink('unavailable', 'muted', colour);
      // Where they run, when the whole row still fits with the folder whole beside it (or in 20
      // columns): "22 sessions · 22 on @devbox". spare: the columns left for the folder beside a tail.
      const far = there.get(project.root), sessions = project.tasks.filter(task => !project.closed?.includes(task.id)).length + (far?.sessions ?? 0), ago = lastActivity(project, far?.last);
      const count = `${sessions} session${sessions === 1 ? '' : 's'}`, folder = shortHome(project.root), tailOf = text => padEnd(text, Math.max(13, widthOf(text) + 2)) + ago, spare = tail => width - 26 - widthOf(tail) - 2;
      const where = far?.on.length ? tailOf(`${count} · ${far.on.map(row => `${row.sessions} on @${row.name}`).join(', ')}`) : null;
      const tail = where && spare(where) >= Math.min(widthOf(folder), 20) ? where : tailOf(count), room = tail === where ? spare(where) : Math.max(4, spare(tail));
      return name + ink(padEnd(clip(folder, room), room + 2), 'muted', colour) + ink(tail, 'muted', colour);
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
    const at = usageList.selected ?? 0, width = Math.max(20, usageList.width - 2), kept = usageRows[at], keptId = usageIds[at];
    const spend = agentSpend(snapshot.projects, { now, days: usagePeriod });
    usageRows = [...(usageData ? usageBlocks(usageData, { now: new Date(now), checks: usageChecks, reading: usageBusy, width, opened: usageOpen }) : [{ vendor: null, text: READING_VENDORS, tone: 'muted' }]), ...topAgentRows(spend, width, now)];
    usageIds = usageRowIds(usageRows);
    // An account's line is drawn in its parts when it fits, else cut to the pane in one tone.
    const lines = usageRows.map(row => row.parts && widthOf(plain(row.text)) <= width ? row.parts.map(part => { const text = ink(plain(part.text), part.tone, colour, part.bold); return part.inverse ? `{inverse}${text}{/inverse}` : text; }).join('') : ink(clip(row.text, width), row.tone, colour, row.bold));
    if (lines.join('\n') !== usageList.ritems?.join('\n')) usageList.setItems(lines);
    // The selected line stays the line it was (usageRowIds), wherever a reading put it: an
    // account that opened or closed over it adds lines or takes some away, and Enter must still
    // act on the line the cursor was on. One that is gone gives way to its account's first line,
    // else its vendor's. A line with nothing to choose (the summary, a rule, a heading, the one
    // that says the vendors are being read) holds no cursor: from the summary or a rule it goes
    // to the nearest line that can be chosen, so the tab opens on its first account.
    const same = row => row.vendor === kept.vendor && row.login === kept.login, chosen = row => Boolean(row?.vendor || row?.agent || row?.none), from = Math.max(0, Math.min(at, usageRows.length - 1));
    const held = !chosen(kept) ? -1 : [usageIds.indexOf(keptId), ...(kept.vendor ? [same, row => row.vendor === kept.vendor].map(test => usageRows.findIndex(test)) : [])].find(index => index >= 0) ?? -1;
    const found = held >= 0 || !(usageRows[from]?.summary || usageRows[from]?.rule) ? held : [usageRows.findIndex((row, place) => place > from && chosen(row)), usageRows.findLastIndex((row, place) => place < from && chosen(row))].find(index => index >= 0) ?? -1;
    usageList.select(found >= 0 ? found : Math.max(0, Math.min(at, usageRows.length - 1)));
  }
  // Top agents: up to ten, most cost first, from this computer (here) and each other computer
  // that sends its own (remoteApp.agents: an ELU up to 0.1.33). An agent that did not start is
  // always among them (topRows). The table (lib/agent-spend.mjs) has a header, a rule, a line
  // per agent, and under the Cost column the period's total: every computer shown, and each
  // one's part when there is more than one. One of those that is offline now is named in those
  // parts; one on a build before 0.1.20 counts a session's total again for each turn, and its
  // part says older ELU. A row's share is of that total.
  function topAgentRows(spend, width, now) {
    const rows = spend.rows.map(row => ({ ...row, where: 'here', open: { root: row.root, id: row.taskId } }));
    const parts = [{ name: 'here', costUsd: spend.costUsd, partial: spend.partial, runs: spend.runs }];
    let peers = [];
    try { peers = remoteApp.agents(now); } catch { peers = []; }
    for (const { machine, top, offline: away } of peers) {
      if (away) { parts.push({ name: machine.name, note: 'offline' }); continue; }
      if (!top) continue;
      const period = usagePeriod === 1 ? top.today : top.week;
      // own is false only for a list a build before 0.1.20 sent; one saved before this build read that word says nothing yet.
      parts.push({ name: machine.name, costUsd: period.costUsd, partial: period.partial, runs: period.runs ?? (period.rows.length ? null : 0), ...(top.own === false ? { old: true } : {}) });
      for (const row of period.rows) rows.push({ ...row, where: machine.name, open: { machine: machine.key, project: row.ref.split(':')[0], id: row.id } });
    }
    const total = usageTotal(parts, usagePeriod === 1 ? 'Today' : '7 days');
    const top = topRows(rows), out = [{ vendor: null, text: '' }, { vendor: null, text: usagePeriod === 1 ? 'Top agents today' : 'Top agents, last 7 days', tone: 'text', bold: true }];
    if (!top.length) {
      out.push({ vendor: null, text: usagePeriod === 1 ? 'No agent has run today.' : 'No agent has run in the last 7 days.', tone: 'muted', none: true });
      // The computers of mine it could not count, as the total names them.
      const away = parts.filter(part => part.note);
      if (away.length) out.push({ vendor: null, text: away.map(part => `${part.name} ${part.note}`).join(' · '), tone: 'muted' });
      return out;
    }
    const table = agentTable(top, { width, total: total.costUsd ?? 0, foot: total });
    out.push({ vendor: null, text: table.head, tone: 'muted' }, { vendor: null, text: table.rule, tone: 'muted' },
      ...table.rows.map((text, at) => ({ vendor: null, text, tone: 'text', agent: top[at], key: `agent:${top[at].open.machine ?? top[at].open.root}\0${top[at].open.id ?? top[at].ref}\0${top[at].agent}` })),
      ...table.foot.map((text, at) => ({ vendor: null, text, tone: at ? 'muted' : 'text' })));
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
  // every line of a vendor; a adds an account, x forgets one, r checks again now. f folds an
  // account with several limits to its tightest one, or unfolds it to a line for each.
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
    if (action === 'up') return moveAccountUp(row, line);
    if (action === 'fold') { if (line.flips) { usageOpen.set(`${vendor}\0${line.login}`, !line.open); draw(); } return; }
    if (action === 'open' && line.setting) return flipSetting(row, line.setting);
    if (action === 'open' && line.login) return useAccount(row, line.login);
    await prompt(`${USAGE_NAMES[vendor]} usage`, usageDetailLines(row, new Date()).join('\n'), '', { read: true });
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
    // A Claude account chosen by hand is in use whatever limit it was marked with, and a session
    // that waits for an account to reset tries it now (lib/claude-switch.mjs).
    if (item.active && !(row.vendor === 'claude' && (item.spentUntil || item.needsSignIn))) return setMessage(`New ${name} turns already use ${item.account}.`);
    useLogin(row.vendor, login); if (row.vendor === 'claude') { try { notePicked(login); } catch { /* The account is in use all the same. */ } } forgetVendors(); usageData = null;
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
  // u: a Claude account goes one place up the order the switching tries them in.
  function moveAccountUp(row, line) {
    if (!row.switches) return setMessage(row.vendor === 'claude' ? 'Add another Claude account first: a adds one.' : 'Only Claude accounts have an order.');
    const item = row.accounts?.find(account => account.login === line?.login);
    if (!item?.account) return setMessage('Select an account to move up.');
    moveUp(item.login, row.accounts.filter(account => account.account).map(account => account.login)); usageData = null;
    setMessage(row.accounts.indexOf(item) > 0 ? `${item.account} moved up.` : `${item.account} is first.`); draw();
  }
  // Enter on a setting of Claude's accounts turns it on or off.
  function flipSetting(row, setting) {
    const on = !row.switches?.[setting];
    if (setting === 'auto') setAuto(on); else setExtraUsage(on);
    usageData = null; setMessage(setting === 'auto' ? on ? 'Claude accounts switch by themselves.' : 'Claude accounts switch only when you pick one.' : on ? 'An account at its limit goes on with paid extra usage.' : 'Paid extra usage is not used.'); draw();
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
      // A session that waits for a Claude account to reset tries the new one.
      if (vendor === 'claude') { try { wakeNow(); } catch { /* It tries when the first one resets. */ } }
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
    if (forgot?.keychainLeft) await prompt(`Forgot ${shown}`, `The Keychain kept its sign-in. Delete "${forgot.keychainLeft}" in Keychain Access.`, '', { read: true });
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
    // And when the box gets its first character, or loses its last: Enter is named only once there is something to send.
    const filled = Boolean(value.trim());
    if (filled !== filledShown) { filledShown = filled; if (!drawing) scheduleDraw(); }
    // The key bar changes when a message is brought back into the box, walked, changed or cleared.
    const walk = recallKeys().join();
    if (walk !== recallShown) { recallShown = walk; if (!drawing) scheduleDraw(); }
  }
  // Whether Enter on the marked choice fills it in and keeps going, as Tab does, instead of
  // running it (the message box's Enter): a bot's whole @name, typed out, is sent as it is.
  function paletteFills() {
    const chosen = paletteValues[palette.selected ?? 0];
    return Boolean(chosen?.more) && !(view !== 'chats' && chosen.value.startsWith('@') && ask.getValue().trim() === chosen.value);
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
  // Whether Auto model is on in view: for the open session, else for the form's new one.
  const autoNow = () => { if (!controller) return false; const task = openTask(); return task ? autoOn(task) : composing() && formAuto(); };
  // A sentence as a row of the command list says it: without its full stop.
  const rowText = line => String(line).replace(/\.$/, '');
  const paletteContext = {
    // The open session's model, as @model reaches it; null where no session is open.
    model: () => { const task = view === 'chat' && controller && selectedId && !selectedRequest ? (snapshot?.tasks ?? []).find(row => row.id === selectedId) : null; return task ? autoOn(task) ? AUTO_NAME : modelOf(task) : null; },
    // Auto model, the first row of /model, where a vendor installed here can have it: what the
    // row says, whether it is in use, what it means after /model computer, and where /model
    // auto quick can send quick questions (a vendor installed here that has a fast model).
    auto: () => !autoOffered() ? null : {
      note: AUTO_LINES.listNote, current: autoNow(), computer: rowText(AUTO_LINES.computerOn),
      quick: [...['grok', 'claude', 'codex'].filter(vendor => installedVendors().includes(vendor)), ...QUICK_WORDS].map(target => ({ word: target, description: rowText(AUTO_LINES.quickSet(target)) })),
    },
    // The models a session can be given, with a mark on the one in use. Each vendor's own
    // list is read beside the app, never held for it: the names known now show at once, and
    // the list is drawn again when a vendor has printed its own.
    models: () => { readAllModels().then(fresh => { if (fresh && !closing) { syncPalette(); draw(); } }, () => {}); const choices = modelChoices(), now = modelNow(), current = now && !autoNow() ? choiceName(now, choices) : null; return choices.map(row => ({ name: row.name, vendor: row.vendor, note: row.note, current: row.name === current })); },
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
  // A text of a project that he changed on two of his computers is said once: which one is in
  // use, and where the other is kept (lib/peer/notes.mjs). One from the 10 minutes before the app
  // opened is said too.
  let notesShown = Date.now() - 600000;
  function notesTick() {
    if (closing || typeof facade?.notesSaid !== 'function') return;
    const said = facade.notesSaid(notesShown); if (!Array.isArray(said) || !said.length) return;
    notesShown = Math.max(...said.map(row => row.at)); setMessage(said.map(row => row.text).join(' '));
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
    const answer = (await prompt('Permissions', body, '', { keys: [...choices.map((_, index) => String(index + 1)), 'r'], bar: [[choices.map((_, index) => String(index + 1)).join(' '), 'choose'], ['r', 'without asking']] }))?.trim().toLowerCase();
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
    const answer = (await prompt('Runs in', body, '', { keys: ['1', '2', '3'], bar: [['1 2 3', 'choose']] }))?.trim().toLowerCase();
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
  // the compose form in one dialog, each its key, its name and its value alone; 1 to 3 change
  // a row, as the line under them says, and Enter starts it. named: the message
  // of a trusted sender, whose folders are offered as the picked mode takes them: Full access
  // offers every folder it names, and a lower mode only the ones it may read. null when cancelled.
  async function workPicker({ named = null } = {}) {
    const offer = mode => named === null ? [] : foldersNamed(named, { mode });
    // own: he changed the Folders row himself, so the message no longer decides it.
    let mode = defaultMode(), place = { kind: 'worktree' }, folders = offer(mode), own = false;
    for (;;) {
      const rows = [`1  Permissions  ${LABELS[mode]}`, `                ${MODE_TEXT[mode]}`,
        `2  Runs in      ${placeText(place)}`, `                ${placeHint(place)}`,
        `3  Folders      ${folders.length ? `${folders.map(shortHome).join(' ')}${own ? '' : '  from their message'}` : 'none'}`, '                Other folders it may read.'];
      const answer = (await prompt('Accept', [...rows, '', '1, 2 or 3 changes a row. Enter starts it as your session. Esc leaves it waiting.'].join('\n'), '', { keys: ['1', '2', '3'], bar: [['1 2 3', 'change a row'], ['enter', 'start it'], ['esc', 'leave it waiting']] }))?.trim();
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
    // With no letter named, the dialog is only to read. bar: what its letters do, for the key bar.
    const keyed = async (title, body, keys = [], { preselect = '', trusted = false, live = null, bar = null, markdown = false } = {}) => {
      const typed = String(await prompt(title, body, preselect, { keys, preselect, trusted, live, bar, read: !keys.length, markdown }) ?? '').trim().toLowerCase();
      if (keys.includes(typed)) return typed;
      if (typed && keys.length) throw new Error(`Nothing was done. Press ${keys.join(' or ')}.`);
      return null;
    };
    if (value.type === 'member') {
      // Another computer of mine says so in its title, and while it has not marked this one back, whose agreement it waits for and what to type there.
      // A computer that says it is mine and is not marked here says so, and the two ways to agree. Either says once why GitHub did not pair the two, when GitHub can say.
      const trusted = value.trusted ?? peerTrusted(value.key), mine = value.self ? null : remoteApp.yours().get(value.key) ?? null, shown = peerName(value.name, value.key), { holdReplies: hold, autoContinue: auto } = peerPolicyOf(value.key);
      const asks = value.self || mine ? null : remoteApp.asking().get(value.key) ?? null, github = mine?.waiting || asks ? remoteApp.githubNote(value.key) : null;
      const agree = mine?.waiting ? [`Waiting for ${shown} to agree: run /mine @${remoteApp.self()} there.`, ...(github ? [github] : []), ''] : asks ? [remoteApp.saysMine(asks.name), ...(github ? [github] : []), ''] : [];
      return keyed(`${mine ? 'Your computer' : 'Teammate'} ${shown}${mine?.waiting ? ' · waiting for it to agree' : asks ? ' · says it is your computer' : ''}`, [...agree, `Key: ${value.key}`, `Fingerprint: ${text(value.member.fingerprint)}`, `Team: ${text(value.team?.name)}`, `Role: ${text(value.member.role)}`, `State: ${value.self ? 'you' : reachText({ ...value.member, via: text(value.member.via) }, { whole: true })}`, `Last seen: ${relativeTime(value.member.lastSeen)}`, ...(value.self ? [] : [trusted ? 'Trust: trusted · paths go out as they are.' : 'Trust: not trusted · paths go out as [path].',
        hold ? `Hold replies: on · each reply and result to ${mine ? 'that computer' : 'them'} waits for you to send it.` : `Hold replies: off · your replies and results go to ${mine ? 'it' : 'them'} when ready.`,
        auto ? `Auto-continue: on · ${mine ? 'its' : 'their'} answer or result continues the chat you asked from.` : `Auto-continue: off · ${mine ? 'its' : 'their'} answers wait in ${mine ? 'its' : 'their'} thread.`,
        '', `${trusted ? 't removes trust' : mine ? 't trusts it' : 't trusts them'} · h ${hold ? 'stops holding replies' : 'holds replies'} · o turns auto-continue ${auto ? 'off' : 'on'}`])].join('\n'), value.self ? [] : ['t', 'h', 'o']);
    }
    if (value.type === 'agent') return keyed(`Sessions of ${peerName(value.name, value.peer)}`, value.row ? [`${text(value.row.handle)} ${text(value.row.label)}`, text(value.row.now), '', 'Overlap with your work:', ...(value.row.overlap ?? []).map(text), '', 'Changed files:', ...(Array.isArray(value.row.files) ? value.row.files.slice(0, 200).map(text) : [])].join('\n') : 'No live sessions.');
    // Any message is accepted the same way: it runs as the owner's session.
    // An answer or a result the chat already went on with is only read: c has nothing left to do.
    const [hint, keys, preselect, bar] = value.kind === 'answer' && value.continued === true ? [wentOn(value), [], ''] : value.kind === 'answer' ? [`c continues in the chat with this ${value.result ? 'result' : 'answer'}.`, ['c'], '', [['c', 'continue']]] : value.kind === 'incoming' ? ['y starts it now, as if you typed it. w picks the mode first. n declines.', ['y', 'w', 'n'], 'y', [['y', 'start it'], ['w', 'pick the mode'], ['n', 'decline']]] : value.kind === 'held' ? ['y sends. e edits it first. n discards.', ['y', 'e', 'n'], '', [['y', 'send'], ['e', 'edit first'], ['n', 'discard']]] : value.kind === 'draft' ? ['y sends. n discards.', ['y', 'n'], '', [['y', 'send'], ['n', 'discard']]] : ['', [], ''];
    // The thread reads like a chat: who said what, oldest first, from the thread's log.
    const logged = () => { try { return value.threadId && typeof facade?.threadMessages === 'function' ? facade.threadMessages(value.threadId) : []; } catch { return []; } }, messages = logged();
    const TAG = { ask: 'question', review: 'review', handoff: 'task', answer: 'answer', held: 'answer', blocked: 'answer' };
    const head = m => [`${TAG[m.kind] === 'answer' ? '↳ ' : ''}${m.from === 'peer' ? peerName(m.name, m.peer) : m.held ? 'your model' : 'you'}`, m.held && value.result ? 'result' : TAG[m.kind] ?? text(m.kind), ...(m.held ? [m.blocked ? 'held: possible secret' : 'not sent yet'] : []), clockTime(m.at)].join(' · ');
    // A model's answer is drawn as Markdown; a message a person wrote, and every line of the app's
    // own, shows as written.
    const shownAs = (words, model = false) => model || !words ? words : asWritten(words);
    const talkOf = list => list.length ? list.flatMap(m => m.from === 'note' ? [shownAs(`(${text(m.text)})`), ''] : [shownAs(head(m)), shownAs(text(m.text), TAG[m.kind] === 'answer'), '']) : [shownAs(text(value.text), ['answer', 'held', 'replied', 'draft'].includes(value.kind)), ''], talk = talkOf(messages);
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
    const page = (said, last) => [...(about ? [shownAs(`Project: ${about}`), ''] : []), ...said, ...last.map(line => shownAs(line)), shownAs(hint)].join('\n').trimEnd();
    // A message of mine that is still on its way is read again while its thread is open: the line says where it is now, then that it was answered or why it failed.
    const tail = value.kind === 'asked' && messages.length && typeof value.id === 'string' && value.id.includes(':') ? value.id.slice(value.id.indexOf(':')) : null;
    const live = tail ? () => { const now = peerList('peerItems').find(row => typeof row?.id === 'string' && row.id.endsWith(tail) && ['asked', 'answer', 'rejected', 'expired'].includes(row.kind)), lines = now ? placed(now) : null; return lines ? page(talkOf(logged()), lines) : null; } : null;
    return keyed(`Thread with ${threadWho(value)}`, page(talk, end), keys, { preselect, trusted: value.trusted === true, live, bar, markdown: true });
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
  // A bot that oversees my sessions is never offered: teammates never reach it (botShareable).
  const botsLine = () => {
    if (!myBots().some(botShareable)) return '';
    const shared = myBots().filter(bot => bot.shared && botShareable(bot)).map(bot => `@${bot.name}`);
    return shared.length ? `Teammates can write to ${shared.join(', ')}.` : 'No bot is shared, so a teammate’s message comes to you.';
  };
  async function shareBots() {
    const bots = myBots().filter(botShareable); if (!bots.length) return '';
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
    // Auto in a project that is the home folder is asked for in so many words, once: only his y
    // lets what another computer on the project asks start there by itself (home on the team's row).
    const handling = HANDLING_ROWS[picked.index][0], atHome = handling === 'auto' && Boolean(controller) && isHomeFolder(controller.repo.root);
    const home = atHome && (current?.home === true || await yes('Home folder', HOME_AUTO_QUESTION, 'y yes · n no'));
    return { handling, rules: rules.trim(), ...(home ? { home: true } : {}) };
  }
  // Saved with the open project as the one teammates' sessions run in. A project that cannot
  // be that (the home folder, unless he allowed it: home) is left out, and the rest is still
  // saved: noProject says why, and the status line each command ends with carries it (projectNote).
  function saveAccess(teamId, { handling, rules, home = false }) {
    if (typeof facade?.saveTeamAccess !== 'function') return { saved: null, noProject: null };
    const root = controller ? controller.repo.root : undefined;
    try { return { saved: facade.saveTeamAccess(teamId, { handling, rules, ...(root ? { root } : {}), ...(root && home ? { home: true } : {}) }), noProject: null }; }
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
    // Auto with no project saved starts nothing by itself: the line says what happens, not what was picked.
    const now = current ? `${current.handling === 'manual' ? 'Manual' : current.root || current.home ? 'Auto' : 'Auto, no project saved: messages wait'} · rules: ${current.rules ? fitWords(current.rules.replace(/\s+/g, ' '), 60) : 'none'}${current.root ? ` · ${shortHome(current.root)}` : current.home ? ' · ~' : ''}` : 'Manual · rules: none';
    setMessage(`${remote(team.name, 40) || 'Team'} now: ${now}`); draw();
    const asked = await accessQuestions(current, { existing: true, team });
    if (!asked) { setMessage('Nothing was changed.'); return; }
    const { saved, noProject } = saveAccess(team.id, asked);
    setMessage(`Saved for ${remote(team.name, 40) || 'the team'}: ${saved?.handling === 'manual' ? 'messages wait for you to approve them' : 'messages start sessions here, as if you typed them'}${saved?.rules ? ', with your rules' : ''}${saved?.root ? ` in ${shortHome(saved.root)}` : saved?.home ? ' in your home folder' : ''}.${projectNote(noProject)}`);
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
  // toModel: he wrote it to @model, so it goes to the model there, as written there.
  async function remoteSubmit(here, machine, text, toModel = false) {
    const name = machine?.name ?? here.machine;
    if (!text) { ask.setValue(`@${name} `); setMessage(`Write the message after @${name}.`); focusInput(); return; }
    // Files or folders on this computer that the message names are offered to go with it (y/n).
    if (here) { setMessage(await remoteApp.send(here, text, { ...filesAsked, toModel })); ask.clearValue(); focusInput(); return; }
    const form = composing(), settings = form ? { permissions: formMode(), place: composePlace, model: composeModel, bots: composeBots } : { permissions: defaultMode(), place: { kind: 'worktree' }, model: null, bots: [] };
    // Auto model is that computer's to set: a session started there from here starts without it, and the line says so.
    const autoHere = form ? formAuto() : autoStart();
    // Files or folders on this computer that it names are offered to go with it too (y/n), as a
    // dropped picture: the session there reads them from its first turn. n sends the text alone;
    // Esc starts nothing, and the message stays in the box as typed.
    const offer = facade?.offerFiles?.(text) ?? null, kept = 'Nothing was sent. The message is still here.';
    let files = null;
    if (offer?.refused) { if (!await filesAsked.confirm(`${offer.refused} Send the text only?`)) throw new Error(kept); }
    else if (offer) { const answer = await filesAsked.confirm(offer.line); if (answer === null) throw new Error(kept); if (answer) files = offer; }
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
    let started = await remoteApp.start(machine, text, settings, { files, sending: filesAsked.sending });
    // That computer cannot take them with a new session (offline, or an older ELU): the text alone, if he says so.
    if (started.noFiles) { setMessage(''); if (!await filesAsked.confirm(`${started.noFiles} Start it with the text only?`)) throw new Error(kept); started = await remoteApp.start(machine, text, settings); }
    ask.clearValue(); if (form) resetForm();
    // The list shows it, with the cursor on it.
    rememberDraft(); view = 'tasks'; returnTo = 'tasks'; selectedId = null; selectedRequest = null; following = null;
    ownSeen = null; wanted = null; barKey = openKey = started.key;
    setMessage(autoHere ? `${started.line} ${AUTO_LINES.otherComputer}` : started.line); resize(); focusInput();
  }
  // A message to your agent here about the session on another computer under the cursor,
  // asked for with @here (lib/remote-helper.mjs). The first starts it in the project open here,
  // with the defaults of a new session there, named after that session; the next ones continue
  // it, wherever it runs.
  async function helperSubmit(row, typed) {
    if (!typed) { ask.setValue(`${HERE} `); setMessage(`Write your message after ${HERE}.`); focusInput(); return; }
    // It runs here, where a picture he dropped is: one under ~/Library goes as a copy it may read, as in enqueue.
    const text = readablePictures(typed).text;
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
      const repo = helperRepo(root), request = queueRequest(root, text, { priority: 0, permissions: defaultMode(), place: { kind: 'worktree' }, folders: [], bots: [], helps: { machine: row.remote.machine, remoteId: row.id, name: row.machine, title: row.remote.title ?? '' } });
      linkHelper({ machine: row.remote.machine, remoteId: row.id, name: row.machine, title: row.remote.title ?? '', root, project: repo.project ?? repo.root, requestId: request.id });
    }
    conduct(); ask.clearValue();
    setMessage(`Sent to your agent here. It answers beside @${row.machine}'s session.`); focusInput();
  }
  // The one line that offers files to a session on another computer of mine, and what shows while they go.
  // confirm: true for y, false for n, null for Esc, which sends nothing and keeps the message in the box.
  const filesAsked = { confirm: line => yesNoKey('Send files', line), sending: line => { setMessage(line); draw(); } };
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
      // One of them is counted in the singular: 1 of 1 teammate, 1 of 1 computer of yours.
      const mine = remoteApp.yours(), said = (rows, one, many) => { const online = rows.filter(member => member.online); return rows.length ? `${online.length} of ${rows.length} ${rows.length === 1 ? one : many} online${online.length ? `: ${online.map(member => `${peerName(member.name, member.key)} (${member.path === 'relayed' ? `through ${remote(member.via, 60) || 'another computer'}` : remote(member.path, 10) || 'direct'})`).join(', ')}` : ''}` : ''; };
      const all = [...members.values()], yours = all.filter(member => mine.has(member.key)), others = all.filter(member => !mine.has(member.key)), unsure = yours.filter(member => mine.get(member.key).waiting).map(member => peerName(member.name, member.key));
      // One that has not marked this machine back yet is not mine yet, and the line says which.
      setMessage(members.size ? [said(others, 'teammate', 'teammates'), said(yours, 'computer of yours', 'of your computers'), unsure.length ? `waiting for ${unsure.join(', ')} to agree` : ''].filter(Boolean).join(' · ') : 'No teammates yet. Use /invite to add one.'); return;
    }
    // from: the open project, when it is another project of a team (not its first), so the
    // teammate's session runs in their folder of it, not where /access sends the team's (lib/peer/asks.mjs).
    const askedFrom = () => {
      if (!controller) return {};
      try { const root = controller.repo.root; return (facade.teamProjectRoots?.() ?? []).some(row => typeof row?.team === 'string' && row.team.length > 64 && path.resolve(row.root) === path.resolve(root)) ? { from: root } : {}; } catch { return {}; }
    };
    // Adding a teammate shares the open project with the team: whoever joins with the code joins
    // it (lib/peer/project-share.mjs), and teammates can ask about it. root: the folder shared.
    // Kept off with /share off before, it is on again: the person who joins it sees it.
    const teamShare = async teamId => {
      if (!controller) return { line: 'Type /share in a project so teammates can ask about it.', root: null };
      try { controller.writable(); const row = await facade.share(controller.repo.root, { teams: [teamId], status: true }), root = row?.root ?? controller.repo.root; return { line: `It shares ${remote(projectName(root), 40) || path.basename(root)}, the folder ${shortHome(root)}: whoever joins with it joins that project. ${seenLine(root)}`, root }; }
      catch (error) { return { line: `${path.basename(controller.repo.root)} is not shared: ${error.message}`, root: null }; }
    };
    if (name === 'invite') {
      const teams = peerRead('peerStatus')?.teams ?? [];
      if (!teams.length && args.length) throw new Error('No team yet. /invite alone starts one and makes a code to send.');
      // Plain /invite first says what it can do: a code for someone new, or which bots teammates may use.
      if (!args.length) {
        const sharing = myBots().some(botShareable);
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
      // The open project is shared first, so the code names the project of the team it is.
      const shared = await teamShare(chosen.id), bots = botsLine();
      const result = await facade.createInvite(chosen.id, { hours: 24, ...(shared.root ? { root: shared.root } : {}) }), code = readCode(typeof result === 'string' ? result : result?.code)?.short;
      if (!code) throw new Error('The invite could not be made.');
      const noProject = asked ? saveAccess(chosen.id, asked).noProject : null;
      // The code goes on the clipboard as the window opens, so nobody has to select it.
      let copied = false; try { if (copyText) { copyText(code); copied = true; } } catch {}
      setMessage(`Invite for ${remote(chosen.name, 40)} ready${copied ? ' and copied' : ''}. It works once, within 24 h.${projectNote(noProject)}`);
      await prompt('Team invite', `${framed(code)}\n\n${copied ? 'Copied to your clipboard. ' : ''}One use, expires in 24 h.\n${shared.line}\n${bots ? `${bots}\n` : ''}Send this code to your teammate. On their computer:\n1. Open a terminal in the project folder they will share with you.\n2. Run npx -y @elu-labs/elu\n3. In ELU, type /join and paste this code.\nStay online until they join.`, '', { read: true }); return;
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
      // The joiner is added to the inviter's team, and the project open now is the project of the
      // team the code was made in (lib/peer/project-share.mjs): one project with theirs, whose sessions each sees.
      // Teammates' messages start sessions in it, as the answers say. /share off keeps it here.
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
      // A code made in another project of the team: the open project is that one here, before
      // what teammates can do here is saved, so it is never taken for the team's first.
      let notKept = null;
      if (joined?.id && (joined.project || joined.member) && controller) { try { facade.joinedProject?.(joined.id, joined.project ?? null, controller.repo.root, { member: joined.member === true }); } catch (error) { notKept = error.message; /* For a new member, saveAccess below checks the same folder and says why it is not kept. */ } }
      // through: the computer that passes the connection along, when the two networks would not connect directly.
      const via = remote(joined?.via, 60), through = via ? ` Connected through ${via}.` : '';
      // Already on the team, the open project joined another project of it: what teammates can
      // do here stays as it was, and that is all there is to say.
      if (joined?.member) { setMessage(notKept ? `Joined nothing new: ${notKept}` : !controller ? `You are on ${team} already. Open your folder of the project and type /join again.` : `Joined ${who ? `${who}'s` : 'the'} project in this folder.${through} You see each other's sessions here now.`); return; }
      const { saved, noProject } = joined?.id ? saveAccess(joined.id, asked) : { saved: null, noProject: null };
      const joinedHead = `Joined ${team}${who ? ` with ${who}` : ''}.${through}`;
      setImmediate(() => nameShared(joined?.id, joinedHead));
      const said = `${joinedHead} ${saved?.handling === 'manual' ? 'Their messages wait for you to approve them.' : saved && !noProject ? 'Their messages start sessions here, as if you typed them.' : ''}${projectNote(noProject)}`.replace(/\s+/g, ' ').trim();
      // A team of my own that nobody else was ever on was closed by the join, so Chats has one #general; on several teams now, each has
      // its own. Said right after who was joined: the row is cut at its width, and what teammates can do here was just answered.
      const teamsNote = [facade.closedLine?.(joined?.closed), facade.teamsLine?.(facade.teamCount?.())].filter(Boolean).join(' ');
      const told = teamsNote && said.startsWith(joinedHead) ? `${joinedHead} ${teamsNote}${said.slice(joinedHead.length)}` : `${said}${teamsNote ? ` ${teamsNote}` : ''}`;
      setMessage(told); return;
    }
    if (name === 'leave') return leaveTeam(args);
    if (name === 'remove') return removeTeammate(args);
    const target = args[0] ?? '';
    // No @name: the question goes to every teammate, and the first to take it answers.
    if (target && !target.startsWith('@')) {
      const chat = controller && view === 'chat' ? { root: controller.repo.root, taskId: selectedId ?? null } : {};
      const result = await peerCommand({ type: 'teamAsk', project: null, text, ...chat, ...askedFrom() });
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
    const result = await peerCommand({ type: 'ask', to, project, text: rest, ...chat, ...(project == null ? askedFrom() : {}) });
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
  // The page of a team's project with no folder here: its sessions and its board on every
  // computer of the team, its instructions and memory as the team has them, to read, and which
  // folder here it is. What is written to it here waits for that folder.
  async function teamPage(project) {
    const open = { team: project.team, id: project.id, name: project.name }, name = project.name, row = (label, value) => ink(label.padEnd(14), 'muted', colour) + ink(value, 'text', colour);
    for (let selected = 0; ;) {
      let notes = null; try { notes = facade?.teamNotes?.(project.team) ?? null; } catch { notes = null; }
      const far = remoteApp.teamCount(project.team), count = `${far.sessions} session${far.sessions === 1 ? '' : 's'}`;
      const rows = [[row('Sessions', far.on.length ? `${count} · ${far.on.map(item => `${item.sessions} on @${item.name}`).join(', ')}` : count), 'sessions'], [row('Kanban', 'its board on every computer'), 'kanban'],
        [row('Instructions', firstLine(notes?.instructions)), 'instructions'], [row('Memory', firstLine(notes?.memory)), 'memory'], [row('Folder here', 'none yet · Enter chooses which'), 'folder']];
      const picked = await listDialog(`Project ${name}`, rows.map(([text]) => text), { selected, notes: [`${name} has no folder on this computer yet. Its sessions, board, instructions and memory are the team's.`] });
      if (!picked) return;
      selected = picked.index; const act = rows[picked.index][1];
      if (act === 'sessions' || act === 'kanban') {
        teamOpen = open; sharedOpen = project.id;
        // Sessions shows its sessions whichever opens first.
        const first = remoteApp.openTeam(project.team, name, controller?.repo.root);
        if (first && act === 'sessions') { barKey = first; wanted = null; }
        showView(act === 'sessions' ? 'tasks' : 'kanban');
        setMessage(fitLine(`${name} on every computer of the team. It has no folder here yet: a new session asks which folder it is.`, `${name}: a new session asks which folder here it is.`));
        setImmediate(() => { if (modal || closing) return; if (view === 'tasks') board.focus(); else if (view === 'kanban') focusContent(Math.max(0, kanbanData.findIndex(column => column.items.length))); draw(); }); return;
      }
      if (act === 'folder') { if (await teamFolderAsk(open)) return; continue; }
      // To read. Edited here, they are its folder's here: e asks which folder that is first, once.
      const text = act === 'instructions' ? notes?.instructions ?? '' : notes?.memory ?? '';
      if (!await readDialog(`${act === 'instructions' ? 'Instructions' : 'Memory'} · ${name}`, text, { empty: `No ${act} yet.` })) continue;
      if (await teamFolderAsk(open)) return;
    }
  }
  // The first new session in a team's project with no folder here: which folder here it is, the
  // open project first. The one chosen is that project here from then on: its sessions, Tasks,
  // instructions and memory are the team's. Asked once: nothing asks again after. false when
  // the owner closed it without choosing.
  async function teamFolderAsk(open) {
    const projects = (dashboardSnapshot().projects ?? []).filter(project => !project.unavailable), top = controller?.repo.root;
    const rows = [...projects.filter(project => project.root === top), ...projects.filter(project => project.root !== top)];
    if (!rows.length) throw new Error(`Open the folder of ${open.name} here first: n in Projects.`);
    if (typeof facade?.keepTeamFolder !== 'function') throw new Error(PEER_MISSING);
    const picked = await listDialog(`Which folder here is ${clip(open.name, 30)}?`, rows.map(project => ink(padEnd(clip(project.name, 22), 24), 'text', colour, true) + ink(clip(shortHome(project.root), Math.max(12, Math.min(60, screen.width - 44))), 'muted', colour)),
      { notes: [`${open.name} has no folder on this computer yet. The one you choose is ${open.name} here from now on: its sessions, Tasks, instructions and memory are the team's. You are asked once.`] });
    if (!picked) return false;
    const root = facade.keepTeamFolder(open.team, rows[picked.index].root);
    teamOpen = null; sharedOpen = null; remoteApp.closeOpened(); sharedKept.at = 0;
    setMessage(`${rows[picked.index].name} is ${open.name} here now.`);
    return root;
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
  // A dialog that names a task or a session takes a command typed into it for a slip: it says
  // what the command is and how to run it, and keeps the box open (check). The box may open
  // with the name or the task in it (opened), and a command typed then lands after it.
  const commandIn = text => typedCommand(`${String(text ?? '').trim()} `);
  const notCommand = (text, opened = '') => {
    const value = String(text ?? '').trim(), start = String(opened ?? '').trim();
    const command = commandIn(value) ?? (start && value !== start && value.startsWith(start) ? commandIn(value.slice(start.length)) : null);
    return command ? `/${command.name} is a command. Esc closes this, then type it.` : null;
  };
  // A project name has no /. It would read as a folder, and the box opens with the folder's
  // name in it, so a command typed there by mistake lands after it (elsewhere/kanban). Names
  // saved with one before, or brought from a teammate, still show as they are.
  const projectNameProblem = text => {
    if (!String(text ?? '').includes('/')) return null;
    const command = String(text).split('/').slice(1).map(word => commandIn(`/${word}`)).find(Boolean);
    return command ? `/${command.name} is a command. Esc skips naming, then type it.` : 'A project name cannot have /.';
  };
  async function nameHere(location) {
    const name = await prompt('New project', `${location.root}\n\nName this project. Its settings are saved in .elu-code/ in this folder.\nThe model finds your code anywhere in your home folder.\nEsc skips${location.common ? ' and opens the repository unnamed' : ''}.`, path.basename(location.root), { check: projectNameProblem });
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
  // The page of an agent of the open session: its model, or a bot in its chat, by model and
  // effort (lib/terminal-agent.mjs). A change is saved for the session, and the chat says so.
  const agentDialog = agentDialogs({ listDialog, yes, setMessage, colour, pickModel, pickEffort: botDialog.pickEffort, nameOf, save: (agent, to, every, line) => {
    const task = openTask(); if (!task) throw new Error('Open a session first.');
    try { return controller.changeAgent(task.id, { bot: agent.bot, to, every, line }); } finally { reported.at = 0; botCache.at = 0; draw(); }
  } });
  // Who is in a session, as its agents' pages read them: its model first, then its bots,
  // each with the model and effort it runs on in this session.
  function sessionAgents(task) {
    const choice = sessionModel(controller.repo, task) ?? controller.defaultModel();
    // own: the level a model runs with when none is chosen, as the headings of its replies show
    // it (lib/bot-models.mjs agentOwnEffort), or null where it is not known here. A run of this
    // session on that name says which model it is.
    const ownOf = ({ vendor, model = null }) => agentOwnEffort(vendor, model, { ran: (task.runs ?? []).findLast(run => run.vendor === vendor && (run.asked ?? null) === (model ?? null) && typeof run.model === 'string')?.model ?? null });
    const levels = agent => ({ ...agent, own: ownOf(agent), ownOf });
    // With Auto model on the session's model reads Auto model: what is on, and the effort its plans and edits run with.
    const auto = autoOn(task) ? { line: autoOnLine(choice.vendor, task), effort: effortOf(choice.vendor, task.autoEffort ?? autoRead('effort', () => autoSettings().effort)) } : null;
    const lead = levels({ who: auto ? AUTO_NAME : modelOf(task), bot: null, vendor: choice.vendor, model: choice.model ?? null, effort: leadEffort(task, choice.vendor), fresh: choice.vendor === 'codex' && (task.permissions ?? 'locked') === 'locked', ...(auto ? { auto } : {}) });
    // saved: the bot as it is saved for every session, which this session's may differ from.
    return [lead, ...botsOf(task).flatMap(name => { const saved = savedBot(name), bot = saved && sessionBot(task, saved); return bot ? [levels({ who: `@${name}`, bot: name, vendor: bot.vendor, model: bot.model ?? null, effort: bot.effort ?? null, saved: { vendor: saved.vendor, model: saved.model ?? null, effort: saved.effort ?? null } })] : []; })];
  }
  // Opens the page of an agent of the open session: bot, a bot's name, or null for its model.
  async function agentPage(bot = null) {
    if (!controller) throw new Error(NO_PROJECT);
    const task = openTask(); if (!task) throw new Error('Open a session first.');
    controller.writable();
    await readAllModels();
    const agent = sessionAgents(task).find(row => row.bot === bot);
    if (!agent) throw new Error(`@${bot} is not in this session.`);
    return agentDialog.open(agent);
  }
  // /agent change <name> [model <model>] [effort <level>] [--every-session]. The name alone
  // opens the agent's page, and no name the list of the session's agents first.
  async function changeAgentCommand(words) {
    const task = openTask();
    if (!task) throw new Error('Start the session first: /model chooses the model of a new one.');
    controller.writable();
    await readAllModels();
    const agents = sessionAgents(task);
    if (!words.length) {
      // The session's model is named by its model, so its row says it once, then its effort.
      const picked = await listDialog('Agents', agents.map(agent => ink(agent.who.padEnd(16), agent.bot ? toneOfBot(agent.bot) : 'orange', colour, true) + ink(agent.bot ? `${nameOf(agent)} · ${effortText(agent)}` : agent.auto?.effort ?? effortText(agent), 'muted', colour)));
      return picked ? agentDialog.open(agents[picked.index]) : undefined;
    }
    const named = words[0].replace(/^@/, '').toLowerCase(), agent = named === 'model' ? agents[0] : agents.find(row => row.bot === named);
    if (!agent) throw new Error(`${words[0]} is not in this session. /agents shows who is.`);
    const said = changeWords(words.slice(1));
    if (!said.model && !said.effort && !said.every) return agentDialog.open(agent);
    // model auto is Auto model, which is the session's alone: a bot runs on one model.
    if (said.model?.length === 1 && isAutoWord(said.model[0])) { if (agent.bot || said.effort || said.every) throw new Error(AUTO_LINES.reserved); return autoCommand(); }
    const found = said.model ? modelWords(said.model, { label: nameOf }) : null;
    if (found && found.count < said.model.length) throw new Error(`${said.model.join(' ')} is not a model this computer offers. /model lists them.`);
    const base = found ? { vendor: found.choice.vendor, model: found.choice.model ?? null } : { vendor: agent.vendor, model: agent.model };
    if (said.effort && !botEfforts(base.vendor).includes(said.effort)) throw new Error(effortProblem(base.vendor));
    const to = { ...base, effort: said.effort ?? (botEfforts(base.vendor).includes(agent.effort) ? agent.effort : null) };
    if (await agentDialog.apply(agent, to, said.every) === null) setMessage('Nothing changed.');
  }
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
    // before: its schedule here as it was ahead of the tick that this add started. list: the
    // session's bots as they are now, each the owner's own (botsPicked).
    const joined = (list, before = null) => {
      const runs = botScheduleIn(controller.repo, task ? { ...task, bots: list, botsPicked: true } : null, name);
      // A bot that oversees neither works in the session nor reviews its changes: it reads and advises.
      const oversees = botOversees(getBot(name)), works = oversees ? 'runs' : 'works';
      if (!runs && oversees) return `@${name} is in this session. It reviews no change and edits nothing: write to @${name} and it looks at your sessions and advises.`;
      if (!runs && botShadows(getBot(name))) return `@${name} is in this session. It reviews the changes, and speaks after each turn that changes no files.`;
      if (!runs) return botWorks(needBot(name)) ? `@${name} is in this session. It works when you write to @${name}.` : `@${name} is in this session. It reviews the changes.`;
      if (!runs.on && runs.note) return `@${name} is in this session. ${runs.note}`;
      if (runs.off) return `@${name} is in this session. Its schedule is off here; /bots schedule on ${name} starts it.`;
      const every = runs.label ?? 'on its schedule', stop = `/bots schedule off ${name} stops the schedule here.`;
      // The form has no session yet: Enter in the empty box starts it with this bot's first turn.
      if (!task) return composeWhen || !runs.label ? `@${name} is in this session. It ${works} here ${every} once the session starts, and when you write to @${name}.` : `@${name} is in this session. Press Enter to start it, or send your first message.`;
      if (before && runs.lastRunAt && runs.lastRunAt !== before.lastRunAt) return `@${name} is in this session and starts now. It then ${works} here ${every}. ${stop}`;
      if (runs.starting) return `@${name} is in this session. It starts when the session is free, then ${works} here ${every}. ${stop}`;
      return `@${name} is in this session. It ${works} here ${every}${runs.nextRunAt ? `, next ${dateText(new Date(runs.nextRunAt))}` : ''}, and when you write to @${name}. ${stop}`;
    };
    if (has && again && action === 'add') { setMessage(joined(now)); return; }
    if (has === (action === 'add')) throw new Error(has ? `@${name} is already in this session.` : `@${name} is not in this session.`);
    // A bot that was deleted since drops out here: the store takes saved names only.
    const saved = listBots().map(bot => bot.name), rest = now.filter(row => row !== name && saved.includes(row)), next = has ? rest : [...rest, name];
    if (task) controller.setBots(task.id, next); else composeBots = chatBots(next);
    // A bot that has a schedule starts here now: the tick queues its first run.
    const before = !has && task ? botScheduleIn(controller.repo, { ...task, bots: next, botsPicked: true }, name) : null;
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
    // The project of a team with no folder here: Enter opens its page, as a project here does.
    // Its first new session here asks which folder it is.
    if (project.shared && project.team) {
      if (action !== 'settings') throw new Error(fitLine(`${project.name} has no folder here yet. Enter opens it; a new session there asks which folder it is.`, 'No folder here yet. Enter opens it.'));
      return teamPage(project);
    }
    // Any other row lets a team's project opened before go.
    if (teamOpen) { teamOpen = null; remoteApp.closeOpened(); }
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
    // A project of another computer: Enter shows its sessions in Sessions. It is not this machine's to change.
    if (project.remote) {
      if (action !== 'settings') throw new Error(`${project.name} is on another computer. Enter shows its sessions.`);
      // The cursor goes to the newest session under that project's own heading, which then shows beside the list.
      const first = remoteApp.openProject(project.key, project.id, controller?.repo.root);
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
  // A project's settings: its Instructions (instructions.md) and Memory (context.md) are edited in place.
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
      // Also on: the other computers that have this project, his and his teammates' alike. It is
      // one project there: the same instructions and memory, with nothing to do for it.
      const also = alsoOn(project);
      // What the text to read says when none is in use: a file that came with the folder and is not in use is there all the
      // same, Shared files shows it, and what e saves takes its place.
      const none = (file, what) => () => unusedTrust(root).some(item => item.name === file && item.before === null) ? `${file} came with the folder and is not in use. Shared files shows it. e writes new text in its place.` : `No ${what} yet. e adds text.`;
      const rows = [[active ? ink('● Active project', 'orange', colour) : ink('Make active', 'text', colour), 'active'], [row('Instructions', line('instructions.md', settings.instructions)), 'instructions'], [row('Memory', line('context.md', settings.context)), 'context'], ...(also ? [[row('Also on', also), 'also']] : []),
        [row('Default model', defaultRow(start)), 'project'], [row('This computer', computerRow()), 'computer'], [ink(joinedTeamsOf(root).length ? 'Leave' : 'Archive', 'text', colour), 'archive'], ...(waiting.length ? [[row('Shared files', count), 'shared']] : [])];
      const picked = await listDialog(`Project ${name}`, rows.map(([text]) => text), { selected });
      if (!picked) return;
      selected = picked.index; const act = rows[picked.index][1];
      if (act === 'active') return makeActive(project);
      // Each says first what it is and how it is used (about), never part of its text. Every turn
      // of the project reads both (lib/runner.mjs); ELU writes only the Memory's learned lines,
      // each from the words of the owner of the computer it ran on (lib/project-learnings.mjs).
      // The computers in Also on have the same text (lib/project-notes.mjs), put together with
      // what each wrote and learned there, a teammate's on a shared project too. So with Also on
      // it is everyone's, not his alone.
      const abouts = also
        ? { instructions: [`Rules every session in this project follows, here and on ${also}.`, 'Everyone on it writes them; e edits.'],
          context: ['What ELU learned from everyone on it, and what they added.', `Sessions here and on ${also} read it. e edits; remove anything wrong.`] }
        : { instructions: ['Rules every session in this project follows. You write them; e edits.'],
          context: ['What ELU learned from you, and what you added. Every session reads it.', 'e edits; remove anything wrong.'] };
      if (act === 'instructions') await readSetting(`Instructions · ${name}`, () => readProjectSettings(root).instructions, none('instructions.md', 'instructions'), (before, text) => saveInstructions(root, text), abouts.instructions);
      // Lines learned while he edits, here or on his other computer, stay: only the ones he took out go.
      else if (act === 'context') await readSetting(`Memory · ${name}`, () => readProjectSettings(root).context, none('context.md', 'memory'), (before, text) => saveContextEdit(root, before, text), abouts.context);
      else if (act === 'also') setMessage(`${name} is the same project on ${also}: the same instructions and memory.`);
      // Once nothing is left to review the row is gone: the cursor goes back to the top, not to the row that took its place.
      else if (act === 'project' || act === 'computer') { try { await chooseDefault(act, [], project); } catch (error) { setMessage(error.message); } }
      else if (act === 'shared') { await reviewProjectFiles(root, { declined: true }); if (!unusedTrust(root).length) selected = active ? 1 : 0; }
      else if (await archiveRow(project)) return;
    }
  }
  // The other computers that have this project (lib/peer/notes.mjs), by the names they go by
  // here: "@devbox, @studio". null when none said so.
  function alsoOn(project) {
    let rows = []; try { rows = facade?.projectLinks?.(project.root) ?? []; } catch { rows = []; }
    const names = (Array.isArray(rows) ? rows : []).filter(row => row?.linked).map(row => `@${remoteApp.nameOf(row.key)}`);
    return names.length ? names.join(', ') : null;
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
  // A project's Instructions or Memory open to read (readDialog). e or Enter edits the text as
  // it is in the file (editSetting), and the editor's Esc or its save comes back to it, drawn
  // again from the file. save gets the text the editor opened with, and the text saved. empty
  // gives what it says when there is no text, read again with the file each time it opens.
  // about: the lines that say first what it is, over the text; the editor and the file never have them.
  async function readSetting(title, current, empty, save, about = []) {
    for (;;) {
      const value = current();
      if (!await readDialog(title, value, { empty: empty(), about })) return;
      await editSetting(title, value, text => save(value, text));
    }
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
    const shared = sharedNow(), there = shared ? null : thereNow();
    if (there) return thereAction(there, index, action);
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
      const text = await prompt('New task', 'What should be done? It waits in To do until you start it with Shift+→.', '', { check: notCommand });
      if (!text?.trim()) return; addCard(repo, text); setMessage('Added to To do. Shift+→ on it starts it.'); return;
    }
    if (!item) throw new Error(viewOnly() ? 'Nothing here.' : 'Nothing here. n adds a task to To do.');
    // A teammate's Task is theirs: Enter opens it to read, and no key changes it.
    if (item.teammate) {
      if (action === 'open') return openCard(item);
      // One of mine on my other computer (session.own) is mine, and moves only there: Shift+→
      // checks one that waits for it there, as here.
      if (['forward', 'check'].includes(action) && ownCheck(item)) { const older = remoteApp.checkLine(item.teammate.peer); if (older) throw new Error(older); return checkSession({ remote: { to: item.teammate.peer, ref: item.session.ref }, title: item.session.title }); }
      if (item.teammate.mine && item.session?.own === true) throw new Error(`That session runs on @${remote(item.teammate.box, 24).replace(/^@/, '') || remote(item.teammate.name, 40)}. Enter opens it; it changes only on that computer.`);
      throw new Error(`That is ${remote(item.teammate.name, 40) || 'a teammate'}'s ${item.session ? 'session' : 'Task'}. Enter opens it to read; it changes only on their machine.`);
    }
    if (action === 'open') {
      if (item.card?.column === 'todo') {
        const text = await prompt('Edit task', 'Change the task. Shift+→ on it starts it.', item.card.text, { check: text => notCommand(text, item.card.text) });
        if (text?.trim() && text.trim() !== item.card.text) { editCard(repo, item.card.id, text); setMessage('Saved.'); } return;
      }
      if (item.task || item.request) return openCard(item);
      throw new Error('Its session is not available. x removes it from the board.');
    }
    if (action === 'remove') {
      if (!item.card) throw new Error('Shift+→ checks it instead. Its session stays in Sessions.');
      removeCard(repo, item.card.id); setMessage('Removed from the board.'); return;
    }
    // /done on the Kanban: the selected card's check, as Shift+→ under Needs you.
    if (action === 'check' && column.column !== 'needs') throw new Error(column.column === 'done' ? 'It is in Done already.' : 'Only a card under Needs you waits for your check.');
    if (action === 'forward' || action === 'check') {
      if (column.column === 'todo') {
        controller.writable();
        const request = enqueue(repo.root, item.card.text, { priority: 0, permissions: defaultMode(), ...(autoStart() ? { auto: true } : {}) }); startCard(repo, item.card.id, request.id); conduct();
        setMessage('Started. It moves to Needs you when the model stops.'); return;
      }
      if (column.column === 'progress') throw new Error('It is being worked on. It moves to Needs you when the model stops.');
      if (column.column === 'needs') {
        if (!item.card && !item.task) throw new Error('Enter opens it: send it again, or /stop cancels it.');
        // Nothing goes to Done before the owner checks it (lib/owner-check.mjs). A card whose
        // session is gone has nothing to check: he moves it himself.
        if (!item.task) { setMessage(moveToDone(repo, item)); return; }
        return checkSession({ repo, root: repo.root, task: item.task });
      }
      throw new Error('Done is the last column. Shift+← reopens it.');
    }
    if (action === 'back') {
      if (column.column === 'done') {
        if (!item.card && !readBoard(repo).done.includes(item.task.id)) throw new Error('Answered questions and published work stay in Done.');
        setDone(repo, item, false); setMessage('Reopened.'); return;
      }
      if (column.column === 'todo') throw new Error('To do is the first column.');
      throw new Error('A started task stays with its session. Enter opens it; Shift+→ checks it.');
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
  // The folder a project is listed under: a schedule keeps the one it was saved with, which may
  // name it by another path (a link to it).
  const listedRoot = root => { try { return projectFolder(root).root; } catch { return root; } };
  // A schedule's row with no run in the list, and its Schedule tab: r runs it now, p pauses or
  // resumes it, x deletes it. Enter on the row moves into its Schedule tab.
  async function scheduleAction(row, action) {
    const { schedule } = row;
    if (action === 'open') return showSchedule({ focus: true });
    // The run it queued takes the schedule's place in the list, and the cursor goes with it.
    if (action === 'retry') {
      runScheduleNow(schedule.id, new Date(), { start: conduct });
      const run = listSchedules().find(value => value.id === schedule.id)?.lastRequestId;
      if (run && row.kind === 'schedule' && listed()) pointBar(`${listedRoot(row.root)}\0request\0${run}`);
      setMessage('Running it now.'); return;
    }
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
    if (row.type === 'model') {
      if (action === 'remove') return; await readAllModels();
      const now = composeModel ?? controller.defaultModel(), auto = formAuto(), choice = await pickModel(now, auto ? autoOnLine(now.vendor) : `The new session uses ${nameOf(now)} (${modelText(now)}).`, { auto: { current: auto } });
      if (choice === AUTO_CHOICE) return autoCommand();
      if (choice) await useModel(choice); return;
    }
    if (row.type === 'bots') { if (action === 'remove') { composeBots = []; setMessage('No bots in this session.'); return; } return pickBots(); }
  }
  // The Model picker: every model a session can be given, narrowed to what is typed. A name
  // that is not listed is taken as vendor:name. null when closed with nothing chosen.
  // none: a default is being chosen, and this says what choosing none means; that row gives NO_CHOICE.
  // auto: the caller takes Auto model (lib/auto-model.mjs) too. Its row comes first, marked
  // when auto.current says it is in use, and gives AUTO_CHOICE. Where no vendor here can have
  // it, the word auto is answered with auto.refused (the session's sentence when not given).
  // Where the caller takes none, the word auto is answered with reserved: it is no model's name.
  const NO_CHOICE = Object.freeze({ none: true }), saysNone = text => String(text ?? '').trim().toLowerCase() === 'none';
  const AUTO_CHOICE = Object.freeze({ auto: true });
  async function pickModel(current, said, { none = null, auto = null, reserved = AUTO_LINES.reserved } = {}) {
    const choices = modelChoices(), offered = Boolean(auto) && autoOffered(), refused = auto ? auto.refused ?? AUTO_LINES.needsHome : reserved;
    const rows = [...(offered ? [{ name: AUTO_WORD, note: [AUTO_LINES.listNote, auto.current ? 'in use' : ''].filter(Boolean).join(' · ') }] : []), ...choices.map(row => ({ name: row.name, note: [row.vendor, row.note].filter(Boolean).join(' · ') })), ...(none ? [{ name: 'none', note: none }] : [])];
    if (!choices.length) throw new Error('No vendor command line is installed, so there is no model to choose yet.');
    const check = text => { if (!text.trim() || none && saysNone(text)) return null; if (isAutoWord(text)) return offered ? null : refused; try { findModel(text); return null; } catch (error) { return error.message; } };
    const answer = await prompt('Model', `${said}\nChoose one, or type vendor:name for a model that is not listed.`, offered && auto.current ? AUTO_WORD : choiceName(current, choices), { suggest: text => matchModels(rows, text), check });
    if (isAutoWord(answer)) { if (!offered) throw new Error(refused); return AUTO_CHOICE; }
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
    // New sessions that begin with Auto model (/model computer auto) say so before the model whose vendor they pick from.
    return autoSettings().default && !homeProblem(start.vendor) ? `${AUTO_NAME} · ${nameOf(start)}` : nameOf(start);
  }
  // /model computer auto: new sessions the owner starts on this computer begin with Auto
  // model, the one in the form now too. A model or none chosen for this computer takes it
  // away again (chooseDefault). Returns the line that says which it is. It is refused with the
  // sentence about this computer, not one session, where no vendor here can have it.
  function computerAuto(on) {
    if (on && !autoOffered()) throw new Error(AUTO_LINES.needsHomeHere);
    saveAutoSettings({ default: on }); autoKept.clear(); composeAuto = on;
    return on ? AUTO_LINES.computerOn : AUTO_LINES.computerOff;
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
    // This computer's default may be Auto model; a project's is a model, and Auto model is said to be this computer's.
    const begins = computer && autoSettings().default;
    const choice = named ? named.choice : words.length ? NO_CHOICE : await pickModel(start(), `${defaultSaid(start(), name)}${begins ? ` ${AUTO_LINES.computerOn}` : ''}`, { none: computer ? "clears this computer's default" : "clears this project's default", ...(computer ? { auto: { current: begins, refused: AUTO_LINES.needsHomeHere } } : { reserved: AUTO_LINES.defaultHint }) });
    if (!choice) return;
    if (choice === AUTO_CHOICE) { setMessage(computerAuto(true)); return; }
    const value = choice === NO_CHOICE ? null : choice;
    if (computer) saveComputerDefault(value); else if (active) controller.setDefaultModel(value); else saveProjectDefault(projectFolder(project.root), value, startConfig(project.root));
    // A model he picks for this computer wins there too: new sessions no longer begin with Auto model.
    setMessage(`${defaultSaid(start(), name)}${begins ? ` ${computerAuto(false)}` : ''}`);
  }
  // Gives a model to the open session, or to the new session form. In a session it is the
  // change its model's page makes (lib/terminal-agent.mjs): the chat keeps its line, what
  // another model of the vendor does is said, and another vendor's is a handoff asked first.
  // Returns false when that was declined.
  async function useModel(choice) {
    const task = openTask();
    if (task) {
      controller.writable();
      const agent = sessionAgents(task)[0];
      return await agentDialog.apply(agent, { vendor: choice.vendor, model: choice.model ?? null, effort: botEfforts(choice.vendor).includes(agent.effort) ? agent.effort : null }) !== null;
    }
    if (!composing()) throw new Error('Open a session, or /new. /model default <name> sets new sessions.');
    // A model he picks wins over Auto model in the form too, and the line says so.
    const auto = formAuto(); composeModel = choice; composeAuto = false;
    setMessage(auto ? AUTO_LINES.picked(nameOf(choice)) : `${nameOf(choice)} for this session.`); return true;
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
    if (openTask() || composing()) { if (!await useModel(choice)) setMessage('Nothing changed.'); return; }
    setMessage(`Added ${nameOf(choice)} (${modelText(choice)}). /model ${choiceName(choice, modelChoices())} uses it in a session.`);
  }
  // /model shows or chooses the model of the open session, or of the new session form.
  // default <name> sets what new sessions of this project start with; add adds one by name.
  // A name may be the one the model is shown by (/model opus 5.5), and words after it are a
  // message, sent to the session on that model (/model sonnet fix the build).
  // auto is Auto model (/model auto, autoCommand): the word is read before any model's name
  // and before a session on another computer. After computer it is this computer's default
  // for new sessions; after default it says where that is set.
  async function modelCommand(args, text = args.join(' ')) {
    if (!controller) throw new Error(NO_PROJECT);
    if (args[0] === 'add') { if (args.length > 1) throw new Error('Use /model add.'); return addModel(); }
    if (isAutoWord(args[0])) return autoCommand(text.trimStart().replace(/^\S+\s*/, ''));
    if (['computer', 'default'].includes(args[0]) && isAutoWord(args[1])) {
      if (args.length > 2) throw new Error(args[0] === 'computer' ? 'Use /model computer <name>, or none.' : 'Use /model default <name>.');
      if (args[0] === 'default') throw new Error(AUTO_LINES.defaultHint);
      setMessage(computerAuto(true)); return;
    }
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
      if (!named) { setMessage(`${defaultSaid(controller.startModel(), controller.snapshot().name)} /model default <name> changes it.${autoStart() ? ` ${AUTO_LINES.computerOn}` : ''}`); return; }
      // A name with no session open, where the box starts a new one: the new session form
      // opens on that model, so the message typed next goes to it.
      if (!sessionBox()) throw new Error('Open a session, or /new. /model default <name> sets new sessions.');
      await newTaskForm(); if (!composing()) return;
    }
    const task = openTask(), now = modelNow(), auto = autoNow();
    const choice = named ? named.choice : await pickModel(now, auto ? autoOnLine(now.vendor, task) : `${task ? `This session uses ${modelOf(task)}` : `The new session uses ${nameOf(now)}`} (${modelText(now)}).`, { auto: { current: auto } });
    if (!choice) return;
    if (choice === AUTO_CHOICE) return autoCommand();
    // The message is the rest of the text as it was typed.
    let rest = text.trimStart(); for (let word = 0; word < (named?.count ?? 0); word += 1) rest = rest.replace(/^\S+\s*/, '');
    // A handoff he said no to changes nothing and sends nothing: a line with a message stays in the box.
    if (!await useModel(choice)) { if (rest.trim()) throw new Error('Nothing changed.'); setMessage('Nothing changed.'); return; }
    if (!rest.trim()) return;
    // A model chosen while a turn works starts with the next turn, and so does its message to
    // the model: it carries the model, so the turn that works on the other one never reads it.
    const sent = {}; try { if (task && modelWaiting(controller.repo, readTask(controller.repo, task.id))) sent.model = choice; } catch { /* It goes as any message. */ }
    // Sending it clears the line, so the line that names the model it went to is said once it
    // is sent, and stays until the answer.
    const before = following; await submit(rest.trim(), sent);
    if (task && following && following !== before) setMessage(`${nameOf(choice)} from this message${sent.waits ? ', when the running turn ends' : ''}.`);
  }
  // /model auto turns Auto model on (lib/auto-model.mjs) for the open session, or for the
  // session the form starts: ELU then picks the model for each step, and the line says which.
  // /model auto on is the same. /model auto off turns it off for the open session, which stays
  // on the model it has, or takes it off the form; it sends nothing.
  // One effort word after it (/model auto high), or quick and where (/model auto quick grok),
  // is a setting of this computer and changes no session. Any other words are a message, sent
  // with Auto model on. rest: what was typed after the word auto.
  const ONE_MODEL = 'A schedule runs on one model. /model NAME picks it.';
  async function autoCommand(rest = '') {
    const said = autoWords(rest);
    if (said.kind === 'effort') { saveAutoSettings({ effort: said.effort }); autoKept.clear(); setMessage(AUTO_LINES.effortSet(said.effort)); return; }
    if (said.kind === 'quick') {
      const saved = saveAutoSettings({ quick: said.quick }); autoKept.clear();
      // A vendor that cannot take one yet is said with it, and so is the one that answers them
      // until it can: for the open session's vendor, or the one a new session starts on.
      const waits = VENDORS.includes(said.quick) && !vendorReady(said.quick, { settings: saved });
      let meanwhile = null; if (waits) { try { meanwhile = quickVendor({ home: modelNow()?.vendor ?? null, settings: saved }); } catch { meanwhile = null; } }
      setMessage(`${AUTO_LINES.quickSet(said.quick)}${waits ? ` ${AUTO_LINES.quickWaits(said.quick, meanwhile)}` : ''}`); return;
    }
    // quick alone is the start of that setting, never a message for the top model.
    if (said.kind === 'message' && said.text.toLowerCase() === 'quick') throw new Error(AUTO_LINES.quickUse);
    // A session on another computer is that computer's to set.
    if (remoteHere()) throw new Error(AUTO_LINES.otherComputer);
    if (said.kind === 'off') {
      const task = openTask();
      if (task && autoOn(task)) {
        controller.writable();
        setSessionAuto(controller.repo, task.id, false); autoKept.clear();
        // The chat keeps the line, as for a model picked: the session goes on with the model it has.
        const line = AUTO_LINES.picked(modelOf(readTask(controller.repo, String(task.id))));
        noteChange(controller.repo, task.id, line); setMessage(line); return;
      }
      if (!task && composing()) composeAuto = false;
      setMessage(AUTO_LINES.off); return;
    }
    // A conductor of a build from before Auto model would run the session on one model, and so
    // would one an update replaced that still runs this session's turn: it is not turned on.
    const open = openTask();
    if (!conductorTakesAuto(open?.id ?? null, [controller.repo.root, controller.repo.project ?? controller.repo.root])) throw new Error(AUTO_LINES.older);
    if (!open && !composing()) {
      // With no session open, where the box starts a new one, the form opens with Auto model on.
      if (!sessionBox()) throw new Error('Open a session, or /new. /model computer auto sets new sessions.');
      await newTaskForm(); if (!composing()) return;
    }
    const task = openTask(); let line;
    if (task) {
      controller.writable();
      const home = (sessionModel(controller.repo, task) ?? controller.defaultModel()).vendor;
      // Refused for a session that cannot change model, or whose vendor has no top and work model.
      setSessionAuto(controller.repo, task.id, true, { vendor: home });
      autoKept.clear(); line = autoOnLine(home, task);
      // The chat keeps the line once; typed again it only says what is on.
      if (!autoOn(task)) noteChange(controller.repo, task.id, line);
    } else {
      if (composeWhen) throw new Error(ONE_MODEL);
      const home = (composeModel ?? controller.defaultModel()).vendor, problem = homeProblem(home);
      if (problem) throw new Error(problem);
      composeAuto = true; autoKept.clear(); line = autoOnLine(home);
    }
    setMessage(line);
    if (said.kind !== 'message') return;
    // Sending it clears the line, so it is said again once the message is sent, and stays until the answer.
    const before = following; await submit(said.text);
    if (following && following !== before) setMessage(line);
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
  // One of mine on my other computer that waits there for my check (session.check, lib/peer/cards.mjs).
  const ownCheck = item => Boolean(item?.teammate?.mine && item.session?.own === true && item.column === 'needs' && item.session.check && item.session.ref);
  // The owner's check of a session that ended (lib/owner-check.mjs): the Task's goal and each
  // objective with the agent's mark and its line of evidence, then his answer. Done moves it to
  // Done; Keep open takes a new goal (with no Task, a message) and it carries on at once; a copy
  // with a new goal starts a new session from where it ended and moves this one to Done. Esc
  // changes nothing. place: { repo, root, task } here, or { remote, title } on a computer of mine.
  // One at work with a Task (working) takes a new goal, and only that: its turn is not stopped,
  // and is told of it (lib/owner-check.mjs keepOpen).
  async function checkSession(place) {
    const seen = place.remote ? await remoteApp.check(place.remote) : checkView(place.repo, place.task);
    const working = seen.working === true && Array.isArray(seen.objectives);
    const lines = [], say = (text, tone = 'text', bold = false) => { lines.push({ text, tone, bold }); };
    say(seen.title || 'Session', 'text', true); if (working) say(GOAL_AT_WORK, 'muted'); else if (seen.ended) say(seen.ended, 'muted');
    if (Array.isArray(seen.objectives)) {
      lines.push(''); say('Goal', 'muted', true); say(seen.goal);
      lines.push(''); say(`Objectives · ${seen.objectives.filter(row => row.met).length} of ${seen.objectives.length} met`, 'muted', true);
      for (const row of seen.objectives) { say(`  ${row.met ? '✓' : '·'} ${row.text}`, row.met ? 'green' : 'text'); if (row.evidence) say(`    ${row.evidence}`, 'muted'); }
    } else {
      // Its first message only where it says more than the title: with no Task, the title is often
      // that message, or its first line, which is then left out.
      lines.push(''); say('No Task', 'muted', true); const first = String(seen.first ?? '').trim(), flat = value => String(value ?? '').replace(/\s+/g, ' ').trim();
      const [top, ...after] = first.split('\n'), more = flat(top) === flat(seen.title) ? after.join('\n').trim() : flat(first) === flat(seen.title) ? '' : first;
      if (more) say(more);
    }
    // What ELU's own records say of its work, as its Task shows it (showTask).
    sayChecklist(lines, say, seen.checklist);
    lines.push('');
    const answers = working ? [['goal', 'New goal']] : Array.isArray(seen.objectives) ? [['done', 'Done'], ['goal', 'Keep open, new goal'], ['copy', 'Done, and a copy with a new goal']] : [['done', 'Done'], ['goal', 'Keep open, new message']];
    const rows = () => { const width = Math.min(88, screen.width - 4) - 6; return [...lines.flatMap(row => typeof row === 'string' ? [row] : wrapText(row.text, width).map(line => ink(line, row.tone, colour, row.bold))), ...answers.map(([, label]) => ink(`› ${label}`, 'text', colour, true))]; };
    let answer = null;
    while (!answer) {
      // Only the answers are chosen: the text above them scrolls into view, and the highlight stays on them.
      const first = rows().length - answers.length, picked = await listDialog('Check', rows, { hint: 'enter choose · esc cancel', selected: first, answers: answers.length });
      if (!picked) return;
      answer = answers[picked.index - (rows().length - answers.length)]?.[0] ?? null;
    }
    return answerCheckWith(place, seen, answer);
  }
  // His answer to the check (checkSession), or a new goal from the Task of a session at work
  // (showTask). What he types is never lost to a refusal (the session started working since the
  // check opened, say): the editor opens again with it, and says why. A new goal for a session
  // at work starts from its goal and objectives as they are, so he adds or changes lines; saved
  // as it opened, it changes nothing, and its turn is not told again. Once it is taken, the
  // status line says when its turn is told, as that computer says it (takes).
  async function answerCheckWith(place, seen, answer) {
    const working = seen.working === true && Array.isArray(seen.objectives);
    const title = !Array.isArray(seen.objectives) ? 'New message' : `${answer === 'copy' ? 'Copy with a new goal' : 'New goal'} (objectives below it, one per line)`;
    const name = `"${firstWords(seen.title || 'Session', 40)}"`;
    // What it shows on its Artifacts tab comes with it, a line each, to change or remove too.
    const shows = Array.isArray(seen.artifacts) ? seen.artifacts : [];
    let text = working ? [seen.goal, ...seen.objectives.map(row => row.text), ...shows.map(artifactText)].map(row => String(row ?? '').trim()).filter(Boolean).join('\n') : '', note = '', kept = null;
    for (;;) {
      if (answer !== 'done') { text = await editText(title, text, { note }); if (text === null || !text.trim()) return; }
      if (working && answer === 'goal' && sameGoal({ goal: seen.goal, objectives: seen.objectives.map(row => row.text), artifacts: shows }, readGoal(text, shows))) return setMessage(`Nothing changed: ${name} keeps its goal.`);
      try {
        if (place.remote) kept = await remoteApp.check(place.remote, answer, text);
        else { if (controller && place.root === controller.repo.root) controller.writable(); kept = answerCheck(place.repo, place.root, readTask(place.repo, String(place.task.id)), answer, text); if (['done', 'copy'].includes(answer)) takeBackBotNotes(place.root, place.task.id); if (answer !== 'done') conduct(); }
        break;
      } catch (error) { if (answer === 'done') throw error; note = error.message; }
    }
    const told = answer === 'goal' && kept?.working === true && Array.isArray(seen.objectives);
    if (told && !place.remote && kept.artifacts !== true) goalSent = { root: place.root, id: place.task.id, name, since: Date.now() - 1000 };
    setMessage(answer === 'done' ? `Moved ${name} to Done.` : answer === 'goal' && kept?.artifacts === true ? `${name} has the new artifacts; its progress stays.` : told ? `${name} has the new goal. ${goalToldWords(kept.takes)}` : answer === 'goal' ? `${name} carries on${Array.isArray(seen.objectives) ? ' with the new goal' : ''}.` : `Moved ${name} to Done. Its copy starts in Sessions.`);
  }
  // The checklist of a session's work (lib/checklist.mjs) under its own heading, each row with
  // ✓ when it is done and its line of evidence under it. An older computer sends none.
  // What its Task asked to see (lib/artifacts.mjs), each with how often it refreshes and the script
  // that does it, as kept here. elsewhere: the computer that keeps a session there, which runs its scripts.
  function sayArtifacts(lines, say, rows, elsewhere = null) {
    if (!Array.isArray(rows) || !rows.length) return;
    lines.push(''); say('Artifacts', 'muted', true);
    for (const row of rows) {
      say(`  · ${row.title}: ${row.shows || row.title} · ${everyText(row.every)}`);
      if (!row.every) continue;
      // The script is code: drawn as written on a shaded block, never as Markdown.
      if (typeof row.script === 'string' && row.script) { say(`    Refresh script, ${everyText(row.every)}:`, 'muted'); lines.push({ text: codeBlock(row.script), tone: 'muted', bold: false, whole: true }); }
      else say(row.script ? `    Its refresh script is kept on ${elsewhere ?? 'its computer'}.` : '    No refresh script yet: the session writes one.', 'muted');
    }
  }
  function sayChecklist(lines, say, rows) {
    if (!Array.isArray(rows) || !rows.length) return;
    lines.push(''); say('Checklist', 'muted', true);
    for (const row of rows) { say(`  ${row.met ? '✓' : '·'} ${row.text}`, row.met ? 'green' : 'text'); if (row.evidence) say(`    ${row.evidence}`, 'muted'); }
  }
  // The open session's Task, from the Task in its header (a click on it, or Ctrl+T): its goal,
  // each objective with the agent's mark and its line of evidence, then the checklist of its
  // work from ELU's own records (lib/checklist.mjs): what its state used to say in the header.
  // A session with no Task of its own shows the same, its first message as its goal and no
  // objectives. When it waits for the owner's check, Check under it goes on to that check
  // (checkSession). One on another computer of mine is read from there; when that computer
  // cannot say it (ELU before 0.1.26, or it is offline), or the run has not started there yet,
  // what its list and its chat told. A message to the session that waits (its queued row, or a
  // follow-up that was blocked) leaves the header on the session: Task opens the session's Task.
  // A Task that waits for his yes says so with y and n, which answer it here as on its row.
  // One at work with a Task (working) takes a new goal from here, its turn not stopped (New goal).
  async function showTask() {
    const there = remoteHere();
    let seen = null, place = null, note = '', checks = true;
    if (there) {
      const v = there.remote ?? {}, started = !there.queued && Boolean(there.ref || there.listed);
      place = started ? { remote: remoteApp.placeOf(there), title: v.title } : null;
      const older = started ? remoteApp.checkLine(v.machine) : null;
      if (older) { note = older; checks = false; } else if (started) { try { seen = await remoteApp.check(place.remote, null, '', { look: true }); } catch (error) { note = error.message; checks = false; } }
      if (!seen) {
        const plan = v.plan && Array.isArray(v.plan.objectives) ? v.plan : null;
        seen = { title: v.title, goal: plan ? plan.goal : v.title, objectives: plan ? plan.objectives.map((text, index) => ({ text, met: (plan.met ?? []).includes(index + 1), evidence: typeof plan.evidence?.[index] === 'string' && plan.evidence[index] ? plan.evidence[index] : null })) : null, checklist: toldChecklist(v, { there: `@${there.machine}` }), waits: false, ...(plan?.by === 'owner' ? { ownGoal: true } : {}), ...(Array.isArray(plan?.artifacts) ? { artifacts: plan.artifacts.map(row => ({ title: row.title, shows: row.shows, every: row.every, script: row.script !== null })) } : {}) };
      }
      if (there.check === true && started) seen.waits = true;
      if (there.label === 'TASK') seen.proposed = true;
      // Someone else's session (seeOnly) is read here: what waits, waits for its owner.
      if (there.seeOnly) { seen.owner = there.owner; checks = false; }
    } else {
      if (!controller || view !== 'chat' || !selectedId) throw new Error('Open a session to see its Task.');
      const task = controller.snapshot().tasks.find(row => row.id === selectedId);
      if (!task) throw new Error('This session has not started yet. Try again once it has.');
      seen = taskView(controller.repo, task, { approvals: approvalsFor(task), scripts: true });
      place = { repo: controller.repo, root: controller.repo.root, task };
      checks = !viewOnly();
    }
    // written: the owner's own words, shown as he typed them (no Markdown drawn): the session's
    // name, and its goal and objectives where he gave them (ownGoal; with no Task, his first
    // message, which an older computer does not mark).
    const lines = [], say = (text, tone = 'text', bold = false, written = false) => { lines.push({ text, tone, bold, written }); };
    const his = seen.ownGoal === true || !Array.isArray(seen.objectives);
    // y and n answer a Task that waits where its row's y and n do: a session here this window
    // may write to, or one on another computer whose row says its Task waits.
    const answers = seen.proposed === true && !seen.owner && (there ? there.label === 'TASK' : !viewOnly());
    const whose = seen.owner ? `${seen.owner}'s` : 'your';
    say(seen.title || 'Session', 'text', true, true);
    if (seen.waits) say(`It waits for ${whose} check.`, 'orange');
    if (seen.proposed) say(answers ? 'Its Task waits for your approval: y approves it, n rejects it.' : `Its Task waits for ${whose} approval.`, 'orange');
    if (note) say(note, 'muted');
    const goal = String(seen.goal ?? '').trim();
    // The goal whole, however long: the dialog scrolls.
    if (goal) { lines.push(''); say('Goal', 'muted', true); lines.push({ text: goal, tone: 'text', bold: false, whole: true, written: his }); }
    if (Array.isArray(seen.objectives) && seen.objectives.length) {
      lines.push(''); say(`Objectives · ${seen.objectives.filter(row => row.met).length} of ${seen.objectives.length} met`, 'muted', true);
      for (const row of seen.objectives) { say(`  ${row.met ? '✓' : '·'} ${row.text}`, row.met ? 'green' : 'text', false, his); if (row.evidence) say(`    ${row.evidence}`, 'muted'); }
    }
    sayArtifacts(lines, say, seen.artifacts, there ? `@${there.machine}` : null);
    sayChecklist(lines, say, seen.checklist);
    // The model's words show their Markdown: the goal whole, every other line its words (lib/markdown.mjs).
    // Each kept for a copy, which gives what was written (keepCopies).
    const wrapped = () => { const width = Math.min(88, screen.width - 4) - 6; return lines.flatMap(row => { if (typeof row === 'string') return [row]; const drawn = markdownRows(row.written ? asWritten(plainText(row.text)) : plainText(row.text), width, { colour, tone: row.tone, bold: row.bold, inline: !row.whole }); keepCopies(drawn.join('\n'), drawn); return drawn; }); };
    const check = seen.waits && checks;
    const newGoal = !check && checks && !seen.owner && !seen.proposed && seen.working === true && Array.isArray(seen.objectives) && seen.objectives.length > 0 && Boolean(place);
    // Opened while typing (Ctrl+T or a click on Task): Esc goes back to the message box, from the
    // Task and from the check after it, which for another computer opens once that one answers.
    // The dialog ends the typing, which by itself would leave for the list as Esc there does.
    const from = screen.focused === ask && ask._reading ? ask : null;
    try {
      nextOrigin = from;
      const yn = answers ? { keys: ['y', 'n'] } : {}, keysHint = answers ? 'y approve · n reject · ' : '';
      const picked = await listDialog(TASK_WORD, wrapped, check ? { hint: `enter check · ${keysHint}↑↓ scroll · esc close`, button: 'Check', ...yn } : newGoal ? { hint: 'enter new goal · ↑↓ scroll · esc close', button: 'New goal' } : { hint: `${keysHint}↑↓ scroll · esc close`, ...yn });
      nextOrigin = from;
      if (picked?.key && answers) {
        if (there) setMessage(await remoteApp.action(there, picked.key === 'y' ? 'accept' : 'decline'));
        else await decideTask(controller.repo.root, place.task, picked.key === 'y');
      } else if (picked?.button && check) await checkSession(place);
      else if (picked?.button && newGoal) await answerCheckWith(place, seen, 'goal');
    } finally { nextOrigin = null; }
  }
  // /done: the check of the open session, the selected row in Sessions, here or on a computer
  // of mine, or the selected card under Needs you on the Kanban.
  async function checkCurrent() {
    const there = remoteHere();
    if (there) {
      if (there.seeOnly) throw new Error(`It is ${there.owner}'s session: only ${there.owner} can check it.`);
      const older = remoteApp.checkLine(there.remote?.machine); if (older) throw new Error(older);
      if (there.queued || !there.ref && !there.listed) throw new Error('This session has not started yet. Try again once it has.');
      return checkSession({ remote: remoteApp.placeOf(there), title: there.remote?.title });
    }
    if (view === 'kanban') { const index = kanbanLists.indexOf(lastPane.kanban); return kanbanAction(index < 0 ? 2 : index, 'check'); }
    if (!controller && view !== 'tasks') throw new Error(NO_PROJECT);
    if (view === 'chat') {
      openStarted();
      const task = selectedId && controller.snapshot().tasks.find(row => row.id === selectedId);
      if (!task && (selectedRequest || following)) throw new Error('This session has not started yet. Try again once it has.');
      if (task) return checkSession({ repo: controller.repo, root: controller.repo.root, task });
    }
    const row = view === 'tasks' ? selectedBoardRow() : null;
    if (row?.kind === 'task') return checkSession({ repo: projectFolder(row.root), root: row.root, task: row.task });
    throw new Error('Open a session to check it. On the Kanban, Shift+→ checks a card under Needs you.');
  }
  // Closing hides a session from Sessions and puts it in Kanban's Done; its history and
  // worktree stay. A new message opens it again.
  function closeTask(location, task, after) {
    if (['running', 'preparing'].includes(task.state)) throw new Error(`${sessionName(task)} is running. Stop it first with /stop.`);
    closeSession(location, task.id); after?.();
    takeBackBotNotes(location.root, task.id);
    setMessage(`Archived ${sessionName(task)}. /archived lists it; a new message brings it back.`);
  }
  // What the bot that oversees the sessions sent a session and no turn read yet goes when he
  // archives it or moves it to Done, as with his stop (lib/orchestrator-actions.mjs
  // takeBackNotes): it never writes to one he closed. Read only when it sent something.
  function takeBackBotNotes(root, id) {
    let rows = []; try { rows = pendingRequests(root); } catch { rows = []; }
    if (!rows.some(row => typeof row.overseer === 'string' && row.state === 'queued' && String(row.continuationTaskId) === String(id))) return;
    import('./orchestrator-actions.mjs').then(actions => actions.takeBackNotes(root, String(id))).catch(() => { /* The session refuses them when they come (ProjectController.ask). */ });
  }
  // Asks for a session's name: one line of up to TITLE_MAX characters. The box opens with
  // the name only when someone chose it (the owner, an approved Task, the model), never
  // with the request. A name that is refused stays in the box. An empty answer takes the
  // owner's name away: the session goes back to its Task's title, the model's name, or the
  // first words of what was asked.
  async function renameTask(location, task, given = null) {
    const own = typeof task.title === 'string' ? task.title.trim() : '';
    for (let typed = own.length <= TITLE_MAX ? own : ''; ;) {
      const answer = given ?? await prompt('Rename session', `One line of up to ${TITLE_MAX} characters. It shows in the list and the title. Leave it empty to go back to the name ELU gave it.`, typed, { check: text => nameProblem(text) ?? notCommand(text, typed) });
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
      setMessage(`Archived ${named(shown ?? row.remote.title)} on @${row.machine}. /archived there lists it.`); return;
    }
    const own = row.named && typeof row.remote.title === 'string' ? row.remote.title.trim() : '', opened = own.length <= TITLE_MAX ? own : '';
    const answer = given ?? await prompt('Rename session', `One line of up to ${TITLE_MAX} characters. It shows in the list and the title. Leave it empty to go back to the name ELU gave it.`, opened, { check: text => nameProblem(text) ?? notCommand(text, opened) });
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
    const rows = id ? pendingRequests(root) : [], pending = rows.filter(row => row.continuationTaskId === String(id) && row.state === 'queued' && !row.standupFor && !row.overseer && !sentByElu(row.goal));
    // What the bot that oversees the sessions sent this session and no turn read yet goes with
    // the stop (lib/orchestrator-actions.mjs takeBackNotes). Read only when it sent something.
    let notes = 0;
    if (rows.some(row => typeof row.overseer === 'string' && row.state === 'queued' && String(row.continuationTaskId) === String(id))) { try { notes = (await import('./orchestrator-actions.mjs')).takeBackNotes(root, id); } catch { notes = 0; } }
    const noted = notes ? ` ${notes > 1 ? `${notes} waiting notes of the bot that oversees your sessions were` : 'The waiting note of the bot that oversees your sessions was'} taken back.` : '';
    // A new goal of his is not taken back (waitingMessage): ↑ is named for the others alone.
    const backs = pending.filter(row => !row.goalChange).length, waiting = pending.length > 1 ? `Your ${pending.length} waiting messages go` : 'Your waiting message goes', back = backs > 1 ? '↑ takes one back' : backs ? '↑ takes it back' : '';
    // A turn of this session the conductor is starting this instant: its request says so
    // before the session says it is working. The stop is sent all the same, and the conductor
    // reads it at its next look, when the turn is there to stop.
    const starting = rows.find(row => row.continuationTaskId === String(id) && row.state === 'starting');
    if (task && (['running', 'preparing'].includes(task.state) || starting)) {
      // The turn that is being stopped: its request, or the time it began when it has none.
      const turn = `${root}\0${task.id}\0${starting?.id ?? rows.find(row => row.taskId === task.id && row.state === 'running')?.id ?? task.activeSince ?? ''}`, again = stopAsked === turn;
      stopAsked = turn; sendCommand({ type: 'stop', root, taskId: task.id }); conduct();
      setMessage(`${pending.length ? `${again ? 'Still stopping' : 'Stopping'}. ${waiting} as soon as it stops${pending.length > 1 ? ', in order' : ''}${again || !back ? '.' : ` · ${back}.`}` : 'Stopping. Changes and chat history are kept.'}${noted}`); return;
    }
    // No turn runs and its long jobs do (lib/jobs.mjs): the stop ends them, and asks nothing new.
    const jobs = task ? sessionJobsNow(root, task.id, { fresh: true }).filter(job => job.state === 'running') : [];
    if (jobs.length) { sendCommand({ type: 'stop', root, taskId: task.id }); conduct(); setMessage(`${jobs.length === 1 ? `Stopping job ${jobs[0].name}.` : `Stopping its ${jobs.length} jobs.`}${noted}`); return; }
    // Nothing runs, and what waits goes now.
    if (pending.length) { conduct(); setMessage(`Nothing is running in this chat. ${waiting} next${pending.length > 1 ? ', in order' : ''}${back ? ` · ${back}` : ''}.${noted}`); return; }
    if (notes) { setMessage(noted.trim()); return; }
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
  // A quick answer of Auto model's takes none: a message sent while it works starts when it ends.
  function notSaidYet(task, row) {
    return ['running', 'preparing'].includes(task?.state) && !task.quickTurn && task.activeInbox !== true && task.activeDeaf !== true && row.state === 'queued' && typedRequest(row) && !row.back && (row.bot ?? null) === (botOfKey(task.activeRole ?? '') ?? null);
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
    return rows.filter(row => row.continuationTaskId === task.id && row.state === 'queued' && !row.scheduled && !row.origin && !row.standupFor && !row.overseer);
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
    const backs = rows.filter(row => !row.goalChange).length;
    setMessage(`Sending now. This turn stops and your message${many ? 's start' : ' starts'} the next one${backs ? ` · ↑ takes ${backs > 1 ? 'one' : 'it'} back` : ''}.`);
    return true;
  }
  // The newest message the owner sent to a session that has not started yet: the one Up in
  // the message box takes back. A bot's scheduled turn is not his to take back here, and
  // neither is a new goal of his (goalChange, takeBack): it is the Task's goal already
  // (lib/owner-check.mjs keepOpen), and a new goal from the Task changes it again. A note the
  // bot that oversees the sessions queued (overseer) is the bot's: /orchestrator undo takes it back.
  function waitingMessage(id, rows) {
    return rows.filter(row => row.continuationTaskId === String(id) && row.state === 'queued' && !row.scheduled && !row.origin && !row.standupFor && !row.overseer && !sentByElu(row.goal))
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
      const root = controller.repo.root, id = String(selectedId); row = waitingMessage(id, pendingRequests(root).filter(value => !value.goalChange));
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
    await prompt('Session details: diff / checks / review / log', [sessionGoal(task), `State: ${stateText(task)}`, `PR: ${task.pr ?? 'not published'}`, `Question: ${response?.question ?? 'none'}`, errorText(task), '\nRESPONSE', response?.summary ?? '', '\nREQUESTS', ...(task.messages ?? []).map(row => row.bot ? `${tagged(`@${row.bot}`, modelTag(wroteIt(row))).title}: ${row.text}` : row.to ? `You → ${row.to}: ${row.text}` : teammateText(row) ? `${row.from}: ${teammateText(row)}` : row.text), '\nDIFF', data.diff || '(no diff)', '\nCHECKS', ...data.checks.map(row => `${row.name}: ${row.status} ${(row.details ?? []).join('; ')}`), '\nREVIEW', ...data.reviews.flatMap(row => [`${tagged(roleLabel(row.role ?? 'reviewer'), modelTag(wroteIt(row))).title} round ${row.round}: ${row.result.summary}`, ...row.result.comments.map(comment => `${comment.severity}: ${comment.body}`)]), '\nLOG', ...data.logs.map(log => `${roleLabel(log.role)}:\n${log.text}`)].join('\n'), '', { read: true });
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
  // What a click under a message that waits in the chat does (drawUnsent): Yes, or Send again,
  // queues it as r in Sessions does; Dismiss takes it away as s does; Reply makes the message
  // box answer whoever sent it (replying), and Enter there sends that answer (sendReply).
  const replyNow = () => replying && view === 'chat' && !remoteHere() && controller?.repo.root === replying.root && String(selectedId) === String(replying.taskId) ? replying : null;
  async function waitingAction(button, word) {
    const root = controller?.repo.root, request = (snapshot.queue ?? []).find(row => row.id === button.id);
    if (!root || !request || !['waiting', 'blocked'].includes(request.state)) throw new Error('That message is no longer waiting.');
    if (word === 'Reply') { replying = { ...button, root }; focusInput(); draw(); return; }
    if (replying?.id === request.id) replying = null;
    if (word === 'Dismiss') { await removeHeld({ root, requests: [request] }); setMessage('Removed.'); return; }
    if (!await homeOk(root, button.taskId)) return;
    if (!retryRequest(root, request.id)) throw new Error('That message is no longer waiting.');
    conduct(); setMessage(asksYes(request) ? YES_SAID : 'Queued again.');
  }
  // His answer goes in the session's chat, where whoever sent the message reads it, on this
  // computer and every one that watches the session (lib/waiting-replies.mjs); the session's
  // model never reads it. The message it answers is taken away, as Dismiss takes it.
  async function sendReply(to, text) {
    const request = (snapshot.queue ?? []).find(row => row.id === to.id);
    if (!request || !['waiting', 'blocked'].includes(request.state)) throw new Error('That message is no longer waiting, so there is nothing to reply to.');
    recordReply(projectFolder(to.root), to.taskId, { text, who: to.who, about: requestGoal(request).split('\n')[0] });
    await removeHeld({ root: to.root, requests: [request] });
    setMessage(`Replied to ${to.who}. Their message will not run.`);
  }
  // A click on the count of messages that wait, in the session's tabs, shows the first of them
  // in the chat, at the top of the pane.
  function jumpToWaiting() {
    if (sessionView !== 'chat') showChat();
    const parts = partsShown ?? [], target = parts.findIndex(part => /^\0(?:unsent|held)\0/.test(part.key) || part.key.startsWith('waiting\0')), ftor = activity._clines?.ftor;
    if (target < 0 || !ftor?.length) return;
    let start = 0; for (let at = 0; at < target; at++) start += partLines(parts[at]);
    const line = ftor[Math.min(ftor.length - 1, start)]?.[0] ?? 0;
    activity.childBase = Math.max(0, Math.min(line, activity.getScrollHeight() - (activity.height - activity.iheight)));
    draw();
  }
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
  // Clean-up of archived sessions (x on one, x on an Archived heading, /archived clean): one
  // question, Learn, then delete or Delete, and one more when some hold work that is on no
  // remote. Learn first reads them in one read-only run for each project and saves what the
  // owner taught in them to its memory (projects.mjs learnArchived); if that does not work,
  // nothing is deleted. Esc stops that run, and the line it shows says nothing is deleted.
  // Archived sessions are each computer's own: this cleans up this computer's only, and another
  // computer of mine cleans up its own there.
  let learning = null;
  const cancelLearn = () => { if (!learning || learning.signal.aborted) return false; learning.abort(); return true; };
  const archivedRows = () => boardRows(dash?.projects ?? [], Date.now(), { archived: true }).filter(row => row.kind === 'task' && row.archived);
  const firstOf = error => String(error?.message ?? error).split('\n')[0];
  async function cleanArchived(rows) {
    rows = rows.filter(row => row.kind === 'task');
    if (!rows.length) return setMessage('No archived sessions.');
    if (learning) throw new Error('A clean-up is reading its sessions. Esc stops it.');
    if (controller && rows.some(row => row.root === controller.repo.root)) controller.writable();
    const live = rows.find(row => ['running', 'preparing'].includes(row.task?.state));
    if (live) throw new Error(`${sessionName(live.task)} is running. Stop it first.`);
    const one = rows.length === 1, it = one ? 'it' : 'them';
    const picked = await listDialog('Clean up', [ink('Learn, then delete', 'text', colour), ink('Delete', 'text', colour)], { notes: [`Deletes ${one ? sessionName(rows[0].task) : `${rows.length} archived sessions`} for good.`, `Learn first saves what you taught in ${it} to the project's memory.`], hint: 'enter choose · esc cancel' });
    if (!picked) return;
    // Work on no remote: commits not pushed, files not committed. Kept, or deleted too.
    const lost = rows.map(row => { try { return unpushedWork(projectFolder(row.root), readTask(projectFolder(row.root), row.id)); } catch { return { commits: 0, edits: 0 }; } });
    const holding = lost.filter(value => value.commits + value.edits), total = { commits: holding.reduce((sum, value) => sum + value.commits, 0), edits: holding.reduce((sum, value) => sum + value.edits, 0) };
    let keep = false;
    if (holding.length) {
      const asked = await listDialog('Work not pushed', [ink('Keep it', 'text', colour), ink('Delete it too', 'text', colour)], { notes: [`${one ? 'It has' : `${holding.length} of them ${holding.length === 1 ? 'has' : 'have'}`} ${unpushedText(total)}.`, 'Kept work stays in its folder and on its branch.'], hint: 'enter choose · esc cancel' });
      if (!asked) return;
      keep = asked.index === 0;
    }
    const learn = picked.index === 0, saved = [], gone = [], kept = [], failed = [];
    if (learn) {
      // A stopped lessons run saves nothing and deletes nothing (learnArchived).
      const stopper = learning = new AbortController(), said = () => setMessage('Stopping. Nothing is deleted.');
      setMessage(`Reading ${one ? sessionName(rows[0].task) : `${rows.length} sessions`} for what you taught. Esc stops.`); draw();
      stopper.signal.addEventListener('abort', said);
      try { for (const root of [...new Set(rows.map(row => row.root))]) saved.push(...await learnArchived(projectFolder(root), rows.filter(row => row.root === root).map(row => row.id), { signal: stopper.signal })); }
      catch (error) { throw new Error(`Nothing was deleted: ${stopper.signal.aborted ? 'stopped before the lessons were saved.' : firstOf(error)}`); }
      finally { stopper.signal.removeEventListener('abort', said); if (learning === stopper) learning = null; }
    }
    for (const [index, row] of rows.entries()) {
      try { const result = deleteSession(projectFolder(row.root), row.id, { keep, seen: lost[index] }); gone.push({ name: sessionName(row.task), root: row.root, id: row.id }); if (result.kept) kept.push(result.kept); }
      catch (error) { failed.push(`${sessionName(row.task)}: ${firstOf(error)}`); }
    }
    // The session open beside the list is gone: the list shows the row the cursor moves to.
    if (controller && gone.some(row => row.root === controller.repo.root && row.id === selectedId)) { selectedId = null; selectedRequest = null; following = null; view = 'tasks'; }
    const said = [gone.length ? `Deleted ${gone.length === 1 ? gone[0].name : `${gone.length} sessions`}.` : '', kept.length ? `Kept ${kept.length === 1 ? `its work on ${kept[0].branch ?? kept[0].worktree}` : `the work of ${kept.length} on their branches`}.` : '', ...failed.map(line => `Not deleted: ${line}`)].filter(Boolean);
    // With Learn the dialog says it all, and the line under it says nothing more.
    setMessage(learn ? '' : said.join(' '));
    if (learn) await listDialog('Saved to memory', (saved.length ? saved.map(line => line.replace(/^Saved to memory: /, '')) : ['Nothing new to keep.']).map(line => ink(line, 'text', colour)), { notes: said, hint: 'enter close', button: 'OK' });
  }
  // Task keys act on the selected row in any project without opening it.
  async function boardAction(action) {
    const row = selectedBoardRow();
    // v shows the session's artifacts beside the list, here or on another computer, and moves
    // into them, as d does its changes. Esc then goes back to where v was typed.
    if (row && action === 'artifacts') {
      if (!['task', 'remote'].includes(row.kind)) throw new Error('Choose a session to see its artifacts.');
      const from = screen.focused === activity ? activity : board;
      if (row.kind === 'remote') { if (remoteHere()?.key !== row.key) draw(); }
      else if (view !== 'chat' || selectedId !== row.id || controller?.repo.root !== row.root) await openRow(row);
      showArtifacts({ focus: true }); artifactsFrom = from; return;
    }
    // d shows what a session on another computer changed in its own tab, as a session here does.
    // A cursor that just moved onto the row is the pane's session from the next draw on, so that draw comes first.
    // Esc then goes back to where d was typed: its chat beside the list, or its row.
    if (row?.kind === 'remote' && action === 'diff') { const from = screen.focused === activity ? activity : board; if (remoteHere()?.key !== row.key) draw(); showChanges({ focus: true }); changesFrom = from; return; }
    // A session of someone else's computer on a shared project is read here, never worked in.
    if (row?.kind === 'remote' && row.seeOnly && !['open', 'new'].includes(action)) throw new Error(seeOnlyLine(row));
    // x cleans up this computer's archived sessions only: another computer of mine cleans up its own.
    if (row?.kind === 'remote' && action === 'clean') throw new Error('x cleans up an archived session. /archived lists them.');
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
        // A refresh script to keep shows whole, as written, and pages with PgUp and PgDn.
        const who = approval.role && approval.role !== 'lead' ? roleLabel(approval.role) : row.task && row.root === controller?.repo.root ? workingModel(row.task) : 'The model', keys = `${approvalKeys(session, approval)} · esc later`;
        // The note, answer, goal, card or line the bot that oversees asks to send shows whole (askedWhole).
        const whole = askedWhole(approval), said = whole ? `${summary}\n\n${whole.label}\n${whole.text}` : summary;
        const body = approval.script ? `${asWritten(`${who} wants to:\n${summary}`)}\n\n${codeBlock(blockText(approval.script.text, { trusted: true }))}\n\n${keys}` : `${who} wants to:\n${said}\n\n${keys}`;
        const key = (await prompt('Needs you', body, '', { keys: [...(offersFull(session, approval) ? ['y', 'n', 'f'] : ['y', 'n']), ...(offersAlways(session, approval) ? ['a'] : [])], markdown: Boolean(approval.script), trusted: Boolean(approval.script) }))?.trim().toLowerCase();
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
    // The Archived heading: x cleans up every archived session listed under it.
    if (row.kind === 'archive') { if (action === 'clean') return cleanArchived(row.rows); throw new Error('x, then Enter, cleans up every archived session.'); }
    if (action === 'clean') { if (row.kind !== 'task' || !row.archived) throw new Error('x cleans up an archived session. /archived lists them.'); return cleanArchived([row]); }
    // c takes away whatever the list shows: a teammate's message is declined, and they are told.
    if (action === 'close' && (row.kind === 'peer' || peerIncoming(row))) return decidePeer(row, 'decline');
    // t shows the Schedule tab of a row a schedule runs, beside the list, and moves into it. Esc then goes back to where t was typed.
    if (action === 'schedule') {
      if (!row.onSchedule) throw new Error('t shows the schedule of a session a schedule runs.');
      if (row.kind === 'schedule') return showSchedule({ focus: true });
      const from = screen.focused === activity ? activity : board, open = row.kind === 'task' ? selectedId === row.id && !selectedRequest : selectedRequest?.id === row.request.id;
      if (view !== 'chat' || !open || controller?.repo.root !== row.root) await openRow(row);
      showSchedule({ focus: true }); scheduleFrom = from; return;
    }
    if (row.kind === 'schedule') return scheduleAction(row, action);
    const live = row.kind === 'task' && ['running', 'preparing'].includes(row.task.state);
    // A session whose message of yours did not run: r sends that message again, s removes it.
    if (row.kind === 'task' && row.request && !live && !row.archived) {
      if (action === 'retry') { if (!await homeOk(row.root, row.id)) return; const yes = asksYes(row.request); if (!retryRequest(row.root, row.request.id)) throw new Error('That message is no longer waiting.'); conduct(); setMessage(yes ? YES_SAID : 'Queued again.'); return; }
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
      // No turn runs and its long jobs do (lib/jobs.mjs): its row is under Running, and s ends them as /stop in its chat does.
      const jobs = !live && row.kind === 'task' ? sessionJobsNow(row.root, row.id, { fresh: true }).filter(job => job.state === 'running') : [];
      if (jobs.length) { sendCommand({ type: 'stop', root: row.root, taskId: row.id }); conduct(); setMessage(jobs.length === 1 ? `Stopping job ${jobs[0].name}.` : `Stopping its ${jobs.length} jobs.`); return; }
      if (!live) throw new Error(row.task ? `${sessionName(row.task)} is not running.` : 'That session is not running.');
      sendCommand({ type: 'stop', root: row.root, taskId: row.id }); conduct(); setMessage(`Stopping ${sessionName(row.task)}. Changes and chat history are kept.`); return;
    }
    if (action === 'retry') {
      if (row.kind === 'request') {
        if (!await homeOk(row.root, row.request.continuationTaskId)) return;
        const lower = underDefault(row.request), yes = asksYes(row.request); if (lower) updateRequest(row.root, row.request.id, lower, { from: ['blocked', 'waiting'] });
        if (!retryRequest(row.root, row.request.id)) throw new Error('Only a blocked or saved request can be retried.');
        conduct(); setMessage(lower ? `Queued again, with ${LABELS[lower.permissions]}, the default now.` : yes ? YES_SAID : 'Queued again.'); return;
      }
      if (!['blocked', 'stopped', 'unverified'].includes(row.task.state)) throw new Error('Retry works on blocked, stopped, or unverified work.');
      // The last message to the lead goes again. A session that only wrote to a bot sends that message to the bot again.
      // One that works with a bot (sessionWorker) sends its last message to that bot, or with no @name, again to it.
      // ELU's own lines (a from with no teammate's key: what stopping ended, a branch that moved, a Standup's) were no one's message, so none goes again as the owner's.
      const yours = (row.task.messages ?? []).filter(value => !value.bot && !(value.from && !value.peer && !value.origin?.peer)), worker = (() => { try { return sessionWorker(row.task, { waiting: pendingRequests(row.root), find: savedBot }); } catch { return null; } })(), last = yours.findLast(value => !value.to || Boolean(worker) && value.to === `@${worker}`) ?? yours.at(-1);
      // A teammate's message is theirs to send again: sent from here it would read as the owner's.
      if (last?.peer || teammateText(last)) throw new Error(`That message is from ${last.from ?? 'a teammate'}. Ask them to send it again, or write your own in the session.`);
      if (!await homeOk(row.root, row.id)) return;
      const again = last?.to ? last.to.replace(/^@/, '') : last?.toModel === true ? null : worker;
      // retried: with Auto model it picks no step, so the turn goes on with the model that failed (lib/auto-model.mjs ownerWords).
      enqueue(row.root, last?.text ?? row.task.goal, { continuationTaskId: row.id, priority: 0, retried: true, ...(again ? { bot: again } : last?.toModel === true ? { toModel: true } : {}) }); conduct(); setMessage(`Retrying ${sessionName(row.task)}.`); return;
    }
    if (action === 'answer') {
      if (row.kind !== 'task') throw new Error('Choose a session to answer.');
      const response = row.task.reply?.outcome === 'needs_input' ? row.task.reply : row.task.result;
      const body = row.task.state === 'needs_input' ? `${response?.question ?? ''}\n${(response?.choices ?? []).join(' / ')}` : `Follow up in ${row.project}:\n${sessionGoal(row.task)}${live ? '\n\nIts turn is working: the turn reads this at its next step, or it is answered beside the turn at once.' : ''}`;
      const text = await prompt(`Answer ${sessionName(row.task)}`, body, ''); if (!text?.trim()) return;
      if (!await homeOk(row.root, row.id)) return;
      // It goes to the working bot the session works with (sessionWorker), such as @lead, and
      // else to the session's model, as before: never to a bot that only answers, such as @reviewer.
      let to = null; try { to = sessionWorker(row.task, { waiting: pendingRequests(row.root), find: savedBot }); } catch { to = null; }
      enqueue(row.root, text.trim(), { continuationTaskId: row.id, priority: 0, ...(to ? { bot: to } : {}) }); conduct(); setMessage(`Sent to ${sessionName(row.task)}.`); return;
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
    if (args.length && ['new', 'sessions', 'kanban', 'chats', 'projects', 'peers', 'usage', 'changes', 'artifacts', 'chat', 'details', 'publish', 'archive', 'setup', 'update', 'help', 'quit'].includes(name)) throw new Error(`Use ${command.usage}.`);
    if (name === 'quit') return quit();
    // A command that names a model waits for each vendor's own list, read beside the app.
    if (['model', 'agent', 'agents'].includes(name)) await readAllModels();
    // The files of a running app are not replaced under it: elu update runs once it is closed.
    if (name === 'update') return setMessage(UPDATE_IN_APP);
    if (name === 'help') return prompt('Commands', ['Six tabs: Sessions, Projects, Kanban, Chats, Bots, and Usage. Tab moves between areas; arrows move inside one.', 'Sessions: every session, in a list on the left. The selected one shows beside it. Enter moves into it and Esc moves back. PgUp and PgDn page its chat, from the message box too. d (or /changes) shows what it changed in place of its chat, also for a session on another computer: [ and ] move between its files, n and p between its changes, and Esc goes back. n or + New session starts one. c (or /archive) archives one; /archived lists them, and a new message brings one back. On a row, typing writes a message; a key is its letter, then Enter. While the model works, its chat shows what it does now, its newest thought or tool call, with the steps before it folded into one line above it; when it ends they all fold into one line above its reply. Ctrl-O or a click on such a line opens them. Task in its header (a click on it, or Ctrl+T) shows its Task: the goal, the objectives, and the checklist of its work, from what ELU knows of it.', 'Projects: every project; ● marks the active one. o makes another active; Enter opens its settings; n or + New project creates one. A project a teammate shares that is not on this computer is listed too: Enter opens its team board, c clones it here.', 'Kanban: this project’s sessions by column. n adds a task; Shift+→ on a To do task starts it. Nothing goes to Done until you check it: Shift+→ under Needs you, or /done in a session, shows its goal and objectives, then Done, a new goal, or a copy with one. A session at work on a Task takes a new goal too, from /done or its Task: its turn is not stopped, and is told at its next step, or when it ends if it takes no message. On a team, everyone who has the same repository sees every session in it, with who started it and on which machine. A project that works in several repositories has a board for each: Board picks one. /share off keeps a project off it.', 'Chats: channels and direct messages on the left, the open one’s threads beside them. Type to write to it. n makes a channel, m sets who is in it, /invite @name adds one teammate, x leaves it. /leave leaves the whole team; an admin’s /remove @name takes a teammate off it, and a new invite brings them back. On a teammate, h holds your replies and results to them until you send each one: y sends it, e edits it first, n drops it. o lets their answer or result continue the chat you asked from.', 'Other computers: an invite shares a project, and every computer on it sees and works on its sessions, yours and teammates’ alike, under that project’s /access on the computer that runs them. There is no /mine: nothing to mark. @name first in a new session starts it on that computer.', 'Bots: models with instructions you write once. n or + New bot makes one; Enter opens it; x removes it. Each shows in its own color; /bots color NAME COLOR changes it. In a session, @name alone adds one and @name with a message asks it; a teammate’s @name with a message asks them. Your next messages there go to that bot too, until you name another or start with @model. A bot that works, such as @lead, also gets your approval of its Task and a new goal.', 'Usage: your accounts and their plan usage, then the top agents by cost. Every account you add stays signed in: Enter on one makes new turns use it, a adds one, x forgets one. d shows a vendor’s details. Enter on an agent opens its session; t shows today or the last 7 days; r checks again.', 'Schedules: /schedule lists times such as in 5m, in 1h and daily 9:00. /schedule in 1h check the build saves one at once. Each run starts a new session that does not see the chat it was made in, named with the schedule’s message or the name you gave its last run, and archives its earlier runs: /archived shows them. In Sessions, ◷ marks the session a schedule runs, one row for each schedule. Its Schedule tab (t, or a click on it) shows when it runs, its message and its mode, and changes them; there r runs it now, p pauses it and x deletes it.', 'Permissions: each session runs as Ask for approval, Approve for me, or Full access. /permissions changes it.', 'Model: each session has its own. /model NAME changes it; the name it is shown by works too (/model opus 5.5), and a message after the name is sent on that model. Over a session on another computer, it changes that session’s model there. /model default NAME sets what new sessions start with, and /model add adds one by name. /model computer NAME sets this computer’s default. Both defaults are also rows in a project’s settings (Projects, Enter), and none in place of the name clears one.', 'Auto model: /model auto lets ELU pick the model for each step of a session, and a message after it is sent that way. A model or an effort you pick for the session turns it off. /model computer auto starts your new sessions on this computer with it. /model auto high sets the effort of its plans and edits, and /model auto quick grok where quick questions go (a vendor, home or off).', 'Agents: /agent add <model> puts another model in this session with no bot to write first. Words after the model say what it is for (/agent add sonnet you review my SQL), and --name NAME names it. @name with a message asks it; /agent remove <name> takes it out. /agent change <name> [model <model>] [effort <level>] changes the model or effort of @model or a bot, from its next turn; a click on a reply’s heading does too.', 'Type / to filter commands. Tab completes; Enter runs.', 'Start a message with ! to run a shell command in the project folder: !git status. In an open session the model sees it with your next message.', 'Mouse: drag to copy; a double click copies a word. Click in the message box to move the cursor.', '', ...COMMANDS.map(row => `${row.usage}\n  ${row.description}`), '', 'Examples:', '/model sonnet', '/model opus 5.5 fix the build', '/model default opus', '/model auto', '/permissions auto', '/permissions folders add ~/evals', '/archive'].join('\n'), '', { read: true });
    if (name === 'model') return modelCommand(args, command.text);
    // /permissions [mode] sets this session's mode; default <mode> sets what new sessions start with.
    if (name === 'budget') {
      const task = controller && view === 'chat' && !selectedRequest && selectedId ? controller.snapshot().tasks.find(row => row.id === selectedId) : null;
      if (!task) throw new Error('Open a session to see or change its spending limit.');
      if (isPeerRun(task.origin)) throw new Error(READ_ONLY_PEERS);
      if (args.length > 1) throw new Error(`Use ${command.usage}.`);
      const money = value => `$${Number(value).toFixed(2)}`;
      if (!args.length) { setMessage(budgetMessage(controller.budget(task.id))); return; }
      if (/^(off|none)$/i.test(args[0])) { controller.setBudget(task.id, null); setMessage(`This session has no spending limit.${task.state === 'blocked' ? ' Send your message again.' : ''}`); return; }
      if (!/^[$]?[0-9]+([.][0-9]+)?$/.test(args[0])) throw new Error('Use /budget with a number of dollars, such as /budget 20, or /budget off.');
      const dollars = Number(args[0].replace('$', ''));
      // A limit that still refuses its next turn says why, not to send the message again (lib/stop-line.mjs budgetBlocks).
      const blocks = budgetBlocks(controller.setBudget(task.id, dollars));
      setMessage(`This session may now spend up to ${money(dollars)}.${task.state !== 'blocked' ? '' : !blocks ? ' Send your message again.' : blocks.counted ? ' A run of unknown cost counts as all of it; only /budget off lets it go on.' : ' It has spent that already.'}`); return;
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
    // /keepgoing [on|off]: whether ELU starts this session again by itself while its Task's
    // objectives are not all met (lib/keep-going.mjs). With no word it says which.
    if (name === 'keepgoing') {
      if (!controller) throw new Error(NO_PROJECT);
      const task = view === 'chat' && !selectedRequest && selectedId ? controller.snapshot().tasks.find(row => row.id === selectedId) : null;
      if (!task) throw new Error('Open a session to see or change whether it keeps going.');
      if (isPeerRun(task.origin)) throw new Error(READ_ONLY_PEERS);
      if (args.length > 1 || args[0] && !/^(on|off)$/i.test(args[0])) throw new Error(`Use ${command.usage}.`);
      if (!args.length) { setMessage(keepsGoing(task, readKeepGoing(controller.repo, task.id)) ? KEEP_ON : KEEP_OFF); return; }
      controller.writable();
      const on = /^on$/i.test(args[0]); setKeepGoing(controller.repo, task.id, on); conduct();
      setMessage(on ? KEEP_ON : KEEP_OFF); return;
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
    // /standup starts a Standup session in this project and opens its chat (docs/standup.md).
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
      const there = remoteHere(); if (there) throw new Error(agentsThere(there));
      const task = openTask();
      if (!task && !composing()) throw new Error('Open a session first.');
      if (!args.length) { setMessage(`In this session: ${[autoNow() ? AUTO_NAME : task ? modelOf(task) : nameOf(modelNow()), ...chatBotsNow().map(bot => `@${bot}`)].join(', ')}. /agent add <model> adds another.`); return; }
      if (args[0] === 'remove' && args.length === 2) return chatBot('remove', args[1].replace(/^@/, '').toLowerCase());
      if (args[0] === 'change') return changeAgentCommand(args.slice(1));
      if (args[0] !== 'add' || args.length < 2) throw new Error('Use /agent add <model> [what it does] [--name NAME], /agent change <name>, or /agent remove <name>.');
      controller.writable();
      // An agent runs on one model: the word auto is Auto model's, and the session's alone.
      if (isAutoWord(args[1])) throw new Error(AUTO_LINES.reserved);
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
    // /orchestrator: how far the bot that oversees the sessions may go by itself, its caps and
    // its last five actions. A level word sets the level, which only the owner does: no turn
    // can. undo ID takes back one logged action where its kind allows, and a line of the
    // Organization section only after his yes (lib/orchestrator-actions.mjs). Read when typed.
    if (name === 'orchestrator') {
      const [{ orchestratorLines, undoAction }, { LEVELS, levelLines, setLevel }] = await Promise.all([import('./orchestrator-actions.mjs'), import('./orchestrator-settings.mjs')]);
      const words = args.map(word => word.toLowerCase());
      if (!words.length) {
        botCache.at = 0; const none = savedBots().some(botOversees) ? [] : ['', 'No bot of yours oversees your sessions now: these apply when one does.'];
        return prompt('Orchestrator', [...orchestratorLines(), ...none, '', '/orchestrator watch, suggest, act or run sets the level. /orchestrator undo ID undoes one action.'].join('\n'), '', { read: true });
      }
      if (words.length === 1 && LEVELS.includes(words[0])) { setMessage(levelLines(setLevel(words[0]))[0]); return; }
      if (words[0] !== 'undo' || words.length !== 2) throw new Error('Use /orchestrator, /orchestrator watch|suggest|act|run, or /orchestrator undo ID.');
      let undone = undoAction(words[1]);
      // A line of the Organization section goes only after his yes, as it came.
      if (!undone.done) {
        if (!await yes(`Undo ${undone.id}`, undone.asks, 'y/N')) { setMessage(`Nothing was undone: ${undone.id} stays.`); return; }
        undone = undoAction(words[1], { confirmed: true });
      }
      setMessage(`${undone.id}: ${undone.text}`); draw(); return;
    }
    if (name === 'projects') { showView('projects'); return; }
    if (name === 'usage') { showView('usage'); return; }
    if (['peers', 'invite', 'join', 'access', 'leave', 'remove', 'share'].includes(name)) return peerSlash(command);
    // /computer says what this computer is called on the owner's other computers and his
    // teammates' (its Sessions heading there, @name); /computer name NAME renames it here at once,
    // and they hear the new name within a tick (lib/peer/settings.mjs, nameComputer). No team is needed.
    if (name === 'computer') {
      // Where the whole line would not fit on one row of the status, it says it in fewer words.
      if (!args.length) { const { box, named } = computerName(); setMessage(fitLine(named ? `This computer is @${box}. /computer name NAME renames it, or default for its host name.` : `This computer is @${box}, from its host name. /computer name NAME renames it.`, `This computer is @${box}. /computer name NAME renames it.`)); return; }
      if (args[0].toLowerCase() !== 'name') throw new Error('Use /computer name NAME, or /computer name default.');
      const status = peerRead('peerStatus'), others = (status?.teams ?? []).flatMap(team => team?.members ?? []).filter(member => member?.key !== status?.key);
      const computer = nameComputer(args.slice(1).join(' '), { others });
      setMessage(!computer.named ? `This computer goes by its host name again: @${computer.box}.` : peerOn() ? fitLine(`This computer is @${computer.box} now. Every computer on your team sees it within seconds.`, `This computer is @${computer.box} now; the others see it within seconds.`) : `This computer is @${computer.box} now.`); return;
    }
    // /mine from before: every computer on a project works the same.
    if (name === 'mine') { setMessage(NO_MINE_LINE); return; }
    // /send PATH...: files from this computer to the session on another computer of mine under the cursor.
    if (name === 'send') {
      const here = remoteHere();
      if (!facade) throw new Error(PEER_MISSING);
      if (!here) throw new Error('Choose a session on another computer in Sessions, then /send PATH.');
      // Someone else's session is read here: nothing is offered or sent to it.
      if (here.seeOnly) throw new Error(seeOnlyLine(here));
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
      if (!args.length) return prompt('MCP servers', [all.length ? all.map(server => `${on.includes(server) ? '● on ' : '○ off'}  ${server}`).join('\n') : 'No MCP servers in Claude Code yet.', '', 'Your Claude Code servers (claude mcp list). Sessions use them all.', '/mcp add adds one, and keeps its key out of the chat. /mcp remove NAME removes one.', '/mcp off NAME turns one off for this project. Teammates\' asks never get them.'].join('\n'), '', { read: true });
      if (args.length !== 2 || !['on', 'off'].includes(args[0])) throw new Error('Use /mcp, /mcp add, /mcp remove NAME, /mcp on NAME or /mcp off NAME.');
      if (!controller) throw new Error(NO_PROJECT);
      setMessage(controller.setServer(args[1], args[0] === 'on')); return;
    }
    // /stop needs no project here when it stops a command or a session on another computer.
    if (name === 'stop') return stopCurrent(args[0]);
    // /done checks a session that ended, here or on another computer of mine (checkSession).
    if (name === 'done') return checkCurrent();
    // /rename and /archive over a session on another computer of mine rename and archive it there.
    const there = ['rename', 'archive'].includes(name) ? remoteHere() : null;
    if (there) return remoteEdit(there, name === 'archive' ? 'close' : 'rename', name === 'rename' && args.length ? args.join(' ') : null);
    if (name === 'artifacts') return showArtifacts();
    if (!controller) throw new Error(NO_PROJECT);
    if (name === 'changes') return showChanges();
    if (name === 'chat') return showChat();
    if (name === 'details') { const task = view === 'chat' && controller.snapshot().tasks.find(row => row.id === selectedId); if (!task) throw new Error('Open a session first.'); return showDetails(repo, task); }
    if (name === 'publish') return publishCurrent();
    if (name === 'takeover') {
      if (!controller) throw new Error('Open a project first.');
      if (!claim.readOnly) { setMessage('This window already makes the changes here.'); return; }
      if (takeProject(claim, Date.now(), true, 'takeover')) return;
      if (offered) return;
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
    if (name === 'archived') {
      if (!args.length) { toggleArchived(); return; }
      // This computer's archived sessions, the ones /archived lists.
      if (args.length === 1 && args[0].toLowerCase() === 'clean') return cleanArchived(archivedRows());
      throw new Error(`Use ${command.usage}.`);
    }
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
  // Where the dialog stands, with the height its layout asked for. Every draw works it out again,
  // moves it up from there when it makes room under it for the status line, and sets it once:
  // that is all a draw does to it. Its lines are not worked out or set again, and a place that
  // did not change is not set at all (blessed clears a box from its copy of the screen when it
  // moves), so a draw that renders nothing leaves the dialog's text on the screen as it was.
  function modalPlace() {
    const width = Math.min(88, screen.width - 4), height = Math.min(screen.height - 4, modal.preferredHeight ?? screen.height - 4);
    return { width, height, left: Math.floor((screen.width - width) / 2), top: Math.floor((screen.height - height) / 2) };
  }
  function placeModal() { Object.assign(modal, modalPlace()); }
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
  // read: the body is only to read, and Esc closes it. bar: what its keys do, as the key bar
  // names them ([key, does]); with keys and no bar, the body's last line says it ("y agrees ·
  // w writes to it instead"). A dialog of keys names Enter only where it acts: on the letter it
  // preselects, or as bar says. Its field's label names only what acts there.
  // markdown: the body holds a model's words (a thread in Chats), drawn as Markdown for the width
  // the dialog has, and again when it changes.
  function prompt(title, body, value = '', { keys = [], preselect = '', trusted = false, suggest = null, check = null, warn = null, live = null, read = false, bar = null, markdown = false } = {}) {
    if (modal) throw new Error('Close the current dialog first.');
    return new Promise(resolve => {
      openDialog();
      modal = dialogBox(title);
      const guided = Boolean(suggest || check || warn), all = suggest?.('') ?? [], drawn = markdown && !guided;
      modal.layout = () => { modal.preferredHeight = Math.max(12, String(body).split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(widthOf(line) / Math.min(80, screen.width - 12))), 0) + 7 + (guided ? all.length + 3 : 0)); }; positionModal();
      const text = blessed.box({ parent: modal, top: 1, left: 1, width: '100%-2', height: '100%-5', scrollable: true, keys: true, tags: guided || drawn, content: guided || drawn ? '' : blockText(body, { trusted }), scrollbar: { ch: '|' } });
      const show = () => text.setContent(drawn ? markdownText(blockText(body, { trusted }), Math.max(8, text.width - 1), { colour }) : blockText(body, { trusted }));
      if (drawn) { show(); modal.laid = show; }
      const said = bar ?? (keys.length ? hintPairs(String(body).trimEnd().split('\n').at(-1), [...keys, 'esc']) : []), letters = said.filter(([key]) => !['enter', 'esc'].includes(key));
      const enter = said.find(([key]) => key === 'enter') ?? (keys.length && preselect ? ['enter', letters.find(([key]) => key === preselect)?.[1] ?? preselect] : null);
      // The page keys are named while the body runs past what its box shows, by the key bar and
      // the field's label alike: both are worked out again on each draw, for the size it has then.
      const longer = () => { text.parseContent(); return (text._clines?.length ?? 0) > text.height - text.iheight; };
      const page = paged => paged ? ' / PgUp PgDn page' : '';
      const labelOf = paged => keys.length ? ` Press ${orList([...keys, ...(enter ? ['Enter'] : [])])} / Esc cancels${page(paged)} ` : read ? ` Esc closes${page(paged)} ` : suggest ? ' Enter submits / Tab completes / ↑↓ choose / Esc cancels ' : ` Enter submits / Esc cancels${page(paged)} `;
      let label = labelOf(longer());
      const field = blessed.textbox({ parent: modal, bottom: 1, left: 1, height: 3, width: '100%-2', border: 'line', label, keys: true, mouse: true, inputOnFocus: false, value, tags: false, style: { fg: shade('text'), bg: shade('raised'), border: { fg: accent } } });
      modal.bar = () => {
        const paged = longer(); if (labelOf(paged) !== label) { label = labelOf(paged); field.setLabel(label); }
        return [...(keys.length ? letters.length ? letters : [[keys.join(' '), 'choose']] : read ? [] : [['enter', 'submit']]), ...(keys.length && enter ? [enter] : []), ...(suggest ? [['tab', 'complete'], ['↑↓', 'choose']] : []), said.find(([key]) => key === 'esc') ?? ['esc', read ? 'close' : 'cancel'], ...(paged ? [['pgup pgdn', 'page']] : [])];
      };
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
      const fresh = live && !guided ? setInterval(() => { if (finished || closing) return; try { const next = live(); if (typeof next === 'string' && next !== body) { body = next; show(); screen.render(); } } catch { /* The body stays as it was. */ } }, 2000) : null; fresh?.unref?.();
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
  // nextOrigin: where the next dialog to open hands focus back to, set by one that knows better
  // than the focus at that moment (showTask, opened while typing).
  let dialogOrigin = null, nextOrigin = null;
  // Drawn again once the dialog is up: a message moves out from under one that covers it.
  function openDialog() { if (ask._reading) ask.cancel(); dialogOrigin ??= nextOrigin ?? screen.focused; nextOrigin = null; if (message) { lastFrame = null; scheduleDraw(); } }
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
  // behind it, and such a click never takes focus from its field or list. Nothing of the screen
  // behind it touches its sides: on its rows the column beside each side is blank, and so is the
  // screen's edge where only that is left beyond it (at 80 columns the message box's border met
  // its right side as "│─┘").
  const dialogBox = title => {
    const dialog = box({ label: ` ${title} `, clickable: true, autoFocus: false });
    dialog.on('render', coords => {
      if (!coords) return;
      const edge = x => x === 0 || x === screen.width - 1, columns = [];
      for (const [beside, step] of [[coords.xi - 1, -1], [coords.xl, 1]]) {
        if (beside < 0 || beside >= screen.width) continue;
        columns.push(beside); if (edge(beside + step)) columns.push(beside + step);
      }
      for (let y = Math.max(0, coords.yi); y < Math.min(coords.yl, screen.height); y++) {
        const row = screen.lines[y]; if (!row) continue;
        for (const x of columns) if (row[x]) row[x][1] = ' ';
        row.dirty = true;
      }
    });
    return dialog;
  };
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
  // Notes never run over the dialog's border or its rows (at 80x24 the result of a clean-up
  // across computers wrote over the title). They show whole under the rows while the list keeps
  // three rows, or all its rows when it has fewer: the list scrolls the rest. Longer notes go
  // on after the rows of a dialog with a button, in the text its keys scroll, one column in as
  // when they fit; under choices they take the room the list leaves, and PgUp and PgDn page them.
  // While some of them are below what shows, the hint says pgdn more.
  // answers: how many rows at the end are the choices; the rows above them are text, in a list
  // of its own over the choices with a blank row between. Every choice stays in view however long
  // the text is, and the highlight is only ever on one of them, so Enter answers only a choice
  // that shows. The text opens at its top: PgUp and PgDn page it, the wheel scrolls it, ↑ on the
  // first choice and ↓ on the last move it a line, and a click on it leaves the highlight where it
  // was. While some of it is below what shows, the hint says pgdn more. The index picked counts
  // the text rows, as with no answers.
  function listDialog(title, rows, { hint = 'enter choose · esc close', keys = [], selected = 0, notes = [], shown = false, button = null, answers = 0 } = {}) {
    if (modal) throw new Error('Close the current dialog first.');
    return new Promise(resolve => {
      openDialog();
      modal = dialogBox(title);
      // rows and notes may be functions: they are asked again for the screen as it is when the
      // window changes size, so lines wrapped or paged for the old size are made for the new one.
      const rowsNow = () => typeof rows === 'function' ? rows() : rows, notesNow = () => typeof notes === 'function' ? notes() : notes;
      const room = button ? 2 : 0, painted = line => ink(line || ' ', shown ? 'text' : 'muted', colour, false, { trusted: shown }), choices = button ? 0 : answers;
      let said = [], under = 0, lines = rowsNow(), items = lines, after = false, noteText = null, hintText = null, list = null, press = null, text = null, above = [], gap = 0;
      // How many rows come before the choices: what an index picked counts first.
      const before = () => choices ? Math.max(0, lines.length - choices) : 0;
      // Whether the end of the notes (or of the text over the choices) is below what shows,
      // worked out again each time it scrolls and once the dialog has its size (laid).
      const seen = box => box.childBase + Math.max(1, box.height - box.iheight);
      const below = () => after ? seen(list) < items.length : Boolean(text) && seen(text) < above.length || Boolean(noteText && under && !noteText.hidden) && seen(noteText) < said.length;
      const hinted = () => { if (list && hintText) hintText.setContent(ink(below() ? `${hint} · pgdn more` : hint, 'muted', colour)); };
      modal.layout = () => {
        said = notesNow().flatMap(note => wrapText(note, modal.width - 5));
        if (list) lines = rowsNow();
        // The text over the choices, its blank rows at the end left out: one blank row stands between.
        if (choices) { above = lines.slice(0, before()); while (above.length && !String(above.at(-1)).trim()) above.pop(); gap = above.length ? 1 : 0; }
        // space: the rows the list and the notes share, with the blank line over the notes.
        const space = screen.height - 8 - room, keep = Math.min(lines.length, 3), need = said.length ? said.length + 1 : 0;
        after = Boolean(button) && need > space - keep;
        items = after ? [...lines, '', ...said.map(line => painted(` ${line}`))] : choices ? lines.slice(before()) : lines;
        under = after ? 0 : Math.min(need, space - keep);
        modal.preferredHeight = Math.max(8, above.length + gap + items.length + 4 + under + room);
        if (!list) return;
        if (noteText) { noteText.height = Math.max(1, under - 1); noteText.setContent(said.map(painted).join('\n')); noteText.scrollTo(0); noteText[under ? 'show' : 'hide'](); }
        if (text) { text.height = `100%-${4 + under + items.length + gap}`; if (above.join('\n') !== text.ritems?.join('\n')) text.setItems(above); text[above.length ? 'show' : 'hide'](); }
        if (choices) { list.bottom = 3 + under; list.height = Math.max(1, items.length); } else list.height = `100%-${4 + under + room}`;
        if (press) press.bottom = 3 + under;
        if (items.join('\n') !== list.ritems?.join('\n')) { const at = list.selected ?? 0; list.setItems(items); list.select(Math.max(0, Math.min(at, items.length - 1))); }
      };
      modal.laid = hinted;
      positionModal();
      if (said.length) noteText = blessed.text({ parent: modal, bottom: 3, left: 2, width: '100%-4', height: Math.max(1, under - 1), hidden: !under, scrollable: true, tags: true, content: said.map(painted).join('\n'), style: { fg: muted, bg: shade('panel') } });
      // The text over the choices comes first, so the list that takes the keys is the last one.
      if (choices) {
        text = blessed.list({ parent: modal, top: 1, left: 1, width: '100%-2', height: `100%-${4 + under + items.length + gap}`, keys: false, mouse: true, vi: false, tags: true, invertSelected: false, interactive: false, hidden: !above.length, style: { fg: shade('text'), bg: shade('panel') }, scrollbar: { ch: '┃', style: { fg: shade('dim') } } });
        steadyWheel(text, step => text.scroll(step, true)); text.setItems(above);
      }
      list = blessed.list({ parent: modal, ...choices ? { bottom: 3 + under, height: Math.max(1, items.length) } : { top: 1, height: `100%-${4 + under + room}` }, left: 1, width: '100%-2', keys: !button, mouse: true, vi: false, tags: true, invertSelected: false, interactive: !button, style: { fg: shade('text'), bg: shade('panel'), selected: { ...selection } }, scrollbar: { ch: '┃', style: { fg: shade('dim') } } });
      if (text) {
        // ↑ on the first choice and ↓ on the last move the text a line; a click on it leaves the keys with the choices.
        const up = list.up, down = list.down;
        list.up = function(by) { if ((this.selected ?? 0) > 0) return up.call(this, by); text.scroll(-1, true); };
        list.down = function(by) { if ((this.selected ?? 0) < this.items.length - 1) return down.call(this, by); text.scroll(1, true); };
        text.on('focus', () => list.focus()); text.on('scroll', hinted);
      }
      steadyWheel(list, button ? step => list.scroll(step, true) : null); list.setItems(items); list.select(Math.max(0, Math.min(selected - before(), items.length - 1)));
      hintText = blessed.text({ parent: modal, bottom: 1, left: 2, width: '100%-4', height: 1, tags: true, content: ink(hint, 'muted', colour), style: { fg: muted, bg: shade('panel') } });
      list.on('scroll', hinted); noteText?.on('scroll', hinted); hinted();
      // The key bar names the same keys as the hint, with the arrows first where they move to a choice.
      modal.bar = () => [...(!button && items.length > 1 && (keys.length || /\benter\b/.test(hint)) && !hint.includes('↑↓') ? [['↑↓', 'choose']] : []), ...hintPairs(hint), ...(below() ? [['pgdn', 'more']] : [])];
      // Choices whose notes are cut: PgUp and PgDn page the notes, else the text over the choices.
      if (!button) list.key(['pageup', 'pagedown'], (_, key) => { const pane = noteText && !noteText.hidden ? noteText : text && !text.hidden ? text : null; if (!pane) return; pane.scroll((key.name === 'pageup' ? -1 : 1) * Math.max(1, pane.height - pane.iheight - 1), true); screen.render(); });
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
        press.key('home', () => scroll(-items.length)); press.key('end', () => scroll(items.length));
        for (const key of keys) press.key(withShift([key]), () => finish({ key }));
        // A click on the text leaves the focus, and so Enter, on the button.
        list.on('focus', () => press.focus());
        press.focus(); minimumSize(); screen.render(); return;
      }
      list.on('select', (_, index) => finish({ index: before() + (index ?? list.selected ?? 0) }));
      list.on('cancel', () => finish(null));
      for (const key of keys) list.key(withShift([key]), () => finish({ index: before() + (list.selected ?? 0), key }));
      list.focus(); minimumSize(); screen.render();
    });
  }
  // A text to read in a dialog, drawn by readableRows for the dialog's width, again when the
  // window changes size. ↑↓, PgUp and PgDn, Home and End and the wheel scroll it; e or Enter
  // gives 'edit', Esc null. empty: what it says when there is no text, wrapped as the text is.
  // about: lines said first, muted, with a blank row before the text. The hint names ↑↓ only
  // when there is more than shows.
  function readDialog(title, text, { empty = '', about = [] } = {}) {
    if (modal) throw new Error('Close the current dialog first.');
    return new Promise(resolve => {
      openDialog();
      modal = dialogBox(title);
      let rows = [], body = null, hintText = null;
      modal.layout = () => {
        const faint = line => wrapText(line, modal.width - 5).map(row => ink(row, 'muted', colour)), first = about.flatMap(faint);
        rows = [...first, ...(first.length ? [''] : []), ...(text.trim() ? readableRows(text, modal.width - 5, { colour }) : faint(empty))];
        modal.preferredHeight = Math.max(8, rows.length + 4);
      };
      // The row at the top stays the same share of the text after the window changed size.
      modal.laid = () => {
        if (!body) return;
        const made = body.getText().split('\n').length, at = made > 1 ? Math.round(body.childBase * rows.length / made) : 0;
        body.setContent(rows.join('\n')); body.scroll(-body.childBase - 1); if (at) body.scroll(at);
        hintText.setContent(ink(['e edit', rows.length > modal.height - 4 ? '↑↓ scroll' : '', 'esc close'].filter(Boolean).join(' · '), 'muted', colour));
      };
      positionModal();
      body = blessed.box({ parent: modal, top: 1, left: 2, width: '100%-4', height: '100%-4', scrollable: true, alwaysScroll: true, keys: false, mouse: true, tags: true, content: '', style: { fg: shade('text'), bg: shade('panel') }, scrollbar: { ch: '┃', style: { fg: shade('dim') } } });
      hintText = blessed.text({ parent: modal, bottom: 1, left: 2, width: '100%-4', height: 1, tags: true, content: '', style: { fg: muted, bg: shade('panel') } });
      steadyWheel(body); modal.laid();
      const scroll = step => { body.scroll(step); screen.render(); }, page = () => Math.max(1, body.height - 1);
      let finished = false;
      const finish = answer => { if (finished) return; finished = true; closeDialog(resolve, answer); };
      modal.dismiss = () => finish(null);
      body.key('up', () => scroll(-1)); body.key('down', () => scroll(1));
      body.key('pageup', () => scroll(-page())); body.key('pagedown', () => scroll(page()));
      body.key('home', () => scroll(-rows.length)); body.key('end', () => scroll(rows.length));
      body.key([...withShift(['e']), 'enter', 'return'], () => finish('edit'));
      body.key('escape', () => finish(null));
      body.focus(); minimumSize(); screen.render();
    });
  }
  // A text editor in a dialog: Enter adds a line, a paste goes in whole, Ctrl-S saves (the
  // text), Esc cancels (null). note: shown above the keys, such as a refused save: whole, on as
  // many lines as it takes at the dialog's width, the field above it making room.
  // A text longer than the box scrolls as the app's other boxes do: the wheel moves it a line a
  // step (lib/wheel.mjs), PgUp and PgDn a page, and both leave the cursor where it is, where
  // typing shows. The arrows move the cursor, and the text follows it past the edge of the box;
  // typing, an arrow, Home or End brings the text back to the cursor, even one that cannot move
  // it, such as ↓ at the end of the text. The cursor is drawn only on its own row, and the
  // scroll bar is on the box's first row at the top of the text, its last at the end.
  function editText(title, value = '', { note = '' } = {}) {
    if (modal) throw new Error('Close the current dialog first.');
    return new Promise(resolve => {
      openDialog();
      modal = dialogBox(title);
      let field = null, hint = null;
      const KEYS = ink('Enter adds a line · Ctrl-S saves · Esc cancels', 'muted', colour);
      const noted = () => note ? wrapText(String(note), Math.max(10, Math.min(88, screen.width - 4) - 6)) : [''];
      const fit = () => { if (!field || !hint) return; const lines = noted(); hint.height = lines.length + 1; field.height = `100%-${lines.length + 4}`; hint.setContent([...(note ? lines.map(line => ink(line, 'orange', colour)) : []), KEYS].join('\n')); };
      modal.layout = () => { modal.preferredHeight = screen.height - 4; fit(); }; positionModal();
      field = blessed.textarea({ parent: modal, top: 1, left: 1, width: '100%-2', height: '100%-5', inputOnFocus: false, keys: true, ignoreKeys: true, mouse: true, tags: false, value, alwaysScroll: true, style: { fg: shade('text'), bg: shade('raised') }, scrollbar: { ch: '┃', style: { fg: shade('dim') } } });
      bindInput(field, screen); editable(field, { hideAway: true }); field.setValue(value);
      steadyWheel(field, step => field.scrollView(step));
      hint = blessed.text({ parent: modal, bottom: 1, left: 2, width: '100%-4', height: 2, tags: true, content: '', style: { fg: muted, bg: shade('panel') } });
      fit();
      modal.bar = () => [['ctrl-s', 'save'], ['esc', 'cancel']];
      const edit = field._listener;
      field._listener = function(ch, key = {}) {
        if (key.ctrl && key.name === 's') return this._done?.(null, this.value);
        if (['pageup', 'pagedown'].includes(key.name) && !key.ctrl && !key.meta) { this.scrollView((key.name === 'pageup' ? -1 : 1) * pageOf(this)); screen.render(); return; }
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
  async function yesKey(title, body, question = 'y yes · n no') { return await yesNoKey(title, body, question) === true; }
  // The same, where Esc is not a no: it gives null, so the caller can do nothing at all.
  async function yesNoKey(title, body, question = 'y yes · n no') { const answer = await prompt(title, `${body}\n\n${question}`, '', { keys: ['y', 'n'] }); return typeof answer === 'string' ? /^y(?:es)?$/i.test(answer.trim()) : null; }
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
      modal.bar = () => [['enter', 'save'], ['esc', 'cancel']];
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
      if (!modal) await prompt(clip(`$ ${command}`, 60), text.includes('\n') ? text : `${text}\n(no output)`, '', { read: true });
    }).catch(error => { if (!closing) { setMessage(error.message); draw(); } });
  }
  // Up and Down in the message box walk through what the owner sent, as in a shell: the open
  // session's own messages, then everything sent since the app opened. It is kept in memory only.
  const sentNow = [];
  // Text that leaves the box unsent (a refused command a new one took the place of, a command Esc
  // dropped for the draft it was typed over) goes there too, so ↑ brings it back. An MCP server
  // command with its URL or command typed never does: it may hold a key.
  const keyedCommand = value => /^\/mcp\s+add\s+\S+\s+\S/i.test(String(value ?? '').trim());
  const toRecall = value => { const text = String(value ?? '').trim(); if (!text || sentNow.at(-1) === text || keyedCommand(text)) return; sentNow.push(text); if (sentNow.length > 200) sentNow.shift(); };
  // A refused command left in the box to change (submit): a / as the first key after it starts
  // a new command in its place.
  let refusedBox = null;
  // A / typed right after a command's last word starts a new command: "/budget lots/usage" is two.
  // After a space it starts the word the command waits for, a path: /permissions folders add /tmp.
  const glued = value => /\S$/.test(String(value ?? ''));
  // The command a new one takes the place of goes to ↑. One that never goes there (keyedCommand)
  // is set aside as a draft is (aside), with the draft already aside under it, and is back in the
  // box once the new command has run, on Esc, or once the / is taken out.
  function replaced(text) {
    if (!keyedCommand(text)) { toRecall(text); return; }
    aside = { text, view, key: draftKey(), keep: draftSlot(), command: true, under: aside };
    setMessage('Your /mcp add is set aside. It is back in the box once this command has run.');
  }
  let recall = null;
  // Whether the key bar was last drawn for a box with text in it (syncPalette).
  let filledShown = false;
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
  // The bot of the form that starts it that way, or null. cached: the key bar asks on every
  // draw, so it reads the bots file only when a bot of the form has a schedule in the saved list.
  function starterBot({ cached = false } = {}) {
    if (!controller || !composing() || composeWhen || !composeBots.length) return null;
    if (cached && !composeBots.some(name => savedBots().some(bot => bot.name === name && bot.schedule))) return null;
    return composeBots.find(name => botScheduleIn(controller.repo, null, name)?.label) ?? null;
  }
  function startWithBot() {
    const starter = starterBot();
    if (!starter) return false;
    let request;
    try {
      controller.writable();
      request = enqueue(controller.repo.root, 'Start working.', { priority: 0, permissions: formMode(), place: composePlace, folders: composeFolders, bots: composeBots, ...(composeModel ? { model: composeModel } : {}), ...(formAuto() ? { auto: true } : {}), ...(composePicked ? { picked: true } : {}), bot: starter });
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
  // sent.model: the model /model NAME gave the session with this message, while its turn
  // works on another: a message to the model then waits for that turn to end, and starts the
  // next on it (sent.waits says it does).
  async function submit(text, sent = {}) {
    // An empty Enter keeps the box reading: a box left focused but not reading drops keys.
    // In the new session form it starts the session when a bot that has a schedule is in it.
    // Over a session whose turn holds a message of his back, it sends that message now.
    // Over a session on another computer whose turn holds one back, it sends it there now.
    // In the new session's box, beside a row that is not a session, its line says Enter starts a
    // new session: it opens the form, as n and + do, in the project a typed message would start in.
    // Kanban's box adds to To do: there it opens the New task form, as n and + New task do.
    if (!text.trim()) {
      if (startWithBot()) return;
      const there = remoteHere();
      if (there && Number.isInteger(there.remote?.held) && there.remote.held > 0 && ['running', 'preparing'].includes(there.remote.state)) setMessage(await remoteApp.action(there, 'sendNow'));
      else if (!there && sessionBox() && !viewOnly()) await catchAction(async () => { const root = view === 'tasks' && teamNow() ? await teamFolderAsk(teamNow()) : goalTarget() ?? (await createHere() ? controller?.repo.root : null); if (root) await newTaskForm(root); });
      else if (!there && view === 'kanban' && !sharedNow() && (!viewOnly() || thereNow())) await catchAction(() => kanbanAction(0, 'new'));
      else sendWaitingNow();
      focusInput(); return;
    }
    // A reply to a message that waits (replying): it answers whoever sent it, and that message does not run.
    if (replyNow() && !isCommand(text)) { await sendReply(replyNow(), text.trim()); replying = null; ask.clearValue(); focusInput(); return; }
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
    const lone = rowKey(text), stray = lone ? null : strayKey(text), from = typedFrom, base = from && text.length > 1 ? typedBase : ''; typedFrom = null; typedBase = ''; refusedBox = null;
    // A character typed on a session's row that is no key there is not sent (strayKey): it stays
    // in the box, and more typed after it makes a message. y and n first answer what waits, as below.
    const keepStray = () => { typedFrom = from; typedBase = ''; ask.setValue(text); setMessage(`${stray} is no key on this row. Type more to write a message.`); focusInput(); draw(); };
    if (stray && !/^[yn]$/i.test(stray)) { keepStray(); return; }
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
    if (!isCommand(text) && await heldConfig(text)) { draw(); return; }
    openStarted();
    recall = null;
    // /mcp add with its URL or command typed is kept out of what Up recalls too: the URL may hold a key.
    if (sentNow.at(-1) !== text.trim() && !keyedCommand(text)) { sentNow.push(text.trim()); if (sentNow.length > 200) sentNow.shift(); }
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
    // A message that starts with a file's path, as a dropped file does, is a message (startsWithPath).
    if (isCommand(text)) {
      // A command typed over a draft (aside): the draft is back once it has run. Refused, the
      // command stays in the box to change, and the draft stays aside.
      const set = aside; aside = null;
      try { const command = parseCommand(text); ask.clearValue(); await dispatch(command); aside = set; bringBack(); }
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
        // Refused, the command stays in the box to change; a / as the first key after it starts a new one in its place (refusedBox).
        const left = ask.getValue(), command = isCommand(left);
        if (command) refusedBox = left;
        // A draft it was typed over stays aside. Under the question to a teammate it is held: it is
        // back once that is sent or cleared.
        if (set) aside = !left || command ? set : { ...set, held: true };
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
      if (stray) { keepStray(); return; }
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
        // A shared project's team board: the message goes to whoever shares it, about that
        // project, whole however long, as a long message in Chats goes (lib/peer/asks.mjs).
        const shared = sharedNow(), who = shared.sharers[0], name = peerName(who.name, who.key);
        sentLine(await peerCommand({ type: 'ask', to: who.key, project: shared.handle, text: text.trim() }), name, fitLine(`Sent to ${name}. It starts a session on ${who.mine ? 'that' : 'their'} computer, under the access ${who.mine ? 'you' : 'they'} chose. The reply shows in Chats.`, `Sent to ${name}. It starts a session there. The reply shows in Chats.`, `Sent to ${name}. The reply shows in Chats.`), who.mine === true);
        sharedTold.at = 0; ask.clearValue(); focusInput(); return;
      }
      // A project of my other computer: the card goes to To do there.
      if (view === 'kanban' && thereNow()) { await thereAct(thereNow(), 'add', { text }); ask.clearValue(); focusInput(); return; }
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
        if (way.to === 'none') { setMessage(`It is ${here.owner}'s session: only ${here.owner} can write to it.`); focusInput(); return; }
        // A plain yes that goes to a session there whose Task waits is his answer to that Task, as y is.
        // After @here it is a message for his agent here, as anything is.
        if (!toModel && way.to === 'there' && here.label === 'TASK' && saysYes(way.text)) { setMessage(await remoteApp.action(here, 'accept')); ask.clearValue(); focusInput(); return; }
        return way.to === 'there' ? await remoteSubmit(here, null, way.text, way.toModel === true) : await helperSubmit(here, way.text);
      }
      if (machine) return await remoteSubmit(here, machine, text.trim().slice(first.length).trim());
      // @everyone asks every open session (docs/standup.md): in a Standup session, the ones its
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
      // In a team's project with no folder here, opened from Projects, the first new session asks which folder it is.
      const team = (view === 'tasks' || composing()) && !composeWhen ? teamNow() : null;
      if (sessionBox() || team) {
        let root = team ? await teamFolderAsk(team) : goalTarget();
        if (root === false) { ask.setValue(typed()); focusInput(); return; }
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
      // A picture in it goes as a copy the session may read, as in a message of its own (enqueue).
      const same = to === (pending.bot ?? null), joined = same ? addToRequest(controller.repo.root, pending.id, readablePictures(mention ? mention.text : text).text, { typed: true }) : null;
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
    // Auto model goes with a new session as its own mark (auto), beside the model whose vendor it picks from.
    const session = continuation ? {} : selectedRequest ? { permissions: selectedRequest.permissions, place: selectedRequest.place, folders: selectedRequest.folders, ...(selectedRequest.bots ? { bots: requestBots(selectedRequest) } : {}), ...(selectedRequest.model ? { model: selectedRequest.model } : {}), ...(selectedRequest.auto === true ? { auto: true } : {}), ...underDefault(selectedRequest) } : { permissions: formMode(), place: composePlace, folders: composeFolders, bots: composeBots, ...(composeModel ? { model: composeModel } : {}), ...(formAuto() ? { auto: true } : {}) };
    const picked = continuation ? false : selectedRequest ? selectedRequest.picked === true : composePicked, fromForm = !continuation && !selectedRequest;
    // A saved request keeps the bot it was written to, so one that now goes to the model is sent as a new request.
    const rewritten = Boolean(selectedRequest?.bot) && !mention;
    // In an open session a message with no @name goes to whoever the owner wrote to last: a bot they
    // wrote to stays the one they are talking to until they name another, or @model.
    let stays = null;
    if (!mention && !toModel && continuation && !selectedRequest) { try { stays = addressedBot(controller.snapshot().tasks.find(row => row.id === continuation), pendingRequests(root)); } catch { /* It goes to the model. */ } }
    const to = mention ? mention.bot.name : stays;
    let request;
    const onModel = sent.model && continuation && !selectedRequest && !to ? { model: sent.model } : {}; if (onModel.model) sent.waits = true;
    // The bot gets the message without its @name; the chat shows who it was written to. One
    // written to @model in a session is kept as his (toModel): the session then stays the model's.
    try { request = enqueue(root, mention ? mention.text : text, { id: rewritten ? undefined : selectedRequest?.id, continuationTaskId: continuation, priority: 0, ...session, ...(picked ? { picked: true } : {}), ...(to ? { bot: to } : {}), ...(toModel && continuation ? { toModel: true } : {}), ...onModel }); if (rewritten) removeRequest(root, selectedRequest.id); }
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
    closing = true; shellRun?.run.stop(); clearTimeout(timer); clearInterval(usageTimer); clearInterval(serversTimer); clearInterval(scheduleTimer); clearInterval(sentTimer); clearInterval(changesTimer); clearInterval(artifactsTimer); clearTimeout(patchTimer); clearTimeout(countTimer); usageAbort.abort();
    let failure;
    // A push still going stops with its guards, and its session says on the next open what reached GitHub (lib/publish.mjs).
    if (pushesRunning()) { setMessage('Stopping the push before ELU closes…'); try { await stopPushes('closed'); } catch (error) { failure = error; } }
    try { await controller?.close(); } catch (error) { failure ??= error; }
    try { claim.release(); } catch (error) { failure ??= error; }
    screen.destroy(); if (failure) rejectDone(failure); else resolveDone();
  }
  // A draft held under a question to a teammate (aside) is back once the question is sent.
  ask.on('submit', text => { pressedAt = Date.now(); catchAction(async () => { const held = aside?.held ? aside : null; await sendTyped(text); if (held && aside === held && !ask.getValue()) bringBack(); }); });
  // A message that names a picture this computer does not have, as one dropped on the terminal
  // of the other computer that reaches ELU here over ssh, goes without it, and the line says
  // so once it went (the box is empty and nothing was refused), and again once the answer came.
  async function sendTyped(text) {
    const away = text.trim() && !isCommand(text) && !text.trimStart().startsWith('!') ? picturesElsewhere(text) : [];
    const was = following;
    await submit(text);
    if (!away.length || ask.getValue().trim() || message.includes(TYPED_BACK.trim())) return;
    // One short row, beside the list of an 80-column screen too: a file's name can be long, so it is not in it.
    const one = away.length === 1, note = one ? 'The picture is on the other computer.' : `The ${away.length} pictures are on the other computer.`;
    if (following && following !== was) following.away = one ? 'the picture' : `the ${away.length} pictures`;
    setMessage([message, note].filter(Boolean).join(' '));
  }
  ask.on('focus', () => ask.readInput());
  // Esc leaves the message box for the view's main pane.
  // An edit of a held reply ends there too, and the reply stays held: the cursor goes back
  // to it in Threads, unless another part of Chats has the focus by then.
  // A row's key typed and not entered is taken back, and the draft it was typed over stays.
  // So does a draft a command was typed over (aside): the command is dropped.
  ask.on('cancel', () => {
    replying = null;
    if (typedFrom && rowKey()) { if (ask.getValue().length > 1) ask.setValue(typedBase); else ask.clearValue(); } typedFrom = null; typedBase = '';
    // The command a draft comes back over goes where ↑ brings it back. One that never goes there
    // (keyedCommand) stays in the box, with the draft still aside under it.
    const over = aside ? ask.getValue() : '';
    if (!keyedCommand(over)) { bringBack(''); if (over.trim() && ask.getValue() !== over) toRecall(over); }
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
    // An empty box names no Enter: the page keys come first there.
    return focused !== ask ? pairs : pairs[0]?.[0] === 'enter' ? [pairs[0], ['pgup pgdn', 'page'], ...pairs.slice(1)] : !ask.getValue().trim() ? [['pgup pgdn', 'page'], ...pairs] : pairs;
  }
  // PgUp and PgDn move a chat a page, in the chat itself or from the message box under it.
  // What it changed moves the same way while it shows. false when nothing of the kind shows.
  function pageChat(up) {
    if (modal) return false;
    if (view === 'chats') { if (teamOn) pageThreads(up); return teamOn; }
    if (!changesBox.hidden) { moveChanges((up ? -1 : 1) * Math.max(1, (changesShown?.high ?? 2) - 1)); return true; }
    if (!artifactsBox.hidden) { moveArtifacts((up ? -1 : 1) * Math.max(1, (artifactsShown?.high ?? 2) - 1)); return true; }
    if (activity.hidden) return false;
    activity.scroll((up ? -1 : 1) * pageOf(activity)); draw(); return true;
  }
  activity.key(['pageup', 'pagedown'], (_, key) => pageChat(key.name === 'pageup'));
  // A session's two views share the right pane: its chat, and what it changed. One answer
  // from Git is kept per session, so coming back to a session shows it at once.
  let sessionView = 'chat', changesFrom = null, patchTimer = null, patchAsked = null, changesShown = null, built = { rows: [] };
  // The Schedule tab: what it shows (drawSchedule), where the focus came from, and where each tab's name is on the switch.
  let scheduleShown = null, scheduleFrom = null, tabSpots = [];
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
      // pages: as many pages of the patch and of each new file as the view has read so far (readMore).
      const changes = taskPatch(controller.repo, id, { changed: () => { if (!closing && key === patchKey() && !patchTimer) askPatch(key, 0); }, pages: entry.pages ?? 1 }), digest = hash(JSON.stringify(changes));
      entry.error = null;
      if (digest !== entry.digest) {
        // The cursor stays on its line of its file while the rows around it change.
        const old = built.entry === entry ? built.rows : null, at = old?.[entry.cursor], name = at?.file != null && entry.changes.files[at.file] ? fileKey(entry.changes.files[at.file]) : null;
        const offset = name === null ? 0 : entry.cursor - old.findIndex(row => row.file === at.file), gap = entry.cursor - entry.top;
        entry.changes = changes; entry.digest = digest;
        // A note goes with its line when the line only moved.
        if (placeNotes(entry.changes, entry.notes)) entry.keep();
        // Up to five files start unfolded when they are short. More, or longer ones, start
        // folded, as a list to pick from: every file and line is there, and opening the view
        // costs the same however much was changed (as remotePatch does).
        if (entry.wide === null && changes.files.length) entry.wide = changes.files.length <= 5 && changes.files.reduce((sum, file) => sum + file.hunks.reduce((lines, hunk) => lines + hunk.lines.length, 0), 0) <= 2000;
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
  function showChat() { sessionView = 'chat'; if (screen.focused === changesBox) leaveChanges(); if (screen.focused === artifactsBox) leaveArtifacts(); if (screen.focused === scheduleList) leaveSchedule(); draw(); }
  // The schedule the Schedule tab shows, for what shows on the right: the schedule that runs the
  // open session (runSchedule), or the run of one that waits to start, or a schedule with no run
  // in the list under the cursor. chat: it has a chat to go back to. null for anything else.
  function shownSchedule(task) {
    if (view === 'tasks' && listed()) { const row = boardLines[barAt]?.row; return row?.kind === 'schedule' ? { schedule: row.schedule, root: row.root, chat: false } : null; }
    if (view !== 'chat' || !controller) return null;
    const root = controller.repo.root, schedules = listSchedules(), job = task ? runSchedule(root, task, schedules) : selectedRequest?.scheduleId ? schedules.find(value => value.id === selectedRequest.scheduleId) ?? null : null;
    return job ? { schedule: job, root, chat: true } : null;
  }
  const openSession = () => view === 'chat' && controller && selectedId ? snapshot?.tasks?.find(row => row.id === selectedId) ?? null : null;
  // Shows the Schedule tab, as a click on its name or t does. focus: the keys go to it.
  // A schedule with no run in the list has no other tab: showing its tab leaves the choice the
  // sessions after it are shown with (Chat or Changes) as it was.
  function showSchedule({ focus = false } = {}) {
    const shown = shownSchedule(openSession()); if (!shown) throw new Error('No schedule runs this session.');
    if (shown.chat) sessionView = 'schedule';
    if (focus && screen.focused !== scheduleList) { const from = screen.focused; if (ask._reading) ask.cancel(); scheduleList.focus(); scheduleFrom = [board, ask, activity].includes(from) ? from : null; }
    draw();
  }
  // Focus leaves the Schedule tab for where it was before: the list, the message box or the chat.
  function leaveSchedule() {
    const to = scheduleFrom; scheduleFrom = null;
    if (to === ask || !listed() && to !== activity) focusInput(); else if (to === activity && view === 'chat') activity.focus(); else focusBoard();
  }
  // The rows of the Schedule tab: when it runs and its next run, the mode each run gets, whether
  // it runs, its message, then run now and delete. Enter changes the row it is on; the next run
  // uses what changed.
  function drawSchedule({ schedule: job, root, chat }) {
    const room = Math.max(24, scheduleList.width - 1), at = new Date(), label = text => ink(text.padEnd(13), 'muted', colour);
    const row = (type, does, name, value, tone = 'text', hint = '') => { const text = clip(value, Math.max(4, room - 13)), more = hint && 13 + widthOf(text) + 2 + widthOf(hint) <= room ? `  ${hint}` : ''; return { type, does, line: label(name) + ink(text, tone, colour, true) + ink(more, 'muted', colour) }; };
    let mode = null; try { mode = runMode(job) ?? 'locked'; } catch (error) { mode = null; }
    const next = job.enabled && job.nextRunAt ? `${dateText(new Date(job.nextRunAt))}, ${untilText(job.nextRunAt, at)}` : job.nextRunAt ? 'paused' : 'none, it has run';
    const message = String(job.goal ?? '').split('\n').flatMap(line => wrapText(line, Math.max(8, room - 13))).filter((line, index, all) => line.trim() || index < all.length - 1);
    const rows = [
      row('when', 'change when', 'When', job.when.label, 'orange'),
      row('when', 'change when', 'Next run', next, job.enabled ? 'text' : 'muted'),
      row('mode', 'change the mode', 'Permissions', mode ? LABELS[mode] : 'unknown', mode === 'full' ? 'orange' : 'text'),
      row('pause', job.enabled ? 'pause' : 'resume', 'Runs', job.enabled ? 'on its own' : job.nextRunAt ? 'paused' : 'no more', job.enabled ? 'text' : 'muted', job.enabled ? 'p pauses' : job.nextRunAt ? 'p resumes' : ''),
      ...message.slice(0, 8).map((line, index) => row('message', 'change the message', index ? '' : 'Message', index === 7 && message.length > 8 ? `${line.trimEnd()}…` : line || ' ')),
      row('run', 'run now', 'Run now', 'r', 'text', 'starts a run now'),
      row('delete', 'delete', 'Delete', 'x', 'text', 'its runs stay in Sessions'),
    ];
    const lines = rows.map(value => value.line);
    // Another schedule's tab, or one shown again, starts on its first row.
    const fresh = scheduleShown?.schedule.id !== job.id;
    if (fresh || lines.join('\n') !== scheduleList.ritems?.join('\n')) { const kept = fresh ? 0 : scheduleList.selected ?? 0; scheduleList.setItems(lines); scheduleList.select(Math.min(kept, lines.length - 1)); }
    const note = [...(job.note ? [job.note] : []), `${projectName(root)} · Each run is a new session. A change is used by the next run.`].flatMap(line => wrapText(line, Math.max(10, scheduleBox.width - 4)));
    if (scheduleHint.height !== note.length) { scheduleHint.height = note.length; scheduleList.height = `100%-${note.length + 3}`; }
    scheduleHint.setContent(ink(note.join('\n'), 'muted', colour));
    scheduleShown = { schedule: job, root, rows, chat };
  }
  // The change Enter, r, p or x makes in the Schedule tab, to the schedule it shows, by the
  // rules /schedule keeps. When, the message and the mode are used by the next run.
  async function scheduleChange(type) {
    const shown = scheduleShown; if (modal || !shown) return;
    const job = listSchedules().find(value => value.id === shown.schedule.id); if (!job) throw new Error('That schedule no longer exists.');
    const row = { schedule: job, root: shown.root };
    if (type === 'when') {
      const when = await pickWhen(job); if (!when) return;
      const value = changeSchedule(job.id, { when }); refreshAwake();
      setMessage(`Runs ${value.when.label}${value.enabled ? `, next ${dateText(new Date(value.nextRunAt))}` : ', paused'}.`);
    } else if (type === 'message') await editSetting('Schedule message', job.goal, text => changeSchedule(job.id, { goal: text }));
    else if (type === 'mode') {
      const mode = await pickMode({ schedule: true }); if (!mode) return;
      changeSchedule(job.id, { permissions: mode, picked: true }); setMessage(`${LABELS[mode]} from the next run.`);
    } else if (type === 'pause') await scheduleAction(row, 'publish');
    else if (type === 'run') { await scheduleAction(row, 'retry'); return followRun(job.id, shown.root); }
    else if (type === 'delete') await scheduleAction(row, 'stop');
    // Deleted, its tab is gone: the keys go back to where they were before it, beside its chat.
    if (!listSchedules().some(value => value.id === job.id)) { sessionView = 'chat'; leaveSchedule(); }
    else if (!scheduleBox.hidden && screen.focused !== scheduleList) scheduleList.focus();
    draw();
  }
  // r runs it now: the run it queued is what the list and the right side follow, with its
  // Schedule tab. The run before it was archived (lib/schedules.mjs).
  async function followRun(id, folder) {
    const job = listSchedules().find(value => value.id === id), root = listedRoot(folder);
    let request = null; try { request = job?.lastRequestId ? pendingRequests(root).find(value => value.id === job.lastRequestId) ?? null : null; } catch { request = null; }
    if (!request) { draw(); return; }
    await openRow(request.taskId != null ? { kind: 'task', root, id: String(request.taskId), key: `${root}\0task\0${request.taskId}` } : { kind: 'request', root, request, key: `${root}\0request\0${request.id}` });
    showSchedule({ focus: true });
  }
  // When a schedule runs: a time from the list, or one typed in Other time, as /schedule takes them.
  async function pickWhen(job) {
    const rows = [...SCHEDULE_PRESETS.map(([when, text]) => ink(when.padEnd(14), 'text', colour, true) + ink(text, 'muted', colour)), ink('Other time…', 'text', colour, true)];
    const picked = await listDialog('When', rows, { notes: [`Now ${job.when.label}. Times are this computer’s local time.`] });
    if (!picked) return null;
    let answer = SCHEDULE_PRESETS[picked.index]?.[0];
    if (!answer) {
      let typed = ''; try { if (parseWhen(job.when.label)) typed = job.when.label; } catch { typed = ''; }
      answer = await prompt('When', ['When should it run?', '', 'in 30m            once, in 30 minutes', 'daily 9:00        every day', 'weekdays 9am      Monday to Friday', 'mon,thu 14:30     chosen days', 'every 2h          every 2 hours (15m to 7d)', 'tomorrow 15:00    once', '2026-12-01 9:00   once', '', 'Times are this computer’s local time. r runs it now.'].join('\n'), typed);
      if (answer === null) return null;
    }
    const when = parseWhen(answer); if (!when) throw new Error('Choose a time. r runs it now.');
    return when;
  }
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
  // The Artifacts tab: what the open session's Task asked to see (lib/artifacts.mjs), drawn from
  // the data its session gave. A session here is read from its records, each read kept until
  // its file changes; one on another computer shows what that computer sent, read only. Where
  // each was scrolled to, where the focus came from, and when the owner looked at one on
  // another computer (the dot on the tab: here it is kept with its records).
  let artifactsShown = null, artifactsFrom = null, chartsShown = '';
  const artifactStores = new Map(), artifactsTop = new Map(), remoteSeen = new Map();
  function storeOf(repo, id) {
    let mark = 'none'; try { const stat = fs.statSync(artifactFile(repo, id)); mark = `${stat.mtimeMs}:${stat.size}`; } catch { /* None yet. */ }
    const key = `${repo.root}\0${id}`, kept = artifactStores.get(key);
    if (kept?.mark === mark) return kept.store;
    const store = readArtifactStore(repo, id); artifactStores.delete(key); artifactStores.set(key, { mark, store });
    if (artifactStores.size > 24) artifactStores.delete(artifactStores.keys().next().value);
    return store;
  }
  // { key, items, waiting, seenAt, ... } for the open session, or null when it has no Task. A Task
  // with no artifact yet has the tab too, which says how to add one. A Task that waits for
  // approval shows them too: the owner sees the numbers before he decides.
  function shownArtifacts(task) {
    const there = remoteHere();
    if (there) {
      const plan = there.remote?.plan; if (!plan || plan.state === 'rejected') return null;
      return { key: `remote\0${there.key}`, items: Array.isArray(plan.artifacts) ? plan.artifacts : [], waiting: plan.state === 'proposed', seenAt: remoteSeen.get(there.key) ?? null, there };
    }
    if (view !== 'chat' || !controller || !task) return null;
    // The own chat of a bot that oversees the sessions shows the Sessions and Agents tables,
    // with no Task and nothing stored: they are worked out when the tab is drawn (overviewItems).
    if (typeof task.botChat === 'string' && botOversees(savedBot(task.botChat))) return { key: `overview\0${controller.repo.root}\0${task.id}`, overview: { root: controller.repo.root, id: String(task.id) }, items: [], waiting: false, seenAt: null };
    let plan = task.plan ?? null;
    // A revision he rejected leaves the Task before it in place.
    if (plan?.state === 'rejected') { try { plan = sessionTasks(controller.repo, task.id).findLast(row => row.state !== 'rejected') ?? null; } catch { plan = null; } }
    if (!plan) return null;
    let store; try { store = storeOf(controller.repo, task.id); } catch { store = { items: {}, seenAt: null }; }
    return { key: `${controller.repo.root}\0${task.id}`, items: artifactItems(plan, store), waiting: plan.state === 'proposed', seenAt: store.seenAt, repo: controller.repo, id: task.id };
  }
  // Shows the Artifacts tab, as a click on its name, v or /artifacts does. focus: the keys go to it.
  function showArtifacts({ focus = false } = {}) {
    const there = remoteHere(), task = there ? null : openSession();
    if (!there && !task) throw new Error('Open a session first.');
    if (!shownArtifacts(task)) throw new Error('This session has no Task yet: its artifacts come with one.');
    sessionView = 'artifacts';
    if (focus && screen.focused !== artifactsBox) { const from = screen.focused; if (ask._reading) ask.cancel(); artifactsBox.focus(); artifactsFrom = [board, ask, activity].includes(from) ? from : null; }
    draw();
  }
  // Focus leaves the Artifacts tab for where it was before: the list, the message box or the chat.
  function leaveArtifacts() {
    const to = artifactsFrom; artifactsFrom = null;
    if (to === ask || !listed() && to !== activity) focusInput(); else if (to === activity && (view === 'chat' || remoteHere())) activity.focus(); else focusBoard();
  }
  // The rows in view, the scrollbar's column on the right. Looking at them marks them seen.
  function drawArtifacts(shown) {
    Object.assign(artifactsBox, { top: activity.top, left: activity.left, width: activity.width, height: activity.height });
    artifactsBox.style.border.fg = screen.focused === artifactsBox ? accent : shade('border');
    const high = Math.max(1, artifactsBox.height - 2), width = Math.max(8, artifactsBox.width - 6);
    // A note is drawn as Markdown, as a model's reply is in the chat (lib/markdown.mjs), and
    // kept for a copy, which gives it as written.
    const noteRows = (block, { width: wide, colour: tinted }) => { const drawn = markdownRows(block.text, wide, { colour: tinted }); keepCopies(drawn.join('\n'), drawn); return drawn; };
    // A chart's plot is a picture where this terminal shows pictures, and text everywhere else:
    // inside tmux, and for a session on another computer.
    const cell = shown.there ? null : pictures?.cell ?? null;
    const rows = artifactsView(shown.overview ? overviewItems(shown.overview, width) : shown.items, { width, colour, waiting: shown.waiting, noteRows, picture: Boolean(cell) });
    const most = Math.max(0, rows.length - high), top = Math.max(0, Math.min(artifactsTop.get(shown.key) ?? 0, most)); artifactsTop.set(shown.key, top);
    const thumb = most ? Math.round((high - 1) * top / most) : -1;
    artifactsBox.setContent(rows.slice(top, top + high).map((row, at) => `  ${row}${' '.repeat(Math.max(0, width - widthOf(visible(row))))} ${at === thumb ? ink('┃', 'dim', colour) : ' '}`).join('\n'));
    // The pictures go over the cells the rows left blank for them, a border and two columns in.
    // iTerm2 shows no colour of a cell through a picture, so there the picture has the pane's own.
    const charts = cell ? chartPictures(rows, { cell, colour, solid: pictures.protocol === 'iterm', top }) : [];
    pictures?.show(charts.length ? { box: artifactsBox, left: 3, top: 1, high, pictures: charts } : null);
    // The cells under a picture are blank whatever it shows: new data can change the picture
    // and no row of text, and the frame is drawn for it all the same.
    const marks = charts.map(chart => `${chart.key} ${chart.row}`).join();
    if (marks !== chartsShown) { chartsShown = marks; lastFrame = null; }
    artifactsShown = { key: shown.key, rows, high, top };
    // The two tables of a bot that oversees are new at every draw and kept nowhere: nothing is marked seen.
    const latest = shown.overview ? null : artifactsLatest(shown.items);
    if (latest && (!shown.seenAt || latest > shown.seenAt)) {
      if (shown.there) remoteSeen.set(shown.there.key, latest);
      else { const { repo, id } = shown, kept = artifactStores.get(`${repo.root}\0${id}`); if (kept) kept.store.seenAt = latest; setImmediate(() => markArtifactsSeen(repo, id, latest)); }
    }
  }
  // The Sessions and Agents tables of a bot that oversees (lib/session-overview.mjs), from this
  // computer's records as they are now, with its own chat left out. A look within the last
  // second is drawn again, so scrolling and the tick do not read every project each time.
  // Records that cannot be read give one line saying so, in place of the tables.
  function overviewItems({ root, id }, width) {
    try { return overviewArtifacts(readOverview({ except: { root, id }, within: 1000 }), { width }); }
    catch (error) { return [{ title: 'Sessions', shows: '', every: null, key: 'sessions', updates: [{ at: new Date().toISOString(), data: { blocks: [{ kind: 'note', text: `ELU could not read the sessions just now: ${String(error?.message ?? error).split('\n')[0]}` }] } }], script: null, run: null }]; }
  }
  function moveArtifacts(step, { redraw = true } = {}) {
    const now = artifactsShown; if (modal || !now) return;
    artifactsTop.set(now.key, Math.max(0, Math.min(Math.max(0, now.rows.length - now.high), now.top + step)));
    if (redraw) draw();
  }
  // ELU runs each refresh script that is due (lib/artifacts.mjs), in a process of its own, while it runs.
  const artifactsTimer = setInterval(() => { if (!closing) refreshArtifacts().catch(() => {}); }, 15000);
  artifactsTimer.unref?.();
  // The switch, and under it the rows in view when Changes shows. Nothing here asks Git.
  function drawSessionViews(task) {
    // changing: it has a Changes tab. A session a schedule runs, or its run that waits to start,
    // has a Schedule tab too; a schedule with no run in the list has only that one (timed.chat false).
    const there = remoteHere(), timed = there ? null : shownSchedule(task), changing = view === 'chat' && Boolean(task) || Boolean(there);
    const offered = changing || Boolean(timed), on = changing && sessionView === 'changes', scheduled = Boolean(timed) && (sessionView === 'schedule' || !timed.chat);
    // Its Task's artifacts, when it has some: their tab, with a dot while new data came since he looked.
    const watched = changing ? shownArtifacts(task) : null, looking = Boolean(watched) && sessionView === 'artifacts' && !scheduled;
    const key = !on ? null : there ? `remote\0${there.key}` : `${controller.repo.root}\0${task.id}`, entry = !key ? null : there ? remotePatch(there) : patches.get(key) ?? null;
    // Another session shows, or the view came back: its changes are read once the cursor rests on it.
    // One on another computer has sent them, or is asked for them now.
    if (key !== patchAsked) { patchAsked = key; askPatch(there ? null : key, 150); if (there && on) remoteApp.changes(there, { fetch: true }); }
    sessionTabs.hidden = !offered; changesBox.hidden = !on; artifactsBox.hidden = !looking; scheduleBox.hidden = !scheduled; changesShown = null;
    if (!looking) { artifactsShown = null; chartsShown = ''; pictures?.show(null); if (screen.focused === artifactsBox) leaveArtifacts(); }
    // A session here: its tab counts its changes without them open, as one on another computer's does.
    if (changing && !there && !on) {
      const shown = `${controller.repo.root}\0${task.id}`, mark = countMark(task), had = patches.get(shown);
      const old = had?.mark === mark && Date.now() - had.at > Math.max(COUNT_AGAIN, (had.took ?? 0) * 20);
      if ((had?.mark !== mark || old) && countAsked !== `${shown}\0${mark}`) askCount(shown, mark);
    }
    if (offered) {
      // The count is the last one read, also while the chat shows.
      const known = !changing ? null : there ? remoteApp.changes(there) : patches.get(`${controller.repo.root}\0${task.id}`), label = changeSummary(known && !known.error ? known.changes : null);
      const word = (text, active) => active ? `${colour ? `{${PALETTE.orange}-fg}` : ''}{bold}{underline}${text}{/underline}{/bold}${colour ? '{/}' : ''}` : ink(text, 'muted', colour);
      // How many of its messages wait, here or on the computer it runs on: a click shows the first (jumpToWaiting).
      const waits = !changing ? 0 : there ? (there.remote?.waiting ?? []).length : (snapshot.queue ?? []).filter(row => row.continuationTaskId === task.id && (['blocked', 'waiting'].includes(row.state) && !(row.origin && row.state === 'waiting') || ['queued', 'starting'].includes(row.state) && !row.standupFor)).length;
      const parts = [...(timed?.chat === false ? [] : [['chat', 'Chat', !on && !scheduled && !looking]]), ...(changing ? [['changes', label, on]] : []), ...(watched ? [['artifacts', `Artifacts${!looking && artifactsUnseen(watched.items, watched.seenAt) ? ' •' : ''}`, looking]] : []), ...(timed ? [['schedule', 'Schedule', scheduled]] : []), ...(waits ? [['waiting', `${waits} waiting`, false]] : [])];
      let x = 1; tabSpots = parts.map(([name, text]) => { const spot = { name, from: x }; x += text.length + 3; return spot; });
      sessionTabs.setContent(` ${parts.map(([name, text, active]) => name === 'waiting' ? ink(text, 'orange', colour, true) : word(text, active)).join('   ')} `);
      Object.assign(sessionTabs, { top: activity.top, left: activity.left + 1, width: x - 2 });
    }
    if (!scheduled) { scheduleShown = null; if (screen.focused === scheduleList) leaveSchedule(); }
    else {
      activity.hidden = true;
      Object.assign(scheduleBox, { top: activity.top, left: activity.left, width: activity.width, height: activity.height });
      scheduleBox.style.border.fg = screen.focused === scheduleList ? accent : shade('border');
      drawSchedule(timed);
    }
    if (looking) { activity.hidden = true; drawArtifacts(watched); }
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
  // Enter on a file's "more" row reads the next page of what the session changed (taskPatch):
  // the lines that come next follow where the cursor is.
  function readMore(index) {
    const now = changesShown, entry = now?.entry; if (modal || !entry || now.rows[index]?.kind !== 'more' || !patchKey()) return;
    entry.pages = (entry.pages ?? 1) + 1; entry.cursor = index;
    askPatch(patchKey(), 0);
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
  changesBox.key(['enter', 'space'], () => changesShown?.rows[changesShown.cursor]?.kind === 'more' ? readMore(changesShown.cursor) : foldChanges(changesShown?.cursor));
  changesBox.key(['[', ']'], ch => stepChanges('file', ch === '[' ? -1 : 1));
  changesBox.key(withShift(['n', 'p']), (_, key) => stepChanges('change', key.name === 'p' ? -1 : 1));
  changesBox.key(['escape', ...withShift(['d'])], () => { if (!modal) showChat(); });
  steadyWheel(changesBox, step => moveChanges(step, { rows: true, redraw: false }), { render: () => draw() });
  artifactsBox.key(['up', 'down'], (_, key) => moveArtifacts(key.name === 'up' ? -1 : 1));
  artifactsBox.key(['pageup', 'pagedown'], (_, key) => moveArtifacts((key.name === 'pageup' ? -1 : 1) * Math.max(1, (artifactsShown?.high ?? 2) - 1)));
  artifactsBox.key(['home', 'end'], (_, key) => moveArtifacts(key.name === 'home' ? -Infinity : Infinity));
  artifactsBox.key(['escape', ...withShift(['v'])], () => { if (!modal) showChat(); });
  steadyWheel(artifactsBox, step => moveArtifacts(step, { redraw: false }), { render: () => draw() });
  artifactsBox.on('click', () => { if (!modal && screen.focused !== artifactsBox) { artifactsBox.focus(); draw(); } });
  // A click puts the cursor on its row. On a file's header it also folds or unfolds the file.
  changesBox.on('click', data => {
    const now = changesShown, index = now ? now.top + data.y - changesBox.atop - 1 : -1; if (modal || !now?.entry || index < now.top || index >= now.rows.length) return;
    if (now.rows[index].kind === 'file') foldChanges(index);
    else if (now.rows[index].kind === 'more') { now.entry.cursor = index; readMore(index); }
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
  artifactsBox.on('focus', from => { const origin = leftBox ? ask : from; if ([board, ask, activity].includes(origin)) artifactsFrom = origin; draw(); });
  // A click on a tab's name shows it: the name it is on, or the one before the gap it is in.
  sessionTabs.on('click', data => {
    const at = data.x - sessionTabs.aleft, spot = tabSpots.filter(value => at >= value.from - 1).at(-1) ?? tabSpots[0]; if (modal || !spot) return;
    catchAction(() => spot.name === 'waiting' ? jumpToWaiting() : spot.name === 'chat' ? showChat() : spot.name === 'changes' ? showChanges({ focus: true }) : spot.name === 'artifacts' ? showArtifacts({ focus: true }) : showSchedule({ focus: true }));
  });
  // Enter changes the row it is on; r, p and x act as they do on a schedule's row.
  scheduleList.on('select', () => { if (!modal) catchAction(() => scheduleChange(scheduleShown?.rows[scheduleList.selected ?? 0]?.type)); });
  scheduleList.key(['r'], () => { if (!modal) catchAction(() => scheduleChange('run')); });
  scheduleList.key(['p'], () => { if (!modal) catchAction(() => scheduleChange('pause')); });
  scheduleList.key(['x', 'delete'], () => { if (!modal) catchAction(() => scheduleChange('delete')); });
  scheduleList.key(['escape'], () => { if (modal) return; if (scheduleShown?.chat) showChat(); else { scheduleFrom = null; focusBoard(); draw(); } });
  scheduleList.on('focus', () => draw());
  scheduleList.on('select item', () => { if (!drawing) scheduleDraw(); });
  // A click on Task in the session's header opens its Task (showTask), as Ctrl+T does from anywhere.
  header.on('click', data => { const at = data.x - header.aleft; if (!modal && headerTask && at >= headerTask.from && at < headerTask.to) catchAction(showTask); });
  // Ctrl+T works while the message box is read too (ignoreLocked): its bar names it. The box
  // itself changes nothing for it (lib/editor.mjs).
  screen.key(['C-t'], () => { if (!modal && !closing) catchAction(() => { if (!sessionShown()) throw new Error('Open a session to see its Task.'); return showTask(); }); });
  // A message sent to a session on another computer from its Changes shows in its chat, as one sent to a session here does.
  ask.on('submit', text => { if (sessionView === 'changes' && remoteHere() && text.trim() && !isCommand(text)) sessionView = 'chat'; });
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
  for (const [keys, action] of [[['a'], 'add'], [['x'], 'forget'], [['d'], 'details'], [['c'], 'check'], [['s'], 'signin'], [['u'], 'up'], [['f'], 'fold']]) usageList.key(withShift(keys), () => { if (!modal) catchAction(() => usageAction(action)); });
  usageList.key(withShift(['t']), () => { if (!modal) { usagePeriod = usagePeriod === 1 ? 7 : 1; draw(); } });
  usageList.key('escape', () => focusInput());
  usageList.on('focus', () => draw());
  // The blank line, the headings and the lines under the agents cannot be chosen: an arrow, the
  // wheel or a click that lands on one goes on to the nearest row the way it was going, so Down
  // from the last account goes into Top agents and Up comes back, at any size. A row keeps in
  // view the lines over it up to the row before (the heading and the table's header over the
  // first agent), and the last one the lines under it (the spend line). A draw that moves the
  // cursor's row (a reading added an account's limits over it) is where the next arrow starts from.
  let usageAt = 0;
  const usageChosen = at => Boolean(usageRows[at]?.vendor || usageRows[at]?.agent || usageRows[at]?.none);
  usageList.on('select item', (_, at) => {
    if (drawing) { usageAt = at; return; }
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
  // A click on the heading of an agent's reply opens that agent's page (agentPage).
  activity.on('click', data => {
    if (modal) return;
    const rows = activity._clines ?? [], at = data.y - activity.atop - activity.itop + activity.childBase, line = index => String(rows[index] ?? '').replace(/\x1b\[[\d;]*m/g, '').trimStart();
    // A click on Yes, Send again, Dismiss or Reply under a message that waits does it (waitingAction).
    if (WAIT_ACTIONS.test(line(at).trim())) {
      let index = 0; for (let row = 0; row < at; row++) if (WAIT_ACTIONS.test(line(row).trim())) index++;
      const raw = String(rows[at] ?? '').replace(/\x1b\[[\d;]*m/g, ''), button = waitButtons[index], x = data.x - activity.aleft - activity.ileft;
      let from = raw.length - raw.trimStart().length;
      for (const word of button?.actions ?? []) { if (x >= from && x < from + word.length) { catchAction(() => waitingAction(button, word)); return; } from += word.length + 3; }
      return;
    }
    const heading = line(at), head = agentHeads.find(row => [row.title, row.narrow].some(text => text && (heading === text || heading.startsWith(`${text}  `))));
    if (head) { if (head.there) setMessage(agentsThere(head.there)); else catchAction(() => agentPage(head.bot)); return; }
    if (!stepKeys.length || !STEPS_LINE.test(line(at))) return;
    let turn = 0; for (let index = 0; index < at; index++) if (STEPS_LINE.test(line(index))) turn++;
    if (stepKeys[turn]) toggleSteps(stepKeys[turn]);
  });
  // Esc while /join looks for the inviter, from anywhere but the message box (which hears it first).
  screen.on('keypress', (_, key = {}) => { if (key.name === 'escape' && !modal && !closing && screen.focused !== ask) { cancelJoin(); cancelLearn(); } });
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
    if (key.name === 'escape' && (cancelJoin() || cancelLearn())) return;
    // Ctrl-O opens or folds the steps of every turn in the chat, as in Claude Code, while typing too.
    if (key.ctrl && key.name === 'o') { toggleSteps(); return; }
    if (!this.getValue()) typedFor = answerTarget();
    // Right after a command was refused, a / as the first key starts a new command in its place,
    // and ↑ brings the refused one back (replaced). Any other key changes the refused one, and so
    // does a / after its last space: that is the path it waits for.
    if (refusedBox !== null) { const was = refusedBox; refusedBox = null; if (ch === '/' && !key.ctrl && !key.meta && this.getValue() === was && glued(was)) { this.setValue(''); replaced(was); } }
    // PgUp and PgDn page the chat above the box; the text and its cursor stay as they are.
    if (['pageup', 'pagedown'].includes(key.name) && !key.ctrl && !key.meta && pageChat(key.name === 'pageup')) return;
    syncPalette();
    if (!palette.hidden) {
      // The key bar says what Enter does with the choice the mark moved to.
      if ((key.name === 'up' || key.name === 'down') && !key.shift) { palette.select((palette.selected + (key.name === 'up' ? -1 : 1) + paletteValues.length) % paletteValues.length); if (!drawing) scheduleDraw(); screen.render(); return; }
      if (key.name === 'escape') { paletteDismissed = this.getValue(); palette.hide(); screen.render(); return; }
      if (key.name === 'tab') { this.setValue(`${paletteValues[palette.selected ?? 0].value} `); syncPalette(); screen.render(); return; }
      if (key.name === 'enter' && key.sequence !== '\n') {
        const chosen = paletteValues[palette.selected ?? 0];
        // A bot's whole @name, typed out, is sent as it is: Enter alone adds that bot to the session.
        if (paletteFills()) { choosePalette(chosen); return; }
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
    const value = nativeInput.call(this, ch, key);
    // The / that set a draft aside is taken out: the draft is back, before what is left. A draft
    // held under a question to a teammate is back once that is cleared.
    if (aside?.held) { if (this._reading && !this.getValue()) bringBack(''); }
    else if (aside && this._reading && !this.getValue().trimStart().startsWith('/')) bringBack(this.getValue());
    syncPalette(); screen.render(); return value;
  };
  // On a Sessions row, and in a session's chat, every printable character starts a message:
  // it goes into the box, which takes the focus, so the rest of what is typed follows it. No
  // letter acts by itself there: a key is its letter, then Enter (rowKey). Ctrl and Alt
  // letters type nothing.
  function typesMessage(ch, key) {
    return typeof ch === 'string' && /^[^\x00-\x1f\x7f]$/u.test(ch) && !key.ctrl && !key.meta && (screen.focused === activity || listed() && screen.focused === board);
  }
  // A paste outside every box goes into the message box at once, wherever the owner types
  // a message from: a session's chat, the list beside it, a session on another computer,
  // Chats, the New session form. Never behind a dialog.
  function pasteMessage(value) {
    if (modal || closing || busy || minimumSize()) return;
    const key = { name: 'paste', sequence: value };
    if (screen.focused === board && barKey !== openKey && !opening) draw();
    if (opening) heldKeys.push([screen.focused, value, key]); else typeFrom(null, value, key);
  }
  // A / typed outside the box starts a command of its own, over a draft too: added to the
  // draft, it was sent with it, as a session, a task or a message. The draft is set aside
  // (aside) and comes back in the box once the command has run, on Esc, or once the / is
  // taken out.
  function typeFrom(from, ch, key) {
    if (screen.focused !== ask) {
      focusInput(); if (screen.focused !== ask) return;
      const draft = ask.getValue();
      if (ch === '/' && draft.trim() && !isCommand(draft) && !heldEdit) { aside = { text: draft, view, key: draftKey(), keep: draftSlot() }; ask.clearValue(); }
      // A / over a command in the box (one refused, one left there) starts a new command in its
      // place: the two never run as one. ↑ brings the one it replaced back (replaced). After the
      // command's last space it is the path the command waits for, as typed in the box.
      else if (ch === '/' && isCommand(draft) && glued(draft) && !heldEdit) { ask.clearValue(); replaced(draft); }
      typedFrom = from; typedBase = ask.getValue(); typedFor = answerTarget();
    }
    // A paste from outside every box, as a dropped file's path, goes where ELU puts it: after a
    // draft it is a word of its own, with a space between.
    if (key.name === 'paste' && /\S$/.test(ask.getValue().slice(0, ask.cursor))) ch = ` ${ch}`;
    ask._listener(ch, key);
  }
  // The draft set aside goes back in the box it came from, before rest (what the box holds
  // when the / was taken out), or alone, over the command, when rest is ''. With no rest, after
  // the command ran, it goes in only when the box is empty. Elsewhere it is kept as that
  // session's draft, when it has none.
  // A command set aside (replaced) goes back in its box over the draft that was aside under it,
  // which is aside again. Elsewhere the draft is kept first, then the command is kept as its
  // session's draft when that has none, else put in the box when that is empty, else it stays
  // aside until the box is (held).
  function bringBack(rest = null) {
    const kept = aside; aside = null; if (!kept) return;
    const home = view === kept.view && draftKey() === kept.key && (rest !== null || !ask.getValue());
    if (home) { ask.setValue(`${kept.text}${rest ?? ''}`); if (kept.command) aside = kept.under ?? null; return; }
    if (!kept.command) { if (kept.keep && !drafts.get(kept.keep)?.trim()) drafts.set(kept.keep, kept.text); return; }
    if (kept.under) { aside = kept.under; bringBack(); }
    if (kept.keep && !drafts.get(kept.keep)?.trim()) drafts.set(kept.keep, kept.text);
    else if (!ask.getValue()) ask.setValue(kept.text);
    else aside = { ...kept, under: aside, held: true };
  }
  // A character typed on a tab or a view's button starts a message there too, so nothing typed
  // is lost: q still quits, ? opens the help, and a space presses the button. On a list whose
  // letters act at once (Usage, Bots, Projects, Kanban, Chats, the New session form, a
  // session's Changes), / starts a command in the box the same way, and every key after it goes there.
  const printable = (ch, key) => typeof ch === 'string' && /^[^\x00-\x1f\x7f\s]$/u.test(ch) && !key.ctrl && !key.meta;
  screen.on('keypress', (ch, key = {}) => {
    if (modal || closing || screen.focused === ask || busy || minimumSize()) return;
    const command = key.name ?? ch;
    if ([...tabs, newCard, kanbanPick, newBot, newProject, back].includes(screen.focused) && !['q', '?'].includes(command)) { if (printable(ch, key)) typeFrom(null, ch, key); return; }
    if (ch === '/' && printable(ch, key) && [usageList, botsList, projectsList, composeList, ...kanbanLists, ...teamLists, changesBox, artifactsBox, scheduleList].includes(screen.focused)) { typeFrom(null, ch, key); return; }
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
  screen.on('keypress', () => { pressedAt = Date.now(); }); screen.program.on('mouse', () => { pressedAt = Date.now(); });
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
  // A teammate's computer that says it is mine, and is not marked here, is said once, with the two ways to agree.
  // Claude work moved to another account (lib/claude-relay.mjs, lib/runner.mjs): the status line says it once.
  let moveSaid = null; try { moveSaid = readSwitch().lastMove?.at ?? null; } catch { moveSaid = null; }
  const sentTimer = setInterval(() => {
    try { sentTick(); failedTick(); notesTick(); } catch { /* Looked at again in a moment. */ }
    try { const move = readSwitch().lastMove; if (move && move.at !== moveSaid) { moveSaid = move.at; setMessage(moveText(move)); usageData = null; } } catch { /* Said on the next look. */ }
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
    clearTimeout(timer); clearInterval(usageTimer); clearInterval(serversTimer); clearInterval(helperTimer); clearInterval(sentTimer); clearInterval(changesTimer); clearInterval(artifactsTimer); clearTimeout(patchTimer); clearTimeout(countTimer); for (const signal of ['SIGTERM', 'SIGHUP']) process.off(signal, interrupted); process.off('exit', restoreTerminal);
    if (!closing) { closing = true; await stopPushes('closed').catch(() => {}); await controller?.close(); claim.release(); screen.destroy(); }
  }
  return { terminal: true };
}
