import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const client=new Client({name:'term-dad-screenshot-test',version:'1'});
try{
 await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/index.js'],env:{TERM_DAD_SCREENSHOT_COMMAND:process.env.TERM_DAD_SCREENSHOT_COMMAND??`${process.cwd()}/scripts/screenshot-wsl`},stderr:'inherit'}));
 const list=await client.callTool({name:'terminal.list',arguments:{}});assert.ok(!list.isError);
 const pane=JSON.parse((list.content as any)[0].text)[0];
 const result=await client.callTool({name:'terminal.screenshot',arguments:{paneId:pane.pane_id}});assert.ok(!result.isError,JSON.stringify(result));
 const image=(result.content as any)[0];assert.equal(image.type,'image');assert.equal(image.mimeType,'image/png');
 const png=Buffer.from(image.data,'base64');assert.ok(png.readUInt32BE(16)>500);assert.ok(png.readUInt32BE(20)>300,'Must capture more than minimized title bar');
 await writeFile('/tmp/term-dad-screenshot.png',png);console.log('PASS: MCP screenshot PNG',png.length,'bytes → /tmp/term-dad-screenshot.png');
}finally{await client.close();}
