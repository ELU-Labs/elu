import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { temp, keyLike } from './helpers.mjs';
import { FACT_KINDS, FACT_TOPICS, allFacts, factById, factText, factsFile, findFacts, holdsEmail, quoteInFile, replaceFact, saveFact, sourceText, withdrawFact } from '../lib/facts.mjs';

// What the overseeing bot learned about the organization (lib/facts.mjs): one fact a line in
// ELU's own folder, each with its source and the exact words there, written only by ELU's code.
function environment(t, values) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
// ELU's folder in a temporary place: the facts of a test are never the owner's.
function home(t) { const dir = temp(t); environment(t, { XDG_CONFIG_HOME: dir }); return dir; }
const read = file => fs.readFileSync(file, 'utf8');
const lines = () => read(factsFile()).split('\n').filter(Boolean);
const WEB = { claim: 'Acme sells to finance teams of mid-size companies.', topic: 'market', source: { kind: 'web', url: 'https://acme.example/customers' }, quote: 'Built for finance teams of 50 to 500 people.' };
const NOV = new Date(2026, 10, 17, 9, 30);

test('a fact is saved with its source and its quote, takes the next id, and the file is only ever added to', t => {
  const dir = home(t);
  assert.deepEqual(allFacts(), []); assert.equal(fs.existsSync(factsFile()), false, 'reading makes no file');
  const first = saveFact(WEB, { now: NOV });
  assert.deepEqual(first, { id: 'f1', claim: WEB.claim, topic: 'market', source: { kind: 'web', url: 'https://acme.example/customers' }, quote: WEB.quote, checked: false, date: NOV.toISOString(), status: 'active' });
  assert.equal(factsFile(), path.join(dir, 'elu-code', 'orchestrator', 'facts.jsonl'));
  assert.equal(fs.statSync(factsFile()).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(factsFile())).mode & 0o777, 0o700);
  const one = read(factsFile());
  assert.deepEqual(JSON.parse(one), { id: 'f1', claim: WEB.claim, topic: 'market', source: first.source, quote: WEB.quote, checked: false, date: NOV.toISOString() });
  // The next one is f2, and the line before it stays as it was written: so does a fact taken back.
  const second = saveFact({ claim: 'Checkout is the step most users leave at.', topic: 'business', source: { kind: 'elu', tool: 'ask_elu', question: 'Where do users drop off?', session: 's-41' }, quote: '38% of sessions end on the checkout page.' });
  assert.equal(second.id, 'f2'); assert.ok(read(factsFile()).startsWith(one)); assert.equal(lines().length, 2);
  withdrawFact('f1');
  assert.ok(read(factsFile()).startsWith(one)); assert.equal(lines().length, 3);
  assert.deepEqual(allFacts().map(fact => fact.id), ['f2']); assert.deepEqual(allFacts({ all: true }).map(fact => [fact.id, fact.status]), [['f1', 'withdrawn'], ['f2', 'active']]);
  // Text goes on one line, with no control characters.
  const third = saveFact({ ...WEB, claim: '  Acme has\ntwo\u0007 plans. ', quote: 'Two plans:\n  Team and   Business.' });
  assert.equal(third.claim, 'Acme has two plans.'); assert.equal(third.quote, 'Two plans: Team and Business.'); assert.equal(third.id, 'f3');
});

test('no quote, no fact: only what the owner said himself needs none', t => {
  home(t);
  for (const quote of [undefined, '', '   \n']) assert.throws(() => saveFact({ ...WEB, quote }), { message: /^No quote, no fact: give the exact words of the source that say so\./ });
  assert.throws(() => saveFact({ ...WEB, quote: 'Yes.' }), { message: /^That quote is too short to say anything/ });
  assert.throws(() => saveFact({ ...WEB, quote: 'word '.repeat(300) }), { message: /at most 1000 characters/ });
  assert.equal(fs.existsSync(factsFile()), false, 'nothing was written');
  const said = saveFact({ claim: 'The team ships on Tuesdays.', topic: 'team', source: { kind: 'owner', session: '12' } });
  assert.deepEqual([said.id, said.quote, said.checked, said.source], ['f1', '', false, { kind: 'owner', session: '12' }]);
  // What he said may come with his words, and they are kept as said, not checked.
  assert.equal(saveFact({ claim: 'Releases need a sign-off from compliance.', topic: 'business', source: { kind: 'owner' }, quote: 'compliance signs off every release' }).checked, false);
});

