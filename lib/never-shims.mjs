// Stand-in commands for the never list. One small script per command word (git, gh, npm and
// the rest) in a private folder that goes first on the PATH of a session in Ask for approval
// or Approve for me: it refuses the calls those modes do not allow, by name, and hands every
// other call, arguments untouched, to the real command. It reaches what a rule on the model's
// own command line cannot: a script the session runs, sh -c, a wrapper. It is not a sandbox.
// A full path to the real command, a changed PATH, a Git alias or another program that does
// the same work gets past it; it is written again whenever a session starts. A session in
// Full access gets none: there the model runs what the owner's own shell could.
//
// Two things are not publishing and pass: a git push whose destination is a folder on this
// machine, and a git merge or git tag in a scratch repository under the system temporary
// directory. A project's own tests do both.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { neverCommands, neverSentence } from './never-list.mjs';
import { EluCodeError, onDiskPath, quote, refuse, systemTemp } from './util.mjs';

// The vendors whose sessions get the folder first on PATH outside Full access: all of them. Where a vendor has
// rules on the command's text as well (Claude Code, Antigravity, Grok Build), those stay;
// the stand-ins reach what a script runs, which that text does not show.
export const SHIM_VENDORS = Object.freeze(['codex', 'claude', 'agy', 'grok']);
// What a stand-in exits with when it refuses.
export const REFUSED = 126;
// Outside the project and outside ELU's own state, which a session may not read: a
// session has to be able to read and run these. Nothing in a sandboxed mode may write here.
export function shimsBase() {
  const data = process.env.XDG_DATA_HOME;
  return path.join(onDiskPath(data && path.isAbsolute(data) ? data : path.join(os.homedir(), '.local', 'share')), 'elu-code', 'never-list');
}
const folderOf = merge => path.join(shimsBase(), merge === true ? 'merge-allowed' : 'all');
// A stand-in named as a vendor's own program (claude, for claude mcp add) has a folder to
// itself beside the others'. Another tool may put a script of that name ahead of the program
// on PATH, one that looks along PATH for the real program and runs the first other file it
// finds: a terminal app that wraps the vendor's command does. Given this stand-in it is handed
// straight back, and stops the turn as a loop. So the folder is never on the PATH that program
// is started with (shimPath), and the stand-in takes it off PATH as it hands a call on. A
// stand-in for any other command does that only for a call that came back to it.
const ownFolder = (merge, name) => `${folderOf(merge)}-${name}`;
// The system temporary directory, links resolved: the one ELU itself was given, and /tmp.
// Read when the stand-ins are written, so a session cannot name another folder by changing TMPDIR.
export function scratchRoots() {
  const out = [];
  for (const dir of [systemTemp(), '/tmp']) { try { const real = fs.realpathSync(dir); if (real !== path.parse(real).root && !out.includes(real)) out.push(real); } catch { /* Not on this system. */ } }
  return out;
}

