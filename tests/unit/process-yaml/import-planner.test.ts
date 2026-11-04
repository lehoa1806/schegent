// Feature 084 / Feature 086 / Feature 263 (FR-R5-F04) — the import planner.
//
// The planner is pure and takes STORED ROWS AT EVERY STATUS — never a resolved
// effective catalog (FR-030, data-model "PhaseIdPresence"). These tests build
// the rows by hand rather than through `resolvePhaseCatalog`, so a later change
// that quietly swaps the argument for `resolution.effective` fails here: the
// invalid-row cases have no effective definition at all.

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { resolvePhaseCatalog } from '../../../src/config/process-catalog';
import { resolveWorkflowCatalog } from '../../../src/config/workflow-catalog';
import type {
  PhaseDefinition,
  PhaseSourceRecord,
  PhaseSourceStatus
} from '../../../src/contracts/process-definitions';
import type {
  WorkflowDefinition,
  WorkflowSourceRecord,
  WorkflowSourceStatus
} from '../../../src/contracts/workflow-definitions';
import {
  findPhaseIdPresence,
  findWorkflowIdPresence,
  planPhaseImport,
  planWorkflowImport,
  type StoredDefinitionIds,
  type WorkflowPackageImportContext
} from '../../../src/services/process-yaml/import-planner';
import { validatePhaseDocument } from '../../../src/services/process-yaml/phase-yaml-validator';
import type {
  ImportPlanRow,
  ProcessYamlCatalogRevision
} from '../../../src/services/process-yaml/types';
import { parseWorkflowPackage } from '../../../src/services/process-yaml/workflow-document';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';

const REVISION: ProcessYamlCatalogRevision = 'phase-rev-1';
const WORKFLOW_REVISION: ProcessYamlCatalogRevision = 'workflow-rev-1';

const EMPTY_IDS: StoredDefinitionIds = new Set<string>();

function phaseIdsOf(rows: readonly PhaseSourceRecord[]): StoredDefinitionIds {
  return new Set(rows.map((row) => row.phaseId));
}

function workflowIdsOf(rows: readonly WorkflowSourceRecord[]): StoredDefinitionIds {
  return new Set(rows.map((row) => row.workflowId));
}

function draftOnly(...ids: readonly string[]): StoredDefinitionIds {
  return new Set(ids);
}

function storedRow(phaseId: string, status: PhaseSourceStatus): PhaseSourceRecord {
  return Object.freeze({
    key: `${phaseId}::0`,
    phaseId,
    status,
    definition: null,
    display: Object.freeze({}),
    errors: Object.freeze([])
  });
}

function storedWorkflowRow(
  workflowId: string,
  status: WorkflowSourceStatus
): WorkflowSourceRecord {
  return Object.freeze({
    key: `${workflowId}::0`,
    workflowId,
    status,
    definition: null,
    display: Object.freeze({}),
    nodePipelineIds: Object.freeze([]),
    errors: Object.freeze([])
  });
}

