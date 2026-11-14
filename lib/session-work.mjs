import fs from 'node:fs';
import path from 'node:path';
import { git, currentBranch } from './git.mjs';

// What a session itself changed. A session may move its folder while it works: it fetches,
// makes a branch from a newer main, commits there, merges, rebases, makes the next branch.
// Its folder against the commit it started from then also counts everything other people
// landed in between. So every count of a session's changes comes from this one rule:
//   A commit is the session's when it was made in the session's folder since the session
//   started. The folder's own record of where HEAD went (its reflog) tells a commit made
//   there from one that only arrived by a checkout, a reset, a pull or a fast-forward.
//   A branch's changes are its tip against the newest commit under it that is not the
//   session's: where the session branched from, or what it last merged in.
//   The branch that is checked out also counts what is not committed yet. In the owner's own
//   folder (place here) that leaves out a file last written before the session started,
//   which cannot be the session's work (olderThanSession).
// Where the record cannot say which commits are the session's, the answer says so (note),
// and counts only what it can stand behind.
const SHA = /^[0-9a-f]{40,64}$/, NONE = /^0+$/;
// Lines of the record that move HEAD and make no commit: a checkout, a reset, a clone, a
// fast-forward, and the first and the last step of a rebase.
const MOVED = /^(?:checkout|reset|clone|branch)\b|^[^:]*\((?:start|finish|abort)\):|^rebase finished|^rebase: checkout |^(?:merge|pull|cherry-pick)\b[^:]*: [Ff]ast-forward$/;
const NAMES = ['main', 'master', 'trunk', 'develop'];

