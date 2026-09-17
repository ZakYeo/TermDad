import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EventQueue,eventFilterSchema } from './events.js';

export function registerEventTools(server:McpServer,queue:EventQueue){
 const result=async(fn:()=>Promise<unknown>)=>{try{return {content:[{type:'text' as const,text:JSON.stringify(await fn())}]};}catch(e){return {isError:true,content:[{type:'text' as const,text:e instanceof Error?e.message:'Event operation failed'}]};}};
 server.registerTool('event.list',{description:'List durable pending metadata events in sequence order. Does not acknowledge them.',inputSchema:{...eventFilterSchema.shape,includeAcknowledged:z.boolean().default(false),limit:z.number().int().min(1).max(1000).default(100)}},async({includeAcknowledged,limit,...filter})=>result(()=>queue.list(filter,includeAcknowledged,limit)));
 server.registerTool('event.acknowledge',{description:'Idempotently acknowledge durable events. Unknown or expired IDs are reported.',inputSchema:{ids:z.array(z.uuid()).min(1).max(100)}},async({ids})=>result(()=>queue.acknowledge(ids)));
 server.registerTool('event.wait_for_event',{description:'Wait for an event matching all supplied filters. Fresh by default: only events published after the wait arms, so a pending backlog cannot fire as new. Pass freshOnly:false to drain history. Never infers worker success and does not acknowledge.',inputSchema:{...eventFilterSchema.shape,timeoutMs:z.number().int().min(1).max(120000).default(30000),freshOnly:z.boolean().default(true)}},async({timeoutMs,freshOnly,...filter},extra)=>result(()=>queue.wait(filter,timeoutMs,extra.signal,freshOnly)));
 const stopSweeper=queue.startSweeper();
 const onclose=server.server.onclose;
 server.server.onclose=async()=>{stopSweeper();await queue.close();await onclose?.();};
}