function validate(source: string) {
  const parsed = parseDocumentText(source);
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.refusal.code}`);
  return validatePhaseDocument(parsed.node);
}

function document(body: string): string {
  return `apiVersion: schegent/v1\nkind: Phase\n${body}`;
}

const VALID_DOCUMENT = document(
  [
    'metadata:',
    '  phaseId: ship-it',
    '  name: Ship It',
    '  version: 1',
    'spec:',
    '  instruction: Ship the thing.',
    ''
  ].join('\n')
);

const PRESENCE_STATUSES = ['effective', 'invalid'] as const;

describe('planPhaseImport', () => {
  it('plans a new id as import and names it (QS-14)', () => {
    const result = planPhaseImport(validate(VALID_DOCUMENT), [], REVISION, EMPTY_IDS);

    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.plan.rows).toEqual([
      {
        outcome: 'import',
        resourceKind: 'phase',
        resourceId: 'ship-it',
        name: 'Ship It',
        requiresRetryConditionCapability: false,
        definition: {
          phaseId: 'ship-it',
          name: 'Ship It',
          version: 1,
          instruction: 'Ship the thing.'
        }
      }
    ]);
    expect(result.plan.computedAgainstRevision).toEqual(REVISION);
    expect(result.plan.computedAgainstWorkflowRevision).toBeUndefined();
  });

  it('flags a document declaring a retryCondition as needing that capability (advisory)', () => {
    const withRetry = document(
      [
        'metadata:',
        '  phaseId: ship-it',
        '  name: Ship It',
        '  version: 1',
        'spec:',
        '  instruction: Ship the thing.',
        '  retryCondition: attempts < 2',
        ''
      ].join('\n')
    );

    const result = planPhaseImport(validate(withRetry), [], REVISION, EMPTY_IDS);

    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.plan.rows[0]).toMatchObject({
      outcome: 'import',
      requiresRetryConditionCapability: true
    });
  });

  it('plans an id claimed by any stored row as skip, whatever that row status is', () => {
    for (const status of PRESENCE_STATUSES) {
      const rows = [storedRow('ship-it', status)];

      const result = planPhaseImport(validate(VALID_DOCUMENT), rows, REVISION, phaseIdsOf(rows));

      expect(result.outcome).toBe('planned');
      if (result.outcome !== 'planned') return;
      expect(result.plan.rows).toEqual([
        {
          outcome: 'skip',
          resourceKind: 'phase',
          resourceId: 'ship-it',
          name: 'Ship It',
          presentRowStatus: status
        }
      ]);
    }
  });

  it('plans a malformed resource as invalid, naming the field and the reason (QS-18)', () => {
    const badVersion = document(
      [
        'metadata:',
        '  phaseId: ship-it',
        '  name: Ship It',
        '  version: soon',
        'spec:',
        '  instruction: Ship the thing.',
        ''
      ].join('\n')
    );

    const result = planPhaseImport(validate(badVersion), [], REVISION, EMPTY_IDS);

    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    const [row] = result.plan.rows;
    expect(row?.outcome).toBe('invalid');
    if (row?.outcome !== 'invalid') return;
    expect(row.defects).toHaveLength(1);
    expect(row.defects[0]?.field).toBe('version');
    expect(row.defects[0]?.code).toBe('positive-integer-required');
    expect(row.defects[0]?.message.length).toBeGreaterThan(0);
  });

  it('reports every defect in one pass rather than one per attempt (QS-22)', () => {
    const threeBad = document(
      [
        'metadata:',
        '  phaseId: "Not A Valid Id"',
        '  name: Ship It',
        '  version: soon',
        'spec:',
        '  instruction: Ship the thing.',
        '  effort: enormous',
        ''
      ].join('\n')
    );

    const result = planPhaseImport(validate(threeBad), [], REVISION, EMPTY_IDS);

    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    const [row] = result.plan.rows;
    expect(row?.outcome).toBe('invalid');
    if (row?.outcome !== 'invalid') return;
    expect(row.defects.map((defect) => defect.field).sort()).toEqual([
      'effort',
      'phaseId',
      'version'
    ]);
    expect(row.totalDefects).toBe(3);
  });

  it('does not claim an id for an invalid resource whose metadata never validated', () => {
    const noMetadata = document(['spec:', '  instruction: Ship the thing.', ''].join('\n'));

    const result = planPhaseImport(validate(noMetadata), [], REVISION, EMPTY_IDS);

    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    const [row] = result.plan.rows;
    expect(row?.outcome).toBe('invalid');
    if (row?.outcome !== 'invalid') return;
    expect(row.resourceId).toBeNull();
  });

  it('produces counts that equal the row count, one bucket per outcome (QS-23)', () => {
    const cases = [
      { source: VALID_DOCUMENT, rows: [] as readonly PhaseSourceRecord[] },
      { source: VALID_DOCUMENT, rows: [storedRow('ship-it', 'effective')] },
      {
        source: document(
          [
            'metadata:',
            '  phaseId: ship-it',
            '  name: Ship It',
            '  version: soon',
            'spec:',
            '  instruction: x',
            ''
          ].join('\n')
        ),
        rows: [] as readonly PhaseSourceRecord[]
      }
    ];

    for (const testCase of cases) {
      const result = planPhaseImport(
        validate(testCase.source),
        testCase.rows,
        REVISION,
        phaseIdsOf(testCase.rows)
      );
      expect(result.outcome).toBe('planned');
      if (result.outcome !== 'planned') return;
      const { counts, rows } = result.plan;
      expect(counts.import + counts.skip + counts.invalid).toBe(rows.length);
      expect(counts.import).toBe(rows.filter((row) => row.outcome === 'import').length);
      expect(counts.skip).toBe(rows.filter((row) => row.outcome === 'skip').length);
      expect(counts.invalid).toBe(rows.filter((row) => row.outcome === 'invalid').length);
    }
  });

  it('returns a refusal with NO rows for a document-level refusal (FR-027)', () => {
    const wrongKind = 'apiVersion: schegent/v1\nkind: Pipeline\nmetadata:\n  phaseId: ship-it\n';

    const result = planPhaseImport(validate(wrongKind), [], REVISION, EMPTY_IDS);

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.refusal.code).toBe('unsupported-kind');
    expect(Object.keys(result)).toEqual(['outcome', 'refusal']);
  });
});

describe('findPhaseIdPresence & findWorkflowIdPresence', () => {
  it('is null when no stored definition claims the id', () => {
    const rows = [storedRow('other', 'effective'), storedRow('third', 'invalid')];
    expect(findPhaseIdPresence(rows, 'ship-it', phaseIdsOf(rows))).toBeNull();
    expect(findWorkflowIdPresence([], 'ship-it-flow', EMPTY_IDS)).toBeNull();
  });

  it('finds a claim from a row that resolves to nothing', () => {
    const rows = [storedRow('specify', 'invalid')];
    expect(findPhaseIdPresence(rows, 'specify', phaseIdsOf(rows))).toEqual({
      status: 'invalid'
    });
  });

  it('finds a claim with no row behind it, and calls it a draft (FR-043)', () => {
    expect(findPhaseIdPresence([], 'specify', draftOnly('specify'))).toEqual({
      status: 'draft'
    });
    expect(findWorkflowIdPresence([], 'ship-it-flow', draftOnly('ship-it-flow'))).toEqual({
      status: 'draft'
    });
  });

  it('prefers the row when a definition has both a draft and an active version', () => {
    const rows = [storedRow('specify', 'effective')];
    expect(findPhaseIdPresence(rows, 'specify', draftOnly('specify'))).toEqual({
      status: 'effective'
    });
  });

  it('reports the first claimant when more than one row claims the id', () => {
    const phaseRows = [storedRow('specify', 'invalid'), storedRow('specify', 'effective')];
    expect(findPhaseIdPresence(phaseRows, 'specify', phaseIdsOf(phaseRows))).toEqual({
      status: 'invalid'
    });

    const wfRows = [
      storedWorkflowRow('ship-it-flow', 'invalid'),
      storedWorkflowRow('ship-it-flow', 'effective')
    ];
    expect(findWorkflowIdPresence(wfRows, 'ship-it-flow', workflowIdsOf(wfRows))).toEqual({
      status: 'invalid'
    });
  });

  it('matches an id exactly, not as a prefix of a longer one', () => {
    const rows = [storedRow('ship-it-again', 'effective')];
    expect(findPhaseIdPresence(rows, 'ship-it', phaseIdsOf(rows))).toBeNull();
    expect(findPhaseIdPresence(rows, 'ship-it-again', phaseIdsOf(rows))).not.toBeNull();
    expect(findPhaseIdPresence([], 'ship-it', draftOnly('ship-it-again'))).toBeNull();

    const wfRows = [storedWorkflowRow('ship-it-flow-again', 'effective')];
    const wfIds = workflowIdsOf(wfRows);
    expect(findWorkflowIdPresence(wfRows, 'ship-it-flow', wfIds)).toBeNull();
    expect(findWorkflowIdPresence(wfRows, 'ship-it-flow-again', wfIds)).not.toBeNull();
    expect(findWorkflowIdPresence([], 'ship-it-flow', draftOnly('ship-it-flow-again'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Composable Workflow package import planning (FR-R5-F04)
// ---------------------------------------------------------------------------

const SPECIFY: PhaseDefinition = Object.freeze({
  phaseId: 'specify',
  name: 'Specify',
  version: 2,
  instruction: 'Write the spec.'
});

const CHILD_WORKFLOW_DEF: WorkflowDefinition = Object.freeze({
  workflowId: 'spec-authoring',
  name: 'Spec Authoring',
  version: 2,
  nodes: Object.freeze([{ nodeId: 'specify-node', kind: 'phase' as const, phaseId: 'specify' }]),
  connections: Object.freeze([]),
  startNodeIds: Object.freeze(['specify-node'])
});

function workflowContext(
  overrides: Partial<WorkflowPackageImportContext> = {}
): WorkflowPackageImportContext {
  const phaseRows = overrides.phaseRows ?? [];
  const workflowRows = overrides.workflowRows ?? [];
  return {
    phaseRows,
    workflowRows,
    phaseIds: phaseIdsOf(phaseRows),
    workflowIds: workflowIdsOf(workflowRows),
    effectivePhases: [],
    effectiveWorkflows: [],
    revision: REVISION,
    workflowRevision: WORKFLOW_REVISION,
    ...overrides
  };
}

function parseWorkflowFixture(text: string) {
  const parsed = parseDocumentText(text);
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.refusal.code}`);
  return parseWorkflowPackage(parsed.node);
}

