#!/usr/bin/env node
// Both branches import lazily: the server's module graph reads the bundled worker skill at
// import time and constructs a push socket, so a CLI subcommand must never load it.
const [subcommand,...rest]=process.argv.slice(2);
// Captured before the imports below, which can take longer than a short-lived parent survives.
const launchedBy=process.ppid;
if(subcommand==='wait-for-event'){
 const {runWaitForEvent}=await import('./wait-cli.js');
 process.exit(await runWaitForEvent(rest));
}
if(subcommand!==undefined){
 console.error(`term-dad: unknown subcommand ${subcommand}; expected wait-for-event, or no arguments to serve MCP over stdio`);
 process.exit(2);
}
const [{StdioServerTransport},{createServer}]=await Promise.all([import('@modelcontextprotocol/sdk/server/stdio.js'),import('./server.js')]);
const {server,dispose}=createServer();
const transport=new StdioServerTransport();
// The stdio transport only reads stdin data; it never notices the client going away. Close the
// server explicitly when stdin ends, and when the parent process has died while something else
// still holds the stdin pipe open, so a server never outlives the client it was launched for.
let closing=false;
const shutdown=async(reason:string)=>{
 if(closing)return;closing=true;
 console.error(`[term-dad] shutting down: ${reason}`);
 const cap=new Promise<void>(resolve=>setTimeout(resolve,5000).unref());
 const report=(step:string)=>(e:unknown)=>console.error(`[term-dad] ${step} during shutdown: ${e instanceof Error?e.message:e}`);
 await Promise.race([dispose().catch(report('dispose failed')),cap]);
 await Promise.race([server.close().catch(report('close failed')),cap]);
 process.exit(0);
};
process.stdin.once('end',()=>void shutdown('client closed stdin'));
process.stdin.once('close',()=>void shutdown('client closed stdin'));
const parentCheckMs=Number(process.env.TERM_DAD_PARENT_CHECK_MS)||5000;
setInterval(()=>{if(process.ppid!==launchedBy)void shutdown(`parent process ${launchedBy} exited`);},parentCheckMs).unref();
await server.connect(transport);
