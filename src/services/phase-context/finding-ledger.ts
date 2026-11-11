/**
 * FR-R6-F15 (F15-A; FR-027 to FR-031, NFR-008) — the finding ledger of one review loop.
 *
 * The host, not the reviewer, decides what a pass means. A parsed report is checked against the
 * loop, the pass before it and the candidate it was made for; its new findings and dispositions
 * are applied to the status each finding had; and the verdict is computed from those statuses
 * and compared with the one the report states. A report that disagrees is refused whole. A
 * fixer's claims are recorded beside the statuses and change none.
 *
 * The ledger keeps identities, severities, statuses and claims. It keeps no title, explanation
 * or evidence of a finding: that prose stays in the report artifact.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { IDENTIFIER_PATTERN, PHASE_CONTEXT_LIMITS, REFERENCE_PATTERN, type Coverage, type Refusal } from '../../contracts/phase-context/context-policy';
import {
  SEVERITIES,
  type Finding,
  type FindingStatus,
  type FixClaimKind,
  type FixClaims,
  type PassOutcome,
  type RecordedClaim,
  type ReviewReport,
  type Severity,
  type StatusChange,
  type Verdict
} from '../../contracts/phase-context/review-loop';
import { isOneOf, isWholeNumber, listOf, matchesPattern, refuse, taggedDigest } from './primitives';

export interface LedgerOptions {
  readonly loopId: string;
  /** A finding of one of these severities blocks the loop until a reviewer resolves it. */
  readonly blockingSeverities: readonly Severity[];
  /** The last pass the loop may hold, from 1 to 32. */
  readonly maxPasses: number;
}

/** What the host knows about a report from outside it: where it is kept and what it reviewed. */
export interface ReportContext {
  readonly reportRef: string;
  readonly candidateRef: string;
  readonly scopeRevision: string;
  readonly criteriaRevision: string;
}

/** The candidate a fixer worked on, as the host recorded it. */
export interface ClaimsContext {
  readonly candidateRef: string;
}

export type AcceptReportResult = { readonly ok: true; readonly outcome: PassOutcome } | Refusal;
export type RecordClaimsResult = { readonly ok: true; readonly recorded: number } | Refusal;

export interface FindingLedger {
  /** Applies a parsed report whole, or refuses it and changes nothing. */
  acceptReport(report: ReviewReport, context: ReportContext): AcceptReportResult;
  /** Records a parsed claim set whole, or refuses it and changes nothing. */
  recordClaims(claims: FixClaims, context: ClaimsContext): RecordClaimsResult;
  /** Every finding of the loop in the order it was opened, as copies. */
  findings(): readonly Finding[];
  /** The outcome of every accepted pass in order, as copies. */
  passes(): readonly PassOutcome[];
}

interface FindingState {
  readonly id: string;
  readonly severity: Severity;
  status: FindingStatus;
  readonly openedInPass: number;
  readonly history: StatusChange[];
  readonly claims: RecordedClaim[];
}

interface PassState {
  readonly outcome: PassOutcome;
  readonly candidateRef: string;
  /** The digest of the report and its context, so the same report given again is recognised. */
  readonly inputDigest: string;
}

interface CheckedOptions {
  readonly loopId: string;
  readonly blocking: ReadonlySet<Severity>;
  readonly maxPasses: number;
}

/** What a report would change, worked out before anything is changed. */
interface Changes {
  readonly opened: ReadonlyMap<string, Severity>;
  readonly statuses: ReadonlyMap<string, FindingStatus>;
}

const REPLAY_TAG = 'prr1';

function invalid(detail: string): Refusal {
  return refuse('invalid-source', detail);
}

function stale(detail: string): Refusal {
  return refuse('stale-revision', detail);
}

function checkedOptions(options: LedgerOptions): CheckedOptions | null {
  const { loopId, blockingSeverities, maxPasses }: { loopId: unknown; blockingSeverities: unknown; maxPasses: unknown } = options;
  const severities = listOf(blockingSeverities, SEVERITIES.length);
  if (!matchesPattern(IDENTIFIER_PATTERN, loopId) || !isWholeNumber(maxPasses, 1, PHASE_CONTEXT_LIMITS.loopPassesMax) || severities === null) {
    return null;
  }
  const blocking = new Set<Severity>();
  for (const severity of severities) {
    if (!isOneOf(SEVERITIES, severity)) return null;
    blocking.add(severity);
  }
  return { loopId, blocking, maxPasses };
}