function includedResource(
  metadata: readonly string[],
  spec: readonly string[]
): readonly string[] {
  return [
    '    - metadata:',
    ...metadata.map((line) => `        ${line}`),
    '      spec:',
    ...spec.map((line) => `        ${line}`)
  ];
}

function workflowDocument(body: {
  readonly spec?: readonly string[];
  readonly workflows?: readonly (readonly string[])[];
  readonly phases?: readonly (readonly string[])[];
  readonly id?: string;
  readonly version?: string;
}): string {
  const lines = [
    'apiVersion: schegent/v1',
    'kind: Workflow',
    'metadata:',
    `  id: ${body.id ?? 'ship-it-flow'}`,
    '  name: Ship It Flow',
    `  version: ${body.version ?? '1'}`,
    'spec:',
    ...(
      body.spec ?? [
        'nodes:',
        '  - nodeId: draft',
        '    kind: workflow',
        '    workflowId: spec-authoring',
        'startNodeIds:',
        '  - draft'
      ]
    ).map((line) => `  ${line}`)
  ];
  if (body.workflows !== undefined || body.phases !== undefined) {
    lines.push('included:');
    if (body.workflows !== undefined) lines.push('  workflows:', ...body.workflows.flat());
    if (body.phases !== undefined) lines.push('  phases:', ...body.phases.flat());
  }
  return `${lines.join('\n')}\n`;
}

