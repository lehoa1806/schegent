# Operator-visible release notes

This file is the release workflow's stable pointer for changes that affect operators. It is maintained manually: neither the version field nor the release job can determine which source changes are operator-visible.
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: package.json -->

## Unreleased — operator-visible changes awaiting the first release

Recorded as they land, so the first release note is assembled from evidence rather than
from memory.

### Skip is refused on a failed run, and the refusal is shown (FR-R4-F20, 2026-10-29)

If a run failed while Skip's confirmation was open, confirming revived the run: its failed task went
back to running, which lifted its queue's halt, and no operator had chosen that. Skip of a failed run
is now refused as `run-failed`. Nothing about the run, its task or the queue changes, and the queue
stays halted on the failed task. The exits for a failed task are Retry, Mark completed and Remove.

- A Skip names the run the operator confirmed. If the queue holds another run by the time the message
  arrives, it is refused as `no-run-in-flight` instead of being applied to the new run, and a Skip
  message without a run id is refused at the boundary.
- On a failed task's view, the disabled Skip control says why, in the sentence its refusal uses: "A
  failed task cannot be skipped: retry it, mark it completed, or remove it." A refused Skip now shows
  its reason beside the control, as Pause, Resume and Restart do.
- If the run fails after the Skip was applied, the Skip is still reported accepted: the skipped phase
  stays skipped, and nothing is revived, resumed or scheduled. Retry resumes the run with that override
  in force.
- Skip of a running or paused phase is unchanged.
- No setting, event, status, field or schema version changed, and there is no migration.

### Finalize commits only the feature's paths, and a new `integrate` Phase moves target branches without touching a checkout (FR-R4-F19, 2026-10-29)

The shipped `finalize` committed everything in the checkout, so another feature's half-done work went
into this feature's commit, and it merged by switching to `develop` in a checkout that other sessions
share. Finalization is now two Phases. `finalize` verifies, repairs and commits only this feature's
paths, in each repository a workspace declares. A new last Phase, `integrate`, merges the committed
work into each repository's target branch without switching, checking out or otherwise touching any
checkout, and reports how far it got.

- A changed path is owned, unrelated or ambiguous. An ambiguous path (claimed by two features, partially
  staged, a file that mixes changes, a rename with one side not owned, or claimed by none) is a
  `[needs-decision]` hand-off: never committed, and it withholds integration in every repository. That
  a path changed never makes it owned.
- `integrate` computes each merge with `git merge-tree --write-tree` (Git 2.38 or later), writes it
  with `git commit-tree`, and moves the target ref only by `git update-ref` with the old value, so a
  target that moved is not overwritten. It refuses, before any ref moves, a detached `HEAD`, a target
  that is not a local branch, a target checked out in another worktree, a conflict, and a Git that
  cannot merge without a working tree. It never fetches, pushes, resets, stashes or switches a branch.
- The guard is kept: every check green in every repository it integrates, and no
  `Status: needs-maintainer` decision. `integrate` runs each check set itself, so the checks run twice
  per feature. It also compares the `HEAD`s the workspace root records with the actual ones.
- It reports `Finalization record:` with one of four states (`integrated`, `partially integrated`,
  `committed, not integrated`, `nothing committed`) and one bullet per repository. After a partial
  integration the record holds the command that restores each ref that moved, and never runs it. Only
  `integrated` ends in `CLEAR`.
- Resuming a halted Run now runs `integrate` again, not `finalize`'s repair loop. Commit a fix you made
  by hand before resuming.
