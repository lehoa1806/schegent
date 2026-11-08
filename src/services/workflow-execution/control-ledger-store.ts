/**
 * FR-R5-F26 (SPEC-04, D4, D1) — Durable control admission ledger store.
 *
 * Provides serialized, revision-checked, and execution-fence-checked reads and
 * mutations over `KEYS.controlLedger` (`schegent.controlLedger`).
 *
 * Invariants:
 * - Unknown top-level ledger versions or unknown per-root versions are never
 *   overwritten or auto-deleted; mutations targeting an unknown version fail
 *   closed with `unsupported-control-ledger-version`.
 * - Enforces `MAX_LIVE_CONTROL_ROOTS = 20` (evicting oldest terminal roots first),
 *   `MAX_FRAMES_PER_ROOT = 1024`, `MAX_QUOTA_OBSERVATIONS = 256`,
 *   `MAX_QUOTA_WAITERS = 160`, `MAX_ACTIVE_AVAILABILITY_CHECKS = 3`, and
 *   per-root byte budget `MAX_ROOT_LEDGER_BYTES = 2_097_152` with
 *   `ROOT_SETTLEMENT_RESERVE_BYTES = 16_384` reserved exclusively for terminal
 *   settlement writes.
 * - Zero `vscode` imports.
 */

import {
  CONTROL_LEDGER_VERSION,
  MAX_ACTIVE_AVAILABILITY_CHECKS,
  MAX_FRAMES_PER_ROOT,
  MAX_LIVE_CONTROL_ROOTS,
  MAX_QUOTA_OBSERVATIONS,
  MAX_QUOTA_WAITERS,
  MAX_ROOT_LEDGER_BYTES,
  ROOT_SETTLEMENT_RESERVE_BYTES,
  createEmptyControlLedger,
  executionFencesEqual,
  isValidExecutionFence,
  type AvailabilityCheckRecord,
  type ControlLedger,
  type ControlLedgerErrorCode,
  type ExecutionFence,
  type ExecutionPermitRecord,
  type QuotaObservationRecord,
  type QuotaWaiterRecord,
  type RootControlState
} from '../../contracts/control-ledger';
import { KEYS, type Memento, type WorkspaceStateStore } from '../../state/workspace-state';

export type ControlLedgerBackingStore =
  | Pick<WorkspaceStateStore, 'getRawControlLedger' | 'transactControlLedger'>
  | Memento;

export type ControlLedgerReadResult =
  | {
      readonly ok: true;
      readonly ledger: ControlLedger;
      readonly preservedUnknownRoots: Readonly<Record<string, unknown>>;
    }
  | {
      readonly ok: false;
      readonly code: 'unsupported-control-ledger-version' | 'control-ledger-corrupt';
      readonly message: string;
      readonly raw: unknown;
    };

export interface ControlLedgerMutationContext {
  readonly ledger: ControlLedger;
  readonly preservedUnknownRoots: Readonly<Record<string, unknown>>;
}

export interface ControlLedgerMutationPlan<T = void> {
  readonly nextLedger: ControlLedger;
  readonly targetRootId?: string;
  readonly expectedFence?: ExecutionFence;
  readonly allowSettlementReserve?: boolean;
  readonly result: T;
}

export type ControlLedgerMutationDirective<T = void> =
  | { readonly commit: true; readonly plan: ControlLedgerMutationPlan<T> }
  | {
      readonly commit: false;
      readonly code: ControlLedgerErrorCode;
      readonly message: string;
    };

export type ControlLedgerMutationOutcome<T = void> =
  | {
      readonly ok: true;
      readonly ledger: ControlLedger;
      readonly result: T;
    }
  | {
      readonly ok: false;
      readonly code: ControlLedgerErrorCode;
      readonly message: string;
      readonly currentLedger?: ControlLedger;
    };

function isWorkspaceBacking(
  store: ControlLedgerBackingStore
): store is Pick<WorkspaceStateStore, 'getRawControlLedger' | 'transactControlLedger'> {
  return 'transactControlLedger' in store && typeof store.transactControlLedger === 'function';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function lookupRecord<T>(
  map: Readonly<Record<string, T>>,
  key: string
): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return value;
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as unknown as T;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (nested !== undefined) {
      copy[key] = deepClone(nested);
    }
  }
  return copy as T;
}

export function measureRootLedgerBytes(root: RootControlState): number {
  return Buffer.byteLength(JSON.stringify(root), 'utf8');
}

function isTerminalRoot(root: RootControlState): boolean {
  return (
    root.linkState === 'terminal' ||
    root.status === 'completed' ||
    root.status === 'failed' ||
    root.status === 'canceled'
  );
}

