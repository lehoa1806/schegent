# Contract: The release binding's per-job requirement

**Consumer**: `.github/workflows/release.yml` (via `scripts/require-full-gate.mjs`)
**Producer**: the GitHub Actions REST API
**Source item**: FR-R3-087 · **Spec**: FR-001…FR-006

## The two-stage decision

The binding is two narrower gates in series, not one replaced by another.

```
stage 1  decideFullGate(runsPayload, sha)      -> { ok, runId } | { ok: false, message }
stage 2  decideJobCoverage(jobsPayload)        -> { ok } | { ok: false, missing, failed, skipped }
```

Stage 1 is unchanged and stays first: it is cheap, it is correct as far as it goes, and a success on
another commit is still not evidence. Stage 2 runs only against a run stage 1 accepted.

## Inputs

**Stage 1** — `GET /repos/{repo}/actions/workflows/full-gate.yml/runs?head_sha={sha}&per_page=100`

**Stage 2** — `GET /repos/{repo}/actions/runs/{run_id}/jobs?per_page=100&page={n}`

```jsonc
{
  "total_count": 11,
  "jobs": [
    { "id": 1, "name": "lint", "status": "completed", "conclusion": "success" },
    { "id": 2, "name": "perf budgets", "status": "completed", "conclusion": "skipped" }
  ]
}
```

**Pagination is exhausted before absence is concluded.** A required name missing from page 1 of a
two-page payload is not an absent job; it is an unread page. The loop stops when the accumulated job
count reaches `total_count` or a page returns none.

## The required list

`REQUIRED_JOB_NAMES` is exported from `scripts/require-full-gate.mjs` and holds the `name:` of every job
in `full-gate.yml` whose result the release depends on:

```
typecheck (host) · typecheck (webview) · typecheck (tests) · lint · unit tests · perf budgets ·
build · browser visual regression · deterministic E2E smoke (feature 055) ·
extension-host integration smoke · sustained evidence soak
```

**One authority.** `tests/unit/build/full-gate-parity.test.ts` asserts that every npm target in its
`RELEASE_CHECK_TARGETS` map is executed by a step inside a job this list names. Two lists that agree by
coincidence is the duplicate-authority shape FR-R3-066 exists to remove; this makes them one list
checked from both ends.

## Verdict classification

| Job state | Bucket | Rationale |
|---|---|---|
| absent from the exhausted payload | `missing` | The check did not exist. An **absent** finding. |
| `conclusion: "skipped"` or `"cancelled"` | `skipped` | The check existed and did not run. |
| `status !== "completed"` | `skipped` | Not finished is not evidence. |
| `completed` + `conclusion !== "success"` | `failed` | The check ran and was red. |
| `completed` + `conclusion === "success"` | — | Satisfied. |

The three buckets are disjoint. The failure message names every entry in each non-empty bucket.

## Failure behaviour

- **Any non-empty bucket** → refuse, naming the jobs.
- **Jobs API unreachable, non-2xx, or unparseable** → refuse. An unanswerable check is a refusal, not a
  pass — the same rule `pre-push` applies to the audit baseline guard.
- Exit code 1 with the message on stderr, matching stage 1's existing shape.

## Non-vacuity

Both directions are fixtures, and the pair is the proof:

1. run-level `success` + `perf budgets` `skipped` → **refuses**, message contains `perf budgets`.
2. the same payload with `perf budgets` `success` → **passes**.
3. `perf budgets` absent entirely → refuses with a message distinguishable from (1).
4. stage-1 behaviour unchanged: a green run at a different SHA still refuses.
