import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { isWaitTool, type Metric } from './telemetry.js';

const metricSchema = z
  .object({
    version: z.literal(1),
    session: z.uuid(),
    timestamp: z.iso.datetime(),
    tool: z
      .string()
      .regex(/^[a-z_.]+$/)
      .max(80),
    durationMs: z.number().finite().nonnegative(),
    outcome: z.enum(['success', 'error', 'timeout']),
    errorCode: z
      .string()
      .regex(/^[A-Z_]+$/)
      .max(80)
      .optional(),
    responseBytes: z.number().int().nonnegative(),
    textBytes: z.number().int().nonnegative(),
  })
  .strict();
export const percentile = (sorted: number[], fraction: number) =>
  sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
export function summarize(metrics: Metric[]) {
  const groups = new Map<string, Metric[]>();
  for (const metric of metrics) {
    const group = groups.get(metric.tool) ?? [];
    group.push(metric);
    groups.set(metric.tool, group);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tool, rows]) => {
      const durations = rows.map((row) => row.durationMs).sort((a, b) => a - b);
      return {
        tool,
        wait: isWaitTool(tool),
        count: rows.length,
        errors: rows.filter((row) => row.outcome === 'error').length,
        timeouts: rows.filter((row) => row.outcome === 'timeout').length,
        medianMs: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        maxMs: durations.at(-1)!,
        accumulatedMs: durations.reduce((sum, n) => sum + n, 0),
        responseBytes: rows.reduce((sum, row) => sum + row.responseBytes, 0),
        textBytes: rows.reduce((sum, row) => sum + row.textBytes, 0),
        maxResponseBytes: rows.reduce((max, row) => Math.max(max, row.responseBytes), 0),
      };
    });
}
export function readTelemetry(directory: string) {
  return readTelemetryRecords(directory, (value) => metricSchema.parse(value));
}
/** Both diagnostic streams share the same bounded file-reading and loss accounting. */
export async function readTelemetryRecords<T>(directory: string, parse: (value: unknown) => T) {
  const metrics: T[] = [];
  let invalidLines = 0,
    droppedRecords = 0,
    bytesRead = 0,
    truncated = false;
  const entries = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  const files = (
    await Promise.all(
      entries
        .filter((name) => /^\d+-[0-9a-f-]{36}\.(active|\d+)\.jsonl$/.test(name))
        .map(async (name) => ({ name, info: await stat(join(directory, name)).catch(() => undefined) })),
    )
  )
    .filter((file) => file.info)
    .sort((a, b) => b.info!.mtimeMs - a.info!.mtimeMs);
  let filesRead = 0;
  for (const { name, info } of files) {
    if (filesRead >= 128 || bytesRead + info!.size > 128 * 1024 * 1024 || metrics.length >= 500000) {
      truncated = true;
      break;
    }
    if (info!.size > 5 * 1024 * 1024) {
      invalidLines++;
      continue;
    }
    const stream = createReadStream(join(directory, name));
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (metrics.length >= 500000) {
          truncated = true;
          break;
        }
        try {
          if (line.length > 4096) throw new Error('Oversized record');
          const value = JSON.parse(line);
          if (
            value.version === 1 &&
            value.kind === 'dropped' &&
            Number.isSafeInteger(value.count) &&
            value.count >= 0
          ) {
            droppedRecords += value.count;
          } else metrics.push(parse(value));
        } catch {
          invalidLines++;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    } finally {
      lines.close();
      stream.destroy();
    }
    filesRead++;
    bytesRead += info!.size;
  }
  return { metrics, filesRead, invalidLines, droppedRecords, truncated };
}
export function reportMarkdown(report: {
  tools: ReturnType<typeof summarize>;
  droppedRecords: number;
  invalidLines: number;
  truncated: boolean;
}) {
  const lines = [
    '# Tool telemetry report',
    '',
    'Durations are server request handling times, excluding response delivery and metric recording. Wait tools include intentional waiting. Accumulated time sums concurrent calls; it is not session wall time. Bytes are serialized MCP result bodies, not tokens or full JSON-RPC frames.',
    '',
    `Dropped records: ${report.droppedRecords}; invalid/incomplete lines: ${report.invalidLines}; report input truncated: ${report.truncated}. Retention excludes older data; unavailable storage can lose records beyond the persisted drop count.`,
    '',
    '| Tool | Calls | Errors | Timeouts | Median ms | p95 ms | Max ms | Accumulated ms | Response bytes | Text bytes |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const row of report.tools)
    lines.push(
      `| ${row.tool}${row.wait ? ' (wait)' : ''} | ${row.count} | ${row.errors} | ${row.timeouts} | ${row.medianMs.toFixed(3)} | ${row.p95Ms.toFixed(3)} | ${row.maxMs.toFixed(3)} | ${row.accumulatedMs.toFixed(3)} | ${row.responseBytes} | ${row.textBytes} |`,
    );
  return lines.join('\n') + '\n';
}
