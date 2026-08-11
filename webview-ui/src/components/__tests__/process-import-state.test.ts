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
import type { SaveWorkflowsRequest, SaveWorkflowsResult } from '../../lib/save-workflows';
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
  saveWorkflowRowFromDefinition,
  workflowImportRows,
  type ImportLayerKey,
  type ImportLayerResult,
  type ImportTargetLayers,
  type ImportedPhaseDefinition,
  type ImportedPipelineDefinition,
  type ImportedWorkflowDefinition
} from '../ProcessImport/process-import-state';

const REVISIONS = Object.freeze({ user: 'user-rev-1', workspace: 'workspace-rev-1' });
const PIPELINE_REVISIONS = Object.freeze({
  user: 'user-pipe-rev-1',
  workspace: 'workspace-pipe-rev-1'
});
const WORKFLOW_REVISIONS = Object.freeze({
  user: 'user-flow-rev-1',
  workspace: 'workspace-flow-rev-1'
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
  reason: { code: 'dependency-absent', dependency: { kind: 'phase', resourceId: 'specify' } }
};

/**
 * Feature 086 T054 — every portable Workflow field, so a dropped one is visible
 * rather than plausible. The connection carries all four of its optional fields
 * because the write forwards the graph verbatim and a rewritten one is exactly
 * what FR-046a forbids.
 */
const FULL_WORKFLOW: ImportedWorkflowDefinition = {
  workflowId: 'ship-it-flow',
  name: 'Ship It Flow',
  description: 'As authored.',
  version: 4,
  nodes: [
    { nodeId: 'draft', pipelineId: 'ship-it', label: 'Draft it' },
    { nodeId: 'review', pipelineId: 'ship-it' }
  ],
  connections: [
    {
      from: { nodeId: 'draft', portId: 'out' },
      to: { nodeId: 'review', portId: 'in' },
      condition: {
        left: { source: 'node-output', nodeId: 'draft', field: 'verdict' },
        operator: 'equals',
        right: 'ship'
      },
      priority: 2,
      isDefault: false,
      selection: 'exactlyOne'
    }
  ],
  startNodeIds: ['draft']
};

/** Feature 086 — a Workflow `import` row, the third layer's write source. */
const WORKFLOW_IMPORT_ROW: ImportPlanRow = {
  outcome: 'import',
  resourceKind: 'workflow',
  resourceId: 'ship-it-flow',
  name: 'Ship It Flow',
  definition: {
    workflowId: 'ship-it-flow',
    name: 'Ship It Flow',
    version: 1,
    nodes: [{ nodeId: 'draft', pipelineId: 'ship-it' }],
    connections: [],
    startNodeIds: ['draft']
  }
};

/** A Workflow waiting on a Pipeline — the dependency direction 086 adds. */
const BLOCKED_WORKFLOW_ROW: ImportPlanRow = {
  outcome: 'blocked',
  resourceKind: 'workflow',
  resourceId: 'ship-it-flow',
  name: 'Ship It Flow',
  reason: {
    code: 'dependency-blocked',
    dependency: { kind: 'pipeline', resourceId: 'ship-it' },
    via: { kind: 'phase', resourceId: 'specify' }
  }
};

/**
 * A plan that also carries the Pipeline catalog's revisions — what preflight
 * produces for any document declaring a Pipeline (FR-043). `plan()` stays the
 * Phase-only shape, so the two cases cannot be confused in a test's fixtures.
 */
function packagePlan(rows: readonly ImportPlanRow[]): ImportPlan {
  return { ...plan(rows), computedAgainstPipelineRevision: PIPELINE_REVISIONS };
}

/**
 * A plan carrying all three revision maps — what preflight produces for a
 * document declaring a Workflow (FR-036). Kept separate from `packagePlan` for
 * the same reason that one is separate from `plan`: the three shapes are what
 * distinguish a writable layer from an absent one, and one fixture covering all
 * of them would make every "held closed" case unreachable.
 */
function workflowPackagePlan(rows: readonly ImportPlanRow[]): ImportPlan {
  return { ...packagePlan(rows), computedAgainstWorkflowRevision: WORKFLOW_REVISIONS };
}

/** A references-only Workflow package: nothing to write but the Workflow itself. */
function workflowOnlyPlan(rows: readonly ImportPlanRow[]): ImportPlan {
  return { ...plan(rows), computedAgainstWorkflowRevision: WORKFLOW_REVISIONS };
}

const HELD = Object.freeze({ id: 'held', name: 'Held', version: 4, instruction: 'Hold.' });
const HELD_PIPELINE = Object.freeze({
  id: 'held-pipeline',
  name: 'Held Pipeline',
  version: 2,
  phases: ['specify']
});
const HELD_WORKFLOW = Object.freeze({
  workflowId: 'held-flow',
  name: 'Held Flow',
  version: 3,
  nodes: [Object.freeze({ nodeId: 'only', pipelineId: 'held-pipeline' })],
  connections: [],
  startNodeIds: ['only']
});

const EMPTY_LAYERS: ImportTargetLayers = { phases: [], pipelines: [], workflows: [] };

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

  // Feature 086 T038. The label has to be total over the kind union, not a
  // two-way test with a fallback: a fallback names the Workflow row "Phase",
  // which is a wrong statement about which catalog the operator is changing
  // rather than a missing one, and it points them at the wrong editor to fix it.
  it('labels a Workflow row as its own kind (FR-056)', () => {
    expect(resourceKindLabel(WORKFLOW_IMPORT_ROW)).toBe('Workflow');
    expect(
      resourceKindLabel({
        outcome: 'skip',
        resourceKind: 'workflow',
        resourceId: 'ship-it-flow',
        name: 'Ship It Flow',
        presentIn: 'workspace',
        presentRowStatus: 'shadowed'
      })
    ).toBe('Workflow');
  });

  it('names every kind exactly once across the row union', () => {
    // Pins totality rather than the three cases: a fourth kind added to the
    // contract without a label here shows up as a duplicate, because the
    // fallback would answer with a kind that already has its own row.
    const labels = [importRow(), PIPELINE_IMPORT_ROW, WORKFLOW_IMPORT_ROW].map(resourceKindLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('states a blocked Workflow row reason naming the Pipeline it waits on', () => {
    // The dependency direction 086 adds. A hard-coded "Phase" here would send
    // the operator to the Phase catalog for a Pipeline that is what is missing.
    const [line] = reasonLines(BLOCKED_WORKFLOW_ROW);
    expect(line).toContain('Pipeline ship-it');
    expect(line).not.toContain('Phase ship-it');
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

describe('Feature 086 T046 — the propagated chain is rendered whole (FR-039, FR-040)', () => {
  it('names all three links: the selected resource, the intermediate, and the root cause', () => {
    // FR-039 asks the operator be able to "trace the chain to its origin". One
    // line naming only the immediate dependency cannot do that: it says the
    // Pipeline is blocked without saying what would unblock it, so the operator
    // opens the Pipeline row, finds it also blocked, and walks the table by hand.
    const lines = reasonLines(BLOCKED_WORKFLOW_ROW);
    const text = lines.join(' ');

    expect(text).toContain('Workflow ship-it-flow');
    expect(text).toContain('Pipeline ship-it');
    expect(text).toContain('Phase specify');
  });

  it('orders the chain from the selected resource to the root cause', () => {
    // Direction is the whole point of rendering it. Reversed, the sentence tells
    // the operator to fix the Workflow so the Phase resolves. Read off the chain
    // line rather than the joined lines, because line one names the immediate
    // dependency first by design and would make the joined order meaningless.
    const chain = reasonLines(BLOCKED_WORKFLOW_ROW).slice(1).join(' ');

    expect(chain.indexOf('Workflow ship-it-flow')).toBeLessThan(chain.indexOf('Pipeline ship-it'));
    expect(chain.indexOf('Pipeline ship-it')).toBeLessThan(chain.indexOf('Phase specify'));
  });

  it('keeps the immediate dependency as its own first line', () => {
    // The chain is additional, not a replacement: the first line still answers
    // "what does THIS row wait on", which is the column's question, and the
    // 085 assertion above reads it.
    const [first] = reasonLines(BLOCKED_WORKFLOW_ROW);
    expect(first).toContain('Pipeline ship-it');
    expect(first).not.toContain('Phase specify');
  });

  it('points the operator at the root cause, not at the intermediate', () => {
    // FR-040 — a consequence must be distinguishable from a root cause. Importing
    // the Pipeline first would not help; the Phase is what is missing.
    const chain = reasonLines(BLOCKED_WORKFLOW_ROW).slice(1).join(' ');
    expect(chain).toContain('Phase specify');
    expect(chain.toLowerCase()).toContain('first');
  });

  it('renders no chain line for a root-cause blocked row', () => {
    // A `dependency-absent` or `dependency-unresolvable` row IS the origin, so
    // there is nothing to trace. A chain line here would invent a third link.
    expect(reasonLines(BLOCKED_PIPELINE_ROW)).toHaveLength(1);
    expect(
      reasonLines({
        ...BLOCKED_PIPELINE_ROW,
        outcome: 'blocked',
        reason: { code: 'dependency-unresolvable', dependency: { kind: 'phase', resourceId: 'specify' } }
      })
    ).toHaveLength(1);
  });

  it('names the via link by its own kind, whatever that kind is', () => {
    // `via` is a `BlockedDependency`, so its kind is read, never assumed. A
    // hard-coded "Phase" here would misname the one case the type allows and
    // send the operator to the wrong catalog — the defect `dependencyLabel`
    // already exists to prevent one link up.
    const text = reasonLines({
      ...BLOCKED_WORKFLOW_ROW,
      outcome: 'blocked',
      reason: {
        code: 'dependency-blocked',
        dependency: { kind: 'pipeline', resourceId: 'ship-it' },
        via: { kind: 'pipeline', resourceId: 'deep-one' }
      }
    }).join(' ');

    expect(text).toContain('Pipeline deep-one');
    expect(text).not.toContain('Phase deep-one');
  });

  it('renders the strings the host bounded, and bounds nothing again (FR-030)', () => {
    // The boundary sanitizes and caps every author-supplied string on the row
    // (`cmd-preflight-process-yaml.ts`: 64 for an identifier). Re-bounding here
    // would be a second cap that silently disagrees with the first, and it would
    // truncate an identifier the operator has to search the catalog for. So this
    // asserts the value arrives verbatim — no ellipsis, no second slice.
    const long = 'a'.repeat(64);
    const text = reasonLines({
      ...BLOCKED_WORKFLOW_ROW,
      outcome: 'blocked',
      resourceId: long,
      reason: {
        code: 'dependency-blocked',
        dependency: { kind: 'pipeline', resourceId: long },
        via: { kind: 'phase', resourceId: long }
      }
    }).join(' ');

    expect(text).toContain(`Workflow ${long}`);
    expect(text).toContain(`Pipeline ${long}`);
    expect(text).toContain(`Phase ${long}`);
    expect(text).not.toContain('…');
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
      pipelines: [],
      workflows: []
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
      pipelines: [],
      workflows: []
    });
    expect((writes[0].request as SavePhasesRequest).phases.slice(0, 2)).toEqual([
      HELD,
      unparseable
    ]);
  });

  it('builds nothing for a plan with no import rows', () => {
    expect(
      buildImportWrites(plan([SKIP_ROW]), 'user', { phases: [HELD], pipelines: [], workflows: [] })
    ).toEqual([]);
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
      pipelines: [HELD_PIPELINE],
      workflows: []
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
  const landed = (...keys: readonly ImportLayerKey[]): readonly ImportLayerResult[] =>
    keys.map((key) => ({ key, ack: { status: 'accepted' } }));

  it('names the scope on a complete import', () => {
    expect(commitOutcomeStatement('imported', 'workspace', landed('phases'))).toContain(
      'workspace layer'
    );
  });

  it('says nothing was written on a failure', () => {
    expect(commitOutcomeStatement('failed', 'user', [])).toContain('Nothing was written');
  });

  it('states that a partial write was left in place and how to finish it', () => {
    // FR-042c — no compensating delete happened, so the sentence must not imply
    // a rollback; FR-042b — the recovery is re-running the same document, which
    // is safe because an already-present id is a skip.
    const statement = commitOutcomeStatement('partial', 'user', [
      ...landed('phases'),
      { key: 'pipelines', ack: { status: 'rejected', reason: 'stale-catalog' } }
    ]);
    expect(statement).toContain('user layer');
    expect(statement).toContain('still there');
    expect(statement.toLowerCase()).toContain('same document');
    for (const undone of ['rolled back', 'removed', 'reverted', 'undo']) {
      expect(statement.toLowerCase()).not.toContain(undone);
    }
  });

  // Feature 086 T055 — with three layers "part of this document" is no longer
  // enough: which part landed decides what the operator has to look at. The
  // sentence reads the acks rather than the plan, so it can only name a layer
  // that actually came back accepted.
  it('names the one layer that landed when the second of three was refused', () => {
    const statement = commitOutcomeStatement('partial', 'user', [
      ...landed('phases'),
      { key: 'pipelines', ack: { status: 'rejected', reason: 'stale-catalog' } }
    ]);
    expect(statement).toContain('Phase');
    expect(statement).not.toContain('Pipeline');
    expect(statement).not.toContain('Workflow');
  });

  it('names both layers that landed when only the Workflow write was refused', () => {
    const statement = commitOutcomeStatement('partial', 'workspace', [
      ...landed('phases', 'pipelines'),
      { key: 'workflows', ack: { status: 'rejected', reason: 'stale-catalog' } }
    ]);
    expect(statement).toContain('Phase');
    expect(statement).toContain('Pipeline');
    expect(statement).not.toContain('Workflow');
  });

  it('offers no compensating action for either partial shape', () => {
    // FR-042c/FR-051 — what landed stays landed, so no sentence may suggest an
    // undo the host will not perform.
    const shapes: readonly (readonly ImportLayerResult[])[] = [
      [...landed('phases'), { key: 'pipelines', ack: { status: 'rejected', reason: 'r' } }],
      [...landed('phases', 'pipelines'), { key: 'workflows', ack: { status: 'rejected', reason: 'r' } }]
    ];
    for (const results of shapes) {
      const statement = commitOutcomeStatement('partial', 'user', results).toLowerCase();
      for (const undone of ['rolled back', 'removed', 'reverted', 'undo', 'delete']) {
        expect(statement).not.toContain(undone);
      }
      expect(statement).toContain('still there');
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
    readonly saveWorkflows: ReturnType<typeof vi.fn>;
  } {
    return {
      savePhases: vi.fn(async (_request: SavePhasesRequest) => phaseAck),
      savePipelines: vi.fn(async (_request: SavePipelinesRequest) => pipelineAck),
      // No plan in this block declares a Workflow, so this must never be called.
      saveWorkflows: vi.fn(async (_request: SaveWorkflowsRequest) => ({
        status: 'accepted' as const
      }))
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
      },
      saveWorkflows: async () => {
        order.push('workflows');
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

// ---------------------------------------------------------------------------
// Feature 086 T054 — the third ordered write
// ---------------------------------------------------------------------------
//
// The Workflow layer is written LAST, and for the same reason the Pipeline layer
// is written second: a node's Pipeline must already be effective before the
// Workflow naming it is published, or the write is validated against a catalog
// that never received it. So the sequence is Phases, Pipelines, Workflow — three
// writes, three revision gates, three intents (FR-045, FR-046, FR-050).
//
// Nothing about the stopping rule or the outcome arithmetic changes: both were
// written for "the first refusal ends the sequence" and "count the acks", which
// are already total over three. These tests assert that rather than a rewrite.

describe('Feature 086 T054 — the Workflow import rows (FR-045)', () => {
  it('partitions the Workflow import rows, in plan order', () => {
    const second: ImportPlanRow = {
      outcome: 'import',
      resourceKind: 'workflow',
      resourceId: 'other-flow',
      name: 'Other Flow',
      definition: { ...FULL_WORKFLOW, workflowId: 'other-flow', name: 'Other Flow' }
    };
    const rows = workflowImportRows(
      workflowPackagePlan([WORKFLOW_IMPORT_ROW, importRow(), second, BLOCKED_WORKFLOW_ROW])
    );
    expect(rows.map((row) => row.resourceId)).toEqual(['ship-it-flow', 'other-flow']);
  });

  it('excludes a blocked Workflow — it is not a Workflow to write', () => {
    expect(workflowImportRows(workflowPackagePlan([BLOCKED_WORKFLOW_ROW]))).toEqual([]);
  });
});

describe('Feature 086 T054 — the Workflow save row built from a document (FR-046a)', () => {
  it('carries every declared field verbatim, renaming nothing', () => {
    // Unlike the Phase and Pipeline rows there is no key to rename: the
    // `schegent.workflows` layer is new as of feature 083, so `workflowId` is the
    // only identity spelling the row has ever had.
    expect(saveWorkflowRowFromDefinition(FULL_WORKFLOW)).toEqual(FULL_WORKFLOW);
  });

  it('keeps the authored graph exactly as declared, including every optional field', () => {
    const row = saveWorkflowRowFromDefinition(FULL_WORKFLOW);
    expect(row.nodes).toEqual(FULL_WORKFLOW.nodes);
    expect(row.connections).toEqual(FULL_WORKFLOW.connections);
    expect(row.startNodeIds).toEqual(FULL_WORKFLOW.startNodeIds);
  });

  it('declares no field the document left out', () => {
    const minimal: ImportedWorkflowDefinition = {
      workflowId: 'bare',
      name: 'Bare',
      version: 1,
      nodes: [{ nodeId: 'only', pipelineId: 'ship-it' }],
      connections: [],
      startNodeIds: ['only']
    };
    expect(Object.keys(saveWorkflowRowFromDefinition(minimal)).sort()).toEqual([
      'connections',
      'name',
      'nodes',
      'startNodeIds',
      'version',
      'workflowId'
    ]);
  });
});

describe('Feature 086 T054 — three ordered writes (FR-045, FR-046, FR-050)', () => {
  const threeLayers = workflowPackagePlan([
    importRow(),
    PIPELINE_IMPORT_ROW,
    WORKFLOW_IMPORT_ROW
  ]);

  it('orders the package as Phases, then Pipelines, then the Workflow', () => {
    const writes = buildImportWrites(threeLayers, 'user', EMPTY_LAYERS);
    expect(writes.map((write) => write.key)).toEqual(['phases', 'pipelines', 'workflows']);
  });

  it('orders them by dependency, not by the order the plan happened to list', () => {
    // The plan is deliberately reversed here. A write order read off the rows
    // would publish a Workflow before the Pipelines its nodes name.
    const reversed = workflowPackagePlan([WORKFLOW_IMPORT_ROW, PIPELINE_IMPORT_ROW, importRow()]);
    expect(buildImportWrites(reversed, 'user', EMPTY_LAYERS).map((write) => write.key)).toEqual([
      'phases',
      'pipelines',
      'workflows'
    ]);
  });

  it('gates each of the three layers on its own catalog revision', () => {
    const writes = buildImportWrites(threeLayers, 'workspace', EMPTY_LAYERS);
    expect(writes.map((write) => write.request.expectedRevision)).toEqual([
      'workspace-rev-1',
      'workspace-pipe-rev-1',
      'workspace-flow-rev-1'
    ]);
  });

  it('takes all three revisions from the scope the operator chose', () => {
    const writes = buildImportWrites(threeLayers, 'user', EMPTY_LAYERS);
    expect(writes.map((write) => write.request.expectedRevision)).toEqual([
      'user-rev-1',
      'user-pipe-rev-1',
      'user-flow-rev-1'
    ]);
  });

  it('declares exactly one intent per layer, naming every id it adds', () => {
    const writes = buildImportWrites(threeLayers, 'user', EMPTY_LAYERS);
    expect(writes.map((write) => write.request.mutation)).toEqual([
      { kind: 'import-package', phaseIds: ['brought-in'] },
      { kind: 'import-package', pipelineIds: ['ship-it'] },
      { kind: 'import-package', workflowIds: ['ship-it-flow'] }
    ]);
  });

  it('appends the Workflow row to the stored Workflow layer, in order', () => {
    const writes = buildImportWrites(threeLayers, 'user', {
      phases: [],
      pipelines: [],
      workflows: [HELD_WORKFLOW]
    });
    const workflowWrite = writes[writes.length - 1].request as SaveWorkflowsRequest;
    expect(workflowWrite.workflows).toEqual([
      HELD_WORKFLOW,
      saveWorkflowRowFromDefinition(WORKFLOW_IMPORT_ROW.definition as ImportedWorkflowDefinition)
    ]);
  });

  // The references-only package: every Pipeline and Phase it names is already in
  // the catalog, so there is exactly one layer to write.
  it('writes only the Workflow layer for a package that supplies nothing else', () => {
    const writes = buildImportWrites(
      workflowOnlyPlan([WORKFLOW_IMPORT_ROW, SKIP_ROW]),
      'user',
      EMPTY_LAYERS
    );
    expect(writes.map((write) => write.key)).toEqual(['workflows']);
    expect(writes[0].request.expectedRevision).toBe('user-flow-rev-1');
  });

  // The same rule the Pipeline half already obeys (FR-040): a layer with no gate
  // to present is not written at all, and neither is anything else — half a
  // package is the one outcome no requirement here admits.
  it('builds nothing at all when a Workflow row has no revision to gate on', () => {
    expect(
      buildImportWrites(packagePlan([importRow(), WORKFLOW_IMPORT_ROW]), 'user', EMPTY_LAYERS)
    ).toEqual([]);
  });

  it('still builds the two-layer package unchanged when no Workflow row is present', () => {
    const writes = buildImportWrites(
      packagePlan([importRow(), PIPELINE_IMPORT_ROW]),
      'user',
      EMPTY_LAYERS
    );
    expect(writes.map((write) => write.key)).toEqual(['phases', 'pipelines']);
  });
});

describe('Feature 086 T054 — confirmation with a Workflow in the plan (FR-050)', () => {
  it('confirms a three-layer package', () => {
    const gate = {
      state: 'planned' as const,
      plan: workflowPackagePlan([importRow(), PIPELINE_IMPORT_ROW, WORKFLOW_IMPORT_ROW]),
      scope: 'user' as const
    };
    expect(confirmBlockedReason(gate)).toBeNull();
  });

  it('confirms a references-only Workflow package', () => {
    const gate = {
      state: 'planned' as const,
      plan: workflowOnlyPlan([WORKFLOW_IMPORT_ROW]),
      scope: 'user' as const
    };
    expect(confirmBlockedReason(gate)).toBeNull();
  });

  it('holds closed a Workflow plan carrying no Workflow revision, and says why', () => {
    const gate = {
      state: 'planned' as const,
      plan: packagePlan([WORKFLOW_IMPORT_ROW]),
      scope: 'user' as const
    };
    const reason = confirmBlockedReason(gate);
    expect(reason).toContain('Workflow catalog revision');
    expect(reason).toContain('again');
  });
});

describe('Feature 086 T054 — projecting the third layer’s ack (FR-042, FR-051)', () => {
  const threeKinds = workflowPackagePlan([importRow(), PIPELINE_IMPORT_ROW, WORKFLOW_IMPORT_ROW]);

  it('reports the Workflow row imported when its own layer was accepted', () => {
    const results = projectCommitResults(threeKinds, 'workspace', [
      { key: 'phases', ack: { status: 'accepted' } },
      { key: 'pipelines', ack: { status: 'accepted' } },
      { key: 'workflows', ack: { status: 'accepted' } }
    ]);
    expect(results[2]).toMatchObject({ resourceId: 'ship-it-flow', outcome: 'imported' });
    expect(results[2].detail).toContain('workspace');
  });

  // FR-051's second partial shape, as the operator sees it: two layers say
  // imported and the third says why it did not, in one table.
  it('reports the Phases and Pipeline imported and the Workflow failed', () => {
    const results = projectCommitResults(threeKinds, 'user', [
      { key: 'phases', ack: { status: 'accepted' } },
      { key: 'pipelines', ack: { status: 'accepted' } },
      { key: 'workflows', ack: { status: 'rejected', reason: 'stale-catalog' } }
    ]);
    expect(results[0].outcome).toBe('imported');
    expect(results[1].outcome).toBe('imported');
    expect(results[2].outcome).toBe('failed');
    expect(results[2].detail).toContain('reapply');
  });

  it('uses the Workflow rejection formatter for a Workflow row', () => {
    // Not the Pipeline formatter: a Workflow rejection can carry the suppressed
    // ancestry note, which the Pipeline formatter would drop.
    const results = projectCommitResults(threeKinds, 'user', [
      { key: 'phases', ack: { status: 'accepted' } },
      { key: 'pipelines', ack: { status: 'accepted' } },
      {
        key: 'workflows',
        ack: {
          status: 'rejected',
          reason: 'workflow-validation',
          result: {
            errors: [
              { workflowId: 'ship-it-flow', field: 'nodes[0].pipelineId', message: 'unknown Pipeline' }
            ],
            ancestryChecksSuppressed: true
          }
        }
      }
    ]);
    expect(results[2].detail).toContain('nodes[0].pipelineId');
    expect(results[2].detail).toContain('unknown Pipeline');
    expect(results[2].detail).toContain('cycle');
  });

  it('says the Workflow layer was never reached rather than borrowing a reason', () => {
    const results = projectCommitResults(threeKinds, 'user', [
      { key: 'phases', ack: { status: 'accepted' } },
      { key: 'pipelines', ack: { status: 'rejected', reason: 'stale-catalog' } }
    ]);
    expect(results[1].detail).toContain('stale-catalog');
    expect(results[2].outcome).toBe('failed');
    expect(results[2].detail).toContain('stopped before this layer');
    expect(results[2].detail).not.toContain('stale-catalog');
  });
});

describe('Feature 086 T054 — running the three-layer commit (FR-045, FR-051)', () => {
  const threeLayers = workflowPackagePlan([importRow(), PIPELINE_IMPORT_ROW, WORKFLOW_IMPORT_ROW]);

  function deps(
    phaseAck: SavePhasesResult,
    pipelineAck: SavePipelinesResult,
    workflowAck: SaveWorkflowsResult
  ): {
    readonly savePhases: ReturnType<typeof vi.fn>;
    readonly savePipelines: ReturnType<typeof vi.fn>;
    readonly saveWorkflows: ReturnType<typeof vi.fn>;
  } {
    return {
      savePhases: vi.fn(async (_request: SavePhasesRequest) => phaseAck),
      savePipelines: vi.fn(async (_request: SavePipelinesRequest) => pipelineAck),
      saveWorkflows: vi.fn(async (_request: SaveWorkflowsRequest) => workflowAck)
    };
  }

  it('sends the three writes in dependency order', async () => {
    const order: string[] = [];
    const report = await runImportCommit(threeLayers, 'user', EMPTY_LAYERS, {
      savePhases: async () => {
        order.push('phases');
        return { status: 'accepted' };
      },
      savePipelines: async () => {
        order.push('pipelines');
        return { status: 'accepted' };
      },
      saveWorkflows: async () => {
        order.push('workflows');
        return { status: 'accepted' };
      }
    });
    expect(order).toEqual(['phases', 'pipelines', 'workflows']);
    expect(report.outcome).toBe('imported');
  });

  // The stopping rule is unchanged and total over three: the first refusal ends
  // the sequence, so a refused Pipeline write means the Workflow is never sent.
  it('never sends the Workflow write when the Pipeline write was refused', async () => {
    const injected = deps(
      { status: 'accepted' },
      { status: 'rejected', reason: 'stale-catalog' },
      { status: 'accepted' }
    );
    const report = await runImportCommit(threeLayers, 'user', EMPTY_LAYERS, injected);
    expect(injected.savePipelines).toHaveBeenCalledTimes(1);
    expect(injected.saveWorkflows).not.toHaveBeenCalled();
    expect(report.outcome).toBe('partial');
  });

  // FR-051 — the second partial shape. Two writes landed; nothing is retracted,
  // and the only way to see that from here is that no further write is sent.
  it('sends nothing further to undo the first two when the third is refused', async () => {
    const injected = deps(
      { status: 'accepted' },
      { status: 'accepted' },
      { status: 'rejected', reason: 'stale-catalog' }
    );
    const report = await runImportCommit(threeLayers, 'user', EMPTY_LAYERS, injected);
    expect(injected.savePhases).toHaveBeenCalledTimes(1);
    expect(injected.savePipelines).toHaveBeenCalledTimes(1);
    expect(injected.saveWorkflows).toHaveBeenCalledTimes(1);
    expect(report.outcome).toBe('partial');
    expect(report.rows[2].outcome).toBe('failed');
  });

  it('reports imported only when all three acks were accepted', async () => {
    const injected = deps({ status: 'accepted' }, { status: 'accepted' }, { status: 'accepted' });
    const report = await runImportCommit(threeLayers, 'workspace', EMPTY_LAYERS, injected);
    expect(report.outcome).toBe('imported');
    expect(report.results.map((result) => result.key)).toEqual([
      'phases',
      'pipelines',
      'workflows'
    ]);
  });

  it('carries the Workflow request through to the save it belongs to', async () => {
    const injected = deps({ status: 'accepted' }, { status: 'accepted' }, { status: 'accepted' });
    await runImportCommit(threeLayers, 'workspace', EMPTY_LAYERS, injected);
    expect(injected.saveWorkflows).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'workspace',
        expectedRevision: 'workspace-flow-rev-1',
        mutation: { kind: 'import-package', workflowIds: ['ship-it-flow'] }
      })
    );
  });

  it('sends only the Workflow write for a references-only package', async () => {
    const injected = deps({ status: 'accepted' }, { status: 'accepted' }, { status: 'accepted' });
    const report = await runImportCommit(
      workflowOnlyPlan([WORKFLOW_IMPORT_ROW]),
      'user',
      EMPTY_LAYERS,
      injected
    );
    expect(injected.savePhases).not.toHaveBeenCalled();
    expect(injected.savePipelines).not.toHaveBeenCalled();
    expect(injected.saveWorkflows).toHaveBeenCalledTimes(1);
    expect(report.outcome).toBe('imported');
  });
});

// ---------------------------------------------------------------------------
// Feature 086 — FR-030
// ---------------------------------------------------------------------------

// Feature 086 T071 — what a capped defect list tells the operator.
//
// FR-030 has two halves that pull in opposite directions, and both are asserted
// here because each one on its own reads as a bug.
//
// The first: author-supplied text arrives VERBATIM. The boundary already
// sanitized it and already capped it — 32 or 48 for a field path by resource kind,
// 512 for a message, 64 for an identifier — so a second cap in the view would
// disagree with the first and truncate a field path the operator has to navigate
// by. `reasonLines` therefore adds no ellipsis and slices nothing.
//
// The second: the LIST is capped at twenty, and a capped list must not read as a
// complete one. `totalDefects` is deliberately the pre-cap count, so the view can
// say how many it is not showing. Without that line the operator fixes the twenty
// they can see, re-imports, and finds the row still invalid for reasons that were
// never named — which is the failure mode of a bound that hides itself.
//
// The Workflow kind is the one that makes this concrete: a Workflow document
// carries three catalog levels, so it is the kind most likely to produce more than
// twenty defects at once.
describe('Feature 086 T071 — a capped defect list says it was capped (FR-030)', () => {
  const DEFECTS_MAX = 20;

  function defect(index: number): { field: string; code: string; message: string } {
    return {
      field: `connections[${index}].condition.left.source`,
      code: 'unknown-operand',
      message: `Saw "step-${index}".`
    };
  }

  /** A row shaped as the boundary emits one: the list sliced, the count not. */
  function invalidWorkflowRow(shown: number, total: number): ImportPlanRow {
    return {
      outcome: 'invalid',
      resourceKind: 'workflow',
      resourceId: 'ship-it-flow',
      defects: Array.from({ length: shown }, (_, index) => defect(index)),
      totalDefects: total
    };
  }

  it('reports how many defects it is not showing', () => {
    const lines = reasonLines(invalidWorkflowRow(DEFECTS_MAX, 57));

    // One line per shown defect, plus the overflow line — nothing dropped to make
    // room for it.
    expect(lines).toHaveLength(DEFECTS_MAX + 1);
    expect(lines[lines.length - 1]).toBe('and 37 more not shown.');
  });

  it('counts the overflow from the total the host sent, not from the cap', () => {
    // The arithmetic must be `total - shown`, not `total - 20`. They agree at the
    // cap and diverge everywhere else, so a hard-coded 20 would be invisible in the
    // common case and wrong the moment a future bound differs.
    expect(reasonLines(invalidWorkflowRow(3, 9)).at(-1)).toBe('and 6 more not shown.');
  });

  it('adds no overflow line when the list is complete', () => {
    // The other direction, and the more damaging one: a complete list that claims
    // to be truncated sends the operator looking for defects that do not exist.
    const lines = reasonLines(invalidWorkflowRow(4, 4));
    expect(lines).toHaveLength(4);
    expect(lines.join(' ')).not.toContain('not shown');
  });

  it('adds no overflow line for a single defect either', () => {
    // The 084 Phase shape, still the common case. `totalDefects === 1` with one
    // defect shown must render exactly the one line.
    expect(reasonLines(INVALID_ROW)).toEqual(['version: Saw "soon".']);
  });

  it('renders each defect as its field and message, verbatim', () => {
    // No re-slice and no ellipsis, at the widest widths the boundary permits: 48
    // for a Workflow field path, 512 for a message. A view-side cap here would cut
    // `connections[0].condition.left.source` mid-word and name a field the operator
    // cannot find.
    const field = `connections[0].${'a'.repeat(48 - 'connections[0].'.length)}`;
    const message = 'm'.repeat(512);
    const [line] = reasonLines({
      outcome: 'invalid',
      resourceKind: 'workflow',
      resourceId: 'ship-it-flow',
      defects: [{ field, code: 'unknown-operand', message }],
      totalDefects: 1
    });

    expect(line).toBe(`${field}: ${message}`);
    expect(line).not.toContain('…');
    expect(line).not.toContain('...');
  });

  it('renders a defect the host sanitized to empty without inventing text', () => {
    // `sanitize` can redact a value down to nothing. The line is then structurally
    // odd but honest; substituting a placeholder here would be the view describing
    // a defect it does not know about.
    expect(
      reasonLines({
        outcome: 'invalid',
        resourceKind: 'workflow',
        resourceId: null,
        defects: [{ field: '', code: '', message: '' }],
        totalDefects: 1
      })
    ).toEqual([': ']);
  });

  it('bounds nothing on a skip row either, whatever its identifier (FR-030)', () => {
    // The 085 assertion covered blocked rows; a skip row also renders an
    // author-supplied identifier, through a different arm. Both layers named in
    // the sentence are host-supplied enums, so the only free text is the id.
    const long = 'z'.repeat(64);
    const [line] = reasonLines({ ...SKIP_ROW, outcome: 'skip', resourceId: long });
    expect(line).not.toContain('…');
    // The sentence is about the layer the row is already in, and it says which.
    expect(line).toContain('user');
    expect(line).toContain('invalid');
  });

  it('renders author text without interpreting it as markup', () => {
    // Every line is plain text, interpolated into a sentence and handed to Svelte,
    // which escapes it on render. Nothing here builds HTML, so an author-supplied
    // angle bracket stays an angle bracket — asserted so a future "render the
    // field path as code" change cannot quietly reach for `{@html}`.
    const [line] = reasonLines({
      outcome: 'invalid',
      resourceKind: 'workflow',
      resourceId: 'ship-it-flow',
      defects: [
        { field: 'nodes[0].nodeId', code: 'x', message: '<img src=x onerror=alert(1)>' }
      ],
      totalDefects: 1
    });
    expect(line).toBe('nodes[0].nodeId: <img src=x onerror=alert(1)>');
  });
});