test('a fact says where it came from: each kind names its place, and nothing else is kept of it', t => {
  home(t);
  assert.deepEqual(FACT_KINDS, ['web', 'elu', 'file', 'session', 'source', 'owner']); assert.deepEqual(FACT_TOPICS, ['business', 'market', 'tech', 'evals', 'team']);
  const refused = (source, message) => assert.throws(() => saveFact({ ...WEB, source }), { message }, JSON.stringify(source));
  refused(undefined, /^A fact names where it came from: source\.kind is one of web, elu, file, session, source, owner\.$/);
  refused({ kind: 'memory' }, /source\.kind is one of/);
  refused({ kind: 'web' }, 'A fact from the web names the address of the page (url).');
  for (const url of ['acme.example/customers', 'file:///etc/hosts', 'javascript:alert(1)', 'https://ana:hunter22@acme.example/']) refused({ kind: 'web', url }, 'The address of a page starts with http:// or https:// and holds no sign-in.');
  refused({ kind: 'elu', question: 'Where do users drop off?' }, 'A fact from ELU names the tool that answered (tool).');
  refused({ kind: 'elu', tool: 'ask_elu' }, 'A fact from ELU names the question asked (question), the issue (issue) or the session (session).');
  refused({ kind: 'session' }, 'A fact from a session names the session (session).');
  refused({ kind: 'source', server: 'slack' }, 'A fact from a connected source names the tool that answered (tool).');
  refused({ kind: 'source', tool: 'search_messages' }, 'A fact from a connected source names the server (server).');
  refused({ kind: 'web', url: `https://acme.example/${'a'.repeat(2000)}` }, /keep source\.url to 2000 characters/);
  assert.equal(fs.existsSync(factsFile()), false);
  // Only the fields of its kind are kept.
  assert.deepEqual(saveFact({ ...WEB, source: { kind: 'web', url: 'https://acme.example/pricing', path: 'src/x.mjs', token: 'abc', note: { a: 1 } } }).source, { kind: 'web', url: 'https://acme.example/pricing' });
  assert.deepEqual(saveFact({ ...WEB, source: { kind: 'elu', tool: 'list_issues', issue: 'iss_204', url: 'https://app.example/issues/204' } }).source, { kind: 'elu', tool: 'list_issues', issue: 'iss_204', url: 'https://app.example/issues/204' });
  assert.deepEqual(saveFact({ ...WEB, source: { kind: 'source', server: 'slack', tool: 'search_messages', question: 'pricing change', ref: 'C04/p1731' } }).source, { kind: 'source', server: 'slack', tool: 'search_messages', question: 'pricing change', ref: 'C04/p1731' });
  assert.deepEqual(saveFact({ ...WEB, source: { kind: 'session', session: 7, project: '/work/shop' } }).source, { kind: 'session', session: '7', project: '/work/shop' });
  // From the web, a session, ELU or a connected source, ELU did not read the words itself.
  assert.deepEqual(allFacts().map(fact => fact.checked), [false, false, false, false]);
  // A claim is one sentence on one of the topics.
  assert.throws(() => saveFact({ ...WEB, claim: ' ' }), { message: 'A fact needs its claim: one sentence.' });
  assert.throws(() => saveFact({ ...WEB, claim: 'x'.repeat(301) }), { message: 'Keep the claim to one sentence of at most 300 characters.' });
  assert.throws(() => saveFact({ ...WEB, topic: 'gossip' }), { message: 'A fact has one topic: business, market, tech, evals or team.' });
  assert.throws(() => saveFact('Acme is big.'), { message: /^A fact is a claim, its topic/ });
  assert.equal(saveFact({ ...WEB, topic: ' Market ' }).topic, 'market');
});

