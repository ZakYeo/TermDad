import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TaskBoard } from '../src/tasks.js';
import { MemoryTaskStorage,type TaskStorage } from '../src/task-storage.js';
import { emptyTaskState,MAX_TASKS,validateTaskState } from '../src/task-model.js';

const input=(title='Implement feature',extra:Record<string,unknown>={})=>({boardId:'term-dad',title,goal:'Meet the recorded requirements',...extra});
const fixture=()=>{const storage=new MemoryTaskStorage();return {storage,board:new TaskBoard(storage)};};

test('task metadata survives board replacement and worker absence without dispatch or inferred completion',async()=>{
 const {storage,board}=fixture(),worker=randomUUID();
 const task=await board.create(input('Feature',{assignedAgentId:worker,acceptanceCriteria:[{id:'check',description:'Checks pass'}]}));
 await board.close();const next=new TaskBoard(storage);
 assert.deepEqual(await next.get(task.id),task);
 assert.equal((await next.list({assignedAgentId:worker})).total,1);
 assert.equal(task.status,'todo');assert.equal(task.ready,true);
 const unassigned=await next.assign({taskId:task.id,expectedRevision:1,agentId:null});
 assert.equal(unassigned.assignedAgentId,null);assert.equal(unassigned.revision,2);
 assert.equal((await next.list({assignedAgentId:null})).total,1);
 await assert.rejects(board.list(),/TASK_BOARD_CLOSED/);
});

test('completion requires explicit criteria, blockers and completed dependencies; failed mutations roll back',async()=>{
 const {board}=fixture();const dependency=await board.create(input('Dependency'));
 const task=await board.create(input('Dependent',{dependencies:[dependency.id],blockers:['Waiting for review'],acceptanceCriteria:[{id:'checks',description:'Checks pass'}]}));
 assert.equal(task.ready,false);assert.deepEqual(task.unresolvedDependencyIds,[dependency.id]);
 await assert.rejects(board.update({taskId:task.id,expectedRevision:1,patch:{status:'done'}}),/TASK_COMPLETION_BLOCKED/);
 assert.equal((await board.get(task.id)).revision,1);
 await board.update({taskId:dependency.id,expectedRevision:1,patch:{status:'done'}});
 await assert.rejects(board.update({taskId:task.id,expectedRevision:1,patch:{status:'done',blockers:[]}}),/TASK_COMPLETION_BLOCKED/);
 const done=await board.update({taskId:task.id,expectedRevision:1,patch:{status:'done',blockers:[],acceptanceCriteria:[{id:'checks',description:'Checks pass',satisfied:true,evidence:'npm run check passed'}]}});
 assert.equal(done.status,'done');assert.equal(done.ready,false);assert.equal(done.blocked,false);
 // Reopening a prerequisite cannot silently invalidate a completed dependent.
 await assert.rejects(board.update({taskId:dependency.id,expectedRevision:2,patch:{status:'todo'}}),/TASK_COMPLETION_BLOCKED/);
 assert.equal((await board.get(dependency.id)).status,'done');
 await board.update({taskId:task.id,expectedRevision:2,patch:{status:'todo'}});
 await board.update({taskId:dependency.id,expectedRevision:2,patch:{status:'todo'}});
 assert.equal((await board.get(task.id)).blocked,true);
});

test('dependencies reject missing IDs, cross-board links, duplicates, self references and multi-node cycles',async()=>{
 const {board}=fixture(),a=await board.create(input('A')),b=await board.create(input('B',{dependencies:[a.id]}));
 await assert.rejects(board.create(input('Missing',{dependencies:[randomUUID()]})),/TASK_DEPENDENCY_MISSING/);
 await assert.rejects(board.create(input('Cross board',{boardId:'other',dependencies:[a.id]})),/TASK_DEPENDENCY_BOARD_MISMATCH/);
 await assert.rejects(board.create(input('Duplicate',{dependencies:[a.id,a.id]})),/TASK_DUPLICATE_DEPENDENCY/);
 await assert.rejects(board.update({taskId:a.id,expectedRevision:1,patch:{dependencies:[a.id]}}),/TASK_DEPENDENCY_CYCLE/);
 const c=await board.create(input('C',{dependencies:[b.id]}));
 await assert.rejects(board.update({taskId:a.id,expectedRevision:1,patch:{dependencies:[c.id]}}),/TASK_DEPENDENCY_CYCLE/);
 assert.equal((await board.list()).total,3);assert.deepEqual((await board.get(a.id)).dependencies,[]);
});

