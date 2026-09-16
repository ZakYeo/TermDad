import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const directory=await mkdtemp(join(tmpdir(),'term-dad-live-recovery-'));
async function connect(){
 const client=new Client({name:'term-dad-live-recovery',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env:{...process.env,TERM_DAD_STATE_DIR:directory} as Record<string,string>,stderr:'inherit'}));
 const call=async(name:string,args:Record<string,unknown>={})=>{const result=await client.callTool({name,arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result));return JSON.parse((result.content as {text:string}[])[0].text);};
 return {client,call};
}
let app=await connect();const owned=new Set<number>();
try{
 const panes=await app.call('terminal.list');assert.ok(panes.length,'Running WezTerm GUI required');
 const parent=process.env.TERM_DAD_TEST_PANE?Number(process.env.TERM_DAD_TEST_PANE):panes[0].pane_id;
 const worker=await app.call('agent.spawn',{name:'recovery-shell',cli:'shell',paneId:parent,command:['bash','--noprofile','--norc','-i']});owned.add(worker.paneId);
 const task=await app.call('task.create',{boardId:'live-recovery',title:'Verify recovered shell',goal:'Preserve assignment across MCP restart',assignedAgentId:worker.agentId,acceptanceCriteria:[{id:'follow-up',description:'Follow-up marker observed after restart'}]});
 assert.equal((await app.call('agent.list'))[0].tasks.items[0].id,task.id);
 await app.call('agent.wait_until_idle',{agentId:worker.agentId,timeoutMs:15000});
 await app.call('agent.send',{agentId:worker.agentId,text:"printf '\\nTERM_DAD_%s\\n' BEFORE_RESTART"});
 const old=await app.call('agent.wait_for_text',{agentId:worker.agentId,text:'TERM_DAD_BEFORE_RESTART',timeoutMs:15000});
 await app.client.close();app=await connect();
 const savedTask=await app.call('task.get',{taskId:task.id});assert.equal(savedTask.assignedAgentId,worker.agentId);assert.equal(savedTask.assignment.availability,'attached');assert.equal(savedTask.status,'todo');
 const recovered=(await app.call('agent.list'))[0];assert.equal(recovered.agentId,worker.agentId);assert.equal(recovered.paneId,worker.paneId);assert.equal(recovered.attachment,'attached');
 assert.equal((await app.call('agent.observe',{agentId:worker.agentId,since:old.observationId})).deltaReset,true);
 await app.call('agent.send',{agentId:worker.agentId,text:"printf '\\nTERM_DAD_%s\\n' AFTER_RESTART"});
 await app.call('agent.wait_for_text',{agentId:worker.agentId,text:'TERM_DAD_AFTER_RESTART',timeoutMs:15000});
 await app.call('task.update',{taskId:task.id,expectedRevision:1,patch:{status:'done',acceptanceCriteria:[{id:'follow-up',description:'Follow-up marker observed after restart',satisfied:true,evidence:'TERM_DAD_AFTER_RESTART observed in test-owned shell'}]}});
 const paneId=await app.call('terminal.spawn',{paneId:parent,command:['bash','--noprofile','--norc','-i']});owned.add(paneId);
 const adopted=await app.call('agent.adopt',{name:'adopted-shell',cli:'shell',paneId});
 await app.call('agent.wait_until_idle',{agentId:adopted.agentId,timeoutMs:15000});
 await app.call('agent.send',{agentId:adopted.agentId,text:"printf '\\nTERM_DAD_%s\\n' ADOPTED"});
 await app.call('agent.wait_for_text',{agentId:adopted.agentId,text:'TERM_DAD_ADOPTED',timeoutMs:15000});
 await app.call('agent.forget',{agentId:adopted.agentId});assert.ok((await app.call('terminal.list')).some((p:{pane_id:number})=>p.pane_id===paneId));
 await app.call('terminal.close',{target:'pane',id:paneId});owned.delete(paneId);
 await app.call('agent.stop',{agentId:worker.agentId});owned.delete(worker.paneId);assert.deepEqual(await app.call('agent.list'),[]);
 const orphan=await app.call('task.get',{taskId:task.id});assert.equal(orphan.status,'done');assert.equal(orphan.assignment.availability,'missing');assert.equal(orphan.assignedAgentId,worker.agentId);
 console.log('PASS: durable task assignment, explicit completion, worker removal retention, live MCP disconnect/restart recovery, stable worker and pane IDs, fresh observation history, follow-up input, adoption, forget, stop and cleanup');
}finally{
 let clean=true;for(const paneId of owned){try{await app.call('terminal.close',{target:'pane',id:paneId});}catch{clean=false;console.error(`Cleanup needed for test pane ${paneId}; state retained in ${directory}`);}}
 await app.client.close();if(clean)await rm(directory,{recursive:true,force:true});
}
