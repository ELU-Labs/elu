import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTeam, newHome, withHome } from './peer-helpers.mjs';
import { isMyComputer, markMyComputer, myComputers, notMyComputer, unmarkMyComputer } from '../lib/peer/my-computers.mjs';
import { asOwnerMark, NEW_REMOTE_COMMANDS, OWNER_VIA, OWNER_WORD_FULL, REMOTE_METHODS, START_FIELDS } from '../lib/peer/remote-methods.mjs';
import { checkGithub, githubPaired, pairingStatus, vouched } from '../lib/peer/github-pairing.mjs';
import { decisionsBlock, DECISIONS_HEADING } from '../lib/owner-decisions.mjs';
import { agentThread, AGENT_KINDS, AGENT_STATES, sessionAgents } from '../lib/session-agents.mjs';
import { FULL_ASK_LIST, FULL_TOOLS, LEVEL_FULL, OVERSEE_FULL } from '../lib/orchestrator-seams.mjs';
import { peerFile } from '../lib/peer/paths.mjs';

// The seams of the Orchestrator at Full (docs/orchestrator.md). With nothing paired or marked,
// each behaves as ELU did before them.

// The owner's GitHub account vouches for keys, as a good check of lib/peer/github-pairing.mjs saves it.
export const pairByGithub = (keys, okAt = new Date().toISOString()) => {
  fs.mkdirSync(peerFile(), { recursive: true });
  fs.writeFileSync(peerFile('github-pairing.json'), JSON.stringify({ version: 1, state: 'ok', at: okAt, login: 'owner', account: 1, keys, okAt }));
};

test('my computers: a computer paired by the GitHub account is his on both sides with no step; unmine wins over it', t => {
  const { founder, member } = makeTeam(t);
  withHome(founder.home, () => {
    assert.equal(isMyComputer(member.identity.key), false, 'nothing paired is a teammate');
    assert.deepEqual(myComputers(), []);
    pairByGithub([member.identity.key]);
    assert.equal(isMyComputer(member.identity.key), true, 'paired is his, unmarked');
    assert.deepEqual(myComputers().map(r => [r.key, r.paired]), [[member.identity.key, true]]);
    // A stranger the account vouches for is on no team with this computer: not his.
    pairByGithub([member.identity.key, 'e'.repeat(64)]);
    assert.equal(isMyComputer('e'.repeat(64)), false);
    // unmine keeps "not mine" over the pairing, until he marks it again.
    assert.equal(unmarkMyComputer(member.identity.key, 'devbox'), true);
    assert.equal(isMyComputer(member.identity.key), false);
    assert.equal(notMyComputer(member.identity.key), true);
    assert.deepEqual(myComputers(), []);
    markMyComputer(member.identity.key, 'devbox');
    assert.equal(isMyComputer(member.identity.key), true);
    assert.equal(notMyComputer(member.identity.key), false);
    // A pairing a day old with no good check since counts no more.
    fs.writeFileSync(peerFile('my-computers.json'), JSON.stringify({ version: 1, computers: {}, notMine: {} }));
    pairByGithub([member.identity.key], new Date(Date.now() - 25 * 3600000).toISOString());
    assert.equal(isMyComputer(member.identity.key), false, 'a stale pairing');
    assert.equal(githubPaired(member.identity.key), false);
  });
  // Each side reads its own account: the member's computer, paired the same way, takes the founder's as its owner's.
  withHome(member.home, () => {
    assert.equal(isMyComputer(founder.identity.key), false);
    pairByGithub([founder.identity.key]);
    assert.equal(isMyComputer(founder.identity.key), true);
  });
});

test('my computers: a pairing made both ways by ELU up to 0.1.33 counts; a one-sided one does not', t => {
  const { founder, member } = makeTeam(t);
  withHome(founder.home, () => {
    fs.mkdirSync(peerFile(), { recursive: true });
    const at = new Date().toISOString();
    fs.writeFileSync(peerFile('mine.json'), JSON.stringify({ [member.identity.key]: { at } }));
    assert.equal(isMyComputer(member.identity.key), false, 'marked here only');
    fs.writeFileSync(peerFile('mine.json'), JSON.stringify({ [member.identity.key]: { at, theirs: true, theirsAt: at } }));
    assert.equal(isMyComputer(member.identity.key), true, 'paired both ways');
  });
});

test('my computers: marked by hand when not paired, only a computer on his team', t => {
  const { founder, member } = makeTeam(t);
  withHome(founder.home, () => {
    assert.throws(() => markMyComputer(founder.identity.key, 'self'), /computer you are on/);
    assert.throws(() => markMyComputer('e'.repeat(64), 'stranger'), /none of your projects/);
    const row = markMyComputer(member.identity.key, 'dev box');
    assert.equal(row.name, 'devbox');
    assert.equal(isMyComputer(member.identity.key), true);
    assert.deepEqual(myComputers().map(r => r.key), [member.identity.key]);
    assert.equal(unmarkMyComputer(member.identity.key), true);
    assert.equal(isMyComputer(member.identity.key), false);
  });
  // The mark is this computer's alone.
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
    fs.writeFileSync(peerFile('github-pairing.json'), 'not json');
    assert.equal(isMyComputer(member.identity.key), false);
  });
});

