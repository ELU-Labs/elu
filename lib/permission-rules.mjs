import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomic, noSymlinks, personalDirectory, readJson, refuse, within } from './util.mjs';
import { HOME_SECRETS } from './vendors.mjs';
import { NEVER_COMMANDS, neverPart } from './never-list.mjs';
import { neverListed } from './agy-hook.mjs';

// Approvals you give once. When a session asks, the owner can press a: the action becomes a
// rule, kept in ELU Code's own state folder (never in a repository), and from then on the
// approval relay answers that kind of action itself. A few defaults are on from the first
// run and can each be turned off. The never list always wins: no rule and no default can
// allow push, tag, merge, deploy or publish, and a is not offered for them.
//
// A rule is narrow on purpose:
//   command  a program and its subcommand (npm test, git diff, pytest), or, for programs where
//            that would be too wide (rm, curl, an install), the exact command. Only a single
//            command matches: a line with ;, &&, ||, $( ), backticks, a redirect to a file or
//            an env assignment never does. A pipe into head, tail, wc or grep is allowed.
//            outside: it was allowed outside the vendor's sandbox, so it matches there too. A
//            command counts as outside whenever the turn has no working sandbox at all.
//   edit     edits inside the session's workspace in an editing turn, or one exact file
//            outside the project.
//   fetch    pages on one host.
// scope: 'project' (the project folder it was saved in) or 'all' (every project).

const FILE = () => path.join(personalDirectory(), 'permission-rules.json');
const RULES_MAX = 200, WORDS_MAX = 24, WORD_MAX = 200, LINE_MAX = 400;

export const DEFAULTS = Object.freeze([
  Object.freeze({ id: 'read', text: 'Read and search files in the project' }),
  Object.freeze({ id: 'git-read', text: 'Git read commands: status, diff, log, show, branch, blame' }),
  Object.freeze({ id: 'checks', text: "The project's own test, lint, typecheck, format and build scripts, inside the sandbox" }),
]);
const DEFAULT_IDS = DEFAULTS.map(row => row.id);

// Which sessions use the owner's saved rules: his own sessions and bots, and a session that
// one of his own other machines started (origin.mine). A teammate's session gets the defaults only.
export const usesSavedRules = origin => !origin?.peer || origin.mine === true;
// Whether a command leaves the sandbox. ctx.sandboxed is true only where the vendor really
// runs commands in one (Claude Code with its sandbox working); Antigravity, Grok Build over
// ACP and Claude Code where its sandbox cannot start run every command outside.
const outsideOf = (action, ctx) => action.outside === true || ctx?.sandboxed !== true;

// ---------------------------------------------------------------------------------------
// What an approval asks for, whatever the vendor calls it.

const COMMAND_TOOLS = ['Bash', 'execute', 'run_command', 'run_terminal_cmd', 'shell', 'terminal'];
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'edit', 'write_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'search_replace', 'create_file'];
const READ_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'read', 'search', 'read_file', 'grep', 'list_dir', 'view_file', 'find_by_name', 'grep_search'];
const FETCH_TOOLS = ['WebFetch', 'fetch', 'read_url', 'web_fetch', 'read_url_content'];
const field = (input, names) => { for (const name of names) if (typeof input?.[name] === 'string' && input[name]) return input[name]; return null; };

// { kind: 'command', line, outside } | { kind: 'edit', file } | { kind: 'read', file } |
// { kind: 'fetch', url } | { kind: 'other' }. A clipped or missing input is 'other'.
export function actionOf(tool, input) {
  const name = String(tool ?? ''), value = input && typeof input === 'object' && !Array.isArray(input) && input.clipped !== true ? input : null;
  if (!value) return { kind: 'other', tool: name };
  if (COMMAND_TOOLS.includes(name)) { const line = field(value, ['command', 'CommandLine', 'commandLine', 'cmd']); return line ? { kind: 'command', line, outside: value.dangerouslyDisableSandbox === true } : { kind: 'other', tool: name }; }
  if (EDIT_TOOLS.includes(name)) { const file = field(value, ['file_path', 'notebook_path', 'path', 'TargetFile', 'target_file', 'AbsolutePath']); return file ? { kind: 'edit', file } : { kind: 'other', tool: name }; }
  if (READ_TOOLS.includes(name)) return { kind: 'read', file: field(value, ['file_path', 'path', 'AbsolutePath', 'SearchPath', 'DirectoryPath']) };
  if (FETCH_TOOLS.includes(name)) { const url = field(value, ['url', 'Url', 'URL']); return url ? { kind: 'fetch', url } : { kind: 'other', tool: name }; }
  return { kind: 'other', tool: name };
}

