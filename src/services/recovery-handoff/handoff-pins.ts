/**
 * FR-R6-F08 (research R4, R5) — the F05 pins a recovery handoff holds on the artifacts it names.
 *
 * Every pin is a protective F05 reference owned by `('handoff', handoffId)`. Pins are per
 * handoff, not per revision: the F05 key carries no revision.
 *
 * A purpose cannot change in place (the F05 reference id hashes it), so a switch adds the new
 * purpose for an artifact before it releases any other purpose this handoff holds on it. The
 * artifact is never unprotected between the two (NFR-005). The target purpose is stored on the
 * handoff row while a switch is in flight, so reconciliation after a restart can finish it.
 *
 * One F05 slot per owner stays in reserve: a handoff pins at most
 * `ARTIFACT_PINS_PER_OWNER_MAX - 1` distinct artifacts, so the add that starts each step of a
 * switch always fits under the F05 quota.
 *
 * Every write names only this handoff's own keys, so another owner's reference to the same
 * artifact is never released here (FR-011, FR-017).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

import { ARTIFACT_PINS_PER_OWNER_MAX } from '../../contracts/artifact-lifecycle/lifecycle-types';
import {
  CLOSED_HANDOFF_STATES,
  HANDOFF_PIN_PURPOSES,
  type HandoffOwnerResolution,
  type HandoffPinPurpose,
  type HandoffState
} from '../../contracts/recovery-handoff/handoff-types';
import { SQLITE_SCHEMA_CURRENT_VERSION } from '../../contracts/sqlite-store/schema-types';
import type { ArtifactLifecycleService } from '../artifact-lifecycle';
import type { NodeSqliteConnection } from '../sqlite-store';
import type { HandoffRow, ReferenceRow } from './handoff-store-rows';
import type { SqliteHandoffStore } from './handoff-store';

/** F05 slots a handoff leaves free so a purpose switch can always add before it releases. */
export const HANDOFF_PIN_RESERVE = 1;

/** The most distinct artifacts one handoff pins. */
export const HANDOFF_PIN_LIMIT = ARTIFACT_PINS_PER_OWNER_MAX - HANDOFF_PIN_RESERVE;

const QUOTA_REFUSAL = 'pin-quota-reached';

/** The two F05 writes this module makes; a narrow port so a test can observe each one. */
export type HandoffPinLifecycle = Pick<ArtifactLifecycleService, 'addReference' | 'releaseReference'>;

export interface HandoffPinDeps {
  readonly store: SqliteHandoffStore;
  readonly lifecycle: HandoffPinLifecycle;
  readonly nowMs: () => number;
}

export interface PinRefusal {
  readonly artifactId: string;
  readonly required: boolean;
  /** The F05 refusal code, or `pin-quota-reached` from the handoff reserve. */
  readonly code: string;
}

export interface PinRevisionResult {
  readonly refusals: readonly PinRefusal[];
}

export interface SwitchResult {
  /** False when an add was refused; the old pins stay and the target stays recorded. */
  readonly complete: boolean;
}

export interface ReconcileResult {
  readonly switchFinished: boolean;
  /** Reference rows that moved from `pending` or `refused` to `pinned`. */
  readonly pinsRetried: number;
}

/** R4: the purpose a handoff in this state pins under; null once it is closed. */
export function pinPurposeFor(state: HandoffState, paused: boolean): HandoffPinPurpose | null {
  if (CLOSED_HANDOFF_STATES.has(state)) return null;
  if (paused) return 'paused-recovery';
  return state === 'uncertain' ? 'uncertain-recovery' : 'pending-handoff';
}

function handoffKey(handoffId: string, artifactId: string, purpose: HandoffPinPurpose) {
  return { artifactId, ownerType: 'handoff' as const, ownerId: handoffId, purpose };
}

function isClosed(handoff: HandoffRow): boolean {
  return CLOSED_HANDOFF_STATES.has(handoff.state);
}

function pinnedArtifacts(store: SqliteHandoffStore, handoffId: string): Set<string> {
  const rows = store.listReferencesForHandoff(handoffId);
  return new Set(rows.filter((row) => row.pinState === 'pinned').map((row) => row.artifactId));
}

