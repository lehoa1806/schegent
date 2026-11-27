# Absent-field assertion classification

**Captured**: 2026-09-06 · **Feature**: 206 (`FR-R3-167`) · **Tree**: `repo/` at `1a8cccef`

**Produced by**: `tests/lint/absent-field-census.test.ts`.

Every figure this classification discusses — how many test files were read, how many contract
documents were discovered, how many assertions each discovery pattern found, how many were
classified and how many were not, and which assertion contradicts which contract — belongs to that
gate and is recomputed on each of its runs. None of them is copied onto this page. To see them, run
the gate:

```bash
npx vitest run tests/lint/absent-field-census.test.ts
```

The gate prints a coverage block and, on failure, the offending assertion next to the contract line
that governs it. That output is the register. This page explains the method, names the kinds of
answer it produces, and states what it cannot decide.

This page exists because its predecessor did the opposite. `docs/audits/absent-field-assertion-census.md`
in the workspace envelope wrote its own counts down, listed its own findings by `file:line`, was
never re-run, and decayed into a snapshot of a tree that no longer existed — the failure
`FR-R3-167` was filed to end. A record that names its producer cannot drift, because it makes no
claim of its own to go stale. A page that transcribes the register is a second copy of the same
mistake, however carefully it is written, which is why no such table appears below.

---

## What was classified

Every assertion in the repository's test sources that claims a field is **absent** — five patterns,
the same five the retired census defined, carried verbatim in the gate's own text:

| Family | What it matches |
|---|---|
| A | `not.toHaveProperty(` |
| B1 | `.<name>).toBeUndefined()` |
| B2 | `.<name>).toBe(undefined)` |
| B3 | `.<name>).toBeNull()` |
| B4 | `.<name>).toBe(null)` |

The population is read from two roots: the host suite under `tests/`, and the webview suite under
`webview-ui/src/`. Both, because the discovered corpus includes `sidebar-ipc*.md`, which governs
exactly the host/webview boundary the second suite tests. Reading the host suite alone would make a
claim about a contract while blind to half the code that contract binds.

An assertion becomes a **candidate** when its field name is quoted in a discovered payload contract,
and a candidate becomes a **finding** when that contract's declaration of the name carries no
conditionality marker — no nullable union member, no optional-property marker, no phrase saying the
field is only sometimes there. A finding is a contradiction: a test says a field is absent, and the
document that governs the field says it is always present.

Contracts are discovered, not listed, by the retired census's basename rule — `audit-events*.md`,
`sidebar-ipc*.md`, `state-schema*.md`, `audit-payload-delta*.md` — across `repo/docs/` and the
workspace envelope's `specs/`. Several of them are unified diffs (`*.diff.md`). In those, a line
added by the diff declares what the contract now says and is read with its leading `+` stripped; a
removed line declares what the contract no longer says and is skipped.

## Line count versus assertion count

The gate reports both, and they differ in both directions. Neither number stands in for the other,
and the coverage block carries the reconciliation so the difference is accounted for rather than
sitting unexplained in a total.

**Lines a search sees that are not assertions.** A pattern's own text can sit inside a **comment**:
a note explaining why the assertion below it would pass on `undefined`, a file header describing
the assertions in the file, a fixture comment in this feature's own unit tests pinning the exact
shape a raw `grep -n` counts and the scanner does not. The scanner blanks comment spans before
matching, so it does not count them; the gate reports the comment-sited lines per family, and
asserts that for every family the discovered lines are exactly the code-sited lines plus the
comment-sited ones.

**Assertions a search cannot see.** Two widenings are deliberate, and both are reported:

1. An assertion the formatter wrapped across a newline. The scanner matches over the whole
   comment-blanked source rather than line by line, so it reads them.
2. The two-argument `expect(value, message)` form. A line-oriented pattern anchored on `)` directly
   before the matcher misses every one of them.

