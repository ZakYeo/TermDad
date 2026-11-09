import test from 'node:test';
import assert from 'node:assert/strict';
import { retryUsageRead } from '../src/usage-read.js';
test('quota read retries only storage contention and stays bounded', async () => {
  let calls = 0;
  const sleeps: number[] = [];
  assert.equal(
    await retryUsageRead(
      async () => {
        if (++calls < 3) throw new Error('USAGE_STORAGE_BUSY');
        return 'ok';
      },
      async (ms) => {
        sleeps.push(ms);
      },
    ),
    'ok',
  );
  assert.deepEqual(sleeps, [50, 100]);
  calls = 0;
  await assert.rejects(
    retryUsageRead(
      async () => {
        calls++;
        throw new Error('USAGE_STATE_CORRUPT');
      },
      async () => {},
    ),
    /CORRUPT/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    retryUsageRead(
      async () => {
        calls++;
        throw new Error('USAGE_STORAGE_BUSY');
      },
      async () => {},
    ),
    /BUSY/,
  );
  assert.equal(calls, 6);
});
