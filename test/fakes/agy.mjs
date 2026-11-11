// The fake Antigravity CLI tests run instead of the real one. fakeClis() in helpers.mjs
// copies it to a bin folder (adding the node shebang) next to fake.json, which holds the
// test's mode, the files it records to, and an `agy` object: signedIn (default true),
// ignoreDenies (a broken vendor that writes anyway), noPermissionRequest (an ACP server
// that never asks). Run from test/fakes/ directly, with no fake.json beside it, it exits 2:
// no path may reach the source file as a program. It honors what the adapter relies on:
// the private HOME's settings.json and hooks.json (the hook command really runs),
// --sandbox, --dangerously-skip-permissions, --conversation under
// <HOME>/.gemini/antigravity-cli/brain, soft-denies in -p (exit 0, a stderr notice naming
// the tool), the /usage sign-in probe, and `acp` with session/request_permission.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import readline from 'node:readline'; import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
let cfg = null; try { cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), 'fake.json'), 'utf8')); } catch { /* Not installed as a test CLI. */ }
if (!cfg) { console.error('fake agy: not installed as a test CLI (no fake.json beside it)'); process.exit(2); }
const agy = cfg.agy ?? {};
if (cfg.calls) fs.appendFileSync(cfg.calls, JSON.stringify({ vendor: 'agy', args, home: process.env.HOME ?? null, autoUpdate: process.env.AGY_CLI_DISABLE_AUTO_UPDATE ?? null }) + '\n');
if (args.includes('--version')) { console.log('agy version 1.5.4'); process.exit(0); }
if (args.includes('--help')) { console.log('Usage: agy [flags]\n  --output-format --json-schema --conversation --mode --sandbox --add-dir --print-timeout --dangerously-skip-permissions'); process.exit(0); }
const HOME = process.env.HOME ?? '';
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const settings = readJson(path.join(HOME, '.gemini', 'antigravity-cli', 'settings.json')) ?? {};
const hooks = readJson(path.join(HOME, '.gemini', 'config', 'hooks.json'));
const brain = path.join(HOME, '.gemini', 'antigravity-cli', 'brain');
const flag = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : null; };
const notice = (tool, rule) => process.stderr.write(`agy: soft-denied ${tool} (${rule})\n`);
const ACTION = { write_to_file: 'write_file', run_command: 'command', read_url: 'read_url', search_web: null };
const KIND = { write_to_file: 'edit', run_command: 'execute', read_url: 'fetch', search_web: 'search' };

