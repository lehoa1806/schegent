/**
 * Conformance fixtures and runner for the 9 FR-015 common bounds (`F03-AC-05`, `FR-015`,
 * `FR-016`, `SC-008`).
 *
 * Every `CommonBoundId` has at least one `limit` fixture and one `limit-plus-one` fixture.
 * `createReferenceAdapter(boundId)` binds either the F03 `ResourceCollector` (for
 * `resource-collector-window`) or the corresponding reference implementation from
 * `common-bound-references.ts` so `SC-008` ("100% of limit-plus-one cases in ... FR-015
 * refuse or degrade as specified") is verified by unit test in this cycle and reusable by
 * `F06` and `F11` when their implementations land.
 *
 * Zero `vscode` imports.
 */

import {
  COMMON_BOUND_IDS,
  type CommonBoundId,
  getCommonQueueBound
} from '../../contracts/runtime-resource-budgets/common-bounds.js';
import {
  AttemptCorrectionHistory,
  DurableIntentAcceptanceGate,
  HistoricalQueryAdmissionGate,
  HistoricalQueryWorkingDataBudget,
  LiveReportLeaseTable,
  PendingAccountingProjectionQueue,
  PendingUsageIngestionQueue,
  UnattributedUsageQueue
} from './common-bound-references.js';
import { ResourceCollector } from './resource-collector.js';

export type ConformanceCaseKind = 'limit' | 'limit-plus-one';

export interface CommonBoundConformanceFixture {
  readonly id: string;
  readonly boundId: CommonBoundId;
  readonly kind: ConformanceCaseKind;
  readonly dimension: 'items' | 'bytes' | 'ageMs' | 'executing-and-waiting' | 'lease-lifetime';
  readonly description: string;
  readonly expectedOutcome:
    | 'accepted-at-limit'
    | 'overwrite-oldest-after-aggregates'
    | 'coalesced-or-refused-coverage-gap'
    | 'expired-or-quarantined-with-omission'
    | 'refused-refill-from-durable'
    | 'paused-degraded-coverage'
    | 'refused-conflict-kept-last-accepted'
    | 'busy-or-limited-and-cancel-frees-slot'
    | 'typed-limit-refusal'
    | 'expired-or-refused-restart-required';
}

export interface CommonBoundCaseResult {
  readonly fixtureId: string;
  readonly boundId: CommonBoundId;
  readonly kind: ConformanceCaseKind;
  readonly passed: boolean;
  readonly detail: string;
}

export interface CommonBoundAdapter {
  readonly boundId: CommonBoundId;
  runFixture(fixture: CommonBoundConformanceFixture): CommonBoundCaseResult;
}

