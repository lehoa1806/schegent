# Live-Log Delivery (`FR-R6-F07`)

**Declared**: 2026-11-10 (`specs/306-recoverable-live-logs/spec.md`)

This guide is for an operator who watches a phase's live log in the dashboard or the sidebar, and
needs to know what the view can drop, how it reports what it dropped, and what survives a reload
or a host restart.

The live log is a view of the phase's retained `stream.jsonl`. The file is the record. The view
reads it in bounded pieces, and every piece it cannot show becomes a counted coverage-gap row in
the view, never a silent hole.

Implemented in:
- [`src/contracts/phase-log-bounds.ts`](../../src/contracts/phase-log-bounds.ts)
- [`src/services/phase-log/phase-log-tail-session.ts`](../../src/services/phase-log/phase-log-tail-session.ts)
- [`src/services/phase-log/live-log-cursor.ts`](../../src/services/phase-log/live-log-cursor.ts)
- [`src/services/phase-log/live-log-record-framer.ts`](../../src/services/phase-log/live-log-record-framer.ts)
- [`src/services/phase-log/live-log-entry-budget.ts`](../../src/services/phase-log/live-log-entry-budget.ts)
- [`src/services/phase-log/live-log-batcher.ts`](../../src/services/phase-log/live-log-batcher.ts)
- [`src/services/phase-log/live-log-counters.ts`](../../src/services/phase-log/live-log-counters.ts)
- [`src/services/phase-log/acp-live-projection.ts`](../../src/services/phase-log/acp-live-projection.ts)
- [`src/services/phase-log/live-log-index.ts`](../../src/services/phase-log/live-log-index.ts)
- [`src/services/phase-log/live-log-replay-reader.ts`](../../src/services/phase-log/live-log-replay-reader.ts)
- [`src/ui/sidebar/commands/phase-log-tail-error.ts`](../../src/ui/sidebar/commands/phase-log-tail-error.ts)

## Production status

What ships and runs in this release:

- the bounded, acknowledged delivery from the log file to the dashboard and sidebar views;
- resumable cursors, so a reloaded view continues where it stopped;
- the six delivery counters, on the stop response and the `phase-log-tail-stopped` audit row;
- bounded operation-and-code failure logging across the start, ack, and stop tail handlers (`phase-log-tail-error.ts`), so neither raw filesystem paths nor thrown exception messages reach the logger;
- **the segment index** (SQLite migration 4, `004_f07_live_log_index`), constructed in production by [`src/activation/sqlite-cutover-wiring.ts`](../../src/activation/sqlite-cutover-wiring.ts). Production calls `openStream(...)` when recording ACP observations, and `readLiveLogVisibility()` reads summary counts from `live_log_*`. Full segment append/finalize/replay persistence is exercised by the contained replay consumer (`src/services/phase-log/live-log-replay-reader.ts`) and integration tests, while live view tailing still reads `stream.jsonl` directly.

What ships as a qualified library boundary not yet wired as the live view producer:

- **The ACP live projection (`projectAcpEvents`).** Production ACP modules (`src/contracts/acp-runtime.ts`, `src/services/acp-runtime/session-update-mapper.ts`, `src/services/acp-runtime/observation-emitter.ts`, `src/runner/acp-stream-encoder.ts`, and `src/runner/acp-open-work-tracker.ts`) import only the `AcpNormalizedEvent` / `AcpEventKind` / `AcpEventOrigin` **types** from `acp-live-projection.ts`; production display streaming currently writes `stream.jsonl` through `AcpStreamEncoder` rather than calling `projectAcpEvents(...)` directly. `projectAcpEvents` enforces control/surrogate metadata rejection, a 128-character `toolName` cap, pre-allocation UTF-8 text truncation, and cycle-safe depth/node/byte-bounded `toolArgs` sizing before sanitization and 255 KiB entry budgeting.

Because production live views still tail `stream.jsonl` directly (without `appendSegment` or `projectAcpEvents` wired into the view loop), `capture-disabled` and `transport-gap` do not yet appear in a live UI view during normal runs.

## Bounds

