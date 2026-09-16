import { FileJournal } from './journal.js';
import { emptyTaskState,validateTaskState,type TaskState } from './task-model.js';

/**
 * Implementations must isolate callback state, serialize transactions across all users of
 * the same store, validate before committing, and never commit when the callback throws.
 * Callbacks are synchronous and must not perform external side effects. Returned values
 * must not alias retained storage. FileTaskStorage supplies durability through the shared journal.
 */
export interface TaskStorage {
 warning?:string;
 transaction<T>(write:boolean,fn:(state:TaskState)=>{state?:TaskState;result:T}):Promise<T>;
}

/** Isolated test/embedding storage; deliberately not a durable default. */
export class MemoryTaskStorage implements TaskStorage {
 private state:TaskState;
 constructor(initial:unknown=emptyTaskState()){this.state=validateTaskState(initial);}
 async transaction<T>(write:boolean,fn:(state:TaskState)=>{state?:TaskState;result:T}):Promise<T>{
  const outcome=fn(structuredClone(this.state));
  if(outcome.state){
   if(!write)throw new Error('TASK_STORAGE_READ_ONLY');
   const next=validateTaskState(outcome.state),result=structuredClone(outcome.result);
   this.state=next;return result;
  }
  return structuredClone(outcome.result);
 }
}

/** Durable task records use the same private directory and atomic journal as workers. */
export class FileTaskStorage extends FileJournal<TaskState> implements TaskStorage {
 constructor(directory?:string){super('tasks','TASK',emptyTaskState,validateTaskState,directory);}
 override transaction<T>(write:boolean,fn:(state:TaskState)=>{state?:TaskState;result:T}):Promise<T>{
  return super.transaction(write,state=>{
   const outcome=fn(state);
   if(outcome.state&&!write)throw new Error('TASK_STORAGE_READ_ONLY');
   return outcome;
  });
 }
}
