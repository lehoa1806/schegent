# Visual gate preflight — recorded observations

FR-R3-065. The finding this closes was that `test:visual` needed a Chromium build no document declared,
and that a missing or stale build failed every case in the suite with the same missing-executable error
instead of naming the one setup step required.

These are observations, not assertions. Each carries the command, the date, the platform, the exit code
and the counts, so a later reader can tell what was actually run from what was merely intended.

## fail → install → pass

**Date**: 2026-08-24 · **Platform**: darwin/arm64 · **Playwright**: `@playwright/test` 1.62.1, resolving
`chromium-1234`

Every leg ran with `PLAYWRIGHT_BROWSERS_PATH` pointed at a scratch directory
(`/tmp/pw-obs-hC3qaW`), **not** at the developer's shared `~/Library/Caches/ms-playwright`. That choice is
part of the record: the sequence needs an unprovisioned cache, and deleting a shared cache to obtain one
would break every other project on the machine and require a 95 MiB download to undo. The scratch
directory was removed afterwards and the shared cache verified untouched.

| Leg | Command | Exit | Observed |
|---|---|---|---|
| 1. fail | `PLAYWRIGHT_BROWSERS_PATH=<scratch> npm run test:visual` | **1** | 7 lines of `visual-preflight:` output; **0** occurrences of `Executable doesn't exist`; the chain stopped before `build:webview` and before the runner started, so **no per-case failures at all** |
| 2. install | `PLAYWRIGHT_BROWSERS_PATH=<scratch> npx playwright install chromium` | **0** | 94.7 MiB downloaded; `chromium-1234`, `chromium_headless_shell-1234`, `ffmpeg-1011` provisioned (559 MiB on disk) |
| 3. pass | `PLAYWRIGHT_BROWSERS_PATH=<scratch> npm run test:visual` | **0** | **18 passed** in 10.5 s; **0** lines of `visual-preflight:` output — the preflight is silent when the browser is present |

The number that matters is leg 1's zero per-case failures. Before this change the same condition produced
eighteen of them, and eighteen red cases read as eighteen broken tests rather than as one missing setup
step. That misdirection, not the discoverability of the command, was the finding's actual cost.

## The review preflight chain, end to end

**Date**: 2026-08-24 · **Platform**: darwin/arm64 · **Command**: `npm run ci:fast` · **Exit: 0**

All eight targets completed: `typecheck:tests`, `lint`, `verify:all`, `test:evals`, `test:visual`,
`test:perf`, `build:host`, `package:smoke`. The host suite reported 8786 passed / 1 skipped, the visual
suite 18 passed, and the VSIX smoke build packaged 51 files.

This is the run this item closes on: a checkout provisioned with the documented setup steps and nothing
else reaches exit 0. The first attempt exited 1 — on `doc-orphan-pages`, because this very file was not
yet linked from anywhere. Recorded rather than quietly fixed, because it is a small instance of the same
class: a document nobody can reach is a document that does not exist, which is what an undeclared
prerequisite also is.

## A real regression is still a real regression

**Date**: 2026-08-24 · **Platform**: darwin/arm64

The acceptance criterion that a setup failure and a visual diff stay distinguishable was asserted by the
behaviour gate but not observed end to end, which review pointed out. Observed now.

`tests/visual/__screenshots__/activity-feed-dark.png` was corrupted in place (a byte band well past the
PNG header, so it still decodes and merely differs), then restored.

| Condition | Command | Exit | Output |
|---|---|---|---|
| Corrupted baseline | `npm run test:visual` | **1** | 3 × `toHaveScreenshot`, 1 × `Error: expect`, and **0** lines of `visual-preflight:` |
| Baseline restored | `npm run test:visual` | **0** | 18 passed; `git status tests/visual/` clean |

Zero preflight lines is the point. A contributor looking at the first line of output can tell "your change
moved a pixel" from "your machine is missing a browser" without reading further — which is the whole
behaviour this item buys, and the reason eighteen identical launch failures were the finding's real cost.

## The gates, observed non-vacuous

**Date**: 2026-08-24 · **Platform**: darwin/arm64

