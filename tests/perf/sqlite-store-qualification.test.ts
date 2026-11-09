import { describe, expect, it } from 'vitest';
import {
  SQLITE_BENCHMARK_MEASURED_SAMPLES,
  SQLITE_BENCHMARK_WARMUP_SAMPLES
} from '../../src/contracts/sqlite-store/schema-types';
import {
  EngineQualificationService,
  measureOperationDistribution
} from '../../src/services/sqlite-store';

describe('FR-R6-F04 Performance & Engine Qualification Suite (SC-001 / F04-AC-01)', () => {
  it('enforces the F03 sample floor (>= 20 warm-up and >= 200 measured samples) and compares SQLite incremental commits against whole-map Memento cloning', () => {
    expect(() =>
      measureOperationDistribution({
        operationName: 'under_floor_test',
        warmupSamples: 5,
        measuredSamples: 50,
        step: () => {}
      })
    ).toThrow(/BENCHMARK_SAMPLE_FLOOR_VIOLATION/);

    const report = EngineQualificationService.runQualificationSuite({
      warmupSamples: SQLITE_BENCHMARK_WARMUP_SAMPLES,
      measuredSamples: SQLITE_BENCHMARK_MEASURED_SAMPLES
    });

    expect(report.engineName).toBe('node:sqlite');
    expect(report.meetsMinimumVersionFloor).toBe(true);
    expect(report.qualificationPassed).toBe(true);
    expect(report.sqliteBenchmarks.length).toBe(2);
    expect(report.legacyMementoBenchmarks.length).toBe(1);

    const admissionBench = report.sqliteBenchmarks[0]!;
    const keysetBench = report.sqliteBenchmarks[1]!;
    const legacyBench = report.legacyMementoBenchmarks[0]!;

    expect(admissionBench.measuredSamples).toBe(200);
    expect(admissionBench.failureCount).toBe(0);
    expect(admissionBench.p50Ms).toBeGreaterThanOrEqual(0);
    expect(admissionBench.p95Ms).toBeGreaterThanOrEqual(admissionBench.p50Ms);
    expect(admissionBench.p99Ms).toBeGreaterThanOrEqual(admissionBench.p95Ms);

    expect(keysetBench.measuredSamples).toBe(200);
    expect(keysetBench.failureCount).toBe(0);

    expect(legacyBench.measuredSamples).toBe(200);
    expect(legacyBench.failureCount).toBe(0);
  });
});
