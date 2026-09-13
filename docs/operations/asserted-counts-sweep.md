# Counts the round-3 documents assert about this tree — what was examined

FR-R3-067. Two documents stated numbers about this tree that were wrong, and nothing checked them. The
corrections took minutes; the mechanism is the deliverable, and this is the record that makes the
mechanism's size accountable rather than arbitrary.

Document paths below are written exactly as the registry names them, because
`tests/lint/asserted-counts.test.ts` checks that every registered claim is accounted for here — and an
abbreviated name would make that check cosmetic. It caught exactly that on its first run.

**Swept 2026-08-24, darwin/arm64.** Scope: the round-3 documents (`docs/features/round_3/**`) and the
repository documents they cite. Deliberately not a tree-wide numeric audit — the registry is a mechanism
later items extend.

## The rule applied

**Citation beats assertion.** A document that names its producer cannot drift; one that restates it can
only be watched. So a count is registered only where stating the number genuinely serves a reader, and
removed wherever it does not. That is why the registry is small: a large one would mean many documents
restating facts they could have cited.

Where a number does serve the reader, it is checked — and by whatever can actually settle it:

- a **static read** can settle it → `tests/lint/asserted-counts.test.ts` registry;
- only a **running suite** knows it → the suite asserts it against its own declarations.

A count that could be settled by neither would not be registrable, and the document should cite instead.

## Every count examined, and its disposition

| Document | Count | Producer | Disposition |
|---|---|---|---|
| `docs/features/round_3/53_FR-R3-053_safe_filesystem_layer.md` §5 | "the remaining **14** modules are not migrated … enumerated in the gate's ledger" | `UNMIGRATED` (16 entries) | **CITED INSTEAD** — the number was wrong and told a reader nothing they could not get by opening the ledger. Removed; the sentence now names the ledger |
| `docs/features/round_3/53_FR-R3-053_safe_filesystem_layer.md` finding 1 | "found **eleven** modules the item does not name" | `UNMIGRATED` minus the 5 the source review named | **DATED EVIDENCE** — registered at first, then unregistered on review. It is a historical finding, and that ledger "only shrinks" by its own gate's rule, so the first unrelated migration would have driven the derived value below eleven and demanded that a past finding be reduced to match today's tree. That is falsification, not maintenance. The sentence is now dated in place ("measured 2026-08-24 against the ledger as it then stood, at sixteen entries") |
| `docs/features/round_3/53_FR-R3-053_safe_filesystem_layer.md` finding 1 | the enumeration beneath that claim | the same ledger | **CORRECTED** — it listed ten items for a stated eleven, because `phase-log-reader.ts` and `phase-log-tail-session.ts` were collapsed into "the phase-log reader". Both are now named. The number was right; the prose was short |
| `repo/tests/evals/README.md` | "**10 cases**" | `cases` in `fixtures/backend-outcomes.json` | **REGISTERED** — this is the number FR-R3-061 wrote the file to protect, and a reader deciding what the suite proves needs it. Checked in two places: the static registry and the suite itself |
| `repo/tests/evals/README.md` | "reports **13** passing tests" | the suite's own test declarations | **IN-SUITE ASSERTION** — a lint gate cannot run the evals config, so the suite derives its own tally. Corrected to the measured figure, then twice more as this change's own additions moved it: 13 -> 15 -> 17 -> **18**, each move forced by the assertion rather than noticed by a reviewer. The derivation also refuses a declaration shape it cannot count — a `.each`, `.skip`, `.only`, `.todo`, or a bare `test(` — because any of those moves the reported tally without moving the derived one and would leave this gate green over a stale README |
| `docs/features/round_3/DONE_61_FR-R3-061_behavioral_canaries.md` | "10 cases — 13 passing tests, three of which are structural" | as above | **CITED INSTEAD** for the tally; **REGISTERED** for the cases. Restating the tally in a second document is how it drifted twice, so §1 now points at the README for it. The case count stayed transcribed, and review found it was the last number in the sweep with nothing behind it — so `deterministic corpus of **10 cases**` is a registry entry rather than a corrected string. The `**10 cases**` under "Confirmed at source" is left alone: that section records what was observed at source when the item was written, which is evidence |
| `docs/features/round_3/INDEX.md` §2 (was `00_verification_perimeter_plan.md`) | "host 643 files / 8,376 tests" at a named commit | none — a dated observation | **DATED EVIDENCE, EXCLUDED.** Not registered, not corrected, not flagged. Rewriting a recorded measurement into agreement with today's tree destroys the evidence rather than maintaining it. A test pins that it stays out of the registry and stays in the document |
| `repo/tests/contract/history-does-not-change-run-path.test.ts` | `ALL_AUDIT_EVENT_TYPES` has length 104 | the audit contract | **REMOVED** — see below |
| `repo/docs/operations/recovery-checkpoints.md` | "heartbeat goes stale (15 seconds" | `STALENESS_THRESHOLD_MS` in `repo/src/state/lock.ts` | **REGISTERED** (FR-R3-073, feature 152) — the review found the runbook saying 30 against a code value of 15, doubling a wait an operator makes while a run is stuck. The sentence now names its producer and the registry derives the seconds from the constant's declaration line |
| `repo/docs/tutorials/developer-setup.md` | "VS Code 1.107.0 or newer" | `engines.vscode` in `repo/package.json` | **REGISTERED** (FR-R3-073, feature 152) — the tutorial declared a 1.85.0 floor while the manifest required `^1.107.0`; a reader between the two installs and then fails at activation. The minor version is the moving part under the `^1` caret, so it is what is derived |
| `repo/docs/development/lint-gate-census.md` | "one rule implemented twelve times, across **794 lines**" | the twelve `no-inline-*` gates in `repo/tests/lint/`, summed | **REGISTERED** (FR-R3-174, feature 213) — the census recommends consolidating this family, so the total is the size of the prize and a stale one argues for work at a scale nobody measured. It had already drifted by the sharpest route available: the correction three lines below it dropped a 77-line member from the family and left the sum reading "roughly 930". Five other live line-count figures the same sweep found were resolved by citation or correction instead; the decision and each reason are below |