test('a quote from a file is checked by code: found there it is saved as checked, and one that is not there is refused', t => {
  home(t);
  const root = temp(t), other = temp(t); fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'pricing.md'), '# Pricing\n\nThe Team plan is billed per seat,\n    with a minimum of five seats.\n');
  fs.writeFileSync(path.join(other, 'notes.md'), 'The Team plan is billed per seat.\n');
  const fact = { claim: 'The Team plan has a five-seat minimum.', topic: 'business', source: { kind: 'file', path: 'docs/pricing.md' } };
  // The words are there, whatever the line ends between them.
  const saved = saveFact({ ...fact, quote: 'billed per seat, with a minimum of five seats.' }, { roots: [root] });
  assert.deepEqual([saved.checked, saved.source], [true, { kind: 'file', path: path.join('docs', 'pricing.md'), root }]);
  assert.equal(saveFact({ ...fact, source: { kind: 'file', path: path.join(root, 'docs', 'pricing.md') }, quote: 'The Team plan is billed per seat' }, { roots: [other, root] }).checked, true, 'named by its whole path');
  // Not the file's words: refused, and nothing is written.
  const before = read(factsFile());
  assert.throws(() => saveFact({ ...fact, quote: 'with a minimum of ten seats.' }, { roots: [root] }), { message: `Those words are not in ${path.join('docs', 'pricing.md')}. Quote the file's own words, letter for letter.` });
  assert.throws(() => saveFact({ ...fact, quote: 'THE TEAM PLAN IS BILLED PER SEAT' }, { roots: [root] }), { message: /^Those words are not in/ });
  // Only a file inside the project, which a session there could read itself.
  const outside = { message: 'A fact from a file names a file inside the project, by its path there.' };
  assert.throws(() => saveFact({ ...fact, source: { kind: 'file', path: path.join(other, 'notes.md') }, quote: 'The Team plan is billed per seat.' }, { roots: [root] }), outside);
  assert.throws(() => saveFact({ ...fact, source: { kind: 'file', path: `../${path.basename(other)}/notes.md` }, quote: 'The Team plan is billed per seat.' }, { roots: [root] }), outside);
  assert.throws(() => saveFact({ ...fact, source: { kind: 'file', path: 'docs/none.md' }, quote: 'The Team plan is billed per seat.' }, { roots: [root] }), outside);
  assert.throws(() => saveFact({ ...fact, source: { kind: 'file', path: 'docs' }, quote: 'The Team plan is billed per seat.' }, { roots: [root] }), { message: /^Those words are not in docs\./ });
  fs.symlinkSync(path.join(other, 'notes.md'), path.join(root, 'docs', 'link.md'));
  assert.throws(() => saveFact({ ...fact, source: { kind: 'file', path: 'docs/link.md' }, quote: 'The Team plan is billed per seat.' }, { roots: [root] }), outside, 'a link that leads out of the project');
  assert.throws(() => saveFact({ ...fact, quote: 'The Team plan is billed per seat' }), { message: 'A fact from a file can be saved only from a session of the project the file is in.' });
  // ELU's own files are never a source: the project's Memory is where findings are written, not where they come from.
  fs.mkdirSync(path.join(root, '.elu-code')); fs.writeFileSync(path.join(root, '.elu-code', 'context.md'), 'The customers are finance teams.\n');
  assert.throws(() => saveFact({ ...fact, source: { kind: 'file', path: '.elu-code/context.md' }, quote: 'The customers are finance teams.' }, { roots: [root] }), { message: "ELU's own files are never the source of a fact." });
  assert.throws(() => saveFact({ ...fact, source: { kind: 'file', path: factsFile() }, quote: 'billed per seat, with a minimum of five seats.' }, { roots: [path.dirname(process.env.XDG_CONFIG_HOME), process.env.XDG_CONFIG_HOME] }), { message: "ELU's own files are never the source of a fact." });
  assert.equal(read(factsFile()), before);
  assert.equal(quoteInFile(path.join(root, 'docs', 'pricing.md'), 'a minimum\nof   five seats'), true); assert.equal(quoteInFile(path.join(root, 'docs', 'pricing.md'), ''), false); assert.equal(quoteInFile(path.join(root, 'gone.md'), 'five seats'), false);
});

