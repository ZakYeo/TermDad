import test from 'node:test';
import { completeViaTools } from './task-support.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTaskTools } from '../src/task-tools.js';
import { TaskBoard } from '../src/tasks.js';
import { MemoryTaskStorage } from '../src/task-storage.js';

test('standalone task tools validate MCP calls, report conflicts and preserve explicit completion',async()=>{
 const server=new McpServer({name:'task-test',version:'1'}),board=new TaskBoard(new MemoryTaskStorage());
 registerTaskTools(server,board);
 const client=new Client({name:'task-test',version:'1'}),[local,remote]=InMemoryTransport.createLinkedPair();
 await server.connect(remote);await client.connect(local);
 const call=(name:string,args:Record<string,unknown>)=>client.callTool({name,arguments:args});
 const data=(result:any)=>JSON.parse(result.content[0].text);
 try{
  assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['task.archive','task.assign','task.create','task.get','task.history','task.list','task.report_result','task.start_attempt','task.update','task.verify']);
  const task=data(await call('task.create',{boardId:'repo',title:'Implement',goal:'Acceptance requirements',acceptanceCriteria:[{id:'tests',description:'Tests pass'}]}));
  assert.equal(task.revision,1);assert.equal(task.priority,'normal');
  // Preserve strictness at the transport boundary, before the SDK invokes handlers.
  for(const [name,args] of [
   ['task.create',{boardId:'repo',title:'Invalid',goal:'Must not create',status:'done'}],
   ['task.get',{taskId:task.id,unexpected:true}],
   ['task.list',{boardId:'repo',assignee:'typo'}],
   ['task.update',{taskId:task.id,expectedRevision:1,patch:{title:'Must not change'},unexpected:true}],
   ['task.update',{taskId:task.id,expectedRevision:1,patch:{title:'Must not change',unexpected:true}}],
   ['task.assign',{taskId:task.id,expectedRevision:1,agentId:randomUUID(),unexpected:true}],
   ['task.archive',{taskId:task.id,expectedRevision:1,archived:true,unexpected:true}],
  ] as const)assert.equal((await call(name,args)).isError,true,name);
  assert.equal(data(await call('task.list',{})).total,1);
  assert.deepEqual(data(await call('task.get',{taskId:task.id})),task);
  assert.equal((await call('task.update',{taskId:task.id,expectedRevision:1,patch:{status:'done'}})).isError,true);
  const worker=randomUUID();assert.equal(data(await call('task.assign',{taskId:task.id,expectedRevision:1,agentId:worker})).assignedAgentId,worker);
  const stale=await call('task.update',{taskId:task.id,expectedRevision:1,patch:{priority:'high'}});
  assert.equal(stale.isError,true);assert.match((stale.content as any)[0].text,/TASK_REVISION_CONFLICT/);
  assert.equal(data(await call('task.list',{assignedAgentId:worker})).total,1);
  assert.equal(data(await call('task.get',{taskId:task.id})).status,'todo');
  assert.equal((await call('task.create',{boardId:'repo',title:'Bad',goal:'Bad',assignedAgentId:'pane-7'})).isError,true);
  assert.equal((await call('task.update',{taskId:task.id,expectedRevision:2,patch:{}})).isError,true);
  const done=await completeViaTools(async(name,args)=>{const r=await call(name,args);assert.notEqual(r.isError,true,JSON.stringify(r));return data(r);},task.id);
  assert.equal(done.status,'done');
  await call('task.archive',{taskId:task.id,expectedRevision:done.revision,archived:true});
  assert.equal(data(await call('task.list',{})).total,0);
  assert.equal(data(await call('task.get',{taskId:task.id})).archived,true);
 }finally{await client.close();await server.close();}
 await assert.rejects(board.list(),/TASK_BOARD_CLOSED/);
});
