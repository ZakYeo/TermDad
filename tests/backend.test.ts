import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execute,keys,sendKeys,splitCommand,WezTermBackend } from '../src/backend.js';
import { adapters } from '../src/adapters.js';

test('subprocess decoding preserves prompt markers split across UTF-8 chunks',async()=>{
 const output=await execute(process.execPath,['-e',`
  process.stdout.write(Buffer.from([0xe2]));
  setTimeout(()=>process.stdout.write(Buffer.from([0x80,0xba,0x20])),100);
 `]);
 assert.equal(output,'› ');
 assert.equal(adapters.codex.classify(output),'READY_FOR_PROMPT');
});

test('subprocess error decoding preserves split UTF-8 diagnostics',async()=>{
 await assert.rejects(execute(process.execPath,['-e',`
  process.stderr.write(Buffer.from([0xe2]));
  setTimeout(()=>{process.stderr.write(Buffer.from([0x80,0xba]));process.exitCode=1;},100);
 `]),/failed \(1\): ›$/);
});

test('inherited property names are rejected before any keys are sent',async()=>{
 const inputs:(string|undefined)[]=[];
 const backend=new WezTermBackend(async(_args,input)=>{inputs.push(input);return '';});
 for(const key of ['toString','constructor','__proto__'])await assert.rejects(sendKeys(backend,7,['ENTER',key]),/Unsupported key/);
 assert.deepEqual(inputs,[]);
});

test('named keys accept case variants and navigation aliases through raw stdin',async()=>{
 const calls:{args:string[];input?:string}[]=[];
 const backend=new WezTermBackend(async(args,input)=>{calls.push({args,input});return '';});
 const aliases:Record<string,string>={Down:'\x1b[B',down:'\x1b[B',DownArrow:'\x1b[B',ArrowDown:'\x1b[B',Escape:'\x1b',Tab:'\t',Return:'\r',ArrowUp:'\x1b[A',UpArrow:'\x1b[A',ArrowLeft:'\x1b[D',LeftArrow:'\x1b[D',ArrowRight:'\x1b[C',RightArrow:'\x1b[C'};
 const cases=[...Object.entries(keys),...Object.entries(keys).map(([key,value])=>[key.toLowerCase(),value]),...Object.entries(aliases)];
 await sendKeys(backend,7,cases.map(([key])=>key));
 assert.deepEqual(calls,cases.map(([,input])=>({args:['send-text','--pane-id','7','--no-paste'],input})));
 calls.length=0;
 await assert.rejects(sendKeys(backend,7,['ArrowDown','Bogus']),/Unsupported key: Bogus.*DOWN.*ESCAPE/);
 assert.deepEqual(calls,[]);
});

test('subprocess output limit counts UTF-8 bytes rather than characters',async()=>{
 await assert.rejects(execute(process.execPath,['-e',`process.stdout.write('€'.repeat(3_000_000));`]),/output exceeded 8 MiB/);
});

test('timeout terminates a subprocess that ignores SIGTERM',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'term-dad-timeout-')),pidFile=join(directory,'pid');
 let pid:number|undefined;
 try{
  await assert.rejects(execute(process.execPath,['-e',`
   process.on('SIGTERM',()=>{});
   require('node:fs').writeFileSync(process.argv[1],String(process.pid));
   setTimeout(()=>process.exit(0),5000);
  `,pidFile],undefined,1000),/timed out/);
  pid=Number(await readFile(pidFile,'utf8'));
  let alive=true;
  for(let attempt=0;attempt<50;attempt++){
   try{process.kill(pid,0);}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;alive=false;break;}
   await new Promise(r=>setTimeout(r,10));
  }
  assert.equal(alive,false,'Timed-out child must not survive an ignored SIGTERM');
 }finally{
  if(pid!==undefined){try{process.kill(pid,'SIGKILL');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}}
  await rm(directory,{recursive:true,force:true});
 }
});
test('send_text issues exactly one bracketed paste carrying the text on stdin',async()=>{
 const calls:{args:string[];input?:string}[]=[];
 const backend=new WezTermBackend(async(args,input)=>{calls.push({args,input});return '';});
 await backend.sendText(7,'marker-once');
 assert.equal(calls.length,1);
 assert.deepEqual(calls[0].args,['send-text','--pane-id','7']);
 assert.equal(calls[0].input,'marker-once');
});
test('splitCommand honours quotes and backslashes and rejects an empty command',()=>{
 assert.deepEqual(splitCommand(`git commit -m "a b" 'c d' e\\ f`),['git','commit','-m','a b','c d','e f']);
 assert.deepEqual(splitCommand(['already','argv']),['already','argv']);
 assert.throws(()=>splitCommand('  '),/command/);
 assert.throws(()=>splitCommand('"unterminated'),/quote/);
});
