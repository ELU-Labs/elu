// The models a bot may name, as the vendor's own command line reports them. A vendor is
// read when its Model step first opens and kept until the app closes. Nothing here uses the
// network. A command line that is missing, slow or changed gives the built-in names or
// none, never an error.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findBin } from './util.mjs';
import { agentEnv } from './process.mjs';
import { botModelProblem } from './bots.mjs';
import { claudeId } from './models.mjs';
import { installedEfforts } from './claude-catalog.mjs';

const MAX = 40, TIMEOUT_MS = 2000;
const option = (name, note, effort = null) => ({ name, note: String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, 120), ...(effort ? { effort } : {}) });
const level = value => typeof value === 'string' && /^[a-z]{1,12}$/.test(value) ? value : null;
// `codex debug models --bundled` (0.166.0-alpha.5.1) prints the catalog inside the binary,
// with no refresh: { "models": [{ "slug", "description", "visibility", ... }] }. A row is
// "list" or "hide", and the hidden ones are left out. default_reasoning_level is the effort
// that model runs with when none is asked for.
export function codexModels(text) {
  let models; try { models = JSON.parse(text).models; } catch { return []; }
  return (Array.isArray(models) ? models : []).filter(model => model?.visibility === 'list' && typeof model.slug === 'string' && model.slug && !botModelProblem('codex', model.slug)).slice(0, MAX).map(model => option(model.slug.trim(), model.description, level(model.default_reasoning_level)));
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
// the ones its --help showed. Codex names carry versions, so none are kept here. A vendor
// that is not in this table is never run for its models.
const SOURCES = {
  claude: { args: ['--help'], parse: claudeModels, fallback: ['fable', 'opus', 'sonnet'].map(alias) },
  codex: { args: ['debug', 'models', '--bundled'], parse: codexModels, fallback: [], efforts: true },
};
// What a command line prints, or null when it fails or takes too long. The output goes to
// a file: Claude Code 2.1.321 exits before a piped --help is fully written.
function printed(bin, args, env, timeout) {
  let folder = null;
  try {
    folder = fs.mkdtempSync(path.join(os.tmpdir(), 'elu-code-models-'));
    const file = path.join(folder, 'out'), fd = fs.openSync(file, 'w', 0o600); let result;
    try { result = spawnSync(bin, args, { cwd: folder, env: agentEnv(env), stdio: ['ignore', fd, 'ignore'], timeout, killSignal: 'SIGKILL' }); } finally { fs.closeSync(fd); }
    return result.error || result.status !== 0 ? null : fs.readFileSync(file, 'utf8');
  } catch { return null; } finally { if (folder) fs.rmSync(folder, { recursive: true, force: true }); }
}
const read = new Map();
// The options of a vendor's Model step, as [{ name, note }]. name is what follows --model.
// An empty list means the vendor's models are not known here, so any name is taken.
export function botModels(vendor, { env = process.env, timeoutMs = TIMEOUT_MS } = {}) {
  const source = Object.hasOwn(SOURCES, vendor) ? SOURCES[vendor] : null; if (!source) return [];
  const bin = findBin(vendor, env); if (!bin) return source.fallback;
  if (!read.has(bin)) { const rows = source.parse(printed(bin, source.args, env, timeoutMs) ?? ''); read.set(bin, rows.length ? rows : source.fallback); }
  return read.get(bin);
}
// The effort a model runs with when a bot asks for none, where the vendor's own list says
// it (Codex's does). null when it is not known here: no value is made up.
export function ownEffort(vendor, model, options) {
  if (!model || !(Object.hasOwn(SOURCES, vendor) && SOURCES[vendor].efforts)) return null;
  return botModels(vendor, options).find(row => row.name === model)?.effort ?? null;
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
// The effort a run went with: the one it was asked for, else its vendor's own for that model
// where that is known (Codex's model list, Claude Code's catalog), else null. model is the one
// the vendor reported, or the one asked for; release is the vendor's version and bin its program.
export function runEffort(vendor, { effort = null, model = null, release = null, bin = null } = {}, options) {
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
