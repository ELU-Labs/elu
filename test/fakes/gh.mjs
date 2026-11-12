// The fake GitHub CLI the GitHub pairing tests put first on PATH (fakeGh in
// test/github-pairing.test.mjs copies it there as gh). It answers only the calls
// lib/peer/github.mjs makes, in the shapes gh 2.x gives them:
//   gh api -i user                                      status line, headers, blank line, user JSON
//   gh api --paginate gists --jq '.[] | select(.description == "D") | {id, created_at}'
//                                                       one compact JSON object per line
//   gh api gists/ID                                     the gist, files with their content
//   gh api -X POST gists --input -                      a new gist from stdin
//   gh api -X PATCH gists/ID --input -                  the files named on stdin replaced, the rest kept
// The signed-in account is FAKE_GH_ACCOUNT (a login; none means signed out) with id
// FAKE_GH_ID. Gists are kept per account in $FAKE_GH_STORE/<login>.json, and every call is
// appended to $FAKE_GH_STORE/calls.jsonl. FAKE_GH_MODE: signedout, noscope (a token without
// gist), slow (never answers), error (GitHub answers 502).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2), env = process.env, store = env.FAKE_GH_STORE, login = env.FAKE_GH_ACCOUNT || null, mode = env.FAKE_GH_MODE || 'normal';
const input = args.includes('--input') ? fs.readFileSync(0, 'utf8') : '';
if (store) fs.appendFileSync(path.join(store, 'calls.jsonl'), `${JSON.stringify({ account: login, args, input: input ? JSON.parse(input) : null })}\n`);
const fail = (text, code = 1) => { process.stderr.write(`${text}\n`); process.exit(code); };
if (args[0] !== 'api') fail(`unknown command "${args[0]}" for "gh"`);
if (mode === 'slow') setInterval(() => {}, 1000);
else {
  if (mode === 'signedout' || !login) fail('To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.', 4);
  if (mode === 'error') { process.stdout.write('{"message":"Server Error"}'); fail('gh: Server Error (HTTP 502)'); }
  main();
}

function main() {
  const rest = args.slice(1), method = rest.includes('-X') ? rest[rest.indexOf('-X') + 1] : 'GET';
  const endpoint = rest.find((word, i) => !word.startsWith('-') && !['-X', '--jq', '--input'].includes(rest[i - 1]));
  if (endpoint === 'user') {
    const user = { login, id: Number(env.FAKE_GH_ID ?? 1000), node_id: 'U_fake', type: 'User' };
    const scopes = mode === 'noscope' ? 'read:org, repo' : 'gist, read:org, repo';
    if (rest.includes('-i')) process.stdout.write(`HTTP/2.0 200 OK\nContent-Type: application/json; charset=utf-8\nX-Oauth-Scopes: ${scopes}\n\n`);
    process.stdout.write(JSON.stringify(user));
    return;
  }
  // A token without the gist scope gets 404 from the gist endpoints, as GitHub answers.
  if (mode === 'noscope' && endpoint.startsWith('gists')) { process.stdout.write('{"message":"Not Found"}'); fail('gh: Not Found (HTTP 404)'); }
  withLock(() => {
    const gists = read();
    if (endpoint === 'gists' && method === 'GET') {
      const jq = rest.includes('--jq') ? rest[rest.indexOf('--jq') + 1] : null;
      if (!jq) { process.stdout.write(JSON.stringify(gists.map(listed))); return; }
      const wanted = /select\(\.description == ("(?:[^"\\]|\\.)*")\) \| \{id, created_at\}$/.exec(jq);
      if (!wanted) fail(`fake gh: unknown --jq ${jq}`);
      const description = JSON.parse(wanted[1]);
      for (const gist of gists.filter(row => row.description === description)) process.stdout.write(`${JSON.stringify({ id: gist.id, created_at: gist.created_at })}\n`);
      return;
    }
    if (endpoint === 'gists' && method === 'POST') {
      const body = JSON.parse(input), now = new Date(Date.now() + gists.length).toISOString();
      const gist = { id: crypto.randomBytes(16).toString('hex'), description: body.description, public: body.public === true, created_at: now, updated_at: now, files: {} };
      for (const [name, file] of Object.entries(body.files ?? {})) gist.files[name] = { filename: name, content: file.content, truncated: false };
      gists.push(gist); write(gists); process.stdout.write(JSON.stringify(gist));
      return;
    }
    const id = /^gists\/([A-Za-z0-9]+)$/.exec(endpoint ?? '')?.[1], gist = gists.find(row => row.id === id);
    if (!gist) { process.stdout.write('{"message":"Not Found"}'); fail('gh: Not Found (HTTP 404)'); }
    if (method === 'GET') { process.stdout.write(JSON.stringify(gist)); return; }
    if (method === 'PATCH') {
      const body = JSON.parse(input);
      for (const [name, file] of Object.entries(body.files ?? {})) { if (file === null) delete gist.files[name]; else gist.files[name] = { filename: name, content: file.content, truncated: false }; }
      gist.updated_at = new Date().toISOString(); write(gists); process.stdout.write(JSON.stringify(gist));
      return;
    }
    fail(`fake gh: unknown call ${args.join(' ')}`);
  });
}
function listed(gist) { return { ...gist, files: Object.fromEntries(Object.entries(gist.files).map(([name, file]) => [name, { filename: name, size: file.content.length }])) }; }
function file() { return path.join(store, `${login}.json`); }
function read() { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return []; } }
function write(gists) { const tmp = `${file()}.${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(gists, null, 2)); fs.renameSync(tmp, file()); }
// Two machines' daemons can call at the same moment: one at a time per store. The lock goes
// when the process exits, an answer that fails included.
function withLock(fn) {
  const lock = path.join(store, 'lock');
  for (let tries = 0; ; tries++) {
    try { fs.mkdirSync(lock); break; } catch (error) { if (error.code !== 'EEXIST' || tries > 400) throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
  }
  process.on('exit', () => fs.rmSync(lock, { recursive: true, force: true }));
  fn();
}
