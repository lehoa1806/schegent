# Release documentation

This directory holds the live release gates, qualification matrices, advisory dispositions, and retired hosted-CI records referenced by the local release procedure.

Start from **[Releasing Schegent (`RELEASE.md`)](../../RELEASE.md)** for the end-to-end local release workflow — see [Release boundary](../../RELEASE.md#release-boundary) and [Step 1: Choose and record the version](../../RELEASE.md#1-choose-and-record-the-version) — or return to the [documentation index](../README.md).

## Live release gates, matrices & controls

Current records consulted when preparing, qualifying, or auditing a local VSIX release candidate (`npm run release`).

| File | Role |
|---|---|
| [Current release controls](current-release-controls.md) | Generated single present-tense authority for what actually runs in this tree today (`FR-R3-138`). |
| [Qualification matrix](qualification-matrix.md) | Node 22 and 24 across macOS, Linux, and Windows — each cell is either an observed run with five recorded facts or explicitly `unobserved` with its prerequisite (`FR-R4-F09`). |
| [Backend qualification log](backend-qualification-log.md) | Live backend canary results produced by `npm run canary` (`FR-R3-084`, `FR-R3-104`). |
| [Advisory dispositions](advisory-dispositions.md) | Policy, field definitions, and rationale requirements governing dependency advisories; `accepted` is a recorded disposition label, not a waiver (`FR-R4-F09`). |
| [`advisory-dispositions.json`](advisory-dispositions.json) | Machine-readable disposition ledger validated during `npm run release` against current dependency audit output. |
| [Held major dependency upgrades](held-major-upgrades.md) | Deliberate semver-major dependency holds, rationale per package, and 90-day review cadence (`FR-R3-090`). |
| [Assistive-technology matrix](accessibility-at-matrix.md) | Per-platform screen-reader testing matrix (`VoiceOver`, `NVDA`, `Narrator`, `Orca`); every row is currently `UNTESTED`, and automated accessibility scans are not a substitute for manual screen-reader verification (`FR-R3-091`, `FR-R3-131`). |
| [Node 22 floor record](node-floor-record.md) | Latest plain-Node toolchain run on the declared Node 22 floor and what that run does not establish; distinct from a full qualification cell (`FR-R5-F21`). |

## Historical & terminal records

These pages carry `<!-- doc-class: record -->` and document hosted GitHub Actions controls that were **retired by operator decision on 2026-08-26** (`FR-R3-099`). Retain them as historical evidence; never cite them as present-tense release controls.

| File | Historical scope |
|---|---|
| [GitHub Actions — Terminal Record](actions-terminal-record.md) | Final capture of the eight retired workflows before hosted Actions were disabled on 2026-08-26. |
| [Withdrawn CI-dependent controls](withdrawn-ci-controls.md) | Inventory of retired hosted controls (GitHub Release artifacts, OIDC provenance, CodeQL, scheduled audits/canaries) and their local substitutes or explicit absence. |
| [Canary credentials: withdrawn request](canary-credential-request.md) | Historical itemized credential request withdrawn on 2026-08-26 when scheduled hosted workflows were retired (`FR-R3-084`, `FR-R3-099`). |
