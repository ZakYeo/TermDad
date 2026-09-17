import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AttentionService } from '../src/attention.js';
import { TaskBoard } from '../src/tasks.js';
import { MemoryTaskStorage } from '../src/task-storage.js';
import { Agents } from '../src/agents.js';
import { WezTermBackend } from '../src/backend.js';
import { completeTask,resultReport } from './task-support.js';
import type { WorkerSnapshot } from '../src/attention-model.js';

const input={boardId:'repo',title:'Task',goal:'Goal'};
async function setup(){
 let output='› Explain this codebase',alive=true,failRead=false,failTasks=false,failWorkers=false,now=Date.now();
 const calls:string[]=[];
 const backend=new WezTermBackend(async args=>{
  calls.push(args[0]);
  if(args[0]==='list')return JSON.stringify(alive?[{pane_id:7,tab_id:1,window_id:1,title:'test',cwd:'/',size:{rows:24,cols:80}}]:[]);
  if(args[0]==='get-text'){if(failRead)throw new Error('PRIVATE_BACKEND_ERROR');return output;}
  return '';
 });
 const agents=new Agents(backend),board=new TaskBoard(new MemoryTaskStorage());
 const worker=await agents.adopt({name:'worker',paneId:7,cli:'codex',workerSkillInitialized:true});
 const attention=new AttentionService(async()=>{if(failTasks)throw new Error('PRIVATE_TASK_ERROR');return board.snapshot();},async()=>{
  if(failWorkers)throw new Error('PRIVATE_WORKER_ERROR');return agents.snapshot();
 },()=>now);
 return {attention,board,agents,worker,calls,setOutput:(text:string)=>{output=text;},remove:()=>{alive=false;},
  failRead:()=>{failRead=true;},failTasks:(v=true)=>{failTasks=v;},failWorkers:(v=true)=>{failWorkers=v;},advance:(ms:number)=>{now+=ms;}};
}

test('eligibility, assignment constraints, categories and priority are independent; reads preserve task records',async()=>{
 const f=await setup();
 const normal=await f.board.create({...input,assignedAgentId:f.worker.agentId});
 const urgent=await f.board.create({...input,title:'Urgent',priority:'urgent'});
 const blocked=await f.board.create({...input,blockers:['Need a decision']});
 const dependency=await f.board.create({...input,dependencies:[normal.id],assignedAgentId:f.worker.agentId});
 const before=await f.board.snapshot(),result=await f.attention.status();
 assert.equal(result.entries[0].id,urgent.id);
 assert.deepEqual(result.entries.find(e=>e.id===normal.id)?.categories,['ready_to_dispatch']);
 assert.deepEqual(result.entries.find(e=>e.id===urgent.id)?.categories,['needs_decision','ready_to_dispatch']);
 assert.deepEqual(result.entries.find(e=>e.id===blocked.id)?.categories,['needs_decision']);
 assert.deepEqual(result.entries.find(e=>e.id===dependency.id)?.categories,['waiting_on_dependencies']);
 assert.equal(result.counts.ready_to_dispatch,2);assert.equal(result.baseline.reason,'initial');
 assert.deepEqual(await f.board.snapshot(),before);assert.ok(f.calls.every(c=>['list','get-text'].includes(c)));
 assert.equal(result.entries.find(e=>e.id===normal.id)?.workerContext,'assignment_only');
 assert.ok(result.entries.find(e=>e.id===normal.id)?.worker?.uncertainty.includes('task_turn_unconfirmed'));
});

