import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {writeFile} from 'node:fs/promises';
const cli=process.argv[2]??'claude';
if(!['claude','codex'].includes(cli))throw new Error('Choose claude or codex');
const client=new Client({name:'term-dad-agent-e2e',version:'1'});
const call=async(name:string,args:Record<string,unknown>={})=>{const r=await client.callTool({name,arguments:args},undefined,{timeout:150000});if(r.isError)throw new Error(JSON.stringify(r));return JSON.parse((r.content as any)[0].text);};
let agentId:string|undefined;
try{
 await client.connect(new StdioClientTransport({command:`${process.cwd()}/scripts/launch-local`,env:{...process.env} as Record<string,string>,stderr:'inherit'}));
 const panes=await call('terminal.list');
 const a=await call('agent.spawn',{name:`term-dad-${cli}-e2e`,cli,paneId:panes[0].pane_id,cwd:process.cwd(),prompt:'This is a terminal transport smoke test. Do not use tools or modify files. Reply with just the concatenation of TERM_DAD_ and FIRST_OK.',timeoutMs:30000});agentId=a.agentId;
 const first=await call('agent.wait_for_text',{agentId,text:'TERM_DAD_FIRST_OK',timeoutMs:120000});
 await call('agent.wait_until_idle',{agentId,timeoutMs:30000});
 await writeFile(`tests/fixtures/${cli}-ready.txt`,first.recentText.split('\n').map((line:string)=>line.trimEnd()).join('\n')+'\n');
 await call('agent.send',{agentId,text:'Follow-up transport test in this same session. Do not use tools. Reply with just the concatenation of TERM_DAD_ and SECOND_OK.'});
 const second=await call('agent.wait_for_text',{agentId,text:'TERM_DAD_SECOND_OK',timeoutMs:120000});assert.equal(second.paneId,a.paneId);
 await call('agent.wait_until_idle',{agentId,timeoutMs:30000});
 await call('agent.interrupt',{agentId});await call('agent.stop',{agentId});agentId=undefined;
 console.log(`PASS: real ${cli} MCP spawn, readiness, initial answer, follow-up in same session, observe, interrupt, stop`);
}finally{if(agentId)await call('agent.stop',{agentId}).catch(console.error);else {const remaining=await call('orchestrator.status').catch(()=>[]);for(const worker of remaining)await call('agent.stop',{agentId:worker.agentId}).catch(()=>{});}await client.close();}
