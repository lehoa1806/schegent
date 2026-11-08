/**
 * FR-R5-F30 (SPEC-08, D7, D4; WF-19; AC-25, AC-26) —
 * Durable control notification service and bounded root history archival.
 *
 * Responsibilities:
 * - Build deterministic `notificationId = ${rootRunId}/${invocationId}/${generation}/${reason}`.
 * - Validate closed `ControlNotificationRecord` shapes.
 * - Persist `delivery: 'pending'` in `ControlLedgerStore` before claiming, and
 *   atomically transition `pending -> claimed` before invoking the toast emitter
 *   (at-most-once toast delivery while keeping the durable run notice visible in
 *   editor and headless reads).
 * - Enforce bounded root history (`<= 256` decision/notice summaries and `<= 64`
 *   settled-check summaries per root), archiving older settled/claimed entries
 *   with an opaque `archivedHistoryCursor` while never discarding active attempts
 *   or `pending` notifications.
 *
 * Zero `vscode` imports.
 */

import {
  type ControlClockPort,
  type ControlDecisionSummaryRecord,
  type ControlLedger,
  type ControlNotificationReason,
  type ControlNotificationRecord,
  type RootControlState
} from '../../contracts/control-ledger';
import { ControlLedgerStore, lookupRecord } from './control-ledger-store';

export const MAX_DECISION_SUMMARIES_PER_ROOT = 256 as const;
export const MAX_SETTLED_CHECK_SUMMARIES_PER_ROOT = 64 as const;

export const VALID_NOTIFICATION_REASONS: readonly ControlNotificationReason[] =
  Object.freeze([
    'candidate-switched',
    'waiting-availability',
    'monitoring-expired',
    'spend-limit-reached',
    'spend-unverifiable',
    'spend-bound-exceeded',
    'intervention-required',
    'repeat-exhausted',
    'foreach-item-failed'
  ]);

const REASON_SET = new Set<string>(VALID_NOTIFICATION_REASONS);

const ALLOWED_NOTIFICATION_KEYS = new Set<string>([
  'notificationId',
  'rootRunId',
  'invocationId',
  'generation',
  'reason',
  'createdAt',
  'delivery',
  'summary'
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildControlNotificationId(input: {
  readonly rootRunId: string;
  readonly invocationId: string;
  readonly generation: number;
  readonly reason: ControlNotificationReason;
}): string {
  return `${input.rootRunId}/${input.invocationId}/${input.generation}/${input.reason}`;
}

export type ControlNotificationValidationResult =
  | { readonly ok: true; readonly value: ControlNotificationRecord }
  | {
      readonly ok: false;
      readonly code: 'invalid-control-notification';
      readonly message: string;
    };

export function validateControlNotificationRecord(
  raw: unknown
): ControlNotificationValidationResult {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      code: 'invalid-control-notification',
      message: 'ControlNotificationRecord must be a plain object.'
    };
  }
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_NOTIFICATION_KEYS.has(key)) {
      return {
        ok: false,
        code: 'invalid-control-notification',
        message: `Unknown field '${key}' in ControlNotificationRecord.`
      };
    }
  }
  if (
    typeof raw.rootRunId !== 'string' ||
    raw.rootRunId.trim().length === 0 ||
    typeof raw.invocationId !== 'string' ||
    raw.invocationId.trim().length === 0 ||
    typeof raw.generation !== 'number' ||
    !Number.isSafeInteger(raw.generation) ||
    raw.generation < 0 ||
    typeof raw.reason !== 'string' ||
    !REASON_SET.has(raw.reason) ||
    typeof raw.createdAt !== 'number' ||
    !Number.isSafeInteger(raw.createdAt) ||
    raw.createdAt < 0 ||
    (raw.delivery !== 'pending' && raw.delivery !== 'claimed')
  ) {
    return {
      ok: false,
      code: 'invalid-control-notification',
      message: 'ControlNotificationRecord failed field validation.'
    };
  }

  const expectedId = buildControlNotificationId({
    rootRunId: raw.rootRunId,
    invocationId: raw.invocationId,
    generation: raw.generation,
    reason: raw.reason as ControlNotificationReason
  });
  if (raw.notificationId !== expectedId) {
    return {
      ok: false,
      code: 'invalid-control-notification',
      message: `ControlNotificationRecord.notificationId ('${String(raw.notificationId)}') must match '${expectedId}'.`
    };
  }

  return {
    ok: true,
    value: Object.freeze({
      notificationId: expectedId,
      rootRunId: raw.rootRunId,
      invocationId: raw.invocationId,
      generation: raw.generation,
      reason: raw.reason as ControlNotificationReason,
      createdAt: raw.createdAt,
      delivery: raw.delivery,
      ...(typeof raw.summary === 'string' && raw.summary.trim().length > 0
        ? { summary: raw.summary }
        : {})
    })
  };
}

