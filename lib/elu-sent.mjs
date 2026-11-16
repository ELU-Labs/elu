// The messages ELU itself sends a session, with no model call before them: that its long jobs
// ended (lib/long-work.mjs), and that its Task's objectives are not all met while nothing runs
// (lib/keep-going.mjs). Each goes to the session's working agent as a message waits in its
// queue, says in its own words that ELU sent it, and reads in the chat as one line of ELU's
// (eluLine), never as the owner's. They are known by their text, as the line an earlier
// version's time limit left is (lib/carry-on.mjs): an earlier ELU that reads one shows the
// text, which says who sent it.
import { dataBlock } from './util.mjs';
import { endedSentence, lastLines } from './jobs.mjs';

const NOT_OWNER = '(ELU sent this, not the owner.)';
// The words of the keep-going check, as the owner asked for them: they name him, so they read as ELU's.
export const KEEP_GOING_ASK = "The Task's objectives are not all met and nothing is running. Carry on, or say exactly what you need from the owner.";
export const KEEP_GOING_TEXT = KEEP_GOING_ASK;
export const KEEP_GOING_LINE = 'ELU told it to carry on: its Task\'s objectives are not all met and nothing was running.';
// Why a session ELU stopped starting by itself waits for the owner (lib/keep-going.mjs), here and on his other computer.
export const STOPPED_LINE = 'ELU stopped starting this session: its last two turns made no progress. Your next message starts it again.';
const JOBS_HEAD = /^ELU: (?:a job|[0-9]+ jobs) of this session ended\. \(ELU sent this, not the owner\.\)\n/;
// One message for the jobs of a session that ended close together: each by its name, its exit
// code, how long it ran and where its log is, then the end of that log, as data.
export function jobsEndedText(jobs) {
  const head = `ELU: ${jobs.length === 1 ? 'a job' : `${jobs.length} jobs`} of this session ended. ${NOT_OWNER}`;
  const parts = jobs.map(job => {
    const lines = lastLines(job.log);
    return [endedSentence(job), `Its log: ${job.log}`, lines.length ? dataBlock(`Last lines of ${job.name}`, { lines }) : 'It printed nothing.'].join('\n');
  });
  return [head, ...parts].join('\n\n');
}
export const sentByElu = text => typeof text === 'string' && (text === KEEP_GOING_TEXT || JOBS_HEAD.test(text));
// The one line the chat shows for such a message, or null for any other text.
export function eluLine(text) {
  if (typeof text !== 'string') return null;
  if (text === KEEP_GOING_TEXT) return KEEP_GOING_LINE;
  if (!JOBS_HEAD.test(text)) return null;
  const said = text.split('\n').filter(line => /^Job [A-Za-z0-9][A-Za-z0-9._-]* /.test(line));
  return `${said.join(' ') || 'A job of this session ended.'} ELU told the session.`;
}
// What a turn at work reads before such a message when it takes it (lib/runner.mjs inboxFeed).
export const DURING_ELU = 'ELU, not the owner, sent you the message below while you were working on this turn. Take it into account now, in this same turn. Your final JSON reply answers the owner as before.';
export const duringElu = text => `${DURING_ELU}\n\n${text}`;