// ---------------------------------------------------------------------------------------
// Reading a command line. Only what this can read whole is ever matched.

// Words and operators, or null for anything this does not read: $ and backticks (outside
// single quotes), an unclosed quote, a new line.
function lex(line) {
  const tokens = []; let word = null;
  const push = () => { if (word !== null) { tokens.push({ word }); word = null; } };
  for (let i = 0; i < line.length;) {
    const ch = line[i], rest = line.slice(i);
    if (ch === ' ' || ch === '\t') { push(); i++; continue; }
    if (ch === "'") { const end = line.indexOf("'", i + 1); if (end < 0) return null; word = (word ?? '') + line.slice(i + 1, end); i = end + 1; continue; }
    if (ch === '"') {
      let j = i + 1, text = '';
      for (; j < line.length && line[j] !== '"'; j++) { if (line[j] === '\\') { j++; if (j >= line.length) return null; text += line[j]; continue; } if (line[j] === '$' || line[j] === '`') return null; text += line[j]; }
      if (j >= line.length) return null;
      word = (word ?? '') + text; i = j + 1; continue;
    }
    if (ch === '\\') { if (i + 1 >= line.length || /[\n\r]/.test(line[i + 1])) return null; word = (word ?? '') + line[i + 1]; i += 2; continue; }
    if (ch === '$' || ch === '`' || ch === '\n' || ch === '\r') return null;
    if ('|&;<>()'.includes(ch) || (word === null && /^[0-9]>/.test(rest))) {
      push();
      const op = /^(?:[0-9]?>&[0-9]|[0-9]?>>?|&>>?|<<?<?|\|\||\|&|\||&&|&|;;?|\(|\)|<)/.exec(rest)?.[0];
      if (!op) return null;
      tokens.push({ op }); i += op.length; continue;
    }
    word = (word ?? '') + ch; i++;
  }
  push(); return tokens;
}
// What a pipe may lead into: output filters that read what comes in and write nothing.
function safeFilter([name, ...args]) {
  if (name === 'head' || name === 'tail') {
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (/^-[0-9]+$/.test(a) || (name === 'tail' && /^\+[0-9]+$/.test(a)) || /^-[nc][+-]?[0-9]+$/.test(a) || /^--(?:lines|bytes)=[+-]?[0-9]+$/.test(a)) continue;
      if (/^-[nc]$/.test(a) && /^[+-]?[0-9]+$/.test(args[k + 1] ?? '')) { k++; continue; }
      return false;
    }
    return true;
  }
  if (name === 'wc') return args.every(a => /^-[lwcm]+$/.test(a));
  if (name === 'grep') {
    let pattern = false;
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (/^-[ivnchEFwxoqsHL]+$/.test(a) || /^-[ABCm][0-9]+$/.test(a)) continue;
      if (/^-[ABCm]$/.test(a) && /^[0-9]+$/.test(args[k + 1] ?? '')) { k++; continue; }
      if (a === '-e' && args[k + 1] !== undefined && !pattern) { pattern = true; k++; continue; }
      if (!a.startsWith('-') && !pattern) { pattern = true; continue; }
      return false;
    }
    return pattern;
  }
  return false;
}
// { main, filters } for one command, maybe piped into filters, maybe with 2>&1 or output sent
// to /dev/null; null for anything else.
export function commandShape(line) {
  const text = String(line ?? '').trim();
  if (!text || text.length > LINE_MAX || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)) return null;
  const tokens = lex(text); if (!tokens) return null;
  const segments = [[]];
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token.word !== undefined) { segments.at(-1).push(token.word); continue; }
    if (token.op === '|') { segments.push([]); continue; }
    if (/^[12]?>&[12]$/.test(token.op)) continue;
    if (/^(?:[12]?>|&>)$/.test(token.op) && tokens[k + 1]?.word === '/dev/null') { k++; continue; }
    return null;
  }
  if (segments.some(words => !words.length || words.length > WORDS_MAX * 2)) return null;
  const [main, ...filters] = segments;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(main[0]) || !filters.every(safeFilter)) return null;
  return { main, filters };
}

