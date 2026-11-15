// A session's model: a vendor's command line and the model name it is started with. Each
// session keeps its own in its saved policy, so choosing one for a session changes no
// other. The choices are the names each installed vendor lists, plus the ones the owner
// added by name; those are kept in the personal folder (models.json), next to the bots.
import fs from 'node:fs';
import path from 'node:path';
import { atomic, findBin, hash, noSymlinks, personalDirectory, readJson, refuse } from './util.mjs';
import { approveSaved, trustedText } from './project-trust.mjs';
import { CAPS, VENDORS, VENDOR_EFFORTS, VENDOR_NAMES } from './vendors.mjs';
import { parseConfig, validateConfig } from './config.mjs';
import { stringifyYaml } from './yaml.mjs';
import { assertPolicy } from './policy.mjs';
import { pinnedConfig } from './checks.mjs';
import { lock, readTask, saveTask, taskDir } from './state.mjs';
import { isPeerRun } from './modes.mjs';
import { botModelProblem } from './bots.mjs';
import { botModels } from './bot-models.mjs';

// What a new session runs on where Claude Code is the first vendor installed and nothing was chosen.
export const FIRST_MODEL = Object.freeze({ vendor: 'claude', model: 'opus' });
const ADDED_MAX = 40;
// The project config takes fewer characters in a model name than a bot does.
const CONFIG_NAME = /^[A-Za-z0-9._:/-]{1,128}$/;
const SHORT = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', grok: 'Grok Build' };

// Vendors that can run a session, and the ones of them installed here.
export const sessionVendors = () => VENDORS.filter(vendor => CAPS[vendor]?.lead);
export const installedVendors = (env = process.env) => sessionVendors().filter(vendor => findBin(vendor, env));
// What is wrong with a model name for a session on this vendor, or null. No name is the
// vendor's own default.
export function modelProblem(vendor, name) {
  if (!sessionVendors().includes(vendor)) return `A session runs on one of: ${sessionVendors().join(', ')}.`;
  if (name == null || name === '') return null;
  return botModelProblem(vendor, name) ?? (CONFIG_NAME.test(String(name).trim()) ? null : 'A model name here has letters, digits, dots, colons, slashes or dashes.');
}
// A model in its saved shape, { vendor, model }, or a refusal the owner can act on.
export function checkModel(value) {
  const vendor = value?.vendor, model = value?.model == null || value.model === '' ? null : String(value.model).trim();
  if (typeof vendor !== 'string') refuse('A model names its vendor.');
  const problem = modelProblem(vendor, model); if (problem) refuse(problem);
  return { vendor, model };
}
// "claude · opus": a model as a status line names it. A vendor alone is its own default.
export const modelText = choice => [choice.vendor, choice.model].filter(Boolean).join(' · ');
// A model as people read it: claude-fable-5-1 reads Fable 5.1, claude-3-5-sonnet-20241022 reads Sonnet 3.5.
export function modelName(id) {
  if (typeof id !== 'string' || !id.trim()) return null;
  const parts = id.trim().replace(/\[.*\]$/, '').replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-');
  const words = parts.filter(part => /^[a-z]+$/i.test(part)), numbers = parts.filter(part => /^\d+$/.test(part));
  if (!words.length || words.length + numbers.length !== parts.length) return id.trim().slice(0, 40);
  return [words.map(word => word[0].toUpperCase() + word.slice(1)).join(' '), numbers.join('.')].filter(Boolean).join(' ');
}
// What a vendor is called where a model has no name of its own.
export const vendorShort = vendor => SHORT[vendor] ?? vendor;
// A Claude model id as Claude Code's own catalog names it (claude-opus-5-5), or null for an id
// that is not Claude's. A date, a context window ([1m]), a provider's prefix
// (us.anthropic.claude-…) and version suffix (-v1:0, @20261001) are left out.
export function claudeId(id) {
  if (typeof id !== 'string') return null;
  const found = /(?:^|[./])(claude-[a-z0-9-]+?)(?:-\d{8})?(?:-v\d+(?::\d+)?)?(?:@[\w.-]*)?(?:\[[^\]]*\])?$/i.exec(id.trim());
  return found ? found[1].toLowerCase() : null;
}
// A model as a chat header names it beside the name: fable 5.2, opus 5.5, or another vendor's
// name as that vendor reported it, gpt-6.1-sol.
export function shortModel(id) {
  if (typeof id !== 'string' || !id.trim()) return null;
  const claude = claudeId(id), named = claude ? modelName(claude) : null;
  return named && named !== claude ? named.toLowerCase() : id.trim().slice(0, 40);
}
// An effort as a chat header names it; medium is med, the others as given.
export const shortEffort = effort => typeof effort === 'string' && effort.trim() ? effort.trim() === 'medium' ? 'med' : effort.trim().slice(0, 12) : null;
// What goes in parentheses after a name in a chat header: the model and effort that wrote the
// entry, "fable 5.2 med". When the name is that model's own (a session's agent reads Opus 5.5),
// only the effort is left. null when nothing is known.
export function modelTag({ model = null, effort = null } = {}, name = '') {
  const shown = shortModel(model), level = shortEffort(effort);
  if (shown && String(name).trim().toLowerCase() === shown.toLowerCase()) return level;
  return [shown, level].filter(Boolean).join(' ') || null;
}
// The parentheses of a chat entry's header: only an entry a model wrote (the agent's, a bot's)
// has them, and only when it carries what wrote it. An entry from before has none.
export const entryTag = entry => entry?.lead || entry?.bot ? modelTag(entry, entry.role) : null;

