import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomic, noSymlinks, readJson, refuse } from '../util.mjs';
import { waitLock } from '../state.mjs';
import { peerFile, peerRepo } from './paths.mjs';
import { sanitize } from './peerdata.mjs';
import { A2A_VERSION, PEER_EXT, ErrorCode, createRpcHandler, rpcError } from './a2a.mjs';

// The local A2A endpoint (docs/peer-network.md, "Local A2A endpoint"): JSON-RPC 2.0
// over HTTP on 127.0.0.1 only. Every request needs the bearer token, a loopback Host
// (so a DNS-rebinding page cannot reach it) and no Origin header (so no web page can).
// @a2a-js/sdk 1.3.0 reads only /.well-known/agent-card.json and falls back to
// SendMessage when the card says streaming is off, so there is no SSE here.
const BODY_MAX = 1024 * 1024;
const DRAIN_MAX = 8 * 1024 * 1024;
const CARD_PATH = '/.well-known/agent-card.json';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PEER_PATH = /^\/a2a\/peer\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;
const HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();
let packageVersion;
const version = () => packageVersion ??= readJson(fileURLToPath(new URL('../../package.json', import.meta.url))).version;

// Reads the token, creating it (32 random bytes, hex, mode 0600) when missing.
export function localToken(file = peerFile('local-a2a.token')) {
  noSymlinks(file);
  if (!fs.existsSync(file)) {
    const release = waitLock(peerRepo(), 'local-a2a');
    try { if (!fs.existsSync(file)) atomic(file, `${crypto.randomBytes(32).toString('hex')}\n`); } finally { release(); }
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) refuse('The local A2A token file must be private to you.');
  const token = fs.readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(token)) refuse('The local A2A token file is not valid.');
  return token;
}

export function buildAgentCard({ name = 'elu-code', shares = [], teammates = [], url, version: cardVersion } = {}) {
  if (typeof url !== 'string' || !/^http:\/\/(127\.0\.0\.1|localhost):\d+\//.test(url)) refuse('The agent card needs the local endpoint URL.');
  const skills = [
    ...shares.filter((share) => NAME.test(share?.handle ?? '')).map(({ handle }) => ({
      id: `project:${handle}`, name: handle, tags: ['project', 'code'],
      description: `Work in ${handle}. Post to /a2a with metadata.project "${handle}".`,
    })),
    ...teammates.filter((mate) => NAME.test(mate?.name ?? '')).map(({ name: mate }) => ({
      id: `teammate:${mate}`, name: `@${mate}`, tags: ['teammate', 'ask'],
      description: `Ask @${mate}'s agent. Post to /a2a/peer/${mate}.`,
    })),
  ];
  // AgentCard.skills is REQUIRED, and required lists must not be empty (spec §5.7).
  if (!skills.length) skills.push({ id: 'agent', name: 'Agent', tags: ['code'], description: 'Ask or task the agent on this machine.' });
  return {
    name: sanitize(name, 64).trim() || 'elu-code',
    description: 'ELU agent on this machine. It can also ask your teammates. SendMessage returns the task at once; poll GetTask for the answer.',
    supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: A2A_VERSION }],
    version: cardVersion ?? version(),
    capabilities: {
      streaming: false, pushNotifications: false, extendedAgentCard: false,
      extensions: [{ uri: PEER_EXT, description: 'Peer metadata: kind, project, hop, from.', required: false }],
    },
    securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer', description: 'Token from local-a2a.json.' } } },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills,
  };
}

