import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const client=new Client({name:'term-dad-live-test',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:['dist/index.js'],stderr:'inherit'});
const call=async(name:string,args:Record<string,unknown>={})=>{const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,JSON.stringify(result));return JSON.parse((result.content as any)[0].text);};
let agentId:string|undefined,split:number|undefined;
try{
 await client.connect(transport);
 const before=await call('terminal.list');assert.ok(before.length>0,'A live WezTerm GUI is required');
 const a=await call('agent.spawn',{name:'term-dad-live-shell',cli:'shell',paneId:before[0].pane_id,cwd:process.cwd(),command:['bash','--noprofile','--norc','-i'],prompt:"printf '\\nTERM_DAD_%s\\n' FIRST"});agentId=a.agentId;
 await call('agent.wait_for_text',{agentId,text:'TERM_DAD_FIRST',timeoutMs:15000});
 const first=await call('agent.observe',{agentId});assert.equal(first.paneId,a.paneId);
 await call('agent.send',{agentId,text:"printf '\\nTERM_DAD_%s\\n' FOLLOWUP"});
 const follow=await call('agent.wait_for_text',{agentId,text:'TERM_DAD_FOLLOWUP',timeoutMs:15000});assert.ok(follow.recentText.includes('TERM_DAD_FOLLOWUP'));
 split=await call('terminal.split',{paneId:a.paneId,direction:'right',percent:30,command:['bash','--noprofile','--norc','-i']});
 await call('terminal.resize',{paneId:split,direction:'Left',amount:2});await call('terminal.focus',{target:'pane',id:split});await call('terminal.move',{paneId:split});
 await call('terminal.close',{target:'pane',id:split});split=undefined;
 await call('agent.send',{agentId,text:'sleep 30'});await call('agent.interrupt',{agentId});
 await call('agent.wait_until_idle',{agentId,timeoutMs:15000});
 await call('agent.stop',{agentId});agentId=undefined;
 assert.equal((await call('terminal.list')).length,before.length);
 console.log('PASS: live MCP spawn, shell readiness, initial/follow-up input, output, split, resize, focus, move, interrupt and cleanup');
}finally{if(split!==undefined)await call('terminal.close',{target:'pane',id:split}).catch(console.error);if(agentId)await call('agent.stop',{agentId}).catch(console.error);await client.close();}
