# Qualification matrix

**What was observed, on which platform and Node, and what was not.** The extension declares Node
`^22 || ^24` and is built on macOS. A gate record says that `npm run gate` passed on one machine
at one commit; it says nothing about the other five combinations below. This page keeps those
five visible instead of letting one passing run stand for all six.

Each cell has exactly one of two shapes (`FR-R4-F09`, `FR-033`):

- **observed**: the command, the full runtime version, a commit of at least seven hex digits, an
  exit code and a date, all five, taken from a gate record. Nothing is inferred from another cell.
- **unobserved**: the word `unobserved` and the prerequisite someone would need to observe it.

There is no third shape. A cell that says a platform "passed" without those five facts is a defect,
and `tests/lint/qualification-matrix-shape.test.ts` reports it by name.

| OS | Node | State | Command | Runtime | Commit | Outcome | Date | Prerequisite |
|---|---|---|---|---|---|---|---|---|
| macOS | 24 | observed | `npm run gate` | v24.19.0 | 5a8af6b0 | exit 0 | 2026-11-01 | — |
| macOS | 22 | unobserved | — | — | — | — | — | a macOS machine running Node 22, then `npm run gate:record` on it |
| Linux | 24 | unobserved | — | — | — | — | — | a Linux host running Node 24, then `npm run gate:record` on it |
| Linux | 22 | unobserved | — | — | — | — | — | a Linux host running Node 22, then `npm run gate:record` on it |
| Windows | 24 | unobserved | — | — | — | — | — | a Windows host running Node 24; Windows is a stated permanent limit of this repository |
| Windows | 22 | unobserved | — | — | — | — | — | a Windows host running Node 22; Windows is a stated permanent limit of this repository |

The macOS / Node 22 cell stays `unobserved` even though the floor was exercised on 2026-11-06. The
[Node 22 floor record](node-floor-record.md) covers a plain-Node run of `test:host`, `build` and
`sbom` under Node 22.23.2. It is not a gate observation: `npm run gate` did not run, and
`npm run gate:record` recorded nothing. A cell holds only what a gate record says.

## What the one observed cell is, and is not

The macOS / Node 24 cell quotes a version-3 gate record made on this machine: `npm run gate`,
Node v24.19.0 on darwin/arm64, exit 0, recorded 2026-11-01 at commit `5a8af6b0`. The record states
four more facts beside those five, and they are copied here because the record is one ignored,
overwritable file (`.gate-attestation.json`) and the next `npm run gate:record` replaces it:

- **Pinned runtime.** The Node that ran, v24.19.0, is the Node the repository pins in `.nvmrc`
  (24.19.0). The record states both and says they match.
- **Clean tree.** The working tree was clean when the gate ran.
- **Envelope.** The workspace envelope was present, so the gates that read it ran.
- **Installs.** Both installed trees, the root and `webview-ui`, matched their lockfiles.

That commit is **older than the commit a release is prepared at**, and it is named so that no reader
takes the cell for an observation of the current tree. `npm run release` reads a record that names
the commit it prepares and refuses a record about any other commit, so this cell never stands in for
that record. A newer record replaces it.

## The Node 24 crash note

On Node 24.19.0 on arm64 macOS, `test:host` has died with `Segmentation fault: 11` and zero test
failures. The diagnosis, and what to do when it happens, is in
[the crash note in CONTRIBUTING.md](../../CONTRIBUTING.md) (the `Segmentation fault: 11` paragraph).
It is not worked around. **A newer patch version is not evidence of a fix**: a gate record under a
later Node proves that run passed, and does not prove the crash is gone. If the crash recurs during a
recorded run, the re-run is recorded as such, as that note instructs.

## Filling a cell

1. On the platform and Node to be observed, run `npm run gate:record` at a clean commit.
2. Copy `command`, `nodeVersion`, `head` (at least its first seven characters), `exitCode` and the
   date of `recordedAt` into the cell. Do not copy a result from another platform. Copy what the
   record says about the pinned Node (`nodeMatchesDeclared`), the envelope and each tree's install
   into the section "What the one observed cell is, and is not" on the same day, before any later
   `npm run gate:record` overwrites the file. A difference in any of them is carried and printed, not
   refused, so it is said beside the cell.
3. A standalone clone records that the workspace envelope was absent. The gates that read the envelope
   skipped, and the cell is still an observation of what did run; say so beside it.
4. Installing and running a release candidate is its own observation, recorded in
   [releasing](../../RELEASE.md) and not here.

<!-- Source: scripts/gate-recorder.mjs -->
<!-- Source: scripts/gate-observation.mjs -->
<!-- Source: tests/lint/qualification-matrix-shape.test.ts -->
