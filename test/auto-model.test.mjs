import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { project, temp } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { createConversation } from '../lib/runner.mjs';
import { changeSettings, lock, readTask, saveTask, settingsFile } from '../lib/state.mjs';
import { atomic, personalDirectory } from '../lib/util.mjs';
import { EFFORTS, VENDORS } from '../lib/vendors.mjs';
import { LABELS } from '../lib/modes.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';
import { forgetCatalogs } from '../lib/claude-catalog.mjs';
import { WAITS_FOR, changeSwitch, dayClock, markSpent } from '../lib/claude-switch.mjs';
import { CAP_CARRY_TEXT } from '../lib/turn-limits.mjs';
import { AUTO_LINE, AUTO_TEXT } from '../lib/remote-helper.mjs';
import { ELU_TEXTS, KEEP_GOING_TEXT, eluLine, jobsEndedText, sentByElu, writtenByElu } from '../lib/elu-sent.mjs';
import { setSessionModel } from '../lib/models.mjs';
import { changeAgent, pickedOverAuto } from '../lib/agent-change.mjs';
import { agentSpend, agentTable, cleanTopAgents, topAgentsWire } from '../lib/agent-spend.mjs';
import { QUICK_ROLE } from '../lib/message-aside.mjs';
import { AUTO_EFFORT, AUTO_NAME, AUTO_WORD, LINES, autoOn, autoSettings, autoSettingsFile, autoWords, classNames, holdVendor, homeProblem, insteadKey, insteadLine, isAck, isAutoWord, isThink, ownerWords, quickText, quickVendor, routeFor, routeName, routesLine, saveAutoSettings, sayOnce, setSessionAuto, stepOf, vendorReady, vendorState } from '../lib/auto-model.mjs';

// Everything here reads a home and a personal folder of its own, made new for this run: no
// test reads what the computer it runs on has installed, signed in or saved.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-test-')));
const BEFORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
fs.mkdirSync(path.join(ROOT, 'home'));
Object.assign(process.env, { HOME: path.join(ROOT, 'home'), XDG_CONFIG_HOME: path.join(ROOT, 'personal') });
test.after(() => {
  for (const [key, value] of Object.entries(BEFORE)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(ROOT, { recursive: true, force: true });
});
const LIB = fileURLToPath(new URL('../lib/', import.meta.url));

// Stand-in vendor programs: files that are only found, never run. home: a home folder of the
// test's own. The personal folder is this run's, so what the app keeps per computer (the
// one-time check, the Claude catalog, the account marks) is read where the tests write it.
function computer(t, names, { own = false } = {}) {
  const parent = temp(t), dir = path.join(parent, 'bin'), home = path.join(parent, 'home');
  fs.mkdirSync(dir); fs.mkdirSync(home);
  for (const name of names) fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const bin = name => fs.realpathSync(path.join(dir, name));
  // own: a personal folder of the test's own, for what it saves in the settings file.
  return { dir, home, bin, env: { PATH: dir, HOME: home, XDG_CONFIG_HOME: own ? path.join(parent, 'personal') : process.env.XDG_CONFIG_HOME } };
}
// The catalog the installed Claude Code would give, kept as the app keeps it between starts.
const CATALOG = { 'claude-fable-5-2': 'high', 'claude-fable-5-1': 'high', 'claude-opus-5-5': 'medium', 'claude-opus-5': 'medium', 'claude-sonnet-5': 'medium', 'claude-haiku-5-5': 'low', 'claude-haiku-5': 'low' };
function catalog(bin, efforts = CATALOG) {
  const stat = fs.statSync(bin);
  atomic(path.join(personalDirectory(), 'claude-catalog.json'), { version: 1, programs: [{ file: bin, size: stat.size, mtimeMs: stat.mtimeMs, efforts }] });
  forgetCatalogs();
}
// Grok Build signed in, and past its one-time check on this computer.
function grokReady(c, { signedIn = true, checked = true } = {}) {
  if (signedIn) { fs.mkdirSync(path.join(c.home, '.grok'), { recursive: true }); fs.writeFileSync(path.join(c.home, '.grok', 'auth.json'), '{}\n', { mode: 0o600 }); }
  const file = path.join(personalDirectory(), 'conformance', 'grok.json');
  if (checked) atomic(file, { v: 1, bin: c.bin('grok'), version: '1.0.77', steps: Object.fromEntries(ADAPTERS.grok.conformance.map(step => [step.id, 'pass'])), relay: true, at: new Date().toISOString() });
  else fs.rmSync(file, { force: true });
}
const CODEX = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];

// ---- Steps ----

// A session that has a reply, with no turn working, nothing open and somewhere for a quick question to go.
const IDLE = { idle: true, replied: true, quick: true };
const step = (text, state = {}) => stepOf(text, { ...IDLE, ...state });

test('the messages a text-only rule got wrong each get the step the session state gives', () => {
  const rows = [
    [1, 'is this safe to merge?', {}, 'plan'],
    [2, 'can this deadlock?', {}, 'plan'],
    [3, 'how does the auth flow work end to end?', {}, 'plan'],
    [4, 'are you sure?', {}, 'plan'],
    [5, 'what did you mean by step 3?', {}, 'plan'],
    // A Task waits: the model that wrote it answers, and may revise it.
    [6, 'does that cover the mobile case?', { waiting: true }, 'plan'],
    // The work stopped on a question: this is the answer it waits for.
    [7, 'what do you recommend?', { work: 'stopped', asked: true, met: 1, objectives: 3 }, 'edit'],
    [8, 'can you make the retry count configurable?', {}, 'plan'],
    [9, 'could you bump the version to 1.4.2?', {}, 'plan'],
    [10, 'would you rename the flag to dryRun?', {}, 'plan'],
    [11, "what's the root cause?", {}, 'plan'],
    // The same after failed checks, with the work going on: the model at work answers.
    [11, "what's the root cause?", { work: 'going', met: 1, objectives: 3 }, 'edit'],
    [12, 'which approach is better here?', {}, 'plan'],
    [13, 'what happens if two workers pick the same job?', {}, 'plan'],
    [14, 'anything else I should worry about before shipping?', {}, 'plan'],
    [15, 'did the tests pass?', {}, 'plan'],
    [16, 'kannst du den Fehler in auth.ts beheben?', {}, 'plan'],
    [17, '¿por qué falla el build?', {}, 'plan'],
    // A standing instruction that ends in "ok?" is no acknowledgement.
    [18, 'from now on use pnpm here, ok?', {}, 'plan'],
    [19, 'how do I run the tests?', {}, 'quick'],
    [20, 'where is the build script?', {}, 'quick'],
    [21, 'what does the add command do?', {}, 'quick'],
    [22, 'why is it called ELU?', {}, 'plan'],
    [23, 'explain what a mutex is', {}, 'plan'],
    [24, 'thanks', {}, 'stay'],
    [24, 'ok', {}, 'stay'],
    [24, 'got it', {}, 'stay'],
    [25, 'what do you think the port is?', {}, 'plan'],
    [26, 'テストはどこにありますか？', {}, 'plan'],
  ];
  assert.deepEqual([...new Set(rows.map(row => row[0]))], Array.from({ length: 26 }, (_, index) => index + 1));
  for (const [number, text, state, expected] of rows) assert.equal(step(text, state), expected, `${number}: ${text}`);
  // None of the eighteen that were harmful reaches the fast model, whatever the session's state.
  for (const [number, text] of rows.filter(row => row[0] <= 18)) assert.equal(quickText(text), false, `${number}: ${text}`);
});

test('the quick table of the design', () => {
  const rows = [
    ['how do I run the tests?', {}, true],
    ['where is the build script?', {}, true],
    ['what does the add command do?', {}, true],
    ['where is the function that parses the config?', {}, true],
    ['is this safe to merge?', {}, false],
    ["what's the root cause?", {}, false],
    ['what is left?', {}, false],
    ['how do I roll this back?', {}, false],
    ['can you make the retry count configurable?', {}, false],
    ['what did you mean by step 3?', {}, false],
    ['does that cover the mobile case?', { waiting: true }, false],
  ];
  for (const [text, state, quick] of rows) {
    assert.equal(step(text, state) === 'quick', quick, text);
    assert.equal(quickText(text), quick, text);
  }
  // A quick text is still not a quick question while a Task waits.
  assert.equal(step('where is the build script?', { waiting: true }), 'plan');
});

