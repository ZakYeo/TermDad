import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EventQueue,eventFilterSchema } from './events.js';
import { stateDirectory } from './journal.js';

/** Kinds a supervisor is woken for by default: everything that needs a person, plus turn completion. */
export const wakeKinds=['attention_required','input_required','ready','pane_disappeared','session_ended'] as const;
const shellWord=(value:string)=>/^[A-Za-z0-9_./:=,@%+-]+$/.test(value)?value:`'${value.replaceAll("'",`'\\''`)}'`;
/**
 * The one command that arms a wake. The server names it because bare `term-dad` is not on
 * PATH and `dist/wait-cli.js` is a module that exits at once; both were tried in the field.
 * `--state-dir` is explicit because the waiter runs in the caller's environment, not the server's.
 */
export function wakeCommand(stateDir=stateDirectory(),execPath=process.execPath){
 const entry=fileURLToPath(new URL('./index.js',import.meta.url)),command=[execPath,entry,'wait-for-event'];
 const args=['--until-event','--state-dir',stateDir,'--kinds',wakeKinds.join(',')];
 // A server run from source (tsx) has no index.js beside it; say so rather than hand out a path that cannot run.
 const warning=existsSync(entry)?undefined:`entry point ${entry} does not exist; run the waiter from a built dist/ instead`;
 return {command,stateDir,kinds:[...wakeKinds],example:[...command,...args].map(shellWord).join(' '),...(warning?{warning}:{})};
}

export function registerEventTools(server:McpServer,queue:EventQueue){
 const result=async(fn:()=>Promise<unknown>)=>{try{return {content:[{type:'text' as const,text:JSON.stringify(await fn())}]};}catch(e){return {isError:true,content:[{type:'text' as const,text:e instanceof Error?e.message:'Event operation failed'}]};}};
 server.registerTool('event.list',{description:'List durable pending metadata events in sequence order. Does not acknowledge them.',inputSchema:{...eventFilterSchema.shape,includeAcknowledged:z.boolean().default(false),limit:z.number().int().min(1).max(1000).default(100)}},async({includeAcknowledged,limit,...filter})=>result(()=>queue.list(filter,includeAcknowledged,limit)));
 server.registerTool('event.acknowledge',{description:'Idempotently acknowledge durable events. Unknown or expired IDs are reported.',inputSchema:{ids:z.array(z.uuid()).min(1).max(100)}},async({ids})=>result(()=>queue.acknowledge(ids)));
 server.registerTool('event.wait_for_event',{description:'Wait for an event matching all supplied filters. Fresh by default: only events published after the wait arms, so a pending backlog cannot fire as new. Pass freshOnly:false to drain history. Never infers worker success and does not acknowledge.',inputSchema:{...eventFilterSchema.shape,timeoutMs:z.number().int().min(1).max(120000).default(30000),freshOnly:z.boolean().default(true)}},async({timeoutMs,freshOnly,...filter},extra)=>result(()=>queue.wait(filter,timeoutMs,extra.signal,freshOnly)));
 server.registerTool('event.wake_command',{description:'The exact detached command that wakes an idle supervisor when an event lands. Run its example verbatim as a background process; never run dist/wait-cli.js directly and never assume term-dad is on PATH. Read-only.',inputSchema:{}},async()=>result(async()=>wakeCommand()));
 const stopSweeper=queue.startSweeper();
 const onclose=server.server.onclose;
 server.server.onclose=async()=>{stopSweeper();await queue.close();await onclose?.();};
}
