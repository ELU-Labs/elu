import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// The PreToolUse hook every ELU launch of Antigravity CLI installs. agy's
// own settings deny or ask per permission action; this hook covers what they cannot: web
// search has no permission action, and the never list is matched on command text. It reads
// the tool call on stdin and prints {"decision":"deny"|"ask","reason"}; no output means no
// opinion, so agy's own permission flow decides. A deny also exits 2 with the reason on
// stderr, the blocking convention hooks share. Anything unreadable denies. No imports from
// lib/: agy starts this script for every matched tool call, so it stays small and fast.
export const PROFILES = Object.freeze(['locked', 'ask', 'auto', 'full']);
export const TOOLS = Object.freeze(['search_web', 'run_command', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'generate_image', 'schedule', 'invoke_subagent', 'define_subagent']);
// Which tool calls reach the hook in each profile; the hook decides from there.
export const MATCHERS = Object.freeze({ locked: TOOLS.join('|'), ask: 'search_web|run_command', auto: TOOLS.join('|'), full: 'run_command' });
// Push, tag, merge, deploy, publish and adding or removing an MCP server, by command text:
// a tripwire, not a boundary.
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
  const tool = typeof event?.tool_name === 'string' ? event.tool_name : null;
  if (!PROFILES.includes(profile) || !tool) return deny('ELU could not read this tool call.');
  if (profile === 'locked') return TOOLS.includes(tool) ? deny(`${tool} is not available in a read-only run.`) : null;
  if (tool === 'run_command' && neverListed(commandText(event.tool_input))) return deny('Push, tag, merge, deploy, publish and adding or removing an MCP server are never run by the model.');
  if (tool === 'search_web') return profile === 'ask' ? ask('Web search needs your approval.') : profile === 'auto' ? deny('Web search is off in Approve for me.') : null;
  if (profile === 'auto' && TOOLS.includes(tool)) return ask(`${tool} goes to the reviewer.`);
  return null;
}
function main() {
  const at = process.argv.indexOf('--profile'), profile = at > 0 ? process.argv[at + 1] : null;
  let event = null;
  try { event = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { /* Unreadable: denied below. */ }
  const verdict = decide(profile, event);
  if (!verdict) return;
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  if (verdict.decision === 'deny') { process.stderr.write(`${verdict.reason}\n`); process.exitCode = 2; }
}
let direct = false;
try { direct = Boolean(process.argv[1]) && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url; } catch { /* Imported, or started another way. */ }
if (direct) main();
