import test from 'node:test';
import assert from 'node:assert/strict';
import { WezTermBackend, parsePanes, sendKeys, execute } from '../src/backend.js';
import { Agents, hashOutput, delta } from '../src/agents.js';
import { adapters } from '../src/adapters.js';
const pane = { pane_id: 7, tab_id: 3, window_id: 1, title: 'test', cwd: 'file:///tmp', size: { rows: 24, cols: 80 } };
function fake() {
  let text = '$ ',
    alive = true;
  const calls: any[] = [];
  const backend = new WezTermBackend(async (args, input) => {
    calls.push({ args, input });
    switch (args[0]) {
      case 'list':
        return JSON.stringify(alive ? [pane] : []);
      case 'spawn':
        return '7\n';
      case 'get-text':
        return text;
      case 'kill-pane':
        alive = false;
        return '';
      default:
        return '';
    }
  });
  return { backend, calls, setText: (s: string) => (text = s), remove: () => (alive = false) };
}
test('parses real-shaped CLI JSON preserving extra metadata and rejects malformed IDs', () => {
  assert.equal(parsePanes(JSON.stringify([pane]))[0].size.cols, 80);
  for (const v of ['{}', 'oops', JSON.stringify([{ ...pane, pane_id: -1 }])]) assert.throws(() => parsePanes(v));
});
test('argv construction preserves commands literally, text travels through stdin', async () => {
  const f = fake();
  await f.backend.spawn({ cwd: '/tmp/a b', command: ['echo', '$(touch /tmp/nope)'], paneId: 0 });
  assert.deepEqual(f.calls[0].args, [
    'spawn',
    '--pane-id',
    '0',
    '--cwd',
    '/tmp/a b',
    '--',
    'echo',
    '$(touch /tmp/nope)',
  ]);
  await f.backend.sendText(7, 'hello\nworld');
  assert.equal(f.calls[1].input, 'hello\nworld');
  assert.equal(f.calls[1].args.includes('--no-paste'), false);
});
test('validation prevents invalid IDs, NUL commands, conflicting spawn targets and unknown keys', async () => {
  const f = fake();
  await assert.rejects(f.backend.read(-1));
  await assert.rejects(f.backend.spawn({ command: ['a\0b'] }));
  await assert.rejects(f.backend.spawn({ newWindow: true, windowId: 1 }));
  await assert.rejects(sendKeys(f.backend, 7, ['ENTER', 'BOGUS']));
  assert.equal(f.calls.length, 0);
});
test('raw key transport emits control bytes without bracketed paste', async () => {
  const f = fake();
  await sendKeys(f.backend, 7, ['UP', 'CTRL_C', 'ENTER']);
  assert.deepEqual(
    f.calls.map((c) => c.input),
    ['\x1b[A', '\x03', '\r'],
  );
  assert.ok(f.calls.every((c) => c.args.includes('--no-paste')));
});
test('hash and delta distinguish identical, appended and rewritten terminal output', () => {
  assert.equal(hashOutput('a'), hashOutput('a'));
  assert.notEqual(hashOutput('a'), hashOutput('b'));
  assert.deepEqual(delta('a', 'ab'), { mode: 'append', text: 'b' });
  assert.equal(delta('a', 'a').mode, 'unchanged');
  assert.equal(delta('abc', 'xyz').mode, 'replace');
});
test('agent mapping, observations, bounded history and disappeared pane cleanup', async () => {
  const f = fake(),
    a = new Agents(f.backend);
  const s = await a.spawn({ name: 'worker', cli: 'shell' });
  assert.equal(a.get('worker').paneId, 7);
  const first = await a.observe(s.agentId);
  const second = await a.observe(s.agentId, first.observationId);
  assert.equal(second.recentText, '');
  assert.equal(second.activity, 'unchanged');
  f.setText('$ hello');
  const third = await a.observe(s.agentId, second.observationId);
  assert.equal(third.outputMode, 'append');
  for (let i = 0; i < 20; i++) await a.observe(s.agentId);
  assert.equal(a.get(s.agentId).history.length, 16);
  assert.equal((await a.observe(s.agentId, first.observationId)).deltaReset, true);
  f.remove();
  await assert.rejects(a.observe(s.agentId), /disappeared/);
  assert.equal(a.records.size, 0);
});
test('silent output does not count as idle; waits time out; failed spawn retains recoverable mapping', async () => {
  const f = fake();
  f.setText('long command with no output');
  const a = new Agents(f.backend);
  await assert.rejects(a.spawn({ name: 'worker', cli: 'claude', prompt: 'hello', timeoutMs: 10 }), /prompt NOT sent/);
  assert.equal(a.records.size, 1);
  assert.equal((await a.observe('worker')).status, 'UNKNOWN');
  assert.equal(f.calls.filter((c) => c.args[0] === 'send-text').length, 0);
});
test('permission detection prevents automatic initial prompt submission', async () => {
  const f = fake();
  f.setText('Do you trust this folder?\n❯ Yes');
  const a = new Agents(f.backend);
  await assert.rejects(a.spawn({ name: 'p', cli: 'claude', prompt: 'do work', timeoutMs: 5 }));
  assert.equal((await a.observe('p')).status, 'WAITING_FOR_PERMISSION');
});
test('state classifier examples', () => {
  const fixtures: [string, string, string][] = [
    ['claude', 'Claude Code\n❯ ', 'READY_FOR_PROMPT'],
    ['claude', 'Thinking… (esc to interrupt)', 'WORKING'],
    ['claude', 'Do you want to proceed?\n❯ 1. Yes', 'WAITING_FOR_PERMISSION'],
    ['codex', 'OpenAI Codex\n› Explain this codebase', 'READY_FOR_PROMPT'],
    ['codex', 'Working (4s • esc to interrupt)', 'WORKING'],
    ['codex', 'Choose an option\nEnter to select', 'WAITING_FOR_QUESTION'],
    ['claude', 'API Error: invalid token', 'ERROR'],
    ['shell', 'running silently', 'UNKNOWN'],
  ];
  for (const [cli, text, status] of fixtures) assert.equal(adapters[cli].classify(text), status);
});
test('subprocess timeout and execution errors are diagnostic', async () => {
  await assert.rejects(execute(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], undefined, 20), /timed out/);
  await assert.rejects(execute('/nonexistent/term-dad', []), /Check executable/);
});

