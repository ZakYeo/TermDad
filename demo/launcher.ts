import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WezTermBackend } from '../src/backend.js';
import { command, type DemoRun } from './runtime.js';
import { basename, join } from 'node:path';

export async function preflight(
  cwd: string,
  env = process.env,
  run = command,
  backend: { instance: WezTermBackend['instance']; list: () => Promise<{ pane_id: number }[]> } = new WezTermBackend(),
) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22+ is required');
  if (!env.WEZTERM_PANE || !/^\d+$/.test(env.WEZTERM_PANE) || !env.WEZTERM_UNIX_SOCKET)
    throw new Error(
      'Run this command inside the intended WezTerm pane (WEZTERM_PANE and WEZTERM_UNIX_SOCKET required).',
    );
  await run('git', ['--version'], cwd);
  await run('codex', ['--version'], cwd);
  await run('codex', ['login', 'status'], cwd);
  const identity = await backend.instance();
  if (!identity) throw new Error('This demo requires verified WezTerm GUI identity (currently Windows/WSL).');
  if (identity.endpoint !== env.WEZTERM_UNIX_SOCKET)
    throw new Error('Selected GUI does not match the invoking WezTerm socket. Open a fresh pane and retry.');
  if (!(await backend.list()).some((p) => p.pane_id === Number(env.WEZTERM_PANE)))
    throw new Error('The invoking pane is not in the selected WezTerm GUI.');
  return { parentPane: Number(env.WEZTERM_PANE), ...identity };
}

export function demoEnvironment(run: DemoRun) {
  return {
    ...process.env,
    TERM_DAD_STATE_DIR: run.state,
    TERM_DAD_STRICT_INSTANCE: '1',
    WEZTERM_UNIX_SOCKET: run.endpoint,
  } as Record<string, string>;
}
export function supervisorArgs(root: string, run: DemoRun, prompt: string) {
  const config: Record<string, unknown> = {
    'mcp_servers.term-dad.command': join(root, 'scripts/launch-local'),
    'mcp_servers.term-dad.args': [],
    'mcp_servers.term-dad.enabled': true,
    'mcp_servers.term-dad.required': true,
    'mcp_servers.term-dad.env.TERM_DAD_STATE_DIR': run.state,
    'mcp_servers.term-dad.env.TERM_DAD_STRICT_INSTANCE': '1',
    'mcp_servers.term-dad.env.WEZTERM_UNIX_SOCKET': run.endpoint,
  };
  return [
    '--cd',
    run.directory,
    '--sandbox',
    'workspace-write',
    '--ask-for-approval',
    'on-request',
    ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
    prompt,
  ];
}
export async function connect(root: string, run: DemoRun) {
  const client = new Client({ name: 'term-dad-internal-demo', version: '1' });
  const transport = new StdioClientTransport({
    command: join(root, 'scripts/launch-local'),
    env: demoEnvironment(run),
    stderr: 'inherit',
  });
  try {
    await client.connect(transport);
  } catch (e) {
    await transport.close();
    throw e;
  }
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 35000 });
    if (response.isError) throw new Error(`Demo MCP call failed: ${name}`);
    const content = response.content as { type: string; text?: string }[];
    const text = content.find((c) => c.type === 'text')?.text;
    if (!text) throw new Error(`No data returned by ${name}`);
    return JSON.parse(text);
  };
  return { call, close: () => client.close() };
}

export function workerCommand(shell = process.env.TERM_DAD_LOCAL_SHELL || process.env.SHELL || '/bin/sh') {
  const cli = ['codex', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'];
  if (basename(shell) === 'fish') return [shell, '-lic', 'exec $argv', ...cli];
  if (['sh', 'dash', 'bash', 'zsh', 'ksh'].includes(basename(shell)))
    return [shell, '-lic', 'exec "$@"', 'term-dad-demo-worker', ...cli];
  throw new Error('Set TERM_DAD_LOCAL_SHELL to a supported login shell for worker launch.');
}
