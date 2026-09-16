import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { WezTermBackend } from '../src/backend.js';
import { EventQueue,FileEventStorage,type EventStorage } from '../src/events.js';
import type { WatchOptions } from '../src/watches.js';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
async function connect(queue:EventQueue,options:WatchOptions={}){
 let now=0,text='Working (1s • esc to interrupt)';const calls:string[]=[];
 const backend=new WezTermBackend(async args=>{calls.push(args[0]);if(args[0]==='list')return JSON.stringify([{pane_id:7,tab_id:1,window_id:1,title:'private-title',cwd:'/',size:{rows:24,cols:80}}]);if(args[0]==='spawn')return '7';return text;});
 const app=createServer(backend,undefined,{automatic:false,now:()=>now,...options},queue);
 const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'integration-test',version:'1'});
 await app.server.connect(a);await client.connect(b);
 const call=async(name:string,args:Record<string,unknown>={})=>{const r=await client.callTool({name,arguments:args});assert.notEqual(r.isError,true,JSON.stringify(r));return JSON.parse((r.content as {text:string}[])[0].text);};
 return {...app,client,call,calls,setText:(value:string)=>{text=value;},tick:async()=>{now+=500;await app.watches.poll();},close:async()=>{await client.close();await app.server.close();await app.watches.dispose();await queue.close();}};
}
const config={paneId:7,adapter:'codex',pollMs:500,inactivityMs:10000,cooldownMs:0};
async function directory(t:any){const path=await mkdtemp(join(tmpdir(),'term-dad-watch-events-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}

test('MCP watch events reach filtered waiters, acknowledge and replay after restart without terminal content',async t=>{
 const path=await directory(t);const app=await connect(new EventQueue(new FileEventStorage(path)));t.after(()=>app.close());
 const worker=await app.call('agent.spawn',{name:'my worker',cli:'codex'});
 const watch=await app.call('watch.create',{agentId:'my worker',pollMs:500,inactivityMs:10000,cooldownMs:0});
 const waiting=app.call('event.wait_for_event',{paneIds:[7],agentIds:[worker.agentId],watchIds:[watch.watchId],kinds:['input_required'],timeoutMs:2000});
 app.setText('private terminal content\n› ');await app.tick();
 const first=(await app.call('event.list')).events[0];assert.equal(first.kind,'ready');
 app.setText('private permission details\nDo you want to proceed?\n› Yes');await app.tick();
 const delivered=await waiting;assert.equal(delivered.status,'event');assert.equal(delivered.event.kind,'input_required');assert.equal(delivered.event.watchId,watch.watchId);
 const ack=await app.call('event.acknowledge',{ids:[first.id]});assert.deepEqual(await app.call('event.acknowledge',{ids:[first.id]}),ack);
 const journal=await readFile(join(path,'events.json'),'utf8');assert.ok(!journal.includes('private'));
 await app.close();assert.ok(!app.calls.includes('kill-pane'));
 const restarted=await connect(new EventQueue(new FileEventStorage(path)));t.after(()=>restarted.close());
 assert.deepEqual(await restarted.call('watch.list'),[]);
 assert.deepEqual((await restarted.call('event.list',{watchIds:[watch.watchId]})).events,[delivered.event]);
 assert.deepEqual(await restarted.call('event.acknowledge',{ids:[first.id]}),ack);
 await restarted.call('event.acknowledge',{ids:[delivered.event.id]});assert.equal((await restarted.call('event.list')).pendingCount,0);
});

test('MCP queue full surfaces watch delivery failure and retries once capacity is acknowledged',async t=>{
 const path=await directory(t),queue=new EventQueue(new FileEventStorage(path),1);const app=await connect(queue);t.after(()=>app.close());
 const blocker=await queue.publish({kind:'occupied',paneId:9,occurredAt:new Date(0).toISOString(),summary:'Existing event'});
 app.setText('Do you want to proceed?');const watch=await app.call('watch.create',config);await app.tick();
 const failed=(await app.call('watch.list'))[0];assert.equal(failed.pendingEvents,1);assert.match(failed.deliveryError,/retrying/);
 assert.equal((await app.call('event.list')).events[0].id,blocker.id);
 await app.call('event.acknowledge',{ids:[blocker.id]});
 const waiting=app.call('event.wait_for_event',{watchIds:[watch.watchId],kinds:['input_required'],timeoutMs:2000});await app.tick();const delivered=await waiting;
 assert.equal(delivered.event.occurredAt,new Date(0).toISOString());assert.equal(delivered.event.sequence,2);
 const recovered=(await app.call('watch.list'))[0];assert.equal(recovered.pendingEvents,0);assert.equal(recovered.deliveryError,undefined);
 await app.tick();assert.equal((await app.call('event.list')).pendingCount,1);
});

test('MCP disconnect drains default watch sink before closing queue and settles waits without killing panes',async t=>{
 const path=await directory(t),disk=new FileEventStorage(path),entered=deferred(),release=deferred(),closed=deferred();let closing=false;
 const storage:EventStorage={async transaction(write,fn){if(write){entered.resolve();await release.promise;}return disk.transaction(write,fn);}};
 class ClosingQueue extends EventQueue {override async close(){closing=true;await super.close();closed.resolve();}}
 const queue=new ClosingQueue(storage),app=await connect(queue);t.after(async()=>{release.resolve();await app.close();});
 app.setText('Do you want to proceed?');await app.call('watch.create',config);const waiting=queue.wait({kinds:['never']});const pass=app.tick();await entered.promise;
 await app.client.close();await new Promise(resolve=>setImmediate(resolve));assert.equal(closing,false);assert.deepEqual(app.watches.list(),[]);
 release.resolve();await pass;await closed.promise;assert.deepEqual(await waiting,{status:'closed'});assert.ok(!app.calls.includes('kill-pane'));
 const replay=new EventQueue(new FileEventStorage(path));t.after(()=>replay.close());assert.equal((await replay.list()).events[0].kind,'input_required');
});

test('createServer retains queue-only injection and explicit watch sink override',async t=>{
 const path=await directory(t),queue=new EventQueue(new FileEventStorage(path));
 const original=createServer(undefined,undefined,queue);assert.equal(original.events,queue);await original.watches.dispose();await original.events.close();
 let delivered=0;const overrideQueue=new EventQueue(new FileEventStorage(path));const app=await connect(overrideQueue,{sink:async()=>{delivered++;}});t.after(()=>app.close());
 app.setText('Do you want to proceed?');await app.call('watch.create',config);await app.tick();assert.equal(delivered,1);assert.equal((await app.call('event.list')).pendingCount,0);
});
