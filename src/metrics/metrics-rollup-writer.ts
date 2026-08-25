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
import { boundForCaller, holdOrdering } from '../lib/io-barrier';
import { streamRollup } from './metrics-rollup-stream';
import type { SanitizedLogger } from '../lib/logger';
import { resolveContainedLink } from '../lib/path-containment';
import { openWithinRoot } from '../lib/safe-open';
import {
  normalizeEvidenceFailureCause,
  type EvidenceHealthReporter
} from '../services/evidence-health/evidence-health-monitor';
import {
  METRICS_ROLLUP_FILENAME,
  METRICS_ROLLUP_SCHEMA_VERSION,
  composeCumulativeTotals,
  serializeCarryForward,
  serializeMetricsRollupRecord,
  type MetricsRollupRecord,
  type RollupTerminalStatus
} from './metrics-rollup';

/**
 * Per-append timeout, matching `AuditLogWriter`'s. A wedged disk must not stall
 * a terminal transition — the append is abandoned and the failure reported.
 */
const APPEND_TIMEOUT_MS = 5000;

/**
 * FR-R3-082 (T1091) — the size at which the rollup is trimmed.
 *
 * 8 MiB, which is `DEFAULT_MAX_READ_BYTES`: a trimmed rollup is therefore always
 * readable in one bounded pass, so the trim and the reader's bound agree by
 * construction rather than by two numbers happening to be compatible.
 */
const TRIM_THRESHOLD_BYTES = 8 * 1024 * 1024;

/**
 * How many records survive a trim.
 *
 * A count rather than a byte budget: records are near-uniform (a few hundred
 * bytes), and a count is what a reader can reason about — "the last 5,000 runs
 * are itemised, everything before them is in the header".
 */
const RETAINED_RECORDS_AFTER_TRIM = 5_000;

