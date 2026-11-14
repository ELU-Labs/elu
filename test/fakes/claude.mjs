// The fake Claude Code CLI tests run instead of the real one. fakeClis() in helpers.mjs
// copies it to a bin folder (adding the node shebang) next to fake.json, which holds the
// test's mode and the files it records to. Without fake.json it behaves as a signed-in
// 2.1.319 that records nothing.
import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline'; import crypto from 'node:crypto';
const vendor=path.basename(process.argv[1]); const args=process.argv.slice(2);
let cfg={}; try{cfg=JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]),'fake.json'),'utf8'));}catch{}
// byMode (fake.json): what a turn started in that --permission-mode does (default, auto,
// bypassPermissions), over the rest of fake.json, so one session's turns can differ by mode.
{const at=args.indexOf('--permission-mode');const started=at>=0?args[at+1]:'default';if(cfg.byMode?.[started])cfg={...cfg,...cfg.byMode[started]};}
const mode=cfg.mode??'normal';
// The model catalog as Claude Code bundles it (the 2.1.323 shape, trimmed). ELU reads each
// row's default_effort from this file to name the effort a run went with; it never runs it for that.
const CATALOG={version:1,models:[{id:"claude-fable-5-1",family:"fable",context:{window:1e6,native_1m:!0},max_output_tokens:{default:64000,upper:128000},capabilities:["effort","max_effort"],default_effort:"high",effort_cost_index:{low:0.75,medium:0.86,high:1}},{id:"claude-fable-5-2",family:"fable",display_name:"Fable 5.2",capabilities:["effort","per_turn_effort"],default_effort:"medium",image_limits:{maxWidth:2576}},{id:"claude-opus-5-5",family:"opus",display_name:"Opus 5.5",capabilities:["effort"],default_effort:"medium"},{id:"claude-sonnet-5-5",family:"sonnet",default_effort:"medium"},{id:"claude-haiku-5-5",family:"haiku",default_effort:"medium"},{id:"claude-3-5-sonnet",family:"sonnet",capabilities:[]}],aliases:{opus:{default:"claude-opus-5-5"}}};
// claude mcp add-json --scope user -- NAME JSON and claude mcp remove --scope SCOPE -- NAME, as the real 2.1.322 does them, on the
// .claude.json in CLAUDE_CONFIG_DIR. The settings are recorded as <json>, so a test can look for a key everywhere else.
// mode mcp-echo: add-json fails and prints the settings it was given, as an error may.
if(args[0]==='mcp'){
 const dir=process.env.CLAUDE_CONFIG_DIR??process.env.HOME,file=path.join(dir,'.claude.json');let data={};try{data=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
 const scope=args.includes('--scope')?args[args.indexOf('--scope')+1]:null,dashed=args.indexOf('--'),words=args.slice(1).filter((arg,at,all)=>arg!=='--scope'&&all[at-1]!=='--scope'&&at+1!==dashed);
 // A word that starts with - before -- is an option, as commander reads it.
 if(args.slice(1,dashed<0?undefined:dashed).some((arg,at,all)=>arg.startsWith('-')&&arg!=='--scope'&&all[at-1]!=='--scope')){console.error(`error: unknown option '${args.slice(1).find(arg=>arg.startsWith('-')&&arg!=='--scope')}'`);process.exit(1);}
 if(cfg.calls)fs.appendFileSync(cfg.calls,JSON.stringify({vendor,args:args.map((arg,at)=>args[1]==='add-json'&&at===args.length-1?'<json>':arg),cwd:process.cwd()})+'\n');
 const save=()=>{fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(file,JSON.stringify(data,null,2),{mode:0o600});};
 if(words[0]==='add-json'){
  const [,name,json]=words;
  if(mode==='mcp-echo'){console.error(`Invalid configuration: ${json}`);process.exit(1);}
  if(!/^[A-Za-z0-9_-]+$/.test(name??'')){console.error(`Invalid name ${name}. Names can only contain letters, numbers, hyphens, and underscores.`);process.exit(1);}
  let entry;try{entry=JSON.parse(json);}catch{entry=null;}
  if(!entry||entry.url&&!entry.type){console.error('Invalid configuration: : Invalid input');process.exit(1);}
  if(scope!=='user'){console.error('The fake takes --scope user only.');process.exit(1);}
  if(data.mcpServers?.[name]){console.error(`MCP server ${name} already exists in user config`);process.exit(1);}
  data.mcpServers={...data.mcpServers,[name]:entry};save();console.log(`Added ${entry.type??'stdio'} MCP server ${name} to user config`);process.exit(0);
 }
 if(words[0]==='remove'){
  const name=words[1],servers=scope==='local'?data.projects?.[process.cwd()]?.mcpServers:data.mcpServers;
  if(!servers?.[name]){console.error(`No MCP server named "${name}" in ${scope} scope`);process.exit(1);}
  delete servers[name];save();console.log(`Removed MCP server ${name} from ${scope} config`);process.exit(0);
 }
 // claude mcp list: the user-scope servers of that .claude.json, then the folder's local ones, by name and target.
 if(words[0]==='list'){
  const rows=Object.entries({...data.mcpServers,...data.projects?.[process.cwd()]?.mcpServers});
  if(!rows.length){console.log('No MCP servers configured. Use `claude mcp add` to add a server.');process.exit(0);}
  console.log('Checking MCP server health...\n');for(const [name,entry] of rows)console.log(`${name}: ${entry.url??[entry.command,...(entry.args??[])].join(' ')}`);process.exit(0);
 }
 console.error('The fake knows mcp add-json, mcp remove and mcp list only.');process.exit(1);
}
// accounts (fake.json): the account a run is on is the one .claude.json names in its config
// folder, CLAUDE_CONFIG_DIR, as the real CLI reads it (HOME without it); a call records it and
// what it sees there of the owner's settings and memory. accounts.loginAs: the account
// `auth login` signs in, into that folder; none ends it as cancelled. accounts.limited: accounts
// whose runs end as the real CLI ends one at its session limit. accounts.usage: per account,
// the fractions of the windows a run reports. accounts.keychain: `auth login` keeps the sign-in
// where the real CLI keeps it on macOS, in the Keychain (the stand-in security first on PATH),
// as a generic password for $USER named "Claude Code-credentials", then, when
// CLAUDE_CONFIG_DIR is set, "-" and the first 8 hex digits of the SHA-256 of that value.
// A run records userMcp: the user-scope servers it would read from its own .claude.json.
const home=process.env.CLAUDE_CONFIG_DIR??process.env.HOME??'';const readIn=name=>{try{return fs.readFileSync(path.join(home,name),'utf8');}catch{return null;}};
let account=null;try{account=JSON.parse(readIn('.claude.json')).oauthAccount?.emailAddress??null;}catch{}
const seen=()=>{const list=dir=>{try{return fs.readdirSync(path.join(home,dir)).sort();}catch{return null;}};const mcpAt=args.indexOf('--mcp-config');let mcp=null;try{const value=mcpAt>=0?args[mcpAt+1]:null;mcp=Object.keys(JSON.parse(value.trim().startsWith('{')?value:fs.readFileSync(value,'utf8')).mcpServers??{}).sort();}catch{}let userMcp=null;try{userMcp=Object.keys(JSON.parse(readIn('.claude.json')).mcpServers??{}).sort();}catch{}const memory=args.flatMap((arg,at)=>arg==='--add-dir'&&/memory$/.test(args[at+1]??'')?[args[at+1]]:[]).flatMap(dir=>{try{return fs.readdirSync(dir).sort().map(name=>`${name}:${fs.readFileSync(path.join(dir,name),'utf8')}`);}catch{return [];}});return {settings:readIn('settings.json'),claudeMd:readIn('CLAUDE.md'),skills:list('skills'),projects:list('projects'),mcp,userMcp,memory};};
// envs (fake.json): each call also records the turn's own elu folder and session it was started with (lib/session-commands.mjs).
if(cfg.calls)fs.appendFileSync(cfg.calls, JSON.stringify({vendor,args,...(cfg.note?{tmp:process.env.CLAUDE_CODE_TMPDIR??null}:{}),...(cfg.envs?{own:process.env.ELU_COMMAND_FOLDER??null,session:process.env.ELU_SESSION??null}:{}),...(cfg.accounts&&args[0]!=='auth'&&!args.includes('--version')&&!args.includes('--help')?{account,config:process.env.CLAUDE_CONFIG_DIR??null,...seen()}:{})})+'\n');
if(args.includes('--version')){console.log('2.1.319');process.exit(0);}
// The --model entry of the real --help, which is where the aliases a bot's Model step offers come from.
const MODEL_HELP="  --model <model>                       Model for the current session. Provide\n                                        an alias for the latest model (e.g.\n                                        'fable', 'opus', or 'sonnet') or a\n                                        model's full name.\n  -n, --name <name>                     Set a display name for this session";
if(args.includes('--help')){console.log('--print --add-dir --restricted --safe-mode --setting-sources --settings --strict-mcp-config --mcp-config --no-chrome --permission-mode --permission-prompts --tools --allowedTools --disallowedTools --output-format --verbose --json-schema --max-budget-usd --session-id --input-format --ignore-user-config --ignore-rules --json --sandbox --cd --output-schema --config');console.log(MODEL_HELP);process.exit(0);}
if(args[0]==='auth'&&args[1]==='login'){
 // The sign-in as Claude Code 2.1.322 runs it (read in its code, and watched in a scratch home
 // over SSH). It tries the browser, prints the link for when none opened, and waits for the
 // code that page shows. On a terminal it sets the input raw, so nothing typed or pasted is
 // shown, and reads a line at a time: the line is cut at # into code and state and sent as it
 // came. Paste marks around it (ESC[200~ … ESC[201~, which a terminal adds while the app that
 // has it asked for them) end up in the code, and the server refuses it. A line with no # is
 // told so and it waits on; Ctrl-C ends it with 130 and no word.
 // accounts.pasted: a file that gets the line as it arrived. accounts.terminal: piped input is
 // read as the terminal's. accounts.listener false: the browser cannot hand the sign-in back
 // (no local listener), so it asks for the code outright and Ctrl-D ends it.
 const link='https://claude.example/oauth/authorize?code=true&client_id=00000000-0000-4000-8000-000000000000&response_type=code&redirect_uri=https%3A%2F%2Fclaude.example%2Foauth%2Fcode%2Fcallback&scope=user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers&code_challenge=FAKEfakeFAKEfakeFAKEfakeFAKEfakeFAKEfake123&code_challenge_method=S256&state=FAKEstateFAKEstateFAKEstateFAKEstate12345';
 const tty=process.stdin.isTTY&&process.stdout.isTTY,terminal=tty||cfg.accounts?.terminal===true,manual=terminal&&cfg.accounts?.listener===false;
 process.stdout.write(manual?`The browser can't return the sign-in to Claude Code automatically. After you sign in, paste the code shown.\nSign in at: ${link}\nPaste code here > `:`Opening browser to sign in…\nIf the browser didn't open, visit: ${link}\nPaste code here if prompted > `);
 if(terminal){
  if(tty)process.stdin.setRawMode(true);
  const end=(code,text='')=>{if(tty)process.stdin.setRawMode(false);process.stderr.write(text);process.exit(code);};
  const code=await new Promise(resolve=>{let held='';process.stdin.on('data',chunk=>{
   const text=chunk.toString('utf8');
   if(text.includes('\x03'))end(130);
   if(manual&&text.includes('\x04'))end(130,'\nLogin failed: Input ended before a code was pasted. Sign in again and paste the code shown.\n');
   held+=text;
   for(let at;(at=held.search(/[\r\n]/))>=0;){
    const line=held.slice(0,at);held=held.slice(at+1);
    if(cfg.accounts?.pasted)fs.writeFileSync(cfg.accounts.pasted,JSON.stringify(line));
    const [code,state]=line.trim().split('#');
    if(!code||!state){process.stderr.write('Invalid code. Please make sure the full code was copied.\n');continue;}
    return resolve(code);
   }
  });});
  // The server takes the code it issued and no other.
  if(!/^[A-Za-z0-9_-]+$/.test(code))end(1,"Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.\n");
  if(tty)process.stdin.setRawMode(false);
 }
 const as=cfg.accounts?.loginAs;if(!as){console.error('Login cancelled.');process.exit(1);}
 fs.mkdirSync(home,{recursive:true});fs.writeFileSync(path.join(home,'.claude.json'),JSON.stringify({oauthAccount:{accountUuid:'uuid-never-shown',emailAddress:as,organizationName:'Example',planDisplayName:cfg.accounts.plan??'Pro'}}),{mode:0o600});
 const signIn=JSON.stringify({claudeAiOauth:{accessToken:'access-never-shown',refreshToken:'refresh-never-shown'}});
 if(cfg.accounts.keychain){const {createHash}=await import('node:crypto'),{spawnSync}=await import('node:child_process');const dir=process.env.CLAUDE_CONFIG_DIR;const service=`Claude Code-credentials${dir?`-${createHash('sha256').update(dir.normalize('NFC')).digest('hex').substring(0,8)}`:''}`;const saved=spawnSync('security',['add-generic-password','-U','-a',process.env.USER||'claude-code-user','-s',service,'-X',Buffer.from(signIn).toString('hex')],{stdio:'ignore'});if(saved.status!==0){console.error('Could not save the sign-in in the Keychain.');process.exit(1);}}
 else fs.writeFileSync(path.join(home,'.credentials.json'),signIn,{mode:0o600});
 console.log('Login successful.');process.exit(0);
}
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:mode!=='signed-out'&&(!cfg.accounts||Boolean(account))}));process.exit(0);}
// refuses (fake.json): options this release does not take. A run started with one ends at once
// as the real CLI ends it, with one line on stderr and nothing printed; --version above still
// answers, as the real 2.1.322 does for any flag.
{const unknown=(cfg.refuses??[]).find(flag=>args.includes(flag));if(unknown){console.error(`error: unknown option '${unknown}'`);process.exit(1);}}
// --input-format stream-json: the prompt is the first line, a user message, and the input stays
// open for the answers to this run's control requests until the runner closes it.
const streaming=args.includes('--input-format')&&args[args.indexOf('--input-format')+1]==='stream-json';
const lines=[],waiters=[];let inputEnded=false;
const nextLine=()=>lines.length?Promise.resolve(lines.shift()):inputEnded?Promise.resolve(null):new Promise(resolve=>waiters.push(resolve));
// onLine: once the prompt is read, the lines of the running turn go here first (a user message,
// a control request); true when it took the line. wake() resolves at the next one, or at the end of the input.
let onLine=null,wakeUp=null;const wake=()=>new Promise(resolve=>{wakeUp=resolve;}),notify=()=>{const go=wakeUp;wakeUp=null;go?.();};
let input='';
if(streaming){const reader=readline.createInterface({input:process.stdin});reader.on('line',line=>{if(onLine?.(line)){notify();return;}if(waiters.length)waiters.shift()(line);else lines.push(line);});reader.on('close',()=>{inputEnded=true;while(waiters.length)waiters.shift()(null);notify();});const first=JSON.parse(await nextLine()??'{}');if(first.type!=='user'||typeof first.message?.content!=='string')throw new Error('The first stream-json line is not a user message.');input=first.message.content;}
else for await (const chunk of process.stdin) input+=chunk;
// stdinLimit (fake.json): input over that many characters is refused before anything starts,
// as the real CLI refuses piped input over 10MB: one line on stderr, nothing on stdout, exit 1.
if(typeof cfg.stdinLimit==='number'&&input.length>cfg.stdinLimit){console.error('Error: piped stdin input exceeds 10MB. Pass large content as a file path in your prompt instead.');process.exit(1);}
if(cfg.inputs)fs.appendFileSync(cfg.inputs, JSON.stringify({vendor,args,input})+'\n');
// hold, or accounts.hold (fake.json): while that file is there, a run waits before it answers.
{const hold=cfg.hold??cfg.accounts?.hold;if(hold)while(fs.existsSync(hold))await new Promise(resolve=>setTimeout(resolve,20));}
const result={outcome:'done',summary:'Updated coupon normalization.',question:null,choices:[],comments:[],responses:[]};
const schemaArg=args.indexOf('--json-schema');
const schema=schemaArg>=0?JSON.parse(args[schemaArg+1]):null;
const conversation=Boolean(schema?.properties?.intent);if(conversation&&schema.properties.repository){const named=cfg.repository;result.repository=named&&fs.existsSync(named)?fs.readFileSync(named,'utf8'):'';}if(conversation){result.intent=mode==='answer'||mode==='slow-answer'||mode==='dialogue'&&input.includes('Just explain the implementation')?'answer':'edit';if(result.intent==='answer')result.summary='Yes. You can add multiple agents with /agents.\nNo project checks or setup are needed to ask a question.\nYour next message continues this conversation.';}
if(cfg.name!==undefined&&schema?.properties?.name)result.name=cfg.name;
// learned (fake.json): what the reply says the owner taught, given only when the schema offers it, as a model would.
if(cfg.learned!==undefined&&schema?.properties?.learned)result.learned=cfg.learned;
// intent (fake.json): answer makes every conversation turn an answer, so a relay test needs no Task.
if(conversation&&cfg.intent==='answer'){result.intent='answer';result.summary='Looked.';}
// answer (fake.json): what an answering turn says.
if(conversation&&result.intent==='answer'&&typeof cfg.answer==='string')result.summary=cfg.answer;
// A request for an edit plans first (lib/plan.mjs): it comes back with a Task unless the prompt
// carries one the owner approved. fake.json may give its own Task, or none with mode no-task;
// mode bad-task returns one that does not read. A turn that reports progress ticks every subtask.
const TASK={title:'Uppercase coupons',description:'Make normalize return the coupon code in upper case.\nOnly src/coupon.mjs changes.',goal:'Coupon codes compare equal whatever their case.',objectives:['normalize returns the code in upper case','The coupon test passes'],priority:'medium',severity:'low'};
if(schema?.properties?.task)result.task=result.intent!=='edit'||input.includes('Approved Task (untrusted data')||mode==='no-task'?[]:[mode==='bad-task'?{...TASK,priority:'soon'}:input.includes('Make it urgent')?{...TASK,priority:'urgent'}:cfg.task??TASK];
// tells (fake.json): the planning reply says what its prompt told it to do with the Task: it waits
// for the owner's approval when told to plan first, and goes to work when told the mode approves it.
if(cfg.tells&&conversation&&result.task?.length)result.summary=input.includes('nobody has to approve it')?'Found normalize in src/coupon.mjs. Uppercasing the codes now.':'Nothing is changed yet. One Task is below for your approval.';
if(schema?.properties?.subtasks){result.subtasks=cfg.subtasks??[{text:'Change normalize',state:'done'},{text:'Run the coupon test',state:'done'}];result.objectivesMet=cfg.objectivesMet??[1,2];if(cfg.etaMinutes!==undefined)result.etaMinutes=cfg.etaMinutes;}
// The owner's last message in the chat this turn was given (the Context block), as a model reads it.
const lastOwner=(()=>{const found=/\nContext \(untrusted data[^\n]*\n(.*)\nEnd of Context\./.exec(input);try{return String((JSON.parse(found[1]).messages??[]).findLast(row=>!row.from&&!row.to)?.text??'');}catch{return '';}})();
// approved: offered when a Task waits and the owner wrote the message (lib/plan.mjs). His message
// approves it in words of his own when it says so (go ahead, sounds good, do it, approve, ship it).
if(schema?.properties?.approved){result.approved=/\b(go ahead|sounds good|do it|approve|ship it)\b/i.test(lastOwner)&&!/\?\s*$/.test(lastOwner);if(result.approved){result.intent='answer';result.task=[];result.summary='Approved. The work starts now.';}}
// ops (mode): work that changes no repository file. The turn answers with a Task. Told to do such
// work now, in this turn (a mode that approves Tasks), or given its approved Task, it runs its
// check and reports both objectives met; told to plan first, it only writes the Task.
const OPS_TASK={title:'Check the coupon build',description:'Run the build check and report what it shows.',goal:'The coupon build is known to pass.',objectives:['The build check has run','Its result is reported'],priority:'medium',severity:'low'};
let opsRun=false;
if(mode==='ops'&&conversation&&result.approved!==true){
 const given=input.includes('Approved Task (untrusted data');opsRun=given||input.includes('do now, in this turn');
 result.intent='answer';if(schema?.properties?.task)result.task=given?[]:[OPS_TASK];
 if(schema?.properties?.subtasks){result.subtasks=opsRun?[{text:'Run the build check',state:'done'}]:[];result.objectivesMet=opsRun?[1,2]:[];}
 result.summary=opsRun?'Ran the build check: it passed.':'Nothing is changed yet. One Task is below for your approval.';
}
// next (fake.json): what the turn that answers a bare continue does. Told that continue means
// the next piece of the goal, it takes it (intent edit, and its editing turn trims spaces too);
// not told, it answers that nothing is left, as a model that waits to be asked does.
const continued=/^continue\b/i.test(lastOwner.trim());
if(cfg.next&&conversation&&continued){
 if(input.includes('they mean the next piece of the goal')){result.intent='edit';result.summary='Next for the goal: trim spaces before the code is compared.';if(schema?.properties?.task)result.task=[];}
 else{result.intent='answer';result.summary='Nothing is left that I can do.';if(schema?.properties?.task)result.task=[];}
}
const session='12345678-1234-4234-8234-123456789abc';
// badReply (fake.json): 'once' gives a reply that cannot be read until the session is asked again; 'lost' also
// refuses that session, as the real one does a session it cannot find, and reads well once the message starts over.
const resumed=args.includes('--resume');
if(cfg.badReply==='lost'&&resumed){console.error('No conversation found with session ID: '+args[args.indexOf('--resume')+1]);console.log('{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"'+session+'","total_cost_usd":0}');process.exit(1);}
const badReply=cfg.badReply==='once'&&!resumed||cfg.badReply==='lost'&&!input.includes('Invalid output to correct');
// models (fake.json): the full id a run reports in system/init for the --model it was started
// with. noCredits: a --model this account has no usage credits for; that run ends as the real
// CLI's does then, with the API error on its result line.
// A --model that is a full id of the catalog reports that id. An alias (opus) reports what
// models gives it, else claude-fable-5-1, as a run with no --model does. Any other name is no
// model: the real CLI starts, reports the name it was given, and ends with the API's 404 on
// its result line; it never runs another model in its place.
const nothingSpent=0;const modelArg=args.includes('--model')?args[args.indexOf('--model')+1]:null;
const ALIASES=['fable','opus','sonnet','haiku','default','best','opusplan'];const plainModel=String(modelArg??'').replace(/\[[^\]]*\]$/,'');const listed=(CATALOG?.models??[]).find(row=>row.id===plainModel.replace(/-\d{8}$/,''))?.id??null;
const reported=cfg.models?.[modelArg]??listed??'claude-fable-5-1';
if(modelArg!==null&&cfg.models?.[modelArg]===undefined&&!listed&&!ALIASES.includes(plainModel)){console.log(JSON.stringify({type:'system',subtype:'init',session_id:session,model:modelArg,permissionMode:'default',mcp_servers:[]}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,api_error_status:404,api_error:'not_found_error',duration_ms:150,num_turns:1,result:`There's an issue with the selected model (${modelArg}). It may not exist or you may not have access to it. Run --model to pick a different model.`,session_id:session,total_cost_usd:nothingSpent}));process.exit(1);}
if(cfg.noCredits&&modelArg===cfg.noCredits){console.log(JSON.stringify({type:'system',subtype:'init',session_id:session,model:reported,permissionMode:'default',mcp_servers:[]}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,api_error_status:429,api_error:'model_requires_usage_credits',duration_ms:180,num_turns:1,result:"You're out of usage credits. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.",session_id:session,total_cost_usd:nothingSpent}));process.exit(1);}
// tooLong (fake.json): a review this model will not take, ended as the real CLI ends a prompt
// longer than its model takes: a number, one over that many characters; 'files', one that
// carries any file's content or excerpts; 'all', every one. tooLongOn: the texts that mark such a
// turn, one of which its input holds (a review's by default).
const tooLong=cfg.tooLong!==undefined&&(cfg.tooLongOn??['Review as @']).some(text=>input.includes(text))&&(cfg.tooLong==='all'||cfg.tooLong==='files'&&/"content":"|"excerpts":\[/.test(input)||typeof cfg.tooLong==='number'&&input.length>cfg.tooLong);
// standupTooLong (fake.json): a Standup turn over that many characters, refused the same way.
const standupTooLong=typeof cfg.standupTooLong==='number'&&input.includes("owner's Standup")&&input.length>cfg.standupTooLong;
// promptTooLong (fake.json): any prompt over that many characters, refused the same way.
const promptTooLong=typeof cfg.promptTooLong==='number'&&input.length>cfg.promptTooLong;
if(tooLong||standupTooLong||promptTooLong){console.log(JSON.stringify({type:'system',subtype:'init',session_id:session,model:reported,permissionMode:'default',mcp_servers:[]}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,duration_ms:120,num_turns:1,result:'Prompt is too long',session_id:session,total_cost_usd:nothingSpent}));process.exit(1);}
if(mode==='no-sandbox'){console.error('Error: sandbox required but unavailable: bubblewrap (bwrap) not installed, socat not installed');console.error('  sandbox.failIfUnavailable is set.');console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,session_id:session}));process.exit(1);}
// spend (fake.json): what a turn uses itself, { model, tokens: [in, out, cacheRead, cacheWrite], usd }.
// As the real CLI, the session then has its own id (the one --session-id names, or the one
// --resume goes on with), and its result carries usage (the turn's own tokens) and, in
// modelUsage and total_cost_usd, what the whole session has used so far: a resumed turn goes on
// from its session's totals (kept beside fake.json for each session, a turn that is stopped
// included), a new session starts from nothing. As the real CLI, modelUsage has one line per
// model the session used: a turn on another model (after /model) adds its own line and keeps
// the others as they were. An assistant row with the turn's tokens comes before any answer.
if(cfg.spend){
 const kept=path.join(path.dirname(process.argv[1]),'spent.json'),own=cfg.spend,[input,output,read,write]=own.tokens;
 const id=flag=>args.includes(flag)?args[args.indexOf(flag)+1]:null,mine=id('--resume')??id('--session-id')??session;
 let all={};try{all=JSON.parse(fs.readFileSync(kept,'utf8'));}catch{}
 const before=id('--resume')&&all[mine]?all[mine]:{},was=before[own.model]??{tokens:[0,0,0,0],usd:0};
 const models={...before,[own.model]:{tokens:was.tokens.map((value,at)=>value+own.tokens[at]),usd:was.usd+own.usd}};fs.writeFileSync(kept,JSON.stringify({...all,[mine]:models}));
 const total=Object.values(models).reduce((sum,line)=>sum+line.usd,0);
 const usage={input_tokens:input,output_tokens:output,cache_read_input_tokens:read,cache_creation_input_tokens:write},print=console.log;
 console.log=text=>{let row=null;try{row=JSON.parse(text);}catch{}
  if(row?.session_id===session)row.session_id=mine;
  print(row?.type==='result'&&!row.is_error?JSON.stringify({...row,total_cost_usd:total,usage,modelUsage:Object.fromEntries(Object.entries(models).map(([model,line])=>[model,{inputTokens:line.tokens[0],outputTokens:line.tokens[1],cacheReadInputTokens:line.tokens[2],cacheCreationInputTokens:line.tokens[3],costUSD:line.usd}]))}):row?JSON.stringify(row):text);};
 print(JSON.stringify({type:'assistant',session_id:mine,message:{id:'msg_spend',model:own.model,usage}}));
}
// An answer turn with permissions has Write in its tools, but a lead that is told ELU prepares the workspace does not edit there.
const edit=(args[args.indexOf('--tools')+1]??'').split(',').some(name=>name==='Write'||name==='default')&&!conversation;
if(edit&&mode==='scaffold'){
 fs.mkdirSync('src',{recursive:true});fs.mkdirSync('test',{recursive:true});
 fs.writeFileSync('test/coupon.test.mjs',"import {test} from 'node:test';import assert from 'node:assert/strict';import {normalize} from '../src/coupon.mjs';test('normalizes coupons',()=>assert.equal(normalize('save'),'SAVE'));\n");
}
// What the real 2.1.322 lists in its init row (capabilities), which is how a host learns what its
// input takes. capabilities (fake.json): another list, or false for a release that names none.
const CAPABILITIES=['interrupt_receipt_v1','interrupt_cancel_queued_v1','interrupt_send_now_v1','interrupt_requeue_taken_v1','msg_lifecycle_v1','request_marker_lists_v1','ask_user_question_unanswered_v1','lifecycle_wakeup_source_v1'];
// The init row comes first, as in the real CLI, before the turn does anything.
const mcpArg=args[args.indexOf('--mcp-config')+1];const servers=!args.includes('--safe-mode')&&mcpArg&&!mcpArg.startsWith('{')&&fs.existsSync(mcpArg)?JSON.parse(fs.readFileSync(mcpArg,'utf8')).mcpServers:{};const mcp=Object.keys(servers).map(name=>({name,status:'connected'}));
// The approval relay's own arguments, one row a run that has it, for tests of what it was told (relays.jsonl beside calls.jsonl).
if(cfg.calls&&servers['elu-code-approval'])fs.appendFileSync(path.join(path.dirname(cfg.calls),'relays.jsonl'),JSON.stringify(servers['elu-code-approval'].args)+'\n');
const permissionMode=args.includes('--permission-mode')?args[args.indexOf('--permission-mode')+1]:'default';
// permissionMode (fake.json): the mode this run says it really got, when that is not the one it was started with.
console.log(JSON.stringify({type:'system',subtype:'init',session_id:session,model:reported,permissionMode:cfg.permissionMode??permissionMode,mcp_servers:mcp,...(cfg.capabilities===false?{}:{capabilities:Array.isArray(cfg.capabilities)?cfg.capabilities:CAPABILITIES})}));
if(cfg.accounts?.limited?.includes(account)){console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,duration_ms:90,num_turns:1,result:"You've hit your session limit · resets 5pm",session_id:session,total_cost_usd:nothingSpent}));process.exit(1);}
const used=cfg.accounts?.usage?.[account]??{fiveHour:0.36,weekly:0.71};
console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{unifiedWindows:{five_hour:{utilization:used.fiveHour,resetsAt:Math.floor(Date.now()/1000)+10800},seven_day:{utilization:used.weekly,resetsAt:Math.floor(Date.now()/1000)+604800}}}}));
console.error('A harmless diagnostic on stderr.');
// The owner's words in a message ELU sent to a running turn (lib/runner.mjs DURING_LEAD), or the message as it is.
const ownerWords=content=>{const found=/Owner message \(untrusted data[^\n]*\n(.*)\nEnd of Owner message\./.exec(content);try{return found?JSON.parse(found[1]).text:content;}catch{return content;}};
const heard=[];const absorbedFile=path.join(path.dirname(process.argv[1]),'absorbed.jsonl');
const caps=cfg.capabilities===false?null:Array.isArray(cfg.capabilities)?cfg.capabilities:CAPABILITIES;const can=name=>Boolean(caps?.includes(name));
const say=row=>console.log(JSON.stringify(row));
// A user message that comes on the input while the turn works waits in a queue, as in the real
// CLI. One sent with a uuid is followed by command_lifecycle rows: queued when it comes, started
// when a turn takes it in (at the turn's next step, or as a turn of its own after the result),
// completed when that turn has answered, cancelled when it was taken back. Each one taken in is
// recorded in absorbed.jsonl beside the fake (mid: true when a running turn took it).
const queue=[],folded=[];let working=null;
const lifecycle=(uuid,state)=>{if(uuid&&can('msg_lifecycle_v1'))say({type:'command_lifecycle',command_uuid:uuid,state,uuid:crypto.randomUUID(),session_id:session});};
const takeQueued=()=>{for(const item of queue.splice(0)){heard.push(ownerWords(item.content));fs.appendFileSync(absorbedFile,JSON.stringify({content:item.content,mid:true,...(item.uuid?{uuid:item.uuid}:{})})+'\n');lifecycle(item.uuid,'started');if(item.uuid)folded.push(item.uuid);}};
// The control requests a host writes on the input, answered as 2.1.322 answers them.
// cancel_async_message takes a message back while it still waits ({cancelled:false} once a turn
// took it). interrupt with send_now sends what waits now: nothing_waiting when nothing does;
// delivering when the command the turn waits on moved to the background, which it does only for
// a person's message (origin.kind human), so the turn goes on and takes the message in; else
// the turn is cut (stopped), its result an error, and the message starts the next turn of this
// same run. A release without interrupt_send_now_v1 reads it as a plain interrupt.
const answer=(id,response)=>say({type:'control_response',response:{subtype:'success',request_id:id,response}});
const control=row=>{
 const request=row.request??{},id=row.request_id,still=()=>queue.map(item=>item.uuid).filter(Boolean);
 fs.appendFileSync(path.join(path.dirname(process.argv[1]),'controls.jsonl'),JSON.stringify(request)+'\n');
 if(request.subtype==='cancel_async_message'){const at=queue.findIndex(item=>item.uuid&&item.uuid===request.message_uuid);if(at>=0)lifecycle(queue.splice(at,1)[0].uuid,'cancelled');return answer(id,{cancelled:at>=0});}
 if(request.subtype==='interrupt'){
  if(request.send_now!==true||!can('interrupt_send_now_v1')){working?.cut();return answer(id,can('interrupt_receipt_v1')?{still_queued:still()}:{});}
  if(!queue.length)return answer(id,{still_queued:[],send_now:'nothing_waiting'});
  if(!working||working.move&&queue.every(item=>item.human)){working?.move();return answer(id,{still_queued:still(),send_now:'delivering'});}
  working.cut();return answer(id,{still_queued:still(),send_now:'stopped'});
 }
 say({type:'control_response',response:{subtype:'error',request_id:id,error:`Unsupported control request subtype: ${request.subtype}`}});
};
const arrive=line=>{let row;try{row=JSON.parse(line);}catch{return false;}
 if(row?.type==='user'&&typeof row.message?.content==='string'){const uuid=typeof row.uuid==='string'?row.uuid:null;queue.push({content:row.message.content,uuid,human:row.origin?.kind==='human'&&row.priority!=='now'});lifecycle(uuid,'queued');return true;}
 if(row?.type==='control_request'){control(row);return true;}
 return false;};
if(streaming){onLine=arrive;for(const line of lines.splice(0))if(!arrive(line))lines.push(line);}
// A wait of the turn that a control request can end early: resolves 'done' after ms, 'moved'
// when the command it stands for went to the background (only where movable), 'cut' when the turn was cut.
const pause=(ms,movable=false)=>new Promise(resolve=>{const end=how=>{clearTimeout(timer);working=null;resolve(how);};const timer=setTimeout(()=>end('done'),ms);working={cut:()=>end('cut'),...(movable?{move:()=>end('moved')}:{})};});
let cutShort=false;
// afterResult: what a stream-json run does after a result line. It ends when its input does, and
// one the host never closes fails the test. A user message that still waits after a result runs
// as one more turn of the same run, as the real CLI runs a queued prompt, with a result line of
// its own. afterMs (fake.json): how long that turn takes.
const afterResult=async()=>{
 if(!streaming)return;
 let timer;const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>{console.error('The input was never closed after the result.');process.exit(3);},10000);};arm();
 for(;;){
  if(queue.length){const item=queue.shift(),words=ownerWords(item.content);lifecycle(item.uuid,'started');fs.appendFileSync(absorbedFile,JSON.stringify({content:item.content,mid:false,...(item.uuid?{uuid:item.uuid}:{})})+'\n');if(cfg.afterMs)await new Promise(resolve=>setTimeout(resolve,cfg.afterMs));say({type:'result',is_error:false,session_id:session,total_cost_usd:0,structured_output:{...result,summary:`Answered what you sent after the turn: ${words}`}});lifecycle(item.uuid,'completed');arm();continue;}
  if(inputEnded)break;
  await wake();
 }
 clearTimeout(timer);
};
if(mode==='slow'){console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Working on the requested change.'}]}}));if(streaming){if(await pause(30000)==='cut')cutShort=true;}else await new Promise(resolve=>setTimeout(resolve,30000));}
// listen: the turn works in steps (steps in fake.json, 8 by default, stepMs apart, 250 by
// default), each a Read call and its result, and takes in what came on its input at each.
if(mode==='listen'&&streaming&&!cutShort){for(let n=0;n<(cfg.steps??8);n++){takeQueued();const id=`toolu_fake_step_${n+1}`;console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id,name:'Read',input:{file_path:'src/coupon.mjs'}}]}}));console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:'export const normalize = (value) => value;'}]}}));if(await pause(cfg.stepMs??250)==='cut'){cutShort=true;break;}}if(!cutShort)takeQueued();}
// command: the turn runs one command that prints nothing for commandMs (fake.json, three
// minutes by default), as a long test run or a sleep does. Nothing is taken in while it runs:
// a message that comes waits for the command to end. Sent now, the command moves to the
// background and the turn goes on, with the result the real CLI gives the model for it.
if(mode==='command'&&streaming&&!cutShort){
 const id='toolu_fake_command',command=cfg.command??'sleep 180';takeQueued();
 say({type:'assistant',message:{content:[{type:'tool_use',id,name:'Bash',input:{command,description:'Wait for it'}}]}});
 const how=await pause(cfg.commandMs??180000,true);
 if(how==='cut')cutShort=true;
 else{say({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:how==='moved'?'Command was moved to the background (ID: bash_1) so that a message that arrived while it was running can reach you; it was not interrupted. Output is being written to: /tmp/claude-fake/tasks/bash_1.output.':'(no output)'}]}});takeQueued();}
}
// A turn that was cut ends as the real CLI ends one, with an error result, and the run goes on with what waits.
if(cutShort){say({type:'result',subtype:'error_during_execution',is_error:true,session_id:session,total_cost_usd:0});await afterResult();process.exit(0);}
if(mode==='slow-answer')await new Promise(resolve=>setTimeout(resolve,250));
if(edit&&mode==='protected')fs.appendFileSync('package.json',' ');
else if(edit&&mode!=='no-change')fs.writeFileSync('src/coupon.mjs','export const normalize = (value) => value.toUpperCase();\n');
// install (fake.json): what an editing turn also leaves in its worktree. true: what npm install
// leaves, an ignored node_modules with a link in .bin, a 5 MB file and 20,000 small files, a
// Python cache, and what pip install -e and pytest-cov leave (egg-info, .coverage, htmlcov);
// 'link': a link that is not ignored.
if(edit&&cfg.install===true&&!fs.existsSync('node_modules/pkg')){
 fs.mkdirSync('node_modules/.bin',{recursive:true});fs.mkdirSync('node_modules/pkg',{recursive:true});fs.writeFileSync('node_modules/pkg/cli.js','#!/usr/bin/env node\n');fs.symlinkSync('../pkg/cli.js','node_modules/.bin/pkg');
 fs.writeFileSync('node_modules/pkg/big.bin',Buffer.alloc(5*1024*1024,1));
 for(let dir=0;dir<20;dir++){fs.mkdirSync(`node_modules/pkg/files/${dir}`,{recursive:true});for(let n=0;n<1000;n++)fs.writeFileSync(`node_modules/pkg/files/${dir}/${n}.js`,`module.exports=${n};\n`);}
 fs.mkdirSync('src/__pycache__',{recursive:true});fs.writeFileSync('src/__pycache__/coupon.cpython-313.pyc',Buffer.from([0,1,2]));
 fs.mkdirSync('coupon.egg-info',{recursive:true});fs.writeFileSync('coupon.egg-info/PKG-INFO','Name: coupon\n');
 fs.writeFileSync('.coverage',Buffer.from([0,1,2]));fs.mkdirSync('htmlcov',{recursive:true});fs.writeFileSync('htmlcov/index.html','<p>100%</p>\n');
}
if(edit&&cfg.install==='link'){try{fs.lstatSync('tool-link');}catch{fs.symlinkSync('src/coupon.mjs','tool-link');}}
// insert (fake.json): { file, at, text }, lines an editing turn also puts in that file after line at, once.
if(edit&&cfg.insert){const {file,at,text}=cfg.insert;const lines=fs.readFileSync(file,'utf8').split('\n');if(!lines.includes(text.split('\n')[0]))fs.writeFileSync(file,[...lines.slice(0,at),text,...lines.slice(at)].join('\n'));}
if(edit&&(input.includes('Trim spaces')||cfg.next&&continued))fs.writeFileSync('src/coupon.mjs','export const normalize = (value) => value.trim().toUpperCase();\n');
// commit (fake.json): an editing turn commits its own work with Git, as an agent that was told
// to commit does. 'once': one commit of everything it changed. 'twice': a second commit after
// it. 'amend': the commit, then that commit amended. 'branch': a new branch first, and the
// commit there. 'dirty': the commit, then one more edit that it leaves uncommitted. 'push':
// the commit, then a push to origin. A turn that changed nothing since commits nothing.
if(edit&&cfg.commit){
 const {spawnSync}=await import('node:child_process');
 const run=(...args)=>{const r=spawnSync('git',['-c','user.name=Agent','-c','user.email=agent@example.invalid',...args],{encoding:'utf8'});if(r.status!==0)throw new Error(`git ${args.join(' ')}: ${r.stderr}`);return r.stdout;};
 const save=(message,...more)=>{run('add','-A');if(more.length||run('status','--porcelain').trim())run('commit','-q',...more,'-m',message);};
 if(cfg.commit==='branch'&&run('branch','--show-current').trim()!=='agent/coupons')run('checkout','-q','-b','agent/coupons');
 save('Normalize coupons');
 if(cfg.commit==='twice'){fs.writeFileSync('notes.md','Coupons are upper case.\n');save('Add notes');}
 if(cfg.commit==='amend'){fs.writeFileSync('notes.md','Coupons are upper case.\n');save('Normalize coupons, with notes','--amend');}
 if(cfg.commit==='dirty')fs.writeFileSync('notes.md','Not committed yet.\n');
 if(cfg.commit==='push')run('push','-q','origin','HEAD');
}
// A command of this turn as the real CLI prints it: the call, then its result, with the exit code when it failed.
const step=async(id,command)=>{const {spawnSync}=await import('node:child_process');say({type:'assistant',message:{content:[{type:'tool_use',id,name:'Bash',input:{command,description:'Run it'}}]}});const r=spawnSync('/bin/sh',['-c',command],{encoding:'utf8'}),out=`${r.stdout}${r.stderr}`;say({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:r.status===0?out||'(no output)':`Exit code ${r.status}\n${out}`,...(r.status===0?{}:{is_error:true})}]}});return r.status===0;};
if(opsRun)await step('toolu_fake_ops','node --check src/coupon.mjs');
// failStep (fake.json): the editing turn's first command fails, because the folder it writes to
// is missing. The stand-in then does what its prompt says, as a model does. Told that a failed
// step is its own to fix, it makes the folder and runs the command again. Told not to retry
// another way when an action is blocked, it stops and asks, as models told so did.
if(cfg.failStep&&edit){
 const copy='cp src/coupon.mjs out/coupon.copy.mjs';
 if(!await step('toolu_fake_fail_1',copy)){
  if(input.includes('A step that fails is yours to fix')){await step('toolu_fake_fail_2',`mkdir -p out && ${copy}`);result.summary='The out folder was missing, so the copy failed. Made the folder and copied the file.';}
  else{result.outcome='needs_input';result.question='The copy failed: the out folder is missing. I was told not to retry another way. Should I create it?';result.choices=['Create it','Stop'];}
 }
}
// asksNext (fake.json): what the editing turn does when its work is done. Told to report and end,
// it does; not told, it asks what to do next and offers choices, as models did.
if(cfg.asksNext&&edit&&result.outcome==='done'&&!input.includes('do not ask what to do next')){result.outcome='needs_input';result.question='What would you like next?';result.choices=['Add tests','Open a pull request','Nothing'];}
// chatty: keeps printing, a line every 200 ms for ticks (fake.json, 15 by default), longer than
// a test's quiet limit, then finishes. stall: an edit turn makes its edit, prints one line and
// then prints nothing for a minute, as a turn that stopped working does.
if(mode==='chatty')for(let n=0;n<(cfg.ticks??15);n++){console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:`Still working (${n}).`}]}}));await new Promise(resolve=>setTimeout(resolve,200));}
// live (fake.json): a file; a working turn keeps a to-do list as the real one does, and goes on once that file exists.
// Claude Code 2.1.322 has no to-do tool in a run unless --tools names one; named, it has the Task tools. A step is made
// with TaskCreate, whose result gives its number, and changed with TaskUpdate by that number. The list is kept with the
// session under the config folder: a new session starts with none, and a later turn of a session finishes the steps an
// earlier one left open and makes none again. liveAsks: the turn that makes the list stops on a question with its
// second step still in hand. liveTool 'todowrite': an older Claude Code, which sends the whole list in one TodoWrite call.
const todoTools=(args[args.indexOf('--tools')+1]??'').split(',').filter(name=>['TaskCreate','TaskUpdate','TaskList','TaskGet','TodoWrite'].includes(name));
const liveGate=async()=>{const until=Date.now()+30000;while(!fs.existsSync(cfg.live)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,50));};
if(cfg.live&&todoTools.includes('TaskCreate')&&cfg.liveTool!=='todowrite'){
 const listDir=path.join(process.env.CLAUDE_CONFIG_DIR??path.join(process.env.HOME??'','.claude'),'tasks',session);if(!resumed)fs.rmSync(listDir,{recursive:true,force:true});fs.mkdirSync(listDir,{recursive:true});
 const kept=()=>fs.readdirSync(listDir).filter(name=>/^\d+\.json$/.test(name)).map(name=>JSON.parse(fs.readFileSync(path.join(listDir,name),'utf8'))).sort((a,b)=>a.id-b.id);
 let calls=0;const say=row=>console.log(JSON.stringify({...row,parent_tool_use_id:null,session_id:session}));
 const call=(name,input,content,tool_use_result)=>{const id=`toolu_fake_${process.pid}_${++calls}`;say({type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id,name,input}]}});say({type:'user',message:{role:'user',content:[{tool_use_id:id,type:'tool_result',content}]},tool_use_result});};
 const create=(subject,description)=>{const id=String(Math.max(0,...kept().map(task=>Number(task.id)))+1);fs.writeFileSync(path.join(listDir,`${id}.json`),JSON.stringify({id,subject,description,status:'pending',blocks:[],blockedBy:[]}));call('TaskCreate',{subject,description,activeForm:`Doing: ${subject}`},`Task #${id} created successfully: ${subject}`,{task:{id,subject,description}});return id;};
 const update=(taskId,status)=>{const file=path.join(listDir,`${taskId}.json`),task=JSON.parse(fs.readFileSync(file,'utf8'));fs.writeFileSync(file,JSON.stringify({...task,status}));call('TaskUpdate',{taskId,status},`Updated task #${taskId} status`,{success:true,taskId,updatedFields:['status'],statusChange:{from:task.status,to:status}});};
 const open=kept().filter(task=>task.status!=='completed');
 if(open.length){for(const task of open)update(task.id,'completed');await liveGate();}
 else{
  const first=create('Change normalize','Return the code in upper case.'),second=create('Run the coupon test','Run the test file.');update(first,'in_progress');update(first,'completed');update(second,'in_progress');await liveGate();
  if(cfg.liveAsks){Object.assign(result,{outcome:'needs_input',question:'Run the long test too?',choices:['Yes','No']});if(result.subtasks){result.subtasks=[{text:'Change normalize',state:'done'},{text:'Run the coupon test',state:'doing'}];result.objectivesMet=[1];}}
  else update(second,'completed');
 }
}
else if(cfg.live&&todoTools.includes('TodoWrite')&&cfg.liveTool==='todowrite'){console.log(JSON.stringify({type:'assistant',parent_tool_use_id:null,message:{content:[{type:'tool_use',id:'toolu_fake_todo',name:'TodoWrite',input:{todos:[{content:'Change normalize',status:'completed',activeForm:'Changing normalize'},{content:'Run the coupon test',status:'in_progress',activeForm:'Running the coupon test'}]}}]}}));await liveGate();}
if(mode==='stall'&&edit){console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Edited the file. Thinking.'}]}}));await new Promise(resolve=>setTimeout(resolve,60000));}
// quiet (fake.json): a turn prints one line and then nothing for a minute, as one that stopped working does, an answering
// turn as an editing one. 'always': every launch. 'once': not the launch ELU starts in its place, which is told that the
// turn before it printed nothing: that one goes on to its answer.
if(cfg.quiet&&(cfg.quiet==='always'||!input.includes('ELU stopped it and started this one in its place'))){console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Reading the code. Thinking.'}]}}));await new Promise(resolve=>setTimeout(resolve,60000));}
if(mode==='question'&&!args.includes('--resume')&&!input.includes('Uppercase')){result.outcome='needs_input';result.question='Which format?';result.choices=['Uppercase','Lowercase'];}
if((mode==='review-fix'||mode==='review-block')&&input.includes('Address the review')){result.responses=[{id:'R1',action:mode==='review-fix'?'fixed':'disputed',reason:mode==='review-fix'?'Handled the edge case.':'The finding still needs owner input.'}];}
// steps (mode): a turn that shows its work as the real CLI writes it without partial messages:
// one assistant row per block. A thinking block carries its text only with --thinking-display
// summarized; without it the text is empty, as Claude Code's default (omitted) sends it. gate
// (fake.json): a file the turn waits for while its command runs, so a test sees it running.
if(mode==='steps'){
 const shown=args.includes('--thinking-display')&&args[args.indexOf('--thinking-display')+1]==='summarized';
 const say=content=>console.log(JSON.stringify({type:'assistant',message:{id:'msg_fake',role:'assistant',content:[content]},parent_tool_use_id:null,session_id:session}));
 const done=(id,content,error=false)=>console.log(JSON.stringify({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:id,content,...(error?{is_error:true}:{})}]},parent_tool_use_id:null,session_id:session}));
 say({type:'thinking',thinking:shown?'The coupon code should compare in upper case. I will read the module first.':'',signature:'sig-fake'});
 say({type:'tool_use',id:'toolu_read',name:'Read',input:{file_path:path.join(process.cwd(),'src','coupon.mjs')}});done('toolu_read','export const normalize = code => code;');
 say({type:'tool_use',id:'toolu_test',name:'Bash',input:{command:'npm test',description:'Run the tests'}});
 if(cfg.gate){while(!fs.existsSync(cfg.gate))await new Promise(resolve=>setTimeout(resolve,20));}
 done('toolu_test','Exit code 1\nnot ok 1 - normalizes coupons',true);
 say({type:'text',text:'The test fails on lower case codes. Fixing normalize.'});
 say({type:'tool_use',id:'toolu_reply',name:'StructuredOutput',input:result});done('toolu_reply','Structured output provided successfully');
}
// live (mode): a long turn as Claude Code 2.1.322 writes it (the shapes of its real logs, with
// made-up content). It counts a thought's tokens while it thinks (system/thinking_tokens) and
// sends the thought with no text; only with live.text and --thinking-display summarized does
// the text come. It starts one command in the background (task_started with is_backgrounded,
// background_tasks_changed), then one that prints nothing for live.seconds (180), with a
// tool_progress row every 30 seconds whose id is the call's with -heartbeat-N, and ends both
// (task_notification, task_updated). live.speed: how many times faster than the clock the
// silent command goes, for a test. live.think: how long it thinks, in ms. gate (fake.json): a
// file the turn waits for before its command ends.
if(mode==='live'){
 const live=cfg.live??{},speed=live.speed??1,uuid=()=>crypto.randomUUID(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const row=value=>console.log(JSON.stringify(value));
 const say=content=>row({type:'assistant',message:{id:'msg_fake',role:'assistant',content:[content]},parent_tool_use_id:null,session_id:session,uuid:uuid()});
 const done=(id,content)=>row({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:id,content}]},parent_tool_use_id:null,session_id:session,uuid:uuid()});
 const system=(subtype,fields)=>row({type:'system',subtype,...fields,uuid:uuid(),session_id:session});
 const shown=live.text===true&&args.includes('--thinking-display')&&args[args.indexOf('--thinking-display')+1]==='summarized';
 const target=live.tokens??1240,parts=8;let counted=0;
 for(let n=0;n<parts;n++){const next=n===parts-1?target:50+Math.round((target-50)*n/(parts-1));row({type:'system',subtype:'thinking_tokens',estimated_tokens:next,estimated_tokens_delta:next-counted,session_id:session,uuid:uuid()});counted=next;await sleep((live.think??400)/parts);}
 say({type:'thinking',thinking:shown?'The coupon tests take a while. I will start the watcher, then run them.':'',signature:'sig-fake'});
 say({type:'text',text:'Starting the watcher, then the tests.'});
 const watch='toolu_01FakeWatch000000000000000',tests='toolu_01FakeTests000000000000000',watching={task_id:'bfakewtch',run_id:'0fakewtch-00000001'},testing={task_id:'bfaketest',run_id:'0faketest-00000001'};
 say({type:'tool_use',id:watch,name:'Bash',input:{command:'npm run watch',description:'Start the watcher',run_in_background:true}});
 system('task_started',{...watching,tool_use_id:watch,description:'npm run watch',is_backgrounded:true,task_type:'local_bash'});
 done(watch,'Command running in background with ID: bfakewtch');
 system('background_tasks_changed',{tasks:[{...watching,task_type:'local_bash',description:'npm run watch'}]});
 say({type:'tool_use',id:tests,name:'Bash',input:{command:'npm test',description:'Run the tests'}});
 system('task_started',{...testing,tool_use_id:tests,description:'npm test',is_backgrounded:false,task_type:'local_bash'});
 for(let n=0;(n+1)*30<=(live.seconds??180);n++){await sleep(30000/speed);row({type:'tool_progress',tool_use_id:`${tests}-heartbeat-${n}`,tool_name:'Bash',parent_tool_use_id:tests,elapsed_time_seconds:(n+1)*30,heartbeat:true,session_id:session,uuid:uuid()});}
 if(cfg.gate){while(!fs.existsSync(cfg.gate))await sleep(20);}
 system('task_notification',{...testing,tool_use_id:tests,status:'completed',output_file:'',summary:'npm test'});
 done(tests,'ok 1 - normalizes coupons');
 system('task_updated',{...watching,patch:{status:'completed',end_time:Date.now()}});
 system('background_tasks_changed',{tasks:[]});
 say({type:'tool_use',id:'toolu_reply',name:'StructuredOutput',input:result});done('toolu_reply','Structured output provided successfully');
}
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
// read once, then the command. The tool call is printed before the command runs and its
// result after, as the real CLI prints them, with nothing between however long it takes.
// A command that fails is shown with its exit code.
// note (fake.json): the real CLI writes a note of its working folder after each command, in
// <CLAUDE_CODE_TMPDIR, or /tmp>/claude-<uid>, and goes back to /tmp when that path is longer
// than 44 bytes. Its sandbox, as ELU sets it for every mode but Full access, denies writes
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
 cfg.commands.forEach((command,i)=>{const id=`toolu_fake_${i+1}`;const script=['-c',`PATH="/usr/bin:/bin:$PATH"\n${ahead}\neval "$1"`,'sh',command];console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id,name:'Bash',input:{command,description:'Run it'}}]}}));const r=fenced?spawnSync('bwrap',[...fenceArgs(sandbox.filesystem??{}),'/bin/sh',...script],{env:process.env,encoding:'utf8'}):spawnSync('/bin/sh',script,{env:process.env,encoding:'utf8'});const denied=noted(i+1);if(denied&&r.status===0)r.status=1;const out=`${r.stdout}${r.stderr}${denied}`;
  console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:r.status===0?out:`Exit code ${r.status}\n${out}`,...(r.status===0?{}:{is_error:true})}]}}));});
}
// shell (fake.json): what the model runs when the message the turn answers asks for it, as a model
// told of ELU's own commands does: each { when, run }, its commands run when the owner's last
// message (a schedule's too) holds when. Each runs as commands above do, after CLAUDE_ENV_FILE,
// with the turn's own environment; the reply says what each printed. Each one is recorded in
// shell.jsonl beside the fake, with the session and project ELU named to the turn.
if(Array.isArray(cfg.shell)&&promptTool){
 const {spawnSync}=await import('node:child_process');const named=process.env.CLAUDE_ENV_FILE;const ahead=named&&fs.existsSync(named)?fs.readFileSync(named,'utf8').trim():'';
 const said=lastOwner||(()=>{try{return String(JSON.parse(/\nTask goal \(untrusted data[^\n]*\n(.*)\nEnd of Task goal\./.exec(input)[1]));}catch{return '';}})();const outs=[];
 for(const [n,ask] of cfg.shell.entries()){if(!said.includes(ask.when))continue;for(const [i,command] of ask.run.entries()){
  const id=`toolu_fake_shell_${n+1}_${i+1}`;console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id,name:'Bash',input:{command,description:'Run it'}}]}}));
  const r=spawnSync('/bin/sh',['-c',`PATH="/usr/bin:/bin:$PATH"\n${ahead}\neval "$1"`,'sh',command],{env:process.env,encoding:'utf8'});const out=`${r.stdout??''}${r.stderr??''}`.trim();
  console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:id,content:r.status===0?out:`Exit code ${r.status}\n${out}`,...(r.status===0?{}:{is_error:true})}]}}));
  fs.appendFileSync(path.join(path.dirname(process.argv[1]),'shell.jsonl'),JSON.stringify({command,status:r.status,out,session:process.env.ELU_SESSION??null,project:process.env.ELU_PROJECT??null})+'\n');outs.push(`${command}: ${out}`);
 }}
 if(outs.length&&typeof result.summary==='string')result.summary=`${result.summary}\n${outs.join('\n')}`;
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
// hostAsks (fake.json): what this turn asks its host on its own output, each { tool_name, input }
// as a can_use_tool control request, whatever its mode; the answer is read on its input. Each
// answer is recorded in host-asks.jsonl beside the fake, and a refused one is a denial of the result.
if(Array.isArray(cfg.hostAsks)&&streaming){let n=0;for(const ask of cfg.hostAsks){
 const id=`req_fake_host_${++n}`,use=`toolu_fake_host_${n}`;
 say({type:'control_request',request_id:id,request:{subtype:'can_use_tool',tool_name:ask.tool_name,input:ask.input,permission_suggestions:[],tool_use_id:use,description:`Allow ${ask.tool_name}?`}});
 let reply=null;for(;;){const line=await nextLine();if(line===null)break;let row;try{row=JSON.parse(line);}catch{continue;}if(row.type==='control_response'&&row.response?.request_id===id){reply=row.response;break;}}
 const allowed=reply?.subtype==='success'&&reply.response?.behavior==='allow';
 fs.appendFileSync(path.join(path.dirname(process.argv[1]),'host-asks.jsonl'),JSON.stringify({tool_name:ask.tool_name,allowed,reply})+'\n');
 if(!allowed)denials.push({tool_name:ask.tool_name,tool_use_id:use,tool_input:ask.input});
}}
// asksInFull (fake.json): the turn asks through the relay in bypassPermissions too, as the real CLI
// still does there for some writes. An ask with work: true is asked only by an editing turn, and one
// with run: true is a shell command the turn really runs once it is allowed.
if(mode==='relay'&&promptTool&&(permissionMode!=='bypassPermissions'||cfg.asksInFull)){
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
 const asks=Array.isArray(cfg.asks)?cfg.asks.filter(ask=>!ask.work||edit).map((ask,i)=>({...ask,id:`toolu_fake_ask_${i+1}`})):[{tool_name:'Bash',input:{command:`touch ${target}`},id:'toolu_fake_touch',touch:true}];
 for(const ask of asks){
  const reply=await call('tools/call',{name:promptTool.split('__')[2],arguments:{tool_name:ask.tool_name,input:ask.input,tool_use_id:ask.id},_meta:{progressToken:1}});
  const decision=JSON.parse(reply.result.content[0].text);
  if(decision.behavior==='allow'){if(ask.touch)fs.writeFileSync(target,'');else fs.appendFileSync(path.join(path.dirname(process.argv[1]),'ran.jsonl'),JSON.stringify(ask.input)+'\n');if(ask.run){const {spawnSync}=await import('node:child_process');spawnSync('/bin/sh',['-c',ask.input.command],{encoding:'utf8'});}}
  else{denials.push({tool_name:ask.tool_name,tool_use_id:ask.id,tool_input:ask.input});
   // tells (fake.json): the turn does what the denial says. Told that nobody declined the call, it goes on and says what still waits; told no, it stops and asks.
   if(cfg.tells){const what=ask.input?.command??ask.tool_name;if(/Go on with the work that does not need it/.test(decision.message??''))result.summary=`Did the rest. Still waits for your answer: ${what}.`;else{result.outcome='needs_input';result.question=`I needed this and it was not allowed: ${what}.`;result.choices=[];}}}
  if(cfg.calls)fs.appendFileSync(cfg.calls,JSON.stringify({vendor,args:[],approval:{tools,decision,progress:progress.length}})+'\n');
 }
 child.stdin.end();
}
// background (fake.json): the turn starts a command in the background and ends asking a
// question; as the real CLI does, it then stays open while that command runs (background.pid
// beside the fake names it).
const BACKGROUND='for i in $(seq 1 110); do sleep 60; done';
if(cfg.background){console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'toolu_fake_bg',name:'Bash',input:{command:BACKGROUND,description:'Watch the deploy',run_in_background:true}}]}}));console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'toolu_fake_bg',content:'Command running in background with ID: bfake1. Output is being written to: /tmp/bfake1.output'}]}}));result.outcome='needs_input';result.question='Is the deploy still running?';result.choices=[];}
// blocked (fake.json): the question this turn ends on, as a model does when something it needed was refused.
if(cfg.blocked){result.outcome='needs_input';result.question=cfg.blocked;result.choices=[];}
if(heard.length&&typeof result.summary==='string')result.summary=`${result.summary} Also took in what you sent while it worked: ${heard.join(' | ')}`;
// A message the turn took in is completed before the turn's result line.
for(const uuid of folded.splice(0))lifecycle(uuid,'completed');
console.log(JSON.stringify({type:'result',is_error:false,session_id:session,total_cost_usd:0,...(denials.length?{permission_denials:denials}:{}),structured_output:mode==='invalid'||badReply?{outcome:'nope'}:result}));
// A stream-json run ends when its input does; one the runner never closes fails the test.
await afterResult();
if(cfg.background){const {spawn}=await import('node:child_process');const child=spawn('/bin/sh',['-c',BACKGROUND],{stdio:'ignore'});fs.writeFileSync(path.join(path.dirname(process.argv[1]),'background.pid'),String(child.pid));await new Promise(resolve=>child.once('exit',resolve));}
