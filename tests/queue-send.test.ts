import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Agents } from '../src/agents.js';
import { WezTermBackend } from '../src/backend.js';
import { MemoryWorkerStorage } from '../src/worker-storage.js';
test('queued steering retains the turn and attempt and refuses approval screens', async () => {
  let text = '❯';
  const inputs: string[] = [];
  const storage = new MemoryWorkerStorage();
  const agents = new Agents(
    new WezTermBackend(
      async (args, input) => {
        if (args[0] === 'list')
          return JSON.stringify([
            { pane_id: 7, tab_id: 1, window_id: 1, title: 'w', cwd: '/tmp', size: { rows: 24, cols: 80 } },
          ]);
        if (args[0] === 'get-text') return text;
        if (input) inputs.push(input);
        return '';
      },
      async () => ({ key: 'k', endpoint: 'e' }),
    ),
    storage,
  );
  const worker = await agents.adopt({ name: 'w', paneId: 7, cli: 'claude', workerSkillInitialized: true });
  const attempt = { taskId: randomUUID(), attemptId: randomUUID() };
  const first = await agents.send(worker.agentId, 'work', attempt);
  text = 'Working… esc to interrupt';
  const queued = await agents.send(worker.agentId, 'correction', undefined, true, 'queue');
  assert.equal(queued.turnId, first.turnId);
  assert.equal(queued.consumption, 'unknown');
  assert.deepEqual((await agents.resolve(worker.agentId)).turn?.attempt, attempt);
  text = 'Do you want to proceed?\n❯';
  const count = inputs.length;
  await assert.rejects(agents.send(worker.agentId, 'yes', undefined, true, 'queue'), /WORKER_INPUT_REQUIRED/);
  assert.equal(inputs.length, count);
  await agents.send(worker.agentId, 'answer', undefined, false);
  assert.deepEqual((await agents.resolve(worker.agentId)).turn?.attempt, attempt);
  await agents.send(worker.agentId, 'detached', null, false);
  assert.equal((await agents.resolve(worker.agentId)).turn?.attempt, undefined);
  await agents.close();
});
