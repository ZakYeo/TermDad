import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { command, prepareRun, saveRun } from '../demo/runtime.js';
import { connect, demoEnvironment, preflight, supervisorArgs, workerCommand } from '../demo/launcher.js';
import { walkthrough } from '../demo/prompt.js';
import { collectStatus } from '../demo/status.js';
import { startPresentation } from '../demo/presentation.js';

const root = fileURLToPath(new URL('..', import.meta.url));
let closeMcp: (() => Promise<void>) | undefined;
let closeWeb: (() => Promise<void>) | undefined;
try {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check') || args.length > 1) throw new Error('Usage: npm run demo [-- --check]');
  if (!args.includes('--check') && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Error('Launch the demo from an interactive WezTerm terminal.');
  workerCommand(); // Validate the worker shell even for --check.
  const identity = await preflight(root);
  if (args.includes('--check')) {
    console.log('Ready: Node, Git, authenticated Codex and the invoking WezTerm pane verified. No demo launched.');
  } else {
    console.log('Building TermDad…');
    await command(process.execPath, [join(root, 'node_modules/typescript/bin/tsc')], root);
    const run = await prepareRun(root, identity.parentPane, identity.key, identity.endpoint);
    console.log(`Demo files preserved at ${run.directory}`);
    const mcp = await connect(root, run);
    closeMcp = mcp.close;
    const paneList = await mcp.call('terminal.list');
    if (paneList.selected?.key !== run.instanceKey) throw new Error('Terminal identity changed before launch');
    const specs = JSON.parse(await readFile(join(run.repository, 'tickets.json'), 'utf8'));
    for (const ticket of run.tickets) {
      const task = await mcp.call('task.create', {
        boardId: 'sales-demo',
        title: `${ticket.id}: ${ticket.title}`,
        goal: `Implement ${ticket.file} according to tickets.json. ${JSON.stringify(specs).slice(0, 6500)}`,
        acceptanceCriteria: [
          {
            id: 'acceptance',
            description: `node check.mjs ${ticket.id} passes; reviewed component committed and merged into the scratch release.`,
          },
        ],
      });
      ticket.taskId = task.id;
    }
    await saveRun(run);
    const web = await startPresentation({
      beforeDirectory: run.before,
      afterDirectory: run.repository,
      readStatus: () => collectStatus(run, mcp.call),
    });
    closeWeb = web.close;
    console.log(
      `Presentation: ${web.url}\nExit Codex to stop the preview server. Workers and scratch files remain for inspection.`,
    );
    const opener =
      process.platform === 'darwin'
        ? ['open']
        : process.env.WSL_DISTRO_NAME
          ? ['rundll32.exe', 'url.dll,FileProtocolHandler']
          : ['xdg-open'];
    try {
      await command(opener[0], [...opener.slice(1), web.url], root);
    } catch {
      console.log(`Open ${web.url} in your browser.`);
    }
    const env = demoEnvironment(run);
    for (const key of [
      'CODEX_THREAD_ID',
      'CODEX_SESSION_ID',
      'CODEX_TOOL_CALL_ID',
      'CODEX_PERMISSION_PROFILE',
      'CODEX_SANDBOX_NETWORK_DISABLED',
    ])
      delete env[key];
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn('codex', supervisorArgs(root, run, walkthrough(root, run, web.url)), {
        cwd: run.directory,
        env,
        stdio: 'inherit',
      });
      const terminate = () => child.kill('SIGTERM');
      const interrupt = () => {}; // Foreground Codex also receives terminal SIGINT.
      process.on('SIGINT', interrupt);
      process.once('SIGTERM', terminate);
      child.once('error', reject);
      child.once('close', (code) => {
        process.removeListener('SIGTERM', terminate);
        process.removeListener('SIGINT', interrupt);
        resolve(code ?? 1);
      });
    });
    process.exitCode = code;
    console.log(
      `Demo stopped. Close only its worker panes when finished. Files and pane IDs: ${join(run.directory, 'run.json')}`,
    );
  }
} catch (error) {
  console.error(`Demo: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closeWeb?.();
  await closeMcp?.();
}
