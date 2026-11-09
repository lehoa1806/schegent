/**
 * FR-R6-F03 — Registered workload fixtures, product acceptance budget targets,
 * per-success-criterion cycle obligations, and acceptance traceability (FR-004,
 * FR-016, SC-002–SC-007, SC-012).
 *
 * Thresholds are proposed product acceptance budgets, not measured facts or
 * industry standards. Changing any registered target requires a documented
 * product trade-off and a fresh baseline (FR-016).
 *
 * Zero `vscode` imports.
 */

import {
  FULL_RESYNC_SNAPSHOT_BYTE_CEILING,
  MAX_RETAINED_HISTORY_ENTRIES,
  ROUTINE_SNAPSHOT_BYTE_BUDGET
} from '../snapshot-bounds';
import {
  MAX_LIVE_CONTROL_ROOTS,
  MAX_ROOT_LEDGER_BYTES,
  ROOT_SETTLEMENT_RESERVE_BYTES
} from '../control-ledger';

export const BUDGET_REGISTRY_VERSION = 1 as const;
export const WORKLOAD_FIXTURE_VERSION = 1 as const;

export const SAMPLE_SUFFICIENCY = Object.freeze({
  minSteadyStateSamples: 200 as const,
  minWarmUpSamples: 20 as const,
  minIsolatedRuns: 3 as const
});

export const WORKLOAD_FIXTURE_IDS = [
  'idle',
  'active',
  'history-2000',
  'concurrent-output',
  'control-ledger-near-limit',
  'long-lived-terminal-data',
  'mixed-normal',
  'mixed-stress',
  'control-ledger-matrix',
  'stream-matrix'
] as const;

export type WorkloadFixtureId = (typeof WORKLOAD_FIXTURE_IDS)[number];

export type WorkloadClass = 'normal' | 'stress' | 'matrix';

export type WorkloadBuildability = 'this-cycle' | 'pending-joint-qualification';

export interface WorkloadFixture {
  readonly id: WorkloadFixtureId;
  readonly version: typeof WORKLOAD_FIXTURE_VERSION;
  readonly class: WorkloadClass;
  readonly description: string;
  readonly seed: number;
  readonly dimensions: Readonly<Record<string, number | string>>;
  readonly consumers: readonly ('F03' | 'F04' | 'F06' | 'F07' | 'F11' | 'F13' | 'F14' | 'F15')[];
  readonly buildable: WorkloadBuildability;
}

