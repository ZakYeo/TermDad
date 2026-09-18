import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { LiveSession, parentPane } from './live-support.js';
const session = await LiveSession.create({
  TERM_DAD_SCREENSHOT_COMMAND: process.env.TERM_DAD_SCREENSHOT_COMMAND ?? `${process.cwd()}/scripts/screenshot-wsl`,
});
try {
  const paneId = await session.spawnPane({
    paneId: parentPane(await session.call('terminal.list')),
    command: ['bash', '--noprofile', '--norc', '-i'],
  });
  const result = await session.client.callTool({ name: 'terminal.screenshot', arguments: { paneId } });
  assert.ok(!result.isError, JSON.stringify(result));
  const image = (result.content as any)[0];
  assert.equal(image.type, 'image');
  assert.equal(image.mimeType, 'image/png');
  const png = Buffer.from(image.data, 'base64');
  assert.ok(png.readUInt32BE(16) > 500);
  assert.ok(png.readUInt32BE(20) > 300, 'Must capture more than minimized title bar');
  await writeFile('/tmp/term-dad-screenshot.png', png);
  console.log('PASS: MCP screenshot PNG', png.length, 'bytes → /tmp/term-dad-screenshot.png');
} finally {
  await session.dispose();
}
