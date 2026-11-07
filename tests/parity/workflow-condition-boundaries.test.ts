// Feature 254 (FR-R4-F07, C-T1; contract C2; data-model §7; FR-026, FR-027, SC-007) — one rule, the
// same defect, at every boundary.
//
// A Workflow condition whose outcome v1 operand semantics fix in advance (an ordering operator, a number
// or boolean under `equals`/`notEquals`, a non-text member of an `in` list) can never match, so every
// Run through it took the default route. It was accepted by every path that validates a Workflow. The
// graph validator now refuses it with `condition-comparison-unsupported` at `connections[<i>].condition`
// (tests/unit/config/workflow-graph-validator.test.ts holds the rule table), and this file holds the four
// boundaries to the same answer for the same input:
//
//   * the catalog projection, which is what the Builder shows for a saved definition,
//   * the sidebar publish path (`publishPackage` over `definition-semantics`), which refuses the publish,
//   * headless `validateProcessDefinition`,
//   * a YAML import preflight row, which is `invalid` and carries the defect.
//
// The YAML cases ship their child Workflows: the import's graph pass runs only when every node
// of the Workflow resolves (`package-resolver.ts`), and a Workflow whose children are absent is
// `blocked` first, as it always was. Feature 285 (FR-010): the other three boundaries use the
// same child-Workflow graph. They used Pipeline nodes, a retired field the headless boundary now
// refuses by default.
//
// Two controls keep the corpus honest. A valid `equals` string is reported by no boundary, so a rule
// that refused everything would fail. And a node status compared with a number keeps its existing
// `condition-right-invalid` at every boundary, with no second defect, so the rule is not claiming a
// case the right-operand check already owns.

import { describe, expect, it } from 'vitest';

import { publishPackage, type CatalogStore } from '../../src/catalog';
import { resolveWorkflowCatalog } from '../../src/config/workflow-catalog';
import { createDefinitionSemantics } from '../../src/config/definition-semantics';
import type { PackagePublishRequest } from '../../src/contracts/catalog-lifecycle';
import { resolvePhaseCatalog } from '../../src/config/process-catalog';
import { validateWorkflowDefinition } from '../../src/config/workflow-definition-validator';
import type { WorkflowDefinition } from '../../src/contracts/workflow-definitions';
import { validateProcessDefinition } from '../../src/headless/process-definition-api';
import { previewProcessDocument } from '../../src/headless/process-yaml-api';
import { FakeCatalogStore } from '../fixtures/fake-catalog-store';

const UNSUPPORTED = 'condition-comparison-unsupported';
const RIGHT_INVALID = 'condition-right-invalid';

// ---------------------------------------------------------------------------
// One Workflow, one condition
// ---------------------------------------------------------------------------

const OUTPUT_LEFT = { source: 'node-output', nodeId: 'draft', field: 'verdict' } as const;
const STATUS_LEFT = { source: 'node-status', nodeId: 'draft' } as const;

const PHASE_ROW = {
  id: 'cond-specify',
  name: 'Cond Specify',
  version: 1,
  instruction: 'Write the spec.'
};
const PHASES = resolvePhaseCatalog({ rows: [PHASE_ROW], revision: 'rev-1' });

/**
 * The node-output operand needs a structured output on its node's child Workflow; `spec-document`
 * feeds the edge. These are the YAML document's `included.workflows`, as stored rows.
 */
const DRAFT_CHILD_ROW = {
  id: 'cond-draft',
  name: 'Cond Draft',
  version: 1,
  outputs: [
    { portId: 'spec-document', label: 'Spec', type: 'markdown' },
    { portId: 'verdict-data', label: 'Verdict', type: 'structured-data' }
  ],
  nodes: [{ nodeId: 'step', kind: 'phase', phaseId: 'cond-specify' }],
  bindings: [
    { kind: 'output', nodeId: 'step', portId: 'spec-document', outputKey: 'spec-document' },
    { kind: 'output', nodeId: 'step', portId: 'verdict-data', outputKey: 'verdict-data' }
  ],
  startNodeIds: ['step']
};
const REVIEW_CHILD_ROW = {
  id: 'cond-review',
  name: 'Cond Review',
  version: 1,
  inputs: [{ portId: 'spec', label: 'Spec', type: 'text', required: false }],
  nodes: [{ nodeId: 'step', kind: 'phase', phaseId: 'cond-specify' }],
  startNodeIds: ['step']
};

