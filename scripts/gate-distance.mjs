#!/usr/bin/env node
// Feature 217 (FR-R3-180; FR-016, SC-005) — how far the gate attestation is from HEAD, in one
// command and without running the gate.
//
// The review that filed FR-R3-180 learned the record was 142 commits behind by copying a sha out
// of the record by hand and running `git rev-list` against it. This prints the same answer: which
// commit the record is about and whether its gate passed, when it was taken and how long the gate
// took, where HEAD is, and how many commits lie between. The contract is
// `specs/217-evidence-posture-and-bounds/contracts/gate-distance-command.md` in the workspace.
//
// REPORTS, NEVER ENFORCES. It exits 0 in every case, a red or stale record included. Enforcement
// is `require-local-gate.mjs`, and this restates none of its refusals: a reporting command that
// exited non-zero would end up wired into a gate by accident, refusing merges it was never designed
// to judge.
//
// ONE SOURCE OF TRUTH. The record's location, its version, the repository root and the tree state
// come from `gate-attestation.mjs`. Deriving any of them a second time is the split shape that
// module's `GATE_COMMAND_SPEC` comment was written to prevent. `REPO_ROOT` in particular makes the
// answer about `repo/` whatever directory the command is invoked from.
//
// The reader is pure over three seams, so every case is testable without the real record, without
// git and without a gate run (`tests/unit/build/gate-distance.test.ts`). The CLI shell at the bottom
// binds the seams to the real world, and importing this module runs nothing.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ATTESTATION_PATH, ATTESTATION_VERSION, REPO_ROOT, readTreeState } from './gate-attestation.mjs';
import { invokedAsScript } from './invoked-as-script.mjs';

/** The remedy every failure below names, as the release path's refusals name it. */
const RECORD_REMEDY = 'npm run gate:record';

/** The widest label, `gate attestation:`, plus one space, so the values align. */
const LABEL_WIDTH = 18;

/** Characters of a commit id shown, as the contract shows them. */
const SHORT_SHA_LENGTH = 7;

/**
 * A full commit id, SHA-1 or SHA-256, which is what `git rev-parse HEAD` writes into a record.
 *
 * Checked before the value becomes a `git` argument. The record is a file anyone with the checkout
 * can edit, and a `head` beginning `-` would be read by `git rev-list` as an option.
 */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

function line(label, value) {
  return `${`${label}:`.padEnd(LABEL_WIDTH)}${value}`;
}

function shortSha(sha) {
  return sha.slice(0, SHORT_SHA_LENGTH);
}

function unusable(reason, detail) {
  return { ok: false, reason, detail };
}

/**
 * The record's text as a usable record, or why it is not one.
 *
 * Two reasons, split as `decideRelease` splits them (FR-R3-135), because they send the reader to
 * different remedies: `stale-version` is an intact record of another schema and needs one gate run,
 * `unreadable` is a file that is not a record at all and needs looking at first.
 */
function parseRecord(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unusable('unreadable', 'not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return unusable('unreadable', 'not a JSON object');
  }
  if (typeof parsed.version !== 'number') return unusable('unreadable', 'version is not a number');
  if (parsed.version !== ATTESTATION_VERSION) {
    return unusable(
      'stale-version',
      `recorded version ${String(parsed.version)}, current ${String(ATTESTATION_VERSION)}`
    );
  }
  if (typeof parsed.head !== 'string' || !COMMIT_ID.test(parsed.head)) {
    return unusable('unreadable', 'head is not a commit id');
  }
  return { ok: true, record: parsed };
}

function remedyFor(reason) {
  return reason === 'stale-version' ? RECORD_REMEDY : `inspect ${ATTESTATION_PATH}, then ${RECORD_REMEDY}`;
}

function readFailureDetail(error) {
  const code = typeof error?.code === 'string' ? error.code : 'unknown error';
  return `the file could not be read, ${code}`;
}

function attestationLine(record) {
  const command = typeof record.command === 'string' ? record.command : 'unknown command';
  const exit =
    typeof record.exitCode === 'number' || typeof record.exitCode === 'string'
      ? String(record.exitCode)
      : 'unknown';
  return line('gate attestation', `${shortSha(record.head)} (${command}, exit ${exit})`);
}

