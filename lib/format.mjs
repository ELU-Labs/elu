import {quote}from'./util.mjs';
import {VENDOR_NAMES}from'./vendors.mjs';
import {botOfKey}from'./bots.mjs';
import {ADAPTERS}from'./adapters/index.mjs';
import {uncheckedText}from'./conformance.mjs';
const names={...VENDOR_NAMES,opencode:'OpenCode',cursor:'Cursor CLI'};
// The session's own run is the model to a person; the config file still calls it lead.
const shown=name=>name==='lead'?'model':name;
// Google's terms on wrapping agy: shown under every Antigravity sign-in row.
export const ANTIGRAVITY_FAQ="Google's FAQ: wrapping agy in third-party agents is not supported on consumer plans. antigravity.google/docs/faq";
// What a vendor row still needs, one line each: the owner signs in with its own CLI; the
// one-time check of a vendor designed from its docs starts by itself.
export function vendorLines(tool){
 const lines=[],hint=ADAPTERS[tool.vendor]?.meta.signInHint;
 if(tool.signedIn===false&&hint){lines.push(...hint.split('\n'));if(tool.vendor==='agy'&&!hint.includes(ANTIGRAVITY_FAQ))lines.push(ANTIGRAVITY_FAQ);}
 if(tool.conformant===false&&tool.available!==false&&tool.supported!==false)lines.push(uncheckedText(tool.vendor,{version:tool.release??null}));
 return lines;
}
export function formatResult(value,command=''){
 if(value.help)return value.help;
 const lines=[];
 if(value.preview)lines.push('Preview only. Nothing ran and no model credit was used.');
 if(value.goal)lines.push(`Task: ${value.goal}`);
 if(value.initialized)lines.push(value.adopted?'ELU Code adopted the committed configuration.':'ELU Code is ready.');
 if(value.uninstalled)lines.push('ELU Code local state was removed.');
 if(value.message)lines.push(value.message);
 for(const line of Array.isArray(value.lines)?value.lines:[])lines.push(String(line));
 if(value.state)lines.push(`Task ${value.id}: ${value.state}`,value.result?.summary??'');
 if(value.sandboxHelper)lines.push(value.sandboxHelper.working?'Sandbox helper: outside file writes were contained; network access was denied.':`Sandbox helper: ${value.sandboxHelper.message}`);
 const vendors=Array.isArray(value.vendors)?value.vendors:value.vendors?Object.values(value.vendors).filter(Boolean):[];
 for(const tool of vendors){lines.push(`${names[tool.vendor]??tool.vendor}: ${tool.available===false?'not installed':tool.version??tool.support??'unknown'}${tool.versionStatus?` (${tool.versionStatus})`:''}${tool.signedIn===false?' — signed out':''}${tool.reason?` — ${tool.reason}`:''}`);for(const line of vendorLines(tool))lines.push(`  ${line}`);}
 for(const row of value.unsupportedVendors??[])lines.push(`${names[row.vendor]}: ${row.support}`);
 // Only the lead entry runs. An older config may still list review entries; bots review now.
 const lead=value.config?.roles?.lead;if(lead)lines.push(`model: ${names[lead.vendor]??lead.vendor}; ${lead.access}; allowed commands: ${lead.commands.join(', ')||'none'}`);
 for(const check of value.config?.checks??[])lines.push(`Check ${check.name}: ${check.command.join(' ')}`);
 for(const file of value.hooks??value.git?.hooks??[])lines.push(`Git hook file: ${file}`);
 for(const role of value.roles??[]){lines.push(`${shown(role.name)}: ${names[role.vendor]??role.vendor}`);for(const rule of role.rules)lines.push(`  ${rule.rule}: ${rule.enforcement}`);if(role.refusal)lines.push(`  Refused: ${role.refusal}`);}
 for(const task of value.tasks??[]){lines.push(`Task ${task.id}: ${task.state} — ${task.goal}`);for(const run of task.runs??[])lines.push(`  ${botOfKey(run.role)?`@${botOfKey(run.role)}`:shown(run.role)}: ${names[run.vendor]??run.vendor} ${run.version??''} (${run.versionStatus??'version not recorded'})`);}
 if(value.tasks?.length===0)lines.push('No tasks yet.');
 for(const result of value.results??value.evidence?.results??[])lines.push(`${result.name}: ${result.status}`);
 for(const file of value.writes??[])lines.push(`Will write: ${file}`);
 for(const file of value.trackedDeletions??[])lines.push(`Tracked deletion: ${file}`);
 if(value.command)lines.push(value.command);
 if(value.commit)lines.push(`Commit: ${value.commit}`);
 if(value.destination)lines.push(`Push destination: ${value.destination.name} ${value.destination.ref}`);
 if(value.body)lines.push('',value.body);
 if(value.pr)lines.push(`Draft PR: ${value.pr}`);
 if(value.nextCommand)lines.push(`To continue: ${value.nextCommand}`);
 else if(value.needsConfirmation||value.preview||value.files)lines.push(`To continue: elu ${command==='run'?`run ${quote(value.goal??'Describe your task')}`:command} --yes`);
 return lines.filter(line=>line!=='').join('\n')+'\n';
}
