import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { git, project, fakeClis } from './helpers.mjs';
import { repository } from '../lib/git.mjs';
import { saveTask } from '../lib/state.mjs';
import { createIdentity } from '../lib/peer/identity.mjs';
import { createTeam, readLog, merge } from '../lib/peer/roster.mjs';
import { createInvite, redeemCode } from '../lib/peer/invite.mjs';
import { projectFolder } from '../lib/workspace.mjs';
import { registerProject, registeredProjects } from '../lib/projects.mjs';
import { share, setTeamProject, teamProjects } from '../lib/peer/shares.mjs';
import { saveTeamAccess, teamAccess } from '../lib/peer/access.mjs';
import { commonTeams } from '../lib/peer/project-share.mjs';

// Peer state lives under $XDG_CONFIG_HOME/elu-code/peer, so a "home" here is an
// XDG_CONFIG_HOME value. Tests in one file run one at a time, which these helpers rely on.

// A fresh temp home that is not active yet; removed after the test.
export function newHome(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-peer-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'personal');
}
function activate(home) {
  const previous = process.env.XDG_CONFIG_HOME; process.env.XDG_CONFIG_HOME = home;
  return () => { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; };
}
// Makes a fresh temp home active for the rest of the test and restores the old one after.
export function peerHome(t) { const home = newHome(t), restore = activate(home); t.after(restore); return home; }
// Runs fn (sync or async) with another home active, then restores the previous one.
export function withHome(home, fn) {
  const restore = activate(home);
  let result; try { result = fn(); } catch (error) { restore(); throw error; }
  if (result && typeof result.then === 'function') return Promise.resolve(result).finally(restore);
  restore(); return result;
}
// A founder and a member in two homes, joined through a real invite and redeem (no
// network): the member's home receives the founder's full log, as elu.invite.prove returns it.
export function makeTeam(t, { founderName = 'ana', memberName = 'sara', teamName = 'core' } = {}) {
  const founderHome = newHome(t), memberHome = newHome(t);
  const member = withHome(memberHome, () => createIdentity({ name: memberName }));
  const { founder, teamId, code, log } = withHome(founderHome, () => {
    const founder = createIdentity({ name: founderName }), state = createTeam(founder, teamName);
    const code = createInvite(founder, state.id, { hours: 1 });
    redeemCode(code, member.key, memberName);
    return { founder, teamId: state.id, code, log: readLog(state.id).ops };
  });
  withHome(memberHome, () => { const { rejected } = merge(teamId, log); if (rejected.length) throw new Error(rejected[0].reason); });
  return { teamId, code, founder: { home: founderHome, identity: founder }, member: { home: memberHome, identity: member } };
}
// A git project registered in the active home, optionally with an origin remote.
export function registeredProject(t, { origin } = {}) {
  const { parent, root } = project(t);
  if (origin) git(root, ['remote', 'add', 'origin', origin]);
  const repo = projectFolder(root); registerProject(repo);
  return { parent, root: repo.root };
}
// The shared fake CLIs, with the reply summary read from a file when it exists, so a
// test can make a teammate's agent answer with chosen text (for example a secret).
export function answeringClis(parent) {
  const fake = fakeClis(parent, { mode: 'answer' }), summary = path.join(parent, 'summary.txt');
  const mark = "const session='12345678";
  for (const vendor of ['claude']) {
    const file = path.join(fake.dir, vendor), script = fs.readFileSync(file, 'utf8');
    if (!script.includes(mark)) throw new Error('helpers.mjs fake CLI changed shape');
    fs.writeFileSync(file, script.replace(mark, `if(fs.existsSync(${JSON.stringify(summary)}))result.summary=fs.readFileSync(${JSON.stringify(summary)},'utf8');\n${mark}`), { mode: 0o755 });
  }
  return { ...fake, summary: text => fs.writeFileSync(summary, text) };
}
// A live editing task (state ready, which a conductor's recovery leaves alone) in a
// registered project, with its own worktree and the given files changed.
export function liveTask(root, { id = '1', goal = 'Normalize coupons', state = 'ready', activeRole = 'lead', files = { 'src/coupon.mjs': 'export const normalize = (value) => value.trim();\n' } } = {}) {
  const repo = repository(root), worktree = path.join(repo.worktrees, id), base = git(root, ['rev-parse', 'HEAD']);
  fs.mkdirSync(repo.worktrees, { recursive: true });
  git(root, ['worktree', 'add', '-b', `feat/task-${id}`, worktree, base]);
  for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true }); fs.writeFileSync(path.join(worktree, file), text); }
  saveTask(repo, { id, goal, state, worktree, branch: `feat/task-${id}`, base, createdAt: new Date().toISOString(), runs: [], reviews: [], messages: [], sessions: {}, activeRole });
  return { repo, worktree, base };
}

// What lets another computer see and work on the sessions here: a shared project, never a mark
// of whose computer it is. Every project registered in the active home but the home folder is
// shared with the teams me and key are both on, the first becomes each team's project, and
// each team's access is set to handling there (Auto unless said), keeping a folder it set.
// Returns that first project's folder, or null when there is none.
export function shareProjects(me, key, { handling = 'auto' } = {}) {
  const ids = commonTeams(me, key);
  if (!ids.length) throw new Error('These two computers are on no team together.');
  let home = os.homedir(); try { home = fs.realpathSync(home); } catch { /* As given. */ }
  let first = null;
  for (const repo of registeredProjects()) {
    if (repo.root === home || home.startsWith(`${repo.root}${path.sep}`)) continue;
    // Two projects in folders of one name each get a handle of their own.
    let row; try { row = share(repo.root, { teams: ids }); } catch (error) { if (!/already shared/.test(error.message)) throw error; row = share(repo.root, { teams: ids, handle: `${path.basename(repo.root).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 30)}-${crypto.randomBytes(3).toString('hex')}` }); }
    first ??= { root: repo.root, handle: row.handle };
  }
  if (!first) return null;
  const projects = teamProjects();
  for (const id of ids) { if (!projects[id]) setTeamProject(id, first.handle); saveTeamAccess(id, { handling, root: teamAccess(id)?.root ?? first.root }); }
  return first.root;
}
