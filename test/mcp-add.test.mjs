import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { CLI, fakeClis, keyLike, temp } from './helpers.mjs';
import { addServer, removeServer, findServerConfig, cliServerConfig, keyedConfigText, keyedLine, serverEntry, secretsOf, urlSecrets, headerValue, nameProblem, readSecret, claudeServers, mcpArguments } from '../lib/mcp.mjs';

// A key shaped like the one ELU's setup page shows, joined when the test runs.
const KEY = keyLike('elu_live_', 'Zq81TfakeKey', 'Wv3x0Notreal');
// The config as the owner pasted it: the shape ELU's setup page gives for any MCP client.
const OWNER = `{\n  "mcpServers": {\n    "elu": {\n      "url": "https://app.example.invalid/api/mcp",\n      "headers": { "Authorization": "Bearer ${KEY}" },\n      "timeout": 120\n    }\n  }\n}`;

function scratch(t, mode) {
  const parent = temp(t), fake = fakeClis(parent, { mode }), saved = {};
  for (const [name, value] of Object.entries({ ...fake.env, HOME: parent })) { saved[name] = process.env[name]; process.env[name] = value; }
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const file = path.join(fake.env.CLAUDE_CONFIG_DIR, '.claude.json');
  const calls = () => fs.existsSync(fake.calls) ? fs.readFileSync(fake.calls, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { parent, ...fake, file, calls, saved: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}
// Every file under a folder that holds the text, except the ones named.
function holding(folder, text, except = []) {
  const found = [];
  const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.isFile() && !except.includes(file) && fs.readFileSync(file).includes(text)) found.push(file); } };
  walk(folder); return found;
}

test('a pasted MCP config is found with its name, and the rest of the message is kept', () => {
  const found = findServerConfig(`Connect this please\n${OWNER}\nthen try it`);
  assert.deepEqual(found.servers, [{ name: 'elu', entry: { type: 'http', url: 'https://app.example.invalid/api/mcp', headers: { Authorization: `Bearer ${KEY}` } } }], 'a URL with no type is http, and a timeout is left out');
  assert.equal(found.rest, 'Connect this please\n\nthen try it');
  assert.equal(findServerConfig(OWNER).rest, '', 'the config alone leaves nothing');
  // Pasted without its outer braces, the name before it is taken.
  assert.deepEqual(findServerConfig(`"elu": { "type": "http", "url": "https://x.example.invalid/mcp", "headers": { "Authorization": "Bearer ${KEY}" } },`).servers.map(row => row.name), ['elu']);
  assert.deepEqual(findServerConfig(`"mcpServers": { "elu": { "url": "https://x.example.invalid/mcp" } }`), { servers: [{ name: 'elu', entry: { type: 'http', url: 'https://x.example.invalid/mcp' } }], rest: '' });
  // One server with no name, a name map, VS Code's servers, a command, and a config inside a larger file.
  assert.deepEqual(findServerConfig('{"url": "https://x.example.invalid/sse", "type": "sse"}').servers, [{ name: null, entry: { type: 'sse', url: 'https://x.example.invalid/sse' } }]);
  assert.deepEqual(findServerConfig('{"gmail": {"command": "npx", "args": ["-y", "gmail-mcp"], "env": {"TOKEN": "abc"}}}').servers, [{ name: 'gmail', entry: { type: 'stdio', command: 'npx', args: ['-y', 'gmail-mcp'], env: { TOKEN: 'abc' } } }]);
  assert.deepEqual(findServerConfig('{"mcp": {"servers": {"elu": {"type": "http", "url": "https://x.example.invalid"}}}}').servers.map(row => row.name), ['elu']);
  assert.deepEqual(findServerConfig('{"projects": {"/w": {"mcpServers": {"a": {"command": "a"}, "b": {"url": "https://b.example.invalid"}}}}}').servers.map(row => row.name), ['a', 'b']);
  // Not a config: plain JSON, a VS Code task, broken JSON, and a server whose settings do not read.
  for (const text of ['{"a": 1}', '{"version": "2.0.0", "tasks": [{"label": "x", "command": "npm"}]}', '{"command": "npm", "type": "shell"}', 'hello {not json}', '{"mcpServers": {"elu": {"url": "https://x",}}}', '{"elu": {"url": "ftp://x.example.invalid"}}', '{"elu": {"url": "https://x.example.invalid", "headers": {"A": 1}}}']) assert.equal(findServerConfig(text), null, text);
  // Text that is not a config but holds a key beside a server's fields is held back too.
  assert.equal(keyedConfigText(`{"mcpServers": {"elu": {"url": "https://x", "headers": {"Authorization": "Bearer ${KEY}"},}}}`), true);
  assert.equal(keyedConfigText('{"mcpServers": {"elu": {"url": "https://x"}}}'), false, 'no key');
  assert.equal(keyedConfigText(`Bearer ${KEY}`), false, 'a key alone is not a config');
  assert.equal(keyedConfigText(`{"mcpServers": {"z": {"url": "https://x.example.invalid/mcp?api_key=${KEY}",}}}`), true, 'a key in the URL\'s query');
});

