# Platform observation record

**Cycle platform: macOS (darwin, arm64). Node ^22 || ^24. 2026-08-25.**

Some of this product's safety properties are platform-specific, and some of the
fixtures that would establish them cannot run on the machine that wrote them. This
page says which is which.

It exists because the alternative is worse than a gap: `FR-R3-054` and `FR-R3-083`
each owe a Windows acceptance half, and reporting an untested platform as supported
is the failure both were explicitly careful to avoid. A skipped fixture that nobody
records reads, six months later, exactly like a passing one.

## How to read the observation classes

| Class | What it means |
|---|---|
| **Observed here** | The fixture ran on this cycle's platform and its result is real evidence. |
| **Unrun here** | The fixture exists and is written to run unedited on the platform it targets. It has not run on that platform. The acceptance half is **unmet**, not met. |
| **Asserted by unit table only** | The condition cannot be produced on any filesystem available to this project, so the classification is exercised by handing the observation in directly. The code path is covered; the real-world behaviour is not measured. This is a **weaker claim** and is recorded as one. |

There is no fourth class, and in particular there is no "expected to pass". A row whose
parenthetical says *by injection* is **Asserted by unit table only** — that phrase in an
*Observed here* row is a misfiled row, not a shade of meaning.

## The record

| Acceptance half | Owner | Fixture | Class |
|---|---|---|---|
| A descendant keeps writing after the direct child is SIGKILLed (the defect, demonstrated) | `FR-R3-054` §2 | `tests/unit/runner/process-tree.test.ts` | **Observed here** |
| Cancellation reaches the whole process group; the sentinel stops advancing | `FR-R3-054` §3 | `tests/unit/runner/process-tree.test.ts` | **Observed here** (POSIX) |
| The same, on Windows, through `taskkill /T` | `FR-R3-054` §5 | `tests/unit/platform/windows-sentinel.test.ts` | **Unrun here** |
| A symlink at any component of a safe-open walk is refused | `FR-R3-053` | `tests/unit/lib/safe-open*.test.ts` | **Observed here** |
| A reparse point at the Windows leaf is refused | `FR-R3-083` §3 | `tests/unit/platform/windows-reparse.test.ts` | **Unrun here** |
| The reparse classification itself (platform-independent) | `FR-R3-083` §3 | `tests/unit/lib/safe-open-reparse.test.ts` | **Observed here** |
| A mount that refuses exclusive creation is reported `unsupported` | `FR-R3-083` §4 | `tests/unit/state/mount-capability.test.ts` | **Asserted by unit table only** |
| A mount that permits a **second** exclusive create is reported `unsupported` | `FR-R3-083` §4 | `tests/unit/state/mount-capability.test.ts` | **Asserted by unit table only** |
| A read-only workspace is classified apart from a broken mount | `FR-R3-083` §4 | `tests/unit/state/mount-capability.test.ts` | **Asserted by unit table only** |
| The probe answers `undetermined` within its bound against a create that never settles | `FR-R3-083` §4 | `tests/unit/state/mount-capability-probe.test.ts` | **Observed here** |
| The escalation ladder reports a group that survives SIGKILL | `FR-R3-054` §5 | `tests/unit/runner/tree-escalation.test.ts` | **Asserted by unit table only** — a genuinely unkillable process group is not producible on demand, so the ladder's decisions are driven against a child double with a stubbed probe. What is established is which decision it reaches, not that it has ever reached it against a real survivor. |
| That report reaches the audit record | `FR-R3-054` §5 | `tests/unit/controller/process-tree-degradation.test.ts`, `tests/lint/tree-degradation-emission-funnel.test.ts` | **Observed here** — the recorder runs against a real append, and the wiring between the runner's hook and the audit writer is gated. |
| The same, on Windows | `FR-R3-054` §5 | — | **Not implemented, deliberately.** There is no group to probe, so the only available check answers for the direct child — and a recycled pid inside the confirmation window would file an entry against a Run whose tree had died. The runtime-log warning is what Windows has. See [Backend operations](backends.md) step 6. |

## Route taken — 2026-08-27

**Decision: rows 1-3 are declined, dated, and the declared support surface narrows
to match. No measurement was obtained, and none is expected under current
constraints.**

`FR-R3-115` offered four routes and required one to be chosen on the record. Three
of them are **unavailable**, which is a different statement from unattractive, and
each reason is observed rather than assumed:

| Route | Status | Why |
|---|---|---|
| **A** — a Windows and a Linux contributor each run `npm run test:host` | Unavailable | This is a single-operator project. `.github/CODEOWNERS` names one person, and `FR-R3-115` row 5 makes that fact the premise of a different finding in the same item. There is no contributor to ask. |
| **B** — a local container or VM on the operator's machine | Unavailable | **Observed 2026-08-27**: `docker`, `podman`, `colima`, `lima` and `orbstack` are all absent from this machine, and no container daemon is running. Route B was the cheapest route to closing row 3 and it is not open. |
| **C** — a public-repository free tier | Not a verification decision | It is a repository-visibility decision, as the item says itself. Recorded, not taken here. |
| **D** — decline explicitly and permanently | **Taken, in part** | See below. |

