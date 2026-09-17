import { PushIngress } from './ingress.js';
import { pushHookArgv,type PushHookOptions } from './worker-hooks.js';

export type WorkerCli='claude'|'codex'|'shell';
/** The push surface `Agents` needs, so worker code never depends on the transport. */
export interface WorkerPush {
 launch(agentId:string,cli:WorkerCli,command:string[]|undefined):string[]|undefined;
 bind(agentId:string,paneId:number):void;
 release(agentId:string):void;
}

/** Mints one token per worker, injects its hooks at launch, and keeps delivery off until asked. */
export class WorkerPushRegistry implements WorkerPush {
 private clis=new Map<string,WorkerCli>();
 private socketState:{listening:boolean;bindError?:string}={listening:false};
 private resolve?:(agentId:string)=>Promise<WorkerCli|undefined>;
 constructor(private ingress:PushIngress,private socketPath:string,private notify:string[]){}
 /** Lets push report on a managed worker it holds no registration for, instead of failing. */
 attachWorkers(resolve:(agentId:string)=>Promise<WorkerCli|undefined>){this.resolve=resolve;}
 /** The real bind outcome, so nothing reports an intended socket path as a bound one. */
 attach(outcome:{listening:boolean;bindError?:string}){this.socketState=outcome;}
 socket(){return {path:this.socketPath,listening:this.socketState.listening,bindError:this.socketState.bindError};}
 launch(agentId:string,cli:WorkerCli,command:string[]|undefined){
  this.clis.set(agentId,cli);
  if(cli==='shell')return command;
  const {token}=this.ingress.register(agentId,-1);
  const options:PushHookOptions={socketPath:this.socketPath,token,notify:this.notify};
  return pushHookArgv(cli,command,options);
 }
 // The token is minted before the pane exists; the pane it reports for is fixed here.
 bind(agentId:string,paneId:number){if(this.clis.get(agentId)!=='shell')this.ingress.rebind(agentId,paneId);}
 release(agentId:string){this.clis.delete(agentId);this.ingress.revoke(agentId);}
 private surface(agentId:string,cli?:WorkerCli){const known=cli??this.clis.get(agentId);return known==='claude'?'claude_hooks':known==='codex'?'codex_notify':null;}
 /**
  * Turning delivery off always succeeds and is idempotent: the safe direction must never be
  * blocked by the reasons a channel is broken. Turning it on fails explicitly instead of
  * returning a success value that describes wiring intent rather than deliverability.
  */
 setEnabled(agentId:string,enabled:boolean){
  if(!enabled){const revoked=this.ingress.revoked(agentId);return revoked?{agentId,enabled:false,registered:false}:{...this.ingress.setEnabled(agentId,false),registered:true};}
  if(this.clis.get(agentId)==='shell')throw new Error('PUSH_UNSUPPORTED_WORKER: shell workers have no hook surface; use a watch instead');
  if(!this.surface(agentId))throw new Error(`PUSH_NOT_WIRED: worker ${agentId} has no hook surface in this server, so a hook can never reach it; respawn it with agent.spawn, or watch its pane instead`);
  if(!this.socketState.listening)throw new Error(`PUSH_SOCKET_UNAVAILABLE: this server did not bind its push socket (${this.socketState.bindError??'reason unavailable'}); keep polling`);
  const view=this.ingress.setEnabled(agentId,true);
  return {...view,registered:true,hookSurface:this.surface(agentId),socket:this.socket(),deliverable:this.deliverable(agentId),note:'enabled; no hook has fired yet, so delivery is not proven'};
 }
 async status(agentId:string){
  const cli=await this.resolve?.(agentId);
  if(this.ingress.revoked(agentId)){
   if(cli===undefined&&!this.clis.has(agentId))throw new Error(`PUSH_UNKNOWN_WORKER: no push registration for ${agentId}`);
   return {agentId,paneId:null,registered:false,enabled:false,hookSurface:this.surface(agentId,cli),deliveries:{count:0,lastAt:null,lastKind:null},proven:false,socket:this.socket(),deliverable:false,reason:'no push registration in this server; a surviving worker needs push enabled again explicitly'};
  }
  return {...this.ingress.status(agentId),registered:true,hookSurface:this.surface(agentId,cli),socket:this.socket(),deliverable:this.deliverable(agentId)};
 }
 list(){return this.ingress.list().map(view=>({...view,registered:true,hookSurface:this.surface(view.agentId),deliverable:this.deliverable(view.agentId)}));}
 enabled(agentId?:string){if(!agentId)return false;try{return this.ingress.status(agentId).enabled;}catch{return false;}}
 /**
  * Enabled describes worker-side intent; deliverable additionally requires a socket this
  * process actually bound. Watches back off only for a channel that can really deliver.
  */
 deliverable(agentId?:string){return this.socketState.listening&&this.enabled(agentId);}
}