test('captured Claude UI fixture recognizes prompt despite non-blocking local hook error', async () => {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(new URL('./fixtures/claude-ready.txt', import.meta.url), 'utf8');
  assert.equal(adapters.claude.classify(text), 'READY_FOR_PROMPT');
});

test('captured Codex UI fixture recognizes the current interactive prompt', async () => {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(new URL('./fixtures/codex-ready.txt', import.meta.url), 'utf8');
  assert.equal(adapters.codex.classify(text), 'READY_FOR_PROMPT');
});
test('concurrent spawns reserve names before backend completion', async () => {
  const f = fake(),
    a = new Agents(f.backend);
  const first = a.spawn({ name: 'same', cli: 'shell' });
  await assert.rejects(a.spawn({ name: 'same', cli: 'shell' }), /already exists/);
  await first;
});
test('unchanged pre-input prompt does not become ready merely because time passes', async () => {
  const f = fake(),
    a = new Agents(f.backend);
  await a.spawn({ name: 'worker', cli: 'shell' });
  await a.send('worker', 'hello');
  a.get('worker').lastInputAt = Date.now() - 2000;
  assert.equal((await a.observe('worker')).status, 'WORKING');
});

test('Codex gets the bundled worker skill with its initial task only, even with custom argv', async () => {
  const f = fake(),
    a = new Agents(f.backend);
  f.setText('OpenAI Codex\n› Explain this codebase');
  await a.spawn({ name: 'worker', cli: 'codex', command: ['custom-codex'], prompt: 'Implement the feature.' });
  await a.send('worker', 'Report your results.');
  const inputs = f.calls.filter((c) => c.args[0] === 'send-text' && !c.args.includes('--no-paste')).map((c) => c.input);
  assert.match(inputs[0], /^\$term-dad-worker\n/);
  assert.match(inputs[0], /Own investigation, design, implementation and verification/);
  assert.ok(inputs[0].endsWith('Assignment:\nImplement the feature.'));
  assert.equal(inputs[1], 'Report your results.');
});

