import type { AuditEventType, CatalogLifecyclePayload } from '../contracts/audit-events';
import { CATALOG_KINDS, type CatalogKind } from '../contracts/catalog-store';
import type { BackendRunnerKind } from '../contracts/backend-kinds';

export const AUDIT_PAYLOAD_MAX_BYTES = 32 * 1024;
export const AUDIT_PAYLOAD_MAX_STRING_LENGTH = 640;
export const AUDIT_PAYLOAD_MAX_ARRAY_LENGTH = 100;

/**
 * Suffix stamped on a string the projector shortened to
 * `AUDIT_PAYLOAD_MAX_STRING_LENGTH`. An over-long string is truncated, not
 * refused: rejecting one dropped the WHOLE entry, so `monitor-stdout-line`
 * recorded only the short lines and the informative ones vanished. On
 * 2026-08-16 that silently discarded 7046 of 7452 stdout lines from one
 * `speckit-implement` run — including the line carrying the fatal signature
 * that ended it, leaving the run's cause unreconstructable from the audit.
 * The marker is what distinguishes a shortened value from one that was
 * always this length.
 */
export const AUDIT_PAYLOAD_TRUNCATION_MARKER = '...';

export type AuditPermissionMode =
  | 'read-only'
  | 'workspace-write'
  | 'unrestricted';

export interface CliInvocationPayloadV3 {
  readonly runner: BackendRunnerKind;
  readonly operation: 'phase' | 'session-compaction' | 'probe';
  readonly permissionMode: AuditPermissionMode;
  readonly continued: boolean;
  readonly sessionReused: boolean;
  readonly modelId?: string;
  readonly effortId?: string;
  readonly diagnosticsEnabled: boolean;
}

export interface PhaseEndPayloadV3 {
  readonly outcome: 'clean' | 'failed' | 'timeout' | 'rate-limited' | 'malformed';
  readonly exitCode: number | null;
  readonly terminationReason: string;
  readonly metrics: Readonly<Record<string, number>>;
  readonly fileChangeCounts: Readonly<{
    created: number;
    modified: number;
    deleted: number;
  }>;
  readonly toolCategoryCounts: Readonly<Record<string, number>>;
  readonly omittedFileEvidenceCount: number;
  readonly omittedToolEvidenceCount: number;
  /**
   * Diagnostic codes, drawn from `RECORDABLE_PHASE_END_WARNINGS`, that
   * explain the recorded `outcome`.
   *
   * Without this the projection recorded `outcome: 'failed'` /
   * `terminationReason: 'error'` with no indication of WHY, leaving the
   * cause only in the transient runtime log — which is what made a
   * volume-triggered run failure on 2026-08-16 undiagnosable from the
   * audit alone.
   *
   * An allowlist rather than a passthrough: the runner's warning list also
   * carries matched fatal signatures and parser messages that interpolate
   * model output, and `phase-end` deliberately records neither. Anything
   * outside the vocabulary is counted in `omittedWarningCount`, never
   * carried.
   */
  readonly warnings?: ReadonlyArray<string>;
  /**
   * Number of warnings dropped because they fall outside
   * `RECORDABLE_PHASE_END_WARNINGS`. Present only when nonzero, so the
   * record shows that unrecorded diagnostics existed without naming them.
   */
  readonly omittedWarningCount?: number;
}

/**
 * Feature FR-R3-007 (T354) — the invocation's transport aggregate.
 *
 * This event was always written; what changes is that it is now the ONLY thing
 * in `audit.log` that says how much the CLI emitted, because the per-line
 * `monitor-stdout-line` writer is gone. That promotion is why it gets a
 * projection of its own instead of riding the generic `projectValue` path: the
 * four aggregate fields are now load-bearing, and a bespoke projection is what
 * makes their presence a typed contract rather than whatever the emitter
 * happened to pass.
 *
 * The two timestamps are the interval the volume covers. Without them
 * `stdoutLines: 365` is unanchored — 365 lines over four seconds and 365 over
 * forty minutes are different runs — and the interval used to be recoverable by
 * reading the first and last per-line entry's own timestamps.
 */
export interface MonitorInvocationSummaryPayloadV3 {
  readonly status: string;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdoutLines: number;
  readonly stderrLines: number;
  readonly firstOutputAt: string | null;
  readonly lastOutputAt: string | null;
  readonly detectedIssues: ReadonlyArray<string>;
}

export interface MetricsViewOpenedPayloadV3 {
  /** Ephemeral UI-session correlation identifier; never a backend conversation ID. */
  readonly sessionId: string;
}

