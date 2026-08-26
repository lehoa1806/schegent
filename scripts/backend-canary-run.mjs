#!/usr/bin/env node
// FR-R3-061 — the runner around `backend-canary.mjs`'s pure decisions.
//
// Separated so the decisions are unit-testable without a CLI, a network, or
// credentials. This half does the I/O and nothing else.

import { spawnSync } from 'node:child_process';
import {
  QUALIFICATION_PATH,
  buildQualificationRecord,
  readHeadCommit
} from './backend-qualification.mjs';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  runnerBackendResult,
  formatReport,
  canaryExitCode,
  saysNotAuthenticated,
  answerEstablishesPrompt,
  liveArgsFor,
  redactLiveEnvelope,
  stdinPayloadFor,
  LIVE_PROMPT,
  INJECTION_PROMPT
} from './backend-canary.mjs';

/** The hard wall-clock deadline on the live turn. */
const LIVE_TIMEOUT_MS = 120_000;

// FR-R3-084 — the smallest invocation that establishes the protocol still parses:
// one turn, a fixed trivial prompt, no workspace mutation, no network target
// other than the provider.
//
// NO AUTH PROBE, and no API key. Both were proxies and both were wrong — see the
// header of `backend-canary.mjs`. The live turn IS the probe: whether the backend
// can complete one is the question, so it is the thing attempted.
//
// The argv and the stdin bytes come from `LIVE_INVOCATIONS`, which mirrors the
// HOST's shape rather than whatever is convenient here. This file used to carry
// its own argv, and each backend's prompt went on the command line — including
// `agy --print <prompt>`, which was the ONE shape that worked while the product
// used a broken one. The probe agreed with nothing the product did.
const BACKENDS = [
  { backend: 'claude', command: 'claude' },
  { backend: 'codex', command: 'codex' },
  { backend: 'agy', command: 'agy' }
];

/**
 * `--record <dir>` writes each backend's REDACTED envelope to `<dir>`.
 *
 * The live cost and injection scenarios of §3.4 are fixtures replayed through the
 * host's own parsers, so they have to come from somewhere reproducible. This is
 * that somewhere: regenerating them is a flag on the canary, not a manual scrub
 * nobody can repeat. Redaction happens in `redactLiveEnvelope`, before any byte
 * reaches the disk.
 */
function recordDirFromArgv(argv) {
  const flag = argv.indexOf('--record');
  if (flag === -1) return null;
  const dir = argv[flag + 1];
  if (!dir || dir.startsWith('--')) {
    console.error('[backend-canary] --record needs a directory');
    process.exit(2);
  }
  return resolve(dir);
}

const recordDir = recordDirFromArgv(process.argv.slice(2));
if (recordDir) mkdirSync(recordDir, { recursive: true });

/**
 * The live turn's working directory — a temp dir, NEVER the workspace.
 *
 * WHY, measured 2026-08-26. These CLIs load their working directory's context
 * into the turn automatically: `CLAUDE.md`, `AGENTS.md`, git state, the active
 * plan. Run from the repository, one two-token prompt billed 38,101
 * cache-creation tokens, and the model answered the injection scenario by citing
 * `specs/155-gate-integrity-and-review/plan.md` and a commit hash -- with NO tool
 * call in the envelope, so it came from the context the CLI shipped on its own.
 *
 * That makes the canary's standing claim -- a fixed trivial prompt that discloses
 * nothing about the workspace -- FALSE as it was invoked. The prompt disclosed
 * nothing; the working directory disclosed the repository. A neutral cwd is what
 * makes the claim true, and it makes the turn cheaper for the same reason.
 *
 * Not cleaned up: it is empty, `tmpdir()` is the OS's to reclaim, and a canary
 * that deletes directories is a canary with a destructive path in it.
 */
const LIVE_CWD = mkdtempSync(resolve(tmpdir(), 'schegent-canary-'));

// `codex exec` refuses a directory it does not trust -- "Not inside a trusted
// directory and --skip-git-repo-check was not specified" -- so an empty temp dir
// makes it report `drifted` for a reason the canary itself created.
//
// An EMPTY GIT REPO is the answer rather than `--skip-git-repo-check`: the host
// always runs inside the operator's git workspace, so reproducing that condition
// keeps the canary's argv identical to the product's. Opting out of the check with
// a flag the host never passes would make the probe test a path nobody runs.
// Empty, so it still discloses no workspace content.
//
// A failure here is left to surface as that backend's own drift, with the CLI's
// reason attached, rather than being pre-empted by a guess about why git is absent.
{
  const init = spawnSync('git', ['init', '--quiet'], {
    cwd: LIVE_CWD,
    encoding: 'utf8',
    shell: false,
    timeout: 30_000
  });
  if (init.error || init.status !== 0) {
    console.error(
      `[backend-canary] could not git-init the probe directory (${init.error?.message ?? `exit ${init.status}`}); ` +
        'a backend that requires a trusted directory will report drifted'
    );
  }
}

function versionProbe(command) {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    shell: false,
    timeout: 30_000
  });
  if (result.error || result.status !== 0) {
    return { ok: false, detail: result.error?.message ?? `exit ${result.status}` };
  }
  // The first semver-looking token, not the last whitespace-separated one.
  // `claude --version` prints "2.x.y (Claude Code)", so taking the last token
  // reported the version as "Code)" -- observed on the first real run.
  const match = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(result.stdout ?? '');
  return { ok: true, version: match?.[0] ?? 'unknown' };
}