/**
 * Enforce bounded per-root history (`<= 256` decision/notice summaries and
 * `<= 64` settled-check summaries), archiving older settled/claimed entries
 * behind an opaque `archivedHistoryCursor` while never discarding active attempts
 * or `pending` notifications.
 */
export function enforceBoundedRootHistory(
  root: RootControlState,
  options?: {
    readonly maxDecisionSummaries?: number | undefined;
    readonly maxSettledChecks?: number | undefined;
  }
): RootControlState {
  const maxDecisions =
    options?.maxDecisionSummaries ?? MAX_DECISION_SUMMARIES_PER_ROOT;
  const maxChecks =
    options?.maxSettledChecks ?? MAX_SETTLED_CHECK_SUMMARIES_PER_ROOT;

  let archivedCount = root.archivedSummaryCount ?? 0;
  let archivedCursor = root.archivedHistoryCursor;

  let decisions = root.decisionSummaries ?? [];
  if (decisions.length > maxDecisions) {
    const overflow = decisions.length - maxDecisions;
    const lastArchived = decisions.at(overflow - 1);
    decisions = Object.freeze(decisions.slice(overflow));
    archivedCount += overflow;
    if (lastArchived !== undefined) {
      archivedCursor = `cursor:${root.ledgerRunId}:${lastArchived.summaryId}:${archivedCount}`;
    }
  }

  let checks = root.settledCheckSummaries ?? [];
  if (checks.length > maxChecks) {
    const overflow = checks.length - maxChecks;
    const lastArchived = checks.at(overflow - 1);
    checks = Object.freeze(checks.slice(overflow));
    archivedCount += overflow;
    if (lastArchived !== undefined) {
      archivedCursor = `cursor:${root.ledgerRunId}:check:${lastArchived.checkId}:${archivedCount}`;
    }
  }

  // Archive claimed notifications if total notifications exceed maxDecisions,
  // while NEVER discarding 'pending' notifications.
  let notificationsById = root.notificationsById;
  if (notificationsById !== undefined) {
    const entries = Object.values(notificationsById);
    if (entries.length > maxDecisions) {
      const pending = entries.filter((n) => n.delivery === 'pending');
      const claimed = entries
        .filter((n) => n.delivery === 'claimed')
        .sort(
          (a, b) =>
            a.createdAt - b.createdAt ||
            a.notificationId.localeCompare(b.notificationId)
        );
      const keepClaimedBudget = Math.max(0, maxDecisions - pending.length);
      const overflowClaimed = Math.max(0, claimed.length - keepClaimedBudget);
      if (overflowClaimed > 0) {
        const keptClaimed = claimed.slice(overflowClaimed);
        const nextMap: Record<string, ControlNotificationRecord> = {};
        for (const p of pending) {
          nextMap[p.notificationId] = p;
        }
        for (const c of keptClaimed) {
          nextMap[c.notificationId] = c;
        }
        notificationsById = Object.freeze(nextMap);
        archivedCount += overflowClaimed;
        const lastArchivedNotice = claimed.at(overflowClaimed - 1);
        if (lastArchivedNotice !== undefined) {
          archivedCursor = `cursor:${root.ledgerRunId}:notice:${lastArchivedNotice.notificationId}:${archivedCount}`;
        }
      }
    }
  }

  return Object.freeze({
    ...root,
    ...(root.decisionSummaries !== undefined || decisions.length > 0
      ? { decisionSummaries: decisions }
      : {}),
    ...(root.settledCheckSummaries !== undefined || checks.length > 0
      ? { settledCheckSummaries: checks }
      : {}),
    ...(notificationsById !== undefined ? { notificationsById } : {}),
    ...(archivedCursor !== undefined
      ? {
          archivedHistoryCursor: archivedCursor,
          archivedSummaryCount: archivedCount
        }
      : {})
  });
}

export interface RecordNotificationInput {
  readonly rootRunId: string;
  readonly invocationId: string;
  readonly frameKey?: string | undefined;
  readonly generation: number;
  readonly reason: ControlNotificationReason;
  readonly summary?: string | undefined;
  readonly claimAndEmitNow?: boolean | undefined;
}

export interface RecordNotificationOutcome {
  readonly ok: boolean;
  readonly notification?: ControlNotificationRecord | undefined;
  readonly newlyCreated: boolean;
  readonly emittedToast: boolean;
  readonly ledger?: ControlLedger | undefined;
  readonly root?: RootControlState | undefined;
  readonly message?: string | undefined;
}

