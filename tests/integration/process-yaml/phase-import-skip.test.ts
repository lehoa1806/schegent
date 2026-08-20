// Feature 084 T044/T045 — an import can only ever add.
//
// QS-15, QS-16, and QS-17 in one file, driven through the preflight command over
// a REAL resolved catalog rather than synthetic `PhaseSourceRecord`s: an
// `effective` id skips, a contested id skips, and an `invalid` id skips. The
// unit tests pin the presence oracle in isolation; what this file adds is that
// the statuses arise from actual stored rows the way an installation produces
// them, which is what makes the stored-rows-not-effective-catalog rule (FR-030,
// SC-004) testable end to end. The `invalid` case is the sharp one — no
// effective catalog contains that id at all, so a presence check written against
// `resolution.effective` would plan an import and silently take the id an
// operator is part-way through repairing.
//
// T045 is the other half: for each case the catalog is compared byte-for-byte
// before and after, the resolved definition is compared field by field, and every
// write-shaped dependency is asserted untouched. A `skip` overwrites nothing,
// merges nothing, renames nothing, and bumps no version.
//
// Feature 099 (T496f, FR-042) — the built-in/user/workspace tier is gone, and with
// it `presentIn` on a skip row and the `shadowed` arm of `PhaseSourceStatus`. Both
// carried layer facts and neither has anything left to say. What each case pinned
// is preserved on the one catalog that remains; see the case comments.

import { describe, expect, it, vi } from 'vitest';

