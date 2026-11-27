# Per-Run execution isolation — the shape, and the gate on building it

Status: **Accepted (shape). Opt-in implementation shipped behind `schegent.lanes.enabled` (default `false`) — see §9.**
Date: 2026-08-27 (reconciled 2026-11-23) · Item: `FR-R3-124` · Spec: `specs/160-run-isolation-boundary` · Delivery: `FR-R6-F10` (`specs/309-isolated-workspace-lanes`)
Supersedes nothing. Narrows nothing already ratified.

Decision: when Schegent gains per-Run execution isolation, the shape is a **per-Run Git worktree**
provisioned and destroyed by the extension host, opt-in, with an explicit attributable merge-back
step. Per-Run clone, copy-based isolation, and contained-backend-only were considered and rejected;
§3 gives the reason for each.

When written on 2026-08-27, this record did **not** ship that mechanism: it decided the shape,
lifted the project rule that forbade it, stated the seams and open questions the implementation
inherited, and put a dated gate on starting it. All four entry conditions in §9 were subsequently
satisfied and opt-in lane dispatch shipped behind `schegent.lanes.enabled` (default `false`) on
2026-11-12; shared-tree execution remains the shipped default, and §9 states what is shipped versus
what remains deferred.

<!-- Source: docs/architecture/local-queue-parallelism-ratification.md -->
<!-- Source: src/services/run-checkpoint-service.ts -->
<!-- Source: src/services/run-mutation-ledger.ts -->

## 1. The question, and why it is being answered now

The workspace-wide concurrency cap — workspace state held under
`schegent.queue.globalConcurrencyCap` and set in the Settings page's Queues section — defaults to `1`
and admits up to `20`. Above one, independent Runs execute in the same checkout. The repository audit of 2026-08-27 made this its second top
finding and half of recommendation P0-2, and its judgment is architectural rather than incidental:
mutation ledgers and checkpoint refusal *"improve attribution, but they cannot provide workspace
isolation or prevent semantic conflicts"*, so semantic edit conflicts and unattributable mutation are
*"an architectural consequence rather than a rare implementation bug"*. Its do-not-ignore list adds
the marketing half: concurrency above one must not be presented as isolation until the boundary
exists.

Round 3 built every compensating control available and this record reopens none of them:

- `FR-R3-004` made checkpoints attributable under concurrency — the declaration attributes, the
  observation checks, and ambiguity declines.
- `FR-R3-077` made the execution fence mandatory.
- `FR-R3-103` closed the unfenced-orphan path.

They work. None of them is a boundary, and none can be. Two Runs editing one file produce one diff;
attribution can refuse to present it as a checkpoint, which is what `decide()` does, but it cannot
decompose it into two intents. **A refusal is the correct behaviour and it is not isolation.**

## 2. The chosen shape

Each admitted Run that would otherwise share a checkout receives a Git worktree of the same
repository, rooted outside the primary working tree, in which its phases execute. Its outputs return
to the primary tree through an explicit merge-back step that is reviewable and attributable by
construction, because the worktree's diff is the Run's diff — no declaration needed to establish
whose work it is.

Three properties decided the choice:

1. **Attribution becomes structural.** The declaration/observation machinery `FR-R3-004` built stops
   being the thing that makes a patch attributable and becomes the thing that makes a *merge-back*
   reviewable. That is a better job for it and it is not wasted work.
2. **One object database.** A worktree shares `.git`, so history, refs, and objects are not
   duplicated. A clone duplicates all three and then has to reconcile them.
3. **Git already answers for it.** `git worktree list --porcelain` enumerates them, `git worktree
   remove` destroys one, `git worktree prune` reaps records whose directory is gone. Orphan recovery
   after a host crash has a first-class primitive rather than a directory-naming convention.

## 3. Alternatives, and why each was rejected

### Per-Run clone

