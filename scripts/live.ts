import assert from 'node:assert/strict';
import { LiveSession,parentPane } from './live-support.js';
const session=await LiveSession.create(),call=session.call;
try{
 const before=await call('terminal.list');assert.ok(before.length>0,'A live WezTerm GUI is required');
 const a=await session.spawnAgent({name:'term-dad-live-shell',cli:'shell',paneId:parentPane(before),cwd:process.cwd(),command:['bash','--noprofile','--norc','-i']});const agentId=a.agentId;
 await call('agent.wait_until_idle',{agentId,timeoutMs:30000});
 const initialTurn=await call('agent.send',{agentId,text:"printf '\\nTERM_DAD_%s\\n' FIRST"});
 await call('agent.wait_for_text',{agentId,text:'TERM_DAD_FIRST',timeoutMs:15000});
 const outcome=await call('agent.wait_for_outcome',{agentId,turnId:initialTurn.turnId,timeoutMs:15000});assert.equal(outcome.reason,'turn_finished');assert.equal(outcome.provenance,'heuristic');
 const first=await call('agent.observe',{agentId});assert.equal(first.paneId,a.paneId);
 let task=await call('task.create',{boardId:'live-attention',title:'Shell round trip',goal:'Observe TERM_DAD_FIRST after submitting shell input',assignedAgentId:agentId});
 const attention=await call('orchestrator.attention',{boardId:'live-attention'});
 assert.equal(attention.counts.ready_to_dispatch,1);assert.equal(attention.entries[0].worker.availability,'attached');
 assert.equal(typeof attention.entries[0].worker.observationAgeMs,'number');
 task=await call('task.start_attempt',{taskId:task.id,expectedRevision:task.revision});
 task=await call('task.report_result',{taskId:task.id,expectedRevision:task.revision,attemptId:task.currentAttemptId,
  outcome:'succeeded',summary:'Observed the shell marker through agent.wait_for_text',workVersion:'live-shell-round-trip',provenance:'supervisor_recorded',artifacts:[],checks:[]});
 const verification=await call('orchestrator.attention',{boardId:'live-attention',since:attention.cursor});
 assert.equal(verification.counts.awaiting_verification,1);assert.ok(verification.changes.some((change:any)=>change.id===task.id));
 await call('task.verify',{taskId:task.id,expectedRevision:task.revision,attemptId:task.currentAttemptId,reportId:task.latestReport.id,
  workVersion:'live-shell-round-trip',result:'passed',rationale:'The live test observed TERM_DAD_FIRST after submission',criteria:[],complete:true});
 const completed=await call('orchestrator.attention',{boardId:'live-attention',since:verification.cursor});
 assert.equal(completed.pagination.entryTotal,0);assert.ok(completed.changes.some((change:any)=>change.id===task.id&&change.after.status==='done'));

 await call('agent.send',{agentId,text:"printf '\\nTERM_DAD_%s\\n' FOLLOWUP"});
 const follow=await call('agent.wait_for_text',{agentId,text:'TERM_DAD_FOLLOWUP',timeoutMs:15000});assert.ok(follow.recentText.includes('TERM_DAD_FOLLOWUP'));
 const split=await session.spawnPane({paneId:a.paneId,direction:'right',percent:30,command:['bash','--noprofile','--norc','-i']},true);
 await call('terminal.resize',{paneId:split,direction:'Left',amount:2});await call('terminal.focus',{target:'pane',id:split});await call('terminal.move',{paneId:split});
 await session.closePane(split);
 const second=await session.spawnAgent({name:'term-dad-broadcast-shell',cli:'shell',paneId:a.paneId,command:['bash','--noprofile','--norc','-i']});const secondId=second.agentId;
 await call('agent.wait_until_idle',{agentId:secondId,timeoutMs:15000});
 await call('agent.broadcast',{agentIds:[agentId,secondId],text:"printf '\\nTERM_DAD_%s\\n' BROADCAST"});
 for(const worker of [agentId,secondId])await call('agent.wait_for_text',{agentId:worker,text:'TERM_DAD_BROADCAST',timeoutMs:15000});
 assert.equal((await call('agent.collect_results')).length,2);assert.equal((await call('orchestrator.status')).length,2);
 assert.ok((await call('terminal.snapshot')).panes.length>=3);
 await call('agent.stop',{agentId:secondId});session.owned.delete(second.paneId);
 const newWindowPane=await session.spawnPane({paneId:a.paneId,newWindow:true,command:['bash','--noprofile','--norc','-i']});
 const window=(await call('terminal.list')).find((p:any)=>p.pane_id===newWindowPane);
 await call('terminal.focus',{target:'window',id:window.window_id});await session.closePane(newWindowPane);
 await call('agent.send',{agentId,text:'sleep 30'});await call('agent.interrupt',{agentId});
 await call('agent.wait_until_idle',{agentId,timeoutMs:15000});
 await call('agent.stop',{agentId});session.owned.delete(a.paneId);
 const after=await call('terminal.list');
 for(const pane of before)assert.ok(after.some((p:any)=>p.pane_id===pane.pane_id),'Pre-existing panes must survive');
 console.log('PASS: live MCP spawn, shell readiness, initial/follow-up input, output, split, resize, focus, move, broadcast, snapshots, task attention/verification/change cursors, new window, interrupt and cleanup');
}finally{await session.dispose();}
