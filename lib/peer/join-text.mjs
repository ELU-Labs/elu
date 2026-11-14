// What a join says while it waits and when it gives up, in one place for the app, the shell
// and the daemon. Kept free of files and networking, like invite-code.mjs.
// A join looks for the inviter for a minute. Once their computer is found it keeps trying
// to connect for CONNECT_MS in all: a network that gives every connection a new port lets
// one try through every 20 seconds or so, and a try can take 35.
import { columns, cut, head as first } from '../width.mjs';
export const CONNECT_MS = 180000;
export const NOT_FOUND = 'Nobody answered for this code. Their ELU is closed or offline, or the code was already used or is older than 24 h. Ask them to open ELU and send a new code with /invite.';
export const OFFLINE = 'This computer is not connected to the network, so it cannot look for them. Check your internet connection, then join again.';
export const CANCELLED = 'Join cancelled. You did not join.';
export const NO_ANSWER = 'Found their computer, but it did not answer. It may have gone to sleep or closed ELU. Ask them to keep ELU open, then join again.';
// The kinds of network hyperdht tells apart: 3 gives every connection a new port.
const RANDOM = 3;
const why = (theirs, mine) => theirs === RANDOM && mine === RANDOM ? 'both networks give every connection a new port'
  : theirs === RANDOM ? 'their network gives every connection a new port, as a phone hotspot does'
  : mine === RANDOM ? 'your network gives every connection a new port, as a phone hotspot does'
  : 'the networks between you blocked it';
// Found, but no way through: why, whether another computer was tried, and what works.
// theirs and mine are the two networks' kinds; tried names the computers asked to pass it along.
export function noRoute({ theirs = null, mine = null, tried = [] } = {}) {
  const names = [...new Set(tried)], listed = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  const passed = names.length ? `${listed[0].toUpperCase()}${listed.slice(1)} could not pass it along either.` : 'No other computer was online to pass it along.';
  return `Found their computer, but could not connect: ${why(theirs, mine)}. ${passed} Join again from another network, or while ELU is open on another computer on your team or theirs.`;
}
// The line that counts while a join waits. progress is what the daemon says it is doing
// ({stage, via}); with none it is still looking. cancel names the key that stops it.
// width: a shell redraws the line in place, so it must fit one row, or the row it wrapped
// from stays behind. Too long, it first drops what the search needs, then is cut.
export function joinWait(progress, seconds, cancel, width = Infinity) {
  const stage = progress?.stage, named = typeof progress?.via === 'string' && progress.via ? progress.via : 'another computer', via = cut(named, 28);
  const head = stage === 'relay' ? `Found them. Connecting through ${via}…`
    : stage === 'retrying' ? 'Found them, but could not connect yet. Trying again…'
    : stage === 'connecting' ? 'Found them. Connecting…'
    : 'Looking for the person who invited you…';
  const whole = `${head} ${seconds} s.${head.startsWith('Looking') ? ' Their ELU must be open.' : ''} ${cancel} cancels.`, text = columns(whole) <= width ? whole : `${head} ${seconds} s. ${cancel} cancels.`;
  return columns(text) <= width ? text : `${first(text, Math.max(0, width - 1)).replace(/[…\s]+$/, '')}…`;
}
