import { readFileSync } from 'node:fs';

// Bundle the same instructions that users install. Inline content also works in
// remote terminal domains, where a server-host path would be meaningless.
const workerSkill=readFileSync(new URL('../skills/term-dad-worker/SKILL.md',import.meta.url),'utf8')
 .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').trim();

export function initialWorkerPrompt(task:string){
 return `$term-dad-worker\n\nApply the Term Dad worker skill once for this session. Its bundled instructions follow, so no local skill installation is required:\n\n${workerSkill}\n\n---\nAssignment:\n${task}`;
}
