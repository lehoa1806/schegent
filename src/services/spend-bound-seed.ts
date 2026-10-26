// FR-R3-209 — the last window of the audit log, read once at activation, so that a host restart
// does not hand every live Run its whole spend bound again.
//
// This reader is a read only. It opens `.schegent/audit.log` through the checked walk with
// `flags: 'r'`, and it never writes, truncates or unlinks the log (hard rule 9). A warning names a
// reason or an error code and never a path (hard rule 22). Rows before the window, and rows in an
// archived log, are not counted, so the tally the watcher builds from it understates by them, as
// the watcher's own eviction does.
import type { AuditEntry } from '../audit/audit-entry';
import { readBoundedTail } from '../lib/bounded-read';
import type { SanitizedLogger } from '../lib/logger';
import { openWithinRoot } from '../lib/safe-open';
import { parseAuditLogLine } from '../parser/audit-log-parser';

const AUDIT_DIR = '.schegent';
const AUDIT_FILE = 'audit.log';

/**
 * How much of the end of the audit log the seed reads: 2 MiB.
 *
 * It covers the longest Run measured on a real workspace, about 1.1 MB from its first row to its
 * last, with room, and holds at most a few thousand `phase-end` rows. It is a cap of its own and
 * not the sidebar's cold-start cap, which answers a different question: how many entries to show.
 * The log is `.schegent` content a cloned workspace can plant, so the read stays bounded.
 */
export const SPEND_SEED_MAX_BYTES = 2 * 1024 * 1024;

const ERROR_CODE_UNKNOWN = 'unknown';
const PHASE_END_EVENT = 'phase-end';

/**
 * The `phase-end` rows of the last `SPEND_SEED_MAX_BYTES` of the workspace's audit log, parsed, in
 * file order. It never rejects: an absent log returns `[]` silently, and any other refusal or
 * failed read returns `[]` and warns once.
 */
export async function readSpendSeed(
  workspaceRoot: string,
  logger: SanitizedLogger
): Promise<readonly AuditEntry[]> {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) return [];

  const opened = await openWithinRoot(workspaceRoot, [AUDIT_DIR, AUDIT_FILE], { flags: 'r' });
  if (opened.outcome === 'refused') {
    // An absent log is the ordinary first start, and stays silent. Any other refusal means the
    // path could not be proven, which an operator should be able to see.
    if (opened.errno !== 'ENOENT' && opened.errno !== 'ENOTDIR') {
      logger.warn('spend seed: read refused', { reason: opened.reason });
    }
    return [];
  }

  let contents: string;
  let skippedBytes: number;
  try {
    const { size } = await opened.handle.stat();
    const tail = await readBoundedTail(opened.handle, size, SPEND_SEED_MAX_BYTES);
    contents = tail.bytes.toString('utf8');
    skippedBytes = tail.skippedBytes;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    logger.warn('spend seed: read failed', { code: code ?? ERROR_CODE_UNKNOWN });
    return [];
  } finally {
    await opened.handle.close().catch(() => undefined);
  }

  const lines = contents.split(/\r?\n/).filter((line) => line.trim().length > 0);
  // The read starts at a byte offset, not at a row boundary. Whenever it started past the first
  // byte, the first line is a fragment, or a whole row cut exactly at its start. Either way it is
  // dropped whatever it begins with: a fragment that begins with `{` can sit inside a nested
  // object, and a figure that counts money should not lean on the parser to refuse it. The cost
  // is at most one uncounted row, which the cap already costs.
  const rows = skippedBytes > 0 ? lines.slice(1) : lines;

  const seeded: AuditEntry[] = [];
  for (const line of rows) {
    const entry = parseAuditLogLine(line);
    if (entry !== null && entry.eventType === PHASE_END_EVENT) seeded.push(entry);
  }
  return seeded;
}
