export type ObservationView = 'screen' | 'last_reply';
/** Extract only recognized reply framing; uncertainty retains the bounded screen. */
export function observationView(text: string, cli: string, view: ObservationView) {
  const planPath = text
    .split('\n')
    .filter((line) => /plan/i.test(line))
    .map((line) => line.match(/(?:^|\s)((?:~\/|\/)[^\s<>"']+\.md)(?=\s|$)/)?.[1])
    .find(Boolean);
  if (view === 'screen') return { text, planPath, fallback: false };
  if (cli !== 'claude') return { text, planPath, fallback: true };
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (
      /^\s*[●⏺]\s+/.test(lines[i]) &&
      !/^\s*[●⏺]\s+(?:Ran \d+ .*hooks?|(?:Bash|Read|Write|Edit|Task|Agent|Search|Glob|Grep)\()/i.test(lines[i])
    )
      start = i;
  }
  if (start < 0) return { text, planPath, fallback: true };
  const reply: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (
      i > start &&
      /^\s*(?:[❯>] |[❯>]$|[─━]{3}|[✻✽✶] |[●⏺] Ran \d+ .*hooks?|⏵⏵|\d+ shells? still running|Waiting for \d+ background)/.test(
        lines[i],
      )
    )
      break;
    reply.push(i === start ? lines[i].replace(/^\s*[●⏺]\s+/, '') : lines[i]);
  }
  const result = reply.join('\n').trim();
  return { text: result || text, planPath, fallback: !result };
}
