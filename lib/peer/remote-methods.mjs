import { isObject } from '../util.mjs';

// The names and fields the Orchestrator at Full adds to the session protocol between the owner's
// computers (lib/peer/remote.mjs). One place, so the sending side, the host and the Orchestrator's
// tools agree. A host that does not know a method or a field refuses it plainly; the sender says
// that computer needs the new ELU.

// Host methods. Each is taken only from one of the owner's own computers
// (lib/peer/my-computers.mjs isMyComputer), else NOT_MY_COMPUTER.
export const REMOTE_METHODS = Object.freeze({
  settings: 'elu.remote.settings', // access, coder model and effort, bots, bot models
  log: 'elu.remote.log', // the last rows of a session's active or last run
  agents: 'elu.remote.agents', // the session's agents (lib/session-agents.mjs)
  decisions: 'elu.remote.decisions', // the owner's decisions for the session and its Task's goal (lib/owner-decisions.mjs)
});
// The sending side's daemon commands for them (REMOTE_COMMANDS, sendPeerCommand).
export const NEW_REMOTE_COMMANDS = Object.freeze(['remoteSettings', 'remoteLog', 'remoteAgents', 'remoteDecisions']);
// What a computer's hello says it takes of these (full): 1, the start fields, settings, log and
// agents, and the owner's word under a mandate (ELU 0.1.46 to 0.1.48); 2 (OWNER_WORD_FULL), the
// owner's word with no mandate and elu.remote.decisions. The owner's word goes only to a 2.
export const OWNER_WORD_FULL = 2;
export const NOT_MY_COMPUTER = 'Only one of the owner\'s own computers can do that here: one paired with this computer as his, or one he marked here with /computers mine.';
export const NEEDS_NEWER = name => `${name} needs a newer ELU for this.`;

// What elu.remote.start takes besides today's fields. effort rides inside model
// ({ vendor, model, effort }); title is the owner's name for the session (saved as
// elu.remote.rename saves it); botModels: { <bot>: { vendor, model, effort } }; folders: checked
// by the host. A mandate an older computer sends is a label only, and is left out.
export const START_FIELDS = Object.freeze(['title', 'botModels', 'folders']);
export const TITLE_MAX = 200, LOG_ROWS_MAX = 200, LOG_ROWS_DEFAULT = 40;

/**
 * elu.remote.settings params, every part optional:
 * @typedef {{ access?: 'ask'|'auto'|'full',
 *   model?: { vendor: string, model: string, effort?: string },
 *   bots?: { add?: string[], remove?: string[] },
 *   botModels?: Record<string, { vendor: string, model: string, effort?: string }> }} RemoteSettings
 * elu.remote.log params: { rows?: number (1..LOG_ROWS_MAX), role?: 'lead' | 'bot:<name>' }
 * elu.remote.agents params: { agent?: string } (one agent's thread when given)
 */
export const SETTINGS_PARTS = Object.freeze(['access', 'model', 'bots', 'botModels']);

// The mark on a request or a message row that the owner's word came through the Orchestrator:
// { bot, computer }. bot: the overseeing bot's name; computer: the sending computer's key, or null
// when it was this one. Absent means today's behaviour. The host honours it from its own bot at
// Full, or from one of the owner's own computers (isMyComputer); from any other it is dropped and
// the text is a note. A row from before keeps a mandate's id beside them, which grants nothing.
/** @typedef {{ bot: string, computer: string|null }} AsOwner */
const NAME = /^[a-z][a-z0-9-]{0,31}$/, HEX64 = /^[0-9a-f]{64}$/;
/** @param {unknown} value @returns {AsOwner|null} */
export function asOwnerMark(value) {
  if (!isObject(value) || !NAME.test(value.bot ?? '')) return null;
  if (value.computer != null && !HEX64.test(value.computer)) return null;
  return { bot: value.bot, computer: value.computer ?? null };
}
// What the chat shows for a message sent as the owner.
export const OWNER_VIA = bot => `You · via @${bot}`;
// The line the receiving turn reads above such a message.
export const OWNER_VIA_LINE = bot => `Sent for the owner by @${bot}, the bot that runs his sessions for him.`;
