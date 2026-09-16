import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskBoard } from '../src/tasks.js';
import { MemoryTaskStorage,FileTaskStorage } from '../src/task-storage.js';
import { completeTask,resultReport } from './task-support.js';

async function fixture(extra={}){
 const board=new TaskBoard(new MemoryTaskStorage());
 const task=await board.create({boardId:'repo',title:'Feature',goal:'Works as requested',assignedAgentId:randomUUID(),acceptanceCriteria:[{id:'test',description:'Regression passes'}],...extra});
 return {board,task};
}
async function reportFixture(extra={}){
 const {board,task}=await fixture();let current=await board.startAttempt({taskId:task.id,expectedRevision:1});
 current=await board.reportResult({taskId:task.id,expectedRevision:2,attemptId:current.currentAttemptId,...resultReport,...extra});
 const decision={taskId:task.id,expectedRevision:3,attemptId:current.currentAttemptId,reportId:current.latestReport!.id,workVersion:resultReport.workVersion,result:'passed',rationale:'Checked behavior and output',criteria:[{criterionId:'test',result:'passed',evidence:['test log']}],complete:true};
 return {board,task:current,decision};
}

test('reports persist evidence without completing tasks; verification gates completion and survives board restart',async()=>{
 const {board,task,decision}=await reportFixture({artifacts:[{kind:'file',reference:'src/feature.ts',context:'WSL repo'}],checks:[{id:'tests',criterionIds:['test'],execution:'npm run check',context:'WSL repo',startedAt:'2026-09-16T10:00:00Z',finishedAt:'2026-09-16T10:01:00Z',result:'passed',exitCode:null,evidence:['logs/check.txt'],provenance:'worker_reported'}]});
 assert.equal(task.status,'in_progress');assert.equal(task.verification.status,'unverified');
 await assert.rejects(board.update({taskId:task.id,expectedRevision:3,patch:{status:'done',acceptanceCriteria:[{id:'test',description:'Regression passes',satisfied:true}]}}),/VERIFICATION_REQUIRED/);
 const done=await board.verify(decision);assert.equal(done.status,'done');assert.equal(done.verification.status,'passed');
 const restarted=new TaskBoard(board.storage);assert.deepEqual(await restarted.get(task.id),done);
 const history=await restarted.history({taskId:task.id});assert.equal(history.attempts[0].reports[0].checks[0].exitCode,null);assert.equal(history.attempts[0].reports[0].checks[0].provenance,'worker_reported');
 assert.equal('attempts' in done,false);
});

test('verification rejects stale identities, failed checks, failed outcomes and unsupported evidence provenance',async()=>{
 for(const extra of [{outcome:'failed'},{checks:[{id:'test',criterionIds:['test'],execution:'test',context:'repo',startedAt:'2026-09-16T10:00:00Z',finishedAt:'2026-09-16T10:01:00Z',result:'failed',exitCode:1,evidence:[],provenance:'supervisor_recorded'}]}]){
  const {board,task,decision}=await reportFixture(extra);await assert.rejects(board.verify(decision),/invalid passing verification/);assert.equal((await board.get(task.id)).revision,3);
 }
 const {board,task,decision}=await reportFixture();
 for(const patch of [{reportId:randomUUID()},{workVersion:'changed'},{attemptId:randomUUID()},{criteria:[]},{criteria:[{criterionId:'test',result:'passed',evidence:[]}]},{criteria:[{criterionId:'unknown',result:'passed',evidence:['x']}]}])await assert.rejects(board.verify({...decision,...patch}));
 await assert.rejects(board.reportResult({taskId:task.id,expectedRevision:3,attemptId:task.currentAttemptId,...resultReport,provenance:'directly_captured'}));
 assert.equal((await board.get(task.id)).revision,3);
 const failed=await board.verify({...decision,result:'inconclusive',criteria:[],complete:false});assert.equal(failed.verification.status,'inconclusive');assert.equal(failed.status,'in_progress');
});

test('new reports and attempts stale verification; obsolete attempts cannot report or dispatch',async()=>{
 const {board,task,decision}=await reportFixture();let current=await board.verify({...decision,complete:false});
 await board.update({taskId:task.id,expectedRevision:current.revision,patch:{title:'Renamed',priority:'high'}});
 current=await board.get(task.id);assert.equal(current.verification.status,'passed');
 current=await board.reportResult({taskId:task.id,expectedRevision:current.revision,attemptId:task.currentAttemptId,...resultReport});assert.equal(current.verification.status,'stale');
 await assert.rejects(board.verify({...decision,expectedRevision:current.revision}),/REPORT_STALE/);
 current=await board.startAttempt({taskId:task.id,expectedRevision:current.revision});assert.equal(current.verification.status,'stale');
 await assert.rejects(board.reportResult({taskId:task.id,expectedRevision:current.revision,attemptId:task.currentAttemptId,...resultReport}),/ATTEMPT_STALE/);
 await assert.rejects(board.validateAttempt(task.id,task.currentAttemptId!,task.assignedAgentId!),/ATTEMPT_STALE/);
 await assert.rejects(board.validateAttempt(task.id,current.currentAttemptId!,randomUUID()),/ASSIGNMENT_MISMATCH/);
 assert.equal((await board.history({taskId:task.id,limit:1})).nextOffset,1);
});

