# Gate integrity measurements

**Captured**: 2026-08-25 · **Feature**: 155 (`FR-R3-088`) · **Tree**: `repo/` at `8a375967`

FR-R3-088's frame: *"A gate I wrote to pass my own code is not independent evidence about my code."*
Four of its consequences are measurable, and this file is where the measurements live. Every number
here is produced by a run, not transcribed — the tests that produce them assert against this file, so
the two cannot drift.

---

## 1. Vacuity detector false-negative rate

**Produced by**: `repo/tests/lint/gate-integrity/vacuity-false-negative-census.test.ts`

    vacuity-census-denominator: 79

| Measure | Value |
|---|---|
| Gates the detector calls **controlled** (the denominator) | **79** |
| Still called controlled after their control is stripped | **0** |
| **False-negative rate under this mutation** | **0.0%** |

**Method.** Every gate the detector classifies as controlled — a **full census**, no sampling and no
seed, so the denominator cannot be narrowed to improve the number. Each gate's source is neutered *in
memory*: every recognised control idiom is stripped, leaving a gate that walks a tree, asserts
emptiness, and proves nothing about its scan. The detector's own predicate is then re-run on the
result. Nothing on disk is modified.

**What this number is.** Evidence that the detector reliably notices when a gate's control idiom is
removed. Under this specific mutation it missed nothing across 78 gates.

**What this number is NOT**, and the limit matters more than the value:

- It measures the detector against **one** mutation — removing the recognised control idioms. A gate
  can be vacuous in ways this does not model: a control that is *present but constrains nothing*, an
  anchor assertion that can never fail, a floor set to zero. Those gates are inside the denominator
  and the mutation does not disturb them, so they are **not** covered by this rate.
- A 0.0% rate does **not** mean no gate in the tree is vacuous. It means the detector sees the
  absence of a control when a control is absent.

**If this number gets worse, the finding is the number.** Improving it by narrowing the census, or by
widening the detector until the mutation stops working, is the exact failure FR-R3-088 §5 names. The
test therefore asserts that the rate is *measured and recorded* — never that it is below a threshold.

---

## 2. Zero-offender gates

**Produced by**: `repo/tests/lint/gate-integrity/zero-offender-census.test.ts`

See that test's printed output for the generated list. The list is **derived from the tree on every
run**, never transcribed here — a checked-in copy is exactly the stale-record shape this tier exists
to remove.

---

## 3. Product coverage versus test-suite coverage

**Produced by**: `repo/scripts/test-census.mjs`

**Measured 2026-08-25**:

| | Files | Cases | Share of cases |
|---|---|---|---|
| About the **product** | 549 | 6,175 | **65.7%** |
| About the **test suite** | 348 | 3,226 | **34.3%** |
| Total | 897 | 9,401 | |

**A third of the suite's cases are tests about the test suite.** That is the reviewer brief's concern
with a number attached, and it is the first time the two have been reported separately.

Run `node scripts/test-census.mjs` for the current split. The assignment rule, which a reader can
apply without consulting a list:

> A test whose subject is a file under `tests/` is a test **about the test suite**.
> A test whose subject is a file under `src/` or `webview-ui/src/` is a test **about the product**.

FR-R3-088 §5's concern is that one figure has been read as the other. Two figures are now reported,
and `coverage-split.test.ts` asserts the census holds **no** hand-maintained list of test files — a
list would let whoever maintains it decide which side a test falls on, which is the authorship
problem FR-R3-088 is about, one level up.

### Allowlist path-claim coverage — re-derived

`allowlist-entries-still-apply.test.ts` now prints its own fraction on every run:
**70 of 334 path claims (21.0%)** across 59 gates that make one, over 3 readable gates.

The reviewer brief measured **69 of 316**. Re-deriving gave 70 of 334 — the tree grew. The brief
itself noted that its first figure ("roughly 319") was wrong by three when re-measured, and the same
thing has now happened again. That is the argument for printing the fraction rather than recording
it: **a number stated once and not re-derived drifts, every time.**

---

## 4. Webview dead-code classification — **RE-VERIFIED**

**Produced by**: `repo/tests/lint/gate-integrity/webview-dead-code-reverification.test.ts`

The reviewer brief's objection was the right one: *"If that classification is wrong, the real figure
is worse."* Re-reading a classification reproduces whatever its first author concluded, mistakes
included — so this re-derives it.

| Component | Statements | Importers outside `__tests__` |
|---|---|---|
| `HoverText.svelte` | 179 | **0** |
| `ControlPanel.svelte` | 104 | **0** |
| `QueueList.svelte` | 41 | **0** |
| `PhaseTracker.svelte` | 36 | **0** |
| `LiveActivityHeader.svelte` | 33 | **0** |
| `StatusHeader.svelte` | 14 | **0** |
| **Total** | **407** | — |

**Verdict: the 407-of-461 figure holds.** All six are unimported outside tests, and the per-component
counts sum to 407. *Dead* means unimported; the statement count is what it costs, not what makes it
dead.

The test re-derives this on every run against a scan asserted non-empty, and pins the config's own
inventory against the same numbers so neither can drift alone. **If a component gains an importer the
test goes red — and that is the good outcome**: it means 407 is wrong and the webview coverage figure
should be read as a testing gap rather than a dead-code inventory.

---

## 5. Non-vacuity controls added by feature 155

Every gate this feature adds was exercised in both directions — introduce the offence, observe red,
revert, observe green — before it was called done. A gate whose red state was never observed is a
gate with an unproven failure path.

| Gate | Control |
|---|---|
| `tests/lint/backend-kind-placement.test.ts` | value import added to a real config module; type-only import must NOT report; re-export hub detected |
| `tests/contract/backend-kind-move-equivalence.test.ts` | pre-move literals are not read from the module under test |
| `tests/unit/build/require-full-gate.test.ts` | skipped job refuses / same job successful passes |
| `tests/unit/build/full-gate-parity.test.ts` | job name removed from `REQUIRED_JOB_NAMES` → 2 assertions red; reverted → green |
| `scripts/envelope-doc-liveness.sh` | dead path → red naming it; reverted → green; backend names stripped → red |
| `tests/lint/gate-integrity/vacuity-false-negative-census.test.ts` | the mutation is pinned against a synthetic control of each recognised shape |

---

## 6. Single-authority audit (FR-082)

| Fact | Authority | Derives from / checks against it |
|---|---|---|
| Full-gate job set | `.github/workflows/full-gate.yml` | `REQUIRED_JOB_NAMES` + the drift assertion in `full-gate-parity.test.ts` |
| Backend containment asymmetry | `repo/docs/security/threat-model.md` | envelope threat model, checked by `envelope-doc-liveness.sh` |
| Backend identity | `repo/src/contracts/backend-kinds.ts` | every importer; `backend-kind-placement.test.ts` |
| Vacuity control idioms | `tests/lint/gate-integrity/vacuity-detector.ts` | the gate and the census both import it |
