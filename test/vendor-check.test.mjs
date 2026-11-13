import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { temp, fakeClis } from './helpers.mjs';
import * as agy from '../lib/adapters/agy.mjs';
import * as grok from '../lib/adapters/grok.mjs';
import { checkOnFirstUse, notSignedInText, readSignInsBeforeCheck, withCheck } from '../lib/vendor-check.mjs';
import { watchSignIn } from '../lib/sign-in-watch.mjs';
import { conformanceState } from '../lib/conformance.mjs';
import { detect } from '../lib/detect.mjs';
import { personalDirectory, savedSignIn, usageTab } from '../lib/usage.mjs';
import { usageBlocks } from '../lib/terminal.mjs';
import { systemTemp } from '../lib/util.mjs';

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// The folders as macOS has them: TMPDIR is /var/folders/…/T/ and ends with a slash, /var is a
// link to /private/var, /tmp is a link to /private/tmp, and the home folder is under no link.
function linkedTemp(root) {
  fs.mkdirSync(path.join(root, 'private', 'var', 'folders', 'xy', 'T'), { recursive: true });
  fs.symlinkSync(path.join(root, 'private', 'var'), path.join(root, 'var'));
  fs.mkdirSync(path.join(root, 'private', 'tmp')); fs.symlinkSync(path.join(root, 'private', 'tmp'), path.join(root, 'tmp'));
  return `${path.join(root, 'var', 'folders', 'xy', 'T')}${path.sep}`;
}
// The fake CLIs on PATH, the owner's home with a Grok Build token, ELU's state, and openers
// on PATH that record each link they are asked to open: a browser that opened.
function machine(t, { agy: agyConfig = {}, grok: grokConfig = undefined } = {}) {
  const root = temp(t), home = path.join(root, 'home'); fs.mkdirSync(path.join(home, '.grok'), { recursive: true });
  fs.writeFileSync(path.join(home, '.grok', 'auth.json'), '{"token":"never-read"}\n', { mode: 0o600 });
  const fake = fakeClis(root), config = path.join(fake.dir, 'fake.json');
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, 'utf8')), agy: agyConfig, grok: grokConfig }));
  const openers = path.join(root, 'openers'), opened = path.join(root, 'opened.log'); fs.mkdirSync(openers);
  for (const name of ['open', 'xdg-open']) fs.writeFileSync(path.join(openers, name), `#!/bin/sh\necho "$@" >> ${JSON.stringify(opened)}\n`, { mode: 0o755 });
  const env = { ...process.env, ...fake.env, PATH: `${fake.env.PATH}${path.delimiter}${openers}`, HOME: home };
  environment(t, { XDG_CONFIG_HOME: fake.env.XDG_CONFIG_HOME });
  const row = async vendor => (await detect(home, env, { only: vendor }))[0];
  return { root, home, fake, env, row, opened: () => fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8').trim().split('\n') : [] };
}
// The longest the event loop went without running a timer while fn ran: what the screen froze for.
async function held(fn) {
  let last = Date.now(), most = 0;
  const timer = setInterval(() => { const now = Date.now(); most = Math.max(most, now - last); last = now; }, 10);
  const started = Date.now();
  try { const value = await fn(); return { value, most: Math.max(most, Date.now() - last), took: Date.now() - started }; }
  finally { clearInterval(timer); }
}

test('the one-time check runs when the temp folder is under a link, as macOS\'s /var is: Grok Build and Antigravity CLI pass', { timeout: 120000 }, async t => {
  const m = machine(t), tmp = linkedTemp(m.root);
  environment(t, { TMPDIR: tmp });
  assert.equal(tmp.endsWith(path.sep), true); assert.equal(`${os.tmpdir()}${path.sep}`, tmp); assert.equal(fs.lstatSync(path.join(m.root, 'var')).isSymbolicLink(), true);
  assert.equal(systemTemp(), path.join(m.root, 'private', 'var', 'folders', 'xy', 'T'));
  assert.equal(fs.realpathSync(m.home), m.home, 'the home folder is under no link');
  // The vendors are given TMPDIR as the owner's shell has it, slash and link and all.
  m.env.TMPDIR = tmp;
  // Before: the check's folder was made under /var/folders/… as written, and its first step refused it.
  // One check starts from the home folder, as c in the Usage tab does, the other from a project
  // under /tmp named through the link, as a first message from there does.
  const project = path.join(m.root, 'tmp', 'project'); fs.mkdirSync(project);
  for (const [vendor, cwd] of [['grok', m.home], ['agy', project]]) {
    const said = [];
    assert.equal(await checkOnFirstUse(await m.row(vendor), { cwd, environment: m.env, say: text => said.push(text) }), true, vendor);
    assert.ok(!said.some(line => /symbolic link/.test(line)), said.join('\n'));
    assert.deepEqual(Object.entries(conformanceState(vendor).steps).filter(([, status]) => status !== 'pass').map(([id]) => id), [], vendor);
  }
  // Nothing is left in the temp folder.
  assert.deepEqual(fs.readdirSync(tmp).filter(name => /^elu-code-(check|signin|help)-/.test(name)), []);
});

