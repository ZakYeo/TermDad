import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LiveGuard, explicitTestPane } from './live-guard.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Each live test has its own registry and closes only panes whose creation it observed. */
export class LiveSession {
  readonly guard: LiveGuard;
  readonly owned: Set<number>;
  private uncertainSpawn = false;
  client = new Client({ name: 'term-dad-live-test', version: '1' });
  private constructor(
    readonly directory: string,
    private readonly env: Record<string, string>,
  ) {
    this.guard = new LiveGuard(
      env.TERM_DAD_TEST_ENDPOINT ?? process.env.TERM_DAD_TEST_ENDPOINT,
      explicitTestPane(env.TERM_DAD_TEST_PANE ?? process.env.TERM_DAD_TEST_PANE),
      env.TERM_DAD_TEST_INSTANCE_KEY ?? process.env.TERM_DAD_TEST_INSTANCE_KEY,
    );
    this.owned = this.guard.panes;
  }
  static async create(env: Record<string, string> = {}) {
    const session = new LiveSession(await mkdtemp(join(tmpdir(), 'term-dad-live-')), env);
    try {
      await session.connect();
      return session;
    } catch (error) {
      await session.client.close().catch(() => {});
      await rm(session.directory, { recursive: true, force: true });
      throw error;
    }
  }
  private async connect() {
    await this.client.connect(
      new StdioClientTransport({
        command: `${process.cwd()}/scripts/launch-local`,
        env: {
          ...process.env,
          ...this.env,
          TERM_DAD_STATE_DIR: this.directory,
          TERM_DAD_STRICT_INSTANCE: '1',
          WEZTERM_UNIX_SOCKET: this.env.TERM_DAD_TEST_ENDPOINT ?? process.env.TERM_DAD_TEST_ENDPOINT ?? '',
        } as Record<string, string>,
        stderr: 'inherit',
      }),
    );
  }
  async restart() {
    await this.client.close();
    this.client = new Client({ name: 'term-dad-live-test', version: '1' });
    await this.connect();
  }
  call = async (name: string, args: Record<string, unknown> = {}) => {
    if (name.startsWith('terminal.') || name.startsWith('agent.')) {
      if (
        !(this.env.TERM_DAD_TEST_ENDPOINT ?? process.env.TERM_DAD_TEST_ENDPOINT) ||
        !(this.env.TERM_DAD_TEST_INSTANCE_KEY ?? process.env.TERM_DAD_TEST_INSTANCE_KEY)
      )
        throw new Error(
          'Live operations require explicit TERM_DAD_TEST_ENDPOINT, TERM_DAD_TEST_INSTANCE_KEY and TERM_DAD_TEST_PANE; inherited WezTerm variables are not authorization',
        );
      const identity = await this.rawCall('terminal.list_instances');
      this.guard.verify(identity.selected);
      this.guard.authorize(name, args);
    }
    const value = await this.rawCall(name, args);
    if (name === 'agent.spawn' || name === 'agent.adopt') this.guard.agents.add(value.agentId);
    return value;
  };
  private rawCall = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 150000 });
    if (result.isError) throw new Error(JSON.stringify(result));
    return JSON.parse((result.content as { text: string }[])[0].text);
  };
  async spawnAgent(args: Record<string, unknown>) {
    // Record ownership before waiting for readiness or submitting an initial prompt.
    if (args.prompt !== undefined) throw new Error('Live tests must submit prompts after recording pane ownership');
    try {
      const worker = await this.call('agent.spawn', args);
      this.owned.add(worker.paneId);
      return worker;
    } catch (error) {
      this.recordUncertainSpawn();
      throw error;
    }
  }
  async spawnPane(args: Record<string, unknown>, split = false) {
    try {
      const pane = await this.call(split ? 'terminal.split' : 'terminal.spawn', args);
      this.owned.add(pane);
      return pane as number;
    } catch (error) {
      this.recordUncertainSpawn();
      throw error;
    }
  }
  private recordUncertainSpawn() {
    this.uncertainSpawn = true;
    console.error(
      `Spawn failed with uncertain pane ownership; inspect the terminal manually. State retained in ${this.directory}`,
    );
  }
  async closePane(paneId: number) {
    if (!this.owned.has(paneId)) throw new Error(`Refusing to close unowned pane ${paneId}`);
    try {
      await this.call('terminal.close', { target: 'pane', id: paneId });
    } catch (error) {
      if (!(await this.paneAbsent(paneId))) throw error;
    }
    this.owned.delete(paneId);
  }
  private async paneAbsent(paneId: number) {
    // A failed listing cannot establish disappearance.
    const panes = await this.call('terminal.list');
    return !panes.some((pane: { pane_id: number }) => pane.pane_id === paneId);
  }
  async stopAgent(agentId: string, paneId: number) {
    if (!this.owned.has(paneId)) throw new Error(`Refusing to stop unowned pane ${paneId}`);
    if (!(await this.paneAbsent(paneId))) {
      try {
        await this.call('agent.stop', { agentId });
      } catch (error) {
        if (!(await this.paneAbsent(paneId))) throw error;
      }
    }
    this.owned.delete(paneId);
  }
  async dispose() {
    let clean = true;
    for (const paneId of this.owned) {
      try {
        await this.closePane(paneId);
      } catch {
        clean = false;
        console.error(`Cleanup needed for test pane ${paneId}; state retained in ${this.directory}`);
      }
    }
    await this.client.close();
    if (clean && !this.uncertainSpawn) await rm(this.directory, { recursive: true, force: true });
  }
}

export function parentPane(panes: { pane_id: number }[]) {
  const requested = process.env.TERM_DAD_TEST_PANE;
  const pane = explicitTestPane(requested);
  if (!Number.isSafeInteger(pane) || !panes.some((p) => p.pane_id === pane))
    throw new Error('Explicit TERM_DAD_TEST_PANE in the verified test GUI required');
  return pane!;
}
