# Execution Lanes (`FR-R6-F10`)

**Declared**: 2026-11-10 (`specs/309-isolated-workspace-lanes/spec.md`)

This guide is for an operator who wants to know what an execution lane is, what the host will and
will not do inside one, and how work in a lane reaches a branch. Every answer comes from one
authority, `LaneService`. The headless port validates input and returns the service's results
unchanged.

Opt-in Run dispatch into execution lanes is controlled by `schegent.lanes.enabled` (default `false`),
with `schegent.lanes.liveCap` (default `1`, max `20`) and
`schegent.lanes.provisioningDeadlineSeconds` (default `120`, range `1`–`600`). While
`schegent.lanes.enabled` is `false`, Runs execute in the operator's checkout, and a queue cap above
one still shares that one working tree (see [Multi-queue concurrency](multi-queue-concurrency.md)).
When `schegent.lanes.enabled` is `true`, each admitted Run provisions an isolated Git worktree
outside the workspace (`lanes/<workspaceId>/<laneId>`), routes agent `cwd`, output verification, and
checkpoint diffs to that lane root while keeping audit, ownership, diagnostics, and handoff evidence
in the primary workspace, and refuses admission with a named `LaneRefusalReason` rather than
silently falling back to the shared checkout. Master Workspace + Execution Repository updates are
coordinated through local transactional sync with compensating rollback (`src/services/nested-repo-sync/`),
recording both revisions explicitly without claiming distributed atomicity.

Implemented in:
- [`src/contracts/execution-lanes.ts`](../../src/contracts/execution-lanes.ts)
- [`src/services/execution-lanes/lane-service.ts`](../../src/services/execution-lanes/lane-service.ts)
- [`src/services/execution-lanes/lane-provisioner.ts`](../../src/services/execution-lanes/lane-provisioner.ts)
- [`src/services/execution-lanes/provisioning-probe.ts`](../../src/services/execution-lanes/provisioning-probe.ts)
- [`src/services/execution-lanes/candidate-freezer.ts`](../../src/services/execution-lanes/candidate-freezer.ts)
- [`src/services/execution-lanes/verification-runner.ts`](../../src/services/execution-lanes/verification-runner.ts)
- [`src/services/execution-lanes/landing.ts`](../../src/services/execution-lanes/landing.ts)
- [`src/services/execution-lanes/lane-reconciler.ts`](../../src/services/execution-lanes/lane-reconciler.ts)
- [`src/services/execution-lanes/lane-cleanup.ts`](../../src/services/execution-lanes/lane-cleanup.ts)
- [`src/headless/execution-lanes-api.ts`](../../src/headless/execution-lanes-api.ts)

For the store these records live in, see [SQLite application store](sqlite-application-store.md).
For the decision this engine implements, see
[Run isolation decision](../architecture/run-isolation-decision.md).

## What a lane is

A lane is a separate Git working tree, made with `git worktree add` from a source revision of the
operator's repository. It lives under the extension's storage directory, at
`lanes/<workspaceId>/<laneId>`, never inside the workspace. The host writes the lane's record as
`preparing` before the first Git step and moves it on after the last, so a lane it made can always
be tied back to its record.

Each lane owns two refs outside `refs/heads/`, so they never show in a branch list:

- `refs/schegent/lanes/<laneId>/base`, created once at provisioning;
- `refs/schegent/lanes/<laneId>/candidate`, set each time the lane's work is frozen.

Nothing from the operator's checkout is copied into a lane. A lane starts from the committed
source revision only: no uncommitted change, untracked file or ignored file is carried over.

The live-lane cap defaults to 1 and can be raised to 20. `preparing`, `active` and `paused` lanes
count toward it.

The workspace root and the storage directory must be absolute paths; the service refuses to open
with either one relative.

## The disclosure

Every lane carries this text, word for word:

> A lane is a separate Git working tree. It is a working-tree boundary, not a permission boundary:
> the repository's hooks, configuration, credentials and object store are shared with it, and a
> process in a lane can reach anything the operator's checkout can. Lane operations may run the
> repository's hooks, and a fast-forward landing in a checked-out branch may run `post-merge`.

In practice:

- `git worktree add` runs `post-checkout`;
- every ref update runs `reference-transaction` on Git 2.28 and later;
- freezing does not use `git commit`, so `pre-commit`, `commit-msg` and `post-commit` do not run;
- a fast-forward landing into a checked-out branch runs `post-merge`.

No lane operation is hook-free. Hooks are the operator's to keep or change.

## The eight provisioning refusals

Before it creates anything, provisioning probes the repository. Each condition below refuses with
its own reason, and nothing is written to disk or to Git:

| Reason | Meaning |
|---|---|
| `git-version-unsupported` | Git is older than 2.17, the oldest version the engine supports |
| `submodules-unsupported` | the repository declares submodules |
| `lfs-unsupported` | the repository uses Git LFS |
| `lane-root-inside-workspace` | the storage directory's `lanes` folder resolves inside the workspace |
| `nested-repository-unsupported` | the workspace folder is not its repository's top level, or the repository is a submodule of another |
| `dependency-recipe-unsupported` | the dependency recipe is not `none`, the only recipe in this release |
| `lane-bound-reached` | the live-lane cap is already reached |
| `source-revision-unresolved` | the source revision does not name a commit |

