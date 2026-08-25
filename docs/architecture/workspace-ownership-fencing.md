# Workspace ownership fencing

Status: Accepted architecture decision.

Schegent arbitrates both window primacy and per-queue execution with a shared, workspace-visible file registry rather than with VS Code Memento. Memento remains useful for projections, but its `get`/`update` surface provides neither a conditional write nor a documented cross-process visibility guarantee, so two extension hosts cannot use it alone to elect one owner safely.

<!-- Source: src/state/ownership-registry.ts -->
<!-- Source: src/state/ownership-fs.ts -->
<!-- Source: src/state/workspace-state.ts -->

## Decision

Production activation roots an `OwnershipRegistry` at `<workspaceRoot>/.schegent/ownership/` and supplies the disk adapter exactly once. Window primacy uses the resource name `primacy`; each execution lease uses `queue:<queueId>`. The two prefixes have independent generation sequences.

The Memento-backed adapter is only the stage-one default and a test-double fallback. It is not the production arbitration mechanism. A lint gate pins the production composition so removing the disk handoff cannot pass silently in a single-window test environment.

<!-- Source: src/extension.ts -->
<!-- Source: src/state/ownership-registry.ts -->
<!-- Source: tests/lint/ownership-registry-wiring.test.ts -->

## Acquisition and fencing

Each resource is represented by generation-numbered JSON files. Acquisition reads the highest generation and attempts to create the next generation with the filesystem's exclusive-create primitive. Exactly one contender can create a given filename; a loser observes `EEXIST`, rereads, and either reports the winner or contests a later generation. Acquisition retries are bounded at eight attempts and exhaustion is an unavailable/refusal result.

The generation number is the fence. Every holder carries its issued fence into authoritative verification, heartbeat, guarded writes, and release — **and into the point of effect of a heartbeat's own write** (FR-R3-055, see the residuals below). If a stalled generation is reclaimed, the revived predecessor still presents its older fence and is rejected as stale. An incomplete generation file left by a crash is skipped; later acquisition advances beyond it rather than treating it as a permanent holder.

<!-- Source: src/state/ownership-registry.ts -->
<!-- Source: src/state/lock.ts -->
<!-- Source: src/state/execution-lease.ts -->
<!-- Source: tests/integration/multi-window/ownership-election.test.ts -->

## Storage properties

The production ownership directory is created with mode `0700`, and record and temporary files use mode `0600`. Heartbeat replacement writes a temporary file and renames it over the record so readers see either the previous complete body or the next complete body. Replace and remove operations prove their entry paths remain inside the configured ownership root before mutating them.

Ownership records contain `version`, `resource`, `fence`, and holder data; they do not need to serialize the workspace path. Files live below `.schegent/`, whose self-ignore file excludes its contents from ordinary Git tracking.

<!-- Source: src/state/ownership-fs.ts -->
<!-- Source: src/audit/schegent-gitignore.ts -->
<!-- Source: tests/integration/multi-window/ownership-election.test.ts -->

## Failure posture and filesystem assumption

Any read or write failure becomes `unavailable`, and callers treat that outcome as “do not proceed.” The design therefore prefers stalled work over electing two owners.

Correct mutual exclusion depends on the mounted filesystem implementing exclusive creation atomically. The registry preserves the originating error code so failures such as `ENOTSUP`, `EPERM`, `EROFS`, or `ENOSYS` remain diagnosable. Filesystems or remote-development mounts that do not honor exclusive-create semantics are outside what this mechanism can prove; moving the workspace to a filesystem with correct local-style exclusive creation is the safe resolution.

<!-- Source: src/state/ownership-registry.ts -->
<!-- Source: src/state/ownership-fs.ts -->

## Verified invariants

The integration suite exercises simultaneous two-host and eight-host primacy elections, per-queue exclusion, concurrent ownership of different queues, stale-holder reclamation, live heartbeats, incomplete-generation recovery, owner-only modes, and refusal when the ownership directory cannot be written. Separate lint tests ensure acquisition never decides from the advisory mirrors and that both point-of-effect checks stay asynchronous.

<!-- Source: tests/integration/multi-window/ownership-election.test.ts -->
<!-- Source: tests/lint/ownership-registry-wiring.test.ts -->

## What is guaranteed, and what is not

The review of 2026-08-23 (H-06) found this document overstating propagation. This section states the
residuals, so that a reader who needs a guarantee can tell which ones exist.

