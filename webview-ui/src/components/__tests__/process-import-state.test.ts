// Feature 084 T037/T039/T040 — the import surface's decisions, as pure functions.
//
// Everything the commit decides lives outside the component so it can be pinned
// directly: which scope is offerable (FR-035), when confirmation is unavailable
// and why (FR-036, FR-057), what the save carries (FR-037, FR-038, FR-046a), and
// how the save's single ack becomes a per-row result (FR-042, FR-044).

import { describe, expect, it, vi } from 'vitest';
import type { ImportPlan, ImportPlanRow } from '../../lib/messages';
import type { SavePhasesRequest, SavePhasesResult } from '../../lib/save-phases';
import type { SavePipelinesRequest, SavePipelinesResult } from '../../lib/save-pipelines';
import {
  IMPORT_TARGET_SCOPES,
  buildImportWrites,
  commitOutcome,
  commitOutcomeStatement,
  commitStatement,
  confirmBlockedReason,
  eligibleRows,
  phaseImportRows,
  pipelineImportRows,
  projectCommitResults,
  reasonLines,
  refusalHeadline,
  resourceKindLabel,
  runImportCommit,
  savePhaseRowFromDefinition,
  savePipelineRowFromDefinition,
  type ImportLayerResult,
  type ImportTargetLayers,
  type ImportedPhaseDefinition,
  type ImportedPipelineDefinition
} from '../ProcessImport/process-import-state';

const REVISIONS = Object.freeze({ user: 'user-rev-1', workspace: 'workspace-rev-1' });
const PIPELINE_REVISIONS = Object.freeze({
  user: 'user-pipe-rev-1',
  workspace: 'workspace-pipe-rev-1'
});

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
    resourceKind: 'phase',
    resourceId: definition.phaseId,
    name: definition.name,
    requiresRetryConditionCapability,
    definition
  };
}

const SKIP_ROW: ImportPlanRow = {
  outcome: 'skip',
  resourceKind: 'phase',
  resourceId: 'specify',
  name: 'Specify',
  presentIn: 'user',
  presentRowStatus: 'invalid'
};

const INVALID_ROW: ImportPlanRow = {
  outcome: 'invalid',
  resourceKind: 'phase',
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
      blocked: rows.filter((row) => row.outcome === 'blocked').length,
      invalid: rows.filter((row) => row.outcome === 'invalid').length
    },
    computedAgainstRevision: REVISIONS
  };
}

/**
 * Feature 085 — a Pipeline `import` row. The definition is the minimal shipped
 * `PipelineDefinition`, named separately because T048's write reads inside it.
 */
const PIPELINE_DEFINITION: ImportedPipelineDefinition = {
  pipelineId: 'ship-it',
  name: 'Ship It',
  version: 1,
  phaseIds: ['specify'],
  inputs: [],
  outputs: [],
  bindings: [],
  recommendedNext: []
};

const PIPELINE_IMPORT_ROW: ImportPlanRow = {
  outcome: 'import',
  resourceKind: 'pipeline',
  resourceId: 'ship-it',
  name: 'Ship It',
  definition: PIPELINE_DEFINITION
};

const BLOCKED_PIPELINE_ROW: ImportPlanRow = {
  outcome: 'blocked',
  resourceKind: 'pipeline',
  resourceId: 'ship-it',
  name: 'Ship It',
  reason: { code: 'dependency-absent', phaseId: 'specify' }
};

/**
 * A plan that also carries the Pipeline catalog's revisions — what preflight
 * produces for any document declaring a Pipeline (FR-043). `plan()` stays the
 * Phase-only shape, so the two cases cannot be confused in a test's fixtures.
 */
function packagePlan(rows: readonly ImportPlanRow[]): ImportPlan {
  return { ...plan(rows), computedAgainstPipelineRevision: PIPELINE_REVISIONS };
}

const HELD = Object.freeze({ id: 'held', name: 'Held', version: 4, instruction: 'Hold.' });
const HELD_PIPELINE = Object.freeze({
  id: 'held-pipeline',
  name: 'Held Pipeline',
  version: 2,
  phases: ['specify']
});

