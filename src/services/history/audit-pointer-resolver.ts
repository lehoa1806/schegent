// ---------------------------------------------------------------------------
// FR-R3-010 (T408/T409) — the reader for `HistoryEntry.auditLogPointer`.
//
// The pointer shipped in feature 013 and, until this file existed, nothing in
// the product ever resolved one. A field that looks like a working drill-down
// and is not is worse than no field, so this requirement chose resolution over
// removal — and resolution means the pointer either produces the run's audit
// entries or says, in a way an operator can act on, why it did not.
//
// Four answers, and the distinctions between them are the point:
//
//   resolved             the entries are here
//   evidence-expired     the log corpus no longer reaches back this far
//   no-evidence-recorded the corpus covers this run and holds nothing for it
//   unaddressable        the pointer names nothing this build can address
//   unavailable          the corpus could not be read
//
// `evidence-expired` is an ordinary outcome, not an error. The audit log prunes
// at 10 archives or 90 days while a history entry lives until its queue's cap
// evicts it, so the two retention windows are independent by design and a
// history row outliving its evidence is expected. Reporting that as a failure
// would train operators to ignore the one signal that tells them evidence is
// gone — and the same reasoning is why `no-evidence-recorded` is separated out
// rather than folded into expiry: a run canceled before its first phase wrote
// anything has an intact corpus and no entries, and calling that "expired"
// would be a false claim about retention.
//
// This module only ever reads. It never rotates, trims, or writes the audit
// log — that log is append-only evidence and the `CLAUDE.md` rule against
// erasing it covers a reader that "helpfully" tidies as much as a deletion
// path.
// ---------------------------------------------------------------------------

import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { AuditEntry } from '../../audit/audit-entry';
import type { SanitizedLogger } from '../../lib/logger';
import { parseAuditLogLineDetailed } from '../../parser/audit-log-parser';
import { parseAuditLogPointer } from '../../state/history-entry';
import { resolveWithinWorkspace } from '../run-request/workspace-containment';

/** Evidence directory, relative to the workspace root. */
const EVIDENCE_DIR = '.schegent';
const LIVE_LOG_NAME = 'audit.log';

/**
 * Archive naming, mirrored from `audit-log-writer.ts` and `metrics-service.ts`.
 *
 * Deliberately strict rather than a `audit.log.*` glob: an operator-deposited
 * `audit.log.bak` next to the real archives is not evidence this build wrote,
 * and reading it would let a hand-edited file answer a drill-down.
 */
const ARCHIVE_PREFIX = 'audit.log.';
const ARCHIVE_STAMP_RE = /^\d{8}-\d{6}(?:-\d{3}-[0-9a-f]{8})?$/;

/**
 * Ceiling on the entries one resolution returns.
 *
 * A long run can emit thousands, and every one of them would cross IPC into a
 * webview list an operator scrolls. The cap bounds that, the scan stops the
 * moment it is reached, and `truncated` says so rather than silently showing a
 * prefix as if it were the whole record.
 */
export const MAX_RESOLVED_ENTRIES = 500;

/**
 * Why a corpus read failed, as a closed set.
 *
 * Free text is not an option here: this value crosses IPC to the webview, and
 * an adapter's own error message names the path it tried to open. Serialising a
 * workspace path into anything the UI or the audit log can see is exactly what
 * the `CLAUDE.md` rule forbids, so the reason is a token the host chose.
 */
export type AuditPointerUnavailableReason = 'corpus-unreadable';

export type AuditPointerResolution =
  | {
      readonly status: 'resolved';
      readonly runId: string;
      readonly entries: readonly AuditEntry[];
      /** `true` when the run has more entries than `MAX_RESOLVED_ENTRIES`. */
      readonly truncated: boolean;
      /** Count only. The warning text can quote a malformed line verbatim. */
      readonly parseWarnings: number;
    }
  | { readonly status: 'evidence-expired'; readonly runId: string }
  | { readonly status: 'no-evidence-recorded'; readonly runId: string }
  | { readonly status: 'unaddressable' }
  | { readonly status: 'unavailable'; readonly reason: AuditPointerUnavailableReason };

export interface AuditPointerResolverDeps {
  readonly workspaceRoot: string;
  readonly logger: Pick<SanitizedLogger, 'warn' | 'sanitize'>;
}

export interface ResolveAuditPointerArgs {
  /** The value stored on the history entry, in whatever shape it was written. */
  readonly pointer: string;
  /**
   * When the run reached its terminal state, ISO-8601.
   *
   * This is what separates expiry from silence. Without it the resolver could
   * only report "no entries", and an operator would have no way to tell a
   * pruned window from a run that never wrote a phase record.
   */
  readonly completedAt: string;
}

interface ScanOutcome {
  readonly entries: AuditEntry[];
  readonly truncated: boolean;
  readonly parseWarnings: number;
  /** Oldest entry timestamp seen anywhere in the corpus, ms since epoch. */
  readonly oldestMs: number | null;
  readonly unreadable: boolean;
}

export class AuditPointerResolver {
  private readonly workspaceRoot: string;
  private readonly logger: Pick<SanitizedLogger, 'warn' | 'sanitize'>;

  constructor(deps: AuditPointerResolverDeps) {
    this.workspaceRoot = deps.workspaceRoot;
    this.logger = deps.logger;
  }

