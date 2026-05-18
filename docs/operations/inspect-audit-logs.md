# Inspect Audit Logs

The audit log is the operator-facing source of truth for Schegent runs. It's a sanitized append-only JSONL file at `.schegent/audit.log` inside the active workspace.

## File layout

| Path | Purpose |
|---|---|
| `.schegent/audit.log` | Active log file. |
| `.schegent/audit.log.<YYYYMMDD-HHMMSS>` | Rotated archives, oldest first. |

> Schegent also writes a separate **raw session transcript** for each workflow
> run at `.schegent/sessions/raw-<runId>.log`. That file is **not** the audit
> log — it is a parallel, intentionally unredacted developer-debug artefact
> with no rotation, no retention, and no sanitization. See
> [inspect-raw-transcripts.md](inspect-raw-transcripts.md) for details.

Rotation triggers when the active file exceeds `schegent.audit.rotation.sizeMB` (default 5 MB) **or** `schegent.audit.rotation.maxAgeDays` (default 30 days), whichever first. Archives are pruned to the most recent `retentionMaxArchives` (10) and trimmed to `retentionMaxArchiveAgeMs` (90 days).

## Quick inspection commands

Show all events for a single run:

```bash
grep '"correlationId":"<runId>"' .schegent/audit.log
```

Show only failures:

```bash
jq -c 'select(.outcome == "failure")' .schegent/audit.log
```

Show only monitor events:

```bash
jq -c 'select(.eventType | startswith("monitor."))' .schegent/audit.log
```

Show only hydration warnings:

```bash
grep '"audit.hydration.warning"' .schegent/audit.log
```

## Entry shape

Every entry has:

```json
{
  "id": "uuid",
  "timestamp": "2026-05-10T11:32:14.123Z",
  "schemaVersion": 1,
  "runId": "run-uuid",
  "correlationId": "run-uuid",
  "phase": "specify | clarify | plan | tasks | analyze | implement | finalize | <custom phase id> | <queue> | <monitor>",
  "iteration": 1,
  "eventType": "<see contracts/audit-events.ts>",
  "payload": { },
  "outcome": "success | failure | info"
}
```

The single source of truth for `eventType` values is [src/contracts/audit-events.ts](../../src/contracts/audit-events.ts).

### Dynamic-pipelines payload fields (additive, since 2026-05)

`phase-start` and `phase-end` payloads always include the pipeline context:

| Field | Type | When present |
|---|---|---|
| `pipelineId` | `string` | Always — `'speckit-new-feature'` for the built-in zero-config flow. |
| `phaseId` | `string` | Always — the active phase id (matches the entry's `phase`). |
| `model` | `string` | Only when the active `PhaseDef.model` is set. |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'` | Only when the active `PhaseDef.effort` is set. |
| `timeoutMs` | `integer` | Only when the active `PhaseDef.timeoutSeconds` is set. |

Filter by pipeline:

```bash
jq -c 'select(.payload.pipelineId == "speckit-new-feature")' .schegent/audit.log
```

Filter all phases that used a model override:

```bash
jq -c 'select(.payload.model != null)' .schegent/audit.log
```

### Delayed-retry payload fields (additive, since feature 011)

Four event types record per-run delayed-retry transitions:

| `eventType` | `outcome` | Payload fields |
|---|---|---|
| `retry-scheduled` | `pending` | `cause` (`transient_error` \| `rate_limit`), `delayedRetryCount`, `pendingRetryAt`, `backoffMs` |
| `retry-manual` | `pending` | `priorDelayedRetryCount`, `priorPendingRetryCause` |
| `retry-recovered` | `success` | `priorDelayedRetryCount` |
| `queue-paused` | `failure` | `reason` (`retry-cap-exhausted:<runId>`), `cause`, `delayedRetryCount` |

Filter all delayed-retry transitions for a single run:

```bash
grep '"correlationId":"<runId>"' .schegent/audit.log \
  | jq -c 'select(.eventType | test("retry-|queue-paused"))'
```

The extended `fatal-signature-matched` event (also additive in 011)
now carries `payload.source: 'built-in' | 'operator-defined'` so an
operator-defined registry hit can be triaged separately from a
vendor message hit.

See [delayed-retry-and-manual-override.md](delayed-retry-and-manual-override.md)
for the state machine these events describe.

## Sanitization

Every entry is passed through `logger.sanitizeRecord()` **once** before disk write. The same sanitized payload is delivered to listeners. There is no code path where listeners see the raw fields.

If you suspect a leak (a token-shaped string appears in `.schegent/audit.log`):

1. Verify the redaction set in [src/lib/logger.ts](../../src/lib/logger.ts) covers the pattern.
2. Run `npm run test -- audit/sanitization` to verify the regression suite still passes.
3. File a security note — see [docs/security/security-note.md](../security/security-note.md).

## Hydration warnings

The audit parser emits `audit.hydration.warning` for entries with:

- A `schemaVersion` higher than the current runtime's `AUDIT_SCHEMA_VERSION`.
- An `eventType` not in the `KNOWN_AUDIT_EVENT_TYPE_SET`.

Both cases **preserve** the entry rather than dropping it. The warning surfaces in the live activity feed and lets operators detect when the workspace was last touched by a newer Schegent build.

If you see a warning:

1. Note the entry's `schemaVersion` and `eventType`.
2. If `schemaVersion` is higher than `AUDIT_SCHEMA_VERSION`, your runtime is older — upgrade the extension.
3. If `eventType` is unrecognized, the entry was emitted by code paths that don't exist in this runtime; it's safe to ignore unless it correlates with operational anomalies.

## Correlation IDs

Every entry carries `correlationId`, which defaults to `runId` if not explicitly threaded. This makes greppable run reconstruction trivial:

```bash
grep '"correlationId":"<id>"' .schegent/audit.log | jq -c .
```

Use this when reconstructing a stuck run; see [debug-stuck-runs.md](debug-stuck-runs.md).

## Schemas

| Constant | Value | Source |
|---|---|---|
| `AUDIT_SCHEMA_VERSION` | `1` | [src/contracts/audit-events.ts](../../src/contracts/audit-events.ts) |
| `STATE_SCHEMA_VERSION` | `2` | [src/contracts/state-schema.ts](../../src/contracts/state-schema.ts) — bumped in feature 011 to add `delayedRetryCount`, `pendingRetryAt`, `pendingRetryCause` to `WorkflowRun`. Forward-migrator at [src/state/workflow-run-migrator.ts](../../src/state/workflow-run-migrator.ts). |

Schema versions are monotonic integers. Bumping either constant is a breaking change requiring a migration story.
