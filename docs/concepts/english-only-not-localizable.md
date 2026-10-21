# English-only is a product decision

Status: Accepted product-boundary decision

Posture: english-only

Decided 2026-08-22 (`FR-R3-030`). Re-taken 2026-10-21 against the full string count (`FR-R3-185`).

<!-- localization-review-date: 2027-04-21 -->

Schegent ships user-facing text in English. There is currently no localization
mechanism, and that absence is deliberate rather than an unfinished migration.
Command titles, setting descriptions, dialogs, notifications, accessibility
labels, and webview copy stay as literals at the place where they render.

<!-- Source: package.json -->
<!-- Source: src/ui/notifications.ts -->
<!-- Source: webview-ui/src -->

## Decision

Contributors must not add a message catalog, translation helper, locale bundle,
or placeholder indirection merely in anticipation of a possible future need.
In the present product, such a boundary would add an alternate source of truth
without a named audience, translation workflow, review owner, release process,
or compatibility promise.

The current implementation reflects this decision:

- the manifest has no `l10n` field and no `%key%` contribution strings;
- the repository has no `package.nls*.json` bundle or `l10n/` directory;
- host code does not call `vscode.l10n`;
- the webview has no module named as an i18n, locale, translation, or strings
  boundary; and
- formerly externalized labels such as the raw-transcript retention choices and
  the metrics-chart hint are inline in the components that render them.

<!-- Source: package.json -->
<!-- Source: webview-ui/src/components/settings/general/GeneralSettingFieldRow.svelte -->
<!-- Source: webview-ui/src/components/MetricsDashboard/MetricsCostChart.svelte -->
<!-- Source: tests/lint/localization-posture.test.ts -->

### Re-taken 2026-10-21

The decision was taken again on 2026-10-21, after the whole string surface was counted (see
Measurement below). The answer is **A: the posture stays `english-only`.**

No condition that would reopen it has fired. On the day, `git shortlog` showed one human author in
each repository's history, `docs/architecture/distribution-posture.md` still says the extension is
private to its author, no translation has been offered, and nobody has named a non-English
audience or a delivery date. The inputs are recorded in `specs/220-localisation-decision/counts.md`.

The count does not change the direction. It sets the cost of reversing the decision, and not its
benefit. Preparing a seam pays off only when someone translates, and nobody does, at any count. A
larger count can only make the preparation dearer.

That cost is 1122 distinct strings to route, and 84% of them (944) are webview text. The webview
has no VS Code localization mechanism. `vscode.l10n` and `package.nls.json` cover the manifest
and the host only, so routing the webview would need a catalog of its own, built by hand and
carried across the boundary between the host and the webview.

<!-- Source: docs/architecture/distribution-posture.md -->

## Measurement

This is the measured size of the text an operator reads, taken at `repo/` commit `98e9c7d0`. A
distinct string is counted once per surface, and an occurrence is every place it appears.

| Surface | Distinct strings | Occurrences | Share of the total |
| --- | --- | --- | --- |
| Manifest | 64 | 68 | 5.7% |
| Host runtime | 114 | 121 | 10.2% |
| Webview | 944 | 1159 | 84.1% |
| **Total** | **1122** | | |

The three surfaces share 5 strings, so the union is 1117 unique strings.

- **Taken with:** `typescript` 5.9.3 and `svelte/compiler` 5.56.10, by the command
  `node specs/220-localisation-decision/measure/string-surface-count.mjs --repo repo --commit 98e9c7d0`,
  run from the workspace root. A second run at the same commit gives byte-identical output.
- **Entries are not strings.** The manifest contributes 23 commands and 37 settings, which is 60
  entries. Those entries carry 64 distinct strings.
- **Left out of the count:** log text, identifiers and codes, comparison operands, imports and
  keys, text the extension did not write, and test-only text. The full list, with the reason for
  each and how many literals it removed, is in `specs/220-localisation-decision/counts.md`.
- **Precision:** a hand-classified sample of 30 strings per runtime surface found 18 of 30 host
  strings and 30 of 30 webview strings visible to an operator. The totals above are not adjusted
  by it.

## Contributor rule

When adding operator-facing copy, write the English literal in the command,
manifest field, host adapter, or Svelte component that presents it. Keep the
usual accessibility and test coverage at that render site. Do not route the
string through an abstraction that implies locale selection when no locale is
selected.

This rule does not prohibit ordinary constants used for protocol values, error
codes, repeated domain terminology, or test fixtures. It concerns a mechanism
whose purpose is translating displayed language.

Whatever the posture, these machine surfaces stay unlocalized: log text, audit
event identifiers, error codes, and command and setting identifiers.

<!-- Source: AGENTS.md -->
<!-- Source: tests/lint/localization-posture.test.ts -->

## The condition that would reopen this

A named non-English audience with a delivery date reopens the decision. That
means identifiable users or a customer commitment requiring a specific locale,
not a speculative preference. Reopening must also assign ownership for
translation quality, fallback behavior, accessibility review, manifest and
webview coverage, release packaging, and continued maintenance.

If that condition occurs, change this decision first and implement one coherent
localization design across both the extension host and webview. The gate at
`tests/lint/localization-posture.test.ts` reads the declared posture from this
file so the project can reverse the decision openly without deleting its drift
check.

Each of three events is an instance of that condition, and reopens the decision when it happens:

- a non-English-speaking operator, identifiable and using the extension;
- a change to the distribution posture (`FR-R3-120`, private-to-author) toward a marketplace
  listing aimed at such an operator;
- a contributor who offers a translation.

These are events a gate cannot see. The review date is what makes someone re-read them: it is
2027-04-21, six months after the 2026-10-21 re-take. On that day, re-read the conditions above.
Then either reopen the decision, or move the date later with a sentence saying what was re-read.
Never delete the date marker to make the gate pass.

<!-- Source: tests/lint/localization-posture.test.ts -->
<!-- Source: tests/lint/dated-review-records.test.ts -->

## What the gate holds

The localization posture test verifies that this document carries exactly one
machine-readable declaration, that the English-only tree has no manifest or
host localization mechanism, that no webview module presents itself as a
translation catalog, and that four specifically protected inline labels remain
at their render sites. The test intentionally does not judge whether every
English sentence is well written; normal product and accessibility review still
own that quality.

<!-- Source: tests/lint/localization-posture.test.ts -->

## What this record does not claim

- No operator is known to have been blocked by the absence of localization. The product's users
  are its author.
- No claim that localization would widen adoption. That is a strategic argument this record does
  not make.
- No position on accessibility, which is measured separately.