const WORD = /^[a-z][a-z0-9-]*$/;
// The never list by command word: { git: [['push'], ['tag'], ['merge']], gh: [['pr', 'merge'], ['release']], … }.
function byWord(options) {
  const out = {};
  for (const command of neverCommands(options)) {
    const [name, ...rest] = command.split(' ');
    if (![name, ...rest].every(word => WORD.test(word)) || rest.length < 1 || rest.length > 2) throw new Error(`No stand-in can read this never-list command: ${command}`);
    (out[name] ??= []).push(rest);
  }
  return out;
}
// What every stand-in starts with: how it refuses, and how it finds and runs the real command,
// which is the first one on PATH outside the stand-in folders and never this file.
// own: the stand-in is named as a vendor's own program, and leaves PATH as it hands a call on.
const head = (shell, name, base, own = false) => `#!${shell}
# Written by ELU and written again whenever a session starts. It refuses the commands
# only Full access allows and hands every other call, arguments untouched, to the real ${name}.
set -f
name=${name}
base=${quote(base)}
refuse() { printf '${neverSentence('%s')}.\\n' "$1" >&2; exit ${REFUSED}; }
find_real() {
  self=\${0%/*}
  old=$IFS; IFS=:
  for d in $PATH; do
    IFS=$old
    [ -n "$d" ] || d=.
    case $d/ in "$base"/*) continue;; esac
    [ "$d" = "$self" ] && continue
    [ -f "$d/$name" ] && [ -x "$d/$name" ] || continue
    [ "$d/$name" -ef "$0" ] 2>/dev/null && continue
    real=$d/$name; return 0
  done
  IFS=$old
  return 1
}
# Another tool's script for this command may look along PATH for the real one and run the first
# other file of its name it finds: this one, which would hand the call straight back to it.
# ${own ? 'So the folders that hold this file leave PATH whenever a call is handed on.' : 'A call that comes back here in the same process is handed on once more, and the folders\n# that hold this file leave PATH with it.'}
leave() {
  kept=; n=0; old=$IFS; IFS=:
  for d in $PATH; do
    IFS=$old
    [ "$d" = "$self" ] && continue
    case $d/ in "$base"/*) [ -e "$d/$name" ] && continue;; esac
    if [ $n = 0 ]; then kept=$d; n=1; else kept=$kept:$d; fi
  done
  IFS=$old
  PATH=$kept; export PATH
}
hand() { ${own ? 'leave' : '[ "\${ELU_NEVER_LIST_WENT-}" = "$$ $name" ] && leave; ELU_NEVER_LIST_WENT="$$ $name"; export ELU_NEVER_LIST_WENT'}; exec "$real" "$@"; }
run() { find_real || { printf '%s: command not found\\n' "$name" >&2; exit 127; }; hand "$@"; }
`;
const tail = 'run "$@"\n';
// git, read as git reads it: its own options first (these take the next word as their value),
// then the command. Listing tags changes nothing and build scripts do it, so git tag alone and
// git tag -l or --list pass.
const GIT_VALUES = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--shallow-file', '--attr-source'];
// What lets a never-list git call through when it stays on this machine. A word with no rule
// here is refused outright.
const GIT_LOCAL = { push: 'push_local', merge: 'scratch', tag: 'scratch' };
// The options of git push that change nothing about where it goes. Any other option is one
// this script cannot read, and the push is refused.
const PUSH_FLAGS = ['all', 'branches', 'mirror', 'tags', 'follow-tags', 'no-follow-tags', 'atomic', 'no-atomic', 'dry-run', 'porcelain', 'delete', 'prune', 'no-prune', 'force', 'no-force', 'force-with-lease', 'no-force-with-lease',
  'force-if-includes', 'no-force-if-includes', 'set-upstream', 'thin', 'no-thin', 'quiet', 'verbose', 'progress', 'no-progress', 'verify', 'no-verify', 'signed', 'no-signed', 'ipv4', 'ipv6'];
