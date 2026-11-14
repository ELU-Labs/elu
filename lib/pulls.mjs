import { spawn } from 'node:child_process';
import { findBin } from './util.mjs';

// The pull request of a branch, as GitHub's own program (gh) lists it. Asking takes the
// network and a moment, so it is asked in the background and what is known so far is given
// at once: nothing waits for it. Without gh, or signed out of it, nothing is known and
// nothing is said. An answer is kept ten minutes; a branch with no pull request yet is asked
// about again after one.
const folders = new Map(), KNOWN_MS = 600000, NONE_MS = 60000, CALL_MS = 20000, OUT_MAX = 200000;
function ask(gh, folder, entry, name) {
  entry.busy.add(name);
  let out = '', done = false, child;
  const finish = code => {
    if (done) return; done = true; clearTimeout(timer); entry.busy.delete(name);
    const before = entry.rows.get(name)?.pull ?? null;
    let pull = before;
    if (code === 0) {
      let rows = null; try { rows = JSON.parse(out); } catch { /* Not an answer. */ }
      if (Array.isArray(rows)) {
        const found = rows.filter(row => Number.isSafeInteger(row?.number) && row.number > 0).sort((one, two) => Number(two.state === 'OPEN') - Number(one.state === 'OPEN') || two.number - one.number)[0];
        pull = found ? { number: found.number, url: typeof found.url === 'string' && /^https:\/\/\S{1,300}$/.test(found.url) ? found.url : null } : null;
      }
    }
    entry.rows.set(name, { at: Date.now(), pull });
    if (JSON.stringify(pull) !== JSON.stringify(before)) { entry.stamp++; try { entry.tell?.(); } catch { /* The view that asked is gone. */ } }
  };
  const timer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* Gone. */ } finish(null); }, CALL_MS);
  timer.unref?.();
  try {
    child = spawn(gh, ['pr', 'list', '--head', name, '--state', 'all', '--limit', '20', '--json', 'number,url,state'], { cwd: folder, env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { finish(null); return; }
  child.stdout.on('data', data => { if (out.length < OUT_MAX) out += data; });
  child.on('error', () => finish(null));
  child.on('close', code => finish(code));
  // Nothing waits for the answer, so a command that is done does not stay for it.
  child.unref?.(); child.stdout.unref?.();
}
// The pull requests known for these branches of the project in `folder`: Map of name to
// { number, url }. changed: called once an answer that differs from what was known arrives.
export function pulls(folder, names, { changed = null, now = Date.now() } = {}) {
  let entry = folders.get(folder);
  if (!entry) {
    entry = { rows: new Map(), stamp: 0, busy: new Set(), tell: null }; folders.set(folder, entry);
    if (folders.size > 50) folders.delete(folders.keys().next().value);
  }
  if (changed) entry.tell = changed;
  const gh = names.length ? findBin('gh') : null;
  for (const name of gh ? names : []) {
    const row = entry.rows.get(name);
    if (!entry.busy.has(name) && !(row && now - row.at < (row.pull ? KNOWN_MS : NONE_MS))) ask(gh, folder, entry, name);
  }
  return new Map(names.flatMap(name => entry.rows.get(name)?.pull ? [[name, entry.rows.get(name).pull]] : []));
}
// A number that moves when an answer about this folder's branches changed.
export const pullsStamp = folder => folders.get(folder)?.stamp ?? 0;
