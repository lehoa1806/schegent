// Feature 254 (FR-R4-F07, D-T2; contract D1, D2; data-model §5; FR-022, FR-023, SC-006) — the launcher
// states what the Run will use, and it states the same thing the Run does.
//
// The Runs preview showed a Pipeline's authored `executionDefaults` as if they were in force. They are
// not applied anywhere (`execution-defaults-stay-advisory.test.ts` pins that), so the preview told an
// operator the Run would use a model and effort that the Run then ignored. The projection now carries,
// per Phase, the backend, model, effort and idle bound that execution will use, resolved by the same
// functions execution calls, and the launcher renders those.
//
// This file is the proof that "the same functions" is true and not just intended. For each Phase of a
// corpus it builds the projection's `runSettings`, then drives the REAL `PhaseRunner` over the frozen
// form of the same Phase (`snapshotPhaseDef`, which is what a Run carries) with a fake backend, and
// compares what the preview says to what `PhaseRunner` hands that backend:
//
//   * the backend the registry is asked for,
//   * the `model` (or its absence, which the preview calls `backend-default`),
//   * the `effort` (likewise),
//   * the `timeoutMs`, which is the idle bound.
//
// The corpus covers an authored and an absent value of each, a pinned runner, a `sideEffects: git`
// Phase on a window whose default is not Claude, and a model string `isSafeArgvValue` refuses. The
// last is the sharp one: `phase-runner.ts` drops an unsafe model rather than passing it, so a preview
// that echoed the authored string would name a model the Run never receives.
//
// The harness shape (a fake runner returning a clean phase message) is the one
// `tests/unit/controller/phase-runner.test.ts` uses to read `model`, `effort` and `timeoutMs`.

import { describe, expect, it, vi } from 'vitest';

import type { AuditLogWriter } from '../../../../src/audit/audit-log-writer';
import type { AuditEntry } from '../../../../src/audit/audit-entry';
import { phaseDefinitionToPhaseDef } from '../../../../src/config/process-catalog';
import { snapshotPhaseDef } from '../../../../src/config/pipeline-snapshot';
import type { BackendRunnerKind } from '../../../../src/contracts/backend-kinds';
import type { PhaseDefinition } from '../../../../src/contracts/process-definitions';
import type {
  EffectiveLimit,
  LaunchPhaseSettings
} from '../../../../src/contracts/snapshot-projections';
import { PhaseRunner } from '../../../../src/controller/phase-runner';
import { SanitizedLogger } from '../../../../src/lib/logger';
import { PromptBuilder } from '../../../../src/runner/prompt-builder';
import { ZippedStreamBuffer } from '../../../../src/runner/zipped-stream-buffer';
import type { BackendRunnerRegistry } from '../../../../src/runner/backend-runner-registry';
import { buildLaunchProjection } from '../../../../src/ui/sidebar/launch-projection';
import type {
  Launchable,
  PhaseCatalogProjection,
  PipelineCatalogProjection,
  PipelineCatalogSourceProjection,
  WorkflowCatalogProjection
} from '../../../../src/ui/sidebar/snapshot';
import type {
  InvocationRequest,
  RawInvocationOutput
} from '../../../../src/runner/invocation-result';

// ---------------------------------------------------------------------------
// Execution: the real PhaseRunner over a fake backend
// ---------------------------------------------------------------------------

const CLEAN_STDOUT = [
  '=== SCHEGENT AUDIT LOG ===',
  'phase: speckit-specify',
  'files_created: []',
  'files_modified: []',
  'files_deleted: []',
  'commands_executed: ["none"]',
  'network_calls: ["none"]',
  'ruleset_switches: ["none"]',
  'notes: ok',
  '=== END AUDIT LOG ===',
  '[SCHEGENT_STATUS: CLEAR]'
].join('\n');

function rawOutput(): RawInvocationOutput {
  const stdoutBuffer = new ZippedStreamBuffer();
  stdoutBuffer.append(CLEAN_STDOUT);
  stdoutBuffer.finalize();
  const stderrBuffer = new ZippedStreamBuffer();
  stderrBuffer.append('');
  stderrBuffer.finalize();
  return {
    stdoutBuffer,
    stderrBuffer,
    exitCode: 0,
    killed: false,
    timedOut: false,
    durationMs: 50
  } as RawInvocationOutput;
}

