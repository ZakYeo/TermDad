import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { stateDirectory } from './journal.js';
import { eventFilterSchema,eventStateSchema,matches,type EventFilter,type QueueEvent } from './events.js';

export interface WaitArgs {filter:EventFilter;fresh:boolean;timeoutSeconds:number;pollMs:number;stateDir:string;}
export interface WaitDeps {now?:()=>number;sleep?:(ms:number)=>Promise<void>;}
const invalid=(detail:string)=>new Error(`WAIT_ARGS_INVALID: ${detail}`);
const flags=['--kinds','--agents','--panes','--watches','--after-sequence','--max-age-seconds','--timeout-seconds','--poll-ms','--state-dir'] as const;
const list=(value:string)=>value.split(',').map(part=>part.trim()).filter(part=>part.length>0);
function number(name:string,value:string,min:number,max:number){
 const parsed=Number(value);
 if(!Number.isInteger(parsed)||parsed<min||parsed>max)throw invalid(`${name} must be an integer between ${min} and ${max}`);
 return parsed;
}

/** Pure argument parsing, so an unusable invocation fails before any filesystem access. */
export function parseWaitArgs(argv:string[]):WaitArgs {
 const raw=new Map<string,string>();
 for(let i=0;i<argv.length;i+=2){
  const flag=argv[i];
  if(!(flags as readonly string[]).includes(flag))throw invalid(`unknown option ${flag}; expected one of ${flags.join(', ')}`);
  if(argv[i+1]===undefined)throw invalid(`${flag} needs a value`);
  raw.set(flag,argv[i+1]);
 }
 const panes=raw.get('--panes')===undefined?undefined:list(raw.get('--panes')!).map(v=>number('--panes',v,0,Number.MAX_SAFE_INTEGER));
 const after=raw.get('--after-sequence')===undefined?undefined:number('--after-sequence',raw.get('--after-sequence')!,0,Number.MAX_SAFE_INTEGER);
 const age=raw.get('--max-age-seconds')===undefined?undefined:number('--max-age-seconds',raw.get('--max-age-seconds')!,1,604800);
 const candidate={
  ...(raw.get('--kinds')!==undefined?{kinds:list(raw.get('--kinds')!)}:{}),
  ...(raw.get('--agents')!==undefined?{agentIds:list(raw.get('--agents')!)}:{}),
  ...(raw.get('--watches')!==undefined?{watchIds:list(raw.get('--watches')!)}:{}),
  ...(panes!==undefined?{paneIds:panes}:{}),
  ...(after!==undefined?{afterSequence:after}:{}),
  ...(age!==undefined?{maxAgeMs:age*1000}:{}),
 };
 const parsed=eventFilterSchema.safeParse(candidate);
 if(!parsed.success)throw invalid('filters must be bounded journal metadata values');
 return {
  filter:parsed.data,
  // An explicit sequence is the deliberate history drain; otherwise never fire on a backlog.
  fresh:after===undefined,
  timeoutSeconds:raw.get('--timeout-seconds')===undefined?1800:number('--timeout-seconds',raw.get('--timeout-seconds')!,1,86400),
  pollMs:raw.get('--poll-ms')===undefined?2000:number('--poll-ms',raw.get('--poll-ms')!,250,60000),
  stateDir:raw.get('--state-dir')??stateDirectory(),
 };
}

/**
 * Reads the journal directly and without its lock. Sound because a mutation commits by
 * renaming a complete file, so an unlocked reader sees either the whole old version or the
 * whole new one. Deliberate: this process is detached and killable, and `FileJournal` has no
 * stale-lock recovery, so holding `events.lock` here could wedge the server's publish path.
 */
async function read(path:string){
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const stat=await file.stat();
  if(!stat.isFile()||stat.size>4_000_000)throw new Error('journal is not a bounded regular file');
  if((stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid()))throw new Error('journal must be owner-only; check the state directory mode (chmod 700) and re-run');
  return eventStateSchema.parse(JSON.parse(await file.readFile('utf8')));
 }finally{await file.close();}
}

/** Never prints; the caller owns stdout so the JSON line stays the only thing on it. */
export async function waitForEvent(args:WaitArgs,deps:WaitDeps={}):Promise<{code:number;output:string}>{
 // Not unref'ed: waiting is this process's entire purpose, unlike the server's background timers.
 const now=deps.now??Date.now,sleep=deps.sleep??((ms:number)=>new Promise<void>(resolve=>{setTimeout(resolve,ms);}));
 const path=join(args.stateDir,'events.json'),deadline=now()+args.timeoutSeconds*1000;
 let filter=args.filter,armed=!args.fresh,failure:string|undefined;
 do {
  let state;
  try{state=await read(path);failure=undefined;}
  catch(e){
   // A missing journal is simply nothing yet; anything else may be a mid-rename read, so retry.
   failure=(e as {code?:string}).code==='ENOENT'?undefined:`EVENT_STATE_UNREADABLE: ${e instanceof Error?e.message:String(e)}`;
  }
  // An absent journal arms at zero: nothing has been published, so everything later is fresh.
  // Arming only on a successful read would silently exclude the very first event.
  if(!state&&!failure&&!armed){filter={...filter,afterSequence:0};armed=true;}
  if(state){
   if(!armed){filter={...filter,afterSequence:state.nextSequence-1};armed=true;}
   const found=state.events.find((e:QueueEvent)=>e.acknowledgedAt===null&&matches(e,filter,now()));
   if(found)return {code:0,output:JSON.stringify({status:'event',event:found})};
  }
  if(now()>=deadline)break;
  await sleep(args.pollMs);
 } while(now()<deadline);
 if(failure)return {code:4,output:''};
 return {code:0,output:'{"status":"timeout"}'};
}

/** Writes exactly one JSON line to stdout; every diagnostic goes to stderr. */
export async function runWaitForEvent(argv:string[]):Promise<number>{
 let args;
 try{args=parseWaitArgs(argv);}
 catch(e){console.error(e instanceof Error?e.message:String(e));return 2;}
 const {code,output}=await waitForEvent(args);
 if(output)process.stdout.write(output+'\n');
 else console.error('EVENT_STATE_UNREADABLE: preserve events.json and recover it explicitly');
 return code;
}
