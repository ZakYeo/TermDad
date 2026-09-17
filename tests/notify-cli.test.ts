import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notifyRequest,sendPush } from '../src/term-dad-notify.js';
import { PushIngress,PushSocket } from '../src/ingress.js';
test('explicit kinds and codex payloads map onto the server push contract',()=>{
 const base=['--socket','/s.sock','--token','t'];
 assert.deepEqual(notifyRequest([...base,'--kind','ready'],''),{socketPath:'/s.sock',line:'{"token":"t","kind":"ready"}'});
 assert.deepEqual(notifyRequest([...base,'--codex'],JSON.stringify({type:'agent-turn-complete'})).line,'{"token":"t","kind":"ready"}');
 assert.deepEqual(notifyRequest([...base,'--codex'],JSON.stringify({type:'agent-approval-request'})).line,'{"token":"t","kind":"input_required"}');
});
test('unusable invocations are rejected rather than guessed at',()=>{
 assert.throws(()=>notifyRequest(['--token','t','--kind','ready'],''),/--socket/);
 assert.throws(()=>notifyRequest(['--socket','/s.sock','--kind','ready'],''),/--token/);
 assert.throws(()=>notifyRequest(['--socket','/s.sock','--token','t'],''),/--kind/);
 assert.throws(()=>notifyRequest(['--socket','/s.sock','--token','t','--kind','rm -rf'],''),/--kind/);
 assert.equal(notifyRequest(['--socket','/s.sock','--token','t','--codex'],'{"type":"unknown-event"}'),undefined);
});
test('a push reaches a listening server and a missing server fails without hanging the worker',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'term-dad-notify-'));
 const pushes:any[]=[];
 const ingress=new PushIngress({sink:async p=>{pushes.push(p);}});
 const socket=new PushSocket(ingress,join(directory,'push.sock'));
 t.after(async()=>{await socket.close();await rm(directory,{recursive:true,force:true});});
 await socket.listen();
 const {token}=ingress.register('worker-1',7);ingress.setEnabled('worker-1',true);
 assert.deepEqual(await sendPush(socket.path,JSON.stringify({token,kind:'ready'})),{ok:true,delivered:true});
 assert.deepEqual(pushes.map(p=>p.kind),['ready']);
 await assert.rejects(sendPush(join(directory,'absent.sock'),'{}',200));
});
