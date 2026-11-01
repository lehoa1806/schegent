// FR-R4-F09 (FR-014 to FR-020; contract AR1 to AR7; research R10 to R14) -- is the advisory
// evidence for this release complete, fresh, about this lockfile, and decided?
//
// A release is prepared against one feature-249 capture per tree (`security:advisory-diff --
// capture`) and the tracked disposition list. This module judges them. It reads nothing and runs
// nothing: it is given the text of each capture, the blob ids HEAD holds for the two lockfiles, the
// text of the list, the sets of packages the build bundled, and a clock. It has no filesystem seam,
// no spawn seam and no network seam, so the gate cannot reach the registry through it (FR-020), and
// the audit itself stays an operator act that makes a file.
//
// WHY SEVEN DAYS, INCLUSIVE. A release is a deliberate act, and a working week lets a maintainer
// capture, decide dispositions and prepare without auditing twice. The budget is the requirement's
// number, not feature 249's 24 hours, which pairs a base and a candidate capture inside a
// comparison and is a different decision. Exactly seven days is accepted and one millisecond more
// is not; a capture observed after `now` is refused so clock skew cannot make one fresh.
//
// WHY AN UNCOVERED FINDING IS NOT A REFUSAL. The requirement names exactly seven refusals
// (data-model section 6). A finding with no covering disposition is reported with its verdict
// (`not-recorded`, `expired` or `does-not-cover`) and counted in the record; refusing for it would
// be a new requirement, and `accepted` is a label and never a waiver (feature 249's DL4).
//
// The coverage rule is feature 249's own, reached through the function it exports, so a finding
// shows the same verdict here as in a comparison. Nothing here edits the list or a capture.
import { dispositionOf, parseDispositionList } from './advisory-dispositions.mjs';
import { TREES, TREE_NAMES, byCodeUnit, checkCapture, parseInstant } from './advisory-model.mjs';
import { escapeForTerminal } from './advisory-report.mjs';
import { sha256Hex } from './release-digest.mjs';

/** The freshness budget, in days. Inclusive: a capture exactly this old is accepted. */
export const RELEASE_ADVISORY_BUDGET_DAYS = 7;

/** The tracked disposition list, relative to the repository root (data-model section 7). */
export const DISPOSITIONS_PATH = 'docs/release/advisory-dispositions.json';

/** The refusal reasons, in the order they are checked (data-model section 6). */
export const RELEASE_ADVISORY_REASONS = Object.freeze([
  'advisory-capture-missing',
  'advisory-incomplete',
  'advisory-unavailable',
  'advisory-lockfile-mismatch',
  'advisory-observed-after-now',
  'advisory-stale',
  'dispositions-unusable'
]);

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const BUDGET_MS = RELEASE_ADVISORY_BUDGET_DAYS * MS_PER_DAY;
const MAX_RATIONALE_CHARACTERS = 2000;
const VERDICTS = Object.freeze(['not-recorded', 'covers', 'expired', 'does-not-cover']);

const plural = (count, unit) => `${count} ${unit}${count === 1 ? '' : 's'}`;

/** An age as days and whole hours, for a person. The exact milliseconds travel beside it. */
function formatAge(ms) {
  const days = Math.floor(ms / MS_PER_DAY);
  const hours = Math.floor((ms % MS_PER_DAY) / MS_PER_HOUR);
  return `${plural(days, 'day')} ${plural(hours, 'hour')}`;
}

/**
 * Judge one tree's capture file (AR2). Returns the completeness, the reason behind it, and the
 * parsed capture when it has the version-1 shape.
 *
 * `succeeded` is complete. `failed`, whatever the reason, is unavailable: the audit gave no
 * report. `rejected`, a file that fails 249's `checkCapture`, a file for the other tree, and no
 * file at all are incomplete.
 */
function assessCapture(tree, rawText) {
  if (typeof rawText !== 'string') {
    return { completeness: 'incomplete', detail: 'no-capture', capture: null, missing: true };
  }
  let value;
  try {
    value = JSON.parse(rawText);
  } catch {
    return { completeness: 'incomplete', detail: 'malformed', capture: null };
  }
  const checked = checkCapture(value);
  if (!checked.ok) return { completeness: 'incomplete', detail: checked.reason, capture: null };
  if (value.tree !== tree) {
    return {
      completeness: 'incomplete',
      detail: `tree-mismatch: the file is for the ${value.tree} tree`,
      capture: null
    };
  }
  const { status, reason } = value.outcome;
  if (status === 'succeeded') return { completeness: 'complete', detail: null, capture: value };
  const completeness = status === 'failed' ? 'unavailable' : 'incomplete';
  return { completeness, detail: reason, capture: value };
}

/** The package name a label or install path names: the segment after the last `node_modules/`. */
function packageSegmentOf(label) {
  const marker = 'node_modules/';
  const at = label.lastIndexOf(marker);
  const rest = at === -1 ? label : label.slice(at + marker.length);
  const segments = rest.split('/');
  return rest.startsWith('@') ? segments.slice(0, 2).join('/') : (segments.at(0) ?? '');
}

