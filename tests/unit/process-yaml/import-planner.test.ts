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
  PipelineDefinitionScope,
  PipelineSourceRecord,
  PipelineSourceStatus
} from '../../../src/contracts/pipeline-definitions';
import {
  findPhaseIdPresence,
  findPipelineIdPresence,
  planPhaseImport,
  planPipelineImport,
  type PackageImportContext
} from '../../../src/services/process-yaml/import-planner';
import { parsePipelinePackage } from '../../../src/services/process-yaml/pipeline-document';
import type {
  ImportPlanRow,
  ProcessYamlLayerRevisions
} from '../../../src/services/process-yaml/types';
import { validatePhaseDocument } from '../../../src/services/process-yaml/phase-yaml-validator';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';

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
      if (row.outcome === 'skip') {
        expect(row.presentIn).toBeTruthy();
        expect(row.presentRowStatus).toBeTruthy();
      } else if (row.outcome === 'blocked') {
        expect(row.reason.code).toMatch(/^dependency-(absent|unresolvable)$/);
        expect(row.reason.phaseId.length).toBeGreaterThan(0);
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
      reason: { code: 'dependency-unresolvable', phaseId: 'specify' }
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
      expect(PRESENCE_SCOPES).toContain(row.presentIn);
      expect(PRESENCE_STATUSES).toContain(row.presentRowStatus);
    }
  });
});
