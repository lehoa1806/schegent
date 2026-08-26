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
| `docs/features/round_3/00_INDEX.md` §2 (was `00_verification_perimeter_plan.md`) | "host 643 files / 8,376 tests" at a named commit | none — a dated observation | **DATED EVIDENCE, EXCLUDED.** Not registered, not corrected, not flagged. Rewriting a recorded measurement into agreement with today's tree destroys the evidence rather than maintaining it. A test pins that it stays out of the registry and stays in the document |
| `repo/tests/contract/history-does-not-change-run-path.test.ts` | `ALL_AUDIT_EVENT_TYPES` has length 104 | the audit contract | **REMOVED** — see below |
| `repo/docs/operations/recovery-checkpoints.md` | "heartbeat goes stale (15 seconds" | `STALENESS_THRESHOLD_MS` in `repo/src/state/lock.ts` | **REGISTERED** (FR-R3-073, feature 152) — the review found the runbook saying 30 against a code value of 15, doubling a wait an operator makes while a run is stuck. The sentence now names its producer and the registry derives the seconds from the constant's declaration line |
| `repo/docs/tutorials/developer-setup.md` | "VS Code 1.107.0 or newer" | `engines.vscode` in `repo/package.json` | **REGISTERED** (FR-R3-073, feature 152) — the tutorial declared a 1.85.0 floor while the manifest required `^1.107.0`; a reader between the two installs and then fails at activation. The minor version is the moving part under the `^1` caret, so it is what is derived |

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

## What a later reader should know

- **The registry has TWO entries, both for the corpus case count, and that is the honest size.** Neither
  slip that motivated this item needed one — one was handled by citation, one by an in-suite assertion —
  and a third candidate (the safe-filesystem "eleven modules" finding) was *unregistered* on review once it
  became clear the claim was historical rather than current. What the two entries cover is the count that
  survived as a transcription in two documents because a reader of each genuinely wants it. Preferring
  citation shrinks a registry; that is the mechanism working, not an under-delivery. A padded registry would
  mean documents restating facts they could cite.
- **The two entries share a producer on purpose.** They are separate claims in separate documents, and the
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
