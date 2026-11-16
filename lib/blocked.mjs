import os from 'node:os';
import path from 'node:path';
import { APPROVAL_WAIT_SECONDS, LABELS, MODES, isPeerRun } from './modes.mjs';
import { liftedBy, neverSentence, whyBlocked } from './never-list.mjs';
import { redact } from './publish.mjs';
import { cut } from './width.mjs';
import { botOfKey, getBot } from './bots.mjs';

// The Blocked lines a session shows under its last turn: what was refused, why, and the one
// thing to do. The window on the computer that runs the session draws them, and so does my
// other computer that follows it (lib/peer/remote.mjs sends them, lib/terminal-remote.mjs draws them).
const plain = value => redact(String(value ?? '')).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const clip = (value, width) => cut(plain(value), width, '...');
const shortHome = value => { const home = os.homedir(); return value === home ? '~' : value.startsWith(`${home}/`) ? `~${value.slice(home.length)}` : value; };
// A path as the Blocked line shows it: inside the session's folder, from there; else from ~.
function shortPath(value, cwd) {
  const file = String(value ?? ''); if (!file) return '';
  const full = cwd ? path.resolve(cwd, file) : file, inside = cwd && (full === cwd || full.startsWith(`${cwd}/`));
  const shown = inside ? path.relative(cwd, full) || '.' : shortHome(full);
  return shown.length > 70 ? `…${shown.slice(-69)}` : shown;
}
// What a denied action was, for the Blocked line: "Edit src/app.ts". cwd: the session's folder.
export function blockedText(denial, cwd = null) {
  const tool = String(denial?.tool ?? denial?.tool_name ?? ''), input = denial?.input ?? denial?.tool_input ?? {}, field = name => typeof input?.[name] === 'string' ? input[name] : '';
  const command = () => { const line = field('command').replace(/\s+/g, ' ').trim(); return line.length > 80 ? `${line.slice(0, 79)}…` : line; };
  const text = denial?.network ? `Connect to ${denial.network}` : typeof denial?.readonly === 'string' ? denial.readonly ? `Write ${shortPath(denial.readonly, cwd)}` : `Run ${command()}`
    : denial?.summary ? String(denial.summary) : tool === 'Bash' ? `Run ${command()}` : ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) ? `Edit ${shortPath(field('file_path') || field('notebook_path'), cwd)}` : tool === 'Read' && field('file_path') ? `Read ${shortPath(field('file_path'), cwd)}` : tool === 'WebFetch' ? `Open ${field('url')}` : tool === 'WebSearch' ? 'Search the web' : `Use ${tool || 'a tool'}`;
  return plain(text).replace(/\s+/g, ' ').trim().slice(0, 160);
}
const waitText = seconds => seconds >= 120 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`;
// One Blocked line: what was refused, why, and the one thing to do, with commands that exist
// here. kind is why (lib/never-list.mjs whyBlocked); a raised mode that lifts it continues the
// turn (setMode). run: the run that was refused; asked: its approvals; full: whether this
// session may have Full access; current: the session's mode now, which may already lift it.
// what: the action alone, as the continuation names it. there: the words of the one thing to
// do that only the computer that runs the session can do (a /permissions command, doing it
// yourself), which my other computer says is done there; none where a reply does it.
export const ranIn = run => MODES.includes(run?.effectivePermissions) ? run.effectivePermissions : MODES.includes(run?.permissions) ? run.permissions : 'locked';
export function blockedLine(denial, run, asked = [], { cwd = null, full = true, current = null, waits = true } = {}) {
  // The mode the turn really ran in: one asked for Approve for me may have run in Ask for approval.
  const what = blockedText(denial, cwd), mode = MODES.includes(run?.effectivePermissions) ? run.effectivePermissions : run?.permissions ?? null, why = whyBlocked(denial, { mode, vendor: run?.vendor ?? null, asked });
  const toFull = full ? '/permissions full continues it.' : 'this session cannot have Full access, so do it yourself.', fullThere = full ? '/permissions full' : 'do it yourself';
  if (why.kind === 'never') { const line = plain(why.line).replace(/\s+/g, ' ').trim(); return { kind: why.kind, what, text: `Blocked: ${neverSentence(why.command)}${line === why.command ? '' : ` (${why.alone ? '' : 'part of: '}${clip(line, 120)})`}. Run it yourself.`, there: 'Run it yourself' }; }
  // The mode was raised after the turn stopped, to one that lifts this: a reply goes on.
  if (['network', 'full', 'ask', 'reviewer'].includes(why.kind) && MODES.includes(current) && current !== ranIn(run) && liftedBy(why.kind, current)) return { kind: why.kind, what, text: `Blocked: ${what}. ${LABELS[current]} is on now: reply to continue.` };
  const text = {
    secret: `Blocked: ${what}. Files that may hold secrets stay closed: open it yourself.`,
    own: `Blocked: ${what}. ELU's own files stay closed in every mode.`,
    // waits: the turn stopped there. One that went on without it says what it left undone.
    timeout: `${waits ? 'Stopped' : 'Not done'}: ${what}. No answer in ${waitText(why.wait ?? APPROVAL_WAIT_SECONDS)}; reply to try again.`,
    owner: `Stopped: ${what}. You said no; reply with what to do instead.`,
    network: `Blocked: ${what}. The internet is off for commands in ${LABELS[mode] ?? LABELS.locked}: ${toFull}`,
    full: `Blocked: ${what}. Needs Full access: ${toFull}`,
    ask: `Blocked: ${what}. This session is read only: /permissions ask continues it.`,
    reviewer: `Blocked: ${what}. Approve for me's reviewer said no: /permissions ask lets you decide.`,
    // Shown while the session waits for him, where /publish would refuse: the changes are checked first.
    git: `Blocked: ${denial?.tool === 'Bash' ? blockedText({ tool: 'Bash', input: denial.input }) : what}. No commit is needed: ELU commits when you publish. Reply to go on.`,
    rule: `Blocked: ${what}. A rule no mode lifts refused it.`,
  }[why.kind];
  const there = { secret: 'open it yourself', network: fullThere, full: fullThere, ask: '/permissions ask', reviewer: '/permissions ask' }[why.kind];
  return { kind: why.kind, what, text, ...(there ? { there } : {}) };
}
// Whether a session may have Full access, as its lead: the owner's own, with a mode.
export const mayHaveFull = task => Boolean(task) && !isPeerRun(task.origin) && MODES.includes(task.permissions);
// Whether the saved bot of that name works (works: true, as @lead): a bot that only answers or
// reviews does not, and a bot's scheduled turns are its own.
const savedWorks = name => { try { return getBot(name)?.works === true; } catch { return false; } };
// The last turn that did a session's work: its model's (lead), or that of a bot that works
// (works(name)), as @lead does every turn of a session written to it (lib/bots.mjs sessionWorker).
export const workRun = (task, works = savedWorks) => task?.runs?.findLast(run => run.role === 'lead' || Boolean(botOfKey(run.role)) && works(botOfKey(run.role)));
// The Blocked lines of a session's last working turn (workRun), at most three, each saying what was
// refused, why and the one thing to do. Shown while the session waits for the owner, and
// for a never-list command whatever the turn went on to do. An approval nobody answered is
// said too once the turn has ended, whatever it ended on: it never passes in silence.
// all: every line, not only the three shown. full: whether the session may have Full access.
export function blockedRows(task, lastLead = workRun(task), { all = false, full = mayHaveFull(task) } = {}) {
  const waits = task.state === 'needs_input', ended = !['running', 'preparing'].includes(task.state);
  const refused = Array.isArray(lastLead?.denials) ? lastLead.denials.filter(denial => ended || denial?.never) : [];
  if (!refused.length) return [];
  // The approvals of that turn: stamped with the id it was launched with, which a resumed
  // turn reports as another. A turn kept before that id was recorded finds them by the
  // tool call each one asked about.
  const ids = [lastLead.session, lastLead.launch].filter(Boolean), uses = refused.map(denial => denial?.tool_use_id).filter(use => typeof use === 'string' && use);
  const asked = (task.approvals ?? []).filter(row => row.role === (lastLead.role ?? 'lead') && (ids.includes(row.session) || (!lastLead.launch && typeof row.id === 'string' && uses.some(use => row.id.endsWith(`-${use}`)))));
  const rows = [...new Map(refused.map(denial => [denial, blockedLine(denial, lastLead, asked, { cwd: task.worktree ?? null, full, current: task.permissions ?? null, waits })]).filter(([denial, row]) => waits || denial?.never || row.kind === 'timeout').map(([, row]) => [row.text, row])).values()];
  return all ? rows : rows.slice(0, 3);
}
