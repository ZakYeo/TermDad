import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionContext } from '../src/session-context.js';
const pane = { pane_id: 1, tab_id: 1, window_id: 1, title: '', cwd: '', size: { rows: 1, cols: 1 } };
test('session metadata separates configured adapters, observed executables and title hints', () => {
  assert.equal(sessionContext(pane, { cli: 'codex' }).certainty, 'configured');
  assert.equal(sessionContext({ ...pane, foreground_process_name: '/usr/bin/bash' }).type, 'shell');
  assert.equal(sessionContext({ ...pane, foreground_process_name: 'C:\\bin\\copilot.exe' }).type, 'copilot');
  assert.equal(sessionContext({ ...pane, title: 'GitHub Copilot | project' }).certainty, 'inferred');
  assert.equal(sessionContext({ ...pane, title: 'fix-claude-bug' }).type, 'unknown');
  assert.equal(sessionContext({ ...pane, title: '⠸ Codex - project' }).type, 'codex');
  assert.equal(sessionContext({ ...pane, foreground_process_name: '/usr/bin/node' }).type, 'command');
});