/**
 * One bounded turn against the provider — the whole probe.
 *
 * A refusal that says "sign in" is reported as not-authenticated; any other
 * failure is a drift, which is a finding somebody reads rather than a skip
 * nobody does. Neither is an exit code: `canaryExitCode` stays 0 for both.
 *
 * THE ANSWER IS CHECKED, not merely counted. A non-empty-output test called agy
 * `ok` for 24 days while it answered a one-character prompt with a greeting; the
 * question a live turn exists to settle is whether OUR prompt arrived, so the
 * probe reads the answer for the token it asked for. A backend that returns
 * something else is `drifted` — a prompt regression is exactly what `M-08`
 * asked canaries to catch.
 */
function liveProbe(backend, command) {
  const args = liveArgsFor(backend);
  if (!args) return undefined;
  const result = spawnSync(command, args, {
    input: stdinPayloadFor(backend, LIVE_PROMPT),
    cwd: LIVE_CWD,
    encoding: 'utf8',
    shell: false,
    timeout: LIVE_TIMEOUT_MS
  });
  if (recordDir && (result.stdout ?? '').length > 0) {
    writeFileSync(
      resolve(recordDir, `${backend}-live.jsonl`),
      redactLiveEnvelope(result.stdout),
      'utf8'
    );
  }
  if (result.error) return { ok: false, detail: result.error.message };
  const notAuthenticated = saysNotAuthenticated(result.stdout, result.stderr);
  if (notAuthenticated) return { ok: false, notAuthenticated: true, detail: 'not signed in' };
  if (result.status !== 0) {
    // The CLI's own last diagnostic line, bounded. `exit 1` alone sent a reader
    // back to the terminal to find out what a filed finding even was.
    const reason = (result.stderr ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-1)[0];
    return {
      ok: false,
      detail: `exit ${result.status}${reason ? `: ${reason.slice(0, 200)}` : ''}`
    };
  }
  const answer = (result.stdout ?? '').trim();
  if (answer.length === 0) return { ok: false, detail: 'empty response' };
  if (!answerEstablishesPrompt(answer)) {
    return {
      ok: false,
      detail:
        'the turn completed but its answer does not carry the token the prompt asked for, ' +
        'so the prompt did not reach the model as sent'
    };
  }
  return { ok: true, detail: `answered in ${answer.length} chars` };
}

/**
 * The injection-shaped scenario, recorded only.
 *
 * Run under `--record` alone, so the ordinary canary spends ONE turn per backend
 * and regenerating fixtures is what costs six. Its verdict is deliberately not
 * folded into the canary's state: whether an injected envelope classifies safely
 * is a question for the host's parsers, and those live in TypeScript this script
 * cannot import. So this half records, and
 * `tests/unit/build/canary-live-records.test.ts` classifies -- which keeps
 * `src/parser` the only reader of a backend envelope (FR-082).
 */
function recordInjectionScenario(backend, command) {
  const args = liveArgsFor(backend);
  if (!args || !recordDir) return;
  const result = spawnSync(command, args, {
    input: stdinPayloadFor(backend, INJECTION_PROMPT),
    cwd: LIVE_CWD,
    encoding: 'utf8',
    shell: false,
    timeout: LIVE_TIMEOUT_MS
  });
  if ((result.stdout ?? '').length === 0) {
    console.error(`[backend-canary] ${backend}: injection scenario produced no output, not recorded`);
    return;
  }
  writeFileSync(
    resolve(recordDir, `${backend}-injection.jsonl`),
    redactLiveEnvelope(result.stdout),
    'utf8'
  );
}

const results = BACKENDS.map(({ backend, command }) => {
  const version = versionProbe(command);
  // A CLI that is not installed is never asked for a turn. Beyond that there is
  // nothing to gate on: the turn is what answers the question.
  const liveResult = version.ok === true ? liveProbe(backend, command) : undefined;
  if (version.ok === true && recordDir) recordInjectionScenario(backend, command);
  return runnerBackendResult({ backend, versionProbe: version, liveProbe: liveResult });
});

console.log(formatReport(results));

// FR-R3-104 (FR-051, FR-054, FR-056) — write the machine-readable record beside the printed
// report, so the release path can read what this run observed.
//
// WRITTEN FROM THE OBSERVED PROBES, never from an argument or a default: the versions are the
// ones this process just executed `--version` for, and `states` is the per-backend verdict, so a
// run where one backend only managed a version probe cannot leave a record that reads as three
// qualified backends.
//
// Written even when a backend is degraded, and this is deliberate. The record is an observation,
// not a certificate; the gate reads the versions and the date, and an operator reading the file
// sees exactly which backends produced a live turn. Writing nothing on partial success would
// leave the release path with no record at all, which refuses for the wrong reason.
const qualificationRecord = buildQualificationRecord({
  versions: Object.fromEntries(
    results.map((result) => [result.backend, result.observedVersion ?? null])
  ),
  states: Object.fromEntries(results.map((result) => [result.backend, result.state])),
  commit: readHeadCommit(),
  platform: `${process.platform} ${process.arch} node ${process.versions.node}`,
  now: new Date().toISOString()
});
writeFileSync(QUALIFICATION_PATH, `${JSON.stringify(qualificationRecord, null, 2)}\n`, 'utf8');
console.log(`[backend-canary] qualification record written to ${QUALIFICATION_PATH}`);

process.exit(canaryExitCode(results));
