// Feature FR-R3-009 (T387, T388) — the append-only metrics rollup writer.
//
// One record per terminal run, appended at the terminal transition while the
// audit evidence is still present. The file is never rewritten, never trimmed,
// and never recomputed: it is the only thing that keeps a cumulative total from
// shrinking when the audit corpus is pruned.
//
// Writes are best-effort with respect to run progress. A failure warns once per
// cause and is reported to `EvidenceHealthReporter` under the `metricsRollup`
// sink (`continue-degraded`) — it never fails a phase or a run. That is a
// deliberate asymmetry with the audit log, which is `fail-closed`: the audit log
// is the evidence, the rollup is a derived summary of it.

import * as fs from 'fs/promises';
import * as path from 'path';
import { ensureSchegentGitignore } from '../audit/schegent-gitignore';
import type { SanitizedLogger } from '../lib/logger';
import { resolveContainedForWrite } from '../lib/path-containment';
import {
  normalizeEvidenceFailureCause,
  type EvidenceHealthReporter
} from '../services/evidence-health/evidence-health-monitor';
import {
  METRICS_ROLLUP_FILENAME,
  METRICS_ROLLUP_SCHEMA_VERSION,
  parseMetricsRollupLine,
  serializeMetricsRollupRecord,
  type MetricsRollupRecord,
  type RollupTerminalStatus
} from './metrics-rollup';

/**
 * Per-append timeout, matching `AuditLogWriter`'s. A wedged disk must not stall
 * a terminal transition — the append is abandoned and the failure reported.
 */
const APPEND_TIMEOUT_MS = 5000;

/** The facts a caller supplies; the version marker is the writer's to stamp. */
export interface MetricsRollupAppend {
  readonly runId: string;
  readonly terminalStatus: RollupTerminalStatus;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly phasesTotal: number;
  readonly phasesCompleted: number;
  readonly phasesSkipped: number;
  readonly backendInvocations: number;
  readonly costUsd?: number;
}

export type MetricsRollupAppendOutcome =
  | { readonly outcome: 'appended' }
  | { readonly outcome: 'already-recorded' }
  | { readonly outcome: 'failed'; readonly cause: string };

export interface MetricsRollupWriterDeps {
  readonly workspaceRoot: string;
  readonly logger: SanitizedLogger;
  readonly evidenceHealth?: EvidenceHealthReporter;
}

export class MetricsRollupWriter {
  private readonly rollupPath: string;
  private writeChain: Promise<void> = Promise.resolve();
  private gitignoreEnsure: Promise<void> | null = null;
  /**
   * Run ids already present in the file, loaded once and then maintained in
   * memory. Lazily loaded so construction costs nothing at activation.
   */
  private knownRunIds: Set<string> | null = null;
  private knownRunIdsLoad: Promise<Set<string>> | null = null;

  constructor(private readonly deps: MetricsRollupWriterDeps) {
    this.rollupPath = path.join(deps.workspaceRoot, '.schegent', METRICS_ROLLUP_FILENAME);
  }

  public get filePath(): string {
    return this.rollupPath;
  }

