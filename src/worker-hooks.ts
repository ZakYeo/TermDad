import { fileURLToPath } from 'node:url';
import type { PushKind } from './ingress.js';

export interface PushHookOptions {socketPath:string;token:string;notify:string[];}
/** The notifier bundled with the server; workers run it, so it must exist in the built output. */
export const notifyCommand=()=>[process.execPath,fileURLToPath(new URL('./term-dad-notify.js',import.meta.url))];
const quote=(value:string)=>`'${value.replaceAll("'",`'\\''`)}'`;
const args=(o:PushHookOptions,extra:string[])=>[...o.notify,'--socket',o.socketPath,'--token',o.token,...extra];
// Claude Code fires these on its own state changes, so no screen scraping is needed to learn about them.
const claudeHooks:Record<string,PushKind>={Notification:'input_required',Stop:'ready',SessionEnd:'session_ended'};

/**
 * Adds push plumbing to a worker's argv. The hooks are inert until the pane's
 * registration is enabled, so an injected worker still pushes nothing by default.
 */
export function pushHookArgv(cli:'claude'|'codex'|'shell',command:string[]|undefined,options:PushHookOptions|undefined){
 if(!command||!options||cli==='shell')return command;
 if(cli==='claude'){
  const hooks=Object.fromEntries(Object.entries(claudeHooks).map(([event,kind])=>[event,[{hooks:[{type:'command',command:args(options,['--kind',kind]).map(quote).join(' '),timeout:5}]}]]));
  return [...command,'--settings',JSON.stringify({hooks})];
 }
 return [...command,'-c',`notify=${JSON.stringify(args(options,['--codex']))}`];
}