// The never list, read three ways: as the vendors' rules read a line, as the Antigravity hook
// reads one (git -C dir push), and word by word after the program.
function neverIn(line, main) {
  if (neverPart(line) || neverListed(line)) return true;
  if (!main) return false;
  const plain = main.filter(word => !word.startsWith('-'));
  return NEVER_COMMANDS.some(command => { const words = command.split(' '); return words.every((word, i) => plain[i] === word); });
}

// A word that names a secret, or ELU Code's own state: by its name anywhere in a path, or by
// where it leads once ~ and relative paths are resolved.
const SECRET_NAME = /^(?:\.env.*|.*\.pem|.*\.key|id_(?:rsa|ed25519|ecdsa|dsa).*|credentials(?:\..*)?|auth\.json|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.pgpass|secrets?(?:\..*)?)$/i;
const SECRET_DIRS = new Set(HOME_SECRETS.filter(name => name.startsWith('.')));
function resolveWord(word, cwd) {
  if (word === '~' || word.startsWith('~/')) return path.join(os.homedir(), word.slice(2));
  if (path.isAbsolute(word)) return path.resolve(word);
  return cwd ? path.resolve(cwd, word) : null;
}
function secretWord(word, cwd) {
  const pieces = String(word).split(/[/:=,]/);
  if (pieces.some(piece => SECRET_NAME.test(piece) || SECRET_DIRS.has(piece))) return true;
  if (/(?:^|\/)\.git\/elu-code(?:\/|$)/.test(word)) return true;
  const full = resolveWord(word, cwd); if (!full) return false;
  const home = os.homedir(), state = path.resolve(personalDirectory());
  return within(state, full) || HOME_SECRETS.some(name => within(path.join(home, name), full));
}

// ---------------------------------------------------------------------------------------
// From an approval to a rule.

// Programs that are too wide as a program alone: a rule for them keeps the exact command.
// Programs that read the files they are given are among them: cat with any arguments would
// read anything.
const EXACT = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ls', 'tree', 'file', 'stat', 'du', 'diff', 'wc', 'bat', 'strings', 'xxd', 'od', 'hexdump', 'jq', 'yq', 'mv', 'cp', 'ln', 'truncate', 'curl', 'wget', 'rsync', 'open', 'xdg-open', 'docker', 'podman', 'kubectl', 'helm', 'gcloud', 'aws', 'az', 'firebase', 'vercel', 'netlify', 'fly', 'flyctl', 'terraform', 'heroku', 'find', 'brew', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'port', 'tee', 'sed', 'awk', 'perl']);
// Programs a rule is never made for: they run anything, delete, change rights, reach other
// machines or the system.
const NO_RULE = new Set(['sudo', 'su', 'doas', 'eval', 'exec', 'env', 'xargs', 'nohup', 'time', 'timeout', 'nice', 'command', 'builtin', 'source', '.', 'rm', 'rmdir', 'shred', 'unlink', 'dd', 'mkfs', 'chmod', 'chown', 'chgrp', 'chflags', 'kill', 'pkill', 'killall', 'reboot', 'shutdown', 'halt', 'launchctl', 'systemctl', 'crontab', 'osascript', 'security', 'ssh', 'scp', 'sftp', 'nc', 'ncat', 'telnet', 'socat', 'git-receive-pack', 'git-upload-pack']);
// Programs whose next word is a subcommand that belongs in the rule.
const SUBCOMMANDS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'git', 'gh', 'cargo', 'go', 'uv', 'poetry', 'pip', 'pip3', 'pipenv', 'make', 'just', 'deno', 'dotnet', 'swift', 'mix', 'rake', 'bundle', 'composer', 'mvn', 'gradle', './gradlew', 'turbo', 'nx', 'vitest', 'ruff', 'hatch', 'tox', 'nox', 'rustup', 'cmake', 'ctest', 'bazel']);
// Subcommands that install, remove or run arbitrary packages: those rules keep the exact command.
const EXACT_SUB = new Set(['install', 'i', 'in', 'ci', 'add', 'remove', 'rm', 'uninstall', 'un', 'r', 'update', 'upgrade', 'up', 'link', 'ln', 'unlink', 'exec', 'x', 'dlx', 'get', 'sync', 'global', 'self', 'clean', 'reset', 'checkout', 'switch', 'restore', 'stash', 'config', 'remote', 'worktree', 'update-ref', 'filter-branch', 'filter-repo', 'gc', 'prune', 'reflog', 'rebase', 'cherry-pick', 'revert', 'am', 'apply', 'submodule', 'lfs', 'credential', 'pull', 'fetch', 'clone', 'ls-remote', 'archive', 'bundle', 'daemon', 'send-email', 'branch', 'api', 'auth', 'secret', 'ssh-key', 'gpg-key', 'repo', 'login', 'logout', 'token', 'adduser', 'owner', 'access', 'set', 'dist-tag', 'deprecate', 'unpublish', 'publish', 'release', 'deploy']);
// Package managers that run a project script by name after run.
const RUNS_SCRIPTS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'uv', 'poetry', 'turbo', 'nx', 'pipenv', 'hatch']);
const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'php', 'deno', 'tsx', 'ts-node', 'sh', 'bash', 'zsh', 'dash', 'fish']);
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9:._@+-]*$/;
const PROGRAM = /^(?:\.\/)?[A-Za-z0-9][A-Za-z0-9._+-]*$/;

