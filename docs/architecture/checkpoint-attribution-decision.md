# Decision: how a recovery checkpoint is attributed to one Run

Status: Accepted (2026-08-18)

Revised the same day. The first draft chose a purely observational mechanism and
argued that option 2 had no declaration surface to derive from; both were wrong.
The declaration surface is the audit record's file lists, and observation alone
cannot attribute under overlapping phase windows. What replaced it is option 2
with the check that closes its stated heuristic — see *Why option 2* below, which
keeps the falsified shape on the record rather than deleting it.

Closes the residual half of review finding **REL-02** of
[principal-architecture-review-2026-08-18.md](../operations/principal-architecture-review-2026-08-18.md);
the default-cap half shipped in feature 098.

Implements FR-R3-004. It does **not** relax the hard rule it exists to serve —
*never take or offer a recovery checkpoint that cannot be attributed to a single
Run.* It removes the condition that, until now, forced that rule to be satisfied
by declining every checkpoint taken above one in-flight Run.

## The decision in one paragraph

Keep one working tree and scope each Run's patch to the paths that Run's own
audit records name — `files_created`, `files_modified`, `files_deleted`,
collected at every phase dispatch — and **check** that declaration against a
`git diff --binary --no-ext-diff HEAD` of the whole tree read at every window
edge and again at the checkpoint seam. The declaration says who wrote what; the
diff says whether the declarations account for everything actually in the tree.
When both hold and the partition is unambiguous, the checkpoint is a patch
containing exactly that Run's sections; when either fails, the checkpoint
declines with a reason naming which of the four ways it failed. At one in-flight
Run the whole mechanism is bypassed and the patch is the same whole-tree diff it
is today.

## Why not option 1 — per-run isolation

Per-Run isolation makes attribution true by construction, and it is the shape
that would survive every failure mode the chosen one merely detects. It was
rejected on four recorded grounds, in order of decisiveness.

**It is forbidden, and lifting the ban is not this feature's decision to make
cheaply.** `git worktree` is prohibited by project rule (`CLAUDE.md`, the
checkpoint hard rule). FR-R3-004 states the terms explicitly: choosing this
option "requires lifting that ban explicitly in `.specify/memory/constitution.md`,
not silently in an implementation PR." That is a legitimate path, and it stays
open — see *What would make us revisit this* below. It is not a path worth
taking to buy a property the cheaper option delivers for the concurrency levels
this product actually runs at.

**It changes the product model, not just the storage layout.** Schegent drives
the Claude Code CLI over the operator's *open workspace*. The Spec-Driven
Development pipeline writes `specs/<NNN-name>/`, `.specify/`, and `.schegent/`,
all of which live at the workspace root and all of which the operator watches in
their editor while the Run proceeds. Move a Run into a private tree and its work
becomes invisible in the IDE until something merges it back; the merge is a
second problem of exactly the same difficulty as the one this feature is
solving, deferred rather than removed. A `git worktree` also does not carry
untracked files, `.gitignore`d build state, or a populated `node_modules`, so
the first thing a phase in a fresh tree does is fail to find the toolchain it
was configured against.

**Submodules and hooks behave differently in a linked worktree.** `core.hooksPath`
is repository-scoped and shared, so a hook that assumes it runs at the primary
worktree's root sees a different root; `git submodule` support in linked
worktrees is version-dependent and has changed within the supported Git range.
Both are behaviours the product would have to specify and test rather than
inherit.

**Copy-based isolation, the stated fallback, is not affordable here.** Measured
on this repository: 1,479 tracked files, 33 MB `.git`, and a **3.1 GB** working
directory of which 258 MB is `node_modules`. A copy per Run at the default cap
range's ceiling of 20 is not a cost anyone would accept, and a copy that
excludes the untracked tree reproduces the toolchain problem above.

## Why not option 3 — serialize Git-capable phases only

This is the smallest change and it involves no heuristic, which is genuinely
attractive. It was rejected because it contradicts a **shipped, tested success
criterion**.

Feature 093's **SC-013**: *"Concurrency does not serialize: with several Runs
executing, each advances through phases independently, and no Run's phase
advance is observed to wait on another Run's progress, pause, or failure."* A
workspace-wide Git-capable-phase lease is precisely a phase advance waiting on
another Run's progress. It is also, in the built-in pipeline, a lease over the
phases that matter most: of the built-in phase set, `speckit-specify`,
`specify-brainstorm`, `superpowers-implement`, `finalize`, and
`superpowers-review-close` are Git-capable, and `superpowers-implement` is
typically the longest phase in the pipeline. Serializing on it means concurrency
above one buys very little.

