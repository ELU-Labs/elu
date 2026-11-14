import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as grok from '../lib/adapters/grok.mjs';
import { agentEnv } from '../lib/process.mjs';
import { conformanceHarness } from '../lib/conformance.mjs';
import { probeVersion } from '../lib/detect.mjs';
import { temp } from './helpers.mjs';

// Against the real Grok Build, when ELU_REAL_GROK names its program. Only what needs no
// sign-in runs: its release, and the check's step that reads what else it loads. The home is
// a scratch one, signed out, and nothing here signs it in or starts a turn.
const REAL = process.env.ELU_REAL_GROK;
const skip = REAL ? false : 'set ELU_REAL_GROK to the grok program to run this against the real one';
function world(t) {
  const dir = temp(t), previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(dir, 'personal');
  t.after(() => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; });
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  return { dir, home, env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: dir } };
}
const inspect = (cwd, env) => { const out = spawnSync(REAL, ['--no-auto-update', 'inspect', '--json'], { cwd, env, encoding: 'utf8', timeout: 60000 }); assert.equal(out.status, 0, out.stderr); return JSON.parse(out.stdout); };
// Another tool's files, as they sit in a home: instructions, a rule, a skill and an MCP server each for Cursor and Claude.
function otherTools(home) {
  for (const [file, text] of [['.cursor/AGENTS.md', 'cursor instructions\n'], ['.cursor/rules/style.md', 'Be terse.\n'], ['.cursor/skills/tidy/SKILL.md', '---\nname: tidy\ndescription: tidy things\n---\nTidy.\n'], ['.cursor/mcp.json', '{"mcpServers":{"notes":{"command":"notes-server"}}}\n'],
    ['.claude/CLAUDE.md', '# claude instructions\n'], ['.claude/rules/style.md', 'Be brief.\n'], ['.claude/skills/neat/SKILL.md', '---\nname: neat\ndescription: neat things\n---\nNeat.\n']]) {
    fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true }); fs.writeFileSync(path.join(home, file), text);
  }
}

test('the real grok inspect: the step that reads what else Grok Build loads passes on an empty home, and on a home that holds another tool\'s files with ELU\'s switches', { skip, timeout: 180000 }, async t => {
  const w = world(t), harness = await conformanceHarness({ scratch: path.join(w.dir, 'scratch') });
  t.after(() => harness.close());
  // Its release and flags, as the check reads them before its first step.
  const version = await probeVersion('grok', REAL, w.home, w.env, { check: true });
  assert.equal(version.supported, true, version.reason); assert.match(version.release, /^\d+\.\d+\.\d+/);
  const step = grok.conformance.find(item => item.id === 'isolation');
  await step.run(harness, { bin: REAL, env: w.env });
  // What it printed there: a row for every switch, each off because ELU set it so.
  const child = agentEnv(w.env, [], grok.childEnv({ mode: 'locked', home: w.home }));
  const empty = inspect(harness.repo, child), cells = empty.externalCompat.cells;
  assert.ok(cells.length >= 13, `${cells.length} switches listed`);
  assert.deepEqual(cells.filter(cell => cell.enabled !== false || cell.source !== 'env').map(cell => `${cell.vendor}.${cell.surface}`), [], 'every switch is off, by the environment');
  assert.deepEqual([...new Set(cells.map(cell => cell.vendor))].sort(), ['claude', 'codex', 'cursor'], 'the list names the other tools on every computer');
  assert.deepEqual(grok.foreignTraces(empty), []);
  // The config ELU writes keeps them off when the environment says nothing.
  const bare = Object.fromEntries(Object.entries(child).filter(([key]) => !/^GROK_(CLAUDE|CURSOR|CODEX)_/.test(key))), byConfig = inspect(harness.repo, bare);
  assert.equal(byConfig.configError, undefined); assert.deepEqual(byConfig.externalCompat.cells.filter(cell => cell.enabled !== false || cell.source !== 'config').map(cell => `${cell.vendor}.${cell.surface}`), []);
  // Another tool's files in the home ELU runs it under: listed with their paths, marked disabled, and the step still passes.
  otherTools(child.HOME);
  const listed = inspect(harness.repo, child), marked = [...listed.projectInstructions, ...listed.skills, ...listed.mcpServers].filter(entry => entry.vendor);
  assert.ok(marked.length >= 6, `${marked.length} entries of another tool are listed`);
  assert.ok(marked.every(entry => entry.compatibilityStatus === 'disabled' && entry.disabled === true), JSON.stringify(marked.map(entry => [entry.vendor, entry.compatibilityStatus])));
  assert.deepEqual(grok.foreignTraces(listed), []);
  await step.run(harness, { bin: REAL, env: w.env });
});

