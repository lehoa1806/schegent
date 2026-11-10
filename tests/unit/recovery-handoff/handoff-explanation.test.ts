// FR-R6-F08 T023 — `buildExplanation` (research R9, FR-012, FR-016, NFR-004, SC-005).
//
// WHAT THIS PINS:
//   - every R9 field: identity, state, paused, revision, source outcome, certainty, coverage,
//     attribution counts, references with their last resolution, omitted and excluded items,
//     deliveries, decisions and next actions;
//   - next actions per state, and `inspect-evidence` in place of `deliver` when a required
//     reference resolved as anything but `available`;
//   - a revision written by a newer build is reported `unsupported`, with no manifest fields;
//   - 32 references per role and 32 excluded items fit in 65,536 bytes untrimmed;
//   - an oversized snapshot is trimmed from the end of its lists to the bound, and
//     `truncatedCounts` says how many were dropped from each;
//   - attribution is counts only: no workspace path reaches the explanation;
//   - an absolute path in any string throws `HandoffExplanationContentError`, naming the field
//     but never the value;
//   - building reads only: a frozen snapshot is accepted and comes back unchanged.
//
// The service-level "explain writes no row" check is in the service test (T025).

import { describe, expect, it } from 'vitest';
import {
  HANDOFF_REFERENCE_ROLES,
  MAX_HANDOFF_EXCLUDED_ITEMS,
  MAX_HANDOFF_EXPLANATION_BYTES,
  MAX_HANDOFF_REFERENCES_PER_ROLE,
  type HandoffReferenceRole,
  type HandoffResolution,
  type HandoffState
} from '../../../src/contracts/recovery-handoff/handoff-types';
import {
  buildExplanation,
  HandoffExplanationContentError,
  type HandoffExplanationSnapshot
} from '../../../src/services/recovery-handoff/handoff-explanation';
import type {
  DecisionRow,
  DeliveryRow,
  HandoffRow,
  ReferenceRow,
  RevisionRow
} from '../../../src/services/recovery-handoff/handoff-store';

const HANDOFF_ID = 'h'.repeat(64);
const DIGEST = 'a'.repeat(64);
const NOW = 1_800_000_000_000;

function handoffRow(overrides: Partial<HandoffRow> = {}): HandoffRow {
  return {
    handoffId: HANDOFF_ID,
    workspaceId: 'ws-1',
    rootExecutionId: 'root-1',
    invocationId: 'inv-1',
    sourceAttemptId: 'att-1',
    state: 'ready',
    paused: false,
    closedReason: null,
    currentRevision: 1,
    pinPurpose: 'pending-handoff',
    pinPurposeTarget: null,
    legacyProvenance: null,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...overrides
  };
}

interface ManifestShape {
  readonly references: readonly { readonly artifactId: string; readonly role: HandoffReferenceRole; readonly required: boolean }[];
  readonly excluded: readonly { readonly itemId: string; readonly reason: string }[];
  readonly entries: readonly { readonly path: string; readonly attribution: string }[];
}

const SMALL: ManifestShape = {
  references: [
    { artifactId: 'art-validated-1', role: 'validated', required: true },
    { artifactId: 'art-partial-1', role: 'partial', required: false }
  ],
  excluded: [{ itemId: 'transcript-1', reason: 'raw-transcript' }],
  entries: [
    { path: 'src/app.ts', attribution: 'attempt' },
    { path: 'src/util.ts', attribution: 'attempt' },
    { path: 'README.md', attribution: 'preexisting' }
  ]
};

function manifestJson(shape: ManifestShape): string {
  return JSON.stringify({
    version: 1,
    sourceOutcome: { status: 'incomplete', reason: 'work-remaining' },
    frozenDefinitionDigest: DIGEST,
    certainty: 'uncertain',
    coverage: 'partial',
    workspace: { entries: shape.entries, omittedCount: 3 },
    references: shape.references,
    excluded: shape.excluded,
    contextId: null,
    envelope: { artifactId: 'env-1', digest: DIGEST }
  });
}

