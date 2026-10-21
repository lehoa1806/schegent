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
import { readReviewDate, reviewDateMarkerNames, reviewIsDue } from './review-dates';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (path: string): string => readFileSync(resolve(REPO_ROOT, path), 'utf8');

interface DatedRecord {
  /** The document carrying the date. */
  readonly document: string;
  /** The HTML-comment marker the date is authored under. */
  readonly marker: string;
  /** What is deferred, for the failure message. */
  readonly defers: string;
  /** Phrases the record must keep, so its unwatched conditions cannot vanish. */
  readonly mustMention: readonly string[];
}

/**
 * Every deferral in this repository that carries a dated review.
 *
 * Adding a deferral WITHOUT a date is what `assertsCompleteRegistry` cannot
 * catch — it only sees markers that exist. Adding one with a date and not
 * registering it here is what it does catch.
 */
const RECORDS: readonly DatedRecord[] = [
  {
    document: 'docs/operations/platform-observation-record.md',
    marker: 'decline-review-date',
    defers: 'the Windows and Linux verification routes (FR-R3-115, FR-R3-129)',
    mustMention: ['What would change this', 'Windows machine', 'container runtime', 'contributor']
  },
  {
    document: 'docs/release/accessibility-at-matrix.md',
    marker: 'at-matrix-review-date',
    defers: 'the macOS/VoiceOver task matrix (FR-R3-131)',
    mustMention: ['The VoiceOver procedure', 'Do not mark a row from an automated result']
  },
  {
    document: 'docs/development/devcontainer-declination.md',
    marker: 'devcontainer-review-date',
    defers: 'the contributor reference environment (FR-R3-132)',
    mustMention: ['What would reopen it', 'second regular maintainer', 'contributor report', 'cannot see']
  },
  {
    // FR-R3-134 — THE ONE THE THREE-FILE ARRANGEMENT LET THROUGH. `FR-R3-129`
    // recorded the first live canary run as owed and gave it three EVENT
    // triggers and no date, while every sibling deferral it wrote the same week
    // got one. Its first trigger also named a mechanism that does not exist:
    // `npm run release:preflight` contains zero occurrences of "canary".
    document: 'docs/operations/live-canary-cadence.md',
    marker: 'canary-review-date',
    defers: 'the first live backend canary run (FR-R3-129)',
    mustMention: ['is OWED', 'Trigger for the first run', 'version-drift']
  },
  {
    // FR-R3-169 — the first entry here that is not a deferral. The CSP
    // supply-chain policy was DECIDED, and the build-time check it was chosen
    // for went unwritten from 2026-05-10 to 2026-09-06. It is registered for the
    // same reason the four above are: its three reversal conditions are events
    // no gate can observe, so the date is the only thing that makes anyone
    // re-read them. A decision whose reversal conditions have quietly lapsed is
    // as much a posture nobody chose as an expired deferral is.
    document: 'docs/security/csp-supply-chain-record.md',
    marker: 'csp-supply-chain-review-date',
    defers: 'the reject-at-build option and the remote-asset ban it rests on (FR-R3-169)',
    mustMention: [
      'What would reverse this',
      'remote font, stylesheet or script',
      'vscode-webview://',
      'reject-at-build Vite plugin',
      'cannot see'
    ]
  },
  {
    // FR-R3-170 — the first entry that is neither a deferral nor a decision. It
    // is a DEBT: two specs are built and waiting on an operator at a dev host,
    // and until this record existed the wait had no owner and no end. The status
    // word `Verification Pending` was the whole of the claim, and it obliged
    // nothing — `014-wake-up` held it for 25 days after its capability was
    // deleted from the product, with two governance rules passing over it in
    // silence.
    //
    // It is registered here rather than dated in the specs themselves because
    // this scan reads `repo/docs/**` and cannot see `specs/`. A date authored in
    // a spec would be watched by nothing and registered nowhere — the sixth
    // marker home, which is the shape FR-R3-134 built this registry to remove.
    document: 'docs/operations/interactive-verification-register.md',
    marker: 'interactive-verification-review-date',
    defers: 'the interactive dev-host evidence owed by specs 067 and 068 (FR-R3-170)',
    mustMention: [
      'Who owes this',
      'What would close this',
      'Whether anybody actually looked',
      'T036 is not owed',
      'cannot see'
    ]
  },
  {
    // FR-R3-185 — a DECISION, registered for the reason FR-R3-169's CSP record is.
    // English-only was decided on 2026-08-22 (FR-R3-030) with one reversal
    // condition and no date. Its reopen events — a non-English-speaking operator, a
    // marketplace listing aimed at one, an offered translation — are facts about
    // the world that no gate can observe, so the date is the only thing that makes
    // anyone re-read them. The posture gate beside it watches the TREE for a
    // localization mechanism; this entry watches the CALENDAR for the audience.
    document: 'docs/concepts/english-only-not-localizable.md',
    marker: 'localization-review-date',
    defers: "localizing the extension's user-visible strings (FR-R3-030, re-taken by FR-R3-185)",
    mustMention: [
      'The condition that would reopen this',
      'non-English-speaking operator',
      'distribution posture',
      'offers a translation',
      'cannot see'
    ]
  }
];

/** Documents excluded from the completeness scan, with the reason. */
const NOT_A_RECORD: readonly string[] = [
  // The gates themselves quote the markers they read.
  'tests/lint/dated-review-records.test.ts',
  'tests/lint/review-dates.ts'
];

describe('FR-R3-134 — every dated deferral is watched, and the registry is complete', () => {
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