Every buffer between the file and the visible window has a byte bound. Each bound is measured on
the serialized UTF-8 form that crosses the boundary.

| Bound | Value | What happens at the bound |
|---|---|---|
| Partial-record residual | 256 KiB | The record is dropped up to its next newline, giving an `oversized-record` gap. |
| One display entry | 255 KiB (256 KiB less a 1 KiB envelope reserve) | The entry is shrunk. If it still does not fit, it becomes a `display-truncation` gap. |
| One batch message | 256 KiB | No batch over the bound is ever posted. Entries carry over to the next batch. |
| Unacknowledged bytes per view | 1 MiB | The host stops posting until the view acknowledges. Nothing is dropped. |
| Visible window | 500 rows and 4 MiB | The oldest rows are evicted, and the `truncated-head` marker's count rises. |
| One replay pass | 8 MiB of source | An older backlog is skipped from the newest record boundary, giving a `range-skipped` gap. |
| One source read | 256 KiB | None; this is the read size. |
| Each counter | 2,147,483,647 (2^31 − 1) | The counter saturates; it never wraps. |
| Cursor string | 160 characters | A longer cursor is malformed. |

The bounds are fixed constants. No user setting changes them.

## Coverage reasons

A coverage-gap row says which reason applies, and where it can, how many records or bytes are
missing. No coverage-gap row holds any of the missing content.

| Reason | What it means | What to do |
|---|---|---|
| `not-yet-produced` | The log file is empty or does not exist yet. | Wait; the phase has not written output yet. |
| `parse-omission` | A line was not a valid record. | Open the raw transcript if the content matters ([inspect raw transcripts](inspect-raw-transcripts.md)). |
| `oversized-record` | A record was larger than the residual bound. | Same as above. The record is still in the file. |
| `display-truncation` | An entry was too large to show, even shrunk. | Same as above. |
| `range-skipped` | A backlog over 8 MiB was skipped, at start or when the view fell behind. | The skipped bytes are still in the file; read them from the file. |
| `artifact-expired` | The log file was removed while being read. | Check retention ([artifact lifecycle](artifact-lifecycle.md)). |
| `permission-refused` | The log file could no longer be read. | Check the file's permissions and the workspace containment. |
| `source-replaced` | The log file was replaced: a new file identity, or one shorter than the read position. | Expected after a phase re-run. The view starts over on the new file. |
| `transport-gap` | ACP events were lost across a reconnect or arrived without an id. | Not produced in production yet. |
| `capture-disabled` | Segment capture is off for the stream, so nothing is kept for replay. | Not produced in production yet. |

## Counters

Each view subscription keeps six counters. They are returned when the view stops, and are
written to the `phase-log-tail-stopped` audit row ([inspect audit logs](inspect-audit-logs.md)).
They are counts only, never content.

| Counter | Raised by |
|---|---|
| `deliveryGaps` | `not-yet-produced` and `range-skipped` gaps; an `artifact-expired` or `permission-refused` refusal, once each time the refusal reason changes; and each replay the view asks for. |
| `omittedRecords` | `parse-omission`, `oversized-record` and `display-truncation` gaps, once per source record. |
| `omittedBytes` | Source bytes skipped with a `range-skipped` gap, bytes of a malformed line, and bytes dropped from an oversized record. |
| `sourceResets` | `source-replaced` gaps. |
| `duplicateBatches` | A batch the view had already applied and ignored. |
| `replayAttempts` | A view that saw a sequence gap and asked the host to replay from its last acknowledged position. |

A replay loses nothing: the host resends from the last acknowledged position. It still raises
`deliveryGaps` along with `replayAttempts`, so subtract `replayAttempts` from `deliveryGaps` to
count the gaps that showed a coverage-gap row. A nonzero `duplicateBatches` also means delivery
recovered and nothing was lost.

## Cursors

A cursor marks a position in one log file. It has the form
`plc1.<stream digest>.<file identity>.<byte offset>.<fingerprint>`.

- The view stores the cursor of the last batch it applied. After a reload it asks to resume from
  that cursor, and continues without repeating or skipping a record.