test('the real grok inspect, with no switch set: what it loads of another tool is named with its file', { skip, timeout: 180000 }, async t => {
  // Grok Build as it runs outside ELU: its own home, no switch in the environment or its config.
  const w = world(t), home = path.join(w.dir, 'plain'), repo = path.join(w.dir, 'repo');
  fs.mkdirSync(path.join(home, '.grok'), { recursive: true }); fs.mkdirSync(repo);
  otherTools(home);
  const env = { PATH: process.env.PATH, HOME: home, GROK_HOME: path.join(home, '.grok'), TMPDIR: w.dir, GROK_DISABLE_AUTOUPDATER: '1', GROK_TELEMETRY_ENABLED: '0', GROK_TELEMETRY_TRACE_UPLOAD: '0', GROK_TELEMETRY_MIXPANEL_ENABLED: '0', GROK_FEEDBACK_ENABLED: '0' };
  const loads = grok.foreignTraces(inspect(repo, env)), at = file => fs.realpathSync(path.join(home, file));
  const named = (what, file) => loads.some(row => row.what === what && fs.realpathSync(row.from) === at(file));
  for (const [what, file, runs] of [['Cursor instructions', '.cursor/AGENTS.md', false], ['Cursor rule', '.cursor/rules/style.md', false], ['Cursor skill tidy', '.cursor/skills/tidy/SKILL.md', false], ['Cursor MCP server notes', '.cursor/mcp.json', true], ['Claude instructions', '.claude/CLAUDE.md', false], ['Claude rule', '.claude/rules/style.md', false], ['Claude skill neat', '.claude/skills/neat/SKILL.md', false]]) {
    assert.ok(named(what, file), `${what} ${file}: ${JSON.stringify(loads)}`);
    assert.equal(loads.find(row => row.what === what).runs, runs, what);
  }
  // Hooks are on with none listed in a folder Grok Build does not trust: the switch itself is named, as something that runs.
  for (const what of ['Cursor hooks', 'Claude hooks']) assert.ok(loads.some(row => row.what === what && row.from === 'switched on (default)' && row.runs), `${what}: ${JSON.stringify(loads)}`);
  assert.ok(!loads.some(row => /sessions/.test(row.what)), 'sessions puts nothing into a turn');
});