function auditWriter(): AuditLogWriter {
  let counter = 0;
  return {
    append: vi.fn(async (entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> => ({
      id: `audit-${++counter}`,
      timestamp: '2026-10-31T00:00:00Z',
      ...entry
    })),
    logPath: '/tmp/.schegent/audit.log'
  } as unknown as AuditLogWriter;
}

/** What execution handed the backend for one Phase: the backend asked for and the request it got. */
interface ExecutionSeen {
  readonly backend: BackendRunnerKind | undefined;
  readonly request: InvocationRequest;
}

async function executionOf(
  definition: PhaseDefinition,
  defaultRunner: BackendRunnerKind,
  idleTimeoutMs: number
): Promise<ExecutionSeen> {
  const requests: InvocationRequest[] = [];
  const asked: (BackendRunnerKind | undefined)[] = [];
  const runner = {
    invoke: vi.fn(async (request: InvocationRequest) => {
      requests.push(request);
      return rawOutput();
    }),
    cancelActive: vi.fn(() => false),
    hasActiveProcess: false
  };
  const registry = {
    getOrCreate: (kind?: BackendRunnerKind) => {
      asked.push(kind);
      return runner;
    }
  } as unknown as BackendRunnerRegistry;

  // The Phase as a Run carries it: frozen, with its backend resolved by the freeze's own function.
  const frozen = snapshotPhaseDef(phaseDefinitionToPhaseDef(definition), defaultRunner);
  const phaseRunner = new PhaseRunner(registry, new PromptBuilder(), auditWriter(), new SanitizedLogger());
  await phaseRunner.run({
    phase: 'speckit-specify',
    phaseDef: frozen,
    iteration: 1,
    iterationCap: 10,
    featureDescription: 'desc',
    featureDir: 'specs/001-mock',
    cliPath: 'claude',
    cwd: '/repo',
    timeoutMs: idleTimeoutMs,
    runId: 'run-1'
  });

  expect(requests).toHaveLength(1);
  return { backend: asked[0], request: requests[0] as InvocationRequest };
}

// ---------------------------------------------------------------------------
// Preview: the projection's runSettings for a Pipeline over the same Phase
// ---------------------------------------------------------------------------

const LIMITS = {
  idleTimeoutSeconds: { value: 5400, origin: 'default' } as EffectiveLimit<number>,
  maxDurationSeconds: { value: 21_600, origin: 'workspace' } as EffectiveLimit<number>
};

const AUTHORED_DEFAULTS = {
  runner: 'agy',
  model: 'pipeline-default-model',
  effort: 'max',
  timeoutSeconds: 7
} as const;

function pipelineRecordOver(phaseId: string): PipelineCatalogSourceProjection {
  return {
    key: 'one::0',
    pipelineId: 'one',
    status: 'effective',
    definition: {
      pipelineId: 'one',
      name: 'One',
      version: 1,
      phaseIds: [phaseId],
      inputs: [],
      outputs: [],
      bindings: [],
      // Authored, advisory and different from anything execution will do: if the projection read it,
      // the preview would disagree with the Run on the model, the effort or the bound (FR-023, M8).
      executionDefaults: AUTHORED_DEFAULTS,
      recommendedNext: []
    },
    display: { name: 'One' },
    errors: [],
    lifecycle: {
      state: 'active',
      createdAt: 1,
      updatedAt: 2,
      activeVersionId: 'v1',
      expectedDraftVersion: 'none',
      versions: [{ versionId: 'v1', createdAt: 1, publishedAt: 2, isActive: true, note: null }]
    }
  } as unknown as PipelineCatalogSourceProjection;
}

function previewOf(
  definition: PhaseDefinition,
  defaultRunner: BackendRunnerKind
): LaunchPhaseSettings {
  const record = pipelineRecordOver(definition.phaseId);
  const pipelines = {
    state: 'ready',
    records: [record],
    effective: record.definition === null ? [] : [record.definition],
    revision: 'rev-pipelines',
    warnings: []
  } as unknown as PipelineCatalogProjection;
  const workflows = {
    state: 'ready',
    records: [],
    effective: [],
    revision: 'rev-workflows',
    warnings: []
  } as unknown as WorkflowCatalogProjection;
  const phases = {
    state: 'ready',
    records: [],
    effective: [definition],
    revision: 'rev-phases',
    warnings: []
  } as unknown as PhaseCatalogProjection;

  const projection = buildLaunchProjection(pipelines, workflows, phases, defaultRunner, LIMITS);
  if (projection === undefined || projection.pipelines.state !== 'entries') {
    throw new Error('the projection listed no Pipeline');
  }
  const entry: Launchable | undefined = projection.pipelines.entries.at(0);
  const first = entry?.runSettings?.phases[0];
  if (first === undefined) throw new Error('the Pipeline entry carried no runSettings');
  return first;
}

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

function phase(
  phaseId: string,
  extra: Partial<Omit<PhaseDefinition, 'phaseId' | 'name' | 'version' | 'instruction'>> = {}
): PhaseDefinition {
  return { phaseId, name: `Phase ${phaseId}`, version: 1, instruction: 'Do the thing.', ...extra } as PhaseDefinition;
}

const CORPUS: ReadonlyArray<{ readonly label: string; readonly definition: PhaseDefinition }> = [
  { label: 'nothing authored', definition: phase('bare') },
  { label: 'a model only', definition: phase('model-only', { model: 'claude-opus-5-5' }) },
  { label: 'an effort only', definition: phase('effort-only', { effort: 'high' }) },
  { label: 'a timeout only', definition: phase('timeout-only', { timeoutSeconds: 90 }) },
  {
    label: 'a model, an effort and a timeout',
    definition: phase('all-three', { model: 'claude-opus-5-5', effort: 'high', timeoutSeconds: 120 })
  },
  { label: 'a pinned runner', definition: phase('pinned', { runner: 'agy', model: 'gemini-pro' }) },
  { label: 'sideEffects git', definition: phase('git-phase', { sideEffects: 'git' }) },
  {
    label: 'an unsafe model string',
    definition: phase('unsafe-model', { model: '--dangerously-skip-permissions', effort: 'low' })
  },
  { label: 'a model with a space', definition: phase('spaced-model', { model: 'not safe' }) }
];

describe('FR-R4-F07 D-T2 — the preview equals what the Run hands the backend (D2, FR-022)', () => {
  describe.each(['claude', 'codex'] as const)('on a window whose default backend is %s', (defaultRunner) => {
    it.each(CORPUS)('$label', async ({ definition }) => {
      const preview = previewOf(definition, defaultRunner);
      const executed = await executionOf(definition, defaultRunner, LIMITS.idleTimeoutSeconds.value * 1000);

      // The backend the registry was asked for.
      expect(preview.backend).toBe(executed.backend);

      // The model: a value execution passes, or `backend-default` when it passes none.
      const model = executed.request.model;
      expect(preview.model).toEqual(
        model === undefined ? { kind: 'backend-default' } : { kind: 'value', value: model }
      );

      // The effort, likewise.
      const effort = executed.request.effort;
      expect(preview.effort).toEqual(
        effort === undefined ? { kind: 'backend-default' } : { kind: 'value', value: effort }
      );

      // The idle bound, in the unit the host passes.
      expect(preview.idleTimeoutSeconds.value * 1000).toBe(executed.request.timeoutMs);
    });
  });

  it('ignores the Pipeline\'s authored execution defaults, which no Run applies (FR-023)', () => {
    const preview = previewOf(phase('plain'), 'claude');
    expect(preview.backend).toBe('claude');
    expect(preview.model).toEqual({ kind: 'backend-default' });
    expect(preview.effort).toEqual({ kind: 'backend-default' });
    expect(preview.idleTimeoutSeconds.value).toBe(LIMITS.idleTimeoutSeconds.value);
    expect(JSON.stringify(preview)).not.toContain('pipeline-default-model');
  });

  it('names the Phase by its name, as the sanitized Phase projection does', () => {
    const preview = previewOf(phase('named'), 'claude');
    expect(preview.phaseName).toBe('Phase named');
  });

  it('never echoes an unsafe authored model as the effective one', () => {
    const preview = previewOf(phase('unsafe', { model: '--dangerously-skip-permissions' }), 'claude');
    expect(preview.model).toEqual({ kind: 'backend-default' });
    expect(JSON.stringify(preview)).not.toContain('dangerously');
  });

  it('reports a git Phase on the Claude backend even when the window default is Codex', () => {
    const preview = previewOf(phase('git-on-codex', { sideEffects: 'git' }), 'codex');
    expect(preview.backend).toBe('claude');
  });

  it('gives the idle bound the origin `phase` when the Phase states one, else the settings layer\'s', () => {
    expect(previewOf(phase('stated', { timeoutSeconds: 45 }), 'claude').idleTimeoutSeconds).toEqual({
      value: 45,
      origin: 'phase'
    });
    expect(previewOf(phase('unstated'), 'claude').idleTimeoutSeconds).toEqual({
      value: 5400,
      origin: 'default'
    });
  });
});
