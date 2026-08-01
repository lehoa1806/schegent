import type { BackendRunnerKind } from '../runner/backend-runner-factory';

export interface SessionDispatchInputs {
  readonly requestedContinue: boolean;
  readonly pendingSessionReuse: boolean;
  readonly resumePrompt?: string;
  readonly persistedSessionId?: string | null;
  readonly persistedSessionRunnerKind?: BackendRunnerKind;
  readonly effectiveRunnerKind: BackendRunnerKind;
}

export interface SessionDispatchDecision {
  readonly ownsResumeSession: boolean;
  readonly isContinue: boolean;
  readonly sessionReuse: boolean;
  readonly resumeSessionId?: string;
  readonly resumePrompt?: string;
}

/**
 * Fail-closed session attachment policy shared by production dispatch and the
 * deterministic backend evaluation corpus. A persisted session may only be
 * attached to the backend kind that created it; the recovery prompt itself is
 * safe to send to a fresh session when ownership cannot be proven.
 */
export function resolveSessionDispatch(
  inputs: SessionDispatchInputs
): SessionDispatchDecision {
  const ownedResumeSessionId =
    inputs.persistedSessionRunnerKind === inputs.effectiveRunnerKind &&
    typeof inputs.persistedSessionId === 'string'
      ? inputs.persistedSessionId
      : undefined;
  const ownsResumeSession = ownedResumeSessionId !== undefined;
  const isContinue = inputs.requestedContinue && ownsResumeSession;
  const shouldResumeSession = isContinue || inputs.pendingSessionReuse;
  const resumeSessionId =
    shouldResumeSession && ownsResumeSession ? ownedResumeSessionId : undefined;
  const sessionReuse = inputs.pendingSessionReuse && !isContinue;
  const resumePrompt = inputs.requestedContinue ? inputs.resumePrompt : undefined;

  return {
    ownsResumeSession,
    isContinue,
    sessionReuse,
    ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
    ...(resumePrompt === undefined ? {} : { resumePrompt })
  };
}
