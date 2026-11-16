import fs from 'node:fs';
import path from 'node:path';
import { atomic, isObject, noSymlinks, readJson } from '../util.mjs';
import { tasks } from '../state.mjs';
import { projectFolder } from '../workspace.mjs';
import { registeredProjects, savedProjectName } from '../projects.mjs';
import { SAVED, SAVED_BEFORE, learnedKey } from '../project-learnings.mjs';
import { notesAgreed, putBackContext, splitContext } from '../project-notes.mjs';
import { readProjectSettings } from '../project-settings.mjs';
import { peerFile } from './paths.mjs';
import { teams } from './roster.mjs';
import { shares, sharedWith } from './shares.mjs';
import { bothMine, mineRows } from './mine.mjs';
import { sharedRoots, teamFolder } from './project-share.mjs';

// What ELU 0.1.29 mixed, put back once (docs/peer-network.md, "A shared project"). 0.1.29 made
// the project shared last a team's project, so a /share or an invite in another folder had that
// folder trade instructions, context and lessons with the teammates' folders of the team's
// first project, which passed them on to the first one when 0.1.30 put it back. What shows it
// here: a folder shared with the team that is not its first project, which traded them with a
// teammate's computer it is not shared with now, as the first project did (project-notes.json).
// Only a computer that was never the owner's shows it: one of his traded every project, from
// before 0.1.29 on, so one that is not his any more (unmarked, unpaired, or off the team) says
// nothing. Never his: no mark here either way (mine.mjs), and its notes came as a teammate's.
// Before 0.1.29 a teammate's computer traded none.
//
// For each such two, a lesson that a session of one saved ("Saved to memory", "Saved to project context" up to 0.1.30) and no
// session of the other did is that one's, and is taken out of the other. One that is not there
// yet is kept out of it only when another computer's copy of it has the lesson (held), so it
// does not come back from there; a lesson nobody else has is never written into the other.
// Taken out, it goes from the teammates' folders too, as any lesson the owner takes out does.
// Everything else stays: his text is never taken out on a guess. When anything there may still be the other
// project's (a lesson no session here saved, or the same instructions or text as the other
// has), one plain line at the end of his text in the context says so.
//
// peer/notes/put-back.json: { at }, once it ran on this computer.
const doneFile = () => peerFile('notes', 'put-back.json');
const same = (a, b) => path.resolve(a) === path.resolve(b);

// The lessons the sessions of the project at root saved: key → the line its context has, or the
// learning as the session said it.
function learnedIn(root) {
  const keys = new Map(), lines = new Map(splitContext(readProjectSettings(root).context).learned.map(item => [item.key, item.line]));
  let list = []; try { list = tasks(projectFolder(root)); } catch { list = []; }
  for (const task of list) for (const message of Array.isArray(task?.messages) ? task.messages : []) {
    if (message?.learned !== true || typeof message.text !== 'string') continue;
    for (const line of message.text.split('\n')) { const said = [SAVED, SAVED_BEFORE].find(start => line.startsWith(start)); if (!said) continue; const text = line.slice(said.length).trim(), key = learnedKey(text); if (key && !keys.has(key)) keys.set(key, lines.get(key) ?? `- ${text}`); }
  }
  return keys;
}
// Whether the computer key sent its notes last as a teammate's (notes.mjs takeNotes).
function sentAsTeammate(key) {
  try { const file = peerFile('notes', 'from', `${key}.json`); noSymlinks(file); if (!fs.existsSync(file)) return false; const value = readJson(file); return isObject(value) && value.key === key && value.theirs === true; } catch { return false; }
}
// Every two projects here that 0.1.29 mixed, [first, other], the first the team's.
function mixedPairs(me) {
  const roots = registeredProjects().map(repo => repo.root), known = root => root ? roots.find(item => same(item, root)) ?? null : null, pairs = [];
  const marked = new Set(mineRows().map(row => row.key)), never = key => key !== me && !bothMine(me, key) && !marked.has(key) && sentAsTeammate(key);
  for (const state of teams()) {
    if (!state.members.some(member => member.key === me && !member.removed)) continue;
    const first = known(teamFolder(state.id)); if (!first) continue;
    const keys = state.members.filter(member => !member.removed).map(member => member.key).filter(never), traded = new Set(notesAgreed(first));
    for (const row of shares()) {
      const other = known(row.root);
      if (!other || same(other, first) || !sharedWith(row, [state.id]) || pairs.some(([a, b]) => same(a, first) && same(b, other))) continue;
      const tradedThere = new Set(notesAgreed(other));
      if (keys.some(key => traded.has(key) && tradedThere.has(key) && ![...sharedRoots(me, key).keys()].some(root => same(root, other)))) pairs.push([first, other]);
    }
  }
  return pairs;
}
const nameOf = root => savedProjectName(root) ?? path.basename(root);
const names = list => list.length < 3 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
// The line the context gets.
export const putBackNote = others => `ELU 0.1.29 mixed this project with ${names(others)}. Lessons learned in a session were put back where they belong; check the rest, and the instructions, for anything that belongs to ${names(others)}.`;

// Once on this computer, before notes are traded: the lessons put back. held(root): the keys of
// the lessons the other computers' copies of the project at root have, as they said last
// (notes.mjs). Returns the lines the app says once, one for each project lessons were taken out of.
export function putBackMixed({ me, log = () => {}, now = Date.now(), held = () => new Set() } = {}) {
  try { noSymlinks(doneFile()); if (fs.existsSync(doneFile())) return []; } catch { return []; }
  const said = [];
  try {
    const pairs = mixedPairs(me), partners = new Map();
    for (const [a, b] of pairs) for (const [one, two] of [[a, b], [b, a]]) partners.set(one, [...partners.get(one) ?? [], two]);
    // What each has, read before any of them changes.
    const learned = new Map([...partners.keys()].map(root => [root, learnedIn(root)])), had = new Map([...partners.keys()].map(root => [root, readProjectSettings(root)]));
    const ownText = root => splitContext(had.get(root).context).own;
    for (const [root, others] of partners) {
      try {
        // Each lesson a session of the other saved and none of this one did: taken out here, or,
        // when it is not here but another computer's copy has it, kept out, so it does not come back from there.
        const own = learned.get(root), settings = had.get(root), lines = splitContext(settings.context).learned, here = new Set(lines.map(item => item.key)), there = held(root);
        const remove = [...new Map(others.flatMap(other => [...learned.get(other)]).filter(([key]) => !own.has(key) && (here.has(key) || there.has(key)))).entries()].map(([key, line]) => ({ key, line }));
        const out = new Set(remove.map(item => item.key)), unsure = lines.some(item => !own.has(item.key) && !out.has(item.key));
        const alike = others.some(other => settings.instructions.trim() && had.get(other).instructions === settings.instructions || ownText(root).trim() && ownText(other) === ownText(root));
        const otherNames = others.map(nameOf), taken = putBackContext(root, { remove, note: unsure || alike ? putBackNote(otherNames) : null, now });
        if (taken.length) said.push(`${taken.length === 1 ? 'A lesson' : `${taken.length} lessons`} of ${names(otherNames)} that ELU 0.1.29 put in ${nameOf(root)} ${taken.length === 1 ? 'was' : 'were'} taken out.`);
      } catch (error) { log(`put back ${nameOf(root)}: ${error.message}`); }
    }
  } catch (error) { log(`put back: ${error.message}`); }
  try { atomic(doneFile(), { at: now }); } catch (error) { log(`put back: ${error.message}`); }
  return said;
}
