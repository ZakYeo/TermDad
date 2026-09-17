import test from 'node:test';
import assert from 'node:assert/strict';
import { pushHookArgv,notifyCommand } from '../src/worker-hooks.js';
const options={socketPath:'/run/term-dad/push.sock',token:'tok-123',notify:['/usr/bin/node','/opt/term-dad/notify.js']};
test('claude workers receive inert hook settings that route each event kind to one notifier',()=>{
 const argv=pushHookArgv('claude',['claude','--model','opus'],options);
 assert.deepEqual(argv.slice(0,3),['claude','--model','opus']);
 assert.equal(argv[3],'--settings');
 const settings=JSON.parse(argv[4]);
 assert.deepEqual(Object.keys(settings.hooks).sort(),['Notification','SessionEnd','Stop']);
 const commands=Object.values(settings.hooks).flatMap((matchers:any)=>matchers.flatMap((m:any)=>m.hooks.map((h:any)=>h.command)));
 assert.equal(commands.length,3);
 for(const command of commands){assert.ok(command.includes('tok-123'));assert.ok(command.includes('/run/term-dad/push.sock'));}
 assert.ok(commands.some(c=>c.includes('input_required'))&&commands.some(c=>c.includes('ready'))&&commands.some(c=>c.includes('session_ended')));
});
test('codex workers receive a notify program override and shells are left untouched',()=>{
 const codex=pushHookArgv('codex',['codex'],options);
 assert.equal(codex[1],'-c');
 assert.match(codex[2],/^notify=/);
 const program=JSON.parse(codex[2].slice('notify='.length));
 assert.deepEqual(program.slice(0,2),options.notify);
 assert.ok(program.includes('tok-123')&&program.includes('/run/term-dad/push.sock'));
 assert.deepEqual(pushHookArgv('shell',['bash','-l'],options),['bash','-l']);
});
test('a worker command is never rewritten when push plumbing is unavailable',()=>{
 assert.deepEqual(pushHookArgv('claude',['claude'],undefined),['claude']);
 assert.deepEqual(pushHookArgv('codex',undefined,options),undefined);
});
test('the bundled notifier resolves to an executable shipped with the server',()=>{
 const command=notifyCommand();
 assert.ok(command.length>=1);
 assert.ok(command.at(-1)!.endsWith('term-dad-notify.js'));
});
test('wrapped launcher argv keeps hook flags with the CLI, not with its wrapper',()=>{
 // scripts/launch-local resolves both CLIs through wrappers; flags must follow the CLI itself.
 const codex=pushHookArgv('codex',['/usr/bin/node','/opt/codex/bin/codex.js'],options);
 assert.deepEqual(codex!.slice(0,2),['/usr/bin/node','/opt/codex/bin/codex.js']);
 assert.equal(codex![2],'-c');
 const claude=pushHookArgv('claude',['/usr/bin/env','PATH=/x','/home/zak/.local/bin/claude'],options);
 assert.deepEqual(claude!.slice(0,3),['/usr/bin/env','PATH=/x','/home/zak/.local/bin/claude']);
 assert.equal(claude![3],'--settings');
});
