import test from 'node:test';
import assert from 'node:assert/strict';
import { Agents } from '../src/agents.js';
import { WezTermBackend } from '../src/backend.js';
import { PushIngress } from '../src/ingress.js';
import { WorkerPushRegistry } from '../src/push-workers.js';
function fixture(){
 const spawns:string[][]=[];
 const backend=new WezTermBackend(async(args)=>{
  if(args[0]==='list')return JSON.stringify([{pane_id:7,tab_id:1,window_id:1,title:'t',cwd:'/',size:{rows:24,cols:80}}]);
  if(args[0]==='spawn'){spawns.push(args);return '7';}
  if(args[0]==='get-text')return 'OpenAI Codex\n› ';
  return '';
 },async()=>null);
 const ingress=new PushIngress({sink:async()=>{}});
 const push=new WorkerPushRegistry(ingress,'/run/term-dad/push.sock',['/usr/bin/node','/opt/notify.js']);
 push.attach({listening:true});
 return {agents:new Agents(backend,undefined,push),ingress,push,spawns};
}
test('a spawned worker carries inert push plumbing and stays disabled until it is turned on',async()=>{
 const f=fixture();
 const {agentId}=await f.agents.spawn({name:'w','cli':'claude'} as any);
 const argv=f.spawns[0].join(' ');
 assert.ok(argv.includes('--settings'),'push hooks are injected at launch so enabling needs no restart');
 assert.ok(argv.includes('/run/term-dad/push.sock'));
 assert.equal(f.ingress.status(agentId).enabled,false,'push is off by default');
 assert.equal(f.ingress.status(agentId).paneId,7,'the registration is bound to the spawned pane');
 assert.equal(f.push.setEnabled(agentId,true).enabled,true);
});
test('push registration is released when a worker is stopped or forgotten',async()=>{
 const f=fixture();
 const {agentId}=await f.agents.spawn({name:'w',cli:'claude'} as any);
 await f.agents.forget(agentId);
 assert.throws(()=>f.ingress.status(agentId),/PUSH_UNKNOWN_WORKER/);
 const second=await f.agents.spawn({name:'w2',cli:'codex'} as any);
 assert.ok(f.spawns[1].join(' ').includes('notify='),'codex workers get a notify program instead of hooks');
 await f.agents.stop(second.agentId);
 assert.throws(()=>f.ingress.status(second.agentId),/PUSH_UNKNOWN_WORKER/);
});
test('a shell worker is launched unmodified and cannot be enabled for push',async()=>{
 const f=fixture();
 const {agentId}=await f.agents.spawn({name:'sh',cli:'shell'} as any);
 assert.ok(!f.spawns[0].join(' ').includes('push.sock'));
 assert.throws(()=>f.push.setEnabled(agentId,true),/PUSH_UNSUPPORTED_WORKER/);
});
test('a channel is only deliverable once the socket this server owns has actually bound',async()=>{
 const f=fixture();
 const {agentId}=await f.agents.spawn({name:'w',cli:'claude'} as any);
 assert.equal(f.push.deliverable(agentId),false,'delivery needs an explicit enable');
 f.push.setEnabled(agentId,true);
 assert.equal(f.push.deliverable(agentId),true);
 assert.deepEqual(f.push.socket(),{path:'/run/term-dad/push.sock',listening:true,bindError:undefined});
 // A server that could not bind still reports enabled intent, but nothing can reach it.
 f.push.attach({listening:false,bindError:'PUSH_SOCKET_PATH_OCCUPIED: refusing to replace a non-socket file'});
 assert.equal(f.push.status(agentId).enabled,true,'the worker-side intent is unchanged');
 assert.equal(f.push.deliverable(agentId),false,'an unbound socket is not deliverable');
 assert.match(f.push.socket().bindError!,/PUSH_SOCKET_PATH_OCCUPIED/);
 assert.equal(f.push.deliverable('absent'),false,'an unknown worker is never deliverable');
});
