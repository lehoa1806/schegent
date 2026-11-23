// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Builds lazy ACP dispatch options for `BackendRunnerRegistry`. No subprocess or filesystem
// operation occurs at wiring time; each ACP transport session spawns only when a Phase executes
// in a trusted primary window, and every callback passes through `AcpAuthorityGate` (F09-FR-17).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { env as vscodeEnv, workspace as vscodeWorkspace } from 'vscode';

import type { SanitizedLogger } from '../lib/logger';
import { createSideEffectFailureReporter } from '../lib/side-effect-failure-reporter';
import type { BackendRunnerFactoryOptions } from '../runner/backend-runner-factory';
import {
  createInMemoryAcpSessionBindingStore,
  type AcpSessionBindingStore
} from '../services/acp-runtime/acp-durable-runtime-store';
import { classifyHostLocality } from '../services/acp-runtime/profiles';
import { AcpAuthorityGate } from '../services/containment-qualification/acp-authority-gate';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { getSqliteCutoverCoordinator } from './sqlite-cutover-wiring';

/** Optional durable ACP hooks exposed by `SqliteCutoverCoordinator` when SQLite cutover is active. */
interface AcpDurableCoordinatorHooks {
  getAcpSessionBindingStore?(): AcpSessionBindingStore | null;
  allocateAcpConnectionGeneration?(): number | null;
  getAcpDurableRuntimeStore?(): {
    readonly sessionBindings: AcpSessionBindingStore;
    allocateConnectionGeneration(): number;
  } | null;
}

/** An authorization receipt was decided while no SQLite store was attached to record it. */
class AcpReceiptStoreDetachedError extends Error {
  constructor() {
    super('no SQLite store attached for the ACP authorization receipt');
    this.name = 'AcpReceiptStoreDetachedError';
  }
}

const VALID_SELECTORS: ReadonlySet<string> = new Set([
  'auto',
  'agy-acp-native',
  'claude-acp-bridge',
  'codex-acp-bridge'
]);

function readHostRemoteName(): string | undefined {
  try {
    return vscodeEnv.remoteName;
  } catch {
    // Partial unit-test `vi.mock('vscode')` stubs may omit `env`; real VS Code hosts always expose it.
    return undefined;
  }
}

function readUncachedAcpProfileSelector(): string {
  const raw = vscodeWorkspace.getConfiguration('schegent.acp').get<unknown>('profile');
  if (typeof raw === 'string' && VALID_SELECTORS.has(raw)) {
    return raw;
  }
  return 'auto';
}

function resolveBridgeScriptPath(): string {
  const bundledCandidate = resolve(__dirname, 'acp-stdio-bridge.js');
  if (existsSync(bundledCandidate)) {
    return bundledCandidate;
  }
  return resolve(__dirname, '..', '..', 'dist', 'acp-stdio-bridge.js');
}

export interface HostAcpDispatchWiringDeps {
  readonly workspaceRoot: string;
  readonly store: WorkspaceStateStore;
  readonly logger: SanitizedLogger;
  readonly isWorkspaceTrusted: () => boolean;
  readonly hasPrimacy: () => Promise<boolean>;
  /** Optional explicit durable session binding store (defaults to SQLite cutover coordinator or in-memory fallback). */
  readonly sessionBindingStore?: AcpSessionBindingStore;
  /** Optional explicit durable connection-generation allocator (defaults to SQLite cutover coordinator). */
  readonly allocateConnectionGeneration?: () => number;
  /** Optional fence-loss event subscription to immediately invalidate cached primacy & SQLite writes. */
  readonly onFenceLost?: (listener: () => void) => { dispose(): void };
  /** Optional disposables collection for the `onFenceLost` subscription. */
  readonly disposables?: { push(disposable: { dispose(): void }): unknown };
  /** Optional test seam overriding `vscode.env.remoteName` for host locality classification. */
  readonly readRemoteName?: () => string | undefined;
}

