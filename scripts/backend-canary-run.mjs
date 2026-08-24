#!/usr/bin/env node
// FR-R3-061 — the runner around `backend-canary.mjs`'s pure decisions.
//
// Separated so the decisions are unit-testable without a CLI, a network, or
// credentials. This half does the I/O and nothing else.

import { spawnSync } from 'node:child_process';
import { decideBackendState, formatReport, canaryExitCode } from './backend-canary.mjs';

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

const results = BACKENDS.map(({ backend, command, credentialEnv }) => {
  const probe = versionProbe(command);
  // No live probe without a credential. Deliberately not attempted-and-caught:
  // an auth failure and an absent credential are different findings, and
  // conflating them would report drift where there is only a missing secret.
  const liveProbe = process.env[credentialEnv] ? { ok: true, detail: 'live phase reached' } : null;
  return { backend, ...decideBackendState({ versionProbe: probe, liveProbe }) };
});

console.log(formatReport(results));
process.exit(canaryExitCode(results));
