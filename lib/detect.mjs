import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findBin, execute, timedOut } from './util.mjs';
import { agentEnv } from './process.mjs';
import { loginEnv } from './logins.mjs';
import { ADAPTERS } from './adapters/index.mjs';
import { CAPS, SIGN_IN_COMMAND, VENDORS, VENDOR_NAMES } from './vendors.mjs';
import { conformanceState, conformant, uncheckedText } from './conformance.mjs';

// A version pin does not prove file permissions work. Pins live in each adapter's meta;
// OpenCode stays disabled below. The registry loop below runs one --version per binary.
export const NOT_YET = 'This vendor is not supported yet.';
// A vendor with no tested release is pinned per machine by its one-time check: the
// conformance state names the binary and the release it proved, and only that release runs.
function machinePins(vendor, bin) {
  let state = null; try { state = conformanceState(vendor); } catch { return []; }
  return state && state.bin === bin ? [state.version] : [];
}
function compareVersion(a,b){
 const [av,ap]=a.split('-',2),[bv,bp]=b.split('-',2);const nums=(s)=>s.split('.').map(Number);
 const an=nums(av),bn=nums(bv);for(let i=0;i<3;i++)if(an[i]!==bn[i])return an[i]-bn[i];
 if(ap===bp)return 0;if(ap===undefined)return 1;if(bp===undefined)return -1;
 const aa=ap.split('.'),bb=bp.split('.');for(let i=0;i<Math.max(aa.length,bb.length);i++){if(aa[i]===bb[i])continue;if(aa[i]===undefined)return -1;if(bb[i]===undefined)return 1;const numeric=/^\d+$/.test(aa[i])&&/^\d+$/.test(bb[i]);return numeric?Number(aa[i])-Number(bb[i]):aa[i].localeCompare(bb[i]);}return 0;
}
// Help goes to a file, not a pipe: Claude Code 2.1.321 exits before a piped --help is fully written (8 KB of 22 KB).
// Both streams are read: Antigravity CLI 1.5.8 prints its help to stderr.
function readHelp(bin,args,{cwd,env}){
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'elu-code-help-')),file=path.join(folder,'help.txt'),errors=path.join(folder,'help-errors.txt');
 try{const fd=fs.openSync(file,'w',0o600),efd=fs.openSync(errors,'w',0o600);let r;try{r=spawnSync(bin,args,{cwd,env,stdio:['ignore',fd,efd],timeout:15000});}finally{fs.closeSync(fd);fs.closeSync(efd);}
  return{status:r.error?null:r.status,text:`${fs.readFileSync(file,'utf8')}\n${fs.readFileSync(errors,'utf8')}`};}
 finally{fs.rmSync(folder,{recursive:true,force:true});}
}
// A flag only some runs need, such as Claude Code's --agents for a bot with subagents. It is
// read from the vendor's help and never added to meta.flags, so a release without it still
// runs everything else.
const helpRead=new Map();
export function vendorHasFlag(vendor,bin,cwd,flag,environment=process.env){
 const meta=ADAPTERS[vendor]?.meta;if(!meta||!/^--[a-z][a-z-]*$/.test(flag))return false;
 const has=text=>new RegExp(`(?<![\\w-])${flag}(?![\\w-])`).test(text);
 if(has(helpRead.get(bin)??''))return true;
 let text='';try{text=readHelp(bin,meta.helpArgs,{cwd,env:agentEnv(environment)}).text;}catch{/* No help means no flag. */}
 // Only a help text that lists the flag is kept: an updated program is read again.
 if(has(text))helpRead.set(bin,text);
 return has(text);
}
// A vendor that needs its one-time check and has no record for this program yet: detect()
// did not run it at all.
const awaitsCheck=tool=>tool?.conformant===false&&tool.version===null;
// Why a vendor cannot run, in words the owner can act on.
export function vendorProblem(vendor,tools){
 const name=VENDOR_NAMES[vendor]??vendor,tool=tools.find(row=>row.vendor===vendor);
 if(!tool?.available)return`${name} is not installed or not on your PATH.`;
 // Not run yet, not even for its version: its one-time check comes first.
 if(awaitsCheck(tool))return uncheckedText(vendor,{bin:tool.bin??null});
 if(!tool.supported)return`${name} ${tool.release??''}`.trim()+`: ${tool.reason??'its version could not be read.'}`;
 if(!tool.signedIn)return`${name} is signed out. Run ${SIGN_IN_COMMAND[vendor]??vendor} to sign in, then send again.`;
 if(tool.conformant===false)return uncheckedText(vendor,{bin:tool.bin??null,version:tool.release??null});
 return null;
}
// check: the one-time check is starting (the owner's first message to an unpinned vendor),
// so it reads the release its pass will name. Otherwise a vendor with no tested release
// and no machine pin is never executed, not even for its version.
export function probeVersion(vendor,bin,cwd,environment=process.env,{check=false}={}){
 const meta=ADAPTERS[vendor]?.meta;
 if(!meta)return{version:null,supported:false,versionStatus:null,reason:NOT_YET};
 const tested=meta.supportedVersions.length?meta.supportedVersions:machinePins(vendor,bin);
 if(!tested.length&&!check)return{version:null,supported:false,versionStatus:null,reason:NOT_YET};
 // A version that did not come in time is asked for once more: a busy machine starts a program slowly.
 const env=agentEnv(environment),ask=()=>execute(bin,meta.versionArgs,{cwd,env,allowFailure:true});let result=ask();if(timedOut(result))result=ask();const release=result.stdout.match(/\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?/)?.[0];
 const oldest=[...tested].sort(compareVersion)[0];
 const value={version:result.stdout.trim().slice(0,120),release,supported:false,versionStatus:null};
 // A shell wrapper standing in for an absent program exits 127.
 if(result.status===127)return{...value,reason:'not installed (only a wrapper was found)'};
 if(result.status!==0||!release||(oldest&&compareVersion(release,oldest)<0))return{...value,reason:'This CLI is older than the oldest tested release, or its version could not be read.'};
 if(tested.includes(release))return{...value,supported:true,versionStatus:meta.supportedVersions.length?'tested version':'proven here'};
 const help=readHelp(bin,meta.helpArgs,{cwd,env});
 // A flag the program takes without listing it in its help (Grok Build 1.0.77 dropped --no-auto-update
 // from its help but still takes it) counts when the program runs with it. Only a program that
 // refuses an unknown flag can be asked this way, so only meta.unlistedFlags are.
 const takes=flag=>{const r=execute(bin,[flag,...meta.versionArgs],{cwd,env,allowFailure:true});return r.status===0&&r.stdout.includes(release);};
 const missing=meta.flags.filter(flag=>!help.text.includes(flag)&&!(meta.unlistedFlags?.includes(flag)&&takes(flag)));
 if(help.status!==0||missing.length)return{...value,reason:`This untested version is missing required flags: ${missing.join(', ')}.`};
 return{...value,supported:true,versionStatus:'untested version',reason:'Required flags are present; native enforcement has not been tested on this release.'};
}
export function unsupportedVendors(env = process.env) {
  return [
    { vendor: 'opencode', names: ['opencode'], reason: 'OpenCode has not passed the file-permission tests. Two consecutive releases and terms approval are also required.' },
    { vendor: 'cursor', names: ['agent', 'cursor-agent'], reason: 'Cursor CLI is not supported yet.' },
  ].map(({ vendor, names, reason }) => {
    const bin = names.map((name) => findBin(name, env)).find(Boolean) ?? null;
    // Presence only: even --version or an auth query may start vendor services.
    return { vendor, bin, available: Boolean(bin), signedIn: null, version: null, supported: false, support: 'not supported yet', reason };
  });
}
const supportText = vendor => { const caps = CAPS[vendor]; return caps.lead && caps.reviewer ? 'sessions and reviews' : caps.reviewer ? 'reviews only' : 'sessions'; };
export function detect(cwd, environment = process.env, { only } = {}) {
  const supported = VENDORS.filter(vendor => !only || vendor === only).map((vendor) => {
    const { meta, signedIn } = ADAPTERS[vendor], gated = CAPS[vendor].conformance;
    const bin = findBin(meta.bin, environment);
    if (!bin) return { vendor, available: false, signedIn: false, version: null, supported: false, conformant: gated ? false : null };
    // Signed in means the account in use is (lib/logins.mjs).
    const env = agentEnv(environment, [], loginEnv(vendor));
    const version = probeVersion(vendor,bin,cwd,environment), probed = version.reason !== NOT_YET;
    // Sign-in is never queried for a vendor that was not run for its version, like the unsupported list: null, not signed out.
    // A check that ran out of time (null) is not a sign-out: the vendor counts as signed in,
    // and reports a missing sign-in itself when a turn starts.
    const answer = probed ? signedIn({ bin, cwd, env }) : null, auth = probed && answer === null ? true : answer;
    // A vendor waiting for its one-time check says so, where an unsupported one says it is not supported.
    const waiting = gated && !probed;
    return { vendor, bin, available: true, signedIn: auth, ...version, ...(waiting ? { reason: uncheckedText(vendor, { bin }) } : {}), support: probed || waiting ? supportText(vendor) : 'not supported yet', conformant: gated ? conformant(vendor, { bin, version: version.release ?? null }) : null };
  });
  return [...supported, ...(only ? [] : unsupportedVendors(environment))];
}
