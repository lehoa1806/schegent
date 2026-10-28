// FR-R4-F02 (spec 240, US4; contract S4; research R8; data-model §7; FR-032 to FR-036) — the spend
// a host restart gives back: a bounded replay of the audit log chain, newest first, that gives each
// active Run either a complete total or the reason its total is only a lower bound.
//
// It replaces the seed that read the last 2 MiB of the live log and nothing else. That reader
// understated whenever a Run's rows lay before its window or in an archive, and it never said so, so
// a restarted Run's total read as known while it was not.
//
// THE SCAN. Files are the live log and then its archives, newest first, named the way
// `collectChainFiles` accepts them (so no fifth copy of the archive stamp pattern exists here). Each
// is opened read-only through `openWithinRoot` with `flags: 'r'` and read as a bounded tail inside
// one total budget, `SPEND_REPLAY_MAX_BYTES`. Nothing is written, truncated or unlinked (hard rule 9);
// a warning names a reason or an error code and never a path (hard rule 22). The audit log is
// `.schegent` content a cloned workspace can plant, so every read stays bounded (hard rule 69).
//
// COMPLETENESS, PER RUN. A Run's span is its rows from `startedAt` on. Walking backwards from the
// newest row, a Run is BOUNDED once a parsed row stamped before its `startedAt` is reached, and its
// total is complete only if nothing inside that span went wrong. Until then, the first thing found
// inside the span is the reason:
//
//   read-failed        a file in the chain could not be opened or read;
//   damaged-row        a non-empty line that does not parse as an audit row, a torn first line of a
//                      whole file included;
//   unknown-row-schema a `phase-end` row stamped with a schema newer than this build knows;
//
// and a Run still unbounded when the scan ends is `budget` (the budget stopped the scan before the
// oldest file was fully read) or `archive-missing` (every file in the chain was read and none held an
// older row, which is also how retention pruning shows up, so a total never shrinks in silence).
// The line a budget cut leaves at the start of a window is not "damage": the budget is the reason.
//
// The scan stops early once every Run is bounded, and a Run the caller did not name is never covered.
import * as path from 'node:path';
import { AUDIT_SCHEMA_VERSION, type AuditEntry } from '../audit/audit-entry';
import { AUDIT_CUTS_BASENAME, collectChainFiles } from '../audit/audit-chain';
import { readBoundedTail } from '../lib/bounded-read';
import type { SanitizedLogger } from '../lib/logger';
import { openWithinRoot } from '../lib/safe-open';
import { parseAuditLogLine } from '../parser/audit-log-parser';
import type { RunSpendTotal } from './spend-bound';

/** The most bytes one replay reads across the whole chain: 8 MiB, enough for a Run that straddles one 5 MiB rotation. */
export const SPEND_REPLAY_MAX_BYTES = 8 * 1024 * 1024;

const AUDIT_DIR = '.schegent';
const PHASE_END_EVENT = 'phase-end';
const ERROR_CODE_UNKNOWN = 'unknown';

type Completeness = RunSpendTotal['completeness'];
type IncompleteReason = Extract<Completeness, { kind: 'incomplete' }>['reason'];

export interface SpendReplay {
  /** The `phase-end` rows of the named Runs, inside their spans, in file order, oldest first. */
  readonly rows: readonly AuditEntry[];
  readonly completeness: ReadonlyMap<string, Completeness>;
}

export interface ReplayRun {
  readonly runId: string;
  readonly startedAt: number;
}

/** One Run's progress through the backward scan. */
interface Tracking {
  readonly startedAt: number;
  bounded: boolean;
  /** The first problem found inside the Run's span, in scan order. */
  reason: IncompleteReason | null;
}

const EMPTY_REPLAY: SpendReplay = Object.freeze({ rows: [], completeness: new Map() });

/** The chain's file names, newest first, without the cut record. Empty when there is no log. */
function chainNewestFirst(workspaceRoot: string): string[] {
  try {
    const chain = collectChainFiles(path.join(workspaceRoot, AUDIT_DIR));
    return chain === null ? [] : chain.ordered.filter((name) => name !== AUDIT_CUTS_BASENAME).reverse();
  } catch {
    return [];
  }
}