  public async resolve(args: ResolveAuditPointerArgs): Promise<AuditPointerResolution> {
    const parsed = parseAuditLogPointer(args.pointer);
    if (parsed === null) return { status: 'unaddressable' };

    const files = await this.listCorpusFiles();
    if (files === null) return { status: 'unavailable', reason: 'corpus-unreadable' };

    const scan = await this.scanCorpus(files, parsed.runId);
    if (scan.unreadable && scan.entries.length === 0) {
      return { status: 'unavailable', reason: 'corpus-unreadable' };
    }

    if (scan.entries.length > 0) {
      return {
        status: 'resolved',
        runId: parsed.runId,
        // Chronological rather than in the order the corpus happened to yield
        // them. Archives sort before the live log by name, so scan order is
        // already close — but a rotation mid-run can interleave, and a phase
        // timeline shown out of order reads as a different run.
        entries: scan.entries.sort(
          (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)
        ),
        truncated: scan.truncated,
        parseWarnings: scan.parseWarnings
      };
    }

    return this.verdictForEmptyMatch(parsed.runId, args.completedAt, scan.oldestMs);
  }

  /**
   * Nothing matched. Decide whether the window moved past this run, or whether
   * the run is inside the window and simply wrote nothing.
   *
   * An empty corpus is expiry: a log holding no entries at all cannot cover
   * anything, and claiming the run "recorded nothing" would be an assertion
   * about the run drawn from evidence about the log.
   *
   * An unparseable `completedAt` is also expiry. It is the conservative answer
   * of the two — expiry tells the operator to look elsewhere, silence tells
   * them there is nothing to look for.
   */
  private verdictForEmptyMatch(
    runId: string,
    completedAt: string,
    oldestMs: number | null
  ): AuditPointerResolution {
    if (oldestMs === null) return { status: 'evidence-expired', runId };
    const completedMs = Date.parse(completedAt);
    if (!Number.isFinite(completedMs)) return { status: 'evidence-expired', runId };
    return completedMs < oldestMs
      ? { status: 'evidence-expired', runId }
      : { status: 'no-evidence-recorded', runId };
  }

  /**
   * The corpus, oldest first: every archive this build's writer would have
   * produced, then the live log.
   *
   * `null` means the directory itself could not be listed, which is a genuine
   * failure. A missing directory is not — a workspace that has never run
   * anything has no `.schegent/`, and the empty corpus that produces is the
   * right input for the expiry verdict above.
   */
  private async listCorpusFiles(): Promise<string[] | null> {
    const liveLog = this.containedPath(path.join(EVIDENCE_DIR, LIVE_LOG_NAME));
    let names: string[];
    try {
      names = await readdir(this.absoluteEvidenceDir());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return liveLog === null ? [] : [liveLog];
      }
      this.logger.warn(
        `audit-pointer: could not list the evidence directory (${
          (err as NodeJS.ErrnoException).code ?? 'unknown'
        })`
      );
      return null;
    }

    const archives = names
      .filter((name) => name.startsWith(ARCHIVE_PREFIX))
      .filter((name) => ARCHIVE_STAMP_RE.test(name.slice(ARCHIVE_PREFIX.length)))
      .sort()
      .map((name) => this.containedPath(path.join(EVIDENCE_DIR, name)))
      .filter((file): file is string => file !== null);

    return liveLog === null ? archives : [...archives, liveLog];
  }

  private async scanCorpus(files: readonly string[], runId: string): Promise<ScanOutcome> {
    const entries: AuditEntry[] = [];
    let parseWarnings = 0;
    let oldestMs: number | null = null;
    let truncated = false;
    let unreadable = false;

    for (const file of files) {
      if (truncated) break;
      try {
        for await (const line of this.lines(file)) {
          const result = parseAuditLogLineDetailed(line);
          if (result.warning !== undefined) parseWarnings += 1;
          const entry = result.entry;
          if (entry === null) continue;
          const stampMs = Date.parse(entry.timestamp);
          if (Number.isFinite(stampMs) && (oldestMs === null || stampMs < oldestMs)) {
            oldestMs = stampMs;
          }
          if (entry.runId !== runId) continue;
          entries.push(entry);
          if (entries.length >= MAX_RESOLVED_ENTRIES) {
            truncated = true;
            break;
          }
        }
      } catch (err) {
        // A rotation can remove an archive between the listing and the read.
        // That is the corpus behaving normally, not a failure to report.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        unreadable = true;
        this.logger.warn(
          `audit-pointer: could not read an evidence file (${
            (err as NodeJS.ErrnoException).code ?? 'unknown'
          })`
        );
      }
    }

    return { entries, truncated, parseWarnings, oldestMs, unreadable };
  }

  /**
   * Streamed rather than read whole. `rotationSizeBytes` is operator-tunable
   * and the archive count is ten, so "read the file into a string" has no
   * bound an operator cannot raise. A drill-down must not be able to allocate
   * the extension host out of memory.
   */
  private lines(file: string): readline.Interface {
    return readline.createInterface({
      input: createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity
    });
  }

  private absoluteEvidenceDir(): string {
    const contained = resolveWithinWorkspace(this.workspaceRoot, EVIDENCE_DIR);
    return contained.ok ? contained.absolutePath : path.join(this.workspaceRoot, EVIDENCE_DIR);
  }

  /**
   * Every path this module opens goes through the one containment oracle
   * (T409), including the ones it derived itself.
   *
   * Deriving them is not a reason to skip the check. The archive names come
   * from `readdir` — a directory an operator can write to — and the workspace
   * root arrives from configuration; checking only the operator-supplied half
   * of a join is how a second, weaker path rule gets written. There is one rule
   * and this is a call to it, not a reimplementation.
   */
  private containedPath(relative: string): string | null {
    const contained = resolveWithinWorkspace(this.workspaceRoot, relative);
    if (contained.ok) return contained.absolutePath;
    this.logger.warn('audit-pointer: refusing an evidence path outside the workspace');
    return null;
  }
}
