// Feature 084 T037/T039/T040 — the import surface's decisions, as pure functions.
//
// Everything the commit decides lives outside the component so it can be pinned
// directly: where a confirmed import writes (FR-035), when confirmation is unavailable
// and why (FR-036, FR-057), what the save carries (FR-037, FR-038, FR-046a), and
// how the save's single ack becomes a per-row result (FR-042, FR-044).

import { describe, expect, it, vi } from 'vitest';
import type { DocumentRefusalCode, ImportPlan, ImportPlanRow } from '../../lib/messages';
import type { SaveModelsImportRequest, SaveModelsImportResult } from '../../lib/save-models';
import type { LifecycleResult } from '../../lib/catalog-lifecycle';
import type { PackagePublishRequest } from '../../../../src/contracts/catalog-lifecycle';
import {
  buildImportPackage,
  commitOutcome,
  commitOutcomeStatement,
  commitStatement,
  confirmBlockedReason,
  eligibleRows,
  importCommitReport,
  lateImportCommitReport,
  layerResultsOf,
  modelCatalogCommitOutcomeStatement,
  modelCatalogCommitStatement,
  modelCatalogImportDelta,
  modelCatalogImportRows,
  phaseImportRows,
  projectCommitResults,
  projectModelCatalogCommitResults,
  reasonLines,
  refusalHeadline,
  resourceKindLabel,
  runImportCommit,
  runModelCatalogImportCommit,
  savePhaseRowFromDefinition,
  saveWorkflowRowFromDefinition,
  workflowImportRows,
  type ImportLayerKey,
  type ImportLayerResult,
  type ImportedPhaseDefinition,
  type ImportedWorkflowDefinition
} from '../ProcessImport/process-import-state';

const PHASE_REVISION = 'phase-rev-1';
const WORKFLOW_REVISION = 'workflow-rev-1';

/** Every portable field, so a dropped one is visible rather than plausible. */
const FULL: ImportedPhaseDefinition = {
  phaseId: 'brought-in',
  name: 'Brought In',
  description: 'As authored.',
  version: 7,
  instruction: 'Do the thing.',
  model: 'claude-opus-5-5',
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
    computedAgainstRevision: PHASE_REVISION
  };
}

const CHILD_WORKFLOW_DEFINITION: ImportedWorkflowDefinition = {
  workflowId: 'child-flow',
  name: 'Child Flow',
  version: 1,
  nodes: [{ nodeId: 'specify', kind: 'phase', phaseId: 'specify' }],
  connections: [],
  startNodeIds: ['specify']
};

const CHILD_WORKFLOW_IMPORT_ROW: ImportPlanRow = {
  outcome: 'import',
  resourceKind: 'workflow',
  resourceId: 'child-flow',
  name: 'Child Flow',
  definition: CHILD_WORKFLOW_DEFINITION
};

const BLOCKED_LEAF_WORKFLOW_ROW: ImportPlanRow = {
  outcome: 'blocked',
  resourceKind: 'workflow',
  resourceId: 'child-flow',
  name: 'Child Flow',
  reason: { code: 'dependency-absent', dependency: { kind: 'phase', resourceId: 'specify' } }
};

/**
 * Every portable Workflow field (FR-R5-F01 / FR-R5-F04), so a dropped one is visible
 * rather than plausible. The connection carries optional fields and structured handoff/to
 * because the write forwards the graph verbatim and a rewritten one is what FR-046a forbids.
 */
