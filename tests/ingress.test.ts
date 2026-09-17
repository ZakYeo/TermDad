import test from 'node:test';
import assert from 'node:assert/strict';
import { PushIngress,pushKinds } from '../src/ingress.js';
function fixture(){
 const pushes:any[]=[];
 const ingress=new PushIngress({sink:async p=>{pushes.push(p);},now:()=>1700000000000});
 return {ingress,pushes};
}
test('push is off until explicitly enabled for that pane; a disabled token delivers nothing',async()=>{
 const {ingress,pushes}=fixture();
 const {token}=ingress.register('worker-1',7);
 assert.equal(ingress.status('worker-1').enabled,false);
 assert.deepEqual(await ingress.handle(JSON.stringify({token,kind:'ready'})),{ok:true,delivered:false});
 assert.deepEqual(pushes,[]);
 ingress.setEnabled('worker-1',true);
 assert.equal(ingress.status('worker-1').enabled,true);
 assert.deepEqual(await ingress.handle(JSON.stringify({token,kind:'ready'})),{ok:true,delivered:true});
 ingress.setEnabled('worker-1',false);
 assert.deepEqual(await ingress.handle(JSON.stringify({token,kind:'ready'})),{ok:true,delivered:false});
 assert.equal(pushes.length,1);
});
test('an enabled token pushes a server-authored event; the worker never supplies its text',async()=>{
 const {ingress,pushes}=fixture();
 const {token}=ingress.register('worker-1',7);ingress.setEnabled('worker-1',true);
 assert.deepEqual(await ingress.handle(JSON.stringify({token,kind:'input_required',summary:'attacker text'})),{ok:true,delivered:true});
 assert.deepEqual(pushes,[{kind:'input_required',paneId:7,agentId:'worker-1',occurredAt:new Date(1700000000000).toISOString(),summary:'Worker reported that it needs input.'}]);
});
test('unknown, revoked and malformed pushes are refused without reaching the sink',async()=>{
 const {ingress,pushes}=fixture();
 const {token}=ingress.register('worker-1',7);ingress.setEnabled('worker-1',true);
 assert.match((await ingress.handle(JSON.stringify({token:'nope',kind:'ready'}))).error!,/PUSH_UNAUTHORIZED/);
 assert.match((await ingress.handle(JSON.stringify({token,kind:'sudo'}))).error!,/PUSH_INPUT_INVALID/);
 assert.match((await ingress.handle('{broken')).error!,/PUSH_INPUT_INVALID/);
 assert.match((await ingress.handle('x'.repeat(4097))).error!,/PUSH_INPUT_INVALID/);
 ingress.revoke('worker-1');
 assert.match((await ingress.handle(JSON.stringify({token,kind:'ready'}))).error!,/PUSH_UNAUTHORIZED/);
 assert.throws(()=>ingress.setEnabled('worker-1',true),/PUSH_UNKNOWN_WORKER/);
 assert.deepEqual(pushes,[]);
});
test('every accepted kind is distinct, bounded and summarised by the server',async()=>{
 const {ingress,pushes}=fixture();
 const {token}=ingress.register('worker-1',7);ingress.setEnabled('worker-1',true);
 for(const kind of pushKinds)assert.deepEqual(await ingress.handle(JSON.stringify({token,kind})),{ok:true,delivered:true});
 assert.deepEqual(pushes.map(p=>p.kind),[...pushKinds]);
 assert.ok(pushes.every(p=>p.summary.length>0&&p.summary.length<=240));
});
test('a sink failure is reported to the hook and never crashes the ingress',async()=>{
 const ingress=new PushIngress({sink:async()=>{throw new Error('secret sink detail');}});
 const {token}=ingress.register('worker-1',7);ingress.setEnabled('worker-1',true);
 const result=await ingress.handle(JSON.stringify({token,kind:'ready'}));
 assert.match(result.error!,/PUSH_DELIVERY_FAILED/);
 assert.ok(!result.error!.includes('secret sink detail'));
});

