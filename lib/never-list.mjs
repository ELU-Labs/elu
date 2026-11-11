// The never list in words: for the chat's Blocked line, for the instructions every model
// gets and for what a stand-in command says when it refuses (never-shims.mjs). The rules
// that refuse are each vendor's own, in its adapter; nothing here allows or refuses anything.
import os from 'node:os';
import path from 'node:path';
import { NEVER_RULES, MERGE_RULE, SENSITIVE } from './adapters/claude.mjs';
import { HOME_SECRETS } from './vendors.mjs';
import { personalDirectory } from './util.mjs';
import { approvalSummary } from './approvals.mjs';

const named = rule => /^Bash\((.+):\*\)$/.exec(rule)[1];
// The commands no mode allows, as the rules name them.
export const NEVER_COMMANDS = Object.freeze(NEVER_RULES.map(named));
// merge: a bot the owner lets merge pull requests; gh pr merge is then not on its list.
export const neverCommands = ({ merge = false } = {}) => merge === true ? NEVER_COMMANDS.filter(command => command !== named(MERGE_RULE)) : [...NEVER_COMMANDS];
// The refusal as the Blocked line and a stand-in command word it.
export const neverSentence = command => `${command} is never allowed, in any mode`;
// The never-list command a stand-in refused, read from what a command printed, or null. A
// stand-in prints the sentence as a line of its own.
export function refusedIn(output) {
  for (const line of String(output ?? '').split('\n')) { const said = line.trim(), found = NEVER_COMMANDS.find(command => said === `${neverSentence(command)}.`); if (found) return found; }
  return null;
}
// One line for the model, once a turn: the commands by name, that a longer line holding
// one counts too, and the read-only way to list tags, which models reach for git tag to do.
export const neverLine = options => `Never run these, alone or inside a longer command line, in any mode: ${neverCommands(options).join(', ')}. To list tags use git for-each-ref --sort=-creatordate refs/tags or git describe --tags, never git tag.`;

