// The fake Codex CLI tests run instead of the real one: lead, reviewer, usage app-server and
// sandbox helper. fakeClis() in helpers.mjs copies it to a bin folder (adding the node
// shebang) next to fake.json, which holds the test's mode and the files it records to.
import fs from 'node:fs'; import path from 'node:path'; import {spawnSync} from 'node:child_process';
const vendor=path.basename(process.argv[1]); const args=process.argv.slice(2);
let cfg={}; try{cfg=JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]),'fake.json'),'utf8'));}catch{}
const mode=cfg.mode??'normal';
if(cfg.calls)fs.appendFileSync(cfg.calls, JSON.stringify({vendor,args})+'\n');
if(args.includes('--version')){console.log('codex-cli 0.166.0-alpha.5.1');process.exit(0);}
if(args.includes('--help')){console.log('--print --add-dir --restricted --safe-mode --setting-sources --settings --strict-mcp-config --mcp-config --no-chrome --permission-mode --permission-prompts --tools --allowedTools --disallowedTools --output-format --verbose --json-schema --max-budget-usd --session-id --ignore-user-config --ignore-rules --json --sandbox --cd --output-schema --config --skip-git-repo-check');process.exit(0);}
// `debug models --bundled` as the real CLI prints it: the catalog as JSON, one row hidden.
// fake.json may carry its own rows as `models`.
if(args[0]==='debug'&&args[1]==='models'){console.log(JSON.stringify({models:cfg.models??[{slug:'big-model',display_name:'Big Model',description:'Frontier model for the most demanding work.',visibility:'list',priority:2},{slug:'quick-model',display_name:'Quick Model',description:'Fast and affordable model for easier tasks.',visibility:'list',priority:1},{slug:'review-model',display_name:'Review Model',description:'Automatic approval review model.',visibility:'hide',priority:9}]}));process.exit(0);}
// `login status` as the real CLI prints it: a ChatGPT sign-in, an API key (exit 0 too, with a masked key), or nothing.
if(args[0]==='login'){
 if(mode==='signed-out'){console.log('Not logged in');process.exit(1);}
 if(mode==='api-key'){console.log('API key configured - sk-fake***-0000\nAuthentication is checked when you send a request.');process.exit(0);}
 console.log('Logged in using ChatGPT');process.exit(0);
}
if(args[0]==='app-server'){
 const readline=await import('node:readline');
 for await(const line of readline.createInterface({input:process.stdin})){
  const row=JSON.parse(line);if(cfg.calls)fs.appendFileSync(cfg.calls,JSON.stringify({vendor,args:[],rpc:row.method})+'\n');
  if(row.id===1)console.log(JSON.stringify({id:1,result:{}}));
  if(row.id===2){const resetsAt=Math.floor(Date.now()/1000)+7200;console.log(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:18,windowDurationMins:300,resetsAt},secondary:{usedPercent:62,windowDurationMins:10080,resetsAt:resetsAt+604800}}}}));}
 }
 process.exit(0);
}
if(args[0]==='sandbox'){
 const marker=args.indexOf('--'); const run=args.slice(marker+1);
 if(cfg.sandboxBin){const r=spawnSync(cfg.sandboxBin,args,{stdio:'inherit',env:process.env});process.exit(r.status??1);}
 if(args.includes('elu-code-sandbox-probe')){console.log(JSON.stringify({writeDenied:true,networkDenied:true}));process.exit(0);}
 const r=spawnSync(run[0],run.slice(1),{stdio:'inherit',env:process.env});process.exit(r.status??1);
}
let input=''; for await (const chunk of process.stdin) input+=chunk;
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
const session=resumed??'12345678-1234-4234-8234-123456789abc';
if(mode==='review-block'||mode==='review-fix'&&!input.includes('Handled the edge case.'))result.comments=[{id:'R1',severity:'must_fix',body:'Handle the edge case.'}];
console.log(JSON.stringify({type:'thread.started',thread_id:session}));
// tooLong (fake.json): a review this model will not take (as in the fake Claude Code), ended as
// the real CLI ends a prompt longer than the model's context window.
const tooLong=cfg.tooLong!==undefined&&input.includes('Review as @')&&(cfg.tooLong==='all'||cfg.tooLong==='files'&&/"content":"|"excerpts":\[/.test(input)||typeof cfg.tooLong==='number'&&input.length>cfg.tooLong);
if(tooLong){const message="Codex ran out of room in the model's context window. Start a new conversation or clear earlier history before retrying.";console.log(JSON.stringify({type:'turn.started'}));console.log(JSON.stringify({type:'error',message}));console.log(JSON.stringify({type:'turn.failed',error:{message}}));process.exit(1);}
// commands (fake.json): what the model runs this turn. Each runs in a plain shell with the
// environment this process was started with, as a session's command does, and is shown as it ran.
if(Array.isArray(cfg.commands)&&args.some(a=>/^default_permissions=|^sandbox_mode=/.test(a))){cfg.commands.forEach((command,i)=>{const r=spawnSync('/bin/sh',['-c',command],{env:process.env,encoding:'utf8'});const item={id:`item_${i+1}`,type:'command_execution',command:`/bin/zsh -c '${command}'`};console.log(JSON.stringify({type:'item.started',item:{...item,aggregated_output:'',exit_code:null,status:'in_progress'}}));console.log(JSON.stringify({type:'item.completed',item:{...item,aggregated_output:`${r.stdout??''}${r.stderr??''}`,exit_code:r.status,status:r.status===0?'completed':'failed'}}));});}
// A lead run shows one sandboxed command; in declined mode the auto reviewer refused it.
else if(args.some(a=>/^default_permissions=|^sandbox_mode=/.test(a))){const status=mode==='declined'?'declined':'completed';console.log(JSON.stringify({type:'item.started',item:{id:'item_1',type:'command_execution',command:'/bin/zsh -lc \'npm test\'',aggregated_output:'',exit_code:null,status:'in_progress'}}));console.log(JSON.stringify({type:'item.completed',item:{id:'item_1',type:'command_execution',command:'/bin/zsh -lc \'npm test\'',aggregated_output:status==='completed'?'ok\n':'',exit_code:status==='completed'?0:null,status}}));if(status==='declined'){result.outcome='needs_input';result.question='The test run was declined. Allow npm test?';}}
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}));
