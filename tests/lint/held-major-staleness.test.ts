// FR-R3-090 (SUP-01) — a held upgrade with no review date is indistinguishable
// from a forgotten one.
//
// The holds themselves are correct: pinning `@types/node` to the runtime floor
// is load-bearing, and re-baselining a linter or a DOM inside an unrelated
// change is how a real regression hides behind churn. `SUP-01` does not ask for
// the upgrades; it asks for a cadence, because "deliberate" and "forgotten" look
// identical from outside without one.
//
// So this fails when a row's `lastReviewed` is more than 90 days old. Re-
// affirming a hold is a valid outcome — the cadence exists so the decision is
// made again, not so the upgrade is taken.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const RECORD = resolve(REPO_ROOT, 'docs/release/held-major-upgrades.md');
const INTERVAL_DAYS = 90;

const record = readFileSync(RECORD, 'utf8');

interface Row {
  readonly pkg: string;
  readonly reason: string;
  readonly lastReviewed: string;
}

/**
 * Table rows under the held-majors heading.
 *
 * Parsed from the ENDS inward — package first, date last — rather than by cell
 * index. A reason cell legitimately contains an escaped pipe (`^22 \| ^24` is
 * how a semver range reads), which shifts every positional index after it and
 * silently drops that row from the census. A parser that skips the rows with the
 * most interesting reasons is worse than no parser, so the two fields this gate
 * needs are read from the two positions an escaped pipe cannot move.
 */
function rows(): readonly Row[] {
  const out: Row[] = [];
  for (const line of record.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    const meaningful = cells.filter((cell) => cell.length > 0);
    if (meaningful.length < 4) continue;
    const date = meaningful[meaningful.length - 1] as string;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.push({
      pkg: (meaningful[0] as string).replaceAll('`', ''),
      // Everything between the fourth cell and the date is the reason, however
      // many pipes it happens to contain.
      reason: meaningful.slice(4, -1).join(' '),
      lastReviewed: date
    });
  }
  return out;
}

const HELD = rows();

describe('FR-R3-090 — every held major upgrade carries a reason and a fresh review date', () => {
  it('the record names holds, so an empty record cannot read as compliance', () => {
    // A record with no rows would pass every assertion below. That is the shape
    // this whole round exists to forbid, so the floor is explicit.
    expect(HELD.length).toBeGreaterThanOrEqual(4);
    expect(record).toContain('Review interval');
  });

  it('the stated interval is the one this gate enforces', () => {
    // Two authorities on one number, made to agree: the document tells a reader
    // 90 days and the gate must not quietly use a different figure.
    expect(record).toContain(`**${INTERVAL_DAYS} days**`);
  });

  it('every hold carries a reason a reader can act on', () => {
    const thin = HELD.filter((row) => row.reason.length < 80).map((row) => row.pkg);
    expect(
      thin,
      'A one-line reason cannot be re-decided in 90 days\' time. Say what the upgrade would ' +
        'cost and what the hold protects.'
    ).toEqual([]);
  });

  it('no hold has gone more than 90 days without a review', () => {
    const now = Date.now();
    const stale = HELD.filter((row) => {
      const reviewed = Date.parse(`${row.lastReviewed}T00:00:00Z`);
      return (now - reviewed) / 86_400_000 > INTERVAL_DAYS;
    }).map((row) => `${row.pkg} (last reviewed ${row.lastReviewed})`);
    expect(
      stale,
      `These holds are overdue. Re-derive the current major with 'npm view <pkg> version', ` +
        `decide again — re-affirming is a valid outcome — and update lastReviewed. Do not ` +
        `re-date without looking: the date is a claim that someone considered it.`
    ).toEqual([]);
  });

  it('every held package is actually declared, so the record cannot outlive its subject', () => {
    // The stale-exemption shape, one record over: a row for a dependency that is
    // gone is a hold nobody can act on.
    const manifests = ['package.json', 'webview-ui/package.json'].map(
      (file) => JSON.parse(readFileSync(resolve(REPO_ROOT, file), 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      }
    );
    const declared = new Set(
      manifests.flatMap((manifest) => [
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {})
      ])
    );
    const orphaned = HELD.filter((row) => !declared.has(row.pkg)).map((row) => row.pkg);
    expect(orphaned).toEqual([]);
  });

  it('NON-VACUITY: a backdated row is detected', () => {
    // In memory, against the real record's real text.
    const backdated = record.replace(/\| 2026-08-25 \|/, '| 2020-01-01 |');
    expect(backdated).not.toBe(record);
    const now = Date.now();
    const stale = backdated
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .map((line) => {
        const meaningful = line.split('|').map((cell) => cell.trim()).filter((cell) => cell.length > 0);
        return (meaningful[meaningful.length - 1] ?? '') as string;
      })
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
      .filter((date) => (now - Date.parse(`${date}T00:00:00Z`)) / 86_400_000 > INTERVAL_DAYS);
    expect(stale.length).toBeGreaterThan(0);
  });
});
