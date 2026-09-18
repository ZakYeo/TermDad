import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const stateDirectory=()=>process.env.TERM_DAD_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(),'.local','state'),'term-dad');
const code=(e:unknown)=>e instanceof Error && 'code' in e ? e.code : undefined;
/** How long a freshly created lock may sit without its holder pid before it counts as abandoned by a pre-pid build. */
const PIDLESS_LOCK_GRACE_MS=5000;
const ORPHAN_TEMPORARY_AGE_MS=60000;
const lockName=/\.lock$/,temporaryName=/\.[0-9a-f-]{36}\.tmp$/;
function alive(pid:number){try{process.kill(pid,0);return true;}catch(e){return code(e)!=='ESRCH';}}
/**
 * A lock is stale when the process that wrote its pid is gone. That is recovery from a dead
 * holder, not stealing on a timer: a slow live writer still keeps its lock for as long as it
 * lives. A lock with no pid can only come from the open-then-write window or an older build,
 * so it is stale only once older than that window.
 */
export async function lockIsStale(path:string){
 try{
  const [contents,info]=await Promise.all([readFile(path,'utf8'),stat(path)]);
  const pid=Number(contents.trim());
  if(contents.trim()&&Number.isInteger(pid)&&pid>0)return !alive(pid);
  return Date.now()-info.mtimeMs>PIDLESS_LOCK_GRACE_MS;
 }catch(e){return code(e)==='ENOENT';}
}
/** Creates the lock atomically and records the holder; reclaims a stale one and retries once. */
export async function acquireLock(path:string){
 for(let reclaimed=false;;reclaimed=true){
  try{const lease=await open(path,'wx',0o600);try{await lease.writeFile(String(process.pid));}catch{}return lease;}
  catch(e){
   if(code(e)!=='EEXIST'||reclaimed||!await lockIsStale(path))throw e;
   await unlink(path).catch(()=>{});
  }
 }
}
/** Startup sweep of locks whose holder is dead and of orphan temporaries; returns what it removed. */
export async function reapStaleLocks(directory:string){
 const removed:string[]=[];
 for(const name of await readdir(directory).catch(()=>[] as string[])){
  const path=join(directory,name);
  let stale=false;
  if(lockName.test(name))stale=await lockIsStale(path);
  else if(temporaryName.test(name))stale=await stat(path).then(s=>Date.now()-s.mtimeMs>ORPHAN_TEMPORARY_AGE_MS).catch(()=>false);
  if(stale){try{await unlink(path);removed.push(name);}catch{}}
 }
 return removed;
}
/** One atomic transaction at a time, including across local server processes. */
export class FileJournal<S> {
 readonly directory:string;
 warning:string|undefined;
 constructor(readonly name:string,readonly prefix:string,readonly empty:()=>S,readonly validate:(value:unknown)=>S,directory=stateDirectory()){this.directory=directory;}
 protected async syncDirectory(){const dir=await open(this.directory,'r');try{await dir.sync();}finally{await dir.close();}}
 async transaction<T>(write:boolean,fn:(state:S)=>{state?:S;result:T}):Promise<T>{
  const path=join(this.directory,`${this.name}.json`),lock=join(this.directory,`${this.name}.lock`);
  if(write)await mkdir(this.directory,{recursive:true,mode:0o700});
  try{const dir=await lstat(this.directory);if(!dir.isDirectory()||(dir.mode&0o077)!==0||(process.getuid&&dir.uid!==process.getuid()))throw new Error(`${this.prefix}_STORAGE_UNSAFE: state directory must be owned by the current user with mode 0700`);}
  catch(e){if(code(e)==='ENOENT'&&!write)return fn(this.empty()).result;throw e;}
  let lease;
  for(let attempt=0;!lease;attempt++){
   try{lease=await acquireLock(lock);}catch(e){
    if(code(e)!=='EEXIST')throw new Error(`${this.prefix}_STORAGE_UNAVAILABLE: cannot acquire journal lock`);
    if(attempt>=10)throw new Error(`${this.prefix}_STORAGE_BUSY: transaction lock ${this.name}.lock is held by a live process; retry. A lock whose holder has exited is reclaimed automatically`);
    await new Promise(resolve=>setTimeout(resolve,20));
   }
  }
  let temporary:string|undefined,committed=false;
  try{
   let state=this.empty();
   try{const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await file.stat();if(!stat.isFile()||stat.size>4_000_000||(stat.mode&0o077)!==0||(process.getuid&&stat.uid!==process.getuid()))throw new Error('invalid size');state=this.validate(JSON.parse(await file.readFile('utf8')));}finally{await file.close();}}
   catch(e){if(code(e)!=='ENOENT')throw new Error(`${this.prefix}_STATE_CORRUPT: journal unreadable or invalid; preserve it and recover explicitly`);}
   const outcome=fn(state);
   if(outcome.state){
    this.validate(outcome.state);
    const serialized=JSON.stringify(outcome.state);
    if(Buffer.byteLength(serialized)>4_000_000)throw new Error(`${this.prefix}_STORAGE_SIZE_LIMIT: journal exceeds its byte limit; no records were discarded`);
    temporary=join(this.directory,`${this.name}.${randomUUID()}.tmp`);
    const file=await open(temporary,'wx',0o600);
    try{await file.writeFile(serialized);await file.sync();}finally{await file.close();}
    await rename(temporary,path);temporary=undefined;committed=true;
    try{await this.syncDirectory();}catch{this.warning=`${this.prefix}_DURABILITY_WARNING: journal committed but directory sync failed; power-loss durability is uncertain`;}
   }
   return outcome.result;
  }finally{if(temporary)await unlink(temporary).catch(()=>{});try{await lease.close();await unlink(lock);}catch{this.warning=`${this.prefix}_LOCK_CLEANUP_WARNING: verify exclusive access before removing ${this.name}.lock`;if(!committed)throw new Error(this.warning);}}
 }
}

