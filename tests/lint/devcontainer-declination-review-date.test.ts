// FR-R3-132 (T1505, FR-004) — the devcontainer decline has a date that fails a
// build.
//
// The audit of 2026-08-27 suggested an optional devcontainer for contributor
// parity. It was declined, for four reasons recorded in the document this gate
// reads. What makes the decline honest rather than a quiet omission is that
// somebody re-reads it: three of its four reopening conditions are EVENTS — a
// second maintainer, a contributor report, a platform leaving the `unverified`
// tier — and no gate in a repository can observe an event. The date is the half
// that is checkable, and this is the mechanism `FR-R3-129` built for exactly this
// shape.
//
// SIX MONTHS, not three. The platform decline is re-read every quarter because
// its conditions can change under it. Nothing about a devcontainer changes on its
// own.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readReviewDate, reviewIsDue } from './review-dates';

const REPO_ROOT = resolve(__dirname, '..', '..');
const RECORD = 'docs/development/devcontainer-declination.md';
const MARKER = 'devcontainer-review-date';

describe('the devcontainer decline carries a review date (FR-R3-132)', () => {
  const body = readFileSync(resolve(REPO_ROOT, RECORD), 'utf8');

  it('carries the marker this gate reads', () => {
    // Vacuity control: a removed marker makes the date null, and a gate comparing
    // null to today would pass — the decline silently losing the only thing that
    // makes it temporary.
    expect(
      readReviewDate(body, MARKER),
      `${RECORD} carries no '<!-- ${MARKER}: YYYY-MM-DD -->' marker`
    ).not.toBeNull();
  });

  it('the review date has not passed', () => {
    const reviewDate = readReviewDate(body, MARKER);
    expect(
      reviewIsDue(reviewDate ?? '9999-12-31', new Date()),
      `The devcontainer decline's review date (${reviewDate ?? 'none'}) has passed. This failure IS ` +
        `the reminder. Re-read ${RECORD}: either a reopening condition fired and the decline is ` +
        'retired, or nothing changed and it is re-dated with a sentence saying what was re-read. ' +
        'Do NOT delete the marker to make this pass.'
    ).toBe(false);
  });

  it('still names the conditions this gate cannot see', () => {
    // The gate watches a date. The record must keep naming the events it cannot,
    // because a decline whose reopening conditions vanished is a permanent posture
    // nobody decided on.
    expect(body).toContain('What would reopen it');
    for (const condition of [/second regular maintainer/i, /contributor report/i, /unverified/i]) {
      expect(condition.test(body), `the record no longer names ${String(condition)}`).toBe(true);
    }
    // And it must say what it does NOT watch, which is the overclaim guard.
    expect(body).toContain('cannot see');
  });
});
