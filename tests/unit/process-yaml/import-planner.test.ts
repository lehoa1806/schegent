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
  PhaseDefinitionScope,
  PhaseSourceRecord,
  PhaseSourceStatus
} from '../../../src/contracts/process-definitions';
import {
  findPhaseIdPresence,
  planPhaseImport
} from '../../../src/services/process-yaml/import-planner';
import type { ProcessYamlLayerRevisions } from '../../../src/services/process-yaml/types';
import { validatePhaseDocument } from '../../../src/services/process-yaml/phase-yaml-validator';
import { parseDocumentText } from '../../../src/services/process-yaml/yaml-parser';

const REVISIONS: ProcessYamlLayerRevisions = Object.freeze({
  user: 'user-rev-1',
  workspace: 'workspace-rev-1'
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
