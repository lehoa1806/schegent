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
const SHADOWED_BUILT_IN_ID = 'speckit-specify';

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
    // A valid user row wins over the built-in of the same id, which leaves the
    // built-in record `shadowed`. The presence scan reports the built-in first,
    // so the reported claimant is a row that is NOT what the installation runs —
    // presence is a gate, not a routing decision.
    layers: {
      user: [
        {
          id: SHADOWED_BUILT_IN_ID,
          name: 'Locally Overridden Specify',
          version: 2,
          instruction: 'Use the local house style.'
        }
      ],
      workspace: []
    },
    phaseId: SHADOWED_BUILT_IN_ID,
    presentIn: 'built-in',
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
