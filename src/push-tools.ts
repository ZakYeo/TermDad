import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WorkerPushRegistry } from './push-workers.js';

export function registerPushTools(server:McpServer,push:WorkerPushRegistry,socketPath:string){
 const result=async(fn:()=>unknown)=>{try{return {content:[{type:'text' as const,text:JSON.stringify(await fn())}]};}catch(e){return {isError:true,content:[{type:'text' as const,text:e instanceof Error?e.message:'Push operation failed'}]};}};
 server.registerTool('push.status',{description:'Show which panes push their own events. Push is off for every pane until it is enabled.',inputSchema:{agentId:z.string().min(1).optional()}},async({agentId})=>result(()=>agentId?{socketPath,worker:push.status(agentId)}:{socketPath,workers:push.list()}));
 server.registerTool('push.set',{description:'Turn worker-pushed events on or off for one pane. Enable it for long-running work so its watch stops scraping the pane and reports as soon as the worker itself reports; disable it to return to polling. Shell workers have no hook surface.',inputSchema:{agentId:z.string().min(1),enabled:z.boolean()}},async({agentId,enabled})=>result(()=>push.setEnabled(agentId,enabled)));
}
