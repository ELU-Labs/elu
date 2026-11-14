import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, fakeClis } from './helpers.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { atomic, findBin, personalDirectory } from '../lib/util.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';
import { REFUSED, SHIM_VENDORS, shimEnvFile, shimPath, shimsBase } from '../lib/never-shims.mjs';

// A terminal app may wrap a vendor's command: each of its panes gets a folder on PATH, ahead
// of the vendor's own, that holds a small script named as the command (claude, codex). The
// script hands to the app's wrapper, which looks along PATH for the real program, skips its
// own files, and starts the first other one it finds. A file it finds that reads like a script
// handing on to the command by name is taken for another tool's stand-in: the wrapper runs it,
// counts the visit in the environment, and gives up when it comes back to the same file or
// has been through sixteen. In a pane of the app it also folds its own hooks into the
// --settings of a Claude Code session. This is a stand-in written for these tests that
// follows that logic; no vendor and no ELU file is named in it.
const PANE = '3AC8A3CD-0000-4000-8000-2B2F901826E6';
const wrapperText = prog => `#!/usr/bin/env bash
prog=${prog}
shim=\${TERMAPP_${prog.toUpperCase()}_WRAPPER_SHIM:-}; root=\${TERMAPP_${prog.toUpperCase()}_WRAPPER_SHIM_ROOT:-}
guard_name=termapp_${prog}_wrapper_reexec_guard; targets_name=termapp_${prog}_wrapper_reexec_targets
is_self_or_shim() {
  local c=$1
  [[ -n $c ]] || return 1
  [[ -e $c && $c -ef $0 ]] && return 0
  [[ -n $shim && -e $c && -e $shim && $c -ef $shim ]] && return 0
  [[ -n $root && $c == "\${root%/}/$prog" ]] && return 0
  case $c in */termapp-cli-shims/*/$prog|*/termapp-cli-shims/$prog|*/Resources/bin/$prog) return 0;; esac
  return 1
}
limit=16; hops=0; history=
guard=\${!guard_name:-}
case $guard in ''|*[!0-9]*) unset $guard_name $targets_name;; *) hops=$guard; history=\${!targets_name:-};; esac
fail_guard() {
  printf '%s\\n' "termapp: stopped a possible infinite $prog shim loop." "termapp's per-pane $prog shim re-entered before the real binary started." "This is usually caused by a conflicting $prog shim from another tool on PATH." >&2
  exit 126
}
seen() { local s; while IFS= read -r s; do [[ $s == "$1" ]] && return 0; done <<< "$history"; return 1; }
looks_like_reexec_shim() {
  local t=$1 text
  is_self_or_shim "$t" && return 0
  [[ -f $t && -r $t ]] || return 1
  [[ $(od -An -N2 -tx1 "$t" 2>/dev/null | tr -d '[:space:]') == 2321 ]] || return 1
  text=$(sed -n '1,160p' "$t" 2>/dev/null || true)
  case $text in *"exec $prog"*|*"exec \\"$prog\\""*|*"exec env $prog"*|*"env $prog"*|*"command $prog"*) return 0;; esac
  case $text in *"=$prog"*|*"=\\"$prog\\""*|*":-$prog}"*) case $text in *'exec "$'*|*'exec \${'*) return 0;; esac;; esac
  return 1
}
exec_resolved() {
  local t=$1; shift
  if ! looks_like_reexec_shim "$t"; then unset $guard_name $targets_name; exec "$t" "$@"; fi
  seen "$t" && fail_guard
  (( hops >= limit )) && fail_guard
  hops=$((hops + 1)); export $guard_name=$hops
  history=\${history:+$history$'\\n'}$t; export $targets_name="$history"
  exec "$t" "$@"
}
find_real() {
  local self_dir d c
  self_dir=$(cd "$(dirname "$0")" && pwd)
  local IFS=:
  for d in $PATH; do
    [[ $d == "$self_dir" ]] && continue
    c=$d/$prog
    is_self_or_shim "$c" && continue
    [[ -x $c ]] && printf '%s' "$c" && return 0
  done
  return 1
}
real=$(find_real) || { echo "Error: $prog not found in PATH" >&2; exit 127; }
echo "$prog hops=$hops real=$real pane=\${TERMAPP_SURFACE_ID:+yes}" >> "$(dirname "$0")/wrapper.log"
if [[ -z \${TERMAPP_SURFACE_ID:-} || $prog != claude || $hops -gt 0 ]]; then exec_resolved "$real" "$@"; fi
case \${1:-} in --help|-h|--version|-v|auth|mcp|config|doctor|install|update|agents|plugin) exec_resolved "$real" "$@";; esac
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID
base='{"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"true","timeout":10}]}]}}'
rest=(); own=(); take=0; session=0
for a in "$@"; do
  if [[ $take == 1 ]]; then own+=("$a"); take=0; continue; fi
  case $a in --settings) take=1;; --settings=*) own+=("\${a#--settings=}");; --session-id|--session-id=*|--resume|--resume=*|-r|--continue|-c) session=1; rest+=("$a");; *) rest+=("$a");; esac
done
if (( \${#own[@]} > 0 )); then
  merged=$(BASE="$base" OWN="$(printf '%s\\0' "\${own[@]}" | base64 | tr -d '\\n')" "$TERMAPP_NODE" -e '
const fs=require("fs");const isObj=x=>x&&typeof x==="object"&&!Array.isArray(x);
const merge=(a,b)=>Array.isArray(a)&&Array.isArray(b)?a.concat(b):isObj(a)&&isObj(b)?Object.fromEntries([...new Set([...Object.keys(a),...Object.keys(b)])].map(k=>[k,k in a&&k in b?merge(a[k],b[k]):k in b?b[k]:a[k]])):isObj(a)||Array.isArray(a)?a:b;
const load=v=>{const t=String(v).trim();return t[0]==="{"?JSON.parse(t):JSON.parse(fs.readFileSync(t,"utf8"));};
let acc=JSON.parse(process.env.BASE);for(const it of Buffer.from(process.env.OWN,"base64").toString("utf8").split("\\0").slice(0,-1).reverse())acc=merge(acc,load(it));
process.stdout.write(JSON.stringify(acc));') && { base=$merged; set -- "\${rest[@]}"; }
fi
if [[ $session == 1 ]]; then exec_resolved "$real" --settings "$base" "$@"; fi
exec_resolved "$real" --session-id 00000000-0000-4000-8000-000000000001 --settings "$base" "$@"
`;
const paneText = (prog, wrapper, folder) => `#!/usr/bin/env bash
wrapper=${JSON.stringify(wrapper)}
export TERMAPP_${prog.toUpperCase()}_WRAPPER_SHIM=${JSON.stringify(path.join(folder, prog))}
export TERMAPP_${prog.toUpperCase()}_WRAPPER_SHIM_ROOT=${JSON.stringify(folder)}
if [[ -x $wrapper ]]; then exec "$wrapper" "$@"; fi
kept=; old=$IFS; IFS=:
for entry in \${PATH:-}; do
  case $entry in "$TERMAPP_${prog.toUpperCase()}_WRAPPER_SHIM_ROOT"|*/termapp-cli-shims/*|*/termapp-cli-shims) continue;; esac
  kept=\${kept:+$kept:}$entry
done
IFS=$old; export PATH=$kept
exec ${prog} "$@"
`;
// The app, with a pane's scripts for these commands. The pane's folder is named through a
// link, as the temporary folder is on macOS; ELU starts a program by its path on disk.
function terminalApp(parent, vendors) {
  const bin = path.join(parent, 'TermApp', 'Resources', 'bin'), real = path.join(parent, 'tmp-real'), link = path.join(parent, 'tmp-link');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(real); fs.symlinkSync(real, link);
  const pane = path.join(link, 'termapp-cli-shims', PANE); fs.mkdirSync(pane, { recursive: true });
  for (const prog of vendors) {
    fs.writeFileSync(path.join(bin, `termapp-${prog}-wrapper`), wrapperText(prog), { mode: 0o755 });
    fs.writeFileSync(path.join(pane, prog), paneText(prog, path.join(bin, `termapp-${prog}-wrapper`), pane), { mode: 0o700 });
  }
  const log = path.join(bin, 'wrapper.log');
  return { bin, pane, onDisk: fs.realpathSync(pane), visits: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [], forget: () => fs.rmSync(log, { force: true }) };
}
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// A project whose vendors are all reached through the app's scripts: the pane's folder first
// on PATH, the vendors' own (the fakes) after it, the app's own variables in the environment
// as its panes have them.
function setup(t, vendor, { mode = 'answer', commands = undefined, wrapped = SHIM_VENDORS } = {}) {
  const p = project(t), fake = fakeClis(p.parent, { mode, commands }), app = terminalApp(p.parent, wrapped);
  environment(t, { ...fake.env, PATH: [app.pane, fake.env.PATH, app.bin].join(path.delimiter), HOME: p.parent, TERMAPP_NODE: process.execPath, TERMAPP_SURFACE_ID: PANE,
    ...Object.fromEntries(wrapped.flatMap(prog => [[`TERMAPP_${prog.toUpperCase()}_WRAPPER_SHIM`, path.join(app.pane, prog)], [`TERMAPP_${prog.toUpperCase()}_WRAPPER_SHIM_ROOT`, app.pane]])),
    GIT_AUTHOR_NAME: 'Test Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid', GIT_COMMITTER_NAME: 'Test Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid' });
  const controller = new ProjectController(projectFolder(p.root)); Object.assign(controller.draftConfig.roles.lead, { vendor, maxCostUsd: null });
  const calls = () => fs.existsSync(fake.calls) ? fs.readFileSync(fake.calls, 'utf8').trim().split('\n').map(JSON.parse).filter(call => call.vendor === vendor) : [];
  return { ...p, fake, app, controller, calls, real: path.join(fake.dir, vendor) };
}
// The one-time check's record for the program ELU starts, which is the pane's script.
const proven = (vendor, version) => atomic(path.join(personalDirectory(), 'conformance', `${vendor}.json`), { v: 1, bin: findBin(vendor), version, steps: Object.fromEntries(ADAPTERS[vendor].conformance.map(step => [step.id, step.id !== 'relay' ? 'pass' : 'fail'])), relay: false, at: new Date().toISOString() });
const PREPARE = {
  agy: () => proven('agy', '1.5.4'),
  grok: f => { fs.mkdirSync(path.join(f.parent, '.grok')); fs.writeFileSync(path.join(f.parent, '.grok', 'auth.json'), '{}\n', { mode: 0o600 }); proven('grok', '1.0.77'); },
};
const NAMES = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity', grok: 'Grok Build' };
const LABELS = { ask: 'Ask for approval', auto: 'Approve for me', full: 'Full access' };

