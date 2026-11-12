import test from 'node:test';
import assert from 'node:assert/strict';
import { argumentMatches, mentionMatches, botMatches, sessionMentions, commandMatches, parseCommand, COMMANDS, needsArgument } from '../lib/terminal-commands.mjs';

const ctx = {
  models: () => [{ name: 'opus', vendor: 'Claude', note: 'most capable', current: true }, { name: 'gpt', vendor: 'Codex' }],
  servers: () => ({ all: ['elu', 'gmail'], on: ['elu'] }),
  teammates: () => [{ name: 'sara', online: false }, { name: 'devbox', online: true, path: 'direct' }],
  bots: () => [{ name: 'docs', about: 'Checks the docs', here: false, color: 'blue' }, { name: 'sec', about: 'Finds leaked secrets', here: true, scheduled: true }, { name: 'style', about: 'Reads for tone', here: false }],
};
const values = (text, context = ctx) => argumentMatches(text, context).map(row => row.value);

test('the command list offers each next word of a command', () => {
  assert.deepEqual(values('/agents '), ['/agents add', '/agents remove']);
  assert.deepEqual(values('/agent '), ['/agent add', '/agent remove'], '/agent and /agents take the same words');
  assert.deepEqual(argumentMatches('/agents add ', ctx).map(row => `${row.value} · ${row.description}`), ['/agents add opus · Claude · most capable', '/agents add gpt · Codex'], 'the models /model offers, without which one is in use');
  assert.deepEqual(values('/agents add G'), ['/agents add gpt']);
  assert.deepEqual(values('/agents remove '), ['/agents remove sec'], 'the bots of this session');
  assert.deepEqual(values('/mcp on '), ['/mcp on gmail']); assert.deepEqual(values('/mcp off '), ['/mcp off elu']);
  for (const done of ['/agents add opus ', '/agents', '/help ', '/unknown x']) assert.deepEqual(values(done), [], done);
  assert.deepEqual(values('/agents add ', {}), [], 'no models known, nothing to offer');
  assert.deepEqual(values('/agents add ', { models: () => { throw new Error('no project'); } }), []);
});

test('/permissions offers the modes, the default, and the folders the model may read', () => {
  assert.deepEqual(values('/permissions '), ['/permissions ask', '/permissions auto', '/permissions full', '/permissions default', '/permissions folders', '/permissions rules']);
  assert.deepEqual(argumentMatches('/permissions ru', ctx).map(row => `${row.value} · ${row.more}`), ['/permissions rules · false'], 'rules alone opens the list');
  assert.deepEqual(values('/permissions rules '), ['/permissions rules remove', '/permissions rules on']);
  assert.equal(needsArgument(COMMANDS.find(row => row.name === 'permissions')), false, 'bare /permissions runs');
  assert.deepEqual(argumentMatches('/permissions fo', ctx).map(row => `${row.value} · ${row.description} · ${row.more}`), ['/permissions folders · Let the model read another folder this session · true'], 'add follows it');
  assert.deepEqual(argumentMatches('/permissions folders ', ctx).map(row => `${row.value} · ${row.description} · ${row.more}`), ['/permissions folders add · Add a folder the model may read this session · true'], 'a path follows it');
  assert.deepEqual(values('/permissions default '), ['/permissions default ask', '/permissions default auto', '/permissions default full']);
  for (const done of ['/permissions folders add ', '/permissions auto ', '/permissions']) assert.deepEqual(values(done), [], done);
});

test('a removed command is not listed, offers no next word, and is unknown when typed', () => {
  const names = COMMANDS.map(command => command.name);
  for (const gone of ['ask', 'review', 'handoff', 'folders', 'open', 'create', 'verify', 'diff']) {
    assert.ok(!names.includes(gone), gone);
    assert.deepEqual(commandMatches(`/${gone}`), [], gone);
    assert.deepEqual(values(`/${gone} `), [], gone);
    assert.throws(() => parseCommand(`/${gone} x`), { message: `Unknown command: /${gone}. Type / to see commands.` });
  }
  assert.deepEqual(commandMatches('/chan').map(command => command.name), ['changes'], 'one command shows what a session changed');
  assert.deepEqual(parseCommand('/permissions folders add "~/my evals"').args, ['folders', 'add', '~/my evals'], 'a quoted folder is one word');
});

test('@ in a session offers bots, then teammates; a teammate named like a bot is left to Chats', () => {
  const both = { ...ctx, teammates: () => [{ name: 'sec', online: true }, { name: 'sara', online: false }] };
  assert.deepEqual(sessionMentions('@s', both).map(row => `${row.value} · ${row.description}`), ['@sec · Finds leaked secrets', '@style · Reads for tone', '@sara · teammate · offline']);
  assert.deepEqual(sessionMentions('@sara hi', both), []);
  // In an open session @model is offered too: it writes to the session's own model. With no session open it is not.
  const open = { ...both, model: () => 'Opus 5' };
  assert.deepEqual(sessionMentions('@m', open).map(row => `${row.value} · ${row.description}`), ['@model · Opus 5 · the model of this session']);
  assert.equal(sessionMentions('@', open).some(row => row.value === '@model'), true); assert.equal(sessionMentions('@', both).some(row => row.value === '@model'), false);
  assert.equal(sessionMentions('@', { ...both, model: () => null }).some(row => row.value === '@model'), false);
  // A teammate named model is left to Chats there, as one named like a bot is.
  assert.deepEqual(sessionMentions('@mo', { ...open, teammates: () => [{ name: 'model', online: true }] }).map(row => row.description), ['Opus 5 · the model of this session']);
});

