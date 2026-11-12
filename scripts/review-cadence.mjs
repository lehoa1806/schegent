// FR-R5-F21 (FR-007 to FR-011) -- the one home of the review-cadence rules.
//
// Two kinds of dated obligation live in this repository: held major upgrades (a row in
// `docs/release/held-major-upgrades.md` that is overdue more than 90 days after its review), and
// dated reviews (an HTML-comment marker in a registered record that is due on its day). Before this
// module, the gates held the rules in `tests/lint/` and nothing else could ask "what is due, and
// when". A report that re-implemented the comparisons would be a second clock, and two clocks
// disagree at exactly the boundary that matters. So the gates and `review-due-report.mjs` import
// every rule from here. The gates are CommonJS, so they load it through a literal `import()` in
// `tests/lint/review-dates.ts` (`loadReviewCadence`, re-exported by `held-major-staleness.ts`): a
// static import of this ESM module from a CommonJS file is TS1479.
//
// It also closes the hole FR-007 names: a row or marker whose date is not a real calendar day used
// to be dropped (or read as absent), so it was never overdue. It is now reported as malformed.
//
// The boundary rules are unchanged (FR-009): a hold is overdue strictly more than the interval
// after 00:00:00Z of its review day; a review is due from 00:00:00Z of its day.

/** The review interval for a held major, in days. The record states the same number. */
export const INTERVAL_DAYS = 90;

const MS_PER_DAY = 86_400_000;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const MALFORMED_TEXT_LIMIT = 200;
const HELD_SECTION = '## Held majors';
/** A heading that ends the held-majors section: level one or two. */
const SECTION_END = /^#{1,2} /;
const MIN_CELLS = 4;

/**
 * True only for a real `YYYY-MM-DD` day. The shape alone is not enough: V8 rolls `2026-02-30` over
 * to 2 March, and `2026-13-45` parses as NaN, which compares false and so reads as "never overdue".
 */
export function isCalendarDate(text) {
  if (typeof text !== 'string' || !DATE_SHAPE.test(text)) return false;
  const ms = Date.parse(`${text}T00:00:00Z`);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === text;
}

function cellsOf(line) {
  return line
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);
}

function isSeparator(line) {
  return /^\|[\s|:-]+\|?$/.test(line.trim());
}

/**
 * The lines of the held-majors section, and whether its heading was found. The section ends at the
 * next heading of level one or two only: a horizontal rule inside it ends nothing, so a row after
 * one is still read (review C1).
 */
function sectionLines(record) {
  const lines = record.split('\n');
  const out = [];
  let inside = false;
  let found = false;
  for (const [index, line] of lines.entries()) {
    if (!inside) {
      inside = line.trim() === HELD_SECTION;
      found = found || inside;
      continue;
    }
    if (SECTION_END.test(line)) break;
    out.push({ line, number: index + 1 });
  }
  return { lines: out, found };
}

function classifyRow(line) {
  const cells = cellsOf(line);
  const pkg = (cells.at(0) ?? '').replaceAll('`', '');
  const last = cells.at(-1) ?? '';
  if (cells.length < MIN_CELLS) return { malformed: DATE_SHAPE.test(last) ? 'bad-shape' : 'missing-date' };
  if (pkg.length === 0) return { malformed: 'bad-shape' };
  if (!DATE_SHAPE.test(last)) return { malformed: 'bad-shape' };
  if (!isCalendarDate(last)) return { malformed: 'impossible-date' };
  // Read from the ENDS inward: a reason may hold an escaped pipe (`^22 \| ^24`), which shifts every
  // positional index after it. Everything between the fourth cell and the date is the reason.
  return { row: { pkg, reason: cells.slice(4, -1).join(' '), lastReviewed: last } };
}

/**
 * Every table row under `## Held majors`, up to the next `# ` or `## ` heading, and whether that
 * heading was found at all, so a renamed heading cannot read as a record with no holds (review C2).
 * The header (first cell `Package`) and the separator are skipped; every other table line is a hold
 * or is malformed.
 */
