// Feature 098 (T059, US5, FR-037, FR-038, SC-017) — what an operator gets from
// the shipped examples alone.
//
// This is the defect FR-R3-014 exists to fix, stated as an assertion. Before the
// built-in layers were emptied, `import-planner.ts` skipped any id already
// claimed in ANY layer including built-in, so these same two documents planned
// sixteen `skip` rows and zero writes: the import UI was the only route in and it
// wrote nothing. Every row below now plans `import`, and the effective catalogs
// after the commit are non-empty.
//
// The documents are read from `repo/examples/` rather than inlined. Inlining
// would assert that a copy of the examples imports, which is not the claim — the
// claim is about the files that ship in the VSIX. `check-vsix-smoke.mjs` (T063)
// enumerates the same directory, so a document added here is covered by both
// without either being edited.
//
// SCOPE (recorded deviation, 2026-08-19): the task text says "all three Pipelines
// plus at least one Workflow composing them". The operator's standing decision is
// that `repo/examples/` is good as it stands — no `dev-new-feature` Pipeline
// (T060) and no example Workflow (T061) are authored — so the Workflow half of
// the claim has no subject and is not asserted here. What survives is the half
// that carries the feature: the shipped documents import onto an EMPTY catalog
// and are the sole source of everything the operator can then run.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import * as path from 'path';

const capabilities = vi.hoisted(() => new Map<string, boolean>());
vi.mock('../../../src/state/capability-trust-resolver', () => ({
  isCapabilityAllowed: (name: string) => capabilities.get(name) ?? true,
  getResolvedScope: () => 'workspace-trust'
}));
vi.mock('../../../src/state/workspace-folder-picker', () => ({
  getCanonicalWorkspaceRoot: () => ({
    uri: { fsPath: '/tmp/examples-coverage' },
    name: 'examples-coverage',
    index: 0
  })
}));

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
import { FakeCatalogStore } from '../../fixtures/fake-catalog-store';
import type { SavePhasesCommand, SavePipelinesCommand } from '../../../src/ui/sidebar/messages';

const EXAMPLES_DIR = path.resolve(__dirname, '../../../examples');
const CORRELATION = 'examples-coverage-1';

/** Every document that ships, discovered rather than listed (FR-041). */
const EXAMPLES: readonly string[] = readdirSync(EXAMPLES_DIR)
  .filter((name) => name.endsWith('.yaml'))
  .sort();

const readExample = (name: string): string =>
  readFileSync(path.join(EXAMPLES_DIR, name), 'utf8');

/** The `kind:` a document declares, read off the root as the reader does. */
function kindOf(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.startsWith('kind:'));
  return line === undefined ? '' : line.slice('kind:'.length).trim();
}

const PIPELINE_EXAMPLES = EXAMPLES.filter((name) => kindOf(readExample(name)) === 'Pipeline');

function logger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    sanitize: (value: string) => value
  };
}

/**
 * The catalogs an accepted write mutates. Seeded empty on purpose: a fresh
 * install holds nothing, and with the built-in layers gone (FR-018) that is the
 * whole catalog the operator starts from.
 *
 * Feature 099 (T496f, FR-041/FR-042) — the definitions moved out of settings
 * into the store, and the layer pair collapsed with them, so the installation is
 * the store itself rather than three per-layer arrays.
 */
interface Installation {
  readonly store: FakeCatalogStore;
}

const emptyInstallation = (): Installation => ({ store: new FakeCatalogStore() });

/** The `{ rows, revision }` seams every handler in this file reads through. */
function readDeps(inst: Installation) {
  return {
    readPhaseConfig: () => ({
      rows: inst.store.rowsOf('phase'),
      revision: inst.store.revisionOf('phase')
    }),
    readPipelineConfig: () => ({
      rows: inst.store.rowsOf('pipeline'),
      revision: inst.store.revisionOf('pipeline')
    }),
    readWorkflowConfig: () => ({
      rows: inst.store.rowsOf('workflow'),
      revision: inst.store.revisionOf('workflow')
    })
  };
}

async function planFor(inst: Installation, text: string): Promise<ImportPlan> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      ...readDeps(inst),
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

