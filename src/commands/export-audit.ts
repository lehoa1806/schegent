import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { AuditLogWriter } from '../audit/audit-log-writer';
import {
  countsOnlyAuditExport,
  createCountsOnlyAuditExport
} from '../services/audit-export/counts-only-export';
import { exportOutcomePayload, type ExportOutcome } from '../contracts/evidence-export-outcome';
import { openWithinRoot } from '../lib/safe-open';
import { resolveContainedLink, resolveWritableAnchor } from '../lib/path-containment';
import { restoreOwnerOnly } from '../services/evidence-export';
import { resolveExportDestination, type ExportDestinationUri } from '../services/export-destination';
import type { Notifier } from '../ui/notifications';
import { EXPORT_TEXT } from './evidence-commands';

export { countsOnlyAuditExport, createCountsOnlyAuditExport };

/** The audit export's file name, suggested in the save dialog (E4). */
export const AUDIT_EXPORT_FILE_NAME = 'schegent-audit-v3.jsonl';

export interface ExportAuditLogDeps {
  readonly workspaceRoot: string;
  readonly notifier: Notifier;
  /** FR-R4-F04 (E1) — the export's outcome is one row, through the writer's own append. */
  readonly auditWriter: Pick<AuditLogWriter, 'append'>;
  /**
   * FR-R4-F04 (E4) — the save dialog, handed the suggested path (the home directory plus the file name)
   * and answering the operator's choice as a URI-like value, or `undefined` for a dismissal.
   */
  readonly promptForTarget: (suggestedPath: string) => Promise<ExportDestinationUri | undefined>;
  /** Defaults to the OS answer; a test passes a temporary directory. */
  readonly homeDirectory?: () => string;
}

/** One outcome, one row: `runId` is `''`, the audit-metadata export names no Run. `true` when it landed. */
async function recordOutcome(deps: ExportAuditLogDeps, outcome: ExportOutcome): Promise<boolean> {
  try {
    await deps.auditWriter.append({
      runId: '',
      phase: 'operator',
      iteration: 0,
      eventType: 'evidence-exported',
      outcome: 'info',
      payload: { ...exportOutcomePayload(outcome) }
    });
    return true;
  } catch {
    return false;
  }
}

export async function runExportAuditLog(deps: ExportAuditLogDeps): Promise<void> {
  const source = path.join(deps.workspaceRoot, '.schegent', 'audit.log');
  let exported: ReturnType<typeof countsOnlyAuditExport>;
  try {
    exported = countsOnlyAuditExport(await fs.readFile(source, 'utf8'));
  } catch {
    // No audit log yet: nothing to export, and nothing worth recording (an append would create the log
    // only to say an export of it was refused).
    deps.notifier.info('Schegent: no audit log yet.');
    return;
  }
  const picked = await deps.promptForTarget(path.join((deps.homeDirectory ?? os.homedir)(), AUDIT_EXPORT_FILE_NAME));
  // A dismissed dialog decided nothing, and records nothing.
  if (!picked || picked.fsPath.length === 0) return;

  const refuse = async (refusal: Extract<ExportOutcome, { outcome: 'refused' }>['refusal']): Promise<void> => {
    const recorded = await recordOutcome(deps, { kind: 'audit-metadata', outcome: 'refused', included: 0, omitted: exported.omitted, refusal });
    void deps.notifier.warn(`Schegent: export refused. ${EXPORT_TEXT.refusal[refusal]}`);
    if (!recorded) void deps.notifier.warn(EXPORT_TEXT.notRecorded);
  };

  const destination = await resolveExportDestination(picked, deps.workspaceRoot);
  if (!destination.ok) {
    await refuse(destination.refusal);
    return;
  }
  let targetExistedBefore = false;
  let priorBytes: Buffer | null = null;
  try {
    const st = await fs.lstat(destination.path);
    if (st.isFile()) {
      targetExistedBefore = true;
      priorBytes = await fs.readFile(destination.path);
    }
  } catch {
    // Target did not exist before this attempt.
  }
  // Opened through the checked walk beneath the destination's resolved parent, `0600` (E5): an existing
  // file is narrowed and truncated, a new one is created owner-only, and a link in any component refuses.
  const located = await resolveWritableAnchor(path.dirname(destination.path));
  if (located === null || located.tail.length > 0) {
    await refuse('write-failed');
    return;
  }
  const leaf = path.basename(destination.path);
  const opened = await openWithinRoot(located.anchor, [leaf], { flags: 'w', fileMode: 0o600 });
  if (opened.outcome === 'refused') {
    await refuse('write-failed');
    return;
  }
  let writeSucceeded = false;
  try {
    await opened.handle.write(exported.text, null, 'utf8');
    writeSucceeded = true;
  } catch {
    await opened.handle.close().catch(() => undefined);
    // The undo goes through the checked walk and the containment oracle, as the write did, so a
    // link planted since cannot aim it outside the destination's directory.
    if (targetExistedBefore && priorBytes !== null) {
      await restoreOwnerOnly(located.anchor, leaf, priorBytes);
    } else {
      const created = await resolveContainedLink(destination.path, [located.anchor]);
      if (created.outcome === 'contained') {
        await fs.rm(created.resolved, { force: true }).catch(() => undefined);
      }
    }
    await refuse('write-failed');
    return;
  } finally {
    if (writeSucceeded) {
      await opened.handle.close().catch(() => undefined);
    }
  }

  const recorded = await recordOutcome(deps, {
    kind: 'audit-metadata',
    outcome: 'exported',
    included: exported.included,
    omitted: exported.omitted
  });
  deps.notifier.info('Schegent: metadata-only audit exported.');
  // The file stays whatever the append did (E6); the operator is told it was not recorded.
  if (!recorded) void deps.notifier.warn(EXPORT_TEXT.notRecorded);
}