import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp,rm,stat,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PushSocket } from '../src/ingress.js';
async function socketFixture(t:any){
 const directory=await mkdtemp(join(tmpdir(),'term-dad-push-'));
 const pushes:any[]=[];
 const ingress=new PushIngress({sink:async p=>{pushes.push(p);}});
 const socket=new PushSocket(ingress,join(directory,'push.sock'));
 t.after(async()=>{await socket.close();await rm(directory,{recursive:true,force:true});});
 return {directory,ingress,socket,pushes};
}
const request=(path:string,line:string)=>new Promise<string>((resolve,reject)=>{
 const client=connect(path);let reply='';
 client.on('error',reject);client.setEncoding('utf8');
 client.on('data',d=>{reply+=d;});client.on('close',()=>resolve(reply.trim()));
 client.end(line+'\n');
});
test('the socket accepts local hook requests, is owner-only and replaces a crashed socket file',async t=>{
 const {ingress,socket,pushes}=await socketFixture(t);
 // A process that dies without closing leaves its socket file behind; recovery must not need a manual cleanup.
 await new Promise<void>((resolve,reject)=>{const child=spawn(process.execPath,['-e',`require('net').createServer().listen(${JSON.stringify(socket.path)},()=>process.exit(0))`]);child.on('error',reject);child.on('exit',()=>resolve());});
 assert.ok((await stat(socket.path)).isSocket());
 const path=await socket.listen();
 assert.equal((await stat(path)).mode&0o777,0o600);
 const {token}=ingress.register('worker-1',7);ingress.setEnabled('worker-1',true);
 assert.deepEqual(JSON.parse(await request(path,JSON.stringify({token,kind:'ready'}))),{ok:true,delivered:true});
 assert.deepEqual(pushes.map(p=>p.agentId),['worker-1']);
});
test('a non-socket file at the socket path is never replaced',async t=>{
 const {socket}=await socketFixture(t);
 await writeFile(socket.path,'not a socket',{mode:0o600});
 await assert.rejects(socket.listen(),/PUSH_SOCKET_PATH_OCCUPIED/);
 assert.equal((await stat(socket.path)).isFile(),true);
});
test('an oversized or silent connection is dropped without affecting later pushes',async t=>{
 const {ingress,socket,pushes}=await socketFixture(t);
 const path=await socket.listen();
 const {token}=ingress.register('worker-1',7);ingress.setEnabled('worker-1',true);
 assert.match(JSON.parse(await request(path,'y'.repeat(9000))).error,/PUSH_INPUT_INVALID/);
 assert.deepEqual(JSON.parse(await request(path,JSON.stringify({token,kind:'input_required'}))),{ok:true,delivered:true});
 assert.equal(pushes.length,1);
 await socket.close();
 await assert.rejects(request(path,'{}'));
});

import { readdir } from 'node:fs/promises';
import { pushSocketPath } from '../src/ingress.js';
test('concurrent servers use distinct sockets and sweep the sockets of crashed peers',async t=>{
 const {directory,ingress,socket}=await socketFixture(t);
 assert.notEqual(pushSocketPath(directory,111),pushSocketPath(directory,222));
 assert.ok(pushSocketPath(directory,111).startsWith(directory));
 const peer=new PushSocket(new PushIngress({sink:async()=>{}}),pushSocketPath(directory,222));
 t.after(()=>peer.close());
 // A crashed peer's socket file is left behind but refuses connections.
 const abandoned=pushSocketPath(directory,333);
 await new Promise<void>((resolve,reject)=>{const child=spawn(process.execPath,['-e',`require('net').createServer().listen(${JSON.stringify(abandoned)},()=>process.exit(0))`]);child.on('error',reject);child.on('exit',()=>resolve());});
 await socket.listen();await peer.listen();
 const {token}=ingress.register('worker-1',7);ingress.setEnabled('worker-1',true);
 assert.deepEqual(JSON.parse(await request(socket.path,JSON.stringify({token,kind:'ready'}))),{ok:true,delivered:true});
 assert.deepEqual(JSON.parse(await request(peer.path,JSON.stringify({token,kind:'ready'}))).error,'PUSH_UNAUTHORIZED: unknown or revoked push token');
 const remaining=await readdir(directory);
 assert.ok(!remaining.includes('push.333.sock'),'a dead peer socket is removed');
 assert.equal(remaining.filter(f=>f.endsWith('.sock')).length,2,'live sockets are never swept');
});
test('a registration counts only the pushes its sink actually accepted',async()=>{
 let fail=false;const delivered:string[]=[];
 const clock={ms:Date.parse('2026-09-17T12:00:00.000Z')};
 const ingress=new PushIngress({sink:async e=>{if(fail)throw new Error('private sink failure');delivered.push(e.kind);},now:()=>clock.ms});
 const {token}=ingress.register('worker-1',7);
 assert.deepEqual(ingress.status('worker-1').deliveries,{count:0,lastAt:null,lastKind:null},'nothing is claimed before a hook fires');
 assert.equal(ingress.status('worker-1').proven,false);
 // A push against a disabled registration is a successful no-op and proves nothing.
 assert.deepEqual(await ingress.handle(JSON.stringify({token,kind:'ready'})),{ok:true,delivered:false});
 assert.equal(ingress.status('worker-1').deliveries.count,0,'a dropped push is not a delivery');
 ingress.setEnabled('worker-1',true);
 fail=true;
 assert.match((await ingress.handle(JSON.stringify({token,kind:'ready'}))).error!,/PUSH_DELIVERY_FAILED/);
 assert.equal(ingress.status('worker-1').deliveries.count,0,'a failed sink is not a delivery');
 fail=false;
 clock.ms+=1000;
 assert.deepEqual(await ingress.handle(JSON.stringify({token,kind:'input_required'})),{ok:true,delivered:true});
 const view=ingress.status('worker-1');
 assert.equal(view.deliveries.count,1);
 assert.equal(view.deliveries.lastKind,'input_required');
 assert.equal(view.deliveries.lastAt,new Date(clock.ms).toISOString());
 assert.equal(view.proven,true,'an observed worker push is the only thing that proves delivery');
 assert.deepEqual(delivered,['input_required']);
 assert.ok(!JSON.stringify(view).includes(token),'no view ever carries a token');
});
