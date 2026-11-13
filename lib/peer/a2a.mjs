import os from 'node:os';
import crypto from 'node:crypto';
import { EluCodeError, isObject, refuse } from '../util.mjs';
import { BOT_NAME } from '../bots.mjs';
import { sanitize } from './peerdata.mjs';

// A2A v1.0 objects and JSON-RPC handling, checked against A2A v1.0.1
// (github.com/a2aproject/A2A, tag v1.0.1):
//   specification/a2a.proto: field names, the TaskState and Role enums, Part's oneof
//     (text | raw | url | data), and which fields are REQUIRED;
//   docs/specification.md §5.5: camelCase JSON names and ProtoJSON enum strings
//     ("TASK_STATE_COMPLETED", "ROLE_USER"); §5.3 and §9.4: JSON-RPC method names;
//     §5.4 and §9.5: error codes and error.data as google.rpc.ErrorInfo objects;
//     §3.2.6 and §3.6: the A2A-Version and A2A-Extensions service parameters;
//     §3.3.4: push config methods return PushNotificationNotSupportedError.
// @a2a-js/sdk 1.3.0 also reads snake_case names and integer enums (ProtoJSON allows
// both), so the validators accept them and always return the spec form.
export const A2A_VERSION = '1.0';
export const BINDING = 'urn:elu-code:a2a-binding:hyperswarm-ndjson:v1';
export const PEER_EXT = 'urn:elu-code:a2a-ext:peer:v1';
// A message's text is bounded only by the line on the link that carries it (FRAME_MAX in
// transport.mjs). A longer one goes before its message in elu.text.put pieces (texts.mjs),
// and the message names it by TEXT_URN. ELU 0.1.19 and earlier took 16000 characters, or
// 160000 for a review.
export const TEXT_MAX = 1024 * 1024;
export const REVIEW_MAX = TEXT_MAX;
// Enum order matches the proto numbers (1-based), which the integer form uses.
export const TaskState = Object.freeze({
  SUBMITTED: 'TASK_STATE_SUBMITTED', WORKING: 'TASK_STATE_WORKING', COMPLETED: 'TASK_STATE_COMPLETED', FAILED: 'TASK_STATE_FAILED',
  CANCELED: 'TASK_STATE_CANCELED', INPUT_REQUIRED: 'TASK_STATE_INPUT_REQUIRED', REJECTED: 'TASK_STATE_REJECTED', AUTH_REQUIRED: 'TASK_STATE_AUTH_REQUIRED',
});
export const Role = Object.freeze({ USER: 'ROLE_USER', AGENT: 'ROLE_AGENT' });
export const ErrorCode = Object.freeze({
  PARSE_ERROR: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL_ERROR: -32603,
  TASK_NOT_FOUND: -32001, TASK_NOT_CANCELABLE: -32002, PUSH_NOTIFICATION_NOT_SUPPORTED: -32003, UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005, INVALID_AGENT_RESPONSE: -32006, EXTENDED_AGENT_CARD_NOT_CONFIGURED: -32007,
  EXTENSION_SUPPORT_REQUIRED: -32008, VERSION_NOT_SUPPORTED: -32009,
});
export const CORE_METHODS = Object.freeze(['SendMessage', 'SendStreamingMessage', 'GetTask', 'ListTasks', 'CancelTask', 'SubscribeToTask',
  'CreateTaskPushNotificationConfig', 'GetTaskPushNotificationConfig', 'ListTaskPushNotificationConfigs', 'DeleteTaskPushNotificationConfig', 'GetExtendedAgentCard']);
const PUSH_METHODS = CORE_METHODS.filter((name) => name.includes('PushNotificationConfig'));
export const PEER_KINDS = Object.freeze(['ask', 'review', 'handoff', 'answer']);
const TERMINAL = new Set([TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELED, TaskState.REJECTED]);
// google.rpc.ErrorInfo.reason is the ErrorCode name, as in the spec's §9.5 example.
const REASON = Object.fromEntries(Object.entries(ErrorCode).map(([name, code]) => [code, name]));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HANDLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/;
const ALIASES = { message_id: 'messageId', context_id: 'contextId', task_id: 'taskId', reference_task_ids: 'referenceTaskIds', media_type: 'mediaType',
  artifact_id: 'artifactId', accepted_output_modes: 'acceptedOutputModes', task_push_notification_config: 'taskPushNotificationConfig',
  history_length: 'historyLength', return_immediately: 'returnImmediately' };

