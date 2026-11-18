import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { project, fakeClis, autoApprove } from './helpers.mjs';
import { ProjectController, archivedRecord, registerProject } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { readTask, saveTask, taskDir } from '../lib/state.mjs';
import { requestApproval } from '../lib/approvals.mjs';
import { standupPlan } from '../lib/standup-round.mjs';

// What the bot that oversees the sessions holds stays on this computer (docs/orchestrator.md).
// Three things here leave it: a Standup session, followed from the owner's other computers;
// the project's Memory, which goes to them and to his teammates; and the lessons of archived
// sessions, which are saved to that Memory. None of them takes what that bot said or asked.

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function setup(t, options = {}) {
  const p = project(t), fake = fakeClis(p.parent, { mode: 'answer', ...options }); environment(t, { ...fake.env, HOME: p.parent });
  const controller = new ProjectController(projectFolder(p.root)); controller.draftConfig.checks = [];
  registerProject(controller.repo);
  const runs = () => { const file = path.join(p.parent, 'inputs.jsonl'); return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(row => row.vendor === 'claude' && row.args.includes('-p')) : []; };
  return { ...p, fake, controller, repo: controller.repo, runs };
}
// The stand-in Claude Code, with the --agents flag the real one has: the bot's helpers need it.
function withAgents(dir) {
  const file = path.join(dir, 'claude'), text = fs.readFileSync(file, 'utf8'), from = "console.log('--print ";
  assert.ok(text.includes(from), 'the stand-in lists its flags'); fs.writeFileSync(file, text.replace(from, "console.log('--agents --print "));
}
const offered = row => Boolean(JSON.parse(row.args[row.args.indexOf('--json-schema') + 1]).properties.learned);
const contextFile = root => path.join(root, '.elu-code', 'context.md');
const SECRET = 'Across your projects: secret-plans #4 waits on the billing fix.';
const none = { computers: () => [], teammates: () => [] };

test("a round's record of a session holds nothing the bot that oversees the sessions said or asked there, and its turns alone make no session one to ask", async t => {
  const f = setup(t), now = Date.now(), at = ms => new Date(now + ms).toISOString(), old = new Date(now - 20 * 86400000).toISOString();
  const one = await f.controller.ask('Explain coupons').finished, two = await f.controller.ask('Old work').finished;
  // The bot replied in the first session after its own agent did, and asks the owner something there.
  const log = path.join(taskDir(f.repo, one.id), 'run-orchestrator.jsonl');
  fs.writeFileSync(log, `${JSON.stringify({ type: 'result', result: JSON.stringify({ summary: SECRET }) })}\n`);
  const first = readTask(f.repo, one.id), said = first.messages.length;
  saveTask(f.repo, { ...first, runs: [...first.runs, { role: 'bot:orchestrator', logFile: log, at: at(1000), vendor: 'claude' }],
    messages: [...first.messages, { at: at(500), text: 'How are my sessions?', to: '@orchestrator' }, { at: at(1000), from: '@orchestrator', bot: 'orchestrator', text: SECRET }] });
  requestApproval({ id: 'approval-orchestrator', root: f.root, taskId: one.id, role: 'bot:orchestrator', vendor: 'claude', tool: 'mcp__elu__session_message', input: { text: SECRET } });
  requestApproval({ id: 'approval-marked', root: f.root, taskId: one.id, role: 'lead', vendor: 'claude', tool: 'mcp__elu__session_start', input: { goal: SECRET }, oversee: true });
  // The second session has been quiet for weeks: only that bot wrote in it since.
  const second = readTask(f.repo, two.id);
  saveTask(f.repo, { ...second, createdAt: old, runs: second.runs.map(run => ({ ...run, at: old })), messages: [...second.messages.map(row => ({ ...row, at: old })), { at: at(1000), from: '@orchestrator', bot: 'orchestrator', overseer: true, text: SECRET }] });
  const plan = await standupPlan({ root: f.root, id: '999' }, { sources: none });
  assert.deepEqual(plan.asked.map(row => row.task.id), [one.id], 'the quiet session is not asked');
  const row = plan.asked[0];
  assert.equal(row.waits, null, 'what that bot asks is no wait of the session');
  assert.equal(JSON.stringify([row.last, row.record, row.waits]).includes('secret-plans'), false, JSON.stringify(row.record));
  assert.equal(readTask(f.repo, one.id).messages.length, said + 2, 'the session keeps its messages');
});

test("a turn of the bot that oversees the sessions teaches the project's Memory nothing, with its tools or without", async t => {
  const f = setup(t, { learned: { add: ['The secret-plans project ships on Friday.'], remove: [] } }); withAgents(f.fake.dir); autoApprove(f.controller);
  // With its tools, in a session with permissions.
  const tools = await f.controller.ask('We ship secret-plans on Friday.', null, { bot: 'orchestrator', permissions: 'auto' }).finished;
  assert.equal(tools.state, 'answered', JSON.stringify(tools.error)); assert.deepEqual(tools.runs.map(run => run.role), ['bot:orchestrator']);
  // Without them, in a Read only session.
  const plain = await f.controller.ask('We ship secret-plans on Friday.', null, { bot: 'orchestrator' }).finished;
  assert.equal(plain.state, 'answered', JSON.stringify(plain.error));
  assert.equal(f.runs().length, 2); assert.deepEqual(f.runs().map(offered), [false, false], 'neither run is offered the learned part');
  assert.equal(fs.existsSync(contextFile(f.root)), false, 'nothing is saved to Memory');
  assert.equal([...tools.messages, ...plain.messages].some(row => row.learned), false);
  // The session's own model, written to by the owner, still saves what he taught.
  const lead = await f.controller.ask('We ship on Fridays.', plain.id).finished;
  assert.equal(lead.state, 'answered', JSON.stringify(lead.error)); assert.equal(offered(f.runs().at(-1)), true);
  assert.match(fs.readFileSync(contextFile(f.root), 'utf8'), /: The secret-plans project ships on Friday\.\n$/);
});

test("the lessons of archived sessions take nothing from that bot's chat, nor from what it replied in another session", async t => {
  const f = setup(t);
  const one = await f.controller.ask('Explain coupons').finished;
  const first = readTask(f.repo, one.id), now = Date.now(), at = ms => new Date(now + ms).toISOString();
  saveTask(f.repo, { ...first, messages: [...first.messages, { at: at(500), text: 'How are my sessions?', to: '@orchestrator' }, { at: at(1000), from: '@orchestrator', bot: 'orchestrator', text: SECRET }, { at: at(1500), from: '@reviewer', bot: 'reviewer', text: 'The coupon code reads fine.' }] });
  const record = archivedRecord(f.repo, readTask(f.repo, one.id));
  assert.equal(JSON.stringify(record).includes('secret-plans'), false, JSON.stringify(record.messages));
  assert.ok(record.messages.some(row => row.from === 'owner' && row.text === 'How are my sessions?'), "the owner's own words are his");
  assert.ok(record.messages.some(row => row.from === '@reviewer (bot)'), 'another bot is read as before');
  // Its chat: no message at all, the owner's words to it included.
  const chat = readTask(f.repo, one.id);
  saveTask(f.repo, { ...chat, botChat: 'orchestrator' });
  assert.deepEqual(archivedRecord(f.repo, readTask(f.repo, one.id)).messages, []);
});
