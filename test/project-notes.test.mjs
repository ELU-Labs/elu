import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { newHome, withHome, makeTeam, registeredProject } from './peer-helpers.mjs';
import { readProjectSettings, saveContext, saveInstructions } from '../lib/project-settings.mjs';
import { saveLearned } from '../lib/project-learnings.mjs';
import { composeContext, saveContextEdit, splitContext } from '../lib/project-notes.mjs';
import { joinRows, notesRows, notesTick, projectLinks, takeNotes } from '../lib/peer/notes.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import { head } from '../lib/peer/roster.mjs';
import { peerFile } from '../lib/peer/paths.mjs';
import { BINDING } from '../lib/peer/a2a.mjs';
import { PeerDaemon } from '../lib/peer/daemon.mjs';

// The owner's two computers, a laptop and a devbox, on one team, with no project shared yet.
function ownComputers(t) {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ana' });
  const laptop = { ...team.founder, key: team.founder.identity.key, name: 'laptop' }, devbox = { ...team.member, key: team.member.identity.key, name: 'devbox' };
  return { team, laptop, devbox };
}
const on = (side, fn) => withHome(side.home, fn);
const today = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; };

test("a project's context is the owner's own text and a set of learned lines, put back together as it was", () => {
  const text = 'The API lives in src/.\n\n## Learned from you\n\n- 2026-11-10: Use pnpm, not npm.\n- 2026-11-12: Keep replies short.\n';
  const { own, learned } = splitContext(text);
  assert.equal(own, 'The API lives in src/.');
  assert.deepEqual(learned.map(row => row.line), ['- 2026-11-10: Use pnpm, not npm.', '- 2026-11-12: Keep replies short.']);
  assert.equal(composeContext(own, learned.map(row => row.line)), text);
  assert.equal(composeContext('', []), ''); assert.equal(composeContext('Only mine.', []), 'Only mine.\n');
});

test('an edit of the context in the Projects tab keeps a line learned while it was open, and takes out only the lines he took out', t => {
  const home = newHome(t); withHome(home, () => {
    const { root } = registeredProject(t);
    saveContext(root, 'Mine.\n\n## Learned from you\n\n- 2026-11-10: Use pnpm, not npm.\n');
    const opened = readProjectSettings(root).context;
    // A session learns something while the editor is open.
    saveLearned(root, { add: ['Deploys go through staging first.'], remove: [] });
    // He takes the pnpm line out and changes his own text.
    saveContextEdit(root, opened, 'Mine, edited.\n\n## Learned from you\n\n');
    const { own, learned } = splitContext(readProjectSettings(root).context);
    assert.equal(own, 'Mine, edited.');
    assert.deepEqual(learned.map(row => row.line), [`- ${today()}: Deploys go through staging first.`]);
  });
});

// There is no "mine": a project's instructions and context go only with a shared project
// (test/shared-project.test.mjs), to every computer on it alike. The owner's own other
// computer is sent nothing of a project not shared, nothing it sends of one is taken, and
// a computer on no team with this one is refused.
test('the owner\'s own other computer is sent no instructions or context of a project not shared, and nothing it sends of one is taken', t => {
  const { team, laptop, devbox } = ownComputers(t);
  const mac = on(laptop, () => registeredProject(t)), box = on(devbox, () => registeredProject(t));
  on(laptop, () => saveInstructions(mac.root, 'Use pnpm, not npm.'));
  on(devbox, () => saveInstructions(box.root, 'Only on the devbox.'));
  on(laptop, () => {
    const daemon = Object.assign(new PeerDaemon({ conductor: () => {} }), { me: laptop.identity, node: { dial() {}, leave() {} } }); daemon.methods = daemon.extensions();
    assert.equal(daemon.hello(devbox.key).notes, 1, 'this build says in its hello that it shares them');
    const wire = { out: '' }, socket = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; this.emit('close'); }, write: chunk => { wire.out += chunk; return true; } });
    daemon.attach(socket, devbox.key);
    socket.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'elu.hello', params: { binding: BINDING, a2aVersion: '1.0', name: 'ana', teams: [{ id: team.teamId, ...head(team.teamId), ops: [] }], handles: [], plans: true, remote: 1, lists: 1, notes: 1, shared: 1 } })}\n`));
    daemon.tellNotes();
    const frames = wire.out.split('\n').flatMap(line => { try { const frame = JSON.parse(line); return frame.method === 'elu.notes' ? [frame] : []; } catch { return []; } });
    assert.deepEqual(joinRows(frames.at(-1)?.params.notes ?? []), [], 'no project is shared');
    const rows = withHome(devbox.home, () => notesRows(laptop.key, notesTick({ me: devbox.key })));
    socket.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'elu.notes', params: { notes: rows } })}\n`));
    assert.deepEqual(JSON.parse(fs.readFileSync(peerFile('notes', 'from', `${devbox.key}.json`), 'utf8')).projects, []);
    assert.deepEqual(projectLinks(mac.root), []);
    assert.equal(readProjectSettings(mac.root).instructions, 'Use pnpm, not npm.\n');
    const stranger = withHome(newHome(t), () => createIdentity({ name: 'eve' }));
    assert.throws(() => takeNotes(laptop.key, stranger.key, rows), { message: 'Only computers on a project with this one share its instructions and context.' });
    daemon.closed = true; clearInterval(daemon.timer);
  });
});