test('permission, authentication and question prompts take precedence over readiness; standalone workers surface',async()=>{
 const f=await setup();
 for(const [text,reason] of [['Do you trust this folder?\n› Yes','input_permission'],['Sign in to continue\n›','input_authentication'],['Choose an option\n›','input_question']]){
  f.setOutput(text);const result=await f.attention.status();
  assert.equal(result.entries[0].kind,'worker');assert.ok(result.entries[0].reasons.includes(reason));
  assert.equal(result.entries[0].worker?.readyForPrompt,false);
  assert.equal(JSON.stringify(result).includes(text),false);
 }
 const task=await f.board.create({...input,assignedAgentId:f.worker.agentId});
 const result=await f.attention.status();assert.equal(result.entries.length,1);assert.equal(result.entries[0].id,task.id);
 assert.ok(result.entries[0].categories.includes('ready_to_dispatch'));assert.ok(result.entries[0].dispatchConstraints.includes('input_question'));
});

test('result and verification queues require recorded evidence, never a ready prompt',async()=>{
 const f=await setup();let task=await f.board.create({...input,assignedAgentId:f.worker.agentId});
 task=await f.board.startAttempt({taskId:task.id,expectedRevision:task.revision});
 assert.equal((await f.attention.status()).counts.awaiting_verification,0);
 task=await f.board.reportResult({taskId:task.id,expectedRevision:task.revision,attemptId:task.currentAttemptId,...resultReport});
 assert.ok((await f.attention.status()).entries[0].categories.includes('awaiting_verification'));
 for(const result of ['failed','inconclusive','passed']){
  task=await f.board.verify({taskId:task.id,expectedRevision:task.revision,attemptId:task.currentAttemptId,reportId:task.latestReport!.id,
   workVersion:resultReport.workVersion,result,rationale:'Review',criteria:[]});
  const entry=(await f.attention.status()).entries[0];
  assert.ok(entry.reasons.includes(`verification_${result}`));assert.ok(entry.categories.includes('needs_decision'));
  assert.equal(entry.categories.includes('awaiting_verification'),false);
 }
 task=await f.board.reportResult({taskId:task.id,expectedRevision:task.revision,attemptId:task.currentAttemptId,...resultReport});
 assert.equal(task.verification.status,'stale');assert.equal((await f.attention.status()).counts.awaiting_verification,1);
 for(const outcome of ['failed','blocked','cancelled']){
  task=await f.board.reportResult({taskId:task.id,expectedRevision:task.revision,attemptId:task.currentAttemptId,...resultReport,outcome});
  assert.ok((await f.attention.status()).entries[0].reasons.includes(`report_${outcome}`));
 }
});

test('matching turns flag missing reports; unrelated turns and stale prompts do not imply task completion',async()=>{
 const f=await setup();let task=await f.board.create({...input,assignedAgentId:f.worker.agentId});
 task=await f.board.startAttempt({taskId:task.id,expectedRevision:task.revision});
 await f.agents.send(f.worker.agentId,'Work',{taskId:task.id,attemptId:task.currentAttemptId!});
 // The unchanged ready prompt is guarded after input regardless of elapsed time.
 const stale=(await f.attention.status()).entries[0];assert.equal(stale.worker?.readyForPrompt,false);
 assert.equal(stale.reasons.includes('ready_without_report'),false);
 await f.agents.storage.transaction(true,state=>{
  state.workers[0].lastInputAt=Date.now()-2000;return {state,result:undefined};
 });
 f.setOutput('Done\n› Next');
 const ready=(await f.attention.status()).entries[0];assert.equal(ready.workerContext,'matching_attempt');
 assert.ok(ready.reasons.includes('ready_without_report'));assert.equal(ready.categories.includes('awaiting_verification'),false);
 task=await f.board.startAttempt({taskId:task.id,expectedRevision:task.revision});
 const unrelated=(await f.attention.status()).entries[0];assert.equal(unrelated.workerContext,'assignment_only');
 assert.equal(unrelated.reasons.includes('ready_without_report'),false);
 assert.equal((await f.board.get(task.id)).status,'in_progress');
});

