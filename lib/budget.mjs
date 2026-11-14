// A session's /budget: what a role of it has spent, and how that reads.
import { isObject } from './util.mjs';
import { runCosts } from './agent-spend.mjs';

// What a role's runs spent, from the run at index from on: { known, unknown, partial, runs }.
// known: the dollars of the runs whose cost is known. unknown: how many runs have no cost
// known. partial: some run's cost is not known. runs: how many there are.
export function roleSpend(task, role, { from = 0 } = {}) {
  let known = 0, unknown = 0, partial = false, runs = 0;
  runCosts(task).forEach((cost, index) => {
    const run = task.runs[index];
    if (index < from || !isObject(run) || run.role !== role) return;
    runs++;
    if (cost !== null) { known += cost; return; }
    partial = true; unknown++;
  });
  return { known, unknown, partial, runs };
}
// What was spent, as the Usage tab and the Kanban card write it: $1.40 when every run's cost is
// known, ≥$1.40 when some run's is not, and null when no run's is (nothing is known yet).
export function spentText({ known = 0, unknown = 0, partial = false, runs = 0 } = {}) {
  if (runs > 0 && unknown === runs) return null;
  return `${partial ? '≥' : ''}$${known.toFixed(2)}`;
}
// What /budget alone says. budget: the project's budget(id).
export function budgetMessage({ spent = 0, limit = null, unknown = 0, partial = false, runs = 0 } = {}) {
  const said = spentText({ known: spent, unknown, partial, runs }), money = value => `$${Number(value).toFixed(2)}`;
  if (limit) return said === null ? `What this session has spent is not known yet. Its limit is ${money(limit)}; /budget off removes the limit.` : `This session has spent ${said} of its ${money(limit)} limit. /budget off removes the limit.`;
  return said === null ? 'What this session has spent is not known yet. It has no limit; /budget NUMBER sets one.' : `This session has spent ${said}. It has no limit; /budget NUMBER sets one.`;
}
