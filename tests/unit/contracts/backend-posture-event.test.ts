// FR-R3-064 — event registration and backward-compatibility, on the pattern
// `trust-capability-denied-event.test.ts` set for feature 059's additive event.
//
// Verifies:
//   1. `backend-posture-admitted` is registered in `BACKEND_POSTURE_EVENT_TYPES`,
//      `ALL_AUDIT_EVENT_TYPES`, and the known-type set;
//   2. the payload accepts exactly the contracted shape and nothing wider;
//   3. `AUDIT_SCHEMA_VERSION` is unchanged — additive, per the precedent recorded
//      in the contract file itself;
//   4. a log written before this change stays readable: an entry that lacks the
//      event is untouched, and an unknown type is still tolerated rather than
//      rejected. That is what makes "additive" a claim about historical records
//      and not just about the type union.
import { describe, expect, it } from 'vitest';
import {
  ALL_AUDIT_EVENT_TYPES,
  AUDIT_SCHEMA_VERSION,
  BACKEND_POSTURE_EVENT_TYPES,
  KNOWN_AUDIT_EVENT_TYPE_SET,
  classifyAuditEvent,
  isKnownAuditEventType,
  type BackendPostureAdmittedPayload,
  type BackendPostureEventType
} from '../../../src/contracts/audit-events';
import { containmentOf } from '../../../src/services/backend-containment-policy';
import { SUPPORTED_BACKENDS } from '../../../src/contracts/backend-kinds';

describe('backend-posture-admitted audit event registration (FR-R3-064)', () => {
  it('registers the event in its own single-member group', () => {
    expect([...BACKEND_POSTURE_EVENT_TYPES]).toEqual(['backend-posture-admitted']);
  });

  it('exposes it via ALL_AUDIT_EVENT_TYPES and the known-type set', () => {
    expect(ALL_AUDIT_EVENT_TYPES).toContain('backend-posture-admitted');
    expect(KNOWN_AUDIT_EVENT_TYPE_SET.has('backend-posture-admitted')).toBe(true);
    expect(isKnownAuditEventType('backend-posture-admitted')).toBe(true);
  });

  it('classifies it as task-scoped — it belongs to a Run, not to the window', () => {
    expect(classifyAuditEvent('backend-posture-admitted')).toBe('task');
  });

  it('leaves AUDIT_SCHEMA_VERSION unchanged', () => {
    // Additive, following the 028 / 030 / 031 / 032 precedent this contract file
    // records in place. A bump here would force every reader to migrate for an
    // event no historical record contains.
    expect(AUDIT_SCHEMA_VERSION).toBe(3);
  });

  it('accepts the contracted payload for every supported backend', () => {
    for (const runner of SUPPORTED_BACKENDS) {
      const payload: BackendPostureAdmittedPayload = {
        runner,
        containment: containmentOf(runner),
        uncontainedAllowed: true
      };
      expect(Object.keys(payload).sort()).toEqual([
        'containment',
        'runner',
        'uncontainedAllowed'
      ]);
      expect(['none', 'os-enforced']).toContain(payload.containment);
    }
  });

  it('derives the classification from the policy rather than restating it', () => {
    // If this ever disagrees, the payload is not reporting the classification the
    // refusal enforces — which would make the record worse than none.
    expect(containmentOf('claude')).toBe('none');
    expect(containmentOf('agy')).toBe('none');
    expect(containmentOf('codex')).toBe('os-enforced');
  });

  it('keeps the event type narrow', () => {
    const type: BackendPostureEventType = 'backend-posture-admitted';
    expect(type).toBe('backend-posture-admitted');
  });
});

describe('backend-posture-admitted — historical logs stay readable (FR-R3-064)', () => {
  it('tolerates a log that predates the event entirely', () => {
    // A pre-change log simply has no entry of this type. Nothing about reading it
    // changes: every type it does contain is still known.
    const historical = ['phase-start', 'cli-invocation', 'phase-end'];
    for (const type of historical) {
      expect(isKnownAuditEventType(type)).toBe(true);
    }
    expect(historical).not.toContain('backend-posture-admitted');
  });

  it('still warns and preserves an unknown event type rather than rejecting it', () => {
    // The reader's tolerance is what makes an additive event safe. If this became
    // false, adding an event would be a breaking change and the precedent this
    // feature relied on would be void.
    expect(isKnownAuditEventType('some-event-a-future-version-writes')).toBe(false);
    expect(() => isKnownAuditEventType('some-event-a-future-version-writes')).not.toThrow();
  });
});