// What Grok Build has no switch for. An agent file under .claude/agents is its own to load:
// its docs say "Loaded as subagents", its Claude agents switch is the CLAUDE.md scan, and
// inspect lists the file the same with every switch off, with no vendor and no mark. A Claude
// settings file in its home is named as a source of its permission rules, beside ELU's
// config. Both load with all of ELU's switches set, so both are named with their files, as
// text the model reads: neither is something that runs, and the step is not a required one.
test('the real grok inspect, with ELU\'s switches: a Claude agent file and a Claude settings file in its home still load, and each is named with its file', { skip, timeout: 180000 }, async t => {
  const w = world(t), harness = await conformanceHarness({ scratch: path.join(w.dir, 'scratch') });
  t.after(() => harness.close());
  const child = agentEnv(w.env, [], grok.childEnv({ mode: 'locked', home: w.home }));
  const agent = path.join(child.HOME, '.claude', 'agents', 'reviewer.md'), settings = path.join(child.HOME, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(agent), { recursive: true }); fs.writeFileSync(agent, '---\nname: reviewer\ndescription: reviews a change\n---\nReview the change.\n');
  fs.writeFileSync(settings, '{"permissions":{"deny":["Bash(rm:*)"]}}\n');
  const listed = inspect(harness.repo, child), real = file => fs.realpathSync(file);
  assert.deepEqual(listed.externalCompat.cells.filter(cell => cell.enabled !== false).map(cell => `${cell.vendor}.${cell.surface}`), [], 'every switch is off');
  const entry = listed.agents.find(item => item.name === 'reviewer');
  assert.equal(real(entry.source.path), real(agent), 'the agent file is listed');
  for (const mark of ['vendor', 'compatibilityStatus', 'disabled']) assert.equal(entry[mark], undefined, `the agent carries no ${mark}`);
  assert.ok(listed.permissions.sources.some(source => source.endsWith(' (settings)') && real(source.replace(/ \([^()]*\)$/, '')) === real(settings)), JSON.stringify(listed.permissions.sources));
  assert.deepEqual(grok.foreignTraces(listed).map(row => [row.what, real(row.from), row.runs]), [['Claude agent reviewer', real(agent), false], ['Claude permissions', real(settings), false]]);
  const step = grok.conformance.find(item => item.id === 'isolation');
  assert.equal(step.required, false);
  await assert.rejects(step.run(harness, { bin: REAL, env: w.env }), error => error.loads.length === 2 && error.loads.every(row => row.runs === false) && /Claude agent reviewer/.test(error.message) && /Claude permissions/.test(error.message));
});

