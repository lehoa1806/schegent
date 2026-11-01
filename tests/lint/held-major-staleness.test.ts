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
//
// FR-R4-F09 (FR-028, FR-029; contract HL1, L2) rewrote the arithmetic out of this file. The rule
// is `isOverdue`, a pure function of the review date, an injected instant and the interval, in
// `held-major-staleness.ts`, and it is tested at its boundary: exactly 90 days is not overdue,
// one millisecond later is, and a review at 00:00:00Z gives the same answer whichever zone the
// instant is written in. The real records are still judged against `Date.now()`, so the gate
// still fails on the calendar. The non-vacuity case used to depend on the real rows being dated
// 2026-08-25, so re-dating them would have broken it; it now plants its own row.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INTERVAL_DAYS, isOverdue, parseHeldRows } from './held-major-staleness';

const REPO_ROOT = resolve(__dirname, '..', '..');
const RECORD = resolve(REPO_ROOT, 'docs/release/held-major-upgrades.md');

const record = readFileSync(RECORD, 'utf8');
const HELD = parseHeldRows(record);

const DAY_MS = 86_400_000;
/** The first instant at which a review dated 2026-08-25 is more than 90 days old is just after this. */
const BOUNDARY = Date.parse('2026-11-23T00:00:00Z');

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
    expect(INTERVAL_DAYS).toBe(90);
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
    const stale = HELD.filter((row) => isOverdue(row.lastReviewed, now, INTERVAL_DAYS)).map(
      (row) => `${row.pkg} (last reviewed ${row.lastReviewed})`
    );
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
});

describe('the 90-day boundary is exact (FR-028, SC-008)', () => {
  it('is not overdue at exactly 90 days', () => {
    expect(isOverdue('2026-08-25', BOUNDARY, INTERVAL_DAYS)).toBe(false);
  });

  it.each([
    ['one millisecond', 1],
    ['one second', 1000]
  ])('is overdue %s later', (_label, extra) => {
    expect(isOverdue('2026-08-25', BOUNDARY + extra, INTERVAL_DAYS)).toBe(true);
  });

  it('is not overdue one millisecond before', () => {
    expect(isOverdue('2026-08-25', BOUNDARY - 1, INTERVAL_DAYS)).toBe(false);
  });

  it('measures from 00:00:00Z of the review date, not from local midnight', () => {
    expect(BOUNDARY - Date.parse('2026-08-25T00:00:00Z')).toBe(90 * DAY_MS);
  });

  it.each([
    ['UTC-5', '2026-11-22T19:00:00-05:00', '2026-11-22T19:00:00.001-05:00'],
    ['UTC+5:30', '2026-11-23T05:30:00+05:30', '2026-11-23T05:30:00.001+05:30'],
    ['UTC+13', '2026-11-23T13:00:00+13:00', '2026-11-23T13:00:00.001+13:00']
  ])('gives the same answer for the boundary instant written in %s', (_zone, exact, after) => {
    expect(Date.parse(exact)).toBe(BOUNDARY);
    expect(isOverdue('2026-08-25', Date.parse(exact), INTERVAL_DAYS)).toBe(false);
    expect(isOverdue('2026-08-25', Date.parse(after), INTERVAL_DAYS)).toBe(true);
  });

  it('applies whatever interval it is given', () => {
    expect(isOverdue('2026-08-25', Date.parse('2026-09-24T00:00:00Z'), 30)).toBe(false);
    expect(isOverdue('2026-08-25', Date.parse('2026-09-24T00:00:00.001Z'), 30)).toBe(true);
  });
});

describe('NON-VACUITY: the gate can fail without depending on today\'s dates', () => {
  const table = (date: string): string =>
    [
      '| Package | Tree | Held at | Current major | Reason | lastReviewed |',
      '|---|---|---|---|---|---|',
      `| \`planted-package\` | repo | \`^1.0.0\` | \`2.x\` | ${'A reason long enough to be acted on. '.repeat(3)} | ${date} |`
    ].join('\n');

  it('reports a synthetic row dated 2020', () => {
    const rows = parseHeldRows(table('2020-01-01'));
    expect(rows).toHaveLength(1);
    expect(rows.filter((row) => isOverdue(row.lastReviewed, Date.now(), INTERVAL_DAYS))).toHaveLength(1);
  });

  it('CONTROL: does not report a synthetic row reviewed today', () => {
    const today = new Date(Date.now()).toISOString().slice(0, 10);
    const rows = parseHeldRows(table(today));
    expect(rows).toHaveLength(1);
    expect(rows.filter((row) => isOverdue(row.lastReviewed, Date.now(), INTERVAL_DAYS))).toEqual([]);
  });

  it('reads a reason that contains an escaped pipe, so the row is not dropped', () => {
    const text = table('2026-08-25').replace('A reason', 'A reason with `^22 \\| ^24` in it, and');
    const rows = parseHeldRows(text);
    expect(rows).toHaveLength(1);
    expect(rows.at(0)?.lastReviewed).toBe('2026-08-25');
    // Both sides of the pipe are in the reason, so it is still long enough to be acted on.
    expect(rows.at(0)?.reason).toContain('^22');
    expect(rows.at(0)?.reason).toContain('^24');
  });
});