**Guaranteed.** Acquisition is compare-and-swap against the registry, so exactly one holder is
elected per resource. A revived predecessor presents an older fence and is rejected at verification,
at heartbeat, and at release. A heartbeat that overlaps a release cannot restore a released holder:
the fence map is a local closing epoch, checked immediately before the heartbeat's write
(FR-R3-055), and `release` drains a beat already in flight so a caller returning from it can rely on
no further write arriving.

**The protocol, chosen and implemented (FR-R3-055, 2026-08-24).** Of the two the review offered —
a compare-and-swap-capable commit, or fence-stamped snapshots that readers reject by generation —
**fence-stamped snapshots** is what ships. `Memento` has no conditional write (that is why FR-R3-003
moved election onto a file registry in the first place), so a true CAS commit would have meant moving
queue and Run state off `Memento` entirely. The stamped protocol is additive and needs no state
migration.

It has two halves, and both matter:

- **At the commit point.** `setRun` takes an optional execution claim, and when one is supplied the
  verify happens **inside the serialized `KEYS.run` link**, not before it. That is the whole
  difference from `writeGuarded`, which verifies and then separately awaits a callback: two
  operations, with a reclaim able to land between them. One link of a chain that already serialises
  this key is as close to a transaction as this storage allows, and strictly closer than two. A
  superseded fence is refused as `fence-superseded` and **writes nothing**.
- **At read time.** A committed record is stamped with the generation it was written under
  (`WorkflowRun.writtenAtFence`), so a reader holding a newer one can tell it came from a superseded
  holder. `isSupersededRun` answers that. An **unstamped** record answers *not superseded*,
  deliberately: records predating the field, and every write made without a claim, carry no
  generation to compare, and reading "no stamp" as guilt would reject the entire existing corpus.

**Closed by FR-R3-077 (feature 153, 2026-08-25).** All three items below recorded what was
outstanding when this record was written. All three have since been taken, and the measurements that
replaced them are stated here rather than in a separate note, because a record whose "outstanding"
section is stale is worse than one that has none.

1. **`writeGuarded` is deleted.** It was verify-then-callback — two operations, behind a name that
   promised atomicity — and its single production caller guarded the advisory `KEYS.lock` mirror.
   That caller now goes through `refreshLockMirrorGuarded`, which verifies *inside* the same
   serialized link that performs the mirror write: one link, not two operations. The helper was
   removed rather than reshaped in place, on the reasoning AGENTS.md records for `withLock` — a
   working wrapper of a defective shape is a working template for reintroducing the defect.

2. **The queue mutation path carries the same fence.** `updateQueue` takes a required
   `QueueCommitClaim` and verifies it inside its own serialized link on `KEYS.queue`. Delivered as a
   separate change *after* the Run commit point's half, which is the order
   `docs/features/round_3/00_escalated_residuals_decision.md` §2 sets — the Run path is the one the
   review measured and the one a revived stale host reaches first.

3. **The stamp is no longer opt-in; the claim is required.** What this item recorded was measured
   again before it was fixed, and the re-measurement corrected the figure: `setRun` has **26**
   production call sites, not 35. Thirty-six occurrences of the token exist in `repo/src`, of which
   nine are prose in comments and one is the declaration. The rest of the finding held exactly —
   none of the 26 passed a claim, so `writtenAtFence` was never written and `isSupersededRun` had no
   production caller at all.

   `setRun`'s claim is now a required parameter, so the type-checker enumerates the call sites rather
   than a grep. A site that provably holds no lease passes `unfencedCommit(reason)` from a closed set
   (`state/ownership-claim.ts`), which is a recorded finding about that site rather than a default —
   and `tests/unit/state/unfenced-commit-inventory.test.ts` pins the set, keeps `test-fixture` out of
   `src/`, and keeps `lease-not-held` to the single site that derives it.

   The read side has its production caller: `WorkspaceStateStore.readRunIfLive` declines a record
   stamped at a superseded generation, `RunDriver` acts on the decline, and the decline is recorded
   as the `run-snapshot-declined` audit event rather than dropped.

**What remains true.** The commit-point check refuses a write it can see. `Memento` offers no
conditional write, so a reclaim landing between the verify and the update can still leave a record
written by a superseded holder — that window is why the read side exists, and
`tests/unit/state/run-mutation-fence.test.ts` forces it explicitly rather than describing it.

Treat the fence as authoritative for *election, heartbeat, a Run mutation and a queue mutation*, and
the read-side decline as the answer to the write that slipped through.