function childDefinition(row: Record<string, unknown>): WorkflowDefinition {
  const result = validateWorkflowDefinition(row);
  if (result.definition === null) throw new Error(`fixture child ${String(row['id'])} is invalid`);
  return result.definition;
}
interface Case {
  readonly label: string;
  readonly condition: Record<string, unknown>;
}

const UNSUPPORTED_CASES: readonly Case[] = [
  { label: 'equals a number', condition: { left: OUTPUT_LEFT, operator: 'equals', right: 5 } },
  { label: 'equals a boolean', condition: { left: OUTPUT_LEFT, operator: 'equals', right: true } },
  { label: 'notEquals a number', condition: { left: OUTPUT_LEFT, operator: 'notEquals', right: 5 } },
  { label: 'notEquals a boolean', condition: { left: OUTPUT_LEFT, operator: 'notEquals', right: false } },
  { label: 'in a list holding a number', condition: { left: OUTPUT_LEFT, operator: 'in', right: ['ship', 5] } },
  { label: 'in a list of numbers', condition: { left: OUTPUT_LEFT, operator: 'in', right: [5, 6] } },
  { label: 'greaterThan', condition: { left: OUTPUT_LEFT, operator: 'greaterThan', right: 3 } },
  { label: 'greaterThanOrEqual', condition: { left: OUTPUT_LEFT, operator: 'greaterThanOrEqual', right: 3 } },
  { label: 'lessThan', condition: { left: OUTPUT_LEFT, operator: 'lessThan', right: 3 } },
  { label: 'lessThanOrEqual', condition: { left: OUTPUT_LEFT, operator: 'lessThanOrEqual', right: 3 } }
];

const VALID_CASE: Case = {
  label: 'equals a string (valid)',
  condition: { left: OUTPUT_LEFT, operator: 'equals', right: 'ship' }
};

const STATUS_NUMBER_CASE: Case = {
  label: 'a node status equals a number',
  condition: { left: STATUS_LEFT, operator: 'equals', right: 5 }
};

/** The workflow's graph: one connection, carrying the condition. */
function graphOf(condition: Record<string, unknown>) {
  return {
    nodes: [
      { nodeId: 'draft', kind: 'workflow', workflowId: 'cond-draft' },
      { nodeId: 'review', kind: 'workflow', workflowId: 'cond-review' }
    ],
    connections: [
      {
        from: { nodeId: 'draft', portId: 'spec-document' },
        to: { nodeId: 'review', portId: 'spec' },
        condition
      }
    ],
    startNodeIds: ['draft']
  };
}

/** What a boundary reported about the condition: its code and field, nothing else compared. */
interface Reported {
  readonly code: string;
  readonly field: string;
}

const relevant = (reported: readonly Reported[]): readonly Reported[] =>
  reported.filter((entry) => entry.code === UNSUPPORTED || entry.code === RIGHT_INVALID);

// ---------------------------------------------------------------------------
// The four boundaries
// ---------------------------------------------------------------------------

/** The catalog projection: what the Builder shows for the saved definition. */
function catalogBoundary(condition: Record<string, unknown>): {
  readonly effective: boolean;
  readonly reported: readonly Reported[];
} {
  const resolution = resolveWorkflowCatalog({
    rows: [
      DRAFT_CHILD_ROW,
      REVIEW_CHILD_ROW,
      { id: 'cond-flow', name: 'Cond Flow', version: 1, ...graphOf(condition) }
    ],
    revision: 'rev-1',
    phaseCatalog: PHASES,
    pipelineCatalog: { effective: [], records: [] }
  });
  const record = resolution.records.find((candidate) => candidate.workflowId === 'cond-flow');
  const errors = record?.errors ?? [];
  return {
    effective: record?.status === 'effective',
    reported: relevant(errors.map((e) => ({ code: e.code, field: e.field })))
  };
}

const semantics = createDefinitionSemantics({ defaultWorkflowId: () => '' });

