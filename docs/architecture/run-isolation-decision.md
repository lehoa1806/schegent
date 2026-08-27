# Per-Run execution isolation — the shape, and the gate on building it

Status: **Accepted (shape). Implementation gated — see §9.**
Date: 2026-08-27 · Item: `FR-R3-124` · Spec: `specs/160-run-isolation-boundary`
Supersedes nothing. Narrows nothing already ratified.

Decision: when Schegent gains per-Run execution isolation, the shape is a **per-Run Git worktree**
provisioned and destroyed by the extension host, opt-in, with an explicit attributable merge-back
step. Per-Run clone, copy-based isolation, and contained-backend-only were considered and rejected;
§3 gives the reason for each.

This record does **not** ship that mechanism. It decides the shape, lifts the project rule that
forbade it, states the seams and open questions the implementation inherits, and puts a dated gate
and review trigger on starting it. §9 is the operative section for anyone asking "is this built?" —
the answer is no.

<!-- Source: docs/architecture/local-queue-parallelism-ratification.md -->
<!-- Source: src/services/run-checkpoint-service.ts -->
<!-- Source: src/services/run-mutation-ledger.ts -->

## 1. The question, and why it is being answered now

`schegent.queue.globalConcurrencyCap` defaults to `1` and admits up to `20`. Above one, independent
Runs execute in the same checkout. The repository audit of 2026-08-27 made this its second top
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
- **Hooks.** Hooks live in `.git/hooks` and are shared, so a hook fires in a worktree as it does in
  the primary tree, with `$GIT_DIR` pointing at the worktree's administrative directory and
  `core.hooksPath` unchanged. A hook written on the assumption that the working tree is the primary
  one — one that reads a path relative to the repository root, or writes to a fixed location — will
  behave differently. The mechanism does not disable hooks and does not audit them; it must state
  this to the operator, because a repository's hooks are the operator's, not Schegent's.
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

**Nothing in §2–§8 is built.** As of 2026-08-27 there is no worktree, sandbox, or per-Run checkout
mechanism anywhere in `repo/src/`; the word `worktree` appears 15 times across 9 files under
`src/`, every one of them a comment explaining its absence. `FR-R3-124`'s T1465 (the boundary) and T1466 (rewiring checkpoints, the
ledger and evidence onto it) are **open**.

**Why gated rather than built.** The audit scopes recommendation P0-2 at a **months** horizon. The
item's own sequencing note says both P0 items *"begin with a decision record … that scopes everything
after it"*, and its own T1467 is worded *"Until T1465 ships"* — the ordering was anticipated when the
item was filed. §8a is why: the work is a per-Run cwd resolution, a state-schema migration, a
decision about twelve evidence anchors, a merge-back conflict policy, an orphan-reaping path, and a
fence consequence. A half-wired boundary behind a default-off switch is worse than a written gate,
because the switch is reachable and its name promises isolation.

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
at the five surfaces a human reads — the manifest description, the Queue settings dialog,
`docs/operations/multi-queue-concurrency.md`, the ratification record, and `ARCHITECTURE.md` — and
`tests/lint/concurrency-isolation-disclosure.test.ts` fails if any of those statements is removed or
if a live document starts presenting a cap above one as isolation.

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

- It does not claim per-Run isolation exists. §9.
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
