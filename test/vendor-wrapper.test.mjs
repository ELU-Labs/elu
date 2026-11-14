import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { project, fakeClis } from './helpers.mjs';
import { ProjectController } from '../lib/projects.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { atomic, findBin, personalDirectory } from '../lib/util.mjs';
import { readTask } from '../lib/state.mjs';
import { ADAPTERS } from '../lib/adapters/index.mjs';
import { stopLine } from '../lib/stop-line.mjs';
import { REFUSED, SHIM_VENDORS, shimEnvFile, shimFolder, shimPath, shimsBase } from '../lib/never-shims.mjs';

// A terminal app may wrap a vendor's command. Each of its panes puts a folder on PATH, ahead
// of the vendor's own, with a small script named as the command (claude, codex). That script
// runs the app's own script for the command, which looks along PATH for the real program:
// the first other file of that name that is not the app's. A file that reads like another
// tool's script handing on to the command by name is run all the same, but the visit is
// counted in the environment, and the app gives up when it is back at a file it has run or
// has made sixteen visits. In a pane it also folds its hooks into the --settings of a Claude
// Code session. This stand-in is written for these tests and names no real app.
const PANE = '11111111-2222-4333-8444-555555555555';
const FOLD = 'const fs=require("fs");let all={hooks:{Stop:[{matcher:"",hooks:[{type:"command",command:"true"}]}]}};for(const given of process.argv.slice(1)){const own=given.trim().startsWith("{")?JSON.parse(given):JSON.parse(fs.readFileSync(given,"utf8"));all={...all,...own,hooks:{...all.hooks,...(own.hooks||{})}};}process.stdout.write(JSON.stringify(all));';
const appScript = prog => `#!/usr/bin/env bash
prog=${prog}
here=$(cd "$(dirname "$0")" && pwd)
count_var=TERMAPP_${prog.toUpperCase()}_VISITS; seen_var=TERMAPP_${prog.toUpperCase()}_VISITED
count=\${!count_var:-0}; seen=\${!seen_var:-}
case $count in *[!0-9]*) count=0; seen=;; esac
# One of the app's own files: this script, or a pane's script for the command.
mine() { [[ $1 -ef $0 ]] || [[ $1 == */termapp-panes/*/$prog ]]; }
next_one() {
  local dir IFS=:
  for dir in $PATH; do
    [[ $dir == "$here" ]] && continue
    mine "$dir/$prog" && continue
    [[ -f $dir/$prog && -x $dir/$prog ]] && { printf '%s' "$dir/$prog"; return 0; }
  done
  return 1
}
# Whether a file reads like another tool's script that hands on to the command by name.
hands_on() {
  [[ $(head -c 2 "$1" 2>/dev/null) == '#!' ]] || return 1
  head -n 200 "$1" | grep -q -e "exec $prog" && return 0
  head -n 200 "$1" | grep -q -e "=$prog\\$" && head -n 200 "$1" | grep -q -e 'exec "\\$'
}
go() {
  local target=$1; shift
  if hands_on "$target"; then
    if [[ $'\\n'$seen$'\\n' == *$'\\n'"$target"$'\\n'* ]] || (( count >= 16 )); then
      echo "termapp: gave up: the $prog command keeps coming back to this script." >&2
      echo "Another tool's script for $prog on PATH hands it back." >&2
      exit 126
    fi
    export $count_var=$((count + 1)) $seen_var="\${seen:+$seen$'\\n'}$target"
  else
    unset $count_var $seen_var
  fi
  exec "$target" "$@"
}
target=$(next_one) || { echo "termapp: no $prog on PATH" >&2; exit 127; }
echo "$prog visits=$count real=$target pane=\${TERMAPP_PANE:+yes}" >> "$here/visits.log"
if [[ $prog == claude && -n \${TERMAPP_PANE:-} && $count == 0 ]]; then
  case \${1:-} in -v|--version|-h|--help|auth|mcp|config|doctor|update|install) ;; *)
    own=(); rest=(); want=0
    for arg in "$@"; do
      if [[ $want == 1 ]]; then own+=("$arg"); want=0; elif [[ $arg == --settings ]]; then want=1; else rest+=("$arg"); fi
    done
    folded=$("$TERMAPP_NODE" -e '${FOLD}' "\${own[@]}") && set -- --settings "$folded" "\${rest[@]}"
  ;; esac
fi
go "$target" "$@"
`;
// The app, with a pane's scripts for these commands. The pane's folder is named through a
// link, as the temporary folder is on macOS; ELU starts a program by its path on disk.
function terminalApp(parent, vendors) {
  const bin = path.join(parent, 'TermApp', 'bin'), real = path.join(parent, 'tmp-real'), link = path.join(parent, 'tmp-link');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(real); fs.symlinkSync(real, link);
  const pane = path.join(link, 'termapp-panes', PANE); fs.mkdirSync(pane, { recursive: true });
  for (const prog of vendors) {
    fs.writeFileSync(path.join(bin, `termapp-${prog}`), appScript(prog), { mode: 0o755 });
    fs.writeFileSync(path.join(pane, prog), `#!/usr/bin/env bash\nexec ${JSON.stringify(path.join(bin, `termapp-${prog}`))} "$@"\n`, { mode: 0o700 });
  }
  const log = path.join(bin, 'visits.log');
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
  environment(t, { ...fake.env, PATH: [app.pane, fake.env.PATH, app.bin].join(path.delimiter), HOME: p.parent, TERMAPP_NODE: process.execPath, TERMAPP_PANE: PANE,
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
  assert.deepEqual(f.app.visits().map(row => row.split(' ').slice(0, 3).join(' ')), SHIM_VENDORS.map(vendor => `${vendor} visits=0 real=${path.join(f.fake.dir, vendor)}`));
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
      for (const row of visits) assert.match(row, new RegExp(`^${vendor} visits=0 real=${f.real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `), row);
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

// An update on a computer that ran the version before: its stand-in for the claude command is
// still in the folder with the others, where the wrapper would find it first.
test('a claude stand-in that an earlier version left beside the others is removed before the next turn, which runs', async t => {
  const f = setup(t, 'claude'), left = path.join(shimFolder('git'), 'claude');
  shimPath(process.env.PATH);
  fs.writeFileSync(left, '#!/bin/sh\nexec claude "$@"\n', { mode: 0o755 });
  const task = await f.controller.ask('Where is coupon normalization?', null, { permissions: 'ask' }).finished;
  assert.equal(task.state, 'answered', JSON.stringify(task.error));
  assert.equal(fs.existsSync(left), false);
  assert.ok(fs.existsSync(path.join(shimFolder('claude'), 'claude')), 'the stand-in for claude is in its own folder');
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

// A vendor's program that never began: it could not be started, or a script in front of it
// ended first. The chat says so in plain words and what to do; what the script printed follows.
const GIVES_UP = 'termapp: gave up: the %s command keeps coming back to this script.';
// turn: what only the launch of a turn has among its arguments.
const givesUp = (f, vendor, turn) => fs.writeFileSync(path.join(f.app.pane, vendor), `#!/bin/sh\ncase " $* " in ${turn}) ;; *) exec ${JSON.stringify(f.real)} "$@";; esac\necho "${GIVES_UP.replace('%s', vendor)}" >&2\necho "second line" >&2\nexit 126\n`, { mode: 0o700 });
test('a turn whose vendor program did not start says so in plain words, then what its command printed, then what to do', async t => {
  const f = setup(t, 'claude');
  // Another tool's script in front of the real program that answers for it until a turn starts, then gives up.
  givesUp(f, 'claude', "' -p '*");
  const { id, finished } = f.controller.ask('Where is coupon normalization?', null, { permissions: 'ask' });
  const said = 'The model could not run: Claude Code did not start. The claude command said: termapp: gave up: the claude command keeps coming back to this script.';
  await assert.rejects(finished, { message: said });
  const task = readTask(f.controller.repo, id);
  assert.equal(task.state, 'blocked'); assert.equal(task.error.message, said); assert.equal(task.error.cause, 'not-started');
  assert.equal(task.runs.length, 1, 'a program that did not start is not started a second time');
  const line = stopLine(task);
  assert.equal(line.text, `${said} Check that claude runs in your terminal, then type continue.`);
  assert.equal(line.action, 'Check that claude runs in your terminal, then type continue.'); assert.equal(line.short, 'check that claude runs in your terminal, then type continue');
});
test('a Codex program that cannot be run when its turn starts is named, with what the shell said of it', async t => {
  const f = setup(t, 'codex', { wrapped: ['claude'] }), real = path.join(f.fake.dir, 'codex');
  // It answers for its version and its flags, then cannot be run: the file it hands to is gone.
  fs.renameSync(real, `${real}-real`);
  fs.writeFileSync(real, `#!/bin/sh\ncase " $* " in *' --help '*) ;; ' exec '*) exec ${JSON.stringify(path.join(f.parent, 'gone', 'codex'))} "$@";; esac\nexec "$0-real" "$@"\n`, { mode: 0o755 });
  const { id, finished } = f.controller.ask('Where is coupon normalization?', null, { permissions: 'full' });
  await assert.rejects(finished, { message: /^The model could not run: Codex did not start\. The codex command said: .*gone\/codex/ });
  const task = readTask(f.controller.repo, id);
  assert.equal(task.error.cause, 'not-started');
  assert.match(stopLine(task).text, /^The model could not run: Codex did not start\. The codex command said: .*gone\/codex.* Check that codex runs in your terminal, then type continue\.$/);
});
test('a Grok Build program that gives up as its live turn starts is named the same way', async t => {
  const f = setup(t, 'grok'); PREPARE.grok(f);
  givesUp(f, 'grok', "*' agent stdio '");
  atomic(path.join(personalDirectory(), 'conformance', 'grok.json'), { v: 1, bin: findBin('grok'), version: '1.0.77', steps: Object.fromEntries(ADAPTERS.grok.conformance.map(step => [step.id, 'pass'])), relay: true, at: new Date().toISOString() });
  const { id, finished } = f.controller.ask('Where is coupon normalization?', null, { permissions: 'ask' });
  const said = 'The model could not run: Grok Build did not start. The grok command said: termapp: gave up: the grok command keeps coming back to this script.';
  await assert.rejects(finished, { message: said });
  assert.equal(stopLine(readTask(f.controller.repo, id)).text, `${said} Check that grok runs in your terminal, then type continue.`);
});
// A vendor that started and then failed keeps the words it had: this is not that.
test('a vendor that started and then ended with an error is still said as could not finish', async t => {
  const f = setup(t, 'claude');
  fs.writeFileSync(path.join(f.app.pane, 'claude'), `#!/bin/sh\ncase " $* " in ' -p '*) ;; *) exec ${JSON.stringify(f.real)} "$@";; esac\necho "Error: sandbox required but unavailable" >&2\nexit 1\n`, { mode: 0o700 });
  const { finished } = f.controller.ask('Where is coupon normalization?', null, { permissions: 'ask' });
  await assert.rejects(finished, { message: 'The model could not finish. Error: sandbox required but unavailable' });
});