/** The sidebar publish path: the whole document is validated before any write. */
async function publishBoundary(condition: Record<string, unknown>): Promise<{
  readonly refused: boolean;
  readonly reported: readonly Reported[];
}> {
  const inner = new FakeCatalogStore();
  const store: CatalogStore = {
    read: () => inner.read(),
    applyLifecycleWrite: (write) => inner.applyLifecycleWrite(write),
    saveDraftLayer: (request) => inner.saveDraftLayer(request),
    publishLayer: (request) => inner.publishLayer(request),
    readVersion: (kind, id, versionId) => inner.readVersion(kind, id, versionId),
    listVersions: (kind, id) => inner.listVersions(kind, id),
    listDefinitions: (kind) => inner.listDefinitions(kind)
  };
  const request: PackagePublishRequest = {
    layers: [
      {
        kind: 'phase',
        expectedRevision: inner.revisionOf('phase'),
        definitions: [{ id: 'cond-specify', body: PHASE_ROW }]
      },
      {
        kind: 'workflow',
        expectedRevision: inner.revisionOf('workflow'),
        definitions: [
          { id: 'cond-draft', body: DRAFT_CHILD_ROW },
          { id: 'cond-review', body: REVIEW_CHILD_ROW },
          { id: 'cond-flow', body: { id: 'cond-flow', name: 'Cond Flow', version: 1, ...graphOf(condition) } }
        ]
      }
    ]
  };
  const outcome = await publishPackage({ store, semantics }, request);
  if (outcome.outcome === 'refused') {
    return {
      refused: true,
      reported: relevant(outcome.refusal.defects.map((d) => ({ code: d.code, field: d.field })))
    };
  }
  return { refused: false, reported: [] };
}

/** Headless `validateProcessDefinition`. */
function headlessBoundary(condition: Record<string, unknown>): readonly Reported[] {
  const verdict = validateProcessDefinition({
    kind: 'workflow',
    definition: { workflowId: 'cond-flow', name: 'Cond Flow', version: 1, ...graphOf(condition) },
    catalog: {
      phases: PHASES.effective,
      workflows: [childDefinition(DRAFT_CHILD_ROW), childDefinition(REVIEW_CHILD_ROW)]
    }
  });
  if (!('kind' in verdict) || verdict.kind !== 'workflow') throw new Error('expected a Workflow verdict');
  return relevant(verdict.errors.map((e) => ({ code: e.code, field: e.field })));
}