// The rule a command becomes, or { refused } in plain words.
function commandRule(line, outside, cwd) {
  const shape = commandShape(line);
  if (neverIn(line, shape?.main)) return { refused: 'That is on the never list, so it is never allowed.' };
  if (!shape) return { refused: 'This joins or wraps several commands, so it can only be allowed once.' };
  const words = shape.main, [program] = words;
  if (words.some(word => secretWord(word, cwd))) return { refused: 'This touches a file that may hold secrets, so it is asked each time.' };
  if (NO_RULE.has(program) || /^(?:sh|bash|zsh|dash|fish)$/.test(program) && words[1]?.startsWith('-')) return { refused: `${program} is asked each time.` };
  if (!PROGRAM.test(program) || program.includes('..')) return { refused: 'A program named by its full path is asked each time.' };
  const exact = (why = null) => words.length > WORDS_MAX || words.some(word => word.length > WORD_MAX) ? { refused: 'This command is too long to keep as a rule.' } : { rule: { kind: 'command', words, exact: true, outside }, why };
  if (EXACT.has(program)) return exact();
  if (INTERPRETERS.has(program)) {
    // python -m pytest, node --test; a script file by name; never inline code or a REPL.
    if (words[1] === '-m' && PLAIN.test(words[2] ?? '')) return { rule: { kind: 'command', words: words.slice(0, 3), exact: false, outside } };
    if (program === 'node' && words[1] === '--test') return { rule: { kind: 'command', words: words.slice(0, 2), exact: false, outside } };
    if (!words[1] || words[1].startsWith('-')) return { refused: 'Code given on the command line is asked each time.' };
    if (path.isAbsolute(words[1]) || words[1].split('/').includes('..')) return exact();
    return { rule: { kind: 'command', words: words.slice(0, 2), exact: false, outside } };
  }
  if (SUBCOMMANDS.has(program)) {
    const sub = words[1];
    if (!sub || !PLAIN.test(sub)) return exact();
    if (EXACT_SUB.has(sub)) return exact();
    if (RUNS_SCRIPTS.has(program) && ['run', 'run-script'].includes(sub)) return PLAIN.test(words[2] ?? '') ? { rule: { kind: 'command', words: words.slice(0, 3), exact: false, outside } } : exact();
    // gh names its subject first (gh pr view): both words belong in the rule.
    if (program === 'gh') return PLAIN.test(words[2] ?? '') && !EXACT_SUB.has(words[2]) ? { rule: { kind: 'command', words: words.slice(0, 3), exact: false, outside } } : exact();
    if (program === 'npx' && sub.startsWith('@')) return exact();
    return { rule: { kind: 'command', words: words.slice(0, 2), exact: false, outside } };
  }
  return { rule: { kind: 'command', words: [program], exact: false, outside } };
}
const inside = (file, dir) => Boolean(dir) && within(path.resolve(dir), path.resolve(file));
const protectedFile = file => path.resolve(file).split(path.sep).some(part => part === '.git' || part === '.elu-code');

