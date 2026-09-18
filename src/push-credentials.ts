import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CodedError,hasCode } from './errors.js';

/**
 * A worker's hook argv carries this file's path, never the credentials themselves, because a
 * running process's argv cannot be rewritten. A supervisor restart replaces the file, so a
 * surviving worker keeps reporting with no relaunch and no lost context.
 *
 * This is not a security boundary. Every worker runs as the same user as the server, so 0600
 * does not stop one worker reading another's file any more than it stopped it reading another's
 * `/proc/<pid>/cmdline`. The properties that do hold are unchanged: the ingress socket is local
 * and owner-only, only a token and kind are trusted, and summaries are authored by the server.
 */
export const credentialSchema=z.object({version:z.literal(1),agentId:z.uuid(),socketPath:z.string().min(1).max(4096),token:z.string().min(1).max(200)}).strict();
export type PushCredential=z.infer<typeof credentialSchema>;
export const credentialDirectory=(state:string)=>join(state,'push-credentials');
export const credentialPath=(state:string,agentId:string)=>join(credentialDirectory(state),`${agentId}.json`);
const named=/^[0-9a-f-]{36}\.json$/;
const code=(e:unknown)=>e instanceof Error&&'code' in e?e.code:undefined;

/** Read by the worker's own hook, and never by the server: see `PushCredentialStore`. */
export async function readCredential(path:string):Promise<PushCredential>{
 try{
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const info=await file.stat();
   if(!info.isFile()||info.size>4096)throw new Error('not a bounded regular file');
   if((info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid()))throw new Error('must be owner-only');
   return credentialSchema.parse(JSON.parse(await file.readFile('utf8')));
  }finally{await file.close();}
 }catch{throw new Error(`PUSH_CREDENTIAL_UNREADABLE: ${path} is missing or not a private valid credential; re-enable push for this worker`);}
}

/**
 * Deliberately write-only: exposing no read method is how "a credential is never loaded into
 * server or event state" is guaranteed by construction rather than by review. Not a
 * `FileJournal` — this is per-worker, tiny, needs no cross-process lock, and must never be
 * validated into a journal — but it borrows the same atomic rename and ownership discipline.
 */
export class PushCredentialStore {
 readonly directory:string;
 constructor(private state:string){this.directory=credentialDirectory(state);}
 private async prepare(){
  await mkdir(this.directory,{recursive:true,mode:0o700});
  const info=await lstat(this.directory);
  if(!info.isDirectory()||(info.mode&0o077)!==0||(process.getuid&&info.uid!==process.getuid()))throw new Error(`${this.directory} must be a directory owned by the current user with mode 0700`);
 }
 async write(credential:PushCredential):Promise<string>{
  const value=credentialSchema.parse(credential),path=credentialPath(this.state,value.agentId);
  let temporary:string|undefined;
  try{
   await this.prepare();
   // Refuse anything that is not absent or a regular file, so a symlink cannot redirect the write.
   const existing=await lstat(path).catch(()=>undefined);
   if(existing&&!existing.isFile())throw new CodedError('PUSH_CREDENTIAL_PATH_OCCUPIED',`refusing to replace ${path}, which is not a regular file`);
   temporary=join(this.directory,`${value.agentId}.${randomUUID()}.tmp`);
   const file=await open(temporary,'wx',0o600);
   try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}
   await rename(temporary,path);temporary=undefined;
   return path;
  }catch(e){
   if(hasCode(e,'PUSH_CREDENTIAL_PATH_OCCUPIED'))throw e;
   // The path, never the token: a diagnostic must not leak the credential it failed to write.
   throw new Error(`PUSH_CREDENTIAL_UNWRITABLE: could not write a private credential in ${this.directory} (${code(e)??'unknown error'}); check the state directory then retry push.set`);
  }finally{if(temporary)await unlink(temporary).catch(()=>{});}
 }
 /** Cleanup must never fail an operation that already succeeded. */
 async remove(agentId:string){await unlink(credentialPath(this.state,agentId)).catch(()=>{});}
 /**
  * Membership, not a liveness probe: a credential cannot be probed the way a socket can, and
  * the durable worker journal is shared by state directory, so another server's live worker is
  * never swept. Callers must skip the sweep entirely if that journal could not be read.
  */
 async sweep(live:Set<string>){
  let removed=0;
  for(const name of await readdir(this.directory).catch(()=>[])){
   if(!named.test(name)||live.has(name.slice(0,-5)))continue;
   await unlink(join(this.directory,name)).catch(()=>{});removed++;
  }
  return removed;
 }
}
