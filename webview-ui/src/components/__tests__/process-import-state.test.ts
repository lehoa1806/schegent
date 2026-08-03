// Feature 084 T037/T039/T040 — the import surface's decisions, as pure functions.
//
// Everything the commit decides lives outside the component so it can be pinned
// directly: which scope is offerable (FR-035), when confirmation is unavailable
// and why (FR-036, FR-057), what the save carries (FR-037, FR-038, FR-046a), and
// how the save's single ack becomes a per-row result (FR-042, FR-044).

import { describe, expect, it } from 'vitest';
import type { ImportPlan, ImportPlanRow } from '../../lib/messages';
import {
  IMPORT_TARGET_SCOPES,
  buildImportSave,
  confirmBlockedReason,
  projectSaveAck,
  reasonLines,
  refusalHeadline,
  savePhaseRowFromDefinition,
  type ImportedPhaseDefinition
} from '../ProcessImport/process-import-state';

const REVISIONS = Object.freeze({ user: 'user-rev-1', workspace: 'workspace-rev-1' });

/** Every portable field, so a dropped one is visible rather than plausible. */
const FULL: ImportedPhaseDefinition = {
  phaseId: 'brought-in',
  name: 'Brought In',
  description: 'As authored.',
  version: 7,
  instruction: 'Do the thing.',
  model: 'claude-opus-4',
  effort: 'high',
  timeoutSeconds: 900,
  loopable: true,
  retryCondition: 'open_questions > 0',
  isRequired: false,
  runner: 'claude'
};

function importRow(
  definition: ImportedPhaseDefinition = FULL,
  requiresRetryConditionCapability = false
): ImportPlanRow {
  return {
    outcome: 'import',
    resourceId: definition.phaseId,
    name: definition.name,
    requiresRetryConditionCapability,
    definition
  };
}

const SKIP_ROW: ImportPlanRow = {
  outcome: 'skip',
  resourceId: 'specify',
  name: 'Specify',
  presentIn: 'user',
  presentRowStatus: 'invalid'
};

const INVALID_ROW: ImportPlanRow = {
  outcome: 'invalid',
  resourceId: null,
  defects: [{ field: 'version', code: 'positive-integer-required', message: 'Saw "soon".' }],
  totalDefects: 1
};

function plan(rows: readonly ImportPlanRow[]): ImportPlan {
  return {
    rows,
    counts: {
      import: rows.filter((row) => row.outcome === 'import').length,
      skip: rows.filter((row) => row.outcome === 'skip').length,
      invalid: rows.filter((row) => row.outcome === 'invalid').length
    },
    computedAgainstRevision: REVISIONS
  };
}

const HELD = Object.freeze({ id: 'held', name: 'Held', version: 4, instruction: 'Hold.' });

describe('Feature 084 — the offerable import targets (FR-035)', () => {
  it('offers the two writable scopes and never built-in', () => {
    expect(IMPORT_TARGET_SCOPES).toEqual(['user', 'workspace']);
    expect(IMPORT_TARGET_SCOPES).not.toContain('built-in');
  });
});

describe('Feature 084 — the retry-condition advisory (T062, FR-012a)', () => {
  it('warns on an import row that declares a retry condition', () => {
    const lines = reasonLines(importRow(FULL, true));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('retry condition');
  });

  it('says nothing on an import row that declares none', () => {
    expect(reasonLines(importRow(FULL, false))).toEqual([]);
  });

  it('does not read as granted — the capability is checked at commit (FR-012a)', () => {
    // The advisory exists so the operator is not surprised by a refusal after
    // clicking Confirm. It must not imply the opposite: the flag describes the
    // DOCUMENT, and the host re-reads the capability at commit time, so wording
    // that claimed the capability was held would be a claim this surface is in
    // no position to make.
    const line = reasonLines(importRow(FULL, true))[0]!.toLowerCase();
    for (const granted of ['allowed', 'trusted', 'granted', 'permitted', 'will be imported']) {
      expect(line).not.toContain(granted);
    }
    // It points forward to the check rather than reporting a decision.
    expect(line).toContain('commit');
  });

  it('does not itself block confirmation', () => {
    // A blocked Confirm would turn an advisory into a second gate — one this
    // surface would be deciding from a value it cannot verify.
    expect(
      confirmBlockedReason({ state: 'planned', plan: plan([importRow(FULL, true)]), scope: 'user' })
    ).toBeNull();
  });

  it('does not change the save the commit sends', () => {
    // Same document, same request, whether or not the advisory fired. If the
    // flag altered the payload it would be part of the gate rather than a
    // description of the document.
    const advised = buildImportSave(plan([importRow(FULL, true)]), 'user', []);
    const silent = buildImportSave(plan([importRow(FULL, false)]), 'user', []);
    expect(advised).toEqual(silent);
    expect(advised?.phases[0]).toHaveProperty('retryCondition', 'open_questions > 0');
  });
});

