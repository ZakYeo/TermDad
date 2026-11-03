import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { CodexAdapter } from '../src/adapters.js';

const captured = readFileSync(new URL('./fixtures/codex-trust-resolved-scrollback.txt', import.meta.url), 'utf8');
const adapter = new CodexAdapter();

test('captured approved trust menu above the Codex startup banner no longer blocks readiness', () => {
  assert.ok(captured.includes('Trust this folder?'));
  assert.ok(captured.includes('› Ask Codex to do anything'));
  assert.equal(adapter.classify(captured), 'READY_FOR_PROMPT');
  assert.equal(adapter.classify(captured.replace('>_ OpenAI Codex', '│ >_ OpenAI Codex')), 'READY_FOR_PROMPT');
});

test('current-frame permission, authentication and question still override an old ready prompt', () => {
  for (const [screen, state] of [
    ['Trust this folder?\n› 1. Trust and continue', 'WAITING_FOR_PERMISSION'],
    ['Would you like to proceed?\n› 1. Yes', 'WAITING_FOR_PERMISSION'],
    ['Sign in to continue', 'WAITING_FOR_AUTHENTICATION'],
    ['Choose an option\n› 1. First', 'WAITING_FOR_QUESTION'],
  ])
    assert.equal(adapter.classify(`${captured}\n${screen}`), state);
});

test('a generic prompt alone never clears a permission request', () => {
  assert.equal(adapter.classify('Trust this folder?\n› Ask Codex to do anything'), 'WAITING_FOR_PERMISSION');
  assert.equal(adapter.classify('Trust this folder?\n› 1. Trust and continue'), 'WAITING_FOR_PERMISSION');
});

test('startup banner alone is not readiness and current-frame work/errors remain observable', () => {
  const banner = 'Trust this folder?\n>_ OpenAI Codex (v0.166.0)';
  assert.equal(adapter.classify(banner), 'UNKNOWN');
  assert.equal(adapter.classify(`${banner}\nWorking (2s • esc to interrupt)`), 'WORKING');
  assert.equal(adapter.classify(`${banner}\nAPI Error: failed`), 'ERROR');
});
