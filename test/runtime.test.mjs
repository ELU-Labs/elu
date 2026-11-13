import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {defaultConfig}from'../lib/config.mjs';import{assertPolicy,policyReport}from'../lib/policy.mjs';import{compile,meta}from'../lib/adapters/claude.mjs';import{detect}from'../lib/detect.mjs';import{project,fakeClis,cli,git}from'./helpers.mjs';
test('Claude command roles run with explicit commands and shared temp denials',(t)=>{
 const {root}=project(t);const role={...defaultConfig().roles.lead,commands:['npm test','npm run build']};
 assert.doesNotThrow(()=>assertPolicy(role));const args=compile({role,cwd:root,session:'12345678-1234-4234-8234-123456789abc'});assert.match(args[args.indexOf('--tools')+1],/Bash/);
 const settings=JSON.parse(args[args.indexOf('--settings')+1]);for(const folder of ['/tmp','/private/tmp','/var/tmp','/private/var/tmp'])assert.ok(settings.sandbox.filesystem.denyWrite.includes(folder));
 assert.match(JSON.stringify(policyReport(role)),/temp folder writable/);
});
test('a missing configured sandbox helper refuses before an agent starts',(t)=>{
 const p=project(t);const f=fakeClis(p.parent);const env={...f.env,ELU_CODE_SANDBOX_HELPER:path.join(p.parent,'missing')};
 assert.equal(cli(p.root,['init','--yes'],env).status,0);git(p.root,['add','.']);git(p.root,['commit','-m','Configure checks']);
 const result=cli(p.root,['run','Normalize coupons','--yes'],env);assert.equal(result.status,1);assert.match(result.json.message,/sandbox helper/i);
 const calls=fs.readFileSync(f.calls,'utf8').trim().split('\n').map(JSON.parse);assert.equal(calls.some(x=>x.args.includes('-p')||x.args[0]==='exec'),false);
});
test('newer CLI releases with required flags are marked untested and older releases refuse',async (t) => {
 const p=project(t);const f=fakeClis(p.parent);const file=path.join(f.dir,'claude');const original=fs.readFileSync(file,'utf8');
 assert.deepEqual(meta.supportedVersions,['2.1.319','2.1.322']);
 fs.writeFileSync(file,original.replaceAll('2.1.319','2.1.322'));let row=(await detect(p.root,{...process.env,...f.env})).find(x=>x.vendor==='claude');assert.equal(row.supported,true);assert.equal(row.versionStatus,'tested version');
 fs.writeFileSync(file,original.replaceAll('2.1.319','2.1.320'));row=(await detect(p.root,{...process.env,...f.env})).find(x=>x.vendor==='claude');assert.equal(row.supported,true);assert.equal(row.versionStatus,'untested version');
 fs.writeFileSync(file,original.replaceAll('2.1.319','2.1.318'));row=(await detect(p.root,{...process.env,...f.env})).find(x=>x.vendor==='claude');assert.equal(row.supported,false);
 fs.writeFileSync(file,original.replaceAll('2.1.319','2.1.320').replaceAll('--restricted','--missing'));row=(await detect(p.root,{...process.env,...f.env})).find(x=>x.vendor==='claude');assert.equal(row.supported,false);
});
