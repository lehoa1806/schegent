# `tests/lint/gate-integrity/` — what this tier claims, and what it does not

FR-R3-088 asks a narrow, uncomfortable question: *a gate I wrote to pass my own code is not
independent evidence about my code.* This tier is the answer that can be given mechanically. It
**measures** the gate suite's own controls rather than asserting they are sound.

## What it claims

- **The zero-offender list is generated**, not transcribed. Each scanning gate's own offence
  predicate is run over `src` and `tests`; a gate with no in-tree match is listed by that run, so the
  list cannot go stale the way a checked-in copy would.
- **Every denominator is printed.** A rate without its denominator is a number, not a measurement.
- **Mutation happens in memory.** The census transforms gate source text as a string and re-runs the
  detector's predicate on it. No file on disk is modified, so a failed run cannot leave the tree
  altered.

## What it does NOT claim

- **It does not prove any gate is sound.** It measures how often the vacuity detector calls a
  deliberately-neutered control "controlled". A low rate is evidence the detector is useful; it is
  not evidence that any particular gate constrains what its name says.
- **It makes no claim about gates it did not mutate.** The census covers the gates the detector
  classifies as controlled. Gates outside that set are outside the number, and the number says so.
- **It is not a substitute for the independent review.** FR-R3-088 §5 is explicit: this removes four
  of a reviewer's cheapest objections so the review can spend its time on the expensive ones. It
  does not discharge exit criterion 8, and `docs/audits/` is where that obligation lives.

## Why the mutation fixtures are derived from the tree

A fixture authored beside a gate demonstrates that the gate catches the thing its author imagined.
A fixture derived by transforming a real source file demonstrates that it catches the thing the tree
can actually produce. Where the tree has no natural offender, the derived mutation is the honest
substitute — and a gate with no offender is **unproven, not useless**, so nothing here deletes one.