test('Antigravity CLI signed out asks for a sign-in and waits a minute for a code: the Usage read, the check and detect say "not signed in for ELU" within seconds, open no browser, and never hold the app', { timeout: 120000 }, async t => {
  const m = machine(t, { agy: { signedIn: false, auth: 'prompt' } }), row = await m.row('agy');
  // The Usage tab's read, before the check: it was 30 silent seconds, then "did not say".
  const read = await held(() => readSignInsBeforeCheck([row], { env: m.env }));
  assert.ok(read.took < 15000, `the read took ${read.took} ms`);
  assert.equal(savedSignIn('agy').signedIn, false); assert.equal(savedSignIn('agy').reason, null);
  const tab = usageTab({ vendors: withCheck([{ vendor: 'claude', available: false }, { vendor: 'codex', available: false }, row, { vendor: 'grok', available: false }], { env: m.env }), env: m.env });
  assert.deepEqual(usageBlocks([tab[2]]).map(line => line.text), ['Antigravity not signed in for ELU · s signs in']);
  // c, or a first message to it: the check stops before it starts, at once, and says what to press.
  const check = await held(() => checkOnFirstUse(row, { cwd: m.home, environment: m.env }).then(() => null, error => error));
  assert.ok(check.value, 'the check refused');
  assert.equal(check.value.message, 'Antigravity CLI is not signed in for ELU. Sign it in with s on its line in the Usage tab.');
  assert.deepEqual([check.value.details.cause, check.value.details.signedIn], ['signin', false]);
  assert.ok(check.took < 15000, `the check took ${check.took} ms`); assert.ok(check.most < 3000, `the app was held ${check.most} ms`);
  assert.equal(conformanceState('agy'), null, 'no step ran');
  // detect() gets the same answer as fast, and the app is never held for it.
  const probe = await held(() => agy.signedIn({ bin: row.bin, cwd: m.home, env: m.env }));
  assert.equal(probe.value, false); assert.ok(probe.took < 15000, `the read took ${probe.took} ms`); assert.ok(probe.most < 3000, `the app was held ${probe.most} ms`);
  // No read opened a browser: the `open` agy runs is ELU's, which does nothing.
  assert.deepEqual(m.opened(), []);
  // s: agy's own sign-in, in the HOME every ELU run of agy shares, with the real PATH and the
  // terminal as its input. The browser opens; the owner pastes the code.
  const command = agy.signInTerminal({ env: m.env });
  assert.deepEqual(command.args, ['-p', '/usage']); assert.equal(command.env.HOME, path.join(personalDirectory(), 'agy-home', 'signin'));
  assert.ok(!command.env.PATH.includes(path.join('agy-home', 'no-browser')));
  const signIn = spawnSync(row.bin, command.args, { env: command.env, input: '4/0AeanS0b-fake-code\n', encoding: 'utf8' });
  assert.equal(signIn.status, 0, signIn.stderr);
  assert.match(signIn.stderr, /Authentication required\. Please visit the URL to log in:\n {2}https:\/\/accounts\.google\.com\/\S+\n\nWaiting for authentication \(timeout 60s\)\.\.\.\nOr, paste the authorization code here and press Enter:\nSigned in\./);
  assert.equal(m.opened().length, 1); assert.match(m.opened()[0], /^https:\/\/accounts\.google\.com\//);
  // Signed in now, for every HOME: the read says so and the check runs to the end.
  assert.deepEqual(await agy.readSignIn({ bin: row.bin, cwd: m.home, env: m.env }), { signedIn: true, reason: null });
  assert.equal(await checkOnFirstUse(row, { cwd: m.home, environment: m.env }), true);
  assert.deepEqual(Object.values(conformanceState('agy').steps).filter(status => status !== 'pass'), []);
});

test('a sign-in read that gets no answer says so after its time, one that is stopped says nothing, and neither leaves the program running', { timeout: 60000 }, async t => {
  const root = temp(t), marker = path.join(root, 'still-running');
  // A program that prints nothing and never ends, then would leave a mark.
  const silent = path.join(root, 'agy'); fs.writeFileSync(silent, `#!/bin/sh\nsleep 3\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  const quiet = await watchSignIn({ bin: silent, args: [], env: process.env, cwd: root, timeoutMs: 1000 });
  assert.deepEqual(quiet, { signedIn: null, reason: 'gave no answer within 1 seconds' });
  const stop = new AbortController(); setTimeout(() => stop.abort(), 200);
  assert.equal(await watchSignIn({ bin: silent, args: [], env: process.env, cwd: root, timeoutMs: 30000, signal: stop.signal }), undefined);
  await new Promise(resolve => setTimeout(resolve, 3500));
  assert.equal(fs.existsSync(marker), false, 'every run was stopped');
  // What the check says then: the reason, and the key that reads it again.
  assert.equal(notSignedInText('agy', { signedIn: null, reason: 'gave no answer within 30 seconds' }), 'Antigravity CLI did not say whether it is signed in (it gave no answer within 30 seconds). r in the Usage tab reads it again.');
});

test('each private HOME of Antigravity CLI finds the owner\'s login keychain on macOS, and nothing else of his home', t => {
  const root = temp(t), home = path.join(root, 'owner'), dir = path.join(root, 'private-home');
  fs.mkdirSync(path.join(home, 'Library', 'Keychains'), { recursive: true }); fs.mkdirSync(dir);
  assert.equal(agy.shareKeychain(dir, { platform: 'linux', home }), false);
  assert.equal(fs.existsSync(path.join(dir, 'Library')), false);
  assert.equal(agy.shareKeychain(dir, { platform: 'darwin', home }), true);
  assert.equal(fs.readlinkSync(path.join(dir, 'Library', 'Keychains')), path.join(home, 'Library', 'Keychains'));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'Library')), ['Keychains']);
  assert.equal(agy.shareKeychain(dir, { platform: 'darwin', home }), true, 'again: kept');
  // A keychain folder of agy's own, made before, is left alone; no keychain at all, no link.
  const own = path.join(root, 'own'); fs.mkdirSync(path.join(own, 'Library', 'Keychains'), { recursive: true });
  assert.equal(agy.shareKeychain(own, { platform: 'darwin', home }), false); assert.equal(fs.lstatSync(path.join(own, 'Library', 'Keychains')).isSymbolicLink(), false);
  assert.equal(agy.shareKeychain(path.join(root, 'none'), { platform: 'darwin', home: path.join(root, 'nobody') }), false);
});

test('Antigravity CLI with no keyring keeps a token file under HOME: each private HOME is linked to the owner\'s file, and a file written over the link is moved there', t => {
  const root = temp(t), home = path.join(root, 'owner'), dir = path.join(root, 'private-home'), other = path.join(root, 'other-home');
  for (const folder of [home, dir, other]) fs.mkdirSync(folder);
  const [inCli, inGemini] = agy.TOKEN_FILES.map(parts => path.join(...parts)), linux = { platform: 'linux', home };
  assert.deepEqual([inCli, inGemini], [path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token'), path.join('.gemini', 'antigravity-oauth-token')]);
  // macOS has the link to the login keychain: no file is linked there.
  assert.equal(agy.shareTokenFile(dir, { platform: 'darwin', home }), false); assert.equal(fs.existsSync(path.join(dir, '.gemini')), false);
  // Linux: both places the file is reported at, each a link to the same place in the owner's home.
  assert.equal(agy.shareTokenFile(dir, linux), true);
  for (const name of [inCli, inGemini]) assert.equal(fs.readlinkSync(path.join(dir, name)), path.join(home, name));
  assert.deepEqual(fs.readdirSync(home), [], 'nothing is made in the owner\'s home');
  assert.equal(fs.existsSync(path.join(dir, inCli)), false, 'a link that leads nowhere reads as no file: signed out');
  assert.equal(agy.shareTokenFile(dir, linux), true, 'again: kept');
  // The owner signs in in his terminal: every HOME of ELU's has that sign-in.
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true }); fs.writeFileSync(path.join(home, inCli), 'owner\n', { mode: 0o600 });
  agy.shareTokenFile(other, linux);
  for (const folder of [dir, other]) assert.equal(fs.readFileSync(path.join(folder, inCli), 'utf8'), 'owner\n');
  // Written in place under a HOME of ELU's: it is the owner's file that changes, and the link stays.
  fs.writeFileSync(path.join(dir, inCli), 'in place\n');
  assert.equal(fs.readFileSync(path.join(home, inCli), 'utf8'), 'in place\n'); assert.equal(fs.lstatSync(path.join(dir, inCli)).isSymbolicLink(), true);
  // Written over the link, as a new file moved into its place: that HOME has a file of its own,
  // and the other HOME does not have the new sign-in.
  const over = (file, text, at) => { fs.writeFileSync(`${file}.new`, text, { mode: 0o600 }); fs.renameSync(`${file}.new`, file); fs.utimesSync(file, at, at); };
  const now = Math.floor(Date.now() / 1000);
  fs.utimesSync(path.join(home, inCli), now - 100, now - 100);
  over(path.join(dir, inCli), 'by rename\n', now);
  assert.equal(fs.lstatSync(path.join(dir, inCli)).isFile(), true); assert.equal(fs.readFileSync(path.join(other, inCli), 'utf8'), 'in place\n');
  // The next time ELU prepares that HOME the newer file becomes the owner's, for him alone, and the link is back.
  assert.equal(agy.shareTokenFile(dir, linux), true);
  assert.equal(fs.readlinkSync(path.join(dir, inCli)), path.join(home, inCli));
  for (const folder of [home, dir, other]) assert.equal(fs.readFileSync(path.join(folder, inCli), 'utf8'), 'by rename\n');
  assert.equal(fs.statSync(path.join(home, inCli)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.gemini', 'antigravity-cli')), ['antigravity-oauth-token'], 'ELU keeps no copy');
  // An older file written over the link is dropped: the owner signed in again since.
  over(path.join(dir, inCli), 'old\n', now - 50); agy.shareTokenFile(dir, linux);
  assert.equal(fs.lstatSync(path.join(dir, inCli)).isSymbolicLink(), true); assert.equal(fs.readFileSync(path.join(dir, inCli), 'utf8'), 'by rename\n');
  // An owner who never ran agy has no ~/.gemini: a file written over the link is moved there, into folders made for him alone.
  const fresh = path.join(root, 'fresh-owner'), mine = path.join(root, 'mine'); fs.mkdirSync(fresh); fs.mkdirSync(mine);
  agy.shareTokenFile(mine, { platform: 'linux', home: fresh }); over(path.join(mine, inGemini), 'first\n', now); agy.shareTokenFile(mine, { platform: 'linux', home: fresh });
  assert.equal(fs.readFileSync(path.join(fresh, inGemini), 'utf8'), 'first\n'); assert.equal(fs.statSync(path.join(fresh, '.gemini')).mode & 0o777, 0o700);
  assert.equal(fs.readlinkSync(path.join(mine, inGemini)), path.join(fresh, inGemini));
  // A link to another place (the owner's home moved) is made again; a folder where the file would be is left alone.
  fs.unlinkSync(path.join(mine, inCli)); fs.symlinkSync(path.join(root, 'elsewhere'), path.join(mine, inCli)); agy.shareTokenFile(mine, { platform: 'linux', home: fresh });
  assert.equal(fs.readlinkSync(path.join(mine, inCli)), path.join(fresh, inCli));
  fs.unlinkSync(path.join(mine, inCli)); fs.mkdirSync(path.join(mine, inCli)); agy.shareTokenFile(mine, { platform: 'linux', home: fresh });
  assert.equal(fs.lstatSync(path.join(mine, inCli)).isDirectory(), true);
});

// A Linux server with no keyring (ssh, a container): agy 1.5.8 keeps its sign-in in a token file
// under HOME. ELU runs agy under a HOME of its own for each workspace, so a sign-in made with s
// reached the sign-in HOME alone: the check, and every turn after it, found agy signed out.
for (const [how, tokenWrite] of [['in place', undefined], ['as a new file moved over the old one', 'rename']]) {
  test(`Antigravity CLI where it keeps a token file, written ${how}: s signs it in for every HOME ELU runs it under, and the check passes`, { timeout: 120000, skip: process.platform === 'darwin' ? 'on macOS every HOME is linked to the login keychain instead' : false }, async t => {
    const m = machine(t, { agy: { storage: 'file', auth: 'prompt', authSeconds: 3, tokenWrite } });
    // The owner's home, where his own agy keeps the file.
    environment(t, { HOME: m.home });
    const row = await m.row('agy'), token = path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    assert.equal((await agy.readSignIn({ bin: row.bin, cwd: m.home, env: m.env })).signedIn, false);
    // s: agy's own sign-in, in ELU's sign-in HOME.
    const command = agy.signInTerminal({ env: m.env });
    const signIn = spawnSync(row.bin, command.args, { env: command.env, input: '4/0AeanS0b-fake-code\n', encoding: 'utf8' });
    assert.equal(signIn.status, 0, signIn.stderr); assert.match(signIn.stderr, /Signed in\./);
    // The check: it reads the sign-in, then runs its steps under HOMEs of their own. All pass.
    assert.equal(await checkOnFirstUse(row, { cwd: m.home, environment: m.env }), true);
    assert.deepEqual(Object.values(conformanceState('agy').steps).filter(status => status !== 'pass'), []);
    // One token file, the owner's own, which his own agy reads too; ELU's HOMEs hold links to it.
    assert.equal(fs.lstatSync(path.join(m.home, token)).isFile(), true);
    const work = agy.childEnv({ mode: 'ask', cwd: m.home }).HOME; assert.notEqual(work, command.env.HOME);
    for (const home of [command.env.HOME, work]) assert.equal(fs.readlinkSync(path.join(home, token)), path.join(m.home, token));
    assert.deepEqual(await agy.readSignIn({ bin: row.bin, cwd: m.home, env: m.env }), { signedIn: true, reason: null });
    // Signed in in his terminal instead (ELU's state is new): ELU finds agy signed in, with no s.
    fs.rmSync(path.join(personalDirectory(), 'agy-home'), { recursive: true });
    assert.deepEqual(await agy.readSignIn({ bin: row.bin, cwd: m.home, env: m.env }), { signedIn: true, reason: null });
  });
}

test('Grok Build: s runs grok login under the HOME and GROK_HOME ELU runs it with, and its token lands where those runs read it', { timeout: 60000 }, async t => {
  // An owner who never ran grok: no ~/.grok at all, so ELU's link to his token file leads nowhere yet.
  const m = machine(t, { grok: { login: true } });
  fs.rmSync(path.join(m.home, '.grok'), { recursive: true });
  assert.deepEqual(await grok.readSignIn({ env: m.env }), { signedIn: false, reason: null });
  const command = grok.signInTerminal({ env: m.env }), row = await m.row('grok');
  assert.equal(fs.statSync(path.join(m.home, '.grok')).mode & 0o777, 0o700, 'his ~/.grok, made as grok makes it');
  assert.deepEqual(command.args, ['login']);
  assert.equal(command.env.HOME, grok.privateHome()); assert.equal(command.env.GROK_HOME, grok.grokHome());
  // grok prints a link and a code, and waits until the owner confirms the code on that page; it reads no input.
  const signIn = await new Promise(resolve => {
    const child = spawn(row.bin, command.args, { env: command.env, stdio: ['ignore', 'pipe', 'pipe'] }); let printed = '', approved = false;
    const read = chunk => { printed += chunk; if (!approved && /Waiting for authorization\.\.\./.test(printed)) { approved = true; fs.writeFileSync(path.join(m.fake.dir, 'grok-approved'), ''); } };
    child.stdout.on('data', read); child.stderr.on('data', read); child.on('close', status => resolve({ status, printed }));
  });
  assert.equal(signIn.status, 0, signIn.printed);
  assert.match(signIn.printed, /Confirm this code in your browser:\n\n {2}FAKE-CODE\n/);
  // Through ELU's link: the owner's own token file, which his own grok reads too.
  assert.equal(fs.existsSync(path.join(m.home, '.grok', 'auth.json')), true);
  assert.deepEqual(await grok.readSignIn({ env: m.env }), { signedIn: true, reason: null });
});

// Which way grok writes auth.json was not watched. Written in place, the token goes through
// ELU's link into the owner's own file (above). Written as a new file moved over the link, it
// stays in ELU's Grok home, where ELU's runs read it; the owner's own sign-in wins once it is newer.
test('Grok Build: a token written over ELU\'s link instead of through it signs every ELU run in, the check passes, and the owner\'s own newer sign-in takes its place', { timeout: 120000 }, async t => {
  const m = machine(t, { grok: { login: true, tokenWrite: 'rename' } });
  fs.rmSync(path.join(m.home, '.grok'), { recursive: true });
  const command = grok.signInTerminal({ env: m.env }), row = await m.row('grok'), link = path.join(grok.grokHome(), 'auth.json'), real = path.join(m.home, '.grok', 'auth.json');
  assert.equal(fs.readlinkSync(link), real);
  const signIn = await new Promise(resolve => {
    const child = spawn(row.bin, command.args, { env: command.env, stdio: ['ignore', 'pipe', 'pipe'] }); let printed = '', approved = false;
    const read = chunk => { printed += chunk; if (!approved && /Waiting for authorization\.\.\./.test(printed)) { approved = true; fs.writeFileSync(path.join(m.fake.dir, 'grok-approved'), ''); } };
    child.stdout.on('data', read); child.stderr.on('data', read); child.on('close', status => resolve({ status, printed }));
  });
  assert.equal(signIn.status, 0, signIn.printed);
  // ELU's link is now a file of grok's own, and nothing is at the owner's place.
  assert.equal(fs.lstatSync(link).isFile(), true); assert.equal(fs.existsSync(real), false);
  assert.deepEqual(await grok.readSignIn({ env: m.env }), { signedIn: true, reason: null });
  // Preparing a run keeps it, and the check runs its steps on it and passes.
  grok.childEnv({ mode: 'ask', home: m.home }); assert.equal(fs.lstatSync(link).isFile(), true);
  assert.equal(await checkOnFirstUse(row, { cwd: m.home, environment: m.env }), true);
  assert.deepEqual(Object.entries(conformanceState('grok').steps).filter(([, status]) => status !== 'pass').map(([id]) => id), []);
  assert.equal(fs.lstatSync(link).isFile(), true);
  // After its check the vendors are read as before every turn: signed in, and the Usage line says ready.
  // (It said "not signed in for ELU" there: that reading looked at the owner's own file alone.)
  const checked = await m.row('grok');
  assert.deepEqual([checked.signedIn, checked.conformant], [true, true]);
  const blank = { available: false }, tab = usageTab({ vendors: withCheck([{ vendor: 'claude', ...blank }, { vendor: 'codex', ...blank }, { vendor: 'agy', ...blank }, checked], { env: m.env }), env: m.env });
  assert.deepEqual(usageBlocks([tab[3]]).map(line => line.text), ['Grok Build  signed in · ready']);
  // The owner signs in in his terminal later: his file is the newer one, and ELU's runs use it through the link again.
  const now = Math.floor(Date.now() / 1000); fs.utimesSync(link, now - 100, now - 100);
  fs.writeFileSync(real, '{"token":"never-read"}\n', { mode: 0o600 });
  grok.childEnv({ mode: 'ask', home: m.home });
  assert.equal(fs.readlinkSync(link), real);
  // A refresh written over the link after that is the newer one again, and is kept.
  fs.utimesSync(real, now - 50, now - 50); fs.writeFileSync(`${link}.new`, '{"token":"never-read"}\n', { mode: 0o600 }); fs.renameSync(`${link}.new`, link);
  grok.childEnv({ mode: 'ask', home: m.home });
  assert.equal(fs.lstatSync(link).isFile(), true);
  assert.deepEqual(await grok.readSignIn({ env: m.env }), { signedIn: true, reason: null });
});