function imported<T>(plan: ImportPlan, kind: 'phase' | 'pipeline'): readonly T[] {
  const definitions: T[] = [];
  for (const row of plan.rows) {
    if (row.outcome === 'import' && row.resourceKind === kind) {
      definitions.push(row.definition as T);
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
 * Commit one planned document, Phases before Pipelines (FR-038/FR-045), through
 * the real handlers. Nothing is stubbed at the write gate: a Pipeline whose
 * Phases had not landed would be rejected here rather than silently accepted.
 */
async function commit(inst: Installation, plan: ImportPlan): Promise<readonly string[]> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      ...readDeps(inst),
      catalogStore: inst.store,
      refreshCatalog: async () => undefined,
      readConfig: () => undefined,
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

  const phases = imported<PhaseDefinition>(plan, 'phase');
  if (phases.length > 0) {
    await savePhasesHandler(ctx, {
      type: CMD_SAVE_PHASES,
      correlationId: CORRELATION,
      payload: {
        expectedRevision: plan.computedAgainstRevision,
        mutation: { kind: 'import-package', phaseIds: phases.map((d) => d.phaseId) },
        phases: [...inst.store.rowsOf('phase'), ...phases.map(phaseRow)]
      }
    } as SavePhasesCommand);
  }

  const pipelines = imported<PipelineDefinition>(plan, 'pipeline');
  if (pipelines.length > 0) {
    const revisions = plan.computedAgainstPipelineRevision;
    expect(revisions).toBeDefined();
    await savePipelinesHandler(ctx, {
      type: CMD_SAVE_PIPELINES,
      correlationId: CORRELATION,
      payload: {
        expectedRevision: revisions!,
        mutation: { kind: 'import-package', pipelineIds: pipelines.map((d) => d.pipelineId) },
        pipelines: [...inst.store.rowsOf('pipeline'), ...pipelines.map(pipelineRow)]
      }
    } as SavePipelinesCommand);
  }

  return acks.map((ack) => ack.status);
}

function phaseCatalog(inst: Installation) {
  return resolvePhaseCatalog({
    rows: inst.store.rowsOf('phase'),
    revision: inst.store.revisionOf('phase')
  });
}

function pipelineCatalog(inst: Installation) {
  return resolvePipelineCatalog({
    rows: inst.store.rowsOf('pipeline'),
    revision: inst.store.revisionOf('pipeline'),
    phaseCatalog: phaseCatalog(inst).effective
  });
}

describe('Feature 098 T059 — the shipped examples are the whole catalog', () => {
  it('ships at least one importable Pipeline document', () => {
    // Guards the discovery itself: an empty list would make every assertion
    // below vacuously true, which is the one way this file could go green while
    // the product shipped nothing to import.
    expect(PIPELINE_EXAMPLES.length).toBeGreaterThan(0);
    expect(EXAMPLES).toContain('model-catalog.yaml');
  });

  it('plans every example resource as a write against an empty catalog (FR-037)', async () => {
    // The pre-098 shape of this assertion was sixteen `skip` rows: the built-in
    // layer claimed the ids and `import-planner.ts` skipped anything claimed in
    // any layer. With that layer gone there is nothing left to collide with.
    const inst = emptyInstallation();
    for (const name of PIPELINE_EXAMPLES) {
      const plan = await planFor(inst, readExample(name));
      const outcomes = plan.rows.map((row) => row.outcome);
      expect(outcomes.length, name).toBeGreaterThan(0);
      expect(new Set(outcomes), name).toEqual(new Set(['import']));
      expect(await commit(inst, plan), name).not.toContain('rejected');
    }
  });

  it('leaves the operator every Pipeline the previous build compiled in (SC-017)', async () => {
    const inst = emptyInstallation();
    expect(pipelineCatalog(inst).effective).toHaveLength(0);

    for (const name of PIPELINE_EXAMPLES) {
      await commit(inst, await planFor(inst, readExample(name)));
    }

    // Each shipped document's own id, resolved out of the catalog it wrote —
    // not a hardcoded list, so adding an example extends the claim rather than
    // failing it.
    const declared = PIPELINE_EXAMPLES.map((name) => name.replace(/\.pipeline\.yaml$/, ''));
    const resolved = pipelineCatalog(inst).effective.map((d) => d.pipelineId);
    expect([...resolved].sort()).toEqual([...declared].sort());
  });

  it('resolves every Phase each example Pipeline runs (FR-038)', async () => {
    // The ordering claim, stated by outcome rather than by call order: a
    // Pipeline resolves against the effective Phase catalog, so a run strip
    // missing a Phase is the failure a Phases-after-Pipelines write would cause.
    const inst = emptyInstallation();
    for (const name of PIPELINE_EXAMPLES) {
      await commit(inst, await planFor(inst, readExample(name)));
    }

    const catalog = pipelineCatalog(inst);
    expect(catalog.records.filter((record) => record.status === 'invalid')).toHaveLength(0);
    const known = new Set(phaseCatalog(inst).effective.map((d) => d.phaseId));
    for (const pipeline of catalog.effective) {
      for (const phaseId of pipeline.phaseIds) {
        expect(known, `${pipeline.pipelineId} -> ${phaseId}`).toContain(phaseId);
      }
    }
  });
});
