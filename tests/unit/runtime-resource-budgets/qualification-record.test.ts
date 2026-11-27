import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  evaluateRetainedGrowth,
  GC_CAVEAT_DISCLOSURE,
  MEMORY_CATEGORIES,
  type MetricReading,
  type QualificationRecord,
  validateQualificationRecord,
  validateStoreComparison
} from '../../../src/contracts/runtime-resource-budgets/qualification-record.js';
import {
  buildQualificationRecord,
  captureEnvironmentDescriptor,
  exportQualificationRecord
} from '../../../src/services/runtime-resource-budgets/qualification-record-builder.js';
import { readHostMemoryCategories } from '../../../src/services/runtime-resource-budgets/resource-collector.js';

describe('qualification-record validation, store comparison, and soak growth (T024..T028)', () => {
  it('builds a valid metadata-only qualification record with pending-joint-qualification obligations and snapshotGate', () => {
    const record = buildQualificationRecord({
      baselineLabel: 'migration-baseline',
      environment: captureEnvironmentDescriptor({ commit: 'abc1234' }),
      distributions: [
        {
          metric: 'mutation-ack-20x64k-ms',
          runId: 'run-1',
          rawCount: 220,
          warmUpCount: 20,
          p50: 1.2,
          p95: 2.5,
          p99: 3.1,
          max: 4.0,
          unit: 'ms',
          derivation: 'measured',
          budgetKind: 'aggregate'
        }
      ],
      budgets: [
        {
          targetId: 'SC-002',
          status: 'migration-baseline-recorded',
          evidence: '3 isolated runs x 200 steady-state samples after 20 warm-up'
        }
      ]
    });

    const validation = validateQualificationRecord(record);
    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(record.targetArchitectureQualified).toBe(false);
    expect(record.snapshotGate.fixture).toBe(
      'tests/perf/webview-snapshot-cost.test.ts#large-history'
    );
    expect(record.activationRecovery.warmEditorRuntime).toEqual({
      status: 'unavailable',
      reason: 'not-run-this-cycle'
    });
    const pendingIds = record.budgets
      .filter((b) => b.status === 'pending-joint-qualification')
      .map((b) => b.targetId);
    expect(pendingIds).toEqual(
      expect.arrayContaining(['SC-003', 'SC-006', 'SC-007', 'SC-009', 'FR-023'])
    );
  });

  it('rejects absolute paths, forbidden keys, failed budgets without remediation, unavailable numeric values, and derived percentiles (SC-010, SC-011, FR-014, FR-022)', () => {
    const base = buildQualificationRecord({
      distributions: []
    });

    const withPosixPath: QualificationRecord = {
      ...base,
      budgets: [
        {
          targetId: 'SC-002',
          status: 'pass',
          evidence: 'Log written to /Users/alice/workspace/schegent/out.json'
        }
      ]
    };
    expect(validateQualificationRecord(withPosixPath).ok).toBe(false);

    const withFailNoRemediation: QualificationRecord = {
      ...base,
      budgets: [{ targetId: 'SC-004a', status: 'fail' }]
    };
    expect(validateQualificationRecord(withFailNoRemediation).ok).toBe(false);

    const withFailAndRemediation: QualificationRecord = {
      ...base,
      budgets: [
        {
          targetId: 'SC-004a',
          status: 'fail',
          remediation: 'Reduce per-mutation full-root serialization via incremental store in F04'
        }
      ]
    };
    expect(validateQualificationRecord(withFailAndRemediation).ok).toBe(true);

    const withDerivedPercentile: QualificationRecord = {
      ...base,
      distributions: [
        {
          metric: 'mutation-ack-20x64k-ms',
          runId: 'run-1',
          rawCount: 220,
          warmUpCount: 20,
          p50: 1,
          p95: 2,
          p99: 3,
          max: 4,
          unit: 'ms',
          derivation: 'derived'
        }
      ]
    };
    expect(validateQualificationRecord(withDerivedPercentile).ok).toBe(false);

    const badUnavailable = {
      ...base,
      activationRecovery: {
        warmEditorRuntime: {
          status: 'unavailable',
          reason: 'no-supported-probe',
          value: 0
        } as unknown as MetricReading,
        coldEditorRuntime: { status: 'unavailable', reason: 'not-run-this-cycle' } as const
      }
    };
    expect(validateQualificationRecord(badUnavailable).ok).toBe(false);

    const withForbiddenKey = {
      ...base,
      fixtures: [
        {
          id: 'idle',
          version: 1,
          seed: 1,
          dimensions: { prompt: 'secret user prompt' }
        }
      ]
    } as unknown as QualificationRecord;
    expect(validateQualificationRecord(withForbiddenKey).ok).toBe(false);
  });

  it('validates fair store comparisons across identical logical data, durability policy, and all 6 memory categories (US6, FR-002, FR-019)', () => {
    const validMem = readHostMemoryCategories({
      serializedBytes: 65_536,
      retainedApplicationBytes: 131_072
    });

    const validComparison = validateStoreComparison({
      fixtureId: 'active',
      arms: [
        {
          label: 'current-memento-store',
          role: 'migration-baseline',
          logicalDataDigest: 'sha256:20x64k-v1',
          durabilityPolicy: 'synchronous-commit-per-mutation',
          qualifiesTargetArchitecture: false,
          memory: validMem,
          distributions: []
        },
        {
          label: 'candidate-sqlite-wal',
          role: 'candidate',
          logicalDataDigest: 'sha256:20x64k-v1',
          durabilityPolicy: 'synchronous-commit-per-mutation',
          qualifiesTargetArchitecture: false,
          memory: validMem,
          distributions: []
        }
      ]
    });
    expect(validComparison.errors).toEqual([]);
    expect(validComparison.ok).toBe(true);

    const mismatchedPolicy = validateStoreComparison({
      fixtureId: 'active',
      arms: [
        {
          label: 'current-memento-store',
          role: 'migration-baseline',
          logicalDataDigest: 'sha256:20x64k-v1',
          durabilityPolicy: 'synchronous-commit',
          qualifiesTargetArchitecture: true, // also invalid for migration-baseline
          memory: {
            ...validMem,
            'process-resident-memory': {
              status: 'measured',
              value: 100_000,
              unit: 'bytes',
              scope: 'total-system', // invalid for host-only category
              derivation: 'measured'
            }
          },
          distributions: []
        },
        {
          label: 'candidate-store',
          role: 'candidate',
          logicalDataDigest: 'sha256:different-data',
          durabilityPolicy: 'deferred-flush',
          qualifiesTargetArchitecture: false,
          memory: {},
          distributions: []
        }
      ]
    });
    expect(mismatchedPolicy.ok).toBe(false);
    expect(mismatchedPolicy.errors.length).toBeGreaterThanOrEqual(4);
    expect(MEMORY_CATEGORIES).toHaveLength(6);
  });

  it('evaluates sustained retained-byte growth across 3 soak runs and enforces GC caveat rules (US7, FR-011, SC-006)', () => {
    const passing = evaluateRetainedGrowth({
      runs: [
        {
          runId: 'soak-1',
          minute20OwnedBytes: 10_000_000,
          minute60OwnedBytes: 10_500_000,
          minute20HeapBytes: 30_000_000,
          minute60HeapBytes: 28_000_000
        },
        {
          runId: 'soak-2',
          minute20OwnedBytes: 10_000_000,
          minute60OwnedBytes: 10_800_000
        },
        {
          runId: 'soak-3',
          minute20OwnedBytes: 10_000_000,
          minute60OwnedBytes: 10_200_000
        }
      ]
    });
    expect(passing.allRunsWithinTarget).toBe(true);
    expect(passing.sufficientRuns).toBe(true);
    expect(passing.noLeakClaimPermitted).toBe(true);
    expect(passing.gcCaveat).toBe(GC_CAVEAT_DISCLOSURE);

    const negativeHeapClaim = evaluateRetainedGrowth({
      claimBasedOnNegativeHeapDelta: true,
      runs: [
        { runId: 'soak-1', minute20OwnedBytes: 10_000_000, minute60OwnedBytes: 11_500_000 },
        { runId: 'soak-2', minute20OwnedBytes: 10_000_000, minute60OwnedBytes: 10_100_000 },
        { runId: 'soak-3', minute20OwnedBytes: 10_000_000, minute60OwnedBytes: 10_100_000 }
      ]
    });
    expect(negativeHeapClaim.allRunsWithinTarget).toBe(false);
    expect(negativeHeapClaim.noLeakClaimPermitted).toBe(false);
    expect(negativeHeapClaim.errors.join(' ')).toMatch(/negative heap delta/i);
  });

  it('exports valid qualification records to disk and refuses invalid ones', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-qual-'));
    try {
      const outPath = path.join(tmpDir, 'qualification-record.json');
      const record = buildQualificationRecord({ distributions: [] });
      await exportQualificationRecord(record, async (json) => {
        await fs.mkdir(path.dirname(outPath), { recursive: true });
        await fs.writeFile(outPath, json, 'utf8');
      });
      const parsed = JSON.parse(await fs.readFile(outPath, 'utf8')) as QualificationRecord;
      expect(validateQualificationRecord(parsed).ok).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
