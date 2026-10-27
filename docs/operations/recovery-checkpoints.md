# Recovery from an interrupted run

Restored under FR-R3-062, which recorded that the stuck-run, crash-restart, safe-reset and
checkpoint-recovery runbooks were deleted without replacement. Cited from
`src/services/run-checkpoint-retention.ts`.
<!-- Source: src/services/run-checkpoint-retention.ts -->
<!-- Source: src/state/workspace-state.ts -->
<!-- Source: src/services/run-checkpoint-service.ts -->

Read [Data retention and deletion](data-retention-and-deletion.md) first if the question is what is
kept and for how long; this page is about getting a workspace moving again.

## Before anything: what state is safe to touch

Two things hold a run's identity, and they are not the same:

- **The audit log** (`.schegent/audit.log`) is append-only evidence. Never delete it to clear a
  stuck run — a hard rule, not a preference. It is the only record of what happened, and a
  reset that erases it removes the evidence needed to explain the reset.
- **Workspace state** (VS Code `Memento`) holds the queue, run records and execution leases. This
  is what a reset touches.

## A run appears stuck

1. **Check whether the process is actually gone.** Cancel the phase from the sidebar. Cancellation
   signals the backend's whole process tree, not just the direct child (FR-R3-054); if the runtime
   log records *"process tree not confirmed gone after SIGKILL"*, a descendant may still be
   running and writing to the workspace. Deal with that before restarting anything, or the next
   phase races it.
2. **Check the lease.** A queue whose execution lease is held by a window that is gone will be
   reclaimed once its heartbeat goes stale (15 seconds — `STALENESS_THRESHOLD_MS` in
   `src/state/lock.ts`, which is the value this sentence is checked against). Waiting is correct;
   forcing it is not.
3. **Read the runtime log** rather than guessing:
   [Inspect the runtime log](runtime-log.md).

## The host crashed or was reloaded mid-run

On activation the extension reattaches: it claims the workspace lock, reattaches the credit
watchdog, and resumes a persisted run. Nothing needs doing by hand for the ordinary case.

Each Run that activation resumes this way, and each Run the credit watchdog later resumes when a
rate-limit backoff ends or credits return, raises one warning as soon as the resume is admitted. It
names the queue, the first 8 characters of the Run id and the phase, and names the two commands
*Schegent: Show Active Run* and *Schegent: Cancel In-Flight Workflow*. The warning has no buttons and
changes nothing: the Run is already working in the workspace, so start no other agent beside it until
you have looked. A Run the queue drain resumes is **not** announced this way.

If the run does **not** resume, the likely cause is that its lease is still held by the previous
session's owner id and has not yet gone stale. That resolves itself within the staleness threshold.

## Safe reset

`schegent.reset` clears workspace state — queue, run records, leases. It does **not** and must not
delete the audit log or raw transcripts. After a reset:

- The audit log still contains every event from the run that was reset, so the history remains
  explainable.
- Session artifacts follow their own retention policy; see
  [Data retention and deletion](data-retention-and-deletion.md).

Prefer cancelling the phase and letting the lease expire over a reset. A reset is the right tool
when state is *inconsistent*, not when a run is merely slow.

## Checkpoints

A run checkpoint captures the working tree's diff at the point a run reached. There is **no
in-product restore path**: nothing resumes from a checkpoint automatically, and a later resume does
not read one — a checkpoint is restored by an operator applying the patch file by hand.
Retention is bounded — checkpoints are pruned by age and count like other evidence, so an old
checkpoint is not a durable record and must not be treated as one. The audit log is the durable
record.

### Restoring a checkpoint by hand

A checkpoint is two files in `<globalStorage>/checkpoints/<runId>/`: `<prefix>.patch` and
`<prefix>.json`. The prefix is the capture time in milliseconds and the Phase id, such as
`1800000000000-speckit-implement`. Two captures of one Phase in the same millisecond are not
merged: the second takes `-1`, the third `-2`, the lowest free number, and its manifest carries the
same suffix. A `<prefix>.declined.json` marker has no patch and nothing to restore. Markers and
snapshots share one budget of 20 entries per Run directory, so a Run that declines often keeps its
older snapshots for less time.

