// The names the Orchestrator at Full shares across the files that build it, so each stream codes
// against the same ones. Nothing here changes what ELU does: until the owner sets the level to
// Full (/orchestrator full), every path behaves as before.

// The new top level, after Run (lib/orchestrator-settings.mjs LEVELS).
export const LEVEL_FULL = 'full';
export const LEVEL_FULL_NAME = 'Full';
export const LEVEL_FULL_MEANS = 'It works as you would: Full access with a shell, every session tool on every computer of yours, and your word inside the mandates you give it. Publishing, releases and Organization lines still ask you.';

// The flag the runner passes to the Claude adapter's compile() for an overseeing turn at Full:
// compile({ ..., oversee: true, overseeFull: true }). Without it an overseeing turn is built as today.
export const OVERSEE_FULL = 'overseeFull';

// What still asks the owner at Full, as Claude Code permissions.ask rules on the Orchestrator's
// own turn. Each goes to the owner through the approval relay, which ELU never answers by itself.
export const FULL_ASK_LIST = Object.freeze([
  'Bash(npm publish:*)', 'Bash(npx * publish:*)', 'Bash(git tag:*)', 'Bash(git push --tags:*)', 'Bash(git push *--follow-tags*)',
  'Bash(gh release:*)', 'Bash(gh workflow run:*)', 'Bash(gh repo delete:*)', 'Bash(git push --force*)', 'Bash(git push -f*)', 'Bash(rm -rf ~*)',
]);

// The caps at Full: their defaults and the most each may be set to (lib/orchestrator-settings.mjs).
// null: no cap of the Orchestrator's own; the session's own budget applies.
export const FULL_CAPS = Object.freeze({
  sessionsPerDay: { value: 20, most: 100 },
  messagesPerHour: { value: 60, most: 300 },
  messagesInARow: { value: 5, most: 20 },
  startBudgetUsd: { value: null },
  turnLimitUsd: { value: null },
  startMode: { value: 'full' },
});

// The new session tools at Full (lib/orchestrator-tools.mjs), beside today's.
export const FULL_TOOLS = Object.freeze(['session_approve', 'session_stop', 'session_rename', 'session_archive', 'session_settings', 'session_log', 'session_agents', 'mandate_propose']);