### D was taken in halves, because its two halves are not the same proposal

`FR-R3-115` T1409 phrases D as *decline, and delete the four `win32` branches or gate
them behind an unsupported-platform refusal*. Those are two separable claims and only
one of them is right.

**The honesty half is taken.** The tree stops implying verified support for a
platform on which it has never executed. See the support-surface change below.

**The deletion half is refused, and this is the substantive decision.** `taskkill /T`
is the only process-tree termination Windows has. Deleting it does not remove an
unverified branch; it removes the *mitigation* and leaves the unverified path as a
bare `kill(pid)` that reaches no descendant. The exposure row 1 describes — a
cancelled Run whose descendants keep writing to the operator's checkout — would
become **certain** rather than unmeasured. Deleting untested safety code because it
is untested inverts the finding.

**The runtime-refusal variant is also refused**, for a narrower reason: a refusal on
startup asserts that Schegent is *broken* on Windows. The evidence says *unmeasured*.
Shipping a stronger negative claim than the evidence supports is the same error as
shipping a stronger positive one, and this round has spent itself removing the
positive version.

`FR-R3-115` §3 sets the standard this has to meet — *"Shipping a platform with no
evidence and shipping no platform are both honest; only the first-without-saying-so
is not."* A kept branch with a declared `unverified` tier is the first, with the
saying-so.

### Review date and trigger

<!-- decline-review-date: 2026-11-27 -->

**This decline is reviewed on or before 2026-11-27**, and
`repo/tests/lint/dated-review-records.test.ts` fails on that day until someone re-reads it.
`FR-R3-129` added both, for the reason the item states: *a dated decline is only honest while someone
re-reads it.* Without a date and a check, the three conditions below expire quietly and a temporary
decline becomes a permanent posture by nobody deciding.

**What the check can and cannot see.** It reads the date above. It cannot notice that a Windows
machine appeared, that a container runtime was installed, or that a contributor ran the suite — those
are facts about the world, and no gate in a repository sees them. Those stay the operator's to watch,
and they are the reason the date is a *ceiling* rather than a schedule: any one of them arriving
reopens this before 2026-11-27.

**When the date arrives**, one of two things happens and both are edits to this file: a route became
available and the decline is **retired**, or nothing changed and the decline is **re-dated** with a
sentence recording what was re-read. Deleting the marker to make the gate pass is the one response
that is not available — it converts the decline into the permanent posture this date exists to
prevent.

### What would change this

Any one of these, and this heading is rewritten rather than amended:

- A Windows machine or VM becomes available to the operator (closes rows 1 and 2).
- A container runtime is installed (closes row 3; **not** row 1 — process-group
  semantics are the thing under test and a Linux container cannot answer for them).
- A contributor on either platform runs `npm run test:host` unedited and reports what
  they saw, pass or fail. Both fixtures are written to need no edit, so this costs
  them one command.

### Rows 1-3 under this decision

Their **evidence class is unchanged** — they remain *Unrun here*, because no
measurement was taken and reclassifying them would be the exact conflation this page
exists to prevent. What changes is that their status is now a **dated decision**
rather than an open intention:

| Row | Class | Disposition |
|---|---|---|
| Windows process-tree termination via `taskkill /T` | **Unrun here** | Declined 2026-08-27. Branch kept. |
| Windows reparse-point refusal at a safe-open leaf | **Unrun here** | Declined 2026-08-27. Branch kept. |
| Linux path case-sensitivity in `output-target-identity.ts:40` | **Unrun here** | Declined 2026-08-27. Route B was the way in and is unavailable. |

**Observed / relied on / inferred**, kept apart as `FR-R3-099` had to learn to do:
*observed* — the five container runtimes are absent, and the fixtures skip with their
platform named; *relied on* — that `taskkill /T` is Windows' process-tree mechanism
and that a container does not reproduce Windows process-group semantics; *inferred* —
that rows 1-3 will stay unmeasured until one of the conditions above changes. Nothing
here is an observation of Windows or Linux behaviour, because none was made.

## The declared support surface

This table **is** the support claim. Any other document that names a platform defers
to it, and `tests/lint/platform-branch-has-record-row.test.ts` refuses a
`process.platform` comparison in `src/` naming a platform that is not here.

