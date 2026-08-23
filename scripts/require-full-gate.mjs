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
export const FULL_GATE_WORKFLOW = 'full-gate.yml';

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
      message:
        `full gate satisfied at ${sha}: run ${green[0].id} ` +
        `(${green[0].html_url ?? 'no url'})`
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
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    }
  });
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
  console.log(`require-full-gate: ${verdict.message}`);
  process.exit(verdict.ok ? 0 : 1);
}

// Only run when invoked directly, so the pure decision above stays importable.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
