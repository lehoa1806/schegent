/**
 * FR-R6-F08 — the vocabularies, bounds and identity shapes of the recovery handoff.
 *
 * Pure types and frozen constants only. Migration 5 spells the same value lists literally
 * (its checksum covers the DDL text); `handoff-schema.test.ts` asserts the two still agree.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import type { ArtifactStoreKind } from '../artifact-lifecycle/lifecycle-types';

export const HANDOFF_MANIFEST_VERSION = 1 as const;
export const MAX_HANDOFF_MANIFEST_BYTES = 16_384 as const;
export const MAX_HANDOFF_EXPLANATION_BYTES = 65_536 as const;
export const MAX_HANDOFF_EXCLUDED_ITEMS = 32 as const;
export const MAX_HANDOFF_REFERENCES_PER_ROLE = 32 as const;
export const MAX_HANDOFF_WORKSPACE_ENTRIES = 100 as const;
export const MAX_HANDOFF_LEGACY_PROVENANCE_BYTES = 2_048 as const;

export const HANDOFF_STATES = Object.freeze([
  'preparing',
  'ready',
  'delivering',
  'acknowledged',
  'uncertain',
  'consumed',
  'superseded',
  'unsupported'
] as const);
export type HandoffState = (typeof HANDOFF_STATES)[number];

/** States after which no operation changes the handoff. */
export const CLOSED_HANDOFF_STATES: ReadonlySet<HandoffState> = new Set<HandoffState>(['consumed', 'superseded']);

export const HANDOFF_CLOSED_REASONS = Object.freeze(['delivered', 'abandoned', 'superseded'] as const);
export type HandoffClosedReason = (typeof HANDOFF_CLOSED_REASONS)[number];

export const HANDOFF_REVISION_STATUSES = Object.freeze(['draft', 'issued', 'superseded'] as const);
export type HandoffRevisionStatus = (typeof HANDOFF_REVISION_STATUSES)[number];

export const HANDOFF_REFERENCE_ROLES = Object.freeze(['validated', 'partial', 'evidence', 'checkpoint'] as const);
export type HandoffReferenceRole = (typeof HANDOFF_REFERENCE_ROLES)[number];

export const HANDOFF_PIN_STATES = Object.freeze(['pending', 'pinned', 'refused', 'released'] as const);
export type HandoffPinState = (typeof HANDOFF_PIN_STATES)[number];

export const HANDOFF_PIN_PURPOSES = Object.freeze(['pending-handoff', 'uncertain-recovery', 'paused-recovery'] as const);
export type HandoffPinPurpose = (typeof HANDOFF_PIN_PURPOSES)[number];

export const HANDOFF_RESOLUTIONS = Object.freeze([
  'available',
  'missing',
  'expired',
  'deleted',
  'unreadable',
  'changed',
  'unsupported'
] as const);
export type HandoffResolution = (typeof HANDOFF_RESOLUTIONS)[number];

export const HANDOFF_EXCLUDED_REASONS = Object.freeze([
  'policy-denied',
  'raw-transcript',
  'vendor-session-store',
  'over-limit',
  'late-fact',
  'sensitivity'
] as const);
export type HandoffExcludedReason = (typeof HANDOFF_EXCLUDED_REASONS)[number];

/** F05 store kinds a handoff may name (research R6); any other kind resolves `unsupported`. */
export const HANDOFF_ACCEPTED_STORE_KINDS: ReadonlySet<ArtifactStoreKind> = new Set<ArtifactStoreKind>([
  'checkpoint',
  'handoff-context',
  'report',
  'review-report',
  'diagnostic',
  'live-log-segment'
]);

export const DELIVERY_TRANSPORTS = Object.freeze(['acp', 'direct'] as const);
export type DeliveryTransport = (typeof DELIVERY_TRANSPORTS)[number];

export const SESSION_PLANS = Object.freeze(['load-session', 'fresh-session'] as const);
export type SessionPlanKind = (typeof SESSION_PLANS)[number];

