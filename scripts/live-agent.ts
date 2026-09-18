import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { LiveSession, parentPane } from './live-support.js';
const cli = process.argv[2] ?? 'claude';
if (!['claude', 'codex'].includes(cli)) throw new Error('Choose claude or codex');
const session = await LiveSession.create(),
  call = session.call;
try {
  const a = await session.spawnAgent({
    name: `term-dad-${cli}-e2e`,
    cli,
    paneId: parentPane(await call('terminal.list')),
    cwd: process.cwd(),
  });
  const agentId = a.agentId;
  await call('agent.wait_until_idle', { agentId, timeoutMs: 30000 });
  await call('agent.send', {
    agentId,
    text: 'This is a terminal transport smoke test. Do not use tools or modify files. Reply with just the concatenation of TERM_DAD_ and FIRST_OK.',
  });
  const first = await call('agent.wait_for_text', { agentId, text: 'TERM_DAD_FIRST_OK', timeoutMs: 120000 });
  await call('agent.wait_until_idle', { agentId, timeoutMs: 30000 });
  if (process.env.TERM_DAD_CAPTURE_FIXTURES === '1')
    await writeFile(
      `tests/fixtures/${cli}-ready.txt`,
      first.recentText
        .split('\n')
        .map((line: string) => line.trimEnd())
        .join('\n') + '\n',
    );
  await call('agent.send', {
    agentId,
    text: 'Follow-up transport test in this same session. Do not use tools. Reply with just the concatenation of TERM_DAD_ and SECOND_OK.',
  });
  const second = await call('agent.wait_for_text', { agentId, text: 'TERM_DAD_SECOND_OK', timeoutMs: 120000 });
  assert.equal(second.paneId, a.paneId);
  await call('agent.wait_until_idle', { agentId, timeoutMs: 30000 });
  await call('agent.interrupt', { agentId });
  await session.stopAgent(agentId, a.paneId);
  console.log(
    `PASS: real ${cli} MCP spawn, readiness, initial answer, follow-up in same session, observe, interrupt and verified pane cleanup`,
  );
} finally {
  await session.dispose();
}
