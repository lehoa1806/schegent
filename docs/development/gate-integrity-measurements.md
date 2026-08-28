# Gate integrity measurements

**Captured**: 2026-08-25 · **Feature**: 155 (`FR-R3-088`) · **Tree**: `repo/` at `8a375967`

FR-R3-088's frame: *"A gate I wrote to pass my own code is not independent evidence about my code."*
Four of its consequences are measurable, and this file is where the measurements live. Every number
here is produced by a run, not transcribed — the tests that produce them assert against this file, so
the two cannot drift.

---

## 1. Vacuity detector false-negative rate

**Produced by**: `repo/tests/lint/gate-integrity/vacuity-false-negative-census.test.ts`

    vacuity-census-denominator: 96

| Measure | Value |
|---|---|
| Gates the detector calls **controlled** (the denominator) | **96** |
| Still called controlled after their control is stripped | **0** |
| **False-negative rate under this mutation** | **0.0%** |

**Denominator movement during feature 156 (2026-08-26).** Every change to the census is recorded with
its cause, because a denominator that moves without explanation is how a measured rate gets improved by
narrowing its sample — the exact failure this measurement exists to prevent.

| Δ | Gate | Cause |
|---|---|---|
| **−1** | `install-flag-parity.test.ts` | Left the controlled set. It walked `.github/workflows/` and asserted a floor of five files — that walk was its vacuity control, since an empty walk would have let its parity assertions pass over nothing. `FR-R3-099` deleted all eight workflows, so the gate was rewritten to read two `.npmrc` files and the documents that teach the install sequence. It scans no directory now, so there is no scan whose emptiness could hide a pass, and the detector correctly stops classifying it. **A reclassification, not a regression**: it kept a non-vacuity test (it mutates the real `.npmrc`) and gained one the old form could not make — that no workflow directory has reappeared to become a second authority on the install policy |
| **+1** | `actions-retirement-claims.test.ts` | Joined. Scans both trees' Markdown for the falsehood `FR-R3-099` repaired, and carries a floor asserting the scan found documents in *both* trees, so a directory rename cannot empty it into a silent pass |
| **+1** | `reference-doc-claims.test.ts` | Joined. Covers `repo/docs/reference/`, the directory two independent reviews found uncovered, and carries a page-count floor plus a check that its own per-file exemption list is truthful |

| **+1** | `webview-host-import-direction.test.ts` | Joined. Pins webview → host imports to `src/contracts/` for values and to type-only elsewhere; carries a floor asserting the scan found more than twenty host imports, so a directory rename cannot empty it |
| **+1** | `no-new-error-cast.test.ts` | Joined. A shrink-only baseline over `(err as Error).message`; carries a floor on the number of source files scanned, so a rename cannot report zero casts as progress |
| **+1** | `dependency-direction.test.ts` | Joined. Refuses a value import from a leaf layer (`contracts`, `lib`) into a layer that acts; carries a floor asserting both leaf directories contain sources |

Net **82 → 86**. The false-negative rate is **0.0%** at every intermediate state; no gate was
removed from the census and none was added to move the number.

Two gates added by feature 156 are deliberately **not** in the census, and the reason is the
detector's own definition rather than an exemption: `key-fixture-bodies-are-filler.test.ts` and
`launch-config-outfiles.test.ts` read a fixed, named set of files rather than walking a tree, so
there is no scan whose emptiness could hide a pass and nothing for a vacuity control to protect.
`webview-bundle-boundary.test.ts` is out for a different reason worth stating: it walks a tree
that may legitimately be absent (`dist/webview/` before a build), and it reports that as a
**skip** rather than a pass — which is the property the detector looks for, expressed by a
console warning rather than by the idiom the detector recognises.

**Denominator movement after feature 156, and a reconciliation (2026-08-27, `FR-R3-124`).** The
machine-readable line above is asserted against a live run by
`vacuity-false-negative-census.test.ts`; the table beside it is prose, and the two had **drifted**.
The line reached 89 across three features while the table still read 86 — the record-versus-tree
divergence this round has now closed five times, sitting inside the measurement that exists to
measure exactly that class. Both now read 90, and the three unrecorded movements are named:

| Δ | Gate | Cause |
|---|---|---|
| **+1** | (86 → 87, `062b26fb`, feature 157) | Joined during "the execution repository verifies alone, and four gates were wrong not one". Not recorded here at the time; identified by `git log -S` on this line. |
| **+1** | (87 → 88, `32c963a1`, feature 157) | Joined during "one answer per mechanism, and the gate class that was missing". Same omission. |
| **+1** | (88 → 89, `1a33112d`, feature 157) | Joined during "the platform claim matches the platform evidence". Same omission. |
| **+1** | `import-graph-acyclic.test.ts` (91 → 92) | Joined. `FR-R3-128` — walks the whole first-party import graph and fails on any cycle, replacing the admission `ARCHITECTURE.md` used to carry. Three controls: a node floor, an edge floor, and an injected three-module cycle the detector must report, plus a diamond it must not. All three were needed: the first node floor was set at 800 against a real graph of 673 and failed for an uninteresting reason, which is how a gate gets loosened. |
| **+1** | `documented-commands-exist.test.ts` (90 → 91) | Joined. `FR-R3-127` — refuses a document that names a command the manifest does not contribute, and holds `api-and-cli.md` in both directions because that page claims completeness. Three controls: a floor on manifest commands, a floor on documents walked, and a floor on distinct `Schegent: <Title>` occurrences found — the third because the first version of its matcher truncated real titles at connectors and hyphens, and a matcher that stops matching would report green over exactly the defect that shipped. |
| **+1** | `concurrency-isolation-disclosure.test.ts` (89 → 90) | Joined. `FR-R3-124` — asserts the shared-tree disclosure is present at the five surfaces a human reads it, and that no live document sells a cap above one as isolation. Two controls: the surface list is pinned at five with every path resolved on disk, and the live-prose corpus carries a floor, so neither a rename nor a moved directory can empty a scan into a silent pass. |

The three back-filled rows carry the commit rather than the gate name, because identifying which
gate joined at each step would mean re-running the detector at three historical revisions; the
movement is recorded and attributable, and inventing a gate name for it would be worse than
naming the commit. **The rate was 0.0% before and after**, so no gate was added to move the number.