The failure mode is worse than the throughput cost. A Run that **pauses** inside
a Git-capable phase keeps its session, its execution lease, and its cap slot;
under option 3 it would also keep the Git-capable-phase lease, and every sibling
Run would stop at its next Git-capable phase until an operator returned. That is
a workspace-wide stall produced by one Run's pause — the exact coupling SC-013
was written to forbid, and the same shape as the deleted drain step 4b.

The existing unit suite already names this reintroduction as the thing it is
guarding against
([`tests/unit/services/run-checkpoint-service.test.ts`](../../tests/unit/services/run-checkpoint-service.test.ts)),
which is why it is rejected here on the record rather than re-argued later.

## Why option 2, and what had to change about it for it to be acceptable

FR-R3-004 states option 2 as "scope the diff to the paths one Run touched,
derived from the run's own audit record", and correctly calls that a
*heuristic*: "a Run that writes outside its declared paths produces an
incomplete patch, and an incomplete patch that presents as a checkpoint is worse
than a decline."

That objection is fatal to the option **as stated**, and closing it is what this
record decides. The declaration surface exists —
`AuditEntryFields.filesCreated` / `filesModified` / `filesDeleted`
([`src/audit/audit-entry.ts`](../../src/audit/audit-entry.ts)), parsed from each
phase's audit record — but it is produced by the CLI and can under-report. Used
alone it is exactly the heuristic the requirement rejects.

**The check is what removes the heuristic.** The declaration says which Run owns
a path; a whole-tree `git diff --binary --no-ext-diff HEAD`, read at every window
edge and again at the checkpoint seam, says whether the declarations account for
the tree. A section present in the tree that no Run declared and that was not
already dirty when this host started is a hole in the declaration, and the answer
is a decline. So an under-reporting record cannot produce a quietly incomplete
patch; it produces a refusal that names the path.

### The shape that was tried first, and why it does not work

The first implementation attributed observationally instead: capture the diff
before and after every phase dispatch, hash each section, and attribute every
section whose hash changed across that window. It needs no declaration at all,
which made it attractive, and it passes every unit test — because a unit test
opens and closes one window at a time.

It fails under real concurrency, and the integration fixture
([`tests/integration/checkpoints/concurrent-attribution.test.ts`](../../tests/integration/checkpoints/concurrent-attribution.test.ts))
is what showed it. Two Runs driving phases at once have windows that overlap
almost entirely: the driver opens Run B's window before Run A's write lands, so
A's write falls inside B's open window and is attributed to both. Every
concurrent section becomes contested, every checkpoint declines
`path-mutated-by-multiple-runs`, and the feature's primary acceptance scenario —
three Runs in flight, each getting its own patch — cannot be satisfied at all.
Narrowing the windows does not help: with two CLI subprocesses genuinely running
at once, the set of Runs whose window is open during any given interval is
almost always ≥ 2. Whole-tree observation can say *that* the tree changed; it
cannot say *who* changed it. That is what the declaration is for.

Three properties of the combined mechanism are worth stating, because each is a
place a simpler version would go wrong:

- **The window is every phase, not every Git-capable phase.** `PhaseSideEffects`
  has four values, and `builtInSideEffects()` marks most built-in phases
  `workspace`, not `git` — those phases mutate the tree too. Collecting
  declarations only at the checkpoint seam would leave every `workspace` phase's
  writes unclaimed, and the completeness check would then decline everything.
- **A phase that produced no audit record is a hole, not an empty declaration.**
  A malformed invocation, a crash, or a cancellation yields no parsed entry, and
  what it wrote is unknown. That marks the Run's evidence incomplete. A phase
  that *did* report and named nothing is different: it reported, and the report
  is checkable against the tree.
- **Untracked files are out of scope on both sides, identically.** `git diff
  HEAD` does not report them, so they are absent from the check and absent from
  the patch — exactly as they are absent from today's whole-tree patch. The
  `git status --porcelain=v1` capture in the metadata JSON still lists them, so
  the record of what existed is unchanged.

