# Interactive verification owed: what two specs are still waiting on

**Opened**: 2026-09-06 (`FR-R3-170`, T1733) · **Updated**: 2026-11-06 (`FR-R5-F18`, T18.4/T18.5; `FR-R5-F20`, the round 5 journeys) ·
**Subjects**: `specs/020-phase-level-logs`, `specs/067-live-mode-rework`, `specs/068-enhance-system-log` ·
**Gates**: `repo/tests/lint/spec-traceability-governance.test.ts` requires each subject to link
here; `repo/tests/lint/dated-review-records.test.ts` reads the date below.

<!-- interactive-verification-review-date: 2026-12-06 -->

Two specs have said `Verification Pending` since they shipped. Both are built, both have automated
coverage of the stable path, and both are waiting on the same thing: an operator sitting in front of
a VS Code dev host, doing something by hand, and reporting what they saw. Until this record existed,
that wait had no owner and no end — the status word was the whole of the claim, and nothing asked it
to say more.

This is not a deferral. Nothing is blocked and nothing is unstarted. It is a debt with a date on it.

## Who owes this

**The repository operator.** Not a role with a rota behind it — this project has one regular
maintainer, and naming a committee would be the more comfortable fiction. The same person carries
the platform decline in
[the platform observation record](platform-observation-record.md) and the VoiceOver matrix in
[the accessibility AT matrix](../release/accessibility-at-matrix.md), for the same reason: these are
observations, and observations need somebody with a machine.

## What is owed

### `067-live-mode-rework` — T033 and T034

**T033, interactive Live Mode transitions.** In a real dev host, walk a multi-phase pipeline and
confirm three behaviours: phase transitions auto-follow; a manual click decisively disables
auto-follow; the Live button re-engages it. The stable production-artifact path is already automated
by `repo/tests/integration/release-ui-qualification.host.test.ts`. What is owed is the interactive
half — whether a human clicking during a live run gets the behaviour the spec describes.

**T034, persistence across a webview reload.** Confirm Live Mode OFF survives a reload as OFF and ON
survives as ON. Store reconstruction is automated and the real-host bundle test pins
`getState`/`setState` alongside the Live Mode markers. What is owed is the reload matrix as a person
actually performs it.

**T036 is not owed and is not counted here.** It is a deliberate won't-do: re-pointing the active
plan back to `067` would create pointer churn against a later workstream. It is unticked because it
was declined, not because it is waiting. A register that swept it in with the other two would be
claiming a debt that nobody incurred.

### `068-enhance-system-log` — T036

Walk the manual smoke steps in the spec's quickstart §3 inside a dev host and verify four things:
structured cells are visible (US1); the CLI command block is visible with redacted markers (US2);
close → reopen makes entries reappear, and `chmod 000` degrades gracefully rather than crashing
(US3); success and error entries are visually distinguishable (US4). Deviations go in that
quickstart's DoD checklist. As with `067`, the shipped-bundle path for both System subtabs is
automated; the interactive persistence and error-display matrix is not.

### `020-phase-level-logs` — Phase 9 SC-011 live check (`FR-R5-F18` T18.4 / T18.5)

All 86 implementation and automated test tasks in `specs/020-phase-level-logs/tasks.md` are ticked,
and both multi-queue host tailing and multi-iteration (`[3, 2, 1]`) webview live-tail recovery are
covered by automated Vitest suites. What remains owed is the interactive Phase 9 `SC-011` live
check in a VS Code dev host:

1. With `schegent.logging.verbose` enabled, run a disposable phase on a queue other than `default`
   using the `agy` backend and open that queue/task/phase in the Phase Log feed.
2. Record the `agy` CLI version and invocation arguments, capture a sanitized `stream.jsonl`
   excerpt to confirm or revise the `event: step_update` / `init` / `result` mapping in
   `specs/020-phase-level-logs/data-model.md` (which remains explicitly labelled `unconfirmed until
   the SC-011 live check passes`), and verify `.schegent/audit.log` contains `phase-log-read` with
   `outcome: success` and `entryCount > 0` followed by `phase-log-tail-started`.

### Round 5 journeys owed a person (`FR-R5-F20`, 2026-11-06)

These six journeys come out of round 5. Each row links the scenario that already owns it. The
scenario is not restated here, and no second acceptance list is written. None of the six was
observed when this section was written: that cycle ran with no person at a real editor and no
screen reader. Each row therefore reads **not observed**. The owner is the repository operator
named above, recorded as `maintainer`.

The procedure is the same for every row. Build the integrated revision, then run the linked
scenario by hand in a VS Code dev host. Record the date, the editor version, the operating system
and the observer, together with what was seen, in the owning spec's quickstart or measurements
file. Then replace **not observed** in the row with a link to that record.

