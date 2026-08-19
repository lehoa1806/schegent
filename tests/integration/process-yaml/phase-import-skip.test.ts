// Feature 084 T044/T045 — an import can only ever add.
//
// QS-15, QS-16, and QS-17 in one file, driven through the preflight command over
// a REAL resolved catalog rather than synthetic `PhaseSourceRecord`s: an
// `effective` id skips, a `shadowed` id skips, and an `invalid` id skips. The
// unit tests pin the presence oracle in isolation; what this file adds is that
// the three statuses arise from actual stored rows the way an installation
// produces them, which is what makes the stored-rows-not-effective-catalog rule
// (FR-030, SC-004) testable end to end. The `invalid` case is the sharp one — no
// effective catalog contains that id at all, so a presence check written against
// `resolution.effective` would plan an import and silently take the id an
// operator is part-way through repairing.
//
// T045 is the other half: for each case the target layer is compared
// byte-for-byte before and after, the resolved definition is compared field by
// field, and every write-shaped dependency is asserted untouched. A `skip`
// overwrites nothing, merges nothing, renames nothing, and bumps no version.

import { describe, expect, it, vi } from 'vitest';

import { BUILT_IN_PHASES } from '../../../src/config/pipeline-config';
import { resolvePhaseCatalog } from '../../../src/config/process-catalog';
import { CMD_PREFLIGHT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import type { PhaseDefinitionScope, PhaseSourceStatus } from '../../../src/contracts/process-definitions';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { readFileSync } from 'fs';
import { join } from 'path';

interface Layers {
  readonly user: readonly unknown[];
  readonly workspace: readonly unknown[];
}

interface Harness {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly ctx: any;
  readonly acks: CommandAckMessage[];
  readonly audits: unknown[];
  readonly writePhaseConfig: ReturnType<typeof vi.fn>;
  readonly updateConfig: ReturnType<typeof vi.fn>;
  readonly executeCommand: ReturnType<typeof vi.fn>;
  readonly notifyWarning: ReturnType<typeof vi.fn>;
}

function buildHarness(layers: Layers, documentText: string): Harness {
  const acks: CommandAckMessage[] = [];
  const audits: unknown[] = [];
  const writePhaseConfig = vi.fn();
  const updateConfig = vi.fn();
  const executeCommand = vi.fn();
  const notifyWarning = vi.fn();

  const ctx = {
    deps: {
      readPhaseConfig: () => ({ user: layers.user, workspace: layers.workspace }),
      writePhaseConfig,
      updateConfig,
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

  return { ctx, acks, audits, writePhaseConfig, updateConfig, executeCommand, notifyWarning };
}

const COMMAND: PreflightProcessYamlCommand = {
  type: CMD_PREFLIGHT_PROCESS_YAML,
  correlationId: 'import-skip-1',
  payload: {}
};

/**
 * A document claiming `phaseId`. Its contents differ from every stored row it is
 * matched against, so a merge or an overwrite would be visible in the layer.
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

/** The built-in whose id a valid user row shadows in the QS-16 case. */
const SHADOWED_ID = 'speckit-specify';

interface SkipCase {
  readonly title: string;
  readonly layers: Layers;
  readonly phaseId: string;
  readonly presentIn: PhaseDefinitionScope;
  readonly presentRowStatus: PhaseSourceStatus;
  /** The layer a commit would have written, had the plan produced an import. */
  readonly target: 'user' | 'workspace';
}

const CASES: readonly SkipCase[] = [
  {
    title: 'QS-15 an effective id skips',
    layers: { user: [VALID_ROW], workspace: [] },
    phaseId: STORED_ID,
    presentIn: 'user',
    presentRowStatus: 'effective',
    target: 'user'
  },
  {
    title: 'QS-16 a shadowed id skips and says which row claimed it',
    // Feature 098 (T036) — the shadowed row used to be the built-in of this id,
    // with a user row winning over it. The built-in layer holds nothing to shadow,
    // so the same arrangement is expressed one layer up: the workspace row wins
    // and the user row is left `shadowed`. The property is untouched — the
    // presence scan reports the lower-precedence row first, so the claimant it
    // names is NOT what the installation runs. Presence is a gate, not a routing
    // decision.
    layers: {
      user: [
        {
          id: SHADOWED_ID,
          name: 'User Specify',
          version: 1,
          instruction: 'Use the shipped house style.'
        }
      ],
      workspace: [
        {
          id: SHADOWED_ID,
          name: 'Locally Overridden Specify',
          version: 2,
          instruction: 'Use the local house style.'
        }
      ]
    },
    phaseId: SHADOWED_ID,
    presentIn: 'user',
    presentRowStatus: 'shadowed',
    target: 'workspace'
  },
  {
    title: 'QS-17 an invalid id skips — the stored-rows rule, not the effective catalog',
    layers: { user: [INVALID_ROW], workspace: [] },
    phaseId: STORED_ID,
    presentIn: 'user',
    presentRowStatus: 'invalid',
    target: 'user'
  }
];

describe('Feature 084 — an import never takes an id that is already claimed', () => {
  for (const testCase of CASES) {
    it(testCase.title, async () => {
      const before = {
        user: JSON.stringify(testCase.layers.user),
        workspace: JSON.stringify(testCase.layers.workspace)
      };
      const resolvedBefore = resolvePhaseCatalog({ builtIn: BUILT_IN_PHASES, ...testCase.layers });
      const definitionBefore = resolvedBefore.effective.find(
        (definition) => definition.phaseId === testCase.phaseId
      );

      const h = buildHarness(testCase.layers, documentClaiming(testCase.phaseId));
      await preflightHandler(h.ctx, COMMAND);

      expect(h.acks).toHaveLength(1);
      const result = h.acks[0]!.result as PreflightProcessYamlResult;
      expect(result.outcome).toBe('planned');
      if (result.outcome !== 'planned') return;

      // The plan says skip, names the claimant, and carries no definition — so
      // there is nothing for a commit to write even if one were attempted.
      expect(result.plan.rows).toEqual([
        {
          outcome: 'skip',
          resourceKind: 'phase',
          resourceId: testCase.phaseId,
          name: 'Incoming Definition',
          presentIn: testCase.presentIn,
          presentRowStatus: testCase.presentRowStatus
        }
      ]);
      expect(result.plan.counts).toEqual({ import: 0, skip: 1, invalid: 0, blocked: 0 });

      // T045 — the layer, byte for byte, either side of the call.
      expect(JSON.stringify(testCase.layers.user)).toBe(before.user);
      expect(JSON.stringify(testCase.layers.workspace)).toBe(before.workspace);
      const resolvedAfter = resolvePhaseCatalog({ builtIn: BUILT_IN_PHASES, ...testCase.layers });
      expect(resolvedAfter.revisions).toEqual(resolvedBefore.revisions);
      // No overwrite and no merge: the definition this installation runs is the
      // same object shape, including the `version` the document tried to raise
      // to 42, and including the ids the layer holds (nothing renamed).
      expect(
        resolvedAfter.effective.find((definition) => definition.phaseId === testCase.phaseId)
      ).toEqual(definitionBefore);
      expect(resolvedAfter.records.map((record) => `${record.scope}:${record.phaseId}`)).toEqual(
        resolvedBefore.records.map((record) => `${record.scope}:${record.phaseId}`)
      );

      // Nothing that could write was reached, and a skip is not an audited event.
      expect(h.writePhaseConfig).not.toHaveBeenCalled();
      expect(h.updateConfig).not.toHaveBeenCalled();
      expect(h.executeCommand).not.toHaveBeenCalled();
      expect(h.notifyWarning).not.toHaveBeenCalled();
      expect(h.audits).toEqual([]);
    });
  }

  it('QS-17 the skipped invalid id resolves in no effective catalog at all (SC-004)', async () => {
    // Stated separately because it is the premise the QS-17 case rests on: a
    // presence check written against `resolution.effective` would find nothing
    // here and plan an import.
    const layers: Layers = { user: [INVALID_ROW], workspace: [] };
    const resolved = resolvePhaseCatalog({ builtIn: BUILT_IN_PHASES, ...layers });
    expect(resolved.effective.some((definition) => definition.phaseId === STORED_ID)).toBe(false);
    expect(
      resolved.records.find((record) => record.scope === 'user' && record.phaseId === STORED_ID)
    ).toMatchObject({ status: 'invalid', definition: null });

    const h = buildHarness(layers, documentClaiming(STORED_ID));
    await preflightHandler(h.ctx, COMMAND);

    const result = h.acks[0]!.result as PreflightProcessYamlResult;
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.plan.counts.import).toBe(0);
  });

  it('an id claimed only in the layer the operator did not target still skips (FR-030)', async () => {
    // Presence is not scoped to the chosen target: the workspace layer claims
    // the id, and a user-scoped import is refused all the same. Otherwise the
    // same id would end up in two layers, one of them permanently shadowed.
    const layers: Layers = { user: [], workspace: [VALID_ROW] };
    const h = buildHarness(layers, documentClaiming(STORED_ID));
    await preflightHandler(h.ctx, COMMAND);

    const result = h.acks[0]!.result as PreflightProcessYamlResult;
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.plan.rows[0]).toMatchObject({
      outcome: 'skip',
      presentIn: 'workspace',
      presentRowStatus: 'effective'
    });
    expect(JSON.stringify(layers.workspace)).toBe(JSON.stringify([VALID_ROW]));
  });
});

describe('Feature 098 (T033) — importing the same document twice writes once', () => {
  // SC-004, on the document the VSIX ships. The first import is represented by its
  // outcome — the ten rows sitting in the WORKSPACE layer, which is where a
  // workspace-scoped import puts them — and the assertion is about the second run:
  // every row skips, every row names `workspace` as the claimant, and nothing is
  // written.
  //
  // The claimant matters as much as the count. Before this feature the same document
  // also produced an all-skip plan, but citing `built-in` — an operator who had never
  // imported anything was told their own ids were taken. `workspace` is a claim the
  // operator made, and it is the one an idempotent re-import should report.
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
   * What the workspace layer holds after the first import. The stored rows
   * deliberately do NOT match the document — different names, a raised version — so
   * an overwrite or a merge on the second run would be visible in the layer rather
   * than hidden behind identical content.
   */
  function importedWorkspacePhases(): readonly unknown[] {
    return IMPORTED_PHASE_IDS.map((id) => ({
      id,
      name: `Already Imported ${id}`,
      version: 7,
      instruction: `Stored instruction for ${id}.`
    }));
  }

  function importedWorkspacePipelines(): readonly unknown[] {
    return [
      {
        id: 'speckit-new-feature',
        name: 'Already Imported Pipeline',
        version: 7,
        phases: [...IMPORTED_PHASE_IDS]
      }
    ];
  }

  function buildPackageHarness(): Harness & { readonly writePipelineConfig: ReturnType<typeof vi.fn> } {
    const phases = importedWorkspacePhases();
    const pipelines = importedWorkspacePipelines();
    const base = buildHarness({ user: [], workspace: phases }, EXAMPLE);
    const writePipelineConfig = vi.fn();
    base.ctx.deps.readPipelineConfig = () => ({ user: [], workspace: pipelines });
    base.ctx.deps.writePipelineConfig = writePipelineConfig;
    return { ...base, writePipelineConfig };
  }

  it('plans ten skip rows, every one citing the workspace layer', async () => {
    const h = buildPackageHarness();
    await preflightHandler(h.ctx, COMMAND);

    const result = h.acks[0]!.result as PreflightProcessYamlResult;
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    expect(result.plan.counts).toEqual({ import: 0, skip: 10, invalid: 0, blocked: 0 });
    for (const row of result.plan.rows) {
      expect(row.outcome).toBe('skip');
      if (row.outcome !== 'skip' || row.resourceKind === 'modelCatalog') continue;
      expect(row.presentIn).toBe('workspace');
      expect(row.presentRowStatus).toBe('effective');
    }
  });

  it('writes nothing on the second run', async () => {
    const h = buildPackageHarness();
    await preflightHandler(h.ctx, COMMAND);

    expect(h.writePhaseConfig).not.toHaveBeenCalled();
    expect(h.writePipelineConfig).not.toHaveBeenCalled();
    expect(h.updateConfig).not.toHaveBeenCalled();
    expect(h.audits).toEqual([]);
  });
});
