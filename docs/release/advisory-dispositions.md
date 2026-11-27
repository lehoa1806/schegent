# Advisory dispositions

`docs/release/advisory-dispositions.json` is the tracked list of recorded decisions about
dependency advisories. It started empty, held 86 entries from the 2026-11-06 review (`FR-R5-F21`),
was refreshed on 2026-11-23 (`FR-R7-14` / `14-12`) after `npm audit fix` eliminated all 14 High and
9 Moderate advisories (cutting findings from 61 → 7 in `root` and 24 → 7 in `webview-ui`), and was
re-verified live on **2026-11-24 (`FR-R8-03` / `03-05`)**: both trees remain at 7 normalized findings
each (`5 moderate`, `2 critical`, expiring `2027-02-22`), all 14 classified **`build-only`**
devDependencies (`@vitest/mocker`, `vitest`, `tinypool`, `glob`, `minimatch`) held behind
semver-major upgrades (`vitest@5.x` / `@vscode/vsce@4.x`) and verified absent from both shipped
runtime bundles (`dist/module-graph/host.json`: 0 bundled third-party packages;
`dist/module-graph/webview.json`: `svelte` and `esm-env` only) and `schegent-sbom.cdx.json`. Once
module graphs are built, **any finding not proven `build-only` (`usage: "shipped"` or
`usage: "unknown"`, including unmapped virtual modules or missing tree graphs) unconditionally
refuses release preparation** (`advisory-shipped`) even if an `accepted` disposition exists; any
remaining finding with no valid non-expired entry refuses release preparation (`advisory-uncovered`). Two commands read it and
nothing writes it:

- `npm run security:advisory-diff -- compare --dispositions docs/release/advisory-dispositions.json`
  shows each finding's verdict beside the comparison (see
  [the comparison page](../operations/dependency-advisory-comparison.md)).
- `npm run release` reads it to show each finding's verdict in the release output and the release
  record, and refuses a list it cannot use (see [releasing](../../RELEASE.md)).

The list changes **only in a reviewed commit**. Neither command edits, extends or reorders it.

## Format

Version 1, a JSON object with `dispositionListVersion: 1` and a `dispositions` array. Every field
below is required and a non-empty string.

| Field | Meaning |
|---|---|
| `advisory` | The advisory id: the canonical id or one of its aliases (for example a `GHSA-` id) |
| `ecosystem` | `npm` |
| `package` | The package the advisory is about |
| `tree` | `root` or `webview-ui`: the dependency tree the decision is about |
| `range` | A semver range. The entry covers a finding only when every installed version satisfies it |
| `status` | `actionable`, `accepted` or `inapplicable`: release preparation treats non-expired `accepted` and `inapplicable` entries covering all installed versions as satisfied, while `actionable` still refuses release preparation (`advisory-uncovered`) |
| `owner` | A name or handle the maintainer types. **It is not verified**: no identity check exists |
| `decidedOn` | `YYYY-MM-DD`, a real calendar date |
| `expiresOn` | `YYYY-MM-DD`. The entry stops covering at `00:00:00Z` on that day |
| `rationale` | **Added for release preparation.** A string of 1 to 2,000 characters: the reason, in the words a reader of this repository alone needs |

`rationale` is an extension under version 1. The comparison command ignores it, so a list that
carries it reads exactly as it did before. Release preparation requires it on every entry and
refuses the list as `dispositions-unusable` (`missing-rationale`) when one entry lacks it, is empty
or whitespace, or runs over 2,000 characters. The full decision record for an accepted finding
stays in the planning envelope; this field is the one-paragraph reason that travels with the
repository.

```json
{
  "dispositionListVersion": 1,
  "dispositions": [
    {
      "advisory": "GHSA-xxxx-xxxx-xxxx",
      "ecosystem": "npm",
      "package": "example-pkg",
      "tree": "webview-ui",
      "range": ">=1.0.0 <1.2.3",
      "status": "accepted",
      "owner": "maintainer-handle",
      "decidedOn": "2026-11-01",
      "expiresOn": "2027-02-01",
      "rationale": "Build-only: the package is not bundled into the webview, so it is not in the shipped code."
    }
  ]
}
```

## What a verdict means

Each finding in a release shows one verdict, decided by the comparison's own rule, evaluated at the
time of preparation:

- **covers**: an entry names the finding for this tree, its range covers every installed version,
  and it has not expired. Release preparation additionally requires `status` to be `accepted` or
  `inapplicable` (`actionable` refuses with `advisory-uncovered`).
- **expired**: an entry names the finding, but its expiry has passed.
- **does-not-cover**: an entry names the finding but is for the other tree, or its range leaves an
  installed version out.
- **not-recorded**: no entry relates to the finding.

Since `FR-R8-03` (`03-05`), once module graphs are supplied, **any finding whose bundled usage
classification is not `build-only` (`usage: "shipped"` or `usage: "unknown"`, including unmapped
virtual modules or a missing tree graph) unconditionally refuses release preparation**
(`advisory-shipped`, the eighth refusal condition in [releasing](../../RELEASE.md)) — an `accepted`
disposition cannot override a shipped or unverified-runtime advisory. Any remaining uncovered or
actionable finding (`not-recorded`, `expired`, `does-not-cover`, or `status: "actionable"`) **refuses
release preparation** (`advisory-uncovered`, the ninth refusal condition).
Every finding is still reported with its verdict, severity, and bundled usage classification;
`npm run security:audit` and `npm run security:advisory-diff` remain report-only outside release
verdicts.

## What a disposition does not do

- **It is not silent suppression.** `accepted` and `inapplicable` satisfy the release-preparation
  disposition gate while unexpired, but they never suppress listing the finding, change a count,
  or change whether a capture is complete; every finding is still reported in full alongside its
  registry severity and bundled-usage classification.
- **It does not establish present exploitability or its absence.** An advisory record is the
  registry's data at the time of capture, and a disposition is a person's decision about it.
- **It is not signed.** The list is an ordinary tracked file. Its authenticity is the review of the
  commit that changed it.

<!-- Source: scripts/release-advisory.mjs -->
<!-- Source: scripts/advisory-dispositions.mjs -->
