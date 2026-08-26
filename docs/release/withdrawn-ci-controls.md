# Withdrawn CI-dependent controls

**Date**: 2026-08-26 · **Item**: [`FR-R3-099`](../../../docs/features/round_3/99_FR-R3-099_actions_retired_by_decision.md)
**Cause**: Actions retired by operator decision, for budget. See
[the terminal record](actions-terminal-record.md).

This file records what was withdrawn and **what each thing was**, because the point of a withdrawal
record is that nobody has to reconstruct a deleted control from its absence. Nothing here is a
statement that the withdrawn control was wrong.

## Withdrawn outright

| Withdrawn | What it was | Why it went |
|---|---|---|
| `scripts/require-full-gate.mjs` | The release binding over GitHub Actions run records: it queried `full-gate.yml`'s completed runs for `github.sha` and refused a tag run when none had succeeded at that exact commit. It failed closed — an unreadable API was not evidence of a green gate. `FR-R3-095` §5 deliberately kept it *"for a process this project may adopt"* | That premise is now decided against. Its data source no longer exists and never will |
| `.github/workflows/release.yml` | The tag-triggered release job whose first step was the binding above | Same |
| `.github/workflows/full-gate.yml` | The weekly ten-job whole-tree gate the binding read | Same. Its 14 red runs are recorded in the terminal record |
| `.github/workflows/ci.yml` | Three-OS matrix plus a Node version-floor job, on push and pull request | Same. Its red Windows leg is live evidence, recorded |
| `.github/workflows/codeql.yml` | GitHub code scanning | Same. **No local substitute exists**; recorded in `SECURITY.md` |
| `.github/workflows/security-audit.yml` | Scheduled `npm audit` | The audit itself is local and stays in the attested chain; only the schedule went |
| `.github/workflows/dependency-review.yml` | Dependency-diff review on pull requests | Reduces to `npm audit`, already local |
| `.github/workflows/backend-canary.yml` | The canary's only scheduled vehicle | Replaced by a local declared cadence — [`FR-R3-104`](../../../docs/features/round_3/104_FR-R3-104_backend_qualification_that_gates.md) |
| `.github/workflows/pr.yml` | Pull-request checks | Same |
| `tests/unit/build/require-full-gate.test.ts` | Unit coverage of `decideFullGate` — the pure decision behind the binding, tested without cutting a release | Tested a function that no longer exists |
| `tests/unit/build/full-gate-parity.test.ts` | Pinned the five job names shared by `full-gate.yml` and `require-full-gate.mjs`, so a rename could not silently detach the binding from the workflow | Both sides of the parity are gone |

## Converted rather than withdrawn

Several gates asserted *"a workflow runs X"*. The invariant worth keeping was never about the
workflow — it was **that X is actually run by something**. Those gates keep the invariant and change
its subject to the attested local chain, which after this item is the only thing that runs anything:

| Gate | Was | Is now |
|---|---|---|
| `tests/unit/build/eval-gate.test.ts` | three workflows run the eval corpus | the attested chain runs the eval corpus |
| `tests/unit/build/test-typecheck-gate.test.ts` | three workflows run the complete test typecheck | the attested chain runs it |
| `tests/unit/build/visual-gate.test.ts` | every workflow uses the canonical Chromium renderer | the attested chain does |
| `tests/lint/install-flag-parity.test.ts` | the local install flags match CI's | the documented install sequence matches the local hardening |
| `tests/lint/dependency-change-scope.test.ts` | the scanner workflows exist and run their credited checks | the scanners that survive are named, and the one that did not is recorded as withdrawn |

A converted gate is stronger than the one it replaces in one specific way: it now guards the only
path a release can take. It is weaker in another, stated plainly: it observes one machine, one
platform, once.
