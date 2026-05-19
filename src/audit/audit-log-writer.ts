import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { AuditEntry } from './audit-entry';
import { AUDIT_SCHEMA_VERSION } from '../contracts/audit-events';
import type { SanitizedLogger } from '../lib/logger';
import { ensureSchegentGitignore } from './schegent-gitignore';

export interface AuditLogConfig {
  workspaceRoot: string;
  rotationSizeBytes: number;
  rotationMaxAgeMs: number;
  /** Maximum number of rotated archives kept. Older archives are pruned. */
  retentionMaxArchives: number;
  /** Maximum age (ms) for rotated archives. Older archives are pruned. */
  retentionMaxArchiveAgeMs: number;
}

const DEFAULT_SIZE = 5 * 1024 * 1024;
const DEFAULT_AGE_MS = 30 * 24 * 60 * 60 * 1000;
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
 * Per-append fs.appendFile timeout. A wedged disk (NFS mount under
 * load, full filesystem with delayed-allocation backpressure) could
 * otherwise stall the entire audit pipeline. On timeout the chained
 * promise resolves so subsequent appends can make progress; the
 * failure is logged via the fallback logger.
 */
const APPEND_TIMEOUT_MS = 5000;

/**
 * Strict matcher for `audit.log.<YYYYMMDD-HHMMSS>` archive names so the
 * retention sweep cannot accidentally pick up unrelated `audit.log.*`
 * siblings (e.g. an operator-deposited `audit.log.backup`,
 * `audit.log.bak`, or a future schema variant). The pattern matches the
 * stamp produced by `formatStamp` exactly: 8 digits, dash, 6 digits.
 */
const ARCHIVE_STAMP_RE = /^\d{8}-\d{6}$/;

export type AuditAppendListener = (entry: AuditEntry) => void;

export interface AuditDisposable {
  dispose(): void;
}

export class AuditLogWriter {
  private readonly config: AuditLogConfig;
  private readonly logger: SanitizedLogger;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<AuditAppendListener>();
  private gitignoreEnsure: Promise<void> | null = null;

  constructor(config: Partial<AuditLogConfig> & { workspaceRoot: string }, logger: SanitizedLogger) {
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
    return path.join(this.config.workspaceRoot, '.schegent', 'audit.log');
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

  public async append(entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> {
    const full: AuditEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
      schemaVersion: entry.schemaVersion ?? AUDIT_SCHEMA_VERSION,
      // The workflow runId IS the per-run correlation identifier. Threading it
      // explicitly into the audit entry keeps `correlationId` greppable across
      // every emitted event (workflow, queue, phase, monitor, audit-pipeline).
      correlationId: entry.correlationId ?? entry.runId
    };
    const sanitized = this.logger.sanitizeRecord(full as unknown as Record<string, unknown>) as unknown as AuditEntry;
    const line = `${JSON.stringify(sanitized)}\n`;
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
    const next = this.writeChain.then(
      () => this.doWrite(line),
      () => this.doWrite(line)
    );
    this.writeChain = next.catch((err) => {
      const code = (err as NodeJS.ErrnoException).code;
      this.logger.warn(
        `audit append failed: ${(err as Error).message}`,
        {
          eventId: sanitized.id,
          eventType: sanitized.eventType,
          runId: sanitized.runId,
          ...(typeof code === 'string' ? { errno: code } : {})
        }
      );
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
    const dir = path.dirname(this.logPath);
    await fs.mkdir(dir, { recursive: true });
    await this.ensureRuntimeGitignore();
    await this.maybeRotate();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        fs.appendFile(this.logPath, line, 'utf8'),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`audit append timed out after ${APPEND_TIMEOUT_MS}ms`)),
            APPEND_TIMEOUT_MS
          );
        })
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
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
    const stamp = formatStamp(new Date());
    const archive = `${this.logPath}.${stamp}`;
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
      // mirrors `formatStamp` exactly.
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
    for (const entry of archives) {
      if (keep.has(entry.fullPath)) continue;
      try {
        await fs.unlink(entry.fullPath);
      } catch (err) {
        this.logger.warn(
          `audit retention unlink failed for ${path.basename(entry.fullPath)}: ${(err as Error).message}`
        );
      }
    }
  }
}

function formatStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