export type ControlToastEmitter = (
  notification: ControlNotificationRecord
) => Promise<void> | void;

export interface ControlNotificationServiceDeps {
  readonly ledgerStore: ControlLedgerStore;
  readonly clock?: ControlClockPort | undefined;
  readonly emitToast?: ControlToastEmitter | undefined;
}

const DEFAULT_CLOCK: ControlClockPort = {
  nowWallMs: () => Date.now(),
  nowMonotonicMs: () => Date.now()
};

export class ControlNotificationService {
  private readonly store: ControlLedgerStore;
  private readonly clock: ControlClockPort;
  private readonly emitToast: ControlToastEmitter | undefined;

  public constructor(deps: ControlNotificationServiceDeps) {
    this.store = deps.ledgerStore;
    this.clock = deps.clock ?? DEFAULT_CLOCK;
    this.emitToast = deps.emitToast;
  }

  /**
   * Persist a durable `ControlNotificationRecord` with `delivery: 'pending'`
   * (if not already present for the deterministic `notificationId`) and optionally
   * claim + emit it at-most-once.
   */
  public async recordNotification(
    input: RecordNotificationInput
  ): Promise<RecordNotificationOutcome> {
    const notificationId = buildControlNotificationId({
      rootRunId: input.rootRunId,
      invocationId: input.invocationId,
      generation: input.generation,
      reason: input.reason
    });

    const nowWallMs = this.clock.nowWallMs();
    const candidateRecord: ControlNotificationRecord = {
      notificationId,
      rootRunId: input.rootRunId,
      invocationId: input.invocationId,
      generation: input.generation,
      reason: input.reason,
      createdAt: nowWallMs,
      delivery: 'pending',
      ...(input.summary !== undefined ? { summary: input.summary } : {})
    };

    const validated = validateControlNotificationRecord(candidateRecord);
    if (!validated.ok) {
      return {
        ok: false,
        newlyCreated: false,
        emittedToast: false,
        message: validated.message
      };
    }

    const mutated = await this.store.mutate<{
      readonly root: RootControlState;
      readonly notification: ControlNotificationRecord;
      readonly newlyCreated: boolean;
    }>(
      {
        targetRootId: input.rootRunId,
        allowSettlementReserve: true
      },
      ({ ledger }) => {
        const root = lookupRecord(ledger.roots, input.rootRunId);
        if (root === undefined) {
          return {
            commit: false,
            code: 'control-root-not-found',
            message: `Control root '${input.rootRunId}' not found.`
          };
        }

        const existingMap = root.notificationsById ?? {};
        const existing = lookupRecord(existingMap, notificationId);
        if (existing !== undefined) {
          return {
            commit: true,
            plan: {
              nextLedger: ledger,
              targetRootId: input.rootRunId,
              allowSettlementReserve: true,
              result: {
                root,
                notification: existing,
                newlyCreated: false
              }
            }
          };
        }

        const summaryEntry: ControlDecisionSummaryRecord = Object.freeze({
          summaryId: `notice:${notificationId}`,
          rootRunId: input.rootRunId,
          invocationId: input.invocationId,
          frameKey: input.frameKey ?? input.invocationId,
          generation: input.generation,
          eventKind: 'notice-created',
          reason: input.reason,
          createdAt: nowWallMs
        });

        const updatedRoot = enforceBoundedRootHistory(
          Object.freeze({
            ...root,
            notificationsById: Object.freeze({
              ...existingMap,
              [notificationId]: validated.value
            }),
            decisionSummaries: Object.freeze([
              ...(root.decisionSummaries ?? []),
              summaryEntry
            ]),
            updatedAt: nowWallMs
          })
        );

        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              roots: {
                ...ledger.roots,
                [input.rootRunId]: updatedRoot
              }
            },
            targetRootId: input.rootRunId,
            allowSettlementReserve: true,
            result: {
              root: updatedRoot,
              notification: validated.value,
              newlyCreated: true
            }
          }
        };
      }
    );

    if (!mutated.ok) {
      return {
        ok: false,
        newlyCreated: false,
        emittedToast: false,
        message: mutated.message
      };
    }

    if (input.claimAndEmitNow !== false) {
      const claimResult = await this.claimAndEmitNotification(
        input.rootRunId,
        notificationId
      );
      return {
        ok: true,
        notification: claimResult.notification ?? mutated.result.notification,
        newlyCreated: mutated.result.newlyCreated,
        emittedToast: claimResult.emittedToast,
        ledger: claimResult.ledger ?? mutated.ledger,
        root: claimResult.root ?? mutated.result.root
      };
    }

    return {
      ok: true,
      notification: mutated.result.notification,
      newlyCreated: mutated.result.newlyCreated,
      emittedToast: false,
      ledger: mutated.ledger,
      root: mutated.result.root
    };
  }

  /**
   * Atomically transition `pending -> claimed` in `ControlLedgerStore` before invoking
   * `emitToast`. Guarantees at-most-once toast delivery even across crash/restart or
   * repeated poll intervals, while keeping the durable notice in `notificationsById`
   * for editor and headless reads.
   */
  public async claimAndEmitNotification(
    rootRunId: string,
    notificationId: string
  ): Promise<{
    readonly ok: boolean;
    readonly emittedToast: boolean;
    readonly notification?: ControlNotificationRecord | undefined;
    readonly ledger?: ControlLedger | undefined;
    readonly root?: RootControlState | undefined;
  }> {
    const mutated = await this.store.mutate<{
      readonly root: RootControlState;
      readonly notification: ControlNotificationRecord;
      readonly transitionedToClaimed: boolean;
    }>(
      {
        targetRootId: rootRunId,
        allowSettlementReserve: true
      },
      ({ ledger }) => {
        const root = lookupRecord(ledger.roots, rootRunId);
        if (root === undefined) {
          return {
            commit: false,
            code: 'control-root-not-found',
            message: `Control root '${rootRunId}' not found.`
          };
        }
        const existingMap = root.notificationsById ?? {};
        const existing = lookupRecord(existingMap, notificationId);
        if (existing === undefined) {
          return {
            commit: false,
            code: 'attempt-not-found',
            message: `Notification '${notificationId}' not found.`
          };
        }
        if (existing.delivery === 'claimed') {
          return {
            commit: true,
            plan: {
              nextLedger: ledger,
              targetRootId: rootRunId,
              allowSettlementReserve: true,
              result: {
                root,
                notification: existing,
                transitionedToClaimed: false
              }
            }
          };
        }

        const claimedRecord: ControlNotificationRecord = Object.freeze({
          ...existing,
          delivery: 'claimed'
        });
        const nextRoot: RootControlState = Object.freeze({
          ...root,
          notificationsById: Object.freeze({
            ...existingMap,
            [notificationId]: claimedRecord
          }),
          updatedAt: this.clock.nowWallMs()
        });

        return {
          commit: true,
          plan: {
            nextLedger: {
              ...ledger,
              roots: {
                ...ledger.roots,
                [rootRunId]: nextRoot
              }
            },
            targetRootId: rootRunId,
            allowSettlementReserve: true,
            result: {
              root: nextRoot,
              notification: claimedRecord,
              transitionedToClaimed: true
            }
          }
        };
      }
    );

    if (!mutated.ok) {
      return {
        ok: false,
        emittedToast: false
      };
    }

    if (mutated.result.transitionedToClaimed && this.emitToast !== undefined) {
      await this.emitToast(mutated.result.notification);
    }

    return {
      ok: true,
      emittedToast: mutated.result.transitionedToClaimed,
      notification: mutated.result.notification,
      ledger: mutated.ledger,
      root: mutated.result.root
    };
  }

  /**
   * Claim and emit all `pending` notifications for a root (e.g. on recovery or poll tick).
   */
  public async flushPendingNotifications(
    rootRunId: string
  ): Promise<readonly ControlNotificationRecord[]> {
    const root = this.store.getRoot(rootRunId);
    if (root === null || root.notificationsById === undefined) {
      return Object.freeze([]);
    }
    const pending = Object.values(root.notificationsById)
      .filter((n) => n.delivery === 'pending')
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt ||
          a.notificationId.localeCompare(b.notificationId)
      );

    const claimed: ControlNotificationRecord[] = [];
    for (const notice of pending) {
      const res = await this.claimAndEmitNotification(
        rootRunId,
        notice.notificationId
      );
      if (res.ok && res.emittedToast && res.notification !== undefined) {
        claimed.push(res.notification);
      }
    }
    return Object.freeze(claimed);
  }

  public getNotificationsForRoot(
    rootRunId: string
  ): readonly ControlNotificationRecord[] {
    const root = this.store.getRoot(rootRunId);
    if (root === null || root.notificationsById === undefined) {
      return Object.freeze([]);
    }
    return Object.freeze(
      Object.values(root.notificationsById).sort(
        (a, b) =>
          a.createdAt - b.createdAt ||
          a.notificationId.localeCompare(b.notificationId)
      )
    );
  }
}
