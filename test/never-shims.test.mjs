import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { temp } from './helpers.mjs';
import { NEVER_COMMANDS, neverSentence, refusedIn } from '../lib/never-list.mjs';
import { REFUSED, SHIM_VENDORS, scratchRoots, shimEnvFile, shimPath, shimScripts, shimsBase, withoutShims, writeShims } from '../lib/never-shims.mjs';

// The stand-ins in a throwaway folder, beside stub "real" commands that print what they got.
// The stub git cannot say where a push would go or which repository a call acts on, so
// nothing of the never list passes as local work here; the tests with the real git are below.
const BLIND = `case " $* " in *' get-url '*|*' rev-parse '*|*' config '*|*' ls-remote '*|*' symbolic-ref '*|*' remote ') exit 128;; esac\n`;
function setup(t) {
  const dir = temp(t), was = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(dir, 'data');
  t.after(() => { if (was === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = was; });
  const real = path.join(dir, 'real'); fs.mkdirSync(real);
  for (const name of Object.keys(shimScripts())) fs.writeFileSync(path.join(real, name), `#!/bin/sh\n${name === 'git' ? BLIND : ''}printf 'REAL ${name}'; for a do printf ' [%s]' "$a"; done; echo\n`, { mode: 0o755 });
  const call = (folder, [name, ...args], PATH = `${folder}${path.delimiter}${real}`) => { const r = spawnSync(path.join(folder, name), args, { env: { PATH }, encoding: 'utf8' }); return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() }; };
  const passed = ([name, ...args]) => ({ code: 0, out: ['REAL', name, ...args.map(arg => `[${arg}]`)].join(' ') });
  return { dir, real, call, passed, all: writeShims(), merge: writeShims({ merge: true }) };
}
const words = line => line.split(' ');

test('every never-list command is refused by its stand-in, in the words of the Blocked line', t => {
  const f = setup(t);
  assert.deepEqual(Object.keys(shimScripts()).sort(), [...new Set(NEVER_COMMANDS.map(command => command.split(' ')[0]))].sort(), 'one stand-in per command word');
  for (const command of NEVER_COMMANDS) {
    // git tag alone lists tags and passes; that is the next test.
    for (const line of command === 'git tag' ? ['git tag v1', 'git tag origin --force'] : [command, `${command} origin --force`]) {
      const got = f.call(f.all, words(line));
      assert.deepEqual(got, { code: REFUSED, out: `${neverSentence(command)}.` }, line);
      assert.equal(refusedIn(`before\n${got.out}\nafter`), command, line);
    }
  }
  assert.equal(refusedIn('git push is not allowed outside Full access'), null, 'the sentence without its full stop is someone quoting it');
  assert.equal(refusedIn('docs say: git push is not allowed outside Full access.'), null, 'only a line of its own counts');
});

