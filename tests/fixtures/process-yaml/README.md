# Process-YAML conformance corpus

The authority for everything in this directory is
[`specs/085-pipeline-package-exchange/contracts/yaml-grammar.md`](../../../../specs/085-pipeline-package-exchange/contracts/yaml-grammar.md).
Where a fixture and the grammar disagree, the grammar is right and the fixture is
a bug.

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
