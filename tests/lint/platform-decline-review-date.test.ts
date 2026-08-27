// FR-R3-129 (T1492, FR-004) — the dated decline has a date that fails a build.
//
// THE PROBLEM THE ITEM NAMES, in its own words: *"a dated decline is only honest
// while someone re-reads it."*
//
// `docs/operations/platform-observation-record.md` records `FR-R3-115`'s decision:
// all three verification routes were unavailable, so Windows and Linux moved to a
// declared `unverified` tier and the routes were declined. That decision is correct
// and this gate does not reopen it. What the record carried was three reopening
// conditions — a Windows machine, a container runtime, a contributor report — and
// **no date, and nothing that notices**. A reopening condition nobody checks is a
// reopening condition that expires quietly, and a temporary decline becomes a
// permanent posture by nobody deciding.
//
// So the record carries a review date and this gate fails once it has passed. The
// failure IS the reminder. There is no other mechanism this project trusts for
// "somebody should re-read this": a calendar entry is not in the repository, and a
// note in a document is what already failed.
//
// THE DATE LIVES IN THE DOCUMENT. A gate holding its own copy would go stale with
// the document it guards, which is the failure it exists to prevent one level up —
// the class `FR-R3-116`, `122`, `123`, `124` and `126` have each closed an instance
// of. It is parsed from a machine-readable marker so the prose around it can be
// rewritten freely.
//
// WHAT THIS GATE DOES NOT DO. It cannot notice that a Windows machine became
// available or that a contributor ran the suite — those are facts about the world,
// and no gate in a repository can see them. It notices the DATE, which is the half
// that is checkable, and the record states the other half as the operator's to
// watch. Saying so is the point: a gate that implied it watched all three would be
// the overclaim this round exists to remove.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const RECORD = 'docs/operations/platform-observation-record.md';

/** The marker the date is authored under. Parsed, never restated. */
const MARKER = /<!--\s*decline-review-date:\s*(\d{4}-\d{2}-\d{2})\s*-->/;

export function readReviewDate(body: string): string | null {
  return MARKER.exec(body)?.[1] ?? null;
}

/** True when `today` is on or after the review date. */
export function reviewIsDue(reviewDate: string, today: Date): boolean {
  // Compared as ISO strings on purpose: a `Date` comparison drags a timezone into a
  // question about a calendar day, and "is it the 27th yet" has no timezone.
  return today.toISOString().slice(0, 10) >= reviewDate;
}

describe('the platform decline carries a review date (FR-R3-129)', () => {
  const body = readFileSync(resolve(REPO_ROOT, RECORD), 'utf8');

  it('the record carries the marker this gate reads', () => {
    // Vacuity control. Without it a removed marker makes the date null, and a gate
    // comparing null to today would pass — the decline silently losing its date,
    // which is exactly the state this gate exists to make impossible.
    expect(
      readReviewDate(body),
      `${RECORD} carries no '<!-- decline-review-date: YYYY-MM-DD -->' marker. The decline's ` +
        'review date is the only mechanism that makes it temporary rather than permanent; if it ' +
        'was removed deliberately, the decline was retired and this gate should go with it.'
    ).not.toBeNull();
  });

  it('the review date has not passed', () => {
    const reviewDate = readReviewDate(body)!;
    expect(
      reviewIsDue(reviewDate, new Date()),
      `The platform decline's review date (${reviewDate}) has passed. This failure is the ` +
        'reminder, and it is the whole mechanism. Re-read ' +
        `${RECORD}: either a verification route became available and the decline is retired, or ` +
        'nothing changed and the decline is re-dated with a new review date and a sentence saying ' +
        'what was re-read. Do NOT delete the marker to make this pass — that converts a temporary ' +
        'decline into a permanent posture by nobody deciding, which is the defect FR-R3-129 filed.'
    ).toBe(false);
  });

  it('the record still names the conditions this gate cannot see', () => {
    // The gate watches the date. The record must keep naming the three world-facts
    // it cannot — a Windows machine, a container runtime, a contributor report —
    // because a gate that implied it watched all three would be the overclaim this
    // round exists to remove.
    expect(body).toMatch(/What would change this/);
    for (const condition of [/Windows machine/i, /container runtime/i, /contributor/i]) {
      expect(condition.test(body), `the record no longer names ${String(condition)}`).toBe(true);
    }
  });

  it('is red on a past date and green on a future one — proved', () => {
    // The predicate is the gate. Driven both ways, and on the boundary, because
    // "on the day" is the case a >= / > slip gets wrong.
    const today = new Date('2026-08-27T12:00:00Z');
    expect(reviewIsDue('2026-08-26', today), 'yesterday is due').toBe(true);
    expect(reviewIsDue('2026-08-27', today), 'today IS due — the review happens on the day').toBe(
      true
    );
    expect(reviewIsDue('2026-08-28', today), 'tomorrow is not due').toBe(false);
    expect(reviewIsDue('2026-11-27', today), 'the recorded date is not due yet').toBe(false);

    // And the parser discriminates.
    expect(readReviewDate('<!-- decline-review-date: 2027-01-01 -->')).toBe('2027-01-01');
    expect(readReviewDate('the review date is 2027-01-01')).toBeNull();
  });
});
