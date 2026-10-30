// Feature 249 (FR-R4-F21) — one audit observation of one npm tree at one commit, written as a
// capture the comparison can read later and offline.
//
// WHAT IT AUDITS. The commit, never the working tree: the tree's manifest and lockfile are read
// from git as `<commit>:<path>`, written into a fresh temporary directory, and `npm audit --json`
// runs there. npm loads the virtual tree from the lockfile, so no `node_modules` is read or
// written, and nothing inside the repository is opened for writing. The contract is
// `specs/249-dependency-advisory-baselines/contracts/capture.md` in the workspace.
//
// THE OUTCOME COMES FROM THE REPORT, NEVER FROM THE EXIT STATUS. npm exits 1 when it finds
// advisories, so a non-zero exit with a valid report is a good capture. And the argv is the one that
// defeats npm's two false-clean paths: with `offline` set npm writes a valid, empty report without
// contacting the registry, and with `omit=dev` it skips the development tree (`AUDIT_ARGV` in the
// model).
//
// PURE OVER NINE SEAMS (git, npm, the temp directory and the clock), so every case is testable
// without git, npm or the network (`tests/unit/scripts/advisory-capture-outcome.test.ts`). The CLI
// binds the seams (`advisory-diff.mjs`), and importing this module runs nothing.
//
// WHAT IT NEVER RECORDS. npm's stderr, and the `uri`, `headers` and `body` of an npm error, the
// registry's user information, port and path, an environment value, or an absolute path. The
// capture is built from an allowlist, in the contract's key order.
import semver from 'semver';
import {
  AUDIT_ARGV,
  AUDIT_COMMAND,
  BOUNDS,
  CAPTURE_VERSION,
  ECOSYSTEM,
  REPORT_FORMAT,
  SEMVER_OPTIONS,
  TOOL,
  TREES,
  advisoryIds,
  byCodeUnit,
  highestSeverity,
  idsIntersect,
  isObjectId,
  mergeIds,
  normalizeSeverity,
  severityRank
} from './advisory-model.mjs';

/** The two sentences every capture carries, so a reader of one file alone is told what it is not. */
export const CAPTURE_LIMITATIONS = Object.freeze([
  "Advisory data is the registry's at observedAt; it is not a statement of present exploitability.",
  "npm may have written to its own cache in the user's home; nothing in the repository was written."
]);

/** The value recorded for a provenance field that could not be read, so the capture stays whole. */
const UNKNOWN = 'unknown';

const SUPPORTED_LOCKFILE_VERSIONS = Object.freeze([2, 3]);
const DEPENDENCY_FIELDS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies'
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function rejection(reason, bound) {
  return bound === undefined ? { ok: false, reason } : { ok: false, reason, bound };
}

/** The package names the root entry declares, in any of the four dependency maps (R7). */
function declaredNames(rootManifest) {
  const names = new Set();
  if (!isRecord(rootManifest)) return names;
  for (const field of DEPENDENCY_FIELDS) {
    const declared = rootManifest[field];
    if (isRecord(declared)) for (const name of Object.keys(declared)) names.add(name);
  }
  return names;
}

/** The location, version and usage of every node a vulnerability entry names, or `null` when one is unusable. */
function readNodes(name, nodes, packages, declared) {
  const out = [];
  for (const location of nodes) {
    const entry = packages[location];
    if (!isRecord(entry) || typeof entry.version !== 'string' || entry.version === '') return null;
    out.push({
      location,
      version: entry.version,
      direct: location === `node_modules/${name}` && declared.has(name),
      production: entry.dev !== true && entry.devOptional !== true
    });
  }
  return out;
}

/**
 * The nodes an advisory range affects, judged by node-semver with npm's own options. A range or
 * version it cannot evaluate keeps the node and notes it; a range matching none of the nodes keeps
 * them all, because npm listed them as vulnerable and dropping them would hide a finding.
 */
function attribute(range, nodes) {
  const rangeUsable = range !== '' && semver.validRange(range, SEMVER_OPTIONS) !== null;
  const notes = [];
  const matched = nodes.filter((node) => {
    if (!rangeUsable || semver.valid(node.version, SEMVER_OPTIONS) === null) {
      if (!notes.includes('range-not-evaluated')) notes.push('range-not-evaluated');
      return true;
    }
    return semver.satisfies(node.version, range, SEMVER_OPTIONS);
  });
  if (matched.length > 0) return { locations: matched, notes };
  return { locations: nodes, notes: ['attributed-by-package'] };
}

