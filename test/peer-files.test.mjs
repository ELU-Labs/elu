import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { makeTeam, newHome, withHome, registeredProject, liveTask } from './peer-helpers.mjs';
import { hash } from '../lib/util.mjs';
import { markMine, noteTheirs } from '../lib/peer/mine.mjs';
import { FILES_UPDATE, NOT_MINE, hostMethods, remoteCommand, watchId } from '../lib/peer/remote.mjs';
import { saveTeamAccess } from '../lib/peer/access.mjs';
import { pendingRequests } from '../lib/workspace.mjs';
import { readTask } from '../lib/state.mjs';
import { repository } from '../lib/git.mjs';
import { offerFiles, offerPaths, stageFiles } from '../lib/peer/index.mjs';
import { BYTES_MAX, FILES_MAX, PIECE, collectFiles, inboxRoot, landFiles, namedPaths, pathsInText, pieces, stagedFiles, takePiece } from '../lib/peer/files.mjs';
import { remoteSessions as remoteGlue } from '../lib/terminal-remote.mjs';
import * as claude from '../lib/adapters/claude.mjs';
import { defaultConfig } from '../lib/config.mjs';
import { APPROVAL_SERVER, APPROVAL_TOOL } from '../lib/mcp.mjs';
import { serve, LIST_TOOL, SEND_TOOL, TOOL_NAME } from '../lib/approval-server.mjs';
import { answerApproval, pendingApprovals } from '../lib/approvals.mjs';
import { parseCommand } from '../lib/terminal-commands.mjs';

// Files from one computer of mine to a session on another (lib/peer/files.mjs, remote.mjs).
// The two daemons are joined by calls, each side's methods running in its own home, as in
// peer-remote.test.mjs. The inbox lies in the home folder, so the home is a temporary one.
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-files-home-')));
const before = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };
process.env.HOME = HOME; delete process.env.XDG_DATA_HOME;
after(() => { for (const [name, value] of Object.entries(before)) if (value === undefined) delete process.env[name]; else process.env[name] = value; fs.rmSync(HOME, { recursive: true, force: true }); });

function connection(key, hello = { remote: 1, files: 1 }) {
  const sent = [];
  return { key, admitted: true, remoteHello: hello, sent, notify: (method, params) => sent.push([method, params]), request: async () => { throw new Error('No answer'); } };
}
const context = (me, sessions = {}) => ({ me, session: key => sessions[key] ?? null, name: key => key.slice(0, 4), box: key => key === me.key ? null : 'mac', log: () => {}, kick: () => {}, soon: () => {}, event: () => {} });
// Ana's laptop (the viewer) and devbox (the host), marked as each other's on both sides, with
// a session (task 1) in the devbox's project of the team, followed from the laptop.
function pair(t) {
  const team = makeTeam(t, { founderName: 'ana', memberName: 'box' }), laptop = team.founder, devbox = team.member;
  const project = withHome(devbox.home, () => {
    const project = registeredProject(t); saveTeamAccess(team.teamId, { root: project.root });
    markMine(devbox.identity.key, laptop.identity.key); noteTheirs(laptop.identity.key, true);
    liveTask(project.root, { id: '1', goal: 'Look at the batch results', state: 'ready' });
    return project;
  });
  withHome(laptop.home, () => { markMine(laptop.identity.key, devbox.identity.key); noteTheirs(devbox.identity.key, true); });
  const toHost = connection(laptop.identity.key), toViewer = connection(devbox.identity.key);
  const hostCtx = context(devbox.identity, { [laptop.identity.key]: toHost }), viewCtx = context(laptop.identity, { [devbox.identity.key]: toViewer });
  const host = hostMethods(hostCtx), calls = [];
  toViewer.request = (method, params) => { calls.push([method, params]); return withHome(devbox.home, () => host[method](params, toHost)); };
  const ref = `${hash(`project\0${project.root}`).slice(0, 16)}:1`, id = watchId(laptop.identity.key, devbox.identity.key, ref);
  return { team, laptop, devbox, project, host, toHost, toViewer, viewCtx, hostCtx, calls, ref, id };
}
// A folder on the laptop to send: a file bigger than one piece, a nested file, an empty one,
// a .git folder and a link that leads out of it; and a key file beside it.
function batch(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-batch-'))); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'batch results');
  fs.mkdirSync(path.join(root, 'runs', 'b'), { recursive: true }); fs.mkdirSync(path.join(root, '.git'));
  const big = crypto.randomBytes(PIECE * 2 + 1234);
  fs.writeFileSync(path.join(root, 'results.bin'), big);
  fs.writeFileSync(path.join(root, 'runs', 'b', 'score.json'), '{"f1":0.83}\n');
  fs.writeFileSync(path.join(root, 'empty.txt'), '');
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'not in the folder');
  fs.symlinkSync(path.join(dir, 'outside.txt'), path.join(root, 'out-link'));
  fs.writeFileSync(path.join(dir, 'id_ed25519'), 'PRIVATE KEY');
  return { dir, root, big, key: path.join(dir, 'id_ed25519') };
}
const landedDir = text => /Files from @\S+: .* in (.+)$/m.exec(text)?.[1];
const requestsFor = root => pendingRequests(root).filter(row => row.continuationTaskId === '1');
const outgoing = () => { const dir = path.join(process.env.XDG_CONFIG_HOME, 'elu-code', 'peer', 'files', 'out'); return fs.existsSync(dir) ? fs.readdirSync(dir) : []; };