  /**
   * Append one record for a terminal run (T387), at most once per run id (T388).
   *
   * Idempotence is enforced two ways because neither is sufficient alone: the
   * in-memory set catches a repeated terminal transition inside one host, and
   * the reader deduplicates by run id so a second host that appended before
   * seeing this one's write still yields a single counted run. Serializing on
   * `writeChain` is what makes the check-then-append pair atomic *within* a
   * host — two concurrent terminal transitions for the same run cannot both pass
   * the check.
   */
  public append(record: MetricsRollupAppend): Promise<MetricsRollupAppendOutcome> {
    const next = this.writeChain.then(
      () => this.doAppend(record),
      () => this.doAppend(record)
    );
    // Keep the chain alive regardless of this append's outcome; `doAppend`
    // resolves rather than rejects, so this is belt-and-braces against a
    // programming error inside it stalling every later append.
    this.writeChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async doAppend(record: MetricsRollupAppend): Promise<MetricsRollupAppendOutcome> {
    let known: Set<string>;
    try {
      known = await this.loadKnownRunIds();
    } catch (err) {
      return this.reportFailure(err, record.runId);
    }
    if (known.has(record.runId)) return { outcome: 'already-recorded' };

    const line = serializeMetricsRollupRecord({
      v: METRICS_ROLLUP_SCHEMA_VERSION,
      runId: record.runId,
      terminalStatus: record.terminalStatus,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationMs: record.durationMs,
      phasesTotal: record.phasesTotal,
      phasesCompleted: record.phasesCompleted,
      phasesSkipped: record.phasesSkipped,
      backendInvocations: record.backendInvocations,
      ...(record.costUsd === undefined ? {} : { costUsd: record.costUsd })
    });

    try {
      await this.write(line);
    } catch (err) {
      return this.reportFailure(err, record.runId);
    }
    // Only mark the run recorded once the bytes are accepted, so a transient
    // failure does not suppress a later retry for the same run.
    known.add(record.runId);
    this.deps.evidenceHealth?.reportSuccess('metricsRollup');
    return { outcome: 'appended' };
  }

  private async write(line: string): Promise<void> {
    const dir = path.dirname(this.rollupPath);
    await fs.mkdir(dir, { recursive: true });
    this.gitignoreEnsure ??= ensureSchegentGitignore(this.deps.workspaceRoot, this.deps.logger);
    await this.gitignoreEnsure;

    // Feature FR-R3-005 — write form. `appendFile` follows a symlink at the
    // target, so a link planted at `.schegent/metrics-rollup.jsonl` would write
    // wherever it points; the first append creates the file, so the leaf may
    // legitimately be absent. A refusal is a failed append, not a redirect.
    const verdict = await resolveContainedForWrite(this.rollupPath, [this.deps.workspaceRoot]);
    if (verdict.outcome === 'refused') {
      throw Object.assign(new Error('metrics rollup path refused'), { code: 'io-error' });
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        fs.appendFile(this.rollupPath, line, { encoding: 'utf8', mode: 0o600 }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Object.assign(new Error('metrics rollup append timed out'), { code: 'ETIMEDOUT' })),
            APPEND_TIMEOUT_MS
          );
        })
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private loadKnownRunIds(): Promise<Set<string>> {
    if (this.knownRunIds !== null) return Promise.resolve(this.knownRunIds);
    this.knownRunIdsLoad ??= this.readRunIds().then(
      (ids) => {
        this.knownRunIds = ids;
        return ids;
      },
      (err) => {
        // Let the next append retry the load rather than caching a failure as
        // an empty set, which would duplicate every existing record.
        this.knownRunIdsLoad = null;
        throw err;
      }
    );
    return this.knownRunIdsLoad;
  }

  private async readRunIds(): Promise<Set<string>> {
    let content: string;
    try {
      content = await fs.readFile(this.rollupPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
      throw err;
    }
    const ids = new Set<string>();
    for (const line of content.split('\n')) {
      const { record } = parseMetricsRollupLine(line);
      if (record !== null) ids.add(record.runId);
    }
    return ids;
  }

  private reportFailure(err: unknown, runId: string): MetricsRollupAppendOutcome {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const cause = normalizeEvidenceFailureCause(code ?? (err as Error | undefined)?.message);
    const shouldWarn = this.deps.evidenceHealth?.reportFailure('metricsRollup', cause) ?? true;
    if (shouldWarn) {
      // Counters and codes only — no path, no message body. The rollup is held
      // to the same paths-free standard as the structured audit log.
      this.deps.logger.warn('metrics rollup append failed; cumulative totals may regress after log rotation', {
        runId,
        cause
      });
    }
    return { outcome: 'failed', cause };
  }
}

export type MetricsRollupAppender = Pick<MetricsRollupWriter, 'append'>;

/** Shape a `MetricsRollupRecord` for tests and fixtures without the writer. */
export function rollupRecordFor(append: MetricsRollupAppend): MetricsRollupRecord {
  return {
    v: METRICS_ROLLUP_SCHEMA_VERSION,
    ...append
  };
}