function inputDigestOf(report: ReviewReport, context: ReportContext): string {
  return taggedDigest([
    REPLAY_TAG,
    context.reportRef,
    context.candidateRef,
    context.scopeRevision,
    context.criteriaRevision,
    report.reportVersion,
    report.loopId,
    report.pass,
    report.reviewerAttemptId,
    report.candidateRef,
    report.scopeRevision,
    report.criteriaRevision,
    report.previousReportRef,
    report.coverage,
    report.reviewPassed,
    report.blockingCount,
    report.findings.map((finding) => [finding.id, finding.severity, finding.title, finding.explanation, finding.evidence]),
    report.dispositions.map((disposition) => [disposition.findingId, disposition.status])
  ]);
}

/**
 * The status a finding has after a reviewer states one. A resolved finding that is seen again
 * must be stated `reopened`, and only a resolved finding can be reopened, so the history shows
 * every recurrence as one.
 */
function statusAfter(current: FindingStatus, stated: FindingStatus): FindingStatus | Refusal {
  if (current === 'resolved') {
    if (stated === 'resolved') return current;
    return stated === 'reopened' ? stated : invalid('recurrence-not-reopened');
  }
  if (stated === 'reopened') return invalid('reopen-not-resolved');
  // `open` on a finding that is still not resolved says nothing new about it.
  return stated === 'open' ? current : stated;
}

function verdictOf(blockingCount: number, coverage: Coverage): Verdict {
  if (blockingCount > 0) return 'needs-fixes';
  return coverage === 'complete' ? 'passed' : 'incomplete';
}

function copyOfFinding(state: FindingState): Finding {
  return {
    id: state.id,
    severity: state.severity,
    status: state.status,
    openedInPass: state.openedInPass,
    history: state.history.map((change) => ({ ...change })),
    claims: state.claims.map((claim) => ({ ...claim }))
  };
}

class Ledger implements FindingLedger {
  private readonly byId = new Map<string, FindingState>();
  private readonly passList: PassState[] = [];

  constructor(private readonly options: CheckedOptions) {}

  acceptReport(report: ReviewReport, context: ReportContext): AcceptReportResult {
    if (!matchesPattern(REFERENCE_PATTERN, context.reportRef)) return invalid('report-ref');
    if (report.loopId !== this.options.loopId) return invalid('loop-mismatch');
    const inputDigest = inputDigestOf(report, context);
    const earlier = this.passList.find((pass) => pass.outcome.pass === report.pass);
    if (earlier !== undefined && earlier.inputDigest === inputDigest) return { ok: true, outcome: { ...earlier.outcome } };

    const orderFault = this.orderRefusal(report, context);
    if (orderFault !== null) return orderFault;
    const changes = this.changesOf(report);
    if ('ok' in changes) return changes;

    const outcome = this.outcomeOf(report, context.reportRef, changes);
    if (report.reviewPassed !== (outcome.verdict === 'passed') || report.blockingCount !== outcome.blockingCount) {
      return invalid('verdict-mismatch');
    }
    this.commit(report.pass, changes);
    this.passList.push({ outcome, candidateRef: context.candidateRef, inputDigest });
    return { ok: true, outcome: { ...outcome } };
  }

  recordClaims(claims: FixClaims, context: ClaimsContext): RecordClaimsResult {
    if (claims.loopId !== this.options.loopId) return invalid('loop-mismatch');
    const last = this.passList.at(-1);
    if (last === undefined || claims.basedOnReportRef !== last.outcome.reportRef) return stale('claims-basis');
    if (context.candidateRef !== last.candidateRef) return stale('candidate-mismatch');
    if (claims.pass !== last.outcome.pass) return stale('claims-pass');

    const named = new Set<string>();
    const fresh: { readonly finding: FindingState; readonly claim: FixClaimKind }[] = [];
    for (const { findingId, claim } of claims.claims) {
      const finding = this.byId.get(findingId);
      if (finding === undefined) return invalid('claim-unknown');
      if (named.has(findingId)) return invalid('claim-duplicate');
      named.add(findingId);
      const recorded = finding.claims.find((entry) => entry.pass === claims.pass);
      if (recorded === undefined) fresh.push({ finding, claim });
      else if (recorded.claim !== claim) return invalid('claim-conflict');
    }
    for (const { finding, claim } of fresh) finding.claims.push({ pass: claims.pass, claim });
    return { ok: true, recorded: fresh.length };
  }

