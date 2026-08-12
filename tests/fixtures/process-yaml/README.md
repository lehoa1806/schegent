# Process-YAML conformance corpus

The authority for the **grammar** — what the reader accepts as syntax, and what
it refuses — is
[`specs/085-pipeline-package-exchange/contracts/yaml-grammar.md`](../../../../specs/085-pipeline-package-exchange/contracts/yaml-grammar.md).
The authority for the **third document kind**, `kind: Workflow`, is
[`specs/086-workflow-package-exchange/contracts/workflow-yaml-grammar.md`](../../../../specs/086-workflow-package-exchange/contracts/workflow-yaml-grammar.md),
which adds no production to the grammar and so defers to the 085 contract on
every syntactic question. Where a fixture and the grammar disagree, the grammar
is right and the fixture is a bug.

The corpus is driven by [`tests/contract/process-yaml-grammar.test.ts`](../../contract/process-yaml-grammar.test.ts).

## Layout

```text
accepted/<vintage>/<name>.yaml        a document the reader accepts
accepted/<vintage>/<name>.tree.json   the exact node tree it parses to
refused/<vintage>/<name>.yaml         a document the reader refuses
refused/<vintage>/<name>.refusal.json the exact { code, message } it refuses with
```

`<vintage>` is the feature that introduced the case:

- **`084`** — the single-Phase format as shipped. This half is the regression
  half: every expectation in it was captured by running the **pre-change**
  reader (bundled from the commit that shipped feature 084), not the reader
  under test. That is what makes the additive-widening guarantee of research R1
  machine-checked rather than asserted — if this feature had altered any
  existing behavior, the capture and the current reader would disagree.
- **`085`** — the one production the subset gained, plus the narrowings that
  bound it. Every fixture in `accepted/085/` was refused by the pre-change
  reader as `block sequences are not part of this format`, which is what makes
  each of them genuinely new rather than an accident of the old grammar.
- **`086`** — the Workflow document kind. This half adds **no** production. It
  exists because the Workflow kind reaches the subset's deepest nesting — a
  condition literal list inside a connection item, four levels below `spec:` —
  and someone has to prove that depth parses under the grammar as it already
  stands. `accepted/086/` is that proof; `refused/086/` proves the 085
  narrowings still bite down there (a flow sequence, a bare dash, and an item
  sharing a level with a sibling key are all still refused, at the token). If a
  fixture in this vintage ever needs a scanner change to pass, the feature was
  mis-planned — see the T001 gate in the runner.
- **`091`** — a **narrowing**, authorized by FR-034 of
  [`specs/091-process-platform-wiring/spec.md`](../../../../specs/091-process-platform-wiring/spec.md)
  and specified in
  [`contracts/surrogate-escape-grammar.md`](../../../../specs/091-process-platform-wiring/contracts/surrogate-escape-grammar.md).
  This is the only vintage that takes documents *out* of the language. A `\u`
  escape naming half of a surrogate pair used to decode to a code unit that is
  not a character, which the export write then rewrote to U+FFFD — import →
  export corrupted the document with no error and no warning. The four cases in
  `refused/091/` are four distinct ways a lookahead can be written wrong, and
  each of them would pass a corpus holding only the other three.
  `accepted/091/` is the other side of the narrowing: a **well-formed** pair is
  still legal and still decodes to the one character it denotes. Note what that
  fixture cannot show — the runner parses and compares against the captured
  tree, and never serializes, so byte-identical round-tripping is asserted in
  `tests/integration/process-yaml/pipeline-package-round-trip.test.ts` instead.

The widening removes exactly one 084 refusal — an outright block sequence — so
that case is deliberately absent from `refused/084/`. What stands in its place
is `refused/085/`, the narrowings *on* the new production. Every one of them
still refuses with `disallowed-syntax`, at the token.

## What is not here, and why

- **The size bound and the encoding guards.** `too-large` and `unreadable`
  refusals are byte-level, not grammar-level. They are pinned in
  `tests/unit/process-yaml/yaml-parser-guards.test.ts`, which proves with a spy
  that the scanner is never entered — a property no on-disk fixture can show.
  A 1 MiB fixture would also add a megabyte to the repository for a case
  already covered.
- **Line-ending and trailing-newline variance.** This repository has no
  `.gitattributes`, so a checkout may normalize the bytes of a file and a
  fixture cannot promise its own line endings. The CRLF and
  no-trailing-newline cases are constructed in memory in
  `tests/unit/process-yaml/yaml-scanner.test.ts`, where the bytes are exact.
  Every fixture here is authored LF with a trailing newline.

## Adding a case

Author the `.yaml`, then run the test once with the expectation file absent: it
fails naming the file it wants. Write the expectation by hand from the grammar —
do not paste in whatever the current reader happens to produce, which is how a
golden corpus quietly ratifies a regression.
