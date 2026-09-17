import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AttentionService,attentionSchema } from './attention.js';

export function registerAttentionTools(server:McpServer,attention:AttentionService){
 server.registerTool('orchestrator.attention',{
  description:'Refresh task-focused decisions, dispatch eligibility, verification work, and net changes since a session cursor. Read-only; worker readiness is heuristic. Page frozen results using pageCursor and offset.',
  inputSchema:attentionSchema,
 },async input=>{
  try{return {content:[{type:'text' as const,text:JSON.stringify(await attention.status(input))}]};}
  catch(e){return {isError:true,content:[{type:'text' as const,text:e instanceof z.ZodError?'ATTENTION_INPUT_INVALID':e instanceof Error?e.message:'Attention unavailable'}]};}
 });
 const onclose=server.server.onclose;
 server.server.onclose=async()=>{await attention.close();await onclose?.();};
}
