#!/usr/bin/env node
// FR-R3-060 (M-09 / R-13) — the release must not publish over a commit whose
// full gate never ran.
//
// `release.yml` runs `verify:all`, build, package smoke and integration at the
// tag. The complete eval / e2e / perf / visual / full-coverage gate lives in
// `full-gate.yml`, which runs weekly and on demand, and RELEASE.md said outright:
// "The release workflow does not query that workflow's status, so confirming it
// is a maintainer action." So a tag could publish with signed provenance over an
// artifact whose full gate ran on a different commit, or not at all.
//
// This queries the completed runs of `full-gate.yml` for the EXACT release SHA
// and fails with a message naming the missing evidence when there is none.
//
// The decision is a pure function over the API response so it can be tested
// without a network or a live repository -- see
// `tests/unit/build/require-full-gate.test.ts`. A release gate that could only
// be exercised by cutting a release is a gate nobody exercises.

/** The workflow whose green run at this SHA is the evidence being required. */
// FR-R3-087 — the known limit FR-R3-074 recorded here is CLOSED.
//
// It read: "this binding accepts the RUN-level conclusion. GitHub reports a run
// 'success' even when a job was skipped, so a future job-level `if:`/`needs:` in
// full-gate.yml could skip a named check while this gate stays green."
//
// The binding is now two narrower gates in series, and both must pass:
//
//   1. `decideFullGate` — a run at the exact release SHA that is `completed`
//      AND `success`. Unchanged, still first, still cheap. A success on another
//      commit is still not evidence.
//   2. `decideJobCoverage` — every job in REQUIRED_JOB_NAMES `completed` with
//      conclusion `success`. A skipped, cancelled, failed or absent job fails
//      the binding, and the message names which.
//
// The second is a second, narrower gate — not a replacement. The run-level
// filter is correct as far as it goes.
export const FULL_GATE_WORKFLOW = 'full-gate.yml';

/**
 * FR-R3-087 — the jobs the release depends on, by their `name:` in
 * `full-gate.yml`.
 *
 * ONE AUTHORITY, CHECKED FROM BOTH ENDS. `tests/unit/build/full-gate-parity.test.ts`
 * asserts that every npm target in its RELEASE_CHECK_TARGETS map is executed by
 * a step inside a job this list names, and that every entry here resolves to a
 * job in the workflow while every workflow job NOT listed carries an explicit
 * `# release-binding: optional` marker with a reason. Two lists that happen to
 * agree is the duplicate-authority shape FR-R3-066 exists to remove; this makes
 * them one list, checked from both directions.
 *
 * No count is transcribed anywhere. A number stated once and not re-derived is
 * the smallest version of what this whole round was about.
 */
export const REQUIRED_JOB_NAMES = Object.freeze([
  'typecheck (host)',
  'typecheck (webview)',
  'typecheck (tests)',
  'lint',
  'unit tests',
  'perf budgets',
  'build',
  'browser visual regression',
  'deterministic E2E smoke (feature 055)',
  'extension-host integration smoke',
  'sustained evidence soak',
  // FR-R3-090 — the documented install, proven from a clean checkout.
  'clean install parity'
]);

/**
 * Decide from a `GET /actions/workflows/{id}/runs` payload.
 *
 * A run counts only when it is `completed` AND `success` AND its `head_sha` is
 * the release commit. Every one of those three matters: `in_progress` is not
 * evidence, a `failure` is anti-evidence, and a success on another commit is the
 * exact confusion this gate exists to remove.
 */
export function decideFullGate(payload, sha) {
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
  const atSha = runs.filter((run) => run?.head_sha === sha);
  const green = atSha.filter(
    (run) => run?.status === 'completed' && run?.conclusion === 'success'
  );
  if (green.length > 0) {
    return {
      ok: true,
      // FR-R3-087 — the run id is returned so stage 2 can query that exact
      // run's jobs. Stage 1 chose the run; stage 2 must not choose a different one.
      //
      // Coerced to a NUMBER here, at the boundary, because it is interpolated
      // into a URL path in `main()`. The value comes from an API response, which
      // is a trusted source over TLS with our own token — but "trusted today"
      // is not a property the code carries, and a non-numeric id would build a
      // request for a path nobody chose. One coercion is cheaper than the
      // argument about whether it is needed.
      runId: Number(green[0].id),
      message:
        `run-level gate satisfied at ${sha}: run ${green[0].id} ` +
        `(${green[0].html_url ?? 'no url'}) — now checking its jobs`
    };
  }
  const seen = atSha
    .map((run) => `${run?.status ?? 'unknown'}/${run?.conclusion ?? 'none'}`)
    .join(', ');
  return {
    ok: false,
    message:
      `no successful ${FULL_GATE_WORKFLOW} run for commit ${sha}. ` +
      (atSha.length === 0
        ? 'No run of that workflow exists for this commit at all. ' +
          'Dispatch it on this exact commit and wait for green before tagging.'
        : `Runs found at this commit: ${seen}. None completed successfully.`)
  };
}

