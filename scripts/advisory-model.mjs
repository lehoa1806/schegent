// Feature 249 (FR-R4-F21) — the vocabulary the advisory comparison shares: the two trees, severities,
// classes, bounds, budgets, the closed code sets, advisory identity, and the shape check a capture
// must pass before the comparison reads it.
//
// The capture module writes captures and the compare module reads them, and neither imports the
// other. What they agree on lives here, once: a second copy of a bound or a code set is the split
// that lets a capture be written one way and rejected another. The contracts are
// `specs/249-dependency-advisory-baselines/contracts/capture.md` and `comparison.md` in the
// workspace.
//
// PURE. No file, no process, no clock and no environment is read, and nothing is hashed. A lockfile's
// identity is the git blob id that git already computes, so no module under `scripts/` produces a
// digest, which `current-control-facts.mjs` would otherwise read as a release-checksum producer.

const MIB = 1024 * 1024;
const MS_PER_MINUTE = 60 * 1000;

/**
 * The two npm trees `security:audit` audits, in the order every result lists them. The scope is
 * fixed: there is no flag that narrows it, because a narrowed comparison would read as complete.
 */
export const TREES = Object.freeze({
  root: Object.freeze({ manifest: 'package.json', lockfile: 'package-lock.json' }),
  'webview-ui': Object.freeze({
    manifest: 'webview-ui/package.json',
    lockfile: 'webview-ui/package-lock.json'
  })
});

/** The tree names, in `TREES` order. */
export const TREE_NAMES = Object.freeze(Object.keys(TREES));

/** The side of a comparison a capture belongs to. */
export const SIDES = Object.freeze(['base', 'candidate']);

/** The severities an advisory carries, in rising order. */
export const SEVERITIES = Object.freeze(['info', 'low', 'moderate', 'high', 'critical']);

/** The severity recorded when a report's value is missing or is not in `SEVERITIES`. */
export const UNKNOWN_SEVERITY = 'unknown';

/** `value` when it is a listed severity, otherwise `unknown`. */
export function normalizeSeverity(value) {
  return typeof value === 'string' && SEVERITIES.includes(value) ? value : UNKNOWN_SEVERITY;
}

/** The position of a known severity in `SEVERITIES`, or -1 for `unknown`. */
export function severityRank(severity) {
  return SEVERITIES.indexOf(severity);
}

/** The classes a finding can land in, in the order a report lists them. */
export const CLASSES = Object.freeze([
  'introduced',
  'worsened',
  'uncertain',
  'pre-existing',
  'resolved',
  'not-determined'
]);

export const CAPTURE_VERSION = 1;
export const RECORD_VERSION = 1;
export const DISPOSITION_LIST_VERSION = 1;
export const REPORT_FORMAT = 'npm-audit-report-2';
export const TOOL = 'npm';
export const ECOSYSTEM = 'npm';

/**
 * The arguments every capture runs `npm` with. `--offline=false` and the three `--include` flags
 * are what make an empty report mean no findings: with `offline` set npm writes a valid, empty
 * report without contacting the registry, and with `omit=dev` it skips the development tree.
 */
export const AUDIT_ARGV = Object.freeze([
  'audit',
  '--json',
  '--offline=false',
  '--include=dev',
  '--include=optional',
  '--include=peer'
]);

/** `AUDIT_ARGV` as the command string a capture records. */
export const AUDIT_COMMAND = `${TOOL} ${AUDIT_ARGV.join(' ')}`;

/** The limits an input is rejected over, and never truncated to. */
export const BOUNDS = Object.freeze({
  reportBytes: 8 * MIB,
  manifestBytes: 16 * MIB,
  lockfileBytes: 16 * MIB,
  findings: 10000,
  locationsPerFinding: 1000,
  captureBytes: 16 * MIB,
  dispositionBytes: 8 * MIB,
  dispositionEntries: 10000,
  auditTimeoutMs: 120 * 1000
});