// A2A-Version is Major.Minor; a patch number is ignored and an empty value means 0.3 (spec §3.6).
const versionOk = (value) => { const match = /^\s*(\d+)\.(\d+)(?:\.\d+)?\s*$/.exec(value ?? ''); return Boolean(match) && `${Number(match[1])}.${Number(match[2])}` === A2A_VERSION; };
const extensionsOf = (value) => String(value ?? '').split(',').map((uri) => uri.trim()).filter(Boolean).slice(0, 16).map((uri) => uri.slice(0, 256));
const requestId = (request) => {
  const id = request?.id;
  return id === null || typeof id === 'string' && id.length <= 128 || Number.isSafeInteger(id) ? id ?? null : null;
};
function send(res, status, text, extra = {}) {
  const body = `${text}\n`;
  res.writeHead(status, { ...HEADERS, ...extra, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sendJson(res, value) {
  const body = JSON.stringify(value);
  res.writeHead(200, { ...HEADERS, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
// Resolves to the body text, or null after answering 413 (or when the client went away).
function readBody(req, res) {
  return new Promise((resolve) => {
    let size = 0, done = false;
    const chunks = [];
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const tooLarge = (cut = false) => {
      send(res, 413, 'The request is larger than 1 MiB.', { Connection: 'close' });
      if (cut) res.once('finish', () => req.destroy());
      finish(null);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > DRAIN_MAX) return req.destroy();
      if (done) return;
      if (size > BODY_MAX) return tooLarge();
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { finish(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { finish(''); }
    });
    req.on('close', () => finish(null));
    const declared = Number(req.headers['content-length']);
    if (declared > BODY_MAX) tooLarge(declared > DRAIN_MAX);
  });
}

// dispatch(method, params, {path, peerName, extensions}) returns the method's result
// (a Task, or for SendMessage a Task or Message) or throws refuse()/a2aError().
export async function startLocalA2A({ dispatch, card, host = '127.0.0.1', port = 0, tokenFile = peerFile('local-a2a.token'), writeState = false } = {}) {
  if (typeof dispatch !== 'function') refuse('The local A2A endpoint needs a dispatch function.');
  if (host !== '127.0.0.1') refuse('The local A2A endpoint listens only on 127.0.0.1.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) refuse('Choose a port from 0 to 65535.');
  const token = localToken(tokenFile), expected = digest(`Bearer ${token}`);
  const route = (method) => (params, ctx) => dispatch(method, params, ctx);
  const rpc = createRpcHandler({ SendMessage: route('SendMessage'), GetTask: route('GetTask'), CancelTask: route('CancelTask') });
  let bound = 0;
  const cardFor = () => {
    const url = `http://127.0.0.1:${bound}/a2a`;
    return typeof card === 'function' ? card({ url }) : card ?? buildAgentCard({ url });
  };
  async function serve(req, res) {
    if (req.headers.origin !== undefined) return send(res, 403, 'Requests from web pages are refused.');
    const hostHeader = String(req.headers.host ?? '').toLowerCase();
    if (hostHeader !== `127.0.0.1:${bound}` && hostHeader !== `localhost:${bound}`) return send(res, 421, 'This endpoint answers only on 127.0.0.1.');
    if (!crypto.timingSafeEqual(digest(req.headers.authorization ?? ''), expected)) return send(res, 401, 'Missing or wrong token.', { 'WWW-Authenticate': 'Bearer' });
    const pathname = req.url.split(/[?#]/)[0];
    if (pathname === CARD_PATH) return req.method === 'GET' ? sendJson(res, cardFor()) : send(res, 405, 'Use GET.', { Allow: 'GET' });
    const peer = PEER_PATH.exec(pathname);
    if (pathname !== '/a2a' && !peer) return send(res, 404, 'Not found.');
    if (req.method !== 'POST') return send(res, 405, 'Use POST.', { Allow: 'POST' });
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json' && type !== 'application/a2a+json') return send(res, 415, 'Send application/json.');
    const body = await readBody(req, res);
    if (body === null) return;
    let request;
    try { request = JSON.parse(body); } catch { return sendJson(res, rpcError(null, ErrorCode.PARSE_ERROR, 'Invalid JSON payload.')); }
    if (!versionOk(req.headers['a2a-version'])) return sendJson(res, rpcError(requestId(request), ErrorCode.VERSION_NOT_SUPPORTED, `Only A2A ${A2A_VERSION} is supported.`, { supportedVersions: A2A_VERSION }));
    const response = await rpc(request, { path: pathname, peerName: peer?.[1] ?? null, extensions: extensionsOf(req.headers['a2a-extensions']) });
    if (response === null) { res.writeHead(204, HEADERS); return res.end(); }
    sendJson(res, response);
  }
  const server = http.createServer({ requestTimeout: 30000, headersTimeout: 10000, maxHeaderSize: 16384 }, (req, res) => {
    serve(req, res).catch(() => { if (!res.headersSent) send(res, 500, 'Internal error.'); else res.destroy(); });
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve(); }); });
  bound = server.address().port;
  const stateFile = peerFile('local-a2a.json');
  if (writeState) { atomic(stateFile, { port: bound, token }); fs.chmodSync(stateFile, 0o600); }
  async function close() {
    const closed = new Promise((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    if (!writeState) return;
    try { noSymlinks(stateFile); if (readJson(stateFile).port === bound) fs.unlinkSync(stateFile); } catch { /* Already gone or replaced by another endpoint. */ }
  }
  return { port: bound, token, url: `http://127.0.0.1:${bound}`, close };
}