test('each session state of the Steps table', () => {
  // It starts a new session.
  assert.equal(stepOf('add a dark mode', { first: true }), 'plan');
  assert.equal(stepOf('where is the build script?', { first: true, idle: true, quick: true }), 'plan');
  // No Task is open.
  assert.equal(step('add a dark mode'), 'plan');
  assert.equal(step('add a dark mode', { met: null, objectives: null }), 'plan');
  // A Task waits for approval, and anything but a plain yes.
  assert.equal(step('make the second objective smaller', { waiting: true }), 'plan');
  // A plain yes to a waiting Task: the approval it always was.
  for (const yes of ['yes', 'ok', 'go ahead', 'sounds good, thanks']) assert.equal(step(yes, { waiting: true }), 'edit', yes);
  assert.equal(step('fine by me', { waiting: true, yes: true }), 'edit');
  assert.equal(step('yes', { waiting: true, yes: false }), 'plan');
  // The approved Task's work is starting, going on, or stopped on a question, a block or a stop.
  assert.equal(step('use the staging database', { work: 'starting', met: 0, objectives: 3 }), 'edit');
  assert.equal(step('use the staging database', { work: 'going', met: 1, objectives: 3 }), 'edit');
  assert.equal(step('use the staging database', { met: 1, objectives: 3 }), 'edit');
  assert.equal(step('use the staging database', { work: 'going' }), 'edit');
  assert.equal(step('use the staging database', { work: 'stopped', met: 2, objectives: 3 }), 'edit');
  assert.equal(step('use the staging database', { work: 'stopped', asked: true, met: 3, objectives: 3 }), 'edit');
  // The work ended (every objective reported met) and a new ask.
  assert.equal(step('now add tests for the parser', { met: 3, objectives: 3 }), 'plan');
  assert.equal(step('now add tests for the parser', { work: 'going', met: 3, objectives: 3 }), 'plan');
  // "ok", "thanks", "got it" with nothing waiting: no step.
  for (const text of ['ok', 'thanks', 'got it']) {
    assert.equal(step(text), 'stay', text);
    assert.equal(step(text, { met: 3, objectives: 3 }), 'stay', text);
  }
  // With the work going on, the same word tells the model at work to carry on.
  assert.equal(step('ok', { met: 1, objectives: 3 }), 'edit');
  // A simple lookup question, with the session idle and not waiting on the owner.
  assert.equal(step('where is the build script?'), 'quick');
  assert.equal(step('where is the build script?', { met: 3, objectives: 3 }), 'quick');
  assert.equal(step('where is the build script?', { met: 1, objectives: 3 }), 'quick');
});

test('a quick question needs every line of the session half of the rule', () => {
  const text = 'where is the build script?';
  assert.equal(step(text, { idle: false }), 'plan');
  assert.equal(step(text, { replied: false }), 'plan');
  assert.equal(step(text, { asked: true }), 'plan');
  assert.equal(step(text, { toModel: true }), 'plan');
  assert.equal(step(text, { quick: false }), 'plan');
  assert.equal(step(text, { waiting: true }), 'plan');
  assert.equal(step(text, { work: 'stopped' }), 'edit');
  assert.equal(step(text, { work: 'starting' }), 'edit');
  // Without a route it is an ordinary message: an edit while the work goes on.
  assert.equal(step(text, { quick: false, met: 1, objectives: 3 }), 'edit');
  // No state at all picks the careful step.
  assert.equal(stepOf(text), 'plan');
  assert.equal(stepOf(text, null), 'plan');
});

test('a message to a bot picks no step, and the owner\'s approval is an edit', () => {
  assert.equal(step('review the diff', { toBot: true }), 'stay');
  assert.equal(step('yes', { toBot: true, waiting: true }), 'stay');
  assert.equal(stepOf('look at this', { toBot: true, first: true }), 'stay');
  assert.equal(step('Approved the Task: Add a dark mode', { approved: true, work: 'starting' }), 'edit');
  assert.equal(step(`${LABELS.auto} approved the Task: Add a dark mode`, { approved: true }), 'edit');
  // To @model it is a step like any other, never a quick question.
  assert.equal(step('add a dark mode', { toModel: true }), 'plan');
});

test('the text half of the quick rule', () => {
  const yes = ['what is the default port?', "what's the test command?", 'what’s the test command?', 'What are the build targets?', 'what does --dry-run do', 'where is the config file', 'where are the fixtures?', 'which file holds the routes?', 'which command starts the server?', 'How do I start the dev server?', 'how to run one test file', 'what is the preview port?', 'how do I address the server?', 'what does the explain command print?',
    // that in the middle joins two parts and points at nothing.
    'where is the function that parses the config?', 'which file sets the port?', 'which command starts the dev server?', 'where is the state stored?'];
  for (const text of yes) assert.equal(quickText(text), true, text);
  const no = [
    // Not one of the openers.
    'is the port 8080?', 'who wrote the parser?', 'when does the cache expire?', 'whats the test command?', "what isn't covered?", 'which approach fits?', 'how does the cache work?', 'run the tests', 'the build script, where is it?',
    // It speaks to the model.
    'what is your plan for the tests?', 'how do I get you to stop?', "what's the file you're editing?", 'where is the script, please?',
    // A word that asks for a judgment, in any of its forms, and the two phrases.
    'why is it slow?', 'what is the cause of the timeout?', 'what is causing the timeout?', 'what is wrong with the build?', 'what is failing?', 'what is the failure in CI?', 'where is the broken link?', 'what does this error mean?', 'where is the bug?', 'what is the safe way to migrate?', 'what is the secure default?', 'where is the race?', 'where is the deadlock?', 'where is the leak?', 'what is the correct flag?', 'what is the right port?', 'what is the better option?', 'what is the best flag?', 'what is worse here?', 'what is the risk?', "what's the thing I shouldn't touch?", 'how do I compare two runs?', 'what is the design of the cache?', 'what is the plan?', 'how do I review a diff?', 'what is there to think about?', 'what is the port and what if it is taken?', 'what is the order and what happens if it changes?',
    // Asking how to mend something, or about something that misbehaves.
    'how to fix the build?', 'how do I fix the lint step?', 'how do I debug the worker?', 'how to solve the merge conflict', 'what is slow in the build?', 'where is the test that hangs?', 'what is the flaky test?', 'where is the crash?',
    // What is behind something or follows from it, a choice, and how to do a piece of work, in other words.
    'what is the problem?', 'what is the reason the CI is red?', 'where is the regression coming from?', 'what is the source of the memory growth?', 'which file has the problem?', 'what is the tradeoff?', 'what are the pros and cons?', 'what are the edge cases?', 'what is the impact of this change?', 'what is the recommended approach?', 'what is the priority?', 'what is blocking the release?',
    'how do I roll this back?', 'how do I revert this change?', 'how do I migrate the users table without downtime?', 'how do I make the retry count configurable?', 'how to handle concurrent writes here?',
    // A word that points into the conversation or at the state of the work.
    'what is left?', 'where are we?', "what's next?", 'what is the status?', 'what does step 3 mean?', 'what is that?', 'how do I do that?',
    // Not plain English letters, more than one paragraph, or too long.
    'what is the café port?', 'where is the build script?\n\nand the tests?', 'what is\tthe port?', `what is ${'a'.repeat(113)}?`, '', '   ',
  ];
  for (const text of no) assert.equal(quickText(text), false, text);
  assert.equal(quickText(`what is ${'a'.repeat(112)}`), true);
  assert.equal(`what is ${'a'.repeat(112)}`.length, 120);
  for (const value of [null, undefined, 7, {}, ['what is this']]) assert.equal(quickText(value), false);
});

test('an acknowledgement is the plain yes words and the thanks words, alone', () => {
  for (const text of ['thanks', 'Thanks!', 'thank you', 'ty', 'nice', 'great', 'cool', 'got it', 'ok', 'okay', 'OK, thanks', 'cool, got it', 'nice, thank you', 'yes', 'sounds good', 'go ahead', 'lgtm', 'continue']) assert.equal(isAck(text), true, text);
  for (const text of ['', 'it', 'you', 'ok?', 'thanks, now add the tests', 'ok but use pnpm', 'got it working yet', 'nice try with the parser', 'danke', 'merci', 'from now on use pnpm here, ok?', 'thanks thanks thanks thanks thanks thanks thanks']) assert.equal(isAck(text), false, text);
  for (const value of [null, undefined, 3, {}]) assert.equal(isAck(value), false);
  assert.equal(isThink('think'), true); assert.equal(isThink('  Think '), true);
  assert.equal(isThink('think about it'), false); assert.equal(isThink(null), false);
});

// ---- Classes ----

