import { after } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Injecting worker/task/event storage does not isolate socket, credential, usage,
// telemetry or startup-sweep paths. Never inherit a developer's state directory.
// Import this before constructing servers, including when running one test file.
const directory = mkdtempSync(join(tmpdir(), 'term-dad-isolated-test-'));
process.env.TERM_DAD_STATE_DIR = directory;
after(() => rm(directory, { recursive: true, force: true }));
