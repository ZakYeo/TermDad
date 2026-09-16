import test from 'node:test';
import assert from 'node:assert/strict';
import { WezTermBackend } from '../src/backend.js';
import { Agents } from '../src/agents.js';
import { WatchManager,type WatchEventInput } from '../src/watches.js';
import { CommandNotificationProvider } from '../src/notifications.js';
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
 f.setText('Do you want to proceed?\n› Yes');await f.tick();await f.tick();assert.equal(f.events.at(-1)?.kind,'input_required');await f.tick();assert.equal(f.events.at(-1)?.kind,'inactive');
 assert.ok(!JSON.stringify(f.events).includes('secret'));assert.ok(f.events.every(e=>!Number.isNaN(Date.parse(e.occurredAt))));await f.watches.dispose();
});
test('sink failures retry independently of successful notifications, bounded cooldown and disappearance',async()=>{
 let attempts=0,notifications=0;const f=fixture({sink:async()=>{if(++attempts===1)throw new Error('private');},notifications:{notify:async()=>{notifications++;}}});
 f.setText('Do you want to proceed?');await f.watches.create({...config,notify:true,cooldownMs:1000});await f.tick();assert.match(f.watches.list()[0].deliveryError!,/retrying/);assert.equal(notifications,1);
 await f.tick();assert.equal(attempts,2);assert.equal(notifications,1);assert.equal(f.watches.list()[0].deliveryError,undefined);
 f.fail(true);await f.tick();assert.equal(f.watches.list()[0].disappeared,false);assert.match(f.watches.list()[0].backendError!,/retrying/);
 f.fail(false);f.remove();await f.tick();assert.equal(f.watches.list()[0].disappeared,true);await f.tick(1000);assert.equal(f.watches.list()[0].pendingEvents,0);assert.ok(!f.calls.includes('kill-pane'));await f.watches.dispose();
});
test('managed pane targets automatically preserve stale-prompt guard and registry cleanup',async()=>{
 const f=fixture();await f.agents.spawn({name:'worker',cli:'codex'});await f.watches.create({paneId:7,pollMs:500,cooldownMs:0});await f.agents.send('worker','test');f.agents.get('worker').lastInputAt=Date.now()-2000;await f.tick();assert.equal(f.watches.list()[0].status,'WORKING');await f.tick(2000);assert.equal(f.events.length,0);
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
test('notification command preserves literal argv, JSON stdin, timeout and failures',async()=>{
 const event:WatchEventInput={kind:'ready',paneId:7,occurredAt:new Date(0).toISOString(),summary:'Fixed summary'};let call:any;
 const p=new CommandNotificationProvider(['/trusted/program','$(never execute)'],async(...args)=>{call=args;return '';});await p.notify(event);assert.deepEqual(call,['/trusted/program',['$(never execute)'],JSON.stringify(event),5000]);
 assert.throws(()=>new CommandNotificationProvider([]));assert.throws(()=>new CommandNotificationProvider(['a\0b']));await assert.rejects(new CommandNotificationProvider(['bad'],async()=>{throw new Error('failed');}).notify(event));
});
test('successful sink is not duplicated when desktop delivery fails',async()=>{
 let sent=0,notifications=0;const f=fixture({sink:async()=>{sent++;},notifications:{notify:async()=>{if(++notifications===1)throw new Error('failed');}}});
 f.setText('Do you want to proceed?');await f.watches.create({...config,notify:true,inactivityMs:10000});await f.tick();assert.equal(sent,1);assert.ok(f.watches.list()[0].deliveryError);await f.tick();assert.equal(sent,1);assert.equal(notifications,2);assert.equal(f.watches.list()[0].pendingEvents,0);await f.watches.dispose();
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
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture({automatic:true});await f.watches.create(config);f.setText('Do you want to proceed?');f.advance(500);t.mock.timers.tick(500);await new Promise(r=>setImmediate(r));assert.equal(f.events[0].kind,'input_required');await f.watches.dispose();const count=f.calls.length;f.advance(5000);t.mock.timers.tick(5000);await new Promise(r=>setImmediate(r));assert.equal(f.calls.length,count);
});
test('MCP watch tools create, list, remove and close without closing panes',async()=>{
 const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');const {createServer}=await import('../src/server.js');
 const f=fixture();const {server,watches}=createServer(f.backend,undefined,{automatic:false});const [a,b]=InMemoryTransport.createLinkedPair();const client=new Client({name:'watch-test',version:'1'});await server.connect(a);await client.connect(b);
 try{const created=await client.callTool({name:'watch.create',arguments:config});assert.equal(created.isError,undefined);const watch=JSON.parse((created.content as any)[0].text);const listed=await client.callTool({name:'watch.list',arguments:{}});assert.equal(JSON.parse((listed.content as any)[0].text)[0].watchId,watch.watchId);await client.callTool({name:'watch.remove',arguments:{watchId:watch.watchId}});assert.deepEqual(watches.list(),[]);await client.callTool({name:'watch.create',arguments:config});}finally{await client.close();await server.close();await watches.dispose();}assert.deepEqual(watches.list(),[]);assert.ok(!f.calls.includes('kill-pane'));
});
