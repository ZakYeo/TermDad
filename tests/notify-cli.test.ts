import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notifyRequest,resolveRequest,sendPush } from '../src/term-dad-notify.js';
import { PushIngress,PushSocket } from '../src/ingress.js';
import { PushCredentialStore,credentialPath } from '../src/push-credentials.js';
import { randomUUID } from 'node:crypto';
test('explicit kinds and codex payloads map onto the server push contract',async()=>{
 const base=['--socket','/s.sock','--token','t'];
 assert.deepEqual(notifyRequest([...base,'--kind','ready'],''),{target:{socketPath:'/s.sock',token:'t'},kind:'ready'});
 assert.equal(notifyRequest([...base,'--codex'],JSON.stringify({type:'agent-turn-complete'}))!.kind,'ready');
 assert.equal(notifyRequest([...base,'--codex'],JSON.stringify({type:'agent-approval-request'}))!.kind,'input_required');
 // Inline flags stay supported: a worker launched by an earlier build has them baked into argv.
 assert.deepEqual(await resolveRequest(notifyRequest([...base,'--kind','ready'],'')!),{socketPath:'/s.sock',line:'{"token":"t","kind":"ready"}'});
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
test('a hook resolves its socket and token from its credential file at fire time',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'term-dad-notify-cred-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const agentId=randomUUID(),store=new PushCredentialStore(directory);
 const path=await store.write({version:1,agentId,socketPath:'/run/push.1.sock',token:'first-token'});
 assert.deepEqual(notifyRequest(['--credential',path,'--kind','ready'],''),{target:{credentialPath:path},kind:'ready'});
 assert.deepEqual(await resolveRequest({target:{credentialPath:path},kind:'ready'}),{socketPath:'/run/push.1.sock',line:'{"token":"first-token","kind":"ready"}'});
 // A re-key replaces the file under a live worker, whose argv never changed.
 await store.write({version:1,agentId,socketPath:'/run/push.2.sock',token:'second-token'});
 assert.deepEqual(await resolveRequest({target:{credentialPath:path},kind:'ready'}),{socketPath:'/run/push.2.sock',line:'{"token":"second-token","kind":"ready"}'});
 // A credential path wins over stale inline flags, so a revoked token can never be used.
 const both=notifyRequest(['--socket','/stale.sock','--token','revoked','--credential',path,'--kind','ready'],'')!;
 assert.deepEqual(await resolveRequest(both),{socketPath:'/run/push.2.sock',line:'{"token":"second-token","kind":"ready"}'});
});
test('an unmodelled event is resolved without reading the credential file',()=>{
 const absent=credentialPath('/nonexistent',randomUUID());
 assert.equal(notifyRequest(['--credential',absent,'--codex'],'{"type":"unknown-event"}'),undefined);
});
test('an unreadable credential fails explicitly and leaves the worker unaffected',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'term-dad-notify-bad-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const absent=credentialPath(directory,randomUUID());
 const request=notifyRequest(['--credential',absent,'--kind','ready'],'')!;
 await assert.rejects(resolveRequest(request),/PUSH_CREDENTIAL_UNREADABLE/);
});
