# Decision: how workspace ownership is arbitrated

Status: Accepted (2026-08-18)

Closes review finding **REL-01** of
[principal-architecture-review-2026-08-18.md](../operations/principal-architecture-review-2026-08-18.md).

Implements FR-R3-003. Preserves the FR-028 / FR-031 / FR-032a / FR-033a lease
invariants recorded in `CLAUDE.md` — this record changes *how* a lease is
claimed, and nothing about *when* either lease is claimed or given back.

## The decision in one paragraph

Both arbitrated resources — window primacy, one holder per workspace, and the
execution lease, one holder per queue — are claimed by exclusively creating a
generation-numbered file under `.schegent/ownership/`. Exclusive creation is the
compare-and-swap; the generation number is the fencing token. `workspaceState`
keys `schegent.lock` and `schegent.executionLeases` are retained as **advisory
per-host mirrors** for the synchronous readers that already existed, and are no
longer authoritative for acquisition or for any guarded operation. Every storage
failure resolves to `unavailable`, and every caller reads `unavailable` as *do
not proceed*.

## What VS Code was measured to guarantee

The requirement named this an explicit unknown and forbade assuming it. What was
measured, and the limits of the measurement, are in
[`tests/integration/state/memento-ordering-probe.test.ts`](../../tests/integration/state/memento-ordering-probe.test.ts).
The result is deliberately a negative one.

**Measured, on `@types/vscode` `^1.85.0` — the engine range in `package.json` —
and true of the interface rather than of a build:**

- `Memento` is `get` and `update` and nothing else. `update` takes a key and a
  value: no expected prior value, no revision, no predicate, and it does not
  return what was there before. A caller therefore cannot make a write
  conditional on what it read, and cannot learn afterwards that it raced.
- `WorkspaceStateStore.serialize()` orders writes to one key **within one store
  instance**, because the promise chain lives on a `Map` held by the store
  object. Two instances over one memento interleave freely. Two instances are the
  in-process stand-in for two extension hosts.
- Read-check-write over that surface elects **two** winners from two contenders.
  That is the defect REL-01 reported, reproduced against the surface it ran on.

**Not measured, and deliberately not relied on:**

- Cross-*process* ordering, atomicity, or visibility of `Memento.update`. Two OS
  processes cannot be created inside a vitest worker, and VS Code's storage is a
  per-host, SQLite-backed cache this suite has no handle on. An experiment that
  reported "both windows saw it on my machine" would be evidence about one
  build's caching behaviour, not a guarantee — which is precisely the assumption
  the finding warned against.

Because the guarantee cannot be established, the design does not stand on it.
This is the whole reason the mechanism is on disk rather than a Memento
compare-and-swap emulation: there is no primitive on that surface to emulate one
with.

## What the design relies on instead

One platform property, and it is a POSIX/Win32 filesystem property rather than a
VS Code one: **`open(2)` with `O_CREAT|O_EXCL` — Node's `fs.open` with flag
`'wx'` — either creates the file or fails `EEXIST`, and cannot do both.** Node
surfaces it unchanged on the platforms this extension supports.

Two hosts contending for a generation therefore produce exactly one create and
one `EEXIST`. Nothing else in the mechanism needs to be atomic: the loser
re-reads and finds the winner in place.

The known limit is stated rather than papered over. `O_EXCL` is not reliable on
NFS clients older than NFSv3, and network filesystems vary. A workspace on such
a mount degrades to the pre-feature behaviour at worst — two windows could both
believe they acquired — and no worse, because nothing was made *more*
optimistic. Schegent is a local-first tool and a network-mounted workspace is
outside its supported shape; see
[local-first-not-offline.md](../concepts/local-first-not-offline.md).

**Remote development is where this is most likely to be met, and it is ordinary
rather than exotic for a VS Code extension.** The mount families worth naming,
beyond the NFS and SMB shares above:

| Deployment | What the workspace sits on |
|---|---|
| WSL2 reaching `/mnt/c` | 9p, whose `O_EXCL` semantics differ from the Linux filesystem beside it |
| Devcontainers and Docker bind mounts | virtiofs or gRPC-FUSE on macOS and Windows hosts |
| GitHub Codespaces | an overlay whose backing store is not the local disk |
| Network home directories | NFS or SMB, reached without the operator thinking of it as a share |