function revisionRow(shape: ManifestShape = SMALL, overrides: Partial<RevisionRow> = {}): RevisionRow {
  return {
    handoffId: HANDOFF_ID,
    revisionNo: 1,
    status: 'issued',
    cutoffKey: DIGEST,
    executionRevision: 'exec-1',
    usageRevision: 4,
    factCutoffMs: NOW,
    manifestVersion: 1,
    manifestJson: manifestJson(shape),
    manifestDigest: DIGEST,
    certainty: 'uncertain',
    coverage: 'partial',
    issuedAtMs: NOW,
    supersededAtMs: null,
    ...overrides
  };
}

function referenceRows(shape: ManifestShape, resolution: HandoffResolution | null = 'available'): ReferenceRow[] {
  return shape.references.map((ref) => ({
    handoffId: HANDOFF_ID,
    revisionNo: 1,
    artifactId: ref.artifactId,
    role: ref.role,
    required: ref.required,
    expectedDigest: null,
    pinState: 'pinned',
    pinRefusal: null,
    lastResolution: resolution,
    resolvedAtMs: resolution === null ? null : NOW
  }));
}

function deliveryRow(index: number, overrides: Partial<DeliveryRow> = {}): DeliveryRow {
  return {
    intentId: `intent-${index}`,
    handoffId: HANDOFF_ID,
    revisionNo: 1,
    targetAttemptId: `att-${index + 2}`,
    envelopeDigest: DIGEST,
    transport: 'acp',
    backendId: 'backend-1',
    profileId: 'profile-1',
    profileVersion: '1',
    ownerDigest: DIGEST,
    sessionPlan: 'fresh-session',
    sessionReason: 'no-prior-session',
    sessionId: null,
    connectionId: 'conn-1',
    promptId: null,
    capabilitiesDigest: DIGEST,
    accessPlanDigest: DIGEST,
    outcome: 'refused',
    outcomeReason: 'not-sent',
    decisionId: null,
    recordedAtMs: NOW + index,
    settledAtMs: NOW + index,
    ...overrides
  };
}

function decisionRow(index: number, overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decisionId: `dec-${index}`,
    handoffId: HANDOFF_ID,
    revisionNo: 1,
    decision: 'continue-new-attempt',
    outcome: 'accepted',
    consumedByIntentId: null,
    recordedAtMs: NOW + index,
    ...overrides
  };
}

