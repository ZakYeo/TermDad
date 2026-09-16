import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {EventQueue,FileEventStorage} from '../src/events.js';
const value=(r:any)=>JSON.parse(r.content[0].text);
test('stdio event timeout, filter, publish visibility, idempotent ack and restart replay',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'term-dad-event-protocol-'));const queue=new EventQueue(new FileEventStorage(directory));
 let client:Client|undefined;
 const connect=async()=>{const c=new Client({name:'event-test',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env:{...process.env,TERM_DAD_STATE_DIR:directory} as Record<string,string>,stderr:'inherit'}));return c;};
 try{
  client=await connect();const event=await queue.publish({kind:'ready',paneId:3,watchId:'w',occurredAt:new Date().toISOString(),summary:'Worker status changed'});
  assert.deepEqual(value(await client.callTool({name:'event.wait_for_event',arguments:{paneIds:[4],timeoutMs:20}})),{status:'timeout'});
  assert.equal(value(await client.callTool({name:'event.wait_for_event',arguments:{paneIds:[3],kinds:['ready'],timeoutMs:100}})).event.id,event.id);
  await client.close();client=await connect();
  assert.equal(value(await client.callTool({name:'event.list',arguments:{watchIds:['w']}})).events[0].id,event.id);
  const ack=value(await client.callTool({name:'event.acknowledge',arguments:{ids:[event.id]}}));
  assert.deepEqual(value(await client.callTool({name:'event.acknowledge',arguments:{ids:[event.id]}})),ack);
  assert.equal(value(await client.callTool({name:'event.list',arguments:{}})).pendingCount,0);
  assert.equal((await client.callTool({name:'event.wait_for_event',arguments:{timeoutMs:120001}})).isError,true);
 }finally{await client?.close();await queue.close();await rm(directory,{recursive:true,force:true});}
});
