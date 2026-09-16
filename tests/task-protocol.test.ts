import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function connect(directory:string,fixture=false,identity='fixture-instance'){
 const client=new Client({name:'task-protocol-test',version:'1'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[fixture?'tests/fixtures/worker-server.mjs':'dist/index.js'],env:{...process.env,TERM_DAD_STATE_DIR:directory,WORKER_TEST_IDENTITY:identity,TERM_DAD_WEZTERM:'/nonexistent/wezterm',WORKER_TEST_LOG:join(directory,'input.log')} as Record<string,string>,stderr:'pipe'}));
 const raw=(name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:args});
 const call=async(name:string,args:Record<string,unknown>={})=>{const result=await raw(name,args);assert.notEqual(result.isError,true,JSON.stringify(result));return JSON.parse((result.content as {text:string}[])[0].text);};
 return {client,raw,call};
}

test('production stdio task tools persist across restart and serialize conflicting multi-process edits without a GUI',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'term-dad-task-protocol-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const first=await connect(directory);t.after(()=>first.client.close());
 assert.equal((await first.client.listTools()).tools.length,42);await assert.rejects(access(join(directory,'tasks.json')));
 const task=await first.call('task.create',{boardId:'repo',title:'Durable',goal:'Preserve metadata',acceptanceCriteria:[{id:'check',description:'Checked'}]});
 await first.client.close();const second=await connect(directory),third=await connect(directory);t.after(()=>second.client.close());t.after(()=>third.client.close());
 assert.deepEqual(await second.call('task.get',{taskId:task.id}),{...task,assignment:null});
 const outcomes=await Promise.all([second.raw('task.update',{taskId:task.id,expectedRevision:1,patch:{priority:'urgent'}}),third.raw('task.update',{taskId:task.id,expectedRevision:1,patch:{priority:'high'}})]);
 assert.equal(outcomes.filter(o=>o.isError).length,1);assert.match(JSON.stringify(outcomes.find(o=>o.isError)),/TASK_REVISION_CONFLICT/);
 assert.equal((await third.call('task.get',{taskId:task.id})).revision,2);
 assert.equal((await second.raw('task.create',{boardId:'repo',title:'Invalid',goal:'Invalid',status:'done'})).isError,true);
 assert.equal((await third.call('task.list')).total,1);
 assert.equal((await second.raw('task.update',{taskId:task.id,expectedRevision:2,patch:{status:'done'}})).isError,true);
 await second.call('task.update',{taskId:task.id,expectedRevision:2,patch:{status:'done',acceptanceCriteria:[{id:'check',description:'Checked',satisfied:true,evidence:'Verified'}]}});
 await third.call('task.archive',{taskId:task.id,expectedRevision:3,archived:true});
 assert.equal((await second.call('task.list')).total,0);
 assert.equal((await second.call('task.get',{taskId:task.id})).archived,true);
 await assert.rejects(access(join(directory,'workers.json')));
});

test('worker joins survive restart, detachment, forgetting and reassignment without sending terminal input',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'term-dad-task-worker-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const first=await connect(directory,true);t.after(()=>first.client.close());
 const worker=await first.call('agent.adopt',{name:'assigned',paneId:7,cli:'codex'});
 const task=await first.call('task.create',{boardId:'repo',title:'Assigned',goal:'Track outcome',assignedAgentId:worker.agentId});
 assert.equal((await first.call('agent.list'))[0].tasks.items[0].id,task.id);
 assert.equal((await first.call('orchestrator.status'))[0].tasks.items[0].id,task.id);
 assert.equal((await first.call('terminal.snapshot')).agents[0].tasks.items[0].id,task.id);
 assert.equal((await first.call('task.get',{taskId:task.id})).assignment.availability,'attached');
 await first.client.close();const second=await connect(directory,true),detached=await connect(directory,true,'new-instance');t.after(()=>second.client.close());t.after(()=>detached.client.close());
 assert.equal((await second.call('agent.list'))[0].tasks.total,1);
 assert.equal((await detached.call('task.get',{taskId:task.id})).assignment.availability,'detached');
 await second.call('agent.forget',{agentId:worker.agentId});
 const missing=await second.call('task.get',{taskId:task.id});assert.equal(missing.assignment.availability,'missing');assert.equal(missing.assignedAgentId,worker.agentId);assert.equal(missing.status,'todo');
 const replacement=await second.call('agent.adopt',{name:'replacement',paneId:7,cli:'codex'});
 await second.call('task.assign',{taskId:task.id,expectedRevision:1,agentId:replacement.agentId});
 assert.equal((await second.call('agent.list'))[0].tasks.items[0].id,task.id);
 await assert.rejects(access(join(directory,'input.log')));
});
