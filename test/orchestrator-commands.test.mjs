import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { keyLike, temp } from './helpers.mjs';
import { makeTeam, withHome } from './peer-helpers.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { registerProject } from '../lib/projects.mjs';
import { readSettings } from '../lib/orchestrator-settings.mjs';
import { mandateFor, mandates, saveMandate } from '../lib/orchestrator-mandates.mjs';
import { isMyComputer, markMyComputer } from '../lib/peer/my-computers.mjs';
import { projectKey } from '../lib/peer/remote.mjs';
import { computersCommand, orchestratorCommand } from '../lib/orchestrator-commands.mjs';

// The owner's commands for the Orchestrator at Full (lib/orchestrator-commands.mjs): its level,
// Full among them, his mandates, and which computers are his. Made-up sessions of a plain folder
// and two made-up computers on a team; no model is asked, no turn runs and no daemon is started.
// ELU's own folder is a new empty one in every test.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
function world(t) {
  const parent = temp(t);
  environment(t, { XDG_CONFIG_HOME: path.join(parent, 'personal'), HOME: parent });
  const root = path.join(parent, 'web'); fs.mkdirSync(root);
  const repo = projectFolder(root); registerProject(repo);
  const session = (id, extra = {}) => {
    saveTask(repo, { id: String(id), kind: 'conversation', base: null, branch: null, worktree: repo.root, goal: `Goal of session ${id}`, state: 'answered', createdAt: new Date().toISOString(), runs: [], messages: [], reviews: [], responses: [], sessions: {}, permissions: 'auto', ...extra });
    return readTask(repo, String(id));
  };
  return { parent, root, repo, session, key: projectKey(repo.root) };
}
// The settings module with Full among its levels, as the Full level's own stream makes it:
// what was set, and with what.
function withFull() {
  const set = [], state = { level: 'suggest' };
  return { set, LEVELS: ['watch', 'suggest', 'act', 'run', 'full'], readSettings: () => ({ ...state }),
    setLevel: (level, how) => { set.push([level, how]); state.level = level; return { ...state }; }, levelLines: now => [`Level: ${now.level}.`] };
}

test('/orchestrator: a level word sets the level, Full is the owner\'s own typing of it, and the bot\'s chats get Full access with it', async t => {
  const w = world(t);
  w.session(1, { botChat: 'orchestrator' }); w.session(2);
  const act = await orchestratorCommand(['Act']);
  assert.match(act.line, /^Level: Act\. /);
  assert.equal(readSettings().level, 'act');
  // Settings that do not know Full yet say so, and set nothing.
  await assert.rejects(orchestratorCommand(['full'], { settings: { ...withFull(), LEVELS: ['watch', 'suggest', 'act', 'run'] } }), /no Full level yet/);
  assert.equal(readSettings().level, 'act');
  const settings = withFull();
  const full = await orchestratorCommand(['full'], { settings });
  assert.deepEqual(settings.set, [['full', { by: 'owner' }]]);
  assert.equal(full.line, 'Level: full.');
  assert.equal(full.chats, 1);
  assert.equal(readTask(w.repo, '1').permissions, 'full', "the bot's own chat");
  assert.equal(readTask(w.repo, '2').permissions, 'auto', 'no other session');
  assert.equal((await orchestratorCommand(['full'], { settings })).chats, 0, 'once is enough');
  // Below Full nothing changes in the chats.
  assert.equal((await orchestratorCommand(['run'], { settings })).chats, 0);
  await assert.rejects(orchestratorCommand(['loud']), /Use \/orchestrator/);
  await assert.rejects(orchestratorCommand(['undo']), /undo ID/);
  await assert.rejects(orchestratorCommand(['undo', 'a1']), /No logged action/);
});

test('/orchestrator alone is a page: the level, the caps, the mandates and the commands', async t => {
  const w = world(t);
  const empty = await orchestratorCommand([]);
  assert.equal(empty.title, 'Orchestrator');
  assert.match(empty.text, /^Level: Suggest\./);
  assert.match(empty.text, /No mandates: its messages to your sessions are notes\./);
  assert.match(empty.text, /\/orchestrator watch, suggest, act, run or full sets the level\./, 'Full is one of the levels now');
  saveMandate({ name: 'Workflows', goal: 'Workflows', decisions: ['Helpers may run on credits'], sessions: [{ computer: null, project: w.key, session: '4' }] }, { by: 'owner' });
  const page = await orchestratorCommand([], { settings: withFull() });
  assert.match(page.text, /Mandates\n {2}m1 · Workflows · 1 decision · 4 in web/);
  assert.match(page.text, /watch, suggest, act, run or full sets the level/);
});