test('a typed message offers the files it names, and they land whole in the session inbox with its paths pointing there', async t => {
  const p = pair(t), b = batch(t);
  const text = `Use ${b.root.replaceAll(' ', '\\ ')} and the key ${b.key}.`;
  const offer = withHome(p.laptop.home, () => offerFiles(text));
  assert.equal(offer.count, 4); assert.equal(offer.keys, 1);
  assert.equal(offer.line, 'Send 4 files (1.4 MB), including 1 key file, leaving out 1 link or special file, from this computer with this message?');
  const files = withHome(p.laptop.home, () => stageFiles(offer));
  const result = await withHome(p.laptop.home, () => remoteCommand(p.viewCtx, { type: 'remoteFiles', id: p.id, to: p.devbox.identity.key, ref: p.ref, text, files }));
  assert.deepEqual(result, { id: p.id, files: 4, bytes: b.big.length + 12 + 'PRIVATE KEY'.length });
  // Sent in pieces of at most 700 KiB, each its own request, the message on the last.
  const sent = p.calls.filter(([method]) => method === 'elu.remote.files');
  assert.equal(sent.length, 3); assert.ok(sent.every(([, params]) => Buffer.from(params.data, 'base64').length <= PIECE));
  assert.deepEqual(sent.map(([, params]) => [params.seq, params.last, 'text' in params]), [[0, false, false], [1, false, false], [2, true, true]]);
  // The copies for sending are gone once sent.
  withHome(p.laptop.home, () => assert.deepEqual(outgoing(), []));
  const inbox = withHome(p.devbox.home, () => {
    const [request] = requestsFor(p.project.root);
    const dir = landedDir(request.goal), inbox = path.dirname(dir);
    assert.ok(dir.startsWith(inboxRoot()), 'in the inbox'); assert.ok(dir.startsWith(HOME), 'in the home folder');
    assert.equal(path.basename(inbox), p.ref.replace(':', '-'));
    assert.match(request.goal, /^Use ".*batch results" and the key .*id_ed25519\.\n\nFiles from @mac: 4 files \(1\.4 MB\) in /);
    assert.ok(!request.goal.includes(b.dir), 'the laptop paths are gone from the text');
    assert.ok(request.goal.includes(path.join(dir, 'batch results')) && request.goal.includes(path.join(dir, 'id_ed25519')));
    assert.deepEqual(fs.readFileSync(path.join(dir, 'batch results', 'results.bin')), b.big);
    assert.equal(fs.readFileSync(path.join(dir, 'batch results', 'runs', 'b', 'score.json'), 'utf8'), '{"f1":0.83}\n');
    assert.equal(fs.readFileSync(path.join(dir, 'batch results', 'empty.txt'), 'utf8'), '');
    assert.equal(fs.existsSync(path.join(dir, 'batch results', '.git')), false, '.git is left out');
    assert.equal(fs.existsSync(path.join(dir, 'batch results', 'out-link')), false, 'a link out of the folder is not followed');
    assert.equal(fs.statSync(path.join(dir, 'id_ed25519')).mode & 0o777, 0o600);
    // Outside any Git work tree, and outside the project and its worktrees.
    assert.notEqual(spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).stdout.trim(), 'true');
    const repo = repository(p.project.root), task = readTask(repo, '1');
    assert.ok(!dir.startsWith(p.project.root) && !dir.startsWith(repo.worktrees));
    // The session may read its inbox: it is one of its folders, which Ask for approval reads (--add-dir).
    assert.deepEqual(task.folders, [inbox]);
    const args = claude.compile({ role: { ...defaultConfig().roles.lead }, mode: 'ask', folders: task.folders, cwd: task.worktree, protectedPaths: ['.git'], commonDir: repo.common, session: crypto.randomUUID(), approval: { tool: APPROVAL_TOOL }, mcp: { file: path.join(os.tmpdir(), 'mcp.json'), names: [APPROVAL_SERVER] } });
    assert.equal(args[args.indexOf(inbox) - 1], '--add-dir');
    return inbox;
  });
  // A second send goes to its own folder in the same inbox, which stays listed once.
  const again = withHome(p.laptop.home, () => stageFiles(offerPaths([b.key])));
  await withHome(p.laptop.home, () => remoteCommand(p.viewCtx, { type: 'remoteFiles', id: p.id, to: p.devbox.identity.key, ref: p.ref, text: '', files: again }));
  withHome(p.devbox.home, () => {
    const requests = requestsFor(p.project.root);
    assert.match(requests.at(-1).goal, /^Files from @mac: 1 file \(1 KB\) in /);
    assert.notEqual(landedDir(requests.at(-1).goal), landedDir(requests[0].goal));
    assert.equal(path.dirname(landedDir(requests.at(-1).goal)), inbox);
    assert.deepEqual(readTask(repository(p.project.root), '1').folders, [inbox]);
  });
});