import { resolvePhaseCatalog } from '../../../src/config/process-catalog';
import { CMD_PREFLIGHT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import type { PhaseSourceStatus } from '../../../src/contracts/process-definitions';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { FakeCatalogStore, NO_WRITES, writesOf } from '../../fixtures/fake-catalog-store';
import { readFileSync } from 'fs';
import { join } from 'path';

const SEEDED_PHASE_REVISION = 'rev-phase-import-skip';
const SEEDED_PIPELINE_REVISION = 'rev-pipeline-import-skip';

interface Harness {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly ctx: any;
  readonly acks: CommandAckMessage[];
  readonly audits: unknown[];
  readonly store: FakeCatalogStore;
  readonly executeCommand: ReturnType<typeof vi.fn>;
  readonly notifyWarning: ReturnType<typeof vi.fn>;
}

function buildHarness(rows: readonly unknown[], documentText: string): Harness {
  const acks: CommandAckMessage[] = [];
  const audits: unknown[] = [];
  const executeCommand = vi.fn();
  const notifyWarning = vi.fn();
  const store = new FakeCatalogStore({
    revisions: { phase: SEEDED_PHASE_REVISION, pipeline: SEEDED_PIPELINE_REVISION }
  });

  const ctx = {
    deps: {
      readPhaseConfig: () => ({ rows, revision: store.revisionOf('phase') }),
      catalogStore: store,
      refreshCatalog: async () => undefined,
      executeCommand,
      notifyWarning,
      openProcessYamlDocument: async () => ({
        outcome: 'read' as const,
        bytes: new Uint8Array(Buffer.from(documentText, 'utf8'))
      }),
      audit: {
        append: async (entry: unknown) => {
          audits.push(entry);
          return undefined;
        }
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (value: string) => value
      }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'import-skip-1'
  };

  return { ctx, acks, audits, store, executeCommand, notifyWarning };
}

const COMMAND: PreflightProcessYamlCommand = {
  type: CMD_PREFLIGHT_PROCESS_YAML,
  correlationId: 'import-skip-1',
  payload: {}
};

/**
 * A document claiming `phaseId`. Its contents differ from every stored row it is
 * matched against, so a merge or an overwrite would be visible in the catalog.
 */
function documentClaiming(phaseId: string): string {
  return [
    'apiVersion: schegent/v1',
    'kind: Phase',
    'metadata:',
    `  phaseId: ${phaseId}`,
    '  name: Incoming Definition',
    '  version: 42',
    'spec:',
    '  instruction: Replace whatever is there.',
    ''
  ].join('\n');
}

const STORED_ID = 'ship-it';

/** A valid stored row: resolves, so its record is `effective`. */
const VALID_ROW = Object.freeze({
  id: STORED_ID,
  name: 'Ship It',
  version: 3,
  instruction: 'Ship the thing.',
  timeoutSeconds: 900
});

/**
 * A stored row that fails validation: no `instruction` and no `skill`, so it
 * carries no definition and appears in no effective catalog. It still claims its
 * id (FR-030).
 */
const INVALID_ROW = Object.freeze({ id: STORED_ID, name: 'Half Repaired', version: 2 });

/** The id two rows contend for in the QS-16 case. */
const CONTESTED_ID = 'speckit-specify';

interface SkipCase {
  readonly title: string;
  readonly rows: readonly unknown[];
  readonly phaseId: string;
  readonly presentRowStatus: PhaseSourceStatus;
}

const CASES: readonly SkipCase[] = [
  {
    title: 'QS-15 an effective id skips',
    rows: [VALID_ROW],
    phaseId: STORED_ID,
    presentRowStatus: 'effective'
  },
  {
    // Feature 098 (T036) expressed this as a user row shadowed by a workspace row;
    // feature 099 (FR-042) deletes the tier that made shadowing representable, and
    // `shadowed` is gone from `PhaseSourceStatus` with it. Two rows contending for
    // one id is still representable — it is a duplicate within the one catalog —
    // and it carries QS-16's property unchanged: the scan reports the id as taken
    // WITHOUT choosing between the rows claiming it. Presence is a gate, not a
    // routing decision, so the plan says only "someone has this id".
    title: 'QS-16 an id two rows contend for skips, and the plan picks neither',
    rows: [
      {
        id: CONTESTED_ID,
        name: 'First Specify',
        version: 1,
        instruction: 'Use the shipped house style.'
      },
      {
        id: CONTESTED_ID,
        name: 'Second Specify',
        version: 2,
        instruction: 'Use the local house style.'
      }
    ],
    phaseId: CONTESTED_ID,
    presentRowStatus: 'invalid'
  },
  {
    title: 'QS-17 an invalid id skips — the stored-rows rule, not the effective catalog',
    rows: [INVALID_ROW],
    phaseId: STORED_ID,
    presentRowStatus: 'invalid'
  }
];

describe('Feature 084 — an import never takes an id that is already claimed', () => {
  for (const testCase of CASES) {
    it(testCase.title, async () => {
      const before = JSON.stringify(testCase.rows);
      const resolvedBefore = resolvePhaseCatalog({
        rows: testCase.rows,
        revision: SEEDED_PHASE_REVISION
      });
      const definitionBefore = resolvedBefore.effective.find(
        (definition) => definition.phaseId === testCase.phaseId
      );

      const h = buildHarness(testCase.rows, documentClaiming(testCase.phaseId));
      await preflightHandler(h.ctx, COMMAND);

      expect(h.acks).toHaveLength(1);
      const result = h.acks[0]!.result as PreflightProcessYamlResult;
      expect(result.outcome).toBe('planned');
      if (result.outcome !== 'planned') return;

      // The plan says skip, reports the claimant's status, and carries no
      // definition — so there is nothing for a commit to write even if one were
      // attempted. It names no row and no destination: with one catalog there is
      // neither a layer to cite nor a choice to make.
      expect(result.plan.rows).toEqual([
        {
          outcome: 'skip',
          resourceKind: 'phase',
          resourceId: testCase.phaseId,
          name: 'Incoming Definition',
          presentRowStatus: testCase.presentRowStatus
        }
      ]);
      expect(result.plan.rows[0]).not.toHaveProperty('presentIn');
      expect(result.plan.counts).toEqual({ import: 0, skip: 1, invalid: 0, blocked: 0 });

      // T045 — the catalog, byte for byte, either side of the call.
      expect(JSON.stringify(testCase.rows)).toBe(before);
      const resolvedAfter = resolvePhaseCatalog({
        rows: testCase.rows,
        revision: h.store.revisionOf('phase')
      });
      expect(resolvedAfter.revision).toBe(resolvedBefore.revision);
      // No overwrite and no merge: the definition this installation runs is the
      // same object shape, including the `version` the document tried to raise
      // to 42, and including the ids the catalog holds (nothing renamed).
      expect(
        resolvedAfter.effective.find((definition) => definition.phaseId === testCase.phaseId)
      ).toEqual(definitionBefore);
      expect(resolvedAfter.records.map((record) => `${record.status}:${record.phaseId}`)).toEqual(
        resolvedBefore.records.map((record) => `${record.status}:${record.phaseId}`)
      );

      // Nothing that could write was reached, and a skip is not an audited event.
      expect(writesOf(h.store)).toEqual(NO_WRITES);
      expect(h.executeCommand).not.toHaveBeenCalled();
      expect(h.notifyWarning).not.toHaveBeenCalled();
      expect(h.audits).toEqual([]);
    });
  }

  it('QS-17 the skipped invalid id resolves in no effective catalog at all (SC-004)', async () => {
    // Stated separately because it is the premise the QS-17 case rests on: a
    // presence check written against `resolution.effective` would find nothing
    // here and plan an import.
    const rows: readonly unknown[] = [INVALID_ROW];
    const resolved = resolvePhaseCatalog({ rows, revision: SEEDED_PHASE_REVISION });
    expect(resolved.effective.some((definition) => definition.phaseId === STORED_ID)).toBe(false);
    expect(resolved.records.find((record) => record.phaseId === STORED_ID)).toMatchObject({
      status: 'invalid',
      definition: null
    });

    const h = buildHarness(rows, documentClaiming(STORED_ID));
    await preflightHandler(h.ctx, COMMAND);

    const result = h.acks[0]!.result as PreflightProcessYamlResult;
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.plan.counts.import).toBe(0);
  });

  it('an id claimed by a row anywhere in the catalog still skips (FR-030)', async () => {
    // Presence is a scan of the whole catalog, not of some privileged part of it.
    // Feature 098 stated this across layers — an id claimed only in the layer the
    // operator did not target still skipped. One catalog states the same rule
    // positionally: the claiming row sits last, behind unrelated rows, and the
    // import is refused all the same.
    const rows: readonly unknown[] = [
      { id: 'decoy-one', name: 'Decoy One', version: 1, instruction: 'Not the one.' },
      { id: 'decoy-two', name: 'Decoy Two', version: 1, instruction: 'Also not the one.' },
      VALID_ROW
    ];
    const h = buildHarness(rows, documentClaiming(STORED_ID));
    await preflightHandler(h.ctx, COMMAND);

    const result = h.acks[0]!.result as PreflightProcessYamlResult;
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.plan.rows[0]).toMatchObject({
      outcome: 'skip',
      resourceId: STORED_ID,
      presentRowStatus: 'effective'
    });
    expect(JSON.stringify(rows[2])).toBe(JSON.stringify(VALID_ROW));
  });
});

