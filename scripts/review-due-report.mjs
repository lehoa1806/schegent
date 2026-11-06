// FR-R5-F21 (FR-010 to FR-014) -- `npm run review:due`: every dated obligation in this repository,
// with the instant it starts failing, in one read-only list.
//
// Two lint gates hold the dates: `held-major-staleness` fails a hold more than 90 days after its
// review, and `dated-review-records` fails a registered review once its day arrives. Each gate
// says so only once it has failed. This report says so in advance, and shows what is coming.
//
// It is advisory. The gates remain the enforcement, and no script that gives a verdict reaches this
// one (`tests/lint/review-due-is-report-only.test.ts`). Every rule it applies is imported from
// `review-cadence.mjs`, the module the gates read, so the report and a gate cannot disagree about a
// date. It writes no file. Contract: `specs/282-dependency-review-cadence/contracts/review-due-report.md`
// in the workspace.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokedAsScript } from './invoked-as-script.mjs';
import {
  DATED_REVIEW_RECORDS,
  INTERVAL_DAYS,
  NOT_A_RECORD,
  holdFailsFromMs,
  isCalendarDate,
  isOverdue,
  readHeldMajors,
  readReviewMarker,
  reviewDateMarkerNames,
  reviewDueFromMs,
  reviewIsDue
} from './review-cadence.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELD_RECORD = 'docs/release/held-major-upgrades.md';
const DOCS_DIR = 'docs';
/** The directories the dated-review gate's walk skips, so both scans read the same files. */
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', '.git', '.svelte-kit']);
const HOLD_TRIGGER = `held-major review every ${String(INTERVAL_DAYS)} days`;
const MARKER_TRIGGER = 'not in the dated-review registry';
/** An ISO-8601 UTC instant: a calendar day, a time, optional fractional seconds, and `Z`. */
const INSTANT_SHAPE = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/;
const USAGE = 'review-due: usage: node scripts/review-due-report.mjs [--now <ISO-8601 UTC instant>] [--root <dir>]';

const EXIT_CURRENT = 0;
const EXIT_ATTENTION = 1;
const EXIT_UNREADABLE = 2;
const STATUSES = Object.freeze(['current', 'due', 'overdue', 'malformed', 'unregistered']);

function readText(root, path) {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch {
    return null;
  }
}

function isoOf(ms) {
  return new Date(ms).toISOString();
}

/** A malformed row has no reliable package cell, so its subject is its first cell as written. */
function malformedSubject(text) {
  const firstCell = (text.split('|').at(1) ?? '').trim().replace(/^`|`$/g, '');
  return firstCell === '' ? '?' : firstCell;
}

function holdObligations(record, nowMs) {
  const { rows, malformed } = readHeldMajors(record);
  const base = { kind: 'hold', owner: HELD_RECORD };
  const held = rows.map((row) => ({
    ...base,
    subject: row.pkg,
    failsFrom: isoOf(holdFailsFromMs(row.lastReviewed)),
    trigger: HOLD_TRIGGER,
    status: isOverdue(row.lastReviewed, nowMs, INTERVAL_DAYS) ? 'overdue' : 'current'
  }));
  const unreadableRows = malformed.map((row) => ({
    ...base,
    subject: malformedSubject(row.text),
    failsFrom: null,
    trigger: HOLD_TRIGGER,
    status: 'malformed',
    detail: `line ${String(row.line)}: ${row.reason}`
  }));
  return [...held, ...unreadableRows];
}

/** A registered record whose marker is absent or not a real day is malformed: its date cannot be read. */
function reviewObligation(record, body, nowMs) {
  const base = { kind: 'review', owner: record.document, subject: record.marker };
  const marker = readReviewMarker(body, record.marker);
  if (marker.state !== 'dated') return { ...base, failsFrom: null, trigger: record.defers, status: 'malformed' };
  return {
    ...base,
    failsFrom: isoOf(reviewDueFromMs(marker.date)),
    trigger: record.defers,
    status: reviewIsDue(marker.date, new Date(nowMs)) ? 'due' : 'current'
  };
}

function markdownUnder(dir) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
    }
  };
  walk(dir);
  return out.sort();
}

