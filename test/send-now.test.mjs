import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, autoApprove } from './helpers.mjs';
import { ProjectController, conversationEntries, registerProject } from '../lib/projects.mjs';
import { projectFolder, pendingRequests, takeTyped, putBack, saveRequest } from '../lib/workspace.mjs';
import { readTask, saveTask, taskDir } from '../lib/state.mjs';
import { Conductor, enqueue, sendCommand } from '../lib/conductor.mjs';
import * as claude from '../lib/adapters/claude.mjs';
import { DURING_LEAD } from '../lib/runner.mjs';

// What the owner sends while a turn works. Claude Code takes it in that turn: its input stays
// open, and the message goes on it at once. The other vendors read their prompt to the end
// before they work, so the message waits for the turn to end, and the owner can send it now:
// the turn stops, and the message starts the next one in the same vendor session.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const isRun = row => row.vendor === 'claude' ? row.args.includes('-p') : row.args[0] === 'exec';
function setup(t, options = {}) {
  const p = project(t), fake = fakeClis(p.parent, options);
  environment(t, { ...fake.env, HOME: p.parent, GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = autoApprove(new ProjectController(projectFolder(p.root))); registerProject(controller.repo);
  const calls = vendor => rows(fake.calls).filter(row => row.vendor === vendor && isRun(row));
  const absorbed = () => rows(path.join(fake.dir, 'absorbed.jsonl'));
  const conductor = new Conductor({ tickMs: 20 }).start(); t.after(() => conductor.stop());
  return { ...p, fake, controller, repo: controller.repo, calls, absorbed, conductor };
}
async function until(check, message, timeout = 20000) {
  const started = Date.now();
  while (!check()) { if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const only = (f) => readTask(f.repo, '1');
const sessionOf = f => { try { return only(f); } catch { return null; } };

test('a message sent while Claude Code works goes to that turn at once, and the chat keeps it once, in order', { timeout: 60000 }, async t => {
  const f = setup(t, { mode: 'listen', steps: 15, stepMs: 200 });
  enqueue(f.root, 'Tidy the coupon module', { priority: 0 });
  await until(() => sessionOf(f)?.state === 'running' && sessionOf(f).activeInbox === true, 'the turn works and takes messages');
  enqueue(f.root, 'Also keep the old name', { continuationTaskId: '1', priority: 0 });
  enqueue(f.root, 'And say which file changed', { continuationTaskId: '1', priority: 0 });
  // Both go to the running turn, in the order sent: none waits for it to end.
  await until(() => (only(f).messages ?? []).filter(row => row.during).length === 2, 'both went to the turn');
  assert.equal(only(f).state, 'running', 'while it still works');
  assert.deepEqual(pendingRequests(f.root).filter(row => row.state === 'queued'), [], 'nothing waits');
  assert.deepEqual(pendingRequests(f.root).filter(row => row.reason === 'Sent to the running turn.').map(row => row.goal), ['Also keep the old name', 'And say which file changed']);
  await until(() => only(f).state !== 'running', 'the turn ends');
  const task = only(f);
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  // One run: the messages were taken in by it, at its steps, and no second turn started.
  assert.equal(f.calls('claude').length, 1);
  const args = f.calls('claude')[0].args;
  assert.equal(args[args.indexOf('--input-format') + 1], 'stream-json', 'its input is stream-json');
  assert.ok(args.includes('--restricted') && args[args.indexOf('--permission-mode') + 1] === 'dontAsk', 'in Read only, as before');
  assert.deepEqual(f.absorbed().map(row => row.mid), [true, true]);
  assert.ok(f.absorbed()[0].content.startsWith(DURING_LEAD), 'the turn is told what the message is');
  assert.ok(f.absorbed()[0].content.includes('"text":"Also keep the old name"'));
  // In the chat each shows once, where it was sent, and the one reply answers all of it.
  assert.deepEqual(task.messages.map(row => [row.text, row.during === true]), [['Tidy the coupon module', false], ['Also keep the old name', true], ['And say which file changed', true]]);
  const entries = conversationEntries(f.repo, task);
  assert.deepEqual(entries.map(row => [row.role, row.during === true]), [['You', false], ['You', true], ['You', true], [entries.at(-1).role, false]]);
  assert.equal(entries.at(-1).lead, true);
  assert.match(entries.at(-1).text, /Also took in what you sent while it worked: Also keep the old name \| And say which file changed$/);
  assert.equal(task.activeInbox, undefined, 'no turn takes messages now');
  // The next turn reads them as the owner's messages.
  enqueue(f.root, 'Thanks', { continuationTaskId: '1', priority: 0 });
  await until(() => f.calls('claude').length === 2 && only(f).state === 'answered', 'the next turn');
  const prompt = rows(path.join(f.parent, 'inputs.jsonl')).filter(row => row.vendor === 'claude' && row.args.includes('-p')).at(-1).input;
  assert.ok(prompt.includes('Also keep the old name') && prompt.includes('And say which file changed'));
});

test('a message to someone else waits, and so does each message behind it', t => {
  const p = project(t); environment(t, { XDG_CONFIG_HOME: path.join(p.parent, 'personal') });
  const at = n => new Date(Date.UTC(2026, 10, 13, 10, 0, n)).toISOString();
  const base = { state: 'queued', priority: 0, continuationTaskId: '4', taskId: null, attempts: 0, notBefore: null, reason: 'Waiting to start.' };
  saveRequest(p.root, 'First', 'r1', { ...base, queuedAt: at(1) });
  saveRequest(p.root, 'To the bot', 'r2', { ...base, queuedAt: at(2), bot: 'sec' });
  saveRequest(p.root, 'Third', 'r3', { ...base, queuedAt: at(3) });
  saveRequest(p.root, 'With a new mode', 'r4', { ...base, continuationTaskId: '5', queuedAt: at(4), permissions: 'full' });
  assert.deepEqual(takeTyped(p.root, '4').map(row => row.goal), ['First']);
  assert.deepEqual(takeTyped(p.root, '4').map(row => row.goal), [], 'the bot\'s message stops the rest');
  assert.deepEqual(takeTyped(p.root, '5'), [], 'a message that changes the session\'s choices starts a turn of its own');
  const taken = takeTyped(p.root, '4', 'sec');
  assert.deepEqual(taken.map(row => row.goal), ['To the bot']);
  putBack(p.root, taken);
  const find = goal => pendingRequests(p.root).find(row => row.goal === goal);
  assert.equal(find('To the bot').state, 'queued', 'one that could not go waits again');
  assert.deepEqual([find('First').state, find('First').reason], ['done', 'Sent to the running turn.']);
  assert.equal(find('Third').state, 'queued');
});

test('a run that took a message after its last step replied twice, and the chat shows both replies', t => {
  const f = { ...project(t) }; environment(t, { XDG_CONFIG_HOME: path.join(f.parent, 'personal') });
  const controller = new ProjectController(projectFolder(f.root)), repo = controller.repo;
  const result = summary => JSON.stringify({ type: 'result', is_error: false, session_id: 's', total_cost_usd: 0.1, structured_output: { outcome: 'done', intent: 'answer', summary, question: null, choices: [], comments: [], responses: [] } });
  const log = [JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'claude-opus-5-5' }), result('Tidied it.'), result('Kept the old name too.')].join('\n');
  assert.deepEqual(claude.replies(log), ['Tidied it.', 'Kept the old name too.']);
  assert.equal(claude.parse(log, { validate: value => value }).result.summary, 'Kept the old name too.', 'the run\'s result is its last');
  const now = Date.now(), at = n => new Date(now + n).toISOString();
  const task = { id: '3', kind: 'conversation', worktree: repo.root, base: null, branch: null, goal: 'Tidy it', state: 'answered', createdAt: at(0), runs: [], sessions: {}, messages: [{ at: at(0), text: 'Tidy it' }, { at: at(10), text: 'Keep the old name', during: true }] };
  fs.mkdirSync(taskDir(repo, '3'), { recursive: true });
  const file = path.join(taskDir(repo, '3'), 'lead-s.log'); fs.writeFileSync(file, `${log}\n`);
  task.runs.push({ role: 'lead', vendor: 'claude', logFile: file, code: 0, session: 's', at: at(20) });
  saveTask(repo, task);
  const entries = conversationEntries(repo, readTask(repo, '3'));
  assert.deepEqual(entries.map(row => [row.lead === true, row.text, row.during === true]), [[false, 'Tidy it', false], [false, 'Keep the old name', true], [true, 'Tidied it.', false], [true, 'Kept the old name too.', false]]);
});

test('a waiting message for Codex is sent now: the turn stops and the message starts the next one in the same thread', { timeout: 60000 }, async t => {
  const f = setup(t, { mode: 'slow' });
  f.controller.setDefaultModel({ vendor: 'codex' });
  // In Full access, where a Codex turn goes on in its thread (Read only starts a new one each turn).
  enqueue(f.root, 'Tidy the coupon module', { priority: 0, permissions: 'full' });
  await until(() => sessionOf(f)?.state === 'running' && f.calls('codex').length === 1, 'Codex works');
  enqueue(f.root, 'Also keep the old name', { continuationTaskId: '1', priority: 0 });
  enqueue(f.root, 'And say which file changed', { continuationTaskId: '1', priority: 0 });
  // Codex reads its prompt to the end before it works, so they wait for the turn.
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.deepEqual(pendingRequests(f.root).filter(row => row.state === 'queued').map(row => row.goal), ['Also keep the old name', 'And say which file changed']);
  assert.equal(only(f).activeInbox, undefined);
  assert.equal(only(f).state, 'running');
  // Send now: the stop /stop sends. The waiting messages start the next turn at once, joined.
  sendCommand({ type: 'stop', root: f.root, taskId: '1' });
  await until(() => f.calls('codex').length === 2 && only(f).state === 'answered', 'the next turn ran');
  const [first, next] = f.calls('codex');
  assert.notEqual(first.args[1], 'resume');
  assert.deepEqual(next.args.slice(0, 3), ['exec', 'resume', '12345678-1234-4234-8234-123456789abc'], 'it went on in the thread that was stopped');
  const task = only(f);
  assert.deepEqual(task.messages.map(row => row.text), ['Tidy the coupon module', 'Also keep the old name\n\nAnd say which file changed']);
  assert.equal(task.interrupted, undefined, 'the stopped turn was picked up');
  assert.deepEqual(pendingRequests(f.root).filter(row => row.state === 'queued'), []);
});
