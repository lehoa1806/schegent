import {
  AUDIT_CHAIN_GENESIS,
  AUDIT_DIGEST_ALG,
  collectChainFiles,
  cutRecordFor,
  digestOf,
  readChainTail,
  readCutLink,
  verifyAuditChainThrough,
  type ChainCheck,
  type ChainTail
} from './audit-chain';
import {
  classifyLoss,
  settleCheckpointMode,
  type AuditCheckpointPort,
  type CheckpointMode,
  type CheckpointOrigin,
  type CheckpointRead
} from './audit-checkpoint';
import { errorMessage } from '../lib/errors';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { AuditEntry } from './audit-entry';
import { AUDIT_SCHEMA_VERSION } from '../contracts/audit-events';
import { boundForCaller, holdOrdering } from '../lib/io-barrier';
import type { SanitizedLogger } from '../lib/logger';
import {
  AuditPayloadValidationError,
  projectAuditPayload
} from './audit-payload';
import { ensureSchegentGitignore } from './schegent-gitignore';
import { AuditGenerationClock } from './audit-generation-sidecar';
import {
  AuditNotOwnerError,
  OWNER_FOR_TESTS,
  type AuditWriteAuthority
} from './audit-write-authority';
import {
  AuditAppendTimeoutError,
  AuditPartialWriteError,
  classifyAuditWriteFailure
} from './audit-write-failure';
import {
  AUDIT_INTEGRITY_CONDITION_EVENT,
  DAMAGE_DIGEST_ALG,
  HISTORY_MISSING_CAUSE,
  HISTORY_RESET_CONDITION,
  HISTORY_SHORTER_CAUSE,
  INTEGRITY_CONDITION_VERSION,
  type HistoryLossCode
} from '../contracts/audit-integrity-condition';
import { NarrowingReporter, narrowRotatedFiles } from '../lib/evidence-narrowing';
import { openWithinRoot, openWithinRootByPath, type SafeOpenRefusal } from '../lib/safe-open';
import {
  resolveContainedLink,
  type ContainmentRefusal
} from '../lib/path-containment';
import type { EvidenceHealthReporter } from '../services/evidence-health/evidence-health-monitor';

export interface AuditLogConfig {
  workspaceRoot: string;
  rotationSizeBytes: number;
  rotationMaxAgeMs: number;
  /** Maximum number of rotated archives kept. Older archives are pruned. */
  retentionMaxArchives: number;
  /** Maximum age (ms) for rotated archives. Older archives are pruned. */
  retentionMaxArchiveAgeMs: number;
}

// FR-R3-085 — exported so the operator-facing retention disclosure DERIVES these
// bounds rather than restating them. A restated bound is the class that recurred
// three times in this round; `retention-disclosure.ts` reads these and a gate
// fails when the rendered document and these values disagree.
export const AUDIT_ROTATION_DEFAULT_SIZE_BYTES = 5 * 1024 * 1024;
export const AUDIT_ROTATION_DEFAULT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SIZE = AUDIT_ROTATION_DEFAULT_SIZE_BYTES;
const DEFAULT_AGE_MS = AUDIT_ROTATION_DEFAULT_AGE_MS;
export const AUDIT_ARCHIVE_DEFAULT_MAX_COUNT = 10;
export const AUDIT_ARCHIVE_DEFAULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ARCHIVES = AUDIT_ARCHIVE_DEFAULT_MAX_COUNT;
const DEFAULT_MAX_ARCHIVE_AGE_MS = AUDIT_ARCHIVE_DEFAULT_MAX_AGE_MS;

/**
 * Floor for `rotationMaxAgeMs` retention. A maliciously low retention
 * (e.g. 1 minute) would silently delete recent compliance evidence on
 * the next rotation pass. Pinning the floor here lets the public
 * `retentionMaxArchiveAgeMs` knob remain operator-tunable while
 * preserving the 7-day evidence window that downstream incident
 * response assumes.
 */
const RETENTION_MAX_ARCHIVE_AGE_FLOOR_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The CALLER's latency bound on one append. A wedged disk (NFS mount under
 * load, full filesystem with delayed-allocation backpressure) must not stall
 * the phase that is waiting on this entry, so on expiry the caller's promise
 * rejects and the failure is logged via the fallback logger.
 *
 * It bounds the CALLER ONLY. It does not release the write chain, and it does
 * not cancel the append -- Node offers no way to abort an in-flight
 * `fs.appendFile`, so the write is still live after this fires.
 * `ORDERING_BARRIER_TIMEOUT_MS` is what governs the chain.
 */
const APPEND_TIMEOUT_MS = 5000;

/**
 * FR-R3-053 (H-02) — the audit log's path could not be safely opened.
 *
 * A distinct error type rather than a bare `Error`, so the chain's existing
 * failure handling records WHY as a bounded code. `symlink-component` on the
 * audit path is not a disk problem: it means something placed a link where the
 * evidence directory belongs, which an operator must see as such.
 */
export class AuditPathRefusedError extends Error {
  public constructor(
    public readonly reason: SafeOpenRefusal,
    public readonly errno: string
  ) {
    super(`audit path refused: ${reason} (${errno})`);
    this.name = 'AuditPathRefusedError';
  }
}

/**
 * FR-R3-053 — the two path segments, named once. `logPath` and the safe open
 * both use them, so the pathname an operator is shown cannot drift from the one
 * the writer actually opens.
 */
