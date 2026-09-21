import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { rm } from 'node:fs/promises';

const clients = new Map<string, Set<Client>>();
export function trackClient(directory: string, client: Client) {
  const group = clients.get(directory) ?? new Set<Client>();
  group.add(client);
  clients.set(directory, group);
}
/** Stop asynchronous writers before removing their state directory, even after an assertion fails. */
export async function cleanupClients(directory: string) {
  const results = await Promise.allSettled([...(clients.get(directory) ?? [])].map((client) => client.close()));
  clients.delete(directory);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  await rm(directory, { recursive: true, force: true });
}
