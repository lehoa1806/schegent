# Duplicate-authority detection — the measurements behind the threshold

FR-R3-066. `tests/lint/doc-duplicate-authority.test.ts` used to hash whole files, so it detected only
byte-identical pairs. This records the measurements that chose its replacement's threshold, its
implementation, and its scope — because a duplicate-detection threshold guessed rather than measured is the
kind of gate that gets disabled in its first month.

**All measurements: 2026-08-24, darwin/arm64, envelope at `repo/` HEAD `8d998145`.**

## What is compared

A **substantive line** is a trimmed line of a tracked markdown document that is not blank, not a heading,
not a source-marker comment (`<!-- … -->`), not a fence marker, and not inside a **closed** fenced code
block. Two documents legitimately sharing a fenced example are not two authorities.

"Closed" is load-bearing. Fences are resolved by matching each opener to a closer of the same marker
(` ``` ` and `~~~` both count, and a closer must be at least as long as its opener, so a ` ``` ` line
inside a ` ```` ` block is content) rather than by a running toggle. A toggle fails twice, and both failures
*shrink* the corpus — the one direction a duplicate detector must not fail in. An unterminated fence
swallows the rest of the document, which is not hypothetical: `specs/014-wake-up/contracts/daemon-registration.md`
carries fifteen markers, so its tail was silently excluded from every comparison; a stray marker nearer the
top would have emptied a document out of the corpus entirely, leaving a green run that proved nothing. And a
` ``` ` line inside a `~~~` block inverted the toggle for everything after it. An opener with no closer is
therefore **not** a fence: the span stays in the comparison. Comparing too much can only surface a pair a
human then reads; comparing too little reports success it has not earned.

**Overlap** is the size of the shared substantive-line multiset divided by the **smaller** document's
substantive-line count. Normalising against the smaller is deliberate: a short document wholly contained in
a long one *is* redundant authority, and normalising against the larger would score that pair low and miss
it.

## The threshold

Corpus: **1,249** tracked `.md` files at or above the existing 2,000-byte floor. Pairs meeting each ratio,
with a floor of 20 shared lines:

| Ratio | Pairs | What the band adds |
|---|---|---|
| ≥ 0.90 | 21 | same-content families only |
| ≥ 0.85 | 23 | same-content families only |
| **≥ 0.80** | **24** | **same-content families only** |
| ≥ 0.75 | 25 | + the `speckit-constitution` skill-tree pair (0.775) |
| ≥ 0.70 | 25 | nothing further; still no boilerplate pair |
| ≥ 0.65 | 30 | + 5 pairs, 4 of them shared extension-hook boilerplate (from 0.652) |
| ≥ 0.60 | 38 | + 8 more, all `speckit-taskstoissues` boilerplate (down to 0.609) |

The corpus counted here is the tree **before** this change: 1,249 documents, and the 24 pairs at ≥ 0.80
include the `api-and-cli.md` ↔ `feature-reference.md` pair this item resolved. After the consolidation the
corpus is **1,248** documents and the report is **23** pairs, all of them allowed families.

**Chosen: ratio ≥ 0.80 AND at least 20 shared substantive lines.**

Boilerplate first enters the report **below 0.70**, not below 0.80: the 12 `speckit-taskstoissues` pairs
whose only shared content is the extension-hooks block every skill file carries span 0.609–0.652, so the
loosest boilerplate-free value is nearer **0.66**. 0.80 is therefore a deliberately *conservative* choice
rather than the loosest safe one — one whole band clear of the shared-hooks floor, because a gate that fires
on ordinary shared boilerplate is a gate switched off within a round, and that margin is what keeps a newly
added skill file from putting it there.

What the margin costs is recorded rather than hidden. Exactly one genuine duplicate sits between 0.70 and
0.80 — the `speckit-constitution` skill-tree pair at 0.775, 69 shared lines — and it goes unreported. It is
an allowed family member either way, so the margin permits nothing that 0.70 would have caught; but a *new*
duplicate landing in that band would also be missed, and 0.70 is the value to reach for if that ever
happens. Between 0.70 and 0.75 the tree holds nothing at all, so that move costs no new noise today.

Both criteria are needed. The ratio alone would let two short documents sharing a handful of boilerplate
lines score 1.000; the absolute floor is what stops that.

### The highest legitimate overlap in this tree is 1.000

Byte-identical files that must both exist — the two agent skill trees read by two runtimes from two fixed
paths. So **the threshold cannot separate legitimate from illegitimate duplication by value.** It decides
what is *reported*; the allowlist decides what is *permitted*. This is the most likely misreading of the
design, so it is stated here rather than left to be inferred.

### Every pair at or above the threshold, by family

| Family | Pairs | Overlap | Disposition |
|---|---|---|---|
| `.agents/skills/**` ↔ `.claude/skills/**` | 13 | 0.822–1.000 | allowed — two runtimes, two fixed paths |
| `.specify/extensions/*/commands/**` ↔ either skill tree | 8 | 0.943–0.980 | allowed — **a third copy the byte-identity detector never surfaced** |
| `.specify/templates/plan-template.md` ↔ `specs/068-enhance-system-log/plan.md` | 1 | 1.000 | allowed — feature 068 committed the unfilled template as its plan |
| `specs/*/checklists/requirements.md` ↔ each other | 1 | 0.909 | allowed — generated from one template per feature |
| **`api-and-cli.md` ↔ `feature-reference.md`** | 1 | **1.000** | **resolved by this change** |

## The implementation, measured three ways

All three report the **same pairs** — 24 on the pre-change tree, 23 after consolidation. Timed in Node over
the real corpus:

| Approach | Time |
|---|---|
| All pairs, rebuilding each document's line counts per pair | 5,804 ms |
| Shared-line candidate index, exact overlap per candidate | 2,789 ms |
| **All pairs, each document's counts built once, iterating the smaller** | **1,163 ms** |

**Chosen: the third.** The index is *slower* than the simple comparison done properly, and the data shows
why: the widest single substantive line is shared by **456 documents**, which alone generates roughly
104,000 candidate pairs; the index produced 185,115 candidates in total — more bookkeeping than the
comparison it was meant to avoid.

This **overturns the decision reached during clarification**, which was to index. Recorded as an overturned
decision rather than quietly changed: "measure before choosing" is this item's own discipline, and it
applies to its implementation as much as to its threshold. If the corpus grows by an order of magnitude,
this is where cost will show, and the index — written once and discarded — is the change to reach for then,
with a fresh measurement.

## Why the scan is tracked-only

The tree contains `scratch/`, which is **gitignored**, holding a document scoring **1.000** against a
tracked one. The predecessor gate survived this only because the two are not byte-identical. Under
substantive-line overlap it would fail every developer who has that directory.

So the corpus is enumerated with `git ls-files` in both repositories: hermetic, respects `.gitignore` by
construction, and scoped to what actually ships. If that enumeration fails the gate **fails and names the
cause** — it does not fall back to a filesystem walk, because a silently widened scope produces failures a
contributor did not cause, and it does not skip, because an inconclusive check must not report success.

**Absent is not the same as unreadable.** `repo/` cloned on its own is a supported layout — CI checks out
exactly that, and there the parent directory is not a repository at all, so `git -C .. ls-files` exits 128.
Failing there would report an *environment* as a duplicate-authority defect, so envelope presence is tested
first, with the same predicate `scripts/check-doc-links.mjs` uses (`ARCHITECTURE.md`, `CLAUDE.md` and
`docs/` one level up). When it is absent the scope narrows to this repository — 63 documents above the size
floor, **0** pairs at or above the threshold — the corpus floor scales with it, and the two assertions that
need an allowed envelope pair to check against skip rather than fail. A root that *is* present and cannot be
listed still fails hard.

## The consolidated pair — content baseline

Captured **before** any edit, so "no content lost" is checked against a fact rather than a memory:

| Document | Substantive lines | Unique to it |
|---|---|---|
| `api-and-cli.md` | 147 | **0** |
| `feature-reference.md` | 148 | **1** — its introductory paragraph |

Union: 145 distinct substantive lines. Consolidation therefore loses nothing provided that one paragraph is
carried across, which it was.

Inbound references decided which document survives. Counting **resolvable markdown links** rather than
mentions:

| Document | Live links | From |
|---|---|---|
| `api-and-cli.md` | **3** | `docs/how-to/feature-guides.md`, `docs/reference/commands.md`, `docs/courses/develop-schegent.md` |
| `feature-reference.md` | **1** | `docs/how-to/feature-guides.md` |

Deletion was chosen over a stub because a stub that restates rather than points is the same defect smaller,
and a stub is where a duplicate regrows.

**A correction to this measurement, recorded rather than quietly fixed.** The first pass concluded that
every citation in `docs/audits/**` and `docs/features/round_3/**` was a backticked filename rather than a
link, and therefore that deletion broke nothing. That was **wrong**: it sampled the four audit files and
three repository documents, not the whole planning tree. `npm run docs:check` then found two genuine
markdown links, both in round-3 planning documents —
`00_backlog_verification_gaps_plan.md:90` and the source item `66_FR-R3-066…md:6`.

Both were resolved the way this repository's own link checker prescribes for a target that is gone for
good: the link became inline code carrying the reason (`` `feature-reference.md` (deleted by `FR-R3-066`;
consolidated into `api-and-cli.md`) ``). That is not rewriting a dated record to match today's tree — the
cited fact and its measured numbers are untouched, and only a now-dangling navigation link became the
citation it always semantically was.

The four dated **audit** documents were, as measured, code spans only: **0** markdown links among them, and
none was edited. Confirmed by an empty `git diff docs/audits/`.

The error is worth keeping visible because it is the same class as the finding this item closes — a
confident conclusion drawn from a partial scan.

## Observed non-vacuous

**2026-08-24, darwin/arm64.** Command in every case:
`npx vitest run tests/lint/doc-duplicate-authority.test.ts`. Each seed was tracked with `git add -N` (the
scan is tracked-only, so an untracked seed would prove nothing), then removed.

| Seed | Result |
|---|---|
| A `repo/docs/reference/` document carrying `api-and-cli.md`'s body under a different H1 and a new intro paragraph | **red** — `SEED-near-duplicate.md == api-and-cli.md (148 shared substantive lines, 100.0% of the smaller)`. This is the exact shape the byte-identity detector passed over |
| The same body placed in the planning envelope at `docs/SEED-cross-boundary.md` | **red** — named across the boundary, so the envelope scope survived the rewrite rather than being assumed to |
| Two documents each with 70 unique paragraphs plus the same 40 lines of extension-hook boilerplate | **green** (9 passed) — 36% overlap, below the threshold |

The third is the one that decides whether this gate stays in the chain. A check that fired on shared
boilerplate would be switched off within a round, and asserting only the red directions would not have
shown that it does not.

The corrected tree passes at **9 tests in 1,095 ms**, which matches the 1,163 ms measured for this
implementation above.

## What this gate does not do

- It reads **heading text out** of the comparison, so two documents with identical bodies under different
  section titles still match. That is the intent — a re-framing is the defect — but it means the gate cannot
  distinguish "same body, different structure" from "same body, same structure".
- It is **quadratic in the corpus**. At 1,249 documents that is 1,163 ms. Measured, not assumed.
- It scans **tracked files only**, so duplication in untracked files is invisible. Those ship to nobody.
- It scans **the envelope only when the envelope is there**, so a standalone `repo/` clone checks 63
  documents rather than 1,248.
- It resolves **duplication, not correctness**. Two documents can be distinct and both wrong; that residual
  belongs to review.