const INCLUDED_SPEC_AUTHORING = includedResource(
  ['id: spec-authoring', 'name: Spec Authoring', 'version: 2'],
  [
    'nodes:',
    '  - nodeId: specify-node',
    '    kind: phase',
    '    phaseId: specify',
    'startNodeIds:',
    '  - specify-node'
  ]
);

const INCLUDED_SPECIFY = includedResource(
  ['phaseId: specify', 'name: Specify', 'version: 2'],
  ['instruction: Write the spec.']
);

const SELF_CONTAINED_WORKFLOW = workflowDocument({
  workflows: [INCLUDED_SPEC_AUTHORING],
  phases: [INCLUDED_SPECIFY]
});

const REFERENCES_ONLY_WORKFLOW = workflowDocument({});

function plannedWorkflowRows(
  text: string,
  ctx: WorkflowPackageImportContext
): readonly ImportPlanRow[] {
  const result = planWorkflowImport(parseWorkflowFixture(text), ctx);
  if (result.outcome !== 'planned') throw new Error(`expected a plan, got ${result.outcome}`);
  return result.plan.rows;
}

describe('planWorkflowImport', () => {
  it('reports one row per declared resource in declared document order: root, included.workflows, included.phases', () => {
    const rows = plannedWorkflowRows(SELF_CONTAINED_WORKFLOW, workflowContext());

    expect(rows.map((row) => [row.resourceKind, row.resourceId])).toEqual([
      ['workflow', 'ship-it-flow'],
      ['workflow', 'spec-authoring'],
      ['phase', 'specify']
    ]);
  });

  it('plans every resource of a self-contained composable package as import when nothing claims its id', () => {
    const rows = plannedWorkflowRows(SELF_CONTAINED_WORKFLOW, workflowContext());

    expect(rows.map((row) => row.outcome)).toEqual(['import', 'import', 'import']);
    for (const row of rows) {
      if (row.outcome !== 'import') continue;
      if (row.resourceKind === 'modelCatalog') continue;
      expect(row.definition).toBeDefined();
    }
  });

  it('carries the root Workflow definition verbatim, including its authored order', () => {
    const rows = plannedWorkflowRows(SELF_CONTAINED_WORKFLOW, workflowContext());
    const [root] = rows;
    expect(root?.outcome).toBe('import');
    if (root?.outcome !== 'import' || root.resourceKind !== 'workflow') return;

    expect(root.definition).toEqual({
      workflowId: 'ship-it-flow',
      name: 'Ship It Flow',
      version: 1,
      nodes: [{ nodeId: 'draft', kind: 'workflow', workflowId: 'spec-authoring' }],
      connections: [],
      startNodeIds: ['draft']
    });
  });

  it('gives every row an outcome from the closed set, whatever the catalog holds', () => {
    const claimed = workflowContext({
      workflowRows: [
        storedWorkflowRow('ship-it-flow', 'effective'),
        storedWorkflowRow('spec-authoring', 'invalid')
      ],
      phaseRows: [storedRow('specify', 'invalid')]
    });

    for (const rows of [
      plannedWorkflowRows(SELF_CONTAINED_WORKFLOW, workflowContext()),
      plannedWorkflowRows(SELF_CONTAINED_WORKFLOW, claimed),
      plannedWorkflowRows(REFERENCES_ONLY_WORKFLOW, workflowContext())
    ]) {
      for (const row of rows) {
        expect(['import', 'skip', 'blocked', 'invalid']).toContain(row.outcome);
      }
    }
  });

  it('skips a Workflow whose id a stored row already claims, at any status', () => {
    for (const status of PRESENCE_STATUSES) {
      const rows = plannedWorkflowRows(
        SELF_CONTAINED_WORKFLOW,
        workflowContext({ workflowRows: [storedWorkflowRow('ship-it-flow', status)] })
      );

      expect(rows[0]).toEqual({
        outcome: 'skip',
        resourceKind: 'workflow',
        resourceId: 'ship-it-flow',
        name: 'Ship It Flow',
        presentRowStatus: status
      });
      expect(rows.slice(1).map((row) => row.outcome)).toEqual(['import', 'import']);
    }
  });

  it('asks each catalog about its own kind of id and no other', () => {
    const crossed = workflowContext({
      phaseRows: [
        storedRow('ship-it-flow', 'effective'),
        storedRow('spec-authoring', 'effective')
      ],
      workflowRows: [storedWorkflowRow('specify', 'effective')]
    });

    expect(plannedWorkflowRows(SELF_CONTAINED_WORKFLOW, crossed).map((row) => row.outcome)).toEqual([
      'import',
      'import',
      'import'
    ]);
  });

  it('skips a Workflow that holds only a draft (FR-043)', () => {
    const rows = plannedWorkflowRows(
      SELF_CONTAINED_WORKFLOW,
      workflowContext({ workflowIds: draftOnly('ship-it-flow') })
    );

    expect(rows[0]).toEqual({
      outcome: 'skip',
      resourceKind: 'workflow',
      resourceId: 'ship-it-flow',
      name: 'Ship It Flow',
      presentRowStatus: 'draft'
    });
    expect(rows.slice(1).map((row) => row.outcome)).toEqual(['import', 'import']);
  });

  it('carries one revision per layer this plan can write, with no computedAgainstPipelineRevision', () => {
    const full = planWorkflowImport(
      parseWorkflowFixture(SELF_CONTAINED_WORKFLOW),
      workflowContext()
    );
    expect(full.outcome).toBe('planned');
    if (full.outcome !== 'planned') return;

    expect(full.plan.computedAgainstRevision).toEqual(REVISION);
    expect(full.plan.computedAgainstWorkflowRevision).toEqual(WORKFLOW_REVISION);
    expect('computedAgainstPipelineRevision' in full.plan).toBe(false);
  });

  it('blocks a references-only Workflow whose child workflow node the catalog does not supply', () => {
    const rows = plannedWorkflowRows(REFERENCES_ONLY_WORKFLOW, workflowContext());

    expect(rows).toEqual([
      {
        outcome: 'blocked',
        resourceKind: 'workflow',
        resourceId: 'ship-it-flow',
        name: 'Ship It Flow',
        reason: {
          code: 'dependency-absent',
          dependency: { kind: 'workflow', resourceId: 'spec-authoring' }
        }
      }
    ]);
  });

  it('imports a references-only Workflow whose child workflow and transitive phase the effective catalogs resolve', () => {
    const rows = plannedWorkflowRows(
      REFERENCES_ONLY_WORKFLOW,
      workflowContext({
        effectiveWorkflows: [CHILD_WORKFLOW_DEF],
        workflowRows: [storedWorkflowRow('spec-authoring', 'effective')],
        effectivePhases: [SPECIFY],
        phaseRows: [storedRow('specify', 'effective')]
      })
    );

    expect(rows.map((row) => row.outcome)).toEqual(['import']);
  });

  it('names the propagated chain when a child Workflow is itself blocked on a missing Phase', () => {
    const missingPhase = workflowDocument({ workflows: [INCLUDED_SPEC_AUTHORING] });

    const rows = plannedWorkflowRows(missingPhase, workflowContext());

    expect(rows[0]).toEqual({
      outcome: 'blocked',
      resourceKind: 'workflow',
      resourceId: 'ship-it-flow',
      name: 'Ship It Flow',
      reason: {
        code: 'dependency-blocked',
        dependency: { kind: 'workflow', resourceId: 'spec-authoring' },
        via: { kind: 'phase', resourceId: 'specify' }
      }
    });
    expect(rows[1]).toMatchObject({
      outcome: 'blocked',
      resourceKind: 'workflow',
      resourceId: 'spec-authoring',
      reason: { code: 'dependency-absent', dependency: { kind: 'phase', resourceId: 'specify' } }
    });
  });

  it('evaluates nested included.workflows in bottom-up topological dependency order even when declared top-down', () => {
    const midWorkflow = includedResource(
      ['id: mid-flow', 'name: Mid Flow', 'version: 1'],
      [
        'nodes:',
        '  - nodeId: call-leaf',
        '    kind: workflow',
        '    workflowId: leaf-flow',
        'startNodeIds:',
        '  - call-leaf'
      ]
    );
    const leafWorkflow = includedResource(
      ['id: leaf-flow', 'name: Leaf Flow', 'version: 1'],
      [
        'nodes:',
        '  - nodeId: run-specify',
        '    kind: phase',
        '    phaseId: specify',
        'startNodeIds:',
        '  - run-specify'
      ]
    );
    const nestedDoc = workflowDocument({
      spec: [
        'nodes:',
        '  - nodeId: call-mid',
        '    kind: workflow',
        '    workflowId: mid-flow',
        'startNodeIds:',
        '  - call-mid'
      ],
      workflows: [midWorkflow, leafWorkflow],
      phases: [INCLUDED_SPECIFY]
    });

    const rows = plannedWorkflowRows(nestedDoc, workflowContext());
    expect(rows.map((row) => [row.resourceKind, row.resourceId, row.outcome])).toEqual([
      ['workflow', 'ship-it-flow', 'import'],
      ['workflow', 'mid-flow', 'import'],
      ['workflow', 'leaf-flow', 'import'],
      ['phase', 'specify', 'import']
    ]);
  });

  it('returns a refusal with NO plan and no partial rows for a document-level refusal', () => {
    for (const text of [
      'apiVersion: schegent/v2\nkind: Workflow\nmetadata:\n  id: ship-it-flow\n',
      'apiVersion: schegent/v1\nkind: Pipeline\nmetadata:\n  id: ship-it-flow\n',
      'metadata:\n  id: ship-it-flow\n',
      workflowDocument({
        workflows: [INCLUDED_SPEC_AUTHORING],
        phases: [INCLUDED_SPECIFY, INCLUDED_SPECIFY]
      })
    ]) {
      const result = planWorkflowImport(parseWorkflowFixture(text), workflowContext());

      expect(result.outcome).toBe('refused');
      if (result.outcome !== 'refused') continue;
      expect(Object.keys(result)).toEqual(['outcome', 'refusal']);
      expect(result.refusal.code.length).toBeGreaterThan(0);
    }
  });
});