test('@ offers teammates by name, and stops after a space', () => {
  assert.deepEqual(mentionMatches('@', ctx).map(row => row.value), ['@devbox', '@sara']);
  assert.deepEqual(mentionMatches('@dev', ctx).map(row => `${row.value} ${row.description}`), ['@devbox online · direct']);
  for (const text of ['@devbox hi', 'hi @dev', '@@']) assert.deepEqual(mentionMatches(text, ctx), [], text);
});

test('/bots offers its next words, then the bots each one can take', () => {
  assert.deepEqual(argumentMatches('/bots ', ctx).map(row => `${row.value} · ${row.description}`), ['/bots add · Keep a bot in this chat', '/bots remove · Take a bot out of this chat', '/bots schedule · Turn a bot\'s schedule off or on in this session', '/bots run · Tell a scheduled bot to work now', '/bots color · Give a bot a color, or a new random one']);
  assert.ok(argumentMatches('/bots ', ctx).every(row => row.more), 'each needs a name after it');
  assert.deepEqual(values('/bots re'), ['/bots remove']);
  assert.deepEqual(argumentMatches('/bots add ', ctx).map(row => `${row.value} · ${row.description}`), ['/bots add docs · Checks the docs', '/bots add style · Reads for tone'], 'bots that are not in the chat');
  assert.deepEqual(values('/bots add st'), ['/bots add style']);
  assert.deepEqual(values('/bots remove '), ['/bots remove sec'], 'bots that are in it');
  assert.deepEqual(values('/bots schedule '), ['/bots schedule off', '/bots schedule on']);
  assert.deepEqual(values('/bots schedule off '), ['/bots schedule off sec'], 'only a bot of this chat that has a schedule');
  assert.deepEqual(values('/bots run '), ['/bots run sec']);
  assert.deepEqual(argumentMatches('/bots color ', ctx).map(row => `${row.value} · ${row.description}`), ['/bots color docs · blue now', '/bots color sec · Finds leaked secrets', '/bots color style · Reads for tone']);
  assert.deepEqual(values('/bots color docs ran'), ['/bots color docs random']);
  for (const done of ['/bots add docs ', '/bots keep ', '/bots']) assert.deepEqual(values(done), [], done);
  assert.deepEqual(values('/bots add ', {}), [], 'no saved bots, nothing to offer');
  assert.deepEqual(values('/bots add ', { bots: () => { throw new Error('unreadable'); } }), []);
});

test('@ offers saved bots by name with what each is for, and stops after a space', () => {
  assert.deepEqual(botMatches('@', ctx).map(row => `${row.value} · ${row.description}`), ['@docs · Checks the docs', '@sec · Finds leaked secrets', '@style · Reads for tone']);
  assert.deepEqual(botMatches('@S', ctx).map(row => row.value), ['@sec', '@style']);
  assert.ok(botMatches('@', ctx).every(row => row.more), 'a message follows the name');
  for (const text of ['@sec hi', 'hi @sec', '@@', '@nobody', 'sec']) assert.deepEqual(botMatches(text, ctx), [], text);
  assert.deepEqual(botMatches('@'), []); assert.deepEqual(botMatches('@', { bots: () => { throw new Error('unreadable'); } }), []);
});

test('/invite offers the teammates who can join the open channel, and nobody where no channel is open', () => {
  const open = { invitees: () => ({ channel: 'design', people: [{ name: 'li', online: false }, { name: 'Sara', online: true }, { name: 'omar', online: false }] }) };
  assert.deepEqual(argumentMatches('/invite ', open).map(row => `${row.value} · ${row.description}`),
    ['/invite @Sara · add to #design · online', '/invite @li · add to #design · offline', '/invite @omar · add to #design · offline'], 'who is online comes first');
  assert.deepEqual(values('/invite s', open), ['/invite @Sara'], 'narrowed as typed, in any case');
  assert.deepEqual(values('/invite @S', open), ['/invite @Sara']); assert.deepEqual(values('/invite @o', open), ['/invite @omar']);
  assert.ok(argumentMatches('/invite ', open).every(row => !row.more), 'Enter on a name adds that teammate');
  for (const done of ['/invite @li ', '/invite x', '/invite']) assert.deepEqual(values(done, open), [], done);
  // #general, a direct message, a bot's chat and the other tabs have no channel to add to.
  assert.deepEqual(values('/invite ', { invitees: () => null }), []); assert.deepEqual(values('/invite ', ctx), []);
  assert.deepEqual(values('/invite ', { invitees: () => ({ channel: 'design', people: [] }) }), [], 'everyone is in it');
  assert.deepEqual(values('/invite ', { invitees: () => { throw new Error('unreadable'); } }), []);
  // The name is optional, so /invite alone still runs, and the list says both things it does.
  const invite = COMMANDS.find(command => command.name === 'invite');
  assert.equal(invite.description, 'Add a teammate to this channel, or make a code for someone new'); assert.equal(invite.usage, '/invite [@teammate|team]');
  assert.deepEqual(commandMatches('/inv').map(command => command.name), ['invite']);
  assert.deepEqual(parseCommand('/invite').args, []); assert.deepEqual(parseCommand('/invite @sara').args, ['@sara']);
});
