// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Builds lazy ACP dispatch options for `BackendRunnerRegistry`. No subprocess or filesystem
// operation occurs at wiring time; each ACP transport session spawns only when a Phase executes
// in a trusted primary window, and every callback passes through `AcpAuthorityGate` (F09-FR-17).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as vscode from 'vscode';

import type { SanitizedLogger } from '../lib/logger';
import type { BackendRunnerFactoryOptions } from '../runner/backend-runner-factory';
import { AcpAuthorityGate } from '../services/containment-qualification/acp-authority-gate';
import type { WorkspaceStateStore } from '../state/workspace-state';
import { getSqliteCutoverCoordinator } from './sqlite-cutover-wiring';

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
  let lastKnownPrimacy = false;
  let ownershipGeneration = 1;

  const refreshPrimacyState = (): void => {
    void deps
      .hasPrimacy()
      .then((held) => {
        if (lastKnownPrimacy && !held) {
          ownershipGeneration += 1;
        }
        lastKnownPrimacy = held;
      })
      .catch(() => {
        lastKnownPrimacy = false;
      });
  };

  const authorityGate = new AcpAuthorityGate(
    {
      isWorkspaceTrusted: () => deps.isWorkspaceTrusted(),
      holdsPrimacy: () => {
        refreshPrimacyState();
        return deps.isWorkspaceTrusted() && (lastKnownPrimacy || Boolean(getSqliteCutoverCoordinator(deps.store)?.getSqliteStore()));
      },
      currentOwnershipGeneration: () => ownershipGeneration
    },
    {
      run(sql, ...params) {
        const conn = getSqliteCutoverCoordinator(deps.store)?.getSqliteStore()?.writerConnection;
        conn?.run(sql, ...params);
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
    currentOwnershipGeneration: () => ownershipGeneration,
    onAcpObservation: (event) => {
      getSqliteCutoverCoordinator(deps.store)?.recordAcpObservation(event);
    }
  };
}