test('ELU starts the wrapped command it finds first on PATH, by its path on disk, and the owner\'s own shell reaches the real program through it', t => {
  const f = setup(t, 'claude');
  for (const vendor of SHIM_VENDORS) {
    assert.equal(findBin(vendor), path.join(f.app.onDisk, vendor), `${vendor} is the pane's script`);
    const typed = spawnSync(vendor, ['--version'], { encoding: 'utf8' });
    assert.equal(typed.status, 0, typed.stderr); assert.match(typed.stdout, /\d+\.\d+\.\d+/);
  }
  assert.deepEqual(f.app.visits().map(row => row.split(' ').slice(0, 3).join(' ')), SHIM_VENDORS.map(vendor => `${vendor} hops=0 real=${path.join(f.fake.dir, vendor)}`));
});

// The owner's scene: ELU opened in a pane of such an app, a turn on Claude Code in the mode a
// new session starts with. The turn ended at once with the wrapper's own words.
for (const mode of ['ask', 'auto', 'full']) {
  for (const vendor of SHIM_VENDORS) {
    test(`a ${NAMES[vendor]} turn in ${LABELS[mode]} runs when another tool's script wraps the ${vendor} command`, async t => {
      const f = setup(t, vendor); PREPARE[vendor]?.(f);
      const task = await f.controller.ask('Where is coupon normalization?', null, { permissions: mode }).finished;
      assert.equal(task.state, 'answered', JSON.stringify(task.error));
      assert.equal(task.runs.at(-1).code, 0); assert.equal(task.runs.at(-1).vendor, vendor);
      assert.ok(f.calls().length > 0, 'the real program ran');
      // The wrapper went straight to the real program each time: it never met a file of ELU's.
      const visits = f.app.visits().filter(row => row.startsWith(`${vendor} `));
      assert.ok(visits.length > 0, 'the turn went through the wrapper');
      for (const row of visits) assert.match(row, new RegExp(`^${vendor} hops=0 real=${f.real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `), row);
    });
  }
}

