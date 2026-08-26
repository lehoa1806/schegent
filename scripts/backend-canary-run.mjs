#!/usr/bin/env node
// FR-R3-061 — the runner around `backend-canary.mjs`'s pure decisions.
//
// Separated so the decisions are unit-testable without a CLI, a network, or
// credentials. This half does the I/O and nothing else.

import { spawnSync } from 'node:child_process';
import {
  runnerBackendResult,
  formatReport,
  canaryExitCode,
  saysNotAuthenticated
} from './backend-canary.mjs';

/**
 * The fixed trivial prompt. A one-word answer, so drift in the response shape is
 * visible without parsing prose, and nothing about the workspace is disclosed to
 * the provider.
 */
const CANARY_PROMPT = 'Reply with exactly one word: canary';

/** The hard wall-clock deadline on the live turn. */
const LIVE_TIMEOUT_MS = 120_000;

// FR-R3-084 — the smallest invocation that establishes the protocol still parses:
// one turn, a fixed trivial prompt, no workspace mutation, no network target
// other than the provider.
//
// NO AUTH PROBE, and no API key. Both were proxies and both were wrong — see the
// header of `backend-canary.mjs`. The live turn IS the probe: whether the backend
// can complete one is the question, so it is the thing attempted.
const BACKENDS = [
  { backend: 'claude', command: 'claude', live: ['-p', CANARY_PROMPT] },
  { backend: 'codex', command: 'codex', live: ['exec', CANARY_PROMPT] },
  { backend: 'agy', command: 'agy', live: ['--print', CANARY_PROMPT] }
];
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
 */
function liveProbe(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: false,
    timeout: LIVE_TIMEOUT_MS
  });
  if (result.error) return { ok: false, detail: result.error.message };
  const notAuthenticated = saysNotAuthenticated(result.stdout, result.stderr);
  if (notAuthenticated) return { ok: false, notAuthenticated: true, detail: 'not signed in' };
  if (result.status !== 0) return { ok: false, detail: `exit ${result.status}` };
  const answer = (result.stdout ?? '').trim();
  if (answer.length === 0) return { ok: false, detail: 'empty response' };
  return { ok: true, detail: `answered in ${answer.length} chars` };
}

const results = BACKENDS.map(({ backend, command, live }) => {
  const version = versionProbe(command);
  // A CLI that is not installed is never asked for a turn. Beyond that there is
  // nothing to gate on: the turn is what answers the question.
  const liveResult = version.ok === true ? liveProbe(command, live) : undefined;
  return runnerBackendResult({ backend, versionProbe: version, liveProbe: liveResult });
});

console.log(formatReport(results));
process.exit(canaryExitCode(results));
