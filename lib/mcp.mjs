import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, personalDirectory, readJson, refuse } from './util.mjs';
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
// Tells the lead which servers it has, and how the owner turns on one that is off.
export function serverNote(root, on) {
  const off = Object.keys(claudeServers(root)).filter(name => !on.includes(name));
  return [
    on.length ? `MCP servers on for you (tools named mcp__NAME__*): ${on.join(', ')}.` : '',
    off.length ? `The owner's other Claude Code MCP servers are off for you: ${off.join(', ')}. When a request needs one of them, tell the owner to type /mcp on NAME in the message box, with that server's name, and then ask again.` : '',
  ].filter(Boolean).join(' ');
}
// The approval relay: ELU Code's own stdio MCP server, started by Claude Code
// from the same private config file as the owner's servers, named as the permission prompt
// tool. Its arguments say which run it answers for; the state folder comes from the env.
export const APPROVAL_SERVER = 'elu-code-approval', APPROVAL_TOOL = `mcp__${APPROVAL_SERVER}__approve`;
const SERVER_SCRIPT = fileURLToPath(new URL('./approval-server.mjs', import.meta.url));
// cwd, access, rules: the turn's workspace, whether it edits, and which rules answer for the
// owner (saved or defaults; lib/permission-rules.mjs). Without rules every call asks.
export function approvalServer({ session, root, taskId, role, vendor, log, waitSeconds = APPROVAL_WAIT_SECONDS, cwd = null, access = null, rules = null }) {
  if (typeof session !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(session)) refuse('An approval relay needs a plain session id.');
  if (typeof log !== 'string' || !path.isAbsolute(log)) refuse('An approval relay needs an absolute log path.');
  const args = [SERVER_SCRIPT, '--session', session, '--root', String(root ?? ''), '--task', String(taskId ?? ''), '--role', String(role ?? 'lead'), '--vendor', String(vendor ?? 'claude'), '--log', log, '--wait', String(waitSeconds), ...(cwd ? ['--cwd', cwd] : []), ...(access ? ['--access', access] : []), ...(rules ? ['--rules', rules] : [])];
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