export const WORKLOAD_FIXTURES: readonly WorkloadFixture[] = Object.freeze([
  {
    id: 'idle',
    version: WORKLOAD_FIXTURE_VERSION,
    class: 'normal',
    description: 'Idle workspace with 1 live queue, 0 active runs, and empty history',
    seed: 302_001,
    dimensions: Object.freeze({
      liveQueues: 1,
      activeRuns: 0,
      historyEntries: 0
    }),
    consumers: ['F03'],
    buildable: 'this-cycle'
  },
  {
    id: 'active',
    version: WORKLOAD_FIXTURE_VERSION,
    class: 'normal',
    description: '20 live roots at 64 KiB each under routine mutation acknowledgement',
    seed: 302_002,
    dimensions: Object.freeze({
      activeRoots: MAX_LIVE_CONTROL_ROOTS,
      rootPayloadBytes: 64 * 1024
    }),
    consumers: ['F03', 'F04'],
    buildable: 'this-cycle'
  },
  {
    id: 'history-2000',
    version: WORKLOAD_FIXTURE_VERSION,
    class: 'normal',
    description: '2,000 retained history entries across 40 partitions (webview snapshot gate)',
    seed: 302_003,
    dimensions: Object.freeze({
      retainedHistoryEntries: MAX_RETAINED_HISTORY_ENTRIES,
      partitions: 40,
      entriesPerPartition: 50
    }),
    consumers: ['F03'],
    buildable: 'this-cycle'
  },
  {
    id: 'concurrent-output',
    version: WORKLOAD_FIXTURE_VERSION,
    class: 'normal',
    description: 'Concurrent stream bursts (4 MiB per stream across 1..20 streams)',
    seed: 302_004,
    dimensions: Object.freeze({
      maxConcurrentStreams: 20,
      burstBytesPerStream: 4 * 1024 * 1024
    }),
    consumers: ['F03', 'F07', 'F13'],
    buildable: 'this-cycle'
  },
  {
    id: 'control-ledger-near-limit',
    version: WORKLOAD_FIXTURE_VERSION,
    class: 'stress',
    description: 'Near-limit control-ledger root approaching the 2 MiB serialized ceiling minus 16 KiB settlement reserve',
    seed: 302_005,
    dimensions: Object.freeze({
      activeRoots: 1,
      targetRootAdmissionCeilingBytes: MAX_ROOT_LEDGER_BYTES - ROOT_SETTLEMENT_RESERVE_BYTES,
      maxRootBytes: MAX_ROOT_LEDGER_BYTES,
      settlementReserveBytes: ROOT_SETTLEMENT_RESERVE_BYTES
    }),
    consumers: ['F03', 'F04'],
    buildable: 'this-cycle'
  },
  {
    id: 'long-lived-terminal-data',
    version: WORKLOAD_FIXTURE_VERSION,
    class: 'normal',
    description: '60-minute sustained session with quiescent checkpoints at minutes 20 and 60',
    seed: 302_006,
    dimensions: Object.freeze({
      durationMinutes: 60,
      checkpointEarlyMinute: 20,
      checkpointLateMinute: 60,
      isolatedSoakRuns: 3
    }),
    consumers: ['F03', 'F04', 'F07', 'F11', 'F13', 'F14', 'F15'],
    buildable: 'pending-joint-qualification'
  },
  {
    id: 'mixed-normal',
    version: WORKLOAD_FIXTURE_VERSION,
    class: 'normal',
    description: '20 roots of 64 KiB, 4 MiB output bursts per stream, 2,000 retained history entries, 1 visible live-log consumer, and 1 paged history query',
    seed: 302_007,
    dimensions: Object.freeze({
      activeRoots: MAX_LIVE_CONTROL_ROOTS,
      rootPayloadBytes: 64 * 1024,
      burstBytesPerStream: 4 * 1024 * 1024,
      retainedHistoryEntries: MAX_RETAINED_HISTORY_ENTRIES,
      visibleLiveLogConsumers: 1,
      pagedHistoryQueries: 1
    }),
    consumers: ['F03', 'F04', 'F06', 'F07', 'F11', 'F13', 'F14', 'F15'],
    buildable: 'pending-joint-qualification'
  },
  {
    id: 'mixed-stress',
    version: WORKLOAD_FIXTURE_VERSION,
    class: 'stress',
    description: 'Near-limit roots, hidden/slow live-log consumers, and limit-plus-one optional consumer queues',
    seed: 302_008,
    dimensions: Object.freeze({
      activeRoots: MAX_LIVE_CONTROL_ROOTS,
      rootPayloadBytes: 512 * 1024,
      burstBytesPerStream: 4 * 1024 * 1024,
      hiddenConsumers: 1,
      limitPlusOneQueues: 9
    }),
    consumers: ['F03', 'F04', 'F06', 'F07', 'F11', 'F13', 'F14', 'F15'],
    buildable: 'pending-joint-qualification'
  },
  {
    id: 'control-ledger-matrix',
    version: WORKLOAD_FIXTURE_VERSION,
    class: 'matrix',
    description: 'Root counts 1, 5, and 20 cross-product with root sizes near 64 KiB, 512 KiB, and 2 MiB plus limit-plus-one refusals',
    seed: 302_009,
    dimensions: Object.freeze({
      rootCounts: '1,5,20',
      rootTargetBytes: '65536,524288,2080768',
      maxLiveRoots: MAX_LIVE_CONTROL_ROOTS,
      maxRootBytes: MAX_ROOT_LEDGER_BYTES,
      settlementReserveBytes: ROOT_SETTLEMENT_RESERVE_BYTES
    }),
    consumers: ['F03', 'F04'],
    buildable: 'this-cycle'
  },
  {
    id: 'stream-matrix',
    version: WORKLOAD_FIXTURE_VERSION,
    class: 'matrix',
    description: 'Stream concurrency 1, 2, 4, 8, and 20 across ordinary text, incompressible bytes, giant lines, and no-newline output',
    seed: 302_010,
    dimensions: Object.freeze({
      concurrencies: '1,2,4,8,20',
      shapes: 'ordinary-text,incompressible,giant-line,no-newline',
      burstBytesPerStream: 4 * 1024 * 1024
    }),
    consumers: ['F03', 'F07', 'F13'],
    buildable: 'this-cycle'
  }
]);

