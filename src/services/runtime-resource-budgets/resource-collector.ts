/**
 * FR-R6-F03 — Harness-only bounded resource collector and feature-detected runtime
 * probes (FR-002, FR-003, FR-015, FR-018, FR-021, SC-011, clarification Q4).
 *
 * The collector runs only when explicitly instantiated by the qualification harness;
 * nothing starts at extension activation.
 *
 * Zero `vscode` imports.
 */

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import {
  RESOURCE_COLLECTOR_MAX_BYTES,
  RESOURCE_COLLECTOR_MAX_SAMPLES
} from '../../contracts/runtime-resource-budgets/common-bounds';
import type {
  MemoryCategory,
  MetricReading,
  Sample,
  UnavailableReason
} from '../../contracts/runtime-resource-budgets/qualification-record';
import { BoundedWindow, type BoundedOfferOutcome } from './bounded-window';

export interface MetricAggregate {
  readonly metric: string;
  readonly subsystem: string;
  readonly observedCount: number;
  readonly evictedCount: number;
  readonly min: number;
  readonly max: number;
  readonly sum: number;
  readonly lastValue: number;
}

export interface SampleCoverage {
  readonly observed: number;
  readonly retained: number;
  readonly overwritten: number;
  readonly currentBytes: number;
}

export interface ResourceCollectorOptions {
  readonly maxSamples?: number;
  readonly maxBytes?: number;
  readonly clock?: () => number;
}

interface MutableAggregate {
  metric: string;
  subsystem: string;
  observedCount: number;
  evictedCount: number;
  min: number;
  max: number;
  sum: number;
  lastValue: number;
}

const DEFAULT_SAMPLE_BYTE_ESTIMATE = 128;

export function estimateSampleBytes(sample: Sample): number {
  if (sample.byteEstimate !== undefined && sample.byteEstimate > 0) {
    return sample.byteEstimate;
  }
  return (
    DEFAULT_SAMPLE_BYTE_ESTIMATE +
    Buffer.byteLength(sample.workloadId, 'utf8') +
    Buffer.byteLength(sample.runId, 'utf8') +
    Buffer.byteLength(sample.subsystem, 'utf8') +
    Buffer.byteLength(sample.metric, 'utf8')
  );
}

export class ResourceCollector {
  private readonly window: BoundedWindow<Sample>;
  private readonly aggregatesByKey = new Map<string, MutableAggregate>();

  constructor(options: ResourceCollectorOptions = {}) {
    this.window = new BoundedWindow<Sample>({
      maxItems: options.maxSamples ?? RESOURCE_COLLECTOR_MAX_SAMPLES,
      maxBytes: options.maxBytes ?? RESOURCE_COLLECTOR_MAX_BYTES,
      overflow: 'overwrite-oldest',
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
      onEvict: (evicted) => {
        const key = `${evicted.subsystem}:${evicted.metric}`;
        const agg = this.aggregatesByKey.get(key);
        if (agg !== undefined) {
          agg.evictedCount += 1;
        }
      }
    });
  }

  record(sample: Sample): BoundedOfferOutcome {
    const bytes = estimateSampleBytes(sample);
    const key = `${sample.subsystem}:${sample.metric}`;
    let agg = this.aggregatesByKey.get(key);
    if (agg === undefined) {
      agg = {
        metric: sample.metric,
        subsystem: sample.subsystem,
        observedCount: 0,
        evictedCount: 0,
        min: sample.value,
        max: sample.value,
        sum: 0,
        lastValue: sample.value
      };
      this.aggregatesByKey.set(key, agg);
    }
    agg.observedCount += 1;
    if (sample.value < agg.min) agg.min = sample.value;
    if (sample.value > agg.max) agg.max = sample.value;
    agg.sum += sample.value;
    agg.lastValue = sample.value;

    return this.window.offer(sample, bytes, sample.atMonotonicMs, sample.atMonotonicMs);
  }

  get sampleCoverage(): SampleCoverage {
    const counters = this.window.counters;
    return {
      observed: counters.observed,
      retained: this.window.size,
      overwritten: counters.overwritten,
      currentBytes: this.window.currentBytes
    };
  }

  retainedSamples(metric?: string): readonly Sample[] {
    const all = this.window.items();
    if (metric === undefined) return all;
    return all.filter((s) => s.metric === metric);
  }

  getAggregate(subsystem: string, metric: string): MetricAggregate | undefined {
    const agg = this.aggregatesByKey.get(`${subsystem}:${metric}`);
    if (agg === undefined) return undefined;
    return { ...agg };
  }

  allAggregates(): readonly MetricAggregate[] {
    return Array.from(this.aggregatesByKey.values(), (agg) => ({ ...agg }));
  }
}

function classifyProbeError(err: unknown): UnavailableReason {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (/EACCES|EPERM|ERR_ACCESS_DENIED|permission/i.test(msg)) {
    return 'permission-refused';
  }
  return 'no-supported-probe';
}

export type EventLoopDelaySnapshot =
  | {
      readonly status: 'measured';
      readonly p50Ms: number;
      readonly p95Ms: number;
      readonly p99Ms: number;
      readonly maxMs: number;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: UnavailableReason;
    };

export interface EventLoopDelayProbe {
  start(): void;
  read(): EventLoopDelaySnapshot;
  stop(): void;
}

