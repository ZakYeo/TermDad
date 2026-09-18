import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readdir,rm,access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { EventQueue,FileEventStorage } from '../src/events.js';
const run=(args:string[])=>new Promise<{code:number;stdout:string;stderr:string}>(resolve=>{
 execFile(process.execPath,['dist/index.js',...args],{timeout:30000},(error,stdout,stderr)=>
  resolve({code:(error as {code?:number}|null)?.code??0,stdout,stderr}));
});
test('the wait-for-event subcommand runs to completion without starting an MCP server',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'term-dad-wait-protocol-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const timed=await run(['wait-for-event','--timeout-seconds','1','--poll-ms','250','--state-dir',directory]);
 assert.equal(timed.code,0,'a timeout must not look like a failed background task');
 assert.equal(timed.stdout,'{"status":"timeout"}\n','exactly one JSON line reaches stdout');
 assert.deepEqual(await readdir(directory),[],'the waiter creates no journal, lock or socket');
 // A subcommand must not construct a server: that would bind a second push socket for this pid.
 const sockets=(await readdir(directory)).filter(name=>name.startsWith('push.'));
 assert.deepEqual(sockets,[]);
});
test('a detached waiter exits carrying the event that woke it, and never acknowledges it',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'term-dad-wait-wake-'));
 const queue=new EventQueue(new FileEventStorage(directory),50,64,Date.now,0);
 t.after(async()=>{await queue.close();await rm(directory,{recursive:true,force:true});});
 await queue.publish({kind:'ready',paneId:7,watchId:'w',occurredAt:new Date().toISOString(),summary:'Worker status changed'});
 const waiting=run(['wait-for-event','--kinds','attention_required','--timeout-seconds','20','--poll-ms','250','--state-dir',directory]);
 let published:string|undefined;
 for(let i=0;i<40&&!published;i++){
  await new Promise(r=>setTimeout(r,250));
  published=(await queue.publish({kind:'attention_required',paneId:7,watchId:'w',occurredAt:new Date().toISOString(),summary:'Worker asked for a person'})).id;
 }
 const woken=await waiting;
 assert.equal(woken.code,0);
 const result=JSON.parse(woken.stdout);
 assert.equal(result.status,'event');
 assert.equal(result.event.kind,'attention_required');
 assert.equal((await queue.list({},false,50)).events.filter(e=>e.acknowledgedAt!==null).length,0,'the waiter acknowledged nothing');
});
test('a bad invocation reports usage on stderr and exits 2',async()=>{
 const bad=await run(['wait-for-event','--nonsense']);
 assert.equal(bad.code,2);
 assert.equal(bad.stdout,'','a usage error writes nothing to stdout');
 assert.match(bad.stderr,/WAIT_ARGS_INVALID/);
});
test('the server names its own waiter: the reported command runs, and the example targets the server journal',async t=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {StdioClientTransport}=await import('@modelcontextprotocol/sdk/client/stdio.js');
 const directory=await mkdtemp(join(tmpdir(),'term-dad-wake-command-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const transport=new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env:{...process.env,TERM_DAD_WEZTERM:'/nonexistent/wezterm',TERM_DAD_STATE_DIR:directory} as Record<string,string>,stderr:'inherit'});
 const client=new Client({name:'test',version:'1'});
 await client.connect(transport);
 try{
  const reply=await client.callTool({name:'event.wake_command',arguments:{}});
  assert.notEqual(reply.isError,true,JSON.stringify(reply));
  const wake=JSON.parse((reply.content as {text:string}[])[0].text);
  assert.equal(wake.command[0],process.execPath,'the runtime that serves MCP is the one that runs the waiter');
  assert.match(wake.command[1],/dist\/index\.js$/,'the only entry point is the dispatcher, never wait-cli.js');
  await access(wake.command[1]);
  assert.equal(wake.warning,undefined,'a built server reports a runnable entry point without caveats');
  assert.equal(wake.command[2],'wait-for-event');
  assert.equal(wake.stateDir,directory,'the waiter must read the journal this server writes, not the caller\'s default');
  assert.ok(wake.example.includes('--until-event'),'the canonical command re-arms itself');
  assert.ok(wake.example.includes(`--state-dir ${directory}`));
  assert.ok(wake.example.includes('attention_required'));
  assert.ok(!wake.example.includes('ready,') || wake.example.includes('attention_required'));
  const ran=await new Promise<{code:number;stdout:string}>(resolve=>execFile(wake.command[0],[...wake.command.slice(1),'--timeout-seconds','1','--poll-ms','250','--state-dir',wake.stateDir],{timeout:30000},(error,stdout)=>resolve({code:(error as {code?:number}|null)?.code??0,stdout})));
  assert.equal(ran.code,0);
  assert.equal(ran.stdout,'{"status":"timeout"}\n','the reported command is runnable as given');
 }finally{await client.close();}
});
