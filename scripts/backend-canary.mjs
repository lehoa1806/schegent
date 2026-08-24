#!/usr/bin/env node
// FR-R3-061 (M-08 / R-15) — behavioural canary for the real backend CLIs.
//
// The eval corpus is 10 deterministic fixtures exercising parser and outcome
// mapping. Real CLI protocol drift, auth changes, prompt/tool regressions and
// cost drift are invisible to it, and stay invisible until a run fails in an
// operator's workspace.
//
// This probes the real thing on a schedule, OFF the PR path. The review is
// explicit that PR gates stay deterministic: a gate depending on a third-party
// service goes red for reasons unrelated to the change under review, and people
// learn to re-run it rather than read it.
//
// DEGRADATION IS A REPORTED STATE, NOT A SKIP
//
// Credentials are an operator-supplied precondition. Without them this runs the
// version probe only and SAYS SO in its output. A canary that silently reports
// success because it did nothing is worse than one that does not run.

/** What a probe can conclude. */
export const PROBE_STATES = ['ok', 'drifted', 'unavailable', 'skipped-no-credentials'];

/**
 * Decide one backend's canary state from a version probe and an optional live
 * probe. A pure function so the decision is testable without a CLI present --
 * the same reasoning as `require-full-gate.mjs`.
 */
export function decideBackendState({ versionProbe, liveProbe, expectedVersionPrefix }) {
  if (!versionProbe || versionProbe.ok !== true) {
    return {
      state: 'unavailable',
      detail: `version probe failed: ${versionProbe?.detail ?? 'no result'}`
    };
  }
  if (
    typeof expectedVersionPrefix === 'string' &&
    expectedVersionPrefix.length > 0 &&
    !String(versionProbe.version ?? '').startsWith(expectedVersionPrefix)
  ) {
    return {
      state: 'drifted',
      detail:
        `version ${versionProbe.version} does not start with the recorded ` +
        `${expectedVersionPrefix}; check the protocol shape before trusting the corpus`
    };
  }
  if (!liveProbe) {
    return {
      state: 'skipped-no-credentials',
      detail:
        `version ${versionProbe.version} observed; the live phase was NOT run because no ` +
        'credentials were supplied. This run says nothing about protocol, auth, prompt or cost.'
    };
  }
  if (liveProbe.ok !== true) {
    return { state: 'drifted', detail: `live probe failed: ${liveProbe.detail ?? 'no detail'}` };
  }
  return { state: 'ok', detail: `version ${versionProbe.version}, live probe passed` };
}

/**
 * The exit code for a whole canary run.
 *
 * ALWAYS 0 unless the canary itself is broken. A drift is a finding to file, not
 * a red gate -- that is the review's explicit constraint, and an exit code is
 * how a workflow turns a finding into a red gate by accident.
 */
export function canaryExitCode(results) {
  return Array.isArray(results) ? 0 : 2;
}

/** One line per backend, so the most recent result is readable in the run log. */
export function formatReport(results) {
  const lines = ['[backend-canary] results'];
  for (const { backend, state, detail } of results) {
    lines.push(`  ${backend}: ${state} — ${detail}`);
  }
  const degraded = results.filter((r) => r.state === 'skipped-no-credentials').length;
  if (degraded > 0) {
    lines.push(
      `  NOTE: ${degraded} backend(s) ran the version probe only. No behavioural claim is made ` +
        'for them by this run.'
    );
  }
  const drifted = results.filter((r) => r.state === 'drifted');
  if (drifted.length > 0) {
    lines.push(
      `  FINDINGS: ${drifted.length} backend(s) drifted. File these; they are not gate failures.`
    );
  }
  return lines.join('\n');
}
