# Reference documents — what is authoritative for what

One subject, one authority. This exists because two documents in this directory were the same document.

## The consolidation decision (FR-R3-066, 2026-08-24)

`feature-reference.md` and `api-and-cli.md` shared **147 of 148 substantive lines** — the entire difference
was the H1 and one introductory paragraph. Two authorities for one subject: an edit landing in either left
the other quietly wrong, and a reader had no way to tell which was current.

**Decision: consolidated into `api-and-cli.md`. `feature-reference.md` deleted.**

**Consolidate rather than differentiate.** At that overlap, differentiating would have meant *authoring* a
genuinely distinct second document rather than editing one — a large job with no reader benefit, and the
original deliverable preferred consolidation.

**`api-and-cli.md` survives** because it carried three resolvable inbound links against the other's one.
The single unique paragraph was carried across first, verified line-by-line against a baseline captured
before the edit: zero substantive lines lost.

**Deleted rather than stubbed.** A stub that restates a section instead of pointing at it is the same defect
smaller, and a stub is where a duplicate regrows. Two planning documents linked the deleted file; both links
became inline citations carrying the reason, which is what this repository's link checker prescribes for a
target that is gone for good.

The measurements behind all of this — including the threshold the detector now uses, and a correction to one
of them — are in
[Duplicate-authority threshold measurement](../operations/duplicate-authority-threshold-measurement.md).

## What is authoritative

| Document | Authoritative for |
|---|---|
| [`api-and-cli.md`](api-and-cli.md) | every shipped command surface: Command Palette commands and their arguments, the host/webview boundary operations, and the access-control vocabulary. The exhaustive user-facing reference |
| [`commands.md`](commands.md) | the Command Palette entries as an operator index, pointing into `api-and-cli.md` for argument detail |

`tests/lint/doc-duplicate-authority.test.ts` enforces the one-authority rule by substantive-line overlap
across the whole envelope. Adding a document that restates an existing one fails it.