Two more outcomes keep the lane in `preparation-failed`, with its residue left for inspection:
`provisioning-deadline-exceeded` (the default deadline is 120 seconds, adjustable from 1 to 600) and
`provisioning-git-failed`.

## Freezing a candidate

Freezing records the lane's current work as one commit, without `git commit`: it stages
everything, writes a tree and a commit, and moves the lane's `candidate` ref naming its expected
old value. The commit uses the repository's `user.name` and `user.email`; if either is missing,
freezing refuses `git-identity-missing`. A lane whose tree equals its last recorded candidate, or
its base when it has none, refuses `candidate-empty`. A freeze that failed after moving the lane's
`HEAD` left no record, so it can be repeated.

## The integration lifecycle

An integration request asks for one frozen candidate to land on one branch. It freezes the
candidate commit, the target branch, the target's tip and the verification profile when it is
made.

| State | Meaning |
|---|---|
| `queued` | made; waits for verification |
| `verifying` | the profile's checks are executing in the lane |
| `awaiting-review` | every check passed; a review receipt is needed before landing |
| `landing` | the fast-forward is in progress |
| `landed` | the target holds the candidate (terminal) |
| `blocked` | a check failed, the target moved, or the landing did not apply; never re-verified in place |
| `canceled` | the operator ended it (terminal) |
| `uncertain` | the target's state after a landing fits no known outcome; both commits are listed |

- At most one request per repository is `verifying` or `landing` at a time. A second one refuses
  `integration-busy`. This holds across windows and across a crash, because the store enforces it.
- A review receipt must name the same candidate, target commit, profile revision and profile
  digest as the request. Any difference refuses `review-stale`.
- Freezing a new candidate for the lane moves its `queued`, `awaiting-review` and `blocked`
  requests to `blocked` with `review-stale`.
- `queued`, `awaiting-review`, `blocked` and `uncertain` requests can be canceled. Canceling an
  `uncertain` request records that the operator acknowledged the unknown outcome. A `verifying` or
  `landing` request cannot be canceled.
- The target branch name is at most 200 bytes in UTF-8.
- Before the first check, the lane must hold the candidate with no tracked change and no untracked
  file; after the last check, with no tracked change. A check may write untracked build output.
  Otherwise the request is `blocked` with `verification-workspace-changed`. Ignored files are not
  seen.
- A check settles when its output closes, or 2 seconds after it exits, whichever comes first, so a
  descendant that left the check's process group cannot hold verification open.
- A verification check's output is hashed and counted, then discarded. No check output, Git
  stderr, absolute path or environment value is stored or returned.
- This window runs one operation per lane at a time: freezing, requesting integration, verifying
  and landing each refuse `lane-busy` while another of them holds the lane, and so does pausing
  the lane.

## Landing

Landing is an explicit, approved fast-forward. It re-checks the target's tip first and refuses,
keeping the lane, when:

- the target moved past the expected commit (`target-advanced`);
- the candidate does not descend from the target (`target-diverged`);
- the target branch is checked out with uncommitted changes (`target-worktree-dirty`);
- the target branch is checked out in a lane (`target-is-lane`).

There are two methods:

- **The target branch is checked out.** The host runs a fast-forward-only merge in that working
  tree, with merge autostash turned off, so the index and files move with the branch.
  `post-merge` may run.
- **The target branch is checked out nowhere.** The host updates the branch ref, naming the
  expected old value, so a concurrent move refuses instead of being overwritten.

The host locates the target branch again right before the effect, so a branch checked out after
the request moved to `landing` is fast-forwarded in its working tree, not moved under it. The
journal's intent names the method chosen first; its observation names the method used.

The host never rebases, resets, stashes, discards, force-updates or pushes. A lint gate fails the
build if any string in the lane engine's source carries `reset`, `rebase`, `stash`, `push`,
`checkout`, `clean`, `--hard`, `--force` or `-f` as a word.

Landing journals its intent before any Git effect and its observed outcome after.

## Reconciliation

Reconciliation compares the store with Git after a crash or a closed window. It never replays a
landing and never removes anything:

- a lane left in `preparing` becomes `preparation-failed`;
- a request left in `verifying` goes back to `queued`;
- a request this window owns is settled by the same rules once no operation of this window holds
  its lane, so a Git failure that left a request in `landing` is settled without a restart; a
  lane this window is still preparing is left alone;
- a request left in `landing` is classified from the target's tip: still at the expected commit is
  `blocked` with `landing-not-applied`; at the candidate is `landed`; past the candidate with the
  candidate in its history is `landed` with `target-advanced-beyond`; anything else is
  `uncertain`, with both commits listed;
