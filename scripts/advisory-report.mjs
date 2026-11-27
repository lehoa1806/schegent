// Feature 249 (FR-R4-F21) — the record a comparison writes and the report it prints.
//
// ONE RESULT, TWO RENDERINGS. `buildRecord` turns a comparison result into the versioned record the
// operator keeps, `renderReport` turns that record into the text the operator reads, and neither
// does a second classification: whatever the record says, the report says. The contract is
// `specs/249-dependency-advisory-baselines/contracts/comparison.md` (K5 to K7) in the workspace.
//
// DETERMINISTIC. Objects are built in a fixed key order, arrays are sorted by code unit and never by
// locale, and the record holds no clock reading but the inputs' observation times and the
// evaluation time. The same inputs give a byte-identical record and report.
//
// SAFE TO PRINT. Advisory titles and package names come from the registry, and a raw escape
// sequence in one could rewrite the operator's terminal. Every string the report takes from an
// input is escaped first: C0 controls, DEL and C1 controls become `\xNN`. The record is JSON and is
// escaped by `JSON.stringify`.
//
// NO MACHINE PATHS. The record is built from the result and the meta it is given, and a capture's
// own fields are already an allowlist, so no absolute path, temp directory, home directory or
// environment value can reach it.
import { BUDGETS, CLASSES, RECORD_VERSION, compareFindings } from './advisory-model.mjs';

/** The first screen's third line, and the statement the record's first sentence repeats (FR-019). */
const REPORT_ONLY_LINE =
  'Report-only. The absolute audit (npm run security:audit) is unaffected; this is not a waiver or permission to integrate.';

const STATEMENTS = Object.freeze([
  'Report-only: this comparison changes no audit, threshold, lockfile, disposition or gate result.',
  'The absolute audit (npm run security:audit) is unaffected; a failing absolute audit still fails.',
  'This comparison is neither a waiver nor permission to integrate a candidate whose checks are red.'
]);

const LIMITATIONS = Object.freeze([
  'A lockfile digest is a git blob id: it identifies content and does not authenticate a capture.',
  'A comparison does not establish present exploitability or current registry advisory counts.'
]);

const CLASS_LABELS = Object.freeze({
  introduced: 'Introduced',
  worsened: 'Worsened',
  uncertain: 'Uncertain',
  'pre-existing': 'Pre-existing',
  resolved: 'Resolved',
  'not-determined': 'Not determined'
});

/** One sentence per completeness reason, so a reader need not look the code up. */
const REASON_SENTENCES = Object.freeze({
  'base-not-selected': 'No base commit was selected, so no capture can be compared against a base.',
  'missing-baseline': 'No base capture was supplied for this tree.',
  'missing-candidate': 'No candidate capture was supplied for this tree.',
  'tree-missing': 'The manifest or lockfile is absent at this commit.',
  mismatch: 'The capture does not describe this commit, tree or lockfile.',
  'missing-provenance': 'The capture does not record where its advisory data came from.',
  malformed: 'The capture file could not be read as a capture.',
  'unsupported-format': 'The capture or the audit report is in a format this comparison does not read.',
  'over-bound': 'An input is over its size bound and was not read.',
  'audit-failure': 'The audit did not produce a report.',
  'not-comparable': 'The two captures were taken with different tools or registries.',
  'observation-skew': 'The two captures were observed too far apart in time.',
  stale: 'The capture is outside the freshness budget.'
});

const NOT_DETERMINED = 'not determined';
const SHORT_COMMIT_LENGTH = 7;
const BLOB_SHORT_LENGTH = 7;
const INDENT = '  ';

/**
 * Replace every C0 control, DEL and C1 control with `\xNN`, so no string taken from an input can
 * move the cursor, change the title or recolour the terminal. Printable text, non-ASCII included,
 * is unchanged.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function escapeForTerminal(text) {
  let out = '';
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    out += isControl ? `\\x${code.toString(16).padStart(2, '0')}` : char;
  }
  return out;
}

const esc = escapeForTerminal;

function reasonRecord(reason) {
  const out = {};
  if (reason.tree !== undefined) out.tree = reason.tree;
  out.code = reason.code;
  if (reason.side !== undefined) out.side = reason.side;
  if (reason.detail !== undefined) out.detail = reason.detail;
  return out;
}

function treeRecord(tree) {
  return {
    tree: tree.tree,
    complete: tree.complete,
    reasons: tree.reasons.map(reasonRecord),
    base: tree.base,
    candidate: tree.candidate,
    totals: tree.totals,
    findings: [...tree.findings].sort(compareFindings)
  };
}

/**
 * The comparison record, version 1, in the contract's key order (K5).
 *
 * @param {import('./advisory-compare.d.mts').ComparisonResult} result
 * @param {import('./advisory-report.d.mts').RecordMeta} meta
 * @returns {import('./advisory-report.d.mts').ComparisonRecord}
 */