function snapshot(overrides: Partial<HandoffExplanationSnapshot> = {}): HandoffExplanationSnapshot {
  return {
    handoff: handoffRow(),
    revision: revisionRow(),
    references: referenceRows(SMALL),
    deliveries: [],
    decisions: [],
    ...overrides
  };
}

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('FR-R6-F08 T023 — explanation fields (R9)', () => {
  it('reports every R9 field from the rows and the stored manifest', () => {
    const explanation = buildExplanation(
      snapshot({
        handoff: handoffRow({ state: 'uncertain', paused: true, pinPurpose: 'paused-recovery' }),
        references: referenceRows(SMALL).map((row) =>
          row.role === 'partial' ? { ...row, lastResolution: 'expired' as const } : row
        ),
        deliveries: [
          deliveryRow(0),
          deliveryRow(1, { outcome: 'uncertain', outcomeReason: 'restart-before-ack', settledAtMs: null })
        ],
        decisions: [decisionRow(0, { revisionNo: 0, outcome: 'refused-stale' })]
      })
    );

    expect(explanation).toMatchObject({
      handoffId: HANDOFF_ID,
      state: 'uncertain',
      paused: true,
      closedReason: null,
      revisionNo: 1,
      currentRevision: 1,
      sourceOutcome: { status: 'incomplete', reason: 'work-remaining' },
      certainty: 'uncertain',
      coverage: 'partial',
      attribution: { counts: { attempt: 2, preexisting: 1, concurrent: 0, unknown: 0 }, omittedCount: 3 }
    });
    expect(explanation.references).toEqual([
      { artifactId: 'art-validated-1', role: 'validated', required: true, lastResolution: 'available' },
      { artifactId: 'art-partial-1', role: 'partial', required: false, lastResolution: 'expired' }
    ]);
    expect(explanation.omitted).toEqual([{ artifactId: 'art-partial-1', role: 'partial', resolution: 'expired' }]);
    expect(explanation.excluded).toEqual([{ itemId: 'transcript-1', reason: 'raw-transcript' }]);
    // Newest first, so trimming from the end drops the oldest.
    expect(explanation.deliveries.map((row) => [row.targetAttemptId, row.outcome, row.sessionPlan])).toEqual([
      ['att-3', 'uncertain', 'fresh-session'],
      ['att-2', 'refused', 'fresh-session']
    ]);
    expect(explanation.decisions).toEqual([
      { revisionNo: 0, decision: 'continue-new-attempt', outcome: 'refused-stale', consumed: false }
    ]);
    expect(explanation.nextActions).toEqual(['decide', 'inspect-evidence']);
    expect(explanation.truncatedCounts).toEqual({
      references: 0,
      omitted: 0,
      excluded: 0,
      deliveries: 0,
      decisions: 0
    });
  });

  it('carries attribution as counts only: no workspace path reaches the explanation', () => {
    const serialized = JSON.stringify(buildExplanation(snapshot()));
    for (const entry of SMALL.entries) expect(serialized).not.toContain(entry.path);
    expect(serialized).not.toContain('"path"');
  });

  it('carries no session id, owner digest or connection id from a delivery', () => {
    const explanation = buildExplanation(
      snapshot({ deliveries: [deliveryRow(0, { sessionPlan: 'load-session', sessionReason: null, sessionId: 'sess-secret-1' })] })
    );
    const serialized = JSON.stringify(explanation);
    expect(serialized).not.toContain('sess-secret-1');
    expect(serialized).not.toContain('conn-1');
    expect(serialized).not.toContain(DIGEST);
  });

  it('reports a revision written by a newer build as unsupported, with no manifest fields', () => {
    const explanation = buildExplanation(
      snapshot({ revision: revisionRow(SMALL, { manifestVersion: 2, manifestJson: '{"version":2}' }) })
    );
    expect(explanation).toMatchObject({
      state: 'unsupported',
      sourceOutcome: null,
      certainty: null,
      coverage: null,
      attribution: null,
      excluded: [],
      nextActions: ['inspect-evidence']
    });
  });

  it('explains a handoff with no revision', () => {
    const explanation = buildExplanation(
      snapshot({ handoff: handoffRow({ state: 'preparing', currentRevision: null }), revision: null, references: [] })
    );
    expect(explanation).toMatchObject({ revisionNo: null, currentRevision: null, attribution: null, references: [] });
  });
});

describe('FR-R6-F08 T023 — next actions (R9 table)', () => {
  const cases: readonly (readonly [HandoffState, readonly string[]])[] = [
    ['preparing', ['none']],
    ['ready', ['deliver']],
    ['delivering', ['await-acknowledgement']],
    ['uncertain', ['decide', 'inspect-evidence']],
    ['acknowledged', ['none']],
    ['consumed', ['none']],
    ['superseded', ['none']],
    ['unsupported', ['inspect-evidence']]
  ];

  for (const [state, actions] of cases) {
    it(`offers ${actions.join(', ')} in state ${state}`, () => {
      expect(buildExplanation(snapshot({ handoff: handoffRow({ state }) })).nextActions).toEqual(actions);
    });
  }

  it('offers inspect-evidence in place of deliver when a required reference is not available', () => {
    const references = referenceRows(SMALL).map((row) =>
      row.required ? { ...row, lastResolution: 'changed' as const } : row
    );
    expect(buildExplanation(snapshot({ references })).nextActions).toEqual(['inspect-evidence']);
    const delivering = buildExplanation(snapshot({ references, handoff: handoffRow({ state: 'delivering' }) }));
    expect(delivering.nextActions).toEqual(['await-acknowledgement', 'inspect-evidence']);
  });

  it('does not treat an optional reference that is not available as blocking', () => {
    const references = referenceRows(SMALL).map((row) =>
      row.required ? row : { ...row, lastResolution: 'missing' as const }
    );
    expect(buildExplanation(snapshot({ references })).nextActions).toEqual(['deliver']);
  });

  it('does not treat a reference never resolved as blocking', () => {
    expect(buildExplanation(snapshot({ references: referenceRows(SMALL, null) })).nextActions).toEqual(['deliver']);
  });
});

