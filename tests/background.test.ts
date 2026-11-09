import test from 'node:test';
import assert from 'node:assert/strict';
import { adapters } from '../src/adapters.js';
import { observeInteraction } from '../src/interaction.js';
test('Claude background footers suppress readiness but never permission precedence', () => {
  for (const footer of [
    '1 shell still running',
    '2 shells still running',
    'Waiting for 1 background agent',
    '← 1 agent',
  ]) {
    assert.equal(adapters.claude.classify(`Reply\n❯\n${footer}`), 'PARKED_BACKGROUND');
    assert.equal(adapters.claude.classify(`Do you want to proceed?\n❯\n${footer}`), 'WAITING_FOR_PERMISSION');
  }
  assert.equal(adapters.claude.classify('Reply\n❯'), 'READY_FOR_PROMPT');
  assert.equal(adapters.claude.classify('The log says "1 shell still running"\n❯'), 'READY_FOR_PROMPT');
  assert.equal(
    adapters.claude.classify('1 shell still running\n' + 'old output\n'.repeat(10) + '❯'),
    'READY_FOR_PROMPT',
  );
  assert.equal(observeInteraction({}, 'PARKED_BACKGROUND', '', null).readyForPrompt, false);
});

test('worker reports require the current turn and retain claims separately from readiness', async () => {
  const { Agents } = await import('../src/agents.js');
  const { WezTermBackend } = await import('../src/backend.js');
  const { MemoryWorkerStorage } = await import('../src/worker-storage.js');
  let screen = '❯';
  const storage = new MemoryWorkerStorage();
  const agents = new Agents(
    new WezTermBackend(
      async (args) =>
        args[0] === 'list'
          ? JSON.stringify([
              { pane_id: 7, tab_id: 1, window_id: 1, title: 'w', cwd: '/tmp', size: { rows: 24, cols: 80 } },
            ])
          : args[0] === 'get-text'
            ? screen
            : '',
      async () => ({ key: 'k', endpoint: 'e' }),
    ),
    storage,
  );
  const worker = await agents.adopt({ name: 'w', paneId: 7, cli: 'claude' });
  const sent = await agents.send(worker.agentId, 'work');
  await storage.transaction(true, (s) => {
    s.workers[0].lastInputAt = 0;
    return { state: s, result: null };
  });
  screen = 'Reply\n❯';
  await agents.recordReport(worker.agentId, {
    turnId: sent.turnId,
    state: 'parked_background',
    summary: 'tests running',
    references: [],
    checks: [],
  });
  assert.equal((await agents.observe(worker.agentId)).status, 'PARKED_BACKGROUND');
  await agents.recordReport(worker.agentId, {
    turnId: sent.turnId,
    state: 'awaiting_parent',
    summary: 'choose path',
    references: [],
    checks: [],
  });
  assert.equal((await agents.observe(worker.agentId)).inputRequest?.kind, 'question');
  await agents.noteInputActivity(worker.agentId);
  assert.equal((await agents.observe(worker.agentId)).workerReport, null);
  await assert.rejects(
    agents.recordReport(worker.agentId, {
      turnId: '00000000-0000-4000-8000-000000000000',
      state: 'done',
      summary: 'stale',
      references: [],
      checks: [],
    }),
    /WORKER_REPORT_STALE/,
  );
  await agents.close();
});
