import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';
import{parse as parseCodex,classify as codexCause,compile as codexCompile}from'../lib/adapters/codex.mjs';import{parse as parseClaude,classify as claudeCause}from'../lib/adapters/claude.mjs';import{botRole}from'../lib/bots.mjs';import{prBody}from'../lib/publish.mjs';import{temp}from'./helpers.mjs';
test('Codex warnings and todo lists are accepted while execution items still refuse',()=>{
 const base=fs.readFileSync(new URL('./fixtures/codex.jsonl',import.meta.url),'utf8');const warning='{"type":"item.completed","item":{"type":"error","message":"Non-fatal warning"}}\n';const todo='{"type":"item.completed","item":{"type":"todo_list","items":[]}}\n';assert.equal(parseCodex(warning+todo+base).result.outcome,'done');
 for(const type of['command_execution','file_change','mcp_tool_call','web_search'])assert.throws(()=>parseCodex(JSON.stringify({type:'item.completed',item:{type}})+'\n'+base));
 assert.equal(parseCodex(fs.readFileSync(new URL('./fixtures/native-codex.jsonl',import.meta.url),'utf8')).result.outcome,'done');assert.equal(parseClaude(fs.readFileSync(new URL('./fixtures/native-claude.jsonl',import.meta.url),'utf8')).result.outcome,'done');
});
test('quota classification uses vendor failure events rather than repository text',()=>{
 for(const message of['Opus limit','monthly spend limit','Credit balance is too low'])assert.equal(claudeCause(JSON.stringify({type:'result',is_error:true,result:message})),'quota');
 assert.equal(claudeCause(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Credit balance is too low'}]}})),'unknown');
 assert.equal(codexCause(JSON.stringify({type:'turn.failed',error:{message:'You have hit your usage limit',code:'usage_limit_reached'}})),'quota');
 assert.equal(codexCause(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'You have hit your usage limit'}})),'unknown');
});
test('Codex disables other tools and does not pass removed settings',(t)=>{
 const args=codexCompile({role:botRole({vendor:'codex'}),cwd:temp(t),schemaFile:'schema.json'});assert.ok(args.includes('features.image_generation=false'));assert.ok(args.includes('features.computer_use=false'));assert.ok(args.includes('features.code_mode=false'));assert.ok(args.includes('tools.experimental_request_user_input.enabled=false'));assert.ok(args.includes('tools.update_plan.enabled=false'));assert.ok(!args.some(x=>/js_repl|use_legacy_landlock/.test(x)));
});
test('the draft body describes the resulting change and redacts its summary',()=>{
 const body=prBody({goal:'Fix coupons',result:{summary:'Normalize coupon casing; api_key=private-value'},responses:[],evidence:{results:[],changedLines:1}});assert.match(body,/Normalize coupon casing/);assert.doesNotMatch(body,/private-value/);
});
