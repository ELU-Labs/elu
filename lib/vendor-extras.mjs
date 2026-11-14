import fs from 'node:fs';
import path from 'node:path';
import { atomic, isObject, personalDirectory, readJson } from './util.mjs';

// What ELU asks of a vendor's program on top of the flags every release must list (the
// adapter's meta.flags): the one thing that makes a run say what it thinks and does as it
// goes (lib/run-activity.mjs). A run works without it, so no run may fail over it.
// - Claude Code: --thinking-display. It is in no help text, and `claude <any flag> --version`
//   exits 0 for a made-up flag too (seen on 2.1.322), so the program cannot be asked.
// - Codex: the config key model_reasoning_summary, given with -c.
// - Grok Build: streaming-json, a value of --output-format.
// So the program's own file is read for the text, once for each program (its path, size and
// time), and what was found is kept. A program that does not hold the text is never given
// the option. One that holds it is; so is a small script that starts the program from
// somewhere else, which cannot say. When a run that was given the option ends at once with
// nothing printed, the runner runs the turn again without it, and when that run gets further
// the program is not given the option again (refuseExtra).
export const EXTRA_TEXT = Object.freeze({ claude: '--thinking-display', codex: 'model_reasoning_summary', grok: 'streaming-json' });
// A script this small is a launcher, not the program: a bundled program is megabytes.
const LAUNCHER_MAX = 256 * 1024, PIECE = 4 * 1024 * 1024;
const file = () => path.join(personalDirectory(), 'vendor-extras.json');
function saved() { try { const value = readJson(file()); return isObject(value) ? value : {}; } catch { return {}; } }
function save(vendor, row) { try { atomic(file(), { ...saved(), [vendor]: row }); } catch { /* Read again next time. */ } }
// true: the file holds the text. false: it is the program itself and does not. null: it
// cannot say (a launcher script, or a file that cannot be read).
function holds(program, size, text) {
  const needle = Buffer.from(text);
  let fd; try { fd = fs.openSync(program, 'r'); } catch { return null; }
  try {
    const buffer = Buffer.alloc(Math.min(Math.max(size, 2), PIECE) + needle.length);
    let offset = 0, kept = 0, script = false;
    for (;;) {
      const got = fs.readSync(fd, buffer, kept, buffer.length - kept, offset); if (!got) break;
      if (offset === 0) script = buffer[0] === 0x23 && buffer[1] === 0x21;
      const end = kept + got;
      if (buffer.subarray(0, end).includes(needle)) return true;
      // The end of this piece may hold the start of the text.
      const tail = Math.min(needle.length - 1, end); buffer.copy(buffer, 0, end - tail, end); kept = tail; offset += got;
    }
    return script && size <= LAUNCHER_MAX ? null : false;
  } catch { return null; } finally { fs.closeSync(fd); }
}
function program(vendor, bin) {
  if (!EXTRA_TEXT[vendor] || typeof bin !== 'string' || !bin) return null;
  try { const real = fs.realpathSync(bin), stat = fs.statSync(real); return stat.isFile() ? { program: real, size: stat.size, mtimeMs: stat.mtimeMs } : null; } catch { return null; }
}
const same = (kept, now) => isObject(kept) && kept.program === now.program && kept.size === now.size && kept.mtimeMs === now.mtimeMs;
// Whether a run of this program is given the vendor's option.
export function takesExtra(vendor, bin) {
  const now = program(vendor, bin); if (!now) return false;
  const kept = saved()[vendor];
  if (same(kept, now)) return kept.refused !== true && kept.has !== false;
  const row = { ...now, has: holds(now.program, now.size, EXTRA_TEXT[vendor]) };
  save(vendor, row);
  return row.has !== false;
}
// This program ended a run at once over the option and ran without it: it is not given it
// again. A later release is another program, and is read anew.
export function refuseExtra(vendor, bin) {
  const now = program(vendor, bin); if (!now) return;
  const kept = saved()[vendor];
  save(vendor, { ...(same(kept, now) ? kept : { ...now, has: null }), refused: true });
}
