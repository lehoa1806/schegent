/**
 * Feature 017 — Queue Registry (pure functions, no I/O).
 *
 * Feature 092 — multi-queue mode, restored. Feature 030 collapsed this
 * registry to exactly one entry and left the multi-queue machinery (UUIDv4
 * ids, name uniqueness, contiguous position ordering, schedules) in place as
 * shape compatibility. That machinery is live again: v10 supplies the state
 * migration and the per-queue scheduler design the collapse was waiting on.
 *
 * The three v6 assertions are gone, and one of them mattered for a reason
 * that is not obvious. `entries[0].id === DEFAULT_QUEUE_ID` was not only a
 * position check — it was also, incidentally, the check that the reserved
 * queue existed at all. Removing it without saying so would have let a
 * reorder or a delete quietly remove the queue that every un-addressed
 * enqueue falls back to, so the membership assertion below is explicit.
 *
 * Invariants (enforced by `validateQueueRegistry`, v10):
 *   - At least one entry, at most `MAX_QUEUES` (20).
 *   - An entry with `id === DEFAULT_QUEUE_ID` exists somewhere in the list,
 *     at any position.
 *   - Ids are unique and each is `'default'` or a UUIDv4.
 *   - Names are unique after trim, case-insensitively, and each is non-empty
 *     after trim and ≤ `MAX_QUEUE_NAME_LENGTH` (64).
 *   - Positions are unique and contiguous from 0.
 *   - Any entry may carry a schedule.
 *
 * Pause state is **not** here (FR-R3-011). A registry entry names, orders and
 * schedules a queue; whether it is paused lives in that queue's `QueueState`
 * and is filled in on read by `projectQueueRegistry`.
 *
 * Down-migration is unsupported. Schedule semantics live in
 * `src/lib/schedule-parser.ts`; this module only stores the parsed shape.
 */

export const DEFAULT_QUEUE_ID = 'default' as const;
// Feature 092 — restored to the v5 cap. Feature 030 reduced it to 1 for the
// single-queue collapse; the bound itself never changed meaning.
export const MAX_QUEUES = 20;
export const MAX_QUEUE_NAME_LENGTH = 64;
export const MIN_QUEUE_NAME_LENGTH = 1;

/**
 * Parsed schedule shape produced by `parseSchedule()`.
 *
 *   - `{ kind: 'relative', delayMs }`: queue resumes `delayMs` ms after the
 *     schedule was set. `delayMs` is bounded by the parser (`in <N>m|h`,
 *     1-1440 minutes or 1-24 hours).
 *   - `{ kind: 'absolute', targetAt }`: queue resumes at the computed local
 *     HH:MM next occurrence. `targetAt` is an ISO timestamp.
 */
export interface QueueSchedule {
  readonly kind: 'relative' | 'absolute';
  readonly expression: string;
  readonly targetAt: string;
  readonly setAt: string;
  readonly recurrence: 'one-shot';
}

export type QueueRegistryState = 'active' | 'manually-paused';

/**
 * Feature 028 — origin of a `manually-paused` transition.
 *
 *   - `'operator'`: the operator paused the queue directly (Queue Settings,
 *     queue-row Pause control, or saved-state restore of an already-paused
 *     queue).
 *   - `'cascade'`: the host queue auto-paused because a task in this queue
 *     hit an active-phase pause. Cascade-pause is matched by an
 *     auto-resume on task resume; an operator pause that happens while a
 *     cascade pause is active wins (the source flips to `'operator'`).
 *   - `'retry-cap'`: the host paused the queue because a delayed-retry
 *     reached the configured cap (`retry-cap-exhausted:<runId>`). Added by
 *     Feature 030 BUG-001 so the retry-handler can write through the
 *     canonical `QueueManager.setQueuePausedState` funnel without losing
 *     source attribution. Cleared by the same operator-resume path that
 *     clears `'operator'` pauses, AND by the workflow-controller's
 *     restart-active-phase / manual delayed-retry paths.
 *   - `null`: the queue is not manually paused.
 *
 * FR-R3-011 — persisted on `QueueState`, alongside the `queueLifecycle` it
 * qualifies, and projected onto a registry entry on read. The invariant
 * `pauseSource === null` iff not paused is established by
 * `projectQueueRegistry` rather than asserted across two records.
 */
export type QueuePauseSource = 'operator' | 'cascade' | 'retry-cap' | null;