- Each changed or new definition has a version: `finalize` 5, `integrate` 1, and the pipeline
  `speckit-new-feature` 6. Version 6 is the first revision that adds a Phase: an import plans
  `integrate` as an **Import** row, and you publish `integrate`, `finalize` and then the pipeline. The
  steps are in
  [Bring an existing catalog to a revised example](process-yaml.md#bring-an-existing-catalog-to-a-revised-example);
  the behavior is in
  [Finalize and integrate across repositories](process-yaml.md#finalize-and-integrate-across-repositories).
- No setting, event, field, schema version or host behavior changed, and there is no migration. Runs
  already created keep the text they were created with, and an item composed before the publish still
  merges the old way.

### The two review Phases read the repositories a workspace declares (FR-R4-F18, 2026-10-29)

`speckit-code-review` and `speckit-security-review` chose their repository by layout: `repo/` beside
`specs/`, otherwise the workspace root. In a workspace whose code lives in linked repositories that
picked the planning root, so a review could read an envelope diff with no source changes and report
nothing wrong. They now read the repositories a workspace declares, report them first under
`Review scope:`, and treat a scope they cannot resolve as a finding.

- A workspace owner declares the repositories in a section headed `## Implementation repositories`
  in the workspace root's `AGENTS.md`: one bullet per repository, in inline code, with an optional
  `(base: <ref>)` that defaults to `develop`. A declaration is the only source of targets; `CLAUDE.md`,
  plan files and agent memory never choose one. The three layouts, the entry form and what a linked
  repository the declaration omits does are in
  [Choose the repositories the two reviews read](process-yaml.md#choose-the-repositories-the-two-reviews-read).
- A workspace without a declaration keeps today's target in both supported layouts: the workspace
  root for a standalone repository, and `repo/` for the envelope, including a `repo/` that is a linked
  worktree. A planning root with linked repositories needs the declaration.
- An unresolved scope is a counted finding, tagged `[needs-decision]`: a declared path that does not
  exist, is outside the workspace, is not a repository top level or has no base, or a declaration that
  is broken. The review never reports clear while one stands, so the Phase retries to its iteration
  cap, or to the unchanged-metrics stop when `schegent.loop.maxUnchangedComparisons` is set. The
  remedy is the declaration.
- Each changed Phase is a new version: `speckit-code-review` 3, `speckit-security-review` 3, and the
  pipeline `speckit-new-feature` 5. An import skips ids a catalog already holds, so an existing
  catalog gets the new text by publishing the two Phases and composing queued items again; the steps
  are in
  [Bring an existing catalog to a revised example](process-yaml.md#bring-an-existing-catalog-to-a-revised-example).
- No setting, event, field, schema version or host behavior changed, and there is no migration. Runs
  already created keep the text they were created with.

### A retry loop can fail early when its judged figures stop changing, off by default (FR-R4-F17, 2026-10-29)

A loop whose retry condition stayed true and whose figures did not move ran to its iteration cap, one
invocation after another. `schegent.loop.maxUnchangedComparisons` lets an operator fail it sooner. It
ships at `0`, which is off, so no existing run changes on upgrade.

- Set to a value from `1` to `49`, it fails a retry loop after that many consecutive comparisons in which
  the figures its retry condition reads did not change, below the iteration cap. `2` is a suggested
  starting value, not a default. A value outside the range is read as `0`. It applies only where the
  phase's cap outcome is to fail, and never at or past the cap.
- The failed run carries a new cause, `judged_metrics_unchanged`, labelled "Judged metrics unchanged",
  and a notice that says the figures were unchanged and that work the condition does not measure may
  still have happened. It advises resolving what blocks the condition first, and then names "Schegent:
  Resume Paused or Failed Workflow", which runs the phase again at the same iteration with the
  iterations left up to the cap. The cause is on the failed run, its `task-execution-ended` event, the
  metrics rollup, the failure record and History.
- The per-run limits view gains an "Unchanged-metrics stop" row: the value, the layer that set it, and
  whether it applies to the current phase. It reads "not applied" when the phase has no retry condition
  or continues at its cap.
- What it does not do: it adds no status, no audit event type and no `phase-end` cause; it never resumes
  a run by itself; it does not reset the cap; and it does not claim that no work happened. A figure the
  condition does not name, or a change to the working tree, does not reset the count.
- The settings reference, the retry contract's new section "Stopping a loop whose judged metrics stop
  changing" and the closed list of ten causes are in
  [retry-contract.md](retry-contract.md#stopping-a-loop-whose-judged-metrics-stop-changing).

### Removing a row records whether the operator attested it, and a report counts how failed rows were resolved (FR-R4-F16, 2026-10-29)

After an attested row was removed, its audit line said `priorStatus: completed` and nothing more, so
it read as a normal completion. And nothing counted which exit a failed row took. Both are now
recorded, and neither changes what any queue, run or row does.

- Removing a row now writes `completionProvenance` on its `task-removed` audit line: `operator-attested`
  when the operator had marked the row completed, `null` otherwise. A line written before this change
  has no such field, and reads as "provenance not recorded", never as attested.
- "Schegent: Report Failed-Row Exits" counts how each failed row was resolved, by failure cause: resumed,
  started fresh, removed, attested, still failed and the other exits, with an unknown count and its
  reasons beside them. It opens an unsaved Markdown document, writes nothing, works in an untrusted
  window, and states what it cannot see: why a queue ran on under the `continue` policy, rows removed by
  Clear Failed or Clear Done, and why an operator chose an exit.
- It is the evidence for a decision, not the decision: no status, button or event was added, and the
  decision record stays pending.
- How to read the report is in
  [Count how failed rows were resolved](inspect-audit-logs.md#count-how-failed-rows-were-resolved).

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

### A failed Run keeps a bounded failure record (FR-R4-F15)

- **A record that Remove does not delete.** When a Run fails, Schegent writes one redacted,
  path-free file of at most 32 KiB to `.schegent/failure-records/`, naming the failure cause, the
  phase context and up to 20 issue summaries the agent reported as still open. Remove deletes a
  row's session directory and raw transcript and leaves the record; a Run's Delete Evidence removes
  it, and the Run's evidence export includes it.
- **"Show last error" shows it.** The row's region now lists the cause, the phase and iteration, the
  issues with the agent's own labels, and the last metrics, and says so plainly when the record was
  removed by retention, is unavailable or could not be read.
- **The age setting now covers it.** `schegent.logging.sessionRetentionMaxAgeDays` ages failure
  records out with the session artifacts, and at most the newest 200 records per workspace are kept.
  `schegent.logging.sessionRetentionMaxBytes` does not apply to them.
- **Five phases ask for issue tags.** In the new-feature example (version 4), `speckit-analyze`,
  `speckit-implement`, `speckit-code-review`, `speckit-security-review` and `finalize` ask the agent
  to start each bullet under `Remaining issues:` with `[regression]`, `[pre-existing]`,
  `[environment]`, `[needs-approval]` or `[needs-decision]`, or no tag when none fits. The tags are
  the agent's labels: Schegent records them and does not check them, and no decision depends on
  one. An existing catalog reaches the new text by publishing each changed definition, as
  [Bring an existing catalog to a revised example](process-yaml.md#bring-an-existing-catalog-to-a-revised-example)
  describes; a Run already started keeps the text it began with.
- **The two notices that named no action now point at the panel.** When a record was written, the
  `cap_exhausted` and `last_phase_issues_remain` failure notices end with the sentence
  `"Show last error" lists what was open.`; when none was written they read as before.

No audit event, field or schema version changed, and nothing about halts, counters, the iteration cap
or a Run's status changed. There is no migration. Rolling back leaves the records on disk: delete
`.schegent/failure-records/` by hand if you want them gone.

When adding an entry, name the affected command, setting, workflow, state transition or persisted
artifact exactly as it appears in the product, and state upgrade or rollback limits explicitly. Do
not infer a historical change list from the current code snapshot alone.

For each entry, name the affected command, setting, workflow, state transition, or persisted artifact exactly as it appears in the product. State upgrade or rollback limits explicitly. Do not infer a historical change list from the current code snapshot alone.
<!-- Source: ../release/actions-terminal-record.md -->
<!-- Source: src/contracts/state-schema.ts -->
<!-- Source: src/contracts/failure-record.ts -->
<!-- Source: src/services/failure-notice.ts -->
<!-- Source: examples/speckit-new-feature.pipeline.yaml -->