test('every file is checked against its SHA-256, and a piece out of order or a send of the wrong size is refused', t => {
  const p = pair(t), b = batch(t);
  const staged = withHome(p.laptop.home, () => stagedFiles(stageFiles(offerPaths([path.join(b.root, 'results.bin')]))));
  const parts = withHome(p.laptop.home, () => [...pieces(staged)]);
  assert.equal(parts.length, 3);
  let SEND = crypto.randomUUID();
  const params = (seq, data = parts[seq], extra = {}) => ({ id: p.id, send: SEND, seq, last: seq === parts.length - 1, size: staged.total, data: data.toString('base64'), ...(seq === parts.length - 1 ? { text: '' } : {}), ...extra });
  withHome(p.devbox.home, () => {
    p.host['elu.remote.watch']({ ref: p.ref }, p.toHost);
    // One byte changed on the way: the file is not kept, and nothing reaches the session.
    const bad = Buffer.from(parts.at(-1)); bad[bad.length - 1] ^= 1;
    p.host['elu.remote.files'](params(0), p.toHost); p.host['elu.remote.files'](params(1), p.toHost);
    assert.throws(() => p.host['elu.remote.files'](params(2, bad), p.toHost), { message: 'results.bin did not arrive whole. Send it again.' });
    assert.deepEqual(requestsFor(p.project.root), []);
    // Out of order, and a last piece that does not end the stream.
    SEND = crypto.randomUUID();
    assert.throws(() => p.host['elu.remote.files'](params(1), p.toHost), /out of order/);
    assert.throws(() => p.host['elu.remote.files'](params(0, parts[0], { size: staged.total + 1, last: true, text: '' }), p.toHost), /not the size it said/);
    // A piece sent again, its answer lost, is taken once; the last sent again answers as before.
    SEND = crypto.randomUUID();
    p.host['elu.remote.files'](params(0), p.toHost); p.host['elu.remote.files'](params(1), p.toHost); p.host['elu.remote.files'](params(1), p.toHost);
    const done = p.host['elu.remote.files'](params(2), p.toHost);
    assert.equal(done.files, 1); assert.deepEqual(p.host['elu.remote.files'](params(2), p.toHost), done);
    assert.equal(requestsFor(p.project.root).length, 1);
    assert.deepEqual(fs.readFileSync(path.join(done.dir, 'results.bin')), b.big);
  });
});

