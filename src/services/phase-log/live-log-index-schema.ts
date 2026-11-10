/**
 * FR-R6-F07 (FR-018, research R9) — DDL of SQLite migration 4, `004_f07_live_log_index`.
 *
 * Additive and forward-only: three `STRICT` tables, and no F04, F05 or F06 table is altered.
 * The F04 `log_streams`, `log_segments` and `log_gaps` placeholders stay as they are; no
 * production code writes them, and this index does not use them (spec Assumptions, plan).
 *
 * No column holds log content. A segment row points at bytes in a file by reference and byte
 * range; the bytes stay in that file.
 *
 * The CHECK value lists are spelled out, not built from the contract constants: the
 * migration checksum covers this text, so it must never change once shipped.
 * `live-log-index.test.ts` asserts the lists still equal the constants.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export const F07_LIVE_LOG_MIGRATION_VERSION = 4 as const;
export const F07_LIVE_LOG_MIGRATION_NAME = '004_f07_live_log_index' as const;

export const F07_LIVE_LOG_TABLE_NAMES = ['live_log_streams', 'live_log_segments', 'live_log_coverage'] as const;

/** Whether a stream's segments are kept. `disabled` keeps none; live display still works. */
export const LIVE_LOG_CAPTURE_MODES = Object.freeze(['captured', 'disabled'] as const);
export type LiveLogCaptureMode = (typeof LIVE_LOG_CAPTURE_MODES)[number];

export const F07_LIVE_LOG_DDL: readonly string[] = Object.freeze([
  `CREATE TABLE IF NOT EXISTS live_log_streams (
    stream_key TEXT PRIMARY KEY CHECK (length(stream_key) BETWEEN 1 AND 512),
    generation TEXT NOT NULL CHECK (length(generation) BETWEEN 1 AND 256),
    capture_mode TEXT NOT NULL CHECK (capture_mode IN ('captured', 'disabled')),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS live_log_segments (
    segment_id TEXT PRIMARY KEY CHECK (length(segment_id) = 64),
    stream_key TEXT NOT NULL REFERENCES live_log_streams(stream_key) ON DELETE CASCADE,
    generation TEXT NOT NULL CHECK (length(generation) BETWEEN 1 AND 256),
    segment_seq INTEGER NOT NULL CHECK (segment_seq >= 0),
    artifact_ref TEXT NOT NULL CHECK (length(artifact_ref) BETWEEN 1 AND 1024),
    start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
    end_offset INTEGER NOT NULL,
    record_count INTEGER NOT NULL CHECK (record_count >= 0),
    durable INTEGER NOT NULL CHECK (durable IN (0, 1)),
    UNIQUE (stream_key, generation, segment_seq),
    CHECK (end_offset >= start_offset)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS live_log_coverage (
    coverage_id TEXT PRIMARY KEY,
    stream_key TEXT NOT NULL REFERENCES live_log_streams(stream_key) ON DELETE CASCADE,
    generation TEXT NOT NULL CHECK (length(generation) BETWEEN 1 AND 256),
    reason TEXT NOT NULL CHECK (reason IN ('capture-disabled', 'not-yet-produced', 'parse-omission', 'oversized-record', 'display-truncation', 'artifact-expired', 'permission-refused', 'transport-gap', 'source-replaced', 'range-skipped')),
    from_offset INTEGER NOT NULL CHECK (from_offset >= 0),
    to_offset INTEGER,
    count INTEGER NOT NULL CHECK (count >= 0),
    recorded_at_ms INTEGER NOT NULL,
    CHECK (to_offset IS NULL OR to_offset >= from_offset)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_live_log_segments_stream ON live_log_segments(stream_key, generation, segment_seq)`,
  `CREATE INDEX IF NOT EXISTS idx_live_log_coverage_stream ON live_log_coverage(stream_key, recorded_at_ms)`
]);
