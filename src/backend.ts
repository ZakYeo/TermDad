import { spawn as spawnProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { windowsInstance } from './terminal-instance.js';
import type { TerminalInstance } from './worker-storage.js';

export const id = z.number().int().nonnegative().safe();
const string = z.string().min(1).max(8192).refine(s => !s.includes('\0'), 'NUL is not allowed');
export const spawnSchema = z.object({ cwd: string.optional(), command: z.array(string).min(1).max(100).optional(), paneId: id.optional(), windowId: id.optional(), newWindow: z.boolean().optional(), domain: string.optional() });
export type SpawnOptions = z.infer<typeof spawnSchema>;
const paneSchema = z.object({pane_id:id, tab_id:id, window_id:id, title:z.string(), cwd:z.string(), size:z.object({rows:id,cols:id}).passthrough()}).passthrough();
export type Pane = z.infer<typeof paneSchema>;
export function parsePanes(text:string):Pane[] { try { return z.array(paneSchema).parse(JSON.parse(text)); } catch { throw new Error('Invalid WezTerm list JSON: expected panes with IDs, title, cwd and size'); } }
export type Runner = (args:string[], input?:string)=>Promise<string>;
export function execute(file:string,args:string[],input?:string,timeout=15000,env?:NodeJS.ProcessEnv):Promise<string> {
  return new Promise((resolve,reject)=>{
    const p=spawnProcess(file,args,{stdio:['pipe','pipe','pipe'],windowsHide:true,env});
    p.stderr.setEncoding('utf8');
    const decoder=new StringDecoder('utf8');
    let stdout='',stderr='',done=false,stdoutBytes=0;
    const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(stdout);};
    const terminate=(error:Error)=>{if(done)return;p.kill('SIGKILL');p.stdin.destroy();p.stdout.destroy();p.stderr.destroy();finish(error);};
    const timer=setTimeout(()=>terminate(new Error(`${file}: command timed out after ${timeout}ms`)),timeout);
    p.on('error',e=>finish(new Error(`${file}: ${e.message}. Check executable and terminal connectivity.`)));
    p.stdout.on('data',(b:Buffer)=>{if(done)return;stdoutBytes+=b.length;if(stdoutBytes>8*1024*1024){terminate(new Error('Command output exceeded 8 MiB'));return;}stdout+=decoder.write(b);});
    p.stdout.on('end',()=>{if(!done)stdout+=decoder.end();});
    p.stderr.on('data',b=>{if(!done)stderr=(stderr+b).slice(-8192);});
    p.stdin.on('error',()=>{});p.stdin.end(input);
    p.on('close',code=>finish(code===0?undefined:new Error(`${file} ${args[0]} failed (${code}): ${stderr}`)));
  });
}
export interface TerminalBackend {
 instance?():Promise<TerminalInstance|null>;
 list():Promise<Pane[]>; spawn(o:SpawnOptions):Promise<number>; split(o:SpawnOptions & {paneId:number;direction?:'right'|'bottom';percent?:number}):Promise<number>;
 read(paneId:number,lines?:number):Promise<string>; sendText(paneId:number,text:string,raw?:boolean):Promise<void>;
 close(paneId:number):Promise<void>; focus(paneId:number):Promise<void>; resize(paneId:number,direction:string,amount:number):Promise<void>; move(paneId:number,newWindow?:boolean,windowId?:number):Promise<void>;
}
export function defaultBinary(){const win='/mnt/c/Program Files/WezTerm/wezterm.exe';return process.env.TERM_DAD_WEZTERM || (existsSync(win)?win:'wezterm');}
// WSL does not forward arbitrary Linux environment variables to Windows.
export function terminalEnvironment(endpoint?:string):NodeJS.ProcessEnv {
 const forwarded=(process.env.WSLENV??'').split(':').filter(v=>v&&v.split('/')[0]!=='WEZTERM_UNIX_SOCKET');
 return {...process.env,...(endpoint?{WEZTERM_UNIX_SOCKET:endpoint,WSLENV:[...forwarded,'WEZTERM_UNIX_SOCKET'].join(':')}:{})};
}
export class WezTermBackend implements TerminalBackend {
 readonly run:Runner;
 readonly instance:()=>Promise<TerminalInstance|null>;
 constructor(run?:Runner,identity?:()=>Promise<TerminalInstance|null>){
  const binary=defaultBinary();
  this.instance=identity??(run?async()=>null:windowsInstance(binary,execute));
  this.run=run??(async(args,input)=>{
   const identity=await this.instance(),endpoint=identity?.endpoint??process.env.WEZTERM_UNIX_SOCKET;
   return execute(binary,['cli','--no-auto-start',...args],input,15000,terminalEnvironment(endpoint));
  });
 }
 async list(){return parsePanes(await this.run(['list','--format','json']));}
 private options(o:SpawnOptions){spawnSchema.parse(o);const a:string[]=[];if(o.paneId!==undefined)a.push('--pane-id',String(o.paneId));if(o.cwd)a.push('--cwd',o.cwd);return a;}
 private paneId(text:string){const n=Number(text.trim());if(!/^\d+$/.test(text.trim()))throw new Error('WezTerm returned an invalid pane ID');return id.parse(n);}
 async spawn(o:SpawnOptions){const a=['spawn',...this.options(o)];if(o.newWindow&&o.windowId!==undefined)throw new Error('newWindow and windowId are mutually exclusive');if(o.newWindow)a.push('--new-window');if(o.windowId!==undefined)a.push('--window-id',String(o.windowId));if(o.domain)a.push('--domain-name',o.domain);if(o.command)a.push('--',...o.command);return this.paneId(await this.run(a));}
 async split(o:SpawnOptions & {paneId:number;direction?:'right'|'bottom';percent?:number}){id.parse(o.paneId);const a=['split-pane',...this.options(o),o.direction==='right'?'--right':'--bottom'];if(o.percent!==undefined)a.push('--percent',String(z.number().int().min(1).max(99).parse(o.percent)));if(o.command)a.push('--',...o.command);return this.paneId(await this.run(a));}
 async read(paneId:number,lines=100){id.parse(paneId);z.number().int().min(1).max(5000).parse(lines);const text=await this.run(['get-text','--pane-id',String(paneId),'--start-line',String(-lines)]);return text.replace(/\r\n/g,'\n').trimEnd().split('\n').slice(-lines).join('\n');}
 async sendText(paneId:number,text:string,raw=false){id.parse(paneId);z.string().max(100000).parse(text);await this.run(['send-text','--pane-id',String(paneId),...(raw?['--no-paste']:[])],text);}
 async close(paneId:number){await this.run(['kill-pane','--pane-id',String(id.parse(paneId))]);}
 async focus(paneId:number){await this.run(['activate-pane','--pane-id',String(id.parse(paneId))]);}
 async resize(paneId:number,direction:string,amount:number){await this.run(['adjust-pane-size','--pane-id',String(id.parse(paneId)),'--amount',String(z.number().int().min(1).max(1000).parse(amount)),z.enum(['Left','Right','Up','Down']).parse(direction)]);}
 async move(paneId:number,newWindow=false,windowId?:number){await this.run(['move-pane-to-new-tab','--pane-id',String(id.parse(paneId)),...(newWindow?['--new-window']:[]),...(windowId!==undefined?['--window-id',String(id.parse(windowId))]:[])]);}
}
export const keys:Record<string,string>={ENTER:'\r',ESC:'\x1b',TAB:'\t',UP:'\x1b[A',DOWN:'\x1b[B',RIGHT:'\x1b[C',LEFT:'\x1b[D',CTRL_C:'\x03',CTRL_D:'\x04',CTRL_A:'\x01',CTRL_E:'\x05',CTRL_U:'\x15',BACKSPACE:'\x7f',DELETE:'\x1b[3~',HOME:'\x1b[H',END:'\x1b[F'};
export async function sendKeys(b:TerminalBackend,paneId:number,sequence:string[]){for(const key of sequence)if(!Object.hasOwn(keys,key))throw new Error(`Unsupported key: ${key}`);for(const key of sequence)await b.sendText(paneId,keys[key],true);}
export async function submit(b:TerminalBackend,paneId:number,text:string){await b.sendText(paneId,text);await new Promise(r=>setTimeout(r,100));await sendKeys(b,paneId,['ENTER']);}
