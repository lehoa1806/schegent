import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { parseAuditLogLineDetailed } from '../parser/audit-log-parser';
import type { Notifier } from '../ui/notifications';

const COUNT_KEYS = new Set([
  'exitCode',
  'fileChangeCounts',
  'metrics',
  'omittedFileEvidenceCount',
  'omittedToolEvidenceCount',
  'outcome',
  'terminationReason',
  'toolCategoryCounts'
]);

/**
 * FR-R3-112 — the export deliberately carries NO chain fields.
 *
 * `prevDigest` links the BYTES of one on-disk entry to the next. An export is a projection: it
 * drops payload fields, renumbers nothing, and emits rows that were never the bytes the digests
 * were taken over. Carrying the digests here would produce a file that looks chain-verifiable and
 * is not — worse than one that plainly is not, because someone would eventually verify it and
 * believe the result. The whitelist below does this by construction; this note says it is on
 * purpose so a future reader does not "fix" it.
 */
export function createCountsOnlyAuditExport(input: string): string {
  const rows: string[] = [];
  for (const line of input.split(/\r?\n/)) {
    const parsed = parseAuditLogLineDetailed(line).entry;
    if (!parsed || parsed.schemaVersion !== 3) continue;
    const payload = Object.fromEntries(
      Object.entries(parsed.payload).filter(([key]) => COUNT_KEYS.has(key))
    );
    rows.push(JSON.stringify({
      id: parsed.id,
      timestamp: parsed.timestamp,
      eventType: parsed.eventType,
      phase: parsed.phase,
      iteration: parsed.iteration,
      outcome: parsed.outcome,
      schemaVersion: 3,
      payload
    }));
  }
  return rows.length > 0 ? `${rows.join('\n')}\n` : '';
}

export async function runExportAuditLog(ctx: {
  workspaceRoot: string;
  notifier: Notifier;
}): Promise<void> {
  const source = path.join(ctx.workspaceRoot, '.schegent', 'audit.log');
  let exported: string;
  try {
    exported = createCountsOnlyAuditExport(await fs.readFile(source, 'utf8'));
  } catch {
    ctx.notifier.info('Schegent: no audit log yet.');
    return;
  }
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(ctx.workspaceRoot, 'schegent-audit-v3.jsonl')),
    filters: { 'JSON Lines': ['jsonl'] },
    saveLabel: 'Export metadata-only audit'
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, Buffer.from(exported, 'utf8'));
  ctx.notifier.info('Schegent: metadata-only audit exported.');
}