test('shared-storage supervisors use revision checks to reject stale concurrent changes',async()=>{
 const {storage,board}=fixture(),other=new TaskBoard(storage),task=await board.create(input());
 const results=await Promise.allSettled([
  board.update({taskId:task.id,expectedRevision:1,patch:{priority:'urgent'}}),
  other.assign({taskId:task.id,expectedRevision:1,agentId:randomUUID()}),
 ]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const failure=results.find(r=>r.status==='rejected') as PromiseRejectedResult;
 assert.match(String(failure.reason),/TASK_REVISION_CONFLICT/);
 const current=await other.get(task.id);assert.equal(current.revision,2);assert.equal(current.priority,'urgent');
 await other.assign({taskId:task.id,expectedRevision:2,agentId:randomUUID()});
 assert.equal((await board.get(task.id)).revision,3);
});

test('archival retains dependency truth, requires revisions, and prevents edits until restored',async()=>{
 const {board}=fixture(),a=await board.create(input('A')),b=await board.create(input('B',{dependencies:[a.id]}));
 await board.archive({taskId:a.id,expectedRevision:1,archived:true});
 assert.equal((await board.list()).total,1);assert.equal((await board.list({includeArchived:true})).total,2);
 assert.equal((await board.get(b.id)).blocked,true);
 await assert.rejects(board.update({taskId:a.id,expectedRevision:2,patch:{status:'done'}}),/TASK_ARCHIVED/);
 await assert.rejects(board.assign({taskId:a.id,expectedRevision:2,agentId:null}),/TASK_ARCHIVED/);
 await assert.rejects(board.archive({taskId:a.id,expectedRevision:1,archived:false}),/TASK_REVISION_CONFLICT/);
 await board.archive({taskId:a.id,expectedRevision:2,archived:false});
 await board.update({taskId:a.id,expectedRevision:3,patch:{status:'done'}});
 await board.archive({taskId:a.id,expectedRevision:4,archived:true});
 assert.equal((await board.get(b.id)).ready,true);
});

test('filters combine, priorities sort, pagination is bounded and cancelled dependencies remain unresolved',async()=>{
 const {board}=fixture(),worker=randomUUID();
 const low=await board.create(input('Low',{priority:'low'}));
 const urgent=await board.create(input('Urgent',{priority:'urgent',assignedAgentId:worker}));
 await board.create(input('Other',{boardId:'other',priority:'urgent'}));
 const blocked=await board.create(input('Blocked',{dependencies:[low.id]}));
 await board.update({taskId:low.id,expectedRevision:1,patch:{status:'cancelled'}});
 assert.equal((await board.get(blocked.id)).ready,false);
 const first=await board.list({boardId:'term-dad',limit:1});
 assert.equal(first.tasks[0].id,urgent.id);assert.equal(first.total,3);assert.equal(first.nextOffset,1);
 const rest=await board.list({boardId:'term-dad',offset:first.nextOffset,limit:2});
 assert.deepEqual(rest.tasks.map(t=>t.id),[blocked.id,low.id]);assert.equal(rest.nextOffset,null);
 assert.deepEqual((await board.list({boardId:'term-dad',assignedAgentId:worker,status:'todo',priority:'urgent',readyOnly:true})).tasks.map(t=>t.id),[urgent.id]);
 await assert.rejects(board.list({limit:101}));
});

test('storage failure propagates, does not advance revisions, and supports an explicit retry',async()=>{
 const memory=new MemoryTaskStorage();let fail=false;
 const storage:TaskStorage={transaction(write,fn){if(fail&&write)return Promise.reject(new Error('storage unavailable'));return memory.transaction(write,fn);}};
 const board=new TaskBoard(storage),task=await board.create(input());fail=true;
 await assert.rejects(board.update({taskId:task.id,expectedRevision:1,patch:{title:'Updated'}}),/storage unavailable/);
 assert.equal((await board.get(task.id)).revision,1);fail=false;
 assert.equal((await board.update({taskId:task.id,expectedRevision:1,patch:{title:'Updated'}})).revision,2);
});

test('inputs and journals reject oversized fields, unknown fields and duplicate criterion identities',async()=>{
 const {board}=fixture();
 await assert.rejects(board.create(input('Bad',{title:'x'.repeat(201)})));
 await assert.rejects(board.create(input('Bad',{paneId:7})));
 await assert.rejects(board.create(input('Bad',{acceptanceCriteria:[{id:'same',description:'A'},{id:'same',description:'B'}]})),/TASK_DUPLICATE_CRITERION/);
 const task=await board.create(input());
 await assert.rejects(board.update({taskId:task.id,expectedRevision:1,patch:{}}));
 await assert.rejects(board.update({taskId:task.id,expectedRevision:1,patch:{boardId:'other'}}));
 const {blocked,ready,unresolvedDependencyIds,...record}=task;
 assert.throws(()=>validateTaskState({version:1,tasks:[record,record]}),/TASK_DUPLICATE_ID/);
 assert.throws(()=>validateTaskState({version:2,tasks:[]}),/TASK_STATE_INVALID/);
 const full={version:1 as const,tasks:Array.from({length:MAX_TASKS},()=>({...record,id:randomUUID(),archived:true}))};
 await assert.rejects(new TaskBoard(new MemoryTaskStorage(full)).create(input()),/TASK_CAPACITY/);
 assert.throws(()=>validateTaskState({...full,tasks:full.tasks.map(t=>({...t,goal:'x'.repeat(8000)}))}),/TASK_STORAGE_SIZE_LIMIT/);
});

test('memory storage isolates initial state, reads, returned results and rollback',async()=>{
 const {board}=fixture(),task=await board.create(input()),{blocked,ready,unresolvedDependencyIds,...record}=task;
 const initial={version:1 as const,tasks:[record]},storage=new MemoryTaskStorage(initial),next=new TaskBoard(storage);
 initial.tasks[0].title='External mutation';assert.equal((await next.get(task.id)).title,'Implement feature');
 const result=await next.get(task.id);result.title='Result mutation';assert.equal((await next.get(task.id)).title,'Implement feature');
 await storage.transaction(false,state=>{state.tasks.length=0;return {result:null};});assert.equal((await next.list()).total,1);
 await assert.rejects(storage.transaction(true,state=>{state.tasks.length=0;throw new Error('rollback');}),/rollback/);
 await assert.rejects(storage.transaction(false,()=>({state:emptyTaskState(),result:null})),/TASK_STORAGE_READ_ONLY/);
 assert.equal((await next.list()).total,1);
});

test('close drains accepted operations, rejects new ones, and bounds outstanding work',async()=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),memory=new MemoryTaskStorage();
 const storage:TaskStorage={async transaction(write,fn){await gate;return memory.transaction(write,fn);}};
 const board=new TaskBoard(storage),pending=Array.from({length:128},()=>board.list());
 await assert.rejects(board.list(),/TASK_OPERATION_LIMIT/);
 let closed=false;const closing=board.close().then(()=>{closed=true;});
 await assert.rejects(board.create(input()),/TASK_BOARD_CLOSED/);assert.equal(closed,false);
 release();await Promise.all(pending);await closing;assert.equal(closed,true);
});