function gitBody(paths, roots) {
  if (paths.some(words => words.length !== 1)) throw new Error('A git entry of the never list names more than its command.');
  const words = paths.map(([word]) => word), local = words.filter(word => GIT_LOCAL[word]), outright = words.filter(word => !GIT_LOCAL[word]);
  const later = local.filter(word => word !== 'tag');
  return `seen=0; sub=; more=0; first=; skip=0; nopt=0
for a do
  if [ $seen = 1 ]; then more=1; first=$a; break; fi
  if [ $skip = 1 ]; then skip=0; nopt=$((nopt+1)); continue; fi
  case $a in
    ${GIT_VALUES.join('|')}) skip=1; nopt=$((nopt+1));;
    -*) nopt=$((nopt+1));;
    *) seen=1; sub=$a;;
  esac
done
case $sub in
${later.length ? `  ${later.join('|')}) ;;\n` : ''}${local.includes('tag') ? '  tag) case $more$first in 0|1-l|1--list) run "$@";; esac;;\n' : ''}${outright.length ? `  ${outright.join('|')}) refuse "$name $sub";;\n` : ''}  *) run "$@";;
esac
# Only a call the never list names reads on from here. Pushing to a folder on this machine and
# working in a scratch repository under the temporary directory are not publishing, so those
# pass. git itself is asked where the push would go and which repository the call acts on;
# whatever it cannot say is refused.
find_real || refuse "$name $sub"
nl='
'
# The real git with this call's own options (-C, -c, --git-dir and the rest), then q1 to q5.
gitq() {
  qt=$#; qi=0
  while [ $qi -lt $qt ]; do
    qa=$1; shift; qi=$((qi+1))
    [ $qi -gt $nopt ] || set -- "$@" "$qa"
  done
  "$real" "$@" \${q1:+"$q1"} \${q2:+"$q2"} \${q3:+"$q3"} \${q4:+"$q4"} \${q5:+"$q5"} </dev/null 2>/dev/null
}
# Whether git reads this as a place on this machine: a file URL, or a path with no host before it.
islocal() {
  case $1 in
    '') return 1;;
    file://*) return 0;;
    *://*) return 1;;
    *:*) case \${1%%:*} in */*) return 0;; esac; return 1;;
  esac
  return 0
}
# Whether every place git would push to for $1 (a remote, a path or a URL) is on this machine.
dest_local() {
  dl=$1; shift
  [ -n "$dl" ] || return 1
  # A remote of this repository: git gives its push URLs, with pushurl and every
  # url.<base>.insteadOf and pushInsteadOf rule applied.
  q1=remote q2=get-url q3=--push q4=--all q5=$dl
  if urls=$(gitq "$@") && [ -n "$urls" ]; then
    oldifs=$IFS; IFS=$nl
    for u in $urls; do IFS=$oldifs; islocal "$u" || return 1; done
    IFS=$oldifs
    return 0
  fi
  # Not one. A bare name may be a remote from the user's own Git settings, so only what is
  # written as a path or a file URL goes on, and only when nothing is set under that very name.
  case $dl in /*|./*|../*|file://*) ;; *) return 1;; esac
  q1=config q2=--get-all q3=remote.$dl.pushurl q4= q5=
  gitq "$@" >/dev/null; [ $? = 1 ] || return 1
  q3=remote.$dl.url
  gitq "$@" >/dev/null; [ $? = 1 ] || return 1
  # A pushInsteadOf rule that matches sends the push somewhere else.
  q1=config q2=--get-regexp q3='^url\\..*\\.pushinsteadof$' q4= q5=
  rules=$(gitq "$@")
  oldifs=$IFS; IFS=$nl
  for rule in $rules; do
    IFS=$oldifs
    while :; do
      case $rule in *' '*) rule=\${rule#* };; *) break;; esac
      case $dl in "$rule"*) return 1;; esac
    done
  done
  IFS=$oldifs
  q1=ls-remote q2=--get-url q3=$dl q4= q5=
  u=$(gitq "$@") && islocal "$u"
}
# The remote a push with none named goes to, as git picks it.
default_remote() {
  dr=; br=
  q1=symbolic-ref q2=-q q3=--short q4=HEAD q5=
  br=$(gitq "$@") || br=
  if [ -n "$br" ]; then q1=config q2=--get q3=branch.$br.pushremote q4= q5=; dr=$(gitq "$@") || dr=; fi
  if [ -z "$dr" ]; then q1=config q2=--get q3=remote.pushdefault q4= q5=; dr=$(gitq "$@") || dr=; fi
  if [ -z "$dr" ] && [ -n "$br" ]; then q1=config q2=--get q3=branch.$br.remote q4= q5=; dr=$(gitq "$@") || dr=; fi
  [ -z "$dr" ] || return 0
  # None is set for the branch: the only remote when there is one, else origin.
  q1=remote q2= q3= q4= q5=
  dr=$(gitq "$@") || return 1
  case $dr in '') return 1;; *"$nl"*) dr=origin;; esac
  return 0
}
push_local() {
  pn=$((nopt+1)); pi=0; repo=; has=0; pend=0; pskip=0
  for pa do
    pi=$((pi+1)); [ $pi -gt $pn ] || continue
    if [ $pskip = 1 ]; then pskip=0; continue; fi
    if [ $pend = 0 ]; then
      case $pa in
        --) pend=1; continue;;
        -o|--push-option) pskip=1; continue;;
        -o*|--push-option=*|--force-with-lease=*|--signed=*) continue;;
        --no-recurse-submodules|--recurse-submodules=no|--recurse-submodules=check) continue;;
        ${PUSH_FLAGS.map(flag => `--${flag}`).join('|')}) continue;;
        --*) return 1;;
        -*[!fnqvud46]*) return 1;;
        -?*) continue;;
      esac
    fi
    [ $has = 1 ] || { has=1; repo=$pa; }
  done
  # Submodules pushed on demand go to their own remotes.
  q1=config q2=--get q3=push.recursesubmodules q4= q5=
  sm=$(gitq "$@") || sm=
  case $sm in ''|no|check|false|off|0) ;; *) return 1;; esac
  if [ -z "$sm" ]; then q1=config q2=--type=bool q3=--get q4=submodule.recurse q5=; [ "$(gitq "$@")" != true ] || return 1; fi
  if [ $has = 0 ]; then default_remote "$@" || return 1; repo=$dr; fi
  dest_local "$repo" "$@"
}
# Whether a folder lies, links resolved, inside the system temporary directory.
intemp() {
${roots.length ? `  it=$(cd -P -- "$1" 2>/dev/null && pwd -P) || return 1
  case $it in ${roots.map(root => `${quote(root)}/?*`).join('|')}) return 0;; esac
