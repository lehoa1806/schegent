/**
 * Counts-only metadata audit export projection (`schemaVersion === 3`).
 *
 * Lives in `src/services/audit-export/` so both `src/commands/export-audit.ts` and
 * `src/services/diagnostics-bundle/bundle-collect.ts` share one sanitizer without a
 * `services/ -> commands/` reverse edge AND without introducing an `audit/ -> parser/`
 * runtime value edge beneath `state/` (`tests/lint/architecture-layers.ts`).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { parseAuditLogLineDetailed } from '../../parser/audit-log-parser';
import { ATTEMPT_ID_RE, CAP_EXHAUSTED_CAUSE, PRE_SPAWN_REFUSAL_CAUSE } from '../../audit/audit-payload';
import {
  AUDIT_CONTAINMENT_POSTURES,
  AUDIT_EXECUTABLE_TARGETS,
  AUDIT_PERMISSION_MODES
} from '../../audit/audit-payload-acp-vocab';
import { REVIEW_SCANNERS } from '../../contracts/containment-qualification';
import { isFailureCause } from '../../contracts/failure-cause';

const COUNT_KEYS = new Set([
  'exitCode',
  'fileChangeCounts',
  'metrics',
  'omittedFileEvidenceCount',
  'omittedToolEvidenceCount',
  'outcome',
  'terminationReason',
  'toolCategoryCounts',
  // Feature 194 (FR-R3-155, T030) — `cause` and `stalled` are value-checked below as
  // defense-in-depth over historical bytes on disk.
  'cause',
  'stalled',
  // Feature 212 (FR-002, FR-007) — attempt identity and result-envelope presence.
  'attemptId',
  'resultEnvelope',
  // Feature 242 (FR-R4-F14) — closed failure cause code on `task-execution-ended`.
  'failureCause',
  // FR-R8-02 / FR-R8-03 (02-02, 03-02) — closed-vocabulary scanner/process authority fields on
  // `cli-invocation` and bounded stream high-water metrics on `monitor-invocation-summary`.
  'executableTarget',
  'containmentPosture',
  'permissionMode',
  'streamHighWaterBytes',
  'streamObservedBytes',
  'streamPendingHighWaterBytes',
  'streamTruncated',
  // Principal Review F5/F6 — closed metadata-only operator security & credential events.
  'scanner',
  'action',
  'fingerprintDigestPrefix',
  'removedSetting',
  'clearedBinding',
  'secretKeyDigestPrefix',
  'matchesConfiguredKey'
]);

/** Closed-vocabulary short lowercase cause token (no spaces, paths, or free-form prose). */
const CLOSED_CAUSE_TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;
const DIGEST_PREFIX_16_RE = /^[0-9a-f]{16}$/;
const SCANNER_CONSENT_ACTIONS = new Set(['granted', 'denied', 'revoked']);
const TELEMETRY_CREDENTIAL_ACTIONS = new Set(['stored', 'cleared']);

/**
 * Value checks for the allowlist above, scoped by `(eventType, key)`.
 * A rejection exports as `null` (not filtered), because absence and rejection carry different meaning.
 */
