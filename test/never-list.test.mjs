import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { NEVER_COMMANDS, liftedBy, neverCommands, neverLine, neverPart, shellParts, whyBlocked } from '../lib/never-list.mjs';
import { NEVER_RULES } from '../lib/adapters/claude.mjs';
import { personalDirectory } from '../lib/util.mjs';

test('the never list in words is the list the rules refuse, and the line for the model names each command once', () => {
  assert.deepEqual(NEVER_COMMANDS.map(command => `Bash(${command}:*)`), [...NEVER_RULES]);
  const line = neverLine();
  assert.ok(line.startsWith(`Never run these, alone or inside a longer command line, in any mode: ${NEVER_COMMANDS.join(', ')}. To list tags`));
  assert.match(line, /To list tags use git for-each-ref --sort=-creatordate refs\/tags or git describe --tags, never git tag\.$/);
  assert.ok(line.length <= 520, `${line.length} characters`);
  // A bot the owner lets merge pull requests is not told gh pr merge is off its list.
  assert.equal(neverCommands({ merge: true }).includes('gh pr merge'), false); assert.doesNotMatch(neverLine({ merge: true }), /gh pr merge/); assert.match(neverLine({ merge: true }), /git merge,/);
});

test('a shell line is read part by part: operators, substitutions and subshells split it, quotes do not', () => {
  assert.deepEqual(shellParts('cd /srv/app && git log --oneline | head -3; git tag'), ['cd /srv/app', 'git log --oneline', 'head -3', 'git tag']);
  assert.deepEqual(shellParts('echo "$(git tag -l)" 2>&1 || true'), ['git tag -l', 'echo "" 2>&1', 'true']);
  assert.deepEqual(shellParts("git commit -m 'a; b && c' &"), ["git commit -m 'a; b && c'"]);
  assert.deepEqual(shellParts('(cd x; git push)\nls `git tag`'), ['cd x', 'git push', 'git tag', 'ls']);
});

test('a never-list command is found alone, as a part of a longer line, in a substitution and behind a wrapper', () => {
  const found = [
    ['cd /srv/app && git log --since="1 week ago" --oneline | wc -l; git merge-base HEAD origin/main; git tag --sort=-creatordate | head -3', 'git tag'],
    ['git tag', 'git tag'], ['git  push   origin main', 'git push'], ['echo "last: $(git tag -l | tail -1)"', 'git tag'], ['ls `git tag`', 'git tag'],
    ['(cd pkg && npm publish)', 'npm publish'], ['for t in a b; do git tag $t; done', 'git tag'], ['if true; then gh release list; fi', 'gh release'],
    ['timeout 30 git push origin main', 'git push'], ['timeout --signal=TERM -k 5 30 git push', 'git push'], ['CI=1 nice -n 5 npm publish', 'npm publish'],
    ['nohup terraform apply -auto-approve &', 'terraform apply'], ['ls | xargs git tag', 'git tag'], ['command git merge main', 'git merge'], ['gh pr merge 12 --squash', 'gh pr merge'],
  ];
  for (const [line, command] of found) assert.equal(neverPart(line), command, line);
  // What the rule's text does not match is not claimed: another word, another spelling, quoted text.
  for (const line of ['git merge-base HEAD origin/main', 'git tagger', 'git log --tags', 'git -C . push', "bash -c 'git push'", 'echo "run git tag later"', "git commit -m 'x; git tag y'", 'ls | xargs -n1 git tag', 'command -v git tag', 'gh pr view 12', 'npm run publish', 'gcloud run services list']) assert.equal(neverPart(line), null, line);
  // A here-document's body is text; a line with one is not read.
  assert.equal(neverPart('cat <<EOF\ngit tag v1\nEOF'), null);
  assert.equal(neverPart('gh pr merge 12', { merge: true }), null); assert.equal(neverPart('git merge main', { merge: true }), 'git merge');
});

