import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { newHome, withHome, makeTeam, registeredProject } from './peer-helpers.mjs';
import { readProjectSettings, projectPromptParts, saveContext, saveInstructions } from '../lib/project-settings.mjs';
import { saveLearned } from '../lib/project-learnings.mjs';
import { ensureTrustStore, pendingTrust } from '../lib/project-trust.mjs';
import { composeContext, saveContextEdit, splitContext } from '../lib/project-notes.mjs';
import { joinRows, linkProject, notesRows, notesSaid, notesTick, projectLinks, takeNotes } from '../lib/peer/notes.mjs';
import { markMine, noteTheirs } from '../lib/peer/mine.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import { createInvite, redeemCode } from '../lib/peer/invite.mjs';
import { head } from '../lib/peer/roster.mjs';
import { peerFile } from '../lib/peer/paths.mjs';
import { BINDING } from '../lib/peer/a2a.mjs';
import { PeerDaemon } from '../lib/peer/daemon.mjs';

// The owner's two computers, a laptop and a devbox, on one team and marked as his on both.
function ownComputers(t) {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'ana' });
  const laptop = { ...team.founder, key: team.founder.identity.key, name: 'laptop' }, devbox = { ...team.member, key: team.member.identity.key, name: 'devbox' };
  for (const [side, other] of [[laptop, devbox], [devbox, laptop]]) withHome(side.home, () => { markMine(side.key, other.key); noteTheirs(other.key, true); });
  return { team, laptop, devbox };
}
// One look on side: what it has, put together with what the other said, and what it sends to it.
const look = (side, other, now) => withHome(side.home, () => notesRows(other.key, notesTick({ me: side.key, now, who: () => `@${other.name}` })));
// The two computers talking: each sends what it has, the other takes it and puts it together.
function talk(a, b, now = Date.now()) {
  for (let round = 0; round < 2; round++) {
    const toB = look(a, b, now); withHome(b.home, () => takeNotes(b.key, a.key, toB));
    const toA = look(b, a, now); withHome(a.home, () => takeNotes(a.key, b.key, toA));
  }
  look(a, b, now);
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

test('two computers of the owner with the same project in different folders: linked once, a lesson on one is in the next prompt on the other, an edit on the other is on the first, and a line taken out stays out', t => {
  const { laptop, devbox } = ownComputers(t);
  const mac = on(laptop, () => registeredProject(t)), box = on(devbox, () => registeredProject(t));
  assert.notEqual(mac.root, box.root);
  on(laptop, () => saveInstructions(mac.root, 'Use pnpm, not npm.'));
  talk(laptop, devbox);
  // Not linked yet: no shared repository, so nothing moves; the project of the same name is offered.
  assert.equal(on(devbox, () => readProjectSettings(box.root).instructions), '');
  const offered = on(laptop, () => projectLinks(mac.root));
  assert.deepEqual(offered.map(row => [row.key, row.older, row.linked, row.same?.name]), [[devbox.key, false, null, 'sample app']]);
  on(laptop, () => linkProject(mac.root, devbox.key, offered[0].same.id));
  talk(laptop, devbox);
  // Linked on both, from the one link made on the laptop.
  assert.equal(on(devbox, () => projectLinks(box.root))[0].linked.name, 'sample app');
  assert.equal(on(devbox, () => readProjectSettings(box.root).instructions), 'Use pnpm, not npm.\n');
  assert.deepEqual(on(devbox, () => pendingTrust(box.root)), [], 'his own text from his own computer is not asked about');
  // A lesson the laptop's session learned.
  on(laptop, () => saveLearned(mac.root, { add: ['Deploys go through staging first.'], remove: [] }));
  talk(laptop, devbox);
  const line = `- ${today()}: Deploys go through staging first.`;
  assert.ok(on(devbox, () => readProjectSettings(box.root).context).includes(line));
  assert.ok(on(devbox, () => projectPromptParts(box.root)).some(part => part.includes(line)), "the devbox's next turn reads it");
  // Instructions edited on the devbox reach the laptop, approved there as his.
  on(devbox, () => saveInstructions(box.root, 'Use pnpm, not npm. Run the tests before a push.'));
  talk(laptop, devbox);
  assert.equal(on(laptop, () => readProjectSettings(mac.root).instructions), 'Use pnpm, not npm. Run the tests before a push.\n');
  assert.deepEqual(on(laptop, () => pendingTrust(mac.root)), []);
  // The devbox takes the lesson out: it goes on the laptop too, and does not come back.
  on(devbox, () => saveLearned(box.root, { add: [], remove: [line] }));
  talk(laptop, devbox); talk(laptop, devbox);
  for (const [side, root] of [[laptop, mac.root], [devbox, box.root]]) assert.ok(!on(side, () => readProjectSettings(root).context).includes('staging'), side.name);
  // Unlinked: a change no longer moves.
  on(devbox, () => linkProject(box.root, laptop.key, null));
  talk(laptop, devbox);
  on(laptop, () => saveInstructions(mac.root, 'Only on the laptop.'));
  talk(laptop, devbox);
  assert.equal(on(devbox, () => readProjectSettings(box.root).instructions), 'Use pnpm, not npm. Run the tests before a push.\n');
  assert.equal(on(laptop, () => projectLinks(mac.root))[0].linked, null);
});

test('a project of the same repository is linked by itself; when both computers changed its text the newer wins, and the other is kept in its history and said once', t => {
  const { laptop, devbox } = ownComputers(t), origin = 'https://example.invalid/acme/app.git', base = Date.now(), at = n => base + n * 1000;
  const mac = on(laptop, () => registeredProject(t, { origin })), box = on(devbox, () => registeredProject(t, { origin }));
  talk(laptop, devbox, at(1));
  assert.equal(on(laptop, () => projectLinks(mac.root))[0].linked.name, 'sample app');
  // Both change the instructions while apart: the laptop first, the devbox later.
  on(laptop, () => saveInstructions(mac.root, 'Laptop rules.')); look(laptop, devbox, at(2));
  on(devbox, () => saveInstructions(box.root, 'Devbox rules.')); look(devbox, laptop, at(3));
  talk(laptop, devbox, at(4));
  for (const [side, root] of [[laptop, mac.root], [devbox, box.root]]) assert.equal(on(side, () => readProjectSettings(root).instructions), 'Devbox rules.\n', side.name);
  const history = path.join(mac.root, '.elu-code', 'history'), kept = fs.readdirSync(history).filter(name => name.endsWith('.md'));
  assert.equal(kept.length, 1); assert.match(kept[0], /^instructions-\d{4}-\d{2}-\d{2}-\d{6}\.md$/);
  assert.equal(fs.readFileSync(path.join(history, kept[0]), 'utf8'), 'Laptop rules.\n');
  assert.equal(fs.readFileSync(path.join(history, '.gitignore'), 'utf8'), '*\n', 'Git leaves the history alone');
  const said = on(laptop, () => notesSaid());
  assert.deepEqual(said.map(row => row.text), [`Instructions of sample app changed here and on @devbox: the newer, from @devbox, is in use. The other is in ${path.join(history, kept[0])}.`]);
  // Said once: the next looks add nothing.
  talk(laptop, devbox, at(5)); assert.equal(on(laptop, () => notesSaid()).length, 1);
  // The learned lines are a set: a line from each computer is on both.
  on(laptop, () => saveLearned(mac.root, { add: ['Laptop lesson.'], remove: [] })); on(devbox, () => saveLearned(box.root, { add: ['Devbox lesson.'], remove: [] }));
  talk(laptop, devbox, at(6));
  for (const [side, root] of [[laptop, mac.root], [devbox, box.root]]) assert.deepEqual(on(side, () => splitContext(readProjectSettings(root).context).learned.map(row => row.line.replace(/^- \S+ /, ''))).sort(), ['Devbox lesson.', 'Laptop lesson.'], side.name);
});

test("a file Git changed from a teammate still waits for his review: his own computer's text is the one in force, and the teammate's is never sent on", t => {
  const { laptop, devbox } = ownComputers(t), origin = 'https://example.invalid/acme/app.git';
  const mac = on(laptop, () => registeredProject(t, { origin })), box = on(devbox, () => registeredProject(t, { origin }));
  on(devbox, () => ensureTrustStore());
  on(laptop, () => saveInstructions(mac.root, 'Old rules.'));
  talk(laptop, devbox, 1000);
  assert.equal(on(devbox, () => readProjectSettings(box.root).instructions), 'Old rules.\n');
  // A pull brings a teammate's change of the file to the devbox.
  const file = path.join(box.root, '.elu-code', 'instructions.md');
  fs.writeFileSync(file, 'A teammate wrote this.\n');
  assert.deepEqual(on(devbox, () => pendingTrust(box.root)).map(row => row.name), ['instructions.md']);
  on(laptop, () => saveInstructions(mac.root, 'New rules from the laptop.'));
  talk(laptop, devbox, 2000);
  assert.equal(fs.readFileSync(file, 'utf8'), 'A teammate wrote this.\n', 'the file is not written over');
  assert.deepEqual(on(devbox, () => pendingTrust(box.root)).map(row => row.name), ['instructions.md'], 'and still asked about');
  assert.equal(on(devbox, () => readProjectSettings(box.root).instructions), 'New rules from the laptop.\n');
  assert.equal(on(laptop, () => readProjectSettings(mac.root).instructions), 'New rules from the laptop.\n', "the teammate's text never reached the laptop");
});

test('only the owner\'s own computers are sent instructions and context, a teammate\'s is sent none and nothing from one is taken, and one on an older ELU is named', t => {
  const { team, laptop, devbox } = ownComputers(t), sara = withHome(newHome(t), () => createIdentity({ name: 'sara' }));
  on(laptop, () => redeemCode(createInvite(laptop.identity, team.teamId, { hours: 1 }), sara.key, 'sara'));
  const mac = on(laptop, () => registeredProject(t)), box = on(devbox, () => registeredProject(t));
  on(laptop, () => saveInstructions(mac.root, 'Use pnpm, not npm.'));
  on(laptop, () => {
    const daemon = Object.assign(new PeerDaemon({ conductor: () => {} }), { me: laptop.identity, node: { dial() {}, leave() {} } }); daemon.methods = daemon.extensions();
    assert.equal(daemon.hello(devbox.key).notes, 1, 'this build says in its hello that it shares them');
    const connect = (key, extra) => {
      const wire = { out: '' }, socket = Object.assign(new EventEmitter(), { destroyed: false, destroy() { this.destroyed = true; this.emit('close'); }, write: chunk => { wire.out += chunk; return true; } });
      daemon.attach(socket, key);
      socket.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'elu.hello', params: { binding: BINDING, a2aVersion: '1.0', name: 'ana', teams: [{ id: team.teamId, ...head(team.teamId), ops: [] }], handles: [], ...extra } })}\n`));
      const frames = method => wire.out.split('\n').flatMap(line => { try { const frame = JSON.parse(line); return frame.method === method ? [frame] : []; } catch { return []; } });
      return { frames, say: frame => socket.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`)), close: () => socket.destroy() };
    };
    // The devbox, his: sent every project here, with its instructions.
    const toBox = connect(devbox.key, { plans: true, remote: 1, lists: 1, notes: 1 });
    const sent = joinRows(toBox.frames('elu.notes').at(-1)?.params.notes);
    assert.deepEqual(sent.map(row => [row.name, row.notes.instructions.text]), [['sample app', 'Use pnpm, not npm.\n']]);
    // What the devbox sends is taken: its project is offered for the link here.
    const rows = withHome(devbox.home, () => notesRows(laptop.key, notesTick({ me: devbox.key })));
    toBox.say({ method: 'elu.notes', params: { notes: rows } });
    assert.equal(projectLinks(mac.root)[0].same.name, 'sample app');
    // Sara, a teammate: sent nothing, and what she sends is not taken.
    const toSara = connect(sara.key, { plans: true, remote: 1, lists: 1, notes: 1 });
    daemon.tellNotes();
    assert.deepEqual(toSara.frames('elu.notes'), []);
    toSara.say({ method: 'elu.notes', params: { notes: rows } });
    assert.equal(fs.existsSync(peerFile('notes', 'from', `${sara.key}.json`)), false);
    assert.throws(() => takeNotes(laptop.key, sara.key, rows), { message: 'Only your own computers share instructions and context.' });
    // The devbox on a build from before this: it is sent none, and the app can say it needs an update.
    toBox.close();
    const older = connect(devbox.key, { plans: true, remote: 1, lists: 1 });
    daemon.tellNotes();
    assert.deepEqual(older.frames('elu.notes'), []);
    assert.equal(projectLinks(mac.root)[0].older, true);
    daemon.closed = true; clearInterval(daemon.timer);
  });
  void box;
});
