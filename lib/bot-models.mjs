// The models a bot may name, as the vendor's own command line reports them. A vendor is
// read once (readBotModels) and kept until the app closes. The read is awaited and never
// holds the app: the screen draws and takes keys while the vendor's program prints. Nothing
// here uses the network. A command line that is missing, slow or changed gives the built-in
// names or none, never an error. Codex's names, which nothing built in can stand in for, are
// also saved for the next start (keptModels).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { atomic, findBin, onDiskPath, personalDirectory, readJson, tempFolder } from './util.mjs';
import { agentEnv, killGroup } from './process.mjs';
import { botModelProblem } from './bots.mjs';
import { claudeId } from './models.mjs';
import { installedEfforts, installedLevels } from './claude-catalog.mjs';
import { EFFORTS, VENDOR_EFFORTS } from './vendors.mjs';

const MAX = 40, TIMEOUT_MS = 2000;
const option = (name, note, effort = null, efforts = null) => ({ name, note: String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, 120), ...(effort ? { effort } : {}), ...(efforts ? { efforts } : {}) });
const level = value => typeof value === 'string' && /^[a-z]{1,12}$/.test(value) ? value : null;
// The efforts a model takes, from a list of levels or of { effort } rows, each once; null when
// the list is missing or names none, so they are not known.
const levels = value => {
  if (!Array.isArray(value)) return null;
  const found = [...new Set(value.slice(0, 24).map(item => level(typeof item === 'string' ? item : item?.effort)).filter(Boolean))];
  return found.length ? found : null;
};
// `codex debug models` prints the catalog the account is served, refreshed from OpenAI and kept
// by Codex between runs; `--bundled` (0.166.0-alpha.5.1) prints the one inside the binary, with
// no refresh. Both: { "models": [{ "slug", "description", "visibility", ... }] }. The one inside
// the binary is older than the release: 0.169.0-alpha.11.1 lists no gpt-6.2-sol there, while
// its refreshed catalog does, first. So the refreshed one is read, and the bundled one only when
// that prints nothing to offer (signed out, offline, too slow). A row is
// "list" or "hide", and the hidden ones are left out. default_reasoning_level is the effort
// that model runs with when none is asked for, and supported_reasoning_levels the efforts it
// takes ([{ "effort": "low", ... }], 0.167.0-alpha.4.1: up to ultra on gpt-6.1-sol, up to max on
// gpt-6-luna).
export function codexModels(text) {
  let models; try { models = JSON.parse(text).models; } catch { return []; }
  return (Array.isArray(models) ? models : []).filter(model => model?.visibility === 'list' && typeof model.slug === 'string' && model.slug && !botModelProblem('codex', model.slug)).slice(0, MAX).map(model => option(model.slug.trim(), model.description, level(model.default_reasoning_level), levels(model.supported_reasoning_levels)));
}
// claude has no list of models. Its --help (2.1.322) names the aliases --model takes:
//   --model <model>  Model for the current session. Provide an alias for the latest model
//                    (e.g. 'fable', 'opus', or 'sonnet') or a model's full name.
const alias = name => option(name, `the latest ${name[0].toUpperCase()}${name.slice(1)} model`);
export function claudeModels(text) {
  const entry = /(?<![\w-])--model <model>([\s\S]*?)(?=\n\s*-{1,2}[A-Za-z]|$)/.exec(String(text ?? ''))?.[1] ?? '';
  return [...new Set([...entry.matchAll(/'([a-z][a-z0-9.-]{0,39})'/g)].map(match => match[1]))].slice(0, MAX).map(alias);
}
// How each vendor is asked, and the names to use when it cannot be. The claude names are
// the ones its --help showed. Codex names carry versions, so none are kept here. retry: what
// the program is asked when its first answer names no model. A vendor
// that is not in this table is never run for its models. saved: the names its program
// printed are also written to disk for the next start (saveModels, below).
const SOURCES = {
  claude: { args: ['--help'], parse: claudeModels, fallback: ['fable', 'opus', 'sonnet'].map(alias) },
  codex: { args: ['debug', 'models'], retry: ['debug', 'models', '--bundled'], parse: codexModels, fallback: [], efforts: true, saved: true },
};
// What a command line prints, or null when it fails or takes too long, when its process
// group is stopped. The program runs beside the app, which is never held for it. The output
// goes to a file: Claude Code 2.1.321 exits before a piped --help is fully written.
function printed(bin, args, env, timeout) {
  return new Promise(resolve => {
    let folder = null, child = null, timer = null, done = false;
    const finish = ok => {
      if (done) return; done = true; clearTimeout(timer);
      let text = null;
      try { if (ok) text = fs.readFileSync(path.join(folder, 'out'), 'utf8'); } catch { text = null; }
      try { if (folder) fs.rmSync(folder, { recursive: true, force: true }); } catch { /* A leftover temp folder is harmless. */ }
      resolve(text);
    };
    try {
      folder = tempFolder('elu-code-models-');
      const fd = fs.openSync(path.join(folder, 'out'), 'w', 0o600);
      try { child = spawn(bin, args, { cwd: folder, env: agentEnv(env), stdio: ['ignore', fd, 'ignore'], detached: true }); } finally { fs.closeSync(fd); }
    } catch { return finish(false); }
    timer = setTimeout(() => { killGroup(child.pid, 'SIGKILL'); finish(false); }, timeout);
    child.once('error', () => finish(false)); child.once('close', code => finish(code === 0));
  });
}
// read: what each program printed, kept by program. reading: the reads that are running.
const read = new Map(), reading = new Map();
const sourceOf = vendor => Object.hasOwn(SOURCES, vendor) ? SOURCES[vendor] : null;
// Between starts. The names a program printed are saved in vendor-models.json in the personal
// folder, by the program's path, size and modification time, as lib/claude-catalog.mjs saves
// Claude Code's catalog: a new release is never taken for the one before it. Whoever must
// name a vendor's models before its program ran in this process reads them there
// (keptModels). The folder is the one the read's own environment names. For the app that is
// this process's own; a read asked with another environment writes beside that one, never
// into the owner's.
const PROGRAMS = 8;
function personalOf(env) {
  if (env === process.env) return personalDirectory();
  const home = typeof env.HOME === 'string' && path.isAbsolute(env.HOME) ? env.HOME : os.homedir();
  return path.join(onDiskPath(typeof env.XDG_CONFIG_HOME === 'string' && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config')), 'elu-code');
}
export const modelsFile = (env = process.env) => path.join(personalOf(env), 'vendor-models.json');
const stampOf = bin => { try { const stat = fs.statSync(bin); return stat.isFile() ? { file: bin, size: stat.size, mtimeMs: stat.mtimeMs } : null; } catch { return null; } };
const sameProgram = (row, vendor, stamp) => row.vendor === vendor && row.file === stamp.file && row.size === stamp.size && row.mtimeMs === stamp.mtimeMs;
function savedPrograms(env) {
  try { const value = readJson(modelsFile(env)); return Array.isArray(value?.programs) ? value.programs.filter(row => typeof row?.vendor === 'string' && typeof row.file === 'string' && Number.isFinite(row.size) && Number.isFinite(row.mtimeMs) && Array.isArray(row.models)) : []; } catch { return []; }
}
// What a saved row gives back: names a bot could save, each with its note and its effort, made
// as the read itself makes them. The file can be edited by hand, so nothing in it is taken as
// it stands.
const savedRows = (vendor, models) => models.filter(row => typeof row?.name === 'string' && row.name && !botModelProblem(vendor, row.name)).slice(0, MAX).map(row => option(row.name.trim(), row.note, level(row.effort), levels(row.efforts)));
// Written only when it would change: every start reads the program once, and most find the
// names they found before. A file that cannot be written only means the next start has no
// names before its own read.
function saveModels(vendor, bin, rows, env) {
  try {
    const stamp = stampOf(bin); if (!stamp) return;
    const programs = savedPrograms(env), was = programs.find(row => sameProgram(row, vendor, stamp));
    if (was && JSON.stringify(was.models) === JSON.stringify(rows)) return;
    atomic(modelsFile(env), { version: 1, programs: [...programs.filter(row => !(row.vendor === vendor && row.file === stamp.file)), { vendor, ...stamp, models: rows }].slice(-PROGRAMS) });
  } catch { /* Read again at the next start. */ }
}
// Reads a vendor's models from its command line, once for each program, and gives the
// options of its Model step as [{ name, note }]. Awaited: the app goes on while the program
// prints. A second call while the first one runs waits for the same read and starts no program.
export async function readBotModels(vendor, { env = process.env, timeoutMs = TIMEOUT_MS } = {}) {
  const source = sourceOf(vendor); if (!source) return [];
  const bin = findBin(vendor, env); if (!bin) return source.fallback;
  if (read.has(bin)) return read.get(bin);
  const names = async args => source.parse(await printed(bin, args, env, timeoutMs) ?? '');
  if (!reading.has(bin)) reading.set(bin, names(source.args).then(async first => first.length || !source.retry ? first : names(source.retry)).then(rows => { read.set(bin, rows.length ? rows : source.fallback); if (rows.length && source.saved) saveModels(vendor, bin, rows, env); }).finally(() => reading.delete(bin)));
  await reading.get(bin);
  return read.get(bin);
}
// Every vendor that has a list, read beside one another. True when a program was read just
// now, so whoever shows the names draws them again.
export async function readAllModels(options) {
  const before = read.size;
  await Promise.all(Object.keys(SOURCES).map(vendor => readBotModels(vendor, options)));
  return read.size !== before;
}
// The options of a vendor's Model step as they were last read, as [{ name, note }]. name is
// what follows --model. It starts no program: before a vendor was read (readBotModels) it
// gives the built-in names. An empty list means the vendor's models are not known here, so
// any name is taken.
export function botModels(vendor, { env = process.env } = {}) {
  const source = sourceOf(vendor); if (!source) return [];
  const bin = findBin(vendor, env); if (!bin) return source.fallback;
  return read.get(bin) ?? source.fallback;
}
// A vendor's models as far as they are known with no program started, as [{ name, note }]:
// what this process read when that gave names, else the names an earlier start saved for the
// program installed now, else the built-in ones. For whoever must tell a vendor's models
// apart before the vendor was read in this process (the classes of Auto model, in a conductor
// that has just started). botModels stays what this process itself read, so the Model step
// and the names /model takes are as they were.
const fromDisk = new Map();
export function keptModels(vendor, { env = process.env } = {}) {
  const source = sourceOf(vendor); if (!source) return [];
  const bin = findBin(vendor, env); if (!bin) return source.fallback;
  const here = read.get(bin); if (here?.length || !source.saved) return here ?? source.fallback;
  const stamp = stampOf(bin); if (!stamp) return here ?? source.fallback;
  // What the file gave for a program is held once it gave names: they do not change while the
  // program does not. A file with none yet is looked at again each time, since another of
  // ELU's processes may write it meanwhile.
  const key = [modelsFile(env), vendor, stamp.file, stamp.size, stamp.mtimeMs].join('\0');
  if (!fromDisk.has(key)) {
    let rows = []; try { const saved = savedPrograms(env).find(row => sameProgram(row, vendor, stamp)); rows = saved ? savedRows(vendor, saved.models) : []; } catch { rows = []; }
    if (!rows.length) return here ?? source.fallback;
    if (fromDisk.size > 20) fromDisk.clear();
    fromDisk.set(key, rows);
  }
  return fromDisk.get(key);
}
// The effort a model runs with when a bot asks for none, where the vendor's own list says
// it (Codex's does). null when it is not known here: no value is made up.
export async function ownEffort(vendor, model, options) {
  if (!model || !sourceOf(vendor)?.efforts) return null;
  return (await readBotModels(vendor, options)).find(row => row.name === model)?.effort ?? null;
}
// The same from the list as it was last read, starting no program: for a page that is drawn
// again and again and has read the vendor's list when it opened.
export function knownEffort(vendor, model, options) {
  if (!model || !sourceOf(vendor)?.efforts) return null;
  return botModels(vendor, options).find(row => row.name === model)?.effort ?? null;
}
// The efforts a model takes, lowest first, as its vendor's own catalog says them where that is
// known with no program started: Codex's model list as last read or saved (keptModels), the
// catalog inside the installed Claude Code. Else, and for no model (the vendor's own), every
// effort the vendor's command line takes (VENDOR_EFFORTS). [] for a vendor with no effort
// setting, and for a Claude model its catalog gives none.
export function modelEfforts(vendor, model = null, { env = process.env } = {}) {
  const all = VENDOR_EFFORTS[vendor] ?? []; if (!all.length || typeof model !== 'string' || !model.trim()) return all;
  if (vendor === 'claude') {
    const id = claudeId(model), bin = id ? findBin('claude', env) : null, read = bin ? installedLevels(bin) : {};
    return id && Object.hasOwn(read, id) ? read[id] : all;
  }
  return keptModels(vendor, { env }).find(row => row.name === model.trim())?.efforts ?? all;
}
// The effort a model runs with when `effort` is asked of it in general (Auto model's one effort
// for plans and edits): that effort where the model takes it, else the highest it takes below
// it, so ultra on a model that stops at max runs at max. null when it takes none at or below.
export function fitEffort(vendor, model, effort, options) {
  if (typeof effort !== 'string' || !effort) return null;
  const takes = modelEfforts(vendor, model, options); if (takes.includes(effort)) return effort;
  const rank = EFFORTS.indexOf(effort); if (rank < 0) return null;
  return takes.filter(level => EFFORTS.indexOf(level) >= 0 && EFFORTS.indexOf(level) < rank).sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b)).at(-1) ?? null;
}
// Every effort a vendor's models take: what its command line takes, then any other its catalog
// names for one of them. For a saved effort whose model is not at hand: it is one the vendor knows.
export function vendorEfforts(vendor, { env = process.env } = {}) {
  const all = VENDOR_EFFORTS[vendor] ?? []; if (!all.length) return all;
  let named = [];
  try {
    if (vendor === 'claude') { const bin = findBin('claude', env); named = bin ? Object.values(installedLevels(bin)).flat() : []; }
    else named = keptModels(vendor, { env }).flatMap(row => row.efforts ?? []);
  } catch { named = []; }
  const extra = [...new Set(named)].filter(effort => !all.includes(effort));
  return extra.length ? [...all, ...extra.sort((a, b) => (EFFORTS.indexOf(a) + 1 || 99) - (EFFORTS.indexOf(b) + 1 || 99))] : all;
}
// The effort each Claude model runs with when Claude Code is given no --effort comes from the
// model catalog inside the installed Claude Code (lib/claude-catalog.mjs), for any release.
// ELU starts Claude Code with no setting sources and without CLAUDE_CODE_EFFORT_LEVEL, so
// neither the owner's effortLevel nor that variable reaches it. This table is used only when
// that catalog cannot be read: it is what the catalogs of 2.1.319 and 2.1.322 said
// (default_effort), and Fable 5.2 is in 2.1.322 only. Another release is not known here, and
// neither is a model the catalog gives no effort.
const CLAUDE_EFFORTS = (() => {
  const earlier = { 'claude-fable-5': 'high', 'claude-fable-5-1': 'high', 'claude-opus-4-7': 'xhigh', 'claude-opus-4-8': 'high', 'claude-opus-5': 'high', 'claude-opus-5-5': 'medium', 'claude-sonnet-5': 'high', 'claude-sonnet-5-5': 'medium', 'claude-haiku-5-5': 'medium' };
  return Object.freeze({ '2.1.319': Object.freeze({ ...earlier }), '2.1.322': Object.freeze({ ...earlier, 'claude-fable-5-2': 'medium' }) });
})();
// bin is the Claude Code program the run used. Its own catalog decides when it has one; the
// table only when nothing could be read from it.
export function claudeOwnEffort(model, release, bin = null) {
  const id = claudeId(model); if (!id) return null;
  const read = bin ? installedEfforts(bin) : {};
  if (Object.keys(read).length) return Object.hasOwn(read, id) ? read[id] : null;
  const table = Object.hasOwn(CLAUDE_EFFORTS, String(release ?? '')) ? CLAUDE_EFFORTS[String(release)] : null;
  return table && Object.hasOwn(table, id) ? table[id] : null;
}
// The effort an agent of a session runs its model with when the owner chose none, starting no
// program, or null where it is not known here: Codex's from its list as last read, Claude
// Code's from the catalog of the installed program. ran: the id a run on that name reported
// (opus reads claude-opus-5-5), which is how the catalog names its models.
export function agentOwnEffort(vendor, model, { ran = null, env = process.env } = {}) {
  if (vendor === 'claude') return claudeOwnEffort(ran ?? model, null, findBin('claude', env));
  return knownEffort(vendor, model, { env });
}
// The effort a run went with: the one it was asked for, else its vendor's own for that model
// where that is known (Codex's model list, Claude Code's catalog), else null. model is the one
// the vendor reported, or the one asked for; release is the vendor's version and bin its program.
export async function runEffort(vendor, { effort = null, model = null, release = null, bin = null } = {}, options) {
  if (effort) return effort;
  if (vendor === 'claude') return claudeOwnEffort(model, release, bin);
  return ownEffort(vendor, model, options);
}
// The options a typed text narrows to: names that start with it, then names that hold it.
// No text gives them all.
export function matchModels(models, text) {
  const wanted = String(text ?? '').trim().toLowerCase(); if (!wanted) return models;
  const found = models.map(row => row.name.toLowerCase().indexOf(wanted));
  return [...models.filter((_, index) => found[index] === 0), ...models.filter((_, index) => found[index] > 0)];
}