export const COMMON_BOUND_CONFORMANCE_FIXTURES: readonly CommonBoundConformanceFixture[] =
  Object.freeze([
    {
      id: 'resource-collector-window:limit',
      boundId: 'resource-collector-window',
      kind: 'limit',
      dimension: 'items',
      description: 'Accepts exactly maxItems samples without eviction or byte overflow.',
      expectedOutcome: 'accepted-at-limit'
    },
    {
      id: 'resource-collector-window:limit-plus-one',
      boundId: 'resource-collector-window',
      kind: 'limit-plus-one',
      dimension: 'items',
      description:
        'Sample N+1 overwrites the oldest raw sample only after rolling aggregates are updated.',
      expectedOutcome: 'overwrite-oldest-after-aggregates'
    },
    {
      id: 'pending-usage-ingestion:limit',
      boundId: 'pending-usage-ingestion',
      kind: 'limit',
      dimension: 'items',
      description: 'Accepts up to maxItems / maxBytes usage observations with 0 coverage gaps.',
      expectedOutcome: 'accepted-at-limit'
    },
    {
      id: 'pending-usage-ingestion:limit-plus-one',
      boundId: 'pending-usage-ingestion',
      kind: 'limit-plus-one',
      dimension: 'items',
      description:
        'At capacity, coalesces provisional counters by key and refuses non-coalescible item N+1 with a counted coverage gap.',
      expectedOutcome: 'coalesced-or-refused-coverage-gap'
    },
    {
      id: 'unattributed-usage-observations:limit',
      boundId: 'unattributed-usage-observations',
      kind: 'limit',
      dimension: 'items',
      description: 'Accepts up to maxItems unattributed observations within the 24-hour window.',
      expectedOutcome: 'accepted-at-limit'
    },
    {
      id: 'unattributed-usage-observations:limit-plus-one',
      boundId: 'unattributed-usage-observations',
      kind: 'limit-plus-one',
      dimension: 'ageMs',
      description:
        'Expires >24h entries first and quarantines/drops item N+1 at capacity with an omission count without guessing attribution.',
      expectedOutcome: 'expired-or-quarantined-with-omission'
    },
    {
      id: 'pending-accounting-projection-work:limit',
      boundId: 'pending-accounting-projection-work',
      kind: 'limit',
      dimension: 'items',
      description: 'Accepts up to maxItems unique projection references and ignores duplicates.',
      expectedOutcome: 'accepted-at-limit'
    },
    {
      id: 'pending-accounting-projection-work:limit-plus-one',
      boundId: 'pending-accounting-projection-work',
      kind: 'limit-plus-one',
      dimension: 'items',
      description:
        'Refuses reference N+1 and sets refillFromDurableRequired so the worker refills from durable intents.',
      expectedOutcome: 'refused-refill-from-durable'
    },
    {
      id: 'outstanding-accounting-intents:limit',
      boundId: 'outstanding-accounting-intents',
      kind: 'limit',
      dimension: 'items',
      description: 'Accepts durable intents up to the item and byte limits without degradation.',
      expectedOutcome: 'accepted-at-limit'
    },
    {
      id: 'outstanding-accounting-intents:limit-plus-one',
      boundId: 'outstanding-accounting-intents',
      kind: 'limit-plus-one',
      dimension: 'items',
      description:
        'Pauses new optional accounting acceptance at intent N+1, retains all previously accepted intents, and marks degradedCoverage.',
      expectedOutcome: 'paused-degraded-coverage'
    },
    {
      id: 'correction-history-per-attempt:limit',
      boundId: 'correction-history-per-attempt',
      kind: 'limit',
      dimension: 'items',
      description: 'Accepts 64 corrections within 256 KiB and updates lastAccepted.',
      expectedOutcome: 'accepted-at-limit'
    },
    {
      id: 'correction-history-per-attempt:limit-plus-one',
      boundId: 'correction-history-per-attempt',
      kind: 'limit-plus-one',
      dimension: 'items',
      description:
        'Refuses the 65th correction (and >256 KiB correction) before acceptance, preserves the 64th accepted contribution, and raises unresolvedConflict.',
      expectedOutcome: 'refused-conflict-kept-last-accepted'
    },
    {
      id: 'historical-query-concurrency:limit',
      boundId: 'historical-query-concurrency',
      kind: 'limit',
      dimension: 'executing-and-waiting',
      description: 'Admits 2 executing and 8 waiting queries within 1 MiB queued parameter bytes.',
      expectedOutcome: 'accepted-at-limit'
    },
    {
      id: 'historical-query-concurrency:limit-plus-one',
      boundId: 'historical-query-concurrency',
      kind: 'limit-plus-one',
      dimension: 'executing-and-waiting',
      description:
        'Returns busy on the 9th waiting query, returns limited when queued parameter bytes exceed 1 MiB, and removes cancelled waiting queries.',
      expectedOutcome: 'busy-or-limited-and-cancel-frees-slot'
    },
    {
      id: 'historical-query-working-data:limit',
      boundId: 'historical-query-working-data',
      kind: 'limit',
      dimension: 'bytes',
      description: 'Reserves up to 32 MiB of working data per workspace.',
      expectedOutcome: 'accepted-at-limit'
    },
    {
      id: 'historical-query-working-data:limit-plus-one',
      boundId: 'historical-query-working-data',
      kind: 'limit-plus-one',
      dimension: 'bytes',
      description: 'Refuses byte 32 MiB + 1 with typed-limit while retaining existing reservations.',
      expectedOutcome: 'typed-limit-refusal'
    },
    {
      id: 'live-report-leases:limit',
      boundId: 'live-report-leases',
      kind: 'limit',
      dimension: 'items',
      description: 'Acquires 4 concurrent leases per workspace within the 5-minute lifetime.',
      expectedOutcome: 'accepted-at-limit'
    },
    {
      id: 'live-report-leases:limit-plus-one',
      boundId: 'live-report-leases',
      kind: 'limit-plus-one',
      dimension: 'lease-lifetime',
      description:
        'Refuses the 5th concurrent lease, refuses automatic renewal, and expires leases after 5 minutes + 1 ms with restart-report-query.',
      expectedOutcome: 'expired-or-refused-restart-required'
    }
  ] satisfies readonly CommonBoundConformanceFixture[]);