test('Codex initialization is deferred without a task, and survives an onboarding timeout', async () => {
  for (const withPrompt of [false, true]) {
    const f = fake(),
      a = new Agents(f.backend);
    f.setText('Do you trust this folder?\n❯ Yes');
    const spawn = a.spawn({ name: 'worker', cli: 'codex', ...(withPrompt ? { prompt: 'task', timeoutMs: 1 } : {}) });
    if (withPrompt) await assert.rejects(spawn, /prompt NOT sent/);
    else await spawn;
    assert.equal(f.calls.filter((c) => c.args[0] === 'send-text').length, 0);
    f.setText('OpenAI Codex\n› Explain this codebase');
    await a.send('worker', 'Start now.');
    const input = f.calls.find((c) => c.args[0] === 'send-text').input;
    assert.match(input, /^\$term-dad-worker\n/);
    assert.ok(input.endsWith('Start now.'));
  }
});

test('failed Codex input keeps initialization pending; concurrent input cannot duplicate it', async () => {
  const f = fake(),
    a = new Agents(f.backend);
  await a.spawn({ name: 'worker', cli: 'codex' });
  const send = f.backend.sendText.bind(f.backend);
  let fail = true;
  f.backend.sendText = async (...args) => {
    if (fail) {
      fail = false;
      throw new Error('transport failure');
    }
    return send(...args);
  };
  await assert.rejects(a.send('worker', 'task'), /WORKER_DELIVERY_UNCERTAIN/);
  await assert.rejects(a.send('worker', 'retry without recovery'), /WORKER_DELIVERY_UNCERTAIN/);
  await a.reattach({ agentId: 'worker', paneId: 7, acknowledgeUncertainDelivery: true, workerSkillInitialized: false });
  assert.notEqual(a.get('worker').workerSkillSent, true);
  const first = a.send('worker', 'retry');
  await assert.rejects(a.send(a.get('worker').agentId, 'concurrent'), /Input already in progress/);
  await first;
  await a.send('worker', 'follow-up');
  const inputs = f.calls.filter((c) => c.args[0] === 'send-text' && !c.args.includes('--no-paste')).map((c) => c.input);
  assert.match(inputs[0], /^\$term-dad-worker\n/);
  assert.equal(inputs[1], 'follow-up');
});

test('Claude and shell task text stays literal', async () => {
  for (const cli of ['claude', 'shell'] as const) {
    const f = fake(),
      a = new Agents(f.backend);
    await a.spawn({ name: 'worker', cli });
    await a.send('worker', 'literal task');
    assert.equal(f.calls.find((c) => c.args[0] === 'send-text').input, 'literal task');
  }
});
test('spawn options are validated once, with one coded conflict error, for the backend and for managed workers', async () => {
  const f = fake();
  await assert.rejects(f.backend.spawn({ newWindow: true, windowId: 1 }), /ARGUMENT_CONFLICT/);
  await assert.rejects(f.backend.split({ paneId: 7, newWindow: true, windowId: 1 } as any), /ARGUMENT_CONFLICT/);
  const agents = new Agents(f.backend);
  await assert.rejects(agents.spawn({ name: 'w', cli: 'shell', newWindow: true, windowId: 1 }), /ARGUMENT_CONFLICT/);
  await assert.rejects(agents.spawn({ name: 'w', cli: 'shell', command: '"unterminated' }), /quote/);
  assert.equal(f.calls.length, 0, 'nothing reaches the terminal before the options are valid');
  // A one-line command is split exactly once and reaches WezTerm as argv.
  await agents.spawn({ name: 'w', cli: 'shell', command: `printf '%s' "a b"` });
  assert.deepEqual(f.calls[0].args.slice(-4), ['--', 'printf', '%s', 'a b']);
});
