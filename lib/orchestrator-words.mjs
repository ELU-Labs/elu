// What the command list says of /orchestrator and /computers (lib/terminal-commands.mjs COMMANDS
// and the words each offers after its name). Kept apart from lib/orchestrator-commands.mjs, which
// re-exports them, so the command list does not load the Orchestrator to show its words.
export const ORCHESTRATOR_USAGE = '/orchestrator [watch|suggest|act|run|full] · /orchestrator mandate [NAME: decisions|NAME add [N]|NAME drop [N]|remove NAME] · /orchestrator undo <id>';
export const COMPUTERS_USAGE = '/computers [mine <name>|unmine <name>]';
export const COMPUTERS_COMMAND = Object.freeze({ name: 'computers', description: 'Mark which computers on your projects are yours: what one sends for you then counts as your own words here', usage: COMPUTERS_USAGE });
export const ORCHESTRATOR_WORDS = Object.freeze({ full: 'Works as you would, with a shell and your word inside your mandates; publishing still asks you', mandate: 'Your word for one goal: mandate NAME: decision; decision', mandates: 'Your mandates and their sessions' });
export const COMPUTERS_WORDS = Object.freeze({ mine: 'Mark a computer as yours, on this computer', unmine: 'Take the mark away' });