export function buildRecord(result, meta) {
  return {
    recordVersion: RECORD_VERSION,
    mode: 'report-only',
    candidate: { commit: meta.candidate.commit },
    base: { commit: meta.base.commit, rule: meta.base.rule, target: meta.base.target },
    evaluatedAt: meta.evaluatedAt,
    budgets: { pairingMinutes: BUDGETS.pairingMinutes, freshnessHours: BUDGETS.freshnessHours },
    complete: result.complete,
    reasons: result.reasons.map(reasonRecord),
    totals: result.totals,
    trees: result.trees.map(treeRecord),
    dispositions: meta.dispositions ?? { state: 'not-supplied' },
    statements: [...STATEMENTS],
    limitations: [...LIMITATIONS]
  };
}

/** The record as the file the operator keeps: two-space JSON and a trailing newline (K6). */
export function serializeRecord(record) {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function shortOf(commit) {
  return esc(String(commit).slice(0, SHORT_COMMIT_LENGTH));
}

function countText(count, unit) {
  return `${String(count)} ${unit}${count === 1 ? '' : 's'}`;
}

function firstLines(record) {
  const verdict = record.complete
    ? 'COMPLETE'
    : `INCOMPLETE (${countText(record.reasons.length, 'reason')})`;
  const counts = record.complete
    ? `Introduced: ${String(record.totals?.['introduced'] ?? 0)}   Worsened: ${String(record.totals?.['worsened'] ?? 0)}`
    : `Introduced: ${NOT_DETERMINED}   Worsened: ${NOT_DETERMINED}`;
  const { commit, rule, target } = record.base;
  let base;
  if (commit === null) base = 'none (base not selected)';
  else if (rule === 'explicit') base = `${shortOf(commit)} (explicit base)`;
  else base = `${shortOf(commit)} (merge-base with ${esc(target ?? '')})`;
  return [
    `Advisory comparison: ${verdict}`,
    counts,
    REPORT_ONLY_LINE,
    `Candidate ${shortOf(record.candidate.commit)} vs base ${base}, evaluated ${esc(record.evaluatedAt)}`
  ];
}

function reasonLines(record) {
  if (record.complete) return [];
  const lines = ['Reasons:'];
  for (const reason of record.reasons) {
    const where = reason.tree === null || reason.tree === undefined ? 'all trees' : esc(reason.tree);
    const side = reason.side === undefined ? '' : `, ${esc(reason.side)}`;
    const detail = reason.detail === undefined ? '' : ` (${esc(reason.detail)})`;
    const sentence = REASON_SENTENCES[reason.code] ?? 'See the record.';
    lines.push(`${INDENT}- ${where}${side}: ${esc(reason.code)}${detail}. ${sentence}`);
  }
  return lines;
}

function provenanceText(provenance) {
  if (provenance === null) return 'none (no capture was read)';
  const lockfile = provenance.lockfile.blob === null ? 'absent' : esc(provenance.lockfile.blob.slice(0, BLOB_SHORT_LENGTH));
  const { outcome } = provenance;
  const result = outcome.reason === undefined ? outcome.status : `${outcome.status} (${outcome.reason})`;
  return [
    `commit ${shortOf(provenance.commit)}`,
    `lockfile ${lockfile}`,
    `${esc(provenance.tool)} ${esc(provenance.toolVersion)}`,
    `registry ${esc(provenance.registryHost)}`,
    `observed ${esc(provenance.observedAt)}`,
    `outcome ${esc(result)}`
  ].join(', ');
}

function provenanceLines(record) {
  const lines = ['Provenance:'];
  for (const tree of record.trees) {
    for (const side of ['base', 'candidate']) {
      lines.push(`${INDENT}${esc(tree.tree)} ${side}: ${provenanceText(tree[side])}`);
    }
  }
  return lines;
}

function pairText(pair) {
  return `${esc(pair.location)}@${esc(pair.version)}`;
}

function reasonText(reason) {
  const pairs = reason.pairs === undefined ? '' : ` (${reason.pairs.map(pairText).join(', ')})`;
  return `${esc(reason.code)}${pairs}`;
}

function sideSeverity(severity) {
  return severity === null ? 'none' : esc(severity);
}

/** How one related entry's own result reads: covers, expired, or does-not-cover with the mismatch. */
function entryResultText(entry) {
  const { mismatch } = entry;
  if (mismatch === undefined) return esc(entry.result);
  if (mismatch.reason === 'range-excludes') {
    return `${esc(entry.result)} (range-excludes ${mismatch.versions.map(esc).join(', ')})`;
  }
  return `${esc(entry.result)} (${esc(mismatch.reason)})`;
}

function entryLine(entry) {
  return (
    `entry: ${esc(entry.status)}, owner ${esc(entry.owner)}, decided ${esc(entry.decidedOn)}, ` +
    `expires ${esc(entry.expiresOn)} - ${entryResultText(entry)}`
  );
}

function findingLines(finding) {
  const aliases = finding.ids.aliases.length === 0 ? '' : ` (aliases: ${finding.ids.aliases.map(esc).join(', ')})`;
  const lines = [`${INDENT}[${esc(finding.tree)}] ${esc(finding.package)} ${esc(finding.ids.canonical)}${aliases}`];
  const inner = `${INDENT}${INDENT}`;
  lines.push(
    `${inner}severity: base ${sideSeverity(finding.severity.base)}, candidate ${sideSeverity(finding.severity.candidate)}; ` +
      `locations: base ${String(finding.base?.locations.length ?? 0)}, candidate ${String(finding.candidate?.locations.length ?? 0)}`
  );
  if (finding.sides !== undefined) lines.push(`${inner}sides: ${finding.sides.map(esc).join(', ')}`);
  for (const reason of finding.reasons) lines.push(`${inner}reason: ${reasonText(reason)}`);
  for (const note of finding.notes) lines.push(`${inner}note: ${esc(note)}`);
  lines.push(`${inner}title: ${esc(finding.title)}`);
  if (finding.dependents.length > 0) {
    lines.push(`${inner}dependents: ${finding.dependents.map(esc).join(', ')}`);
  }
  lines.push(`${inner}disposition: ${esc(finding.disposition.verdict)}`);
  for (const entry of finding.disposition.entries) lines.push(`${inner}${INDENT}${entryLine(entry)}`);
  return lines;
}

/** The count a class section is headed with: one number when the result is complete, else per tree. */
function sectionHeading(record, name) {
  const label = CLASS_LABELS[name];
  const listed = (tree) => tree.findings.filter((finding) => finding.class === name).length;
  if (record.complete) {
    const total = record.trees.reduce((sum, tree) => sum + listed(tree), 0);
    return `${label} (${String(total)})`;
  }
  const perTree = record.trees.map((tree) => {
    const count = tree.complete || name === 'not-determined' ? String(listed(tree)) : NOT_DETERMINED;
    return `${esc(tree.tree)}: ${count}`;
  });
  return `${label} (${perTree.join(', ')})`;
}

function sectionLines(record) {
  const all = record.trees.flatMap((tree) => tree.findings).sort(compareFindings);
  const lines = [];
  for (const name of CLASSES) {
    lines.push(sectionHeading(record, name));
    for (const finding of all.filter((item) => item.class === name)) lines.push(...findingLines(finding));
  }
  return lines;
}

/** The state of the disposition list, when one was named (K7 item 4). */
function dispositionListLines(record) {
  const { state, defect } = record.dispositions;
  if (state === 'not-supplied') return [];
  return [`Disposition list: ${state}${defect === undefined ? '' : ` (${esc(defect)})`}`];
}

/**
 * The human report: the first four lines, then the reasons, the provenance of each capture, every
 * class section in order with every finding listed, and the limitations (K7).
 *
 * @param {import('./advisory-report.d.mts').ComparisonRecord} record
 * @returns {string}
 */
export function renderReport(record) {
  const blocks = [
    firstLines(record),
    reasonLines(record),
    provenanceLines(record),
    sectionLines(record),
    dispositionListLines(record),
    ['Limitations:', ...record.limitations.map((sentence) => `${INDENT}- ${esc(sentence)}`)]
  ].filter((block) => block.length > 0);
  return `${blocks.map((block) => block.join('\n')).join('\n\n')}\n`;
}
