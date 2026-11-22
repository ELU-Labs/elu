// The messages ELU itself sends a session, with no model call before them: that its long jobs
// ended (lib/long-work.mjs), and that its Task's objectives are not all met while nothing runs
// (lib/keep-going.mjs). Each goes to the session's working agent as a message waits in its
// queue, says in its own words that ELU sent it, and reads in the chat as one line of ELU's
// (eluLine), never as the owner's. They are known by their text, as the line an earlier
// version's time limit left is (lib/carry-on.mjs): an earlier ELU that reads one shows the
// text, which says who sent it.
import { dataBlock } from './util.mjs';
import { endedSentence, lastLines } from './jobs.mjs';
import { CAP_CARRY_TEXT } from './turn-limits.mjs';

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
// The Orchestrator's wake at Full (lib/orchestrator-wake.mjs): what changed in the owner's
// sessions since its last look, sent into its own chat. It names ELU, never the owner.
export const WAKE_HEAD = count => `ELU: ${count === 1 ? 'a session' : `${count} sessions`} of the owner's changed. ${NOT_OWNER}`;
const WAKE_LINE = /^ELU: (a session|[0-9]+ sessions) of the owner's changed\. \(ELU sent this, not the owner\.\)(?:\n|$)/;
// A session's lead asks one of its bots (elu sessions ask, lib/session-commands.mjs): the bot's
// turn runs on it after the lead's turn, and its answer goes back to the lead in its next turn
// (LEAD_BACK). Both name ELU and the lead, never the owner.
const BOT = '([a-z][a-z0-9-]{0,31})';
export const LEAD_ASK_HEAD = bot => `ELU: this session's lead asks @${bot}. ${NOT_OWNER}`;
const LEAD_ASK = new RegExp(`^ELU: this session's lead asks @${BOT}\\. \\(ELU sent this, not the owner\\.\\)\\n\\n([\\s\\S]+)$`);
export const leadAskText = (bot, text) => `${LEAD_ASK_HEAD(bot)}\n\n${text}`;
// { bot, text } of such a message, or null.
export function leadAsked(text) { const found = typeof text === 'string' ? LEAD_ASK.exec(text) : null; return found ? { bot: found[1], text: found[2] } : null; }
export const LEAD_BACK_HEAD = bot => `ELU: @${bot} answered what you asked it. ${NOT_OWNER}`;
const LEAD_BACK = new RegExp(`^ELU: @${BOT} answered what you asked it\\. \\(ELU sent this, not the owner\\.\\)(?:\\n|$)`);
export const leadBackText = (bot, answer) => [LEAD_BACK_HEAD(bot), dataBlock(`Answer of @${bot}`, answer || '(It answered nothing.)'), 'Take its answer into account and go on with the work.'].join('\n\n');
// The session's bots reviewed a pull request it opened or updated, or its change while a long
// turn worked (lib/runner.mjs sweepPulls), and what they found, or why one could not review,
// goes to the lead, as a message of ELU's. Each review is a block labelled with what it was of:
// "Review of PR #7 by @pair", "Review of your change at abc1234 by @pair".
export const REVIEWS_HEAD = "ELU: the session's bots reviewed its work. (ELU sent this, not the owner.)";
const REVIEWS = /^ELU: the session's bots reviewed its work\. \(ELU sent this, not the owner\.\)(?:\n|$)/;
export const REVIEWS_TAIL = 'Each block is one bot\'s review, of the pull request or the change its label names, at the head commit it names. Fix or dispute each must_fix finding where that work is (a pull request\'s own branch), push it, and say in your reply what you did with each: ELU reviews a pull request again when its head moves. A bot that could not review is named in its block with why: say so where you report that work.';
export const reviewsText = items => [REVIEWS_HEAD, ...items.map(item => dataBlock(item.label, item.value)), REVIEWS_TAIL].join('\n\n');
export const sentByElu = text => typeof text === 'string' && (text === KEEP_GOING_TEXT || JOBS_HEAD.test(text) || WAKE_LINE.test(text) || LEAD_ASK.test(text) || LEAD_BACK.test(text) || REVIEWS.test(text));
// The one line the chat shows for such a message, or null for any other text.
export function eluLine(text) {
  if (typeof text !== 'string') return null;
  if (text === KEEP_GOING_TEXT) return KEEP_GOING_LINE;
  const woke = WAKE_LINE.exec(text);
  if (woke) return `ELU woke it: ${woke[1]} of yours changed.`;
  const asked = leadAsked(text);
  if (asked) { const line = asked.text.split('\n').find(value => value.trim())?.trim() ?? ''; return `The lead asked @${asked.bot}: ${line.length > 160 ? `${line.slice(0, 159)}…` : line}`; }
  const back = LEAD_BACK.exec(text);
  if (back) return `ELU gave the lead @${back[1]}'s answer.`;
  if (REVIEWS.test(text)) {
    const of = [...new Set([...text.matchAll(/^Review of (PR #[0-9]+|your change at [0-9a-f]{7})/gm)].map(match => match[1]))];
    return `ELU gave the lead the bots' review of ${of.length ? of.length > 1 ? `${of.slice(0, -1).join(', ')} and ${of.at(-1)}` : of[0] : 'its work'}.`;
  }
  if (!JOBS_HEAD.test(text)) return null;
  const said = text.split('\n').filter(line => /^Job [A-Za-z0-9][A-Za-z0-9._-]* /.test(line));
  return `${said.join(' ') || 'A job of this session ended.'} ELU told the session.`;
}
// Every text ELU sends a session by itself, one row a kind: is(text) tells it. The first two
// are the ones above, which the chat shows as one line of ELU's (sentByElu, eluLine), with the
// Orchestrator's wake (WAKE_HEAD) beside them. The
// others are shown as they always were, each by the file that sends it: the line an earlier
// version's time limit left (lib/carry-on.mjs), a helper's automatic turn
// (lib/remote-helper.mjs AUTO_TEXT) and the continuation after a session's mode was raised
// (lib/terminal.mjs). They are listed here so that whoever must tell the owner's own words
// from ELU's (Auto model, lib/auto-model.mjs) asks in one place. sentByElu stays those three:
// what it answers decides how the chat draws a message.
const HELPER_TURN = /\(Automatic turn \d+ of \d+: the owner did not write this\.\)$/;
const MODE_CONTINUE = /^Continue where you stopped: this session now has [A-Za-z ]{1,40}\. Try again only this: /;
export const ELU_TEXTS = Object.freeze([
  Object.freeze({ id: 'keep-going', is: text => text === KEEP_GOING_TEXT }),
  Object.freeze({ id: 'jobs-ended', is: text => JOBS_HEAD.test(text) }),
  Object.freeze({ id: 'orchestrator-wake', is: text => WAKE_LINE.test(text) }),
  Object.freeze({ id: 'lead-asks-bot', is: text => LEAD_ASK.test(text) }),
  Object.freeze({ id: 'bot-answered-lead', is: text => LEAD_BACK.test(text) }),
  Object.freeze({ id: 'bots-reviewed', is: text => REVIEWS.test(text) }),
  Object.freeze({ id: 'carry-on', is: text => text === CAP_CARRY_TEXT }),
  Object.freeze({ id: 'helper-turn', is: text => HELPER_TURN.test(text) }),
  Object.freeze({ id: 'mode-continue', is: text => MODE_CONTINUE.test(text) }),
]);
// Whether ELU wrote this text, whichever of those it is.
export const writtenByElu = text => typeof text === 'string' && ELU_TEXTS.some(row => row.is(text));
// What a turn at work reads before such a message when it takes it (lib/runner.mjs inboxFeed).
export const DURING_ELU = 'ELU, not the owner, sent you the message below while you were working on this turn. Take it into account now, in this same turn. Your final JSON reply answers the owner as before.';
export const duringElu = text => `${DURING_ELU}\n\n${text}`;
