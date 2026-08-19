// Feature 085 T043/T044 — the confirmed package write, across both host commands.
//
// A package can write two catalogs, and two catalog writes cannot be one atomic
// operation (FR-042). Everything below follows from taking that seriously rather
// than pretending otherwise:
//
//   ordered      — Phases first, then the Pipeline (FR-038), so a Pipeline is
//                  never persisted ahead of a dependency this same import
//                  supplies. The order is checked BEHAVIORALLY, not just by the
//                  sequence of spy calls: the Pipeline save resolves its
//                  references against the effective Phase catalog, so reversing
//                  the two writes turns an accepted save into an
//                  `unknown-phase` rejection.
//   independent  — each write is reported on its own (FR-042), so a failed
//                  second write reports exactly what landed (FR-042a).
//   irreversible — a failed second write triggers NO compensating delete
//                  (FR-042c). Re-running the same document is the recovery
//                  (FR-042b), and it is self-healing because the landed Phases
//                  then plan `skip` and resolve the Pipeline's references.
//
// The plan-to-request translation is the webview's, and is pinned as pure logic
// in `webview-ui/src/components/__tests__/process-import-state.test.ts`. It is
// mirrored below rather than imported — the webview is a separate program —
// exactly as `phase-import-commit.test.ts` mirrors the single-Phase one. What
// this file asserts is that the two HOST commands compose over the shape the
// contract specifies.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));
vi.mock('../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/tmp/package-import' },
    name: 'package-import',
    index: 0
  })
}));

import { BUILT_IN_PHASES, BUILT_IN_PIPELINES } from '../../../src/config/pipeline-config';
import { resolvePipelineCatalog } from '../../../src/config/pipeline-catalog';
import { resolvePhaseCatalog } from '../../../src/config/process-catalog';
import { CMD_PREFLIGHT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  ImportPlan,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import type { PipelineDefinition } from '../../../src/contracts/pipeline-definitions';
import type { PhaseDefinition } from '../../../src/contracts/process-definitions';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';
import { handler as savePhasesHandler } from '../../../src/ui/sidebar/commands/cmd-save-phases';
import { handler as savePipelinesHandler } from '../../../src/ui/sidebar/commands/cmd-save-pipelines';
import { CMD_SAVE_PHASES, CMD_SAVE_PIPELINES } from '../../../src/ui/sidebar/messages';
import type { SavePhasesCommand, SavePipelinesCommand } from '../../../src/ui/sidebar/messages';

/** The one scope a package targets; a write never splits across scopes (FR-036). */
type Scope = 'user' | 'workspace';

/** The configuration key each layer write targets, and the order they occur in. */
type LayerKey = 'phases' | 'pipelines';

interface Layers {
  user: readonly unknown[];
  workspace: readonly unknown[];
}

/** Both writable catalogs, mutated in place by an accepted write. */
interface Installation {
  readonly phases: Layers;
  readonly pipelines: Layers;
}

function installation(seed: {
  readonly phases?: Partial<Layers>;
  readonly pipelines?: Partial<Layers>;
} = {}): Installation {
  return {
    phases: { user: seed.phases?.user ?? [], workspace: seed.phases?.workspace ?? [] },
    pipelines: { user: seed.pipelines?.user ?? [], workspace: seed.pipelines?.workspace ?? [] }
  };
}

/** The rows of both layers as the operator's preview saw them, for the proposal. */
interface Held {
  readonly phases: readonly unknown[];
  readonly pipelines: readonly unknown[];
}

function held(inst: Installation, scope: Scope): Held {
  return { phases: inst.phases[scope], pipelines: inst.pipelines[scope] };
}

const CORRELATION = 'package-import-1';

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    sanitize: (value: string) => value
  };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

function packageDocument(body: readonly string[]): string {
  return ['apiVersion: schegent/v1', 'kind: Pipeline', ...body, ''].join('\n');
}

/**
 * Self-contained: the root's every reference is supplied by the same document.
 * `specify` and `plan` are free ids — the built-ins are all `speckit-` prefixed —
 * so nothing here resolves by accident.
 */
const SELF_CONTAINED = packageDocument([
  'metadata:',
  '  id: ship-it',
  '  name: Ship It',
  '  version: 3',
  'spec:',
  '  phaseIds:',
  '    - specify',
  '    - plan',
  '  inputs:',
  '    - portId: feature-brief',
  '      label: Feature brief',
  '      type: text',
  '      required: true',
  '  bindings:',
  '    - kind: input',
  '      phaseIndex: 0',
  '      inputKey: brief',
  '      source:',
  '        from: pipeline-input',
  '        portId: feature-brief',
  'included:',
  '  phases:',
  '    - metadata:',
  '        phaseId: specify',
  '        name: Specify',
  '        version: 2',
  '      spec:',
  '        instruction: Write the spec.',
  '    - metadata:',
  '        phaseId: plan',
  '        name: Plan',
  '        version: 5',
  '      spec:',
  '        instruction: Write the plan.'
]);

