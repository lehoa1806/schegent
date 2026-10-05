# Gate recording

**Declared**: 2026-10-02 · **Items**: `FR-R3-178` (T1827 – T1831), `FR-R3-180` (T1846) ·
**Owner**: the operator holding the checkout · **Spec**: `specs/217-evidence-posture-and-bounds`

`npm run gate:record` runs the full gate once, watches its exit code, and writes what it saw to
`.gate-attestation.json` at the root of this repository: the commit it ran at, whether the tree was
clean, the exit code, the platform and Node version, and when the run started and when it was
recorded. It is the record [RELEASE.md](../../RELEASE.md) §2a binds a release to. This page says what
a record is, what else the project uses one for, and when one is taken.

<!-- Source: scripts/record-gate-run.mjs -->
<!-- Source: scripts/gate-recorder.mjs -->
<!-- Source: scripts/gate-attestation.mjs -->

## What a record is, and what it is not

- **One file, replaced by the next recording.** Git ignores the file and it is never committed, so it
  describes the checkout it sits in and nothing else. There is no history of records: recording
  anywhere replaces the record that was there.
- **Local.** This machine wrote it, about a run on this machine. Nothing on GitHub reads it, and
  `npm run release:preflight` says as much when it accepts one: *"This is a LOCAL record on this
  machine, not independent verification."*
- **It refuses rather than guesses.** With uncommitted changes in the tree it refuses before it
  starts: exit 2, no gate spawned, nothing written. It refuses again, exit 2, if the tree changed
  while the gate ran. A red gate is not a refusal. It is recorded as a failure, exit 1, because an
  honest record of a red tree is worth more than no record.
- **It cannot see what is installed.** It names the commit and what `git status` reports, and git
  ignores `node_modules` in both trees. The gate installs nothing either. A gate run over packages
  installed from an earlier lockfile is therefore recorded as a PASS at a commit whose own
  dependencies it never ran. Installing the committed tree before recording, as step 3 of the bot
  rule's procedure below does, is what ties the record to the commit, and nothing checks that it was
  done.

## Bot-proposed dependency changes: bind the merge — 2026-10-02

Feature 217 (`FR-R3-178`; FR-029 – FR-036, T1827 – T1831), in the four-field shape. **Recorded here
rather than on the [merge-gate observation](merge-gate-observation.md) page**, which is a withdrawn
record whose procedures are inert. A rule that governs merges today belongs beside the mechanism it
uses.

**The rule, in one sentence.** A bot-proposed dependency change is merged into `develop` only from a
commit that carries a passing `npm run gate:record` record naming that commit; nothing on GitHub
checks it, so the rule holds only as far as the operator follows it.

**Decision.** Bind the merge, the filing's option B. The bot keeps proposing as configured in
`.github/dependabot.yml`. It is neither paused (option A) nor narrowed (option C). What changes is the
path into `develop`. For this rule, *the proposal's head* is the head of the branch being merged,
which is the commit that applies the bump. A root proposal that moves a range the pin holds cannot
pass the gate at the bot's own head; the last measurement below says which proposals the pin passes.
The procedure applies each all the same, with the other accepted proposals, as one commit on a branch
from `develop`, rather than merging the bot's branch.

**Measurement.** Taken 2026-10-01 and re-checked 2026-10-02
([measurements §5](../../../specs/217-evidence-posture-and-bounds/measurements.md)):

- **Coverage.** Two `npm` ecosystems, the root and `webview-ui`. Each runs weekly on Monday, with at
  most ten open proposals, minor and patch updates only, grouped by toolchain. `.github/` holds no
  workflow definitions.
- **Open.** Three proposals, all in the root ecosystem and all dated 2026-08-31:
  - `09ce4c4f`: `@secretlint/node` ^13.0.4 → ^13.0.5
  - `68eaeb76`: `typescript-eslint` ^8.67.0 → ^8.68.0
  - `43667249`: `@types/vscode` 1.107.0 → 1.134.0

  All three were cut from `e630346f`, and `develop` at `ffd191d4` is 102 commits past it.
- **Merged as written: none.** No bot commit is reachable from `develop`. Proposals reach the tree
  through a person instead. `b6993e80` (2026-08-24) evaluated fourteen open proposals, applied
  twelve upgrades from them as one commit, and rejected three as downgrades. A proposal can carry
  more than one upgrade, because the bot groups by toolchain.
