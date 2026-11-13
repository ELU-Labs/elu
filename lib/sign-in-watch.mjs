import { spawn } from 'node:child_process';

// Reading a vendor's sign-in by running it, without ever waiting on a sign-in it starts.
// Antigravity CLI 1.5.8 signed out, asked `agy -p /usage`, prints "Authentication required.
// Please visit the URL to log in:", the link, "Waiting for authentication (timeout 60s)..." and
// "Or, paste the authorization code here and press Enter:", opens the browser with `open` (or
// xdg-open) from PATH, and then waits a minute for the code, even with nothing on its input.
// Interactive, it says "You are currently not signed in." and "Select login method:". The
// moment one of those is printed the read ends: the vendor is signed out, and it is stopped.
export const WAITING_FOR_SIGN_IN = /authentication required|please visit the url to log in|waiting for authentication|paste the authorization code|currently not signed in|select login method/i;
const SIGNED_OUT = /authentication (?:required|failed|timed out)|not (?:signed|logged) in|login required|log in/i;
const LIMIT = 65536;
const firstLine = text => text.split('\n').map(line => line.replace(/[\x00-\x1f\x7f]/g, '').trim()).find(Boolean)?.slice(0, 200) ?? '';
const stop = pid => { try { process.kill(-pid, 'SIGKILL'); } catch { /* Already ended. */ } };

// One run: { signedIn: true, reason: null } when it exits 0; { signedIn: false, reason } when
// it asks for a sign-in or exits saying it is signed out; { signedIn: null, reason } when it
// gives no answer in timeoutMs or exits otherwise; undefined when signal stops the wait. Its
// output is read for those words only, and never kept: the link it prints carries a code.
export function watchSignIn({ bin, args, env, cwd, timeoutMs, signal } = {}) {
  return new Promise(resolve => {
    let child = null, text = '', done = false, timer = null;
    const finish = (value, kill = true) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      if (kill && child?.pid) stop(child.pid);
      resolve(value);
    };
    const aborted = () => finish(undefined);
    if (signal?.aborted) return finish(undefined, false);
    try { child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }); }
    catch (error) { return finish({ signedIn: null, reason: `could not start: ${error.message}`.slice(0, 200) }, false); }
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => finish({ signedIn: null, reason: `gave no answer within ${Math.round(timeoutMs / 1000)} seconds` }), timeoutMs);
    // Its input stays open and empty: a pasted code is the owner's, never ELU's.
    child.stdin.on('error', () => {});
    const read = chunk => {
      if (text.length < LIMIT) text += chunk.toString('utf8').slice(0, LIMIT - text.length);
      if (WAITING_FOR_SIGN_IN.test(text)) finish({ signedIn: false, reason: 'asked for a sign-in' });
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.once('error', error => finish({ signedIn: null, reason: `could not start: ${error.message}`.slice(0, 200) }, false));
    child.once('close', code => {
      if (code === 0) return finish({ signedIn: true, reason: null }, false);
      finish(SIGNED_OUT.test(text) ? { signedIn: false, reason: 'says it is signed out' } : { signedIn: null, reason: `exited ${code ?? 'by a signal'}${firstLine(text) ? `: ${firstLine(text)}` : ''}` }, false);
    });
  });
}
