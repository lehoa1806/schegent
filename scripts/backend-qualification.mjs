// FR-R3-104 (FR-051..FR-059) & FR-R7-14 (14-10) — the backend qualification record, and the gate
// that reads it.
//
// WHAT FR-R7-14 (14-10) CLOSED. Version 1 recorded `states`, never checked them in
// `decideQualification`, skipped absent backends, and watched only three source prefixes
// (`src/runner/`, `src/parser/`, `src/contracts/backend-kinds.ts`), leaving ACP runtime, bridge,
// descriptor, and bundler changes invisible. Version 2 requires:
//   - positive turn evidence (`states[backend] === 'ok'` and a recorded version) for EVERY
//     advertised backend (`claude`, `codex`, `agy`);
//   - shipped-transport provenance (`acp-stdio-bridge` for `claude` and `codex`; `acp-native` for
//     `agy`), active profile id, and executable/version metadata;
//   - a deterministic source/build fingerprint covering runner, parser, descriptors, ACP runtime,
//     bridge sources, esbuild config, and the built bridge bundle (`dist/acp-stdio-bridge.js`),
//     hashed via `sha256Hex` from `./release-digest.mjs`;
//   - explicit distinction between deterministic credential-free `--fixture` evidence
//     (`mode: 'fixture'`) and deliberate live release evidence (`mode: 'live'`).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { REPO_ROOT } from './gate-attestation.mjs';
import { sha256Hex } from './release-digest.mjs';

/**
 * Where the record lives. Untracked, like the gate attestation and for the same reason: it
 * describes one machine's observation at one time, and the next clone must not inherit a
 * qualification it never earned.
 */
export const QUALIFICATION_PATH = resolve(REPO_ROOT, '.backend-qualification.json');

/**
 * How long a qualification stands. **Declared here, derived everywhere else** (FR-052).
 */
export const QUALIFICATION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Advertised backends every release qualification record must cover positively. */
export const ADVERTISED_BACKENDS = Object.freeze(['claude', 'codex', 'agy']);

/** Expected shipped transport for each advertised backend. */
export const EXPECTED_BACKEND_TRANSPORTS = Object.freeze({
  claude: 'acp-stdio-bridge',
  codex: 'acp-stdio-bridge',
  agy: 'acp-native'
});

/** Built-in host ACP profile id for each advertised backend. */
export const EXPECTED_BACKEND_PROFILES = Object.freeze({
  claude: 'claude-acp-bridge',
  codex: 'codex-acp-bridge',
  agy: 'agy-acp-native'
});

/**
 * The paths whose change invalidates an older qualification (FR-053 + FR-R7-14 14-10).
 *
 * Covers legacy/runner adapters, output parsers, backend descriptors, ACP runtime contracts,
 * the ACP client/profiles/stdio bridge implementation, and esbuild bundling configuration.
 */
export const QUALIFICATION_PATHS = Object.freeze([
  'src/runner/',
  'src/parser/',
  'src/contracts/backend-kinds.ts',
  'src/contracts/backend-descriptors.ts',
  'src/contracts/acp-runtime.ts',
  'src/services/acp-runtime/',
  'esbuild.config.mjs'
]);

/** Built bridge output hashed into the qualification source/build fingerprint when present. */
export const QUALIFICATION_BUILD_OUTPUTS = Object.freeze(['dist/acp-stdio-bridge.js']);

/** The override, and its name says what it costs. */
export const DRIFT_OVERRIDE_ENV = 'SCHEGENT_RELEASE_UNQUALIFIED';

const git = (args) =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function collectFilesUnder(root, relTarget) {
  const full = resolve(root, relTarget);
  if (!existsSync(full)) return [];
  const stat = statSync(full);
  if (stat.isFile()) return [relTarget.split(sep).join('/')];
  if (!stat.isDirectory()) return [];
  const files = [];
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const childAbs = join(full, entry.name);
    const childRel = relative(root, childAbs).split(sep).join('/');
    if (entry.isDirectory()) {
      files.push(...collectFilesUnder(root, childRel));
    } else if (entry.isFile()) {
      files.push(childRel);
    }
  }
  return files;
}