test('an email address or a secret never gets into a fact', t => {
  home(t);
  const email = { message: 'A fact never holds an email address. Say who by role or by name.' };
  assert.throws(() => saveFact({ ...WEB, claim: 'Ana (ana@acme.example) owns billing.' }), email);
  assert.throws(() => saveFact({ ...WEB, quote: 'Write to billing-team@acme.example for a quote.' }), email);
  assert.throws(() => saveFact({ ...WEB, source: { kind: 'source', server: 'gmail', tool: 'search_threads', question: 'from:ana@acme.example pricing' } }), email);
  const secret = { message: 'That may hold a secret, so it is not saved as a fact.' };
  assert.throws(() => saveFact({ ...WEB, quote: `The deploy key is ${keyLike('ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8')}` }), secret);
  assert.throws(() => saveFact({ ...WEB, claim: 'Staging uses API_KEY=abcd1234efgh for the sandbox.' }), secret);
  assert.equal(fs.existsSync(factsFile()), false, 'nothing was written');
  for (const text of ['ana@acme.example', 'Mail ana.b+news@mail.acme.co.uk today']) assert.equal(holdsEmail(text), true, text);
  for (const text of ['Follow @acme on the web', 'https://blog.example/@acme/pricing', 'a 50% rise @ launch', '']) assert.equal(holdsEmail(text), false, text);
  // The folder a project is in is where its file is, not something the fact says.
  const root = path.join(temp(t), 'drive-ana@acme.example'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'plan.md'), 'We ship the importer in March.\n');
  assert.equal(saveFact({ claim: 'The importer ships in March.', topic: 'business', source: { kind: 'file', path: 'plan.md' }, quote: 'We ship the importer in March.' }, { roots: [root] }).checked, true);
  assert.equal(saveFact({ ...WEB, source: { kind: 'session', session: '3', project: root } }).source.project, root);
  assert.throws(() => saveFact({ ...WEB, source: { kind: 'session', session: '3', project: 'ana@acme.example' } }), email, 'a project that is no folder here is text like any other');
});

test('a fact is never edited: a newer one replaces it and names it, and one taken back stays in the file', t => {
  home(t);
  saveFact(WEB);
  const newer = replaceFact('f1', { ...WEB, claim: 'Acme sells to finance teams of any size.', quote: 'Now for finance teams of every size.' });
  assert.deepEqual([newer.id, newer.replaces, newer.status], ['f2', 'f1', 'active']);
  assert.deepEqual(allFacts({ all: true }).map(fact => [fact.id, fact.status, fact.replacedBy]), [['f1', 'replaced', 'f2'], ['f2', 'active', undefined]]);
  assert.deepEqual(allFacts().map(fact => fact.id), ['f2']);
  assert.equal(factById('f1').claim, WEB.claim, 'the old one reads as it was saved');
  assert.throws(() => replaceFact('f1', WEB), { message: 'f1 was already replaced by f2. Replace that one.' });
  assert.throws(() => replaceFact('f9', WEB), { message: 'No fact has the id f9.' });
  assert.throws(() => replaceFact('the first', WEB), { message: 'A fact that replaces another names it by its id, such as f12.' });
  // Taking the newer one back puts the one it replaced in force again.
  const taken = withdrawFact(' f2 ', { now: NOV });
  assert.deepEqual([taken.withdrawn, taken.fact.status, taken.fact.withdrawn], [true, 'withdrawn', NOV.toISOString()]);
  assert.deepEqual(allFacts({ all: true }).map(fact => [fact.id, fact.status]), [['f1', 'active'], ['f2', 'withdrawn']]);
  assert.equal(factById('f1').replacedBy, undefined);
  // Taken back twice is taken back once; one that is not there is said so.
  assert.equal(withdrawFact('f2').withdrawn, false); assert.equal(lines().length, 3);
  for (const id of ['f9', '', 'two', null]) assert.throws(() => withdrawFact(id), { message: /^No fact has the id / }, String(id));
  assert.throws(() => replaceFact('f2', WEB), { message: 'f2 was taken back, so there is nothing to replace. Save this as a new fact.' });
  assert.equal(factById('f2').status, 'withdrawn', 'still found by its id'); assert.equal(factById('f3'), null);
  assert.equal(lines().length, 3);
});