## The adjacent correction

`repo/tests/contract/history-does-not-change-run-path.test.ts` asserted a **global** audit-event count to
prove a **local** negative: that the History surface added no event type. Measured in this batch: adding one
unrelated audit event forced that number from 103 to 104, in a test belonging to a different feature.

The very next assertion in the same file already pins the intended property — no event type matching
`/histor/i` beyond two named ones — by naming the shape it forbids rather than a cardinality. So the count
added nothing except a standing obligation to re-bless it, and a number re-blessed without being read is
worse than no number.

**The count was removed. The property it stood in for remains asserted.** This is the same defect as the two
slips above, inverted: instead of a document going stale against the tree, a test went stale against
everything else.

Swept for others of the same shape: zero remaining. No test in `repo/tests/**` asserts a length on
`ALL_AUDIT_EVENT_TYPES`, on any other `ALL_*` contract constant, or on `SUPPORTED_*`. Recorded so a later
reader knows the sweep happened and found nothing, rather than wondering whether it was done.

## The dated-figure convention — 2026-09-13

FR-R3-174 / FR-025. The registry above answers "which numbers are checked". This section answers the
question underneath it: **how a reader tells a number that is supposed to be true now from a number
that was true when it was written.** A figure of the second kind must not be registered, must not be
corrected, and must not be read as a claim about today — and until now nothing said so out loud.

> **Measured 2026-09-13 (`FR-R3-174`).** The sweep that motivated this found **559** line-count
> figures near a file path in tracked Markdown: **527 dated, 32 live, 0 unclear**. The full
> classification is §M7 of `specs/213-claims-nothing-verifies/decisions.md`, in the planning
> envelope — deliberately not linked, because a relative link from here escapes a standalone `repo/`
> checkout, and the sweep found that exact defect one document over.

