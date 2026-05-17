/**
 * Feature 017 — Queue Registry (pure functions, no I/O).
 *
 * Feature 030 — single-queue mode. The registry collapses to exactly one
 * entry with the reserved id `'default'`. Multi-queue scaffolding (UUIDv4
 * ids, name uniqueness, contiguous position ordering, schedule fields) is
 * retained as types-only shape compatibility for the v5 → v6 migrator and
 * for forward-readability of historical audit log entries. No active code
 * path creates, renames, deletes, or attaches a schedule to a queue after
 * the v6 cutover.
 *
 * Invariants (enforced by `validateQueueRegistry`, v6):
 *   - Exactly one entry.
 *   - `entries[0].id === DEFAULT_QUEUE_ID` ('default').
 *   - `entries[0].position === 0`.
 *   - `entries[0].schedule === null`.
 *   - Pause-source invariant retained from v5:
 *     `pauseSource === null` iff `state !== 'manually-paused'`.
 *   - `name` is non-empty after trim and ≤ `MAX_QUEUE_NAME_LENGTH` (64).
 *
 * Down-migration is unsupported. Schedule semantics live in
 * `src/lib/schedule-parser.ts`; this module only stores the parsed shape.
 */

export const DEFAULT_QUEUE_ID = 'default' as const;
// Feature 030 — single-queue mode (was 20 in v5; reduced to 1 in v6).
export const MAX_QUEUES = 1;
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
 *   - `null`: the queue is not manually paused.
 *
 * Invariant (enforced by `validateQueueRegistry`):
 *   `pauseSource === null` iff `state !== 'manually-paused'`.
 */
export type QueuePauseSource = 'operator' | 'cascade' | null;

export interface QueueRegistryEntry {
  readonly id: string;
  readonly name: string;
  readonly position: number;
  readonly state: QueueRegistryState;
  readonly pauseSource: QueuePauseSource;
  readonly schedule: QueueSchedule | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface QueueRegistry {
  readonly entries: readonly QueueRegistryEntry[];
  readonly updatedAt: number;
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
        state: 'active',
        pauseSource: null,
        schedule: null,
        createdAt: now,
        updatedAt: now
      }
    ],
    updatedAt: now
  };
}

export function findQueue(registry: QueueRegistry, id: string): QueueRegistryEntry | undefined {
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
  | 'invalid-registry-state'
  // Feature 030 — single-queue invariants.
  | 'expected-single-entry'
  | 'schedule-not-supported';

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
  // Feature 030 — v6 single-queue invariant: exactly one entry.
  if (registry.entries.length !== 1) {
    throw new QueueRegistryViolation(
      'expected-single-entry',
      `QueueRegistry must contain exactly one entry in v6 (got ${registry.entries.length})`
    );
  }
  if (registry.entries.length > MAX_QUEUES) {
    throw new QueueRegistryViolation(
      'queue-cap-reached',
      `QueueRegistry exceeds cap (${MAX_QUEUES} entries)`
    );
  }
  const defaultEntry = registry.entries.find((e) => e.id === DEFAULT_QUEUE_ID);
  if (!defaultEntry) {
    throw new QueueRegistryViolation(
      'invalid-registry-state',
      'QueueRegistry is missing the reserved default queue'
    );
  }
  // Feature 030 — v6 invariant: the single entry MUST be the default-id sentinel.
  if (registry.entries[0].id !== DEFAULT_QUEUE_ID) {
    throw new QueueRegistryViolation(
      'invalid-queue-id',
      `QueueRegistry single entry must have id '${DEFAULT_QUEUE_ID}' (got '${registry.entries[0].id}')`
    );
  }
  // Feature 030 — v6 invariant: schedule MUST be null.
  if (registry.entries[0].schedule !== null) {
    throw new QueueRegistryViolation(
      'schedule-not-supported',
      `QueueRegistry single entry must have schedule === null in v6`
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
    if (e.state !== 'active' && e.state !== 'manually-paused') {
      throw new QueueRegistryViolation(
        'invalid-queue-state',
        `QueueRegistry entry "${e.id}" has invalid state: ${String(e.state)}`
      );
    }
    const expectsSource = e.state === 'manually-paused';
    const hasSource = e.pauseSource === 'operator' || e.pauseSource === 'cascade';
    if (expectsSource && !hasSource) {
      throw new QueueRegistryViolation(
        'invalid-queue-state',
        `QueueRegistry entry "${e.id}" is manually-paused but has invalid pauseSource: ${String(e.pauseSource)}`
      );
    }
    if (!expectsSource && e.pauseSource !== null) {
      throw new QueueRegistryViolation(
        'invalid-queue-state',
        `QueueRegistry entry "${e.id}" has non-null pauseSource ('${String(e.pauseSource)}') while state is '${e.state}'`
      );
    }
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
    state: 'active',
    pauseSource: null,
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

export function setQueueState(
  registry: QueueRegistry,
  params: {
    id: string;
    state: QueueRegistryState;
    /**
     * Required when `state === 'manually-paused'`; ignored otherwise (set to
     * `null` automatically). Defaults to `'operator'` when omitted on a pause
     * transition so legacy callers keep working.
     */
    pauseSource?: Exclude<QueuePauseSource, null>;
    now: number;
  }
): QueueRegistry {
  const existing = findQueue(registry, params.id);
  if (!existing) {
    throw new QueueRegistryViolation('unknown-queue-id', `Unknown queue id: ${params.id}`);
  }
  const pauseSource: QueuePauseSource =
    params.state === 'manually-paused' ? params.pauseSource ?? 'operator' : null;
  return {
    entries: registry.entries.map((e) =>
      e.id === params.id
        ? {
            ...e,
            state: params.state,
            pauseSource,
            updatedAt: params.now
          }
        : e
    ),
    updatedAt: params.now
  };
}

export function setQueuePaused(
  registry: QueueRegistry,
  params: {
    id: string;
    paused: boolean;
    /**
     * Origin of the pause transition. Defaults to `'operator'` when
     * `paused: true`; ignored when `paused: false`.
     */
    pauseSource?: Exclude<QueuePauseSource, null>;
    now: number;
  }
): QueueRegistry {
  return setQueueState(registry, {
    id: params.id,
    state: params.paused ? 'manually-paused' : 'active',
    pauseSource: params.pauseSource,
    now: params.now
  });
}

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