test('Codex\'s classes are the newest of each family word it lists', () => {
  assert.deepEqual(classNames('codex', { codexModels: CODEX }), { top: 'gpt-6-astra', work: 'gpt-6.1-sol', fast: 'gpt-6-luna' });
  assert.deepEqual(classNames('codex', { codexModels: [...CODEX].reverse() }), { top: 'gpt-6-astra', work: 'gpt-6.1-sol', fast: 'gpt-6-luna' });
  // As the vendor's list gives them, a row a name.
  assert.deepEqual(classNames('codex', { codexModels: CODEX.map(name => ({ name, note: '' })) }), { top: 'gpt-6-astra', work: 'gpt-6.1-sol', fast: 'gpt-6-luna' });
  assert.deepEqual(classNames('codex', { codexModels: [] }), { top: null, work: null, fast: null });
  // Terra is in no class, and a name with no family word is none.
  assert.deepEqual(classNames('codex', { codexModels: ['gpt-6.1-terra', 'gpt-5.5', 'o9', 'gpt-7-astra-preview', null, {}] }), { top: null, work: null, fast: null });
  assert.deepEqual(classNames('codex', { codexModels: ['gpt-5.6-sol', 'gpt-10-sol', 'gpt-9.12-sol', 'gpt-9.2-sol'] }), { top: null, work: 'gpt-10-sol', fast: null });
  assert.deepEqual(classNames('codex', { codexModels: ['gpt-6-luna', 'gpt-6.2-luna', 'gpt-7-astra'] }), { top: 'gpt-7-astra', work: null, fast: 'gpt-6.2-luna' });
});

test('Codex with no names known has no class, and none is made up', t => {
  const c = computer(t, ['codex']);
  assert.deepEqual(classNames('codex', { env: c.env }), { top: null, work: null, fast: null });
  assert.equal(homeProblem('codex', { env: c.env }), LINES.noClasses('codex'));
  assert.equal(routeFor('plan', { home: 'codex', env: c.env }), null);
  assert.equal(routesLine({ home: 'codex', env: c.env }), '');
  // Not installed at all: the same.
  assert.deepEqual(classNames('codex', { env: computer(t, []).env }), { top: null, work: null, fast: null });
});

test('Claude Code\'s classes are its two aliases and the newest Haiku its catalog lists', t => {
  const c = computer(t, ['claude']);
  // No catalog in the program: the fast model the design names.
  assert.deepEqual(classNames('claude', { env: c.env }), { top: 'fable', work: 'opus', fast: 'claude-haiku-5-5' });
  assert.equal(routeName('claude', 'fable', { env: c.env }), 'Fable');
  catalog(c.bin('claude'));
  assert.deepEqual(classNames('claude', { env: c.env }), { top: 'fable', work: 'opus', fast: 'claude-haiku-5-5' });
  assert.equal(routeName('claude', 'fable', { env: c.env }), 'Fable 5.2');
  assert.equal(routeName('claude', 'opus', { env: c.env }), 'Opus 5.5');
  assert.equal(routeName('claude', 'claude-haiku-5-5', { env: c.env }), 'Haiku 5.5');
  catalog(c.bin('claude'), { ...CATALOG, 'claude-haiku-6': 'low', 'claude-haiku-5-9': 'low' });
  assert.equal(classNames('claude', { env: c.env }).fast, 'claude-haiku-6');
  // Not installed here: the names still read, since a session of Claude Code may run elsewhere.
  assert.deepEqual(classNames('claude', { env: computer(t, []).env }), { top: 'fable', work: 'opus', fast: 'claude-haiku-5-5' });
  // A vendor's own default is named by the vendor, and another vendor's name as a reply's header reads it.
  assert.equal(routeName('grok', null), 'Grok Build');
  assert.equal(routeName('codex', 'gpt-6.1-sol'), 'gpt-6.1-sol');
});

test('Antigravity and Grok Build have no classes, and Auto model needs Claude Code or Codex', () => {
  for (const vendor of ['agy', 'grok', 'other', null, undefined]) {
    assert.deepEqual(classNames(vendor, { codexModels: CODEX }), { top: null, work: null, fast: null });
    assert.equal(homeProblem(vendor, { codexModels: CODEX }), 'Auto model needs Claude Code or Codex for this session.');
    for (const kind of ['plan', 'edit', 'quick']) assert.equal(routeFor(kind, { home: vendor, codexModels: CODEX }), null);
    assert.equal(routesLine({ home: vendor, codexModels: CODEX }), '');
  }
  assert.equal(homeProblem('claude'), null);
  assert.equal(homeProblem('codex', { codexModels: CODEX }), null);
  assert.equal(homeProblem('codex', { codexModels: ['gpt-6-astra', 'gpt-6-luna'] }), 'Auto model needs a top model and a work model, and Codex does not list both on this computer.');
});

// ---- Whose words ----

test('only the owner\'s own typed words pick a step: one request of each kind', t => {
  const session = { continuationTaskId: '3', priority: 0 }, typed = { ...session, typed: true }, key = 'c'.repeat(64);
  const jobs = jobsEndedText([{ name: 'gate', code: 0, signal: null, ranMs: 61000, log: path.join(temp(t), 'no.log') }]);
  const mine = [
    ['a message he types in a session', { ...typed, goal: 'fix the login redirect' }],
    ['the message that starts a session', { goal: 'add a dark mode', typed: true, priority: 0, permissions: 'ask', place: { kind: 'worktree' }, folders: [], bots: [], picked: true }],
    ['a new session with Auto model on', { goal: 'add a dark mode', typed: true, priority: 0, permissions: 'auto', auto: true }],
    ['a message to @model', { ...typed, goal: 'add a dark mode', toModel: true }],
    ['his approval of a Task, by the key', { ...typed, goal: 'Approved the Task: Add a dark mode', approved: true }],
    ['a Task the mode he set approved', { ...typed, goal: `${LABELS.auto} approved the Task: Add a dark mode`, approved: true }],
    ['a request no retry has touched', { ...typed, goal: 'fix the login redirect', attempts: 0 }],
    ['a card he starts from the board', { goal: 'Ship the settings page', typed: true, priority: 0, permissions: 'ask' }],
    // The work it reopens is a step like any other.
    ['a new goal he types in the Done check', { ...typed, goal: 'The owner gave this session a new goal.', goalChange: { task: 't-0a1b2c3d', revision: 2 } }],
  ];
  for (const [what, row] of mine) assert.equal(ownerWords(row), true, what);
  const notMine = [
    ['1 keep going', { ...session, goal: KEEP_GOING_TEXT }],
    ['1 keep going, through a typed path', { ...typed, goal: KEEP_GOING_TEXT }],
    ['2 jobs that ended', { ...session, goal: jobs }],
    ['2 jobs that ended, through a typed path', { ...typed, goal: jobs }],
    ['3 carry on after an old time limit', { ...typed, goal: CAP_CARRY_TEXT }],
    ['4 a helper\'s own turn', { ...typed, goal: AUTO_TEXT('laptop', 2) }],
    ['5 a retry after a stall or a rate limit', { ...typed, goal: 'fix the login redirect', attempts: 1 }],
    ['6 the restart after a Claude limit reset', { ...typed, goal: 'fix the login redirect', waitsFor: WAITS_FOR }],
    // The turn it starts again runs on the model the failed one ran on.
    ['the retry key', { ...typed, goal: 'fix the login redirect', attempts: 0, retried: true }],
    ['10 a schedule that came due', { goal: 'Check the nightly build', scheduleId: 'schedule-0a1b2c3d', priority: 1 }],
    ['10 a schedule run now by hand', { goal: 'Check the nightly build', scheduleId: 'schedule-0a1b2c3d', priority: 1, typed: true }],
    ['11 a bot\'s schedule', { goal: 'Review what changed', bot: 'reviewer', scheduled: true, typed: true }],
    ['12 a message to a bot', { ...typed, goal: 'look at the diff', bot: 'reviewer' }],
    ['12 a bot chat', { goal: 'look at the diff', typed: true, bot: 'reviewer', botChat: true }],
    ['17 a Standup', { goal: '/standup', typed: true, standup: true }],
    ['17 a Standup\'s question to a session', { ...typed, goal: 'Standup: what are you working on?', standupFor: { round: 'r1', by: '@owner' } }],
    ['19 a teammate\'s message he accepted', { goal: 'Answer the question from @sara', typed: true, origin: { kind: 'ask', peer: key, name: 'sara' }, readOnly: true }],
    ['19 a teammate\'s handoff', { goal: 'Work on the handoff from @sara', typed: true, origin: { kind: 'handoff', peer: key, name: 'sara' } }],
    ['20 the answer to his own ask', { ...typed, goal: 'Continue with the answer from @sara shown in the peer data block.', origin: { kind: 'answer', peer: key, name: 'sara' }, readOnly: true }],
    ['21 a message from his other computer', { ...session, goal: 'fix the login redirect', computer: key }],
    ['21 a session his other computer started', { goal: 'add a dark mode', priority: 0, computer: key, permissions: 'ask', typed: true }],
    ['21 his other computer\'s approval', { ...typed, goal: 'Approved the Task: Add a dark mode', approved: true, computer: key }],
    ['21 words another computer added to a waiting request', { ...typed, goal: 'fix the login redirect\n\nand the logout one', adds: key }],
    ['23 a session another session\'s model started', { goal: 'add a dark mode', typed: true, priority: 0, permissions: 'ask', byElu: true }],
    ['24 a new goal typed on his other computer', { ...typed, goal: 'The owner gave this session a new goal.', goalChange: { task: 't-0a1b2c3d', revision: 2 }, computer: key }],
    ['24 a new goal, retried by the key', { ...typed, goal: 'The owner gave this session a new goal.', goalChange: { task: 't-0a1b2c3d', revision: 2 }, retried: true }],
    ['25 a copy of a session', { goal: 'add a dark mode', typed: true, priority: 0, copied: true, model: { vendor: 'claude', model: 'opus' } }],
    ['26 a local program with the owner\'s token', { goal: 'add a dark mode', permissions: 'ask' }],
    ['27 the continuation after a mode was raised', { ...typed, goal: `Continue where you stopped: this session now has ${LABELS.full}. Try again only this: npm test. Do not retry anything the owner said no to or that is never allowed.` }],
    ['27 the same, marked', { ...typed, goal: 'anything ELU wrote', byElu: true }],
    ['a helper session', { ...typed, goal: 'help the session there', helps: { machine: key, name: 'laptop', remoteId: 'r1' } }],
    ['a read-only run', { ...typed, goal: 'what changed?', readOnly: true }],
    ['a request nobody typed', { ...session, goal: 'fix the login redirect' }],
    ['a request marked typed by anything but true', { ...session, goal: 'fix the login redirect', typed: 'yes' }],
  ];
  for (const [what, row] of notMine) assert.equal(ownerWords(row), false, what);
  for (const value of [null, undefined, 'fix it', [], 3]) assert.equal(ownerWords(value), false);
});