export function createReferenceAdapter(boundId: CommonBoundId): CommonBoundAdapter {
  const bound = getCommonQueueBound(boundId);
  return {
    boundId,
    runFixture(fixture: CommonBoundConformanceFixture): CommonBoundCaseResult {
      switch (boundId) {
        case 'resource-collector-window':
          return runResourceCollectorFixture(fixture);
        case 'pending-usage-ingestion':
          return runPendingUsageFixture(fixture);
        case 'unattributed-usage-observations':
          return runUnattributedUsageFixture(fixture, bound.maxAgeMs ?? 86_400_000);
        case 'pending-accounting-projection-work':
          return runPendingProjectionFixture(fixture);
        case 'outstanding-accounting-intents':
          return runOutstandingIntentsFixture(fixture);
        case 'correction-history-per-attempt':
          return runCorrectionHistoryFixture(
            fixture,
            bound.maxItems ?? 64,
            bound.maxBytes ?? 262_144
          );
        case 'historical-query-concurrency':
          return runQueryConcurrencyFixture(
            fixture,
            bound.maxExecuting ?? 2,
            bound.maxItems ?? 8,
            bound.maxBytes ?? 1_048_576
          );
        case 'historical-query-working-data':
          return runWorkingDataFixture(fixture, bound.maxBytes ?? 33_554_432);
        case 'live-report-leases':
          return runReportLeaseFixture(
            fixture,
            bound.maxItems ?? 4,
            bound.fixedLifetimeMs ?? 300_000
          );
      }
    }
  };
}

function runResourceCollectorFixture(
  fixture: CommonBoundConformanceFixture
): CommonBoundCaseResult {
  const collector = new ResourceCollector({ maxSamples: 8, maxBytes: 4096 });
  for (let i = 0; i < 8; i += 1) {
    collector.record({
      workloadId: 'wl-conformance',
      runId: 'run-1',
      subsystem: 'host',
      metric: 'controlProbeLatenessMs',
      value: i + 1,
      atMonotonicMs: 1_000 + i * 10
    });
  }
  if (fixture.kind === 'limit') {
    const cov = collector.sampleCoverage;
    const passed = cov.retained === 8 && cov.overwritten === 0;
    return {
      fixtureId: fixture.id,
      boundId: fixture.boundId,
      kind: fixture.kind,
      passed,
      detail: `retained=${cov.retained}, overwritten=${cov.overwritten}`
    };
  }
  collector.record({
    workloadId: 'wl-conformance',
    runId: 'run-1',
    subsystem: 'host',
    metric: 'controlProbeLatenessMs',
    value: 25,
    atMonotonicMs: 2_000
  });
  const cov = collector.sampleCoverage;
  const agg = collector.getAggregate('host', 'controlProbeLatenessMs');
  const passed =
    cov.retained === 8 &&
    cov.overwritten === 1 &&
    agg !== undefined &&
    agg.observedCount === 9 &&
    agg.min === 1 &&
    agg.max === 25;
  return {
    fixtureId: fixture.id,
    boundId: fixture.boundId,
    kind: fixture.kind,
    passed,
    detail: `retained=${cov.retained}, overwritten=${cov.overwritten}, observed=${agg?.observedCount ?? 0}`
  };
}

