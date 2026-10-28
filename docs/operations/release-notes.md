# Operator-visible release notes

This file is the release workflow's stable pointer for changes that affect operators. It is maintained manually: neither the version field nor the release job can determine which source changes are operator-visible.
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: package.json -->

## Unreleased — operator-visible changes awaiting the first release

Recorded as they land, so the first release note is assembled from evidence rather than
from memory.

### A failed run records its cause and says what to do next (FR-R4-F14, 2026-10-28)

A run that failed at its iteration cap told the operator to run "Schegent: Resume" to retry,
and a resume gave the phase one more attempt that failed the same way. Every failed run now carries
one cause from a closed list of nine, and each failure shows a notice built for that cause.

- The cause is on the failed run, on its `task-execution-ended` audit event and on its metrics rollup
  record. The rollup record is now version 2; version 1 records are still read, and cumulative totals are
  unchanged. A run that failed before this change reads as "Cause not recorded".
- The notices say what stopped and which action is worth taking, by its exact title. A cap failure says
  that "Schegent: Resume Paused or Failed Workflow" gives the phase one more attempt and that it fails the
  same way unless the blocker is resolved first, and names "Mark '…' as completed" for work finished by
  hand. A last-phase failure says to fix the open issues first. No notice offers a button that does not
  exist, and none carries agent output.
- History's run detail shows a failed run's cause as `{label} ({code})`.
- The `schegent.loop.maxIterations` description and the settings reference now say it bounds every phase
  that has a retry condition, and that the run fails at the cap unless the phase or
  `schegent.retry.forceContinueOnCap` says to continue. No behavior changed.
