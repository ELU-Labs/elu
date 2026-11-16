// One refresh of a session's artifact, in a process of its own that ELU starts while it runs
// (lib/artifacts.mjs refreshDue), so the app never waits for a script.
//
// node artifact-refresh.mjs <project folder> <session> <artifact key>
import { runRefresh } from './artifacts.mjs';

const [root, id, key] = process.argv.slice(2);
try { await runRefresh(root, id, key); } catch { /* The next look tries again. */ }
