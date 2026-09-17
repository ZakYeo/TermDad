import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createServer } from '../src/server.js';
import { WezTermBackend } from '../src/backend.js';
import { EventQueue,FileEventStorage,type EventInput } from '../src/events.js';
import { MemoryWorkerStorage } from '../src/worker-storage.js';
import { MemoryTaskStorage } from '../src/task-storage.js';
const value=(r:any)=>JSON.parse(r.content[0].text);
const input=(kind='ready',occurredAt=new Date().toISOString()):EventInput=>({kind,paneId:7,watchId:'w',occurredAt,summary:'Worker status changed'});
async function connect(t:any){
 const directory=await mkdtemp(join(tmpdir(),'term-dad-freshness-'));
 const backend=new WezTermBackend(async args=>args[0]==='list'?JSON.stringify([]):'',async()=>null);
 const queue=new EventQueue(new FileEventStorage(directory));
 // Injected storage throughout: a unit test must never touch the developer's real state directory.
 const app=createServer(backend,undefined,{automatic:false},queue,new MemoryWorkerStorage(),new MemoryTaskStorage());
 const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'freshness-test',version:'1'});
 await app.server.connect(a);await client.connect(b);
 t.after(async()=>{await client.close();await app.watches.dispose();await queue.close();await rm(directory,{recursive:true,force:true});});
 return {queue,call:(name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:args})};
}
test('event.wait_for_event ignores pending history unless history is explicitly requested',async t=>{
 const {queue,call}=await connect(t);
 const stale=await queue.publish(input());
 assert.deepEqual(value(await call('event.wait_for_event',{timeoutMs:100})),{status:'timeout'},'a backlog must not satisfy a fresh wait');
 assert.equal(value(await call('event.wait_for_event',{timeoutMs:100,freshOnly:false})).event.id,stale.id,'history is still reachable on request');
 assert.equal(value(await call('event.list')).pendingCount,1,'waiting never consumed it');
});
test('a fresh wait still receives a later event, whatever time that event claims',async t=>{
 const {queue,call}=await connect(t);
 await queue.publish(input('ready'));
 const waiting=call('event.wait_for_event',{kinds:['input_required'],timeoutMs:10000});
 // The wait arms asynchronously across the transport, so publish until it is observed rather
 // than racing it once. Each event claims 1970, proving freshness ignores the producing clock.
 const published:string[]=[];let settled=false;
 void waiting.then(()=>{settled=true;});
 for(let i=0;i<40&&!settled;i++){published.push((await queue.publish(input('input_required',new Date(0).toISOString()))).id);await new Promise(r=>setTimeout(r,50));}
 const delivered=value(await waiting);
 assert.equal(delivered.status,'event');
 assert.ok(published.includes(delivered.event.id),'a fresh wait received an event published after it armed');
 assert.equal(delivered.event.occurredAt,new Date(0).toISOString());
});
test('an explicit afterSequence overrides the fresh baseline',async t=>{
 const {queue,call}=await connect(t);
 const first=await queue.publish(input());
 assert.equal(value(await call('event.wait_for_event',{afterSequence:0,timeoutMs:100})).event.id,first.id);
});
