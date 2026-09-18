import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { EventQueue } from './events.js';
import { registerEventTools } from './event-tools.js';
import { WezTermBackend,type TerminalBackend,id,spawnSchema,sendKeys,submit,keyDescription } from './backend.js';
import { Agents,adoptionSchema,reattachSchema } from './agents.js';
import { FileWorkerStorage,type WorkerStorage } from './worker-storage.js';
import { CommandScreenshotProvider,type ScreenshotProvider } from './screenshots.js';
import { WatchManager,type WatchOptions } from './watches.js';
import { registerWatchTools } from './watch-tools.js';
import { CommandNotificationProvider } from './notifications.js';
import { attemptReferenceSchema } from './task-results.js';
import { TaskBoard } from './tasks.js';
import { FileTaskStorage,type TaskStorage } from './task-storage.js';
import { registerTaskTools } from './task-tools.js';
import { withWorkerTasks } from './task-workers.js';
import { AttentionService } from './attention.js';
import { registerAttentionTools } from './attention-tools.js';
import { guardTerminalSelection } from './terminal-selection.js';
import { PushIngress,PushSocket,pushSocketPath } from './ingress.js';
import { WorkerPushRegistry } from './push-workers.js';
import { registerPushTools } from './push-tools.js';
import { notifyCommand } from './worker-hooks.js';
import { stateDirectory,reapStaleLocks } from './journal.js';
export function createServer(backend:TerminalBackend=new WezTermBackend(),screenshots:ScreenshotProvider=new CommandScreenshotProvider(),watchOptions:WatchOptions|EventQueue={},eventQueue?:EventQueue,workerStorage:WorkerStorage=new FileWorkerStorage(),taskStorage:TaskStorage=new FileTaskStorage()){
 const server=new McpServer({name:'term-dad',version:'0.1.0'}),tasks=new TaskBoard(taskStorage);
 const socketPath=pushSocketPath(stateDirectory());
 // A pushed event still publishes bounded metadata; `watches.confirm` then samples the pane
 // so the recorded status comes from the terminal rather than from the worker's claim.
 const ingress=new PushIngress({sink:async event=>{await events.publish(event);await watches.confirm(event.paneId);}});
 const pushSocket=new PushSocket(ingress,socketPath);
 const stateDir=stateDirectory();
 const push=new WorkerPushRegistry(ingress,socketPath,notifyCommand(),stateDir);
 const agents=new Agents(backend,workerStorage,push);
 // Push can then report on a managed worker it holds no registration for, rather than failing,
 // accept the worker's name, and re-key a surviving worker on demand under its own lock.
 push.attachWorkers(async agentIdOrName=>{
  const w=await agents.resolveOptional(agentIdOrName);
  if(!w)return undefined;
  const attached=w.paneId!==null&&await agents.isAttached(w).catch(()=>false);
  return {agentId:w.agentId,cli:w.cli,push:w.push,...(attached?{rekey:()=>agents.rekey(w.agentId)}:{})};
 });
 guardTerminalSelection(server);
 const register=(name:string,description:string,shape:z.ZodRawShape,fn:(a:any)=>Promise<unknown>)=>server.registerTool(name,{description,inputSchema:shape},async a=>{try{const result=await fn(a);return {content:[{type:'text' as const,text:JSON.stringify(result??{ok:true})}]};}catch(e){const message=e instanceof Error?e.message:String(e);console.error(`[term-dad] ${name}: ${message}`);return {isError:true,content:[{type:'text' as const,text:message}]};}});
 const pane={paneId:id},agent={agentId:z.string().min(1)},text={text:z.string().max(100000)},wait={timeoutMs:z.number().int().min(1).max(120000).default(30000)};
 register('terminal.list','List live WezTerm windows, tabs and panes.',{},()=>backend.list());
 register('terminal.list_instances','List verified running WezTerm GUIs and the selected identity (Windows/WSL).',{},async()=>{
  if(!backend.listInstances)throw new Error('GUI selection is unavailable for this backend');
  const instances=await backend.listInstances();
  try{return {instances,selected:await backend.instance?.()??null};}
  catch(e){return {instances,selected:null,selectionError:e instanceof Error?e.message:'Selected GUI unavailable'};}
 });
 register('terminal.select_instance','Switch this server to an exact GUI identity returned by terminal.list_instances; sends no input. Remove watches first.',{key:z.string().min(1).max(1024)},async a=>{
  if(!backend.selectInstance)throw new Error('GUI selection is unavailable for this backend');
  watches.assertSwitchable();
  return {selected:await backend.selectInstance(a.key)};
 });
 register('terminal.spawn','Create a visible tab or window; command is an argv array.',spawnSchema.shape,a=>backend.spawn(a));
 register('terminal.split','Split right (side by side) or bottom (stacked).',{...spawnSchema.shape,...pane,direction:z.enum(['right','bottom']).default('right'),percent:z.number().int().min(1).max(99).optional()},a=>backend.split(a));
 register('terminal.read','Read last N lines of visible text and scrollback.',{...pane,lines:z.number().int().min(1).max(5000).default(100)},a=>backend.read(a.paneId,a.lines));
 register('terminal.send_text','Paste text into an interactive PTY without Enter.',{...pane,...text},a=>backend.sendText(a.paneId,a.text));
 register('terminal.submit','Paste text then press Enter in an existing application.',{...pane,...text},a=>submit(backend,a.paneId,a.text));
 register('terminal.send_key',`Send a named terminal key without bracketed paste. ${keyDescription}`,{...pane,key:z.string().describe(keyDescription)},a=>sendKeys(backend,a.paneId,[a.key]));
 register('terminal.send_keys',`Send an ordered sequence of terminal keys without bracketed paste; validates all names before sending. ${keyDescription}`,{...pane,keys:z.array(z.string().describe(keyDescription)).min(1).max(100)},a=>sendKeys(backend,a.paneId,a.keys));
 const target={target:z.enum(['pane','tab','window']).default('pane'),id};
 register('terminal.close','Kill all processes in the selected pane, tab or window.',target,async a=>{const panes=(await backend.list()).filter(p=>p[`${a.target}_id`]===a.id);if(!panes.length)throw new Error('Target not found');for(const p of panes){await backend.close(p.pane_id);await agents.reconcileClosed(p.pane_id);}return {closed:panes.map(p=>p.pane_id)};});
 register('terminal.focus','Activate a pane or a pane in a tab/window (OS foreground is platform dependent).',target,async a=>{const p=(await backend.list()).find(p=>p[`${a.target}_id`]===a.id);if(!p)throw new Error('Target not found');await backend.focus(p.pane_id);});
 register('terminal.resize','Resize a split by cell count.',{...pane,direction:z.enum(['Left','Right','Up','Down']),amount:z.number().int().min(1).max(1000).default(1)},a=>backend.resize(a.paneId,a.direction,a.amount));
 register('terminal.move','Move pane into a new tab, optionally in a new or specified window.',{...pane,newWindow:z.boolean().optional(),windowId:id.optional()},a=>{if(a.newWindow&&a.windowId!==undefined)throw new Error('Choose newWindow or windowId');return backend.move(a.paneId,a.newWindow,a.windowId);});
 register('terminal.snapshot','Workspace panes with recent text and managed agents.',{},async()=>({panes:await Promise.all((await backend.list()).map(async p=>({...p,recentText:await backend.read(p.pane_id,30)}))),agents:await withWorkerTasks(await agents.snapshot(),tasks)}));
 register('agent.spawn','Start a visible interactive worker. Codex receives the Term Dad worker skill with its first task. Readiness timeout leaves pane available for diagnosis; never auto-approves permissions.',{...spawnSchema.shape,name:z.string().min(1).max(100),cli:z.enum(['claude','codex','shell']),prompt:z.string().max(100000).optional(),...wait},a=>agents.spawn(a));
 register('agent.list','List saved workers, attachment state and recovery reasons without terminal text.',{},async()=>withWorkerTasks(await agents.list(),tasks));
 register('agent.adopt','Adopt an existing pane without sending input; Codex initializes on the next task unless declared initialized.',adoptionSchema.shape,a=>agents.adopt(a));
 register('agent.reattach','Explicitly bind a saved worker to a pane; inspect uncertain delivery before acknowledging it.',reattachSchema.shape,a=>agents.reattach(a));
 register('agent.forget','Remove a saved mapping without closing its pane.',agent,a=>agents.forget(a.agentId));
 register('agent.send','Submit a task to the existing worker; initializes the Codex worker skill if no task has been sent yet.',{...agent,...text,attempt:attemptReferenceSchema.optional()},async a=>{if(a.attempt){const worker=await agents.resolve(a.agentId);await tasks.validateAttempt(a.attempt.taskId,a.attempt.attemptId,worker.agentId);}return agents.send(a.agentId,a.text,a.attempt);});
 for(const name of ['observe','status'])register(`agent.${name}`,'Observe state, activity and the tail of normalized output (20 lines by default). Pass since to get only the change since that observation; raise lines only when a screen is actually needed.',{...agent,since:z.string().optional(),lines:z.number().int().min(1).max(150).default(20)},a=>agents.observe(a.agentId,a.since,a.lines));
 register('agent.interrupt','Send Ctrl+C to worker.',agent,a=>agents.interrupt(a.agentId));
 register('agent.stop','Close worker pane and remove mapping.',agent,a=>agents.stop(a.agentId));
 server.registerTool('agent.wait_for_outcome',{description:'Wait for required input, heuristic turn completion, optional quiet output, disappearance or timeout. Never verifies task success. lastObservation carries the change since `since` when given, capped to `lines`.',inputSchema:{...agent,turnId:z.uuid(),...wait,quietMs:z.number().int().min(1000).max(3600000).optional(),since:z.string().optional(),lines:z.number().int().min(1).max(150).default(20)}},async(a,extra)=>{
  try{return {content:[{type:'text' as const,text:JSON.stringify(await agents.waitForOutcome(a.agentId,a.turnId,a.timeoutMs,a.quietMs,extra.signal,{since:a.since,lines:a.lines}))}]};}
  catch(e){return {isError:true,content:[{type:'text' as const,text:e instanceof Error?e.message:'Worker wait failed'}]};}
 });
 register('agent.wait_for_text','Wait for literal text in recent output.',{...agent,text:z.string().min(1),...wait},a=>agents.wait(a.agentId,o=>o.recentText.includes(a.text),a.timeoutMs));
 register('agent.wait_until_idle','Wait for a recognized prompt; silence alone never counts.',{...agent,...wait},a=>agents.wait(a.agentId,o=>['READY_FOR_PROMPT','IDLE'].includes(o.status),a.timeoutMs));
 register('agent.broadcast','Submit a message to explicit workers; returns per-agent outcomes.',{agentIds:z.array(z.string()).min(1).max(64),...text},async a=>Promise.all(a.agentIds.map(async (agentId:string)=>{try{return await agents.send(agentId,a.text);}catch(e){return {agentId,error:String(e)};}})));
 register('agent.collect_results','Collect observations; does not infer task success from idle state.',{},async()=>withWorkerTasks(await agents.snapshot(),tasks));
 register('orchestrator.status','Status, activity and task summary of every managed agent without screen text; use agent.status for the one you need to read.',{},async()=>withWorkerTasks(await agents.summaries(),tasks));
 for(const kind of ['terminal','agent'])server.registerTool(`${kind}.screenshot`,{description:'Capture on demand through the configured platform screenshot provider.',inputSchema:kind==='terminal'?pane:agent},async(a:any)=>{try{return {content:[await (kind==='terminal'?screenshots.capture(a.paneId,await backend.instance?.()):agents.withPane(a.agentId,(paneId,instance)=>screenshots.capture(paneId,instance)))]};}catch(e){return {isError:true,content:[{type:'text' as const,text:String(e)}]};}});
 const events:EventQueue=watchOptions instanceof EventQueue?watchOptions:eventQueue??new EventQueue();
 const options=watchOptions instanceof EventQueue?{}:watchOptions;
 const watches:WatchManager=new WatchManager(backend,agents,{notifications:CommandNotificationProvider.fromEnvironment(),pushDeliverable:agentId=>push.deliverable(agentId),...options,sink:options.sink??(input=>events.publish(input))});
 // Register the event close handler first so watch disposal drains its sink before queue close.
 const previousClose=server.server.onclose;
 server.server.onclose=async()=>{await pushSocket.close();await agents.close();await previousClose?.();};
 // Listening is best effort: a server that cannot bind still polls, it just cannot be pushed to.
 const pushReady=pushSocket.listen().then(path=>{push.attach({listening:true});return path;}).catch(e=>{const message=e instanceof Error?e.message:String(e);push.attach({listening:false,bindError:message});console.error(`[term-dad] push socket: ${message}`);return undefined;});
 // A worker that outlived the previous server rereads its credential file, so re-keying it is
 // what makes push recoverable without killing the pane. Skipped entirely when the socket did
 // not bind: rewriting credentials to a dead path would also strand a live peer server's worker.
 const pushRestored=pushReady.then(path=>path?agents.restorePush():undefined).catch(e=>{console.error(`[term-dad] push restore: ${e instanceof Error?e.message:e}`);});
 // Locks whose holder has exited would otherwise fail every write in every server sharing the
 // directory until someone removed them by hand. Only dead holders are reclaimed; see journal.ts.
 const reaped=reapStaleLocks(stateDir).then(removed=>{for(const name of removed)console.error(`[term-dad] reclaimed stale ${name}`);return removed;}).catch(()=>[] as string[]);
 registerTaskTools(server,tasks,()=>agents.list());
 const attention=new AttentionService(()=>tasks.snapshot(),()=>agents.snapshot());
 registerAttentionTools(server,attention);
 registerEventTools(server,events);
 registerPushTools(server,push);
 registerWatchTools(server,watches);
 // The SDK fires onclose without awaiting it, so an explicit shutdown needs a promise to wait on.
 const chain=server.server.onclose;let disposed:Promise<void>|undefined;
 const dispose=()=>disposed??=(async()=>{await chain?.();})();
 server.server.onclose=dispose;
 return {server,agents,watches,events,tasks,attention,push,ingress,pushSocket,pushReady,pushRestored,reaped,dispose};
}
