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
 constructor(private ingress:PushIngress,private socketPath:string,private notify:string[]){}
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
 setEnabled(agentId:string,enabled:boolean){
  if(this.clis.get(agentId)==='shell')throw new Error('PUSH_UNSUPPORTED_WORKER: shell workers have no hook surface; use a watch instead');
  return this.ingress.setEnabled(agentId,enabled);
 }
 status(agentId:string){return this.ingress.status(agentId);}
 list(){return this.ingress.list();}
 enabled(agentId?:string){if(!agentId)return false;try{return this.ingress.status(agentId).enabled;}catch{return false;}}
}
