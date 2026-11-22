// The never list and the names no session may read, as rules. Imported by the Claude adapter,
// which holds Claude Code to them, and by lib/never-list.mjs, which words them. A module of its
// own, importing nothing, so it is whole whichever of those two is loaded first.

// A project can be a folder of repositories, or your whole home, so the owner's lead may
// read across home to find code. These stay unreadable wherever the project is.
export const SENSITIVE = ['.env*', '.npmrc', '.netrc', '.pypirc', 'auth.json', 'credentials', 'credentials.json', 'id_rsa', 'id_ed25519', '*.pem'];

// The never list as Claude Code deny rules, in Ask for approval and Approve for me. They match
// command text, so they are a tripwire: `git -C . push` or `sh -c` get past them. The sandbox,
// the stand-in commands and the prompt carry the rest. Adding or removing an MCP server is on
// it too: there only the owner does that (/mcp add, elu mcp add). Full access has none of it.
export const MCP_NEVER = Object.freeze(['claude mcp add', 'claude mcp add-json', 'claude mcp add-from-claude-desktop', 'claude mcp remove', 'elu mcp add', 'elu mcp remove']);
export const NEVER_RULES = Object.freeze(['git push', 'git tag', 'git merge', 'gh pr merge', 'gh release', 'npm publish', 'pnpm publish', 'yarn publish', 'cargo publish', 'firebase deploy', 'vercel deploy', 'gcloud run deploy', 'gcloud app deploy', 'fly deploy', 'kubectl apply', 'terraform apply', ...MCP_NEVER].map(command => `Bash(${command}:*)`));
// The owner may let one bot merge pull requests (its switch in the Bots tab). In that bot's
// own working turn this one rule leaves the list; every other rule stays for everyone. In
// Full access there is no list, so the switch changes nothing.
export const MERGE_RULE = 'Bash(gh pr merge:*)';