describe('Feature 084 — a refusal states a reason (T051, FR-057)', () => {
  it('never returns a bare code', () => {
    for (const code of [
      'unreadable',
      'too-large',
      'unsupported-version',
      'unsupported-kind',
      'disallowed-syntax',
      'multi-document',
      'empty'
    ] as const) {
      const headline = refusalHeadline(code);
      expect(headline).not.toBe(code);
      expect(headline).not.toContain(code);
      // A sentence, not a fragment.
      expect(headline.endsWith('.')).toBe(true);
    }
  });

  it('falls back to a sentence for a code this bundle does not know', () => {
    // A host newer than the webview bundle. The panel must still read as a
    // refusal rather than going blank; the host's own message and the code are
    // rendered beside this, so nothing is lost.
    const unknown = 'a-code-from-a-later-build' as Parameters<typeof refusalHeadline>[0];
    expect(refusalHeadline(unknown)).toBe('This document was not accepted.');
  });
});

describe('Feature 084 — confirmation availability (FR-036, FR-056, FR-057)', () => {
  const ready = { state: 'planned' as const, plan: plan([importRow()]), scope: 'user' as const };

  it('is available once there is a plan with an import row and a chosen scope', () => {
    expect(confirmBlockedReason(ready)).toBeNull();
  });

  it('is unavailable with a stated reason while preflight is still running', () => {
    const reason = confirmBlockedReason({ ...ready, state: 'validating' });
    expect(reason).toBeTruthy();
    expect(reason).toContain('still being read');
  });

  it('is unavailable with a stated reason for a refused document', () => {
    const reason = confirmBlockedReason({ state: 'refused', plan: null, scope: 'user' });
    expect(reason).toContain('refused');
  });

  it('is unavailable with a stated reason on a plan with no import rows', () => {
    const reason = confirmBlockedReason({ ...ready, plan: plan([SKIP_ROW, INVALID_ROW]) });
    expect(reason).toContain('nothing to import');
  });

  // FR-056: no default. An unchosen scope is not silently the workspace.
  it('is unavailable until the operator chooses a scope, and says so', () => {
    const reason = confirmBlockedReason({ ...ready, scope: null });
    expect(reason).toContain('Choose');
  });

  it('is unavailable while a commit is already in flight', () => {
    const reason = confirmBlockedReason({ ...ready, state: 'committing' });
    expect(reason).toContain('in progress');
  });

  it('states a reason for every state that is not a confirmable plan', () => {
    for (const state of ['idle', 'validating', 'canceled', 'refused', 'failed'] as const) {
      expect(confirmBlockedReason({ state, plan: null, scope: 'user' })).toBeTruthy();
    }
  });
});

describe('Feature 084 — the save row built from a document (FR-046a)', () => {
  it('carries every declared field verbatim, renaming only the identity key', () => {
    expect(savePhaseRowFromDefinition(FULL)).toEqual({
      id: 'brought-in',
      name: 'Brought In',
      description: 'As authored.',
      version: 7,
      instruction: 'Do the thing.',
      model: 'claude-opus-4',
      effort: 'high',
      timeoutSeconds: 900,
      loopable: true,
      retryCondition: 'open_questions > 0',
      isRequired: false,
      runner: 'claude'
    });
  });

  it('declares no field the document left out', () => {
    const row = savePhaseRowFromDefinition({
      phaseId: 'lean',
      name: 'Lean',
      version: 2,
      skill: 'speckit-plan'
    });
    expect(Object.keys(row).sort()).toEqual(['id', 'name', 'skill', 'version']);
  });
});