/**
 * The root references a Phase this document does not supply and no layer holds,
 * so the root is `blocked` while the one included Phase stays eligible (FR-039).
 */
const BLOCKED_ROOT = packageDocument([
  'metadata:',
  '  id: ship-it',
  '  name: Ship It',
  '  version: 3',
  'spec:',
  '  phaseIds:',
  '    - specify',
  '    - polish',
  'included:',
  '  phases:',
  '    - metadata:',
  '        phaseId: specify',
  '        name: Specify',
  '        version: 2',
  '      spec:',
  '        instruction: Write the spec.'
]);

const HELD_PHASE = Object.freeze({
  id: 'held',
  name: 'Held',
  version: 4,
  instruction: 'Hold.'
});

const HELD_PIPELINE = Object.freeze({
  // Feature 098 (T080) — the held Pipeline used to name `speckit-specify`, which
  // resolved out of the built-in Phase layer. That layer is empty, so it names the
  // held Phase instead: every installation below that holds this Pipeline holds
  // that Phase in the same scope. The row has to stay valid, because the point of
  // "held" is that an import leaves it standing — an invalid row would be rejected
  // by the write gate and the case would report a validation failure instead.
  id: 'held-pipeline',
  name: 'Held Pipeline',
  version: 2,
  phases: ['held']
});

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

async function planFor(inst: Installation, text: string): Promise<ImportPlan> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      readPhaseConfig: () => inst.phases,
      readPipelineConfig: () => inst.pipelines,
      openProcessYamlDocument: async () => ({
        outcome: 'read' as const,
        bytes: new Uint8Array(Buffer.from(text, 'utf8'))
      }),
      audit: { append: async () => undefined },
      logger: logger()
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: CORRELATION
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const command: PreflightProcessYamlCommand = {
    type: CMD_PREFLIGHT_PROCESS_YAML,
    correlationId: CORRELATION,
    payload: {}
  };
  await preflightHandler(ctx, command);
  expect(acks).toHaveLength(1);
  const result = acks[0]!.result as PreflightProcessYamlResult;
  expect(result.outcome).toBe('planned');
  if (result.outcome !== 'planned') throw new Error('unreachable');
  return result.plan;
}

// ---------------------------------------------------------------------------
// Commit — the webview's translation, mirrored
// ---------------------------------------------------------------------------

/** Only `import` rows are written; `skip`, `blocked`, and `invalid` are not (FR-037). */
function importedPhases(plan: ImportPlan): readonly PhaseDefinition[] {
  const definitions: PhaseDefinition[] = [];
  for (const row of plan.rows) {
    if (row.outcome === 'import' && row.resourceKind === 'phase') definitions.push(row.definition);
  }
  return definitions;
}

function importedPipelines(plan: ImportPlan): readonly PipelineDefinition[] {
  const definitions: PipelineDefinition[] = [];
  for (const row of plan.rows) {
    if (row.outcome === 'import' && row.resourceKind === 'pipeline') {
      definitions.push(row.definition);
    }
  }
  return definitions;
}

function phaseRow(definition: PhaseDefinition): Record<string, unknown> {
  const { phaseId, ...declared } = definition;
  return { id: phaseId, ...declared };
}

function pipelineRow(definition: PipelineDefinition): Record<string, unknown> {
  const { pipelineId, phaseIds, ...declared } = definition;
  return { id: pipelineId, phases: [...phaseIds], ...declared };
}

/**
 * One attempted layer write. Appending the added rows is what makes the
 * positional shape check pass: deleting them from the proposal reproduces the
 * layer the operator's preview described, in order.
 */
interface Attempt {
  readonly key: LayerKey;
  readonly command: SavePhasesCommand | SavePipelinesCommand;
}

function attemptsFor(plan: ImportPlan, scope: Scope, layers: Held): readonly Attempt[] {
  const attempts: Attempt[] = [];
  const phases = importedPhases(plan);
  const pipelines = importedPipelines(plan);

  // FR-038 — the Phase attempt is built and run first, unconditionally.
  if (phases.length > 0) {
    attempts.push({
      key: 'phases',
      command: {
        type: CMD_SAVE_PHASES,
        correlationId: CORRELATION,
        payload: {
          scope,
          expectedRevision: plan.computedAgainstRevision[scope],
          mutation: {
            kind: 'import-package',
            phaseIds: phases.map((definition) => definition.phaseId)
          },
          phases: [...layers.phases, ...phases.map(phaseRow)]
        }
      }
    });
  }

  if (pipelines.length > 0) {
    // FR-043 — the Pipeline layer carries ITS OWN revision, not the Phase
    // layer's. A single revision could not gate two independently mutable
    // layers, and using the live one at confirm time would defeat FR-040.
    const revisions = plan.computedAgainstPipelineRevision;
    expect(revisions).toBeDefined();
    attempts.push({
      key: 'pipelines',
      command: {
        type: CMD_SAVE_PIPELINES,
        correlationId: CORRELATION,
        payload: {
          scope,
          expectedRevision: revisions![scope],
          mutation: {
            kind: 'import-package',
            pipelineIds: pipelines.map((definition) => definition.pipelineId)
          },
          pipelines: [...layers.pipelines, ...pipelines.map(pipelineRow)]
        }
      }
    });
  }

  return attempts;
}

