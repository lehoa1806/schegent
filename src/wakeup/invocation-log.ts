// Feature 014 — JSONL invocation log: rotation, retention, malformed-line tolerance.
//
// One JSONL record per Wake-up fire. The runner writes records; the host
// reads them for the Settings UI "View recent runs" affordance and for
// quickstart verification (SC-002).
//
// Path layout under `<globalStorageUri>/wakeup/`:
//   invocations.log         (current)
//   invocations.log.1       (newest backup)
//   invocations.log.2
//   invocations.log.3       (oldest retained)
//
// Rotation policy:
//   - Size cap: 5 MB on the current file triggers rotation.
//   - Retention: lines older than 90 days are dropped at rotation time.
//   - Backups: 3. The oldest is unlinked; older are shifted upward.
// Tolerance:
//   - Malformed lines (non-JSON, missing fields, wrong types) are
//     silently skipped on read. The writer NEVER emits malformed lines,
//     so corruption can only come from external tampering.
//
// HARD INVARIANT: every record's `cwdInsideWorkspace` MUST be the
// literal `false`. The append path rejects anything else. This is the
// canonical evidence that Context-Isolated Execution (FR-007/FR-008)
// held for that invocation.

import { existsSync, readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export type WakeUpTriggerSource = 'scheduled' | 'manual';
export type WakeUpAttemptStatus = 'succeeded' | 'failed' | 'timed-out' | 'skipped';

export interface InvocationRecord {
  readonly timestamp: string; // ISO-8601 UTC
  readonly platform: 'darwin' | 'win32' | 'linux-systemd' | 'linux-cron';
  readonly pid: number;
  readonly lockAcquired: boolean;
  readonly ephemeralCwd: string;
  /** Literal `false` — never `true`. The append path enforces this. */
  readonly cwdInsideWorkspace: false;
  readonly envScrubbed: boolean;
  readonly claudeExitCode: number | null;
  readonly durationMs: number;
  readonly triggerSource?: WakeUpTriggerSource;
  readonly status?: WakeUpAttemptStatus;
  readonly timedOut?: boolean;
  readonly skipped?: boolean;
  readonly rawResponse?: string;
  readonly errorReason?: string;
  /**
   * Feature 031 — five OPTIONAL fields. ALL are absent on legacy
   * (014/024) records. A 031-aware runner writes them on every
   * non-lock-skipped invocation; the reader tolerates absent fields.
   * See specs/031-advanced-wakeup-logs-models/contracts/wakeup-invocation-record.diff.md.
   */
  /** UUIDv4 join key with the session-log block + audit event. */
  readonly correlationId?: string;
  /** Verbatim operator selection from the settings mirror (may be invalid). */
  readonly requestedModel?: string;
  /** What the runner actually passed to the Claude CLI (or `'runner-default'`). */
  readonly actualModel?: string;
  /** Byte count appended to `session.log` for this invocation. */
  readonly sessionLogBytesAppended?: number;
  /** True iff a retention trim ran during this append. */
  readonly sessionLogTrimmed?: boolean;
  readonly [extra: string]: unknown;
}

export interface WakeUpLogProjectionEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly triggerSource: WakeUpTriggerSource;
  readonly status: WakeUpAttemptStatus;
  readonly durationMs: number | null;
  readonly rawResponse: string;
  readonly message: string;
  readonly truncated: boolean;
  /**
   * Feature 031 — surfaced from the source `InvocationRecord` for UI
   * rendering. Absent on legacy records; the renderer falls back to
   * `'runner-default'` semantics. Both are pass-through strings — no
   * extra sanitization (they're closed-vocabulary identifiers).
   */
  readonly requestedModel?: string;
  readonly actualModel?: string;
  /**
   * Feature 031 T040 — invocation correlation id used as the key for
   * the CMD_READ_WAKEUP_SESSION_LOG IPC when the operator expands the
   * row. Absent on legacy 014/024 records; the UI hides the expansion
   * affordance entirely for rows without an id.
   */
  readonly correlationId?: string;
}

export interface WakeUpLogProjection {
  readonly entries: readonly WakeUpLogProjectionEntry[];
  readonly readError?: string;
}

const MAX_SIZE_BYTES = 5 * 1024 * 1024;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_BACKUPS = 3;
const PROJECTED_RESPONSE_BYTES = 4096;
const PROJECTED_MESSAGE_BYTES = 512;

export class InvocationLog {
  constructor(private readonly logDir: string) {}

  private get logPath(): string {
    return join(this.logDir, 'invocations.log');
  }

  async append(record: InvocationRecord): Promise<void> {
    if (record.cwdInsideWorkspace !== false) {
      throw new Error('invariant: cwdInsideWorkspace must be literal false');
    }
    await fs.mkdir(this.logDir, { recursive: true });
    await this.rotateIfNeeded();
    const line = JSON.stringify(record) + '\n';
    await fs.appendFile(this.logPath, line, { encoding: 'utf8' });
  }