The last is the one that catches people: a workspace under a network home
directory is on a share whether or not anyone chose one.

**What this project does about it is disclose, not detect.** Whether the
primitive actually degrades on any specific one of those mounts has not been
measured here, and building a warning on an unmeasured risk would either cry wolf
on working setups or miss the ones that matter. What the fence does instead is
keep the *reason* a failure happened: an arbitration failure carries the errno
the filesystem gave — `ENOTSUP`, `EPERM`, `EROFS`, `ENOSYS` each point somewhere
different — rather than flattening every cause to `io-error`. That turns "no
window is primary" from a symptom into evidence, at the moment the problem is
actually in front of someone.

## The mechanism

```text
.schegent/ownership/
  primacy.9f21c4e0d1a2b3c4.g000000004.json
  queue-default.4c1b7e2f09a8d6b5.g000000011.json
```

A filename is `<slug>.<sha256-16>.g<9 digits>.json`. The slug is the resource
name reduced to `[A-Za-z0-9_-]` and truncated; the digest is over the *raw*
resource name and carries the uniqueness the reduction discards, so two queue ids
that slug identically still address different files. A queue id reaches this code
from persisted state, so it is treated as untrusted input and is not permitted to
reach a path component.

- **Acquire** reads the directory, finds the highest generation with a parseable
  body, and — if the resource is unheld, already ours, or held by an owner whose
  heartbeat has aged past 15 s — exclusively creates generation N+1. On `EEXIST`
  it re-reads and retries, bounded at 8 attempts, after which it reports
  `unavailable`. Winning the create is confirmed against a fresh read before
  `acquired` is returned, because pruning frees earlier names and a caller
  working from a stale listing can create a generation that is no longer the
  highest.
- **The fence is the generation number.** Monotonicity is structural, not
  maintained: a token can only be issued by creating a file whose name did not
  exist, and generations below the current one are pruned, never re-issued.
- **Re-acquisition by the same owner keeps its generation**, and therefore its
  token and its `acquiredAt`. Nothing changed hands, so nothing should invalidate
  a token that guarded writes are already carrying.
- **Release writes an unheld record**, keeping the file. Removing it would let
  the next acquisition restart at generation 1 and hand out a token a revived
  predecessor still carries.
- **Two resources are two filename prefixes**, so their counters are independent
  by construction. Nothing has to remember to keep them apart.
- **An aborted generation is skipped.** A winner that dies between creating N+1
  and writing its body leaves an empty file; readers treat it as held by nobody
  and contend for N+2, so a dead winner cannot wedge a resource. A single
  mutex-guarded record would have needed its own staleness rule for exactly this
  case.

Directory mode is `0700` and file mode `0600`. A record carries the resource
name, the fence, an owner id, and two timestamps. It carries **no workspace
path**, no task or run identifier, and no operator-authored text.

## Why fencing and not only compare-and-swap

Compare-and-swap closes the simultaneous-acquire race and leaves the
revived-stale-holder race open: a host that stalls past 15 s, has its lease
reclaimed, and then resumes still believes it holds the lease and will act on
that belief. The token is issued at acquisition, carried by the holder, and
checked **at the point of effect**, so the revived host's operation is *rejected*
rather than merely late:

| Verdict | Meaning |
|---|---|
| `valid` | The current generation is ours and we are its holder. |
| `rejected: stale-fence` | The resource moved on without us. Carries `currentFence` and `ownerOfRecord`. |
| `rejected: not-holder` | The generation is still current but the holder slot is not ours. |
| `unavailable` | Storage could not answer. Treated as *do not proceed*. |

The check is about the fence and the identity only. Whether a holder's own
heartbeat has aged is the staleness question its manager already answers, and
folding the two together would make a guarded write's verdict depend on a clock
the caller never passed.

## Where the check is made

| Point of effect | Guard |
|---|---|
| Mutating IPC command (sidebar) | `WorkspaceLockManager.hasPrimacy()` — awaited, fail-closed, before the command runs |
| Queue admission (`AutoDrainCoordinator.startPendingHead`) | `ExecutionLeaseManager.hasLease(queueId)` re-check between the claim and the start; a claim that cannot be verified is given back and the queue is not admitted |
| Primacy heartbeat | Rejection drops the token and **re-acquires**. It never releases — see below |
| Execution-lease heartbeat | Rejection drops that queue's token and clears its mirror entry, and does not re-acquire: the queue belongs to whoever reclaimed it |
| Every synchronous mirror read (`isHeld`, `heldQueueIds`) | Additionally gated on this host holding a token for the resource |