/**
 * The persisted registry entry. **Carries no pause state** (FR-R3-011).
 *
 * `state` and `pauseSource` used to live here, in `KEYS.queueRegistry`, while
 * `queueLifecycle` and the legacy `paused` boolean lived in `KEYS.queue` — three
 * representations of one fact across two memento keys with no transaction
 * between them. They are gone from the persisted shape rather than merely left
 * unwritten, and that is the point: a reader that forgets to project now fails
 * to compile, where an inert-but-present field would have answered "active" for
 * a queue that is paused. Silence in the safe direction is not available here.
 *
 * `ProjectedQueueRegistryEntry` below is what readers get.
 */
export interface QueueRegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly schedule: QueueSchedule | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface QueueRegistry {
  readonly entries: readonly QueueRegistryEntry[];
  readonly updatedAt: number;
}

/**
 * A registry entry with its pause view filled in from the authoritative
 * `QueueState` (FR-R3-011).
 *
 * Structurally identical to the pre-collapse `QueueRegistryEntry`, deliberately:
 * every consumer that reads `entry.state === 'manually-paused'` keeps reading
 * exactly that, and gets an answer sourced from one place instead of a second
 * copy that a crash between two writes could have left stale.
 */
export interface ProjectedQueueRegistryEntry extends QueueRegistryEntry {
  readonly state: QueueRegistryState;
  readonly pauseSource: QueuePauseSource;
}

export interface ProjectedQueueRegistry {
  readonly entries: readonly ProjectedQueueRegistryEntry[];
  readonly updatedAt: number;
}

/**
 * The pause facts this module needs from a queue's authoritative record.
 *
 * Narrowed to two fields rather than taking `QueueState` so the registry stays
 * import-free and pure — it stores shapes, it does not reach into queue state.
 */
export interface QueuePauseView {
  readonly paused: boolean;
  readonly pauseSource: QueuePauseSource;
}

/**
 * Fill in each entry's pause view from `pauseByQueueId` (FR-R3-011).
 *
 * A queue with no entry in the map projects as `active`. That is the honest
 * answer and not a fallback with a hidden failure mode: a registry entry whose
 * `QueueState` has not been created yet has never been paused, because pausing
 * is a write to that very record.
 *
 * The `pauseSource === null` iff `state !== 'manually-paused'` invariant that
 * `validateQueueRegistry` used to assert across two persisted records now holds
 * by construction here — there is one place that builds the pair, and it builds
 * both halves from the same input.
 */
export function projectQueueRegistry(
  registry: QueueRegistry,
  pauseByQueueId: ReadonlyMap<string, QueuePauseView>
): ProjectedQueueRegistry {
  return {
    entries: registry.entries.map((entry) => {
      const view = pauseByQueueId.get(entry.id);
      const paused = view?.paused === true;
      return {
        ...entry,
        state: paused ? 'manually-paused' : 'active',
        pauseSource: paused ? view?.pauseSource ?? 'operator' : null
      };
    }),
    updatedAt: registry.updatedAt
  };
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidQueueId(id: string): boolean {
  if (id === DEFAULT_QUEUE_ID) return true;
  return UUID_V4_RE.test(id);
}

export function isValidQueueName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= MIN_QUEUE_NAME_LENGTH && trimmed.length <= MAX_QUEUE_NAME_LENGTH;
}

export function makeDefaultRegistry(now: number = Date.now()): QueueRegistry {
  return {
    entries: [
      {
        id: DEFAULT_QUEUE_ID,
        name: 'Default queue',
        position: 0,
        schedule: null,
        createdAt: now,
        updatedAt: now
      }
    ],
    updatedAt: now
  };
}

/**
 * Look a queue up by id, preserving whichever entry shape was handed in.
 *
 * Generic over the entry rather than fixed to `QueueRegistryEntry` because
 * FR-R3-011 gave the registry two read shapes: the persisted one, and the
 * projected one that carries the pause view. A non-generic signature would
 * widen a projected lookup back to the persisted entry, so a caller that had
 * correctly asked for the projection would find `state` missing again and be
 * tempted to re-derive it locally — which is the second derivation site the
 * collapse exists to remove. Callers passing a plain `QueueRegistry` are
 * unaffected: `T` infers `QueueRegistryEntry` and the result type is what it
 * always was.
 */
export function findQueue<T extends QueueRegistryEntry>(
  registry: { readonly entries: readonly T[] },
  id: string
): T | undefined {
  return registry.entries.find((e) => e.id === id);
}