interface LayerResult {
  readonly key: LayerKey;
  readonly ack: CommandAckMessage;
}

interface CommitRun {
  /** Configuration keys actually written, in the order `updateConfig` saw them. */
  readonly writes: readonly LayerKey[];
  readonly results: readonly LayerResult[];
  readonly outcome: 'imported' | 'partial' | 'failed';
}

/**
 * The webview's outcome rule, mirrored (FR-042a): the import is never reported
 * as wholly succeeded or wholly failed when it was neither.
 */
function outcomeOf(results: readonly LayerResult[]): CommitRun['outcome'] {
  const accepted = results.filter((result) => result.ack.status === 'accepted').length;
  if (accepted === results.length) return 'imported';
  return accepted === 0 ? 'failed' : 'partial';
}

async function commitPackage(
  inst: Installation,
  plan: ImportPlan,
  scope: Scope,
  layers: Held,
  opts: { readonly failOn?: LayerKey } = {}
): Promise<CommitRun> {
  const writes: LayerKey[] = [];
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      readPhaseConfig: () => inst.phases,
      readPipelineConfig: () => inst.pipelines,
      readConfig: () => undefined,
      updateConfig: async (key: string, value: unknown, target: Scope) => {
        expect(key === 'phases' || key === 'pipelines').toBe(true);
        writes.push(key as LayerKey);
        if (opts.failOn === key) throw new Error('EACCES: settings.json is read-only');
        const layer = key === 'phases' ? inst.phases : inst.pipelines;
        layer[target] = value as readonly unknown[];
      },
      executeCommand: vi.fn(),
      queueRemover: { remove: vi.fn() },
      audit: { append: async () => undefined },
      logger: logger()
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: CORRELATION
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const results: LayerResult[] = [];
  for (const attempt of attemptsFor(plan, scope, layers)) {
    if (attempt.key === 'phases') {
      await savePhasesHandler(ctx, attempt.command as SavePhasesCommand);
    } else {
      await savePipelinesHandler(ctx, attempt.command as SavePipelinesCommand);
    }
    const ack = acks[acks.length - 1];
    expect(ack).toBeDefined();
    results.push({ key: attempt.key, ack: ack! });
    // A rejected write stops the sequence. The ordering exists so the Pipeline
    // never lands without its Phases; carrying on past a failed Phase write
    // would be exactly that.
    if (ack!.status !== 'accepted') break;
  }

  return { writes, results, outcome: outcomeOf(results) };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function effectivePhaseIds(inst: Installation): readonly string[] {
  return resolvePhaseCatalog({
    builtIn: BUILT_IN_PHASES,
    user: inst.phases.user,
    workspace: inst.phases.workspace
  }).effective.map((definition) => definition.phaseId);
}

function effectivePipelineIds(inst: Installation): readonly string[] {
  const phases = resolvePhaseCatalog({
    builtIn: BUILT_IN_PHASES,
    user: inst.phases.user,
    workspace: inst.phases.workspace
  }).effective;
  return resolvePipelineCatalog({
    builtIn: BUILT_IN_PIPELINES,
    user: inst.pipelines.user,
    workspace: inst.pipelines.workspace,
    phaseCatalog: phases
  }).effective.map((definition) => definition.pipelineId);
}

function snapshot(inst: Installation, scope: Scope): string {
  return JSON.stringify({ phases: inst.phases[scope], pipelines: inst.pipelines[scope] });
}

beforeEach(() => capabilities.clear());

describe('Feature 085 T043 — the ordered two-layer write', () => {
  it('writes only the `import` rows, leaving `skip` untouched (FR-037)', async () => {
    // `specify` is already held, so it plans `skip` and stays at the version the
    // host holds — a skip is not a write, and not an overwrite either.
    const inst = installation({
      phases: { workspace: [HELD_PHASE, { id: 'specify', name: 'Mine', version: 7, instruction: 'Mine.' }] }
    });
    const plan = await planFor(inst, SELF_CONTAINED);
    expect(plan.counts).toEqual({ import: 2, skip: 1, blocked: 0, invalid: 0 });

    const run = await commitPackage(inst, plan, 'workspace', held(inst, 'workspace'));

    expect(run.outcome).toBe('imported');
    expect(inst.phases.workspace).toEqual([
      HELD_PHASE,
      { id: 'specify', name: 'Mine', version: 7, instruction: 'Mine.' },
      { id: 'plan', name: 'Plan', version: 5, instruction: 'Write the plan.' }
    ]);
    // The declared version survives the write it arrived on (FR-044).
    expect(inst.pipelines.workspace).toEqual([
      expect.objectContaining({ id: 'ship-it', version: 3, phases: ['specify', 'plan'] })
    ]);
  });

  it('writes the Phase layer before the Pipeline layer (FR-038)', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan, 'user', held(inst, 'user'));

    expect(run.writes).toEqual(['phases', 'pipelines']);
    expect(run.results.map((result) => result.ack.status)).toEqual(['accepted', 'accepted']);
    expect(run.outcome).toBe('imported');
  });

  it('accepts the Pipeline only because its Phases already landed (FR-038)', async () => {
    // The behavioral half of the ordering rule. The Pipeline save resolves
    // references against the EFFECTIVE Phase catalog, so this same command sent
    // first is a rejection rather than a save — which is what makes the order a
    // correctness rule and not a preference.
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    expect(effectivePhaseIds(inst)).not.toContain('specify');

    const reversed = await commitPackage(
      installation(),
      plan,
      'user',
      { phases: [], pipelines: [] },
      // Nothing is written, so the Phase attempt cannot have run first.
      { failOn: 'phases' }
    );
    expect(reversed.outcome).toBe('failed');
    expect(reversed.writes).toEqual(['phases']);

    const run = await commitPackage(inst, plan, 'user', held(inst, 'user'));
    expect(run.outcome).toBe('imported');
    expect(effectivePhaseIds(inst)).toEqual(expect.arrayContaining(['specify', 'plan']));
    expect(effectivePipelineIds(inst)).toContain('ship-it');
  });

  it('writes the eligible Phase even though the Pipeline is blocked (FR-039)', async () => {
    const inst = installation();
    const plan = await planFor(inst, BLOCKED_ROOT);
    expect(plan.counts).toEqual({ import: 1, skip: 0, blocked: 1, invalid: 0 });

    const run = await commitPackage(inst, plan, 'workspace', held(inst, 'workspace'));

    // A blocked row is not a failed write — it was never eligible, so there is
    // no Pipeline attempt at all and nothing partial about the outcome.
    expect(run.writes).toEqual(['phases']);
    expect(run.outcome).toBe('imported');
    expect(effectivePhaseIds(inst)).toContain('specify');
    expect(inst.pipelines.workspace).toEqual([]);
    const blocked = plan.rows.find((row) => row.outcome === 'blocked');
    expect(blocked).toMatchObject({
      resourceKind: 'pipeline',
      resourceId: 'ship-it',
      reason: { code: 'dependency-absent', dependency: { kind: 'phase', resourceId: 'polish' } }
    });
  });

  it('refuses both layers when the Phase layer changed since preflight (FR-040)', async () => {
    const inst = installation({ phases: { workspace: [HELD_PHASE] } });
    const plan = await planFor(inst, SELF_CONTAINED);
    const layers = held(inst, 'workspace');

    // Someone else writes the Phase layer between the preview and the confirm.
    inst.phases.workspace = [HELD_PHASE, { id: 'landed', name: 'Landed', version: 1, instruction: 'First.' }];
    const before = snapshot(inst, 'workspace');

    const run = await commitPackage(inst, plan, 'workspace', layers);

    expect(run.results.map((result) => result.ack.status)).toEqual(['rejected']);
    expect(run.results[0]?.ack).toMatchObject({ reason: 'stale-catalog' });
    expect(run.outcome).toBe('failed');
    expect(run.writes).toEqual([]);
    expect(snapshot(inst, 'workspace')).toBe(before);
  });

  it('refuses the Pipeline layer alone when only it changed since preflight (FR-040)', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    const layers = held(inst, 'user');

    // The two layers have independent revisions, so a concurrent Pipeline write
    // must stop the Pipeline half without pretending the Phase half is stale.
    inst.pipelines.user = [HELD_PIPELINE];

    const run = await commitPackage(inst, plan, 'user', layers);

    expect(run.writes).toEqual(['phases']);
    expect(run.results.map((result) => [result.key, result.ack.status])).toEqual([
      ['phases', 'accepted'],
      ['pipelines', 'rejected']
    ]);
    expect(run.results[1]?.ack).toMatchObject({ reason: 'stale-catalog' });
    expect(run.outcome).toBe('partial');
    expect(effectivePhaseIds(inst)).toEqual(expect.arrayContaining(['specify', 'plan']));
    expect(inst.pipelines.user).toEqual([HELD_PIPELINE]);
  });

  it('reports staleness rather than the denied capability (FR-041)', async () => {
    // Both gates would fire. The operator is told the one that is actionable:
    // the preview no longer describes the catalog, so re-running the preflight
    // is the next step whether or not the capability is ever granted.
    capabilities.set('phases', false);
    const inst = installation({ phases: { workspace: [HELD_PHASE] } });
    const plan = await planFor(inst, SELF_CONTAINED);
    const layers = held(inst, 'workspace');
    inst.phases.workspace = [HELD_PHASE, { id: 'landed', name: 'Landed', version: 1, instruction: 'First.' }];

    const run = await commitPackage(inst, plan, 'workspace', layers);

    expect(run.results[0]?.ack).toMatchObject({ status: 'rejected', reason: 'stale-catalog' });
    expect(run.writes).toEqual([]);
  });

  it('reports staleness rather than the denied capability on the Pipeline layer (FR-041)', async () => {
    capabilities.set('pipelineOverrides', false);
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    const layers = held(inst, 'user');
    inst.pipelines.user = [HELD_PIPELINE];

    const run = await commitPackage(inst, plan, 'user', layers);

    expect(run.results[1]?.ack).toMatchObject({ status: 'rejected', reason: 'stale-catalog' });
    expect(run.writes).toEqual(['phases']);
  });
});