The ratio is the argument: the common case is a recorded measurement, so the marker has to be cheap
enough to write every time, and legible enough that the 32 stand out against it.

### The form: the Corrected / Re-measured blockquote

A dated figure sitting in prose is marked by the blockquote this tree already writes:

```text
> **Corrected 2026-08-26 (`FR-R3-102`).** This sentence said "<= 600 LoC".
> `src/controller/phase-runner.ts` is **1,035 lines**, and its budget in
> `repo/tests/lint/phase-runner-loc-budget.test.ts` is ratcheted to exactly that.
```

Three things make it the form rather than a form. It sits **adjacent to the figure**, so a reader who
finds the number finds the marker without scrolling. It states **a date and what changed**, so the
figure is falsifiable as a historical claim even after it stops being true as a current one. And it
is **already in the tree**, in `ARCHITECTURE.md` and in every measurement in this feature's research
notes — the convention is being written down, not invented, which is the posture the gate work in
this round has taken throughout.

**`Re-measured <date>`** is the same form for a figure measured again without being wrong: it records
a second observation rather than a correction. `ARCHITECTURE.md` carries both, stacked, for the same
sentence.

### When the table applies instead

A second form exists in this tree and the plan did not name it, so it is reconciled here rather than
left to collide. `docs/development/lint-gate-census.md` heads its census with:

```text
| Figure | Value | Date | Method |
|---|---|---|---|
| Gate files | **200** | 2026-09-13 | `*.test.ts` under `tests/lint/` recursively |
```

**Use the table when a document holds many figures in one place** — a census, a sweep, a measurement
record whose subject *is* the set of numbers. There, a blockquote per figure would be longer than the
figures and would bury the comparison the table exists to make; and the table earns a fourth column
the blockquote has nowhere to put, which is `Method`.

**The blockquote is the default**, and it is what a figure sitting inside prose gets. That ordering
is deliberate and is not a preference: the table cannot mark a number in the middle of a sentence
without lifting it out of the sentence, and the sentence is usually where the number does its work.
Selecting the table as the general marker would also orphan every `Corrected` annotation already
written under this convention.

**There is no third form.** If a figure fits neither — a number inside a sentence in a document that
also carries a census table — it takes the blockquote, because the test is where the *figure* sits,
not what else the document contains.

### Why the `*-review-date` marker is not reused

The obvious candidate is the existing `<!-- <name>-review-date: YYYY-MM-DD -->` marker read by
`tests/lint/review-dates.ts`. It is not reused, and the reason is structural rather than stylistic.

**That marker encodes an obligation that expires.** `reviewIsDue()` returns true once today is on or
after the date, and `dated-review-records.test.ts` goes red on the day. It was built for a dated
platform decline — *"a dated decline is only honest while someone re-reads it"* — where coming due is
the whole point.

**A dated figure needs the opposite: an exclusion that never expires.** A correctly-dated historical
number does not become wrong by the passage of time; it becomes *older*, which is exactly what the
date already says. Wiring it to the expiring marker would turn a correct historical figure red on a
calendar day, and the cheapest way to clear that red is to bump the date — which trains a reader to
clear the marker rather than check the claim. That is the failure mode this whole round exists to
close, rebuilt from the wrong parts.

So the two markers stay distinct on purpose: one says *"come back to this"*, the other says *"this
was true then, and that is all it ever claimed"*.

### What the convention does not do

It is **not gated**. Nothing scans prose for an unmarked figure, for the reason the registry's own
docblock gives and this document's next section re-applies: a heuristic over prose produces false
positives, and a gate with false positives gets switched off. What the convention buys is that a
reader who *does* look can settle the question, and that a figure this feature dates stays dated.

## Registry extension decided: one line-count entry, no completeness scan — 2026-09-14

Feature 213 (FR-028, T1754), in the four-field shape
`specs/213-claims-nothing-verifies/contracts/sweep-outputs.md` §C4 requires of every decision this cycle
makes. **Recorded here rather than in the feature directory** because the registry's own docblock names
this document as what makes the registry's size accountable, and a decision that changes that size
belongs where the accounting is.