` : ''}  return 1
}
# Whether the repository this call acts on is a scratch one: its top level and the folder that
# holds its history both lie inside the temporary directory. A worktree there of a repository
# kept somewhere else is not one.
scratch() {
  q1=rev-parse q2=--show-toplevel q3= q4= q5=
  top=$(gitq "$@") && [ -n "$top" ] || { q2=--absolute-git-dir; top=$(gitq "$@") && [ -n "$top" ]; } || return 1
  q2=--path-format=absolute q3=--git-common-dir
  common=$(gitq "$@") && [ -n "$common" ] || return 1
  intemp "$top" && intemp "$common"
}
case $sub in
${local.map(word => `  ${word}) ${GIT_LOCAL[word]} "$@" || refuse "$name ${word}";;\n`).join('')}esac
hand "$@"
`;
}
// Every other tool, read on the safe side: an option written without = may or may not take
// the next word as its value, so both readings are tried and either one that makes a
// never-list command refuses. skips: words the tool reads past before its command.
const SKIPS = { gcloud: ['alpha', 'beta', 'preview'] };
function body(name, paths) {
  const one = paths.filter(words => words.length === 1).map(([word]) => word), two = paths.filter(words => words.length === 2);
  const firsts = [...new Set(two.map(([word]) => word))], skips = SKIPS[name] ?? [];
  return `looking=1; w=; prev=0
for a do
  case $a in
    ${name === 'cargo' ? '+*|' : ''}-*=*) prev=0; continue;;
    -*) prev=1; continue;;
  esac
${two.length ? `  if [ -n "$w" ]; then
    case "$w $a" in ${two.map(words => `'${words.join(' ')}'`).join('|')}) refuse "$name $w $a";; esac
    [ $prev = 1 ] || w=
  fi
