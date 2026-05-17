// Feature 014 T025 — Wake up activation / deactivation lifecycle.
//
// Responsibilities (per contracts/daemon-registration.md):
//   1. On extension activate, drive a `daemon-manager.reconcile()` so
//      that the OS state matches the persisted `schegent.wakeUp.*`
//      settings. This catches the "ran once on machine A, opened the
//      extension on machine B" drift case.
//   2. Re-publish the workspace-roots mirror file at activation time
//      (US2 / FR-024). The runner reads this file at fire time to
//      decide cwd-inside-workspace; if VS Code opens with a different
//      folder set than last save, the mirror would otherwise be stale.
//   3. On extension deactivate, attempt `daemon-manager.uninstall()`
//      and swallow errors with a single audit event
//      (`wakeup-daemon-uninstall-failed-on-deactivate` — FR-023). The
//      OS schedule MUST be torn down even if the host process is
//      shutting down on an error path.
//
// All side effects are best-effort: a failed reconcile MUST NOT block
// the rest of extension activation (FR-024). The save-handler is the
// authoritative path that proves install success — reconcile is a
// drift-detector, not an install.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { AuditAppender } from './save-handler';
import type { DaemonManager, ReconcileAction } from './daemon-manager';
import { readSettings, type WakeUpConfig } from './settings';

const SYNTHETIC_RUN_ID = 'wakeup-system';
const SYNTHETIC_PHASE = 'wakeup';

export interface ActivationDeps {
  readonly readConfig: () => WakeUpConfig;
  readonly daemonManager: DaemonManager;
  readonly workspaceRoots: () => readonly string[];
  readonly homeDir: string;
  readonly sourceRunnerPath: string;
  readonly audit: AuditAppender;
  readonly logger: { warn: (msg: string) => void };
}

export interface ActivationResult {
  readonly reconcileAction: ReconcileAction;
  readonly workspaceRootsMirrored: boolean;
}

/**
 * Run the activation lifecycle. Never throws — every failure path
 * emits a single sanitized log line and proceeds.
 */
export async function activateWakeUp(deps: ActivationDeps): Promise<ActivationResult> {
  // Mirror the workspace-roots file even when reconcile decides nothing
  // needs to change — the runner uses this file as the authoritative
  // workspace defense list (FR-024).
  const mirrored = await mirrorWorkspaceRoots(deps);

  const settings = readSettings(deps.readConfig());
  let action: ReconcileAction = 'none';
  try {
    const result = await deps.daemonManager.reconcile({
      settings,
      workspaceRoots: deps.workspaceRoots(),
      sourceRunnerPath: deps.sourceRunnerPath,
      homeDir: deps.homeDir
    });
    action = result.action;
  } catch (err) {
    deps.logger.warn(`wakeup activation reconcile failed: ${(err as Error).message}`);
  }

  return { reconcileAction: action, workspaceRootsMirrored: mirrored };
}

/**
 * Deactivation hook (FR-023). On a non-zero exit, the OS schedule must
 * still be removed if Wake up was enabled — otherwise an updated host
 * binary might launch under the old runner. Any failure is recorded as
 * a single audit event and swallowed so the extension shutdown is not
 * blocked.
 */
export async function deactivateWakeUp(deps: ActivationDeps): Promise<void> {
  const settings = readSettings(deps.readConfig());
  if (!settings.enabled) return;

  try {
    await deps.daemonManager.uninstall();
  } catch (err) {
    const message = (err as Error).message ?? 'unknown';
    deps.logger.warn(`wakeup deactivate uninstall failed: ${message}`);
    try {
      await deps.audit.append({
        runId: SYNTHETIC_RUN_ID,
        phase: SYNTHETIC_PHASE,
        iteration: 0,
        eventType: 'wakeup-daemon-uninstall-failed-on-deactivate',
        payload: { reason: message },
        outcome: 'failure'
      });
    } catch {
      /* swallow — best-effort */
    }
  }
}

/**
 * Atomic write of `<homeDir>/workspace-roots.json`. Emits an audit
 * event with the count of roots (NOT the paths — defense-in-depth so
 * a workspace-name leak via the audit log cannot happen).
 */
async function mirrorWorkspaceRoots(deps: ActivationDeps): Promise<boolean> {
  const roots = deps.workspaceRoots();
  const target = path.join(deps.homeDir, 'workspace-roots.json');
  try {
    await fs.mkdir(deps.homeDir, { recursive: true });
    const tmp = `${target}.tmp.${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify({ roots: [...roots] }, null, 2), 'utf8');
    await fs.rename(tmp, target);
  } catch (err) {
    deps.logger.warn(`wakeup workspace-roots mirror failed: ${(err as Error).message}`);
    return false;
  }

  try {
    await deps.audit.append({
      runId: SYNTHETIC_RUN_ID,
      phase: SYNTHETIC_PHASE,
      iteration: 0,
      eventType: 'wakeup-workspace-roots-updated',
      payload: { rootCount: roots.length },
      outcome: 'info'
    });
  } catch {
    /* swallow */
  }
  return true;
}
