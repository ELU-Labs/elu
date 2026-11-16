// The process that keeps one long job of a session (lib/jobs.mjs): it starts the job's command,
// writes what the command prints to the job's log, and writes how it ended, once, when it ends.
// ELU starts it apart from the turn (its own session and group, nothing of the turn's on it),
// so the turn ending, the app closing and an update of ELU leave it running: it loads Node's
// own modules only, and nothing of ELU's after it started.
//
// node job-runner.mjs <spec.json>, with the command's environment as JSON on its input, so
// no file ever holds it.
// spec: { program, args, cwd, log, pidFile, exitFile, wake, unless }. wake: a command line that
// asks ELU to look when the job has ended (the conductor, started when none runs), or null;
// unless: a file that says the owner stopped the conductor himself, so none is started for him.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const write = (file, value) => { const draft = `${file}.${process.pid}.draft`; fs.writeFileSync(draft, `${JSON.stringify(value)}\n`, { mode: 0o600 }); fs.renameSync(draft, file); };
let spec = null, env = null;
try { spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); } catch { process.exit(2); }
try { const given = JSON.parse(fs.readFileSync(0, 'utf8')); if (given && typeof given === 'object' && Object.values(given).every(value => typeof value === 'string')) env = given; } catch { env = null; }
const startedAt = Date.now();
let done = false;
function ended(result) {
  if (done) return; done = true;
  try { write(spec.exitFile, { ...result, endedAt: new Date().toISOString(), ranMs: Date.now() - startedAt }); } catch { /* ELU then reads it as ended with no exit code. */ }
  // ELU is told by itself: the conductor that runs reads the file; with none running, one starts.
  const wake = Array.isArray(spec.wake) && spec.wake.length > 1 && spec.wake.every(part => typeof part === 'string') ? spec.wake : null;
  if (wake) { try { if (fs.existsSync(wake[1]) && !(typeof spec.unless === 'string' && fs.existsSync(spec.unless))) spawn(wake[0], wake.slice(1), { detached: true, stdio: 'ignore', cwd: typeof spec.wakeCwd === 'string' ? spec.wakeCwd : '/' }).unref(); } catch { /* ELU reads the file when it next looks. */ } }
}
if (!env) ended({ code: null, signal: null, error: 'Its environment could not be read.' });
let out = null;
if (!done) { try { out = fs.openSync(spec.log, 'a', 0o600); } catch (error) { ended({ code: null, signal: null, error: `Its log could not be opened: ${error.code ?? error.message}` }); } }
if (!done) {
  let child = null;
  try { child = spawn(spec.program, Array.isArray(spec.args) ? spec.args : [], { cwd: spec.cwd, env, stdio: ['ignore', out, out] }); }
  catch (error) { ended({ code: null, signal: null, error: `It could not be started: ${error.code ?? error.message}` }); }
  try { fs.closeSync(out); } catch { /* The command holds its own. */ }
  if (child) {
    try { write(spec.pidFile, { pid: child.pid ?? null, at: new Date().toISOString() }); } catch { /* The job is found by its runner. */ }
    // A stop asks the command to end; ELU ends what is left of it a moment later (lib/jobs.mjs stopJob).
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { try { if (child.pid) process.kill(child.pid, signal); } catch { /* Ended already. */ } });
    child.once('error', error => ended({ code: null, signal: null, error: `It could not be started: ${error.code ?? error.message}` }));
    child.once('close', (code, signal) => ended({ code, signal: signal ?? null }));
  }
}
