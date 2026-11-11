// FR-R6-F14 — the delivery counters and the health projection: the state order, which drops
// leave the destination's health alone, what a new destination forgets, and a snapshot that
// holds counts and closed classes only (FR-011; NFR-006).
import { describe, expect, it } from 'vitest';

import {
  COVERAGE_OUTCOMES,
  DROP_REASONS,
  EXPIRY_REASONS,
  TELEMETRY_MAPPING_REVISION,
  type DropReason
} from '../../../src/contracts/telemetry-export';
import { createHealthCounters, type HealthView } from '../../../src/services/telemetry-export/delivery-health';

const WITH_DESTINATION: HealthView = { hasDestination: true, retrying: false, queuedBatches: 0, queuedBytes: 0 };
const DELIBERATE: readonly DropReason[] = ['disabled', 'authorization-changed', 'shutdown'];

describe('delivery health', () => {
  it('starts healthy with every count at zero and one entry per closed reason', () => {
    const health = createHealthCounters().snapshot(WITH_DESTINATION);
    expect(health.state).toBe('healthy');
    expect(health.mappingRevision).toBe(TELEMETRY_MAPPING_REVISION);
    expect(health.lastSuccessAt).toBeNull();
    expect(health.lastError).toBeNull();
    expect(Object.keys(health.dropReasons).sort()).toEqual([...DROP_REASONS].sort());
    expect(Object.keys(health.expiryReasons).sort()).toEqual([...EXPIRY_REASONS].sort());
    expect(Object.keys(health.coverage).sort()).toEqual([...COVERAGE_OUTCOMES].sort());
    const counts = [...Object.values(health.dropReasons), ...Object.values(health.expiryReasons), ...Object.values(health.coverage)];
    expect(counts.every((count) => count === 0)).toBe(true);
  });

  it('is disabled without a destination, whatever else is true', () => {
    const counters = createHealthCounters();
    counters.dropped('rejected');
    expect(counters.snapshot({ ...WITH_DESTINATION, hasDestination: false, retrying: true }).state).toBe('disabled');
  });

  it('reports retrying before degraded', () => {
    const counters = createHealthCounters();
    counters.expired('retry-budget-exhausted');
    expect(counters.snapshot(WITH_DESTINATION).state).toBe('degraded');
    expect(counters.snapshot({ ...WITH_DESTINATION, retrying: true }).state).toBe('retrying');
  });

  it.each(DROP_REASONS.filter((reason) => !DELIBERATE.includes(reason)))('is degraded after a batch dropped as %s', (reason) => {
    const counters = createHealthCounters();
    counters.dropped(reason);
    const health = counters.snapshot(WITH_DESTINATION);
    expect(health.state).toBe('degraded');
    expect(health.droppedBatches).toBe(1);
    expect(health.dropReasons[reason]).toBe(1);
  });

  it.each(DELIBERATE)('stays healthy after a batch dropped as %s, and still counts it', (reason) => {
    const counters = createHealthCounters();
    counters.dropped(reason);
    const health = counters.snapshot(WITH_DESTINATION);
    expect(health.state).toBe('healthy');
    expect(health.droppedBatches).toBe(1);
    expect(health.dropReasons[reason]).toBe(1);
  });

  it('keeps a failure through a deliberate drop', () => {
    const counters = createHealthCounters();
    counters.expired('age');
    counters.dropped('shutdown');
    expect(counters.snapshot(WITH_DESTINATION).state).toBe('degraded');
  });

  it('returns to healthy on an acknowledgement, which also replaces the last error', () => {
    const counters = createHealthCounters();
    counters.error('network');
    counters.dropped('rejected');
    counters.acknowledged(1_000, 3, null);
    const clean = counters.snapshot(WITH_DESTINATION);
    expect(clean).toMatchObject({ state: 'healthy', lastSuccessAt: 1_000, lastError: null, acknowledgedBatches: 1, rejectedDataPoints: 3 });
    counters.acknowledged(2_000, 2, 'response-malformed');
    const anomalous = counters.snapshot(WITH_DESTINATION);
    expect(anomalous).toMatchObject({ state: 'healthy', lastSuccessAt: 2_000, lastError: 'response-malformed', rejectedDataPoints: 5 });
  });

  it('forgets the last error and the failed batch for a new destination, and keeps the counts', () => {
    const counters = createHealthCounters();
    counters.error('tls');
    counters.expired('age');
    counters.destinationChanged();
    const health = counters.snapshot(WITH_DESTINATION);
    expect(health).toMatchObject({ state: 'healthy', lastError: null, expiredBatches: 1 });
    expect(health.expiryReasons.age).toBe(1);
  });

  it('counts each record and offer outcome on its own counter', () => {
    const counters = createHealthCounters();
    counters.duplicateRecord();
    counters.unsupportedSchemaRecord();
    counters.unsupportedSchemaRecord();
    counters.invalidRecord();
    counters.invalidRecord();
    counters.invalidRecord();
    for (let count = 0; count < 4; count += 1) counters.refusedOffer();
    for (let count = 0; count < 5; count += 1) counters.ledgerFault();
    counters.coverage('overflow');
    const health = counters.snapshot({ ...WITH_DESTINATION, queuedBatches: 6, queuedBytes: 7 });
    expect(health).toMatchObject({
      duplicateRecords: 1,
      unsupportedSchemaRecords: 2,
      invalidRecords: 3,
      refusedOffers: 4,
      ledgerFaults: 5,
      queuedBatches: 6,
      queuedBytes: 7
    });
    expect(health.coverage.overflow).toBe(1);
    expect(health.coverage.exported).toBe(0);
  });

  it('returns a frozen snapshot that later counts do not change', () => {
    const counters = createHealthCounters();
    const before = counters.snapshot(WITH_DESTINATION);
    counters.dropped('rejected');
    counters.coverage('missing');
    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.dropReasons)).toBe(true);
    expect(Object.isFrozen(before.expiryReasons)).toBe(true);
    expect(Object.isFrozen(before.coverage)).toBe(true);
    expect(before.dropReasons.rejected).toBe(0);
    expect(before.coverage.missing).toBe(0);
  });
});