  /**
   * Most recent `limit` records, oldest-first. Malformed lines are
   * skipped silently. Returns empty array if no log file exists.
   */
  async read(limit = 100): Promise<readonly InvocationRecord[]> {
    let content: string;
    try {
      content = await fs.readFile(this.logPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const lines = content.split('\n').filter((l) => l.length > 0);
    const recs: InvocationRecord[] = [];
    for (const line of lines.slice(-limit)) {
      const rec = tryParse(line);
      if (rec) recs.push(rec);
    }
    return recs;
  }

  readSync(limit = 100): readonly InvocationRecord[] {
    if (!existsSync(this.logPath)) return [];
    const content = readFileSync(this.logPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    const recs: InvocationRecord[] = [];
    for (const line of lines.slice(-limit)) {
      const rec = tryParse(line);
      if (rec) recs.push(rec);
    }
    return recs;
  }

  projectRecent(
    sanitize: (value: string) => string,
    limit = 5
  ): WakeUpLogProjection {
    try {
      const records = this.readSync(Math.max(limit, 25));
      return {
        entries: projectWakeUpLogEntries(records, sanitize, limit)
      };
    } catch (err) {
      return {
        entries: [],
        readError: truncateWithFlag(sanitize((err as Error).message ?? 'wake-up log unavailable'), PROJECTED_MESSAGE_BYTES).value
      };
    }
  }

  private async rotateIfNeeded(): Promise<void> {
    let size = 0;
    try {
      const stat = await fs.stat(this.logPath);
      size = stat.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    if (size <= MAX_SIZE_BYTES) return;
    await this.rotate();
  }

  private async rotate(): Promise<void> {
    // Shift backups upward: drop .MAX, rename .(MAX-1) → .MAX, … .1 → .2.
    for (let i = MAX_BACKUPS; i >= 1; i--) {
      const src = join(this.logDir, `invocations.log.${i}`);
      if (i === MAX_BACKUPS) {
        await safeUnlink(src);
        continue;
      }
      const dst = join(this.logDir, `invocations.log.${i + 1}`);
      try {
        await fs.rename(src, dst);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    // Apply 90-day retention while writing the new .1 backup.
    const retained = await this.readRetainedLines();
    const rotatedPath = join(this.logDir, 'invocations.log.1');
    const body = retained.length ? retained.join('\n') + '\n' : '';
    await fs.writeFile(rotatedPath, body, 'utf8');
    await fs.writeFile(this.logPath, '', 'utf8');
  }

  private async readRetainedLines(): Promise<readonly string[]> {
    let content: string;
    try {
      content = await fs.readFile(this.logPath, 'utf8');
    } catch {
      return [];
    }
    const cutoff = Date.now() - RETENTION_MS;
    const lines = content.split('\n').filter((l) => l.length > 0);
    const kept: string[] = [];
    for (const line of lines) {
      const rec = tryParse(line);
      if (!rec) continue;
      const ts = Date.parse(rec.timestamp);
      if (Number.isFinite(ts) && ts >= cutoff) kept.push(line);
    }
    return kept;
  }
}

function tryParse(line: string): InvocationRecord | null {
  try {
    const obj: unknown = JSON.parse(line);
    if (obj && typeof obj === 'object' && (obj as { cwdInsideWorkspace?: unknown }).cwdInsideWorkspace === false) {
      return obj as InvocationRecord;
    }
    return null;
  } catch {
    return null;
  }
}

export function projectWakeUpLogEntries(
  records: readonly InvocationRecord[],
  sanitize: (value: string) => string,
  limit = 5
): readonly WakeUpLogProjectionEntry[] {
  return records
    .slice()
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, limit)
    .map((record, idx) => projectRecord(record, sanitize, idx));
}

function projectRecord(
  record: InvocationRecord,
  sanitize: (value: string) => string,
  idx: number
): WakeUpLogProjectionEntry {
  const status = deriveStatus(record);
  const raw = truncateWithFlag(sanitize(String(record.rawResponse ?? '')), PROJECTED_RESPONSE_BYTES);
  const fallbackMessage = status === 'succeeded'
    ? 'Wake up completed'
    : status === 'skipped'
      ? 'Wake up skipped because another invocation is active'
      : status === 'timed-out'
        ? 'Wake up timed out'
        : String(record.errorReason ?? 'Wake up failed');
  const message = truncateWithFlag(sanitize(fallbackMessage), PROJECTED_MESSAGE_BYTES);
  return Object.freeze({
    id: `${record.timestamp}:${record.triggerSource ?? 'scheduled'}:${status}:${idx}`,
    timestamp: record.timestamp,
    triggerSource: record.triggerSource === 'manual' ? 'manual' : 'scheduled',
    status,
    durationMs:
      typeof record.durationMs === 'number' && Number.isFinite(record.durationMs)
        ? Math.max(0, Math.floor(record.durationMs))
        : null,
    rawResponse: raw.value,
    message: message.value,
    truncated: raw.truncated || message.truncated,
    // Feature 031 — pass through the closed-vocabulary model fields so
    // the per-row UI can render "actual (was: requested)" when the
    // operator's selection was unhonored. Absent on legacy records.
    ...(typeof record.requestedModel === 'string'
      ? { requestedModel: record.requestedModel }
      : {}),
    ...(typeof record.actualModel === 'string'
      ? { actualModel: record.actualModel }
      : {}),
    // Feature 031 T040 — surface the row's correlation id so the UI can
    // gate the "expand session log" affordance on whether the row was
    // written by a 031-aware runner. Legacy 014/024 records omit it.
    ...(typeof record.correlationId === 'string'
      ? { correlationId: record.correlationId }
      : {})
  });
}

function deriveStatus(record: InvocationRecord): WakeUpAttemptStatus {
  if (record.status) return record.status;
  if (record.skipped || record.lockAcquired === false) return 'skipped';
  if (record.timedOut || record.errorReason === 'claude-watchdog-killed') return 'timed-out';
  if (record.claudeExitCode === 0 && !record.errorReason) return 'succeeded';
  return 'failed';
}

function truncateWithFlag(input: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.byteLength(input, 'utf8');
  if (bytes <= maxBytes) return { value: input, truncated: false };
  const suffix = '[truncated]';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  let out = input;
  while (Buffer.byteLength(out, 'utf8') + suffixBytes > maxBytes && out.length > 0) {
    out = out.slice(0, -1);
  }
  return { value: `${out}${suffix}`, truncated: true };
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
