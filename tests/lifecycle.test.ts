import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile,readdir,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from '../src/server.js';
import { WezTermBackend } from '../src/backend.js';
import { EventQueue,FileEventStorage } from '../src/events.js';
import { FileWorkerStorage } from '../src/worker-storage.js';
import { FileTaskStorage } from '../src/task-storage.js';
async function deadPid(){const child=spawn(process.execPath,['-e','0']);const pid=child.pid!;await new Promise(r=>child.on('exit',r));return pid;}
const env=(directory:string)=>({...process.env,TERM_DAD_WEZTERM:'/nonexistent/wezterm',TERM_DAD_STATE_DIR:directory});

test('startup reclaims a journal lock left by a dead server so writes work again',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'term-dad-lifecycle-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 await writeFile(join(directory,'workers.lock'),String(await deadPid()),{mode:0o600});
 const wez=new WezTermBackend(async args=>args[0]==='list'?'[]':'' ,async()=>null);
 const events=new EventQueue(new FileEventStorage(directory),50,64,Date.now,0);
 process.env.TERM_DAD_STATE_DIR=directory;
 const term=createServer(wez,undefined,{automatic:false},events,new FileWorkerStorage(directory),new FileTaskStorage(directory));
 t.after(async()=>{await term.pushSocket.close();await term.watches.dispose();await term.agents.close();await events.close();});
 await term.pushReady;await term.pushRestored;
 assert.deepEqual(await term.reaped,['workers.lock']);
 assert.ok(!(await readdir(directory)).includes('workers.lock'));
});

test('the stdio server exits and unlinks its push socket when its client closes stdin',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'term-dad-exit-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const child=spawn(process.execPath,['dist/index.js'],{env:env(directory),stdio:['pipe','pipe','inherit']});
 const exited=new Promise<number|null>(r=>child.on('exit',code=>r(code)));
 // Wait for the socket to appear, which shows startup finished.
 const socket=join(directory,`push.${child.pid}.sock`);
 for(let i=0;i<100&&!(await stat(socket).catch(()=>null));i++)await new Promise(r=>setTimeout(r,50));
 await stat(socket);
 child.stdin.end();
 const timer=setTimeout(()=>child.kill('SIGKILL'),8000);
 const code=await exited;clearTimeout(timer);
 assert.equal(code,0,'the server exits on its own when the client goes away');
 assert.equal(await stat(socket).catch(()=>null),null,'and leaves no socket behind');
});

test('the stdio server exits when its parent process dies even while something else holds its stdin open',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'term-dad-orphan-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 // The shell parent exits at once; `sleep` keeps the server's stdin pipe open, so only the parent check can end it.
 const parent=spawn('/bin/sh',['-c',`sleep 20 | "${process.execPath}" dist/index.js >/dev/null 2>&1 & sleep 1; exit 0`],{env:{...env(directory),TERM_DAD_PARENT_CHECK_MS:'200'}});
 await new Promise(r=>parent.on('exit',r));
 let socket:string|undefined;
 for(let i=0;i<100&&!socket;i++){socket=(await readdir(directory).catch(()=>[] as string[])).find(n=>/^push\.\d+\.sock$/.test(n));if(!socket)await new Promise(r=>setTimeout(r,50));}
 assert.ok(socket,'the server started');
 const pid=Number(socket!.split('.')[1]);
 const alive=()=>{try{process.kill(pid,0);return true;}catch{return false;}};
 for(let i=0;i<50&&alive();i++)await new Promise(r=>setTimeout(r,100));
 const survived=alive();if(survived)process.kill(pid,'SIGKILL');
 assert.equal(survived,false,'server outlived its parent');
});