/** FR-R3-082 (T1098) — the rollup's path, as the segments the walk walks. */
const ROLLUP_LEAF = METRICS_ROLLUP_FILENAME;
const ROLLUP_SEGMENTS: readonly string[] = ['.schegent', ROLLUP_LEAF];

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
  /**
   * FR-R3-082 (T1089) — the outstanding write the chain is holding on.
   *
   * The chain link does not resolve until this does, even when the caller has
   * already been told the append timed out. A caller-bound expiry that released
   * the chain is precisely the reorder this item removes.
   */
  private pendingWrite: Promise<void> = Promise.resolve();
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
    // FR-R3-082 (T1089) — the chain waits for the OUTSTANDING WRITE, not merely
    // for the caller's view of it. `next` settles when the caller is answered,
    // which a timeout can make early; `pendingWrite` settles when the bytes are
    // really done.
    this.writeChain = next.then(
      () => this.pendingWrite,
      () => this.pendingWrite
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
    // FR-R3-082 (T1091) — after the append, never instead of it. A trim that
    // could refuse an append would make the durable record's availability
    // depend on its own size.
    await this.trimIfOversized();
    return { outcome: 'appended' };
  }

  private async write(line: string): Promise<void> {
    this.gitignoreEnsure ??= ensureSchegentGitignore(this.deps.workspaceRoot, this.deps.logger);
    await this.gitignoreEnsure;

    // FR-R3-082 (T1089) — the I/O barrier, in the shape `FR-R3-050` established
    // for `AuditLogWriter`. Applied rather than reinvented, because a second
    // shape for "what does a timed-out evidence append mean" is a second answer
    // to the same question.
    //
    // What this replaces was `Promise.race([appendFile, setTimeout])`. `race`
    // reports whichever side settles first and cannot cancel the other: the
    // timer fired, the chain link resolved, and the append was still in flight —
    // free to land after the NEXT append had already been written. That is
    // `M-02`'s shape exactly, and the file's own header admitted the adjacent
    // half ("the file is never rewritten, never trimmed").
    //
    // Two guarantees, two mechanisms, which is the whole correction:
    //   - `settled` resolves when the write really settles. No timeout on it.
    //   - the CHAIN holds on `settled`, so nothing interleaves with a write the
    //     caller gave up on.
    //   - the CALLER's promise is bounded, so a wedged filesystem does not stall
    //     a phase; it reports `ETIMEDOUT` and the accounting downstream is
    //     unchanged.
    const settled = this.appendBytes(line);
    this.pendingWrite = holdOrdering(settled, (barrierMs) => {
      this.deps.logger.warn(
        'metrics rollup append ordering is no longer guaranteed; an append stayed ' +
          'in flight past the ordering barrier',
        { barrierMs }
      );
    });
    await boundForCaller(settled, APPEND_TIMEOUT_MS, () =>
      Object.assign(new Error('metrics rollup append timed out'), { code: 'ETIMEDOUT' })
    );
  }

  /**
   * The write itself, with no bound on it. Whoever needs one wraps this.
   *
   * `protected` rather than `private` so a test can wedge it by subclassing.
   * The alternative was an injected write port, and this file is in a round that
   * has spent several items establishing what an injected write port costs: it
   * is a pathname write by another name, it has to be defaulted, and a default
   * is off in production the moment someone forgets. A subclass adds no
   * production surface at all — nothing constructs one but a test.
   */
  protected async appendBytes(line: string): Promise<void> {
    // FR-R3-082 (T1098) — one open that walks and refuses, replacing raw
    // `fs.mkdir` + a containment VERDICT + `fs.appendFile` on the same pathname.
    //
    // The verdict this replaces was FR-R3-005's and it was correct as far as it
    // went: it refused a link planted AT the rollup. What it could not cover is
    // the interval between the verdict and the append, or a link at a component
    // above the leaf — and `.schegent/` is a directory a cloned workspace
    // controls. A refusal is reported as `path-refused` rather than `io-error`
    // so it reaches a phase-end warning (T1075) instead of reading as a disk
    // problem.
    const opened = await openWithinRoot(this.deps.workspaceRoot, ROLLUP_SEGMENTS, {
      flags: 'a',
      createDirs: true,
      dirMode: 0o700,
      fileMode: 0o600
    });
    if (opened.outcome === 'refused') {
      // A REFUSAL and a FAILURE are reported apart, and the walk already tells
      // them apart: `io-failed` carries the errno of a syscall that ran and went
      // wrong (a read-only file is `EACCES`, and the operator's fix is a
      // permission change), while every other reason means the path could not be
      // proven and no syscall against it was attempted. Collapsing the first into
      // `path-refused` would send an operator looking for a symlink that is not
      // there.
      throw Object.assign(new Error('metrics rollup path refused'), {
        code: opened.reason === 'io-failed' ? opened.errno : 'path-refused'
      });
    }
    try {
      await opened.handle.write(line, null, 'utf8');
    } finally {
      await opened.handle.close().catch(() => undefined);
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

  /**
   * FR-R3-082 (T1091) — trim and compact, preserving the totals exactly.
   *
   * The module's own header was the finding: "the file is never rewritten, never
   * trimmed". A durable rollup that only grows is one that eventually cannot be
   * loaded — and `FR-R3-009` built it precisely so `cumulativeCostUsd` would
   * stop decreasing when an archive was pruned, so a trim that simply dropped
   * the oldest records would reintroduce the defect the file exists to prevent.
   *
   * So the discarded records are not discarded: their contribution is folded
   * into a carry-forward header written ahead of the retained ones, and every
   * reader sums header + records. A trim may lose HISTORY; it may never lose
   * TOTALS, and those are different things.
   *
   * Rewritten through a temp file and published with a rename, so a crash
   * mid-trim leaves the previous rollup intact rather than a half-written one.
   * The rename is the atomic-publish shape the migration ledger records as its
   * remaining residual — it is the same trade every durable file in this
   * repository makes, and it is listed there rather than implied here.
   */
  private async trimIfOversized(): Promise<void> {
    try {
      // The SIZE first, from a stat, before anything reads or parses a line.
      //
      // This runs on every append and the append is awaited by the terminal
      // transition, so the common case — a rollup comfortably under the
      // threshold — must not pay a whole-file read and a `JSON.parse` per record
      // to discover that nothing needs doing. It used to.
      let sizeBytes: number;
      try {
        sizeBytes = (await fs.stat(this.rollupPath)).size;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
      if (sizeBytes <= TRIM_THRESHOLD_BYTES) return;

      const streamed = await streamRollup(this.deps.workspaceRoot, this.rollupPath);
      if (!streamed.available) return;

      // Newest last in an append-only file, so the retained window is the tail.
      const retained = streamed.records.slice(-this.retainedRecordsAfterTrim());
      const discarded = streamed.records.slice(0, streamed.records.length - retained.length);

      // The rewrite happens whenever the file is oversized, even when nothing is
      // discarded: a rollup can exceed the threshold on unparseable content
      // rather than on records, and compacting it back to what it actually holds
      // is the right answer to that too. When there is nothing to carry forward
      // and no existing header, no header is written — a compacted rollup is
      // then byte-for-byte what a fresh one would be.
      const carried =
        discarded.length === 0 && streamed.carryForward === undefined
          ? undefined
          : composeCumulativeTotals(discarded, [], streamed.carryForward);
      const header =
        carried === undefined
          ? ''
          : serializeCarryForward({
              totals: carried.totals,
              runs: carried.rollupRuns,
              trimmedThrough: discarded.length === 0 ? '' : discarded[discarded.length - 1]!.endedAt
            });
      // A REWRITE THROUGH THIS BUILD'S SCHEMA, and that costs something worth
      // naming: `parseMetricsRollupLine` produces a fixed record shape, so a
      // field a NEWER build added is already gone by the time the trim sees the
      // line, and re-serializing writes this build's field set back while
      // preserving the record's own `v`. A v1 host trimming a v2-written file
      // therefore strips the v2 fields and leaves `v: 2` claiming they are
      // there. Nothing today has a v2, so nothing is lost today; the moment the
      // schema moves, either the trim carries unknown fields through the parse
      // or it refuses to rewrite a record whose `v` exceeds its own. Recorded
      // here because this is the line that would do the damage.
      const body = retained.map((entry) => serializeMetricsRollupRecord(entry)).join('');

      // FR-R3-082 (T1098) — the temp file through the checked walk too. The
      // rename that publishes it is the atomic-publish residual the migration
      // ledger records by name: Node exposes no `renameat`, so the publish
      // cannot be made handle-relative here any more than it can anywhere else.
      const tempSegments = [...ROLLUP_SEGMENTS.slice(0, -1), `${ROLLUP_LEAF}.trim`];
      const temp = path.join(this.deps.workspaceRoot, ...tempSegments);
      const opened = await openWithinRoot(this.deps.workspaceRoot, tempSegments, {
        flags: 'w',
        createDirs: true,
        dirMode: 0o700,
        fileMode: 0o600
      });
      if (opened.outcome === 'refused') {
        throw Object.assign(new Error('metrics rollup trim path refused'), {
          code: 'path-refused'
        });
      }
      try {
        await opened.handle.write(header + body, null, 'utf8');
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
      // FR-R3-005's gate, satisfied on its own terms: a `rename` RELOCATES, so
      // both ends are proven through the link form before it runs. That is not
      // the same guarantee the walk gives — the residual is that `rename` cannot
      // be handle-relative — but the oracle is what this gate asks for and the
      // reasoning it encodes is right: a destructive call with no proof in front
      // of it is the shape FR-R3-005 removed.
      const from = await resolveContainedLink(temp, [this.deps.workspaceRoot]);
      const to = await resolveContainedLink(this.rollupPath, [this.deps.workspaceRoot]);
      if (from.outcome === 'refused' || to.outcome === 'refused') {
        throw Object.assign(new Error('metrics rollup trim publish refused'), {
          code: 'path-refused'
        });
      }
      await fs.rename(temp, this.rollupPath);
      // The dedup set is NOT narrowed to the retained ids. A discarded run's
      // contribution now lives in the carry-forward header, so re-appending it
      // would count it twice — once in the header, once as a live record — and
      // `append` short-circuits on exactly this set. Terminal-transition replay
      // relies on that ("the writer's run-id idempotence keeps a repeat at zero
      // appends"), so forgetting the discarded ids is what would make a trim
      // able to inflate `cumulativeCostUsd`. The set holds run-id strings only,
      // so keeping them costs almost nothing next to being wrong.
      //
      // `knownRunIds` is therefore left exactly as it is: it already holds every
      // id loaded from the file plus every id appended since, which is the whole
      // set the trim just split into header and body.
      for (const entry of retained) this.knownRunIds?.add(entry.runId);
    } catch (err) {
      // A failed trim is not a failed append. The record is already durable and
      // the file is merely larger than intended; reporting it as an evidence
      // failure would say the run's metrics were lost, which is untrue.
      const errno = (err as NodeJS.ErrnoException).code;
      this.deps.logger.warn('metrics rollup trim failed; the rollup keeps growing', {
        ...(typeof errno === 'string' ? { errno } : {})
      });
    }
  }

  /**
   * How many records survive a trim.
   *
   * `protected` for the same reason `appendBytes` is: a test that had to write
   * five thousand records to observe a discard would be testing its own patience
   * rather than the arithmetic. Nothing overrides it in production.
   */
  protected retainedRecordsAfterTrim(): number {
    return RETAINED_RECORDS_AFTER_TRIM;
  }

  private async readRunIds(): Promise<Set<string>> {
    // FR-R3-082 (T1093) — streamed, not `readFile`. This scan ran on every
    // append cycle against a file the module's own header described as one that
    // "is never rewritten, never trimmed"; between the two, the rollup was fully
    // resident whenever it was written to.
    const streamed = await streamRollup(this.deps.workspaceRoot, this.rollupPath);
    const ids = new Set<string>();
    for (const record of streamed.records) ids.add(record.runId);
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