test('facts are found by their words, by topic and by id', t => {
  home(t);
  saveFact(WEB);
  saveFact({ claim: 'Checkout is the step most users leave at.', topic: 'business', source: { kind: 'elu', tool: 'ask_elu', question: 'Where do users drop off?' }, quote: '38% of sessions end on the checkout page.' });
  saveFact({ claim: 'The eval set has 80 gold sessions.', topic: 'evals', source: { kind: 'owner' } });
  saveFact({ claim: 'Acme raised prices for finance teams in October.', topic: 'market', source: { kind: 'web', url: 'https://news.example/acme-prices' }, quote: 'Acme raised its Team price by 20%.' });
  withdrawFact('f3');
  const ids = options => findFacts(options).map(fact => fact.id);
  // With no words: the facts in force, the newest first.
  assert.deepEqual(ids(), ['f4', 'f2', 'f1']); assert.deepEqual(ids({ all: true }), ['f4', 'f3', 'f2', 'f1']);
  // The ones that hold most of the words first, then the newest; a word may be in the claim, the quote or the source.
  assert.deepEqual(ids({ words: 'Acme finance prices' }), ['f4', 'f1']);
  assert.deepEqual(ids({ words: 'checkout' }), ['f2']); assert.deepEqual(ids({ words: 'drop off' }), ['f2']); assert.deepEqual(ids({ words: 'news' }), ['f4']); assert.deepEqual(ids({ words: 'news.example' }), ['f4', 'f1']);
  assert.deepEqual(ids({ words: 'kubernetes' }), []);
  assert.deepEqual(ids({ topic: 'market' }), ['f4', 'f1']); assert.deepEqual(ids({ topic: 'market', words: 'customers' }), ['f1']); assert.deepEqual(ids({ topic: 'evals' }), []);
  assert.deepEqual(ids({ words: 'gold sessions', all: true }), ['f3', 'f2']);
  assert.deepEqual(ids({ limit: 2 }), ['f4', 'f2']);
  // By id: exactly those, in that order, whatever became of them, so a line that cites one still resolves.
  assert.deepEqual(findFacts({ ids: ['f3', 'f1', 'f8', 'f3'] }).map(fact => [fact.id, fact.status]), [['f3', 'withdrawn'], ['f1', 'active']]);
  assert.deepEqual(ids({ ids: 'f2' }), ['f2']);
});

