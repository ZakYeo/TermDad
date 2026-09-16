import { execute } from './backend.js';
export interface ScreenshotProvider {capture(paneId:number):Promise<{type:'image';data:string;mimeType:'image/png'}>;}
// The provider executable receives a pane ID and must return PNG base64 on stdout.
export class CommandScreenshotProvider implements ScreenshotProvider {
 async capture(paneId:number){const command=process.env.TERM_DAD_SCREENSHOT_COMMAND;if(!command)throw new Error('Screenshot provider not configured. Set TERM_DAD_SCREENSHOT_COMMAND to a trusted executable accepting a pane ID and returning PNG base64.');const data=(await execute(command,[String(paneId)])).trim();const bytes=Buffer.from(data,'base64');if(bytes.length>5*1024*1024||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Screenshot provider did not return a valid PNG (max 5 MiB)');return {type:'image' as const,data,mimeType:'image/png' as const};}
}
