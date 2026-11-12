import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detect, unsupportedVendors, vendorProblem } from '../lib/detect.mjs';
import { defaultConfig, validateConfig } from '../lib/config.mjs';
import { assertPolicy } from '../lib/policy.mjs';
import { project, fakeClis, cli, git, readRole } from './helpers.mjs';

function plant(dir, name, marker) {
  fs.writeFileSync(path.join(dir, name), `#!${process.execPath}\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},'executed\\n');process.exit(91);\n`, { mode: 0o755 });
}
function assertUnavailable(vendors) {
  for (const vendor of ['opencode', 'cursor']) {
    const row = vendors.find((value) => value.vendor === vendor);
    assert.ok(row, vendor);
    assert.equal(row.available, true, vendor);
    assert.equal(row.supported, false, vendor);
    assert.equal(row.version, null, vendor);
    assert.equal(row.signedIn, null, vendor);
    assert.equal(row.support, 'not supported yet', vendor);
    assert.ok(row.reason);
  }
}
// Registry vendors with no tested release: found on PATH, never run, never signed in, never conformant.
// Their row says what they do here and what will start their one-time check.
function assertNotYet(vendors) {
  for (const [vendor, name, support] of [['agy', 'Antigravity CLI', 'sessions and reviews'], ['grok', 'Grok Build', 'sessions']]) {
    const row = vendors.find((value) => value.vendor === vendor);
    assert.ok(row, vendor);
    assert.equal(row.available, true, vendor); assert.equal(row.supported, false, vendor);
    assert.equal(row.version, null, vendor); assert.equal(row.signedIn, null, vendor);
    assert.equal(row.support, support, vendor); assert.equal(row.conformant, false, vendor);
    assert.equal(row.reason, `${name} has not been checked on this machine yet. Your first message to it runs the check.`, vendor);
  }
}
test('unsupported discovery checks both Cursor aliases without executing a binary', (t) => {
  const p = project(t); const f = fakeClis(p.parent); const marker = path.join(p.parent, 'unexpected-execution');
  for (const name of ['opencode', 'agent', 'cursor-agent', 'agy', 'grok']) plant(f.dir, name, marker);
  const env = { PATH: f.dir };
  assertUnavailable(detect(p.root, env)); assertNotYet(detect(p.root, env));
  assert.equal(unsupportedVendors(env).find((row) => row.vendor === 'cursor').bin, path.join(f.dir, 'agent'));
  fs.unlinkSync(path.join(f.dir, 'agent'));
  assertUnavailable(unsupportedVendors(env));
  assert.equal(unsupportedVendors(env).find((row) => row.vendor === 'cursor').bin, path.join(f.dir, 'cursor-agent'));
  assert.equal(fs.existsSync(marker), false);
  assert.ok(fs.readFileSync(f.calls, 'utf8').trim().split('\n').map(JSON.parse).every((row) => ['claude', 'codex'].includes(row.vendor)));
});
test('init and policy report unsupported vendors without probing or selecting them', (t) => {
  const p = project(t); const f = fakeClis(p.parent); const marker = path.join(p.parent, 'unexpected-execution');
  for (const name of ['opencode', 'agent', 'cursor-agent', 'agy', 'grok']) plant(f.dir, name, marker);
  const preview = cli(p.root, ['init', '--dry-run'], f.env);
  assert.equal(preview.status, 0, preview.stdout); assertUnavailable(preview.json.vendors); assertNotYet(preview.json.vendors);
  assert.equal(preview.json.config.roles.lead.vendor, 'claude');
  assert.deepEqual(Object.keys(preview.json.config.roles), ['lead'], 'reviews are done by bots; a new config names no reviewer');
  assert.equal(cli(p.root, ['init', '--yes'], f.env).status, 0);
  git(p.root, ['add', '.']); git(p.root, ['commit', '-m', 'Configure checks']);
  const policy = cli(p.root, ['policy', 'show'], f.env);
  assert.equal(policy.status, 0, policy.stdout);
  for (const vendor of ['opencode', 'cursor']) assert.ok(policy.json.unsupportedVendors.find(row => row.vendor === vendor && !row.supported), vendor);
  assert.equal(fs.existsSync(marker), false);
});
test('a candidate version pin cannot enable an unsupported vendor', () => {
  for (const vendor of ['opencode', 'cursor']) {
    for (const name of ['lead', 'reviewer']) {
      // A reviewer entry is from an older config; it is still checked when one is there.
      const config = defaultConfig(); config.roles.reviewer = readRole('auto'); config.roles[name].vendor = vendor;
      assert.throws(() => validateConfig(config), /unsupported vendor/);
      assert.throws(() => assertPolicy(config.roles[name]), /supported vendor/);
    }
  }
  assert.ok(unsupportedVendors({ PATH: '' }).every((row) => !row.available && !row.supported && row.version === null));
});
test('a shell wrapper standing in for an absent Claude reads as not installed', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-detect-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\necho "claude: command not found" >&2\nexit 127\n', { mode: 0o755 });
  const [claude] = detect(dir, { PATH: dir, HOME: dir }, { only: 'claude' });
  assert.equal(claude.available, true); assert.equal(claude.supported, false); assert.equal(claude.signedIn, false);
  assert.equal(claude.reason, 'not installed (only a wrapper was found)');
  assert.equal(vendorProblem('claude', [claude]), 'Claude Code: not installed (only a wrapper was found)');
});

