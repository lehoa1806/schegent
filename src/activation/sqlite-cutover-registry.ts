// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Pure in-memory registration and reverse-order disposal ledger keyed by `WorkspaceStateStore`.
// Performs no filesystem, process, or SQLite side effects on its own; callers gate primary
// store opening and disposal on workspace trust and primacy.
/**
 * FR-R7-14 (14-21) — Explicit registration ordering and symmetric disposal registry
 * for SQLite cutover collaborators associated with a `WorkspaceStateStore`.
 *
 * Replaces the four implicit WeakMaps previously scattered at the top of
 * `sqlite-cutover-wiring.ts` with a single explicit lifecycle container that:
 *   1. Records registration order (`operationalMemento` -> `catalogFs` -> `workspaceLock` -> `coordinator`).
 *   2. Exposes deterministic inspection (`inspectCutoverRegistrations`) and strict production
 *      validation (`assertCutoverRegistrationOrder`) so incomplete or reordered construction
 *      fails loudly when verified.
 *   3. Disposes registered resources in strict reverse order (`coordinator.close()` -> clearing
 *      `workspaceLock`, `catalogFs`, and `operationalMemento` references) on teardown without
 *      leaking stale handles.
 */

import type * as vscode from 'vscode';
import type { SwitchableCatalogFsAdapter } from '../services/sqlite-store';
import type { WorkspaceLockManager } from '../state/lock';
import type { SwitchableOperationalMemento } from '../state/sqlite-operational-backing';
import type { WorkspaceStateStore } from '../state/workspace-state';

export type CutoverRegistrationSlot =
  | 'operationalMemento'
  | 'catalogFs'
  | 'workspaceLock'
  | 'coordinator';

export const EXPECTED_CUTOVER_REGISTRATION_ORDER: readonly CutoverRegistrationSlot[] = Object.freeze([
  'operationalMemento',
  'catalogFs',
  'workspaceLock',
  'coordinator'
]);

export interface RegisteredWorkspaceLock {
  readonly lock: Pick<WorkspaceLockManager, 'hasPrimacy'>;
  readonly disposables: vscode.Disposable[];
}

export interface DisposableCutoverCoordinator {
  close(): void;
}

export interface CutoverRegistrationSnapshot {
  readonly registered: readonly CutoverRegistrationSlot[];
  readonly missing: readonly CutoverRegistrationSlot[];
  readonly orderViolations: readonly string[];
  readonly disposed: boolean;
}

interface StoreCutoverEntry<TCoordinator extends DisposableCutoverCoordinator> {
  operationalMemento?: SwitchableOperationalMemento | undefined;
  catalogFs?: SwitchableCatalogFsAdapter | undefined;
  workspaceLock?: RegisteredWorkspaceLock | undefined;
  coordinator?: TCoordinator | undefined;
  registrationSequence: CutoverRegistrationSlot[];
  orderViolations: string[];
  allowMissingCatalogFs: boolean;
  disposed: boolean;
}

export class CutoverRegistrationOrderError extends Error {
  public readonly code: 'CUTOVER_REGISTRATION_DISPOSED' | 'CUTOVER_REGISTRATION_INCOMPLETE' | 'CUTOVER_REGISTRATION_OUT_OF_ORDER';

  public constructor(
    code: 'CUTOVER_REGISTRATION_DISPOSED' | 'CUTOVER_REGISTRATION_INCOMPLETE' | 'CUTOVER_REGISTRATION_OUT_OF_ORDER',
    message: string
  ) {
    super(`${code}: ${message}`);
    this.name = 'CutoverRegistrationOrderError';
    this.code = code;
  }
}

const EXPECTED_PREDECESSORS: Readonly<Record<CutoverRegistrationSlot, readonly CutoverRegistrationSlot[]>> =
  Object.freeze({
    operationalMemento: [],
    catalogFs: ['operationalMemento'],
    workspaceLock: ['operationalMemento', 'catalogFs'],
    coordinator: ['operationalMemento', 'catalogFs', 'workspaceLock']
  });

export class SqliteCutoverStoreRegistry<TCoordinator extends DisposableCutoverCoordinator> {
  private readonly entries = new WeakMap<WorkspaceStateStore, StoreCutoverEntry<TCoordinator>>();

