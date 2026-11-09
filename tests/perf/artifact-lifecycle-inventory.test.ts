// FR-R6-F05 (T046; AC-04, NFR-003, SC-004) — storage inventory at 10,000 artifacts.
//
// 10,000 registered checkpoint rows, each with its bytes in a 10,000-file fake scan tree
// (100 run directories of 100 files). One declared-root scan runs first and its heap delta is
// bounded; one pass stops at SCAN_MAX_ENTRIES_PER_PASS (2,000) and is labelled partial, which the
// test asserts. Then inventory pages are read at the maximum page size, cycling through every cursor.
//
// Sample counts follow the F03 floor that `measureOperationDistribution` enforces (20 warm-up,
// 200 measured), which is stricter than the task's 5/50: the helper refuses fewer.

import * as os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  INVENTORY_PAGE_MAX_ENTRIES,
  SCAN_MAX_ENTRIES_PER_PASS
} from '../../src/contracts/artifact-lifecycle/lifecycle-types';
import {
  SQLITE_BENCHMARK_MEASURED_SAMPLES,
  SQLITE_BENCHMARK_WARMUP_SAMPLES
} from '../../src/contracts/sqlite-store/schema-types';
import { measureOperationDistribution } from '../../src/services/sqlite-store';
import { lifecycleFixture, seedCheckpoint } from '../unit/artifact-lifecycle/lifecycle-fixture';

const RUN_COUNT = 100;
const ARTIFACTS_PER_RUN = 100;
const ARTIFACT_COUNT = RUN_COUNT * ARTIFACTS_PER_RUN;
const WARM_P95_BUDGET_MS = 500;
const SCAN_HEAP_BUDGET_BYTES = 32 * 1024 * 1024;
const TEST_TIMEOUT_MS = 180_000;

describe('FR-R6-F05 storage inventory at 10,000 artifacts (AC-04, SC-004)', () => {
  it(
    'reads inventory pages at warm p95 <= 500 ms and scans 10,000 entries within 32 MiB of heap',
    async () => {
      const fixture = lifecycleFixture();
      const service = fixture.build();
      for (let run = 0; run < RUN_COUNT; run += 1) {
        for (let item = 0; item < ARTIFACTS_PER_RUN; item += 1) {
          seedCheckpoint(service, fixture.fs, `art-${run}-${item}`, { ownerRunId: `run-${run}` });
        }
      }

      const heapBeforeScan = process.memoryUsage().heapUsed;
      const scanStarted = performance.now();
      const scan = await service.scanDeclaredRoots();
      const scanMs = performance.now() - scanStarted;
      const scanHeapDelta = Math.max(0, process.memoryUsage().heapUsed - heapBeforeScan);
      if (!scan.ok) throw new Error(scan.refusal.code);
      // One pass is bounded (NFR-001): a 10,000-entry tree is labelled partial, never silently complete.
      expect(scan.value.coverage).toBe('partial');
      expect(scan.value.entriesVisited).toBe(SCAN_MAX_ENTRIES_PER_PASS);

      const coldStarted = performance.now();
      const cold = service.listInventory({ pageSize: INVENTORY_PAGE_MAX_ENTRIES });
      const coldMs = performance.now() - coldStarted;
      expect(cold.ok && cold.value.entries.length).toBe(INVENTORY_PAGE_MAX_ENTRIES);

      let cursor: string | undefined;
      let seen = 0;
      const warm = measureOperationDistribution({
        operationName: 'artifact_lifecycle_inventory_page',
        warmupSamples: SQLITE_BENCHMARK_WARMUP_SAMPLES,
        measuredSamples: SQLITE_BENCHMARK_MEASURED_SAMPLES,
        step: () => {
          const page = service.listInventory({
            pageSize: INVENTORY_PAGE_MAX_ENTRIES,
            ...(cursor === undefined ? {} : { cursor })
          });
          if (!page.ok) throw new Error(page.refusal.code);
          seen += page.value.entries.length;
          cursor = page.value.nextCursor ?? undefined;
        }
      });

      console.info(
        JSON.stringify({
          platform: `${os.platform()}-${os.arch()}`,
          node: process.version,
          fixture: { rows: ARTIFACT_COUNT, scanEntries: ARTIFACT_COUNT, runs: RUN_COUNT, pageSize: INVENTORY_PAGE_MAX_ENTRIES },
          scan: {
            ms: Number(scanMs.toFixed(1)),
            heapDeltaBytes: scanHeapDelta,
            coverage: scan.value.coverage,
            entriesVisited: scan.value.entriesVisited
          },
          cold: { ms: Number(coldMs.toFixed(2)) },
          warm: { p50Ms: warm.p50Ms, p95Ms: warm.p95Ms, p99Ms: warm.p99Ms, maxMs: warm.maxMs }
        })
      );

      expect(warm.failureCount).toBe(0);
      expect(seen).toBeGreaterThan(ARTIFACT_COUNT);
      expect(warm.p95Ms).toBeLessThanOrEqual(WARM_P95_BUDGET_MS);
      expect(scanHeapDelta).toBeLessThanOrEqual(SCAN_HEAP_BUDGET_BYTES);
    },
    TEST_TIMEOUT_MS
  );
});