/**
 * Compute a deterministic fingerprint over every qualification-relevant source path and shipped
 * bridge bundle under `repoRoot`. Returns a 64-char hex digest (produced via `./release-digest.mjs`)
 * or `null` when no source files can be read.
 */
export function computeQualificationSourceFingerprint(repoRoot = REPO_ROOT) {
  const candidates = new Set();
  for (const prefix of QUALIFICATION_PATHS) {
    for (const file of collectFilesUnder(repoRoot, prefix)) {
      candidates.add(file);
    }
  }
  for (const built of QUALIFICATION_BUILD_OUTPUTS) {
    const builtFiles = collectFilesUnder(repoRoot, built);
    if (builtFiles.length === 0) return null;
    for (const file of builtFiles) {
      candidates.add(file);
    }
  }
  const sorted = [...candidates].sort();
  if (sorted.length === 0) return null;
  const chunks = [];
  for (const rel of sorted) {
    const content = readFileSync(resolve(repoRoot, rel));
    chunks.push(`${rel}:${sha256Hex(content)}\n`);
  }
  return sha256Hex(chunks.join(''));
}

/** The record, or `null` when absent; `{ malformed: true }` when it exists and does not parse. */
export function readQualification(path = QUALIFICATION_PATH) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { malformed: true };
  }
}

const COMMIT_SHA = /^[0-9a-f]{7,64}$/;

export function changedQualificationPaths(qualifiedCommit, head = 'HEAD') {
  if (typeof qualifiedCommit !== 'string' || !COMMIT_SHA.test(qualifiedCommit)) return null;
  let changed;
  try {
    changed = git(['diff', '--name-only', `${qualifiedCommit}..${head}`]);
  } catch {
    return null;
  }
  if (changed.length === 0) return [];
  return changed
    .split('\n')
    .filter((file) => QUALIFICATION_PATHS.some((prefix) => file.startsWith(prefix)));
}

/** The installed CLI surface, as the canary would observe it. Absent probes are `null`. */
export function probeInstalledVersions(commands = { claude: 'claude', codex: 'codex', agy: 'agy' }) {
  const observed = {};
  for (const [backend, command] of Object.entries(commands)) {
    try {
      observed[backend] = execFileSync(command, ['--version'], {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore']
      })
        .trim()
        .split('\n')[0];
    } catch {
      observed[backend] = null;
    }
  }
  return observed;
}

/** Extract the comparable version token from a `--version` line. */
export function versionToken(line) {
  if (typeof line !== 'string') return null;
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(line);
  return match === null ? null : match[1];
}

/**
 * Decide whether the release path (or deterministic fixture verification when `requireLive: false`)
 * may proceed on backend qualification. Pure over its inputs.
 */
