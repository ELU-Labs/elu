// The fake Claude Code CLI tests run instead of the real one. fakeClis() in helpers.mjs
// copies it to a bin folder (adding the node shebang) next to fake.json, which holds the
// test's mode and the files it records to. Without fake.json it behaves as a signed-in
// 2.1.319 that records nothing.
import fs from 'node:fs'; import path from 'node:path';
const vendor=path.basename(process.argv[1]); const args=process.argv.slice(2);
let cfg={}; try{cfg=JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]),'fake.json'),'utf8'));}catch{}
const mode=cfg.mode??'normal';
if(cfg.calls)fs.appendFileSync(cfg.calls, JSON.stringify({vendor,args,...(cfg.note?{tmp:process.env.CLAUDE_CODE_TMPDIR??null}:{})})+'\n');
if(args.includes('--version')){console.log('2.1.319');process.exit(0);}
// The --model entry of the real --help, which is where the aliases a bot's Model step offers come from.
const MODEL_HELP="  --model <model>                       Model for the current session. Provide\n                                        an alias for the latest model (e.g.\n                                        'fable', 'opus', or 'sonnet') or a\n                                        model's full name.\n  -n, --name <name>                     Set a display name for this session";
if(args.includes('--help')){console.log('--print --add-dir --restricted --safe-mode --setting-sources --settings --strict-mcp-config --mcp-config --no-chrome --permission-mode --permission-prompts --tools --allowedTools --disallowedTools --output-format --verbose --json-schema --max-budget-usd --session-id --ignore-user-config --ignore-rules --json --sandbox --cd --output-schema --config');console.log(MODEL_HELP);process.exit(0);}
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:mode!=='signed-out'}));process.exit(0);}
let input=''; for await (const chunk of process.stdin) input+=chunk;
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
console.log(JSON.stringify({type:'system',subtype:'init',session_id:session,model:'claude-fable-5-1',permissionMode:cfg.permissionMode??permissionMode,mcp_servers:mcp}));
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
if(Array.isArray(cfg.commands)&&promptTool){
 const {spawnSync}=await import('node:child_process');const named=process.env.CLAUDE_ENV_FILE;const ahead=named&&fs.existsSync(named)?fs.readFileSync(named,'utf8').trim():'';
 cfg.commands.forEach((command,i)=>{const id=`toolu_fake_${i+1}`;const r=spawnSync('/bin/sh',['-c',`PATH="/usr/bin:/bin:$PATH"\n${ahead}\neval "$1"`,'sh',command],{env:process.env,encoding:'utf8'});const denied=noted(i+1);if(denied&&r.status===0)r.status=1;const out=`${r.stdout}${r.stderr}${denied}`;
  console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id,name:'Bash',input:{command,description:'Run it'}}]}}));
  console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:r.status===0?out:`Exit code ${r.status}\n${out}`,...(r.status===0?{}:{is_error:true})}]}}));});
}
if(mode==='relay'&&promptTool&&permissionMode!=='bypassPermissions'){
 const {spawn}=await import('node:child_process');const readline=await import('node:readline');
 const server=servers[promptTool.split('__')[1]];if(!server)throw new Error('The approval relay is not in --mcp-config.');
 const child=spawn(server.command,server.args,{env:{...process.env,...(server.env??{})},stdio:['pipe','pipe','inherit']});
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
console.log(JSON.stringify({type:'result',is_error:false,session_id:session,total_cost_usd:0,...(denials.length?{permission_denials:denials}:{}),structured_output:mode==='invalid'||badReply?{outcome:'nope'}:result}));
