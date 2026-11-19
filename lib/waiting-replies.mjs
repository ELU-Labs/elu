import fs from 'node:fs';
import path from 'node:path';
import { taskDir } from './state.mjs';
import { noSymlinks } from './util.mjs';

// What the owner answered a message another computer sent into a session, in place of letting
// it run: Reply under a message that waits for his yes. It is his answer to whoever sent it,
// not a message to the session: it shows in the session's chat, here and on every computer
// that watches the session, and the session's model never reads it. It is kept beside the
// session's record, as its ! commands are (lib/shell.mjs), so a turn that holds the record
// never writes over it.
const file = (repo, id) => path.join(taskDir(repo, id), 'replies.jsonl');
export const replyFile = file;
// who: whom it answers, as the chat names them (ana on @my-box); about: the first words of
// the message it answers.
export function recordReply(repo, id, { text, who, about = '' }) {
  const target = file(repo, id); noSymlinks(target);
  const row = { at: new Date().toISOString(), text: String(text), who: String(who), about: String(about) };
  fs.appendFileSync(target, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  return row;
}
// Every reply of a session, oldest first. A torn or foreign line is skipped.
export function replyRows(repo, id) {
  let text;
  try { const target = file(repo, id); noSymlinks(target); text = fs.readFileSync(target, 'utf8'); } catch { return []; }
  return text.split('\n').flatMap(line => { try { const row = JSON.parse(line); return row && typeof row.at === 'string' && typeof row.text === 'string' && typeof row.who === 'string' ? [row] : []; } catch { return []; } });
}
