// FR-R3-134 — every deferral this repository records carries a date that fails a
// build, and one gate knows the whole set.
//
// WHY ONE GATE AND NOT FOUR. `FR-R3-129` built the mechanism for the platform
// decline: the date lives in the document under a machine-readable marker, and a
// gate fails once it has passed, because *"a dated decline is only honest while
// someone re-reads it"*. `FR-R3-131` needed it for the owed VoiceOver matrix and
// `FR-R3-132` for the devcontainer declination. By the third copy the shared
// predicate had been extracted to `review-dates.ts` — and three gate FILES still
// each hard-coded one document and one marker.
//
// That is the duplication shape `FR-R3-132` spent a cycle removing from the
// host/webview mirror, and it has the same failure mode: the answer to *"which
// records carry a dated review?"* was three files, so a fourth deferral could be
// written with no date and nothing would notice. It did — see `RECORDS` below.
//
// THE REGISTRY IS THE POINT, not the loop. `assertsCompleteRegistry` scans the
// tree for review-date markers and fails when one is not registered here, so the
// set cannot quietly diverge from what exists. That is the control the mirror
// census did not have when it reported zero copies while reading a quarter of the
// tree (`FR-R3-133` measured that class at one instance and declined a meta-gate;
// this is the same idea applied where the set is small and enumerable).
//
// WHAT A GATE CAN AND CANNOT WATCH. It watches the DATE. It cannot see that a
// Windows machine appeared, that a contributor filed a report, or that an
// operator ran a screen reader — those are facts about the world. Every record
// below states its own unwatched conditions, and this gate asserts that it still
// does, because a record whose reopening conditions vanished is a permanent
// posture nobody decided on.
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesUnder } from './source-scan';
import { loadReviewCadence } from './review-dates';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (path: string): string => readFileSync(resolve(REPO_ROOT, path), 'utf8');

// FR-R5-F21 (FR-011): the registry (`RECORDS`) and `NOT_A_RECORD` moved to
// `scripts/review-cadence.mjs`, so the `review:due` report reads the same set
// this gate does. The entries moved verbatim, with their comments. Each describe
// loads the module before it collects, because `it.each(RECORDS)` needs the
// registry at collection time.

describe('FR-R3-134 — every dated deferral is watched, and the registry is complete', async () => {
  const {
    DATED_REVIEW_RECORDS: RECORDS,
    NOT_A_RECORD,
    readReviewDate,
    reviewDateMarkerNames,
    reviewIsDue
  } = await loadReviewCadence();

  it('registers at least the deferrals this round produced', () => {
    // The control. Every assertion below is a per-record loop; an emptied
    // registry would make all of them vacuous and report green.
    // Raised 4 -> 5 by FR-R3-169 (FR-014), then 5 -> 6 by FR-R3-170 (FR-009),
    // then 6 -> 7 by FR-R3-185. A floor that does not move when the set does is a
    // floor the new member is not standing on.
    expect(RECORDS.length).toBeGreaterThanOrEqual(7);
    expect(new Set(RECORDS.map((entry) => entry.marker)).size, 'markers must be distinct').toBe(
      RECORDS.length
    );
  });

  it.each(RECORDS)('$document carries the marker this gate reads', (record) => {
    expect(
      readReviewDate(read(record.document), record.marker),
      `${record.document} carries no '<!-- ${record.marker}: YYYY-MM-DD -->' marker. Without it ` +
        `the date is null, a comparison against null passes, and ${record.defers} becomes a ` +
        'permanent posture by nobody deciding.'
    ).not.toBeNull();
  });

  it.each(RECORDS)('$document has not passed its review date', (record) => {
    const date = readReviewDate(read(record.document), record.marker);
    expect(
      reviewIsDue(date ?? '9999-12-31', new Date()),
      `The review date for ${record.defers} (${date ?? 'none'}) has passed. This failure IS the ` +
        `reminder. Re-read ${record.document}: either a reopening condition fired and the ` +
        'deferral is retired, or nothing changed and it is re-dated with a sentence saying what ' +
        'was re-read. Do NOT delete the marker to make this pass.'
    ).toBe(false);
  });

  it.each(RECORDS)('$document still names the conditions no gate can see', (record) => {
    const body = read(record.document);
    for (const phrase of record.mustMention) {
      expect(
        body.includes(phrase),
        `${record.document} no longer says "${phrase}". A gate watches the DATE; the record must ` +
          'keep naming the world-facts it cannot, or a deferral outlives the conditions it was ' +
          'granted under.'
      ).toBe(true);
    }
  });

  it('finds no dated review record missing from the registry', () => {
    // The half that makes the registry a set rather than a list somebody
    // remembered to append to. Three separate gate files could not answer "which
    // records carry a dated review?", which is how the canary deferral was
    // written with no date at all and noticed by nobody for a day.
    const registered = new Set(RECORDS.map((entry) => `${entry.document}::${entry.marker}`));
    const excluded = new Set(NOT_A_RECORD);
    const unregistered: string[] = [];
    let scanned = 0;

    for (const absolute of filesUnder(resolve(REPO_ROOT, 'docs'), { extensions: ['.md'] })) {
      const rel = relative(REPO_ROOT, absolute);
      if (excluded.has(rel)) continue;
      scanned += 1;
      for (const name of reviewDateMarkerNames(readFileSync(absolute, 'utf8'))) {
        if (!registered.has(`${rel}::${name}`)) unregistered.push(`${rel} (${name})`);
      }
    }

    expect(scanned, 'no documents were scanned — the walk found nothing to check').toBeGreaterThan(
      50
    );
    expect(
      unregistered,
      'These documents carry a review-date marker that no RECORDS entry names. Register them: a ' +
        'gate that reads a hand-kept list cannot tell "no deferrals exist" from "the list is out ' +
        'of date", and that is exactly how the live-canary deferral came to carry three event ' +
        'triggers and no date at all.'
    ).toEqual([]);
  });
});

describe('FR-R5-F21 (FR-008): a review marker whose date is not a real day is malformed', async () => {
  const { DATED_REVIEW_RECORDS: RECORDS, readReviewDate, readReviewMarker } = await loadReviewCadence();
  const MARKER = 'x-review-date';

  it.each([
    ['a month and day that do not exist', '2026-13-45'],
    ['a day that does not exist in February', '2026-02-30']
  ])('reads %s as malformed, not absent', (_label, date) => {
    const marker = readReviewMarker(`<!-- ${MARKER}: ${date} -->`, MARKER);
    expect(marker.state).toBe('malformed');
    // The old reader returned null here, and a gate comparing against null passed.
    expect(readReviewDate(`<!-- ${MARKER}: ${date} -->`, MARKER)).toBeNull();
  });

  it('reads a real day as dated', () => {
    expect(readReviewMarker(`<!-- ${MARKER}: 2026-11-27 -->`, MARKER)).toEqual({
      state: 'dated',
      date: '2026-11-27'
    });
  });

  it('reads a document without the marker as absent', () => {
    expect(readReviewMarker('no marker here', MARKER)).toEqual({ state: 'absent' });
  });

  it.each(RECORDS)('$document carries a marker dated on a real day', (record) => {
    expect(readReviewMarker(read(record.document), record.marker).state).toBe('dated');
  });
});
