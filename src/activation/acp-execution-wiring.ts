// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Builds lazy ACP dispatch options for `BackendRunnerRegistry`. No subprocess or filesystem
// operation occurs at wiring time; each ACP transport session spawns only when a Phase executes
// in a trusted primary window, and every callback passes through `AcpAuthorityGate` (F09-FR-17).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as vscode from 'vscode';

import type { SanitizedLogger } from '../lib/logger';
import { createSideEffectFailureReporter } from '../lib/side-effect-failure-reporter';
import type { BackendRunnerFactoryOptions } from '../runner/backend-runner-factory';
import { AcpAuthorityGate } from '../services/containment-qualification/acp-authority-gate';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { getSqliteCutoverCoordinator } from './sqlite-cutover-wiring';

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

function readUncachedAcpProfileSelector(): string {
  const raw = vscode.workspace.getConfiguration('schegent.acp').get<unknown>('profile');
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
}

export function buildHostAcpDispatchOptions(
  deps: HostAcpDispatchWiringDeps
): NonNullable<BackendRunnerFactoryOptions['acpDispatch']> {
  const bridgeScriptPath = resolveBridgeScriptPath();
  const reportReceiptFailure = createSideEffectFailureReporter(deps.logger);
  // The last authoritative `hasPrimacy()` verdict; null until the first one lands.
  let lastVerifiedPrimacy: boolean | null = null;
  let ownershipGeneration = 1;

  /** Asks the lock once and records the verdict; an unreadable lock is a lost one. */
  const verifyPrimacy = async (): Promise<boolean> => {
    let held: boolean;
    try {
      held = await deps.hasPrimacy();
    } catch {
      held = false;
    }
    if (lastVerifiedPrimacy === true && !held) {
      ownershipGeneration += 1;
    }
    lastVerifiedPrimacy = held;
    return held;
  };
  const refreshPrimacyState = (): void => {
    void verifyPrimacy();
  };

  // Review gap GC-08 (2026-11-12) — the authoritative verdict decides. "A SQLite store is attached"
  // used to satisfy primacy outright, and it stays true in a window that opened its store while
  // primary and then lost primacy. The follow-up the same day removed it as a stand-in too: a
  // session awaits `primeAuthority` before it registers its scope, so a verdict is in place before
  // its first callback, and no verdict denies. The synchronous `isHeld()` is the advisory mirror,
  // which FR-R3-024 keeps out of decisions.
  const authorityGate = new AcpAuthorityGate(
    {
      isWorkspaceTrusted: () => deps.isWorkspaceTrusted(),
      holdsPrimacy: () => {
        refreshPrimacyState();
        return deps.isWorkspaceTrusted() && lastVerifiedPrimacy === true;
      },
      currentOwnershipGeneration: () => ownershipGeneration
    },
    {
      // The gate swallows a writer failure, so the writer reports its own: once per operation.
      run(sql, ...params) {
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
    readConfiguredProfile: () => readUncachedAcpProfileSelector(),
    // Read once per session, as it registers its scope: start a verify so a verdict is in place
    // before the session's first callback.
    currentOwnershipGeneration: () => {
      refreshPrimacyState();
      return ownershipGeneration;
    },
    primeAuthority: async () => (await verifyPrimacy()) && deps.isWorkspaceTrusted(),
    onAcpObservation: (event) => {
      getSqliteCutoverCoordinator(deps.store)?.recordAcpObservation(event);
    }
  };
}
