import fs from 'node:fs';
import { SIGNS_IN_IN_ELU, SIGN_IN_IN_ELU, VENDOR_NAMES, signInCommand } from './vendors.mjs';
import { DEFAULT_LOGIN, LOGIN_VENDORS } from './logins.mjs';
import { accountOf } from './usage.mjs';

// The one line a session shows under its last message when it stopped and waits for the
// owner: why it stopped, in plain words when that is known, and the one thing to do. The
// status row and the Sessions list show the same action. It is worked out when the session
// is drawn, from what the session keeps, so a session that stopped under an older release
// gets it too.
const CARRY_ON = 'Type continue to carry on.';
const AGAIN = 'Type continue to try again.';
const NEW_SESSION = 'Start a new session with /new.';
const MODEL = 'Choose another with /model, then type continue.';
// A vendor where the owner keeps several accounts signed in (lib/logins.mjs): the account that
// hit its limit is named, and the way on is another one.
const SWITCH = 'Switch account in Usage, then type continue.';
const SWITCH_OR_AGAIN = 'Switch account in Usage, or type continue to try again.';
// The causes a run's error may keep (lib/adapters classify).
const KNOWN = ['quota', 'rate-limit', 'auth', 'model-unavailable', 'network'];
// A last sentence that already tells the owner what to do.
const ACTION = /^(?:type|reply|start|send|sign in|run|write|update|split|commit|remove|add|review|disable|choose|pick|ask|wait|use|open|install|turn|give|enter|ignore|set|raise|approve|answer|press|in sessions|\/\w)|\bthen (?:send|type|reply)\b|\bagain\b|\bnext message\b/i;
const sentences = text => String(text ?? '').match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map(part => part.trim()).filter(Boolean) ?? [];
const clean = text => String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
const ends = text => /[.!?]$/.test(text) ? text : `${text}.`;
// The action in a few words: type continue, start a new session, or the action itself.
const shorten = action => /type continue/i.test(action) && !/,/.test(action) ? 'type continue' : action === NEW_SESSION ? 'start a new session' : action.replace(/\.$/, '').replace(/^\w/, letter => letter.toLowerCase());
const line = (why, action) => ({ text: `${ends(why)} ${action}`, action, short: shorten(action) });
const own = (text, action) => ({ text, action, short: shorten(action) });
// What a message says to do, when its last sentence says it.
function ownAction(text) {
  const last = sentences(text).at(-1);
  return last && ACTION.test(last) ? last : null;
}
// Edits that a later turn could not finish are kept as not verified, with the error: that
// session waits for the owner too.
const waits = task => Boolean(task) && (['blocked', 'stopped'].includes(task.state) || ['needs_input', 'unverified'].includes(task.state) && Boolean(task.error?.message));
// The run that failed: the one whose log the error names (a bot's, a reviewer's), else the last run.
const failedRun = (task, file) => {
  const runs = (task.runs ?? []).filter(run => run && typeof run.vendor === 'string');
  return (typeof file === 'string' && file ? runs.findLast(run => run.logFile === file) : null) ?? runs.at(-1) ?? null;
};
// Why a turn could not finish, from the last error its vendor printed: the run's log, read
// from its end. Only the kind of failure is taken from it, never its words. Kept per file
// and size, since the screen is drawn many times a second.
const READ = 64 * 1024, seen = new Map();
const KINDS = [
  // Claude stopped at the session's own /budget, which it is given as --max-budget-usd.
  ['budget', /"error_max_budget_usd"/],
  ['auth', /authenticat|not (?:signed|logged) in|log ?in required|please (?:run )?\/?login|unauthori[sz]ed|invalid (?:api|x-api) key|oauth token|\b401\b/i],
  ['quota', /out of (?:usage )?credits|credit balance is too low|usage[_ ]limit|hit your (?:session|weekly|usage) limit|insufficient_quota|billing|quota|resource_exhausted|monthly spend limit|\b402\b/i],
  ['rate-limit', /rate.?limit|too many requests|\b429\b/i],
  ['network', /econnreset|econnrefused|enotfound|etimedout|eai_again|socket hang up|fetch failed|getaddrinfo|network (?:error|is unreachable)|connection (?:error|refused|reset|closed|timed out)/i],
];
const errorOf = row => {
  if (!row || typeof row !== 'object') return null;
  if (row.type === 'result') return row.is_error || row.subtype === 'error_max_budget_usd' ? JSON.stringify([row.subtype, row.result, row.errors, row.error, row.api_error]) : '';
  if (['error', 'turn.failed'].includes(row.type)) return JSON.stringify(row.error ?? row.message ?? row);
  if (row.error && typeof row.error === 'object') return JSON.stringify(row.error);
  return null;
};
// Which limit the vendor said the account hit, from the same failure: a window of its plan
// (the session's five hours, the week), credits it has run out of, or its usage limit when it
// says no more. The reset is kept only as the vendor wrote it after "resets" or "try again",
// and only when it reads as a time: letters, digits and a few marks.
const LIMITS = [
  ['session', /hit your session limit|\b5.hour limit|five.hour limit/i],
  ['weekly', /hit your weekly limit|\bweekly limit/i],
  ['opus', /hit your opus limit/i],
  ['monthly', /monthly spend limit/i],
  ['credits', /out of (?:usage )?credits|credit balance is too low|insufficient_quota|billing|\b402\b/i],
  ['usage', /usage[_ ]limit|resource_exhausted|\bquota\b/i],
];
const RESET = /\b(resets|try again)(?: (at|in))? ([A-Za-z0-9][A-Za-z0-9 :,/+-]{0,39}?)\s*(?=[\u00b7.()"\\]|$)/i;
export function limitOf(text) {
  const said = clean(text), kind = LIMITS.find(([, pattern]) => pattern.test(said))?.[0];
  if (!kind) return null;
  const reset = kind === 'credits' ? null : said.match(RESET);
  const when = reset && /\d/.test(reset[3]) ? reset[3].replace(/[\s,]+$/, '') : null;
  return { kind, resets: when ? `resets ${reset[2]?.toLowerCase() === 'in' ? 'in ' : ''}${when}` : null };
}
function readLog(file) {
  const none = { cause: null, limit: null };
  if (typeof file !== 'string' || !file) return none;
  let stat; try { stat = fs.statSync(file); } catch { return none; }
  if (!stat.isFile()) return none;
  const key = `${stat.size}:${stat.mtimeMs}`, kept = seen.get(file);
  if (kept?.key === key) return kept.read;
  let cause = null, limit = null;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = Math.min(READ, stat.size), buffer = Buffer.alloc(size);
      fs.readSync(fd, buffer, 0, size, stat.size - size);
      // The last line that reports an outcome decides: a turn that failed and then finished is not a failure.
      for (const text of buffer.toString('utf8').split('\n').reverse()) {
        let row; try { row = JSON.parse(text); } catch { continue; }
        const said = errorOf(row);
        if (said === null) continue;
        cause = said ? KINDS.find(([, pattern]) => pattern.test(said))?.[0] ?? null : null;
        limit = cause === 'quota' ? limitOf(said) : null;
        break;
      }
    } finally { fs.closeSync(fd); }
  } catch { cause = null; limit = null; }
  const read = { cause, limit };
  if (seen.size > 200) seen.clear();
  seen.set(file, { key, read });
  return read;
}
export const logCause = file => readLog(file).cause;
// { kind, resets } for a run whose log ends at an account limit, else null.
export const logLimit = file => readLog(file).limit;
const signIn = (who, vendor, verb) => {
  const name = VENDOR_NAMES[vendor] ?? 'The model\'s command line', command = signInCommand(vendor) ?? vendor ?? 'its command';
  return line(`${who} could not ${verb}: ${name} is signed out`, SIGNS_IN_IN_ELU.includes(vendor) ? `${SIGN_IN_IN_ELU}, then type continue.` : `Sign in again with ${command}, then type continue.`);
};
// The session's own /budget, spent by the role whose run stopped. Only costs that are known
// count here: a run that failed before it said its cost is not taken as all of the limit.
function overLimit(task, run) {
  if (!Number.isFinite(task.budgetUsd)) return false;
  const spent = (task.runs ?? []).filter(row => row?.role === (run?.role ?? 'lead') && Number.isFinite(row.costUsd)).reduce((total, row) => total + row.costUsd, 0);
  return spent >= task.budgetUsd - 0.005;
}
// What a session that spent its /budget says: the limit, and how the owner raises it (runner overBudget).
function budgetLine(task, who) {
  if (!Number.isFinite(task.budgetUsd)) return line(`${who} reached its spending limit for this turn`, AGAIN);
  const limit = task.budgetUsd, dollars = `$${Number(limit.toFixed(2))}`, more = Math.min(100, Math.max(20, Math.ceil(limit * 2)));
  const spent = who === 'The model' ? `This session has spent its ${dollars} limit` : `${who} has spent its ${dollars} limit in this session`;
  return line(spent, limit >= 100 ? '/budget off removes it, then type continue.' : `/budget ${more} raises it, then type continue.`);
}
// The account a run was on, by the email its folder names here, read again at most every few
// seconds since the screen is drawn many times a second. Only this machine's own files say it:
// a run keeps the id of its account (run.login), never the email.
const accounts = new Map();
export function runAccount(run) {
  if (!LOGIN_VENDORS.includes(run?.vendor)) return null;
  const login = typeof run.login === 'string' ? run.login : DEFAULT_LOGIN, key = `${run.vendor}:${login}`, kept = accounts.get(key);
  if (kept && Date.now() - kept.at < 5000) return kept.email;
  let email = null; try { email = accountOf(run.vendor, login)?.email ?? null; } catch { email = null; }
  if (accounts.size > 50) accounts.clear();
  accounts.set(key, { at: Date.now(), email });
  return email;
}
// What an account at its limit did, in the vendor's terms. Out of usage credits only when the
// vendor said credits or billing; a limit it did not name is its usage limit.
const HIT = { session: 'hit its session limit', weekly: 'hit its weekly limit', opus: 'hit its Opus limit', monthly: 'hit its monthly spend limit', usage: 'hit its usage limit', credits: 'is out of usage credits' };
// The why for a known cause of a turn that could not finish, and the one thing to do.
// account: the email of the account the run was on, when this machine can name it.
// limit: which limit, and when it resets, as the run's log says (logLimit).
function causeLine(cause, who, vendor, account = null, limit = null) {
  const several = LOGIN_VENDORS.includes(vendor), named = account ?? 'the account';
  const hit = `${HIT[limit?.kind] ?? HIT.usage}${limit?.resets ? ` (${limit.resets})` : ''}`;
  if (cause === 'quota') return several ? line(`${who} could not finish: ${named} ${hit}`, SWITCH) : line(`${who} could not finish: the account ${hit}`, AGAIN);
  if (cause === 'rate-limit') return several ? line(`${who} could not finish: ${named} hit its rate limit`, SWITCH_OR_AGAIN) : line(`${who} could not finish: the account hit its rate limit`, AGAIN);
  if (cause === 'network') return line(`${who} could not finish: the connection dropped`, AGAIN);
  if (cause === 'model-unavailable') return line(`${who} could not finish: that model is not available`, MODEL);
  if (cause === 'auth') return signIn(who, vendor, 'finish');
  return null;
}
// Work that cannot go on in this session: published, its policy changed, or its Git folder
// is no longer safe to work in.
function cannotGoOn(reason) {
  const text = clean(reason);
  if (/cannot be continued/i.test(text)) return line('This work is published, so it cannot go on here', NEW_SESSION);
  if (/policy changed/i.test(text)) return line('The task policy changed', NEW_SESSION);
  if (/filesystem monitor/i.test(text)) return line('Git\'s filesystem monitor is on, and it can run programs', 'Turn it off with git config core.fsmonitor false, then type continue.');
  // Every new session in this repository is refused the same way, so a new one is no way out.
  const driver = text.match(/^Git attribute ([\w.-]{1,40})=([\w.-]{1,80}) enables an executable driver/i);
  if (driver) return line(`Git runs a program for the ${driver[1]}=${driver[2]} attribute in this repository`, `Remove ${driver[1]}.${driver[2]} from Git's config, then type continue.`);
  if (/^Submodules are not supported/i.test(text)) return line('ELU cannot edit a repository that has submodules', 'Ask about it here instead.');
  // A new session starts from the hooks as they are now, so they are looked at first.
  if (/^Git hooks changed/i.test(text)) return line(sentences(text)[0], 'Review the hooks, then start a new session with /new.');
  if (/saved hooks are missing or changed|editing workspace already exists/i.test(text)) return line(sentences(text)[0], NEW_SESSION);
  return null;
}
// An error after the agent's edit, while ELU checks it or its bots review it, said as
// the line the chat shows: the edits are kept, why the checks and review could not go on in
// plain words, and what to do. Never a raw path or a system error: those read as a file of
// the editing workspace that could not be read. null where the stop line already says it
// well: a vendor's run that could not finish or run, a stop or a limit, and work that cannot
// go on in this session.
const ARTICLE = /^(?:The|A|An|This|That|No|Only|Some|One)\b/;
export function loopStopMessage(error) {
  const message = clean(error?.message), details = error?.details && typeof error.details === 'object' ? error.details : {};
  if (details.vendorSaid || details.timedOut === true || details.outputLimit === true || ['quiet', 'cap'].includes(details.stoppedBy)) return null;
  if (message && (/ could not (?:finish|run)\b|^Stopped\b|is not installed or not on your PATH/i.test(message) || cannotGoOn(message))) return null;
  const raw = !message || typeof error?.code === 'string' || /(?:^|[\s:'"(])(?:\/|~\/|[A-Za-z]:\\)[^\s]*[\/\\]/.test(message) || /^Refusing a symbolic link|not a regular file|too large to inspect/i.test(message);
  const said = raw ? [] : sentences(message);
  const first = said[0]?.replace(/[.!?]+$/, '') ?? '';
  const reason = raw || !first ? 'a file in the editing workspace could not be read' : ARTICLE.test(first) ? first.replace(/^\w/, letter => letter.toLowerCase()) : first;
  const action = said.length > 1 && ACTION.test(said.at(-1)) ? said.at(-1) : AGAIN;
  return `Your edits are kept, but the checks and review could not go on: ${reason}. ${action}`;
}
// A reply to a session whose work could not go on ends with why (runner STUCK_LINE).
const STUCK = 'The work could not go on: ';
function stuckReason(task) {
  const summary = String((task.reply ?? task.result)?.summary ?? ''), at = summary.lastIndexOf(STUCK);
  return at < 0 ? null : summary.slice(at + STUCK.length);
}
// Returns { text, action, short }, or null for a session that is not waiting because it
// stopped. short: the action in a few words, for a row of the Sessions list.
// logCause, logLimit: how the run's log is read, for a test.
export function stopLine(task, { logCause: readCause = logCause, logLimit: readLimit = logLimit, account = runAccount } = {}) {
  if (!waits(task)) return null;
  const error = task.error && typeof task.error === 'object' ? task.error : null, message = clean(error?.message);
  const edits = task.kind !== 'conversation', kept = edits ? ' Your changes are kept.' : '';
  const stopped = own(`Stopped before it finished.${kept} ${CARRY_ON}`, CARRY_ON);
  if (!message) {
    const stuck = stuckReason(task);
    if (stuck) return cannotGoOn(stuck) ?? line(sentences(stuck)[0] ?? 'The work could not go on', NEW_SESSION);
    if (task.reviewStatus === 'blocked') return line('The review still asks for fixes', 'Type continue to work on them.');
    if (task.evidence?.results?.some(row => row?.status !== 'passed')) return line('The checks did not pass', 'Type continue to fix them.');
    return stopped;
  }
  // A limit stopped the turn. The line it was stopped with says so and what to do; one from
  // before that line existed, or from a vendor that reports only that it could not finish,
  // gets it here.
  if (error.timedOut === true || ['quiet', 'cap'].includes(error.stoppedBy)) {
    const said = /^Stopped after\b/.test(message) && ownAction(message);
    return said ? own(message, said) : stopped;
  }
  const failed = message.match(/^(.{1,60}?) could not (finish|run)\b/), who = failed?.[1] ?? 'The model';
  if (error.outputLimit === true) return line(`${who} wrote more output than one turn may keep`, NEW_SESSION);
  const blocked = cannotGoOn(message);
  if (blocked) return blocked;
  if (/^Stopped by the owner\.?$/i.test(message) || task.state === 'stopped' && /\baborted\b/i.test(message)) return own(`You stopped it.${kept} ${CARRY_ON}`, CARRY_ON);
  if (/\bRetry to continue\.?$/i.test(message)) return line(message.replace(/\s*Retry to continue\.?$/i, ''), CARRY_ON);
  if (/must-fix finding/i.test(message)) return line(message, 'Type continue to work on them.');
  // A vendor that refused the run (could not run) said why in its own words; they stay, with
  // the action for the cause after them. Its own advice, such as a command of its own app, is
  // not the owner's action here.
  if (failed?.[2] === 'run' || failed && !ownAction(message)) {
    const run = failedRun(task, error.logFile), stored = KNOWN.includes(error.cause) ? error.cause : null;
    // Claude counts the session's /budget running out as quota, so the log is read for it.
    const logged = stored && stored !== 'quota' ? null : readCause(error.logFile);
    const cause = logged === 'budget' || (stored ?? logged) === 'quota' && overLimit(task, run) ? 'budget' : stored ?? logged;
    if (cause === 'budget') return budgetLine(task, who);
    if (failed[2] === 'run') return cause === 'auth' ? signIn(who, run?.vendor, 'run') : line(message, cause === 'model-unavailable' ? MODEL : AGAIN);
    return causeLine(cause, who, run?.vendor, ['quota', 'rate-limit'].includes(cause) && LOGIN_VENDORS.includes(run?.vendor) ? account(run) : null, cause === 'quota' ? readLimit(error.logFile) : null) ?? line(message, AGAIN);
  }
  if (/is not installed or not on your PATH\.?$/i.test(message)) return line(message, 'Install it, then type continue.');
  const said = ownAction(message);
  return said ? own(message, said) : line(message, AGAIN);
}
