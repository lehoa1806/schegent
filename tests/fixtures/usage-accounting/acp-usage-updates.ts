/**
 * FR-R6-F06 (T038, FR-023, FR-024, research R12) — the F06-owned ACP usage update fixtures.
 * F13 (the ACP transport) is not built; these shapes freeze the joint observation contract
 * that the mapping reads.
 */
import type { AcpAttemptBinding, AcpUsageUpdate } from '../../../src/services/usage-accounting/acp-usage-mapping';

export const ACP_ROOT = 'run-acp-1';
export const ACP_ATTEMPT = '2d8b8e3a-6c74-4b2a-9c3f-4b8c9e3fb003';
export const ACP_SECOND_ATTEMPT = '3e9c9f4b-7d85-4c3b-8d4a-5c9daf4ac004';

export function acpUpdate(overrides: Partial<AcpUsageUpdate> = {}): AcpUsageUpdate {
  return {
    profileId: 'profile-a',
    acpSessionId: 'acp-session-1',
    connectionGeneration: 1,
    turnId: 'turn-1',
    hostReceiveSeq: 1,
    eventUtc: '2026-11-10T10:00:00.000Z',
    replayed: false,
    producerEventId: 'evt-1',
    hasQualifiedSessionBaseline: false,
    used: 1200,
    size: 200_000,
    ...overrides
  };
}

export function acpBinding(overrides: Partial<AcpAttemptBinding> = {}): AcpAttemptBinding {
  return {
    profileId: 'profile-a',
    acpSessionId: 'acp-session-1',
    connectionGeneration: 1,
    turnId: 'turn-1',
    rootId: ACP_ROOT,
    attemptId: ACP_ATTEMPT,
    ...overrides
  };
}
