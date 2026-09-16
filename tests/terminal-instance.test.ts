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
test('GUI discovery is read-only and explicit selection replaces the pinned endpoint',async()=>{
 const requests:any[]=[];
 const a={endpoint:'C:\\gui-sock-12',key:'host:12:a',pid:12,title:'first'};
 const b={endpoint:'C:\\gui-sock-23',key:'host:23:b',pid:23,title:'second'};
 const run:typeof execute=async(file,_args,input)=>{
  if(file==='wslpath')return 'C:\\test';
  const request=JSON.parse(input!);requests.push(request);
  if(request.action==='list')return JSON.stringify([a,b]);
  const gui=request.action==='select'?b:request.endpoint===b.endpoint?b:a;
  return JSON.stringify({endpoint:gui.endpoint,key:gui.key});
 };
 const identity=windowsInstance(binary,run);
 assert.equal((await identity())?.key,a.key);
 assert.deepEqual(await identity.list(),[a,b]);
 assert.equal((await identity())?.key,a.key);
 assert.deepEqual(await identity.select(b.key),{endpoint:b.endpoint,key:b.key});
 assert.equal((await identity())?.key,b.key);
 assert.equal(requests.at(-1).endpoint,b.endpoint);
 assert.equal(requests.find(r=>r.action==='select').key,b.key);
});
test('failed or mismatched selection preserves the previous identity and endpoint',async()=>{
 let failure:'throw'|'mismatch'='throw';const requests:any[]=[];
 const run:typeof execute=async(file,_args,input)=>{
  if(file==='wslpath')return 'C:\\test';
  const request=JSON.parse(input!);requests.push(request);
  if(request.action==='select'){
   if(failure==='throw')throw new Error('GUI exited');
   return JSON.stringify({endpoint:'C:\\gui-sock-23',key:'replacement'});
  }
  return JSON.stringify({endpoint:'C:\\gui-sock-12',key:'original'});
 };
 const identity=windowsInstance(binary,run);await identity();
 await assert.rejects(identity.select('target'),/GUI exited/);
 failure='mismatch';await assert.rejects(identity.select('target'),/no longer matches/);
 assert.equal((await identity())?.key,'original');
 assert.equal(requests.at(-1).endpoint,'C:\\gui-sock-12');
});
test('concurrent initial reads coalesce and cannot overwrite a selection',async()=>{
 let release!:()=>void;let started!:()=>void;
 const pending=new Promise<void>(resolve=>{release=resolve;});
 const entered=new Promise<void>(resolve=>{started=resolve;});
 let reads=0;
 const run:typeof execute=async(file,_args,input)=>{
  if(file==='wslpath')return 'C:\\test';
  const request=JSON.parse(input!);
  if(request.action==='resolve'){reads++;started();await pending;}
  return JSON.stringify({endpoint:'C:\\gui-sock-12',key:request.action==='select'?request.key:'initial'});
 };
 const identity=windowsInstance(binary,run);
 const first=identity(),second=identity();await entered;
 await assert.rejects(identity.select('other'),/TERMINAL_BUSY/);
 release();await Promise.all([first,second]);assert.equal(reads,1);
 assert.equal((await identity.select('other')).key,'other');
});
test('selection excludes identity reads and other selections until validated',async()=>{
 let release!:()=>void;let started!:()=>void;
 const pending=new Promise<void>(resolve=>{release=resolve;});
 const entered=new Promise<void>(resolve=>{started=resolve;});
 const run:typeof execute=async(file,_args,input)=>{
  if(file==='wslpath')return 'C:\\test';
  const request=JSON.parse(input!);started();await pending;
  return JSON.stringify({endpoint:'C:\\gui-sock-12',key:request.key});
 };
 const identity=windowsInstance(binary,run);const selection=identity.select('chosen');await entered;
 await assert.rejects(identity(),/TERMINAL_BUSY/);
 await assert.rejects(identity.select('other'),/TERMINAL_BUSY/);
 release();assert.equal((await selection).key,'chosen');
});
test('GUI lists validate identities and enforce the discovery bound',async()=>{
 let result:unknown=Array.from({length:65},(_,i)=>({endpoint:`socket-${i}`,key:`key-${i}`,pid:i+1,title:''}));
 const run:typeof execute=async(file)=>file==='wslpath'?'C:\\test':JSON.stringify(result);
 const identity=windowsInstance(binary,run);await assert.rejects(identity.list());
 result=[{endpoint:'socket',key:'key',pid:0,title:''}];await assert.rejects(identity.list());
 result=[];assert.deepEqual(await identity.list(),[]);
});
test('native GUI discovery and selection explain explicit configuration fallback',async()=>{
 if(process.platform==='win32')return;
 const identity=windowsInstance('/usr/bin/wezterm',async()=>{throw new Error('must not run');});
 await assert.rejects(identity.list(),/unsupported.*WEZTERM_UNIX_SOCKET/);
 await assert.rejects(identity.select('key'),/unsupported.*WEZTERM_UNIX_SOCKET/);
});
