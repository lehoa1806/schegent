// FR-R4-F03 (FR-015, FR-016, FR-018; contract C1, C2, C4, C6; data-model §4, §5; R14 to R16) — the head
// checkpoint's pure core: its shape, its key, its parse, the loss classification and the writer's mode
// table. No I/O and no `vscode`.
//
// WHAT A CHECKPOINT IS FOR. The hash chain makes an edit EVIDENT, but it sits on the same disk as the log,
// so it cannot notice that the end of the log was removed, or that every audit file was. The checkpoint
// is the digest and position of the newest row that landed, kept OUTSIDE the workspace
// (`audit-checkpoint-store.ts`), so removing `.schegent/` cannot remove it. A history that no longer
// reaches it is reported as lost. It holds a digest, a count, times and states, and nothing else: no
// content, no path, no run id (contract C7).
//
// IT MAKES NO CLAIM IT CANNOT KEEP. It does not stop an actor who can write the extension's storage as
// the same OS user, and it says nothing about entries after the checkpoint, so every "consistent" reading
// is worded as "only entries after it could be missing undetected" (threat-model T3, FR-021).
import { createHash } from 'node:crypto';
import type { ChainCheck } from './audit-chain';

/** The state of a stored checkpoint file. `retired` is what a deliberate reset leaves behind. */
export type CheckpointState = 'active' | 'retired';
/** Where the history a checkpoint tracks began, as the writer found it. */
export type CheckpointOrigin = 'new' | 'adopted' | 'reset';

const CHECKPOINT_STATES: readonly string[] = ['active', 'retired'];
const CHECKPOINT_ORIGINS: readonly string[] = ['new', 'adopted', 'reset'];
const CHECKPOINT_VERSION = 1;
const KEY_DOMAIN = 'schegent-audit-checkpoint-v1\0';

export interface AuditHeadCheckpointV1 {
  readonly version: 1;
  /** The file's own key: 64 lowercase hex characters, never a path or a slug of one. */
  readonly workspaceKey: string;
  readonly state: CheckpointState;
  readonly origin: CheckpointOrigin;
  /** Digest of the newest landed row. `''` only while retired. */
  readonly headDigest: string;
  /** That row's chain position. 0 only while retired. */
  readonly position: number;
  readonly establishedAtMs: number;
  readonly updatedAtMs: number;
  /** Present iff `state === 'retired'`. */
  readonly retiredAtMs?: number;
  /** Present iff `state === 'retired'`. */
  readonly retiredPosition?: number;
}

/** What a read of the stored checkpoint answered. It never throws, and never treats a bad file as absent. */
export type CheckpointRead =
  | { readonly status: 'absent' }
  | { readonly status: 'active' | 'retired'; readonly checkpoint: AuditHeadCheckpointV1 }
  | {
      readonly status: 'unreadable';
      readonly reason: 'corrupt' | 'version-unknown' | 'unreachable';
    };

/** The writer's side of the checkpoint: one read, one atomic write. Absent means "no checkpoint". */
export interface AuditCheckpointPort {
  /** The key this port's file is stored under, which every record it writes carries as `workspaceKey`. */
  readonly key: string;
  read(): Promise<CheckpointRead>;
  write(next: AuditHeadCheckpointV1, options?: { readonly force?: boolean }): Promise<void>;
}

/** A write was refused because the stored file could not be read, and so must not be overwritten (R15). */
export class CheckpointNotWritableError extends Error {
  public constructor() {
    super('the stored audit checkpoint is unreadable, so it was not overwritten');
    this.name = 'CheckpointNotWritableError';
  }
}

/**
 * The key a workspace's checkpoint is stored under: the lowercase hex SHA-256 of a domain prefix and the
 * real path. The full 64 characters and no readable slug, so the key reveals nothing of the path
 * (FR-019), unlike a prefixed slug; the prefix keeps it from matching any other hash of the same path.
 */
