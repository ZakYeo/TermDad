export type Status =
  | 'STARTING'
  | 'WORKING'
  | 'PARKED_BACKGROUND'
  | 'READY_FOR_PROMPT'
  | 'WAITING_FOR_PERMISSION'
  | 'WAITING_FOR_QUESTION'
  | 'WAITING_FOR_AUTHENTICATION'
  | 'RUNNING_EXTERNAL_COMMAND'
  | 'IDLE'
  | 'ERROR'
  | 'UNKNOWN';
export interface InteractiveAgentAdapter {
  cli: string;
  classify(text: string): Status;
}
function common(text: string): Status | undefined {
  if (
    /(?:do you trust|trust this folder|allow .*\?|permission required|would you like to proceed|Do you want to proceed)/i.test(
      text,
    )
  )
    return 'WAITING_FOR_PERMISSION';
  if (
    /(?:sign in to continue|log in to continue|please (?:sign|log) in|enter (?:your )?(?:authentication|verification) code|open .+ to (?:sign|log) in)/i.test(
      text,
    )
  )
    return 'WAITING_FOR_AUTHENTICATION';
  if (/(?:^\s*(?:select an option|choose an option|Which [^\n?]+\?)\s*$|Enter to select)/im.test(text))
    return 'WAITING_FOR_QUESTION';
  if (/(?:not logged in|authentication failed|failed to connect|command not found|API Error:)/i.test(text))
    return 'ERROR';
}
export class ClaudeCodeAdapter implements InteractiveAgentAdapter {
  cli = 'claude';
  classify(text: string): Status {
    const t = text.split('\n').slice(-25).join('\n');
    return (
      common(t) ??
      (claudeBackground(t) ? 'PARKED_BACKGROUND' : undefined) ??
      (/(?:esc to interrupt|ctrl\+c to interrupt|Thinking…|Working…)/i.test(t)
        ? 'WORKING'
        : /(?:^|\n)\s*[❯>]\s*[^\n]*$/m.test(t)
          ? 'READY_FOR_PROMPT'
          : 'UNKNOWN')
    );
  }
}
export class CodexAdapter implements InteractiveAgentAdapter {
  cli = 'codex';
  classify(text: string): Status {
    const lines = text.split('\n').slice(-25);
    // Codex prints its startup banner after folder trust is resolved. WezTerm
    // can retain the earlier trust menu above it, especially after pane splits.
    // Ignore only text before that explicit frame boundary, never permission
    // text within the current frame or merely before an arbitrary prompt marker.
    let banner = -1;
    for (let index = 0; index < lines.length; index++) {
      if (/^\s*(?:│\s*)?>_ OpenAI Codex \(v\d+\.\d+\.\d+[^)]*\)/.test(lines[index])) banner = index;
    }
    const t = lines.slice(banner < 0 ? 0 : banner).join('\n');
    return (
      common(t) ??
      (/(?:esc to interrupt|Working \(|Thinking)/i.test(t)
        ? 'WORKING'
        : /(?:^|\n)\s*›[^\n]*$/m.test(t)
          ? 'READY_FOR_PROMPT'
          : 'UNKNOWN')
    );
  }
}
export class ShellAdapter implements InteractiveAgentAdapter {
  cli = 'shell';
  classify(text: string): Status {
    return /(?:^|\n)[^\n]*[$#❯>]\s*$/.test(text.trimEnd()) ? 'READY_FOR_PROMPT' : 'UNKNOWN';
  }
}
export const adapters: Record<string, InteractiveAgentAdapter> = {
  claude: new ClaudeCodeAdapter(),
  codex: new CodexAdapter(),
  shell: new ShellAdapter(),
};

/** Only footer-like complete lines count, never quoted prose in the reply. */
export function claudeBackground(text: string): boolean {
  return text
    .split('\n')
    .slice(-8)
    .some((line) =>
      /^\s*(?:⏵⏵[^\n]*·\s*)?(?:[1-9]\d* shells? still running|Waiting for [1-9]\d* background agents?|←\s*[1-9]\d* agents?)(?:\s*[·|].*)?\s*$/i.test(
        line,
      ),
    );
}