export function decideQualification({
  record,
  head,
  installedVersions,
  changedPaths,
  now,
  overrideRequested = false,
  maxAgeMs = QUALIFICATION_MAX_AGE_MS,
  expectedFingerprint,
  requireLive = true,
  requiredBackends = ADVERTISED_BACKENDS
}) {
  const override = (verdict) =>
    overrideRequested
      ? {
          ok: true,
          reason: `overridden:${verdict.reason}`,
          message:
            `RELEASING UNQUALIFIED — ${verdict.message} Overridden by ${DRIFT_OVERRIDE_ENV}. ` +
            'Record this in docs/release/backend-qualification-log.md as an unqualified release, ' +
            'with the date and the reason, per FR-057.'
        }
      : verdict;

  if (record === null || record === undefined) {
    return override({
      ok: false,
      reason: 'no-qualification',
      message:
        `no backend qualification record exists at ${QUALIFICATION_PATH}. Run \`npm run canary\`; ` +
        'it writes the record beside its printed result.'
    });
  }
  if (record.malformed === true) {
    return override({
      ok: false,
      reason: 'unreadable-qualification',
      message: `the record at ${QUALIFICATION_PATH} exists and does not parse. Re-run \`npm run canary\`.`
    });
  }
  const qualifiedAt = Date.parse(record.qualifiedAt ?? '');
  if (!Number.isFinite(qualifiedAt)) {
    return override({
      ok: false,
      reason: 'undated-qualification',
      message: 'the qualification record carries no readable date, so its age cannot be judged.'
    });
  }
  const ageMs = Date.parse(now) - qualifiedAt;
  if (ageMs < 0) {
    return override({
      ok: false,
      reason: 'future-qualification',
      message: `the backend qualification timestamp (${record.qualifiedAt}) is after ${now}.`
    });
  }
  if (ageMs > maxAgeMs) {
    const days = (ms) => Math.round(ms / 86_400_000);
    return override({
      ok: false,
      reason: 'stale-qualification',
      message:
        `the newest backend qualification is ${days(ageMs)} days old; the declared bound is ` +
        `${days(maxAgeMs)} days (QUALIFICATION_MAX_AGE_MS). Run \`npm run canary\`.`
    });
  }

  if (record.version !== 2) {
    return override({
      ok: false,
      reason: 'unsupported-qualification-version',
      message:
        `the backend qualification record has version ${JSON.stringify(record.version ?? null)}, ` +
        'expected version 2 with shipped-transport provenance. Re-run `npm run canary`.'
    });
  }

  const recordMode = record.mode;
  if (recordMode !== 'live' && recordMode !== 'fixture') {
    return override({
      ok: false,
      reason: 'invalid-qualification-mode',
      message: `the backend qualification record has unsupported or missing mode ${JSON.stringify(record.mode ?? null)}.`
    });
  }
  if (requireLive && recordMode !== 'live') {
    return override({
      ok: false,
      reason: 'fixture-only-qualification',
      message:
        'the backend qualification record was produced in deterministic fixture mode (`--fixture`), ' +
        'not from live provider turns. Run `npm run canary` for live release qualification.'
    });
  }

  // FR-R7-14 (14-10): Every advertised backend must have positive turn evidence (`state === 'ok'`),
  // a recorded version token, the expected shipped transport, and the expected built-in profile.
  const incomplete = [];
  const transportMismatches = [];
  for (const backend of requiredBackends) {
    const state = record.states?.[backend];
    const recordedVersion = record.versions?.[backend];
    if (state !== 'ok') {
      incomplete.push(`${backend}: state=${String(state ?? 'missing')}`);
      continue;
    }
    if (typeof recordedVersion !== 'string' || versionToken(recordedVersion) === null) {
      incomplete.push(`${backend}: missing observed version`);
    }
    const recordedTransport = record.transports?.[backend];
    const expectedTransport = EXPECTED_BACKEND_TRANSPORTS[backend];
    if (expectedTransport !== undefined && recordedTransport !== expectedTransport) {
      transportMismatches.push(
        `${backend}: recorded transport ${String(recordedTransport ?? 'missing')}, expected ${expectedTransport}`
      );
    }
    const recordedProfile = record.profiles?.[backend];
    const expectedProfile = EXPECTED_BACKEND_PROFILES[backend];
    if (expectedProfile !== undefined && recordedProfile !== expectedProfile) {
      transportMismatches.push(
        `${backend}: recorded profile ${String(recordedProfile ?? 'missing')}, expected ${expectedProfile}`
      );
    }
  }
  if (incomplete.length > 0) {
    return override({
      ok: false,
      reason: 'incomplete-qualification',
      message:
        `backend qualification is incomplete or degraded — ${incomplete.join('; ')}. ` +
        'Every advertised backend must complete a positive turn before release.'
    });
  }
  if (transportMismatches.length > 0) {
    return override({
      ok: false,
      reason: 'transport-mismatch',
      message:
        `backend qualification did not exercise the shipped transport — ${transportMismatches.join('; ')}. ` +
        'Re-run `npm run canary` through the shipped ACP bridge/native transport.'
    });
  }

  const drifted = [];
  for (const [backend, installed] of Object.entries(installedVersions ?? {})) {
    if (installed === null || installed === undefined) continue;
    const qualified = record.versions?.[backend];
    if (typeof qualified !== 'string') {
      drifted.push(`${backend}: installed ${versionToken(installed)}, never qualified`);
      continue;
    }
    if (versionToken(qualified) !== versionToken(installed)) {
      drifted.push(
        `${backend}: qualified ${versionToken(qualified)}, installed ${versionToken(installed)}`
      );
    }
  }
  if (drifted.length > 0) {
    return override({
      ok: false,
      reason: 'version-drift',
      message:
        `the installed CLI surface has moved since it was qualified — ${drifted.join('; ')}. ` +
        'Run `npm run canary` against the installed versions.'
    });
  }

  if (expectedFingerprint !== undefined) {
    if (typeof expectedFingerprint !== 'string' || expectedFingerprint.length === 0) {
      return override({
        ok: false,
        reason: 'unanswerable-fingerprint',
        message: 'cannot compute the current backend qualification source/build fingerprint.'
      });
    }
    if (
      typeof record.sourceFingerprint !== 'string' ||
      record.sourceFingerprint !== expectedFingerprint
    ) {
      return override({
        ok: false,
        reason: 'fingerprint-mismatch',
        message:
          'qualification-relevant runner, parser, descriptor, ACP runtime, or bridge sources/build ' +
          'changed since the qualification record was written. Re-run `npm run canary`.'
      });
    }
  }

  if (changedPaths === null) {
    return override({
      ok: false,
      reason: 'unanswerable-path-check',
      message:
        `cannot determine which files changed since the qualified commit ` +
        `(${record.commit ?? 'unrecorded'}). An unanswerable check is a refusal: re-run ` +
        '`npm run canary` at this commit.'
    });
  }
  if (changedPaths.length > 0) {
    return override({
      ok: false,
      reason: 'runner-changed-since-qualification',
      message:
        `these qualification-relevant files changed since the qualified commit: ` +
        `${changedPaths.slice(0, 5).join(', ')}${changedPaths.length > 5 ? ', …' : ''}. ` +
        'The eval corpus cannot see protocol drift — every fixture records the OLD protocol — so ' +
        'a fresh record naming this commit is required. Run `npm run canary`.'
    });
  }
  if (record.commit !== head) {
    return {
      ok: true,
      reason: 'qualified-at-equivalent-tree',
      message:
        `backend qualification stands: recorded at ${String(record.commit).slice(0, 12)}, and no ` +
        'qualification-relevant file has changed since.'
    };
  }
  return {
    ok: true,
    reason: 'qualified',
    message: `backend qualification stands: recorded at HEAD, ${describeVersions(record.versions)}.`
  };
}

