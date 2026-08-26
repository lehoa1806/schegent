# Observe the merge gates

> **Withdrawn, 2026-08-26.** The controls this runbook observes are gone: GitHub
> Actions were retired by operator decision, for budget, and all eight workflow files
> were deleted (`FR-R3-099`). This page is kept as a **dated historical record** of
> how those controls were observed while they ran — the observations were true when
> made and are not rewritten here — but every procedure below is now inert. What the
> workflows actually produced over fourteen weeks is read once in
> [the terminal record](../release/actions-terminal-record.md); what each withdrawn
> control was is recorded in
> [withdrawn CI controls](../release/withdrawn-ci-controls.md).

This runbook separates three questions that are easy to collapse into one:

1. Does the checked-in workflow declare a trigger for the integration branch?
2. Did GitHub actually run that workflow for the commit or pull request?
3. Does the remote repository require the resulting check before merge?

The source tree can establish the first question and provides local equivalents
for much of the work. Only evidence from the remote repository can establish
the second and third.
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: CONTRIBUTING.md -->

## Current trigger surface

The integration target named by every branch-filtered workflow is `develop`.
The four workflows relevant to pull-request observation are:

| Workflow | Pull-request trigger | Other trigger | Reported job names |
|---|---|---|---|
| `PR` | opened, synchronized, reopened, or made ready for review against `develop` | none | `validate (ubuntu-latest)`, `validate (macos-latest)`, `validate (windows-latest)` |
| `CI` | pull request against `develop` | push to `develop`; manual dispatch | `full CI (<os>)` on three operating systems and `cross-major (node 22 floor, ubuntu)` |
| `CodeQL` | pull request against `develop` | push to `develop`; weekly schedule; manual dispatch | `analyze (javascript-typescript)` |
| `Dependency review` | opened, synchronized, reopened, or made ready for review against `develop` | none | `dependency-review` |

<!-- Source: ../release/actions-terminal-record.md -->

The `PR` matrix installs both dependency trees without lifecycle scripts, then
runs the test typecheck, `verify:all`, deterministic evaluations, the build,
Linux-only visual regression, and VSIX package smoke. The `CI` matrix adds
Linux coverage, E2E, performance, and extension-host integration; it also has a
separate Ubuntu/Node 22 job that runs the test typecheck and `verify:all`.
<!-- Source: ../release/actions-terminal-record.md -->

Dependency review evaluates pull-request dependency changes at a `high`
severity floor and comments on failure. CodeQL runs the
`javascript-typescript` language pack with `security-extended` queries. Its
workflow records that findings surface for triage and do not fail the build by
default, so a completed CodeQL job is not evidence that every finding was
resolved.
<!-- Source: ../release/actions-terminal-record.md -->

`Full gate` and `Security audit` are scheduled/manual workflows, not
pull-request triggers. The release workflow is tag/manual driven. Their absence
from a pull request is therefore not a missing merge-trigger observation.
<!-- Source: ../release/actions-terminal-record.md -->

## Verify the checked-in definitions locally

Run the focused workflow-trigger test first:

```bash
npx vitest run tests/lint/workflow-trigger-branches.test.ts
```

It enumerates every workflow file, expects the exact current number of branch
filters per file, resolves positive `branches:` entries against local Git refs,
and requires every workflow to have an event that can fire without manual
dispatch. It deliberately does not interpret tag filters, `branches-ignore`,
or remote branch-protection settings.
<!-- Source: tests/lint/workflow-trigger-branches.test.ts -->

If Git metadata or workflow files are unavailable, the ref-resolution cases
skip with a stated reason. Treat that outcome as “not observed,” not as a green
trigger check. In a normal checkout, failures name the workflow, trigger,
branch or unmatched pattern, and source line.
<!-- Source: tests/lint/workflow-trigger-branches.test.ts -->

For a review-sized local preflight, run:

```bash
npm run ci:fast
```