test('reopening and requirements changes invalidate verification; completion cannot be edited silently',async()=>{
 const {board,task}=await fixture();let current=await completeTask(board,task.id);
 await assert.rejects(board.update({taskId:task.id,expectedRevision:current.revision,patch:{goal:'New requirement'}}),/REOPEN_REQUIRED/);
 await assert.rejects(board.assign({taskId:task.id,expectedRevision:current.revision,agentId:randomUUID()}),/REOPEN_REQUIRED/);
 current=await board.update({taskId:task.id,expectedRevision:current.revision,patch:{status:'in_progress',goal:'New requirement'}});
 assert.equal(current.verification.status,'stale');assert.equal(current.currentAttemptId,null);
 await assert.rejects(board.update({taskId:task.id,expectedRevision:current.revision,patch:{status:'done'}}),/VERIFICATION_REQUIRED/);
});

test('passing verification requires resolved dependencies and blockers even without completion',async()=>{
 const {board,task}=await fixture({blockers:['Review needed']});
 let current=await board.startAttempt({taskId:task.id,expectedRevision:1});
 current=await board.reportResult({taskId:task.id,expectedRevision:2,attemptId:current.currentAttemptId,...resultReport});
 await assert.rejects(board.verify({taskId:task.id,expectedRevision:3,attemptId:current.currentAttemptId,reportId:current.latestReport!.id,workVersion:resultReport.workVersion,result:'passed',rationale:'Checked',criteria:[{criterionId:'test',result:'passed',evidence:['review']}]}),/COMPLETION_BLOCKED/);
 const dependency=await board.create({boardId:'repo',title:'Dependency',goal:'Ready'});
 current=await board.update({taskId:task.id,expectedRevision:3,patch:{blockers:[],dependencies:[dependency.id]}});
 await assert.rejects(completeTask(board,task.id),/COMPLETION_BLOCKED/);
});

test('history limits and conflicting result writes preserve committed records',async()=>{
 const {board,task}=await fixture({acceptanceCriteria:[]});let current=await board.startAttempt({taskId:task.id,expectedRevision:1});
 const report={taskId:task.id,expectedRevision:2,attemptId:current.currentAttemptId,...resultReport};
 const race=await Promise.allSettled([board.reportResult(report),board.reportResult(report)]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
 current=await board.get(task.id);
 for(let i=1;i<20;i++)current=await board.reportResult({...report,expectedRevision:current.revision});
 await assert.rejects(board.reportResult({...report,expectedRevision:current.revision}),/REPORT_LIMIT/);
 assert.equal((await board.history({taskId:task.id})).attempts[0].reports.length,20);
 for(let i=1;i<20;i++)current=await board.startAttempt({taskId:task.id,expectedRevision:current.revision});
 await assert.rejects(board.startAttempt({taskId:task.id,expectedRevision:current.revision}),/ATTEMPT_LIMIT/);
});

test('legacy migration is read-only until a successful write; reopened legacy tasks require verification',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'term-dad-migration-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const {board,task}=await fixture({acceptanceCriteria:[]});
 const record=await board.storage.transaction(false,s=>({result:s.tasks[0]}));
 const {attempts,currentAttemptId,legacyCompletion,...legacy}=record;legacy.status='done';
 const old=JSON.stringify({version:1,tasks:[legacy]}),path=join(directory,'tasks.json');await writeFile(path,old,{mode:0o600});
 const migrated=new TaskBoard(new FileTaskStorage(directory));const read=await migrated.get(task.id);assert.equal(read.verification.status,'legacy_unverified');assert.equal(await readFile(path,'utf8'),old);
 const reopened=await migrated.update({taskId:task.id,expectedRevision:1,patch:{status:'todo'}});
 assert.equal(JSON.parse(await readFile(path,'utf8')).version,2);assert.equal(reopened.verification.status,'unverified');
 await assert.rejects(migrated.update({taskId:task.id,expectedRevision:2,patch:{status:'done'}}),/VERIFICATION_REQUIRED/);
});

test('check timestamp ordering uses instants rather than ISO string precision and permits unknown times',async()=>{
 const {checkSchema}=await import('../src/task-results.js');
 const check={id:'test',criterionIds:[],execution:'test',context:'repo',result:'passed',exitCode:0,evidence:[],provenance:'supervisor_recorded'};
 assert.equal(checkSchema.safeParse({...check,startedAt:'2026-09-16T10:00:00Z',finishedAt:'2026-09-16T10:00:00.500Z'}).success,true);
 assert.equal(checkSchema.safeParse({...check,startedAt:'2026-09-16T10:00:00.500Z',finishedAt:'2026-09-16T10:00:00Z'}).success,false);
 assert.equal(checkSchema.safeParse({...check,startedAt:'2026-09-16T10:00:00Z',finishedAt:'2026-09-16T10:00:00.000Z'}).success,true);
 assert.equal(checkSchema.safeParse({...check,startedAt:null,finishedAt:null}).success,true);
});

test('verification limit rolls back; worker summaries expose outcome and verification without full evidence',async()=>{
 const {board,task,decision}=await reportFixture();let current=task;
 for(let i=0;i<20;i++)current=await board.verify({...decision,expectedRevision:current.revision,complete:false});
 await assert.rejects(board.verify({...decision,expectedRevision:current.revision,complete:false}),/VERIFICATION_LIMIT/);
 const summary=(await board.workerSummaries()).get(task.assignedAgentId!)!.items[0];
 assert.equal(summary.verificationStatus,'passed');assert.equal(summary.reportedOutcome,'succeeded');assert.equal('checks' in summary,false);
 const done=await board.update({taskId:task.id,expectedRevision:current.revision,patch:{status:'done'}});
 const reopened=await board.update({taskId:task.id,expectedRevision:done.revision,patch:{status:'in_progress'}});
 assert.equal(reopened.verification.status,'stale');assert.equal(reopened.currentAttemptId,null);
});
