/**
 * FR-R5-F19 (feature 278, T19.1, FR-001 and FR-002) — the first-blocker notice.
 *
 * WHAT IT IS. A Run's first report that carries a blocking tag (`needs-decision` or `needs-approval`,
 * read through the one tag authority `normalizeIssueTag`) raises one warning toast, so the operator
 * learns that a decision is waiting without opening a queue row. The message is a fixed template: it
 * names the Run by its cleaned label and says where the decision record can be opened. It never
 * echoes an issue summary, reads a metric name or reads a file.
 *
 * ONCE PER RUN. The bound is an in-memory ledger of Run ids, so a host restart forgets it and a Run
 * may be notified once more afterwards. That is an accepted, disclosed residual (spec FR-001, SC-001);
 * no stored flag is added. A failed notify does not mark the Run, so the next report retries.
 */
import { BLOCKING_ISSUE_TAGS, normalizeIssueTag } from '../contracts/failure-record';
import { SanitizedLogger } from '../lib/logger';
import type { InvocationResult } from '../parser/stdout-parser';
import { cleanAnnouncementValue } from './resume-decision';

/** Run ids the ledger remembers; the oldest is dropped beyond it, so a long session cannot grow it. */
export const BLOCKER_NOTICE_LEDGER_MAX = 256;

export interface BlockerNotice {
  readonly level: 'warn';
  /** One line, single spaces. */
  readonly message: string;
}

export interface BlockerNoticeInput {
  readonly runLabel: string;
  readonly result: InvocationResult;
}

type Sanitize = (value: string) => string;

// `SanitizedLogger.sanitize` reads no instance state (the same reasoning as `failure-notice.ts`), so one
// module-level redactor serves every caller and the Run driver does not have to supply one.
const defaultRedactor = new SanitizedLogger();
const defaultSanitize: Sanitize = (value) => defaultRedactor.sanitize(value);

const blockingTags: readonly string[] = BLOCKING_ISSUE_TAGS;

function reportsBlockingIssue(result: InvocationResult): boolean {
  if (result.kind !== 'remaining_issues') return false;
  return result.issues.some((issue) =>
    blockingTags.includes(normalizeIssueTag(issue.tag, issue.source === 'host' ? 'host' : 'agent'))
  );
}

/** The notice for a report, or `null` when no issue in it carries a blocking tag. Pure. */
export function blockerNotice(input: BlockerNoticeInput, sanitize: Sanitize): BlockerNotice | null {
  if (!reportsBlockingIssue(input.result)) return null;
  const label = cleanAnnouncementValue(input.runLabel, sanitize).replace(/\s+/g, ' ').trim();
  return {
    level: 'warn',
    message:
      `Schegent: "${label}" is waiting on a decision only you can make. ` +
      'Open the decision record from its queue row.'
  };
}

/**
 * Run ids already notified in this host session, bounded first-in first-out. No entry is removed when
 * a Run ends: a failed Run is resumed under the same id, and the resumed Run is still the same Run.
 */
export class BlockerNoticeLedger {
  private readonly notified = new Set<string>();

  public has(runId: string): boolean {
    return this.notified.has(runId);
  }

  public mark(runId: string): void {
    this.notified.delete(runId);
    this.notified.add(runId);
    while (this.notified.size > BLOCKER_NOTICE_LEDGER_MAX) {
      const oldest = this.notified.values().next();
      if (oldest.done === true) return;
      this.notified.delete(oldest.value);
    }
  }
}

export interface BlockerNoticeDeps {
  readonly ledger: BlockerNoticeLedger;
  readonly notifier: { warn(message: string): unknown };
  readonly logger: { warn(message: string): void };
  readonly sanitize?: Sanitize;
}

/**
 * Raise the notice when the Run has not been notified and the report blocks. The Run is marked only
 * after the notifier returns, and a throw writes one log line (error name, operation, Run id) and
 * never fails the Run.
 */
export function emitBlockerNotice(
  input: BlockerNoticeInput & { readonly runId: string },
  deps: BlockerNoticeDeps
): void {
  if (deps.ledger.has(input.runId)) return;
  const sanitize = deps.sanitize ?? defaultSanitize;
  const notice = blockerNotice(input, sanitize);
  if (notice === null) return;
  try {
    deps.notifier.warn(notice.message);
  } catch (error) {
    const code = error instanceof Error ? error.name : 'unknown';
    deps.logger.warn(
      `blocker-notice: notify failed (operation=notify, errorCode=${sanitize(code)}, runId=${sanitize(input.runId)})`
    );
    return;
  }
  deps.ledger.mark(input.runId);
}
