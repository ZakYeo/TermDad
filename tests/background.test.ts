import test from 'node:test';
import assert from 'node:assert/strict';
import { adapters } from '../src/adapters.js';
import { observeInteraction } from '../src/interaction.js';
test('Claude background footers suppress readiness but never permission precedence', () => {
  for (const footer of [
    '1 shell still running',
    '2 shells still running',
    'Waiting for 1 background agent',
    '← 1 agent',
  ]) {
    assert.equal(adapters.claude.classify(`Reply\n❯\n${footer}`), 'PARKED_BACKGROUND');
    assert.equal(adapters.claude.classify(`Do you want to proceed?\n❯\n${footer}`), 'WAITING_FOR_PERMISSION');
  }
  assert.equal(adapters.claude.classify('Reply\n❯'), 'READY_FOR_PROMPT');
  assert.equal(adapters.claude.classify('The log says "1 shell still running"\n❯'), 'READY_FOR_PROMPT');
  assert.equal(
    adapters.claude.classify('1 shell still running\n' + 'old output\n'.repeat(10) + '❯'),
    'READY_FOR_PROMPT',
  );
  assert.equal(observeInteraction({}, 'PARKED_BACKGROUND', '', null).readyForPrompt, false);
});