test('one list names every text ELU sends by itself, and the chat reads the two it always did', t => {
  const jobs = jobsEndedText([{ name: 'gate', code: 0, signal: null, ranMs: 61000, log: path.join(temp(t), 'no.log') }]);
  const helper = AUTO_TEXT('laptop', 1), lifted = `Continue where you stopped: this session now has ${LABELS.auto}. Try again only this: npm install; npm test. Do not retry anything the owner said no to or that is never allowed.`;
  assert.deepEqual(ELU_TEXTS.map(row => row.id), ['keep-going', 'jobs-ended', 'carry-on', 'helper-turn', 'mode-continue']);
  const kind = text => ELU_TEXTS.filter(row => row.is(text)).map(row => row.id);
  assert.deepEqual(kind(KEEP_GOING_TEXT), ['keep-going']);
  assert.deepEqual(kind(jobs), ['jobs-ended']);
  assert.deepEqual(kind(CAP_CARRY_TEXT), ['carry-on']);
  assert.deepEqual(kind(helper), ['helper-turn']);
  assert.deepEqual(kind(lifted), ['mode-continue']);
  for (const text of [KEEP_GOING_TEXT, jobs, CAP_CARRY_TEXT, helper, lifted]) assert.equal(writtenByElu(text), true, text.slice(0, 40));
  for (const text of ['Carry on where you stopped.', 'continue where you stopped', 'fix the login redirect', 'ELU: a job of this session ended.', '', null, undefined, 4]) assert.equal(writtenByElu(text), false, String(text));
  // The helper's text is known by the same words its own pane knows it by.
  assert.match(helper, AUTO_LINE);
  // The continuation is written in lib/terminal.mjs: its opening words there are the ones matched here.
  for (const mode of ['ask', 'auto', 'full']) assert.equal(writtenByElu(`Continue where you stopped: this session now has ${LABELS[mode]}. Try again only this: x.`), true, mode);
  assert.ok(fs.readFileSync(path.join(LIB, 'terminal.mjs'), 'utf8').includes('`Continue where you stopped: this session now has ${LABELS[mode]}. Try again only this: '));
  // What the chat draws as one line of ELU's is as it was: the two, and no other.
  assert.equal(sentByElu(KEEP_GOING_TEXT), true); assert.equal(sentByElu(jobs), true);
  for (const text of [CAP_CARRY_TEXT, helper, lifted, 'fix it', null]) { assert.equal(sentByElu(text), false); assert.equal(eluLine(text), null); }
});

// ---- This computer's settings ----

test('the settings file: defaults, a merge, and back', t => {
  const c = computer(t, [], { own: true }), env = c.env, file = autoSettingsFile(env);
  assert.equal(file, path.join(env.XDG_CONFIG_HOME, 'elu-code', 'auto-model.json'));
  assert.equal(autoSettingsFile(), path.join(personalDirectory(), 'auto-model.json'));
  assert.deepEqual(autoSettings({ env }), { effort: 'xhigh', quick: null, default: false, hold: {} });
  assert.equal(AUTO_EFFORT, 'xhigh');
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(saveAutoSettings({ effort: 'high' }, { env }), { effort: 'high', quick: null, default: false, hold: {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, effort: 'high', quick: null, default: false, hold: {} });
  // Each change is merged into what is there.
  saveAutoSettings({ quick: 'grok' }, { env }); saveAutoSettings({ default: true }, { env });
  assert.deepEqual(autoSettings({ env }), { effort: 'high', quick: 'grok', default: true, hold: {} });
  for (const quick of ['home', 'off', 'claude', 'codex', null]) assert.equal(saveAutoSettings({ quick }, { env }).quick, quick);
  // A change may be worked out from the settings as they read under the lock.
  assert.equal(saveAutoSettings(was => ({ effort: was.effort === 'high' ? 'max' : 'low' }), { env }).effort, 'max');
  assert.deepEqual(saveAutoSettings({}, { env }), { effort: 'max', quick: null, default: true, hold: {} });
  assert.deepEqual(saveAutoSettings(null, { env }), { effort: 'max', quick: null, default: true, hold: {} });
  // A value that is none is refused with the ones there are, and nothing changes.
  assert.throws(() => saveAutoSettings({ effort: 'huge' }, { env }), { message: `Effort for Auto model is one of: ${EFFORTS.join(', ')}.` });
  assert.throws(() => saveAutoSettings({ quick: 'nowhere' }, { env }), { message: LINES.quickUse });
  assert.throws(() => saveAutoSettings({ quick: 'agy' }, { env }), { message: 'Antigravity CLI has no fast model for quick questions.' });
  assert.deepEqual(autoSettings({ env }), { effort: 'max', quick: null, default: true, hold: {} });
  // The lock is given back, and no half-written file is left beside it.
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['auto-model.json']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a settings file edited by hand is read value by value, and one that cannot be read gives the defaults', t => {
  const c = computer(t, [], { own: true }), env = c.env, file = autoSettingsFile(env), now = 1_800_000_000_000;
  atomic(file, { version: 1, effort: 'huge', quick: 'nowhere', default: 'yes', hold: { grok: 'soon', claude: now - 1, codex: now + 1000, other: now + 1000 }, holdSignIn: { codex: 'a|b', claude: 'gone', grok: 7 }, extra: true });
  assert.deepEqual(autoSettings({ env, now }), { effort: 'xhigh', quick: null, default: false, hold: { codex: now + 1000 }, holdSignIn: { codex: 'a|b' } });
  // A hold past its time says nothing.
  assert.deepEqual(autoSettings({ env, now: now + 1000 }), { effort: 'xhigh', quick: null, default: false, hold: {} });
  for (const text of ['{ not json', '[]', '"auto"', 'null', '']) { fs.writeFileSync(file, text); assert.deepEqual(autoSettings({ env, now }), { effort: 'xhigh', quick: null, default: false, hold: {} }, text); }
  // Never throws, whatever stands where the file should be.
  fs.rmSync(file); fs.mkdirSync(file);
  assert.deepEqual(autoSettings({ env, now }), { effort: 'xhigh', quick: null, default: false, hold: {} });
  fs.rmdirSync(file); fs.symlinkSync(path.join(c.home, 'elsewhere.json'), file);
  assert.deepEqual(autoSettings({ env, now }), { effort: 'xhigh', quick: null, default: false, hold: {} });
});

// ---- Vendors and the quick route ----

test('what is known of a vendor without running it', t => {
  const c = computer(t, ['claude', 'codex', 'grok', 'agy'], { own: true }), env = c.env;
  assert.deepEqual(vendorState('grok', { env: computer(t, []).env }), { vendor: 'grok', installed: false, signedIn: null, block: null, held: false, ready: false });
  for (const vendor of ['other', null, undefined]) assert.equal(vendorReady(vendor, { env }), false);
  // Claude Code and Codex: no file says whether a sign-in works, so no account named is not a no.
  for (const vendor of ['claude', 'codex']) assert.deepEqual(vendorState(vendor, { env }), { vendor, installed: true, signedIn: null, block: null, held: false, ready: true });
  fs.writeFileSync(path.join(c.home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'owner@example.invalid' } }));
  assert.equal(vendorState('claude', { env }).signedIn, true);
  // Grok Build: signed in is its token file, and its one-time check must have passed for a read-only run.
  grokReady(c, { signedIn: false, checked: false });
  let state = vendorState('grok', { env });
  assert.equal(state.installed, true); assert.equal(state.signedIn, false); assert.equal(state.ready, false);
  assert.match(state.block, /has not been checked on this machine yet/);
  grokReady(c, { signedIn: true, checked: false });
  state = vendorState('grok', { env });
  assert.equal(state.signedIn, true); assert.equal(state.ready, false); assert.match(state.block, /has not been checked/);
  // Full access is never stopped by the check, so only a read-only run is asked about here.
  assert.equal(vendorState('grok', { env, mode: 'full' }).block, null);
  grokReady(c);
  assert.deepEqual(vendorState('grok', { env }), { vendor: 'grok', installed: true, signedIn: true, block: null, held: false, ready: true });
  assert.equal(vendorReady('grok', { env }), true);
  // Antigravity: never checked here, so not ready, and it has no fast model anyway.
  assert.equal(vendorReady('agy', { env }), false);
});

