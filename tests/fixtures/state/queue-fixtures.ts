/**
 * Feature 092 (T005, T006) — shared fixture builders for the v9 → v10 work.
 *
 * Two builders, used across US1, US2 and US4:
 *
 *   - `buildV9QueueState()` produces the **pre-migration** shape: one
 *     `QueueState` sitting directly at `KEYS.queue`, the way every workspace
 *     persisted at schema version 9 holds it. Migration tests read this.
 *   - `buildQueueRegistry()` produces a **post-migration** registry of N valid
 *     entries. Registry, drain and projection tests read this.
 *
 * Both default to the shapes the invariants care about rather than to empty
 * ones, because the interesting failures are all near a boundary: a queue with
 * no pending work exercises none of the preservation guarantees, and a registry
 * whose `'default'` entry sits at position zero cannot distinguish the
 * positional assertion feature 092 removes from the membership assertion it
 * adds. Callers override what they mean to vary and inherit the rest.
 */

import {
  DEFAULT_QUEUE_ID,
  type QueueRegistry,
  type QueueRegistryEntry,
  type QueueSchedule
} from '../../../src/queue/queue-registry';
import {
  type FeatureRequest,
  type QueueLifecycle,
  type QueueState
} from '../../../src/queue/feature-request';

/** Fixed clock. Fixtures must not vary run to run. */
export const FIXTURE_NOW = 1_700_000_000_000;

/**
 * Deterministic UUIDv4-shaped ids. `isValidQueueId` accepts `'default'` or a
 * v4 UUID, so a fixture queue that is not the reserved one needs a real-shaped
 * id — a readable slug like `'queue-2'` would be refused by validation and the
 * test would fail for the wrong reason.
 */
export function fixtureQueueId(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

export interface PendingTaskOptions {
  readonly id?: string;
  readonly description?: string;
  readonly position?: number;
  readonly queueId?: string;
}

/** One pending `FeatureRequest`, complete enough to survive validation. */
export function buildPendingTask(options: PendingTaskOptions = {}): FeatureRequest {
  const position = options.position ?? 0;
  return {
    id: options.id ?? `task-${position}`,
    description: options.description ?? `Pending task ${position}`,
    enqueuedAt: FIXTURE_NOW,
    createdAt: FIXTURE_NOW,
    startedAt: null,
    updatedAt: FIXTURE_NOW,
    completedAt: null,
    status: 'pending',
    queueId: options.queueId ?? DEFAULT_QUEUE_ID,
    position,
    pauseCause: null,
    runId: null,
    retryCount: 0,
    lastError: null,
    pausedReason: null
  };
}

export interface V9QueueStateOptions {
  /** How many pending tasks to seed. Default 3. */
  readonly pendingCount?: number;
  /** Seed an in-flight task with this run id. Default none. */
  readonly inFlightRunId?: string;
  readonly queueLifecycle?: QueueLifecycle;
  /**
   * Scheduled start. Left to the lockstep rule by default: supplying a
   * timestamp without also supplying `queueLifecycle: 'idle-pending'` builds
   * the one-sided state the v10 migrator must reject, which is exactly what a
   * negative test wants — so this builder does **not** silently repair it.
   */
  readonly scheduledStartAt?: number | null;
  readonly scheduledStartSource?: QueueState['scheduledStartSource'];
  readonly paused?: boolean;
  readonly migrationNotice?: QueueState['migrationNotice'];
}

function deriveLifecycle(paused: boolean, requests: readonly FeatureRequest[]): QueueLifecycle {
  if (paused) return 'operator-paused';
  if (requests.some((r) => r.status === 'in-flight')) return 'running';
  return 'active-empty';
}

/**
 * The v9 persisted shape: a single `QueueState`, no map, no queue id in the
 * key. This is what `KEYS.queue` holds before feature 092 and what
 * `migrateV9ToV10()` reads.
 */
export function buildV9QueueState(options: V9QueueStateOptions = {}): QueueState {
  const pendingCount = options.pendingCount ?? 3;
  const requests: FeatureRequest[] = [];

  if (options.inFlightRunId) {
    requests.push({
      ...buildPendingTask({ id: 'task-in-flight', position: 0 }),
      status: 'in-flight',
      startedAt: FIXTURE_NOW,
      runId: options.inFlightRunId
    });
  }

  for (let i = 0; i < pendingCount; i += 1) {
    requests.push(buildPendingTask({ position: requests.length }));
  }

  const paused = options.paused ?? false;
  return {
    requests,
    inFlightId: options.inFlightRunId ? 'task-in-flight' : null,
    paused,
    pausedReason: paused ? 'operator' : null,
    updatedAt: FIXTURE_NOW,
    queueLifecycle: options.queueLifecycle ?? deriveLifecycle(paused, requests),
    scheduledStartAt: options.scheduledStartAt ?? null,
    scheduledStartSource: options.scheduledStartSource ?? null,
    migrationNotice: options.migrationNotice ?? 'dismissed'
  };
}

export interface QueueRegistryOptions {
  /** Total entries, including the reserved `'default'`. Default 3. */
  readonly count?: number;
  /**
   * Where the reserved `'default'` entry sits. Defaults to a **non-zero**
   * position so a test cannot pass by accident under the removed
   * `entries[0].id === 'default'` assertion.
   */
  readonly defaultAtPosition?: number;
  /** Attach this schedule to every non-default entry. Default none. */
  readonly schedule?: QueueSchedule | null;
}

/**
 * A valid multi-queue registry: contiguous positions from zero, unique names,
 * exactly one `'default'` entry, pause-source paired with state.
 */
export function buildQueueRegistry(options: QueueRegistryOptions = {}): QueueRegistry {
  const count = options.count ?? 3;
  if (count < 1) throw new Error('A registry fixture needs at least the default entry');

  const defaultAt = options.defaultAtPosition ?? Math.min(1, count - 1);
  if (defaultAt < 0 || defaultAt >= count) {
    throw new Error(`defaultAtPosition ${defaultAt} is outside 0..${count - 1}`);
  }

  const entries: QueueRegistryEntry[] = [];
  for (let position = 0; position < count; position += 1) {
    const isDefault = position === defaultAt;
    entries.push({
      id: isDefault ? DEFAULT_QUEUE_ID : fixtureQueueId(position + 1),
      name: isDefault ? 'Default queue' : `Queue ${position + 1}`,
      position,
      state: 'active',
      pauseSource: null,
      schedule: isDefault ? null : (options.schedule ?? null),
      createdAt: FIXTURE_NOW,
      updatedAt: FIXTURE_NOW
    });
  }

  return { entries, updatedAt: FIXTURE_NOW };
}

/**
 * The v10 persisted shape for a registry built by `buildQueueRegistry()`:
 * one `QueueState` per entry, keyed by queue id.
 */
export function buildQueueStateMap(
  registry: QueueRegistry,
  perQueue: (entry: QueueRegistryEntry) => V9QueueStateOptions = () => ({})
): Record<string, QueueState> {
  const map: Record<string, QueueState> = {};
  for (const entry of registry.entries) {
    const state = buildV9QueueState(perQueue(entry));
    map[entry.id] = {
      ...state,
      requests: state.requests.map((r) => ({ ...r, queueId: entry.id }))
    };
  }
  return map;
}