**Decision.** Register **one** of the six unregistered live line-count figures the sweep found — the
`no-inline-*` family total in `repo/docs/development/lint-gate-census.md` — as an entry in the existing
`tests/lint/asserted-counts.test.ts`. No new file and no new gate (FR-029). The other five are resolved
by **citation or correction** and are deliberately left unregistered, each with its reason below. The
**completeness scan is declined.**

**Measurement.** `specs/213-claims-nothing-verifies/decisions.md` §M7 swept both trees — 1,897 tracked
Markdown files in the envelope, 113 in `repo/` — and found 1,189 line-count-shaped figures, 559 of them
near a file path. Of those: **527 dated records, 32 live, 0 unclear, and 0 already registered**. The
zero is the finding the decision turns on: the registry's four existing entries hold no line-count
figure at all, so nothing in this class was covered. The 32 live occurrences are eight distinct claims.
T1753 converted two of them to pointers at the tests that own their numbers. These are the remaining
six, measured on 2026-09-14:

| Claim, as written | Document | Measured now | Disposition |
|---|---|---|---|
| "one rule implemented twelve times, across roughly 930 lines" | `repo/docs/development/lint-gate-census.md` | the twelve sum to **794** | **REGISTERED**, after correcting the figure |
| "does the same job in **15 lines**" (and 12 identical table restatements) | same | **15** — accurate | **CITED** — the 12 restatements now point at the paragraph that states it once |
| "It is 872 lines and you are not expected to read all of them" | `repo/CONTRIBUTING.md` | `../AGENTS.md` is **153** | **CORRECTED**, number removed |
| "an orientation document of about 140 lines" | `docs/hard-rules.md` | `AGENTS.md` is **153** | **CORRECTED**, number removed |
| "the 293-line component this item measured at its worst" | `repo/docs/operations/lazy-route-wait-budget.md` | **293** — accurate | **NOT REGISTERED** |
| "a 9-to-25-line ledger fixture" | same | a range across five mock factory bodies | **NOT REGISTRABLE** |

**Two of the six were accurate when measured, three were wrong — by 5.7x, 17% and 8% — and one is
unpinnable.** That mix is the
argument against reading accuracy as coverage: the two are right today by luck of nobody having edited
the file, not because anything holds them.

**Reason.** Clarification Q4 fixed the rule before either sweep ran: *extend or register where the
uncovered set is small enough to enumerate by hand; decline any option requiring a heuristic over prose.*
Six claims is hand-enumerable, and they are enumerated above, so the rule admits registration — and then
a second question decides which of the six it is worth spending on, because "registrable" is not
"should be registered".

*Which of the six.* The registry's stated principle is that a count is registered **only where stating
the number genuinely serves a reader**. Applied to a red gate, that becomes a testable question: when
this entry fails, does the failure tell someone something they must act on, or only that a file changed?
The four existing entries all pass it — a corpus case moved, an operator's wait is wrong, an install
breaks. Of the six here, exactly one does:

- **The family total passes.** The census *recommends consolidating* these twelve gates, and the total is
  the size of the prize. A stale total argues for work at a scale nobody measured. It had also already
  drifted, by the sharpest route available: the `Corrected 2026-08-27` note three lines below it removed
  `no-inline-queue-item-template.test.ts` — a **77-line** member — from the family, and left the sum the
  membership determines reading "roughly 930". A correction landed one clause away from the number it
  invalidated and did not reach it. That is a demonstrated failure mode, not a hypothetical one, and the
  entry also pins the family at twelve so a thirteenth member cannot arrive under a total that still adds
  up.
- **The exemplar's 15 lines fails it.** The sentence's work is the *contrast* with the 794, and the
  contrast survives a few lines either way. A red would say only that someone edited a lint gate, and the
  sole available fix would be to re-bless `stated` — the habit this gate exists to break. The 12 table
  cells that restated it were the real exposure, and they are gone: citation, not registration.