test('everyday JSON is not a server config: an API\'s answer, a log line, a package.json', () => {
  const samples = [
    '{"id": 1347, "url": "https://api.github.com/repos/o/r/issues/1347", "title": "Found a bug", "state": "open"}',
    '{"level":"error","url":"https://api.x.example.invalid/v1","status":500,"msg":"upstream failed"}',
    '{"name": "app", "version": "1.0.0", "bugs": {"url": "https://github.com/o/r/issues"}, "repository": {"type": "git", "url": "https://github.com/o/r.git"}, "scripts": {"start": "node ."}}',
    '{"action": "opened", "issue": {"url": "https://api.github.com/repos/o/r/issues/2", "user": {"login": "x"}}}',
    '{"servers": {"prod": {"url": "https://x.example.invalid", "region": "eu"}}}',
  ];
  for (const text of samples) assert.equal(findServerConfig(text), null, text);
  // Under mcpServers a server may have fields of its own.
  assert.deepEqual(findServerConfig('{"mcpServers": {"a": {"url": "https://a.example.invalid", "description": "A", "disabled": false}}}').servers.map(row => row.name), ['a']);
});

test('a claude mcp add line reads as the server it adds, with ! or without; one that does not read but holds a key is caught', () => {
  const url = 'https://app.example.invalid/api/mcp', header = { Authorization: `Bearer ${KEY}` };
  assert.deepEqual(cliServerConfig(`!claude mcp add --transport http elu ${url} --header "Authorization: Bearer ${KEY}"`), { servers: [{ name: 'elu', entry: { type: 'http', url, headers: header } }], rest: '', cli: true });
  assert.deepEqual(cliServerConfig(`Set this up: claude mcp add -t sse -s user -H "Authorization: Bearer ${KEY}" -H "X-Team: a" elu ${url}\nthen try it`), { servers: [{ name: 'elu', entry: { type: 'sse', url, headers: { ...header, 'X-Team': 'a' } } }], rest: 'Set this up:\nthen try it', cli: true });
  assert.deepEqual(cliServerConfig(`claude mcp add elu ${url}`).servers[0].entry, { type: 'http', url }, 'a URL with no --transport is http');
  assert.deepEqual(cliServerConfig('claude mcp add --env GITHUB_TOKEN=tok_abcdef123456 A=1 github -- docker run -i --rm ghcr.io/github/github-mcp-server').servers[0], { name: 'github', entry: { type: 'stdio', command: 'docker', args: ['run', '-i', '--rm', 'ghcr.io/github/github-mcp-server'], env: { GITHUB_TOKEN: 'tok_abcdef123456', A: '1' } } });
  assert.deepEqual(cliServerConfig('claude mcp add gmail npx -y gmail-mcp').servers[0].entry, { type: 'stdio', command: 'npx', args: ['-y', 'gmail-mcp'] });
  assert.deepEqual(cliServerConfig(`! claude mcp add-json --scope user elu '{"type":"http","url":"${url}","headers":{"Authorization":"Bearer ${KEY}"}}'`).servers, [{ name: 'elu', entry: { type: 'http', url, headers: header } }]);
  assert.deepEqual(cliServerConfig(`claude mcp add elu ${url} \\\n  --header "Authorization: Bearer ${KEY}" && echo done`).servers[0].entry.headers, header, 'a line that ends in \\ goes on, and && ends it');
  // Lines that do not read: held only when they hold a key.
  assert.deepEqual(cliServerConfig(`!claude mcp add --header "Authorization: Bearer ${KEY}"`), { keyed: true });
  assert.deepEqual(cliServerConfig(`!claude mcp add --frobnicate elu ${url} -H "Authorization: Bearer ${KEY}"`), { keyed: true });
  assert.deepEqual(cliServerConfig(`claude mcp add -- -h ${url} -H "Authorization: Bearer ${KEY}"`), { keyed: true }, 'a name that starts with - is not taken');
  assert.deepEqual(cliServerConfig(`!elu mcp add elu https://x.example.invalid/mcp?token=${KEY}`), { keyed: true });
  for (const text of ['how does claude mcp add work?', '!claude mcp list', 'claude mcp add', '!elu mcp add elu https://x.example.invalid --header Authorization']) assert.equal(cliServerConfig(text), null, text);
  // A key in a line, as a ! command holds one.
  for (const line of [`curl -H "Authorization: Bearer ${KEY}" https://x`, `curl -H 'X-Api-Key: ${KEY}' https://x`, `GITHUB_TOKEN=${KEY} gh api /user`, `curl https://x/mcp?api_key=${KEY}`, 'git clone https://me:s3cretpass@example.invalid/r.git']) assert.equal(keyedLine(line), true, line);
  for (const line of ['git status', 'curl -H "Accept: application/json" https://x', 'docker run -e NODE_ENV=production app', 'echo $GITHUB_TOKEN']) assert.equal(keyedLine(line), false, line);
});