test('a line that does not read is left out, a cut one is never joined with the next, and ids go on after the highest', t => {
  home(t);
  fs.mkdirSync(path.dirname(factsFile()), { recursive: true });
  const kept = { id: 'f7', claim: 'Kept.', topic: 'tech', source: { kind: 'owner' }, quote: '', checked: false, date: NOV.toISOString() };
  fs.writeFileSync(factsFile(), ['not json', JSON.stringify(kept), JSON.stringify({ id: 'f9', claim: 'From a later ELU.', topic: 'tech', source: { kind: 'hologram' } }), JSON.stringify({ id: 'f7', claim: 'The same id twice.', topic: 'tech', source: { kind: 'owner' } }), '[1, 2]', '{"id":"f10","claim":"cut sho'].join('\n'));
  assert.deepEqual(allFacts(), [{ ...kept, status: 'active' }]);
  const next = saveFact(WEB);
  assert.equal(next.id, 'f10', 'after the highest id a whole line holds, whether or not it reads as a fact here');
  assert.deepEqual(allFacts().map(fact => fact.id), ['f7', 'f10']);
  assert.match(read(factsFile()), /"cut sho\n\{"id":"f10"/);
});

test('two turns that save at the same moment never share an id', async t => {
  home(t);
  const lib = fileURLToPath(new URL('../lib/facts.mjs', import.meta.url));
  const script = `const { saveFact } = await import(${JSON.stringify(lib)}); const saved = []; for (let n = 0; n < 5; n++) { const fact = saveFact({ claim: 'Saved by run ' + process.argv[1] + ', ' + n + '.', topic: 'tech', source: { kind: 'owner' } }); saved.push([fact.id, fact.claim]); } console.log(JSON.stringify(saved));`;
  const run = n => new Promise((resolve, reject) => { const child = spawn(process.execPath, ['--input-type=module', '-e', script, String(n)], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', said = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { said += chunk; }); child.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(said))); });
  const saved = (await Promise.all(Array.from({ length: 6 }, (_, n) => run(n)))).flat();
  // Each turn was given an id of its own, and that id reads back as the fact it saved.
  assert.equal(new Set(saved.map(([id]) => id)).size, 30);
  for (const [id, claim] of saved) assert.equal(factById(id).claim, claim, id);
  assert.deepEqual(allFacts().map(fact => fact.id), Array.from({ length: 30 }, (_, n) => `f${n + 1}`));
});

test('a fact reads as two lines of plain text: what it says, then where it came from, when, and whether ELU found the quote', t => {
  home(t);
  const root = temp(t); fs.writeFileSync(path.join(root, 'plan.md'), 'We ship the importer in March.\n');
  const web = saveFact(WEB, { now: NOV });
  assert.equal(factText(web), `f1 [market] ${WEB.claim}\n  Source: the web, https://acme.example/customers · read 2026-11-17 · quote not checked by ELU: "${WEB.quote}"`);
  const file = saveFact({ claim: 'The importer ships in March.', topic: 'business', source: { kind: 'file', path: 'plan.md' }, quote: 'We ship the importer in March.' }, { roots: [root], now: NOV });
  assert.equal(factText(file), 'f2 [business] The importer ships in March.\n  Source: the file plan.md · read 2026-11-17 · quote found in the file by ELU: "We ship the importer in March."');
  const said = saveFact({ claim: 'The team ships on Tuesdays.', topic: 'team', source: { kind: 'owner', session: '12' } }, { now: NOV });
  assert.equal(factText(said), 'f3 [team] The team ships on Tuesdays.\n  Source: the owner, who said so himself in session 12 · read 2026-11-17 · no quote');
  replaceFact('f1', { ...WEB, claim: 'Acme sells to finance teams of any size.' }, { now: NOV }); withdrawFact('f3', { now: new Date(2026, 10, 18) });
  assert.match(factText(factById('f1')), /^f1 \[market\] .+ \(replaced by f4\)\n/); assert.match(factText(factById('f4')), /^f4 \[market\] Acme sells to finance teams of any size\. \(replaces f1\)\n/);
  assert.match(factText(factById('f3')), /^f3 \[team\] The team ships on Tuesdays\. \(withdrawn 2026-11-18\)\n/);
  assert.equal(sourceText({ kind: 'elu', tool: 'ask_elu', question: 'Where do users drop off?', issue: 'iss_204', session: 's-41' }), 'ELU, ask_elu, asked "Where do users drop off?", issue iss_204, session s-41');
  assert.equal(sourceText({ kind: 'source', server: 'slack', tool: 'search_messages', question: 'pricing', ref: 'C04/p1731' }), 'slack, search_messages, asked "pricing", C04/p1731');
  assert.equal(sourceText({ kind: 'session', session: '7', project: '/work/shop' }), 'session 7 of shop');
});

test('a test with no folder of its own is refused: the owner\'s facts are never a test\'s to read or write', t => {
  // Were it not refused, it would go to a home folder made for this test, never the owner's.
  home(t); environment(t, { HOME: temp(t) }); delete process.env.XDG_CONFIG_HOME;
  assert.throws(() => saveFact(WEB), { message: /^A test must set XDG_CONFIG_HOME before it uses the facts/ });
  assert.throws(() => allFacts(), { message: /^A test must set XDG_CONFIG_HOME/ });
});
