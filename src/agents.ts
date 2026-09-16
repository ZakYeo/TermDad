import { createHash,randomUUID } from 'node:crypto';
import { adapters, type Status } from './adapters.js';
import { type TerminalBackend,type SpawnOptions,submit,sendKeys } from './backend.js';
export const hashOutput=(text:string)=>createHash('sha256').update(text).digest('hex');
export function delta(previous:string,current:string){if(previous===current)return {mode:'unchanged',text:''};if(current.startsWith(previous))return {mode:'append',text:current.slice(previous.length)};return {mode:'replace',text:current};}
type Observation={id:string;text:string;status:Status};
export interface Agent {agentId:string;name:string;paneId:number;cli:string;cwd?:string;lastInputAt?:number;lastOutputAt:number;outputHash:string;recentText:string;status:Status;history:Observation[];}
export class Agents {
 readonly records=new Map<string,Agent>();
 constructor(readonly backend:TerminalBackend){}
 get(agentId:string){const a=this.records.get(agentId)??[...this.records.values()].find(a=>a.name===agentId);if(!a)throw new Error(`Unknown agent: ${agentId}`);return a;}
 async spawn(o:SpawnOptions & {name:string;cli:'claude'|'codex'|'shell';prompt?:string;timeoutMs?:number}){
 if(this.records.size>=64)throw new Error('Maximum of 64 managed agents reached');
 if([...this.records.values()].some(a=>a.name===o.name))throw new Error(`Agent name already exists: ${o.name}`);
 const paneId=await this.backend.spawn({...o,command:o.command??(o.cli==='shell'?undefined:[o.cli])});
 const a:Agent={agentId:randomUUID(),name:o.name,paneId,cli:o.cli,cwd:o.cwd,lastOutputAt:Date.now(),outputHash:'',recentText:'',status:'STARTING',history:[]};this.records.set(a.agentId,a);
 if(o.prompt!==undefined){try{await this.wait(a.agentId,obs=>obs.status==='READY_FOR_PROMPT',o.timeoutMs??30000);await this.send(a.agentId,o.prompt);}catch(e){throw new Error(`Agent ${a.agentId} remains in pane ${paneId}; prompt NOT sent: ${e instanceof Error?e.message:e}`);}}
 return {agentId:a.agentId,name:a.name,paneId,status:a.status};
 }
 async observe(agentId:string,since?:string){const a=this.get(agentId);const pane=(await this.backend.list()).find(p=>p.pane_id===a.paneId);if(!pane){this.records.delete(a.agentId);throw new Error(`Pane ${a.paneId} disappeared; agent ${a.name} removed`);}
 const text=(await this.backend.read(a.paneId,150)).slice(-24000),hash=hashOutput(text),changed=hash!==a.outputHash;
 if(changed)a.lastOutputAt=Date.now();a.outputHash=hash;a.recentText=text;
 a.status=adapters[a.cli].classify(text);
 // A stale prompt immediately after submission is not evidence of readiness.
 if(a.lastInputAt && Date.now()-a.lastInputAt<750 && a.status==='READY_FOR_PROMPT')a.status='WORKING';
 const previous=since?a.history.find(h=>h.id===since):undefined;const observationId=randomUUID();const output=previous?delta(previous.text,text):{mode:'replace',text};
 a.history.push({id:observationId,text,status:a.status});if(a.history.length>16)a.history.shift();
 return {agentId:a.agentId,name:a.name,paneId:a.paneId,observationId,previousObservationId:since,deltaReset:!!since&&!previous,status:a.status,activity:changed?'changed':'unchanged',lastActivitySecondsAgo:(Date.now()-a.lastOutputAt)/1000,lastInputAt:a.lastInputAt,lastOutputAt:a.lastOutputAt,outputHash:hash,cwd:pane.cwd,process:pane.foreground_process_name??null,awaitingInput:['READY_FOR_PROMPT','WAITING_FOR_PERMISSION','WAITING_FOR_QUESTION'].includes(a.status),permissionPrompt:a.status==='WAITING_FOR_PERMISSION',recentText:output.text,outputMode:output.mode,screenshotAvailable:!!process.env.TERM_DAD_SCREENSHOT_COMMAND};
 }
 async send(agentId:string,text:string){const a=this.get(agentId);await submit(this.backend,a.paneId,text);a.lastInputAt=Date.now();a.status='WORKING';return {agentId:a.agentId,sent:true};}
 async interrupt(agentId:string){const a=this.get(agentId);await sendKeys(this.backend,a.paneId,['CTRL_C']);return {interrupted:true};}
 async stop(agentId:string){const a=this.get(agentId);await this.backend.close(a.paneId);this.records.delete(a.agentId);return {stopped:true};}
 async wait(agentId:string,predicate:(o:Awaited<ReturnType<Agents['observe']>>)=>boolean,timeoutMs=30000){const deadline=Date.now()+timeoutMs;let last;do{last=await this.observe(agentId);if(predicate(last))return last;if(Date.now()>=deadline)break;await new Promise(r=>setTimeout(r,Math.min(250,deadline-Date.now())));}while(Date.now()<=deadline);throw new Error(`Timed out waiting for ${agentId}; last status ${last?.status}`);}
 async snapshot(){return Promise.all([...this.records.keys()].map(async agentId=>{try{return await this.observe(agentId);}catch(e){return {agentId,error:String(e)};}}));}
}