const SCHEGENT_DIR_NAME = '.schegent';
const AUDIT_LOG_NAME = 'audit.log';
/** FR-R3-112 — the cut-record file, beside the log and never one of its archives. */
const AUDIT_CUTS_NAME = 'audit.log.cuts';

/**
 * Feature 217 (FR-004) — owner-only, declared once for every open that writes,
 * and the mode an archive retention keeps is narrowed to. The audit chain is
 * evidence of what ran on this machine, and a 022 umask made it readable by
 * every local account.
 */
const AUDIT_DIR_MODE = 0o700;
const AUDIT_FILE_MODE = 0o600;

/**
 * The CHAIN's ordering barrier: how long append N+1 waits for append N to
 * really settle before giving up on ordering.
 *
 * These were once the same timer, and that was the defect (FR-R3-050, M-02).
 * `Promise.race` reports whichever side settles first; it cannot cancel the
 * loser. So when the 5s bound fired, the caller was told the append failed AND
 * the chain advanced -- while the abandoned write was still in flight. The next
 * link may rotate the log or append its own line, so that write could land in a
 * generation it does not belong to, or after a line that was written later.
 * Silent, and indistinguishable from success on inspection.
 *
 * Deliberately far above the caller's bound: it exists for a permanently wedged
 * device, not for a slow one. Unbounded was the first answer and is wrong --
 * it stops the audit pipeline forever and loses every subsequent entry, whereas
 * a recorded reorder is still evidence. On expiry ordering really is lost, so
 * the writer says so (`ORDERING_UNGUARANTEED_CODE`) rather than letting the log
 * imply a sequence it no longer has.
 */
const ORDERING_BARRIER_TIMEOUT_MS = 60_000;

/**
 * Logged when the barrier above expires. Code-resident and stable so an
 * operator can grep one string to learn that audit ordering is not guaranteed
 * from that point in the run.
 *
 * NOT added to `RECORDABLE_PHASE_END_WARNINGS`: nothing routes a writer-level
 * code into `diagnosticWarnings` (only the runner layer produces those), so an
 * entry there would be allowlist surface no producer can reach.
 */
const ORDERING_UNGUARANTEED_CODE = 'audit-append-ordering-unguaranteed';

/** The `runId` of a row the writer itself authors (an integrity condition): there is no Run to name. */
const AUDIT_WRITER_RUN_ID = 'audit-writer';

/**
 * Strict matcher for current and legacy timestamped archive names so the
 * retention sweep cannot accidentally pick up unrelated `audit.log.*`
 * siblings (e.g. an operator-deposited `audit.log.backup`,
 * `audit.log.bak`, or a future schema variant). The pattern matches the
 * current millisecond/random suffix and the legacy seconds-only form are both
 * retained safely across upgrades.
 */
const ARCHIVE_STAMP_RE = /^\d{8}-\d{6}(?:-\d{3}-[0-9a-f]{8})?$/;

export type AuditAppendListener = (entry: AuditEntry) => void;

export interface AuditDisposable {
  dispose(): void;
}

export class AuditLogWriter {
  /**
   * The digest of the last row KNOWN to have landed, which the NEXT row links to (FR-R3-112; FR-R4-F03 FR-005).
   * Advanced only after the write settles: it used to advance before the write was queued, and a rejected
   * write was never rolled back, so the next row linked to bytes that never landed. `null` until the first
   * tail check has read the log.
   */
  private landedDigest: string | null = null;
  /** True until the chain's last line is read, and again after a rejected, short or expired step (W3). */
  private tailCheckOwed = true;
  /** The fence the last landed row was written under; a different fence owes a tail check (R10). */
  private writtenUnderFence: number | null = null;

  private readonly config: AuditLogConfig;
  private readonly logger: SanitizedLogger;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<AuditAppendListener>();
  private gitignoreEnsure: Promise<void> | null = null;
  /** Feature 217 (FR-003, data-model.md §2) — says once, path-free, what narrowing found. */
  private readonly narrowing = new NarrowingReporter('audit log:', (message) =>
    this.logger.warn(message)
  );

  /** FR-R4-F03 (W4; R10) — asked inside every step that writes; see `audit-write-authority.ts`. */
  private readonly authority: AuditWriteAuthority;
  /** FR-R4-F03 (W5) — latched by the first maintenance the authority grants. */
  private maintenanceRan = false;
  private readonly port: AuditCheckpointPort | undefined;
  private readonly generationClock: AuditGenerationClock;
  /**
   * FR-R4-F03 (W8; R15) — the head checkpoint this writer tracks: its mode, the chain position of the last
   * landed row, and the origin and first-seen time its records carry. `null` when it tracks none (`off`).
   */
  private cp: {
    mode: CheckpointMode;
    position: number;
    origin: CheckpointOrigin;
    establishedAtMs: number;
  } | null = null;
  private checkpointWarned = false;

