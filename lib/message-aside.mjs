// A message the owner sends to a session while its turn works. A turn that takes messages
// (Claude Code; Codex through its app-server, lib/codex-live.mjs) reads it at its next step.
// A turn that cannot (a vendor that reads its prompt to the end and nothing more) is not made
// to: the message is answered at once beside that turn, by a short read-only run on the
// session's own model that is given the chat and every step the turn has taken so far
// (lib/runner.mjs runMessageAside; the conductor starts it, lib/conductor.mjs answerBeside).
// That run also says what the message is. One that only asks for information is answered and
// done: the chat keeps the message and the answer, and the session's next turn reads both.
// One that asks for work, or to change course, still starts the next turn when this one ends,
// and Enter in the empty box sends it now by stopping the turn.
//
// The request carries what the chat shows while it waits (aside): { state: 'running' } while
// the answer is written, { state: 'answered', kind, text, who } once it is in, { state:
// 'failed', error } when it could not be written. The answer and the run that wrote it are
// kept in a folder of their own under the session's, aside/<request id>/answer.json, because
// the turn holds the session's record; they join the record once no turn holds it (foldAsides).
import fs from 'node:fs';
import path from 'node:path';
import { atomic, isObject, noSymlinks, readJson } from './util.mjs';
import { lock, readTask, saveTask, taskDir } from './state.mjs';

export const ASIDE_ANSWERED = 'Answered beside the running turn, from what it has done so far. The turn goes on.';
export const ASIDE_RUNNING = 'Being answered now, beside the running turn.';
export const ASIDE_WORK = 'It asks for work, so it also starts the next turn when this one ends.';
// What sending it now costs, where the turn must stop for it.
export const STOPS_TURN = 'that stops the turn and the command that is running';
export const STOPS_COMMAND = 'that stops the command that is running';
const REQUEST = /^[A-Za-z0-9_-]{1,80}$/, WORKING = ['running', 'preparing'];