test('in Full access the app\'s variables reach its wrapper, which folds its hooks into the session\'s own --settings; outside it the wrapper gets none of them', async t => {
  const f = setup(t, 'claude');
  const full = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' }).finished;
  assert.equal(full.state, 'answered', JSON.stringify(full.error));
  const turn = () => f.calls().findLast(call => call.args.includes('--permission-prompt-tool')), settings = call => JSON.parse(call.args[call.args.indexOf('--settings') + 1]);
  assert.equal(turn().args.filter(arg => arg === '--settings').length, 1);
  assert.equal(settings(turn()).disableAllHooks, true, 'ELU\'s settings are still the session\'s'); assert.ok(settings(turn()).hooks?.Stop, 'with the app\'s hooks beside them');
  assert.match(f.app.visits().at(-1), / pane=yes$/);
  f.app.forget();
  const ask = await f.controller.ask('And the tests?', null, { permissions: 'ask' }).finished;
  assert.equal(ask.state, 'answered', JSON.stringify(ask.error));
  assert.equal(settings(turn()).hooks, undefined); assert.ok(f.app.visits().every(row => / pane=$/.test(row)), f.app.visits().join('\n'));
});

// What the model runs inside a session. ELU's stand-in for the claude command is first on the
// PATH of a command there; it hands every call but an MCP change to the claude it finds next,
// which is the app's script.
for (const mode of ['ask', 'auto']) {
  test(`in ${LABELS[mode]} a command of a Codex session reaches the wrapped claude, and adding an MCP server is still refused by name`, async t => {
    const f = setup(t, 'codex', { commands: ['claude --version', 'claude mcp list', 'claude mcp add demo -- demo-server', 'sh -c "claude mcp remove demo"', 'command -v claude'] });
    const task = await f.controller.ask('Look at the MCP servers.', null, { permissions: mode }).finished;
    assert.equal(task.state, 'answered', JSON.stringify(task.error));
    const steps = fs.readFileSync(task.runs.at(-1).logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'item.completed' && row.item.type === 'command_execution').map(row => row.item);
    assert.deepEqual(steps.map(step => step.exit_code), [0, 0, REFUSED, REFUSED, 0], steps.map(step => step.aggregated_output).join('\n'));
    assert.match(steps[0].aggregated_output, /^\d+\.\d+\.\d+/); assert.match(steps[1].aggregated_output, /No MCP servers configured/);
    assert.deepEqual(steps.slice(2, 4).map(step => step.aggregated_output.trim()), ['claude mcp add is not allowed outside Full access.', 'claude mcp remove is not allowed outside Full access.']);
    assert.ok(steps[4].aggregated_output.trim().startsWith(shimsBase() + path.sep), 'the claude a command finds first is ELU\'s stand-in');
  });
  test(`in ${LABELS[mode]} a command of a Claude Code session reaches the wrapped claude, and adding an MCP server in a script is still refused by name`, async t => {
    const f = setup(t, 'claude', { commands: ['claude --version', 'sh -c "claude mcp list"', 'sh -c "claude mcp add demo -- demo-server"', 'command -v claude', 'command -v git'] });
    const task = await f.controller.ask('Look at the MCP servers.', null, { permissions: mode }).finished;
    assert.equal(task.state, 'answered', JSON.stringify(task.error));
    const printed = fs.readFileSync(task.runs.at(-1).logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.type === 'user').map(row => row.message.content[0].content);
    assert.match(printed[0], /^\d+\.\d+\.\d+/); assert.match(printed[1], /No MCP servers configured/);
    assert.equal(printed[2], `Exit code ${REFUSED}\nclaude mcp add is not allowed outside Full access.\n`);
    for (const found of printed.slice(3)) assert.ok(found.trim().startsWith(shimsBase() + path.sep), `a command finds ELU's stand-in first: ${found}`);
  });
}