The manifest currently composes this from test typechecking, lint,
`verify:all`, evaluations, visual and performance tests, a host build, and
package smoke. A unit guard compares the recursive `ci` and `ci:fast` script
graphs so a normal CI gate cannot silently become unreachable from the local
preflight without an explicit tested exclusion.
<!-- Source: package.json -->
<!-- Source: tests/unit/build/preflight-coverage.test.ts -->

For the broad local path, run both commands below. `verify:all` includes policy,
type, lint, host-test, and covered-webview checks; `ci` exercises the broader
build, test, package, E2E, performance, and extension-host path. The two scripts
are composed differently, so neither command is a substitute for the other on
a release-sized change.

```bash
npm run verify:all
npm run ci
```

<!-- Source: package.json -->
<!-- Source: tests/integration/ci-gate.host.test.ts -->

Local success establishes only that the checked-out code passes those commands.
It does not demonstrate that GitHub received an event, selected the intended
workflow revision, ran every matrix leg, or enforced any result at merge time.
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: CONTRIBUTING.md -->

## Observe one pull request

Use a pull request whose base branch is `develop` and record its head commit
SHA. After an `opened`, `synchronize`, `reopened`, or `ready_for_review` event,
inspect the remote run list for that exact SHA and record, for each workflow:

| Evidence to record | Acceptance condition |
|---|---|
| `PR` run URL or identifier | One run for the pull-request event; all three `validate` operating-system legs reached a terminal result. |
| `CI` run URL or identifier | One pull-request run; all three `full CI` legs and the Node 22 `cross-major` leg reached a terminal result. |
| `CodeQL` run URL or identifier | One pull-request run with the `javascript-typescript` analysis leg accounted for. |
| `Dependency review` run URL or identifier | One pull-request run with the `dependency-review` job accounted for. |

<!-- Source: ../release/actions-terminal-record.md -->

Match by commit SHA and event, not merely by workflow display name. Both `CI`
and `CodeQL` also run on pushes to `develop`, and CodeQL has scheduled/manual
runs; a nearby successful run from another event does not observe the pull
request path.
<!-- Source: ../release/actions-terminal-record.md -->

The workflows cancel superseded pull-request work through their concurrency
settings. A canceled older SHA is expected after a new synchronization, but it
does not qualify the new head SHA; wait for and record the replacement runs.
<!-- Source: ../release/actions-terminal-record.md -->

After merge, separately observe the merge commit on `develop`. `CI` and
`CodeQL` declare push triggers for that branch; `PR` and `Dependency review` do
not. Record the push-run identifiers and the merge SHA rather than carrying the
pull-request run forward as push evidence.
<!-- Source: ../release/actions-terminal-record.md -->

## Confirm enforcement separately

The repository contains workflow definitions but no checked-in
branch-protection or repository-ruleset file. Consequently, a green workflow
run proves that a check reported; it does not prove that the remote blocks a
merge when that check is missing, pending, canceled, or failed.
<!-- Source: CONTRIBUTING.md -->

Inspect the remote protection or ruleset applying to `develop` and record:

- the rule or ruleset identifier;
- whether pull requests and status checks are required;
- the exact required check contexts;
- whether the rule applies to administrators or has bypass actors;
- the time and commit SHA against which the observation was made.

Compare the required contexts with the actual job/check names from the current
workflow runs. Workflow and job renames can change those contexts even when the
underlying commands are unchanged.
<!-- Source: ../release/actions-terminal-record.md -->

Use precise conclusions in the observation record:

- **declared** — the checked-in trigger names `develop`;
- **observed** — a remote run for the intended event and SHA is recorded;
- **passing** — every expected job reached a successful result;
- **enforced** — a remote protection/ruleset observation proves the check is
  required for merge.

Do not promote one conclusion into another without its corresponding evidence.
<!-- Source: tests/lint/workflow-trigger-branches.test.ts -->
<!-- Source: CONTRIBUTING.md -->