const FULL_WORKFLOW: ImportedWorkflowDefinition = {
  workflowId: 'ship-it-flow',
  name: 'Ship It Flow',
  description: 'As authored.',
  version: 4,
  inputs: [
    {
      portId: 'featureName',
      label: 'Feature Name',
      type: 'text',
      required: true,
      description: 'Feature name'
    }
  ],
  outputs: [
    {
      portId: 'verdict',
      label: 'Verdict',
      type: 'markdown',
      required: true
    }
  ],
  nodes: [
    { nodeId: 'draft', kind: 'phase', phaseId: 'specify', label: 'Draft it' },
    { nodeId: 'review', kind: 'workflow', workflowId: 'child-flow' }
  ],
  connections: [
    {
      from: { nodeId: 'draft' },
      to: { kind: 'node', nodeId: 'review' },
      handoff: 'auto',
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
  bindings: [
    {
      kind: 'input',
      nodeId: 'draft',
      inputKey: 'featureName',
      source: { from: 'workflow-input', portId: 'featureName' }
    }
  ],
  startNodeIds: ['draft'],
  executionDefaults: { model: 'claude-sonnet-4-6', effort: 'high', timeoutSeconds: 600 },
  recommendedNext: ['release-flow']
};

/** A Workflow `import` row, the second layer's write source. */
const WORKFLOW_IMPORT_ROW: ImportPlanRow = {
  outcome: 'import',
  resourceKind: 'workflow',
  resourceId: 'ship-it-flow',
  name: 'Ship It Flow',
  definition: {
    workflowId: 'ship-it-flow',
    name: 'Ship It Flow',
    version: 1,
    nodes: [{ nodeId: 'draft', kind: 'workflow', workflowId: 'child-flow' }],
    connections: [],
    startNodeIds: ['draft']
  }
};

/** A parent Workflow waiting on a child Workflow that waits on a Phase. */
const BLOCKED_WORKFLOW_ROW: ImportPlanRow = {
  outcome: 'blocked',
  resourceKind: 'workflow',
  resourceId: 'ship-it-flow',
  name: 'Ship It Flow',
  reason: {
    code: 'dependency-blocked',
    dependency: { kind: 'workflow', resourceId: 'child-flow' },
    via: { kind: 'phase', resourceId: 'specify' }
  }
};

/**
 * Feature 096 — a Model Catalog `import` row. Distinct field set from the other
 * kinds' import arms: no `definition`, since there is no
 * PhaseDefinition/WorkflowDefinition analog for a model id.
 */
const MODEL_CATALOG_IMPORT_ROW: ImportPlanRow = {
  outcome: 'import',
  resourceKind: 'modelCatalog',
  resourceId: 'custom-model-a',
  backend: 'claude',
  modelId: 'custom-model-a'
};

/** A Model Catalog skip row — `ModelCatalogSkipRow`, not the presence arm. */
const MODEL_CATALOG_SKIP_ALREADY_EXISTS_ROW: ImportPlanRow = {
  outcome: 'skip',
  resourceKind: 'modelCatalog',
  resourceId: 'custom-model-a',
  backend: 'claude',
  modelId: 'custom-model-a',
  reason: 'already-exists'
};

const MODEL_CATALOG_SKIP_UNRECOGNIZED_BACKEND_ROW: ImportPlanRow = {
  outcome: 'skip',
  resourceKind: 'modelCatalog',
  resourceId: 'custom-model-x',
  backend: 'foo',
  modelId: 'custom-model-x',
  reason: 'unrecognized-backend'
};

/**
 * A plan carrying both Phase and Workflow revisions — what preflight produces for a
 * document declaring a Workflow (FR-036). Kept separate from `plan`: the two shapes are what
 * distinguish a writable Workflow layer from an absent one.
 */
function workflowPackagePlan(rows: readonly ImportPlanRow[]): ImportPlan {
  return { ...plan(rows), computedAgainstWorkflowRevision: WORKFLOW_REVISION };
}

/** A references-only Workflow package: nothing to write but the Workflow itself. */
function workflowOnlyPlan(rows: readonly ImportPlanRow[]): ImportPlan {
  return { ...plan(rows), computedAgainstWorkflowRevision: WORKFLOW_REVISION };
}

const HELD = Object.freeze({ id: 'held', name: 'Held', version: 4, instruction: 'Hold.' });
const HELD_WORKFLOW = Object.freeze({
  workflowId: 'held-flow',
  name: 'Held Flow',
  version: 3,
  nodes: [Object.freeze({ nodeId: 'only', kind: 'phase' as const, phaseId: 'specify' })],
  connections: [],
  startNodeIds: ['only']
});

describe('Feature 084 — the import target (FR-035)', () => {
  it('takes no import target — the destination is not an input (T496f)', () => {
    expect(buildImportPackage).toHaveLength(1);
    expect(runImportCommit).toHaveLength(2);
    expect(commitStatement).toHaveLength(1);
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
    const line = reasonLines(importRow(FULL, true))[0]!.toLowerCase();
    for (const granted of ['allowed', 'trusted', 'granted', 'permitted', 'will be imported']) {
      expect(line).not.toContain(granted);
    }
    expect(line).toContain('commit');
  });

  it('does not itself block confirmation', () => {
    expect(
      confirmBlockedReason({ state: 'planned', plan: plan([importRow(FULL, true)]) })
    ).toBeNull();
  });

  it('does not change the save the commit sends', () => {
    const advised = buildImportPackage(plan([importRow(FULL, true)]));
    const silent = buildImportPackage(plan([importRow(FULL, false)]));
    expect(advised).toEqual(silent);
    expect(advised!.request.layers[0].definitions[0].body).toHaveProperty(
      'retryCondition',
      'open_questions > 0'
    );
  });
});

describe('Feature 084 — a refusal states a reason (T051, FR-057)', () => {
  const REFUSAL_CODE_SET: Readonly<Record<DocumentRefusalCode, true>> = {
    unreadable: true,
    'too-large': true,
    'unsupported-version': true,
    'unsupported-kind': true,
    'disallowed-syntax': true,
    'multi-document': true,
    'duplicate-id': true,
    'graph-cycle': true,
    empty: true
  };
  const ALL_REFUSAL_CODES = Object.keys(REFUSAL_CODE_SET) as readonly DocumentRefusalCode[];

  it('never returns a bare code', () => {
    for (const code of ALL_REFUSAL_CODES) {
      const headline = refusalHeadline(code);
      expect(headline).not.toBe(code);
      expect(headline).not.toContain(code);
      expect(headline.endsWith('.')).toBe(true);
    }
  });

  it('a refusal that is not kind-specific does not name one resource kind', () => {
    const KIND_SPECIFIC: ReadonlySet<string> = new Set(['graph-cycle']);
    for (const code of ALL_REFUSAL_CODES) {
      if (KIND_SPECIFIC.has(code)) continue;
      const headline = refusalHeadline(code);
      for (const kind of ['Phase', 'Pipeline', 'Workflow']) {
        expect(
          headline,
          `refusalHeadline('${code}') names ${kind}, but the code is reachable for every document kind`
        ).not.toContain(kind);
      }
    }
  });

  it('falls back to a sentence for a code this bundle does not know', () => {
    const unknown = 'a-code-from-a-later-build' as Parameters<typeof refusalHeadline>[0];
    expect(refusalHeadline(unknown)).toBe('This document was not accepted.');
  });
});

describe('Feature 084 — confirmation availability (FR-036, FR-056, FR-057)', () => {
  const ready = { state: 'planned' as const, plan: plan([importRow()]) };

  it('is available once there is a plan with an import row, nothing else to choose', () => {
    expect(confirmBlockedReason(ready)).toBeNull();
  });

  it('is unavailable with a stated reason while preflight is still running', () => {
    const reason = confirmBlockedReason({ ...ready, state: 'validating' });
    expect(reason).toBeTruthy();
    expect(reason).toContain('still being read');
  });

  it('is unavailable with a stated reason for a refused document', () => {
    const reason = confirmBlockedReason({ state: 'refused', plan: null });
    expect(reason).toContain('refused');
  });

  it('is unavailable with a stated reason on a plan with no import rows', () => {
    const reason = confirmBlockedReason({ ...ready, plan: plan([SKIP_ROW, INVALID_ROW]) });
    expect(reason).toContain('nothing to import');
  });

  it('asks the operator to choose nothing, in any state (T496f)', () => {
    for (const state of ['idle', 'validating', 'canceled', 'refused', 'failed', 'committing'] as const) {
      expect(confirmBlockedReason({ ...ready, state }) ?? '').not.toContain('Choose');
    }
  });

  it('is unavailable while a commit is already in flight', () => {
    const reason = confirmBlockedReason({ ...ready, state: 'committing' });
    expect(reason).toContain('in progress');
  });

  it('states a reason for every state that is not a confirmable plan', () => {
    for (const state of ['idle', 'validating', 'canceled', 'refused', 'failed'] as const) {
      expect(confirmBlockedReason({ state, plan: null })).toBeTruthy();
    }
  });
});

describe('Feature 085 T035 — the plan is kind-tagged (FR-056)', () => {
  it('labels each row with its own kind, not the document with one', () => {
    expect(resourceKindLabel(WORKFLOW_IMPORT_ROW)).toBe('Workflow');
    expect(resourceKindLabel(importRow())).toBe('Phase');
    expect(resourceKindLabel(SKIP_ROW)).toBe('Phase');
  });

  it('labels a Workflow row as its own kind (FR-056)', () => {
    expect(resourceKindLabel(WORKFLOW_IMPORT_ROW)).toBe('Workflow');
    expect(
      resourceKindLabel({
        outcome: 'skip',
        resourceKind: 'workflow',
        resourceId: 'ship-it-flow',
        name: 'Ship It Flow',
        presentRowStatus: 'invalid'
      })
    ).toBe('Workflow');
  });

  it('names every kind exactly once across the row union', () => {
    const labels = [importRow(), WORKFLOW_IMPORT_ROW].map(resourceKindLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('states a blocked Workflow row reason naming the child Workflow it waits on', () => {
    const [line] = reasonLines(BLOCKED_WORKFLOW_ROW);
    expect(line).toContain('Workflow child-flow');
    expect(line).not.toContain('Phase child-flow');
  });

  it('partitions the import rows by kind, in plan order', () => {
    const both = plan([importRow(), WORKFLOW_IMPORT_ROW, SKIP_ROW]);
    expect(phaseImportRows(both).map((row) => row.resourceId)).toEqual(['brought-in']);
    expect(workflowImportRows(both).map((row) => row.resourceId)).toEqual(['ship-it-flow']);
    expect(eligibleRows(both)).toHaveLength(2);
  });

  it('counts a Workflow-only plan as eligible — eligibility reads no kind (FR-057)', () => {
    const references = plan([WORKFLOW_IMPORT_ROW, SKIP_ROW]);
    expect(eligibleRows(references)).toHaveLength(1);
    expect(phaseImportRows(references)).toHaveLength(0);
  });

  it('treats a blocked Workflow as ineligible, not as a Workflow to write', () => {
    expect(eligibleRows(plan([BLOCKED_LEAF_WORKFLOW_ROW]))).toHaveLength(0);
    expect(workflowImportRows(plan([BLOCKED_LEAF_WORKFLOW_ROW]))).toHaveLength(0);
  });
});

describe('Feature 096 T022 — Model Catalog row rendering (contracts §6)', () => {
  it('labels a Model Catalog row with its own kind', () => {
    expect(resourceKindLabel(MODEL_CATALOG_IMPORT_ROW)).toBe('Model Catalog');
    expect(resourceKindLabel(MODEL_CATALOG_SKIP_ALREADY_EXISTS_ROW)).toBe('Model Catalog');
  });

  it('states an import row as adding the model id to its backend', () => {
    expect(reasonLines(MODEL_CATALOG_IMPORT_ROW)).toEqual(['Add `custom-model-a` to claude']);
  });

  it('states an already-exists skip naming the model id and its backend', () => {
    expect(reasonLines(MODEL_CATALOG_SKIP_ALREADY_EXISTS_ROW)).toEqual([
      '`custom-model-a` already exists under claude — skipped'
    ]);
  });

  it('states an unrecognized-backend skip naming the backend and the model id', () => {
    expect(reasonLines(MODEL_CATALOG_SKIP_UNRECOGNIZED_BACKEND_ROW)).toEqual([
      'Unrecognized backend `foo` — `custom-model-x` skipped'
    ]);
  });

  it('names every kind exactly once, Model Catalog included (FR-056 totality)', () => {
    const labels = [importRow(), WORKFLOW_IMPORT_ROW, MODEL_CATALOG_IMPORT_ROW].map(
      resourceKindLabel
    );
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('Feature 086 T046 — the propagated chain is rendered whole (FR-039, FR-040)', () => {
  it('names all three links: the selected resource, the intermediate, and the root cause', () => {
    const lines = reasonLines(BLOCKED_WORKFLOW_ROW);
    const text = lines.join(' ');

    expect(text).toContain('Workflow ship-it-flow');
    expect(text).toContain('Workflow child-flow');
    expect(text).toContain('Phase specify');
  });

  it('orders the chain from the selected resource to the root cause', () => {
    const chain = reasonLines(BLOCKED_WORKFLOW_ROW).slice(1).join(' ');

    expect(chain.indexOf('Workflow ship-it-flow')).toBeLessThan(chain.indexOf('Workflow child-flow'));
    expect(chain.indexOf('Workflow child-flow')).toBeLessThan(chain.indexOf('Phase specify'));
  });

  it('keeps the immediate dependency as its own first line', () => {
    const [first] = reasonLines(BLOCKED_WORKFLOW_ROW);
    expect(first).toContain('Workflow child-flow');
    expect(first).not.toContain('Phase specify');
  });

  it('points the operator at the root cause, not at the intermediate', () => {
    const chain = reasonLines(BLOCKED_WORKFLOW_ROW).slice(1).join(' ');
    expect(chain).toContain('Phase specify');
    expect(chain.toLowerCase()).toContain('first');
  });

  it('renders no chain line for a root-cause blocked row', () => {
    expect(reasonLines(BLOCKED_LEAF_WORKFLOW_ROW)).toHaveLength(1);
    expect(
      reasonLines({
        ...BLOCKED_LEAF_WORKFLOW_ROW,
        outcome: 'blocked',
        reason: { code: 'dependency-unresolvable', dependency: { kind: 'phase', resourceId: 'specify' } }
      })
    ).toHaveLength(1);
  });

  it('names the via link by its own kind, whatever that kind is', () => {
    const text = reasonLines({
      ...BLOCKED_WORKFLOW_ROW,
      outcome: 'blocked',
      reason: {
        code: 'dependency-blocked',
        dependency: { kind: 'workflow', resourceId: 'child-flow' },
        via: { kind: 'workflow', resourceId: 'deep-one' }
      }
    }).join(' ');

    expect(text).toContain('Workflow deep-one');
    expect(text).not.toContain('Phase deep-one');
  });

  it('renders the strings the host bounded, and bounds nothing again (FR-030)', () => {
    const long = 'a'.repeat(64);
    const text = reasonLines({
      ...BLOCKED_WORKFLOW_ROW,
      outcome: 'blocked',
      resourceId: long,
      reason: {
        code: 'dependency-blocked',
        dependency: { kind: 'workflow', resourceId: long },
        via: { kind: 'phase', resourceId: long }
      }
    }).join(' ');

    expect(text).toContain(`Workflow ${long}`);
    expect(text).toContain(`Phase ${long}`);
    expect(text).not.toContain('…');
  });
});

describe('Feature 085 T048 — confirmation with a package in the plan (FR-057)', () => {
  it('confirms a plan whose only eligible row is a Workflow', () => {
    expect(
      confirmBlockedReason({
        state: 'planned',
        plan: workflowPackagePlan([WORKFLOW_IMPORT_ROW, SKIP_ROW])
      })
    ).toBeNull();
  });

  it('reports "nothing to import" when no row is eligible, whatever the kinds', () => {
    const reason = confirmBlockedReason({
      state: 'planned',
      plan: plan([BLOCKED_LEAF_WORKFLOW_ROW, SKIP_ROW, INVALID_ROW])
    });
    expect(reason).toContain('nothing to import');
  });

  it('confirms a multi-Phase package — the ordered two-layer write exists now', () => {
    const second = importRow({ ...FULL, phaseId: 'also-in', name: 'Also In' });
    expect(
      confirmBlockedReason({
        state: 'planned',
        plan: workflowPackagePlan([importRow(), second, WORKFLOW_IMPORT_ROW])
      })
    ).toBeNull();
  });

  it('still confirms an ordinary single-Phase document', () => {
    expect(
      confirmBlockedReason({ state: 'planned', plan: plan([importRow()]) })
    ).toBeNull();
  });

  it('holds closed a Workflow plan carrying no Workflow revision, and says why', () => {
    const reason = confirmBlockedReason({
      state: 'planned',
      plan: plan([WORKFLOW_IMPORT_ROW])
    });
    expect(reason).toContain('Workflow catalog revision');
    expect(reason).not.toContain('nothing to import');
    expect(buildImportPackage(plan([importRow(), WORKFLOW_IMPORT_ROW]))).toBeNull();
  });
});

describe('Feature 085 T035 — what confirming will write, stated first (FR-058)', () => {
  it('names the eligible count and the destination, and excludes the rest', () => {
    const statement = commitStatement(plan([importRow(), SKIP_ROW, INVALID_ROW]));
    expect(statement).toContain('1 resource');
    expect(statement).toContain('the catalog');
    expect(statement).toContain('nothing else');
    expect(statement).toContain('2 rows are left unchanged');
  });

  it('names one destination and never a layer', () => {
    const statement = commitStatement(plan([importRow()]));
    expect(statement).toContain('the catalog');
    for (const layer of ['user layer', 'workspace layer', 'built-in']) {
      expect(statement).not.toContain(layer);
    }
  });

  it('mentions no leftover when every row is eligible', () => {
    const statement = commitStatement(plan([importRow(), WORKFLOW_IMPORT_ROW]));
    expect(statement).toContain('2 resources');
    expect(statement).not.toContain('unchanged');
  });

  it('says nothing would be written when no row is eligible', () => {
    const statement = commitStatement(plan([SKIP_ROW, INVALID_ROW]));
    expect(statement).toContain('write nothing');
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
      model: 'claude-opus-5-5',
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

describe('Feature 084/085 — the commit writes (FR-037, FR-038, FR-043, FR-046a)', () => {
  it('writes the imported row alone, gated on the plan revision', () => {
    const built = buildImportPackage(plan([importRow()]));
    expect(built).toEqual({
      keys: ['phases'],
      request: {
        layers: [
          {
            kind: 'phase',
            expectedRevision: PHASE_REVISION,
            definitions: [{ id: 'brought-in', body: savePhaseRowFromDefinition(FULL) }]
          }
        ]
      }
    });
    expect(JSON.stringify(built)).not.toContain(HELD.id);
  });

  it('takes the expected revision from the plan, not from a live catalog read', () => {
    const moved: ImportPlan = {
      ...plan([importRow()]),
      computedAgainstRevision: 'moved-phase-rev'
    };
    expect(buildImportPackage(moved)!.request.layers[0].expectedRevision).toBe('moved-phase-rev');
  });

  it('builds nothing for a plan with no import rows', () => {
    expect(buildImportPackage(plan([SKIP_ROW]))).toBeNull();
  });

  it('orders a package as the Phase layer then the Workflow layer', () => {
    const built = buildImportPackage(workflowPackagePlan([WORKFLOW_IMPORT_ROW, importRow()]));
    expect(built!.keys).toEqual(['phases', 'workflows']);
    expect(built!.request.layers.map((layer) => layer.kind)).toEqual(['phase', 'workflow']);
  });

  it('gates each layer on its own catalog revision', () => {
    const built = buildImportPackage(workflowPackagePlan([importRow(), WORKFLOW_IMPORT_ROW]));
    expect(built!.request.layers[0].expectedRevision).toBe(PHASE_REVISION);
    expect(built!.request.layers[1].expectedRevision).toBe(WORKFLOW_REVISION);
  });

  it('names every id it writes, under the kind that owns it', () => {
    const second = importRow({ ...FULL, phaseId: 'also-in', name: 'Also In' });
    const built = buildImportPackage(
      workflowPackagePlan([importRow(), second, CHILD_WORKFLOW_IMPORT_ROW, WORKFLOW_IMPORT_ROW])
    );
    const layers = built!.request.layers;
    expect(layers[0].kind).toBe('phase');
    expect(layers[0].definitions.map((definition) => definition.id)).toEqual([
      'brought-in',
      'also-in'
    ]);
    expect(layers[1].kind).toBe('workflow');
    expect(layers[1].definitions.map((definition) => definition.id)).toEqual([
      'child-flow',
      'ship-it-flow'
    ]);
  });

  it('writes the Workflow row alone, the stored layer having no route in', () => {
    const built = buildImportPackage(workflowPackagePlan([WORKFLOW_IMPORT_ROW]));
    expect(built!.request.layers[0].definitions).toEqual([
      {
        id: 'ship-it-flow',
        body: saveWorkflowRowFromDefinition(
          WORKFLOW_IMPORT_ROW.definition as ImportedWorkflowDefinition
        )
      }
    ]);
    expect(JSON.stringify(built)).not.toContain(HELD_WORKFLOW.workflowId);
  });

  it('builds nothing at all when a Workflow row has no revision to gate on', () => {
    expect(buildImportPackage(plan([importRow(), WORKFLOW_IMPORT_ROW]))).toBeNull();
  });
});

describe('Feature 085 T048 — the whole-commit outcome (FR-042a)', () => {
  const accepted = (key: 'phases' | 'workflows'): ImportLayerResult => ({
    key,
    ack: { status: 'accepted' }
  });
  const rejected = (key: 'phases' | 'workflows', reason: string): ImportLayerResult => ({
    key,
    ack: { status: 'rejected', reason }
  });

  it('is imported when every write it sent was accepted', () => {
    expect(commitOutcome([accepted('phases'), accepted('workflows')])).toBe('imported');
    expect(commitOutcome([accepted('phases')])).toBe('imported');
  });

  it('is failed when nothing it sent was accepted', () => {
    expect(commitOutcome([rejected('phases', 'stale-catalog')])).toBe('failed');
  });

  it('is partial when the Phase layer landed and the Workflow layer did not', () => {
    expect(commitOutcome([accepted('phases'), rejected('workflows', 'stale-catalog')])).toBe(
      'partial'
    );
  });

  it('is failed, not imported, when it sent nothing', () => {
    expect(commitOutcome([])).toBe('failed');
  });

  it('is unknown, not failed, when the last write timed out', () => {
    expect(commitOutcome([rejected('phases', 'timeout')])).toBe('unknown');
    expect(commitOutcome([accepted('phases'), rejected('workflows', 'timeout')])).toBe('unknown');
    const sentence = commitOutcomeStatement('unknown', [rejected('phases', 'timeout')]);
    expect(sentence).toMatch(/not yet known/);
    expect(sentence).not.toMatch(/Nothing was written/);
    expect(modelCatalogCommitOutcomeStatement('unknown')).toMatch(/not yet known/);
  });
});

describe('Feature 085 T048 — the outcome sentence (FR-042b, FR-042c)', () => {
  const landed = (...keys: readonly ImportLayerKey[]): readonly ImportLayerResult[] =>
    keys.map((key) => ({ key, ack: { status: 'accepted' } }));

  it('names the catalog on a complete import', () => {
    const statement = commitOutcomeStatement('imported', landed('phases'));
    expect(statement).toContain('the catalog');
    expect(statement).not.toContain('layer');
  });

  it('says nothing was written on a failure', () => {
    expect(commitOutcomeStatement('failed', [])).toContain('Nothing was written');
  });

  it('states that a partial write was left in place and how to finish it', () => {
    const statement = commitOutcomeStatement('partial', [
      ...landed('phases'),
      { key: 'workflows', ack: { status: 'rejected', reason: 'stale-catalog' } }
    ]);
    expect(statement).toContain('the catalog');
    expect(statement).toContain('still there');
    expect(statement.toLowerCase()).toContain('same document');
    for (const undone of ['rolled back', 'removed', 'reverted', 'undo']) {
      expect(statement.toLowerCase()).not.toContain(undone);
    }
  });

  it('names the one layer that landed when the Workflow layer was refused', () => {
    const statement = commitOutcomeStatement('partial', [
      ...landed('phases'),
      { key: 'workflows', ack: { status: 'rejected', reason: 'stale-catalog' } }
    ]);
    expect(statement).toContain('Phase');
    expect(statement).not.toContain('Workflow');
  });

  it('offers no compensating action for partial outcomes', () => {
    const shapes: readonly (readonly ImportLayerResult[])[] = [
      [...landed('phases'), { key: 'workflows', ack: { status: 'rejected', reason: 'r' } }]
    ];
    for (const results of shapes) {
      const statement = commitOutcomeStatement('partial', results).toLowerCase();
      for (const undone of ['rolled back', 'removed', 'reverted', 'undo', 'delete']) {
        expect(statement).not.toContain(undone);
      }
      expect(statement).toContain('still there');
    }
  });
});

describe('Feature 085 T048 — projecting the layer acks onto the plan (FR-042, FR-042a)', () => {
  const mixed = plan([importRow(), SKIP_ROW, INVALID_ROW]);
  const bothKinds = workflowPackagePlan([importRow(), WORKFLOW_IMPORT_ROW, SKIP_ROW]);

  it('produces exactly one result per plan row, in order', () => {
    const results = projectCommitResults(mixed, [
      { key: 'phases', ack: { status: 'accepted' } }
    ]);
    expect(results).toHaveLength(mixed.rows.length);
    expect(results.map((row) => row.resourceId)).toEqual(['brought-in', 'specify', null]);
  });

  it('reports every import row as imported when its layer was accepted', () => {
    const results = projectCommitResults(mixed, [
      { key: 'phases', ack: { status: 'accepted' } }
    ]);
    expect(results[0]).toMatchObject({ outcome: 'imported' });
    expect(results[0].detail).toContain('catalog');
  });

  it('reports every import row as failed, with the reason, when its layer was rejected', () => {
    const results = projectCommitResults(mixed, [
      { key: 'phases', ack: { status: 'rejected', reason: 'stale-catalog' } }
    ]);
    expect(results[0].outcome).toBe('failed');
    expect(results[0].detail).toContain('stale-catalog');
    expect(results[0].detail).toContain('reapply');
  });

  it('keeps the preflight outcome and reason for rows the commit never touched', () => {
    const results = projectCommitResults(mixed, [
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

  it('names the destination without naming a layer', () => {
    const results = projectCommitResults(mixed, [
      { key: 'phases', ack: { status: 'accepted' } }
    ]);
    expect(results[0].detail).toContain('catalog');
    expect(results[0].detail).not.toContain('layer');
  });

  it('reports the Phases imported and the Workflow failed, in one table', () => {
    const results = projectCommitResults(bothKinds, [
      { key: 'phases', ack: { status: 'accepted' } },
      { key: 'workflows', ack: { status: 'rejected', reason: 'stale-catalog' } }
    ]);
    expect(results[0]).toMatchObject({ resourceId: 'brought-in', outcome: 'imported' });
    expect(results[1].resourceId).toBe('ship-it-flow');
    expect(results[1].outcome).toBe('failed');
    expect(results[1].detail).toMatch(/changed since you started editing|stale-catalog/);
    expect(results[2].outcome).toBe('skipped');
  });

  it('uses the Workflow rejection formatter for a Workflow row', () => {
    const results = projectCommitResults(bothKinds, [
      { key: 'phases', ack: { status: 'accepted' } },
      {
        key: 'workflows',
        ack: {
          status: 'rejected',
          reason: 'workflow-validation',
          result: {
            errors: [
              {
                workflowId: 'ship-it-flow',
                field: 'nodes[0].workflowId',
                message: 'unknown Workflow'
              }
            ],
            ancestryChecksSuppressed: true
          }
        }
      }
    ]);
    expect(results[1].detail).toContain('nodes[0].workflowId');
    expect(results[1].detail).toContain('unknown Workflow');
    expect(results[1].detail).toContain('cycle');
  });

  it('says a layer was never reached rather than borrowing the other one’s reason', () => {
    const results = projectCommitResults(bothKinds, [
      { key: 'phases', ack: { status: 'rejected', reason: 'stale-catalog' } }
    ]);
    expect(results[0].detail).toContain('stale-catalog');
    expect(results[1].outcome).toBe('failed');
    expect(results[1].detail).toContain('stopped before this layer');
    expect(results[1].detail).not.toContain('stale-catalog');
  });
});

describe('Feature 085 T048 — running the commit (FR-038, FR-042, FR-042c)', () => {
  const bothKinds = workflowPackagePlan([importRow(), WORKFLOW_IMPORT_ROW]);

  function deps(ack: LifecycleResult = { status: 'accepted' }): {
    readonly publishPackage: ReturnType<typeof vi.fn>;
    readonly kindsSent: () => readonly string[];
  } {
    const publishPackage = vi.fn(async (_request: PackagePublishRequest) => ack);
    return {
      publishPackage,
      kindsSent: () =>
        publishPackage.mock.calls.flatMap((call) =>
          (call[0] as PackagePublishRequest).layers.map((layer) => layer.kind)
        )
    };
  }

  it('sends the Phase layer and the Workflow layer in one request, Phase first', async () => {
    const injected = deps();
    const report = await runImportCommit(bothKinds, injected);
    expect(injected.publishPackage).toHaveBeenCalledTimes(1);
    expect(injected.kindsSent()).toEqual(['phase', 'workflow']);
    expect(report.outcome).toBe('imported');
  });

  it('rejects every layer when the one request is refused, and sends nothing further', async () => {
    const injected = deps({ status: 'rejected', reason: 'stale-catalog' });
    const report = await runImportCommit(bothKinds, injected);
    expect(injected.publishPackage).toHaveBeenCalledTimes(1);
    expect(report.outcome).toBe('failed');
    expect(report.rows.map((row) => row.outcome)).toEqual(['failed', 'failed']);
  });

  it('sends no second request to undo the Phases when the Workflow layer failed', async () => {
    const injected = deps({
      status: 'rejected',
      reason: 'package-partial',
      result: {
        published: [{ kind: 'phase', total: 1 }],
        draftedOnly: ['workflow'],
        failedKind: 'workflow',
        cause: 'stale'
      }
    });
    const report = await runImportCommit(bothKinds, injected);
    expect(injected.publishPackage).toHaveBeenCalledTimes(1);
    expect(report.outcome).toBe('partial');
    expect(report.rows[0].outcome).toBe('imported');
    expect(report.rows[1].outcome).toBe('failed');
  });

  it('sends nothing, and reports failure, for a plan it cannot build a package for', async () => {
    const injected = deps();
    const report = await runImportCommit(plan([WORKFLOW_IMPORT_ROW]), injected);
    expect(injected.publishPackage).not.toHaveBeenCalled();
    expect(report.outcome).toBe('failed');
    expect(report.results).toEqual([]);
  });

  it('carries each layer’s own revision gate through to the send', async () => {
    const injected = deps();
    await runImportCommit(bothKinds, injected);
    const request = injected.publishPackage.mock.calls[0][0] as PackagePublishRequest;
    expect(request.layers[0]).toMatchObject({ kind: 'phase', expectedRevision: PHASE_REVISION });
    expect(request.layers[1]).toMatchObject({
      kind: 'workflow',
      expectedRevision: WORKFLOW_REVISION
    });
    expect(request.layers[0]).not.toHaveProperty('scope');
    expect(request.layers[1]).not.toHaveProperty('scope');
  });
});

// ---------------------------------------------------------------------------
// Feature 086 T054 / FR-R5-F04 — the composable Workflow layer
// ---------------------------------------------------------------------------

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
    expect(saveWorkflowRowFromDefinition(FULL_WORKFLOW)).toEqual(FULL_WORKFLOW);
  });

  it('keeps the authored graph exactly as declared, including every optional field', () => {
    const row = saveWorkflowRowFromDefinition(FULL_WORKFLOW);
    expect(row.nodes).toEqual(FULL_WORKFLOW.nodes);
    expect(row.connections).toEqual(FULL_WORKFLOW.connections);
    expect(row.startNodeIds).toEqual(FULL_WORKFLOW.startNodeIds);
    expect(row.inputs).toEqual(FULL_WORKFLOW.inputs);
    expect(row.outputs).toEqual(FULL_WORKFLOW.outputs);
    expect(row.bindings).toEqual(FULL_WORKFLOW.bindings);
    expect(row.executionDefaults).toEqual(FULL_WORKFLOW.executionDefaults);
    expect(row.recommendedNext).toEqual(FULL_WORKFLOW.recommendedNext);
  });

  it('declares no field the document left out', () => {
    const minimal: ImportedWorkflowDefinition = {
      workflowId: 'bare',
      name: 'Bare',
      version: 1,
      nodes: [{ nodeId: 'only', kind: 'phase', phaseId: 'specify' }],
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

describe('Feature 254 V-T2 — every definition kind with import rows is in the request (FR-041)', () => {
  const KIND_OF_ROW: readonly (readonly [string, ImportPlanRow, 'phase' | 'workflow', string])[] = [
    ['phase', importRow(), 'phase', String(importRow().resourceId)],
    ['workflow', WORKFLOW_IMPORT_ROW, 'workflow', String(WORKFLOW_IMPORT_ROW.resourceId)]
  ];

  it.each(KIND_OF_ROW.map((entry) => [entry[0], entry] as const))(
    'puts the %s layer in the request when the plan has a %s import row',
    (_label, [, row, kind]) => {
      const built = buildImportPackage(workflowPackagePlan([row]));

      expect(built?.request.layers.map((layer) => layer.kind)).toEqual([kind]);
    }
  );

  it('puts every kind in the request when the plan has an import row of each', () => {
    const built = buildImportPackage(workflowPackagePlan(KIND_OF_ROW.map((entry) => entry[1])));

    expect(built?.request.layers.map((layer) => layer.kind)).toEqual(['phase', 'workflow']);
    expect(built?.keys).toEqual(['phases', 'workflows']);
  });

  it('carries each row id in its layer, so no definition is named in a layer it does not belong to', () => {
    const built = buildImportPackage(workflowPackagePlan(KIND_OF_ROW.map((entry) => entry[1])));
    const idsByKind = Object.fromEntries(
      (built?.request.layers ?? []).map((layer) => [layer.kind, layer.definitions.map((entry) => entry.id)])
    );

    for (const [, , kind, id] of KIND_OF_ROW) expect(idsByKind[kind]).toEqual([id]);
  });

  it('puts a layer in the request for every kind the plan holds, and none for a kind it does not', () => {
    for (const [, row, kind] of KIND_OF_ROW) {
      const others = KIND_OF_ROW.filter((entry) => entry[2] !== kind).map((entry) => entry[1]);
      const built = buildImportPackage(workflowPackagePlan([row, ...others]));
      expect(built?.request.layers.map((layer) => layer.kind)).toContain(kind);
    }
    expect(buildImportPackage(workflowPackagePlan([SKIP_ROW]))).toBeNull();
  });
});

describe('Feature 086 T054 — two ordered layers with composable Workflows (FR-045, FR-046, FR-050)', () => {
  const twoLayers = workflowPackagePlan([
    importRow(),
    CHILD_WORKFLOW_IMPORT_ROW,
    WORKFLOW_IMPORT_ROW
  ]);

  it('orders the package as Phases, then Workflows', () => {
    expect(buildImportPackage(twoLayers)!.keys).toEqual(['phases', 'workflows']);
  });

  it('orders them by dependency, not by the order the plan happened to list', () => {
    const reversed = workflowPackagePlan([
      WORKFLOW_IMPORT_ROW,
      CHILD_WORKFLOW_IMPORT_ROW,
      importRow()
    ]);
    expect(buildImportPackage(reversed)!.keys).toEqual(['phases', 'workflows']);
  });

  it('gates each of the two layers on its own catalog revision', () => {
    const built = buildImportPackage(twoLayers)!;
    expect(built.request.layers.map((layer) => layer.expectedRevision)).toEqual([
      PHASE_REVISION,
      WORKFLOW_REVISION
    ]);
  });

  it('takes both revisions from the plan they were computed against', () => {
    const moved: ImportPlan = {
      ...twoLayers,
      computedAgainstRevision: 'moved-phase-rev',
      computedAgainstWorkflowRevision: 'moved-workflow-rev'
    };
    expect(
      buildImportPackage(moved)!.request.layers.map((layer) => layer.expectedRevision)
    ).toEqual(['moved-phase-rev', 'moved-workflow-rev']);
  });

  it('names every id it adds, under the kind that owns it', () => {
    const built = buildImportPackage(twoLayers)!;
    expect(
      built.request.layers.map((layer) => [
        layer.kind,
        layer.definitions.map((definition) => definition.id)
      ])
    ).toEqual([
      ['phase', ['brought-in']],
      ['workflow', ['child-flow', 'ship-it-flow']]
    ]);
  });

  it('writes only the Workflow layer for a package that supplies nothing else', () => {
    const built = buildImportPackage(workflowOnlyPlan([WORKFLOW_IMPORT_ROW, SKIP_ROW]))!;
    expect(built.keys).toEqual(['workflows']);
    expect(built.request.layers[0].expectedRevision).toBe(WORKFLOW_REVISION);
  });

  it('builds nothing at all when a Workflow row has no revision to gate on', () => {
    expect(buildImportPackage(plan([importRow(), WORKFLOW_IMPORT_ROW]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Feature 086 — FR-030
// ---------------------------------------------------------------------------

describe('Feature 086 T071 — a capped defect list says it was capped (FR-030)', () => {
  const DEFECTS_MAX = 20;

  function defect(index: number): { field: string; code: string; message: string } {
    return {
      field: `connections[${index}].condition.left.source`,
      code: 'unknown-operand',
      message: `Saw "step-${index}".`
    };
  }

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

    expect(lines).toHaveLength(DEFECTS_MAX + 1);
    expect(lines[lines.length - 1]).toBe('and 37 more not shown.');
  });

  it('counts the overflow from the total the host sent, not from the cap', () => {
    expect(reasonLines(invalidWorkflowRow(3, 9)).at(-1)).toBe('and 6 more not shown.');
  });

  it('adds no overflow line when the list is complete', () => {
    const lines = reasonLines(invalidWorkflowRow(4, 4));
    expect(lines).toHaveLength(4);
    expect(lines.join(' ')).not.toContain('not shown');
  });

  it('adds no overflow line for a single defect either', () => {
    expect(reasonLines(INVALID_ROW)).toEqual(['version: Saw "soon".']);
  });

  it('renders each defect as its field and message, verbatim', () => {
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

  it('renders no author text at all on a skip row, so bounds nothing (FR-030)', () => {
    const long = 'z'.repeat(64);
    const [line] = reasonLines({
      outcome: 'skip',
      resourceKind: 'phase',
      resourceId: long,
      name: 'Specify',
      presentRowStatus: 'invalid'
    });
    expect(line).not.toContain('…');
    expect(line).not.toContain(long);
    expect(line).toContain('invalid');
  });

  it('renders author text without interpreting it as markup', () => {
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

// ---------------------------------------------------------------------------
// Feature 096 T023 — the Model Catalog commit (Implementation Note 1)
// ---------------------------------------------------------------------------

const MODELS_REVISION = 'models-rev-1';

function modelCatalogPlan(rows: readonly ImportPlanRow[]): ImportPlan {
  return { ...plan(rows), computedAgainstModelsRevision: MODELS_REVISION };
}

const SECOND_MODEL_CATALOG_IMPORT_ROW: ImportPlanRow = {
  outcome: 'import',
  resourceKind: 'modelCatalog',
  resourceId: 'custom-model-b',
  backend: 'codex',
  modelId: 'custom-model-b'
};

describe('Feature 096 T023 — the Model Catalog import rows (FR-015)', () => {
  it('partitions the Model Catalog import rows, in plan order', () => {
    const rows = modelCatalogImportRows(
      modelCatalogPlan([
        MODEL_CATALOG_IMPORT_ROW,
        MODEL_CATALOG_SKIP_ALREADY_EXISTS_ROW,
        SECOND_MODEL_CATALOG_IMPORT_ROW
      ])
    );
    expect(rows.map((row) => row.resourceId)).toEqual(['custom-model-a', 'custom-model-b']);
  });

  it('excludes a skip row — it is not a model to write', () => {
    expect(
      modelCatalogImportRows(modelCatalogPlan([MODEL_CATALOG_SKIP_ALREADY_EXISTS_ROW]))
    ).toEqual([]);
  });

  it('is empty for a plan with no Model Catalog rows at all', () => {
    expect(modelCatalogImportRows(plan([importRow()]))).toEqual([]);
  });
});

describe('Feature 096 T023 — confirmation with a Model Catalog plan (FR-015, FR-056)', () => {
  it('confirms without asking for a Workflow revision it does not carry', () => {
    const reason = confirmBlockedReason({
      state: 'planned',
      plan: modelCatalogPlan([MODEL_CATALOG_IMPORT_ROW])
    });
    expect(reason).toBeNull();
  });

  it('holds closed a Model Catalog plan carrying no Model Catalog revision, and says why', () => {
    const reason = confirmBlockedReason({
      state: 'planned',
      plan: plan([MODEL_CATALOG_IMPORT_ROW])
    });
    expect(reason).toContain('Model Catalog revision');
    expect(reason).not.toContain('nothing to import');
  });

  it('still reports "nothing to import" for an all-skip Model Catalog plan', () => {
    const reason = confirmBlockedReason({
      state: 'planned',
      plan: modelCatalogPlan([MODEL_CATALOG_SKIP_ALREADY_EXISTS_ROW])
    });
    expect(reason).toContain('nothing to import');
    expect(reason).not.toContain('Model Catalog revision');
  });
});

describe('Feature 096 T023 — what confirming a Model Catalog import will do (FR-058)', () => {
  it('names the eligible count and excludes the rest, without naming a layer', () => {
    const statement = modelCatalogCommitStatement(
      modelCatalogPlan([
        MODEL_CATALOG_IMPORT_ROW,
        MODEL_CATALOG_SKIP_ALREADY_EXISTS_ROW,
        MODEL_CATALOG_SKIP_UNRECOGNIZED_BACKEND_ROW
      ])
    );
    expect(statement).toContain('1 model');
    expect(statement).toContain('model catalog');
    expect(statement).toContain('2 rows are left unchanged');
    for (const layer of ['user layer', 'workspace layer']) {
      expect(statement).not.toContain(layer);
    }
  });

  it('mentions no leftover when every row is eligible', () => {
    const statement = modelCatalogCommitStatement(
      modelCatalogPlan([MODEL_CATALOG_IMPORT_ROW, SECOND_MODEL_CATALOG_IMPORT_ROW])
    );
    expect(statement).toContain('2 models');
    expect(statement).not.toContain('unchanged');
  });

  it('says nothing would be written when no row is eligible', () => {
    const statement = modelCatalogCommitStatement(
      modelCatalogPlan([MODEL_CATALOG_SKIP_ALREADY_EXISTS_ROW])
    );
    expect(statement).toContain('write nothing');
  });
});

describe('Feature 096 T023 — the delta a Model Catalog commit sends (contracts §4)', () => {
  it('groups import rows by backend, never a pre-merged catalog', () => {
    const delta = modelCatalogImportDelta(
      modelCatalogPlan([
        MODEL_CATALOG_IMPORT_ROW,
        SECOND_MODEL_CATALOG_IMPORT_ROW,
        MODEL_CATALOG_SKIP_ALREADY_EXISTS_ROW
      ])
    );
    expect(delta).toEqual({ claude: ['custom-model-a'], codex: ['custom-model-b'] });
  });

  it('collects more than one model id under the same backend', () => {
    const secondClaudeRow: ImportPlanRow = {
      outcome: 'import',
      resourceKind: 'modelCatalog',
      resourceId: 'custom-model-c',
      backend: 'claude',
      modelId: 'custom-model-c'
    };
    const delta = modelCatalogImportDelta(
      modelCatalogPlan([MODEL_CATALOG_IMPORT_ROW, secondClaudeRow])
    );
    expect(delta).toEqual({ claude: ['custom-model-a', 'custom-model-c'] });
  });

  it('is empty for a plan with nothing eligible to import', () => {
    expect(
      modelCatalogImportDelta(modelCatalogPlan([MODEL_CATALOG_SKIP_ALREADY_EXISTS_ROW]))
    ).toEqual({});
  });
});

describe('Feature 096 T023 — projecting the Model Catalog ack onto the plan (FR-042)', () => {
  const mixed = modelCatalogPlan([
    SECOND_MODEL_CATALOG_IMPORT_ROW,
    MODEL_CATALOG_SKIP_ALREADY_EXISTS_ROW,
    MODEL_CATALOG_SKIP_UNRECOGNIZED_BACKEND_ROW
  ]);

  it('produces exactly one result per plan row, in order', () => {
    const results = projectModelCatalogCommitResults(mixed, { status: 'accepted' });
    expect(results).toHaveLength(mixed.rows.length);
    expect(results.map((row) => row.resourceId)).toEqual([
      'custom-model-b',
      'custom-model-a',
      'custom-model-x'
    ]);
  });

  it('reports the import row imported, naming its backend, on an accepted ack', () => {
    const results = projectModelCatalogCommitResults(mixed, { status: 'accepted' });
    expect(results[0]).toEqual({
      resourceId: 'custom-model-b',
      outcome: 'imported',
      detail: 'Added to codex.'
    });
  });

  it('reports the import row failed, with the formatted reason, on a rejected ack', () => {
    const results = projectModelCatalogCommitResults(mixed, {
      status: 'rejected',
      reason: 'persistence-failed'
    });
    expect(results[0]).toEqual({
      resourceId: 'custom-model-b',
      outcome: 'failed',
      detail: 'The host refused this action (`persistence-failed`).'
    });
  });

  it('formats a stale-catalog rejection as the recovery sentence, not the bare code', () => {
    const results = projectModelCatalogCommitResults(mixed, {
      status: 'rejected',
      reason: 'stale-catalog'
    });
    expect(results[0].outcome).toBe('failed');
    expect(results[0].detail).toContain('inspect it again');
  });

  it('keeps the preflight outcome and reason for skip rows, regardless of the ack', () => {
    const results = projectModelCatalogCommitResults(mixed, {
      status: 'rejected',
      reason: 'stale-catalog'
    });
    expect(results[1]).toEqual({
      resourceId: 'custom-model-a',
      outcome: 'skipped',
      detail: reasonLines(MODEL_CATALOG_SKIP_ALREADY_EXISTS_ROW).join(' ')
    });
    expect(results[2]).toEqual({
      resourceId: 'custom-model-x',
      outcome: 'skipped',
      detail: reasonLines(MODEL_CATALOG_SKIP_UNRECOGNIZED_BACKEND_ROW).join(' ')
    });
  });
});

describe('Feature 096 T023 — running the Model Catalog commit (FR-016, FR-042a)', () => {
  it('sends the delta, expected revision, and import-package intent in one call', async () => {
    const saveModels = vi.fn(
      async (_request: SaveModelsImportRequest): Promise<SaveModelsImportResult> => ({
        status: 'accepted'
      })
    );
    const report = await runModelCatalogImportCommit(modelCatalogPlan([MODEL_CATALOG_IMPORT_ROW]), {
      saveModels
    });
    expect(saveModels).toHaveBeenCalledWith({
      models: { claude: ['custom-model-a'] },
      expectedRevision: MODELS_REVISION,
      mutation: { kind: 'import-package' }
    });
    expect(report.outcome).toBe('imported');
  });

  it('sends no write, and reports failure, for a plan with no Model Catalog revision', async () => {
    const saveModels = vi.fn(
      async (_request: SaveModelsImportRequest): Promise<SaveModelsImportResult> => ({
        status: 'accepted'
      })
    );
    const report = await runModelCatalogImportCommit(plan([MODEL_CATALOG_IMPORT_ROW]), {
      saveModels
    });
    expect(saveModels).not.toHaveBeenCalled();
    expect(report.outcome).toBe('failed');
    expect(report.ack).toEqual({ status: 'rejected', reason: 'no-plan-revision' });
  });

  it('reports failed, not imported, when the save is rejected', async () => {
    const saveModels = vi.fn(
      async (_request: SaveModelsImportRequest): Promise<SaveModelsImportResult> => ({
        status: 'rejected',
        reason: 'stale-catalog',
        result: { currentRevision: 'models-rev-2' }
      })
    );
    const report = await runModelCatalogImportCommit(modelCatalogPlan([MODEL_CATALOG_IMPORT_ROW]), {
      saveModels
    });
    expect(report.outcome).toBe('failed');
    expect(report.rows[0].outcome).toBe('failed');
    expect(report.rows[0].detail).toContain('inspect it again');
  });

  it('projects one row per plan row into the report', async () => {
    const saveModels = vi.fn(
      async (_request: SaveModelsImportRequest): Promise<SaveModelsImportResult> => ({
        status: 'accepted'
      })
    );
    const withSkip = modelCatalogPlan([
      MODEL_CATALOG_IMPORT_ROW,
      MODEL_CATALOG_SKIP_ALREADY_EXISTS_ROW
    ]);
    const report = await runModelCatalogImportCommit(withSkip, { saveModels });
    expect(report.rows).toHaveLength(2);
    expect(report.rows[0].outcome).toBe('imported');
    expect(report.rows[1].outcome).toBe('skipped');
  });
});

describe('Feature 096 T023 — the Model Catalog commit outcome sentence (FR-042a)', () => {
  it('states every eligible model was added, on the imported outcome', () => {
    expect(modelCatalogCommitOutcomeStatement('imported')).toContain('added to the catalog');
  });

  it('says nothing was added, on the failed outcome', () => {
    expect(modelCatalogCommitOutcomeStatement('failed')).toContain('Nothing was added');
  });

  it('names no layer — Model Catalog has exactly one implicit target', () => {
    for (const outcome of ['imported', 'failed'] as const) {
      const statement = modelCatalogCommitOutcomeStatement(outcome);
      for (const layer of ['user layer', 'workspace layer', 'built-in']) {
        expect(statement).not.toContain(layer);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Feature 254 (FR-R4-F07, P-T1 and P-T3 webview halves, P-T2; contract P1 to P5, P9; data-model §6)
// ---------------------------------------------------------------------------

const ALL_KEYS: readonly ImportLayerKey[] = ['phases', 'workflows'];

describe('Feature 254 — one publishPackage call per commit (P-T2, contract P1, FR-013)', () => {
  const onePlan = plan([importRow()]);
  const twoPlan = workflowPackagePlan([importRow(), WORKFLOW_IMPORT_ROW]);
  const composablePlan = workflowPackagePlan([
    importRow(),
    CHILD_WORKFLOW_IMPORT_ROW,
    WORKFLOW_IMPORT_ROW
  ]);

  it.each([
    ['one layer', onePlan, ['phase']],
    ['two layers', twoPlan, ['phase', 'workflow']],
    ['composable two layers', composablePlan, ['phase', 'workflow']]
  ] as const)('sends exactly one call for %s, its layers in dependency order', async (_label, input, kinds) => {
    const publishPackage = vi.fn(async (_request: PackagePublishRequest) => ({
      status: 'accepted' as const
    }));
    const report = await runImportCommit(input, { publishPackage });
    expect(publishPackage).toHaveBeenCalledTimes(1);
    expect(publishPackage.mock.calls[0][0].layers.map((layer) => layer.kind)).toEqual(kinds);
    expect(report.outcome).toBe('imported');
  });

  it('gates each layer on the revision its own catalog was planned against', () => {
    const publishPackage = vi.fn(async (_request: PackagePublishRequest) => ({
      status: 'accepted' as const
    }));
    void runImportCommit(composablePlan, { publishPackage });
    expect(
      publishPackage.mock.calls[0][0].layers.map((layer) => [layer.kind, layer.expectedRevision])
    ).toEqual([
      ['phase', PHASE_REVISION],
      ['workflow', WORKFLOW_REVISION]
    ]);
  });

  it('turns a throwing sender into a rejection of every layer, not an escaping rejection', async () => {
    const publishPackage = vi.fn(async (_request: PackagePublishRequest): Promise<LifecycleResult> => {
      throw new Error('DataCloneError');
    });
    const report = await runImportCommit(composablePlan, { publishPackage });
    expect(publishPackage).toHaveBeenCalledTimes(1);
    expect(report.outcome).toBe('failed');
    expect(report.results.map((result) => [result.key, result.ack.status])).toEqual([
      ['phases', 'rejected'],
      ['workflows', 'rejected']
    ]);
    expect(report.rows.every((row) => row.outcome === 'failed')).toBe(true);
  });

  it('does not put a rejected row\'s exception text in the report', async () => {
    const publishPackage = vi.fn(async (_request: PackagePublishRequest): Promise<LifecycleResult> => {
      throw new Error('C:\\Users\\private\\secret.yaml');
    });
    const report = await runImportCommit(twoPlan, { publishPackage });
    expect(JSON.stringify(report)).not.toContain('secret.yaml');
  });
});

describe('Feature 254 — the fan-out of one acknowledgement (P-T2, data-model §6, FR-015)', () => {
  const twoPlan = workflowPackagePlan([importRow(), WORKFLOW_IMPORT_ROW]);

  it('returns one result per key, in key order', () => {
    const results = layerResultsOf(ALL_KEYS, { status: 'accepted' });
    expect(results.map((result) => result.key)).toEqual(ALL_KEYS);
  });

  it('gives every key an accepted result for an accepted package', () => {
    const results = layerResultsOf(ALL_KEYS, {
      status: 'accepted',
      result: { published: [{ kind: 'phase', ids: ['brought-in'], total: 1 }] }
    });
    expect(results.every((result) => result.ack.status === 'accepted')).toBe(true);
    const report = importCommitReport(twoPlan, results);
    expect(report.outcome).toBe('imported');
    expect(report.rows.map((row) => row.outcome)).toEqual(['imported', 'imported']);
  });

  it.each(['stale-catalog', 'stale-layer', 'persistence-failed', 'config-ops-unavailable', 'dispatch-failed'])(
    'rejects every key with %s, and reports every row failed with that reason',
    (reason) => {
      const results = layerResultsOf(ALL_KEYS, { status: 'rejected', reason });
      expect(results.map((result) => result.ack)).toEqual([
        { status: 'rejected', reason },
        { status: 'rejected', reason }
      ]);
      const report = importCommitReport(twoPlan, results);
      expect(report.outcome).toBe('failed');
      expect(report.rows.map((row) => row.outcome)).toEqual(['failed', 'failed']);
    }
  );

  it('marks every key unknown when the wait ran out, and reports every row unknown', () => {
    const results = layerResultsOf(ALL_KEYS, { status: 'rejected', reason: 'timeout' });
    expect(results).toHaveLength(2);
    const report = importCommitReport(twoPlan, results);
    expect(report.outcome).toBe('unknown');
    expect(report.rows.map((row) => row.outcome)).toEqual(['unknown', 'unknown']);
  });

  it('reads a package-partial acknowledgement key by key: drafted only, failed, not attempted', () => {
    const draftedThenFailed = layerResultsOf(ALL_KEYS, {
      status: 'rejected',
      reason: 'package-partial',
      result: { published: [], draftedOnly: ['phase'], failedKind: 'workflow', cause: 'EACCES' }
    });
    expect(draftedThenFailed[0]).toMatchObject({
      key: 'phases',
      ack: { status: 'rejected', reason: 'package-partial' }
    });
    expect(draftedThenFailed[1]).toMatchObject({
      key: 'workflows',
      ack: { status: 'rejected', reason: 'EACCES' }
    });

    const stoppedAtFirst = layerResultsOf(ALL_KEYS, {
      status: 'rejected',
      reason: 'package-partial',
      result: { published: [], draftedOnly: [], failedKind: 'phase', cause: 'EACCES' }
    });
    expect(stoppedAtFirst[0]).toMatchObject({
      key: 'phases',
      ack: { status: 'rejected', reason: 'EACCES' }
    });
    expect(stoppedAtFirst[1]).toMatchObject({
      key: 'workflows',
      ack: { status: 'rejected', reason: 'not-attempted' }
    });
  });

  it('lets the failed layer win over drafted-only when the publish pass stopped on it', () => {
    const results = layerResultsOf(ALL_KEYS, {
      status: 'rejected',
      reason: 'package-partial',
      result: {
        published: [{ kind: 'phase', total: 1 }],
        draftedOnly: ['workflow'],
        failedKind: 'workflow',
        cause: 'stale'
      }
    });
    expect(results[0].ack.status).toBe('accepted');
    expect(results[1].ack).toMatchObject({ status: 'rejected', reason: 'stale-catalog' });
  });

  it('falls back to rejecting every key with the reason when a partial result is not the documented shape', () => {
    for (const result of [undefined, null, 'x', 3, {}, { published: 'no' }]) {
      const results = layerResultsOf(ALL_KEYS, {
        status: 'rejected',
        reason: 'package-partial',
        result
      });
      expect(results).toHaveLength(2);
      expect(results.every((entry) => entry.ack.status === 'rejected')).toBe(true);
    }
  });
});

describe('Feature 254 — a refused package reports every defect against its row (P-T1 webview half, P3, FR-014)', () => {
  const twoPlan = workflowPackagePlan([
    importRow(),
    CHILD_WORKFLOW_IMPORT_ROW,
    WORKFLOW_IMPORT_ROW
  ]);
  const refused: LifecycleResult = {
    status: 'rejected',
    reason: 'validation-failed',
    result: {
      defects: [
        {
          kind: 'workflow',
          id: 'ship-it-flow',
          field: 'connections[0].to',
          code: 'unresolved-endpoint',
          message: 'no such node'
        },
        {
          kind: 'workflow',
          id: 'child-flow',
          field: 'nodes[0].phaseId',
          code: 'unknown-phase',
          message: 'unknown Phase'
        },
        // Same id as the child Workflow row, but a Phase defect: it must not land on the Workflow row.
        {
          kind: 'phase',
          id: 'child-flow',
          field: 'version',
          code: 'positive-integer-required',
          message: 'a Phase defect'
        }
      ],
      total: 3
    }
  };

  it('rejects every key as validation-failed', () => {
    const results = layerResultsOf(ALL_KEYS, refused);
    expect(results.map((result) => result.ack)).toEqual([refused, refused]);
  });

  it('shows each defect on the row whose kind and id match, and only there', () => {
    const report = importCommitReport(twoPlan, layerResultsOf(ALL_KEYS, refused));
    expect(report.outcome).toBe('failed');
    const [phaseRow, childWorkflowRow, rootWorkflowRow] = report.rows;
    expect(rootWorkflowRow.detail).toContain('connections[0].to');
    expect(rootWorkflowRow.detail).toContain('no such node');
    expect(childWorkflowRow.detail).toContain('nodes[0].phaseId');
    expect(childWorkflowRow.detail).toContain('unknown Phase');
    expect(childWorkflowRow.detail).not.toContain('a Phase defect');
    expect(rootWorkflowRow.detail).not.toContain('a Phase defect');
    expect(phaseRow.detail).not.toContain('nodes[0].phaseId');
  });

  it('says a row with no defect was not written because the package was refused', () => {
    const report = importCommitReport(twoPlan, layerResultsOf(ALL_KEYS, refused));
    expect(report.rows[0].outcome).toBe('failed');
    expect(report.rows[0].detail).toContain('Not written: the package was refused');
  });

  it('shows every row failed, whatever the defect list names', () => {
    const none: LifecycleResult = {
      status: 'rejected',
      reason: 'validation-failed',
      result: { defects: [], total: 0 }
    };
    const report = importCommitReport(twoPlan, layerResultsOf(ALL_KEYS, none));
    expect(report.rows.map((row) => row.outcome)).toEqual(['failed', 'failed', 'failed']);
    expect(report.rows.every((row) => row.detail.includes('Not written: the package was refused'))).toBe(true);
  });

  it('survives a validation-failed acknowledgement with no usable defect list', () => {
    for (const result of [undefined, null, 'x', {}, { defects: 'no' }]) {
      const report = importCommitReport(
        twoPlan,
        layerResultsOf(ALL_KEYS, { status: 'rejected', reason: 'validation-failed', result })
      );
      expect(report.rows.every((row) => row.outcome === 'failed')).toBe(true);
    }
  });

  it('keeps rows the commit never addressed as they were', () => {
    const withSkip = workflowPackagePlan([importRow(), SKIP_ROW]);
    const report = importCommitReport(withSkip, layerResultsOf(['phases'], refused));
    expect(report.rows[1].outcome).toBe('skipped');
  });
});

describe('Feature 254 — a partial outcome is reported exactly (P-T3 webview half, P5, FR-016)', () => {
  const twoPlan = workflowPackagePlan([importRow(), WORKFLOW_IMPORT_ROW]);

  // Pass 1 stopped: the Phase layer drafted, the Workflow layer failed.
  const draftPassStopped: LifecycleResult = {
    status: 'rejected',
    reason: 'package-partial',
    result: { published: [], draftedOnly: ['phase'], failedKind: 'workflow', cause: 'EACCES' }
  };
  // Pass 2 stopped: the Phase layer is live; the Workflow layer failed to publish and stays a draft.
  const publishPassStopped: LifecycleResult = {
    status: 'rejected',
    reason: 'package-partial',
    result: {
      published: [{ kind: 'phase', total: 1 }],
      draftedOnly: ['workflow'],
      failedKind: 'workflow',
      cause: 'stale'
    }
  };

  it('names the drafted-only layer and the failed layer, as listed', () => {
    const report = importCommitReport(twoPlan, layerResultsOf(ALL_KEYS, draftPassStopped));
    const [phaseRow, workflowRow] = report.rows;
    expect(phaseRow.outcome).toBe('failed');
    expect(phaseRow.detail).toMatch(/draft/i);
    expect(phaseRow.detail).toMatch(/not published/i);
    expect(phaseRow.detail).toContain('Workflows');
    expect(workflowRow.outcome).toBe('failed');
    expect(workflowRow.detail).toContain('EACCES');
  });

  it('is failed when only drafts landed, and says the drafts are there', () => {
    const report = importCommitReport(twoPlan, layerResultsOf(ALL_KEYS, draftPassStopped));
    expect(report.outcome).toBe('failed');
    const sentence = commitOutcomeStatement(report.outcome, report.results);
    expect(sentence).not.toMatch(/Nothing was written/);
    expect(sentence).toContain('Phases');
    expect(sentence).toMatch(/draft/i);
    expect(sentence).toMatch(/not published/i);
    expect(sentence).toMatch(/skipped/);
  });

  it('still says nothing was written when nothing was, not even a draft', () => {
    const report = importCommitReport(
      twoPlan,
      layerResultsOf(ALL_KEYS, { status: 'rejected', reason: 'stale-catalog' })
    );
    expect(commitOutcomeStatement(report.outcome, report.results)).toBe('Nothing was written.');
  });

  it('says what is live and what is only a draft when the publish pass stopped', () => {
    const report = importCommitReport(twoPlan, layerResultsOf(ALL_KEYS, publishPassStopped));
    expect(report.outcome).toBe('partial');
    expect(report.rows[0]).toMatchObject({ resourceId: 'brought-in', outcome: 'imported' });
    expect(report.rows[1].outcome).toBe('failed');
    expect(report.rows[1].detail).toMatch(/changed since you started editing|stale-catalog/);
    expect(report.rows[1].detail).toMatch(/draft/i);
    const sentence = commitOutcomeStatement(report.outcome, report.results);
    expect(sentence).toContain('Phases');
    expect(sentence).toMatch(/draft/i);
    expect(sentence).toMatch(/still there/);
    expect(sentence).toMatch(/skipped/);
  });

  it('dispatches nothing further, so nothing that landed is removed (hard rule 49)', async () => {
    const publishPackage = vi.fn(async (_request: PackagePublishRequest) => publishPassStopped);
    await runImportCommit(twoPlan, { publishPackage });
    expect(publishPackage).toHaveBeenCalledTimes(1);
  });

  it('keeps the outcome arithmetic for the documented three outcomes', () => {
    const accepted = layerResultsOf(ALL_KEYS, { status: 'accepted' });
    expect(commitOutcome(accepted)).toBe('imported');
    expect(commitOutcome(layerResultsOf(ALL_KEYS, { status: 'rejected', reason: 'stale-catalog' }))).toBe('failed');
    expect(commitOutcome(layerResultsOf(ALL_KEYS, publishPassStopped))).toBe('partial');
  });

  describe('the recovery it names (FR-R4-F07 audit G-RECOVERY)', () => {
    const outcomeSentenceOf = (ack: LifecycleResult): string => {
      const report = importCommitReport(twoPlan, layerResultsOf(ALL_KEYS, ack));
      return commitOutcomeStatement(report.outcome, report.results);
    };

    it('tells the operator to publish a drafted layer from the Builder before inspecting the document again', () => {
      const report = importCommitReport(twoPlan, layerResultsOf(ALL_KEYS, draftPassStopped));
      const detail = report.rows.at(0)?.detail ?? '';
      expect(detail).toMatch(/draft/i);
      expect(detail).toContain('Builder');
      expect(detail).toContain('same document');
      expect(detail.indexOf('Builder')).toBeLessThan(detail.indexOf('same document'));
    });

    it.each([
      ['only drafts landed', draftPassStopped],
      ['the publish pass stopped', publishPassStopped]
    ] as const)('names the same two steps, in order, in the outcome sentence when %s', (_label, ack) => {
      const sentence = outcomeSentenceOf(ack);
      expect(sentence).toContain('Builder');
      expect(sentence).toContain('same document');
      expect(sentence.indexOf('Builder')).toBeLessThan(sentence.indexOf('same document'));
      expect(sentence).toContain('drafts included');
    });

    it('offers no publish step when no layer was left as a draft', () => {
      const results: readonly ImportLayerResult[] = [
        { key: 'phases', ack: { status: 'accepted' } },
        { key: 'workflows', ack: { status: 'rejected', reason: 'stale-catalog' } }
      ];
      const statement = commitOutcomeStatement('partial', results);
      expect(statement).toContain('same document');
      expect(statement).not.toMatch(/Builder|publish/i);
    });

    it('does not call a dependency absent from the catalog when its own row says the catalog holds it as a draft', () => {
      const draftOnly: ImportPlanRow = { ...SKIP_ROW, presentRowStatus: 'draft' };
      const details = projectCommitResults(plan([draftOnly, BLOCKED_LEAF_WORKFLOW_ROW]), []).map(
        (row) => row.detail
      );
      expect(details.at(0)).toContain('in the catalog as a draft row');
      expect(details.at(1)).toContain('not published');
      expect(details.at(1)).not.toContain('not in the catalog');
    });
  });
});

describe('Feature 254 — a late outcome re-runs the fan-out for every layer (P9, TA3)', () => {
  const twoPlan = workflowPackagePlan([importRow(), WORKFLOW_IMPORT_ROW]);

  it('updates every row, not only the last layer\'s, when the late answer is accepted', () => {
    const timedOut = importCommitReport(
      twoPlan,
      layerResultsOf(ALL_KEYS, { status: 'rejected', reason: 'timeout' })
    );
    expect(timedOut.rows.map((row) => row.outcome)).toEqual(['unknown', 'unknown']);

    const late = lateImportCommitReport(twoPlan, { status: 'accepted' });
    expect(late.outcome).toBe('imported');
    expect(late.rows.map((row) => row.outcome)).toEqual(['imported', 'imported']);
    expect(late.results.map((result) => result.key)).toEqual(ALL_KEYS);
  });

  it('updates every row when the late answer is a partial outcome', () => {
    const late = lateImportCommitReport(twoPlan, {
      status: 'rejected',
      reason: 'package-partial',
      result: {
        published: [{ kind: 'phase', total: 1 }],
        draftedOnly: ['workflow'],
        failedKind: 'workflow',
        cause: 'stale'
      }
    });
    expect(late.outcome).toBe('partial');
    expect(late.rows.map((row) => row.outcome)).toEqual(['imported', 'failed']);
  });

  it('updates every row when the late answer is a refusal', () => {
    const late = lateImportCommitReport(twoPlan, { status: 'rejected', reason: 'stale-catalog' });
    expect(late.outcome).toBe('failed');
    expect(late.rows.map((row) => row.outcome)).toEqual(['failed', 'failed']);
  });

  it('reports the same layers the commit sent, for the same plan', () => {
    expect(lateImportCommitReport(twoPlan, { status: 'accepted' }).results.map((r) => r.key)).toEqual(
      buildImportPackage(twoPlan)!.keys
    );
  });

  it('reports a failed commit with no results for a plan no package can be built from', () => {
    const unbuildable = plan([WORKFLOW_IMPORT_ROW]);
    const late = lateImportCommitReport(unbuildable, { status: 'accepted' });
    expect(late.outcome).toBe('failed');
    expect(late.results).toEqual([]);
  });
});