The mutating-IPC gate moved from a synchronous `!lock.isForeignLockHeld()` mirror
read to an awaited `lock.hasPrimacy()`. That is the one operator-visible timing
change in this feature: a mutating command now waits for a directory read before
it is admitted. It fails closed on any throw or rejection.

### One gap this feature does not close

`ScheduledStartCoordinator`'s `isForeignLockHeld` probe (feature 065, FR-014)
still reads the mirror, and the mirror is per-host, so it can only ever see a
lock *this* window wrote. Its `scheduled-start-superseded { lock-unavailable }`
path is therefore effectively unreachable, and a scheduled start in a secondary
window is instead refused further down by the primacy gate.

This is pre-existing — `KEYS.lock` was a per-host memento entry before this
feature too, so the probe could never see a rival — and it is recorded rather
than fixed because the correction is a behaviour change in feature 065's audited
path, not part of the acquisition mechanism. The authoritative record can now
answer the question the probe is asking, which is what makes the fix available.

`QueueScheduleWatchdog`'s `isPrimary` gate stays synchronous and keeps reading
`isHeld()`. That is sound under the new model because every synchronous mirror
read is additionally gated on this window holding a fence, so a superseded window
reads `false` from its own mirror; a polling watchdog does not need the awaited
check that the mutating boundary does.

## What did not change

- **No Run-scoped path releases primacy.** Primacy is acquired in
  `extension.ts` at activation and released at `dispose()`, nowhere else. A
  heartbeat that is rejected re-acquires rather than releasing, precisely so that
  no new release site appears. SC-009 still pins the two-run case.
- `WorkspaceLockManager` cardinality is unchanged: one holder per workspace.
- `withLock`, `LockSession`, and `retain()` remain deleted.
- The execution lease keeps its tenure — claimed when a queue promotes a task,
  released at the Run's terminal transition (`completed`, `failed`, `canceled`,
  enumerated), and not released when the Run's task row is gone.
- Drain step 4b stays deleted. The concurrency ceiling stays at step 4, and the
  lease re-check added at step 6/7 is a *verification of a claim already made*,
  not a second capacity gate.
- Heartbeat cadence (5 s) and staleness threshold (15 s) are unchanged. The
  mechanism did not force a change, so none was made.
- Crash recovery is unchanged: a dead host's records go stale 15 s after their
  last heartbeat and are reclaimable from then on, and every Run still recorded
  as executing is resumed rather than failed.

## Failure mode

Refuse to acquire, never assume acquired. Concretely: an unreadable directory, an
unwritable file, an exhausted retry budget, or a rejected token all resolve to a
refusal. The operator-visible consequence of a storage failure is that a window
does not become primary and a queue is not drained — work waits. The consequence
of the opposite choice would be two CLI subprocesses against one working tree,
which is the failure this feature exists to prevent.

## Rejected alternatives

- **Emulate compare-and-swap over `Memento`** — write a claim, re-read, and
  concede if someone else's landed. There is no ordering to appeal to across
  hosts and no visibility guarantee either, so the re-read can succeed for both
  contenders. It would encode the assumption the requirement forbade.
- **A single record file guarded by a lockfile** — needs its own staleness rule
  for a holder that dies between taking the lockfile and writing the record, and
  that rule is the thing being built. Generation-per-file makes the aborted case
  a skip.
- **A monotonic counter stored beside the record** — monotonicity then depends on
  every writer incrementing correctly, which is a trust relationship between two
  processes that do not know about each other. The filename makes it structural.
- **`git worktree` per host** — forbidden by project rule, and it answers a
  different question (isolation of the tree, not arbitration of ownership).

## See also

- [The Workspace Lock](../concepts/workspace-lock.md) — the operator-facing model
- [`src/state/ownership-registry.ts`](../../src/state/ownership-registry.ts) — the mechanism
- [`src/state/ownership-fs.ts`](../../src/state/ownership-fs.ts) — the storage seam
- [`tests/integration/multi-window/ownership-election.test.ts`](../../tests/integration/multi-window/ownership-election.test.ts) — two hosts, one winner
