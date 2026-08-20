// Feature 099 (T496f, FR-054) — the budget is unchanged and so is the fixture
// size: 50 Phases and 20 Pipelines, resolved 100 times. What changed is where
// the rows come from. `loadCatalog` takes a store snapshot now, so the reader
// supplies only the two settings that stayed (`models`, `defaultPipelineId`) and
// the definitions arrive as a snapshot. Resolving the same number of rows is the
// same work, which is exactly why the 50 ms p95 gate carries over unmoved.

import { describe, it, expect } from 'vitest';
import { loadCatalog, type CatalogConfigReader } from '../../src/config/pipeline-config-loader';
import type { CatalogSnapshot } from '../../src/contracts/catalog-store';
import { FakeCatalogStore } from '../fixtures/fake-catalog-store';

const PHASE_COUNT = 50;
const PIPELINE_COUNT = 20;
const PHASES_PER_PIPELINE = 5;
const SAMPLES = 100;
const P95_BUDGET_MS = 50;

function buildFixture(): { phases: readonly Record<string, unknown>[]; pipelines: readonly Record<string, unknown>[] } {
  const phases: Record<string, unknown>[] = [];
  for (let i = 0; i < PHASE_COUNT; i++) {
    const id = `phase-${i.toString().padStart(2, '0')}`;
    phases.push({
      id,
      name: `Phase ${i}`,
      instruction: `Custom directive for ${id} — exercise PhaseDef ingestion across catalog merge and validation passes.`,
      loopable: i % 4 === 0,
      ...(i % 4 === 0 ? { retryCondition: 'open_questions > 0' } : {}),
      ...(i % 3 === 0 ? { model: 'claude-opus-4-7' } : {}),
      ...(i % 5 === 0 ? { effort: 'high' } : {}),
      ...(i % 7 === 0 ? { timeoutSeconds: 600 } : {})
    });
  }

  const pipelines: Record<string, unknown>[] = [];
  for (let p = 0; p < PIPELINE_COUNT; p++) {
    const phaseIds: string[] = [];
    for (let k = 0; k < PHASES_PER_PIPELINE; k++) {
      const idx = (p * PHASES_PER_PIPELINE + k) % PHASE_COUNT;
      phaseIds.push(`phase-${idx.toString().padStart(2, '0')}`);
    }
    pipelines.push({
      id: `pipeline-${p.toString().padStart(2, '0')}`,
      name: `Pipeline ${p}`,
      phases: phaseIds
    });
  }

  return { phases, pipelines };
}

function makeSnapshot(
  phases: readonly Record<string, unknown>[],
  pipelines: readonly Record<string, unknown>[]
): CatalogSnapshot {
  return new FakeCatalogStore({ phases, pipelines }).snapshot();
}

function makeReader(): CatalogConfigReader {
  return {
    getDefaultPipelineId(scope) {
      return scope === 'workspace' ? 'pipeline-00' : undefined;
    },
    getModels() {
      return undefined;
    }
  };
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx];
}

describe('loadCatalog performance (T059, plan Performance Goals)', () => {
  it(`completes in ≤ ${P95_BUDGET_MS} ms p95 with ${PHASE_COUNT} phases / ${PIPELINE_COUNT} pipelines`, () => {
    const { phases, pipelines } = buildFixture();
    const snapshot = makeSnapshot(phases, pipelines);
    const reader = makeReader();

    const warmup = loadCatalog(snapshot, reader);
    expect(warmup.errors).toEqual([]);
    expect(warmup.usedFallback).toBe(false);
    expect(warmup.catalog.phases.length).toBeGreaterThanOrEqual(PHASE_COUNT);
    expect(warmup.catalog.pipelines.length).toBeGreaterThanOrEqual(PIPELINE_COUNT);

    const samples: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const start = performance.now();
      loadCatalog(snapshot, reader);
      samples.push(performance.now() - start);
    }

    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length / 2)];
    const p95 = percentile(samples, 95);
    const max = samples[samples.length - 1];

    expect(
      p95,
      `loadCatalog p95 ${p95.toFixed(2)} ms exceeded ${P95_BUDGET_MS} ms budget (p50=${p50.toFixed(2)} ms, max=${max.toFixed(2)} ms)`
    ).toBeLessThanOrEqual(P95_BUDGET_MS);
  });
});