- a lane whose root was deleted by hand is reported `root-missing` and is never re-created;
- a worktree in Git's registry that no lane record names is counted, never touched, and its path is
  not reported.

## Cleanup

Cleanup removes a lane only when every condition holds. Otherwise it keeps the lane and reports
why:

| Condition | Kept with |
|---|---|
| the lane is not pinned | `lane-pinned` |
| its state is not live (`preparing`, `active`, `paused`) | `lane-live` |
| its state is `cleanup-eligible` | `lane-state-invalid` |
| no request of the lane is open (`queued`, `verifying`, `awaiting-review`, `landing`, `blocked`, `uncertain`) | `request-open` |
| its root resolves inside the storage directory's `lanes/` | `not-contained` |
| Git's worktree registry lists its root | `registry-mismatch` |
| `git status` in the root shows no change and no untracked file, and its `HEAD` is the source commit or the lane's current candidate | `lane-dirty` |

Removal uses `git worktree remove` without `--force`, then deletes the lane's `base` ref. The
`candidate` ref is kept, so a landed or abandoned candidate stays recoverable by name. The lane's
records are kept too; `removed` is a terminal state, not a deleted row.

**Ignored files are not protected.** Git removes a worktree that holds only ignored files, and
deletes those files with it. A lane is a disposable working tree, so build output and other ignored
files in a lane are lost at cleanup. To keep them, pin the lane: a pinned lane is never removed.

A lane becomes `cleanup-eligible` only when the operator releases it with `eligible`. Releasing
with `retain` keeps it out of cleanup.

## Ownership

Only the primary window writes lane records. Opening the service as primary takes a new ownership
generation for the workspace, and every write checks it in the same transaction. A window holding
an older generation refuses `ownership-superseded` and writes nothing.

The generation fences records, not Git. A superseded window that is part-way through a freeze,
a cleanup or a landing can still finish that Git step before its next write refuses. The next
reconcile observes what Git holds.

## Known limits

- **Git's environment.** Every lane Git call and every check runs with the variables that
  redirect Git or change how it reads configuration, attributes and pathspecs removed:
  `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_NAMESPACE`, `GIT_SHALLOW_FILE`,
  `GIT_REPLACE_REF_BASE`, `GIT_ATTR_SOURCE`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`,
  `GIT_LITERAL_PATHSPECS`, `GIT_GLOB_PATHSPECS`, `GIT_NOGLOB_PATHSPECS`, `GIT_ICASE_PATHSPECS` and
  `GIT_PREFIX`. The operator's `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` are kept.
- **A check's environment.** A verification check runs code the candidate holds, so before that
  removal it gets what `schegent.cli.environmentMode` gives the agent: under `allowlist` the
  bootstrap names (`PATH`, `HOME`, the account, locale and temp-directory names) plus
  `schegent.cli.environmentAllowlist`; under `inherit` the whole host environment. `minimal` keeps
  the bootstrap names for a check, since a build tool started by name needs `PATH`. The policy is
  read at each check, so a changed setting reaches the next one without a reload (review gap
  GC-15). A check that needs another variable, such as `JAVA_HOME`, needs it on the allowlist.
  <!-- Source: src/services/execution-lanes/verification-runner.ts -->
- **Git timeouts.** A Git call past its bound is sent `SIGTERM`, not killed as a process group.
  A hook that ignores it, or leaves a process holding Git's output, can hold the call open.
- **Repository filters run.** Every host Git call passes `-c core.fsmonitor=false` and
  `-c core.hooksPath=/dev/null`, so repository hooks and an fsmonitor program do not run (review gap
  GC-11). The host's patch diffs also pass `--no-ext-diff --no-textconv`. Clean and smudge filters
  configured for the repository still run in lanes as they do in the checkout: switching them off
  would make the lane commit store raw worktree content, which for an encrypting filter is the
  plaintext.
  <!-- Source: src/lib/host-git-config.ts -->
- **Large status output.** A lane whose `git status` output exceeds 1 MiB cannot be observed, and
  the operation that needed it fails instead of guessing.
- **Windows.** Git and check commands run with the lane root as their working directory. On
  Windows a bare program name such as `git` or `npm` is resolved along PATH only, to an absolute
  path, so a `git.exe` or `npm.exe` placed in a lane does not run (review gap GC-24). A relative
  PATH entry is skipped for the same reason. A check program installed only as a `.cmd` shim is
  not found, as before. The engine is not exercised on Windows.
  <!-- Source: src/lib/spawn-command.ts -->

## What is deferred

- **Dispatch.** Runs do not execute in lanes. A queue cap above one still shares one working
  tree, and no surface may say otherwise until dispatch ships.
- **UI.** There is no sidebar or dashboard view of lanes. The headless port is the only surface.
- **ACP.** No backend protocol carries lane identity.
- **Activation wiring.** Reconciliation and cleanup are host operations; calling them from
  extension activation is not wired in this release.
- **Candidate-ref pruning.** `candidate` refs grow by at most one per lane and are not pruned.