describe('Feature 085 T044 — a failed second write is partial, and stays partial', () => {
  it('leaves the Phases written and reports the outcome as partial (FR-042a)', async () => {
    const inst = installation({ phases: { workspace: [HELD_PHASE] } });
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan, 'workspace', held(inst, 'workspace'), {
      failOn: 'pipelines'
    });

    expect(run.outcome).toBe('partial');
    expect(run.results.map((result) => [result.key, result.ack.status])).toEqual([
      ['phases', 'accepted'],
      ['pipelines', 'rejected']
    ]);
    expect(run.results[1]?.ack).toMatchObject({ reason: 'persistence-failed' });
    // Exactly which resources landed is observable, which is what FR-042a asks
    // the surface to report: the two Phases did, the Pipeline did not.
    expect(effectivePhaseIds(inst)).toEqual(expect.arrayContaining(['specify', 'plan']));
    expect(effectivePipelineIds(inst)).not.toContain('ship-it');
  });

  it('triggers no compensating delete of the Phases that landed (FR-042c)', async () => {
    const inst = installation({ phases: { workspace: [HELD_PHASE] } });
    const plan = await planFor(inst, SELF_CONTAINED);

    const run = await commitPackage(inst, plan, 'workspace', held(inst, 'workspace'), {
      failOn: 'pipelines'
    });

    // Two attempts, two writes, and no third. Removing a resource the operator
    // never confirmed removing is a destructive write in its own right, and it
    // can destroy a concurrent edit.
    expect(run.writes).toEqual(['phases', 'pipelines']);
    expect(inst.phases.workspace).toEqual([
      HELD_PHASE,
      { id: 'specify', name: 'Specify', version: 2, instruction: 'Write the spec.' },
      { id: 'plan', name: 'Plan', version: 5, instruction: 'Write the plan.' }
    ]);
  });

  it('is recovered by re-running the same document, with no manual cleanup (FR-042b)', async () => {
    const inst = installation({ phases: { workspace: [HELD_PHASE] } });
    const first = await planFor(inst, SELF_CONTAINED);
    await commitPackage(inst, first, 'workspace', held(inst, 'workspace'), { failOn: 'pipelines' });

    // The same bytes, nothing edited, nothing removed by hand.
    const second = await planFor(inst, SELF_CONTAINED);

    // The landed Phases are present, so they plan `skip` — and a `skip` resolves
    // the root's references (FR-034), which is precisely why re-running heals.
    expect(second.counts).toEqual({ import: 1, skip: 2, blocked: 0, invalid: 0 });
    expect(
      second.rows.filter((row) => row.outcome === 'skip').map((row) => row.resourceId)
    ).toEqual(['specify', 'plan']);

    const run = await commitPackage(inst, second, 'workspace', held(inst, 'workspace'));

    expect(run.writes).toEqual(['pipelines']);
    expect(run.outcome).toBe('imported');
    expect(effectivePipelineIds(inst)).toContain('ship-it');
    // The Phases were not rewritten, so the versions the first run stored stand.
    expect(inst.phases.workspace).toEqual([
      HELD_PHASE,
      { id: 'specify', name: 'Specify', version: 2, instruction: 'Write the spec.' },
      { id: 'plan', name: 'Plan', version: 5, instruction: 'Write the plan.' }
    ]);
  });
});