  private getOrCreate(store: WorkspaceStateStore): StoreCutoverEntry<TCoordinator> {
    let entry = this.entries.get(store);
    if (entry === undefined) {
      entry = {
        registrationSequence: [],
        orderViolations: [],
        allowMissingCatalogFs: false,
        disposed: false
      };
      this.entries.set(store, entry);
    }
    return entry;
  }

  private recordSlot(
    entry: StoreCutoverEntry<TCoordinator>,
    slot: CutoverRegistrationSlot,
    strictOrder: boolean,
    optionalPredecessors: readonly CutoverRegistrationSlot[] = []
  ): void {
    if (entry.disposed) {
      throw new CutoverRegistrationOrderError(
        'CUTOVER_REGISTRATION_DISPOSED',
        `Cannot register '${slot}' after cutover store entry was disposed`
      );
    }
    const missingPredecessors = EXPECTED_PREDECESSORS[slot].filter(
      (req) => !optionalPredecessors.includes(req) && !entry.registrationSequence.includes(req)
    );
    if (missingPredecessors.length > 0) {
      const violation = `'${slot}' registered before [${missingPredecessors.join(', ')}]`;
      entry.orderViolations.push(violation);
      if (strictOrder) {
        throw new CutoverRegistrationOrderError('CUTOVER_REGISTRATION_OUT_OF_ORDER', violation);
      }
    }
    if (!entry.registrationSequence.includes(slot)) {
      entry.registrationSequence.push(slot);
    }
  }

  public registerOperationalMemento(
    store: WorkspaceStateStore,
    memento: SwitchableOperationalMemento,
    options?: { readonly strictOrder?: boolean }
  ): void {
    const entry = this.getOrCreate(store);
    this.recordSlot(entry, 'operationalMemento', options?.strictOrder === true);
    entry.operationalMemento = memento;
  }

  public getOperationalMemento(store: WorkspaceStateStore): SwitchableOperationalMemento | undefined {
    return this.entries.get(store)?.operationalMemento;
  }

  public registerCatalogFs(
    store: WorkspaceStateStore,
    catalogFs: SwitchableCatalogFsAdapter,
    options?: { readonly strictOrder?: boolean }
  ): void {
    const entry = this.getOrCreate(store);
    this.recordSlot(entry, 'catalogFs', options?.strictOrder === true);
    entry.catalogFs = catalogFs;
  }

  public getCatalogFs(store: WorkspaceStateStore): SwitchableCatalogFsAdapter | undefined {
    return this.entries.get(store)?.catalogFs;
  }

  public registerWorkspaceLock(
    store: WorkspaceStateStore,
    lock: Pick<WorkspaceLockManager, 'hasPrimacy'>,
    disposables: vscode.Disposable[],
    options?: { readonly strictOrder?: boolean; readonly allowMissingCatalogFs?: boolean }
  ): void {
    const entry = this.getOrCreate(store);
    if (options?.allowMissingCatalogFs === true) {
      entry.allowMissingCatalogFs = true;
    }
    this.recordSlot(
      entry,
      'workspaceLock',
      options?.strictOrder === true,
      entry.allowMissingCatalogFs ? ['catalogFs'] : []
    );
    entry.workspaceLock = { lock, disposables };
  }

  public getWorkspaceLock(store: WorkspaceStateStore): RegisteredWorkspaceLock | undefined {
    return this.entries.get(store)?.workspaceLock;
  }

  public registerCoordinator(
    store: WorkspaceStateStore,
    coordinator: TCoordinator,
    options?: { readonly strictOrder?: boolean; readonly allowMissingCatalogFs?: boolean }
  ): void {
    const entry = this.getOrCreate(store);
    const catalogOptional = entry.allowMissingCatalogFs || options?.allowMissingCatalogFs === true;
    this.recordSlot(
      entry,
      'coordinator',
      options?.strictOrder === true,
      catalogOptional ? ['catalogFs'] : []
    );
    entry.coordinator = coordinator;
  }

  public getCoordinator(store: WorkspaceStateStore): TCoordinator | undefined {
    return this.entries.get(store)?.coordinator;
  }

  public assertNotDisposed(store: WorkspaceStateStore, slot: CutoverRegistrationSlot): void {
    if (this.entries.get(store)?.disposed === true) {
      throw new CutoverRegistrationOrderError(
        'CUTOVER_REGISTRATION_DISPOSED',
        `Cannot register '${slot}' after cutover store entry was disposed`
      );
    }
  }

