// FR-R6-F14 T029 (NFR-003, F14-AC-05) -- mapping and enqueueing one bounded batch.
//
// One sample is one `offer` of 256 source records to an authorized exporter: each record is
// validated, checked against the remembered copies, mapped, passed through the attribute-set
// limit and added to the open batch; the 256th record seals the batch, which encodes the request
// body and puts it in the delivery queue. The records are built before the clock starts and the
// delivery of the sealed batch ends after it stops, so a sample holds the synchronous work a
// caller of `offer` waits for and nothing else.
//
// The reference batch is 192 usage records of five measures, 48 operation records and 16
// corrections over eight model pairs and two backends. 20 warm-up and 200 measured samples, the
// F03 floor. Lives in the perf tier, not beside the acceptance test, per FR-R3-042.

import { describe, expect, it } from 'vitest';

import { TELEMETRY_EXPORT_BOUNDS } from '../../src/contracts/telemetry-export';
import { createHarness } from '../fixtures/telemetry-export/exporter-harness';
import { correctionRecord, cost, measure, operationRecord, usageRecord } from '../fixtures/telemetry-export/source-records';

const WARMUP_SAMPLES = 20;
const MEASURED_SAMPLES = 200;
const P95_BUDGET_MS = 5;
const P50_RANK = 0.5;
const P95_RANK = 0.95;
const BATCH_RECORDS = TELEMETRY_EXPORT_BOUNDS.batchRecordsMax;
const USAGE_RECORDS = 192;
const OPERATION_RECORDS = 48;
const MODEL_PAIRS = 8;
const BACKENDS = ['claude', 'codex'] as const;

function percentile(samples: readonly number[], rank: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(rank * sorted.length) - 1);
  return sorted.at(index) ?? Number.POSITIVE_INFINITY;
}

/** The reference batch of one sample; every source identity is new, so nothing is a duplicate. */
function referenceBatch(sample: number): unknown[] {
  return Array.from({ length: BATCH_RECORDS }, (_unused, index) => {
    const model = index % MODEL_PAIRS;
    const labels = {
      sourceId: `sample-${String(sample)}-${String(index)}`,
      backend: BACKENDS.at(index % BACKENDS.length) ?? 'claude',
      modelRequested: `model-${String(model)}`,
      modelReported: `model-${String(model)}-20260101`
    };
    if (index < USAGE_RECORDS) {
      return usageRecord({
        ...labels,
        measures: [
          measure({ quantity: String(1_000 + index) }),
          measure({ measure: 'output_tokens', quantity: String(200 + index) }),
          measure({ measure: 'cache_read_tokens', quantity: '320', cacheRelation: 'subset-of-input' }),
          measure({ measure: 'cache_creation_tokens', quantity: '160', cacheRelation: 'disjoint' }),
          cost(String(1_500 + index))
        ]
      });
    }
    if (index < USAGE_RECORDS + OPERATION_RECORDS) return operationRecord({ ...labels, durationMs: 900 + index });
    return correctionRecord({}, labels);
  });
}

describe('FR-R6-F14 telemetry export mapping latency (NFR-003)', () => {
  it('validates, maps and enqueues one 256-record batch in at most 5 ms at p95', async () => {
    const harness = createHarness();
    harness.authorize();
    const samples: number[] = [];
    let accepted = 0;

    for (let sample = 0; sample < WARMUP_SAMPLES + MEASURED_SAMPLES; sample += 1) {
      const batch = referenceBatch(sample);
      const started = performance.now();
      const result = harness.exporter.offer(batch);
      const elapsed = performance.now() - started;
      if (sample >= WARMUP_SAMPLES) {
        samples.push(elapsed);
        accepted += result.accepted;
      }
      // Outside the sample: the sealed batch is delivered and acknowledged before the next one.
      await harness.exporter.idle();
    }

    const p50 = percentile(samples, P50_RANK);
    const p95 = percentile(samples, P95_RANK);
    console.info(JSON.stringify({ samples: samples.length, recordsPerSample: BATCH_RECORDS, p50Ms: p50, p95Ms: p95 }));
    expect(samples).toHaveLength(MEASURED_SAMPLES);
    // Every sample did the whole of the work: all records accepted, one sealed batch each, all sent.
    expect(accepted).toBe(MEASURED_SAMPLES * BATCH_RECORDS);
    const health = harness.exporter.health();
    expect(health.acknowledgedBatches).toBe(WARMUP_SAMPLES + MEASURED_SAMPLES);
    expect(health).toMatchObject({ droppedBatches: 0, expiredBatches: 0, queuedBatches: 0, duplicateRecords: 0, invalidRecords: 0 });
    expect(health.coverage.overflow).toBe(0);
    expect(harness.transport.requests).toHaveLength(WARMUP_SAMPLES + MEASURED_SAMPLES);
    expect(p95).toBeLessThanOrEqual(P95_BUDGET_MS);
  });
});
