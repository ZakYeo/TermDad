import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod,mkdtemp,readFile,readdir,rm,stat,symlink,writeFile,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PushCredentialStore,credentialDirectory,credentialPath,readCredential } from '../src/push-credentials.js';
const token='tok-'+'a'.repeat(40);
async function store(t:any){
 const directory=await mkdtemp(join(tmpdir(),'term-dad-cred-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 return {directory,store:new PushCredentialStore(directory)};
}
test('a credential is written atomically and owner-only, into an owner-only private directory',async t=>{
 const f=await store(t);const agentId=randomUUID();
 const path=await f.store.write({version:1,agentId,socketPath:'/run/push.1.sock',token});
 assert.equal(path,credentialPath(f.directory,agentId));
 assert.equal((await stat(path)).mode&0o777,0o600,'a credential is never group or world readable');
 assert.equal((await stat(credentialDirectory(f.directory))).mode&0o777,0o700);
 assert.deepEqual(JSON.parse(await readFile(path,'utf8')),{version:1,agentId,socketPath:'/run/push.1.sock',token});
 await f.store.write({version:1,agentId,socketPath:'/run/push.2.sock',token:token+'x'});
 assert.equal((await readCredential(path)).socketPath,'/run/push.2.sock','a re-key replaces in place, so baked argv keeps working');
 assert.deepEqual((await readdir(credentialDirectory(f.directory))).filter(n=>n.endsWith('.tmp')),[],'no temporary file is left behind');
});
test('an unsafe credential file is refused rather than read',async t=>{
 const f=await store(t);const agentId=randomUUID();
 const path=await f.store.write({version:1,agentId,socketPath:'/run/push.1.sock',token});
 await chmod(path,0o644);
 await assert.rejects(readCredential(path),/PUSH_CREDENTIAL_UNREADABLE/,'a world-readable credential is not trusted');
 await chmod(path,0o600);
 await writeFile(path,'x'.repeat(5000),{mode:0o600});
 await assert.rejects(readCredential(path),/PUSH_CREDENTIAL_UNREADABLE/,'an oversized credential is refused');
 await writeFile(path,'{ broken',{mode:0o600});
 await assert.rejects(readCredential(path),/PUSH_CREDENTIAL_UNREADABLE/);
 await assert.rejects(readCredential(join(f.directory,'absent.json')),/PUSH_CREDENTIAL_UNREADABLE/);
 // A symlink at the target must never be followed, nor its destination overwritten.
 const other=randomUUID(),elsewhere=join(f.directory,'elsewhere');
 await writeFile(elsewhere,'untouched',{mode:0o600});
 await mkdir(credentialDirectory(f.directory),{recursive:true,mode:0o700});
 await symlink(elsewhere,credentialPath(f.directory,other));
 await assert.rejects(f.store.write({version:1,agentId:other,socketPath:'/s',token}),/PUSH_CREDENTIAL_PATH_OCCUPIED/);
 assert.equal(await readFile(elsewhere,'utf8'),'untouched');
 await assert.rejects(readCredential(credentialPath(f.directory,other)),/PUSH_CREDENTIAL_UNREADABLE/);
});
test('a credential error names the path and never the token',async t=>{
 const f=await store(t);const agentId=randomUUID();
 await f.store.write({version:1,agentId,socketPath:'/run/push.1.sock',token});
 const directory=credentialDirectory(f.directory);
 await chmod(directory,0o500);
 try{
  const error=await f.store.write({version:1,agentId:randomUUID(),socketPath:'/s',token}).then(()=>undefined,(e:Error)=>e);
  assert.match(error!.message,/PUSH_CREDENTIAL_UNWRITABLE/);
  assert.ok(error!.message.includes(directory),'the remediation names where to look');
  assert.ok(!error!.message.includes(token),'a diagnostic never carries a token');
 }finally{await chmod(directory,0o700);}
});
test('a sweep removes only credentials whose worker is absent from the durable set',async t=>{
 const f=await store(t);const live=randomUUID(),gone=randomUUID();
 await f.store.write({version:1,agentId:live,socketPath:'/run/push.1.sock',token});
 await f.store.write({version:1,agentId:gone,socketPath:'/run/push.1.sock',token});
 await writeFile(join(credentialDirectory(f.directory),'not-a-credential.txt'),'ignore me',{mode:0o600});
 const before=await readFile(credentialPath(f.directory,live),'utf8');
 assert.equal(await f.store.sweep(new Set([live])),1);
 assert.equal(await readFile(credentialPath(f.directory,live),'utf8'),before,'a surviving worker is never touched');
 await assert.rejects(stat(credentialPath(f.directory,gone)));
 assert.ok((await readdir(credentialDirectory(f.directory))).includes('not-a-credential.txt'),'a sweep only removes what it recognises');
 assert.equal(await f.store.sweep(new Set([live])),0);
 assert.equal(await new PushCredentialStore(join(f.directory,'absent')).sweep(new Set()),0,'sweeping an absent store is a no-op');
});
test('removing a credential is idempotent and never throws',async t=>{
 const f=await store(t);const agentId=randomUUID();
 await f.store.write({version:1,agentId,socketPath:'/run/push.1.sock',token});
 await f.store.remove(agentId);
 await assert.rejects(stat(credentialPath(f.directory,agentId)));
 await f.store.remove(agentId);
 await f.store.remove(randomUUID());
});
test('the server-side store exposes no way to read a credential back',async t=>{
 const f=await store(t);
 assert.equal(typeof (f.store as any).read,'undefined');
 assert.ok(!Object.getOwnPropertyNames(PushCredentialStore.prototype).includes('read'),'credentials must never be loadable into server state');
});