**Denominator movement 92 → 96 (2026-08-28, `FR-R3-136`).** Four more steps, two of them
unrecorded when they happened — the same omission the reconciliation above names, which is the
second time this section has had to be back-filled rather than kept. Attribution is by `git log -S`
on the machine-readable line, the method that section established.

| Δ | Gate | Cause |
|---|---|---|
| **+1** | (92 → 93, `799cb72d`, feature 197) | Joined during "stop retyping the host contract, tier the gate, ship a graph example". Not recorded here at the time. |
| **+1** | (93 → 94, `a2f97115`, feature 198) | Joined during "one reader for every dated deferral, and a trigger that named nothing". Same omission. |
| **+1** | `command-trust-dispositions.test.ts` (94 → 95) | Joined. `FR-R3-136` — refuses a command registration that carries no trust disposition, and refuses any registration outside the guarded helper. Three controls: a floor on source files walked, a floor on registrations found, and two demonstrations the gate can fail — `requireDisposition` driven with an unclassified id, and the raw-registration detector driven against a synthetic source containing one. |
| **+1** | `activation-trust-classification.test.ts` (95 → 96) | Joined. `FR-R3-136` — refuses a module under `src/activation/` that carries no trust-classification verdict. Its control is the denominator itself: the module count is derived from the directory listing and floored, so a listing that stopped finding modules fails rather than passing over nothing, and the four verdicts are a closed set so an unrecognised one is an offender too. |

**The rate is 0.0% at every step**, so no gate was added to move the number.

**Why this keeps happening, said plainly.** Two authorities on one figure — a line a test asserts
against a live run, and a table a human maintains — will drift unless something reads both. Nothing
does. The line is gated; the table is prose beside it. That is a real gap in this document and it is
recorded here rather than repaired in a feature about Workspace Trust.

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
| `tests/a11y/a11y-scan.spec.ts` | axe scoped to `document.head` instead of `document` → the leanest combination gave **1** node/rule pair against the floor, named; restored → green at **3,660 pairs over 24 combinations**, leanest `sidebar|light` at 41 (2026-08-28, `FR-R3-131`) | yes, by live mutation |
| `tests/lint/a11y-baseline-shrinks.test.ts` | one probe entry appended to the empty baseline → `accepts 1 finding(s), over its recorded ceiling of 0`; removed → green (2026-08-28) | yes, by live mutation |
| `tests/lint/snapshot-mirror-census.test.ts` | landed red against 51 byte-identical declarations; its union half independently rediscovered `QueueSummary.pauseSource` missing `'retry-cap'`; its structural half found five renamed copies a name-keyed comparison cannot see; **widening its walk from three host directories to `src/` found fifteen more it had been reporting as "webview-local"** (2026-08-28, `FR-R3-132`) | yes, by live mutation |
| `tests/lint/verification-tiers.test.ts` | four mutations: `test:perf` dropped from the release tier; `--cache` appended to a tier; a tier renamed in its document; a tier pointed at a target `package.json` does not define (2026-08-28, `FR-R3-132`) | yes, by live mutation |
| `tests/lint/dated-review-records.test.ts` | a past date, and a removed marker (2026-08-28, `FR-R3-132`, as `devcontainer-declination-review-date.test.ts`); then, consolidated (`FR-R3-134`): a record with no marker at all — `live-canary-cadence.md`, the deferral the three-file arrangement let through — and an unregistered marker planted in a fourth document, named by the completeness scan | yes, by live mutation |
| `tests/lint/at-matrix-honesty.test.ts` | three mutations: a `**PASS**` result with no date; an `UNTESTED` row whose trigger cell was `—`; `Schegent conforms to WCAG 2.1 Level AA.` appended to `RELEASE.md` (2026-08-28) | yes, by live mutation |
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


### Is a narrow gate scope a class? Measured, and it is one instance (2026-08-28, `FR-R3-133`)

`FR-R3-132` found `snapshot-mirror-census.test.ts` reporting **0** duplicated declarations while
walking three host directories out of twelve; the true number was 15. That was written up as a
finding about gates in general — *"a gate's scope is part of its verdict, and nothing was checking the
scope"* — and a meta-gate was the obvious next move. **It was measured first, and declined.**

**Method.** All `tests/lint/*.test.ts` were scanned for a scope constant (`*_ROOTS`, `*_DIRS`,
`SCAN_ROOTS`, `SCANNED_DIRS`). **17** gates declare one. Most omit a code area, and almost every
omission is correct: a gate about Svelte components has no business in `scripts/`. A rule requiring
every gate to name every area would be noise, so the omissions were not the measurement.

The measurement is the one that actually caught the census bug: **does the thing the gate forbids
occur outside the scope it declares?** That question has no false positives — a hit means either the
scope is wrong or an exclusion is undeclared. Two candidates where a hit would be a real defect:

| Gate | Omits | Does the forbidden thing occur there? |
|---|---|---|
| `no-legacy-surface-name.test.ts` — *"the retired surface name appears on no surface"* | `scripts`, `tests` | **No.** `'Process Library'` occurs outside `src/` and `webview-ui/src/` in exactly one file: the gate itself, in its own docblock |
| `waits-are-bounded-by-time.test.ts` — a wait must be bounded by elapsed time | `webview-ui/src` | **No.** Zero occurrences of `setImmediate` in the whole webview tree. The browser has no `setImmediate`; the omission is the scope being correct, not narrow |

**One instance, in a gate written the same day, fixed at the source.** A meta-gate for a class of one
would be the shape this repository refuses elsewhere: `FR-R3-121`'s governance census found nothing
retirable and said so, because **zero is a valid outcome**. Recording the count is what stops the next
author re-deriving it, and it is cheaper than a control with a false-positive budget and no measured
subject.

**What would reopen it**: a second instance. The signal is specific and cheap to check — a gate
reporting a count that a wider walk of the same forbidden pattern contradicts. If one appears, the
denominator for the meta-gate is 17 and the method is written above.