| Platform | Tier | Evidence |
|---|---|---|
| **macOS** (darwin, arm64) | **Verified** | The full host suite runs here every cycle. This record's header names the date and the platform. |
| **Linux** | **Unverified** | Ships, and is branched for (`src/lib/output-target-identity.ts:40`). Has never executed here. Route B unavailable — see *Route taken*. |
| **Windows** (win32) | **Unverified** | Ships, and is branched for in four production files, two of them safety paths. Has never executed here. Both fixtures are *Unrun here*. |

**"Unverified" is a claim about evidence, not about quality.** It does not say the
platform is broken, and it does not say it works. It says nobody has run it and this
project will not pretend otherwise. A defect on an unverified platform is not a
regression against a promise, because no promise was made.

## What this record does not claim

- **No NFS, SMB, 9p or virtiofs mount was used.** `FR-R3-083` §4 allows the
  mount-capability acceptance to be discharged by injection when no such mount is
  available to the author, provided the weaker claim is stated. It is stated: the
  three mount rows above are classification coverage, not field evidence. What has
  been established is that the probe reaches a verdict and cleans up after itself
  on every path; what has not is how a particular remote filesystem behaves.

### Filesystem classes, each with a verdict (`FR-R3-129` T1493, 2026-08-27)

The audit of 2026-08-27 listed seven filesystem classes among its unresolved unknowns. Four were
already named above; **three were named nowhere**, and they are the three most likely to be true of a
real operator's machine. `FR-R3-129` extends the **declaration** rather than the test matrix — the
item's own instruction, and the right one: a matrix row that claims a class nobody can run is worse
than a declaration that excludes it.

| Class | Verdict | Basis |
|---|---|---|
| **NFS** | Inside the boundary, **classification-tested only** | The mount-capability probe reaches a verdict and cleans up; how NFS behaves is unobserved. |
| **SMB** | Inside the boundary, **classification-tested only** | As NFS. |
| **9p** | Inside the boundary, **classification-tested only** | As NFS. Relevant to WSL2, which is also `Unverified`. |
| **virtiofs** | Inside the boundary, **classification-tested only** | As NFS. |
| **Cloud-sync** (Dropbox, iCloud Drive, OneDrive, Google Drive) | **Explicitly outside the boundary** | Not a mount class the probe can classify. These filesystems reorder, delay and duplicate writes to satisfy a sync protocol, and two of this product's guarantees rest on write ordering an operator can reason about: the append-only audit chain (`FR-R3-112`) and the ownership lease's heartbeat (`FR-R3-070`). A synchroniser that resurrects a deleted lease file or reorders two audit appends breaks both, and no amount of probing at startup detects a behaviour that happens later. **Do not place a workspace inside a cloud-synced directory.** This is a declaration, not a refusal: nothing enforces it, and `FR-R3-129` did not add enforcement because a heuristic that guessed wrong would refuse legitimate workspaces. |
| **Endpoint-security / anti-malware filtered** | **Inside the boundary, with a stated failure mode** | These filters hold or deny opens on files a scanner is inspecting. The safe-open layer (`FR-R3-053`) refuses rather than retries on an unexpected errno, so the observable outcome is a refused operation with a reason — not a corrupted one. That is the correct behaviour and it is also a real source of spurious refusals, which an operator seeing one should suspect. Unobserved here. |
| **Quota-constrained** | **Inside the boundary, with a stated failure mode** | `ENOSPC`/`EDQUOT` on an evidence write is handled as a snapshot or sink failure, and the retention sweeps bound growth (`FR-R3-012`, `FR-R3-050`). What is **not** claimed is graceful degradation under a quota reached mid-Run: the Run fails at the write, which is visible, and no test exercises it. |

**What this table is.** A declaration of where the support boundary sits, class by class, so that
"unknown" is replaced by a verdict a reader can act on. **What it is not**: field evidence for any
row. Four rows say classification-only, two say inside-with-a-failure-mode, and one says outside — and
none of the seven has been observed on this host.
- **No Windows checkout ran this suite.** Both Windows rows are unrun. They are
  written to run without edits — `tests/unit/platform/` is inside the configured
  test globs, and both fixtures skip with the platform named in the skip reason —
  so a Windows contributor produces the missing evidence by running `npm run
  test:host` and reporting what they see, whether it passes or fails.

## When to update this page

Whenever a row's class changes: a fixture runs on the platform it targets, a real
mount becomes available, or a new acceptance half acquires a platform dependency.
A row whose class has silently stopped being true is the specific failure this page
was written to prevent, so a change of platform is a change to this file.

## Related

- [Native binding decision](../architecture/native-binding-decision.md) — why the
  Windows halves are what they are, and why they are not going to be closed by a
  native call.
- [Backend operations](backends.md) — step 6, the operator-facing statement of the
  process-tree limit.
- [Workspace ownership fencing](../architecture/workspace-ownership-fencing.md) —
  the mount limit the probe now looks for.
