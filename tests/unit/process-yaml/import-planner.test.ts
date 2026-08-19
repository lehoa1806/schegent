// Feature 084 T028 — the import planner, written before the module exists.
//
// Covers quickstart QS-14 (a new id plans `import`), QS-18 (a malformed
// resource plans `invalid` naming the field and the reason), QS-22 (every
// defect in one pass, not one per attempt) and QS-23 (counts equal row count).
//
// The planner is pure and takes STORED ROWS OF EVERY LAYER — never a resolved
// effective catalog (FR-030, data-model "PhaseIdPresence"). These tests build
// the rows by hand rather than through `resolvePhaseCatalog`, so a later change
// that quietly swaps the argument for `resolution.effective` fails here: the
// invalid-row and shadowed-row cases have no effective definition at all.

import { describe, expect, it } from 'vitest';
import type {
  PhaseDefinition,
  PhaseDefinitionScope,
  PhaseSourceRecord,
  PhaseSourceStatus
} from '../../../src/contracts/process-definitions';
import type {
  PipelineDefinition,
  PipelineDefinitionScope,
  PipelineSourceRecord,
  PipelineSourceStatus
} from '../../../src/contracts/pipeline-definitions';
import type {
  WorkflowDefinitionScope,
  WorkflowSourceRecord,
  WorkflowSourceStatus
} from '../../../src/contracts/workflow-definitions';
import {
  findPhaseIdPresence,
  findPipelineIdPresence,
  findWorkflowIdPresence,
  planPhaseImport,
  planPipelineImport,
  planWorkflowImport,
  type PackageImportContext,
  type WorkflowPackageImportContext
} from '../../../src/services/process-yaml/import-planner';
import { parsePipelinePackage } from '../../../src/services/process-yaml/pipeline-document';
import { parseWorkflowPackage } from '../../../src/services/process-yaml/workflow-document';
import type {
  ImportPlanRow,
  ProcessYamlLayerRevisions
} from '../../../src/services/process-yaml/types';
import { validatePhaseDocument } from '../../../src/services/process-yaml/phase-yaml-validator';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BUILT_IN_PHASES, BUILT_IN_PIPELINES } from '../../../src/config/pipeline-config';
import { resolvePhaseCatalog } from '../../../src/config/process-catalog';
import { resolvePipelineCatalog } from '../../../src/config/pipeline-catalog';

const REVISIONS: ProcessYamlLayerRevisions = Object.freeze({
  user: 'user-rev-1',
  workspace: 'workspace-rev-1'
});

/**
 * Deliberately different values from {@link REVISIONS}: the two catalogs are
 * independently mutable, so a plan that reported one layer's revision for the
 * other would gate the wrong write and pass a shared-fixture test (FR-043).
 */
const PIPELINE_REVISIONS: ProcessYamlLayerRevisions = Object.freeze({
  user: 'pipeline-user-rev-1',
  workspace: 'pipeline-workspace-rev-1'
});

function storedRow(
  phaseId: string,
  scope: PhaseDefinitionScope,
  status: PhaseSourceStatus
): PhaseSourceRecord {
  return Object.freeze({
    key: `${scope}::${phaseId}::0`,
    phaseId,
    scope,
    status,
    // Deliberately null even for a `shadowed` row: presence must not depend on
    // a resolved definition being present (FR-030).
    definition: null,
    display: Object.freeze({}),
    errors: Object.freeze([])
  });
}

/** Parse + validate, so the tests exercise the same result the host will pass. */
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

