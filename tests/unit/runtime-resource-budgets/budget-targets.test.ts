import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BUDGET_REGISTRY_VERSION,
  F03_ACCEPTANCE_CASE_IDS,
  F03_ACCEPTANCE_CASE_TRACEABILITY,
  REGISTERED_BUDGET_TARGETS,
  SAMPLE_SUFFICIENCY,
  SUCCESS_CRITERION_IDS,
  SUCCESS_CRITERION_OBLIGATIONS,
  WORKLOAD_FIXTURE_IDS,
  WORKLOAD_FIXTURE_VERSION,
  WORKLOAD_FIXTURES
} from '../../../src/contracts/runtime-resource-budgets/budget-targets.js';
import {
  COMMON_QUEUE_BOUNDS,
  CORRECTION_HISTORY_MAX_BYTES,
  CORRECTION_HISTORY_MAX_ITEMS,
  HISTORICAL_QUERY_MAX_EXECUTING,
  HISTORICAL_QUERY_MAX_QUEUED_PARAMETER_BYTES,
  HISTORICAL_QUERY_MAX_WAITING,
  HISTORICAL_QUERY_WORKING_DATA_MAX_BYTES,
  LIVE_REPORT_LEASE_LIFETIME_MS,
  LIVE_REPORT_MAX_LEASES,
  OUTSTANDING_ACCOUNTING_INTENTS_MAX_BYTES,
  OUTSTANDING_ACCOUNTING_INTENTS_MAX_ITEMS,
  PENDING_ACCOUNTING_PROJECTION_MAX_BYTES,
  PENDING_ACCOUNTING_PROJECTION_MAX_ITEMS,
  PENDING_USAGE_INGESTION_MAX_BYTES,
  PENDING_USAGE_INGESTION_MAX_ITEMS,
  RESOURCE_COLLECTOR_MAX_BYTES,
  RESOURCE_COLLECTOR_MAX_SAMPLES,
  UNATTRIBUTED_USAGE_MAX_AGE_MS,
  UNATTRIBUTED_USAGE_MAX_BYTES,
  UNATTRIBUTED_USAGE_MAX_ITEMS
} from '../../../src/contracts/runtime-resource-budgets/common-bounds.js';

