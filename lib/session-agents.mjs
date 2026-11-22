// Every agent of a session, for the Agents tab (lib/terminal.mjs), the Orchestrator's
// session_agents tool and elu.remote.agents (lib/peer/remote-methods.mjs): the coder, each bot,
// the sub-agents of their runs (Claude Code Task/Agent subagents by parent_tool_use_id, Codex
// in-session agents by their collab spawn and wait items), and the helpers started as ELU jobs
// that run an agent (codex exec, claude -p), read from the job's own log. Read from the
// session's records and logs only; no model call. A helper started as a detached process is not
// an ELU job and is not listed.

export const AGENT_KINDS = Object.freeze(['coder', 'bot', 'subagent', 'helper']);
export const AGENT_STATES = Object.freeze(['working', 'waiting', 'done']);
export const SUMMARY_MAX = 160;

/**
 * One row of the Agents tab.
 * @typedef {{
 *   id: string,            // stable within the session: 'lead', 'bot:<name>', 'sub:<role>:<tool_use_id>', 'job:<name>'
 *   kind: 'coder'|'bot'|'subagent'|'helper',
 *   name: string,          // what the row shows: the model's label, '@advisor', a sub-agent's description, the job's name
 *   parent: string|null,   // the id of the agent that started it, for sub-agents and helpers
 *   vendor: string|null, model: string|null, effort: string|null,
 *   state: 'working'|'waiting'|'done',
 *   since: string|null,    // ISO time of the state's start
 *   spend: number|null,    // dollars, when the vendor says
 *   summary: string,       // one line of what it is on now: its latest message, plan step or tool call (at most SUMMARY_MAX)
 *   log: string|null       // the file its thread is read from
 * }} AgentRow
 *
 * One entry of an agent's thread, drawn like Chat.
 * @typedef {{ at: string|null, kind: 'message'|'step'|'result'|'note', text: string, tool?: string }} AgentEntry
 */

// The session's agents, coder first, then bots, then each one's sub-agents and helpers under it.
/** @param {object} repo @param {object} task @returns {AgentRow[]} */
export function sessionAgents(repo, task) { void repo; void task; return []; }

// One agent's thread, oldest first. An id that is not one of sessionAgents' is [].
/** @param {object} repo @param {object} task @param {string} id @param {{ rows?: number }} [options] @returns {AgentEntry[]} */
export function agentThread(repo, task, id, options = {}) { void repo; void task; void id; void options; return []; }
