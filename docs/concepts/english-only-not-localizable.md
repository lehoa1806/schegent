# English-only is a product decision

Status: Accepted product-boundary decision

Posture: english-only

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

## Contributor rule

When adding operator-facing copy, write the English literal in the command,
manifest field, host adapter, or Svelte component that presents it. Keep the
usual accessibility and test coverage at that render site. Do not route the
string through an abstraction that implies locale selection when no locale is
selected.

This rule does not prohibit ordinary constants used for protocol values, error
codes, repeated domain terminology, or test fixtures. It concerns a mechanism
whose purpose is translating displayed language.

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

<!-- Source: tests/lint/localization-posture.test.ts -->

## What the gate holds

The localization posture test verifies that this document carries exactly one
machine-readable declaration, that the English-only tree has no manifest or
host localization mechanism, that no webview module presents itself as a
translation catalog, and that four specifically protected inline labels remain
at their render sites. The test intentionally does not judge whether every
English sentence is well written; normal product and accessibility review still
own that quality.

<!-- Source: tests/lint/localization-posture.test.ts -->