// ---------------------------------------------------------------------------
// Feature 085 T052 — an import removes nothing, so it confirms nothing (FR-054)
// ---------------------------------------------------------------------------
//
// Every other mutating catalog action has a confirmation because it can destroy
// work: `catalog.remove-phase` and `catalog.remove-pipeline` erase a row, and
// `workspace.reset` erases a layer. Import has none, and FR-054 states the reason
// rather than the policy — it never removes or replaces an existing resource.
//
// So this pins the reason, not just the absence. The registry check alone would
// pass just as well on an import that silently overwrote a held row; what makes
// the missing gate CORRECT is that a write only ever appends, and a resource the
// host already holds plans `skip` (FR-030) and is left exactly as authored.

const IMPORT_PATH_COMMANDS: readonly string[] = [
  'CMD_PREFLIGHT_PROCESS_YAML',
  'CMD_SAVE_PHASES',
  'CMD_SAVE_PIPELINES'
];

describe('Feature 085 T052 — import registers no destructive-action confirmation (FR-054)', () => {
  it('names no import-path command in the destructive-command set', () => {
    // Read as text rather than imported: these are the two hand-maintained
    // tables the `useConfirm` gate is derived from, and the assertion is about
    // what they LIST. `tests/lint/destructive-actions.lint.test.ts` enforces the
    // gate over that list; this enforces that import stays off it.
    const lint = readFileSync(
      resolve(__dirname, '..', '..', 'lint', 'destructive-actions.lint.test.ts'),
      'utf8'
    );
    const listed = lint.slice(
      lint.indexOf('const DESTRUCTIVE_COMMANDS'),
      lint.indexOf('];', lint.indexOf('const DESTRUCTIVE_COMMANDS'))
    );
    for (const command of IMPORT_PATH_COMMANDS) expect(listed).not.toContain(command);
  });

  it('declares no confirmation copy for an import action', () => {
    // An `ActionKey` is the handle a confirmation is registered under. No import
    // key exists, so there is nothing for a call site to await — the gate cannot
    // be added by accident, only deliberately and with copy to match.
    const copy = readFileSync(
      resolve(__dirname, '..', '..', '..', 'webview-ui', 'src', 'lib', 'action-copy.ts'),
      'utf8'
    );
    const keys = copy.slice(copy.indexOf('export type ActionKey'), copy.indexOf(';', copy.indexOf('export type ActionKey')));
    expect(keys).toContain("'catalog.remove-phase'");
    expect(keys.toLowerCase()).not.toContain('import');
    expect(keys.toLowerCase()).not.toContain('exchange');
  });

  it('appends to the target layer and rewrites nothing that was there', async () => {
    const MINE = Object.freeze({ id: 'mine', name: 'Mine', version: 9, instruction: 'Mine.' });
    const inst = installation({
      phases: { workspace: [HELD_PHASE, MINE] },
      pipelines: { workspace: [HELD_PIPELINE] }
    });
    const before = JSON.parse(snapshot(inst, 'workspace')) as {
      phases: readonly unknown[];
      pipelines: readonly unknown[];
    };

    const plan = await planFor(inst, SELF_CONTAINED);
    const run = await commitPackage(inst, plan, 'workspace', held(inst, 'workspace'));
    expect(run.outcome).toBe('imported');

    // Each layer is its prior contents, in order, followed by the imported rows.
    // Positional, because a row that moved is a row some other reader's index
    // now points past.
    expect(inst.phases.workspace.slice(0, before.phases.length)).toEqual(before.phases);
    expect(inst.pipelines.workspace.slice(0, before.pipelines.length)).toEqual(before.pipelines);
    expect(inst.phases.workspace.length).toBe(before.phases.length + 2);
    expect(inst.pipelines.workspace.length).toBe(before.pipelines.length + 1);
  });

  it('leaves a resource the host already holds exactly as its author wrote it', async () => {
    // The document declares `specify` at version 2 with its own instruction. The
    // host holds a different `specify`. The held one is what an operator would
    // lose if import replaced rather than skipped, so it is the case worth
    // pinning: nothing about it changes, not even its position.
    const AUTHORED = Object.freeze({
      id: 'specify',
      name: 'My Specify',
      version: 41,
      instruction: 'Mine, not the document.'
    });
    const inst = installation({ phases: { workspace: [AUTHORED, HELD_PHASE] } });

    const plan = await planFor(inst, SELF_CONTAINED);
    expect(plan.counts).toEqual({ import: 2, skip: 1, blocked: 0, invalid: 0 });

    await commitPackage(inst, plan, 'workspace', held(inst, 'workspace'));

    expect(inst.phases.workspace[0]).toEqual(AUTHORED);
    expect(inst.phases.workspace.filter((row) => (row as { id: string }).id === 'specify')).toEqual([
      AUTHORED
    ]);
  });

  it('touches neither the other scope nor the layer it was not addressed to', async () => {
    const inst = installation({
      phases: { user: [HELD_PHASE], workspace: [] },
      pipelines: { user: [HELD_PIPELINE], workspace: [] }
    });
    const untouched = snapshot(inst, 'user');

    const plan = await planFor(inst, SELF_CONTAINED);
    await commitPackage(inst, plan, 'workspace', held(inst, 'workspace'));

    expect(snapshot(inst, 'user')).toBe(untouched);
  });

  it('removes nothing when the second write fails, so recovery needs no undo (FR-042c)', async () => {
    // The other half of why no confirmation is owed: the failure mode is a
    // partial APPEND, never a partial delete. Re-running the same document is
    // the recovery (FR-042b, pinned in T044 above), and it needs no permission
    // to destroy anything because there is nothing to destroy.
    const inst = installation({ phases: { workspace: [HELD_PHASE] } });
    const before = [...inst.phases.workspace];

    const plan = await planFor(inst, SELF_CONTAINED);
    const run = await commitPackage(inst, plan, 'workspace', held(inst, 'workspace'), {
      failOn: 'pipelines'
    });

    expect(run.outcome).toBe('partial');
    expect(inst.phases.workspace.slice(0, before.length)).toEqual(before);
    expect(inst.pipelines.workspace).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Feature 085 T058 — what the import leaves behind (FR-045, FR-046)
// ---------------------------------------------------------------------------
//
// FR-045: the document is a one-time input, not a source the catalog reads from.
// The catalog has exactly three layers, and a fourth one that happened to be a
// file on someone's disk would be a source no other installation has — a Pipeline
// that resolves here and nowhere else.
//
// FR-046: what import writes is a catalog row like any other. It goes through
// the same save command, the same layer validation, and the same cross-reference
// resolution an operator's own edit does — so an imported Pipeline cannot be
// valid in a way an authored one could not be, and cannot be invalid in a way
// the catalog would fail to notice.

describe('Feature 085 T058 — an import is not a catalog source (FR-045)', () => {
  it('reads the document once, and never again', async () => {
    let opens = 0;
    const inst = installation();
    const acks: CommandAckMessage[] = [];
    const ctx = {
      deps: {
        readPhaseConfig: () => inst.phases,
        readPipelineConfig: () => inst.pipelines,
        openProcessYamlDocument: async () => {
          opens += 1;
          return {
            outcome: 'read' as const,
            bytes: new Uint8Array(Buffer.from(SELF_CONTAINED, 'utf8'))
          };
        },
        audit: { append: async () => undefined },
        logger: logger()
      },
      postAck: async (msg: CommandAckMessage) => {
        acks.push(msg);
        return true;
      },
      correlationId: CORRELATION
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await preflightHandler(ctx, {
      type: CMD_PREFLIGHT_PROCESS_YAML,
      correlationId: CORRELATION,
      payload: {}
    } as PreflightProcessYamlCommand);
    expect(opens).toBe(1);

    const result = acks[0]!.result as PreflightProcessYamlResult;
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;

    // The commit is driven entirely by the plan. If the document were a source,
    // the write would need to consult it again.
    await commitPackage(inst, result.plan, 'workspace', held(inst, 'workspace'));
    expect(opens).toBe(1);
    expect(effectivePipelineIds(inst)).toContain('ship-it');
  });

  it('survives the document changing underneath it after the commit', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    await commitPackage(inst, plan, 'workspace', held(inst, 'workspace'));
    const after = snapshot(inst, 'workspace');

    // A later read of a document that now says something else must be
    // impossible, not merely unlikely: resolve the catalog again and see the
    // same rows. Nothing here has a handle on the file to re-read.
    await planFor(inst, BLOCKED_ROOT);
    expect(snapshot(inst, 'workspace')).toBe(after);
    expect(effectivePipelineIds(inst)).toContain('ship-it');
  });

  it('stores no trace of where the resource came from', async () => {
    // FR-050 forbids a path crossing the boundary at all; this is the storage
    // end of the same rule. A row that named its origin would also be a row
    // whose contents differ between two operators who imported the same bytes.
    //
    // Asserted on the key set rather than by scanning for suspicious words:
    // `source` is legitimate binding vocabulary, so a word list would either
    // miss a real origin field or fire on a real binding.
    //
    // The claim is one-directional — import ADDS nothing. The catalog's own
    // normalization drops an optional array that came out empty, which is why
    // this is a subset check and not deep equality: subtraction by a rule the
    // catalog applies to every row is not a trace of anything.
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    await commitPackage(inst, plan, 'workspace', held(inst, 'workspace'));

    const addsNothing = (stored: readonly unknown[], declared: readonly Record<string, unknown>[]) => {
      expect(stored).toHaveLength(declared.length);
      stored.forEach((row, index) => {
        const expected = declared[index]!;
        for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
          expect(Object.keys(expected)).toContain(key);
          expect(value).toEqual(expected[key]);
        }
      });
    };

    addsNothing(inst.phases.workspace, importedPhases(plan).map(phaseRow));
    addsNothing(inst.pipelines.workspace, importedPipelines(plan).map(pipelineRow));
  });
});

describe('Feature 085 T058 — an imported Pipeline is a catalog row like any other (FR-046)', () => {
  it('resolves as effective, with the definition the document declared', async () => {
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    await commitPackage(inst, plan, 'workspace', held(inst, 'workspace'));

    const resolved = resolvePipelineCatalog({
      builtIn: BUILT_IN_PIPELINES,
      user: inst.pipelines.user,
      workspace: inst.pipelines.workspace,
      phaseCatalog: resolvePhaseCatalog({
        builtIn: BUILT_IN_PHASES,
        user: inst.phases.user,
        workspace: inst.phases.workspace
      }).effective
    });

    const record = resolved.records.find((row) => row.pipelineId === 'ship-it');
    expect(record?.status).toBe('effective');
    expect(record?.errors).toEqual([]);
    expect(resolved.effective.find((row) => row.pipelineId === 'ship-it')).toMatchObject({
      pipelineId: 'ship-it',
      name: 'Ship It',
      version: 3,
      phaseIds: ['specify', 'plan']
    });
  });

  it('is refused by the same validation an authored row is, not a lenient one', async () => {
    // A binding naming a port the Pipeline does not declare. Preflight plans the
    // row — the document is well formed — and the save command applies the same
    // cross-reference gate it applies to an operator's own edit. Import is not a
    // way around the catalog's rules.
    //
    // The Phases are seeded so this isolates the binding gate: with the layer
    // empty, `unknown-phase` would fire first and the binding defect would go
    // unobserved even though the save still failed.
    const seed = installation();
    const plan = await planFor(seed, SELF_CONTAINED);
    const inst = installation({
      phases: { workspace: importedPhases(plan).map(phaseRow) }
    });
    const [pipeline] = importedPipelines(plan);
    expect(pipeline).toBeDefined();

    const acks: CommandAckMessage[] = [];
    const ctx = {
      deps: {
        readPhaseConfig: () => inst.phases,
        readPipelineConfig: () => inst.pipelines,
        readConfig: () => undefined,
        updateConfig: async () => {
          throw new Error('a rejected save must not reach a write');
        },
        executeCommand: vi.fn(),
        queueRemover: { remove: vi.fn() },
        audit: { append: async () => undefined },
        logger: logger()
      },
      postAck: async (msg: CommandAckMessage) => {
        acks.push(msg);
        return true;
      },
      correlationId: CORRELATION
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const broken = {
      ...pipelineRow(pipeline!),
      bindings: [
        {
          kind: 'input',
          phaseIndex: 0,
          inputKey: 'brief',
          source: { from: 'pipeline-input', portId: 'no-such-port' }
        }
      ]
    };

    await savePipelinesHandler(ctx, {
      type: CMD_SAVE_PIPELINES,
      correlationId: CORRELATION,
      payload: {
        scope: 'workspace',
        expectedRevision: plan.computedAgainstPipelineRevision!.workspace,
        mutation: { kind: 'import-package', pipelineIds: ['ship-it'] },
        pipelines: [broken]
      }
    } as SavePipelinesCommand);

    expect(acks).toHaveLength(1);
    expect(acks[0]!.status).toBe('rejected');
    expect(acks[0]!.reason).toBe('pipeline-validation');
    // The specific defect, not just the reason class: a coarse code alone would
    // pass on a rejection that happened for some unrelated reason.
    expect(acks[0]!.result).toMatchObject({
      errors: [{ pipelineId: 'ship-it', code: 'binding-unknown-input-port' }],
      total: 1
    });
    expect(inst.pipelines.workspace).toEqual([]);
  });

  it('is refused when its Phases are not there, exactly as an authored row would be', async () => {
    // The other half of FR-046, and the reason FR-038 orders the two writes: a
    // Pipeline whose Phases have not landed does not resolve. Writing the
    // Pipeline layer alone reproduces the reversed order and must fail.
    const inst = installation();
    const plan = await planFor(inst, SELF_CONTAINED);
    const [pipeline] = importedPipelines(plan);

    const acks: CommandAckMessage[] = [];
    const ctx = {
      deps: {
        readPhaseConfig: () => inst.phases,
        readPipelineConfig: () => inst.pipelines,
        readConfig: () => undefined,
        updateConfig: async () => {
          throw new Error('a rejected save must not reach a write');
        },
        executeCommand: vi.fn(),
        queueRemover: { remove: vi.fn() },
        audit: { append: async () => undefined },
        logger: logger()
      },
      postAck: async (msg: CommandAckMessage) => {
        acks.push(msg);
        return true;
      },
      correlationId: CORRELATION
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await savePipelinesHandler(ctx, {
      type: CMD_SAVE_PIPELINES,
      correlationId: CORRELATION,
      payload: {
        scope: 'workspace',
        expectedRevision: plan.computedAgainstPipelineRevision!.workspace,
        mutation: { kind: 'import-package', pipelineIds: ['ship-it'] },
        pipelines: [pipelineRow(pipeline!)]
      }
    } as SavePipelinesCommand);

    expect(acks[0]!.status).toBe('rejected');
    expect(acks[0]!.reason).toBe('pipeline-validation');
    const detail = acks[0]!.result as { readonly errors: readonly { readonly code: string }[] };
    expect(detail.errors.map((error) => error.code)).toContain('unknown-phase');
    expect(JSON.stringify(detail.errors)).toContain('specify');
  });
});
