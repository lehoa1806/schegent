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
| macOS | 24 | observed | `npm run gate` | v24.21.0 | 97083a1b | exit 0 | 2026-10-22 | — |
| macOS | 22 | unobserved | — | — | — | — | — | a macOS machine running Node 22, then `npm run gate:record` on it |
| Linux | 24 | unobserved | — | — | — | — | — | a Linux host running Node 24, then `npm run gate:record` on it |
| Linux | 22 | unobserved | — | — | — | — | — | a Linux host running Node 22, then `npm run gate:record` on it |
| Windows | 24 | unobserved | — | — | — | — | — | a Windows host running Node 24; Windows is a stated permanent limit of this repository |
| Windows | 22 | unobserved | — | — | — | — | — | a Windows host running Node 22; Windows is a stated permanent limit of this repository |

## What the one observed cell is, and is not

The macOS / Node 24 cell quotes the newest gate record made on this machine: `npm run gate`,
Node v24.21.0 on darwin/arm64, exit 0, recorded 2026-10-22 at commit `97083a1b`. That commit is
**older than the commit a release is prepared at**, and it is named so that no reader takes the cell
for an observation of the current tree. A newer record replaces it.

Two limits come with it. The repository pins Node 24.19.0 in `.nvmrc`, and the record ran on
v24.21.0; a gate record at version 3 states both beside each other and prints a difference, and a
difference is carried, not refused. And the record was made before the version-3 fields existed, so
it does not say whether the workspace envelope was present or what was installed; a release needs a
newer record anyway.

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
   date of `recordedAt` into the cell. Do not copy a result from another platform.
3. A standalone clone records that the workspace envelope was absent. The gates that read the envelope
   skipped, and the cell is still an observation of what did run; say so beside it.
4. Installing and running a release candidate is its own observation, recorded in
   [releasing](../../RELEASE.md) and not here.

<!-- Source: scripts/gate-recorder.mjs -->
<!-- Source: scripts/gate-observation.mjs -->
<!-- Source: tests/lint/qualification-matrix-shape.test.ts -->