Rejected. It duplicates the object database per Run — on a large repository that is the dominant
disk and time cost of admitting a Run, paid at admission, when the operator is waiting. It also
creates a second answer to "what is this repository's history", which every later question
(submodules, LFS, hooks, remotes, credentials) has to be asked twice about. The isolation it buys
over a worktree is the object database, which is not the thing being isolated: the conflict is in
the working tree.

### Copy-based isolation (`cp -R` of the working tree)

Rejected, and it was the fallback `FR-R3-004` named. It is expensive on large repositories, it has
no primitive for "what copies exist" or "reap the ones whose owner is gone", and it makes the copy's
relationship to `HEAD` a convention rather than a fact Git can be asked about. Its one advantage —
it works without Git — is worth less than it looks, because the checkpoint mechanism already makes
Git a hard runtime dependency of the feature that would use it.

### Contained-backend-only

Rejected **as a substitute**, accepted as a complement. Containing the backend
(`FR-R3-125`) bounds what a model-driven process can reach; it does not stop two contained backends
from being pointed at the same working tree, which is exactly the situation here. The two boundaries
are orthogonal and the audit filed them as two halves of one recommendation. An uncontained backend
can also *leave* its worktree, so worktrees do not make backends safe either. Neither is the other's
answer.

### Leave the cap at one in practice

Rejected as a decision, though it is the honest description of the default. The cap's range above one
is ratified for the pinned local topology
(`docs/architecture/local-queue-parallelism-ratification.md`) and this record does not reopen that.
What it refuses is the position that a ratified range needs no boundary: the ratification's own
residual-risks section says concurrent Runs share one worktree and may edit the same path. This
record is the plan for retiring that residual, not a challenge to the ratification.

## 4. The `git worktree` prohibition — where it actually lived, and its narrow lifting

**The prohibition was never in the constitution.** `FR-R3-004` recorded that choosing worktrees
*"requires lifting that ban explicitly in `.specify/memory/constitution.md`, not silently in an
implementation PR"*. `.specify/memory/constitution.md` contains the string `worktree` **zero times**,
and did not contain it when that sentence was written. The rule lives in `AGENTS.md`'s checkpoint
hard rule — *"this project forbids `git worktree`"* — and is restated as established fact in
`specs/093-per-queue-run-execution/plan.md` ("forbidden project-wide"), that spec's `T053` and
`research.md`, `docs/architecture/blueprint.md`, and the run-mutation-ledger docblock.

This correction is recorded rather than quietly worked around. Adding the prohibition to the
constitution in order to then lift it would manufacture the record the earlier prescription assumed
existed — the form-over-truth defect `FR-R3-116`, `122`, `123` and `126` are about, committed by the
item correcting that class. The ban is therefore lifted in `AGENTS.md`, the file that declares itself
the single source of truth for the hard rules.

**The lifting is narrow, and the narrowness is the point.** `git worktree` remains forbidden as an
ambient development or agent practice in this repository. It is permitted **only** for
Schegent-provisioned per-Run execution roots, created and destroyed by the mechanism §9 gates, under
the containment oracle (`src/lib/path-containment.ts`) and the fence. A blanket lift would license
exactly the unattributable working tree the rule protected, in the window before the mechanism
exists — the worst possible ordering.

Historical statements are left as written where they are dated records (the `specs/093` files, the
`DONE_` feature files); `AGENTS.md`, `blueprint.md`, and the ledger docblock state present rule and
are corrected to point here.

## 5. Git version floor

**Floor: Git 2.17** (2018-04), and the floor is set by `git worktree remove` rather than by `add`:

| Primitive | Since | Used for |
|---|---|---|
| `git worktree add --detach` | 2.5 | provisioning a Run's root at a specific commit |
| `git worktree prune` | 2.5 | reaping records whose directory is gone |
| `git worktree list --porcelain` | 2.7 | enumerating what exists, for orphan recovery |
| `git worktree remove` | 2.17 | destroying a Run's root, including its administrative record |
| `git worktree repair` | 2.30 | recovering after the primary tree moves |

