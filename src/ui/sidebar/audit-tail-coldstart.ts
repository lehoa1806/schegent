import type { SanitizedLogger } from '../../lib/logger';
import { parseAuditLogLine } from '../../parser/audit-log-parser';
import { projectAuditEntry } from './audit-tail-projector';
import { AUDIT_TAIL_MAX, type AuditTailEntry } from './snapshot';
import { readBoundedTail } from '../../lib/bounded-read';
import { openWithinRoot } from '../../lib/safe-open';

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

/**
 * FR-R3-082 (T1095) — how much of the end of the audit log a cold start reads.
 *
 * 256 KiB. `AUDIT_TAIL_MAX` bounds the number of ENTRIES the sidebar shows;
 * this bounds the BYTES read to find them, and the two are different questions.
 * Generous for the entry count above at any realistic entry size, and four
 * orders of magnitude below what an unbounded read of a planted log would take.
 */
const AUDIT_TAIL_MAX_BYTES = 256 * 1024;

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

  // FR-R3-082 (T1095) — the END of the file, under a byte cap, through the
  // checked walk. One visit closes both of this module's findings.
  //
  // `REL-07`: this read the WHOLE audit log to show a TAIL. The log is
  // `.schegent` content a cloned workspace can plant, and this runs at
  // activation, so a large planted log made the extension host resident in it
  // before the sidebar had drawn anything. Reading from the end costs the cap
  // rather than the file.
  //
  // The migration half is the same call: the components are walked rather than
  // the path composed, which is what struck this module from the ledger.
  const opened = await openWithinRoot(workspaceRoot, [AUDIT_DIR, AUDIT_FILE], { flags: 'r' });
  if (opened.outcome === 'refused') {
    // An absent log is the ordinary cold start — nothing has run yet — and stays
    // silent. Anything else is reported: an audit tail that shows nothing
    // because its path could not be proven must not look like a workspace with
    // no history.
    if (opened.errno !== 'ENOENT' && opened.errno !== 'ENOTDIR') {
      logger?.warn('audit-coldstart: read refused', { reason: opened.reason });
    }
    return Object.freeze([]);
  }

  let contents: string;
  let skippedBytes = 0;
  try {
    const { size } = await opened.handle.stat();
    const tail = await readBoundedTail(opened.handle, size, AUDIT_TAIL_MAX_BYTES);
    contents = tail.bytes.toString('utf8');
    skippedBytes = tail.skippedBytes;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    logger?.warn('audit-coldstart: read failed', { code: code ?? 'unknown' });
    return Object.freeze([]);
  } finally {
    await opened.handle.close().catch(() => undefined);
  }

  const lines = contents.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // The first line is a fragment whenever the cap cut into the file, because the
  // read starts at a byte offset and not at a record boundary. Dropped rather
  // than parsed: half an entry is not a smaller entry.
  if (lines.length > 0 && !lines[0]!.trimStart().startsWith('{')) lines.shift();
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

  // Reported only when the cap actually cost the view something.
  //
  // The original intent, kept verbatim: "a tail that quietly starts 4 GiB in
  // looks like a short log, and an operator reading it would draw conclusions
  // from an absence this host manufactured." That absence is real only when the
  // bytes read could not fill the view. `AUDIT_TAIL_MAX` bounds what the sidebar
  // shows at fifty entries, so a cap that recovered fifty or more produced
  // exactly the display an unbounded read would have produced, and there is no
  // manufactured absence to explain.
  //
  // Emitting it on `skippedBytes > 0` alone made it permanent furniture. The
  // audit log is append-only and this product may never erase it, so every
  // long-lived workspace crosses 256 KiB once and then warns on every cold start
  // forever, about a condition that is by design and that no operator can act
  // on. Measured on 2026-08-31 against a real 1.41 MB log: 1.15 MB skipped, 431
  // entries still inside the cap, for a view that shows 50 — 8x more than it
  // could display. Finding 4 of the 2026-08-30 host-log triage read that warning
  // as evidence the log had outgrown the cap and needed rotation; the arithmetic
  // says the cap is doing its job and the warning was the defect.
  //
  // `recoveredEntries` rides along because `skippedBytes` alone never answered
  // the question an operator actually has, which is whether anything is missing
  // from what they are looking at.
  if (skippedBytes > 0 && projected.length < AUDIT_TAIL_MAX) {
    logger?.warn('audit-coldstart: log exceeds the tail byte cap; earlier entries not read', {
      skippedBytes,
      recoveredEntries: projected.length
    });
  }

  return Object.freeze(projected);
}
