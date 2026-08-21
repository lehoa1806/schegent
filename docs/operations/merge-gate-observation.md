# Merge-gate observation record

**Status**: procedure recorded, observation **outstanding**
**Opened**: 2026-08-21
**Source finding**: `OPS-N1` (High likelihood / High impact)

## What happened

Four merge-blocking workflows filtered their `push` and `pull_request`
triggers on `branches: [main]`. Neither repository has a `main` branch —
`develop` is the integration branch and the default in both.

A GitHub workflow whose branch filter matches nothing does not fail and
does not report a skipped run. It produces no check at all, which on a
pull request is visually indistinguishable from a check that passed. The
four affected workflows were:

| Workflow | What it gates |
|---|---|
| `ci.yml` | full CI across the three-OS matrix |
| `pr.yml` | the PR validation matrix |
| `codeql.yml` | CodeQL static analysis (PR and push paths) |
| `dependency-review.yml` | dependency diff review on pull requests |

Thirty-eight merges landed on `develop` with none of the four running on
any of them. Two defects reached `develop` through the gap, and one was
itself a recurrence of an earlier finding that the gate would have caught
the second time.

`codeql.yml`'s weekly `schedule` trigger carries no branch filter and did
continue to run. `full-gate.yml` and `security-audit.yml` (cron) and
`release.yml` (tag push) were never affected.

## What was changed

Six `branches:` entries across the four files now name `develop`. No
`uses:`, `permissions:`, `concurrency:`, job, or step line changed, and no
npm script or dependency was added.

The durable half is
[`tests/lint/workflow-trigger-branches.test.ts`](../../tests/lint/workflow-trigger-branches.test.ts).
It resolves every branch entry in every workflow against the repository's
refs and fails the build when one resolves to nothing, and it fails when a
workflow is reachable by no event that can fire on its own. It runs inside
`npm run test:host`, so it is already in `npm run test`, `verify:all`, and
`ci:fast` — there is no separate command to remember.

The gate asserts a weaker property than GitHub's filter evaluation: that
every branch a trigger *names* exists. That is deliberate. It cannot admit
a name that exists nowhere in the repository, which is the failure mode
above, and it cannot produce a false alarm for a name that does exist.

## Observation procedure — outstanding

The fix cannot be confirmed from the tree. A workflow trigger is only
observed working when GitHub runs it, which requires the retarget to reach
the remote. That is an outward action outside the authority of the cycle
that made the change, so the conclusions below are recorded as
**outstanding by decision** rather than left implied or filled in on
assumption.

Once the retarget is on the remote `develop`, an operator should confirm
each cell and fill in the run identifiers:

| Workflow | Event to exercise | Run observed | Conclusion |
|---|---|---|---|
| `ci.yml` | push to `develop` | _(unfilled)_ | _(unfilled)_ |
| `ci.yml` | pull request targeting `develop` | _(unfilled)_ | _(unfilled)_ |
| `pr.yml` | pull request targeting `develop` | _(unfilled)_ | _(unfilled)_ |
| `codeql.yml` | push to `develop` | _(unfilled)_ | _(unfilled)_ |
| `codeql.yml` | pull request targeting `develop` | _(unfilled)_ | _(unfilled)_ |
| `dependency-review.yml` | pull request targeting `develop` | _(unfilled)_ | _(unfilled)_ |

Two events, four workflows, six trigger paths — the same six entries the
gate reported before the retarget.

Expect the first real runs to surface failures. Four gates that have not
executed for 38 merges are measuring a tree they have never seen. A
failure there is a **new finding**, not a regression of this change: the
gate reporting is the outcome being sought.

## One consequence worth knowing before the first run

The four workflows were inert. They are now live, and three of them fire on
`pull_request` — including pull requests from forks. That was always their
declared intent, and nothing about the permission posture changed: all four
keep `permissions: contents: read`, none uses `pull_request_target`, and none
references a secret in its trigger block. But "these workflows have never
executed against an outside contribution" is true today and stops being true
with the first fork PR. Review the first one rather than merging on a green
check alone.

## Follow-up that does not live in this tree

Retargeting makes the four workflows *run*. It does not make them
*required*. Branch protection and required-status-check configuration are
repository settings, not file contents, and no test in this repository can
assert them. An operator must:

1. Confirm branch protection on `develop` (there is no `main` to protect).
2. Add the four workflows' check names to the required set, so a red check
   blocks the merge rather than merely reporting.
3. Re-check the required set after any workflow rename — a required check
   whose name no longer exists blocks every merge, the opposite failure of
   the one recorded here.

Until step 2 is done, the gates report but do not block, and the honest
description of the state is "observed, not enforced".

## Related

- [CONTRIBUTING.md](../../CONTRIBUTING.md) — the branch model and the
  recorded Option B alternative.
- [workflow-runs.md](workflow-runs.md) — reading workflow run state.
