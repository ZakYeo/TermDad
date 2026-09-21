import { execFileSync } from 'node:child_process';
import { release } from 'node:os';

/** Metadata failure must not prevent an incomplete benchmark from saving its evidence. */
export function benchmarkEnvironment() {
  let commit = 'unavailable',
    workingTree = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    workingTree = execFileSync('git', ['status', '--short'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
      ? 'modified'
      : 'clean';
  } catch {
    /* Sandboxed or non-checkout execution still produces a report. */
  }
  return {
    generatedAt: new Date().toISOString(),
    commit,
    workingTree,
    node: process.version,
    platform: process.platform,
    release: release(),
    arch: process.arch,
  };
}