// Full access as ELU runs it: HOME is a mirror of the owner's home that leaves out the folders
// of coding tools (lib/home-mirror.mjs), GROK_HOME is ELU's, and every switch is off. Under it
// the real program lists nothing of his. With his home itself as HOME, and the same GROK_HOME
// and switches, it marks his Claude and Cursor instructions, rules, skills and MCP servers as
// switched off and still loads his Claude agent, a Claude plugin with its hook, the permission
// rules of his Claude settings file, his ~/.grok agent and his ~/.agents skill: why Full access
// does not run in his home.
test('the real grok inspect, in Full access: under the mirror of the owner\'s home nothing of his coding tools is listed; in his home itself a Claude agent, a Claude plugin and Claude permission rules still load', { skip, timeout: 180000 }, async t => {
  const w = world(t), repo = path.join(w.dir, 'repo'), real = file => fs.realpathSync(file); fs.mkdirSync(repo);
  const put = (file, text) => { fs.mkdirSync(path.dirname(path.join(w.home, file)), { recursive: true }); fs.writeFileSync(path.join(w.home, file), text); return path.join(w.home, file); };
  otherTools(w.home); put('.npmrc', '//registry.npmjs.org/:_authToken=owner-npm-token\n');
  const agent = put('.claude/agents/reviewer.md', '---\nname: reviewer\ndescription: reviews a change\n---\nReview the change.\n');
  const plugin = path.join(w.home, '.claude', 'plugins', 'cache', 'market', 'helper', '1.0.0');
  const settings = put('.claude/settings.json', JSON.stringify({ enabledPlugins: { 'helper@market': true }, permissions: { deny: ['Bash(rm:*)'] } }));
  put('.claude/plugins/installed_plugins.json', JSON.stringify({ version: 2, plugins: { 'helper@market': [{ scope: 'user', installPath: plugin, version: '1.0.0', installedAt: '2026-11-01T00:00:00.000Z', lastUpdated: '2026-11-01T00:00:00.000Z' }] } }));
  put('.claude/plugins/known_marketplaces.json', JSON.stringify({ market: { source: { source: 'github', repo: 'example/market' }, installLocation: path.join(w.home, '.claude', 'plugins', 'marketplaces', 'market'), lastUpdated: '2026-11-01T00:00:00.000Z' } }));
  put('.claude/plugins/cache/market/helper/1.0.0/.claude-plugin/plugin.json', JSON.stringify({ name: 'helper', version: '1.0.0', description: 'a plugin' }));
  put('.claude/plugins/cache/market/helper/1.0.0/commands/hello.md', '---\ndescription: say hello\n---\nSay hello.\n');
  put('.claude/plugins/cache/market/helper/1.0.0/hooks/hooks.json', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'plugin-hook' }] }] } }));
  put('.claude.json', '{"mcpServers":{"claude-notes":{"command":"notes-server"}}}\n');
  put('.grok/agents/own.md', '---\nname: own\ndescription: his own agent\n---\nDo.\n'); put('.agents/skills/shared/SKILL.md', '---\nname: shared\ndescription: shared things\n---\nShared.\n');
  const every = dir => fs.readdirSync(dir, { recursive: true }).sort().map(name => { const stat = fs.lstatSync(path.join(dir, name)); return `${name} ${stat.isFile() ? stat.mtimeMs : 'folder'}`; }), before = every(w.home);
  const child = agentEnv(w.env, [], grok.childEnv({ mode: 'full', home: w.home }), { full: true });
  // The mirror: his npm sign-in and nothing of a coding tool but the .grok ELU wrote.
  assert.equal(child.HOME, grok.fullHome()); assert.deepEqual(fs.readdirSync(child.HOME).sort(), ['.grok', '.npmrc']);
  assert.equal(fs.readFileSync(path.join(child.HOME, '.npmrc'), 'utf8'), '//registry.npmjs.org/:_authToken=owner-npm-token\n'); assert.equal(real(path.join(child.HOME, '.grok')), real(child.GROK_HOME));
  const own = value => ['projectInstructions', 'skills', 'agents', 'mcpServers', 'hooks', 'plugins'].flatMap(section => (value[section] ?? []).filter(entry => !['builtin', 'bundled'].includes(entry.source?.type)).map(entry => `${section} ${entry.name ?? ''} ${entry.path ?? entry.source?.path ?? ''}`.trim()));
  const off = value => assert.deepEqual(value.externalCompat.cells.filter(cell => cell.enabled !== false).map(cell => `${cell.vendor}.${cell.surface}`), [], 'every switch is off');
  const under = inspect(repo, child);
  off(under); assert.equal(under.configError, undefined);
  assert.deepEqual(own(under), [], 'nothing of his is listed'); assert.deepEqual(under.permissions.sources, [], 'and no rules of his');
  assert.deepEqual(grok.foreignTraces(under), []);
  t.diagnostic(`under the mirror: ${under.externalCompat.cells.length} switches listed, all off; listed ${own(under).length}; permission sources ${under.permissions.sources.length}; loaded from another tool ${grok.foreignTraces(under).length}`);
  // His home itself, with the same GROK_HOME and switches.
  const inHis = inspect(repo, { ...child, HOME: w.home }), marked = [...inHis.projectInstructions, ...inHis.skills, ...inHis.mcpServers].filter(entry => entry.vendor);
  off(inHis);
  assert.ok(marked.length >= 7, `${marked.length} entries of another tool are listed`); assert.ok(marked.every(entry => entry.compatibilityStatus === 'disabled' && entry.disabled === true), JSON.stringify(marked.map(entry => [entry.vendor, entry.compatibilityStatus])));
  const loads = grok.foreignTraces(inHis).map(row => [row.what, real(row.from), row.runs]);
  assert.deepEqual(loads, [['Claude agent reviewer', real(agent), false], ['Claude plugin helper', real(plugin), true], ['Claude permissions', real(settings), false]]);
  assert.ok(inHis.agents.some(entry => entry.name === 'own' && real(entry.source.path) === real(path.join(w.home, '.grok', 'agents', 'own.md'))), 'his own ~/.grok agent loads though GROK_HOME is elsewhere');
  assert.ok(inHis.skills.some(entry => entry.name === 'shared' && !entry.vendor && entry.disabled !== true), 'and his ~/.agents skill');
  t.diagnostic(`in his home itself: listed ${own(inHis).length}, marked switched off ${marked.length}; loaded from another tool: ${loads.map(row => `${row[0]}${row[2] ? ' (runs)' : ''}`).join(', ')}; permission sources ${JSON.stringify(inHis.permissions.sources.map(source => source.replace(w.home, '~')))}`);
  // Neither reading wrote in his home, and the mirror took nothing of a coding tool.
  assert.deepEqual(every(w.home), before); assert.deepEqual(fs.readdirSync(child.HOME).sort(), ['.grok', '.npmrc']);
});
