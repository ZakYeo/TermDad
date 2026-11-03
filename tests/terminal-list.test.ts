import test from 'node:test';
import assert from 'node:assert/strict';
import { compactInventory } from '../src/terminal-list.js';
import { Agents } from '../src/agents.js';
import { WezTermBackend } from '../src/backend.js';
const pane = (id: number, title = '') => ({
  pane_id: id,
  tab_id: 1,
  window_id: 1,
  title,
  cwd: 'file:///work/my-project',
  size: { rows: 20, cols: 80 },
  cursor_x: 10,
});
test('compact listing derives stable split labels, omits raw dimensions and separates detached records', async () => {
  let key = 'original';
  let reads = 0;
  const backend = new WezTermBackend(
    async (args) => {
      if (args[0] === 'list') return JSON.stringify([pane(2), pane(1, 'Shell')]);
      reads++;
      throw new Error('No screen reads permitted');
    },
    async () => ({ endpoint: 'socket', key }),
  );
  const agents = new Agents(backend);
  await agents.adopt({ name: '  ', cli: 'shell', paneId: 1 });
  let result = compactInventory(await agents.inventory());
  assert.equal(result.panes[1].label, 'Shell');
  assert.equal(result.panes[1].labelSource, 'pane_title');
  assert.equal(result.panes[1].worker?.name, '  ');
  assert.equal(result.panes[0].tabLabel, 'Shell (2 panes)');
  assert.equal(result.panes[0].label, 'my-project');
  assert.equal('raw' in result.panes[0], false);
  key = 'replacement';
  result = compactInventory(await agents.inventory());
  assert.equal(result.panes[1].worker, null);
  assert.equal(result.detached.count, 1);
  assert.equal('workers' in result.detached, false);
  const detailed = compactInventory(await agents.inventory(), { verbose: true, includeDetached: true });
  assert.equal(detailed.panes[0].raw?.cursor_x, 10);
  assert.equal(detailed.detached.workers?.length, 1);
  assert.equal(reads, 0);
});
test('real tab titles win; empty directory falls back to pane ID', () => {
  const result = compactInventory({
    selected: null,
    workers: [],
    notes: [],
    panes: [{ ...pane(4), cwd: '', tab_title: 'Actual tab' }],
  });
  assert.equal(result.panes[0].label, 'Pane 4');
  assert.equal(result.panes[0].tabLabel, 'Actual tab');
  assert.equal(result.panes[0].tabLabelSource, 'tab_title');
});

test('activity inspection is optional, bounded, text-free and tolerates one failed screen', async () => {
  let active = 0,
    peak = 0,
    reads = 0;
  const backend = new WezTermBackend(
    async (args) => {
      if (args[0] === 'list') return JSON.stringify(Array.from({ length: 7 }, (_, i) => pane(i)));
      if (args[0] === 'get-text') {
        reads++;
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        if (args.includes('6')) throw new Error('pane disappeared');
        return '$ ';
      }
      return '';
    },
    async () => ({ endpoint: 'local', key: 'local' }),
  );
  const agents = new Agents(backend);
  for (let i = 0; i < 7; i++) await agents.adopt({ name: `shell-${i}`, cli: 'shell', paneId: i });
  await agents.inventory();
  assert.equal(reads, 0);
  const result = compactInventory(await agents.inventory(true));
  assert.equal(peak, 4);
  assert.equal(reads, 7);
  assert.equal(result.panes[0].activity.status, 'READY_FOR_PROMPT');
  assert.equal(result.panes[6].activity.status, 'UNKNOWN');
  assert.equal('recentText' in result.panes[0].activity, false);
});