test('the stand-in named as a vendor\'s program is kept off the PATH that program is started with, and leaves the PATH it hands on', t => {
  const f = setup(t, 'claude'), folders = value => value.split(path.delimiter).filter(dir => dir.startsWith(shimsBase() + path.sep));
  const has = (dirs, name) => dirs.filter(dir => fs.existsSync(path.join(dir, name)));
  // Codex, Grok Build and Antigravity give a command the PATH they were started with: both folders, the vendor-named one first.
  const others = folders(shimPath(process.env.PATH, { program: 'codex' }));
  assert.equal(has(others, 'claude').length, 1); assert.equal(has(others, 'git').length, 1); assert.equal(others.indexOf(has(others, 'claude')[0]), 0);
  // Claude Code is started without the folder that holds a claude; the file it runs ahead of each command puts both first.
  const own = folders(shimPath(process.env.PATH, { program: 'claude' }));
  assert.deepEqual(has(own, 'claude'), []); assert.equal(has(own, 'git').length, 1);
  const inCommand = spawnSync('/bin/sh', ['-c', `. ${JSON.stringify(shimEnvFile())}; command -v claude; command -v git; claude --version`], { env: { ...process.env, PATH: shimPath(process.env.PATH, { program: 'claude' }) }, encoding: 'utf8' });
  assert.equal(inCommand.status, 0, inCommand.stderr);
  const [claudeAt, gitAt, version] = inCommand.stdout.trim().split('\n');
  assert.ok(claudeAt.startsWith(shimsBase() + path.sep)); assert.ok(gitAt.startsWith(shimsBase() + path.sep)); assert.notEqual(path.dirname(claudeAt), path.dirname(gitAt)); assert.match(version, /^\d+\.\d+\.\d+/);
  // What the real program is handed: every stand-in but the one named as itself.
  const printer = path.join(f.parent, 'printer'); fs.mkdirSync(printer); fs.writeFileSync(path.join(printer, 'claude'), '#!/bin/sh\nprintf \'%s\' "$PATH"\n', { mode: 0o755 });
  const handed = spawnSync('claude', [], { env: { ...process.env, PATH: [...others, printer].join(path.delimiter) }, encoding: 'utf8' });
  assert.equal(handed.status, 0, handed.stderr); assert.deepEqual(handed.stdout.split(path.delimiter), [has(others, 'git')[0], printer]);
});

