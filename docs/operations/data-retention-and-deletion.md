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
| Failure records | 30 days (the session age setting) and the newest 200 per workspace | none |

<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: package.json -->
<!-- Source: src/services/session-retention/session-artifact-retention-service.ts -->
<!-- Source: src/services/run-checkpoint-retention.ts -->
<!-- Source: src/monitor/cli-transport-sink.ts -->
<!-- Source: src/services/history/history-description-store.ts -->
<!-- Source: src/services/failure-record/failure-record-retention.ts -->

The session age setting covers raw transcripts, verbose diagnostic trees and failure records; the session byte setting covers the first two only. Neither deletes structured audit entries, recovery checkpoints in extension `globalStorage`, runtime logs, CLI transport generations, or history descriptions.

<!-- Source: src/services/session-retention/session-artifact-retention-service.ts -->
<!-- Source: src/services/run-checkpoint-retention.ts -->
<!-- Source: src/services/failure-record/failure-record-retention.ts -->

## Failure records

A Run that fails leaves one small file that says what the agent reported as still open when it failed. Remove does not delete it.

1. **Where.** `.schegent/failure-records/`, beside `.schegent/sessions/` and outside the session tree that Remove clears. `.schegent/.gitignore` keeps it out of commits.
2. **Name.** `<stamp>_<suffix>_<runId>_<taskId>.json`, for example `20261028T143005123Z_0a1b2c3d_3f2504e0-4f89-11d3-9a0c-0305e82c3301_9b2e5f10-1c2d-4e3f-8a4b-5c6d7e8f9a0b.json`: the failure time in UTC, 8 hex characters that keep two failures in the same millisecond apart, the Run id and the task id. A Run that fails, is resumed and fails again has one file per failure. To find the records of a row you have removed, list the directory by the Run id or by the task id:

   ```sh
   ls .schegent/failure-records | grep -F '<runId>'
   ls .schegent/failure-records | grep -F '<taskId>'
   ```

3. **Contains.** The failure cause, the phase context when a phase produced output (phase, iteration, iteration cap, and the count of unchanged comparisons when it is known), whether the phase reported open issues, up to 20 issue summaries of at most 240 characters each with secrets redacted and absolute paths replaced, up to 16 metrics from the audit block, and how many issues and metrics were left out.
4. **Excludes.** Transcripts, the task's description, absolute paths and the workspace root.
5. **Bounds.** 32 KiB per record.
6. **Retention.** The session age setting, `schegent.logging.sessionRetentionMaxAgeDays`, and a cap of the newest 200 records per workspace. The same sweep that prunes session artifacts removes them: on activation, after a Run ends, and when the setting changes. The byte setting does not apply to them.
7. **Remove keeps them.** Remove deletes a row's session directory and raw transcript, and leaves its records. A Run's Delete Evidence removes that Run's records, and refuses while the Run is active. A Run's evidence export includes them.
8. **Tags are the agent's claims.** A summary may carry a label such as `regression` or `needs-approval`, which the agent chose. Schegent does not check a label and nothing it does depends on one. A record is diagnostic text for you to read, kept apart from the audit log, which holds no record text.
9. **Deleting by hand.** Delete the files. Nothing else references them. "Show last error" then says the diagnostics were removed by retention, or are unavailable.

<!-- Source: src/services/failure-record/failure-record-store.ts -->
<!-- Source: src/services/failure-record/failure-record-retention.ts -->
<!-- Source: src/services/failure-record/record-text.ts -->
<!-- Source: src/services/failure-record/record-builder.ts -->
<!-- Source: src/contracts/failure-record.ts -->
<!-- Source: src/services/evidence-export.ts -->
<!-- Source: src/services/evidence-delete.ts -->
<!-- Source: src/controller/task-deletion.ts -->
<!-- Source: package.json -->

## Safe operator procedure

1. Stop or cancel active Runs before manually removing evidence. Active session artifacts are deliberately protected from the normal sweep.
2. Use the Settings UI to reduce `schegent.logging.sessionRetentionMaxAgeDays` or `schegent.logging.sessionRetentionMaxBytes` when the intent is to prune inactive session artifacts; the sweep runs on activation, after terminal Runs, and when those settings change.
3. Treat `globalStorage/checkpoints` separately. Checkpoints may contain unredacted binary Git diffs and are managed by their fixed retention service rather than workspace settings.
4. Treat `.schegent/audit.log` as evidence, not a cleanup proxy for the whole `.schegent` directory. Host code rotates and prunes archives. Local processes can still modify or delete the log — the hash chain (`src/audit/audit-chain.ts`) makes that **evident, not impossible**: each entry carries the previous entry's digest, so `npm run audit:verify` names the first break, and a retention prune records a cut point rather than silently orphaning the chain. An actor who can edit the log can recompute every later digest; what they cannot do is edit one entry and leave the rest consistent.
5. If you manually delete a history description, its history row can remain but byte-identical rerun input becomes unavailable.
6. Deleting `.schegent/failure-records/`, or one Run's files in it, removes only failure diagnostics. "Show last error" then says they were removed by retention or are unavailable; the Run, its row and the audit log are unaffected.

<!-- Source: src/extension.ts -->
<!-- Source: src/services/session-retention/session-artifact-retention-service.ts -->
<!-- Source: src/services/run-checkpoint-service.ts -->
<!-- Source: src/services/run-checkpoint-retention.ts -->
<!-- Source: src/audit/audit-log-writer.ts -->
<!-- Source: src/services/history/history-description-store.ts -->
<!-- Source: src/services/failure-record/failure-record-store.ts -->

Schegent has no single “delete all retained data” command. `schegent.clearAll` clears Queue state and cancels active work; it is not documented in its implementation as an evidence eraser. Workspace Reset is a separate staged state operation and should not be inferred to remove extension-private checkpoints outside the workspace.

<!-- Source: src/commands/clear-all.ts -->
<!-- Source: src/commands/reset.ts -->
<!-- Source: src/services/run-checkpoint-service.ts -->
