import type { Pane } from './backend.js';
export type SessionContext = {
  type: 'claude' | 'codex' | 'copilot' | 'shell' | 'command' | 'unknown';
  source: 'managed_adapter' | 'foreground_process' | 'title' | 'unavailable';
  certainty: 'configured' | 'observed' | 'inferred' | 'unknown';
  note?: string;
};
export function sessionContext(pane: Pane, worker?: { cli: 'claude' | 'codex' | 'shell' }): SessionContext {
  if (worker)
    return {
      type: worker.cli,
      source: 'managed_adapter',
      certainty: 'configured',
      note: 'Configured worker adapter; not proof of the current foreground process.',
    };
  if (typeof pane.foreground_process_name === 'string' && pane.foreground_process_name.trim()) {
    const executable = pane.foreground_process_name
      .replaceAll('\\', '/')
      .split('/')
      .at(-1)!
      .toLowerCase()
      .replace(/\.exe$/, '');
    const type = ['claude', 'codex', 'copilot'].includes(executable)
      ? (executable as 'claude' | 'codex' | 'copilot')
      : ['bash', 'zsh', 'sh', 'fish', 'pwsh', 'powershell', 'cmd'].includes(executable)
        ? 'shell'
        : 'command';
    return { type, source: 'foreground_process', certainty: 'observed' };
  }
  const title = pane.title.trim().replace(/^[\u2800-\u28ff]\s*/, '');
  const match = /^(Claude(?: Code)?|Codex|GitHub Copilot)(?:\s*[-:|]|$)/i.exec(title);
  if (match)
    return {
      type: /^claude/i.test(match[1]) ? 'claude' : /^codex/i.test(match[1]) ? 'codex' : 'copilot',
      source: 'title',
      certainty: 'inferred',
    };
  return { type: 'unknown', source: 'unavailable', certainty: 'unknown' };
}