test('a stand-in reads the command the way the tool does, not as text', t => {
  const f = setup(t);
  const refused = {
    'git -C dir push': 'git push', 'git -c a=b push': 'git push', 'git --git-dir=x push': 'git push', 'git --git-dir x push origin': 'git push', 'git --no-pager merge main': 'git merge', 'git -c user.name=x -C dir merge': 'git merge',
    'gh -R o/r pr merge 5': 'gh pr merge', 'gh pr -R o/r merge': 'gh pr merge', 'gh --repo o/r release create v1': 'gh release',
    'npm --registry x publish': 'npm publish', 'pnpm -r publish': 'pnpm publish', 'cargo +nightly publish': 'cargo publish',
    'gcloud --project p run deploy': 'gcloud run deploy', 'gcloud run --region x deploy svc': 'gcloud run deploy', 'gcloud beta run deploy svc': 'gcloud run deploy', 'gcloud --quiet app deploy': 'gcloud app deploy',
    'kubectl -n ns apply -f x': 'kubectl apply', 'terraform -chdir=x apply': 'terraform apply', 'firebase --project p deploy --only hosting': 'firebase deploy',
    'claude mcp --scope user add x https://x': 'claude mcp add', 'claude --debug mcp add-json x {}': 'claude mcp add-json', 'claude mcp remove -s user x': 'claude mcp remove', 'elu mcp add x https://x': 'elu mcp add',
  };
  for (const [line, command] of Object.entries(refused)) assert.deepEqual(f.call(f.all, words(line)), { code: REFUSED, out: `${neverSentence(command)}.` }, line);
  for (const line of ['git merge-base HEAD main', 'git tag-list', 'git log --grep push', 'git stash push', 'git -C push status', 'git status', 'git',
    'gh pr view 5', 'gh pr list --search merge', 'gh issue list release', 'npm run publish', 'npm install publish', 'npm --prefix dir run test', 'yarn publish-docs', 'cargo build',
    'gcloud run services list', 'kubectl get pods', 'terraform plan', 'vercel ls', 'fly status', 'firebase emulators:start',
    'claude mcp list', 'claude mcp get elu', 'claude -p hello', 'elu mcp', 'elu status']) assert.deepEqual(f.call(f.all, words(line)), f.passed(words(line)), line);
  // The arguments reach the real command as they were written.
  for (const line of [['git', 'commit', '-m', 'git push'], ['git', 'status', '', 'a b', '*', "it's", '$HOME', '-C']]) assert.deepEqual(f.call(f.all, line), f.passed(line), line.join(' '));
});

test('listing tags passes; every other git tag is refused', t => {
  const f = setup(t);
  for (const line of ['git tag', 'git tag -l', 'git tag --list v*', 'git -C dir tag -l']) assert.deepEqual(f.call(f.all, words(line)), f.passed(words(line)), line);
  for (const line of ['git tag v1', 'git tag -d v1', 'git tag -a v1 -m x', 'git tag -f v1', 'git -C dir tag v1']) assert.deepEqual(f.call(f.all, words(line)), { code: REFUSED, out: `${neverSentence('git tag')}.` }, line);
});

test('a bot allowed to merge gets no refusal for gh pr merge, and still one for the rest', t => {
  const f = setup(t);
  assert.deepEqual(f.call(f.merge, words('gh pr merge 5')), f.passed(words('gh pr merge 5')));
  assert.deepEqual(f.call(f.merge, words('gh -R o/r pr merge 5')), f.passed(words('gh -R o/r pr merge 5')));
  assert.deepEqual(f.call(f.merge, words('gh release create v1')), { code: REFUSED, out: `${neverSentence('gh release')}.` });
  assert.deepEqual(f.call(f.merge, words('git push')), { code: REFUSED, out: `${neverSentence('git push')}.` });
  assert.deepEqual(f.call(f.all, words('gh pr merge 5')), { code: REFUSED, out: `${neverSentence('gh pr merge')}.` });
});

test('the real command is the first one outside the stand-in folders, and a missing one says so', t => {
  const f = setup(t), join = (...dirs) => dirs.join(path.delimiter);
  assert.deepEqual(f.call(f.all, ['git', 'status'], join(f.all, f.all, f.merge, f.real)), f.passed(['git', 'status']), 'neither itself nor the other folder');
  assert.deepEqual(f.call(f.merge, ['gh', 'pr', 'merge'], join(f.merge, f.all, f.real)), f.passed(['gh', 'pr', 'merge']), 'the other folder is not the real command');
  assert.deepEqual(f.call(f.all, ['git', 'status'], f.all), { code: 127, out: 'git: command not found' });
  assert.deepEqual(f.call(f.all, ['git', 'status'], ''), { code: 127, out: 'git: command not found' });
  assert.deepEqual(f.call(f.all, ['git', 'push'], f.all), { code: REFUSED, out: `${neverSentence('git push')}.` }, 'refused before the real command is looked for');
});