export type CycleObligationKind =
  | 'enforced-by-test'
  | 'migration-baseline'
  | 'pending-joint-qualification';

export const SUCCESS_CRITERION_IDS = [
  'SC-001',
  'SC-002',
  'SC-003',
  'SC-004',
  'SC-005',
  'SC-006',
  'SC-007',
  'SC-008',
  'SC-009',
  'SC-010',
  'SC-011',
  'SC-012'
] as const;

export type SuccessCriterionId = (typeof SUCCESS_CRITERION_IDS)[number];

export interface SuccessCriterionObligation {
  readonly id: SuccessCriterionId | 'FR-023';
  readonly obligation: CycleObligationKind;
  readonly summary: string;
}

export const SUCCESS_CRITERION_OBLIGATIONS: readonly SuccessCriterionObligation[] = Object.freeze([
  {
    id: 'SC-001',
    obligation: 'enforced-by-test',
    summary: '100% of in-scope queues in inventory with 5 attributes, 0 competing constants, and 0 unbounded diagnostic collectors'
  },
  {
    id: 'SC-002',
    obligation: 'migration-baseline',
    summary: '>= 200 steady-state samples after 20 warm-up in 3 isolated runs with raw count, p50, p95, p99, max'
  },
  {
    id: 'SC-003',
    obligation: 'pending-joint-qualification',
    summary: 'Mixed normal workload event-loop delay p95 <= 20 ms and p99 <= 100 ms on reference host (requires F04/F07/F11/F13)'
  },
  {
    id: 'SC-004',
    obligation: 'migration-baseline',
    summary: 'Routine mutation ack p95 <= 100 ms at 20x64 KiB roots and p95 <= 500 ms at near-limit 2 MiB roots; CPU vs persistence wait'
  },
  {
    id: 'SC-005',
    obligation: 'enforced-by-test',
    summary: 'Representative large-history fixture routine snapshot <= 512 KiB and full resync <= 1 MiB'
  },
  {
    id: 'SC-006',
    obligation: 'pending-joint-qualification',
    summary: 'Three 60-minute mixed normal soaks show <= 10% owned retained byte growth between minutes 20 and 60'
  },
  {
    id: 'SC-007',
    obligation: 'pending-joint-qualification',
    summary: 'Mixed normal workload owned retained application data <= 512 MiB across in-scope host consumers'
  },
  {
    id: 'SC-008',
    obligation: 'enforced-by-test',
    summary: '100% of limit-plus-one cases in control-ledger matrix and FR-015 refuse/degrade as specified; settlement reserve preserved'
  },
  {
    id: 'SC-009',
    obligation: 'pending-joint-qualification',
    summary: 'Combined stress workload completes 100% of cancellations and durable acceptances with zero optional-consumer outcome drift'
  },
  {
    id: 'SC-010',
    obligation: 'enforced-by-test',
    summary: 'Qualification records contain zero prompts, code, transcripts, or absolute paths; 100% of failed budgets carry remediation'
  },
  {
    id: 'SC-011',
    obligation: 'enforced-by-test',
    summary: 'Zero metrics without a supported probe or with a refused permission are recorded as zero'
  },
  {
    id: 'SC-012',
    obligation: 'enforced-by-test',
    summary: 'Every FR-001..FR-023 and SC-001..SC-012 maps to at least one of F03-AC-01..F03-AC-06 with a reviewable fixture'
  },
  {
    id: 'FR-023',
    obligation: 'pending-joint-qualification',
    summary: 'Installed editor host qualification run deferred to joint run after F04 and F13 land'
  }
]);