export function buildHostAcpDispatchOptions(
  deps: HostAcpDispatchWiringDeps
): NonNullable<BackendRunnerFactoryOptions['acpDispatch']> {
  const bridgeScriptPath = resolveBridgeScriptPath();
  const reportReceiptFailure = createSideEffectFailureReporter(deps.logger);
  const fallbackSessionBindings = createInMemoryAcpSessionBindingStore();
  let fallbackGeneration = 0;
  // The last authoritative `hasPrimacy()` verdict; null until the first one lands.
  let lastVerifiedPrimacy: boolean | null = null;
  let ownershipGeneration = 1;
  let primacyRequestSeq = 0;
  let lastSettledPrimacySeq = 0;
  let pendingPrimacyChecks = 0;

  /**
   * Asks the lock once and records the verdict with monotonic sequencing so an older slow `true`
   * resolution can never overwrite a newer `false` loss; an unreadable lock is a lost one.
   */
  const verifyPrimacy = async (): Promise<boolean> => {
    const seq = ++primacyRequestSeq;
    const startOwnershipGeneration = ownershipGeneration;
    pendingPrimacyChecks += 1;
    let held: boolean;
    try {
      held = (await deps.hasPrimacy()) === true;
    } catch {
      held = false;
    } finally {
      pendingPrimacyChecks = Math.max(0, pendingPrimacyChecks - 1);
    }
    if (ownershipGeneration !== startOwnershipGeneration) {
      if (!held) {
        if (lastVerifiedPrimacy === true) {
          ownershipGeneration += 1;
        }
        lastVerifiedPrimacy = false;
      }
      return false;
    }
    if (seq < lastSettledPrimacySeq) {
      if (!held) {
        ownershipGeneration += 1;
        lastVerifiedPrimacy = false;
        return false;
      }
      return lastVerifiedPrimacy === true;
    }
    lastSettledPrimacySeq = seq;
    if (lastVerifiedPrimacy === true && !held) {
      ownershipGeneration += 1;
    }
    lastVerifiedPrimacy = held;
    return held;
  };
  const refreshPrimacyState = (): void => {
    void verifyPrimacy();
  };

  const canWriteDurableAcpState = (): boolean =>
    deps.isWorkspaceTrusted() && lastVerifiedPrimacy === true;

  if (deps.onFenceLost !== undefined) {
    const sub = deps.onFenceLost(() => {
      lastSettledPrimacySeq = ++primacyRequestSeq;
      lastVerifiedPrimacy = false;
      ownershipGeneration += 1;
    });
    deps.disposables?.push(sub);
  }

  const resolveCoordinatorHooks = (): AcpDurableCoordinatorHooks | undefined =>
    getSqliteCutoverCoordinator(deps.store) as (AcpDurableCoordinatorHooks | undefined);

  const sessionBindingStore: AcpSessionBindingStore = {
    getBinding(persistedSessionId) {
      const store =
        deps.sessionBindingStore ??
        resolveCoordinatorHooks()?.getAcpSessionBindingStore?.() ??
        resolveCoordinatorHooks()?.getAcpDurableRuntimeStore?.()?.sessionBindings ??
        fallbackSessionBindings;
      return store.getBinding(persistedSessionId);
    },
    putBinding(binding) {
      if (deps.sessionBindingStore !== undefined) {
        deps.sessionBindingStore.putBinding(binding);
        return;
      }
      if (!canWriteDurableAcpState()) {
        fallbackSessionBindings.putBinding(binding);
        return;
      }
      const store =
        resolveCoordinatorHooks()?.getAcpSessionBindingStore?.() ??
        resolveCoordinatorHooks()?.getAcpDurableRuntimeStore?.()?.sessionBindings ??
        fallbackSessionBindings;
      store.putBinding(binding);
    }
  };

  const allocateConnectionGeneration = (): number => {
    if (deps.allocateConnectionGeneration !== undefined) {
      return deps.allocateConnectionGeneration();
    }
    if (canWriteDurableAcpState()) {
      const hooks = resolveCoordinatorHooks();
      const durableGen =
        hooks?.allocateAcpConnectionGeneration?.() ??
        hooks?.getAcpDurableRuntimeStore?.()?.allocateConnectionGeneration();
      if (typeof durableGen === 'number' && Number.isSafeInteger(durableGen) && durableGen >= 1) {
        fallbackGeneration = Math.max(fallbackGeneration, durableGen);
        return durableGen;
      }
    }
    fallbackGeneration += 1;
    return fallbackGeneration;
  };

  const remoteName = deps.readRemoteName ? deps.readRemoteName() : readHostRemoteName();
  const hostLocality = classifyHostLocality(remoteName);

  // Review gap GC-08 (2026-11-12) & FR-R7-14 (14-07) — the authoritative verdict decides.
  // Sensitive callbacks await `verifyPrimacy()` via `authorizeAsync()`; synchronous `holdsPrimacy()`
  // fails closed while any probe is pending or before the first verdict settles without spawning
  // floating refreshes.
  const authorityGate = new AcpAuthorityGate(
    {
      isWorkspaceTrusted: () => deps.isWorkspaceTrusted(),
      holdsPrimacy: () =>
        pendingPrimacyChecks === 0 && deps.isWorkspaceTrusted() && lastVerifiedPrimacy === true,
      verifyPrimacy,
      currentOwnershipGeneration: () => ownershipGeneration
    },
    {
      // The gate swallows a writer failure, so the writer reports its own: once per operation.
      run(sql, ...params) {
        if (!canWriteDurableAcpState()) return;
        const conn = getSqliteCutoverCoordinator(deps.store)?.getSqliteStore()?.writerConnection;
        if (conn === undefined) {
          reportReceiptFailure('acp-authorization-receipt', new AcpReceiptStoreDetachedError());
          return;
        }
        try {
          conn.run(sql, ...params);
        } catch (thrown) {
          reportReceiptFailure('acp-authorization-receipt', thrown);
        }
      }
    }
  );

  return {
    enabled: true,
    allowLegacyDrain: true,
    bridgeScriptPath,
    authorityGate,
    primaryWorkspaceRoot: deps.workspaceRoot,
    protectedDatabasePaths: () => getSqliteCutoverCoordinator(deps.store)?.getDatabaseProtectedPaths() ?? [],
    readConfiguredProfile: () => readUncachedAcpProfileSelector(),
    // Trigger an initial verify only when trusted and before any verdict has landed so untrusted
    // windows never read lock state and already-primed sessions do not fire floating checks.
    currentOwnershipGeneration: () => {
      if (deps.isWorkspaceTrusted() && lastVerifiedPrimacy === null && pendingPrimacyChecks === 0) {
        refreshPrimacyState();
      }
      return ownershipGeneration;
    },
    primeAuthority: async () => {
      if (!deps.isWorkspaceTrusted()) return false;
      return (await verifyPrimacy()) && canWriteDurableAcpState();
    },
    onAcpObservation: (event) => {
      if (!canWriteDurableAcpState()) return;
      getSqliteCutoverCoordinator(deps.store)?.recordAcpObservation(event);
    },
    sessionBindingStore,
    allocateConnectionGeneration,
    hostLocality
  };
}
