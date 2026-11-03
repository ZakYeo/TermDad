import assert from 'node:assert/strict';
import test from 'node:test';
import { createStartGate } from '../demo/start-gate.js';

test('demo execution remains pending until Start and can begin only once', async () => {
  const gate = createStartGate();
  let launches = 0;
  const execution = gate.wait.then((started) => {
    if (started) launches++;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(launches, 0);
  gate.start();
  gate.start();
  await execution;
  assert.equal(launches, 1);
});

test('cancelled demo never launches on a late Start click', async () => {
  const gate = createStartGate();
  gate.cancel();
  gate.start();
  assert.equal(await gate.wait, false);
});