// The rule an approval would become, with the sentence that says it, or { refused } with why
// not. ctx: { project, cwd, access, sandboxed } of the turn that asked.
export function ruleFor(tool, input, ctx = {}) {
  const action = actionOf(tool, input);
  let made;
  if (action.kind === 'command') made = commandRule(action.line, outsideOf(action, ctx), ctx.cwd);
  else if (action.kind === 'edit') {
    const file = resolveWord(action.file, ctx.cwd);
    if (!file || secretWord(action.file, ctx.cwd) || protectedFile(file)) made = { refused: 'This file is protected, so editing it is asked each time.' };
    else if (inside(file, ctx.cwd) || inside(file, ctx.project)) made = ctx.access === 'edit' && inside(file, ctx.cwd) ? { rule: { kind: 'edit', workspace: true } } : { refused: 'An edit here waits for a Task you approve, so it is asked each time.' };
    else made = { rule: { kind: 'edit', file } };
  } else if (action.kind === 'fetch') {
    let url = null; try { url = new URL(action.url); } catch { /* Not a URL. */ }
    made = url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.hostname ? { rule: { kind: 'fetch', domain: url.hostname.toLowerCase() } } : { refused: 'This address cannot be kept as a rule.' };
  } else if (action.kind === 'read') made = { refused: 'Reads are asked each time outside the project.' };
  else made = { refused: 'This kind of action is asked each time.' };
  return made.rule ? { rule: made.rule, line: ruleSentence(made.rule), summary: ruleSummary(made.rule) } : made;
}

// ---------------------------------------------------------------------------------------
// Rules in words.

export function ruleText(rule) {
  if (rule.kind === 'command') return rule.words.join(' ');
  if (rule.kind === 'edit') return rule.workspace ? 'edits in the session’s workspace' : `edits to ${shortHome(rule.file)}`;
  if (rule.kind === 'fetch') return `pages on ${rule.domain}`;
  return 'unknown';
}
export function ruleSentence(rule) {
  if (rule.kind === 'command') return `${rule.exact ? 'Run exactly' : 'Run'} ${rule.words.join(' ')}${rule.exact ? '' : ', with any arguments'}${rule.outside ? ', also outside the sandbox' : ''}, without asking.`;
  if (rule.kind === 'edit') return rule.workspace ? 'Edit files in the session’s own workspace without asking, in turns that edit.' : `Edit ${shortHome(rule.file)} without asking.`;
  if (rule.kind === 'fetch') return `Open pages on ${rule.domain} without asking.`;
  return '';
}
// The sentence without its ending, for a list: Run npm test, with any arguments.
export const ruleSummary = rule => ruleSentence(rule).replace(/,? without asking(?:, in turns that edit)?\.$/, '');
const shortHome = file => { const home = os.homedir(); return file === home ? '~' : file.startsWith(`${home}/`) ? `~/${file.slice(home.length + 1)}` : file; };
export const whereText = rule => rule.scope === 'all' ? 'All my projects' : `This project: ${shortHome(rule.project)}`;

// ---------------------------------------------------------------------------------------
// The store: { version, rules, off }. A missing file is no rules and every default on. An
// unreadable one is no rules and every default off, so nothing is answered that was not meant.

