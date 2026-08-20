// Feature 092 (T098, US5 — FR-061, plan.md D8) — the drill-down's addressing.
//
// Two halves, and the first is a guard rather than a feature. Slice E adds three
// tiers of navigation, and the tempting way to do that is three more nav
// siblings; the contract says otherwise. So the nav enum is pinned as
// **unchanged** — seven members, in order, landing on `operations` — because the
// regression this phase could introduce is silent: an eighth route would render
// perfectly well and would move a surface off the page it belongs under.
//
// The second half is `DashboardLocation`: tiers 2 and 3 are sub-locations
// beneath `operations`, each carrying **exactly** the ids it displays. "Exactly"
// is asserted on the key sets, not just on the values, because a location that
// also carried, say, a `taskId` would deep-link to something the tier does not
// show — and would then have to be kept in step with a selection the URL is not
// the source of truth for.
//
// Contract: specs/092-multi-queue-concurrency/contracts/snapshot-v4-and-drill-down.md §2

import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_ROUTES,
  DASHBOARD_ROUTE_LABELS,
  DEFAULT_DASHBOARD_LOCATION,
  DEFAULT_DASHBOARD_ROUTE,
  parentLocation,
  queueDetailLocation,
  runDetailLocation,
  type DashboardLocation
} from './routes';

const QUEUE_A = 'queue-a';
const RUN_1 = 'run-1';

describe('Feature 092 T098 — the nav enum is unchanged (FR-061)', () => {
  it('still has exactly the seven routes, in order', () => {
    expect(DASHBOARD_ROUTES).toEqual([
      'operations',
      'runs',
      'history',
      'metrics',
      'system',
      'builder',
      'settings'
    ]);
  });

  it('still lands on operations', () => {
    expect(DEFAULT_DASHBOARD_ROUTE).toBe('operations');
  });

  it('gains no `queue-detail` or `run-detail` nav sibling — they are sub-locations', () => {
    expect(DASHBOARD_ROUTES).not.toContain('queue-detail' as never);
    expect(DASHBOARD_ROUTES).not.toContain('run-detail' as never);
    expect(Object.keys(DASHBOARD_ROUTE_LABELS).sort()).toEqual([...DASHBOARD_ROUTES].sort());
  });

  it('keeps tier 1 on the route already labelled "Queues"', () => {
    // Tier 1 is not a new surface (contract §2, "Tier 1 is **not a new
    // surface**"). If this label ever moves, the drill-down's root moved with
    // it and the three tiers no longer share a spine.
    expect(DASHBOARD_ROUTE_LABELS.operations).toBe('Queues');
  });

  it('keeps `runs` a nav peer of tier 1 rather than a fourth tier (FR-063)', () => {
    expect(DASHBOARD_ROUTES.indexOf('runs')).toBe(DASHBOARD_ROUTES.indexOf('operations') + 1);
  });
});

describe('Feature 092 T098 — DashboardLocation addresses each tier (FR-061)', () => {
  it('defaults to the Queues tier', () => {
    expect(DEFAULT_DASHBOARD_LOCATION).toEqual({ route: 'queues' });
  });

  it('addresses Queue Detail with exactly a queueId', () => {
    const location = queueDetailLocation(QUEUE_A);
    expect(location).toEqual({ route: 'queue-detail', queueId: QUEUE_A });
    expect(Object.keys(location).sort()).toEqual(['queueId', 'route']);
  });

  it('addresses Run Detail with exactly a queueId and a runId', () => {
    const location = runDetailLocation(QUEUE_A, RUN_1);
    expect(location).toEqual({ route: 'run-detail', queueId: QUEUE_A, runId: RUN_1 });
    expect(Object.keys(location).sort()).toEqual(['queueId', 'route', 'runId']);
  });

  it('carries the queueId down to tier 3 — a Run is addressed within its queue', () => {
    // Not cosmetic: tier 3's back-navigation has to know which queue to return
    // to, and a run id alone would make that a lookup that can fail.
    expect(runDetailLocation(QUEUE_A, RUN_1).queueId).toBe(QUEUE_A);
  });

  it('freezes each location so a consumer cannot retarget a destination in place', () => {
    expect(Object.isFrozen(queueDetailLocation(QUEUE_A))).toBe(true);
    expect(Object.isFrozen(runDetailLocation(QUEUE_A, RUN_1))).toBe(true);
    expect(Object.isFrozen(DEFAULT_DASHBOARD_LOCATION)).toBe(true);
  });
});

describe('Feature 092 T098 — back-navigation walks the tiers (FR-060)', () => {
  it('takes Run Detail back to its own queue, not to the queue list', () => {
    expect(parentLocation(runDetailLocation(QUEUE_A, RUN_1))).toEqual(queueDetailLocation(QUEUE_A));
  });

  it('takes Queue Detail back to the Queues tier', () => {
    expect(parentLocation(queueDetailLocation(QUEUE_A))).toEqual(DEFAULT_DASHBOARD_LOCATION);
  });

  it('leaves the Queues tier where it is — tier 1 is the root', () => {
    expect(parentLocation(DEFAULT_DASHBOARD_LOCATION)).toEqual(DEFAULT_DASHBOARD_LOCATION);
  });

  it('reaches tier 1 from tier 3 in exactly two steps', () => {
    const tier3: DashboardLocation = runDetailLocation(QUEUE_A, RUN_1);
    expect(parentLocation(parentLocation(tier3))).toEqual(DEFAULT_DASHBOARD_LOCATION);
  });
});