test('the folder is private, first on PATH once, and written again when anything in it changed', t => {
  const f = setup(t), mode = file => (fs.statSync(file).mode & 0o777).toString(8);
  assert.equal(path.dirname(f.all), shimsBase()); assert.equal(path.dirname(f.merge), shimsBase());
  assert.deepEqual([shimsBase(), f.all, f.merge].map(mode), ['700', '700', '700']);
  for (const name of fs.readdirSync(f.all)) assert.equal(mode(path.join(f.all, name)), '755', name);
  assert.equal(shimPath(['/usr/bin', f.merge, f.all, '/bin'].join(path.delimiter)), [f.all, '/usr/bin', '/bin'].join(path.delimiter));
  assert.equal(shimPath(['/usr/bin', f.all].join(path.delimiter), { merge: true }), [f.merge, '/usr/bin'].join(path.delimiter));
  // Full access: no stand-in folder at all, not even one an outer session left on PATH.
  assert.equal(withoutShims(['/usr/bin', f.merge, f.all, shimsBase(), '/bin'].join(path.delimiter)), ['/usr/bin', '/bin'].join(path.delimiter));
  // The folder goes on the PATH a session is given and nowhere else: ELU's own checks run the real commands.
  const mine = process.env.PATH; shimPath(mine); assert.equal(process.env.PATH, mine); assert.equal(mine.split(path.delimiter).some(entry => entry.startsWith(shimsBase())), false);
  // What a session left behind: a changed stand-in, a link in its place, a program of its own.
  const git = path.join(f.all, 'git'), text = fs.readFileSync(git, 'utf8'), before = fs.statSync(path.join(f.all, 'npm')).mtimeMs;
  fs.writeFileSync(git, '#!/bin/sh\nexec /usr/bin/git "$@"\n'); fs.rmSync(path.join(f.all, 'gh')); fs.symlinkSync('/bin/echo', path.join(f.all, 'gh'));
  fs.writeFileSync(path.join(f.all, 'ls'), '#!/bin/sh\n', { mode: 0o755 }); fs.chmodSync(f.all, 0o755);
  shimPath('/usr/bin');
  assert.equal(fs.readFileSync(git, 'utf8'), text); assert.equal(fs.lstatSync(path.join(f.all, 'gh')).isFile(), true); assert.equal(fs.existsSync(path.join(f.all, 'ls')), false); assert.equal(mode(f.all), '700');
  assert.equal(fs.statSync(path.join(f.all, 'npm')).mtimeMs, before, 'a stand-in that already says the same is left alone');
  assert.deepEqual(f.call(f.all, ['git', 'push']), { code: REFUSED, out: `${neverSentence('git push')}.` });
});

