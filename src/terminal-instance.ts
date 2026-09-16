import { fileURLToPath } from 'node:url';
import { instanceSchema,type TerminalInstance } from './worker-storage.js';
import type { execute } from './backend.js';

/** Host-side identity only. No command is ever injected into a worker pane. */
export function windowsInstance(binary:string,run:typeof execute){
 let endpoint=process.env.WEZTERM_UNIX_SOCKET;
 let firstKey:string|undefined;
 let helperPath:Promise<string>|undefined;
 return async():Promise<TerminalInstance|null>=>{
  const wsl=binary.startsWith('/mnt/')&&binary.toLowerCase().endsWith('.exe');
  if(!wsl&&process.platform!=='win32')return null;
  const script=fileURLToPath(new URL('../scripts/instance-windows.ps1',import.meta.url));
  helperPath??=wsl?run('wslpath',['-w',script]).then(s=>s.trim()):Promise.resolve(script);
  const powershell=wsl?'/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe':'powershell.exe';
  const windowsBinary=wsl?(await run('wslpath',['-w',binary])).trim():binary;
  const result=await run(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',await helperPath],JSON.stringify({endpoint,binary:windowsBinary}));
  const identity=instanceSchema.parse(JSON.parse(result));
  if(firstKey!==undefined&&firstKey!==identity.key)throw new Error('WezTerm GUI identity changed; restart the MCP server and reattach explicitly');
  firstKey=identity.key;endpoint=identity.endpoint;
  return identity;
 };
}
