# Data retention and deletion

Schegent uses independent retention rules for independent artifact classes. Deleting or pruning one class does not imply that the others are removed.

<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/services/session-retention/session-artifact-retention-service.ts -->
<!-- Source: src/services/run-checkpoint-retention.ts -->

## Retention matrix

| Artifact | Default bound | Protected data |
|---|---|---|
| Active structured audit log | rotates at 5 MiB or 30 days | current `audit.log` |
| Rotated audit archives | 10 archives and 90 days, with a 7-day minimum age policy | none beyond the configured archive rules |
| Raw transcripts and verbose diagnostic trees | 30 days and 512 MiB across complete inactive Runs | artifacts for active/protected Run IDs |
| Recovery checkpoints | 14 days and 256 MiB | ten most recent Run directories are protected from the size bound, but not the age bound |
| CLI transport log | 5 MiB per generation plus three generations | current live file until rotation |
| History descriptions | coupled to retained history entries | removed best-effort when the owning history row is evicted |

<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: package.json -->
<!-- Source: src/services/session-retention/session-artifact-retention-service.ts -->
<!-- Source: src/services/run-checkpoint-retention.ts -->
<!-- Source: src/monitor/cli-transport-sink.ts -->
<!-- Source: src/services/history/history-description-store.ts -->

The session age/byte settings cover raw transcripts and verbose diagnostic trees only. They do not delete structured audit entries, recovery checkpoints in extension `globalStorage`, runtime logs, CLI transport generations, or history descriptions.

<!-- Source: src/services/session-retention/session-artifact-retention-service.ts -->
<!-- Source: src/services/run-checkpoint-retention.ts -->

## Safe operator procedure

1. Stop or cancel active Runs before manually removing evidence. Active session artifacts are deliberately protected from the normal sweep.
2. Use the Settings UI to reduce `schegent.logging.sessionRetentionMaxAgeDays` or `schegent.logging.sessionRetentionMaxBytes` when the intent is to prune inactive session artifacts; the sweep runs on activation, after terminal Runs, and when those settings change.
3. Treat `globalStorage/checkpoints` separately. Checkpoints may contain unredacted binary Git diffs and are managed by their fixed retention service rather than workspace settings.
4. Treat `.schegent/audit.log` as evidence, not a cleanup proxy for the whole `.schegent` directory. Host code rotates and prunes archives. Local processes can still modify or delete the log — the hash chain (`src/audit/audit-chain.ts`) makes that **evident, not impossible**: each entry carries the previous entry's digest, so `npm run audit:verify` names the first break, and a retention prune records a cut point rather than silently orphaning the chain. An actor who can edit the log can recompute every later digest; what they cannot do is edit one entry and leave the rest consistent.
5. If you manually delete a history description, its history row can remain but byte-identical rerun input becomes unavailable.

<!-- Source: src/extension.ts -->
<!-- Source: src/services/session-retention/session-artifact-retention-service.ts -->
<!-- Source: src/services/run-checkpoint-service.ts -->
<!-- Source: src/services/run-checkpoint-retention.ts -->
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/services/history/history-description-store.ts -->

Schegent has no single “delete all retained data” command. `schegent.clearAll` clears Queue state and cancels active work; it is not documented in its implementation as an evidence eraser. Workspace Reset is a separate staged state operation and should not be inferred to remove extension-private checkpoints outside the workspace.

<!-- Source: src/commands/clear-all.ts -->
<!-- Source: src/commands/reset.ts -->
<!-- Source: src/services/run-checkpoint-service.ts -->