test('why an action was refused, in every mode: the never list, a closed file, the owner, the sandbox, the mode, or a rule it cannot name', t => {
  const home = process.env.HOME, config = process.env.XDG_CONFIG_HOME; process.env.HOME = '/home/owner'; delete process.env.XDG_CONFIG_HOME;
  t.after(() => { process.env.HOME = home; if (config === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = config; });
  assert.equal(os.homedir(), '/home/owner');
  const run = command => ({ tool: 'Bash', input: { command } }), claude = mode => ({ mode, vendor: 'claude' });
  assert.deepEqual(whyBlocked(run('cd x; git tag | head -3'), claude('full')), { kind: 'never', command: 'git tag', line: 'cd x; git tag | head -3', alone: false });
  assert.deepEqual(whyBlocked(run('git push origin main'), claude('ask')), { kind: 'never', command: 'git push', line: 'git push origin main', alone: true });
  // Where the vendor has no rule for the list, a stand-in command refuses it in every mode: no mode lets it through.
  assert.deepEqual(whyBlocked({ tool: 'command_execution', summary: 'Run: git push origin main' }, { mode: 'ask', vendor: 'codex' }), { kind: 'never', command: 'git push', line: 'git push origin main', alone: true });
  assert.deepEqual(whyBlocked({ tool: 'run_command', summary: 'Run: cd x && git push' }, { mode: 'auto', vendor: 'grok' }), { kind: 'never', command: 'git push', line: 'cd x && git push', alone: false });
  // A step a stand-in command refused: the adapter names the command, and the line is shown without the vendor's shell around it.
  assert.deepEqual(whyBlocked({ tool: 'command_execution', summary: "Run: /bin/zsh -c 'git push origin HEAD'", never: 'git push' }, { mode: 'full', vendor: 'codex' }), { kind: 'never', command: 'git push', line: 'git push origin HEAD', alone: true });
  assert.deepEqual(whyBlocked({ tool: 'command_execution', summary: "Run: /bin/zsh -lc 'sh ./sync.sh'", never: 'npm publish' }, { mode: 'ask', vendor: 'codex' }), { kind: 'never', command: 'npm publish', line: 'sh ./sync.sh', alone: false });
  assert.notEqual(whyBlocked({ tool: 'command_execution', summary: 'Run: ls', never: 'ls' }, { mode: 'ask', vendor: 'codex' }).kind, 'never', 'only a command of the list is taken at its word');
  // Claude Code: its rule read the model's line and found nothing; the stand-in refused inside the script.
  assert.deepEqual(whyBlocked({ tool: 'Bash', input: { command: 'npm test 2>&1' }, tool_use_id: 'toolu_1', never: 'git push' }, { mode: 'ask', vendor: 'claude' }), { kind: 'never', command: 'git push', line: 'npm test 2>&1', alone: false });
  // Files every mode keeps closed.
  assert.deepEqual(whyBlocked({ tool: 'Read', input: { file_path: '/srv/app/.env.local' } }, claude('auto')), { kind: 'secret' });
  assert.deepEqual(whyBlocked({ tool: 'Grep', input: { path: '/home/owner/.aws' } }, claude('full')), { kind: 'secret' });
  assert.deepEqual(whyBlocked({ tool: 'Edit', input: { file_path: path.join(personalDirectory(), 'bots.json') } }, claude('full')), { kind: 'own' });
  // An edit of a secret's file is a mode's question, not a closed door: Full access reaches it.
  assert.deepEqual(whyBlocked({ tool: 'Edit', input: { file_path: '/srv/app/.env' } }, claude('ask')), { kind: 'full' });
  // What each mode refused without asking, and what lifts it.
  assert.deepEqual(whyBlocked(run('npm install'), claude('ask')), { kind: 'full' });
  assert.deepEqual(whyBlocked({ tool: 'WebSearch', input: { query: 'x' } }, claude('auto')), { kind: 'reviewer' });
  assert.deepEqual(whyBlocked({ tool: 'Edit', input: { file_path: '/srv/app/a.ts' } }, claude('locked')), { kind: 'ask' });
  assert.deepEqual(whyBlocked({ tool: 'Edit', input: { file_path: '/srv/app/a.ts' } }, { vendor: 'claude' }), { kind: 'ask' }, 'a run with no mode is read only');
  // The sandbox inside a command: a host it kept off the internet, a file it would not write, Git's own folder.
  assert.deepEqual(whyBlocked({ tool: 'Bash', input: { command: 'curl https://elu.dev' }, network: 'elu.dev' }, claude('auto')), { kind: 'network', host: 'elu.dev' });
  assert.deepEqual(whyBlocked({ tool: 'Bash', input: { command: 'touch /etc/x' }, readonly: '/etc/x' }, claude('ask')), { kind: 'full' });
  assert.deepEqual(whyBlocked({ tool: 'Bash', input: { command: 'git commit -m x' }, readonly: '/srv/app/.git/index.lock' }, claude('ask')), { kind: 'git' });
  assert.deepEqual(whyBlocked({ tool: 'Bash', input: { command: 'git add -A' }, readonly: '' }, claude('auto')), { kind: 'git' });
  // The owner's own answer, in any mode: by the tool call it asked about, by the host, or by what it said.
  const asked = [{ id: 'launch-1-toolu_9', tool: 'Edit', summary: 'Edit: ~/x/tools.ts', decision: 'timeout', wait: 1200 }, { tool: 'Bash', summary: 'Run: rm -rf /srv/app/old', decision: 'deny' }, { tool: 'Bash', summary: 'Run: rmdir /srv/tmp', decision: 'timeout' }, { tool: 'Bash', summary: 'Run: ls', decision: 'allow' }, { id: 'launch-1-net-1', tool: 'SandboxNetworkAccess', summary: 'Connect to elu.dev', host: 'elu.dev', decision: 'deny' }];
  assert.deepEqual(whyBlocked({ tool: 'Edit', input: { file_path: '/home/owner/x/tools.ts' }, tool_use_id: 'toolu_9' }, { ...claude('ask'), asked }), { kind: 'timeout', wait: 1200 });
  assert.deepEqual(whyBlocked({ tool: 'Bash', input: { command: 'curl https://elu.dev' }, network: 'elu.dev' }, { ...claude('ask'), asked }), { kind: 'owner' });
  assert.deepEqual(whyBlocked(run('rm -rf /srv/app/old'), { ...claude('full'), asked }), { kind: 'owner' });
  assert.deepEqual(whyBlocked(run('rmdir /srv/tmp'), { ...claude('full'), asked }), { kind: 'timeout', wait: 1200 });
  assert.deepEqual(whyBlocked(run('ls'), { ...claude('full'), asked }), { kind: 'rule' });
  assert.deepEqual(whyBlocked(run('cat notes.txt'), claude('full')), { kind: 'rule' }); assert.deepEqual(whyBlocked({ tool: 'Agent', input: 'cut' }, claude('full')), { kind: 'rule' });
  // Which raised mode lifts which refusal, so the turn goes on by itself.
  assert.ok(liftedBy('full', 'full') && liftedBy('timeout', 'full') && liftedBy('network', 'full') && liftedBy('ask', 'ask') && liftedBy('reviewer', 'ask'));
  for (const kind of ['never', 'secret', 'own', 'git', 'rule']) assert.equal(liftedBy(kind, 'full'), false, `${kind} is not lifted`);
  // The owner's own no stands in every mode: only he says what comes after it.
  for (const mode of ['ask', 'auto', 'full']) assert.equal(liftedBy('owner', mode), false, `${mode} does not lift the owner's no`);
  assert.equal(liftedBy('network', 'auto'), false, 'Approve for me keeps commands off the internet');
});
