/**
 * FR-R6-F08 (FR-019, research R11, US5 scenario 3, F08-AC-09) — mapping a pre-cutover record.
 *
 * - settled, paused and uncertain records keep their ids, and certainty is unchanged;
 * - a provider session id lands only in `legacyProvenance`, never in the manifest;
 * - an unknown envelope version maps to `unsupported` with the identity only;
 * - a mapped record plans `fresh-session` (`legacy-session`) without an explicit ACP mapping,
 *   and `load-session` with one when the R8 conditions hold.
 */

import { describe, expect, it } from 'vitest';
import type { HandoffCutoff } from '../../../src/contracts/recovery-handoff/handoff-types';
import { validateHandoffManifest } from '../../../src/contracts/recovery-handoff/handoff-manifest';
import {
  legacyPriorSession,
  mapLegacyRecord,
  type LegacyHandoffRecord
} from '../../../src/services/recovery-handoff/legacy-handoff-mapping';
import { planSession, type SessionParty } from '../../../src/services/recovery-handoff/session-plan';

const FROZEN = 'c'.repeat(64);
const CUTOFF: HandoffCutoff = { executionRevision: 'legacy-exec-1', usageRevision: 0, factCutoffMs: 1_700_000_000_000 };

function legacyEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    invocationId: 'inv-legacy-1',
    previousAttemptId: 'att-legacy-1',
    previousOutcome: { status: 'incomplete', reason: 'work-remaining' },
    upstreamArtifactRefs: ['art-upstream-1'],
    partialArtifactRefs: ['art-partial-1'],
    workspace: {
      coverage: 'partial',
      omittedCount: 2,
      entries: [
        { path: 'notes.md', existedBefore: false, dirtyBefore: false, attribution: 'unknown' },
        { path: 'src/app.ts', existedBefore: true, dirtyBefore: false, attribution: 'attempt' }
      ]
    },
    effects: { certainty: 'uncertain', evidenceRefs: [] },
    truncated: false,
    ...overrides
  };
}

function record(overrides: Partial<LegacyHandoffRecord> = {}): LegacyHandoffRecord {
  return {
    workspaceId: 'ws-legacy',
    runId: 'run-legacy-1',
    invocationId: 'inv-legacy-1',
    attemptId: 'att-legacy-1',
    status: 'settled',
    outcome: { status: 'incomplete', reason: 'work-remaining' },
    certainty: 'safe',
    frozenDefinitionDigest: FROZEN,
    cutoff: CUTOFF,
    attribution: { backendId: 'claude-cli', runtimeId: 'legacy-runner' },
    ...overrides
  };
}

const PARTY: SessionParty = {
  ownerDigest: 'd'.repeat(64),
  backendId: 'acp-claude',
  profileId: 'profile-1',
  profileVersion: '1',
  capabilitiesDigest: 'e'.repeat(64)
};

