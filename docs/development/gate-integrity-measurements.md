# Gate integrity measurements

**Captured**: 2026-08-25 · **Feature**: 155 (`FR-R3-088`) · **Tree**: `repo/` at `8a375967`

FR-R3-088's frame: *"A gate I wrote to pass my own code is not independent evidence about my code."*
Four of its consequences are measurable, and this file is where the measurements live. Every number
here is produced by a run, not transcribed — the tests that produce them assert against this file, so
the two cannot drift.

---

## 1. Vacuity detector false-negative rate

**Produced by**: `repo/tests/lint/gate-integrity/vacuity-false-negative-census.test.ts`

    vacuity-census-denominator: 89

| Measure | Value |
|---|---|
| Gates the detector calls **controlled** (the denominator) | **86** |
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
