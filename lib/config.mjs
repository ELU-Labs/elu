import { parseYaml } from './yaml.mjs';
import { exactKeys, isObject, refuse, relativePath } from './util.mjs';
import { MODEL_NAME, VENDORS } from './vendors.mjs';

// What no run does, whatever a project's config says. One thing opens, and not from a config
// file: a bot its owner switched on to merge pull requests may run gh pr merge in its own
// working turn. Nothing else in the list opens for anyone.
export const NEVER = Object.freeze(['push', 'force-push', 'tag', 'merge', 'deploy', 'publish']);
// roles.lead is the model that does the work. Reviews are done by the session's bots, so a
// new config names no reviewer.
export function defaultConfig() {
  return {
    version: 1,
    roles: {
      // timeoutSeconds: how long a turn may print nothing before it is stopped (lib/turn-limits.mjs).
      // 900 reads as the default there (10 minutes); it stays 900 here because this file is
      // committed and shared, and ELU 0.1.9 and earlier read it as the whole turn's limit.
      lead: { vendor: 'claude', access: 'edit', network: 'off', commands: [], writablePaths: ['.'], timeoutSeconds: 900, maxCostUsd: null },
    },
    never: [...NEVER],
    checks: [{ name: 'tests', command: ['npm', 'test'] }, { name: 'build', command: ['npm', 'run', 'build'] }],
    limits: { changedLines: 400, reviewRounds: 2 },
    paths: ['.'],
  };
}
function strings(value, label) {
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string') || new Set(value).size !== value.length) refuse(`${label} must be a list of distinct strings.`);
}
function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) refuse(`${label} must be an integer from ${min} to ${max}.`);
}
export function validateConfig(value) {
  exactKeys(value, ['version', 'roles', 'never', 'checks', 'limits', 'paths', 'sandboxHelper', 'mcp', 'mcpOff'], 'Config');
  // mcpOff: Claude Code MCP servers turned off for this project's lead. mcp is the old opt-in
  // list, still read so older settings load; every server is now on unless turned off.
  for (const key of ['mcp', 'mcpOff']) if (value[key] !== undefined) { strings(value[key], key); if (value[key].length > 20 || value[key].some(name => !/^[A-Za-z0-9_.-]{1,64}$/.test(name))) refuse(`${key} lists up to 20 MCP server names.`); }
  // The key is still read so an older file that holds null loads. A path is refused: this file
  // comes with the repository, and the helper is started outside the sandbox.
  if (value.sandboxHelper !== undefined && value.sandboxHelper !== null) refuse('A project file cannot name the sandbox helper. Remove sandboxHelper from .elu-code/config.yaml and set ELU_CODE_SANDBOX_HELPER instead.');
  if (value.version !== 1) refuse('Config version must be 1.');
  // An entry other than lead (reviewer, security and so on) is from before bots did the
  // reviews. It is still checked so an older config loads as it always did; nothing runs it.
  if (!isObject(value.roles) || Object.keys(value.roles).length > 8 || Object.keys(value.roles).some(name => !/^[a-z][a-z0-9-]{0,29}$/.test(name) || ['constructor', 'prototype'].includes(name))) refuse('The config holds up to eight model entries with plain names.');
  for (const [name, role] of Object.entries(value.roles)) {
    // The owner reads "the model" for the entry that does the work; the others go by their name.
    const who = name === 'lead' ? 'The model' : name, own = name === 'lead' ? "The model's" : name;
    exactKeys(role, ['vendor', 'access', 'network', 'commands', 'writablePaths', 'timeoutSeconds', 'maxCostUsd', 'model'], `${own} policy`);
    if (![...VENDORS, ...(name === 'reviewer' ? ['auto', 'none'] : [])].includes(role.vendor)) refuse(`${who} has an unsupported vendor.`);
    // model: optional, for vendors whose CLI takes one (CAPS.model); the policy check says whether this vendor does.
    if (role.model !== undefined && (typeof role.model !== 'string' || !MODEL_NAME.test(role.model))) refuse(`${name === 'lead' ? 'The model' : `The ${name} model`} must be a plain model name.`);
    if (!['read', 'edit'].includes(role.access) || !['off', 'on'].includes(role.network)) refuse(`${who} has invalid access or network rules.`);
    if (name !== 'lead' && role.access !== 'read') refuse(`${name} must be read-only. Only the model edits.`);
    strings(role.commands, `${own} commands`); strings(role.writablePaths, `${own} writablePaths`);
    for (const file of role.writablePaths) relativePath(file);
    if (role.access === 'read' && role.writablePaths.length) refuse(`${who} is read-only, so it cannot have writable paths.`);
    integer(role.timeoutSeconds, 1, 7200, `${own} timeoutSeconds`);
    if (role.maxCostUsd !== null && (typeof role.maxCostUsd !== 'number' || !Number.isFinite(role.maxCostUsd) || role.maxCostUsd <= 0 || role.maxCostUsd > 100)) refuse(`${own} maxCostUsd must be null or from 0 to 100, excluding 0.`);
  }
  if (!value.roles.lead) refuse('The config names no model to do the work.');
  strings(value.never, 'never');
  if (value.never.length !== NEVER.length || NEVER.some((x) => !value.never.includes(x))) refuse('The fixed never list cannot be weakened or extended.');
  strings(value.paths, 'paths'); if (!value.paths.length) refuse('Declare at least one allowed path.');
  for (const p of value.paths) relativePath(p);
  exactKeys(value.limits, ['changedLines', 'reviewRounds'], 'Limits');
  integer(value.limits.changedLines, 1, 10000, 'changedLines'); integer(value.limits.reviewRounds, 1, 2, 'reviewRounds');
  if (!Array.isArray(value.checks) || value.checks.length > 20) refuse('Declare from 0 to 20 checks.');
  const names = new Set();
  for (const check of value.checks) {
    exactKeys(check, ['name', 'command'], 'Check');
    if (typeof check.name !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(check.name) || names.has(check.name)) refuse('Check names must be distinct plain words.');
    names.add(check.name);
    if (!Array.isArray(check.command) || !check.command.length || check.command.some((x) => typeof x !== 'string' || !x || /[\x00-\x1f]/.test(x))) refuse(`Check ${check.name} needs an argument list.`);
    if (check.command[0].startsWith('-') || check.command[0].includes('/')) refuse('Check programs must be found on PATH.');
  }
  return value;
}
export function parseConfig(text) { return validateConfig(parseYaml(text)); }

