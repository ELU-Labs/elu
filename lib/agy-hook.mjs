import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The PreToolUse hook an ELU launch of Antigravity CLI installs in every mode but Full
// access, which has no hook. agy's
// own settings deny or ask per permission action; this hook covers what they cannot: web
// search has no permission action, and the never list is matched on command text outside
// Full access, which has none. It reads
// the tool call on stdin and prints {"decision":"deny"|"ask","reason"}; no output means no
// opinion, so agy's own permission flow decides. A deny also exits 2 with the reason on
// stderr, the blocking convention hooks share. Anything unreadable denies. No imports from
// lib/: agy starts this script for every matched tool call, so it stays small and fast.
export const PROFILES = Object.freeze(['locked', 'ask', 'auto', 'full']);
export const TOOLS = Object.freeze(['search_web', 'run_command', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'generate_image', 'schedule', 'invoke_subagent', 'define_subagent']);
// What agy hands the hook on stdin. agy 1.5.13 sends { hookEventName: "PreToolUse",
// toolCall: { name, args, id }, conversationId, cwd, ... }: the tool's name is toolCall.name and
// its input toolCall.args, a command in args.CommandLine (seen on macOS with a hook that kept what
// it was given). tool_name and tool_input are the names the hooks of other tools use; they are
// read too, so a release that sends them is read the same.
export function toolCall(event) {
  const call = event?.toolCall && typeof event.toolCall === 'object' ? event.toolCall : null;
  const name = typeof call?.name === 'string' && call.name ? call.name : typeof event?.tool_name === 'string' && event.tool_name ? event.tool_name : null;
  return { tool: name, input: call && name === call.name ? call.args ?? null : event?.tool_input ?? null };
}
// Which tool calls reach the hook in each profile; the hook decides from there. Full access
// installs no hook, so it has no entry.
export const MATCHERS = Object.freeze({ locked: TOOLS.join('|'), ask: 'search_web|run_command', auto: TOOLS.join('|') });
// Push, tag, merge, deploy, publish and adding or removing an MCP server, by command text:
// a tripwire, not a boundary. Full access runs them.
// A command word ends where the word does: git merge-base and git tag-list are other
// commands, as they are to the other vendors' rules. Anything else after the word still counts.
const NEVER = [
  String.raw`^git(?:\s+(?:-[cC]\s+\S+|--?\S+))*\s+(?:push|tag|merge)`, String.raw`^gh\s+pr\s+merge`, String.raw`^gh\s+release`,
  String.raw`^(?:npm|pnpm|yarn|cargo)\s+publish`, String.raw`^(?:firebase|vercel|fly)\s+deploy`, String.raw`^gcloud\s+(?:run|app)\s+deploy`,
  String.raw`^kubectl\s+apply`, String.raw`^terraform\s+apply`,
  String.raw`^claude(?:\s+--?\S+)*\s+mcp(?:\s+--?\S+)*\s+(?:add|add-json|add-from-claude-desktop|remove)`, String.raw`^elu\s+mcp\s+(?:add|remove)`,
].map(source => new RegExp(`${source}(?![\\w-])`));
const deny = reason => ({ decision: 'deny', reason });
const ask = reason => ({ decision: 'ask', reason });
export function commandText(input) {
  for (const key of ['CommandLine', 'command', 'cmd']) if (typeof input?.[key] === 'string') return input[key];
  return input == null ? '' : typeof input === 'string' ? input : JSON.stringify(input);
}
export function neverListed(text) {
  return String(text).split(/\s*(?:\|\||&&|;|\||\n)\s*/).some(part => { const segment = part.trim().replace(/^(?:sudo|env)\s+/, ''); return NEVER.some(rule => rule.test(segment)); });
}
// The decision for one tool call, or null for no opinion.
export function decide(profile, event) {
  const { tool, input } = toolCall(event);
  if (!PROFILES.includes(profile) || !tool) return deny('ELU could not read this tool call.');
  if (profile === 'locked') return TOOLS.includes(tool) ? deny(`${tool} is not available in a read-only run.`) : null;
  if (tool === 'run_command' && profile !== 'full' && neverListed(commandText(input))) return deny('Push, tag, merge, deploy, publish and adding or removing an MCP server run only in Full access.');
  if (tool === 'search_web') return profile === 'ask' ? ask('Web search needs your approval.') : profile === 'auto' ? deny('Web search is off in Approve for me.') : null;
  if (profile === 'auto' && TOOLS.includes(tool)) return ask(`${tool} goes to the reviewer.`);
  return null;
}