test('a quick question goes to the first place that applies', t => {
  const c = computer(t, ['claude', 'codex', 'grok'], { own: true }), env = c.env, more = { env, codexModels: CODEX };
  catalog(c.bin('claude')); grokReady(c);
  // Nothing set: Grok Build when it is ready, whatever the session's own vendor.
  assert.equal(quickVendor({ home: 'claude', ...more }), 'grok');
  assert.equal(quickVendor({ home: 'codex', ...more }), 'grok');
  assert.deepEqual(routeFor('quick', { home: 'claude', ...more }), { step: 'quick', vendor: 'grok', model: null, name: 'Grok Build' });
  // Grok Build not past its one-time check: the fast model of the session's own vendor. The check is never started.
  grokReady(c, { checked: false });
  assert.equal(quickVendor({ home: 'claude', ...more }), 'claude');
  assert.deepEqual(routeFor('quick', { home: 'claude', ...more }), { step: 'quick', vendor: 'claude', model: 'claude-haiku-5-5', name: 'Haiku 5.5' });
  assert.deepEqual(routeFor('quick', { home: 'codex', ...more }), { step: 'quick', vendor: 'codex', model: 'gpt-6-luna', name: 'Gpt Luna 6' });
  // Not signed in: the same.
  grokReady(c, { signedIn: true, checked: true }); fs.rmSync(path.join(c.home, '.grok'), { recursive: true });
  assert.equal(quickVendor({ home: 'claude', ...more }), 'claude');
  grokReady(c);
  // The vendor the owner set comes first; when it cannot take one, the session's own vendor,
  // never a second vendor he did not name, however ready Grok Build is.
  saveAutoSettings({ quick: 'codex' }, { env });
  assert.equal(quickVendor({ home: 'claude', ...more }), 'codex');
  assert.equal(quickVendor({ home: 'claude', env, codexModels: ['gpt-6-astra', 'gpt-6.1-sol'] }), 'claude');
  assert.equal(quickVendor({ home: 'codex', env, codexModels: ['gpt-6-astra', 'gpt-6.1-sol'] }), null);
  saveAutoSettings({ quick: 'claude' }, { env });
  assert.equal(quickVendor({ home: 'codex', ...more }), 'claude');
  holdVendor('claude', 'unknown', { env });
  assert.equal(quickVendor({ home: 'codex', ...more }), 'codex');
  assert.equal(quickVendor({ home: 'claude', ...more }), null);
  saveAutoSettings({ hold: {} }, { env });
  // Grok Build named and not ready yet: the session's own vendor meanwhile.
  saveAutoSettings({ quick: 'grok' }, { env });
  assert.equal(quickVendor({ home: 'claude', ...more }), 'grok');
  grokReady(c, { checked: false });
  assert.equal(quickVendor({ home: 'claude', ...more }), 'claude');
  assert.equal(quickVendor({ home: 'codex', ...more }), 'codex');
  grokReady(c);
  // home: only the session's own vendor, so project text goes to no second vendor.
  saveAutoSettings({ quick: 'home' }, { env });
  assert.equal(quickVendor({ home: 'claude', ...more }), 'claude');
  assert.equal(quickVendor({ home: 'codex', ...more }), 'codex');
  assert.equal(quickVendor({ home: 'codex', env, codexModels: [] }), null);
  // off: nowhere, and the message is not quick.
  saveAutoSettings({ quick: 'off' }, { env });
  assert.equal(quickVendor({ home: 'claude', ...more }), null);
  assert.equal(routeFor('quick', { home: 'claude', ...more }), null);
  // The settings the caller already read are the ones used.
  assert.equal(quickVendor({ home: 'claude', ...more, settings: { quick: null, hold: {} } }), 'grok');
  assert.equal(quickVendor({ home: 'claude', ...more, settings: { quick: 'home', hold: {} } }), 'claude');
  // Nothing installed that could take one.
  const bare = computer(t, ['agy'], { own: true });
  assert.equal(quickVendor({ home: 'agy', env: bare.env }), null);
  assert.equal(quickVendor({ env: bare.env }), null);
});

test('a fast vendor that failed is passed over for a while', t => {
  const c = computer(t, ['claude', 'grok'], { own: true }), env = c.env, now = 1_800_000_000_000, minute = 60000;
  catalog(c.bin('claude')); grokReady(c);
  const quick = at => quickVendor({ home: 'claude', env, now: at });
  assert.equal(quick(now), 'grok');
  // Any failure, and a time limit: 15 minutes.
  assert.deepEqual(holdVendor('grok', 'unknown', { env, now }).hold, { grok: now + 15 * minute });
  assert.equal(vendorState('grok', { env, now }).held, true);
  assert.equal(quick(now), 'claude'); assert.equal(quick(now + 15 * minute - 1), 'claude'); assert.equal(quick(now + 15 * minute), 'grok');
  assert.deepEqual(holdVendor('grok', 'rate-limit', { env, now }).hold, { grok: now + 15 * minute });
  // A limit: an hour.
  assert.deepEqual(holdVendor('grok', 'quota', { env, now }).hold, { grok: now + 60 * minute });
  assert.equal(quick(now + 59 * minute), 'claude'); assert.equal(quick(now + 60 * minute), 'grok');
  // The session's own vendor can be passed over too: then a quick question goes nowhere.
  holdVendor('claude', 'unknown', { env, now });
  assert.equal(quick(now), null); assert.equal(quick(now + 15 * minute), 'claude');
  // A sign-in that failed: until that sign-in changes, however long, a day at most.
  const held = holdVendor('grok', 'auth', { env, now: now + 61 * minute });
  assert.equal(held.hold.grok, now + 61 * minute + 24 * 60 * minute); assert.equal(typeof held.holdSignIn.grok, 'string');
  assert.equal(quick(now + 5 * 60 * minute), 'claude');
  fs.writeFileSync(path.join(c.home, '.grok', 'auth.json'), '{"signed":"in again"}\n');
  assert.equal(vendorState('grok', { env, now: now + 5 * 60 * minute }).held, false);
  assert.equal(quick(now + 5 * 60 * minute), 'grok');
  // A later failure of another kind takes the sign-in's mark away.
  assert.equal(holdVendor('grok', 'unknown', { env, now: now + 5 * 60 * minute }).holdSignIn, undefined);
  // A name that is no vendor is not kept, and nothing here throws where the file cannot be written.
  assert.equal(holdVendor('other', 'unknown', { env, now }), null);
  fs.rmSync(autoSettingsFile(env)); fs.mkdirSync(autoSettingsFile(env));
  assert.equal(holdVendor('grok', 'unknown', { env, now }), null);
});

// ---- Routes ----

