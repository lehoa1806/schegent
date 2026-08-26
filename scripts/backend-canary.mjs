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
// When the live phase does not run, this says so and says why. A canary that
// silently reports success because it did nothing is worse than one that does
// not run.
//
// IT ATTEMPTS THE THING IT REPORTS ON (2026-08-26)
//
// This took two corrections in one afternoon, and the second is the instructive
// one.
//
// FIRST, the canary decided "can we make a live call?" by testing whether
// `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `AGY_API_KEY` held a non-empty string.
// On the machine this product is developed on that is false while the truth is
// true: the CLIs authenticate by SUBSCRIPTION — `claude auth status` reports
// `authMethod: "claude.ai"`, `codex login status` reports "Logged in using
// ChatGPT" — and no API key variable exists anywhere. The canary reported
// `skipped-no-credentials` forever on a machine where a live call succeeds.
//
// SECOND, the fix for that substituted a DIFFERENT proxy: ask each CLI whether it
// is signed in, via `claude auth status`, `codex login status`, `agy models`. That
// was wrong too, and wrong the same way. `agy models` answers "Please sign in to
// view available models" — a statement about MODEL LISTING permission — while
// `agy --print` completes a turn perfectly. The probe reported a working,
// authenticated backend as unauthenticated. A false negative, one step after
// fixing a false negative.
//
// So there is no auth probe. The only non-proxy answer to "can this backend
// complete a live turn?" is to ATTEMPT A LIVE TURN and classify what came back.
// An unauthenticated CLI spends one refused call, which costs nothing because it
// fails at auth before reaching a model — and is worth far more than a verdict
// that disagrees with reality.
//
// The classifier reads OUTPUT, never exit status: `agy models` printed its
// refusal beside exit 0, and that fail-open shape is exactly what a status-keyed
// check would have swallowed.

/** What a probe can conclude. */
export const PROBE_STATES = [
  'ok',
  'drifted',
  'unavailable',
  'skipped-not-authenticated',
  'skipped-no-live-path'
];

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
      state: 'skipped-no-live-path',
      detail:
        `version ${versionProbe.version} observed; no live invocation is implemented for this ` +
        'backend, so the live phase was NOT run. This run says nothing about protocol, auth, ' +
        'prompt or cost.'
    };
  }
  if (liveProbe.ok !== true && liveProbe.notAuthenticated === true) {
    // Not a drift: the backend is fine, this machine is not signed in to it.
    return {
      state: 'skipped-not-authenticated',
      detail:
        `version ${versionProbe.version} observed; the live turn was refused because this CLI ` +
        'is not signed in. This run says nothing about protocol, auth, prompt or cost.'
    };
  }
  if (liveProbe.ok !== true) {
    return { state: 'drifted', detail: `live probe failed: ${liveProbe.detail ?? 'no detail'}` };
  }
  return { state: 'ok', detail: `version ${versionProbe.version}, live probe passed` };
}

/**
 * The runner's whole per-backend decision (FR-R3-072). Pure so it has unit
 * coverage over every runner-reachable input. It accepts raw observations only
 * -- the executed version probe and the credential env var's value -- and
 * passes no liveProbe, so `ok` is unreachable from here until a live
 * invocation exists. An empty-string credential is absent.
 */
export function runnerBackendResult({ backend, versionProbe, liveProbe, expectedVersionPrefix }) {
  return { backend, ...decideBackendState({ versionProbe, liveProbe, expectedVersionPrefix }) };
}

/**
 * Does this failed live attempt say the CLI is not signed in?
 *
 * Reads OUTPUT, never exit status. `agy models` printed its sign-in refusal
 * beside exit 0, and a status-keyed check would have read that as success — the
 * fail-open shape this round keeps closing.
 *
 * Deliberately narrow: only text that clearly says "sign in" counts. An
 * unrecognised failure becomes `drifted`, which is a finding somebody reads,
 * rather than a skip, which is a shrug. Guessing wide here would convert real
 * protocol drift into "probably just auth".
 */
export function saysNotAuthenticated(stdout, stderr) {
  const text = `${stdout ?? ''}\n${stderr ?? ''}`;
  return /please (sign|log) in|not (signed|logged) in|unauthorized|authentication (failed|required)/i.test(
    text
  );
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
  // DERIVED from the state name, not a list of them. The previous version named
  // two states literally and silently stopped counting when the states were
  // renamed on 2026-08-26 — a degraded run that reported no degradation, which is
  // the one thing this note exists to prevent.
  const degraded = results.filter((r) => String(r.state).startsWith('skipped-')).length;
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