export function createEventLoopDelayProbe(deps?: {
  readonly monitorEventLoopDelayFn?: typeof monitorEventLoopDelay | null;
  readonly resolutionMs?: number;
}): EventLoopDelayProbe {
  const fn =
    deps !== undefined && 'monitorEventLoopDelayFn' in deps
      ? deps.monitorEventLoopDelayFn
      : monitorEventLoopDelay;

  if (typeof fn !== 'function') {
    return {
      start: () => undefined,
      read: () => ({ status: 'unavailable', reason: 'no-supported-probe' }),
      stop: () => undefined
    };
  }

  let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
  let failureReason: UnavailableReason | null = null;

  return {
    start(): void {
      try {
        histogram = fn({ resolution: deps?.resolutionMs ?? 10 });
        histogram.enable();
      } catch (err) {
        failureReason = classifyProbeError(err);
        histogram = null;
      }
    },
    read(): EventLoopDelaySnapshot {
      if (failureReason !== null) {
        return { status: 'unavailable', reason: failureReason };
      }
      if (histogram === null) {
        return { status: 'unavailable', reason: 'no-supported-probe' };
      }
      try {
        const nsToMs = (ns: number): number =>
          Number.isFinite(ns) && ns >= 0 ? ns / 1_000_000 : 0;
        return {
          status: 'measured',
          p50Ms: nsToMs(histogram.percentile(50)),
          p95Ms: nsToMs(histogram.percentile(95)),
          p99Ms: nsToMs(histogram.percentile(99)),
          maxMs: nsToMs(histogram.max)
        };
      } catch (err) {
        return { status: 'unavailable', reason: classifyProbeError(err) };
      }
    },
    stop(): void {
      try {
        histogram?.disable();
      } catch {
        // best-effort
      }
    }
  };
}

export function readEventLoopUtilization(deps?: {
  readonly eluFn?: typeof performance.eventLoopUtilization | null;
}): MetricReading {
  const fn =
    deps !== undefined && 'eluFn' in deps ? deps.eluFn : performance.eventLoopUtilization;
  if (typeof fn !== 'function') {
    return { status: 'unavailable', reason: 'no-supported-probe' };
  }
  try {
    const elu = fn();
    return {
      status: 'measured',
      value: elu.utilization,
      unit: 'ratio',
      scope: 'host-process',
      derivation: 'measured'
    };
  } catch (err) {
    return { status: 'unavailable', reason: classifyProbeError(err) };
  }
}

export interface HostMemoryProbeInput {
  readonly serializedBytes?: number;
  readonly retainedApplicationBytes?: number;
  readonly backendProcessMemoryBytes?: number | null;
  readonly backendUnavailableReason?: UnavailableReason;
  readonly memoryUsageFn?: typeof process.memoryUsage | null;
}

/**
 * Read the six distinct memory categories (FR-002, FR-018, SC-011).
 * Host-process readings carry `scope: 'host-process'` and are never labeled `total-system`.
 * Missing probes or refused permissions map to `status: 'unavailable'`, never `0`.
 */
export function readHostMemoryCategories(
  input: HostMemoryProbeInput = {}
): Readonly<Record<MemoryCategory, MetricReading>> {
  const memFn =
    'memoryUsageFn' in input ? input.memoryUsageFn : process.memoryUsage;

  let hostHeap: MetricReading;
  let hostExternal: MetricReading;
  let hostRss: MetricReading;

  if (typeof memFn !== 'function') {
    const unavail: MetricReading = { status: 'unavailable', reason: 'no-supported-probe' };
    hostHeap = unavail;
    hostExternal = unavail;
    hostRss = unavail;
  } else {
    try {
      const mem = memFn();
      hostHeap = {
        status: 'measured',
        value: mem.heapUsed,
        unit: 'bytes',
        scope: 'host-process',
        derivation: 'measured'
      };
      hostExternal = {
        status: 'measured',
        value: mem.external + mem.arrayBuffers,
        unit: 'bytes',
        scope: 'host-process',
        derivation: 'measured'
      };
      hostRss = {
        status: 'measured',
        value: mem.rss,
        unit: 'bytes',
        scope: 'host-process',
        derivation: 'measured'
      };
    } catch (err) {
      const reason = classifyProbeError(err);
      const unavail: MetricReading = { status: 'unavailable', reason };
      hostHeap = unavail;
      hostExternal = unavail;
      hostRss = unavail;
    }
  }

  const serialized: MetricReading =
    input.serializedBytes !== undefined
      ? {
          status: 'measured',
          value: input.serializedBytes,
          unit: 'bytes',
          scope: 'serialized',
          derivation: 'measured'
        }
      : { status: 'unavailable', reason: 'not-run-this-cycle' };

  const retainedApp: MetricReading =
    input.retainedApplicationBytes !== undefined
      ? {
          status: 'measured',
          value: input.retainedApplicationBytes,
          unit: 'bytes',
          scope: 'owned-retained',
          derivation: 'measured'
        }
      : { status: 'unavailable', reason: 'not-run-this-cycle' };

  const backendMem: MetricReading =
    typeof input.backendProcessMemoryBytes === 'number'
      ? {
          status: 'measured',
          value: input.backendProcessMemoryBytes,
          unit: 'bytes',
          scope: 'backend-process',
          derivation: 'measured'
        }
      : {
          status: 'unavailable',
          reason: input.backendUnavailableReason ?? 'not-run-this-cycle'
        };

  return Object.freeze({
    'serialized-bytes': serialized,
    'retained-application-bytes': retainedApp,
    'managed-heap': hostHeap,
    'external-buffer-allocation': hostExternal,
    'process-resident-memory': hostRss,
    'backend-process-memory': backendMem
  });
}