- The metadata-only audit export carries `failureCause`, value-checked against the nine codes.
- The new cause table, and how Resume, Retry and Restart differ, are in
  [When a run fails: its cause and what to do next](retry-contract.md#when-a-run-fails-its-cause-and-what-to-do-next).

### The shipped new-feature pipeline decides, sets aside or reports instead of asking (version 3, 2026-10-28)

An unattended run has nobody to answer a question, and runs of this pipeline have stopped
on one. `speckit-implement` reported a task as needing a maintainer decision, went on
counting it in `pending_tasks`, and re-ran to its iteration cap. `finalize` left failing
dependency-audit checks alone because a lockfile bump was "outside this task" and "needs
your approval". `examples/speckit-new-feature.pipeline.yaml` is now version 3, and both
Phases say what they may settle alone, what they must set aside and what they must report.

- `speckit-implement` ranks the sources it settles a conflict by and records each decision
  in `<feature_dir>/decisions.md`. A task only a maintainer can answer is set aside as
  *blocked* (`Status: needs-maintainer`); a task only a person can finish is a *hand-off*.
  Neither counts toward `pending_tasks`. The Phase gains the metrics `blocked_tasks` and
  `user_run_tasks`, and its loop condition is still `pending_tasks > 0`.
- A task is a hand-off in three cases and no other: its own line carries the `USER-RUN`
  marker (outside inline code); its own line names a person's approval as the condition; or
  every other step is done and the only one left is pushing, opening or merging a pull
  request, watching CI or deploying outside the repository. A task with any implementation
  still undone stays pending, so difficulty, size and a failing test never make a hand-off.
  `speckit-implement` lists each open hand-off with its basis under
  `Hand-off tasks (for the user):`, outside `Remaining issues:`, and reports CLEAR when only
  hand-offs remain.
- `speckit-tasks` now writes the label `[USER-RUN]`, and only on work that needs a person:
  pushing, opening or merging a pull request, watching CI, deploying outside the repository,
  an explicit approval, or work that cannot start until one of those has happened. It splits
  a line that mixes headless work with a person's step, marks only the tasks the skill wrote
  and adds none of its own. `speckit-implement` never adds, removes or edits a marker.
- `finalize` may fix a failing dependency-audit check without asking: a patch or minor bump
  of at most three packages, whose advisory is in a dependency the feature did not change,
  in a `fix(deps)` commit of its own that is reverted if it turns a green check red. A major
  bump, a forced update, an overrides entry and any change to an audit's threshold or
  ignore list stay outside that authority. It merges to `develop` only when every check is
  green and no decision waits on a maintainer.

<!-- Source: examples/speckit-new-feature.pipeline.yaml -->

**Who is affected**: anyone who runs the shipped pipeline, and whoever maintains a catalog
that holds an earlier copy of it.

**What you may need to do**: nothing for a fresh install. A catalog that already holds
`speckit-tasks`, `speckit-implement`, `finalize` or the pipeline `speckit-new-feature` keeps
its copy, because an import never overwrites an existing id (`FR-024`): save a draft of each
changed definition with the new text and publish it. "Bring an existing catalog to a revised
example" in `docs/operations/process-yaml.md` gives the steps, and says what happens to items
already queued and to Runs already started.

**What happens to Runs you already have**: nothing. A Run keeps the pipeline snapshot it
was created with.

**What you gain, and what you do not**: a blocked task or an out-of-authority advisory no
longer loops the Phase to its cap or waits for an approval nobody can give. The Phase
reports it, and the Run ends at its last Phase with `Remaining issues:` listing what a
maintainer must decide. This reduces the risk of a stalled run; it does not remove it. The
authority is prose the backend follows, and the host does not enforce it.

### A window that loses the primacy election keeps contesting (`FR-032`, 2026-09-12)

Exactly one VS Code window per workspace drives Runs. That window used to be chosen once,
at activation, and a window that lost stayed passive for the rest of its life. When the
window holding primacy exited *without* releasing its lease — a crash, a force quit, a
machine suspended — the record it left behind still reads as live for fifteen seconds, so
a replacement window opened inside that span lost the election correctly and then never
asked again. The reported instance sat for 6h28m with persisted Runs untouched, and the
only recovery was restarting VS Code. A window now contests on every heartbeat until it
wins, and installs its recovery producers at the moment it wins rather than only at
activation.

**Who is affected**: anyone who opens more than one VS Code window on the same workspace,
and anyone whose primary window has ever exited uncleanly.

**What you may need to do**: nothing.

**The accepted consequence — closing the primary window hands the workspace to the
survivor.** With two windows open on one workspace, the second begins driving persisted
Runs within roughly 15–20 seconds of the first ceasing to beat: the fifteen-second
staleness threshold, rounded up to the next five-second heartbeat. This is the intended
behaviour rather than a side effect of the fix. The alternative considered was to contest
only while a Run is pending, and it was rejected because it makes takeover depend on state
the losing window cannot see. Operator decision, 2026-09-12: always contest. There is no
setting that pins a window as non-driving — primacy is a property of the workspace lease,
not a per-window rank.

**What happens to Runs you already have**: nothing changes on disk, and a takeover cannot
double-drive a Run. The resume path claims the queue's execution lease before it marks
anything in flight (`FR-R3-070`), so a window that gains primacy while another is still
executing declines rather than spawning a second process.

**What you gain**: a crashed or force-quit host no longer strands every persisted Run on
that workspace until somebody notices and restarts VS Code.

### BREAKING — a Phase is judged on its exit status by default (`FR-R3-117`, 2026-08-27)

A Phase that declares nothing used to advance on the model's own report of its work. It
is now judged on its process's exit status, and a clean termination token cannot
override a non-zero exit or a timeout.

**Who is affected**: any Phase whose `sideEffects` is other than `none` — and because
`sideEffects` resolves to `workspace` when omitted, that is most Phases. A Phase
declaring `sideEffects: none` is unchanged.

**What you may need to do**: a Phase that legitimately exits non-zero (a linter used as
a probe, a diff check) now stops the Run. Add `hostVerification: model-token` to that
Phase's spec to keep the old behaviour. Nothing else is required.

**What happens to Runs you already have**: nothing. Persisted plan snapshots are
migrated (state schema 13 → 14) carrying the verdict basis they were frozen under, so
an existing Run keeps the meaning it was approved with.

**What you gain**: a failed build, a failed test run or a crashed tool can no longer
report success, and every completed Run's evidence names which basis judged each Phase
(`phase-end.verdictBasis`).

**Shipped documents affected, swept rather than left to discovery**: both example
pipelines — `examples/speckit-new-feature.pipeline.yaml` (nine Phases; six make a
verifiable claim) and `examples/speckit-bugfix.pipeline.yaml` (five Phases) — now write
`hostVerification: exit-code` out explicitly. They would resolve to it anyway; an
example is what an operator copies, so it should say what judges each Phase rather than
let it be inherited invisibly. `examples/model-catalog.yaml` declares no Phases and is
unaffected. No other pipeline or phase document ships in the tree.

Full reasoning: [`docs/architecture/phase-verdict-default.md`](../architecture/phase-verdict-default.md).

## First release pending — 2026-08-26

**No release has shipped, and this is a dated statement rather than an empty section**
(`FR-R3-101`, FR-030). `release.yml` never ran: no `v*` tag was ever pushed, and the workflow
itself was deleted on 2026-08-26 when Actions were retired by operator decision
([terminal record](../release/actions-terminal-record.md)). So there are no operator-visible
changes to record because there has been no version for an operator to be visible to.

**Owner**: the repository operator, who is the only party who can cut a release.

**What must happen before the first entry exists**: a release goes out through the local path —
`npm run gate:record` then `npm run release`, which refuses unless a recorded gate PASS names
`HEAD` over a clean tree ([`RELEASE.md` §2a](../../RELEASE.md)). At that point this section is
replaced by a `## v<version>` heading with evidence-backed additions, changes, fixes, removals,
migration effects and security notes.

**Two limits worth stating now rather than discovering at release time**: the local path emits
**no SBOM and no attestation** — those were `release.yml`'s, and they went with it; and
verification is single-platform, single-machine, permanently, since the three-OS matrix is gone.

## Unreleased

Nothing yet. When adding the first entry, name the affected command, setting, workflow, state
transition or persisted artifact exactly as it appears in the product, and state upgrade or
rollback limits explicitly. Do not infer a historical change list from the current code snapshot
alone.

For each entry, name the affected command, setting, workflow, state transition, or persisted artifact exactly as it appears in the product. State upgrade or rollback limits explicitly. Do not infer a historical change list from the current code snapshot alone.
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: src/contracts/state-schema.ts -->
