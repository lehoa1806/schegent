# Artifact Lifecycle, Storage and Recovery (`FR-R6-F05`)

**Declared**: 2026-11-10 (`specs/304-artifact-lifecycle-storage-recovery/spec.md`)

This guide is for an operator who has to answer four questions about local storage: what Schegent
keeps, what it is allowed to delete, why something was kept, and what happens when a deletion or a
migration is interrupted. Every answer comes from one authority, `ArtifactLifecycleService`. The
headless API and the sidebar's storage-details view both call it and return its results unchanged,
so the two surfaces cannot disagree.

Implemented in:
- [`src/contracts/artifact-lifecycle/lifecycle-types.ts`](../../src/contracts/artifact-lifecycle/lifecycle-types.ts)
- [`src/contracts/artifact-lifecycle/retention-policy-types.ts`](../../src/contracts/artifact-lifecycle/retention-policy-types.ts)
- [`src/contracts/artifact-lifecycle/legacy-preservation-types.ts`](../../src/contracts/artifact-lifecycle/legacy-preservation-types.ts)
- [`src/contracts/artifact-lifecycle/access-types.ts`](../../src/contracts/artifact-lifecycle/access-types.ts)
- [`src/contracts/artifact-lifecycle/sweeper-census.ts`](../../src/contracts/artifact-lifecycle/sweeper-census.ts)
- [`src/contracts/validators/artifact-lifecycle.ts`](../../src/contracts/validators/artifact-lifecycle.ts)
- [`src/services/artifact-lifecycle/lifecycle-service.ts`](../../src/services/artifact-lifecycle/lifecycle-service.ts)
- [`src/services/artifact-lifecycle/legacy-preservation.ts`](../../src/services/artifact-lifecycle/legacy-preservation.ts)
- [`src/services/artifact-lifecycle/restart-reconciliation.ts`](../../src/services/artifact-lifecycle/restart-reconciliation.ts)
- [`src/headless/artifact-lifecycle-api.ts`](../../src/headless/artifact-lifecycle-api.ts)

For the store these records live in, see [SQLite application store](sqlite-application-store.md).
For the retention classes themselves, see [Data retention and deletion](data-retention-and-deletion.md).

## Production status

The service and its schema ship in this release, but production constructs no lifecycle service
until the application store is opened in the extension host (the F01-B cutover). Until then:

- the sidebar's storage-details view answers `unavailable`;
- the existing sweepers keep their own protection (see the [sweeper census](#sweeper-census));
- the one live change is the run-checkpoint sweeper, which spares every run pinned for recovery.

## Availability states

Each artifact record carries one of seven availability states. Missing bytes never become an empty
successful artifact.

| State | Meaning |
|---|---|
| `present` | The bytes were found and match the record's identity. |
| `pending` | Registered; the producer has not settled the bytes yet. |
| `missing` | The bytes are gone and no deletion explains it. |
| `expired` | Removed by a retention rule. |
| `deleted` | Removed by a deletion operation this service recorded. |
| `corrupt` | The bytes are there but their digest no longer matches. |
| `unverified` | The state could not be read, or a stored value is outside the known set. |

F04 already stores four values in `artifact_availability`. Those rows are never rewritten. When no
lifecycle record exists, they are read through a fixed mapping:

| F04 value | Read as |
|---|---|
| `available` | `present` |
| `evicted` | `expired` |
| `missing` | `missing` |
| `quarantined` | `present`, with the record forced into the quarantine class |
| anything else | `unverified` (never `present`) |

## Protection and early release

An artifact is protected while any active reference holds it, or while its owning run is pinned for
recovery. A protected artifact is never a deletion target, whatever the policy says.

- Adding the same reference twice, or releasing it twice, changes nothing.
- After a restart the service asks the host where each reference owner is. An owner it cannot place
  is `unresolved`, and protection then fails closed: the artifact stays protected and cleanup is
  refused.
- **Early release** drops a reference before its owner settles. Preview it first: the preview names
  the recovery capability the release surrenders (for example, resuming that run from its
  checkpoint). The release itself needs the preview id, a confirmation and full authority.

## Storage inventory

The inventory is paged:

- a page holds at most 200 entries and at most 1 MiB serialized;
- its cursor is a keyset cursor, so it stays stable while records are added on either side of it.

Totals are split per retention class into **reclaimable**, **protected** and **unclassified**.

The scan of the declared storage roots works like this:

- It reads with `lstat` only and never follows a link.
- It stops after 2,000 entries or 8 directory levels in one pass.
- A file under a root that matches no known pattern is counted `unclassified`. It is never eligible
  for deletion.

### The partial label

A scan is labelled `partial`, with coverage figures (entries visited, roots completed of roots
declared), when any of these happen:

- it was cancelled;
- it hit one of the bounds above;
- a root could not be read.

A partial scan never reads as "nothing here". The time of the last *complete* scan is reported
separately, so a partial pass does not hide how old the full picture is.

## Storage pressure

When usage is over the configured target, the pressure report gives the protected and reclaimable
byte counts. If everything over the target is protected, it reports pressure with
`reclaimableBytes: 0` and plans no deletion.

New work is then held back by the existing admission controls (F02 pin quota admission, F03
backpressure). Nothing is evicted to make room, and runs that are already active can still settle.

## Deletion

Every deletion is a two-step, previewed mutation:

1. **Preview.** `previewArtifactDeletion` lists the targets, the bytes affected and the protected
   exceptions.
2. **Execute.** `executeArtifactDeletion` presents the preview id, the confirmation and the
   authority.

The gate checks the request in a fixed order:

1. untrusted workspace;
2. not the primary window;
3. audit unhealthy;
4. preview missing or stale;
5. confirmation missing.

A preview goes stale when the selection it was taken for has changed.

Each target is resolved inside its declared root, both lexically and canonically. Its protection and
writer are re-checked, and the intent is persisted before any unlink. Per-target outcomes:

| Outcome | Meaning |
|---|---|
| `deleted` | Removed. |
| `already-absent` | The bytes were already gone; this counts as success. |
| `retained` | The unlink failed (for example `EACCES`); the bytes are still there. |
| `refused` | Protected, outside its root, swapped for a link, or the operation lost its fence. |
| `unknown` | Interrupted mid-effect; reconciliation settles it. |

How the outcomes roll up into the operation:

- If any target was retained or refused, the operation ends `partial`.
- If persisting the intent fails (for example on a full disk), nothing is unlinked.
- An operation interrupted by a restart resumes under the same operation id, and the targets it left
  `executing` are reconciled.
- At activation, before any sweep, the host calls `reconcileAfterRestart` with its authority. It
  resumes every unfinished deletion and settles every unfinished legacy quarantine. A deletion whose
  lease another holder still owns is left to that holder and reported as deferred.
- Only one sweep holds the workspace lease at a time. A second sweep is refused
  `sweep-in-progress`.
- Cancellation is observed before the next target, within one second.

## Legacy catalog preservation

A legacy catalog can hold a version file that was written but never published to its manifest
(version-before-manifest residue). The migration preview classifies that residue, reporting:

- the source manifest generation;
- each version id and digest;
- unresolved references;
- live and frozen consumers.

Nothing is classified as disposable, and no published pointer is ever synthesized.

- **Default: preserved in place.** No file moves unless the operator asks.
- **Quarantine on request.** A quarantine move is previewed and gated like a deletion. The bytes are
  copied under `.schegent/quarantine/catalog/`, the copy's digest is verified, and only then is the
  source removed. An existing destination is never overwritten.
- **Interruption.** A move interrupted after the copy leaves both files and the operation
  unfinished. Reconciliation inspects both sides, moves nothing, and records the target `ambiguous`.
  Until then, a new quarantine or a purge of that residue is refused `ownership-unresolved`.
- **Referenced versions** are refused and stay where they are.
- **Re-import** of quarantined content goes through the current catalog admission gates and a
  preview, and writes nothing. If the manifest already names that version, the preview is refused:
  `identity-conflict` for the same content, `content-conflict` for different content. It never
  invents a published version.
- **Purge** of quarantined residue is its own previewed, confirmed mutation. It refuses residue that
  a consumer still references or whose preservation is still ambiguous. A purged copy keeps its
  record and digest; only its quarantine location is cleared.
- **Unreadable manifest.** If the legacy manifest cannot be read, the quarantine preview, the
  quarantine and the re-import preview are refused `unavailable`.
- **No catalog configured.** A host that supplies no legacy catalog gets `unavailable` from every
  preservation operation.

## Retention policy and Task archival (opt-in)

Nothing is collected or archived until an operator adopts a policy. Before that, the implicit
revision 0 is in force, and it collects nothing.

1. **Preview** the policy (`previewRetentionPolicy`). The preview shows what it would collect, keep
   and archive.
2. **Adopt** it (`adoptRetentionPolicy`) with the preview id, the same policy, a confirmation and full
   authority. Adopting a different policy than the one previewed is refused `preview-stale`.

The default policy has these values:

| Field | Default |
|---|---|
| `archivalHotListBound` | 100 resolved terminal Tasks per queue |
| `archivalMaxAgeMs` | 30 days after terminal resolution |
| `terminalDetailMaxAgeMs` | 90 days (the F02 metadata retention age) |

Archival (`previewTaskArchival`, then `archiveTerminalTasks`) moves resolved terminal Tasks past
either bound out of the hot list and into an archived summary. These Tasks are never archived:

- pending, paused, intervention-required and unresolved-decision Tasks;
- a Task whose run still has an unresolved control frame. It is counted as `skipped`.

If the host supplies no control-ledger lookup, every run counts as unresolved, so nothing is
archived.

An archived summary keeps its detail until its detail age expires. After that it reports
`aggregates-only` coverage instead of silently losing fields.

## Artifact access handles

A report can be embedded in, or read by, another component only through a handle qualified for one
attempt and one session, under the host's access policy. Until F13 supplies a policy, every request
is denied.

- A changed digest, a different session or a forged reference is refused.
- An unknown artifact is refused `access-denied` rather than `not-found`, so the answer does not
  reveal whether the artifact exists.
- A materialized copy is written only under the workspace root, is never overwritten, and expires:
  after 1 hour by default, and after 1 day at most.

## Sweeper census

Every existing evidence sweeper is listed below with the protection it applies today. Only the
run-checkpoint sweeper reads F05 recovery pins in this release. The others are routed through the
lifecycle service at the F01-B cutover.

| Sweeper | Source | Protection today | Cutover owner |
|---|---|---|---|
| `RunCheckpointRetentionService.sweep` | `src/services/run-checkpoint-retention.ts` | lifecycle recovery pins | F05 |
| `SessionArtifactRetentionService.sweep` | `src/services/session-retention/session-artifact-retention-service.ts` | run-status protected set | F01-B |
| `sweepFailureRecords` | `src/services/failure-record/failure-record-retention.ts` | class-specific policy | F01-B |
| `cleanupSessionArtifacts` | `src/services/session-cleanup/session-cleanup-service.ts` | run-status protected set | F01-B |
| `createEvidenceMaintenancePass` | `src/services/evidence-maintenance/evidence-maintenance-pass.ts` | class-specific policy | F01-B |
| `TransportRouter.enforceTotal` | `src/monitor/transport/transport-router.ts` | class-specific policy | F01-B |
| `RunTransportStore.narrowLegacy` | `src/monitor/transport/run-transport-store.ts` | class-specific policy | F01-B |
| `scavengeAbandonedSpools` | `src/audit/raw-transcript-writer.ts` | class-specific policy | F01-B |
| `AuditLogWriter.pruneArchives` | `src/audit/audit-log-writer.ts` | class-specific policy | F01-B |
| `sweepHistoryDescriptions` | `src/services/history/history-description-sweep.ts` | class-specific policy | F01-B |
| `HISTORY_CAP_PER_QUEUE` | `src/state/workspace-state.ts` | class-specific policy | F01-B |
| `planRetention` | `src/catalog/catalog-retention.ts` | class-specific policy | F01-B |
| `MetricsRollupWriter.trimIfOversized` | `src/metrics/metrics-rollup-writer.ts` | none needed (aggregate rows only) | F01-B |
| `RuntimeLogSink.rotateGenerations` | `src/lib/runtime-log/runtime-log-sink.ts` | none needed | F01-B |
| `enforceBoundedRootHistory` | `src/services/workflow-execution/control-notification-service.ts` | class-specific policy | F01-B |

The source of truth is `SWEEPER_CENSUS`. A unit test requires each named symbol to appear in its
source file, so a renamed or moved sweeper fails the build before this table goes stale.

The run-status protected set also carries the runs pinned in SQLite: lane pins, exports in flight
and active protective references. When the SQLite query for those pins fails, the failure is
reported once and the session sweep is skipped, at activation, at a terminal Run and on a retention
setting change. A sweep on the rest of the set would delete what those pins protect. The
maintenance pass stops the same way, and both run again on their next trigger.

## Unqualified platforms

The containment, link and unlink guarantees above were measured on local POSIX filesystems only:

- **Windows** mutation semantics (file locking, rename-over, unlink of an open file) are not
  qualified.
- **Network mounts** (NFS, SMB and similar) are not qualified; `lstat`, rename and unlink may not be
  atomic or coherent there.

Local POSIX evidence does not qualify these environments. Power-loss durability follows each sink's
recorded policy.