// A stream made by hand, as a build that does not check its names could send it.
function land(list, bodies = []) {
  const stream = Buffer.concat([Buffer.from(`${JSON.stringify(list)}\n`), ...bodies]), send = crypto.randomUUID();
  const piece = takePiece('f'.repeat(64), { send, seq: 0, last: true, size: stream.length, data: stream.toString('base64') });
  return landFiles(piece.file, piece.size, path.join(path.dirname(process.env.XDG_CONFIG_HOME), 'landed', send));
}

test('caps: 5000 files and 200 MB a send, on both sides', t => {
  const home = newHome(t), dir = path.dirname(home);
  const many = path.join(dir, 'many'); fs.mkdirSync(many);
  for (let n = 0; n <= FILES_MAX; n++) fs.writeFileSync(path.join(many, `${n}.txt`), '');
  withHome(home, () => assert.throws(() => collectFiles(namedPaths([many])), { message: 'That is more than 5,000 files; a send carries up to 5,000 files. Name fewer.' }));
  const huge = path.join(dir, 'huge.bin'); fs.writeFileSync(huge, ''); fs.truncateSync(huge, BYTES_MAX + 1);
  withHome(home, () => assert.throws(() => collectFiles(namedPaths([huge])), { message: 'That is more than 200 MB; a send carries up to 200 MB. Name fewer files.' }));
  // Over a cap, the typed message is not held up: the line says why, and the text can go alone.
  withHome(home, () => assert.equal(offerFiles(`see ${huge}`).refused, 'That is more than 200 MB; a send carries up to 200 MB. Name fewer files.'));
  // The host checks the list again, whatever the sender's build counted.
  withHome(home, () => {
    const files = Array.from({ length: FILES_MAX + 1 }, (_, n) => ({ path: `a/${n}`, size: 0, sha256: hash('') }));
    assert.throws(() => land({ items: [{ name: 'a' }], files }), { message: 'A send carries up to 5,000 files.' });
    assert.throws(() => land({ items: [{ name: 'a' }], files: [{ path: 'a/b', size: BYTES_MAX + 1, sha256: hash('') }] }), { message: 'A send carries up to 200 MB.' });
    assert.throws(() => takePiece('f'.repeat(64), { send: crypto.randomUUID(), seq: 0, last: false, size: BYTES_MAX * 2, data: '' }), { message: 'A send carries up to 200 MB.' });
  });
});

test('a name that is not a plain relative path is refused, and nothing is written outside the folder', t => {
  const home = newHome(t), base = path.dirname(home), body = Buffer.from('x'), sum = hash(body);
  withHome(home, () => {
    for (const bad of ['../escape', '/etc/passwd', 'a/../../escape', 'a/./b', 'a//b', 'a/.git/config', 'a\\b', 'a/\u0007bell', '']) {
      const items = [{ name: bad.split('/')[0] || 'a' }];
      assert.throws(() => land({ items, files: [{ path: bad, size: 1, sha256: sum }] }, [body]), /can't be used here/, bad);
    }
    assert.throws(() => land({ items: [{ name: 'a' }], files: [{ path: 'a/X', size: 1, sha256: sum }, { path: 'a/x', size: 1, sha256: sum }] }, [body, body]), /named twice/);
    assert.throws(() => land({ items: [{ name: 'a' }], files: [{ path: 'a', size: 1, sha256: sum }, { path: 'a/b', size: 1, sha256: sum }] }, [body, body]), /a file and a folder at once/);
    assert.equal(fs.existsSync(path.join(base, 'escape')), false);
    assert.deepEqual(fs.existsSync(path.join(base, 'landed')) ? fs.readdirSync(path.join(base, 'landed')) : [], [], 'nothing stays after a refusal');
    assert.equal(land({ items: [{ name: 'a' }], files: [{ path: 'a/b/c.txt', size: 1, sha256: sum }] }, [body]).count, 1);
  });
  // The sender never sends a link out of the folder, nor anything that is not a file.
  const folder = path.join(base, 'odd'); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'ok.txt'), 'ok'); fs.symlinkSync('/etc/hosts', path.join(folder, 'hosts'));
  withHome(home, () => { const found = collectFiles(namedPaths([folder])); assert.deepEqual(found.files.map(row => row.path), ['odd/ok.txt']); assert.equal(found.skipped, 1); });
});

