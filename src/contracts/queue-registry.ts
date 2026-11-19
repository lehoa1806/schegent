/**
 * FR-R7-07 — Pure Queue Registry shapes and helper functions relocated from
 * `src/queue/queue-registry.ts` into `src/contracts/` so `src/state/` can
 * validate, normalize, and project queue registries without importing the
 * `queue/` acting layer. `src/queue/queue-registry.ts` re-exports every symbol
 * unchanged for full backward compatibility.
 *
 * Feature 017 / Feature 092 / FR-R3-011 — pure functions, no I/O.
 */

import { DEFAULT_QUEUE_ID } from './queue-identity';
import { MAX_QUEUES, MAX_QUEUE_NAME_LENGTH } from './queue-bounds';
import {
  effectiveQueueFailurePolicy,
  type QueueFailurePolicy
} from './queue-failure-policy';

export const MIN_QUEUE_NAME_LENGTH = 1;

/**
 * Parsed schedule shape produced by `parseSchedule()`.
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
 * Feature 028 / FR-R3-011 — origin of a `manually-paused` transition,
 * persisted on `QueueState` alongside `queueLifecycle` and projected onto a
 * registry entry on read.
 */
export type QueuePauseSource = 'operator' | 'cascade' | 'retry-cap' | null;

/**
 * Persisted registry entry. Carries no pause state (FR-R3-011).
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
 * Registry entry with pause view and failure policy projected from `QueueState`.
 */
export interface ProjectedQueueRegistryEntry extends QueueRegistryEntry {
  readonly state: QueueRegistryState;
  readonly pauseSource: QueuePauseSource;
  readonly failurePolicy: QueueFailurePolicy;
  readonly failurePolicyOverride: QueueFailurePolicy | null;
}

export interface ProjectedQueueRegistry {
  readonly entries: readonly ProjectedQueueRegistryEntry[];
  readonly updatedAt: number;
}

/**
 * Narrow pause facts projected from a queue's authoritative record.
 */
export interface QueuePauseView {
  readonly paused: boolean;
  readonly pauseSource: QueuePauseSource;
}

export function projectQueueRegistry(
  registry: QueueRegistry,
  pauseByQueueId: ReadonlyMap<string, QueuePauseView>,
  failurePolicyByQueueId: ReadonlyMap<string, QueueFailurePolicy | undefined> = new Map(),
  workspaceFailurePolicyDefault: QueueFailurePolicy = 'halt-on-failure'
): ProjectedQueueRegistry {
  return {
    entries: registry.entries.map((entry) => {
      const view = pauseByQueueId.get(entry.id);
      const paused = view?.paused === true;
      const storedFailurePolicy = failurePolicyByQueueId.get(entry.id);
      return {
        ...entry,
        state: paused ? 'manually-paused' : 'active',
        pauseSource: paused ? view.pauseSource ?? 'operator' : null,
        failurePolicy: effectiveQueueFailurePolicy(
          storedFailurePolicy,
          workspaceFailurePolicyDefault
        ),
        failurePolicyOverride: storedFailurePolicy ?? null
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

export function validateQueueRegistry(registry: QueueRegistry): void {
  const candidate: unknown = registry;
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    !Array.isArray((candidate as QueueRegistry).entries) ||
    (candidate as QueueRegistry).entries.length === 0
  ) {
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
    registry.entries.some(
      (e) => e.id !== params.id && queueNameKey(e.name) === queueNameKey(trimmedName)
    )
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
