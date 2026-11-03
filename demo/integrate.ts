import { readFile } from 'node:fs/promises';
import { integrate, type DemoRun } from './runtime.js';

try {
  const [manifest, ticket] = process.argv.slice(2);
  if (!manifest || !ticket || process.argv.length !== 4) throw new Error('Usage: integrate.ts <run.json> <SALES-10x>');
  const run: DemoRun = JSON.parse(await readFile(manifest, 'utf8'));
  console.log(JSON.stringify(await integrate(run, ticket)));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
