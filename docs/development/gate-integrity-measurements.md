# Gate integrity measurements

**Captured**: 2026-08-25 · **Feature**: 155 (`FR-R3-088`) · **Tree**: `repo/` at `8a375967`

FR-R3-088's frame: *"A gate I wrote to pass my own code is not independent evidence about my code."*
Four of its consequences are measurable, and this file is where the measurements live. Every number
here is produced by a run, not transcribed — the tests that produce them assert against this file, so
the two cannot drift.

---

## 1. Vacuity detector false-negative rate

**Produced by**: `repo/tests/lint/gate-integrity/vacuity-false-negative-census.test.ts`

    vacuity-census-denominator: 82

| Measure | Value |
|---|---|
| Gates the detector calls **controlled** (the denominator) | **82** |
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

| Gate | Control | Red observed |
|---|---|---|
| `tests/lint/backend-kind-placement.test.ts` | value import added to a real config module; type-only import must NOT report; re-export hub detected | yes |
| `tests/contract/backend-kind-move-equivalence.test.ts` | pre-move literals are not read from the module under test | yes |
| `tests/unit/build/require-full-gate.test.ts` | skipped job refuses / same job successful passes | yes |
| `tests/unit/build/full-gate-parity.test.ts` | job name removed from `REQUIRED_JOB_NAMES` → 2 assertions red; reverted → green | yes, by live mutation |
| `scripts/envelope-doc-liveness.sh` | dead path → red naming it; reverted → green; backend names stripped → red | yes, 9/9 selftest |
| `scripts/single-platform-qualifier.sh` | unqualified claim → red naming file and line; qualifier added → green; a qualifier 12 lines away does NOT discharge | yes, 8/8 selftest |
| `tests/lint/install-flag-parity.test.ts` | `--ignore-scripts` stripped from a real workflow's real text | yes |
| `tests/lint/held-major-staleness.test.ts` | a backdated row in the real record's real text | yes |
| `tests/lint/dependency-change-scope.test.ts` | a bumped range and an undeclared addition | yes |
| `tests/lint/retention-disclosure-parity.test.ts` | a perturbed constant makes the rendered table differ from the document | yes |
| `tests/unit/services/evidence-export.test.ts` | an unlisted file added to the artifact → red; removed → green | yes |
| `tests/unit/audit/platform-permission-modes.test.ts` | a loosened mode is detected | yes |
| `tests/a11y/a11y-scan.test.ts` (spec) | a baseline entry removed → `new: 1`, named; restored → green | yes, by live mutation |
| `tests/lint/a11y-policy-parity.test.ts` | a drifted statement and a widened tag set | yes |
| `tests/unit/services/capability-enforcement-plan.test.ts` | withholding a capability changes the argv — the plan is not a no-op | yes |
| `tests/integration/capability-refusal.test.ts` | narrowed set → refused at the attempt; widened set → same operation succeeds | yes |
| `tests/lint/capability-argv-parity.test.ts` | a drifted adapter literal | yes |
| `tests/lint/capability-text-contract-parity.test.ts` | an undeclared event-shaped token | yes |
| `tests/lint/expansion-freeze.test.ts` | each frozen pattern matched against its own probe | yes |
| `tests/lint/gate-integrity/vacuity-false-negative-census.test.ts` | the mutation is pinned against a synthetic control of each recognised shape | yes |
| `tests/lint/procedure-surface-registry.test.ts` | a registered probe surface: disagree → throws, agree → does not, unregistered → not checked | yes |

**Two of these were driven by a LIVE mutation of the real tree** — the job-name removal and the
accessibility baseline entry — rather than by an in-memory fixture. Where a live mutation was used, the
tree was restored and re-verified green in the same step.

---

## 6. Single-authority audit (FR-082)

| Fact | Authority | Derives from / checks against it |
|---|---|---|
| Full-gate job set | `.github/workflows/full-gate.yml` | `REQUIRED_JOB_NAMES` + the drift assertion in `full-gate-parity.test.ts` |
| Backend containment asymmetry | `repo/docs/security/threat-model.md` | envelope threat model, checked by `envelope-doc-liveness.sh` |
| Backend identity | `repo/src/contracts/backend-kinds.ts` | every importer; `backend-kind-placement.test.ts` |
| Vacuity control idioms | `tests/lint/gate-integrity/vacuity-detector.ts` | the gate and the census both import it |
| Run-id validity | `repo/src/contracts/run-id.ts` | the evidence export and the evidence delete both import it. Extracted during security review, which found the rule COPIED into both — a second authority introduced by the security fix itself, and the way it goes wrong is that one is tightened and the other is not, so a delete accepts an id an export refuses |
| Retention bounds | the retention constants in `src/audit/`, `src/services/`, `src/monitor/` | `retention-disclosure.ts` reads them; `retention-disclosure-parity.test.ts` gates the rendered document |
| Held major upgrades | `docs/release/held-major-upgrades.md` | `held-major-staleness.test.ts` resolves every row against the two manifests |
| Install-script policy | the workflow files **and** the two `.npmrc` files | neither derives from the other — npm reads one, Actions the other — so `install-flag-parity.test.ts` checks them against each other in both directions |
| Accessibility target | `PRODUCT.md` and `docs/prd-metrics-dashboard.md` | the scan's tag set; `a11y-policy-parity.test.ts` binds all three |
| Capability audit events | `src/contracts/audit-events.ts` | operator-facing text; `capability-text-contract-parity.test.ts`, checked contract-first |
| Default backend argv | the `UNBOUNDED_PERMISSION_ARGS` literal in each adapter | `unboundedArgs()` in the plan; `capability-argv-parity.test.ts`. **Two authorities on purpose**: four gates read the adapter source to prove the posture, and the plan needs the value to answer "what does the default produce?" — neither can be derived from the other without losing what the other provides. |

### Bounds, caps and coverage fractions this feature prints (FR-081)

Every one of these is emitted at run time rather than recorded here, so it cannot go stale:

| Printed by | What it declares |
|---|---|
| `vacuity-false-negative-census` | `mutated=N stillCalledControlled=M rate=R%`, plus what the mutation does **not** model |
| `zero-offender-census` | classifiable gates, tree files scanned, and **how many gate files were NOT classified** |
| `allowlist-entries-still-apply` | checked *N* of *M* path claims, the readable-gate count, and that a clean run is not a clean sweep |
| `scripts/test-census.mjs` | two coverage figures, the rule that assigns each, and what it does not measure |
| `scripts/envelope-doc-liveness.sh` | registered documents, spans resolved, spans excused, and the 2-line tombstone window |
| `scripts/single-platform-qualifier.sh` | its scan roots, its claim count, its discharge vocabulary, and what it does not check |
| `scripts/posture-status.sh` | three things it did **not** verify — unconditionally, not through `say()` |
| the accessibility scan | target, surface count, exclusion list (including when empty), and that a scan is not conformance |
| `docs/release/accessibility-at-matrix.md` | every supported platform, recorded **untested** |
| `tests/unit/audit/platform-permission-modes.test.ts` | the platform it did not exercise |
