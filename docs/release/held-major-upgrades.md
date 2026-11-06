# Held major dependency upgrades

**Reviewed**: 2026-11-06 · **Review interval**: **90 days** · **Feature**: 155 (`FR-R3-090`)

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
| `@types/node` | both | `^22.20.1` | `26.x` | **Pinned to the runtime floor, not to the latest types.** `package.json` declares Node `^22 \|\| ^24`. The hosted workflows that ran the 22 floor were retired on 2026-08-26 (`FR-R3-099`). It was exercised again on 2026-11-06 under Node 22.23.2 (`test:host`, `build` and `sbom`, macOS only), and the [Node 22 floor record](node-floor-record.md) states what that run does and does not show. Types ahead of the floor would let a `node:` API that does not exist on 22 typecheck clean and fail at runtime on the platform the floor exists to protect. This hold is load-bearing and moves only when the floor moves. | 2026-11-06 |
| `globals` | repo | `^14.0.0` | `17.x` | Supplies environment globals to the flat ESLint config. Its majors reshuffle which environments exist and under what names; the config names a small, stable set. The upgrade is a config edit plus a full lint re-baseline, and a re-baseline bundled into an unrelated change is how a real regression hides behind a churned record. | 2026-11-06 |
| `jsdom` | webview | `^25.0.0` | `31.x` | The DOM the webview component suite runs against. Six majors of DOM-behaviour change would move rendering assertions across a 350-file suite, and separating "the upgrade broke this" from "this was always wrong" is the work — not the version bump. | 2026-11-06 |
| `@vscode/test-electron` | repo | `^2.3.9` | `3.x` | Drives the extension-host integration suite, which runs locally on macOS only: there is no remote matrix. Its major changes how the test Electron build is resolved and launched, which is the one part of the chain that no platform other than this macOS machine can exercise — see `92_FR-R3-092`. Upgrading it blind, with no remote matrix to catch a regression, is exactly the move `VER-1` makes unwise. | 2026-11-06 |
| `@secretlint/node` | repo | `^10.2.2` | `13.x` | **Held with the secretlint family, which `@vscode/vsce` depends on at 10, in 3.x and in 4.x.** `vsce` takes `secretlint`, this engine and the preset at `^10.1.2`, and the release scanner runs the 10.2.2 preset ruleset. `secretlint` and `@secretlint/secretlint-rule-preset-recommend` are declared at `^10.2.2` too and would move with it: aligning on 13 is a major upgrade of both that would change the rules that run today. Reviewed when `vsce` moves to the 13 family. The hold was decided in feature 256 (`FR-025`, research `R19`); the registry review it left pending (`FR-027`) is the 2026-11-06 entry below. | 2026-11-06 |

---

## Review 2026-11-06

Feature 282 (`FR-R5-F21`). Each hold was re-read against the registry on this date (UTC), under Node 24.19.0. `Locked` is `current` from `npm outdated`. The consumers come from a fixed-string search of `src/`, `tests/`, `scripts/`, `webview-ui/src/`, both manifests and the config files, excluding `node_modules`, lockfiles and Markdown.

### `@types/node`

- **Observed**: 26.6.6, the `latest` dist-tag. Command: `npm view @types/node version`, run in `repo/` and again in `repo/webview-ui/`, with the same answer. Held at `^22.20.1` in both trees, locked 22.20.1.
- **Consumers**: no file imports it. It supplies ambient types to every host source file that uses a `node:` API. Two lint gates name it: `tests/lint/dependency-change-scope.test.ts` and `tests/lint/held-major-staleness.test.ts`.
- **Decision**: reaffirm. The hold follows the declared runtime floor, and `engines.node` is still `^22 || ^24`. Types ahead of 22 would let a `node:` API that 22 lacks typecheck clean.
- **Floor**: exercised on the same day under Node 22.23.2, with no failure specific to Node 22. The [Node 22 floor record](node-floor-record.md) has the commands, the counts and the limits of that run.

### `globals`

