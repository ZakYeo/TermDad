import { randomUUID } from 'node:crypto';
import { FileJournal } from './journal.js';
import { z } from 'zod';

const token=z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.:/-]+$/);
const identifier=z.string().min(1).max(100).regex(/^[^\x00-\x1f\x7f]*$/);
export const eventInputSchema=z.object({kind:token,paneId:z.number().int().nonnegative().safe(),watchId:identifier.optional(),agentId:identifier.optional(),occurredAt:z.iso.datetime({offset:true}).max(64),summary:z.string().min(1).max(240).regex(/^[^\x00-\x1f\x7f]*$/)}).strict();
export type EventInput=z.infer<typeof eventInputSchema>;
const eventSchema=eventInputSchema.extend({id:z.uuid(),sequence:z.number().int().positive().safe(),acknowledgedAt:z.iso.datetime().max(64).nullable()});
export type QueueEvent=z.infer<typeof eventSchema>;
const stateSchema=z.object({version:z.literal(1),nextSequence:z.number().int().positive().safe(),events:z.array(eventSchema).max(1000)}).strict();
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

export const eventFilterSchema=z.object({paneIds:z.array(z.number().int().nonnegative().safe()).min(1).max(64).optional(),agentIds:z.array(identifier).min(1).max(64).optional(),watchIds:z.array(identifier).min(1).max(64).optional(),kinds:z.array(token).min(1).max(64).optional(),afterSequence:z.number().int().nonnegative().safe().optional()}).strict();
export type EventFilter=z.infer<typeof eventFilterSchema>;
function matches(e:QueueEvent,f:EventFilter){return (!f.paneIds||f.paneIds.includes(e.paneId))&&(!f.agentIds||(e.agentId!==undefined&&f.agentIds.includes(e.agentId)))&&(!f.watchIds||(e.watchId!==undefined&&f.watchIds.includes(e.watchId)))&&(!f.kinds||f.kinds.includes(e.kind))&&(f.afterSequence===undefined||e.sequence>f.afterSequence);}
export type WaitResult={status:'event';event:QueueEvent}|{status:'timeout'|'cancelled'|'closed'};
type Waiter={filter:EventFilter;finish:(result:WaitResult)=>void;fail:(error:unknown)=>void};
export class EventQueue {
 private tail:Promise<unknown>=Promise.resolve();
 private closed=false;
 private operations=0;
 private waiters=new Set<Waiter>();
 private polling:ReturnType<typeof setInterval>|undefined;
 private checking=false;
 constructor(readonly storage:EventStorage=new FileEventStorage(),readonly capacity=1000,readonly maxWaiters=64){
  if(!Number.isInteger(capacity)||capacity<1||capacity>1000||!Number.isInteger(maxWaiters)||maxWaiters<1||maxWaiters>64)throw new Error('Invalid event queue bounds');
 }
 private run<T>(fn:()=>Promise<T>):Promise<T>{
  if(this.closed)return Promise.reject(new Error('EVENT_QUEUE_CLOSED'));
  if(this.operations>=128)return Promise.reject(new Error('EVENT_OPERATION_LIMIT'));
  this.operations++;
  const result=this.tail.then(fn).finally(()=>{this.operations--;});this.tail=result.catch(()=>{});return result;
 }
 async publish(input:EventInput):Promise<QueueEvent>{
  const parsed=eventInputSchema.safeParse(input);if(!parsed.success)throw new Error('EVENT_INPUT_INVALID: expected bounded metadata');
  const event=await this.run(()=>this.storage.transaction(true,s=>{
   if(s.events.filter(e=>e.acknowledgedAt===null).length>=this.capacity)throw new Error('EVENT_QUEUE_FULL: acknowledge pending events and retry; no pending event was discarded');
   if(s.nextSequence>=Number.MAX_SAFE_INTEGER)throw new Error('EVENT_SEQUENCE_EXHAUSTED');
   const events=[...s.events];while(events.length>=this.capacity){const index=events.findIndex(e=>e.acknowledgedAt!==null);if(index<0)throw new Error('EVENT_QUEUE_FULL');events.splice(index,1);}
   const event:QueueEvent={...parsed.data,id:randomUUID(),sequence:s.nextSequence,acknowledgedAt:null};
   return {state:{version:1,nextSequence:s.nextSequence+1,events:[...events,event]},result:event};
  }));
  await this.checkWaiters();return event;
 }
 async list(filter:EventFilter={},includeAcknowledged=false,limit=100){
  const f=eventFilterSchema.parse(filter);if(!Number.isInteger(limit)||limit<1||limit>1000)throw new Error('Invalid event list limit');
  return this.run(()=>this.storage.transaction(false,s=>{const found=s.events.filter(e=>(includeAcknowledged||e.acknowledgedAt===null)&&matches(e,f));return {result:{events:found.slice(0,limit),hasMore:found.length>limit,pendingCount:s.events.filter(e=>e.acknowledgedAt===null).length,capacity:this.capacity,storageWarning:this.storage.warning??null}};}));
 }
 async acknowledge(ids:string[]){
  if(ids.length<1||ids.length>100||ids.some(id=>!z.uuid().safeParse(id).success))throw new Error('Invalid event IDs');
  return this.run(()=>this.storage.transaction(true,s=>{
   const wanted=new Set(ids),at=new Date().toISOString(),known=new Set(s.events.map(e=>e.id));
   const events=s.events.map(e=>wanted.has(e.id)&&!e.acknowledgedAt?{...e,acknowledgedAt:at}:e);
   return {state:{...s,events},result:{events:events.filter(e=>wanted.has(e.id)),unknownIds:[...wanted].filter(id=>!known.has(id))}};
  }));
 }
 wait(filter:EventFilter={},timeoutMs=30000,signal?:AbortSignal):Promise<WaitResult>{
  const f=eventFilterSchema.parse(filter);
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)return Promise.reject(new Error('Invalid event wait timeout'));
  if(this.closed)return Promise.resolve({status:'closed'});
  if(signal?.aborted)return Promise.resolve({status:'cancelled'});
  if(this.waiters.size>=this.maxWaiters)return Promise.reject(new Error('EVENT_WAITER_LIMIT'));
  return new Promise((resolve,reject)=>{
   const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.waiters.delete(waiter);if(!this.waiters.size&&this.polling){clearInterval(this.polling);this.polling=undefined;}};
   const waiter:Waiter={filter:f,finish:r=>{cleanup();resolve(r);},fail:e=>{cleanup();reject(e);}};
   const abort=()=>waiter.finish({status:'cancelled'}),timer=setTimeout(()=>waiter.finish({status:'timeout'}),timeoutMs);
   this.waiters.add(waiter);signal?.addEventListener('abort',abort,{once:true});
   if(!this.polling)this.polling=setInterval(()=>{void this.checkWaiters();},100);
   void this.checkWaiters();
  });
 }
 private async checkWaiters(){
  if(this.checking||!this.waiters.size||this.closed)return;
  this.checking=true;
  try{const {events}=await this.list({},false,1000);for(const waiter of this.waiters){const event=events.find(e=>matches(e,waiter.filter));if(event)waiter.finish({status:'event',event});}}
  catch(e){if(!(e instanceof Error&&e.message.startsWith('EVENT_STORAGE_BUSY')))for(const waiter of this.waiters)waiter.fail(e);}
  finally{this.checking=false;}
 }
 async close(){this.closed=true;for(const waiter of this.waiters)waiter.finish({status:'closed'});await this.tail;}
}
