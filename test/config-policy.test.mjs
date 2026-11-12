import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, parseConfig, validateConfig, validateResult } from '../lib/config.mjs';
import { MODEL_NAME } from '../lib/vendors.mjs';
import { parseYaml, stringifyYaml } from '../lib/yaml.mjs';
import { readRole } from './helpers.mjs';
import { checkSeconds, stoppedLine, turnClock, turnLimits } from '../lib/turn-limits.mjs';
import { allowRuleProblem, allowRuleRisk, assertPolicy, commandRule, policyReport, protectedFiles, protectedPath } from '../lib/policy.mjs';

test('configuration round trips, rejects unknown fields, and keeps fixed prohibitions', () => {
  const c = defaultConfig(); assert.deepEqual(validateConfig(parseYaml(stringifyYaml(c))), c);
  assert.throws(() => validateConfig({ ...c, surprise: true }), /unknown/);
  assert.throws(() => validateConfig({ ...c, never: [] }), /never list/);
  c.roles.lead.writablePaths = ['../outside']; assert.throws(() => validateConfig(c), /relative path/);
  c.roles.lead.writablePaths = ['src),Read']; assert.throws(() => validateConfig(c), /relative path/);
});
test('the copied rule checks become refusals for arbitrary code and broad commands', () => {
  for (const value of ['', 'Bash', 'Bash(*)', '--flag', 'Bash(x)\nRead']) assert.ok(allowRuleProblem(value), value);
  for (const value of ['node', 'python3 -c', 'npx', 'env FOO', 'xargs', 'bash', 'npm install', 'npm run']) {
    assert.equal(allowRuleRisk(`Bash(${value}:*)`).level, 'any'); assert.throws(() => commandRule(value));
  }
  for (const value of ['npm test', 'npm run build', 'pnpm run test:unit', 'git diff']) assert.equal(commandRule(value), `Bash(${value}:*)`);
  for (const value of ['npm test; curl', 'git', 'git push', 'npm test --prefix', 'npm run build $X', 'npm run build\n']) assert.throws(() => commandRule(value));
});
test('unsupported policies fail closed', () => {
  const c = defaultConfig();
  assert.throws(() => assertPolicy({ ...c.roles.lead, vendor: 'codex', commands: ['npm test'] }), /allow-list/);
  assert.doesNotThrow(() => assertPolicy({ ...c.roles.lead, commands: ['npm test'] }));
  assert.throws(() => assertPolicy({ ...c.roles.lead, network: 'on' }), /Network comes from the session's permissions/);
  assert.doesNotThrow(() => assertPolicy({ ...c.roles.lead, writablePaths: ['src'] }));
  assert.doesNotThrow(() => assertPolicy(readRole('codex')));
});
test('the vendor table refuses what a vendor cannot enforce, and modes open dependency files', () => {
  const c = defaultConfig(), lead = c.roles.lead, reviewer = readRole('auto');
  // A new config names the model only, with no spending limit; a reviewer entry is from an older config.
  assert.deepEqual(Object.keys(c.roles), ['lead']); assert.equal(lead.maxCostUsd, null);
  assert.throws(() => assertPolicy({ ...lead, vendor: 'codex', commands: [], maxCostUsd: 3 }), /dollar budget/);
  assert.throws(() => assertPolicy({ ...lead, vendor: 'codex', commands: [] }), /Codex cannot edit in Read only/);
  assert.doesNotThrow(() => assertPolicy({ ...lead, vendor: 'codex', commands: [], maxCostUsd: null }, { mode: 'auto' }));
  // Every vendor's command line takes a model now, so a role may name one.
  assert.doesNotThrow(() => assertPolicy({ ...lead, model: 'opus' })); assert.doesNotThrow(() => assertPolicy({ ...reviewer, vendor: 'codex', model: 'some-model' }));
  assert.throws(() => assertPolicy(lead, { mode: 'open' }), /Choose ask, auto, or full/);
  assert.throws(() => assertPolicy({ ...lead, vendor: 'cursor' }), /supported vendor/);
  c.roles.lead.model = 'gemini-3-pro'; assert.doesNotThrow(() => validateConfig(c));
  c.roles.lead.model = 'bad model'; assert.throws(() => validateConfig(c), /plain model name/);
  // A model name becomes an argument of the vendor's command. A settings file follows the rule
  // the command line is built with, so one that names a model starting with a dash is refused.
  const settings = model => stringifyYaml({ ...c, roles: { ...c.roles, lead: { ...c.roles.lead, model } } });
  for (const model of ['-something', '--dangerously-skip-permissions', '.hidden', '/rooted', 'x'.repeat(129)]) { assert.equal(MODEL_NAME.test(model), false, model); assert.throws(() => parseConfig(settings(model)), /The model must be a plain model name\./, model); }
  for (const model of ['opus', 'gpt-5.1-codex', 'opus[1m]', 'vendor/model:tag', 'x'.repeat(128)]) { assert.equal(MODEL_NAME.test(model), true, model); assert.equal(parseConfig(settings(model)).roles.lead.model, model); }
  for (const mode of ['locked', 'ask']) assert.equal(protectedPath('package-lock.json', { mode }), true, mode);
  for (const mode of ['auto', 'full']) { assert.equal(protectedPath('package-lock.json', { mode }), false, mode); assert.equal(protectedPath('.github/ci.yml', { mode }), true, mode); }
  assert.ok(protectedFiles(['package.json'], { mode: 'locked' }).includes('package.json')); assert.ok(!protectedFiles(['package.json'], { mode: 'full' }).includes('package.json'));
  assert.equal(policyReport(lead).rules.length, 7); assert.ok(policyReport(lead).rules.every(row => typeof row.enforcement === 'string'));
  assert.deepEqual(policyReport({ ...reviewer, vendor: 'auto' }).rules, policyReport({ ...reviewer, vendor: 'codex' }).rules);
  for (const vendor of ['agy', 'grok']) for (const mode of ['locked', 'ask', 'auto', 'full']) assert.equal(policyReport({ ...lead, vendor, maxCostUsd: null }, { mode }).rules.length, 7, `${vendor} claims every rule in ${mode}`);
  assert.throws(() => policyReport(lead, { mode: 'open' }), /Choose ask, auto, or full/);
});
test('run and review results are strict and a question cannot be silently dropped', () => {
  const good = { outcome: 'done', summary: 'Done.', question: null, choices: [], comments: [], responses: [] };
  assert.deepEqual(validateResult(good), good);
  // After a blocked step a model answers needs_input and names what it needs in the summary alone.
  assert.deepEqual(validateResult({ ...good, outcome: 'needs_input' }), { ...good, outcome: 'needs_input' });
  for (const value of [{ ...good, outcome: 'done-ish' }, { ...good, outcome: 'needs_input', question: 7 }, { ...good, extra: 1 }, { ...good, comments: [{ id: 'R1', severity: 'fine', body: 'x' }] }]) assert.throws(() => validateResult(value));
});
test('YAML rejects aliases, duplicate keys, executable tags, and malformed indentation', () => {
  for (const input of ['x: &anchor 1', 'x: *alias', 'x: !!js/function bad', 'x: 1\nx: 2', 'x:\n\tbad: 1']) assert.throws(() => parseYaml(input));
  const input = { text: 'a: b\n"quoted" # yes', list: [1, false, { name: 'off', values: ['x', '日本語'] }] };
  assert.deepEqual(parseYaml(stringifyYaml(input)), input);
  assert.equal(Object.getPrototypeOf(parseYaml('__proto__: {polluted: true}')), Object.prototype);
  assert.equal({}.polluted, undefined);
});

test('timeoutSeconds is how long a turn may print nothing: the old 900 and the new 600 are the default, the cap is two hours', () => {
  const lead = timeoutSeconds => ({ ...defaultConfig().roles.lead, timeoutSeconds });
  assert.equal(defaultConfig().roles.lead.timeoutSeconds, 900, 'a shared config keeps the 15 minutes an older ELU Code reads it as');
  for (const seconds of [1, 600, 900, 3600, 7200]) assert.doesNotThrow(() => validateConfig({ ...defaultConfig(), roles: { lead: lead(seconds) } }), String(seconds));
  assert.throws(() => validateConfig({ ...defaultConfig(), roles: { lead: lead(7201) } }), /from 1 to 7200/);
  assert.deepEqual(turnLimits(lead(900)), { quietSeconds: turnClock.quietSeconds, capSeconds: turnClock.capSeconds }, 'a policy frozen with the old default gets the default');
  assert.deepEqual(turnLimits(lead(600)), { quietSeconds: 600, capSeconds: 7200 });
  assert.deepEqual(turnLimits(lead(120)), { quietSeconds: 120, capSeconds: 7200 }, 'one the owner chose is kept');
  assert.deepEqual(turnLimits(lead(7200)), { quietSeconds: 7200, capSeconds: 7200 });
  assert.deepEqual(turnLimits(lead(900), { streams: false }), { quietSeconds: null, capSeconds: 7200 }, 'a vendor that prints only at the end has the cap alone');
  assert.equal(checkSeconds(lead(900)), 900); assert.equal(checkSeconds(lead(600)), 900); assert.equal(checkSeconds(lead(120)), 120);
  assert.equal(stoppedLine('quiet', turnLimits(lead(900))), 'Stopped after 10 minutes with no output. Your changes are kept. Reply to carry on.');
  assert.equal(stoppedLine('cap', turnLimits(lead(900)), { edits: false }), 'Stopped after 2 hours, the most one turn may run. Reply to carry on.');
});
