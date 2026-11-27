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
import { validateRecoveryEnvelope } from '../../../src/contracts/recovery-envelope';
import type { HandoffCutoff } from '../../../src/contracts/recovery-handoff/handoff-types';
import { validateHandoffManifest } from '../../../src/contracts/recovery-handoff/handoff-manifest';
import {
  isValidAcpSessionMapping,
  legacyPriorSession,
  mapLegacyRecord,
  parseLegacyProvenance,
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

  it('maps valid non-colliding evidenceRefs to role evidence (required: false) within the 32-ref bound (16-12)', () => {
    const mapped = mapLegacyRecord(
      record({
        envelope: legacyEnvelope({
          effects: { certainty: 'uncertain', evidenceRefs: ['ev-art-1', 'ev-art-2'] }
        })
      })
    );
    if (mapped.kind !== 'prepare') throw new Error(mapped.kind);
    expect(validateHandoffManifest(mapped.manifest).ok).toBe(true);
    expect(mapped.manifest.references).toEqual([
      { artifactId: 'art-upstream-1', role: 'validated', required: false },
      { artifactId: 'art-partial-1', role: 'partial', required: false },
      { artifactId: 'ev-art-1', role: 'evidence', required: false },
      { artifactId: 'ev-art-2', role: 'evidence', required: false }
    ]);
  });

  it('refuses unmappable evidenceRefs, out-of-grammar chars, duplicate roles, inconsistent complete+omittedCount, >32 refs, and >16 KiB post-mapping manifests (16-12)', () => {
    // 1. Out-of-grammar evidenceRef (valid RecoveryEnvelope opaque ref, invalid HandoffManifest opaque id)
    expect(
      mapLegacyRecord(
        record({
          envelope: legacyEnvelope({
            effects: { certainty: 'uncertain', evidenceRefs: ['event/with/slash'] }
          })
        })
      )
    ).toEqual({ kind: 'invalid', code: 'invalid-ref', field: 'references.2.artifactId' });

    // 2. Out-of-grammar chars in upstreamArtifactRefs (spaces allowed by RecoveryEnvelope, forbidden by manifest)
    expect(
      mapLegacyRecord(
        record({
          envelope: legacyEnvelope({
            upstreamArtifactRefs: ['bad artifact id']
          })
        })
      )
    ).toEqual({ kind: 'invalid', code: 'invalid-ref', field: 'references.0.artifactId' });

    // 3. Duplicate role across upstreamArtifactRefs and partialArtifactRefs / evidenceRefs
    expect(
      mapLegacyRecord(
        record({
          envelope: legacyEnvelope({
            upstreamArtifactRefs: ['art-dup'],
            partialArtifactRefs: ['art-dup']
          })
        })
      )
    ).toEqual({ kind: 'invalid', code: 'invalid', field: 'references.1.artifactId' });
    expect(
      mapLegacyRecord(
        record({
          envelope: legacyEnvelope({
            upstreamArtifactRefs: ['art-dup'],
            partialArtifactRefs: [],
            effects: { certainty: 'uncertain', evidenceRefs: ['art-dup'] }
          })
        })
      )
    ).toEqual({ kind: 'invalid', code: 'invalid', field: 'references.1.artifactId' });

    // 4. Inconsistent complete coverage with omittedCount > 0
    expect(
      mapLegacyRecord(
        record({
          envelope: legacyEnvelope({
            workspace: { coverage: 'complete', omittedCount: 1, entries: [] }
          })
        })
      )
    ).toEqual({ kind: 'invalid', code: 'invalid', field: 'coverage' });

    // 5a. Exceeding 32 total mapped references across upstream + partial + evidence
    expect(
      mapLegacyRecord(
        record({
          envelope: legacyEnvelope({
            upstreamArtifactRefs: Array.from({ length: 15 }, (_, i) => `up-${i}`),
            partialArtifactRefs: Array.from({ length: 10 }, (_, i) => `part-${i}`),
            effects: {
              certainty: 'uncertain',
              evidenceRefs: Array.from({ length: 8 }, (_, i) => `ev-${i}`)
            }
          })
        })
      )
    ).toEqual({ kind: 'invalid', code: 'over-limit', field: 'references' });

    // 5b. Valid <= 16 KiB RecoveryEnvelope whose post-mapping HandoffManifest exceeds 16,384 bytes
    const expandingEnvelope = legacyEnvelope({
      upstreamArtifactRefs: Array.from({ length: 32 }, (_, i) => `u-${String(i).padStart(2, '0')}-${'a'.repeat(120)}`),
      partialArtifactRefs: [],
      workspace: {
        coverage: 'partial',
        omittedCount: 1,
        entries: Array.from({ length: 28 }, (_, i) => ({
          path: `d${String(i).padStart(2, '0')}/${'p'.repeat(335)}.ts`,
          existedBefore: true,
          dirtyBefore: false,
          attribution: 'attempt'
        }))
      }
    });
    expect(validateRecoveryEnvelope(expandingEnvelope).ok).toBe(true);
    expect(mapLegacyRecord(record({ envelope: expandingEnvelope }))).toEqual({
      kind: 'invalid',
      code: 'over-limit',
      field: 'manifest'
    });
  });
});