test('only a computer that is mine on both sides may send, and an older host is told to update', async t => {
  const p = pair(t), b = batch(t);
  const piece = () => ({ id: p.id, send: crypto.randomUUID(), seq: 0, last: true, size: 1, data: 'eA==', text: '' });
  // A teammate's key, or a computer marked on one side only, is refused before any piece is taken.
  withHome(p.devbox.home, () => assert.throws(() => p.host['elu.remote.files'](piece(), connection('e'.repeat(64))), { message: NOT_MINE }));
  withHome(p.devbox.home, () => noteTheirs(p.laptop.identity.key, false));
  withHome(p.devbox.home, () => assert.throws(() => p.host['elu.remote.files'](piece(), p.toHost), { message: NOT_MINE }));
  withHome(p.devbox.home, () => noteTheirs(p.laptop.identity.key, true));
  const files = () => withHome(p.laptop.home, () => stageFiles(offerPaths([b.key])));
  const sendIt = () => withHome(p.laptop.home, () => remoteCommand(p.viewCtx, { type: 'remoteFiles', id: p.id, to: p.devbox.identity.key, ref: p.ref, text: '', files: files() }));
  // A host whose hello says nothing of files: nothing is sent.
  p.toViewer.remoteHello = { remote: 1 };
  await assert.rejects(sendIt(), { message: FILES_UPDATE('@mac') });
  assert.equal(FILES_UPDATE('@mac'), '@mac needs to update ELU Code to receive files.');
  assert.equal(p.calls.filter(([method]) => method === 'elu.remote.files').length, 0);
  // One that does not know the method answers Method not found: the same line.
  p.toViewer.remoteHello = { remote: 1, files: 1 };
  const request = p.toViewer.request;
  p.toViewer.request = (method, params) => { if (method !== 'elu.remote.files') return request(method, params); const error = new Error('Method not found'); error.details = { rpc: { code: -32601 } }; throw error; };
  await assert.rejects(sendIt(), { message: '@mac needs to update ELU Code to receive files.' });
  // The copies for sending go either way.
  withHome(p.laptop.home, () => assert.deepEqual(outgoing(), []));
});

test('the message box offers the files a message names: y sends them with it, n sends the text alone, and /send sends files alone', async t => {
  const home = newHome(t), b = batch(t), commands = [], asked = [];
  const status = { running: true, key: 'k'.repeat(64), name: 'ana', box: 'laptop', teams: [{ members: [{ key: 'k'.repeat(64), name: 'ana' }, { key: 'd'.repeat(64), name: 'ana', box: 'devbox', online: true }] }] };
  const facade = { mineRows: () => [{ key: 'd'.repeat(64), mine: true, theirs: true }], remoteSessions: () => [], offerFiles, offerPaths, stageFiles };
  const glue = remoteGlue({ facade, peerRead: () => status, peerCommand: async (command, options) => { commands.push([command, options]); return command.type === 'remoteFiles' ? { id: command.id, files: command.files.count, bytes: command.files.bytes } : {}; }, chatMessage: ({ text }) => text, ink: text => text, colour: false });
  const row = { id: crypto.randomUUID(), machine: 'devbox', ref: null };
  const answer = yes => ({ confirm: async line => { asked.push(line); return yes; }, sending: () => {} });
  await withHome(home, async () => {
    // y: the files go with the message.
    assert.equal(await glue.send(row, `Here is the key: ${b.key}`, answer(true)), 'Sent 1 file to the session on @devbox.');
    assert.equal(asked.at(-1), 'Send 1 file (1 KB), including 1 key file, from this computer with this message?');
    const [command, options] = commands.at(-1);
    assert.equal(command.type, 'remoteFiles'); assert.equal(command.text, `Here is the key: ${b.key}`); assert.equal(command.files.count, 1); assert.ok(options.timeoutMs >= 60000);
    // n: the text alone, as before.
    assert.equal(await glue.send(row, `Here is the key: ${b.key}`, answer(false)), 'Sent to the session on @devbox.');
    assert.deepEqual(commands.at(-1)[0], { type: 'remoteSend', id: row.id, text: `Here is the key: ${b.key}` });
    // A message that names nothing here is not asked about.
    const count = asked.length;
    await glue.send(row, 'And the tests in /no/such/folder', answer(true));
    assert.equal(asked.length, count); assert.equal(commands.at(-1)[0].type, 'remoteSend');
    // /send PATH: the files alone, after the same line without "with this message".
    assert.equal(await glue.sendPaths(row, [b.key], answer(true)), 'Sent 1 file to the session on @devbox.');
    assert.equal(asked.at(-1), 'Send 1 file (1 KB), including 1 key file, from this computer?');
    assert.equal(commands.at(-1)[0].text, '');
    const sends = commands.length;
    assert.equal(await glue.sendPaths(row, [b.key], answer(false)), 'Nothing was sent.');
    assert.equal(commands.length, sends, 'nothing more went');
    // Over a limit the line says why; n keeps the message, y sends the text alone.
    const huge = path.join(b.dir, 'huge.bin'); fs.writeFileSync(huge, ''); fs.truncateSync(huge, BYTES_MAX + 1);
    await assert.rejects(glue.send(row, `see ${huge}`, answer(false)), { message: 'Nothing was sent. The message is still here.' });
    assert.equal(asked.at(-1), 'That is more than 200 MB; a send carries up to 200 MB. Name fewer files. Send the text only?');
    assert.equal(await glue.send(row, `see ${huge}`, answer(true)), 'Sent to the session on @devbox.');
  });
  // A dropped path, its spaces escaped, and a quoted one are found; one that is not here is not.
  const dropped = `look at ${b.root.replaceAll(' ', '\\ ')}, then '${b.key}' and /nowhere/at/all`;
  assert.deepEqual(pathsInText(dropped).map(row => row.path), [b.root, b.key]);
  assert.deepEqual(parseCommand(`/send ${b.root.replaceAll(' ', '\\ ')} ~/x`).args, [b.root, '~/x']);
});

