import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { adapters, type Status } from './adapters.js';
import { observeInteraction,type InteractionState } from './interaction.js';
import { attemptReferenceSchema } from './task-results.js';
import { initialWorkerPrompt } from './worker-skill.js';
import { type TerminalBackend,type SpawnOptions,spawnSchema,submit,sendKeys,id } from './backend.js';
import type { WorkerPush } from './push-workers.js';
import { MemoryWorkerStorage,newWorker,workerSchema,type WorkerStorage,type WorkerRecord,type TerminalInstance } from './worker-storage.js';
export const hashOutput=(text:string)=>createHash('sha256').update(text).digest('hex');
export function delta(previous:string,current:string){if(previous===current)return {mode:'unchanged',text:''};if(current.startsWith(previous))return {mode:'append',text:current.slice(previous.length)};return {mode:'replace',text:current};}
type Observation={id:string;text:string;status:Status};
export interface Agent extends Omit<WorkerRecord,'paneId'>,InteractionState {paneId:number;lastOutputAt:number;outputHash:string;recentText:string;status:Status;history:Observation[];}
const sameInstance=(a:TerminalInstance|null,b:TerminalInstance|null)=>a!==null&&b!==null&&a.key===b.key&&a.endpoint===b.endpoint;
export const adoptionSchema=z.object({name:workerSchema.shape.name,paneId:id,cli:workerSchema.shape.cli,workerSkillInitialized:z.boolean().optional()}).strict();
export const reattachSchema=z.object({agentId:z.string().min(1),paneId:id,acknowledgeUncertainDelivery:z.boolean().optional(),workerSkillInitialized:z.boolean().optional()}).strict();

