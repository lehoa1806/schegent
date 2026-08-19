// FR-R3-011 (T425) — the v12 → v13 pause collapse, over every disagreement.
//
// Three persisted representations answered "is this queue paused" before the
// collapse, so there are eight combinations of what a workspace can arrive
// carrying. Six of them are disagreements that no test could reach before,
// because the code that produced them was a lost write rather than a code path.
// Enumerating all eight is the only way to state the winner as a rule instead of
// as whichever case someone thought to write down.
//
// The rule under test: **any representation reading paused wins**, and a queue
// that resolves to *not* paused keeps its `queueLifecycle` verbatim.

import { describe, expect, it } from 'vitest';
import {
  migrateV12ToV13,
  type QueuePauseDivergenceResolvedAuditEvent,
  type QueueStateMap,
  type StateMigratedV12ToV13AuditEvent
} from '../../../src/state/queue-state-migrator';
import type { QueueState } from '../../../src/queue/feature-request';
import type { QueueRegistry, QueueRegistryEntry } from '../../../src/queue/queue-registry';

const NOW = 1_700_000_000_000;

/** A persisted registry entry as pre-collapse builds wrote it. */
type LegacyEntry = QueueRegistryEntry & {
  state?: 'active' | 'manually-paused';
  pauseSource?: 'operator' | 'cascade' | 'retry-cap' | null;
};

/** A persisted queue record as pre-collapse builds wrote it. */
type LegacyQueueState = QueueState & { paused?: boolean };

function legacyEntry(overrides: Partial<LegacyEntry> = {}): LegacyEntry {
  return {
    id: 'default',
    name: 'Default',
    position: 0,
    schedule: null,
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    state: 'active',
    pauseSource: null,
    ...overrides
  };
}

function legacyRegistry(entries: readonly LegacyEntry[]): QueueRegistry {
  return { entries: entries as unknown as QueueRegistryEntry[], updatedAt: NOW - 1000 };
}

function legacyQueue(overrides: Partial<LegacyQueueState> = {}): LegacyQueueState {
  return {
    requests: [],
    inFlightId: null,
    paused: false,
    pausedReason: null,
    updatedAt: NOW - 1000,
    queueLifecycle: 'active-empty',
    pauseSource: null,
    scheduledStartAt: null,
    scheduledStartSource: null,
    ...overrides
  };
}

function reshapeEvent(
  events: ReturnType<typeof migrateV12ToV13>['auditEvents']
): StateMigratedV12ToV13AuditEvent {
  const found = events.find((event) => event.type === 'state-migrated-v12-to-v13');
  expect(found, 'the collapse always emits its reshape event').toBeDefined();
  return found as StateMigratedV12ToV13AuditEvent;
}

function divergenceEvents(
  events: ReturnType<typeof migrateV12ToV13>['auditEvents']
): readonly QueuePauseDivergenceResolvedAuditEvent[] {
  return events.filter(
    (event) => event.type === 'queue-pause-divergence-resolved'
  ) as readonly QueuePauseDivergenceResolvedAuditEvent[];
}

