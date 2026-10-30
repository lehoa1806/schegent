// Feature 249 (FR-R4-F21) — what a disposition list says about each finding of a comparison, read
// through the narrow version-1 contract this feature asks the dispositions owner (FR-R4-009) to
// adopt. The contract is `specs/249-dependency-advisory-baselines/contracts/dispositions.md` in the
// workspace.
//
// RENDER ONLY. A disposition is a decision someone else made and recorded. This module reads it and
// attaches a verdict and the related entries to each finding, and it never changes a class, a total,
// a reason or the completeness of the comparison, never writes a file, and never reads `accepted` as
// a waiver: in this contract it is a label. An entry that has expired, or that names the other tree
// or a range that leaves an installed version out, is never shown as covering.
//
// PURE. `parseDispositionList` takes the list's text and `applyDispositions` a comparison result
// and the evaluation time, so every rule is testable without a file. The CLI reads the named path
// within the 8 MiB bound and passes the text in.
import semver from 'semver';
import {
  BOUNDS,
  DISPOSITION_LIST_VERSION,
  DISPOSITION_STATUSES,
  ECOSYSTEM,
  SEMVER_OPTIONS,
  TREE_NAMES,
  byCodeUnit,
  identifierSet,
  parseInstant
} from './advisory-model.mjs';

/** The fields every entry carries, in the order a parsed entry holds them (DL2). */
const ENTRY_FIELDS = Object.freeze([
  'advisory',
  'ecosystem',
  'package',
  'tree',
  'range',
  'status',
  'owner',
  'decidedOn',
  'expiresOn'
]);

function unusable(defect) {
  return { state: 'unusable', defect };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A `YYYY-MM-DD` that is a real calendar date. */
function validDate(text) {
  return !Number.isNaN(parseInstant(`${text}T00:00:00Z`));
}

function validEntry(entry) {
  if (!isRecord(entry)) return false;
  if (!ENTRY_FIELDS.every((field) => typeof entry[field] === 'string' && entry[field] !== '')) return false;
  return (
    entry.ecosystem === ECOSYSTEM &&
    TREE_NAMES.includes(entry.tree) &&
    DISPOSITION_STATUSES.includes(entry.status) &&
    validDate(entry.decidedOn) &&
    validDate(entry.expiresOn) &&
    // A coverage claim that cannot be checked is not one, so an entry node-semver rejects makes the
    // whole list unusable.
    semver.validRange(entry.range, SEMVER_OPTIONS) !== null
  );
}

/**
 * Read a disposition list (DL2). Returns the entries, in their fields' order, or the defect that
 * makes the list unusable: over its size or entry bound, not JSON or of the wrong shape, or of
 * another version.
 *
 * @param {string} text
 * @returns {import('./advisory-dispositions.d.mts').DispositionList}
 */
export function parseDispositionList(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > BOUNDS.dispositionBytes) {
    return unusable('over-bound');
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return unusable('malformed');
  }
  if (!isRecord(value) || value.dispositionListVersion === undefined) return unusable('malformed');
  if (value.dispositionListVersion !== DISPOSITION_LIST_VERSION) return unusable('unsupported-format');
  if (!Array.isArray(value.dispositions)) return unusable('malformed');
  if (value.dispositions.length > BOUNDS.dispositionEntries) return unusable('over-bound');
  if (!value.dispositions.every(validEntry)) return unusable('malformed');
  const entries = value.dispositions.map((entry) =>
    Object.fromEntries(ENTRY_FIELDS.map((field) => [field, entry[field]]))
  );
  return { state: 'read', entries };
}

/** The versions installed on the side a finding is shown on: the candidate's when present, else the base's. */
function installedVersions(finding) {
  const side = finding.candidate ?? finding.base;
  return [...new Set((side?.locations ?? []).map((location) => location.version))].sort(byCodeUnit);
}

/** One related entry's own result: covers, expired, or does not cover with the mismatch named (DL3). */
function entryResult(entry, tree, versions, evaluatedMs) {
  const shown = {
    advisory: entry.advisory,
    status: entry.status,
    owner: entry.owner,
    decidedOn: entry.decidedOn,
    expiresOn: entry.expiresOn
  };
  if (entry.tree !== tree) {
    return { ...shown, result: 'does-not-cover', mismatch: { reason: 'other-tree' } };
  }
  const excluded = versions.filter((version) => !semver.satisfies(version, entry.range, SEMVER_OPTIONS));
  if (excluded.length > 0) {
    return { ...shown, result: 'does-not-cover', mismatch: { reason: 'range-excludes', versions: excluded } };
  }
  // An expiry date ends at 00:00:00Z that day.
  if (parseInstant(`${entry.expiresOn}T00:00:00Z`) <= evaluatedMs) return { ...shown, result: 'expired' };
  return { ...shown, result: 'covers' };
}

function byEntry(a, b) {
  return (
    byCodeUnit(a.advisory, b.advisory) ||
    byCodeUnit(a.decidedOn, b.decidedOn) ||
    byCodeUnit(a.owner, b.owner) ||
    byCodeUnit(a.expiresOn, b.expiresOn) ||
    byCodeUnit(a.status, b.status)
  );
}

/** The verdict and related entries of one classified finding, decided in the order of data-model §7. */
function dispositionOf(finding, list, evaluatedMs) {
  if (list.state === 'unusable') return { verdict: 'unknown', entries: [] };
  const names = new Set(identifierSet(finding.ids));
  const related = list.entries.filter(
    (entry) => names.has(entry.advisory) && entry.ecosystem === ECOSYSTEM && entry.package === finding.package
  );
  if (related.length === 0) return { verdict: 'not-recorded', entries: [] };
  const versions = installedVersions(finding);
  const entries = related.map((entry) => entryResult(entry, finding.tree, versions, evaluatedMs)).sort(byEntry);
  const results = new Set(entries.map((entry) => entry.result));
  let verdict = 'does-not-cover';
  if (results.has('covers')) verdict = 'covers';
  else if (results.has('expired')) verdict = 'expired';
  return { verdict, entries };
}

/**
 * A new comparison result whose findings carry a disposition: the verdict and every related entry
 * with its own result. Nothing else about the result changes. With no list the result is returned
 * as it is, every finding already `not-recorded`.
 *
 * @param {import('./advisory-compare.d.mts').ComparisonResult} result
 * @param {import('./advisory-dispositions.d.mts').DispositionList | { state: 'not-supplied' } | null} list
 * @param {string} evaluatedAt
 * @returns {import('./advisory-compare.d.mts').ComparisonResult}
 */
export function applyDispositions(result, list, evaluatedAt) {
  if (list === null || list === undefined || list.state === 'not-supplied') return result;
  const evaluatedMs = parseInstant(evaluatedAt);
  if (Number.isNaN(evaluatedMs)) throw new RangeError('evaluatedAt is not a UTC instant');
  return {
    ...result,
    trees: result.trees.map((tree) => ({
      ...tree,
      findings: tree.findings.map((finding) => ({
        ...finding,
        disposition: dispositionOf(finding, list, evaluatedMs)
      }))
    }))
  };
}
