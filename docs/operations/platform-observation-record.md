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

There is no fourth class, and in particular there is no "expected to pass".

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
| A process group that survives SIGKILL is recorded in evidence | `FR-R3-054` §5 | `tests/unit/controller/process-tree-degradation.test.ts` | **Observed here** (by injection: a real unkillable group is not producible) |

## What this record does not claim

- **No NFS, SMB, 9p or virtiofs mount was used.** `FR-R3-083` §4 allows the
  mount-capability acceptance to be discharged by injection when no such mount is
  available to the author, provided the weaker claim is stated. It is stated: the
  three mount rows above are classification coverage, not field evidence. What has
  been established is that the probe reaches a verdict and cleans up after itself
  on every path; what has not is how a particular remote filesystem behaves.
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
