import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WezTermBackend } from '../src/backend.js';
import { Agents,normalizeScreen,tail,delta } from '../src/agents.js';
const pane={pane_id:7,tab_id:3,window_id:1,title:'test',cwd:'file:///tmp',size:{rows:24,cols:80}};
function fake(initial='$ '){let text=initial;const backend=new WezTermBackend(async args=>{switch(args[0]){case 'list':return JSON.stringify([pane]);case 'spawn':return '7\n';case 'get-text':return text;default:return '';}});return {backend,setText:(s:string)=>{text=s;}};}
const padded=(lines:string[])=>lines.map(l=>l.padEnd(80)).join('\n');

test('normalizeScreen strips per-line padding and collapses blank runs',()=>{
 assert.equal(normalizeScreen('a   \n\n\n\nb  \n   \n'),'a\n\nb');
 assert.equal(normalizeScreen(''),'');
});
test('a padded captured screen shrinks by about half once normalized',async()=>{
 const fixture=await readFile(new URL('./fixtures/claude-ready.txt',import.meta.url),'utf8');
 const raw=padded(fixture.split('\n')),normalized=normalizeScreen(raw);
 assert.ok(normalized.length<=raw.length*0.52,`${normalized.length} of ${raw.length}`);
});
test('tail keeps the last N lines and counts what it dropped',()=>{
 assert.deepEqual(tail('a\nb\nc',2),{text:'b\nc',linesOmitted:1});
 assert.deepEqual(tail('a\nb',5),{text:'a\nb',linesOmitted:0});
});
test('observe caps recentText at 20 lines by default and honours a lines override',async()=>{
 const lines=Array.from({length:60},(_,i)=>`line ${i}`);const f=fake(lines.join('\n')),a=new Agents(f.backend);await a.spawn({name:'w',cli:'shell'});
 const capped=await a.observe('w');assert.equal(capped.recentText,lines.slice(-20).join('\n'));assert.equal(capped.linesOmitted,40);
 const full=await a.observe('w',undefined,60);assert.equal(full.recentText,lines.join('\n'));assert.equal(full.linesOmitted,0);
 await assert.rejects(a.observe('w',undefined,0));await assert.rejects(a.observe('w',undefined,151));
});
test('output hash is computed on normalized text so padding changes are not activity',async()=>{
 const f=fake(padded(['$ ']));const a=new Agents(f.backend);await a.spawn({name:'w',cli:'shell'});
 const first=await a.observe('w');f.setText('$ ');const second=await a.observe('w');
 assert.equal(second.outputHash,first.outputHash);assert.equal(second.activity,'unchanged');
});
test('wait for text sees the whole screen even though the returned text is capped',async()=>{
 const lines=['needle',...Array.from({length:40},(_,i)=>`line ${i}`)];const f=fake(lines.join('\n')),a=new Agents(f.backend);await a.spawn({name:'w',cli:'shell'});
 const found=await a.wait('w',o=>o.recentText.includes('needle'),500);
 assert.equal(found.linesOmitted,21);assert.ok(!found.recentText.includes('needle'));
});