/** `recordedAt - startedAt` as `14m 08s`, or `duration unknown` when either end does not parse. */
function durationText(startedAt, recordedAt) {
  const start = typeof startedAt === 'string' ? Date.parse(startedAt) : Number.NaN;
  const end = typeof recordedAt === 'string' ? Date.parse(recordedAt) : Number.NaN;
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 'duration unknown';
  const seconds = Math.round((end - start) / MS_PER_SECOND);
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  return `${String(minutes)}m ${String(seconds % SECONDS_PER_MINUTE).padStart(2, '0')}s`;
}

function recordedLine(record) {
  const at = typeof record.recordedAt === 'string' ? record.recordedAt : 'unknown';
  return line('recorded', `${at}, ${durationText(record.startedAt, record.recordedAt)}`);
}

function headLine(tree) {
  return line('HEAD', `${shortSha(tree.head)}${tree.treeClean ? '' : ' (uncommitted changes)'}`);
}

function commitsBehind(count) {
  return `${String(count)} ${count === 1 ? 'commit' : 'commits'} behind`;
}

/**
 * Report the attestation's distance from HEAD. Pure over its seams; never throws for any state the
 * record or the tree can be in, and never calls `process.exit` — the caller owns the process.
 *
 * `distance` is `git rev-list --count <head>..HEAD`, the contract's definition. That count alone is
 * 0 when HEAD is an ANCESTOR of the record — a checkout moved back past the recorded commit — which
 * would read as "the record describes HEAD". So a record HEAD does not contain also reports the
 * commits it is ahead by, and names the remedy.
 *
 * @param {import('./gate-distance.d.mts').GateDistanceDeps} deps
 * @returns {import('./gate-distance.d.mts').GateDistanceReport}
 */
export function reportGateDistance(deps) {
  let text;
  try {
    text = deps.readRecordText();
  } catch (error) {
    return report([
      line('gate attestation', `unusable (unreadable: ${readFailureDetail(error)})`),
      line('remedy', remedyFor('unreadable'))
    ]);
  }
  if (text === null) {
    return report([line('gate attestation', 'none recorded'), line('remedy', RECORD_REMEDY)]);
  }
  const parsed = parseRecord(text);
  if (!parsed.ok) {
    return report([
      line('gate attestation', `unusable (${parsed.reason}: ${parsed.detail})`),
      line('remedy', remedyFor(parsed.reason))
    ]);
  }
  const { record } = parsed;

  let tree;
  try {
    tree = deps.readTreeState();
  } catch {
    // The command reports; a git that cannot answer is one more thing to report, not a crash.
    return report([
      attestationLine(record),
      recordedLine(record),
      line('HEAD', 'unknown - git could not report it'),
      line('distance', 'unknown')
    ]);
  }

  const behind = deps.countCommits(`${record.head}..HEAD`);
  const ahead = behind === null || record.head === tree.head ? 0 : deps.countCommits(`HEAD..${record.head}`);
  if (behind === null || ahead === null) {
    return report([
      attestationLine(record),
      headLine(tree),
      line('distance', 'unknown - recorded commit is not in this repository'),
      line('remedy', RECORD_REMEDY)
    ]);
  }
  const lines = [attestationLine(record), recordedLine(record), headLine(tree)];
  if (ahead === 0) return report([...lines, line('distance', commitsBehind(behind))]);
  return report([
    ...lines,
    line(
      'distance',
      `${commitsBehind(behind)}, ${String(ahead)} ahead - the recorded commit is not an ancestor of HEAD`
    ),
    line('remedy', RECORD_REMEDY)
  ]);
}

/** Every outcome exits 0: see the header. One construction site, so no branch can differ. */
function report(lines) {
  return { exitCode: 0, lines };
}

/** The record's text, or `null` when there is none. Any other read failure is the reader's to report. */
function readRecordText() {
  try {
    return readFileSync(ATTESTATION_PATH, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** `git rev-list --count <range>` in `repo/`, or `null` when git cannot resolve the range. */
function countCommits(range) {
  try {
    const out = execFileSync('git', ['rev-list', '--count', range], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    return /^\d+$/.test(out) ? Number(out) : null;
  } catch {
    return null;
  }
}

if (invokedAsScript(import.meta.url)) {
  const outcome = reportGateDistance({ readRecordText, readTreeState, countCommits });
  for (const text of outcome.lines) console.log(text);
  process.exitCode = outcome.exitCode;
}
