import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { CodedError, codeOf, hasCode } from '../src/errors.js';
import { toolCall } from '../src/tool-result.js';

test('CodedError carries its code and keeps the CODE: detail message shape', () => {
  const e = new CodedError('WORKER_BUSY', 'input already in progress');
  assert.equal(e.code, 'WORKER_BUSY');
  assert.equal(e.message, 'WORKER_BUSY: input already in progress');
  assert.equal(new CodedError('EVENT_QUEUE_CLOSED').message, 'EVENT_QUEUE_CLOSED');
  assert.ok(e instanceof Error);
});
test('codeOf reads an explicit code first and falls back to the leading token of a CODE: message', () => {
  assert.equal(codeOf(new CodedError('A_B', 'x')), 'A_B');
  assert.equal(codeOf(new Error('WORKER_STORAGE_BUSY: lock held')), 'WORKER_STORAGE_BUSY');
  assert.equal(codeOf(new Error('Pane 7 disappeared')), undefined, 'a prose message has no code');
  assert.equal(codeOf('WORKER_BUSY'), undefined, 'only errors carry codes');
  assert.ok(hasCode(new Error('WORKER_BUSY: x'), 'WORKER_STORAGE_BUSY', 'WORKER_BUSY'));
  assert.ok(!hasCode(new Error('WORKER_BUSYNESS: x'), 'WORKER_BUSY'), 'a prefix match is not a code match');
});
test('toolCall serialises results, reports errors as isError text and names the invalid argument', async () => {
  assert.deepEqual(await toolCall('t.ok', async () => ({ a: 1 })), { content: [{ type: 'text', text: '{"a":1}' }] });
  assert.deepEqual(await toolCall('t.void', async () => undefined), {
    content: [{ type: 'text', text: '{"ok":true}' }],
  });
  const failed = await toolCall('t.fail', async () => {
    throw new Error('WORKER_BUSY: retry');
  });
  assert.equal(failed.isError, true);
  assert.equal(failed.content[0].text, 'WORKER_BUSY: retry');
  const invalid = await toolCall(
    't.invalid',
    async () => {
      z.object({ taskId: z.uuid() }).parse({ taskId: 'nope' });
    },
    { invalid: 'TASK_INPUT_INVALID' },
  );
  assert.equal(invalid.isError, true);
  assert.match(
    invalid.content[0].text,
    /^TASK_INPUT_INVALID: taskId: /,
    'the code is kept and the offending field is named',
  );
  const thrown = await toolCall('t.string', async () => {
    throw 'plain';
  });
  assert.equal(thrown.content[0].text, 't.string failed');
});
