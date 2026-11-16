// The file elu artifacts set and elu artifacts script read in a session: --file FILE, the
// script's FILE, or - for standard input. A turn's elu reads it (lib/command-client.mjs) and
// hands ELU its text, outside a sandbox where the vendor runs the command outside one, so
// ELU's relay looks at the same file to say whether the turn may run it unasked
// (lib/permission-rules.mjs allowedBy). Both read the command with this, so they never differ.
// It loads nothing, as the command loads only Node's own modules.

// argv: the words after elu, starting with artifacts. { file, rest } with rest the words
// without the file, { error } for --file with no file, or null for a command that reads none.
export function namedFile(argv) {
  if (!Array.isArray(argv) || argv[0] !== 'artifacts' || !['set', 'script'].includes(argv[1]) || argv.includes('--') || argv.some(arg => arg === '--text' || String(arg).startsWith('--text='))) return null;
  const named = argv.findIndex(arg => arg === '--file' || arg.startsWith('--file='));
  if (named >= 0) {
    const inline = argv[named].startsWith('--file='), file = inline ? argv[named].slice(7) : argv[named + 1];
    if (!file) return { error: '--file needs a file, or - for standard input.\n' };
    return { file, rest: argv.filter((_, at) => at !== named && (inline || at !== named + 1)) };
  }
  // elu artifacts script N FILE, and elu artifacts set N -: the fourth word.
  const words = argv.flatMap((arg, at) => !arg.startsWith('-') || arg === '-' ? [at] : []);
  if (words.length !== 4 || !(argv[1] === 'script' || argv[words[3]] === '-')) return null;
  return { file: argv[words[3]], rest: argv.filter((_, at) => at !== words[3]) };
}