### The a11y scan's recorded mutation was replaced, not amended (2026-08-28, `FR-R3-131`)

The row above used to read *"a baseline entry removed → `new: 1`, named; restored → green"*. That
mutation is **no longer performable**: `FR-R3-131` cleared all 30 accepted entries at the colour
source, so there is no entry to remove. The recorded proof would have survived as text describing an
experiment nobody could run — the `FR-R3-126` class, prose outliving the fact, inside the batch that
closed it.

What replaced it is a stronger control, and the substitution is why the scan needed one at all: with
30 accepted entries a harness that rendered nothing failed on 30 *fallen* entries, so `findings: 0`
was impossible. At zero accepted, a scan of a blank tree reports exactly what a clean sweep reports.
Measured: scoping axe to `document.head` produced `findings: 0` and **passed both baseline
assertions**. Only `MIN_NODES_EXAMINED` caught it.

The floor itself was first set to 40 — one below the leanest measurement, which is a tripwire rather
than a floor, and would have failed on the removal of any decorative element. It is 20: the number
separates *rendered* from *blank* (measured 41 against a mutated 1), not *big* from *small*.

**94 as of 2026-08-28 (`FR-R3-134`)**, net up one over 93: `dated-review-records.test.ts` walks
`docs/` and asserts an empty unregistered set, so it is a scanning gate and the detector classifies it
as controlled — its control is the floor on documents scanned (>50) plus the registry-size floor.
The two gates it retired were not in the denominator: neither walked a tree, each read one named file.

**93 as of 2026-08-28 (`FR-R3-132`)**, up one: `snapshot-mirror-census.test.ts` walks the host tree
and asserts an empty result set, so it is a scanning gate and the detector classifies it as
controlled. Its control is the pair of floors on what the walk found — 20 mirror declarations and 200
host declarations — because every assertion in it is a per-declaration loop and a parser that matched
nothing would report green over a deleted file.

The `FR-R3-131` gates are outside the **vacuity denominator** and that is not an omission:
the detector's denominator is gates that walk a tree and assert emptiness, and neither of these
does — one reads a JSON count, the other parses a fixed table. Both were nonetheless driven red by
live mutation, recorded above.

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

## FR-R3-118 — the envelope-reaching gates, swept by running them (2026-08-27)

`FR-R3-118` reported one defect: `spec-traceability-governance.test.ts` read the
planning envelope unguarded, raised `ENOENT` in a standalone execution-repository
clone, and so made `npm run gate` unreachable — and a release uncuttable — from a
clone that `README.md:22` and `repo/AGENTS.md` both promise can build and test. It
recorded nine siblings as already correct, "one file out of ten".

**The sweep was performed by cloning the repository into an envelope-free parent
and running the suite there, not by searching for the guard.** That distinction
produced the finding, because the register undercounted in two independent ways.

### What was measured

| Gate | Reaches parent as | Behaviour in an envelope-free clone, **before** | Now |
|---|---|---|---|
| `spec-traceability-governance.test.ts` | `ENVELOPE_ROOT` | **threw** `ENOENT` on `readdirSync(../specs)` and `readFileSync(../AGENTS.md)` | reported skip |
| `eslint-baseline.test.ts` | `ENVELOPE_ROOT` | **6 false accusations**: `an owner that cannot be resolved is an unowned entry` | reported skip |
| `source-loc-budget.test.ts` | `ENVELOPE_ROOT` | **1 false accusation**: `waiver needs ... a reference that resolves on disk` | resolvability defers; decision text and ISO date stay checked |
| `actions-retirement-claims.test.ts` | `ENVELOPE` | **threw** `ENOENT` on `scandir ../docs`; its vacuity floor also demanded both trees | scans repo-only; the floor is per-tree |
| `source-marker-targets.test.ts` | `ENVELOPE` | **8 false accusations** — markers that resolve only into the envelope reported as broken | reported skip |
| `capability-text-contract-parity.test.ts` | `ENVELOPE_ROOT` | correct — `existsSync` branch, absence asserted explicitly | unchanged |
| `threat-id-anchor-parity.test.ts` | `WORKSPACE_ROOT` | correct — `required: false` | unchanged |
| `agents-claude-parity.test.ts` | `WORKSPACE_ROOT` | correct — `existsSync` + `skipIf` | unchanged |
| `no-tryAutoDrain-doc-references.test.ts` | `WORKSPACE_ROOT` | correct — five `existsSync` guards | unchanged |
| `a11y-policy-parity.test.ts` | `ENVELOPE_ROOT` | correct | unchanged |
| `scripts/check-doc-links.mjs` | `WS_ROOT` | correct — `envelopePresent()`, the shape the others now share | unchanged |

**Eleven gates, not ten. Four misbehaved, not one.**

### The two things searching could not have found

**1. The count was wrong because the search term was.** `source-marker-targets` and
`actions-retirement-claims` name their root `ENVELOPE`, not `ENVELOPE_ROOT`. A
search for the latter — which is how the register was built, and how this feature's
own research restated it — misses both. `no-unguarded-parent-read.test.ts`
therefore matches on **the resolved path**, not on the name of the constant: it
resolves each root declaration against the file's real directory and flags only
those landing strictly above `REPO_ROOT`. An earlier draft matched
`resolve(X, '..')` textually and flagged `LINT_DIR = resolve(__dirname, '..')`,
which is `tests/lint`. Textual depth is not depth.

**2. A guarded read can still be wrong, in a worse shape than a throw.**
`eslint-baseline` and `source-loc-budget` both guarded their reads. Neither crashed.
Both then judged the missing envelope as a defect **in the repository** — seven
confident, actionable, wrong accusations against provenance that is in fact
correct. A crash announces itself as a rig problem and gets diagnosed as one; a
false accusation announces itself as a repo problem and someone acts on it. Grep
sees a guard and stops; only running the thing distinguishes *guarded* from
*correct under absence*.

### What now covers it

`tests/lint/no-unguarded-parent-read.test.ts` fails when a file under `repo/tests/`
declares a root above `REPO_ROOT`, reads through it, and contains no envelope
check. It carries its own vacuity control (the parent-reaching set must not come
back empty — an empty match is how the two `ENVELOPE`-named gates went unnoticed).