const ASK = { type: 'object', additionalProperties: false, properties: { to: { type: 'string', minLength: 1, maxLength: 64 }, project: { type: 'string', maxLength: 64 }, question: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['to', 'project', 'question'] };
// asks is offered only when teammates exist. It is listed as required so strict
// structured-output modes accept the schema; an empty list means no drafts.
export function resultSchema({ asks = false } = {}) {
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      outcome: { type: 'string', enum: ['done', 'needs_input', 'blocked'] }, summary: { type: 'string', minLength: 1, maxLength: 4000 },
      question: { type: ['string', 'null'], maxLength: 2000 }, choices: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      comments: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, severity: { type: 'string', enum: ['must_fix', 'suggestion'] }, body: { type: 'string' } }, required: ['id', 'severity', 'body'] } },
      responses: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, action: { type: 'string', enum: ['fixed', 'disputed'] }, reason: { type: 'string' } }, required: ['id', 'action', 'reason'] } },
    }, required: ['outcome', 'summary', 'question', 'choices', 'comments', 'responses'],
  };
  if (asks) { schema.properties.asks = { type: 'array', maxItems: 3, items: ASK }; schema.required.push('asks'); }
  return schema;
}
// schedule: offered to a bot that has a schedule when the owner writes to it, so the owner
// can tell it in plain words to stop or start running by itself in this session.
const SCHEDULE_WORDS = Object.freeze(['keep', 'off', 'on']);
// name: offered while the session has no name, so the first reply names it.
export function conversationSchema({ intents = ['answer', 'edit'], asks = false, schedule = false, name = false } = {}) {
  const schema = resultSchema({ asks });
  if (name) { schema.properties.name = { type: 'string' }; schema.required.push('name'); }
  schema.properties.intent = { type: 'string', enum: intents };
  schema.required.push('intent');
  // The project may hold no code: the lead names the repository it would change.
  if (intents.includes('edit')) { schema.properties.repository = { type: 'string', maxLength: 1000 }; schema.required.push('repository'); }
  if (schedule) { schema.properties.schedule = { type: 'string', enum: [...SCHEDULE_WORDS] }; schema.required.push('schedule'); }
  return schema;
}
// Peer runs offer only answer, but an edit intent is still parsed so the runner can turn it into an answer.
// who: what replied, as the owner reads it; a bot is @name.
export function validateConversation(value, { asks = false, who = 'The model', schedule = false } = {}) {
  exactKeys(value, ['outcome', 'summary', 'question', 'choices', 'comments', 'responses', 'intent', 'repository', 'name', ...(asks ? ['asks'] : []), ...(schedule ? ['schedule'] : [])], 'Conversation result');
  if (!['answer', 'edit'].includes(value.intent)) refuse(`${who} returned an invalid conversation intent.`);
  if (value.repository !== undefined && (typeof value.repository !== 'string' || value.repository.length > 1000 || /[\x00-\x1f\x7f]/.test(value.repository))) refuse(`${who} returned an invalid repository.`);
  // A reply that leaves schedule out, or says anything but off or on, changes nothing.
  // A name is passed on as it came and never fails a reply: whoever saves it checks it.
  const { intent, repository, schedule: word, name, ...result } = value; return { ...validateResult(result, { asks }), intent, ...(repository?.trim() ? { repository: repository.trim() } : {}), ...(schedule && ['off', 'on'].includes(word) ? { schedule: word } : {}), ...(typeof name === 'string' ? { name } : {}) };
}
function validateAsks(value) {
  if (!Array.isArray(value) || value.length > 3) refuse('Draft at most three asks.');
  for (const row of value) {
    exactKeys(row, ['to', 'project', 'question'], 'Draft ask');
    if (typeof row.to !== 'string' || !row.to.trim() || row.to.length > 64 || /[\x00-\x1f\x7f]/.test(row.to)) refuse('A draft ask needs a teammate name.');
    if (typeof row.project !== 'string' || row.project.length > 64 || /[\x00-\x1f\x7f]/.test(row.project)) refuse('A draft ask has an invalid project.');
    if (typeof row.question !== 'string' || !row.question.trim() || row.question.length > 2000) refuse('A draft ask needs a question of 1 to 2000 characters.');
  }
}
export function validateResult(value, { asks = false } = {}) {
  exactKeys(value, ['outcome', 'summary', 'question', 'choices', 'comments', 'responses', ...(asks ? ['asks'] : [])], 'Run result');
  if (value.asks !== undefined) validateAsks(value.asks);
  if (!['done', 'needs_input', 'blocked'].includes(value.outcome) || typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 4000) refuse('The run returned an invalid outcome or summary.');
  if (!(value.question === null || (typeof value.question === 'string' && value.question.length <= 2000))) refuse('The run returned an invalid question.');
  strings(value.choices, 'Result choices'); if (value.choices.length > 8) refuse('Too many choices.');
  // A needs_input result may leave question empty. After a blocked step a model names what it
  // needs in the summary, and whatever shows a result falls back to the summary.
  for (const field of ['comments', 'responses']) {
    if (!Array.isArray(value[field]) || value[field].length > 30) refuse(`Invalid ${field}.`);
    const ids = new Set();
    for (const row of value[field]) {
      if (!isObject(row)) refuse(`Invalid ${field} entry.`);
      exactKeys(row, field === 'comments' ? ['id', 'severity', 'body'] : ['id', 'action', 'reason'], field);
      if (typeof row.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(row.id) || ids.has(row.id)) refuse('Review IDs must be distinct plain words.');
      ids.add(row.id);
      const text = field === 'comments' ? row.body : row.reason;
      if (typeof text !== 'string' || !text.trim() || text.length > 4000) refuse('Review text is missing or too long.');
      if (field === 'comments' ? !['must_fix', 'suggestion'].includes(row.severity) : !['fixed', 'disputed'].includes(row.action)) refuse('Invalid review decision.');
    }
  }
  return value;
}
