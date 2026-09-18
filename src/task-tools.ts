import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toolCall } from './tool-result.js';
import { createTaskSchema,taskFilterSchema,updateTaskSchema } from './task-model.js';
import { startAttemptSchema,reportResultSchema,verifyTaskSchema,taskHistorySchema } from './task-results.js';
import { TaskBoard,assignTaskSchema,archiveTaskSchema } from './tasks.js';
import { withTaskAssignments,type WorkerLookup } from './task-workers.js';

/** Worker lookup enriches reads only; task mutations never dispatch or depend on the terminal. */
export function registerTaskTools(server:McpServer,board:TaskBoard,workers?:WorkerLookup){
 const invalid={invalid:'TASK_INPUT_INVALID'};
 server.registerTool('task.create',{description:'Record a task goal, priority, dependencies and acceptance criteria. Does not send input to workers.',inputSchema:createTaskSchema},a=>toolCall('task.create',()=>board.create(a),invalid));
 server.registerTool('task.get',{description:'Read a task, including archived tasks and unresolved dependencies.',inputSchema:z.object({taskId:z.uuid()}).strict()},a=>toolCall('task.get',async()=>{const task=await board.get(a.taskId);return workers?(await withTaskAssignments([task],workers))[0]:task;},invalid));
 server.registerTool('task.list',{description:'List tasks by priority with filters and bounded pagination. Readiness is based on recorded dependencies and blockers.',inputSchema:taskFilterSchema},a=>toolCall('task.list',async()=>{const page=await board.list(a);return workers?{...page,tasks:await withTaskAssignments(page.tasks,workers)}:page;},invalid));
 server.registerTool('task.update',{description:'Update task metadata using its expected revision. Arrays replace previous values. Completion requires passing verification of the current report, satisfied criteria and dependencies, and no blockers.',inputSchema:updateTaskSchema},a=>toolCall('task.update',()=>board.update(a),invalid));
 server.registerTool('task.assign',{description:'Record a worker UUID assignment, or null to unassign. Does not verify worker availability or dispatch input.',inputSchema:assignTaskSchema},a=>toolCall('task.assign',()=>board.assign(a),invalid));
 server.registerTool('task.archive',{description:'Archive or restore a task without deleting it or satisfying dependencies. Requires the expected revision.',inputSchema:archiveTaskSchema},a=>toolCall('task.archive',()=>board.archive(a),invalid));
 server.registerTool('task.start_attempt',{description:'Start an assigned task attempt without dispatching input. Supersedes previous attempts.',inputSchema:startAttemptSchema},a=>toolCall('task.start_attempt',()=>board.startAttempt(a),invalid));
 server.registerTool('task.report_result',{description:'Record a result, artifacts and reported checks. Does not complete or verify the task.',inputSchema:reportResultSchema},a=>toolCall('task.report_result',()=>board.reportResult(a),invalid));
 server.registerTool('task.verify',{description:'Record a decision against the current report and work version; optionally complete atomically. Evidence is supplied, not automatically executed.',inputSchema:verifyTaskSchema},a=>toolCall('task.verify',()=>board.verify(a),invalid));
 server.registerTool('task.history',{description:'Read bounded attempt history including full reports and verification records.',inputSchema:taskHistorySchema},a=>toolCall('task.history',()=>board.history(a),invalid));
 return ()=>board.close();
}
