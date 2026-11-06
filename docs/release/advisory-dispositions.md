# Advisory dispositions

`docs/release/advisory-dispositions.json` is the tracked list of recorded decisions about
dependency advisories. It started empty. Its first entries record the 2026-11-06 review
(`FR-R5-F21`): one `accepted` entry per finding of that day's captures of both trees, 86 in all,
each expiring 2027-02-04. A finding with no entry is not pre-decided. Two commands read it and
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
| `status` | `actionable`, `accepted` or `inapplicable`: a label, not an instruction (see below) |
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
  and it has not expired.
- **expired**: an entry names the finding, but its expiry has passed.
- **does-not-cover**: an entry names the finding but is for the other tree, or its range leaves an
  installed version out.
- **not-recorded**: no entry relates to the finding.

An uncovered finding (`not-recorded`, `expired` or `does-not-cover`) is **reported, not refused**.
Release preparation refuses only for the seven conditions in [releasing](../../RELEASE.md).

## What a disposition does not do

- **It is not a waiver.** `accepted` is a label. It does not suppress a finding, change a count,
  change whether a capture is complete, or permit anything; the finding is listed whatever its
  verdict.
- **It does not establish present exploitability or its absence.** An advisory record is the
  registry's data at the time of capture, and a disposition is a person's decision about it.
- **It is not signed.** The list is an ordinary tracked file. Its authenticity is the review of the
  commit that changed it.

<!-- Source: scripts/release-advisory.mjs -->
<!-- Source: scripts/advisory-dispositions.mjs -->