function byLocation(a, b) {
  return byCodeUnit(a.location, b.location) || byCodeUnit(a.version, b.version);
}

/** The transitive closure of `effects` from a package: every package listed because it depends on it. */
function dependentsOf(name, effectsByName) {
  const seen = new Set();
  const pending = [...(effectsByName.get(name) ?? [])];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined || next === name || seen.has(next)) continue;
    seen.add(next);
    pending.push(...(effectsByName.get(next) ?? []));
  }
  return [...seen].sort(byCodeUnit);
}

/** One finding from one advisory object. Its locations are the package's nodes the range affects. */
function findingFrom(name, advisory, ids, attributed, dependents) {
  const locations = [...attributed.locations].sort(byLocation);
  return {
    package: name,
    ids,
    severity: normalizeSeverity(advisory.severity),
    range: typeof advisory.range === 'string' ? advisory.range : '',
    title: typeof advisory.title === 'string' ? advisory.title : '',
    url: typeof advisory.url === 'string' ? advisory.url : '',
    locations,
    direct: locations.some((location) => location.direct),
    production: locations.some((location) => location.production),
    dependents,
    notes: [...attributed.notes].sort(byCodeUnit)
  };
}

/** One finding from several whose identifier sets intersect: union of locations, highest known severity. */
function mergeFindings(findings) {
  const ranked = [...findings].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      byCodeUnit(a.ids.canonical, b.ids.canonical)
  );
  const primary = ranked[0];
  const seen = new Set();
  const locations = [];
  for (const finding of findings) {
    for (const location of finding.locations) {
      const key = `${location.location}\u0000${location.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      locations.push(location);
    }
  }
  locations.sort(byLocation);
  const notes = new Set(['merged-duplicate']);
  for (const finding of findings) for (const note of finding.notes) notes.add(note);
  return {
    package: primary.package,
    ids: mergeIds(findings.map((finding) => finding.ids)),
    severity: highestSeverity(findings.map((finding) => finding.severity)),
    range: primary.range,
    title: primary.title,
    url: primary.url,
    locations,
    direct: locations.some((location) => location.direct),
    production: locations.some((location) => location.production),
    dependents: primary.dependents,
    notes: [...notes].sort(byCodeUnit)
  };
}

/** Group one package's findings whose identifier sets intersect, transitively, and merge each group. */
function mergeIntersecting(findings) {
  const groups = [];
  for (const finding of findings) {
    const touching = groups.filter((group) => group.some((member) => idsIntersect(member.ids, finding.ids)));
    const merged = [finding, ...touching.flat()];
    for (const group of touching) groups.splice(groups.indexOf(group), 1);
    groups.push(merged);
  }
  return groups.map((group) => (group.length === 1 ? group[0] : mergeFindings(group)));
}

/**
 * Turn an npm audit report (version 2) and the lockfile it was taken over into findings.
 *
 * An advisory object in a `via` is one finding, held at the package's nodes its range affects. A
 * string in a `via` creates none: it names a vulnerable dependency, and its package is only a
 * dependent. Anything that cannot be read with certainty rejects the whole report and truncates
 * nothing: a partial capture would read as a clean one.
 *
 * `rootManifest` is the object whose dependency maps name what the tree declares directly; capture
 * passes the lockfile's own root entry, the lockfile being where the usage is recorded.
 *
 * @param {unknown} report
 * @param {unknown} lockfile
 * @param {unknown} rootManifest
 * @returns {import('./advisory-capture.d.mts').NormalizeResult}
 */
export function normalizeReport(report, lockfile, rootManifest) {
  if (!isRecord(report)) return rejection('malformed');
  if (report['auditReportVersion'] !== 2) return rejection('unsupported-format');
  if (!isRecord(lockfile)) return rejection('malformed');
  if (!SUPPORTED_LOCKFILE_VERSIONS.includes(lockfile['lockfileVersion'])) {
    return rejection('unsupported-format');
  }
  const { packages } = lockfile;
  const { vulnerabilities } = report;
  if (!isRecord(packages) || !isRecord(vulnerabilities)) return rejection('malformed');

  const declared = declaredNames(rootManifest);
  const effectsByName = new Map();
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    if (!isRecord(entry)) return rejection('malformed');
    const effects = entry['effects'] ?? [];
    if (!isStringArray(effects)) return rejection('malformed');
    effectsByName.set(name, effects);
  }

  const found = [];
  for (const name of Object.keys(vulnerabilities).sort(byCodeUnit)) {
    const entry = vulnerabilities[name];
    const { via, nodes } = entry;
    if (!Array.isArray(via) || !isStringArray(nodes)) return rejection('malformed');
    const advisories = via.filter((item) => typeof item !== 'string');
    if (!advisories.every(isRecord)) return rejection('malformed');
    if (advisories.length === 0) continue;
    const located = readNodes(name, nodes, packages, declared);
    if (located === null) return rejection('malformed');
    const dependents = dependentsOf(name, effectsByName);
    const own = [];
    for (const advisory of advisories) {
      const ids = advisoryIds(advisory);
      if (ids === null) return rejection('malformed');
      const range = typeof advisory.range === 'string' ? advisory.range : '';
      const attributed = attribute(range, located);
      if (attributed.locations.length > BOUNDS.locationsPerFinding) {
        return rejection('over-bound', 'locations-per-finding');
      }
      own.push(findingFrom(name, advisory, ids, attributed, dependents));
    }
    found.push(...mergeIntersecting(own));
  }
  if (found.length > BOUNDS.findings) return rejection('over-bound', 'findings');
  found.sort((a, b) => byCodeUnit(a.package, b.package) || byCodeUnit(a.ids.canonical, b.ids.canonical));
  return { ok: true, findings: found };
}

/** The host name of a registry URL, or `null` when it is missing, is not a URL, or has no host. */
function registryHostOf(registry) {
  if (typeof registry !== 'string') return null;
  try {
    const { hostname } = new URL(registry.trim());
    return hostname === '' ? null : hostname;
  } catch {
    return null;
  }
}

/** The capture, built from an allowlist in the contract's key order (P1). */
function buildCapture(fields) {
  return {
    captureVersion: CAPTURE_VERSION,
    tree: fields.tree,
    ecosystem: ECOSYSTEM,
    commit: fields.commit,
    objectFormat: fields.objectFormat,
    manifest: fields.manifest,
    lockfile: fields.lockfile,
    tool: TOOL,
    toolVersion: fields.toolVersion ?? UNKNOWN,
    command: AUDIT_COMMAND,
    registryHost: fields.registryHost ?? UNKNOWN,
    observedAt: fields.observedAt,
    reportFormat: REPORT_FORMAT,
    outcome: fields.outcome,
    limitations: [...CAPTURE_LIMITATIONS],
    findings: fields.findings ?? []
  };
}

function failed(reason, statusCode) {
  return statusCode === undefined
    ? { status: 'failed', reason }
    : { status: 'failed', reason, statusCode };
}

function rejected(reason, bound) {
  return bound === undefined ? { status: 'rejected', reason } : { status: 'rejected', reason, bound };
}

/**
 * Decide the outcome from what the audit printed, never from its exit status (FR-004). A report is
 * a capture whatever npm's exit code was; an npm error is a failed capture that keeps only its
 * status code.
 */
function decideOutcome(audit, lockfile, rootManifest) {
  if (audit.spawnError) return { outcome: failed('tool-unavailable'), findings: [] };
  if (audit.timedOut) return { outcome: failed('audit-timeout'), findings: [] };
  if (audit.overflow || Buffer.byteLength(audit.stdout) > BOUNDS.reportBytes) {
    return { outcome: rejected('over-bound', 'report-bytes'), findings: [] };
  }
  if (audit.stdout.trim() === '') return { outcome: failed('no-report'), findings: [] };
  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    return { outcome: failed('report-unparseable'), findings: [] };
  }
  if (!isRecord(report)) return { outcome: rejected('malformed'), findings: [] };
  const isError =
    report['error'] !== undefined ||
    (report['message'] !== undefined && report['auditReportVersion'] === undefined);
  if (isError) {
    const code = report['statusCode'];
    const statusCode = typeof code === 'number' && Number.isInteger(code) ? code : undefined;
    return { outcome: failed('audit-error', statusCode), findings: [] };
  }
  const normalized = normalizeReport(report, lockfile, rootManifest);
  if (!normalized.ok) {
    return { outcome: rejected(normalized.reason, normalized.bound), findings: [] };
  }
  return { outcome: { status: 'succeeded' }, findings: normalized.findings };
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * Audit one tree at one commit and return the capture. Never throws for what the audit did: a
 * failed or rejected observation is a capture too. It throws only when the commit does not resolve
 * or the tree is not one of the two, which the caller refuses first.
 *
 * @param {{ tree: string, commit: string }} subject
 * @param {import('./advisory-capture.d.mts').CaptureSeams} seams
 * @returns {import('./advisory-model.d.mts').CaptureFile}
 */
export function captureTree({ tree, commit }, seams) {
  if (!Object.hasOwn(TREES, tree)) throw new TypeError(`unknown tree ${String(tree)}`);
  if (typeof commit !== 'string' || commit === '' || commit.startsWith('-')) {
    throw new TypeError('the commit must be a revision, not an option');
  }
  const files = TREES[tree];
  const fullCommit = seams.gitRevParse(['--verify', '--end-of-options', `${commit}^{commit}`]);
  if (!isObjectId(fullCommit)) throw new Error('the commit does not resolve to a commit');
  const objectFormat = seams.gitRevParse(['--show-object-format']);
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
    throw new Error('the object format of the repository is not recognised');
  }

  const blobOf = (path) => {
    const blob = seams.gitRevParse(['--verify', '--end-of-options', `${fullCommit}:${path}`]);
    return isObjectId(blob) ? blob : null;
  };
  const manifest = { path: files.manifest, blob: blobOf(files.manifest) };
  const lockfile = { path: files.lockfile, blob: blobOf(files.lockfile) };
  const earlyCapture = (outcome, extra = {}) =>
    buildCapture({
      tree,
      commit: fullCommit,
      objectFormat,
      manifest,
      lockfile,
      observedAt: seams.now().toISOString(),
      outcome,
      ...extra
    });

  if (manifest.blob === null || lockfile.blob === null) {
    return earlyCapture(rejected('tree-missing'));
  }
  const sized = [
    { spec: `${fullCommit}:${files.manifest}`, limit: BOUNDS.manifestBytes, bound: 'manifest-bytes' },
    { spec: `${fullCommit}:${files.lockfile}`, limit: BOUNDS.lockfileBytes, bound: 'lockfile-bytes' }
  ];
  for (const { spec, limit, bound } of sized) {
    const size = seams.gitCatFileSize(spec);
    if (size === null) return earlyCapture(rejected('tree-missing'));
    if (size > limit) return earlyCapture(rejected('over-bound', bound));
  }
  const manifestText = seams.gitCatFileBlob(sized[0].spec);
  const lockfileText = seams.gitCatFileBlob(sized[1].spec);
  const parsedManifest = parseJson(manifestText);
  const parsedLockfile = parseJson(lockfileText);
  if (!parsedManifest.ok || !isRecord(parsedManifest.value) || !parsedLockfile.ok || !isRecord(parsedLockfile.value)) {
    return earlyCapture(rejected('malformed'));
  }
  const lock = parsedLockfile.value;
  if (!SUPPORTED_LOCKFILE_VERSIONS.includes(lock['lockfileVersion'])) {
    return earlyCapture(rejected('unsupported-format'));
  }
  if (!isRecord(lock['packages'])) return earlyCapture(rejected('malformed'));

  const dir = seams.makeTempDir();
  try {
    seams.writeFile(dir, 'package.json', manifestText);
    seams.writeFile(dir, 'package-lock.json', lockfileText);
    const toolVersion = seams.npmVersion(dir);
    if (typeof toolVersion !== 'string' || toolVersion.trim() === '') {
      return earlyCapture(failed('tool-unavailable'));
    }
    const registryHost = registryHostOf(seams.npmRegistry(dir));
    if (registryHost === null) {
      return earlyCapture(failed('registry-unknown'), { toolVersion: toolVersion.trim() });
    }
    const observedAt = seams.now().toISOString();
    const audit = seams.runAudit(dir, AUDIT_ARGV);
    const { outcome, findings } = decideOutcome(audit, lock, lock['packages']['']);
    return buildCapture({
      tree,
      commit: fullCommit,
      objectFormat,
      manifest,
      lockfile,
      toolVersion: toolVersion.trim(),
      registryHost,
      observedAt,
      outcome,
      findings
    });
  } finally {
    seams.removeDir(dir);
  }
}
