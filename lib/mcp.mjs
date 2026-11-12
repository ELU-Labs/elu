import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { findBin, mkdir, personalDirectory, readJson, refuse } from './util.mjs';
import { APPROVAL_WAIT_SECONDS } from './modes.mjs';

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
// owner adds one: the model cannot, and a key never goes through the chat.
export const ADD_NOTE = "When a request needs an MCP server the owner does not have, tell the owner to type /mcp add in the message box: it asks for the server's URL and key and keeps the key out of the chat. Never ask for a key, token or password in the chat. You cannot add a server yourself.";
export function serverNote(root, on) {
  const off = Object.keys(claudeServers(root)).filter(name => !on.includes(name));
  return [
    on.length ? `MCP servers on for you (tools named mcp__NAME__*): ${on.join(', ')}.` : '',
    off.length ? `The owner's other Claude Code MCP servers are off for you: ${off.join(', ')}. When a request needs one of them, tell the owner to type /mcp on NAME in the message box, with that server's name, and then ask again.` : '',
    ADD_NOTE,
  ].filter(Boolean).join(' ');
}

// Adding and removing a server. It is saved by Claude Code's own command (claude mcp
// add-json --scope user), never by writing its file here, and the key in it is never shown,
// logged or sent to a model. A new name is one Claude Code takes.
const NEW_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export function nameProblem(name) {
  if (typeof name !== 'string' || !NEW_NAME.test(name)) return 'A server name is up to 64 letters, digits, - and _.';
  if (name === APPROVAL_SERVER) return `${APPROVAL_SERVER} is ELU Code's own server. Use another name.`;
  return null;
}
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/, ENV = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
export const headerProblem = value => HEADER.test(value) ? null : 'Type only the header\'s name, such as Authorization. Its value is asked for next.';
export const envProblem = value => ENV.test(value) ? null : 'Type only the variable\'s name, such as API_KEY. Its value is asked for next.';
const strings = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([key, item]) => names.test(key) && typeof item === 'string') ? value : null;
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
// The values in a server's settings that may be keys: its headers, its environment, and a
// bearer token in its arguments. They are taken out of anything Claude Code prints.
export function secretsOf(entry) {
  const values = [...Object.values(entry?.headers ?? {}), ...Object.values(entry?.env ?? {}), ...(entry?.args ?? []).filter(arg => /bearer\s+\S|token|key|secret/i.test(arg))];
  const parts = values.flatMap(value => [value.trim(), ...value.split(/[\s:=]+/).filter(part => part.length >= 8 && (/[^A-Za-z-]/.test(part) || part.length >= 20))]).filter(value => value.length >= 4);
  return [...new Set(parts)].sort((a, b) => b.length - a.length);
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
// found also inside a larger file; { NAME: server, … }; or one server with no name.
function serversIn(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) return null;
  const named = map => {
    if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
    const rows = Object.entries(map).map(([name, server]) => ({ name, entry: serverEntry(server) }));
    return rows.length && rows.every(row => row.entry) ? rows : null;
  };
  for (const key of ['mcpServers', 'servers']) { const rows = named(value[key]); if (rows) return rows; }
  const one = serverEntry(value); if (one) return [{ name: null, entry: one }];
  const rows = named(value); if (rows) return rows;
  for (const item of Object.values(value)) { const inner = serversIn(item, depth + 1); if (inner) return inner; }
  return null;
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
// Text that looks like a server's settings with a key in it, though it does not read as a
// config: it is held back from a model too, until it is sent a second time.
export const keyedConfigText = text => /mcpServers|"(?:url|command)"\s*:/i.test(text) && /Bearer\s+[A-Za-z0-9._~+/=-]{8,}|"(?:authorization|x-api-key|api[_-]?key|token)"\s*:\s*"[^"\s]{8,}"/i.test(text);

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
  const { code, said } = await claudeMcp(['add-json', '--scope', 'user', name, JSON.stringify(clean)], { secrets });
  if (code !== 0) refuse(`Claude Code did not add ${name}${said ? `: ${said}` : '.'}`);
  if (!serverScope(name, root)) refuse(`Claude Code did not add ${name}.`);
  return `Added ${name}. Sessions get it from their next turn.`;
}
export async function removeServer(name, root = null) {
  if (typeof name !== 'string' || !NAME.test(name)) refuse('Use an MCP server name from /mcp.');
  const scope = serverScope(name, root);
  if (!scope) refuse(`No MCP server named ${name}. /mcp lists yours.`);
  const { code, said } = await claudeMcp(['remove', '--scope', scope, name], scope === 'local' ? { cwd: root } : {});
  if (code !== 0) refuse(`Claude Code did not remove ${name}${said ? `: ${said}` : '.'}`);
  return `Removed ${name}. Sessions stop getting it from their next turn.`;
}

