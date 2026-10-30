# Dependency advisory comparison

**Declared**: 2026-10-30 · **Item**: `FR-R4-F21` · **Owner**: the operator running the command ·
**Spec**: `specs/249-dependency-advisory-baselines`

`npm run security:advisory-diff` tells you whether a candidate commit introduced or worsened a
dependency advisory, as against an explicit base commit. `npm run security:audit` answers a different
question, whether the tree has any advisory at all, and it is unchanged. This page says what the
comparison reports, how to take one, and what it will and will not tell you.

<!-- Source: scripts/advisory-diff.mjs -->
<!-- Source: package.json -->

## What it answers

A candidate with advisories is not necessarily a candidate that made things worse. The comparison
sorts every advisory finding of a candidate against the same tree at a base commit, so a reviewer can
see which findings the candidate introduced, which it worsened, and which were already there. It is
**report-only**: it shows a difference and decides nothing about it.

## What it does not do

- It changes no audit, threshold, lockfile or disposition.
- It is not part of `npm run gate`, `npm run ci`, any `verify:*` tier, `npm run release` or
  `npm run package`, and no Phase or pipeline runs it. `tests/lint/advisory-diff-is-report-only.test.ts`
  keeps it that way.
- It grants no waiver. A candidate whose checks are red is no more mergeable because a comparison
  found nothing new, and an advisory that `npm run security:audit` reports is still reported by it.
