import assert from 'node:assert/strict';
import { LiveSession, parentPane } from './live-support.js';
const session = await LiveSession.create();
try {
  const panes = await session.call('terminal.list');
  assert.ok(panes.length, 'Running WezTerm GUI required');
  const parent = parentPane(panes);
  const worker = await session.spawnAgent({
    name: 'recovery-shell',
    cli: 'shell',
    paneId: parent,
    command: ['bash', '--noprofile', '--norc', '-i'],
  });
  let task = await session.call('task.create', {
    boardId: 'live-recovery',
    title: 'Verify recovered shell',
    goal: 'Preserve assignment across MCP restart',
    assignedAgentId: worker.agentId,
    acceptanceCriteria: [{ id: 'follow-up', description: 'Follow-up marker observed after restart' }],
  });
  assert.equal((await session.call('agent.list'))[0].tasks.items[0].id, task.id);
  task = await session.call('task.start_attempt', { taskId: task.id, expectedRevision: task.revision });
  await session.call('agent.wait_until_idle', { agentId: worker.agentId, timeoutMs: 15000 });
  const initialTurn = await session.call('agent.send', {
    agentId: worker.agentId,
    attempt: { taskId: task.id, attemptId: task.currentAttemptId },
    text: "printf '\\nTERM_DAD_%s\\n' BEFORE_RESTART",
  });
  const old = await session.call('agent.wait_for_text', {
    agentId: worker.agentId,
    text: 'TERM_DAD_BEFORE_RESTART',
    timeoutMs: 15000,
  });
  await session.restart();
  const savedTask = await session.call('task.get', { taskId: task.id });
  assert.equal(savedTask.assignedAgentId, worker.agentId);
  assert.equal(savedTask.assignment.availability, 'attached');
  assert.equal(savedTask.status, 'in_progress');
  const recovered = (await session.call('agent.list'))[0];
  assert.equal(recovered.agentId, worker.agentId);
  assert.equal(recovered.paneId, worker.paneId);
  assert.equal(recovered.attachment, 'attached');
  const recoveredObservation = await session.call('agent.observe', {
    agentId: worker.agentId,
    since: old.observationId,
  });
  assert.equal(recoveredObservation.deltaReset, true);
  assert.equal(recoveredObservation.turnId, initialTurn.turnId);
  const followupTurn = await session.call('agent.send', {
    agentId: worker.agentId,
    attempt: { taskId: task.id, attemptId: task.currentAttemptId },
    text: "printf '\\nTERM_DAD_%s\\n' AFTER_RESTART",
  });
  await session.call('agent.wait_for_text', {
    agentId: worker.agentId,
    text: 'TERM_DAD_AFTER_RESTART',
    timeoutMs: 15000,
  });
  task = await session.call('task.report_result', {
    taskId: task.id,
    expectedRevision: task.revision,
    attemptId: task.currentAttemptId,
    outcome: 'succeeded',
    summary: 'Follow-up marker observed after MCP restart',
    workVersion: followupTurn.turnId,
    provenance: 'supervisor_recorded',
    artifacts: [],
    checks: [],
  });
  task = await session.call('task.verify', {
    taskId: task.id,
    expectedRevision: task.revision,
    attemptId: task.currentAttemptId,
    reportId: task.latestReport.id,
    workVersion: followupTurn.turnId,
    result: 'passed',
    rationale: 'Live test observed follow-up output from the recovered shell',
    criteria: [
      { criterionId: 'follow-up', result: 'passed', evidence: ['TERM_DAD_AFTER_RESTART observed in test-owned shell'] },
    ],
    complete: true,
  });
  const paneId = await session.spawnPane({ paneId: parent, command: ['bash', '--noprofile', '--norc', '-i'] });
  const adopted = await session.call('agent.adopt', { name: 'adopted-shell', cli: 'shell', paneId });
  await session.call('agent.wait_until_idle', { agentId: adopted.agentId, timeoutMs: 15000 });
  await session.call('agent.send', { agentId: adopted.agentId, text: "printf '\\nTERM_DAD_%s\\n' ADOPTED" });
  await session.call('agent.wait_for_text', { agentId: adopted.agentId, text: 'TERM_DAD_ADOPTED', timeoutMs: 15000 });
  await session.call('agent.forget', { agentId: adopted.agentId });
  assert.ok((await session.call('terminal.list')).some((p: { pane_id: number }) => p.pane_id === paneId));
  await session.closePane(paneId);
  await session.call('agent.stop', { agentId: worker.agentId });
  session.owned.delete(worker.paneId);
  assert.deepEqual(await session.call('agent.list'), []);
  const orphan = await session.call('task.get', { taskId: task.id });
  assert.equal(orphan.status, 'done');
  assert.equal(orphan.assignment.availability, 'missing');
  assert.equal(orphan.assignedAgentId, worker.agentId);
  console.log(
    'PASS: durable task assignment, explicit completion, worker removal retention, live MCP disconnect/restart recovery, stable worker and pane IDs, fresh observation history, follow-up input, adoption, forget, stop and cleanup',
  );
} finally {
  await session.dispose();
}
