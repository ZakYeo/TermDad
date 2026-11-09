import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { TaskBoard } from '../src/tasks.js';
import { MemoryTaskStorage } from '../src/task-storage.js';
const input = () => ({
  agentId: randomUUID(),
  idempotencyKey: 'once',
  task: { boardId: 'b', title: 'Task', goal: 'Goal' },
  text: 'work',
});
test('concurrent dispatch retries prepare one task and submit once', async () => {
  const board = new TaskBoard(new MemoryTaskStorage()),
    args = input();
  let calls = 0;
  const submit = async () => {
    calls++;
    return { turnId: randomUUID() };
  };
  const results = await Promise.all([board.dispatch(args, submit), board.dispatch(args, submit)]);
  assert.equal(calls, 1);
  assert.equal(results[0].id, results[1].id);
  const repeated = await board.dispatch(args, submit);
  assert.equal(repeated.dispatch!.status, 'submitted');
  assert.equal(calls, 1);
  await assert.rejects(board.dispatch({ ...args, text: 'different' }, submit), /KEY_CONFLICT/);
  assert.equal((await board.list()).total, 1);
});
test('uncertain delivery survives restart and is never retried', async () => {
  const storage = new MemoryTaskStorage(),
    board = new TaskBoard(storage),
    args = input();
  let calls = 0;
  const submit = async () => {
    calls++;
    throw new Error('WORKER_DELIVERY_UNCERTAIN');
  };
  const result = await board.dispatch(args, submit);
  assert.equal(result.dispatch!.status, 'uncertain');
  const restarted = new TaskBoard(storage);
  assert.equal((await restarted.dispatch(args, submit)).dispatch!.status, 'uncertain');
  assert.equal(calls, 1);
});
test('readiness refusal retains a prepared task and records no submission', async () => {
  const board = new TaskBoard(new MemoryTaskStorage());
  const result = await board.dispatch(input(), async () => {
    throw new Error('WORKER_NOT_READY');
  });
  assert.equal(result.dispatch!.status, 'not_submitted');
  assert.ok(result.currentAttemptId);
});
