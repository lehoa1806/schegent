// Feature 058 — activation guard for multi-root workspaces (Option B per
// docs/explanation/architecture.md).
//
// Surfaces ONE non-blocking informational toast naming the canonical
// workspace folder when the extension activates against a multi-root
// `.code-workspace`. The same predicate emits a `multi-root.warning-shown`
// audit event with a deliberately path-free payload (`folderCount`,
// `canonicalFolderName`) so log/operator workflows can detect that the
// implicit-canonical behavior is in play.
//
// Contracts:
// - specs/058-multi-root-workspace/contracts/multi-root-warning-contract.md
//
// Hard rules respected:
// - "Never serialize workspace root paths into the structured audit log."
//   Only the folder's `.name` (display name, typically the basename) is
//   recorded — never `uri.fsPath`.
// - The audit event is appended BEFORE the notifier call so a notifier
//   throw cannot lose the record.
// - When `schegent.multiRoot.suppressWarning === true`, BOTH the audit
//   event and the toast are suppressed: the audit event represents an
//   actually-shown warning, not a "would have shown" hypothesis.

import type * as vscode from 'vscode';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import type { Notifier } from '../ui/notifications';
import type { MultiRootWarningShownPayload } from '../contracts/audit-events';

// Synthetic envelope identifiers — activation-time events are not bound to
// a workflow run or pipeline phase.
const SYNTHETIC_RUN_ID = 'workspace-activation';
const SYNTHETIC_PHASE = 'activation';

let alreadyShownForActivation = false;

export interface MaybeShowMultiRootWarningDeps {
  readonly workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined;
  readonly canonicalFolder: vscode.WorkspaceFolder | undefined;
  readonly suppressWarning: boolean;
  readonly auditWriter: Pick<AuditLogWriter, 'append'>;
  readonly notifier: Pick<Notifier, 'info'>;
}

function formatMessage(canonicalFolderName: string): string {
  return `Schegent: Using "${canonicalFolderName}" as the canonical workspace folder. The .schegent/ directory and audit log live in this folder only. Other folders in the workspace are treated as ordinary VS Code roots.`;
}

/**
 * Emits the multi-root warning if conditions apply.
 *
 * Returns `true` if both the audit event and notifier were invoked,
 * `false` otherwise (single-folder, suppressed, defensive bail, or
 * already-shown).
 *
 * Behavior:
 * - One-shot per activation: a second call within the same activation
 *   returns `false` without re-emitting.
 * - Audit event is awaited BEFORE the notifier call so a notifier
 *   throw cannot lose the audit record.
 * - Notifier errors are swallowed: the audit record is the durable
 *   record; the toast is a courtesy surface.
 */
export async function maybeShowMultiRootWarning(
  deps: MaybeShowMultiRootWarningDeps
): Promise<boolean> {
  if (alreadyShownForActivation) return false;
  const folders = deps.workspaceFolders;
  if (!folders || folders.length <= 1) return false;
  if (deps.suppressWarning) return false;
  const canonical = deps.canonicalFolder;
  if (!canonical) return false;

  alreadyShownForActivation = true;

  const payload: MultiRootWarningShownPayload = {
    folderCount: folders.length,
    canonicalFolderName: canonical.name
  };

  try {
    await deps.auditWriter.append({
      runId: SYNTHETIC_RUN_ID,
      phase: SYNTHETIC_PHASE,
      iteration: 0,
      eventType: 'multi-root.warning-shown',
      payload: { ...payload },
      outcome: 'info'
    });
  } catch {
    // Best-effort — append's internal chain already self-heals and logs.
  }

  try {
    deps.notifier.info(formatMessage(canonical.name));
  } catch {
    // Defensive: notifier should never throw, but if it does, the audit
    // record is already durable.
  }

  return true;
}

/**
 * Test-only hook to reset the one-shot guard. Called from `beforeEach`
 * in `multi-root-warning.test.ts`. NOT exposed to production callers.
 *
 * Production callers achieve "one fire per activation" naturally because
 * `extension.ts#activate()` only invokes `maybeShowMultiRootWarning(...)`
 * once. The module-level flag is defense-in-depth for U-7.
 */
export function resetMultiRootWarningGuardForTest(): void {
  alreadyShownForActivation = false;
}