function describeVersions(versions) {
  const entries = Object.entries(versions ?? {});
  if (entries.length === 0) return 'no versions recorded';
  return entries.map(([backend, version]) => `${backend} ${versionToken(version) ?? '?'}`).join(', ');
}

/**
 * FR-R3-104 & FR-R7-14 (14-10) — project canary results into the v2 machine-readable record.
 */
export function recordFromCanaryResults(
  results,
  { commit, platform, now, mode = 'live', sourceFingerprint = null }
) {
  return buildQualificationRecord({
    versions: Object.fromEntries(
      results.map((result) => [result.backend, result.observedVersion ?? null])
    ),
    states: Object.fromEntries(results.map((result) => [result.backend, result.state])),
    transports: Object.fromEntries(
      results.map((result) => [
        result.backend,
        result.transport ?? EXPECTED_BACKEND_TRANSPORTS[result.backend] ?? 'unknown'
      ])
    ),
    profiles: Object.fromEntries(
      results.map((result) => [
        result.backend,
        result.profileId ?? EXPECTED_BACKEND_PROFILES[result.backend] ?? 'unknown'
      ])
    ),
    executables: Object.fromEntries(
      results.map((result) => [result.backend, result.executable ?? result.backend])
    ),
    commit,
    platform,
    now,
    mode,
    sourceFingerprint
  });
}

/** The v2 record the canary writes. Shape stated once, so the writer and the gate cannot disagree. */
export function buildQualificationRecord({
  versions,
  commit,
  platform,
  now,
  states,
  mode = 'live',
  sourceFingerprint = null,
  transports = { ...EXPECTED_BACKEND_TRANSPORTS },
  profiles = { ...EXPECTED_BACKEND_PROFILES },
  executables
}) {
  return {
    version: 2,
    mode,
    qualifiedAt: now,
    commit,
    platform,
    sourceFingerprint,
    versions,
    states,
    transports,
    profiles,
    ...(executables !== undefined ? { executables } : {})
  };
}

export function readHeadCommit() {
  try {
    return git(['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}
