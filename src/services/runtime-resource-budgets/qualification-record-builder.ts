/**
 * Qualification record builder and metadata-only JSON exporter (`FR-007`, `FR-013`,
 * `FR-014`, `FR-019`, `FR-023`, `SC-010`, `SC-011`).
 *
 * Zero `vscode` imports.
 */

import * as os from 'node:os';

import {
  BUDGET_REGISTRY_VERSION,
  SUCCESS_CRITERION_OBLIGATIONS,
  WORKLOAD_FIXTURES
} from '../../contracts/runtime-resource-budgets/budget-targets.js';
import { RUNTIME_RESOURCE_BUDGETS_CONTRACT_VERSION } from '../../contracts/runtime-resource-budgets/common-bounds.js';
import {
  type BudgetResult,
  type Distribution,
  type EnvironmentDescriptor,
  type MemoryCategory,
  type MetricReading,
  QUALIFICATION_RECORD_SCHEMA_VERSION,
  type QualificationRecord,
  type RecordedFixtureRef,
  type RefusalEvent,
  validateQualificationRecord
} from '../../contracts/runtime-resource-budgets/qualification-record.js';
import {
  FULL_RESYNC_SNAPSHOT_BYTE_CEILING,
  ROUTINE_SNAPSHOT_BYTE_BUDGET
} from '../../contracts/snapshot-bounds.js';
import { readHostMemoryCategories } from './resource-collector.js';

export interface CaptureEnvironmentOptions {
  readonly commit?: string;
  readonly filesystem?: 'local' | 'remote' | 'unknown';
  readonly runtime?: 'standalone-node' | 'editor-extension-host';
  readonly editorVersion?: string;
  readonly cacheState?: 'warm' | 'cold' | 'unknown';
  readonly start?: 'warm' | 'cold' | 'not-applicable';
}

export function captureEnvironmentDescriptor(
  options: CaptureEnvironmentOptions = {}
): EnvironmentDescriptor {
  const runtime = options.runtime ?? 'standalone-node';
  return Object.freeze({
    os: os.platform(),
    osRelease: os.release(),
    arch: os.arch(),
    filesystem: options.filesystem ?? 'local',
    runtime,
    runtimeVersion: process.version,
    editorVersion:
      options.editorVersion ??
      (runtime === 'standalone-node' ? 'not-applicable-standalone' : 'unknown-editor'),
    commit: sanitizeCommitIdentifier(options.commit ?? 'working-tree'),
    machineMemoryBytes: os.totalmem(),
    cacheState: options.cacheState ?? 'warm',
    start: options.start ?? (runtime === 'standalone-node' ? 'not-applicable' : 'warm')
  });
}

function sanitizeCommitIdentifier(raw: string): string {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{7,40}$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return 'working-tree';
}

export interface BuildQualificationRecordInput {
  readonly baselineLabel?: 'migration-baseline' | 'target-architecture';
  readonly targetArchitectureQualified?: boolean;
  readonly environment?: EnvironmentDescriptor;
  readonly activationRecovery?: {
    readonly warmEditorRuntime: MetricReading;
    readonly coldEditorRuntime: MetricReading;
  };
  readonly fixtures?: readonly RecordedFixtureRef[];
  readonly distributions: readonly Distribution[];
  readonly memory?: Readonly<Record<MemoryCategory, MetricReading>>;
  readonly refusals?: readonly RefusalEvent[];
  readonly budgets?: readonly BudgetResult[];
  readonly sampleCoverage?: {
    readonly observed: number;
    readonly retained: number;
  };
}

export function buildQualificationRecord(
  input: BuildQualificationRecordInput
): QualificationRecord {
  const baselineLabel = input.baselineLabel ?? 'migration-baseline';
  const environment = input.environment ?? captureEnvironmentDescriptor();

  const targetArchitectureQualified =
    baselineLabel === 'migration-baseline' || environment.runtime === 'standalone-node'
      ? false
      : (input.targetArchitectureQualified ?? false);

  const defaultFixtures: RecordedFixtureRef[] = WORKLOAD_FIXTURES.filter(
    (fixture) => fixture.buildable === 'this-cycle'
  ).map((fixture) => ({
    id: fixture.id,
    version: fixture.version,
    seed: fixture.seed,
    dimensions: fixture.dimensions
  }));

  const providedBudgets = input.budgets ?? [];
  const providedIds = new Set(providedBudgets.map((b) => b.targetId));
  const pendingBudgets: BudgetResult[] = SUCCESS_CRITERION_OBLIGATIONS.filter(
    (entry) =>
      entry.obligation === 'pending-joint-qualification' && !providedIds.has(entry.id)
  ).map((entry) => ({
    targetId: entry.id,
    status: 'pending-joint-qualification',
    evidence: 'Deferred to joint qualification run after F04/F07/F11/F13 land'
  }));

  const memory = input.memory ?? readHostMemoryCategories();
  const totalDistSamples = input.distributions.reduce((acc, d) => acc + d.rawCount, 0);

  return Object.freeze({
    schemaVersion: QUALIFICATION_RECORD_SCHEMA_VERSION,
    recordKind: 'runtime-resource-qualification',
    budgetRegistryVersion: BUDGET_REGISTRY_VERSION,
    inventoryVersion: RUNTIME_RESOURCE_BUDGETS_CONTRACT_VERSION,
    baselineLabel,
    targetArchitectureQualified,
    environment,
    activationRecovery: input.activationRecovery ?? {
      warmEditorRuntime: { status: 'unavailable', reason: 'not-run-this-cycle' } as const,
      coldEditorRuntime: { status: 'unavailable', reason: 'not-run-this-cycle' } as const
    },
    fixtures: input.fixtures ?? defaultFixtures,
    distributions: input.distributions,
    memory,
    refusals: input.refusals ?? [],
    budgets: [...providedBudgets, ...pendingBudgets],
    snapshotGate: {
      fixture: 'tests/perf/webview-snapshot-cost.test.ts#large-history',
      routineBudgetBytes: ROUTINE_SNAPSHOT_BYTE_BUDGET,
      fullBudgetBytes: FULL_RESYNC_SNAPSHOT_BYTE_CEILING
    },
    sampleCoverage: input.sampleCoverage ?? {
      observed: totalDistSamples,
      retained: totalDistSamples
    }
  });
}

export async function exportQualificationRecord(
  record: QualificationRecord,
  writeTarget?: (json: string) => Promise<void> | void
): Promise<string> {
  const validation = validateQualificationRecord(record);
  if (!validation.ok) {
    throw new Error(
      `Refusing to export invalid qualification record: ${validation.errors.join('; ')}`
    );
  }
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  if (writeTarget !== undefined) {
    await writeTarget(serialized);
  }
  return serialized;
}