describe('the shipped workflow example imports into a workspace that has never imported', () => {
  const EXAMPLE = readFileSync(
    join(__dirname, '..', '..', '..', 'examples', 'example-two-node.workflow.yaml'),
    'utf8'
  );

  function shippedContext(): WorkflowPackageImportContext {
    const phaseCatalog = resolvePhaseCatalog({ rows: [], revision: REVISION });
    const workflowCatalog = resolveWorkflowCatalog({
      rows: [],
      revision: WORKFLOW_REVISION,
      phaseCatalog: { effective: phaseCatalog.effective, records: phaseCatalog.records }
    });
    return {
      phaseRows: phaseCatalog.records,
      workflowRows: workflowCatalog.records,
      phaseIds: phaseIdsOf(phaseCatalog.records),
      workflowIds: workflowIdsOf(workflowCatalog.records),
      effectivePhases: phaseCatalog.effective,
      effectiveWorkflows: workflowCatalog.effective,
      revision: phaseCatalog.revision,
      workflowRevision: workflowCatalog.revision
    };
  }

  it('plans five rows — root Workflow, two child Workflows, and two Phases — and skips none', () => {
    const rows = plannedWorkflowRows(EXAMPLE, shippedContext());

    expect(rows).toHaveLength(5);
    expect(rows.filter((row) => row.outcome === 'skip')).toEqual([]);
    expect(rows.map((row) => row.outcome)).toEqual(Array.from({ length: 5 }, () => 'import'));
  });

  it('names the root Workflow first, then included.workflows, then included.phases in declaration order', () => {
    const rows = plannedWorkflowRows(EXAMPLE, shippedContext());

    expect(rows.map((row) => [row.resourceKind, row.resourceId])).toEqual([
      ['workflow', 'example-conditional-graph'],
      ['workflow', 'example-draft'],
      ['workflow', 'example-revise'],
      ['phase', 'example-write-draft'],
      ['phase', 'example-revise-draft']
    ]);
  });
});
