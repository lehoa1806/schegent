// Shared by the gates that make a dated record fail once its date has passed.
//
// FR-R3-129 introduced the mechanism for the platform decline: *"a dated decline
// is only honest while someone re-reads it"*, so the date lives in the document
// under a machine-readable marker and a gate fails on the day. FR-R3-131 needed
// the same thing for the assistive-technology matrix's owed VoiceOver rows, and a
// second copy of the comparison is how the two would eventually disagree about
// what "on the day" means.
//
// The MARKER NAME stays per-gate and the DATE stays in the document. Only the
// predicate is shared — this module holds no dates.
export function readReviewDate(body: string, marker: string): string | null {
  const pattern = new RegExp(`<!--\\s*${marker}:\\s*(\\d{4}-\\d{2}-\\d{2})\\s*-->`);
  return pattern.exec(body)?.[1] ?? null;
}

/** True when `today` is on or after the review date. */
export function reviewIsDue(reviewDate: string, today: Date): boolean {
  // Compared as ISO strings on purpose: a `Date` comparison drags a timezone into a
  // question about a calendar day, and "is it the 27th yet" has no timezone.
  return today.toISOString().slice(0, 10) >= reviewDate;
}
