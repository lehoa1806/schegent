import { AUDIT_CHAIN_GENESIS, AUDIT_DIGEST_ALG, cutRecordFor, digestOf } from './audit-chain';
import { errorMessage } from '../lib/errors';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { AuditEntry } from './audit-entry';
import { AUDIT_SCHEMA_VERSION } from '../contracts/audit-events';
import { boundForCaller, holdOrdering } from '../lib/io-barrier';
import type { SanitizedLogger } from '../lib/logger';
import {
  AuditPayloadValidationError,
  projectAuditPayload
} from './audit-payload';
import { ensureSchegentGitignore } from './schegent-gitignore';
import { openWithinRoot, openWithinRootByPath, type SafeOpenRefusal } from '../lib/safe-open';
import {
  resolveContainedLink,
  type ContainmentRefusal
} from '../lib/path-containment';
import {
  normalizeEvidenceFailureCause,
  type EvidenceHealthReporter
} from '../services/evidence-health/evidence-health-monitor';

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
const DEFAULT_MAX_ARCHIVES = 10;
const DEFAULT_MAX_ARCHIVE_AGE_MS = 90 * 24 * 60 * 60 * 1000;

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
   * The digest the NEXT entry links to. FR-R3-112 (FR-124).
   *
   * Starts at the genesis marker, which is distinct from an empty string on purpose: "the chain
   * starts here" must not read the same as "someone removed the link". On a writer opened over an
   * existing log this is re-seeded from the last line by `seedChainFrom`, because a fresh writer
   * that restarted the chain mid-file would fabricate a break at every host restart.
   */
  private lastDigest: string = AUDIT_CHAIN_GENESIS;

  private readonly config: AuditLogConfig;
  private readonly logger: SanitizedLogger;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<AuditAppendListener>();
  private gitignoreEnsure: Promise<void> | null = null;
  /** FR-R3-112 — one-shot chain seed; see `ensureChainSeeded`. */
  private chainSeed: Promise<void> | null = null;

  constructor(
    config: Partial<AuditLogConfig> & { workspaceRoot: string },
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
    // Retention previously only ran during rotation. A long-lived host
    // that never trips the size/age threshold for the active log would
    // accumulate archives indefinitely (e.g. a developer who never
    // closes VS Code and whose audit log stays under the 5 MiB floor).
    // Schedule one sweep on construction so process startup brings the
    // on-disk archive set back inside the retention budget. The sweep is
    // best-effort — failures stay in the runtime log, never block init.
    this.writeChain = this.writeChain.then(() => this.pruneArchives()).catch(() => {
      // pruneArchives already logs internally; swallow so a later
      // append cannot rejection-chain off the startup sweep.
    });
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
   * Re-seed the chain from the last line already on disk.
   *
   * FR-R3-112. Without this, every host restart would begin a new chain mid-file and a verifier
   * would report a break at each one — which is the false-positive shape that gets a verifier
   * turned off. The caller supplies the line because reading the log is the caller's business (it
   * knows the rotation naming); this class only links.
   *
   * An unreadable or absent tail leaves the genesis marker, which is the honest state for a log
   * this writer has not yet seen.
   */
  public seedChainFrom(lastLine: string | null): void {
    const trimmed = lastLine?.trim() ?? '';
    this.lastDigest = trimmed.length === 0 ? AUDIT_CHAIN_GENESIS : digestOf(trimmed);
  }

  /**
   * FR-R3-112 — seed the chain from the log already on disk, once per writer.
   *
   * WITHOUT THIS THE CHAIN BREAKS AT EVERY RESTART, and the break looks exactly like tampering.
   * A fresh writer starts at the genesis marker; if the file already holds chained entries, the
   * first append after activation writes `prevDigest: "genesis"` into the middle of the log, and
   * the verifier reports a break at that entry. `seedChainFrom` existed for precisely this and
   * nothing called it — the half-wired shape this round has been removing all along, in the
   * mechanism built to detect a different kind of dishonesty. Found by reading the call graph of
   * my own code rather than by a test, which is why the test below it now exists.
   *
   * READS THE WHOLE FILE and keeps the last non-empty line. A tail read would be cheaper, and it
   * is not worth the complexity here: the log rotates at 5 MiB by default, this runs once per
   * activation, and a partial tail read that lands mid-line would seed from a fragment — which
   * would produce the very break it is here to prevent.
   *
   * An unreadable or absent file leaves the genesis marker, which is the honest state for a log
   * this writer has not seen: a chain that begins now.
   */
  private ensureChainSeeded(): Promise<void> {
    this.chainSeed ??= (async (): Promise<void> => {
      // Through the canonical walk, like every other access to this file. A raw read would follow
      // a planted `.schegent` symlink and seed the chain from a log outside the workspace — which
      // would then make every entry this writer appends verify against someone else's history.
      const opened = await openWithinRoot(
        this.config.workspaceRoot,
        [SCHEGENT_DIR_NAME, AUDIT_LOG_NAME],
        { flags: 'r' }
      );
      if (opened.outcome === 'refused') {
        this.seedChainFrom(null);
        return;
      }
      try {
        const body = await opened.handle.readFile('utf8');
        const lines = body.split('\n').filter((line) => line.trim().length > 0);
        this.seedChainFrom(lines.length === 0 ? null : (lines[lines.length - 1] as string));
      } catch {
        // ENOENT on a fresh workspace is the common case and is not a failure.
        this.seedChainFrom(null);
      } finally {
        await opened.handle.close().catch(() => undefined);
      }
    })();
    return this.chainSeed;
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
    // FR-R3-112 (FR-124, FR-127) — the chain link.
    //
    // Added AFTER sanitization and the secret check, so the digest covers exactly the bytes that
    // reach disk. Hashing the pre-sanitization object would make the chain verify against something
    // no file contains.
    //
    // FAIL-CLOSED, and this is the load-bearing part. A digest failure is an APPEND failure: the
    // throw below reaches the existing evidence-health machinery, which is what turns an unwritable
    // audit sink into `unavailable`. What must never happen is an unchained entry — a line with no
    // `prevDigest`, or one carrying the genesis marker mid-file, would make every later entry
    // unverifiable while looking ordinary, which is the tampering this exists to detect wearing the
    // costume of a bug.
    // Seeded from the log on disk before the first link is computed, so a restart continues the
    // chain instead of restarting it mid-file. One read per writer, awaited here because the
    // digest below depends on its result.
    await this.ensureChainSeeded();
    //
    // THE LINK IS COMPLETE BEFORE ANY BYTE IS WRITTEN. Serialization, JSON encoding and hashing all
    // happen here, and only a line whose successor's link is already computable is handed to the
    // writer. An earlier shape hashed the line AFTER the write was queued: a hash failure there
    // would have left the entry on disk and `lastDigest` stale, so the NEXT entry would link to the
    // wrong predecessor — a broken chain produced by the chain's own error path, indistinguishable
    // from an edit. Failing before the write cannot do that.
    let line: string;
    let nextDigest: string;
    try {
      const chained: AuditEntry & { prevDigest: string; digestAlg: string } = {
        ...sanitized,
        prevDigest: this.lastDigest,
        digestAlg: AUDIT_DIGEST_ALG
      };
      line = `${JSON.stringify(chained)}\n`;
      nextDigest = digestOf(line.trimEnd());
    } catch (err) {
      this.logger.warn('audit chain link failed', { reasonCode: 'chain-link-failed' });
      throw err;
    }
    // The next entry links to THIS entry's bytes. Advanced before the write is awaited, on purpose:
    // the write chain is serialized, so the next append's link must already reflect this line even
    // if this write is still in flight. A digest advanced after the await would give two concurrent
    // appends the same predecessor.
    this.lastDigest = nextDigest;
    // Run doWrite regardless of the previous link's outcome so one wedged
    // or rejected append cannot stall the whole chain. The caller still
    // observes this call's outcome via the awaited `next` promise; the
    // self-healing `writeChain` swallows errors after warning.
    //
    // Include the failed entry's id + type + runId in the warn so a disk-full
    // / wedge incident is forensically attributable from the runtime log
    // alone — the prior generic "audit append failed: <message>" left
    // operators correlating timestamps by hand. Keep the message free of
    // path/body bytes (paths-free audit discipline, see hard rule 014).
    // `settled` resolves when the append REALLY settles -- no timeout on it.
    // The chain barrier and the caller's bound then hang off it separately,
    // because they are two different guarantees that one timer used to serve.
    const settled = this.writeChain.then(
      () => this.doWrite(line),
      () => this.doWrite(line)
    );
    // The barrier keeps its own link, so a caller-bound expiry cannot release
    // the chain and let an abandoned write interleave with the next append.
    // FR-R3-082 (T1089) — the two helpers moved to `lib/io-barrier.ts` so the
    // metrics rollup writer uses THIS shape rather than a second copy of it.
    // Behaviour is unchanged; the reporting stays here, where the wording that
    // suits an audit log lives.
    this.writeChain = holdOrdering(
      settled,
      (barrierMs) => {
        this.logger.warn(
          'audit append ordering is no longer guaranteed; an append stayed ' +
            'in flight past the ordering barrier',
          { code: ORDERING_UNGUARANTEED_CODE, barrierMs }
        );
      },
      ORDERING_BARRIER_TIMEOUT_MS
    );
    const next = boundForCaller(settled, APPEND_TIMEOUT_MS, () =>
      new Error(`audit append timed out after ${APPEND_TIMEOUT_MS}ms`)
    );
    // The warn hangs off the caller's view, not off the chain: it reports what
    // the caller was told, and putting it back on the chain would reintroduce
    // exactly the release this fix removes. `void` because the branch is
    // deliberate -- `next` is awaited below, and a `.catch` on a derived promise
    // does not consume the rejection the caller still receives.
    void next.catch((err) => {
      const code = (err as NodeJS.ErrnoException).code;
      const shouldWarn = this.evidenceHealth?.reportFailure(
        'audit',
        normalizeEvidenceFailureCause(code ?? (err as Error).message)
      ) ?? true;
      if (shouldWarn) {
        this.logger.warn(
          'audit append failed; structured evidence is unavailable',
          {
            eventId: sanitized.id,
            eventType: sanitized.eventType,
            runId: sanitized.runId,
            ...(typeof code === 'string' ? { errno: code } : {})
          }
        );
      }
    });
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

  private async doWrite(line: string): Promise<void> {
    await this.ensureRuntimeGitignore();
    await this.maybeRotate();
    // FR-R3-053 (H-02) — opened through the safe walk, never `path.join` +
    // `mkdir -p` + `appendFile`. All three of those follow symlinks, so a
    // `.schegent` symlink already present in the workspace redirected the next
    // append out of it -- the append-only evidence record, written somewhere
    // else, with no race required. Reproduced in
    // `tests/unit/audit/audit-path-containment.test.ts`.
    //
    // Reopened per append rather than held across the run, deliberately: the
    // rotation between these two lines replaces the file, so a retained handle
    // would keep appending to the rotated-away inode. Holding the descriptor is
    // the right shape for a sink that never rotates; this one does. The
    // no-race hole is closed either way, because every open re-walks.
    const opened = await openWithinRoot(
      this.config.workspaceRoot,
      [SCHEGENT_DIR_NAME, AUDIT_LOG_NAME],
      { flags: 'a', createDirs: true, dirMode: 0o700, fileMode: 0o600 }
    );
    if (opened.outcome === 'refused') {
      throw new AuditPathRefusedError(opened.reason, opened.errno);
    }
    try {
      // No timeout here. Whoever needs a bound wraps this; the chain needs the
      // real settlement, and racing it away in here is what lost the ordering.
      await opened.handle.write(line, null, 'utf8');
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }

  private ensureRuntimeGitignore(): Promise<void> {
    this.gitignoreEnsure ??= ensureSchegentGitignore(this.config.workspaceRoot, this.logger);
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
    const ageMs = Date.now() - stat.mtimeMs;
    const ageExceeded = ageMs >= this.config.rotationMaxAgeMs;
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
      { flags: 'a', createDirs: true, dirMode: 0o700, fileMode: 0o600 }
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
