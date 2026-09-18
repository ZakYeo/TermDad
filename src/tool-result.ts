import { z } from 'zod';

export type ToolResult={content:{type:'text';text:string}[];isError?:true};
const text=(value:unknown):ToolResult=>({content:[{type:'text',text:JSON.stringify(value??{ok:true})}]});
/**
 * The one way a tool answers: the JSON of its result, or the failure message as `isError` text.
 * A schema failure names the offending field so the error teaches the caller the schema; a
 * `invalid` code prefixes it for the tool groups that report one. Every failure is logged to
 * stderr, never stdout, which belongs to the protocol.
 */
export async function toolCall(name:string,fn:()=>Promise<unknown>,options:{invalid?:string}={}):Promise<ToolResult>{
 try{return text(await fn());}
 catch(e){return toolError(name,e,options);}
}
/** The failure half of `toolCall`, for tools whose success content is not JSON text (images). */
export function toolError(name:string,e:unknown,options:{invalid?:string}={}):ToolResult{
 const message=e instanceof z.ZodError?`${options.invalid??'ARGUMENT_INVALID'}: ${e.issues.map(i=>`${i.path.join('.')||'input'}: ${i.message}`).join('; ')}`:e instanceof Error?e.message:`${name} failed`;
 console.error(`[term-dad] ${name}: ${message}`);
 return {isError:true,content:[{type:'text',text:message}]};
}