function fullShape(): ManifestShape {
  const references = HANDOFF_REFERENCE_ROLES.flatMap((role) =>
    Array.from({ length: MAX_HANDOFF_REFERENCES_PER_ROLE }, (_unused, index) => ({
      artifactId: `art-${role}-${String(index).padStart(3, '0')}-${'x'.repeat(10)}`,
      role,
      required: index % 2 === 0
    }))
  );
  const excluded = Array.from({ length: MAX_HANDOFF_EXCLUDED_ITEMS }, (_unused, index) => ({
    itemId: `item-${String(index).padStart(3, '0')}-${'y'.repeat(10)}`,
    reason: 'policy-denied'
  }));
  return { references, excluded, entries: SMALL.entries };
}

describe('FR-R6-F08 T023 — the 64 KiB bound', () => {
  it('fits 32 references per role and 32 excluded items untrimmed', () => {
    const shape = fullShape();
    const explanation = buildExplanation(
      snapshot({
        revision: revisionRow(shape),
        references: referenceRows(shape, 'missing'),
        deliveries: Array.from({ length: 8 }, (_unused, index) => deliveryRow(index)),
        decisions: Array.from({ length: 8 }, (_unused, index) => decisionRow(index))
      })
    );
    expect(explanation.references).toHaveLength(HANDOFF_REFERENCE_ROLES.length * MAX_HANDOFF_REFERENCES_PER_ROLE);
    expect(explanation.excluded).toHaveLength(MAX_HANDOFF_EXCLUDED_ITEMS);
    expect(Object.values(explanation.truncatedCounts).every((dropped) => dropped === 0)).toBe(true);
    expect(bytesOf(explanation)).toBeLessThanOrEqual(MAX_HANDOFF_EXPLANATION_BYTES);
  });

  it('trims an oversized snapshot from the end of its lists and counts what it dropped', () => {
    const shape = fullShape();
    const deliveries = Array.from({ length: 2_000 }, (_unused, index) => deliveryRow(index));
    const decisions = Array.from({ length: 2_000 }, (_unused, index) => decisionRow(index));
    const explanation = buildExplanation(
      snapshot({ revision: revisionRow(shape), references: referenceRows(shape, 'missing'), deliveries, decisions })
    );

    expect(bytesOf(explanation)).toBeLessThanOrEqual(MAX_HANDOFF_EXPLANATION_BYTES);
    const { truncatedCounts } = explanation;
    expect(truncatedCounts.deliveries).toBeGreaterThan(0);
    expect(truncatedCounts.decisions).toBeGreaterThan(0);
    expect(explanation.deliveries.length + truncatedCounts.deliveries).toBe(deliveries.length);
    expect(explanation.decisions.length + truncatedCounts.decisions).toBe(decisions.length);
    expect(explanation.references.length + truncatedCounts.references).toBe(shape.references.length);
    expect(explanation.excluded.length + truncatedCounts.excluded).toBe(shape.excluded.length);
    // The newest delivery is kept: trimming drops from the end, which holds the oldest.
    expect(explanation.deliveries.at(0)?.targetAttemptId).toBe(`att-${deliveries.length + 1}`);
  });
});

describe('FR-R6-F08 T023 — content guard', () => {
  const absolutePaths = ['/Users/someone/project', 'C:\\work\\project', '~/project', '\\\\server\\share'];

  for (const absolute of absolutePaths) {
    it(`throws HandoffExplanationContentError for an absolute path, naming only the field (${absolute.charAt(0)})`, () => {
      const references = referenceRows(SMALL).map((row) =>
        row.role === 'partial' ? { ...row, artifactId: absolute } : row
      );
      let thrown: unknown = null;
      try {
        buildExplanation(snapshot({ references }));
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HandoffExplanationContentError);
      const message = thrown instanceof Error ? thrown.message : '';
      expect(message).toContain('references');
      expect(message).not.toContain(absolute);
    });
  }

  it('accepts relative-looking and opaque identifiers', () => {
    const references = referenceRows(SMALL).map((row) =>
      row.role === 'partial' ? { ...row, artifactId: 'run-1/hand-1' } : row
    );
    expect(() => buildExplanation(snapshot({ references }))).not.toThrow();
  });
});

describe('FR-R6-F08 T023 — building reads only', () => {
  it('accepts a frozen snapshot and leaves it unchanged', () => {
    const input = deepFreeze(
      snapshot({ deliveries: [deliveryRow(0), deliveryRow(1)], decisions: [decisionRow(0), decisionRow(1)] })
    );
    const before = JSON.stringify(input);
    buildExplanation(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});
