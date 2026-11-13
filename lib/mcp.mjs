import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { findBin, mkdir, personalDirectory, readJson, refuse, systemTemp } from './util.mjs';
import { APPROVAL_WAIT_SECONDS } from './modes.mjs';
import { commandWords } from './terminal-commands.mjs';

// Your own Claude Code MCP servers (claude mcp list), by name. A project's lead gets all of
// them except the ones its settings turn off, and a teammate's run never gets any.
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const claudeFile = () => process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
export function claudeServers(root) {
  let value;
  try { value = readJson(claudeFile()); } catch { return {}; }
  const servers = { ...(value?.mcpServers ?? {}), ...(root ? value?.projects?.[root]?.mcpServers ?? {} : {}) };
  return Object.fromEntries(Object.entries(servers).filter(([name, server]) => NAME.test(name) && server && typeof server === 'object'));
}
export function checkServerName(name) {
  if (typeof name !== 'string' || !NAME.test(name)) refuse('Use an MCP server name from claude mcp list.');
  return name;
}
// Tells the lead which servers it has, how the owner turns on one that is off, and how the
// owner adds one: a key never goes through the chat, and outside Full access the model
// cannot add or remove a server (the never list). full: the turn runs with Full access.
const KEEP_KEYS = "When a request needs an MCP server the owner does not have, tell the owner to type /mcp add in the message box: it asks for the server's URL and key and keeps the key out of the chat. Never ask for a key, token or password in the chat.";
export const ADD_NOTE = `${KEEP_KEYS} Never add or remove a server yourself.`;
export function serverNote(root, on, { full = false } = {}) {
  const off = Object.keys(claudeServers(root)).filter(name => !on.includes(name));
  return [
    on.length ? `MCP servers on for you (tools named mcp__NAME__*): ${on.join(', ')}.` : '',
    off.length ? `The owner's other Claude Code MCP servers are off for you: ${off.join(', ')}. When a request needs one of them, tell the owner to type /mcp on NAME in the message box, with that server's name, and then ask again.` : '',
    full ? KEEP_KEYS : ADD_NOTE,
  ].filter(Boolean).join(' ');
}