function parseRawControlLedger(raw: unknown): ControlLedgerReadResult {
  if (raw === undefined || raw === null) {
    return {
      ok: true,
      ledger: createEmptyControlLedger(),
      preservedUnknownRoots: Object.freeze({})
    };
  }
  if (!isPlainRecord(raw)) {
    return {
      ok: false,
      code: 'control-ledger-corrupt',
      message: 'Persisted schegent.controlLedger is not an object.',
      raw
    };
  }
  const version = raw.version;
  if (typeof version === 'number' && version !== CONTROL_LEDGER_VERSION) {
    return {
      ok: false,
      code: 'unsupported-control-ledger-version',
      message: `Unsupported schegent.controlLedger version '${String(version)}'.`,
      raw
    };
  }
  if (version !== CONTROL_LEDGER_VERSION) {
    return {
      ok: false,
      code: 'control-ledger-corrupt',
      message: 'Persisted schegent.controlLedger has an invalid version field.',
      raw
    };
  }
  const revision = raw.revision;
  const nextWaitSequence = raw.nextWaitSequence;
  if (
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    typeof nextWaitSequence !== 'number' ||
    !Number.isSafeInteger(nextWaitSequence) ||
    nextWaitSequence < 1 ||
    !isPlainRecord(raw.roots) ||
    !isPlainRecord(raw.quotaObservations) ||
    !isPlainRecord(raw.checks) ||
    !Array.isArray(raw.waiters) ||
    !isPlainRecord(raw.permits)
  ) {
    return {
      ok: false,
      code: 'control-ledger-corrupt',
      message: 'Persisted schegent.controlLedger failed structural validation.',
      raw
    };
  }

  const validRoots: Record<string, RootControlState> = {};
  const preservedUnknownRoots: Record<string, unknown> = {};
  for (const [rootId, rootValue] of Object.entries(raw.roots)) {
    if (!isPlainRecord(rootValue)) {
      return {
        ok: false,
        code: 'control-ledger-corrupt',
        message: `Control root '${rootId}' is not an object.`,
        raw
      };
    }
    const rootVersion = rootValue.version;
    if (typeof rootVersion === 'number' && rootVersion !== CONTROL_LEDGER_VERSION) {
      preservedUnknownRoots[rootId] = deepFreeze(deepClone(rootValue));
      continue;
    }
    if (
      rootVersion !== undefined &&
      rootVersion !== CONTROL_LEDGER_VERSION
    ) {
      return {
        ok: false,
        code: 'control-ledger-corrupt',
        message: `Control root '${rootId}' has invalid version.`,
        raw
      };
    }
    if (
      typeof rootValue.ledgerRunId !== 'string' ||
      rootValue.ledgerRunId !== rootId ||
      typeof rootValue.connectedRunId !== 'string' ||
      !isValidExecutionFence(rootValue.fence) ||
      !isPlainRecord(rootValue.framesByKey) ||
      !isPlainRecord(rootValue.attemptsById)
    ) {
      return {
        ok: false,
        code: 'control-ledger-corrupt',
        message: `Control root '${rootId}' failed invariant check.`,
        raw
      };
    }
    validRoots[rootId] = deepFreeze(
      deepClone({
        ...(rootValue as unknown as RootControlState),
        version: CONTROL_LEDGER_VERSION
      })
    );
  }

  const ledger: ControlLedger = deepFreeze({
    version: CONTROL_LEDGER_VERSION,
    revision,
    nextWaitSequence,
    roots: validRoots,
    quotaObservations: deepClone(
      raw.quotaObservations as Record<string, QuotaObservationRecord>
    ),
    checks: deepClone(raw.checks as Record<string, AvailabilityCheckRecord>),
    waiters: deepClone(raw.waiters as QuotaWaiterRecord[]),
    permits: deepClone(raw.permits as Record<string, ExecutionPermitRecord>)
  });

  return {
    ok: true,
    ledger,
    preservedUnknownRoots: deepFreeze(preservedUnknownRoots)
  };
}

