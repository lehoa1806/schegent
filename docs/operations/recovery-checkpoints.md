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
and the newest 20 checkpoints per run are retained.

**With more than one run in flight, the checkpoint is declined rather than
taken.** A checkpoint is a diff of the single shared working tree, so with a
sibling run editing concurrently it would capture that sibling's in-progress
work and restoring it would revert changes belonging to another task. Instead of
writing a snapshot that is unsafe to apply, Schegent writes no `.patch` at all
and records a `<timestamp>-<phase>.declined.json` marker carrying `runId`,
`phaseId`, `declinedAt`, `inFlightRuns`, `restorable: false`, and the reason
`concurrent-runs-share-one-worktree`, plus a matching runtime-log warning. A
decline is not a failure: the Git-capable phase proceeds. Only a genuinely
failed snapshot blocks its phase. Markers are pruned on the same
20-per-run budget as snapshots. To get restorable checkpoints back, run at
`schegent.queue.globalConcurrencyCap = 1`, or when the run is the only live one
— see [Multiple queues and concurrency](multi-queue-concurrency.md#recovery-checkpoints-are-declined-while-runs-are-concurrent).

Terminal state changes use a workspace-state intent journal. Activation replays
an unfinished intent before any queue scheduler starts, then reconciles the
terminal run, queue projection, and idempotent history entry before clearing the
journal.