`repair` is **not** in the floor: a moved primary tree is a case the mechanism may refuse rather than
repair, and requiring 2.30 (2020-12) for a recovery path that has not been designed would raise the
floor for nothing. The floor is stated here rather than assumed from the ambient version, and the
implementation must probe it and refuse the opt-in below it — a partially-supported worktree is worse
than none, because the operator would have been told they had a boundary.

Git is already a hard runtime dependency of the checkpoint mechanism (`git diff --binary`,
`git status --porcelain=v1`, `git rev-parse HEAD`), so this adds a version requirement, not a
dependency.

## 6. Disk cost

A worktree shares `.git`, so the cost is **one checkout of the tracked tree per concurrent Run**,
plus a small administrative directory under `.git/worktrees/<name>/`. It does **not** duplicate the
object database, refs, or history.

Untracked and ignored files are **not** copied — which is a behaviour change an operator will notice
before they notice anything else: `node_modules/`, build output, and `.env` files are absent from a
fresh worktree. For this product that is the single largest practical obstacle, because a Run's
phases frequently invoke tooling that expects an installed dependency tree. The implementation must
decide it explicitly (§8, Q3) rather than discover it.

Order-of-magnitude for this repository, stated so the number is not invented later: the tracked tree
is the dominant term and `node_modules` is not in it. At cap 8 the cost is 8 tracked checkouts, and
whatever Q3 decides about the untracked tree is what makes that figure acceptable or not.

## 7. Credential and hook semantics

- **Credentials.** A worktree shares the repository's config and therefore its remotes and its
  credential helper. Nothing is isolated by a worktree at the credential layer: a process in a
  worktree can push, fetch, and read `.git/config` exactly as one in the primary tree can. **A
  worktree is a working-tree boundary and not a permission boundary**, and any statement that
  implies otherwise is the same overclaim this item exists to prevent. Backend authority is
  `FR-R3-125`'s subject.
- **Hooks and filters.** Hooks live in `.git/hooks` and are shared with processes running inside a
  worktree, so any Git command executed by an agent or verification check in a lane still fires
  hooks as the operator with `$GIT_DIR` pointing at the worktree's administrative directory.
  Since GC-11 (2026-11-12), host-invoked Git calls neutralize repository hooks and fsmonitor via
  `-c core.hooksPath=/dev/null` and `-c core.fsmonitor=false` (`src/lib/host-git-config.ts`),
  while configured clean/smudge filters continue to execute as the operator so committed content
  matches repository filter semantics. See [Execution lanes](../operations/execution-lanes.md).
- **Submodules and LFS.** Both are out of the first implementation's scope and must be *refused*
  rather than half-supported: a worktree of a repository with submodules does not initialise them,
  and LFS smudge behaviour in a secondary worktree is version-dependent. Refuse the opt-in, name the
  reason.

## 8. The seam inventory and the open questions

### 8a. Seams, measured 2026-08-27 at `5958474`

**Git is invoked from two modules, four call sites, and every one passes `cwd: workspaceRoot`:**

| Site | Command | Consequence of a per-Run root |
|---|---|---|
| `src/activation/run-safety-wiring.ts:80` | `git diff --binary --no-ext-diff HEAD` | the baseline probe must run in the Run's root, or the baseline is the wrong tree's |
| `src/services/run-checkpoint-service.ts:260` | `git diff --binary --no-ext-diff HEAD` | the checkpoint diff becomes the Run's diff — see §8b Q1 |
| `src/services/run-checkpoint-service.ts:264` | `git status --porcelain=v1` | same |
| `src/services/run-checkpoint-service.ts:268` | `git rev-parse HEAD` | a detached worktree's `HEAD` is its own; the answer changes |

**The phase execution cwd is a single value threaded from one place.**
`WorkflowControllerOptions.cwd` is set once from the workspace root, reaches `RunDriver` as
`options.cwd`, and from there `phase-runner.ts`, `phase-sidecar-reader.ts`, `session-compactor.ts`
and the runner's `request.cwd`. The driver is already **per-queue** (feature 093's session registry),
so per-*queue* is nearly per-Run — but a session outlives a Run, so the value must be resolved per
Run and not per session.