export const SESSION_CAPABILITIES = Object.freeze(['declared', 'absent', 'unknown'] as const);
export type SessionCapability = (typeof SESSION_CAPABILITIES)[number];

export const FRESH_SESSION_REASONS = Object.freeze([
  'owner-mismatch',
  'profile-changed',
  'backend-changed',
  'capability-absent',
  'capability-unknown',
  'legacy-session',
  'uncertain-prior',
  'no-prior-session',
  'capabilities-changed'
] as const);
export type FreshSessionReason = (typeof FRESH_SESSION_REASONS)[number];

export const DELIVERY_OUTCOMES = Object.freeze(['pending', 'acknowledged', 'uncertain', 'refused'] as const);
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

export const DELIVERY_OUTCOME_REASONS = Object.freeze(['not-sent', 'restart-before-ack', 'connection-lost'] as const);
export type DeliveryOutcomeReason = (typeof DELIVERY_OUTCOME_REASONS)[number];

export const HANDOFF_DECISIONS = Object.freeze(['continue-new-attempt', 'abandon'] as const);
export type HandoffDecision = (typeof HANDOFF_DECISIONS)[number];

export const DECISION_OUTCOMES = Object.freeze(['accepted', 'refused-stale', 'refused-closed'] as const);
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

/** In refusal order (research R7): the first that applies is the one returned. */
export const REDELIVERY_REFUSALS = Object.freeze([
  'handoff-closed',
  'unsupported-version',
  'stale-revision',
  'delivery-in-flight',
  'attempt-reused',
  'direct-backend-refused',
  'new-connection-refused',
  'profile-changed-refused',
  'decision-required'
] as const);
export type RedeliveryRefusal = (typeof REDELIVERY_REFUSALS)[number];

export const NEXT_ACTIONS = Object.freeze([
  'deliver',
  'await-acknowledgement',
  'decide',
  'inspect-evidence',
  'none'
] as const);
export type NextAction = (typeof NEXT_ACTIONS)[number];

/** Codes a manifest validation can refuse with; nothing is written on any of them. */
export const MANIFEST_REFUSAL_CODES = Object.freeze([
  'invalid',
  'invalid-path',
  'invalid-ref',
  'over-limit',
  'unsupported-version'
] as const);
export type ManifestRefusalCode = (typeof MANIFEST_REFUSAL_CODES)[number];

export const HANDOFF_REFUSAL_CODES = Object.freeze([
  ...MANIFEST_REFUSAL_CODES,
  'not-found',
  'conflict',
  'required-pin-refused',
  'capture-failed',
  'context-missing',
  'context-invalid',
  ...REDELIVERY_REFUSALS.filter((code) => code !== 'unsupported-version')
] as const);
export type HandoffRefusalCode = (typeof HANDOFF_REFUSAL_CODES)[number];

/** The four identities a handoff identity derives from (research R2); each an F05 opaque id. */
export interface HandoffLineage {
  readonly workspaceId: string;
  readonly rootExecutionId: string;
  readonly invocationId: string;
  readonly sourceAttemptId: string;
}

/** The facts a revision was prepared from (research R3). */
export interface HandoffCutoff {
  readonly executionRevision: string;
  readonly usageRevision: number;
  readonly factCutoffMs: number;
}

/** The owner a session belongs to; a session id is never carried across owners (R8). */
export interface SessionOwner {
  readonly agentId: string;
  readonly accountScope: string;
}

export type SessionPlan =
  | { readonly plan: 'load-session'; readonly sessionId: string }
  | { readonly plan: 'fresh-session'; readonly reason: FreshSessionReason };

/** `live` keeps an artifact; `unresolved` keeps it too (F05 rule); only `settled` lets it go. */
export type HandoffOwnerResolution = 'live' | 'settled' | 'unresolved';

export type HandoffRefusal<Code extends string = HandoffRefusalCode> = {
  readonly ok: false;
  readonly code: Code;
};
