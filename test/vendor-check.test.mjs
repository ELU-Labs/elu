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
import { watchSignIn, watchSignInSync } from '../lib/sign-in-watch.mjs';
import { conformanceState } from '../lib/conformance.mjs';
import { detect } from '../lib/detect.mjs';
import { personalDirectory, savedSignIn, usageTab } from '../lib/usage.mjs';
import { usageBlocks } from '../lib/terminal.mjs';
import { systemTemp } from '../lib/util.mjs';

function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// The temp folder as macOS has it: TMPDIR is /var/folders/…/T, and /var is a link to /private/var.
function linkedTemp(root) {
  fs.mkdirSync(path.join(root, 'private', 'var', 'folders', 'xy', 'T'), { recursive: true });
  fs.symlinkSync(path.join(root, 'private', 'var'), path.join(root, 'var'));
  return path.join(root, 'var', 'folders', 'xy', 'T');
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
  const row = vendor => detect(home, env, { only: vendor })[0];
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
  assert.equal(os.tmpdir(), tmp); assert.equal(fs.lstatSync(path.join(m.root, 'var')).isSymbolicLink(), true);
  assert.equal(systemTemp(), path.join(m.root, 'private', 'var', 'folders', 'xy', 'T'));
  // Before: the check's folder was made under /var/folders/… as written, and its first step refused it.
  for (const vendor of ['grok', 'agy']) {
    const said = [];
    assert.equal(await checkOnFirstUse(m.row(vendor), { cwd: m.home, environment: m.env, say: text => said.push(text) }), true, vendor);
    assert.ok(!said.some(line => /symbolic link/.test(line)), said.join('\n'));
    assert.deepEqual(Object.entries(conformanceState(vendor).steps).filter(([, status]) => status !== 'pass').map(([id]) => id), [], vendor);
  }
  // Nothing is left in the temp folder.
  assert.deepEqual(fs.readdirSync(tmp).filter(name => /^elu-code-(check|signin|help)-/.test(name)), []);
});

test('Antigravity CLI signed out asks for a sign-in and waits a minute for a code: the Usage read, the check and detect say "not signed in for ELU" within seconds, open no browser, and never hold the app', { timeout: 120000 }, async t => {
  const m = machine(t, { agy: { signedIn: false, auth: 'prompt' } }), row = m.row('agy');
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
  // detect(), which cannot wait, gets the same answer as fast.
  const started = Date.now();
  assert.equal(agy.probeSignIn({ bin: row.bin, cwd: m.home, env: m.env }), false);
  assert.ok(Date.now() - started < 15000);
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
  assert.deepEqual(watchSignInSync({ bin: silent, args: [], env: process.env, cwd: root, timeoutMs: 1000 }), { signedIn: null, reason: 'gave no answer within 1 seconds' });
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

test('Grok Build: s runs grok login under the HOME and GROK_HOME ELU runs it with, and its token lands where those runs read it', { timeout: 60000 }, async t => {
  // An owner who never ran grok: no ~/.grok at all, so ELU's link to his token file leads nowhere yet.
  const m = machine(t, { grok: { login: true } });
  fs.rmSync(path.join(m.home, '.grok'), { recursive: true });
  assert.deepEqual(await grok.readSignIn({ env: m.env }), { signedIn: false, reason: null });
  const command = grok.signInTerminal({ env: m.env }), row = m.row('grok');
  assert.equal(fs.statSync(path.join(m.home, '.grok')).mode & 0o777, 0o700, 'his ~/.grok, made as grok makes it');
  assert.deepEqual(command.args, ['login']);
  // On a computer with no browser it is the sign-in grok names for one.
  assert.deepEqual(grok.signInTerminal({ env: m.env, browser: false }).args, ['login', '--device-auth']);
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