function enforceBoundsAndEvict(
  ledger: ControlLedger,
  preservedUnknownRoots: Readonly<Record<string, unknown>>,
  targetRootId: string | undefined,
  allowSettlementReserve: boolean
):
  | { readonly ok: true; readonly bounded: ControlLedger }
  | { readonly ok: false; readonly code: ControlLedgerErrorCode; readonly message: string } {
  const roots: Record<string, RootControlState> = { ...ledger.roots };
  const unknownCount = Object.keys(preservedUnknownRoots).length;

  while (Object.keys(roots).length + unknownCount > MAX_LIVE_CONTROL_ROOTS) {
    const evictable = Object.values(roots)
      .filter((r) => r.ledgerRunId !== targetRootId && isTerminalRoot(r))
      .sort((a, b) => {
        const aTime = a.completedAt ?? a.updatedAt;
        const bTime = b.completedAt ?? b.updatedAt;
        if (aTime !== bTime) return aTime - bTime;
        return a.ledgerRunId.localeCompare(b.ledgerRunId);
      });
    const oldest = evictable.at(0);
    if (oldest === undefined) {
      return {
        ok: false,
        code: 'control-root-limit-exceeded',
        message: `Live control roots cannot exceed ${MAX_LIVE_CONTROL_ROOTS}.`
      };
    }
    delete roots[oldest.ledgerRunId];
  }

  const remainingRootIds = new Set<string>([
    ...Object.keys(roots),
    ...Object.keys(preservedUnknownRoots)
  ]);

  if (targetRootId !== undefined) {
    const targetRoot = lookupRecord(roots, targetRootId);
    if (targetRoot !== undefined) {
      const frameCount = Object.keys(targetRoot.framesByKey).length;
      if (frameCount > MAX_FRAMES_PER_ROOT) {
        return {
          ok: false,
          code: 'control-frame-limit-exceeded',
          message: `Root '${targetRootId}' exceeds MAX_FRAMES_PER_ROOT (${MAX_FRAMES_PER_ROOT}).`
        };
      }
      const byteLimit = allowSettlementReserve
        ? MAX_ROOT_LEDGER_BYTES
        : MAX_ROOT_LEDGER_BYTES - ROOT_SETTLEMENT_RESERVE_BYTES;
      const rootBytes = measureRootLedgerBytes(targetRoot);
      if (rootBytes > byteLimit) {
        return {
          ok: false,
          code: 'control-ledger-size-exceeded',
          message: `Root '${targetRootId}' serialized size (${rootBytes} bytes) exceeds limit (${byteLimit} bytes).`
        };
      }
    }
  }

  const activeChecks = Object.values(ledger.checks).filter(
    (c) =>
      c.status === 'running' ||
      c.stage === 'pending' ||
      c.stage === 'started'
  );
  if (activeChecks.length > MAX_ACTIVE_AVAILABILITY_CHECKS) {
    return {
      ok: false,
      code: 'control-check-limit-exceeded',
      message: `Active availability checks (${activeChecks.length}) exceed MAX_ACTIVE_AVAILABILITY_CHECKS (${MAX_ACTIVE_AVAILABILITY_CHECKS}).`
    };
  }

  const observationsEntries = Object.entries(ledger.quotaObservations);
  let boundedObservations = ledger.quotaObservations;
  if (observationsEntries.length > MAX_QUOTA_OBSERVATIONS) {
    const sorted = [...observationsEntries].sort(
      ([keyA, a], [keyB, b]) => a.observedAt - b.observedAt || keyA.localeCompare(keyB)
    );
    const kept = sorted.slice(sorted.length - MAX_QUOTA_OBSERVATIONS);
    boundedObservations = Object.fromEntries(kept);
  }

  let waiters = ledger.waiters.filter((w) => remainingRootIds.has(w.ledgerRunId));
  if (waiters.length > MAX_QUOTA_WAITERS) {
    const activeWaiters = waiters.filter(
      (w) => w.status === 'waiting' || w.status === 'paused'
    );
    if (activeWaiters.length > MAX_QUOTA_WAITERS) {
      return {
        ok: false,
        code: 'control-waiter-limit-exceeded',
        message: `Active quota waiters (${activeWaiters.length}) exceed MAX_QUOTA_WAITERS (${MAX_QUOTA_WAITERS}).`
      };
    }
    const terminalWaiters = waiters
      .filter((w) => w.status === 'granted' || w.status === 'canceled')
      .sort((a, b) => a.updatedAt - b.updatedAt || a.waitSequence - b.waitSequence);
    const keepTerminalCount = MAX_QUOTA_WAITERS - activeWaiters.length;
    const keptTerminalIds = new Set(
      terminalWaiters.slice(Math.max(0, terminalWaiters.length - keepTerminalCount)).map((w) => w.waiterId)
    );
    waiters = waiters.filter(
      (w) =>
        w.status === 'waiting' ||
        w.status === 'paused' ||
        keptTerminalIds.has(w.waiterId)
    );
  }

  const permits: Record<string, ExecutionPermitRecord> = {};
  for (const [permitId, permit] of Object.entries(ledger.permits)) {
    if (
      remainingRootIds.has(permit.ledgerRunId) ||
      permit.status === 'active' ||
      permit.status === 'held-uncertain'
    ) {
      permits[permitId] = permit;
    }
  }

  return {
    ok: true,
    bounded: deepFreeze({
      ...ledger,
      roots,
      quotaObservations: boundedObservations,
      waiters,
      permits
    })
  };
}

export class ControlLedgerStore {
  private readonly store: ControlLedgerBackingStore;
  private chain: Promise<void> = Promise.resolve();

