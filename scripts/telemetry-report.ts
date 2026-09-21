import { join } from 'node:path';
import { stateDirectory } from '../src/journal.js';
import { readTelemetry, summarize, reportMarkdown } from '../src/telemetry-report.js';
const args = process.argv.slice(2);
if (args.some((arg) => arg.startsWith('--') && arg !== '--json') || args.filter((arg) => arg !== '--json').length > 1) {
  throw new Error('Usage: npm run telemetry:report -- [directory] [--json]');
}
const directory = args.find((arg) => arg !== '--json') ?? join(stateDirectory(), 'telemetry');
const { metrics, ...coverage } = await readTelemetry(directory);
const report = { ...coverage, tools: summarize(metrics) };
console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : reportMarkdown(report));
