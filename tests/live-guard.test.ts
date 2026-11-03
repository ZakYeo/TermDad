import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveGuard } from '../scripts/live-guard.js';

test('live identity remains pinned across reconnect and rejects another GUI or reused PID', () => {
  const guard = new LiveGuard('C:\\gui-sock-12');
  guard.verify({ endpoint: 'C:\\gui-sock-12', key: 'host:12:first' });
  guard.verify({ endpoint: 'C:\\gui-sock-12', key: 'host:12:first' });
  assert.throws(() => guard.verify({ endpoint: 'C:\\gui-sock-12', key: 'host:12:second' }), /identity changed/);
  assert.throws(() => guard.verify({ endpoint: 'C:\\gui-sock-13', key: 'other' }), /configured/);
  assert.throws(() => guard.verify(null), /configured/);
  assert.throws(() => new LiveGuard(undefined).verify({ endpoint: 'x', key: 'y' }), /configured/);
});
test('only owned pane and worker operations are permitted', () => {
  const guard = new LiveGuard('endpoint');
  guard.panes.add(12);
  guard.agents.add('ours');
  guard.authorize('terminal.close', { paneId: 12 });
  guard.authorize('terminal.split', { paneId: 12 });
  guard.authorize('agent.send', { agentId: 'ours' });
  for (const [name, args] of [
    ['terminal.close', { target: 'tab', id: 12 }],
    ['terminal.close', { paneIds: [12, 13] }],
    ['terminal.split', { paneId: 13 }],
    ['agent.stop', { agentId: 'theirs' }],
    ['agent.reattach', { agentId: 'ours', paneId: 13 }],
    ['terminal.select_instance', { key: 'other' }],
    ['terminal.spawn', { newWindow: true }],
    ['terminal.spawn', { paneId: 13 }],
  ] as const)
    assert.throws(() => guard.authorize(name, args));
});