**Observed red**: a probe file reading `../AGENTS.md` with no guard was added, the
gate failed naming it, and the probe was removed and the gate passed.

The rule it enforces is deliberately narrower than the lesson. "Do not judge an
absence you cannot see" is the real rule and is not mechanically checkable; the
gate checks the mechanical half, and this entry records the other half so it is
written down somewhere even though nothing enforces it.

## FR-R3-116 — semantic claim consistency: a gate class that did not exist (2026-08-27)

### The blind spot

`FR-R3-112` landed the audit hash chain. `src/audit/audit-chain.ts` shipped, it was
wired into `audit-log-writer.ts`, and `npm run audit:verify` shipped with it. **Five
documents went on saying the log had no chain**, and one of them —
`docs/security/threat-model.md` — asserted the chain at line 22, denied it at line
70, and asserted it again at line 163. All three sentences were in the shipped
threat model. Only two were true.

Roughly 141 lint gates were green for the whole interval between the merge and the
review that found it, and a pre-push liveness check resolved every backticked source
path in both envelope documents.

**None of that could have caught it.** The machinery checks **path liveness** (does a
cited path exist?) and **constant parity** (do two copies of a literal agree?). It had
no instrument for **semantic claim consistency**: whether a document asserts something
the tree contradicts. A sentence saying a mechanism is absent cites nothing, so path
liveness has no opinion; it duplicates no constant, so parity has none either.

### How it was found

By a human reading the threat model end to end and noticing it disagreed with itself
two paragraphs apart. That is not a repeatable detection method, which is the
argument for the gate.

### What now covers it, and what does not

`tests/lint/document-mechanism-consistency.test.ts` fails when a document under
`repo/` denies a mechanism the tree exports. Three seeded pairs:

| Seed | Mechanism | Chosen because |
|---|---|---|
| `audit-chain` | `src/audit/audit-chain.ts` exports `digestOf` | the pair that produced the finding |
| `process-tree` | `src/runner/process-tree.ts` exports `signalProcessTree` | its true statement is **platform-qualified** — POSIX kills the group, Windows uses `taskkill /T`, and the degradation report is deliberately absent on Windows. An unqualified denial is a real defect; a qualified one is correct prose. It is the seed that tests whether the denial-versus-limit distinction actually holds |
| `ownership-fence` | `src/state/ownership-registry.ts` exports `OwnershipRegistry` | a state-layer mechanism, so the three seeds are not three instances of one shape |

Three design decisions worth recording, because each is a place the gate could have
gone wrong:

1. **A denial is not a limit.** Every document this feature corrected states the
   mechanism's limit — *tampering is evident, not impossible; the chain head sits on
   the same disk*. Those sentences must pass. The corrected tree is the gate's own
   negative fixture: if it flags corrected text, the regex is wrong, not the text.
2. **A dated historical statement is not a denial.** The T3 anchor's *"Until
   FR-R3-112 that was a write discipline and nothing more: ... there was no chain,
   signature or post-write detection"* is both true and the clearest explanation of
   the mechanism in the tree. A gate that forced it out would destroy the
   documentation it exists to protect. The qualifier must be in the **same sentence**,
   not the same paragraph — a paragraph-scoped rule lets one dated clause excuse an
   unrelated live denial three sentences later.
3. **Scope is the execution repository, not the envelope.** `docs/audits/` and
   `docs/features/` exist to *quote* claims. The review that produced this item quotes
   all five denials verbatim; scanning it would make the gate fail on the document
   that asked for the gate.

**What it is not**: a seeded-pair detector, and its docblock says so. It cannot detect
arbitrary contradiction, it does not parse prose, and it will not notice a denial
phrased outside its regexes. A general contradiction detector is not proposed and
pretending otherwise would be the overclaim this whole class is about.

### Non-vacuity, measured

A regex gate over prose has FR-R3-114's exact failure mode — a pattern matching
nothing is indistinguishable from a tree with nothing to match — and no natural
symptom. `scripts/document-mechanism-consistency-selftest.sh` drives **each of the
three seeds** red against the real tree and back to green, and additionally proves
the two carve-outs are not loopholes:

```
9 passed, 0 failed
  audit-chain      row 1's exact sentence restored -> red, names the seed -> removed -> green
  process-tree     unqualified denial planted      -> red, names the seed -> removed -> green
  ownership-fence  denial planted                  -> red, names the seed -> removed -> green
  a correctly-stated limit          -> green (not read as a denial)
  an explicitly historical denial   -> green (not read as a live claim)
```

It restores the tree on every exit path via `trap ... EXIT INT TERM`, because a
self-test that leaves a planted falsehood in a security document when it fails is
worse than no self-test.

### What the gate found that the register did not

A **sixth** live denial: `docs/security/whitepaper.md:102` — *"That is a write-path
convention, not tamper evidence: there is no signature or hash chain"*. `FR-R3-116`
enumerated five. The gate found the sixth on its first run, before it had ever been
committed, which is the most direct evidence available that the class was real and
under-counted rather than fully known and merely unenforced.

## FR-R3-119 — the composition root, and a ratchet that licensed what it forbade (2026-08-27)

### What was measured

`src/extension.ts` held **1,489 lines, 77 imports, three top-level functions** — one of
which, `wireStage2()`, spanned lines 263–1483: **1,221 lines**, ~245 top-level
statements. `src/activation/`, which `ARCHITECTURE.md` called the composition root, was
1,863 lines across 11 focused modules, largest `ui-wiring.ts` at 387.

Its LOC entry was `{ path: 'src/extension.ts', maxLines: 1_490 }` — a plain number, one
line above the file. Its two **larger** peers, `workspace-state.ts` (2,768) and
`queue-manager.ts` (1,841), both carried dated waivers with quoted decisions,
resolvable references and shrink-only high-water marks.

**The finding is that pairing.** The largest cohesion problem in the tree was the one
the waiver machinery never saw, and nobody ever had to write down why.

### What changed

`sidebar-router-wiring.ts` took 240 lines of `MessageRouter` construction out of
`wireStage2`. **1,221 → 1,010** for the function, **1,489 → 1,270** for the file,
eleven imports dead and removed, no behavioural change (`FR-059`).