- **Reach.** Every proposal is a `devDependency`, and that settles nothing. Neither manifest declares
  a runtime dependency, so everything the extension ships is built from dev-declared packages. For
  example, `webview-ui` imports the `svelte` runtime, `vite` bundles it into `dist/webview/`, and the
  VSIX ships that directory. The batch above moved `svelte`.
- **Cost.** The last recording of the full gate before this decision took 342.8 s, about six
  minutes. It was a PASS at `49319218`, a `develop` merge, on 2026-08-28 (darwin/arm64, Node
  24.19.0).
- **The gate already fails most root proposals that move a declared range.**
  `tests/lint/dependency-change-scope.test.ts` pins the declared range of 18 of the 21 root
  `devDependencies`, and the gate runs it. Each of the three open proposals moves one of those 18,
  so the pin fails at each of their heads, and the gate fails with it. The pin's own message says an
  intended bump is "its OWN change with its own verification". That is the change this rule records.
  The other three, `axe-core`, `secretlint` and `@secretlint/secretlint-rule-preset-recommend`, are
  not pinned. The pin reads declared ranges, not the lockfile, and the same file holds the declared
  versions of the last two to the versions the lockfile resolves. So a proposal that moves
  `axe-core`, or moves either of the last two with its lockfile entry, passes; one that moves either
  one's lockfile entry alone fails; and one that rewrites only `package-lock.json` for anything
  else, such as an update to a transitive dependency, passes.

**Reason.** Pausing the bot would forfeit an update path that is in use. The one batch drew twelve
upgrades from these proposals, and one of them changed code inside the package.

Binding needs no new machinery. The recorder exists, `release:preflight` already refuses on its
record, and the recorder has recorded a PASS on this tree before.

The filing warned that a gate run per proposal, at minutes per run, is a policy that gets skipped and
then cited as protection. This rule asks for one run per batch, because a batch is one commit. That is
about six minutes a week on the configured schedule, and it is the shape the one batch already had.

Finally, the pin fails a root proposal that moves a range it holds at its own head. For such a
proposal, the commit that applies the bump and moves the pin is the only commit the gate can pass at,
so binding it adds a record, not a step. For a proposal the pin passes, the recorded gate run is the
only check there is.

**Revisit condition.** Reopen this decision if any of the following is observed. The answer is then to
pause the bot, not to write a stronger sentence.

1. A bot-proposed change is found on `develop` whose merge message carries no `Gate-record:` line for
   the commit it merged. The rule was skipped, and the filing said that outcome makes pausing the right
   answer.
2. A recorded full gate takes longer than fifteen minutes, more than two and a half times the 342.8 s
   above. At that point one run per batch stops being something an operator does in one sitting.
3. A verification point that does not depend on this machine exists again. That would be a decision of
   its own, reopening `FR-R3-099`. This decision does not make it, and the rule would then belong
   there.

### How to perform it

1. **Read the proposals against `develop`, not against the base they were cut from.** A proposal cut
   before `develop` moved can move a dependency backwards; `b6993e80` rejected three for that reason.
   `git fetch origin` refreshes the proposals, and `git branch -r` lists them under
   `origin/dependabot/`.
2. **Apply the accepted proposals as one commit**, on a branch from `develop`. The commit holds three
   things:
   - the version bump, in the manifest it belongs to;
   - the lockfile that bump rewrites;
   - for a root bump of a range the pin holds, the moved entry in `PINNED` in
     `tests/lint/dependency-change-scope.test.ts`.

   Use the `chore(deps-dev)` prefix the bot uses, so the change reads as what it is.
3. **Install the tree that commit declares, then record the gate at it.** Run the install sequence
   [CONTRIBUTING.md](../../CONTRIBUTING.md) gives, `npm ci` and then `npm --prefix webview-ui ci`, so
   the gate runs the versions the commit's lockfiles name rather than whatever was installed before
   the bump. When `git status --porcelain` prints nothing, run `npm run gate:record` in the
   foreground and wait for it. The exit code says what happened:
   - **Exit 0**, with `record-gate-run: recorded a PASS at <commit>`, is the record this rule asks
     for.
   - **Exit 1** means it recorded a failure. Do not merge: fix the problem on the branch, commit, and
     record again.
   - **Exit 2** means it refused and wrote nothing, because the tree was dirty before the run or
     changed during it.
