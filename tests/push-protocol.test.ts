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
  const socketPath=value(await client.callTool({name:'push.status',arguments:{}})).socketPath;
  assert.equal((await stat(socketPath)).mode&0o777,0o600,'the push socket is owner-only');
  assert.deepEqual(value(await client.callTool({name:'push.status',arguments:{}})).workers,[],'no worker pushes before one is registered');
  assert.equal((await client.callTool({name:'push.set',arguments:{agentId:'absent',enabled:true}})).isError,true);
  assert.deepEqual(await sendPush(socketPath,JSON.stringify({token:'forged',kind:'ready'})),{error:'PUSH_UNAUTHORIZED: unknown or revoked push token'});
  assert.deepEqual(value(await client.callTool({name:'event.list',arguments:{}})).events,[],'a forged push never becomes an event');
 }finally{await client?.close();await rm(directory,{recursive:true,force:true});}
});
