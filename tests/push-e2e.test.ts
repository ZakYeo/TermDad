import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.js';
import { WezTermBackend } from '../src/backend.js';
import { EventQueue,FileEventStorage } from '../src/events.js';
import { FileWorkerStorage } from '../src/worker-storage.js';
import { FileTaskStorage } from '../src/task-storage.js';
import { sendPush } from '../src/term-dad-notify.js';
import { inputKind } from '../src/interaction.js';
test('an enabled worker push becomes a durable event and releases a waiting supervisor',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'term-dad-push-e2e-'));
 let text='Do you want to proceed?\n› Yes';
 const backend=new WezTermBackend(async args=>{
  if(args[0]==='list')return JSON.stringify([{pane_id:7,tab_id:1,window_id:1,title:'t',cwd:'/',size:{rows:24,cols:80}}]);
  if(args[0]==='spawn')return '7';
  if(args[0]==='get-text')return text;
  return '';
 },async()=>null);
 const events=new EventQueue(new FileEventStorage(directory));
 process.env.TERM_DAD_STATE_DIR=directory;
 const term=createServer(backend,{capture:async()=>({type:'image',data:'',mimeType:'image/png'})} as any,{},events,new FileWorkerStorage(directory),new FileTaskStorage(directory));
 t.after(async()=>{await term.pushSocket.close();await term.watches.dispose();await events.close();await rm(directory,{recursive:true,force:true});});
 const {agentId}=await term.agents.spawn({name:'w',cli:'claude'} as any);
 const socketPath=await term.pushReady;
 const token=(term.ingress as any).byAgent.get(agentId).token;
 await term.watches.create({agentId,pushPollMs:30000,cooldownMs:0});
 const waiting=events.wait({agentIds:[agentId]},5000);
 await term.pushReady;
 const enabled=term.push.setEnabled(agentId,true);
 assert.equal(enabled.proven,false,'enabling claims nothing about delivery');
 assert.equal(enabled.deliverable,true,'every link this server can see is live');
 assert.deepEqual(await sendPush(socketPath,JSON.stringify({token,kind:'input_required'})),{ok:true,delivered:true});
 const woken:any=await waiting;
 assert.equal(woken.status,'event');
 assert.equal(woken.event.agentId,agentId);
 const kinds=(await events.list({},true,100)).events.map(e=>e.kind);
 assert.ok(kinds.includes('input_required'));
 // The pushed event is corroborated by a sample of the pane, not trusted on the worker's word.
 assert.ok(inputKind(term.watches.list()[0].status!)!==null,`sampled status was ${term.watches.list()[0].status}`);
 // Only an observed worker push establishes that the channel works end to end.
 const proved=await term.push.status(agentId);
 assert.equal(proved.proven,true);
 assert.equal(proved.deliveries.count,1);
 assert.equal(proved.deliveries.lastKind,'input_required');
 assert.ok(!JSON.stringify(proved).includes(token),'no push result carries a token');
});
