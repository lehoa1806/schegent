# GitHub Actions — Terminal Record

<!-- doc-class: record -->

**Status**: terminal. Actions are **retired by operator decision, 2026-08-26**, for budget.
**Recorded**: 2026-08-26 · **Item**: [`FR-R3-099`](../../../docs/features/round_3/DONE_99_FR-R3-099_actions_retired_by_decision.md)
**Repository at the time of capture**: `repo/` HEAD `2a885187`

## What this record is, and where its numbers come from

This is the last reading of fourteen weeks of CI signal that nothing ever consumed. It exists because
the harvest had to happen before the disable, and after the disable it would be archaeology.

**Provenance — read this before using any figure below.** These numbers come from the **live GitHub
API, queried twice on 2026-08-26 during the round-3 consolidation**, and are transcribed from that
capture as recorded in
[`FR-R3-099` §2](../../../docs/features/round_3/DONE_99_FR-R3-099_actions_retired_by_decision.md).
**No fresh API call was made when this record was written.** The environment that wrote it holds no
GitHub credential, and fabricating a second reading — or presenting a transcription as a live query —
would be the exact defect this item exists to repair, one week later and in the same direction.

What follows from that: the per-workflow **run counts, final conclusions and the SHAs named below are
from the capture**. Per-run **IDs are absent** for every workflow, because the capture did not record
them. They are marked absent rather than reconstructed. Anyone who restores API access can complete
those cells; nobody should infer them.

## The eight workflows

`https://api.github.com/repos/lehoa1806/schegent/actions/runs` → `total_count: 185`.

| Workflow | Runs | Final conclusion | SHA of last observed run | Run ID | Notes |
|---|---|---|---|---|---|
| `full-gate.yml` | 14 | **failure** | `b6993e80` (2026-08-24) | *absent — not captured* | Weekly for 14 weeks, **all 14 red**. Last run 7 of 10 jobs green; reds in unit-under-load, visual, soak |
| `ci.yml` | 9 | **failure** | `2a885187` (2026-08-26) — the then-current HEAD | *absent* | **Windows leg failed**; the other legs were fail-fast-cancelled |
| `codeql.yml` | 24 | **success** | `2a885187` (2026-08-26) | *absent* | Green at HEAD. This is the control with **no local substitute** |
| `security-audit.yml` | 14 | **success** | `b6993e80` (2026-08-24) | *absent* | Last pass is a dated fact, not a live control |
| `backend-canary.yml` | 1 | **success** | — (2026-08-26) | *absent* | Ran **green on the same day its own file header said "AND THIS WORKFLOW DOES NOT RUN"** |
| `dependency-review.yml` | 3 | failure | — (2026-08-23) | *absent* | Reduces to `npm audit`, already local |
| `pr.yml` | 3 | failure (dependabot) | — (2026-08-23) | *absent* | |
| `release.yml` | 0 | **never ran** | — | n/a | No `v*` tag was ever pushed |

Runs existed **at the then-current HEAD**, which falsifies the standing premise that this work is
unpushed. The remote held this history and had been running gates against it. Whether the
mirror-ignoring was deliberate or never noticed cannot be determined from the tree. What can be
determined, and is the finding: **no record anywhere consumed any of these results.**

## Reconciliation — what the red legs say about local claims

`FR-R3-092` §3's rule: a local "verified" that a red remote leg contradicts is a finding against the
item that claimed it. Both candidates are dispositioned here rather than noted.

### The 14 red full-gate runs versus `FR-R3-097`'s does-not-reproduce closure

**Reading taken: the closure stands, and is now qualified rather than reopened.**

`FR-R3-097` closed a flake investigation by measuring locally and finding the failures did not
reproduce. The remote reds land in exactly the three jobs that work predicted would be
load-sensitive — unit-under-load, visual, soak — which is corroboration of its *diagnosis*, not
refutation of its *closure*.

Why the closure is not reopened: the remote reds are on **shared GitHub runners**, which are weaker
and noisier than the machine the local measurement used, and `FR-R3-097`'s whole finding is that these
three suites are sensitive to machine load. A red on a busier machine is the predicted behaviour, not
a new defect. What the closure may **not** claim any more is that the failures do not occur — they
occurred, fourteen times, on hardware this project does not control.

The honest residual, recorded here rather than in a closure that would have to be reopened to hold
it: **this project has never observed those three suites green on hardware it does not own, and after
this retirement it has no way to.** That is a limit of the verification envelope, and it is stated in
the posture record.

### The red Windows `ci.yml` leg versus every Windows-path claim

**Reading taken: this is live evidence, and it is handed to the boundary that owns it.**

`FR-R3-083` and spec 154 own the Windows portability boundary, and they were written from
*reasoning* about `detached`, job objects and `taskkill /T` — not from an observation of Windows
failing. The red leg at HEAD is that observation. It is not this record's to diagnose, and this
record does not diagnose it: the failing job's logs are on a remote whose Actions are now retired, so
the *cause* is unrecovered and is stated as unrecovered.

Every local claim it bears on, named:

- **Windows portability generally** — `FR-R3-083`'s stated permanent limit was already "Windows is
  not verified here". The red leg upgrades that from *unverified* to *observed failing at least once
  at `2a885187`*, cause unknown. Recorded, not resolved.
- **The three-OS matrix as a pending future** — every record that treated the matrix as something
  this project might one day read is now wrong in the other direction: it ran, it was red on Windows,
  and it will not run again.
- **`detached: process.platform !== 'win32'`** — the platform branch is not implicated by any evidence
  here; the leg's failure is unattributed. Naming it would be the same unfounded inference this item
  repairs.

## What is lost, permanently, with no local substitute