test('/orchestrator mandate: the owner makes one with a goal and decisions, changes its decisions, and the list and one mandate read back', async t => {
  world(t);
  const settings = withFull();
  const made = await orchestratorCommand(['mandate', 'Workflows:', 'Codex', 'helpers', 'may', 'spend', 'credits;', 'merge', 'your', 'own', 'PRs'], { text: 'mandate Workflows: Codex helpers may spend credits; merge your own PRs', settings });
  assert.equal(made.line, 'Mandate m1 Workflows: 2 decisions. Sessions started under it join it, and /orchestrator mandate m1 add N adds one. It gives your word at Full only: /orchestrator full.');
  assert.deepEqual(mandates()[0].decisions, ['Codex helpers may spend credits', 'merge your own PRs']);
  // Without text the words are joined.
  const again = await orchestratorCommand(['mandate', 'workflows:', 'Helpers', 'may', 'run', 'on', 'credits'], { settings });
  assert.equal(again.line, 'Mandate m1 Workflows has 1 decision now. It gives your word at Full only: /orchestrator full.');
  assert.equal(mandates().length, 1, 'the same name is the same mandate');
  settings.setLevel('full');
  assert.equal((await orchestratorCommand(['mandate'], { text: 'mandate m1: A; B; C', settings })).line, 'Mandate m1 Workflows has 3 decisions now.');
  const long = 'Ship the workflows tab with the agent and Gmail nodes working end to end on the devbox';
  const second = await orchestratorCommand([], { text: `mandate ${long}: Merge when the checks pass`, settings });
  assert.match(second.line, /^Mandate m2 Ship the workflows tab with the agent and Gmail nodes working end to end on…: 1 decision\./);
  assert.equal(mandates()[1].goal, long);
  const list = await orchestratorCommand(['mandates']);
  assert.equal(list.title, 'Mandates');
  assert.match(list.text, /^m1 · Workflows · 3 decisions · 0 sessions\n {2}- A\n {2}- B\n {2}- C\n\nm2 · /);
  assert.match(list.text, new RegExp(`  Goal: ${long}`));
  const one = await orchestratorCommand(['mandate', 'm2']);
  assert.equal(one.title, 'Mandate m2');
  await assert.rejects(orchestratorCommand(['mandate', 'Nothing']), /No mandate is named Nothing/);
  await assert.rejects(orchestratorCommand([], { text: 'mandate m9: A' }), /No mandate has the id m9/);
  await assert.rejects(orchestratorCommand([], { text: 'mandate : A' }), /Use \/orchestrator mandate/);
  await assert.rejects(orchestratorCommand([], { text: `mandate Keys: use ${keyLike('ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4')}` }), /may hold a secret/);
  await assert.rejects(orchestratorCommand([], { text: `mandate Long: ${'x'.repeat(501)}` }), /each decision to 500/);
  await assert.rejects(orchestratorCommand([], { text: `mandate Many: ${Array.from({ length: 41 }, (_, i) => `d${i}`).join('; ')}` }), /up to 40 decisions/);
  assert.equal(mandates().length, 2, 'nothing refused was saved');
});

