// FR-R6-F09 (T036; NFR-001, F09-AC-06) -- the cost admission adds to a spawn once the identity's
// version is cached.
//
// The wired gate (`wireContainmentAdmission`) with the real executable resolution and the real
// version probe, over a fake CLI written under the vitest temp root. The first admission pays for
// the probe; every measured admission reads the cached version, resolves the executable, judges
// the record and the binding, and checks the per-Run fingerprint. 20 warm-up and 200 measured
// samples, the F03 floor. Lives in the perf tier, not beside the acceptance test, per FR-R3-042.

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wireContainmentAdmission } from '../../src/activation/containment-admission-wiring';
import type { BackendRunnerKind } from '../../src/contracts/backend-kinds';
import { SHIPPED_DEFAULT_POLICY } from '../../src/contracts/process-environment-policy';
import { createCliVersionProbe } from '../../src/runner/cli-version-probe';

const WARMUP_SAMPLES = 20;
const MEASURED_SAMPLES = 200;
const P95_BUDGET_MS = 10;
const P95_RANK = 0.95;

let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'f09-admission-perf-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function percentile(samples: readonly number[], rank: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(rank * sorted.length) - 1);
  return sorted.at(index) ?? Number.POSITIVE_INFINITY;
}

describe('FR-R6-F09 admission latency from a cached identity (NFR-001)', () => {
  it('a cached admission adds at most 10 ms at p95', async () => {
    const cli = join(root, 'codex-perf');
    await writeFile(cli, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.170.0'\n", 'utf8');
    await chmod(cli, 0o755);
    const memento = new Map<string, unknown>();
    const probe = createCliVersionProbe({ environmentPolicy: () => SHIPPED_DEFAULT_POLICY });
    const granted: ReadonlySet<BackendRunnerKind> = new Set(['codex']);
    const { spawnGate } = wireContainmentAdmission({
      memento: { get: (key) => memento.get(key), update: async (key, value) => void memento.set(key, value) },
      logger: { warn: () => undefined },
      isTrusted: () => true,
      hasPrimacy: async () => true,
      environmentPolicy: SHIPPED_DEFAULT_POLICY,
      granted: () => granted,
      observeVersion: (cliPath) => probe.observe(cliPath)
    });

    for (let index = 0; index < WARMUP_SAMPLES; index += 1) {
      await spawnGate.admit('codex', { runId: `warm-${String(index)}`, cliPath: cli });
    }
    const samples: number[] = [];
    for (let index = 0; index < MEASURED_SAMPLES; index += 1) {
      const started = performance.now();
      await spawnGate.admit('codex', { runId: `run-${String(index)}`, cliPath: cli });
      samples.push(performance.now() - started);
    }

    expect(samples).toHaveLength(MEASURED_SAMPLES);
    expect(percentile(samples, P95_RANK)).toBeLessThanOrEqual(P95_BUDGET_MS);
  });
});