export function readHeldMajors(record) {
  const rows = [];
  const malformed = [];
  const section = sectionLines(record);
  for (const { line, number } of section.lines) {
    if (!line.trim().startsWith('|') || isSeparator(line)) continue;
    if (cellsOf(line).at(0) === 'Package') continue;
    const verdict = classifyRow(line);
    if (verdict.row) {
      rows.push({ ...verdict.row, line: number });
      continue;
    }
    malformed.push({ line: number, text: line.slice(0, MALFORMED_TEXT_LIMIT), reason: verdict.malformed });
  }
  return { rows, malformed, found: section.found };
}

/** The holds of `readHeldMajors`, for callers that predate the malformed list. */
export function parseHeldRows(record) {
  return readHeldMajors(record).rows;
}

/**
 * Whether a review dated `lastReviewed` is MORE than `intervalDays` old at `nowMs`. The date is read
 * as 00:00:00Z, so the answer is the same in every time zone. Exactly the interval is not overdue.
 */
export function isOverdue(lastReviewed, nowMs, intervalDays) {
  return nowMs - Date.parse(`${lastReviewed}T00:00:00Z`) > intervalDays * MS_PER_DAY;
}

/** The first instant at which a hold reviewed on `lastReviewed` is overdue: D + 90 d + 1 ms. */
export function holdFailsFromMs(lastReviewed) {
  return Date.parse(`${lastReviewed}T00:00:00Z`) + INTERVAL_DAYS * MS_PER_DAY + 1;
}

function markerPattern(marker) {
  // Any non-space token is captured, so that a malformed date is seen and refused rather than read
  // as an absent marker.
  return new RegExp(`<!--\\s*${marker}:\\s*(\\S+?)\\s*-->`);
}

/** A review marker's state: absent, malformed (with its text), or dated (with its day). */
export function readReviewMarker(body, marker) {
  const match = markerPattern(marker).exec(body);
  if (!match) return { state: 'absent' };
  const [, text = ''] = match;
  if (!isCalendarDate(text)) return { state: 'malformed', text: text.slice(0, MALFORMED_TEXT_LIMIT) };
  return { state: 'dated', date: text };
}

/** The marker's day, or `null` when it is absent or malformed. Gates use `readReviewMarker`. */
export function readReviewDate(body, marker) {
  const read = readReviewMarker(body, marker);
  return read.state === 'dated' ? read.date : null;
}

/** Every review-date marker name in `body`, in order of appearance, whatever its date text. */
export function reviewDateMarkerNames(body) {
  const pattern = /<!--\s*([a-z][a-z0-9-]*-review-date)\s*:\s*\S+?\s*-->/g;
  return [...body.matchAll(pattern)].map(([, name = '']) => name);
}

/** True when `today` is on or after the review date, compared as UTC calendar days. */
export function reviewIsDue(reviewDate, today) {
  // Compared as ISO strings on purpose: "is it the 27th yet" has no time zone.
  return today.toISOString().slice(0, 10) >= reviewDate;
}

/** The first instant (ms since the epoch) at which a review dated `reviewDate` is due: D 00:00:00Z. */
export function reviewDueFromMs(reviewDate) {
  return Date.parse(`${reviewDate}T00:00:00Z`);
}

/**
 * Every record in this repository that carries a dated review. Moved verbatim from
 * `tests/lint/dated-review-records.test.ts` (FR-R3-134), which still holds the gate.
 *
 * Adding a deferral WITHOUT a date is what the completeness scan cannot catch: it only sees
 * markers that exist. Adding one with a date and not registering it here is what it does catch.
 */
export const DATED_REVIEW_RECORDS = Object.freeze([
  {
    document: 'docs/operations/platform-observation-record.md',
    marker: 'decline-review-date',
    defers: 'the Windows verification route and Linux verification beyond the local unit-tier leg (FR-R3-115, FR-R3-129)',
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
]);

/** Documents excluded from the completeness scan, with the reason. */
export const NOT_A_RECORD = Object.freeze([
  // The gates themselves quote the markers they read.
  'tests/lint/dated-review-records.test.ts',
  'tests/lint/review-dates.ts'
]);