test('GitHub pairing: the gist of the signed-in account vouches; the check keeps this computer in it', async t => {
  const home = newHome(t), me = 'a'.repeat(64), other = 'b'.repeat(64), calls = [];
  const gist = { id: 'g1', created_at: '2026-01-01T00:00:00Z', files: { [`${other}.json`]: { content: JSON.stringify({ key: other, name: 'devbox' }) }, [`${'c'.repeat(64)}.json`]: { content: JSON.stringify({ key: 'd'.repeat(64) }) } } };
  const run = async (args, { input }) => {
    calls.push([args.join(' '), input]);
    if (args[1] === '-i') return { code: 0, stdout: 'HTTP/2 200\nx-oauth-scopes: gist, repo\n\n{"id":1,"login":"owner"}', stderr: '' };
    if (args[1] === '--paginate') return { code: 0, stdout: '{"id":"g1","created_at":"2026-01-01T00:00:00Z"}\n', stderr: '' };
    if (args[1] === 'gists/g1') return { code: 0, stdout: JSON.stringify(gist), stderr: '' };
    if (args[2] === 'PATCH') return { code: 0, stdout: JSON.stringify({ ...gist, files: { ...gist.files, [`${me}.json`]: { content: JSON.parse(input).files[`${me}.json`].content } } }), stderr: '' };
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  await withHome(home, async () => {
    assert.equal((await checkGithub({ me, run, env: { NODE_TEST_CONTEXT: 'child' } })).state, 'off', 'a test run asks first');
    const got = await checkGithub({ me, name: 'mac', run, env: { ELU_GITHUB_PAIRING: '1' } });
    assert.equal(got.state, 'ok');
    assert.deepEqual(got.keys, [other], 'a file whose content names another key vouches for nothing');
    assert.ok(calls.some(([line, input]) => line.startsWith('api -X PATCH gists/g1') && JSON.parse(input).files[`${me}.json`]), 'this computer wrote its own file');
    assert.deepEqual(pairingStatus().keys, [other]);
    assert.equal(githubPaired(other), true);
    // A failed check keeps what the last good one found.
    const failing = async () => ({ code: 1, stdout: '', stderr: 'HTTP 502' });
    assert.equal((await checkGithub({ me, run: failing, env: { ELU_GITHUB_PAIRING: '1' } })).state, 'error');
    assert.equal(githubPaired(other), true);
    assert.equal((await checkGithub({ me, run: async () => ({ code: 4, stdout: '', stderr: 'gh auth login' }), env: { ELU_GITHUB_PAIRING: '1' } })).state, 'signedout');
  });
  assert.deepEqual([...vouched([gist])], [other]);
});

test('remote methods and the asOwner mark: no mandate, and only to a host at OWNER_WORD_FULL', () => {
  assert.deepEqual(Object.values(REMOTE_METHODS), ['elu.remote.settings', 'elu.remote.log', 'elu.remote.agents', 'elu.remote.decisions']);
  assert.deepEqual(NEW_REMOTE_COMMANDS, ['remoteSettings', 'remoteLog', 'remoteAgents', 'remoteDecisions']);
  assert.equal(OWNER_WORD_FULL, 2);
  assert.deepEqual(START_FIELDS, ['title', 'botModels', 'folders']);
  assert.deepEqual(asOwnerMark({ bot: 'orchestrator' }), { bot: 'orchestrator', computer: null });
  assert.deepEqual(asOwnerMark({ bot: 'orchestrator', mandate: 'm1' }), { bot: 'orchestrator', computer: null }, 'an old row keeps its mark');
  for (const bad of [null, {}, { bot: 'Orchestrator' }, { bot: 'orchestrator', computer: 'abc' }]) assert.equal(asOwnerMark(bad), null, JSON.stringify(bad));
  assert.equal(OWNER_VIA('orchestrator'), 'You · via @orchestrator');
});

test('owner decisions: none is today\'s behaviour; a session with some reads them under the heading', () => {
  assert.equal(decisionsBlock({}), '');
  assert.equal(decisionsBlock({ ownerDecisions: ['Codex helpers may spend credits', 7, ''] }), `${DECISIONS_HEADING}:\nThe owner set these for this session. Follow each of them in every turn, as his own instructions, until he changes them.\n1. Codex helpers may spend credits`);
});

test('session agents and the level names', () => {
  assert.deepEqual(sessionAgents({}, {}), []);
  assert.deepEqual(agentThread({}, {}, 'lead'), []);
  assert.deepEqual(AGENT_KINDS, ['coder', 'bot', 'subagent', 'helper']);
  assert.deepEqual(AGENT_STATES, ['working', 'waiting', 'done']);
  assert.equal(LEVEL_FULL, 'full'); assert.equal(OVERSEE_FULL, 'overseeFull');
  assert.ok(FULL_ASK_LIST.includes('Bash(npm publish:*)'));
  assert.ok(FULL_TOOLS.includes('session_settings') && FULL_TOOLS.includes('session_update_task') && !FULL_TOOLS.includes('mandate_propose'));
});