export function checkpointKey(realRoot: string): string {
  return createHash('sha256').update(`${KEY_DOMAIN}${realRoot}`).digest('hex');
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Parse a stored checkpoint file. A file that is not this release's reading is NEVER absent: bad JSON,
 * wrong field types and a key that is not the file's own are `corrupt`, and a `version` this release does
 * not know is `version-unknown` and is not read any further (a newer release's file is not ours to judge,
 * and not ours to overwrite).
 */
export function parseCheckpoint(text: string, key: string): CheckpointRead {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { status: 'unreadable', reason: 'corrupt' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { status: 'unreadable', reason: 'corrupt' };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.version !== 'number') return { status: 'unreadable', reason: 'corrupt' };
  if (record.version !== CHECKPOINT_VERSION) return { status: 'unreadable', reason: 'version-unknown' };

  const { workspaceKey, state, origin, headDigest, position, establishedAtMs, updatedAtMs } = record;
  const wellFormed =
    workspaceKey === key
    && typeof state === 'string' && CHECKPOINT_STATES.includes(state)
    && typeof origin === 'string' && CHECKPOINT_ORIGINS.includes(origin)
    && typeof headDigest === 'string'
    && isCount(position)
    && isTime(establishedAtMs)
    && isTime(updatedAtMs);
  if (!wellFormed) return { status: 'unreadable', reason: 'corrupt' };

  const base = {
    version: CHECKPOINT_VERSION,
    workspaceKey,
    origin: origin as CheckpointOrigin,
    headDigest,
    position,
    establishedAtMs,
    updatedAtMs
  } as const;
  if (state === 'active') {
    return { status: 'active', checkpoint: { ...base, state: 'active' } };
  }
  const { retiredAtMs, retiredPosition } = record;
  if (!isTime(retiredAtMs) || !isCount(retiredPosition)) return { status: 'unreadable', reason: 'corrupt' };
  return { status: 'retired', checkpoint: { ...base, state: 'retired', retiredAtMs, retiredPosition } };
}

/** The seven states a verification can find (data-model §5). */
export type LossState =
  | { readonly state: 'new-workspace' }
  | { readonly state: 'consistent'; readonly position: number }
  | { readonly state: 'adopted'; readonly position: number; readonly adoptedAtMs: number }
  | {
      readonly state: 'shorter';
      readonly expected: number;
      readonly found: number;
      readonly detail: 'tail-removed' | 'head-absent';
    }
  | { readonly state: 'missing'; readonly expected: number }
  | { readonly state: 'no-checkpoint-for-location' }
  | {
      readonly state: 'not-performed';
      readonly reason:
        | 'checkpoint-unreadable'
        | 'checkpoint-version-unknown'
        | 'checkpoint-unreachable'
        | 'chain-not-intact';
    };

const UNREADABLE_REASON = {
  corrupt: 'checkpoint-unreadable',
  'version-unknown': 'checkpoint-version-unknown',
  unreachable: 'checkpoint-unreachable'
} as const;

/**
 * Classify what a verification found, top to bottom: the first matching row wins (data-model §5).
 *
 * A checkpoint that cannot be read, or a chain that is not intact (a position past a break is not one
 * the verifier would reproduce), is `not-performed`: it is never a clean verdict and never says the
 * history is complete. A head the walk finds where the checkpoint says, or whose position retention
 * legitimately removed, is `consistent`. Anything else with an active checkpoint is `shorter`, with the
 * counts that show it, or `missing` when no audit file is left at all. The same head at ANOTHER position
 * is a rewrite with recomputed links, so it is `shorter` and not `consistent`.
 */
export function classifyLoss(read: CheckpointRead, check: ChainCheck | null): LossState {
  if (read.status === 'unreadable') {
    return { state: 'not-performed', reason: UNREADABLE_REASON[read.reason] };
  }
  const verdict = check?.verdict;
  if (verdict !== undefined && !verdict.ok) return { state: 'not-performed', reason: 'chain-not-intact' };
  if (read.status !== 'active') {
    return check === null ? { state: 'new-workspace' } : { state: 'no-checkpoint-for-location' };
  }
  const { position, origin, establishedAtMs } = read.checkpoint;
  if (verdict === undefined) return { state: 'missing', expected: position };

  const { probe, prunedThrough, tail } = verdict.positions;
  if (probe?.foundAt === position || position <= prunedThrough) {
    return origin === 'adopted'
      ? { state: 'adopted', position, adoptedAtMs: establishedAtMs }
      : { state: 'consistent', position };
  }
  return tail < position
    ? { state: 'shorter', expected: position, found: tail, detail: 'tail-removed' }
    : { state: 'shorter', expected: position, found: tail, detail: 'head-absent' };
}

/** What the writer does with the checkpoint at its next landed rows (R15). */
export type CheckpointMode = 'new' | 'adopt' | 'track' | 'loss' | 'reset' | 'off';

/** What the writer knows about the chain when it settles its mode. */
export interface SettleFacts {
  /** Whether any `audit.log*` chain file exists. */
  readonly filesPresent: boolean;
  /** The digest of the last valid row, or null when there is none. */
  readonly tailDigest: string | null;
  /** The walk, with the checkpoint head as its probe, or null when none was needed or possible. */
  readonly walk: ChainCheck | null;
}

export interface CheckpointSettlement {
  readonly mode: CheckpointMode;
  /** The chain position of the last landed row: where the next advance counts from. 0 when none. */
  readonly position: number;
}

/**
 * Settle the writer's checkpoint mode from what the checkpoint and the chain say (R15's table).
 *
 * `loss` never advances, and that is the point: advancing over a truncated tail would make the next
 * verification find a consistent checkpoint and erase the finding. `off` never writes, because an
 * unreadable file may be a newer release's, and a walk that is not intact gives no position the verifier
 * would reproduce. The cheap case, the head being the tail, needs no walk at all.
 */
export function settleCheckpointMode(read: CheckpointRead, facts: SettleFacts): CheckpointSettlement {
  if (read.status === 'unreadable') return { mode: 'off', position: 0 };
  const verdict = facts.walk?.verdict;
  const intact = verdict !== undefined && verdict.ok;

  if (read.status !== 'active') {
    if (!facts.filesPresent) return { mode: read.status === 'retired' ? 'reset' : 'new', position: 0 };
    return intact ? { mode: 'adopt', position: verdict.positions.tail } : { mode: 'off', position: 0 };
  }

  const { headDigest, position } = read.checkpoint;
  if (!facts.filesPresent) return { mode: 'loss', position: 0 };
  if (facts.tailDigest !== null && facts.tailDigest === headDigest) return { mode: 'track', position };
  if (!intact) return { mode: 'off', position: 0 };

  const { probe, prunedThrough, tail } = verdict.positions;
  return probe?.foundAt === position || position <= prunedThrough
    ? { mode: 'track', position: tail }
    : { mode: 'loss', position: 0 };
}