test('the routes of a session on Claude Code, and the line that says them', t => {
  const c = computer(t, ['claude', 'grok'], { own: true }), env = c.env, ctx = { home: 'claude', env, free: () => ({ free: true }) };
  catalog(c.bin('claude')); grokReady(c);
  assert.deepEqual(routeFor('plan', ctx), { step: 'plan', vendor: 'claude', model: 'fable', effort: 'xhigh' });
  assert.deepEqual(routeFor('edit', ctx), { step: 'edit', vendor: 'claude', model: 'opus', effort: 'xhigh' });
  assert.deepEqual(routeFor('quick', ctx), { step: 'quick', vendor: 'grok', model: null, name: 'Grok Build' });
  for (const none of ['stay', 'review', '', null, undefined]) assert.equal(routeFor(none, ctx), null);
  // The line of the design, word for word.
  assert.equal(routesLine(ctx), 'Plans: Fable 5.2 xhigh · Edits: Opus 5.5 xhigh · Quick questions: Grok Build');
  assert.equal(LINES.on(routesLine(ctx)), 'Auto model is on. Plans: Fable 5.2 xhigh · Edits: Opus 5.5 xhigh · Quick questions: Grok Build');
  // The effort is this computer's, for plans and edits alike; the quick run gets none.
  saveAutoSettings({ effort: 'high' }, { env });
  assert.equal(routeFor('plan', ctx).effort, 'high'); assert.equal(routeFor('edit', ctx).effort, 'high'); assert.equal('effort' in routeFor('quick', ctx), false);
  assert.equal(routesLine(ctx), 'Plans: Fable 5.2 high · Edits: Opus 5.5 high · Quick questions: Grok Build');
  // A working bot that does the session's work edits on its own model.
  assert.equal(routeFor('edit', { ...ctx, worker: 'builder' }), null);
  assert.deepEqual(routeFor('plan', { ...ctx, worker: 'builder' }), { step: 'plan', vendor: 'claude', model: 'fable', effort: 'high' });
  assert.equal(routesLine({ ...ctx, worker: 'builder' }), 'Plans: Fable 5.2 high · Edits: @builder · Quick questions: Grok Build');
  // With nowhere for a quick question to go, the line leaves that part out.
  saveAutoSettings({ quick: 'off' }, { env });
  assert.equal(routesLine(ctx), 'Plans: Fable 5.2 high · Edits: Opus 5.5 high');
});

test('the routes of a session on Codex', t => {
  const c = computer(t, ['codex'], { own: true }), ctx = { home: 'codex', env: c.env, codexModels: CODEX };
  assert.deepEqual(routeFor('plan', ctx), { step: 'plan', vendor: 'codex', model: 'gpt-6-astra', effort: 'xhigh' });
  assert.deepEqual(routeFor('edit', ctx), { step: 'edit', vendor: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' });
  assert.deepEqual(routeFor('quick', ctx), { step: 'quick', vendor: 'codex', model: 'gpt-6-luna', name: 'Gpt Luna 6' });
  assert.equal(routesLine(ctx), 'Plans: Gpt Astra 6 xhigh · Edits: gpt-6.1-sol xhigh · Quick questions: Gpt Luna 6');
  // Nothing reads a Codex model's own limit: it is always taken as free.
  assert.equal('instead' in routeFor('plan', ctx), false);
});

test('at a limit the other model takes the step, with one line a limit', t => {
  const c = computer(t, ['claude'], { own: true }), env = c.env, now = new Date(2026, 10, 17, 9, 0).getTime(), until = new Date(2026, 10, 19, 18, 0).getTime();
  catalog(c.bin('claude'));
  const held = at => model => model === at ? { free: false, until, why: 'model' } : { free: true };
  // The top model is at its own weekly limit: the work model answers.
  const plan = routeFor('plan', { home: 'claude', env, now, free: held('fable') });
  assert.deepEqual(plan, { step: 'plan', vendor: 'claude', model: 'opus', effort: 'xhigh', instead: { from: 'fable', why: 'limit', until } });
  assert.equal(insteadLine(plan, { env, now }), 'Fable 5.2 is at its limit until Thu 6:00 PM, so Opus 5.5 answers until then.');
  assert.equal(insteadLine(plan, { env, now }), LINES.limit({ from: 'Fable 5.2', to: 'Opus 5.5', until, now }));
  assert.equal(dayClock(until, now), 'Thu 6:00 PM');
  assert.equal(insteadKey(plan), 'limit:fable');
  // Its edits are untouched, and the line names what would run now.
  assert.deepEqual(routeFor('edit', { home: 'claude', env, now, free: held('fable') }), { step: 'edit', vendor: 'claude', model: 'opus', effort: 'xhigh' });
  assert.equal(routesLine({ home: 'claude', env, now, free: held('fable') }), 'Plans: Opus 5.5 xhigh · Edits: Opus 5.5 xhigh · Quick questions: Haiku 5.5');
  // The work model is at its limit and the top model is free: the top model edits.
  const edit = routeFor('edit', { home: 'claude', env, now, free: held('opus') });
  assert.deepEqual(edit, { step: 'edit', vendor: 'claude', model: 'fable', effort: 'xhigh', instead: { from: 'opus', why: 'limit', until } });
  assert.equal(insteadLine(edit, { env, now }), 'Opus 5.5 is at its limit until Thu 6:00 PM, so Fable 5.2 edits until then.');
  // Both at a limit (the account's own): nothing is swapped, and the turn says what it meets, as today.
  const both = () => ({ free: false, until, why: 'account' });
  assert.deepEqual(routeFor('plan', { home: 'claude', env, now, free: both }), { step: 'plan', vendor: 'claude', model: 'fable', effort: 'xhigh' });
  assert.deepEqual(routeFor('edit', { home: 'claude', env, now, free: both }), { step: 'edit', vendor: 'claude', model: 'opus', effort: 'xhigh' });
  assert.equal(insteadLine(routeFor('plan', { home: 'claude', env, now, free: both }), { env, now }), null);
  assert.equal(insteadKey(routeFor('plan', { home: 'claude', env, now, free: both })), null);
  // A limit with no time known, and one that ends today.
  const open = routeFor('plan', { home: 'claude', env, now, free: model => model === 'fable' ? { free: false, until: null } : { free: true } });
  assert.equal(open.instead.until, null);
  assert.equal(insteadLine(open, { env, now }), 'Fable 5.2 is at its limit, so Opus 5.5 answers for now.');
  assert.equal(LINES.limit({ from: 'Fable 5.2', to: 'Opus 5.5', until: new Date(2026, 10, 17, 18, 0).getTime(), now }), 'Fable 5.2 is at its limit until 6:00 PM, so Opus 5.5 answers until then.');
  // A reading that fails or says nothing is taken as free.
  assert.deepEqual(routeFor('plan', { home: 'claude', env, now, free: () => { throw new Error('unread'); } }), { step: 'plan', vendor: 'claude', model: 'fable', effort: 'xhigh' });
  assert.deepEqual(routeFor('plan', { home: 'claude', env, now, free: () => null }), { step: 'plan', vendor: 'claude', model: 'fable', effort: 'xhigh' });
});

test('a top model that is not on the plan: the work model answers in this session', t => {
  const c = computer(t, ['claude'], { own: true }), env = c.env, task = { id: '4', auto: true, autoNoTop: true };
  catalog(c.bin('claude'));
  const plan = routeFor('plan', { home: 'claude', env, task, free: () => ({ free: true }) });
  assert.deepEqual(plan, { step: 'plan', vendor: 'claude', model: 'opus', effort: 'xhigh', instead: { from: 'fable', why: 'plan', until: null } });
  assert.equal(insteadLine(plan, { env }), 'Fable 5.2 is not on your plan, so Opus 5.5 answers in this session.');
  assert.equal(insteadKey(plan), 'no-top');
  // The work model at its limit is never swapped for a top model the plan does not have.
  assert.deepEqual(routeFor('edit', { home: 'claude', env, task, free: model => model === 'opus' ? { free: false, until: null } : { free: true } }), { step: 'edit', vendor: 'claude', model: 'opus', effort: 'xhigh' });
  assert.equal(routesLine({ home: 'claude', env, task, free: () => ({ free: true }) }), 'Plans: Opus 5.5 xhigh · Edits: Opus 5.5 xhigh · Quick questions: Haiku 5.5');
});

test('with no reading given, a Claude model\'s limit is the one the app keeps for the account', t => {
  const c = computer(t, ['claude'], { own: true }), env = c.env, now = Date.now(), until = now + 3 * 60 * 60000;
  catalog(c.bin('claude'));
  t.after(() => changeSwitch(state => { delete state.spent; }));
  assert.deepEqual(routeFor('plan', { home: 'claude', env, now }), { step: 'plan', vendor: 'claude', model: 'fable', effort: 'xhigh' });
  // Anthropic refused a request for Fable on the one account here: its own week is over until then.
  markSpent('default', { window: 'model', until, model: 'fable' });
  const plan = routeFor('plan', { home: 'claude', env, now });
  assert.equal(plan.model, 'opus'); assert.deepEqual(plan.instead, { from: 'fable', why: 'limit', until: new Date(until).getTime() });
  assert.deepEqual(routeFor('edit', { home: 'claude', env, now }), { step: 'edit', vendor: 'claude', model: 'opus', effort: 'xhigh' });
  // Once the mark has passed, the top model plans again.
  assert.equal(routeFor('plan', { home: 'claude', env, now: until + 1 }).model, 'fable');
  // The account's own limit holds every model alike: no swap.
  markSpent('default', { window: 'weekly', until: until + 60000 });
  assert.deepEqual(routeFor('plan', { home: 'claude', env, now }), { step: 'plan', vendor: 'claude', model: 'fable', effort: 'xhigh' });
});

test('a line is said once a limit', () => {
  const task = { id: '4' }, now = 1_800_000_000_000, until = now + 5000;
  assert.equal(sayOnce(task, 'limit:fable', { until, now }), true);
  assert.deepEqual(task.autoSaid, { 'limit:fable': until });
  assert.equal(sayOnce(task, 'limit:fable', { until, now: now + 1 }), false);
  assert.equal(sayOnce(task, 'limit:opus', { until: until + 5000, now: now + 1 }), true);
  // Past its time the same limit may be met again, and what has passed is not kept.
  assert.equal(sayOnce(task, 'limit:fable', { until: until + 9000, now: until }), true);
  assert.deepEqual(task.autoSaid, { 'limit:opus': until + 5000, 'limit:fable': until + 9000 });
  // With no time given: a day.
  assert.equal(sayOnce(task, 'no-top', { now }), true);
  assert.equal(task.autoSaid['no-top'], now + 24 * 60 * 60000);
  assert.equal(sayOnce(task, 'no-top', { now: now + 23 * 60 * 60000 }), false);
  // A record with anything else there starts clean.
  const odd = { autoSaid: ['x'] };
  assert.equal(sayOnce(odd, 'no-top', { now }), true); assert.deepEqual(odd.autoSaid, { 'no-top': now + 24 * 60 * 60000 });
});

// ---- A session's own setting ----

test('Auto model is turned on and off for a session, also while a turn holds it', t => {
  const p = project(t), repo = repository(p.root), id = createConversation(repo, defaultConfig(), 'add a dark mode').id;
  assert.equal(autoOn(readTask(repo, id)), false);
  assert.equal('auto' in readTask(repo, id), false);
  assert.equal(autoOn(setSessionAuto(repo, id, true)), true);
  assert.equal(readTask(repo, id).auto, true);
  assert.equal(fs.existsSync(settingsFile(repo, id)), false);
  // Off takes the mark and Auto model's own effort away; the owner's effort was never touched.
  changeSettings(repo, id, task => { task.autoEffort = 'xhigh'; task.leadEffort = 'low'; });
  assert.equal(readTask(repo, id).autoEffort, 'xhigh');
  const off = setSessionAuto(repo, id, false);
  assert.equal('auto' in off, false); assert.equal('autoEffort' in off, false); assert.equal(off.leadEffort, 'low');
  const read = readTask(repo, id);
  assert.equal('auto' in read, false); assert.equal('autoEffort' in read, false); assert.equal(read.leadEffort, 'low');
  // Turned off once more: nothing to change.
  assert.equal(autoOn(setSessionAuto(repo, id, false)), false);
  // While a turn holds the record the change waits beside it, and every read lays it over.
  const turn = lock(repo, `task-${id}`);
  try {
    assert.equal(autoOn(setSessionAuto(repo, id, true)), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile(repo, id), 'utf8')), { auto: true });
    assert.equal(autoOn(readTask(repo, id)), true);
    assert.equal(autoOn(setSessionAuto(repo, id, false)), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile(repo, id), 'utf8')), { auto: null });
    assert.equal(autoOn(readTask(repo, id)), false);
  } finally { turn(); }
  assert.equal('auto' in readTask(repo, id), false);
  // The vendor, when the caller names it, must have a top and a work model.
  assert.throws(() => setSessionAuto(repo, id, true, { vendor: 'grok' }), { message: 'Auto model needs Claude Code or Codex for this session.' });
  assert.throws(() => setSessionAuto(repo, id, true, { vendor: 'codex', codexModels: [] }), { message: LINES.noClasses('codex') });
  assert.equal(autoOn(readTask(repo, id)), false);
  assert.equal(autoOn(setSessionAuto(repo, id, true, { vendor: 'codex', codexModels: CODEX })), true);
  assert.equal(autoOn(setSessionAuto(repo, id, true, { vendor: 'claude' })), true);
});

