import { defaultUsageProviders } from '../src/usage-providers.js';
import { configureUsageSchema } from '../src/usage-model.js';

// Opt-in read-only account check. Never starts a model turn or prints account identifiers.
const provider = process.argv[2];
if (provider !== 'codex') throw new Error('Usage: npm run test:usage -- codex');
try {
  const source = defaultUsageProviders().codex;
  const observation = await source.read!(configureUsageSchema.parse({ accountRef: 'live-check', provider }));
  if (!observation.windows.length) throw new Error('No account quota windows returned');
  console.log(
    JSON.stringify(
      {
        provider,
        source: observation.source,
        observedAt: new Date(observation.observedAt).toISOString(),
        windows: observation.windows.map(({ kind, windowSeconds, usedPercent, resetsAt }) => ({
          kind,
          windowSeconds,
          usedPercent,
          resetsAt: resetsAt === null ? null : new Date(resetsAt).toISOString(),
        })),
        supervisorControlsWorkers: true,
      },
      null,
      2,
    ),
  );
} catch {
  console.error(
    'USAGE_LIVE_FAILED: account quota read unavailable; no inference was requested. Check CLI authentication and network access.',
  );
  process.exitCode = 1;
}