**1. What a checkpoint holds.** The patch is `git diff --binary` against the commit named by
`baseCommit` in the manifest: the staged and unstaged edits to tracked files, new tracked files and
binary files included. It does not hold an untracked file, and it never holds an ignored file;
ignored files are neither captured nor listed nor counted. The manifest says which case you are
in:

- `completeness: "complete"` means no untracked, non-ignored entry existed when it was taken.
- `completeness: "incomplete"` means at least one did. `excludedUntracked` lists up to 50 of them
  (a wholly untracked directory is listed once, with a trailing `/`) and `excludedUntrackedCount`
  is the full number. An empty patch beside `incomplete` is a work tree whose only changes were
  untracked, not a work tree with no changes.
- In a record made while other Runs were in flight, only entries under this Run's own declared
  paths are named; the rest are only counted in `unattributedUntrackedCount`.
- A manifest with no `completeness` field was written before the field existed. Read it as
  `unknown`, never as complete, and assume untracked files may be missing.

**2. A disposable target.** Apply the patch to a copy, never to the live workspace. Clone it with
`git clone --no-hardlinks` and check out `baseCommit` detached. Do not use `git worktree`: a
worktree shares the original repository's refs, hooks and object store, so it is not disposable. If
`baseCommit` is the empty tree (a repository with no commit yet), there is nothing to check out:
start from `git init`. Replace the placeholders with the workspace path, a new empty directory
outside the workspace, the manifest's `baseCommit` and the patch file's full path.

```bash
# Either a clone at the base commit ...
git clone --no-hardlinks <workspace> <tmp>
git -C <tmp> checkout --detach <baseCommit>
# ... or, when the repository has no commit yet, an empty one.
git init <tmp>
# Check first: this changes nothing, and exits non-zero if the patch does not apply cleanly.
git -C <tmp> apply --check --binary <patch>
git -C <tmp> apply --binary <patch>
# Only when the check failed: a three-way merge, which needs the base blobs (a clone has them).
git -C <tmp> apply --3way --binary <patch>
# Or last: apply what applies and write the rest to .rej files for a manual merge.
git -C <tmp> apply --reject --binary <patch>
```

**3. Check, then apply.** Run `--check` first and apply only if it exits 0. `git apply` is
all-or-nothing: when the check fails, nothing has been written.

**4. When the check fails.** The patch's lines no longer match the target, which happens when the
target has commits beyond `baseCommit`. `--3way` works through the index, so the target's own
changes must be committed first; it merges using the base blobs a clone holds, and leaves conflict
markers and a non-zero exit where the two edits meet. `--reject` works on an uncommitted target: it
applies the hunks that fit and writes the others beside the file as `<name>.rej` for a manual merge.

**5. Copying back.** Review the result in the target (`git -C <tmp> diff` and `status`), then copy
the files you want into the workspace by path. Do not copy the target's `.git`.

**6. What cannot be restored.** Everything in `excludedUntracked` (and, for `unknown`, anything
untracked), and every ignored file. If a file listed there matters, it is still in the workspace
as it was left; the checkpoint was never going to return it.

#### When a checkpoint cannot be taken

A Git-capable Phase is blocked, and the Run's error reads `checkpoint-unavailable: <reason>`, when
a snapshot cannot be taken. A blocked Phase is not a declined one: a decline writes a marker and
the Phase proceeds, a failure to snapshot stops it. The reason tells you what to change:

- `diff-size-limit`: the diff against the base is over 20 MiB. Commit or stash large changes, or
  remove the large file from the tracked set.
- `status-size-limit`: the working-tree status is over 1 MiB, in practice thousands of untracked
  files. Ignore, move or remove the generated files.
- `capture-failed`: Git itself could not be read; check that `git` runs in the workspace.
- `artifact-write-failed`: the checkpoint directory or a file in it could not be written; check the
  extension's global storage for space and permissions.

## What this page does not claim

Apart from "Restoring a checkpoint by hand", none of the procedures here has an automated
end-to-end test behind it. That section's commands are run in throwaway repositories by
`tests/integration/checkpoints/manual-restore-runbook.test.ts`, which also fails if its fenced block
and the test's command list differ. FR-R3-062 asks for tested runbooks; this page restores the
*content* that was deleted, and the tested-procedure half remains outstanding for every other
section and is recorded as such in that item.
