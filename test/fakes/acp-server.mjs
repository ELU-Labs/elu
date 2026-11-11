// A scripted ACP server for acp-client tests: newline JSON-RPC 2.0 on stdio. It answers
// initialize and session/new, turns a session/prompt into two session/update notifications
// plus a session/request_permission request it waits on, never answers `slow`, echoes
// `echo` (with how many notifications it received), and exits 3 on `exit`.
import readline from 'node:readline';
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const waiting = new Map(); let notifications = 0, nextId = 100;
const ask = (method, params) => new Promise(resolve => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
// Every message is handled without blocking the read loop, so a reply to this server's own
// request (sent while a prompt is in flight) is still read.
for await (const line of readline.createInterface({ input: process.stdin })) {
  let row; try { row = JSON.parse(line); } catch { continue; }
  if (row.id !== undefined && row.method === undefined) { waiting.get(row.id)?.(row.error ? { error: row.error } : row.result); waiting.delete(row.id); continue; }
  if (row.id === undefined) { notifications++; continue; }
  handle(row);
}
async function handle(row) {
  const reply = result => send({ jsonrpc: '2.0', id: row.id, result });
  switch (row.method) {
    case 'initialize': reply({ protocolVersion: row.params?.protocolVersion ?? 1, agentCapabilities: {}, authMethods: [{ id: 'cached_token' }] }); break;
    case 'session/new': reply({ sessionId: 'sess-1' }); break;
    case 'session/prompt': {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking.' } } } });
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Writing outside.' } } } });
      const answer = await ask('session/request_permission', { sessionId: 'sess-1', toolCall: { title: 'Write /outside/secret.txt' }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }] });
      reply({ stopReason: 'end_turn', answered: answer });
      break;
    }
    case 'echo': reply({ params: row.params ?? null, notifications }); break;
    case 'slow': break;
    case 'exit': process.exit(3);
    default: send({ jsonrpc: '2.0', id: row.id, error: { code: -32601, message: 'Method not found' } });
  }
}

