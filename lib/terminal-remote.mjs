import { remoteRow } from './board.mjs';
import { taskCard } from './terminal-plan.mjs';
import { remote, tagged, wrapText } from './terminal-visuals.mjs';
import { fileCount } from './peer/files.mjs';
// An entry from an older ELU there has no model or effort, and its header reads as before.
import { entryTag as tagOf } from './models.mjs';
import { AUTO_LINE, HELPER_AUTO_MAX, sentEntries } from './remote-helper.mjs';

// The app's side of sessions on your other computers (lib/peer/remote.mjs): the rows they
// add to Sessions, what shows beside the list when one is under the cursor, the keys that
// act on one, and /mine. Everything it reads comes from the peer facade's files; everything
// it does goes to the daemon as a command. deps are the app's own helpers, passed in so this
// file draws as the rest of the app does.
export const MINE_USAGE = '/mine [@name | remove @name | auto on | auto off]';
const plainName = value => remote(value, 40).replace(/[\s@]+/g, '');
const WEEK = 7 * 86400000;
// restMs: how long the cursor rests on a session not followed here yet before it is watched there.
export function remoteSessions({ facade, peerRead, peerCommand, chatMessage, ink, colour, toneOfBot = () => 'violet', restMs = 300 }) {
  const list = (name, ...args) => { try { const value = facade?.[name]?.(...args); return Array.isArray(value) ? value : []; } catch { return []; } };
  // Every teammate's machine, with the name it goes by here: its box name, else its owner's name.
  const machines = () => {
    const status = peerRead('peerStatus'), seen = new Map();
    for (const member of (status?.teams ?? []).flatMap(team => team?.members ?? [])) if (member?.key && member.key !== status.key && !seen.has(member.key)) seen.set(member.key, { key: member.key, name: plainName(member.box) || plainName(member.name) || member.key.slice(0, 8), owner: plainName(member.name), box: plainName(member.box), online: Boolean(member.online) });
    return seen;
  };
  const marks = () => new Map(list('mineRows').map(row => [row.key, row]));
  // What this machine goes by on the others, so /mine there can find it: its box name, else its owner's name.
  const self = () => { const status = peerRead('peerStatus'); return plainName(status?.box) || plainName(status?.name) || 'NAME'; };
  // Teammates' machines that are not both mine yet: the ones /invite offers to make mine without a code.
  const unmarked = () => { const marked = marks(); return [...machines().values()].filter(row => !(marked.get(row.key)?.mine && marked.get(row.key)?.theirs)); };
  const nameOf = key => machines().get(key)?.name ?? key.slice(0, 8);
  // The machine a leading @word names, by its box name or its owner's name, any case.
  const find = (word, rows = [...machines().values()]) => {
    if (!/^@[^\s@]+$/.test(word ?? '')) return null;
    const wanted = word.slice(1).toLowerCase(), by = field => rows.filter(row => row[field] && row[field].toLowerCase() === wanted);
    const box = by('box'), owner = by('owner');
    return box.length === 1 ? box[0] : owner.length === 1 ? owner[0] : null;
  };
  // A machine this one marked as its own: a leading @name for it starts the session there.
  // One the other side has not marked back yet, or that runs an older build, is still found
  // here, so the owner hears why it cannot start, and the message never goes as a question.
  const named = word => { const marked = marks(); return find(word, [...machines().values()].filter(row => marked.get(row.key)?.mine)); };
  // Read from their files at most every 500 ms: the list is drawn far more often. views: the
  // sessions this machine follows (started from here, or opened here); lists: every session
  // on each computer of mine, as it last listed them.
  let read = { at: 0, views: [], lists: new Map() };
  const fresh = now => { if (now - read.at > 500 || now < read.at) read = { at: now, views: list('remoteSessions'), lists: new Map(list('remoteMachines').map(row => [row.key, row])) }; return read; };
  // Computers both machines marked as mine, with the name they go by here and whether they are online.
  const ours = () => { const marked = marks(); if (![...marked.values()].some(row => row.mine && row.theirs)) return []; const all = machines(); return [...marked.values()].filter(row => row.mine && row.theirs).map(row => all.get(row.key) ?? { key: row.key, name: row.key.slice(0, 8), online: false }); };
  // The repository of a project here, read again every minute: Sessions shows the sessions of my
  // computers' projects of the same repository.
  const repos = new Map();
  const repoOf = (root, now = Date.now()) => {
    if (!root) return null;
    const known = repos.get(root); if (known && now - known.at < 60000) return known.id;
    let id = null; try { id = facade?.projectRepoId?.(root) ?? null; } catch { id = null; }
    repos.set(root, { id, at: now }); return id;
  };
  // Every repository the open project holds, read again every minute: its own, and those its
  // Kanban has boards for, as the daemon last found them (the clones its folder holds and the
  // ones its recent sessions work in); the app asks git nothing for it. A session of my other
  // computer working in one of them shows under that computer's heading.
  const held = new Map();
  const holds = (root, now = Date.now()) => {
    if (!root) return new Set();
    const known = held.get(root); if (known && now - known.at < 60000 && now >= known.at) return known.ids;
    const ids = new Set([repoOf(root, now), ...list('projectRepoIds', root)].filter(id => typeof id === 'string' && id));
    if (held.size > 50) held.clear();
    held.set(root, { at: now, ids }); return ids;
  };
  // Whether Sessions shows a listed session under its computer's heading, with the open project's
  // repository (repo) and every one it holds (here): by the repository the session works in,
  // else, from a build that names none, by its project's.
  const shows = (item, project, repo, here) => item.repoId ? here.has(item.repoId) : Boolean(repo) && project?.repoId === repo;
  // A project of another computer opened from Projects: its sessions show under their own heading.
  let opened = null;
  // Sessions under the cursor that were asked to be watched: when, and why one could not be.
  // One that failed is asked again after a while, never on every draw; one that was busy, sooner.
  const asked = new Map(), RETRY_MS = 30000, BUSY_MS = 5000;
  let resting = { id: null, at: 0 };
  // One session of a computer of mine as a row. view: what this machine follows of it, live;
  // item: how that computer last listed it. The row's key is the session's id either way. Its
  // time and place in the list are the listing's: a watch stamps its first events with the
  // moment it was made, which is not when the session last did anything.
  function sessionRow(machine, item, view, project, now) {
    const v = view ? item?.at ? { ...view, lastAt: item.at } : view : { id: item.id, machine: machine.key, createdAt: item.createdAt, lastAt: item.at, state: item.state, title: item.title, question: item.question, error: item.error, plan: item.plan, approvals: item.approvals, steps: [], entries: [] };
    const row = remoteRow(v, machine.name, now);
    return { ...row, project: project?.name ?? v.project ?? '-', listed: Boolean(item), ref: item?.ref ?? view?.ref ?? null, watched: Boolean(view), online: machine.online === true, by: item?.by ?? (view && !view.ref ? 'here' : null), who: item?.who ?? null, grouped: true, last: Date.parse(v.lastAt ?? v.createdAt ?? 0) || 0 };
  }
  // Each session of a computer of mine, once: as it listed it, with what this machine follows
  // of it (the same session by its id from here, by the id both machines give it, or by its
  // place there). A view that lost its place there, such as a watch its events made again
  // here, takes the listed place, so it is the same session everywhere. Then the ones started
  // from here that it has not listed (yet, or on a build that cannot list), and, for a computer
  // with no list, the ones watched here.
  function each(machine, kept, views) {
    const own = views.filter(view => view.machine === machine.key), byId = new Map(own.map(view => [view.id, view])), byRef = new Map(own.filter(view => view.ref).map(view => [view.ref, view]));
    const out = [], used = new Set();
    for (const item of kept?.sessions ?? []) {
      const found = (item.remoteId && byId.get(item.remoteId)) || byId.get(item.id) || byRef.get(item.ref) || null;
      const view = found && !found.ref && (found.id === item.id || found.handoff && found.id === item.remoteId) ? { ...found, ref: item.ref } : found;
      if (view) used.add(view.id);
      out.push({ item, view });
    }
    for (const view of own) if (!used.has(view.id) && (!view.ref || !kept?.listedAt)) out.push({ item: null, view });
    return out;
  }
  // The sessions of each computer of mine, as Sessions shows them: those working in a repository
  // the open project (root) holds, those started from here, and those of a project opened from
  // Projects. A session its computer names no repository for (an older build, or one in no
  // repository) goes by its project's: the same as the open project's. Finished ones stay a week, as here.
  function groups(now = Date.now(), root = null) {
    const { views, lists } = fresh(now), mine = ours(), out = [];
    if (!mine.length) return out;
    const repo = repoOf(root, now), here = holds(root, now);
    for (const machine of mine) {
      const kept = lists.get(machine.key), projects = new Map((kept?.projects ?? []).map(row => [row.id, row]));
      const main = [], other = [];
      let away = 0;
      for (const { item, view } of each(machine, kept, views)) {
        if (!item) { if (!view.ref) main.push(sessionRow(machine, null, view, null, now)); continue; }
        const project = projects.get(item.project), same = shows(item, project, repo, here), open = opened?.key === machine.key && opened.project === item.project;
        if (!same && !(view && !view.ref)) away++;
        if (!same && !open && !(view && !view.ref)) continue;
        (same || (view && !view.ref) ? main : other).push(sessionRow(machine, item, view, project, now));
      }
      const recent = row => row.group !== 3 || now - row.last < WEEK, newest = (a, b) => b.last - a.last;
      out.push({ machine, older: kept?.older === true, listed: Boolean(kept?.listedAt), away, rows: main.filter(recent).sort(newest), opened: open(machine, projects), other: other.filter(recent).sort(newest) });
    }
    return out;
  }
  const open = (machine, projects) => opened?.key === machine.key ? projects.get(opened.project) ?? null : null;
  const keyed = row => ({ ...row, key: `remote:${row.remote.machine}\0remote\0${row.id}` });
  // Board lines after this machine's own: a heading per computer of mine, online or offline,
  // its sessions newest first, then those of the project opened from Projects.
  function sections(now = Date.now(), root = null) {
    const lines = [];
    for (const group of groups(now, root)) {
      const { machine } = group;
      if (!group.rows.length && !group.older && !group.listed && !group.opened) continue;
      lines.push({ spacer: true }, { header: `On ${machine.name} · ${machine.online ? 'online' : 'offline'}`, tone: machine.online ? 'violet' : 'muted', count: group.rows.length });
      if (group.older) lines.push({ note: `Update ELU on ${machine.name} to see its sessions here.` });
      else if (!group.rows.length) lines.push({ note: group.away ? `No sessions of this project. Projects lists its others.` : 'No sessions yet.' });
      for (const row of group.rows) lines.push({ row: keyed(row) });
      if (group.opened) {
        lines.push({ spacer: true }, { header: `${group.opened.name} on ${machine.name}`, tone: 'violet', count: group.other.length });
        if (!group.other.length) lines.push({ note: 'No sessions yet.' });
        for (const row of group.other) lines.push({ row: keyed(row) });
      }
    }
    return lines;
  }
  // What waits for me on a computer of mine, in any of its projects (its home folder too): an
  // allow or deny, a Task to approve, a question. Each is a row of its own under Needs you
  // here, marked with the computer, beside the session's row under its computer when
  // Sessions lists it there.
  function rows(now = Date.now()) {
    const { views, lists } = fresh(now), out = [];
    for (const machine of ours()) {
      const kept = lists.get(machine.key), projects = new Map((kept?.projects ?? []).map(row => [row.id, row]));
      for (const { item, view } of each(machine, kept, views)) {
        const row = sessionRow(machine, item, view, item ? projects.get(item.project) : null, now);
        if (row.group === 0) out.push({ ...row, grouped: false, keyId: `${row.id}/wants` });
      }
    }
    return out;
  }
  // The projects of my computers with sessions Sessions does not show here: "<project> on <name>"
  // in Projects, with how many (sessions). A session of my other computer that works in a
  // repository this project holds is part of this project, whatever folder its project is
  // there (a folder of clones, the home folder): it shows under that computer's heading, as one
  // started from here does, so a project there whose sessions all show here is not listed again.
  // Nor is one with no sessions yet: opened, it would show nothing, and new sessions there start
  // from here with @name. One working in no repository, or one this project does not hold, is
  // reached from here.
  function projects(now = Date.now(), root = null) {
    const { views, lists } = fresh(now), mine = ours(), out = [];
    if (!mine.length) return out;
    const repo = repoOf(root, now), here = holds(root, now);
    for (const machine of mine) {
      const kept = lists.get(machine.key); if (!kept || kept.older) continue;
      const listed = each(machine, kept, views).filter(pair => pair.item);
      for (const project of kept.projects ?? []) {
        const away = listed.filter(({ item, view }) => item.project === project.id && !shows(item, project, repo, here) && !(view && !view.ref)).map(pair => pair.item);
        if (!away.length) continue;
        out.push({ remote: true, key: machine.key, id: project.id, root: `remote:${machine.key}:${project.id}`, name: `${project.name} on ${machine.name}`, project: project.name, machine: machine.name, online: machine.online, sessions: away.length, last: away[0]?.at ?? null });
      }
    }
    return out;
  }
  // The key of one session of a computer of mine (key) as Sessions lists it with the open
  // project (root), or null when it is not there: by its id when it was started from here
  // (remote), else by its place on that computer (ref).
  function sessionKey(key, { remote = null, ref = null } = {}, root = null) {
    for (const group of groups(Date.now(), root)) if (group.machine.key === key) for (const row of [...group.rows, ...(group.opened ? group.other : [])]) if ((remote && row.id === remote) || (ref && row.ref === ref)) return keyed(row).key;
    return null;
  }
  // Opens a project of a computer of mine in Sessions; the key of its newest session, if any.
  function openProject(key, project) {
    opened = { key, project };
    const group = groups(Date.now()).find(row => row.machine.key === key);
    const first = group?.other[0] ?? group?.rows.find(row => row.listed && (fresh(Date.now()).lists.get(key)?.sessions ?? []).some(item => item.ref === row.ref && item.project === project));
    return first ? keyed(first).key : null;
  }
  const note = (text, tone, width) => wrapText(text, width).map(row => ink(row, tone, colour)).join('\n');
  // What shows beside the list for a session on another computer: its chat as a local
  // session shows it, the steps it is taking while it works, its changes, its Task and what
  // it waits for. Drawn as parts, a blank line between two, each with a key that names what
  // it shows, so the pane can keep the owner on the part he reads while others come and go.
  // helper: your agent here for it (lib/remote-helper.mjs), whose chat shows in the same
  // pane, in time order: { model, entries, working, stopped, sends }.
  function parts(row, width, helper = null) {
    const v = row.remote, where = `on @${row.machine}`, lines = [], seen = new Map();
    const add = (key, text) => { const n = seen.get(key) ?? 0; seen.set(key, n + 1); lines.push({ key: `${key}\0${n}`, text }); };
    const hereKey = entry => `here\0${entry.at ?? ''}\0${entry.role ?? ''}\0${entry.text ?? ''}`;
    // A session not followed here yet is watched there once the cursor rests on it; until its
    // events arrive, what its computer listed shows. An offline computer is not asked.
    if (row.listed && !row.watched && row.ref) {
      const now = Date.now(), tried = asked.get(row.id);
      if (resting.id !== row.id) resting = { id: row.id, at: now };
      const due = !tried || (!tried.pending && now - tried.at >= (tried.busy ? BUSY_MS : RETRY_MS));
      if (row.online && due && now - resting.at >= restMs) {
        asked.set(row.id, { pending: true, at: now });
        peerCommand({ type: 'remoteWatch', to: v.machine, ref: row.ref, cursor: true }).then(() => { asked.delete(row.id); read.at = 0; },
          error => asked.set(row.id, { error: error.message, busy: /is busy|Too many requests/.test(error.message), at: Date.now() }));
      }
      const failed = asked.get(row.id), said = !row.online ? `@${row.machine} is offline. What it listed last is shown.` : failed?.error && !failed.busy ? failed.error : `Opening it on @${row.machine}…`;
      add('listed', chatMessage({ title: v.title || 'Session', text: [v.question, v.error].filter(Boolean).join('\n\n') || `${row.label}`, tone: 'blue', shaded: true }, width, colour));
      add('opening', note(said, failed?.error && !failed.busy && row.online ? 'orange' : 'muted', width));
      for (const entry of [...helper?.entries ?? []].sort((a, b) => Date.parse(a.at ?? 0) - Date.parse(b.at ?? 0))) add(hereKey(entry), hereMessage(entry, helper, width));
      return lines;
    }
    const entries = v.entries?.length ? v.entries : v.text ? [{ role: 'You', at: v.createdAt, text: v.text }] : [];
    // The model, the bots and the shell of this chat are those of the other computer, and
    // their titles say so (Opus 5.5 on @devbox), so they are never taken for this computer's.
    // What was sent there from here reads You → @devbox, or the agent here's when it sent it.
    const fromHelper = sentEntries(v, helper?.sends ?? []);
    for (const entry of [...entries, ...(helper?.entries ?? []).map(row => ({ ...row, here: true }))].sort((a, b) => Date.parse(a.at ?? 0) - Date.parse(b.at ?? 0))) {
      const key = entry.here ? hereKey(entry) : `entry\0${entry.at ?? ''}\0${entry.role ?? ''}\0${entry.text ?? ''}`;
      if (entry.here) add(key, hereMessage(entry, helper, width));
      else if (entry.role === 'You' && !entry.shell && !entry.bot) add(key, chatMessage({ title: `${fromHelper.has(entry) ? `${helper.model} here` : 'You'} → @${row.machine}`, at: entry.at, text: entry.text, tone: 'blue', shaded: true }, width, colour));
      else if (entry.shell) add(key, chatMessage({ title: `${entry.role} ${where}`, at: entry.at, text: entry.text, tone: 'green', raw: true }, width, colour));
      else if (entry.bot) add(key, chatMessage({ ...tagged(entry.role, tagOf(entry), ` ${where}`), at: entry.at, text: entry.text, tone: entry.failed ? 'red' : entry.quiet ? 'muted' : toneOfBot(entry.bot) }, width, colour));
      else add(key, chatMessage({ ...tagged(entry.role, tagOf(entry), entry.lead ? ` ${where}` : ''), at: entry.at, text: entry.text, tone: entry.lead ? 'orange' : 'blue', shaded: !entry.lead }, width, colour));
    }
    if (v.state === 'needs_input' && v.question) add('question', chatMessage({ title: 'Waiting for you', text: [v.question, (v.choices ?? []).map((choice, index) => `${index + 1}. ${choice}`).join('\n')].filter(Boolean).join('\n\n'), tone: 'orange' }, width, colour) + (byTeammate(row) ? '' : '\n' + note(`Answer it there: @${row.machine} ${v.choices?.length ? '1' : 'and your answer'}`, 'muted', width)));
    if (v.diff?.patch) add('changes', chatMessage({ title: `Changes · ${v.diff.summary}`, text: v.diff.patch.split('\n').slice(0, 120).join('\n') + (v.diff.patch.split('\n').length > 120 ? '\n…' : ''), tone: 'green', raw: true }, width, colour));
    if (['starting', 'preparing', 'running'].includes(v.state) && !v.approvals?.length) {
      add('working', ink(v.state === 'starting' ? `Starting ${where}` : `Working ${where}`, 'orange', colour, true));
      for (const step of (v.steps ?? []).slice(-4)) add(`step\0${step.at ?? ''}\0${step.text ?? ''}`, ink(remote(step.text, Math.max(10, width - 2)), 'muted', colour));
    }
    if (v.plan && !(v.plan.state === 'rejected')) add('task', taskCard(v.plan, { width, colour, approval: Boolean(v.approvals?.length) }));
    for (const item of v.approvals ?? []) add(`approval\0${item.id}`, [ink(`Waiting for your approval ${where}`, 'orange', colour, true), ink(`${!item.role || item.role === 'lead' ? 'The model' : item.role.replace(/^bot:/, '@')} wants to:`, 'text', colour), note(item.summary, 'text', width), ink(`Esc, then y allow · n deny${item.always ? ' · a always' : ''}`, 'muted', colour)].join('\n'));
    if (v.error) add('error', note(v.error, 'orange', width));
    if (v.behind) add('behind', note(`Catching up with @${row.machine}…`, 'muted', width));
    // Its agent here waits for the owner's approval, which is answered on its own row.
    for (const item of helper?.approvals ?? []) add(`here-approval\0${item.id ?? item.summary ?? ''}`, [ink('Waiting for your approval here', 'orange', colour, true), ink(`${helper.model} here wants to:`, 'text', colour), note(item.summary, 'text', width), note(`Answer it on the row of "${helper.title}" in Sessions, under Needs you.`, 'muted', width)].join('\n'));
    if (helper?.working && !helper.approvals?.length) add('here-working', ink(`${helper.model} is working here`, 'orange', colour, true));
    if (helper?.stopped && !helper.working) add('here-stopped', note(`The two agents stopped after ${HELPER_AUTO_MAX} turns by themselves. Write to your agent here to go on.`, 'muted', width));
    const by = row.by === 'teammate' && row.who ? ` Started by @${row.who}.` : row.by === 'schedule' ? ' Started by a schedule.' : row.by === 'bot' && row.who ? ` @${row.who}'s chat.` : '';
    add('runs', note(`Runs ${where}${v.project ? ` in ${remote(v.project, 40)}` : ''}.${by} ${byTeammate(row) ? 'Type below to continue it there.' : `Type below to write to your agent here; start with @${row.machine} to write to the session there.`}`, 'muted', width));
    return lines;
  }
  const view = (row, width, helper = null) => parts(row, width, helper).map(part => part.text).join('\n\n');
  // One entry of your agent here in that pane: its model's reply, your message to it, a turn
  // it took by itself after the session there answered, or your message still waiting.
  function hereMessage(entry, helper, width) {
    const auto = !entry.lead && !entry.bot && !entry.shell && AUTO_LINE.exec(entry.text ?? '');
    if (auto) return chatMessage({ title: `Automatic turn ${auto[1]} of ${auto[2]}`, at: entry.at, text: `@${String(entry.text).match(/^@(\S+) answered/)?.[1] ?? 'it'} answered. ${helper.model} here goes on by itself.`, tone: 'muted' }, width, colour);
    if (entry.lead) return chatMessage({ ...tagged(entry.role, tagOf(entry), ' here'), at: entry.at, text: entry.text, tone: 'orange' }, width, colour);
    if (entry.shell || entry.bot) return chatMessage({ ...tagged(entry.role, tagOf(entry), ' here'), at: entry.at, text: entry.text, tone: entry.shell ? 'green' : entry.failed ? 'red' : entry.quiet ? 'muted' : toneOfBot(entry.bot), ...(entry.shell ? { raw: true } : {}) }, width, colour);
    return chatMessage({ title: entry.waiting ? 'You (waiting)' : entry.role, at: entry.at, text: entry.text, tone: 'blue', shaded: true }, width, colour);
  }
  // The names a leading @word may call the computer of a session there: as its row shows it,
  // its box name, or its owner's name there when that is not this computer's own.
  function callsIt(row, word) {
    if (!/^@[^\s@]+$/.test(word ?? '')) return false;
    const wanted = word.slice(1).toLowerCase(), machine = machines().get(row.remote.machine), me = plainName(peerRead('peerStatus')?.name).toLowerCase();
    return [row.machine, machine?.name, machine?.box, machine?.owner && machine.owner.toLowerCase() !== me ? machine.owner : null].some(name => name && name.toLowerCase() === wanted);
  }
  // A teammate's session on that computer, such as a handoff accepted there: no agent here
  // helps it, since nothing is sent to it from here (lib/peer/session-tools.mjs), so every
  // message goes to it, as before. One a message from a computer of mine started there is
  // mine, not a teammate's (lib/peer/remote.mjs), and is helped as any of mine.
  const byTeammate = row => row.by === 'teammate';
  // Where a message over a session on another computer goes: to your agent here, or, when it
  // starts with that computer's @name, to the session there, without the @name.
  function route(row, text) {
    const value = String(text ?? '').trimStart(), first = value.split(/\s+/)[0], named = callsIt(row, first);
    return named || byTeammate(row) ? { to: 'there', text: (named ? value.slice(first.length) : value).trim() } : { to: 'here', text: value.trim() };
  }
  // The message box, while a session on another computer is under the cursor: the longest
  // that fits in max. typed: what is in the box, which may already name that computer.
  const label = (row, max = Infinity, typed = '') => {
    const forms = byTeammate(row) ? [` Message ${row.remote.title ? 'this session' : 'it'} on @${row.machine} `]
      : route(row, typed).to === 'there' ? [` Message the session on @${row.machine} `, ` Message @${row.machine} `]
      : [` Message your agent here · @${row.machine} writes to the session there `, ` Message your agent here · @${row.machine} writes there `, ' Message your agent here '];
    return forms.find(form => form.length <= max) ?? forms.at(-1);
  };
  async function start(machine, text, settings) {
    const result = await peerCommand({ type: 'remoteStart', to: machine.key, text, permissions: settings.permissions, place: settings.place, model: settings.model ?? null, bots: settings.bots ?? [] });
    // The list reads its rows again at once, so the new one is there for the cursor.
    read.at = 0;
    return { id: result.id, key: `remote:${machine.key}\0remote\0${result.id}`, line: `Started on @${machine.name}${result.project ? ` in ${remote(result.project, 40)}` : ''}. It shows here as it works.` };
  }
  // A session not followed here yet is named by its computer and its place there: the daemon watches it first.
  const at = row => row.ref && !row.watched ? { to: row.remote.machine, ref: row.ref } : {};
  // A message that names files or folders on this computer offers to send them with it: one
  // line, y sends them, n sends the text alone (confirm answers it). Over a limit, the line says
  // so and y sends the text alone. sending(line): what the status line says while they go.
  // model: the text starts with a model's name (/model NAME message). It goes as typed: that
  // computer reads the name among its own models, runs the session on it from this message
  // on, and answers with the name it shows that model by, which the status line says.
  async function send(row, text, { confirm = null, sending = () => {}, model = false } = {}) {
    if (model) { const took = await peerCommand({ type: 'remoteSend', id: row.id, ...at(row), text, model: true }), named = took?.model ?? 'that model'; return took?.sent ? `Sent to the session on @${row.machine}, now on ${named}.` : `The session on @${row.machine} uses ${named} from your next message.`; }
    const offer = confirm ? facade?.offerFiles?.(text) ?? null : null;
    if (offer?.refused) { if (!await confirm(`${offer.refused} Send the text only?`)) throw new Error('Nothing was sent. The message is still here.'); }
    else if (offer && await confirm(offer.line)) return sendFiles(row, offer, text, sending);
    await peerCommand({ type: 'remoteSend', id: row.id, ...at(row), text });
    return `Sent to the session on @${row.machine}.`;
  }
  // /send PATH...: the files alone, after the same line.
  async function sendPaths(row, paths, { confirm, sending = () => {} }) {
    const offer = facade?.offerPaths?.(paths);
    if (!offer) throw new Error('Files cannot be sent from this computer.');
    if (!await confirm(offer.line)) return 'Nothing was sent.';
    return sendFiles(row, offer, '', sending);
  }
  // The daemon waits for each piece to be taken there: a minute, and a second for every 300 KB.
  async function sendFiles(row, offer, text, sending) {
    const files = facade.stageFiles(offer);
    sending(`Sending ${fileCount(files.count)} to @${row.machine}…`);
    const result = await peerCommand({ type: 'remoteFiles', id: row.id, ...at(row), text, files }, { timeoutMs: 60000 + Math.ceil(files.bytes / 300) });
    read.at = 0;
    return `Sent ${fileCount(Number.isSafeInteger(result?.files) ? result.files : files.count)} to the session on @${row.machine}.`;
  }
  // y, n, s and c on a session on another computer. Whoever answers first, here or there, wins.
  // always: a, once the owner chose where (scope 'project' or 'all'). The rule is kept on the
  // computer the session runs on, since that is where its relay reads the rules.
  async function action(row, action, scope = null) {
    if (row.approval && action === 'always') {
      if (!row.approval.always) throw new Error('This one is asked each time. y allows it once, n denies it.');
      const { answered, kept } = await peerCommand({ type: 'remoteAnswer', id: row.id, ...at(row), approval: row.approval.id, decision: 'allow', always: scope === 'all' ? 'all' : 'project' });
      read.at = 0;
      if (!answered && !kept) return 'That approval was already answered.';
      return `${answered ? 'Allowed. ' : ''}From now on, without asking on @${row.machine}: ${kept ?? row.approval.always} (${scope === 'all' ? 'all your projects there' : 'this project'}).`;
    }
    if (row.approval && ['accept', 'decline'].includes(action)) {
      const { answered } = await peerCommand({ type: 'remoteAnswer', id: row.id, ...at(row), approval: row.approval.id, decision: action === 'accept' ? 'allow' : 'deny' });
      read.at = 0;
      return answered ? action === 'accept' ? 'Allowed.' : 'Denied.' : 'That approval was already answered.';
    }
    if (row.label === 'TASK' && ['accept', 'decline'].includes(action)) {
      const { answered } = await peerCommand({ type: 'remoteTask', id: row.id, ...at(row), decision: action === 'accept' ? 'approve' : 'reject' });
      return answered ? action === 'accept' ? `Task approved. It starts on @${row.machine}.` : 'Task rejected. Nothing was changed.' : 'That Task was already answered.';
    }
    if (action === 'stop') { await peerCommand({ type: 'remoteStop', id: row.id, ...at(row) }); return `Stopping it on @${row.machine}. Changes and chat history are kept there.`; }
    if (action === 'close' && !row.listed) { await peerCommand({ type: 'remoteForget', id: row.id }); read.at = 0; return `Removed from this list. It stays on @${row.machine}.`; }
    return null;
  }
  // /mine: which of your teammates' machines are yours. Both machines mark each other, by
  // hand or, when both are signed in to the same GitHub account, by themselves.
  async function mine(args) {
    const all = machines(), marked = marks();
    if (!args.length) {
      const rows = [...marked.values()].filter(row => row.mine || row.theirs);
      // While pairing by GitHub cannot work here, how to pair is said once, at the end.
      let hint = null; try { hint = facade?.pairingHint?.() ?? null; } catch { hint = null; }
      if (!rows.length) return hint ? `No other computer is yours yet. ${hint}` : `No other computer is yours yet. Two computers on one team signed in to GitHub with gh as the same account pair by themselves; or run /mine @name here and on that computer.`;
      const said = rows.map(row => { const name = `@${all.get(row.key)?.name ?? row.key.slice(0, 8)}`; return row.mine && row.theirs ? `${name} is yours${row.auto === 'github' && row.login ? ` (GitHub ${row.login})` : ''}` : row.mine ? `${name}: waiting for it to mark this machine too` : `${name} marks this machine as its own; /mine ${name} agrees`; }).join(' · ');
      return hint ? `${said}. ${hint}` : said;
    }
    if (args[0] === 'auto') {
      if (args.length !== 2 || !['on', 'off'].includes(args[1])) throw new Error(`Use ${MINE_USAGE}.`);
      await peerCommand({ type: 'mineAuto', on: args[1] === 'on' });
      return args[1] === 'on' ? 'Computers signed in to the same GitHub account pair by themselves again.' : 'Computers no longer pair by GitHub account. The ones already yours stay yours; /mine remove @name ends one.';
    }
    const remove = args[0] === 'remove', word = remove ? args[1] : args[0];
    if (args.length !== (remove ? 2 : 1) || !word?.startsWith('@')) throw new Error(`Use ${MINE_USAGE}.`);
    const machine = find(word);
    if (!machine) throw new Error(`No teammate's computer is called ${word}.`);
    if (remove) { await peerCommand({ type: 'unmine', key: machine.key }); return `@${machine.name} is no longer yours. Neither computer can start sessions on the other now, and it does not pair again by GitHub until you type /mine @${machine.name}.`; }
    const { both, older } = await peerCommand({ type: 'mine', key: machine.key });
    return both ? `@${machine.name} is yours. Type @${machine.name} first in the new session box to start a session there.` : older ? `@${machine.name} needs to update ELU to run sessions from here.` : `Waiting for @${machine.name} to mark this machine too. On @${machine.name}, type /mine @${self()}.`;
  }
  // The line the app shows once when a computer of mine paired by GitHub, here or while the app
  // was closed in the last 10 minutes: the daemon notes pairedAt on its row (lib/peer/mine.mjs).
  const appStart = Date.now() - 600000, toldPairs = new Set();
  function paired() {
    const rows = list('mineRows').filter(row => row.auto === 'github' && row.mine && row.theirs && row.login && Date.parse(row.pairedAt ?? '') > appStart && !toldPairs.has(`${row.key}:${row.pairedAt}`));
    for (const row of rows) toldPairs.add(`${row.key}:${row.pairedAt}`);
    return rows.length ? rows.map(row => `@${nameOf(row.key)} is yours: both computers are signed in to GitHub as ${row.login}.`).join(' ') : null;
  }
  // The answer to "Is <name>'s computer yours too?" after joining with a code made for that: yes marks it here.
  async function agree(key, owner) {
    const { both } = await peerCommand({ type: 'mine', key }), who = machines().get(key)?.name || plainName(owner) || key.slice(0, 8);
    return both ? `@${who} is yours. Type @${who} first in the new session box to start a session there.` : `Marked as yours. Type @${who} first in the new session box to start a session there.`;
  }
  // What my computers that are online now say their agents spent, for the Usage tab: one entry
  // each, { machine, top }, top null for one on a build that does not send it (or cannot list).
  function agents(now = Date.now()) {
    const { lists } = fresh(now);
    return ours().filter(machine => machine.online).map(machine => { const kept = lists.get(machine.key); return { machine, top: kept && !kept.older && kept.topAgents && typeof kept.topAgents === 'object' ? kept.topAgents : null, listed: Boolean(kept?.listedAt) || kept?.older === true }; });
  }
  // Opens a session of a computer of mine in Sessions, by its project there: the key of its row.
  // One this machine follows is listed once, by the id it has here, so it is found by its place
  // there (ref) first, then by its listed id.
  function openSession(key, project, id, ref = null, root = null) {
    opened = { key, project };
    return (ref ? sessionKey(key, { ref }, root) : null) ?? `remote:${key}\0remote\0${id}`;
  }
  return { rows, sections, sessionKey, projects, openProject, openSession, agents, named, view, parts, label, route, start, send, sendPaths, action, mine, agree, unmarked, self, paired };
}