  findings(): readonly Finding[] {
    return Array.from(this.byId.values(), copyOfFinding);
  }

  passes(): readonly PassOutcome[] {
    return this.passList.map((pass) => ({ ...pass.outcome }));
  }

  /** The report's place in the loop: its pass, its candidate and the report before it. */
  private orderRefusal(report: ReviewReport, context: ReportContext): Refusal | null {
    if (report.pass !== this.passList.length + 1) return stale('pass-out-of-order');
    if (report.pass > this.options.maxPasses) return refuse('capacity-exceeded', 'pass-limit');
    if (report.candidateRef !== context.candidateRef) return stale('candidate-mismatch');
    if (report.scopeRevision !== context.scopeRevision) return stale('scope-mismatch');
    if (report.criteriaRevision !== context.criteriaRevision) return stale('criteria-mismatch');
    // A reviewer that could not read the candidate has reviewed nothing: no verdict follows.
    if (report.coverage === 'unavailable') return refuse('required-context-unavailable', 'coverage-unavailable');
    const last = this.passList.at(-1);
    const expected = last === undefined ? null : last.outcome.reportRef;
    return report.previousReportRef === expected ? null : stale('previous-report');
  }

  /** Dispositions are read against the findings known before this report, never its own. */
  private changesOf(report: ReviewReport): Changes | Refusal {
    const opened = new Map<string, Severity>();
    for (const finding of report.findings) {
      if (opened.has(finding.id)) return invalid('finding-duplicate');
      if (this.byId.has(finding.id)) return invalid('finding-known');
      opened.set(finding.id, finding.severity);
    }
    if (this.byId.size + opened.size > PHASE_CONTEXT_LIMITS.loopFindingsMax) return refuse('capacity-exceeded', 'finding-count');

    const statuses = new Map<string, FindingStatus>();
    for (const { findingId, status } of report.dispositions) {
      const finding = this.byId.get(findingId);
      if (finding === undefined) return invalid('disposition-unknown');
      if (statuses.has(findingId)) return invalid('disposition-duplicate');
      const next = statusAfter(finding.status, status);
      if (typeof next !== 'string') return next;
      statuses.set(findingId, next);
    }
    return { opened, statuses };
  }

  private outcomeOf(report: ReviewReport, reportRef: string, changes: Changes): PassOutcome {
    let open = 0;
    let resolved = 0;
    let blockingCount = 0;
    const count = (severity: Severity, status: FindingStatus): void => {
      if (status === 'resolved') {
        resolved += 1;
        return;
      }
      open += 1;
      if (this.options.blocking.has(severity)) blockingCount += 1;
    };
    for (const finding of this.byId.values()) count(finding.severity, changes.statuses.get(finding.id) ?? finding.status);
    for (const severity of changes.opened.values()) count(severity, 'open');

    const verdict = verdictOf(blockingCount, report.coverage);
    return {
      pass: report.pass,
      reportRef,
      verdict,
      blockingCount,
      open,
      resolved,
      newFindings: changes.opened.size,
      mayDispatchFix: verdict === 'needs-fixes' && report.pass < this.options.maxPasses
    };
  }

  private commit(pass: number, changes: Changes): void {
    for (const [findingId, status] of changes.statuses) {
      const finding = this.byId.get(findingId);
      if (finding === undefined || finding.status === status) continue;
      finding.status = status;
      finding.history.push({ pass, status });
    }
    for (const [id, severity] of changes.opened) {
      this.byId.set(id, { id, severity, status: 'open', openedInPass: pass, history: [{ pass, status: 'open' }], claims: [] });
    }
  }
}

/** A ledger made with options no loop may have: it holds nothing and refuses everything. */
function refusingLedger(): FindingLedger {
  const refusal = refuse('invalid-policy', 'ledger-options');
  return {
    acceptReport: () => refusal,
    recordClaims: () => refusal,
    findings: () => [],
    passes: () => []
  };
}

/**
 * The ledger of one review loop. Options are checked once here; a ledger made with options no
 * loop may have fails closed, so a caller that does not look at them cannot run an unbounded
 * loop.
 */
export function createFindingLedger(options: LedgerOptions): FindingLedger {
  const checked = checkedOptions(options);
  return checked === null ? refusingLedger() : new Ledger(checked);
}
