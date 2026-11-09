import { describe, expect, it } from 'vitest';
import {
  RESOURCE_COLLECTOR_MAX_BYTES,
  RESOURCE_COLLECTOR_MAX_SAMPLES
} from '../../../src/contracts/runtime-resource-budgets/common-bounds';
import {
  ResourceCollector,
  createEventLoopDelayProbe,
  readEventLoopUtilization,
  readHostMemoryCategories
} from '../../../src/services/runtime-resource-budgets/resource-collector';

describe('ResourceCollector and probes (T012, T013, SC-011, FR-021)', () => {
  it('enforces 4,096-sample bound under 10,000 offers while preserving aggregates across overwrites', () => {
    const collector = new ResourceCollector();
    for (let i = 1; i <= 10_000; i += 1) {
      collector.record({
        workloadId: 'mixed-normal',
        runId: 'run-1',
        atMonotonicMs: i,
        subsystem: 'control-ledger',
        metric: 'mutation-ack-ms',
        value: i
      });
    }

    const cov = collector.sampleCoverage;
    expect(cov.observed).toBe(10_000);
    expect(cov.retained).toBe(RESOURCE_COLLECTOR_MAX_SAMPLES);
    expect(cov.overwritten).toBe(10_000 - RESOURCE_COLLECTOR_MAX_SAMPLES);
    expect(cov.currentBytes).toBeLessThanOrEqual(RESOURCE_COLLECTOR_MAX_BYTES);

    const agg = collector.getAggregate('control-ledger', 'mutation-ack-ms');
    expect(agg).toBeDefined();
    expect(agg!.observedCount).toBe(10_000);
    expect(agg!.evictedCount).toBe(10_000 - RESOURCE_COLLECTOR_MAX_SAMPLES);
    expect(agg!.min).toBe(1);
    expect(agg!.max).toBe(10_000);
    expect(agg!.lastValue).toBe(10_000);
  });

  it('enforces the 4 MiB byte bound when large sample byteEstimates arrive', () => {
    const collector = new ResourceCollector();
    const oneMib = 1024 * 1024;
    for (let i = 1; i <= 5; i += 1) {
      collector.record({
        workloadId: 'active',
        runId: 'run-1',
        atMonotonicMs: i,
        subsystem: 'stream',
        metric: 'chunk-bytes',
        value: i,
        byteEstimate: oneMib
      });
    }

    expect(collector.sampleCoverage.retained).toBe(4);
    expect(collector.sampleCoverage.overwritten).toBe(1);
    expect(collector.sampleCoverage.currentBytes).toBeLessThanOrEqual(
      RESOURCE_COLLECTOR_MAX_BYTES
    );
  });

  it('records missing probes and refused permissions as unavailable, never as 0 (SC-011)', () => {
    const missingDelay = createEventLoopDelayProbe({ monitorEventLoopDelayFn: null });
    missingDelay.start();
    const delaySnap = missingDelay.read();
    expect(delaySnap).toEqual({ status: 'unavailable', reason: 'no-supported-probe' });
    expect('p50Ms' in delaySnap).toBe(false);

    const deniedDelay = createEventLoopDelayProbe({
      monitorEventLoopDelayFn: (() => {
        throw new Error('EPERM: instrumentation permission denied');
      }) as never
    });
    deniedDelay.start();
    expect(deniedDelay.read()).toEqual({ status: 'unavailable', reason: 'permission-refused' });

    expect(readEventLoopUtilization({ eluFn: null })).toEqual({
      status: 'unavailable',
      reason: 'no-supported-probe'
    });
    expect(
      readEventLoopUtilization({
        eluFn: () => {
          throw new Error('EACCES: permission refused');
        }
      })
    ).toEqual({
      status: 'unavailable',
      reason: 'permission-refused'
    });

    const deniedMem = readHostMemoryCategories({
      memoryUsageFn: (() => {
        throw new Error('EPERM: permission refused');
      }) as never
    });
    expect(deniedMem['managed-heap']).toEqual({
      status: 'unavailable',
      reason: 'permission-refused'
    });
    expect('value' in deniedMem['managed-heap']).toBe(false);
  });

  it('labels host memory readings as host-process and keeps all 6 categories distinct', () => {
    const mem = readHostMemoryCategories({
      serializedBytes: 65_536,
      retainedApplicationBytes: 131_072,
      backendProcessMemoryBytes: null
    });

    expect(mem['serialized-bytes']).toEqual({
      status: 'measured',
      value: 65_536,
      unit: 'bytes',
      scope: 'serialized',
      derivation: 'measured'
    });
    expect(mem['retained-application-bytes']).toEqual({
      status: 'measured',
      value: 131_072,
      unit: 'bytes',
      scope: 'owned-retained',
      derivation: 'measured'
    });
    expect(mem['managed-heap'].status).toBe('measured');
    if (mem['managed-heap'].status === 'measured') {
      expect(mem['managed-heap'].scope).toBe('host-process');
      expect(mem['managed-heap'].value).toBeGreaterThan(0);
    }
    expect(mem['backend-process-memory']).toEqual({
      status: 'unavailable',
      reason: 'not-run-this-cycle'
    });
  });
});
