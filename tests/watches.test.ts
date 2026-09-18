import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WezTermBackend } from '../src/backend.js';
import { Agents } from '../src/agents.js';
import { WatchManager,type WatchEventInput } from '../src/watches.js';
import { CommandNotificationProvider } from '../src/notifications.js';
import { EventQueue,type EventState,type EventStorage } from '../src/events.js';
import { MemoryWorkerStorage } from '../src/worker-storage.js';
import { MemoryTaskStorage } from '../src/task-storage.js';
// This file builds real servers, which bind a push socket in the state directory. Point the
// whole file at a private one so a test run never creates sockets in, or sweeps sockets from,
// the developer's own state directory.
process.env.TERM_DAD_STATE_DIR=await mkdtemp(join(tmpdir(),'term-dad-state-'));
/** Isolated event storage: a unit test must never read or write the developer's real journal. */
function memoryEvents():EventStorage{
 let state:EventState={version:1,nextSequence:1,events:[]};
 return {async transaction(_write,fn){const value=fn(structuredClone(state));if(value.state)state=value.state;return value.result;}};
}
function fixture(options:any={}){
 let now=0,text='› ',alive=true,fail=false;
 const calls:string[]=[];const events:WatchEventInput[]=[];
 const backend=new WezTermBackend(async args=>{calls.push(args[0]);if(fail)throw new Error('secret backend error');if(args[0]==='list')return JSON.stringify(alive?[{pane_id:7,tab_id:1,window_id:1,title:'private',cwd:'/',size:{rows:24,cols:80}}]:[]);if(args[0]==='spawn')return '7';return text;});
 const agents=new Agents(backend);
 const watches=new WatchManager(backend,agents,{automatic:false,now:()=>now,sink:async e=>{events.push(e);},...options});
 return {watches,agents,backend,calls,events,advance:(ms:number)=>{now+=ms;},setText:(s:string)=>text=s,remove:()=>alive=false,fail:(v:boolean)=>fail=v,tick:async(ms=500)=>{now+=ms;await watches.poll();}};
}
const config={paneId:7,adapter:'codex',pollMs:500,inactivityMs:1000,cooldownMs:0};
test('baseline, prompt transitions, permission precedence and quiet episodes',async()=>{
 const f=fixture();await f.watches.create(config);await f.tick();assert.equal(f.events.length,0);
 f.setText('Working (2s • esc to interrupt)');await f.tick();f.setText('secret output\n› ');await f.tick();await f.tick();
 assert.deepEqual(f.events.map(e=>e.kind),['ready']);await f.tick();await f.tick();assert.deepEqual(f.events.map(e=>e.kind),['ready','inactive']);
 f.setText('Do you want to proceed?\n› Yes');await f.tick();assert.equal(f.events.at(-1)?.kind,'input_required');await f.tick();assert.equal(f.events.at(-1)?.kind,'attention_required','a stable prompt asks for a person');await f.tick();assert.equal(f.events.at(-1)?.kind,'inactive');
 assert.ok(!JSON.stringify(f.events).includes('secret'));assert.ok(f.events.every(e=>!Number.isNaN(Date.parse(e.occurredAt))));await f.watches.dispose();
});
test('sink failures retry independently of successful notifications, bounded cooldown and disappearance',async()=>{
 let attempts=0,notifications=0;const f=fixture({sink:async()=>{if(++attempts===1)throw new Error('private');},notifications:{notify:async()=>{notifications++;}}});
 f.setText('Do you want to proceed?');await f.watches.create({...config,notify:true,cooldownMs:1000});await f.tick();assert.match(f.watches.list()[0].deliveryError!,/retrying/);assert.equal(notifications,2,'the failed request for a person does not hold back the input request');
 await f.tick();assert.equal(attempts,3,'the request for a person and the input request each reach the sink once');assert.equal(notifications,2);assert.equal(f.watches.list()[0].deliveryError,undefined);
 f.fail(true);await f.tick();assert.equal(f.watches.list()[0].disappeared,false);assert.match(f.watches.list()[0].backendError!,/retrying/);
 f.fail(false);f.remove();await f.tick();assert.equal(f.watches.list()[0].disappeared,true);await f.tick(1000);assert.equal(f.watches.list()[0].pendingEvents,0);assert.ok(!f.calls.includes('kill-pane'));await f.watches.dispose();
});
test('managed pane targets automatically preserve stale-prompt guard and registry cleanup',async()=>{
 const f=fixture();await f.agents.spawn({name:'worker',cli:'codex'});await f.watches.create({paneId:7,pollMs:500,cooldownMs:0});await f.agents.send('worker','test');await f.agents.storage.transaction(true,s=>{s.workers[0].lastInputAt=Date.now()-2000;return {state:s,result:undefined};});await f.tick();assert.equal(f.watches.list()[0].status,'WORKING');await f.tick(2000);assert.equal(f.events.length,0);
 f.setText('new result\n› ');await f.tick();assert.equal(f.events[0].kind,'ready');f.remove();await f.tick();assert.equal(f.agents.records.size,0);await f.watches.dispose();
});
test('validation, capacity, removal and disposal are bounded and never close panes',async()=>{
 const f=fixture();await assert.rejects(f.watches.create({paneId:7}));await assert.rejects(f.watches.create({...config,agentId:'x'}));await assert.rejects(f.watches.create({...config,pollMs:1}));await assert.rejects(f.watches.create({...config,notify:true}));
 for(let i=0;i<64;i++)await f.watches.create(config);await assert.rejects(f.watches.create(config),/Maximum/);const first=f.watches.list()[0];assert.equal(f.watches.remove(first.watchId).removed,true);await f.watches.dispose();assert.deepEqual(f.watches.list(),[]);await assert.rejects(f.watches.create(config),/disposed/);assert.ok(!f.calls.includes('kill-pane'));
});
test('poll calls never overlap and removal prevents in-flight delivery',async()=>{
 const f=fixture();const w=await f.watches.create(config);let release!:()=>void;let reads=0;
 f.backend.read=async()=>{reads++;await new Promise<void>(r=>release=r);return 'Do you want to proceed?';};
 const pass=f.tick();await new Promise(r=>setImmediate(r));const concurrent=f.watches.poll();assert.equal(reads,1);f.watches.remove(w.watchId);release();await Promise.all([pass,concurrent]);assert.equal(f.events.length,0);await f.watches.dispose();
});
test('concurrent watch creations cannot exceed capacity',async()=>{
 const f=fixture();
 try{
  const results=await Promise.allSettled(Array.from({length:65},()=>f.watches.create(config)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,64);
  const rejected=results.find(r=>r.status==='rejected');
  assert.ok(rejected&&rejected.status==='rejected');assert.match(rejected.reason.message,/Maximum/);
  assert.equal(f.watches.list().length,64);
 }finally{await f.watches.dispose();}
});
test('disposal during worker lookup prevents late watch insertion',async()=>{
 const f=fixture();let release!:()=>void;
 f.agents.findByPane=async()=>{await new Promise<void>(r=>release=r);return undefined;};
 const creation=f.watches.create(config),rejected=assert.rejects(creation,/disposed/);
 const closing=f.watches.dispose();release();await Promise.all([closing,rejected]);
 assert.deepEqual(f.watches.list(),[]);assert.equal(f.calls.length,0);
});
test('notification command preserves literal argv, JSON stdin, timeout and failures',async()=>{
 const event:WatchEventInput={kind:'ready',paneId:7,occurredAt:new Date(0).toISOString(),summary:'Fixed summary'};let call:any;
 const p=new CommandNotificationProvider(['/trusted/program','$(never execute)'],async(...args)=>{call=args;return '';});await p.notify(event);assert.deepEqual(call,['/trusted/program',['$(never execute)'],JSON.stringify(event),5000]);
 assert.throws(()=>new CommandNotificationProvider([]));assert.throws(()=>new CommandNotificationProvider(['a\0b']));await assert.rejects(new CommandNotificationProvider(['bad'],async()=>{throw new Error('failed');}).notify(event));
});
test('successful sink is not duplicated when desktop delivery fails',async()=>{
 let sent=0,notifications=0;const f=fixture({sink:async()=>{sent++;},notifications:{notify:async()=>{if(++notifications===1)throw new Error('failed');}}});
 f.setText('Do you want to proceed?');await f.watches.create({...config,notify:true,inactivityMs:10000});await f.tick();assert.equal(sent,2,'both kinds reach the sink although the first notification failed');assert.ok(f.watches.list()[0].deliveryError);assert.equal(f.watches.list()[0].pendingEvents,1);await f.tick();assert.equal(sent,2,'the retried notification does not resend the delivered event');assert.equal(notifications,3);assert.equal(f.watches.list()[0].pendingEvents,0);assert.equal(f.watches.list()[0].deliveryError,undefined);await f.watches.dispose();
});
test('cooldown retains transitions and activity resets inactivity once per episode',async()=>{
 const f=fixture();await f.watches.create({...config,cooldownMs:2000});f.setText('Working (1s • esc to interrupt)');await f.tick();f.setText('new\n› ');await f.tick();assert.deepEqual(f.events.map(e=>e.kind),['ready']);
 await f.tick(1000);assert.equal(f.watches.list()[0].pendingEvents,1);await f.tick(1000);assert.deepEqual(f.events.map(e=>e.kind),['ready','inactive']);f.setText('newer\n› ');await f.tick();await f.tick(2000);assert.deepEqual(f.events.map(e=>e.kind),['ready','inactive','inactive']);await f.watches.dispose();
});
test('dispose waits for in-flight delivery and suppresses subsequent notification',async()=>{
 let release!:()=>void,notifications=0;const f=fixture({sink:async()=>new Promise<void>(r=>release=r),notifications:{notify:async()=>{notifications++;}}});f.setText('Do you want to proceed?');await f.watches.create({...config,notify:true});const pass=f.tick();await new Promise(r=>setImmediate(r));let done=false;const closing=f.watches.dispose().then(()=>{done=true;});await new Promise(r=>setImmediate(r));assert.equal(done,false);release();await Promise.all([pass,closing]);assert.equal(notifications,0);assert.deepEqual(f.watches.list(),[]);
});
test('dispose waits for an in-flight baseline and prevents creation from surviving',async()=>{
 const f=fixture();let release!:()=>void;f.backend.read=async()=>{await new Promise<void>(r=>release=r);return '› ';};const create=f.watches.create(config);await new Promise(r=>setImmediate(r));const rejected=assert.rejects(create,/removed/);const closing=f.watches.dispose();release();await Promise.all([closing,rejected]);assert.deepEqual(f.watches.list(),[]);
});
test('automatic timer schedules serial polls and disposal clears future work',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture({automatic:true});await f.watches.create(config);f.setText('Do you want to proceed?');f.advance(500);t.mock.timers.tick(500);await new Promise(r=>setImmediate(r));assert.deepEqual(f.events.map(e=>e.kind),['input_required'],'a screen seen once is not yet known to be stable');await f.watches.dispose();const count=f.calls.length;f.advance(5000);t.mock.timers.tick(5000);await new Promise(r=>setImmediate(r));assert.equal(f.calls.length,count);
});
test('MCP watch tools create, list, remove and close without closing panes',async()=>{
 const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {createServer}=await import('../src/server.js');
 const f=fixture();const {server,watches}=createServer(f.backend,undefined,{automatic:false},new EventQueue(memoryEvents()),new MemoryWorkerStorage(),new MemoryTaskStorage());const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'watch-test',version:'1'});await server.connect(a);await client.connect(b);
 try{const created=await client.callTool({name:'watch.create',arguments:config});assert.equal(created.isError,undefined);const watch=JSON.parse((created.content as any)[0].text);const listed=await client.callTool({name:'watch.list',arguments:{}});assert.equal(JSON.parse((listed.content as any)[0].text)[0].watchId,watch.watchId);await client.callTool({name:'watch.remove',arguments:{watchId:watch.watchId}});assert.deepEqual(watches.list(),[]);await client.callTool({name:'watch.create',arguments:config});}finally{await client.close();await server.close();await watches.dispose();}assert.deepEqual(watches.list(),[]);assert.ok(!f.calls.includes('kill-pane'));
});
test('push-backed watches back off to a liveness interval and verify pushed events by sampling',async()=>{
 let enabled=true;
 const f=fixture({pushDeliverable:()=>enabled});
 await f.watches.create({...config,pollMs:500,pushPollMs:30000});
 const baseline=f.calls.length;
 await f.tick(500);await f.tick(500);
 assert.equal(f.calls.length,baseline,'a push-backed pane is not scraped on the normal interval');
 f.setText('Do you want to proceed?\n› Yes');
 await f.watches.confirm(7);
 assert.ok(f.calls.length>baseline,'a push triggers an immediate confirming sample');
 assert.deepEqual(f.events.map(e=>e.kind),['input_required']);
 await f.watches.confirm(7);
 assert.deepEqual(f.events.map(e=>e.kind),['input_required','attention_required'],'a second confirming sample finds the prompt stable and asks for a person');
 assert.equal(f.watches.list()[0].pushBacked,true);
 enabled=false;
 f.setText('done\n› ');
 await f.tick(500);
 assert.equal(f.events.at(-1)?.kind,'ready','disabling push restores the normal polling interval');
 await f.watches.dispose();
});
test('a watch keeps its fast interval while push is enabled but not deliverable',async()=>{
 let deliverable=false;
 const f=fixture({pushDeliverable:()=>deliverable});
 await f.watches.create({...config,pollMs:500,pushPollMs:30000});
 const baseline=f.calls.length;
 await f.tick(500);
 assert.ok(f.calls.length>baseline,'an undeliverable channel must not stretch the polling backstop');
 assert.equal(f.watches.list()[0].pushBacked,false);
 deliverable=true;
 const backedOff=f.calls.length;
 await f.tick(500);
 assert.equal(f.calls.length,backedOff,'a deliverable channel backs off to the liveness interval');
 assert.equal(f.watches.list()[0].pushBacked,true);
 await f.watches.dispose();
});
test('a push for an unwatched or disappeared pane never fabricates an event',async()=>{
 const f=fixture({pushDeliverable:()=>true});
 await f.watches.confirm(7);
 assert.deepEqual(f.events,[]);
 await f.watches.create({...config,pushPollMs:30000});
 f.remove();
 await f.watches.confirm(7);
 assert.deepEqual(f.events.map(e=>e.kind),['pane_disappeared']);
 await f.watches.dispose();
});
test('a recognised prompt asks for a person once, a changed prompt replaces an undelivered request, and working then prompting again re-fires',async()=>{
 let block=false;const delivered:WatchEventInput[]=[];
 const g=fixture({sink:async(e:WatchEventInput)=>{if(block)throw new Error('private');delivered.push(e);}});await g.watches.create({...config,attentionMs:5000});await g.tick();
 g.setText('Which file?\n› ');await g.tick();await g.tick();await g.tick();
 assert.deepEqual(delivered.slice(0,2).map(e=>e.kind),['input_required','attention_required'],'the input request is immediate; the request for a person waits for one stable poll');
 assert.equal(delivered.filter(e=>e.kind==='attention_required').length,1,'one request for a person per unresolved prompt');
 block=true;g.setText('Which file, exactly?\n› ');await g.tick();await g.tick();
 assert.equal(g.watches.list()[0].pendingEvents,1,'a changed prompt replaces the undelivered request rather than queueing a second');
 const first=g.watches.list()[0].lastEvent!;assert.equal(first.kind,'attention_required');
 g.advance(1000);g.setText('Which file, precisely?\n› ');await g.tick();await g.tick();
 assert.equal(g.watches.list()[0].pendingEvents,1);assert.ok(g.watches.list()[0].lastEvent!.occurredAt>first.occurredAt,'a replacement carries a fresh timestamp');
 block=false;await g.tick();assert.equal(delivered.filter(e=>e.kind==='attention_required').length,2);
 g.setText('Working (1s • esc to interrupt)');await g.tick();g.setText('Which one?\n› ');await g.tick();await g.tick();
 assert.equal(delivered.filter(e=>e.kind==='attention_required').length,3,'a new prompt after working re-fires');
 await g.watches.dispose();
});
test('a worker left at a ready prompt asks for a person at attentionMs, distinctly from inactivity, and a working pane never does',async()=>{
 const f=fixture();await f.watches.create({...config,attentionMs:2000});assert.equal(f.watches.list()[0].attentionMs,2000);
 f.setText('Working (1s • esc to interrupt)');await f.tick();f.setText('done\n› ');await f.tick();assert.deepEqual(f.events.map(e=>e.kind),['ready']);
 await f.tick(1000);assert.deepEqual(f.events.map(e=>e.kind),['ready','inactive']);
 await f.tick(1000);assert.deepEqual(f.events.map(e=>e.kind),['ready','inactive','attention_required']);
 await f.tick(2000);await f.tick(2000);assert.equal(f.events.filter(e=>e.kind==='attention_required').length,1,'a stalled prompt asks once');
 f.setText('Working (9s • esc to interrupt)');await f.tick();await f.tick(3000);await f.tick(3000);
 assert.equal(f.events.filter(e=>e.kind==='attention_required').length,1,'a working pane past attentionMs is not a request for a person');
 await f.watches.dispose();
});
test('a request for a person is delivered ahead of quieter kinds and is never held by the cooldown',async()=>{
 const f=fixture();await f.watches.create({...config,cooldownMs:2000,attentionMs:5000});
 f.setText('Working (1s • esc to interrupt)');await f.tick();f.setText('done\n› ');await f.tick();assert.deepEqual(f.events.map(e=>e.kind),['ready']);
 f.setText('Which file?\n› ');await f.tick();assert.equal(f.watches.list()[0].pendingEvents,1,'input_required waits out the cooldown');
 await f.tick();
 assert.deepEqual(f.events.map(e=>e.kind),['ready','attention_required'],'delivered inside the cooldown, ahead of the queued input request');
 assert.equal(f.watches.list()[0].pendingEvents,1,'input_required still waits out the cooldown');
 await f.tick(1000);assert.deepEqual(f.events.map(e=>e.kind),['ready','attention_required','input_required']);await f.watches.dispose();
});
test('attentionMs is bounded',async()=>{
 const f=fixture();await assert.rejects(f.watches.create({...config,attentionMs:1}));await assert.rejects(f.watches.create({...config,attentionMs:3600001}));await f.watches.dispose();
});
test('a prompt whose screen is still changing asks for a person once it is stable, and never once per redraw',async()=>{
 const f=fixture();await f.watches.create({...config,attentionMs:5000,inactivityMs:60000});await f.tick();
 f.setText('Which do you prefer?\n❯ ');await f.tick();
 assert.deepEqual(f.events.map(e=>e.kind),['input_required'],'a screen seen for the first time is not yet known to be stable');
 await f.tick();assert.deepEqual(f.events.map(e=>e.kind),['input_required','attention_required'],'one poll of unchanged output makes it a request for a person');
 // The question stays in the last lines while the worker streams: the prompt classifier still says question, the hash changes every poll.
 for(let i=0;i<4;i++){f.setText(`Which do you prefer?\nline ${i}\n❯ `);await f.tick();}
 assert.equal(f.events.filter(e=>e.kind==='attention_required').length,1,'a changing screen never asks again per redraw');
 await f.tick();assert.equal(f.events.filter(e=>e.kind==='attention_required').length,2,'a new stable screen at a prompt asks once more');
 await f.tick();await f.tick();assert.equal(f.events.filter(e=>e.kind==='attention_required').length,2);
 await f.watches.dispose();
});
test('an unmanaged pane whose padding changes is not activity, so its quiet episode still fires',async()=>{
 const f=fixture();f.setText('secret output\n› ');await f.watches.create(config);await f.tick();
 f.setText('secret output     \n›   ');await f.tick();await f.tick();
 assert.deepEqual(f.events.map(e=>e.kind),['inactive']);
});
test('a notifier that rejects attention_required does not stall the other kinds of the same watch',async()=>{
 const notified:string[]=[];
 const f=fixture({notifications:{notify:async(e:WatchEventInput)=>{if(e.kind==='attention_required')throw new Error('Unsupported notification kind');notified.push(e.kind);}}});
 await f.watches.create({...config,notify:true,attentionMs:1000,inactivityMs:100000});
 f.setText('Working (1s • esc to interrupt)');await f.tick();f.setText('done\n› ');await f.tick();
 await f.tick(1000);await f.tick(1000);
 assert.deepEqual(f.events.map(e=>e.kind),['ready','attention_required'],'the request for a person still reaches the durable sink');
 f.setText('Do you want to proceed?\n› ');await f.tick();await f.tick();
 assert.ok(f.events.some(e=>e.kind==='input_required'),'an input request is delivered although the notifier keeps failing on the request for a person');
 assert.ok(notified.includes('input_required'));
 assert.equal(f.watches.list()[0].deliveryError,'Event delivery failed; retrying on the next poll.','the failing destination stays visible');
 await f.watches.dispose();
});
test('watch polling does not record observations, so a supervisor since baseline survives it',async()=>{
 const f=fixture();await f.agents.adopt({name:'w',paneId:7,cli:'codex'});
 const first=await f.agents.observe('w');
 await f.watches.create({agentId:'w',pollMs:500});
 for(let i=0;i<20;i++)await f.tick();
 const again=await f.agents.observe('w',first.observationId);
 assert.equal(again.deltaReset,false,'twenty watch polls must not evict the baseline the supervisor is holding');
 assert.equal(again.outputMode,'unchanged');
 await f.watches.dispose();
});