const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
function checkRule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const scope = value.scope === 'all' ? 'all' : value.scope === 'project' && typeof value.project === 'string' && path.isAbsolute(value.project) ? 'project' : null;
  if (!scope) return null;
  const at = typeof value.at === 'string' ? value.at : null, base = { scope, ...(scope === 'project' ? { project: path.resolve(value.project) } : {}), ...(at ? { at } : {}) };
  if (value.kind === 'command') {
    const words = Array.isArray(value.words) ? value.words : null;
    if (!words?.length || words.length > WORDS_MAX || words.some(word => typeof word !== 'string' || !word || word.length > WORD_MAX || clean(word) !== word)) return null;
    if (NO_RULE.has(words[0]) || !PROGRAM.test(words[0]) || neverIn(words.join(' '), words) || (SUBCOMMANDS.has(words[0]) && words.length < 2 && value.exact !== true)) return null;
    return { kind: 'command', words: [...words], exact: value.exact === true, outside: value.outside === true, ...base };
  }
  if (value.kind === 'edit') {
    if (value.workspace === true) return { kind: 'edit', workspace: true, ...base };
    return typeof value.file === 'string' && path.isAbsolute(value.file) && clean(value.file) === value.file && !secretWord(value.file) && !protectedFile(value.file) ? { kind: 'edit', file: path.resolve(value.file), ...base } : null;
  }
  if (value.kind === 'fetch') return typeof value.domain === 'string' && /^[a-z0-9.-]{1,253}$/.test(value.domain) && /[a-z0-9]/.test(value.domain) ? { kind: 'fetch', domain: value.domain, ...base } : null;
  return null;
}
export function readStore() {
  const file = FILE();
  try {
    noSymlinks(file);
    if (!fs.existsSync(file)) return { rules: [], off: [] };
    const value = readJson(file);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not a mapping');
    return { rules: (Array.isArray(value.rules) ? value.rules : []).slice(0, RULES_MAX).map(checkRule).filter(Boolean), off: [...new Set((Array.isArray(value.off) ? value.off : []).filter(id => DEFAULT_IDS.includes(id)))] };
  } catch { return { rules: [], off: [...DEFAULT_IDS], unreadable: true }; }
}
function writeStore({ rules, off }) { atomic(FILE(), { version: 1, rules, off }); }
const sameRule = (a, b) => a.kind === b.kind && a.scope === b.scope && (a.project ?? null) === (b.project ?? null) && JSON.stringify([a.words ?? null, a.exact ?? null, a.workspace ?? null, a.file ?? null, a.domain ?? null]) === JSON.stringify([b.words ?? null, b.exact ?? null, b.workspace ?? null, b.file ?? null, b.domain ?? null]);
// Saves a rule for one project or for all of them. The same rule saved again is kept once;
// one saved for outside the sandbox stays that way.
export function saveRule(rule, { scope, project = null } = {}) {
  if (!['project', 'all'].includes(scope)) refuse('Choose this project or all your projects.');
  if (scope === 'project' && (typeof project !== 'string' || !path.isAbsolute(project))) refuse('A rule for this project needs its folder.');
  const checked = checkRule({ ...rule, scope, ...(scope === 'project' ? { project } : {}), at: new Date().toISOString() });
  if (!checked) refuse('That cannot be kept as a rule.');
  const store = readStore(); if (store.unreadable) refuse(`${FILE()} cannot be read. Fix or remove it first.`);
  const found = store.rules.find(row => sameRule(row, checked));
  if (found) { if (checked.outside) found.outside = true; }
  else { if (store.rules.length >= RULES_MAX) refuse(`At most ${RULES_MAX} rules. Remove one with /permissions rules.`); store.rules.push(checked); }
  writeStore(store); return found ?? checked;
}
// The numbered list /permissions and elu permissions show: the defaults first, then the
// saved rules in the order they were saved.
export function listEntries() {
  const store = readStore();
  return [...DEFAULTS.map(row => ({ kind: 'default', id: row.id, text: row.text, on: !store.off.includes(row.id) })), ...store.rules.map(rule => ({ kind: 'rule', rule, text: ruleSummary(rule), short: ruleText(rule), where: whereText(rule) }))].map((row, index) => ({ n: index + 1, ...row }));
}
export function entryLine(row) {
  return row.kind === 'default' ? `${row.n}. ${row.on ? 'on ' : 'off'}  ${row.text} (default, all projects)` : `${row.n}. ${row.text} · ${row.where}`;
}
// Removes saved rule n, or turns default n off. Returns what was done, in words.
export function removeEntry(n) {
  const row = listEntries().find(entry => entry.n === Number(n));
  if (!row) refuse('No rule has that number. elu permissions lists them.');
  const store = readStore(); if (store.unreadable) refuse(`${FILE()} cannot be read. Fix or remove it first.`);
  if (row.kind === 'default') { if (!store.off.includes(row.id)) store.off.push(row.id); writeStore(store); return `Turned off: ${row.text}.`; }
  store.rules = store.rules.filter(rule => !sameRule(rule, row.rule)); writeStore(store); return `Removed: ${row.text}.`;
}
// Turns default n on again.
export function turnOnEntry(n) {
  const row = listEntries().find(entry => entry.n === Number(n));
  if (!row || row.kind !== 'default') refuse('Only a default can be turned on again. elu permissions lists them.');
  const store = readStore(); if (store.unreadable) refuse(`${FILE()} cannot be read. Fix or remove it first.`);
  store.off = store.off.filter(id => id !== row.id); writeStore(store); return `Turned on: ${row.text}.`;
}

