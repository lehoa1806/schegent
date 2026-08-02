import type { AuditEventType } from '../contracts/audit-events';
import type { BackendRunnerKind } from '../runner/backend-runner-factory';

export const AUDIT_PAYLOAD_MAX_BYTES = 32 * 1024;
export const AUDIT_PAYLOAD_MAX_STRING_LENGTH = 240;
export const AUDIT_PAYLOAD_MAX_ARRAY_LENGTH = 100;

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

function projectValue(value: unknown, depth: number): unknown {
  if (depth > 4) throw new AuditPayloadValidationError('max-depth-exceeded');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return assertFiniteNumber(value);
  if (typeof value === 'string') {
    if (value.length > AUDIT_PAYLOAD_MAX_STRING_LENGTH) {
      throw new AuditPayloadValidationError('string-too-long');
    }
    if (PATH_OR_ENDPOINT_RE.test(value)) {
      throw new AuditPayloadValidationError('path-or-endpoint-detected');
    }
    return value;
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
    omittedToolEvidenceCount: omittedTools
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
  } else if (eventType === 'metrics-view-opened') {
    projected = projectMetricsViewOpened(payload) as unknown as Record<string, unknown>;
  } else {
    projected = projectValue(payload, 0) as Record<string, unknown>;
  }
  const bytes = Buffer.byteLength(JSON.stringify(projected), 'utf8');
  if (bytes > AUDIT_PAYLOAD_MAX_BYTES) {
    throw new AuditPayloadValidationError('payload-too-large');
  }
  return Object.freeze(projected);
}
