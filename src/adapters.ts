export type Status='STARTING'|'WORKING'|'READY_FOR_PROMPT'|'WAITING_FOR_PERMISSION'|'WAITING_FOR_QUESTION'|'RUNNING_EXTERNAL_COMMAND'|'IDLE'|'ERROR'|'UNKNOWN';
export interface InteractiveAgentAdapter { cli:string; classify(text:string):Status; }
function common(text:string):Status|undefined {
 if(/(?:do you trust|trust this folder|allow .*\?|permission required|would you like to proceed|Do you want to proceed)/i.test(text))return 'WAITING_FOR_PERMISSION';
 if(/(?:select an option|choose an option|Enter to select|Which .+\?)/i.test(text))return 'WAITING_FOR_QUESTION';
 if(/(?:not logged in|authentication failed|failed to connect|command not found|API Error:)/i.test(text))return 'ERROR';
}
export class ClaudeCodeAdapter implements InteractiveAgentAdapter {cli='claude'; classify(text:string):Status {const t=text.split('\n').slice(-25).join('\n');return common(t)??(/(?:esc to interrupt|ctrl\+c to interrupt|Thinking…|Working…)/i.test(t)?'WORKING':/(?:^|\n)\s*[❯>]\s*[^\n]*$/m.test(t)?'READY_FOR_PROMPT':'UNKNOWN');}}
export class CodexAdapter implements InteractiveAgentAdapter {cli='codex';classify(text:string):Status {const t=text.split('\n').slice(-25).join('\n');return common(t)??(/(?:esc to interrupt|Working \(|Thinking)/i.test(t)?'WORKING':/(?:^|\n)\s*›[^\n]*$/m.test(t)?'READY_FOR_PROMPT':'UNKNOWN');}}
export class ShellAdapter implements InteractiveAgentAdapter {cli='shell';classify(text:string):Status{return /(?:^|\n)[^\n]*[$#❯>]\s*$/.test(text.trimEnd())?'READY_FOR_PROMPT':'UNKNOWN';}}
export const adapters:Record<string,InteractiveAgentAdapter>={claude:new ClaudeCodeAdapter(),codex:new CodexAdapter(),shell:new ShellAdapter()};