/** New pins go under the in-flight target, else the stored purpose, else the state's purpose. */
function holdingPurpose(handoff: HandoffRow): HandoffPinPurpose | null {
  return handoff.pinPurposeTarget ?? handoff.pinPurpose ?? pinPurposeFor(handoff.state, handoff.paused);
}

function pinOne(
  deps: HandoffPinDeps,
  row: ReferenceRow,
  purpose: HandoffPinPurpose,
  held: Set<string>
): PinRefusal | null {
  const { store, lifecycle } = deps;
  if (!held.has(row.artifactId) && held.size >= HANDOFF_PIN_LIMIT) {
    store.setPinState(row.handoffId, row.revisionNo, row.artifactId, 'refused', QUOTA_REFUSAL);
    return { artifactId: row.artifactId, required: row.required, code: QUOTA_REFUSAL };
  }
  const added = lifecycle.addReference({ ...handoffKey(row.handoffId, row.artifactId, purpose), protective: true });
  if (!added.ok) {
    store.setPinState(row.handoffId, row.revisionNo, row.artifactId, 'refused', added.refusal.code);
    return { artifactId: row.artifactId, required: row.required, code: added.refusal.code };
  }
  store.setPinState(row.handoffId, row.revisionNo, row.artifactId, 'pinned', null);
  held.add(row.artifactId);
  return null;
}

/**
 * Pins every not-yet-pinned reference of one revision. Idempotent: a pinned row is skipped and
 * an F05 add of an active key is a no-op. A refused row is retried on the next call.
 */
export function pinRevision(deps: HandoffPinDeps, handoffId: string, revisionNo: number): PinRevisionResult {
  const handoff = deps.store.getHandoff(handoffId);
  if (handoff === undefined || isClosed(handoff)) return { refusals: [] };
  const purpose = holdingPurpose(handoff);
  if (purpose === null) return { refusals: [] };
  if (handoff.pinPurpose === null) deps.store.updateHandoff(handoffId, { pinPurpose: purpose }, deps.nowMs());
  const held = pinnedArtifacts(deps.store, handoffId);
  const refusals: PinRefusal[] = [];
  const rows = deps.store.listReferences(handoffId, revisionNo);
  // Required first: when the limit bites, it refuses an optional reference if one is left.
  const ordered = [...rows.filter((row) => row.required), ...rows.filter((row) => !row.required)];
  for (const row of ordered) {
    if (row.pinState === 'pinned' || row.pinState === 'released') continue;
    const refusal = pinOne(deps, row, purpose, held);
    if (refusal !== null) refusals.push(refusal);
  }
  return { refusals };
}

/** Per artifact: add the target, then release every other purpose this handoff holds on it. */
function finishSwitch(deps: HandoffPinDeps, handoffId: string, target: HandoffPinPurpose): SwitchResult {
  let complete = true;
  for (const artifactId of pinnedArtifacts(deps.store, handoffId)) {
    const added = deps.lifecycle.addReference({ ...handoffKey(handoffId, artifactId, target), protective: true });
    if (!added.ok) {
      complete = false;
      continue;
    }
    for (const purpose of HANDOFF_PIN_PURPOSES) {
      if (purpose === target) continue;
      deps.lifecycle.releaseReference({ ...handoffKey(handoffId, artifactId, purpose), reason: 'owner-durable' });
    }
  }
  if (complete) {
    deps.store.updateHandoff(handoffId, { pinPurpose: target, pinPurposeTarget: null }, deps.nowMs());
  }
  return { complete };
}

/** R4: moves every pin of a live handoff to `target`, make-before-break. */
export function switchPurpose(deps: HandoffPinDeps, handoffId: string, target: HandoffPinPurpose): SwitchResult {
  const handoff = deps.store.getHandoff(handoffId);
  if (handoff === undefined || isClosed(handoff)) return { complete: false };
  if (handoff.pinPurpose === target && handoff.pinPurposeTarget === null) return { complete: true };
  if (handoff.pinPurpose === null) {
    deps.store.updateHandoff(handoffId, { pinPurpose: target, pinPurposeTarget: null }, deps.nowMs());
    return { complete: true };
  }
  deps.store.updateHandoff(handoffId, { pinPurposeTarget: target }, deps.nowMs());
  return finishSwitch(deps, handoffId, target);
}