| Control | After the retirement |
|---|---|
| **CodeQL static analysis** | **Gone.** Last ran green at `2a885187`, 2026-08-26. There is no local equivalent in this repository. Recorded in `SECURITY.md` |
| Dependency review | Reduces to `npm audit`, which is already local and already in the chain |
| Three-OS matrix | **Gone.** Single-platform verification becomes a permanent stated limit, not a pending state |
| Node version-floor job | **Gone.** No local substitute; the floor is now declared and unverified |
| Scheduled `security-audit` | **Gone as a schedule.** Its last pass is the dated fact above |
| Scheduled `backend-canary` | **Gone as a schedule.** The local cadence that replaces it is [`FR-R3-104`](../../../docs/features/round_3/DONE_104_FR-R3-104_backend_qualification_that_gates.md) |

## Still owed to the operator — the half the tree cannot do

**Two things are owed, and the second was discovered on 2026-08-27 by checking the remote instead of
reasoning about it.**

### What is verified, as of 2026-08-27

Observed with `git ls-remote` over the configured SSH remote — a read-only query, no API credential
involved:

| Fact | Value | Checked |
|---|---|---|
| Default branch (`HEAD` symref) | `refs/heads/develop` | 2026-08-27 |
| Workflow files on `refs/heads/develop` | **none** | 2026-08-27 |
| Workflow files on `refs/heads/master` | **none** — seven deleted by `ce6cb180` | 2026-08-27, after the fast-forward |
| Workflow files on `refs/heads/retire-actions-on-master` | **none** | 2026-08-27 |
| Workflow files at `refs/tags/v0.1.0` | **six** — see the note below | 2026-08-27 |

**No branch on the remote carries a workflow file.** That row is the load-bearing one, and it is an
observation: `git ls-tree` against each fetched ref, counted.

**What follows from it is reasoning, and is labelled as reasoning.** GitHub resolves a trigger's
workflow files from a ref — `schedule` from the default branch, `push` and `pull_request` from the
ref involved, `workflow_dispatch` from the default branch. That is GitHub's **documented behaviour,
relied on here and not verified here**: this checkout holds no API credential, so the Actions API
cannot be queried and no run list can be read. The conclusion *"nothing can run"* is therefore an
inference from a documented mechanism over an observed state, not a report of an empty run list.

**The same distinction applies to the two pushes below.** What was observed is that the pushed
commits carry no workflow files. That neither push *started a run* is inferred, not seen — for the
same reason. Saying so matters here more than most places: this record exists because `FR-R3-099`
found 185 runs that every document in the tree said were not happening, and the failure was
reasoning about the remote instead of querying it. The reasoning below is sound and it is still
reasoning.

**The one query that would settle it** is `GET /repos/lehoa1806/schegent/actions/runs`, which needs a
token. It is listed as step 3 of the settings flip precisely so the operator, who can run it, closes
the loop.

**The `v0.1.0` tag still carries six of them, and it is inert** — on the same documented mechanism. A
tag triggers a workflow only when the tag is *pushed*; that tag already exists, re-pushing an
existing tag is a no-op, and a new tag would be cut from a branch that has none. So the files at
that tag are historical content with no path to execution, and they are left alone deliberately:
rewriting a published tag to tidy a file that cannot run would be worse than the residual. It is the
clearest remaining argument for the settings flip below, which closes the class rather than the
instances.

### 1. The `master` residual — CLOSED 2026-08-27

The deletion had landed on `develop` and never reached `master`, which carried seven workflow files
with `push`, `pull_request` and `schedule` triggers. Their schedules were inert — not the default
branch — but a push to `master`, or a pull request targeting it, would have run them and billed for
them. `FR-R3-099` said the tree must own the deletion; it owned it on one branch for a day.

`ce6cb180` deletes `.github/workflows/` and nothing else. It was committed on
`retire-actions-on-master`, a direct descendant of `master`, pushed, and then fast-forwarded onto
`master` with the operator's approval:

```bash
git push origin retire-actions-on-master               # branch, triggered nothing
git push origin retire-actions-on-master:master        # fast-forward, triggered nothing
```

Neither push is believed to have triggered a run, on the mechanism above — the pushed commits carry
no workflow files. **Believed, not observed**: reading the run list needs the API credential this
checkout does not hold.

**Recorded because the sequence matters.** The branch push was permitted by this environment's
outward-action guardrail; the `master` update was refused, and went through only after the operator
approved it explicitly. That is the same line `FR-R3-099` drew for the settings flip — outward
mutations are the operator's — enforced by tooling rather than by judgement, and then lifted by the
operator rather than worked around.

### 2. Repository settings (outward, the operator's)

**Repository settings are not changed**, and cannot be from here: this checkout holds an SSH key that
can push, and **no API credential and no `gh` CLI**, which is what flipping a setting needs. The
distinction matters — an earlier version of this note said only "no credential", which reads as "the
remote is unreachable", and it is not.

1. Open `https://github.com/lehoa1806/schegent/settings/actions`.
2. Under **Actions permissions**, select **Disable actions**.
3. Save, and confirm `https://api.github.com/repos/lehoa1806/schegent/actions/runs` records no run
   dated after the disable.

This is now the **only** outstanding step, and it is belt-and-braces rather than the thing standing
between the operator and a bill: no branch on the remote carries a workflow file, so nothing can
run. What the setting closes is the **class** — a file restored on any branch by any means, and the
six files still sitting at the `v0.1.0` tag — which no amount of deleting can, because deletion
addresses instances and the setting addresses the capability.

This repository does not claim the setting is flipped.

## What was not rewritten

No run history was deleted and no history was rewritten. The remote run history is the only evidence
this record cites, and it must stay resolvable. A disable does not remove it.
