import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { refuse, relativePath, within } from './util.mjs';
import { CAPS, ENFORCEMENT, VENDOR_NAMES } from './vendors.mjs';
import { PROFILES } from './modes.mjs';

const INTERPRETERS = new Set(['node', 'nodejs', 'deno', 'bun', 'python', 'python2', 'python3', 'ruby', 'perl', 'php', 'lua', 'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'osascript', 'tsx', 'ts-node', 'awk', 'gawk']);
const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'env', 'xargs', 'eval', 'exec', 'source', '.', 'sudo', 'su', 'doas', 'nohup', 'timeout', 'nice', 'time', 'watch', 'command', 'builtin', 'make', 'docker', 'ssh', 'script', 'expect', 'parallel', 'find']);
const NETWORK = new Set(['curl', 'wget', 'http', 'https', 'nc', 'ncat', 'telnet', 'scp', 'sftp', 'ftp', 'rsync']);
const GIT_READS = new Set(['log', 'show', 'diff', 'status', 'blame', 'grep', 'rev-parse', 'ls-files', 'ls-tree', 'describe', 'shortlog', 'cat-file', 'rev-list', 'merge-base', 'name-rev']);
export function allowRuleProblem(rule) {
  if (typeof rule !== 'string' || !rule.trim()) return 'an empty rule';
  if (rule.length > 300 || /[\r\n]/.test(rule)) return 'a rule must fit on one line, within 300 characters';
  if (!/^[A-Za-z][A-Za-z0-9_]*(\([^\r\n]+\))?$/.test(rule)) return 'not a tool permission rule';
  if (/^Bash(\(\s*(\*|:\*)?\s*\))?$/.test(rule)) return 'it allows every shell command';
  return null;
}
export function allowRuleRisk(rule) {
  const match = /^Bash\((.*)\)$/.exec(rule);
  if (!match) return null;
  const prefix = match[1].replace(/(?::\*|\s+\*)$/, '').trim();
  const [first, ...rest] = prefix.split(/\s+/);
  const program = path.basename(first);
  if (RUNNERS.has(program) || INTERPRETERS.has(program)) return { level: 'any', text: `${program} can run arbitrary code.` };
  if (['npm', 'pnpm', 'yarn'].includes(program)) {
    if ((rest[0] === 'run' || rest[0] === 'run-script') && /^[a-zA-Z0-9:_-]+$/.test(rest[1] ?? '') && rest.length === 2) return null;
    if (rest.length === 1 && ['test', 't'].includes(rest[0])) return null;
    return { level: 'any', text: 'Name one package script; package runners and installs are refused.' };
  }
  if (NETWORK.has(program)) return { level: 'changes', text: 'It reaches another machine.' };
  if (program === 'git' && GIT_READS.has(rest[0]) && rest.length === 1) return null;
  return { level: 'broad', text: 'This command prefix has not been tested.' };
}
export function commandRule(command) {
  if (typeof command !== 'string' || !/^[a-zA-Z0-9_-]+(?: [a-zA-Z0-9:_-]+)*$/.test(command)) refuse('Allowed commands must be plain program and argument prefixes, without shell syntax.');
  const rule = `Bash(${command}:*)`;
  const problem = allowRuleProblem(rule); const risk = allowRuleRisk(rule);
  if (problem || risk) refuse(`Cannot allow ${command}: ${problem ?? risk.text}`, { risk: risk?.level });
  return rule;
}
export function sensitive(file) {
  return /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|credentials(?:\.json)?|auth\.json|id_(?:rsa|ed25519)|[^/]+\.pem)$/.test(file);
}
// Dependency files stay protected in locked and ask; Approve for me and Full access may change them.
const DEPENDENCY = /(^|\/)(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|[^/]*\.lock)$/;
const dependenciesOpen = mode => ['auto', 'full'].includes(mode);
export function protectedPath(file, { mode = 'locked' } = {}) {
  return /(^|\/)(?:\.elu-code|\.git|\.github|\.gitlab|\.circleci|\.claude|\.codex|\.agents|\.gemini|\.cursor|\.vscode|\.idea|\.zed|\.husky|\.githooks|node_modules)(\/|$)/.test(file)
    || /(^|\/)(?:\.yarnrc\.yml|\.pnpmfile\.cjs|pnpm-workspace\.yaml|bunfig\.toml|\.mocharc[^/]*|vitest\.workspace[^/]*|ava\.config[^/]*|karma\.conf[^/]*|\.nycrc[^/]*|pyproject\.toml|setup\.cfg|tox\.ini|pytest\.ini|conftest\.py)$/.test(file)
    || /(^|\/)(?:AGENTS(?:\.override)?\.md|CLAUDE(?:\.local)?\.md|\.mcp\.json|\.gitmodules|\.gitattributes|\.gitignore|\.npmrc|Jenkinsfile|Makefile|Dockerfile)$/.test(file)
    || (!dependenciesOpen(mode) && DEPENDENCY.test(file))
    || /(^|\/)(?:(?:vitest|vite|jest|webpack|rollup|babel|next|eslint|prettier|playwright|cypress|tsup)\.config\.[^/]+|tsconfig[^/]*\.json|\.babelrc[^/]*|\.eslintrc[^/]*)$/.test(file);
}
export function protectedFiles(files, { mode = 'locked' } = {}) {
  return [...new Set(['.elu-code', '.git', '.github', '.gitlab', '.circleci', '.claude', '.codex', '.agents', '.gemini', '.cursor', '.vscode', '.idea', '.zed', '.husky', '.githooks', 'node_modules', 'AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'CLAUDE.local.md', '.mcp.json', '.gitignore', '.gitattributes', '.gitmodules', ...files.filter((x) => protectedPath(x, { mode }) || (!dependenciesOpen(mode) && /(^|\/)package\.json$/.test(x)))])];
}
// What enforces each rule for this role in this profile, from the vendor table. A reviewer
// set to auto or none reports like Codex, the vendor it may become.
export function policyReport(role, { mode = 'locked' } = {}) {
  if (!PROFILES.includes(mode)) refuse('Choose ask, auto, or full.');
  const table = ENFORCEMENT[['auto', 'none'].includes(role.vendor) ? 'codex' : role.vendor] ?? {};
  const rules = (table[mode] ?? table.locked ?? []).map(({ rule, enforcement }) => ({ rule, enforcement: typeof enforcement === 'function' ? enforcement(role) : enforcement }));
  return { vendor: role.vendor, access: role.access, rules };
}
// What a role may ask of its vendor, from CAPS. mode is the session profile: an edit role
// on a vendor without lockedEdit runs only in a mode that lifts the lock.
export function assertPolicy(role, { mode = 'locked' } = {}) {
  const caps = CAPS[role.vendor];
  if (!caps) refuse(`Choose a supported vendor: ${role.vendor}.`);
  if (!PROFILES.includes(mode)) refuse('Choose ask, auto, or full.');
  if (role.network !== 'off') refuse("Network comes from the session's permissions.");
  for (const command of role.commands) commandRule(command);
  const name = VENDOR_NAMES[role.vendor];
  if (!caps.commands && role.commands.length) refuse(`${name} cannot enforce a per-run command allow-list. Remove the allowed commands, or choose Claude.`);
  if (!caps.budget && role.maxCostUsd !== null) refuse(`${name} cannot enforce a dollar budget. Set maxCostUsd to null and use the time limit, or choose Claude.`);
  if (mode === 'locked' && !caps.lockedEdit && role.access !== 'read') refuse(`${name} cannot edit in Read only. Choose Ask for approval, Approve for me, or Full access.`);
  if (caps.model === 'none' && role.model !== undefined) refuse(`${name} does not take a model name.`);
  if (caps.model === 'required' && !role.model) refuse(`${name} needs a model name.`);
  if (role.access === 'read' && role.commands.length) refuse('A read-only run uses file tools or supplied source context, without shell commands.');
  if (role.access === 'edit' && !role.writablePaths.length) refuse('Editing needs writable paths.');
  if (role.vendor === 'claude' && role.commands.length && (role.writablePaths.length !== 1 || role.writablePaths[0] !== '.')) refuse('Claude shell access with narrower writable paths has not been tested. Use no shell commands or allow the worktree.');
  for (const p of role.writablePaths) relativePath(p);
  return role;
}
export function assertNoCodexProjectConfig(cwd) {
  const home = os.homedir();
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (dir !== home && fs.existsSync(path.join(dir, '.codex', 'config.toml'))) refuse('Codex project configuration could add MCP servers. Move it out of this task before running.');
    if (dir === path.dirname(dir)) break;
  }
  for (const file of ['/etc/codex/config.toml', '/etc/codex/managed_config.toml', '/etc/codex/requirements.toml', '/Library/Application Support/com.openai.codex/config.toml', '/Library/Application Support/com.openai.codex/managed_config.toml']) {
    if (fs.existsSync(file)) refuse('Managed Codex configuration has not passed the no-MCP tests.');
  }
}
export function pathAllowed(file, paths) {
  return paths.some((p) => p === '.' || within(path.resolve('/', p), path.resolve('/', file)));
}