  constructor(
    config: Partial<AuditLogConfig> & {
      workspaceRoot: string;
      /** Absent means the owner with a constant fence, for the many tests that build no lock. */
      authority?: AuditWriteAuthority;
      /** Absent means no head checkpoint: nothing is written outside the workspace (contract C4). */
      checkpoint?: AuditCheckpointPort;
    },
    logger: SanitizedLogger,
    private readonly evidenceHealth?: EvidenceHealthReporter
  ) {
    this.config = {
      workspaceRoot: config.workspaceRoot,
      rotationSizeBytes: config.rotationSizeBytes ?? DEFAULT_SIZE,
      rotationMaxAgeMs: config.rotationMaxAgeMs ?? DEFAULT_AGE_MS,
      retentionMaxArchives: config.retentionMaxArchives ?? DEFAULT_MAX_ARCHIVES,
      retentionMaxArchiveAgeMs: Math.max(
        config.retentionMaxArchiveAgeMs ?? DEFAULT_MAX_ARCHIVE_AGE_MS,
        RETENTION_MAX_ARCHIVE_AGE_FLOOR_MS
      )
    };
    this.logger = logger;
    // FR-R4-F04 (A2) — the live generation's start, observed once per generation and kept here.
    this.generationClock = new AuditGenerationClock({
      workspaceRoot: config.workspaceRoot,
      report: (code) => this.logger.warn('audit generation age: the sidecar could not be used', { reasonCode: code })
    });
    this.authority = config.authority ?? OWNER_FOR_TESTS;
    this.port = config.checkpoint;
    // FR-R4-F03 (FR-013; W1) — CONSTRUCTION IS READ-ONLY. It used to queue a retention sweep (narrow,
    // unlink, cut record) before any trust check or election. That is now `runArchiveMaintenance()`,
    // called from the trust gate in the window that won the election.
  }

  public get logPath(): string {
    return path.join(this.config.workspaceRoot, SCHEGENT_DIR_NAME, AUDIT_LOG_NAME);
  }

  // Feature 068 (US3) — cold-start replay (`readAuditTailColdStart`) is keyed
  // on the workspace root, not the resolved log path; expose the canonical
  // root the writer was constructed with so the projector can hand it through.
  public get workspaceRoot(): string {
    return this.config.workspaceRoot;
  }