Three of the twenty-eight bindings the span closed over — `context`, `output`,
`config` — turned out not to be dependencies at all: the router reads none of them.
They were in scope, which is not the same thing, and only the extraction made the
difference visible. That is a small result worth recording, because "what does this
actually depend on" is unanswerable while everything is in one function.

### What the gate now catches that it did not — two things

**1. A tight ceiling.** `WAIVER_FACTOR` refuses a ceiling set at a large multiple of
its file. It has no opinion on a ceiling set one line above it, and cannot have one by
construction — yet that is the shape a god file naturally produces, because every edit
raises the number by exactly what the edit added. The gate now reports a plain ceiling
within `max(25, 2%)` of its file as **un-decided debt**.

Adding the check found **eight** files in that shape, not one. The pattern is systemic,
which is itself the finding. Seven are a recorded shrink-only baseline — failing all
eight inside a feature scoped to one of them is how a useful gate gets reverted — and a
ninth cannot arrive. `src/extension.ts` is absent from the baseline: that is what
coming off the list looks like.

**2. A function-level bound.** The file-level number did not catch a 1,221-line
function inside a 1,489-line file. There is now a 400-line bound over
`src/extension.ts` and `src/activation/`; 400 is observed, not invented — it is
`ui-wiring.ts` rounded up.

### The mutation that killed the first draft, recorded because it looked right

The bound's first version enforced **a single flat mark of 1,010** — the
post-extraction size of `wireStage2` — across the whole scope, on the ordinary ratchet
reasoning that you record where you are and forbid going backwards.

Mutation testing killed it. A **new 407-line function** added to `src/activation/`
**passed**, because 407 < 1,010.

> A ratchet set to the worst offender licenses every newcomer up to the worst offender.

That is the exact inverse of its purpose, and the flat form reads like good practice.
The corrected shape separates the two: a **400-line bound every function is held to**,
plus a **named, shrink-only legacy exemption** — `src/extension.ts:wireStage2` at 1,010,
the only entry, list closed. The exemption's own guard asserts it may be lowered and
never raised, and that the exempted function still exists and is still over the bound,
so a stale entry cannot linger.

Recorded at length because the defect was invisible to reading and to review. Only
driving the gate red found it, and the same shape is available to any ratchet that
pins a single number for a whole scope.

### Non-vacuity, measured

| Mutation | Result |
|---|---|
| a 407-line function in `src/activation/` | red — over the 400-line bound |
| the exemption raised 1,010 → 1,500 | red — "an exemption may be lowered, never raised" |
| `extension.ts` ceiling set to 1,271 against a 1,270-line file | red — un-decided debt |

Each was reverted and the gate returned green.

## FR-R3-115..119 — every gate this batch added, observed red (2026-08-27)

FR-070 required each new gate to be driven red by mutation of the real tree before it
counted. A gate that has never failed is a gate nobody has evidence for, and
`FR-R3-114` measured one that read as coverage for months while matching nothing.

**Five gates, six observations** — the semantic-consistency gate is driven twice, once
across all three seeds and once against the specific sentence `FR-R3-116` row 1 names.

| Gate | Mutation | Observed |
|---|---|---|
| `document-mechanism-consistency` | each of three seeds' denial sentences planted in a document in its scope | red, naming the seed, then green on restore — by `scripts/document-mechanism-consistency-selftest.sh`, 9 passed / 0 failed |
| `document-mechanism-consistency` | `threat-model.md:70`'s exact original sentence restored | red — the FR-026 case, specifically |
| `no-unguarded-parent-read` | a probe file reading `../AGENTS.md` with no envelope check | red, naming the probe, then green on removal |
| `platform-branch-has-record-row` | `process.platform === 'freebsd'` added under `src/` | red, naming `freebsd`, then green on revert |
| `source-loc-budget` function bound | a 407-line function added to `src/activation/` | red — and this one **changed the design**: it passed against the first draft, which is how the flat-mark defect was found |
| `source-loc-budget` tight ceiling | `extension.ts` ceiling set to 1,271 against a 1,270-line file | red — un-decided debt |

Two further non-vacuity checks were driven in the opposite direction, to prove the
carve-outs are not loopholes: a correctly-stated **limit** and an explicitly
**historical** denial both leave `document-mechanism-consistency` green.

**The one that mattered most was the one that did NOT go red.** The 407-line function
passed the function bound's first draft, and that is the only reason the flat-mark
defect was found — it was invisible to reading and to review. An observation that
fails to reproduce the expected failure is evidence too, and worth more here than the
five that behaved.

## FR-R3-121 — the governance surface, measured (2026-08-27)

`FR-R3-121` filed the aggregate, not any individual gate: *"gate for gate, the best
thing about this repository"*, against an entry cost nothing had ever added up.

### Standing figures — with their method, because all three move

Recorded so the next round reads **direction of travel** rather than re-deriving from
zero. Every figure carries the rule that produced it: `FR-R3-121` reported 141 gates
where this measured 150, and the difference was **not** drift — the item counted a
subdirectory's seven *files*, two of which are not gates, and this counts gate files
recursively. Two correct numbers, one units mismatch. A figure without its method
cannot be compared to the next one, and that near-miss is why this table has four
columns instead of three.

| Figure | Value | Date | Method |
|---|---|---|---|
| Lint gate files | **151** | 2026-08-27 | `find repo/tests/lint -name '*.test.ts'`, recursive; includes `gate-integrity/` |
| Envelope Markdown | **1,387 files, 16.2 MB** | 2026-08-27 | `find docs specs -name '*.md'` from the workspace root |
| `AGENTS.md` | **981 lines, 749 in the hard-rules section, 64 rules** | 2026-08-27 | `wc -l`; section extent by `^## ` boundaries; rules by `^- \*\*Never\*\*` |
| Envelope gate set (the push cost) | **39 s** | 2026-08-27 | the six `scripts/*.sh` gates `pre-push` runs, timed end to end |
| Liveness self-test alone | **51 s** | 2026-08-27 | `scripts/envelope-doc-liveness-selftest.sh`, run separately — it is not in the push path |

