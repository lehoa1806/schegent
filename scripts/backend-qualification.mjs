// FR-R3-104 (FR-051..FR-059) — the backend qualification record, and the gate that reads it.
//
// WHAT WAS WRONG. `FR-R3-084` produced the first live canary result this project has ever had,
// and `FR-R3-061` built the canary that produces it. Both stopped one step short of a control:
// the result was PROSE in `docs/release/backend-qualification-log.md`, and no gate read it. So
// a release could be cut with a qualification record that was six months old, or taken against
// a CLI version the installed binary no longer is, and nothing would say so. A cadence nobody
// enforces is a cadence, not a gate — the same shape as the coverage floors `FR-R3-100` found
// declared and unenforced, and as the `timeoutSeconds` four records claimed and nothing applied.
//
// WHAT THIS ADDS. The canary writes a machine-readable record beside its prose entry; the
// release path refuses when that record is absent, stale, or older than the installed CLI
// surface; and a change under the runner area requires a record naming the resulting commit.
//
// WHY THE RELEASE PATH AND NOT EVERY GATE RUN. A live turn costs the operator's own subscription
// quota. `FR-R3-061` decided PR gates stay deterministic, and item 104 restates it: gate the
// release, not `npm run ci`. An operator running the gate forty times a day must not be charged
// forty live turns, and a gate people cannot afford is a gate people disable.
//
// NO PROXY. Nothing here infers qualification from anything other than a record the canary
// wrote after attempting a live turn. The canary's own history is why that is stated: two
// successive auth PROXIES — an env-var check, then a sign-in probe — each reported a working
// backend as unusable. A gate that accepted "the binary exists" as qualification would be the
// third.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from './gate-attestation.mjs';

/**
 * Where the record lives. Untracked, like the gate attestation and for the same reason: it
 * describes one machine's observation at one time, and the next clone must not inherit a
 * qualification it never earned.
 */
export const QUALIFICATION_PATH = resolve(REPO_ROOT, '.backend-qualification.json');

/**
 * How long a qualification stands. **Declared here, derived everywhere else** (FR-052) — the
 * operator disclosure reads this constant rather than restating it, because a bound stated in a
 * comment is the shape this round keeps finding: a number that four records claim and nothing
 * enforces.
 *
 * FOURTEEN DAYS, and the reasoning rather than a round number. What this record vouches for is
 * that three third-party CLIs still speak the protocol the adapters parse. The observed drift
 * rate is the input: between 2026-08-02 and 2026-08-26, `claude` moved 2.0.x to 2.1.246 and
 * `codex` moved through 0.149.0 — multiple releases inside a month, on vendors' own schedules,
 * with no deprecation contract owed to this project. A month-old qualification would routinely
 * be two or three CLI releases behind. A week would cost a subscription operator four live
 * turns a month for a protocol that does not usually break weekly.
 *
 * Fourteen days is one canary run per fortnight: cheap enough to keep, short enough that the
 * record is about roughly the software the operator is running.
 */
export const QUALIFICATION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The paths whose change invalidates an older qualification (FR-053).
 *
 * These are the files that decide what reaches a CLI's command line and how its output is
 * parsed. A change here can break the protocol contract the canary is the only check on, and it
 * will break it silently: every deterministic fixture in the eval corpus is a recording of the
 * OLD protocol, so it keeps passing.
 *
 * `src/parser/` is included and the reason is worth stating: `invocation-usage.ts` reads three
 * backends' terminal rows, and `FR-R3-098` found a marker pair that had never matched `codex`
 * at all. That was a parse-side defect invisible to every fixture, which is exactly the class
 * this gate exists for.
 */
export const QUALIFICATION_PATHS = Object.freeze([
  'src/runner/',
  'src/parser/',
  'src/contracts/backend-kinds.ts'
]);

/** The override, and its name says what it costs. */
export const DRIFT_OVERRIDE_ENV = 'SCHEGENT_RELEASE_UNQUALIFIED';

const git = (args) =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

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
    // Distinct from absence, as with the gate attestation: a corrupted record sends someone to
    // a different remedy than a missing one.
    return { malformed: true };
  }
}

/**
 * Which qualification-relevant paths changed between the qualified commit and HEAD.
 *
 * Returns `null` when the question cannot be answered — an unknown commit, a shallow clone, no
 * git. `null` is NOT "nothing changed": `decideQualification` treats it as a refusal, because an
 * unanswerable check is a refusal and not a pass.
 */
const COMMIT_SHA = /^[0-9a-f]{7,64}$/;

export function changedQualificationPaths(qualifiedCommit, head = 'HEAD') {
  // FR-R3-105's rule, applied to this file's own argv. The commit comes out of a JSON record on
  // disk, which is untrusted input by the same argument the argv boundary makes about an
  // operator-imported pipeline document: `execFileSync` uses no shell, so this is not shell
  // injection — it is FLAG injection. A "commit" of `--output=/tmp/x` would be read by `git` as an
  // option, not as a revision. Bounded to what a commit id can actually be; anything else is
  // unanswerable, which the decision treats as a refusal.
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
      // Not installed, not on PATH, or refused. Recorded as unknown rather than as a mismatch:
      // a machine without `agy` is not a machine whose `agy` qualification is stale.
      observed[backend] = null;
    }
  }
  return observed;
}

/**
 * Extract the comparable version token from a `--version` line.
 *
 * The three CLIs answer differently (`2.1.246 (Claude Code)`, `codex-cli 0.149.0`, `1.1.20`), so
 * the comparison is on the first dotted-numeric token rather than on the whole line. Comparing
 * whole lines would report drift whenever a vendor changed its banner text, and an operator who
 * learns that a drift warning usually means nothing will ignore the one that means something.
 */
export function versionToken(line) {
  if (typeof line !== 'string') return null;
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(line);
  return match === null ? null : match[1];
}

/**
 * Decide whether the release path may proceed on backend qualification. Pure over its inputs, so
 * every arm is exercisable without a live turn, without git and without cutting a release.
 *
 * The arms are separate because their remedies are: run the canary; run it again after the
 * upgrade; run it at this commit; fix the record; or take the override and record why.
 */
export function decideQualification({
  record,
  head,
  installedVersions,
  changedPaths,
  now,
  overrideRequested = false,
  maxAgeMs = QUALIFICATION_MAX_AGE_MS
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
    // NOT a refusal. The record names a commit whose qualification-relevant files are identical
    // to HEAD's, which is the property that matters; requiring the same SHA would demand a live
    // turn for every documentation commit.
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

/** The record the canary writes. Shape stated once, so the writer and the gate cannot disagree. */
export function buildQualificationRecord({ versions, commit, platform, now, states }) {
  return {
    version: 1,
    qualifiedAt: now,
    commit,
    platform,
    versions,
    // The per-backend verdict, so a record written when one backend was degraded cannot read as
    // three green backends. The gate does not consult it today; an operator reading the file does.
    states
  };
}

export function readHeadCommit() {
  try {
    return git(['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}
