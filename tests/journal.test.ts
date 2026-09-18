import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile,utimes,stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { FileJournal,acquireLock,reapStaleLocks } from '../src/journal.js';
import { FileWorkerStorage } from '../src/worker-storage.js';
type S={version:1;items:string[]};
const journal=(directory:string)=>new FileJournal<S>('demo','DEMO',()=>({version:1,items:[]}),v=>v as S,directory);
async function deadPid(){const child=spawn(process.execPath,['-e','0']);const pid=child.pid!;await new Promise(r=>child.on('exit',r));return pid;}
async function directory(t:any){const d=await mkdtemp(join(tmpdir(),'term-dad-journal-'));t.after(()=>rm(d,{recursive:true,force:true}));return d;}

test('a held lock names its holder pid',async t=>{
 const d=await directory(t),j=journal(d);
 await j.transaction(true,s=>({state:s,result:undefined}));
 // Read inside the callback: the lock is released as soon as it returns.
 const seen=await j.transaction(true,s=>({state:s,result:readFileSync(join(d,'demo.lock'),'utf8')}));
 assert.equal(seen.trim(),String(process.pid));
});
test('a lock whose holder pid is dead is reclaimed and the transaction proceeds',async t=>{
 const d=await directory(t),j=journal(d);
 await j.transaction(true,s=>({state:s,result:undefined}));
 await writeFile(join(d,'demo.lock'),String(await deadPid()),{mode:0o600});
 assert.equal(await j.transaction(false,s=>({result:s.items.length})),0);
});
test('a lock held by a live pid is honoured',async t=>{
 const d=await directory(t),j=journal(d);
 await j.transaction(true,s=>({state:s,result:undefined}));
 await writeFile(join(d,'demo.lock'),String(process.pid),{mode:0o600});
 await assert.rejects(j.transaction(false,s=>({result:s})),/DEMO_STORAGE_BUSY/);
});
test('a pid-less lock is honoured while fresh and reclaimed once older than the write window',async t=>{
 const d=await directory(t),j=journal(d);
 await j.transaction(true,s=>({state:s,result:undefined}));
 const lock=join(d,'demo.lock');
 await writeFile(lock,'',{mode:0o600});
 await assert.rejects(j.transaction(false,s=>({result:s})),/DEMO_STORAGE_BUSY/);
 const old=(Date.now()-60_000)/1000;await utimes(lock,old,old);
 assert.equal(await j.transaction(false,s=>({result:s.items.length})),0);
});
test('a worker lock left by a dead process no longer blocks the worker',async t=>{
 const d=await directory(t),storage=new FileWorkerStorage(d),agentId='11111111-2222-4333-8444-555555555555';
 await writeFile(join(d,`worker-${agentId}.lock`),String(await deadPid()),{mode:0o600});
 assert.equal(await storage.exclusive(agentId,async()=>'ran'),'ran');
 await writeFile(join(d,`worker-${agentId}.lock`),String(process.pid),{mode:0o600});
 await assert.rejects(storage.exclusive(agentId,async()=>'ran'),/WORKER_BUSY/);
});
test('startup reaping removes dead-holder locks and old orphan temporaries only',async t=>{
 const d=await directory(t);
 const dead=join(d,'workers.lock'),live=join(d,'events.lock'),fresh=join(d,'tasks.lock'),oldTmp=join(d,'tasks.0b3c0f1e-1111-4222-8333-444444444444.tmp'),newTmp=join(d,'events.0b3c0f1e-1111-4222-8333-555555555555.tmp');
 await writeFile(dead,String(await deadPid()),{mode:0o600});
 await writeFile(live,String(process.pid),{mode:0o600});
 await writeFile(fresh,'',{mode:0o600});
 await writeFile(oldTmp,'{}',{mode:0o600});const old=(Date.now()-120_000)/1000;await utimes(oldTmp,old,old);
 await writeFile(newTmp,'{}',{mode:0o600});
 const removed=await reapStaleLocks(d);
 assert.deepEqual(removed.sort(),['tasks.0b3c0f1e-1111-4222-8333-444444444444.tmp','workers.lock']);
 for(const kept of [live,fresh,newTmp])await stat(kept);
 assert.deepEqual(await reapStaleLocks(join(d,'missing')),[]);
});
test('concurrent acquirers over one dead lock end with exactly one holder',async t=>{
 const d=await directory(t),lock=join(d,'race.lock');
 await writeFile(lock,String(await deadPid()),{mode:0o600});
 const outcomes=await Promise.allSettled(Array.from({length:8},()=>acquireLock(lock)));
 const holders=outcomes.filter(o=>o.status==='fulfilled');
 assert.equal(holders.length,1,'the stale lock is reclaimed once and every other acquirer sees it held');
 for(const o of outcomes)if(o.status==='rejected')assert.equal((o.reason as NodeJS.ErrnoException).code,'EEXIST');
 assert.equal((await stat(lock)).isFile(),true,'the winner\'s lock is still in place');
 await (holders[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireLock>>>).value.close();
 assert.equal(await stat(join(d,'reclaim.lock')).catch(()=>null),null,'the reclaim guard is released');
});