**Before and after, and the honest answer is: unchanged.** The push cost was ~45 s in
the 2026-08-26 measurement the envelope README records and is 39 s here. This feature
**retired no gate** (see below), so nothing was expected to come down, and nothing
did. The variation is machine load, not a reduction, and reporting it as one would be
the kind of claim this round exists to remove.

### The census, and why it retired nothing

`docs/development/lint-gate-census.md` now carries **one row per gate** — invariant,
what else holds it, a verdict, and the evidence. Generated for its structure, written
by hand for its verdicts, and gated on completeness by
`tests/lint/lint-gate-census-complete.test.ts` so the next gate added cannot arrive
without a row.

**Verdicts: 138 unique, 13 partially redundant, 0 redundant. Zero retirements.**

FR-021 permits a retirement only when a named control now holds the invariant — a
type, a generated contract, a compiler flag, or a named sibling gate. *Seems covered*
and *the code moved* are not successors. **No gate met that bar**, and `FR-R3-121` §5
predicted it: its author sampled the set and found every gate well motivated.

**What the census found instead, and it is a real result.** The thirteen
`no-inline-*` gates are **one rule implemented thirteen times, across 1,009 lines**.
Diffing two of them leaves the command constant, the allowlist, and the prose;
several say in their own headers that they *"mirror the established pattern at"* a
named sibling. And `no-inline-backend-ping-ipc.test.ts` does the same job in **15
lines**, which is what makes this evidence rather than an impression.

That is redundant **machinery**, not a redundant **rule** — the distinction
`FR-R3-121` §3 opens with. Each gate pins a *different* command's single call site,
and retiring any of them deletes a guarantee nothing else holds. So the census
recommends **consolidation into one table-driven gate with thirteen rows**, saving
roughly 900 lines while keeping every rule — recorded as a named follow-up, not taken
here, because an allowlist transcribed wrong silently widens a command's call sites.

### The entry cost

- `repo/CONTRIBUTING.md` now opens with **ten documents, in order**, and states that
  everything else is reference. Ten counted honestly: there is no optional eleventh,
  because a list of eleven with one marked optional is a list of eleven.
- `AGENTS.md`'s hard-rules section gained a **subsystem index** routing a contributor
  to the rules their change touches. **No rule moved**: all 64 are byte-identical and
  in their original order, verified by diffing the rule-bearing lines before and
  after. Sub-headings between the bullets were considered and rejected — the existing
  order does not cluster cleanly, so headings would have meant reordering all 64 by
  hand, and a rule lost in that shuffle is worse than a flat list with an index.

### What this does not claim

A `unique` verdict means *no sibling gate, type, generated contract or compiler flag
was found asserting the same invariant* by the four mechanical signals the census
documents. It does **not** mean a human read all 151 gates against each other and
proved independence. That stronger claim would need per-gate review this cycle did
not do, and the census says so in its own Method section rather than leaving a reader
to assume otherwise.

### FR-R3-120..122 — the changed verdicts, observed red (2026-08-27)

FR-041 required each new or changed verdict driven red by mutation before it counted.
Four gates, six observations:

| Check | Mutation | Observed |
|---|---|---|
| `audit-baseline-status` empty verdict | a corpus present with no `.md` | red before the change (`ok`), green after (`nothing-to-verify`, exit 0) — selftest case 23a, asserting the **code as hard as the word** |
| …its non-vacuity control | a corpus **with** one document | reports `ok`, so a change returning `nothing-to-verify` unconditionally cannot pass — case 23c |
| `check-manifest-versions` | `webview-ui/package.json` bumped to `0.2.1` | red, naming every one of the six version sites and both values; green on revert |
| `lint-gate-census-complete` | a gate file with no census row | red, naming the file |
| …the other direction | a census row naming a deleted gate | red, naming the row |
| VSIX content allowlist | the SBOM added to the package | **red without being asked** — the allowlist gate caught a deliberate new packaged file and required a deliberate entry, which is the behaviour it exists for |

The last row is worth keeping. Nothing in this feature planned to test that gate; it
fired on its own the first time `npm run package` emitted a new file into the archive,
and refused until the addition was written down with a reason. A gate that catches
your own intended change and makes you justify it is the one you find out is working
without designing an experiment.

## FR-R3-123 — the status field that stopped meaning anything (2026-08-27)

### The class

`spec-traceability-governance.test.ts` enforced two rules about a spec's status and enforced them
correctly: the word must come from a closed vocabulary, and `Complete` may not be claimed while a
task is unchecked. **Neither asks whether the word is true.** `Draft` is always in the vocabulary,
so a shipped, merged, fully-ticked feature labelled `Draft` passed everything.

Measured before the rule existed, across 155 spec directories: **58 said they were unfinished and
their own task lists said otherwise** — 48 `Draft` and 10 `In Progress`.

This is the fourth instance in two days of the shape `FR-R3-116` named: machinery that checks
*form* and *parity* exhaustively, with no instrument for whether a claim is *true*.

### Two corrections to the filed item, found before implementation

The item was filed at the end of another cycle, from a measurement. Verifying it at source changed
two of its three claims, and both are recorded because an item about untrue records cannot be
repaired by quietly editing it.

1. **The three specs with unchecked tasks were completed features, not abandoned ones.** The item
   said their tasks were *"generated and never started"* with *"no recorded disposition"*. Both
   halves were wrong: each corresponds to a `DONE_` feature record carrying a `## Closure` section,
   and each one's deliverables are in the tree — `src/ui/sidebar/commands/primacy-gate.ts`
   (FR-R3-024), `tests/lint/capability-argv-parity.test.ts` (FR-R3-032),
   `tests/lint/lint-gates-are-hermetic.test.ts` (FR-R3-033). A **two-record divergence**, not an
   absence.
2. **An unchecked box is not evidence of undone work in this tree.** 35 of 188 `DONE_` feature
   files carry unchecked boxes — 18.6%. `DONE_24` has 8 unchecked and **0 checked** while its
   substance is demonstrably shipped. The FR files are specifications; ticking, when it happened,
   happened elsewhere.

### Two findings the analysis phase caught before the gate shipped

