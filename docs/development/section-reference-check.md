# Section references are checked by `docs:check`: decided 2026-10-20

**Decided**: 2026-10-20 (`FR-R3-184`, feature 219), on a count taken that day and corrected the same
day · **Gate**: `scripts/check-doc-links.mjs`, run by `npm run docs:check`, whose logic is held by
`tests/lint/doc-section-references.test.ts`

<!-- Source: scripts/check-doc-links.mjs -->
<!-- Source: tests/lint/doc-section-references.test.ts -->

`docs:check` always resolved the path of every relative Markdown link. Until this decision it
stripped the `#fragment`, so a sentence could name a section that the file it linked no longer had,
and still pass. One such sentence raised the question. The planning envelope's README sent new
contributors to build commands under a label that `repo/README.md` lost on 2026-08-23. The link
resolved and the label did not, and nothing reported it until a reviewer read it. `docs:check` now
also resolves the section a live document names in another file. This page records why, on what
count, and what would reopen the decision.

> **Corrected 2026-10-20.** This page first recorded the opposite outcome: declined, on a count of
> nine. Review found the cause. The count read `§` markers one line at a time, so it missed a
> marker that wraps onto the next line after its link, which the rule's definition includes. With
> it the count is ten, and the rule says build. The decision changed, so the page is rewritten. Its
> first version is in the commit history.

## The rule, fixed before the count

The rule was fixed on 2026-10-20 in the feature's specification (its decision D6), before any
reference was counted:

- A reference is **mechanical** when its syntax alone fixes both its target and the section it
  names.
  - That means a link fragment, `[text](file.md#heading)`.
  - It also means a `§` marker directly after a link or backticked path, with only whitespace
    between, a line break included. The marker must be followed by a quoted or emphasised name
    (`` `file.md` §"Heading" ``) or by a numbered identifier (`` `file.md` §4.2 ``). A marker
    followed by bare words is prose.
  - Any other reference is **prose**.
- **Build** a check for the mechanical forms if live documents hold **ten or more** mechanical
  references that do not resolve. **Decline** below ten.
- **Decline** a check over prose, whatever its count. Finding a section named in free prose needs a
  heuristic, and a heuristic over prose produces false positives. That is the argument
  `tests/lint/asserted-counts.test.ts` makes for discovering nothing.

The threshold of ten sits between the two bounds the filing set: two such references would not
justify a gate, and twenty would. It was fixed before counting, so the count could not choose its
own threshold.

## Decision

**Built.** In every live document `docs:check` walks, it resolves two kinds of section reference:

- a link fragment naming a heading in another Markdown file. It resolves against the target's
  GitHub heading anchors and explicit HTML ids;
- a `§` marker directly after a link or backticked path naming another file. It resolves by heading
  text, by a quoted name ending in an ellipsis as a prefix, or by a numbered identifier at the start
  of a heading.

A reference that does not resolve fails `docs:check`, and the failure names the file, the line and
the missing section.

The check does not read:

- **records.** A page is a record when it carries the `<!-- doc-class: record -->` marker on its own
  line near its top, the rule `tests/lint/current-control-claims.test.ts` reads. It is also a
  record when it lies under the envelope's `docs/features/`, `docs/audits/` or `docs/plans/`, or
  when it is the envelope's `ARCHITECTURE.md`, whose banner declares it one. `repo/docs/features/`
  holds user guides, which are live. A page leaves the check by carrying the marker. That shows in
  its diff, and the same marker already takes a page out of `current-control-claims.test.ts`;
- line anchors;
- fragments on files that are not Markdown;
- same-file anchors, including a link that names its own file by path;
- sections named in free prose. That includes a `§` not directly after its link
  (`[x](t.md) (§9)`, `[x](t.md), §9`) and an identifier with a letter after its digits (`§2a`,
  `§4b.2`);
- a line, or a paragraph joined from shorter lines, over 10,000 characters. It is counted and
  reported in the check's summary line instead;
- a target outside both trees, with symlinks resolved, or one that cannot be read. It is counted as
  unverifiable. With the planning envelope absent, that includes every reference into it, as paths
  already were.

The anchor rule is GitHub's, re-implemented, and some rare shapes are read differently. None
affected a reference on 2026-10-20: every live reference resolves the same way against a CommonMark
parser. Several of the shapes do occur in the tree:

- a fence opened inside a list item hides every later heading in its file;
- an anchor written `<A NAME=x>`, without quotes, or split across lines is not seen;
- a heading inside a list item, or after a byte-order mark, is not seen;
- any `:word:` is read as an emoji shortcode;
- a link inside an HTML comment, after a backslash or in an image is read, as the path check reads
  it;
- an `id=` inside inline code or a comment counts as an anchor;
- a heading inside an HTML comment is read as a heading;
- YAML front matter between `---` lines is read as a setext heading, where GitHub shows a table;
- a named entity other than `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;` and `&nbsp;` is left as
  written, so `&mdash;` keeps its letters in the anchor;
- a fragment that differs from its heading only in case is refused, with its own reason.

## Measurement

The sweep was taken at workspace commit `638714b` and `repo/` commit `bfd2b65b`. It covered the 481
tracked Markdown files that `docs:check` reads. The sweep is committed with feature 219 as
`specs/219-prose-hops-resolve/measure/section-refs-sweep.mjs`, and its report is
`specs/219-prose-hops-resolve/sweep.md`. These are the figures on that date, corrected:

