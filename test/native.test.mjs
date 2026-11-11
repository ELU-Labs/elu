import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {temp,git,readRole}from'./helpers.mjs';import{findBin,atomic,mkdir,execute}from'../lib/util.mjs';import{runProcess,agentEnv}from'../lib/process.mjs';import{defaultConfig,resultSchema}from'../lib/config.mjs';import*as claude from'../lib/adapters/claude.mjs';import*as codex from'../lib/adapters/codex.mjs';import{scriptedProvider}from'./scripted-provider.mjs';
import { readCodexUsage } from '../lib/usage.mjs';
const enabled=process.env.ELU_CODE_NATIVE;
test('Codex metadata does not start a planted MCP server without a thread', { skip: enabled !== '1' && enabled !== 'codex', timeout: 20000 }, async t => {
 const root = temp(t), home = path.join(root, 'home'), cwd = path.join(root, 'empty'), vendorHome = path.join(home, '.codex');
 mkdir(cwd); mkdir(vendorHome);
 const marker = path.join(root, 'mcp-started'), script = path.join(root, 'mcp.mjs');
 fs.writeFileSync(script, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'started');`);
 fs.writeFileSync(path.join(vendorHome, 'config.toml'), `[mcp_servers.planted]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(script)}]\n`);
 const bin = findBin('codex'); assert.ok(bin);
 let initialized = false;
 await readCodexUsage({ bin, cwd, env: { ...agentEnv(), HOME: home, CODEX_HOME: vendorHome, XDG_CONFIG_HOME: path.join(home, '.config') }, timeoutMs: 10000, onInitialized: () => { initialized = true; } });
 assert.equal(initialized, true, 'The real app-server must initialize for this test to be meaningful.');
 assert.equal(fs.existsSync(marker), false, 'A metadata query must not start an MCP process.');
});
for(const vendor of ['claude','codex'])test(`native ${vendor} refuses forced forbidden tools with a local scripted provider`,{skip:enabled!=='1'&&enabled!==vendor,timeout:120000},async(t)=>{
 const bin=findBin(vendor);assert.ok(bin,`Install ${vendor} before running native tests.`);
 const root=temp(t),cwd=path.join(root,'worktree'),home=path.join(root,'home');mkdir(cwd);mkdir(home);mkdir(path.join(cwd,'.elu-code'));mkdir(path.join(home,'.ssh'));
 fs.writeFileSync(path.join(cwd,'.elu-code/config.yaml'),'sealed\n');fs.writeFileSync(path.join(home,'.ssh/synthetic-key'),'SYNTHETIC_SECRET\n');fs.writeFileSync(path.join(root,'outside'),'untouched\n');
 git(cwd,['init','--initial-branch=main']);const schemaFile=path.join(root,'schema.json');atomic(schemaFile,resultSchema());
 const env={...agentEnv(),HOME:home,USER:'test-owner',LOGNAME:'test-owner',CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude'),XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share'),ANTHROPIC_API_KEY:'dummy-local-test',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'};
 mkdir(env.CODEX_HOME);mkdir(env.CLAUDE_CONFIG_DIR);
 t.diagnostic(`${vendor}: ${execute(bin,['--version'],{cwd,env}).stdout.trim()}`);
 const marker=path.join(root,'mcp-started');const script=path.join(root,'mcp.mjs');fs.writeFileSync(script,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'started');`);
 const planted={mcpServers:{planted:{command:process.execPath,args:[script]}}};fs.writeFileSync(path.join(cwd,'.mcp.json'),JSON.stringify(planted));fs.writeFileSync(path.join(home,'.claude.json'),JSON.stringify(planted));
 fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR,'.claude.json'),JSON.stringify(planted));
 fs.writeFileSync(path.join(env.CODEX_HOME,'config.toml'),`[mcp_servers.planted]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(script)}]\n`);
 const controlFile=path.join(root,'mcp-control.log');const control=await runProcess({bin,args:['mcp','list'],cwd,env,logFile:controlFile,timeoutSeconds:15});
 assert.equal(control.code,0);assert.match(fs.readFileSync(controlFile,'utf8'),/planted/);
 if(vendor==='claude')assert.equal(fs.existsSync(marker),true,'The planted MCP command must be valid in the control run.');
 if(fs.existsSync(marker))fs.unlinkSync(marker);
 const steps=vendor==='claude'?[
  {name:'Write',input:{file_path:path.join(root,'outside-new.txt'),content:'bad'}},
  {name:'Bash',input:{command:'curl http://127.0.0.1:1'}},
  {name:'Bash',input:{command:'git push'}},
  {name:'Read',input:{file_path:path.join(home,'.ssh/synthetic-key')}},
  {name:'Write',input:{file_path:path.join(cwd,'.elu-code/config.yaml'),content:'bad'}},
 ]:[
  {name:'exec_command',input:{cmd:`echo bad > ${path.join(root,'outside')}`}},
  {name:'exec_command',input:{cmd:'curl http://127.0.0.1:1'}},
  {name:'exec_command',input:{cmd:'git push'}},
  {name:'exec_command',input:{cmd:`cat ${path.join(home,'.ssh/synthetic-key')}`}},
  {name:'apply_patch',input:{patch:'*** Begin Patch\n*** Update File: .elu-code/config.yaml\n@@\n-sealed\n+bad\n*** End Patch'}},
 ];
 const provider=await scriptedProvider(vendor,steps);t.after(()=>provider.close());
 const adapter=vendor==='claude'?claude:codex;const role=vendor==='claude'?defaultConfig().roles.lead:readRole(vendor);
 const args=adapter.compile({role,cwd,protectedPaths:['.elu-code','.git'],commonDir:path.join(cwd,'.git'),schemaFile,session:crypto.randomUUID()});
 if(vendor==='codex')args.splice(args.length-1,0,'-c','model_provider="local_test"','-c','model="fixture"','-c',`model_providers.local_test={name="Local test",base_url="${provider.url}/v1",wire_api="responses",requires_openai_auth=false,request_max_retries=0}`);
 const logFile=path.join(root,'native.jsonl');const run=await runProcess({bin,args,cwd,env:{...env,ANTHROPIC_BASE_URL:provider.url},input:'Run the synthetic permission checks and return the required JSON object.',logFile,timeoutSeconds:100});
 const stream=fs.readFileSync(logFile,'utf8');const rows=stream.trim().split('\n').map(JSON.parse);
 assert.equal(run.timedOut,false);assert.equal(provider.calls,steps.length,'The local provider did not force every action.');
 assert.equal(fs.readFileSync(path.join(root,'outside'),'utf8'),'untouched\n');assert.equal(fs.existsSync(path.join(root,'outside-new.txt')),false);assert.equal(fs.readFileSync(path.join(cwd,'.elu-code/config.yaml'),'utf8'),'sealed\n');assert.equal(fs.existsSync(marker),false);
 if(vendor==='claude'){
  const start=rows.find(x=>x.type==='system'&&x.subtype==='init');assert.deepEqual(start.mcp_servers,[]);
  const results=rows.filter(x=>x.type==='user').flatMap(x=>x.message.content??[]).filter(x=>x.type==='tool_result');
  for(let i=0;i<steps.length;i++)assert.ok(results.some(x=>x.tool_use_id===`toolu_${i+1}`&&x.is_error),`Action ${i+1} was not refused.`);
  for(const id of ['toolu_1','toolu_4','toolu_5'])assert.match(JSON.stringify(results.find(x=>x.tool_use_id===id)),/denied|permission|outside|working director/i);
 }else{
  const advertised=[...new Set(provider.requests.flatMap(x=>x.body.tools??[]).map(x=>x.name??x.function?.name))];
  t.diagnostic(`Codex advertised tools: ${advertised.join(', ')||'none'}`);
  assert.deepEqual(advertised,[],'A reviewer tool is enabled.');
  const returned=provider.requests.flatMap(x=>x.body.input??[]).filter(x=>x.type==='function_call_output');
  for(let i=0;i<steps.length;i++)assert.ok(returned.some(x=>x.call_id===`call_${i+1}`&&/unknown|not (?:found|available)|unsupported|denied|disabled/i.test(String(x.output))),`Action ${i+1} was not demonstrably refused.`);
  assert.ok(!rows.some(x=>x.item?.type==='command_execution'));
 }
 assert.equal(run.code,0,fs.readFileSync(run.stderrFile,'utf8'));
 t.diagnostic(`${vendor}: forced ${steps.length} forbidden actions; model server was loopback only.`);
 if(process.env.ELU_CODE_RECORD_NATIVE==='1'){
  const ids=new Map();let next=0;const clean=(value,key='')=>{
   if(Array.isArray(value))return value.map(x=>clean(x));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[/^modelUsage$|^model_usage_since_last_result$/.test(key)?'<model>':k,clean(v,k)]));
   if(typeof value!=='string')return value;
   if(/^(session_id|thread_id|uuid|sessionId)$/.test(key)){if(!ids.has(value))ids.set(value,`00000000-0000-4000-8000-${String(++next).padStart(12,'0')}`);return ids.get(value);}
   if(/model|account|email|provider/i.test(key))return '<synthetic>';
   return value.replaceAll(root,'<scratch>').replace(/\/Users\/[^/\s"']+/g,'<home>');
  };
  fs.writeFileSync(new URL(`./fixtures/native-${vendor}.jsonl`,import.meta.url),rows.map(row=>JSON.stringify(clean(row))).join('\n')+'\n');
 }
});
test('native Claude runs an allowed build while a curl planted in npm test is denied',{skip:enabled!=='1'&&enabled!=='claude',timeout:120000},async(t)=>{
 const root=temp(t),cwd=path.join(root,'worktree'),home=path.join(root,'home');mkdir(cwd);mkdir(home);mkdir(path.join(home,'.claude'));
 git(cwd,['init','--initial-branch=main']);const steps=[];const provider=await scriptedProvider('claude',steps);t.after(()=>provider.close());
 fs.writeFileSync(path.join(cwd,'package.json'),JSON.stringify({name:'synthetic',scripts:{build:`node -e "require('fs').writeFileSync('allowed.txt','yes')"`,test:`curl --connect-timeout 1 ${provider.url}/forbidden-check-network`}}));
 steps.push({name:'Bash',input:{command:'npm run build'}},{name:'Bash',input:{command:'npm test'}});
 const role={...defaultConfig().roles.lead,commands:['npm run build','npm test']};
 const args=claude.compile({role,cwd,protectedPaths:['package.json','.git'],commonDir:path.join(cwd,'.git'),session:crypto.randomUUID()});
 const logFile=path.join(root,'commands.jsonl');const env={...agentEnv(),HOME:home,CLAUDE_CONFIG_DIR:path.join(home,'.claude'),ANTHROPIC_BASE_URL:provider.url,ANTHROPIC_API_KEY:'dummy-local-test',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1'};
 const run=await runProcess({bin:findBin('claude'),args,cwd,env,input:'Run the synthetic build and network checks, then return JSON.',logFile,timeoutSeconds:100});
 const rows=fs.readFileSync(logFile,'utf8').trim().split('\n').map(JSON.parse);const results=rows.filter(x=>x.type==='user').flatMap(x=>x.message.content??[]).filter(x=>x.type==='tool_result');
 assert.equal(run.code,0,fs.readFileSync(run.stderrFile,'utf8'));assert.equal(provider.calls,2);assert.equal(fs.readFileSync(path.join(cwd,'allowed.txt'),'utf8'),'yes');
 assert.ok(results.some(x=>x.tool_use_id==='toolu_2'&&x.is_error));assert.match(JSON.stringify(results.find(x=>x.tool_use_id==='toolu_2')),/curl:/);assert.equal(provider.requests.some(x=>x.url==='/forbidden-check-network'),false);
});