// elu mcp [list] | add NAME URL [--header NAME] | add NAME COMMAND [ARGS…] [--env NAME] |
// remove NAME [--yes]. The key is never an argument: it is read with echo off, or from
// standard input when that is not a terminal.
export async function mcpCli(words, flags, { root = null, input = process.stdin, output = process.stderr } = {}) {
  const [action = 'list', name, ...rest] = words;
  if (action === 'list') {
    const names = Object.keys(claudeServers(root));
    return { servers: names, message: names.length ? names.join('\n') : 'No MCP servers in Claude Code. elu mcp add NAME URL adds one.' };
  }
  if (action === 'add') {
    const use = 'Use elu mcp add NAME URL [--header NAME], or elu mcp add NAME COMMAND [ARGS...] [--env NAME].';
    if (!name || !rest.length) refuse(use);
    const problem = nameProblem(name); if (problem) refuse(problem);
    const url = /^https?:\/\//i.test(rest[0]);
    if (url && rest.length > 1) refuse(use);
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
// The approval relay: ELU Code's own stdio MCP server, started by Claude Code
// from the same private config file as the owner's servers, named as the permission prompt
// tool. Its arguments say which run it answers for; the state folder comes from the env.
export const APPROVAL_SERVER = 'elu-code-approval', APPROVAL_TOOL = `mcp__${APPROVAL_SERVER}__approve`;
const SERVER_SCRIPT = fileURLToPath(new URL('./approval-server.mjs', import.meta.url));
export function approvalServer({ session, root, taskId, role, vendor, log, waitSeconds = APPROVAL_WAIT_SECONDS }) {
  if (typeof session !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(session)) refuse('An approval relay needs a plain session id.');
  if (typeof log !== 'string' || !path.isAbsolute(log)) refuse('An approval relay needs an absolute log path.');
  const args = [SERVER_SCRIPT, '--session', session, '--root', String(root ?? ''), '--task', String(taskId ?? ''), '--role', String(role ?? 'lead'), '--vendor', String(vendor ?? 'claude'), '--log', log, '--wait', String(waitSeconds)];
  return { command: process.execPath, args, env: { HOME: os.homedir(), ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}) } };
}
// Server settings can hold tokens, so they go to a private file for one run, never to
// the command line. The file lives in ELU Code's own state folder, which no session may
// read; the shared temp folder is one a session can read. Its folder is named for the
// process that made it, and the caller removes it when the run ends. approval: the relay
// settings for this run (approvalServer), or null for a run that never asks.
const OWN = /^mcp-([1-9][0-9]*)-[A-Za-z0-9]{6}$/, EARLIER = /^elu-code-mcp-[A-Za-z0-9]{6}$/, EARLIER_AGE_MS = 60000;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const entries = dir => { try { return fs.readdirSync(dir); } catch { return []; } };
const drop = folder => { try { if (fs.lstatSync(folder).isDirectory()) fs.rmSync(folder, { recursive: true, force: true }); } catch { /* Gone already. */ } };
// Removes the settings a run left behind when its process died before it could: folders
// of a process that is gone, and the folders an earlier release made in the temp folder.
// It runs when ELU Code starts and never throws.
export function sweepServers() {
  const state = personalDirectory(), uid = process.getuid?.();
  for (const name of entries(state)) {
    const pid = Number(OWN.exec(name)?.[1] ?? 0);
    if (pid && pid !== process.pid && !alive(pid)) drop(path.join(state, name));
  }
  const temps = [os.tmpdir()]; try { temps.push(fs.realpathSync(os.tmpdir())); } catch { /* Listed as named. */ }
  for (const dir of new Set(temps)) {
    for (const name of entries(dir).filter(name => EARLIER.test(name))) {
      try { const stat = fs.lstatSync(path.join(dir, name)); if ((uid === undefined || stat.uid === uid) && Date.now() - stat.mtimeMs > EARLIER_AGE_MS) drop(path.join(dir, name)); } catch { /* Gone already. */ }
    }
  }
}
export function writeServers(names, root, { approval = null } = {}) {
  const all = claudeServers(root), picked = {};
  for (const name of names) {
    if (name === APPROVAL_SERVER) refuse(`The MCP server name ${APPROVAL_SERVER} is reserved for ELU Code's approval relay.`);
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
