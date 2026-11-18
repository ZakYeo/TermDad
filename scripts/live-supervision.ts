import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LiveSession, parentPane } from './live-support.js';
const cli = process.argv[2] ?? 'codex';
const plan = process.argv.includes('--plan');
if (!['claude', 'codex'].includes(cli) || (plan && cli !== 'claude'))
  throw new Error('Usage: npm run test:supervision -- claude|codex [--plan]');

// This process waits for events; it never uses supervisor heartbeat sleeps.
function arm(command: string[], stateDir: string, groupId: string) {
  const child = spawn(
    command[0],
    [
      ...command.slice(1),
      '--group',
      groupId,
      '--state-dir',
      stateDir,
      '--kinds',
      plan
        ? 'plan_approval,tool_permission,question'
        : 'ready,worker_report,input_required,plan_approval,tool_permission,question',
      '--timeout-seconds',
      '120',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '',
    diagnostic = '';
  const timer = setTimeout(() => child.kill('SIGTERM'), 125000);
  const done = new Promise<any>((resolve, reject) => {
    child.stdout.on('data', (data) => {
      output += data.toString();
      if (output.length > 65536) child.kill('SIGTERM');
    });
    child.stderr.on('data', (data) => {
      diagnostic = (diagnostic + data.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Event waiter failed (${code}): ${diagnostic}`));
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error('Event waiter did not return one JSON result'));
      }
    });
  });
  void done.catch(() => {});
  return {
    done,
    stop: () => {
      clearTimeout(timer);
      child.kill('SIGTERM');
    },
  };
}

let scratch: string | undefined;
let retainScratch = false;
const session = await LiveSession.create();
const call = session.call;
let active: ReturnType<typeof arm> | undefined;
let group: any;
try {
  if (cli === 'claude') {
    scratch = await mkdtemp(join(tmpdir(), 'term-dad-claude-supervision-'));
    console.log(`Claude scratch directory: ${scratch}`);
    await writeFile(join(scratch, 'README.md'), 'Temporary Term Dad hook test. No secrets or external services.\n');
  }
  const paneId = parentPane((await call('terminal.list')).panes);
  for (let round = 1; round <= 2; round++) {
    const worker = await session
      .spawnAgent({
        name: `supervision-${cli}-${round}`,
        cli,
        paneId,
        cwd: scratch ?? process.cwd(),
        ...(plan ? { cliArgs: ['--permission-mode', 'plan'] } : {}),
      })
      .catch((error) => {
        retainScratch = true;
        throw error;
      });
    let ready = await call('agent.wait_until_ready', { agentId: worker.agentId, timeoutMs: 30000 });
    if (
      cli === 'codex' &&
      ready.lastObservation?.recentText?.includes('Update available') &&
      ready.lastObservation.recentText.includes('esc skip')
    ) {
      await call('terminal.send_keys', { paneId: worker.paneId, keys: ['ESC'] });
      ready = await call('agent.wait_until_ready', { agentId: worker.agentId, timeoutMs: 30000 });
    }
    if (ready.reason === 'input_required') {
      console.error(
        `Startup input reported in test pane ${worker.paneId}; waiting up to 60 seconds without approving it.`,
      );
      await call('agent.wait_until_idle', { agentId: worker.agentId, timeoutMs: 60000 });
      ready = await call('agent.wait_until_ready', { agentId: worker.agentId, timeoutMs: 30000 });
    }
    assert.equal(ready.reason, 'ready', 'Startup readiness was not established; this harness never approves prompts');
    if (!group) {
      const setup = await call('supervision.create', { name: `live-${cli}`, members: [{ agentId: worker.agentId }] });
      assert.equal(setup.monitoringReady, true, JSON.stringify(setup.setupErrors));
      group = setup.group;
    }
    // Start the waiter process before replacing membership. Deterministic tests prove
    // the stricter ordering where the waiter has already read the empty group.
    const wake = await call('event.wake_command', { groupId: group.groupId });
    active = arm(wake.command, wake.stateDir, group.groupId);
    if (round === 2) {
      const setup = await call('supervision.update', {
        groupId: group.groupId,
        expectedRevision: group.revision,
        members: [{ agentId: worker.agentId }],
      });
      assert.equal(setup.monitoringReady, true, JSON.stringify(setup.setupErrors));
      group = setup.group;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await call('agent.send', {
          agentId: worker.agentId,
          text: plan
            ? 'Plan-only hook smoke test in this scratch directory. Propose adding one sentence to README.md without editing it, then call ExitPlanMode to request approval. Do not run commands or access anything outside this directory.'
            : `Hook supervision smoke test. Do not use tools, edit files, or access external services. Reply with the concatenation of TERM_DAD_SUPERVISION_ and ROUND_${round}_OK.`,
        });
        break;
      } catch (error) {
        if (attempt >= 2 || !String(error).includes('WORKER_BUSY')) throw error;
        const ready = await call('agent.wait_until_ready', { agentId: worker.agentId, timeoutMs: 30000 });
        assert.equal(ready.reason, 'ready', 'Worker needs input or transport recovery; no task was resent');
      }
    }
    const result = await active.done;
    active = undefined;
    assert.equal(result.status, 'event', `Expected an actual event, got ${result.status}`);
    assert.equal(result.event.agentId, worker.agentId);
    let push = (await call('push.status', { agentId: worker.agentId })).worker;
    if (!push.proven) {
      // A terminal-derived ready event can precede the asynchronous CLI callback.
      await call('event.wait_for_event', {
        agentIds: [worker.agentId],
        afterSequence: result.event.sequence,
        freshOnly: false,
        timeoutMs: 10000,
      });
      push = (await call('push.status', { agentId: worker.agentId })).worker;
    }
    assert.equal(push.proven, true, 'Configured hooks are not evidence of actual delivery');
    assert.ok(push.deliveries.count > 0);
    if (plan) assert.equal(result.event.kind, 'plan_approval', 'Expected the ExitPlanMode approval hook');
    else {
      assert.ok(['ready', 'worker_report'].includes(result.event.kind), `Worker requested input: ${result.event.kind}`);
      await call('agent.wait_for_text', {
        agentId: worker.agentId,
        text: `TERM_DAD_SUPERVISION_ROUND_${round}_OK`,
        timeoutMs: 30000,
      });
    }
    console.log(
      `PASS round ${round}: ${cli} event ${result.event.kind}, ${push.deliveries.count} accepted hooks; client auto-resume not asserted`,
    );
    await call('event.acknowledge', { ids: [result.event.id] });
    const emptied = await call('supervision.update', {
      groupId: group.groupId,
      expectedRevision: group.revision,
      members: [],
    });
    group = emptied.group;
    await session.stopAgent(worker.agentId, worker.paneId);
  }
  group = (await call('supervision.close', { groupId: group.groupId, expectedRevision: group.revision })).group;
  console.log('PASS: two worker rounds, unchanged group waiter command, dynamic membership and real hook evidence');
} finally {
  active?.stop();
  if (group?.state === 'active')
    await call('supervision.close', { groupId: group.groupId, expectedRevision: group.revision }).catch(() => {});
  await session.dispose();
  if (scratch && !retainScratch && session.owned.size === 0) await rm(scratch, { recursive: true, force: true });
}
