import assert from 'node:assert/strict';
import { LiveSession, parentPane } from './live-support.js';
const session = await LiveSession.create();
try {
  const baseline = await session.call('terminal.list');
  const parent = parentPane(baseline.panes);
  const worker = await session.spawnAgent({
    name: 'inventory-smoke',
    cli: 'shell',
    paneId: parent,
    command: ['bash', '--noprofile', '--norc', '-i'],
  });
  const second = await session.spawnPane({ paneId: parent, command: ['bash', '--noprofile', '--norc', '-i'] });
  console.log(`Created test panes ${worker.paneId}, ${second} in ${baseline.selected.key}`);
  await session.call('agent.wait_until_idle', { agentId: worker.agentId, timeoutMs: 15000 });
  await session.call('agent.send', {
    agentId: worker.agentId,
    text: "printf '\\nTD_%s   \\n  indented\\n' INVENTORY_OK",
  });
  await session.call('agent.wait_for_text', { agentId: worker.agentId, text: 'TD_INVENTORY_OK', timeoutMs: 15000 });
  const compact = await session.call('terminal.read', { paneId: worker.paneId, lines: 15 });
  const raw = await session.call('terminal.read', { paneId: worker.paneId, lines: 15, raw: true });
  assert.ok(compact.length <= raw.length);
  assert.ok(compact.split('\n').every((line: string) => line === line.trimEnd()));
  const listing = await session.call('terminal.list', { activity: 'inspect', workspace: 'inspect', verbose: true });
  const ours = listing.panes.find((p: any) => p.pane_id === worker.paneId);
  assert.equal(ours.session.type, 'shell');
  assert.equal(ours.activity.source, 'screen_classifier');
  assert.ok(ours.workspace.status);
  assert.ok(ours.raw.size);
  const result = await session.call('terminal.close', {
    paneIds: [worker.paneId, second],
    expectedInstanceKey: baseline.selected.key,
  });
  for (const item of result.results) {
    assert.equal(item.outcome, 'closed');
    session.owned.delete(item.paneId);
  }
  const after = await session.call('terminal.list');
  for (const pane of baseline.panes)
    assert.ok(
      after.panes.some((p: any) => p.pane_id === pane.pane_id),
      'Pre-existing pane retained',
    );
  assert.ok(!after.panes.some((p: any) => p.pane_id === worker.paneId || p.pane_id === second));
  console.log(
    'PASS: compact/raw reads, session/activity/workspace context, batch close and pre-existing pane preservation',
  );
} finally {
  await session.dispose();
}
