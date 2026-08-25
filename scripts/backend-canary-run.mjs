#!/usr/bin/env node
// FR-R3-061 — the runner around `backend-canary.mjs`'s pure decisions.
//
// Separated so the decisions are unit-testable without a CLI, a network, or
// credentials. This half does the I/O and nothing else.

import { spawnSync } from 'node:child_process';
import { runnerBackendResult, formatReport, canaryExitCode } from './backend-canary.mjs';

/** The three shipped backends, and the version prefix last observed for each. */
const BACKENDS = [
  { backend: 'claude', command: 'claude', credentialEnv: 'ANTHROPIC_API_KEY' },
  { backend: 'codex', command: 'codex', credentialEnv: 'OPENAI_API_KEY' },
  { backend: 'agy', command: 'agy', credentialEnv: 'AGY_API_KEY' }
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

const results = BACKENDS.map(({ backend, command, credentialEnv }) =>
  // FR-R3-072: the runner constructs no probe result. It hands the decision
  // layer only what it observed -- the executed version probe and the raw
  // credential value -- and the decision layer turns "credential absent" and
  // "credential present, no live path" into distinct honest skips. `ok` is
  // unreachable from here until a live invocation exists.
  runnerBackendResult({
    backend,
    versionProbe: versionProbe(command),
    credentialValue: process.env[credentialEnv]
  })
);

console.log(formatReport(results));
process.exit(canaryExitCode(results));
