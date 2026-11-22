// What the command list says of /orchestrator and /computers (lib/terminal-commands.mjs COMMANDS
// and the words each offers after its name). Kept apart from lib/orchestrator-commands.mjs, which
// re-exports them, so the command list does not load the Orchestrator to show its words.
export const ORCHESTRATOR_USAGE = '/orchestrator [watch|suggest|act|run|full] · /orchestrator undo <id>';
export const COMPUTERS_USAGE = '/computers [mine <name>|unmine <name>]';
export const COMPUTERS_COMMAND = Object.freeze({ name: 'computers', description: 'Which computers on your projects are yours: paired ones are, and you can mark or unmark one here', usage: COMPUTERS_USAGE });
export const ORCHESTRATOR_WORDS = Object.freeze({ full: 'The default: works as you would, with a shell, and its words to your own sessions are yours; publishing still asks you' });
export const COMPUTERS_WORDS = Object.freeze({ mine: 'Make a computer that is not paired yours, on this computer', unmine: 'Say a computer is not yours here, paired or not' });
