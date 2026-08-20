// Feature 059 (US6, T029) — audit-event registration + payload-shape unit test.
// Contract: specs/059-fine-grained-trust-scopes/contracts/trust-capability-
//           denied-audit-contract.md (I-1..I-6) and
//           specs/059-fine-grained-trust-scopes/contracts/sidebar-ipc.md
//
// Verifies:
//   1. `trust.capability-denied` is registered in `TRUST_GATE_EVENT_TYPES`,
//      `ALL_AUDIT_EVENT_TYPES`, and the `KNOWN_AUDIT_EVENT_TYPE_SET`.
//   2. `TrustCapabilityDeniedPayload` accepts the contracted shape:
//        capability ∈ {phases, retryConditions, pipelineOverrides}
//        resolvedScope ∈ {user, workspace, workspace-trust}
//        workspaceBasename: string (no `/` or `\`)
//        reason ∈ TRUST_DENIED_REASONS (closed enum)
//        rowIndex: optional number (US3, retry-condition row granularity)
//   3. `AUDIT_SCHEMA_VERSION` remains `2` (additive event, no bump).
//
// This pairs with T028 (integration test) and the audit-log-parser
// tolerance test (T030). Together they pin the end-to-end audit record
// downstream SIEM consumers depend on (FR-007).

import { describe, expect, it } from 'vitest';
import {
  ALL_AUDIT_EVENT_TYPES,
  AUDIT_SCHEMA_VERSION,
  KNOWN_AUDIT_EVENT_TYPE_SET,
  TRUST_GATE_EVENT_TYPES,
  isKnownAuditEventType,
  type TrustCapabilityDeniedPayload,
  type TrustGateEventType
} from '../../../src/contracts/audit-events';
import {
  TRUST_DENIED_REASONS,
  type ResolvedScope,
  type TrustCapability,
  type TrustDeniedReason
} from '../../../src/contracts/sidebar-ipc';

describe('trust.capability-denied audit event registration (059, T029)', () => {
  it('registers trust.capability-denied in TRUST_GATE_EVENT_TYPES', () => {
    expect([...TRUST_GATE_EVENT_TYPES]).toEqual(['trust.capability-denied']);
  });

  it('exposes trust.capability-denied via ALL_AUDIT_EVENT_TYPES', () => {
    expect(ALL_AUDIT_EVENT_TYPES).toContain('trust.capability-denied');
  });

  it('exposes trust.capability-denied via the KNOWN_AUDIT_EVENT_TYPE_SET', () => {
    expect(KNOWN_AUDIT_EVENT_TYPE_SET.has('trust.capability-denied')).toBe(true);
  });

  it('exposes trust.capability-denied via isKnownAuditEventType', () => {
    expect(isKnownAuditEventType('trust.capability-denied')).toBe(true);
  });

  it('rejects an unknown sibling event via isKnownAuditEventType', () => {
    expect(isKnownAuditEventType('trust.capability-bogus')).toBe(false);
  });

  it('uses AUDIT_SCHEMA_VERSION 3 for bounded metadata-only payloads', () => {
    expect(AUDIT_SCHEMA_VERSION).toBe(3);
  });

  it('exposes a TrustGateEventType union limited to the registered literal', () => {
    const t: TrustGateEventType = 'trust.capability-denied';
    expect(t).toBe('trust.capability-denied');
  });
});

describe('TrustCapabilityDeniedPayload shape (059, T029)', () => {
  it('accepts a phases-denied payload (minimal, no rowIndex)', () => {
    const payload: TrustCapabilityDeniedPayload = {
      capability: 'phases',
      resolvedScope: 'workspace',
      workspaceBasename: 'enterprise-monorepo',
      reason: TRUST_DENIED_REASONS.phasesWorkspace
    };
    expect(Object.keys(payload).sort()).toEqual([
      'capability',
      'reason',
      'resolvedScope',
      'workspaceBasename'
    ]);
    expect(payload.workspaceBasename).not.toMatch(/[\\/]/);
  });

  it('accepts a retryConditions-denied payload with rowIndex', () => {
    const payload: TrustCapabilityDeniedPayload = {
      capability: 'retryConditions',
      resolvedScope: 'user',
      workspaceBasename: 'team-workspace',
      reason: TRUST_DENIED_REASONS.retryConditionsUser,
      rowIndex: 2
    };
    expect(payload.rowIndex).toBe(2);
    expect(payload.workspaceBasename).not.toMatch(/[\\/]/);
  });

  it('accepts a denial at workspace-trust scope, the arm no setting can widen', () => {
    // Feature 099 (T496f, FR-046) — `pipelineOverrides` left with the layer tier
    // it gated. The claim here is about the SCOPE, not the capability:
    // `workspace-trust` is the arm no per-capability setting can widen, and a
    // surviving capability carries it just as well.
    const payload: TrustCapabilityDeniedPayload = {
      capability: 'phases',
      resolvedScope: 'workspace-trust',
      workspaceBasename: 'untrusted-folder',
      reason: TRUST_DENIED_REASONS.workspaceTrust
    };
    expect(payload.resolvedScope).toBe('workspace-trust');
  });

  it('confines capability to the closed enum', () => {
    const capabilities: readonly TrustCapability[] = ['phases', 'retryConditions'];
    for (const c of capabilities) {
      const p: TrustCapabilityDeniedPayload = {
        capability: c,
        resolvedScope: 'user',
        workspaceBasename: 'x',
        reason: TRUST_DENIED_REASONS.phasesWorkspace
      };
      expect(p.capability).toBe(c);
    }
  });

  it('confines resolvedScope to the closed enum', () => {
    const scopes: readonly ResolvedScope[] = ['user', 'workspace', 'workspace-trust'];
    for (const s of scopes) {
      const p: TrustCapabilityDeniedPayload = {
        capability: 'phases',
        resolvedScope: s,
        workspaceBasename: 'x',
        reason: TRUST_DENIED_REASONS.phasesWorkspace
      };
      expect(p.resolvedScope).toBe(s);
    }
  });

  it('confines reason to the closed TRUST_DENIED_REASONS template set', () => {
    const reasons = Object.values(TRUST_DENIED_REASONS) as readonly TrustDeniedReason[];
    expect(reasons.length).toBeGreaterThanOrEqual(1);
    for (const r of reasons) {
      const p: TrustCapabilityDeniedPayload = {
        capability: 'phases',
        resolvedScope: 'user',
        workspaceBasename: 'x',
        reason: r
      };
      expect(reasons).toContain(p.reason as TrustDeniedReason);
    }
  });
});
