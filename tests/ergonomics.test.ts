import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { WezTermBackend } from '../src/backend.js';
import { MemoryWorkerStorage } from '../src/worker-storage.js';
import { MemoryTaskStorage } from '../src/task-storage.js';

async function fixture(t:any){
 const calls:{args:string[];input?:string}[]=[];
 const backend=new WezTermBackend(async(args,input)=>{
  calls.push({args,input});
  if(args[0]==='list')return JSON.stringify([{pane_id:7,tab_id:1,window_id:1,title:'shell',cwd:'/',size:{rows:24,cols:80}}]);
  if(args[0]==='spawn')return '9';
  if(args[0]==='get-text')return '$ ';
  return '';
 },async()=>null);
 const app=createServer(backend,undefined,{automatic:false},undefined,new MemoryWorkerStorage(),new MemoryTaskStorage());
 const [a,b]=InMemoryTransport.createLinkedPair(),client=new Client({name:'ergonomics',version:'1'});
 await app.server.connect(a);await client.connect(b);
 t.after(async()=>{await client.close();await app.dispose();});
 const raw=(name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:args});
 const call=async(name:string,args:Record<string,unknown>={})=>{const r=await raw(name,args);assert.notEqual(r.isError,true,JSON.stringify(r));return JSON.parse((r.content as {text:string}[])[0].text);};
 const fails=async(name:string,args:Record<string,unknown>,pattern:RegExp)=>{const r=await raw(name,args);assert.equal(r.isError,true,`${name} accepted ${JSON.stringify(args)}`);assert.match((r.content as {text:string}[])[0].text,pattern);};
 const sent=()=>calls.filter(c=>c.args[0]==='send-text');
 return {calls,call,fails,sent};
}

test('terminal.close and terminal.focus accept paneId as well as target plus id',async t=>{
 const f=await fixture(t);
 assert.deepEqual(await f.call('terminal.close',{paneId:7}),{closed:[7]});
 assert.ok(f.calls.some(c=>c.args[0]==='kill-pane'&&c.args.includes('7')));
 await f.call('terminal.focus',{paneId:7});
 assert.ok(f.calls.some(c=>c.args[0]==='activate-pane'));
 await f.fails('terminal.close',{},/id/);
 await f.fails('terminal.close',{id:7,paneId:8},/ARGUMENT_CONFLICT/);
});
test('agent.send and agent.broadcast accept message as an alias of text',async t=>{
 const f=await fixture(t);
 const {agentId}=await f.call('agent.adopt',{name:'w',cli:'shell',paneId:7});
 const result=await f.call('agent.send',{agentId,message:'hello'});
 assert.equal(result.sent,true);
 assert.equal(f.sent()[0].input,'hello');
 await f.fails('agent.send',{agentId},/text/);
 const outcomes=await f.call('agent.broadcast',{agentIds:[agentId],message:'again'});
 assert.equal(outcomes[0].sent,true);
});
test('terminal.submit without text presses Enter only',async t=>{
 const f=await fixture(t);
 await f.call('terminal.submit',{paneId:7});
 const sent=f.sent();
 assert.equal(sent.length,1,'nothing is pasted before the Enter');
 assert.equal(sent[0].input,'\r');
 assert.ok(sent[0].args.includes('--no-paste'));
});
test('spawn tools accept a command string and split it into argv without a shell',async t=>{
 const f=await fixture(t);
 assert.equal(await f.call('terminal.spawn',{command:'zsh -l -c "echo hi there"'}),9);
 const spawn=f.calls.find(c=>c.args[0]==='spawn')!;
 assert.deepEqual(spawn.args.slice(spawn.args.indexOf('--')+1),['zsh','-l','-c','echo hi there']);
 await f.fails('terminal.spawn',{command:'"unterminated'},/quote/);
 await f.fails('terminal.spawn',{command:'   '},/command/);
});
test('event.acknowledge accepts eventIds as an alias of ids',async t=>{
 const f=await fixture(t);
 const id=randomUUID();
 assert.deepEqual((await f.call('event.acknowledge',{eventIds:[id]})).unknownIds,[id]);
 await f.fails('event.acknowledge',{},/ids/);
});
test('terminal.send_key accepts everyday key spellings',async t=>{
 const f=await fixture(t);
 for(const [key,bytes] of [['Ctrl+C','\x03'],['ctrl-c','\x03'],['Page Down','\x1b[6~'],['PgUp','\x1b[5~'],['Space',' '],['Enter','\r'],['Escape','\x1b'],['Tab','\t'],['Down','\x1b[B']] as const){
  await f.call('terminal.send_key',{paneId:7,key});
  assert.equal(f.sent().at(-1)!.input,bytes,key);
 }
 await f.fails('terminal.send_key',{paneId:7,key:'Bogus'},/Unsupported key/);
});
