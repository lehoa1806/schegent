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

/** Expected spend/cost denomination for each advertised backend (FR-R7-18 N04). */
export const EXPECTED_BACKEND_COST_DENOMINATIONS = Object.freeze({
  claude: 'usd',
  codex: 'tokens',
  agy: 'tokens'
});

/**
 * The paths whose change invalidates an older qualification (FR-053 + FR-R7-14 14-10 +
 * FR-R7-17 R7-17-05).
 *
 * Covers legacy/runner adapters, output parsers, backend descriptors, ACP runtime contracts,
 * the ACP client/profiles/stdio bridge implementation, ACP authority gate, host ACP execution
 * wiring, and esbuild bundling configuration.
 */
export const QUALIFICATION_PATHS = Object.freeze([
  'src/runner/',
  'src/parser/',
  'src/contracts/backend-kinds.ts',
  'src/contracts/backend-descriptors.ts',
  'src/contracts/acp-runtime.ts',
  'src/services/acp-runtime/',
  'src/services/containment-qualification/acp-authority-gate.ts',
  'src/activation/acp-execution-wiring.ts',
  'esbuild.config.mjs'
]);

/** Valid host locality tags recorded on v2 qualification records. */
export const QUALIFICATION_LOCALITIES = Object.freeze(['local', 'remote']);

/** Optional live-qualification check flags recorded on v2 records (`R7-17-05`). */
export const QUALIFICATION_CHECK_KEYS = Object.freeze([
  'resume',
  'policyDenial',
  'permissionTitleSanitized'
]);

/** Built bridge output hashed into the qualification source/build fingerprint when present. */
export const QUALIFICATION_BUILD_OUTPUTS = Object.freeze(['dist/acp-stdio-bridge.js']);

/** Default path to the credential-free per-backend prompt-behavior eval manifest (FR-R7-18 N04). */
export const BEHAVIOR_EVAL_MANIFEST_PATH = resolve(
  REPO_ROOT,
  'tests',
  'evals',
  'fixtures',
  'backend-behavior',
  'manifest.json'
);

/** Maximum freshness age in days for credential-free prompt-behavior eval fixtures (FR-R7-18 N04). */
export const BEHAVIOR_EVAL_MAX_AGE_DAYS = 30;

/** The override, and its name says what it costs. */
export const DRIFT_OVERRIDE_ENV = 'SCHEGENT_RELEASE_UNQUALIFIED';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MS_PER_DAY = 86_400_000;

/**
 * Summarize the credential-free per-backend prompt-behavior eval manifest (FR-R7-18 N04)
 * into an additive `behaviorEvals` metadata block for v2 qualification records.
 *
 * Pure over a parsed manifest object; reads from disk when given a file path string.
 * Returns `null` when a path does not exist or cannot be parsed.
 */
