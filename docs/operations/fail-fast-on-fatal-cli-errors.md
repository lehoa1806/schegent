# Fail-Fast on Fatal CLI Errors

Schegent inspects every Claude CLI invocation's stdout and stderr against
a frozen registry of fatal substrings. If a match is found, the run
terminates after that single invocation regardless of the CLI's exit
code, releases the workspace lock, and surfaces the redacted matched
text on the `phase-end` audit event's `payload.cause` field. This bounds
token and wall-clock consumption to one invocation on quota-exhausted
runs.

The **code-resident floor** of the registry contains exactly one
signature (`"You're out of extra usage"`) and is treated as immutable.
Adding a new floor entry requires a code change to
[src/lib/fatal-signature-registry.ts](../../src/lib/fatal-signature-registry.ts)
plus PR review.

**Feature 011** added an operator-additive surface: workspace settings
can declare additional fatal signatures via `schegent.fatalSignatures`
(also editable from **Dashboard → Settings → Fatal Signatures**).
Operator entries extend the registry — they cannot remove or re-order
built-ins. When both a built-in and an operator entry would match the
same text, the built-in wins. The `fatal-signature-matched` audit
event carries `payload.source: 'built-in' | 'operator-defined'` so the
match attribution is unambiguous. File an issue if you believe a
match pattern should be promoted from operator-additive to the
code-resident floor.

## How to recognize a fail-fast termination

Look at the most recent `phase-end` event in `.schegent/audit.log`:

```bash
grep '"eventType":"phase-end"' .schegent/audit.log | tail -n 1 | jq .
```

| `payload.cause` | Interpretation |
|---|---|
| Redacted CLI error text (e.g., "out of extra usage") | Fatal CLI failure (this guide). Resolve at the CLI level (top up quota, fix billing, etc.) and re-run. |
| Literal `"cap_exhausted"` | Iteration cap reached with a truthy `retryCondition`. See [custom-retry-conditions.md](custom-retry-conditions.md). |
| Field absent | Generic phase failure. See [debug-stuck-runs.md](debug-stuck-runs.md). |

## Where it surfaces

| Surface | Field |
|---|---|
| Sidebar | Last-error pane (redacted) |
| Dashboard | Run history record |
| Audit log | `phase-end.outcome = 'failure'`, `phase-end.payload.cause = <redacted>` |
| Iteration counter | Always exactly `1` on the failing phase |

## Canonical reference

For the full operator-facing walkthrough, see
[specs/010-pipeline-resilience/quickstart.md](../../../specs/010-pipeline-resilience/quickstart.md)
§2.

## Trust boundary

Fail-fast is a code-level allowlist (built-in floor) plus an
operator-additive surface (workspace setting) with deterministic
stdout-first classification. The matched signature text and the
`source` attribution both flow through the **single sanitization
point** at
[src/audit/audit-log-writer.ts](../../src/audit/audit-log-writer.ts)
before reaching disk or any listener. See
[docs/security/threat-model.md](../security/threat-model.md) T12.

## Relationship to delayed retry (feature 011)

Fail-fast is the **bypass** for delayed-retry: a fatal-signature match
terminates the run immediately, never increments `delayedRetryCount`,
and never schedules a `pendingRetryAt` timer. Non-zero exits without a
fatal-signature match are subject to the 15-min / 60-min delayed-retry
loop and the 5-retry cap (see
[delayed-retry-and-manual-override.md](delayed-retry-and-manual-override.md)).
Operators who want to short-circuit a known-bad CLI failure mode can
add an operator-defined signature to skip the delayed-retry loop on
subsequent occurrences.