export class Agents {
 readonly records=new Map<string,Agent>();
 private readonly sessionId=randomUUID();
 private operations=new Set<Promise<unknown>>();
 private closed=false;
 constructor(readonly backend:TerminalBackend,readonly storage:WorkerStorage=new MemoryWorkerStorage(),readonly push?:WorkerPush){}
 private run<T>(fn:()=>Promise<T>):Promise<T>{
  if(this.closed)return Promise.reject(new Error('WORKER_CLOSED'));
  if(this.operations.size>=128)return Promise.reject(new Error('WORKER_OPERATION_LIMIT'));
  const task=fn();this.operations.add(task);void task.finally(()=>this.operations.delete(task)).catch(()=>{});return task;
 }
 async close(){this.closed=true;await Promise.allSettled([...this.operations]);}
 private async saved(){
  const workers=await this.storage.transaction(false,s=>({result:s.workers}));
  const live=new Set(workers.map(w=>w.agentId));
  for(const key of this.records.keys())if(!live.has(key))this.records.delete(key);
  return workers;
 }
 private async lookup(agentId:string){const a=(await this.saved()).find(w=>w.agentId===agentId||w.name===agentId);if(!a)throw new Error(`Unknown agent: ${agentId}`);return a;}
 // Synchronous cache access is retained for existing embedders; operations always refresh storage.
 get(agentId:string){const a=this.records.get(agentId)??[...this.records.values()].find(a=>a.name===agentId);if(!a)throw new Error(`Unknown agent: ${agentId}`);return a;}
 private cache(w:WorkerRecord):Agent {
  if(w.paneId===null)throw new Error('WORKER_RESERVED: spawn did not finish; inspect terminal panes before adopting or forgetting');
  let a=this.records.get(w.agentId);
  if(!a||a.revision!==w.revision){a={...w,paneId:w.paneId,lastOutputAt:Date.now(),outputHash:'',recentText:'',status:'UNKNOWN',history:[]};
   // Admission is bounded too: adopt/spawn may run without any metadata reads.
   if(!this.records.has(w.agentId)&&this.records.size>=64)this.records.delete(this.records.keys().next().value!);
   this.records.set(w.agentId,a);}
  else Object.assign(a,w);
  return a;
 }
 private async change(agentId:string,fn:(a:WorkerRecord)=>void){
  const w=await this.storage.transaction(true,s=>{const a=s.workers.find(w=>w.agentId===agentId);if(!a)throw new Error('Unknown agent');fn(a);return {state:s,result:a};});
  if(w.paneId!==null)this.cache(w);return w;
 }
 private async remove(agentId:string){await this.storage.transaction(true,s=>({state:{...s,workers:s.workers.filter(w=>w.agentId!==agentId)},result:undefined}));this.records.delete(agentId);await this.push?.release(agentId);}
 private async insert(w:WorkerRecord){
  await this.storage.transaction(true,s=>{
   if(s.workers.length>=64)throw new Error('Maximum of 64 managed agents reached');
   if(s.workers.some(a=>a.name===w.name||a.agentId===w.name||a.name===w.agentId))throw new Error(`Agent name already exists: ${w.name}`);
   this.available(s.workers,w);return {state:{...s,workers:[...s.workers,w]},result:undefined};
  });
 }
 private available(workers:WorkerRecord[],w:WorkerRecord){
  if(w.paneId!==null&&workers.some(a=>a.agentId!==w.agentId&&a.paneId===w.paneId&&(sameInstance(a.instance,w.instance)||(!a.instance&&!w.instance))))throw new Error('WORKER_PANE_OCCUPIED: pane already has a managed worker');
 }
 private identity(){return this.backend.instance?.()??Promise.resolve(null);}
 private attached(w:WorkerRecord,instance:TerminalInstance|null){return sameInstance(w.instance,instance)||(!w.instance&&!instance&&w.sessionId===this.sessionId);}
 private async checked(w:WorkerRecord){
  const instance=await this.identity();
  if(!this.attached(w,instance))throw new Error('WORKER_DETACHED: terminal identity differs or cannot be verified; use agent.reattach explicitly');
  const a=this.cache(w),pane=(await this.backend.list()).find(p=>p.pane_id===a.paneId);
  if(!this.attached(w,await this.identity()))throw new Error('WORKER_DETACHED: terminal identity changed during observation');
  if(!pane){await this.remove(a.agentId);throw new Error(`Pane ${a.paneId} disappeared; agent ${a.name} removed`);}
  return {a,pane};
 }
 private async locked<T>(agentId:string,fn:(w:WorkerRecord)=>Promise<T>){
  const w=await this.lookup(agentId);
  return this.storage.exclusive(w.agentId,async()=>fn(await this.lookup(w.agentId)));
 }
 spawn(o:SpawnOptions & {name:string;cli:WorkerRecord['cli'];prompt?:string;timeoutMs?:number}){return this.run(async()=>{
  const configured=process.env[`TERM_DAD_${o.cli.toUpperCase()}_COMMAND`];
  const command=o.command??(configured?z.array(z.string().min(1)).min(1).parse(JSON.parse(configured)):(o.cli==='shell'?undefined:[o.cli]));
  if(o.newWindow&&o.windowId!==undefined)throw new Error('newWindow and windowId are mutually exclusive');
  const w=newWorker(o.name,o.cli,null,await this.identity(),this.sessionId);
  // Hooks are injected at launch but stay inert: pushes are dropped until the pane is enabled.
  // The binding is set before the record is inserted, so it is durable from the first write.
  const launched=await this.push?.launch(w.agentId,o.cli,command);
  if(launched?.push)w.push=launched.push;
  let paneId:number|undefined,launchedPane=false;
  try{
   const options=spawnSchema.parse({...o,command:launched?launched.command:command});
   await this.storage.exclusive(w.agentId,async()=>{
    await this.insert(w);
    try{paneId=await this.backend.spawn(options);launchedPane=true;}
    catch{throw new Error(`WORKER_SPAWN_UNCERTAIN: launch response was lost or rejected; reservation ${w.agentId} retained. Inspect terminal.list before forgetting the reservation and adopting any surviving pane. Do not repeat spawn blindly.`);}
    try{await this.change(w.agentId,a=>{a.paneId=paneId!;});this.push?.bind(w.agentId,paneId);}
    catch{throw new Error(`WORKER_STORAGE_FAILED: pane ${paneId} is alive but mapping was not saved; inspect it, forget reservation ${w.agentId}, and agent.adopt it. No prompt sent.`);}
   });
  }catch(e){
   // `launch` already minted a token and wrote a credential file. Release them unless a pane
   // actually started: those two paths deliberately retain a reservation for explicit
   // recovery, and its credential belongs to it until it is forgotten. Without this, a
   // retried name collision or the worker cap leaks a live token per attempt and eventually
   // exhausts the registration limit, permanently breaking spawn for the whole process.
   if(!launchedPane)await this.push?.release(w.agentId);
   throw e;
  }
  if(o.prompt!==undefined){
   try{await this.wait(w.agentId,obs=>obs.status==='READY_FOR_PROMPT',o.timeoutMs??30000);}
   catch(e){throw new Error(`Agent ${w.agentId}, pane ${paneId} retained for diagnosis; prompt NOT sent: ${e instanceof Error?e.message:e}`);}
   // Submission failures report uncertainty, never the incorrect claim that no input was sent.
   await this.send(w.agentId,o.prompt);
  }
  return {agentId:w.agentId,name:w.name,paneId,status:this.get(w.agentId).status,turnId:this.get(w.agentId).turn?.id??null};
 });}
 adopt(input:z.input<typeof adoptionSchema>){return this.run(async()=>{
  const o=adoptionSchema.parse(input),instance=await this.identity();
  if(!(await this.backend.list()).some(p=>p.pane_id===o.paneId))throw new Error('Pane not found');
  const w=newWorker(o.name,o.cli,o.paneId,instance,this.sessionId);w.workerSkillSent=o.workerSkillInitialized??false;
  await this.insert(w);this.cache(w);return this.view(w,'attached',null);
 });}
 reattach(input:z.input<typeof reattachSchema>){return this.run(async()=>{
  const o=reattachSchema.parse(input);
  return this.locked(o.agentId,async old=>{
   if(old.deliveryPending&&(!o.acknowledgeUncertainDelivery||o.workerSkillInitialized===undefined))throw new Error('WORKER_DELIVERY_UNCERTAIN: inspect the pane, acknowledgeUncertainDelivery and specify workerSkillInitialized');
   const instance=await this.identity();if(!(await this.backend.list()).some(p=>p.pane_id===o.paneId))throw new Error('Pane not found');
   const updated=await this.storage.transaction(true,s=>{
    const a=s.workers.find(w=>w.agentId===old.agentId)!;
    const moved=a.paneId!==o.paneId||!this.attached(a,instance);
    Object.assign(a,{paneId:o.paneId,instance,sessionId:this.sessionId,revision:randomUUID(),deliveryPending:false});
    if(o.workerSkillInitialized!==undefined)a.workerSkillSent=o.workerSkillInitialized;
    if(moved){delete a.lastInputAt;delete a.inputOutputHash;}
    this.available(s.workers,a);return {state:s,result:a};
   });this.cache(updated);
   // The pane can change here, so the registration must follow it or pushes would be
   // attributed to the wrong pane. A failed re-key must not fail a rebind that succeeded.
   await this.push?.rekey(updated);
   return this.view(updated,'attached',null);
  });
 });}
 /**
  * Re-keys workers that outlived a previous server, so a surviving pane can push again without
  * being killed. Gated on verified attachment: worker metadata is shared by state directory, so
  * an ungated pass would re-key another live server's workers and silently revoke their tokens.
  * Detached records are left for an explicit `agent.reattach`, which re-keys them anyway.
  */
 restorePush(){return this.run(async()=>{
  if(!this.push)return;
  const workers=await this.saved(),instance=await this.identity();
  for(const w of workers){
   if(!w.push||w.paneId===null||!this.attached(w,instance))continue;
   try{await this.storage.exclusive(w.agentId,()=>this.push!.rekey(w));}
   catch(e){console.error(`[term-dad] push rekey ${w.agentId}: ${e instanceof Error?e.message:e}`);}
  }
  // Only reached when the journal read above succeeded, so a credential is never removed
  // because the durable set could not be established.
  await this.push.sweepCredentials(new Set(workers.map(w=>w.agentId)));
 });}
 forget(agentId:string){return this.run(()=>this.locked(agentId,async w=>{await this.remove(w.agentId);return {forgotten:true};}));}
 private view(w:WorkerRecord,attachment:string,recoveryReason:string|null){return {agentId:w.agentId,name:w.name,paneId:w.paneId,cli:w.cli,attachment,recoveryReason,deliveryPending:w.deliveryPending,turnId:w.turn?.id??null,workerSkillInitialized:w.workerSkillSent,storageWarning:this.storage.warning??null};}
 list(){return this.run(async()=>{
  const workers=await this.saved();for(const key of this.records.keys())if(!workers.some(w=>w.agentId===key))this.records.delete(key);
  if(!workers.length)return [];
  let instance:TerminalInstance|null;
  try{instance=await this.identity();}catch{return workers.map(w=>this.view(w,'detached','Terminal identity unavailable'));}
  let panes;
  try{panes=await this.backend.list();}catch{return workers.map(w=>this.view(w,'detached','Terminal transport unavailable'));}
  const result=[];
  for(const w of workers){
   if(w.paneId!==null&&this.attached(w,instance)&&!panes.some(p=>p.pane_id===w.paneId)){
    try{await this.locked(w.agentId,current=>this.checked(current));}
    catch(e){if(e instanceof Error&&e.message.includes('disappeared'))continue;result.push(this.view(w,'detached','Recovery could not verify pane; retry'));continue;}
   }
   result.push(this.view(w,w.paneId!==null&&this.attached(w,instance)?'attached':'detached',w.paneId===null?'Spawn reservation needs explicit recovery':this.attached(w,instance)?null:'Terminal identity differs or is unverified'));
  }
  return result;
 });}
 observe(agentId:string,since?:string){return this.run(()=>this.locked(agentId,async w=>{
  const {a,pane}=await this.checked(w);
  const text=(await this.backend.read(a.paneId,150)).slice(-24000),hash=hashOutput(text),changed=hash!==a.outputHash;
  if(changed)a.lastOutputAt=Date.now();a.outputHash=hash;a.recentText=text;a.status=adapters[a.cli].classify(text);
  const classifiedStatus=a.status;
  if((a.deliveryPending||(a.lastInputAt&&(Date.now()-a.lastInputAt<750||hash===a.inputOutputHash)))&&a.status==='READY_FOR_PROMPT')a.status='WORKING';
  // A guarded stale prompt is not observed progress and must not resolve input requests.
  const interaction=observeInteraction(a,a.status==='WORKING'&&classifiedStatus==='READY_FOR_PROMPT'?'UNKNOWN':a.status,text,a.turn?.id??null);
  const previous=since?a.history.find(h=>h.id===since):undefined,observationId=randomUUID(),output=previous?delta(previous.text,text):{mode:'replace',text};
  a.history.push({id:observationId,text,status:a.status});if(a.history.length>16)a.history.shift();
  return {agentId:a.agentId,name:a.name,paneId:a.paneId,observedAt:new Date().toISOString(),bindingRevision:a.revision,observationId,...interaction,turnId:a.turn?.id??null,attempt:a.turn?.attempt??null,previousObservationId:since,deltaReset:!!since&&!previous,status:a.status,activity:changed?'changed':'unchanged',lastActivitySecondsAgo:(Date.now()-a.lastOutputAt)/1000,lastInputAt:a.lastInputAt,lastOutputAt:a.lastOutputAt,outputHash:hash,cwd:pane.cwd,process:pane.foreground_process_name??null,awaitingInput:['READY_FOR_PROMPT','WAITING_FOR_PERMISSION','WAITING_FOR_QUESTION','WAITING_FOR_AUTHENTICATION'].includes(a.status),permissionPrompt:a.status==='WAITING_FOR_PERMISSION',deliveryPending:a.deliveryPending,recentText:output.text,outputMode:output.mode,screenshotAvailable:!!process.env.TERM_DAD_SCREENSHOT_COMMAND};
 }));}
 send(agentId:string,text:string,attempt?:z.infer<typeof attemptReferenceSchema>){return this.run(()=>this.locked(agentId,async w=>{
  z.string().max(100000).parse(text);
  if(attempt)attemptReferenceSchema.parse(attempt);
  const {a}=await this.checked(w);
  if(a.deliveryPending)throw new Error('WORKER_DELIVERY_UNCERTAIN: inspect and agent.reattach before further input');
  const initialize=a.cli==='codex'&&!a.workerSkillSent,prompt=initialize?initialWorkerPrompt(text):text;
  z.string().max(100000).parse(prompt);
  const hash=hashOutput((await this.backend.read(a.paneId,150)).slice(-24000));
  await this.change(a.agentId,w=>{w.inputOutputHash=hash;w.lastInputAt=Date.now();w.deliveryPending=true;w.turn={id:randomUUID(),bindingRevision:w.revision,...(attempt?{attempt}: {})};});
  try{await submit(this.backend,a.paneId,prompt);await this.change(a.agentId,w=>{w.deliveryPending=false;if(initialize)w.workerSkillSent=true;});}
  catch{throw new Error('WORKER_DELIVERY_UNCERTAIN: input may have reached the pane; inspect and agent.reattach before retrying');}
  a.status='WORKING';return {agentId:a.agentId,sent:true,turnId:a.turn!.id};
 }));}
 interrupt(agentId:string){return this.run(()=>this.locked(agentId,async w=>{
  const {a}=await this.checked(w);if(a.deliveryPending)throw new Error('WORKER_DELIVERY_UNCERTAIN: inspect and reattach first');
  const hash=hashOutput((await this.backend.read(a.paneId,150)).slice(-24000));
  await this.change(a.agentId,w=>{w.inputOutputHash=hash;w.lastInputAt=Date.now();w.deliveryPending=true;});
  try{await sendKeys(this.backend,a.paneId,['CTRL_C']);await this.change(a.agentId,w=>{w.deliveryPending=false;});}
  catch{throw new Error('WORKER_DELIVERY_UNCERTAIN: interrupt may have reached pane; inspect and reattach');}
  return {interrupted:true};
 }));}
 stop(agentId:string){return this.run(()=>this.locked(agentId,async w=>{const {a}=await this.checked(w);await this.backend.close(a.paneId);await this.remove(a.agentId);return {stopped:true};}));}
 withPane<T>(agentId:string,fn:(paneId:number,instance:TerminalInstance|null)=>Promise<T>){return this.run(()=>this.locked(agentId,async w=>{const {a}=await this.checked(w);return fn(a.paneId,a.instance);}));}
 async findByPane(paneId:number){const instance=await this.identity();return (await this.saved()).find(w=>w.paneId===paneId&&this.attached(w,instance));}
 async resolve(agentId:string){return this.lookup(agentId);}
 async resolveOptional(agentId:string){return (await this.saved()).find(w=>w.agentId===agentId);}
 async bindingPaneExists(w:WorkerRecord){
  if(!this.attached(w,await this.identity()))throw new Error('WORKER_DETACHED');
  const exists=(await this.backend.list()).some(p=>p.pane_id===w.paneId);
  if(!this.attached(w,await this.identity()))throw new Error('WORKER_DETACHED');
  return exists;
 }
 async requireAttachment(agentId:string){const w=await this.lookup(agentId);if(!this.attached(w,await this.identity()))throw new Error('WORKER_DETACHED');return w;}
 async reconcileClosed(paneId:number){const w=await this.findByPane(paneId);if(w)await this.run(()=>this.locked(w.agentId,async current=>{await this.checked(current);})).catch(e=>{if(!(e instanceof Error&&e.message.includes('disappeared')))throw e;});}
 wait(agentId:string,predicate:(o:Awaited<ReturnType<Agents['observe']>>)=>boolean,timeoutMs=30000){return this.run(async()=>{const deadline=Date.now()+timeoutMs;let last;do{last=await this.observe(agentId);if(predicate(last))return last;if(Date.now()>=deadline)break;await new Promise(r=>setTimeout(r,Math.min(250,deadline-Date.now())));}while(Date.now()<=deadline);throw new Error(`Timed out waiting for ${agentId}; last status ${last?.status}`);});}
 waitForOutcome(agentId:string,turnId:string,timeoutMs=30000,quietMs?:number,signal?:AbortSignal){return this.run(async()=>{
  z.uuid().parse(turnId);z.number().int().min(1).max(120000).parse(timeoutMs);
  if(quietMs!==undefined)z.number().int().min(1000).max(3600000).parse(quietMs);
  const binding=await this.lookup(agentId),deadline=Date.now()+timeoutMs;
  const assertTurn=(w:WorkerRecord)=>{
   if(w.revision!==binding.revision||w.turn?.bindingRevision!==w.revision)throw new Error('WORKER_BINDING_CHANGED');
   if(w.turn?.id!==turnId)throw new Error('WORKER_TURN_SUPERSEDED');
   if(w.deliveryPending)throw new Error('WORKER_DELIVERY_UNCERTAIN');
  };
  assertTurn(binding);
  let last:Awaited<ReturnType<Agents['observe']>>|undefined;
  do{
   if(signal?.aborted)throw new Error('WORKER_WAIT_CANCELLED');
   if(this.closed)throw new Error('WORKER_CLOSED');
   const current=await this.resolveOptional(binding.agentId);
   if(!current){
    if(!await this.bindingPaneExists(binding))return {reason:'worker_disappeared',lastObservation:last??null};
    throw new Error('WORKER_NO_LONGER_MANAGED');
   }
   assertTurn(current);
   try{last=await this.observe(binding.agentId);}
   catch(e){
    if(e instanceof Error&&e.message.includes('disappeared')&&!await this.bindingPaneExists(binding))return {reason:'worker_disappeared',lastObservation:last??null};
    throw e;
   }
   // Input and reattachment can interleave between observations; do not answer for a newer turn.
   const after=await this.resolveOptional(binding.agentId);if(after)assertTurn(after);else continue;
   if(last.turnId!==turnId)throw new Error('WORKER_TURN_SUPERSEDED');
   if(last.inputRequired)return {reason:'input_required',lastObservation:last};
   if(last.readyForPrompt)return {reason:'turn_finished',provenance:'heuristic',lastObservation:last};
   if(quietMs!==undefined&&Date.now()-Math.max(last.lastOutputAt,last.lastInputAt??0)>=quietMs)return {reason:'output_quiet',lastObservation:last};
   if(Date.now()>=deadline)break;
   await new Promise(r=>setTimeout(r,Math.min(250,Math.max(0,deadline-Date.now()))));
  }while(Date.now()<=deadline);
  return {reason:'timeout',lastObservation:last??null};
 });}
 async snapshot(){const workers=await this.list();return Promise.all(workers.map(async w=>{if(w.attachment==='detached')return w;try{return await this.observe(w.agentId);}catch(e){return {...w,error:String(e)};}}));}
}
