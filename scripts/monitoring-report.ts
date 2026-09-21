import { join } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { stateDirectory } from '../src/journal.js';
import { readMonitoring, summarizeMonitoring, referenceSchema } from '../src/monitoring-report.js';
const args = process.argv.slice(2);
if (args.length > 2 || args.some((a) => a.startsWith('--')))
  throw new Error('Usage: npm run monitoring:report -- [directory] [reference-transitions.json]');
const directory = args[0] ?? join(stateDirectory(), 'monitoring');
let references = referenceSchema.parse([]);
if (args[1]) {
  if ((await stat(args[1])).size > 1024 * 1024) throw new Error('Reference file exceeds 1 MiB');
  references = referenceSchema.parse(JSON.parse(await readFile(args[1], 'utf8')));
}
const { metrics, ...coverage } = await readMonitoring(directory);
console.log(JSON.stringify({ ...coverage, sessions: summarizeMonitoring(metrics, references) }, null, 2));
