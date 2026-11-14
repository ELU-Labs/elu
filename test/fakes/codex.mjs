// The fake Codex CLI tests run instead of the real one: lead, reviewer, usage app-server and
// sandbox helper. fakeClis() in helpers.mjs copies it to a bin folder (adding the node
// shebang) next to fake.json, which holds the test's mode and the files it records to.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import {spawnSync} from 'node:child_process';
const vendor=path.basename(process.argv[1]); const args=process.argv.slice(2);
let cfg={}; try{cfg=JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]),'fake.json'),'utf8'));}catch{}
// byInput (fake.json): rules [{includes, set}]. An exec launch whose prompt includes the text takes
// those keys in place of the test's, the first rule that matches: a run beside a turn answers at
// once while the turn itself never ends.
let early=null;if(Array.isArray(cfg.byInput)&&args[0]==='exec'){early='';for await(const chunk of process.stdin)early+=chunk;const rule=cfg.byInput.find(rule=>early.includes(rule.includes));if(rule)cfg={...cfg,...rule.set};}
const mode=cfg.mode??'normal';
// accounts (fake.json): the account a run is on is the one auth.json names in CODEX_HOME (or
// ~/.codex), as the real CLI keeps it; a call records it. accounts.loginAs: the account `codex
// login` signs in there. accounts.limited: accounts whose turns fail at their usage limit.
// accounts.lapsed: accounts whose sign-in lapsed (true: every account). `login status` still
// says signed in, and a turn fails in the words codex-cli 0.167.0 keeps for it.
// accounts.codexUsage: per account, the percent of the windows the app-server reports.
const codexHome=process.env.CODEX_HOME??path.join(process.env.HOME??'','.codex');
// codexTurn (fake.json): { requests: [usage], model }. Each turn makes those requests and keeps
// them as codex-cli 0.167.0 keeps a thread: a rollout file under CODEX_HOME,
// sessions/YYYY/MM/DD/rollout-<local time>-<thread>.jsonl under the day the thread began, with
// a turn_context line (the turn's model), a token_usage_record line for each request and an
// event_msg token_count line with the thread's total after it. turn.completed (exec) and
// thread/tokenUsage/updated (app-server) report that total: what the thread has used so far,
// begun from its rollout when a run resumes it, as the real one reports it. A new thread's id is
// a UUIDv7. model: what a run started without --model runs on (the real one names it in the
// rollout only). Without codexTurn a turn reports no tokens and the thread is a fixed one.
// printed: bytes an exec turn prints before its answer (reasoning items of 64KB), for a log
// longer than ELU reads whole.
const turnUse=cfg.codexTurn??null,pad2=n=>String(n).padStart(2,'0');
const newThread=()=>{const ms=Date.now().toString(16).padStart(12,'0'),r=crypto.randomBytes(10).toString('hex');return `${ms.slice(0,8)}-${ms.slice(8)}-7${r.slice(0,3)}-${'89ab'[r.charCodeAt(3)%4]}${r.slice(4,7)}-${r.slice(7,19)}`;};
const rolloutOf=thread=>{const walk=dir=>{let entries=[];try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return null;}for(const entry of entries){const file=path.join(dir,entry.name);const found=entry.isDirectory()?walk(file):entry.name.endsWith(`-${thread}.jsonl`)?file:null;if(found)return found;}return null;};return walk(path.join(codexHome,'sessions'));};
const rolloutNew=thread=>{const now=new Date(),day=path.join(codexHome,'sessions',String(now.getFullYear()),pad2(now.getMonth()+1),pad2(now.getDate()));fs.mkdirSync(day,{recursive:true});const file=path.join(day,`rollout-${now.getFullYear()}-${pad2(now.getMonth()+1)}-${pad2(now.getDate())}T${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}-${thread}.jsonl`);fs.appendFileSync(file,JSON.stringify({timestamp:now.toISOString(),type:'session_meta',payload:{id:thread,session_id:thread,cwd:process.cwd(),cli_version:'0.167.0',model_provider:'openai'}})+'\n');return file;};
const USAGE=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
const usageSum=(a,b)=>Object.fromEntries(USAGE.map(key=>[key,(a?.[key]??0)+(b?.[key]??0)]));
// One turn of a thread on model: its requests written to the thread's rollout. Returns the thread's total after it.
function codexTurnRun(thread,model){
 const file=rolloutOf(thread)??rolloutNew(thread),turn=newThread(),put=(type,payload)=>fs.appendFileSync(file,JSON.stringify({timestamp:new Date().toISOString(),type,payload})+'\n');
 let total=null;for(const line of fs.readFileSync(file,'utf8').split('\n')){try{const row=JSON.parse(line);if(row.type==='event_msg'&&row.payload?.type==='token_count')total=row.payload.info?.total_token_usage??total;}catch{}}
 put('turn_context',{turn_id:turn,cwd:process.cwd(),model});
 let own=null;
 (turnUse.requests??[]).forEach((request,n)=>{const usage=usageSum(request,{total_tokens:(request.input_tokens??0)+(request.output_tokens??0)});own=usageSum(own,usage);total=usageSum(total,usage);put('token_usage_record',{thread_id:thread,turn_id:turn,response_id:`resp_${n+1}`,usage,turn_token_usage:own,thread_token_usage:total});put('event_msg',{type:'token_count',info:{total_token_usage:total,last_token_usage:usage,model_context_window:272000}});});
 return total??usageSum(null,null);
}
let account=null;try{account=JSON.parse(Buffer.from(JSON.parse(fs.readFileSync(path.join(codexHome,'auth.json'),'utf8')).tokens.id_token.split('.')[1],'base64url').toString('utf8')).email??null;}catch{}
if(cfg.calls)fs.appendFileSync(cfg.calls, JSON.stringify({vendor,args,...(cfg.accounts&&args[0]==='exec'?{account,config:process.env.CODEX_HOME??null}:{})})+'\n');
if(args.includes('--version')){console.log('codex-cli 0.166.0-alpha.5.1');process.exit(0);}
if(args.includes('--help')){console.log('--print --add-dir --restricted --safe-mode --setting-sources --settings --strict-mcp-config --mcp-config --no-chrome --permission-mode --permission-prompts --tools --allowedTools --disallowedTools --output-format --verbose --json-schema --max-budget-usd --session-id --ignore-user-config --ignore-rules --json --sandbox --cd --output-schema --config --skip-git-repo-check');process.exit(0);}
// refuses (fake.json): config keys this release does not take. An exec started with one ends at
// once with one line on stderr and nothing printed.
{const unknown=args[0]==='exec'?(cfg.refuses??[]).find(key=>args.some(arg=>arg.startsWith(`${key}=`))):null;if(unknown){console.error(`error: unknown configuration key: ${unknown}`);process.exit(1);}}
// `debug models --bundled` as the real CLI prints it: the catalog as JSON, one row hidden.
// fake.json may carry its own rows as `models`.
if(args[0]==='debug'&&args[1]==='models'){console.log(JSON.stringify({models:cfg.models??[{slug:'big-model',display_name:'Big Model',description:'Frontier model for the most demanding work.',visibility:'list',priority:2},{slug:'quick-model',display_name:'Quick Model',description:'Fast and affordable model for easier tasks.',visibility:'list',priority:1},{slug:'review-model',display_name:'Review Model',description:'Automatic approval review model.',visibility:'hide',priority:9}]}));process.exit(0);}
// `login status` as the real CLI prints it: a ChatGPT sign-in, an API key (exit 0 too, with a masked key), or nothing.
if(args[0]==='login'&&args[1]!=='status'){
 // --device-auth prints the link and a one-time code first, as codex-cli 0.167.0 prints them (watched in a
 // scratch home), then waits for the sign-in on that page; it reads nothing from its input.
 if(args.includes('--device-auth'))console.log("\nWelcome to Codex [v\x1b[90m0.166.0-alpha.5.1\x1b[0m]\n\x1b[90mOpenAI's command-line coding agent\x1b[0m\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mFAKE-CODE\x1b[0m\n\n\x1b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\x1b[0m\n");
 // accounts.loginSeconds: how long the sign-in waits for the owner, as the real one does.
 if(cfg.accounts?.loginSeconds)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,cfg.accounts.loginSeconds*1000);
 const as=cfg.accounts?.loginAs;if(!as){console.error('Login cancelled.');process.exit(1);}
 const payload=Buffer.from(JSON.stringify({email:as,'https://api.openai.com/auth':{chatgpt_plan_type:cfg.accounts.plan??'plus'}})).toString('base64url');
 fs.mkdirSync(codexHome,{recursive:true});fs.writeFileSync(path.join(codexHome,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{id_token:`h.${payload}.s`,access_token:'access-never-shown',refresh_token:'refresh-never-shown'}}),{mode:0o600});
 console.log('Successfully logged in');process.exit(0);
}
if(args[0]==='login'){
 if(mode==='signed-out'){console.log('Not logged in');process.exit(1);}
 if(mode==='api-key'){console.log('API key configured - sk-fake***-0000\nAuthentication is checked when you send a request.');process.exit(0);}
 console.log('Logged in using ChatGPT');process.exit(0);
}
// `mcp list`: the [mcp_servers.NAME] tables of config.toml in CODEX_HOME (or ~/.codex), as the real CLI reads it.
if(args[0]==='mcp'&&args[1]==='list'){let text='';try{text=fs.readFileSync(path.join(codexHome,'config.toml'),'utf8');}catch{}const names=[...text.matchAll(/^\[mcp_servers\.([A-Za-z0-9_-]+)\]\s*$/gm)].map(match=>match[1]);console.log(names.length?names.join('\n'):'No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.');process.exit(0);}
if(args[0]==='app-server'){
 // appServer (fake.json): what this release's app-server speaks beside the usage read. Absent: nothing,
 // and any other method is answered as the real one answers a method it does not have. 'threads':
 // threads and turns, but no turn/steer. 'steer': turn/steer too, as codex-cli 0.167.0 speaks it
 // (read from the real program against a stand-in model service): a message steered into the turn
 // waits while a command runs and is read when it ends, shown as a userMessage item whose clientId
 // is the id it was sent with; with no turn running the answer is "no active turn to steer";
 // turn/interrupt ends the turn as interrupted and drops what it had not read. The turn works in
 // steps (steps, stepMs: one command each, or a pause where the launch has the shell tool off;
 // commandMs: how long the first command runs), and each
 // message it reads is recorded in absorbed.jsonl beside the fake, each request in appserver.jsonl.
 // config/read names a user layer when CODEX_HOME holds a config.toml, as the real one does.
 const readline=await import('node:readline');
 const dir=path.dirname(process.argv[1]),speaks=['steer','threads'].includes(cfg.appServer);
 const out=row=>process.stdout.write(JSON.stringify(row)+'\n'),note=(method,params)=>out({method,params});
 const ownerWords=content=>{const found=/Owner message \(untrusted data[^\n]*\n(.*)\nEnd of Owner message\./.exec(content);try{return found?JSON.parse(found[1]).text:content;}catch{return content;}};
 const absorb=(text,mid,uuid)=>fs.appendFileSync(path.join(dir,'absorbed.jsonl'),JSON.stringify({content:text,mid,...(uuid?{uuid}:{})})+'\n');
 let thread=null,threadModel=null,active=null,turns=0,items=0;const heard=[];
 const item=(state,kind,value)=>note(`item/${kind}`,{threadId:thread,turnId:state.id,item:value});
 const shown=(state,texts,client)=>{const value={type:'userMessage',id:`item_${++items}`,clientId:client??null,content:texts.map(text=>({type:'text',text,text_elements:[]}))};item(state,'started',value);item(state,'completed',value);};
 const takeQueued=state=>{for(const message of state.queue.splice(0)){heard.push(ownerWords(message.text));absorb(message.text,true,message.id);shown(state,[message.text],message.id);}};
 const pause=async(state,ms)=>{const end=Date.now()+ms;while(Date.now()<end&&!state.cut)await new Promise(resolve=>setTimeout(resolve,Math.max(1,Math.min(20,end-Date.now()))));return!state.cut;};
 const ended=(state,status)=>{if(active===state)active=null;note('turn/completed',{threadId:thread,turn:{id:state.id,status,items:[],error:null}});};
 const reply=(input,schema)=>{
  const result={outcome:'done',summary:'Updated coupon normalization.',question:null,choices:[],comments:[],responses:[]},conversation=Boolean(schema?.properties?.intent);
  if(conversation&&schema.properties.repository){const named=cfg.repository;result.repository=named&&fs.existsSync(named)?fs.readFileSync(named,'utf8'):'';}
  if(conversation){result.intent=mode==='answer'?'answer':'edit';if(result.intent==='answer')result.summary='Yes. You can add multiple agents with /agents.';}
  if(cfg.name!==undefined&&schema?.properties?.name)result.name=cfg.name;
  if(schema?.properties?.task)result.task=result.intent!=='edit'||input.includes('Approved Task (untrusted data')?[]:[cfg.task??{title:'Uppercase coupons',description:'Make normalize return the coupon code in upper case.',goal:'Coupon codes compare equal whatever their case.',objectives:['normalize returns the code in upper case'],priority:'medium',severity:'low'}];
  if(schema?.properties?.subtasks){result.subtasks=[{text:'Change normalize',state:'done'}];result.objectivesMet=[1];}
  return result;
 };
 const work=async(state,texts,schema,first)=>{
  note('turn/started',{threadId:thread,turn:{id:state.id,status:'inProgress',items:[],error:null}});
  shown(state,texts,state.client);
  // A turn that a send now started: the messages it starts with are read as it starts.
  if(!first)for(const text of texts){heard.push(ownerWords(text));absorb(text,false,null);}
  if(first){
   item(state,'completed',{type:'reasoning',id:`item_${++items}`,summary:['Working on the requested change.'],content:[]});
   for(let n=0;n<(cfg.steps??2);n++){
    takeQueued(state);
    // A launch with the shell tool off (Read only) has no command to run: the model only thinks.
    if(args.includes('features.shell_tool=false')){if(!await pause(state,cfg.stepMs??100))return ended(state,'interrupted');continue;}
    const command={type:'commandExecution',id:`item_${++items}`,command:"/bin/zsh -lc 'npm test'",cwd:process.cwd(),aggregatedOutput:null,exitCode:null,status:'inProgress',commandActions:[],processId:null,durationMs:null};
    item(state,'started',command);
    if(!await pause(state,n===0&&cfg.commandMs?cfg.commandMs:cfg.stepMs??100))return ended(state,'interrupted');
    item(state,'completed',{...command,aggregatedOutput:'ok\n',exitCode:0,status:'completed',durationMs:1});
   }
  }
  // The model writes its answer; what came meanwhile is read first, and answered with the rest.
  takeQueued(state);if(!await pause(state,cfg.afterMs??20))return ended(state,'interrupted');takeQueued(state);
  const result=reply(texts.join('\n'),schema);if(heard.length)result.summary+=` Also took in what you sent while it worked: ${heard.join(' | ')}`;
  const said=JSON.stringify(result);item(state,'completed',{type:'agentMessage',id:`item_${++items}`,text:said});
  const used=turnUse?codexTurnRun(thread,threadModel):null;
  const total=used?{totalTokens:used.total_tokens,inputTokens:used.input_tokens,cachedInputTokens:used.cached_input_tokens,cacheWriteInputTokens:used.cache_write_input_tokens,outputTokens:used.output_tokens,reasoningOutputTokens:used.reasoning_output_tokens}:{totalTokens:32,inputTokens:20,cachedInputTokens:5,cacheWriteInputTokens:0,outputTokens:12,reasoningOutputTokens:2};
  note('thread/tokenUsage/updated',{threadId:thread,turnId:state.id,tokenUsage:{total,last:total,modelContextWindow:200000}});
  ended(state,'completed');
 };
 const refuse=(id,message)=>out({id,error:{code:-32600,message}});
 for await(const line of readline.createInterface({input:process.stdin})){
  const row=JSON.parse(line),params=row.params??{};if(cfg.calls)fs.appendFileSync(cfg.calls,JSON.stringify({vendor,args:[],rpc:row.method})+'\n');
  if(row.method&&row.method!=='initialize'&&row.method!=='initialized')fs.appendFileSync(path.join(dir,'appserver.jsonl'),JSON.stringify({method:row.method,params,flags:args.flatMap((value,i)=>args[i-1]==='-c'?[value]:[])})+'\n');
  if(row.id==null)continue;
  if(row.method==='initialize'){out({id:row.id,result:{userAgent:'codex_fake/0.166.0-alpha.5.1',codexHome,platformFamily:'unix',platformOs:'linux'}});continue;}
  if(row.method==='account/rateLimits/read'){const resetsAt=Math.floor(Date.now()/1000)+7200,used=cfg.accounts?.codexUsage?.[account]??{fiveHour:18,weekly:62};out({id:row.id,result:{rateLimits:{primary:{usedPercent:used.fiveHour,windowDurationMins:300,resetsAt},secondary:{usedPercent:used.weekly,windowDurationMins:10080,resetsAt:resetsAt+604800}}}});continue;}
  if(!speaks||row.method==='turn/steer'&&cfg.appServer!=='steer'){refuse(row.id,`Invalid request: unknown variant \`${row.method}\`, expected one of \`initialize\`, \`account/rateLimits/read\``);continue;}
  if(row.method==='config/read'){let own='';try{own=fs.readFileSync(path.join(codexHome,'config.toml'),'utf8');}catch{}out({id:row.id,result:{config:{},origins:{},layers:[{name:{type:'sessionFlags'},version:'1',config:{}},...(own.trim()?[{name:{type:'user',file:path.join(codexHome,'config.toml'),profile:null},version:'1',config:{model:'owner-model'}}]:[]),{name:{type:'system',file:'/etc/codex/config.toml'},version:'1',config:{}}]}});continue;}
  if(row.method==='thread/start'||row.method==='thread/resume'){thread=row.method==='thread/resume'?params.threadId:turnUse?newThread():'12345678-1234-4234-8234-123456789abc';threadModel=params.model??(turnUse?turnUse.model??'gpt-6.1-sol':'fake-model');const kept=turnUse?{path:rolloutOf(thread)??rolloutNew(thread)}:{};out({id:row.id,result:{thread:{id:thread,turns:[],...kept},model:threadModel,modelProvider:'openai',cwd:params.cwd??process.cwd(),approvalPolicy:params.approvalPolicy??'on-request',sandbox:{type:params.sandbox==='danger-full-access'?'dangerFullAccess':'readOnly'},reasoningEffort:null}});if(row.method==='thread/start')note('thread/started',{thread:{id:thread,turns:[]}});continue;}
  if(row.method==='turn/start'){
   if(params.threadId!==thread){refuse(row.id,`thread not found: ${params.threadId}`);continue;}
   const texts=(params.input??[]).map(part=>String(part.text??'')),state={id:`turn_${++turns}`,queue:[],cut:false,client:params.clientUserMessageId??null};active=state;
   if(cfg.inputs)fs.appendFileSync(cfg.inputs,JSON.stringify({vendor,args,input:texts.join('\n\n')})+'\n');
   out({id:row.id,result:{turn:{id:state.id,status:'inProgress',items:[],error:null}}});work(state,texts,params.outputSchema??null,turns===1);continue;
  }
  if(row.method==='turn/steer'){
   if(params.threadId!==thread){refuse(row.id,`thread not found: ${params.threadId}`);continue;}
   if(!active){refuse(row.id,'no active turn to steer');continue;}
   if(params.expectedTurnId!==active.id){refuse(row.id,`expected active turn id \`${params.expectedTurnId}\` but found \`${active.id}\``);continue;}
   for(const part of params.input??[])active.queue.push({id:params.clientUserMessageId??null,text:String(part.text??'')});
   out({id:row.id,result:{turnId:active.id}});continue;
  }
  if(row.method==='turn/interrupt'){if(active&&params.turnId===active.id){active.queue.length=0;active.cut=true;}out({id:row.id,result:{}});continue;}
  refuse(row.id,`Invalid request: unknown variant \`${row.method}\``);
 }
 process.exit(0);
}
if(args[0]==='sandbox'){
 const marker=args.indexOf('--'); const run=args.slice(marker+1);
 if(cfg.sandboxBin){const r=spawnSync(cfg.sandboxBin,args,{stdio:'inherit',env:process.env});process.exit(r.status??1);}
 if(args.includes('elu-code-sandbox-probe')){console.log(JSON.stringify({writeDenied:true,networkDenied:true}));process.exit(0);}
 const r=spawnSync(run[0],run.slice(1),{stdio:'inherit',env:process.env});process.exit(r.status??1);
}
let input=early??''; if(early===null)for await (const chunk of process.stdin) input+=chunk;
if(cfg.inputs)fs.appendFileSync(cfg.inputs, JSON.stringify({vendor,args,input})+'\n');
// replay (fake.json): a file holding what a real launch printed, given back as it came. A launch
// that is asked to correct its output answers as usual instead.
if(cfg.replay&&args[0]==='exec'&&!input.includes('Invalid output to correct')){await new Promise(done=>process.stdout.write(fs.readFileSync(cfg.replay,'utf8'),done));process.exit(0);}
const result={outcome:'done',summary:'Updated coupon normalization.',question:null,choices:[],comments:[],responses:[]};
const schemaFile=args.indexOf('--output-schema');
const schema=schemaFile>=0?JSON.parse(fs.readFileSync(args[schemaFile+1],'utf8')):null;
const conversation=Boolean(schema?.properties?.intent);if(conversation&&schema.properties.repository){const named=cfg.repository;result.repository=named&&fs.existsSync(named)?fs.readFileSync(named,'utf8'):'';}if(conversation){result.intent=mode==='answer'||mode==='slow-answer'||mode==='dialogue'&&input.includes('Just explain the implementation')?'answer':'edit';if(result.intent==='answer')result.summary='Yes. You can add multiple agents with /agents.\nNo project checks or setup are needed to ask a question.\nYour next message continues this conversation.';}
if(cfg.name!==undefined&&schema?.properties?.name)result.name=cfg.name;
// A request for an edit plans first (lib/plan.mjs): it comes back with a Task unless the prompt
// carries one the owner approved. fake.json may give its own Task, or none with mode no-task;
// mode bad-task returns one that does not read. A turn that reports progress ticks every subtask.
const TASK={title:'Uppercase coupons',description:'Make normalize return the coupon code in upper case.\nOnly src/coupon.mjs changes.',goal:'Coupon codes compare equal whatever their case.',objectives:['normalize returns the code in upper case','The coupon test passes'],priority:'medium',severity:'low'};
if(schema?.properties?.task)result.task=result.intent!=='edit'||input.includes('Approved Task (untrusted data')||mode==='no-task'?[]:[mode==='bad-task'?{...TASK,priority:'soon'}:input.includes('Make it urgent')?{...TASK,priority:'urgent'}:cfg.task??TASK];
if(schema?.properties?.subtasks){result.subtasks=cfg.subtasks??[{text:'Change normalize',state:'done'},{text:'Run the coupon test',state:'done'}];result.objectivesMet=cfg.objectivesMet??[1,2];}
// `exec resume <id> -` continues that thread; a new run starts a fixed one.
const resumed=args[0]==='exec'&&args[1]==='resume'?args[2]:null;
const session=resumed??(turnUse?newThread():'12345678-1234-4234-8234-123456789abc');
if(mode==='review-block'||mode==='review-fix'&&!input.includes('Handled the edge case.'))result.comments=[{id:'R1',severity:'must_fix',body:'Handle the edge case.'}];
console.log(JSON.stringify({type:'thread.started',thread_id:session}));
if(cfg.accounts?.lapsed===true||cfg.accounts?.lapsed?.includes?.(account)){const message='Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.';console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'error',message}));console.log(JSON.stringify({type:'turn.failed',error:{message}}));process.exit(1);}
// slow: a new thread works for half a minute before it answers, as a long turn does; a resumed
// one answers at once, or after resumeMs (fake.json) when a test needs it still working.
if(mode==='slow'&&resumed&&cfg.resumeMs)await new Promise(resolve=>setTimeout(resolve,cfg.resumeMs));
if(mode==='slow'&&!resumed){console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'item.completed',item:{id:'item_0',type:'reasoning',text:'Working on the requested change.'}}));await new Promise(resolve=>setTimeout(resolve,30000));}
if(cfg.accounts?.limited?.includes(account)){const message="You've hit your usage limit. Upgrade to Pro or try again later.";console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'error',message}));console.log(JSON.stringify({type:'turn.failed',error:{message:`${message} (usage_limit_reached)`}}));process.exit(1);}
// tooLong (fake.json): a review this model will not take (as in the fake Claude Code), ended as
// the real CLI ends a prompt longer than the model's context window.
const tooLong=cfg.tooLong!==undefined&&(cfg.tooLongOn??['Review as @']).some(text=>input.includes(text))&&(cfg.tooLong==='all'||cfg.tooLong==='files'&&/"content":"|"excerpts":\[/.test(input)||typeof cfg.tooLong==='number'&&input.length>cfg.tooLong);
if(tooLong){const message="Codex ran out of room in the model's context window. Start a new conversation or clear earlier history before retrying.";console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'error',message}));console.log(JSON.stringify({type:'turn.failed',error:{message}}));process.exit(1);}
// commands (fake.json): what the model runs this turn. Each runs in a plain shell with the
// environment this process was started with, as a session's command does, and is shown as it ran:
// item.started before it runs and item.completed after, as the real CLI prints them.
if(Array.isArray(cfg.commands)&&args.some(a=>/^default_permissions=|^sandbox_mode=/.test(a))){cfg.commands.forEach((command,i)=>{const item={id:`item_${i+1}`,type:'command_execution',command:`/bin/zsh -c '${command}'`};console.log(JSON.stringify({type:'item.started',item:{...item,aggregated_output:'',exit_code:null,status:'in_progress'}}));const r=spawnSync('/bin/sh',['-c',command],{env:process.env,encoding:'utf8'});console.log(JSON.stringify({type:'item.completed',item:{...item,aggregated_output:`${r.stdout??''}${r.stderr??''}`,exit_code:r.status,status:r.status===0?'completed':'failed'}}));});}
// A lead run shows one sandboxed command; in declined mode the auto reviewer refused it.
else if(args.some(a=>/^default_permissions=|^sandbox_mode=/.test(a))){const status=mode==='declined'?'declined':'completed';console.log(JSON.stringify({type:'item.started',item:{id:'item_1',type:'command_execution',command:'/bin/zsh -lc \'npm test\'',aggregated_output:'',exit_code:null,status:'in_progress'}}));console.log(JSON.stringify({type:'item.completed',item:{id:'item_1',type:'command_execution',command:'/bin/zsh -lc \'npm test\'',aggregated_output:status==='completed'?'ok\n':'',exit_code:status==='completed'?0:null,status}}));if(status==='declined'){result.outcome='needs_input';result.question='The test run was declined. Allow npm test?';}}
// steps (mode): a turn that shows its work as exec --json writes it. A reasoning item comes only
// with -c model_reasoning_summary set to something other than none: every model in the release's
// catalog defaults to none, and then the stream has no reasoning item. gate (fake.json): a file
// the turn waits for while its command runs.
if(mode==='steps'){
 const summary=args.flatMap((a,i)=>args[i-1]==='-c'&&/^model_reasoning_summary=/.test(a)?[a.split('=')[1].replace(/"/g,'')]:[]).at(-1)??'none';
 const item=(type,value)=>console.log(JSON.stringify({type,item:value}));
 if(summary!=='none')item('item.completed',{id:'item_10',type:'reasoning',text:'**Reading the coupon module**\n\nThe codes should compare in upper case.'});
 item('item.started',{id:'item_11',type:'command_execution',command:"/bin/zsh -c 'npm test'",aggregated_output:'',exit_code:null,status:'in_progress'});
 if(cfg.gate){while(!fs.existsSync(cfg.gate))await new Promise(resolve=>setTimeout(resolve,20));}
 item('item.completed',{id:'item_11',type:'command_execution',command:"/bin/zsh -c 'npm test'",aggregated_output:'not ok 1\n',exit_code:1,status:'failed'});
 item('item.completed',{id:'item_12',type:'agent_message',text:'The test fails on lower case codes. Fixing normalize.'});
 item('item.completed',{id:'item_13',type:'file_change',changes:[{path:path.join(process.cwd(),'src','coupon.mjs'),kind:'update'}],status:'completed'});
}
// live (fake.json): a file; a turn launched with the plan tool on prints its to-do list, first
// step done, as the real one prints a todo_list item, and goes on once that file exists.
if(cfg.live&&args.includes('tools.update_plan.enabled=true')){console.log(JSON.stringify({type:'item.started',item:{id:'item_todo',type:'todo_list',items:[{text:'Change normalize',completed:true},{text:'Run the coupon test',completed:false}]}}));const until=Date.now()+30000;while(!fs.existsSync(cfg.live)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,50));}
if(turnUse?.printed){const text='x'.repeat(65536);for(let at=0;at<turnUse.printed;at+=text.length)console.log(JSON.stringify({type:'item.completed',item:{id:`item_long_${at}`,type:'reasoning',text}}));}
// summary (a byInput rule): what this reply says.
if(typeof cfg.summary==='string')result.summary=cfg.summary;
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}));
{const named=args.flatMap((arg,i)=>['--model','-m'].includes(args[i-1])?[arg]:[]).at(-1);
 const {total_tokens,...usage}=turnUse?codexTurnRun(session,named??turnUse.model??'gpt-6.1-sol'):{input_tokens:0,output_tokens:0};
 console.log(JSON.stringify({type:'turn.completed',usage}));}
