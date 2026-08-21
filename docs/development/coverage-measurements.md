# Coverage measurements

Measured coverage figures, recorded at the moment a gate's shape was decided, so
that a later reader can tell a threshold chosen from evidence from one chosen from
habit. Every entry states what was run, on what, and what the run's exit status
was.

This file exists because a threshold is only as honest as the measurement behind
it. `vitest.config.ts` carried a derivation comment naming "branch 056" figures
long after the tree had moved past them, and the one number in it that had drifted
most — branches, recorded at ~84.1% against 88.11% actual — drifted unobserved
precisely because nothing wrote the measurement down where it could be compared.

---

## 2026-08-22 — the host composition root, before and after inclusion

**Why measured.** `coverage.exclude` in [vitest.config.ts](../../vitest.config.ts)
excluded `src/extension.ts` — 1,334 lines of activation composition root — on the
stated grounds that its seams are "exercised end-to-end via integration tests, not
unit tests". Those integration tests are the twelve `*.host.test.ts` files, which
`vitest.config.ts` excludes from `npm run test`, and which `ci.yml` reaches only
after the Linux-only visual-regression step. So the exclusion needed either a
premise that holds or removal, and the deciding fact was the size of the coverage
drop nobody had measured.

**Environment.** darwin, node per `.nvmrc`, branch
`110-coverage-and-budget-gate-completeness`, workspace `3abb100` / `repo/`
`a60e462`. Both runs taken before any configuration change.

**Commands.**

```bash
# baseline, config as it stood
npm run test:coverage

# with the composition root in the measured set: the override replaces the
# config's exclude array, dropping both `src/extension.ts` and the dead
# `src/**/*.d.ts` pattern
npm run test:coverage -- --coverage.exclude="src/ui/sidebar/messages.ts"
```

The override was confirmed to have taken effect by the file count in the report,
which went from 410 to 411.

| Metric | Baseline (excluded) | With `extension.ts` | Delta | Floor | Headroom after |
|---|---|---|---|---|---|
| Statements | 89.94% (38084/42340) | 89.64% (38720/43192) | −0.30 | 80 | +9.64 |
| Branches | 88.11% (13029/14787) | 88.09% (13081/14848) | −0.02 | 75 | +13.09 |
| Functions | 93.55% (2408/2574) | 91.65% (2437/2659) | −1.90 | 80 | +11.65 |
| Lines | 89.94% (38084/42340) | 89.64% (38720/43192) | −0.30 | 80 | +9.64 |

**Both runs exited 0.** Runtime 16.68s baseline, 16.05s included.

**`src/extension.ts` measured alone**: statements 74.64% (636/852), branches
85.00% (51/60), functions 34.11% (29/85), lines 74.64% (636/852).

**What the numbers decided.** Three quarters of the composition root's statements
are already exercised by the suite that runs on every `npm run test`. The
exclusion's premise was not merely unbacked — it named the wrong suite. Including
the file costs 0.30 points of line coverage against 9.64 points of headroom, so
the file was added to the measured set and **no threshold was changed**. The low
function figure (34.11%) is the honest shape of an activation entry: most of its
functions are callbacks handed to the host and invoked only by a running VS Code,
and it is now visible in the gate instead of hidden behind an exclusion.

Thresholds were deliberately **not** raised to match the measurement. A floor
pinned to what today's tree happens to hit turns the next legitimate refactor red
for no reason; the floors stay at 80/75/80/80 and this record is what a future
change argues against.

**Confirmed after the change**, with the configuration as it now stands: 411 files,
statements 89.64% (38720/43192), branches 88.11% (13088/14854), functions 91.65%
(2437/2659), lines 89.64%; exit 0. Statements and functions are byte-identical to
the override run above; branches read 13088/14854 here against 13081/14848 there,
a difference of 0.02 points on the same measured set. The v8 provider attributes
branch ranges from what actually executed, so that last digit carries run-to-run
noise — a second reason not to pin a floor to a measured value.

---

## 2026-08-22 — the webview, first measurement