// The model in a config.
export const configModel = config => ({ vendor: config.roles.lead.vendor, model: config.roles.lead.model ?? null });
// The project's own default, or null when it has chosen none: a config that names Claude Code
// and no model is the one every project starts from.
export function projectChoice(config) {
  const { vendor, model } = configModel(config);
  return model || vendor !== FIRST_MODEL.vendor ? { vendor, model } : null;
}
// This computer's default: the model of every project that has not chosen one. It is kept in
// the personal folder (default-model.json). null when the owner set none, or it cannot be read.
const computerFile = () => path.join(personalDirectory(), 'default-model.json');
export function computerDefault() {
  try {
    const file = computerFile(); noSymlinks(file); if (!fs.existsSync(file)) return null;
    const value = readJson(file).default;
    return value && typeof value.vendor === 'string' && !modelProblem(value.vendor, value.model) ? { vendor: value.vendor, model: value.model ?? null } : null;
  } catch { return null; }
}
// Sets it; null goes back to no choice.
export function saveComputerDefault(choice) {
  const saved = choice == null ? null : checkModel(choice);
  atomic(computerFile(), { version: 1, default: saved }); return saved;
}
// Which vendors are installed is asked on every redraw, so PATH is read once a second at most.
let lookedAt = { path: null, at: 0, vendors: [] };
function installedNow(env) {
  const key = env.PATH ?? '';
  if (lookedAt.path !== key || Date.now() - lookedAt.at > 1000) lookedAt = { path: key, at: Date.now(), vendors: installedVendors(env) };
  return lookedAt.vendors;
}
// The model a new session starts on here, and why (from): the project's own default
// ('project'), else this computer's ('computer'), else the first vendor installed here, in
// the order of VENDORS ('installed'). A saved default whose vendor is not installed here is
// never used: it is passed over, and missing names each one ({ from, vendor, model }) so
// whoever shows the default can say so. With no vendor installed nothing can run, and it
// reads as the first saved default, else Claude's ('none'). config: the project's settings,
// or null for what this computer gives a project that has not chosen.
export function startModel(config, { env = process.env } = {}) {
  const installed = installedNow(env);
  const saved = [['project', config ? projectChoice(config) : null], ['computer', computerDefault()]].filter(([, choice]) => choice).map(([from, choice]) => ({ from, ...choice }));
  const used = saved.find(row => installed.includes(row.vendor)), missing = used ? saved.slice(0, saved.indexOf(used)) : saved;
  if (used) return { ...used, missing };
  const first = installed[0];
  if (!first) return { from: 'none', vendor: saved[0]?.vendor ?? FIRST_MODEL.vendor, model: saved[0] ? saved[0].model : FIRST_MODEL.model, missing };
  return { from: 'installed', ...(first === FIRST_MODEL.vendor ? FIRST_MODEL : { vendor: first, model: null }), missing };
}
// The same as a choice, { vendor, model }: what a new session of that project starts with.
export function defaultModel(config, options) {
  const { vendor, model } = startModel(config, options);
  return { vendor, model };
}
// A saved default that is passed over, in one sentence: name(choice) is how a model reads.
export function passedOver(missing, name) {
  return missing.map(row => `${name(row)} is ${row.from === 'project' ? "this project's" : "this computer's"} default, but ${VENDOR_NAMES[row.vendor]} is not installed here.`).join(' ');
}
// A bot as it runs on this computer. One whose vendor is not installed here runs on this
// computer's default model instead (startModel with no project), under its own name and
// instructions, whether it names a model or not: the model it names belongs to the program
// that is missing. An effort the new vendor does not take, and helpers, which start on Claude
// Code only, are left out. review: the turn is a review, which only a vendor that can review
// takes (caps.reviewer): the default when it can, else the first installed vendor that can.
// When none can, the bot comes back as saved (reviewsHere says so). A teammate's question
// to a shared bot is never moved (lib/bots.mjs, sharedBot).
export function botHere(bot, { env = process.env, review = false, caps = CAPS } = {}) {
  const installed = installedNow(env);
  if (!bot || installed.includes(bot.vendor)) return bot;
  const start = startModel(null, { env });
  if (start.from === 'none') return bot;
  const can = vendor => !review || caps[vendor]?.reviewer === true, vendor = can(start.vendor) ? start.vendor : installed.find(can);
  if (!vendor) return bot;
  const model = vendor === start.vendor ? start.model : vendor === FIRST_MODEL.vendor ? FIRST_MODEL.model : null;
  return { ...bot, vendor, model, effort: VENDOR_EFFORTS[vendor]?.includes(bot.effort) ? bot.effort : null, subagents: vendor === 'claude' ? bot.subagents ?? null : null };
}
// Whether a vendor installed here can review at all.
export const reviewsHere = ({ env = process.env, caps = CAPS } = {}) => installedNow(env).some(vendor => caps[vendor]?.reviewer === true);
// A teammate's question (the read-only kind, lib/modes.mjs isPeerRun) is answered by Claude
// Code only: its launch alone keeps every read inside the shared project, hides what Git
// does not track, and holds the run under a dollar cap (lib/adapters/claude.mjs, peer). No
// other vendor's Read only launch is proven to do the three, so none answers one.
// What the owner of a computer without Claude Code reads on the question that could not run.
// The asker is told the same in their words (lib/peer/failure.mjs).
export const NO_QUESTIONS = "A teammate's question is answered by Claude Code only, and it is not installed here. Set /access to Auto, and teammates' messages start sessions on your model instead.";
// A copy of a config that runs on this model. A dollar budget and a command list stay only
// where the vendor enforces them.
export function withModel(config, choice) {
  const { vendor, model } = checkModel(choice), next = structuredClone(config), lead = next.roles.lead;
  lead.vendor = vendor;
  if (model) lead.model = model; else delete lead.model;
  lead.maxCostUsd = CAPS[vendor].budget ? lead.maxCostUsd ?? null : null;
  if (!CAPS[vendor].commands) lead.commands = [];
  return next;
}

