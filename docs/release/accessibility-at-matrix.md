# Assistive-technology matrix

**Captured**: 2026-08-25 · **Updated**: 2026-11-23 (`FR-R7-17`, Features 310/311/331; `FR-R7-14`, 14-17); 2026-11-06 (`FR-R5-F20`) · **Target**: WCAG 2.1 Level AA (whole-app automated scan baseline); WCAG 2.2 Level AA (`F11-NFR-07` / `NFR-007` for Feature 310 and `F12-NFR-04` / `NFR-004` for Feature 311 operator journeys)
**Features**: 155 (`FR-R3-091`), 167 (`FR-R3-131`), 310 (`FR-R6-F11`), 311 (`FR-R6-F12`), 328 (`FR-R7-14`, 14-17), 331 (`FR-R7-17`, `R7-17-01` / `R7-17-03`)

<!-- at-matrix-review-date: 2026-11-27 -->

## Why this file exists, and what it is not

`repo/tests/a11y/` runs an automated WCAG 2.1 AA scan over every dashboard route in every shipped
theme. **An automated scan is not conformance.** Automated tooling catches a minority of real
barriers: it finds what a rule engine can see in a rendered accessibility tree, and says nothing about
whether a screen-reader user can complete a task.

This file is where the other half lives — and where the fact that it has **not been done** is recorded
rather than left to be inferred. `A11Y-01` is the only Medium-*confidence* row in its register, and
the confidence was honest: the review did not establish a failure, it established that **nobody had
looked**.

## The matrix