- A cursor is a position only and grants no access. The view's selection (queue, task, pipeline,
  phase, iteration) decides which file is read, and the containment check applies as for any
  read. A forged cursor can reach no other file.
- Cursors are unsigned on purpose, so they stay valid across a host restart.

The host checks a cursor in a fixed order: version, shape, stream, file identity, offset within
the file's size, a newline just before the offset, and a fingerprint of up to 64 bytes ending at
the offset. The first failure decides.

| Start result | When | What the view shows |
|---|---|---|
| `accepted` | Every check passed. | The log continues from the cursor. |
| `reset` with a `source-replaced` gap | The file identity changed, or the file is now shorter than the offset. | The newest part of the new file. |
| `reset` with no `source-replaced` gap | The cursor was malformed, named another stream, was not at a record boundary, or its fingerprint did not match. | The newest part of the file. |
| `unknown-version` | The cursor came from another protocol version. | The newest part of the file. |
| `none` | No cursor was given. | The newest part of the file. |

"The newest part" is the whole file up to 8 MiB. A larger file starts at the first record
boundary inside its last 8 MiB, with a `range-skipped` gap for what came before.

Known limit: while a view is open, the host checks each read only for a new file identity or a
file shorter than the read position. The fingerprint is checked only when a cursor is resumed.
So a file rewritten in place, or recreated with the same identity, and grown past the read
position between two reads is not detected as replaced. The view then shows `parse-omission`
rows or entries from the new content. It never reads another file.

## The segment index and contained replay reader

Migration 4 adds three authoritative F07 tables: `live_log_streams`, `live_log_segments`, and `live_log_coverage`. They hold byte ranges and relative `artifact_ref` pointers (up to 1,024 characters), and no log content. For the store itself, see [SQLite application store](sqlite-application-store.md).

- `sqlite-cutover-wiring.ts` constructs `createLiveLogIndex(...)` on activation and opens streams on ACP observations.
- A segment becomes readable only after its end offset is verified against the file's real size, so a restart in the middle of a write never offers bytes the file does not hold.
- A segment that was written but never verified is listed apart as unverified and is not read.
- `restartReplay()` returns segments and coverage ranges oldest-first up to 1,024 rows per list, setting `truncated: true` when more rows exist.
- A replaced file starts a new generation, and the old generation is reported once as a `source-replaced` range.
- With capture disabled, a restart reports a single `capture-disabled` range and no segments, writing nothing to SQLite even if earlier captured generations existed.
- The contained replay consumer ([`src/services/phase-log/live-log-replay-reader.ts`](../../src/services/phase-log/live-log-replay-reader.ts)) validates every stored `artifact_ref` lexically (1–1,024 characters, no NUL/control characters, no backslashes, no POSIX/Windows absolute, drive-relative, or UNC prefixes, and no empty, `.`, or `..` segments) before opening via `openWithinRoot(trustedRoot, segments, { flags: 'r' })` (non-symlink intermediate walk + `O_NOFOLLOW` regular-file check), verifying `stat.size >= endOffset`, and reading bounded byte ranges within the 8 MiB pass budget. Escaping, symlink, or malformed references are refused as `permission-refused` without touching paths outside the trusted root.

### F04 placeholder log tables (schema-v9 ownership decision)

The three Migration 1 F04 placeholder tables (`log_streams`, `log_segments`, and `log_gaps`) and their deprecated adapter (`LogIndexStoreAdapter`) have zero production callers and are not written by this index. Under `FR-R7-16` (`16-08`), they are explicitly **retained as deprecated empty placeholders in SQLite schema version 9 (`SQLITE_MIN_READER_VERSION = 9`)** to preserve Migration 1 checksum immutability and schema-8/9 backup/restore compatibility; F07 `live_log_*` is the authoritative owner (and `store-relocation.ts` detects `live_log_streams` as active operational data). Retirement (`DROP TABLE`) is deferred to a future schema-breaking migration that bumps `SQLITE_MIN_READER_VERSION` and teaches restore verification to ignore verified-empty retired tables. The index does not prune segment rows of old generations; that retention belongs to the artifact lifecycle (F05).
