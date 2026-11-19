// Feature 318 (FR-R7-04, FR-004) — typed refusal when the operator declines
// (or cannot be asked to acknowledge) repository-controlled agent configuration
// before an uncontained Run starts.
//
// Lives in `services/` beside `UncontainedBackendRefusedError` and
// `CapabilityNotEnforceableError` so `controller/start-failure-classification.ts`
// and `controller/phase-runner.ts` recognize it across module boundaries via a
// dedicated predicate without importing UI or activation modules.
import type { BackendRunnerKind } from '../contracts/backend-kinds';

export type AgentConfigAckRefusalReason = 'denied' | 'unavailable';

export class AgentConfigAcknowledgementRefusedError extends Error {
  public constructor(
    public readonly kind: BackendRunnerKind,
    public readonly fileCount: number,
    public readonly reason: AgentConfigAckRefusalReason = 'denied'
  ) {
    const noun = fileCount === 1 ? 'entry' : 'entries';
    const detail =
      reason === 'unavailable'
        ? 'the acknowledgement prompt could not be shown'
        : 'repository agent configuration was not acknowledged';
    super(
      `The '${kind}' uncontained run did not start because ${detail} ` +
        `(${fileCount} repository configuration ${noun} found). ` +
        'Review the repository agent configuration files and accept the prompt on the next start, ' +
        'or switch to a contained backend.'
    );
    this.name = 'AgentConfigAcknowledgementRefusedError';
  }
}

export function isAgentConfigAcknowledgementRefusal(
  error: unknown
): error is AgentConfigAcknowledgementRefusedError {
  return error instanceof AgentConfigAcknowledgementRefusedError;
}