describe('planPhaseImport', () => {
  it('plans a new id as import and names it (QS-14)', () => {
    const result = planPhaseImport(validate(VALID_DOCUMENT), [], REVISIONS);

    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.plan.rows).toEqual([
      {
        outcome: 'import',
        resourceKind: 'phase',
        resourceId: 'ship-it',
        name: 'Ship It',
        requiresRetryConditionCapability: false,
        // FR-046a — the row carries what the commit will write, verbatim. The
        // assertion is exhaustive (`toEqual`, not `toMatchObject`) so a field
        // the mapper starts dropping or inventing fails here rather than
        // surfacing later as a lossy round trip.
        definition: {
          phaseId: 'ship-it',
          name: 'Ship It',
          version: 1,
          instruction: 'Ship the thing.'
        }
      }
    ]);
    expect(result.plan.computedAgainstRevision).toEqual(REVISIONS);
    // A Phase document writes one layer, so there is no second revision to have
    // been computed against, and the plan claims none (FR-043).
    expect(result.plan.computedAgainstPipelineRevision).toBeUndefined();
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

    const result = planPhaseImport(validate(withRetry), [], REVISIONS);

    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.plan.rows[0]).toMatchObject({
      outcome: 'import',
      requiresRetryConditionCapability: true
    });
  });

  it('plans an id claimed by any stored row as skip, whatever that row status is', () => {
    for (const status of ['effective', 'shadowed', 'invalid'] as const) {
      const rows = [storedRow('ship-it', 'user', status)];

      const result = planPhaseImport(validate(VALID_DOCUMENT), rows, REVISIONS);

      expect(result.outcome).toBe('planned');
      if (result.outcome !== 'planned') return;
      expect(result.plan.rows).toEqual([
        {
          outcome: 'skip',
          resourceKind: 'phase',
          resourceId: 'ship-it',
          name: 'Ship It',
          presentIn: 'user',
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

    const result = planPhaseImport(validate(badVersion), [], REVISIONS);

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

    const result = planPhaseImport(validate(threeBad), [], REVISIONS);

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
    // The count the boundary will bound the list against (T031).
    expect(row.totalDefects).toBe(3);
  });

  it('does not claim an id for an invalid resource whose metadata never validated', () => {
    const noMetadata = document(['spec:', '  instruction: Ship the thing.', ''].join('\n'));

    const result = planPhaseImport(validate(noMetadata), [], REVISIONS);

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
      { source: VALID_DOCUMENT, rows: [storedRow('ship-it', 'workspace', 'effective')] },
      {
        source: document(
          ['metadata:', '  phaseId: ship-it', '  name: Ship It', '  version: soon', 'spec:', '  instruction: x', ''].join(
            '\n'
          )
        ),
        rows: [] as readonly PhaseSourceRecord[]
      }
    ];

    for (const testCase of cases) {
      const result = planPhaseImport(validate(testCase.source), testCase.rows, REVISIONS);
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

    const result = planPhaseImport(validate(wrongKind), [], REVISIONS);

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.refusal.code).toBe('unsupported-kind');
    expect(Object.keys(result)).toEqual(['outcome', 'refusal']);
  });
});

describe('findPhaseIdPresence', () => {
  it('is null when no stored row in any layer claims the id', () => {
    const rows = [storedRow('other', 'user', 'effective'), storedRow('third', 'workspace', 'invalid')];

    expect(findPhaseIdPresence(rows, 'ship-it')).toBeNull();
  });

  it('finds a claim in any layer, including a built-in row', () => {
    const rows = [storedRow('specify', 'built-in', 'shadowed')];

    expect(findPhaseIdPresence(rows, 'specify')).toEqual({
      scope: 'built-in',
      status: 'shadowed'
    });
  });

  it('reports the earliest claimant in the layer order the presence oracle is written in', () => {
    // built-in `specify` overridden by a user row: both claim the id. The oracle
    // is a union over stored rows, so it names the first claimant in that union
    // order — built-in, user, workspace — rather than resolving precedence.
    const rows = [
      storedRow('specify', 'user', 'effective'),
      storedRow('specify', 'built-in', 'shadowed')
    ];

    expect(findPhaseIdPresence(rows, 'specify')).toEqual({
      scope: 'built-in',
      status: 'shadowed'
    });
  });

  it('matches an id exactly, not as a prefix of a longer one', () => {
    const rows = [storedRow('ship-it-again', 'user', 'effective')];

    expect(findPhaseIdPresence(rows, 'ship-it')).toBeNull();
    expect(findPhaseIdPresence(rows, 'ship-it-again')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Feature 085 T029 — planning a package (US3)
// ---------------------------------------------------------------------------
//
// A package declares more than one resource, so the planner's job grows a
// property the single-Phase path never had to state: the document is read whole.
// Every resource it declares is classified before any row is reported (FR-023),
// exactly one row per declared resource (FR-024), each row's outcome from the
// closed set (FR-025) and carrying a reason when it is not `import` (FR-026),
// with counts that sum to the row count (FR-028). A document-level refusal
// produces no plan at all — not an empty one, and not the rows read so far
// (FR-029).
//
// These tests deliberately do NOT pin the ROOT Pipeline's outcome in the mixed
// fixture. Dependency resolution arrives in US4 (T041), and the root's outcome
// is exactly what it changes: a well-formed Pipeline whose references do not
// resolve becomes `blocked`, never `invalid` (FR-033). Pinning it here would
// make a correct US4 change look like a regression. The properties asserted
// below hold either way.

function storedPipelineRow(
  pipelineId: string,
  scope: PipelineDefinitionScope,
  status: PipelineSourceStatus
): PipelineSourceRecord {
  return Object.freeze({
    key: `${scope}::${pipelineId}::0`,
    pipelineId,
    scope,
    status,
    definition: null,
    display: Object.freeze({}),
    errors: Object.freeze([])
  });
}

const SPECIFY: PhaseDefinition = Object.freeze({
  phaseId: 'specify',
  name: 'Specify',
  version: 2,
  instruction: 'Write the spec.'
});

/** Read a package the way preflight will: parse the tree, then classify it. */
function parsePackage(text: string) {
  const parsed = parseDocumentText(text);
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.refusal.code}`);
  return parsePipelinePackage(parsed.node);
}

/**
 * The oracles the planner consults, kept apart on purpose: presence is scanned
 * against STORED ROWS at every status, and dependency resolution reads the
 * EFFECTIVE catalog (FR-030 vs FR-030a). Two fields, never one substituted for
 * the other.
 */
function context(overrides: Partial<PackageImportContext> = {}): PackageImportContext {
  return {
    phaseRows: [],
    pipelineRows: [],
    effectivePhases: [],
    revisions: REVISIONS,
    pipelineRevisions: PIPELINE_REVISIONS,
    ...overrides
  };
}

/** One `included.phases` entry at the indent the emitter writes it. */
function includedPhase(metadata: readonly string[], spec: readonly string[]): readonly string[] {
  return [
    '    - metadata:',
    ...metadata.map((line) => `        ${line}`),
    '      spec:',
    ...spec.map((line) => `        ${line}`)
  ];
}

function packageDocument(
  spec: readonly string[],
  phases: readonly (readonly string[])[] = []
): string {
  return [
    'apiVersion: schegent/v1',
    'kind: Pipeline',
    'metadata:',
    '  id: ship-it',
    '  name: Ship It',
    '  version: 1',
    'spec:',
    ...spec.map((line) => `  ${line}`),
    ...(phases.length > 0 ? ['included:', '  phases:', ...phases.flat()] : []),
    ''
  ].join('\n');
}

/** Three resources, all well formed and none of them already claimed. */
const SELF_CONTAINED = packageDocument(
  ['phaseIds:', '  - specify', '  - plan'],
  [
    includedPhase(
      ['phaseId: specify', 'name: Specify', 'version: 2'],
      ['instruction: Write the spec.']
    ),
    includedPhase(['phaseId: plan', 'name: Plan', 'version: 5'], ['skill: speckit-plan'])
  ]
);

/**
 * Three resources with three different fates: `specify` is already claimed,
 * `plan` is malformed, and the root is whatever the resolution rules of the
 * moment make it.
 */
const MIXED = packageDocument(
  ['phaseIds:', '  - specify', '  - plan'],
  [
    includedPhase(
      ['phaseId: specify', 'name: Specify', 'version: 2'],
      ['instruction: Write the spec.']
    ),
    includedPhase(['phaseId: plan', 'name: Plan', 'version: 0'], ['skill: speckit-plan'])
  ]
);

const MIXED_CONTEXT = context({
  phaseRows: [storedRow('specify', 'user', 'effective')],
  effectivePhases: [SPECIFY]
});

function plannedRows(text: string, ctx: PackageImportContext): readonly ImportPlanRow[] {
  const result = planPipelineImport(parsePackage(text), ctx);
  if (result.outcome !== 'planned') throw new Error(`expected a plan, got ${result.outcome}`);
  return result.plan.rows;
}

describe('planPipelineImport', () => {
  it('reports exactly one row per declared resource, root first then included in order (FR-024)', () => {
    const rows = plannedRows(SELF_CONTAINED, context());

    expect(rows.map((row) => [row.resourceKind, row.resourceId])).toEqual([
      ['pipeline', 'ship-it'],
      ['phase', 'specify'],
      ['phase', 'plan']
    ]);
  });

  it('plans every resource of a self-contained package as import when nothing claims its id', () => {
    // Stable across US4: the root's `specify` and `plan` references resolve
    // because this same document supplies them and their rows are `import`
    // (FR-035), so adding the resolver does not turn this into `blocked`.
    const rows = plannedRows(SELF_CONTAINED, context());

    expect(rows.map((row) => row.outcome)).toEqual(['import', 'import', 'import']);
    for (const row of rows) {
      expect(row.outcome).toBe('import');
      if (row.outcome !== 'import') continue;
      if (row.resourceKind === 'modelCatalog') continue;
      expect(row.definition).toBeDefined();
    }
  });

  it('carries both layers\' revisions, each from its own catalog (FR-043)', () => {
    const result = planPipelineImport(parsePackage(SELF_CONTAINED), context());
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    // A confirmed package is two ordered writes against two independently
    // mutable layers. One revision cannot gate both, and reading the Pipeline
    // layer's at confirm time would leave FR-040 unable to fire for it.
    expect(result.plan.computedAgainstRevision).toEqual(REVISIONS);
    expect(result.plan.computedAgainstPipelineRevision).toEqual(PIPELINE_REVISIONS);
  });

  it('gives every row an outcome from the closed set (FR-025)', () => {
    for (const rows of [plannedRows(SELF_CONTAINED, context()), plannedRows(MIXED, MIXED_CONTEXT)]) {
      for (const row of rows) {
        expect(['import', 'skip', 'blocked', 'invalid']).toContain(row.outcome);
      }
    }
  });

  it('gives every non-import row a reason for not importing (FR-026)', () => {
    // An operator who is told "not imported" and nothing else has to guess
    // between "you already have it", "it is broken", and "something it needs is
    // missing" — three different next actions.
    const rows = plannedRows(MIXED, MIXED_CONTEXT);
    const nonImport = rows.filter((row) => row.outcome !== 'import');
    expect(nonImport.length).toBeGreaterThan(0);

    for (const row of nonImport) {
      if (row.outcome === 'skip' && row.resourceKind !== 'modelCatalog') {
        expect(row.presentIn).toBeTruthy();
        expect(row.presentRowStatus).toBeTruthy();
      } else if (row.outcome === 'blocked') {
        expect(row.reason.code).toMatch(/^dependency-(absent|unresolvable)$/);
        expect(row.reason.dependency.resourceId.length).toBeGreaterThan(0);
      } else if (row.outcome === 'invalid') {
        expect(row.defects.length).toBeGreaterThan(0);
        expect(row.totalDefects).toBeGreaterThanOrEqual(row.defects.length);
      }
    }
  });

  it('skips an id a stored row already claims, and invalidates a malformed resource', () => {
    const rows = plannedRows(MIXED, MIXED_CONTEXT);

    expect(rows[1]).toEqual({
      outcome: 'skip',
      resourceKind: 'phase',
      resourceId: 'specify',
      name: 'Specify',
      presentIn: 'user',
      presentRowStatus: 'effective'
    });
    expect(rows[2]?.outcome).toBe('invalid');
    const malformed = rows[2];
    if (malformed?.outcome !== 'invalid') return;
    expect(malformed.resourceId).toBe('plan');
    expect(malformed.defects.map((defect) => defect.field)).toContain('version');
  });

  it('skips a root Pipeline whose id a stored Pipeline row already claims, at any status', () => {
    for (const status of ['effective', 'shadowed', 'invalid'] as const) {
      const rows = plannedRows(
        SELF_CONTAINED,
        context({ pipelineRows: [storedPipelineRow('ship-it', 'workspace', status)] })
      );

      expect(rows[0]).toEqual({
        outcome: 'skip',
        resourceKind: 'pipeline',
        resourceId: 'ship-it',
        name: 'Ship It',
        presentIn: 'workspace',
        presentRowStatus: status
      });
    }
  });

  it('produces the coherent skip/blocked pair for one id, and it is correct (FR-030b)', () => {
    // T037 — the pair that reads like a contradiction and is not. `specify` is
    // claimed by a stored row, so writing it would destroy work the operator
    // authored: the Phase row is `skip`. That same row is shadowed, so it is not
    // what runtime resolves: the Pipeline that references it is `blocked` naming
    // the same id. Two oracles, two questions, two correct answers (research R6).
    //
    // The context states them disagreeing on purpose — a stored row with no
    // effective definition — so a planner that resolved dependencies against
    // presence would report `import` on the root and fail at run time.
    const rows = plannedRows(
      SELF_CONTAINED,
      context({ phaseRows: [storedRow('specify', 'user', 'shadowed')], effectivePhases: [] })
    );

    expect(rows[0]).toEqual({
      outcome: 'blocked',
      resourceKind: 'pipeline',
      resourceId: 'ship-it',
      name: 'Ship It',
      reason: { code: 'dependency-unresolvable', dependency: { kind: 'phase', resourceId: 'specify' } }
    });
    expect(rows[1]).toEqual({
      outcome: 'skip',
      resourceKind: 'phase',
      resourceId: 'specify',
      name: 'Specify',
      presentIn: 'user',
      presentRowStatus: 'shadowed'
    });
    // FR-039, decided here rather than at the write: the blocked root does not
    // take the independently eligible Phase with it.
    expect(rows[2]?.outcome).toBe('import');
  });

  it('produces counts that sum to the row count, one bucket per outcome (FR-028)', () => {
    for (const testCase of [
      { text: SELF_CONTAINED, ctx: context() },
      { text: MIXED, ctx: MIXED_CONTEXT },
      {
        text: SELF_CONTAINED,
        ctx: context({ pipelineRows: [storedPipelineRow('ship-it', 'user', 'invalid')] })
      }
    ]) {
      const result = planPipelineImport(parsePackage(testCase.text), testCase.ctx);
      expect(result.outcome).toBe('planned');
      if (result.outcome !== 'planned') return;
      const { counts, rows } = result.plan;

      expect(counts.import + counts.skip + counts.blocked + counts.invalid).toBe(rows.length);
      for (const outcome of ['import', 'skip', 'blocked', 'invalid'] as const) {
        expect(counts[outcome]).toBe(rows.filter((row) => row.outcome === outcome).length);
      }
    }
  });

  it('reports the plan as one finished value, so no row precedes the last classification (FR-023)', () => {
    // There is no streaming seam to test: the planner returns the plan whole,
    // and the counts that accompany row 0 already describe the resource declared
    // last. A reader that emitted rows as it went would be observable here as a
    // count that disagreed with the rows beside it.
    const result = planPipelineImport(parsePackage(MIXED), MIXED_CONTEXT);
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    expect(Object.keys(result)).toEqual(['outcome', 'plan']);
    expect(result.plan.rows).toHaveLength(3);
    expect(result.plan.counts.invalid).toBe(1);
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(Object.isFrozen(result.plan.rows)).toBe(true);
  });

  it('returns a refusal with NO plan and no partial rows for a document-level refusal (FR-029)', () => {
    // The second included Phase is malformed, so a reader that classified as it
    // went would already hold two rows when it reached the bad envelope.
    for (const text of [
      'apiVersion: schegent/v2\nkind: Pipeline\nmetadata:\n  id: ship-it\n',
      'apiVersion: schegent/v1\nkind: Workflow\nmetadata:\n  id: ship-it\n',
      'metadata:\n  id: ship-it\n'
    ]) {
      const result = planPipelineImport(parsePackage(text), context());

      expect(result.outcome).toBe('refused');
      if (result.outcome !== 'refused') continue;
      expect(Object.keys(result)).toEqual(['outcome', 'refusal']);
      expect(result.refusal.code.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Feature 085 T050 — the presence oracle for BOTH kinds (US6, FR-030)
// ---------------------------------------------------------------------------
//
// The skip guarantee is the one property an import must never get wrong: it is
// what stands between an operator's half-repaired row and a document that
// declares the same id. This module is its single enforcement site, so these
// tests walk the whole matrix rather than sampling it — every layer in
// `PRESENCE_SCAN_ORDER` crossed with every status, for each kind — and pin that
// the two catalogs are scanned independently.

const PRESENCE_SCOPES = ['built-in', 'user', 'workspace'] as const;
const PRESENCE_STATUSES = ['effective', 'shadowed', 'invalid'] as const;

describe('Feature 085 T050 — presence covers every layer at every status (FR-030)', () => {
  it('claims a Phase id from any layer in any state', () => {
    for (const scope of PRESENCE_SCOPES) {
      for (const status of PRESENCE_STATUSES) {
        // `shadowed` and `invalid` are the load-bearing cells. A row in either
        // state has no resolved definition, so an oracle that read the effective
        // catalog would report "absent" and let the import overwrite work the
        // operator is part-way through.
        expect(findPhaseIdPresence([storedRow('specify', scope, status)], 'specify')).toEqual({
          scope,
          status
        });
      }
    }
  });

  it('claims a Pipeline id from any layer in any state', () => {
    for (const scope of PRESENCE_SCOPES) {
      for (const status of PRESENCE_STATUSES) {
        expect(
          findPipelineIdPresence([storedPipelineRow('ship-it', scope, status)], 'ship-it')
        ).toEqual({ scope, status });
      }
    }
  });

  it('plans a skip for a Phase claimed only by a shadowed or invalid row', () => {
    // The end-to-end statement of the same rule: the oracle answering "present"
    // has to reach the row's outcome, not stop at the helper.
    for (const status of ['shadowed', 'invalid'] as const) {
      const rows = plannedRows(
        SELF_CONTAINED,
        context({ phaseRows: [storedRow('specify', 'workspace', status)] })
      );
      const phase = rows.find((row) => row.resourceKind === 'phase' && row.resourceId === 'specify');
      expect(phase?.outcome).toBe('skip');
      if (phase?.outcome !== 'skip') continue;
      if (phase.resourceKind === 'modelCatalog') continue;
      expect(phase.presentIn).toBe('workspace');
      expect(phase.presentRowStatus).toBe(status);
    }
  });

  it('plans a skip for a Pipeline claimed only by an invalid row', () => {
    const rows = plannedRows(
      SELF_CONTAINED,
      context({ pipelineRows: [storedPipelineRow('ship-it', 'workspace', 'invalid')] })
    );
    expect(rows[0]).toEqual({
      outcome: 'skip',
      resourceKind: 'pipeline',
      resourceId: 'ship-it',
      name: 'Ship It',
      presentIn: 'workspace',
      presentRowStatus: 'invalid'
    });
  });

  it('compares an id inside its own kind\'s catalog and no other', () => {
    // The two catalogs are separate stores. A Pipeline named `specify` does not
    // claim the Phase id `specify`, and a shared scan would make one kind's
    // catalog silently gate the other's import.
    expect(findPhaseIdPresence([], 'specify')).toBeNull();
    expect(findPipelineIdPresence([], 'ship-it')).toBeNull();

    const crossed = context({
      phaseRows: [storedRow('ship-it', 'user', 'effective')],
      pipelineRows: [storedPipelineRow('specify', 'user', 'effective')]
    });
    const rows = plannedRows(SELF_CONTAINED, crossed);

    // Root Pipeline `ship-it` vs a Phase row `ship-it`; Phase `specify` vs a
    // Pipeline row `specify`. Neither is a claim, so nothing is skipped.
    expect(rows.map((row) => row.outcome)).toEqual(['import', 'import', 'import']);
  });

  it('reports the earliest Pipeline claimant in the scan order, not by precedence', () => {
    // Same rule the Phase oracle already states: presence is a gate, and the
    // reported row is evidence for the skip rather than a routing decision.
    const rows = [
      storedPipelineRow('ship-it', 'workspace', 'effective'),
      storedPipelineRow('ship-it', 'built-in', 'shadowed')
    ];
    expect(findPipelineIdPresence(rows, 'ship-it')).toEqual({
      scope: 'built-in',
      status: 'shadowed'
    });
  });

  it('matches a Pipeline id exactly, not as a prefix of a longer one', () => {
    const rows = [storedPipelineRow('ship-it-again', 'user', 'effective')];
    expect(findPipelineIdPresence(rows, 'ship-it')).toBeNull();
    expect(findPipelineIdPresence(rows, 'ship-it-again')).not.toBeNull();
  });

  it('names the layer and the state the claim was found in, on every skip (FR-026)', () => {
    // "Already present" alone leaves the operator unable to act: which layer
    // holds it, and is that row healthy or the broken one they are fixing?
    const rows = plannedRows(
      SELF_CONTAINED,
      context({
        phaseRows: [storedRow('specify', 'built-in', 'effective')],
        pipelineRows: [storedPipelineRow('ship-it', 'user', 'shadowed')]
      })
    );
    const skips = rows.filter((row) => row.outcome === 'skip');
    expect(skips).toHaveLength(2);
    for (const row of skips) {
      if (row.outcome !== 'skip') continue;
      if (row.resourceKind === 'modelCatalog') continue;
      expect(PRESENCE_SCOPES).toContain(row.presentIn);
      expect(PRESENCE_STATUSES).toContain(row.presentRowStatus);
    }
  });
});

// ---------------------------------------------------------------------------
// Feature 086 T032 — planning a Workflow package (US4)
// ---------------------------------------------------------------------------
//
// One level up from 085, and the properties are the same ones: the document is
// read whole, every resource it declares is classified before any row is
// reported (FR-023), exactly one row per declared resource (FR-025, SC-009),
// each outcome from the closed set with a reason whenever it is not `import`
// (FR-026), counts that sum to the row count (FR-028), and nothing written
// whatever the outcomes (SC-008).
//
// A third catalog joins the two, and it is a third PRESENCE oracle rather than a
// generalization of either: the Workflow rows are a separate store with their own
// revisions, so a scan that took "rows and an id accessor" would make it possible
// to ask the Pipeline catalog about a Workflow id.
//
// As in 085's section, these tests deliberately do NOT pin the ROOT's outcome in
// a fixture whose dependencies fail. Resolution and propagation arrive in US5
// (T043-T045) and the root's outcome is exactly what they change — a Workflow
// whose node names an unresolvable Pipeline becomes `blocked`, never `invalid`
// (FR-037, FR-041). Pinning it here would make a correct US5 change look like a
// regression. The self-contained fixture is stable across that change on purpose:
// its node's Pipeline is supplied by the same document as an `import` row, which
// is what FR-035 says resolves a reference.

function storedWorkflowRow(
  workflowId: string,
  scope: WorkflowDefinitionScope,
  status: WorkflowSourceStatus
): WorkflowSourceRecord {
  return Object.freeze({
    key: `${scope}::${workflowId}::0`,
    workflowId,
    scope,
    status,
    // Null even for a `shadowed` row, like the other two builders: presence must
    // not depend on a resolved definition being present (FR-030).
    definition: null,
    display: Object.freeze({}),
    nodePipelineIds: Object.freeze([]),
    errors: Object.freeze([])
  });
}

/**
 * Deliberately different again from the other two revision fixtures. Three
 * independently mutable layers cannot share one gate, and a plan that reported
 * one layer's revision for another would gate the wrong write and still pass a
 * shared-fixture test (FR-036, data-model §3.4).
 */
const WORKFLOW_REVISIONS: ProcessYamlLayerRevisions = Object.freeze({
  user: 'workflow-user-rev-1',
  workspace: 'workflow-workspace-rev-1'
});

function workflowContext(
  overrides: Partial<WorkflowPackageImportContext> = {}
): WorkflowPackageImportContext {
  return {
    phaseRows: [],
    pipelineRows: [],
    workflowRows: [],
    effectivePhases: [],
    effectivePipelines: [],
    invalidPipelines: new Map(),
    revisions: REVISIONS,
    pipelineRevisions: PIPELINE_REVISIONS,
    workflowRevisions: WORKFLOW_REVISIONS,
    ...overrides
  };
}

/** Read a Workflow package the way preflight will: parse the tree, then classify. */
function parseWorkflowFixture(text: string) {
  const parsed = parseDocumentText(text);
  if (!parsed.ok) throw new Error(`fixture did not parse: ${parsed.refusal.code}`);
  return parseWorkflowPackage(parsed.node);
}

/** One `included.*` entry at the indent the emitter writes it, for either kind. */
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
  readonly pipelines?: readonly (readonly string[])[];
  readonly phases?: readonly (readonly string[])[];
  /** Overridden only where the root's own id or version is the subject (T058, T059). */
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
    ...(body.spec ?? ['nodes:', '  - nodeId: draft', '    pipelineId: spec-authoring', 'startNodeIds:', '  - draft']).map(
      (line) => `  ${line}`
    )
  ];
  // A section is written only when supplied: an empty one is a different
  // document, and `included` is omitted entirely in references-only mode.
  if (body.pipelines !== undefined || body.phases !== undefined) {
    lines.push('included:');
    if (body.pipelines !== undefined) lines.push('  pipelines:', ...body.pipelines.flat());
    if (body.phases !== undefined) lines.push('  phases:', ...body.phases.flat());
  }
  return `${lines.join('\n')}\n`;
}

const INCLUDED_SPEC_AUTHORING = includedResource(
  ['id: spec-authoring', 'name: Spec Authoring', 'version: 2'],
  ['phaseIds:', '  - specify']
);

const INCLUDED_SPECIFY = includedResource(
  ['phaseId: specify', 'name: Specify', 'version: 2'],
  ['instruction: Write the spec.']
);

/** Three resources across three catalogs, none of them already claimed. */
const SELF_CONTAINED_WORKFLOW = workflowDocument({
  pipelines: [INCLUDED_SPEC_AUTHORING],
  phases: [INCLUDED_SPECIFY]
});

/** A Workflow whose node names a Pipeline the catalog is expected to supply. */
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
  it('reports one row per declared resource, root first then each section in order (FR-025)', () => {
    const rows = plannedWorkflowRows(SELF_CONTAINED_WORKFLOW, workflowContext());

    // The reader's order, not the planner's: the root, then `included.pipelines`,
    // then `included.phases` — which is `WORKFLOW_INCLUDED_KEY_ORDER`, so what the
    // operator reads matches the order the document declared (FR-016).
    expect(rows.map((row) => [row.resourceKind, row.resourceId])).toEqual([
      ['workflow', 'ship-it-flow'],
      ['pipeline', 'spec-authoring'],
      ['phase', 'specify']
    ]);
  });

  it('plans every resource of a self-contained package as import when nothing claims its id', () => {
    const rows = plannedWorkflowRows(SELF_CONTAINED_WORKFLOW, workflowContext());

    expect(rows.map((row) => row.outcome)).toEqual(['import', 'import', 'import']);
    for (const row of rows) {
      if (row.outcome !== 'import') continue;
      if (row.resourceKind === 'modelCatalog') continue;
      // The row carries what the write will store; nothing else can, because the
      // host retains nothing past the read that produced the plan (FR-031).
      expect(row.definition).toBeDefined();
    }
  });

  it('carries the root Workflow definition verbatim, including its authored order', () => {
    const rows = plannedWorkflowRows(SELF_CONTAINED_WORKFLOW, workflowContext());
    const [root] = rows;
    expect(root?.outcome).toBe('import');
    if (root?.outcome !== 'import' || root.resourceKind !== 'workflow') return;

    // `toEqual`, not `toMatchObject`: a field the reader starts dropping or
    // inventing fails here rather than surfacing later as a lossy round trip.
    expect(root.definition).toEqual({
      workflowId: 'ship-it-flow',
      name: 'Ship It Flow',
      version: 1,
      nodes: [{ nodeId: 'draft', pipelineId: 'spec-authoring' }],
      connections: [],
      startNodeIds: ['draft']
    });
  });

  it('gives every row an outcome from the closed set, whatever the catalog holds', () => {
    const claimed = workflowContext({
      workflowRows: [storedWorkflowRow('ship-it-flow', 'user', 'effective')],
      pipelineRows: [storedPipelineRow('spec-authoring', 'workspace', 'shadowed')],
      phaseRows: [storedRow('specify', 'built-in', 'invalid')]
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

  it('gives every non-import row a reason for not importing (FR-026)', () => {
    // Told only "not imported", an operator has to guess between "you already
    // have it", "it is broken", and "something it needs is missing" — three
    // different next actions.
    const invalidVersion = workflowDocument({
      pipelines: [INCLUDED_SPEC_AUTHORING],
      phases: [
        includedResource(
          ['phaseId: specify', 'name: Specify', 'version: 0'],
          ['instruction: Write the spec.']
        )
      ]
    });
    const rows = [
      ...plannedWorkflowRows(
        SELF_CONTAINED_WORKFLOW,
        workflowContext({ workflowRows: [storedWorkflowRow('ship-it-flow', 'user', 'shadowed')] })
      ),
      ...plannedWorkflowRows(invalidVersion, workflowContext())
    ];
    const nonImport = rows.filter((row) => row.outcome !== 'import');
    expect(nonImport.length).toBeGreaterThan(0);

    for (const row of nonImport) {
      if (row.outcome === 'skip' && row.resourceKind !== 'modelCatalog') {
        expect(PRESENCE_SCOPES).toContain(row.presentIn);
        expect(PRESENCE_STATUSES).toContain(row.presentRowStatus);
      } else if (row.outcome === 'blocked') {
        expect(row.reason.dependency.resourceId.length).toBeGreaterThan(0);
      } else if (row.outcome === 'invalid') {
        expect(row.defects.length).toBeGreaterThan(0);
        expect(row.totalDefects).toBeGreaterThanOrEqual(row.defects.length);
      }
    }
  });

  it('skips a Workflow whose id a stored row already claims, in any layer at any status', () => {
    // The third catalog's half of the FR-024/FR-030 skip guarantee. `shadowed`
    // and `invalid` are the load-bearing cells: neither has a resolved
    // definition, so an oracle reading the effective catalog would report the id
    // absent and overwrite a row the operator may be part-way through fixing.
    for (const scope of PRESENCE_SCOPES) {
      for (const status of PRESENCE_STATUSES) {
        const rows = plannedWorkflowRows(
          SELF_CONTAINED_WORKFLOW,
          workflowContext({ workflowRows: [storedWorkflowRow('ship-it-flow', scope, status)] })
        );

        expect(rows[0]).toEqual({
          outcome: 'skip',
          resourceKind: 'workflow',
          resourceId: 'ship-it-flow',
          name: 'Ship It Flow',
          presentIn: scope,
          presentRowStatus: status
        });
        // FR-025b — a skipped root takes nothing with it; the resources it
        // shipped are still planned on their own merits.
        expect(rows.slice(1).map((row) => row.outcome)).toEqual(['import', 'import']);
      }
    }
  });

  it('asks each catalog about its own kind of id and no other', () => {
    // Three separate stores. A Pipeline named `ship-it-flow` does not claim the
    // Workflow id, and a shared scan would let one catalog gate another's import.
    const crossed = workflowContext({
      pipelineRows: [storedPipelineRow('ship-it-flow', 'user', 'effective')],
      phaseRows: [storedRow('spec-authoring', 'user', 'effective')],
      workflowRows: [storedWorkflowRow('specify', 'user', 'effective')]
    });

    expect(findWorkflowIdPresence([], 'ship-it-flow')).toBeNull();
    expect(plannedWorkflowRows(SELF_CONTAINED_WORKFLOW, crossed).map((row) => row.outcome)).toEqual([
      'import',
      'import',
      'import'
    ]);
  });

  it('reports the earliest Workflow claimant in the scan order, not by precedence', () => {
    const rows = [
      storedWorkflowRow('ship-it-flow', 'workspace', 'effective'),
      storedWorkflowRow('ship-it-flow', 'built-in', 'shadowed')
    ];

    expect(findWorkflowIdPresence(rows, 'ship-it-flow')).toEqual({
      scope: 'built-in',
      status: 'shadowed'
    });
  });

  it('matches a Workflow id exactly, not as a prefix of a longer one', () => {
    const rows = [storedWorkflowRow('ship-it-flow-again', 'user', 'effective')];

    expect(findWorkflowIdPresence(rows, 'ship-it-flow')).toBeNull();
    expect(findWorkflowIdPresence(rows, 'ship-it-flow-again')).not.toBeNull();
  });

  it('carries one revision per layer this plan can write, each from its own catalog (FR-036)', () => {
    const full = planWorkflowImport(
      parseWorkflowFixture(SELF_CONTAINED_WORKFLOW),
      workflowContext()
    );
    expect(full.outcome).toBe('planned');
    if (full.outcome !== 'planned') return;

    expect(full.plan.computedAgainstRevision).toEqual(REVISIONS);
    expect(full.plan.computedAgainstPipelineRevision).toEqual(PIPELINE_REVISIONS);
    expect(full.plan.computedAgainstWorkflowRevision).toEqual(WORKFLOW_REVISIONS);
  });

  it('claims no revision for a layer a references-only document never writes (FR-043)', () => {
    // The webview reads each field's PRESENCE as "this plan can write that
    // layer". A references-only Workflow declares no Pipeline and no Phase, so
    // claiming their revisions would assert a fact about catalogs this plan is
    // not going to touch — and would offer a write with nothing in it.
    const result = planWorkflowImport(
      parseWorkflowFixture(REFERENCES_ONLY_WORKFLOW),
      workflowContext()
    );
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    expect(result.plan.computedAgainstWorkflowRevision).toEqual(WORKFLOW_REVISIONS);
    expect(result.plan.computedAgainstPipelineRevision).toBeUndefined();
  });

  it('produces counts that sum to the row count, one bucket per outcome (FR-028)', () => {
    for (const testCase of [
      { text: SELF_CONTAINED_WORKFLOW, ctx: workflowContext() },
      { text: REFERENCES_ONLY_WORKFLOW, ctx: workflowContext() },
      {
        text: SELF_CONTAINED_WORKFLOW,
        ctx: workflowContext({
          workflowRows: [storedWorkflowRow('ship-it-flow', 'user', 'invalid')],
          phaseRows: [storedRow('specify', 'workspace', 'shadowed')]
        })
      }
    ]) {
      const result = planWorkflowImport(parseWorkflowFixture(testCase.text), testCase.ctx);
      expect(result.outcome).toBe('planned');
      if (result.outcome !== 'planned') return;
      const { counts, rows } = result.plan;

      expect(counts.import + counts.skip + counts.blocked + counts.invalid).toBe(rows.length);
      for (const outcome of ['import', 'skip', 'blocked', 'invalid'] as const) {
        expect(counts[outcome]).toBe(rows.filter((row) => row.outcome === outcome).length);
      }
    }
  });

  it('reports the plan as one finished value, so no row precedes the last classification (FR-023)', () => {
    // There is no streaming seam to test: the plan is returned whole, and the
    // counts that accompany row 0 already describe the resource declared last. A
    // reader that emitted rows as it went would show up here as a count that
    // disagreed with the rows beside it.
    const invalidLastPhase = workflowDocument({
      pipelines: [INCLUDED_SPEC_AUTHORING],
      phases: [
        includedResource(
          ['phaseId: specify', 'name: Specify', 'version: soon'],
          ['instruction: Write the spec.']
        )
      ]
    });

    const result = planWorkflowImport(parseWorkflowFixture(invalidLastPhase), workflowContext());
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    expect(Object.keys(result)).toEqual(['outcome', 'plan']);
    expect(result.plan.rows).toHaveLength(3);
    expect(result.plan.counts.invalid).toBe(1);
    expect(Object.isFrozen(result.plan)).toBe(true);
    expect(Object.isFrozen(result.plan.rows)).toBe(true);
  });

  it('writes no catalog byte whatever the outcomes, because it has nothing to write with (SC-008)', () => {
    // The planner is pure: parse and validate happen before it, the write after
    // it. The observable statement at this level is that planning leaves every
    // oracle it was handed exactly as it found it — the command-level "nothing
    // was written" is asserted in `workflow-preflight.test.ts`.
    const ctx = workflowContext({
      workflowRows: [storedWorkflowRow('other-flow', 'user', 'effective')],
      pipelineRows: [storedPipelineRow('spec-authoring', 'user', 'shadowed')],
      phaseRows: [storedRow('specify', 'workspace', 'invalid')],
      effectivePhases: [SPECIFY]
    });
    const before = JSON.stringify(ctx);

    planWorkflowImport(parseWorkflowFixture(SELF_CONTAINED_WORKFLOW), ctx);

    expect(JSON.stringify(ctx)).toBe(before);
  });

  // -------------------------------------------------------------------------
  // Feature 086 T045 — pass 3 reaching the plan (FR-037 – FR-042).
  //
  // The resolver's own tests state the three passes against synthetic catalogs.
  // These state the two things only the planner can: that a real document's rows
  // carry the verdicts, and that pass 2's blocked ROW is what pass 3 reads — the
  // wiring, not the rule.
  // -------------------------------------------------------------------------

  const SPEC_AUTHORING: PipelineDefinition = Object.freeze({
    pipelineId: 'spec-authoring',
    name: 'Spec Authoring',
    version: 2,
    phaseIds: Object.freeze(['specify']),
    inputs: Object.freeze([]),
    outputs: Object.freeze([]),
    bindings: Object.freeze([]),
    recommendedNext: Object.freeze([])
  });

  it('blocks a references-only Workflow whose node the catalog does not supply (FR-037)', () => {
    // Well-formed, and `invalid` would be the wrong word for it: nothing about
    // this Workflow is wrong. Its ports cannot even be checked until the Pipeline
    // is present, which is why resolution runs first (FR-041).
    const rows = plannedWorkflowRows(REFERENCES_ONLY_WORKFLOW, workflowContext());

    expect(rows).toEqual([
      {
        outcome: 'blocked',
        resourceKind: 'workflow',
        resourceId: 'ship-it-flow',
        name: 'Ship It Flow',
        reason: {
          code: 'dependency-absent',
          dependency: { kind: 'pipeline', resourceId: 'spec-authoring' }
        }
      }
    ]);
  });

  it('imports a references-only Workflow whose node the effective catalog resolves', () => {
    // The other half of the pair above, and the reason the oracle has to be the
    // EFFECTIVE catalog rather than the stored rows: the same shadowed row that
    // makes an id present cannot make it resolvable.
    const rows = plannedWorkflowRows(
      REFERENCES_ONLY_WORKFLOW,
      workflowContext({
        effectivePipelines: [SPEC_AUTHORING],
        pipelineRows: [storedPipelineRow('spec-authoring', 'user', 'effective')]
      })
    );

    expect(rows.map((row) => row.outcome)).toEqual(['import']);
  });

  it('distinguishes a node id no layer claims from one a layer claims and cannot resolve', () => {
    const rows = plannedWorkflowRows(
      REFERENCES_ONLY_WORKFLOW,
      workflowContext({ pipelineRows: [storedPipelineRow('spec-authoring', 'workspace', 'shadowed')] })
    );

    expect(rows[0]).toMatchObject({
      outcome: 'blocked',
      reason: {
        code: 'dependency-unresolvable',
        dependency: { kind: 'pipeline', resourceId: 'spec-authoring' }
      }
    });
  });

  it('names the propagated chain when a node Pipeline is itself blocked (FR-039, FR-040, SC-012)', () => {
    // The end-to-end shape SC-012 describes, and the one only the planner can
    // state: a document supplying a Workflow and its Pipeline but NOT the Phase
    // that Pipeline needs. Pass 2 blocks the Pipeline on the Phase; pass 3 reads
    // that blocked row and blocks the Workflow on the Pipeline, carrying the Phase
    // as `via`. Reporting `dependency-absent` here would tell the operator to
    // supply a Pipeline the document already contains.
    const missingPhase = workflowDocument({ pipelines: [INCLUDED_SPEC_AUTHORING] });

    const rows = plannedWorkflowRows(missingPhase, workflowContext());

    expect(rows[0]).toEqual({
      outcome: 'blocked',
      resourceKind: 'workflow',
      resourceId: 'ship-it-flow',
      name: 'Ship It Flow',
      reason: {
        code: 'dependency-blocked',
        dependency: { kind: 'pipeline', resourceId: 'spec-authoring' },
        via: { kind: 'phase', resourceId: 'specify' }
      }
    });
    // And the intermediate still reports its own root cause, so the chain is
    // readable from either end.
    expect(rows[1]).toMatchObject({
      outcome: 'blocked',
      resourceKind: 'pipeline',
      resourceId: 'spec-authoring',
      reason: { code: 'dependency-absent', dependency: { kind: 'phase', resourceId: 'specify' } }
    });
  });

  it('carries the intermediate reason verbatim, so a repairable Phase is not reported as absent', () => {
    // `via` is pass 2's own dependency, not a re-derivation. A stored-but-
    // unresolvable Phase makes the Pipeline `dependency-unresolvable`; the
    // Workflow's `via` must still name that Phase, because "repair it" and
    // "supply it" are different operator actions.
    const missingPhase = workflowDocument({ pipelines: [INCLUDED_SPEC_AUTHORING] });

    const rows = plannedWorkflowRows(
      missingPhase,
      workflowContext({ phaseRows: [storedRow('specify', 'user', 'invalid')] })
    );

    expect(rows[0]).toMatchObject({
      outcome: 'blocked',
      reason: {
        code: 'dependency-blocked',
        dependency: { kind: 'pipeline', resourceId: 'spec-authoring' },
        via: { kind: 'phase', resourceId: 'specify' }
      }
    });
    expect(rows[1]).toMatchObject({
      outcome: 'blocked',
      reason: { code: 'dependency-unresolvable' }
    });
  });

  it('lets a blocked Workflow leave every independently eligible row importing (FR-025b)', () => {
    // FR-025b needs no code and that is the claim: a row is one resource's
    // verdict, so a blocked root cannot demote anything. The Phase here is
    // eligible on its own merits even though nothing in the document can use it —
    // the Pipeline that would is not in this document at all.
    const unrelatedPhase = workflowDocument({ phases: [INCLUDED_SPECIFY] });

    const rows = plannedWorkflowRows(unrelatedPhase, workflowContext());

    expect(rows.map((row) => [row.resourceKind, row.outcome])).toEqual([
      ['workflow', 'blocked'],
      ['phase', 'import']
    ]);
  });

  it('resolves a self-contained package against the Pipeline it supplies (FR-035, FR-035a)', () => {
    // Nothing is effective here — the only thing that can satisfy the node is a
    // planned row. Without the FR-035a union a self-contained package would be
    // reported broken on the very Pipeline it ships.
    const rows = plannedWorkflowRows(SELF_CONTAINED_WORKFLOW, workflowContext());

    expect(rows.map((row) => row.outcome)).toEqual(['import', 'import', 'import']);
  });

  it('plans a Workflow whose node names a Pipeline the document declares but skips', () => {
    // FR-036 at the top level: what resolves a node is presence in the catalog,
    // not being written by this import. The Pipeline row is `skip` and the
    // Workflow still imports.
    const rows = plannedWorkflowRows(
      SELF_CONTAINED_WORKFLOW,
      workflowContext({
        pipelineRows: [storedPipelineRow('spec-authoring', 'user', 'effective')],
        effectivePipelines: [SPEC_AUTHORING]
      })
    );

    expect(rows.map((row) => [row.resourceKind, row.outcome])).toEqual([
      ['workflow', 'import'],
      ['pipeline', 'skip'],
      ['phase', 'import']
    ]);
  });

  it('blocks a Workflow on a skipped Pipeline whose claiming row does not resolve', () => {
    // The FR-030b pair one level up, and it reads like a contradiction without
    // being one: the Pipeline row is `skip` because the id is claimed, and the
    // Workflow is `blocked` naming that same id because the claim does not resolve.
    const rows = plannedWorkflowRows(
      SELF_CONTAINED_WORKFLOW,
      workflowContext({
        pipelineRows: [storedPipelineRow('spec-authoring', 'workspace', 'shadowed')]
      })
    );

    expect(rows.map((row) => [row.resourceKind, row.outcome])).toEqual([
      ['workflow', 'blocked'],
      ['pipeline', 'skip'],
      ['phase', 'import']
    ]);
    expect(rows[0]).toMatchObject({
      reason: {
        code: 'dependency-unresolvable',
        dependency: { kind: 'pipeline', resourceId: 'spec-authoring' }
      }
    });
  });

  it('names the first failing node in authored reference order', () => {
    const twoNodes = workflowDocument({
      spec: [
        'nodes:',
        '  - nodeId: draft',
        '    pipelineId: spec-authoring',
        '  - nodeId: review',
        '    pipelineId: spec-review',
        'startNodeIds:',
        '  - draft',
        '  - review'
      ]
    });

    const rows = plannedWorkflowRows(
      twoNodes,
      workflowContext({ effectivePipelines: [SPEC_AUTHORING] })
    );

    expect(rows[0]).toMatchObject({
      outcome: 'blocked',
      reason: { dependency: { kind: 'pipeline', resourceId: 'spec-review' } }
    });
  });

  it('returns a refusal with NO plan and no partial rows for a document-level refusal (FR-027)', () => {
    // Each of these is refused at the envelope, before any resource is
    // classified — including the last, whose second `included.phases` entry would
    // already have produced two rows on a reader that classified as it went.
    for (const text of [
      'apiVersion: schegent/v2\nkind: Workflow\nmetadata:\n  id: ship-it-flow\n',
      'apiVersion: schegent/v1\nkind: Pipeline\nmetadata:\n  id: ship-it-flow\n',
      'metadata:\n  id: ship-it-flow\n',
      workflowDocument({
        pipelines: [INCLUDED_SPEC_AUTHORING],
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

// ---------------------------------------------------------------------------
// Feature 086 T057-T059 — an id the catalog already holds is never overwritten
// (US7: FR-025a, FR-031 – FR-034, FR-036a, FR-038a, SC-009a, SC-011, SC-012a)
// ---------------------------------------------------------------------------
//
// 085 stated this rule for two catalogs; the third makes two of its properties
// newly reachable, and both are the kind that only shows up at depth:
//
//   - **Same-kind only** now has three kinds to confuse, and the one 085 could
//     not express is a DOCUMENT that declares a Workflow and a Pipeline sharing
//     an id. The reader's duplicate scan is per section, so the document is
//     admitted; presence then has to ask each catalog about its own kind, or one
//     resource silently gates the other.
//   - **The coherent triple** (FR-038a) runs the full three levels here: a Phase
//     skipped for presence, a Pipeline blocked naming that same Phase, a Workflow
//     blocked naming that Pipeline. Read as a contradiction it invites a
//     "reconciliation" that would suppress one of the three rows; it is not one.
//
// The FR-025a order (`invalid > skip > blocked > import`) is likewise only fully
// exercised with three kinds in play, because a Workflow is the first resource
// that can qualify for `skip` and `blocked` at once on dependencies two layers
// down.

describe('Feature 086 T057 — Workflow presence reads stored rows only (FR-031, FR-034, SC-011)', () => {
  it('claims a Workflow id from any layer in any state', () => {
    // The oracle-level twin of the Phase and Pipeline matrices above, walked
    // rather than sampled. `shadowed` and `invalid` are the load-bearing cells:
    // a row in either state has no resolved definition, so an oracle reading a
    // resolved catalog would report the id absent and overwrite authored work —
    // possibly a row the operator is part-way through repairing (FR-034).
    for (const scope of PRESENCE_SCOPES) {
      for (const status of PRESENCE_STATUSES) {
        expect(
          findWorkflowIdPresence([storedWorkflowRow('ship-it-flow', scope, status)], 'ship-it-flow')
        ).toEqual({ scope, status });
      }
    }
  });

  it('has no effective Workflow catalog to decide presence from', () => {
    // FR-034 stated structurally rather than behaviourally, because behaviour
    // cannot state it: the context carries `effectivePhases` and
    // `effectivePipelines` — resolution's oracles — and no effective Workflow
    // field at all. Presence has nothing to read but the stored rows. A future
    // `effectiveWorkflows` on this context would be the first step to the wrong
    // oracle, and would fail here before it could be wired to anything.
    expect(Object.keys(workflowContext()).sort()).toEqual([
      'effectivePhases',
      'effectivePipelines',
      'invalidPipelines',
      'phaseRows',
      'pipelineRevisions',
      'pipelineRows',
      'revisions',
      'workflowRevisions',
      'workflowRows'
    ]);
  });

  it('names the claiming layer and status on a Workflow skip, not just "already present" (FR-032)', () => {
    // Told only "already present", an operator cannot act: which of three layers
    // holds it, and is that row the healthy one or the broken one they are
    // fixing? Those are different next steps.
    const rows = plannedWorkflowRows(
      SELF_CONTAINED_WORKFLOW,
      workflowContext({ workflowRows: [storedWorkflowRow('ship-it-flow', 'workspace', 'invalid')] })
    );

    expect(rows[0]).toEqual({
      outcome: 'skip',
      resourceKind: 'workflow',
      resourceId: 'ship-it-flow',
      name: 'Ship It Flow',
      presentIn: 'workspace',
      presentRowStatus: 'invalid'
    });
  });
});

describe('Feature 086 T058 — same-kind conflicts and the coherent triple (FR-033, FR-036a, FR-038a)', () => {
  /** A package whose root Workflow and included Pipeline deliberately share an id. */
  const SHARED_ID_ACROSS_KINDS = workflowDocument({
    id: 'spec-authoring',
    pipelines: [INCLUDED_SPEC_AUTHORING],
    phases: [INCLUDED_SPECIFY]
  });

  /** What the effective Pipeline catalog holds when a claim on the shared id resolves. */
  const EFFECTIVE_SPEC_AUTHORING: PipelineDefinition = Object.freeze({
    pipelineId: 'spec-authoring',
    name: 'Spec Authoring',
    version: 2,
    phaseIds: Object.freeze(['specify']),
    inputs: Object.freeze([]),
    outputs: Object.freeze([]),
    bindings: Object.freeze([]),
    recommendedNext: Object.freeze([])
  });

  it('treats a Workflow id and a Pipeline id that match as no conflict at all (FR-033)', () => {
    // Three separate stores, so `spec-authoring` the Workflow and `spec-authoring`
    // the Pipeline are unrelated names that happen to be spelled alike. The
    // reader admits the document — its duplicate scan is per section — so
    // presence is the only thing standing between this package and one resource
    // gating the other.
    const rows = plannedWorkflowRows(SHARED_ID_ACROSS_KINDS, workflowContext());

    expect(rows.map((row) => [row.resourceKind, row.resourceId, row.outcome])).toEqual([
      ['workflow', 'spec-authoring', 'import'],
      ['pipeline', 'spec-authoring', 'import'],
      ['phase', 'specify', 'import']
    ]);
  });

  it('skips only the kind whose catalog claims the shared id, in either direction', () => {
    // The asymmetry is the test: a claim in one catalog must move exactly one
    // row. A shared scan would move both, and with the ids spelled alike the
    // mistake reads as correct.
    const workflowClaimed = plannedWorkflowRows(
      SHARED_ID_ACROSS_KINDS,
      workflowContext({
        workflowRows: [storedWorkflowRow('spec-authoring', 'user', 'effective')]
      })
    );
    expect(workflowClaimed.map((row) => row.outcome)).toEqual(['skip', 'import', 'import']);

    const pipelineClaimed = plannedWorkflowRows(
      SHARED_ID_ACROSS_KINDS,
      workflowContext({
        pipelineRows: [storedPipelineRow('spec-authoring', 'user', 'effective')],
        effectivePipelines: [EFFECTIVE_SPEC_AUTHORING]
      })
    );
    expect(pipelineClaimed.map((row) => row.outcome)).toEqual(['import', 'skip', 'import']);
  });

  it('reports all three of the coherent triple, none suppressed or merged (FR-038a, SC-012a)', () => {
    // The full-depth version of 085's FR-030b pair, and the shape most likely to
    // be "fixed" into a lie: the Phase is skipped because a stored row claims its
    // id; the Pipeline is blocked naming that SAME id because the claim does not
    // resolve; the Workflow is blocked naming that Pipeline. Every row answers a
    // different question, so none may be softened into another — and each names
    // its own root cause, so the chain reads from either end.
    const rows = plannedWorkflowRows(
      SELF_CONTAINED_WORKFLOW,
      workflowContext({ phaseRows: [storedRow('specify', 'workspace', 'shadowed')] })
    );

    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      outcome: 'blocked',
      resourceKind: 'workflow',
      resourceId: 'ship-it-flow',
      name: 'Ship It Flow',
      reason: {
        code: 'dependency-blocked',
        dependency: { kind: 'pipeline', resourceId: 'spec-authoring' },
        via: { kind: 'phase', resourceId: 'specify' }
      }
    });
    expect(rows[1]).toEqual({
      outcome: 'blocked',
      resourceKind: 'pipeline',
      resourceId: 'spec-authoring',
      name: 'Spec Authoring',
      reason: {
        code: 'dependency-unresolvable',
        dependency: { kind: 'phase', resourceId: 'specify' }
      }
    });
    expect(rows[2]).toEqual({
      outcome: 'skip',
      resourceKind: 'phase',
      resourceId: 'specify',
      name: 'Specify',
      presentIn: 'workspace',
      presentRowStatus: 'shadowed'
    });
  });

  it('neither writes nor compares the included copy of a skipped resource (FR-036a)', () => {
    // Two statements in one, because they fail together. A `skip` row carries no
    // `definition`, so there is nothing for a write to pick up — the write set is
    // the `import` rows and the skipped id is not among them. And it carries no
    // second copy of the resource either: comparing the document's copy against
    // the catalog's would invite a merge decision this feature does not make, and
    // the row shape is what would have to hold the two sides.
    const rows = plannedWorkflowRows(
      SELF_CONTAINED_WORKFLOW,
      workflowContext({
        workflowRows: [storedWorkflowRow('ship-it-flow', 'user', 'effective')],
        phaseRows: [storedRow('specify', 'user', 'effective')],
        effectivePhases: [SPECIFY]
      })
    );

    const skips = rows.filter((row) => row.outcome === 'skip');
    expect(skips.map((row) => row.resourceKind)).toEqual(['workflow', 'phase']);
    for (const row of skips) {
      expect(Object.keys(row).sort()).toEqual([
        'name',
        'outcome',
        'presentIn',
        'presentRowStatus',
        'resourceId',
        'resourceKind'
      ]);
    }

    const written = rows
      .filter((row) => row.outcome === 'import')
      .map((row) => `${row.resourceKind}:${row.resourceId}`);
    expect(written).toEqual(['pipeline:spec-authoring']);
  });
});

describe('Feature 086 T059 — the FR-025a precedence order (SC-009a)', () => {
  /** The same root, malformed: a version the validator rejects outright. */
  const MALFORMED_ROOT = workflowDocument({
    version: '0',
    pipelines: [INCLUDED_SPEC_AUTHORING],
    phases: [INCLUDED_SPECIFY]
  });

  /** An included Phase the validator rejects, alongside a well-formed Pipeline. */
  const MALFORMED_PHASE = workflowDocument({
    pipelines: [INCLUDED_SPEC_AUTHORING],
    phases: [
      includedResource(
        ['phaseId: specify', 'name: Specify', 'version: 0'],
        ['instruction: Write the spec.']
      )
    ]
  });

  it('reports a malformed resource as invalid even when the catalog holds its id', () => {
    // Validity before presence, at both the root and an included resource. The id
    // a malformed resource claims may itself be the defect, so consulting
    // presence would answer with a row that has nothing to do with it — and
    // "already present" would tell the operator to do nothing about a document
    // that is broken.
    const claimsEverything = workflowContext({
      workflowRows: [storedWorkflowRow('ship-it-flow', 'user', 'effective')],
      phaseRows: [storedRow('specify', 'user', 'effective')],
      effectivePhases: [SPECIFY]
    });

    const rootRows = plannedWorkflowRows(MALFORMED_ROOT, claimsEverything);
    expect(rootRows[0]?.outcome).toBe('invalid');
    if (rootRows[0]?.outcome !== 'invalid') return;
    expect(rootRows[0].resourceId).toBe('ship-it-flow');
    expect(rootRows[0].defects.length).toBeGreaterThan(0);
    // An invalid row carries no presence evidence, because presence was never asked.
    expect(rootRows[0]).not.toHaveProperty('presentIn');
    expect(rootRows[0]).not.toHaveProperty('presentRowStatus');

    const phaseRows = plannedWorkflowRows(MALFORMED_PHASE, claimsEverything);
    const phase = phaseRows.find((row) => row.resourceKind === 'phase');
    expect(phase?.outcome).toBe('invalid');
  });

  it('reports a claimed resource as skip even when a dependency of it is missing', () => {
    // Presence before resolution, at both levels. Nothing this import will write
    // depends on the reference, so reporting the dependency would send the
    // operator to fix something that is not in their way.
    const referencesOnlyClaimed = plannedWorkflowRows(
      REFERENCES_ONLY_WORKFLOW,
      workflowContext({ workflowRows: [storedWorkflowRow('ship-it-flow', 'user', 'effective')] })
    );
    // Without the claim this exact document is `blocked` on `spec-authoring` —
    // the `planWorkflowImport` block above pins that half.
    expect(referencesOnlyClaimed.map((row) => row.outcome)).toEqual(['skip']);
    expect(referencesOnlyClaimed[0]).not.toHaveProperty('reason');

    // And one level down: a claimed Pipeline whose Phase the document does not
    // supply is `skip`, not `blocked`.
    const pipelineClaimed = plannedWorkflowRows(
      workflowDocument({ pipelines: [INCLUDED_SPEC_AUTHORING] }),
      workflowContext({ pipelineRows: [storedPipelineRow('spec-authoring', 'user', 'effective')] })
    );
    const pipeline = pipelineClaimed.find((row) => row.resourceKind === 'pipeline');
    expect(pipeline?.outcome).toBe('skip');
    expect(pipeline).not.toHaveProperty('reason');
  });

  it('classifies each resource of a claimed Workflow on its own merits (FR-025b)', () => {
    // The root is skipped and its dependencies are absent, which under a
    // propagating scheme would make the whole package one line. It is three: the
    // Workflow `skip` for presence, the Phase `skip` for presence, and the
    // Pipeline `blocked` because the row claiming its Phase does not resolve.
    // Three resources, three questions, three answers.
    const rows = plannedWorkflowRows(
      SELF_CONTAINED_WORKFLOW,
      workflowContext({
        workflowRows: [storedWorkflowRow('ship-it-flow', 'user', 'effective')],
        phaseRows: [storedRow('specify', 'workspace', 'shadowed')]
      })
    );

    expect(rows.map((row) => [row.resourceKind, row.outcome])).toEqual([
      ['workflow', 'skip'],
      ['pipeline', 'blocked'],
      ['phase', 'skip']
    ]);
  });

  it('selects one outcome per resource in every combination the order distinguishes (SC-009a)', () => {
    // The matrix, walked rather than sampled: validity crossed with presence
    // crossed with resolvability, at the root. Each cell names the outcome the
    // order selects, and the point of the table is that the FIRST applicable rule
    // wins — every `invalid` cell also has a claimed id, and both `skip` cells
    // also have something later in the order to say.
    const cases = [
      { malformed: true, claimed: true, resolvable: true, expected: 'invalid' },
      { malformed: true, claimed: true, resolvable: false, expected: 'invalid' },
      { malformed: true, claimed: false, resolvable: true, expected: 'invalid' },
      { malformed: true, claimed: false, resolvable: false, expected: 'invalid' },
      { malformed: false, claimed: true, resolvable: true, expected: 'skip' },
      { malformed: false, claimed: true, resolvable: false, expected: 'skip' },
      { malformed: false, claimed: false, resolvable: true, expected: 'import' },
      { malformed: false, claimed: false, resolvable: false, expected: 'blocked' }
    ] as const;

    for (const testCase of cases) {
      // Resolvability is the node's: the self-contained document supplies the
      // Pipeline its node names, and the references-only one does not.
      const text = testCase.resolvable
        ? testCase.malformed
          ? MALFORMED_ROOT
          : SELF_CONTAINED_WORKFLOW
        : workflowDocument(testCase.malformed ? { version: '0' } : {});
      const rows = plannedWorkflowRows(
        text,
        workflowContext(
          testCase.claimed
            ? { workflowRows: [storedWorkflowRow('ship-it-flow', 'user', 'effective')] }
            : {}
        )
      );

      expect(rows[0]?.outcome, JSON.stringify(testCase)).toBe(testCase.expected);
    }
  });
});

describe('the shipped example imports into a workspace that has never imported (T032)', () => {
  // Feature 098 (SC-002) — the defect this feature exists to fix, asserted on the
  // document the VSIX actually ships rather than on a fixture that resembles it.
  //
  // The presence oracle is built the way `preflight-service.ts` builds it — through
  // `resolvePhaseCatalog` / `resolvePipelineCatalog` over the product's own layers,
  // with the operator's two layers empty. That is deliberate and is what makes this
  // test say something: a `context({ phaseRows: [] })` would pass today, because the
  // planner is given its rows and the rows were never the argument that was wrong.
  // What was wrong is that the built-in layer claimed the nine Phase ids and the one
  // Pipeline id this very document supplies, so every row came back `skip` and the
  // import wrote nothing.
  const EXAMPLE = readFileSync(
    join(__dirname, '..', '..', '..', 'examples', 'speckit-new-feature.pipeline.yaml'),
    'utf8'
  );

  function shippedContext(): PackageImportContext {
    const phaseCatalog = resolvePhaseCatalog({
      builtIn: BUILT_IN_PHASES,
      user: [],
      workspace: []
    });
    const pipelineCatalog = resolvePipelineCatalog({
      builtIn: BUILT_IN_PIPELINES,
      user: [],
      workspace: [],
      phaseCatalog: phaseCatalog.effective
    });
    return {
      phaseRows: phaseCatalog.records,
      pipelineRows: pipelineCatalog.records,
      effectivePhases: phaseCatalog.effective,
      revisions: phaseCatalog.revisions,
      pipelineRevisions: pipelineCatalog.revisions
    };
  }

  it('plans ten rows — one Pipeline and nine Phases — and skips none', () => {
    const rows = plannedRows(EXAMPLE, shippedContext());

    expect(rows).toHaveLength(10);
    expect(rows.filter((row) => row.outcome === 'skip')).toEqual([]);
    expect(rows.map((row) => row.outcome)).toEqual(Array.from({ length: 10 }, () => 'import'));
  });

  it('names the Pipeline first and then its nine Phases in declaration order', () => {
    const rows = plannedRows(EXAMPLE, shippedContext());

    expect(rows.map((row) => [row.resourceKind, row.resourceId])).toEqual([
      ['pipeline', 'speckit-new-feature'],
      ['phase', 'speckit-specify'],
      ['phase', 'speckit-clarify'],
      ['phase', 'speckit-plan'],
      ['phase', 'speckit-tasks'],
      ['phase', 'speckit-checklist'],
      ['phase', 'speckit-analyze'],
      ['phase', 'speckit-implement'],
      ['phase', 'speckit-review'],
      ['phase', 'finalize']
    ]);
  });

  it('carries a definition on every row, so confirming the plan has ten things to write', () => {
    // A plan whose rows resolve `import` but carry nothing would report ten writes
    // and perform none. Each row is asserted to hold the definition the write needs,
    // and the root Pipeline's phase list is asserted to be the one the document
    // declared — the plan is what a confirmed write becomes effective from.
    const rows = plannedRows(EXAMPLE, shippedContext());

    for (const row of rows) {
      expect(row.outcome).toBe('import');
      // A `modelCatalog` import row carries `backend`/`modelId` in place of a
      // `definition`, so it has to be excluded from the check below. Asserting
      // the exclusion is empty keeps the narrowing from silently excusing a row.
      expect(row.resourceKind).not.toBe('modelCatalog');
      if (row.outcome !== 'import' || row.resourceKind === 'modelCatalog') continue;
      expect(row.definition).toBeDefined();
    }
    const root = rows[0];
    expect(root?.resourceKind).toBe('pipeline');
    expect(root?.outcome).toBe('import');
  });

  it('also plans the bugfix example with no skip rows', () => {
    const bugfix = readFileSync(
      join(__dirname, '..', '..', '..', 'examples', 'speckit-bugfix.pipeline.yaml'),
      'utf8'
    );
    const rows = plannedRows(bugfix, shippedContext());

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.outcome === 'skip')).toEqual([]);
  });
});
