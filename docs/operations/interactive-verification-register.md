# Interactive verification owed: what two specs are still waiting on

**Opened**: 2026-09-06 (`FR-R3-170`, T1733) ·
**Subjects**: `specs/067-live-mode-rework`, `specs/068-enhance-system-log` ·
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