test('an untested Claude whose piped --help is cut short is still read in full', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-detect-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const flags = '--print --add-dir --restricted --safe-mode --setting-sources --settings --strict-mcp-config --mcp-config --no-chrome --permission-mode --permission-prompts --tools --allowedTools --disallowedTools --output-format --json-schema --max-budget-usd --session-id --input-format --ignore-user-config --ignore-rules';
  // Like Claude Code 2.1.321: a pipe gets only the first 8190 bytes, so --verbose at the end is lost.
  fs.writeFileSync(path.join(dir, 'claude'), `#!${process.execPath}
import fs from 'node:fs'; const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.999 (Claude Code)'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const help = ${JSON.stringify(flags)} + ' '.repeat(20000) + ' --verbose\\n';
fs.writeSync(1, fs.fstatSync(1).isFIFO() ? help.slice(0, 8190) : help); process.exit(0);
`, { mode: 0o755 });
  const [claude] = detect(dir, { PATH: dir, HOME: dir }, { only: 'claude' });
  assert.equal(claude.supported, true, claude.reason); assert.equal(claude.versionStatus, 'untested version');
  assert.equal(vendorProblem('claude', [claude]), null);
});

test('the lead error names what is wrong', () => {
  assert.equal(vendorProblem('claude', [{ vendor: 'claude', available: false }]), 'Claude Code is not installed or not on your PATH.');
  assert.equal(vendorProblem('claude', [{ vendor: 'claude', available: true, supported: true, signedIn: false }]), 'Claude Code is signed out. Run claude to sign in, then send again.');
  // The command is the one that signs in, which is not always the vendor's name.
  const signedOut = vendor => vendorProblem(vendor, [{ vendor, available: true, supported: true, signedIn: false }]);
  assert.equal(signedOut('codex'), 'Codex is signed out. Run codex login to sign in, then send again.');
  assert.equal(signedOut('grok'), 'Grok Build is signed out. Run grok login to sign in, then send again.');
  assert.equal(signedOut('agy'), 'Antigravity CLI is signed out. Run agy to sign in, then send again.');
  assert.equal(vendorProblem('claude', [{ vendor: 'claude', available: true, supported: false, signedIn: true, release: '2.1.321', reason: 'This untested version is missing required flags: --verbose.' }]), 'Claude Code 2.1.321: This untested version is missing required flags: --verbose.');
});

test('ELU Code finds a lead installed in ~/.local/bin when PATH lacks it, as under tmux or a login service', (t) => {
  const p = project(t), f = fakeClis(p.parent), home = path.join(p.parent, 'home'), local = path.join(home, '.local', 'bin');
  fs.mkdirSync(local, { recursive: true }); fs.copyFileSync(path.join(f.dir, 'claude'), path.join(local, 'claude')); fs.chmodSync(path.join(local, 'claude'), 0o755);
  // The PATH a non-login shell gets: system folders only.
  const env = { HOME: home, PATH: ['/usr/bin', '/bin'].join(path.delimiter) };
  const preview = cli(p.root, ['init', '--dry-run'], env);
  const claude = preview.json.vendors.find(row => row.vendor === 'claude');
  assert.equal(claude.available, true, JSON.stringify(preview.json.vendors));
  assert.equal(claude.signedIn, true);
});

test('addUserBin appends ~/.local/bin once, only when it exists', async (t) => {
  const { addUserBin } = await import('../lib/process.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'elu-user-bin-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const folder = path.join(home, '.local', 'bin'), env = { PATH: ['/a', '/b'].join(path.delimiter) };
  assert.equal(addUserBin(env, home), false, 'no folder, no change'); assert.equal(env.PATH, ['/a', '/b'].join(path.delimiter));
  fs.mkdirSync(folder, { recursive: true });
  assert.equal(addUserBin(env, home), true); assert.equal(env.PATH, ['/a', '/b', folder].join(path.delimiter), 'appended, so earlier folders win');
  assert.equal(addUserBin(env, home), false); assert.equal(env.PATH.split(path.delimiter).filter(x => x === folder).length, 1);
  const first = { PATH: [folder, '/a'].join(path.delimiter) }; assert.equal(addUserBin(first, home), false); assert.equal(first.PATH, [folder, '/a'].join(path.delimiter));
  const empty = {}; assert.equal(addUserBin(empty, home), true); assert.equal(empty.PATH, folder);
  assert.equal(addUserBin({ PATH: '/a' }, ''), false, 'no home, no change');
});
