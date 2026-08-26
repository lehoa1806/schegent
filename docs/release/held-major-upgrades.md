# Held major dependency upgrades

**Reviewed**: 2026-08-25 · **Review interval**: **90 days** · **Feature**: 155 (`FR-R3-090`)

`SUP-01` credits this repository's lockfiles, CI `--ignore-scripts`, audits, CodeQL and provenance as
real controls, and names one thing missing: *"intentionally ignored major upgrades drift from hardened
CI … review majors on cadence."* The holds are deliberate and correct. What was missing is a **date**.

**A held upgrade with no review date is indistinguishable from a forgotten one.** That is the whole
finding, and this record is the whole fix. `repo/tests/lint/held-major-staleness.test.ts` fails when
any `lastReviewed` below is more than 90 days old.

**This file does not bump anything.** `FR-R3-090` §5 is explicit: *"Do not bump the held majors as part
of this item. The cadence is the deliverable; the upgrades are their own changes with their own
verification. Bundling them hides a dependency bump inside a hardening change."*
`repo/tests/lint/dependency-change-scope.test.ts` enforces that for this feature's own diff.

---

## Held majors

| Package | Tree | Held at | Current major | Reason | lastReviewed |
|---|---|---|---|---|---|
| `@types/node` | both | `^22.20.1` | `26.x` | **Pinned to the runtime floor, not to the latest types.** `package.json` declares Node `^22 \|\| ^24` and CI verifies the 22 floor. Types ahead of the floor would let a `node:` API that does not exist on 22 typecheck clean and fail at runtime on the platform the floor exists to protect. This hold is load-bearing and moves only when the floor moves. | 2026-08-25 |
| `globals` | repo | `^14.0.0` | `17.x` | Supplies environment globals to the flat ESLint config. Its majors reshuffle which environments exist and under what names; the config names a small, stable set. The upgrade is a config edit plus a full lint re-baseline, and a re-baseline bundled into an unrelated change is how a real regression hides behind a churned record. | 2026-08-25 |
| `jsdom` | webview | `^25.0.0` | `30.x` | The DOM the webview component suite runs against. Five majors of DOM-behaviour change would move rendering assertions across a 350-file suite, and separating "the upgrade broke this" from "this was always wrong" is the work — not the version bump. | 2026-08-25 |
| `@vscode/test-electron` | repo | `^2.3.9` | `3.x` | Drives the extension-host integration suite under Xvfb. Its major changes how the test Electron build is resolved and launched, which is the one part of the chain that cannot be exercised locally on this platform — see `92_FR-R3-092`. Upgrading it blind, with no remote matrix to catch a regression, is exactly the move `VER-1` makes unwise. | 2026-08-25 |

---

## What is NOT held

Every other dependency tracks its current major. `esbuild` (`^0.28.2`) and similar `0.x` packages have
no major to hold — a `0.x` bump is a minor by semver's own rules and is not a hold.

## How to review

On or before each `lastReviewed + 90 days`:

1. Re-derive the current major: `npm view <package> version`.
2. Decide. **Re-affirming a hold is a valid outcome** — the cadence exists so the decision is made
   again, not so the upgrade is taken.
3. Update `lastReviewed` and, if the reason has changed, the reason. A re-affirmed hold with an
   unchanged reason still gets a fresh date; that is what makes the date mean "someone looked".
4. If you take the upgrade, it is **its own change** with its own verification, and this row is
   deleted rather than re-dated.

**Do not re-date a row without looking.** A date is a claim that a person considered it, and this
record is worth exactly what that claim is worth.
