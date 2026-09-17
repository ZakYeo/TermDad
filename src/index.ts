#!/usr/bin/env node
// Both branches import lazily: the server's module graph reads the bundled worker skill at
// import time and constructs a push socket, so a CLI subcommand must never load it.
const [subcommand,...rest]=process.argv.slice(2);
if(subcommand==='wait-for-event'){
 const {runWaitForEvent}=await import('./wait-cli.js');
 process.exit(await runWaitForEvent(rest));
}
if(subcommand!==undefined){
 console.error(`term-dad: unknown subcommand ${subcommand}; expected wait-for-event, or no arguments to serve MCP over stdio`);
 process.exit(2);
}
const [{StdioServerTransport},{createServer}]=await Promise.all([import('@modelcontextprotocol/sdk/server/stdio.js'),import('./server.js')]);
const {server}=createServer();
await server.connect(new StdioServerTransport());