export function summarizeBehaviorEvalManifest(
  manifestOrPath = BEHAVIOR_EVAL_MANIFEST_PATH,
  { requiredBackends = ADVERTISED_BACKENDS } = {}
) {
  let manifest = manifestOrPath;
  if (typeof manifestOrPath === 'string') {
    try {
      manifest = JSON.parse(readFileSync(manifestOrPath, 'utf8'));
    } catch {
      return null;
    }
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.tasks)) return null;
  const headerRecordedMs =
    typeof manifest.recordedAt === 'string' ? Date.parse(manifest.recordedAt) : Number.NaN;
  if (!Number.isFinite(headerRecordedMs)) {
    return null;
  }
  if (
    typeof manifest.maxAgeDays !== 'number' ||
    !Number.isFinite(manifest.maxAgeDays) ||
    manifest.maxAgeDays <= 0 ||
    manifest.maxAgeDays > BEHAVIOR_EVAL_MAX_AGE_DAYS
  ) {
    return null;
  }
  if (typeof manifest.staleFixtureOwner !== 'string' || manifest.staleFixtureOwner.trim().length === 0) {
    return null;
  }

  let oldestRecordedMs = headerRecordedMs;
  let oldestRecordedAt = manifest.recordedAt;
  let newestRecordedMs = headerRecordedMs;
  let newestRecordedAt = manifest.recordedAt;
  const perBackend = {};
  for (const backend of requiredBackends) {
    const tasks = manifest.tasks.filter((task) => task && task.backend === backend);
    const promptDigests = [];
    const expectedDenom = EXPECTED_BACKEND_COST_DENOMINATIONS[backend];
    let passedCount = 0;
    let totalCostUnits = 0;
    let costDenomination = expectedDenom ?? null;
    for (const task of tasks) {
      const digestValid =
        typeof task.promptText === 'string' &&
        typeof task.promptDigest === 'string' &&
        SHA256_HEX.test(task.promptDigest) &&
        sha256Hex(task.promptText) === task.promptDigest;
      const transportValid =
        EXPECTED_BACKEND_TRANSPORTS[backend] === undefined ||
        task.transport === EXPECTED_BACKEND_TRANSPORTS[backend];
      const profileValid =
        EXPECTED_BACKEND_PROFILES[backend] === undefined ||
        task.profileId === EXPECTED_BACKEND_PROFILES[backend];
      const denomValid =
        task.costUnits &&
        (expectedDenom !== undefined
          ? task.costUnits.denomination === expectedDenom
          : task.costUnits.denomination === 'usd' || task.costUnits.denomination === 'tokens');
      const costValid =
        Boolean(denomValid) &&
        typeof task.costUnits.value === 'number' &&
        Number.isFinite(task.costUnits.value) &&
        task.costUnits.value >= 0;
      const taskRecordedMs =
        typeof task.recordedAt === 'string' ? Date.parse(task.recordedAt) : Number.NaN;
      const recordedValid = Number.isFinite(taskRecordedMs);
      if (recordedValid) {
        if (taskRecordedMs < oldestRecordedMs) {
          oldestRecordedMs = taskRecordedMs;
          oldestRecordedAt = task.recordedAt;
        }
        if (taskRecordedMs > newestRecordedMs) {
          newestRecordedMs = taskRecordedMs;
          newestRecordedAt = task.recordedAt;
        }
      }
      if (typeof task.promptDigest === 'string') promptDigests.push(task.promptDigest);
      if (costValid) {
        costDenomination = costDenomination ?? task.costUnits.denomination;
        totalCostUnits += task.costUnits.value;
      }
      if (digestValid && transportValid && profileValid && costValid && recordedValid) {
        passedCount += 1;
      }
    }
    perBackend[backend] = {
      taskCount: tasks.length,
      passedCount,
      promptDigests,
      costDenomination: costDenomination ?? (backend === 'claude' ? 'usd' : 'tokens'),
      totalCostUnits: Number(totalCostUnits.toFixed(6))
    };
  }

  return {
    recordedAt: oldestRecordedAt,
    latestRecordedAt: newestRecordedAt,
    maxAgeDays: manifest.maxAgeDays,
    staleFixtureOwner: manifest.staleFixtureOwner.trim(),
    perBackend
  };
}

/**
 * Validate an optional `behaviorEvals` summary block attached to a v2 qualification record
 * (FR-R7-18 N04). Pure over its inputs; called by `decideQualification` only when `behaviorEvals`
 * is present so existing v2 records remain 100% backwards compatible.
 */