export type QueueRegistryError =
  | 'unknown-queue-id'
  | 'duplicate-queue-name'
  | 'queue-cap-reached'
  | 'invalid-queue-name'
  | 'invalid-queue-id'
  | 'cannot-delete-default-queue'
  | 'invalid-queue-position'
  | 'invalid-queue-state'
  | 'invalid-registry-state';

export class QueueRegistryViolation extends Error {
  public readonly code: QueueRegistryError;
  constructor(code: QueueRegistryError, message: string) {
    super(message);
    this.code = code;
    this.name = 'QueueRegistryViolation';
  }
}

/**
 * Validate the registry as a whole. Throws `QueueRegistryViolation` on
 * structural issues; callers should treat this as a programming error.
 */
export function validateQueueRegistry(registry: QueueRegistry): void {
  if (!registry || !Array.isArray(registry.entries) || registry.entries.length === 0) {
    throw new QueueRegistryViolation(
      'invalid-registry-state',
      'QueueRegistry must contain at least one entry (the default queue)'
    );
  }
  if (registry.entries.length > MAX_QUEUES) {
    throw new QueueRegistryViolation(
      'queue-cap-reached',
      `QueueRegistry exceeds cap (${MAX_QUEUES} entries)`
    );
  }
  // Feature 092 — membership, not position. This assertion replaces the v6
  // `entries[0].id === DEFAULT_QUEUE_ID` check, which enforced *both* that the
  // reserved queue existed and that it sat first. Only the first half is a real
  // invariant; the reserved queue may be reordered like any other, and the
  // fallback target for an un-addressed enqueue must still be findable.
  const defaultEntry = registry.entries.find((e) => e.id === DEFAULT_QUEUE_ID);
  if (!defaultEntry) {
    throw new QueueRegistryViolation(
      'invalid-registry-state',
      'QueueRegistry is missing the reserved default queue'
    );
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  const positions = new Set<number>();
  for (const e of registry.entries) {
    if (!isValidQueueId(e.id)) {
      throw new QueueRegistryViolation(
        'invalid-queue-id',
        `QueueRegistry has invalid id: ${e.id}`
      );
    }
    if (ids.has(e.id)) {
      throw new QueueRegistryViolation(
        'invalid-registry-state',
        `QueueRegistry has duplicate id: ${e.id}`
      );
    }
    ids.add(e.id);
    if (!isValidQueueName(e.name)) {
      throw new QueueRegistryViolation(
        'invalid-queue-name',
        `QueueRegistry entry "${e.id}" has invalid name (must be 1-${MAX_QUEUE_NAME_LENGTH} chars after trim)`
      );
    }
    const key = queueNameKey(e.name);
    if (names.has(key)) {
      throw new QueueRegistryViolation(
        'duplicate-queue-name',
        `QueueRegistry has duplicate name: ${key}`
      );
    }
    names.add(key);
    if (!Number.isInteger(e.position) || e.position < 0) {
      throw new QueueRegistryViolation(
        'invalid-queue-position',
        `QueueRegistry entry "${e.id}" has invalid position: ${e.position}`
      );
    }
    if (positions.has(e.position)) {
      throw new QueueRegistryViolation(
        'invalid-registry-state',
        `QueueRegistry has duplicate position: ${e.position}`
      );
    }
    positions.add(e.position);
    // FR-R3-011 — the `state` / `pauseSource` checks that stood here are gone
    // with the fields. They asserted a pairing between two values this record
    // no longer holds; `projectQueueRegistry` now establishes the same pairing
    // by construction, from the one record that owns it.
  }
  for (let i = 0; i < registry.entries.length; i++) {
    if (!positions.has(i)) {
      throw new QueueRegistryViolation(
        'invalid-registry-state',
        'QueueRegistry positions must be contiguous from 0'
      );
    }
  }
}

/**
 * Create a new queue entry. Caller supplies the freshly minted UUIDv4 id
 * (so this module remains pure / clock-injectable). Throws on cap or
 * duplicate-name; returns the new registry on success.
 */
export function createQueue(
  registry: QueueRegistry,
  params: { id: string; name: string; now: number }
): QueueRegistry {
  const trimmedName = params.name.trim();
  if (!isValidQueueName(trimmedName)) {
    throw new QueueRegistryViolation(
      'invalid-queue-name',
      `Queue name must be 1-${MAX_QUEUE_NAME_LENGTH} chars after trim`
    );
  }
  if (!isValidQueueId(params.id) || params.id === DEFAULT_QUEUE_ID) {
    throw new QueueRegistryViolation(
      'invalid-queue-id',
      `Queue id must be a non-default UUIDv4 (got: ${params.id})`
    );
  }
  if (registry.entries.length >= MAX_QUEUES) {
    throw new QueueRegistryViolation(
      'queue-cap-reached',
      `Cannot create queue: cap (${MAX_QUEUES}) reached`
    );
  }
  if (registry.entries.some((e) => queueNameKey(e.name) === queueNameKey(trimmedName))) {
    throw new QueueRegistryViolation(
      'duplicate-queue-name',
      `Queue name already in use: ${trimmedName}`
    );
  }
  const next: QueueRegistryEntry = {
    id: params.id,
    name: trimmedName,
    position: registry.entries.length,
    schedule: null,
    createdAt: params.now,
    updatedAt: params.now
  };
  return {
    entries: [...registry.entries, next],
    updatedAt: params.now
  };
}

/**
 * Rename a queue. Names must remain unique. The reserved `'default'` id can
 * be renamed (the display name is purely cosmetic) but the id stays fixed.
 */
export function renameQueue(
  registry: QueueRegistry,
  params: { id: string; name: string; now: number }
): QueueRegistry {
  const trimmedName = params.name.trim();
  if (!isValidQueueName(trimmedName)) {
    throw new QueueRegistryViolation(
      'invalid-queue-name',
      `Queue name must be 1-${MAX_QUEUE_NAME_LENGTH} chars after trim`
    );
  }
  const existing = findQueue(registry, params.id);
  if (!existing) {
    throw new QueueRegistryViolation('unknown-queue-id', `Unknown queue id: ${params.id}`);
  }
  if (
    registry.entries.some((e) => e.id !== params.id && queueNameKey(e.name) === queueNameKey(trimmedName))
  ) {
    throw new QueueRegistryViolation(
      'duplicate-queue-name',
      `Queue name already in use: ${trimmedName}`
    );
  }
  return {
    entries: registry.entries.map((e) =>
      e.id === params.id ? { ...e, name: trimmedName, updatedAt: params.now } : e
    ),
    updatedAt: params.now
  };
}

/**
 * Delete a queue. The reserved `'default'` queue can never be deleted.
 * Caller is responsible for relocating or canceling that queue's pending
 * `FeatureRequest`s before invoking this — see `quickstart.md`.
 */
export function deleteQueue(
  registry: QueueRegistry,
  params: { id: string; now: number }
): QueueRegistry {
  if (params.id === DEFAULT_QUEUE_ID) {
    throw new QueueRegistryViolation(
      'cannot-delete-default-queue',
      'The default queue cannot be deleted'
    );
  }
  const existing = findQueue(registry, params.id);
  if (!existing) {
    throw new QueueRegistryViolation('unknown-queue-id', `Unknown queue id: ${params.id}`);
  }
  return {
    entries: compactQueuePositions(registry.entries.filter((e) => e.id !== params.id)),
    updatedAt: params.now
  };
}

// FR-R3-011 — `setQueueState()` and `setQueuePaused()` were deleted here, not
// deprecated. They were the registry's half of the two-key pause write, and a
// working writer for a field that no longer exists is a working template for
// reintroducing the divergence this collapse removed. Pause writes go to
// `QueueState` through `QueueManager.setQueuePausedState`, which is now a single
// write to a single key.

/**
 * Attach or clear a queue's one-shot schedule. Any entry may carry one — the
 * v6 rule that singled out `entries[0]` described a registry with only one
 * entry to single out.
 */
export function setQueueSchedule(
  registry: QueueRegistry,
  params: { id: string; schedule: QueueSchedule | null; now: number }
): QueueRegistry {
  const existing = findQueue(registry, params.id);
  if (!existing) {
    throw new QueueRegistryViolation('unknown-queue-id', `Unknown queue id: ${params.id}`);
  }
  return {
    entries: registry.entries.map((e) =>
      e.id === params.id ? { ...e, schedule: params.schedule, updatedAt: params.now } : e
    ),
    updatedAt: params.now
  };
}

function queueNameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function compactQueuePositions(entries: readonly QueueRegistryEntry[]): QueueRegistryEntry[] {
  return entries
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((entry, position) => ({ ...entry, position }));
}
