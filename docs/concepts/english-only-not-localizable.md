# English-only is a decision, not an unfinished migration

Status: Accepted product-boundary decision (2026-08-22)

Posture: english-only

Schegent's user-facing text is English, deliberately. There is no localization
mechanism, and adding one is a decision to be taken openly rather than a gap to
be filled quietly. This document is the position, the measured surface it covers,
what reversing it would cost, and the name of the test that holds it.

## Product decision

**Schegent is not localizable, by decision.** The extension ships one language.
It has no `package.nls.json`, no `l10n` field, no `l10n/` bundle, and no
`vscode.l10n` call, and none of those absences is an oversight.

Three grounds:

- **There is no shipped audience.** `package.json` declares 0.2.0, the only tag
  is `v0.1.0`, and [`RELEASE.md`](../../RELEASE.md) records the marketplace
  publish as a manual step with no automated job. Nothing is in anyone's hands to
  localize for.
- **The cost is recurring, the benefit is not yet real.** Every new user-facing
  string pays a localization tax once a mechanism exists. Paying it for zero
  users is paying it for nothing.
- **The webview makes the price steep.** See
  [What reversing this would cost](#what-reversing-this-would-cost). The
  measured 76,533 lines of webview source are the part that is not a mechanical
  edit.

English-only is a legitimate engineering position. The illegitimate position is
the one this decision replaced: a fifteen-line module calling itself a "minimal
localization boundary" while consulting no locale, surrounded by fifty-six
manifest strings and seventy-six thousand lines of webview with no boundary at
all. That state served nobody. It read as a migration in progress, so the next
contributor filed the next string into a mechanism that did not exist — and the
one after that did not, because there was no rule either way.

### The condition that would reopen this

**A named non-English audience with a delivery date.** Concretely: a decision to
publish to the marketplace *and* a specific locale requested by identifiable
users or required by a customer commitment. Not "it would be nice", and not a
contributor's preference — the trigger is demand with a name attached.

When that arrives, reversing the decision is one edit plus the work: change the
`Posture:` line at the top of this file to `Posture: localizable`, and
[`tests/lint/localization-posture.test.ts`](../../tests/lint/localization-posture.test.ts)
stops objecting to localization mechanisms. The gate reads the posture out of this
document rather than hard-coding English-only, precisely so that changing your
mind does not require deleting the test that holds the old mind.

## The surface this covers

Measured 2026-08-22 at commit `c3ff953d65bb2b754de3ce79193da90c9b1c904f`. Each
figure is published with the command that produces it, so a reader re-derives it
rather than trusting it. All commands run from the execution repository root.

The commit matters for one row. These are the figures *before* this decision was
applied, so the webview count still includes the 15 lines of `i18n.ts` and the two
import lines this change removed. Re-run at that commit and the counts match
exactly; re-run on the current tree and the webview row reads 334 files / 76,516
lines — a 17-line difference with a named cause, not drift. Every other row is
unaffected.

| Surface | Count | Method |
|---|---|---|
| `contributes.commands` titles | 19 | `node -e "console.log(require('./package.json').contributes.commands.length)"` |
| Configuration description strings | 34, across 32 properties | Count `description` and `markdownDescription` keys under `contributes.configuration.properties`. Two properties carry both: `schegent.logging.runtimeLogLevel` and `schegent.logging.runtimeLogFilePath` |
| `enumDescriptions` | 0 | Same walk, counting `enumDescriptions` keys |
| Remaining `contributes` strings | 3 | `configuration.title`, the activity-bar container title, and the view name — all the literal `"Schegent"` |
| `%key%` NLS placeholders in the manifest | 0 | Walk every string value under `contributes` for a whole-value `%…%` form |
| Host dialog sites | 22 | `rg -o 'vscode\.window\.show[A-Za-z]+' src \| wc -l` |
| …of which carry no text of their own | 6 | `vscode-host-services.ts:75-77` and `extension.ts:389-391` are `(message) => vscode.window.show*Message(message)` pass-through adapters |
| Webview source | 76,533 lines across 335 files | `rg --files webview-ui/src -g '*.ts' -g '*.svelte' \| xargs wc -l`. Of these, 113 `.svelte` files are 24,220 lines and 222 `.ts` files are 52,313. A further 6 files (5 CSS, 1 snapshot) at 531 lines bring the directory total to 341 files / 77,064 lines |
| `package.nls*.json` | absent | `find . -maxdepth 1 -name 'package.nls*.json'` |
| `l10n` field in `package.json` | absent | `node -e "console.log('l10n' in require('./package.json'))"` |
| `l10n/` directory | absent | `test -d l10n` |
| `vscode.l10n` usage | absent | `rg -c 'vscode\.l10n' src` |

Two things the counts do not show, which matter more than the counts:

- **There is no central host strings module.** The 16 dialog sites that do carry
  text draw it from inline literals, from exported constants
  (`RESET_CONFIRMATION_MESSAGE` and `RESET_COMPLETED_TOAST` in
  `src/commands/reset.ts`), and from messages computed across roughly twenty
  modules. A localization migration would have to create the module first.
- **The manifest strings are ordinary literals.** None uses the `%key%` form that
  VS Code's manifest NLS requires, so localizing them is a rewrite of every
  entry, not the addition of a translation file.

### Where the figures came from, and why the method is published

The source finding for this decision — the 2026-08-21 architecture review —
stated three of these figures differently: ~38,700 lines of webview rather than
76,533, 32 configuration descriptions rather than 34 strings across 32
properties, and "18 host dialog strings" rather than 22 sites of which 6 are
text-free. The figures are corrected here rather than copied.

That is why every row above carries its command. The reason the earlier numbers
drifted is that they were stated without a method, so nobody could tell a
measurement from a recollection. These can be re-run.

## What reversing this would cost

Not "add a bundle". Three distinct pieces of work, in ascending order of
difficulty:

**1. The manifest — mechanical, bounded.** Replace 56 literal strings (19
command titles, 34 configuration description strings, 3 brand strings) with
`%key%` placeholders and add `package.nls.json`. Tedious, low-risk, done once.

**2. The host — needs a module that does not exist.** Add the `l10n` field, an
`l10n/bundle.l10n.json`, and route every user-facing string through
`vscode.l10n.t()`. The 22 dialog sites are the visible part; the invisible part is
that the text lives in inline literals, exported constants, and computed messages
across roughly twenty modules with no central strings module to migrate. Building
that module is the first irreversible step, which is exactly why it is not built
speculatively here.

**3. The webview — a contract change, not a bundle.** This is the piece that
makes the decision worth writing down.

`vscode.l10n` resolves inside the extension host. The webview is a **separate
bundle** with no access to the host's l10n bundle. So localizing 76,533 lines of
webview source means one of two things, and both are more than a translation
file:

- ship a locale bundle into the webview build, duplicating the string catalogue
  and the resolution logic across the trust boundary; or
- resolve strings host-side and pass them — or pass a locale — across the
  host↔webview message protocol.

The second route is a protocol change, and that protocol is fenced.
`npm run contracts:check` regenerates and compares the IPC schemas;
`tests/lint/no-duplicate-ipc-validators.test.ts` forbids a second validator for a
message; `tests/lint/no-envelope-reconstruction.test.ts` forbids rebuilding an
envelope outside its one construction site. Every one of those guards exists
because a previous change tried to route data around the contract. A locale would
have to go *through* it.

So branch B is: 56 manifest rewrites, a host strings module built from twenty
modules' worth of scattered text, and either a duplicated catalogue in a second
bundle or an IPC contract change — followed by review of 76,533 lines for
missed literals. That is the price. It is written here so that whoever revisits
this decision is choosing, not discovering.

## What changed when this was decided

`webview-ui/src/lib/i18n.ts` was deleted and its four strings inlined at the four
sites that render them, byte-identically:

| String | Now lives at |
|---|---|
| `Always retain` | `GeneralSettingFieldRow.svelte`, `<option value="always">` |
| `Errors only` | `GeneralSettingFieldRow.svelte`, `<option value="errors-only">` |
| `Off` | `GeneralSettingFieldRow.svelte`, `<option value="off">` |
| `Hover or focus a point on the chart for exact values.` | `MetricsCostChart.svelte` |

The module was deleted rather than renamed to something truer, for two measured
reasons:

- **The indirection deduplicated nothing.** Each of the four strings occurred
  exactly once in the entire repository — inside `i18n.ts` itself. There was no
  second consumer for any of them.
- **The file that used it already bypassed it.**
  `GeneralSettingFieldRow.svelte` called `t()` three times and, ninety lines
  above, inlined `{draft[spec.key as 'loggingVerbose'] ? 'On' : 'Off'}` directly.
  One file, two conventions, for labels of the same kind. Renaming the module to
  "a small shared-label module" would have preserved that inconsistency under a
  truer name — and a renamed module can drift back into claiming to be a
  boundary. A deleted one cannot.

`DEFAULT_LOCALE`, `MessageId`, and `t` survive nowhere.

## What holds this

[`tests/lint/localization-posture.test.ts`](../../tests/lint/localization-posture.test.ts)
reads the `Posture:` line above and fails when the codebase drifts against it. It
fails when a `package.nls*.json`, an `l10n` field, an `l10n/` directory, a
`vscode.l10n` call, or a `%key%` manifest value appears while the posture is
`english-only`; when a module reappears exporting `t` or `DEFAULT_LOCALE` or
declaring `MessageId`, or named for localization, anywhere under
`webview-ui/src/`; when any of the four strings above leaves its component; and
when this document is missing or its `Posture:` line unparseable.

Every failure message names this file, so a contributor who trips the gate reads
the decision rather than working around the test.

The one thing the gate deliberately does **not** flag is the word "message".
`webview-ui/src/lib/messages.ts` re-exports the sidebar IPC contract and
`src/ui/notifications.ts` takes a `message` parameter; neither is a string
catalogue. A gate keyed on the word instead of the shape would have failed on the
tree the day it was written.

## Related

- [Local-first does not mean offline execution](local-first-not-offline.md) — the
  other accepted product-boundary decision, and the form this document follows.
- [`AGENTS.md`](../../AGENTS.md) — points here, so the boundary is met before a
  string is added.
- The 2026-08-18 architecture review's "Internationalization remains minimal"
  observation, at
  [`docs/operations/principal-architecture-review-2026-08-18.md`](../operations/principal-architecture-review-2026-08-18.md),
  carries a Reading note pointing here. Minimal is what this decision looks like
  from the outside.
