import { refuse } from '../util.mjs';
import { awaitCommand, peerStatus, remoteMachines, remoteSessions, sendPeerCommand } from './index.mjs';
import { mineRows, pairedMine } from './mine.mjs';
import { collectFiles, fileCount, namedPaths, sizeText, stageFiles } from './files.mjs';
import { newestEntry, noteSend } from '../remote-helper.mjs';

// The two tools a session of the owner's gets for his other computers (lib/approval-server.mjs):
// what their sessions are, and files to one of them. Only computers that are mine on both
// sides are listed or sent to, as everywhere else (lib/peer/mine.mjs).
const plain = value => String(value ?? '').replace(/[\s@]+/g, '').slice(0, 40);
function computers() {
  let status = null; try { status = peerStatus(); } catch { status = null; }
  const members = new Map((status?.teams ?? []).flatMap(team => team.members ?? []).map(member => [member.key, member]));
  return mineRows().filter(row => row.mine && row.theirs && pairedMine(row.key)).map(row => {
    const member = members.get(row.key);
    return { key: row.key, name: plain(member?.box) || plain(member?.name) || row.key.slice(0, 8), online: member?.online === true };
  });
}
const waitsOn = row => row.question ? `question: ${row.question}` : row.approvals?.length ? `approval: ${row.approvals.map(item => item.summary).join('; ')}` : row.plan?.state === 'proposed' ? `Task to approve: ${row.plan.title}` : null;
// Every session listed by each computer of mine, and the ones started from here it has not listed
// yet. A teammate's session there (by: teammate, such as a handoff accepted there) is left out:
// files go only to the owner's own sessions, and that computer refuses them too.
function sessionsOf(machine) {
  const kept = remoteMachines().find(row => row.key === machine.key), projects = new Map((kept?.projects ?? []).map(row => [row.id, row.name]));
  const views = remoteSessions().filter(row => row.machine === machine.key), listed = new Set();
  for (const row of kept?.sessions ?? []) { listed.add(row.id); if (row.remoteId) listed.add(row.remoteId); }
  const out = (kept?.sessions ?? []).filter(row => row.by !== 'teammate').map(row => ({ session: row.id, title: row.title, state: row.state, project: projects.get(row.project) ?? null, waits: waitsOn(row), to: machine.key, ref: row.ref, own: row.remoteId ?? null }));
  for (const view of views) if (!listed.has(view.id)) out.push({ session: view.id, title: view.title, state: view.state, project: view.project ?? null, waits: waitsOn(view) });
  return out;
}
export function otherSessions() {
  const list = computers();
  if (!list.length) return 'No other computer of yours is paired with this one. On each computer, /mine @name marks the other.';
  return { computers: list.map(machine => ({ computer: `@${machine.name}`, online: machine.online, sessions: sessionsOf(machine).map(({ to, ref, own, ...row }) => row) })) };
}
// Files with a message to one session on a computer of mine. reads(file): why this session may
// not read that file, or null (lib/session-reads.mjs). Returns the line that says what went.
// The computer and title of a session a send names, for the owner's approval, or null.
// A session started from here is also named by the id it has here (own), as Sessions has it.
const named = (row, session) => row.session === session || row.own === session;
export function sendTarget(session) {
  if (typeof session !== 'string' || !session) return null;
  for (const machine of computers()) { const row = sessionsOf(machine).find(item => named(item, session)); if (row) return { computer: `@${machine.name}`, title: row.title ?? null }; }
  return null;
}
// from: the session here that sends ({ task, root }), kept for the helper of that session
// there (lib/remote-helper.mjs), so its answer gives the helper a turn. only: the one session a
// helper helps, the only one it sends to. paths may be none: the message goes alone, as a
// message typed there from here does, which every build there takes.
export async function sendToSession(input, { reads, from = null, only = null }) {
  const { session, paths = [], message = '' } = input ?? {};
  if (typeof session !== 'string' || !session) refuse('Name the session: an id from list_other_sessions.');
  if (!Array.isArray(paths) || paths.length > 100 || paths.some(item => typeof item !== 'string' || !(item.startsWith('/') || item.startsWith('~/')))) refuse('Name each path in full, starting with / or ~/.');
  if (typeof message !== 'string' || message.length > 16000) refuse('Write the message in up to 16000 characters.');
  if (!paths.length && !message.trim()) refuse('Send files, a message, or both.');
  // What this session may not read is refused first, whatever the session named.
  const collected = paths.length ? collectFiles(namedPaths(paths), { check: reads }) : null;
  let found = null;
  for (const machine of computers()) { const row = sessionsOf(machine).find(item => named(item, session)); if (row) { found = { machine, row }; break; } }
  if (only && !(session === only || found && named(found.row, only))) refuse(`This session helps session ${only} only, and sends to no other.`);
  if (!found) refuse('No session on your other computers has that id. list_other_sessions lists them.');
  if (!found.machine.online) refuse(`@${found.machine.name} is offline. Try again once it is on.`);
  if (peerStatus().running !== true) refuse("ELU Code's connection to your other computers is not running on this one.");
  // One started from here and named by its id here goes by that id while it is followed here.
  const views = remoteSessions(), byOwn = found.row.session !== session && views.some(view => view.id === session);
  const after = newestEntry(views.find(view => view.id === session || view.id === only));
  const at = found.row.ref && !byOwn ? { to: found.row.to, ref: found.row.ref } : {};
  const kept = () => { if (from) { try { noteSend(only ?? session, { ...from, after }); } catch { /* The send went; only the helper's next turn by itself is lost. */ } } };
  if (!collected) {
    await awaitCommand(sendPeerCommand({ type: 'remoteSend', id: session, ...at, text: message }).id);
    kept();
    return `Sent the message to the session on @${found.machine.name}.`;
  }
  const staged = stageFiles(collected);
  const { id } = sendPeerCommand({ type: 'remoteFiles', id: session, ...at, text: message, files: staged });
  const result = await awaitCommand(id, 60000 + Math.ceil(staged.bytes / 300));
  kept();
  return `Sent ${fileCount(result?.files ?? staged.count)} (${sizeText(result?.bytes ?? staged.bytes)}) to the session on @${found.machine.name}.`;
}