// ---------------------------------------------------------------------------------------
// The turn of the bot that oversees the owner's sessions (lib/bots.mjs botOversees) has two
// profiles of its own, each with every tool call matched: oversee below the level Full, and
// oversee-full at it (OVERSEE_FULL, lib/orchestrator-seams.mjs), in Full access. Each reads the
// policy its launch wrote beside hooks.json (lib/adapters/agy.mjs overseePolicy): the session's
// mode, the MCP servers of the turn, the turn's approval relay (the options of ELU's approval
// server for this run, lib/mcp.mjs approvalServer) and the environment that relay runs with,
// and at Full the folders of ELU's own state that the turn never changes.
// What Claude Code's turn of that bot asks the relay (lib/approval-server.mjs overseeing), this
// hook asks it, by the same names: an MCP call as mcp__<server>__<tool>, web search as
// WebSearch, a fetch as WebFetch, a command as Bash. The relay answers from that bot's own table,
// counts its questions to ELU, and asks the owner what the table leaves to him, here as there:
// the hook waits for his answer. With no relay (a launch given no approval server) nothing can
// reach him, so whatever would ask him is refused, saying so.
// Only these two profiles load anything of lib/, and only for a call the relay decides.
export const OVERSEE_PROFILES = Object.freeze(['oversee', 'oversee-full']);
// ELU's approval relay (lib/mcp.mjs APPROVAL_SERVER) and its one tool for Claude Code's
// permission prompt, which no model calls.
export const RELAY_SERVER = 'elu-code-approval', RELAY_PROMPT = 'approve';
// Below Full the turn reads files and ends: these tools it uses unasked. ELU's tools, a source's
// and the web go to the relay. Any other tool is refused, as Claude Code's turn has no other.
export const OVERSEE_READS = Object.freeze(['view_file', 'read_file', 'list_dir', 'grep_search', 'find_by_name', 'view_file_outline', 'view_code_item', 'view_content_chunk', 'wait', 'wait_5_seconds', 'finish']);
const WEB_TOOLS = Object.freeze(['search_web', 'read_url_content', 'read_url']);
export const OVERSEE_REFUSED = 'A bot that oversees the sessions below the level Full edits nothing, runs no command and starts nothing: it reads files, and uses ELU\'s tools, a source and the web as its level allows. Do not retry it another way: say in your reply what you needed.';
export const OWN_REFUSED = "The bot that oversees the sessions never changes ELU's own files (its level, caps, mandates and action log, the owner's computers, the approvals he answers, the bots, his saved rules) or ELU's records of a session in a repository's Git folder: only ELU's own tools and commands do. Do not retry it another way.";
export const NO_RELAY = 'This asks the owner first, and this Antigravity turn has no way to reach him. It was not done. Do not retry it another way: say in your reply exactly what you would run or call, and why; he runs it or allows it.';
export const PROMPT_REFUSED = "That tool is ELU's own permission prompt for Claude Code. No model calls it.";
// A command that may be one of the ask list (lib/orchestrator-actions.mjs askListed) or name one
// of the bot's own files, by any of the words those rules look for: only such a command is
// handed to the relay at Full, so the others run without loading anything. It matches more than
// those rules do, never less; the relay decides each one it matches.
const ASKISH = /publish|tag|release|workflow|delete|force|-[A-Za-z]*f|mirror|\+|rm|deploy|apply|destroy|tofu|terraform|kubectl|helm|docker|vercel|orchestrator|mandates|computers|mine\.json|actions\.jsonl|elu-code/i;
// The call as Claude Code names it to the relay, or null for a tool the relay is not asked about.
export function relayCall(tool, input) {
  const first = (...names) => names.map(name => input?.[name]).find(value => typeof value === 'string' && value) ?? null;
  if (tool === 'call_mcp_tool') {
    const server = first('ServerName', 'serverName', 'server_name', 'server'), name = first('ToolName', 'toolName', 'tool_name', 'tool');
    const given = input?.Arguments ?? input?.arguments ?? input?.args ?? {};
    return server && name ? { tool: `mcp__${server}__${name}`, input: given && typeof given === 'object' ? given : {}, server, name } : { tool: 'mcp__unknown__unknown', input: {}, server: null, name: null };
  }
  if (tool === 'search_web') return { tool: 'WebSearch', input: { query: first('query', 'Query', 'search_query', 'SearchQuery') ?? commandText(input) } };
  if (tool === 'read_url_content' || tool === 'read_url') return { tool: 'WebFetch', input: { url: first('Url', 'url', 'URL', 'Uri', 'uri') ?? commandText(input) } };
  if (tool === 'run_command') return { tool: 'Bash', input: { command: commandText(input) } };
  return null;
}
// Every string a call is handed, at any depth, keys left out: where a path to one of the bot's
// own files would be. An input nested deeper than anyone writes one counts as naming one.
function strings(value, depth = 0, out = []) {
  if (depth > 8) { out.push(null); return out; }
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, depth + 1, out);
  return out;
}
const within = (file, dir) => file === dir || file.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
// A path a call is handed that lies in ELU's own state (own: its folders under each spelling)
// or in ELU's records of a session (a .git/elu-code folder anywhere). Resolved from cwd, and
// through its links as far as it exists.
function namesOwn(value, { own = [], cwd = '/', home = '/' } = {}) {
  return strings(value).some(text => {
    if (text === null) return true;
    if (/(?:^|[/\\])\.git[/\\]+elu-code(?:[/\\]|$)/.test(text)) return true;
    if (!/^(?:\/|~\/|\.{1,2}\/)/.test(text) || text.length > 4096) return false;
    const file = text.startsWith('~/') ? path.join(home, text.slice(2)) : path.resolve(cwd, text);
    let real = file; try { real = fs.realpathSync(file); } catch { try { real = path.join(fs.realpathSync(path.dirname(file)), path.basename(file)); } catch { real = file; } }
    return own.some(dir => typeof dir === 'string' && path.isAbsolute(dir) && (within(file, dir) || within(real, dir)));
  });
}
// The relay's answer for one call, as Claude Code's turn gets it, written to the relay's log as
// the approval server writes it; null when there is no relay.
async function askRelay(policy, call, callId) {
  const relay = policy?.relay;
  if (!relay) return null;
  // The relay reads ELU's own folder, which it finds from the environment the approval server is given.
  for (const [key, value] of Object.entries(policy.env ?? {})) if (typeof value === 'string') process.env[key] = value;
  const { overseeing } = await import('./approval-server.mjs');
  const use = String(callId ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 78) || `hook-${process.pid}-${Date.now()}`;
  const out = await overseeing(call.tool, call.input, { id: `${relay.session}-${use}`, mode: relay.mode, root: relay.root, taskId: relay.task, role: relay.role, vendor: relay.vendor, bot: relay.oversee, servers: relay.servers, run: relay.session, cwd: relay.cwd, access: relay.access, rules: relay.rules, sandboxed: relay.sandboxed === 'yes', waitSeconds: relay.wait });
  // What Full allows by itself is not written, as Claude Code's turn never asks the relay about it.
  if (typeof relay.log === 'string' && path.isAbsolute(relay.log) && !(out.decision === 'allow' && out.by === 'full')) {
    try { fs.appendFileSync(relay.log, `${JSON.stringify({ id: `${relay.session}-${use}`, tool: call.tool, summary: out.summary, decision: out.decision, ...(out.by ? { by: out.by } : {}), ...(out.rule ? { rule: out.rule } : {}), ...(out.decision === 'timeout' ? { wait: relay.wait } : {}), at: new Date().toISOString() })}\n`, { mode: 0o600 }); } catch { /* The decision still reaches agy. */ }
  }
  return out;
}
// Without a relay: the bot's own table (lib/orchestrator-tools.mjs overseeingAnswer) decides what
// it allows and refuses, and what it would ask the owner is refused. A question to ELU is one it
// cannot count against his cap, so it is refused too.
async function withoutRelay(policy, call, full) {
  for (const [key, value] of Object.entries(policy?.env ?? {})) if (typeof value === 'string') process.env[key] = value;
  let answer = 'deny';
  try { answer = (await import('./orchestrator-tools.mjs')).overseeingAnswer(call.tool, { mode: policy?.mode ?? null, servers: policy?.servers ?? [], input: call.input, full, cwd: policy?.cwd ?? null }); } catch { answer = 'deny'; }
  if (answer === 'allow' && !(String(call.server ?? '').toLowerCase() === 'elu' && call.name === 'ask_elu')) return { decision: 'allow' };
  if (answer === 'deny') return { decision: 'deny', message: full ? OWN_REFUSED : OVERSEE_REFUSED };
  return { decision: 'deny', message: NO_RELAY };
}
const asked = async (policy, call, callId, full) => (await askRelay(policy, call, callId)) ?? await withoutRelay(policy, call, full);
const verdictOf = out => out.decision === 'allow' ? null : deny(out.message || NO_RELAY);
// The decision for one tool call of the overseeing turn, or null for no opinion. policy: what
// the launch wrote (null when it could not be read: every call is refused). relay(call): for the
// tests, in place of asking ELU's relay.
export async function decideOversee(profile, event, policy, { relay = null } = {}) {
  const { tool, input } = toolCall(event), full = profile === 'oversee-full';
  if (!OVERSEE_PROFILES.includes(profile) || !tool || !policy || typeof policy !== 'object') return deny('ELU could not read this tool call.');
  const ask = relay ?? (call => asked(policy, call, event?.toolCall?.id, full));
  const call = relayCall(tool, input);
  if (call?.server === RELAY_SERVER && call.name === RELAY_PROMPT) return deny(PROMPT_REFUSED);
  if (!full) {
    if (OVERSEE_READS.includes(tool)) return null;
    if (tool === 'call_mcp_tool' || WEB_TOOLS.includes(tool)) return verdictOf(await ask(call));
    return deny(OVERSEE_REFUSED);
  }
  // At Full: every tool, as a Full access turn has. What it never changes is refused here, by
  // its path; a command of the ask list asks the owner through the relay; a source's tool keeps
  // the relay's rules; reading and the web are open.
  if (OVERSEE_READS.includes(tool) || WEB_TOOLS.includes(tool)) return null;
  if (tool === 'call_mcp_tool') return verdictOf(await ask(call));
  if (tool === 'run_command') {
    const text = commandText(input);
    if ((policy.named ?? []).some(name => typeof name === 'string' && name && text.includes(name)) || /\.git[/\\]+elu-code/.test(text)) return deny(OWN_REFUSED);
    return ASKISH.test(text) ? verdictOf(await ask(call)) : null;
  }
  return namesOwn(input, { own: policy.own ?? [], cwd: policy.cwd ?? '/', home: policy.home ?? '/' }) ? deny(OWN_REFUSED) : null;
}
const readPolicy = file => { try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; } };
async function main() {
  const at = process.argv.indexOf('--profile'), profile = at > 0 ? process.argv[at + 1] : null;
  let event = null;
  try { event = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { /* Unreadable: denied below. */ }
  let verdict;
  if (OVERSEE_PROFILES.includes(profile)) {
    const given = process.argv.indexOf('--policy'), file = given > 0 ? process.argv[given + 1] : null;
    try { verdict = await decideOversee(profile, event, file && path.isAbsolute(file) ? readPolicy(file) : null); } catch { verdict = deny('ELU could not decide this tool call, so it was not done.'); }
  } else verdict = decide(profile, event);
  if (!verdict) return;
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  if (verdict.decision === 'deny') { process.stderr.write(`${verdict.reason}\n`); process.exitCode = 2; }
}
let direct = false;
try { direct = Boolean(process.argv[1]) && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url; } catch { /* Imported, or started another way. */ }
// Not awaited at the top: ELU's relay, which the oversee profiles load, imports this file too,
// and a top-level wait here would hold that import until it ended, which it never would.
if (direct) main().catch(() => { process.stdout.write(`${JSON.stringify(deny('ELU could not decide this tool call, so it was not done.'))}\n`); process.exitCode = 2; });