**The partition is verified, not assumed.** At checkpoint time the service
re-reads the current diff and requires that *every* section present is either in
the ledger's baseline (dirty before this extension host observed anything —
typically the operator's own uncommitted work) or claimed by exactly one Run. A
section that is neither is unexplained: it may be the checkpointing Run's own
write from a subprocess that outlived its phase, or from a phase whose record
under-reported, in which case the scoped patch would be incomplete. That is the
outcome the requirement says is worse than a decline, so it declines.

### Declared paths are untrusted input

They arrive from CLI stdout, which is operator-influenced — the same property
[`src/controller/phase-sidecar-reader.ts`](../../src/controller/phase-sidecar-reader.ts)
already documents about this surface. Two containments apply, and both are in
`canonicalizeDeclaredPath`:

- A declared path is resolved against the workspace root and dropped unless it
  stays inside it. A record naming `/etc/hosts` or `../../secrets` claims
  nothing.
- Canonicalisation is **lexical only**. No `realpath`, no `lstat`, nothing that
  touches the filesystem. A `realpath` here would be a syscall at an
  attacker-nameable location performed solely to make a string comparison
  succeed — the same reasoning that orders containment before probing in
  `resolveRunOutputs`. A path that does not lexically match a section git already
  printed simply matches nothing, so the section reads as unclaimed and the
  checkpoint declines. Every failure of the match is a refusal, never a
  misattribution.

## The mechanism

At each phase dispatch, `RunDriver.dispatchObserved` opens the Run's window
before the dispatch and closes it — in a `finally`, so a failed or cancelled
phase is not a hole in the record — with that phase's audit record. The close
carries `null` when there is no parsed record, which is how a crash becomes
incomplete evidence rather than a silent empty declaration.

At a Git-capable phase's checkpoint seam:

| Condition | Outcome |
|---|---|
| In-flight Runs ≤ 1 | Whole-tree patch, `attribution.mode: 'sole-run'`. Ledger not consulted. |
| Evidence for this Run, or for any live sibling, is incomplete | Decline, `attribution-evidence-incomplete` |
| A present section is claimed by no Run and is not baseline | Decline, `unattributed-worktree-change` |
| A present section is claimed by this Run **and** a sibling | Decline, `path-mutated-by-multiple-runs` |
| No sibling-claimed section is present | Whole-tree patch, `attribution.mode: 'no-sibling-work-present'` |
| This Run has no present claimed section | Decline, `no-attributable-changes-observed` |
| Otherwise | Patch of this Run's sections only, `attribution.mode: 'scoped'` |

Evidence is *complete* for a Run only when the ledger observed it from its first
phase — `run.phasesCompleted.length === 0` at first observation **and** the Run
started after this ledger was constructed — and every phase since closed its
window with a record it could read. The second clause is what catches a Run
resumed from a previous window: the ledger is in-memory and per-host, so a Run
reloaded mid-pipeline has writes no ledger ever saw, and a fresh ledger must not
mistake its own emptiness for a clean history.

Ownership is decided on the section's **path** while splitting and rejoining is
decided on the header line verbatim. The two jobs are separate on purpose: a
declaration names a path, so ownership has to, but a header git quotes with
C-style escapes cannot be reduced to a plain path reliably. Such a section yields
a path no declaration matches, so it reads as unclaimed and the checkpoint
declines — the failure of the best-effort half is a refusal, never a
misattribution.

A scoped patch is written by concatenating the sections already read, not by a
second `git diff -- <paths>` call. A patch file *is* a concatenation of sections,
so this needs no path re-quoting, no second process, and no risk that a path
which round-trips badly through `git`'s C-style quoting silently drops out of the
patch.

`no-sibling-work-present` deserves its own line because it is what makes the
common case cheap and safe: with three Runs in flight but only one holding
uncommitted work, the whole-tree diff *is* that Run's diff, and it is written in
full rather than reconstructed.

## What it costs

Measured on this repository (1,479 tracked files, 33 MB `.git`, macOS APFS):
`git diff --binary --no-ext-diff HEAD` takes **20–60 ms** and `git status
--porcelain=v1` **5–33 ms**, the ranges spanning warm and cold filesystem cache.

The ledger adds two diff captures per phase dispatch. A phase dispatch is a
Claude Code CLI invocation measured in minutes; 40–120 ms of git per phase is
below the noise floor of the thing it brackets. The captures are `await`ed
rather than backgrounded, because the "before" capture is what establishes the
baseline, and a baseline taken after a phase has started writing would swallow
that phase's own work.

