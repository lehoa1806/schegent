import * as fs from 'fs/promises';
import * as path from 'path';
import type { SanitizedLogger } from '../../lib/logger';
import { parseAuditLogLine } from '../../parser/audit-log-parser';
import { projectAuditEntry } from './audit-tail-projector';
import { AUDIT_TAIL_MAX, type AuditTailEntry } from './snapshot';

// Feature 068 (US3 / FR-006, FR-007, FR-010) — synchronous-style cold-start
// replay of the persisted audit log so the webview's System tab is non-empty
// on workspace reload before any live audit event arrives.
//
// Contract: see specs/068-enhance-system-log/contracts/audit-tail-projector.md §2.
//
// The reader is read-only. It must never write, truncate, or unlink the log
// (CLAUDE.md hard rule: "Never implement task or phase deletion by erasing
// .schegent/audit.log"). On any I/O failure it returns `[]` and warn-logs once
// with a sanitized error code — the workspaceRoot path itself MUST NOT be
// serialized into the log message (CLAUDE.md hard rule: "Never serialize
// workspace root paths into the structured audit log").

const AUDIT_DIR = '.schegent';
const AUDIT_FILE = 'audit.log';

export async function readAuditTailColdStart(
  workspaceRoot: string,
  logger?: SanitizedLogger
): Promise<readonly AuditTailEntry[]> {
  // T027 — empty / whitespace workspaceRoot guard. The audit writer rejects
  // empty roots at startup; defensively short-circuit on the read path so a
  // missing workspace folder during boot does not synthesize a bogus path.
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
    return Object.freeze([]);
  }

  const filePath = path.join(workspaceRoot, AUDIT_DIR, AUDIT_FILE);
  let contents: string;
  try {
    contents = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return Object.freeze([]);
    logger?.warn('audit-coldstart: read failed', { code: code ?? 'unknown' });
    return Object.freeze([]);
  }

  const lines = contents.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return Object.freeze([]);

  const tailLines = lines.slice(Math.max(0, lines.length - AUDIT_TAIL_MAX));
  const projected: AuditTailEntry[] = [];
  let warnedOnce = false;
  for (let i = 0; i < tailLines.length; i++) {
    const entry = parseAuditLogLine(tailLines[i]!);
    if (entry) {
      projected.push(projectAuditEntry(entry));
      continue;
    }
    if (!warnedOnce) {
      logger?.warn('audit-coldstart: dropped unparseable audit log line(s)');
      warnedOnce = true;
    }
  }

  return Object.freeze(projected);
}