describe('mapLegacyRecord (R11)', () => {
  it.each(['settled', 'paused', 'uncertain'] as const)('keeps the historical ids of a %s record', (status) => {
    const mapped = mapLegacyRecord(record({ status }));
    if (mapped.kind !== 'prepare') throw new Error(mapped.kind);
    expect(mapped.lineage).toEqual({
      workspaceId: 'ws-legacy',
      rootExecutionId: 'run-legacy-1',
      invocationId: 'inv-legacy-1',
      sourceAttemptId: 'att-legacy-1'
    });
    expect(mapped.paused).toBe(status === 'paused');
    expect(mapped.cutoff).toEqual(CUTOFF);
  });

  it.each(['safe', 'uncertain', 'unknown'] as const)('leaves certainty %s unchanged', (certainty) => {
    const mapped = mapLegacyRecord(record({ status: 'uncertain', certainty, envelope: legacyEnvelope() }));
    if (mapped.kind !== 'prepare') throw new Error(mapped.kind);
    expect(mapped.manifest.certainty).toBe(certainty);
  });

  it('keeps the outcome and the runtime attribution', () => {
    const mapped = mapLegacyRecord(record({ outcome: { status: 'failed', reason: 'process-failure' } }));
    if (mapped.kind !== 'prepare') throw new Error(mapped.kind);
    expect(mapped.manifest.sourceOutcome).toEqual({ status: 'failed', reason: 'process-failure' });
    expect(JSON.parse(mapped.legacyProvenance)).toMatchObject({
      kind: 'legacy-record',
      status: 'settled',
      attribution: { backendId: 'claude-cli', runtimeId: 'legacy-runner' }
    });
  });

  it('puts a provider session id only in the provenance', () => {
    const mapped = mapLegacyRecord(record({ providerSessionId: 'sess-provider-9', envelope: legacyEnvelope() }));
    if (mapped.kind !== 'prepare') throw new Error(mapped.kind);
    expect(JSON.parse(mapped.legacyProvenance)).toMatchObject({
      providerSession: { kind: 'legacy-provider-session', value: 'sess-provider-9' }
    });
    expect(JSON.stringify(mapped.manifest)).not.toContain('sess-provider-9');
  });

  it('maps a valid envelope into a manifest the validator accepts', () => {
    const mapped = mapLegacyRecord(record({ envelope: legacyEnvelope() }));
    if (mapped.kind !== 'prepare') throw new Error(mapped.kind);
    expect(validateHandoffManifest(mapped.manifest).ok).toBe(true);
    expect(mapped.manifest.coverage).toBe('partial');
    expect(mapped.manifest.workspace).toEqual({
      entries: [
        { path: 'notes.md', attribution: 'unknown' },
        { path: 'src/app.ts', attribution: 'attempt' }
      ],
      omittedCount: 2
    });
    expect(mapped.manifest.references).toEqual([
      { artifactId: 'art-upstream-1', role: 'validated', required: false },
      { artifactId: 'art-partial-1', role: 'partial', required: false }
    ]);
    expect(mapped.manifest.envelope).toBeNull();
  });

  it('maps a record with no envelope to an empty, unavailable workspace', () => {
    const mapped = mapLegacyRecord(record());
    if (mapped.kind !== 'prepare') throw new Error(mapped.kind);
    expect(validateHandoffManifest(mapped.manifest).ok).toBe(true);
    expect(mapped.manifest).toMatchObject({
      coverage: 'unavailable',
      workspace: { entries: [], omittedCount: 0 },
      references: []
    });
  });

  it('maps an unknown envelope version to unsupported, keeping the identity only', () => {
    const mapped = mapLegacyRecord(
      record({ providerSessionId: 'sess-provider-9', envelope: legacyEnvelope({ version: 7, futureField: true }) })
    );
    expect(mapped).toEqual({
      kind: 'unsupported',
      lineage: {
        workspaceId: 'ws-legacy',
        rootExecutionId: 'run-legacy-1',
        invocationId: 'inv-legacy-1',
        sourceAttemptId: 'att-legacy-1'
      },
      legacyProvenance: JSON.stringify({ kind: 'unsupported-envelope', version: 7 })
    });
  });

  it('records a non-numeric unknown version as null', () => {
    const mapped = mapLegacyRecord(record({ envelope: legacyEnvelope({ version: '/Users/x/secret' }) }));
    expect(mapped).toMatchObject({
      kind: 'unsupported',
      legacyProvenance: JSON.stringify({ kind: 'unsupported-envelope', version: null })
    });
  });

  it('refuses an invalid field, naming it', () => {
    expect(mapLegacyRecord(record({ runId: 'not an id' }))).toEqual({ kind: 'invalid', field: 'runId' });
    expect(mapLegacyRecord(record({ status: 'done' as 'settled' }))).toEqual({ kind: 'invalid', field: 'status' });
    expect(mapLegacyRecord(record({ certainty: 'sure' as 'safe' }))).toEqual({ kind: 'invalid', field: 'certainty' });
    expect(mapLegacyRecord(record({ providerSessionId: 'has space' }))).toEqual({
      kind: 'invalid',
      field: 'providerSessionId'
    });
    expect(
      mapLegacyRecord(record({ attribution: { backendId: 'claude-cli', runtimeId: '' } }))
    ).toEqual({ kind: 'invalid', field: 'attribution.runtimeId' });
    expect(mapLegacyRecord(record({ envelope: legacyEnvelope({ truncated: 'no' }) }))).toEqual({
      kind: 'invalid',
      field: 'envelope'
    });
  });
});

describe('legacyPriorSession and planSession (R8, R11)', () => {
  it('plans a fresh legacy-session from a provider session id without an ACP mapping', () => {
    const prior = legacyPriorSession(record({ providerSessionId: 'sess-provider-9' }), PARTY);
    expect(prior).toMatchObject({ source: 'legacy' });
    expect(planSession({ prior, target: PARTY, capability: 'declared', forceFresh: false })).toEqual({
      plan: 'fresh-session',
      reason: 'legacy-session'
    });
  });

  it('plans no-prior-session for a record with neither a session id nor a mapping', () => {
    const prior = legacyPriorSession(record(), PARTY);
    expect(prior).toBeNull();
    expect(planSession({ prior, target: PARTY, capability: 'declared', forceFresh: false })).toEqual({
      plan: 'fresh-session',
      reason: 'no-prior-session'
    });
  });

  it('loads the mapped ACP session when the R8 conditions hold, and never the provider id', () => {
    const prior = legacyPriorSession(record({ providerSessionId: 'sess-provider-9' }), PARTY, {
      kind: 'acp-session',
      sessionId: 'acp-sess-1'
    });
    expect(planSession({ prior, target: PARTY, capability: 'declared', forceFresh: false })).toEqual({
      plan: 'load-session',
      sessionId: 'acp-sess-1'
    });
    const otherBackend = { ...PARTY, backendId: 'acp-other' };
    expect(planSession({ prior, target: otherBackend, capability: 'declared', forceFresh: false })).toEqual({
      plan: 'fresh-session',
      reason: 'backend-changed'
    });
  });
});
