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
});
// The sending side's daemon commands for them (REMOTE_COMMANDS, sendPeerCommand).
export const NEW_REMOTE_COMMANDS = Object.freeze(['remoteSettings', 'remoteLog', 'remoteAgents']);
export const NOT_MY_COMPUTER = 'Only one of the owner\'s own computers can do that here. Mark it with /computers mine on this computer.';
export const NEEDS_NEWER = name => `${name} needs a newer ELU for this.`;

// What elu.remote.start takes besides today's fields. effort rides inside model
// ({ vendor, model, effort }); title is the owner's name for the session (saved as
// elu.remote.rename saves it); botModels: { <bot>: { vendor, model, effort } }; folders: checked
// by the host; mandate: a label only, the host never reads authority from it.
export const START_FIELDS = Object.freeze(['title', 'botModels', 'folders', 'mandate']);
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
// { bot, mandate, computer }. bot: the overseeing bot's name; mandate: the mandate's id
// (lib/orchestrator-mandates.mjs); computer: the sending computer's key, or null when it was this
// one. Absent means today's behaviour. The host honours it only from this computer or one of the
// owner's own (isMyComputer); from any other it is dropped and the text is a note.
/** @typedef {{ bot: string, mandate: string, computer: string|null }} AsOwner */
const NAME = /^[a-z][a-z0-9-]{0,31}$/, MANDATE = /^m[1-9]\d{0,5}$/, HEX64 = /^[0-9a-f]{64}$/;
/** @param {unknown} value @returns {AsOwner|null} */
export function asOwnerMark(value) {
  if (!isObject(value) || !NAME.test(value.bot ?? '') || !MANDATE.test(value.mandate ?? '')) return null;
  if (value.computer != null && !HEX64.test(value.computer)) return null;
  return { bot: value.bot, mandate: value.mandate, computer: value.computer ?? null };
}
// What the chat shows for a message sent as the owner.
export const OWNER_VIA = (bot, mandateName = null) => `You · via @${bot}${mandateName ? ` · ${mandateName}` : ''}`;
// The line the receiving turn reads above such a message.
export const OWNER_VIA_LINE = (bot, mandateName) => `Sent for the owner by @${bot} under the mandate ${mandateName}.`;