describe('budget-targets and traceability (FR-015, FR-016, SC-002..SC-007, SC-012)', () => {
  it('pins the exact FR-015 common queue and query bound constants (FR-016)', () => {
    expect(RESOURCE_COLLECTOR_MAX_SAMPLES).toBe(4_096);
    expect(RESOURCE_COLLECTOR_MAX_BYTES).toBe(4 * 1024 * 1024);

    expect(PENDING_USAGE_INGESTION_MAX_ITEMS).toBe(4_096);
    expect(PENDING_USAGE_INGESTION_MAX_BYTES).toBe(16 * 1024 * 1024);

    expect(UNATTRIBUTED_USAGE_MAX_ITEMS).toBe(1_024);
    expect(UNATTRIBUTED_USAGE_MAX_BYTES).toBe(4 * 1024 * 1024);
    expect(UNATTRIBUTED_USAGE_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);

    expect(PENDING_ACCOUNTING_PROJECTION_MAX_ITEMS).toBe(2_048);
    expect(PENDING_ACCOUNTING_PROJECTION_MAX_BYTES).toBe(8 * 1024 * 1024);

    expect(OUTSTANDING_ACCOUNTING_INTENTS_MAX_ITEMS).toBe(10_000);
    expect(OUTSTANDING_ACCOUNTING_INTENTS_MAX_BYTES).toBe(32 * 1024 * 1024);

    expect(CORRECTION_HISTORY_MAX_ITEMS).toBe(64);
    expect(CORRECTION_HISTORY_MAX_BYTES).toBe(256 * 1024);

    expect(HISTORICAL_QUERY_MAX_EXECUTING).toBe(2);
    expect(HISTORICAL_QUERY_MAX_WAITING).toBe(8);
    expect(HISTORICAL_QUERY_MAX_QUEUED_PARAMETER_BYTES).toBe(1 * 1024 * 1024);

    expect(HISTORICAL_QUERY_WORKING_DATA_MAX_BYTES).toBe(32 * 1024 * 1024);

    expect(LIVE_REPORT_MAX_LEASES).toBe(4);
    expect(LIVE_REPORT_LEASE_LIFETIME_MS).toBe(5 * 60 * 1000);

    expect(COMMON_QUEUE_BOUNDS).toHaveLength(9);
  });

  it('pins the exact product acceptance budget targets and sample sufficiency rules (FR-016, SC-002..SC-007)', () => {
    expect(BUDGET_REGISTRY_VERSION).toBe(1);
    expect(SAMPLE_SUFFICIENCY).toEqual({
      minSteadyStateSamples: 200,
      minWarmUpSamples: 20,
      minIsolatedRuns: 3
    });

    const thresholdOf = (id: string) =>
      REGISTERED_BUDGET_TARGETS.find((t) => t.id === id)?.threshold;
    expect(thresholdOf('SC-002')).toEqual({
      minSamples: 200,
      minWarmUpSamples: 20,
      minRuns: 3
    });
    expect(thresholdOf('SC-003')).toEqual({ p95Max: 20, p99Max: 100 });
    expect(thresholdOf('SC-004a')).toEqual({ p95Max: 100 });
    expect(thresholdOf('SC-004b')).toEqual({ p95Max: 500 });
    expect(thresholdOf('SC-005')).toEqual({
      routineMaxBytes: 512 * 1024,
      fullMaxBytes: 1024 * 1024
    });
    expect(thresholdOf('SC-006')).toEqual({ maxGrowthPercent: 10 });
    expect(thresholdOf('SC-007')).toEqual({ maxOwnedRetainedBytes: 512 * 1024 * 1024 });
  });

  it('registers all 10 deterministic workload fixtures with unique IDs and seeds', () => {
    expect(WORKLOAD_FIXTURE_VERSION).toBe(1);
    expect(WORKLOAD_FIXTURES).toHaveLength(WORKLOAD_FIXTURE_IDS.length);
    const ids = new Set(WORKLOAD_FIXTURES.map((f) => f.id));
    const seeds = new Set(WORKLOAD_FIXTURES.map((f) => f.seed));
    expect(ids.size).toBe(WORKLOAD_FIXTURE_IDS.length);
    expect(seeds.size).toBe(WORKLOAD_FIXTURE_IDS.length);
  });

  it('assigns a cycle obligation to every SC-001..SC-012 and FR-023', () => {
    const obligationIds = new Set(SUCCESS_CRITERION_OBLIGATIONS.map((o) => o.id));
    for (const scId of SUCCESS_CRITERION_IDS) {
      expect(obligationIds.has(scId), `Missing obligation for ${scId}`).toBe(true);
    }
    expect(obligationIds.has('FR-023')).toBe(true);
  });

  it('maps every FR-001..FR-023 and SC-001..SC-012 to at least one F03-AC-01..F03-AC-06 with existing test fixtures on disk (SC-012)', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const mappedCases = new Set(F03_ACCEPTANCE_CASE_TRACEABILITY.map((c) => c.caseId));
    expect(mappedCases.size).toBe(F03_ACCEPTANCE_CASE_IDS.length);

    const mappedFrs = new Set(
      F03_ACCEPTANCE_CASE_TRACEABILITY.flatMap((c) => c.functionalRequirements)
    );
    for (let i = 1; i <= 23; i += 1) {
      const frId = `FR-${String(i).padStart(3, '0')}`;
      expect(mappedFrs.has(frId), `${frId} must map to an F03-AC-* case`).toBe(true);
    }

    const mappedScs = new Set(F03_ACCEPTANCE_CASE_TRACEABILITY.flatMap((c) => c.successCriteria));
    for (const scId of SUCCESS_CRITERION_IDS) {
      expect(mappedScs.has(scId), `${scId} must map to an F03-AC-* case`).toBe(true);
    }

    for (const entry of F03_ACCEPTANCE_CASE_TRACEABILITY) {
      expect(entry.fixtures.length).toBeGreaterThan(0);
      for (const relPath of entry.fixtures) {
        const fullPath = path.join(repoRoot, relPath);
        expect(
          fs.existsSync(fullPath),
          `Traceability fixture for ${entry.caseId} does not exist: ${relPath}`
        ).toBe(true);
      }
    }
  });
});