// ---------------------------------------------------------------------------------------
// Matching.

// A word's value without the option that carries it: --config=.env reads .env.
const optionValue = word => word.replace(/^--?[A-Za-z0-9-]+=/, '');
// git options that run a program, write a file or read outside the repository.
const GIT_UNSAFE = /^(?:--(?:output|ext-diff|no-index|exec|upload-pack|receive-pack|open-files-in-pager|textconv)|-O)/;
function commandMatches(rule, action, shape, ctx) {
  if (outsideOf(action, ctx) && !rule.outside) return false;
  const words = shape.main;
  // A rule's arguments are free, but never a secret, ELU Code's own state, or a git option
  // that runs a program or writes a file: those are checked each time, not when it was kept.
  if (words.some(word => secretWord(word, ctx.cwd) || secretWord(optionValue(word), ctx.cwd))) return false;
  if (words[0] === 'git' && words.some(word => GIT_UNSAFE.test(word))) return false;
  if (rule.exact) return words.length === rule.words.length && rule.words.every((word, i) => words[i] === word) && !shape.filters.length;
  return rule.words.every((word, i) => words[i] === word);
}
function ruleMatches(rule, action, ctx, shape) {
  if (rule.scope === 'project' && (!ctx.project || path.resolve(ctx.project) !== rule.project)) return false;
  if (rule.kind === 'command') return action.kind === 'command' && Boolean(shape) && commandMatches(rule, action, shape, ctx);
  if (rule.kind === 'edit') {
    if (action.kind !== 'edit') return false;
    const file = resolveWord(action.file, ctx.cwd);
    if (!file || secretWord(action.file, ctx.cwd) || protectedFile(file)) return false;
    if (rule.workspace) return ctx.access === 'edit' && inside(file, ctx.cwd);
    return file === rule.file && !inside(file, ctx.cwd) && !inside(file, ctx.project);
  }
  if (rule.kind === 'fetch') {
    if (action.kind !== 'fetch') return false;
    let url = null; try { url = new URL(action.url); } catch { return false; }
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.hostname.toLowerCase() === rule.domain;
  }
  return false;
}

