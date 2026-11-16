// elu as a session's turn has it (lib/session-commands.mjs openPlace): elu sessions, elu
// schedules and elu artifacts, handed to ELU outside the vendor's sandbox. The command writes its request into
// the turn's own folder, named in the line that starts it, and prints ELU's answer. Nothing
// here reads the environment, which a sandbox may drop, or ELU's own files, which it keeps
// from commands, and it loads Node's own modules only, and lib/artifact-file.mjs, which loads none.
//
// node command-client.mjs <folder> <session> <mode> [elu arguments...]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { namedFile } from './artifact-file.mjs';

const HELP = 'In a session, elu has elu sessions, elu schedules, elu artifacts and elu jobs. elu sessions --help, elu schedules --help, elu artifacts --help and elu jobs --help say more.\n';
// elu artifacts set N --file FILE and elu artifacts script N FILE: the file is read here, with
// what the turn may read itself (- is standard input), and handed to ELU as text (--text), so ELU
// never reads a path a turn names. Where the vendor runs this outside its sandbox, ELU's relay
// asks the owner first for a file the sandbox keeps from the turn (lib/artifact-file.mjs).
// Returns the arguments to send, or a line that says why not.
const MOST_CHARS = 20000;
function withText(argv) {
  const named = namedFile(argv);
  if (!named) return { argv };
  if (named.error) return { error: named.error };
  const { file, rest } = named;
  let text; try { text = fs.readFileSync(file === '-' ? 0 : file, 'utf8'); } catch (error) { return { error: `${file === '-' ? 'Standard input' : file} could not be read: ${error.code ?? error.message}.\n` }; }
  if (text.length > MOST_CHARS) return { error: `${file === '-' ? 'Standard input' : file} has ${text.length} characters: at most ${MOST_CHARS}.\n` };
  return { argv: [...rest, '--text', text] };
}
// How long ELU has to take a request it was handed, how often the command looks, and how often
// it says it still waits (id.wait): ELU runs nothing the owner allows once the command is gone.
const TAKE_MS = 20000, POLL_MS = 50, BEAT_MS = 250;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const gone = folder => { try { return !fs.statSync(folder).isDirectory(); } catch { return true; } };

async function main([folder, session, mode, ...given]) {
  if (!['sessions', 'schedules', 'artifacts', 'jobs'].includes(given[0])) {
    const argv = given;
    const asked = !argv.length || ['-h', '--help', 'help'].includes(argv[0]);
    (asked ? process.stdout : process.stderr).write(HELP);
    return asked ? 0 : 1;
  }
  const read = withText(given);
  if (read.error) { process.stderr.write(read.error); return 1; }
  const argv = read.argv;
  const id = crypto.randomBytes(12).toString('hex');
  const request = path.join(folder, `${id}.request.json`), answer = path.join(folder, `${id}.answer.json`), draft = path.join(folder, `.${id}.draft`), wait = path.join(folder, `${id}.wait`);
  try {
    fs.writeFileSync(wait, '', { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(draft, JSON.stringify({ v: 1, id, session, mode, argv, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(draft, request);
  } catch (error) {
    for (const file of [draft, wait]) { try { fs.rmSync(file, { force: true }); } catch { /* Never written. */ } }
    process.stderr.write(`ELU could not be reached from this command (${error.code ?? error.message}). The owner can run it himself: elu ${argv.join(' ')}\n`);
    return 1;
  }
  const started = Date.now();
  let beat = started;
  for (;;) {
    let text = null;
    try { text = fs.readFileSync(answer, 'utf8'); } catch { /* Not answered yet. */ }
    if (text !== null) {
      for (const file of [answer, wait]) { try { fs.rmSync(file, { force: true }); } catch { /* The folder goes with the turn. */ } }
      let value = null; try { value = JSON.parse(text); } catch { /* Read below. */ }
      if (!value || typeof value !== 'object') { process.stderr.write('ELU sent an answer that could not be read.\n'); return 1; }
      if (typeof value.out === 'string') process.stdout.write(value.out);
      if (typeof value.err === 'string') process.stderr.write(value.err);
      return Number.isInteger(value.code) ? value.code : 1;
    }
    if (gone(folder)) { process.stderr.write('The turn ended before ELU answered.\n'); return 1; }
    // ELU takes a request at once while the turn runs: one still there was never seen.
    if (Date.now() - started > TAKE_MS && fs.existsSync(request)) {
      let taken = false; try { fs.unlinkSync(request); } catch { taken = true; }
      if (!taken) { try { fs.rmSync(wait, { force: true }); } catch { /* The folder goes with the turn. */ } process.stderr.write('ELU did not take the request. Nothing was changed.\n'); return 1; }
    }
    if (Date.now() - beat >= BEAT_MS) { beat = Date.now(); try { const now = new Date(); fs.utimesSync(wait, now, now); } catch { /* ELU then runs nothing more for it. */ } }
    await sleep(POLL_MS);
  }
}
process.exitCode = await main(process.argv.slice(2));