Memory is bounded by the dirty set, not the repository, and not by what a
declaration claims: the ledger holds a `Set<path>` per in-flight Run plus one
baseline set, prunes every set at each capture to the paths the tree still shows,
and drops a Run's entry at its terminal transition. Section bodies are never
retained. A phase declaring more than `MAX_DECLARED_PATHS_PER_PHASE` paths is
treated as a hole rather than truncated — truncation would drop real claims and
surface as `unattributed-worktree-change`, pointing an operator at a file when
the problem is the record.

## What this does not do

- **It does not add an in-product restore.** Restore stays a documented manual
  `git apply`, per [recovery-checkpoints.md](../operations/recovery-checkpoints.md).
  What this feature adds to that runbook is the **base commit**, now recorded in
  the metadata JSON, so the operator can check out the base a patch was taken
  against instead of inferring it.
- **It does not attribute an operator's own hand edits.** A file the operator
  edits in their editor mid-session is a post-baseline section claimed by no
  Run, and it declines every checkpoint until it is committed, stashed, or
  reverted. This is deliberate over-conservatism: the alternative is deciding,
  undecidably, that an unclaimed write was *not* the checkpointing Run's. The
  decline marker names the paths so the remedy is obvious.
- **It does not make a Run's audit record trustworthy.** A record that
  under-reports produces a decline, not a wrong patch — but it still produces a
  decline, and a CLI that routinely under-reports would make checkpoints rare
  above one in-flight Run. That is the trade FR-R3-004 asks for in as many words:
  an incomplete patch that presents as a checkpoint is worse than a decline. It
  is also the metric to watch; see *What would make us revisit this*.
- **It does not read a declared path.** Declared paths are matched as strings
  against sections git printed. Nothing opens, stats, or resolves one.
- **It does not police the sole-run path.** At one in-flight Run the ledger is
  bypassed entirely, so a whole-tree patch still sweeps up whatever a
  previously-failed Run left uncommitted — exactly as it does today. That is the
  requirement's "cap 1 is byte-for-byte unchanged" clause taken literally, and it
  is the one place the mechanism defers to the existing behaviour rather than
  improving on it. Above one in-flight Run those leftovers are `retired` keys:
  excluded from a scoped patch, and enough to block the whole-tree shortcut.
- **It does not change the cap, the range, or `MAX_QUEUES`.**
- **It does not weaken the decline.** Four reasons replace one; the set of
  situations in which a patch is written is strictly larger, and every situation
  in which one is written is one where the partition was checked.

## Constitutional impact

**None.** The chosen shape uses no `git worktree` and no copy-based isolation,
so the project ban recorded in `CLAUDE.md` stands unamended and
`.specify/memory/constitution.md` needs no change. This is recorded here rather
than left implicit because FR-R3-004's T310 asks for "any constitutional change
the chosen shape requires", and the answer being *none* is itself the finding.

## Supersession

Feature 093's **SC-015** — *"No snapshot of workspace file state taken while more
than one Run was executing is ever offered for restore, and every such declined
snapshot carries a recorded reason"* — is superseded in its literal wording, and
preserved in its intent. The invariant it was protecting was never "concurrency
means no snapshot"; it was **a snapshot must never contain work that is not the
Run's own**. The restated criterion is:

> No snapshot that contains another Run's work is ever offered for restore, and
> every declined snapshot carries a recorded reason.

Under a cap of 1 the two statements are identical. Above it, the old wording
mandates the decline that this feature removes the *cause* of. The hard rule in
`CLAUDE.md` is updated to match; the rule's first sentence — never take or offer
a checkpoint that cannot be attributed to a single Run — is unchanged, because
it is the one this record exists to keep.

## What would make us revisit this

Option 1 becomes the right answer if any of these become true, and the ban
should then be lifted deliberately rather than worked around:

- Runs need to execute against different commits, not just different files. The
  ledger partitions a tree; it cannot give two Runs different `HEAD`s.
- A phase legitimately needs to run `git checkout`, `git stash`, or a rebase.
  Every one of those rewrites the whole tree, so every section becomes something
  no declaration named and every sibling's partition is destroyed at once — the
  ledger will decline, loudly and correctly, but it will decline for everyone.
- `unattributed-worktree-change` becomes the common outcome in practice rather
  than the rare one. That would mean audit records are routinely missing writes,
  or writes are routinely escaping their phases, and the fix for either is
  isolation rather than a better check.