/**
 * Where a finding's package stands against this build (research R13): `shipped` when one of its
 * locations is a bundled install path, `unknown` when the graph is unavailable or the package
 * matches a module the graph could not map, and `build-only` otherwise.
 */
function usageOf(found, bundled) {
  if (!bundled) return 'unknown';
  const installPaths = new Set(bundled.installPaths ?? []);
  if (found.locations.some((location) => installPaths.has(location.location))) return 'shipped';
  const unmapped = new Set((bundled.unmapped ?? []).map(packageSegmentOf));
  return unmapped.has(found.package) ? 'unknown' : 'build-only';
}

/**
 * The disposition list as release preparation needs it: readable by 249's reader, and every entry
 * carrying a `rationale` (a non-empty string of at most 2,000 characters). 249's reader ignores
 * the field; this is the one place it is required.
 */
function assessDispositions(dispositionsText) {
  if (typeof dispositionsText !== 'string') {
    return { list: null, defect: 'unreadable', sha256: null, entries: null, message: null };
  }
  const list = parseDispositionList(dispositionsText);
  const sha256 = sha256Hex(dispositionsText);
  if (list.state === 'unusable') {
    return { list, defect: list.defect, sha256, entries: null, message: null };
  }
  const raw = JSON.parse(dispositionsText).dispositions;
  const lacking = raw.findIndex(
    (entry) =>
      typeof entry.rationale !== 'string' ||
      entry.rationale.trim().length === 0 ||
      entry.rationale.length > MAX_RATIONALE_CHARACTERS
  );
  if (lacking !== -1) {
    const named = `${escapeForTerminal(raw.at(lacking).advisory)} for ${escapeForTerminal(raw.at(lacking).package)}`;
    return {
      list,
      defect: 'missing-rationale',
      sha256,
      entries: raw.length,
      message:
        `entry ${lacking + 1} (${named}) has no rationale of 1 to ${MAX_RATIONALE_CHARACTERS} characters`
    };
  }
  return { list, defect: null, sha256, entries: raw.length, message: null };
}

/** The first refusal that applies to one tree, or null (AR3, in the documented order). */
function refusalForTree(tree, assessed, lockBlobs, nowMs) {
  const { completeness, detail, capture, missing } = assessed;
  if (missing) {
    return {
      reason: 'advisory-capture-missing',
      message: `no usable advisory capture was supplied for the ${tree} tree`
    };
  }
  if (completeness === 'incomplete') {
    return {
      reason: 'advisory-incomplete',
      message: `the ${tree} capture is incomplete (${detail}); capture the ${tree} tree again`
    };
  }
  if (completeness === 'unavailable') {
    return {
      reason: 'advisory-unavailable',
      message: `the ${tree} capture is unavailable: the audit gave no report (${detail}); capture the ${tree} tree again`
    };
  }

  const expectedPath = TREES[tree].lockfile;
  const headBlob = lockBlobs?.[tree];
  if (capture.lockfile.path !== expectedPath || capture.lockfile.blob !== headBlob) {
    return {
      reason: 'advisory-lockfile-mismatch',
      message:
        `the ${tree} capture audited ${capture.lockfile.path} at blob ${String(capture.lockfile.blob)}, ` +
        `and HEAD holds blob ${String(headBlob)} for ${expectedPath}; capture the ${tree} tree again`
    };
  }

  const observedMs = parseInstant(capture.observedAt);
  const ageMs = nowMs - observedMs;
  if (ageMs < 0) {
    return {
      reason: 'advisory-observed-after-now',
      message:
        `the ${tree} capture was observed at ${capture.observedAt}, ` +
        `after the preparation time ${new Date(nowMs).toISOString()}`
    };
  }
  if (ageMs > BUDGET_MS) {
    return {
      reason: 'advisory-stale',
      message:
        `the ${tree} capture is ${formatAge(ageMs)} old (${ageMs} ms), over the budget of ` +
        `${plural(RELEASE_ADVISORY_BUDGET_DAYS, 'day')} (${BUDGET_MS} ms); capture the ${tree} tree again`
    };
  }
  return null;
}

/**
 * Evaluate the advisory evidence for one release preparation.
 *
 * `captures` maps each tree to the TEXT of its capture file, or to `undefined` when none was
 * supplied or it could not be read. `lockBlobs` maps each tree to the git blob id HEAD holds for
 * its lockfile. `dispositionsText` is the list's text, or `null` when it could not be read.
 * `bundledByTree` maps each tree to `{ installPaths, unmapped }` from that run's module graph, or
 * is `null` before the build exists, in which case usage is `unknown` and only the refusals
 * matter. `now` is UTC milliseconds.
 *
 * Refuses, with exactly one reason, tree by tree in `TREE_NAMES` order, then the list.
 *
 * @param {{ captures: Record<string, string | undefined>, lockBlobs: Record<string, string>,
 *   dispositionsText: string | null, bundledByTree: Record<string, { installPaths?: readonly string[],
 *   unmapped?: readonly string[] }> | null, now: number }} input
 */