// Adding and removing a server. It is saved by Claude Code's own command (claude mcp
// add-json --scope user), never by writing its file here, and the key in it is never shown,
// logged or sent to a model. A new name is one Claude Code takes.
// A name never starts with -, so Claude Code cannot read one as an option.
const NEW_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
export function nameProblem(name) {
  if (typeof name !== 'string' || !NEW_NAME.test(name)) return 'A server name is up to 64 letters, digits, - and _, and does not start with -.';
  if (name === APPROVAL_SERVER) return `${APPROVAL_SERVER} is ELU's own server. Use another name.`;
  return null;
}
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/, ENV = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
export const headerProblem = value => HEADER.test(value) ? null : 'Type only the header\'s name, such as Authorization. Its value is asked for next.';
export const envProblem = value => ENV.test(value) ? null : 'Type only the variable\'s name, such as API_KEY. Its value is asked for next.';
const strings = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([key, item]) => names.test(key) && typeof item === 'string') ? value : null;
// The fields a server's settings may have. An object with any other field is not taken as a
// server unless it sits under mcpServers: a log line or an API's answer may have a url too.
const SERVER_FIELDS = new Set(['type', 'url', 'headers', 'command', 'args', 'env', 'timeout', 'cwd', 'transport', 'oauth', 'headersHelper', 'envFile']);
const onlyServerFields = value => Object.keys(value).every(field => SERVER_FIELDS.has(field));
// A server's settings as Claude Code takes them, from what a config file holds, or null when
// they are not a server's: a URL (http or sse) with its headers, or a command with its
// arguments and environment. Other fields, such as a timeout, are left out.
export function serverEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.url === 'string' && /^https?:\/\/[^\s]+$/i.test(value.url)) {
    if (value.type !== undefined && !['http', 'sse', 'streamable-http', 'streamableHttp'].includes(value.type)) return null;
    const headers = value.headers === undefined ? {} : strings(value.headers, HEADER); if (!headers) return null;
    return { type: value.type === 'sse' ? 'sse' : 'http', url: value.url, ...(Object.keys(headers).length ? { headers: { ...headers } } : {}) };
  }
  if (typeof value.command === 'string' && value.command.trim()) {
    if (value.type !== undefined && value.type !== 'stdio') return null;
    const args = value.args === undefined ? [] : Array.isArray(value.args) && value.args.every(arg => typeof arg === 'string') ? [...value.args] : null;
    const env = value.env === undefined ? {} : strings(value.env, ENV);
    if (!args || !env) return null;
    return { type: 'stdio', command: value.command, args, ...(Object.keys(env).length ? { env: { ...env } } : {}) };
  }
  return null;
}
// The parts of a URL that may be keys, as written and decoded: the name and password before
// an @, a query value whose name says it is a key, and any long value or path segment that
// mixes letters and digits (https://host/api/mcp/s/<key>/mcp).
const opaque = part => part.length >= 16 && /[A-Za-z]/.test(part) && /[0-9]/.test(part);
const KEY_PARAM = /^(?:api[_-]?key|key|token|access[_-]?token|auth|secret|password|pass|pat|sig|signature)$/i;
export function urlSecrets(url) {
  const match = /^https?:\/\/(?:([^@/?#\s]*)@)?[^/?#\s]*([^?#\s]*)(?:\?([^#\s]*))?/i.exec(String(url ?? '')); if (!match) return [];
  const [, user = '', where = '', query = ''] = match, out = [];
  const both = value => { out.push(value); try { const plain = decodeURIComponent(value); if (plain !== value) out.push(plain); } catch { /* Kept as written. */ } };
  for (const part of user.split(':')) if (part) both(part);
  for (const segment of where.split('/')) if (opaque(segment)) both(segment);
  for (const pair of query.split('&')) { const at = pair.indexOf('='); if (at > 0 && (KEY_PARAM.test(pair.slice(0, at)) ? pair.length - at > 4 : opaque(pair.slice(at + 1)))) both(pair.slice(at + 1)); }
  return out;
}
// The values in a server's settings that may be keys: its headers, its environment, a
// bearer token in its arguments, and a key in its URL or in a URL among its arguments. They
// are taken out of anything Claude Code prints, and a config that has one is never sent.
export function secretsOf(entry) {
  const values = [...Object.values(entry?.headers ?? {}), ...Object.values(entry?.env ?? {}), ...(entry?.args ?? []).filter(arg => /bearer\s+\S|token|key|secret/i.test(arg))];
  const parts = values.flatMap(value => [value.trim(), ...value.split(/[\s:=]+/).filter(part => part.length >= 8 && (/[^A-Za-z-]/.test(part) || part.length >= 20))]);
  const inUrls = [entry?.url, ...(entry?.args ?? [])].filter(value => typeof value === 'string' && /^https?:\/\//i.test(value)).flatMap(urlSecrets);
  return [...new Set([...parts, ...inUrls].filter(value => value.length >= 4))].sort((a, b) => b.length - a.length);
}
const scrub = (text, secrets) => secrets.reduce((out, secret) => out.split(secret).join('…'), text);
// A header's value as it is sent: a key typed alone for Authorization is a bearer token.
export const headerValue = (name, value) => name.toLowerCase() === 'authorization' && !/\s/.test(value.trim()) ? `Bearer ${value.trim()}` : value.trim();

// Each {…} in the text whose braces balance, outermost first, as [start, end). A long
// message is looked at only so far: the first 200 braces, each over 20,000 characters.
function braces(text) {
  const found = [];
  for (let start = text.indexOf('{'), tried = 0; start >= 0 && tried < 200; start = text.indexOf('{', start + 1), tried++) {
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (let at = start; at < Math.min(text.length, start + 20000) && end < 0; at++) {
      const ch = text[at];
      if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; }
      else if (ch === '"') quoted = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) end = at + 1;
    }
    if (end > 0) found.push([start, end]);
  }
  return found;
}
// The servers a parsed value names: { mcpServers: { NAME: server } } (or VS Code's servers),
// also under mcp or a project of Claude Code's own file; { NAME: server, … }; or one server
// with no name. Only an entry under mcpServers may have fields a server does not; nothing
// else in a larger file is looked into.
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function serversIn(value, depth = 0) {
  if (!isObject(value) || depth > 3) return null;
  const named = (map, strict) => {
    if (!isObject(map)) return null;
    const rows = Object.entries(map).map(([name, server]) => ({ name, entry: !strict || isObject(server) && onlyServerFields(server) ? serverEntry(server) : null }));
    return rows.length && rows.every(row => row.entry) ? rows : null;
  };
  const listed = named(value.mcpServers, false) ?? named(value.servers, true); if (listed) return listed;
  for (const inner of [value.mcp, ...(isObject(value.projects) ? Object.values(value.projects) : [])]) { const rows = serversIn(inner, depth + 1); if (rows) return rows; }
  const one = onlyServerFields(value) ? serverEntry(value) : null; if (one) return [{ name: null, entry: one }];
  return named(value, true);
}
// An MCP server config in a message, as people paste one from a setup page: the servers it
// names ({ name, entry }, name null when it has none) and the rest of the message, or null.
// A config pasted without its outer braces ("mcpServers": {…} or "elu": {…}) counts, and
// the name before it is taken.
export function findServerConfig(text) {
  // Only a message with a server's field in it is looked at.
  if (typeof text !== 'string' || text.length > 100000 || !/"(?:url|command|mcpServers|servers)"\s*:/.test(text)) return null;
  // An object that reads is looked into by serversIn, so the objects inside it are not tried
  // again on their own: a task's command in a VS Code file is not a server.
  let read = 0;
  for (const [start, end] of braces(text)) {
    if (start < read) continue;
    let value; try { value = JSON.parse(text.slice(start, end)); } catch { continue; }
    read = end;
    let servers = serversIn(value); if (!servers) continue;
    let from = start;
    const label = /"([^"\n]{1,64})"\s*:\s*$/.exec(text.slice(Math.max(0, start - 80), start));
    if (label) {
      from = start - label[0].length;
      if (servers.length === 1 && servers[0].name === null && !nameProblem(label[1])) servers = [{ ...servers[0], name: label[1] }];
    }
    const rest = `${text.slice(0, from)} ${text.slice(end)}`.replace(/"(?:mcpServers|servers)"\s*:/g, '').replace(/^[\s{},]+|[\s{},]+$/g, '').replace(/[ \t]+\n/g, '\n').trim();
    return { servers, rest: /^[\s{}[\],:]*$/.test(rest) ? '' : rest };
  }
  return null;
}
// A key in a line of text: a bearer token, a header that carries one, a variable named for
// one with its value, a key in a URL's query, or a password before a URL's @.
export function keyedLine(text) {
  const line = String(text ?? '');
  return /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(line)
    || /\b(?:authorization|x-api-key|api-key|x-auth-token|cookie)"?\s*:\s*"?(?:Basic\s+)?[^\s"']{8,}/i.test(line)
    || /\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PAT)\s*=\s*["']?[^\s"'$]{8,}/.test(line)
    || /[?&](?:api[_-]?key|key|token|access[_-]?token|auth)=[^\s&"'#]{8,}/i.test(line)
    || /\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/i.test(line);
}
// Text that looks like a server's settings with a key in it, though it does not read as a
// config: it is never sent to a model as it is either.
export const keyedConfigText = text => /mcpServers|"(?:url|command)"\s*:/i.test(text) && (keyedLine(text) || /"(?:authorization|x-api-key|api[_-]?key|token)"\s*:\s*"[^"\s]{8,}"/i.test(text));

// claude mcp add, claude mcp add-json or elu mcp add typed in a message, with or without !
// in front: the servers the line adds, as findServerConfig gives them, or { keyed: true }
// for a line that holds a key but does not read, or null. The line runs to the end of its
// line (a line that ends in \ goes on) or to the next ; && || or |.
const CLI_ADD = /(?:^|[\s!;&|(`$])((?:claude|elu(?:-code)?)\s+mcp\s+add(?:-json|-from-claude-desktop)?)(?=\s|$)/;
const ENV_PAIR = /^[A-Za-z_][A-Za-z0-9_]*=/, HEADER_PAIR = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+:(?!\/\/)/;
export function cliServerConfig(text) {
  if (typeof text !== 'string' || text.length > 100000) return null;
  const match = CLI_ADD.exec(text); if (!match) return null;
  const start = match.index + match[0].length - match[1].length;
  let end = start;
  for (;;) { const at = text.indexOf('\n', end); if (at < 0) { end = text.length; break; } if (text[at - 1] === '\\') { end = at + 1; continue; } end = at; break; }
  const line = text.slice(start, end).replace(/\\\n/g, ' ');
  let words = null; try { words = commandWords(line); } catch { /* An open quote: it does not read. */ }
  const stop = words?.findIndex(word => [';', '&&', '||', '|', '&'].includes(word)) ?? -1;
  if (words && stop >= 0) words = words.slice(0, stop);
  const keyed = keyedLine(line);
  const row = words && words[0] === 'claude' ? claudeAddWords(words) : null;
  if (!row) return keyed ? { keyed: true } : null;
  const rest = `${text.slice(0, start).replace(/[\s!$]+$/, '')} ${text.slice(end)}`.replace(/[ \t]+\n/g, '\n').trim();
  return { servers: [row], rest: /^[\s!$]*$/.test(rest) ? '' : rest, cli: true };
}
// claude mcp add [options] NAME URL|COMMAND [ARGS...] and claude mcp add-json NAME JSON, read as
// claude 2.1 reads them, as { name, entry }, or null. A URL with no --transport is http.
// Options may follow a URL; after a command, every word is one of its arguments.
function claudeAddWords(words) {
  const [, , sub, ...rest] = words;
  if (sub !== 'add' && sub !== 'add-json') return null;
  let transport = null, dashed = false; const env = {}, headers = {}, positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (dashed || !arg.startsWith('-') || arg === '-') { positional.push(arg); if (sub === 'add' && positional.length === 2 && !/^https?:\/\//i.test(arg)) dashed = true; continue; }
    if (arg === '--') { dashed = true; continue; }
    const cut = arg.startsWith('--') ? arg.indexOf('=') : -1, flag = cut > 0 ? arg.slice(0, cut) : arg, inline = cut > 0 ? arg.slice(cut + 1) : undefined;
    const value = () => inline ?? rest[++i];
    // -e and -H take one value or more, as claude reads them: each word that has the shape.
    const many = (shape, take) => { const first = value(); if (typeof first !== 'string' || !shape.test(first)) return false; take(first); while (inline === undefined && typeof rest[i + 1] === 'string' && shape.test(rest[i + 1])) take(rest[++i]); return true; };
    if (flag === '-s' || flag === '--scope') value();
    else if (flag === '-t' || flag === '--transport') transport = value();
    else if (flag === '-e' || flag === '--env') { if (!many(ENV_PAIR, pair => { const at = pair.indexOf('='); env[pair.slice(0, at)] = pair.slice(at + 1); })) return null; }
    else if (flag === '-H' || flag === '--header') { if (!many(HEADER_PAIR, pair => { const at = pair.indexOf(':'); headers[pair.slice(0, at).trim()] = pair.slice(at + 1).trim(); })) return null; }
    else if (flag === '--client-id' || flag === '--callback-port') value();
    else if (flag !== '--client-secret') return null;
  }
  const [name, target, ...args] = positional;
  if (!name || !target || nameProblem(name)) return null;
  if (sub === 'add-json') { if (args.length) return null; let value; try { value = JSON.parse(target); } catch { return null; } const entry = serverEntry(value); return entry ? { name, entry } : null; }
  const url = /^https?:\/\//i.test(target);
  if (url && args.length) return null;
  const type = transport ?? (url ? 'http' : 'stdio');
  if (url !== (type === 'http' || type === 'sse') || !['http', 'sse', 'stdio'].includes(type)) return null;
  const entry = serverEntry(url ? { type, url: target, ...(Object.keys(headers).length ? { headers } : {}) } : { type, command: target, args, ...(Object.keys(env).length ? { env } : {}) });
  return entry ? { name, entry } : null;
}

// Where Claude Code keeps a server of this name: 'user', 'local' (for the project folder),
// or null.
export function serverScope(name, root) {
  let value; try { value = readJson(claudeFile()); } catch { return null; }
  if (value?.mcpServers && Object.hasOwn(value.mcpServers, name)) return 'user';
  if (root && value?.projects?.[root]?.mcpServers && Object.hasOwn(value.projects[root].mcpServers, name)) return 'local';
  return null;
}
// Runs claude mcp …: Claude Code's own command saves its file. What it prints is shown
// without the keys. The settings are on its command line while it runs, as claude mcp takes
// no other input for them.
function claudeMcp(args, { cwd = os.homedir(), secrets = [], timeoutMs = 60000 } = {}) {
  const bin = findBin('claude');
  if (!bin) refuse('Claude Code is not installed here: the claude command was not found.');
  return new Promise((resolve, reject) => {
    let said = '', child;
    try { child = spawn(bin, ['mcp', ...args], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { reject(new Error(scrub(error.message, secrets))); return; }
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    const take = data => { if (said.length < 4000) said += data; };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('error', error => { clearTimeout(timer); reject(new Error(scrub(error.message, secrets))); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, said: scrub(said, secrets).trim().split('\n').find(Boolean) ?? '' }); });
  });
}
// Adds a server to Claude Code for every folder. replace: one of that name is removed first.
export async function addServer(name, entry, { root = null, replace = false } = {}) {
  const problem = nameProblem(name); if (problem) refuse(problem);
  const clean = serverEntry(entry); if (!clean) refuse('These are not an MCP server\'s settings: give a URL, or a command.');
  const secrets = secretsOf(clean), scope = serverScope(name, root);
  if (scope && !replace) refuse(`${name} is already one of your Claude Code servers. Remove it first.`);
  if (scope) await removeServer(name, root);
  const { code, said } = await claudeMcp(['add-json', '--scope', 'user', '--', name, JSON.stringify(clean)], { secrets });
  if (code !== 0) refuse(`Claude Code did not add ${name}${said ? `: ${said}` : '.'}`);
  if (!serverScope(name, root)) refuse(`Claude Code did not add ${name}.`);
  return `Added ${name}. Sessions get it from their next turn.`;
}
export async function removeServer(name, root = null) {
  if (typeof name !== 'string' || !NAME.test(name)) refuse('Use an MCP server name from /mcp.');
  const scope = serverScope(name, root);
  if (!scope) refuse(`No MCP server named ${name}. /mcp lists yours.`);
  const { code, said } = await claudeMcp(['remove', '--scope', scope, '--', name], scope === 'local' ? { cwd: root } : {});
  if (code !== 0) refuse(`Claude Code did not remove ${name}${said ? `: ${said}` : '.'}`);
  return `Removed ${name}. Sessions stop getting it from their next turn.`;
}

// elu mcp's own arguments: --header, --env, --yes and --json, before a lone --. Every word
// after -- is the command and its arguments, as written, so a command's own options reach it.
export const MCP_USE = 'Use elu mcp add NAME URL [--header NAME], or elu mcp add NAME [--env NAME] -- COMMAND [ARGS]...';
export function mcpArguments(argv) {
  const flags = {}, words = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { words.push(...argv.slice(i + 1)); break; }
    if (arg === '-h' || arg === '--help') { flags.help = true; continue; }
    if (!arg.startsWith('--')) { words.push(arg); continue; }
    const cut = arg.indexOf('='), name = cut > 0 ? arg.slice(2, cut) : arg.slice(2), inline = cut > 0 ? arg.slice(cut + 1) : undefined;
    if (Object.hasOwn(flags, name)) refuse(`Duplicate option --${name}.`);
    if ((name === 'yes' || name === 'json') && inline === undefined) flags[name] = true;
    else if (name === 'header' || name === 'env') { const value = inline ?? argv[++i]; if (!value || value.startsWith('-')) refuse(`--${name} needs a value.`); flags[name] = value; }
    else refuse(`Unknown option ${arg}. A command's own options go after --. ${MCP_USE}`);
  }
  return { flags, words };
}
// elu mcp [list] | add NAME URL [--header NAME] | add NAME [--env NAME] -- COMMAND [ARGS…] |
// remove NAME [--yes]. The key is never an argument: it is read with echo off, or from
// standard input when that is not a terminal.
export async function mcpCli(words, flags, { root = null, input = process.stdin, output = process.stderr } = {}) {
  const [action = 'list', name, ...rest] = words;
  if (action === 'list') {
    const names = Object.keys(claudeServers(root));
    return { servers: names, message: names.length ? names.join('\n') : 'No MCP servers in Claude Code. elu mcp add NAME URL adds one.' };
  }
  if (action === 'add') {
    if (!name || !rest.length) refuse(MCP_USE);
    const problem = nameProblem(name); if (problem) refuse(problem);
    const url = /^https?:\/\//i.test(rest[0]);
    if (url && rest.length > 1) refuse(MCP_USE);
    // A key written here would stay in the shell's history.
    if (keyedLine(rest.join(' ')) || url && urlSecrets(rest[0]).length) refuse(`This holds a key. Never put a key on the command line: it stays in your shell history. ${url ? 'Use --header NAME to be asked for it, or /mcp add in ELU for a URL that holds its key.' : 'Use --env NAME to be asked for it.'}`);
    if (url ? flags.env : flags.header) refuse(url ? '--env goes with a command. A URL takes --header.' : '--header goes with a URL. A command takes --env.');
    const field = url ? flags.header : flags.env;
    if (field) { const wrong = (url ? headerProblem : envProblem)(field); if (wrong) refuse(`${wrong} Never put a key on the command line.`); }
    if (serverScope(name, root)) refuse(`${name} is already one of your Claude Code servers. elu mcp remove ${name} first.`);
    let value = null;
    if (field) { value = (await readSecret(`${field} (hidden): `, { input, output })).trim(); if (!value) refuse('No value was given. Nothing was added.'); }
    const entry = url ? { type: 'http', url: rest[0], ...(field ? { headers: { [field]: headerValue(field, value) } } : {}) } : { command: rest[0], args: rest.slice(1), ...(field ? { env: { [field]: value } } : {}) };
    return { added: name, message: await addServer(name, entry, { root }) };
  }
  if (action === 'remove') {
    if (!name || rest.length) refuse('Use elu mcp remove NAME.');
    if (!serverScope(name, root)) refuse(`No MCP server named ${name}. elu mcp lists yours.`);
    if (!flags.yes) {
      if (flags.json || !input.isTTY) refuse(`Add --yes to remove ${name}.`);
      const answer = await readLine(`Remove ${name} from your Claude Code servers? [y/N] `, { input, output });
      if (!/^y(?:es)?$/i.test(answer.trim())) return { removed: null, message: 'Nothing was removed.' };
    }
    return { removed: name, message: await removeServer(name, root) };
  }
  refuse('Use elu mcp, elu mcp add or elu mcp remove.');
}
// One line from the terminal, typed with echo off, or the first line of standard input.
export function readSecret(question, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) return new Promise((resolve, reject) => {
    let text = ''; input.setEncoding?.('utf8');
    input.on('data', chunk => { text += chunk; }); input.on('error', reject);
    input.on('end', () => resolve(text.split(/\r?\n/)[0] ?? ''));
  });
  return new Promise((resolve, reject) => {
    output.write(question); let text = '';
    const raw = input.isRaw; input.setRawMode?.(true); input.resume(); input.setEncoding?.('utf8');
    const done = (error, value) => { input.removeListener('data', onData); input.setRawMode?.(Boolean(raw)); input.pause(); output.write('\n'); if (error) reject(error); else resolve(value); };
    const onData = chunk => {
      for (const ch of String(chunk).replace(/\x1b\[20[01]~/g, '')) {
        if (ch === '\r' || ch === '\n' || ch === '\x04') return done(null, text);
        if (ch === '\x03') return done(new Error('Cancelled. Nothing was added.'));
        if (ch === '\x7f' || ch === '\b') text = text.slice(0, -1);
        else if (ch === '\x15') text = '';
        else if (ch >= ' ') text += ch;
      }
    };
    input.on('data', onData);
  });
}
function readLine(question, { input, output }) {
  return new Promise(resolve => {
    output.write(question); input.resume(); input.setEncoding?.('utf8'); let text = '';
    const onData = chunk => { text += chunk; if (/[\r\n]/.test(text)) { input.removeListener('data', onData); input.pause(); resolve(text.split(/\r?\n/)[0]); } };
    input.on('data', onData); input.once('end', () => resolve(text));
  });
}
// The approval relay: ELU's own stdio MCP server, started by Claude Code
// from the same private config file as the owner's servers, named as the permission prompt
// tool. Its arguments say which run it answers for; the state folder comes from the env.
export const APPROVAL_SERVER = 'elu-code-approval', APPROVAL_TOOL = `mcp__${APPROVAL_SERVER}__approve`;
const SERVER_SCRIPT = fileURLToPath(new URL('./approval-server.mjs', import.meta.url));
// cwd, access, rules: the turn's workspace, whether it edits, and which rules answer for the
// owner (saved or defaults; lib/permission-rules.mjs). Without rules every call asks.
// sandboxed: the turn's commands really run in Claude Code's sandbox. mode, folders and common:
// the turn's mode, the folders it may read beside its workspace (the home only when the turn
// reads across it) and the repository's Git folder, for the tools that send files to the
// owner's other computers (they read only what the turn may). helps: the session there this one
// helps, the only one those tools send to (lib/remote-helper.mjs).
export function approvalServer({ session, root, taskId, role, vendor, log, waitSeconds = APPROVAL_WAIT_SECONDS, cwd = null, access = null, rules = null, sandboxed = false, mode = null, folders = [], common = null, helps = null }) {
  if (typeof session !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(session)) refuse('An approval relay needs a plain session id.');
  if (typeof log !== 'string' || !path.isAbsolute(log)) refuse('An approval relay needs an absolute log path.');
  const args = [SERVER_SCRIPT, '--session', session, '--root', String(root ?? ''), '--task', String(taskId ?? ''), '--role', String(role ?? 'lead'), '--vendor', String(vendor ?? 'claude'), '--log', log, '--wait', String(waitSeconds), ...(cwd ? ['--cwd', cwd] : []), ...(access ? ['--access', access] : []), ...(rules ? ['--rules', rules] : []), ...(rules ? ['--sandboxed', sandboxed === true ? 'yes' : 'no'] : []), ...(mode ? ['--mode', mode, '--folders', JSON.stringify(folders ?? [])] : []), ...(common ? ['--common', common] : []), ...(helps ? ['--helps', helps] : [])];
  return { command: process.execPath, args, env: { HOME: os.homedir(), ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}) } };
}
// Server settings can hold tokens, so they go to a private file for one run, never to
// the command line. The file lives in ELU's own state folder, which no session may
// read; the shared temp folder is one a session can read. Its folder is named for the
// process that made it, and the caller removes it when the run ends. approval: the relay
// settings for this run (approvalServer), or null for a run that never asks.
const OWN = /^mcp-([1-9][0-9]*)-[A-Za-z0-9]{6}$/, EARLIER = /^elu-code-mcp-[A-Za-z0-9]{6}$/, EARLIER_AGE_MS = 60000;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const entries = dir => { try { return fs.readdirSync(dir); } catch { return []; } };
const drop = folder => { try { if (fs.lstatSync(folder).isDirectory()) fs.rmSync(folder, { recursive: true, force: true }); } catch { /* Gone already. */ } };
// Removes the settings a run left behind when its process died before it could: folders
// of a process that is gone, and the folders an earlier release made in the temp folder.
// It runs when ELU starts and never throws.
export function sweepServers() {
  const state = personalDirectory(), uid = process.getuid?.();
  for (const name of entries(state)) {
    const pid = Number(OWN.exec(name)?.[1] ?? 0);
    if (pid && pid !== process.pid && !alive(pid)) drop(path.join(state, name));
  }
  for (const dir of [systemTemp()]) {
    for (const name of entries(dir).filter(name => EARLIER.test(name))) {
      try { const stat = fs.lstatSync(path.join(dir, name)); if ((uid === undefined || stat.uid === uid) && Date.now() - stat.mtimeMs > EARLIER_AGE_MS) drop(path.join(dir, name)); } catch { /* Gone already. */ }
    }
  }
}
export function writeServers(names, root, { approval = null } = {}) {
  const all = claudeServers(root), picked = {};
  for (const name of names) {
    if (name === APPROVAL_SERVER) refuse(`The MCP server name ${APPROVAL_SERVER} is reserved for ELU's approval relay.`);
    if (!all[name]) refuse(`The MCP server ${name} is not set up in Claude Code. Run claude mcp list, or /mcp off ${name}.`);
    picked[name] = all[name];
  }
  if (approval) picked[APPROVAL_SERVER] = approvalServer(approval);
  const state = personalDirectory(); mkdir(state);
  const folder = fs.mkdtempSync(path.join(state, `mcp-${process.pid}-`)); fs.chmodSync(folder, 0o700);
  const file = path.join(folder, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: picked }), { mode: 0o600, flag: 'wx' });
  return { file, folder, names: Object.keys(picked) };
}
