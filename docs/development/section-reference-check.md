# Section references are not checked by `docs:check`: decided 2026-10-20

**Decided**: 2026-10-20 (`FR-R3-184`, feature 219), on a count taken that day · **Gate**: none reads
this file. `scripts/check-doc-links.mjs` states the outcome in its header and points here.

<!-- Source: scripts/check-doc-links.mjs -->

`docs:check` resolves the path of every relative Markdown link and strips the `#fragment`. A
sentence can therefore name a section that the file it links no longer has, and still pass. One
such sentence raised this question. The planning envelope's README sent new contributors to build
commands under a label that `repo/README.md` lost on 2026-08-23. The link resolved and the label did
not, and nothing reported it until a reviewer read it. This page records whether `docs:check` should
also resolve the section a reference names. The question was decided on a measured count.

## The rule, fixed before the count

The rule was fixed on 2026-10-20 in the feature's specification (its decision D6), before any
reference was counted:

- A reference is **mechanical** when its syntax alone fixes both its target and the section it
  names. That means a link fragment, `[text](file.md#heading)`, or a `§` marker directly after a
  link or a backticked path, as in `` `file.md` §4.2 `` or `[file](file.md) §"Heading"`. Any other
  reference is **prose**.
- **Build** a check for the mechanical forms if live documents hold **ten or more** mechanical
  references that do not resolve. **Decline** below ten.
- **Decline** a check over prose, whatever its count. Finding a section named in free prose needs a
  heuristic, and a heuristic over prose produces false positives. That is the argument
  `tests/lint/asserted-counts.test.ts` makes for discovering nothing.

The threshold of ten sits between the two bounds the filing set: two such references would not
justify a gate, and twenty would. It was fixed before counting, so the count could not choose its
own threshold.

## Decision

**Declined.** `docs:check` keeps resolving paths only. It resolves neither heading fragments nor `§`
markers. The live failures the count found are listed below as ordinary documentation repairs, and
no check enforces them.

## Measurement

The sweep was taken at workspace commit `638714b` and `repo/` commit `bfd2b65b`. It covered the 481
tracked Markdown files that `docs:check` reads. The sweep is committed with feature 219 as
`specs/219-prose-hops-resolve/measure/section-refs-sweep.mjs`, and its report is
`specs/219-prose-hops-resolve/sweep.md`. These are the figures on that date:

| References naming a section, heading, label or phrase in another file | Found | Do not resolve |
|---|---|---|
| Mechanical, in live documents: **the number the rule reads** | 36 | **9** |
| Prose, in live documents | 56 | 2 |
| In dated records | 381 | 22 |
| **All** | **473** | **33** |

"Dated records" means pages under the spec, filing, audit and plan prefixes. It also includes three
pages whose banners declare them records, and records were never edited.

On that date the nine live mechanical failures named three distinct targets:

- six checklist links in `.github/PULL_REQUEST_TEMPLATE.md` named a "Hard rules when changing host
  code" heading in the envelope's `CLAUDE.md`. That file had become a pointer, and the heading had
  moved to `docs/hard-rules.md`;
- two links in `webview-ui/README.md` named a `#model-catalog` heading that
  `docs/operations/process-yaml.md` did not have;
- `docs/development/gate-integrity-measurements.md` named a `RELEASE.md` section, "what was
  withdrawn", that `RELEASE.md` did not have.

Both live prose failures were in the envelope. Its `CONTRIBUTING.md` sent readers to a
"Verification" section of its README that did not exist. A product requirements draft named a
`Dashboard.svelte` that did not exist. The report lists every failure, records included, by file and
line at those commits.

## Reason

1. **The count is below the bar fixed before it was taken.** Nine live mechanical failures, over
   three distinct targets, is fewer than ten. The rule therefore says decline. It is applied as
   written, not argued again after the count.
2. **Neither defect that raised the question was mechanical.** The README pointed, in running prose,
   at a plain label that had never been a heading. A fragment check would not have seen it, and a
   prose check is declined. A check here would have caught a different class from the one reported.
3. **The scope statement's old reason covered line anchors only. This is the reason for headings.**
   The checker's header stripped `#anchor` and `#L42` alike, "because line anchors move with every
   edit". That is true of line anchors, but a heading anchor moves only when its heading is renamed.
   Heading anchors stay unresolved because of the measurement above, not because they are noise. At
   nine live failures over three targets, a re-count on demand costs less than a check that every
   contributor's change must pass.
4. **A heading-only rule would misread a convention this tree uses.** Filings number their
   deliverables as list items, and other pages cite them as `§3.4`, meaning item 4 under heading 3.
   In the count, five `§` failures in dated records resolve that way, and so do four prose references
   in live pages. Any future check must read that convention or exempt it, or it will fail correct
   citations.

## Revisit condition

Reopen this decision when either of these is observed:

1. **A re-count reaches ten.** The committed sweep is read-only and takes one command at any two
   commits. Reopen when it finds ten or more mechanical references in live documents that do not
   resolve.
2. **The tree adopts a convention a check can read for prose.** An example would be writing every
   section reference as a fragment link. That would move references from prose into the mechanical
   forms, so the count must be retaken before the rule is applied again.

To re-count, run `node specs/219-prose-hops-resolve/measure/section-refs-sweep.mjs --out <new file>`
from the workspace root. It reads both repositories at their `HEAD` by default, or at the commits
passed with `--ws` and `--repo`.