describe('FR-R3-011 — v12 → v13 queue pause collapse', () => {
  // Every combination of the three pre-collapse representations. `lifecycle` is
  // the value the record carried, which is `operator-paused` exactly when that
  // representation said paused; the non-paused value differs per case only to
  // prove the collapse preserves whatever was there.
  const COMBINATIONS = [
    { registry: false, lifecycle: false, mirror: false, resolved: false, agreed: true },
    { registry: false, lifecycle: false, mirror: true, resolved: true, agreed: false },
    { registry: false, lifecycle: true, mirror: false, resolved: true, agreed: false },
    { registry: false, lifecycle: true, mirror: true, resolved: true, agreed: false },
    { registry: true, lifecycle: false, mirror: false, resolved: true, agreed: false },
    { registry: true, lifecycle: false, mirror: true, resolved: true, agreed: false },
    { registry: true, lifecycle: true, mirror: false, resolved: true, agreed: false },
    { registry: true, lifecycle: true, mirror: true, resolved: true, agreed: true }
  ] as const;

  for (const combination of COMBINATIONS) {
    const label =
      `registry=${combination.registry} lifecycle=${combination.lifecycle} ` +
      `mirror=${combination.mirror}`;

    it(`resolves ${label} to paused=${combination.resolved}`, () => {
      const queueStates: QueueStateMap = {
        default: legacyQueue({
          paused: combination.mirror,
          queueLifecycle: combination.lifecycle ? 'operator-paused' : 'active-empty'})
      };
      const registry = legacyRegistry([
        legacyEntry({
          state: combination.registry ? 'manually-paused' : 'active',
          pauseSource: combination.registry ? 'operator' : null
        })
      ]);

      const result = migrateV12ToV13(queueStates, registry, NOW);

      expect(result.changed).toBe(true);
      const collapsed = result.queueStates.default!;
      expect(collapsed.queueLifecycle === 'operator-paused').toBe(combination.resolved);
      // The mirror is gone from the record, not set to false. Absence is what
      // `needsPauseCollapse()` keys on, so a `paused: false` left behind would
      // re-run the migration on every load.
      expect('paused' in collapsed).toBe(false);
      // The pairing is established by construction: a source exists exactly when
      // the queue is paused.
      expect(collapsed.pauseSource === null).toBe(!combination.resolved);
    });

    it(`${combination.agreed ? 'stays silent' : 'reports the divergence'} for ${label}`, () => {
      const result = migrateV12ToV13(
        {
          default: legacyQueue({
            paused: combination.mirror,
            queueLifecycle: combination.lifecycle ? 'operator-paused' : 'active-empty'})
        },
        legacyRegistry([
          legacyEntry({
            state: combination.registry ? 'manually-paused' : 'active',
            pauseSource: combination.registry ? 'operator' : null
          })
        ]),
        NOW
      );

      const divergences = divergenceEvents(result.auditEvents);
      expect(divergences).toHaveLength(combination.agreed ? 0 : 1);
      if (combination.agreed) return;
      expect(divergences[0]).toEqual({
        type: 'queue-pause-divergence-resolved',
        occurredAt: NOW,
        queueId: 'default',
        registryPaused: combination.registry,
        lifecyclePaused: combination.lifecycle,
        mirrorPaused: combination.mirror,
        resolvedPaused: combination.resolved,
        resolvedPauseSource: combination.resolved ? 'operator' : null,
        reason: 'any-representation-paused-wins'
      });
    });
  }

  it('keeps a non-paused lifecycle verbatim rather than re-deriving one', () => {
    // The retired reconciler re-derived from `(inFlightId, paused, pending)`,
    // which promoted a legitimately held `idle-pending` to `running` on the
    // strength of an unrelated disagreement. This queue has an in-flight task
    // and is deliberately marked `idle-pending`; the collapse must not touch it.
    const result = migrateV12ToV13(
      {
        default: legacyQueue({
          paused: false,
          inFlightId: 'task-1',
          queueLifecycle: 'idle-pending',
          pauseSource: null,
          scheduledStartAt: NOW + 60_000,
          scheduledStartSource: 'operator-chooser'
        })
      },
      legacyRegistry([legacyEntry()]),
      NOW
    );

    const collapsed = result.queueStates.default!;
    expect(collapsed.queueLifecycle).toBe('idle-pending');
    expect(collapsed.scheduledStartAt).toBe(NOW + 60_000);
    expect(collapsed.pauseSource).toBeNull();
  });

  it('clears an armed restore when the queue resolves to paused', () => {
    // The `scheduledStartAt` ⟷ `idle-pending` lockstep is per entry and holds
    // after the collapse as it did before: a queue that resolves to
    // `operator-paused` cannot also be carrying an armed scheduled start.
    const result = migrateV12ToV13(
      {
        default: legacyQueue({
          paused: true,
          queueLifecycle: 'idle-pending',
          pauseSource: null,
          scheduledStartAt: NOW + 60_000,
          scheduledStartSource: 'programmatic-scheduled'
        })
      },
      legacyRegistry([legacyEntry()]),
      NOW
    );

    const collapsed = result.queueStates.default!;
    expect(collapsed.queueLifecycle).toBe('operator-paused');
    expect(collapsed.scheduledStartAt).toBeNull();
    expect(collapsed.scheduledStartSource).toBeNull();
  });

  it('preserves a recorded cascade attribution and does not promote it to operator', () => {
    const result = migrateV12ToV13(
      { default: legacyQueue({ paused: true, queueLifecycle: 'operator-paused'}) },
      legacyRegistry([legacyEntry({ state: 'manually-paused', pauseSource: 'cascade' })]),
      NOW
    );

    expect(result.queueStates.default!.pauseSource).toBe('cascade');
  });

  it('attributes a paused queue with no recorded source to the operator', () => {
    // Conservative on purpose: an operator pause outranks a cascade one, and a
    // cascade resume must leave it standing. Guessing `cascade` here would let
    // the next cascade resume silently undo an operator's pause.
    const result = migrateV12ToV13(
      { default: legacyQueue({ paused: true, queueLifecycle: 'active-empty'}) },
      legacyRegistry([legacyEntry()]),
      NOW
    );

    expect(result.queueStates.default!.pauseSource).toBe('operator');
  });

  it('keeps the pause reason when paused and clears it when not', () => {
    const result = migrateV12ToV13(
      {
        paused: legacyQueue({
          paused: true,
          queueLifecycle: 'operator-paused',
          pauseSource: null,
          pausedReason: 'retry-cap-exhausted:run-9'
        }),
        running: legacyQueue({
          paused: false,
          queueLifecycle: 'active-empty',
          pauseSource: null,
          pausedReason: 'retry-cap-exhausted:run-8'
        })
      },
      legacyRegistry([legacyEntry({ id: 'paused' }), legacyEntry({ id: 'running', position: 1 })]),
      NOW
    );

    expect(result.queueStates.paused!.pausedReason).toBe('retry-cap-exhausted:run-9');
    expect(result.queueStates.running!.pausedReason).toBeNull();
  });

  it('strips the derived pause fields from every registry entry', () => {
    const result = migrateV12ToV13(
      { default: legacyQueue({ paused: true, queueLifecycle: 'operator-paused'}) },
      legacyRegistry([
        legacyEntry({ state: 'manually-paused', pauseSource: 'operator' }),
        legacyEntry({ id: 'q2', position: 1 })
      ]),
      NOW
    );

    for (const entry of result.registry.entries) {
      expect('state' in entry).toBe(false);
      expect('pauseSource' in entry).toBe(false);
      // Everything the registry does own survives untouched.
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.name.length).toBeGreaterThan(0);
    }
    expect(result.registry.updatedAt).toBe(NOW - 1000);
  });

  it('resolves a queue with no registry entry from its own record alone', () => {
    // A queue state with no matching entry is a torn record, not an error. The
    // representation that is present decides; the absent one contributes
    // nothing rather than voting "not paused".
    const result = migrateV12ToV13(
      { orphan: legacyQueue({ paused: true, queueLifecycle: 'active-empty'}) },
      legacyRegistry([]),
      NOW
    );

    expect(result.queueStates.orphan!.queueLifecycle).toBe('operator-paused');
    expect(result.queueStates.orphan!.pauseSource).toBe('operator');
  });

  it('reports the reshape once, counting paused and divergent queues', () => {
    const result = migrateV12ToV13(
      {
        a: legacyQueue({ paused: true, queueLifecycle: 'operator-paused'}),
        b: legacyQueue({ paused: true, queueLifecycle: 'active-empty'}),
        c: legacyQueue({ paused: false, queueLifecycle: 'active-empty'})
      },
      legacyRegistry([
        legacyEntry({ id: 'a', state: 'manually-paused', pauseSource: 'operator' }),
        legacyEntry({ id: 'b', position: 1 }),
        legacyEntry({ id: 'c', position: 2 })
      ]),
      NOW
    );

    const reshape = reshapeEvent(result.auditEvents);
    expect(reshape).toEqual({
      type: 'state-migrated-v12-to-v13',
      fromVersion: 12,
      toVersion: 13,
      occurredAt: NOW,
      queueIds: ['a', 'b', 'c'],
      pausedQueueCount: 2,
      divergentQueueCount: 1
    });
    // The reshape event leads, so a reader sees the migration before the
    // per-queue detail it explains.
    expect(result.auditEvents[0]!.type).toBe('state-migrated-v12-to-v13');
  });

  it('carries no operator-authored text into the audit payloads', () => {
    // Queue names are operator-authored. The structured audit log carries queue
    // identifiers, booleans and closed tokens only (FR-038a).
    const result = migrateV12ToV13(
      { default: legacyQueue({ paused: true, queueLifecycle: 'active-empty'}) },
      legacyRegistry([legacyEntry({ name: 'Nightly refactor sweep' })]),
      NOW
    );

    const serialized = JSON.stringify(result.auditEvents);
    expect(serialized).not.toContain('Nightly refactor sweep');
  });

  it('is a no-op on an already-collapsed record, so nothing is written', () => {
    const collapsed = migrateV12ToV13(
      { default: legacyQueue({ paused: true, queueLifecycle: 'operator-paused'}) },
      legacyRegistry([legacyEntry({ state: 'manually-paused', pauseSource: 'operator' })]),
      NOW
    );

    const again = migrateV12ToV13(collapsed.queueStates, collapsed.registry, NOW);

    expect(again.changed).toBe(false);
    expect(again.auditEvents).toEqual([]);
    // Identity, not deep equality: `changed: false` means the caller writes
    // nothing, and returning a fresh copy would invite one.
    expect(again.queueStates).toBe(collapsed.queueStates);
    expect(again.registry).toBe(collapsed.registry);
  });

  it('treats a half-collapsed record as pre-collapse', () => {
    // One queue collapsed, one not — the exact half-written shape a lost second
    // write produces. Keying on "any entry still legacy" is what makes the
    // migration finish the job rather than skip it.
    const partial: QueueStateMap = {
      done: legacyQueue({ queueLifecycle: 'active-empty'}) as QueueState,
      pending: legacyQueue({ paused: true, queueLifecycle: 'active-empty'})
    };
    delete (partial.done as LegacyQueueState).paused;

    const result = migrateV12ToV13(partial, legacyRegistry([]), NOW);

    expect(result.changed).toBe(true);
    expect('paused' in result.queueStates.pending!).toBe(false);
    expect(result.queueStates.pending!.queueLifecycle).toBe('operator-paused');
    expect(result.queueStates.done!.queueLifecycle).toBe('active-empty');
  });

  it('collapses an empty workspace without inventing a queue', () => {
    // No queues and a registry that still carries the legacy fields: the record
    // is pre-collapse, so the registry is rewritten and nothing is fabricated.
    const result = migrateV12ToV13({}, legacyRegistry([legacyEntry()]), NOW);

    expect(result.changed).toBe(true);
    expect(result.queueStates).toEqual({});
    expect(reshapeEvent(result.auditEvents).queueIds).toEqual([]);
  });
});
