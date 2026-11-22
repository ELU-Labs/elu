import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTeam, newHome, withHome } from './peer-helpers.mjs';
import { isMyComputer, markMyComputer, myComputers, unmarkMyComputer } from '../lib/peer/my-computers.mjs';
import { asOwnerMark, NEW_REMOTE_COMMANDS, OWNER_VIA, REMOTE_METHODS, START_FIELDS } from '../lib/peer/remote-methods.mjs';
import { decisionsBlock, joinMandate, mandateFor, mandates, mandatesFile, saveMandate } from '../lib/orchestrator-mandates.mjs';
import { agentThread, AGENT_KINDS, AGENT_STATES, sessionAgents } from '../lib/session-agents.mjs';
import { FULL_ASK_LIST, FULL_TOOLS, LEVEL_FULL, OVERSEE_FULL } from '../lib/orchestrator-seams.mjs';
import { peerFile } from '../lib/peer/paths.mjs';

// The seams of the Orchestrator at Full (docs: orchestrator full control). With nothing marked
// or configured, each behaves as ELU did before them.

test('my computers: nothing is the owner\'s until he marks it here, and only a computer on his team', t => {
  const { founder, member } = makeTeam(t);
  withHome(founder.home, () => {
    assert.equal(isMyComputer(member.identity.key), false, 'unmarked is a teammate');
    assert.deepEqual(myComputers(), []);
    assert.throws(() => markMyComputer(founder.identity.key, 'self'), /computer you are on/);
    assert.throws(() => markMyComputer('e'.repeat(64), 'stranger'), /none of your projects/);
    const row = markMyComputer(member.identity.key, 'dev box');
    assert.equal(row.name, 'devbox');
    assert.equal(isMyComputer(member.identity.key), true);
    assert.deepEqual(myComputers().map(r => r.key), [member.identity.key]);
    // The old marks file never counts.
    assert.equal(fs.existsSync(peerFile('mine.json')), false);
    assert.equal(unmarkMyComputer(member.identity.key), true);
    assert.equal(isMyComputer(member.identity.key), false);
  });
  // The mark is this computer's alone: the member's computer did not mark the founder's.
  withHome(member.home, () => assert.equal(isMyComputer(founder.identity.key), false));
});

test('my computers: a damaged file marks nothing', t => {
  const { founder, member } = makeTeam(t);
  withHome(founder.home, () => {
    fs.mkdirSync(peerFile(), { recursive: true });
    fs.writeFileSync(peerFile('my-computers.json'), '{"version":2,"computers":{}}');
    assert.equal(isMyComputer(member.identity.key), false);
    fs.writeFileSync(peerFile('my-computers.json'), 'not json');
    assert.equal(isMyComputer(member.identity.key), false);
  });
});

test('remote methods and the asOwner mark', () => {
  assert.deepEqual(Object.values(REMOTE_METHODS), ['elu.remote.settings', 'elu.remote.log', 'elu.remote.agents']);
  assert.deepEqual(NEW_REMOTE_COMMANDS, ['remoteSettings', 'remoteLog', 'remoteAgents']);
  assert.ok(START_FIELDS.includes('title') && START_FIELDS.includes('mandate'));
  assert.deepEqual(asOwnerMark({ bot: 'orchestrator', mandate: 'm1' }), { bot: 'orchestrator', mandate: 'm1', computer: null });
  for (const bad of [null, {}, { bot: 'orchestrator' }, { bot: 'Orchestrator', mandate: 'm1' }, { bot: 'orchestrator', mandate: 'x1' }, { bot: 'orchestrator', mandate: 'm1', computer: 'abc' }]) assert.equal(asOwnerMark(bad), null, JSON.stringify(bad));
  assert.equal(OWNER_VIA('orchestrator', 'Workflows'), 'You · via @orchestrator · Workflows');
});

test('mandates: none is today\'s behaviour; only the owner makes one', t => {
  const home = newHome(t);
  withHome(home, () => {
    assert.deepEqual(mandates(), []);
    assert.equal(mandateFor({ computer: null, project: 'p1', session: '7' }), null);
    assert.throws(() => saveMandate({ name: 'Workflows' }, { by: 'orchestrator' }), /Only the owner/);
    const m = saveMandate({ name: 'Workflows', goal: 'Ship the runtime', decisions: ['Codex helpers may spend credits'] }, { by: 'owner' });
    assert.equal(m.id, 'm1');
    const devbox = 'd'.repeat(64);
    joinMandate('m1', { computer: devbox, project: 'abc123', session: '113' }, { by: 'start' });
    assert.throws(() => joinMandate('m1', { computer: null, project: 'abc123', session: '9' }, { by: 'orchestrator' }), /Only the owner/);
    assert.equal(mandateFor({ computer: devbox, project: 'abc123', session: '113' })?.name, 'Workflows');
    assert.equal(mandateFor({ computer: null, project: 'abc123', session: '113' }), null, 'another computer is another session');
    assert.equal(decisionsBlock(m), "Owner's decisions (mandate Workflows):\n- Codex helpers may spend credits");
    fs.writeFileSync(mandatesFile(), 'broken');
    assert.deepEqual(mandates(), []);
  });
});

test('session agents and the level names', () => {
  assert.deepEqual(sessionAgents({}, {}), []);
  assert.deepEqual(agentThread({}, {}, 'lead'), []);
  assert.deepEqual(AGENT_KINDS, ['coder', 'bot', 'subagent', 'helper']);
  assert.deepEqual(AGENT_STATES, ['working', 'waiting', 'done']);
  assert.equal(LEVEL_FULL, 'full'); assert.equal(OVERSEE_FULL, 'overseeFull');
  assert.ok(FULL_ASK_LIST.includes('Bash(npm publish:*)'));
  assert.ok(FULL_TOOLS.includes('session_settings'));
});