export const modelsFile = () => path.join(personalDirectory(), 'models.json');
// The models the owner added by name. A row that is no longer valid is left out.
export function addedModels() {
  let value; try { value = readJson(modelsFile()); } catch { return []; }
  return (Array.isArray(value?.models) ? value.models : []).filter(row => typeof row?.name === 'string' && row.name && !modelProblem(row.vendor, row.name)).map(row => ({ vendor: row.vendor, name: row.name }));
}
export function rememberModel(vendor, name) {
  const { model } = checkModel({ vendor, model: name });
  if (!model) refuse('Name the model to add.');
  const rows = addedModels();
  if (!rows.some(row => row.vendor === vendor && row.name === model)) atomic(modelsFile(), { version: 1, models: [...rows, { vendor, name: model }].slice(-ADDED_MAX) });
  return { vendor, model };
}
// Every model a session can be given here, as [{ name, vendor, model, note }]. name is what
// the owner types: the model's own name, or vendor:name when two vendors share it. Claude's
// own default is its first model, so only the other vendors have a row for theirs.
export function modelChoices({ env = process.env } = {}) {
  const rows = [], added = addedModels();
  for (const vendor of installedVendors(env)) {
    if (vendor !== FIRST_MODEL.vendor) rows.push({ vendor, model: null, note: 'its own default model' });
    const listed = botModels(vendor, { env }).filter(row => !modelProblem(vendor, row.name));
    for (const row of listed) rows.push({ vendor, model: row.name, note: row.note });
    for (const row of added) if (row.vendor === vendor && !listed.some(item => item.name === row.name)) rows.push({ vendor, model: row.name, note: '' });
  }
  const plain = row => row.model ?? row.vendor, shared = name => rows.filter(row => plain(row) === name).length > 1 || VENDORS.includes(name);
  return rows.map(row => ({ ...row, name: row.model && shared(row.model) ? `${row.vendor}:${row.model}` : plain(row) }));
}
// The model a typed name means: a listed name, vendor:name for any model of an installed
// vendor, or a vendor alone for its default. Throws with a line that says what to type.
export function findModel(text, { env = process.env } = {}) {
  const typed = String(text ?? '').trim(), choices = modelChoices({ env }), pick = row => ({ vendor: row.vendor, model: row.model });
  const listed = choices.find(row => row.name === typed) ?? choices.find(row => row.name.toLowerCase() === typed.toLowerCase());
  if (listed) return pick(listed);
  const at = typed.indexOf(':'), vendor = (at < 0 ? typed : typed.slice(0, at)).toLowerCase(), name = at < 0 ? '' : typed.slice(at + 1);
  if (sessionVendors().includes(vendor)) {
    if (!findBin(vendor, env)) throw new Error(`${VENDOR_NAMES[vendor]} is not installed or not on your PATH.`);
    if (!name) return vendor === FIRST_MODEL.vendor ? { ...FIRST_MODEL } : { vendor, model: null };
    const problem = modelProblem(vendor, name); if (problem) throw new Error(problem);
    return { vendor, model: name };
  }
  const same = choices.filter(row => row.model === typed);
  if (same.length > 1) throw new Error(`${typed} is on ${same.map(row => row.vendor).join(' and ')}. Type ${same.map(row => row.name).join(' or ')}.`);
  throw new Error(choices.length ? `No model named ${typed.slice(0, 40)}. /model lists them; /model add adds one by name.` : 'No vendor command line is installed, so there is no model to choose yet.');
}
// The model the first words name, and the words after it: /model opus 5.5, /model opus fix the
// build. The most words that name a model win. One word is what findModel takes; more are the
// name a model is shown by (label: Opus 5.5), or a Claude model and version (sonnet 5 is
// claude-sonnet-5). Words that name no model throw what findModel says of the first.
export function modelWords(words, { env = process.env, label = choice => modelName(choice.model) } = {}) {
  const choices = modelChoices({ env }), named = text => {
    if (!/\s/.test(text)) { try { return findModel(text, { env }); } catch { return null; } }
    const shown = choices.find(row => (label(row) ?? '').toLowerCase() === text.toLowerCase());
    if (shown) return { vendor: shown.vendor, model: shown.model };
    const [, family, version] = /^([a-z]+) (\d+(?:\.\d+)?)$/i.exec(text) ?? [];
    return family && choices.some(row => row.vendor === 'claude' && row.model === family.toLowerCase()) ? { vendor: 'claude', model: `claude-${family.toLowerCase()}-${version.replace('.', '-')}` } : null;
  };
  for (let count = words.length; count > 0; count -= 1) {
    const choice = named(words.slice(0, count).join(' '));
    if (choice) return { choice, count };
  }
  return { choice: findModel(words[0], { env }), count: 1 };
}
// The name a choice is typed as, for a list that marks the one in use.
export function choiceName(choice, choices) {
  const row = choices.find(item => item.vendor === choice.vendor && item.model === choice.model);
  return row?.name ?? (choice.model ? `${choice.vendor}:${choice.model}` : choice.vendor);
}

