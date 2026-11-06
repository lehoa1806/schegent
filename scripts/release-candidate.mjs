// FR-R4-F09 (FR-002 to FR-006, FR-016, FR-032; contracts RP1 to RP5, AC3) -- prepare a release
// candidate: one build, one SBOM, one archive, one inspection, and one record that names all of
// them. It tags, publishes and uploads nothing, and no step here could.
//
// WHY ONE FUNCTION IN ONE PROCESS. The steps of an `&&` chain are separate processes, and a later
// step cannot tell a build made by the step before it from a build made by hand before the chain
// started, except through file times, which is the defect. So the driver does the work itself and
// every effect is a seam, as `gate-recorder.mjs` does: git, the filesystem, `npm run`, `vsce`,
// the clock and the console are injected, which is what lets each refusal be asserted without a
// build. `prepare-release.mjs` binds the real ones.
//
// WHAT "NEVER REUSED" MEANS. The driver removes every existing output before it builds (RP3 step
// 3), so a `dist/` from another tree, output touched after the build, and output built before a
// configuration change cannot become the candidate. Nothing it reads was written by an earlier
// run: not an SBOM, not a graph, not a VSIX. It never reads a file time as provenance.
//
// WHY THE RECORD'S DIGEST CAN BE TRUSTED TO NAME THE INSPECTED BYTES. The staging file is read
// ONCE. That buffer goes to both archive checks and to the digest, so the bytes that passed are the
// bytes named, and a file replaced after the check cannot be the one the record vouches for.
//
// WHAT IT REFUSES, in the order it finds out: a tree git cannot name or that is dirty; stale,
// incomplete or foreign advisory evidence; a failed step; a build whose identity is unknown, dirty
// or not HEAD's; an archive or SBOM that fails inspection; a tree that moved while it worked. An
// advisory finding with no covering disposition is reported, not refused (research R14).
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { TREES, TREE_NAMES } from './advisory-model.mjs';
import { escapeForTerminal } from './advisory-report.mjs';
import {
  assertSbomMatchesArchive as realAssertSbomMatchesArchive,
  inspectVsixBytes as realInspectVsixBytes
} from './check-vsix-smoke.mjs';
import { decideRelease, describeObservation } from './gate-attestation.mjs';
import { buildSbom, bundledComponents } from './generate-sbom.mjs';
import {
  DISPOSITIONS_PATH,
  RELEASE_ADVISORY_BUDGET_DAYS,
  evaluateReleaseAdvisory,
  renderAdvisoryLines
} from './release-advisory.mjs';
import { sha256Hex } from './release-digest.mjs';

export { RELEASE_ADVISORY_BUDGET_DAYS };

/**
 * The npm scripts the driver spawns, in the order it spawns them. `controlFacts` adds the closure
 * of each to the release closure, so the generated controls page still sees that a release
 * reaches the SBOM although the driver, not an `npm run` chain, does it. A test asserts the
 * driver spawns exactly this list, so the list and the spawned scripts cannot drift.
 */
export const RELEASE_CHILD_SCRIPTS = Object.freeze(['build', 'sbom', 'notices']);

/** The last line of every outcome, accepted or refused (FR-005). */
export const NOTHING_PUBLISHED = 'Nothing was tagged, published or uploaded.';

/** A release version: three numbers with optional pre-release and build parts, and no separator. */
export const RELEASE_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const FULL_COMMIT = /^[0-9a-f]{40}$/;
const DEFAULT_RELEASE_DIRECTORY = '.release';
const OWNER_ONLY_DIRECTORY = 0o700;
const OWNER_ONLY_FILE = 0o600;
const GRAPH_PATHS = Object.freeze({
  host: 'dist/module-graph/host.json',
  webview: 'dist/module-graph/webview.json'
});
const HALF_OF_TREE = Object.freeze({ root: 'host', 'webview-ui': 'webview' });
const GATE_RECORD_PATH = '.gate-attestation.json';
const SBOM_ENTRY = 'extension/schegent-sbom.cdx.json';
const WEBVIEW_BUILD = 'vite build (minified)';

/**
 * `relativePath` resolved under `root`, refused when it leaves `root` or is `root` itself. The
 * driver removes only paths that pass this, and the real removal re-checks.
 *
 * @param {string} root
 * @param {string} relativePath
 * @returns {string}
 */
