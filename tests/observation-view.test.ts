import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { observationView } from '../src/observation-view.js';
test('captured Claude output extracts reply without echoed brief, hook chatter or footer', async () => {
  const screen = await readFile(new URL('./fixtures/claude-ready.txt', import.meta.url), 'utf8');
  const result = observationView(screen, 'claude', 'last_reply');
  assert.equal(result.text, 'TERM_DAD_FIRST_OK');
  assert.equal(result.fallback, false);
  assert.ok(result.text.length < screen.length / 10);
});
test('multiline replies preserve prose and plan paths remain references', () => {
  const screen =
    '❯ private brief\n⏺ First line\n  Second line\n✻ Worked for 2m\n❯\nPlan file: ~/.claude/plans/example.md';
  const result = observationView(screen, 'claude', 'last_reply');
  assert.equal(result.text, 'First line\n  Second line');
  assert.equal(result.planPath, '~/.claude/plans/example.md');
  assert.equal(observationView('truncated reply', 'claude', 'last_reply').fallback, true);
  assert.equal(observationView(screen, 'codex', 'last_reply').fallback, true);
});