  public subscribe(listener: AuditAppendListener): AuditDisposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      }
    };
  }

  private notify(entry: AuditEntry): void {
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (err) {
        this.logger.warn(`audit listener failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Queue one step on the write chain and keep the chain moving.
   *
   * The step runs after the previous one settles, whichever way it settled, and the next waits for
   * THIS step's real settlement under the same ordering barrier an append uses, so a wedged step is
   * reported once and cannot stop all recording.
   */
  private enqueue<T>(step: () => Promise<T>, afterLanding?: () => Promise<void>): Promise<T> {
    const settled = this.writeChain.then(step, step);
    // The next step waits for `afterLanding` (the checkpoint advance), but the caller does not: its
    // promise is `settled`. So an advance is ordered after its row and before the next row, and never
    // ahead of the log (W8).
    const gate = afterLanding === undefined ? settled : settled.then(afterLanding, () => undefined);
    this.writeChain = holdOrdering(
      gate,
      (barrierMs) => {
        // The step's outcome is unknown: it may yet land. The next step re-reads the tail before it
        // links (contract W2, R4), and the existing disclosure stands for a write that lands later.
        this.tailCheckOwed = true;
        this.logger.warn(
          'audit append ordering is no longer guaranteed; an append stayed ' +
            'in flight past the ordering barrier',
          { code: ORDERING_UNGUARANTEED_CODE, barrierMs }
        );
      },
      ORDERING_BARRIER_TIMEOUT_MS
    );
    return settled;
  }

  /**
   * FR-R4-F03 (FR-014; W5; R12) — the retention sweep, once, and only for the owner: one step on the
   * write chain that asks the authority first. A non-owner resolves `not-owner` and leaves the latch
   * open; the first granted call latches, and later ones resolve `already-ran`.
   */
  public runArchiveMaintenance(): Promise<'ran' | 'already-ran' | 'not-owner'> {
    return this.enqueue(async () => {
      if ((await this.authority.currentFence()) === null) return 'not-owner';
      if (this.maintenanceRan) return 'already-ran';
      this.maintenanceRan = true;
      await this.pruneArchives();
      return 'ran';
    });
  }

  /**
   * FR-R3-112 (FR-125) — report a chain break onto the evidence-health surface.
   *
   * ONE DIRECTION ONLY, on purpose. A verified chain says nothing about whether the last
   * append landed, so there is no `noteChainOk`: clearing a real append failure because a hash
   * walk passed would be a false all-clear on the one surface an operator consults to decide
   * whether to trust the record. The reporter stays private; this is the only way in.
   */
  public noteChainBreak(detail: string): void {
    this.logger.warn('audit chain verification found a break', { reasonCode: 'chain-broken' });
    const shouldWarn = this.evidenceHealth?.reportFailure('audit', 'chain-broken') ?? true;
    if (shouldWarn) {
      this.logger.warn('structured evidence cannot be relied on', { detail: detail.slice(0, 240) });
    }
  }

  /**
   * FR-R4-F03 (FR-016; W7) — report a loss of established history, through the same path as a broken
   * link: one warning, and the audit sink fails with `history-shorter` or `history-missing`. Written by
   * the command (verification) and by the writer's own tail check; neither writes a file.
   */
  public noteHistoryLoss(code: HistoryLossCode, detail: string): void {
    this.logger.warn('audit verification found loss of recorded entries', { reasonCode: code });
    const shouldWarn = this.evidenceHealth?.reportFailure('audit', code) ?? true;
    if (shouldWarn) this.logger.warn('structured evidence cannot be relied on', { detail: detail.slice(0, 240) });
  }

  /** The stored head checkpoint, read-only and in any window. No port means "unreachable", never "absent". */
  public async readCheckpoint(): Promise<CheckpointRead> {
    try {
      return (await this.port?.read()) ?? { status: 'unreadable', reason: 'unreachable' };
    } catch {
      return { status: 'unreadable', reason: 'unreachable' };
    }
  }

  /**
   * FR-R4-F03 (FR-017; TA4, R17) — retire the head checkpoint, as one step behind the authority. Refused
   * while any chain file exists (this never deletes or moves evidence), and never over a checkpoint it
   * cannot read. On `retired` the two history findings clear and the next tail check starts the next
   * history with a `history-reset` row.
   */
  public retireCheckpoint(): Promise<'not-owner' | 'files-present' | 'absent' | 'unavailable' | 'retired'> {
    return this.enqueue(async () => {
      if ((await this.authority.currentFence()) === null) return 'not-owner';
      if (collectChainFiles(path.dirname(this.logPath)) !== null) return 'files-present';
      const read = await this.readCheckpoint();
      if (read.status === 'absent' || read.status === 'retired') return 'absent';
      if (read.status === 'unreadable' || this.port === undefined) return 'unavailable';
      const now = Date.now();
      try {
        await this.port.write({
          ...read.checkpoint,
          state: 'retired',
          headDigest: '',
          position: 0,
          updatedAtMs: now,
          retiredAtMs: now,
          retiredPosition: read.checkpoint.position
        });
      } catch {
        return 'unavailable';
      }
      this.evidenceHealth?.clearAuditIntegrity?.([HISTORY_SHORTER_CAUSE, HISTORY_MISSING_CAUSE]);
      this.tailCheckOwed = true;
      return 'retired';
    });
  }

  public async append(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> {
    let projectedPayload: Record<string, unknown>;
    try {
      projectedPayload = projectAuditPayload(entry.eventType, entry.payload);
    } catch (err) {
      const reasonCode = err instanceof AuditPayloadValidationError
        ? err.reasonCode
        : 'projection-failed';
      this.logger.warn('audit payload rejected', {
        eventType: entry.eventType,
        reasonCode
      });
      throw err;
    }
    const full: AuditEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
      payload: projectedPayload,
      schemaVersion: entry.schemaVersion ?? AUDIT_SCHEMA_VERSION,
      // The workflow runId IS the per-run correlation identifier. Threading it
      // explicitly into the audit entry keeps `correlationId` greppable across
      // every emitted event (workflow, queue, phase, monitor, audit-pipeline).
      correlationId: entry.correlationId ?? entry.runId
    };
    const sanitized = this.logger.sanitizeRecord(full as unknown as Record<string, unknown>) as unknown as AuditEntry;
    if (JSON.stringify(sanitized.payload) !== JSON.stringify(projectedPayload)) {
      this.logger.warn('audit payload rejected', {
        eventType: entry.eventType,
        reasonCode: 'secret-detected'
      });
      throw new AuditPayloadValidationError('secret-detected');
    }
    // FR-R4-F03 (W2) — the link is computed INSIDE the serialized step, from the last row that landed.
    // `settled` resolves when the step really settles; the chain barrier and the caller's bound hang
    // off it separately (FR-R3-050, M-02).
    const settled = this.enqueue(() => this.writeStep(sanitized), () => this.advanceCheckpoint());
    const next = boundForCaller(settled, APPEND_TIMEOUT_MS, () => new AuditAppendTimeoutError(APPEND_TIMEOUT_MS));
    // The notice hangs off the caller's view, not off the chain: it reports what the caller was
    // told, and putting it back on the chain would reintroduce the release the barrier removed.
    // `void` because the branch is deliberate -- `next` is awaited below, and a `.catch` on a
    // derived promise does not consume the rejection the caller still receives.
    void next.catch((err) => this.noteAppendFailure(err, sanitized));
    try {
      await next;
    } finally {
      // Live subscribers should still learn that the event occurred even
      // when the durable audit sink rejects (for example disk-full or
      // permissions failures). The append promise still rejects, preserving
      // durability-first semantics for callers, while the sanitized live
      // projection can surface the failure context instead of going stale.
      this.notify(sanitized);
    }
    return sanitized;
  }

  /**
   * FR-R4-F03 (FR-006; W6) — report one rejected append: one notice and one health report, whatever came
   * before it, since a rejected entry is never retried. No path or body (hard rule 014). A not-owner
   * refusal is noticed where it is decided (W4) and reports neither here.
   */
  private noteAppendFailure(err: unknown, entry: AuditEntry): void {
    const cause = classifyAuditWriteFailure(err);
    if (cause === null) return;
    this.evidenceHealth?.reportFailure('audit', cause);
    const code = (err as { code?: unknown }).code;
    this.logger.warn('audit append failed; structured evidence is unavailable', {
      eventId: entry.id,
      eventType: entry.eventType,
      runId: entry.runId,
      cause,
      ...(typeof code === 'string' ? { errno: code } : {})
    });
  }

  /**
   * One write step, the only code that writes the log's rows (data-model §7): ask who may write, check
   * the tail when one is owed, link from the last row that landed, write, then move the link forward. A
   * failure leaves `landedDigest` where it was and owes a tail check, so the next step re-reads the log.
   */
  private async writeStep(entry: AuditEntry): Promise<void> {
    // FR-R4-F03 (W4, R10) — asked INSIDE the step, so a step queued while this window owned the workspace
    // asks again at its own turn. A different fence than the last row's means someone else may have
    // written since, with or without a gain event, so the tail is re-read before this step links.
    const fence = await this.authority.currentFence();
    if (fence === null) {
      this.logger.warn(
        `audit-not-owner: a ${entry.eventType} event was not recorded because this window does not ` +
          'own the workspace; the action belongs in the owner window'
      );
      throw new AuditNotOwnerError(entry.eventType);
    }
    if (fence !== this.writtenUnderFence) this.tailCheckOwed = true;
    if (this.tailCheckOwed) await this.checkTail();
    // The link is complete before any byte is written, over the sanitized entry, and fails closed: a
    // digest failure is an append failure, never an unchained line (FR-R3-112, FR-127).
    let line: string;
    try {
      const chained: AuditEntry & { prevDigest: string; digestAlg: string } = {
        ...entry,
        prevDigest: this.landedDigest ?? AUDIT_CHAIN_GENESIS,
        digestAlg: AUDIT_DIGEST_ALG
      };
      line = `${JSON.stringify(chained)}\n`;
    } catch (err) {
      this.logger.warn('audit chain link failed', { reasonCode: 'chain-link-failed' });
      throw err;
    }
    try {
      await this.doWrite(line);
    } catch (err) {
      this.tailCheckOwed = true;
      throw err;
    }
    this.landedDigest = digestOf(line.trimEnd());
    this.generationClock.landed(entry.timestamp);
    this.writtenUnderFence = fence;
    if (this.cp !== null) this.cp.position += 1;
    this.evidenceHealth?.reportSuccess('audit');
  }

  /**
   * FR-R4-F03 (FR-007, FR-008; W3, R5) — read the chain's last line as bytes, before linking. A valid line
   * is linked to, terminated first if it lacks its newline. An invalid one is KEPT as found, terminated,
   * and followed by one `damaged-tail` row; a line in an archive gets no newline (an archive is never
   * opened for writing). One `audit-tail-damaged` warning and no health failure (clarification Q2).
   */
  private async checkTail(): Promise<void> {
    const read = (name: string): Promise<Buffer> => this.readThroughWalk(name);
    const tail = await readChainTail(path.dirname(this.logPath), read);
    if (tail === null) {
      this.landedDigest = (await readCutLink(path.dirname(this.logPath), read)) ?? AUDIT_CHAIN_GENESIS;
    } else {
      if (!tail.endsWithNewline && tail.file === AUDIT_LOG_NAME) await this.appendBytes('\n');
      if (tail.valid) {
        this.landedDigest = tail.digest;
      } else {
        await this.recordDamage(tail);
      }
    }
    await this.settleCheckpoint();
    this.tailCheckOwed = false;
  }

  /** Write the `damaged-tail` row for an invalid last line, link the chain to it, and say so once. */
  private async recordDamage(tail: ChainTail): Promise<void> {
    const line = this.integrityRow(tail.previousDigest, {
      condition: 'damaged-tail',
      conditionVersion: INTEGRITY_CONDITION_VERSION,
      file: tail.file,
      line: tail.line,
      byteOffset: tail.byteOffset,
      byteLength: tail.bytes.length,
      digestAlg: DAMAGE_DIGEST_ALG,
      digest: createHash(DAMAGE_DIGEST_ALG).update(tail.bytes).digest('hex')
    });
    await this.appendBytes(line);
    this.landedDigest = digestOf(line.trimEnd());
    this.logger.warn(
      `audit-tail-damaged: the log's final line was not valid JSON; it was kept as found and ` +
        `recorded (${tail.file} line ${tail.line}, ${tail.bytes.length} bytes)`
    );
  }

  /** One `audit-integrity-condition` row, as a serialized line, linked to `previous` (genesis when none). */
  private integrityRow(previous: string | null, payload: Record<string, unknown>): string {
    return `${JSON.stringify({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      // No Run, so a sentinel id like the other system events carry (`trust-gate`, `system`): the line
      // parser drops a row whose `runId` is not a non-empty string, which would hide this row from every
      // reader and count it as a warning.
      runId: AUDIT_WRITER_RUN_ID,
      phase: 'audit-writer',
      iteration: 0,
      eventType: AUDIT_INTEGRITY_CONDITION_EVENT,
      outcome: 'info',
      payload: projectAuditPayload(AUDIT_INTEGRITY_CONDITION_EVENT, payload),
      schemaVersion: AUDIT_SCHEMA_VERSION,
      correlationId: AUDIT_WRITER_RUN_ID,
      prevDigest: previous ?? AUDIT_CHAIN_GENESIS,
      digestAlg: AUDIT_DIGEST_ALG
    })}\n`;
  }

  /**
   * FR-R4-F03 (FR-015, FR-016, FR-018; W3 step 3; R15) — settle the checkpoint mode from the stored
   * checkpoint and the chain, once per tail check. The checkpoint port is read once; the walk is made only
   * when the cheap answer (the head IS the tail) does not hold. A retired checkpoint with no history starts
   * the next one with a `history-reset` row; a finding of loss is reported through the broken-link path and
   * never advanced over; an unreadable checkpoint, or a chain that does not walk intact, means no tracking.
   */
  private async settleCheckpoint(): Promise<void> {
    const port = this.port;
    if (port === undefined) {
      this.cp = null;
      return;
    }
    const dir = path.dirname(this.logPath);
    let read: CheckpointRead;
    try {
      read = await port.read();
    } catch {
      read = { status: 'unreadable', reason: 'unreachable' };
    }
    const filesPresent = collectChainFiles(dir) !== null;
    const head = read.status === 'active' ? read.checkpoint.headDigest : undefined;
    let walk: ChainCheck | null = null;
    if (filesPresent && read.status !== 'unreadable' && head !== this.landedDigest) {
      try {
        const readFile = (name: string): Promise<Buffer> => this.readThroughWalk(name);
        walk = await verifyAuditChainThrough(dir, readFile, head === undefined ? {} : { probeDigest: head });
      } catch {
        walk = null;
      }
    }
    const settled = settleCheckpointMode(read, { filesPresent, tailDigest: this.landedDigest, walk });
    const mode = settled.mode;
    let position = settled.position;
    if (mode === 'reset' && read.status === 'retired') {
      const { retiredPosition = 0, retiredAtMs = 0 } = read.checkpoint;
      const line = this.integrityRow(null, {
        condition: HISTORY_RESET_CONDITION,
        conditionVersion: INTEGRITY_CONDITION_VERSION,
        retiredPosition,
        retiredAtMs
      });
      await this.appendBytes(line);
      this.landedDigest = digestOf(line.trimEnd());
      position = 1;
    }
    if (mode === 'loss') {
      const loss = classifyLoss(read, walk);
      this.noteHistoryLoss(
        loss.state === 'missing' ? HISTORY_MISSING_CAUSE : HISTORY_SHORTER_CAUSE,
        loss.state === 'missing'
          ? `the checkpoint expects ${loss.expected} chained entries and no audit file is present`
          : 'the log no longer reaches the checkpointed entry'
      );
    }
    if (mode === 'off') this.warnCheckpointUnavailable();
    const origin: CheckpointOrigin =
      mode === 'adopt' ? 'adopted' : mode === 'reset' ? 'reset' : read.status === 'active' ? read.checkpoint.origin : 'new';
    this.cp = {
      mode,
      position,
      origin,
      establishedAtMs: read.status === 'active' ? read.checkpoint.establishedAtMs : Date.now()
    };
  }

  private warnCheckpointUnavailable(): void {
    if (this.checkpointWarned) return;
    this.checkpointWarned = true;
    this.logger.warn(
      'audit-checkpoint-unavailable: the head checkpoint could not be read or written; loss detection is ' +
        'not tracking this window\'s log'
    );
  }

  /**
   * Advance the head checkpoint to the row that just landed (W8). Runs between this step and the next, so
   * it is ordered after its row and never ahead of it, and the caller does not wait for it. A failure
   * warns once, stops tracking for this writer, and never rejects an append (FR-018). `loss` and `off`
   * never advance, and neither does a writer that tracks nothing.
   */
  private async advanceCheckpoint(): Promise<void> {
    const cp = this.cp;
    const port = this.port;
    if (cp === null || port === undefined || this.landedDigest === null) return;
    if (cp.mode === 'loss' || cp.mode === 'off') return;
    const now = Date.now();
    // The first advance of a new, adopted or reset history establishes it; every later one keeps that time.
    const establishedAtMs = cp.mode === 'track' ? cp.establishedAtMs : now;
    try {
      await port.write({
        version: 1,
        workspaceKey: port.key,
        state: 'active',
        origin: cp.origin,
        headDigest: this.landedDigest,
        position: cp.position,
        establishedAtMs,
        updatedAtMs: now
      });
      cp.mode = 'track';
      cp.establishedAtMs = establishedAtMs;
    } catch {
      cp.mode = 'off';
      this.warnCheckpointUnavailable();
    }
  }

  /**
   * Read one chain file through the canonical walk, so a planted `.schegent` link is refused. An ARCHIVE
   * slot the walk refuses on containment grounds is skipped as an empty file: it is not evidence this
   * writer wrote, and a planted name must not stop all recording (feature 217, FR-003). The live log is
   * different, because the append that follows would be refused for the same reason.
   */
  private async readThroughWalk(name: string): Promise<Buffer> {
    const opened = await openWithinRoot(this.config.workspaceRoot, [SCHEGENT_DIR_NAME, name], {
      flags: 'r'
    });
    if (opened.outcome === 'refused') {
      if (name !== AUDIT_LOG_NAME && opened.reason !== 'io-failed') {
        this.logger.warn(`audit tail check skipped an archive slot the walk refused: ${opened.reason}`);
        return Buffer.alloc(0);
      }
      throw new AuditPathRefusedError(opened.reason, opened.errno);
    }
    try {
      return await opened.handle.readFile();
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }

  private async doWrite(line: string): Promise<void> {
    await this.ensureRuntimeGitignore();
    await this.maybeRotate();
    await this.appendBytes(line);
  }

  /**
   * Append bytes to the live log, and nothing else. Opened through the safe walk, never `appendFile`
   * (FR-R3-053, H-02: a planted `.schegent` link redirected the append out of the workspace), and reopened
   * per append because a rotation replaces the file. A write that returns short is a PARTIAL WRITE:
   * thrown, so the next step re-reads the end of the log (FR-022).
   */
  private async appendBytes(text: string): Promise<void> {
    const opened = await openWithinRoot(
      this.config.workspaceRoot,
      [SCHEGENT_DIR_NAME, AUDIT_LOG_NAME],
      { flags: 'a', createDirs: true, dirMode: AUDIT_DIR_MODE, fileMode: AUDIT_FILE_MODE }
    );
    if (opened.outcome === 'refused') {
      throw new AuditPathRefusedError(opened.reason, opened.errno);
    }
    this.narrowing.report(opened.narrowing);
    try {
      // No timeout here. Whoever needs a bound wraps this; the chain needs the real settlement, and
      // racing it away in here is what lost the ordering.
      // A real handle always answers; a test seam that wraps `write` may not, so the count is read
      // defensively and only a number that is SHORT is a partial write.
      const written = (await opened.handle.write(text, null, 'utf8')) as { bytesWritten?: number } | undefined;
      const expected = Buffer.byteLength(text, 'utf8');
      if (written?.bytesWritten !== undefined && written.bytesWritten < expected) {
        throw new AuditPartialWriteError(written.bytesWritten, expected);
      }
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }

  private ensureRuntimeGitignore(): Promise<void> {
    // Feature 217 (FR-003) — the drop runs before the first append's open, so on
    // a fresh but widened `.schegent/` it is the drop that narrows it.
    this.gitignoreEnsure ??= ensureSchegentGitignore(this.config.workspaceRoot, this.logger).then(
      (notices) => this.narrowing.report(notices)
    );
    return this.gitignoreEnsure;
  }

  private async maybeRotate(): Promise<void> {
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      stat = await fs.stat(this.logPath);
    } catch {
      return;
    }
    const sizeExceeded = stat.size >= this.config.rotationSizeBytes;
    // FR-R4-F04 (A1) — the age of the generation, from its oldest usable row, never from the file's mtime
    // (every append refreshes it, so a busy log never aged out). Asked only under the size threshold: the age
    // read loads the live log, and a log planted far past the threshold must not be loaded to rotate it.
    const ageExceeded =
      !sizeExceeded && Date.now() - (await this.generationClock.observe()) >= this.config.rotationMaxAgeMs;
    if (!sizeExceeded && !ageExceeded) return;
    // Milliseconds plus a UUID suffix prevent a burst of rotations in one
    // second from renaming over an earlier archive. The legacy seconds-only
    // shape remains recognized by retention for backward compatibility.
    const rotationTime = new Date();
    const milliseconds = String(rotationTime.getUTCMilliseconds()).padStart(3, '0');
    const stamp = `${formatStamp(rotationTime)}-${milliseconds}-${randomUUID().slice(0, 8)}`;
    const archive = `${this.logPath}.${stamp}`;
    // Feature FR-R3-005 — both ends, link form. `rename` acts on the directory
    // entries and follows neither, and the archive does not exist yet, so the
    // check that matters is the one on the directory they share. A refusal
    // leaves the live log where it is: an unrotated audit log is a large file,
    // and moving one out of the workspace is not the recovery.
    const ends = await Promise.all([
      resolveContainedLink(this.logPath, [this.config.workspaceRoot]),
      resolveContainedLink(archive, [this.config.workspaceRoot])
    ]);
    const refused = ends.find((verdict) => verdict.outcome === 'refused');
    if (refused && refused.outcome === 'refused') {
      this.warnContainmentRefusal('rotation', refused.reason);
      return;
    }
    try {
      await fs.rename(this.logPath, archive);
    } catch (err) {
      this.logger.warn(`audit log rotation failed: ${(err as Error).message}`);
      return;
    }
    this.generationClock.rotated();
    await this.pruneArchives();
  }

  /**
   * Prune rotated archives that exceed the retention budget.
   *
   * The active log file (`audit.log`) is never touched. Archives are matched
   * by the `audit.log.<stamp>` naming convention produced by `maybeRotate`.
   * Pruning is best-effort — failures are logged and swallowed so they cannot
   * block the write chain.
   */
  private async pruneArchives(): Promise<void> {
    const dir = path.dirname(this.logPath);
    const baseName = path.basename(this.logPath);
    const prefix = `${baseName}.`;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      // ENOENT (`.schegent` not yet created) is the normal cold-start
      // case for the startup sweep — there is nothing to prune, so
      // silently skip. Any other failure is logged for diagnostics.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.warn(`audit retention readdir failed: ${(err as Error).message}`);
      }
      return;
    }
    const archives: { fullPath: string; mtimeMs: number }[] = [];
    for (const name of entries) {
      if (name === baseName) continue;
      if (!name.startsWith(prefix)) continue;
      // Only sweep entries whose suffix matches our own stamp shape so
      // an operator-deposited `audit.log.backup` or `audit.log.bak`
      // cannot be deleted by our retention pass. The strict matcher
      // recognizes only current and legacy Schegent archive stamps.
      const stampSuffix = name.slice(prefix.length);
      if (!ARCHIVE_STAMP_RE.test(stampSuffix)) continue;
      const fullPath = path.join(dir, name);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isFile()) archives.push({ fullPath, mtimeMs: stat.mtimeMs });
      } catch {
        // ignore unreadable entries
      }
    }
    archives.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const now = Date.now();
    const keep = new Set<string>();
    for (let i = 0; i < archives.length && i < this.config.retentionMaxArchives; i++) {
      const entry = archives[i];
      if (now - entry.mtimeMs > this.config.retentionMaxArchiveAgeMs) continue;
      keep.add(entry.fullPath);
    }
    // Feature 217 (FR-005) — an archive is the live log renamed, and a rename
    // keeps the mode, so a log an earlier release left widened leaves widened
    // archives behind it that no open ever reaches. Narrowed where they lie,
    // before the prune below, which removes only what is not kept.
    this.narrowing.report(
      await narrowRotatedFiles([...keep], AUDIT_FILE_MODE, [this.config.workspaceRoot])
    );
    // FR-R3-112 (FR-126a) — a prune is the legitimate operation that looks most like
    // tampering, so it leaves a record saying what it removed. The lines are read BEFORE the
    // unlink, because after it the boundary digests are gone and the gap becomes
    // indistinguishable from a deletion. Best-effort, like the rest of this sweep: an
    // unreadable archive contributes nothing to the record rather than blocking the prune.
    const removedLines: string[] = [];
    for (const entry of archives) {
      if (keep.has(entry.fullPath)) continue;
      // Feature FR-R3-005 — the archive list came out of `readdir`, so these
      // names were never configured by anyone and the enumeration says nothing
      // about where they lead.
      const verdict = await resolveContainedLink(entry.fullPath, [this.config.workspaceRoot]);
      if (verdict.outcome === 'refused') {
        this.warnContainmentRefusal('retention', verdict.reason);
        continue;
      }
      // Read through the same canonical walk as every other access to this directory. The
      // name came out of `readdir`, so nobody configured it and the enumeration says nothing
      // about where it leads — the reason FR-R3-053 gave for the unlink below applies
      // identically to reading it.
      let body: string | null = null;
      const reading = await openWithinRootByPath(this.config.workspaceRoot, entry.fullPath, {
        flags: 'r'
      });
      if (reading.outcome === 'refused') {
        this.logger.warn(
          `audit retention refused to read an archive before pruning it: containment ` +
            `${reading.reason}; its range will be absent from the cut record`
        );
      } else {
        try {
          body = await reading.handle.readFile('utf8');
        } catch (err) {
          this.logger.warn(
            `audit retention could not read ${path.basename(entry.fullPath)} before pruning it; ` +
              `its range will be absent from the cut record: ${errorMessage(err)}`
          );
        } finally {
          await reading.handle.close().catch(() => undefined);
        }
      }
      try {
        await fs.unlink(entry.fullPath);
        if (body !== null) removedLines.push(...body.split('\n'));
      } catch (err) {
        this.logger.warn(
          `audit retention unlink failed for ${path.basename(entry.fullPath)}: ${(err as Error).message}`
        );
      }
    }
    await this.recordCut(removedLines);
  }

  /**
   * Write the cut record for one prune pass.
   *
   * IN ITS OWN FILE, and the file order is why. A prune removes the OLDEST end of history, so
   * the surviving entries link past the removed range and the record that explains the gap has
   * to be read before them. Appending it to the live log would place it at the newest end,
   * where a verifier walking forward would reach it long after the discontinuity it explains.
   * `scripts/verify-audit-chain.ts` reads this file first for exactly that reason.
   *
   * Not chained itself, and this is a stated limit rather than an omission: the cut file is one
   * more file on the same disk. It makes a prune DISTINGUISHABLE from a deletion; it does not
   * make a forged cut record impossible. `docs/security/threat-model.md` T3 says so.
   */
  private async recordCut(removedLines: readonly string[]): Promise<void> {
    const record = cutRecordFor(removedLines, Date.now());
    if (record === null) return;
    // Opened through the same canonical-path walk as the live log, not `fs.appendFile`.
    // FR-R3-053's finding applies here unchanged: `appendFile` follows symlinks, so a planted
    // `.schegent` or `audit.log.cuts` link would redirect the record that explains a prune out
    // of the workspace — and a cut record written somewhere else is a verification that reports
    // tampering for a prune that was recorded correctly.
    const opened = await openWithinRoot(
      this.config.workspaceRoot,
      [SCHEGENT_DIR_NAME, AUDIT_CUTS_NAME],
      { flags: 'a', createDirs: true, dirMode: AUDIT_DIR_MODE, fileMode: AUDIT_FILE_MODE }
    );
    if (opened.outcome === 'refused') {
      // Bounded and path-free, like every other refusal warning here. Not thrown: the prune
      // is best-effort by design and an unwritable cut file must not wedge the write chain —
      // but it is said loudly, because the archives are already gone.
      this.logger.warn(
        `audit cut record refused: containment ${opened.reason} (errno ${opened.errno}); the ` +
          'next verification will report a break at this boundary'
      );
      return;
    }
    this.narrowing.report(opened.narrowing);
    try {
      await opened.handle.write(`${JSON.stringify(record)}\n`, null, 'utf8');
    } catch (err) {
      // The archives are already gone. Say so loudly: the next verification will report a
      // break, and an operator needs to know it was this prune and not an edit.
      this.logger.warn(
        `audit retention pruned ${record.removedCount} entries but could not write the cut ` +
          `record; verification will report a break at that boundary: ${errorMessage(err)}`
      );
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }

  /**
   * Feature FR-R3-005 — bounded, path-free. Distinct from the failure warnings
   * above, which quote an errno message: those say the operation was attempted
   * and did not work, and this says it was never attempted.
   */
  private warnContainmentRefusal(operation: string, reason: ContainmentRefusal): void {
    this.logger.warn(`audit log ${operation} refused: containment ${reason}`);
  }
}

function formatStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