` : ''}  if [ $looking = 1 ]; then
    case $a in
${skips.length ? `      ${skips.join('|')}) prev=0; continue;;\n` : ''}${one.length ? `      ${one.join('|')}) refuse "$name $a";;\n` : ''}${firsts.length ? `      ${firsts.join('|')}) w=$a;;\n` : ''}    esac
    [ $prev = 1 ] || looking=0
  fi
  prev=0
  if [ $looking = 0 ] && [ -z "$w" ]; then break; fi
done
${tail}`;
}
// The scripts, by file name. merge: a bot the owner lets merge pull requests; its gh stand-in
// then does not refuse gh pr merge. roots: the folders that count as the temporary directory.
export function shimScripts({ merge = false, roots = scratchRoots() } = {}) {
  // dash starts faster than the bash that /bin/sh is on some systems; a session runs git hundreds of times.
  const shell = fs.existsSync('/bin/dash') ? '/bin/dash' : '/bin/sh', base = shimsBase();
  return Object.fromEntries(Object.entries(byWord({ merge })).map(([name, paths]) => [name, `${head(shell, name, base, SHIM_VENDORS.includes(name))}${name === 'git' ? gitBody(paths, roots) : body(name, paths)}`]));
}
// The stand-ins that are named as a vendor's own program: each vendor's command is its name.
const ownNames = merge => Object.keys(byWord({ merge })).filter(name => SHIM_VENDORS.includes(name));
// The folder a stand-in is kept in.
export const shimFolder = (name, { merge = false } = {}) => SHIM_VENDORS.includes(name) ? ownFolder(merge, name) : folderOf(merge);
// Writes the folder (0700, files 0755) and returns it, and beside it the folder of each
// stand-in named as a vendor's own program. A file that already says the same is
// left alone; anything else found there is removed, so nothing a session left in a folder
// that is first on PATH stays for the next one.
export function writeShims({ merge = false, roots = scratchRoots() } = {}) {
  const all = shimScripts({ merge, roots }), own = ownNames(merge);
  writeFolder(folderOf(merge), Object.fromEntries(Object.entries(all).filter(([name]) => !own.includes(name))));
  for (const name of own) writeFolder(ownFolder(merge, name), { [name]: all[name] });
  return folderOf(merge);
}
function writeFolder(folder, scripts) {
  const base = shimsBase();
  try {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    for (const dir of [base, folder]) { const stat = fs.lstatSync(dir); if (!stat.isDirectory()) throw new Error(`${dir} is not a folder`); if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700); }
    for (const [name, text] of Object.entries(scripts)) {
      const file = path.join(folder, name);
      let same = false;
      try { const stat = fs.lstatSync(file); same = stat.isFile() && (stat.mode & 0o777) === 0o755 && fs.readFileSync(file, 'utf8') === text; } catch { /* Written below. */ }
      if (same) continue;
      const draft = path.join(folder, `.${name}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
      fs.writeFileSync(draft, text, { mode: 0o755, flag: 'wx' }); fs.chmodSync(draft, 0o755); fs.renameSync(draft, file);
    }
    // A name that starts with a dot is another launch's file on its way in.
    for (const name of fs.readdirSync(folder)) if (!Object.hasOwn(scripts, name) && !name.startsWith('.')) fs.rmSync(path.join(folder, name), { recursive: true, force: true });
  } catch (error) {
    if (error instanceof EluCodeError) throw error;
    refuse(`ELU could not write its stand-in commands for the never list: ${error.message}`);
  }
}
// PATH without any stand-in folder: for a session in Full access, which refuses nothing by
// name, so a folder an outer session left on PATH does not refuse for it either.
export function withoutShims(current = '') {
  const base = shimsBase();
  return String(current ?? '').split(path.delimiter).filter(dir => dir && dir !== base && !dir.startsWith(`${base}${path.sep}`)).join(path.delimiter);
}
// PATH for a session: the folders first, and no other stand-in folder after them. It returns the
// text and changes nothing else: ELU's own checks never run behind the stand-ins.
// program: the command of the vendor this PATH starts. A stand-in of that name is left off, so
// another tool's script for the command, looking for the real one, does not find it.
export function shimPath(current = '', { merge = false, program = null } = {}) {
  const folder = writeShims({ merge }), rest = withoutShims(current);
  return [...ownNames(merge).filter(name => name !== program).map(name => ownFolder(merge, name)), folder, ...(rest ? [rest] : [])].join(path.delimiter);
}
// Claude Code starts each command from a snapshot of the owner's shell setup. The snapshot
// builds PATH again, which leaves the folder behind the system's own. Claude Code runs the
// file named in CLAUDE_ENV_FILE ahead of each command, after the snapshot: this one line puts
// the folder first again, and with it the folder of the stand-in named claude, which is not on
// the PATH Claude Code itself is started with. Returns the file, beside the folder it names.
export function shimEnvFile({ merge = false } = {}) {
  const folder = writeShims({ merge }), file = `${folder}.path.sh`, text = `export PATH=${[...ownNames(merge).map(name => ownFolder(merge, name)), folder].map(quote).join(':')}:"$PATH"\n`;
  try {
    let same = false;
    try { const stat = fs.lstatSync(file); same = stat.isFile() && fs.readFileSync(file, 'utf8') === text; } catch { /* Written below. */ }
    if (!same) {
      const draft = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
      fs.writeFileSync(draft, text, { mode: 0o644, flag: 'wx' }); fs.renameSync(draft, file);
    }
  } catch (error) { refuse(`ELU could not write its stand-in commands for the never list: ${error.message}`); }
  return file;
}
