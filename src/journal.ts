import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
export const stateDirectory=()=>process.env.TERM_DAD_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(),'.local','state'),'term-dad');
const code=(e:unknown)=>e instanceof Error && 'code' in e ? e.code : undefined;
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
   try{lease=await open(lock,'wx',0o600);}catch(e){
    if(code(e)!=='EEXIST')throw new Error(`${this.prefix}_STORAGE_UNAVAILABLE: cannot acquire journal lock`);
    if(attempt>=10)throw new Error(`${this.prefix}_STORAGE_BUSY: transaction lock exists; retry. After a crash, verify no server uses this state directory before removing ${this.name}.lock`);
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