A wrap and an invisibility are not the same thing, and the coverage block counts them separately
because reading the first as the second overstated the gate's reach. A B-family pattern begins at
the property access, so `expect(\n  record.name\n).toBeNull()` puts the only text a search could
match on a line of its own that matches nothing: one assertion, zero matching lines. A family A
pattern begins at `not.toHaveProperty(` and its capture may close empty, so the opening line of
`expect(x).not.toHaveProperty(\n  'name'\n)` still matches on its own and `grep` still prints it:
one assertion, one matching line, wrapped but not invisible. The block reports the wrapped count and
the invisible count on separate rows, and the invisible one is measured per assertion — asked of
each assertion's own starting line — rather than inferred from either the wrap or the arithmetic.

The remaining excess of assertions over code-sited lines, where there is one, is a line carrying
more than one assertion of the same family.

## The contradictions, and how each was resolved

Every contradiction this classification found was a **name collision**, with one exception noted
below: the asserted field name is a name some contract governs, but the object being asserted on is
a different record type from the one that contract describes. `runId` on a queue task is not
`runId` on an audit envelope; `phaseId` on a sidebar projection row is not `phaseId` on a
`phase-end` payload; `iterationN` on a phase-log *selection*, where the contract's own type is
`number | null`, is not `iterationN` on a `phase-breakpoint-fired` payload, where it is declared
unconditionally.

In each case both accounts were accurate — the test is right about its receiver and the contract is
right about its own record — so each was resolved the same way: an adjacent dated decision note on
the assertion, naming the receiver and the contract it was confused with, per the note grammar the
gate enforces. **No test was edited to silence a finding, and no contract was changed.** Where a
test's assertion was genuinely weaker than the behaviour it meant to pin, it was strengthened, not
relaxed.

The one contradiction that is not a name collision is the method's own limitation showing through.
In `expect(row.phaseProgress, row.id).toBeNull()`, `row.id` is `expect`'s message argument, not the
asserted expression — but the discovery patterns match text, and to a text scanner `row.id` reads
as the asserted name. The note records that, so the gate stays green without the pattern being
widened to guess at argument positions.

To see the current set — which assertions, on which lines, against which contract line — run the
gate. It reports each one with its governing declaration quoted back.

## What could not be classified

Three kinds of assertion are carried forward with a named reason rather than dropped, and the gate
reports the three separately on every run. They are named apart because a single "unresolvable"
bucket would misdescribe most of its own membership to anyone who went looking.

**Dynamic key.** `not.toHaveProperty(key)` where the argument is a variable, an interpolated
template string, or a computed expression such as a concatenation. There is no literal name to look
up in a contract, and the gate does not evaluate test code to find one.

**Non-identifier literal.** `not.toHaveProperty('9bad')`, `not.toHaveProperty('has-dash')`. The name
is written out in full — nothing about it is dynamic — but no contract declares a field under a name
that is not a JavaScript identifier, so there is nothing to look up. Calling these dynamic, as the
first cut of this gate did, misdescribes what a reader following the label would find.

**Declaration not located.** A contract quotes the field name in backticks, but nowhere declares it:
the name appears in a prose sentence, a bullet list of preserved fields, or a Notes cell belonging
to some other field's row. Every distinct name in this bucket was checked against the discovered
corpus by hand on the capture date, against the tree named at the top of this page, and the verdict
held in each case — mentioned, never declared. Because nothing declares them, nothing says whether
their absence contradicts anything, and the gate says so rather than guessing. The live list is in
the gate's output; it is not transcribed here, for the reason this page opens with.

## Limitations this work does not lift

Stated as limitations, because a gate whose reach is not written down reads as a stronger claim than
it is.

1. **The corpus is a basename rule.** A payload contract filed under any other name is invisible to
   the gate. Widening the rule was deliberately rejected: a gate that grows its own corpus answers a
   different question every release, and no two of its runs would be comparable with each other.
2. **Conditionality written in English is read by a phrase list.** A contract that says a field is
   only sometimes present in a phrasing outside that list reads as unconditional and produces a
   finding. Each phrase in the list earns its place by appearing in the discovered corpus and is
   pinned by a unit test, so widening it is a visible edit — that is the guard, not an absence of
   the problem.