function unregisteredMarkers(root) {
  const registered = new Set(DATED_REVIEW_RECORDS.map((entry) => `${entry.document}::${entry.marker}`));
  const excluded = new Set(NOT_A_RECORD);
  const found = [];
  for (const absolute of markdownUnder(join(root, DOCS_DIR))) {
    const owner = relative(root, absolute).split(sep).join('/');
    const body = excluded.has(owner) ? null : readText(root, owner);
    if (body === null) continue;
    for (const subject of reviewDateMarkerNames(body)) {
      if (registered.has(`${owner}::${subject}`)) continue;
      found.push({ kind: 'marker', owner, subject, failsFrom: null, trigger: MARKER_TRIGGER, status: 'unregistered' });
    }
  }
  return found;
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** By `failsFrom` ascending, with no date last; ties by owner, then subject. */
function byFailsFrom(left, right) {
  if (left.failsFrom !== right.failsFrom) {
    if (left.failsFrom === null) return 1;
    if (right.failsFrom === null) return -1;
    return compareText(left.failsFrom, right.failsFrom);
  }
  return compareText(left.owner, right.owner) || compareText(left.subject, right.subject);
}

/**
 * Every dated obligation under `root`, judged at `nowMs`, and every record that could not be read.
 *
 * @param {{ root: string, nowMs: number }} options
 */
export function evaluate({ root, nowMs }) {
  const obligations = [];
  const unreadable = [];
  const heldRecord = readText(root, HELD_RECORD);
  // A record without its heading is unreadable, not a record with no holds (review C2).
  if (heldRecord === null || !readHeldMajors(heldRecord).found) unreadable.push(HELD_RECORD);
  else obligations.push(...holdObligations(heldRecord, nowMs));
  for (const record of DATED_REVIEW_RECORDS) {
    const body = readText(root, record.document);
    if (body === null) unreadable.push(record.document);
    else obligations.push(reviewObligation(record, body, nowMs));
  }
  obligations.push(...unregisteredMarkers(root));
  return { obligations: obligations.sort(byFailsFrom), unreadable };
}

/** The stdout lines: one per obligation, then the summary. */
export function formatReport(evaluation, nowMs) {
  const lines = evaluation.obligations.map((row) => {
    const subject = row.detail === undefined ? row.subject : `${row.subject} (${row.detail})`;
    return [row.status, row.failsFrom ?? '-', row.kind, row.owner, subject, `trigger: ${row.trigger}`].join('  ');
  });
  const counts = STATUSES.map(
    (status) => `${String(evaluation.obligations.filter((row) => row.status === status).length)} ${status}`
  );
  lines.push(
    `review-due: ${String(evaluation.obligations.length)} obligation(s) at ${isoOf(nowMs)}: ${counts.join(', ')}`
  );
  return lines;
}

/** 2 when a record could not be read, else 1 when anything needs attention, else 0. */
export function exitCodeOf(evaluation) {
  if (evaluation.unreadable.length > 0) return EXIT_UNREADABLE;
  return evaluation.obligations.every((row) => row.status === 'current') ? EXIT_CURRENT : EXIT_ATTENTION;
}

/** The instant an `--now` value names, or `null` when it is not an ISO-8601 UTC instant on a real day. */
function parseInstant(text) {
  const match = INSTANT_SHAPE.exec(text);
  if (match === null || !isCalendarDate(match[1])) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || isoOf(ms).slice(0, 10) !== match[1]) return null;
  return ms;
}

/**
 * The evaluation root and instant, or `null` on a usage error.
 *
 * @param {readonly string[]} argv
 * @param {number} defaultNowMs
 */
export function parseArgs(argv, defaultNowMs) {
  let root = REPO_ROOT;
  let nowMs = defaultNowMs;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) return null;
    if (flag === '--root') root = resolve(value);
    else if (flag === '--now') {
      const parsed = parseInstant(value);
      if (parsed === null) return null;
      nowMs = parsed;
    } else return null;
  }
  return { root, nowMs };
}

function main() {
  const options = parseArgs(process.argv.slice(2), Date.now());
  if (options === null) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT_UNREADABLE;
  }
  const evaluation = evaluate(options);
  for (const path of evaluation.unreadable) process.stderr.write(`unreadable  ${path}\n`);
  process.stdout.write(`${formatReport(evaluation, options.nowMs).join('\n')}\n`);
  return exitCodeOf(evaluation);
}

if (invokedAsScript(import.meta.url)) {
  process.exitCode = main();
}