| References naming a section, heading, label or phrase in another file | Found | Do not resolve |
|---|---|---|
| Mechanical, in live documents: **the number the rule reads** | 39 | **10** |
| Prose, in live documents | 56 | 2 |
| In dated records | 404 | 24 |
| **All** | **499** | **36** |

A link that names its own file by path counts as same-file, as a bare `#fragment` does. Review moved
the one such link, which resolves, out of the table.

The sweep's records were the specification's: `specs/`, `docs/features/`, `docs/audits/` and
`docs/plans/` in both trees, and three pages named. The check reads records by the rule under
"Decision", which review aligned with the tree's own marker. On the same rows that rule gives the
same ten live failures. The one reference under `repo/docs/features/` resolves, and the three
marker-bearing pages the sweep did not name hold no link fragment or `§` marker the check reads.

The ten live mechanical failures named four distinct targets. Each was repointed at a heading its
target has before the check landed, and no target gained a heading:

- six checklist links in `.github/PULL_REQUEST_TEMPLATE.md` named a "Hard rules when changing host
  code" heading in the envelope's `CLAUDE.md`. That file had become a pointer. The heading had moved
  to `AGENTS.md`, also a pointer, and to `docs/hard-rules.md`, which holds the rules. The links now
  name `docs/hard-rules.md`;
- two links in `webview-ui/README.md` named a `#model-catalog` heading that
  `docs/operations/process-yaml.md` had folded into its general import procedure. They now name
  "Inspect an import" and "Confirm the plan";
- `docs/development/gate-integrity-measurements.md` named a `RELEASE.md` section, "what was
  withdrawn", that `RELEASE.md` never had. It now cites §5, "What a release no longer does";
- the envelope README cited a filing's §7, wrapped onto the line after the link. The filing's
  headings stop at 6, and "§7" is a finding inside its section 2. The sentence says what the filing
  asks for, so it now links section 3, the deliverable.

The two live prose failures were in the envelope. Its `CONTRIBUTING.md` sent readers to a
"Verification" section of its README that did not exist. A product requirements draft named a
`Dashboard.svelte` that did not exist. Both are outside the check, and both were handed to the
operator, together with one broken same-file anchor in `RELEASE.md`. The report lists every failure,
records included, by file and line at those commits. A failure inside a record is listed and left
as written.

## Reason

1. **The count meets the bar fixed before it was taken.** Ten live mechanical failures meets ten,
   so the rule says build. It is applied as written, in this direction as it would have been in the
   other.
2. **These failures are invisible to a path check, whatever caused them.** Two followed a
   reorganisation: a section that left with the rules it held, and a section folded into another.
   Two never matched: a section that never existed, and a section cited by a number it does not
   have. None was a typo. Each sentence still pointed at the file it meant, so the path check
   passed all four.
3. **The old reason for stripping fragments covered line anchors only.** `#L42` moves with every
   edit, so a check on it would be noise. A heading anchor goes stale when its heading is renamed,
   moved or removed, which is rarer than a line moving. When it does, the sentence naming it is
   stale too, so a failure is a defect worth repairing, not noise. The ten repairs above are what
   that looks like.
4. **What the check leaves out is left out on purpose, and the cost is stated.**
   - **Prose** would need a heuristic. The README hop that raised this question was prose, so the
     check would not have caught that one. It catches the mechanical ones, and those were the ten.
   - **Dated records** describe their date.
   - **Same-file anchors** were outside the measured class.
   - **Filings** number their deliverables as list items, and other pages cite those items as
     `§3.4`, meaning item 4 under heading 3. A heading-only rule cannot read that convention. The
     check exempts records, where five such citations sit. A live document that needs one should
     link the heading that holds the item, as the README now does.

## Revisit condition

Reopen this decision when any of these is observed:

1. **A false refusal.** The check refuses a reference that a reader can follow, and the only fix
   would be to rewrite correct prose. Then the `§` rule should learn the positional convention
   above, or be narrowed.
2. **A broken same-file anchor in a live document, other than `RELEASE.md`'s.** Same-file anchors
   were outside the measured class. On 2026-10-20 one was broken, in `RELEASE.md`, and it was handed
   to the operator. Another shows the class recurs, and the check should read same-file anchors
   too.
3. **A convention for prose.** The tree adopts a form a check can read for references now written
   in prose, for example every section reference written as a fragment link. That moves references
   into the checked forms.

People observe conditions 1 and 3: a reader meets the refusal, or a change adopts the convention. A
sweep observes condition 2. To re-measure, run the sweep from the planning envelope's root, where it
lives: `node specs/219-prose-hops-resolve/measure/section-refs-sweep.mjs --out <new file>`. It reads
both repositories at their `HEAD` by default, or at the commits passed with `--ws` and `--repo`.
For condition 2, read `counts.sameFile.unresolved` and the `sameFile` rows it counts: an unresolved
row in a live document, other than `RELEASE.md`'s, meets it. The sweep tiers pages by the
specification's rule, which differs from the check's on five pages: `repo/docs/features/`'s two
guides and the three release records that carry the marker. Judge a row on those pages by the
check's rule under "Decision". With that, the run's `counts.liveMechanicalUnresolved` should be
zero, as `docs:check` holds it.
