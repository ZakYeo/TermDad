import test from 'node:test';
import assert from 'node:assert/strict';
import { closePanes } from '../src/terminal-close.js';
import { WezTermBackend } from '../src/backend.js';
function fixture() {
  let key = 'one';
  const alive = new Set([1, 2, 3]);
  const closed: number[] = [];
  const backend = new WezTermBackend(
    async (args) => {
      if (args[0] === 'list')
        return JSON.stringify(
          [...alive].map((id) => ({
            pane_id: id,
            tab_id: 1,
            window_id: 1,
            title: '',
            cwd: '',
            size: { rows: 1, cols: 1 },
          })),
        );
      if (args[0] === 'kill-pane') {
        const id = Number(args.at(-1));
        closed.push(id);
        alive.delete(id);
      }
      return '';
    },
    async () => ({ endpoint: key, key }),
  );
  return {
    backend,
    alive,
    closed,
    change: () => {
      key = 'other';
    },
  };
}
test('batch validates all targets before closing and reports already-gone panes', async () => {
  const f = fixture();
  for (const ids of [[], [1, 1], [1, -1], Array.from({ length: 101 }, (_, i) => i)])
    await assert.rejects(
      closePanes(f.backend, ids, 'one', async () => {}),
      /ARGUMENT_INVALID/,
    );
  await assert.rejects(
    closePanes(f.backend, [1], 'wrong', async () => {}),
    /IDENTITY_MISMATCH/,
  );
  assert.deepEqual(f.closed, []);
  assert.deepEqual((await closePanes(f.backend, [1, 9], 'one', async () => {})).results, [
    { paneId: 1, outcome: 'closed' },
    { paneId: 9, outcome: 'already_gone' },
  ]);
  assert.deepEqual([...f.alive], [2, 3]);
});
test('identity change stops remaining closes and reconciliation failure cannot hide a successful close', async () => {
  const f = fixture();
  const result = await closePanes(f.backend, [1, 2, 3], 'one', async () => {
    f.change();
    throw new Error('journal unavailable');
  });
  assert.deepEqual(
    result.results.map((r) => r.outcome),
    ['closed', 'skipped', 'skipped'],
  );
  assert.ok(result.results[0].note);
  assert.deepEqual(f.closed, [1]);
});
test('a failed close/list never invents disappearance and does not block independent targets', async () => {
  const f = fixture();
  const close = f.backend.close.bind(f.backend);
  f.backend.close = async (id) => {
    if (id === 1) throw new Error('transport failed');
    await close(id);
  };
  const result = await closePanes(f.backend, [1, 2], 'one', async () => {});
  assert.deepEqual(
    result.results.map((r) => r.outcome),
    ['failed', 'closed'],
  );
  assert.ok(f.alive.has(1));
});