describe('parseLegacyProvenance and isValidAcpSessionMapping (16-12)', () => {
  it('parses valid legacy provenance and fails safe to malformed on invalid JSON or unexpected shapes', () => {
    expect(parseLegacyProvenance(null)).toEqual({ kind: 'none' });
    expect(parseLegacyProvenance('{bad json')).toEqual({ kind: 'malformed' });
    expect(parseLegacyProvenance(JSON.stringify({ kind: 'unknown' }))).toEqual({ kind: 'malformed' });
    expect(parseLegacyProvenance(JSON.stringify({ kind: 'legacy-record', providerSession: null }))).toEqual({
      kind: 'legacy-record',
      providerSessionId: null
    });
    expect(
      parseLegacyProvenance(
        JSON.stringify({
          kind: 'legacy-record',
          providerSession: { kind: 'legacy-provider-session', value: 'sess-provider-9' }
        })
      )
    ).toEqual({ kind: 'legacy-record', providerSessionId: 'sess-provider-9' });
    expect(parseLegacyProvenance(JSON.stringify({ kind: 'unsupported-envelope', version: 7 }))).toEqual({
      kind: 'unsupported-envelope',
      version: 7
    });
  });

  it('rejects ephemeral bridge IDs and legacy provider ID reuse in ACP session mappings', () => {
    expect(isValidAcpSessionMapping({ kind: 'acp-session', sessionId: 'acp-claude-session-1' })).toBe(false);
    expect(isValidAcpSessionMapping({ kind: 'acp-session', sessionId: 'acp-codex-session-42' })).toBe(false);
    expect(isValidAcpSessionMapping({ kind: 'acp-session', sessionId: 'acp-agy-session-7' })).toBe(false);
    expect(isValidAcpSessionMapping({ kind: 'acp-session', sessionId: 'sess-provider-9' }, 'sess-provider-9')).toBe(
      false
    );
    expect(isValidAcpSessionMapping({ kind: 'acp-session', sessionId: 'acp-sess-claude-real-1' }, 'sess-provider-9')).toBe(
      true
    );

    const ephemeralPrior = legacyPriorSession(record({ providerSessionId: 'sess-provider-9' }), PARTY, {
      kind: 'acp-session',
      sessionId: 'acp-claude-session-1'
    });
    expect(ephemeralPrior).toMatchObject({ source: 'legacy' });
    expect(planSession({ prior: ephemeralPrior, target: PARTY, capability: 'declared', forceFresh: false })).toEqual({
      plan: 'fresh-session',
      reason: 'legacy-session'
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
