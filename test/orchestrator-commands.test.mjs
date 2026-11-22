import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { temp } from './helpers.mjs';
import { makeTeam, withHome } from './peer-helpers.mjs';
import { readTask, saveTask } from '../lib/state.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { registerProject } from '../lib/projects.mjs';
import { readSettings } from '../lib/orchestrator-settings.mjs';
import { isMyComputer, markMyComputer } from '../lib/peer/my-computers.mjs';
import { projectKey } from '../lib/peer/remote.mjs';
import { peerFile } from '../lib/peer/paths.mjs';
import { computersCommand, orchestratorCommand } from '../lib/orchestrator-commands.mjs';

// The owner's commands for the Orchestrator (lib/orchestrator-commands.mjs): its level, Full the
// default among them, and which computers are his. Made-up sessions of a plain folder
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

test('/orchestrator alone is a page: Full by default, the caps and the commands, no mandates', async t => {
  world(t);
  const page = await orchestratorCommand([]);
  assert.equal(page.title, 'Orchestrator');
  assert.match(page.text, /^Level: Full, the default\. /, 'a fresh install is at Full with no command');
  assert.match(page.text, /never in a teammate's/);
  assert.match(page.text, /\/orchestrator watch, suggest, act, run or full sets the level\./);
  assert.doesNotMatch(page.text, /mandate/i);
  // A level the owner set stays.
  await orchestratorCommand(['suggest']);
  assert.match((await orchestratorCommand([])).text, /^Level: Suggest\./);
  // The mandate words are gone.
  await assert.rejects(orchestratorCommand(['mandate', 'Settings:', 'A']), /Use \/orchestrator/);
  await assert.rejects(orchestratorCommand(['mandates']), /Use \/orchestrator/);
});

test('/computers: the owner marks a computer on his team as his on this computer, by its name, and unmine says it is not', async t => {
  const { founder, member } = makeTeam(t);
  await withHome(founder.home, async () => {
    assert.equal((await computersCommand([])).line, 'None is yours here yet: a computer signed in to the same GitHub account is paired as yours. Not yours: @sara. /computers mine NAME makes one yours.');
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
    assert.match(yes.line, /^@sara is yours here: what it sends for you counts as your own words\. Unless the two are paired, on @sara \/computers mine .+ makes this one its too\.$/);
    assert.equal(isMyComputer(member.identity.key), true);
    assert.equal((await computersCommand(['mine', member.identity.key.slice(0, 8)])).line, '@sara is yours here already.');
    assert.equal((await computersCommand([])).line, 'Yours here: @sara.');
    assert.equal((await computersCommand(['unmine', 'sara'])).line, "@sara is not yours here now, paired or not: what it sends counts as a teammate's again. /computers mine sara makes it yours again.");
    assert.equal(isMyComputer(member.identity.key), false);
    assert.equal((await computersCommand(['unmine', 'sara'])).line, '@sara is not yours here.');
  });
  // The mark is that computer's own: the member's computer marked nothing.
  await withHome(member.home, async () => assert.equal(isMyComputer(founder.identity.key), false));
});

test('/computers: a paired computer is listed as his with no step, and unmine overrides the pairing', async t => {
  const { founder, member } = makeTeam(t);
  await withHome(founder.home, async () => {
    fs.mkdirSync(peerFile(), { recursive: true });
    const okAt = new Date().toISOString();
    fs.writeFileSync(peerFile('github-pairing.json'), JSON.stringify({ version: 1, state: 'ok', at: okAt, keys: [member.identity.key], okAt }));
    assert.equal((await computersCommand([])).line, 'Yours here: @sara.');
    assert.equal((await computersCommand(['mine', 'sara'])).line, '@sara is yours here already.');
    assert.match((await computersCommand(['unmine', 'sara'])).line, /^@sara is not yours here now, paired or not/);
    assert.equal(isMyComputer(member.identity.key), false);
    assert.match((await computersCommand([])).line, /Not yours: @sara\./);
    await computersCommand(['mine', 'sara'], { yes: async () => true });
    assert.equal(isMyComputer(member.identity.key), true);
  });
});

test('/computers: a computer with nothing shared says so, and a mark is never made for a computer off the team', async t => {
  world(t);
  assert.equal((await computersCommand([])).line, 'No other computer shares a project with this one. /invite in a project shares it.');
  await assert.rejects(computersCommand(['mine', 'devbox']), /No computer on your projects/);
  assert.throws(() => markMyComputer('e'.repeat(64), 'devbox'));
});
