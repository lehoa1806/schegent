// Closed, host-authored reason templates ensure no operator-controlled text
// reaches trust-denial audit payloads.
export const TRUST_DENIED_REASONS = {
  workspaceTrust:
    'Workspace is not trusted; per-capability scopes cannot widen workspace trust.',
  phasesWorkspace: 'allowCustomPhases is false at workspace scope.',
  phasesUser: 'allowCustomPhases is false at user scope.',
  retryConditionsWorkspace:
    'allowCustomRetryConditions is false at workspace scope.',
  retryConditionsUser: 'allowCustomRetryConditions is false at user scope.',
  pipelineOverridesWorkspace:
    'allowPipelineOverrides is false at workspace scope.',
  pipelineOverridesUser: 'allowPipelineOverrides is false at user scope.',
  workflowOverridesWorkspace:
    'allowWorkflowOverrides is false at workspace scope.',
  workflowOverridesUser: 'allowWorkflowOverrides is false at user scope.'
} as const;

export type TrustCapability =
  | 'phases'
  | 'retryConditions'
  | 'pipelineOverrides'
  | 'workflowOverrides';
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