| Journey | Owning scenario | Observation | Owner | What a person would do |
|---|---|---|---|---|
| Acknowledgement latency under load | [spec 269](../../../specs/269-builder-command-lifecycle/spec.md), User Story 2, scenarios 1 and 2 (queue creation waits for the host's acknowledgement, bounded at 5 seconds); filing [F10](../../../docs/features/round_5/DONE_10_FR-R5-F10_builder_persistence_and_command_feedback.md) | **not observed** | maintainer | With phases running on other queues, submit `New Queue` and time the acknowledgement against the 5-second bound. |
| Multi-window recovery | [spec 267](../../../specs/267-workflow-dispatch-recovery/spec.md), User Story 3, its Independent Test (a second window on the same workspace); filing [F08](../../../docs/features/round_5/DONE_08_FR-R5-F08_workflow_dispatch_and_recovery_integrity.md) | **not observed** | maintainer | Perform that Independent Test in two real editor windows open on one workspace. |
| Dashboard hide/restore | [spec 269](../../../specs/269-builder-command-lifecycle/spec.md), User Story 1 (drafts, tab, selection and undo history survive a hidden panel); filing [F10](../../../docs/features/round_5/DONE_10_FR-R5-F10_builder_persistence_and_command_feedback.md) | **not observed** | maintainer | Edit a Phase and a Workflow draft, switch away from the Dashboard panel, return, and compare. |
| Current phase-log journey | The `020-phase-level-logs` section above; filing [F18](../../../docs/features/round_5/DONE_18_FR-R5-F18_phase_log_live_tail_and_qualification.md) | **not observed** | maintainer | Steps 1 and 2 of that section. |
| Clean-install Workflow launch, import and export | [spec 267 quickstart](../../../specs/267-workflow-dispatch-recovery/quickstart.md), which runs `tests/integration/round5-clean-install-journey.test.ts` (the automated host path); filing [F07](../../../docs/features/round_5/DONE_07_FR-R5-F07_pipeline_removal_and_workflow_delivery.md), task T07 | **not observed** in a real editor | maintainer | Install the packaged VSIX into a clean editor profile, then launch one Workflow, import one and export one. |
| Representative open menu, dialog and keyboard states | No F08 to F19 scenario owns it. Automated evidence only: the opened Workflow-picker state in `tests/a11y/a11y-scan.spec.ts` (`FR-R5-F20`), which reports automated findings, not conformance | **not observed** | maintainer | Follow the procedure in [the accessibility AT matrix](../release/accessibility-at-matrix.md) with the keyboard and a screen reader, opening the Workflow picker and one dialog. |

## What would close this

Any of these, per subject, and the subject moves to `Complete`:

1. **The walkthrough is performed and recorded.** The evidence goes in the spec's own quickstart DoD
   checklist, dated, and the spec's `## Evidence owed` section is replaced by the result.
2. **The interactive behaviour becomes automatable.** If a harness appears that can drive a real
   webview through a phase transition and a reload — VS Code's own extension test runner reaching
   further than it does today, for instance — then the owed observation stops being an observation
   and becomes a test, and this record's subject list shrinks by one.
3. **The behaviour is withdrawn.** If a subject's capability is removed from the product, the debt
   goes with it. That is what happened to `014-wake-up`, which sat at `Verification Pending` for 25
   days after its capability was deleted on 2026-08-12 — see the withdrawal note in that spec. It is
   the case this register is built to make visible rather than repeat.

When the last subject leaves, this record is retired rather than left standing empty. An empty
register that still fails a build on a date is ceremony.

## What this record cannot see

The gate watches the **date**, and the presence of three fields in two specs. Naming what it cannot
watch matters more than the coverage does:

- **Whether anybody actually looked.** No gate can observe an operator opening a dev host. A spec
  can claim its evidence was gathered and the claim would pass every check in this repository. The
  date is the only mechanism that makes anyone re-read the claim.
- **Whether `## Evidence owed` says anything useful.** The gate asserts the section exists and is
  not empty. It cannot judge whether the observation described is specific enough to be performed.
  That is the honest limit of a text check, and pretending otherwise would be the overclaim this
  round has spent its time removing.
- **Whether the automated coverage that already exists is sufficient.** Both subjects assert that
  the stable path is automated and only the interactive half is owed. That judgement was made by the
  authors of those specs; nothing here re-derives it.
- **Whether a dev host still reproduces the conditions.** VS Code changes. A walkthrough performed
  today against an API that shifts next quarter proves less than its date suggests. Re-reading is
  what catches that, which is what the date is for.

**This record is reviewed on or before 2026-12-06**, and
`repo/tests/lint/dated-review-records.test.ts` fails from that day until someone re-reads it.

Three months, not the six that the event-triggered declines in this repository carry. The horizon
differs because the thing being waited on differs: a decline like
[the platform observation record](platform-observation-record.md) waits on the world to change —
a Windows machine appearing, a contributor filing a report — and six months is a reasonable interval
to re-ask a question nobody can force. This waits on work that is already possible and simply has
not been done. A debt that can be discharged any afternoon should be looked at sooner than a posture
that depends on events outside the project.

The standing decline of the Windows and Linux verification routes (`FR-R3-115`) is a separate and
still-current posture, dated in its own record. This register does not discharge it, restate it, or
depend on it. Both can be true: some platforms are not verified at all, and some behaviours on the
verified platform are still owed a human.