function runPendingUsageFixture(fixture: CommonBoundConformanceFixture): CommonBoundCaseResult {
  const queue = new PendingUsageIngestionQueue({ maxItems: 4, maxBytes: 400 });
  for (let i = 0; i < 4; i += 1) {
    queue.offer({ key: `k-${i}`, tokens: 10, bytes: 100, provisional: true });
  }
  if (fixture.kind === 'limit') {
    const passed = queue.state.items === 4 && queue.state.coverageGapCount === 0;
    return {
      fixtureId: fixture.id,
      boundId: fixture.boundId,
      kind: fixture.kind,
      passed,
      detail: `items=${queue.state.items}, gaps=${queue.state.coverageGapCount}`
    };
  }
  const coalesced = queue.offer({ key: 'k-1', tokens: 5, bytes: 100, provisional: true });
  const refused = queue.offer({ key: 'k-new', tokens: 5, bytes: 100, provisional: false });
  const passed =
    coalesced.status === 'coalesced' &&
    refused.status === 'refused-coverage-gap' &&
    queue.state.coverageGapCount === 1 &&
    queue.state.items === 4;
  return {
    fixtureId: fixture.id,
    boundId: fixture.boundId,
    kind: fixture.kind,
    passed,
    detail: `coalesced=${coalesced.status}, refused=${refused.status}, gaps=${queue.state.coverageGapCount}`
  };
}

function runUnattributedUsageFixture(
  fixture: CommonBoundConformanceFixture,
  maxAgeMs: number
): CommonBoundCaseResult {
  const queue = new UnattributedUsageQueue({ maxItems: 4, maxBytes: 400, maxAgeMs });
  for (let i = 0; i < 4; i += 1) {
    queue.offer({ rawPayloadSummary: `obs-${i}`, bytes: 100 }, 1_000);
  }
  if (fixture.kind === 'limit') {
    const passed = queue.state.items === 4 && queue.state.omissionCount === 0;
    return {
      fixtureId: fixture.id,
      boundId: fixture.boundId,
      kind: fixture.kind,
      passed,
      detail: `items=${queue.state.items}, omissions=${queue.state.omissionCount}`
    };
  }
  const quarantined = queue.offer({ rawPayloadSummary: 'obs-overflow', bytes: 100 }, 2_000);
  const afterExpiry = queue.offer(
    { rawPayloadSummary: 'obs-fresh', bytes: 100 },
    1_000 + maxAgeMs + 1
  );
  const passed =
    quarantined.status === 'quarantined-or-expired' &&
    quarantined.omissionCount === 1 &&
    afterExpiry.status === 'accepted' &&
    afterExpiry.expiredCount === 4;
  return {
    fixtureId: fixture.id,
    boundId: fixture.boundId,
    kind: fixture.kind,
    passed,
    detail: `omissions=${quarantined.omissionCount}, expired=${afterExpiry.expiredCount}`
  };
}

function runPendingProjectionFixture(
  fixture: CommonBoundConformanceFixture
): CommonBoundCaseResult {
  const queue = new PendingAccountingProjectionQueue({ maxItems: 4, maxBytes: 400 });
  for (let i = 0; i < 4; i += 1) {
    queue.offer({ intentId: `intent-${i}`, bytes: 100 });
  }
  if (fixture.kind === 'limit') {
    const dup = queue.offer({ intentId: 'intent-0', bytes: 100 });
    const passed =
      queue.state.items === 4 &&
      dup.status === 'duplicate-ignored' &&
      !queue.state.refillFromDurableRequired;
    return {
      fixtureId: fixture.id,
      boundId: fixture.boundId,
      kind: fixture.kind,
      passed,
      detail: `items=${queue.state.items}, dup=${dup.status}`
    };
  }
  const extra = queue.offer({ intentId: 'intent-4', bytes: 100 });
  const passed =
    extra.status === 'refused-refill-from-durable' &&
    extra.refillFromDurableRequired &&
    queue.state.items === 4;
  return {
    fixtureId: fixture.id,
    boundId: fixture.boundId,
    kind: fixture.kind,
    passed,
    detail: `status=${extra.status}, refill=${extra.refillFromDurableRequired}`
  };
}