4. **Merge that commit with `git merge --no-ff`.** End the merge message with
   `Gate-record: PASS at <commit>`, copying the commit from the recorder's line. The record names the
   branch head, which is the merge's second parent. Copy only the commit: the recorder's line also
   carries this machine's absolute path to the record, and that does not belong in history. The record
   file is replaced at the next recording, so this line is the only trace that outlives it.
   `git log --merges --grep='^Gate-record: PASS at ' develop` lists every merge that says it followed
   the rule.

### What it does not do

- **It is not enforced.** Merging a proposal in GitHub's interface bypasses it. Nothing in this
  repository runs a check on a proposal where it is opened: `.github/` has held no workflow
  definitions since `FR-R3-099` retired them by decision on 2026-08-26.
- **It covers the branch head, not the merge.** If `develop` moved after the branch was cut, the merge
  commit's tree was never gated. `npm run release:preflight` demands a record at the release commit
  itself, and that covers the combination at a release. Before then, only a recording after the merge
  covers it.
- **It replaces the previous record.** Recording on a proposal branch replaces whatever record
  `develop` had, so a release still needs a fresh recording at its own commit.
- **It does not judge the version.** Over the install step 3 makes, a passing gate says the tree
  builds and passes its own checks with the new version. It does not say the new version is
  trustworthy. The dependency audit is
  `npm run security:audit`; an operator invokes it, and the gate does not contain it.
- **The pin covers 18 of the root manifest's 21 ranges.** It does not stop a `webview-ui` proposal,
  or a root one that moves one of the three ranges it leaves out, but the rule applies to each all the
  same.
- **No proposal has been merged under it yet.** The one batch, `b6993e80`, predates the recorder
  (2026-08-26). Its verification is what its commit message describes, not a record.

### Shown performable, 2026-10-02

The refusal path was run on this checkout at 2026-10-02T00:20:23Z, with 56 uncommitted changes in the
tree. `npm run gate:record` exited 2 and printed
`record-gate-run: the working tree has uncommitted changes.`. It started no gate, and it left
`.gate-attestation.json` byte-identical to a copy taken just before (`cmp` printed nothing).

The pass path was the record then on this machine, a PASS at `49319218` from 2026-08-28. Feature 217
recorded the gate again at the commit it produced (T1845): a PASS at `70a34b4d`, recorded at
2026-10-02T04:02:02Z after 365 s, and `npm run gate:distance` then read 0 commits behind.

<!-- Source: .github/dependabot.yml -->
<!-- Source: tests/lint/dependency-change-scope.test.ts -->
<!-- Source: scripts/require-local-gate.mjs -->

## Recording cadence: at every merge into `develop`, not on push — 2026-10-02

Feature 217 (`FR-R3-180`; FR-015, T1846), in the four-field shape. Recorded here rather than on the
[merge-gate observation](merge-gate-observation.md) page, for the reason the bot rule above gives:
that page is a withdrawn record. The bot rule is this rule applied to one kind of branch, and the two
share the merge line.

**The rule, in one sentence.** Every change reaches `develop` as a `git merge --no-ff` of a commit
that carries a passing `npm run gate:record` record naming that commit, and the merge message ends
`Gate-record: PASS at <commit>`; nothing checks it, so it holds only as far as the operator follows
it.

**Decision.** Manual, at a stated point: the merge into `develop`. Of the three cadences the filing
offered, this is the manual one, with a merge as its interval rather than a period of time. Recording
is not automated on push. It is not left to the release either, though a release still records at
its own commit, as [RELEASE.md](../../RELEASE.md) §2a requires.

**Measurement.** Taken 2026-10-02 on this checkout
([measurements §4](../../../specs/217-evidence-posture-and-bounds/measurements.md)):

- **Duration: 384 s.** The full gate at `70a34b4d` (T1843) exited 0 after 384 s of wall clock,
  03:02:12Z to 03:08:36Z. Recording the same commit (T1845) took 365 s from `startedAt` to
  `recordedAt`. A gate recorded on push would add six to six and a half minutes to every push.
- **Release only.** Until T1845 the record on this checkout was the PASS at `49319218` from
  2026-08-28. By 2026-10-01 `develop` was 144 commits past it, and no recording had completed here in
  between, because each one replaces the file. On `develop`'s own first-parent line those commits
  arrived as 74 changes: 48 merges and 26 commits made on `develop` directly.
