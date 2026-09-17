import { randomUUID } from 'node:crypto';
import { FileJournal } from './journal.js';
import { z } from 'zod';

const token=z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.:/-]+$/);
const identifier=z.string().min(1).max(100).regex(/^[^\x00-\x1f\x7f]*$/);
export const eventInputSchema=z.object({kind:token,paneId:z.number().int().nonnegative().safe(),watchId:identifier.optional(),agentId:identifier.optional(),occurredAt:z.iso.datetime({offset:true}).max(64),summary:z.string().min(1).max(240).regex(/^[^\x00-\x1f\x7f]*$/)}).strict();
export type EventInput=z.infer<typeof eventInputSchema>;
const eventSchema=eventInputSchema.extend({id:z.uuid(),sequence:z.number().int().positive().safe(),acknowledgedAt:z.iso.datetime().max(64).nullable()});
export type QueueEvent=z.infer<typeof eventSchema>;
export const eventStateSchema=z.object({version:z.literal(1),nextSequence:z.number().int().positive().safe(),events:z.array(eventSchema).max(1000)}).strict();
const stateSchema=eventStateSchema;
export type EventState=z.infer<typeof stateSchema>;
export interface EventStorage { warning?:string; transaction<T>(write:boolean,fn:(state:EventState)=>{state?:EventState;result:T}):Promise<T> }
const empty=():EventState=>({version:1,nextSequence:1,events:[]});
function validateState(value:unknown):EventState {
 const parsed=stateSchema.safeParse(value);
 if(!parsed.success)throw new Error('EVENT_STATE_CORRUPT: invalid journal; preserve the file and recover it explicitly');
 const s=parsed.data,ids=new Set<string>();let previous=0;
 for(const e of s.events){if(ids.has(e.id)||e.sequence<=previous||e.sequence>=s.nextSequence)throw new Error('EVENT_STATE_CORRUPT: inconsistent journal');ids.add(e.id);previous=e.sequence;}
 return s;
}

export class FileEventStorage extends FileJournal<EventState> implements EventStorage {
 constructor(directory?:string){super('events','EVENT',empty,validateState,directory);}
}