function runOutstandingIntentsFixture(
  fixture: CommonBoundConformanceFixture
): CommonBoundCaseResult {
  const gate = new DurableIntentAcceptanceGate({ maxItems: 4, maxBytes: 400 });
  for (let i = 0; i < 4; i += 1) {
    gate.accept({ intentId: `durable-${i}`, bytes: 100 });
  }
  if (fixture.kind === 'limit') {
    const passed = gate.state.items === 4 && !gate.state.degradedCoverage;
    return {
      fixtureId: fixture.id,
      boundId: fixture.boundId,
      kind: fixture.kind,
      passed,
      detail: `items=${gate.state.items}, degraded=${gate.state.degradedCoverage}`
    };
  }
  const paused = gate.accept({ intentId: 'durable-4', bytes: 100 });
  const retained = gate.retainedIntents();
  const passed =
    paused.status === 'paused-degraded-coverage' &&
    paused.degradedCoverage &&
    retained.length === 4 &&
    retained[0]?.intentId === 'durable-0';
  return {
    fixtureId: fixture.id,
    boundId: fixture.boundId,
    kind: fixture.kind,
    passed,
    detail: `status=${paused.status}, retained=${retained.length}`
  };
}

function runCorrectionHistoryFixture(
  fixture: CommonBoundConformanceFixture,
  maxItems: number,
  maxBytes: number
): CommonBoundCaseResult {
  const history = new AttemptCorrectionHistory({ maxItems, maxBytes });
  for (let i = 1; i <= maxItems; i += 1) {
    history.submit({ revision: i, contributionTokens: i * 10, bytes: 1024 });
  }
  if (fixture.kind === 'limit') {
    const passed =
      history.state.items === maxItems &&
      !history.state.unresolvedConflict &&
      history.state.lastAccepted?.revision === maxItems;
    return {
      fixtureId: fixture.id,
      boundId: fixture.boundId,
      kind: fixture.kind,
      passed,
      detail: `items=${history.state.items}, lastRevision=${history.state.lastAccepted?.revision ?? 0}`
    };
  }
  const extraCount = history.submit({
    revision: maxItems + 1,
    contributionTokens: 9999,
    bytes: 512
  });
  const byteHistory = new AttemptCorrectionHistory({ maxItems, maxBytes });
  byteHistory.submit({ revision: 1, contributionTokens: 50, bytes: maxBytes });
  const extraBytes = byteHistory.submit({ revision: 2, contributionTokens: 60, bytes: 1 });
  const passed =
    extraCount.status === 'refused-conflict' &&
    extraCount.unresolvedConflict &&
    extraCount.lastAccepted?.revision === maxItems &&
    extraBytes.status === 'refused-conflict' &&
    extraBytes.lastAccepted?.revision === 1;
  return {
    fixtureId: fixture.id,
    boundId: fixture.boundId,
    kind: fixture.kind,
    passed,
    detail: `extraCount=${extraCount.status}, extraBytes=${extraBytes.status}, keptRev=${extraCount.lastAccepted?.revision ?? 0}`
  };
}

