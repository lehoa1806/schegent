/**
 * FR-R6-F03 — Qualification record types, store-comparison validator, retained-growth
 * evaluator, and metadata-only qualification record validator (FR-002, FR-007, FR-011,
 * FR-013, FR-014, FR-018, FR-019, FR-021, FR-022, SC-010, SC-011).
 *
 * Zero `vscode` imports.
 */

export const QUALIFICATION_RECORD_SCHEMA_VERSION = 1 as const;

export const MEMORY_CATEGORIES = [
  'serialized-bytes',
  'retained-application-bytes',
  'managed-heap',
  'external-buffer-allocation',
  'process-resident-memory',
  'backend-process-memory'
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export type MetricScope =
  | 'host-process'
  | 'backend-process'
  | 'serialized'
  | 'owned-retained'
  | 'total-system';

export type UnavailableReason =
  | 'no-supported-probe'
  | 'permission-refused'
  | 'not-run-this-cycle'
  | 'remote-filesystem-unobserved';

export type MetricReading =
  | {
      readonly status: 'measured';
      readonly value: number;
      readonly unit: 'bytes' | 'ms' | 'ratio' | 'count';
      readonly scope: MetricScope;
      readonly derivation: 'measured' | 'derived';
    }
  | {
      readonly status: 'unavailable';
      readonly reason: UnavailableReason;
    };

/**
 * Sample held in the bounded collector window. Carries no execution authority (FR-021).
 */
export interface Sample {
  readonly workloadId: string;
  readonly runId: string;
  readonly atMonotonicMs: number;
  readonly subsystem: string;
  readonly metric: string;
  readonly value: number;
  readonly byteEstimate?: number;
}

export interface Distribution {
  readonly metric: string;
  readonly runId: string;
  readonly rawCount: number;
  readonly warmUpCount: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly unit: 'ms' | 'bytes' | 'ratio' | 'count';
  readonly derivation?: 'measured' | 'derived';
  readonly budgetKind?: 'aggregate' | 'component';
}

export interface EnvironmentDescriptor {
  readonly os: string;
  readonly osRelease: string;
  readonly arch: string;
  readonly filesystem: 'local' | 'remote' | 'unknown';
  readonly runtime: 'standalone-node' | 'editor-extension-host';
  readonly runtimeVersion: string;
  readonly editorVersion: string;
  readonly commit: string;
  readonly machineMemoryBytes: number;
  readonly cacheState: 'warm' | 'cold' | 'unknown';
  readonly start: 'warm' | 'cold' | 'not-applicable';
}

export type RefusalOutcomeKind =
  | 'refused'
  | 'coalesced'
  | 'expired'
  | 'quarantined'
  | 'busy'
  | 'limited'
  | 'paused';

export interface RefusalEvent {
  readonly authorityOrBoundId: string;
  readonly outcome: RefusalOutcomeKind;
  readonly count: number;
}

export type BudgetResultStatus =
  | 'pass'
  | 'fail'
  | 'pending-joint-qualification'
  | 'migration-baseline-recorded';

export interface BudgetResult {
  readonly targetId: string;
  readonly status: BudgetResultStatus;
  readonly evidence?: string;
  readonly remediation?: string;
  readonly unsupportedCapacity?: string;
}

export interface RecordedFixtureRef {
  readonly id: string;
  readonly version: number;
  readonly seed: number;
  readonly dimensions: Readonly<Record<string, number | string>>;
}

export interface QualificationRecord {
  readonly schemaVersion: typeof QUALIFICATION_RECORD_SCHEMA_VERSION;
  readonly recordKind: 'runtime-resource-qualification';
  readonly budgetRegistryVersion: number;
  readonly inventoryVersion: number;
  readonly baselineLabel: 'migration-baseline' | 'target-architecture';
  readonly targetArchitectureQualified: boolean;
  readonly environment: EnvironmentDescriptor;
  readonly activationRecovery: {
    readonly warmEditorRuntime: MetricReading;
    readonly coldEditorRuntime: MetricReading;
  };
  readonly fixtures: readonly RecordedFixtureRef[];
  readonly distributions: readonly Distribution[];
  readonly memory: Readonly<Record<MemoryCategory, MetricReading>>;
  readonly refusals: readonly RefusalEvent[];
  readonly budgets: readonly BudgetResult[];
  readonly snapshotGate: {
    readonly fixture: string;
    readonly routineBudgetBytes: number;
    readonly fullBudgetBytes: number;
  };
  readonly sampleCoverage: {
    readonly observed: number;
    readonly retained: number;
  };
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

export interface StoreComparisonArm {
  readonly label: string;
  readonly role: 'migration-baseline' | 'candidate';
  readonly logicalDataDigest: string;
  readonly durabilityPolicy: string;
  readonly qualifiesTargetArchitecture: boolean;
  readonly memory: Readonly<Partial<Record<MemoryCategory, MetricReading>>>;
  readonly distributions: readonly Distribution[];
}

export interface StoreComparison {
  readonly fixtureId: string;
  readonly arms: readonly StoreComparisonArm[];
}

export const GC_CAVEAT_DISCLOSURE =
  'Heap and resident-memory readings reflect V8 garbage-collection timing; a negative or flat heap delta does not prove the absence of a leak and never substitutes for owned retained bytes across matched quiescent checkpoints.' as const;

export interface SoakCheckpointSample {
  readonly runId: string;
  readonly minute20OwnedBytes: number;
  readonly minute60OwnedBytes: number;
  readonly minute20HeapBytes?: number;
  readonly minute60HeapBytes?: number;
  readonly minute20RssBytes?: number;
  readonly minute60RssBytes?: number;
}

export interface RetainedGrowthInput {
  readonly maxGrowthPercent?: number;
  readonly runs: readonly SoakCheckpointSample[];
  readonly claimBasedOnNegativeHeapDelta?: boolean;
}

export interface PerRunGrowthResult {
  readonly runId: string;
  readonly growthBytes: number;
  readonly growthPercent: number;
  readonly withinTarget: boolean;
  readonly heapDeltaBytes?: number;
  readonly rssDeltaBytes?: number;
}

export interface RetainedGrowthEvaluation {
  readonly maxGrowthPercent: number;
  readonly perRun: readonly PerRunGrowthResult[];
  readonly allRunsWithinTarget: boolean;
  readonly sufficientRuns: boolean;
  readonly noLeakClaimPermitted: boolean;
  readonly gcCaveat: string;
  readonly errors: readonly string[];
}

/**
 * Validate that a store comparison uses identical logical data and durability policy
 * across arms, separates all 6 memory categories, prohibits host-process readings from
 * being labeled total-system, and prevents migration baselines from qualifying the
 * target architecture (FR-002, FR-019, US6).
 */
export function validateStoreComparison(comparison: StoreComparison): ValidationResult {
  const errors: string[] = [];
  if (comparison.arms.length < 2) {
    errors.push('Store comparison requires at least two arms.');
    return { ok: false, errors };
  }
  const reference = comparison.arms[0]!;
  for (const arm of comparison.arms) {
    if (arm.logicalDataDigest !== reference.logicalDataDigest) {
      errors.push(
        `Arm '${arm.label}' logicalDataDigest '${arm.logicalDataDigest}' does not match '${reference.logicalDataDigest}'.`
      );
    }
    if (arm.durabilityPolicy !== reference.durabilityPolicy) {
      errors.push(
        `Arm '${arm.label}' durabilityPolicy '${arm.durabilityPolicy}' does not match '${reference.durabilityPolicy}'.`
      );
    }
    if (arm.role === 'migration-baseline' && arm.qualifiesTargetArchitecture) {
      errors.push(
        `Arm '${arm.label}' is a migration-baseline and must not qualify the target architecture.`
      );
    }
    for (const category of MEMORY_CATEGORIES) {
      const reading = arm.memory[category];
      if (reading === undefined) {
        errors.push(`Arm '${arm.label}' is missing memory category '${category}'.`);
        continue;
      }
      validateMetricReadingCategory(category, reading, `arm '${arm.label}'`, errors);
    }
  }
  return { ok: errors.length === 0, errors };
}

function validateMetricReadingCategory(
  category: MemoryCategory,
  reading: MetricReading,
  context: string,
  errors: string[]
): void {
  if (reading.status === 'unavailable') {
    const raw = reading as unknown as Record<string, unknown>;
    if ('value' in raw && raw.value !== undefined) {
      errors.push(`Unavailable reading '${category}' in ${context} must not carry a numeric value.`);
    }
    return;
  }
  if (!Number.isFinite(reading.value) || reading.value < 0) {
    errors.push(`Measured reading '${category}' in ${context} must have a non-negative finite value.`);
  }
  if (
    (category === 'managed-heap' ||
      category === 'external-buffer-allocation' ||
      category === 'process-resident-memory') &&
    reading.scope === 'total-system'
  ) {
    errors.push(
      `Host-only memory category '${category}' in ${context} must not be labeled 'total-system'.`
    );
  }
  if (category === 'backend-process-memory' && reading.scope !== 'backend-process') {
    errors.push(
      `Category 'backend-process-memory' in ${context} must have scope 'backend-process'.`
    );
  }
}

/**
 * Evaluate sustained retained-byte growth across matched quiescent checkpoints at
 * minutes 20 and 60 (FR-011, SC-006, US7).
 */
export function evaluateRetainedGrowth(input: RetainedGrowthInput): RetainedGrowthEvaluation {
  const maxGrowthPercent = input.maxGrowthPercent ?? 10;
  const errors: string[] = [];
  const sufficientRuns = input.runs.length >= 3;
  if (!sufficientRuns) {
    errors.push(`Sustained-trend evaluation requires at least 3 runs; received ${input.runs.length}.`);
  }
  if (input.claimBasedOnNegativeHeapDelta === true) {
    errors.push('A negative heap delta must not be offered as proof that no leak exists.');
  }

  const perRun: PerRunGrowthResult[] = [];
  for (const run of input.runs) {
    if (run.minute20OwnedBytes <= 0) {
      errors.push(`Run '${run.runId}' minute20OwnedBytes must be positive.`);
    }
    const growthBytes = run.minute60OwnedBytes - run.minute20OwnedBytes;
    const growthPercent =
      run.minute20OwnedBytes > 0 ? (growthBytes / run.minute20OwnedBytes) * 100 : 100;
    const withinTarget = growthPercent <= maxGrowthPercent;
    const heapDeltaBytes =
      run.minute20HeapBytes !== undefined && run.minute60HeapBytes !== undefined
        ? run.minute60HeapBytes - run.minute20HeapBytes
        : undefined;
    const rssDeltaBytes =
      run.minute20RssBytes !== undefined && run.minute60RssBytes !== undefined
        ? run.minute60RssBytes - run.minute20RssBytes
        : undefined;
    perRun.push({
      runId: run.runId,
      growthBytes,
      growthPercent,
      withinTarget,
      ...(heapDeltaBytes !== undefined ? { heapDeltaBytes } : {}),
      ...(rssDeltaBytes !== undefined ? { rssDeltaBytes } : {})
    });
  }

  const allRunsWithinTarget = perRun.length > 0 && perRun.every((r) => r.withinTarget);
  const noLeakClaimPermitted =
    sufficientRuns &&
    allRunsWithinTarget &&
    input.claimBasedOnNegativeHeapDelta !== true &&
    errors.length === 0;

  return {
    maxGrowthPercent,
    perRun,
    allRunsWithinTarget,
    sufficientRuns,
    noLeakClaimPermitted,
    gcCaveat: GC_CAVEAT_DISCLOSURE,
    errors
  };
}

const FORBIDDEN_RECORD_KEYS = new Set([
  'prompt',
  'code',
  'transcript',
  'content',
  'body',
  'stdout',
  'stderr',
  'workspaceRoot',
  'absolutePath'
]);

const MAX_RECORD_STRING_LENGTH = 240;

const POSIX_ABS_PATH_RE = /(?:^|[\s"'])\/(?:Users|home|var|tmp|private|opt|etc|Volumes|mnt|srv|root|proc|sys)\/[^\s"']*/;
const GENERIC_LEADING_SLASH_PATH_RE = /^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/;
const WINDOWS_ABS_PATH_RE = /[A-Za-z]:\\[\\\S]+/;
const HOME_TILDE_PATH_RE = /(?:^|\s)~\/[^\s]+/;
const FILE_URL_RE = /file:\/\/\S+/i;

function scanMetadataOnlyValue(value: unknown, path: string, errors: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (value.length > MAX_RECORD_STRING_LENGTH) {
      errors.push(
        `String at '${path}' exceeds maximum metadata length (${value.length} > ${MAX_RECORD_STRING_LENGTH}).`
      );
    }
    if (
      POSIX_ABS_PATH_RE.test(value) ||
      GENERIC_LEADING_SLASH_PATH_RE.test(value) ||
      WINDOWS_ABS_PATH_RE.test(value) ||
      HOME_TILDE_PATH_RE.test(value) ||
      FILE_URL_RE.test(value)
    ) {
      errors.push(`String at '${path}' contains a forbidden absolute, home, or file-URL path.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      scanMetadataOnlyValue(value[i], `${path}[${i}]`, errors);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_RECORD_KEYS.has(k)) {
        errors.push(`Forbidden non-metadata key '${k}' at '${path}.${k}'.`);
      }
      scanMetadataOnlyValue(v, `${path}.${k}`, errors);
    }
  }
}

/**
 * Validate a qualification record for metadata-only safety, unavailable-metric integrity,
 * baseline non-qualification, failed-budget remediation, and measured-only event-loop
 * reporting (FR-013, FR-014, FR-018, FR-019, FR-022, SC-010, SC-011).
 */
export function validateQualificationRecord(record: QualificationRecord): ValidationResult {
  const errors: string[] = [];
  const rawRecord = record as unknown as Record<string, unknown>;

  if (rawRecord.schemaVersion !== QUALIFICATION_RECORD_SCHEMA_VERSION) {
    errors.push(`Unsupported qualification record schemaVersion '${String(rawRecord.schemaVersion)}'.`);
  }
  if (rawRecord.recordKind !== 'runtime-resource-qualification') {
    errors.push(`Invalid recordKind '${String(rawRecord.recordKind)}'.`);
  }

  scanMetadataOnlyValue(record, 'record', errors);

  if (record.baselineLabel === 'migration-baseline' && record.targetArchitectureQualified) {
    errors.push('A migration-baseline record must have targetArchitectureQualified: false.');
  }
  if (record.environment.runtime === 'standalone-node' && record.targetArchitectureQualified) {
    errors.push(
      'Standalone shell-runtime observations must not qualify the editor runtime (FR-007).'
    );
  }

  const rawMemory = record.memory as Readonly<Partial<Record<MemoryCategory, MetricReading>>>;
  for (const category of MEMORY_CATEGORIES) {
    const reading = rawMemory[category];
    if (reading === undefined) {
      errors.push(`Missing memory category '${category}'.`);
      continue;
    }
    validateMetricReadingCategory(category, reading, 'record.memory', errors);
  }

  for (const [key, reading] of Object.entries(record.activationRecovery)) {
    if (reading.status === 'unavailable') {
      const raw = reading as unknown as Record<string, unknown>;
      if ('value' in raw && raw.value !== undefined) {
        errors.push(`Unavailable activationRecovery.${key} must not carry a numeric value.`);
      }
    }
  }

  for (const dist of record.distributions) {
    if (dist.derivation === 'derived') {
      errors.push(
        `Distribution '${dist.metric}' (${dist.runId}) must be directly measured, never derived or summed from component percentiles (FR-022).`
      );
    }
    if (dist.rawCount < dist.warmUpCount) {
      errors.push(`Distribution '${dist.metric}' (${dist.runId}) has rawCount < warmUpCount.`);
    }
  }

  for (const budget of record.budgets) {
    if (budget.status === 'fail') {
      const hasRemediation =
        typeof budget.remediation === 'string' && budget.remediation.trim().length > 0;
      const hasUnsupported =
        typeof budget.unsupportedCapacity === 'string' &&
        budget.unsupportedCapacity.trim().length > 0;
      if (!hasRemediation && !hasUnsupported) {
        errors.push(
          `Failed budget '${budget.targetId}' must specify a non-empty remediation or unsupportedCapacity statement (FR-014).`
        );
      }
    }
  }

  if (record.sampleCoverage.retained > record.sampleCoverage.observed) {
    errors.push('sampleCoverage.retained cannot exceed sampleCoverage.observed.');
  }

  return { ok: errors.length === 0, errors };
}