export const eventFilterSchema=z.object({paneIds:z.array(z.number().int().nonnegative().safe()).min(1).max(64).optional(),agentIds:z.array(identifier).min(1).max(64).optional(),watchIds:z.array(identifier).min(1).max(64).optional(),kinds:z.array(token).min(1).max(64).optional(),afterSequence:z.number().int().nonnegative().safe().optional(),notBefore:z.iso.datetime({offset:true}).max(64).optional(),maxAgeMs:z.number().int().min(1).max(604800000).optional()}).strict();
export type EventFilter=z.infer<typeof eventFilterSchema>;
export function matches(e:QueueEvent,f:EventFilter,now=Date.now()){const at=f.notBefore!==undefined||f.maxAgeMs!==undefined?Date.parse(e.occurredAt):0;return (!f.paneIds||f.paneIds.includes(e.paneId))&&(!f.agentIds||(e.agentId!==undefined&&f.agentIds.includes(e.agentId)))&&(!f.watchIds||(e.watchId!==undefined&&f.watchIds.includes(e.watchId)))&&(!f.kinds||f.kinds.includes(e.kind))&&(f.afterSequence===undefined||e.sequence>f.afterSequence)&&(f.notBefore===undefined||at>=Date.parse(f.notBefore))&&(f.maxAgeMs===undefined||now-at<=f.maxAgeMs);}
export type WaitResult={status:'event';event:QueueEvent}|{status:'timeout'|'cancelled'|'closed'};
type Waiter={filter:EventFilter;armed:boolean;finish:(result:WaitResult)=>void;fail:(error:unknown)=>void};
/** Kinds quiet enough that an unread one is noise rather than a lost obligation. */
export const autoAcknowledgeKinds=['ready','inactive'] as const;
export class EventQueue {
 private tail:Promise<unknown>=Promise.resolve();
 private closed=false;
 private operations=0;
 private waiters=new Set<Waiter>();
 private polling:ReturnType<typeof setInterval>|undefined;
 private sweeping:ReturnType<typeof setInterval>|undefined;
 private checking=false;
 constructor(readonly storage:EventStorage=new FileEventStorage(),readonly capacity=1000,readonly maxWaiters=64,readonly now:()=>number=Date.now,readonly autoAcknowledgeMs=900000){
  if(!Number.isInteger(capacity)||capacity<1||capacity>1000||!Number.isInteger(maxWaiters)||maxWaiters<1||maxWaiters>64)throw new Error('Invalid event queue bounds');
  if(autoAcknowledgeMs!==0&&(!Number.isInteger(autoAcknowledgeMs)||autoAcknowledgeMs<60000||autoAcknowledgeMs>86400000))throw new Error('Invalid event auto-acknowledge window');
 }
 /** Ageing noise is acknowledged, never discarded; a pending record is always retained. */
 private expired(s:EventState,now:number){return this.autoAcknowledgeMs?s.events.filter(e=>e.acknowledgedAt===null&&(autoAcknowledgeKinds as readonly string[]).includes(e.kind)&&now-Date.parse(e.occurredAt)>this.autoAcknowledgeMs):[];}
 private run<T>(fn:()=>Promise<T>):Promise<T>{
  if(this.closed)return Promise.reject(new Error('EVENT_QUEUE_CLOSED'));
  if(this.operations>=128)return Promise.reject(new Error('EVENT_OPERATION_LIMIT'));
  this.operations++;
  const result=this.tail.then(fn).finally(()=>{this.operations--;});this.tail=result.catch(()=>{});return result;
 }
 async publish(input:EventInput):Promise<QueueEvent>{
  const parsed=eventInputSchema.safeParse(input);if(!parsed.success)throw new Error('EVENT_INPUT_INVALID: expected bounded metadata');
  const event=await this.run(()=>this.storage.transaction(true,s=>{
   // Expiring here also relieves capacity pressure before the full-queue check rejects a producer.
   const now=this.now(),stamp=new Date(now).toISOString(),stale=new Set(this.expired(s,now).map(e=>e.id));
   const swept=stale.size?s.events.map(e=>stale.has(e.id)?{...e,acknowledgedAt:stamp}:e):s.events;
   if(swept.filter(e=>e.acknowledgedAt===null).length>=this.capacity)throw new Error('EVENT_QUEUE_FULL: acknowledge pending events and retry; no pending event was discarded');
   if(s.nextSequence>=Number.MAX_SAFE_INTEGER)throw new Error('EVENT_SEQUENCE_EXHAUSTED');
   // Never evict a record this transaction just acknowledged: a pending event must become
   // observable as acknowledged rather than disappearing unseen inside one publish.
   const events=[...swept];while(events.length>=this.capacity){const index=events.findIndex(e=>e.acknowledgedAt!==null&&!stale.has(e.id));if(index<0)throw new Error('EVENT_QUEUE_FULL: acknowledge pending events and retry; no pending event was discarded');events.splice(index,1);}
   const event:QueueEvent={...parsed.data,id:randomUUID(),sequence:s.nextSequence,acknowledgedAt:null};
   return {state:{version:1,nextSequence:s.nextSequence+1,events:[...events,event]},result:event};
  }));
  await this.checkWaiters();return event;
 }
 /**
  * Acknowledges aged noise on demand. A read-only pass decides first, so a quiet server
  * never writes, and an absent state directory is never created merely by sweeping.
  */
 async sweep(){
  if(!this.autoAcknowledgeMs)return 0;
  const ids=await this.run(()=>this.storage.transaction(false,s=>({result:this.expired(s,this.now()).map(e=>e.id)})));
  for(let i=0;i<ids.length;i+=100)await this.acknowledge(ids.slice(i,i+100));
  return ids.length;
 }
 /** Unref'ed and bounded: the journal drains while a supervisor sleeps, without holding the process open. */
 startSweeper(){
  if(this.closed||this.sweeping||!this.autoAcknowledgeMs)return ()=>{};
  const timer=setInterval(()=>{void this.sweep().catch(()=>{});},Math.max(this.autoAcknowledgeMs/2,60000));
  timer.unref();this.sweeping=timer;
  return ()=>{clearInterval(timer);if(this.sweeping===timer)this.sweeping=undefined;};
 }
 async list(filter:EventFilter={},includeAcknowledged=false,limit=100){
  const f=eventFilterSchema.parse(filter);if(!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('Invalid event list limit');
  const now=this.now();
  return this.run(()=>this.storage.transaction(false,s=>{const found=s.events.filter(e=>(includeAcknowledged||e.acknowledgedAt===null)&&matches(e,f,now));return {result:{events:found.slice(0,limit),hasMore:found.length>limit,pendingCount:s.events.filter(e=>e.acknowledgedAt===null).length,capacity:this.capacity,storageWarning:this.storage.warning??null}};}));
 }
 async acknowledge(ids:string[]){
  if(ids.length<1||ids.length>100||ids.some(id=>!z.uuid().safeParse(id).success))throw new Error('Invalid event IDs');
  return this.run(()=>this.storage.transaction(true,s=>{
   const wanted=new Set(ids),at=new Date(this.now()).toISOString(),known=new Set(s.events.map(e=>e.id));
   const events=s.events.map(e=>wanted.has(e.id)&&!e.acknowledgedAt?{...e,acknowledgedAt:at}:e);
   return {state:{...s,events},result:{events:events.filter(e=>wanted.has(e.id)),unknownIds:[...wanted].filter(id=>!known.has(id))}};
  }));
 }
 /**
  * `fresh` means "published after this wait armed", expressed as a sequence baseline rather
  * than a timestamp: `occurredAt` is observation time, and delivery can lag it by a cooldown,
  * so a clock-based cutoff would time out while the event sat pending.
  */
 wait(filter:EventFilter={},timeoutMs=30000,signal?:AbortSignal,fresh=false):Promise<WaitResult>{
  const f=eventFilterSchema.parse(filter);
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)return Promise.reject(new Error('Invalid event wait timeout'));
  if(this.closed)return Promise.resolve({status:'closed'});
  if(signal?.aborted)return Promise.resolve({status:'cancelled'});
  if(this.waiters.size>=this.maxWaiters)return Promise.reject(new Error('EVENT_WAITER_LIMIT'));
  const arming=fresh&&f.afterSequence===undefined;
  return new Promise((resolve,reject)=>{
   const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.waiters.delete(waiter);if(!this.waiters.size&&this.polling){clearInterval(this.polling);this.polling=undefined;}};
   const waiter:Waiter={filter:f,armed:!arming,finish:r=>{cleanup();resolve(r);},fail:e=>{cleanup();reject(e);}};
   const abort=()=>waiter.finish({status:'cancelled'}),timer=setTimeout(()=>waiter.finish({status:'timeout'}),timeoutMs);
   this.waiters.add(waiter);signal?.addEventListener('abort',abort,{once:true});
   if(!this.polling)this.polling=setInterval(()=>{void this.checkWaiters();},100);
   // Registering before reading the baseline can only over-include by one event, never lose one.
   if(arming)this.run(()=>this.storage.transaction(false,s=>({result:s.nextSequence}))).then(next=>{waiter.filter={...waiter.filter,afterSequence:next-1};waiter.armed=true;void this.checkWaiters();},e=>waiter.fail(e));
   else void this.checkWaiters();
  });
 }
 private async checkWaiters(){
  if(this.checking||!this.waiters.size||this.closed)return;
  this.checking=true;
  try{const now=this.now(),{events}=await this.list({},false,1000);for(const waiter of this.waiters){if(!waiter.armed)continue;const event=events.find(e=>matches(e,waiter.filter,now));if(event)waiter.finish({status:'event',event});}}
  // Backpressure and lock contention are transient: the 100ms poll retries them. Failing every
  // parked waiter on one of them would hand a supervisor an error instead of its event.
  catch(e){const transient=e instanceof Error&&/^(EVENT_STORAGE_BUSY|EVENT_OPERATION_LIMIT|EVENT_QUEUE_CLOSED)/.test(e.message);if(!transient)for(const waiter of this.waiters)waiter.fail(e);}
  finally{this.checking=false;}
 }
 async close(){this.closed=true;if(this.sweeping){clearInterval(this.sweeping);this.sweeping=undefined;}for(const waiter of this.waiters)waiter.finish({status:'closed'});await this.tail;}
}
