// The fake Claude Code CLI tests run instead of the real one. fakeClis() in helpers.mjs
// copies it to a bin folder (adding the node shebang) next to fake.json, which holds the
// test's mode and the files it records to. Without fake.json it behaves as a signed-in
// 2.1.319 that records nothing.
import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline';
const vendor=path.basename(process.argv[1]); const args=process.argv.slice(2);
let cfg={}; try{cfg=JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]),'fake.json'),'utf8'));}catch{}
// byMode (fake.json): what a turn started in that --permission-mode does (default, auto,
// bypassPermissions), over the rest of fake.json, so one session's turns can differ by mode.
{const at=args.indexOf('--permission-mode');const started=at>=0?args[at+1]:'default';if(cfg.byMode?.[started])cfg={...cfg,...cfg.byMode[started]};}
const mode=cfg.mode??'normal';
if(cfg.calls)fs.appendFileSync(cfg.calls, JSON.stringify({vendor,args,...(cfg.note?{tmp:process.env.CLAUDE_CODE_TMPDIR??null}:{})})+'\n');
if(args.includes('--version')){console.log('2.1.319');process.exit(0);}
// The --model entry of the real --help, which is where the aliases a bot's Model step offers come from.
const MODEL_HELP="  --model <model>                       Model for the current session. Provide\n                                        an alias for the latest model (e.g.\n                                        'fable', 'opus', or 'sonnet') or a\n                                        model's full name.\n  -n, --name <name>                     Set a display name for this session";
if(args.includes('--help')){console.log('--print --add-dir --restricted --safe-mode --setting-sources --settings --strict-mcp-config --mcp-config --no-chrome --permission-mode --permission-prompts --tools --allowedTools --disallowedTools --output-format --verbose --json-schema --max-budget-usd --session-id --input-format --ignore-user-config --ignore-rules --json --sandbox --cd --output-schema --config');console.log(MODEL_HELP);process.exit(0);}
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:mode!=='signed-out'}));process.exit(0);}
// --input-format stream-json: the prompt is the first line, a user message, and the input stays
// open for the answers to this run's control requests until the runner closes it.
const streaming=args.includes('--input-format')&&args[args.indexOf('--input-format')+1]==='stream-json';
const lines=[],waiters=[];let inputEnded=false;
const nextLine=()=>lines.length?Promise.resolve(lines.shift()):inputEnded?Promise.resolve(null):new Promise(resolve=>waiters.push(resolve));
let input='';
if(streaming){const reader=readline.createInterface({input:process.stdin});reader.on('line',line=>{if(waiters.length)waiters.shift()(line);else lines.push(line);});reader.on('close',()=>{inputEnded=true;while(waiters.length)waiters.shift()(null);});const first=JSON.parse(await nextLine()??'{}');if(first.type!=='user'||typeof first.message?.content!=='string')throw new Error('The first stream-json line is not a user message.');input=first.message.content;}
else for await (const chunk of process.stdin) input+=chunk;
if(cfg.inputs)fs.appendFileSync(cfg.inputs, JSON.stringify({vendor,args,input})+'\n');
const result={outcome:'done',summary:'Updated coupon normalization.',question:null,choices:[],comments:[],responses:[]};
const schemaArg=args.indexOf('--json-schema');
const schema=schemaArg>=0?JSON.parse(args[schemaArg+1]):null;
const conversation=Boolean(schema?.properties?.intent);if(conversation&&schema.properties.repository){const named=cfg.repository;result.repository=named&&fs.existsSync(named)?fs.readFileSync(named,'utf8'):'';}if(conversation){result.intent=mode==='answer'||mode==='slow-answer'||mode==='dialogue'&&input.includes('Just explain the implementation')?'answer':'edit';if(result.intent==='answer')result.summary='Yes. You can add multiple agents with /agents.\nNo project checks or setup are needed to ask a question.\nYour next message continues this conversation.';}
if(cfg.name!==undefined&&schema?.properties?.name)result.name=cfg.name;
// intent (fake.json): answer makes every conversation turn an answer, so a relay test needs no Task.
if(conversation&&cfg.intent==='answer'){result.intent='answer';result.summary='Looked.';}
// A request for an edit plans first (lib/plan.mjs): it comes back with a Task unless the prompt
// carries one the owner approved. fake.json may give its own Task, or none with mode no-task;
// mode bad-task returns one that does not read. A turn that reports progress ticks every subtask.
const TASK={title:'Uppercase coupons',description:'Make normalize return the coupon code in upper case.\nOnly src/coupon.mjs changes.',goal:'Coupon codes compare equal whatever their case.',objectives:['normalize returns the code in upper case','The coupon test passes'],priority:'medium',severity:'low'};
if(schema?.properties?.task)result.task=result.intent!=='edit'||input.includes('Approved Task (untrusted data')||mode==='no-task'?[]:[mode==='bad-task'?{...TASK,priority:'soon'}:input.includes('Make it urgent')?{...TASK,priority:'urgent'}:cfg.task??TASK];
if(schema?.properties?.subtasks){result.subtasks=cfg.subtasks??[{text:'Change normalize',state:'done'},{text:'Run the coupon test',state:'done'}];result.objectivesMet=cfg.objectivesMet??[1,2];}
const session='12345678-1234-4234-8234-123456789abc';
// badReply (fake.json): 'once' gives a reply that cannot be read until the session is asked again; 'lost' also
// refuses that session, as the real one does a session it cannot find, and reads well once the message starts over.
const resumed=args.includes('--resume');
if(cfg.badReply==='lost'&&resumed){console.error('No conversation found with session ID: '+args[args.indexOf('--resume')+1]);console.log('{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"'+session+'","total_cost_usd":0}');process.exit(1);}
const badReply=cfg.badReply==='once'&&!resumed||cfg.badReply==='lost'&&!input.includes('Invalid output to correct');
// models (fake.json): the full id a run reports in system/init for the --model it was started
// with. noCredits: a --model this account has no usage credits for; that run ends as the real
// CLI's does then, with the API error on its result line.
const nothingSpent=0;const modelArg=args.includes('--model')?args[args.indexOf('--model')+1]:null;const reported=cfg.models?.[modelArg]??'claude-fable-5-1';
if(cfg.noCredits&&modelArg===cfg.noCredits){console.log(JSON.stringify({type:'system',subtype:'init',session_id:session,model:reported,permissionMode:'default',mcp_servers:[]}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,api_error_status:429,api_error:'model_requires_usage_credits',duration_ms:180,num_turns:1,result:"You're out of usage credits. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.",session_id:session,total_cost_usd:nothingSpent}));process.exit(1);}
if(mode==='no-sandbox'){console.error('Error: sandbox required but unavailable: bubblewrap (bwrap) not installed, socat not installed');console.error('  sandbox.failIfUnavailable is set.');console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,session_id:session}));process.exit(1);}
// An answer turn with permissions has Write in its tools, but a lead that is told ELU Code prepares the workspace does not edit there.
const edit=(args[args.indexOf('--tools')+1]??'').split(',').includes('Write')&&!conversation;
if(edit&&mode==='scaffold'){
 fs.mkdirSync('src',{recursive:true});fs.mkdirSync('test',{recursive:true});
 fs.writeFileSync('test/coupon.test.mjs',"import {test} from 'node:test';import assert from 'node:assert/strict';import {normalize} from '../src/coupon.mjs';test('normalizes coupons',()=>assert.equal(normalize('save'),'SAVE'));\n");
}
if(mode==='slow'){console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Working on the requested change.'}]}}));await new Promise(resolve=>setTimeout(resolve,30000));}
if(mode==='slow-answer')await new Promise(resolve=>setTimeout(resolve,250));
if(edit&&mode==='protected')fs.appendFileSync('package.json',' ');
else if(edit&&mode!=='no-change')fs.writeFileSync('src/coupon.mjs','export const normalize = (value) => value.toUpperCase();\n');
if(edit&&input.includes('Trim spaces'))fs.writeFileSync('src/coupon.mjs','export const normalize = (value) => value.trim().toUpperCase();\n');
if(mode==='question'&&!args.includes('--resume')&&!input.includes('Uppercase')){result.outcome='needs_input';result.question='Which format?';result.choices=['Uppercase','Lowercase'];}
if((mode==='review-fix'||mode==='review-block')&&input.includes('Address the review')){result.responses=[{id:'R1',action:mode==='review-fix'?'fixed':'disputed',reason:mode==='review-fix'?'Handled the edge case.':'The finding still needs owner input.'}];}
const mcpArg=args[args.indexOf('--mcp-config')+1];const servers=!args.includes('--safe-mode')&&mcpArg&&!mcpArg.startsWith('{')&&fs.existsSync(mcpArg)?JSON.parse(fs.readFileSync(mcpArg,'utf8')).mcpServers:{};const mcp=Object.keys(servers).map(name=>({name,status:'connected'}));
const permissionMode=args.includes('--permission-mode')?args[args.indexOf('--permission-mode')+1]:'default';
// permissionMode (fake.json): the mode this run says it really got, when that is not the one it was started with.
console.log(JSON.stringify({type:'system',subtype:'init',session_id:session,model:reported,permissionMode:cfg.permissionMode??permissionMode,mcp_servers:mcp}));
console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{unifiedWindows:{five_hour:{utilization:0.36,resetsAt:Math.floor(Date.now()/1000)+10800},seven_day:{utilization:0.71,resetsAt:Math.floor(Date.now()/1000)+604800}}}}));
console.error('A harmless diagnostic on stderr.');
// relay: like the real CLI, a tool call the permission mode would prompt for goes to the
// --permission-prompt-tool server from --mcp-config: initialize, tools/list, then approve for a
// touch outside the workspace. Allowed, the touch happens; denied, the result reports the denial.
// bypassPermissions never asks. The server is started exactly as the config says, env included.
// asks (fake.json): the calls to ask about instead, each { tool_name, input }, in order; an allowed
// one is recorded in ran.jsonl beside the fake, and each decision gets its own calls row.
const denials=[];
const promptTool=args.includes('--permission-prompt-tool')?args[args.indexOf('--permission-prompt-tool')+1]:null;
// commands (fake.json): what the model runs this turn, in a session with permissions. Each starts
// the way the real CLI starts one: a shell whose PATH was built again with the system folders
// first (its snapshot of the owner's shell setup), then the script named in CLAUDE_ENV_FILE,
// read once, then the command. A command that fails is shown with its exit code.
// note (fake.json): the real CLI writes a note of its working folder after each command, in
// <CLAUDE_CODE_TMPDIR, or /tmp>/claude-<uid>, and goes back to /tmp when that path is longer
// than 44 bytes. Its sandbox, as ELU Code sets it for every mode but Full access, denies writes
// under /tmp: there the command ends 1 whatever it did.
const uid=process.getuid?.()??0;const named=process.env.CLAUDE_CODE_TMPDIR;const own=named&&Buffer.byteLength(path.join(named,`claude-${uid}`))<=44?path.join(named,`claude-${uid}`):null;
const noted=i=>{if(!cfg.note||permissionMode==='bypassPermissions')return '';if(!own)return `sh: operation not permitted: /tmp/claude-${uid}/cwd-${i}\n`;fs.mkdirSync(own,{recursive:true,mode:0o700});fs.writeFileSync(path.join(own,`cwd-${i}`),process.cwd());return '';};
// fence (fake.json): where bwrap is installed, a command of a turn whose settings enable the
// sandbox runs fenced as Claude Code's sandbox fences it on Linux: the disk read-only but for
// the working folder and the run's temporary folder, less what denyWrite names; each file
// denyRead names or matches by name hidden under an empty device, a folder under an empty
// one; no network.
const settingsAt=args.indexOf('--settings');const sandbox=settingsAt>=0?JSON.parse(args[settingsAt+1]).sandbox??null:null;
function fenceArgs(fenced){
 const home=process.env.HOME??'',cwd=process.cwd(),out=['--die-with-parent','--unshare-net','--ro-bind','/','/','--dev','/dev','--proc','/proc'];
 const abs=p=>p.startsWith('~/')?path.join(home,p.slice(2)):path.isAbsolute(p)?p:path.join(cwd,p),under=(p,dir)=>p===dir||p.startsWith(`${dir}/`);
 const denied=(fenced.denyWrite??[]).map(abs);
 for(const dir of [cwd,process.env.CLAUDE_CODE_TMPDIR].filter(Boolean))if(fs.existsSync(dir)&&!denied.some(d=>under(dir,d)))out.push('--bind',dir,dir);
 for(const p of denied)if(fs.existsSync(p))out.push('--ro-bind',p,p);
 const hide=p=>{try{out.push(...(fs.lstatSync(p).isDirectory()?['--tmpfs',p]:['--ro-bind','/dev/null',p]));}catch{}};
 const walk=(dir,test,depth=0)=>{if(depth>12)return;let names=[];try{names=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}for(const entry of names){const p=path.join(dir,entry.name);if(entry.isDirectory()){if(entry.name!=='.git')walk(p,test,depth+1);}else if(test(entry.name))hide(p);}};
 for(const entry of fenced.denyRead??[]){
  if(!entry.includes('*')){hide(abs(entry));continue;}
  const at=entry.indexOf('**/'),base=at>0?abs(entry.slice(0,at-1)):cwd,name=entry.slice(at+3),re=new RegExp(`^${name.replace(/[.+^$(){}|[\]\\]/g,'\\$&').replace(/\*/g,'.*')}$`);
  walk(base,file=>re.test(file));
 }
 return [...out,'--chdir',cwd];
}
if(Array.isArray(cfg.commands)&&promptTool){
 const {spawnSync}=await import('node:child_process');const named=process.env.CLAUDE_ENV_FILE;const ahead=named&&fs.existsSync(named)?fs.readFileSync(named,'utf8').trim():'';
 const fenced=cfg.fence&&sandbox?.enabled===true&&spawnSync('bwrap',['--version']).status===0;
 cfg.commands.forEach((command,i)=>{const id=`toolu_fake_${i+1}`;const script=['-c',`PATH="/usr/bin:/bin:$PATH"\n${ahead}\neval "$1"`,'sh',command];const r=fenced?spawnSync('bwrap',[...fenceArgs(sandbox.filesystem??{}),'/bin/sh',...script],{env:process.env,encoding:'utf8'}):spawnSync('/bin/sh',script,{env:process.env,encoding:'utf8'});const denied=noted(i+1);if(denied&&r.status===0)r.status=1;const out=`${r.stdout}${r.stderr}${denied}`;
  console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id,name:'Bash',input:{command,description:'Run it'}}]}}));
  console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:r.status===0?out:`Exit code ${r.status}\n${out}`,...(r.status===0?{}:{is_error:true})}]}}));});
}
// network (fake.json): hosts a sandboxed command of this turn connects to, in order. As in the real
// CLI a host is let through when the settings list it in sandbox.network.allowedDomains or it was
// allowed earlier in this run. Otherwise, in the default mode, Claude asks on its output with a
// can_use_tool control request for SandboxNetworkAccess and reads the answer on its input; with
// the prompt given as text that input is closed, so the host is denied without asking and the
// command reports "user denied". Each connection is recorded in network.jsonl beside the fake.
if(Array.isArray(cfg.network)){
 const settingsArg=args.indexOf('--settings');const allowedDomains=settingsArg>=0?JSON.parse(args[settingsArg+1]).sandbox?.network?.allowedDomains??[]:[];
 const allowedHere=new Set();let asked=0;
 for(const [i,host] of cfg.network.entries()){
  let allowed=permissionMode==='bypassPermissions'||allowedDomains.includes(host)||allowedHere.has(host),ask=false;
  if(!allowed&&streaming&&!inputEnded&&permissionMode==='default'){
   ask=true;const id=`req_fake_${++asked}`;
   console.log(JSON.stringify({type:'control_request',request_id:id,request:{subtype:'can_use_tool',tool_name:'SandboxNetworkAccess',input:{host},permission_suggestions:[{type:'addRules',rules:[{toolName:'SandboxNetworkAccess',ruleContent:`domain:${host}`}],behavior:'allow',destination:'localSettings'}],description:`Allow network connection to ${host}?`,tool_use_id:`toolu_fake_net_${i+1}`}}));
   for(;;){const line=await nextLine();if(line===null)break;let row;try{row=JSON.parse(line);}catch{continue;}if(row.type==='control_response'&&row.response?.request_id===id){allowed=row.response.subtype==='success'&&row.response.response?.behavior==='allow';break;}}
   if(allowed)allowedHere.add(host);
  }
  const id=`toolu_fake_net_${i+1}`,command=`curl -sS https://${host}/`;
  console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id,name:'Bash',input:{command,description:'Fetch it'}}]}}));
  console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:allowed?'connected':`Exit code 56\ncurl: (56) CONNECT tunnel failed, response 403\n<sandbox_violations>\ndeny network-outbound ${host}:443 (user denied)\n</sandbox_violations>`,...(allowed?{}:{is_error:true})}]}}));
  fs.appendFileSync(path.join(path.dirname(process.argv[1]),'network.jsonl'),JSON.stringify({host,allowed,asked:ask,streaming})+'\n');
 }
}
if(mode==='relay'&&promptTool&&permissionMode!=='bypassPermissions'){
 const {spawn}=await import('node:child_process');const readline=await import('node:readline');
 const server=servers[promptTool.split('__')[1]];if(!server)throw new Error('The approval relay is not in --mcp-config.');
 // wait (fake.json): how many seconds the relay waits for the owner, in place of its twenty minutes.
 const child=spawn(server.command,[...server.args,...(cfg.wait?['--wait',String(cfg.wait)]:[])],{env:{...process.env,...(server.env??{})},stdio:['pipe','pipe','inherit']});
 const waiting=new Map();let next=1;const progress=[];
 readline.createInterface({input:child.stdout}).on('line',line=>{let row;try{row=JSON.parse(line);}catch{return;}if(row.method==='notifications/progress')progress.push(row.params);else if(waiting.has(row.id)){waiting.get(row.id)(row);waiting.delete(row.id);}});
 const call=(method,params)=>new Promise(resolve=>{const id=next++;waiting.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 await call('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fake-claude',version:'0'}});
 child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 const tools=(await call('tools/list',{})).result.tools.map(tool=>tool.name);
 const target=path.join(path.dirname(process.argv[1]),'touched');
 const asks=Array.isArray(cfg.asks)?cfg.asks.map((ask,i)=>({...ask,id:`toolu_fake_ask_${i+1}`})):[{tool_name:'Bash',input:{command:`touch ${target}`},id:'toolu_fake_touch',touch:true}];
 for(const ask of asks){
  const reply=await call('tools/call',{name:promptTool.split('__')[2],arguments:{tool_name:ask.tool_name,input:ask.input,tool_use_id:ask.id},_meta:{progressToken:1}});
  const decision=JSON.parse(reply.result.content[0].text);
  if(decision.behavior==='allow'){if(ask.touch)fs.writeFileSync(target,'');else fs.appendFileSync(path.join(path.dirname(process.argv[1]),'ran.jsonl'),JSON.stringify(ask.input)+'\n');}
  else denials.push({tool_name:ask.tool_name,tool_use_id:ask.id,tool_input:ask.input});
  if(cfg.calls)fs.appendFileSync(cfg.calls,JSON.stringify({vendor,args:[],approval:{tools,decision,progress:progress.length}})+'\n');
 }
 child.stdin.end();
}
// blocked (fake.json): the question this turn ends on, as a model does when something it needed was refused.
if(cfg.blocked){result.outcome='needs_input';result.question=cfg.blocked;result.choices=[];}
console.log(JSON.stringify({type:'result',is_error:false,session_id:session,total_cost_usd:0,...(denials.length?{permission_denials:denials}:{}),structured_output:mode==='invalid'||badReply?{outcome:'nope'}:result}));
// A stream-json run ends when its input does; one the runner never closes fails the test.
if(streaming&&!inputEnded){const timer=setTimeout(()=>{console.error('The input was never closed after the result.');process.exit(3);},10000);while(await nextLine()!==null);clearTimeout(timer);}