**The sweep was 58, not 48.** The item framed this as a `Draft` problem. Ten of the eleven
`In Progress` specs were fully ticked too — so a rule saying *"a fully-ticked spec may not say
`Draft`"* would have left the identical defect one word over, ten times. The shipped rule is a
table over (task state × status).

**The scan had to be case-insensitive, and this nearly shipped wrong.** **80 specs mark their tasks
`- [X]` with a capital X.** A scan matching only `- [x]` reads every one as having no tasks — which
the "no task state" exemption then excuses — so the gate would have passed over more than half of
`specs/` while reporting green.

> A vacuous gate, inside the gate written to close vacuous gates.

Caught by analyze rather than by review. Both spellings are now pinned by a fixture beside the rule.

### What the exemptions are for

`Verification Pending` means done-and-awaiting-verification, so unchecked tasks *agree* with it —
one spec is legitimately in that state. `Deferred` and `Superseded` describe dispositions decoupled
from task counts and already carry their own requirements in the same gate. A spec with no
`tasks.md` has no task state; judging it would mean inventing one.

### What was reconciled, and what it means

- **58 specs** to `Complete`, one commit, gate-verified.
- **Three specs** (`108`, `116`, `118`) had their 68 boxes ticked in one pass, each `tasks.md`
  carrying a header saying **exactly what the tick means**: reconciled months later against the
  `DONE_` closure record and re-verified at source, *not* checked as the work happened. A tick
  normally carries the second claim and here it does not.
- **Twelve specs** with no `tasks.md` derived from their `DONE_` records, each carrying a note that
  `Complete` comes from that record rather than from a task list the directory never had.
- **One spec** (`080-release-qualification`) moved `In Progress` → **`Deferred`**. Its four
  residual tasks all need macOS/Windows/Linux lifecycle evidence or interactive dev-host matrices —
  the evidence `FR-R3-115` declined on the record after establishing no contributor, container
  runtime or CI budget exists. `In Progress` was the wrong word: nothing had been in flight since
  2026-08-22. `Deferred` obliges a rationale and an owner, which is the information a reader needs.

### Non-vacuity, measured

| Mutation | Observed |
|---|---|
| a fully-ticked spec set to `Draft` | red, naming it and the reason |
| a fully-ticked spec set to `In Progress` | red — the hole one word over |
| a spec with 4 unchecked tasks set to `Complete` | red — **the pre-existing rule, proving this feature added beside it rather than loosening it** |

A first mutation attempt targeted a spec with **no `tasks.md`** and correctly did **not** fail. That
is recorded because it looked like a broken gate for a minute and was the exemption working.

### What is out of scope, with its measurement preserved

The 35 `DONE_` files with unchecked boxes were **counted, not read**. Whether any hides real undone
work is **unknown**, and reconciling 188 feature files is a different item. The count is here so
the question can be filed rather than assumed either way.

## FR-R3-121 follow-up — two corrections found by acting on the census (2026-08-27)

The census recommended consolidating the `no-inline-*` gates. Starting that work found two defects,
neither of which a reader would have seen.

### 1. The cluster was twelve, not thirteen

`no-inline-queue-item-template.test.ts` is **not** an IPC single-call-site gate. It pins the single
render path of a Svelte row template and shares only the filename prefix. The census generalised
from diffing two files and a name.

**A consolidation that had trusted "thirteen" would have folded a Svelte template gate into an IPC
allowlist table.** The census's own Method section states this limit — verdicts assigned by
mechanical signal, not by reading each gate against every other — so the correction is left visible
there rather than edited away. It is what the limit looks like when it bites.

### 2. The generator silently destroyed the analysis it was written to carry

`census-lint-gates.mjs` preserved each row's hand-written columns across regeneration, which was the
whole point of making it a generator. It did **not** preserve hand-written *sections*. So
regenerating after adding one gate rewrote 151 rows faithfully and **deleted the Method and
Retirements sections entirely** — the only part a human wrote, and the only part carrying the
reasoning.

Found by regenerating and noticing the file had got shorter.

> Preserving the rows but not the reasoning is the worse half to keep.

Fixed with a `<!-- census:prose -->` marker: everything between it and `## The census` is carried
through untouched. Verified idempotent — two consecutive regenerations leave both sections intact.

**Why this is recorded and not just fixed.** A generator that quietly discards hand-written analysis
is the same defect class as a stale record: the file still looks authoritative afterwards. It was
introduced *by this round*, in the tooling built to close that class, and it survived one review.

### The consolidation was not taken

Each of the twelve carries a distinct allowlist of files permitted to reference its command. An
allowlist transcribed wrong during consolidation silently **widens** what may call a mutating IPC
command — a security-relevant regression with no failing test to announce it. The upside is ~900
lines of duplication that cost nothing at runtime and catch everything they should today.

A refactor whose upside is tidiness and whose downside is a silent authorisation widening gets
scheduled deliberately. It stays a named follow-up.

## FR-R3-121 follow-up 2 — the consolidation, attempted (2026-08-27)

The census recommended consolidating the `no-inline-*` gates and this cycle deferred it on a stated
risk: *an allowlist transcribed wrong silently widens what may call a mutating IPC command*. The
attempt was made specifically to test whether that risk could be removed mechanically.

**It can.** The allowlists are separable from the duplicated scan helper, so the ~25-line
`listMatchingFiles` boilerplate could be consolidated without a single allowlist moving. The
original reason to defer did not survive contact.

**A better one replaced it.** Normalising the twelve helper bodies — stripping whitespace and
comments, then hashing — found **six distinct variants collapsing to three failure semantics**:

| On a partly-unreadable tree | Gates | Effect |
|---|---|---|
| return `[]` | 2 | discards matches the scan did find |
| unhandled → throw | 6 | fails closed, loudly |
| return the matches found | 2 | most complete — and the only variant carrying a written rationale |

Plus two already migrated to the shared `filesReferencing`, one of which does the whole job in
**15 lines**.

So the consolidation is **not** a tidying. It is choosing one failure semantics for twelve
IPC-authority gates, which changes what eight of them do when the tree cannot be fully read.