const EMPTY_LAYERS: ImportTargetLayers = { phases: [], pipelines: [] };

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
    const advised = buildImportWrites(plan([importRow(FULL, true)]), 'user', EMPTY_LAYERS);
    const silent = buildImportWrites(plan([importRow(FULL, false)]), 'user', EMPTY_LAYERS);
    expect(advised).toEqual(silent);
    const request = advised[0].request as SavePhasesRequest;
    expect(request.phases[0]).toHaveProperty('retryCondition', 'open_questions > 0');
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

describe('Feature 085 T035 — the plan is kind-tagged (FR-056)', () => {
  it('labels each row with its own kind, not the document with one', () => {
    // A package declares both, so the label is a property of the row. Reading
    // it off the document would put "Pipeline" on every included Phase.
    expect(resourceKindLabel(PIPELINE_IMPORT_ROW)).toBe('Pipeline');
    expect(resourceKindLabel(importRow())).toBe('Phase');
    expect(resourceKindLabel(SKIP_ROW)).toBe('Phase');
  });

  it('partitions the import rows by kind, in plan order', () => {
    // The two are written by different layer saves in a fixed order (FR-038),
    // so they are separated here rather than at the write.
    const both = plan([importRow(), PIPELINE_IMPORT_ROW, SKIP_ROW]);
    expect(phaseImportRows(both).map((row) => row.resourceId)).toEqual(['brought-in']);
    expect(pipelineImportRows(both).map((row) => row.resourceId)).toEqual(['ship-it']);
    expect(eligibleRows(both)).toHaveLength(2);
  });

  it('counts a Pipeline-only plan as eligible — eligibility reads no kind (FR-057)', () => {
    // A references-only package whose dependencies are all present has no Phase
    // row at all. Answering "nothing to import" for it would describe a
    // different document.
    const references = plan([PIPELINE_IMPORT_ROW, SKIP_ROW]);
    expect(eligibleRows(references)).toHaveLength(1);
    expect(phaseImportRows(references)).toHaveLength(0);
  });

  it('treats a blocked Pipeline as ineligible, not as a Pipeline to write', () => {
    expect(eligibleRows(plan([BLOCKED_PIPELINE_ROW]))).toHaveLength(0);
    expect(pipelineImportRows(plan([BLOCKED_PIPELINE_ROW]))).toHaveLength(0);
  });
});

describe('Feature 085 T048 — confirmation with a package in the plan (FR-057)', () => {
  it('confirms a plan whose only eligible row is a Pipeline', () => {
    // A references-only package. Eligibility reads no kind, and as of T048
    // neither does writability — the Pipeline layer write is the whole commit.
    expect(
      confirmBlockedReason({
        state: 'planned',
        plan: packagePlan([PIPELINE_IMPORT_ROW, SKIP_ROW]),
        scope: 'user'
      })
    ).toBeNull();
  });

  it('reports "nothing to import" when no row is eligible, whatever the kinds', () => {
    const reason = confirmBlockedReason({
      state: 'planned',
      plan: plan([BLOCKED_PIPELINE_ROW, SKIP_ROW, INVALID_ROW]),
      scope: 'user'
    });
    expect(reason).toContain('nothing to import');
  });

  it('confirms a multi-Phase package — the ordered two-layer write exists now', () => {
    const second = importRow({ ...FULL, phaseId: 'also-in', name: 'Also In' });
    expect(
      confirmBlockedReason({
        state: 'planned',
        plan: packagePlan([importRow(), second, PIPELINE_IMPORT_ROW]),
        scope: 'user'
      })
    ).toBeNull();
  });

  it('still confirms an ordinary single-Phase document', () => {
    expect(
      confirmBlockedReason({ state: 'planned', plan: plan([importRow()]), scope: 'user' })
    ).toBeNull();
  });

  // FR-040 for the Pipeline layer. Its write needs its own expected revision;
  // without one there is no staleness gate to present, so the commit is held
  // rather than made ungated.
  it('holds closed a Pipeline plan carrying no Pipeline revision, and says why', () => {
    const reason = confirmBlockedReason({
      state: 'planned',
      plan: plan([PIPELINE_IMPORT_ROW]),
      scope: 'user'
    });
    expect(reason).toContain('Pipeline catalog revision');
    expect(reason).not.toContain('nothing to import');
    // And nothing partial is buildable from it either — not even the Phase half
    // of a plan that also had Phases.
    expect(buildImportWrites(plan([importRow(), PIPELINE_IMPORT_ROW]), 'user', EMPTY_LAYERS))
      .toEqual([]);
  });
});

