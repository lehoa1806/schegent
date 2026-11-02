# What Schegent keeps on this machine

**Audience**: any operator running Schegent. **Status**: derived — see below.

Schegent writes its own evidence to your workstation and makes no network call of its own. That does
**not** mean your content stays there: the Claude Code CLI that Schegent drives sends repository content
and prompts to the model vendor, whatever the capture settings below say, and no setting here changes it
(see [local-first, not offline](../concepts/local-first-not-offline.md)). This page says what Schegent
writes, where, whether the content is redacted, and for how long. It exists because `PRIV-01` found there
was no moment at which an operator was told any of that.

## Derived, not written

**Every bound in the table below is read from the constant that enforces it**, by
`repo/src/services/retention-disclosure.ts`. There is no second number to keep in step, and
`repo/tests/lint/retention-disclosure-parity.test.ts` fails if this document and those constants
disagree.

That mechanism is the point. This class of defect recurred three times in this round — operator-facing
text asserting a property nothing checks — and each previous fix was an edit, after which the text
drifted again.

## What is kept

| Store | Location | Content | Bounds | Swept by | Live protection | On delete | On export | Derived from |
|---|---|---|---|---|---|---|---|---|
| Structured audit log | `.schegent/audit.log`, `.schegent/audit.log.<stamp>` | metadata, redacted | rotates at 5 MiB or 30 days (age measured from the generation's oldest usable row), whichever comes first; at most 10 archives are kept, each at most 90 days; each payload is truncated above 32 KiB | rotation, activation | the live log is never pruned; only rotated archives are, and each prune is recorded as a cut | kept | included whole (shared) | `AUDIT_ROTATION_DEFAULT_SIZE_BYTES / AUDIT_ROTATION_DEFAULT_AGE_MS / AUDIT_ARCHIVE_DEFAULT_MAX_COUNT / AUDIT_ARCHIVE_DEFAULT_MAX_AGE_MS in src/audit/audit-log-writer.ts; AUDIT_PAYLOAD_MAX_BYTES in src/audit/audit-payload.ts` |
| Audit cuts | `.schegent/audit.log.cuts` | metadata, redacted | one small record appended each time an archive is pruned, so the chain verifier can tell a prune from a deletion; no bound of its own | none | append-only; the writer never rewrites it | kept | included whole (shared) | `AUDIT_CUTS_BASENAME in src/audit/audit-chain.ts` |
| Audit head checkpoint | `<globalStorage>/audit-checkpoints/<key>.json` | metadata, redacted | one small file per workspace location, holding a digest, a position and times only; never pruned, and retired only by the reset command; a moved folder leaves its old file behind | none | replaced in place by the window that owns the workspace | kept | n/a | `checkpointKey in src/audit/audit-checkpoint.ts; the store in src/audit/audit-checkpoint-store.ts` |
| Audit generation sidecar | `.schegent/audit-generation.json` | state, redacted | one small file recording when the live audit generation was first observed, used to age a generation whose rows carry no usable time; no bound of its own | rotation | keyed by the live generation, so a rotation starts a fresh record | kept | n/a | `AUDIT_GENERATION_SIDECAR_NAME in src/audit/audit-generation-sidecar.ts` |
| Raw session transcript (retained) | `.schegent/sessions/raw-<runId>.log` | unredacted content, **not redacted** | kept for `always`, or promoted for a non-clean Run under `errors-only`; removed by the session retention settings (default 30 days and 512 MiB), whichever removes it first | run-end, activation, settings-change, periodic | a Run that is executing or paused is never selected | removed | included | `src/audit/raw-transcript-writer.ts; schegent.logging.sessionRetentionMaxAgeDays / schegent.logging.sessionRetentionMaxBytes` |
| Raw session transcript (pending) | `.schegent/sessions/.pending/raw-<runId>.log` | unredacted content, **not redacted** | holds an `errors-only` Run's transcript until it ends: promoted to the retained name if the Run failed, was canceled or paused, removed if it completed; otherwise swept by the session retention settings (default 30 days and 512 MiB), whichever removes it first | run-end, activation, settings-change, periodic | a Run that is executing or paused is never selected | removed | omitted | `src/audit/raw-transcript-writer.ts; schegent.logging.sessionRetentionMaxAgeDays / schegent.logging.sessionRetentionMaxBytes` |
| Raw transcript spool | `<temp>/schegent-raw-spool-<pid>-<suffix>/stdout`, `<temp>/schegent-raw-spool-<pid>-<suffix>/stderr` | unredacted content, **not redacted** | the backend's output while one invocation runs, in the operating system's temporary area and outside the workspace; removed when the invocation ends, and a spool left by a process that has died is removed by the next writer's scavenge | run-end | a spool is named for the process that made it, so a live process's spool is not reaped | n/a | n/a | `RAW_SPOOL_PREFIX in src/audit/raw-transcript-writer.ts (not exported; checked by tests/unit/services/retention-inventory.test.ts)` |
| Run diagnostics trees | `.schegent/sessions/<runId>/diagnostics/<pipeline>/<phase>/<iteration>/<file>` | unredacted content, **not redacted** | the verbose diagnostic files (`stream.jsonl`, `debug.json`, `verbose.log`) of one phase iteration; by the session retention settings (default 30 days and 512 MiB), whichever removes it first | run-end, activation, settings-change, periodic | a Run that is executing or paused is never selected | removed | included | `schegent.logging.sessionRetentionMaxAgeDays / schegent.logging.sessionRetentionMaxBytes` |
| Run transport (CLI stream lines) | `.schegent/sessions/<runId>/transport.log` | redacted content, redacted | kept when the transport mode keeps it; at most 5 MiB per Run and 20 MiB across all Run files and legacy generations, with records older than the session retention age removed; secret patterns redacted, otherwise CLI content as sent | append, run-end, periodic | the pass does not age an active Run's file, and the total is enforced without removing it | removed | included | `TRANSPORT_FILE_MAX_BYTES / TRANSPORT_WORKSPACE_MAX_BYTES in src/monitor/transport/transport-policy.ts; schegent.logging.transportCaptureMode` |
| Transport stage (errors-only, while a Run is active) | `<temp>/schegent-transport-<key>/<runId>.log` | redacted content, redacted | holds an `errors-only` Run's transport until it ends: promoted to its Run file if the Run failed or was canceled, removed if it completed; at most 5 MiB per Run, outside the workspace and outside the total | run-end, periodic | a stage is promoted or removed only when its Run is known to have ended; while the Run runs it is only aged by the retention age | n/a | n/a | `TRANSPORT_FILE_MAX_BYTES / TRANSPORT_SPOOL_PREFIX in src/monitor/transport/transport-policy.ts` |
| Legacy transport generations | `.schegent/cli-transport.log`, `.schegent/cli-transport.log.<n>` | redacted content, redacted | no longer written (at most 3 numbered generations from an earlier release); each file expires whole by its newest record at the session retention age, and counts toward the Run-transport total | run-end, periodic | no Run writes it, so there is nothing to protect | kept | omitted | `CLI_TRANSPORT_FILE_NAME / CLI_TRANSPORT_MAX_GENERATIONS in src/monitor/cli-transport-sink.ts` |
| Failure records | `.schegent/failure-records/<record>` | redacted content, redacted | one record per failed Run, at most 32 KiB each; at most the newest 200 are kept, each for the session retention age (default 30 days) | run-end, activation, settings-change, periodic | a record is written once and never rewritten | removed | included | `FAILURE_RECORD_RETAINED_MAX / FAILURE_RECORD_MAX_BYTES in src/contracts/failure-record.ts; schegent.logging.sessionRetentionMaxAgeDays` |
| Run history descriptions | `.schegent/history/<description>` | redacted content, redacted | the operator's description of a Run; a description no history entry refers to is removed once it is 24 hours old, at most 200 per activation | activation | a description newer than 24 hours may still be mid-write and is kept | kept (Run history) | included | `HISTORY_ORPHAN_GRACE_MS / HISTORY_SWEEP_MAX_REMOVALS in src/services/history/history-description-store.ts` |
| Metrics rollup | `.schegent/metrics-rollup.jsonl` | metadata, redacted | one record per terminal Run; trimmed to the newest 5,000 records when it passes 8 MiB; totals carried forward | append | appended once per Run id, at the terminal transition | kept | n/a | `TRIM_THRESHOLD_BYTES / RETAINED_RECORDS_AFTER_TRIM in src/metrics/metrics-rollup-writer.ts` |
| Runtime log | `.schegent/syslog`, `.schegent/syslog.<n>` | redacted content, redacted | sanitized host diagnostics; rotates at 5 MiB and keeps 3 generations by default (the two `schegent.logging.runtimeLog*` settings); no age bound, by decision: its path can be configured outside the workspace, where an age sweep would delete files in a place you chose; default location | rotation | the live file is rotated, never deleted by a sweep | kept | n/a | `schegent.logging.runtimeLogMaxBytes / schegent.logging.runtimeLogMaxGenerations in src/config/settings-schema.ts` |
| Ownership records | `.schegent/ownership/<record>` | state, redacted | small records of which window holds the workspace; each is replaced in place by the window that owns it and removed when it is released; they hold no evidence content | none | a record is changed only by its owner | kept | n/a | `src/state/ownership-fs.ts` |
| Process catalog | `.schegent/catalog/<entry>` | state, redacted | the saved process definitions; at most 50 versions are kept, and a version a Run or history entry refers to is not pruned | append | the active and draft versions and any version a Run refers to are exempt | kept | n/a | `CATALOG_RETENTION_BOUND in src/contracts/catalog-store.ts` |
| Evidence .gitignore | `.schegent/.gitignore` | state, redacted | one small file that keeps this directory out of commits; created beside the first evidence written, never overwritten when an operator has changed it | none | not applicable | kept | n/a | `src/audit/schegent-gitignore.ts` |
| Private recovery checkpoints | `<globalStorage>/checkpoints/<runId>/<file>` | recovery material, **not redacted** | 14 days and 256 MiB total, with the 10 most recent Run directories protected from the size limit; deliberately outside the workspace | activation | the 10 most recent Run directories are protected from the size limit | removed | n/a | `CHECKPOINT_MAX_AGE_MS / CHECKPOINT_MAX_TOTAL_BYTES / CHECKPOINT_RECENT_RUN_FLOOR in src/services/run-checkpoint-retention.ts` |
| Workspace memento state | `<workspaceState>/schegent.*` | state, redacted | the Run map, queues and history that survive a reload; history is capped at 50 entries per queue, the oldest dropped first | append | the cap applies to history entries only | kept | n/a | `HISTORY_CAP_PER_QUEUE in src/state/workspace-state.ts` |
| Operator pseudonym | `<workspaceState>/schegent.operatorPseudonym` | state, redacted | one random label of the form `pseudonym-` and 16 hex digits, made on first use and written into audit rows in place of an account name; replaced only by the reset command, which records the reset first | none | not applicable | kept | n/a | `schegent.operatorPseudonym in src/state/workspace-state.ts; src/lib/operator-attribution.ts` |
| Export, audit-export and bundle destinations | `<destination>/<export>` | redacted content, redacted | a directory or file you choose; each artifact is carried up to 16 MiB and anything larger is omitted with the reason in the manifest; owner-only permissions; Schegent never removes or ages what it exported | none | not applicable: outside the workspace once written | n/a | n/a | `MAX_ARTIFACT_BYTES in src/services/evidence-export.ts` |

The 90-second stall threshold is a constant (`MONITOR_STALL_THRESHOLD_MS`), not a setting: a Run that has been silent that long is reported as stalled, and no setting changes it.

## Older audit rows, and when a sweep runs

**Older audit generations can hold content.** Before this release the audit log could carry stream content
in some rows. Those generations are not rewritten or erased selectively: they are listed in an export's
manifest, and they leave the workspace only the way every audit generation does, whole, in a normal
retention cut that the chain verifier can still follow. Deleting a Run's evidence never touches the audit
log.

**Older rows can name an operating-system user.** New rows carry a random pseudonym of the form
`pseudonym-` and 16 hex digits, stored in the extension's private workspace storage and never derived from
your account name. Rows written before that, and any override you stored, may hold your OS username, and
they are not rewritten. A pseudonym is still linkable metadata: it ties every row from one editor user in
one workspace together, and `Schegent: Reset Operator Pseudonym` changes only the rows written after it.

**An age bound and the time a sweep runs are different things.** An age says when evidence becomes eligible
for removal. Removal itself happens when something looks, and what looks differs by store: the "Swept by"
column above names it. The host looks when it starts, when a Run ends, when a retention setting changes,
and once an hour in an idle window that owns the workspace, but the hourly look reaches only the session
groups (raw transcripts and diagnostic trees), the failure records and the CLI transport. The rotated
audit archives (also pruned when the log rotates), the private recovery checkpoints and the history
descriptions are looked at when the host starts, and not again while it stays open. Evidence the hourly
look reaches can therefore outlive its age by up to an hour in an open window; the rest, for as long as
the host stays open; and all of it, for as long as the host stays closed.
Audit files, current and archived, are owner-only (`0600`).

## The one artifact that is deliberately unredacted

`.schegent/sessions/raw-<runId>.log` holds the backend's output **verbatim**. That is the threat
model's stated position, not an oversight: it is a developer-debug artefact, comparable to terminal
scrollback, never read back by the host, never shipped to a webview, and gitignored. If your prompts
or your repository contain secrets, that file can contain them too.

It is the reason this page exists rather than a reason it does not.

**The export is the exception, and deliberately so.** An export crosses a trust boundary that a local
file does not — someone else receives it — so every artifact is redacted on the way out, including
this one. Redacting more than the product's own set is fine; redacting less is not.

## Errors-only remains the default

This page describes what is **retained**. It does not change what is **captured**: the default session
retention is `errors-only`, and nothing in `FR-R3-085` alters it.

## What you can do about it

| Want to | Command |
|---|---|
| See what is held for a Run | `Schegent: Export Run Evidence` — writes an archive plus a manifest of exactly what it contains and what it deliberately omits |
| Remove what is held for a Run | `Schegent: Delete Run Evidence` — reports what it removed **and** what it could not, and refuses rather than racing a live writer |

## What this page does not claim

- **On-disk evidence is not tamper-proof.** These are files under your own account's authority. The
  audit log carries a hash chain, and the extension keeps a small checkpoint outside the workspace; they
  reduce undetected loss and make an edit evident, and they prove nothing against the same OS user, who
  can edit both. The export carries a chain too, because its recipient is a different party — that is
  where a chain means something most.
- **Nothing here is encrypted at rest.** `FR-R3-085` stage 1 declined optional encryption for a
  stated reason: this product has no key store, and inventing one is a larger change than that item.
  `FR-R3-127` turned that into a record with a reversal trigger —
  [the evidence-encryption declination](../architecture/evidence-encryption-declination.md) — so the
  question is answered rather than re-asked. The short version: encryption's hard part is the key
  lifecycle, and the actor it would stop is one that already has the authority to read the key.
- **Which posture you are in is a choice with a name.** `FR-R3-127` publishes three privacy profiles
  — `ephemeral`, `diagnostic` (these defaults) and `forensic` — each stating what it keeps, who it is
  for, and what it does **not** change. See [the settings reference](../reference/settings.md).
  The decline is recorded with its reason rather than omitted.
