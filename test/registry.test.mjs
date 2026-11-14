import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { VENDORS, VENDOR_NAMES, CAPS, ENFORCEMENT, HOME_SECRETS } from '../lib/vendors.mjs';
import { ADAPTERS, adapterFor } from '../lib/adapters/index.mjs';
import { detect } from '../lib/detect.mjs';
import { defaultConfig, validateConfig } from '../lib/config.mjs';
import { project, fakeClis, FAKES } from './helpers.mjs';

test('every vendor has a name, caps, an enforcement table and an adapter with the contract exports', () => {
  assert.deepEqual(VENDORS, ['claude', 'codex', 'agy', 'grok']);
  for (const vendor of VENDORS) {
    const adapter = adapterFor(vendor);
    assert.equal(adapter, ADAPTERS[vendor]);
    assert.ok(VENDOR_NAMES[vendor] && CAPS[vendor] && ENFORCEMENT[vendor], vendor);
    assert.equal(adapter.meta.vendor, vendor); assert.equal(typeof adapter.meta.bin, 'string');
    for (const key of ['versionArgs', 'helpArgs', 'flags', 'supportedVersions', 'envKeys']) assert.ok(Array.isArray(adapter.meta[key]), `${vendor} meta.${key}`);
    for (const key of ['signInHint', 'installHint']) assert.equal(typeof adapter.meta[key], 'string', `${vendor} meta.${key}`);
    for (const name of ['signedIn', 'compile', 'parse', 'classify']) assert.equal(typeof adapter[name], 'function', `${vendor} ${name}`);
    assert.ok(Array.isArray(adapter.conformance), `${vendor} conformance`);
    assert.ok(['mcp', 'acp', null].includes(CAPS[vendor].relay)); assert.ok(['none', 'optional', 'required'].includes(CAPS[vendor].model));
    const config = defaultConfig(); config.roles.lead.vendor = vendor; assert.doesNotThrow(() => validateConfig(config), vendor);
  }
  assert.equal(CAPS.codex.lead, true, 'Codex leads in every mode');
  assert.throws(() => { CAPS.codex.lead = false; }); assert.throws(() => VENDORS.push('cursor')); assert.throws(() => HOME_SECRETS.push('x'));
  for (const value of ['cursor', 'opencode', '', null]) assert.throws(() => adapterFor(value), /supported vendor/, String(value));
});

// An unpinned vendor (no tested release in its meta) is pinned per machine by its one-time
// check: until then it is listed from PATH, never executed, not even for --version,
// and its compile says what starts the check. Its fake answers --version only once installed as a test CLI.
test('unpinned vendors are listed from PATH but never executed, and refuse to launch until their one-time check passed here', t => {
  const p = project(t), f = fakeClis(p.parent), marker = path.join(p.parent, 'unexpected-execution');
  const previous = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = f.env.XDG_CONFIG_HOME;
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  // Recorders in place of the fakes: any execution leaves the marker.
  for (const name of ['agy', 'grok']) fs.writeFileSync(path.join(f.dir, name), `#!${process.execPath}\nimport fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},'executed\\n');process.exit(91);\n`, { mode: 0o755 });
  const rows = detect(p.root, { PATH: f.dir });
  for (const vendor of ['agy', 'grok']) {
    const row = rows.find(value => value.vendor === vendor), adapter = ADAPTERS[vendor];
    assert.deepEqual(adapter.meta.supportedVersions, [], vendor);
    assert.equal(row.available, true, vendor); assert.equal(row.supported, false, vendor); assert.equal(row.version, null, vendor); assert.equal(row.signedIn, null, vendor);
    const unchecked = `${VENDOR_NAMES[vendor]} has not been checked on this machine yet. Your first message to it runs the check.`;
    assert.equal(row.support, 'sessions and reviews', vendor); assert.equal(row.conformant, false, vendor); assert.equal(row.reason, unchecked, vendor);
    assert.throws(() => adapter.compile({ role: defaultConfig().roles.lead, cwd: p.root, schemaFile: path.join(p.parent, 'schema.json'), session: '12345678-1234-4234-8234-123456789abc', runDir: p.parent }), { name: 'EluCodeError', message: unchecked }, vendor);
    assert.throws(() => adapter.parse(''), /no JSON (?:run )?result/, vendor);
    assert.equal(adapter.classify(''), 'unknown', vendor);
  }
  assert.equal(fs.existsSync(marker), false, 'no unpinned binary ran');
  // Run from test/fakes/ directly, with no fake.json beside it, the agy fake exits 2; the grok fake answers its version.
  assert.equal(spawnSync(process.execPath, [path.join(FAKES, 'agy.mjs'), '--version'], { encoding: 'utf8' }).status, 2);
  const grok = spawnSync(process.execPath, [path.join(FAKES, 'grok.mjs'), '--version'], { encoding: 'utf8' });
  assert.equal(grok.status, 0); assert.equal(grok.stdout.trim(), '1.0.77');
});