export const isTerminal = (state) => TERMINAL.has(state);

// Errors: a2aError() is a refuse()-style error that carries its JSON-RPC code. Other
// refusals become Invalid params; anything else becomes Internal error with no details.
function errorData(code, data) {
  if (Array.isArray(data)) return data;
  if (!isObject(data) && !(code >= -32099 && code <= -32001)) return undefined;
  return [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: REASON[code] ?? 'UNKNOWN', domain: 'a2a-protocol.org', ...(isObject(data) ? { metadata: strings(data) } : {}) }];
}
const strings = (value) => Object.fromEntries(Object.entries(value).map(([k, v]) => [sanitize(k, 64), sanitize(v, 200)]));
export function a2aError(code, message, data) {
  return new EluCodeError(message, { rpc: { code, data: errorData(code, data) } });
}
export function rpcError(id, code, message, data) {
  const error = { code, message, data: errorData(code, data) };
  if (error.data === undefined) delete error.data;
  return { jsonrpc: '2.0', id, error };
}
// A refusal message reaches another machine, so local paths are cut from it, unless the
// caller is a trusted peer, who gets it as written.
const HOME = os.homedir();
export const publicMessage = (text, { trusted = false } = {}) => trusted ? sanitize(text, 300) : sanitize(text, 300).replaceAll(HOME, '~').replace(/(?:~|\/)[^\s'"]*\/[^\s'"]*/g, '[path]');
export function errorObject(error, onError, { trusted = false } = {}) {
  if (error instanceof EluCodeError) {
    const rpc = error.details?.rpc;
    return rpcError(null, rpc?.code ?? ErrorCode.INVALID_PARAMS, publicMessage(error.message, { trusted }) || 'Invalid parameters.', rpc?.data).error;
  }
  onError?.(error);
  return { code: ErrorCode.INTERNAL_ERROR, message: 'Internal error.' };
}
// Whether the caller is a trusted peer: the handler's own trusted(ctx), else ctx.trusted,
// which the daemon sets on each session from peers.json (a function, read per error, so
// trust given or removed while the connection is open applies at once).
function trustedCaller(trusted, ctx) {
  const value = typeof trusted === 'function' ? trusted(ctx) : ctx?.trusted;
  return (typeof value === 'function' ? value() : value) === true;
}

// Shape checks. Everything here may come from another machine.
const quoted = (name) => JSON.stringify(sanitize(name, 40));
// Unknown fields are dropped (§5.7: implementations SHOULD ignore them), so a teammate on a
// newer ELU still gets through; the frame size limit bounds what they can carry.
function fields(value, keys, label) {
  if (!isObject(value)) refuse(`${label} must be an object.`);
  const out = {};
  for (const [name, item] of Object.entries(value)) {
    const key = Object.hasOwn(ALIASES, name) ? ALIASES[name] : name;
    if (!keys.includes(key)) continue;
    if (Object.hasOwn(out, key)) refuse(`${label} repeats the field ${quoted(key)}.`);
    if (item !== null && item !== undefined) out[key] = item;
  }
  return out;
}
export function validId(value, label = 'Id') {
  if (typeof value !== 'string' || !ID.test(value)) refuse(`${label} must be a short id with no slashes or spaces.`);
  return value;
}
function text(value, label, max) {
  if (typeof value !== 'string' || value.length > max) refuse(`${label} must be text of at most ${max} characters.`);
  return value;
}
function list(value, label, max, each) {
  if (!Array.isArray(value) || value.length > max) refuse(`${label} must be a list of at most ${max} items.`);
  return value.map((item, index) => each(item, `${label} ${index + 1}`));
}
function enumValue(value, table, label) {
  const values = Object.values(table);
  if (Number.isInteger(value) && value >= 1 && value <= values.length) return values[value - 1];
  if (!values.includes(value)) refuse(`${label} must be one of ${values.join(', ')}.`);
  return value;
}
function plainJson(value, label, depth = 0) {
  if (depth > 32) refuse(`${label} is nested too deeply.`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) refuse(`${label} has an invalid number.`); return; }
  if (Array.isArray(value)) { for (const item of value) plainJson(item, label, depth + 1); return; }
  if (!isObject(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) refuse(`${label} must be plain JSON.`);
  for (const item of Object.values(value)) plainJson(item, label, depth + 1);
}
function json(value, label, max) {
  plainJson(value, label);
  const encoded = JSON.stringify(value);
  if (encoded.length > max) refuse(`${label} is too large.`);
  return JSON.parse(encoded);
}
function metadata(value, label) {
  if (!isObject(value)) refuse(`${label} must be an object.`);
  return json(value, label, 16384);
}
const charge = (budget, size) => { budget.left -= size; if (budget.left < 0) refuse(`The text is longer than ${budget.max} characters.`); };

function part(value, label, budget) {
  const out = fields(value, ['text', 'raw', 'url', 'data', 'metadata', 'filename', 'mediaType'], label);
  const content = ['text', 'raw', 'url', 'data'].filter((key) => Object.hasOwn(out, key));
  if (content.length !== 1) refuse(`${label} must have exactly one of text, raw, url, or data.`);
  if (out.text !== undefined) { text(out.text, label, budget.max); charge(budget, out.text.length); }
  if (out.raw !== undefined) { if (typeof out.raw !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(out.raw)) refuse(`${label} raw must be base64.`); charge(budget, out.raw.length); }
  if (out.url !== undefined) text(out.url, `${label} url`, 2048);
  if (out.data !== undefined) { out.data = json(out.data, `${label} data`, budget.max); charge(budget, JSON.stringify(out.data).length); }
  if (out.metadata !== undefined) out.metadata = metadata(out.metadata, `${label} metadata`);
  if (out.filename !== undefined) text(out.filename, `${label} filename`, 255);
  if (out.mediaType !== undefined) text(out.mediaType, `${label} media type`, 255);
  return out;
}
const parts = (value, label, budget) => {
  if (!Array.isArray(value) || value.length < 1) refuse(`${label} needs at least one part.`);
  return list(value, label, 8, (item, name) => part(item, name, budget));
};
function extension(value) {
  const out = fields(value, ['kind', 'project', 'hop', 'from', 'team', 'room', 'bot'], 'Peer metadata');
  if (!PEER_KINDS.includes(out.kind)) refuse(`Peer metadata kind must be one of ${PEER_KINDS.join(', ')}.`);
  if (out.project !== undefined && (typeof out.project !== 'string' || !HANDLE.test(out.project))) refuse('Peer metadata project must be a share handle.');
  if (!Number.isInteger(out.hop) || out.hop < 0 || out.hop > 16) refuse('Peer metadata hop must be a whole number from 0 to 16.');
  const from = fields(out.from, ['key', 'name'], 'Peer metadata sender');
  if (typeof from.key !== 'string' || !/^[0-9a-f]{64}$/.test(from.key)) refuse('Peer metadata sender key must be 64 hex characters.');
  if (typeof from.name !== 'string' || !from.name || from.name.length > 64 || sanitize(from.name, 64) !== from.name) refuse('Peer metadata sender name must be short plain text.');
  if (out.team !== undefined && typeof out.team !== 'boolean') refuse('Peer metadata team must be true or false.');
  // team: the ask went to the whole team (older peers drop the field and show a plain ask).
  // room: the team, and the channel in it or null for #general, the ask was sent in.
  let room = null;
  if (out.room !== undefined) {
    const where = fields(out.room, ['team', 'channel'], 'Peer metadata room');
    if (typeof where.team !== 'string' || !/^[0-9a-f]{64}$/.test(where.team) || where.channel != null && (typeof where.channel !== 'string' || !/^[0-9a-f]{16}$/.test(where.channel))) refuse('Peer metadata room must name a team and a channel.');
    room = { team: where.team, channel: where.channel ?? null };
  }
  // bot: the receiver's shared bot the question is for. A build from before bots drops the
  // field, so there the question goes to the person as a plain ask.
  if (out.bot !== undefined && (typeof out.bot !== 'string' || !BOT_NAME.test(out.bot))) refuse('Peer metadata bot must be a bot name.');
  return { kind: out.kind, project: out.project ?? null, hop: out.hop, from: { key: from.key, name: from.name }, ...(out.team ? { team: true } : {}), ...(room ? { room } : {}), ...(out.bot ? { bot: out.bot } : {}) };
}
function checkMessage(value, budget, label = 'Message') {
  const out = fields(value, ['messageId', 'contextId', 'taskId', 'role', 'parts', 'metadata', 'extensions', 'referenceTaskIds'], label);
  validId(out.messageId, `${label} id`);
  if (out.contextId !== undefined) validId(out.contextId, `${label} context id`);
  if (out.taskId !== undefined) validId(out.taskId, `${label} task id`);
  out.role = enumValue(out.role, Role, `${label} role`);
  out.parts = parts(out.parts, `${label} part`, budget);
  if (out.extensions !== undefined) out.extensions = list(out.extensions, `${label} extensions`, 16, (uri, name) => text(uri, name, 256));
  if (out.referenceTaskIds !== undefined) out.referenceTaskIds = list(out.referenceTaskIds, `${label} reference task ids`, 16, validId);
  if (out.metadata !== undefined) {
    out.metadata = metadata(out.metadata, `${label} metadata`);
    if (Object.hasOwn(out.metadata, PEER_EXT)) {
      if (!out.extensions?.includes(PEER_EXT)) refuse(`${label} carries peer metadata without listing the peer extension.`);
      out.metadata[PEER_EXT] = extension(out.metadata[PEER_EXT]);
    }
  }
  return out;
}
export function validateMessage(value, { max = TEXT_MAX } = {}) {
  return checkMessage(value, { max, left: max });
}
function artifactShape(value, label, budget) {
  const out = fields(value, ['artifactId', 'name', 'description', 'parts', 'metadata', 'extensions'], label);
  validId(out.artifactId, `${label} id`);
  if (out.name !== undefined) text(out.name, `${label} name`, 200);
  if (out.description !== undefined) text(out.description, `${label} description`, 1000);
  out.parts = parts(out.parts, `${label} part`, budget);
  if (out.metadata !== undefined) out.metadata = metadata(out.metadata, `${label} metadata`);
  if (out.extensions !== undefined) out.extensions = list(out.extensions, `${label} extensions`, 16, (uri, name) => text(uri, name, 256));
  return out;
}
export function validateTask(value, { max = REVIEW_MAX } = {}) {
  const budget = { max, left: max };
  const out = fields(value, ['id', 'contextId', 'status', 'artifacts', 'history', 'metadata'], 'Task');
  validId(out.id, 'Task id');
  if (out.contextId !== undefined) validId(out.contextId, 'Task context id');
  const status = fields(out.status, ['state', 'message', 'timestamp'], 'Task status');
  status.state = enumValue(status.state, TaskState, 'Task state');
  if (status.message !== undefined) status.message = checkMessage(status.message, budget, 'Task status message');
  if (status.timestamp !== undefined && (typeof status.timestamp !== 'string' || !TIMESTAMP.test(status.timestamp))) refuse('Task status timestamp must be an ISO 8601 UTC time.');
  out.status = status;
  if (out.artifacts !== undefined) out.artifacts = list(out.artifacts, 'Task artifact', 32, (item, name) => artifactShape(item, name, budget));
  if (out.history !== undefined) out.history = list(out.history, 'Task history', 64, (item, name) => checkMessage(item, budget, name));
  if (out.metadata !== undefined) {
    out.metadata = metadata(out.metadata, 'Task metadata');
    if (Object.hasOwn(out.metadata, PEER_EXT) && !isObject(out.metadata[PEER_EXT])) refuse('Task peer metadata must be an object.');
  }
  return out;
}

// Builders. They return spec-form objects and run the same validators.
export const textPart = (value) => ({ text: String(value) });
export const dataPart = (value) => ({ data: value, mediaType: 'application/json' });
// A picture sent beside a message, as the v1.0 file part by reference: its bytes travel in
// elu.picture.put pieces, never in the message, and a build from before pictures ignores it.
export const PICTURE_URN = 'urn:elu-code:picture:';
export const filePart = ({ id, name, type, size, sha256 }) => ({ url: `${PICTURE_URN}${id}`, filename: name, mediaType: type, metadata: { [PEER_EXT]: { size, sha256 } } });
// A message's text sent ahead of it in elu.text.put pieces, as UTF-8 of that size and hash.
export const TEXT_URN = 'urn:elu-code:text:';
export const textRefPart = ({ id, size, sha256 }) => ({ url: `${TEXT_URN}${id}`, mediaType: 'text/plain', metadata: { [PEER_EXT]: { size, sha256 } } });
export function peerExt(value) {
  const ext = isObject(value?.metadata) ? value.metadata[PEER_EXT] : undefined;
  return isObject(ext) ? ext : null;
}
export function message({ role = Role.USER, text: body, parts: given, contextId, taskId, ext, messageId = crypto.randomUUID(), metadata: extra } = {}) {
  if (given === undefined && typeof body !== 'string') refuse('A message needs text or parts.');
  const value = { messageId, role, parts: given ?? [textPart(body)] };
  if (contextId !== undefined) value.contextId = contextId;
  if (taskId !== undefined) value.taskId = taskId;
  if (ext) value.extensions = [PEER_EXT];
  if (ext || extra) value.metadata = { ...extra, ...(ext ? { [PEER_EXT]: { project: null, hop: 1, ...ext } } : {}) };
  return validateMessage(value, { max: REVIEW_MAX });
}
function status(state, note, taskId, contextId) {
  const value = { state, timestamp: new Date().toISOString() };
  if (typeof note === 'string') value.message = message({ role: Role.AGENT, text: note, taskId, contextId });
  else if (note !== undefined) value.message = note;
  return value;
}
export function task({ id = crypto.randomUUID(), contextId, state = TaskState.SUBMITTED, statusMessage, artifacts, ext } = {}) {
  const value = { id };
  if (contextId !== undefined) value.contextId = contextId;
  value.status = status(state, statusMessage, id, contextId);
  if (artifacts?.length) value.artifacts = artifacts;
  if (ext) value.metadata = { [PEER_EXT]: ext };
  return validateTask(value);
}
export function artifact({ name, text: body, parts: given } = {}) {
  if (given === undefined && typeof body !== 'string') refuse('An artifact needs text or parts.');
  return { artifactId: crypto.randomUUID(), ...(name ? { name } : {}), parts: given ?? [textPart(body)] };
}
// ext replaces the task's peer metadata (null removes it), so a stale substate such as
// "awaiting-owner" never survives a later state. artifacts are appended.
export function withState(current, state, { message: note, ext, artifacts } = {}) {
  const before = validateTask(current);
  if (isTerminal(before.status.state) && state !== before.status.state) refuse('This task is already finished.');
  const next = { ...before, status: status(state, note, before.id, before.contextId) };
  if (artifacts?.length) next.artifacts = [...before.artifacts ?? [], ...artifacts];
  if (ext !== undefined) {
    const meta = { ...before.metadata };
    if (ext === null) delete meta[PEER_EXT]; else meta[PEER_EXT] = ext;
    if (Object.keys(meta).length) next.metadata = meta; else delete next.metadata;
  }
  return validateTask(next);
}

// JSON-RPC 2.0. Core params are validated and normalised before a handler sees them;
// results are validated so only spec-form objects leave this machine.
function sendParams(value) {
  const out = fields(value, ['tenant', 'message', 'configuration', 'metadata'], 'SendMessage params');
  if (out.tenant !== undefined) text(out.tenant, 'Tenant', 128);
  if (out.message === undefined) refuse('SendMessage needs a message.');
  out.message = validateMessage(out.message, { max: TEXT_MAX });
  if (out.configuration !== undefined) {
    const config = fields(out.configuration, ['acceptedOutputModes', 'taskPushNotificationConfig', 'historyLength', 'returnImmediately'], 'SendMessage configuration');
    if (config.taskPushNotificationConfig !== undefined) throw a2aError(ErrorCode.PUSH_NOTIFICATION_NOT_SUPPORTED, 'Push notifications are not supported.');
    if (config.acceptedOutputModes !== undefined) config.acceptedOutputModes = list(config.acceptedOutputModes, 'Accepted output modes', 16, (mode, name) => text(mode, name, 255));
    if (config.historyLength !== undefined && (!Number.isInteger(config.historyLength) || config.historyLength < 0)) refuse('History length must be a whole number.');
    if (config.returnImmediately !== undefined && typeof config.returnImmediately !== 'boolean') refuse('returnImmediately must be true or false.');
    out.configuration = config;
  }
  if (out.metadata !== undefined) out.metadata = metadata(out.metadata, 'SendMessage metadata');
  return out;
}
function taskParams(keys, label) {
  return (value) => {
    const out = fields(value, keys, label);
    if (out.tenant !== undefined) text(out.tenant, 'Tenant', 128);
    validId(out.id, 'Task id');
    if (out.historyLength !== undefined && (!Number.isInteger(out.historyLength) || out.historyLength < 0)) refuse('History length must be a whole number.');
    if (out.metadata !== undefined) out.metadata = metadata(out.metadata, `${label} metadata`);
    return out;
  };
}
const PARAMS = {
  SendMessage: sendParams,
  GetTask: taskParams(['tenant', 'id', 'historyLength'], 'GetTask params'),
  CancelTask: taskParams(['tenant', 'id', 'metadata'], 'CancelTask params'),
};
function sendResult(value) {
  if (isObject(value) && Object.keys(value).length === 1 && (value.task || value.message)) return value.task ? { task: validateTask(value.task) } : { message: validateMessage(value.message, { max: REVIEW_MAX }) };
  if (isObject(value) && Object.hasOwn(value, 'status')) return { task: validateTask(value) };
  if (isObject(value) && Object.hasOwn(value, 'messageId')) return { message: validateMessage(value, { max: REVIEW_MAX }) };
  throw new Error('SendMessage returned neither a task nor a message.');
}
const RESULTS = { SendMessage: sendResult, GetTask: (value) => validateTask(value), CancelTask: (value) => validateTask(value) };
function unknownMethod(method) {
  if (PUSH_METHODS.includes(method)) return a2aError(ErrorCode.PUSH_NOTIFICATION_NOT_SUPPORTED, 'Push notifications are not supported.');
  if (CORE_METHODS.includes(method)) return a2aError(ErrorCode.UNSUPPORTED_OPERATION, `${method} is not supported.`);
  return a2aError(ErrorCode.METHOD_NOT_FOUND, 'Method not found.');
}
const validRpcId = (id) => id === null || (typeof id === 'string' && id.length <= 128) || Number.isSafeInteger(id);

// Returns async handle(request, ctx): a JSON-RPC response object, or null for a
// notification. onError(error) sees internal failures, which never reach the caller.
// trusted(ctx), or ctx.trusted, keeps paths in refusal messages for a trusted peer.
export function createRpcHandler(methods = {}, { onError, trusted } = {}) {
  const has = (name) => Object.hasOwn(methods, name) && typeof methods[name] === 'function';
  return async function handle(request, ctx = {}) {
    if (!isObject(request)) return rpcError(null, ErrorCode.INVALID_REQUEST, Array.isArray(request) ? 'Batch requests are not supported.' : 'Invalid request.');
    const notification = !Object.hasOwn(request, 'id'), id = notification ? null : request.id;
    if (request.jsonrpc !== '2.0' || !validRpcId(id) || typeof request.method !== 'string' || !request.method || request.method.length > 128) {
      return rpcError(validRpcId(id) ? id : null, ErrorCode.INVALID_REQUEST, 'Invalid request.');
    }
    const { method } = request;
    let result;
    try {
      const params = request.params === undefined ? {} : request.params;
      if (!isObject(params)) throw a2aError(ErrorCode.INVALID_PARAMS, 'Params must be an object.');
      if (!has(method)) throw unknownMethod(method);
      const input = Object.hasOwn(PARAMS, method) ? PARAMS[method](params) : params;
      const output = await methods[method](input, ctx);
      try { result = Object.hasOwn(RESULTS, method) ? RESULTS[method](output) : output; }
      catch (error) { onError?.(error); throw new Error('Invalid handler result.'); }
    } catch (error) {
      if (notification) { onError?.(error); return null; }
      return { jsonrpc: '2.0', id, error: errorObject(error, onError, { trusted: trustedCaller(trusted, ctx) }) };
    }
    return notification ? null : { jsonrpc: '2.0', id, result: result ?? null };
  };
}