function yamlScalar(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

/** A self-contained Workflow package: every node's child Workflow and Phase ships with it. */
function workflowDocument(condition: Record<string, unknown>): string {
  const left = condition['left'] as Record<string, unknown>;
  const right = condition['right'];
  const rightLines =
    right === undefined
      ? []
      : Array.isArray(right)
        ? ['        right:', ...right.map((value) => `          - ${yamlScalar(value)}`)]
        : [`        right: ${yamlScalar(right)}`];
  return [
    'apiVersion: schegent/v1',
    'kind: Workflow',
    'metadata:',
    '  id: cond-flow',
    '  name: Cond Flow',
    '  version: 1',
    'spec:',
    '  nodes:',
    '    - nodeId: draft',
    '      kind: workflow',
    '      workflowId: cond-draft',
    '    - nodeId: review',
    '      kind: workflow',
    '      workflowId: cond-review',
    '  connections:',
    '    - from:',
    '        nodeId: draft',
    '        portId: spec-document',
    '      to:',
    '        nodeId: review',
    '        portId: spec',
    '      condition:',
    '        left:',
    `          source: ${yamlScalar(left['source'])}`,
    `          nodeId: ${yamlScalar(left['nodeId'])}`,
    ...(left['field'] === undefined ? [] : [`          field: ${yamlScalar(left['field'])}`]),
    `        operator: ${yamlScalar(condition['operator'])}`,
    ...rightLines,
    '  startNodeIds:',
    '    - draft',
    'included:',
    '  workflows:',
    '    - metadata:',
    '        id: cond-draft',
    '        name: Cond Draft',
    '        version: 1',
    '      spec:',
    '        outputs:',
    '          - portId: spec-document',
    '            label: Spec',
    '            type: markdown',
    '          - portId: verdict-data',
    '            label: Verdict',
    '            type: structured-data',
    '        nodes:',
    '          - nodeId: step',
    '            kind: phase',
    '            phaseId: cond-specify',
    '        bindings:',
    '          - kind: output',
    '            nodeId: step',
    '            portId: spec-document',
    '            outputKey: spec-document',
    '          - kind: output',
    '            nodeId: step',
    '            portId: verdict-data',
    '            outputKey: verdict-data',
    '        startNodeIds:',
    '          - step',
    '    - metadata:',
    '        id: cond-review',
    '        name: Cond Review',
    '        version: 1',
    '      spec:',
    '        inputs:',
    '          - portId: spec',
    '            label: Spec',
    '            type: text',
    '            required: false',
    '        nodes:',
    '          - nodeId: step',
    '            kind: phase',
    '            phaseId: cond-specify',
    '        startNodeIds:',
    '          - step',
    '  phases:',
    '    - metadata:',
    '        phaseId: cond-specify',
    '        name: Cond Specify',
    '        version: 1',
    '      spec:',
    '        instruction: Write the spec.',
    ''
  ].join('\n');
}

/** A YAML import preflight: the plan row for the Workflow. */
async function importBoundary(condition: Record<string, unknown>): Promise<{
  readonly rowOutcome: string;
  readonly reported: readonly Reported[];
}> {
  const empty = () => ({ rows: [], revision: 'rev-0' });
  const result = await previewProcessDocument(
    {
      readPhaseConfig: empty,
      readWorkflowConfig: empty,
      readModelsConfig: () => ({}),
      logger: { sanitize: (value: string) => value, warn: () => undefined }
    },
    { bytes: new TextEncoder().encode(workflowDocument(condition)) }
  );
  if (!('plan' in result)) {
    throw new Error(`the document did not plan: ${JSON.stringify(result)}`);
  }
  const row = result.plan.rows.find((candidate) => candidate.resourceKind === 'workflow');
  if (row === undefined) throw new Error('the plan has no Workflow row');
  return {
    rowOutcome: row.outcome,
    reported: relevant(
      row.outcome === 'invalid' ? row.defects.map((d) => ({ code: d.code, field: d.field })) : []
    )
  };
}

// ---------------------------------------------------------------------------
// The corpus, at each boundary
// ---------------------------------------------------------------------------

const ONE_UNSUPPORTED: readonly Reported[] = [{ code: UNSUPPORTED, field: 'connections[0].condition' }];

describe('FR-R4-F07 C-T1 — the same defect at every boundary (FR-026, FR-027, SC-007)', () => {
  it('keeps the fixtures valid: the clean Workflow is effective at the catalog and plans as an import', async () => {
    expect(catalogBoundary(VALID_CASE.condition).effective).toBe(true);
    expect((await importBoundary(VALID_CASE.condition)).rowOutcome).toBe('import');
    expect((await publishBoundary(VALID_CASE.condition)).refused).toBe(false);
  });

  describe.each(UNSUPPORTED_CASES)('$label', ({ condition }) => {
    it('the catalog projection marks the Workflow invalid, with one defect at the condition', () => {
      const boundary = catalogBoundary(condition);
      expect(boundary.effective).toBe(false);
      expect(boundary.reported).toEqual(ONE_UNSUPPORTED);
    });

    it('the sidebar publish path refuses the publication with that one defect', async () => {
      const boundary = await publishBoundary(condition);
      expect(boundary.refused).toBe(true);
      expect(boundary.reported).toEqual(ONE_UNSUPPORTED);
    });

    it('headless validation reports that one defect', () => {
      expect(headlessBoundary(condition)).toEqual(ONE_UNSUPPORTED);
    });

    it('a YAML import plans the Workflow row invalid, with that one defect', async () => {
      const boundary = await importBoundary(condition);
      expect(boundary.rowOutcome).toBe('invalid');
      expect(boundary.reported).toEqual(ONE_UNSUPPORTED);
    });
  });

  describe('the valid control: a string comparison is reported by no boundary', () => {
    it('catalog, publish, headless and import', async () => {
      const { condition } = VALID_CASE;
      expect(catalogBoundary(condition).reported).toEqual([]);
      expect((await publishBoundary(condition)).reported).toEqual([]);
      expect(headlessBoundary(condition)).toEqual([]);
      expect((await importBoundary(condition)).reported).toEqual([]);
    });
  });

  describe('the node-status control: a number keeps condition-right-invalid, with no new defect', () => {
    const RIGHT_FIELD: readonly Reported[] = [
      { code: RIGHT_INVALID, field: 'connections[0].condition.right' }
    ];

    it('at every boundary', async () => {
      const { condition } = STATUS_NUMBER_CASE;
      expect(catalogBoundary(condition).reported).toEqual(RIGHT_FIELD);
      expect((await publishBoundary(condition)).reported).toEqual(RIGHT_FIELD);
      expect(headlessBoundary(condition)).toEqual(RIGHT_FIELD);
      expect((await importBoundary(condition)).reported).toEqual(RIGHT_FIELD);
    });
  });
});
