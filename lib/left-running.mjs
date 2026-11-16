// What a turn left running in the background when it ended. A vendor that wrote its answer and
// stayed open for such a command is ended with it (lib/process.mjs afterResult): the command
// was the turn's, so it ends with the turn. One that ended by itself while a command of its
// shell still ran (sleep 600 &) leaves that command to end with it too. The chat says so in
// one line of ELU's (leftLine), and the next turn of the same agent is told (leftNote), with
// the way to start what must outlive a turn (elu jobs, lib/jobs.mjs).
const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
// A command as a vendor's log has it, without the shell the vendor wraps it in (Codex:
// /bin/zsh -lc '...'), as a line or as the words of one.
const SHELL = /^(?:\S*\/)?(?:ba|z|da|k)?sh$/;
function unwrapped(text) {
  const wrapped = /^\s*(\S+)\s+(?:-[A-Za-z]+\s+)*?-[A-Za-z]*c\s+([\s\S]+)$/.exec(text);
  if (!wrapped || !SHELL.test(wrapped[1])) return text;
  const script = wrapped[2].trim();
  if (/^'[\s\S]*'$/.test(script)) return script.slice(1, -1).replaceAll("'\\''", "'");
  if (/^"[\s\S]*"$/.test(script)) return script.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  return script;
}
function ofWords(words) {
  const at = SHELL.test(words[0]) ? words.findIndex((word, index) => index > 0 && /^-[A-Za-z]*c$/.test(word)) : -1;
  return at > 0 && typeof words[at + 1] === 'string' ? words[at + 1] : words.join(' ');
}
// Every shell command a turn's log shows the turn ran, whole and in the order it ran them,
// whatever the vendor: the value of each "command" (or "cmd") in a row of its log. Claude
// Code's Bash calls, Codex's command_execution items and an ACP tool call's input all name
// theirs so. A program listed with its args (an MCP server's) is not a command of the turn.
export function ranCommands(logText) {
  const found = [];
  const take = value => {
    const text = typeof value === 'string' ? unwrapped(value) : Array.isArray(value) && value.length && value.every(word => typeof word === 'string') ? ofWords(value) : '';
    if (text.trim() && !found.includes(text)) found.push(text);
  };
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, inner] of Array.isArray(value) ? value.entries() : Object.entries(value)) { if ((key === 'command' || key === 'cmd') && !Array.isArray(value.args)) take(inner); walk(inner); }
  };
  for (const line of String(logText ?? '').split('\n')) {
    if (!line.includes('"command"') && !line.includes('"cmd"')) continue;
    try { walk(JSON.parse(line)); } catch { /* Not a row. */ }
  }
  return found;
}
// The simple commands of a shell line, each as the system lists its process: without its
// redirections, its quotes, and the words that only start it (nohup, setsid, NAME=value).
const STARTERS = /^(?:(?:nohup|setsid|exec|command|time|env|nice(?:\s+-n\s*-?\d+|\s+-\d+)?|[A-Za-z_]\w*=\S*)\s+)+/;
const simple = command => command.replace(/\d*(?:>>?|<)&?\s*[^\s;&|()]+/g, ' ').replace(/["']/g, '').split(/\n|&&|\|\||[;&|()]/).map(piece => clean(piece).replace(STARTERS, '')).filter(Boolean);
// A process is one of them when it is listed as that command, whatever folder its program is
// in, or as that command behind the program that reads it (/bin/bash ./gate.sh).
const program = text => text.replace(/^\S*\//, '');
const runsAs = (listed, command) => program(listed) === program(command) || (listed.includes(' ') && program(listed.slice(listed.indexOf(' ') + 1)) === program(command));
// Or a shell that still carries a whole command of several words (a loop, a group it left
// running), which is named as the turn wrote it.
const carries = (listed, command) => { const at = command.includes(' ') ? listed.indexOf(command) : -1; return at >= 0 && !/[^\s'"]/.test(listed[at - 1] ?? ' ') && !/[^\s'"]/.test(listed[at + command.length] ?? ' '); };
// The commands that still ran, as the turn started them. adapter: the vendor's; one that names
// the background commands of a turn in its log (Claude Code) is asked for those that still had
// a process (left: what was running under the run when it ended). stayed: the vendor had
// answered and stayed open, so it waited on something: the last command it started when no
// process names one, and another vendor's first process that was left. A vendor that ended by
// itself names only what its own log shows the turn ran and that still had a process, on
// every vendor, and never a helper of its own (an MCP server): no command of the log is it.
export function leftCommands(adapter, logText, left, { stayed = true } = {}) {
  const procs = (Array.isArray(left) ? left : []).filter(value => typeof value === 'string');
  // Claude Code runs a command inside eval '...', each ' of it written '\''.
  const plain = procs.map(text => text.replaceAll("'\\''", "'"));
  let started = [];
  if (typeof adapter?.backgroundCommands === 'function') { try { started = adapter.backgroundCommands(logText).filter(value => typeof value === 'string' && value.trim()); } catch { started = []; } }
  else if (stayed) return procs.slice(0, 1).map(clean).filter(Boolean);
  const still = started.filter(command => plain.some(text => text.includes(command)));
  if (stayed) return [...new Set((still.length ? still : started.slice(-1)).map(clean).filter(Boolean))];
  let ran = []; try { ran = ranCommands(logText); } catch { ran = []; }
  const pieces = ran.flatMap(simple), whole = ran.map(clean).filter(Boolean);
  const shown = plain.map(clean).filter(Boolean).flatMap(listed => pieces.some(piece => runsAs(listed, piece)) ? [listed] : whole.filter(command => carries(listed, command)).slice(0, 1));
  return [...new Set([...still.map(clean).filter(Boolean), ...shown])];
}
const short = text => text.length > 80 ? `${text.slice(0, 79)}…` : text;
export function leftLine(commands) {
  const shown = commands.slice(0, 3).map(short).join('; ');
  return `Its turn ended, and ${commands.length === 1 ? 'the command' : `the ${commands.length} commands`} it left running in the background ended with it: ${shown}${commands.length > 3 ? '; …' : ''}`;
}
// For the prompt of the next turn of the agent that left them (task.leftBehind, lib/runner.mjs).
export function leftNote(task, roleName) {
  const kept = task?.leftBehind;
  if (!kept || kept.role !== roleName || !Array.isArray(kept.commands) || !kept.commands.length) return [];
  const commands = kept.commands.filter(value => typeof value === 'string' && value);
  if (!commands.length) return [];
  return [`Your last turn ended while ${commands.length === 1 ? 'a command' : `${commands.length} commands`} you had left running in the background still ran, and ${commands.length === 1 ? 'it' : 'they'} ended with the turn: ${commands.join('; ')}. Nothing of ${commands.length === 1 ? 'it' : 'them'} runs now. Start what must outlive a turn with elu jobs start NAME -- COMMAND.`];
}
