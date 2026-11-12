#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { approvalSummary, awaitDecision, requestApproval } from './approvals.mjs';
import { APPROVAL_WAIT_SECONDS } from './modes.mjs';
import { allowedBy } from './permission-rules.mjs';

// The live approval relay for Claude Code: a stdio MCP server with one tool,
// approve, named by --permission-prompt-tool. Claude calls it for every action its permission
// mode would prompt for; the call becomes a request file the terminal answers, and the reply
// is the one text block Claude expects. Newline-delimited JSON-RPC 2.0, no dependencies.
// Every message is answered without blocking the read loop, so a ping arriving while an
// approval waits is still answered, and an unknown method never hangs the run.
// A call one of the owner's rules or a default covers (lib/permission-rules.mjs) is allowed
// here without asking; --rules says which apply: saved (his own sessions) or defaults (a
// teammate's). Without --rules every call asks. --sandboxed yes: the turn's commands really run
// in Claude Code's sandbox; with no, every command counts as leaving it.
export const SERVER_NAME = 'elu-code-approval', TOOL_NAME = 'approve';
const DENIED = 'The owner declined this. Do not retry it another way. Finish without it and say what you could not do.';
const ID_CHARS = /[^A-Za-z0-9_-]/g, PLAIN = /^[A-Za-z0-9_-]{1,80}$/;

function options(argv) {
  const out = { session: null, root: null, task: null, role: null, vendor: null, log: null, wait: APPROVAL_WAIT_SECONDS, progress: 60, cwd: null, access: null, rules: null, sandboxed: 'no' };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, ''), value = argv[i + 1];
    if (!Object.hasOwn(out, name) || value === undefined) throw new Error(`Unknown or incomplete option: ${argv[i]}`);
    out[name] = ['wait', 'progress'].includes(name) ? Number(value) : value;
  }
  if (!PLAIN.test(out.session ?? '')) throw new Error('The approval server needs a plain --session id.');
  if (!(out.wait > 0) || !(out.progress > 0)) throw new Error('--wait and --progress are positive seconds.');
  if (out.log && !path.isAbsolute(out.log)) throw new Error('--log must be an absolute path.');
  if (out.cwd && !path.isAbsolute(out.cwd)) throw new Error('--cwd must be an absolute path.');
  if (out.access !== null && !['edit', 'read'].includes(out.access)) throw new Error('--access is edit or read.');
  if (out.rules !== null && !['saved', 'defaults'].includes(out.rules)) throw new Error('--rules is saved or defaults.');
  if (!['yes', 'no'].includes(out.sandboxed)) throw new Error('--sandboxed is yes or no.');
  return out;
}
const timeoutText = wait => `No answer from the owner within ${Math.max(1, Math.round(wait / 60))} minutes. Do not retry it another way; say what you need.`;
const TOOL = { name: TOOL_NAME, description: 'Asks the owner of this session to allow or deny a tool call.', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] } };

export async function serve({ argv = process.argv.slice(2), input = process.stdin, output = process.stdout } = {}) {
  const opts = options(argv);
  const send = value => { try { output.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`); } catch { /* Claude closed the pipe; the run is over. */ } };
  const reply = (id, result) => send({ id, result }), fail = (id, code, message) => send({ id, error: { code, message } });
  let calls = 0;
  const record = row => { if (opts.log) { try { fs.appendFileSync(opts.log, `${JSON.stringify(row)}\n`, { mode: 0o600 }); } catch { /* The decision still reaches Claude. */ } } };
  async function approve(id, params) {
    const args = params?.arguments ?? {};
    const tool = typeof args.tool_name === 'string' && args.tool_name.trim() ? args.tool_name.slice(0, 120) : 'unknown';
    const use = String(args.tool_use_id ?? '').replace(ID_CHARS, '').slice(0, 78) || `call-${++calls}`;
    const approvalId = `${opts.session}-${use}`;
    // A rule or a default answers at once; nothing is written for the owner to answer.
    let ruled = null;
    if (opts.rules) { try { ruled = allowedBy(tool, args.input, { project: opts.root || null, cwd: opts.cwd, access: opts.access, saved: opts.rules === 'saved', sandboxed: opts.sandboxed === 'yes' }); } catch { ruled = null; } }
    if (ruled) { record({ id: approvalId, tool, summary: approvalSummary(tool, args.input), decision: 'allow', by: ruled.by, rule: ruled.text, at: new Date().toISOString() }); return reply(id, text({ behavior: 'allow' })); }
    let summary;
    try { ({ summary } = requestApproval({ id: approvalId, root: opts.root, taskId: opts.task, role: opts.role, vendor: opts.vendor, tool, input: args.input, waitSeconds: opts.wait, cwd: opts.cwd, access: opts.access, rules: opts.rules, sandboxed: opts.sandboxed === 'yes' })); }
    catch (error) {
      // The same call asked twice waits on the first request; anything else is answered as a denial.
      if (!/already requested/.test(error.message)) { record({ id: approvalId, tool, summary: approvalSummary(tool, args.input), decision: 'deny', at: new Date().toISOString() }); return reply(id, text({ behavior: 'deny', message: DENIED })); }
      summary = approvalSummary(tool, args.input);
    }
    const token = params?._meta?.progressToken; let ticks = 0;
    const timer = setInterval(() => { if (token !== undefined) send({ method: 'notifications/progress', params: { progressToken: token, progress: ++ticks, message: `Waiting for the owner: ${summary}` } }); }, opts.progress * 1000);
    let decision;
    try { decision = await awaitDecision(approvalId, { waitSeconds: opts.wait }); } catch { decision = 'deny'; }
    finally { clearInterval(timer); }
    record({ id: approvalId, tool, summary, decision, ...(decision === 'timeout' ? { wait: opts.wait } : {}), at: new Date().toISOString() });
    reply(id, text(decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: decision === 'timeout' ? timeoutText(opts.wait) : DENIED }));
  }
  const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  function handle(row) {
    const { id, method, params } = row;
    if (method === 'initialize') return reply(id, { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: SERVER_NAME, version: '1' } });
    if (method === 'ping') return reply(id, {});
    if (method === 'tools/list') return reply(id, { tools: [TOOL] });
    if (method === 'tools/call') return params?.name === TOOL_NAME ? approve(id, params) : fail(id, -32602, `Unknown tool: ${String(params?.name ?? '').slice(0, 60)}`);
    return fail(id, -32601, 'Method not found');
  }
  const lines = readline.createInterface({ input });
  lines.on('line', line => {
    if (!line.trim()) return;
    let row; try { row = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
    if (!row || typeof row !== 'object' || Array.isArray(row)) return fail(null, -32600, 'Invalid request');
    if (row.method === undefined) return; // A response to a notification of ours: nothing to do.
    if (row.id === undefined || row.id === null) return; // Notifications (initialized, cancelled) need no reply.
    handle(row);
  });
  await new Promise(resolve => { lines.once('close', resolve); input.once('end', resolve); });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.on('error', () => process.exit(0));
  try { await serve(); process.exit(0); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2); }
}