export function validateBehaviorEvalsSummary(
  behaviorEvals,
  { now, requiredBackends = ADVERTISED_BACKENDS }
) {
  if (!behaviorEvals || typeof behaviorEvals !== 'object' || Array.isArray(behaviorEvals)) {
    return {
      ok: false,
      reason: 'invalid-behavior-evals',
      message: 'the qualification record carries a malformed behaviorEvals summary.'
    };
  }
  const owner =
    typeof behaviorEvals.staleFixtureOwner === 'string' &&
    behaviorEvals.staleFixtureOwner.trim().length > 0
      ? behaviorEvals.staleFixtureOwner.trim()
      : null;
  if (owner === null) {
    return {
      ok: false,
      reason: 'invalid-behavior-evals',
      message:
        'the qualification record behaviorEvals summary omits staleFixtureOwner; declare the ' +
        'checkout operator owner per repo/docs/operations/live-canary-cadence.md.'
    };
  }
  const maxAgeDays = behaviorEvals.maxAgeDays;
  if (
    typeof maxAgeDays !== 'number' ||
    !Number.isFinite(maxAgeDays) ||
    maxAgeDays <= 0 ||
    maxAgeDays > BEHAVIOR_EVAL_MAX_AGE_DAYS
  ) {
    return {
      ok: false,
      reason: 'invalid-behavior-evals',
      message:
        `the qualification record behaviorEvals summary carries invalid maxAgeDays ` +
        `(${String(maxAgeDays)}); expected a finite value in (0, ${String(BEHAVIOR_EVAL_MAX_AGE_DAYS)}].`
    };
  }
  const nowMs = Date.parse(now ?? '');
  if (!Number.isFinite(nowMs)) {
    return {
      ok: false,
      reason: 'invalid-behavior-evals',
      message: 'cannot evaluate behaviorEvals freshness without a readable current timestamp.'
    };
  }
  const recordedAtMs = Date.parse(behaviorEvals.recordedAt ?? '');
  if (!Number.isFinite(recordedAtMs)) {
    return {
      ok: false,
      reason: 'invalid-behavior-evals',
      message: 'the qualification record behaviorEvals summary carries no readable recordedAt timestamp.'
    };
  }
  if (behaviorEvals.latestRecordedAt !== undefined) {
    const latestMs = Date.parse(behaviorEvals.latestRecordedAt ?? '');
    if (!Number.isFinite(latestMs)) {
      return {
        ok: false,
        reason: 'invalid-behavior-evals',
        message: 'the qualification record behaviorEvals summary carries no readable latestRecordedAt timestamp.'
      };
    }
    if (nowMs - latestMs < 0) {
      return {
        ok: false,
        reason: 'future-behavior-evals',
        message:
          `the behaviorEvals timestamp (${behaviorEvals.latestRecordedAt}) is after ${now}. ` +
          `Owner: ${owner}.`
      };
    }
  }
  const ageMs = nowMs - recordedAtMs;
  if (ageMs < 0) {
    return {
      ok: false,
      reason: 'future-behavior-evals',
      message:
        `the behaviorEvals timestamp (${behaviorEvals.recordedAt}) is after ${now}. ` +
        `Owner: ${owner}.`
    };
  }
  if (ageMs > maxAgeDays * MS_PER_DAY) {
    const days = Math.round(ageMs / MS_PER_DAY);
    return {
      ok: false,
      reason: 'stale-behavior-evals',
      message:
        `per-backend prompt-behavior eval fixtures are ${String(days)} days old; the declared ` +
        `bound is ${String(maxAgeDays)} days. Stale-fixture owner: ${owner}. Refresh ` +
        'repo/tests/evals/fixtures/backend-behavior/ and run `npm run test:evals`.'
    };
  }

  const perBackend = behaviorEvals.perBackend;
  if (!perBackend || typeof perBackend !== 'object' || Array.isArray(perBackend)) {
    return {
      ok: false,
      reason: 'invalid-behavior-evals',
      message: 'the qualification record behaviorEvals summary omits perBackend coverage.'
    };
  }
  const incomplete = [];
  for (const backend of requiredBackends) {
    const entry = perBackend[backend];
    if (!entry || typeof entry !== 'object') {
      incomplete.push(`${backend}: missing`);
      continue;
    }
    if (!Number.isInteger(entry.taskCount) || entry.taskCount < 3) {
      incomplete.push(`${backend}: taskCount=${String(entry.taskCount)} (< 3)`);
      continue;
    }
    if (!Number.isInteger(entry.passedCount) || entry.passedCount !== entry.taskCount) {
      incomplete.push(
        `${backend}: passedCount=${String(entry.passedCount)}/${String(entry.taskCount)}`
      );
      continue;
    }
    if (
      !Array.isArray(entry.promptDigests) ||
      entry.promptDigests.length !== entry.taskCount ||
      !entry.promptDigests.every((d) => typeof d === 'string' && SHA256_HEX.test(d)) ||
      new Set(entry.promptDigests).size !== entry.taskCount
    ) {
      incomplete.push(`${backend}: invalid promptDigests`);
      continue;
    }
    const expectedDenom = EXPECTED_BACKEND_COST_DENOMINATIONS[backend];
    if (
      expectedDenom !== undefined
        ? entry.costDenomination !== expectedDenom
        : entry.costDenomination !== 'usd' && entry.costDenomination !== 'tokens'
    ) {
      incomplete.push(`${backend}: invalid costDenomination=${String(entry.costDenomination)}`);
      continue;
    }
    if (
      typeof entry.totalCostUnits !== 'number' ||
      !Number.isFinite(entry.totalCostUnits) ||
      entry.totalCostUnits < 0
    ) {
      incomplete.push(`${backend}: invalid totalCostUnits=${String(entry.totalCostUnits)}`);
    }
  }
  if (incomplete.length > 0) {
    return {
      ok: false,
      reason: 'incomplete-behavior-evals',
      message:
        `behaviorEvals summary is incomplete or degraded — ${incomplete.join('; ')}. ` +
        `Owner: ${owner}. Run \`npm run test:evals\`.`
    };
  }
  return { ok: true };
}

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
  requiredBackends = ADVERTISED_BACKENDS,
  expectedLocality,
  requireChecks = false
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

  // FR-R7-17 (R7-17-05): Validate optional locality and live-qualification check flags without
  // breaking existing v2 records that omit them.
  if (record.locality !== undefined) {
    if (typeof record.locality !== 'string' || !QUALIFICATION_LOCALITIES.includes(record.locality)) {
      return override({
        ok: false,
        reason: 'invalid-qualification-locality',
        message: `the backend qualification record carries unsupported locality ${JSON.stringify(record.locality)}.`
      });
    }
    if (requireLive && record.locality !== 'local') {
      return override({
        ok: false,
        reason: 'unqualified-locality',
        message:
          `the backend qualification record was captured on locality '${record.locality}'; ` +
          "only local host ('local') qualification is valid for release."
      });
    }
    if (expectedLocality !== undefined && record.locality !== expectedLocality) {
      return override({
        ok: false,
        reason: 'locality-mismatch',
        message:
          `the backend qualification record was captured on locality '${record.locality}', ` +
          `expected '${expectedLocality}'.`
      });
    }
  } else if (expectedLocality !== undefined) {
    return override({
      ok: false,
      reason: 'locality-mismatch',
      message: `the backend qualification record omits locality; expected '${expectedLocality}'.`
    });
  }

  if (record.checks !== undefined) {
    if (typeof record.checks !== 'object' || record.checks === null || Array.isArray(record.checks)) {
      return override({
        ok: false,
        reason: 'incomplete-qualification-checks',
        message: 'the backend qualification record carries a malformed checks object.'
      });
    }
    const failedChecks = [];
    for (const key of QUALIFICATION_CHECK_KEYS) {
      const value = record.checks[key];
      if (value !== undefined && value !== true) {
        failedChecks.push(`${key}=${String(value)}`);
      } else if (requireChecks && value !== true) {
        failedChecks.push(`${key}=missing`);
      }
    }
    if (failedChecks.length > 0) {
      return override({
        ok: false,
        reason: 'incomplete-qualification-checks',
        message:
          `backend qualification checks are incomplete or failed — ${failedChecks.join('; ')}. ` +
          'Re-run qualification covering resume, permission policy denial, and sanitized permission titles.'
      });
    }
  } else if (requireChecks) {
    return override({
      ok: false,
      reason: 'incomplete-qualification-checks',
      message:
        `the backend qualification record omits required qualification checks (${QUALIFICATION_CHECK_KEYS.join(', ')}).`
    });
  }

  // FR-R7-18 (N04): Validate optional additive `behaviorEvals` summary when present,
  // preserving 100% backwards compatibility with existing v2 records that omit it.
  if (record.behaviorEvals !== undefined) {
    const evalVerdict = validateBehaviorEvalsSummary(record.behaviorEvals, {
      now,
      requiredBackends
    });
    if (!evalVerdict.ok) {
      return override(evalVerdict);
    }
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
  {
    commit,
    platform,
    now,
    mode = 'live',
    sourceFingerprint = null,
    locality,
    checks,
    behaviorEvals
  }
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
    sourceFingerprint,
    ...(locality !== undefined ? { locality } : {}),
    ...(checks !== undefined ? { checks } : {}),
    ...(behaviorEvals !== undefined ? { behaviorEvals } : {})
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
  executables,
  locality,
  checks,
  behaviorEvals
}) {
  return {
    version: 2,
    mode,
    qualifiedAt: now,
    commit,
    platform,
    ...(locality !== undefined ? { locality } : {}),
    sourceFingerprint,
    versions,
    states,
    transports,
    profiles,
    ...(executables !== undefined ? { executables } : {}),
    ...(checks !== undefined ? { checks } : {}),
    ...(behaviorEvals !== undefined ? { behaviorEvals } : {})
  };
}

export function readHeadCommit() {
  try {
    return git(['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}