function runQueryConcurrencyFixture(
  fixture: CommonBoundConformanceFixture,
  maxExecuting: number,
  maxWaiting: number,
  maxBytes: number
): CommonBoundCaseResult {
  const gate = new HistoricalQueryAdmissionGate({
    maxExecuting,
    maxWaiting,
    maxQueuedParameterBytes: maxBytes
  });
  for (let i = 0; i < maxExecuting; i += 1) {
    gate.submit({ queryId: `exec-${i}`, parameterBytes: 1024 });
  }
  for (let i = 0; i < maxWaiting; i += 1) {
    gate.submit({ queryId: `wait-${i}`, parameterBytes: 1024 });
  }
  if (fixture.kind === 'limit') {
    const passed =
      gate.state.executingCount === maxExecuting && gate.state.waitingCount === maxWaiting;
    return {
      fixtureId: fixture.id,
      boundId: fixture.boundId,
      kind: fixture.kind,
      passed,
      detail: `executing=${gate.state.executingCount}, waiting=${gate.state.waitingCount}`
    };
  }
  const ninthWaiting = gate.submit({ queryId: 'wait-overflow', parameterBytes: 1024 });
  const cancelled = gate.cancel('wait-0');
  const byteOverflow = gate.submit({ queryId: 'wait-huge', parameterBytes: maxBytes });
  const admittedAfterCancel = gate.submit({ queryId: 'wait-replaces', parameterBytes: 1024 });
  const passed =
    ninthWaiting.status === 'busy' &&
    cancelled &&
    byteOverflow.status === 'limited' &&
    admittedAfterCancel.status === 'waiting';
  return {
    fixtureId: fixture.id,
    boundId: fixture.boundId,
    kind: fixture.kind,
    passed,
    detail: `ninth=${ninthWaiting.status}, byteOverflow=${byteOverflow.status}, afterCancel=${admittedAfterCancel.status}`
  };
}

function runWorkingDataFixture(
  fixture: CommonBoundConformanceFixture,
  maxBytes: number
): CommonBoundCaseResult {
  const budget = new HistoricalQueryWorkingDataBudget({ maxBytes });
  const atLimit = budget.reserve(maxBytes);
  if (fixture.kind === 'limit') {
    const passed = atLimit.status === 'reserved' && budget.state.allocatedBytes === maxBytes;
    return {
      fixtureId: fixture.id,
      boundId: fixture.boundId,
      kind: fixture.kind,
      passed,
      detail: `status=${atLimit.status}, bytes=${budget.state.allocatedBytes}`
    };
  }
  const plusOne = budget.reserve(1);
  const passed = plusOne.status === 'typed-limit' && budget.state.allocatedBytes === maxBytes;
  return {
    fixtureId: fixture.id,
    boundId: fixture.boundId,
    kind: fixture.kind,
    passed,
    detail: `status=${plusOne.status}, bytes=${budget.state.allocatedBytes}`
  };
}

function runReportLeaseFixture(
  fixture: CommonBoundConformanceFixture,
  maxLeases: number,
  leaseLifetimeMs: number
): CommonBoundCaseResult {
  const table = new LiveReportLeaseTable({ maxLeases, leaseLifetimeMs });
  for (let i = 0; i < maxLeases; i += 1) {
    table.acquire(`lease-${i}`, 1_000);
  }
  if (fixture.kind === 'limit') {
    const active = table.useLease('lease-0', 1_000 + leaseLifetimeMs);
    const passed = table.state.activeLeases === maxLeases && active.status === 'active';
    return {
      fixtureId: fixture.id,
      boundId: fixture.boundId,
      kind: fixture.kind,
      passed,
      detail: `activeLeases=${table.state.activeLeases}, useAtBoundary=${active.status}`
    };
  }
  const fifth = table.acquire('lease-4', 1_000);
  const renewal = table.renew() as { readonly status: string; readonly instruction: string };
  const expired = table.useLease('lease-0', 1_000 + leaseLifetimeMs + 1);
  const passed =
    fifth.status === 'refused-lease-limit' &&
    renewal.status === 'refused-no-automatic-renewal' &&
    expired.status === 'expired-restart-required';
  return {
    fixtureId: fixture.id,
    boundId: fixture.boundId,
    kind: fixture.kind,
    passed,
    detail: `fifth=${fifth.status}, renewal=${renewal.status}, expired=${expired.status}`
  };
}

export function runCommonBoundConformance(
  adapter: CommonBoundAdapter
): readonly CommonBoundCaseResult[] {
  const fixtures = COMMON_BOUND_CONFORMANCE_FIXTURES.filter(
    (fixture) => fixture.boundId === adapter.boundId
  );
  return fixtures.map((fixture) => adapter.runFixture(fixture));
}

export function runAllReferenceBoundConformance(): readonly CommonBoundCaseResult[] {
  return COMMON_BOUND_IDS.flatMap((boundId) =>
    runCommonBoundConformance(createReferenceAdapter(boundId))
  );
}
