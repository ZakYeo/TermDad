// Deterministic terminal transport for multi-process MCP tests; never controls a real GUI.
import { appendFile } from 'node:fs/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from '../../dist/server.js';
import { WezTermBackend } from '../../dist/backend.js';
const backend=new WezTermBackend(async(args,input)=>{
 if(args[0]==='list')return JSON.stringify([{pane_id:7,tab_id:1,window_id:1,title:'fixture',cwd:'/',size:{rows:24,cols:80}}]);
 if(args[0]==='spawn')return '7';
 if(args[0]==='get-text')return 'OpenAI Codex\n› Explain this codebase';
 if(args[0]==='send-text'){
  if(process.env.WORKER_TEST_LOG)await appendFile(process.env.WORKER_TEST_LOG,JSON.stringify({input})+'\n');
  if(!args.includes('--no-paste'))await new Promise(r=>setTimeout(r,500));
 }
 return '';
},async()=>({endpoint:'fixture-socket',key:process.env.WORKER_TEST_IDENTITY??'fixture-instance'}));
await createServer(backend).server.connect(new StdioServerTransport());