// The stand-in for git in front of the real git, in scratch repositories. tmp stands for the
// system temporary directory and other for anywhere else; both are throwaway folders.
function withGit(t) {
  const dir = fs.realpathSync(temp(t)), was = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(dir, 'data');
  t.after(() => { if (was === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = was; });
  const tmp = path.join(dir, 'tmp'), other = path.join(dir, 'other'), settings = path.join(dir, 'gitconfig');
  for (const folder of [tmp, other, path.join(dir, 'home')]) fs.mkdirSync(folder); fs.writeFileSync(settings, '');
  const gitDir = process.env.PATH.split(path.delimiter).find(entry => entry && !entry.startsWith(shimsBase()) && fs.existsSync(path.join(entry, 'git')));
  const folder = writeShims({ roots: [tmp] });
  const env = { PATH: [folder, gitDir, '/usr/bin', '/bin'].join(path.delimiter), HOME: path.join(dir, 'home'), TMPDIR: os.tmpdir(), GIT_CONFIG_GLOBAL: settings, GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const real = (cwd, ...args) => { const r = spawnSync(path.join(gitDir, 'git'), args, { cwd, env, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
  const git = (cwd, ...args) => { const r = spawnSync(path.join(folder, 'git'), args, { cwd, env, encoding: 'utf8' }); return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() }; };
  const repo = (where, { bare = false } = {}) => {
    fs.mkdirSync(where, { recursive: true }); real(where, 'init', '--quiet', '--initial-branch=main', ...(bare ? ['--bare'] : []));
    if (!bare) { fs.writeFileSync(path.join(where, 'a.txt'), 'a\n'); real(where, 'add', '.'); real(where, 'commit', '--quiet', '-m', 'one'); real(where, 'branch', 'side'); }
    return where;
  };
  const refused = command => ({ code: REFUSED, out: `${neverSentence(command)}.` });
  // Passed: the real git got the call, whatever it then made of it.
  const passed = (got, label) => { assert.notEqual(got.code, REFUSED, `${label}: ${got.out}`); assert.equal(refusedIn(got.out), null, label); };
  return { tmp, other, settings, real, git, repo, refused, passed };
}
const HOST = 'ssh://git.invalid/sample.git';

test('the file Claude Code runs ahead of each command puts the folder back in front of the system folders', t => {
  const f = setup(t), file = shimEnvFile(), merge = shimEnvFile({ merge: true });
  assert.deepEqual([...SHIM_VENDORS].sort(), ['agy', 'claude', 'codex', 'grok']);
  assert.equal(path.dirname(file), shimsBase()); assert.notEqual(file, merge);
  // A shell whose PATH was built again with other folders first, as Claude Code's is from its
  // snapshot of the owner's shell setup; then the file, then the command.
  const run = (named, command, start = [f.real, f.all, f.merge].join(path.delimiter)) => { const r = spawnSync('/bin/sh', ['-c', `PATH=${JSON.stringify(start)}\n${fs.readFileSync(named, 'utf8')}\n${command}`], { encoding: 'utf8' }); return `${r.stdout}${r.stderr}`.trim(); };
  assert.equal(run(file, 'command -v git'), path.join(f.all, 'git')); assert.equal(run(merge, 'command -v gh'), path.join(f.merge, 'gh'));
  assert.equal(run(file, 'git push 2>&1; echo $?'), `${neverSentence('git push')}.\n${REFUSED}`);
  assert.equal(run(file, 'git status'), 'REAL git [status]', 'every other call still reaches the real command');
  // A session in Full access can rewrite the file; the next launch writes it again, and leaves one that says the same alone.
  fs.writeFileSync(file, 'export PATH=/elsewhere\n'); assert.equal(shimEnvFile(), file); assert.equal(run(file, 'command -v git'), path.join(f.all, 'git'));
  fs.rmSync(file); fs.symlinkSync('/etc/hosts', file); shimEnvFile(); assert.equal(fs.lstatSync(file).isFile(), true);
  const before = fs.statSync(file).mtimeMs; shimEnvFile(); assert.equal(fs.statSync(file).mtimeMs, before);
  assert.equal(fs.existsSync(path.join(f.all, 'git')), true, 'the file sits beside the folder, not in it');
  // A data folder whose name needs quoting.
  process.env.XDG_DATA_HOME = path.join(f.dir, "it's here");
  const odd = shimEnvFile(), folder = path.join(shimsBase(), 'all');
  assert.equal(run(odd, 'command -v git', f.real), path.join(folder, 'git')); assert.equal(run(odd, 'git push 2>&1; echo $?', f.real), `${neverSentence('git push')}.\n${REFUSED}`);
});

test('a push passes when git says it goes to a folder on this machine, however the remote is written', t => {
  const f = withGit(t), bare = f.repo(path.join(f.tmp, 'bare.git'), { bare: true }), work = f.repo(path.join(f.other, 'work'));
  const heads = () => f.real(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort();
  f.real(work, 'remote', 'add', 'origin', bare);
  f.passed(f.git(work, 'push', 'origin', 'HEAD:refs/heads/a'), 'a remote that is a path'); assert.deepEqual(heads(), ['a'], 'the real git pushed');
  f.passed(f.git(work, 'push', '-u', 'origin', 'main'), '-u'); f.passed(f.git(work, 'push', '-fq', 'origin', 'main'), 'short options together');
  f.passed(f.git(work, 'push', '-o', 'ci.skip', 'origin', 'main'), 'the value of -o is not the remote');
  f.passed(f.git(work, 'push', '--all'), 'no remote named, and the only remote is a path');
  f.passed(f.git(f.tmp, '-C', work, 'push', 'origin', 'side'), 'git -C from another folder');
  f.passed(f.git(work, 'push', bare, 'HEAD:refs/heads/b'), 'a path on the command line'); f.passed(f.git(work, 'push', path.relative(work, bare).replace(/^(?!\.)/, './'), 'HEAD:refs/heads/c'), 'a relative path');
  f.passed(f.git(work, 'push', `file://${bare}`, 'HEAD:refs/heads/d'), 'a file URL');
  f.real(work, 'remote', 'set-url', 'origin', `file://${bare}`); f.passed(f.git(work, 'push', 'origin', 'HEAD:refs/heads/e'), 'a remote that is a file URL');
  f.real(work, 'remote', 'add', 'hub', HOST); f.passed(f.git(work, 'push'), 'two remotes, none named: origin, which is local');
  assert.deepEqual(heads(), ['a', 'b', 'c', 'd', 'e', 'main', 'side']);
});

test('a push to anywhere else, or one git cannot place, is refused before anything is sent', t => {
  const f = withGit(t), bare = f.repo(path.join(f.tmp, 'bare.git'), { bare: true }), work = f.repo(path.join(f.tmp, 'work')), no = f.refused('git push');
  const set = (key, value) => f.real(work, 'config', key, value), unset = key => f.real(work, 'config', '--unset', key);
  // What the command line names.
  for (const where of [HOST, 'https://git.invalid/sample.git', 'git.invalid:sample.git', 'git@git.invalid:team/sample.git', 'ext::sh -c true', 'bare.git', 'nowhere']) assert.deepEqual(f.git(work, 'push', where, 'main'), no, where);
  // What the remote says.
  f.real(work, 'remote', 'add', 'origin', HOST);
  assert.deepEqual(f.git(work, 'push', 'origin', 'main'), no, 'a remote on another machine'); assert.deepEqual(f.git(work, 'push'), no, 'the same with no remote named'); assert.deepEqual(f.git(f.other, '-C', work, 'push', '--all'), no);
  f.real(work, 'remote', 'set-url', 'origin', bare); f.passed(f.git(work, 'push', 'origin', 'main'), 'origin is now a path');
  f.real(work, 'remote', 'set-url', '--push', 'origin', HOST); assert.deepEqual(f.git(work, 'push', 'origin', 'main'), no, 'remote.origin.pushurl names a host'); unset('remote.origin.pushurl');
  assert.deepEqual(f.git(work, '-c', `remote.origin.pushurl=${HOST}`, 'push', 'origin', 'main'), no, 'the same given with -c');
  // A rule that rewrites the path to a host, for the remote and for a path on the command line.
  for (const rule of ['pushInsteadOf', 'insteadOf']) {
    set(`url.ssh://git.invalid/.${rule}`, `${f.tmp}/`);
    assert.deepEqual(f.git(work, 'push', 'origin', 'main'), no, `${rule}, the remote`); assert.deepEqual(f.git(work, 'push', bare, 'main'), no, `${rule}, a path`);
    unset(`url.ssh://git.invalid/.${rule}`);
  }
  // Where a push with no remote named goes.
  f.real(work, 'remote', 'add', 'hub', HOST);
  for (const key of ['branch.main.pushRemote', 'remote.pushDefault', 'branch.main.remote']) { set(key, 'hub'); assert.deepEqual(f.git(work, 'push'), no, key); unset(key); }
  f.passed(f.git(work, 'push'), 'with none of them set it is origin again');
  // Submodules pushed on demand go to their own remotes.
  for (const [key, value] of [['push.recurseSubmodules', 'on-demand'], ['submodule.recurse', 'true']]) { set(key, value); assert.deepEqual(f.git(work, 'push', 'origin', 'main'), no, key); unset(key); }
  // An option that can send it elsewhere, or one this script does not know.
  for (const option of ['--receive-pack=git-receive-pack', '--exec=git-receive-pack', '--repo=origin', '--recurse-submodules=on-demand', '--rec', '--frobnicate', '-fx']) assert.deepEqual(f.git(work, 'push', option, 'origin', 'main'), no, option);
  // A name or a path that the user's own Git settings make a remote.
  fs.writeFileSync(f.settings, `[remote "far"]\n\turl = ${HOST}\n[remote "${bare}"]\n\tpushurl = ${HOST}\n`);
  assert.deepEqual(f.git(work, 'push', 'far', 'main'), no); assert.deepEqual(f.git(work, 'push', bare, 'main'), no);
  fs.writeFileSync(f.settings, ''); f.passed(f.git(work, 'push', bare, 'main'), 'the path alone');
  assert.deepEqual(f.git(f.tmp, 'push', 'origin'), no, 'outside any repository');
});

test('git tag and git merge pass in a scratch repository under the temporary directory, and nowhere else', t => {
  const f = withGit(t), work = f.repo(path.join(f.tmp, 'work')), kept = f.repo(path.join(f.other, 'kept')), bare = f.repo(path.join(f.tmp, 'bare.git'), { bare: true });
  assert.deepEqual(scratchRoots(), [...new Set([fs.realpathSync(os.tmpdir()), fs.realpathSync('/tmp')])], 'the system temporary directory, links resolved');
  f.passed(f.git(work, 'tag', 'v1'), 'tag'); assert.equal(f.real(work, 'tag', '-l'), 'v1'); f.passed(f.git(work, 'tag', '-d', 'v1'), 'tag -d'); assert.equal(f.real(work, 'tag', '-l'), '');
  f.passed(f.git(work, 'merge', '--quiet', 'side'), 'merge'); f.passed(f.git(f.other, '-C', work, 'tag', '-a', 'v2', '-m', 'two'), 'git -C from elsewhere');
  f.real(work, 'push', '--quiet', bare, 'main'); f.passed(f.git(f.other, `--git-dir=${bare}`, 'tag', 'v3', 'main'), 'a bare repository there'); assert.equal(f.real(bare, 'tag', '-l'), 'v3');
  for (const args of [['tag', 'v1'], ['tag', '-d', 'v1'], ['tag', '-a', 'v1', '-m', 'one'], ['merge', 'side'], ['merge', '--abort']]) assert.deepEqual(f.git(kept, ...args), f.refused(`git ${args[0]}`), `elsewhere: git ${args.join(' ')}`);
  f.passed(f.git(kept, 'tag', '-l'), 'a listing passes anywhere'); assert.equal(f.real(kept, 'tag', '-l'), '', 'nothing was made');
  // A worktree under the temporary directory of a repository kept elsewhere is that repository.
  const tree = path.join(f.tmp, 'tree'); f.real(kept, 'worktree', 'add', '--quiet', tree, 'side');
  assert.deepEqual(f.git(tree, 'tag', 'v1'), f.refused('git tag')); assert.deepEqual(f.git(tree, 'merge', 'main'), f.refused('git merge'));
  // Links are resolved first, both ways.
  const out = path.join(f.tmp, 'out'), inside = path.join(f.other, 'in'); fs.symlinkSync(kept, out); fs.symlinkSync(work, inside);
  assert.deepEqual(f.git(out, 'tag', 'v1'), f.refused('git tag'), 'a link under the temporary directory to a repository elsewhere'); assert.deepEqual(f.git(f.tmp, '-C', out, 'merge', 'side'), f.refused('git merge'));
  f.passed(f.git(inside, 'tag', 'v4'), 'a link elsewhere to a scratch repository'); assert.deepEqual(f.real(work, 'tag', '-l').split('\n'), ['v2', 'v4']);
  assert.deepEqual(f.git(f.tmp, 'tag', 'v1'), f.refused('git tag'), 'not a repository'); assert.equal(f.real(kept, 'tag', '-l'), '');
});
