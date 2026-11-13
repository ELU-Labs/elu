// The stand-in for macOS's security command that tests put first on PATH, so no test ever
// reaches a real Keychain. fakeKeychain() in helpers.mjs copies it to a bin folder (adding
// the node shebang) next to keychain.json, which holds its generic passwords as
// { items: [{ account, service }] } (never a value). It knows what Claude Code and ELU run:
//   add-generic-password [-U] -a ACCOUNT -s SERVICE (-X HEX | -w VALUE)
//   find-generic-password -a ACCOUNT [-w] -s SERVICE
//   delete-generic-password -a ACCOUNT -s SERVICE   (one matching item, as the real one)
// A missing item exits 44, as the real one does. keychain.json { locked: true }: a change
// fails as it does on a locked Keychain with no one to unlock it (exit 36). Every call is
// recorded to keychain-calls.jsonl, its value as <value>.
import fs from 'node:fs'; import path from 'node:path';
const dir = path.dirname(process.argv[1]), file = path.join(dir, 'keychain.json'), args = process.argv.slice(2);
let store = { items: [] }; try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* An empty Keychain. */ }
fs.appendFileSync(path.join(dir, 'keychain-calls.jsonl'), `${JSON.stringify({ args: args.map((arg, at) => ['-X', '-w'].includes(args[at - 1]) && args[0] === 'add-generic-password' ? '<value>' : arg) })}\n`);
const flag = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const [command] = args, account = flag('-a'), service = flag('-s');
const matches = item => (account === undefined || item.account === account) && (service === undefined || item.service === service);
const save = () => fs.writeFileSync(file, JSON.stringify(store, null, 1));
const NOT_FOUND = 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.';
const LOCKED = 'security: SecKeychainItemDelete: User interaction is not allowed.';
if (command === 'add-generic-password') {
  if (store.locked) { console.error(LOCKED); process.exit(36); }
  store.items = store.items.filter(item => !(item.account === account && item.service === service));
  store.items.push({ account, service }); save(); process.exit(0);
}
if (command === 'find-generic-password') {
  if (!store.items.some(matches)) { console.error(NOT_FOUND); process.exit(44); }
  if (args.includes('-w')) console.log('{}');
  process.exit(0);
}
if (command === 'delete-generic-password') {
  if (store.locked) { console.error(LOCKED); process.exit(36); }
  const at = store.items.findIndex(matches);
  if (at < 0) { console.error(NOT_FOUND); process.exit(44); }
  store.items.splice(at, 1); save(); console.log('password has been deleted.'); process.exit(0);
}
console.error(`The stand-in security knows add-, find- and delete-generic-password only, not ${command}.`);
process.exit(2);
