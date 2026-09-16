import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm,stat,writeFile,access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventQueue,FileEventStorage,type EventInput,type EventStorage,type EventState } from '../src/events.js';
const input=(paneId=1,kind='ready'):EventInput=>({kind,paneId,watchId:'watch-1',agentId:'worker-1',occurredAt:new Date().toISOString(),summary:'Worker status changed'});
async function fixture(t:any,capacity=3){const directory=await mkdtemp(join(tmpdir(),'term-dad-events-'));const queue=new EventQueue(new FileEventStorage(directory),capacity);t.after(async()=>{await queue.close();await rm(directory,{recursive:true,force:true});});return {directory,queue};}
test('journal replays IDs, sequences and acknowledgments across restarts; only acked events are evicted',async t=>{
 const {directory,queue}=await fixture(t,2);const a=await queue.publish(input()),b=await queue.publish(input(2));
 await assert.rejects(queue.publish(input(3)),/EVENT_QUEUE_FULL/);
 assert.equal((await queue.list()).pendingCount,2);
 const ack=await queue.acknowledge([a.id]);assert.deepEqual(await queue.acknowledge([a.id]),ack);
 await queue.close();const restarted=new EventQueue(new FileEventStorage(directory),2);t.after(()=>restarted.close());
 assert.deepEqual((await restarted.list()).events,[b]);
 const c=await restarted.publish(input(3));assert.equal(c.sequence,3);assert.notEqual(c.id,b.id);
 assert.deepEqual((await restarted.acknowledge([a.id])).unknownIds,[a.id]);
 assert.equal((await stat(join(directory,'events.json'))).mode&0o777,0o600);
});
test('read-only access is lazy; corrupt and oversized journals are preserved',async t=>{
 const {directory}=await fixture(t);const absent=join(directory,'absent');const lazy=new EventQueue(new FileEventStorage(absent));t.after(()=>lazy.close());
 assert.equal((await lazy.list()).pendingCount,0);await assert.rejects(access(absent));
 const path=join(directory,'events.json');await writeFile(path,'broken',{mode:0o600});const q=new EventQueue(new FileEventStorage(directory));t.after(()=>q.close());
 await assert.rejects(q.publish(input()),/EVENT_STATE_CORRUPT/);assert.equal(await readFile(path,'utf8'),'broken');
 await writeFile(path,'x'.repeat(4_000_001));await assert.rejects(q.list(),/EVENT_STATE_CORRUPT/);
});
test('waits replay pending events, combine filters, handle publish race and never consume',async t=>{
 const {queue}=await fixture(t);const first=await queue.publish(input());
 assert.deepEqual(await queue.wait({paneIds:[1,2],kinds:['ready']}),{status:'event',event:first});
 const wait=queue.wait({paneIds:[2,3],agentIds:['worker-1'],watchIds:['watch-1'],kinds:['error'],afterSequence:first.sequence},1000);
 await queue.publish(input(2));const expected=await queue.publish(input(3,'error'));
 assert.deepEqual(await wait,{status:'event',event:expected});assert.equal((await queue.list()).pendingCount,3);
 assert.deepEqual(await queue.wait({kinds:['missing']},10),{status:'timeout'});
});
test('waiter limits, cancellation and close settle promptly',async t=>{
 const {directory}=await fixture(t);const q=new EventQueue(new FileEventStorage(directory),3,1);const controller=new AbortController();
 const pending=q.wait({},1000,controller.signal);await assert.rejects(q.wait(),/EVENT_WAITER_LIMIT/);controller.abort();assert.deepEqual(await pending,{status:'cancelled'});
 const closing=q.wait();await q.close();assert.deepEqual(await closing,{status:'closed'});assert.deepEqual(await q.wait(),{status:'closed'});await assert.rejects(q.publish(input()),/EVENT_QUEUE_CLOSED/);
});
test('injected write failure stays observable and does not suppress publish retry',async()=>{
 let fail=true,state:EventState={version:1,nextSequence:1,events:[]};
 const storage:EventStorage={async transaction(_write,fn){if(fail){fail=false;throw new Error('disk unavailable');}const value=fn(structuredClone(state));if(value.state)state=value.state;return value.result;}};
 const queue=new EventQueue(storage);await assert.rejects(queue.publish(input()),/disk unavailable/);const event=await queue.publish(input());assert.equal(event.sequence,1);await queue.close();
});
test('input excludes extra content, journal corruption does not reset sequence, lock conflicts are explicit',async t=>{
 const {queue,directory}=await fixture(t);await assert.rejects(queue.publish({...input(),rawText:'secret'} as EventInput),/EVENT_INPUT_INVALID/);
 await writeFile(join(directory,'events.lock'),'');await assert.rejects(queue.list(),/EVENT_STORAGE_BUSY/);await rm(join(directory,'events.lock'));
 const event=await queue.publish(input());await writeFile(join(directory,'events.json'),JSON.stringify({version:1,nextSequence:1,events:[event]}));await assert.rejects(queue.list(),/EVENT_STATE_CORRUPT/);
});
test('wait sees publications from a second queue using the same journal',async t=>{
 const {queue,directory}=await fixture(t);const other=new EventQueue(new FileEventStorage(directory));t.after(()=>other.close());
 const pending=queue.wait({paneIds:[9]},1000);
 // Let the initial read finish before the independent writer acquires its transaction lock.
 await new Promise(resolve=>setTimeout(resolve,30));const event=await other.publish(input(9));assert.deepEqual(await pending,{status:'event',event});
});
test('concurrent publish and ack serialize without lost updates',async t=>{
 const {queue}=await fixture(t,50);
 const events=await Promise.all(Array.from({length:20},(_,i)=>queue.publish(input(i))));
 assert.deepEqual(events.map(e=>e.sequence),Array.from({length:20},(_,i)=>i+1));
 await Promise.all(events.map(e=>queue.acknowledge([e.id])));assert.equal((await queue.list()).pendingCount,0);
});
test('cross-instance concurrent writers preserve every event and ack',async t=>{
 const {queue,directory}=await fixture(t,50);const other=new EventQueue(new FileEventStorage(directory),50);t.after(()=>other.close());
 const events=await Promise.all(Array.from({length:20},(_,i)=>(i%2?queue:other).publish(input(i))));
 assert.equal(new Set(events.map(e=>e.sequence)).size,20);
 await Promise.all(events.map((e,i)=>(i%2?other:queue).acknowledge([e.id])));
 assert.equal((await queue.list()).pendingCount,0);assert.equal((await other.list({},true)).events.length,20);
});
test('pending reads do not prevent cancellation or close, and operation backlog is bounded',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const storage:EventStorage={async transaction(_write,fn){await gate;return fn({version:1,nextSequence:1,events:[]}).result;}};
 const queue=new EventQueue(storage),controller=new AbortController();
 const cancelled=queue.wait({},1000,controller.signal);controller.abort();assert.deepEqual(await cancelled,{status:'cancelled'});
 const closingWait=queue.wait();const operations=Array.from({length:127},()=>queue.list());
 await assert.rejects(queue.list(),/EVENT_OPERATION_LIMIT/);
 const closing=queue.close();assert.deepEqual(await closingWait,{status:'closed'});
 release();await Promise.all(operations);await closing;
});
test('directory-sync failure after commit reports warning without rejecting publish or duplicating sequence',async t=>{
 const {directory}=await fixture(t);
 class FailingDirectorySync extends FileEventStorage {protected override async syncDirectory(){throw new Error('injected directory sync failure');}}
 const queue=new EventQueue(new FailingDirectorySync(directory));t.after(()=>queue.close());
 const event=await queue.publish(input());const listed=await queue.list();assert.equal(listed.events[0].id,event.id);assert.equal(listed.events.length,1);assert.match(listed.storageWarning!,/EVENT_DURABILITY_WARNING/);
 const reopened=new EventQueue(new FileEventStorage(directory));t.after(()=>reopened.close());assert.deepEqual((await reopened.list()).events,[event]);
});
