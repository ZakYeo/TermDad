import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WatchManager,watchShape } from './watches.js';
export function registerWatchTools(server:McpServer,watches:WatchManager){
 const register=(name:string,description:string,inputSchema:z.ZodRawShape,fn:(a:any)=>unknown)=>server.registerTool(name,{description,inputSchema},async a=>{try{return {content:[{type:'text' as const,text:JSON.stringify(await fn(a))}]};}catch(e){const message=e instanceof z.ZodError?e.issues.map(i=>`${i.path.join('.')||'target'}: ${i.message}`).join('; '):e instanceof Error?e.message:'Watch operation failed';return {isError:true,content:[{type:'text' as const,text:message}]};}});
 register('watch.create','Watch an existing pane or managed worker. Ready and inactivity never establish success.',watchShape,a=>watches.create(a));
 register('watch.list','List watches, pending delivery counts and recoverable errors.',{},()=>watches.list());
 register('watch.remove','Remove a watch without closing its pane.',{watchId:z.string().min(1).max(100)},a=>watches.remove(a.watchId));
 const previous=server.server.onclose;
 server.server.onclose=async()=>{await watches.dispose();await previous?.();};
 return ()=>watches.dispose();
}