/** The names a rejected capture or an incomplete result gives for the bound that was exceeded. */
export const BOUND_NAMES = Object.freeze([
  'report-bytes',
  'manifest-bytes',
  'lockfile-bytes',
  'findings',
  'locations-per-finding',
  'capture-bytes'
]);

/** The pairing and freshness budgets. Development defaults; the release budget is another feature's. */
export const BUDGETS = Object.freeze({ pairingMinutes: 60, freshnessHours: 24 });

/** `BUDGETS` in milliseconds. */
export const PAIRING_BUDGET_MS = BUDGETS.pairingMinutes * MS_PER_MINUTE;
export const FRESHNESS_BUDGET_MS = BUDGETS.freshnessHours * 60 * MS_PER_MINUTE;

/** npm's own options for judging whether a version is in a range (npm's metavuln calculator). */
export const SEMVER_OPTIONS = Object.freeze({ includePrerelease: true, loose: true });

export const CAPTURE_STATUSES = Object.freeze(['succeeded', 'failed', 'rejected']);

/** The reasons a capture is `failed`: the audit did not give a report. */
export const FAILED_REASONS = Object.freeze([
  'tool-unavailable',
  'audit-timeout',
  'no-report',
  'report-unparseable',
  'audit-error',
  'registry-unknown'
]);

/** The reasons a capture is `rejected`: the audit ran or was skipped, and its input cannot be used. */
export const REJECTED_REASONS = Object.freeze([
  'unsupported-format',
  'over-bound',
  'malformed',
  'tree-missing'
]);

/** The notes a finding can carry. */
export const FINDING_NOTES = Object.freeze([
  'range-not-evaluated',
  'attributed-by-package',
  'merged-duplicate'
]);

/** The reasons a classified finding carries, by the rows of the classification table. */
export const CLASS_REASON_CODES = Object.freeze([
  'disclosed-between-captures',
  'still-installed-on-candidate',
  'severity-revised',
  'severity-not-comparable',
  'new-on-candidate',
  'partly-in-base-lockfile',
  'severity-raised',
  'new-pair',
  'newly-direct',
  'newly-production',
  'severity-lowered',
  'fewer-pairs',
  'no-longer-direct',
  'no-longer-production',
  'absent-on-candidate'
]);

/** The thirteen reasons a tree, and so the result, is incomplete. */
export const COMPLETENESS_REASONS = Object.freeze([
  'base-not-selected',
  'missing-baseline',
  'missing-candidate',
  'tree-missing',
  'mismatch',
  'missing-provenance',
  'malformed',
  'unsupported-format',
  'over-bound',
  'audit-failure',
  'not-comparable',
  'observation-skew',
  'stale'
]);

/** The statuses a disposition entry can hold. They are rendered as labels, never interpreted. */
export const DISPOSITION_STATUSES = Object.freeze(['actionable', 'accepted', 'inapplicable']);

/** The verdicts a finding's disposition can have, in the order they are decided. */
export const DISPOSITION_VERDICTS = Object.freeze([
  'unknown',
  'not-recorded',
  'covers',
  'expired',
  'does-not-cover'
]);

const GHSA_ID = /^GHSA(?:-[0-9a-z]{4}){3}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** True for a full git object id, SHA-1 or SHA-256. */
export function isObjectId(value) {
  return typeof value === 'string' && OBJECT_ID.test(value);
}

/**
 * The instant `text` names, in milliseconds, or `NaN` when it is not `YYYY-MM-DDTHH:MM:SS(.sss)?Z`
 * or is not a real calendar instant. `Date.parse` alone accepts forms this must not, and rolls an
 * impossible day such as the 30th of February forward without complaint.
 */
export function parseInstant(text) {
  if (typeof text !== 'string' || !UTC_INSTANT.test(text)) return Number.NaN;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return Number.NaN;
  const withFraction = text.includes('.') ? text : `${text.slice(0, -1)}.000Z`;
  return new Date(ms).toISOString() === withFraction ? ms : Number.NaN;
}