- **Observed**: 17.14.0, the `latest` dist-tag. Command: `npm view globals version`, run in `repo/`. Held at `^14.0.0`, locked 14.0.0.
- **Consumers**: `scripts/lint-config.mjs` alone, which reads `globals.node` and `globals.browser`.
- **Decision**: reaffirm. The upgrade is still a lint config edit plus a full lint re-baseline. `eslint` and `@eslint/js` are also a major behind on this date (see below), so one deliberate lint upgrade could re-baseline once rather than twice.

### `jsdom`

- **Observed**: 31.0.0, the `latest` dist-tag. Command: `npm view jsdom version`, run in `repo/webview-ui/`. This row said `30.x`, which is corrected to `31.x`. Held at `^25.0.0`, locked 25.0.1.
- **Consumers**: `webview-ui/vitest.config.ts` (`environment: 'jsdom'`). Also the webview component and store suites under `webview-ui/src/`, and three root tests that name it: `tests/integration/hover-text-popover.host.test.ts`, `tests/lint/settings-group-heading-parity.test.ts` and `tests/visual/webview.visual.spec.ts`.
- **Decision**: reaffirm. The reason stands. Its count of majors moves from five to six.

### `@vscode/test-electron`

- **Observed**: 3.1.0, the `latest` dist-tag. Command: `npm view @vscode/test-electron version`, run in `repo/`. Held at `^2.3.9`, locked 2.5.2.
- **Consumers**: `tests/integration/runTest.ts` and `tests/integration/vscode-test-executable.ts`. Also the integration suites that launch through them (`multi-root`, `open-dashboard-no-workspace`, `trust-untrusted-workspace`, `hover-text-popover`), `tests/e2e/pipeline.test.ts` and `src/config/general-settings.ts`.
- **Decision**: reaffirm. `repo/.github/workflows/` does not exist, so the extension-host suite still runs only on this macOS machine. No remote matrix would catch a launch regression.

### `@secretlint/node`

- **Observed**: 13.1.0, the `latest` dist-tag. Command: `npm view @secretlint/node version`, run in `repo/`. Held at `^10.2.2`, locked 10.2.2.
- **`vsce`**: `npm view @vscode/vsce@3.9.2 dependencies --json` gives `secretlint`, this engine and the preset at `^10.1.2`; 3.9.2 is the declared and locked `vsce`. The latest `vsce` is 4.1.0, from `npm view @vscode/vsce version dependencies --json`. It takes `@secretlint/core` and the preset at `^10.2.2`.
- **Consumers**: `scripts/scan-secrets.mjs` and `tests/unit/build/secret-scan-harness.ts`.
- **Decision**: reaffirm. The condition this hold names, `vsce` moving to the 13 family, has not happened in either `vsce` major. This is the registry review that feature 256 (`FR-027`) left pending.

---

## What is NOT held

On 2026-11-06, `npm outdated --json --all=false` was run in `repo/` and in `repo/webview-ui/`; both
exited 1. It listed eleven direct dependencies a major behind (the major of `latest` above the major
of `wanted`) with no hold:

- root: `@eslint/js` and `eslint` 9 to 10, `typescript` 5 to 7, `vitest` and `@vitest/coverage-v8`
  3 to 5, `@vscode/vsce` 3 to 4;
- `webview-ui`: `typescript` 5 to 7, `vite` 7 to 8, `vitest` and `@vitest/coverage-v8` 3 to 5,
  `@sveltejs/vite-plugin-svelte` 6 to 7.

These are not holds: no one decided to keep them, and this record does not decide it now. Each
becomes its own change or a row above. `esbuild` (`^0.28.2`) and similar `0.x` packages have
no major to hold — a `0.x` bump is a minor by semver's own rules and is not a hold.

## Intentional dependency change

Moving a declared range on purpose, a held major included, updates these files in the same change,
or `tests/lint/dependency-change-scope.test.ts` fails:

- the `PINNED` range for the package in `tests/lint/dependency-change-scope.test.ts`;
- the pin counts ("18 of the 22" today) in `.github/dependabot.yml` and, twice, in
  `docs/operations/gate-recording.md`, when the number of pinned ranges changes;
- the package's row under **Held majors** above: deleted when the hold is taken, re-dated with a
  review entry when it is reaffirmed;
- `package.json` and `package-lock.json`, and `webview-ui/package.json` and
  `webview-ui/package-lock.json` when the package is declared there.

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
