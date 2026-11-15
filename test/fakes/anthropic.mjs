// The stand-in Anthropic API that tests, and a run of the real app on a test machine, send
// Claude Code's requests to through ELU's Claude relay (lib/claude-relay.mjs), which reaches it
// by ELU_TEST_ANTHROPIC_URL: nothing leaves the computer. It answers as the real API answered
// Claude Code 2.1.325 in a probe: the same anthropic-ratelimit-unified-* headers, an event
// stream for a message, and its refusals.
//
// standInAnthropic(file) starts it in this process on 127.0.0.1: { url, close(), calls(),
// set(edit) }. As a script, `node anthropic.mjs <config.json>` writes its address to
// <config.json>.url and runs until it is stopped.
//
// The config file is read again on every request, so a test, or a person, changes what it does
// while it runs: { accounts: { "<access token>": { email, fiveHour, weekly, mode, after, times,
// retryAfter, expiresIn } }, refresh: { "<refresh token>": "<access token>" } }.
//   fiveHour, weekly: the share of each window an answer reports (0..1).
//   mode: ok (the default); weekly or fiveHour, refused at that limit; opus, refused at the
//   weekly limit of Opus models only; minute, refused for a per-minute slowdown (retry-after:
//   retryAfter seconds, 1 by default), `times` times, then ok; claimOnly, the same slowdown
//   with the account as a whole rejected (status rejected, a representative claim) while each
//   window allowed it; headerless, refused with no headers `times` times, then ok; billing,
//   refused for billing (402); expired, refused as a sign-in that ended (401). after: ok for
//   that many requests on the token first.
//   delayMs: an answer comes that much later. A token that is not listed is refused as an
//   unknown sign-in (401). Each answer's row says how many of its account's requests were being
//   answered at once (active).
// /v1/oauth/token renews a sign-in as Anthropic's does: the refresh token for a new access
// token and a new refresh token. The old access token then gets 401, and the old refresh token
// is refused (invalid_grant).
// Every request is recorded to <config.json>.calls.jsonl: when, its path, the account its token
// names, the token's tag (tagOf: the start of its SHA-256, never the token), its model, the
// account_uuid of its metadata, and the status it got.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const tagOf = token => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
const H = 'anthropic-ratelimit-unified-';
const seconds = () => Math.floor(Date.now() / 1000);
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { accounts: {}, refresh: {} }; } };
const write = (file, value) => { const draft = `${file}.${process.pid}.tmp`; fs.writeFileSync(draft, JSON.stringify(value, null, 1)); fs.renameSync(draft, file); };
// The windows of an answer, as the real API sends them: a status, a share and a reset for each.
function windows(account, { rejected = null, model = null } = {}) {
  const fiveReset = seconds() + 3 * 3600, weekReset = seconds() + (account.weeklyResetIn ?? 3 * 86400);
  const five = rejected === 'fiveHour' ? 1 : account.fiveHour ?? 0.2, week = rejected === 'weekly' ? 1 : account.weekly ?? 0.3;
  const headers = {
    [`${H}status`]: rejected ? 'rejected' : 'allowed',
    [`${H}5h-status`]: rejected === 'fiveHour' ? 'rejected' : 'allowed', [`${H}5h-utilization`]: String(five), [`${H}5h-reset`]: String(fiveReset),
    [`${H}7d-status`]: rejected === 'weekly' ? 'rejected' : 'allowed', [`${H}7d-utilization`]: String(week), [`${H}7d-reset`]: String(weekReset),
    [`${H}representative-claim`]: rejected === 'fiveHour' ? 'five_hour' : 'seven_day',
    [`${H}reset`]: String(rejected === 'fiveHour' ? fiveReset : weekReset),
    [`${H}overage-status`]: 'rejected', [`${H}overage-disabled-reason`]: 'out_of_credits',
  };
  if (model) Object.assign(headers, { [`${H}status`]: 'rejected', [`${H}7d_${model}-status`]: 'rejected', [`${H}7d_${model}-utilization`]: '1.0', [`${H}7d_${model}-reset`]: String(weekReset), [`${H}representative-claim`]: `seven_day_${model}`, [`${H}reset`]: String(weekReset) });
  return headers;
}
const error = (res, status, type, message, headers = {}) => { const body = JSON.stringify({ type: 'error', error: { type, message }, request_id: 'req_standin' }); res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_standin', 'content-length': Buffer.byteLength(body), ...headers }); res.end(body); };
// A message, streamed as the real API streams one.
function message(res, headers, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_standin', ...headers });
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event('message_start', { message: { id: 'msg_standin', type: 'message', role: 'assistant', model: model ?? 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } });
  event('message_stop', {}); res.end();
}
export function standInAnthropic(file) {
  const callsFile = `${file}.calls.jsonl`, counts = new Map(), active = new Map();
  const record = row => fs.appendFileSync(callsFile, `${JSON.stringify({ at: Date.now(), ...row })}\n`);
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', part => parts.push(part));
    req.on('end', () => {
      const text = Buffer.concat(parts).toString('utf8'), url = new URL(req.url, 'http://standin');
      let body = null; try { body = JSON.parse(text); } catch { body = null; }
      const config = read(file);
      if (url.pathname === '/v1/oauth/token' && req.method === 'POST') {
        const old = body?.refresh_token, access = typeof old === 'string' ? config.refresh?.[old] : null;
        if (!access || !config.accounts?.[access]) { record({ path: url.pathname, status: 400 }); return error(res, 400, 'invalid_grant', 'Refresh token is invalid.'); }
        const n = (config.renewed ?? 0) + 1, next = `${access.replace(/-r\d+$/, '')}-r${n}`, nextRefresh = `${old.replace(/-r\d+$/, '')}-r${n}`;
        const account = config.accounts[access]; delete config.accounts[access]; delete config.refresh[old];
        config.accounts[next] = { ...account }; config.refresh[nextRefresh] = next; config.renewed = n; write(file, config);
        record({ path: url.pathname, status: 200, account: account.email, token: tagOf(next), was: tagOf(access) });
        const answer = JSON.stringify({ token_type: 'Bearer', access_token: next, refresh_token: nextRefresh, expires_in: account.renewedFor ?? 28800, scope: 'user:inference user:profile' });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(answer) }); res.end(answer); return;
      }
      const token = String(req.headers.authorization ?? '').replace(/^Bearer /, ''), account = config.accounts?.[token] ?? null;
      let uuid = null; try { uuid = JSON.parse(body?.metadata?.user_id ?? 'null')?.account_uuid ?? null; } catch { uuid = null; }
      const row = { path: url.pathname, account: account?.email ?? null, token: token ? tagOf(token) : null, model: body?.model ?? null, uuid, stream: body?.stream === true };
      if (url.pathname === '/v1/messages/count_tokens') { record({ ...row, status: 200 }); const answer = '{"input_tokens":10}'; res.writeHead(200, { 'content-type': 'application/json', 'content-length': answer.length }); res.end(answer); return; }
      if (url.pathname !== '/v1/messages') { record({ ...row, status: 404 }); return error(res, 404, 'not_found_error', 'Not found.'); }
      if (!account || account.mode === 'expired') { record({ ...row, status: 401 }); return error(res, 401, 'authentication_error', 'OAuth token has expired. Please obtain a new token or refresh your existing token.'); }
      const seen = (counts.get(token) ?? 0) + 1; counts.set(token, seen);
      const mode = seen > (account.after ?? 0) ? account.mode ?? 'ok' : 'ok', past = seen - (account.after ?? 0);
      const family = /\b(opus|sonnet|haiku|fable)\b/.exec(String(body?.model ?? '').replace(/-/g, ' '))?.[1] ?? null;
      if (mode === 'weekly' || mode === 'fiveHour') { record({ ...row, status: 429, window: mode }); return error(res, 429, 'rate_limit_error', 'This request would exceed your account\'s rate limit. Please try again later.', windows(account, { rejected: mode })); }
      if (mode === 'opus' && family === 'opus') { record({ ...row, status: 429, window: 'opus' }); return error(res, 429, 'rate_limit_error', 'This request would exceed your account\'s rate limit. Please try again later.', windows(account, { model: 'opus' })); }
      if (mode === 'minute' && past <= (account.times ?? 1)) { record({ ...row, status: 429, window: 'minute' }); return error(res, 429, 'rate_limit_error', 'Number of requests has exceeded your per-minute rate limit.', { ...windows(account), 'retry-after': String(account.retryAfter ?? 1) }); }
      if (mode === 'claimOnly' && past <= (account.times ?? 1)) { record({ ...row, status: 429, window: 'claimOnly' }); return error(res, 429, 'rate_limit_error', 'Number of requests has exceeded your per-minute rate limit.', { ...windows(account), [`${H}status`]: 'rejected', [`${H}representative-claim`]: 'five_hour', 'retry-after': String(account.retryAfter ?? 1) }); }
      if (mode === 'headerless' && past <= (account.times ?? 1)) { record({ ...row, status: 429, window: 'headerless' }); return error(res, 429, 'rate_limit_error', 'Too many requests.'); }
      if (mode === 'billing') { record({ ...row, status: 402 }); return error(res, 402, 'billing_error', 'Your credit balance is too low to access the Anthropic API.'); }
      const now = (active.get(account.email) ?? 0) + 1; active.set(account.email, now);
      setTimeout(() => { record({ ...row, status: 200, active: now }); message(res, windows(account), body?.model); active.set(account.email, active.get(account.email) - 1); }, account.delayMs ?? 0);
    });
  });
  server.on('clientError', (failure, socket) => { try { socket.destroy(); } catch { /* Gone. */ } });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    resolve({
      url, server,
      close: () => new Promise(done => { server.closeAllConnections?.(); server.close(() => done()); }),
      calls: () => { try { return fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } },
      set: edit => { const value = read(file); edit(value); write(file, value); },
      read: () => read(file),
    });
  }));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const file = process.argv[2];
  const api = await standInAnthropic(file);
  fs.writeFileSync(`${file}.url`, api.url);
}
