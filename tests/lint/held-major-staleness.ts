// FR-R4-F09 (FR-028, FR-029; contract HL1) -- the rule behind `held-major-staleness.test.ts`, in a
// module of its own so it can be tested at its boundary with an injected clock.
//
// Not a `.test.ts`, so importing it registers no suite. The row parser moved here from the test
// file unchanged in behavior, and `isOverdue` is the rule the test used to inline: a hold is
// overdue when its review date is MORE than the interval before the instant it is judged at.
// "More than" is the point. A review at 00:00:00Z on a date is exactly `interval` days old at
// 00:00:00Z that many days later, and that instant is not overdue; one millisecond past it is.

/** The review interval, in days. The record states the same number, and a test makes them agree. */
export const INTERVAL_DAYS = 90;

const MS_PER_DAY = 86_400_000;

/** One hold: the package, the reason a reader can act on, and the date someone last looked. */
export interface HeldRow {
  readonly pkg: string;
  readonly reason: string;
  readonly lastReviewed: string;
}

/**
 * Table rows under the held-majors heading.
 *
 * Parsed from the ENDS inward -- package first, date last -- rather than by cell index. A reason
 * cell legitimately contains an escaped pipe (`^22 \| ^24` is how a semver range reads), which
 * shifts every positional index after it and silently drops that row from the census. A parser that
 * skips the rows with the most interesting reasons is worse than no parser, so the two fields the
 * gate needs are read from the two positions an escaped pipe cannot move.
 */
export function parseHeldRows(record: string): readonly HeldRow[] {
  const out: HeldRow[] = [];
  for (const line of record.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const meaningful = line
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);
    if (meaningful.length < 4) continue;
    const date = meaningful.at(-1) ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.push({
      pkg: (meaningful.at(0) ?? '').replaceAll('`', ''),
      // Everything between the fourth cell and the date is the reason, however
      // many pipes it happens to contain.
      reason: meaningful.slice(4, -1).join(' '),
      lastReviewed: date
    });
  }
  return out;
}

/**
 * Whether a review dated `lastReviewed` (`YYYY-MM-DD`) is more than `intervalDays` old at `nowMs`.
 * The date is read as 00:00:00Z, so the answer is the same in every time zone, and `nowMs` is
 * injected, so a test chooses the instant.
 */
export function isOverdue(lastReviewed: string, nowMs: number, intervalDays: number): boolean {
  return nowMs - Date.parse(`${lastReviewed}T00:00:00Z`) > intervalDays * MS_PER_DAY;
}
