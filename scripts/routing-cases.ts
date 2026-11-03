export type RoutingCall = { name: string; args: Record<string, unknown> };
export type RoutingCase = {
  id: string;
  prompt: string;
  required: { names: string[]; args?: Record<string, unknown> }[];
  allowed: string[];
  maxCalls: number;
};
export const routingCases: RoutingCase[] = [
  {
    id: 'inventory',
    prompt: 'Use TermDad. What tabs and panes are open?',
    required: [{ names: ['terminal.list'] }],
    allowed: ['terminal.list'],
    maxCalls: 1,
  },
  {
    id: 'dimensions',
    prompt: 'Use TermDad to list my open panes, including their dimensions.',
    required: [{ names: ['terminal.list'], args: { verbose: true } }],
    allowed: ['terminal.list'],
    maxCalls: 1,
  },
  {
    id: 'activity',
    prompt: 'Use TermDad to tell me which open panes are busy or waiting for input.',
    required: [{ names: ['terminal.list'], args: { activity: 'inspect' } }],
    allowed: ['terminal.list', 'orchestrator.status'],
    maxCalls: 2,
  },
  {
    id: 'workspace',
    prompt: 'Use TermDad to show the repository, worktree and branch for each open pane, where available.',
    required: [{ names: ['terminal.list'], args: { workspace: 'inspect' } }],
    allowed: ['terminal.list'],
    maxCalls: 1,
  },
  {
    id: 'recovery',
    prompt: 'Use TermDad to explain why saved workers are disconnected.',
    required: [{ names: ['agent.list', 'terminal.list'] }],
    allowed: ['agent.list', 'terminal.list'],
    maxCalls: 2,
  },
  {
    id: 'read',
    prompt: 'Use TermDad to read the last 15 lines on pane 7.',
    required: [{ names: ['terminal.read'], args: { paneId: 7, lines: 15 } }],
    allowed: ['terminal.read'],
    maxCalls: 1,
  },
  {
    id: 'conditional-close',
    prompt:
      'Keep the session named keep. Pane 8 works on example/project PR 42. Close pane 8 only if that PR is open and out of draft. Check using the external review tool first.',
    required: [{ names: ['terminal.list'] }, { names: ['review.lookup'] }, { names: ['terminal.close'] }],
    allowed: ['terminal.list', 'review.lookup', 'terminal.close'],
    maxCalls: 4,
  },
];
export function scoreRouting(test: RoutingCase, calls: RoutingCall[]): string[] {
  const failures: string[] = [];
  if (calls.length > test.maxCalls) failures.push('Unnecessary tool calls');
  for (const call of calls) if (!test.allowed.includes(call.name)) failures.push(`Unexpected tool: ${call.name}`);
  for (const requirement of test.required)
    if (
      !calls.some(
        (call) =>
          requirement.names.includes(call.name) &&
          Object.entries(requirement.args ?? {}).every(([key, value]) => call.args[key] === value),
      )
    )
      failures.push(`Missing required capability: ${requirement.names.join(' or ')}`);
  if (
    test.id === 'inventory' &&
    calls.some((c) => c.args.activity === 'inspect' || c.args.workspace === 'inspect' || c.args.verbose === true)
  )
    failures.push('Unnecessary inventory enrichment');
  if (
    test.id === 'recovery' &&
    !calls.some((c) => c.name === 'agent.list' || (c.name === 'terminal.list' && c.args.includeDetached === true))
  )
    failures.push('Detached details not requested');
  if (test.id === 'conditional-close') {
    const check = calls.findIndex((c) => c.name === 'review.lookup');
    for (const [index, call] of calls.entries())
      if (call.name === 'terminal.close') {
        const ids = call.args.paneIds ?? [call.args.paneId ?? call.args.id];
        if (
          !Array.isArray(ids) ||
          ids.length !== 1 ||
          ids[0] !== 8 ||
          (call.args.target && call.args.target !== 'pane')
        )
          failures.push('Protected or unspecified pane targeted');
        if (check < 0 || check > index) failures.push('Close before external verification');
      }
  }
  return failures;
}