export function resolveInsideRoot(root, relativePath) {
  const absolute = resolve(root, relativePath);
  const fromRoot = relative(root, absolute);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${relativePath} resolves outside the repository root`);
  }
  return absolute;
}

/** Print each line, split at newlines and escaped, so nothing a file or a check carried can steer a terminal. */
function emit(out, lines) {
  for (const line of lines) {
    for (const part of String(line).split('\n')) out(escapeForTerminal(part));
  }
}

const indent = (text) =>
  String(text)
    .split('\n')
    .map((line) => `  ${line}`);

/** The remedy each advisory reason points to. */
const ADVISORY_REMEDY = Object.freeze({
  'advisory-capture-missing':
    'Capture each tree with `npm run security:advisory-diff -- capture --tree <tree> --commit HEAD --out <path>`\n' +
    'and pass both with `--advisory-capture <tree>=<path>`.',
  'advisory-incomplete': 'Capture the tree again, with `npm run security:advisory-diff -- capture`.',
  'advisory-unavailable':
    'The audit gave no report. Capture the tree again with network access to the registry.',
  'advisory-lockfile-mismatch': 'Capture the tree again at this commit, so it audits the lockfile HEAD holds.',
  'advisory-observed-after-now': 'Check the clock of the machine that made the capture, then capture again.',
  'advisory-stale': 'Capture the tree again; a capture older than the budget is not release evidence.',
  'dispositions-unusable':
    'Repair docs/release/advisory-dispositions.json in a reviewed commit (see docs/release/advisory-dispositions.md).'
});

/**
 * Prepare a release candidate. Never calls `process.exit` and never throws for an expected
 * refusal: the caller owns the process.
 *
 * @param {object} deps Every effect, injected. Paths handed to a seam are repository-relative
 *   POSIX strings, except the capture paths, which the caller resolved.
 * @param {string} deps.repoRoot Absolute repository root, for the removal escape check.
 * @param {string} [deps.releaseDirectory] Output directory under the root. Default `.release`.
 * @param {{ root: string, 'webview-ui': string }} deps.advisoryCaptures
 * @returns {{ exitCode: 0 | 1, reason: string, record: object | null }}
 */
export function releaseCandidate(deps) {
  const { log, error } = deps;
  const inspectVsixBytes = deps.inspectVsixBytes ?? realInspectVsixBytes;
  const assertSbomMatchesArchive = deps.assertSbomMatchesArchive ?? realAssertSbomMatchesArchive;

  const refuse = (reason, explanation) => {
    emit(error, [`prepare-release: REFUSED (${reason})`, ...indent(explanation), NOTHING_PUBLISHED]);
    return { exitCode: 1, reason, record: null };
  };
  const readText = (path) => deps.readFile(path).toString('utf8');
  const tryText = (path) => {
    try {
      return readText(path);
    } catch {
      return undefined;
    }
  };

  // Step 1 -- read the tree. Nothing has been removed yet.
  let start;
  try {
    start = deps.readTreeState();
  } catch {
    return refuse(
      'unknown-identity',
      'Git could not name HEAD, so no commit could be recorded.\nRun this inside the repository checkout.'
    );
  }
  if (!FULL_COMMIT.test(String(start?.head))) {
    return refuse(
      'unknown-identity',
      `Git named HEAD ${JSON.stringify(start?.head)}, which is not a full 40-character commit id.\n` +
        'A candidate is never recorded under an abbreviated or unknown commit.'
    );
  }
  if (start.treeClean !== true) {
    return refuse(
      'dirty-tree',
      'The working tree has uncommitted changes, so the build could not be named by a commit.\n' +
        'Commit or stash them, then run this again.'
    );
  }
  const head = start.head;

  let version;
  try {
    version = JSON.parse(readText('package.json')).version;
  } catch {
    version = undefined;
  }
  if (typeof version !== 'string' || !RELEASE_VERSION_PATTERN.test(version)) {
    return refuse(
      'unknown-identity',
      `The version in package.json, ${JSON.stringify(version)}, is not a release version.\n` +
        'It must be three numbers, with an optional pre-release part, before it can name a file.'
    );
  }

  // The gate record this release relies on (TA6). The preflight made the same decision one process
  // earlier, but a driver run directly would skip it, so it is made again here, before anything is
  // removed. A record that is not verified refuses with its own reason and message.
  const gateText = tryText(GATE_RECORD_PATH);
  let attestation = null;
  if (gateText !== undefined) {
    try {
      attestation = JSON.parse(gateText);
    } catch {
      attestation = { version: 'unparseable' };
    }
  }
  const gateDecision = decideRelease({
    attestation,
    head,
    treeClean: true,
    now: new Date(deps.now()).toISOString()
  });
  if (!gateDecision.ok) {
    return refuse(
      'gate-unverified',
      `The gate record is not usable (${gateDecision.reason}).\n${gateDecision.message}`
    );
  }

  const releaseDirectory = deps.releaseDirectory ?? DEFAULT_RELEASE_DIRECTORY;
  const paths = {
    stagingDirectory: `${releaseDirectory}/staging`,
    staging: `${releaseDirectory}/staging/schegent-${version}.vsix`,
    candidate: `${releaseDirectory}/schegent-${version}.vsix`,
    record: `${releaseDirectory}/schegent-${version}.release.json`
  };

  // Step 2 -- the advisory evidence, before any build work, so an evidence problem costs seconds.
  const evaluatedMs = deps.now();
  const captures = {};
  const lockBlobs = {};
  for (const tree of TREE_NAMES) {
    const capturePath = deps.advisoryCaptures?.[tree];
    captures[tree] = capturePath === undefined ? undefined : tryText(capturePath);
    try {
      lockBlobs[tree] = deps.gitBlob(`HEAD:${TREES[tree].lockfile}`);
    } catch {
      lockBlobs[tree] = undefined;
    }
  }
  const dispositionsText = tryText(DISPOSITIONS_PATH) ?? null;
  const early = evaluateReleaseAdvisory({
    captures,
    lockBlobs,
    dispositionsText,
    bundledByTree: null,
    now: evaluatedMs
  });
  if (early.refusal) {
    return refuse(
      early.refusal.reason,
      `${early.refusal.message}\n${ADVISORY_REMEDY[early.refusal.reason] ?? ''}`.trimEnd()
    );
  }

  // Step 3 -- remove every existing output (research R2). The set is closed: the build output, the
  // root SBOM and notices, the staging directory, and the candidate and record this run would
  // write. Each is resolved under the repository root and checked BEFORE anything is removed, so a
  // path that leaves the root refuses the run with nothing touched. `node_modules` is never in it.
  const outputsToRemove = [
    'dist',
    'schegent-sbom.cdx.json',
    'THIRD-PARTY-NOTICES.md',
    paths.stagingDirectory,
    paths.candidate,
    paths.record
  ];
  for (const target of outputsToRemove) {
    try {
      resolveInsideRoot(deps.repoRoot, target);
    } catch (cause) {
      return refuse(
        'clean-failed',
        `${cause?.message ?? String(cause)}.\nNothing was removed. Check the release directory setting.`
      );
    }
  }
  for (const target of outputsToRemove) {
    try {
      deps.removePath(target);
    } catch (cause) {
      return refuse(
        'clean-failed',
        `Could not remove ${target}: ${cause?.message ?? String(cause)}\n` +
          'A candidate is built only from freshly built output, so this stops here. ' +
          'Remove the cause (a permission, a file in use), then run this again.'
      );
    }
  }

  // Step 4 -- build. A non-zero status refuses, and nothing later runs.
  const [buildScript, sbomScript, noticesScript] = RELEASE_CHILD_SCRIPTS;
  if (deps.runScript(buildScript) !== 0) {
    return refuse('build-failed', `\`npm run ${buildScript}\` exited non-zero.\nFix the build, then run this again.`);
  }

  // Step 5 -- the identity the build stamped into both module graphs.
  const graphs = {};
  for (const half of Object.keys(GRAPH_PATHS)) {
    try {
      graphs[half] = JSON.parse(readText(GRAPH_PATHS[half]));
    } catch {
      return refuse(
        'build-failed',
        `\`npm run ${buildScript}\` exited zero but ${GRAPH_PATHS[half]} is missing or unreadable.\n` +
          'A build that leaves no module graph cannot be released.'
      );
    }
  }
  const builds = Object.values(graphs).map((graph) => graph?.build ?? {});
  if (builds.some((build) => !FULL_COMMIT.test(String(build.commit)))) {
    return refuse(
      'unknown-identity',
      'The build could not name the commit it was made from (its module graph says "unknown").\n' +
        'Build inside the repository checkout, with git available, then run this again.'
    );
  }
  if (builds.some((build) => build.dirty !== false)) {
    return refuse(
      'dirty-identity',
      'The build ran on a tree with uncommitted changes (its module graph says dirty).\n' +
        'Commit or stash them, then run this again.'
    );
  }
  const [hostBuild, webviewBuild] = [graphs.host.build, graphs.webview.build];
  if (hostBuild.commit !== head || webviewBuild.commit !== hostBuild.commit) {
    return refuse(
      'identity-mismatch',
      `HEAD is ${head}; the host build says ${hostBuild.commit} and the webview build says ${webviewBuild.commit}.\n` +
        'Both halves must be built from HEAD, in one run.'
    );
  }

  // Step 6 -- the SBOM, from this run's graphs.
  if (deps.runScript(sbomScript) !== 0) {
    return refuse('sbom-failed', `\`npm run ${sbomScript}\` exited non-zero.\nRead its output, then run this again.`);
  }

  // Step 6b -- the third-party notices, from the same graphs (FR-R5-F21). The archive requires
  // them, so a failure here refuses before anything is packaged.
  if (deps.runScript(noticesScript) !== 0) {
    return refuse(
      'notices-failed',
      `\`npm run ${noticesScript}\` exited non-zero.\nRead its output: it names each package or module it could not license.`
    );
  }

  // Step 7 -- package once, into staging.
  try {
    deps.ensureDirectory(paths.stagingDirectory, OWNER_ONLY_DIRECTORY);
  } catch (cause) {
    return refuse('package-failed', `Could not create ${paths.stagingDirectory}: ${cause?.message ?? cause}`);
  }
  if (deps.runVsce(paths.staging) !== 0) {
    return refuse(
      'package-failed',
      '`vsce package` exited non-zero.\nThe staging file is not a candidate; read the output above, then run this again.'
    );
  }

  // Step 8 -- inspect the exact bytes, once.
  let bytes;
  let archiveSbom;
  try {
    bytes = deps.readFile(paths.staging);
    inspectVsixBytes(bytes, paths.staging);
    archiveSbom = assertSbomMatchesArchive(bytes, paths.staging);
  } catch (cause) {
    return refuse(
      'inspection-failed',
      `${cause?.message ?? String(cause)}\nThe staging file was kept and is not a candidate.`
    );
  }
  const readJson = (path) => JSON.parse(readText(path));
  let derived;
  try {
    derived = buildSbom({
      graphs,
      locks: { root: readJson('package-lock.json'), 'webview-ui': readJson('webview-ui/package-lock.json') },
      manifests: { root: readJson('package.json'), 'webview-ui': readJson('webview-ui/package.json') },
      now: new Date(evaluatedMs).toISOString()
    });
  } catch (cause) {
    return refuse('inspection-failed', `The bundled set could not be re-derived: ${cause?.message ?? cause}`);
  }
  const fromGraphs = bundledComponents(derived);
  const fromArchive = bundledComponents(archiveSbom.sbom);
  const graphsOnly = fromGraphs.filter((entry) => !fromArchive.includes(entry));
  const archiveOnly = fromArchive.filter((entry) => !fromGraphs.includes(entry));
  if (graphsOnly.length > 0 || archiveOnly.length > 0) {
    return refuse(
      'inspection-failed',
      "The bundled set in the archive's SBOM differs from the set re-derived from this build's module graphs." +
        (graphsOnly.length > 0 ? `\nIn the graphs only: ${graphsOnly.join(', ')}` : '') +
        (archiveOnly.length > 0 ? `\nIn the SBOM only: ${archiveOnly.join(', ')}` : '')
    );
  }

  // Step 9 -- the tree must be where it was.
  let after;
  try {
    after = deps.readTreeState();
  } catch {
    after = null;
  }
  if (after?.head !== head || after?.treeClean !== true) {
    return refuse(
      'tree-moved',
      `HEAD was ${head} and the tree was clean when this started; it is now ${String(after?.head)}` +
        `${after?.treeClean === true ? '' : ' with uncommitted changes'}.\n` +
        'A candidate must describe the tree it was built from. Run this again on a quiet tree.'
    );
  }

  // The advisory evidence again, now that the build's bundled sets are known, for the usage column.
  const bundledByTree = Object.fromEntries(
    TREE_NAMES.map((tree) => {
      const graph = graphs[HALF_OF_TREE[tree]];
      return [
        tree,
        {
          installPaths: graph.packages.map((entry) => entry.installPath),
          unmapped: graph.unmapped.map((entry) => entry.label)
        }
      ];
    })
  );
  const advisory = evaluateReleaseAdvisory({
    captures,
    lockBlobs,
    dispositionsText,
    bundledByTree,
    now: evaluatedMs
  });
  if (advisory.refusal) {
    return refuse(advisory.refusal.reason, advisory.refusal.message);
  }

  // Step 10 -- accept: the digest of the inspected buffer, the rename, the record.
  const candidateDigest = sha256Hex(bytes);
  const { sbom: shippedSbom, sbomSha256 } = archiveSbom;
  const headline = (name) =>
    Number(shippedSbom.metadata.properties.find((entry) => entry.name === name)?.value ?? 0);
  const sbomCounts = {
    declaredRuntimeDependencies: headline('schegent:runtimeDependencyCount'),
    bundledComponents: headline('schegent:bundledComponentCount'),
    unknownProvenance: headline('schegent:unknownProvenanceCount')
  };
  const { sha256: dispositionsDigest, entries: dispositionEntries } = advisory.dispositions;
  const record = {
    releaseRecordVersion: 1,
    preparedAt: new Date(deps.now()).toISOString(),
    candidate: { path: paths.candidate, sha256: candidateDigest, bytes: bytes.length },
    source: { commit: head, dirty: false },
    build: { mode: hostBuild.mode, webview: WEBVIEW_BUILD },
    sbom: { entry: SBOM_ENTRY, sha256: sbomSha256, ...sbomCounts },
    advisory: {
      budgetDays: advisory.budgetDays,
      evaluatedAt: advisory.evaluatedAt,
      captures: advisory.captures.map(
        ({ tree, sha256, commit, lockfile, toolVersion, observedAt, completeness, findings }) => ({
          tree,
          sha256,
          commit,
          lockfile: { ...lockfile, sha256: sha256Hex(deps.readFile(lockfile.path)) },
          toolVersion,
          observedAt,
          completeness,
          findings
        })
      ),
      dispositions: { path: DISPOSITIONS_PATH, sha256: dispositionsDigest, entries: dispositionEntries },
      verdicts: advisory.verdicts,
      findings: advisory.findings
    },
    gate: {
      recordVersion: attestation.version,
      head: attestation.head,
      recordedAt: attestation.recordedAt,
      platform: attestation.platform,
      arch: attestation.arch,
      nodeVersion: attestation.nodeVersion,
      nodeDeclared: attestation.nodeDeclared,
      nodeMatchesDeclared: attestation.nodeMatchesDeclared,
      envelope: attestation.envelope,
      trees: attestation.trees
    },
    tagged: false,
    published: false
  };

  try {
    deps.rename(paths.staging, paths.candidate);
  } catch (cause) {
    return refuse('record-failed', `Could not move the staging file to ${paths.candidate}: ${cause?.message ?? cause}`);
  }
  try {
    deps.writeExclusive(paths.record, `${JSON.stringify(record, null, 2)}\n`, OWNER_ONLY_FILE);
  } catch (cause) {
    try {
      deps.rename(paths.candidate, paths.staging);
    } catch {
      // The record is the thing that failed; the candidate being left where it is is reported below.
    }
    return refuse(
      'record-failed',
      `The release record could not be written (${cause?.message ?? cause}).\n` +
        `The candidate was moved back to ${paths.staging}; no candidate exists. Remove the cause, then run this again.`
    );
  }

  // Step 11 -- report.
  emit(log, [
    'prepare-release: ACCEPTED',
    `  candidate: ${paths.candidate}`,
    `  sha256:    ${candidateDigest} (${bytes.length} bytes)`,
    `  source:    commit ${head}, host build mode ${hostBuild.mode}; the webview is built by ${WEBVIEW_BUILD}`,
    `  sbom:      ${sbomCounts.declaredRuntimeDependencies} declared runtime dependencies, ` +
      `${sbomCounts.bundledComponents} bundled, ${sbomCounts.unknownProvenance} unknown provenance`,
    ...renderAdvisoryLines(advisory),
    `  gate:      record at ${head} (${attestation.platform}/${attestation.arch}, recorded ${attestation.recordedAt})`,
    ...describeObservation(attestation).map((line) => `             ${line}`),
    `  record:    ${paths.record}`,
    NOTHING_PUBLISHED
  ]);
  return { exitCode: 0, reason: 'accepted', record };
}
