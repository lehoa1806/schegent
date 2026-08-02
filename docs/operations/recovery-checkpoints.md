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

Terminal state changes use a workspace-state intent journal. Activation replays
an unfinished intent before any queue scheduler starts, then reconciles the
terminal run, queue projection, and idempotent history entry before clearing the
journal.
