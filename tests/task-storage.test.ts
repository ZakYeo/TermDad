import test from 'node:test';
import { completeTask } from './task-support.js';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,writeFile,stat,access,chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskBoard } from '../src/tasks.js';
import { FileTaskStorage } from '../src/task-storage.js';
const input={boardId:'repo',title:'Durable task',goal:'Survive restart'};
async function fixture(t:any){const directory=await mkdtemp(join(tmpdir(),'term-dad-tasks-'));t.after(()=>rm(directory,{recursive:true,force:true}));return {directory,storage:new FileTaskStorage(directory)};}

test('file tasks survive new instances with assignments, dependencies, criteria, revisions and archive state',async t=>{
 const {directory,storage}=await fixture(t),board=new TaskBoard(storage);
 const prerequisite=await board.create(input);
 await completeTask(board,prerequisite.id);
 const task=await board.create({...input,dependencies:[prerequisite.id],acceptanceCriteria:[{id:'test',description:'Checked',satisfied:true,evidence:'Confirmed'}]});
 const archived=await board.archive({taskId:task.id,expectedRevision:1,archived:true});await board.close();
 const restarted=new TaskBoard(new FileTaskStorage(directory));
 assert.deepEqual(await restarted.get(task.id),archived);
 assert.equal((await restarted.list({includeArchived:true})).total,2);
 assert.equal((await stat(join(directory,'tasks.json'))).mode&0o777,0o600);
 assert.equal((await stat(directory)).mode&0o777,0o700);
});

test('cross-instance transactions keep all records and reject conflicting revisions',async t=>{
 const {directory,storage}=await fixture(t),first=new TaskBoard(storage),second=new TaskBoard(new FileTaskStorage(directory));
 const created=await Promise.all(Array.from({length:8},(_,i)=>(i%2?first:second).create({...input,title:`Task ${i}`})));
 assert.equal((await first.list()).total,8);
 const results=await Promise.allSettled([first,second].map(board=>board.update({taskId:created[0].id,expectedRevision:1,patch:{title:'Updated'}})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.match(String((results.find(r=>r.status==='rejected') as PromiseRejectedResult).reason),/TASK_REVISION_CONFLICT/);
 assert.equal((await second.get(created[0].id)).revision,2);
});

test('reads are lazy; corruption, invalid graphs, oversize files and unsafe permissions are preserved',async t=>{
 const {directory,storage}=await fixture(t),absent=join(directory,'absent'),lazy=new TaskBoard(new FileTaskStorage(absent));
 assert.equal((await lazy.list()).total,0);await assert.rejects(access(absent));
 const board=new TaskBoard(storage),task=await board.create(input),path=join(directory,'tasks.json'),valid=await readFile(path,'utf8');
 for(const invalid of ['not-json',JSON.stringify({...JSON.parse(valid),version:3}),'x'.repeat(4_000_001)]){
  await writeFile(path,invalid);await assert.rejects(board.list(),/TASK_STATE_CORRUPT/);assert.equal(await readFile(path,'utf8'),invalid);
 }
 const broken=JSON.parse(valid);broken.tasks[0].dependencies=[task.id];await writeFile(path,JSON.stringify(broken));
 await assert.rejects(board.get(task.id),/TASK_STATE_CORRUPT/);
 await writeFile(path,valid);await chmod(path,0o644);await assert.rejects(board.list(),/TASK_STATE_CORRUPT/);
 await chmod(path,0o600);await chmod(directory,0o755);await assert.rejects(board.list(),/TASK_STORAGE_UNSAFE/);
 await chmod(directory,0o700);assert.equal((await board.get(task.id)).id,task.id);
});

test('failed mutations and stale locks preserve committed state; orphan temporary files never override it',async t=>{
 const {directory,storage}=await fixture(t),board=new TaskBoard(storage),task=await board.create(input);
 const path=join(directory,'tasks.json'),before=await readFile(path,'utf8');
 await assert.rejects(storage.transaction(true,state=>{state.tasks=[];throw new Error('failed mutation');}),/failed mutation/);
 await assert.rejects(storage.transaction(true,state=>{state.tasks[0].title='x'.repeat(201);return {state,result:null};}),/TASK_STATE_INVALID/);
 await assert.rejects(storage.transaction(false,state=>({state,result:null})),/TASK_STORAGE_READ_ONLY/);
 assert.equal(await readFile(path,'utf8'),before);
 await writeFile(join(directory,'tasks.orphan.tmp'),'incomplete',{mode:0o600});
 await writeFile(join(directory,'tasks.lock'),'');await assert.rejects(board.list(),/TASK_STORAGE_BUSY/);
 assert.equal(await readFile(path,'utf8'),before);await rm(join(directory,'tasks.lock'));
 assert.equal((await board.get(task.id)).id,task.id);
});

test('post-commit durability warnings preserve successful result and are observable on list',async t=>{
 const {directory}=await fixture(t);
 class UnsyncedStorage extends FileTaskStorage {protected override async syncDirectory(){throw new Error('sync failed');}}
 const board=new TaskBoard(new UnsyncedStorage(directory)),created=await board.create(input);
 const page=await board.list();assert.equal(page.total,1);assert.match(page.storageWarning??'',/TASK_DURABILITY_WARNING/);
 assert.equal((await new TaskBoard(new FileTaskStorage(directory)).get(created.id)).id,created.id);
});