- **`RunsSurface.svelte`'s 293 lines fails it.** The figure supports a judgement — this is the largest
  lazy route component, and `App.route-loading.test.ts` is safe because it never navigates to that route.
  Adding five lines to the component changes the number and changes nothing about the judgement. Red as
  noise, fixed by re-blessing.
- **The 9-to-25-line range is not registrable at all.** `stated` is one number by construction, and no
  static read yields a range over five inline mock factory bodies. The document should cite, and the
  sentence already does the only thing that matters — it says the fixtures are negligible next to a real
  transform.
- **Both `AGENTS.md` claims fail for a reason worth recording separately**, because they otherwise look
  like the most obviously registrable of the six — a `wc -l` of a named file. **The path `AGENTS.md`
  resolves to two different files depending on layout.** `readDocument`'s candidate list tries the
  envelope first, so in the full workspace it reads the envelope's `AGENTS.md` (**153** lines) and in a
  standalone `repo/` clone it reads `repo/AGENTS.md` (**41**). One entry would assert two different
  numbers, green locally and red in CI, and the gate has no way to say "the envelope's copy" — its
  contract is that *producers inside this repository are always read*, and this producer is not inside
  it. The figures are therefore removed rather than registered, which is the fix the registry's first
  principle would have chosen anyway: `repo/CONTRIBUTING.md` was telling every new contributor that a
  153-line file is 872 lines long and that the index exists to spare them reading it.

*Decline any option requiring a heuristic over prose* is what kills the completeness scan, and the
registry's own counter-argument — that a heuristic over prose produces false positives and a gate with
false positives gets switched off — is **confirmed by this sweep's numbers rather than merely repeated**:

| Scan, as it would be wired | Flags | Of them, genuinely live | False-positive rate |
|---|---|---|---|
| shape match near a file path, no filtering | 559 | 32 | **94%** |
| plus R1: exclude the four record path prefixes | 71 | 32 | **55%** |
| plus R2 and R3: dated header, adjacent dated marker | 33 | 32 | 3% |

R1 is a **path** rule — the same `RECORD_PREFIXES` the basename gate already uses — so it costs nothing
and reads no prose. It gets the rate to 55%, and no further. **Everything below that line is R2 and R3,
and R2 and R3 are precisely the prose heuristic Q4's rule forbids** — "does this document's header claim
a capture date", "is there a dated blockquote within five lines". A 55% false-positive gate is switched
off within a week; a 3% one is bought with the rules the rule forbids.

And this document now carries a fresh specimen of R2 failing, four sections down: `Swept 2026-08-24` in
this file's own header made R2 score **every** figure here as a dated record, including a present-tense
claim about how many entries the registry has *today*, which had been two entries stale since feature
152. The sweep found it by hand, not by rule. A heuristic over prose errs in both directions, and a gate
built on one would have been confidently wrong in both.

**What declining costs, stated rather than hidden.** 32 live figures are now accounted for; the next one
written is not. The mitigation is this document plus the convention above, which is a record rather than
a mechanism, and a record only helps a reader who looks. That is a real gap and it is the price of not
shipping a gate that gets disabled.

**FR-030 — the same rule, and it did not diverge.** T1748 applied Q4 to the citation gate and reached
*extend the extraction, decline the semantic check*; this applies it to the registry and reaches *add one
entry, decline the scan*. Both halves match: the extension and the entry are each a hand-enumerated set
attached to machinery that already exists, and the semantic check and the completeness scan are each a
judgement about prose. The two even fail for the same reason at the same place — T1748 declined semantic
staleness by quoting this registry's docblock, and this decision declines the scan by measuring what that
docblock asserted. **The one difference is a difference in the evidence, not in the rule**: T1748 could
answer its counter-argument *by construction*, because restricting extraction to comment ranges is a
lexical distinction the parser already makes and it removed four false positives out of four. No such
lexical line exists here. A figure's tier is not in its syntax.