// The hooks.json PreToolUse entries whose matcher names the tool run, with the call on stdin.
function hookDecision(tool, input, cwd) {
  for (const entry of hooks?.hooks?.PreToolUse ?? []) {
    if (!new RegExp(`^(?:${entry.matcher})$`).test(tool)) continue;
    for (const hook of entry.hooks ?? []) {
      const r = spawnSync('/bin/sh', ['-c', hook.command], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd }), encoding: 'utf8', env: process.env, timeout: (hook.timeout ?? 10) * 1000 });
      if (r.status === 2) return 'deny';
      try { const out = JSON.parse(r.stdout); if (['deny', 'ask'].includes(out.decision)) return out.decision; } catch { /* No opinion. */ }
    }
  }
  return null;
}
const ruleMatches = (rules, action, target) => (rules ?? []).some(rule => { const m = /^([a-z_]+)\((.*)\)$/.exec(rule); return m && m[1] === action && (m[2] === '*' || target === m[2] || (m[2].endsWith('/') && target.startsWith(m[2]))); });
// Hook deny, settings deny and the sandbox refuse; a hook ask, a settings ask or an outside
// write asks, which headless mode cannot do; otherwise the tool runs.
function permit(tool, input, { cwd, skip, sandbox }) {
  if (skip) return { verdict: 'allow' };
  const action = ACTION[tool], target = tool === 'write_to_file' ? input.TargetFile : tool === 'run_command' ? input.CommandLine.split(/\s+/)[0] : input.Url ?? '';
  const outside = tool === 'write_to_file' && !target.startsWith(`${cwd}${path.sep}`);
  const hook = hookDecision(tool, input, cwd);
  if (hook === 'deny') return { verdict: 'deny', rule: 'hook' };
  if (action && ruleMatches(settings.permissions?.deny, action, target)) return { verdict: 'deny', rule: `permissions.deny: ${action}` };
  if (sandbox && (outside || tool === 'read_url')) return { verdict: 'deny', rule: 'sandbox' };
  if (hook === 'ask') return { verdict: 'ask', rule: 'hook' };
  if (action && ruleMatches(settings.permissions?.ask, action, target)) return { verdict: 'ask', rule: `permissions.ask: ${action}` };
  if (outside && settings.allowNonWorkspaceAccess !== true) return { verdict: 'ask', rule: 'outside the workspace' };
  return { verdict: 'allow' };
}
// The "model": it attempts exactly what the prompt names.
function plan(text, cwd) {
  const attempts = [], clean = value => value.replace(/[.,;]+$/, '');
  for (const m of text.matchAll(/\b[Cc]reate (?:a |the )?file (?:named )?(\S+)/g)) attempts.push({ tool: 'write_to_file', input: { TargetFile: path.resolve(cwd, clean(m[1])), CodeContent: 'elu-code\n' } });
  const run = /\b[Rr]un (?:this |the )?command(?: and report its output)?:?\s+(\S+)/.exec(text); if (run) attempts.push({ tool: 'run_command', input: { CommandLine: clean(run[1]), Cwd: cwd } });
  const url = /\b[Ff]etch (https?:\/\/\S+)/.exec(text); if (url) attempts.push({ tool: 'read_url', input: { Url: clean(url[1]) } });
  const search = /\b[Ss]earch the web for ([^.\n]+)/.exec(text); if (search) attempts.push({ tool: 'search_web', input: { query: search[1] } });
  return attempts;
}
async function perform({ tool, input }) {
  if (tool === 'write_to_file') { fs.mkdirSync(path.dirname(input.TargetFile), { recursive: true }); fs.writeFileSync(input.TargetFile, input.CodeContent); return `Created ${input.TargetFile}.`; }
  if (tool === 'run_command') { const r = spawnSync('/bin/sh', ['-c', input.CommandLine], { cwd: input.Cwd, encoding: 'utf8' }); return `Ran ${input.CommandLine} (exit ${r.status}).`; }
  if (tool === 'read_url') { try { const r = await fetch(input.Url); return `Fetched ${input.Url}: ${r.status}.`; } catch (error) { return `Fetch failed: ${error.message}`; } }
  return `Searched the web for ${input.query}.`;
}
// One turn: ask is the ACP permission request (null in headless mode), dir the conversation's folder.
async function turn(text, { cwd, skip, sandbox, ask, dir }) {
  const done = [], denied = [];
  for (const attempt of plan(text, cwd)) {
    let { verdict, rule } = permit(attempt.tool, attempt.input, { cwd, skip, sandbox });
    if (verdict === 'ask') {
      if (ask && agy.noPermissionRequest) verdict = 'allow';
      else if (ask) { verdict = (await ask(attempt)) === 'allow' ? 'allow' : 'deny'; rule = 'permission request rejected'; }
      else { verdict = 'deny'; rule = `${rule}; headless`; }
    }
    if (verdict === 'deny' && !agy.ignoreDenies) { notice(attempt.tool, rule); denied.push(`${attempt.tool} denied (${rule})`); continue; }
    done.push(await perform(attempt));
  }
  const nonce = /\b[Rr]emember (?:this )?nonce:? ([0-9a-f-]{36})/.exec(text); if (nonce) fs.writeFileSync(path.join(dir, 'nonce'), nonce[1]);
  // The quotes may be JSON-escaped: the runner carries the goal in a data block.
  let summary = /summary \\?"([^"\\]+)\\?"/.exec(text)?.[1] ?? ([...done, ...denied].join(' ') || 'Nothing to do.');
  if (/nonce from earlier/.test(text)) { try { summary = fs.readFileSync(path.join(dir, 'nonce'), 'utf8'); } catch { summary = 'No nonce in this conversation.'; } }
  return { outcome: denied.length && !done.length ? 'blocked' : 'done', summary, question: null, choices: [], comments: [], responses: [] };
}
async function headless() {
  const prompt = flag('-p') ?? '';
  if (agy.signedIn === false) { console.error('authentication required: run agy to sign in'); process.exit(1); }
  if (prompt === '/usage') { console.log(JSON.stringify({ usage: { plan: 'fake' } })); process.exit(0); }
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  if (cfg.inputs) fs.appendFileSync(cfg.inputs, JSON.stringify({ vendor: 'agy', args, input }) + '\n');
  const text = `${prompt}\n${input}`, cwd = process.cwd(), conversation = flag('--conversation'), id = conversation ?? crypto.randomUUID(), dir = path.join(brain, id);
  if (conversation && !fs.existsSync(dir)) { console.error(`conversation not found: ${conversation}`); process.exit(1); }
  fs.mkdirSync(dir, { recursive: true });
  const schema = flag('--json-schema') ? readJson(flag('--json-schema')) : null;
  const result = await turn(text, { cwd, skip: args.includes('--dangerously-skip-permissions'), sandbox: args.includes('--sandbox'), ask: null, dir });
  if (schema?.properties?.intent) { result.intent = 'answer'; if (schema.properties.repository) result.repository = ''; }
  if (cfg.name !== undefined && schema?.properties?.name) result.name = cfg.name;
  console.log(JSON.stringify({ conversationId: id, model: 'gemini-3-pro', structured_output: result, stats: { turns: 1 } }, null, 2));
}
async function acp() {
  const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  const waiting = new Map(), sessions = new Map(); let nextId = 100;
  const request = (method, params) => new Promise(resolve => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
  async function handle(row) {
    const reply = result => send({ jsonrpc: '2.0', id: row.id, result }), fail = (code, message) => send({ jsonrpc: '2.0', id: row.id, error: { code, message } }), p = row.params ?? {};
    switch (row.method) {
      case 'initialize': reply({ protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] }); break;
      case 'session/new': { if (agy.signedIn === false) return fail(-32000, 'authentication required'); const id = crypto.randomUUID(); fs.mkdirSync(path.join(brain, id), { recursive: true }); sessions.set(id, { cwd: p.cwd }); reply({ sessionId: id }); break; }
      case 'session/resume': { if (typeof p.sessionId !== 'string' || !fs.existsSync(path.join(brain, p.sessionId))) return fail(-32602, 'conversation not found'); sessions.set(p.sessionId, { cwd: p.cwd }); reply({ sessionId: p.sessionId }); break; }
      case 'session/set_mode': { if (!sessions.has(p.sessionId)) return fail(-32602, 'unknown session'); if (!['accept-edits', 'auto'].includes(p.modeId)) return fail(-32602, 'unknown mode'); sessions.get(p.sessionId).mode = p.modeId; reply({}); break; }
      case 'session/prompt': {
        const session = sessions.get(p.sessionId); if (!session) return fail(-32602, 'unknown session');
        const text = (p.prompt ?? []).filter(block => block?.type === 'text').map(block => block.text).join('\n');
        const update = chunk => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } } } });
        update('Working on it.\n');
        const ask = async attempt => {
          const title = attempt.tool === 'write_to_file' ? `Write ${attempt.input.TargetFile}` : attempt.tool === 'run_command' ? `Run ${attempt.input.CommandLine}` : `${attempt.tool} ${attempt.input.Url ?? attempt.input.query ?? ''}`.trim();
          const answer = await request('session/request_permission', { sessionId: p.sessionId, toolCall: { toolCallId: `call-${nextId}`, title, kind: KIND[attempt.tool], rawInput: attempt.input }, options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] });
          return answer?.outcome?.outcome === 'selected' && answer.outcome.optionId === 'allow-once' ? 'allow' : 'deny';
        };
        const result = await turn(text, { cwd: session.cwd, skip: false, sandbox: false, ask, dir: path.join(brain, p.sessionId) });
        // The runner's conversation schema rides in the prompt: an answer turn.
        if (/"intent"\s*:\s*\{/.test(text)) { result.intent = 'answer'; if (/"repository"\s*:\s*\{/.test(text)) result.repository = ''; }
        if (cfg.name !== undefined && /"name"\s*:\s*\{"type"/.test(text)) result.name = cfg.name;
        update(`Here is the result:\n${JSON.stringify(result, null, 2)}\n`);
        reply({ stopReason: 'end_turn' }); break;
      }
      case 'session/cancel': break;
      default: fail(-32601, 'Method not found');
    }
  }
  // Replies to this server's own requests arrive while a prompt is in flight, so nothing blocks the read loop.
  for await (const line of readline.createInterface({ input: process.stdin })) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.id !== undefined && row.method === undefined) { waiting.get(row.id)?.(row.error ? null : row.result); waiting.delete(row.id); continue; }
    if (row.id === undefined) continue;
    handle(row);
  }
  process.exit(0);
}
if (args[0] === 'acp') await acp(); else await headless();