// The model a session runs on is the one in its saved policy. Only a session that keeps
// its own policy can change it; one pinned to a commit runs what that commit says.
export const ownsPolicy = task => task?.mode === 'automatic' || task?.kind === 'conversation';
// Sets a session's model from its next message. A turn in progress holds the session, so
// the change waits for it to end.
export function setSessionModel(repo, taskId, choice) {
  let release;
  try { release = lock(repo, `task-${taskId}`); }
  catch (error) { if (error.message.includes('holds this lock')) refuse('Wait for the reply, or /stop, then choose the model.'); throw error; }
  try {
    const task = readTask(repo, taskId);
    if (isPeerRun(task.origin)) refuse("A teammate's question keeps the model it started with.");
    if (!ownsPolicy(task)) refuse('This session keeps the model of the commit it started from.');
    const { config } = pinnedConfig(repo, task.base, { current: false, task });
    const next = withModel(config, choice), text = stringifyYaml(next); parseConfig(text);
    assertPolicy(next.roles.lead, { mode: 'ask' });
    atomic(path.join(taskDir(repo, task.id), 'policy.yaml'), text); task.configHash = hash(text); saveTask(repo, task);
    return task;
  } finally { release(); }
}
// Sets the model new sessions of a project start with: the vendor and model in its config
// file. proposed is the config a project with no file yet would be given.
// choice null: the project goes back to no default of its own, and uses this computer's.
export function setDefaultModel(repo, choice, proposed) {
  // The change starts from settings the owner approved, never from a file he has not.
  const file = path.join(repo.root, '.elu-code/config.yaml'), approved = trustedText(repo.root, 'config.yaml');
  const config = withModel(approved != null ? parseConfig(approved) : proposed, choice ?? { vendor: FIRST_MODEL.vendor, model: null });
  validateConfig(config); assertPolicy(config.roles.lead, { mode: 'ask' }); const text = stringifyYaml(config);
  fs.mkdirSync(path.dirname(file), { recursive: true }); approveSaved(repo.root, 'config.yaml', text); atomic(file, text); return config;
}