describe('Feature 085 T035 — what confirming will write, stated first (FR-058)', () => {
  it('names the eligible count and the chosen scope, and excludes the rest', () => {
    const statement = commitStatement(plan([importRow(), SKIP_ROW, INVALID_ROW]), 'user');
    expect(statement).toContain('1 resource');
    expect(statement).toContain('user layer');
    expect(statement).toContain('nothing else');
    expect(statement).toContain('2 rows are left unchanged');
  });

  it('says a scope is what it is waiting for, rather than naming a default', () => {
    // FR-046 — the target is the operator's choice and never the document's, so
    // an unchosen scope must not read as one already picked.
    const statement = commitStatement(plan([importRow()]), null);
    expect(statement).toContain('the scope you choose');
    for (const scope of ['user layer', 'workspace layer']) {
      expect(statement).not.toContain(scope);
    }
  });

  it('mentions no leftover when every row is eligible', () => {
    const statement = commitStatement(plan([importRow(), PIPELINE_IMPORT_ROW]), 'workspace');
    expect(statement).toContain('2 resources');
    expect(statement).toContain('workspace layer');
    expect(statement).not.toContain('unchanged');
  });

  it('says nothing would be written when no row is eligible', () => {
    const statement = commitStatement(plan([SKIP_ROW, INVALID_ROW]), 'user');
    expect(statement).toContain('write nothing');
    // It must not name a count of resources it would write, which is zero.
    expect(statement).not.toContain('0 resources');
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

describe('Feature 085 T048 — the Pipeline save row built from a document (FR-046a)', () => {
  it('carries every declared field verbatim, renaming only the two key names', () => {
    expect(savePipelineRowFromDefinition(PIPELINE_DEFINITION)).toEqual({
      id: 'ship-it',
      name: 'Ship It',
      version: 1,
      phases: ['specify'],
      inputs: [],
      outputs: [],
      bindings: [],
      recommendedNext: []
    });
  });

  it('copies the phase sequence rather than aliasing the plan’s array', () => {
    const row = savePipelineRowFromDefinition(PIPELINE_DEFINITION);
    expect(row.phases).not.toBe(PIPELINE_DEFINITION.phaseIds);
    expect(row.phases).toEqual(PIPELINE_DEFINITION.phaseIds);
  });
});

describe('Feature 084/085 — the commit writes (FR-037, FR-038, FR-043, FR-046a)', () => {
  it('appends the imported row to the chosen layer and gates on that layer revision', () => {
    const writes = buildImportWrites(plan([importRow()]), 'user', {
      phases: [HELD],
      pipelines: []
    });
    expect(writes).toEqual([
      {
        key: 'phases',
        request: {
          scope: 'user',
          expectedRevision: 'user-rev-1',
          mutation: { kind: 'import', phaseId: 'brought-in' },
          phases: [HELD, savePhaseRowFromDefinition(FULL)]
        }
      }
    ]);
  });

  // FR-038: the gate is the revision the PLAN was computed against, per scope.
  it('takes the expected revision from the scope the operator chose', () => {
    const writes = buildImportWrites(plan([importRow()]), 'workspace', EMPTY_LAYERS);
    expect(writes[0].request.expectedRevision).toBe('workspace-rev-1');
  });

  // The layer rows are passed through untouched, so a row the catalog could not
  // parse is carried across rather than dropped by the import.
  it('preserves the layer it was given, in order', () => {
    const unparseable = { id: 'broken', name: 'Invalid Phase', version: 1 };
    const writes = buildImportWrites(plan([importRow()]), 'workspace', {
      phases: [HELD, unparseable],
      pipelines: []
    });
    expect((writes[0].request as SavePhasesRequest).phases.slice(0, 2)).toEqual([
      HELD,
      unparseable
    ]);
  });

  it('builds nothing for a plan with no import rows', () => {
    expect(buildImportWrites(plan([SKIP_ROW]), 'user', { phases: [HELD], pipelines: [] })).toEqual(
      []
    );
  });

  // FR-038 — the Phase layer is written FIRST and unconditionally. A Pipeline
  // referencing a Phase this same document supplies does not validate until that
  // Phase is in the catalog, so the reverse order would refuse a package that is
  // internally consistent.
  it('orders a package as the Phase layer then the Pipeline layer', () => {
    const writes = buildImportWrites(
      packagePlan([PIPELINE_IMPORT_ROW, importRow()]),
      'user',
      EMPTY_LAYERS
    );
    expect(writes.map((write) => write.key)).toEqual(['phases', 'pipelines']);
  });

  // FR-043 — two writes, two catalogs, two revisions. One map cannot gate both.
  it('gates each layer on its own catalog revision', () => {
    const writes = buildImportWrites(
      packagePlan([importRow(), PIPELINE_IMPORT_ROW]),
      'workspace',
      EMPTY_LAYERS
    );
    expect(writes[0].request.expectedRevision).toBe('workspace-rev-1');
    expect(writes[1].request.expectedRevision).toBe('workspace-pipe-rev-1');
  });

  it('declares exactly one intent per layer, naming every id it adds', () => {
    const second = importRow({ ...FULL, phaseId: 'also-in', name: 'Also In' });
    const writes = buildImportWrites(
      packagePlan([importRow(), second, PIPELINE_IMPORT_ROW]),
      'user',
      EMPTY_LAYERS
    );
    expect(writes[0].request.mutation).toEqual({
      kind: 'import-package',
      phaseIds: ['brought-in', 'also-in']
    });
    expect(writes[1].request.mutation).toEqual({
      kind: 'import-package',
      pipelineIds: ['ship-it']
    });
  });

  // The distinction is observable — the host answers a `stale-catalog` rejection
  // with different legal actions per intent kind — so the shipped standalone
  // path keeps the intent it shipped with.
  it('keeps the single-Phase standalone intent as `import`, not `import-package`', () => {
    const standalone = buildImportWrites(plan([importRow()]), 'user', EMPTY_LAYERS);
    expect(standalone[0].request.mutation).toEqual({ kind: 'import', phaseId: 'brought-in' });
    // One Phase, but a package: the Phase write is part of an ordered pair, so
    // it declares the package intent.
    const withPipeline = buildImportWrites(
      packagePlan([importRow(), PIPELINE_IMPORT_ROW]),
      'user',
      EMPTY_LAYERS
    );
    expect(withPipeline[0].request.mutation).toEqual({
      kind: 'import-package',
      phaseIds: ['brought-in']
    });
  });

  it('appends the Pipeline row to the stored Pipeline layer, in order', () => {
    const writes = buildImportWrites(packagePlan([PIPELINE_IMPORT_ROW]), 'user', {
      phases: [],
      pipelines: [HELD_PIPELINE]
    });
    expect((writes[0].request as SavePipelinesRequest).pipelines).toEqual([
      HELD_PIPELINE,
      savePipelineRowFromDefinition(PIPELINE_DEFINITION)
    ]);
  });

  // Half a package is the one outcome no requirement admits, so a plan missing
  // the Pipeline revision yields no writes at all — not the Phase half.
  it('builds nothing at all when a Pipeline row has no revision to gate on', () => {
    expect(
      buildImportWrites(plan([importRow(), PIPELINE_IMPORT_ROW]), 'user', EMPTY_LAYERS)
    ).toEqual([]);
  });
});

describe('Feature 085 T048 — the whole-commit outcome (FR-042a)', () => {
  const accepted = (key: 'phases' | 'pipelines'): ImportLayerResult => ({
    key,
    ack: { status: 'accepted' }
  });
  const rejected = (key: 'phases' | 'pipelines', reason: string): ImportLayerResult => ({
    key,
    ack: { status: 'rejected', reason }
  });

  it('is imported when every write it sent was accepted', () => {
    expect(commitOutcome([accepted('phases'), accepted('pipelines')])).toBe('imported');
    expect(commitOutcome([accepted('phases')])).toBe('imported');
  });

  it('is failed when nothing it sent was accepted', () => {
    expect(commitOutcome([rejected('phases', 'stale-catalog')])).toBe('failed');
  });

  // The case the two-layer write introduced, and the reason the outcome has a
  // third value: the layers are independently gated.
  it('is partial when the Phase layer landed and the Pipeline layer did not', () => {
    expect(commitOutcome([accepted('phases'), rejected('pipelines', 'stale-catalog')])).toBe(
      'partial'
    );
  });

  it('is failed, not imported, when it sent nothing', () => {
    // A plan `buildImportWrites` refused. Calling it success would put an
    // "imported" line under a document that was never written.
    expect(commitOutcome([])).toBe('failed');
  });
});

describe('Feature 085 T048 — the outcome sentence (FR-042b, FR-042c)', () => {
  it('names the scope on a complete import', () => {
    expect(commitOutcomeStatement('imported', 'workspace')).toContain('workspace layer');
  });

  it('says nothing was written on a failure', () => {
    expect(commitOutcomeStatement('failed', 'user')).toContain('Nothing was written');
  });

  it('states that a partial write was left in place and how to finish it', () => {
    // FR-042c — no compensating delete happened, so the sentence must not imply
    // a rollback; FR-042b — the recovery is re-running the same document, which
    // is safe because an already-present id is a skip.
    const statement = commitOutcomeStatement('partial', 'user');
    expect(statement).toContain('user layer');
    expect(statement).toContain('still there');
    expect(statement.toLowerCase()).toContain('same document');
    for (const undone of ['rolled back', 'removed', 'reverted', 'undo']) {
      expect(statement.toLowerCase()).not.toContain(undone);
    }
  });
});

describe('Feature 085 T048 — projecting the layer acks onto the plan (FR-042, FR-042a)', () => {
  const mixed = plan([importRow(), SKIP_ROW, INVALID_ROW]);
  const bothKinds = packagePlan([importRow(), PIPELINE_IMPORT_ROW, SKIP_ROW]);

  it('produces exactly one result per plan row, in order', () => {
    const results = projectCommitResults(mixed, 'user', [
      { key: 'phases', ack: { status: 'accepted' } }
    ]);
    expect(results).toHaveLength(mixed.rows.length);
    expect(results.map((row) => row.resourceId)).toEqual(['brought-in', 'specify', null]);
  });

  it('reports every import row as imported when its layer was accepted', () => {
    const results = projectCommitResults(mixed, 'user', [
      { key: 'phases', ack: { status: 'accepted' } }
    ]);
    expect(results[0]).toMatchObject({ outcome: 'imported' });
    expect(results[0].detail).toContain('user');
  });

  it('reports every import row as failed, with the reason, when its layer was rejected', () => {
    const results = projectCommitResults(mixed, 'user', [
      { key: 'phases', ack: { status: 'rejected', reason: 'stale-catalog' } }
    ]);
    expect(results[0].outcome).toBe('failed');
    expect(results[0].detail).toContain('stale-catalog');
    // FR-040 — the operator is told the plan has to be recomputed.
    expect(results[0].detail).toContain('reapply');
  });

  it('keeps the preflight outcome and reason for rows the commit never touched', () => {
    const results = projectCommitResults(mixed, 'user', [
      { key: 'phases', ack: { status: 'rejected', reason: 'phase-denied' } }
    ]);
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
    const results = projectCommitResults(mixed, 'workspace', [
      { key: 'phases', ack: { status: 'accepted' } }
    ]);
    expect(results[0].detail).toContain('workspace');
  });

  // FR-042a — the partial outcome, reported exactly. Each row reads the ack of
  // ITS OWN layer, which is the only way both halves can be true at once.
  it('reports the Phases imported and the Pipeline failed, in one table', () => {
    const results = projectCommitResults(bothKinds, 'user', [
      { key: 'phases', ack: { status: 'accepted' } },
      { key: 'pipelines', ack: { status: 'rejected', reason: 'stale-catalog' } }
    ]);
    expect(results[0]).toMatchObject({ resourceId: 'brought-in', outcome: 'imported' });
    expect(results[1].resourceId).toBe('ship-it');
    expect(results[1].outcome).toBe('failed');
    expect(results[1].detail).toContain('stale-catalog');
    expect(results[2].outcome).toBe('skipped');
  });

  it('uses the Pipeline rejection formatter for a Pipeline row', () => {
    // Not the Phase formatter: the two read different structured payloads, and
    // a Pipeline blocked by dependents must name them.
    const results = projectCommitResults(bothKinds, 'user', [
      { key: 'phases', ack: { status: 'accepted' } },
      {
        key: 'pipelines',
        ack: {
          status: 'rejected',
          reason: 'pipeline-validation',
          result: { errors: [{ pipelineId: 'ship-it', field: 'phases', message: 'unknown Phase' }] }
        }
      }
    ]);
    expect(results[1].detail).toContain('ship-it.phases');
    expect(results[1].detail).toContain('unknown Phase');
  });

  it('says a layer was never reached rather than borrowing the other one’s reason', () => {
    // The Phase write was refused, so the sequence stopped. The Pipeline row was
    // not rejected — it was never sent — and reporting the Phase layer's reason
    // against it would send the operator to fix the wrong thing.
    const results = projectCommitResults(bothKinds, 'user', [
      { key: 'phases', ack: { status: 'rejected', reason: 'stale-catalog' } }
    ]);
    expect(results[0].detail).toContain('stale-catalog');
    expect(results[1].outcome).toBe('failed');
    expect(results[1].detail).toContain('stopped before this layer');
    expect(results[1].detail).not.toContain('stale-catalog');
  });
});

describe('Feature 085 T048 — running the commit (FR-038, FR-042, FR-042c)', () => {
  const bothKinds = packagePlan([importRow(), PIPELINE_IMPORT_ROW]);

  function deps(
    phaseAck: SavePhasesResult,
    pipelineAck: SavePipelinesResult
  ): {
    readonly savePhases: ReturnType<typeof vi.fn>;
    readonly savePipelines: ReturnType<typeof vi.fn>;
  } {
    return {
      savePhases: vi.fn(async (_request: SavePhasesRequest) => phaseAck),
      savePipelines: vi.fn(async (_request: SavePipelinesRequest) => pipelineAck)
    };
  }

  it('sends the Phase write before the Pipeline write', async () => {
    const order: string[] = [];
    const report = await runImportCommit(bothKinds, 'user', EMPTY_LAYERS, {
      savePhases: async () => {
        order.push('phases');
        return { status: 'accepted' };
      },
      savePipelines: async () => {
        order.push('pipelines');
        return { status: 'accepted' };
      }
    });
    expect(order).toEqual(['phases', 'pipelines']);
    expect(report.outcome).toBe('imported');
  });

  it('stops at the first rejection and never sends the second write', async () => {
    const injected = deps({ status: 'rejected', reason: 'stale-catalog' }, { status: 'accepted' });
    const report = await runImportCommit(bothKinds, 'user', EMPTY_LAYERS, injected);
    expect(injected.savePhases).toHaveBeenCalledTimes(1);
    expect(injected.savePipelines).not.toHaveBeenCalled();
    expect(report.outcome).toBe('failed');
  });

  // FR-042c — the failed second write triggers no compensating delete. The only
  // way to see that from here is that nothing further is sent at all.
  it('sends no third write to undo the first when the second is refused', async () => {
    const injected = deps({ status: 'accepted' }, { status: 'rejected', reason: 'stale-catalog' });
    const report = await runImportCommit(bothKinds, 'user', EMPTY_LAYERS, injected);
    expect(injected.savePhases).toHaveBeenCalledTimes(1);
    expect(injected.savePipelines).toHaveBeenCalledTimes(1);
    expect(report.outcome).toBe('partial');
    expect(report.rows[0].outcome).toBe('imported');
    expect(report.rows[1].outcome).toBe('failed');
  });

  it('sends nothing, and reports failure, for a plan it cannot build writes for', async () => {
    const injected = deps({ status: 'accepted' }, { status: 'accepted' });
    // No Pipeline revision — the plan is unwritable, so the commit is a no-op.
    const report = await runImportCommit(
      plan([PIPELINE_IMPORT_ROW]),
      'user',
      EMPTY_LAYERS,
      injected
    );
    expect(injected.savePhases).not.toHaveBeenCalled();
    expect(injected.savePipelines).not.toHaveBeenCalled();
    expect(report.outcome).toBe('failed');
    expect(report.results).toEqual([]);
  });

  it('carries the built request through to the save it belongs to', async () => {
    const injected = deps({ status: 'accepted' }, { status: 'accepted' });
    await runImportCommit(bothKinds, 'workspace', EMPTY_LAYERS, injected);
    expect(injected.savePhases).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'workspace', expectedRevision: 'workspace-rev-1' })
    );
    expect(injected.savePipelines).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'workspace', expectedRevision: 'workspace-pipe-rev-1' })
    );
  });
});
