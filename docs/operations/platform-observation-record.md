# Platform observation record

**Cycle platform: macOS (darwin, arm64). Node ^22 || ^24. 2026-08-25.** Since 2026-11-12 the same
machine also runs a Linux container (aarch64, OrbStack); a row observed there names it.

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
| **Observed here** | The fixture ran on this machine, on the cycle's platform or on the platform the row names, and its result is real evidence. |
| **Unrun here** | The fixture exists and is written to run unedited on the platform it targets. It has not run on that platform. The acceptance half is **unmet**, not met. |
| **Asserted by unit table only** | The condition cannot be produced on any filesystem available to this project, so the classification is exercised by handing the observation in directly. The code path is covered; the real-world behaviour is not measured. This is a **weaker claim** and is recorded as one. |

There is no fourth class, and in particular there is no "expected to pass". A row whose
parenthetical says *by injection* is **Asserted by unit table only** — that phrase in an
*Observed here* row is a misfiled row, not a shade of meaning.

## The record

| Acceptance half | Owner | Fixture | Class |
|---|---|---|---|
| A descendant keeps writing after the direct child is SIGKILLed (the defect, demonstrated) | `FR-R3-054` §2 | `tests/unit/runner/process-tree.test.ts` | **Observed here** |
| Cancellation reaches the whole process group; the sentinel stops advancing | `FR-R3-054` §3 | `tests/unit/runner/process-tree.test.ts` | **Observed here** (POSIX: on macOS, and on Linux in the local leg at `18f9beea`, 4 of 4) |
| The same, on Windows, through `taskkill /T` | `FR-R3-054` §5 | `tests/unit/platform/windows-sentinel.test.ts` | **Unrun here** |
| A symlink at any component of a safe-open walk is refused | `FR-R3-053` | `tests/unit/lib/safe-open*.test.ts` | **Observed here** |
| A reparse point at the Windows leaf is refused | `FR-R3-083` §3 | `tests/unit/platform/windows-reparse.test.ts` | **Unrun here** |
| The reparse classification itself (platform-independent) | `FR-R3-083` §3 | `tests/unit/lib/safe-open-reparse.test.ts` | **Observed here** |
| Two names differing only by case stay two output identities on Linux (row 3 below) | `FR-R3-115`, review gap GC-18 | `tests/unit/platform/linux-case-sensitivity.test.ts` | **Observed here**, in the local Linux leg on 2026-11-12. On macOS it skips with its platform named. |
| A mount that refuses exclusive creation is reported `unsupported` | `FR-R3-083` §4 | `tests/unit/state/mount-capability.test.ts` | **Asserted by unit table only** |
| A mount that permits a **second** exclusive create is reported `unsupported` | `FR-R3-083` §4 | `tests/unit/state/mount-capability.test.ts` | **Asserted by unit table only** |
| A read-only workspace is classified apart from a broken mount | `FR-R3-083` §4 | `tests/unit/state/mount-capability.test.ts` | **Asserted by unit table only** |
| The probe answers `undetermined` within its bound against a create that never settles | `FR-R3-083` §4 | `tests/unit/state/mount-capability-probe.test.ts` | **Observed here** |
| The escalation ladder reports a group that survives SIGKILL | `FR-R3-054` §5 | `tests/unit/runner/tree-escalation.test.ts` | **Asserted by unit table only** — a genuinely unkillable process group is not producible on demand, so the ladder's decisions are driven against a child double with a stubbed probe. What is established is which decision it reaches, not that it has ever reached it against a real survivor. |
| That report reaches the audit record | `FR-R3-054` §5 | `tests/unit/controller/process-tree-degradation.test.ts`, `tests/lint/tree-degradation-emission-funnel.test.ts` | **Observed here** — the recorder runs against a real append, and the wiring between the runner's hook and the audit writer is gated. |
| The same, on Windows | `FR-R3-054` §5 | — | **Not implemented, deliberately.** There is no group to probe, so the only available check answers for the direct child — and a recycled pid inside the confirmation window would file an entry against a Run whose tree had died. The runtime-log warning is what Windows has. See [Backend operations](backends.md) step 6. |
| Real offline CLI output for DNS refusal, connection reset, timeout, proxy failure, auth failure and provider overload, per supported CLI — **Q2**. Dated 2026-10-28. Prerequisite: an isolated network namespace or VM, never the operator's host, and no paid request | `FR-R4-F02` (FR-026) | — | **Unrun here** |
| The natural frequency of host grace termination after a terminal result — **Q3**. Dated 2026-10-28. Prerequisite: metadata-only counts from real runs, never a transcript | `FR-R4-F02` (FR-016) | — | **Unrun here** |
| `/status` at the qualified CLI version, healthy, exhausted and unreachable, and whether a structured discriminator exists — **Q1**. Dated 2026-10-28. Prerequisite: a consenting account in each state, with the capture redacted of credentials | `FR-R4-F02` (FR-022) | — | **Unrun here** |
| The credit watchdog reads a `/status` answer as recovered only from the bounded exact grammar, and negated, quoted or structured text never recovers | `FR-R4-F02` (FR-017, FR-018, FR-019) | `tests/unit/parser/credit-status.test.ts` | **Asserted by unit table only** — the fixtures are synthetic text written without a real capture. What is established is how that text is classified, not that a real CLI prints it (Q1). |
| The predicted offline failures and the stale-credit-then-network-failure case run the real path and match `retry-contract.md` | `FR-R4-F02` (FR-023, FR-024) | `tests/integration/offline-retry-path.test.ts` over `tests/fixtures/offline-cli-stub.mjs` | **Asserted by unit table only** — the child is a stub that prints what the source predicts. What is established is how that shape is classified, retried and capped, not that a real CLI prints it (Q2). |
| Host grace termination after a result is classified on lifecycle facts, and a quoted event or incidental `429` is not a rate limit | `FR-R4-F02` (FR-012, FR-014, FR-016) | `tests/integration/grace-termination-rate-limit.test.ts` over `tests/fixtures/grace-termination-stub.mjs` | **Asserted by unit table only** — the child is a synthetic lifecycle fixture. What is established is the classification after a real SIGTERM and SIGKILL, not how often a real CLI is grace-terminated (Q3). |