type Window =
  | { readonly kind: 'read'; readonly lines: readonly string[]; readonly bytes: number; readonly cut: boolean }
  | { readonly kind: 'failed' };

/** Open one file read-only and read at most `maxBytes` of its end. Never throws. */
async function readWindow(
  workspaceRoot: string,
  name: string,
  maxBytes: number,
  logger: SanitizedLogger
): Promise<Window> {
  const opened = await openWithinRoot(workspaceRoot, [AUDIT_DIR, name], { flags: 'r' });
  if (opened.outcome === 'refused') {
    logger.warn('spend replay: read refused', { reason: opened.reason });
    return { kind: 'failed' };
  }
  try {
    const { size } = await opened.handle.stat();
    const tail = await readBoundedTail(opened.handle, size, maxBytes);
    const lines = tail.bytes.toString('utf8').split(/\r?\n/);
    // A read that started past the first byte begins inside a row: that fragment is the budget's
    // cut, dropped and reported as the budget, not as damage.
    const cut = tail.skippedBytes > 0;
    return { kind: 'read', lines: cut ? lines.slice(1) : lines, bytes: tail.bytes.length, cut };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    logger.warn('spend replay: read failed', { code: code ?? ERROR_CODE_UNKNOWN });
    return { kind: 'failed' };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/**
 * The `phase-end` rows of the named Runs and each Run's completeness, from at most
 * `maxBytes` of the audit chain. Never rejects: any failure becomes a Run's `incomplete` reason.
 * `maxBytes` defaults to the contract's budget; only a test passes another.
 */
export async function readSpendReplay(
  workspaceRoot: string,
  logger: SanitizedLogger,
  runs: readonly ReplayRun[],
  maxBytes: number = SPEND_REPLAY_MAX_BYTES
): Promise<SpendReplay> {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0 || runs.length === 0) {
    return EMPTY_REPLAY;
  }
  const tracked = new Map<string, Tracking>(
    runs.map((run) => [run.runId, { startedAt: run.startedAt, bounded: false, reason: null }])
  );
  const open = (): Tracking[] => [...tracked.values()].filter((run) => !run.bounded);
  /** Record `reason` against every Run still unbounded and for which `inSpan` holds. */
  const markOpen = (reason: IncompleteReason, inSpan: (run: Tracking) => boolean = () => true): void => {
    for (const run of open()) if (run.reason === null && inSpan(run)) run.reason = reason;
  };

  const newestFirst: AuditEntry[] = [];
  let remaining = maxBytes;
  let budgetStopped = false;

  for (const name of chainNewestFirst(workspaceRoot)) {
    if (open().length === 0) break;
    if (remaining <= 0) {
      budgetStopped = true;
      break;
    }
    const window = await readWindow(workspaceRoot, name, remaining, logger);
    if (window.kind === 'failed') {
      markOpen('read-failed');
      continue;
    }
    remaining -= window.bytes;

    for (let index = window.lines.length - 1; index >= 0; index -= 1) {
      const line = window.lines[index] as string;
      if (line.trim().length === 0) continue;
      const entry = parseAuditLogLine(line);
      if (entry === null) {
        markOpen('damaged-row');
        continue;
      }
      const at = Date.parse(entry.timestamp);
      const inSpanOf = (run: Tracking): boolean => !Number.isFinite(at) || at >= run.startedAt;
      if (entry.eventType === PHASE_END_EVENT) {
        if ((entry.schemaVersion ?? 0) > AUDIT_SCHEMA_VERSION) markOpen('unknown-row-schema', inSpanOf);
        const owner = tracked.get(entry.runId);
        if (owner !== undefined && inSpanOf(owner)) newestFirst.push(entry);
      }
      if (Number.isFinite(at)) {
        for (const run of open()) if (at < run.startedAt) run.bounded = true;
      }
      if (open().length === 0) break;
    }
    if (window.cut && open().length > 0) {
      budgetStopped = true;
      break;
    }
  }

  const completeness = new Map<string, Completeness>();
  for (const [runId, run] of tracked) {
    const reason = run.reason ?? (run.bounded ? null : budgetStopped ? 'budget' : 'archive-missing');
    completeness.set(runId, reason === null ? { kind: 'complete' } : { kind: 'incomplete', reason });
  }
  return { rows: newestFirst.reverse(), completeness };
}