test('Auto model and its effort are settings: a turn that saves its own copy of the record does not undo them', t => {
  const p = project(t), repo = repository(p.root), id = createConversation(repo, defaultConfig(), 'add a dark mode').id;
  const turn = lock(repo, `task-${id}`);
  try {
    // The turn read the record before the owner turned Auto model on.
    const own = readTask(repo, id);
    setSessionAuto(repo, id, true); changeSettings(repo, id, task => { task.autoEffort = 'high'; });
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile(repo, id), 'utf8')), { auto: true, autoEffort: 'high' });
    // Its save takes both into the record and into its own copy.
    own.state = 'answered'; saveTask(repo, own);
    assert.equal(own.auto, true); assert.equal(own.autoEffort, 'high');
    assert.equal(fs.existsSync(settingsFile(repo, id)), false);
    // And the other way: turned off under a turn whose copy still has it on.
    setSessionAuto(repo, id, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile(repo, id), 'utf8')), { auto: null, autoEffort: null });
    saveTask(repo, own);
    assert.equal('auto' in own, false); assert.equal('autoEffort' in own, false);
  } finally { turn(); }
  const after = readTask(repo, id);
  assert.equal('auto' in after, false); assert.equal('autoEffort' in after, false); assert.equal(after.state, 'answered');
});

test('a session that cannot change model refuses Auto model with the sentences a model change gives', t => {
  const p = project(t), repo = repository(p.root);
  const asked = createConversation(repo, defaultConfig(), 'Answer the question from @sara', { origin: { kind: 'ask', peer: 'b'.repeat(64), name: 'sara', threadId: 'thread-1' } }).id;
  assert.throws(() => setSessionAuto(repo, asked, true), { message: LINES.keepsTeammate });
  assert.throws(() => setSessionModel(repo, asked, { vendor: 'claude', model: 'opus' }), { message: LINES.keepsTeammate });
  assert.equal(autoOn(readTask(repo, asked)), false);
  // Off is never refused: a session that somehow has the mark can always lose it.
  assert.equal(autoOn(setSessionAuto(repo, asked, false)), false);
  const source = fs.readFileSync(path.join(LIB, 'models.mjs'), 'utf8');
  assert.ok(source.includes(JSON.stringify(LINES.keepsTeammate)));
  assert.ok(source.includes(`'${LINES.keepsCommit}'`));
});

test('every way Auto model goes off forgets which conversation each model had', t => {
  const p = project(t), repo = repository(p.root), id = createConversation(repo, defaultConfig(), 'add a dark mode').id;
  // On, with the vendor session each model keeps while it is (lib/runner.mjs).
  const kept = () => {
    setSessionAuto(repo, id, true);
    const task = readTask(repo, id); task.autoSessions = { fable: { vendor: 'claude', id: 'S1' }, opus: { vendor: 'claude', id: 'S2' } }; saveTask(repo, task);
    assert.deepEqual(Object.keys(readTask(repo, id).autoSessions), ['fable', 'opus']);
  };
  const gone = what => { const task = readTask(repo, id); assert.equal(autoOn(task), false, what); assert.equal('autoSessions' in task, false, what); };
  kept(); assert.equal('autoSessions' in setSessionAuto(repo, id, false), false); gone('/model auto off');
  kept(); assert.equal(pickedOverAuto(repo, id, 'Opus 5.5'), true); gone('a model picked on his other computer');
  kept(); changeAgent(repo, id, { to: { vendor: 'claude', model: 'opus', effort: 'high' } }); gone('a model and an effort picked here');
  assert.equal(readTask(repo, id).leadEffort, 'high');
  // While a turn holds the session the change waits in settings.json, and the turn's own save
  // of the copy it holds lays it: what each model had goes then too (lib/state.mjs laySettings).
  kept();
  const held = readTask(repo, id), release = lock(repo, `task-${id}`);
  try { setSessionAuto(repo, id, false); assert.equal(fs.existsSync(settingsFile(repo, id)), true, 'the change waits for the turn'); saveTask(repo, held); }
  finally { release(); }
  gone('/model auto off while a turn works');
});