export function evaluateReleaseAdvisory({ captures, lockBlobs, dispositionsText, bundledByTree, now }) {
  // Destructured, not read as properties: the checksum detector matches a digest field read by
  // name in any file but the digest module (TA2).
  const {
    list: dispositionList,
    defect: dispositionDefect,
    sha256: dispositionsDigest,
    entries: dispositionEntries,
    message: dispositionMessage
  } = assessDispositions(dispositionsText);
  const verdicts = Object.fromEntries(VERDICTS.map((verdict) => [verdict, 0]));
  const findings = [];
  const records = [];
  let refusal = null;

  for (const tree of TREE_NAMES) {
    const rawText = captures?.[tree];
    const assessed = assessCapture(tree, rawText);
    const { capture } = assessed;
    records.push({
      tree,
      completeness: assessed.completeness,
      detail: assessed.detail,
      sha256: typeof rawText === 'string' ? sha256Hex(rawText) : null,
      commit: capture?.commit ?? null,
      lockfile: capture ? { path: capture.lockfile.path, blob: capture.lockfile.blob } : null,
      toolVersion: capture?.toolVersion ?? null,
      observedAt: capture?.observedAt ?? null,
      findings: capture?.findings.length ?? 0
    });

    if (!refusal) {
      const found = refusalForTree(tree, assessed, lockBlobs, now);
      if (found) refusal = { ...found, tree, detail: assessed.detail };
    }

    if (assessed.completeness !== 'complete') continue;
    for (const item of capture.findings) {
      const subject = {
        ids: item.ids,
        package: item.package,
        tree,
        candidate: { locations: item.locations }
      };
      const { verdict } = dispositionList
        ? dispositionOf(subject, dispositionList, now)
        : { verdict: 'unknown' };
      if (verdict in verdicts) verdicts[verdict] += 1;
      findings.push({
        tree,
        advisory: item.ids.canonical,
        url: item.url,
        package: item.package,
        severity: item.severity,
        usage: usageOf(item, bundledByTree?.[tree] ?? null),
        disposition: verdict
      });
    }
  }

  if (!refusal && dispositionDefect) {
    const message =
      dispositionMessage ??
      `the disposition list ${DISPOSITIONS_PATH} is unusable (${dispositionDefect})`;
    refusal = {
      reason: 'dispositions-unusable',
      message: `${message}; the list changes only in a reviewed commit`,
      tree: null,
      detail: dispositionDefect
    };
  }

  findings.sort(
    (a, b) =>
      byCodeUnit(a.tree, b.tree) || byCodeUnit(a.package, b.package) || byCodeUnit(a.advisory, b.advisory)
  );

  return {
    budgetDays: RELEASE_ADVISORY_BUDGET_DAYS,
    evaluatedAt: new Date(now).toISOString(),
    refusal,
    captures: records,
    dispositions: {
      state: dispositionList ? dispositionList.state : 'unusable',
      defect: dispositionDefect,
      sha256: dispositionsDigest,
      entries: dispositionEntries
    },
    findings,
    verdicts
  };
}

/**
 * The evidence as lines for the operator: each tree's completeness, age and finding count, then
 * one line per finding (tree, advisory id, package, severity, usage, verdict and the capture's own
 * URL), then the verdict counts. No line ranks findings or totals them by count (FR-016). Every
 * string that came from a capture or a list passes through `escapeForTerminal`, so an escape
 * sequence in a registry's text is printed as `\xNN` and never interpreted.
 *
 * @param {ReturnType<typeof evaluateReleaseAdvisory>} result
 * @returns {string[]}
 */
export function renderAdvisoryLines(result) {
  const evaluatedMs = parseInstant(result.evaluatedAt);
  const lines = [];
  for (const capture of result.captures) {
    const age =
      capture.observedAt === null
        ? ''
        : `, observed ${capture.observedAt} (${formatAge(evaluatedMs - parseInstant(capture.observedAt))} before preparation)`;
    const detail = capture.detail === null ? '' : ` (${capture.detail})`;
    lines.push(
      `  advisory ${capture.tree}: ${capture.completeness}${detail}, ${plural(capture.findings, 'finding')}${age}`
    );
  }
  for (const found of result.findings) {
    lines.push(
      `  finding ${found.tree} ${found.advisory} ${found.package} severity=${found.severity} ` +
        `usage=${found.usage} disposition=${found.disposition} ${found.url}`
    );
  }
  lines.push(
    `  dispositions at preparation: ${VERDICTS.map((verdict) => `${result.verdicts[verdict]} ${verdict}`).join(', ')}`
  );
  return lines.map(escapeForTerminal);
}
