import { randomUUID } from 'node:crypto';
import { unlink,type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { attemptReferenceSchema } from './task-results.js';
import { FileJournal,acquireLock } from './journal.js';

export const instanceSchema=z.object({endpoint:z.string().min(1).max(8192),key:z.string().min(1).max(1024)}).strict();
export type TerminalInstance=z.infer<typeof instanceSchema>;
export const workerSchema=z.object({
 agentId:z.uuid(),name:z.string().min(1).max(100),paneId:z.number().int().nonnegative().safe().nullable(),
 cli:z.enum(['claude','codex','shell']),instance:instanceSchema.nullable(),sessionId:z.uuid(),revision:z.uuid(),
 turn:z.object({id:z.uuid(),bindingRevision:z.uuid(),attempt:attemptReferenceSchema.optional()}).strict().optional(),
 workerSkillSent:z.boolean(),deliveryPending:z.boolean(),lastInputAt:z.number().nonnegative().optional(),
 // Records that this pane was launched with a hook surface, and where it rereads its
 // credentials. Never the token: the path is stored absolute because the baked argv is
 // immutable, so this is the only record of what the worker actually reads.
 push:z.object({credentialPath:z.string().min(1).max(4096),surface:z.enum(['claude_hooks','codex_notify'])}).strict().optional(),
 inputOutputHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type WorkerRecord=z.infer<typeof workerSchema>;
export type WorkerState={version:1;workers:WorkerRecord[]};
const schema=z.object({version:z.literal(1),workers:z.array(workerSchema).max(64)}).strict();
const empty=():WorkerState=>({version:1,workers:[]});
function validate(value:unknown):WorkerState {
 const parsed=schema.safeParse(value);
 if(!parsed.success)throw new Error('WORKER_STATE_CORRUPT: invalid worker journal; preserve it for explicit recovery');
 const ids=new Set<string>(),names=new Set<string>(),panes=new Set<string>();
 for(const w of parsed.data.workers){
  const pane=JSON.stringify([w.instance?.key??'unverified',w.paneId]);
  if(ids.has(w.agentId)||names.has(w.name)||(w.paneId!==null&&panes.has(pane)))throw new Error('WORKER_STATE_CORRUPT: duplicate mapping');
  ids.add(w.agentId);names.add(w.name);if(w.paneId!==null)panes.add(pane);
 }
 return parsed.data;
}
export interface WorkerStorage {
 warning?:string;
 transaction<T>(write:boolean,fn:(state:WorkerState)=>{state?:WorkerState;result:T}):Promise<T>;
 exclusive<T>(agentId:string,fn:()=>Promise<T>):Promise<T>;
}

export class FileWorkerStorage extends FileJournal<WorkerState> implements WorkerStorage {
 constructor(directory?:string){super('workers','WORKER',empty,validate,directory);}
 protected async releaseWorkerLock(lock:FileHandle,path:string){await lock.close();await unlink(path);}
 async exclusive<T>(agentId:string,fn:()=>Promise<T>):Promise<T>{
  z.uuid().parse(agentId);
  // Establish and validate the private directory before creating a lock in it.
  await this.transaction(true,()=>({result:undefined}));
  const path=join(this.directory,`worker-${agentId}.lock`);
  let lock;
  try{lock=await acquireLock(path);}catch{throw new Error('WORKER_BUSY: Input already in progress or lifecycle operation locked; retry. A lock left by a process that has exited is reclaimed automatically');}
  try{return await fn();}
  finally{
   try{await this.releaseWorkerLock(lock,path);}
   catch{this.warning='WORKER_LOCK_CLEANUP_WARNING: operation outcome preserved; stop all servers before removing stale worker locks';}
  }
 }
}

/** Explicitly injectable, isolated storage for embedders and deterministic tests. */
export class MemoryWorkerStorage implements WorkerStorage {
 private state=empty();
 private locks=new Set<string>();
 async transaction<T>(_write:boolean,fn:(state:WorkerState)=>{state?:WorkerState;result:T}){
  const value=fn(structuredClone(this.state));
  if(value.state)this.state=validate(structuredClone(value.state));
  return value.result;
 }
 async exclusive<T>(agentId:string,fn:()=>Promise<T>){
  if(this.locks.has(agentId))throw new Error('WORKER_BUSY: Input already in progress');
  this.locks.add(agentId);try{return await fn();}finally{this.locks.delete(agentId);}
 }
}
export function newWorker(name:string,cli:WorkerRecord['cli'],paneId:number|null,instance:TerminalInstance|null,sessionId:string):WorkerRecord {
 return workerSchema.parse({agentId:randomUUID(),name,cli,paneId,instance,sessionId,revision:randomUUID(),workerSkillSent:false,deliveryPending:false});
}