describe('Feature 098 (T033) — importing the same document twice writes once', () => {
  // SC-004, on the document the VSIX ships. The first import is represented by its
  // outcome — the ten rows sitting in the catalog — and the assertion is about the
  // second run: every row skips, every row reports a claimant that resolves, and
  // nothing is written.
  //
  // The claimant matters as much as the count. Before feature 098 the same document
  // also produced an all-skip plan, but citing `built-in` — an operator who had never
  // imported anything was told their own ids were taken. Feature 099 removed the
  // built-in tier outright, so the only rows that can claim an id are ones the
  // operator put there, and `presentRowStatus: 'effective'` is the residue of that
  // claim: a row that resolves, holding the id.
  const EXAMPLE = readFileSync(
    join(__dirname, '..', '..', '..', 'examples', 'speckit-new-feature.pipeline.yaml'),
    'utf8'
  );

  const IMPORTED_PHASE_IDS = Object.freeze([
    'speckit-specify',
    'speckit-clarify',
    'speckit-plan',
    'speckit-tasks',
    'speckit-checklist',
    'speckit-analyze',
    'speckit-implement',
    'speckit-review',
    'finalize'
  ]);

  /**
   * What the catalog holds after the first import. The stored rows deliberately do
   * NOT match the document — different names, a raised version — so an overwrite or
   * a merge on the second run would be visible in the catalog rather than hidden
   * behind identical content.
   */
  function importedPhases(): readonly unknown[] {
    return IMPORTED_PHASE_IDS.map((id) => ({
      id,
      name: `Already Imported ${id}`,
      version: 7,
      instruction: `Stored instruction for ${id}.`
    }));
  }

  function importedPipelines(): readonly unknown[] {
    return [
      {
        id: 'speckit-new-feature',
        name: 'Already Imported Pipeline',
        version: 7,
        phases: [...IMPORTED_PHASE_IDS]
      }
    ];
  }

  function buildPackageHarness(): Harness {
    const pipelines = importedPipelines();
    const base = buildHarness(importedPhases(), EXAMPLE);
    base.ctx.deps.readPipelineConfig = () => ({
      rows: pipelines,
      revision: base.store.revisionOf('pipeline')
    });
    return base;
  }

  it('plans ten skip rows, every one citing a stored row that resolves', async () => {
    const h = buildPackageHarness();
    await preflightHandler(h.ctx, COMMAND);

    const result = h.acks[0]!.result as PreflightProcessYamlResult;
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    expect(result.plan.counts).toEqual({ import: 0, skip: 10, invalid: 0, blocked: 0 });
    for (const row of result.plan.rows) {
      expect(row.outcome).toBe('skip');
      if (row.outcome !== 'skip' || row.resourceKind === 'modelCatalog') continue;
      expect(row.presentRowStatus).toBe('effective');
      expect(row).not.toHaveProperty('presentIn');
    }
  });

  it('writes nothing on the second run', async () => {
    const h = buildPackageHarness();
    await preflightHandler(h.ctx, COMMAND);

    expect(writesOf(h.store)).toEqual(NO_WRITES);
    expect(h.audits).toEqual([]);
  });
});