- Its exit code is not a verdict. See [Exit codes](#exit-codes).

## The three steps

Run each from `repo/`. The first prints the base, the second audits one tree at one commit, and the
third compares. Both trees, `root` and `webview-ui`, are always compared, and no flag narrows that.

```sh
OUT=$(mktemp -d)
CAND=$(git rev-parse HEAD)
BASE=$(node scripts/advisory-diff.mjs base --candidate "$CAND")
for T in root webview-ui; do
  node scripts/advisory-diff.mjs capture --tree "$T" --commit "$BASE" --out "$OUT/base-$T.json"
  node scripts/advisory-diff.mjs capture --tree "$T" --commit "$CAND" --out "$OUT/cand-$T.json"
done
node scripts/advisory-diff.mjs compare --candidate "$CAND" \
  --base-capture root="$OUT/base-root.json" --base-capture webview-ui="$OUT/base-webview-ui.json" \
  --candidate-capture root="$OUT/cand-root.json" --candidate-capture webview-ui="$OUT/cand-webview-ui.json" \
  --out "$OUT/record.json"
```

- **`base`** prints the selected base commit. It contacts nothing.
- **`capture`** is the only step that contacts the npm registry, through `npm`. It reads the tree's
  manifest and lockfile from the commit, never from the working tree, audits them in a temporary
  directory, and writes a capture. It runs the audit so that it reaches the registry and covers every
  dependency type whatever the local npm configuration: npm writes a valid but empty report when
  offline mode is set, and skips development dependencies when they are omitted, and either would
  otherwise read as a capture with no findings. It exits 0 whatever the audit did.
- **`compare`** reads the captures and the two lockfiles at the two commits, prints the report, and
  writes a record when `--out` is named. It contacts nothing and starts no `npm`.

Leaving out a capture is allowed. It is reported as a reason the result is incomplete, not refused.

<!-- Source: scripts/advisory-capture.mjs -->
<!-- Source: scripts/advisory-model.mjs -->

## Base selection

By default the base is the single merge-base of the candidate and the local branch `develop`.
`--target <branch>` names another local branch, and `--base <rev>` names a commit directly; the two
cannot be given together. There is no fallback. If the target branch does not exist, the histories
share no commit, there are several merge-bases, or `--base` does not resolve, no base is selected and
the result is incomplete with the reason `base-not-selected`. Nothing is guessed, and no
remote-tracking branch is tried.

<!-- Source: scripts/advisory-compare.mjs -->

## The five classes

Each finding lands in exactly one class, by the first rule that fits.

| Class | Meaning |
|---|---|
| **Introduced** | The advisory appears only on the candidate. When some of its package versions and locations were already in the base lockfile, the report names those and says it was likely disclosed between the two captures |
| **Worsened** | It appears on both sides, and on the candidate it has a higher known severity, a location the base did not have, newly direct use, or newly production use. Each cause is named |
| **Uncertain** | The difference cannot be put down to the candidate: the advisory appears only on the candidate yet every one of its installed versions and locations was already in the base lockfile, or appears only on the base yet one of its versions is still installed on the candidate, or its severity changed while its versions and locations are identical. These are changes in the advisory database, not in the code |
| **Pre-existing** | It appears on both sides without getting worse. Always listed, never collapsed |
| **Resolved** | It appears only on the base, and none of its versions remains installed on the candidate |

A sixth label, **not determined**, is used only when a tree is incomplete: the findings that could be
read are listed under it, and none is called introduced.

A matching advisory identifier never by itself makes a finding pre-existing. Two findings are the same
advisory when their identifiers intersect, and an alias such as the registry's numeric id counts.

<!-- Source: scripts/advisory-compare.mjs -->

## Completeness

A comparison is complete only when, for both trees, a base was selected and both captures were
supplied, can be read, describe the commit and files they claim to, succeeded, are comparable, fresh
and paired. Otherwise it is incomplete, names every reason with its tree, and states its introduced
and worsened counts as **not determined**, never as zero. A tree that is itself complete keeps its own
counts, stated for that tree only. The thirteen reasons:

| Reason | Raised when |
|---|---|
| `base-not-selected` | No base commit was selected (see Base selection) |
| `missing-baseline` | No base capture was supplied for the tree |
| `missing-candidate` | No candidate capture was supplied for the tree |
| `tree-missing` | The manifest or lockfile is absent at that side's commit |
| `mismatch` | The capture's tree, commit, manifest or lockfile is not the one that side names |
| `missing-provenance` | The capture does not record where its advisory data came from |
| `malformed` | The capture is not JSON of the capture's shape |
| `unsupported-format` | The capture or the audit report is in a format this comparison does not read |
| `over-bound` | An input is over its size bound and was not read |
| `audit-failure` | The audit did not produce a report (offline, a registry error, a timeout) |
| `not-comparable` | The two captures used different tools, tool major versions or registries |
| `observation-skew` | The two captures were observed more than 60 minutes apart |
| `stale` | A capture is older than 24 hours, or was observed after the evaluation time |

<!-- Source: scripts/advisory-compare.mjs -->

## Budgets

The two captures of a tree must be at most 60 minutes apart, and each capture at most 24 hours old
at the evaluation time (`--at`, default now). Both are development defaults. The release budget is
owned by `FR-R4-009`, and neither is a flag.

## Dispositions

`--dispositions <path>` names a list of recorded decisions about advisories. It is read only, never
written, and its format is version 1 of the narrow contract this feature asks the dispositions owner
to adopt: advisory id, ecosystem, package, tree, range, status, owner, decision date and expiry date.
Each finding shows one verdict and every related entry:

- **covers**: an entry names the finding, for this tree, with a range covering every installed version
  and an expiry still ahead. An expiry date ends at 00:00:00Z on that day.
- **expired**, **does-not-cover**: an entry names the finding but has expired, or names the other tree
  or a range that leaves an installed version out. These are never shown as approved.
- **not-recorded**: no list was named, or none of its entries relates to the finding.
- **unknown**: a list was named but cannot be used (missing, unreadable, over 8 MiB or 10,000
  entries, malformed, or another version). The report says why.

A disposition never changes a class, a count or whether the comparison is complete. `accepted` is a
label, not a waiver.

<!-- Source: scripts/advisory-dispositions.mjs -->

## Outputs

`--out` is opened before any other work, with exclusive create and owner-only mode, and is refused,
with nothing written and no report printed, when the path exists, is a symbolic link, has no parent
directory, or lies under a `.schegent` directory. The tool never retains, rotates or deletes an
earlier output. A capture holds the commit, the manifest and lockfile blob ids, the tool and its
version, the registry host name, the time of observation, the exact command, and its findings. A
record holds each capture's subject and provenance, never its findings, and the comparison's result.
Neither holds an absolute path, an environment value, npm's standard error, or anything an npm error
carried beyond its status code. Titles and names printed in the report are escaped, so a control
character in one cannot reach the terminal.

<!-- Source: scripts/advisory-report.mjs -->

## Exit codes

- `0`: the command wrote its output. For `compare` that holds whatever the classes, counts or
  completeness are, and for `capture` whatever the audit did. **Zero is not a verdict.**
- `1`: the output could not be opened or written, or, for `base` only, no base was selected.
- `2`: a bad invocation.

## Limitations

- A blob id identifies content and authenticates nothing. A capture is an unsigned file, and anyone
  who can forge its blob ids can forge its findings.
- A comparison does not establish present exploitability or the registry's current advisory counts.
- `npm` may write to its own cache in your home directory while a capture runs. Nothing in the
  repository is written.
- Only npm's version-2 audit report, and lockfile versions 2 and 3, are supported.
