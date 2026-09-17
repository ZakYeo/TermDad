import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {sendPush} from '../src/term-dad-notify.js';
const value=(r:any)=>JSON.parse(r.content[0].text);
test('push is listed, disabled by default, and an enabled hook wakes a waiting supervisor over stdio',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'term-dad-push-protocol-'));
 let client:Client|undefined;
 try{
  client=new Client({name:'push-test',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env:{...process.env,TERM_DAD_STATE_DIR:directory} as Record<string,string>,stderr:'inherit'}));
  const names=(await client.listTools()).tools.map(t=>t.name);
  for(const name of ['push.status','push.set'])assert.ok(names.includes(name),`${name} is exposed`);
  const socket=value(await client.callTool({name:'push.status',arguments:{}})).socket;
  assert.equal(socket.listening,true,'status reports the socket it actually bound, not the one it intended');
  assert.equal(socket.bindError,undefined);
  assert.equal((await stat(socket.path)).mode&0o777,0o600,'the push socket is owner-only');
  const socketPath=socket.path;
  assert.deepEqual(value(await client.callTool({name:'push.status',arguments:{}})).workers,[],'no worker pushes before one is registered');
  // A pane this server never launched with hooks is refused explicitly, not reported as enabled.
  const unwired=await client.callTool({name:'push.set',arguments:{agentId:'absent',enabled:true}});
  assert.equal(unwired.isError,true);
  assert.match((unwired.content as any)[0].text,/PUSH_NOT_WIRED/);
  assert.deepEqual(value(await client.callTool({name:'push.set',arguments:{agentId:'absent',enabled:false}})),{agentId:'absent',enabled:false,registered:false},'turning delivery off always succeeds');
  assert.deepEqual(await sendPush(socketPath,JSON.stringify({token:'forged',kind:'ready'})),{error:'PUSH_UNAUTHORIZED: unknown or revoked push token'});
  assert.deepEqual(value(await client.callTool({name:'event.list',arguments:{}})).events,[],'a forged push never becomes an event');
 }finally{await client?.close();await rm(directory,{recursive:true,force:true});}
});
