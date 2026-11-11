import http from 'node:http';
export const answer={outcome:'done',summary:'Synthetic permission check.',question:null,choices:[],comments:[],responses:[]};
export async function scriptedProvider(vendor,steps){
 const requests=[];let cursor=0;
 const server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{};requests.push({url:req.url,body});
  if(req.url.includes('count_tokens')){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"input_tokens":1}');return;}
  if(!req.url.includes('messages')&&!req.url.includes('responses')){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const send=(type,data)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);
  if(vendor==='claude'){
   const step=cursor<steps.length?steps[cursor++]:null;
   const structured=body.tools?.some(t=>t.name==='StructuredOutput');
   const block=step?{type:'tool_use',id:`toolu_${cursor}`,name:step.name,input:step.input}:structured?{type:'tool_use',id:'toolu_final',name:'StructuredOutput',input:answer}:{type:'text',text:JSON.stringify(answer)};
   send('message_start',{message:{id:`msg_${requests.length}`,type:'message',role:'assistant',model:body.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:1}}});
   send('content_block_start',{index:0,content_block:block.type==='tool_use'?{...block,input:{}}:{type:'text',text:''}});
   send('content_block_delta',{index:0,delta:block.type==='tool_use'?{type:'input_json_delta',partial_json:JSON.stringify(block.input)}:{type:'text_delta',text:block.text}});
   send('content_block_stop',{index:0});send('message_delta',{delta:{stop_reason:block.type==='tool_use'?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:1}});send('message_stop',{});
  }else{
   const step=cursor<steps.length?steps[cursor++]:null;
   const item=step?{id:`fc_${cursor}`,type:'function_call',call_id:`call_${cursor}`,name:step.name,arguments:JSON.stringify(step.input),status:'completed'}:{id:'msg_final',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(answer),annotations:[]}]};
   send('response.created',{response:{id:`resp_${requests.length}`,object:'response',status:'in_progress',output:[]}});
   send('response.output_item.added',{output_index:0,item:step?{...item,arguments:'',status:'in_progress'}:{...item,status:'in_progress',content:[]}});
   if(step)send('response.function_call_arguments.delta',{output_index:0,item_id:item.id,delta:item.arguments});
   else send('response.output_text.delta',{output_index:0,content_index:0,item_id:item.id,delta:JSON.stringify(answer)});
   send('response.output_item.done',{output_index:0,item});
   send('response.completed',{response:{id:`resp_${requests.length}`,object:'response',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});
  }
  res.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return{url:`http://127.0.0.1:${server.address().port}`,requests,get calls(){return cursor;},close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
