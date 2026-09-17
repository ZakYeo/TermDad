import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WorkerPushRegistry } from './push-workers.js';

export function registerPushTools(server:McpServer,push:WorkerPushRegistry){
 const result=async(fn:()=>unknown)=>{try{return {content:[{type:'text' as const,text:JSON.stringify(await fn())}]};}catch(e){return {isError:true,content:[{type:'text' as const,text:e instanceof Error?e.message:'Push operation failed'}]};}};
 // Reads the registry's own socket state, so an intended path can never be reported as a bound one.
 server.registerTool('push.status',{description:"Report push delivery per pane. `enabled` is worker-side intent only; `deliverable` means every link this server can see is live; `proven` means a hook has actually fired, which is the only evidence delivery works. Push is off for every pane until it is enabled.",inputSchema:{agentId:z.string().min(1).optional()}},async({agentId})=>result(async()=>agentId?{socket:push.socket(),worker:await push.status(agentId)}:{socket:push.socket(),workers:push.list()}));
 server.registerTool('push.set',{description:'Turn worker-pushed events on or off for one pane. Enable it for long-running work so its watch stops scraping the pane and reports as soon as the worker itself reports; disable it to return to polling. Enabling fails explicitly when the channel cannot deliver: PUSH_NOT_WIRED for a pane this server did not launch with hooks, PUSH_SOCKET_UNAVAILABLE when the socket did not bind, PUSH_UNSUPPORTED_WORKER for a shell worker. Disabling always succeeds.',inputSchema:{agentId:z.string().min(1),enabled:z.boolean()}},async({agentId,enabled})=>result(()=>push.setEnabled(agentId,enabled)));
}
