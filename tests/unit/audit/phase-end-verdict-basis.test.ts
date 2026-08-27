import { describe, expect, it } from 'vitest';
import { AUDIT_SCHEMA_VERSION } from '../../../src/contracts/audit-events';
import { projectAuditPayload } from '../../../src/audit/audit-payload';

/**
 * FR-R3-117 / FR-035 — a completed Run's evidence names the basis that judged
 * each Phase.
 */
describe('phase-end verdictBasis (FR-R3-117)', () => {
  const project = (payload: Record<string, unknown>): Record<string, unknown> =>
    projectAuditPayload('phase-end', payload) as unknown as Record<string, unknown>;

  it('carries exit-code through', () => {
    expect(project({ outcome: 'failed', verdictBasis: 'exit-code' }).verdictBasis).toBe('exit-code');
  });

  it('carries model-token through', () => {
    expect(project({ outcome: 'clean', verdictBasis: 'model-token' }).verdictBasis).toBe('model-token');
  });

  it('omits the field rather than defaulting it when absent', () => {
    // A record written before this feature did not RECORD a basis. Defaulting it
    // to model-token would assert something nobody measured — the exact shape of
    // claim this round exists to remove.
    expect('verdictBasis' in project({ outcome: 'clean' })).toBe(false);
  });

  it('omits an unrecognised value rather than passing it through', () => {
    expect('verdictBasis' in project({ outcome: 'clean', verdictBasis: 'vibes' })).toBe(false);
  });

  it('does not bump AUDIT_SCHEMA_VERSION — the field is additive', () => {
    // The 028 / 030 / 031 / 032 precedent recorded at audit-events.ts:34. A new
    // optional field on an existing event breaks no reader.
    expect(AUDIT_SCHEMA_VERSION).toBe(3);
  });
});
