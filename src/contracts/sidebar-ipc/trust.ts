// Closed, host-authored reason templates ensure no operator-controlled text
// reaches trust-denial audit payloads.
export const TRUST_DENIED_REASONS = {
  workspaceTrust:
    'Workspace is not trusted; per-capability scopes cannot widen workspace trust.',
  phasesWorkspace: 'allowCustomPhases is false at workspace scope.',
  phasesUser: 'allowCustomPhases is false at user scope.',
  retryConditionsWorkspace:
    'allowCustomRetryConditions is false at workspace scope.',
  retryConditionsUser: 'allowCustomRetryConditions is false at user scope.'
} as const;

// Feature 099 (T492, FR-046) — two capabilities left with the layer tier they
// gated. `allowPipelineOverrides` and `allowWorkflowOverrides` answered "may this
// layer redefine what that one declares", and with one layer there is nothing to
// redefine. The two that remain are keyed on document CONTENT — a custom Phase
// body, a custom retry-condition expression — which the collapse does not touch.
export type TrustCapability = 'phases' | 'retryConditions';
export type ResolvedScope = 'user' | 'workspace' | 'workspace-trust';
export type TrustDeniedReason =
  (typeof TRUST_DENIED_REASONS)[keyof typeof TRUST_DENIED_REASONS];

export interface TrustDeniedError {
  readonly kind: 'trust-denied';
  readonly capability: TrustCapability;
  readonly resolvedScope: ResolvedScope;
  readonly rowIndex?: number;
  readonly reason: TrustDeniedReason;
}
