import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ticketDefinitions } from './runtime.js';

export interface DemoStatus {
  available: boolean;
  updatedAt: string | null;
  tickets: Array<{ id: string; title: string; state: string; description?: string }>;
  released: boolean;
  message: string;
}

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function asset(root: string, pathname: string) {
  const parts = pathname.split('/');
  if (parts.some((part) => part.startsWith('.') || part.includes('\\') || part.includes('\0'))) return null;
  const base = await realpath(root);
  const candidate = await realpath(resolve(base, pathname || 'index.html'));
  const within = relative(base, candidate);
  if (within.startsWith(`..${sep}`) || within === '..' || within.startsWith(sep)) return null;
  const type = contentTypes[extname(candidate)];
  if (!type) return null;
  const metadata = await stat(candidate);
  if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024) return null;
  return { body: await readFile(candidate), type };
}

/** Local presentation with one explicitly requested start action; no terminal input over HTTP. */
export async function startPresentation(options: {
  beforeDirectory: string;
  afterDirectory: string;
  readStatus: () => Promise<DemoStatus>;
  onStart?: () => void | Promise<void>;
}): Promise<{ url: string; close: () => Promise<void> }> {
  let status: DemoStatus = {
    available: false,
    updatedAt: null,
    tickets: [],
    released: false,
    message: 'Connecting to TermDad…',
  };
  let stopped = false;
  let execution: 'waiting' | 'starting' | 'running' | 'failed' = 'waiting';
  const startToken = randomBytes(32).toString('hex');
  const shownStatus = () =>
    options.onStart
      ? {
          ...status,
          execution,
          startToken,
          ...(execution === 'failed'
            ? { message: 'Could not start the demo. Check the launcher terminal; restart the launcher to try again.' }
            : {}),
        }
      : status;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let acquisitionTimer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    acquisitionTimer = setTimeout(() => {
      if (!stopped)
        status = { ...status, available: false, message: 'Progress observation delayed — last observation shown.' };
    }, 10000);
    try {
      const current = await options.readStatus();
      if (!stopped)
        status = {
          ...current,
          tickets: current.tickets.map((ticket) => ({
            ...ticket,
            description:
              ticket.description ??
              ticketDefinitions.find((definition) => definition.id === ticket.id)?.description ??
              '',
          })),
        };
    } catch {
      if (!stopped) status = { ...status, available: false, message: 'Progress unavailable — last observation shown.' };
    } finally {
      clearTimeout(acquisitionTimer);
      if (!stopped) timer = setTimeout(() => void refresh(), 2000);
    }
  };
  // Initial acquisition need not block the browser or shutdown on an unavailable provider.
  void refresh();
  const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url));
  let authority = '';
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'",
    );
    const fail = (code: number) => {
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(code === 404 ? 'Not found' : 'Request not allowed');
    };
    if (req.headers.host !== authority) return fail(403);
    try {
      const pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
      if (pathname === '/start' && options.onStart) {
        if (req.method !== 'POST') return fail(405);
        if (req.headers.origin !== `http://${authority}` || req.headers['x-demo-start-token'] !== startToken)
          return fail(403);
        if (stopped || execution !== 'waiting') return fail(409);
        execution = 'starting'; // Lock before invoking the callback, including across concurrent requests.
        void Promise.resolve().then(async () => {
          if (stopped) return;
          try {
            await options.onStart!();
            if (!stopped) execution = 'running';
          } catch {
            if (!stopped) execution = 'failed';
          }
        });
        res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ execution }));
        return;
      }
      if (req.method !== 'GET') return fail(405);
      if (pathname === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(shownStatus()));
        return;
      }
      let root = publicDirectory;
      let path = pathname.slice(1);
      if (pathname.startsWith('/before/')) {
        root = options.beforeDirectory;
        path = pathname.slice('/before/'.length);
      } else if (pathname.startsWith('/after/')) {
        if (!status.released || !status.available) return fail(404);
        root = options.afterDirectory;
        path = pathname.slice('/after/'.length);
      }
      const result = await asset(root, path);
      if (!result) return fail(404);
      res.writeHead(200, { 'Content-Type': result.type });
      res.end(result.body);
    } catch {
      fail(404);
    }
  });
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolveListen();
      });
    });
  } catch (error) {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(acquisitionTimer);
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Presentation did not bind a loopback port');
  authority = `127.0.0.1:${address.port}`;
  return {
    url: `http://${authority}/`,
    close: async () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(acquisitionTimer);
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
        server.closeAllConnections();
      });
    },
  };
}