**The evidence layer is anchored to `workspaceRoot` in twelve or more modules**, and this is the
largest and least obvious part of the work: `audit/audit-log-writer.ts`,
`audit/raw-transcript-writer.ts`, `audit/verbose-diagnostic-path.ts`, `controller/phase-runner.ts`,
`controller/phase-sidecar-reader.ts`, `metrics/metrics-service.ts`,
`metrics/metrics-rollup-writer.ts`, `metrics/metrics-rollup-reader.ts`,
`monitor/cli-transport-sink.ts`, `activation/workspace-session.ts` (`.schegent/ownership`),
`state/mount-capability-probe.ts`, `ui/sidebar/audit-tail-coldstart.ts`.

**The fence and window primacy are anchored to the primary tree.** `.schegent/ownership` under the
workspace root is where the lease lives, and `FR-R3-103` closed the orphan path on that assumption.

### 8a.1 Cutover reconciliation (2026-11-23, post-`FR-R6-F10` / `FR-R7-16`)

The 2026-08-27 seam table above reflects the pre-lane baseline. Current production wiring reconciles
each seam as follows while keeping shared-tree mode as the default (`schegent.lanes.enabled = false`):

| Production seam | Current wiring | Behavior |
|---|---|---|
| `src/activation/sqlite-cutover-wiring.ts` | Opens `LaneService` on primary activation, calls `laneService.reconcile()`, creates `RunLaneCoordinator`, and opens read-only `ChangeReviewService` over `IntegrationStore`. | Startup recovery and lane-root caching run on primary cutover; periodic cleanup remains host/headless-triggered. |
| `src/activation/run-safety-wiring.ts` | Wires `provisionRunLane`, `resolveRunCwd`, `onRunLanePaused`, and `onRunLaneResumed` into `WorkflowController` and `RunCheckpointService`, and resolves lane roots at connected-run settlement. | Runs bound to a lane execute, verify outputs, and diff checkpoints in the lane root; non-lane Runs keep `workspaceRoot`. |
| `src/services/execution-lanes/run-lane-binding.ts` | Provisions or reuses one lane per `rootExecutionId`, refuses admission (`IsolatedLaneProvisionRefusedError`) without shared-tree fallback, syncs pause/resume/terminal transitions, and freezes a candidate on completion. | Never opens integration requests, approves receipts, or lands branches on behalf of a Run (`16-22`). |
| `src/services/run-checkpoint-service.ts` | Resolves `effectiveRoot` via `resolveRunExecutionRoot` before Git diff/status/HEAD reads. | Captures sole-run diffs inside the lane root while storing patches and recovery envelopes under host storage. |
| `src/services/workflow-execution/` & `src/runner/acp-backed-runner.ts` | Resolves per-Run lane root for cross-root handoff materialization and ACP session `cwd`. | ACP wire protocol carries no lane-id field; session scoping uses the resolved lane path. |
| Primary-workspace anchors (`.schegent/`, SQLite, audit, metrics, ownership leases) | Unchanged — anchored to the primary workspace and host storage directory. | Evidence and ownership fencing survive lane removal (`Q2`). |
| `src/services/nested-repo-sync/nested-repo-sync.ts` | Separate local transactional sync coordinator for Master Workspace + Execution Repository. | Single-lane provisioning still refuses nested repos (`nested-repository-unsupported`); two-repo sync uses compensating rollback outside single-lane provisioning. |

### 8b. The eight open questions, with the position each currently has

These are **positions**, not decisions: they are what a reader should assume unless the
implementation argues otherwise, and each states what would change it.

