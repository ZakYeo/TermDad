import type { AttentionEntry,TaskSnapshot,WorkerStatus } from './attention-model.js';

type Fields=Record<string,string|number|boolean|null>;
export type Fingerprints=Map<string,Fields>;
export interface Change {kind:'task'|'worker';id:string;change:'added'|'removed'|'updated';changedFields:string[];before:Fields|null;after:Fields|null;}
export function taskFingerprints(tasks:TaskSnapshot,entries:AttentionEntry[],boardId?:string):Fingerprints {
 const byId=new Map(entries.filter(e=>e.kind==='task').map(e=>[e.id,e]));
 return new Map(tasks.tasks.filter(t=>boardId===undefined||t.boardId===boardId).map(t=>[t.id,{
  revision:t.revision,status:t.status,archived:t.archived,ready:t.ready,
  currentAttemptId:t.currentAttemptId,reportId:t.latestReport?.id??null,verificationStatus:t.verification.status,
  categories:JSON.stringify(byId.get(t.id)?.categories??[]),reasons:JSON.stringify(byId.get(t.id)?.reasons??[]),
 }]));
}
export function workerFingerprints(workers:WorkerStatus[]):Fingerprints {
 return new Map(workers.map(w=>[w.agentId,{
  name:w.name,paneId:w.paneId,availability:w.availability,status:w.status,bindingRevision:w.bindingRevision,
  outputHash:w.outputHash,turnId:w.turnId,taskId:w.attempt?.taskId??null,attemptId:w.attempt?.attemptId??null,
  inputRequired:w.inputRequired,inputRequest:JSON.stringify(w.inputRequest),readyForPrompt:w.readyForPrompt,
  deliveryPending:w.deliveryPending,uncertainty:JSON.stringify(w.uncertainty),
 }]));
}
export function compare(kind:Change['kind'],before:Fingerprints|null,after:Fingerprints|null,omitDerived=false):Change[]{
 // Source failure is not evidence that records disappeared or were created.
 if(!before||!after)return [];
 const changes:Change[]=[];
 for(const id of new Set([...before.keys(),...after.keys()])){
  const old=before.get(id)??null,current=after.get(id)??null;
  const fields=[...new Set([...Object.keys(old??{}),...Object.keys(current??{})])]
   .filter(key=>!(omitDerived&&['categories','reasons'].includes(key))&&old?.[key]!==current?.[key]);
  if(!old||!current||fields.length)changes.push({kind,id,change:!old?'added':!current?'removed':'updated',changedFields:fields,before:old,after:current});
 }
 return changes.sort((a,b)=>a.id.localeCompare(b.id));
}