  public constructor(store: ControlLedgerBackingStore) {
    this.store = store;
  }

  public read(): ControlLedgerReadResult {
    const raw = isWorkspaceBacking(this.store)
      ? this.store.getRawControlLedger()
      : this.store.get<unknown>(KEYS.controlLedger);
    return parseRawControlLedger(raw);
  }

  public getRoot(ledgerRunId: string): RootControlState | null {
    const readResult = this.read();
    if (!readResult.ok) return null;
    return lookupRecord(readResult.ledger.roots, ledgerRunId) ?? null;
  }

  public async mutate<T = void>(
    options: {
      readonly expectedRevision?: number;
      readonly targetRootId?: string;
      readonly expectedFence?: ExecutionFence;
      readonly allowSettlementReserve?: boolean;
    },
    mutator: (
      context: ControlLedgerMutationContext
    ) => Promise<ControlLedgerMutationDirective<T>> | ControlLedgerMutationDirective<T>
  ): Promise<ControlLedgerMutationOutcome<T>> {
    const runTransaction = async (
      raw: unknown,
      write: (next: unknown) => Promise<void>
    ): Promise<ControlLedgerMutationOutcome<T>> => {
      const parsed = parseRawControlLedger(raw);
      if (!parsed.ok) {
        return {
          ok: false,
          code: parsed.code,
          message: parsed.message
        };
      }
      const { ledger, preservedUnknownRoots } = parsed;

      if (
        options.targetRootId !== undefined &&
        options.targetRootId in preservedUnknownRoots
      ) {
        return {
          ok: false,
          code: 'unsupported-control-ledger-version',
          message: `Control root '${options.targetRootId}' was persisted with an unsupported version.`,
          currentLedger: ledger
        };
      }

      if (
        options.expectedRevision !== undefined &&
        ledger.revision !== options.expectedRevision
      ) {
        return {
          ok: false,
          code: 'stale-ledger-revision',
          message: `Expected control ledger revision ${options.expectedRevision}, found ${ledger.revision}.`,
          currentLedger: ledger
        };
      }

      if (options.targetRootId !== undefined && options.expectedFence !== undefined) {
        const existingRoot = lookupRecord(ledger.roots, options.targetRootId);
        if (
          existingRoot !== undefined &&
          !executionFencesEqual(existingRoot.fence, options.expectedFence)
        ) {
          return {
            ok: false,
            code: 'stale-execution-fence',
            message: `Stale execution fence on control root '${options.targetRootId}'.`,
            currentLedger: ledger
          };
        }
      }

      const directive = await mutator({ ledger, preservedUnknownRoots });
      if (!directive.commit) {
        return {
          ok: false,
          code: directive.code,
          message: directive.message,
          currentLedger: ledger
        };
      }

      const { plan } = directive;
      const effectiveTargetRootId = plan.targetRootId ?? options.targetRootId;
      const effectiveExpectedFence = plan.expectedFence ?? options.expectedFence;
      const effectiveAllowReserve =
        plan.allowSettlementReserve ?? options.allowSettlementReserve ?? false;

      if (effectiveTargetRootId !== undefined && effectiveExpectedFence !== undefined) {
        const existingRoot = lookupRecord(ledger.roots, effectiveTargetRootId);
        if (
          existingRoot !== undefined &&
          !executionFencesEqual(existingRoot.fence, effectiveExpectedFence)
        ) {
          return {
            ok: false,
            code: 'stale-execution-fence',
            message: `Stale execution fence on control root '${effectiveTargetRootId}'.`,
            currentLedger: ledger
          };
        }
      }

      const nextRevision = ledger.revision + 1;
      const candidateLedger: ControlLedger = {
        ...plan.nextLedger,
        version: CONTROL_LEDGER_VERSION,
        revision: nextRevision
      };

      const bounded = enforceBoundsAndEvict(
        candidateLedger,
        preservedUnknownRoots,
        effectiveTargetRootId,
        effectiveAllowReserve
      );
      if (!bounded.ok) {
        return {
          ok: false,
          code: bounded.code,
          message: bounded.message,
          currentLedger: ledger
        };
      }

      const persistedPayload = {
        ...bounded.bounded,
        roots: {
          ...preservedUnknownRoots,
          ...bounded.bounded.roots
        }
      };
      await write(persistedPayload);

      return {
        ok: true,
        ledger: bounded.bounded,
        result: plan.result
      };
    };

    if (isWorkspaceBacking(this.store)) {
      return this.store.transactControlLedger(runTransaction);
    }

    const memento = this.store;
    const previous = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const raw = memento.get<unknown>(KEYS.controlLedger);
      return await runTransaction(raw, async (next: unknown) => {
        await memento.update(KEYS.controlLedger, next);
      });
    } finally {
      release();
    }
  }
}