test('uncertain delivery, failed reads, unknown output and missing workers remain explicit',async()=>{
 const f=await setup();await f.board.create({...input,assignedAgentId:f.worker.agentId});
 f.setOutput('Unrecognized terminal content');assert.ok((await f.attention.status()).entries[0].reasons.includes('worker_state_unknown'));
 await f.agents.storage.transaction(true,state=>{state.workers[0].deliveryPending=true;return {state,result:undefined};});
 const uncertain=(await f.attention.status()).entries[0];assert.ok(uncertain.reasons.includes('delivery_uncertain'));
 f.failRead();const failed=(await f.attention.status()).entries[0];assert.equal(failed.worker?.observedAt,null);
 assert.equal(failed.worker?.observationAgeMs,null);assert.equal(failed.worker?.readyForPrompt,null);
 assert.ok(failed.worker?.uncertainty.includes('observation_failed'));assert.equal(JSON.stringify(failed).includes('PRIVATE_BACKEND_ERROR'),false);
 f.remove();assert.equal((await f.attention.status()).entries[0].worker?.availability,'missing');
});

test('cursors ignore advancing ages and observation IDs but detect output, revisions and dependency changes',async()=>{
 const f=await setup();const first=await f.board.create({...input,assignedAgentId:f.worker.agentId});
 const dependent=await f.board.create({...input,dependencies:[first.id]});
 const baseline=await f.attention.status();f.advance(5000);
 const same=await f.attention.status({since:baseline.cursor});assert.deepEqual(same.changes,[]);
 f.setOutput('New output\n› Next');const output=await f.attention.status({since:baseline.cursor});
 assert.deepEqual(output.changes.map(c=>c.kind),['worker']);assert.ok(output.changes[0].changedFields.includes('outputHash'));
 await completeTask(f.board,first.id);
 const completed=await f.attention.status({since:baseline.cursor});
 assert.equal(completed.entries.some(e=>e.id===first.id),false);
 assert.ok(completed.entries.find(e=>e.id===dependent.id)?.categories.includes('ready_to_dispatch'));
 assert.ok(completed.changes.find(c=>c.id===first.id)?.changedFields.includes('status'));
 assert.ok(completed.changes.find(c=>c.id===dependent.id)?.changedFields.includes('ready'));
 const done=await f.board.get(first.id);await f.board.archive({taskId:first.id,expectedRevision:done.revision,archived:true});
 assert.ok((await f.attention.status({since:completed.cursor})).changes.find(c=>c.id===first.id)?.changedFields.includes('archived'));
});

test('full-source failures preserve useful results without fabricated additions or removals',async()=>{
 const f=await setup();await f.board.create({...input,assignedAgentId:f.worker.agentId});
 const baseline=await f.attention.status();
 f.failWorkers();const noWorkers=await f.attention.status({since:baseline.cursor});
 assert.equal(noWorkers.entries.length,1);assert.equal(noWorkers.entries[0].worker?.availability,'unknown');
 assert.deepEqual(noWorkers.changes,[]);assert.deepEqual(noWorkers.baseline.incompleteSources,['workers']);
 f.failWorkers(false);f.failTasks();f.setOutput('Choose an option');
 const noTasks=await f.attention.status({since:baseline.cursor});assert.equal(noTasks.counts.needs_decision,null);
 assert.equal(noTasks.entries[0].kind,'worker');assert.ok(noTasks.entries[0].worker?.uncertainty.includes('task_source_unavailable'));
 assert.ok(noTasks.changes.every(c=>c.kind==='worker'));assert.equal(JSON.stringify(noTasks).includes('PRIVATE_'),false);
 f.failTasks(false);const recovered=await f.attention.status({since:noTasks.cursor});
 assert.ok(recovered.changes.every(c=>c.kind==='worker'));assert.ok(recovered.baseline.incompleteSources.includes('tasks'));
});