// What the run beside the turn is told.
export function asideInstructions() {
  return ['The owner sent this session a message while it is in the middle of a turn. You are not that turn: you run beside it, read-only, and it goes on.',
    'The context holds the session\'s chat (messages), under working its Task and every step the turn has taken so far, newest last (working.checks, when it is there, says the project\'s checks are running in place of a turn), and under message what the owner just wrote.',
    'Answer his message now from them, in at most 8 short lines, in his language: what he asked, as far as the chat and those steps show it; say so when they do not.',
    'Then say what kind of message it is. Set intent to answer when it only asks for information. Set intent to edit when it asks this session to do something, to change something, or to change what the turn is doing; then say in your answer what the turn is doing now and that the message starts when that turn ends, and do none of the work yourself. Set repository to an empty text.',
    'This run only answers. Change nothing and run nothing that writes. Do not start, continue or approve any edit or Task. Set outcome to done.',
  ].join(' ');
}
export const asideSide = (repo, id, request) => path.join(taskDir(repo, id), 'aside', request);
const answerFile = (repo, id, request) => path.join(asideSide(repo, id, request), 'answer.json');
export function saveAside(repo, id, row) { if (REQUEST.test(row?.request ?? '')) atomic(answerFile(repo, id, row.request), row); }
// Every answer kept beside the session's record, oldest first.
export function readAsides(repo, id) {
  let names = [];
  try { const dir = path.join(taskDir(repo, id), 'aside'); noSymlinks(dir); names = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => REQUEST.test(name)) : []; } catch { return []; }
  const rows = [];
  for (const name of names) { try { const file = answerFile(repo, id, name); noSymlinks(file); if (!fs.existsSync(file)) continue; const row = readJson(file); if (isObject(row) && row.request === name && typeof row.text === 'string') rows.push(row); } catch { /* Not one of them. */ } }
  return rows.sort((a, b) => Date.parse(a.askedAt ?? a.at ?? 0) - Date.parse(b.askedAt ?? b.at ?? 0));
}
// What the chat shows of a message that was answered beside a turn and is done: his message,
// the answer under the name of what wrote it, and one line that says where it came from.
export function asideRows(row) {
  return [
    { at: row.askedAt ?? row.at, text: row.message, ...(row.bot ? { to: `@${row.bot}` } : {}), aside: row.request },
    { at: row.at, text: row.text, from: `${row.who} · beside the turn`, update: true, aside: row.request },
    { at: row.at, text: ASIDE_ANSWERED, from: 'ELU', line: true, aside: row.request },
  ];
}
// shown: its message is done and its rows belong in the chat (a message that asks for work
// shows under its waiting row instead, and then as the next turn's own).
const shown = row => row.kind === 'question' && row.shown !== false;
// The rows of answers the session's record does not hold yet, for a chat read while its turn works.
export const asideWaiting = (repo, id) => readAsides(repo, id).filter(row => !row.folded && shown(row)).flatMap(asideRows);
// Takes every answer given beside a turn into the session's own record, each once: its rows
// in the chat, and its run, kept apart as a standup's are (standup), so nothing takes it for
// a turn of the session. Only while no turn holds the session. Returns how many it took.
export function foldAsides(repo, id) {
  const waiting = readAsides(repo, id).filter(row => !row.folded);
  if (!waiting.length) return 0;
  let release; try { release = lock(repo, `task-${id}`); } catch { return 0; }
  try {
    const task = readTask(repo, id);
    if (WORKING.includes(task.state) && !task.standupTurn) return 0;
    for (const row of waiting) {
      if (shown(row) && !(task.messages ?? []).some(value => value.aside === row.request)) (task.messages ??= []).push(...asideRows(row));
      task.runs = [...(task.runs ?? []), ...(row.runs ?? []).map(run => ({ ...run, standup: 'aside', aside: row.request }))];
      saveTask(repo, task); saveAside(repo, id, { ...row, folded: true });
    }
    return waiting.length;
  } catch { return 0; }
  finally { release(); }
}
// What the chat says under a message of the owner's that has not run yet while its session
// works, in plain words: what happens to it and when, and the keys. It never says only that
// the message waits. goes: the running turn takes it. deaf: that turn takes none, so it is
// answered beside it. soon: the turn has not said yet which of the two it is, in its first
// moments. stops: sending it now stops the command the turn is running. there:
// the computer the session runs on (@name), when it is another one. enter: Enter in the empty
// box sends it now from here; readOnly: Up does not take it back from here.
// Returns { tag, lines, keys, answer }: tag goes in the row's title; answer is what the run
// beside the turn said, to show under the message, when the message still starts a turn.
export function waitingWords(row, { working = false, goes = false, deaf = false, soon = false, stops = false, readOnly = false, enter = true, model = 'The model', there = '' } = {}) {
  const aside = isObject(row.aside) ? row.aside : null, on = there ? ` on ${there}` : '', turn = `the running turn${on}`;
  const join = (...parts) => parts.filter(Boolean).join(' · ') || null;
  const back = readOnly ? null : '↑ takes it back';
  const stopsTurn = join(enter ? `Enter in the empty box sends it now: ${there ? `that stops the turn${on} and the command that is running` : STOPS_TURN}` : null, back);
  const goesNow = join(enter ? `Enter${there ? ' in the empty box' : ''} sends it now${stops ? `: ${STOPS_COMMAND}` : ''}` : null, back);
  const ends = `It starts when ${turn} ends.`;
  if (row.state === 'starting') return { tag: 'starting', lines: [`Starting${on}.`], keys: null, answer: null };
  if (!working) return { tag: 'starts next', lines: [row.reason && !/^Waiting to start\.?$/.test(row.reason) ? row.reason : `Starts next${on}.`], keys: readOnly ? null : '↑ in the message box takes it back', answer: null };
  if (goes && row.turn) {
    if (row.now) return { tag: 'being sent now', lines: [row.reason ?? 'Sending it now.'], keys: null, answer: null };
    if (row.fixed) return { tag: 'read at the turn\'s next step', lines: [`${turn[0].toUpperCase()}${turn.slice(1)} has it and reads it at its next step.`], keys: null, answer: null };
    return { tag: 'read when the running command ends', lines: [`${turn[0].toUpperCase()}${turn.slice(1)} reads it when the command it is running ends.`], keys: goesNow, answer: null };
  }
  if (goes) return { tag: 'going to the running turn', lines: [`Going to ${turn}, which reads it at its next step.`], keys: goesNow, answer: null };
  if (aside?.state === 'running') return { tag: 'being answered now', lines: [ASIDE_RUNNING], keys: stopsTurn, answer: null };
  if (aside?.state === 'answered') return { tag: 'answered · starts when this turn ends', lines: [ASIDE_ANSWERED, ASIDE_WORK], keys: stopsTurn, answer: { who: aside.who ?? model, text: String(aside.text ?? ''), at: aside.at ?? null } };
  if (aside?.state === 'failed') return { tag: 'starts when this turn ends', lines: [`Could not be answered beside the turn: ${String(aside.error ?? 'no answer came.')}`, ends], keys: stopsTurn, answer: null };
  // A turn that takes no message: it is answered beside the turn in a moment.
  if (deaf) return { tag: 'answered in a moment', lines: [`${turn[0].toUpperCase()}${turn.slice(1)} takes no message while it works, so this is answered beside it in a moment.`], keys: stopsTurn, answer: null };
  if (soon) return { tag: 'read or answered in a moment', lines: [`${turn[0].toUpperCase()}${turn.slice(1)} reads it at its next step, or it is answered beside the turn.`], keys: stopsTurn, answer: null };
  return { tag: 'starts when this turn ends', lines: [ends], keys: stopsTurn, answer: null };
}
// The same in one line, for the status line under the chat once the message is sent.
export function sentWords({ goes = false, deaf = false, soon = false, there = '' } = {}) {
  const turn = `${there ? 'Its' : 'The'} running turn`;
  return goes ? `${turn} reads it at its next step.` : deaf ? `${turn} takes no message while it works, so it is answered beside it now.`
    : soon ? `${turn} reads it at its next step, or it is answered beside the turn.` : `It starts when ${there ? 'its' : 'the'} running turn ends.`;
}