| # | Question | Position | What would change it |
|---|---|---|---|
| Q1 | Does a checkpoint of a Run in its own worktree still consult the ledger? | **No.** A worktree's diff is the Run's diff, so `decide()` should take the cap-1 path — the whole-tree diff, before the ledger. The ledger's job moves to merge-back. | evidence that a phase can write outside its worktree, which would make the diff incomplete again |
| Q2 | Where does evidence live — the Run's root or the primary tree? | **The primary tree.** Evidence must survive the worktree being removed, and `.schegent/` is the operator's durable record. The Run's root holds source edits only. | a requirement that a Run's evidence be discardable with it, which no current retention rule asks for |
| Q3 | Are untracked and ignored files carried into the worktree? | **No, and the opt-in refuses when the tree's tooling needs them.** Copying `node_modules` defeats the disk argument; symlinking it shares mutable state across Runs, which is the isolation failure wearing a different hat. | a measured install cost low enough to run per Run, or a per-repository declaration of what must be linked |
| Q4 | Is the per-Run root inside or outside the workspace? | **Outside**, under the extension's storage path. Inside means Runs see each other's roots, the file watcher sees N copies of the tree, and `.gitignore` becomes load-bearing for correctness. | a requirement that the operator open a Run's tree in the same window |
| Q5 | What does merge-back do on conflict? | **Refuse, retain, and report.** Leave the Run's worktree intact, write the patch, and tell the operator — never a partial apply and never an automatic three-way merge. | nothing foreseeable; a partial apply is unrecoverable without a checkpoint of the primary tree |
| Q6 | Does the state schema gain a per-Run root field? | **Yes, and therefore a forward-only migration** with the existing refuse-a-future-version behaviour. Deriving the root from the run id would make it unrecoverable after a crash with a changed storage path. | a decision to make the root derivable and accept that |
| Q7 | Who reaps a worktree after a host crash? | **The existing orphan path, extended.** `FR-R3-103`'s recovery already runs at activation; `git worktree list --porcelain` plus the run map is the reconciliation, and `git worktree prune` the primitive. | evidence that reaping at activation races a second host, which window primacy should already prevent |
| Q8 | Can the opt-in be raised without the boundary? | **No — the opt-in gates on the Git floor, no submodules, no LFS, and a passing provisioning probe**, and refuses with a named reason otherwise. A silent fallback to shared-tree execution under a setting called isolation is the worst failure this design has. | nothing |

## 9. The gate on implementing this — read this section first

**Opt-in isolated lane dispatch is now wired (`FR-R6-F10`, 2026-11-12); shared-tree execution remains the default.**
As of 2026-08-27 there was no worktree, sandbox, or per-Run checkout mechanism anywhere in
`repo/src/`. As of 2026-11-10 the lane engine landed (`FR-R6-F10`,
[Execution lanes](../operations/execution-lanes.md)), recording how each entry condition below was
met in `specs/309-isolated-workspace-lanes/research.md`. As of 2026-11-12, all four entry
conditions below are satisfied in code (`F09` qualification matrix, `F15` cross-root handoff
materializer, `RunCheckpointService` per-lane `sole-run` capture, and primary-workspace evidence
anchoring), and opt-in per-Run lane dispatch is wired behind `schegent.lanes.enabled` (default
`false`, `schegent.lanes.liveCap` default `1`). When `schegent.lanes.enabled` is `false` (the
shipped default), Runs execute in the shared checkout and a cap above one still shares one working
tree. When `schegent.lanes.enabled` is `true`, admission gates on `LaneService.provisionLane` and
refuses with a named `LaneRefusalReason` rather than falling back to the shared checkout.

**Historical gate rationale (2026-08-27) and remaining deferrals (2026-11-23).** The 2026-08-27
audit scoped P0-2 at a months horizon and gated implementation on the four entry conditions below
so a half-wired switch would not promise isolation before the boundary existed. All four entry
conditions are now satisfied in code for opt-in use (`schegent.lanes.enabled = true`). What remains
deferred or off by default:

- **Default posture:** `schegent.lanes.enabled` defaults to `false`; raising the queue concurrency
  cap without opting in still shares one working tree.
- **Interactive UI:** `ChangeReviewService` exposes read-only review snapshots, while lane approval,
  landing, and cleanup actions remain on the host/headless port (`src/headless/execution-lanes-api.ts`)
  rather than mutating sidebar/dashboard IPC commands.
- **ACP wire protocol:** ACP carries no lane-id field; `AcpBackedRunner` binds session `cwd` to the
  resolved lane root.
- **Retention & platform qualification:** `lane-retention.ts` bounds `lane_operations` and unreferenced
  terminal lane rows while preserving reachable `candidate` refs and recovery evidence; live Windows
  host execution remains unrun (see [Platform observation record](../operations/platform-observation-record.md)).

**Entry conditions.** All four before implementation starts:

1. Q3 is decided with a measurement, not a position — the untracked-tree question is the one that
   decides whether the feature is usable at all.
2. Q2 is decided and the twelve evidence anchors are enumerated against that decision, so the
   rewiring is a list rather than a discovery.
3. A provisioning probe exists that can answer, on the operator's machine, whether the Git floor,
   submodule state, and LFS state permit the opt-in — because the opt-in must refuse, not degrade.
4. `FR-R3-125`'s qualification matrix is filed, so the two halves of P0-2 are not designed against
   different assumptions about what a backend may reach.

**Review trigger: 2026-11-27**, or earlier on any of:

- the concurrency measurement (`docs/operations/concurrent-run-isolation-measurement.md`) being
  re-run and showing a materially worse attribution outcome than 2026-08-27's;
- an operator report of a semantic conflict or an unattributable diff under cap >1;
- any proposal to raise the default cap above one, which this record refuses until the boundary
  exists.

**The standing consequence while this is open.** A cap above one is *chosen*, not safe. It is stated
at the four surfaces a human reads — the Settings page's Queues section,
`docs/operations/multi-queue-concurrency.md`, the ratification record, and `ARCHITECTURE.md` — and
`tests/lint/concurrency-isolation-disclosure.test.ts` fails if any of those statements is removed or
if a live document starts presenting a cap above one as isolation. The manifest description, a
fifth surface when this record was written, left with the configuration key it described,
`schegent.queue.globalConcurrencyCap`, which no scheduling path read (`FR-R3-145`).

## 10. Reopening conditions for the shape itself

The shape decided in §2 returns to this record if any of these move:

- Git's worktree primitives change semantics for shared hooks or config in a way that makes a
  worktree's relationship to the primary tree unstable.
- A container runtime becomes available on a supported platform *and* the audit's objection to
  containerizing the extension host is retired — at which point contained per-Run execution may
  dominate worktrees on both isolation and reproducibility.
- The pinned local topology in `docs/architecture/local-queue-parallelism-ratification.md` widens
  (remote submission, multiple mutating principals, multiple hosts). A worktree is a working-tree
  boundary for one local operator; it answers nothing about a second principal.
- Q5's refusal turns out to be unusable in practice — an operator who can never merge back has an
  isolation mechanism that isolates their work from themselves.

## 11. What this record does not claim

- It does not claim per-Run isolation is active by default: `schegent.lanes.enabled` defaults to `false`, and shared-tree mode still shares one working tree. §9.
- It does not claim a worktree is a permission or process boundary. §7.
- It does not claim the attribution machinery was wasted. §1 and §8b Q1: it becomes what makes
  merge-back reviewable.
- It does not claim the ratified cap range was wrong, or propose narrowing it. §3.
- It does not claim the eight positions in §8b are decisions. They are the default a reader should
  assume, each with what would change it.

<!-- Source: AGENTS.md -->
<!-- Source: src/lib/path-containment.ts -->
<!-- Source: src/activation/run-safety-wiring.ts -->
<!-- Source: src/controller/workflow-controller.ts -->
<!-- Source: docs/operations/concurrent-run-isolation-measurement.md -->