// Where HEAD went in this folder, oldest first: [{ old, now, at, text }], at in seconds.
// whole: the record starts where the folder did. null when there is no record to read.
// since: in a folder the session shares with its owner (place here), only what HEAD did
// after the session started. That is every line after the last one, no newer than its
// start, that brought HEAD to the commit it started from (base): the record keeps whole
// seconds, and the owner may have committed in the very second the session started.
// Without such a line the time alone says.
function headLog(root, since = 0, base = null) {
  const rows = [], found = git(root, ['rev-parse', '--git-path', 'logs/HEAD'], { allowFailure: true });
  let text = null;
  if (found.status === 0) { try { text = fs.readFileSync(path.resolve(root, found.stdout.trim()), 'utf8'); } catch { /* Kept another way: Git is asked below. */ } }
  if (text !== null) {
    for (const line of text.split('\n')) {
      const match = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) .*? (\d+) [+-]\d{4}(?:\t(.*))?$/.exec(line);
      if (match) rows.push({ old: match[1], now: match[2], at: Number(match[3]), text: match[4] ?? '' });
    }
  } else {
    const run = git(root, ['log', '-g', '--format=%H%x09%gd%x09%gs', '--date=unix', 'HEAD', '--'], { allowFailure: true });
    if (run.status !== 0) return null;
    for (const line of run.stdout.split('\n').reverse()) {
      const [now, when, ...rest] = line.split('\t'), at = /\{(\d+)\}$/.exec(when ?? '');
      if (SHA.test(now) && at) rows.push({ old: rows.at(-1)?.now ?? '0', now, at: Number(at[1]), text: rest.join('\t') });
    }
  }
  const whole = rows.length > 0 && NONE.test(rows[0].old);
  if (!since) return { rows, whole };
  const second = Math.floor(since / 1000), start = rows.findLastIndex(row => row.at <= second && row.now === base);
  return { rows: start < 0 ? rows.filter(row => row.at >= second) : rows.slice(start + 1), whole };
}
// A rebase makes each commit of the old line anew on the new one. A commit it made from one
// that was not the session's (work the session's branch sat on, which the new line does not
// have) is not the session's either. The commits a rebase in this record made, each with the
// commits of the old line written by the same author at the same time under the same first
// line: Map of commit to those. One with none was not made from another (a reworded one, say).
const WROTE = '--format=%H%x09%an%x00%ae%x00%at%x00%s', lines = new Map();
function remade(root, rows) {
  const steps = []; let open = null;
  for (const row of rows) {
    if (/^[^:]*\(start\):/.test(row.text)) open = { tip: row.old, onto: row.now };
    else if (/^[^:]*\((?:finish|abort)\):/.test(row.text)) open = null;
    else if (open && SHA.test(row.now) && /^[^:]*\([a-z]+\):/.test(row.text)) steps.push({ sha: row.now, ...open });
  }
  const from = new Map();
  if (!steps.length) return from;
  const wrote = text => new Map(text.split('\n').flatMap(line => { const at = line.indexOf('\t'); return at > 0 ? [[line.slice(0, at), line.slice(at + 1)]] : []; }));
  const who = wrote(git(root, ['log', '--no-walk=unsorted', WROTE, '--stdin'], { input: `${[...new Set(steps.map(step => step.sha))].join('\n')}\n`, allowFailure: true }).stdout);
  for (const step of steps) {
    // The commits of a line do not change, so each old line is asked about once.
    const key = `${root}\0${step.onto}\0${step.tip}`;
    if (!lines.has(key)) { lines.set(key, wrote(git(root, ['log', WROTE, `${step.onto}..${step.tip}`, '--'], { allowFailure: true }).stdout)); if (lines.size > 200) lines.delete(lines.keys().next().value); }
    const mine = who.get(step.sha);
    from.set(step.sha, mine === undefined ? [] : [...lines.get(key)].flatMap(([sha, written]) => written === mine && sha !== step.sha ? [sha] : []));
  }
  return from;
}
// The commits made in this folder: each sits on the commit HEAD was at before it (a commit,
// a merge, a cherry-pick, a step of a rebase), or takes that commit's place on the same
// parents (an amend, a squash). parents: what each of them sits on.
function madeHere(root, rows, base) {
  const made = rows.filter(row => SHA.test(row.now) && !MOVED.test(row.text)), own = new Set(), parents = new Map();
  if (!made.length) return { own, parents };
  const from = remade(root, rows);
  const asked = [...new Set(made.flatMap(row => NONE.test(row.old) ? [row.now] : [row.now, row.old]))];
  const run = git(root, ['rev-list', '--no-walk=unsorted', '--parents', '--ignore-missing', '--stdin'], { input: `${asked.join('\n')}\n`, allowFailure: true });
  for (const line of run.stdout.split('\n')) { const [sha, ...above] = line.split(' '); if (SHA.test(sha)) parents.set(sha, above); }
  for (const row of made) {
    const above = parents.get(row.now), before = NONE.test(row.old) ? null : parents.get(row.old);
    if (!above || row.now === base) continue;
    // What a rebase made from commits that were not the session's is not the session's.
    const was = from.get(row.now);
    if (was?.length && !was.some(sha => own.has(sha))) continue;
    if (before === null ? !above.length : above.includes(row.old) || (before && row.now !== row.old && above.join() === before.join())) own.add(row.now);
  }
  return { own, parents };
}
// One branch of the session: its own commits (seen), and the commit they are compared with
// (ground; null is a branch with no history before the session). how: started (the commit
// the session started from), branched (a newer one it moved to), merged (one it merged in),
// merge (its own last merge), head (the last commit, where nothing more can be told),
// joined (two lines of other people's work that only this branch holds together: ground is
// then the tree Git makes of the two, merged, and joined names the two).
// sure is false where the session merged work that shares no newest commit with its own
// line and Git cannot put the lines together itself: then only what it changed since that
// merge is counted.
const joins = new Map();
function joinedTree(root, [one, two]) {
  const key = `${root}\0${one}\0${two}`;
  if (!joins.has(key)) {
    // Git 2.38 and later merges two commits without a folder; an older one, or a conflict, gives no tree.
    const run = git(root, ['merge-tree', '--write-tree', '--no-messages', one, two], { allowFailure: true }), tree = run.status === 0 ? run.stdout.split('\n')[0].trim() : '';
    joins.set(key, SHA.test(tree) ? tree : null); if (joins.size > 200) joins.delete(joins.keys().next().value);
  }
  return joins.get(key);
}
function under(root, tip, own, parents, base) {
  const seen = new Set(), edges = new Set(), stack = [tip];
  while (stack.length) {
    const at = stack.pop();
    if (seen.has(at)) continue;
    if (!own.has(at)) { edges.add(at); continue; }
    seen.add(at);
    const above = parents.get(at) ?? [];
    if (!above.length) edges.add(null);
    stack.push(...above);
  }
  let line = tip, merge = null;
  while (own.has(line)) { const above = parents.get(line) ?? []; if (above.length > 1) merge ??= line; line = above[0] ?? null; }
  const how = ground => ground === base ? 'started' : ground === line ? 'branched' : 'merged';
  if (edges.size === 1) { const [ground] = edges; return { seen, ground, how: how(ground), sure: true }; }
  if (!edges.has(null)) {
    const newest = git(root, ['merge-base', '--independent', ...edges], { allowFailure: true }).stdout.split('\n').filter(sha => SHA.test(sha));
    if (newest.length === 1) return { seen, ground: newest[0], how: how(newest[0]), sure: true };
    const joined = newest.length === 2 ? newest.sort() : null, tree = joined && joinedTree(root, joined);
    if (tree) return { seen, ground: tree, how: 'joined', sure: true, joined };
  }
  // Its commits after its last merge are its own for certain.
  const after = new Set();
  for (let at = tip; at !== merge && own.has(at); at = parents.get(at)?.[0]) after.add(at);
  return { seen: after, ground: merge ?? tip, how: 'merge', sure: false };
}
export const NOTES = Object.freeze({
  here: 'This session works in your own folder. What anyone changed there since it started counts too.',
  blind: "ELU cannot tell which commits here are this session's, so only what is not committed shows.",
  merge: name => `This session merged other work into ${name}, so only its changes since that merge show.`,
  crowded: 'Your folder had over 2,000 changed files before this session started, so some of them show too.',
});
// The session's branches, the one that is checked out first, then the others it made, the
// one it worked on last first: [{ branch, current, ground, tip, commits, how, remote }], and
// the one line to say when something could not be told (note). branch is null where HEAD is
// on no branch; remote marks a branch that is only on the remote now.
export function sessionWork(task) {
  const root = task.worktree, base = task.base, here = task.place?.kind === 'here';
  const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowFailure: true }).stdout.trim();
  if (!SHA.test(head)) return { parts: [{ branch: null, current: true, ground: base, tip: null, commits: 0, how: 'started', remote: false }], note: null, log: [] };
  const name = currentBranch(root) || null, log = headLog(root, here ? Date.parse(task.createdAt) || 0 : 0, base);
  const { own, parents } = log ? madeHere(root, log.rows, base) : { own: new Set(), parents: new Map() };
  const first = under(root, head, own, parents, base), parts = [{ branch: name, current: true, ground: first.ground, tip: head, commits: first.seen.size, how: first.how, joined: first.joined ?? null, remote: false }];
  // Without the record, a commit the session did not start from cannot be told from its own.
  const blind = head !== base && !first.seen.size && (!log || !here && !log.whole || !log.rows.some(row => row.now === head));
  if (blind) parts[0].how = 'head';
  let unsure = first.sure ? null : name ?? 'this branch';
  if (own.size) {
    const covered = new Set(first.seen), last = new Map(log.rows.map((row, at) => [row.now, at])), sent = new Set();
    const refs = git(root, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes'], { allowFailure: true }).stdout.split('\n').flatMap(line => {
      const [tip, ref = ''] = line.split(' '), local = ref.startsWith('refs/heads/'), short = local ? ref.slice(11) : ref.split('/').slice(3).join('/');
      if (!local && short) sent.add(short);
      return own.has(tip) && short && short !== 'HEAD' ? [{ tip, short, local }] : [];
    }).sort((a, b) => (last.get(b.tip) ?? -1) - (last.get(a.tip) ?? -1) || Number(b.local) - Number(a.local));
    for (const ref of refs) {
      // A branch under one that is listed already holds no change of its own to list.
      if (covered.has(ref.tip)) continue;
      const found = under(root, ref.tip, own, parents, base);
      for (const sha of found.seen) covered.add(sha);
      if (!found.sure) unsure ??= ref.short;
      parts.push({ branch: ref.short, current: false, ground: found.ground, tip: ref.tip, commits: found.seen.size, how: found.how, joined: found.joined ?? null, remote: !ref.local });
    }
    // pushed: the remote has a branch of this name, so it may have a pull request.
    for (const part of parts) part.pushed = Boolean(part.branch) && part.commits > 0 && sent.has(part.branch);
  }
  return { parts, note: blind ? NOTES.blind : unsure ? NOTES.merge(unsure) : here ? NOTES.here : null, log: log?.rows ?? [] };
}
// What a part is compared with, in plain words: `main as it was when this session branched`.
// The name is the branch the commit is on that a reader knows best: the remote's main one,
// then main or master, then the project's own branch, then any other that is not the
// session's. Where no branch holds it, the commit is named by its first characters.
const named = new Map();
function nameOf(root, sha, skip, prefer) {
  const key = `${root}\0${sha}\0${prefer ?? ''}\0${[...skip].join('\0')}`;
  if (named.has(key)) return named.get(key);
  const rows = git(root, ['for-each-ref', '--contains', sha, '--format=%(refname) %(symref)', 'refs/heads', 'refs/remotes'], { allowFailure: true }).stdout.split('\n').filter(Boolean).map(line => line.split(' '));
  const main = new Set(rows.filter(([, target]) => target).map(([, target]) => target));
  let best = null;
  for (const [ref, target] of rows) {
    const local = ref.startsWith('refs/heads/'), short = local ? ref.slice(11) : ref.split('/').slice(3).join('/');
    if (target || !short || skip.has(short)) continue;
    const known = NAMES.indexOf(short), rank = main.has(ref) ? 0 : known >= 0 ? 1 + known : short === prefer ? 10 : local ? 12 : 11;
    if (!best || rank < best.rank) best = { rank, short };
  }
  if (best) { named.set(key, best.short); if (named.size > 400) named.delete(named.keys().next().value); }
  return best?.short ?? null;
}
const WHEN = { started: 'when this session started', branched: 'when this session branched', merged: 'when this session last merged it in', merge: 'after the last merge this session made' };
// project: the branch the project's own folder is on, where a session in a worktree started.
export function comparedWith(task, work, part, { project = null } = {}) {
  if (part.ground === null) return 'an empty project: this branch has no history before this session';
  if (part.how === 'merge') return `${part.branch ?? 'this branch'} ${WHEN.merge}`;
  if (part.how === 'head') return `the last commit on ${part.branch ?? 'this folder'}`;
  const kind = task.place?.kind ?? 'worktree', mine = new Set(work.parts.filter(row => row.commits && row.branch).map(row => row.branch));
  if (kind === 'worktree' && task.branch) mine.add(task.branch);
  if (part.how === 'joined') {
    // Each of the two by the branch a reader knows it by, the named one first: `main and feature, merged`.
    const told = part.joined.map(sha => nameOf(task.worktree, sha, mine, project)), words = told.map((name, at) => name && told.indexOf(name) === at ? name : `commit ${part.joined[at].slice(0, 8)}`);
    return `${words.sort((a, b) => Number(a.startsWith('commit ')) - Number(b.startsWith('commit '))).join(' and ')}, merged`;
  }
  let name = null;
  if (part.how === 'started' && kind !== 'worktree') {
    // The branch the session started on is the one it left first, or the one it is still on.
    const left = /^checkout: moving from (\S+) to /.exec(work.log.find(row => row.text.startsWith('checkout: moving from '))?.text ?? '')?.[1];
    name = kind === 'branch' ? task.place.branch : left && !SHA.test(left) ? left : work.parts[0].branch;
  }
  name ??= nameOf(task.worktree, part.ground, mine, project);
  return name ? `${name} as it was ${WHEN[part.how]}` : `commit ${part.ground.slice(0, 8)}, ${part.how === 'started' ? 'where this session started' : part.how === 'branched' ? 'where this session branched' : 'which this session last merged in'}`;
}
// What Git compares a part with: its ground, or the tree with nothing in it.
export const groundOf = (root, part) => part.ground ?? git(root, ['hash-object', '-t', 'tree', '--stdin'], { input: '' }).stdout.trim();
// In the owner's own folder (place here) what is not committed may be the owner's own, from
// before the session. A file that was not written, made or moved since the session started
// cannot be the session's work: names holds the paths not committed whose file (for one that
// is gone, the folder it was in) is older than the session, and skip is what leaves the ones
// Git tracks out of a diff. A command line holds OLDER_MAX of those: with more, the rest
// still show, and more says so (NOTES.crowded). Nothing for a session in a folder of its
// own, where everything not committed is the session's.
const OLDER_MAX = 2000;
export function olderThanSession(task) {
  const since = Date.parse(task.createdAt), root = task.worktree, older = { names: new Set(), skip: [], more: false };
  if (task.place?.kind !== 'here' || !Number.isFinite(since)) return older;
  const changedAt = name => {
    for (let at = path.join(root, name); at.length >= root.length; at = path.dirname(at)) { try { return fs.lstatSync(at).ctimeMs; } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') break; } }
    return Infinity;
  };
  const listed = args => { const run = git(root, args, { allowFailure: true }); return run.status === 0 ? run.stdout.split('\0').filter(name => name && changedAt(name) < since) : []; };
  for (const name of listed(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', 'HEAD', '--'])) {
    if (older.skip.length === OLDER_MAX) { older.more = true; break; }
    older.names.add(name); older.skip.push(`:(exclude,literal)${name}`);
  }
  for (const name of listed(['ls-files', '--others', '--exclude-standard', '-z'])) older.names.add(name);
  return older;
}
// The paths a session changed, on every branch of its own, for where only names are told.
export function sessionFiles(task) {
  const names = new Set(), older = olderThanSession(task);
  for (const part of sessionWork(task).parts) {
    const ground = groundOf(task.worktree, part);
    const run = git(task.worktree, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', ground, ...(part.current ? [] : [part.tip]), '--', ...(part.current ? older.skip : [])], { allowFailure: true });
    if (run.status === 0) for (const name of run.stdout.split('\0')) if (name) names.add(name);
  }
  const extra = git(task.worktree, ['ls-files', '--others', '--exclude-standard', '-z'], { allowFailure: true });
  if (extra.status === 0) for (const name of extra.stdout.split('\0')) if (name && !older.names.has(name)) names.add(name);
  return [...names].sort();
}