test('a key in a server\'s URL counts: a Zapier-style path, a query value, a password', () => {
  const zap = 'https://mcp.zapier.example.invalid/api/mcp/s/a8Kd93LmQz0Xw7Rt2Vb/mcp', query = `https://x.example.invalid/mcp?api_key=${KEY}&region=eu`;
  assert.deepEqual(urlSecrets(zap), ['a8Kd93LmQz0Xw7Rt2Vb']); assert.deepEqual(urlSecrets(query), [KEY]);
  assert.deepEqual(urlSecrets('https://me:pa%24%24word1@x.example.invalid/mcp'), ['me', 'pa%24%24word1', 'pa$$word1']);
  assert.deepEqual(urlSecrets('https://x.example.invalid/api/mcp?transport=sse'), [], 'nothing in a plain URL');
  assert.deepEqual(secretsOf(findServerConfig(`{"zap": {"url": "${zap}"}}`).servers[0].entry), ['a8Kd93LmQz0Xw7Rt2Vb']);
  assert.ok(secretsOf({ command: 'npx', args: ['mcp-remote', query] }).includes(KEY), 'a URL among the arguments');
});

test('a server\'s settings: the keys in them, a bearer key typed alone, and the names Claude Code takes', () => {
  assert.deepEqual(serverEntry({ url: 'https://x.example.invalid', type: 'streamable-http', timeout: 5 }), { type: 'http', url: 'https://x.example.invalid' });
  assert.deepEqual(serverEntry({ command: 'npx', cwd: '/tmp' }), { type: 'stdio', command: 'npx', args: [] });
  assert.equal(serverEntry({ url: 'https://x', type: 'ws' }), null); assert.equal(serverEntry({ command: '' }), null); assert.equal(serverEntry([]), null);
  assert.deepEqual(secretsOf({ headers: { Authorization: `Bearer ${KEY}` } }), [`Bearer ${KEY}`, KEY]);
  assert.deepEqual(secretsOf({ command: 'npx', args: ['mcp-remote', 'https://x', '--header', `Authorization: Bearer ${KEY}`] }), [`Authorization: Bearer ${KEY}`, KEY]);
  assert.deepEqual(secretsOf({ type: 'http', url: 'https://x' }), []);
  assert.equal(headerValue('Authorization', ` ${KEY} `), `Bearer ${KEY}`); assert.equal(headerValue('authorization', `Bearer ${KEY}`), `Bearer ${KEY}`); assert.equal(headerValue('X-Api-Key', KEY), KEY);
  assert.equal(nameProblem('elu'), null); assert.equal(nameProblem('my_server-2'), null);
  for (const bad of ['', 'a b', 'a.b', 'x'.repeat(65), 'elu-code-approval', '-h', '--scope', '--client-secret']) assert.ok(nameProblem(bad), bad);
});