- **Pushes.** `develop` was pushed from this checkout 12 times between 2026-08-24 and 2026-09-14,
  and not since. A push carried between 0 and 76 merges; the one on 2026-08-31 carried 50. The merge
  `ffd191d4` of 2026-09-17 has never been pushed.
- **Merges.** First-parent merges into `develop`, by ISO week: 81 in the week from 2026-08-24, 35 in
  the week from 08-31, 5 from 09-07 and 3 from 09-14. Nothing has landed on `develop` since
  2026-09-17.
- **Hooks.** This repository has none. `core.hooksPath` is unset, and `.git/hooks` holds only the
  samples git installs. A push hook would be new machinery, installed separately in every clone.
- **The tree is often dirty.** The refusal run above found 56 uncommitted changes, and both of
  feature 217's runs had to set uncommitted changes aside before they could start.

**Reason.** A push is the wrong point to record. A change enters `develop` when it is merged or
committed there, and a push carries whatever has piled up since the last one: up to 76 merges at the
measured rate, and nothing at all since 2026-09-14. A recording at push time would also often meet a
dirty tree, so it would refuse the push or skip the record. And a hook that holds a push for six
minutes is the hook that gets `--no-verify`'d, as the filing warned.

Release only is what produced the 144 commits behind. A period of time would not have bounded the
distance either, because one week held 81 merges.

At a merge, recording adds a file, not a run. [CONTRIBUTING.md](../../CONTRIBUTING.md) already asks
for the gate before a change goes to `develop` (*"run `npm run gate` before you open a pull
request"*), and `npm run gate:record` is that run with its result written down. That holds only as far
as the existing rule is followed. Following it costs at least 81 × 384 s, about 8.6 hours of gate, in
a week like the one from 2026-08-24, and about 19 minutes in a week like the one from 2026-09-14. This
rule makes that cost visible. It does not add to it.

The rule names merges because a merge message can name a record in history: the commit it names
exists before the merge does. A commit made on `develop` directly cannot name its own record, so
under this rule every change goes through a branch. Between merges, `npm run gate:distance` reports
the distance without running anything.

**Revisit condition.** Reopen this decision if any of the following is observed.

1. The listing below prints a change made after 2026-10-02: a merge without the line, or a commit
   made on `develop` directly. The rule was skipped, and the answer is a check that reads the record
   and refuses the merge, not a check that runs the gate.
2. A recorded gate takes longer than fifteen minutes, about 2.3 times the 384 s above. A run per merge
   then stops being something an operator waits out at the merge.
3. Changes reach `develop` somewhere no recording can be taken, such as a pull request merged on
   GitHub, or a verification point that does not depend on this machine exists again. The second
   would reopen `FR-R3-099`, and the cadence would then belong there.

### How to perform it

Steps 3 and 4 of the bot rule's procedure above, for any branch. Install the tree the branch head
declares, and when `git status --porcelain` prints nothing, run `npm run gate:record` at the branch
head, merge that commit with `git merge --no-ff`, and end the merge message with
`Gate-record: PASS at <commit>`. To list every change to `develop` since
this decision whose message carries no such line:

```bash
git log --first-parent --since=2026-10-02T00:00:00 --invert-grep \
  --grep='^Gate-record: PASS at ' --format='%h %cs %s' develop
```

It lists both kinds of skipped change: a merge that did not carry the line, and a commit made on
`develop` directly.

### What it does not do

- **It is not enforced.** Nothing refuses a merge without the line. The listing finds one afterwards.
- **It names the branch head, not the merge.** Right after the merge, `npm run gate:distance` reads 1
  commit behind: the merge commit itself. If `develop` had not moved since the branch was cut, the
  merge commit's tree is the branch head's, so the record covers it. If it had moved, the distance
  reads more than 1 and the combination was never gated, as the bot rule says above.
- **It keeps one record per checkout.** A recording on a branch replaces the record `develop` had
  here.
- **It does not replace the release recording.** `npm run release:preflight` refuses a record that
  names another commit (`wrong-commit`), so a release cut after the merge records again at its own
  commit.

<!-- Source: scripts/gate-distance.mjs -->
<!-- Source: CONTRIBUTING.md -->