  public unregisterCoordinator(store: WorkspaceStateStore, coordinator?: TCoordinator): void {
    const entry = this.entries.get(store);
    if (entry === undefined) return;
    if (coordinator !== undefined && entry.coordinator !== coordinator) return;
    entry.coordinator = undefined;
    if (!entry.disposed) {
      entry.registrationSequence = entry.registrationSequence.filter((slot) => slot !== 'coordinator');
    }
  }

  public inspect(store: WorkspaceStateStore): CutoverRegistrationSnapshot {
    const entry = this.entries.get(store);
    if (entry === undefined) {
      return {
        registered: [],
        missing: [...EXPECTED_CUTOVER_REGISTRATION_ORDER],
        orderViolations: [],
        disposed: false
      };
    }
    const missing = EXPECTED_CUTOVER_REGISTRATION_ORDER.filter(
      (slot) => !entry.registrationSequence.includes(slot)
    );
    return {
      registered: [...entry.registrationSequence],
      missing,
      orderViolations: [...entry.orderViolations],
      disposed: entry.disposed
    };
  }

  public assertCompleteAndOrdered(
    store: WorkspaceStateStore,
    requiredSlots: readonly CutoverRegistrationSlot[] = EXPECTED_CUTOVER_REGISTRATION_ORDER
  ): void {
    const snapshot = this.inspect(store);
    if (snapshot.disposed) {
      throw new CutoverRegistrationOrderError(
        'CUTOVER_REGISTRATION_DISPOSED',
        'Cutover store entry has already been disposed'
      );
    }
    if (snapshot.orderViolations.length > 0) {
      throw new CutoverRegistrationOrderError(
        'CUTOVER_REGISTRATION_OUT_OF_ORDER',
        snapshot.orderViolations.join('; ')
      );
    }
    const missing = requiredSlots.filter((slot) => !snapshot.registered.includes(slot));
    if (missing.length > 0) {
      throw new CutoverRegistrationOrderError(
        'CUTOVER_REGISTRATION_INCOMPLETE',
        `Missing required cutover registrations: ${missing.join(', ')}`
      );
    }
  }

  /**
   * Tears down Stage 2 registrations (`coordinator`, `workspaceLock`, `catalogFs`) in reverse
   * order while preserving Stage 1's `operationalMemento` so Stage 2 can cleanly re-wire when
   * workspace folders change within the same host activation.
   */
  public resetStage2(store: WorkspaceStateStore): readonly CutoverRegistrationSlot[] {
    const entry = this.entries.get(store);
    if (entry === undefined || entry.disposed) {
      return [];
    }
    const disposedOrder: CutoverRegistrationSlot[] = [];
    try {
      if (entry.coordinator !== undefined) {
        try {
          entry.coordinator.close();
        } finally {
          entry.coordinator = undefined;
          disposedOrder.push('coordinator');
        }
      }
    } finally {
      if (entry.workspaceLock !== undefined) {
        entry.workspaceLock = undefined;
        disposedOrder.push('workspaceLock');
      }
      if (entry.catalogFs !== undefined) {
        entry.catalogFs = undefined;
        disposedOrder.push('catalogFs');
      }
      entry.registrationSequence = entry.registrationSequence.filter(
        (slot) => slot === 'operationalMemento'
      );
      entry.orderViolations = [];
      entry.allowMissingCatalogFs = false;
    }
    return disposedOrder;
  }

  /**
   * Symmetric reverse-order teardown: closes coordinator first, clears references,
   * and marks the entry disposed so later registrations fail closed.
   */
  public dispose(store: WorkspaceStateStore): readonly CutoverRegistrationSlot[] {
    const entry = this.entries.get(store);
    if (entry === undefined || entry.disposed) {
      return [];
    }
    entry.disposed = true;
    const disposedOrder: CutoverRegistrationSlot[] = [];
    try {
      if (entry.coordinator !== undefined) {
        try {
          entry.coordinator.close();
        } finally {
          entry.coordinator = undefined;
          disposedOrder.push('coordinator');
        }
      }
    } finally {
      if (entry.workspaceLock !== undefined) {
        entry.workspaceLock = undefined;
        disposedOrder.push('workspaceLock');
      }
      if (entry.catalogFs !== undefined) {
        entry.catalogFs = undefined;
        disposedOrder.push('catalogFs');
      }
      if (entry.operationalMemento !== undefined) {
        entry.operationalMemento = undefined;
        disposedOrder.push('operationalMemento');
      }
    }
    return disposedOrder;
  }
}

