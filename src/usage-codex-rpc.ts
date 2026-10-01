import { spawn } from 'node:child_process';
import type { UsageConfig } from './usage-model.js';

/** Read-only app-server exchange: never creates a thread, logs in, or asks for inference. */
export async function readCodexQuota(config: UsageConfig): Promise<{ account: unknown; limits: unknown }> {
  const args = [...(config.profile ? ['--profile', config.profile] : []), 'app-server'];
  const child = spawn(process.env.TERM_DAD_CODEX_EXECUTABLE || 'codex', args, {
    env: { ...process.env, ...(config.codexHome ? { CODEX_HOME: config.codexHome } : {}) },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let buffer = '',
    bytes = 0,
    nextId = 0;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let failure: Error | undefined;
  const fail = (message: string) => {
    failure = new Error(message);
    for (const p of pending.values()) p.reject(failure);
    pending.clear();
  };
  const deadline = setTimeout(() => {
    fail('USAGE_REFRESH_TIMEOUT');
    child.kill('SIGKILL');
  }, 15_000);
  child.on('error', () => fail('USAGE_CODEX_UNAVAILABLE'));
  child.on('exit', () => fail('USAGE_CODEX_EXITED'));
  child.stdin.on('error', () => fail('USAGE_CODEX_UNAVAILABLE'));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data: string) => {
    bytes += Buffer.byteLength(data);
    if (bytes > 1024 * 1024) {
      fail('USAGE_RESPONSE_TOO_LARGE');
      child.kill('SIGKILL');
      return;
    }
    buffer += data;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        const p = pending.get(message.id);
        if (!p) continue;
        pending.delete(message.id);
        if (message.error) p.reject(new Error('USAGE_PROVIDER_ERROR'));
        else p.resolve(message.result);
      } catch {
        fail('USAGE_PROVIDER_INVALID');
      }
    }
  });
  const request = (method: string, params?: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + '\n');
    });
  try {
    await request('initialize', { clientInfo: { name: 'term_dad_usage', version: '0.1.0' } });
    child.stdin.write('{"method":"initialized"}\n');
    const account = await request('account/read', { refreshToken: false });
    const limits = await request('account/rateLimits/read');
    return { account, limits };
  } finally {
    clearTimeout(deadline);
    child.stdin.end();
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}