/**
 * FR-R3-087 — decide from a `GET /actions/runs/{id}/jobs` payload.
 *
 * Three DISJOINT buckets, because an absent check and a red check are different
 * findings and a refusal that conflates them sends someone to read a workflow
 * instead of fixing a job:
 *
 *   missing — a required name absent from the exhausted payload. The check did
 *             not exist.
 *   skipped — present with conclusion `skipped`/`cancelled`, or not `completed`.
 *             The check existed and did not run. This is the case the whole item
 *             is about: GitHub still reports the RUN as `success`.
 *   failed  — `completed` with a conclusion that is neither `success` nor
 *             `skipped`. The check ran and was red.
 *
 * Pure over the payload so it is testable without a network or a live
 * repository — a release gate that could only be exercised by cutting a release
 * is a gate nobody exercises.
 */
export function decideJobCoverage(payload) {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
  const byName = new Map();
  for (const job of jobs) {
    if (typeof job?.name === 'string') byName.set(job.name, job);
  }

  const missing = [];
  const failed = [];
  const skipped = [];
  for (const name of REQUIRED_JOB_NAMES) {
    const job = byName.get(name);
    if (job === undefined) {
      missing.push(name);
      continue;
    }
    if (job.status !== 'completed') {
      skipped.push(name);
      continue;
    }
    if (job.conclusion === 'success') continue;
    if (job.conclusion === 'skipped' || job.conclusion === 'cancelled') {
      skipped.push(name);
      continue;
    }
    failed.push(name);
  }

  if (missing.length === 0 && failed.length === 0 && skipped.length === 0) {
    return { ok: true, message: `all ${REQUIRED_JOB_NAMES.length} required jobs completed successfully` };
  }

  const parts = [];
  if (skipped.push === undefined) throw new Error('unreachable');
  if (skipped.length > 0) parts.push(`did not run: ${skipped.join(', ')}`);
  if (failed.length > 0) parts.push(`failed: ${failed.join(', ')}`);
  if (missing.length > 0) parts.push(`absent from the run entirely: ${missing.join(', ')}`);
  return {
    ok: false,
    missing,
    failed,
    skipped,
    message:
      'the run reports success but its jobs do not satisfy the release binding — ' +
      parts.join('; ') +
      '. A job skipped by an `if:` does not make a run red, which is why this ' +
      'binding reads the jobs and not the run summary.'
  };
}

/**
 * Read every page of the jobs endpoint.
 *
 * Pagination is exhausted BEFORE absence is concluded: a required name missing
 * from page 1 of a two-page payload is not an absent job, it is an unread page,
 * and reporting it as absent would send someone to look for a job that ran.
 */
async function fetchAllJobs(repo, runId, headers) {
  const jobs = [];
  let page = 1;
  let total = null;
  for (;;) {
    const url =
      `https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs` +
      `?per_page=100&page=${page}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`could not read jobs for run ${runId} (HTTP ${response.status})`);
    }
    const payload = await response.json();
    const pageJobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    jobs.push(...pageJobs);
    if (total === null && typeof payload?.total_count === 'number') total = payload.total_count;
    if (pageJobs.length === 0) break;
    if (total !== null && jobs.length >= total) break;
    page += 1;
    if (page > 50) break; // a runaway backstop, far above any real job count
  }
  return { jobs };
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.RELEASE_SHA;
  const token = process.env.GH_TOKEN;
  if (!repo || !sha) {
    console.error('require-full-gate: GITHUB_REPOSITORY and RELEASE_SHA are required');
    process.exit(2);
  }
  const url =
    `https://api.github.com/repos/${repo}/actions/workflows/${FULL_GATE_WORKFLOW}` +
    `/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`;
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {})
  };
  const response = await fetch(url, { headers });
  if (!response.ok) {
    // Fail closed. An unreadable API is not evidence of a green gate, and
    // treating it as one is how a release gate becomes decorative.
    console.error(
      `require-full-gate: could not read workflow runs (HTTP ${response.status}). ` +
        'Refusing to release without evidence.'
    );
    process.exit(1);
  }
  const verdict = decideFullGate(await response.json(), sha);
  if (!verdict.ok) {
    console.error(`require-full-gate: ${verdict.message}`);
    process.exit(1);
  }
  console.log(`require-full-gate: ${verdict.message}`);

  // Stage 2 — the per-job query. Same fail-closed rule as stage 1: an
  // unanswerable check is a refusal, not a pass.
  if (!Number.isSafeInteger(verdict.runId) || verdict.runId <= 0) {
    // Fail closed, like every other unanswerable step here: a run whose id the
    // API did not report as a positive integer is a run this gate cannot query.
    console.error(
      'require-full-gate: the run-level match carried no usable run id. ' +
        'Refusing to release without per-job evidence.'
    );
    process.exit(1);
  }
  let jobsPayload;
  try {
    jobsPayload = await fetchAllJobs(repo, verdict.runId, headers);
  } catch (error) {
    console.error(
      `require-full-gate: ${error instanceof Error ? error.message : 'jobs query failed'}. ` +
        'Refusing to release without evidence.'
    );
    process.exit(1);
  }
  const coverage = decideJobCoverage(jobsPayload);
  console.log(`require-full-gate: ${coverage.message}`);
  process.exit(coverage.ok ? 0 : 1);
}

// Only run when invoked directly, so the pure decision above stays importable.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