const READ_PROGRAMS = new Set(['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'rg', 'find', 'tree', 'pwd', 'file', 'stat', 'du', 'diff']);
const GIT_READS = new Set(['status', 'diff', 'log', 'show', 'branch', 'blame']);
const BRANCH_LISTS = /^(?:-a|-r|-l|-v|-vv|--all|--remotes|--list|--verbose|--show-current|--no-color|--color(?:=\S+)?|--column(?:=\S+)?|--no-column|--sort=\S+|--format=\S+|--merged|--no-merged|--contains|--no-contains|--points-at|--abbrev=\d+|--no-abbrev|-i|--ignore-case)$/;
// A word given to a read: inside the workspace or the project, and no secret.
const readable = (word, ctx) => { if (secretWord(word, ctx.cwd)) return false; if (word.startsWith('-')) return true; const full = resolveWord(word, ctx.cwd); return !full || inside(full, ctx.cwd) || inside(full, ctx.project); };
function readDefault(action, ctx, shape) {
  if (action.kind === 'read') return !action.file || readable(action.file, ctx);
  if (action.kind !== 'command' || !shape) return false;
  const [program, ...args] = shape.main;
  if (!READ_PROGRAMS.has(program)) return false;
  if (program === 'find' && args.some(arg => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(arg))) return false;
  if (program === 'rg' && args.some(arg => /^--pre(?:-glob)?(?:=|$)/.test(arg))) return false;
  if (program === 'tail' && args.some(arg => /^(?:-[a-zA-Z]*[fF][a-zA-Z]*|--follow.*|--retry)$/.test(arg))) return false;
  if (program === 'diff' && args.some(arg => /^--(?:to-file|from-file)/.test(arg))) return false;
  return args.every(arg => readable(arg.replace(/^--?[A-Za-z-]+=/, ''), ctx));
}
function gitDefault(action, ctx, shape) {
  if (action.kind !== 'command' || !shape) return false;
  const [program, sub, ...args] = shape.main;
  if (program !== 'git' || !GIT_READS.has(sub)) return false;
  if (args.some(arg => GIT_UNSAFE.test(arg) || secretWord(arg, ctx.cwd))) return false;
  if (sub === 'branch') { const listing = args.some(arg => ['-l', '--list'].includes(arg)); return args.every(arg => BRANCH_LISTS.test(arg) || (listing && !arg.startsWith('-'))); }
  return true;
}
const SCRIPT = /^(?:test|tests|lint|typecheck|type-check|types|tsc|format|fmt|prettier|build|check|checks|verify)(?::[A-Za-z0-9:_.-]+)?$/;
function packageScripts(cwd) {
  try { const file = path.join(cwd, 'package.json'); noSymlinks(file); const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value?.scripts && typeof value.scripts === 'object' ? Object.keys(value.scripts) : []; } catch { return []; }
}
const has = (cwd, ...names) => names.some(name => { try { return fs.existsSync(path.join(cwd, name)); } catch { return false; } });
function makeTargets(cwd) {
  for (const name of ['Makefile', 'makefile', 'GNUmakefile']) { try { const text = fs.readFileSync(path.join(cwd, name), 'utf8'); return [...text.matchAll(/^([A-Za-z0-9_.:-]+)\s*:(?!=)/gm)].map(match => match[1]); } catch { /* Next name. */ } }
  return [];
}
// The project's own scripts by the names that test, lint, typecheck, format and build. Only
// where the command stays in the vendor's sandbox: a request to leave it is asked.
function checksDefault(action, ctx, shape) {
  if (action.kind !== 'command' || !shape || outsideOf(action, ctx) || !ctx.cwd) return false;
  const [program, sub, third, ...rest] = shape.main, after = [third, ...rest].filter(word => word !== undefined);
  if (shape.main.some(word => secretWord(word, ctx.cwd))) return false;
  const script = name => SCRIPT.test(name ?? '') && packageScripts(ctx.cwd).includes(name);
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) {
    if (['run', 'run-script'].includes(sub)) return script(third);
    if (program === 'npm' && ['test', 't'].includes(sub)) return script('test');
    if (program === 'bun' && sub === 'test') return true;
    return program !== 'npm' && script(sub);
  }
  if (program === 'make') return Boolean(sub) && SCRIPT.test(sub) && makeTargets(ctx.cwd).includes(sub) && after.every(word => /^-/.test(word) || SCRIPT.test(word) && makeTargets(ctx.cwd).includes(word));
  if (program === 'cargo') return ['test', 'build', 'check', 'clippy', 'fmt'].includes(sub) && has(ctx.cwd, 'Cargo.toml');
  if (program === 'go') return ['test', 'build', 'vet'].includes(sub) && has(ctx.cwd, 'go.mod');
  const python = has(ctx.cwd, 'pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', 'setup.py', 'conftest.py');
  if (program === 'pytest') return python;
  if (['python', 'python3'].includes(program) && sub === '-m' && third === 'pytest') return python;
  if (program === 'node' && sub === '--test') return has(ctx.cwd, 'package.json');
  return false;
}
const DEFAULT_MATCH = { read: readDefault, 'git-read': gitDefault, checks: checksDefault };

// What answers this approval for the owner, or null when it waits for him:
// { by: 'rule', text } for a saved rule (ctx.saved: the session may use them), or
// { by: 'default', text } for a default. Never anything the never list holds.
// ctx: { project, cwd, access, saved, sandboxed }.
export function allowedBy(tool, input, ctx = {}) {
  const action = actionOf(tool, input);
  if (action.kind === 'other') return null;
  const shape = action.kind === 'command' ? commandShape(action.line) : null;
  if (action.kind === 'command' && neverIn(action.line, shape?.main)) return null;
  const store = readStore();
  if (ctx.saved === true) for (const rule of store.rules) if (ruleMatches(rule, action, ctx, shape)) return { by: 'rule', text: ruleText(rule) };
  for (const row of DEFAULTS) if (!store.off.includes(row.id) && DEFAULT_MATCH[row.id](action, ctx, shape)) return { by: 'default', text: action.kind === 'command' ? shape.main.slice(0, 3).join(' ').slice(0, 80) : 'read in the project' };
  return null;
}
