import { emptyTaskState,validateTaskState,type TaskState } from './task-model.js';

/**
 * Implementations must isolate callback state, serialize transactions across all users of
 * the same store, validate before committing, and never commit when the callback throws.
 * Callbacks are synchronous and must not perform external side effects. Returned values
 * must not alias retained storage. A future FileJournal adapter supplies durability.
 */
export interface TaskStorage {
 warning?:string;
 transaction<T>(write:boolean,fn:(state:TaskState)=>{state?:TaskState;result:T}):Promise<T>;
}

/** Isolated test/embedding storage; deliberately not a durable default. */
export class MemoryTaskStorage implements TaskStorage {
 private state:TaskState;
 constructor(initial:TaskState=emptyTaskState()){this.state=validateTaskState(initial);}
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