// ---- Usage ----

test('quick answers are a row of their own in Usage, named once here, on another computer and on a build before Auto model there', () => {
  const now = new Date(2026, 10, 12, 15, 0, 0).getTime(), at = new Date(now - 3600000).toISOString();
  const projects = [{ root: '/r', key: 'a'.repeat(16), tasks: [{ id: '3', title: 'Normalize coupon codes', goal: 'Normalize coupon codes', createdAt: at, runs: [{ role: 'lead', vendor: 'claude', at, costUsd: 0.5 }, { role: QUICK_ROLE, vendor: 'grok', at, costUsd: 0.01 }] }] }];
  const named = line => line.split(LINES.usageRow).length - 1;
  const here = agentSpend(projects, { now }).rows;
  assert.deepEqual(here.map(row => [row.agent, row.title]), [['Claude', 'Normalize coupon codes'], ['Quick answers', 'Normalize coupon codes']]);
  const local = agentTable(here, { width: 120, total: 0.51 }).rows;
  assert.deepEqual(local.map(named), [0, 1]); assert.match(local[1], /^Quick answers · Normalize coupon codes +Grok Build /);
  // Over the wire the label goes in the title.
  const sent = JSON.parse(JSON.stringify(topAgentsWire(projects, now)));
  assert.deepEqual(sent.today.rows.map(row => [row.agent, row.title]), [['Claude', 'Normalize coupon codes'], ['Quick answers', 'Quick answers · Normalize coupon codes']]);
  const there = cleanTopAgents(sent).today.rows.map(row => ({ ...row, where: 'laptop' }));
  const shown = agentTable(there, { width: 120, total: 0.51 }).rows;
  assert.deepEqual(shown.map(named), [0, 1]); assert.match(shown[1], /^Quick answers · Normalize coupon codes +laptop +Grok Build /);
  // A build before Auto model labels only an @name, and shows a row by any other name by its
  // title alone, as this one shows a model's own row.
  assert.deepEqual(agentTable(there.map(row => ({ ...row, agent: 'Grok Build' })), { width: 120, total: 0.51 }).rows.map(named), [0, 1]);
  // A row with no title is still named once, both ways.
  const bare = [{ ...projects[0], tasks: [{ ...projects[0].tasks[0], title: '', goal: '' }] }];
  const wired = cleanTopAgents(JSON.parse(JSON.stringify(topAgentsWire(bare, now)))).today.rows.find(row => row.agent === LINES.usageRow);
  assert.equal(named(agentTable([wired], { width: 120 }).rows[0]), 1);
  assert.equal(named(agentTable(agentSpend(bare, { now }).rows.filter(row => row.agent === LINES.usageRow), { width: 120 }).rows[0]), 1);
});

// ---- What is typed and what is shown ----

test('what follows /model auto', () => {
  for (const nothing of ['', '   ', null, undefined, 'on', ' On ']) assert.deepEqual(autoWords(nothing), { kind: 'on' }, String(nothing));
  // off alone turns it off, and is never sent as a message.
  for (const off of ['off', ' OFF ']) assert.deepEqual(autoWords(off), { kind: 'off' }, off);
  for (const effort of EFFORTS) assert.deepEqual(autoWords(effort), { kind: 'effort', effort });
  assert.deepEqual(autoWords(' HIGH '), { kind: 'effort', effort: 'high' });
  for (const quick of [...VENDORS, 'home', 'off']) assert.deepEqual(autoWords(`quick ${quick}`), { kind: 'quick', quick });
  assert.deepEqual(autoWords('Quick  GROK'), { kind: 'quick', quick: 'grok' });
  // Anything else is a message, sent with Auto model on, as it was typed.
  for (const text of ['add a dark mode', 'high priority: fix the login', 'quick', 'quick fix for the login', 'quick grok please', 'medium rare', 'ultra fast please', 'off the record fix it', 'on second thought, fix it', 'off off']) assert.deepEqual(autoWords(text), { kind: 'message', text });
  assert.deepEqual(autoWords('  Add a  dark mode '), { kind: 'message', text: 'Add a  dark mode' });
});

test('the sentences, as the design writes them', () => {
  assert.equal(AUTO_NAME, 'Auto model'); assert.equal(AUTO_WORD, 'auto');
  for (const word of ['auto', 'Auto', ' AUTO ']) assert.equal(isAutoWord(word), true, word);
  for (const word of ['automatic', 'claude:auto', 'auto model', '', null]) assert.equal(isAutoWord(word), false, String(word));
  assert.equal(LINES.listNote, 'ELU picks the model for each step');
  assert.equal(LINES.on(''), 'Auto model is on.');
  assert.equal(LINES.box(LABELS.auto), 'Message Auto model · Approve for me');
  assert.equal(LINES.quickFrom('Grok Build'), 'Grok Build · quick answer');
  assert.equal(LINES.handUp('Fable 5.2'), 'Fable 5.2 answers this one: it needs more than a quick answer.');
  assert.equal(LINES.picked('Opus 5.5'), 'Model of this session: Opus 5.5. Auto model is off.');
  assert.equal(LINES.offAfter('Effort of Opus 5.5: low → high'), 'Effort of Opus 5.5: low → high. Auto model is off.');
  assert.equal(LINES.offAfter('Effort of Opus 5.5: low → high. It applies from the next turn.'), 'Effort of Opus 5.5: low → high. It applies from the next turn. Auto model is off.');
  assert.equal(LINES.needsHome, 'Auto model needs Claude Code or Codex for this session.');
  assert.equal(LINES.otherComputer, 'Auto model is set on the computer that runs the session.');
  assert.equal(LINES.defaultHint, 'Auto model is set for this computer: /model computer auto.');
  assert.equal(LINES.usageRow, 'Quick answers');
  assert.equal(LINES.quickSet('grok'), 'Quick questions go to Grok Build on this computer.');
  assert.equal(LINES.quickSet('home'), "Quick questions go to the session's own vendor on this computer.");
  assert.equal(LINES.quickSet('off'), 'Quick questions are off on this computer.');
  assert.equal(LINES.effortSet('high'), 'Auto model plans and edits at high on this computer.');
  assert.equal(LINES.needsHomeHere, 'Auto model needs Claude Code or Codex on this computer.');
  assert.equal(LINES.quickCut, 'The quick answer was cut off. Send your question again.');
  // The vendor he set is not ready: the one that answers meanwhile (quickVendor), or none.
  assert.equal(LINES.quickWaits('grok', 'claude'), 'Grok Build is not ready for quick questions on this computer yet. Until it is, Claude Code answers them.');
  for (const none of [undefined, null]) assert.equal(LINES.quickWaits('grok', none), 'Grok Build is not ready for quick questions on this computer yet. Until it is, no quick answer is given.');
  // The feature is named in full wherever it is named, and no sentence is left open.
  const said = Object.values(LINES).map(line => typeof line === 'function' ? line(line === LINES.limit || line === LINES.noTop ? { from: 'Fable 5.2', to: 'Opus 5.5' } : 'grok') : line);
  for (const line of said) {
    assert.equal(typeof line, 'string');
    assert.doesNotMatch(line, /\bAuto\b(?! model)/, line);
    assert.doesNotMatch(line, /undefined|\[object/, line);
  }
  assert.ok(Object.isFrozen(LINES));
});

// ---- Loading ----

// lib/auto-model.mjs imports files that, once the feature is wired in, import it back. Whichever
// of them a program loads first, everything must load, and what this file exports must be set.
test('every file on the way loads first without leaving a name unset', async () => {
  const first = ['auto-model', 'models', 'bot-models', 'conformance', 'claude-accounts', 'elu-sent', 'state', 'terminal-commands', 'runner', 'projects', 'conductor'];
  const url = name => pathToFileURL(path.join(LIB, `${name}.mjs`)).href;
  const code = name => `await import(${JSON.stringify(url(name))}); const auto = await import(${JSON.stringify(url('auto-model'))}); if (auto.AUTO_NAME !== 'Auto model' || typeof auto.LINES.off !== 'string' || auto.stepOf('thanks', {}) !== 'stay' || auto.classNames('grok').top !== null) throw new Error('unset');`;
  const run = name => new Promise(resolve => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code(name)], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let said = ''; child.stderr.on('data', part => { said += part; });
    child.on('close', status => resolve({ name, status, said: said.trim().split('\n').slice(0, 6).join('\n') }));
  });
  for (const result of await Promise.all(first.map(run))) assert.equal(result.status, 0, `${result.name} first: ${result.said}`);
});