// The relay as Claude Code starts it for one of the owner's own sessions, driven in process.
function relay(t, argv) {
  const input = new PassThrough(), output = new PassThrough(), rows = [], waiting = [];
  let buffer = '';
  output.on('data', chunk => { buffer += chunk; let index; while ((index = buffer.indexOf('\n')) >= 0) { rows.push(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1); waiting.splice(0).forEach(resolve => resolve()); } });
  const done = serve({ argv, input, output });
  t.after(() => { input.end(); return done; });
  return { send: value => input.write(`${JSON.stringify(value)}\n`), next: async predicate => { for (;;) { const row = rows.find(predicate); if (row) return row; await new Promise(resolve => waiting.push(resolve)); } } };
}

test("a session's tool sends only what the session may read, lists only my computers, and in Ask for approval the owner answers the send", async t => {
  const p = pair(t), b = batch(t);
  fs.mkdirSync(path.join(HOME, '.ssh'), { recursive: true }); fs.writeFileSync(path.join(HOME, '.ssh', 'id_ed25519'), 'PRIVATE KEY');
  await withHome(p.laptop.home, async () => {
    const project = registeredProject(t), env = process.env.XDG_CONFIG_HOME;
    fs.writeFileSync(path.join(project.root, '.env'), 'TOKEN=1\n');
    fs.writeFileSync(path.join(project.root, 'notes.txt'), 'notes\n');
    const argv = mode => ['--session', `s-${mode}`, '--root', project.root, '--task', '3', '--role', 'lead', '--vendor', 'claude', '--log', path.join(path.dirname(env), `${mode}.jsonl`), '--wait', '600', '--cwd', project.root, '--access', 'edit', '--rules', 'saved', '--sandboxed', 'no', '--mode', mode, '--folders', '[]'];
    const server = relay(t, argv('auto'));
    server.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.deepEqual((await server.next(row => row.id === 1)).result.tools.map(tool => tool.name), [TOOL_NAME, LIST_TOOL, SEND_TOOL]);
    const call = async (id, name, args) => { server.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }); return (await server.next(row => row.id === id)).result; };
    // An untracked .env in the workspace, ELU Code's own state and a secret folder of the home: refused, nothing staged.
    for (const [n, file, why] of [[2, path.join(project.root, '.env'), /may hold a secret and Git does not track it/], [3, path.join(env, 'elu-code'), /ELU Code's own state/], [4, path.join(HOME, '.ssh', 'id_ed25519'), /in a folder this session may not read/]]) {
      const said = await call(n, SEND_TOOL, { session: p.id, paths: [file], message: 'x' });
      assert.equal(said.isError, true, file); assert.match(said.content[0].text, why, file);
    }
    // A folder that holds one is refused whole.
    let said = await call(5, SEND_TOOL, { session: p.id, paths: [project.root], message: 'x' });
    assert.equal(said.isError, true); assert.match(said.content[0].text, /\.env may hold a secret/);
    // Approve for me reads only the session's folders.
    said = await call(6, SEND_TOOL, { session: p.id, paths: [b.key], message: 'x' });
    assert.equal(said.isError, true); assert.match(said.content[0].text, /outside the folders this session reads/);
    assert.deepEqual(outgoing(), []);
    // The list names my other computer and its sessions; an id that is none of them is refused.
    const machines = path.join(env, 'elu-code', 'peer', 'remote', 'machines'); fs.mkdirSync(machines, { recursive: true });
    fs.writeFileSync(path.join(machines, `${p.devbox.identity.key}.json`), JSON.stringify({ key: p.devbox.identity.key, listedAt: new Date().toISOString(), projects: [{ id: p.ref.split(':')[0], name: 'shop', repoId: null, home: false }], sessions: [{ id: p.id, ref: p.ref, project: p.ref.split(':')[0], title: 'Look at the batch results', state: 'needs_input', question: 'Where are the batch results?', approvals: [], by: 'you' }] }));
    said = await call(7, LIST_TOOL, {});
    const listed = JSON.parse(said.content[0].text);
    assert.equal(listed.computers.length, 1);
    assert.deepEqual(listed.computers[0].sessions, [{ session: p.id, title: 'Look at the batch results', state: 'needs_input', project: 'shop', waits: 'question: Where are the batch results?' }]);
    said = await call(8, SEND_TOOL, { session: crypto.randomUUID(), paths: [path.join(project.root, 'notes.txt')] });
    assert.match(said.content[0].text, /No session on your other computers has that id/);
    // The session is there, but this computer's daemon is not running: nothing is staged.
    said = await call(9, SEND_TOOL, { session: p.id, paths: [path.join(project.root, 'notes.txt')] });
    assert.equal(said.isError, true); assert.match(said.content[0].text, /offline|not running/);
    assert.deepEqual(outgoing(), []);
    // Marked on one side only: nothing is listed.
    noteTheirs(p.devbox.identity.key, false);
    said = await call(10, LIST_TOOL, {});
    assert.match(said.content[0].text, /No other computer of yours is paired with this one/);
    noteTheirs(p.devbox.identity.key, true);
    // In Ask for approval the owner is asked about a send, with its paths; the list is answered at once.
    const ask = relay(t, argv('ask'));
    ask.send({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: TOOL_NAME, arguments: { tool_name: `mcp__${APPROVAL_SERVER}__${LIST_TOOL}`, input: {}, tool_use_id: 'list' } } });
    assert.equal(JSON.parse((await ask.next(row => row.id === 20)).result.content[0].text).behavior, 'allow');
    ask.send({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: TOOL_NAME, arguments: { tool_name: `mcp__${APPROVAL_SERVER}__${SEND_TOOL}`, input: { session: p.id, paths: [b.key], message: 'the key' }, tool_use_id: 'send' } } });
    for (let n = 0; n < 250 && !pendingApprovals().length; n++) await new Promise(resolve => setTimeout(resolve, 20));
    const [pending] = pendingApprovals();
    assert.equal(pending.title, `Send to a session on another computer of yours: ${b.key}`);
    answerApproval(pending.id, 'deny');
    assert.equal(JSON.parse((await ask.next(row => row.id === 21)).result.content[0].text).behavior, 'deny');
    // A session without the owner's saved rules (a teammate's question) gets no such tools.
    const theirs = relay(t, argv('ask').map(value => value === 'saved' ? 'defaults' : value));
    theirs.send({ jsonrpc: '2.0', id: 30, method: 'tools/list' });
    assert.deepEqual((await theirs.next(row => row.id === 30)).result.tools.map(tool => tool.name), [TOOL_NAME]);
  });
});
