import { createHash, randomUUID } from 'node:crypto';
import type { Status } from './adapters.js';

export type InputKind = 'permission' | 'question' | 'authentication';
export interface InputRequest {
  id: string;
  kind: InputKind;
  turnId: string | null;
  detectedAt: string;
  state: 'pending' | 'uncertain';
  provenance: 'heuristic';
}
export interface InteractionState {
  request?: InputRequest;
  fingerprint?: string;
}
export function inputKind(status: Status): InputKind | null {
  return status === 'WAITING_FOR_PERMISSION'
    ? 'permission'
    : status === 'WAITING_FOR_QUESTION'
      ? 'question'
      : status === 'WAITING_FOR_AUTHENTICATION'
        ? 'authentication'
        : null;
}
/** Observation-only state. Sending input cannot resolve a request. */
export function observeInteraction(state: InteractionState, status: Status, text: string, turnId: string | null) {
  const kind = inputKind(status);
  if (kind) {
    const fingerprint = createHash('sha256')
      .update(`${kind}\0${turnId}\0${text.split('\n').slice(-25).join('\n')}`)
      .digest('hex');
    if (state.fingerprint !== fingerprint) {
      state.request = {
        id: randomUUID(),
        kind,
        turnId,
        detectedAt: new Date().toISOString(),
        state: 'pending',
        provenance: 'heuristic',
      };
      state.fingerprint = fingerprint;
    } else if (state.request) state.request.state = 'pending';
  } else if (status === 'WORKING' || status === 'READY_FOR_PROMPT') {
    delete state.request;
    delete state.fingerprint;
  } else if (state.request) state.request.state = 'uncertain';
  return {
    inputRequired: kind !== null,
    readyForPrompt: status === 'READY_FOR_PROMPT',
    inputRequest: state.request ? { ...state.request } : null,
  };
}