// The commands of a shell line as a vendor's rules read it: each side of && || ; | |& & and
// a new line, and what runs inside $( ), backticks and ( ). Quoted text is one piece.
export function shellParts(line) {
  const text = String(line ?? ''), out = [], stack = [{ close: null, quote: null, text: '' }];
  const cut = () => { const frame = stack.at(-1), part = frame.text.trim(); if (part) out.push(part); frame.text = ''; };
  for (let i = 0; i < text.length; i++) {
    const frame = stack.at(-1), ch = text[i], two = text.slice(i, i + 2);
    if (frame.quote === "'") { if (ch === "'") frame.quote = null; frame.text += ch; continue; }
    if (ch === '\\') { frame.text += two; i++; continue; }
    if (two === '$(') { stack.push({ close: ')', quote: null, text: '' }); i++; continue; }
    if (ch === '`') { if (frame.close === '`') { cut(); stack.pop(); } else stack.push({ close: '`', quote: null, text: '' }); continue; }
    if (frame.quote === '"') { if (ch === '"') frame.quote = null; frame.text += ch; continue; }
    if (ch === '"' || ch === "'") { frame.quote = ch; frame.text += ch; continue; }
    if (ch === '(') { cut(); stack.push({ close: ')', quote: null, text: '' }); continue; }
    if (ch === ')') { cut(); if (stack.length > 1 && frame.close === ')') stack.pop(); continue; }
    if (['&&', '||', '|&', ';;'].includes(two)) { cut(); i++; continue; }
    // 2>&1 and &> point output somewhere; they do not end a command.
    if (ch === '&' && (text[i - 1] === '>' || text[i + 1] === '>')) { frame.text += ch; continue; }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n') { cut(); continue; }
    frame.text += ch;
  }
  while (stack.length) { cut(); stack.pop(); }
  return out;
}
// What is dropped before a command is compared: the shell words that open a body, a leading
// VAR=value, and the wrappers timeout, time, nice, nohup, stdbuf, command, builtin, noglob
// and a bare xargs.
function bare(part) {
  let text = part.replace(/\s+/g, ' ').trim();
  for (let was = null; was !== text;) {
    was = text;
    text = text.replace(/^(?:if|then|else|elif|do|while|until|!|\{)\s+/, '')
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"']*)\s+/, '')
      .replace(/^(?:time|nohup|builtin|noglob)\s+/, '')
      .replace(/^command\s+(?!-[vV]\b)/, '')
      .replace(/^nice(?:\s+(?:-n\s*-?\d+|--adjustment=-?\d+|-\d+))?\s+/, '')
      .replace(/^stdbuf(?:\s+-\S+)*\s+/, '')
      .replace(/^timeout(?:\s+(?:-[sk]\s+\S+|--(?:signal|kill-after)(?:=\S+|\s+\S+)|-\S+))*\s+\S+\s+/, '')
      .replace(/^xargs\s+(?!-)/, '');
  }
  return text;
}
// The never-list command a shell line holds, alone or as one of its parts, or null. A line
// with a here-document is not read: its body is text, not commands, and this cannot tell
// the two apart.
export function neverPart(line, options) {
  const text = String(line ?? '');
  if (/<<[^<]/.test(text)) return null;
  const list = neverCommands(options);
  for (const part of shellParts(text)) { const command = bare(part), found = list.find(name => command === name || command.startsWith(`${name} `)); if (found) return found; }
  return null;
}

const READS = ['Read', 'Grep', 'Glob'], EDITS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
// The vendors whose never list is a rule or a hook on the command's text. Where stand-in
// commands hold the list, the adapter says which command one refused (denial.never).
const RULED = ['claude', 'grok', 'agy'];
const within = (file, dir) => file === dir || file.startsWith(`${dir}${path.sep}`);
const glob = name => new RegExp(`^${name.replace(/[.+^$(){}|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
// Why no mode would have allowed a refused action, or null when a wider mode could.
//   never: a never-list command; command is its name, line the whole line, alone whether
//     the line runs nothing else. denial.never: the command a stand-in said it refused
//   secret, own: a file that may hold secrets, or ELU Code's own, closed in every mode
//   owner, timeout: Full access asked the owner, who said no or did not answer
//   rule: refused in Full access by something this cannot name
// asked: the approvals of that run, as the task keeps them.
export function whyBlocked(denial, { mode = null, vendor = null, asked = [] } = {}) {
  const tool = String(denial?.tool ?? ''), input = denial?.input && typeof denial.input === 'object' ? denial.input : {}, field = name => typeof input[name] === 'string' ? input[name] : '';
  const summary = typeof denial?.summary === 'string' ? denial.summary : '';
  const line = tool === 'Bash' ? field('command') : /^Run:? /.test(summary) ? summary.replace(/^Run:? /, '') : '';
  if (line && RULED.includes(vendor)) { const command = neverPart(line); if (command) return { kind: 'never', command, line, alone: shellParts(line).length === 1 }; }
  // A stand-in command refused it, wherever in the line or in a script it ran. The line is shown without the shell a vendor wraps it in.
  if (NEVER_COMMANDS.includes(denial?.never)) { const inner = /^\S*sh -l?c (['"])(.*)\1$/s.exec(line)?.[2] ?? line; return { kind: 'never', command: denial.never, line: inner || denial.never, alone: neverPart(inner) === denial.never && shellParts(inner).length === 1 }; }
  const file = field('file_path') || field('notebook_path') || field('path');
  if (file && vendor === 'claude' && [...READS, ...EDITS].includes(tool)) {
    const full = path.resolve(file);
    if (within(full, path.resolve(personalDirectory()))) return { kind: 'own' };
    if (READS.includes(tool) && (SENSITIVE.some(name => glob(name).test(path.basename(full))) || HOME_SECRETS.some(name => within(full, path.join(os.homedir(), name))))) return { kind: 'secret' };
  }
  if (mode !== 'full') return null;
  const answer = summary || !tool ? null : asked.findLast(row => row.decision !== 'allow' && row.summary === approvalSummary(tool, input));
  return { kind: answer ? answer.decision === 'timeout' ? 'timeout' : 'owner' : 'rule' };
}