test('/orchestrator mandate add and drop: a session here by its number or the open one joins it, one at a time, and never a teammate\'s', async t => {
  const w = world(t);
  w.session(4); w.session(5); w.session(6, { origin: { kind: 'ask', peer: 'f'.repeat(64), name: 'sara' } });
  await orchestratorCommand([], { text: 'mandate Workflows: A' });
  await orchestratorCommand([], { text: 'mandate Billing: B' });
  const ref = id => ({ computer: null, project: w.key, session: id });
  assert.equal((await orchestratorCommand(['mandate', 'Workflows', 'add', '4'], { root: w.root })).line, 'Session 4 joined mandate m1 Workflows.');
  assert.equal(mandateFor(ref('4'))?.id, 'm1');
  assert.equal((await orchestratorCommand(['mandate', 'Workflows', 'add', '4'], { root: w.root })).line, 'Session 4 is in mandate m1 Workflows already.');
  // The open session, and a move: a session is in one mandate at a time.
  assert.equal((await orchestratorCommand(['mandate', 'billing', 'add'], { open: { root: w.root, id: '4' } })).line, 'Session 4 joined mandate m2 Billing, and left m1 Workflows.');
  assert.equal(mandateFor(ref('4'))?.id, 'm2');
  assert.deepEqual(mandates().find(m => m.id === 'm1').sessions, []);
  assert.equal((await orchestratorCommand(['mandate', 'm2', 'drop', '4'], { root: w.root })).line, 'Session 4 left mandate m2 Billing.');
  assert.equal(mandateFor(ref('4')), null);
  assert.equal((await orchestratorCommand(['mandate', 'm2', 'drop', '4'], { root: w.root })).line, 'Session 4 is not in mandate m2 Billing.');
  await assert.rejects(orchestratorCommand(['mandate', 'm1', 'add', '6'], { root: w.root }), /teammate's message started is never in a mandate/);
  await assert.rejects(orchestratorCommand(['mandate', 'm1', 'add', '9'], { root: w.root }), /No session 9/);
  await assert.rejects(orchestratorCommand(['mandate', 'm1', 'add', '4']), /Open a project first/);
  await assert.rejects(orchestratorCommand(['mandate', 'm1', 'add']), /Open a session/);
  // A session on another computer joins only when that computer is marked as the owner's here.
  await assert.rejects(orchestratorCommand(['mandate', 'm1', 'add'], { open: { computer: 'd'.repeat(64), project: 'abc123', session: '113' } }), /not marked as yours here/);
});

test('/orchestrator mandate remove: the mandate is gone, and its sessions get notes again', async t => {
  const w = world(t); w.session(4);
  await orchestratorCommand([], { text: 'mandate Workflows: A' });
  await orchestratorCommand([], { text: 'mandate Billing: B' });
  await orchestratorCommand(['mandate', 'm1', 'add', '4'], { root: w.root });
  assert.equal((await orchestratorCommand(['mandate', 'remove', 'workflows'])).line, "Removed mandate m1 Workflows. In its sessions the Orchestrator's messages are notes again.");
  assert.deepEqual(mandates().map(m => m.id), ['m2']);
  assert.equal(mandateFor({ computer: null, project: w.key, session: '4' }), null);
  await assert.rejects(orchestratorCommand(['mandate', 'remove', 'm1']), /No mandate is named m1/);
  assert.equal((await orchestratorCommand(['mandate', 'remove', 'm2'])).line.startsWith('Removed mandate m2'), true);
  assert.equal((await orchestratorCommand(['mandates'])).line, 'No mandates yet. /orchestrator mandate NAME: decision; decision makes one.');
});

test('/computers: the owner marks a computer on his team as his on this computer, by its name, and takes the mark away', async t => {
  const { founder, member } = makeTeam(t);
  await withHome(founder.home, async () => {
    assert.equal((await computersCommand([])).line, 'None is marked as yours here. Not marked: @sara. /computers mine NAME marks one.');
    await assert.rejects(computersCommand(['mine', 'nobody']), /No computer on your projects goes by @nobody/);
    await assert.rejects(computersCommand(['mine']), /Use \/computers/);
    await assert.rejects(computersCommand(['own', 'sara']), /Use \/computers/);
    // It goes by another person's name on the team: asked first, and no is no.
    const asked = [];
    const no = await computersCommand(['mine', '@Sara'], { yes: async (title, question) => { asked.push([title, question]); return false; } });
    assert.equal(no.line, 'Nothing was marked.');
    assert.equal(isMyComputer(member.identity.key), false);
    assert.match(asked[0][1], /^@sara is sara's on your team\. Marked, what it sends for you counts as your own words here/);
    const yes = await computersCommand(['mine', 'sara'], { yes: async () => true });
    assert.match(yes.line, /^@sara is yours here: what it sends for you counts as your own words\. On @sara, \/computers mine .+ marks this one too\.$/);
    assert.equal(isMyComputer(member.identity.key), true);
    assert.equal((await computersCommand(['mine', member.identity.key.slice(0, 8)])).line, '@sara is yours here already.');
    assert.equal((await computersCommand([])).line, 'Yours here: @sara.');
    assert.equal((await computersCommand(['unmine', 'sara'])).line, "@sara is not yours here now: what it sends counts as a teammate's again.");
    assert.equal(isMyComputer(member.identity.key), false);
    assert.equal((await computersCommand(['unmine', 'sara'])).line, '@sara was not marked as yours here.');
  });
  // The mark is that computer's own: the member's computer marked nothing.
  await withHome(member.home, async () => assert.equal(isMyComputer(founder.identity.key), false));
});

test('/computers: a computer with nothing shared says so, and a mark is never made for a computer off the team', async t => {
  world(t);
  assert.equal((await computersCommand([])).line, 'No other computer shares a project with this one. /invite in a project shares it.');
  await assert.rejects(computersCommand(['mine', 'devbox']), /No computer on your projects/);
  assert.throws(() => markMyComputer('e'.repeat(64), 'devbox'));
});
