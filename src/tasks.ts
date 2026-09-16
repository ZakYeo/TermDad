import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
 MAX_TASKS,createTaskSchema,taskFilterSchema,taskIdentity,taskView,updateTaskSchema,
 validateTaskState,type Task,type TaskState,
} from './task-model.js';
import type { TaskStorage } from './task-storage.js';

export const assignTaskSchema=z.object({...taskIdentity,agentId:z.uuid().nullable()}).strict();
export const archiveTaskSchema=z.object({...taskIdentity,archived:z.boolean()}).strict();
const priorities={urgent:0,high:1,normal:2,low:3};

/** Task truth is explicit metadata, independent of terminal readiness or worker lifetime. */
export class TaskBoard {
 private operations=new Set<Promise<unknown>>();
 private closed=false;
 constructor(readonly storage:TaskStorage){}
 private run<T>(fn:()=>Promise<T>):Promise<T>{
  if(this.closed)return Promise.reject(new Error('TASK_BOARD_CLOSED'));
  if(this.operations.size>=128)return Promise.reject(new Error('TASK_OPERATION_LIMIT'));
  const operation=Promise.resolve().then(fn);this.operations.add(operation);
  void operation.finally(()=>this.operations.delete(operation)).catch(()=>{});return operation;
 }
 async close(){this.closed=true;await Promise.allSettled([...this.operations]);}
 private find(state:TaskState,id:string){const task=state.tasks.find(t=>t.id===id);if(!task)throw new Error('TASK_NOT_FOUND');return task;}
 create(input:unknown){return this.run(async()=>{
  const fields=createTaskSchema.parse(input);
  return this.storage.transaction(true,state=>{
   if(state.tasks.length>=MAX_TASKS)throw new Error('TASK_CAPACITY: archived tasks count toward capacity');
   const now=new Date().toISOString();
   const task:Task={...fields,id:randomUUID(),status:'todo',archived:false,revision:1,createdAt:now,updatedAt:now};
   state.tasks.push(task);validateTaskState(state);
   return {state,result:taskView(task,state)};
  });
 });}
 get(taskId:string){return this.run(async()=>{
  z.uuid().parse(taskId);return this.storage.transaction(false,state=>({result:taskView(this.find(state,taskId),state)}));
 });}
 list(input:unknown={}){return this.run(async()=>{
  const filter=taskFilterSchema.parse(input);
  return this.storage.transaction(false,state=>{
   const tasks=state.tasks.filter(t=>(filter.includeArchived||!t.archived)&&
    (filter.boardId===undefined||t.boardId===filter.boardId)&&
    (filter.assignedAgentId===undefined||t.assignedAgentId===filter.assignedAgentId)&&
    (filter.status===undefined||t.status===filter.status)&&(filter.priority===undefined||t.priority===filter.priority))
    .map(t=>taskView(t,state)).filter(t=>!filter.readyOnly||t.ready)
    .sort((a,b)=>priorities[a.priority]-priorities[b.priority]||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
   const end=filter.offset+filter.limit;
   return {result:{tasks:tasks.slice(filter.offset,end),total:tasks.length,nextOffset:end<tasks.length?end:null,storageWarning:this.storage.warning??null}};
  });
 });}
 private change(taskId:string,expectedRevision:number,apply:(task:Task)=>void){
  return this.storage.transaction(true,state=>{
   const task=this.find(state,taskId);
   if(task.revision!==expectedRevision)throw new Error('TASK_REVISION_CONFLICT: reload the task before retrying');
   if(task.revision===Number.MAX_SAFE_INTEGER)throw new Error('TASK_REVISION_OVERFLOW');
   apply(task);task.revision++;task.updatedAt=new Date(Math.max(Date.now(),Date.parse(task.updatedAt))).toISOString();
   validateTaskState(state);return {state,result:taskView(task,state)};
  });
 }
 update(input:unknown){return this.run(async()=>{
  const {taskId,expectedRevision,patch}=updateTaskSchema.parse(input);
  return this.change(taskId,expectedRevision,task=>{
   if(task.archived)throw new Error('TASK_ARCHIVED: unarchive before editing');
   for(const [key,value] of Object.entries(patch))if(value!==undefined)Object.assign(task,{[key]:value});
  });
 });}
 assign(input:unknown){return this.run(async()=>{
  const {taskId,expectedRevision,agentId}=assignTaskSchema.parse(input);
  return this.change(taskId,expectedRevision,task=>{
   if(task.archived)throw new Error('TASK_ARCHIVED: unarchive before assigning');
   task.assignedAgentId=agentId;
  });
 });}
 archive(input:unknown){return this.run(async()=>{
  const {taskId,expectedRevision,archived}=archiveTaskSchema.parse(input);
  return this.change(taskId,expectedRevision,task=>{task.archived=archived;});
 });}
}
