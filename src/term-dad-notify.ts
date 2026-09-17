#!/usr/bin/env node
import { connect } from 'node:net';
import { pushKinds,type PushKind } from './ingress.js';

// Codex reports its own lifecycle; only the kinds Term Dad models are forwarded.
const codexKinds:Record<string,PushKind>={'agent-turn-complete':'ready','agent-approval-request':'input_required','session-end':'session_ended'};
const flag=(argv:string[],name:string)=>{const index=argv.indexOf(name);return index>=0?argv[index+1]:undefined;};

/** Builds the single request line for one hook invocation, or nothing when the event is not modelled. */
export function notifyRequest(argv:string[],stdin:string){
 const socketPath=flag(argv,'--socket'),token=flag(argv,'--token');
 if(!socketPath)throw new Error('term-dad-notify: --socket <path> is required');
 if(!token)throw new Error('term-dad-notify: --token <value> is required');
 let kind=flag(argv,'--kind') as PushKind|undefined;
 if(argv.includes('--codex')){
  const payload=argv.at(-1);
  let type:unknown;
  for(const candidate of [payload,stdin]){try{type=JSON.parse(candidate??'')?.type;}catch{}if(type)break;}
  kind=codexKinds[String(type)];
  if(!kind)return undefined;
 }
 if(!kind||!pushKinds.includes(kind))throw new Error(`term-dad-notify: --kind must be one of ${pushKinds.join(', ')}`);
 return {socketPath,line:JSON.stringify({token,kind})};
}

/** One request, one reply, bounded: a hook must never block the worker it runs in. */
export function sendPush(socketPath:string,line:string,timeoutMs=5000){
 return new Promise<unknown>((resolve,reject)=>{
  const client=connect(socketPath);
  let reply='';
  const fail=(e:unknown)=>{client.destroy();reject(e instanceof Error?e:new Error(String(e)));};
  client.setTimeout(timeoutMs,()=>fail(new Error('term-dad-notify: timed out')));
  client.setEncoding('utf8');
  client.on('error',fail);
  client.on('data',chunk=>{reply+=chunk;});
  client.on('close',()=>{try{resolve(JSON.parse(reply.trim()||'{}'));}catch{reject(new Error('term-dad-notify: unreadable reply'));}});
  client.end(line+'\n');
 });
}

if(process.argv[1]&&import.meta.url===new URL(`file://${process.argv[1]}`).href){
 const stdin=process.stdin.isTTY?'':await new Promise<string>(resolve=>{let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{text+=c;});process.stdin.on('end',()=>resolve(text));setTimeout(()=>resolve(text),1000).unref();});
 try{
  const request=notifyRequest(process.argv.slice(2),stdin);
  // Hooks run inside the worker: an unmodelled event or an absent server must stay silent and non-fatal.
  if(request)await sendPush(request.socketPath,request.line);
 }catch(e){console.error(e instanceof Error?e.message:String(e));}
 process.exit(0);
}