export type RegisteredTargetId =
  | 'SC-002'
  | 'SC-003'
  | 'SC-004a'
  | 'SC-004b'
  | 'SC-005'
  | 'SC-006'
  | 'SC-007';

export interface RegisteredBudgetTarget {
  readonly id: RegisteredTargetId;
  readonly criterionId: SuccessCriterionId;
  readonly metric: string;
  readonly fixtureId: WorkloadFixtureId;
  readonly budgetVersion: typeof BUDGET_REGISTRY_VERSION;
  readonly unit: 'samples' | 'ms' | 'bytes' | 'percent';
  readonly threshold: {
    readonly minSamples?: number;
    readonly minWarmUpSamples?: number;
    readonly minRuns?: number;
    readonly p95Max?: number;
    readonly p99Max?: number;
    readonly routineMaxBytes?: number;
    readonly fullMaxBytes?: number;
    readonly maxGrowthPercent?: number;
    readonly maxOwnedRetainedBytes?: number;
  };
  readonly obligation: CycleObligationKind;
}

export const REGISTERED_BUDGET_TARGETS: readonly RegisteredBudgetTarget[] = Object.freeze([
  {
    id: 'SC-002',
    criterionId: 'SC-002',
    metric: 'steady-state-sample-sufficiency',
    fixtureId: 'active',
    budgetVersion: BUDGET_REGISTRY_VERSION,
    unit: 'samples',
    threshold: Object.freeze({
      minSamples: SAMPLE_SUFFICIENCY.minSteadyStateSamples,
      minWarmUpSamples: SAMPLE_SUFFICIENCY.minWarmUpSamples,
      minRuns: SAMPLE_SUFFICIENCY.minIsolatedRuns
    }),
    obligation: 'migration-baseline'
  },
  {
    id: 'SC-003',
    criterionId: 'SC-003',
    metric: 'event-loop-delay-ms',
    fixtureId: 'mixed-normal',
    budgetVersion: BUDGET_REGISTRY_VERSION,
    unit: 'ms',
    threshold: Object.freeze({
      p95Max: 20,
      p99Max: 100
    }),
    obligation: 'pending-joint-qualification'
  },
  {
    id: 'SC-004a',
    criterionId: 'SC-004',
    metric: 'mutation-ack-20x64k-ms',
    fixtureId: 'active',
    budgetVersion: BUDGET_REGISTRY_VERSION,
    unit: 'ms',
    threshold: Object.freeze({
      p95Max: 100
    }),
    obligation: 'migration-baseline'
  },
  {
    id: 'SC-004b',
    criterionId: 'SC-004',
    metric: 'mutation-ack-near-limit-2mib-ms',
    fixtureId: 'control-ledger-near-limit',
    budgetVersion: BUDGET_REGISTRY_VERSION,
    unit: 'ms',
    threshold: Object.freeze({
      p95Max: 500
    }),
    obligation: 'migration-baseline'
  },
  {
    id: 'SC-005',
    criterionId: 'SC-005',
    metric: 'webview-snapshot-bytes',
    fixtureId: 'history-2000',
    budgetVersion: BUDGET_REGISTRY_VERSION,
    unit: 'bytes',
    threshold: Object.freeze({
      routineMaxBytes: ROUTINE_SNAPSHOT_BYTE_BUDGET,
      fullMaxBytes: FULL_RESYNC_SNAPSHOT_BYTE_CEILING
    }),
    obligation: 'enforced-by-test'
  },
  {
    id: 'SC-006',
    criterionId: 'SC-006',
    metric: 'soak-owned-retained-growth-percent',
    fixtureId: 'long-lived-terminal-data',
    budgetVersion: BUDGET_REGISTRY_VERSION,
    unit: 'percent',
    threshold: Object.freeze({
      maxGrowthPercent: 10
    }),
    obligation: 'pending-joint-qualification'
  },
  {
    id: 'SC-007',
    criterionId: 'SC-007',
    metric: 'mixed-normal-owned-retained-bytes',
    fixtureId: 'mixed-normal',
    budgetVersion: BUDGET_REGISTRY_VERSION,
    unit: 'bytes',
    threshold: Object.freeze({
      maxOwnedRetainedBytes: 512 * 1024 * 1024
    }),
    obligation: 'pending-joint-qualification'
  }
]);

