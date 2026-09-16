import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsInstance } from '../src/terminal-instance.js';
import type { execute } from '../src/backend.js';
const binary='/mnt/c/Program Files/WezTerm/wezterm.exe';
test('Windows resolver pins discovered endpoint and refuses a reused PID with another start identity',async()=>{
 const old=process.env.WEZTERM_UNIX_SOCKET;delete process.env.WEZTERM_UNIX_SOCKET;
 try{
  let key='host:12:start-a';const requests:any[]=[];
  const run:typeof execute=async(file,args,input)=>{
   if(file==='wslpath')return 'C:\\converted\\'+args[1].split('/').pop();
   assert.ok(args.includes('-File'));assert.ok(!args.join(' ').includes('gui-sock'));
   requests.push(JSON.parse(input!));return JSON.stringify({endpoint:'C:\\gui-sock-12',key});
  };
  const identity=windowsInstance(binary,run);assert.equal((await identity())?.key,key);await identity();
  assert.equal(requests[0].endpoint,undefined);assert.equal(requests[1].endpoint,'C:\\gui-sock-12');
  key='host:12:start-b';await assert.rejects(identity(),/identity changed/);
 }finally{if(old===undefined)delete process.env.WEZTERM_UNIX_SOCKET;else process.env.WEZTERM_UNIX_SOCKET=old;}
});
test('Windows resolver passes configured socket literally via stdin and propagates unavailable identity',async()=>{
 const old=process.env.WEZTERM_UNIX_SOCKET;process.env.WEZTERM_UNIX_SOCKET='C:\\a $(literal)\\gui-sock-42';
 try{
  const requests:any[]=[];const run:typeof execute=async(file,_args,input)=>{if(file==='wslpath')return 'C:\\test';requests.push(JSON.parse(input!));throw new Error('identity unavailable');};
  await assert.rejects(windowsInstance(binary,run)(),/identity unavailable/);assert.equal(requests[0].endpoint,process.env.WEZTERM_UNIX_SOCKET);
 }finally{if(old===undefined)delete process.env.WEZTERM_UNIX_SOCKET;else process.env.WEZTERM_UNIX_SOCKET=old;}
});
test('unavailable native identity support returns null without invoking a helper',async()=>{
 if(process.platform==='win32')return;
 const identity=windowsInstance('/usr/bin/wezterm',async()=>{throw new Error('must not run');});assert.equal(await identity(),null);
});
