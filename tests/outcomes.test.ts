import test from 'node:test';
import assert from 'node:assert/strict';
import { Agents } from '../src/agents.js';
import { WezTermBackend } from '../src/backend.js';
import { MemoryWorkerStorage } from '../src/worker-storage.js';
import { observeInteraction,type InteractionState } from '../src/interaction.js';
import { adapters } from '../src/adapters.js';

async function fixture(){
 let text='› Ready',alive=true,fail=false;const inputs:string[]=[];
 const backend=new WezTermBackend(async(args,input)=>{
  if(fail)throw new Error('transport failed');
  if(args[0]==='list')return JSON.stringify(alive?[{pane_id:7,tab_id:1,window_id:1,title:'worker',cwd:'/repo',size:{rows:24,cols:80}}]:[]);
  if(args[0]==='get-text')return text;
  if(args[0]==='send-text')inputs.push(input??'');
  return '';
 },async()=>({key:'instance',endpoint:'socket'}));
 const storage=new MemoryWorkerStorage(),agents=new Agents(backend,storage);
 const worker=await agents.adopt({name:'worker',paneId:7,cli:'codex',workerSkillInitialized:true});
 const send=await agents.send(worker.agentId,'Implement');
 const age=()=>storage.transaction(true,s=>{s.workers[0].lastInputAt=Date.now()-5000;return {state:s,result:null};});
 return {agents,backend,storage,worker,send,inputs,age,text:(value:string)=>{text=value;},alive:(value:boolean)=>{alive=value;},fail:(value:boolean)=>{fail=value;}};
}

test('permission, question and authentication end waits before quiet or readiness without sending input',async()=>{
 for(const [text,kind] of [['Do you want to proceed?\n›','permission'],['Which package?\n›','question'],['Please sign in\n›','authentication']]){
  const f=await fixture();f.text(text);await f.age();
  const result=await f.agents.waitForOutcome(f.worker.agentId,f.send.turnId,10,1000);
  assert.equal(result.reason,'input_required');assert.equal(result.lastObservation!.inputRequest!.kind,kind);
  assert.equal(result.lastObservation!.readyForPrompt,false);assert.equal(f.inputs.length,2);
 }
});

test('stale prompt and quiet output cannot finish a turn; a changed ready prompt is heuristic completion',async()=>{
 const f=await fixture();await f.age();
 assert.equal((await f.agents.waitForOutcome(f.worker.agentId,f.send.turnId,1)).reason,'timeout');
 f.agents.get(f.worker.agentId).lastOutputAt=Date.now()-5000;
 assert.equal((await f.agents.waitForOutcome(f.worker.agentId,f.send.turnId,1,1000)).reason,'output_quiet');
 f.text('Done with response\n› Next task');
 const outcome=await f.agents.waitForOutcome(f.worker.agentId,f.send.turnId,1);assert.equal(outcome.reason,'turn_finished');assert.equal(outcome.provenance,'heuristic');
 assert.equal(outcome.lastObservation!.inputRequired,false);assert.equal(outcome.lastObservation!.awaitingInput,true);
});

test('sending an answer does not resolve pending input; unknown observation retains uncertainty',async()=>{
 const f=await fixture();f.text('Which package?');const first=await f.agents.observe(f.worker.agentId);
 assert.equal((await f.agents.observe(f.worker.agentId)).inputRequest!.id,first.inputRequest!.id);
 await f.agents.send(f.worker.agentId,'Use existing');assert.ok(f.agents.get(f.worker.agentId).request);
 f.text('screen redraw');const unknown=await f.agents.observe(f.worker.agentId);assert.equal(unknown.inputRequest!.state,'uncertain');
 f.text('Working (1s)');assert.equal((await f.agents.observe(f.worker.agentId)).inputRequest,null);
});

test('turn identity survives restart; superseded turns and changed bindings reject waits',async()=>{
 const f=await fixture();await f.age();const restarted=new Agents(f.backend,f.storage);
 assert.equal((await restarted.observe(f.worker.agentId)).turnId,f.send.turnId);
 assert.equal((await restarted.waitForOutcome(f.worker.agentId,f.send.turnId,1)).reason,'timeout');
 const next=await restarted.send(f.worker.agentId,'Follow-up');await assert.rejects(restarted.waitForOutcome(f.worker.agentId,f.send.turnId,1),/TURN_SUPERSEDED/);
 await restarted.reattach({agentId:f.worker.agentId,paneId:7});await assert.rejects(restarted.waitForOutcome(f.worker.agentId,next.turnId,1),/BINDING_CHANGED/);
});

test('disappearance is distinct from transport failure and cancellation',async()=>{
 const f=await fixture();f.fail(true);await assert.rejects(f.agents.waitForOutcome(f.worker.agentId,f.send.turnId,1),/transport failed/);
 f.fail(false);const controller=new AbortController();controller.abort();await assert.rejects(f.agents.waitForOutcome(f.worker.agentId,f.send.turnId,100,undefined,controller.signal),/WAIT_CANCELLED/);
 f.alive(false);assert.equal((await f.agents.waitForOutcome(f.worker.agentId,f.send.turnId,1)).reason,'worker_disappeared');
});

test('uncertain submission retains turn identity and cannot produce a completion outcome',async()=>{
 const f=await fixture();f.backend.sendText=async()=>{throw new Error('lost response');};
 await assert.rejects(f.agents.send(f.worker.agentId,'Next'),/DELIVERY_UNCERTAIN/);
 const stored=await f.agents.resolve(f.worker.agentId);assert.ok(stored.turn);assert.notEqual(stored.turn.id,f.send.turnId);
 await assert.rejects(f.agents.waitForOutcome(f.worker.agentId,stored.turn.id,1),/DELIVERY_UNCERTAIN/);
});

test('input classification preserves permission precedence and request identity is observation scoped',()=>{
 assert.equal(adapters.codex.classify('Please sign in\nDo you want to proceed?\n›'),'WAITING_FOR_PERMISSION');
 const state:InteractionState={};const first=observeInteraction(state,'WAITING_FOR_QUESTION','Which package?','turn-a');
 assert.equal(observeInteraction(state,'UNKNOWN','redraw','turn-a').inputRequest!.state,'uncertain');
 assert.equal(observeInteraction(state,'WAITING_FOR_QUESTION','Which package?','turn-a').inputRequest!.id,first.inputRequest!.id);
 assert.notEqual(observeInteraction(state,'WAITING_FOR_QUESTION','Which package?','turn-b').inputRequest!.id,first.inputRequest!.id);
 assert.equal(observeInteraction(state,'READY_FOR_PROMPT','›','turn-b').inputRequest,null);
});