test('frozen pages cover all entries and changes, do not reobserve, and cursors reset explicitly',async()=>{
 const f=await setup();const baseline=await f.attention.status();
 for(let i=0;i<5;i++)await f.board.create({...input,title:`Task ${i}`,boardId:i===4?'other':'repo'});
 const first=await f.attention.status({since:baseline.cursor,limit:2}),calls=f.calls.length;
 assert.equal(first.pagination.entryTotal,5);assert.equal(first.pagination.changeTotal,5);assert.equal(first.counts.ready_to_dispatch,5);
 f.advance(1000);await f.board.create({...input,title:'Added after snapshot'});
 const second=await f.attention.status({pageCursor:first.cursor,offset:2,limit:2});
 const third=await f.attention.status({pageCursor:first.cursor,offset:4,limit:2});
 assert.equal(f.calls.length,calls);assert.equal(second.generatedAt,first.generatedAt);assert.equal(third.pagination.nextOffset,null);
 assert.equal(new Set([...first.entries,...second.entries,...third.entries].map(e=>e.id)).size,5);
 assert.equal(new Set([...first.changes,...second.changes,...third.changes].map(e=>e.id)).size,5);
 const scoped=await f.attention.status({since:first.cursor,boardId:'repo'});assert.equal(scoped.baseline.reason,'scope_changed');
 assert.ok(scoped.entries.every(e=>e.boardId==='repo'));
 assert.equal((await f.attention.status({since:randomUUID()})).baseline.reason,'unknown_or_expired');
 await assert.rejects(f.attention.status({pageCursor:first.cursor,since:baseline.cursor}));
 await assert.rejects(f.attention.status({offset:2}));await assert.rejects(f.attention.status({limit:101}));
 f.advance(15*60*1000);await assert.rejects(f.attention.status({pageCursor:first.cursor}),/ATTENTION_PAGE_EXPIRED/);
 assert.equal((await f.attention.status({since:first.cursor})).baseline.reset,true);
 const retained=await f.attention.status();for(let i=0;i<16;i++)await f.attention.status();
 assert.equal((await f.attention.status({since:retained.cursor})).baseline.reset,true);
});

test('observation age differs from output inactivity and detached observations have no invented freshness',async()=>{
 const f=await setup(),observation=await f.agents.observe(f.worker.agentId),now=Date.now();
 const attention=new AttentionService(()=>f.board.snapshot(),async()=>[{...observation,observedAt:new Date(now-500).toISOString(),lastOutputAt:now-10000,status:'UNKNOWN'}],()=>now);
 const worker=(await attention.status()).entries[0].worker!;
 assert.equal(worker.observationAgeMs,500);assert.equal(worker.outputInactiveMs,10000);
 const detached:WorkerSnapshot=await f.agents.list();detached[0].attachment='detached';
 const unavailable=new AttentionService(()=>f.board.snapshot(),async()=>detached,()=>now);
 const result=(await unavailable.status()).entries[0];assert.equal(result.worker?.observedAt,null);assert.ok(result.reasons.includes('worker_detached'));
});

test('refresh admission and shutdown stay bounded; independent cursors remain usable',async()=>{
 const board=new TaskBoard(new MemoryTaskStorage());let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const attention=new AttentionService(async()=>{await gate;return board.snapshot();},async()=>[]);
 const pending=attention.status();await assert.rejects(attention.status(),/ATTENTION_BUSY/);
 const closing=attention.close();release();await pending;await closing;
 await assert.rejects(attention.status(),/ATTENTION_CLOSED/);
 const f=await setup(),a=await f.attention.status(),b=await f.attention.status();
 await f.board.create(input);
 assert.equal((await f.attention.status({since:a.cursor})).changes.filter(c=>c.kind==='task').length,1);
 assert.equal((await f.attention.status({since:b.cursor})).changes.filter(c=>c.kind==='task').length,1);
});


test('unavailable workers leave decision counts unknown even with an empty task graph',async()=>{
 const board=new TaskBoard(new MemoryTaskStorage());
 const attention=new AttentionService(()=>board.snapshot(),async()=>{throw new Error('Unavailable');});
 const result=await attention.status();
 assert.equal(result.counts.needs_decision,null);assert.equal(result.counts.ready_to_dispatch,0);
 assert.equal(result.counts.awaiting_verification,0);assert.equal(result.sources.workers,false);
});