| OS | Screen reader | Version | Exercised | Result | Trigger |
|---|---|---|---|---|---|
| macOS | VoiceOver | — | **Nothing** | **UNTESTED**: **not observed** as of 2026-11-23 (`FR-R7-14`, 14-17; `FR-R7-17`, Features 310 & 311) | 2026-11-27, owner `maintainer`: run [the procedure below](#the-procedure) on a clean editor profile; see *Why it is untested* |
| Windows | NVDA | — | **Nothing** | **UNTESTED** | Windows platform verification (`FR-R3-129`) |
| Windows | Narrator | — | **Nothing** | **UNTESTED** | Windows platform verification (`FR-R3-129`) |
| Linux | Orca | — | **Nothing** | **UNTESTED** | Linux platform verification (`FR-R3-129`) |

**Every supported platform is untested.** That is the truth as of this date, and it is written down in
the form `FR-R3-054` established when it recorded its Windows half as *unrun* rather than reporting it
met. On 2026-11-06 (`FR-R5-F20`) the macOS row was re-read and is still **not observed**: that cycle
had no person at a Mac with VoiceOver on. The NVDA, Narrator and Orca rows stay unobserved, for the
reason given below. **An automated scan pass is an automated finding, not conformance.** A clean run
of `repo/tests/a11y/` moves no row in this table. No row above may be marked otherwise without naming the technology, its version, the OS, and what
was and was not exercised.

**The ordering is not arbitrary and it is not alphabetical.** NVDA, Narrator and Orca follow platform
verification, not the other way around: this product's platform behaviour is verified on macOS
only, where the VoiceOver row above is still **not observed**, and the other platforms are declared
unobserved
([`docs/operations/platform-observation-record.md`](../operations/platform-observation-record.md),
`FR-R3-129`). A screen-reader row for a platform whose *filesystem behaviour* is undeclared would be
the more specific claim resting on the less specific one. macOS/VoiceOver is therefore the only row
that can move on evidence available today, and it is the only row this file asks for.

`repo/tests/lint/at-matrix-honesty.test.ts` holds the shape: no row carries a result without a date,
and every **UNTESTED** row carries a trigger.

## The VoiceOver procedure, and why the row is still untested

### Why it is untested

`FR-R3-131` T1500 asks for this matrix to be executed. It was **not executed**, and the row says so
rather than being filled from what the automated scan can infer. Driving VoiceOver through an
operator journey requires a human at a macOS machine with the screen reader on; nothing in a CI
runner, and nothing in an agent session, observes what a screen-reader user hears. A row marked
*pass* on the strength of a rule engine would be precisely the substitution this file's format exists
to prevent, and `FR-R3-091` wrote that rule before the temptation arrived: *"Do not mark a row from
an automated result. The scan is in `repo/tests/a11y/`; it is a different claim."*

This is the same declination
[`FR-R3-129`](../../../docs/features/round_3/DONE_129_FR-R3-129_qualification_residuals_with_dates.md)
recorded for the live backend canary: the work is owed, the trigger is dated, and the procedure is
written out so that executing it is a session's work rather than a design exercise.

### Review 2026-11-06

Feature 282 (`FR-R5-F21`) re-read this matrix ahead of its date.

- **Evidence checked**: every commit since the date was written on 2026-08-28 (`5af5e4e3`) to this
  page and to `repo/tests/a11y/`: five. They change the automated scan (its routes, the contrast
  baseline, the harness) and this page's text. `FR-R5-F20` (`ae4ae439`) re-read the VoiceOver row on
  the same day and left it **not observed**. No commit records a VoiceOver run.
- **Still owed**: one run of [the procedure below](#the-procedure) by a person at a Mac with
  VoiceOver on. The owner is the maintainer.
- **The date stands at 2026-11-27.** Only that run can move the row, and it has not happened, so the
  review cannot renew the date. A clean automated scan would not change this either.

### Review 2026-11-23

Feature 328 (`FR-R7-14`, finding `14-17`) diagnosed and stabilized the intermittent `1000 × 600` small-window keyboard navigation failure and extended the manual VoiceOver procedure below. Feature 331 (`FR-R7-17`, items `R7-17-01` and `R7-17-03`) expanded the automated Playwright accessibility scan and added Feature 310 and Feature 311 operator rows to the manual VoiceOver procedure.

- **Automated diagnosis and fix (`FR-R7-14`, `14-17`)**: In `repo/tests/a11y/workflow-run-overflow.a11y.spec.ts`, `claude-speckit-plan` (`height = 174 px`) sits cleanly inside the `operations-scroll` viewport (`[89, 263]` within `[44, 572]`) after a single `488 px` `PageDown` from `run-detail-back`, so keyboard geometry was not skipping the node. The intermittent miss was caused by the fixed `SETTLE_MS = 60` (`page.waitForTimeout(60)`) delay firing the next `PageDown` before scroll movement settled under load. The test now awaits observable focus (`toBeFocused()`), overflow readiness (`scrollHeight > clientHeight`, `scrollTop === 0`, all 11 nodes laid out), and consecutive `requestAnimationFrame` scroll stabilization before sampling each step, and passed 10 consecutive isolated runs plus full `npm run a11y`.
- **Automated Feature 310 / 311 / 313 scan expansion (`FR-R7-17`, `R7-17-01` & `R7-17-03`)**: `repo/tests/a11y/a11y-scan.spec.ts` now also scans Historical Reports (`metrics-mode-reports`, `HistoricalReportsPanel`, retention disclosure, root drill-down and focus restoration on close, two-step saved-report delete focus), System Runtime Health (`TelemetryRuntimeHealthPanel` including visible `content-export-unsupported` refusal), and Active/History drill-downs with expanded `ExecutionVisibilityPanel` and `ChangeReviewPanel` (distinct non-numeric availability/recovery readings, keyboard-scrollable `.cr-files`, refresh/close status announcements, and waiting-approval handoff controls) across all three shipped themes (`light`, `dark`, `high-contrast`), plus desktop target-size sanity checks (`>= 24 px`).
- **Scope vs target (`NFR-007` / `NFR-004`)**: Automated Playwright axe scans evaluate the WCAG 2.1 Level AA rule set (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`) plus targeted keyboard, focus, and target-size sanity checks, while Feature 310 (`NFR-007` / `F11-NFR-07`) and Feature 311 (`NFR-004` / `F12-NFR-04`) target **WCAG 2.2 Level AA** for their operator journeys. **Automated Playwright axe scans (including the newly added Feature 310 and Feature 311 states) are automated checks, not human AT conformance**, and move **no** row in the matrix above.
- **Still owed**: One human run of [the procedure below](#the-procedure) — covering **launch, pause, recovery, evidence deletion, Feature 310 Historical Reports, and Feature 311 Execution Visibility & Change Review** on a clean editor profile — is still owed by the maintainer at a macOS machine (`VS Code 1.107.0` floor on local `darwin/arm64`) with VoiceOver enabled. Every human AT platform row (macOS VoiceOver, Windows NVDA, Windows Narrator, Linux Orca) remains truthfully **`UNTESTED`** / **`not observed`**.
- **The date stands at 2026-11-27.** No human VoiceOver session has been observed, so the review does not renew the date.

### The procedure

Run the operator journey from
[`docs/tutorials/user-quickstart.md`](../tutorials/user-quickstart.md) together with the Feature 310
([`docs/operations/historical-reporting.md`](../operations/historical-reporting.md)) and Feature 311
([`docs/operations/change-review.md`](../operations/change-review.md)) operator journeys on a **clean editor profile**
with **VoiceOver on and the mouse untouched** — keyboard and screen reader only, start to finish,
explicitly covering **launch, pause, recovery, evidence deletion, Historical Reports (Feature 310), and Execution Visibility & Change Review (Feature 311)**. One row per task. A task
that needs sighted correction is a **fail** with the barrier named, not a partial pass.

| # | Task | From | Completed by keyboard + VoiceOver alone? |
|---|---|---|---|
| 1 | Reach and open the dashboard on a clean editor profile | quickstart §1 | |
| 2 | Import the example process | quickstart §2 | |
| 3 | Compose, queue, and **launch** a run | quickstart §3 | |
| 4 | Determine the run's current phase and status without looking | quickstart §4 | |
| 5 | **Pause** the run, and confirm by ear that it paused | `PhaseControlMenu` | |
| 6 | **Recover** / resume the run (paused or interrupted state), and confirm by ear that it resumed | `PhaseControlMenu` / recovery surface | |
| 7 | Reach the evidence for a completed phase and read a verdict | history surface | |
| 8 | Trigger **evidence deletion**, read the retention disclosure and confirmation prompt by ear, and confirm completion | evidence delete command / history surface | |
| 9 | Reach the settings surface and change one setting | settings route | |
| 10 | **Feature 310 (Historical Reports) — query & filter**: switch to the **Reports** tab under Metrics (`metrics-mode-reports`), select a report view and filters (`Report`, `Window`, `Workflow ID` / `Outcome` or `Backend`, `Sort by`), and run the report while confirming polite status announcements by ear | `HistoricalReportsPanel` (`NFR-007`, WCAG 2.2 AA target) | |
| 11 | **Feature 310 (Historical Reports) — drill-down, focus restoration & retention disclosure**: open a root execution drill-down, inspect attempts/usage/omissions, close the drill-down and confirm focus restores to the triggering row button, and read the external-file retention disclosure (`outside-managed-retention`) by ear | `HistoricalReportsPanel` / `ReportDrillDownPanel` (`NFR-007`) | |
| 12 | **Feature 310 (Historical Reports) — two-step saved-report deletion**: open a saved report's action menu, trigger `Delete…`, verify focus moves to `Confirm delete`, read the disclosure that previously exported files on disk remain untouched, and confirm (or cancel with `Keep`) the two-step deletion by ear | `SavedReportsSection` (`NFR-007`) | |
| 13 | **Feature 311 (Execution Visibility) — drill-down & distinct non-numeric readings**: expand `ExecutionVisibilityPanel` inside an active or historical run drill-down, filter by attempt, and confirm by ear that evidence availability (`Missing`, `Expired`, `Partial`, `Unavailable`), live-log coverage, normalized ACP state, and recovery posture (`Verified`, `Degraded`, `Uncertain`) read as distinct non-numeric phrases | `ExecutionVisibilityPanel` (`NFR-004`, WCAG 2.2 AA target) | |
| 14 | **Feature 311 (Change Review) — open, refresh, close & keyboard scrolling**: open Change Review in both the native `vscode.changes` multi-file view and the disclosed `vscode.diff` single-file fallback, trigger `Refresh review` and `Close review` while confirming status announcements, and focus and scroll `.cr-files` (`change-review-file-list`) via keyboard alone | `ChangeReviewPanel` (`NFR-004`) | |
| 15 | **Feature 311 (Phase Handoff) — review & approve revision**: navigate to a waiting-approval phase handoff inside `ExecutionVisibilityPanel`, read its revision, source, and omission summary, and approve (or edit and supersede) the handoff revision by keyboard and VoiceOver alone | `ExecutionVisibilityPanel` (`NFR-004`) | |

Record, per row: platform, assistive technology, VoiceOver's exact macOS version, the OS version,
the route, the task outcome, and any remaining blockers if the task failed. Then fill the matrix
row above with the date and the pass/fail tally, and **file each failure as its own item** — a
failure recorded only in this table is a finding with no owner.

## What the automated scan found, and what happened to it

**First run, 2026-08-25**, over 7 routes × 3 themes = 21 combinations: **30 WCAG 2.1 AA violations,
all `color-contrast`** — ten in each of the three shipped themes, recorded in
`repo/tests/a11y/a11y-baseline.json` as a count **and** a list. They were accepted into a baseline
rather than fixed, on `FR-R3-091` §3's *"a baseline, not a wall"*, and this file said so: the scan's
first result was that the product did not meet the level it stated.

**2026-08-28, `FR-R3-131`: the thirty are cleared, not re-accepted.** The baseline holds zero
entries. The audit of 2026-08-27 made the second half of the point — a baseline prevents growth, and
then its stability starts reading as compliance — and the debt turned out to be three token
decisions rather than thirty CSS edits:

| Cause | Findings | Fix |
|---|---|---|
| `--schegent-color-active` (which is `--vscode-charts-blue`, a **chart** colour) used as small text on the blue-tinted `--schegent-surface-active` | **24** | `--schegent-color-active-fg`; the accent still draws the border, underline or bar, and no longer carries the word |
| `opacity: 0.75` on a history badge — a ratio no reviewer can read off the declaration | **6** | a colour instead; dimming on text is expressed as a colour, never as opacity |

**How the split was got wrong first, because the correction is the more useful record.** A first
reading of the baseline scored it 15 / 9 / 6 and attributed nine findings to *inactive* navigation
labels, which produced a third token — a mixed-down nav-label colour — fixing nothing that had been
measured. axe reports the **shortest unique selector**: on the route a nav button is active for, that
button is uniquely identified by its `data-testid` alone, so nine of the eighteen active-label
findings appear in the record as `button[data-testid="dashboard-route-system"] > .nav-label` with no
`.active` in them. Every one of the 30 was an active label or a badge; none was an inactive label. The
speculative token was reverted, and the count is now checkable against the JSON the entries were
removed from.

### Two more findings the scan had never been pointed at

**Nine, from `FR-R3-127`, three days earlier.** Three buttons carried `class="btn"`, and the only
`.btn` rules in the webview are scoped under `.pb` in `pipeline-builder.css` and never reached them,
so they rendered with the user-agent default in all three themes. The a11y scan needs a Playwright
browser and runs in the deferred whole-suite tier, so that cycle's own verification could not have
seen them.

**Six more, because a whole webview was unscanned.** This extension ships **two** webviews. The scan
loaded only `dashboard.html`, and printed `excluded routes: (none)` while the sidebar panel —
`StatusBar`, `StatsStrip`, `CurrentTask` — had never been looked at by any rule engine. `FR-R3-131`
pointed the scan at it: **24 combinations now, not 21**, and the first run found `.elapsed-pill`
carrying the same accent-as-small-text pair as the 24 (three themes), plus `aria-prohibited-attr` on
a decorative status dot given an `aria-label` a generic `span` may not carry (three themes). Both
fixed. An undeclared limit read as full coverage is the failure `EXCLUDED_ROUTES` exists to prevent
one level down; it was happening one level up.

**Four, from a rule the scan cannot carry at all.** `FR-R3-143` gave the General tab four collapsible
groups, and each group's header is a `<summary>`. The 390x844 coarse-pointer walk in
`tests/visual/webview.visual.spec.ts` measured `button, input, select, textarea` and stopped there, so
it never saw them; the theme's `@media (pointer: coarse)` block raised the same four element types and
no others, so nothing lifted them either. The two omissions covered for each other and the headers
shipped at **35px** against a 44px floor. The axe scan could not have caught this: target size is
WCAG **2.2** SC 2.5.8, and this scan's tag set is `wcag2a, wcag2aa, wcag21a, wcag21aa`. Both halves are
fixed — `summary` is in the walk's selector and in the theme's coarse-pointer rule — and the walk now
seeds a list entry through the UI first, because `StringListField`'s per-row Remove button does not
exist on a surface published with an empty allowlist and so had never been measured either. On
2026-11-16 Settings went to one section at a time, which hid three of the four groups from the walk,
since it skips an element with no box; the walk now shows each section in turn and measures it.
<!-- Source: webview-ui/src/lib/theme.css -->
<!-- Source: tests/visual/webview.visual.spec.ts -->

**What this does and does not change about the target.** Contrast is now clean across the scanned
surface — both webviews, 8 surfaces × 3 themes — and the sentence this file used to carry, *the
product does not currently meet the level it states*, is no longer true **of contrast**. It remains
true of the level as a whole, for a different reason: every row of the matrix above is untested, and
AA is not a contrast ratio. The claim boundary is written in [`RELEASE.md`](../../RELEASE.md), where a
claim would actually be made.

## How to add a row

1. Run the built app under the real assistive technology on that OS.
2. Record the technology, its exact version, the OS version, and **what you exercised** — a route
   list, not "the app".
3. Record what you did **not** exercise, in the same row. A partial pass recorded as a pass is the
   defect this file's format exists to prevent.
4. Do not mark a row from an automated result. The scan is in `repo/tests/a11y/`; it is a different
   claim.

## What this does not block

`FR-R3-091` §5: *"This blocks nothing in criterion 8 and is not a reason to hold a release gate. It
was deferred on that basis and the basis has not changed; it is filed because a deferral with no item
eventually becomes a gap with no record."*