**Revisit condition.** The scan is reopened when the live-versus-record split stops being a judgement
about prose — when tier is carried by something a parser reads. A front-matter field, or a dated figure
written in a delimiter a scanner can see rather than a blockquote a reader recognises, would turn R2 and
R3 from heuristics into lookups, and the 3% row above becomes reachable honestly. The convention written
above is the first step toward that and deliberately not the last: it standardises the *form* so that a
later mechanical reader has one shape to look for. Until then the answer is no, and the reason is the
registry's own, not indifference. The single entry is settled.

## What a later reader should know

- **The registry has FIVE entries, and the size is argued rather than asserted.** Two are the corpus case
  count in the two documents that state it; feature 152 added the lease staleness window and the VS Code
  engine floor (FR-R3-073); FR-R3-174 added the twelfth-gate line total decided below. Neither slip that
  motivated *this* item needed an entry — one was handled by citation, one by an in-suite assertion — and
  a third candidate (the safe-filesystem "eleven modules" finding) was *unregistered* on review once it
  became clear the claim was historical rather than current. Preferring citation shrinks a registry; that
  is the mechanism working, not an under-delivery. A padded registry would mean documents restating facts
  they could cite.

  > **Corrected 2026-09-14** (`FR-R3-174`, T1754). This bullet read **TWO**, and had been two entries out
  > of date since feature 152: each item that registered a count left the sentence counting registrations
  > untouched. Worth more than the correction is *why the FR-R3-174 sweep nearly missed it*. This
  > document's header is dated — `Swept 2026-08-24` — and the classification rule that reads a dated
  > header files the whole document as a record, so a **present-tense claim about what the registry
  > contains today** was scored as historical evidence and dropped from the live set. The claim is live;
  > the rule over-captured. A mechanical rule over prose errs in both directions, and that is the finding
  > the decision below rests on rather than a detail beside it.
- **The corpus pair shares a producer on purpose.** They are separate claims in separate documents, and the
  pair is also what makes the per-entry scoping assertion non-vacuous: both claim strings contain
  `**10 cases**`, so a gate that searched the tree for the number instead of reading the document that
  makes each claim would score the wrong line. A one-entry registry made that assertion iterate an empty
  list, and an earlier stand-in for it asserted prose from a document the registry no longer named.
- **Nothing is discovered automatically.** There is no scan for integers in prose. A count nobody registered
  is unchecked, and this table is how that stays visible instead of looking like coverage.
- **`repo/` cloned on its own is a supported layout, and the gate respects it.** CI checks out exactly that,
  where the planning envelope is not present, so an entry whose document lives in the envelope is *skipped*
  there rather than failed — absent is not the same as unreadable. Producers inside `repo/` are always read,
  so the producer-side direction (a count going stale because the tree moved) stays live in both layouts.
  Same predicate as `doc-duplicate-authority.test.ts` and `agents-claude-parity.test.ts`.
- **Four errors were made during this work and are worth knowing about**, because every one of them is the
  same class as the finding — the item applying its own rule to itself and getting it wrong first:
  1. The plan chose "count `it(` declarations in the suite's source" as the derivation. That yields **6** for
     a suite reporting **15**: ten of the tests are generated by a loop over the corpus cases. Exactly the
     trap FR-R3-065 hit when it counted `test(` calls in a parameterised visual suite and got 4 for 18. The
     derivation now separates standalone from templated declarations and multiplies the latter by the case
     count.
  2. The first version of that derivation matched single-quoted titles only and missed its own
     double-quoted one, reporting 6 standalone where there were 7. It caught itself on the first run —
     which is the argument for deriving a number rather than restating it in one line.
  3. The safe-filesystem "eleven modules" claim was **registered, and should not have been**. It is a
     historical finding against a ledger that only shrinks, so registering it would have demanded reducing
     a past finding on the next migration — the falsification this item's own rule forbids. Caught in
     review; the sentence is now dated in place and the entry is gone.
  4. Review found the derivation asserted only against the file it reads, so the claim that it "needs no
     maintenance" was stated rather than checked. It is now a parameterised function exercised against a
     synthetic source that gains a declaration — which moved the tally a third time, 17 -> 18.