export const F03_ACCEPTANCE_CASE_IDS = [
  'F03-AC-01',
  'F03-AC-02',
  'F03-AC-03',
  'F03-AC-04',
  'F03-AC-05',
  'F03-AC-06'
] as const;

export type F03AcceptanceCaseId = (typeof F03_ACCEPTANCE_CASE_IDS)[number];

export interface F03AcceptanceCaseMapping {
  readonly caseId: F03AcceptanceCaseId;
  readonly functionalRequirements: readonly string[];
  readonly successCriteria: readonly SuccessCriterionId[];
  readonly fixtures: readonly string[];
}

export const F03_ACCEPTANCE_CASE_TRACEABILITY: readonly F03AcceptanceCaseMapping[] = Object.freeze([
  {
    caseId: 'F03-AC-01',
    functionalRequirements: ['FR-001', 'FR-012', 'FR-015'],
    successCriteria: ['SC-001', 'SC-007', 'SC-008', 'SC-012'],
    fixtures: [
      'tests/unit/runtime-resource-budgets/resource-inventory.test.ts',
      'tests/unit/runtime-resource-budgets/common-bound-conformance.test.ts'
    ]
  },
  {
    caseId: 'F03-AC-02',
    functionalRequirements: ['FR-002', 'FR-003', 'FR-007', 'FR-018', 'FR-019', 'FR-021', 'FR-023'],
    successCriteria: ['SC-002', 'SC-011'],
    fixtures: [
      'tests/unit/runtime-resource-budgets/resource-collector.test.ts',
      'tests/unit/runtime-resource-budgets/distribution.test.ts',
      'tests/perf/runtime-resource-baselines.test.ts'
    ]
  },
  {
    caseId: 'F03-AC-03',
    functionalRequirements: ['FR-004', 'FR-005', 'FR-008', 'FR-020'],
    successCriteria: ['SC-004', 'SC-008'],
    fixtures: [
      'tests/unit/runtime-resource-budgets/control-ledger-matrix.test.ts',
      'tests/perf/runtime-resource-baselines.test.ts'
    ]
  },
  {
    caseId: 'F03-AC-04',
    functionalRequirements: ['FR-004', 'FR-006', 'FR-009', 'FR-010', 'FR-017', 'FR-022'],
    successCriteria: ['SC-003', 'SC-007', 'SC-009'],
    fixtures: [
      'tests/unit/services/phase-log-tail-residual-bound.test.ts',
      'tests/unit/runtime-resource-budgets/pressure-status.test.ts',
      'tests/perf/runtime-resource-baselines.test.ts'
    ]
  },
  {
    caseId: 'F03-AC-05',
    functionalRequirements: ['FR-011'],
    successCriteria: ['SC-006'],
    fixtures: ['tests/unit/runtime-resource-budgets/qualification-record.test.ts']
  },
  {
    caseId: 'F03-AC-06',
    functionalRequirements: ['FR-013', 'FR-014', 'FR-016'],
    successCriteria: ['SC-005', 'SC-010', 'SC-012'],
    fixtures: [
      'tests/unit/runtime-resource-budgets/qualification-record.test.ts',
      'tests/unit/runtime-resource-budgets/budget-targets.test.ts',
      'tests/perf/webview-snapshot-cost.test.ts'
    ]
  }
]);