## Route taken — 2026-10-22

**Decision: rows 1-3 are declined, dated, and the declared support surface narrows
to match. No measurement was obtained, and none is expected under current
constraints.**

**Amended 2026-11-12: Route B was taken for row 3.** The unit tier ran in a Linux container on this
machine, row 3 is now observed, and rows 1 and 2 are unchanged. See
[Local Linux leg 2026-11-12](#local-linux-leg-2026-11-12).

`FR-R3-115` offered four routes and required one to be chosen on the record. Only
Route A is **unavailable**, which is a different statement from unattractive, and
its reason is observed rather than assumed. Route B was available and was taken on 2026-11-12 for the
unit tier, Route C is not a verification decision, and Route D is taken in part:

| Route | Status | Why |
|---|---|---|
| **A** — a Windows and a Linux contributor each run `npm run test:host` | Unavailable | This is a single-operator project. `.github/CODEOWNERS` names one person, and `FR-R3-115` row 5 makes that fact the premise of a different finding in the same item. There is no contributor to ask. |
| **B** — a local container or VM on the operator's machine | **Taken 2026-11-12, for the unit tier** | The operator asked for verification to run locally instead of on hosted CI, and `npm run verify:linux` now runs the unit tier in a Linux container under OrbStack 2.2.5. See [Local Linux leg 2026-11-12](#local-linux-leg-2026-11-12). It closes row 3 and nothing else. **Superseded:** on 2026-10-22 OrbStack 2.2.3 was installed and the route was available but not taken, because the unattended cycle that wrote this record was not authorised to provision a Linux machine; on 2026-08-27 `docker`, `podman`, `colima`, `lima` and `orbstack` were all absent from this machine, and no container daemon was running. |
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
re-reads it.* Without a date and a check, the conditions below expire quietly and a temporary
decline becomes a permanent posture by nobody deciding.

**What the check can and cannot see.** It reads the date above. It cannot notice that a Windows
machine appeared or that a contributor ran the suite on one — those
are facts about the world, and no gate in a repository sees them. Those stay the operator's to watch,
and they are the reason the date is a *ceiling* rather than a schedule: any one of them arriving
reopens this before 2026-11-27.

**When the date arrives**, one of two things happens and both are edits to this file: a route became
available and the decline is **retired**, or nothing changed and the decline is **re-dated** with a
sentence recording what was re-read. Deleting the marker to make the gate pass is the one response
that is not available — it converts the decline into the permanent posture this date exists to
prevent.

### Review 2026-11-06

Feature 282 (`FR-R5-F21`) re-read this decline ahead of its date.

- **Evidence checked**: every commit since the date was written on 2026-08-28 (`9789b49e`) to this
  page and to the [qualification matrix](../release/qualification-matrix.md): seven, which change
  wording, the release-candidate record and the shape of the matrix. All four Linux and Windows cells
  of the matrix still read `unobserved`. A wider search of `tests/integration` finds no run on
  another platform either.
- **Still owed**: a `npm run test:host` run on Windows and one on Linux, each by a person, by any of
  the routes under "What would change this". The owner is the operator, who is the maintainer.
- **The date stands at 2026-11-27.** No route below has arrived, and closing this decline needs an
  observation that nobody has made, so the review cannot renew the date. The 2026-11-06 floor run
  under Node 22 was on macOS and changes nothing here.

### What would change this

**Rewritten 2026-11-12**, because one of its three conditions arrived: a container runtime on the
operator's machine (OrbStack 2.2.5), in which `npm run test:host` ran unedited in a Linux container, and its result is recorded under
[Local Linux leg 2026-11-12](#local-linux-leg-2026-11-12). That closed row 3. What remains is
Windows only, and any one of these rewrites this heading again:

- A Windows machine or VM becomes available to the operator (closes rows 1 and 2).
- A contributor on Windows runs `npm run test:host` unedited and reports what they saw, pass or
  fail. Both fixtures are written to need no edit, so this costs them one command.

A Linux container cannot stand in for either: process-group and reparse-point semantics are the
things under test, and only Windows has them. Moving Linux itself out of the `unverified` tier is a
separate question with a higher bar, set out in the support surface below.

### Rows 1-3 under this decision

Rows 1 and 2 keep their **evidence class** — they remain *Unrun here*, because no
measurement was taken and reclassifying them would be the exact conflation this page
exists to prevent. What changes is that their status is now a **dated decision**
rather than an open intention. Row 3 changed class on 2026-11-12 because a measurement was
taken, not because the decision was revisited:

| Row | Class | Disposition |
|---|---|---|
| Windows process-tree termination via `taskkill /T` | **Unrun here** | Declined 2026-08-27. Branch kept. |
| Windows reparse-point refusal at a safe-open leaf | **Unrun here** | Declined 2026-08-27. Branch kept. |
| Linux path case-sensitivity in `output-target-identity.ts:40` | **Observed here**, in the Linux leg | Declined 2026-08-27; **closed 2026-11-12** by Route B. `tests/unit/platform/linux-case-sensitivity.test.ts` ran on Linux, see [Local Linux leg 2026-11-12](#local-linux-leg-2026-11-12). |

**Observed / relied on / inferred**, kept apart as `FR-R3-099` had to learn to do:
*observed* — on 2026-11-12 the unit tier ran in a Linux container on this machine, and row 3's
fixture passed there and failed against a mutant that folds case; the Windows fixtures skip with their
platform named (recorded 2026-08-27, not re-run on Windows); *relied on* — that `taskkill /T` is
Windows' process-tree mechanism, that a container does not reproduce Windows process-group semantics,
and that the container's own filesystem behaves as a desktop Linux one does for case; *inferred* —
that rows 1 and 2 will stay unmeasured until one of the conditions above changes. Nothing here is an
observation of Windows behaviour, because none was made.

## Local Linux leg 2026-11-12

Review gap GC-18; Route B above. The operator chose local verification over hosted CI, so
`FR-R3-099` stands, and an agent session working at their request built the leg and ran it on this
machine. What follows was observed by that session, not by the operator in person.

**What runs.** `npm run verify:linux` (`scripts/linux-leg.sh`) builds `schegent-linux-leg:node-24.19.0`
from `node:24.19.0-bookworm-slim` plus `git`, `ca-certificates` and `procps`, and runs it as the
image's non-root `node` user. The tree under test is a commit, piped in with `git archive`, and the script
refuses to run while its own files differ from `HEAD`, so a dirty worktree cannot make it green. Inside, `scripts/linux-leg/run-steps.sh` runs the install, the webview
install, the build, the SBOM, both typechecks, lint, `contracts:check` and `test:host`, every step
whatever the one before it did, and prints each exit status. Under OrbStack 2.2.5 the container
reports `Linux 7.2.12-orbstack-00394-gbecdd6130068 aarch64` and Node v24.19.0.

**First run, at `f4966ebb`.** The SBOM step and `test:host` exited 1 and every other step exited 0.
`test:host` ran 1,476 files and 22,598 tests: 22,542 passed, 11 failed and 45 were skipped, in
2,239 s. Each red, with its cause:

| Red | Where | Cause | Disposition |
|---|---|---|---|
| SBOM exit 1 | the leg | The leg built only the webview, and the SBOM is generated from the host module graph that the full build writes | The leg runs `npm run build` (`18f9beea`) |
| `ps` and `pgrep` not found | `process-tree-surviving-helper` (T14), `shutdown-teardown-order` (T23), `global-temp-root` (T1818a) | The slim image ships no `procps`; a desktop Linux does | `procps` in the image (`18f9beea`) |
| `acp-open-refused:profile-unqualified` | `acp-backed-runner` (the full turn), `f10-isolated-lanes-integration` (F10-AC-08) | Only darwin/arm64 qualifies an ACP profile, and both tests took the host's platform, so they would fail on an Intel Mac as well (inferred, not run) | The runner takes a platform; the tests pin darwin/arm64, and a new case asserts the refusal before launch anywhere else (`bb290c79`) |
| Sidebar bundle over its cap | `bundle-size` (SC-010) | Not Linux-specific: review gap GC-16's notice pushed the sidebar past its cap | Fixed (`f9e82e55`) |
| Workspace references not found | `basename-line-references` (2 cases: too few references extracted), `doc-references-outside-markdown` (2 cases: citations resolve in neither tree) | `git archive` carries `repo/` only, and these gates read the workspace's documents | Recorded, not fixed. They fail without the envelope rather than skip, so a standalone clone would fail them too (inferred, not run); the qualification matrix's "the gates that read the envelope skipped" is not true of these two |
| Timed out at 600 s | `usage-accounting-acceptance` (SC-003, 100,000 money additions into a file database) | A durable commit costs about 42 times as much in the container as on macOS; see below | The case now runs in one outer transaction, so it measures the arithmetic, not one commit per write; see below |

**SC-003 is consistent with a cost of `fsync`.** Run alone in the same image, the file took 829 s
and SC-003 timed out again; on macOS the case alone took 245 s at a load average between 4 and 9. The
store opens its database in WAL mode with `synchronous = FULL` (`src/services/sqlite-store/sqlite-driver.ts`),
so every commit asks for an `fsync`. Measured on 2026-11-12 with 5,000 one-row commits under
`node:sqlite`:

| Where | `synchronous = FULL` | `synchronous = OFF` |
|---|---|---|
| Linux container, its own disk (`/tmp`) | 3,401 µs a commit | 8 µs |
| Linux container, `tmpfs` (`/dev/shm`) | 5 µs | 5 µs |
| macOS, APFS (`$TMPDIR`) | 82 µs | 13 µs |

The timings fit a Linux `fsync` that reaches the disk and a macOS one that does not (inferred, not
traced): SQLite asks macOS for a full flush (`F_FULLFSYNC`) only under `PRAGMA fullfsync`, which the
store does not set. SC-003 itself was not rerun on `tmpfs` or with `synchronous = OFF`, so only the
extra time Linux takes is attributed to `fsync`, and that attribution rests on the table above. The
600 s budget appears to have been sized on a platform where a durable commit is cheap. The leg keeps its own disk, so it
keeps measuring what Linux does.

**SC-003 fixed in the test, 2026-11-12.** SC-003 checks exact totals, not commit cost, so neither a
per-platform budget nor a `tmpfs` temp root was needed. The case now opens one outer transaction, which
every accounting write joins (`src/services/usage-accounting/accounting-transaction.ts`), and commits it
once before the exact-total check. It still uses the real file store. On macOS the case alone took
34 s, down from 245 s. Recovery after a crash stays the business of F06-AC-07, not of this case.

**Rerun, at `18f9beea`** (10:27 to 10:59 UTC). Every step exited 0 except `test:host`, which ran 1,480
files and 22,611 tests: 22,560 passed, 6 failed and 45 were skipped, in 1,757 s. Four of the six are
the envelope gates and one is SC-003, as in the table above. The sixth was new:
`stdio-transport` (*reports a stdin the agent closed as one close*) passed in the first run and
failed here. The race was in the test, not the transport: the fake agent answered before it closed its
stdin, so a second write could reach the pipe first, be buffered and never fail. Widening that window
with a 0.5 s sleep fails the old order every time on macOS too, and the fix closes stdin first
(`9d45eec2`). One load-average sample on the host during this run read 15.4. The harness was then
hardened (`5a7ab5e0`): it refuses to run while its own files differ from `HEAD`, writes the archive to
a file before the container reads it, runs the container with `--init`, and reads the Node pin from the
commit under test.

**Third run, at `3b51e8b0`** (11:16 to 11:52 UTC), the first through the hardened harness. Every step
exited 0 except `test:host`: 1,480 files and 22,611 tests, 22,559 passed, 7 failed and 45 skipped, in
2,056 s. `stdio-transport` passed. Five of the seven are the envelope gates and SC-003 again. The other
two had passed in both earlier runs, and another session's test runs were loading the host: its
one-minute load average, sampled every two minutes from 11:25 UTC, read between 3.8 and 30.5. Both are recorded as
load-sensitive test designs, not Linux behaviour, and neither is fixed here:

- `f14b-host-integration` (F14-AC-05/06/10) waits a fixed 20 ms for a retry-exhausted batch to spool,
  then asserts one spooled batch; it read 0. The spool arrived after the test had closed the
  database and surfaced as an unhandled `database is not open` rejection from
  `src/services/telemetry-host/telemetry-durable-store.ts`. Fixed later the same day: a spool that
  starts or resumes after the store closed now drops its batch and removes its file, any other spool
  failure is reported through the side-effect reporter (operation `telemetry-spool`), and the host's
  `idle()` waits for unawaited spool work, which the test now awaits in place of the 20 ms.
- `secret-scan-staged` (SS4, SIGTERM while the engine runs) polls every 2 ms for the scan's temporary
  directory and never saw it. The directory exists only while the scan runs, so a scan that completes
  between two delayed polls leaves nothing to see (inferred, not traced).

**Row 3.** `tests/unit/platform/linux-case-sensitivity.test.ts` (`d386f056`) creates `Report.md` and
`report.md` side by side and asserts two output identities. In the leg image it passed, 2 of 2, and
with `fold()` changed to always lower-case it failed, 2 of 2, so the fixture can see the defect it
guards against. On macOS it skips with its platform named.

## The declared support surface

This table **is** the support claim. Any other document that names a platform defers
to it, and `tests/lint/platform-branch-has-record-row.test.ts` refuses a
`process.platform` comparison in `src/` naming a platform that is not here.

| Platform | Tier | Evidence |
|---|---|---|
| **macOS** (darwin, arm64) | **Verified** | The full host suite runs here every cycle. This record's header names the date and the platform. |
| **Linux** | **Unverified** | Ships, and is branched for (`src/lib/output-target-identity.ts:40`). The unit tier has executed here in a Linux container (`npm run verify:linux`, 2026-11-12, aarch64), and the case branch is observed, see [Local Linux leg 2026-11-12](#local-linux-leg-2026-11-12). The extension host, a browser and a real CLI have not run on Linux, and no gate record was made there, so the tier stays **Unverified**. |
| **Windows** (win32) | **Unverified** | Ships, and is branched for in four production files, two of them safety paths. Has never executed here. Both fixtures are *Unrun here*. The one Windows result there is, [the red Windows CI leg](../release/actions-terminal-record.md#the-red-windows-ciyml-leg-versus-every-windows-path-claim) at `2a885187`, ran on CI, not on this machine, so "has never executed here" stays true of this machine; its cause is unrecovered. |

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

## Ownership timing (`FR-R4-F01`, 2026-10-27)

<!-- Source: src/state/ownership-claim.ts -->
<!-- Source: src/state/lock.ts -->
<!-- Source: src/state/execution-lease.ts -->

Window primacy and the per-queue execution lease arbitrate through exclusive file creation and a
fencing generation (see [Workspace ownership fencing](../architecture/workspace-ownership-fencing.md)).
Whether that arbitration holds across two real windows, across a suspend and wake, and on a network
mount is a property of the platform, not of the code, and **nothing in this section was observed
on one**. Every row below is `Asserted by unit table only` or `Unrun here`; none is `Observed here`.

The first six rows are deterministic tests over a simulated filesystem (an in-memory `OwnershipFs`
whose interleavings the test chooses) and an injected scheduler. They establish what the code does
at one chosen interleaving. They are not cross-process evidence, and this page does not let them
stand in for it.

| Procedure | Platform | Mount | VS Code version | Timing | Outcome class |
|---|---|---|---|---|---|
| **P1** two primacy ticks overlap, the first parked in `acquire` (one primacy-gain notice) | macOS (darwin, arm64), no host | in-memory `OwnershipFs` double | none (no host) | injected scheduler, no real time | **Asserted by unit table only** (`tests/unit/state/ownership-timing-probes.test.ts`) |
| **P2** two execution-lease beats overlap, a release between (a released queue stays released) | as P1 | as P1 | none | as P1 | **Asserted by unit table only** (same file) |
| **P3** suspend and wake, the holder wakes first | as P1 | as P1 | none | as P1 | **Asserted by unit table only** (same file) |
| **P4** suspend and wake, the rival wakes first (one gain, one loss) | as P1 | as P1 | none | as P1 | **Asserted by unit table only** (same file) |
| **P5** a new generation created, its body not yet written | as P1 | as P1 | none | as P1 | **Asserted by unit table only** (same file) |
| **P6** an ownership verify that never settles gives up within `OWNERSHIP_VERIFY_DEADLINE_MS` and refuses | as P1 | a filesystem whose listing is held open | none | injected scheduler | **Asserted by unit table only** (`tests/unit/state/verify-deadline.test.ts`) |
| **Q1** two windows on one workspace: open, let the first go stale, reclaim, observe exactly one loss notice | macOS, the supported VS Code build | the workspace's local disk | the supported build | the reclaim takes `STALENESS_THRESHOLD_MS` (15 s) after the first window's last beat | **Unrun here**. Prerequisite: the maintainer's hardware, with two VS Code windows on the supported build |
| **Q2** suspend and wake with a Run in flight, in both wake orders (holder first, rival first) | macOS, the supported VS Code build | the workspace's local disk | the supported build | a sleep longer than `STALENESS_THRESHOLD_MS` | **Unrun here**. Prerequisite: a machine that can sleep with VS Code open and a Run mid-Phase |
| **Q3** an SMB or NFS workspace: run the existing mount probe, then Q1, on the mount | the maintainer's platform | an SMB or NFS share | the supported build | as Q1 | **Unrun here**. Prerequisite: a share the maintainer can mount. Limitation recorded: the declared support surface above lists NFS and SMB as inside the boundary, **classification-tested only**, so how exclusive creation and the fencing generation behave there is unobserved, and a mount that the probe classifies `unsupported` is reported as such rather than relied on |

When a Q row is run, its class changes to `Observed here` with the date and the platform, and the
timing column records the measured interval. A row that is exercised only by a simulated adapter
stays `Asserted by unit table only`.

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