3. **Receiver type is not inferred.** The gate matches a field *name*. Whether the asserted object is
   the record the contract governs is a human judgement, and it is the judgement the decision note
   carries. Every contradiction described above is of exactly this kind.
4. **The scanner reads text, not syntax.** It has no type information and no AST. It matches over the
   whole source with comment spans blanked — that, and only that, is what keeps the comment-sited
   line count and the assertion count apart — but it cannot tell an asserted expression from another
   argument in the same call. Finding those comment spans needs a hand-written lexer for strings,
   templates and regex literals, and a construct it reads wrong desynchronises silently in both
   directions: real comments left unblanked, or real code blanked and its assertions gone from the
   population with nothing said. Two such constructs were found by differential-testing the blanker
   against the TypeScript compiler's own comment ranges over the whole corpus, and both are now
   pinned by unit tests. That comparison is the guard, and it is a check someone must think to run
   again — not a property the design provides.

   The lexer recovers from an unterminated string, template or regex by discarding the failed scan
   and stepping forward one character, which is the right reading and is quadratic: a file of
   nothing but openers costs a scan per opener. Each file therefore gets a fixed allowance of
   sub-scan work, and a file that exhausts it is reported *unscannable* — named, with its reason,
   and dropped from every count rather than silently contributing zero. The gate fails on a
   non-empty unscannable list, so such a file stops the build and gets looked at. Two consequences
   follow. A file that legitimately needs more work than the allowance would be refused rather than
   scanned slowly, though the allowance is eight times what the whole corpus asks for today. And an
   unscannable file is read as all code and no comment, never the reverse: reading it as comment
   would let any dated line in it stand in for a decision note.
5. **An `expect(value, message)` whose message contains a parenthesis, or runs past 200 characters,
   is invisible — not merely unclassifiable.** The message is read up to the first paren of either
   sort and no further than 200 characters. Bounding it that way is what stops the pattern reaching
   across a call boundary and pairing one property access with some distant matcher, which would
   manufacture assertions that are not there. The cost is that these two shapes drop out of the
   population entirely rather than being carried forward with a reason.
6. **A document that declares one name twice is answered by its unconditional declaration.** Where a
   contract declares a field both conditionally and unconditionally — two payload sections, or a
   table row and a fenced interface — the gate reports the unconditional one and the assertion
   becomes a finding needing a note. It resolves a genuine ambiguity in the direction of noise
   rather than silence, because the alternative put the assertion in `ordinary`, where it is a bare
   count with no row and nothing to notice.
7. **An occurrence inside a string literal counts as an assertion.** Strings are skipped when
   finding comment boundaries but are not blanked, so a pattern quoted in a test fixture is part of
   the population. This is why every fixture field name in the gate's own unit tests is invented
   rather than borrowed from a real contract: an invented name matches nothing the corpus quotes and
   classifies as ordinary. Borrowing a real field name into a fixture string would manufacture a
   finding.
8. **A diff contract is read from its added side only.** A `*.diff.md` declaration on a removed line
   is skipped, on the ground that the contract no longer says it. If a diff is ever filed the other
   way round — recording a removal that has not happened — the gate reads the wrong side of it.
9. **The gate proves a note exists and is dated.** It does not read the reasoning, cannot tell a true
   note from a false one, and has no expiry: a note dated years ago still satisfies it. What it
   prevents is a contradiction landing *silently*.
10. **A pass is a bounded claim.** It says the discovered assertions in the discovered contracts
   carry notes. It does not say the contracts are right, that the corpus is complete, or that the
   tests are testing the right thing.

## Related

- [Gate integrity measurements](gate-integrity-measurements.md) — the vacuity detector this gate is
  classified by, and why a gate must prove it scanned something
- [Audit event reference](../reference/audit-events.md) — the one payload contract that lives in
  `repo/`; the rest are in the workspace envelope's `specs/`
