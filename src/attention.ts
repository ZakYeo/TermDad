import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { categories,projectAttention,workerStatus,type AttentionEntry,type TaskSnapshot,type WorkerSnapshot } from './attention-model.js';
import { compare,taskFingerprints,workerFingerprints,type Change,type Fingerprints } from './attention-changes.js';

export const attentionSchema=z.object({
 boardId:z.string().trim().min(1).max(200).optional(),since:z.uuid().optional(),pageCursor:z.uuid().optional(),
 offset:z.number().int().min(0).max(2128).optional(),limit:z.number().int().min(1).max(100).default(50),
}).strict().superRefine((v,ctx)=>{
 if(v.pageCursor&&(v.boardId!==undefined||v.since!==undefined))ctx.addIssue({code:'custom',message:'pageCursor cannot be combined with boardId or since'});
 if(!v.pageCursor&&v.offset!==undefined)ctx.addIssue({code:'custom',message:'offset requires pageCursor'});
});
interface Sources {tasks:boolean;workers:boolean;}
interface Snapshot {
 cursor:string;boardId:string|null;generatedAt:string;startedAt:string;expiresAt:number;
 entries:AttentionEntry[];changes:Change[];tasks:Fingerprints|null;workers:Fingerprints|null;
 sources:Sources;warnings:string[];baseline:{reset:boolean;reason:string|null;since:string|null;incompleteSources:string[]};
}
/** Bounded, process-local comparisons. No task writes, terminal text retention, or implicit acknowledgments. */
export class AttentionService {
 private snapshots=new Map<string,Snapshot>();
 private pending:Promise<Snapshot>|undefined;
 private closed=false;
 constructor(private readonly readTasks:()=>Promise<TaskSnapshot>,private readonly readWorkers:()=>Promise<WorkerSnapshot>,private readonly now:()=>number=Date.now){}
 async close(){this.closed=true;await this.pending?.catch(()=>{});this.snapshots.clear();}
 async status(input:unknown={}){
  const query=attentionSchema.parse(input);
  if(this.closed)throw new Error('ATTENTION_CLOSED');
  this.expire();
  let snapshot:Snapshot;
  if(query.pageCursor){
   const saved=this.snapshots.get(query.pageCursor);
   if(!saved)throw new Error('ATTENTION_PAGE_EXPIRED: request a fresh attention snapshot');
   snapshot=saved;
  }else{
   if(this.pending)throw new Error('ATTENTION_BUSY: another attention refresh is in progress');
   this.pending=this.capture(query.boardId,query.since);
   try{snapshot=await this.pending;}finally{this.pending=undefined;}
  }
  const offset=query.offset??0,end=offset+query.limit;
  const entries=snapshot.entries.slice(offset,end),changes=snapshot.changes.slice(offset,end);
  const counts=Object.fromEntries(categories.map(c=>[c,snapshot.sources.tasks&&(c!=='needs_decision'||snapshot.sources.workers)?snapshot.entries.filter(e=>e.categories.includes(c)).length:null]));
  // Ages describe the frozen collection, so subsequent pages are identical even as time passes.
  return structuredClone({cursor:snapshot.cursor,boardId:snapshot.boardId,generatedAt:snapshot.generatedAt,
   collection:{startedAt:snapshot.startedAt,finishedAt:snapshot.generatedAt},sources:snapshot.sources,warnings:snapshot.warnings,
   baseline:snapshot.baseline,counts,entries,changes,
   pagination:{offset,limit:query.limit,entryTotal:snapshot.entries.length,changeTotal:snapshot.changes.length,
    nextOffset:end<Math.max(snapshot.entries.length,snapshot.changes.length)?end:null,pageCursor:snapshot.cursor},
  });
 }
 private expire(){for(const [id,snapshot] of this.snapshots)if(snapshot.expiresAt<=this.now())this.snapshots.delete(id);}
 private async capture(boardId?:string,since?:string):Promise<Snapshot>{
  const startedAt=new Date(this.now()).toISOString();
  const previous=since?this.snapshots.get(since):undefined;
  const baseline=previous&&previous.boardId===(boardId??null)?previous:undefined;
  const [taskRead,workerRead]=await Promise.allSettled([this.readTasks(),this.readWorkers()]);
  const tasks=taskRead.status==='fulfilled'?taskRead.value:null;
  const workerData=workerRead.status==='fulfilled'?workerRead.value:null;
  const now=this.now(),workers=workerData?.map(w=>workerStatus(w,now))??null;
  const entries=projectAttention(tasks,workers,boardId);
  const scopedWorkers=boardId===undefined?workers:tasks?workers?.filter(w=>tasks.tasks.some(t=>t.boardId===boardId&&t.assignedAgentId===w.agentId))??null:null;
  const sources={tasks:tasks!==null,workers:scopedWorkers!==null};
  const taskPrints=tasks?taskFingerprints(tasks,entries,boardId):null;
  const workerPrints=scopedWorkers?workerFingerprints(scopedWorkers):null;
  const changes=baseline?[...compare('task',baseline.tasks,taskPrints,!baseline.sources.workers||!sources.workers),...compare('worker',baseline.workers,workerPrints)]:[];
  const warnings=[...(!tasks?['TASK_SOURCE_UNAVAILABLE']:[]),...(!workerData?['WORKER_SOURCE_UNAVAILABLE']:[]),
   ...(tasks?.storageWarning?[tasks.storageWarning]:[]),
   ...new Set(workerData?.flatMap(w=>'storageWarning' in w&&w.storageWarning?[w.storageWarning]:[])??[])];
  const snapshot:Snapshot={cursor:randomUUID(),boardId:boardId??null,generatedAt:new Date(now).toISOString(),startedAt,expiresAt:now+15*60*1000,
   entries,changes,tasks:taskPrints,workers:workerPrints,sources,warnings,
   baseline:{reset:!baseline,reason:baseline?null:!since?'initial':previous?'scope_changed':'unknown_or_expired',since:since??null,
    incompleteSources:(['tasks','workers'] as const).filter(s=>!sources[s]||(baseline&&!baseline.sources[s]))},
  };
  this.expire();
  while(this.snapshots.size>=16)this.snapshots.delete(this.snapshots.keys().next().value!);
  this.snapshots.set(snapshot.cursor,snapshot);
  return snapshot;
 }
}