/** The one comparator every sort uses: UTF-16 code units, never the locale. */
export function byCodeUnit(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * The GHSA id in the last path segment of an advisory's `url`, or `null`.
 *
 * @param {unknown} url
 */
function ghsaFromUrl(url) {
  if (typeof url !== 'string') return null;
  let segments;
  try {
    segments = new URL(url).pathname.split('/').filter((segment) => segment.length > 0);
  } catch {
    return null;
  }
  const last = segments[segments.length - 1];
  return last !== undefined && GHSA_ID.test(last) ? last : null;
}

/**
 * The identity of one advisory object from an npm audit report: a canonical id and its aliases, or
 * `null` when the object carries neither. The canonical id is the GHSA id when the `url` has one,
 * otherwise `npm:<source>`. Version-2 reports carry no other identifier, so the numeric `source`
 * is the alias when a GHSA id is canonical.
 *
 * @param {{ source?: unknown, url?: unknown } | null | undefined} advisory
 * @returns {{ canonical: string, aliases: string[] } | null}
 */
export function advisoryIds(advisory) {
  const source = advisory?.source;
  const hasSource = typeof source === 'number' && Number.isSafeInteger(source) && source >= 0;
  const npmId = hasSource ? `npm:${String(source)}` : null;
  const ghsa = ghsaFromUrl(advisory?.url);
  if (ghsa !== null) return { canonical: ghsa, aliases: npmId === null ? [] : [npmId] };
  if (npmId !== null) return { canonical: npmId, aliases: [] };
  return null;
}

/** Every identifier an `ids` object holds, canonical first. */
export function identifierSet(ids) {
  return [ids.canonical, ...ids.aliases];
}

/** True when two identifier sets share an identifier. */
export function idsIntersect(a, b) {
  const left = new Set(identifierSet(a));
  return identifierSet(b).some((id) => left.has(id));
}

/**
 * One `ids` object for several that name the same advisory: every identifier any of them holds,
 * with the smallest GHSA id as canonical when there is one, otherwise the smallest identifier, and
 * the rest as sorted aliases.
 */
export function mergeIds(idsList) {
  const all = new Set(idsList.flatMap((ids) => identifierSet(ids)));
  const sorted = [...all].sort(byCodeUnit);
  const canonical = sorted.find((id) => id.startsWith('GHSA-')) ?? sorted[0];
  return { canonical, aliases: sorted.filter((id) => id !== canonical) };
}

/** The highest known severity of several, or `unknown` when none is known. */
export function highestSeverity(severities) {
  return severities.reduce(
    (highest, next) => (severityRank(next) > severityRank(highest) ? next : highest),
    UNKNOWN_SEVERITY
  );
}

/**
 * The order a classified finding takes in a record and a report: class, then tree, package and
 * canonical id, each by code unit.
 */
export function compareFindings(a, b) {
  return (
    CLASSES.indexOf(a.class) - CLASSES.indexOf(b.class) ||
    TREE_NAMES.indexOf(a.tree) - TREE_NAMES.indexOf(b.tree) ||
    byCodeUnit(a.package, b.package) ||
    byCodeUnit(a.ids.canonical, b.ids.canonical)
  );
}

const PROVENANCE_FIELDS = Object.freeze([
  'tool',
  'toolVersion',
  'command',
  'registryHost',
  'observedAt',
  'reportFormat',
  'limitations'
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isMissing(value) {
  if (value === undefined || value === null || value === '') return true;
  return Array.isArray(value) && value.length === 0;
}

function validLocation(location) {
  return (
    isRecord(location) &&
    isNonEmptyString(location.location) &&
    isNonEmptyString(location.version) &&
    typeof location.direct === 'boolean' &&
    typeof location.production === 'boolean'
  );
}

function validFinding(finding) {
  if (!isRecord(finding)) return false;
  const { ids } = finding;
  return (
    isNonEmptyString(finding.package) &&
    isRecord(ids) &&
    isNonEmptyString(ids.canonical) &&
    isStringArray(ids.aliases) &&
    (finding.severity === UNKNOWN_SEVERITY || SEVERITIES.includes(finding.severity)) &&
    typeof finding.range === 'string' &&
    typeof finding.title === 'string' &&
    typeof finding.url === 'string' &&
    Array.isArray(finding.locations) &&
    finding.locations.every(validLocation) &&
    typeof finding.direct === 'boolean' &&
    typeof finding.production === 'boolean' &&
    isStringArray(finding.dependents) &&
    Array.isArray(finding.notes) &&
    finding.notes.every((note) => FINDING_NOTES.includes(note))
  );
}

function validOutcome(outcome) {
  if (!isRecord(outcome) || !CAPTURE_STATUSES.includes(outcome.status)) return false;
  if (outcome.status === 'succeeded') return outcome.reason === undefined;
  if (outcome.status === 'failed') {
    return (
      FAILED_REASONS.includes(outcome.reason) &&
      (outcome.statusCode === undefined || Number.isInteger(outcome.statusCode))
    );
  }
  if (!REJECTED_REASONS.includes(outcome.reason)) return false;
  return outcome.reason !== 'over-bound' || BOUND_NAMES.includes(outcome.bound);
}

/** A file entry: a repository-relative path and its blob id, which is `null` only when it is absent. */
function validFile(file, mayBeAbsent) {
  if (!isRecord(file) || !isNonEmptyString(file.path)) return false;
  return file.blob === null ? mayBeAbsent : isObjectId(file.blob);
}

function shapeIsValid(capture) {
  const { outcome } = capture;
  const treeMissing = isRecord(outcome) && outcome.status === 'rejected' && outcome.reason === 'tree-missing';
  return (
    typeof capture.tree === 'string' &&
    Object.hasOwn(TREES, capture.tree) &&
    capture.ecosystem === ECOSYSTEM &&
    isObjectId(capture.commit) &&
    (capture.objectFormat === 'sha1' || capture.objectFormat === 'sha256') &&
    validFile(capture.manifest, treeMissing) &&
    validFile(capture.lockfile, treeMissing) &&
    typeof capture.tool === 'string' &&
    typeof capture.toolVersion === 'string' &&
    typeof capture.command === 'string' &&
    typeof capture.registryHost === 'string' &&
    !Number.isNaN(parseInstant(capture.observedAt)) &&
    typeof capture.reportFormat === 'string' &&
    isStringArray(capture.limitations) &&
    validOutcome(outcome) &&
    Array.isArray(capture.findings) &&
    (outcome.status === 'succeeded' || capture.findings.length === 0) &&
    capture.findings.every(validFinding)
  );
}

/**
 * Whether a parsed capture file has the shape version 1 defines. The checks run in a fixed
 * precedence, so a defect is always named the same way: an unknown `captureVersion` is
 * `unsupported-format`, then a missing or empty provenance field is `missing-provenance`, and any
 * other defect is `malformed`.
 *
 * @param {unknown} value
 * @returns {{ ok: true } | { ok: false, reason: 'malformed' | 'unsupported-format' | 'missing-provenance' }}
 */
export function checkCapture(value) {
  if (!isRecord(value) || value.captureVersion === undefined) return { ok: false, reason: 'malformed' };
  if (value.captureVersion !== CAPTURE_VERSION) return { ok: false, reason: 'unsupported-format' };
  if (PROVENANCE_FIELDS.some((field) => isMissing(value[field]))) {
    return { ok: false, reason: 'missing-provenance' };
  }
  return shapeIsValid(value) ? { ok: true } : { ok: false, reason: 'malformed' };
}