**Why measured.** `webview-ui` held 39,353 lines of source against 37,496 lines of
test across 137 files with no coverage block, no thresholds, and no coverage
provider declared — so its `test:coverage` script could not run from a clean
install of that workspace, and nothing reported which of those lines were reached.

**Environment.** As above. The provider was installed transiently
(`npm --prefix webview-ui install --no-save @vitest/coverage-v8@^3.2.4`) so that
the measurement changed nothing in the tree.

**Measured set**: `src/**/*.ts` and `src/**/*.svelte`, excluding `*.test.ts` and
`src/**/__tests__/**` — **189 files**.

| Metric | Measured | Covered / total | Floor adopted |
|---|---|---|---|
| Statements | 84.97% | 12466/14671 | 79 |
| Branches | 79.60% | 4747/5963 | 74 |
| Functions | 81.06% | 865/1067 | 76 |
| Lines | 84.97% | 12466/14671 | 79 |

Floors are `floor(measured) − 5` per metric — real headroom for a legitimate
refactor, and the same practice the host's config documents.

**What the provider counts.** All 189 files of the measured set appear in the
report — **107 `.svelte` and 82 non-test `.ts`** — so un-imported Svelte
components are instrumented at 0% rather than omitted, and no component that
ships is excluded. Under the v8 provider `lines` and `statements` are the same
measure, which is why those two percentages are identical here and in the host.

**Nine files sit at 0%**, 461 statements in total (3.1% of the measured set):
`HoverText.svelte` (179), `ControlPanel.svelte` (104), `QueueList.svelte` (41),
`PhaseTracker.svelte` (36), `LiveActivityHeader.svelte` (33), `copy-text.ts` (27),
`StatusHeader.svelte` (14), `dashboard/main.ts` (14), and `main.ts` (13). They are
counted, not hidden.

**Why `__tests__/**` is out of the measured set.** The first run of this
measurement counted 198 files, and the nine extra ones were test scaffolding:
`launch-fixture.ts` (105 statements), `route-mount-ledger.ts` (64),
`queue-runtime-fixture.ts` (88), and six `.svelte` surfaces built only to be
mounted by a test (`HoverTextHarness.svelte` and five `Ledger*Surface.svelte`
fixtures) — 289 statements between them, exercised by construction. Counting them
read as 85.17 / 79.77 / 81.30 / 85.17, two tenths of a point better than the
product code actually is. They are excluded for exactly the reason `*.test.ts` is,
and this is not the Svelte-component exclusion the requirement forbids: every
component that ships is measured.

**A `.ts`-only measured set was also taken**, for comparison only: 80.52 / 83.75 /
79.44 / 80.52 over 7,229 statements. It is not the set adopted — excluding the
Svelte majority would reproduce exactly the defect that motivated this record —
but it shows the components contribute roughly half of the measured statements.

**Runtime.** Webview suite without coverage 9.13s; with coverage 9.96–11.50s over
three runs. The `verify:all` delta is therefore around **+1s on the webview leg**,
and the suite runs once in that chain rather than twice.

**Chain placement.** `verify:all` and `ci` both run `test:host &&
test:webview:coverage` where they previously ran `test` (itself `vitest run &&
npm --prefix webview-ui run test`). Splitting the composite into its two legs is
what lets the webview leg carry coverage without the suite running twice; the two
gates that pin chain shape — `tests/unit/build/preflight-coverage.test.ts` and
`tests/unit/build/release-gate.test.ts` — were updated together so both chains
name the same legs in the same order.

**Negative control.** With the statements floor raised above the measurement, the
gate fails as intended:

```
$ npx vitest run --coverage --coverage.thresholds.statements=90   # in webview-ui
ERROR: Coverage for statements (84.97%) does not meet global threshold (90%)
exit 1
```

Note that the override has to be passed to `vitest` directly. Through
`npm run test:webview:coverage -- --coverage.thresholds.statements=90` the flag is
swallowed: the outer npm appends it to `npm --prefix webview-ui run test:coverage`,
where the inner npm reads it as one of its own config options and never forwards
it. The first attempt at this control exited 0 for that reason and proved nothing.