/** Ends every pin this handoff holds, under every purpose; another owner's keys are never named. */
export function releaseAll(deps: HandoffPinDeps, handoffId: string): void {
  const rows = deps.store.listReferencesForHandoff(handoffId);
  for (const artifactId of new Set(rows.map((row) => row.artifactId))) {
    for (const purpose of HANDOFF_PIN_PURPOSES) {
      deps.lifecycle.releaseReference({ ...handoffKey(handoffId, artifactId, purpose), reason: 'owner-durable' });
    }
  }
  for (const row of rows) {
    if (row.pinState !== 'pinned' && row.pinState !== 'pending') continue;
    deps.store.setPinState(handoffId, row.revisionNo, row.artifactId, 'released', null);
  }
  deps.store.updateHandoff(handoffId, { pinPurposeTarget: null }, deps.nowMs());
}

function switchTarget(handoff: HandoffRow): HandoffPinPurpose | null {
  if (handoff.pinPurposeTarget !== null) return handoff.pinPurposeTarget;
  const desired = pinPurposeFor(handoff.state, handoff.paused);
  if (desired === null || handoff.pinPurpose === null || desired === handoff.pinPurpose) return null;
  return desired;
}

function retryRefusedPins(deps: HandoffPinDeps, handoffId: string): number {
  const open = deps.store
    .listReferencesForHandoff(handoffId)
    .filter((row) => row.pinState === 'pending' || row.pinState === 'refused');
  for (const revisionNo of new Set(open.map((row) => row.revisionNo))) {
    pinRevision(deps, handoffId, revisionNo);
  }
  const after = deps.store.listReferencesForHandoff(handoffId);
  return open.filter((row) =>
    after.some(
      (now) => now.revisionNo === row.revisionNo && now.artifactId === row.artifactId && now.pinState === 'pinned'
    )
  ).length;
}

/**
 * Restart reconciliation for one handoff: a closed handoff releases what an interrupted close
 * left; a live one finishes any in-flight or missed purpose switch, then retries refused pins.
 */
export function reconcilePins(deps: HandoffPinDeps, handoffId: string): ReconcileResult {
  const handoff = deps.store.getHandoff(handoffId);
  if (handoff === undefined) return { switchFinished: false, pinsRetried: 0 };
  if (isClosed(handoff)) {
    releaseAll(deps, handoffId);
    return { switchFinished: false, pinsRetried: 0 };
  }
  const target = switchTarget(handoff);
  let switchFinished = false;
  if (target !== null) {
    if (handoff.pinPurposeTarget === null) {
      deps.store.updateHandoff(handoffId, { pinPurposeTarget: target }, deps.nowMs());
    }
    switchFinished = finishSwitch(deps, handoffId, target).complete;
  }
  return { switchFinished, pinsRetried: retryRefusedPins(deps, handoffId) };
}

/** True when a newer build has migrated this store; its handoff rows are never interpreted. */
export function isNewerBuildStore(conn: NodeSqliteConnection): boolean {
  const applied = conn.scalar<number>('SELECT MAX(version) FROM schema_migrations') ?? 0;
  return applied > SQLITE_SCHEMA_CURRENT_VERSION;
}

/**
 * R5: how F05 places a `handoff` owner. A store from a newer build is never interpreted, so
 * every id is `unresolved` there, and F05 keeps the artifact.
 */
export function handoffOwnerResolution(conn: NodeSqliteConnection, handoffId: string): HandoffOwnerResolution {
  if (isNewerBuildStore(conn)) return 'unresolved';
  const state = conn.scalar<HandoffState>('SELECT state FROM recovery_handoffs WHERE handoff_id = ?', handoffId);
  if (state === undefined) return 'unresolved';
  return CLOSED_HANDOFF_STATES.has(state) ? 'settled' : 'live';
}
