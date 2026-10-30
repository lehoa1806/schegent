// FR-R4-F04 (FR-005, FR-006, FR-007, contract X; data-model §2, §4) — the transport bounds, and the pure
// decisions that apply them.
//
// Pure, no I/O: the store reads and writes, and this module says what to keep. Keeping the decision
// separate is what lets the policy be proven over arrays of records without a filesystem, and what lets
// the retention disclosure import the same constants the writers use (a bound typed twice is two bounds
// the first time one is edited).
//
// The bounds, in one place:
//
//   - `TRANSPORT_FILE_MAX_BYTES`, per Run file and per stage file. A record that alone passes it is
//     replaced by a placeholder, so no byte of it is written (FR-006). The shared log's own bound is the
//     same constant, defined once in `src/contracts/transport-bounds.ts`.
//   - A record-age bound, which is the session retention age and is read by the caller on every check.
//   - `TRANSPORT_WORKSPACE_MAX_BYTES` over every Run file and legacy generation (staging excluded), met
//     by removing the inactive file whose newest record is oldest.
//
// Compaction keeps the newest records that are inside the age bound and within half the file bound, so a
// file that reaches its bound is halved and the next compaction is a long way off (amortized, R5).

import { TRANSPORT_FILE_MAX_BYTES, TRANSPORT_WORKSPACE_MAX_BYTES } from '../../contracts/transport-bounds';

// The two size bounds are defined in `src/contracts/transport-bounds.ts`, where the privacy profiles and
// the disclosure can read them (a contract may not import the monitor), and re-exported here so the
// transport modules and their tests have one import for every transport constant.
export { TRANSPORT_FILE_MAX_BYTES, TRANSPORT_WORKSPACE_MAX_BYTES };

/** What a compaction keeps at most: half the bound, so the next one is not a record away. */
export const TRANSPORT_COMPACT_TARGET_BYTES = TRANSPORT_FILE_MAX_BYTES / 2;

/** The Run transport file's name inside `.schegent/sessions/<runId>/`. */
export const TRANSPORT_RUN_FILE_NAME = 'transport.log';

/** The stage directory's prefix under the OS temp root; never matches the raw scavenger's `schegent-raw-spool-`. */
export const TRANSPORT_SPOOL_PREFIX = 'schegent-transport-';

/** Domain separation for the workspace key of the stage directory (data-model §2). */
export const TRANSPORT_SPOOL_KEY_DOMAIN = 'schegent-transport-spool-v1\0';

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z\t/;
const PLACEHOLDER_FIELD_COUNT = 4;

/**
 * The time a record line carries, or `null` when it carries none the policy can read. The record format
 * is `<ISO timestamp>\t<runId>\t<phase>\t<stream>\t<line>`, so the time is the first field.
 */
export function recordTimeMs(line: string): number | null {
  if (!ISO_PREFIX.test(line)) return null;
  const parsed = Date.parse(line.slice(0, line.indexOf('\t')));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The line that stands in for a formatted record longer than the file bound (data-model §2). It keeps
 * the record's own timestamp, Run, phase and stream, and says how many bytes were omitted; none of the
 * record's content is in it. `<n>` is the byte length of the formatted record, its newline included.
 */
export function transportPlaceholder(formatted: string): string {
  const fields = formatted.split('\t', PLACEHOLDER_FIELD_COUNT);
  const [stamp = '', runId = '', phase = '', stream = ''] = fields;
  const omitted = Buffer.byteLength(formatted, 'utf8');
  return (
    `${stamp}\t${runId}\t${phase}\t${stream}\t` +
    `[transport record omitted: run=${runId} phase=${phase} stream=${stream} bytes=${omitted}]\n`
  );
}

/**
 * The records a compaction keeps: the newest ones that are inside the age bound and together within
 * `targetBytes`. Records are in append order, so the scan runs newest first and stops at the first one
 * that is expired or would pass the target. An empty answer means the file is removed.
 *
 * A record with no readable time is not treated as expired: the policy cannot say it is old, and the
 * size bound still removes it eventually.
 */
export function selectCompaction(
  records: readonly string[],
  nowMs: number,
  maxAgeMs: number,
  targetBytes: number = TRANSPORT_COMPACT_TARGET_BYTES
): readonly string[] {
  let keptBytes = 0;
  let firstKept = records.length;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index] ?? '';
    const at = recordTimeMs(record);
    if (at !== null && nowMs - at > maxAgeMs) break;
    const bytes = Buffer.byteLength(record, 'utf8');
    if (keptBytes + bytes > targetBytes) break;
    keptBytes += bytes;
    firstKept = index;
  }
  return records.slice(firstKept);
}

/** One file the workspace total may remove. */
export interface TotalCandidate {
  readonly id: string;
  readonly bytes: number;
  /** The time of the file's newest record; the file with the oldest one goes first. */
  readonly newestMs: number;
  /** An active Run's file (one that is executing or paused) is never removed to meet the total. */
  readonly active: boolean;
}

/**
 * The ids to remove so the sum of `candidates` is within `maxBytes`: inactive files only, the one with
 * the oldest newest record first. If the active files alone are over the bound nothing more can go, and
 * the total stays over rather than an active Run's evidence being removed.
 */
export function selectTotalRemovals(
  candidates: readonly TotalCandidate[],
  maxBytes: number = TRANSPORT_WORKSPACE_MAX_BYTES
): readonly string[] {
  let total = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
  const removable = candidates
    .filter((candidate) => !candidate.active)
    .sort((a, b) => a.newestMs - b.newestMs || a.id.localeCompare(b.id));
  const removals: string[] = [];
  for (const candidate of removable) {
    if (total <= maxBytes) break;
    removals.push(candidate.id);
    total -= candidate.bytes;
  }
  return removals;
}
