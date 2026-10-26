/**
 * FR-R3-198 (FR-011) — the cost a claude CLI session had already reported.
 *
 * A `result` row's `total_cost_usd` is the CLI session's cumulative total, and it
 * carries across `--resume`: every resume path restores the session's stored
 * cost state. So an invocation that continues a session reports the spend of
 * every invocation before it as well as its own. `ClaudeCliRunner` remembers
 * the figure it last recorded for each session and reports it as the next
 * invocation's baseline, which `extractInvocationUsageMetrics` subtracts.
 *
 * In memory only, one ledger per runner. A session it has not seen, after a
 * host restart or an eviction, takes the Run's persisted figure when the request
 * resuming it carries one (FR-R3-209), and otherwise counts the whole cumulative
 * total once. The keys are CLI session ids, so nothing here is logged or persisted.
 */

/** How many sessions a ledger remembers before it evicts the oldest. */
export const MAX_TRACKED_SESSIONS = 64;

export class SessionCostLedger {
  // A `Map` iterates in insertion order. Re-inserting an entry makes it the
  // newest, so the first key is always the oldest.
  private readonly costs = new Map<string, number>();

  /** The cumulative total last recorded for the session, if any. Reading it refreshes the entry. */
  public get(sessionId: string): number | undefined {
    const cumulativeUsd = this.costs.get(sessionId);
    if (cumulativeUsd === undefined) return undefined;
    this.costs.delete(sessionId);
    this.costs.set(sessionId, cumulativeUsd);
    return cumulativeUsd;
  }

  /** Records the session's cumulative total as of its latest invocation. */
  public record(sessionId: string, cumulativeUsd: number): void {
    this.costs.delete(sessionId);
    this.costs.set(sessionId, cumulativeUsd);
    if (this.costs.size <= MAX_TRACKED_SESSIONS) return;
    const oldest = this.costs.keys().next();
    if (!oldest.done) this.costs.delete(oldest.value);
  }

  /** Records the figure only when the ledger holds none for the session; eviction is `record`'s. */
  public recordIfAbsent(sessionId: string, cumulativeUsd: number): void {
    if (!this.costs.has(sessionId)) this.record(sessionId, cumulativeUsd);
  }
}