describe('Feature 084 — the commit request (FR-037, FR-038, FR-046a)', () => {
  it('appends the imported row to the chosen layer and gates on that layer revision', () => {
    const request = buildImportSave(plan([importRow()]), 'user', [HELD]);
    expect(request).toEqual({
      scope: 'user',
      expectedRevision: 'user-rev-1',
      mutation: { kind: 'import', phaseId: 'brought-in' },
      phases: [HELD, savePhaseRowFromDefinition(FULL)]
    });
  });

  // FR-038: the gate is the revision the PLAN was computed against, per scope.
  it('takes the expected revision from the scope the operator chose', () => {
    expect(buildImportSave(plan([importRow()]), 'workspace', [])?.expectedRevision).toBe(
      'workspace-rev-1'
    );
  });

  // The layer rows are passed through untouched, so a row the catalog could not
  // parse is carried across rather than dropped by the import.
  it('preserves the layer it was given, in order', () => {
    const unparseable = { id: 'broken', name: 'Invalid Phase', version: 1 };
    const request = buildImportSave(plan([importRow()]), 'workspace', [HELD, unparseable]);
    expect(request?.phases.slice(0, 2)).toEqual([HELD, unparseable]);
  });

  it('builds nothing for a plan with no import rows', () => {
    expect(buildImportSave(plan([SKIP_ROW]), 'user', [HELD])).toBeNull();
  });

  // FR-044: one Phase per document. The shared save intent can declare exactly
  // one added identity, so a multi-row plan is refused here rather than being
  // written as a partial import.
  it('builds nothing for a plan carrying more than one import row', () => {
    const second = importRow({ ...FULL, phaseId: 'also-in', name: 'Also In' });
    expect(buildImportSave(plan([importRow(), second]), 'user', [])).toBeNull();
  });
});

describe('Feature 084 — projecting the save ack onto the plan (FR-042, FR-044)', () => {
  const mixed = plan([importRow(), SKIP_ROW, INVALID_ROW]);

  it('produces exactly one result per plan row, in order', () => {
    const results = projectSaveAck(mixed, { status: 'accepted' }, 'user');
    expect(results).toHaveLength(mixed.rows.length);
    expect(results.map((row) => row.resourceId)).toEqual(['brought-in', 'specify', null]);
  });

  it('reports every import row as imported when the save was accepted', () => {
    const results = projectSaveAck(mixed, { status: 'accepted' }, 'user');
    expect(results[0]).toMatchObject({ outcome: 'imported' });
    expect(results[0].detail).toContain('user');
  });

  // FR-044a: the commit is all-or-nothing, so a rejection cannot leave a row
  // reporting success.
  it('reports every import row as failed, with the reason, when the save was rejected', () => {
    const results = projectSaveAck(mixed, { status: 'rejected', reason: 'stale-catalog' }, 'user');
    expect(results[0].outcome).toBe('failed');
    expect(results[0].detail).toContain('stale-catalog');
    // FR-038 — the operator is told the plan has to be recomputed.
    expect(results[0].detail).toContain('reapply');
  });

  it('keeps the preflight outcome and reason for rows the commit never touched', () => {
    const results = projectSaveAck(mixed, { status: 'rejected', reason: 'phase-denied' }, 'user');
    expect(results[1]).toEqual({
      resourceId: 'specify',
      outcome: 'skipped',
      detail: reasonLines(SKIP_ROW).join(' ')
    });
    expect(results[2]).toEqual({
      resourceId: null,
      outcome: 'invalid',
      detail: reasonLines(INVALID_ROW).join(' ')
    });
  });

  // FR-046 — the origin named is the scope the operator picked, never anything
  // the document claimed.
  it('names the scope the write landed in', () => {
    const results = projectSaveAck(mixed, { status: 'accepted' }, 'workspace');
    expect(results[0].detail).toContain('workspace');
  });
});