`npx vitest run tests/lint/procedure-surface-registry.test.ts` (then
`playwright-install-doc-parity.test.ts`, which FR-R3-088 migrated into that registry), three seeds,
each reverted:

| Seed | Result |
|---|---|
| `CONTRIBUTING.md` pinned `playwright@1.61.0` | **red**, naming the document, the documented command, and the declared 1.62.1 |
| `developer-workflows.md` pinned the range `playwright@^1.62` | **red**, naming the range and why a range is not a reproducible instruction |
| `playwright.config.ts` switched to `firefox` | **red**, naming the browser the config launches and the preflight does not check |

And the tolerance direction, which matters just as much: rewording the prose around the command —
"needs a Chromium build that" → "depends upon a Chromium browser build which" — left the gate **green**
(7 passed). A gate that fires when someone improves a sentence is a gate that gets switched off.

The preflight's own behaviour gate (`playwright-browser-preflight.test.ts`, 14 cases) exercises the
absent, stale, half-installed, shell-only, indeterminate and present paths as a child process against
redirected caches.

## The fourth cache state

**Date**: 2026-08-24 · **Platform**: darwin/arm64 · **Command**:
`PLAYWRIGHT_BROWSERS_PATH=<scratch> node scripts/check-playwright-browser.mjs`

A cache holding an empty `chromium-1234` — what an install interrupted during extraction, or one
provisioned for a different platform, leaves behind — exited **1** with the right remedy but the wrong
sentence: *"No Chromium build is present, so this cache has never been provisioned."* The reader can see
`chromium-1234` in the cache, so that is the same contradiction between the diagnosis and the visible
cache that the shell-only branch was added to remove, one state further out. The preflight now names it
as a half-installed build. The remedy is unchanged; only the sentence is.

Reverting that branch turns the new case red on the "never been provisioned" assertion and leaves the
other 13 green, so the addition is not vacuous.

## The build a headless run actually starts

**Date**: 2026-08-24 · **Platform**: darwin/arm64

A headless launch with no `channel` — which is what `playwright.config.ts` configures — does not start the
build `chromium.executablePath()` names. It starts `chromium_headless_shell-<rev>`, a separate download
cached beside the headed one; leg 2 above provisioned both, which is why the fail → pass sequence did not
expose the difference.

Measured against a scratch cache holding `chromium-1234` and no shell:

| Command | Exit | Observed |
|---|---|---|
| `PLAYWRIGHT_BROWSERS_PATH=<scratch> node scripts/check-playwright-browser.mjs` (headed check only) | **0** | reported nothing, having promised it had checked |
| `chromium.launch()` against the same cache | — | `browserType.launch: Executable doesn't exist at …/chromium_headless_shell-1234/…` |
| the same preflight, once it also checks the shell | **1** | one `visual-preflight:` block naming `chromium_headless_shell-1234`, the path, and the install command |

The preflight therefore checks both builds. The remedy is unchanged — `npx playwright install chromium`
fetches both — so what changed is only that a half-finished or `--no-shell` install is named here instead
of at the first launch. `playwright-browser-preflight.test.ts` pins the sequence, deriving the paths from
the preflight's own `Looked for:` output rather than from a cache layout hardcoded in the test.

## Two measurement errors worth recording

Both were made while building this, and both are the same class as the finding itself — a check that looks
at the wrong thing and reports confidently.

1. **A case-count floor of 18 failed against an untouched suite.** The suite reports 18 cases from **4**
   literal `test(` calls; the rest are generated by parameterised loops over themes, surfaces and routes.
   A source-text count is not the case count. No case count is asserted now, and the reason is recorded at
   the assertion.
2. **A "never reports success" check matched `ok` inside "looked for".** Substring matching over prose,
   firing on the gate's own remedy text. It now matches whole words.

## What is not covered

- The preflight checks **existence, not integrity**. A truncated or corrupt executable passes it and fails
  at launch. Detecting that requires launching a browser, which is the cost this design exists to avoid.
- A visual case **deleted outright** is not detected. What is detected is the likelier shape — a case
  silenced in place with `.skip` / `.fixme` / `.only` to get a chain green.
- The parity gate reads **code spans, never prose**. A document can describe the wrong thing in a sentence
  and pass; that boundary is deliberate.
