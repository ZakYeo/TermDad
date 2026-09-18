import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TaskBoard } from '../src/tasks.js';
import { MemoryTaskStorage } from '../src/task-storage.js';
import { withTaskAssignments, withWorkerTasks } from '../src/task-workers.js';
const input = { boardId: 'repo', title: 'Task', goal: 'Goal' };

test('assignment reads distinguish attached, detached, missing, unknown and unassigned without mutating tasks', async () => {
  const board = new TaskBoard(new MemoryTaskStorage()),
    agentId = randomUUID(),
    task = await board.create({ ...input, assignedAgentId: agentId });
  for (const attachment of ['attached', 'detached']) {
    const [view] = await withTaskAssignments([task], async () => [
      { agentId, name: 'worker', paneId: 7, attachment, recoveryReason: null },
    ]);
    assert.equal(view.assignment?.availability, attachment);
    assert.equal(view.assignment?.paneId, 7);
  }
  assert.equal((await withTaskAssignments([task], async () => []))[0].assignment?.availability, 'missing');
  assert.equal(
    (
      await withTaskAssignments([task], async () => {
        throw new Error('private transport failure');
      })
    )[0].assignment?.availability,
    'unknown',
  );
  assert.equal((await board.get(task.id)).assignedAgentId, agentId);
  assert.equal((await board.get(task.id)).status, 'todo');
  const unassigned = await board.create(input);
  assert.equal(
    (
      await withTaskAssignments([unassigned], async () => {
        throw new Error('must not lookup');
      })
    )[0].assignment,
    null,
  );
});

test('worker summaries stay bounded, preserve priority and omit archived tasks; corruption does not hide workers', async () => {
  const storage = new MemoryTaskStorage(),
    board = new TaskBoard(storage),
    agentId = randomUUID();
  for (let i = 0; i < 22; i++) await board.create({ ...input, title: `Task ${i}`, assignedAgentId: agentId });
  const urgent = await board.create({ ...input, title: 'Urgent', priority: 'urgent', assignedAgentId: agentId });
  const archived = await board.create({ ...input, assignedAgentId: agentId });
  await board.archive({ taskId: archived.id, expectedRevision: 1, archived: true });
  const [worker, empty] = await withWorkerTasks([{ agentId }, { agentId: randomUUID() }], board);
  assert.equal(worker.tasks.total, 23);
  assert.equal(worker.tasks.items.length, 20);
  assert.equal(worker.tasks.truncated, true);
  assert.equal(worker.tasks.items[0].id, urgent.id);
  assert.equal(empty.tasks.total, 0);
  const failing = new TaskBoard({
    transaction: async () => {
      throw new Error('TASK_STATE_CORRUPT');
    },
  });
  const [preserved] = await withWorkerTasks([{ agentId }], failing);
  assert.equal(preserved.agentId, agentId);
  assert.equal(preserved.tasks.total, null);
  assert.match(preserved.tasks.storageWarning ?? '', /TASK_SUMMARY_UNAVAILABLE/);
});
