// Pure data about the vendor CLIs ELU can launch. No imports, so every module may read it.
export const VENDORS = Object.freeze(['claude', 'codex', 'agy', 'grok']);
export const VENDOR_NAMES = Object.freeze({ claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity CLI', grok: 'Grok Build' });
// What the owner types in a terminal to sign in to each vendor's own CLI.
export const SIGN_IN_COMMAND = Object.freeze({ claude: 'claude', codex: 'codex login', agy: 'agy', grok: 'grok login' });
// lead/reviewer: roles it may take. lockedEdit: may edit in locked. commands: enforces a
// per-run command allow-list. budget: enforces a dollar budget. peer: may answer teammates.
// relay: how a live approval reaches the owner ('mcp' | 'acp' | null).
// conformance: needs the per-machine check before a run.
// model: 'none' | 'optional' | 'required' (a role may or must name a model).
// Codex leads in every mode through -c keys; its reviewer stays the locked launch.
export const CAPS = Object.freeze({
  claude: Object.freeze({ lead: true, reviewer: true, lockedEdit: true, commands: true, budget: true, peer: true, relay: 'mcp', conformance: false, model: 'optional' }),
  codex: Object.freeze({ lead: true, reviewer: true, lockedEdit: false, commands: false, budget: false, peer: false, relay: null, conformance: false, model: 'optional' }),
  agy: Object.freeze({ lead: true, reviewer: true, lockedEdit: false, commands: false, budget: false, peer: false, relay: 'acp', conformance: true, model: 'optional' }),
  grok: Object.freeze({ lead: true, reviewer: false, lockedEdit: false, commands: false, budget: false, peer: false, relay: 'acp', conformance: true, model: 'optional' }),
});
// The effort levels a role may ask for, and the ones each vendor's command line takes; an
// empty list means that vendor has no such setting. A model name becomes an argument, so it
// never starts with a dash.
export const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const VENDOR_EFFORTS = Object.freeze({ claude: EFFORTS, codex: EFFORTS, agy: Object.freeze([]), grok: Object.freeze([]) });
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/;
// The model of the helpers of a bot that names none for them: Claude Code's own word for
// the model of the turn that starts a helper.
export const OWN_MODEL = 'inherit';
// Home entries no agent may read, whatever the project is. Shared by the adapters and by
// the folder check, so one list says what a named folder may never be.
export const HOME_SECRETS = Object.freeze(['.ssh', '.aws', '.azure', '.config', '.claude', '.claude.json', '.codex', '.gnupg', '.docker', '.kube', '.netrc', '.git-credentials', '.pgpass', '.npmrc', '.pypirc', '.zsh_history', '.zsh_sessions', '.bash_history', '.python_history', '.node_repl_history', '.psql_history', '.mysql_history', 'Library']);
// ENFORCEMENT[vendor][profile] = [{ rule, enforcement }] for policyReport. An enforcement
// is a string, or a function of the role when it depends on the role's own settings.
const network = role => role.network === 'off' ? 'OS sandbox' : 'not expressible';
export const ENFORCEMENT = {
  claude: {
    locked: [
      { rule: 'network', enforcement: network },
      { rule: 'read and write paths', enforcement: role => `vendor permissions${role.commands.length ? ' and OS sandbox; temp folder writable' : ''}` },
      { rule: 'command prefixes', enforcement: role => role.commands.length ? 'vendor command permissions' : 'vendor tool list disables command execution' },
      { rule: 'no MCP servers or hooks', enforcement: 'vendor strict empty MCP and disabled hooks' },
      { rule: 'never push, tag, merge, deploy, or publish', enforcement: 'vendor tool restrictions and OS sandbox' },
      { rule: 'time limit', enforcement: 'process group timeout' },
      { rule: 'dollar limit', enforcement: 'vendor budget flag' },
    ],
    // Ask for approval, Approve for me and Full access.
    ask: [
      { rule: 'network', enforcement: 'vendor sandbox; web tools and escapes ask the owner' },
      { rule: 'read and write paths', enforcement: 'vendor permissions and OS sandbox; outside edits ask the owner' },
      { rule: 'command prefixes', enforcement: 'vendor sandbox; commands outside it ask the owner' },
      { rule: 'no MCP servers or hooks', enforcement: 'vendor strict MCP config (your servers and the approval relay) and disabled hooks' },
      { rule: 'never push, tag, merge, deploy, or publish', enforcement: 'vendor deny rules, stand-in commands first on PATH for what a script runs, and OS sandbox; every escape asks' },
      { rule: 'time limit', enforcement: 'process group timeout, paused while an approval waits' },
      { rule: 'dollar limit', enforcement: 'vendor budget flag' },
    ],
    auto: [
      { rule: 'network', enforcement: 'vendor sandbox; a reviewer model decides escapes' },
      { rule: 'read and write paths', enforcement: 'vendor permissions and OS sandbox; a reviewer model decides outside edits' },
      { rule: 'command prefixes', enforcement: 'vendor sandbox; a reviewer model decides commands outside it' },
      { rule: 'no MCP servers or hooks', enforcement: 'vendor strict MCP config (your servers and the approval relay) and disabled hooks' },
      { rule: 'never push, tag, merge, deploy, or publish', enforcement: 'vendor deny rules and stand-in commands first on PATH; an obscured command gets through if the reviewer allows it' },
      { rule: 'time limit', enforcement: 'process group timeout, paused while an approval waits' },
      { rule: 'dollar limit', enforcement: 'vendor budget flag' },
    ],
    full: [
      { rule: 'network', enforcement: 'not enforced' },
      { rule: 'read and write paths', enforcement: 'vendor deny rules for secrets and ELU state only; a shell can read anything' },
      { rule: 'command prefixes', enforcement: 'not enforced' },
      { rule: 'no MCP servers or hooks', enforcement: 'vendor strict MCP config (your servers and the approval relay) and disabled hooks' },
      { rule: 'never push, tag, merge, deploy, or publish', enforcement: 'prompt text, vendor deny rules and stand-in commands first on PATH only' },
      { rule: 'time limit', enforcement: 'process group timeout' },
      { rule: 'dollar limit', enforcement: 'vendor budget flag' },
    ],
  },
  codex: {
    locked: [
      { rule: 'network', enforcement: network },
      { rule: 'read and write paths', enforcement: 'OS sandbox' },
      { rule: 'command prefixes', enforcement: role => role.commands.length ? 'not expressible' : 'vendor tool list disables command execution' },
      { rule: 'no MCP servers or hooks', enforcement: 'ignore user configuration; project and managed configuration refuse launch' },
      { rule: 'never push, tag, merge, deploy, or publish', enforcement: 'vendor tool restrictions and OS sandbox' },
      { rule: 'time limit', enforcement: 'process group timeout' },
      { rule: 'dollar limit', enforcement: role => role.maxCostUsd === null ? 'not requested; time limit only' : 'not expressible' },
    ],
    ask: [
      { rule: 'network', enforcement: 'OS sandbox; blocked actions are reported' },
      { rule: 'read and write paths', enforcement: 'vendor permission profile and OS sandbox; secrets and state denied, named folders read only' },
      { rule: 'command prefixes', enforcement: 'any command inside the OS sandbox' },
      { rule: 'no MCP servers or hooks', enforcement: 'ignore user configuration; project and managed configuration refuse launch' },
      { rule: 'never push, tag, merge, deploy, or publish', enforcement: 'stand-in commands first on PATH refuse by name; OS sandbox: no network, Git common directory read-only' },
      { rule: 'time limit', enforcement: 'process group timeout' },
      { rule: 'dollar limit', enforcement: role => role.maxCostUsd === null ? 'not requested; time limit only' : 'not expressible' },
    ],
    auto: [
      { rule: 'network', enforcement: 'OS sandbox; escapes go to the vendor reviewer model' },
      { rule: 'read and write paths', enforcement: 'vendor permission profile and OS sandbox; escapes go to the vendor reviewer model' },
      { rule: 'command prefixes', enforcement: 'any command inside the OS sandbox; escapes reviewed' },
      { rule: 'no MCP servers or hooks', enforcement: 'ignore user configuration; project and managed configuration refuse launch' },
      { rule: 'never push, tag, merge, deploy, or publish', enforcement: 'stand-in commands first on PATH refuse by name (a tripwire, not a boundary); an escape goes to the vendor reviewer model' },
      { rule: 'time limit', enforcement: 'process group timeout' },
      { rule: 'dollar limit', enforcement: role => role.maxCostUsd === null ? 'not requested; time limit only' : 'not expressible' },
    ],
    full: [
      { rule: 'network', enforcement: 'not enforced' },
      { rule: 'read and write paths', enforcement: 'not enforced; no sandbox' },
      { rule: 'command prefixes', enforcement: 'any command, no sandbox' },
      { rule: 'no MCP servers or hooks', enforcement: 'ignore user configuration; project and managed configuration refuse launch' },
      { rule: 'never push, tag, merge, deploy, or publish', enforcement: 'prompt text and stand-in commands first on PATH only; a full path to the real command gets past' },
      { rule: 'time limit', enforcement: 'process group timeout' },
      { rule: 'dollar limit', enforcement: role => role.maxCostUsd === null ? 'not requested; time limit only' : 'not expressible' },
    ],
  },
  // Antigravity CLI runs under a private HOME holding only ELU's settings and hook; its
  // enforcement is the vendor's permission rules, its sandbox, and the hook on command text.
  agy: {
    locked: [
      { rule: 'network', enforcement: 'vendor permissions deny read_url and execute_url; hook denies search_web' },
      { rule: 'read and write paths', enforcement: 'vendor workspace-only access and write_file deny; OS sandbox' },
      { rule: 'command prefixes', enforcement: role => role.commands.length ? 'not expressible' : 'vendor command deny and hook deny' },
      { rule: 'no MCP servers or hooks', enforcement: 'private HOME holds only ELU settings and its hook; vendor mcp deny' },
      { rule: 'never push, tag, merge, deploy, or publish', enforcement: 'vendor tool denies and OS sandbox' },
      { rule: 'time limit', enforcement: 'process group timeout and vendor print timeout' },
      { rule: 'dollar limit', enforcement: role => role.maxCostUsd === null ? 'not requested; time limit only' : 'not expressible' },
    ],
    ask: [
      { rule: 'network', enforcement: 'asks you live over ACP, or denied and reported' },
      { rule: 'read and write paths', enforcement: 'workspace, and named folders read only; an outside edit asks or is reported; secret and protected paths denied' },
      { rule: 'command prefixes', enforcement: 'every command asks or is reported' },
      { rule: 'no MCP servers or hooks', enforcement: 'private HOME holds only ELU settings and its hook; MCP asks' },
      { rule: 'never push, tag, merge, deploy, or publish', enforcement: 'hook denies by command text, stand-in commands first on PATH refuse by name; commands ask' },
      { rule: 'time limit', enforcement: 'process group timeout and vendor print timeout; held while an approval waits' },
      { rule: 'dollar limit', enforcement: role => role.maxCostUsd === null ? 'not requested; time limit only' : 'not expressible' },
    ],
    auto: [
      { rule: 'network', enforcement: 'reviewer model decides over ACP, or denied and reported; hook denies search_web' },
      { rule: 'read and write paths', enforcement: 'workspace, and named folders read only; OS sandbox; secret and protected paths denied' },
      { rule: 'command prefixes', enforcement: 'reviewer model decides or reported; sudo denied' },
      { rule: 'no MCP servers or hooks', enforcement: 'private HOME holds only ELU settings and its hook; MCP reviewed' },
      { rule: 'never push, tag, merge, deploy, or publish', enforcement: 'hook denies by command text, stand-in commands first on PATH refuse by name (tripwires, not a boundary)' },
      { rule: 'time limit', enforcement: 'process group timeout and vendor print timeout; held while an approval waits' },
      { rule: 'dollar limit', enforcement: role => role.maxCostUsd === null ? 'not requested; time limit only' : 'not expressible' },
    ],
    full: [
      { rule: 'network', enforcement: 'open' },
      { rule: 'read and write paths', enforcement: 'any path; secret and state folders denied to the file tool only' },
      { rule: 'command prefixes', enforcement: 'any command, no sandbox' },
      { rule: 'no MCP servers or hooks', enforcement: 'private HOME holds only ELU settings and its hook; MCP allowed' },
      { rule: 'never push, tag, merge, deploy, or publish', enforcement: 'prompt text, the hook on command text and stand-in commands first on PATH only' },
      { rule: 'time limit', enforcement: 'process group timeout and vendor print timeout' },
      { rule: 'dollar limit', enforcement: role => role.maxCostUsd === null ? 'not requested; time limit only' : 'not expressible' },
    ],
  },
  // Grok Build: every profile is designed from the vendor's docs and proven
  // per machine by Grok's one-time check. Deny rules match command text: a tripwire.
  grok: {
    locked: [
      { rule: 'network', enforcement: 'vendor tool list removes web tools; no shell; the model call itself uses the network' },
      { rule: 'read and write paths', enforcement: 'vendor read-only sandbox, tool list and deny rules; secrets denied by rule' },
      { rule: 'command prefixes', enforcement: 'vendor tool list disables command execution' },
      { rule: 'no MCP servers or hooks', enforcement: 'private home with ELU configuration; vendor Claude and Cursor compatibility off; no folder trust' },
      { rule: 'never push, tag, merge, deploy, or publish', enforcement: 'vendor tool restrictions and read-only sandbox' },
      { rule: 'time limit', enforcement: 'process group timeout and vendor turn limit' },
      { rule: 'dollar limit', enforcement: role => role.maxCostUsd === null ? 'not requested; time limit only' : 'not expressible' },
    ],
    ask: [
      { rule: 'network', enforcement: 'vendor permission rules: web and shell ask over ACP, or are denied and reported in headless mode' },
      { rule: 'read and write paths', enforcement: 'vendor permission rules: workspace edits free, outside edits ask; secrets denied by rule' },
      { rule: 'command prefixes', enforcement: 'not expressible; every shell command asks' },
      { rule: 'no MCP servers or hooks', enforcement: 'private home with ELU configuration; vendor Claude and Cursor compatibility off; no folder trust' },
      { rule: 'never push, tag, merge, deploy, or publish', enforcement: 'vendor deny rules on command text and stand-in commands first on PATH (tripwires)' },
      { rule: 'time limit', enforcement: 'process group timeout and vendor turn limit; paused while an approval waits' },
      { rule: 'dollar limit', enforcement: role => role.maxCostUsd === null ? 'not requested; time limit only' : 'not expressible' },
    ],
    auto: [
      { rule: 'network', enforcement: 'vendor reviewer model decides; a refused action asks over ACP or is reported' },
      { rule: 'read and write paths', enforcement: 'vendor permission rules and workspace sandbox in headless mode; secrets denied by rule' },
      { rule: 'command prefixes', enforcement: 'vendor reviewer model decides' },
      { rule: 'no MCP servers or hooks', enforcement: 'private home with ELU configuration; vendor Claude and Cursor compatibility off; no folder trust' },
      { rule: 'never push, tag, merge, deploy, or publish', enforcement: 'vendor deny rules on command text and stand-in commands first on PATH (tripwires)' },
      { rule: 'time limit', enforcement: 'process group timeout and vendor turn limit; paused while an approval waits' },
      { rule: 'dollar limit', enforcement: role => role.maxCostUsd === null ? 'not requested; time limit only' : 'not expressible' },
    ],
    full: [
      { rule: 'network', enforcement: 'not enforced' },
      { rule: 'read and write paths', enforcement: 'not enforced; secret reads denied by rule (file tools only)' },
      { rule: 'command prefixes', enforcement: 'not enforced' },
      { rule: 'no MCP servers or hooks', enforcement: 'private home with ELU configuration; vendor Claude and Cursor compatibility off; no folder trust' },
      { rule: 'never push, tag, merge, deploy, or publish', enforcement: 'vendor deny rules on command text, stand-in commands first on PATH and prompt text only' },
      { rule: 'time limit', enforcement: 'process group timeout and vendor turn limit' },
      { rule: 'dollar limit', enforcement: role => role.maxCostUsd === null ? 'not requested; time limit only' : 'not expressible' },
    ],
  },
};
