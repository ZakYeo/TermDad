#!/usr/bin/env node
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import { pushKinds, type PushKind } from './ingress.js';
import { readCredential } from './push-credentials.js';

// Codex reports its own lifecycle; only the kinds Term Dad models are forwarded.
const codexKinds: Record<string, PushKind> = {
  'agent-turn-complete': 'ready',
  'agent-approval-request': 'input_required',
  'session-end': 'session_ended',
};
const flag = (argv: string[], name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

export type NotifyTarget = { credentialPath: string } | { socketPath: string; token: string };
export interface NotifyRequest {
  target: NotifyTarget;
  kind: PushKind;
}

/** Which event this invocation reports, or nothing when the CLI's event is not modelled. */
export function notifyKind(argv: string[], stdin: string): PushKind | undefined {
  let kind = flag(argv, '--kind') as PushKind | undefined;
  if (argv.includes('--codex')) {
    const payload = argv.at(-1);
    let type: unknown;
    for (const candidate of [payload, stdin]) {
      try {
        type = JSON.parse(candidate ?? '')?.type;
      } catch {}
      if (type) break;
    }
    return codexKinds[String(type)];
  }
  if (!kind || !pushKinds.includes(kind))
    throw new Error(`term-dad-notify: --kind must be one of ${pushKinds.join(', ')}`);
  return kind;
}
/**
 * A credential path wins over inline flags, so a worker whose argv somehow carries both can
 * never authenticate with a revoked token. Inline flags remain supported because a worker
 * launched by an earlier build has them baked in for the rest of its life.
 */
export function notifyTarget(argv: string[]): NotifyTarget {
  const credentialPath = flag(argv, '--credential');
  if (credentialPath) return { credentialPath };
  const socketPath = flag(argv, '--socket'),
    token = flag(argv, '--token');
  if (!socketPath) throw new Error('term-dad-notify: --socket <path> or --credential <path> is required');
  if (!token) throw new Error('term-dad-notify: --token <value> is required');
  return { socketPath, token };
}
/**
 * Synchronous and pure. The kind is resolved first, so an unmodelled event stays silent
 * without touching the filesystem even when the credential is gone.
 */
export function notifyRequest(argv: string[], stdin: string): NotifyRequest | undefined {
  const kind = notifyKind(argv, stdin);
  if (!kind) return undefined;
  return { target: notifyTarget(argv), kind };
}
/** The one filesystem read, at fire time, so a re-keyed credential is picked up with no relaunch. */
export async function resolveRequest(request: NotifyRequest) {
  const { socketPath, token } =
    'credentialPath' in request.target ? await readCredential(request.target.credentialPath) : request.target;
  return { socketPath, line: JSON.stringify({ token, kind: request.kind }) };
}

/** One request, one reply, bounded: a hook must never block the worker it runs in. */
export function sendPush(socketPath: string, line: string, timeoutMs = 5000) {
  return new Promise<unknown>((resolve, reject) => {
    const client = connect(socketPath);
    let reply = '';
    const fail = (e: unknown) => {
      client.destroy();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    client.setTimeout(timeoutMs, () => fail(new Error('term-dad-notify: timed out')));
    client.setEncoding('utf8');
    client.on('error', fail);
    client.on('data', (chunk) => {
      reply += chunk;
    });
    client.on('close', () => {
      try {
        resolve(JSON.parse(reply.trim() || '{}'));
      } catch {
        reject(new Error('term-dad-notify: unreadable reply'));
      }
    });
    client.end(line + '\n');
  });
}

// pathToFileURL, not string concatenation: a path with a space or a percent sign must still match.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stdin = process.stdin.isTTY
    ? ''
    : await new Promise<string>((resolve) => {
        let text = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => {
          text += c;
        });
        process.stdin.on('end', () => resolve(text));
        setTimeout(() => resolve(text), 1000).unref();
      });
  try {
    const request = notifyRequest(process.argv.slice(2), stdin);
    // Hooks run inside the worker: an unmodelled event, an unreadable credential or an absent
    // server must stay silent and non-fatal, never blocking or breaking the worker it runs in.
    if (request) {
      const { socketPath, line } = await resolveRequest(request);
      await sendPush(socketPath, line);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
  }
  process.exit(0);
}
