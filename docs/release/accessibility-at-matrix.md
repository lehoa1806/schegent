# Assistive-technology matrix

**Captured**: 2026-08-25 · **Target**: WCAG 2.1 Level AA · **Feature**: 155 (`FR-R3-091`)

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

| OS | Screen reader | Version | Exercised | Result |
|---|---|---|---|---|
| macOS | VoiceOver | — | **Nothing** | **UNTESTED** |
| Windows | NVDA | — | **Nothing** | **UNTESTED** |
| Windows | Narrator | — | **Nothing** | **UNTESTED** |
| Linux | Orca | — | **Nothing** | **UNTESTED** |

**Every supported platform is untested.** That is the truth as of this date, and it is written down in
the form `FR-R3-054` established when it recorded its Windows half as *unrun* rather than reporting it
met. No row above may be marked otherwise without naming the technology, its version, the OS, and what
was and was not exercised.

## What the automated scan did find

The first run, 2026-08-25, over 7 routes × 3 themes = 21 combinations:

**30 WCAG 2.1 AA violations, all `color-contrast`** — ten in each of the three shipped themes. They are
recorded in `repo/tests/a11y/a11y-baseline.json` as a count **and** a list, keyed by route, theme, rule
id and selector.

They are **accepted into a baseline, not fixed**, and that is a deliberate choice recorded here rather
than a silence: `FR-R3-091` §3 asks for *"a baseline, not a wall"*, so the gate ratchets from today's
state and fails on a rise. Each one is a real finding against a level the product claims in
`PRODUCT.md`. **The scan's first result is that the product does not currently meet the level it
states**, and paying that down is work this item scopes but does not do.

The affected elements cluster in three places: the active navigation label, the version badge on
history rows, and the tab controls on the builder, system and settings surfaces.

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