**Nothing is unsafe today** — all eight carry a positive `toContain` vacuity control, verified, so a
truncated scan fails the gate rather than passing it.

### Why this is recorded at length

The census's own entry said *"one rule, twelve implementations."* That was **true about the rule and
wrong about the implementations**, and it was written from diffing two files. A consolidation
trusting it would have unified three failure behaviours into one without anyone deciding which —
and the resulting gate would have looked cleaner while quietly having changed how eight
authority checks fail.

This is the **third** correction to the same census entry in one day: thirteen → twelve (a Svelte
template gate shares the prefix), then "twelve identical" → "twelve with three semantics". Each
correction came from acting on the entry rather than reading it.

> A census is a hypothesis until somebody tries to use it.

### And then the premise died a second time — the divergence was unreachable

Reading one level further: **`filesMatching` does not shell out.** Neither does
`scanWebviewSources`. Both are `node:fs` walks, and `filesMatching` catches its own read errors
internally and returns `false` for an unreadable file. So `err.status` is **always `undefined`**,
every variant's conditions are always false, and every variant falls through to the same
`throw err`.

The three "failure semantics" were three flavours of **dead code** — `grep`/`rg` exit-code handling
left behind when the scan stopped being a subprocess. There was never a runtime difference.

> Dead error handling for a mechanism that is gone does not merely take up room. It answers
> questions wrongly — twice, to a reader who was being careful.

### What shipped

One `matchingRelativePaths` in `source-scan.ts`; ten private `listMatchingFiles` copies deleted;
**156 lines removed**. Errors propagate, which is what all twelve already did.

Verified, because the original objection deserved an answer rather than a dismissal:

| Check | Result |
|---|---|
| every allowlist byte-identical to `HEAD` | **12 of 12 SAME** |
| every `toContain` vacuity control intact | 12 of 12 |
| a planted offender still turns a gate red | yes — `__probe/Offender.svelte` caught and named |
| no `e.status` / `e.stdout` left in the family | none |

### The cost, which is the part worth remembering

Removing the shared idiom made ten gates **invisible to the meta-gates that read them**. The
classifiable-gate count fell **89 → 79**, and `allowlist-entries-still-apply` found 2 gates where it
requires at least 3 — and said so rather than passing over the smaller set.

Both meta-gates caught it. Both were taught the new call in the same commit, and the denominator is
back at 89. But the lesson generalises past this refactor:

> A shared idiom is load-bearing for the machinery that reads it. Changing one is not a local edit.

That is also the honest verdict on the two earlier deferrals: the caution was right, the stated
*reason* was wrong twice, and only attempting the work found out.

## FR-R3-126 — the fifth form-versus-truth instance, and the gate class it needed (2026-08-27)

**Produced by**: `repo/tests/lint/documented-defaults-are-executable.test.ts`

    executable-example-blocks: 4
    inverted-claim-phrases-refused: 4

### What was found

`FR-R3-117` inverted the phase verdict default on 2026-08-26: a Phase whose claim is load-bearing is
judged on its process's **exit status**, and `hostVerification: 'model-token'` is the explicit opt-out.
`repo/docs/security/threat-model.md` kept stating the **inverse** at two lines — *"A Phase outcome is
self-certification unless the Phase declares `hostVerification: 'exit-code'`"* and *"The marking is
opt-in"*.

**Where it hid.** Inside a document that passed every check pointed at it:

| Check | Verdict over the drift |
|---|---|
| `check-doc-links.mjs` | green — every link resolved |
| `check-docs.mjs` (version/heading) | green |
| source-marker gates | green — the markers named real files |
| `doc-duplicate-authority.test.ts` | green — one document said it, once |
| `document-mechanism-consistency.test.ts` | green |
| `npm run docs:check`, `npm run gate` | green, end to end |

Every one of those verifies **form**. None asks whether the sentence is true. This is the fifth
instance of that class this round: `FR-R3-116` (a mechanism the documents denied), `FR-R3-122` (three
records that were not true), `FR-R3-123` (58 statuses that were not true), `FR-R3-124` (a
`git worktree` ban whose prescribed home never held it), and this one — which is the worst placed of
the five, because a threat model is the document a security reviewer opens first, and applying
model-self-certification to a load-bearing Phase is the wrong conclusion about what advances a Run.

### The gate class, and its direction

The audit of 2026-08-27 recommends against generic prose validation and asks instead for *"small
executable semantic examples"*. The class has two halves and the direction of the first is the whole
point:

1. **Worked examples authored in the document**, under an `<!-- executable-example: <id> -->` marker,
   read by the gate and fed through the owning resolver. A gate holding its own copy of the pairs
   would be a unit test: green while the document says the opposite, which is exactly the relationship
   the gates in the table above had to this finding.
2. **A named list of inverted claims** refused by phrase in the one document. Added during
   implementation, because reverting the prose sentence while leaving the block correct left the gate
   green — and the sentence is what a reviewer reads.

Four defaults carry a block: the phase verdict basis (`resolveHostVerification`), the
uncontained-backend grant scope (`judgeBackendContainment`), the trust-ladder deny-precedence
(`resolveCapabilityDecision`), and the session-retention defaults (`SETTINGS_SCHEMA`).

### What this measurement does NOT establish

- **Prose truth is not verified.** Four defaults have executable examples. Every other sentence in the
  corpus is unchecked, and the gate says so in its own file and in its failure message.
- **The inverted-claim list is literal.** A newly-invented paraphrase of a false claim will pass it.
  That residual is smaller than the one that shipped, and it is stated rather than papered over.
- **One default's example is scoped.** Session retention's block checks the values and their units,
  not the sweep — the block says which claim it checks and which it does not.

### An honest neighbour

**§1 of this same file was found drifted on this same day.** `FR-R3-124` discovered that the
vacuity-census denominator read **86** in §1's prose table while its machine-readable line — the one a
live run asserts against — read **89**: three unrecorded movements across feature 157, inside the
measurement that exists to measure record-versus-tree divergence. It was reconciled to 90 there, with
the three movements back-filled by commit.

Recording that beside this entry is the point. A document about the fifth instance of a class that did
not mention the instance found in its own §1 on the same afternoon would be a small version of the
thing it is recording.
