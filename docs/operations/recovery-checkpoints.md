# Recovery checkpoints

Schegent freezes a mutation plan when a run starts. Phases declared with
`git` or `unrestricted` side effects require an operator approval whose receipt
contains the plan fingerprint and approved phase IDs. Editing the catalog does
not broaden that receipt; resume requests approval again when fingerprints do
not match.

Immediately before each approved Git-capable phase, Schegent captures a private
binary diff and status manifest below the extension global-storage directory.
Checkpoint creation is fail-closed: the phase does not start if recovery
evidence cannot be written. Files and directories use owner-only permissions,
and what is kept is bounded both inside and across run directories — see
[Where they live, and how long they last](#where-they-live-and-how-long-they-last).

A checkpoint is a `.patch` beside a `<timestamp>-<phase>.json` metadata file. The
metadata carries `runId`, `phaseId`, `capturedAt`, `baseCommit`, the
`git status --porcelain=v1` manifest, and an `attribution` block of
`{mode, inFlightRuns, paths}`.

## Where they live, and how long they last

One directory per run, under VS Code's global storage for this extension:

```text
<globalStorageUri>/checkpoints/<runId>/
├── <timestamp>-<phaseId>.patch          # git diff --binary HEAD, mode 0600
├── <timestamp>-<phaseId>.json           # metadata for the patch above
└── <timestamp>-<phaseId>.declined.json  # marker; no patch was taken
```

That location is **outside your workspace**. The generated `.schegent/.gitignore`
does not reach it, the session-artifact sweep does not visit it, and the same
directory accumulates work from every workspace this extension has ever opened.
A `.patch` is unredacted source, so treat the store as you would the working tree
it came from.

Two budgets bound it, and neither knows about the other:

| Bound | Value | Scope |
|---|---|---|
| Artifacts per run | newest 20 | *Inside* one run directory. Declines count on the same budget. |
| Age | 14 days | *Across* run directories. A directory whose newest artifact is older than this is removed whole. |
| Total size | 256 MiB | *Across* run directories. While the store is over budget, whole directories go oldest-first until it fits. |
| Recent-run floor | newest 10 directories | Held back from the **size** bound. |

The floor does **not** hold a directory back from the age bound, and the
asymmetry is deliberate: "recent but over budget" is plausibly still wanted,
while "old" is the bound saying nobody wants it however few there are. A floor
that covered both would leave a residue of ancient diffs nothing could ever
reap.

The outer bounds are **age and volume, never lifecycle**. A run completing does
not delete its checkpoints — a finished run's patch is exactly what you want when
that run turns out to have gone badly. `.declined.json` markers are ordinary
artifacts under the same policy; they are not reaped preferentially for being
`restorable: false`.

The values are code-resident constants in
[`run-checkpoint-retention.ts`](../../src/services/run-checkpoint-retention.ts),
not settings. A setting here would be a knob whose wrong value is silent data
loss in a directory you never open.

The cross-run sweep runs once per window activation and does not block it. It
removes only inside the checkpoint root, refuses an entry that resolves outside
it, and does not follow a symlink into one. A sweep that removed nothing logs
nothing; a sweep that removed something writes one
`checkpoint-retention: sweep complete` line to the [runtime log](runtime-log.md)
carrying counts, bytes, and which bound triggered it. Retention writes nothing to
`audit.log`, which never carries a workspace path. If the checkpoint root cannot
be read the sweep warns once and gives up — no phase, run, or activation fails
because retention could not run.

**If you need a patch to outlive these bounds, copy it elsewhere.** Nothing warns
before a reap, and there is no undo.

## Restoring one by hand

There is no in-product restore. Read the metadata beside the patch, check out the
commit it names, and apply:

```sh
# 1. Which commit was the tree on when this was taken?
cat '<globalStorageUri>/checkpoints/<runId>/<timestamp>-<phaseId>.json'

# 2. Would it apply cleanly? --check changes nothing.
git -C <workspace> apply --check '<...>/<timestamp>-<phaseId>.patch'

# 3. Apply it against the commit the metadata named.
git -C <workspace> checkout <baseCommit>
git -C <workspace> apply '<...>/<timestamp>-<phaseId>.patch'
```

Use `baseCommit`, not whatever is currently checked out. A patch taken with
several runs in flight holds only one run's sections, so it is a subset of a tree
that has kept moving; applying it to a later commit is not guaranteed to be a
no-op even when it succeeds. Commit or stash your current work first — `git apply`
writes into the working tree.

A run directory that is not there was reaped by the age or size bound above, or
never held a patch because the snapshot was declined. Neither leaves a record of
the file that used to exist; the runtime log's `checkpoint-retention` lines say
how many directories a sweep removed, not which.

## When there is a marker instead of a patch

Schegent declines rather than writing a snapshot it cannot attribute to a single
run. A decline writes **no** `.patch` and records a
`<timestamp>-<phase>.declined.json` marker carrying `runId`, `phaseId`,
`declinedAt`, `inFlightRuns`, `restorable: false`, a `reason`, and a `detail`
naming what to deal with — plus a counts-only runtime-log warning. **A decline is
not a failure: the Git-capable phase proceeds.** Only a genuinely failed snapshot
blocks its phase. Markers are pruned on the same 20-per-run budget as snapshots,
and their run directory is reaped by the same cross-run bounds.

| `reason` | What it means | What to do |
|---|---|---|
| `unattributed-worktree-change` | The tree holds a change no run's audit record claims — a hand edit, or a write that escaped its phase. `detail.paths` names them. | Commit, stash, or revert those paths. |
| `path-mutated-by-multiple-runs` | Two runs both reported writing the same file, so neither patch can be separated. `detail.paths` names them. | Let one run finish and commit, or cancel one. |
| `attribution-evidence-incomplete` | This run's history, or a live sibling's, has a gap — a run resumed after a window restart, a phase that produced no audit record, or a git read that failed. `detail.ownEvidence` and `detail.unaccountedSiblings` say which. | Nothing to repair; the next run started in this window records cleanly. |
| `no-attributable-changes-observed` | Nothing this run claims is still uncommitted, so there is nothing to snapshot. | Expected after a run's own work has been committed. |
| `concurrent-runs-share-one-worktree` | **Historical.** Written by Schegent before FR-R3-004, when every checkpoint above one in-flight run was declined regardless of attribution. Nothing emits it now. | Nothing; the marker predates the current behaviour. |

To make declines less likely, run at `schegent.queue.globalConcurrencyCap = 1`, or
keep the working tree clean of hand edits while runs are in flight — see
[Multiple queues and concurrency](multi-queue-concurrency.md#recovery-checkpoints-under-concurrency).

Terminal state changes use a workspace-state intent journal. Activation replays
an unfinished intent before any queue scheduler starts, then reconciles the
terminal run, queue projection, and idempotent history entry before clearing the
journal.