// A script for a command that is not a vendor's, written the same way. ELU's stand-in for the
// command is first on a session's PATH, so the first other file the script finds is the
// stand-in, which hands the call back to the script: without end, or until the script gives up.
const REAL_GIT = '#!/bin/sh\nprintf \'REAL git\'; for a do printf \' [%s]\' "$a"; done; echo\ncase $1 in again) exec git status;; path) printf \'%s\\n\' "$PATH";; esac\n';
function wrappedGit(t, write) {
  const f = setup(t, 'claude'), wrap = path.join(f.parent, 'wrap'), real = path.join(f.parent, 'real-git'); fs.mkdirSync(wrap); fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'git'), REAL_GIT, { mode: 0o755 });
  const first = write(wrap, f), all = shimPath('', { program: 'codex' }), PATH = [all, ...first, real, '/usr/bin', '/bin'].join(path.delimiter);
  const call = (...args) => { const r = spawnSync('git', args, { env: { PATH, TERMAPP_NODE: process.execPath }, encoding: 'utf8', timeout: 20000 }); return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }; };
  return { ...f, call, real, all: all.split(path.delimiter), rest: [...first, real, '/usr/bin', '/bin'] };
}
test('a call that another tool\'s script hands back to ELU\'s stand-in reaches the real command, and a refused call is refused before any script', t => {
  // The plainest such script: no count, no check of what it runs.
  const f = wrappedGit(t, wrap => { fs.writeFileSync(path.join(wrap, 'git'), '#!/bin/sh\nold=$IFS; IFS=:\nfor d in $PATH; do IFS=$old\n  [ "$d/git" -ef "$0" ] && continue\n  [ -x "$d/git" ] && { echo wrapped >&2; exec "$d/git" "$@"; }\ndone\nexit 127\n', { mode: 0o755 }); return [wrap]; });
  assert.deepEqual(f.call('status'), { code: 0, out: 'REAL git [status]', err: 'wrapped\nwrapped' }, 'the script ran, was handed the call a second time, and found the real git');
  assert.deepEqual(f.call('push', 'origin'), { code: REFUSED, out: '', err: 'git push is not allowed outside Full access.' });
  // The call that came back left the folder of the git stand-in behind, and only that one.
  assert.deepEqual(f.call('path').out.split('\n'), ['REAL git [path]', [...f.all.filter(dir => !fs.existsSync(path.join(dir, 'git'))), ...f.rest].join(path.delimiter)]);
});
test('the same holds for a script that counts its visits and gives up at a file it has seen', t => {
  const f = wrappedGit(t, (wrap, f) => { const app = terminalApp(wrap, ['git']); return [app.pane, app.bin]; });
  assert.deepEqual(f.call('status'), { code: 0, out: 'REAL git [status]', err: '' });
  assert.deepEqual(f.call('tag', 'v1').code, REFUSED);
});
test('a command that starts itself again by name is handed its own call again, and a call nobody handed back keeps the stand-ins on PATH', t => {
  const f = wrappedGit(t, () => []);
  assert.deepEqual(f.call('again'), { code: 0, out: 'REAL git [again]\nREAL git [status]', err: '' });
  assert.deepEqual(f.call('path').out.split('\n'), ['REAL git [path]', [...f.all, ...f.rest].join(path.delimiter)]);
  // A script the real command runs is a new call: a push in it is still refused.
  const script = path.join(f.parent, 'hook.sh'); fs.writeFileSync(script, '#!/bin/sh\ngit push origin\n', { mode: 0o755 });
  const nested = spawnSync('/bin/sh', ['-c', `git status && ${JSON.stringify(script)}`], { env: { PATH: [...f.all, ...f.rest].join(path.delimiter) }, encoding: 'utf8' });
  assert.equal(nested.status, REFUSED); assert.equal(nested.stderr.trim(), 'git push is not allowed outside Full access.');
});