export class AuditPayloadValidationError extends Error {
  constructor(public readonly reasonCode: string) {
    super(`audit payload rejected: ${reasonCode}`);
    this.name = 'AuditPayloadValidationError';
  }
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const PATH_OR_ENDPOINT_RE = /(?:^~?[\\/]|^[A-Za-z]:[\\/]|[a-z][a-z0-9+.-]*:\/\/|[\\/](?:Users|home|var|tmp|private|workspace|workspaces)[\\/])/i;
const OMITTED_KEYS = new Set([
  'args',
  'argv',
  'command',
  'commands',
  'commandsExecuted',
  'commands_executed',
  'conversationId',
  'cwd',
  'debugFile',
  'endpoint',
  'endpoints',
  'error',
  'errorMessage',
  'expression',
  'file',
  'filePath',
  'files',
  'filesCreated',
  'filesDeleted',
  'filesModified',
  'files_created',
  'files_deleted',
  'files_modified',
  'lastErrorSummary',
  'modelFile',
  'networkCalls',
  'network_calls',
  'note',
  'notes',
  'output',
  'path',
  'prompt',
  'resumeSessionId',
  'sessionId',
  'signature',
  'stderr',
  'stdout',
  'workspaceRoot'
]);

function assertFiniteNumber(value: number): number {
  if (!Number.isFinite(value)) throw new AuditPayloadValidationError('non-finite-number');
  return value;
}

/**
 * Shorten `value` to at most `AUDIT_PAYLOAD_MAX_STRING_LENGTH` characters,
 * spending the tail of that budget on `AUDIT_PAYLOAD_TRUNCATION_MARKER` so
 * the result stays within the bound rather than exceeding it by the
 * marker's own length.
 */
function boundString(value: string): string {
  if (value.length <= AUDIT_PAYLOAD_MAX_STRING_LENGTH) return value;
  const keep = AUDIT_PAYLOAD_MAX_STRING_LENGTH - AUDIT_PAYLOAD_TRUNCATION_MARKER.length;
  return `${value.slice(0, keep)}${AUDIT_PAYLOAD_TRUNCATION_MARKER}`;
}

function projectValue(value: unknown, depth: number): unknown {
  if (depth > 4) throw new AuditPayloadValidationError('max-depth-exceeded');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return assertFiniteNumber(value);
  if (typeof value === 'string') {
    const bounded = boundString(value);
    // Deliberately tested against the BOUNDED value, not the raw one: the
    // bounded string is what gets written, so it is what the no-paths rule
    // has to hold for. A path beyond the cut is already gone; one before it
    // still refuses, and now reports the reason it actually failed.
    if (PATH_OR_ENDPOINT_RE.test(bounded)) {
      throw new AuditPayloadValidationError('path-or-endpoint-detected');
    }
    return bounded;
  }
  if (Array.isArray(value)) {
    if (value.length > AUDIT_PAYLOAD_MAX_ARRAY_LENGTH) {
      throw new AuditPayloadValidationError('array-too-long');
    }
    return value
      .filter((item) => item !== undefined)
      .map((item) => projectValue(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    const projected: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (!KEY_RE.test(key)) throw new AuditPayloadValidationError('invalid-key');
      if (OMITTED_KEYS.has(key) || child === undefined) continue;
      projected[key] = projectValue(child, depth + 1);
    }
    return projected;
  }
  throw new AuditPayloadValidationError('unsupported-value');
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function boundedMetadataString(value: unknown, fallback: string): string {
  return projectValue(stringValue(value, fallback), 0) as string;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function countArray(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function projectMetrics(value: unknown): Readonly<Record<string, number>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return Object.freeze({});
  const metrics: Record<string, number> = {};
  for (const [key, metric] of Object.entries(value as Record<string, unknown>)) {
    if (!KEY_RE.test(key)) throw new AuditPayloadValidationError('invalid-metric-key');
    if (typeof metric !== 'number' || !Number.isFinite(metric)) {
      throw new AuditPayloadValidationError('invalid-metric-value');
    }
    metrics[key] = metric;
  }
  return Object.freeze(metrics);
}

function projectCliInvocation(payload: Record<string, unknown>): CliInvocationPayloadV3 {
  const runner = stringValue(payload.runner, 'claude');
  if (!['claude', 'codex', 'agy'].includes(runner)) {
    throw new AuditPayloadValidationError('invalid-runner');
  }
  const operation = stringValue(payload.operation, 'phase');
  if (!['phase', 'session-compaction', 'probe'].includes(operation)) {
    throw new AuditPayloadValidationError('invalid-operation');
  }
  const permissionMode = stringValue(
    payload.permissionMode,
    runner === 'codex' ? 'workspace-write' : 'unrestricted'
  );
  if (!['read-only', 'workspace-write', 'unrestricted'].includes(permissionMode)) {
    throw new AuditPayloadValidationError('invalid-permission-mode');
  }
  return Object.freeze({
    runner: runner as BackendRunnerKind,
    operation: operation as CliInvocationPayloadV3['operation'],
    permissionMode: permissionMode as AuditPermissionMode,
    continued: booleanValue(payload.continued ?? payload.isContinue),
    sessionReused: booleanValue(payload.sessionReused ?? payload.sessionReuse),
    ...(typeof (payload.modelId ?? payload.model) === 'string'
      ? { modelId: boundedMetadataString(payload.modelId ?? payload.model, 'unknown') }
      : {}),
    ...(typeof (payload.effortId ?? payload.effort) === 'string'
      ? { effortId: boundedMetadataString(payload.effortId ?? payload.effort, 'unknown') }
      : {}),
    diagnosticsEnabled: booleanValue(payload.diagnosticsEnabled)
  });
}

/**
 * The closed vocabulary of `phase-end` diagnostic codes.
 *
 * Every member is a code-resident literal with no interpolated content —
 * that is the entry condition, not a coincidence. The warning list reaching
 * this module also contains matched fatal signatures (which may be
 * operator-authored) and parser messages that splice in up to 60 characters
 * of model output; those are content, they are what `OMITTED_KEYS` exists
 * to keep out of the log, and no amount of length-bounding makes them
 * recordable.
 *
 * Drift is contained by construction: if an emitter's literal changes, its
 * warning stops matching and lands in `omittedWarningCount`. The record
 * degrades to "something was warned about" rather than recording the wrong
 * thing or leaking content. `tests/unit/audit/audit-payload-v3.test.ts`
 * pins the set.
 */
export const RECORDABLE_PHASE_END_WARNINGS: ReadonlySet<string> = new Set([
  // src/controller/phase-outcome-mapper.ts — OUTPUT_TRUNCATED_WARNING
  'output-truncated-unclassifiable',
  // src/parser/audit-log-parser.ts
  '[constitution] missing audit log',
  '[constitution] unterminated audit log',
  // src/parser/stdout-parser.ts
  '[constitution] multiple contract blocks',
  '[constitution] missing audit log on clean response',
  // src/controller/phase-runner.ts — FR-R3-047 (H-04). Without this code the
  // record would say `outcome: 'failed'` / `terminationReason: 'error'` with no
  // stated cause, which is the exact shape that made a real 2026-08-16 failure
  // undiagnosable from the audit alone. The closed `TerminationReason` union
  // lives in the audit contract and is persisted in run state, so the cause
  // travels here rather than as a new union member.
  'stdin-delivery-failed',
  // src/controller/phase-runner.ts — FR-R3-058 (M-07). Reachable, unlike the
  // FR-R3-050 marker that was deliberately NOT added here: the phase runner puts
  // this code in the `warnings` array the phase-end projection reads, the same
  // route `stdin-delivery-failed` takes. Without it the record would say
  // `outcome: 'failed'` / `terminationReason: 'error'` with the cause dropped --
  // the exact shape that made the 2026-08-16 failure undiagnosable.
  'host-verification-failed',
  // src/services/evidence-health/evidence-health-monitor.ts — FR-R3-080 (T1076).
  // One code per evidence sink, enumerated rather than pattern-matched, because
  // an allowlist that accepts a PREFIX accepts whatever a caller appends to it —
  // and the thing a sink would most plausibly append is the path it refused.
  //
  // Enumerated as a set rather than added one at a time: SEC-06 and SEC-07 name
  // three sinks between them, and the two that are not named can refuse for the
  // same reason the moment they are migrated. Adding them when they refuse would
  // mean discovering the gap from a silent decline, which is the failure this
  // item exists to remove.
  'evidence-path-refused:audit',
  'evidence-path-refused:rawTranscript',
  'evidence-path-refused:runtimeLog',
  'evidence-path-refused:metricsRollup',
  'evidence-path-refused:historyPointer'
]);

interface ProjectedWarnings {
  readonly recorded: ReadonlyArray<string>;
  readonly omitted: number;
}

function projectPhaseEndWarnings(value: unknown): ProjectedWarnings {
  if (!Array.isArray(value)) return { recorded: [], omitted: 0 };
  const recorded: string[] = [];
  let omitted = 0;
  for (const entry of value) {
    if (typeof entry === 'string' && RECORDABLE_PHASE_END_WARNINGS.has(entry)) {
      if (!recorded.includes(entry)) recorded.push(entry);
      continue;
    }
    omitted += 1;
  }
  return { recorded: Object.freeze(recorded), omitted };
}

function projectPhaseEnd(payload: Record<string, unknown>): PhaseEndPayloadV3 {
  const rawOutcome = stringValue(payload.outcome, 'malformed');
  const outcome = ['clean', 'failed', 'timeout', 'rate-limited', 'malformed'].includes(rawOutcome)
    ? rawOutcome
    : 'malformed';
  const explicitMetrics = projectMetrics(payload.metrics);
  const legacyMetrics: Record<string, number> = { ...explicitMetrics };
  for (const key of [
    'durationMs',
    'cliDurationMs',
    'numTurns',
    'totalCostUsd',
    'inputTokens',
    'outputTokens',
    'cacheCreationInputTokens',
    'cacheReadInputTokens'
  ]) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) legacyMetrics[key] = value;
  }
  const created = countArray(payload.filesCreated ?? payload.files_created);
  const modified = countArray(payload.filesModified ?? payload.files_modified);
  const deleted = countArray(payload.filesDeleted ?? payload.files_deleted);
  const omittedTools = countArray(payload.commandsExecuted ?? payload.commands_executed);
  const warnings = projectPhaseEndWarnings(payload.warnings);
  return Object.freeze({
    outcome: outcome as PhaseEndPayloadV3['outcome'],
    exitCode: payload.exitCode === null ? null : numberValue(payload.exitCode, 0),
    terminationReason: boundedMetadataString(
      payload.terminationReason ?? payload.reason ?? payload.cause,
      outcome
    ),
    metrics: Object.freeze(legacyMetrics),
    fileChangeCounts: Object.freeze({ created, modified, deleted }),
    toolCategoryCounts: projectMetrics(payload.toolCategoryCounts),
    omittedFileEvidenceCount: created + modified + deleted,
    omittedToolEvidenceCount: omittedTools,
    ...(warnings.recorded.length > 0 ? { warnings: warnings.recorded } : {}),
    ...(warnings.omitted > 0 ? { omittedWarningCount: warnings.omitted } : {})
  });
}

/**
 * An ISO-8601 UTC instant as `Date.prototype.toISOString` writes one. The
 * monitor is the only emitter and always formats through that method, so the
 * pattern is a shape assertion on a code-resident format rather than a parser
 * for operator input.
 */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/**
 * Anything that is not that shape becomes `null` rather than throwing.
 *
 * The trade is deliberate and it runs the opposite way from `cli-invocation`'s
 * validation: with the per-line events gone this summary is the invocation's
 * only volume record, so refusing the whole entry over a malformed timestamp
 * would lose the counts too. A missing interval degrades the record; a rejected
 * payload erases it.
 */
function projectActivityStamp(value: unknown): string | null {
  return typeof value === 'string' && ISO_INSTANT_RE.test(value) ? value : null;
}

function projectMonitorInvocationSummary(
  payload: Record<string, unknown>
): MonitorInvocationSummaryPayloadV3 {
  const issues = Array.isArray(payload.detectedIssues) ? payload.detectedIssues : [];
  if (issues.length > AUDIT_PAYLOAD_MAX_ARRAY_LENGTH) {
    throw new AuditPayloadValidationError('array-too-long');
  }
  return Object.freeze({
    status: boundedMetadataString(payload.status, 'unknown'),
    durationMs: numberValue(payload.durationMs),
    exitCode:
      payload.exitCode === null || payload.exitCode === undefined
        ? null
        : numberValue(payload.exitCode, 0),
    signal: typeof payload.signal === 'string'
      ? boundedMetadataString(payload.signal, 'unknown')
      : null,
    stdoutLines: numberValue(payload.stdoutLines),
    stderrLines: numberValue(payload.stderrLines),
    firstOutputAt: projectActivityStamp(payload.firstOutputAt),
    lastOutputAt: projectActivityStamp(payload.lastOutputAt),
    detectedIssues: Object.freeze(
      issues
        .filter((issue): issue is string => typeof issue === 'string')
        .map((issue) => boundedMetadataString(issue, 'unknown'))
    )
  });
}

/**
 * The store's version-id form, as `catalog-paths.ts` writes one: `v` followed by
 * a positive integer with no leading zero. Restated here rather than imported
 * because the store's copy is a *path* concern — it is how a record's file is
 * named — and this one is a projection concern: it is the assertion that keeps
 * the only non-enum field in the payload from carrying anything but an id.
 *
 * If the store's format ever changes, this refuses and `catalog-lifecycle-commit`
 * logs the append failure. That is the intended failure mode: a visible missing
 * record, never a written wrong one.
 */
const CATALOG_VERSION_ID_RE = /^v[1-9][0-9]*$/;

/**
 * Feature 100 (T513, FR-054) — the three catalog lifecycle events get a bespoke
 * projection rather than riding `projectValue`, and the reason is that the closed
 * `CatalogLifecyclePayload` type does not survive this boundary.
 * `projectAuditPayload` takes a `Record<string, unknown>`, so the compiler has
 * nothing left to enforce here; `OMITTED_KEYS` catches `note` and
 * `workspaceRoot`, but it does NOT contain `body` or `draftBody`, and the generic
 * path would write a definition body into the log verbatim. That is precisely the
 * leak FR-054 forbids. A projection that names its three fields and copies
 * nothing else is what makes the closure a mechanism instead of a convention.
 *
 * Every field is required, and a malformed one throws rather than degrading to a
 * fallback. `projectMonitorInvocationSummary` degrades because its counts survive
 * a missing interval; here all three fields ARE the record, and an entry that
 * cannot say which definition it is about — or which version — is not a
 * degraded record but a misleading one.
 */
function projectCatalogLifecycle(payload: Record<string, unknown>): CatalogLifecyclePayload {
  const resourceKind = payload.resourceKind;
  if (typeof resourceKind !== 'string' || !CATALOG_KINDS.includes(resourceKind as CatalogKind)) {
    throw new AuditPayloadValidationError('invalid-catalog-kind');
  }
  const resourceId = payload.resourceId;
  if (typeof resourceId !== 'string' || resourceId.length === 0) {
    throw new AuditPayloadValidationError('invalid-catalog-resource-id');
  }
  const versionId = payload.versionId;
  if (typeof versionId !== 'string' || !CATALOG_VERSION_ID_RE.test(versionId)) {
    throw new AuditPayloadValidationError('invalid-catalog-version-id');
  }
  return Object.freeze({
    resourceKind: resourceKind as CatalogKind,
    // Still projected, not passed through: the emitter sanitizes and bounds the
    // id, and this is the boundary that makes the no-paths rule hold whether or
    // not it did.
    resourceId: projectValue(resourceId, 0) as string,
    versionId
  });
}

function projectMetricsViewOpened(
  payload: Record<string, unknown>
): MetricsViewOpenedPayloadV3 {
  if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
    throw new AuditPayloadValidationError('invalid-metrics-session-id');
  }
  return Object.freeze({ sessionId: projectValue(payload.sessionId, 0) as string });
}

/**
 * Converts every event-family payload into the bounded v3 metadata model.
 * Sensitive execution detail is omitted by key; malformed or path-bearing
 * residual data is rejected instead of being persisted.
 */
export function projectAuditPayload(
  eventType: AuditEventType,
  payload: Record<string, unknown>
): Record<string, unknown> {
  let projected: Record<string, unknown>;
  if (eventType === 'cli-invocation') {
    projected = projectCliInvocation(payload) as unknown as Record<string, unknown>;
  } else if (eventType === 'phase-end') {
    projected = projectPhaseEnd(payload) as unknown as Record<string, unknown>;
  } else if (eventType === 'monitor-invocation-summary') {
    projected = projectMonitorInvocationSummary(payload) as unknown as Record<string, unknown>;
  } else if (eventType === 'metrics-view-opened') {
    projected = projectMetricsViewOpened(payload) as unknown as Record<string, unknown>;
  } else if (
    eventType === 'definition-published' ||
    eventType === 'definition-deactivated' ||
    eventType === 'definition-restored'
  ) {
    projected = projectCatalogLifecycle(payload) as unknown as Record<string, unknown>;
  } else {
    projected = projectValue(payload, 0) as Record<string, unknown>;
  }
  const bytes = Buffer.byteLength(JSON.stringify(projected), 'utf8');
  if (bytes > AUDIT_PAYLOAD_MAX_BYTES) {
    throw new AuditPayloadValidationError('payload-too-large');
  }
  return Object.freeze(projected);
}
