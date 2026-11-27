// FR-R4-F04 (FR-018, contract A6; data-model §7) — which audit generations carry legacy content.
//
// Before schema v3 the audit log carried CLI output (`monitor-stdout-line` and `monitor-stderr-line` rows)
// and the command line of each CLI invocation (`cli-invocation` rows with a `command`). Those rows are
// content, not metadata, and an old history can still hold them. A reader who knows the current audit log
// is metadata only would assume the same of every file in an export, so the export names each file's
// class. This module classifies bytes and nothing else: it never changes or removes a byte, and a legacy
// row leaves only when pruning cuts the whole archive that holds it.
//
// Pure. A line that does not parse is ignored in both directions: it cannot make a generation legacy and
// it does not hide a legacy row beside it.

import { MONITOR_EVENT_TYPES } from '../contracts/audit-events';

/** What an audit generation holds. */
export type AuditGenerationClass = 'metadata-only' | 'legacy-content';

// The two retired per-line events, picked from the registry that keeps them parseable (`-line` is how both end)
// rather than spelled here: a retired name is read-only and belongs in one place (`no-transport-in-audit.test.ts`).
const RETIRED_STREAM_EVENTS: ReadonlySet<string> = new Set(MONITOR_EVENT_TYPES.filter((eventType) => eventType.endsWith('-line')));
const FIRST_SCHEMA_WITHOUT_COMMAND = 3;

interface RowShape {
  readonly eventType?: unknown;
  readonly schemaVersion?: unknown;
  readonly payload?: unknown;
}

function isLegacyRow(row: RowShape): boolean {
  if (typeof row.eventType !== 'string') return false;
  if (RETIRED_STREAM_EVENTS.has(row.eventType)) return true;
  if (row.eventType !== 'cli-invocation') return false;
  if (typeof row.schemaVersion !== 'number' || row.schemaVersion >= FIRST_SCHEMA_WITHOUT_COMMAND) return false;
  const payload = row.payload;
  return typeof payload === 'object' && payload !== null && (payload as { command?: unknown }).command !== undefined;
}

/** Whether an audit generation holds retired stream content (`legacy-content`) or metadata only. Pure; never throws. */
export function classifyAuditGeneration(bytes: Uint8Array | string): AuditGenerationClass {
  const text = typeof bytes === 'string' ? bytes : Buffer.from(bytes).toString('utf8');
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed === 'object' && parsed !== null && isLegacyRow(parsed as RowShape)) return 'legacy-content';
  }
  return 'metadata-only';
}