function guardedPayloadValue(eventType: string, key: string, value: unknown): unknown {
  if (key === 'cause') {
    const ok =
      eventType === 'phase-end'
        ? value === CAP_EXHAUSTED_CAUSE || value === PRE_SPAWN_REFUSAL_CAUSE
        : typeof value === 'string' && CLOSED_CAUSE_TOKEN.test(value);
    return ok ? value : null;
  }
  if (key === 'stalled') {
    const ok = typeof value === 'number' && Number.isInteger(value) && value > 0;
    return ok ? value : null;
  }
  if (key === 'resultEnvelope') {
    const ok = eventType === 'phase-end' && (value === 'received' || value === 'absent');
    return ok ? value : null;
  }
  if (key === 'attemptId') {
    const ok =
      (eventType === 'phase-end' ||
        eventType === 'cli-invocation' ||
        eventType === 'monitor-invocation-summary') &&
      typeof value === 'string' &&
      ATTEMPT_ID_RE.test(value);
    return ok ? value : null;
  }
  if (key === 'failureCause') {
    const ok = eventType === 'task-execution-ended' && isFailureCause(value);
    return ok ? value : null;
  }
  if (key === 'executableTarget') {
    const ok =
      eventType === 'cli-invocation' &&
      typeof value === 'string' &&
      AUDIT_EXECUTABLE_TARGETS.has(value);
    return ok ? value : null;
  }
  if (key === 'containmentPosture') {
    const ok =
      eventType === 'cli-invocation' &&
      typeof value === 'string' &&
      AUDIT_CONTAINMENT_POSTURES.has(value);
    return ok ? value : null;
  }
  if (key === 'permissionMode') {
    const ok =
      eventType === 'cli-invocation' &&
      typeof value === 'string' &&
      AUDIT_PERMISSION_MODES.has(value);
    return ok ? value : null;
  }
  if (
    key === 'streamHighWaterBytes' ||
    key === 'streamObservedBytes' ||
    key === 'streamPendingHighWaterBytes'
  ) {
    const ok =
      eventType === 'monitor-invocation-summary' &&
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0;
    return ok ? value : null;
  }
  if (key === 'streamTruncated') {
    const ok = eventType === 'monitor-invocation-summary' && typeof value === 'boolean';
    return ok ? value : null;
  }
  if (key === 'scanner') {
    const ok =
      eventType === 'scanner-consent-changed' &&
      typeof value === 'string' &&
      (REVIEW_SCANNERS as readonly string[]).includes(value);
    return ok ? value : null;
  }
  if (key === 'action') {
    const ok =
      (eventType === 'scanner-consent-changed' &&
        typeof value === 'string' &&
        SCANNER_CONSENT_ACTIONS.has(value)) ||
      (eventType === 'telemetry-credential-changed' &&
        typeof value === 'string' &&
        TELEMETRY_CREDENTIAL_ACTIONS.has(value));
    return ok ? value : null;
  }
  if (key === 'fingerprintDigestPrefix') {
    const ok =
      eventType === 'scanner-consent-changed' &&
      typeof value === 'string' &&
      DIGEST_PREFIX_16_RE.test(value);
    return ok ? value : null;
  }
  if (key === 'removedSetting' || key === 'clearedBinding') {
    const ok = eventType === 'scanner-consent-changed' && typeof value === 'boolean';
    return ok ? value : null;
  }
  if (key === 'secretKeyDigestPrefix') {
    const ok =
      eventType === 'telemetry-credential-changed' &&
      typeof value === 'string' &&
      DIGEST_PREFIX_16_RE.test(value);
    return ok ? value : null;
  }
  if (key === 'matchesConfiguredKey') {
    const ok = eventType === 'telemetry-credential-changed' && typeof value === 'boolean';
    return ok ? value : null;
  }
  return value;
}

/**
 * FR-R3-112 — the export deliberately carries NO chain fields (`prevDigest` hashes raw disk bytes).
 */
export function createCountsOnlyAuditExport(input: string): string {
  return countsOnlyAuditExport(input).text;
}

/**
 * Projects raw `.jsonl` audit text into counts-only schema-v3 rows plus `included`/`omitted` counts.
 */
export function countsOnlyAuditExport(input: string): {
  readonly text: string;
  readonly included: number;
  readonly omitted: number;
} {
  const rows: string[] = [];
  let omitted = 0;
  for (const line of input.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const parsed = parseAuditLogLineDetailed(line).entry;
    if (!parsed || parsed.schemaVersion !== 3) {
      omitted += 1;
      continue;
    }
    const payload = Object.fromEntries(
      Object.entries(parsed.payload)
        .filter(([key]) => COUNT_KEYS.has(key))
        .map(([key, value]) => [key, guardedPayloadValue(parsed.eventType, key, value)])
    );
    rows.push(
      JSON.stringify({
        id: parsed.id,
        timestamp: parsed.timestamp,
        eventType: parsed.eventType,
        phase: parsed.phase,
        iteration: parsed.iteration,
        outcome: parsed.outcome,
        schemaVersion: 3,
        payload
      })
    );
  }
  return { text: rows.length > 0 ? `${rows.join('\n')}\n` : '', included: rows.length, omitted };
}

