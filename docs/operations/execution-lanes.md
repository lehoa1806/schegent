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
- [`src/services/execution-lanes/lane-retention.ts`](../../src/services/execution-lanes/lane-retention.ts)
- [`src/services/execution-lanes/run-lane-binding.ts`](../../src/services/execution-lanes/run-lane-binding.ts)
- [`src/headless/execution-lanes-api.ts`](../../src/headless/execution-lanes-api.ts)

For the store these records live in, see [SQLite application store](sqlite-application-store.md).
For the decision this engine implements, see
[Run isolation decision](../architecture/run-isolation-decision.md).
For the rehearsed, symptom-first recovery procedure when a lane or integration request is stuck,
see [Incident recovery guide — Symptom 3: Stuck execution lane](incident-recovery-guide.md#symptom-3-stuck-execution-lane).

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
> process in a lane can reach anything the operator's checkout can. Host Git operations disable
> repository hooks and fsmonitor (`core.hooksPath=/dev/null`, `core.fsmonitor=false`), while
> configured clean/smudge filters and any Git command run by a process in the lane still execute as the operator.

In practice (reconciled with review gap GC-11):

- every host-invoked Git call (`worktree add`, ref updates, freeze plumbing, fast-forward landing,
  status, and cleanup) passes `-c core.fsmonitor=false -c core.hooksPath=/dev/null`
  (`src/lib/host-git-config.ts`), so host lane operations do not run repository hooks (including
  `post-checkout`, `reference-transaction`, or `post-merge`) or an fsmonitor daemon;
- freezing uses plumbing (`add`, `write-tree`, `commit-tree`, `update-ref`) and never calls
  `git commit`;
- configured clean and smudge filters still run as the operator during host Git operations so
  committed blobs match repository filter semantics;
- any Git command run by an agent or verification check *inside* the lane still shares `.git/hooks`,
  configuration, credentials, and the object store, and executes hooks as the operator.

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
  requests to `blocked` with `review-stale`. When a refreeze overwrites an already-`blocked`
  request whose prior reason was not `review-stale` (for example `verification-failed` or
  `target-advanced`), the superseded reason is preserved in `lane_integration_journal` and exposed
  oldest-to-newest on `IntegrationRequestView.priorBlockedReasons`, while approving or landing the
  superseded request continues to refuse `review-stale`.
- `CandidateView.createdAt` is paired directly with the SQL column `lane_candidates.frozen_at`.
- `profileId` accepts 1–128 characters (`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`), aligned across the
  contract, headless validator, service rules, and SQLite schema.
- `queued`, `awaiting-review`, `blocked` and `uncertain` requests can be canceled. Canceling an
  `uncertain` request records that the operator acknowledged the unknown outcome. A `verifying` or
  `landing` request cannot be canceled.
- The target branch name is at most 200 bytes in UTF-8.
- Headless port calls (`src/headless/execution-lanes-api.ts`) and `requestIntegration` validate
  plain prototypes once and deep-snapshot all inputs (including nested verification profile checks
  and `argv` arrays) before any asynchronous Git step so caller getters or post-call mutations
  cannot diverge.
- List filter semantics (`listLanes`, `listRequests`): omitting `states` (`undefined`) returns all
  states; passing an explicit empty array (`states: []`) returns `{ items: [], nextCursor: null }`
  (matching `lanesInStates([])` and `requestsInStates([])`).
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
  tree, with merge autostash turned off, so the index and files move with the branch. Host Git
  overrides disable repository hooks (`core.hooksPath=/dev/null`), while configured clean/smudge
  filters still run as the operator.
- **The target branch is checked out nowhere.** The host updates the branch ref, naming the
  expected old value, so a concurrent move refuses instead of being overwritten.

The host locates the target branch again right before the effect, so a branch checked out after
the request moved to `landing` is fast-forwarded in its working tree, not moved under it. The
journal's intent names the method chosen first; its observation names the method used. Ancestry
checks (`isAncestorDetailed`) distinguish `ancestor`, `not-ancestor`, `missing-ref` (an absent or
GC'd commit, which landing reconciliation settles as `uncertain` rather than wedging), and
`git-error` (a subprocess/timeout/buffer/spawn failure, which remains retryable). Checked-out
target `git status` output exceeding 1 MiB (`code: 'buffer'`) refuses `target-worktree-dirty`
before landing and settles honestly (`blocked` or `uncertain`) on observation rather than leaving
the per-repository landing lock wedged.

The host never rebases, resets, stashes, discards, force-updates or pushes. A lint gate fails the
build if any string in the lane engine's source carries `reset`, `rebase`, `stash`, `push`,
`checkout`, `clean`, `--hard`, `--force` or `-f` as a word.

Landing journals its intent before any Git effect and its observed outcome after.

## Reconciliation

Reconciliation compares the store with Git after a crash or a closed window. It never replays a
landing and never removes an existing worktree:

- a lane left in `preparing` becomes `preparation-failed`;
- a `pending` cleanup operation left by a crash mid-cleanup is converged: if the worktree is already
  absent and unregistered in Git, any leftover `base` ref is deleted and the lane transitions
  cleanly to `removed`; if the worktree is still present or registered, the pending operation ends
  `failed` (`cleanup-interrupted`) and user work is preserved in `cleanup-eligible`;
- a request left in `verifying` goes back to `queued`;
- a request this window owns is settled by the same rules once no operation of this window holds
  its lane, so a Git failure that left a request in `landing` is settled without a restart; a
  lane this window is still preparing is left alone;
- a request left in `landing` is classified from the target's tip: still at the expected commit is
  `blocked` with `landing-not-applied`; at the candidate is `landed`; past the candidate with the
  candidate in its history is `landed` with `target-advanced-beyond`; anything else (including an
  absent/GC'd candidate commit or >1 MiB dirty checked-out status at the candidate tip) is
  `uncertain`, with both commits listed;
- a lane whose root was deleted by hand is reported `root-missing` and is never re-created
  (unregistered absent `preparation-failed` lanes are not reported `root-missing`);
- a lane whose root fails containment (for example, an escaping symlink) is reported
  `containment-refused` rather than `root-missing`;
- consecutive identical `reconcile` `kept` rows in `lane_operations` are deduplicated, and a
  bounded retention pass (`src/services/execution-lanes/lane-retention.ts`) runs at the end of
  reconcile;
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
| Git's worktree registry lists its root (not bare, not prunable) | `registry-mismatch` |
| Git's worktree registry entry is not locked (`git worktree lock`) | `worktree-locked` |
| `git status` completes within the 1 MiB buffer and timeout | `status-buffer-exceeded` / `status-timeout` |
| `git status` in the root shows no change and no untracked file, and its `HEAD` is the source commit or the lane's current candidate | `lane-dirty` |

- **Unregistered absent `preparation-failed` lanes** (whose worktree was never created and whose
  directory is absent on disk) settle cleanly to `removed` when released to `cleanup-eligible` and
  cleaned up; a directory left on disk that Git does not register still keeps `registry-mismatch`.
- **Mid-cleanup crash convergence & concurrent pin guard:** immediately before `git worktree remove`,
  cleanup opens a fenced transaction that re-checks `pinned = 0` and eligibility (aborting with
  `lane-pinned` if concurrently pinned while inspecting status) and records a durable `pending`
  `cleanup` operation. Pinning after that pre-removal fence refuses `lane-busy` while removal is
  in flight. A crash after `worktree remove` converges cleanly to `removed` on the next `reconcile`
  or `cleanupLanes` pass.
- **Sibling isolation:** locked worktrees (`worktree-locked`), `status-buffer-exceeded`, and
  `status-timeout` keep the affected lane without throwing or aborting cleanup of remaining sibling
  lanes in the batch.
- **Deduplication and bounded retention (`lane-retention.ts`):** consecutive identical `kept` rows
  in `lane_operations` are suppressed. At the end of `cleanupLanes` and `reconcile`, a fenced
  retention pass caps non-pending `lane_operations` to `64` per lane (never pruning `pending`
  operations) and prunes aged (`> 30` days) or excess (`> 500` per workspace) unpinned `removed`
  lanes that hold no pending operations, no open requests, no reachable `lane_candidates`, and no
  `lane_review_receipts` or `lane_integration_journal` records. Active, retained, pinned,
  `preparation-failed` (until explicitly cleaned up to `removed`, so remaining worktrees or `base`
  refs are never orphaned), candidate-bearing, and receipted/journalled lanes are always preserved.

Removal uses `git worktree remove` without `--force`, then deletes the lane's `base` ref. The
`candidate` ref is kept, so a landed or abandoned candidate stays recoverable by name. For lanes
with candidates, receipts, or journals, the lane's records outlive cleanup indefinitely; `removed`
is a terminal state.

**Ignored files are not protected.** Git removes a worktree that holds only ignored files, and
deletes those files with it. A lane is a disposable working tree, so build output and other ignored
files in a lane are lost at cleanup. To keep them, pin the lane: a pinned lane is never removed.

A lane becomes `cleanup-eligible` only when the operator releases it with `eligible`. Releasing
with `retain` keeps it out of cleanup.

## Ownership

Only the primary window writes lane records. Opening the service as primary takes a new ownership
generation for the workspace, and every write checks it in the same transaction. A window holding
an older generation refuses `ownership-superseded` and writes nothing.

In addition to fenced store transactions, freeze (`candidate-freezer.ts`), landing (`landing.ts`),
cleanup (`lane-cleanup.ts`), provisioning (`lane-provisioner.ts`), and verification
(`verification-runner.ts`, including fenced `insertVerificationResult`) re-check the host's SQLite
generation immediately before each Git or verification check effect. That aborts stale work before
spawning a subprocess. **Irreducible residual window:** an ownership transfer that lands in the
microsecond interval between the SQLite generation check and the OS `spawn` / Git ref commit cannot
be prevented by a SQLite fence alone; in that window, the stale host's subsequent settlement write
refuses `ownership-superseded`, and the successor's `reconcile()` classifies the observed Git state
from journalled commit hashes without ever repeating a landing.

## Authority, evidence and access guidance

- **Human approval provenance & verification-`argv` separation (`16-22`):** `approveRequest` binds
  `candidateCommit`, `targetCommit`, `profileRevision`, and `profileDigest` — all of which are
  readable on `IntegrationRequestView`. Those fields are **freshness bindings, not a secret**.
  `approveRequest` fails closed (`review-stale`, writing zero receipt) whenever
  `LaneServiceDeps.authorizeApproval` is omitted or returns `false`. Production Run dispatch
  (`RunLaneCoordinator` in `src/services/execution-lanes/run-lane-binding.ts`) never calls
  `requestIntegration`, `verifyRequest`, `approveRequest`, or `landRequest` on behalf of a Run, and
  none of those mutating operations are exposed to agents or webview IPC. Any surface granting
  approval authority must wire `LaneServiceDeps.authorizeApproval` to a host-verified human
  confirmation prompt that displays the parsed frozen verification checks (`argv`), ensuring a
  proposed verification `argv` cannot authorize its own landing.
- **Unsalted digests:** `repositoryId` is an unsalted SHA-256 of the repository's canonical common
  Git directory path (a local observer who knows or guesses candidate workspace paths can match it),
  and verification `outputSha256` is an unsalted SHA-256 of combined check stdout/stderr (capable of
  confirming guessed small or fixed outputs). Treat SQLite lane metadata with the same local
  operator access boundary as the workspace store.
- **Directory modes:** provisioning creates *new* parent directories under
  `<storageDir>/lanes/<workspaceId>` with mode `0700` (owner-only), while preserving the existing
  filesystem mode on directories that already exist.

## Known limits

- **Git's environment.** Every lane Git call and every check strips (case-insensitively, so Windows
  mixed/lowercase names cannot bypass removal) the variables that redirect Git, override config or
  helper binaries, or change how Git reads attributes and pathspecs:
  `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_COMMON_DIR`, `GIT_NAMESPACE`, `GIT_SHALLOW_FILE`,
  `GIT_REPLACE_REF_BASE`, `GIT_ATTR_SOURCE`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`,
  `GIT_LITERAL_PATHSPECS`, `GIT_GLOB_PATHSPECS`, `GIT_NOGLOB_PATHSPECS`, `GIT_ICASE_PATHSPECS`,
  `GIT_PREFIX`, `GIT_EXEC_PATH`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG`,
  `GIT_EXTERNAL_DIFF`, `GIT_TEMPLATE_DIR`, `GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_ASKPASS`,
  `SSH_ASKPASS`, `GIT_PAGER`, `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`, and any `GIT_CONFIG_KEY_*` or
  `GIT_CONFIG_VALUE_*` variable. Stripping `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` env overrides
  still lets Git read the operator's real `~/.gitconfig` and `/etc/gitconfig` while preventing
  env-var redirection.
- **A check's environment.** A verification check runs code the candidate holds, so before that
  removal it gets what `schegent.cli.environmentMode` gives the agent: under `allowlist` the
  bootstrap names (`PATH`, `HOME`, the account, locale and temp-directory names) plus
  `schegent.cli.environmentAllowlist`; under `inherit` the whole host environment. `minimal` keeps
  the bootstrap names for a check, since a build tool started by name needs `PATH`. The policy is
  read at each check, so a changed setting reaches the next one without a reload (review gap
  GC-15). A check that needs another variable, such as `JAVA_HOME`, needs it on the allowlist.
  <!-- Source: src/services/execution-lanes/verification-runner.ts -->
- **Git timeouts and pipe-holding descendants (`16-18`).** `createExecFileGitRunner` spawns `git`
  with `shell: false` and detached process-group teardown (`SIGTERM`, escalating to `SIGKILL` across
  the process group after 250 ms) plus a 2 s post-exit stdio-drain grace (clearing both timeout and
  drain timers on settlement). A filter or descendant holding pipes open cannot stall a lane call
  past bounded teardown, and every failure preserves its diagnosable code (`timeout`, `buffer`,
  `exit`, `spawn`) without leaking stderr.
  <!-- Source: src/services/execution-lanes/git-runner.ts -->
- **Repository filters run.** Every host Git call passes `-c core.fsmonitor=false` and
  `-c core.hooksPath=/dev/null`, so repository hooks and an fsmonitor program do not run (review gap
  GC-11). The host's patch diffs also pass `--no-ext-diff --no-textconv`. Clean and smudge filters
  configured for the repository still run in lanes as they do in the checkout: switching them off
  would make the lane commit store raw worktree content, which for an encrypting filter is the
  plaintext.
  <!-- Source: src/lib/host-git-config.ts -->
- **Large status output (`16-18`).** `git status` is bounded by a streaming 1 MiB `maxBuffer`
  returning `code: 'buffer'`. Verification releases the busy lane, returns the request to `queued`,
  and surfaces `LaneGitError` with `code: 'buffer'`; cleanup keeps the lane with
  `status-buffer-exceeded` without aborting sibling lanes; and landing refuses
  `target-worktree-dirty` (or settles `blocked` / `uncertain` during reconcile) rather than wedging
  the per-repository landing lock.
- **Exercised platforms and Windows (`16-22`).** Git and check commands run with the lane root as
  their working directory. Bare program names resolve along strictly absolute `PATH` entries only
  (review gap GC-24, `src/lib/spawn-command.ts`), so a planted executable in a lane does not run,
  and `.cmd` shims are not resolved as bare commands on Windows. See
  [Platform observation record](platform-observation-record.md) for the exact evidence tiers: full
  host + integration suites are exercised on `darwin/arm64` (Node `v24.22.2`); the unit tier ran in
  a Linux `aarch64` container (`npm run verify:linux` under OrbStack); and live Windows host
  execution remains **unrun** (Windows resolution and teardown paths are verified only by
  platform-parameterized unit tests).
  <!-- Source: src/lib/spawn-command.ts -->
- **Fault-injection suite measurement (`16-23`).** On `darwin/arm64` (`Node v24.22.2`, measured
  2026-11-23), `npx vitest run tests/unit/execution-lanes/fault-injection.test.ts` passed 9/9 tests
  in **28.99 s** Vitest duration (**29.36 s** wall-clock total), using non-wrapping 32-bit harness
  IDs (`writeUInt32BE`).

## Cutover status and what remains deferred (`16-23`)

Reconciling the original `specs/309-isolated-workspace-lanes/spec.md` delivery gaps against current
production cutover wiring (`src/activation/sqlite-cutover-wiring.ts`, `src/activation/run-safety-wiring.ts`):

- **FR-004 (Run dispatch):** Shipped opt-in behind `schegent.lanes.enabled` (default `false`) via
  `RunLaneCoordinator` (`src/services/execution-lanes/run-lane-binding.ts`) and `WorkflowController`.
  When `schegent.lanes.enabled` is `false`, Runs continue to share one working tree.
- **FR-008 (Lane identity carriage):** `WorkflowRun` records carry `laneId` and `laneRootRef`, and
  `PhaseHandoffCoordinator` resolves per-Run lane roots; legacy audit and metrics schemas do not yet
  add a dedicated lane-id column on every historical row.
- **FR-015 (Activation reconciliation & cleanup):** Primary activation opens `LaneService` and
  invokes `reconcile()` automatically (`src/activation/sqlite-cutover-wiring.ts`); cleanup remains
  an explicit host/headless operation (`cleanupLanes`) rather than an automatic background timer.
- **FR-016 (Two-repository sync):** Master Workspace + Execution Repository coordination ships
  separately via `NestedRepoSyncCoordinator` (`src/services/nested-repo-sync/`); single-lane
  provisioning continues to refuse nested repositories with `nested-repository-unsupported`.
- **FR-018 (Headless port & UI):** The headless port (`src/headless/execution-lanes-api.ts`) is
  shipped and read-only `ChangeReviewService` reads `IntegrationStore`; mutating sidebar/dashboard
  UI controls for lane approval, landing, and cleanup remain deferred.
- **FR-019 (SQLite persistence & ACP binding):** Migration 6 (`006_f10_execution_lanes`) is shipped
  and wired into the SQLite cutover. `AcpBackedRunner` binds session `cwd` to the resolved lane
  root; the ACP wire protocol itself carries no dedicated lane-id field.
- **Candidate-ref pruning:** `refs/schegent/lanes/<laneId>/candidate` grows by at most one ref per
  lane with a frozen candidate and is intentionally preserved by cleanup and `lane-retention.ts`.