test('/mcp add saves through claude mcp add-json in the user scope, never by writing the file, and a refusal never shows the key', async t => {
  const f = scratch(t);
  const entry = findServerConfig(OWNER).servers[0].entry;
  assert.equal(await addServer('elu', entry), 'Added elu. Sessions get it from their next turn.');
  assert.deepEqual(f.saved().mcpServers.elu, { type: 'http', url: 'https://app.example.invalid/api/mcp', headers: { Authorization: `Bearer ${KEY}` } });
  assert.deepEqual(f.calls().map(row => row.args), [['mcp', 'add-json', '--scope', 'user', '--', 'elu', '<json>']], 'Claude Code\'s own command saved it, the name after --');
  assert.deepEqual(Object.keys(claudeServers(null)), ['elu']);
  await assert.rejects(addServer('elu', entry), { message: 'elu is already one of your Claude Code servers. Remove it first.' });
  // A replace removes the old one first, through Claude Code too.
  assert.equal(await addServer('elu', { ...entry, headers: { Authorization: 'Bearer other-key-123456' } }, { replace: true }), 'Added elu. Sessions get it from their next turn.');
  assert.deepEqual(f.calls().slice(1).map(row => row.args), [['mcp', 'remove', '--scope', 'user', '--', 'elu'], ['mcp', 'add-json', '--scope', 'user', '--', 'elu', '<json>']]);
  assert.equal(f.saved().mcpServers.elu.headers.Authorization, 'Bearer other-key-123456');
  await assert.rejects(addServer('a b', entry), /A server name is up to 64 letters/); await assert.rejects(addServer('x', { url: 'nope' }), /not an MCP server's settings/);
  assert.equal(await removeServer('elu'), 'Removed elu. Sessions stop getting it from their next turn.');
  assert.deepEqual(f.saved().mcpServers, {}); await assert.rejects(removeServer('elu'), { message: 'No MCP server named elu. /mcp lists yours.' });
  assert.deepEqual(holding(f.parent, KEY), [], 'the key is nowhere once it is gone');
  // Claude Code may print the settings it was given when it refuses them: the key is taken out.
  fs.writeFileSync(path.join(f.dir, 'fake.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(f.dir, 'fake.json'), 'utf8')), mode: 'mcp-echo' }));
  const refused = await addServer('elu', entry).then(() => null, error => error.message);
  assert.match(refused, /^Claude Code did not add elu: Invalid configuration: /); assert.ok(!refused.includes(KEY) && !refused.includes('Bearer elu_'), refused);
  // Without Claude Code there is nothing to save with.
  process.env.PATH = path.join(f.parent, 'nowhere');
  await assert.rejects(addServer('elu', entry), { message: 'Claude Code is not installed here: the claude command was not found.' });
});

test('elu mcp add reads the key from stdin or a prompt with echo off, never from its arguments; elu mcp remove asks first', async t => {
  const f = scratch(t), env = { ...process.env, ...f.env, HOME: f.parent };
  const withInput = (args, input) => spawnSync(process.execPath, [CLI, 'mcp', ...args], { cwd: f.parent, env, input, encoding: 'utf8', timeout: 60000 }), run = args => withInput(args, '');
  const added = withInput(['add', 'elu', 'https://app.example.invalid/api/mcp', '--header', 'Authorization'], `${KEY}\n`);
  assert.equal(added.status, 0, added.stderr); assert.equal(added.stdout.trim(), 'Added elu. Sessions get it from their next turn.');
  assert.ok(!added.stdout.includes(KEY) && !added.stderr.includes(KEY), 'the key is not printed');
  assert.deepEqual(f.saved().mcpServers.elu, { type: 'http', url: 'https://app.example.invalid/api/mcp', headers: { Authorization: `Bearer ${KEY}` } }, 'a key alone is sent as Bearer KEY');
  // A key on the command line is refused, so it never lands in shell history.
  const inline = run(['add', 'other', 'https://x.example.invalid', '--header', `Authorization: Bearer ${KEY}`]);
  assert.equal(inline.status, 1); assert.match(inline.stderr, /Type only the header's name, such as Authorization\. Its value is asked for next\. Never put a key on the command line\./);
  assert.ok(!inline.stderr.includes(KEY));
  assert.match(run(['add', 'other', 'https://x.example.invalid', '--env', 'TOKEN']).stderr, /--env goes with a command\. A URL takes --header\./);
  assert.match(run(['add', 'elu', 'https://x.example.invalid']).stderr, /elu is already one of your Claude Code servers\. elu mcp remove elu first\./);
  assert.match(withInput(['add', 'empty', 'https://x.example.invalid', '--header', 'Authorization'], '\n').stderr, /No value was given\. Nothing was added\./);
  // A key in the URL is refused too: it would stay in the shell's history.
  const inUrl = run(['add', 'zap', `https://x.example.invalid/mcp?api_key=${KEY}`]);
  assert.equal(inUrl.status, 1); assert.match(inUrl.stderr, /This holds a key\. Never put a key on the command line: it stays in your shell history\./);
  // A command server, its key in the environment. Its own options go after --, untouched.
  const stdio = withInput(['add', 'gmail', '--env', 'GMAIL_TOKEN', '--', 'npx', '-y', 'gmail-mcp', '--verbose', '--json'], 'tok-abcdef-123\n');
  assert.equal(stdio.status, 0, stdio.stderr); assert.equal(stdio.stdout.trim(), 'Added gmail. Sessions get it from their next turn.', 'a --json after -- is the command\'s');
  assert.deepEqual(f.saved().mcpServers.gmail, { type: 'stdio', command: 'npx', args: ['-y', 'gmail-mcp', '--verbose', '--json'], env: { GMAIL_TOKEN: 'tok-abcdef-123' } });
  const docker = run(['add', 'github', 'docker', 'run', '-i', '--rm', 'ghcr.io/github/github-mcp-server']);
  assert.equal(docker.status, 1); assert.match(docker.stderr, /Unknown option --rm\. A command's own options go after --\. Use elu mcp add NAME URL \[--header NAME\], or elu mcp add NAME \[--env NAME\] -- COMMAND \[ARGS\]\.\.\./);
  assert.equal(run(['add', 'github', '--', 'docker', 'run', '-i', '--rm', 'ghcr.io/github/github-mcp-server']).status, 0);
  assert.deepEqual(f.saved().mcpServers.github.args, ['run', '-i', '--rm', 'ghcr.io/github/github-mcp-server']);
  assert.match(run(['add', '-h', 'https://x.example.invalid']).stdout, /mcp add NAME \[--env NAME\] -- COMMAND \[ARGS\]\.\.\./, '-h is help, never a name');
  assert.match(run(['add', '--', '--scope', 'https://x.example.invalid']).stderr, /does not start with -/);
  assert.deepEqual(mcpArguments(['add', 'a', '--header=Authorization', '--yes', '--', '--yes']), { flags: { header: 'Authorization', yes: true }, words: ['add', 'a', '--yes'] });
  assert.equal(run(['remove', 'github', '--yes']).status, 0);
  const listed = withInput(['--json'], '');
  assert.deepEqual(JSON.parse(listed.stdout).servers, ['elu', 'gmail']); assert.ok(!listed.stdout.includes(KEY), 'the list shows names only');
  assert.match(run(['remove', 'gmail']).stderr, /Add --yes to remove gmail\./);
  assert.equal(run(['remove', 'gmail', '--yes']).stdout.trim(), 'Removed gmail. Sessions stop getting it from their next turn.');
  assert.match(run(['remove', 'gmail', '--yes']).stderr, /No MCP server named gmail\. elu mcp lists yours\./);
  assert.ok(f.calls().every(row => !JSON.stringify(row).includes(KEY)), 'what the fake recorded has no key');
  assert.deepEqual(holding(f.parent, KEY, [f.file]), [], 'the key is only in Claude Code\'s own file');
  // At a terminal the key is typed with echo off: nothing of it is written back.
  const input = new PassThrough(), output = new PassThrough(); let shown = '', raw = null;
  input.isTTY = true; input.setRawMode = value => { raw = value; }; output.on('data', data => { shown += data; });
  const typed = readSecret('Authorization (hidden): ', { input, output });
  input.write('wrong'); input.write('\x7f\x7f\x7f\x7f\x7f'); input.write(`\x1b[200~${KEY}\x1b[201~`); input.write('\r');
  assert.equal(await typed, KEY); assert.equal(shown, 'Authorization (hidden): \n'); assert.equal(raw, false, 'raw mode is put back');
  const cancelled = readSecret('Key: ', { input, output }); input.write('abc\x03');
  await assert.rejects(cancelled, /Cancelled\. Nothing was added\./);
});
