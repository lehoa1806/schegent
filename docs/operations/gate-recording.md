# Gate recording

**Declared**: 2026-10-02 · **Item**: `FR-R3-178` (T1827 – T1831) · **Owner**: the operator holding
the checkout · **Spec**: `specs/217-evidence-posture-and-bounds`

`npm run gate:record` runs the full gate once, watches its exit code, and writes what it saw to
`.gate-attestation.json` at the root of this repository: the commit it ran at, whether the tree was
clean, the exit code, the platform and Node version, and when the run started and when it was
recorded. It is the record [RELEASE.md](../../RELEASE.md) §2a binds a release to. This page says what
a record is, and what else the project uses one for.

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
which is the commit that applies the bump. The bot's own head cannot pass the gate (see the last
measurement below), so it is never the commit merged.

**Measurement.** Taken 2026-10-01 and re-checked 2026-10-02
([measurements §5](../../../specs/217-evidence-posture-and-bounds/measurements.md)):

- **Coverage.** Two `npm` ecosystems, the root and `webview-ui`. Each runs weekly on Monday, with at
  most ten open proposals, minor and patch updates only, grouped by toolchain. `.github/` holds no
  workflow definitions.
- **Open.** Three proposals, all in the root ecosystem and all dated 2026-08-31:
  - `09ce4c4f`: `@secretlint/node` ^13.0.4 → ^13.0.5
  - `68eaeb76`: `typescript-eslint` ^8.67.0 → ^8.68.0
  - `43667249`: `@types/vscode` 1.107.0 → 1.134.0

  All three were cut from `e630346f`, and `develop` is now 102 commits past it.
- **Merged as written: none.** No bot commit is reachable from `develop`. Proposals reach the tree
  through a person instead. `b6993e80` (2026-08-24) evaluated fourteen open proposals, applied twelve
  of them as one commit, and rejected three as downgrades.
- **Reach.** Every proposal is a `devDependency`, and that settles nothing. Neither manifest declares
  a runtime dependency, so everything the extension ships is built from dev-declared packages. For
  example, `webview-ui` imports the `svelte` runtime, `vite` bundles it into `dist/webview/`, and the
  VSIX ships that directory. The batch above moved `svelte`.
- **Cost.** The last recording of the full gate took 342.8 s, about six minutes. It was a PASS at
  `49319218`, a `develop` merge, on 2026-08-28 (darwin/arm64, Node 24.19.0).
- **The gate already fails a root proposal as written.** `tests/lint/dependency-change-scope.test.ts`
  pins the declared range of every root `devDependency`, and the gate runs it. Each of the three open
  proposals moves one of those ranges, so the pin fails at each of their heads, and the gate fails
  with it. The pin's own message says an intended bump is "its OWN change with its own verification".
  That is the change this rule records.

**Reason.** Pausing the bot would forfeit an update path that is in use. The one batch drew twelve
upgrades from these proposals, and one of them changed code inside the package.

Binding needs no new machinery. The recorder exists, `release:preflight` already refuses on its
record, and the recorder has recorded a PASS on this tree before.

The filing warned that a gate run per proposal, at minutes per run, is a policy that gets skipped and
then cited as protection. This rule asks for one run per batch, because a batch is one commit. That is
about six minutes a week on the configured schedule, and it is the shape the one batch already had.

Finally, the pin fails every root proposal at its own head. The commit that applies the bump and moves
the pin is therefore the only commit the gate can pass at, so binding it adds a record, not a step.

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
   - for a root bump, the moved entry in `PINNED` in `tests/lint/dependency-change-scope.test.ts`.

   Use the `chore(deps-dev)` prefix the bot uses, so the change reads as what it is.
3. **Record the gate at that commit.** When `git status --porcelain` prints nothing, run
   `npm run gate:record` in the foreground and wait for it. The exit code says what happened:
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
- **It does not judge the version.** A passing gate says the tree builds and passes its own checks with
  the new version. It does not say the new version is trustworthy. The dependency audit is
  `npm run security:audit`; an operator invokes it, and the gate does not contain it.
- **The pin covers the root manifest only.** It does not stop a `webview-ui` proposal, but the rule
  applies to one all the same.
- **No proposal has been merged under it yet.** The one batch, `b6993e80`, predates the recorder
  (2026-08-26). Its verification is what its commit message describes, not a record.

### Shown performable, 2026-10-02

The refusal path was run on this checkout at 2026-10-02T00:20:23Z, with 56 uncommitted changes in the
tree. `npm run gate:record` exited 2 and printed
`record-gate-run: the working tree has uncommitted changes.`. It started no gate, and it left
`.gate-attestation.json` byte-identical to a copy taken just before (`cmp` printed nothing).

The pass path is the record already on this machine: a PASS at `49319218`, on 2026-08-28. Feature 217
records it again at the commit it produces (T1845).

<!-- Source: .github/dependabot.yml -->
<!-- Source: tests/lint/dependency-change-scope.test.ts -->
<!-- Source: scripts/require-local-gate.mjs -->
