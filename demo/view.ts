import { loadPrepared } from './prepared.js';
import { startPresentation } from './presentation.js';
import { collectStatus } from './status.js';
import { TaskBoard } from '../src/tasks.js';
import { FileTaskStorage } from '../src/task-storage.js';

// Reopen recorded results without launching Codex, claiming a run or touching terminals.
try {
  if (process.argv.length !== 3) throw new Error('Usage: npm run demo:view -- <demo-directory>');
  const run = await loadPrepared(process.argv[2], true);
  const board = new TaskBoard(new FileTaskStorage(run.state));
  const web = await startPresentation({
    beforeDirectory: run.before,
    afterDirectory: run.repository,
    readStatus: () =>
      collectStatus(run, async (name) => (name === 'task.list' ? board.list({ boardId: 'sales-demo' }) : [])),
  });
  console.log(
    `Recorded demo: ${web.url}\nOpen this URL in your browser. Ctrl+C stops this viewer. No workers launched.`,
  );
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await web.close();
  await board.close();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
