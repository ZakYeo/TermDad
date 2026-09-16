import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createTaskSchema,taskFilterSchema,updateTaskSchema } from './task-model.js';
import { TaskBoard,assignTaskSchema,archiveTaskSchema } from './tasks.js';

/** Opt-in module. The production server must inject durable storage before registering. */
export function registerTaskTools(server:McpServer,board:TaskBoard){
 const result=async(fn:()=>Promise<unknown>)=>{
  try{return {content:[{type:'text' as const,text:JSON.stringify(await fn())}]};}
  catch(e){return {isError:true,content:[{type:'text' as const,text:e instanceof z.ZodError?'TASK_INPUT_INVALID':e instanceof Error?e.message:'Task operation failed'}]};}
 };
 server.registerTool('task.create',{description:'Record a task goal, priority, dependencies and acceptance criteria. Does not send input to workers.',inputSchema:createTaskSchema},a=>result(()=>board.create(a)));
 server.registerTool('task.get',{description:'Read a task, including archived tasks and unresolved dependencies.',inputSchema:z.object({taskId:z.uuid()}).strict()},a=>result(()=>board.get(a.taskId)));
 server.registerTool('task.list',{description:'List tasks by priority with filters and bounded pagination. Readiness is based on recorded dependencies and blockers.',inputSchema:taskFilterSchema},a=>result(()=>board.list(a)));
 server.registerTool('task.update',{description:'Update task metadata using its expected revision. Arrays replace previous values. Completion is explicit; all criteria and dependencies must be satisfied.',inputSchema:updateTaskSchema},a=>result(()=>board.update(a)));
 server.registerTool('task.assign',{description:'Record a worker UUID assignment, or null to unassign. Does not verify worker availability or dispatch input.',inputSchema:assignTaskSchema},a=>result(()=>board.assign(a)));
 server.registerTool('task.archive',{description:'Archive or restore a task without deleting it or satisfying dependencies. Requires the expected revision.',inputSchema:archiveTaskSchema},a=>result(()=>board.archive(a)));
 const onclose=server.server.onclose;
 server.server.onclose=async()=>{await board.close();await onclose?.();};
}
